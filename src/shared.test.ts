import { describe, expect, it } from 'vitest';
import { isBridgeError, BRIDGE_ERROR_CODES, REQUEST_TIMEOUT_MS, METHOD_TIMEOUTS_MS } from './shared';
import type { BridgeContext } from './shared';

describe('shared', () => {
  it('exposes the v1 error codes', () => {
    expect(BRIDGE_ERROR_CODES).toContain('permission_denied');
    expect(BRIDGE_ERROR_CODES).toContain('not_authenticated');
    expect(BRIDGE_ERROR_CODES).toContain('payload_too_large');
  });

  it('isBridgeError narrows correctly', () => {
    expect(isBridgeError({ code: 'permission_denied', message: 'no' })).toBe(true);
    expect(isBridgeError({ code: 'not_a_real_code', message: 'no' })).toBe(false);
    expect(isBridgeError(null)).toBe(false);
    expect(isBridgeError({ message: 'missing code' })).toBe(false);
  });

  it('exposes a sane request timeout', () => {
    expect(REQUEST_TIMEOUT_MS).toBe(30_000);
  });
});

describe('BridgeContext.routeParams', () => {
  it('accepts an empty routeParams object', () => {
    const ctx: BridgeContext = {
      bridgeVersion: 1, appId: 'x', mode: 'page', locale: 'en-US', theme: 'light',
      blockProps: null, routeParams: {},
    };
    expect(ctx.routeParams).toEqual({});
  });

  it('accepts populated routeParams', () => {
    const ctx: BridgeContext = {
      bridgeVersion: 1, appId: 'x', mode: 'page', locale: 'en-US', theme: 'light',
      blockProps: null, routeParams: { id: '123', slug: 'foo' },
    };
    expect(ctx.routeParams.id).toBe('123');
  });
});

describe('BRIDGE_ERROR_CODES', () => {
  it('includes ai_not_configured', () => {
    expect((BRIDGE_ERROR_CODES as readonly string[])).toContain('ai_not_configured');
  });
  it('includes not_implemented', () => {
    expect((BRIDGE_ERROR_CODES as readonly string[])).toContain('not_implemented');
  });
});

describe('METHOD_TIMEOUTS_MS', () => {
  it('extends ai.prompt timeout based on context', () => {
    const ctx: BridgeContext = {
      bridgeVersion: 1, appId: 'x', mode: 'page', locale: 'en-US', theme: 'light',
      blockProps: null, routeParams: {}, aiTimeoutSeconds: 90,
    };
    expect(METHOD_TIMEOUTS_MS['ai.prompt']!(ctx)).toBe(95_000);
  });
  it('caps ai.prompt timeout at 125s even if context lies', () => {
    const ctx: BridgeContext = {
      bridgeVersion: 1, appId: 'x', mode: 'page', locale: 'en-US', theme: 'light',
      blockProps: null, routeParams: {}, aiTimeoutSeconds: 9999,
    };
    expect(METHOD_TIMEOUTS_MS['ai.prompt']!(ctx)).toBe(125_000);
  });
  it('defaults to 65s for ai.prompt when context omits aiTimeoutSeconds', () => {
    const ctx: BridgeContext = {
      bridgeVersion: 1, appId: 'x', mode: 'page', locale: 'en-US', theme: 'light',
      blockProps: null, routeParams: {},
    };
    expect(METHOD_TIMEOUTS_MS['ai.prompt']!(ctx)).toBe(65_000);
  });
});

describe('publish-side error codes', () => {
  it('includes ability_handler_error', () => {
    expect((BRIDGE_ERROR_CODES as readonly string[])).toContain('ability_handler_error');
  });
  it('includes app_load_failed', () => {
    expect((BRIDGE_ERROR_CODES as readonly string[])).toContain('app_load_failed');
  });
  it('includes ability_not_implemented', () => {
    expect((BRIDGE_ERROR_CODES as readonly string[])).toContain('ability_not_implemented');
  });
  it('includes ability_timeout', () => {
    expect((BRIDGE_ERROR_CODES as readonly string[])).toContain('ability_timeout');
  });
});
