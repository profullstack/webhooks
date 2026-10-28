// The hub: endpoints, emit, durable delivery, the API. Runs under node --test and bun test.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  Webhooks,
  checkUrl,
  isPrivateAddress,
  matchesEvent,
  memoryStore,
  sqliteStore,
  tV1Header,
  verifySignature,
  webhooksApi,
} from '../src/index.js';

/** A receiver that records what arrived and answers with the next queued status. */
function receiver(statuses = []) {
  const got = [];
  const fetchImpl = async (url, init) => {
    got.push({ url: String(url), headers: init.headers, body: init.body });
    const status = statuses.length ? statuses.shift() : 204;
    if (status === 'throw') throw new Error('connection refused');
    return new Response(null, { status });
  };
  return { got, fetchImpl };
}

const publicDns = async () => ['93.184.216.34'];

function hub(extra = {}) {
  let t = 1_700_000_000_000;
  const clock = { now: () => t, advance: (ms) => (t += ms) };
  const rx = receiver(extra.statuses);
  const hooks = new Webhooks({ store: extra.store ?? memoryStore(), source: 'https://app.test', fetchImpl: rx.fetchImpl, now: clock.now, guard: { lookup: publicDns }, ...extra.options });
  return { hooks, clock, rx };
}

async function sqliteDb() {
  try {
    const { Database } = await import('bun:sqlite');
    return new Database(':memory:');
  } catch {
    const { DatabaseSync } = await import('node:sqlite');
    return new DatabaseSync(':memory:');
  }
}

describe('checkUrl', () => {
  it('takes a public https URL and refuses our own network', async () => {
    assert.deepEqual(await checkUrl('https://hooks.example.com/in#frag', { lookup: publicDns }), { ok: true, url: 'https://hooks.example.com/in' });
    assert.equal((await checkUrl('http://hooks.example.com/', { lookup: publicDns })).ok, false);
    assert.equal((await checkUrl('https://127.0.0.1/')).ok, false);
    assert.equal((await checkUrl('https://169.254.169.254/latest/meta-data')).ok, false);
    assert.equal((await checkUrl('https://localhost:8080/')).ok, false);
    assert.equal((await checkUrl('https://[::1]/')).ok, false);
    assert.equal((await checkUrl('https://evil.example/', { lookup: async () => ['10.0.0.5'] })).ok, false);
    assert.equal((await checkUrl('https://user:pw@hooks.example.com/', { lookup: publicDns })).ok, false);
    assert.equal((await checkUrl('http://127.0.0.1:3000/', { allowHttp: true, allowPrivate: true })).ok, true);
  });

  it('knows private addresses in both families', () => {
    for (const ip of ['10.1.2.3', '172.20.0.1', '192.168.1.1', '100.64.0.1', '::ffff:10.0.0.1', 'fd00::1', 'fe80::1']) assert.equal(isPrivateAddress(ip), true, ip);
    for (const ip of ['8.8.8.8', '2606:4700::1111']) assert.equal(isPrivateAddress(ip), false, ip);
  });
});

describe('Webhooks', () => {
  it('matches event patterns', () => {
    assert.equal(matchesEvent(['*'], 'room.joined'), true);
    assert.equal(matchesEvent(['room.*'], 'room.joined'), true);
    assert.equal(matchesEvent(['room.*'], 'roomy.joined'), false);
    assert.equal(matchesEvent(['room.left'], 'room.joined'), false);
  });

  it('delivers an emitted event, signed, only to endpoints that subscribe to it', async () => {
    const { hooks, rx } = hub();
    const { endpoint, secret } = await hooks.createEndpoint('u1', { url: 'https://hooks.example.com/a', events: ['room.*'] });
    await hooks.createEndpoint('u1', { url: 'https://hooks.example.com/b', events: ['invoice.paid'] });
    await hooks.createEndpoint('u2', { url: 'https://hooks.example.com/c' });
    assert.equal(endpoint.enabled, true);
    assert.equal('secret' in endpoint, false, 'the public endpoint never carries its secret');

    const emitted = await hooks.emit('u1', 'room.joined', { code: '4821' }, { subject: 'room:4821' });
    assert.equal(emitted.queued, 1);
    assert.equal(await hooks.drain(), 1);
    assert.equal(rx.got.length, 1);
    const [d] = rx.got;
    assert.equal(d.url, 'https://hooks.example.com/a');
    assert.equal(d.headers['content-type'], 'application/cloudevents+json');
    assert.equal(d.headers['webhook-event'], 'room.joined');
    assert.equal(d.headers['webhook-id'], emitted.id);
    assert.deepEqual(verifySignature({ headers: d.headers, body: d.body, secret }).ok, true);
    const event = JSON.parse(d.body);
    assert.equal(event.type, 'room.joined');
    assert.equal(event.source, 'https://app.test');
    assert.equal(event.subject, 'room:4821');
    assert.deepEqual(event.data, { code: '4821' });
    const [log] = await hooks.deliveries('u1');
    assert.equal(log.status, 'delivered');
    assert.equal(log.last_status, 204);
  });

  it('retries with backoff across drains, keeps the webhook-id, and gives up at the end of the schedule', async () => {
    const { hooks, rx, clock } = hub({ statuses: [500, 'throw', 204], options: { backoffMs: [1000, 5000] } });
    await hooks.createEndpoint('u1', { url: 'https://hooks.example.com/a' });
    const { id } = await hooks.emit('u1', 'x.happened', {});
    await hooks.drain();
    assert.equal((await hooks.deliveries('u1'))[0].status, 'pending');
    assert.equal(await hooks.drain(), 0, 'not due yet');
    clock.advance(1000);
    await hooks.drain();
    let [log] = await hooks.deliveries('u1');
    assert.equal(log.attempts, 2);
    assert.equal(log.last_error, 'connection refused');
    clock.advance(5000);
    await hooks.drain();
    [log] = await hooks.deliveries('u1');
    assert.equal(log.status, 'delivered');
    assert.equal(log.attempts, 3);
    assert.deepEqual(rx.got.map((g) => g.headers['webhook-id']), [id, id, id]);

    const failing = hub({ statuses: [500, 500], options: { backoffMs: [1000] } });
    await failing.hooks.createEndpoint('u1', { url: 'https://hooks.example.com/a' });
    await failing.hooks.emit('u1', 'x.happened', {});
    await failing.hooks.drain();
    failing.clock.advance(1000);
    await failing.hooks.drain();
    assert.equal((await failing.hooks.deliveries('u1'))[0].status, 'failed');
  });

  it('a 4xx other than 408/429 is not worth a retry until the schedule says so, and an endpoint that keeps failing is switched off', async () => {
    const { hooks, clock } = hub({ statuses: Array(10).fill(410), options: { backoffMs: [], disableAfter: 3 } });
    const { endpoint } = await hooks.createEndpoint('u1', { url: 'https://hooks.example.com/a' });
    for (let i = 0; i < 3; i++) await hooks.emit('u1', 'x.happened', { i });
    await hooks.drain();
    const e = await hooks.getEndpoint('u1', endpoint.id);
    assert.equal(e.enabled, false);
    assert.match(e.disabled_reason, /3 failed deliveries/);
    assert.equal((await hooks.emit('u1', 'x.happened', {})).queued, 0, 'a switched-off endpoint gets nothing');
    clock.advance(1);
    const back = await hooks.updateEndpoint('u1', endpoint.id, { enabled: true });
    assert.equal(back.failures, 0);
    assert.equal(back.disabled_reason, null);
  });

  it('owners only see their own, secrets rotate, tests are sent at once, and deliveries can be redone', async () => {
    const { hooks, rx } = hub({ statuses: [204, 500] });
    const { endpoint, secret } = await hooks.createEndpoint('u1', { url: 'https://hooks.example.com/a' });
    await assert.rejects(hooks.getEndpoint('u2', endpoint.id), { status: 404 });
    await assert.rejects(hooks.createEndpoint('u1', { url: 'https://127.0.0.1/' }), { status: 400 });
    const rotated = await hooks.rotateSecret('u1', endpoint.id);
    assert.notEqual(rotated.secret, secret);
    assert.deepEqual(await hooks.secret('u1', endpoint.id), { secret: rotated.secret });
    const test = await hooks.test('u1', endpoint.id);
    assert.equal(test.ok, true);
    assert.equal(JSON.parse(rx.got[0].body).type, 'webhook.test');
    assert.equal(verifySignature({ headers: rx.got[0].headers, body: rx.got[0].body, secret: rotated.secret }).ok, true);

    await hooks.emit('u1', 'x.happened', {});
    await hooks.drain();
    const pending = (await hooks.deliveries('u1')).find((d) => d.event_type === 'x.happened');
    assert.equal(pending.status, 'pending');
    await hooks.redeliver('u1', pending.id);
    await hooks.drain();
    assert.equal((await hooks.deliveries('u1')).find((d) => d.id === pending.id).status, 'delivered');
    await assert.rejects(hooks.redeliver('u2', pending.id), { status: 404 });
  });

  it('only known event types can be subscribed to, when the app says what it emits', async () => {
    const { hooks } = hub({ options: { eventTypes: ['room.joined', 'room.left'] } });
    await hooks.createEndpoint('u1', { url: 'https://hooks.example.com/a', events: 'room.*' });
    await assert.rejects(hooks.createEndpoint('u1', { url: 'https://hooks.example.com/a', events: ['invoice.paid'] }), /no event matches/);
  });

  it('seals secrets at rest and can send a legacy signature header too', async () => {
    const store = memoryStore();
    const box = { seal: (s) => `sealed:${Buffer.from(s).toString('base64')}`, open: (s) => Buffer.from(s.slice(7), 'base64').toString() };
    const { hooks, rx } = hub({ store, options: { secretBox: box, extraHeaders: tV1Header('x-coinpay-signature') } });
    const { endpoint, secret } = await hooks.createEndpoint('u1', { url: 'https://hooks.example.com/a' });
    assert.match((await store.getEndpoint(endpoint.id)).secret, /^sealed:/);
    assert.deepEqual(await hooks.secret('u1', endpoint.id), { secret });
    await hooks.emit('u1', 'x.happened', {});
    await hooks.drain();
    assert.equal(verifySignature({ headers: rx.got[0].headers, body: rx.got[0].body, secret }).ok, true);
    assert.match(rx.got[0].headers['x-coinpay-signature'], /^t=\d+,v1=[0-9a-f]{64}$/);
  });

  it('a SQLite store keeps pending deliveries for the next process', async () => {
    const db = await sqliteDb();
    const first = hub({ store: sqliteStore(db), statuses: [503] });
    const { endpoint } = await first.hooks.createEndpoint('u1', { url: 'https://hooks.example.com/a', events: ['a.*', 'b.c'] });
    await first.hooks.emit('u1', 'a.b', { n: 1 });
    await first.hooks.drain();
    const second = hub({ store: sqliteStore(db), options: { backoffMs: [0] } });
    second.clock.advance(60_000);
    assert.equal(await second.hooks.drain(), 1);
    const [log] = await second.hooks.deliveries('u1', { endpointId: endpoint.id });
    assert.equal(log.status, 'delivered');
    assert.equal(log.attempts, 2);
    assert.deepEqual((await second.hooks.getEndpoint('u1', endpoint.id)).events, ['a.*', 'b.c']);
  });
});

describe('webhooksApi', () => {
  it('serves the endpoint API to whoever owner() says is calling', async () => {
    const { hooks } = hub({ options: { eventTypes: ['room.joined'] } });
    const api = webhooksApi(hooks, { basePath: '/api/v1/webhooks', owner: (req) => (req.headers.get('authorization') === 'Bearer k1' ? 'u1' : null) });
    const call = (method, path, body, key = 'k1') =>
      api(new Request(`https://app.test${path}`, { method, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }));
    assert.equal(await call('GET', '/elsewhere'), null);
    assert.equal((await call('GET', '/api/v1/webhooks', null, 'nope')).status, 401);
    const created = await call('POST', '/api/v1/webhooks', { url: 'https://hooks.example.com/a', events: ['room.joined'] });
    assert.equal(created.status, 201);
    const { endpoint, secret } = await created.json();
    assert.match(secret, /^whsec_/);
    const list = await (await call('GET', '/api/v1/webhooks')).json();
    assert.deepEqual(list.event_types, ['room.joined']);
    assert.equal(list.endpoints.length, 1);
    assert.equal((await (await call('PATCH', `/api/v1/webhooks/${endpoint.id}`, { description: 'crm' })).json()).description, 'crm');
    assert.equal((await call('POST', `/api/v1/webhooks/${endpoint.id}/test`)).status, 200);
    assert.equal((await (await call('GET', `/api/v1/webhooks/${endpoint.id}/deliveries`)).json()).deliveries.length, 1);
    assert.equal((await call('POST', '/api/v1/webhooks', { url: 'http://10.0.0.1/' })).status, 400);
    assert.equal((await call('DELETE', `/api/v1/webhooks/${endpoint.id}`)).status, 200);
    assert.equal((await call('GET', `/api/v1/webhooks/${endpoint.id}`)).status, 404);
  });
});
