// Where endpoints and deliveries live.
//
// Three stores share one shape: memoryStore (tests, throwaway instances),
// sqliteStore (bun:sqlite, node:sqlite, better-sqlite3) and postgresStore
// (anything with pg's `query(text, params) -> { rows }`: pg, @neondatabase,
// a Supabase pooler). Every method is async, so the hub never cares which.
//
// Times are unix milliseconds. An endpoint's `events` is a list of patterns
// ("*", "room.joined", "room.*") kept as JSON text in SQL.

const ENDPOINT_COLS = 'id, owner, url, secret, events, description, enabled, failures, disabled_reason, created_at, updated_at';
const DELIVERY_COLS = 'id, endpoint_id, owner, event_id, event_type, payload, status, attempts, next_at, last_status, last_error, created_at, updated_at';

const tableNames = (prefix = '') => {
  if (!/^[a-z_][a-z0-9_]*$/i.test(prefix) && prefix !== '') throw new Error('webhooks: bad table prefix');
  return { endpoints: `${prefix}webhook_endpoints`, deliveries: `${prefix}webhook_deliveries` };
};

/** DDL for the two tables, for apps that keep their own migrations. */
export function schemaSql(dialect = 'sqlite', prefix = '') {
  const t = tableNames(prefix);
  const big = dialect === 'pg' ? 'BIGINT' : 'INTEGER';
  return [
    `CREATE TABLE IF NOT EXISTS ${t.endpoints} (
      id TEXT PRIMARY KEY,
      owner TEXT NOT NULL,
      url TEXT NOT NULL,
      secret TEXT NOT NULL,
      events TEXT NOT NULL DEFAULT '["*"]',
      description TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1,
      failures INTEGER NOT NULL DEFAULT 0,
      disabled_reason TEXT,
      created_at ${big} NOT NULL,
      updated_at ${big} NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS ${t.endpoints}_owner ON ${t.endpoints}(owner)`,
    `CREATE TABLE IF NOT EXISTS ${t.deliveries} (
      id TEXT PRIMARY KEY,
      endpoint_id TEXT NOT NULL,
      owner TEXT NOT NULL,
      event_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      next_at ${big} NOT NULL,
      last_status INTEGER,
      last_error TEXT,
      created_at ${big} NOT NULL,
      updated_at ${big} NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS ${t.deliveries}_due ON ${t.deliveries}(status, next_at)`,
    `CREATE INDEX IF NOT EXISTS ${t.deliveries}_endpoint ON ${t.deliveries}(endpoint_id, created_at)`,
  ];
}

const num = (v) => (v === null || v === undefined ? null : Number(v));

function toEndpoint(r) {
  if (!r) return null;
  let events = ['*'];
  try {
    events = JSON.parse(r.events);
  } catch {}
  return {
    id: r.id,
    owner: r.owner,
    url: r.url,
    secret: r.secret,
    events,
    description: r.description ?? '',
    enabled: Number(r.enabled) === 1 || r.enabled === true,
    failures: Number(r.failures ?? 0),
    disabledReason: r.disabled_reason ?? null,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

function toDelivery(r) {
  if (!r) return null;
  return {
    id: r.id,
    endpointId: r.endpoint_id,
    owner: r.owner,
    eventId: r.event_id,
    eventType: r.event_type,
    payload: r.payload,
    status: r.status,
    attempts: Number(r.attempts ?? 0),
    nextAt: Number(r.next_at),
    lastStatus: num(r.last_status),
    lastError: r.last_error ?? null,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

const ENDPOINT_FIELDS = { url: 'url', secret: 'secret', events: 'events', description: 'description', enabled: 'enabled', failures: 'failures', disabledReason: 'disabled_reason', updatedAt: 'updated_at' };
const DELIVERY_FIELDS = { status: 'status', attempts: 'attempts', nextAt: 'next_at', lastStatus: 'last_status', lastError: 'last_error', updatedAt: 'updated_at' };

function sqlValue(key, value) {
  if (key === 'events') return JSON.stringify(value);
  if (key === 'enabled') return value ? 1 : 0;
  return value ?? null;
}

/**
 * One SQL implementation for both dialects. `q` runs a statement written with
 * `?` placeholders: `q.all(sql, params)`, `q.run(sql, params)`, and `q.claim`
 * for the dialect's way of taking due rows without two workers getting one.
 */
function sqlStore(q, prefix) {
  const t = tableNames(prefix);
  const update = async (table, fields, id, patch) => {
    const keys = Object.keys(patch).filter((k) => fields[k]);
    if (!keys.length) return;
    await q.run(`UPDATE ${table} SET ${keys.map((k) => `${fields[k]} = ?`).join(', ')} WHERE id = ?`, [...keys.map((k) => sqlValue(k, patch[k])), id]);
  };
  return {
    async insertEndpoint(e) {
      await q.run(`INSERT INTO ${t.endpoints} (${ENDPOINT_COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        e.id, e.owner, e.url, e.secret, JSON.stringify(e.events), e.description, e.enabled ? 1 : 0, e.failures, e.disabledReason, e.createdAt, e.updatedAt,
      ]);
    },
    async getEndpoint(id) {
      return toEndpoint((await q.all(`SELECT ${ENDPOINT_COLS} FROM ${t.endpoints} WHERE id = ?`, [id]))[0]);
    },
    async listEndpoints(owner) {
      return (await q.all(`SELECT ${ENDPOINT_COLS} FROM ${t.endpoints} WHERE owner = ? ORDER BY created_at`, [owner])).map(toEndpoint);
    },
    updateEndpoint: (id, patch) => update(t.endpoints, ENDPOINT_FIELDS, id, patch),
    async deleteEndpoint(id) {
      await q.run(`DELETE FROM ${t.deliveries} WHERE endpoint_id = ?`, [id]);
      await q.run(`DELETE FROM ${t.endpoints} WHERE id = ?`, [id]);
    },
    async insertDeliveries(rows) {
      for (const d of rows) {
        await q.run(`INSERT INTO ${t.deliveries} (${DELIVERY_COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
          d.id, d.endpointId, d.owner, d.eventId, d.eventType, d.payload, d.status, d.attempts, d.nextAt, d.lastStatus, d.lastError, d.createdAt, d.updatedAt,
        ]);
      }
    },
    async getDelivery(id) {
      return toDelivery((await q.all(`SELECT ${DELIVERY_COLS} FROM ${t.deliveries} WHERE id = ?`, [id]))[0]);
    },
    async listDeliveries({ owner, endpointId, limit = 50 }) {
      const where = endpointId ? 'owner = ? AND endpoint_id = ?' : 'owner = ?';
      const params = endpointId ? [owner, endpointId] : [owner];
      return (await q.all(`SELECT ${DELIVERY_COLS} FROM ${t.deliveries} WHERE ${where} ORDER BY created_at DESC LIMIT ?`, [...params, limit])).map(toDelivery);
    },
    updateDelivery: (id, patch) => update(t.deliveries, DELIVERY_FIELDS, id, patch),
    async claimDue(now, limit, leaseMs) {
      return (await q.claim(t.deliveries, now, limit, now + leaseMs)).map(toDelivery);
    },
    async prune(before) {
      await q.run(`DELETE FROM ${t.deliveries} WHERE status <> 'pending' AND updated_at < ?`, [before]);
    },
  };
}

/** bun:sqlite (`query`), node:sqlite or better-sqlite3 (`prepare`). Creates its tables. */
export function sqliteStore(db, { prefix = '', migrate = true } = {}) {
  const compile = typeof db.query === 'function' ? db.query.bind(db) : typeof db.prepare === 'function' ? db.prepare.bind(db) : null;
  if (!compile) throw new TypeError('sqliteStore needs a database with query() (bun:sqlite) or prepare() (node:sqlite, better-sqlite3)');
  if (migrate) for (const sql of schemaSql('sqlite', prefix)) db.exec(sql);
  const cache = new Map();
  const stmt = (sql) => {
    let s = cache.get(sql);
    if (!s) cache.set(sql, (s = compile(sql)));
    return s;
  };
  const all = (sql, params) => stmt(sql).all(...params);
  return sqlStore(
    {
      all: async (sql, params) => all(sql, params),
      run: async (sql, params) => void stmt(sql).run(...params),
      // One process holds a SQLite file, and these three statements run with no await between them.
      claim: async (table, now, limit, leaseUntil) => {
        db.exec('BEGIN IMMEDIATE');
        try {
          const rows = all(`SELECT ${DELIVERY_COLS} FROM ${table} WHERE status = 'pending' AND next_at <= ? ORDER BY next_at LIMIT ?`, [now, limit]);
          for (const r of rows) stmt(`UPDATE ${table} SET next_at = ? WHERE id = ?`).run(leaseUntil, r.id);
          db.exec('COMMIT');
          return rows;
        } catch (e) {
          db.exec('ROLLBACK');
          throw e;
        }
      },
    },
    prefix,
  );
}

const dollars = (sql) => {
  let n = 0;
  return sql.replace(/\?/g, () => `$${++n}`);
};

/**
 * Postgres through a pool with pg's `query(text, params)`. Run `schemaSql('pg')`
 * in your migrations, or pass `{ migrate: true }` and await `store.ready`.
 */
export function postgresStore(pool, { prefix = '', migrate = false } = {}) {
  if (typeof pool?.query !== 'function') throw new TypeError('postgresStore needs a pool with query(text, params)');
  const ready = migrate ? (async () => { for (const sql of schemaSql('pg', prefix)) await pool.query(sql); })() : Promise.resolve();
  const run = async (sql, params) => (await ready, (await pool.query(dollars(sql), params)).rows);
  const store = sqlStore(
    {
      all: run,
      run: async (sql, params) => void (await run(sql, params)),
      // SKIP LOCKED: several workers can drain one table and never take the same row.
      claim: (table, now, limit, leaseUntil) =>
        run(
          `UPDATE ${table} SET next_at = ? WHERE id IN (SELECT id FROM ${table} WHERE status = 'pending' AND next_at <= ? ORDER BY next_at LIMIT ? FOR UPDATE SKIP LOCKED) RETURNING ${DELIVERY_COLS}`,
          [leaseUntil, now, limit],
        ),
    },
    prefix,
  );
  return Object.assign(store, { ready });
}

/** Everything in memory: tests, and instances that can lose pending deliveries on restart. */
export function memoryStore() {
  const endpoints = new Map();
  const deliveries = new Map();
  const copy = (o) => (o ? { ...o, ...(o.events ? { events: [...o.events] } : {}) } : null);
  return {
    async insertEndpoint(e) {
      endpoints.set(e.id, copy(e));
    },
    async getEndpoint(id) {
      return copy(endpoints.get(id));
    },
    async listEndpoints(owner) {
      return [...endpoints.values()].filter((e) => e.owner === owner).sort((a, b) => a.createdAt - b.createdAt).map(copy);
    },
    async updateEndpoint(id, patch) {
      const e = endpoints.get(id);
      if (e) endpoints.set(id, copy({ ...e, ...patch }));
    },
    async deleteEndpoint(id) {
      endpoints.delete(id);
      for (const [k, d] of deliveries) if (d.endpointId === id) deliveries.delete(k);
    },
    async insertDeliveries(rows) {
      for (const d of rows) deliveries.set(d.id, { ...d });
    },
    async getDelivery(id) {
      return copy(deliveries.get(id));
    },
    async listDeliveries({ owner, endpointId, limit = 50 }) {
      return [...deliveries.values()]
        .filter((d) => d.owner === owner && (!endpointId || d.endpointId === endpointId))
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, limit)
        .map(copy);
    },
    async updateDelivery(id, patch) {
      const d = deliveries.get(id);
      if (d) deliveries.set(id, { ...d, ...patch });
    },
    async claimDue(now, limit, leaseMs) {
      const due = [...deliveries.values()].filter((d) => d.status === 'pending' && d.nextAt <= now).sort((a, b) => a.nextAt - b.nextAt).slice(0, limit);
      for (const d of due) d.nextAt = now + leaseMs;
      return due.map(copy);
    },
    async prune(before) {
      for (const [k, d] of deliveries) if (d.status !== 'pending' && d.updatedAt < before) deliveries.delete(k);
    },
  };
}
