import {
  isBridgeError,
  newRequestId,
  REQUEST_TIMEOUT_MS,
  METHOD_TIMEOUTS_MS,
  type BridgeContext,
  type BridgeError,
  type BridgeErrorCode,
  type BridgeMessage,
  type BridgeResponse,
  type AiPromptParams,
  type AiPromptResult,
  type AbilityDescriptor,
} from './shared';

export class BridgeRequestError extends Error implements BridgeError {
  public readonly code: BridgeErrorCode;
  public readonly details?: unknown;
  constructor(error: BridgeError) {
    super(`${error.code}: ${error.message}`);
    this.code = error.code;
    this.details = error.details;
    this.name = 'BridgeRequestError';
  }
}

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

const pending = new Map<string, PendingRequest>();
let context: BridgeContext | null = null;
let resolveReady!: () => void;
const ready = new Promise<void>((r) => { resolveReady = r; });

const isInIframe = typeof window !== 'undefined' && window.parent !== window;
const inlineContext = typeof document !== 'undefined' ? loadInlineContext() : null;
const isInline = inlineContext !== null;

if (isInline) {
  // Inline mode: context is already known from the DOM script tag.
  // Messages are exchanged with the same window (postMessage target = window).
  // event.source is window in real browsers and null in jsdom.
  context = inlineContext;
  resolveReady();

  window.addEventListener('message', (event: MessageEvent<unknown>) => {
    // Accept messages from the same window (null covers jsdom where source is not set)
    if (event.source !== null && event.source !== window) return;
    const msg = event.data as BridgeMessage | null;
    if (!msg || typeof msg !== 'object') return;
    if ((msg as BridgeMessage).type !== 'dsgo:response') return;
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

    if ((msg as BridgeMessage).type === 'dsgo:context') {
      context = (msg as { type: 'dsgo:context'; payload: BridgeContext }).payload;
      resolveReady();
      return;
    }

    if ((msg as BridgeMessage).type !== 'dsgo:response') return;
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
  },
  ai: {
    prompt: (params: AiPromptParams) => call<AiPromptResult>('ai.prompt', params),
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
