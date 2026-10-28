// The /webhooks API every app mounts, as a plain fetch handler so Hono, Next
// route handlers, Bun.serve and itty all take it unchanged.
//
//   const api = webhooksApi(hooks, { basePath: '/api/v1/webhooks', owner: async (req) => userIdFrom(req) });
//   app.all('/api/v1/webhooks/*', async (c) => (await api(c.req.raw)) ?? c.notFound());   // Hono
//   app.all('/api/v1/webhooks', async (c) => (await api(c.req.raw)) ?? c.notFound());
//
// Routes (all JSON, all scoped to the caller):
//   GET    /                       endpoints + the event types this app emits
//   POST   /                       { url, events?, description? } -> { endpoint, secret }
//   GET    /:id                    one endpoint
//   PATCH  /:id                    { url?, events?, description?, enabled? }
//   DELETE /:id
//   GET    /:id/secret             { secret }
//   POST   /:id/rotate             { secret }  (the old one stops working)
//   POST   /:id/test               sends webhook.test now: { ok, status, error }
//   GET    /:id/deliveries         recent deliveries, with payloads
//   GET    /deliveries             recent deliveries across endpoints
//   POST   /deliveries/:id/retry   send one again

import { WebhookError } from './hub.js';

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/**
 * @param {import('./hub.js').Webhooks} hooks
 * @param {{ basePath?: string, owner: (req: Request) => string | null | undefined | Promise<string | null | undefined> }} opts
 * @returns {(req: Request) => Promise<Response | null>} null when the path is not ours
 */
export function webhooksApi(hooks, { basePath = '/api/v1/webhooks', owner } = {}) {
  if (typeof owner !== 'function') throw new Error('webhooksApi: owner(req) required');
  const base = basePath.replace(/\/+$/, '');
  return async (req) => {
    const path = new URL(req.url).pathname.replace(/\/+$/, '');
    if (path !== base && !path.startsWith(`${base}/`)) return null;
    const parts = path.slice(base.length).split('/').filter(Boolean).map(decodeURIComponent);
    const who = await owner(req);
    if (!who) return json({ error: 'sign in or send an API key' }, 401);
    const method = req.method.toUpperCase();
    const body = async () => {
      if (method === 'GET' || method === 'DELETE') return {};
      try {
        return (await req.json()) ?? {};
      } catch {
        return {};
      }
    };
    const limit = Number(new URL(req.url).searchParams.get('limit') ?? 50);
    try {
      const [a, b, c] = parts;
      if (!a) {
        if (method === 'GET') return json({ endpoints: await hooks.listEndpoints(who), event_types: hooks.eventTypes });
        if (method === 'POST') return json(await hooks.createEndpoint(who, await body()), 201);
      } else if (a === 'deliveries') {
        if (!b && method === 'GET') return json({ deliveries: await hooks.deliveries(who, { limit }) });
        if (b && c === 'retry' && method === 'POST') return json(await hooks.redeliver(who, b), 202);
      } else if (!b) {
        if (method === 'GET') return json(await hooks.getEndpoint(who, a));
        if (method === 'PATCH' || method === 'PUT') return json(await hooks.updateEndpoint(who, a, await body()));
        if (method === 'DELETE') return json(await hooks.deleteEndpoint(who, a));
      } else if (!c) {
        if (b === 'secret' && method === 'GET') return json(await hooks.secret(who, a));
        if (b === 'rotate' && method === 'POST') return json(await hooks.rotateSecret(who, a));
        if (b === 'test' && method === 'POST') return json(await hooks.test(who, a));
        if (b === 'deliveries' && method === 'GET') return json({ deliveries: await hooks.deliveries(who, { endpointId: a, limit }) });
      }
      return json({ error: 'not found' }, 404);
    } catch (e) {
      if (e instanceof WebhookError) return json({ error: e.message }, e.status);
      throw e;
    }
  };
}
