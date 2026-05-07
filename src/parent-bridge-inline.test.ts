import { describe, it, expect, vi, beforeEach } from 'vitest';
import { startInlineParentBridge } from './parent-bridge-inline';

describe('startInlineParentBridge', () => {
  beforeEach(() => {
    const scriptEl = document.createElement('script');
    scriptEl.type = 'application/json';
    scriptEl.id = 'dsgo-context';
    scriptEl.textContent = JSON.stringify({ bridgeVersion: 1, mode: 'inline', appId: 'sample' });
    document.body.appendChild(scriptEl);
  });

  it('round-trips a request and response via window postMessage', async () => {
    const apiFetch = vi.fn(async () => ({ title: 'Site' }));
    startInlineParentBridge({
      manifest: { id: 'sample', permissions: { read: ['site_info'] } },
      permMap: { 'site.info': 'site_info' },
      nonce: 'NONCE',
      apiFetch,
    });

    const id = 'req-1';
    const reply = new Promise<MessageEvent>((resolve) => {
      const handler = (e: MessageEvent) => {
        if (e.data?.type === 'dsgo:response' && e.data.id === id) {
          window.removeEventListener('message', handler);
          resolve(e);
        }
      };
      window.addEventListener('message', handler);
    });

    window.postMessage({ type: 'dsgo:request', id, method: 'site.info' }, '*');
    const ev = await reply;
    expect(ev.data.ok).toBe(true);
  });
});
