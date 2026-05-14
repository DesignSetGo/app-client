/**
 * parent-bridge-publish — wp-admin module that registers DSGo apps' published
 * abilities with @wordpress/abilities and bridges executeAbility() calls into
 * sandboxed iframes.
 *
 * Reads <script id="dsgo-publisher-config"> JSON island; for each app's
 * abilities[] calls registerAbility() with an async callback that:
 *   1. Finds-or-creates a hidden iframe at the app's bundle URL.
 *   2. Waits for dsgo:abilities:ready from the iframe.
 *   3. Posts dsgo:request{method:"ability:<name>", params:input} to the iframe.
 *   4. Awaits the matching dsgo:response.
 *   5. Returns/throws as appropriate.
 *
 * Also handles iframe→parent dsgo:hello (responds with synthesized context)
 * and dsgo:request (proxies posts.list/etc. via wp.apiFetch + handleRequest).
 */

import { registerAbility, registerAbilityCategory, getAbilityCategory } from '@wordpress/abilities';
import {
  BridgeRequestError,
  toBridgeError,
  type BridgeContext,
  type BridgeRequest,
  type BridgeResponse,
  type PublisherConfig,
  type PublisherAppConfig,
  type PublishedAbilityDescriptor,
} from './shared';
import { handleRequest, type ApiFetch } from './transport';

declare global {
  interface Window {
    wp?: { apiFetch?: ApiFetch };
  }
}

interface InflightAbility {
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface IframeEntry {
  appId: string;
  iframe: HTMLIFrameElement;
  ready: Promise<string[]>;
  resolveReady: (impls: string[]) => void;
  rejectReady: (err: unknown) => void;
  inflight: Map<string, InflightAbility>;
  idleTimer: ReturnType<typeof setTimeout> | null;
  lastUsedAt: number;
  isHidden: boolean;
  appConfig: PublisherAppConfig;
}

const READY_TIMEOUT_MS = 10_000;
const IDLE_TIMEOUT_MS = 30_000;
const LRU_HIDDEN_CAP = 4;
const MAX_INFLIGHT_PER_IFRAME = 8;

const entries = new Map<string, IframeEntry>();
let nextRequestId = 0;

function readConfig(): PublisherConfig | null {
  const tag = document.getElementById('dsgo-publisher-config');
  if (!tag?.textContent) return null;
  try {
    return JSON.parse(tag.textContent) as PublisherConfig;
  } catch {
    return null;
  }
}

function escapeAttr(value: string): string {
  // CSS.escape is not available in all environments (e.g. jsdom test env).
  // App IDs are constrained to slug characters by the manifest validator so
  // a simple double-quote escape is sufficient for the attribute selector.
  return (typeof CSS !== 'undefined' && CSS.escape)
    ? CSS.escape(value)
    : value.replace(/["\\]/g, '\\$&');
}

function findVisibleMount(appId: string): HTMLIFrameElement | null {
  return document.querySelector<HTMLIFrameElement>(
    `iframe[data-dsgo-app-id="${escapeAttr(appId)}"]:not([data-dsgo-publisher-host])`,
  );
}

function createHiddenIframe(appConfig: PublisherAppConfig): HTMLIFrameElement {
  const iframe = document.createElement('iframe');
  iframe.setAttribute('data-dsgo-app-id', appConfig.id);
  iframe.setAttribute('data-dsgo-publisher-host', '1');
  iframe.setAttribute('sandbox', 'allow-scripts');
  iframe.setAttribute('aria-hidden', 'true');
  iframe.setAttribute('tabindex', '-1');
  iframe.style.cssText = 'position:absolute;left:-9999px;top:-9999px;width:0;height:0;border:0;visibility:hidden;';
  iframe.src = appConfig.bundle_url;
  document.body.appendChild(iframe);
  return iframe;
}

function getOrCreateEntry(appConfig: PublisherAppConfig): IframeEntry {
  const existing = entries.get(appConfig.id);
  if (existing) {
    existing.lastUsedAt = Date.now();
    resetIdle(existing);
    return existing;
  }

  const visible = findVisibleMount(appConfig.id);
  let iframe: HTMLIFrameElement;
  let isHidden: boolean;

  if (visible) {
    iframe = visible;
    isHidden = false;
  } else {
    enforceLruCap();
    iframe = createHiddenIframe(appConfig);
    isHidden = true;
  }

  let resolveReady!: (impls: string[]) => void;
  let rejectReady!: (err: unknown) => void;
  const rawReady = new Promise<string[]>((res, rej) => {
    resolveReady = res;
    rejectReady = rej;
  });

  // For hidden iframes we arm a load-timeout; visible mounts may already be
  // ready — their dsgo:abilities:ready message will resolve rawReady normally.
  let readyTimer: ReturnType<typeof setTimeout> | null = null;
  if (isHidden) {
    readyTimer = setTimeout(() => {
      rejectReady(new BridgeRequestError({ code: 'app_load_failed', message: `app "${appConfig.id}" did not become ready within ${READY_TIMEOUT_MS}ms` }));
    }, READY_TIMEOUT_MS);
  }

  const entry: IframeEntry = {
    appId: appConfig.id,
    iframe,
    ready: rawReady.finally(() => { if (readyTimer) clearTimeout(readyTimer); }),
    resolveReady,
    rejectReady,
    inflight: new Map(),
    idleTimer: null,
    lastUsedAt: Date.now(),
    isHidden,
    appConfig,
  };

  entries.set(appConfig.id, entry);
  resetIdle(entry);
  return entry;
}

function resetIdle(entry: IframeEntry): void {
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  entry.idleTimer = setTimeout(() => teardown(entry), IDLE_TIMEOUT_MS);
}

function teardown(entry: IframeEntry): void {
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  if (entry.isHidden && entry.iframe.parentNode) {
    entry.iframe.parentNode.removeChild(entry.iframe);
  }
  for (const [, inflight] of entry.inflight) {
    clearTimeout(inflight.timer);
    inflight.reject(new BridgeRequestError({ code: 'internal_error', message: 'iframe torn down' }));
  }
  entries.delete(entry.appId);
}

function enforceLruCap(): void {
  const hidden = Array.from(entries.values())
    .filter((e) => e.isHidden)
    .sort((a, b) => a.lastUsedAt - b.lastUsedAt);
  while (hidden.length >= LRU_HIDDEN_CAP) {
    const evict = hidden.shift()!;
    teardown(evict);
  }
}

async function dispatch(
  appConfig: PublisherAppConfig,
  ability: PublishedAbilityDescriptor,
  input: unknown,
): Promise<unknown> {
  const entry = getOrCreateEntry(appConfig);

  let implementations: string[];
  try {
    implementations = await entry.ready;
  } catch (err) {
    teardown(entry);
    throw err;
  }

  if (!implementations.includes(ability.name)) {
    throw new BridgeRequestError({ code: 'ability_not_implemented', message: `app "${appConfig.id}" does not implement "${ability.name}"` });
  }
  if (entry.inflight.size >= MAX_INFLIGHT_PER_IFRAME) {
    throw new BridgeRequestError({ code: 'rate_limited', message: `too many in-flight calls to "${appConfig.id}"` });
  }

  const id = `pub_${++nextRequestId}`;
  resetIdle(entry);

  return new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => {
      entry.inflight.delete(id);
      reject(new BridgeRequestError({ code: 'ability_timeout', message: `"${ability.name}" exceeded ${ability.timeout_seconds}s` }));
    }, ability.timeout_seconds * 1000);

    entry.inflight.set(id, { resolve, reject, timer });
    entry.iframe.contentWindow?.postMessage(
      { type: 'dsgo:request', id, method: `ability:${ability.name}`, params: input },
      '*',
    );
  });
}

function makeContextFor(appConfig: PublisherAppConfig): BridgeContext {
  return {
    bridgeVersion: 1,
    appId: appConfig.id,
    mode: 'admin',
    locale: document.documentElement.lang || 'en-US',
    theme: 'light',
    blockProps: null,
    routeParams: {},
    path: '/',
    search: '',
    hash: '',
    mountPrefix: null,
  };
}

function setupGlobalMessageListener(): void {
  window.addEventListener('message', (event: MessageEvent<unknown>) => {
    const msg = event.data;
    if (!msg || typeof msg !== 'object') return;
    const type = (msg as { type: unknown }).type;

    // Find which entry owns this message source
    let owner: IframeEntry | null = null;
    for (const e of entries.values()) {
      if (e.iframe.contentWindow === event.source) {
        owner = e;
        break;
      }
    }
    if (!owner) return;

    if (type === 'dsgo:hello') {
      owner.iframe.contentWindow?.postMessage(
        { type: 'dsgo:context', payload: makeContextFor(owner.appConfig) },
        '*',
      );
      return;
    }

    if (type === 'dsgo:abilities:ready') {
      const m = msg as { implementations?: unknown };
      const impls = Array.isArray(m.implementations)
        ? (m.implementations.filter((x) => typeof x === 'string') as string[])
        : [];
      owner.resolveReady(impls);
      return;
    }

    if (type === 'dsgo:response') {
      const r = msg as BridgeResponse;
      const inflight = owner.inflight.get(r.id);
      if (!inflight) return;
      owner.inflight.delete(r.id);
      clearTimeout(inflight.timer);
      if (r.ok) {
        inflight.resolve(r.data);
      } else {
        // Preserve the structured `{code, message, details}` — the registerAbility
        // callback maps it back into a BridgeRequestError below.
        inflight.reject(new BridgeRequestError(r.error));
      }
      resetIdle(owner);
      return;
    }

    if (type === 'dsgo:request') {
      void handleIframeRequest(owner, msg as BridgeRequest);
      return;
    }
  });
}

async function handleIframeRequest(owner: IframeEntry, req: BridgeRequest): Promise<void> {
  if (!window.wp?.apiFetch) {
    owner.iframe.contentWindow?.postMessage(
      { type: 'dsgo:response', id: req.id, ok: false, error: { code: 'internal_error', message: 'wp.apiFetch unavailable' } },
      '*',
    );
    return;
  }

  const cfg = owner.appConfig;
  // The publish-side permMap is intentionally a subset of the main bridge's
  // surface. Methods deliberately NOT exposed to embedded apps via the
  // parent-bridge-publish channel:
  //   - `email.send` / `media.upload` — would let an embedded app act on the
  //     host site's behalf (send mail / write to media library) outside the
  //     visibility of the host's own permission gates.
  //   - `commerce.*` — host-site WooCommerce surface; embedded apps shouldn't
  //     touch the host's cart or product catalog.
  //   - `http.fetch` — by design in v1: an embedded app calling the proxy
  //     would resolve secrets against the host site's vault. That's the wrong
  //     blast radius — the credential belongs to the host operator, not the
  //     publisher. Embedded apps that need outbound HTTP should make the call
  //     from their own bundle context (where they own the vault).
  // Any method omitted here returns `unknown_method` to the embedded app,
  // which is the right signal for "this surface is intentionally not here."
  const permMap: Record<string, string | null> = {
    'site.info': 'site_info',
    'posts.list': 'posts',
    'posts.get': 'posts',
    'pages.list': 'pages',
    'pages.get': 'pages',
    'user.current': 'user',
    'user.can': 'user',
    'storage.app.get': null,
    'storage.app.set': null,
    'storage.user.get': null,
    'storage.user.set': null,
    'bridge.ping': null,
    'help.method': null,
    'abilities.list': 'abilities',
    'abilities.invoke': 'abilities',
    'ai.prompt': 'ai',
  };

  const manifest = { id: cfg.id, permissions: { read: cfg.permissions.read } };
  const config = readConfig();
  const nonce = config?.rest_nonce ?? '';

  const response = await handleRequest(req, {
    manifest,
    permMap,
    nonce,
    apiFetch: window.wp.apiFetch,
  });
  owner.iframe.contentWindow?.postMessage(response, '*');
  resetIdle(owner);
}

const DSGO_CATEGORY = 'dsgo-app';

function ensureCategory(): void {
  if (getAbilityCategory(DSGO_CATEGORY)) return;
  registerAbilityCategory(DSGO_CATEGORY, {
    label: 'DesignSetGo Apps',
    description: 'Abilities published by DesignSetGo apps installed on this site.',
  });
}

function init(): void {
  const config = readConfig();
  if (!config || config.apps.length === 0) return;

  setupGlobalMessageListener();
  ensureCategory();

  for (const app of config.apps) {
    for (const ability of app.abilities) {
      registerAbility({
        name: ability.name,
        label: ability.label,
        description: ability.description,
        category: ability.category,
        ...(ability.input_schema ? { input_schema: ability.input_schema } : {}),
        ...(ability.output_schema ? { output_schema: ability.output_schema } : {}),
        annotations: ability.annotations,
        callback: async (input: unknown) => {
          try {
            return await dispatch(app, ability, input);
          } catch (err) {
            // Re-throw as a structured BridgeRequestError so the `code` and
            // `details` survive — `dispatch` rejects with BridgeRequestError,
            // but coerce anything unexpected too rather than flattening to a
            // bare `Error("code: message")`.
            if (err instanceof BridgeRequestError) throw err;
            throw new BridgeRequestError(toBridgeError(err));
          }
        },
      });
    }
  }
}

init();
