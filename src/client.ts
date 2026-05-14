import {
  isBridgeError,
  newRequestId,
  clampResizeHeight,
  REQUEST_TIMEOUT_MS,
  METHOD_TIMEOUTS_MS,
  type BridgeContext,
  type BridgeErrorCode,
  type BridgeMessage,
  type BridgeRequest,
  type BridgeResponse,
  type AiPromptParams,
  type AiPromptResult,
  type AbilityDescriptor,
  type AbilityHandler,
  type BridgeMethodHelp,
  type HttpFetchInit,
  type HttpFetchResult,
} from './shared';
import { BridgeRequestError } from './client-error';
import { applyBlockStyles } from './dom';
import {
  applyExternalLocation,
  attachInlinePopstateListener,
  navigate as routerNavigate,
  setLocationFromContext,
  subscribe as routerSubscribe,
  type Location as RouterLocation,
  type NavigateOptions,
} from './router';
import type {
  PostStatus,
  PostsQuery,
  PostContentStyles,
  Post,
  PostListResult,
  SiteInfo,
  EmailSendParams,
  EmailSendResult,
  MediaUploadOptions,
  MediaUploadResult,
  CurrentUser,
  CommerceProduct,
  CommerceProductsQuery,
  CommerceProductsResult,
  CommerceCart,
  CheckoutHostedResult,
} from './types';

export { BridgeRequestError };
// Re-export every domain type so the package's public type surface (and the
// rollup .d.ts bundle) is unchanged after the move to types.ts.
export type {
  PostStatus,
  PostsQuery,
  PostContentStyles,
  Post,
  PostListResult,
  SiteInfo,
  EmailSendParams,
  EmailSendResult,
  MediaUploadOptions,
  MediaUploadResult,
  CurrentUser,
  CommerceProductAttributeTerm,
  CommerceProductAttribute,
  CommerceProductVariationRef,
  CommerceProductTaxonomyRef,
  CommerceQuantityLimits,
  CommerceProduct,
  CommerceProductsQuery,
  CommerceProductsResult,
  CommerceCartItem,
  CommerceCart,
  CheckoutHostedResult,
} from './types';

declare global {
  interface Window {
    dsgo?: typeof dsgo;
  }
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Read inline context from a <script type="application/json" id="dsgo-context">
 * tag injected by InlineRenderer. Returns the parsed BridgeContext when
 * mode === 'inline', otherwise null.
 */
function loadInlineContext(): BridgeContext | null {
  const tag = document.getElementById('dsgo-context');
  if (!tag) return null;
  try {
    const ctx = JSON.parse(tag.textContent ?? '');
    if (ctx?.mode === 'inline') return ctx as BridgeContext;
  } catch { /* ignore */ }
  return null;
}

/** Unique token for this module instance; used to guard the inline listener against
 *  stale copies left by vi.resetModules() in tests. */
const _moduleToken = Symbol('dsgo-module');

const pending = new Map<string, PendingRequest>();
const abilityHandlers = new Map<string, AbilityHandler<unknown, unknown>>();
let readyScheduled = false;
let context: BridgeContext | null = null;
let resolveReady!: () => void;
const ready = new Promise<void>((r) => { resolveReady = r; });

const isInIframe = typeof window !== 'undefined' && window.parent !== window;
const inlineContext = typeof document !== 'undefined' ? loadInlineContext() : null;
const isInline = inlineContext !== null;

function scheduleReady(): void {
  // Mark this module instance as the active handler so stale inline listeners
  // from prior vi.resetModules() reloads don't claim incoming ability requests.
  (window as unknown as Record<string | symbol, unknown>)['__dsgoActiveToken'] = _moduleToken;
  if (readyScheduled) return;
  readyScheduled = true;
  queueMicrotask(() => {
    readyScheduled = false;
    const target = isInline ? window : window.parent;
    target.postMessage({
      type: 'dsgo:abilities:ready',
      app_id: context?.appId ?? '',
      implementations: Array.from(abilityHandlers.keys()),
    }, '*');
  });
}

async function dispatchAbility(method: string, id: string, params: unknown, target: Window): Promise<void> {
  const name = method.slice('ability:'.length);
  const handler = abilityHandlers.get(name);
  if (!handler) {
    target.postMessage({
      type: 'dsgo:response', id, ok: false,
      error: { code: 'ability_not_implemented', message: `no handler for "${name}"` },
    }, '*');
    return;
  }
  try {
    const data = await handler(params);
    target.postMessage({ type: 'dsgo:response', id, ok: true, data }, '*');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    target.postMessage({
      type: 'dsgo:response', id, ok: false,
      error: { code: 'ability_handler_error', message: msg, details: { app_error: msg } },
    }, '*');
  }
}

/**
 * Settle the pending promise for an incoming `dsgo:response`. Identical
 * across both transports — only the per-transport listener differs in how
 * it decides a message is ours (event.source check) and what else it
 * handles (`dsgo:context`, `router:popstate`). Returns silently when the
 * id has no pending entry (late/duplicate response).
 */
function settleResponse(resp: BridgeResponse): void {
  const p = pending.get(resp.id);
  if (!p) return;
  pending.delete(resp.id);
  clearTimeout(p.timer);
  if (resp.ok) {
    p.resolve(resp.data);
  } else {
    const err = isBridgeError(resp.error)
      ? resp.error
      : { code: 'internal_error' as BridgeErrorCode, message: 'malformed error response' };
    p.reject(new BridgeRequestError(err));
  }
}

/**
 * True only when this module instance is the active handler. When
 * vi.resetModules() accumulates stale inline listeners, only the module
 * that last called implement() (and set __dsgoActiveToken) responds.
 */
function isActiveModule(): boolean {
  return (window as unknown as Record<string | symbol, unknown>)['__dsgoActiveToken'] === _moduleToken;
}

/**
 * Shared `dsgo:request` handling for `ability:` methods. `target` is the
 * window ability responses are posted back to (same window inline; parent
 * frame in iframe mode). Returns true when the request was an ability
 * request (handled here), false otherwise so the caller can fall through
 * to transport-specific request handling (e.g. `router:popstate`).
 */
function handleAbilityRequest(req: BridgeRequest, target: Window): boolean {
  if (typeof req.method === 'string' && req.method.startsWith('ability:')) {
    void dispatchAbility(req.method, req.id, req.params, target);
    return true;
  }
  return false;
}

if (isInline) {
  // Inline mode: context is already known from the DOM script tag.
  // Messages are exchanged with the same window (postMessage target = window).
  // event.source is window in real browsers and null in jsdom.
  if (inlineContext === null) {
    throw new BridgeRequestError({ code: 'internal_error', message: 'inline bridge bootstrapped without a context' });
  }
  context = inlineContext;
  setLocationFromContext(context);
  attachInlinePopstateListener();
  resolveReady();

  window.addEventListener('message', (event: MessageEvent<unknown>) => {
    // Accept messages from the same window (null covers jsdom where source is not set)
    if (event.source !== null && event.source !== window) return;
    const msg = event.data as BridgeMessage | null;
    if (!msg || typeof msg !== 'object') return;
    const type = (msg as BridgeMessage).type;

    if (type === 'dsgo:request') {
      if (!isActiveModule()) return;
      handleAbilityRequest(msg as BridgeRequest, window);
      return;
    }

    if (type !== 'dsgo:response') return;
    settleResponse(msg as BridgeResponse);
  });
} else if (isInIframe) {
  window.addEventListener('message', (event: MessageEvent<unknown>) => {
    if (event.source !== window.parent) return;
    const msg = event.data as BridgeMessage | null;
    if (!msg || typeof msg !== 'object') return;
    const type = (msg as BridgeMessage).type;

    if (type === 'dsgo:context') {
      context = (msg as { type: 'dsgo:context'; payload: BridgeContext }).payload;
      setLocationFromContext(context);
      resolveReady();
      return;
    }

    if (type === 'dsgo:request') {
      if (!isActiveModule()) return;
      const req = msg as BridgeRequest;
      // Ability requests are shared with inline mode; only the parent-driven
      // `router:popstate` is genuinely iframe-specific.
      if (handleAbilityRequest(req, window.parent)) return;
      if (req.method === 'router:popstate') {
        const params = (req.params ?? {}) as Partial<RouterLocation>;
        applyExternalLocation(params);
        window.parent.postMessage({ type: 'dsgo:response', id: req.id, ok: true, data: null }, '*');
        return;
      }
    }

    if (type !== 'dsgo:response') return;
    settleResponse(msg as BridgeResponse);
  });

  window.parent.postMessage({ type: 'dsgo:hello' }, '*');
} else {
  resolveReady();
}

async function call<T>(method: string, params?: unknown): Promise<T> {
  await ready;
  return new Promise<T>((resolve, reject) => {
    if (!isInline && !isInIframe) {
      reject(new BridgeRequestError({ code: 'internal_error', message: 'bridge client not running inside an iframe' }));
      return;
    }
    const id = newRequestId();
    const timeoutMs = (() => {
      const fn = METHOD_TIMEOUTS_MS[method];
      return fn && context !== null ? fn(context) : REQUEST_TIMEOUT_MS;
    })();
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new BridgeRequestError({ code: 'internal_error', message: `request "${method}" timed out` }));
    }, timeoutMs);
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
    // Inline mode: same-window transport. Iframe mode: post to parent frame.
    const target = isInline ? window : window.parent;
    target.postMessage({ type: 'dsgo:request', id, method, params }, '*');
  });
}

/**
 * Try invoking a registered ability first; if no matching ability is
 * registered or the Abilities API is unavailable, fall back to running
 * `restCall` and return its result.
 *
 * Fallbacks:
 *  - `not_found` — the ability name isn't registered on this site.
 *  - `not_implemented` — the Abilities API isn't available (old WP).
 *  - `permission_denied` ONLY when `details.reason === 'manifest_permission_missing'`
 *    — i.e. the app's manifest doesn't declare `abilities` permission, so the
 *    client-side guard refused the probe before any ability could even be
 *    consulted. That's not an authorization decision about a specific
 *    ability, it's "this app can't probe abilities at all here," and the
 *    documented abilities-first/REST-fallback contract should still hold.
 *
 * Runtime `permission_denied` from the abilities runtime itself (the ability
 * exists and refused the visitor, or it isn't in the manifest's
 * `abilities.consumes` allow-list) MUST propagate; falling back through REST
 * would silently bypass the ability's per-visitor policy. Those errors arrive
 * without the `manifest_permission_missing` details marker, so they fall
 * through to the throw below.
 */
async function tryAbilityElseRest<T>(
  abilityName: string,
  abilityArgs: Record<string, unknown> | undefined,
  restCall: () => Promise<T>,
): Promise<T> {
  try {
    return await call<T>('abilities.invoke', { name: abilityName, args: abilityArgs });
  } catch (err) {
    if (err instanceof BridgeRequestError) {
      if (err.code === 'not_found' || err.code === 'not_implemented') {
        return await restCall();
      }
      if (err.code === 'permission_denied') {
        const details = err.details as { reason?: unknown; permission?: unknown } | undefined;
        if (details?.reason === 'manifest_permission_missing' && details?.permission === 'abilities') {
          return await restCall();
        }
      }
    }
    throw err;
  }
}

export const dsgo = {
  ready,
  get context(): BridgeContext | null { return context; },
  site: {
    info: () => call<SiteInfo>('site.info'),
  },
  posts: {
    list: (q?: PostsQuery) => call<PostListResult>('posts.list', q),
    get:  (id: number, opts?: { type?: string }) => call<Post>('posts.get', { id, ...(opts ?? {}) }),
  },
  pages: {
    list: (q?: Omit<PostsQuery, 'category' | 'tag'>) => call<PostListResult>('pages.list', q),
    get:  (id: number) => call<Post>('pages.get', { id }),
  },
  content: {
    /**
     * Inject the block + theme stylesheets WordPress would normally enqueue
     * for a post's content. Idempotent and dedup'd: calling it again with
     * the same `content_styles` is a no-op. Pass either the styles object
     * (`post.content_styles`) or the post itself.
     *
     * Manifests opt in by declaring `content.blockStyles` (and optionally
     * `content.themeStyles`). Without that, posts arrive with
     * `content_styles: null` and this helper returns 0 without doing
     * anything — safe to call defensively.
     *
     * @returns the number of <link> + <style> nodes appended this call.
     */
    applyBlockStyles: (input: PostContentStyles | Post | null | undefined): number =>
      applyBlockStyles(input),
  },
  user: {
    current: () => call<CurrentUser | null>('user.current'),
    can:     (cap: string) => call<boolean>('user.can', { cap }),
  },
  storage: {
    app: {
      get: (key: string) => call<unknown>('storage.app.get', { key }),
      set: (key: string, value: unknown) => call<void>('storage.app.set', { key, value }),
    },
    user: {
      get: (key: string) => call<unknown>('storage.user.get', { key }),
      set: (key: string, value: unknown) => call<void>('storage.user.set', { key, value }),
    },
  },
  abilities: {
    list:   () => call<AbilityDescriptor[]>('abilities.list'),
    invoke: <T = unknown>(name: string, args?: Record<string, unknown>) =>
      call<T>('abilities.invoke', { name, args }),
    implement<I = unknown, O = unknown>(name: string, handler: AbilityHandler<I, O>): void {
      abilityHandlers.set(name, handler as AbilityHandler<unknown, unknown>);
      scheduleReady();
    },
  },
  ai: {
    prompt: (params: AiPromptParams) => call<AiPromptResult>('ai.prompt', params),
  },
  email: {
    send: (params: EmailSendParams) => call<EmailSendResult>('email.send', params),
  },
  http: {
    /**
     * Server-mediated outbound HTTP request. The app never sees the
     * credentials referenced via `{{ALIAS}}` tokens in init.headers —
     * those resolve from the per-app vault at the server, and the
     * resolved values never round-trip back into the response.
     *
     * Only https:// URLs whose host matches a manifest entry under
     * `permissions.http` are allowed; everything else rejects with
     * `http_host_not_allowed` (or `http_invalid_url` for non-https).
     * 30x responses are surfaced verbatim — the proxy does not follow
     * redirects, so apps that need to chase a Location header must
     * re-call fetch with the new URL themselves.
     */
    fetch: (url: string, init?: HttpFetchInit) =>
      call<HttpFetchResult>('http.fetch', { url, init }),
  },
  media: {
    /**
     * Upload a Blob (or File) to the site's WordPress media library. The
     * resulting attachment is owned by the current visitor and tagged with
     * the app id so admins can audit which app produced each asset.
     *
     * Core, opt-out: every app gets this method. Apps that don't want to
     * expose uploads to their users can disable it by adding
     * `"media": { "uploads": false }` to their manifest. The runtime gate is
     * the standard WP `upload_files` capability, so anonymous visitors and
     * subscriber-tier users get `permission_denied` automatically.
     */
    upload: (file: Blob, opts?: MediaUploadOptions) =>
      call<MediaUploadResult>('media.upload', {
        file,
        filename: opts?.filename,
        alt_text: opts?.altText,
      }),
  },
  commerce: {
    products: {
      list: (q?: CommerceProductsQuery) =>
        tryAbilityElseRest<CommerceProductsResult>(
          'woocommerce/list-products', q as Record<string, unknown> | undefined,
          () => call<CommerceProductsResult>('commerce.products.list', q),
        ),
      get: (id: number) =>
        tryAbilityElseRest<CommerceProduct>(
          'woocommerce/get-product', { id },
          () => call<CommerceProduct>('commerce.products.get', { id }),
        ),
    },
    cart: {
      get: () =>
        tryAbilityElseRest<CommerceCart>(
          'woocommerce/get-cart', undefined,
          () => call<CommerceCart>('commerce.cart.get'),
        ),
      addItem: (params: { id: number; quantity?: number; variation?: { attribute: string; value: string }[] }) =>
        tryAbilityElseRest<CommerceCart>(
          'woocommerce/cart-add-item', params as unknown as Record<string, unknown>,
          () => call<CommerceCart>('commerce.cart.add_item', params),
        ),
      updateItem: (params: { key: string; quantity: number }) =>
        tryAbilityElseRest<CommerceCart>(
          'woocommerce/cart-update-item', params as unknown as Record<string, unknown>,
          () => call<CommerceCart>('commerce.cart.update_item', params),
        ),
      removeItem: (params: { key: string }) =>
        tryAbilityElseRest<CommerceCart>(
          'woocommerce/cart-remove-item', params as unknown as Record<string, unknown>,
          () => call<CommerceCart>('commerce.cart.remove_item', params),
        ),
    },
    checkout: {
      /**
       * Get the WooCommerce checkout URL and navigate the top window to it.
       * WC's session cookie carries the cart through the navigation, so the
       * visitor lands at /checkout/ with their cart intact.
       *
       * Returns `{ url, navigated: true }` after the navigation request is
       * dispatched. In iframe mode the parent does the actual navigation; in
       * inline mode we navigate the current window directly.
       */
      openHostedPage: async (params?: { return_to?: string }): Promise<CheckoutHostedResult> => {
        const result = await call<{ url: string }>('commerce.checkout.open_hosted_page', params ?? {});
        const url = result?.url ?? '';
        if (typeof window === 'undefined' || url === '') {
          return { url, navigated: false };
        }
        // Inline mode: same window. Iframe mode: ask parent to top-navigate
        // (the sandbox blocks `window.top.location =` from inside the iframe).
        if (isInline) {
          window.location.assign(url);
        } else if (window.parent && window.parent !== window) {
          window.parent.postMessage({ type: 'dsgo:nav-top', url }, '*');
        }
        return { url, navigated: true };
      },
    },
  },
  router: {
    navigate: (path: string, opts?: NavigateOptions) =>
      routerNavigate(path, opts ?? {}, {
        context,
        forwardToParent: async (params) => {
          await call<null>('router.navigate', params);
        },
      }),
    subscribe: (handler: (loc: RouterLocation) => void) => routerSubscribe(handler),
  },
  help: {
    /**
     * Look up a bridge method's full documentation at runtime.
     *
     * Always available — no manifest permission required. Returns
     * `{ signature, description, errors, examples }` for known methods, or
     * throws a BridgeError with code `not_found` for unknown ones.
     *
     * Useful for: discovering methods not enumerated in your harness prompt,
     * confirming a method's exact parameter shape, generating in-app help text.
     */
    method: (name: string) => call<BridgeMethodHelp>('help.method', { name }),
  },
  bridge: {
    ping: () => call<{ ok: true; bridge_version: number; server_time: string }>('bridge.ping'),
    requestResize: (height: number) => {
      if (!Number.isFinite(height)) return;
      const clamped = clampResizeHeight(height);
      if (typeof window !== 'undefined' && window.parent && window.parent !== window) {
        window.parent.postMessage({ type: 'dsgo:resize', height: clamped }, '*');
      }
    },
  },
} as const;

if (isInIframe || isInline) {
  window.dsgo = dsgo;
}
