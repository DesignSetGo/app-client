export const BRIDGE_VERSION = 1;

export const BRIDGE_ERROR_CODES = [
  'permission_denied',
  'not_authenticated',
  'unknown_method',
  'invalid_params',
  'not_found',
  'rate_limited',
  'payload_too_large',
  'internal_error',
  'ai_not_configured',
  'not_implemented',
  'ability_handler_error',
  'app_load_failed',
  'ability_not_implemented',
  'ability_timeout',
  // HTTP proxy errors — soft TS-break for apps that exhaustively switch
  // over BridgeError.code (add new arms or fall through `default:`).
  'http_permission_denied',
  'http_invalid_url',
  'http_method_not_allowed',
  'http_host_not_allowed',
  'http_invalid_header',
  'http_invalid_body',
  'http_unknown_secret',
  'http_secret_not_set',
  'http_ssrf_blocked',
  'http_request_too_large',
  'http_response_too_large',
  'http_timeout',
  'http_rate_limited',
  'http_network_error',
  'sodium_unavailable',
  // Apps-as-abilities: companion-plugin resolution at registration time.
  // Surfaced when AbilitiesPublisher::registration_args hits the
  // !class_exists branch — the published ability is registered with
  // a sentinel callback that returns this code, so any caller
  // (cron, webhook, dsgo.abilities.invoke) gets a structured signal
  // that the companion plugin is missing rather than a generic
  // ability error.
  'execute_php_class_not_loadable',
] as const;

export type BridgeErrorCode = (typeof BRIDGE_ERROR_CODES)[number];

export interface BridgeError {
  code: BridgeErrorCode;
  message: string;
  details?: unknown;
}

export interface BridgeContext {
  bridgeVersion: number;
  appId: string;
  mode: 'page' | 'block' | 'admin';
  locale: string;
  theme: 'light' | 'dark';
  blockProps: Record<string, unknown> | null;
  /**
   * URL `:param` captures for the current request. Empty `{}` for static
   * routes; populated for inline-mode dynamic routes (e.g. `/customers/:id`
   * matching `/customers/123` yields `{ id: '123' }`).
   */
  routeParams: Record<string, string>;
  /**
   * Path within the app's mount. Always starts with `/`. For prefixed mounts,
   * excludes `/{prefix}/{appId}`. For block-embedded apps, always `/`.
   */
  path: string;
  /** Query string with leading `?`, or `""` when none. */
  search: string;
  /** Fragment with leading `#`, or `""` when none. */
  hash: string;
  /**
   * The site-relative prefix the app mounts under, used for client-side
   * navigation validation. `""` for a root-mounted app; `/apps/{id}` (no
   * trailing slash) for a prefixed mount. `null` when the bridge runs in
   * a context where navigation is internal-only (block embed, admin).
   */
  mountPrefix: string | null;
  /**
   * Set when manifest declares "ai" in permissions.read; the value is the
   * manifest's ai.timeout_seconds. Used by the per-method client timeout
   * map so dsgo.ai.prompt() isn't killed at the default 30s.
   */
  aiTimeoutSeconds?: number;
}

export type BridgeRequest = {
  type: 'dsgo:request';
  id: string;
  method: string;
  params?: unknown;
};

export type BridgeResponse =
  | { type: 'dsgo:response'; id: string; ok: true; data: unknown }
  | { type: 'dsgo:response'; id: string; ok: false; error: BridgeError };

export type BridgeContextEvent = {
  type: 'dsgo:context';
  payload: BridgeContext;
};

export type BridgeHello = {
  type: 'dsgo:hello';
};

export type BridgeMessage = BridgeRequest | BridgeResponse | BridgeContextEvent | BridgeHello;

export const REQUEST_TIMEOUT_MS = 30_000;
export const MAX_INFLIGHT_REQUESTS = 32;

/**
 * Per-method timeout overrides. Keys are bridge method names; values are
 * functions that compute the timeout (ms) from context. Methods absent from
 * this map fall back to REQUEST_TIMEOUT_MS.
 */
export const METHOD_TIMEOUTS_MS: Record<string, (ctx: BridgeContext) => number> = {
  'ai.prompt': (ctx) => Math.min(120_000, (ctx.aiTimeoutSeconds ?? 60) * 1000) + 5_000,
};

// New types for the AI bridge surface ----------------------------------

export type Role = 'user' | 'assistant' | 'system';

export interface PromptMessage { role: Role; content: string }

/**
 * Shape returned by `dsgo.help.method(name)`. Mirrors the entry shape in
 * `designsetgo-apps/data/bridge-methods.json` — see `Bridge_Method_Registry` PHP-side.
 */
export interface BridgeMethodHelp {
  signature: string;
  description: string;
  errors: string[];
  examples: string[];
}

export interface AbilityDescriptor {
  name: string;
  label: string;
  description: string;
  category: string;
  input_schema: Record<string, unknown> | null;
  output_schema: Record<string, unknown> | null;
  annotations: { readonly?: boolean; destructive?: boolean; idempotent?: boolean };
}

export interface AiPromptParams {
  messages: PromptMessage[];
  max_tokens?: number;
  tools?: 'auto' | string[];
}

export interface AiToolCallRecord {
  name: string;
  args: Record<string, unknown>;
  result: { ok: true; data: unknown } | { ok: false; error: string; code: string };
  duration_ms: number;
}

export interface AiPromptResult {
  content: string;
  usage: { input_tokens: number; output_tokens: number };
  tool_calls: AiToolCallRecord[];
}

// HTTP proxy bridge surface --------------------------------------------

export type HttpFetchMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD';

export interface HttpFetchInit {
  method?: HttpFetchMethod;
  headers?: Record<string, string>;
  /**
   * Request body, already serialized. The proxy does NOT accept structured
   * objects — apps that want to send JSON must `JSON.stringify(...)` and
   * set `Content-Type` themselves. This matches the cross-host fetch API
   * surface and avoids ambiguous server-side coercion.
   */
  body?: string;
  /**
   * Upstream timeout, clamped server-side to [1000, 30000] ms. Network
   * latency above this raises `http_timeout`.
   */
  timeout_ms?: number;
}

export interface HttpFetchResult {
  ok: true;
  /**
   * Upstream HTTP status code. 30x is surfaced verbatim — the proxy does
   * not follow redirects so apps that need to chase a Location header
   * have to issue the follow-up request themselves.
   */
  status: number;
  /**
   * Response headers with `Set-Cookie` / `Set-Cookie2` stripped. Names are
   * preserved as-sent by the upstream; compare with `toLowerCase()` if you
   * need case-insensitive lookup. When the upstream returned an
   * `application/(*+)?json` content type that failed to parse, a synthetic
   * `X-Dsgo-Json-Parse-Error: 1` is set and `body` stays as the raw string.
   */
  headers: Record<string, string>;
  /**
   * Auto-parsed JSON object for `application/(*+)?json` responses;
   * otherwise the raw response body as a string.
   */
  body: unknown;
}

export function isBridgeError(value: unknown): value is BridgeError {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<BridgeError>;
  return typeof v.code === 'string'
    && typeof v.message === 'string'
    && (BRIDGE_ERROR_CODES as readonly string[]).includes(v.code);
}

/**
 * Canonical bridge error class. Carries the structured `{code, message,
 * details}` shape on a real `Error` so it can be `throw`n, `instanceof`-
 * checked, and round-tripped onto the wire without reverse-engineering
 * object literals. Implements `BridgeError`, so anywhere a `BridgeError`
 * is expected an instance is assignable.
 *
 * Throw this — never a bare `{ code, message }` literal — so `catch`
 * blocks have exactly one shape to handle.
 */
export class BridgeRequestError extends Error implements BridgeError {
  public readonly code: BridgeErrorCode;
  public readonly details?: unknown;
  constructor(error: BridgeError) {
    // `.message` stays the raw bridge message: transport.ts and toBridgeError
    // serialize it straight back onto the wire, so prefixing the code here
    // would leak `code: message` into the public error contract.
    super(error.message);
    this.code = error.code;
    this.details = error.details;
    this.name = 'BridgeRequestError';
  }
}

export function isBridgeRequestError(value: unknown): value is BridgeRequestError {
  return value instanceof BridgeRequestError;
}

/**
 * Coerce any thrown value into a structured `BridgeError`. Handles three
 * cases the codebase actually produces:
 *   - a `BridgeRequestError` (or any object passing `isBridgeError`)
 *   - a plain `Error` (mapped to `internal_error`)
 *   - anything else (stringified into `internal_error`)
 */
export function toBridgeError(value: unknown): BridgeError {
  if (isBridgeError(value)) {
    return { code: value.code, message: value.message, details: value.details };
  }
  if (value instanceof Error) {
    return { code: 'internal_error', message: value.message };
  }
  return { code: 'internal_error', message: String(value) };
}

export function newRequestId(): string {
  return 'req_' + Math.random().toString(36).slice(2, 11);
}

// ---------------------------------------------------------------------------
// Iframe auto-resize clamp — the host shrinks/grows a block-embed iframe to
// the height the app reports. Bounds keep a misbehaving app from collapsing
// to nothing or growing without limit. Shared by the client (sender) and
// parent-bridge (receiver) so both ends agree on the range.
// ---------------------------------------------------------------------------
export const RESIZE_MIN_HEIGHT_PX = 100;
export const RESIZE_MAX_HEIGHT_PX = 2000;

export function clampResizeHeight(raw: number): number {
  return Math.max(RESIZE_MIN_HEIGHT_PX, Math.min(RESIZE_MAX_HEIGHT_PX, Math.round(raw)));
}

// ---------------------------------------------------------------------------
// Path validation — trust-boundary check shared by the client-side router
// (router.ts) and the parent-side enforcement (parent-bridge.ts). Both ends
// MUST agree: the parent re-runs this even if the iframe already validated,
// because the iframe is untrusted.
// ---------------------------------------------------------------------------

/**
 * Reserved paths a root-mounted app may not navigate into. Mirrors the
 * server-side guard in InlineRenderer's mount handling.
 */
export const ROOT_RESERVED_PREFIXES = [
  '/wp-admin/',
  '/wp-login.php',
  '/wp-json/',
  '/feed',
  '/sitemap',
] as const;

export type PathValidationResult =
  | { ok: true; resolvedURL: string }
  | { ok: false; reason: string };

/**
 * Validate a navigation path against an app's mount prefix and resolve it to
 * a parent-window URL. Structured `reason`s are preserved so callers can
 * surface a precise `invalid_params` message.
 *
 * `mountPrefix`:
 *   - `null`  — block-embed / admin: no parent URL surface.
 *   - `''`    — root-mounted: any path except WordPress-reserved prefixes.
 *   - `/x`    — prefixed mount: resolved URL is `${mountPrefix}${rawPath}`.
 */
export function validatePath(
  rawPath: unknown,
  mountPrefix: string | null,
): PathValidationResult {
  if (typeof rawPath !== 'string' || rawPath === '') {
    return { ok: false, reason: 'path must be a non-empty string' };
  }
  if (!rawPath.startsWith('/')) {
    return { ok: false, reason: 'path must start with "/"' };
  }
  if (rawPath.includes('..') || rawPath.includes('//')) {
    return { ok: false, reason: 'path must not contain ".." or "//"' };
  }
  // Reject control characters (0x00-0x1F, 0x7F).
  if (/[\x00-\x1F\x7F]/.test(rawPath)) {
    return { ok: false, reason: 'path must not contain control characters' };
  }

  if (mountPrefix === null) {
    // Block-embed / admin contexts have no parent URL surface; the path is
    // valid in the abstract sense but won't change the address bar.
    return { ok: true, resolvedURL: rawPath };
  }

  if (mountPrefix === '') {
    // Root-mounted: any path allowed except WP-reserved prefixes.
    for (const reserved of ROOT_RESERVED_PREFIXES) {
      if (rawPath === reserved.replace(/\/$/, '') || rawPath.startsWith(reserved)) {
        return { ok: false, reason: `path "${rawPath}" is in a WordPress-reserved prefix` };
      }
    }
    return { ok: true, resolvedURL: rawPath };
  }

  // Prefixed mount: the resolved URL is `${mountPrefix}${rawPath}`, except
  // when path === '/', where we want `${mountPrefix}/` rather than
  // `${mountPrefix}//`.
  const resolvedURL = rawPath === '/' ? mountPrefix + '/' : mountPrefix + rawPath;
  return { ok: true, resolvedURL };
}

// Apps-as-abilities (publish side) types ------------------------------

export type AbilityHandler<I = unknown, O = unknown> = (input: I) => Promise<O> | O;

export interface AbilitiesReady {
  type: 'dsgo:abilities:ready';
  app_id: string;
  implementations: string[];
}

export interface PublishedAbilityDescriptor {
  name: string;
  label: string;
  description: string;
  category: string;
  input_schema?: Record<string, unknown>;
  output_schema?: Record<string, unknown>;
  annotations: { readonly?: boolean; destructive?: boolean; idempotent?: boolean };
  timeout_seconds: number;
}

export interface PublisherAppConfig {
  id: string;
  bundle_url: string;
  permissions: { read: string[]; write: string[] };
  abilities: PublishedAbilityDescriptor[];
}

export interface PublisherConfig {
  apps: PublisherAppConfig[];
  rest_root: string;
  rest_nonce: string;
}
