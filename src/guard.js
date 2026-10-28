// Is a customer's webhook URL safe for our server to POST to?
//
// A webhook URL is chosen by whoever has an account, and our server is the one
// that fetches it. Without a check, "https://169.254.169.254/latest/meta-data"
// or "http://127.0.0.1:5432" is a way to make us probe our own network. So a
// URL must be https, and every address its host resolves to must be public.
// The check runs again on each delivery, because DNS can change after the
// endpoint was saved.

import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/** IPv4 ranges that are not the public internet. */
const PRIVATE_V4 = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

const v4ToInt = (ip) => ip.split('.').reduce((n, part) => (n << 8) + Number(part), 0) >>> 0;

function privateV4(ip) {
  const n = v4ToInt(ip);
  return PRIVATE_V4.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (n & mask) === (v4ToInt(base) & mask);
  });
}

function privateV6(ip) {
  const s = ip.toLowerCase().replace(/^\[|\]$/g, '');
  if (s === '::' || s === '::1') return true;
  // IPv4-mapped (::ffff:10.0.0.1) and the hex form Node prints (::ffff:a00:1).
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (mapped) return privateV4(mapped[1]);
  const hexMapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(s);
  if (hexMapped) {
    const hi = parseInt(hexMapped[1], 16);
    const lo = parseInt(hexMapped[2], 16);
    return privateV4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  const first = parseInt(s.split(':')[0] || '0', 16);
  // fc00::/7 unique local, fe80::/10 link local, ff00::/8 multicast.
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00;
}

/** Whether an IP literal is loopback, private, link-local, reserved or multicast. */
export function isPrivateAddress(ip) {
  const v = isIP(String(ip).replace(/^\[|\]$/g, ''));
  if (v === 4) return privateV4(ip);
  if (v === 6) return privateV6(ip);
  return true;
}

const BLOCKED_HOSTS = /^(localhost|.*\.localhost|.*\.local|.*\.internal|metadata\.google\.internal)$/i;

/**
 * Check a webhook URL. Resolves to `{ ok: true, url }` (normalised) or
 * `{ ok: false, reason }`, never throws.
 *
 * - `allowHttp`: accept http:// too (local development).
 * - `allowPrivate`: skip the address check (tests, or an instance that only
 *   ever posts to its own network on purpose).
 * - `lookup`: a DNS resolver, `(host) => Promise<string[]>`; injected for tests.
 */
export async function checkUrl(input, { allowHttp = false, allowPrivate = false, lookup } = {}) {
  let url;
  try {
    url = new URL(String(input).trim());
  } catch {
    return { ok: false, reason: 'not a URL' };
  }
  if (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:')) {
    return { ok: false, reason: allowHttp ? 'must be http or https' : 'must be https' };
  }
  if (url.username || url.password) return { ok: false, reason: 'no credentials in the URL; use the signing secret' };
  if (String(input).length > 2000) return { ok: false, reason: 'URL too long' };
  url.hash = '';
  if (allowPrivate) return { ok: true, url: url.toString() };

  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (BLOCKED_HOSTS.test(host)) return { ok: false, reason: 'that host is not on the public internet' };
  let addresses;
  if (isIP(host)) addresses = [host];
  else {
    try {
      addresses = lookup
        ? await lookup(host)
        : (await dnsLookup(host, { all: true, verbatim: true })).map((a) => a.address);
    } catch {
      return { ok: false, reason: `cannot resolve ${host}` };
    }
  }
  if (!addresses.length) return { ok: false, reason: `cannot resolve ${host}` };
  if (addresses.some(isPrivateAddress)) return { ok: false, reason: 'that host is not on the public internet' };
  return { ok: true, url: url.toString() };
}
