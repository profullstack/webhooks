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
  /** The webhook-id to send. Defaults to the event's id, or a random msg_ id. */
  id?: string;
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

// ---- the hub: endpoints, events and durable delivery --------------------

export interface GuardOptions {
  /** Accept http:// too (development). */
  allowHttp?: boolean;
  /** Skip the public-address check. */
  allowPrivate?: boolean;
  /** DNS resolver, for tests. */
  lookup?: (host: string) => Promise<string[]>;
}

/** https only, and every address the host resolves to must be public (no SSRF). */
export function checkUrl(url: string, options?: GuardOptions): Promise<{ ok: true; url: string } | { ok: false; reason: string }>;
export function isPrivateAddress(ip: string): boolean;

export interface Endpoint {
  id: string;
  owner: string;
  url: string;
  secret: string;
  events: string[];
  description: string;
  enabled: boolean;
  failures: number;
  disabledReason: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface Delivery {
  id: string;
  endpointId: string;
  owner: string;
  eventId: string;
  eventType: string;
  payload: string;
  status: 'pending' | 'delivered' | 'failed';
  attempts: number;
  nextAt: number;
  lastStatus: number | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface WebhookStore {
  insertEndpoint(e: Endpoint): Promise<void>;
  getEndpoint(id: string): Promise<Endpoint | null>;
  listEndpoints(owner: string): Promise<Endpoint[]>;
  updateEndpoint(id: string, patch: Partial<Endpoint>): Promise<void>;
  deleteEndpoint(id: string): Promise<void>;
  insertDeliveries(rows: Delivery[]): Promise<void>;
  getDelivery(id: string): Promise<Delivery | null>;
  listDeliveries(q: { owner: string; endpointId?: string; limit?: number }): Promise<Delivery[]>;
  updateDelivery(id: string, patch: Partial<Delivery>): Promise<void>;
  claimDue(now: number, limit: number, leaseMs: number): Promise<Delivery[]>;
  prune(before: number): Promise<void>;
}

export type SqliteLike =
  | { exec(sql: string): void; query(sql: string): { all(...p: unknown[]): unknown[]; run(...p: unknown[]): unknown } }
  | { exec(sql: string): void; prepare(sql: string): { all(...p: unknown[]): unknown[]; run(...p: unknown[]): unknown } };
export type PgLike = { query(sql: string, params?: unknown[]): Promise<{ rows: any[] }> };

export function memoryStore(): WebhookStore;
/** Creates its tables unless `migrate: false`. */
export function sqliteStore(db: SqliteLike, options?: { prefix?: string; migrate?: boolean }): WebhookStore;
/** Run `schemaSql('pg')` in your migrations, or pass `migrate: true` and await `ready`. */
export function postgresStore(pool: PgLike, options?: { prefix?: string; migrate?: boolean }): WebhookStore & { ready: Promise<void> };
export function schemaSql(dialect?: 'sqlite' | 'pg', prefix?: string): string[];

export interface PublicEndpoint {
  id: string;
  url: string;
  events: string[];
  description: string;
  enabled: boolean;
  failures: number;
  disabled_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface PublicDelivery {
  id: string;
  endpoint_id: string;
  event_id: string;
  event_type: string;
  status: 'pending' | 'delivered' | 'failed';
  attempts: number;
  next_at: string | null;
  last_status: number | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  payload?: unknown;
}

export const DEFAULT_BACKOFF_MS: number[];
export const DEFAULT_DISABLE_AFTER: number;
export const TEST_EVENT: 'webhook.test';
export function matchesEvent(patterns: string[], type: string): boolean;
export function publicEndpoint(e: Endpoint): PublicEndpoint;
export function publicDelivery(d: Delivery, options?: { payload?: boolean }): PublicDelivery;

export class WebhookError extends Error {
  status: number;
  constructor(message: string, status?: number);
}

export interface WebhooksOptions {
  store: WebhookStore;
  /** CloudEvents source: your site's URL. */
  source?: string;
  /** The events this app emits; endpoint patterns must match one. */
  eventTypes?: string[];
  /** Per owner. Default 10. */
  maxEndpoints?: number;
  /** Wait before attempt 2, 3, ... Default about three days in all. */
  backoffMs?: number[];
  /** Consecutive failures that switch an endpoint off. Default 20. */
  disableAfter?: number;
  timeoutMs?: number;
  guard?: GuardOptions;
  fetchImpl?: typeof fetch;
  now?: () => number;
  onDelivery?: (info: { delivery: PublicDelivery; endpoint: PublicEndpoint; ok: boolean }) => void | Promise<void>;
  log?: (message: string) => void;
}

export class Webhooks {
  constructor(options: WebhooksOptions);
  readonly eventTypes: string[];
  createEndpoint(owner: string, input: { url: string; events?: string[] | string; description?: string }): Promise<{ endpoint: PublicEndpoint; secret: string }>;
  listEndpoints(owner: string): Promise<PublicEndpoint[]>;
  getEndpoint(owner: string, id: string): Promise<PublicEndpoint>;
  updateEndpoint(owner: string, id: string, patch: { url?: string; events?: string[] | string; description?: string; enabled?: boolean }): Promise<PublicEndpoint>;
  deleteEndpoint(owner: string, id: string): Promise<{ deleted: true }>;
  secret(owner: string, id: string): Promise<{ secret: string }>;
  rotateSecret(owner: string, id: string): Promise<{ secret: string }>;
  /** Queue an event for every subscribed endpoint of `owner`; returns at once. */
  emit(owner: string, type: string, data: unknown, options?: { subject?: string; id?: string }): Promise<{ id: string; queued: number }>;
  test(owner: string, id: string): Promise<{ ok: boolean; status: number | null; error: string | null; delivery_id: string }>;
  deliveries(owner: string, options?: { endpointId?: string; limit?: number }): Promise<PublicDelivery[]>;
  redeliver(owner: string, deliveryId: string): Promise<PublicDelivery>;
  /** Send everything due now. */
  drain(options?: { limit?: number }): Promise<number>;
  /** Drain every few seconds in the background. */
  start(options?: { intervalMs?: number; keepDays?: number }): this;
  stop(): void;
}

/** The /webhooks API as a fetch handler; resolves null for paths outside `basePath`. */
export function webhooksApi(
  hooks: Webhooks,
  options: { basePath?: string; owner: (req: Request) => string | null | undefined | Promise<string | null | undefined> },
): (req: Request) => Promise<Response | null>;

export interface SecretBox {
  seal(secret: string): string | Promise<string>;
  open(sealed: string): string | Promise<string>;
}
export interface WebhooksOptions {
  /** Older signature headers sent next to the Standard Webhooks ones while receivers migrate. */
  extraHeaders?: (input: { body: string; secret: string; endpoint: PublicEndpoint; eventType: string }) => Record<string, string>;
  /** Encrypt signing secrets at rest with the app's own key. */
  secretBox?: SecretBox;
}

type LegacySigner = (input: { body: string; secret: string }) => Record<string, string>;
/** `t=<unix>,v1=<hex HMAC of "t.body">` (CoinPay, OutreachGraph, wx93). */
export function tV1Header(name: string): LegacySigner;
/** `sha256=<hex HMAC of body>` (ThreatCrush, rssamplifier). */
export function sha256Header(name: string): LegacySigner;
/** Bare hex HMAC of the body (ugig). */
export function hexHeader(name: string): LegacySigner;
export function combineHeaders(...signers: LegacySigner[]): LegacySigner;
