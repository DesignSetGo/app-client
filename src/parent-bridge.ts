import {
  type BridgeContext,
  type BridgeError,
  type BridgeMessage,
  type BridgeRequest,
  type BridgeResponse,
} from './shared';

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

function reply(id: string, ok: boolean, payload: unknown): void {
  const msg: BridgeResponse = ok
    ? { type: 'dsgo:response', id, ok: true, data: payload }
    : { type: 'dsgo:response', id, ok: false, error: payload as BridgeError };
  iframeWindow?.postMessage(msg, '*');
}

async function dispatch(req: BridgeRequest): Promise<void> {
  const required = permMap[req.method];
  if (required === undefined) {
    return reply(req.id, false, { code: 'unknown_method', message: req.method });
  }
  if (required !== null && !manifest.permissions.read.includes(required)) {
    return reply(req.id, false, { code: 'permission_denied', message: `app does not have "${required}" permission` });
  }

  if (req.method === 'bridge.ping') {
    return reply(req.id, true, { ok: true, bridge_version: 1, server_time: new Date().toISOString() });
  }

  if (!window.wp?.apiFetch) {
    return reply(req.id, false, { code: 'internal_error', message: 'wp.apiFetch unavailable' });
  }

  try {
    const result = await routeToWp(req);
    reply(req.id, true, result);
  } catch (err: any) {
    const status = err?.data?.status as number | undefined;
    const code = status === 401 ? 'not_authenticated'
      : status === 403 ? 'permission_denied'
      : status === 404 ? 'not_found'
      : 'internal_error';
    reply(req.id, false, { code, message: err?.message ?? String(err) });
  }
}

function shapePost(raw: any): unknown {
  if (!raw || typeof raw !== 'object') return raw;
  return {
    id:                 raw.id,
    slug:               raw.slug,
    title:              raw.title?.rendered ?? '',
    excerpt:            raw.excerpt?.rendered ?? '',
    content:            raw.content?.rendered ?? '',
    status:             raw.status,
    protected:          raw.content?.protected ?? raw.excerpt?.protected ?? false,
    date:               raw.date_gmt ? raw.date_gmt + 'Z' : raw.date,
    modified:           raw.modified_gmt ? raw.modified_gmt + 'Z' : raw.modified,
    author:             raw.author,
    link:               raw.link,
    featured_media_url: null, // populated server-side requires _embed; v1 leaves it null
    categories:         raw.categories ?? [],
    tags:               raw.tags ?? [],
  };
}

async function routeToWp(req: BridgeRequest): Promise<unknown> {
  const af = window.wp!.apiFetch!;
  const headers = { 'X-WP-Nonce': nonce };

  switch (req.method) {
    case 'site.info': {
      const raw = await af({ path: '/', headers }) as Record<string, unknown>;
      return {
        title:       raw.name,
        description: raw.description,
        url:         raw.url,
        admin_email: raw.email,
        language:    raw.language,
        timezone:    raw.timezone_string,
        gmt_offset:  raw.gmt_offset,
        date_format: raw.date_format,
        time_format: raw.time_format,
      };
    }
    case 'posts.list': {
      const q = (req.params ?? {}) as Record<string, unknown>;
      const resp = await af({ path: '/wp/v2/posts?' + new URLSearchParams(q as Record<string, string>).toString(), headers, parse: false }) as Response;
      const rawItems = await resp.json();
      return {
        items:       Array.isArray(rawItems) ? rawItems.map(shapePost) : [],
        total:       parseInt(resp.headers.get('X-WP-Total') ?? '0', 10),
        total_pages: parseInt(resp.headers.get('X-WP-TotalPages') ?? '0', 10),
      };
    }
    case 'posts.get': {
      const { id } = req.params as { id: number };
      return shapePost(await af({ path: `/wp/v2/posts/${id}`, headers }));
    }
    case 'pages.list': {
      const q = (req.params ?? {}) as Record<string, unknown>;
      const resp = await af({ path: '/wp/v2/pages?' + new URLSearchParams(q as Record<string, string>).toString(), headers, parse: false }) as Response;
      const rawItems = await resp.json();
      return {
        items:       Array.isArray(rawItems) ? rawItems.map(shapePost) : [],
        total:       parseInt(resp.headers.get('X-WP-Total') ?? '0', 10),
        total_pages: parseInt(resp.headers.get('X-WP-TotalPages') ?? '0', 10),
      };
    }
    case 'pages.get': {
      const { id } = req.params as { id: number };
      return shapePost(await af({ path: `/wp/v2/pages/${id}`, headers }));
    }
    case 'user.current': {
      // Anonymous visitors get null per the spec, not an exception.
      try {
        const raw = await af({ path: '/wp/v2/users/me?context=edit', headers }) as any;
        return {
          id:         raw.id,
          name:       raw.name,
          slug:       raw.slug,
          email:      raw.email ?? '',
          avatar_url: raw.avatar_urls?.['96'] ?? raw.avatar_urls?.['48'] ?? raw.avatar_urls?.['24'] ?? '',
          roles:      raw.roles ?? [],
        };
      } catch (err: any) {
        if (err?.data?.status === 401) return null;
        throw err;
      }
    }
    case 'user.can': {
      // Anonymous visitors get false per the spec, not an exception.
      const { cap } = req.params as { cap: string };
      try {
        const r = await af({ path: '/dsgo/v1/can?cap=' + encodeURIComponent(cap), headers });
        return (r as any).can;
      } catch (err: any) {
        if (err?.data?.status === 401) return false;
        throw err;
      }
    }
    case 'storage.app.get': {
      const { key } = req.params as { key: string };
      const r = await af({ path: `/dsgo/v1/apps/${manifest.id}/storage/app/${encodeURIComponent(key)}`, headers });
      return (r as any).value;
    }
    case 'storage.app.set': {
      const { key, value } = req.params as { key: string; value: unknown };
      await af({ path: `/dsgo/v1/apps/${manifest.id}/storage/app/${encodeURIComponent(key)}`, method: 'PUT', data: { value }, headers });
      return null;
    }
    case 'storage.user.get': {
      const { key } = req.params as { key: string };
      const r = await af({ path: `/dsgo/v1/apps/${manifest.id}/storage/user/${encodeURIComponent(key)}`, headers });
      return (r as any).value;
    }
    case 'storage.user.set': {
      const { key, value } = req.params as { key: string; value: unknown };
      await af({ path: `/dsgo/v1/apps/${manifest.id}/storage/user/${encodeURIComponent(key)}`, method: 'PUT', data: { value }, headers });
      return null;
    }
    default:
      throw new Error('unknown method: ' + req.method);
  }
}

window.addEventListener('message', (event: MessageEvent<unknown>) => {
  if (event.source !== iframeWindow) return;
  const msg = event.data as BridgeMessage | null;
  if (!msg || typeof msg !== 'object') return;
  if ((msg as BridgeMessage).type === 'dsgo:hello') {
    iframeWindow?.postMessage({ type: 'dsgo:context', payload: ctx }, '*');
    return;
  }
  if ((msg as BridgeMessage).type === 'dsgo:request') {
    void dispatch(msg as BridgeRequest);
  }
});
