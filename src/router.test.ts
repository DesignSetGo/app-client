import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BridgeContext } from './shared';
import {
  validatePath,
  navigate,
  subscribe,
  applyExternalLocation,
  setLocationFromContext,
  getLocation,
  _resetForTests,
} from './router';

function makeCtx(over: Partial<BridgeContext> = {}): BridgeContext {
  return {
    bridgeVersion: 1,
    appId: 'sample',
    mode: 'page',
    locale: 'en-US',
    theme: 'light',
    blockProps: null,
    routeParams: {},
    path: '/',
    search: '',
    hash: '',
    mountPrefix: '/apps/sample',
    ...over,
  };
}

describe('validatePath', () => {
  it('rejects non-string', () => {
    expect(validatePath('' as unknown as string, '/apps/x')).toEqual({ ok: false, reason: expect.any(String) });
  });
  it('rejects path missing leading slash', () => {
    expect(validatePath('foo', '/apps/x').ok).toBe(false);
  });
  it('rejects ".." traversal', () => {
    expect(validatePath('/foo/../bar', '/apps/x').ok).toBe(false);
  });
  it('rejects double slashes', () => {
    expect(validatePath('/foo//bar', '/apps/x').ok).toBe(false);
  });
  it('accepts valid prefixed paths', () => {
    expect(validatePath('/about', '/apps/sample')).toEqual({ ok: true, resolvedURL: '/apps/sample/about' });
  });
  it('handles root path with prefixed mount', () => {
    expect(validatePath('/', '/apps/sample')).toEqual({ ok: true, resolvedURL: '/apps/sample/' });
  });
  it('accepts any path for root mount, except WP-reserved', () => {
    expect(validatePath('/about', '').ok).toBe(true);
    expect(validatePath('/wp-admin/users.php', '').ok).toBe(false);
    expect(validatePath('/wp-json/foo', '').ok).toBe(false);
    expect(validatePath('/feed', '').ok).toBe(false);
    expect(validatePath('/sitemap.xml', '').ok).toBe(false);
  });
  it('passes path through for null mountPrefix (block embed)', () => {
    // Not blocked by validation — block-embed mode handles internally.
    expect(validatePath('/foo', null)).toEqual({ ok: true, resolvedURL: '/foo' });
  });
});

describe('router.navigate (inline full-page)', () => {
  // Inline mode is signaled by the PHP-rendered `mode: 'inline'` on the
  // context (see InlineRenderer); the typed mode field carries this same-
  // window-transport marker.
  function inlineCtx(over: Partial<BridgeContext> = {}): BridgeContext {
    return makeCtx({ ...over, mountPrefix: over.mountPrefix ?? '/apps/sample' }) as BridgeContext & { mode: string };
  }

  beforeEach(() => {
    _resetForTests();
    history.replaceState(null, '', '/apps/sample/');
  });

  afterEach(() => { _resetForTests(); });

  it('runs pushState locally when context.mode === "inline"', async () => {
    const ctx = { ...inlineCtx(), mode: 'inline' as unknown as 'page' };
    setLocationFromContext(ctx);
    await navigate('/about', {}, { context: ctx, forwardToParent: vi.fn() });
    expect(window.location.pathname).toBe('/apps/sample/about');
    expect(getLocation().path).toBe('/about');
  });

  it('uses replaceState when opts.replace === true', async () => {
    const ctx = { ...inlineCtx(), mode: 'inline' as unknown as 'page' };
    setLocationFromContext(ctx);
    const initialLength = history.length;
    await navigate('/x', { replace: true }, { context: ctx, forwardToParent: vi.fn() });
    expect(history.length).toBe(initialLength);
  });

  it('rejects invalid paths with invalid_params', async () => {
    const ctx = { ...inlineCtx(), mode: 'inline' as unknown as 'page' };
    await expect(navigate('/foo/../bar', {}, {
      context: ctx,
      forwardToParent: vi.fn(),
    })).rejects.toMatchObject({ code: 'invalid_params' });
  });

  it('appends search and hash to URL', async () => {
    const ctx = { ...inlineCtx(), mode: 'inline' as unknown as 'page' };
    setLocationFromContext(ctx);
    await navigate('/about', { search: 'q=1', hash: 'top' }, {
      context: ctx,
      forwardToParent: vi.fn(),
    });
    expect(window.location.pathname).toBe('/apps/sample/about');
    expect(window.location.search).toBe('?q=1');
    expect(window.location.hash).toBe('#top');
  });
});

describe('router.navigate (block-embed)', () => {
  beforeEach(() => { _resetForTests(); });

  it('updates internal state without touching window.history when mountPrefix is null', async () => {
    const ctx = makeCtx({ mode: 'block', mountPrefix: null });
    setLocationFromContext(ctx);
    const beforePath = window.location.pathname;

    const fwd = vi.fn();
    await navigate('/wizard/step-2', { state: { step: 2 } }, {
      context: ctx,
      forwardToParent: fwd,
    });

    expect(fwd).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe(beforePath); // unchanged
    expect(getLocation().path).toBe('/wizard/step-2');
  });
});

describe('router.subscribe', () => {
  beforeEach(() => { _resetForTests(); });

  it('fires subscribers on programmatic navigate (block-embed mode)', async () => {
    // Block-embed: navigate updates internal state without any forward.
    // Easiest way to test subscribe semantics without touching real history.
    const ctx = makeCtx({ mode: 'block', mountPrefix: null });
    setLocationFromContext(ctx);
    const handler = vi.fn();
    subscribe(handler);
    await navigate('/about', {}, { context: ctx, forwardToParent: vi.fn() });
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ path: '/about' }));
  });

  it('returns unsubscribe function that stops further notifications', async () => {
    const ctx = makeCtx({ mode: 'block', mountPrefix: null });
    setLocationFromContext(ctx);
    const handler = vi.fn();
    const unsub = subscribe(handler);
    await navigate('/a', {}, { context: ctx, forwardToParent: vi.fn() });
    unsub();
    await navigate('/b', {}, { context: ctx, forwardToParent: vi.fn() });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('isolates subscriber errors from each other', async () => {
    const ctx = makeCtx({ mode: 'block', mountPrefix: null });
    const goodHandler = vi.fn();
    subscribe(() => { throw new Error('boom'); });
    subscribe(goodHandler);
    await navigate('/c', {}, { context: ctx, forwardToParent: vi.fn() });
    expect(goodHandler).toHaveBeenCalled();
  });
});

describe('router.applyExternalLocation', () => {
  beforeEach(() => { _resetForTests(); });

  it('updates state and fires subscribers (popstate path)', () => {
    const handler = vi.fn();
    subscribe(handler);
    applyExternalLocation({ path: '/from-history', search: '?x=1', hash: '', state: { hi: true } });
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({
      path: '/from-history',
      search: '?x=1',
      state: { hi: true },
    }));
    expect(getLocation().path).toBe('/from-history');
  });
});

describe('router forwardToParent (iframe full-page)', () => {
  beforeEach(() => { _resetForTests(); });

  it('forwards to parent when mode === "page" and mountPrefix is set', async () => {
    const ctx = makeCtx({ mode: 'page', mountPrefix: '/apps/sample' });
    setLocationFromContext(ctx);
    const fwd = vi.fn().mockResolvedValue(undefined);
    await navigate('/about', {}, { context: ctx, forwardToParent: fwd });
    expect(fwd).toHaveBeenCalledWith(expect.objectContaining({ path: '/about', replace: false }));
    expect(getLocation().path).toBe('/about');
  });

  it('does not call window.history.pushState when mode === "page" (iframe must defer)', async () => {
    const ctx = makeCtx({ mode: 'page', mountPrefix: '/apps/sample' });
    setLocationFromContext(ctx);
    const pushSpy = vi.spyOn(window.history, 'pushState');
    await navigate('/about', {}, { context: ctx, forwardToParent: vi.fn().mockResolvedValue(undefined) });
    expect(pushSpy).not.toHaveBeenCalled();
    pushSpy.mockRestore();
  });
});
