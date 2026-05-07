import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BridgeContext } from './shared';

declare global {
  interface Window {
    __dsgoBridgeContext: BridgeContext;
    __dsgoNonce: string;
    __dsgoManifest: { id: string; name: string; permissions: { read: string[]; write: string[] } };
    __dsgoPermissionMap: Record<string, string | null>;
    wp: { apiFetch: (opts: unknown) => Promise<unknown> };
  }
}

describe('parent-bridge', () => {
  let iframe: HTMLIFrameElement;
  let iframeWindow: Window;
  let postSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    document.body.innerHTML = '<iframe id="dsgo"></iframe>';
    iframe = document.getElementById('dsgo') as HTMLIFrameElement;
    iframeWindow = iframe.contentWindow!;
    postSpy = vi.fn();
    Object.defineProperty(iframeWindow, 'postMessage', { value: postSpy, configurable: true });

    window.__dsgoBridgeContext = { bridgeVersion: 1, appId: 'sample', mode: 'page', locale: 'en-US', theme: 'light', blockProps: null };
    window.__dsgoNonce = 'nonce-xyz';
    window.__dsgoManifest = { id: 'sample', name: 'Sample', permissions: { read: ['posts'], write: [] } };
    window.__dsgoPermissionMap = { 'posts.list': 'posts', 'user.current': 'user', 'bridge.ping': null };
    window.wp = { apiFetch: vi.fn().mockResolvedValue([]) };

    vi.resetModules();
  });

  it('responds to dsgo:hello with context', async () => {
    await import('./parent-bridge');
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'dsgo:hello' }, source: iframeWindow }));
    const ctxCall = postSpy.mock.calls.find(c => c[0]?.type === 'dsgo:context');
    expect(ctxCall).toBeTruthy();
    expect(ctxCall![0].payload.appId).toBe('sample');
  });

  it('rejects request without granted permission', async () => {
    await import('./parent-bridge');
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'dsgo:request', id: 'r1', method: 'user.current' }, source: iframeWindow }));
    const reply = postSpy.mock.calls.find(c => c[0]?.id === 'r1');
    expect(reply![0]).toMatchObject({ type: 'dsgo:response', ok: false, error: expect.objectContaining({ code: 'permission_denied' }) });
  });

  it('dispatches granted method via apiFetch', async () => {
    await import('./parent-bridge');
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'dsgo:request', id: 'r2', method: 'posts.list', params: { per_page: 5 } }, source: iframeWindow }));
    await new Promise(r => setTimeout(r, 0));
    expect(window.wp.apiFetch).toHaveBeenCalled();
  });

  it('handles bridge.ping locally', async () => {
    await import('./parent-bridge');
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'dsgo:request', id: 'r3', method: 'bridge.ping' }, source: iframeWindow }));
    const reply = postSpy.mock.calls.find(c => c[0]?.id === 'r3');
    expect(reply![0]).toMatchObject({ type: 'dsgo:response', ok: true, data: expect.objectContaining({ ok: true, bridge_version: 1 }) });
  });
});

describe('parent-bridge resize forwarding', () => {
  let iframe: HTMLIFrameElement;
  let iframeWindow: Window;
  let parentPostSpy: ReturnType<typeof vi.fn>;

  function setupContext(ctx: Partial<BridgeContext> = {}) {
    window.__dsgoBridgeContext = {
      bridgeVersion: 1,
      appId: 'sample',
      mode: 'block',
      locale: 'en-US',
      theme: 'light',
      blockProps: { autoResize: true },
      ...ctx,
    } as BridgeContext;
    window.__dsgoNonce = 'nonce-xyz';
    window.__dsgoManifest = { id: 'sample', name: 'Sample', permissions: { read: ['posts'], write: [] } };
    window.__dsgoPermissionMap = { 'posts.list': 'posts', 'user.current': 'user', 'bridge.ping': null };
    window.wp = { apiFetch: vi.fn().mockResolvedValue([]) };
  }

  beforeEach(() => {
    document.body.innerHTML = '<iframe id="dsgo"></iframe>';
    iframe = document.getElementById('dsgo') as HTMLIFrameElement;
    iframeWindow = iframe.contentWindow!;
    Object.defineProperty(iframeWindow, 'postMessage', { value: vi.fn(), configurable: true });
    parentPostSpy = vi.fn();
    Object.defineProperty(window, 'parent', {
      value: { postMessage: parentPostSpy },
      configurable: true,
      writable: true,
    });
    vi.resetModules();
  });

  afterEach(() => {
    const realWindow = window;
    Object.defineProperty(window, 'parent', { value: realWindow, configurable: true, writable: true });
  });

  it('resizes iframe and forwards dsgo:embed:resize to Layer 0 when mode=block and autoResize=true', async () => {
    setupContext({ mode: 'block', blockProps: { autoResize: true } });
    await import('./parent-bridge');
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'dsgo:resize', height: 720 },
      source: iframeWindow,
    }));
    expect(iframe.style.height).toBe('720px');
    const fwdCall = parentPostSpy.mock.calls.find(c => c[0]?.type === 'dsgo:embed:resize');
    expect(fwdCall).toBeTruthy();
    expect(fwdCall![0]).toEqual({ type: 'dsgo:embed:resize', height: 720, appId: 'sample' });
  });

  it('ignores dsgo:resize when mode=page (no resize, no parent post)', async () => {
    setupContext({ mode: 'page', blockProps: null });
    await import('./parent-bridge');
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'dsgo:resize', height: 720 },
      source: iframeWindow,
    }));
    expect(iframe.style.height).toBe('');
    const fwdCall = parentPostSpy.mock.calls.find(c => c[0]?.type === 'dsgo:embed:resize');
    expect(fwdCall).toBeUndefined();
  });

  it('ignores dsgo:resize when mode=block but autoResize=false', async () => {
    setupContext({ mode: 'block', blockProps: { autoResize: false } });
    await import('./parent-bridge');
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'dsgo:resize', height: 720 },
      source: iframeWindow,
    }));
    expect(iframe.style.height).toBe('');
    const fwdCall = parentPostSpy.mock.calls.find(c => c[0]?.type === 'dsgo:embed:resize');
    expect(fwdCall).toBeUndefined();
  });
});
