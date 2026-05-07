import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BridgeContext } from './shared';

declare global {
  interface Window {
    wp: { apiFetch: (opts: unknown) => Promise<unknown> };
  }
}

interface EmbedConfig {
  context: BridgeContext;
  manifest: { id: string; name?: string; permissions: { read: string[]; write: string[] } };
  permMap: Record<string, string | null>;
  nonce: string;
}

function mountEmbed(id: string, cfg: EmbedConfig): { iframe: HTMLIFrameElement; iframeWindow: Window; postSpy: ReturnType<typeof vi.fn> } {
  const wrapper = document.createElement('div');
  const iframe = document.createElement('iframe');
  iframe.dataset.dsgoEmbedId = id;
  iframe.dataset.dsgoAppId = cfg.manifest.id;
  const cfgEl = document.createElement('script');
  cfgEl.type = 'application/json';
  cfgEl.dataset.dsgoEmbedConfig = id;
  cfgEl.textContent = JSON.stringify(cfg);
  wrapper.appendChild(iframe);
  wrapper.appendChild(cfgEl);
  document.body.appendChild(wrapper);
  const iframeWindow = iframe.contentWindow!;
  const postSpy = vi.fn();
  Object.defineProperty(iframeWindow, 'postMessage', { value: postSpy, configurable: true });
  return { iframe, iframeWindow, postSpy };
}

function defaultConfig(overrides: Partial<EmbedConfig> = {}): EmbedConfig {
  return {
    context: { bridgeVersion: 1, appId: 'sample', mode: 'page', locale: 'en-US', theme: 'light', blockProps: null },
    manifest: { id: 'sample', name: 'Sample', permissions: { read: ['posts'], write: [] } },
    permMap: { 'posts.list': 'posts', 'user.current': 'user', 'bridge.ping': null },
    nonce: 'nonce-xyz',
    ...overrides,
  };
}

describe('parent-bridge', () => {
  beforeEach(() => {
    document.body.replaceChildren();
    window.wp = { apiFetch: vi.fn().mockResolvedValue([]) };
    vi.resetModules();
  });

  it('responds to dsgo:hello with the embed-specific context', async () => {
    const { iframeWindow, postSpy } = mountEmbed('1', defaultConfig());
    await import('./parent-bridge');
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'dsgo:hello' }, source: iframeWindow }));
    const ctxCall = postSpy.mock.calls.find(c => c[0]?.type === 'dsgo:context');
    expect(ctxCall).toBeTruthy();
    expect(ctxCall![0].payload.appId).toBe('sample');
  });

  it('routes by event.source so two embeds get their own context', async () => {
    const a = mountEmbed('1', defaultConfig({
      context: { bridgeVersion: 1, appId: 'app-a', mode: 'block', locale: 'en-US', theme: 'light', blockProps: null },
      manifest: { id: 'app-a', name: 'A', permissions: { read: ['posts'], write: [] } },
    }));
    const b = mountEmbed('2', defaultConfig({
      context: { bridgeVersion: 1, appId: 'app-b', mode: 'block', locale: 'en-US', theme: 'light', blockProps: null },
      manifest: { id: 'app-b', name: 'B', permissions: { read: ['pages'], write: [] } },
    }));
    await import('./parent-bridge');

    window.dispatchEvent(new MessageEvent('message', { data: { type: 'dsgo:hello' }, source: a.iframeWindow }));
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'dsgo:hello' }, source: b.iframeWindow }));

    const aCtx = a.postSpy.mock.calls.find(c => c[0]?.type === 'dsgo:context');
    const bCtx = b.postSpy.mock.calls.find(c => c[0]?.type === 'dsgo:context');
    expect(aCtx![0].payload.appId).toBe('app-a');
    expect(bCtx![0].payload.appId).toBe('app-b');
  });

  it('rejects request without granted permission', async () => {
    const { iframeWindow, postSpy } = mountEmbed('1', defaultConfig());
    await import('./parent-bridge');
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'dsgo:request', id: 'r1', method: 'user.current' }, source: iframeWindow }));
    const reply = postSpy.mock.calls.find(c => c[0]?.id === 'r1');
    expect(reply![0]).toMatchObject({ type: 'dsgo:response', ok: false, error: expect.objectContaining({ code: 'permission_denied' }) });
  });

  it('dispatches granted method via apiFetch', async () => {
    const { iframeWindow } = mountEmbed('1', defaultConfig());
    await import('./parent-bridge');
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'dsgo:request', id: 'r2', method: 'posts.list', params: { per_page: 5 } }, source: iframeWindow }));
    await new Promise(r => setTimeout(r, 0));
    expect(window.wp.apiFetch).toHaveBeenCalled();
  });

  it('handles bridge.ping locally', async () => {
    const { iframeWindow, postSpy } = mountEmbed('1', defaultConfig());
    await import('./parent-bridge');
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'dsgo:request', id: 'r3', method: 'bridge.ping' }, source: iframeWindow }));
    const reply = postSpy.mock.calls.find(c => c[0]?.id === 'r3');
    expect(reply![0]).toMatchObject({ type: 'dsgo:response', ok: true, data: expect.objectContaining({ ok: true, bridge_version: 1 }) });
  });

  it('ignores messages from windows not registered as DSGo embeds', async () => {
    const { postSpy } = mountEmbed('1', defaultConfig());
    await import('./parent-bridge');
    const stranger = { postMessage: vi.fn() } as unknown as Window;
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'dsgo:hello' }, source: stranger }));
    expect(postSpy).not.toHaveBeenCalled();
  });
});

describe('parent-bridge resize forwarding', () => {
  beforeEach(() => {
    document.body.replaceChildren();
    window.wp = { apiFetch: vi.fn().mockResolvedValue([]) };
    vi.resetModules();
  });

  afterEach(() => {
    document.body.replaceChildren();
  });

  it('resizes the iframe when mode=block and autoResize=true', async () => {
    const { iframe, iframeWindow } = mountEmbed('1', defaultConfig({
      context: { bridgeVersion: 1, appId: 'sample', mode: 'block', locale: 'en-US', theme: 'light', blockProps: { autoResize: true } },
    }));
    await import('./parent-bridge');
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'dsgo:resize', height: 720 },
      source: iframeWindow,
    }));
    expect(iframe.style.height).toBe('720px');
  });

  it('ignores dsgo:resize when mode=page', async () => {
    const { iframe, iframeWindow } = mountEmbed('1', defaultConfig({
      context: { bridgeVersion: 1, appId: 'sample', mode: 'page', locale: 'en-US', theme: 'light', blockProps: null },
    }));
    await import('./parent-bridge');
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'dsgo:resize', height: 720 },
      source: iframeWindow,
    }));
    expect(iframe.style.height).toBe('');
  });

  it('ignores dsgo:resize when autoResize=false', async () => {
    const { iframe, iframeWindow } = mountEmbed('1', defaultConfig({
      context: { bridgeVersion: 1, appId: 'sample', mode: 'block', locale: 'en-US', theme: 'light', blockProps: { autoResize: false } },
    }));
    await import('./parent-bridge');
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'dsgo:resize', height: 720 },
      source: iframeWindow,
    }));
    expect(iframe.style.height).toBe('');
  });
});
