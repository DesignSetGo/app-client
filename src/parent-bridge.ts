import {
  type BridgeContext,
  type BridgeMessage,
  type BridgeRequest,
} from './shared';
import { handleRequest, guardRequest } from './transport';

declare global {
  interface Window {
    wp?: { apiFetch?: (opts: { path: string; method?: string; data?: unknown; headers?: Record<string, string>; parse?: boolean }) => Promise<unknown> };
  }
}

const ctx: BridgeContext = (window as any).__dsgoBridgeContext;
const manifest = (window as any).__dsgoManifest as { id: string; permissions: { read: string[] } };
const permMap = (window as any).__dsgoPermissionMap as Record<string, string | null>;
const nonce = (window as any).__dsgoNonce as string;

const iframe = document.querySelector('iframe') as HTMLIFrameElement | null;
const iframeWindow = iframe?.contentWindow ?? null;

async function dispatch(req: BridgeRequest): Promise<void> {
  // Synchronous guard: handles unknown_method, permission_denied, bridge.ping
  // without deferring to a microtask — keeps fast-path replies synchronous.
  const early = guardRequest(req, { manifest, permMap });
  if (early !== null) {
    iframeWindow?.postMessage(early, '*');
    return;
  }

  if (!window.wp?.apiFetch) {
    iframeWindow?.postMessage(
      { type: 'dsgo:response', id: req.id, ok: false, error: { code: 'internal_error', message: 'wp.apiFetch unavailable' } },
      '*',
    );
    return;
  }

  const response = await handleRequest(req, { manifest, permMap, nonce, apiFetch: window.wp!.apiFetch! });
  iframeWindow?.postMessage(response, '*');
}

window.addEventListener('message', (event: MessageEvent<unknown>) => {
  if (event.source !== iframeWindow) return;
  const msg = event.data as BridgeMessage | null;
  if (!msg || typeof msg !== 'object') return;
  if ((msg as BridgeMessage).type === 'dsgo:hello') {
    iframeWindow?.postMessage({ type: 'dsgo:context', payload: ctx }, '*');
    return;
  }
  if ((msg as { type: string }).type === 'dsgo:resize') {
    if (ctx.mode !== 'block' || !ctx.blockProps?.autoResize) return;
    const raw = Number((msg as { type: string; height: unknown }).height);
    if (!Number.isFinite(raw)) return;
    const h = Math.max(100, Math.min(2000, Math.round(raw)));
    if (iframe) iframe.style.height = h + 'px';
    if (window.parent && window.parent !== window) {
      window.parent.postMessage(
        { type: 'dsgo:embed:resize', height: h, appId: ctx.appId },
        '*',
      );
    }
    return;
  }
  if ((msg as BridgeMessage).type === 'dsgo:request') {
    void dispatch(msg as BridgeRequest);
  }
});
