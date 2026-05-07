/**
 * transport.ts — transport-agnostic request dispatcher.
 *
 * Both the iframe transport (parent-bridge.ts) and the upcoming inline
 * transport (Task 13) can call `handleRequest` with their own apiFetch
 * instance and globals, keeping all method-routing logic in one place.
 */

import type { BridgeRequest, BridgeResponse, BridgeErrorCode } from './shared';
import { BRIDGE_ERROR_CODES } from './shared';

interface WpRestErrorBody {
  code?: unknown;
  message?: unknown;
  data?: {
    status?: unknown;
    details?: {
      status?: { code?: string };
    };
  };
}

export type ApiFetch = (opts: {
  path: string;
  method?: string;
  data?: unknown;
  headers?: Record<string, string>;
  parse?: boolean;
}) => Promise<unknown>;

export interface RequestHandlerDeps {
  manifest: { id: string; permissions: { read: string[] } };
  permMap: Record<string, string | null>;
  nonce: string;
  apiFetch: ApiFetch;
}

function makeOk(id: string, data: unknown): BridgeResponse {
  return { type: 'dsgo:response', id, ok: true, data };
}

function makeErr(id: string, code: BridgeErrorCode, message: string): BridgeResponse {
  return { type: 'dsgo:response', id, ok: false, error: { code, message } };
}

// ---------------------------------------------------------------------------
// Response shapers — live here because they are transport-agnostic; they turn
// raw WP REST responses into the typed bridge payload shapes.
// ---------------------------------------------------------------------------

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
    featured_media_url: null,
    categories:         raw.categories ?? [],
    tags:               raw.tags ?? [],
  };
}

// ---------------------------------------------------------------------------
// Synchronous guard — call before any async work to short-circuit fast.
// Returns a BridgeResponse if the request should be rejected or answered
// inline (unknown method, missing permission, bridge.ping).
// Returns null if the request should proceed to WP REST routing.
// ---------------------------------------------------------------------------

export function guardRequest(
  req: BridgeRequest,
  deps: Pick<RequestHandlerDeps, 'manifest' | 'permMap'>,
): BridgeResponse | null {
  const { manifest, permMap } = deps;

  const required = permMap[req.method];
  if (required === undefined) {
    return makeErr(req.id, 'unknown_method', req.method);
  }

  if (required !== null && !manifest.permissions.read.includes(required)) {
    return makeErr(req.id, 'permission_denied', `app does not have "${required}" permission`);
  }

  if (req.method === 'bridge.ping') {
    return makeOk(req.id, { ok: true, bridge_version: 1, server_time: new Date().toISOString() });
  }

  return null;
}

// ---------------------------------------------------------------------------
// Core dispatcher
// ---------------------------------------------------------------------------

export async function handleRequest(
  req: BridgeRequest,
  deps: RequestHandlerDeps,
): Promise<BridgeResponse> {
  const { nonce, apiFetch, manifest } = deps;

  // 1–3. Fast-path checks (unknown method, permission, bridge.ping)
  const early = guardRequest(req, deps);
  if (early !== null) return early;

  // 4. Route to WP REST API
  const headers = { 'X-WP-Nonce': nonce };

  try {
    const result = await routeToWp(req, { apiFetch, headers, manifest });
    return makeOk(req.id, result);
  } catch (err: unknown) {
    // wp.apiFetch has two failure shapes:
    //   1. Default (`parse: true`): rejects with the parsed JSON error body
    //      `{ code, message, data: { status } }`.
    //   2. `parse: false` (used by posts.list/pages.list to read X-WP-Total
    //      headers): rejects with the raw `Response` on non-2xx.
    // Map both to a BridgeError so callers get a consistent code + message.
    let restCode: string | undefined;
    let restMsg: string | undefined;
    let status: number | undefined;
    let body: WpRestErrorBody | undefined;
    if (typeof Response !== 'undefined' && err instanceof Response) {
      status = err.status;
      try {
        body = await err.clone().json() as WpRestErrorBody;
      } catch {
        // body wasn't JSON — fall through to status-based mapping
      }
    } else {
      body = err as WpRestErrorBody;
      if (typeof body?.data?.status === 'number') status = body.data.status;
    }
    if (body) {
      if (typeof body.code === 'string') restCode = body.code;
      if (typeof body.message === 'string') restMsg = body.message;
    }
    // WP normalizes `posts.list` / `pages.list` capability violations on the
    // `status` param (subscriber asking for `status=draft`, etc.) to a 400
    // `rest_invalid_param`. The actual signal is buried in
    // `data.details.status.code === 'rest_forbidden_status'`. Bridge spec
    // requires `permission_denied` for that case — map it here.
    const detailsStatusCode = body?.data?.details?.status?.code;
    if (restCode === 'rest_invalid_param' && detailsStatusCode === 'rest_forbidden_status') {
      restCode = 'permission_denied';
      if (!restMsg) restMsg = 'Status is forbidden.';
    }
    const isKnownBridgeCode = restCode !== undefined &&
      (BRIDGE_ERROR_CODES as readonly string[]).includes(restCode);
    const code: BridgeErrorCode = isKnownBridgeCode
      ? (restCode as BridgeErrorCode)
      : status === 401 ? 'not_authenticated'
      : status === 403 ? 'permission_denied'
      : status === 404 ? 'not_found'
      : status === 413 ? 'payload_too_large'
      : status === 429 ? 'rate_limited'
      : 'internal_error';
    return makeErr(req.id, code, restMsg ?? (status !== undefined ? `HTTP ${status}` : 'request failed'));
  }
}


// ---------------------------------------------------------------------------
// Internal routing — called only by handleRequest
// ---------------------------------------------------------------------------

async function routeToWp(
  req: BridgeRequest,
  ctx: { apiFetch: ApiFetch; headers: Record<string, string>; manifest: RequestHandlerDeps['manifest'] },
): Promise<unknown> {
  const { apiFetch: af, headers, manifest } = ctx;

  switch (req.method) {
    case 'site.info': {
      // The built-in WP REST root index (`/`) doesn't expose admin_email,
      // language, or the date/time formats — call our /dsgo/v1/site-info
      // helper which assembles the spec-required shape server-side. The
      // body is already in bridge shape; pass through unchanged.
      return await af({ path: '/dsgo/v1/site-info', headers });
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
