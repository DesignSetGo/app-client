import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BridgeContext } from './shared';

const sampleContext: BridgeContext = {
  bridgeVersion: 1,
  appId: 'sample',
  mode: 'page',
  locale: 'en-US',
  theme: 'light',
  blockProps: null,
  routeParams: {},
};

function dispatchFromParent(data: unknown) {
  window.dispatchEvent(new MessageEvent('message', {
    data,
    source: window.parent as MessageEventSource,
  }));
}

function findRequest(postSpy: ReturnType<typeof vi.fn>, method?: string) {
  const call = postSpy.mock.calls.find(c => {
    const m = c[0];
    if (!m || m.type !== 'dsgo:request') return false;
    return method === undefined ? true : m.method === method;
  });
  if (!call) throw new Error(`no dsgo:request${method ? ' for ' + method : ''} posted`);
  return call[0] as { type: 'dsgo:request'; id: string; method: string; params?: unknown };
}

describe('bridge client', () => {
  let postMessageSpy: ReturnType<typeof vi.fn>;
  let realParent: Window;

  beforeEach(() => {
    postMessageSpy = vi.fn();
    realParent = window.parent;
    Object.defineProperty(window, 'parent', {
      value: { postMessage: postMessageSpy },
      configurable: true,
      writable: true,
    });
    vi.resetModules();
  });

  afterEach(() => {
    vi.useRealTimers();
    Object.defineProperty(window, 'parent', { value: realParent, configurable: true, writable: true });
  });

  it('posts dsgo:hello on module load', async () => {
    await import('./client');
    expect(postMessageSpy.mock.calls[0][0]).toEqual({ type: 'dsgo:hello' });
  });

  it('exposes context as null until dsgo:context arrives, then populates it', async () => {
    const { dsgo } = await import('./client');
    expect(dsgo.context).toBeNull();
    dispatchFromParent({ type: 'dsgo:context', payload: sampleContext });
    await dsgo.ready;
    expect(dsgo.context).toEqual(sampleContext);
    expect(dsgo.context!.appId).toBe('sample');
  });

  it('buffers calls until context arrives, then dispatches them', async () => {
    const { dsgo } = await import('./client');
    const callPromise = dsgo.posts.list({ per_page: 5 });

    expect(postMessageSpy.mock.calls.filter(c => c[0]?.type === 'dsgo:request').length).toBe(0);

    dispatchFromParent({ type: 'dsgo:context', payload: sampleContext });
    await dsgo.ready;
    await Promise.resolve();

    const sent = findRequest(postMessageSpy, 'posts.list');
    dispatchFromParent({ type: 'dsgo:response', id: sent.id, ok: true, data: { items: [], total: 0, total_pages: 0 } });
    await expect(callPromise).resolves.toEqual({ items: [], total: 0, total_pages: 0 });
  });

  it('rejects on error response with typed BridgeError', async () => {
    const { dsgo, BridgeRequestError } = await import('./client');
    dispatchFromParent({ type: 'dsgo:context', payload: sampleContext });
    await dsgo.ready;

    const promise = dsgo.user.current();
    await Promise.resolve();
    const sent = findRequest(postMessageSpy, 'user.current');
    dispatchFromParent({ type: 'dsgo:response', id: sent.id, ok: false, error: { code: 'permission_denied', message: 'no' } });

    await expect(promise).rejects.toBeInstanceOf(BridgeRequestError);
    await expect(promise).rejects.toHaveProperty('code', 'permission_denied');
  });

  it('times out 30s after context arrives', async () => {
    vi.useFakeTimers();
    const { dsgo, BridgeRequestError } = await import('./client');
    dispatchFromParent({ type: 'dsgo:context', payload: sampleContext });
    await dsgo.ready;

    const promise = dsgo.bridge.ping();
    await Promise.resolve();
    vi.advanceTimersByTime(30_001);
    await expect(promise).rejects.toBeInstanceOf(BridgeRequestError);
    await expect(promise).rejects.toHaveProperty('code', 'internal_error');
  });
});

describe('bridge client side-effect gating', () => {
  it('does nothing when imported in a non-iframe context (window.parent === window)', async () => {
    const realParent = window.parent;
    Object.defineProperty(window, 'parent', { value: window, configurable: true, writable: true });
    const postSpy = vi.fn();
    window.postMessage = postSpy as unknown as typeof window.postMessage;
    vi.resetModules();
    await import('./client');
    expect(postSpy).not.toHaveBeenCalled();
    Object.defineProperty(window, 'parent', { value: realParent, configurable: true, writable: true });
  });
});

describe('dsgo.bridge.requestResize', () => {
  let postMessageSpy: ReturnType<typeof vi.fn>;
  let realParent: Window;

  beforeEach(() => {
    postMessageSpy = vi.fn();
    realParent = window.parent;
    Object.defineProperty(window, 'parent', {
      value: { postMessage: postMessageSpy },
      configurable: true,
      writable: true,
    });
    vi.resetModules();
  });

  afterEach(() => {
    Object.defineProperty(window, 'parent', { value: realParent, configurable: true, writable: true });
  });

  it('posts dsgo:resize with clamped height to window.parent', async () => {
    const { dsgo } = await import('./client');
    dsgo.bridge.requestResize(720);
    const resizeCall = postMessageSpy.mock.calls.find(c => c[0]?.type === 'dsgo:resize');
    expect(resizeCall).toBeTruthy();
    expect(resizeCall![0]).toEqual({ type: 'dsgo:resize', height: 720 });
  });

  it('skips postMessage when height is NaN', async () => {
    const { dsgo } = await import('./client');
    dsgo.bridge.requestResize(NaN);
    const resizeCall = postMessageSpy.mock.calls.find(c => c[0]?.type === 'dsgo:resize');
    expect(resizeCall).toBeUndefined();
  });

  it('clamps height below 100 up to 100', async () => {
    const { dsgo } = await import('./client');
    dsgo.bridge.requestResize(-50);
    const resizeCall = postMessageSpy.mock.calls.find(c => c[0]?.type === 'dsgo:resize');
    expect(resizeCall).toBeTruthy();
    expect(resizeCall![0]).toEqual({ type: 'dsgo:resize', height: 100 });
  });

  it('clamps height above 2000 down to 2000', async () => {
    const { dsgo } = await import('./client');
    dsgo.bridge.requestResize(99999);
    const resizeCall = postMessageSpy.mock.calls.find(c => c[0]?.type === 'dsgo:resize');
    expect(resizeCall).toBeTruthy();
    expect(resizeCall![0]).toEqual({ type: 'dsgo:resize', height: 2000 });
  });
});
