// Standard Webhooks signing and verification.
// Spec: https://www.standardwebhooks.com/
//
// The signed content is `${webhook-id}.${webhook-timestamp}.${body}`, MACed
// with HMAC-SHA256 and base64 encoded, prefixed with the version tag `v1,`.
// A receiver rejects a timestamp outside the tolerance window (5 minutes by
// default), so a captured delivery cannot be replayed later.
//
// node:crypto rather than crypto.subtle so signing stays synchronous; Bun
// implements the same module, so one code path serves both runtimes.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const SIG_VERSION = 'v1';
const SECRET_PREFIX = 'whsec_';
const encoder = new TextEncoder();

/**
 * Turn a secret into HMAC key bytes.
 * - `whsec_<base64>`: the spec form, the key is the decoded base64.
 * - any other string: used as UTF-8 bytes (compatible with older fleet senders).
 * - Uint8Array / Buffer: used as is.
 */
export function secretToKey(secret) {
  if (secret instanceof Uint8Array) {
    if (secret.length === 0) throw new Error('webhooks: secret is empty');
    return Buffer.from(secret);
  }
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new Error('webhooks: secret required');
  }
  if (secret.startsWith(SECRET_PREFIX)) {
    const b64 = secret.slice(SECRET_PREFIX.length);
    const key = Buffer.from(b64, 'base64');
    if (key.length === 0) throw new Error('webhooks: whsec_ secret has no key bytes');
    return key;
  }
  return Buffer.from(secret, 'utf8');
}

function bodyBytes(body) {
  if (typeof body === 'string') return encoder.encode(body);
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  throw new Error('webhooks: body must be a string or bytes (the raw request body)');
}

function computeSignature(id, timestamp, body, key) {
  return createHmac('sha256', key)
    .update(`${id}.${timestamp}.`)
    .update(bodyBytes(body))
    .digest('base64');
}

export function signRequest({ id, timestamp, body, secret } = {}) {
  if (!id || typeof id !== 'string') throw new Error('signRequest: id required');
  if (timestamp instanceof Date) timestamp = Math.floor(timestamp.getTime() / 1000);
  if (timestamp === undefined) timestamp = Math.floor(Date.now() / 1000);
  if (!Number.isInteger(timestamp)) throw new Error('signRequest: timestamp must be integer unix seconds');
  if (body === undefined || body === null) throw new Error('signRequest: body required');
  const mac = computeSignature(id, timestamp, body, secretToKey(secret));
  return {
    'webhook-id': id,
    'webhook-timestamp': String(timestamp),
    'webhook-signature': `${SIG_VERSION},${mac}`,
  };
}

/** Case-insensitive header read from a Headers instance or a plain object. */
export function getHeader(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === 'function') return headers.get(name);
  const lower = name.toLowerCase();
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === lower) {
      const v = headers[k];
      if (Array.isArray(v)) return v.length ? v.join(' ') : null;
      return v == null ? null : String(v);
    }
  }
  return null;
}

function safeEqual(a, b) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function verifySignature({ headers, body, secret, toleranceSeconds = 300, now } = {}) {
  const id = getHeader(headers, 'webhook-id');
  const ts = getHeader(headers, 'webhook-timestamp');
  const sig = getHeader(headers, 'webhook-signature');
  if (!id) return { ok: false, reason: 'missing webhook-id' };
  if (!ts) return { ok: false, reason: 'missing webhook-timestamp' };
  if (!sig) return { ok: false, reason: 'missing webhook-signature' };

  if (!/^\d+$/.test(ts.trim())) return { ok: false, reason: 'invalid webhook-timestamp' };
  const timestamp = Number(ts.trim());
  const nowSec = typeof now === 'function' ? now() : Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - timestamp) > toleranceSeconds) {
    return { ok: false, reason: 'timestamp outside tolerance' };
  }

  let key;
  let expected;
  try {
    key = secretToKey(secret);
    expected = computeSignature(id, timestamp, body, key);
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }

  // Several space-delimited signatures are allowed (key rotation). Accept if
  // any v1 entry matches; entries with other versions are ignored.
  let matched = false;
  for (const entry of sig.split(' ')) {
    const comma = entry.indexOf(',');
    if (comma === -1) continue;
    if (entry.slice(0, comma) !== SIG_VERSION) continue;
    // No early exit: every candidate is compared, so timing does not reveal which matched.
    if (safeEqual(entry.slice(comma + 1), expected)) matched = true;
  }
  if (!matched) return { ok: false, reason: 'signature mismatch' };
  return { ok: true, id, timestamp };
}

export function generateSecret() {
  return SECRET_PREFIX + randomBytes(32).toString('base64');
}
