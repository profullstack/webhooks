// Receive side: verify the signature over the raw body, then parse.
// Always pass the body exactly as received; re-serialised JSON will not match.

import { verifySignature } from './sign.js';

export function verifyAndParse({ headers, body, secret, toleranceSeconds = 300, now } = {}) {
  const sig = verifySignature({ headers, body, secret, toleranceSeconds, now });
  if (!sig.ok) return { ok: false, reason: sig.reason, status: 401 };
  let event;
  try {
    const text = typeof body === 'string' ? body : new TextDecoder().decode(body);
    event = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'invalid JSON', status: 400 };
  }
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    return { ok: false, reason: 'event must be a JSON object', status: 400 };
  }
  return { ok: true, event, id: sig.id };
}

function json(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * A `(request: Request) => Promise<Response>` handler, for Bun.serve, Deno,
 * Workers, or anything else that speaks the Fetch API.
 * `onEvent(event, ctx)` may return a Response to override the default 204.
 * A throw from onEvent becomes a 500, which the sender retries.
 */
export function fetchHandler({ secret, onEvent, toleranceSeconds = 300 } = {}) {
  if (!secret) throw new Error('fetchHandler: secret required');
  if (typeof onEvent !== 'function') throw new Error('fetchHandler: onEvent required');
  return async (request, ctx) => {
    if (request.method && request.method !== 'POST') {
      return json(405, { error: 'method not allowed' });
    }
    const body = await request.text();
    const r = verifyAndParse({ headers: request.headers, body, secret, toleranceSeconds });
    if (!r.ok) return json(r.status, { error: r.reason });
    try {
      const out = await onEvent(r.event, ctx ?? request);
      if (out instanceof Response) return out;
    } catch (err) {
      return json(500, { error: 'handler failed' });
    }
    return new Response(null, { status: 204 });
  };
}

/**
 * Hono route handler: `app.post('/webhooks', honoHandler({ secret, onEvent }))`.
 * Duck-typed on `c.req.raw` (a Fetch Request), so hono is not a dependency.
 */
export function honoHandler({ secret, onEvent, toleranceSeconds = 300 } = {}) {
  const handle = fetchHandler({ secret, onEvent, toleranceSeconds });
  return (c) => handle(c.req.raw, c);
}
