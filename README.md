# @profullstack/webhooks

Standard Webhooks signing, verification and delivery with retries, plus the
whole "webhooks" feature an app offers its customers: endpoints with signing
keys, event filters, a durable outbox with backoff, a delivery log, test pings,
SSRF-safe URLs and a drop-in `/webhooks` API. Zero dependencies.

Every app in the fleet that sends or receives a webhook does it the same way:
a [CloudEvents 1.0](https://cloudevents.io/) JSON body, signed per the
[Standard Webhooks](https://www.standardwebhooks.com/) spec. This package is
that one way, so nobody hand-rolls HMAC again.

- Plain ESM JavaScript with hand-written types. No runtime dependencies.
- Works in Node >= 20 and Bun (uses `node:crypto`, `fetch`, `Request`, `Response`).
- Matches the Standard Webhooks reference test vector, so any spec-compliant
  library (Svix, `standardwebhooks`, etc.) can talk to it.

```bash
npm i @profullstack/webhooks
# or
bun add @profullstack/webhooks
```

## Give your app webhooks (the hub)

Every fleet app with an API offers customers a webhook callback the same way:

```js
import { Webhooks, sqliteStore, webhooksApi } from '@profullstack/webhooks';

const hooks = new Webhooks({
  store: sqliteStore(db),                  // or postgresStore(pool), memoryStore()
  source: 'https://group.call.pit.world',  // CloudEvents source
  eventTypes: ['room.joined', 'room.left', 'recording.ready'],
}).start();                                // drains due deliveries every 5 s

// Mount the API (any framework: it is a fetch handler that returns null when the path is not its own).
const api = webhooksApi(hooks, { basePath: '/api/v1/webhooks', owner: async (req) => (await userFrom(req))?.id });
app.all('/api/v1/webhooks/*', async (c) => (await api(c.req.raw)) ?? c.notFound());
app.all('/api/v1/webhooks', async (c) => (await api(c.req.raw)) ?? c.notFound());

// Wherever something happens:
await hooks.emit(user.id, 'room.joined', { code: '4821', who: 'Anthony' }, { subject: 'room:4821' });
```

| Route (under basePath) | Does |
| --- | --- |
| `GET /` | endpoints + the app's `event_types` |
| `POST /` `{ url, events?, description? }` | new endpoint; returns `{ endpoint, secret }` |
| `GET / PATCH / DELETE /:id` | read, change (`url`, `events`, `description`, `enabled`), remove |
| `GET /:id/secret`, `POST /:id/rotate` | show the secret, or replace it |
| `POST /:id/test` | sends `webhook.test` now and says how it went |
| `GET /:id/deliveries`, `GET /deliveries` | the delivery log, with payloads |
| `POST /deliveries/:id/retry` | send one again |

What it does for you:

- **Payloads** are CloudEvents 1.0 JSON with `webhook-id`, `webhook-timestamp`, `webhook-signature`
  (Standard Webhooks) and `webhook-event` headers. Receivers verify with `verifySignature` or any
  Standard Webhooks library, and dedupe on `webhook-id` (delivery is at least once).
- **Events** are patterns: `*`, `room.joined`, `room.*`. With `eventTypes` set, a pattern that
  matches nothing is refused.
- **Retries** live in the store, so a restart loses nothing: after a failure it waits 30 s, 2 min,
  10 min, 1 h, 6 h, 24 h, 48 h (`backoffMs`), each endpoint in order. 20 failures in a row switch the
  endpoint off (`disableAfter`); turning it back on clears the count.
- **URLs** must be https and resolve only to public addresses, checked when saved and before every
  delivery (`checkUrl`; `guard: { allowHttp, allowPrivate }` for development).
- **Secrets** are `whsec_` keys, shown on create, `secret` and `rotate`. Pass
  `secretBox: { seal, open }` to keep them encrypted at rest.
- **Stores**: `sqliteStore(db)` (bun:sqlite, node:sqlite, better-sqlite3; creates its tables),
  `postgresStore(pool)` (anything with pg's `query`; run `schemaSql('pg')` in your migrations or
  pass `{ migrate: true }`), `memoryStore()`. `prefix` namespaces the two tables.
- **Moving an app that signed its own way**: keep its old header next to the new ones until
  customers switch, with `extraHeaders: tV1Header('x-coinpay-signature')` (`t=,v1=hex`),
  `sha256Header(name)` (`sha256=hex`) or `hexHeader(name)`; `combineHeaders(...)` for several.

Surfaces: the house rule is API + CLI + MCP for every feature. The CLI and MCP of an app wrap these
routes with its own key (`groupcall webhooks ...`, MCP `create_webhook`, ...).

## Make a secret

```js
import { generateSecret } from '@profullstack/webhooks';

generateSecret(); // 'whsec_3j1V...=' (base64 of 32 random bytes)
```

Store it in the vault on both sides. Secrets are accepted in two forms:

- `whsec_<base64>`: the spec form. The HMAC key is the decoded base64.
- any other string: used as its UTF-8 bytes. This is what older fleet senders
  (autoblog) did, so existing shared secrets keep working.

## Send

```js
import { createEvent, sendWebhook } from '@profullstack/webhooks';

const event = createEvent('com.profullstack.ai.prompt.run.v1', { prompt: 'Summarize the repo' }, {
  source: 'https://ai.profullstack.com',
  subject: 'run:42',
});

const result = await sendWebhook('https://agent.example.com/webhooks', event, {
  secret: process.env.WEBHOOK_SECRET,
  onAttempt: ({ attempt, status, error, ms }) => log.info({ attempt, status, error, ms }),
});
// { ok: true, status: 204, attempts: 1, id: '<event.id>' }
```

`createEvent(type, data, { source, subject, id, time })` returns:

```json
{
  "specversion": "1.0",
  "id": "8f0c...",
  "type": "com.profullstack.ai.prompt.run.v1",
  "source": "https://ai.profullstack.com",
  "subject": "run:42",
  "time": "2026-10-06T12:00:00.000Z",
  "datacontenttype": "application/json",
  "data": { "prompt": "Summarize the repo" }
}
```

`source` defaults to `urn:profullstack:webhooks`, `id` to a random UUID and
`time` to now. `sendWebhook` also accepts any plain object or a pre-serialised
string as the event.

## Receive in Hono (Bun)

```js
import { Hono } from 'hono';
import { honoHandler } from '@profullstack/webhooks';

const app = new Hono();

app.post('/webhooks', honoHandler({
  secret: process.env.WEBHOOK_SECRET,
  onEvent: async (event, c) => {
    await queue.add(event.type, event.data, { jobId: event.id });
  },
}));
```

The handler reads the raw body from `c.req.raw`, verifies it, and calls
`onEvent(event, c)`. It answers:

| Status | When |
| --- | --- |
| 204 | verified and `onEvent` returned |
| 401 | missing headers, bad signature, or timestamp outside tolerance |
| 400 | signature fine but the body is not a JSON object |
| 405 | not a POST |
| 500 | `onEvent` threw (so the sender retries) |

Return a `Response` from `onEvent` to send something else (for example a 202).
It does not import hono. For `Bun.serve`, Workers or Deno use
`fetchHandler({ secret, onEvent })`, which takes a plain `Request`.

## Receive in Node (node:http)

The signature is over the bytes as received, so read the raw body. Never
verify `JSON.stringify(await req.json())`.

```js
import http from 'node:http';
import { verifyAndParse } from '@profullstack/webhooks';

http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString('utf8');

  const r = verifyAndParse({ headers: req.headers, body, secret: process.env.WEBHOOK_SECRET });
  if (!r.ok) {
    res.writeHead(r.status, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: r.reason }));
  }
  await handle(r.event); // r.id is the webhook-id, dedupe on it
  res.writeHead(204).end();
}).listen(8787);
```

`verifyAndParse` returns `{ ok: true, event, id }` or
`{ ok: false, reason, status }` with status 401 for an auth failure and 400 for
bad JSON. If you only need the signature check, `verifySignature` returns
`{ ok: true, id, timestamp }` or `{ ok: false, reason }`. Both take `headers`
as a `Headers` instance or a plain object (any case).

## Header format

Three headers, per the Standard Webhooks spec:

```
webhook-id: 8f0c2d1e-...            the event id, identical on every retry
webhook-timestamp: 1791288000       unix seconds, fresh on every attempt
webhook-signature: v1,K5oZfzN95Z9UVu1EsfQmfVNQhnkZ2pj9o9NDN/H/pI4=
```

The signature is `v1,` plus the base64 HMAC-SHA256 of
`${webhook-id}.${webhook-timestamp}.${body}`, keyed with the secret. Comparison
is constant time.

- **Replay window:** a timestamp more than `toleranceSeconds` (default 300) away
  from the receiver's clock, either way, is rejected.
- **Key rotation:** the signature header may hold several space-separated
  signatures (`v1,abc v1,def`). A receiver accepts if any one matches its
  secret, so sign with old and new keys during a rotation. Entries with a
  version other than `v1` are ignored.
- **Idempotency:** retries reuse the same `webhook-id`. Receivers should treat
  a repeated id as already handled.

`signRequest({ id, timestamp, body, secret })` builds these headers if you want
to manage transport yourself.

Requests also carry `content-type: application/cloudevents+json` (or
`application/json` for a non-CloudEvents body) and
`user-agent: @profullstack/webhooks`. Extra `headers` you pass are merged in,
but can never replace the `webhook-*` ones.

## Retry policy

`sendWebhook(url, event, { secret, retryDelaysMs, timeoutMs, fetchImpl, headers, onAttempt })`

- `retryDelaysMs` (default `[0, 10_000, 60_000]`) has one entry per attempt:
  the wait before that attempt. The default is three attempts over about 70
  seconds. `[0]` means a single attempt.
- **Retried:** network errors, timeouts, `408`, `429` and any `5xx`.
- **Not retried:** any other `4xx`. The receiver has said the request itself is
  wrong, and sending it again will not change that.
- Any `2xx` is success.
- `timeoutMs` (default 10 s) bounds each attempt, not the whole delivery.
- `onAttempt({ attempt, status, error, ms })` runs after every attempt, for a
  delivery log. `status` is `null` for a network error or timeout.
- The result is `{ ok, status, attempts, id, error? }`. It never throws for a
  failed delivery; it throws only for a missing `url` or `secret`.

Delays run in-process. For deliveries that must survive a restart, put them on
a queue (BullMQ, etc.) with `retryDelaysMs: [0]` and let the queue retry.

## License

MIT, Profullstack, LLC
