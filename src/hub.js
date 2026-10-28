// Webhooks as a product feature: customers register endpoints, the app emits
// events, and every subscribed endpoint gets a signed delivery that survives
// restarts and is retried with backoff.
//
//   const hooks = new Webhooks({ store: sqliteStore(db), source: 'https://group.call.pit.world' });
//   hooks.start();                                   // drains due deliveries every few seconds
//   const { endpoint, secret } = await hooks.createEndpoint(user.id, { url, events: ['room.*'] });
//   await hooks.emit(user.id, 'room.joined', { code: '4821', who: 'Anthony' });
//
// Delivery is at least once. Each event keeps its id across attempts (the
// `webhook-id` header), so receivers dedupe on it.

import { randomBytes } from 'node:crypto';
import { createEvent } from './event.js';
import { checkUrl } from './guard.js';
import { sendWebhook } from './sender.js';
import { generateSecret } from './sign.js';

/** Wait before attempt 2, 3, ...: about three days in all, like most providers. */
export const DEFAULT_BACKOFF_MS = [30_000, 2 * 60_000, 10 * 60_000, 60 * 60_000, 6 * 60 * 60_000, 24 * 60 * 60_000, 48 * 60 * 60_000];

/** An endpoint that fails this many deliveries in a row is switched off. */
export const DEFAULT_DISABLE_AFTER = 20;

/** The event `test()` sends. */
export const TEST_EVENT = 'webhook.test';

const newId = (prefix) => `${prefix}_${randomBytes(12).toString('base64url')}`;

/** Whether an event type matches an endpoint's patterns: "*", an exact type, or "room.*". */
export function matchesEvent(patterns, type) {
  return (patterns?.length ? patterns : ['*']).some((p) => p === '*' || p === type || (p.endsWith('.*') && type.startsWith(p.slice(0, -1))));
}

export class WebhookError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

/** An endpoint as its owner sees it: never the secret. */
export function publicEndpoint(e) {
  return {
    id: e.id,
    url: e.url,
    events: e.events,
    description: e.description,
    enabled: e.enabled,
    failures: e.failures,
    disabled_reason: e.disabledReason,
    created_at: new Date(e.createdAt).toISOString(),
    updated_at: new Date(e.updatedAt).toISOString(),
  };
}

/** A delivery as its owner sees it, with the payload that was (or will be) sent. */
export function publicDelivery(d, { payload = true } = {}) {
  return {
    id: d.id,
    endpoint_id: d.endpointId,
    event_id: d.eventId,
    event_type: d.eventType,
    status: d.status,
    attempts: d.attempts,
    next_at: d.status === 'pending' ? new Date(d.nextAt).toISOString() : null,
    last_status: d.lastStatus,
    last_error: d.lastError,
    created_at: new Date(d.createdAt).toISOString(),
    updated_at: new Date(d.updatedAt).toISOString(),
    ...(payload ? { payload: safeJson(d.payload) } : {}),
  };
}

function safeJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

export class Webhooks {
  /**
   * @param {object} o
   * @param {object} o.store         memoryStore(), sqliteStore(db) or postgresStore(pool)
   * @param {string} [o.source]      CloudEvents `source`: your site's URL
   * @param {string[]} [o.eventTypes] the events this app emits, for docs and validation
   * @param {number} [o.maxEndpoints] per owner (default 10)
   * @param {object} [o.guard]       checkUrl options: { allowHttp, allowPrivate, lookup }
   */
  constructor({
    store,
    source,
    eventTypes = [],
    maxEndpoints = 10,
    backoffMs = DEFAULT_BACKOFF_MS,
    disableAfter = DEFAULT_DISABLE_AFTER,
    timeoutMs = 10_000,
    guard = {},
    fetchImpl = globalThis.fetch,
    now = Date.now,
    onDelivery,
    extraHeaders,
    secretBox,
    log = () => {},
  } = {}) {
    if (!store) throw new Error('Webhooks: store required');
    Object.assign(this, { store, source, eventTypes, maxEndpoints, backoffMs, disableAfter, timeoutMs, guard, fetchImpl, now, onDelivery, extraHeaders, log });
    // Secrets at rest: sealed with the app's own key when it gives one ({ seal, open }).
    this.seal = secretBox ? (s) => secretBox.seal(s) : (s) => s;
    this.open = secretBox ? (s) => secretBox.open(s) : (s) => s;
    this.timer = null;
    this.draining = null;
  }

  // ---- endpoints ---------------------------------------------------------

  async validEvents(events) {
    const list = events === undefined || events === null ? ['*'] : Array.isArray(events) ? events.map(String) : String(events).split(/[,\s]+/);
    const clean = [...new Set(list.map((e) => e.trim()).filter(Boolean))];
    if (!clean.length) return ['*'];
    if (clean.length > 50) throw new WebhookError('at most 50 event patterns');
    for (const e of clean) {
      if (!/^(\*|[a-z0-9_.-]+(\.\*)?)$/i.test(e)) throw new WebhookError(`bad event pattern: ${e}`);
      if (this.eventTypes.length && e !== '*' && !this.eventTypes.some((t) => matchesEvent([e], t))) throw new WebhookError(`no event matches ${e}; try ${this.eventTypes.join(', ')}`);
    }
    return clean;
  }

  async validUrl(url) {
    const r = await checkUrl(url, this.guard);
    if (!r.ok) throw new WebhookError(`url: ${r.reason}`);
    return r.url;
  }

  /** A new endpoint for `owner`. The secret is returned here and by `rotateSecret`/`secret`. */
  async createEndpoint(owner, { url, events, description = '' } = {}) {
    if (!owner) throw new WebhookError('owner required', 401);
    if ((await this.store.listEndpoints(owner)).length >= this.maxEndpoints) throw new WebhookError(`at most ${this.maxEndpoints} webhook endpoints`, 409);
    const at = this.now();
    const secret = generateSecret();
    const endpoint = {
      id: newId('wh'),
      owner,
      url: await this.validUrl(url),
      secret: await this.seal(secret),
      events: await this.validEvents(events),
      description: String(description).slice(0, 200),
      enabled: true,
      failures: 0,
      disabledReason: null,
      createdAt: at,
      updatedAt: at,
    };
    await this.store.insertEndpoint(endpoint);
    return { endpoint: publicEndpoint(endpoint), secret };
  }

  async own(owner, id) {
    const e = id ? await this.store.getEndpoint(id) : null;
    if (!e || e.owner !== owner) throw new WebhookError('no such webhook endpoint', 404);
    return e;
  }

  async listEndpoints(owner) {
    return (await this.store.listEndpoints(owner)).map(publicEndpoint);
  }

  async getEndpoint(owner, id) {
    return publicEndpoint(await this.own(owner, id));
  }

  /** Change url, events, description or enabled. Turning one back on clears its failure count. */
  async updateEndpoint(owner, id, patch = {}) {
    await this.own(owner, id);
    const next = { updatedAt: this.now() };
    if (patch.url !== undefined) next.url = await this.validUrl(patch.url);
    if (patch.events !== undefined) next.events = await this.validEvents(patch.events);
    if (patch.description !== undefined) next.description = String(patch.description).slice(0, 200);
    if (patch.enabled !== undefined) {
      next.enabled = Boolean(patch.enabled);
      if (next.enabled) Object.assign(next, { failures: 0, disabledReason: null });
    }
    await this.store.updateEndpoint(id, next);
    return this.getEndpoint(owner, id);
  }

  async deleteEndpoint(owner, id) {
    await this.own(owner, id);
    await this.store.deleteEndpoint(id);
    return { deleted: true };
  }

  /** The signing secret, for an owner who lost it. */
  async secret(owner, id) {
    return { secret: await this.open((await this.own(owner, id)).secret) };
  }

  /** A new secret; the old one stops working at once. */
  async rotateSecret(owner, id) {
    await this.own(owner, id);
    const secret = generateSecret();
    await this.store.updateEndpoint(id, { secret: await this.seal(secret), updatedAt: this.now() });
    return { secret };
  }

  // ---- events --------------------------------------------------------------

  /**
   * Queue `type` for every enabled endpoint of `owner` that subscribes to it.
   * Returns at once; the drainer sends. `opts.subject` names what it is about.
   */
  async emit(owner, type, data, { subject, id } = {}) {
    const endpoints = (await this.store.listEndpoints(owner)).filter((e) => e.enabled && matchesEvent(e.events, type));
    const event = createEvent(type, data, { source: this.source, ...(subject !== undefined ? { subject: String(subject) } : {}), ...(id ? { id } : {}) });
    if (!endpoints.length) return { id: event.id, queued: 0 };
    const at = this.now();
    const payload = JSON.stringify(event);
    await this.store.insertDeliveries(
      endpoints.map((e) => ({ id: newId('dlv'), endpointId: e.id, owner, eventId: event.id, eventType: type, payload, status: 'pending', attempts: 0, nextAt: at, lastStatus: null, lastError: null, createdAt: at, updatedAt: at })),
    );
    if (this.timer) queueMicrotask(() => void this.drain().catch(() => {}));
    return { id: event.id, queued: endpoints.length };
  }

  /** Send a `webhook.test` event to one endpoint now, and say how it went. Not retried. */
  async test(owner, id) {
    const e = await this.own(owner, id);
    const event = createEvent(TEST_EVENT, { endpoint_id: e.id, message: 'This is a test delivery.' }, { source: this.source });
    const at = this.now();
    const d = { id: newId('dlv'), endpointId: e.id, owner, eventId: event.id, eventType: TEST_EVENT, payload: JSON.stringify(event), status: 'pending', attempts: 0, nextAt: at + 365 * 86_400_000, lastStatus: null, lastError: null, createdAt: at, updatedAt: at };
    await this.store.insertDeliveries([d]);
    const r = await this.attempt(e, d, { final: true });
    return { ok: r.ok, status: r.status, error: r.error ?? null, delivery_id: d.id };
  }

  async deliveries(owner, { endpointId, limit = 50 } = {}) {
    if (endpointId) await this.own(owner, endpointId);
    return (await this.store.listDeliveries({ owner, endpointId, limit: Math.min(200, Math.max(1, Number(limit) || 50)) })).map((d) => publicDelivery(d));
  }

  /** Send a delivery again from the start: a fixed receiver can catch up on what it missed. */
  async redeliver(owner, deliveryId) {
    const d = await this.store.getDelivery(deliveryId);
    if (!d || d.owner !== owner) throw new WebhookError('no such delivery', 404);
    await this.store.updateDelivery(d.id, { status: 'pending', attempts: 0, nextAt: this.now(), lastError: null, updatedAt: this.now() });
    if (this.timer) queueMicrotask(() => void this.drain().catch(() => {}));
    return publicDelivery({ ...d, status: 'pending', attempts: 0, nextAt: this.now() });
  }

  // ---- delivery ------------------------------------------------------------

  /** One try at one delivery; records the result and schedules the next try. */
  async attempt(endpoint, d, { final = false } = {}) {
    const at = this.now();
    const attempts = d.attempts + 1;
    let r;
    const checked = await checkUrl(endpoint.url, this.guard);
    if (!checked.ok) r = { ok: false, status: null, error: `url: ${checked.reason}` };
    else {
      const secret = await this.open(endpoint.secret);
      r = await sendWebhook(checked.url, d.payload, {
        secret,
        retryDelaysMs: [0],
        timeoutMs: this.timeoutMs,
        fetchImpl: this.fetchImpl,
        headers: { 'content-type': 'application/cloudevents+json', 'webhook-event': d.eventType, ...(this.extraHeaders ? this.extraHeaders({ body: d.payload, secret, endpoint: publicEndpoint(endpoint), eventType: d.eventType }) : {}) },
        id: d.eventId,
      });
    }
    const wait = this.backoffMs[attempts - 1];
    const done = r.ok ? 'delivered' : final || wait === undefined ? 'failed' : 'pending';
    await this.store.updateDelivery(d.id, {
      status: done,
      attempts,
      nextAt: done === 'pending' ? at + wait : d.nextAt,
      lastStatus: r.status ?? null,
      lastError: r.ok ? null : String(r.error ?? `HTTP ${r.status}`).slice(0, 300),
      updatedAt: at,
    });
    if (d.eventType !== TEST_EVENT) {
      if (r.ok && endpoint.failures) await this.store.updateEndpoint(endpoint.id, { failures: 0, updatedAt: at });
      if (!r.ok) {
        const failures = ++endpoint.failures;
        const off = failures >= this.disableAfter;
        await this.store.updateEndpoint(endpoint.id, { failures, ...(off ? { enabled: false, disabledReason: `${failures} failed deliveries in a row; last: ${String(r.error ?? r.status).slice(0, 120)}` } : {}), updatedAt: at });
        if (off) endpoint.enabled = false;
        if (off) this.log(`webhooks: endpoint ${endpoint.id} switched off after ${failures} failures`);
      }
    }
    try {
      await this.onDelivery?.({ delivery: publicDelivery({ ...d, status: done, attempts, lastStatus: r.status ?? null, lastError: r.error ?? null }, { payload: false }), endpoint: publicEndpoint(endpoint), ok: r.ok });
    } catch {}
    return r;
  }

  /** Send everything due. Safe to call often; concurrent calls share one run. */
  drain({ limit = 50 } = {}) {
    if (this.draining) return this.draining;
    this.draining = (async () => {
      let sent = 0;
      try {
        for (;;) {
          const due = await this.store.claimDue(this.now(), limit, 5 * 60_000);
          if (!due.length) break;
          // In order per endpoint (a receiver sees its events in sequence), endpoints side by side.
          const byEndpoint = new Map();
          for (const d of due) byEndpoint.set(d.endpointId, [...(byEndpoint.get(d.endpointId) ?? []), d]);
          await Promise.all(
            [...byEndpoint].map(async ([endpointId, list]) => {
              const e = await this.store.getEndpoint(endpointId);
              for (const d of list) {
                // An endpoint deleted or switched off since: the delivery is dropped, not retried forever.
                if (!e || !e.enabled) {
                  await this.store.updateDelivery(d.id, { status: 'failed', lastError: e ? 'endpoint is disabled' : 'endpoint was deleted', updatedAt: this.now() });
                  continue;
                }
                await this.attempt(e, d);
                sent += 1;
              }
            }),
          );
          if (due.length < limit) break;
        }
      } finally {
        this.draining = null;
      }
      return sent;
    })();
    return this.draining;
  }

  /** Drain every `intervalMs`, and prune finished deliveries older than `keepDays`. */
  start({ intervalMs = 5000, keepDays = 30 } = {}) {
    if (this.timer) return this;
    let ticks = 0;
    this.timer = setInterval(() => {
      void this.drain().catch((e) => this.log(`webhooks: drain failed: ${e.message}`));
      if (++ticks % 720 === 1) void this.store.prune(this.now() - keepDays * 86_400_000).catch(() => {});
    }, intervalMs);
    this.timer.unref?.();
    return this;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
