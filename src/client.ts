import {
  isBridgeError,
  newRequestId,
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
} from './shared';
import { BridgeRequestError } from './client-error';
import {
  applyExternalLocation,
  attachInlinePopstateListener,
  navigate as routerNavigate,
  setLocationFromContext,
  subscribe as routerSubscribe,
  type Location as RouterLocation,
  type NavigateOptions,
} from './router';

export { BridgeRequestError };

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

if (isInline) {
  // Inline mode: context is already known from the DOM script tag.
  // Messages are exchanged with the same window (postMessage target = window).
  // event.source is window in real browsers and null in jsdom.
  context = inlineContext;
  setLocationFromContext(context!);
  attachInlinePopstateListener();
  resolveReady();

  window.addEventListener('message', (event: MessageEvent<unknown>) => {
    // Accept messages from the same window (null covers jsdom where source is not set)
    if (event.source !== null && event.source !== window) return;
    const msg = event.data as BridgeMessage | null;
    if (!msg || typeof msg !== 'object') return;
    const type = (msg as BridgeMessage).type;

    if (type === 'dsgo:request') {
      // Guard: only the active module instance should handle incoming ability requests.
      // When vi.resetModules() accumulates stale inline listeners, only the module
      // that last called implement() (and set __dsgoActiveToken) will respond.
      if ((window as unknown as Record<string | symbol, unknown>)['__dsgoActiveToken'] !== _moduleToken) return;
      const req = msg as BridgeRequest;
      if (typeof req.method === 'string' && req.method.startsWith('ability:')) {
        void dispatchAbility(req.method, req.id, req.params, window);
      }
      return;
    }

    if (type !== 'dsgo:response') return;
    const resp = msg as BridgeResponse;
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
      // Guard: only the active module instance should handle incoming ability requests.
      if ((window as unknown as Record<string | symbol, unknown>)['__dsgoActiveToken'] !== _moduleToken) return;
      const req = msg as BridgeRequest;
      if (typeof req.method === 'string' && req.method.startsWith('ability:')) {
        void dispatchAbility(req.method, req.id, req.params, window.parent);
        return;
      }
      if (req.method === 'router:popstate') {
        const params = (req.params ?? {}) as Partial<RouterLocation>;
        applyExternalLocation(params);
        window.parent.postMessage({ type: 'dsgo:response', id: req.id, ok: true, data: null }, '*');
        return;
      }
    }

    if (type !== 'dsgo:response') return;
    const resp = msg as BridgeResponse;
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

export type PostStatus = 'publish' | 'draft' | 'private' | 'pending' | 'future' | 'any';

export interface PostsQuery {
  per_page?: number;
  page?: number;
  search?: string;
  category?: number | string;
  tag?: number | string;
  orderby?: 'date' | 'modified' | 'title' | 'id';
  order?: 'asc' | 'desc';
  status?: PostStatus;
}

export interface Post {
  id: number;
  slug: string;
  title: string;
  excerpt: string;
  content: string;
  status: PostStatus;
  protected: boolean;
  date: string;
  modified: string;
  author: number;
  link: string;
  featured_media_url: string | null;
  categories: number[];
  tags: number[];
}

export interface PostListResult { items: Post[]; total: number; total_pages: number }

export interface SiteInfo {
  title: string;
  description: string;
  url: string;
  admin_email: string;
  language: string;
  timezone: string;
  gmt_offset: number;
  date_format: string;
  time_format: string;
}

export interface EmailSendParams {
  to: 'admin' | 'current_user';
  subject: string;
  body: string;
  isHtml?: boolean;
  replyTo?: string;
}

export interface EmailSendResult { sent: true }

export interface MediaUploadOptions {
  /** Override the filename used for the WP attachment. Sanitized server-side. */
  filename?: string;
  /** Sets the attachment's alt text (`_wp_attachment_image_alt` meta). */
  altText?: string;
}

export interface MediaUploadResult {
  /** WP attachment post ID. */
  id: number;
  /** Public URL of the uploaded file (under `wp-content/uploads/...`). */
  url: string;
  /** Final MIME type of the stored file, as detected by WordPress. */
  mime_type: string;
  /** Final on-disk filename (after collision resolution). */
  filename: string;
  /** Image width in pixels, or null for non-rasterized formats (e.g. SVG). */
  width: number | null;
  /** Image height in pixels, or null for non-rasterized formats. */
  height: number | null;
  /** Alt text saved against the attachment, or `""` when none was supplied. */
  alt_text: string;
}

export interface CurrentUser {
  id: number;
  name: string;
  slug: string;
  email: string;
  avatar_url: string;
  roles: string[];
}

export const dsgo = {
  ready,
  get context(): BridgeContext | null { return context; },
  site: {
    info: () => call<SiteInfo>('site.info'),
  },
  posts: {
    list: (q?: PostsQuery) => call<PostListResult>('posts.list', q),
    get:  (id: number) => call<Post>('posts.get', { id }),
  },
  pages: {
    list: (q?: Omit<PostsQuery, 'category' | 'tag'>) => call<PostListResult>('pages.list', q),
    get:  (id: number) => call<Post>('pages.get', { id }),
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
  bridge: {
    ping: () => call<{ ok: true; bridge_version: number; server_time: string }>('bridge.ping'),
    requestResize: (height: number) => {
      if (!Number.isFinite(height)) return;
      const clamped = Math.max(100, Math.min(2000, Math.round(height)));
      if (typeof window !== 'undefined' && window.parent && window.parent !== window) {
        window.parent.postMessage({ type: 'dsgo:resize', height: clamped }, '*');
      }
    },
  },
} as const;

if (isInIframe || isInline) {
  window.dsgo = dsgo;
}
