/**
 * parent-bridge — host-page transport for sandboxed app iframes.
 *
 * One copy of this script handles every DSGo iframe on the page. Each iframe
 * declares itself with `data-dsgo-embed-id="<n>"` and ships a sibling JSON
 * config island `<script type="application/json" data-dsgo-embed-config="<n>">`
 * that holds its bridge context, manifest, permission map, and REST nonce.
 *
 * On message, we route by `event.source` so multiple block embeds on the
 * same page each see their own context — no globals, no `querySelector('iframe')`.
 */

import {
  type BridgeContext,
  type BridgeMessage,
  type BridgeRequest,
} from './shared';
import { handleRequest, guardRequest, type ApiFetch } from './transport';

declare global {
  interface Window {
    wp?: { apiFetch?: ApiFetch };
  }
}

interface EmbedConfig {
  context: BridgeContext;
  manifest: { id: string; name?: string; permissions: { read: string[] } };
  permMap: Record<string, string | null>;
  nonce: string;
  /** Per-(user, app) nonce for storage calls — see RestApi::permit_storage. */
  appNonce?: string;
}

interface EmbedEntry extends EmbedConfig {
  iframe: HTMLIFrameElement;
}

const embeds = new Map<Window, EmbedEntry>();

function readConfig(id: string): EmbedConfig | null {
  // Embed IDs are server-generated and constrained to `[A-Za-z0-9_-]+`
  // (a per-page counter), so we don't need CSS.escape here. Defensive
  // check rejects anything else rather than building a malformed selector.
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return null;
  const el = document.querySelector<HTMLScriptElement>(
    `script[data-dsgo-embed-config="${id}"]`,
  );
  if (!el?.textContent) return null;
  try {
    const parsed = JSON.parse(el.textContent) as EmbedConfig;
    if (!parsed?.context || !parsed?.manifest || !parsed?.permMap || typeof parsed.nonce !== 'string') {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function discover(): void {
  const iframes = document.querySelectorAll<HTMLIFrameElement>('iframe[data-dsgo-embed-id]');
  iframes.forEach((iframe) => {
    const id = iframe.dataset.dsgoEmbedId;
    if (!id) return;
    const cfg = readConfig(id);
    if (!cfg) return;
    const w = iframe.contentWindow;
    if (!w) return;
    if (embeds.has(w)) return;
    embeds.set(w, { iframe, ...cfg });
  });
}

async function dispatch(entry: EmbedEntry, req: BridgeRequest): Promise<void> {
  const target = entry.iframe.contentWindow;
  if (!target) return;
  // Synchronous guard: handles unknown_method, permission_denied, bridge.ping
  // without deferring to a microtask.
  const early = guardRequest(req, { manifest: entry.manifest, permMap: entry.permMap });
  if (early !== null) {
    target.postMessage(early, '*');
    return;
  }
  if (!window.wp?.apiFetch) {
    target.postMessage(
      { type: 'dsgo:response', id: req.id, ok: false, error: { code: 'internal_error', message: 'wp.apiFetch unavailable' } },
      '*',
    );
    return;
  }
  const response = await handleRequest(req, {
    manifest: entry.manifest,
    permMap: entry.permMap,
    nonce: entry.nonce,
    ...(entry.appNonce ? { appNonce: entry.appNonce } : {}),
    apiFetch: window.wp.apiFetch,
  });
  target.postMessage(response, '*');
}

function entryFor(source: MessageEventSource | null): EmbedEntry | null {
  if (!source) return null;
  return embeds.get(source as Window) ?? null;
}

window.addEventListener('message', (event: MessageEvent<unknown>) => {
  // Re-discover lazily — iframes inside lazy-rendered blocks may not have
  // been in the DOM at script load.
  if (!entryFor(event.source)) discover();
  const entry = entryFor(event.source);
  if (!entry) return;

  const msg = event.data as BridgeMessage | null;
  if (!msg || typeof msg !== 'object') return;

  if ((msg as BridgeMessage).type === 'dsgo:hello') {
    entry.iframe.contentWindow?.postMessage({ type: 'dsgo:context', payload: entry.context }, '*');
    return;
  }
  if ((msg as { type: string }).type === 'dsgo:resize') {
    if (entry.context.mode !== 'block' || !entry.context.blockProps?.autoResize) return;
    const raw = Number((msg as { type: string; height: unknown }).height);
    if (!Number.isFinite(raw)) return;
    const h = Math.max(100, Math.min(2000, Math.round(raw)));
    entry.iframe.style.height = h + 'px';
    return;
  }
  if ((msg as BridgeMessage).type === 'dsgo:request') {
    void dispatch(entry, msg as BridgeRequest);
  }
});

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', discover, { once: true });
} else {
  discover();
}
