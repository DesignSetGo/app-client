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
