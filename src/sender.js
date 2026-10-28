// Deliver a signed event with retries.
//
// The webhook-id stays the same on every attempt (receivers dedupe on it); the
// timestamp and signature are fresh per attempt, so a late retry is never
// rejected as stale.

import { randomUUID } from 'node:crypto';
import { signRequest } from './sign.js';

export const DEFAULT_RETRY_DELAYS_MS = [0, 10_000, 60_000];
export const DEFAULT_TIMEOUT_MS = 10_000;
const USER_AGENT = '@profullstack/webhooks';

/** Network errors, timeouts, 408, 429 and 5xx are retried. Other statuses are final. */
export function isRetryable(status) {
  if (status === null || status === undefined) return true;
  return status === 408 || status === 429 || status >= 500;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function postOnce(url, body, headers, timeoutMs, fetchImpl) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    // Never follow a redirect: the URL was checked, where it points was not. A public URL
    // answering 302 to 169.254.169.254 would otherwise walk us into our own network.
    const res = await fetchImpl(url, { method: 'POST', headers, body, signal: controller.signal, redirect: 'manual' });
    // Free the connection; the response body is not part of the result.
    try {
      await res.body?.cancel?.();
    } catch {}
    if (res.status >= 300 && res.status < 400) return { status: res.status, error: `redirect refused (HTTP ${res.status}); use the final URL` };
    return { status: res.status };
  } catch (err) {
    const error = timedOut
      ? `timeout after ${timeoutMs}ms`
      : err instanceof Error
        ? err.message
        : String(err);
    return { status: null, error };
  } finally {
    clearTimeout(timer);
  }
}

export async function sendWebhook(
  url,
  event,
  {
    secret,
    retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    fetchImpl = globalThis.fetch,
    headers = {},
    onAttempt,
    id: givenId,
  } = {},
) {
  if (!url) throw new Error('sendWebhook: url required');
  if (!secret) throw new Error('sendWebhook: secret required');
  if (typeof fetchImpl !== 'function') throw new Error('sendWebhook: no fetch implementation');

  const isString = typeof event === 'string';
  const body = isString ? event : JSON.stringify(event);
  const id =
    givenId ||
    (!isString && event && typeof event.id === 'string' && event.id) ||
    `msg_${randomUUID()}`;
  const contentType =
    !isString && event && event.specversion ? 'application/cloudevents+json' : 'application/json';
  const delays = retryDelaysMs.length ? retryDelaysMs : [0];

  let attempts = 0;
  let status = null;
  let error;
  for (const delay of delays) {
    if (delay > 0) await sleep(delay);
    attempts++;
    const started = Date.now();
    const signed = signRequest({ id, timestamp: Math.floor(Date.now() / 1000), body, secret });
    const reqHeaders = {
      'content-type': contentType,
      'user-agent': USER_AGENT,
      ...headers,
      ...signed,
    };
    const r = await postOnce(url, body, reqHeaders, timeoutMs, fetchImpl);
    status = r.status;
    error = r.error;
    if (typeof onAttempt === 'function') {
      try {
        await onAttempt({ attempt: attempts, status, error, ms: Date.now() - started });
      } catch {}
    }
    if (status !== null && status >= 200 && status < 300) {
      return { ok: true, status, attempts, id };
    }
    if (!isRetryable(status)) break;
  }
  return { ok: false, status, attempts, id, error: error ?? `HTTP ${status}` };
}
