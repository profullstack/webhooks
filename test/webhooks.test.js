// Runs under both `bun test` and `node --test` (node:test + node:assert only).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createEvent,
  generateSecret,
  honoHandler,
  fetchHandler,
  sendWebhook,
  signRequest,
  verifyAndParse,
  verifySignature,
} from '../src/index.js';

const now = () => Math.floor(Date.now() / 1000);

describe('signRequest / verifySignature', () => {
  it('matches the Standard Webhooks reference vector', () => {
    const h = signRequest({
      id: 'msg_p5jXN8AQM9LWM0D4loKWxJek',
      timestamp: 1614265330,
      body: '{"test": 2432232314}',
      secret: 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw',
    });
    assert.equal(h['webhook-signature'], 'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=');
    assert.equal(h['webhook-id'], 'msg_p5jXN8AQM9LWM0D4loKWxJek');
    assert.equal(h['webhook-timestamp'], '1614265330');
  });

  it('round trips with a whsec_ secret', () => {
    const secret = generateSecret();
    assert.match(secret, /^whsec_[A-Za-z0-9+/]{43}=$/);
    const body = JSON.stringify({ hello: 'world' });
    const headers = signRequest({ id: 'msg_1', timestamp: now(), body, secret });
    assert.deepEqual(verifySignature({ headers, body, secret }), {
      ok: true,
      id: 'msg_1',
      timestamp: Number(headers['webhook-timestamp']),
    });
  });

  it('round trips with a raw string secret, and raw != whsec_ of the same text', () => {
    const body = '{"a":1}';
    const headers = signRequest({ id: 'm', timestamp: now(), body, secret: 'plain-shared-secret' });
    assert.equal(verifySignature({ headers, body, secret: 'plain-shared-secret' }).ok, true);
    const other = verifySignature({ headers, body, secret: 'whsec_' + Buffer.from('nope').toString('base64') });
    assert.deepEqual(other, { ok: false, reason: 'signature mismatch' });
  });

  it('accepts a Headers instance', () => {
    const secret = generateSecret();
    const body = '{}';
    const headers = new Headers(signRequest({ id: 'm', timestamp: now(), body, secret }));
    assert.equal(verifySignature({ headers, body, secret }).ok, true);
  });

  it('rejects a tampered body', () => {
    const secret = generateSecret();
    const headers = signRequest({ id: 'm', timestamp: now(), body: '{"amount":1}', secret });
    const r = verifySignature({ headers, body: '{"amount":9}', secret });
    assert.deepEqual(r, { ok: false, reason: 'signature mismatch' });
  });

  it('rejects a wrong secret', () => {
    const headers = signRequest({ id: 'm', timestamp: now(), body: '{}', secret: generateSecret() });
    assert.equal(verifySignature({ headers, body: '{}', secret: generateSecret() }).ok, false);
  });

  it('rejects a stale timestamp and a far-future one', () => {
    const secret = generateSecret();
    for (const ts of [now() - 301, now() + 301]) {
      const headers = signRequest({ id: 'm', timestamp: ts, body: '{}', secret });
      assert.deepEqual(verifySignature({ headers, body: '{}', secret }), {
        ok: false,
        reason: 'timestamp outside tolerance',
      });
    }
    const headers = signRequest({ id: 'm', timestamp: now() - 1000, body: '{}', secret });
    assert.equal(verifySignature({ headers, body: '{}', secret, toleranceSeconds: 2000 }).ok, true);
  });

  it('accepts any of several signatures (key rotation)', () => {
    const oldSecret = generateSecret();
    const newSecret = generateSecret();
    const body = '{"x":1}';
    const ts = now();
    const a = signRequest({ id: 'm', timestamp: ts, body, secret: oldSecret });
    const b = signRequest({ id: 'm', timestamp: ts, body, secret: newSecret });
    const headers = { ...a, 'webhook-signature': `${a['webhook-signature']} ${b['webhook-signature']}` };
    assert.equal(verifySignature({ headers, body, secret: oldSecret }).ok, true);
    assert.equal(verifySignature({ headers, body, secret: newSecret }).ok, true);
    assert.equal(verifySignature({ headers, body, secret: generateSecret() }).ok, false);
  });

  it('ignores signatures with an unknown version tag', () => {
    const secret = generateSecret();
    const h = signRequest({ id: 'm', timestamp: now(), body: '{}', secret });
    const mac = h['webhook-signature'].slice(3);
    const headers = { ...h, 'webhook-signature': `v2,${mac}` };
    assert.equal(verifySignature({ headers, body: '{}', secret }).ok, false);
  });

  it('reports missing headers', () => {
    assert.deepEqual(verifySignature({ headers: {}, body: '', secret: 's' }), {
      ok: false,
      reason: 'missing webhook-id',
    });
  });
});

describe('createEvent', () => {
  it('builds a CloudEvents 1.0 envelope', () => {
    const e = createEvent('com.example.thing.happened.v1', { n: 1 }, {
      source: 'https://example.com',
      subject: 'thing:1',
      id: 'evt_1',
      time: '2026-01-01T00:00:00.000Z',
    });
    assert.deepEqual(e, {
      specversion: '1.0',
      id: 'evt_1',
      type: 'com.example.thing.happened.v1',
      source: 'https://example.com',
      subject: 'thing:1',
      time: '2026-01-01T00:00:00.000Z',
      datacontenttype: 'application/json',
      data: { n: 1 },
    });
    const d = createEvent('t', null);
    assert.equal(typeof d.id, 'string');
    assert.equal(d.source, 'urn:profullstack:webhooks');
    assert.ok(!('subject' in d));
  });
});

function fakeFetch(statuses, calls = []) {
  return async (url, init) => {
    calls.push({ url, init });
    const s = statuses[Math.min(calls.length - 1, statuses.length - 1)];
    if (s instanceof Error) throw s;
    return new Response(null, { status: s });
  };
}

describe('sendWebhook', () => {
  const secret = generateSecret();
  const event = createEvent('test.v1', { ok: true }, { source: 'https://a.test' });

  it('retries a 5xx and succeeds on the second attempt', async () => {
    const calls = [];
    const log = [];
    const r = await sendWebhook('https://b.test/hook', event, {
      secret,
      retryDelaysMs: [0, 1, 1],
      fetchImpl: fakeFetch([503, 200], calls),
      onAttempt: (a) => log.push(a),
    });
    assert.deepEqual(r, { ok: true, status: 200, attempts: 2, id: event.id });
    assert.equal(calls.length, 2);
    assert.deepEqual(log.map((a) => [a.attempt, a.status]), [[1, 503], [2, 200]]);
    assert.ok(log.every((a) => typeof a.ms === 'number'));
    // What was sent verifies on the other side.
    const sent = calls[1].init;
    const v = verifyAndParse({ headers: sent.headers, body: sent.body, secret });
    assert.equal(v.ok, true);
    assert.deepEqual(v.event, event);
    assert.equal(sent.headers['content-type'], 'application/cloudevents+json');
    assert.equal(sent.headers['webhook-id'], event.id);
  });

  it('does not retry a 400', async () => {
    const calls = [];
    const r = await sendWebhook('https://b.test/hook', event, {
      secret,
      retryDelaysMs: [0, 1, 1],
      fetchImpl: fakeFetch([400, 200], calls),
    });
    assert.equal(r.ok, false);
    assert.equal(r.status, 400);
    assert.equal(r.attempts, 1);
    assert.equal(r.error, 'HTTP 400');
  });

  it('retries 408, 429 and network errors', async () => {
    const r = await sendWebhook('https://b.test/hook', event, {
      secret,
      retryDelaysMs: [0, 1, 1, 1],
      fetchImpl: fakeFetch([408, 429, new TypeError('fetch failed'), 204]),
    });
    assert.deepEqual(r, { ok: true, status: 204, attempts: 4, id: event.id });
  });

  it('gives up after the last delay', async () => {
    const r = await sendWebhook('https://b.test/hook', event, {
      secret,
      retryDelaysMs: [0, 1],
      fetchImpl: fakeFetch([500]),
    });
    assert.deepEqual(r, { ok: false, status: 500, attempts: 2, id: event.id, error: 'HTTP 500' });
  });

  it('times out a hung request and retries it', async () => {
    let n = 0;
    const hang = (url, init) => {
      n++;
      if (n === 2) return Promise.resolve(new Response(null, { status: 200 }));
      return new Promise((_, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    };
    const log = [];
    const r = await sendWebhook('https://b.test/hook', event, {
      secret,
      retryDelaysMs: [0, 1],
      timeoutMs: 30,
      fetchImpl: hang,
      onAttempt: (a) => log.push(a),
    });
    assert.equal(r.ok, true);
    assert.equal(r.attempts, 2);
    assert.equal(log[0].status, null);
    assert.equal(log[0].error, 'timeout after 30ms');
  });

  it('merges extra headers but never lets them replace the signature', async () => {
    const calls = [];
    await sendWebhook('https://b.test/hook', event, {
      secret,
      retryDelaysMs: [0],
      headers: { 'x-extra': '1', 'webhook-signature': 'forged' },
      fetchImpl: fakeFetch([200], calls),
    });
    assert.equal(calls[0].init.headers['x-extra'], '1');
    assert.match(calls[0].init.headers['webhook-signature'], /^v1,/);
  });
});

describe('verifyAndParse', () => {
  const secret = generateSecret();
  it('401 on a bad signature, 400 on bad JSON', () => {
    const headers = signRequest({ id: 'm', timestamp: now(), body: 'not json', secret });
    assert.deepEqual(verifyAndParse({ headers, body: 'not json', secret }), {
      ok: false,
      reason: 'invalid JSON',
      status: 400,
    });
    assert.equal(verifyAndParse({ headers, body: 'tampered', secret }).status, 401);
  });
});

function fakeHonoContext(request) {
  return { req: { raw: request }, marker: 'ctx' };
}

describe('honoHandler', () => {
  const secret = generateSecret();
  const event = createEvent('run.prompt.v1', { prompt: 'hi' });
  const body = JSON.stringify(event);

  it('verifies, calls onEvent with the event and context, returns 204', async () => {
    let got;
    const handler = honoHandler({ secret, onEvent: (e, c) => (got = [e, c.marker]) });
    const req = new Request('https://x.test/hook', {
      method: 'POST',
      headers: signRequest({ id: event.id, timestamp: now(), body, secret }),
      body,
    });
    const res = await handler(fakeHonoContext(req));
    assert.equal(res.status, 204);
    assert.deepEqual(got, [event, 'ctx']);
  });

  it('401 on a bad signature without calling onEvent', async () => {
    let called = false;
    const handler = honoHandler({ secret, onEvent: () => (called = true) });
    const req = new Request('https://x.test/hook', {
      method: 'POST',
      headers: signRequest({ id: event.id, timestamp: now(), body, secret: generateSecret() }),
      body,
    });
    const res = await handler(fakeHonoContext(req));
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: 'signature mismatch' });
    assert.equal(called, false);
  });

  it('400 on a signed but non-JSON body', async () => {
    const handler = honoHandler({ secret, onEvent: () => {} });
    const req = new Request('https://x.test/hook', {
      method: 'POST',
      headers: signRequest({ id: 'm', timestamp: now(), body: '{oops', secret }),
      body: '{oops',
    });
    assert.equal((await handler(fakeHonoContext(req))).status, 400);
  });

  it('500 when onEvent throws, so the sender retries', async () => {
    const handler = honoHandler({ secret, onEvent: () => { throw new Error('boom'); } });
    const req = new Request('https://x.test/hook', {
      method: 'POST',
      headers: signRequest({ id: event.id, timestamp: now(), body, secret }),
      body,
    });
    assert.equal((await handler(fakeHonoContext(req))).status, 500);
  });

  it('onEvent may return its own Response', async () => {
    const handler = fetchHandler({ secret, onEvent: () => Response.json({ queued: true }, { status: 202 }) });
    const req = new Request('https://x.test/hook', {
      method: 'POST',
      headers: signRequest({ id: event.id, timestamp: now(), body, secret }),
      body,
    });
    const res = await handler(req);
    assert.equal(res.status, 202);
    assert.deepEqual(await res.json(), { queued: true });
  });
});
