import {
  isBridgeError,
  newRequestId,
  REQUEST_TIMEOUT_MS,
  type BridgeContext,
  type BridgeError,
  type BridgeErrorCode,
  type BridgeMessage,
  type BridgeResponse,
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

const pending = new Map<string, PendingRequest>();
let context: BridgeContext | null = null;
let resolveReady!: () => void;
const ready = new Promise<void>((r) => { resolveReady = r; });

const isInIframe = typeof window !== 'undefined' && window.parent !== window;

if (isInIframe) {
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
    if (!isInIframe) {
      reject(new BridgeRequestError({ code: 'internal_error', message: 'bridge client not running inside an iframe' }));
      return;
    }
    const id = newRequestId();
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new BridgeRequestError({ code: 'internal_error', message: `request "${method}" timed out` }));
    }, REQUEST_TIMEOUT_MS);
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
    window.parent.postMessage({ type: 'dsgo:request', id, method, params }, '*');
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
  bridge: {
    ping: () => call<{ ok: true; bridge_version: number; server_time: string }>('bridge.ping'),
  },
} as const;

if (isInIframe) {
  window.dsgo = dsgo;
}
