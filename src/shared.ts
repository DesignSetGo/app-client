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

export function isBridgeError(value: unknown): value is BridgeError {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<BridgeError>;
  return typeof v.code === 'string'
    && typeof v.message === 'string'
    && (BRIDGE_ERROR_CODES as readonly string[]).includes(v.code);
}

export function newRequestId(): string {
  return 'req_' + Math.random().toString(36).slice(2, 11);
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
