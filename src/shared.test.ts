import { describe, expect, it } from 'vitest';
import { isBridgeError, BRIDGE_ERROR_CODES, REQUEST_TIMEOUT_MS } from './shared';
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
