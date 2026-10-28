// Older fleet signature headers, for apps moving onto this package.
//
// A receiver already checks the header an app used to send. Sending that header
// next to the Standard Webhooks ones keeps every existing receiver working while
// customers switch to `verifySignature`. Pass one (or several) as the hub's
// `extraHeaders` and drop it once nobody verifies the old one.

import { createHmac } from 'node:crypto';
import { secretToKey } from './sign.js';

const hmacHex = (secret, content) => createHmac('sha256', secretToKey(secret)).update(content).digest('hex');

/** `t=<unix>,v1=<hex HMAC of "t.body">` (CoinPay, OutreachGraph, wx93, and Stripe's shape). */
export const tV1Header = (name) => ({ body, secret }) => {
  const t = Math.floor(Date.now() / 1000);
  return { [name]: `t=${t},v1=${hmacHex(secret, `${t}.${body}`)}` };
};

/** `sha256=<hex HMAC of body>` (ThreatCrush, rssamplifier, and GitHub's shape). */
export const sha256Header = (name) => ({ body, secret }) => ({ [name]: `sha256=${hmacHex(secret, body)}` });

/** `<hex HMAC of body>` with no prefix (ugig). */
export const hexHeader = (name) => ({ body, secret }) => ({ [name]: hmacHex(secret, body) });

/** Several legacy headers at once. */
export const combineHeaders = (...fns) => (input) => Object.assign({}, ...fns.map((f) => f(input)));
