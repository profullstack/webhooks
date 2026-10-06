// Type definitions for @profullstack/webhooks

/** `whsec_<base64>` (spec form), any other string (used as UTF-8 bytes), or raw key bytes. */
export type WebhookSecret = string | Uint8Array;

/** The raw request body, exactly as received or sent. */
export type WebhookBody = string | Uint8Array | ArrayBuffer;

export type HeaderBag =
  | Headers
  | { get(name: string): string | null }
  | Record<string, string | string[] | undefined | null>;

export interface SignedHeaders {
  'webhook-id': string;
  'webhook-timestamp': string;
  'webhook-signature': string;
}

export interface SignInput {
  id: string;
  /** Unix seconds (or a Date). Defaults to now. */
  timestamp?: number | Date;
  body: WebhookBody;
  secret: WebhookSecret;
}

export function signRequest(input: SignInput): SignedHeaders;

export interface VerifyInput {
  headers: HeaderBag;
  body: WebhookBody;
  secret: WebhookSecret;
  /** Allowed clock skew either way, in seconds. Default 300. */
  toleranceSeconds?: number;
  /** Override "now" in unix seconds. Testing only. */
  now?: () => number;
}

export type VerifyResult =
  | { ok: true; id: string; timestamp: number }
  | { ok: false; reason: string };

export function verifySignature(input: VerifyInput): VerifyResult;

/** `whsec_` + base64 of 32 random bytes. */
export function generateSecret(): string;

/** The HMAC key bytes a secret resolves to. */
export function secretToKey(secret: WebhookSecret): Buffer;

/** Case-insensitive header read from a Headers instance or a plain object. */
export function getHeader(headers: HeaderBag, name: string): string | null;

export interface CloudEvent<T = unknown> {
  specversion: '1.0';
  id: string;
  type: string;
  source: string;
  subject?: string;
  time: string;
  datacontenttype: 'application/json';
  data: T;
}

export interface CreateEventOptions {
  /** Defaults to `urn:profullstack:webhooks`. */
  source?: string;
  subject?: string;
  /** Defaults to a random UUID. */
  id?: string;
  /** Defaults to now. */
  time?: string | Date;
}

export const DEFAULT_SOURCE: string;

export function createEvent<T = unknown>(
  type: string,
  data: T,
  options?: CreateEventOptions,
): CloudEvent<T>;

export interface AttemptInfo {
  attempt: number;
  /** HTTP status, or null for a network error or timeout. */
  status: number | null;
  error?: string;
  ms: number;
}

export interface SendWebhookOptions {
  secret: WebhookSecret;
  /** One entry per attempt: the wait before it. Default [0, 10000, 60000]. */
  retryDelaysMs?: number[];
  /** Per-attempt timeout. Default 10000. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Extra request headers. The webhook-* headers always win. */
  headers?: Record<string, string>;
  onAttempt?: (info: AttemptInfo) => void | Promise<void>;
}

export interface DeliveryResult {
  ok: boolean;
  status: number | null;
  attempts: number;
  /** The webhook-id used on every attempt (the event id when it has one). */
  id: string;
  error?: string;
}

export const DEFAULT_RETRY_DELAYS_MS: number[];
export const DEFAULT_TIMEOUT_MS: number;

/** True for network errors/timeouts (null), 408, 429 and 5xx. */
export function isRetryable(status: number | null | undefined): boolean;

/** POST a signed event. An object is JSON encoded; a string is sent as is. */
export function sendWebhook(
  url: string | URL,
  event: CloudEvent | Record<string, unknown> | string,
  options: SendWebhookOptions,
): Promise<DeliveryResult>;

export type ParseResult<T = any> =
  | { ok: true; event: T; id: string }
  | { ok: false; reason: string; status: 400 | 401 };

export function verifyAndParse<T = CloudEvent>(input: VerifyInput): ParseResult<T>;

export interface HandlerOptions<Ctx> {
  secret: WebhookSecret;
  /** Return a Response to override the default 204. A throw becomes a 500. */
  onEvent: (event: any, ctx: Ctx) => unknown | Promise<unknown>;
  toleranceSeconds?: number;
}

/** `(request) => Response` for Bun.serve, Workers, Deno or any Fetch API server. */
export function fetchHandler<Ctx = Request>(
  options: HandlerOptions<Ctx>,
): (request: Request, ctx?: Ctx) => Promise<Response>;

/** Hono route handler. Only `c.req.raw` is read, so hono is not a dependency. */
export function honoHandler<C extends { req: { raw: Request } } = any>(
  options: HandlerOptions<C>,
): (c: C) => Promise<Response>;
