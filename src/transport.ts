/**
 * transport.ts — transport-agnostic request dispatcher.
 *
 * Both the iframe transport (parent-bridge.ts) and the upcoming inline
 * transport (Task 13) can call `handleRequest` with their own apiFetch
 * instance and globals, keeping all method-routing logic in one place.
 */

import type { BridgeRequest, BridgeResponse, BridgeErrorCode } from './shared';
import { BRIDGE_ERROR_CODES, BridgeRequestError } from './shared';

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

/**
 * Narrow a WP-REST rejection (which arrives as `unknown` — it could be the
 * parsed JSON error body, a thrown `Response`, or anything else) to the
 * `{ data: { status } }` shape used by the per-method 401 fallbacks below.
 */
function restStatusOf(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const data = (err as { data?: unknown }).data;
  if (!data || typeof data !== 'object') return undefined;
  const status = (data as { status?: unknown }).status;
  return typeof status === 'number' ? status : undefined;
}

/** Read a single property off an untrusted REST object without `any`. */
function pick(obj: unknown, key: string): unknown {
  if (!obj || typeof obj !== 'object') return undefined;
  return (obj as Record<string, unknown>)[key];
}

export type ApiFetch = (opts: {
  path: string;
  method?: string;
  data?: unknown;
  /**
   * Raw request body (e.g. `FormData` for multipart uploads). When set,
   * `wp.apiFetch` forwards it untouched and lets the browser populate the
   * `Content-Type` boundary header. Mutually exclusive with `data`, which
   * would JSON-stringify and clobber the multipart framing.
   */
  body?: BodyInit;
  headers?: Record<string, string>;
  parse?: boolean;
}) => Promise<unknown>;

export interface RequestHandlerDeps {
  manifest: { id: string; permissions: { read: string[] } };
  permMap: Record<string, string | null>;
  nonce: string;
  /**
   * Per-(user, app) nonce minted at bootstrap. Sent on storage calls in the
   * `X-DSGo-App-Nonce` header so the server can confirm the call came from
   * this app's bootstrap, not from another app forging a fetch. Optional for
   * backward-compat with bootstrap chains that haven't been rebuilt; storage
   * calls without it 403 at the server.
   */
  appNonce?: string;
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

function shapePost(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw;
  const r = raw as Record<string, unknown>;
  const title = r.title as { rendered?: unknown } | undefined;
  const excerpt = r.excerpt as { rendered?: unknown; protected?: unknown } | undefined;
  const content = r.content as { rendered?: unknown; protected?: unknown } | undefined;
  return {
    id:                 r.id,
    slug:               r.slug,
    title:              title?.rendered ?? '',
    excerpt:            excerpt?.rendered ?? '',
    content:            content?.rendered ?? '',
    // Sibling field; only present when the manifest opts in via
    // `content.blockStyles` / `content.themeStyles`. See class-block-styles.php.
    content_styles:     r.content_styles ?? null,
    status:             r.status,
    protected:          content?.protected ?? excerpt?.protected ?? false,
    date:               r.date_gmt ? String(r.date_gmt) + 'Z' : r.date,
    modified:           r.modified_gmt ? String(r.modified_gmt) + 'Z' : r.modified,
    author:             r.author,
    link:               r.link,
    featured_media_url: null,
    categories:         r.categories ?? [],
    tags:               r.tags ?? [],
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
    return {
      type: 'dsgo:response',
      id:   req.id,
      ok:   false,
      error: {
        code:    'permission_denied',
        message: `app does not have "${required}" permission`,
        // Distinguish manifest-level denials (the app never declared this
        // permission) from runtime denials (server-side abilities/commerce
        // policy refused this visitor). Internal probes like the commerce
        // surface's abilities-first lookup use this to fall back to REST
        // when the manifest doesn't grant `abilities`, instead of failing
        // a call the developer thought only needed `commerce`.
        details: { reason: 'manifest_permission_missing', permission: required },
      },
    };
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
  const { nonce, apiFetch, manifest, appNonce } = deps;

  // 1–3. Fast-path checks (unknown method, permission, bridge.ping)
  const early = guardRequest(req, deps);
  if (early !== null) return early;

  // 4. Route to WP REST API
  // Storage routes carry the per-(user, app) nonce so the server can confirm
  // this call came from our app's bootstrap, not from another app forging a
  // direct fetch. See RestApi::permit_storage.
  const headers: Record<string, string> = { 'X-WP-Nonce': nonce };
  if (req.method.startsWith('storage.') && appNonce) {
    headers['X-DSGo-App-Nonce'] = appNonce;
  }
  // posts/pages calls hit `/wp/v2/...` directly; the server-side
  // `rest_prepare_post`/`rest_prepare_page` filter reads this header to
  // resolve the calling app's manifest and attach `content_styles` when the
  // app has opted in via `content.blockStyles`/`content.themeStyles`. Sent
  // unconditionally — the server no-ops cleanly when the manifest opts out.
  if (req.method.startsWith('posts.') || req.method.startsWith('pages.')) {
    headers['X-DSGo-App-Id'] = manifest.id;
  }
  // Suppress the parent's apiFetch JSON content-type middleware — the
  // browser will set `multipart/form-data; boundary=...` itself when we
  // pass FormData as the request body. Setting it manually here would
  // strip the boundary parameter and break parsing on the PHP side.

  try {
    const result = await routeToWp(req, { apiFetch, headers, manifest });
    return makeOk(req.id, result);
  } catch (err: unknown) {
    // `routeToWp` itself only ever throws `BridgeRequestError` — a structured
    // error we can map straight through without reverse-engineering a shape.
    if (err instanceof BridgeRequestError) {
      return makeErr(req.id, err.code, err.message);
    }
    // Everything else came out of `wp.apiFetch`, which has two failure shapes:
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
    case 'help.method': {
      // Always-available bridge method docs lookup. No permission gate.
      // The model uses this to discover method signatures without the
      // harness having to enumerate every method in the system prompt.
      const { name } = (req.params ?? {}) as { name?: string };
      if (typeof name !== 'string' || name === '') {
        throw new BridgeRequestError({ code: 'invalid_params', message: 'name is required' });
      }
      return await af({ path: `/dsgo/v1/apps/${manifest.id}/help/methods/${encodeURIComponent(name)}`, headers });
    }
    case 'site.info': {
      // The built-in WP REST root index (`/`) doesn't expose admin_email,
      // language, or the date/time formats — call our /dsgo/v1/site-info
      // helper which assembles the spec-required shape server-side. The
      // body is already in bridge shape; pass through unchanged.
      return await af({ path: '/dsgo/v1/site-info', headers });
    }
    case 'posts.list': {
      const q = { ...(req.params ?? {}) } as Record<string, unknown>;
      // Optional `type` routes to a CPT's REST endpoint (`/wp/v2/<type>`).
      // Public, show_in_rest post types are readable; the server enforces
      // visibility and capability the same way it does for the default
      // `posts` route. Defaults to `posts` when omitted.
      const type = typeof q.type === 'string' && q.type ? q.type : 'posts';
      delete q.type;
      const resp = await af({ path: `/wp/v2/${type}?` + new URLSearchParams(q as Record<string, string>).toString(), headers, parse: false }) as Response;
      const rawItems = await resp.json();
      return {
        items:       Array.isArray(rawItems) ? rawItems.map(shapePost) : [],
        total:       parseInt(resp.headers.get('X-WP-Total') ?? '0', 10),
        total_pages: parseInt(resp.headers.get('X-WP-TotalPages') ?? '0', 10),
      };
    }
    case 'posts.get': {
      const { id, type } = req.params as { id: number; type?: string };
      const route = typeof type === 'string' && type ? type : 'posts';
      return shapePost(await af({ path: `/wp/v2/${route}/${id}`, headers }));
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
        const raw = await af({ path: '/wp/v2/users/me?context=edit', headers });
        const r = (raw ?? {}) as Record<string, unknown>;
        const avatars = (r.avatar_urls ?? {}) as Record<string, unknown>;
        return {
          id:         r.id,
          name:       r.name,
          slug:       r.slug,
          email:      r.email ?? '',
          avatar_url: avatars['96'] ?? avatars['48'] ?? avatars['24'] ?? '',
          roles:      r.roles ?? [],
        };
      } catch (err: unknown) {
        if (restStatusOf(err) === 401) return null;
        throw err;
      }
    }
    case 'user.can': {
      const { cap } = req.params as { cap: string };
      try {
        const r = await af({ path: '/dsgo/v1/can?cap=' + encodeURIComponent(cap), headers });
        return pick(r, 'can');
      } catch (err: unknown) {
        if (restStatusOf(err) === 401) return false;
        throw err;
      }
    }
    case 'storage.app.get': {
      const { key } = req.params as { key: string };
      const r = await af({ path: `/dsgo/v1/apps/${manifest.id}/storage/app/${encodeURIComponent(key)}`, headers });
      return pick(r, 'value');
    }
    case 'storage.app.set': {
      const { key, value } = req.params as { key: string; value: unknown };
      await af({ path: `/dsgo/v1/apps/${manifest.id}/storage/app/${encodeURIComponent(key)}`, method: 'PUT', data: { value }, headers });
      return null;
    }
    case 'storage.user.get': {
      const { key } = req.params as { key: string };
      const r = await af({ path: `/dsgo/v1/apps/${manifest.id}/storage/user/${encodeURIComponent(key)}`, headers });
      return pick(r, 'value');
    }
    case 'storage.user.set': {
      const { key, value } = req.params as { key: string; value: unknown };
      await af({ path: `/dsgo/v1/apps/${manifest.id}/storage/user/${encodeURIComponent(key)}`, method: 'PUT', data: { value }, headers });
      return null;
    }
    case 'abilities.list': {
      return await af({ path: `/dsgo/v1/apps/${manifest.id}/abilities`, headers });
    }
    case 'abilities.invoke': {
      const { name, args } = (req.params ?? {}) as { name: string; args?: Record<string, unknown> };
      // The ability name slug contains "/" — leave it un-encoded so the route
      // regex (/abilities/<ns>/<name>) matches.
      return await af({
        path: `/dsgo/v1/apps/${manifest.id}/abilities/${name}`,
        method: 'POST',
        data: args !== undefined ? { args } : {},
        headers,
      });
    }
    case 'ai.prompt': {
      const params = (req.params ?? {}) as Record<string, unknown>;
      return await af({
        path: `/dsgo/v1/apps/${manifest.id}/ai/prompt`,
        method: 'POST',
        data: params,
        headers,
      });
    }
    case 'email.send': {
      const params = (req.params ?? {}) as Record<string, unknown>;
      return await af({
        path: `/dsgo/v1/apps/${manifest.id}/email/send`,
        method: 'POST',
        data: params,
        headers,
      });
    }
    case 'media.upload': {
      const params = (req.params ?? {}) as { file?: unknown; filename?: unknown; alt_text?: unknown };
      // Accept Blob (the canonical case — SVG, Canvas.toBlob, fetch().blob())
      // and File (which extends Blob, so the runtime check covers it).
      if (typeof Blob === 'undefined' || !(params.file instanceof Blob)) {
        throw new BridgeRequestError({ code: 'invalid_params', message: '"file" must be a Blob or File' });
      }
      const filename = typeof params.filename === 'string' && params.filename !== ''
        ? params.filename
        : (params.file as File).name || 'upload.bin';
      const formData = new FormData();
      formData.append('file', params.file, filename);
      formData.append('filename', filename);
      if (typeof params.alt_text === 'string' && params.alt_text !== '') {
        formData.append('alt_text', params.alt_text);
      }
      return await af({
        path: `/dsgo/v1/apps/${manifest.id}/media/upload`,
        method: 'POST',
        body: formData,
        headers,
      });
    }
    case 'http.fetch': {
      // The client wrapper passes { url, init } in params; flatten to a
      // single payload so the REST args declaration matches (url at top
      // level, with method/headers/body/timeout_ms siblings). URL goes
      // LAST so a caller-supplied `init.url` cannot override params.url —
      // belt-and-suspenders against a wrapper that hasn't been TS-checked.
      const params = (req.params ?? {}) as { url?: unknown; init?: Record<string, unknown> };
      const init   = (params.init ?? {}) as Record<string, unknown>;
      return await af({
        path: `/dsgo/v1/apps/${manifest.id}/http/fetch`,
        method: 'POST',
        data: { ...init, url: params.url },
        headers,
      });
    }
    // Commerce — route every commerce.* method through the single dispatcher.
    // Method "commerce.<group>.<verb>" maps to "/commerce/<group>/<verb>"
    // (verb's underscores translate to hyphens for URL hygiene).
    case 'commerce.products.list':
    case 'commerce.products.get':
    case 'commerce.cart.get':
    case 'commerce.cart.add_item':
    case 'commerce.cart.update_item':
    case 'commerce.cart.remove_item':
    case 'commerce.checkout.open_hosted_page': {
      const tail = req.method.slice('commerce.'.length).replace(/\./g, '/').replace(/_/g, '-');
      const params = (req.params ?? {}) as Record<string, unknown>;
      return await af({
        path: `/dsgo/v1/apps/${manifest.id}/commerce/${tail}`,
        method: 'POST',
        data: { params },
        headers,
      });
    }
    default:
      // Unreachable in practice — `guardRequest` rejects unknown methods with
      // `unknown_method` before routing — but keep it a structured error so
      // every throw out of this function has the same shape.
      throw new BridgeRequestError({ code: 'unknown_method', message: req.method });
  }
}
