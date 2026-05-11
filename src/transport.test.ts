import { describe, expect, it, vi } from 'vitest';
import { handleRequest } from './transport';
import type { RequestHandlerDeps } from './transport';
import type { BridgeRequest } from './shared';

function makeDeps(overrides: Partial<RequestHandlerDeps> = {}): RequestHandlerDeps {
  return {
    manifest: { id: 'app1', permissions: { read: ['posts'], write: [] } },
    permMap: {
      'bridge.ping':    null,
      'site.info':      null,
      'posts.list':     'posts',
      'posts.get':      'posts',
      'pages.list':     null,
      'pages.get':      null,
      'user.current':   'user',
      'user.can':       null,
      'storage.app.get':  null,
      'storage.app.set':  null,
      'storage.user.get': null,
      'storage.user.set': null,
    },
    nonce: 'test-nonce',
    apiFetch: vi.fn().mockResolvedValue({ name: 'Test Site', description: 'desc', url: 'http://example.com' }),
    ...overrides,
  };
}

function req(method: string, params?: unknown): BridgeRequest {
  return { type: 'dsgo:request', id: 'r1', method, params };
}

describe('handleRequest', () => {
  it('rejects unknown methods', async () => {
    const deps = makeDeps();
    const res = await handleRequest(req('no_such_method'), deps);
    expect(res).toMatchObject({
      type: 'dsgo:response',
      id: 'r1',
      ok: false,
      error: expect.objectContaining({ code: 'unknown_method' }),
    });
  });

  it('rejects when permission missing', async () => {
    // 'user.current' requires 'user', which is not in manifest.permissions.read
    const deps = makeDeps();
    const res = await handleRequest(req('user.current'), deps);
    expect(res).toMatchObject({
      type: 'dsgo:response',
      id: 'r1',
      ok: false,
      error: expect.objectContaining({ code: 'permission_denied' }),
    });
  });

  it('passes through known bridge codes from REST error bodies (e.g. payload_too_large)', async () => {
    // Storage::app_set throws StorageError('payload_too_large'); REST emits
    // {code: 'payload_too_large', message: '...'} with HTTP 422. The bridge
    // must propagate that specific code instead of collapsing to internal_error.
    const apiFetch = vi.fn().mockRejectedValue(
      Object.assign(new Error('app storage quota exceeded (300000 > 262144)'), {
        code: 'payload_too_large',
        data: { status: 422 },
      }),
    );
    const deps = makeDeps({ apiFetch });
    const res = await handleRequest(
      req('storage.app.set', { key: 'big', value: 'x'.repeat(300000) }),
      deps,
    );
    expect(res).toMatchObject({
      type: 'dsgo:response',
      id: 'r1',
      ok: false,
      error: expect.objectContaining({ code: 'payload_too_large' }),
    });
  });

  it('falls back to status-based mapping when REST code is not recognized', async () => {
    const apiFetch = vi.fn().mockRejectedValue(
      Object.assign(new Error('forbidden'), {
        code: 'rest_some_unknown_code',
        data: { status: 403 },
      }),
    );
    const deps = makeDeps({ apiFetch });
    const res = await handleRequest(req('site.info'), deps);
    expect(res).toMatchObject({
      ok: false,
      error: expect.objectContaining({ code: 'permission_denied' }),
    });
  });

  it('dispatches site.info to /dsgo/v1/site-info and returns body unchanged', async () => {
    // Server-side endpoint already shapes the response into bridge form;
    // transport just forwards.
    const apiFetch = vi.fn().mockResolvedValue({
      title: 'My Site',
      description: 'A site',
      url: 'https://example.com',
      admin_email: 'admin@example.com',
      language: 'en-US',
      timezone: 'UTC',
      gmt_offset: 0,
      date_format: 'Y-m-d',
      time_format: 'H:i',
    });
    const deps = makeDeps({ apiFetch });
    const res = await handleRequest(req('site.info'), deps);
    expect(apiFetch).toHaveBeenCalledWith(expect.objectContaining({ path: '/dsgo/v1/site-info' }));
    expect(res).toMatchObject({
      type: 'dsgo:response',
      id: 'r1',
      ok: true,
      data: expect.objectContaining({ title: 'My Site', language: 'en-US', admin_email: 'admin@example.com' }),
    });
  });

  it('maps WP rest_invalid_param/rest_forbidden_status (subscriber asking for drafts) to permission_denied', async () => {
    const apiFetch = vi.fn().mockRejectedValue(
      Object.assign(new Error('Invalid parameter(s): status'), {
        code: 'rest_invalid_param',
        message: 'Invalid parameter(s): status',
        data: {
          status: 400,
          details: { status: { code: 'rest_forbidden_status' } },
        },
      }),
    );
    const deps = makeDeps({ apiFetch });
    const res = await handleRequest(req('posts.list', { status: 'draft' }), deps);
    expect(res).toMatchObject({
      ok: false,
      error: expect.objectContaining({ code: 'permission_denied' }),
    });
  });

  it('sends X-DSGo-App-Id on posts.get and shapes through content_styles when present', async () => {
    const apiFetch = vi.fn().mockResolvedValue({
      id: 7,
      slug: 'hello',
      title:   { rendered: 'Hello' },
      content: { rendered: '<p>hi</p>' },
      excerpt: { rendered: 'hi' },
      content_styles: {
        links: ['https://example.com/wp-block-library.css'],
        inline: '/* inline */',
        sources: ['core'],
        budget: { used: 12, cap: 262144 },
      },
    });
    const deps = makeDeps({ apiFetch });
    const res = await handleRequest(req('posts.get', { id: 7 }), deps);
    expect(res.ok).toBe(true);
    expect(apiFetch).toHaveBeenCalledWith(expect.objectContaining({
      path: '/wp/v2/posts/7',
      headers: expect.objectContaining({ 'X-DSGo-App-Id': 'app1' }),
    }));
    expect((res as any).data).toMatchObject({
      id: 7,
      content: '<p>hi</p>',
      content_styles: expect.objectContaining({ sources: ['core'] }),
    });
  });

  it('routes posts.list with type to /wp/v2/<type> and strips type from query', async () => {
    const headers = new Headers({ 'X-WP-Total': '6', 'X-WP-TotalPages': '1' });
    const apiFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify([]), { headers, status: 200 }));
    const deps = makeDeps({ apiFetch });
    const res = await handleRequest(req('posts.list', { type: 'recipe', per_page: 10 }), deps);
    expect(res.ok).toBe(true);
    expect(apiFetch).toHaveBeenCalledWith(expect.objectContaining({
      path: '/wp/v2/recipe?per_page=10',
    }));
  });

  it('routes posts.get with type to /wp/v2/<type>/<id>', async () => {
    const apiFetch = vi.fn().mockResolvedValue({
      id: 42, slug: 'sourdough', title: { rendered: 'Sourdough' }, content: { rendered: '' }, excerpt: { rendered: '' },
    });
    const deps = makeDeps({ apiFetch });
    const res = await handleRequest(req('posts.get', { id: 42, type: 'recipe' }), deps);
    expect(res.ok).toBe(true);
    expect(apiFetch).toHaveBeenCalledWith(expect.objectContaining({
      path: '/wp/v2/recipe/42',
    }));
  });

  it('defaults posts.list with no type to /wp/v2/posts', async () => {
    const headers = new Headers({ 'X-WP-Total': '0', 'X-WP-TotalPages': '0' });
    const apiFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify([]), { headers, status: 200 }));
    const deps = makeDeps({ apiFetch });
    await handleRequest(req('posts.list', { per_page: 5 }), deps);
    expect(apiFetch).toHaveBeenCalledWith(expect.objectContaining({
      path: '/wp/v2/posts?per_page=5',
    }));
  });

  it('shapes posts without content_styles to content_styles: null', async () => {
    const apiFetch = vi.fn().mockResolvedValue({
      id: 8,
      slug: 'no-styles',
      title:   { rendered: 'X' },
      content: { rendered: '<p>x</p>' },
      excerpt: { rendered: '' },
    });
    const deps = makeDeps({ apiFetch });
    const res = await handleRequest(req('posts.get', { id: 8 }), deps);
    expect((res as any).data.content_styles).toBeNull();
  });

  it('handles raw Response thrown by wp.apiFetch parse:false path', async () => {
    const responseLike = new Response(
      JSON.stringify({ code: 'rest_invalid_param', message: 'Bad', data: { status: 400, details: { status: { code: 'rest_forbidden_status' } } } }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
    const apiFetch = vi.fn().mockRejectedValue(responseLike);
    const deps = makeDeps({ apiFetch });
    const res = await handleRequest(req('posts.list', { status: 'private' }), deps);
    expect(res).toMatchObject({
      ok: false,
      error: expect.objectContaining({ code: 'permission_denied' }),
    });
  });
});

describe('transport — abilities methods', () => {
  const baseDeps = {
    manifest: { id: 'sample', permissions: { read: ['abilities', 'ai'] as string[] } },
    permMap: {
      'abilities.list':   'abilities',
      'abilities.invoke': 'abilities',
      'ai.prompt':        'ai',
      'bridge.ping':      null,
    } as Record<string, string | null>,
    nonce: 'NONCE',
  };

  it('routes abilities.list to GET /dsgo/v1/apps/<id>/abilities', async () => {
    const apiFetch = vi.fn(async () => [{
      name: 'yoast/x', label: 'X', description: 'x', category: 'test',
      input_schema: null, output_schema: null, annotations: {},
    }]);
    const req = { type: 'dsgo:request', id: 'r1', method: 'abilities.list' } as const;
    const resp = await handleRequest(req, { ...baseDeps, apiFetch });
    expect(resp.ok).toBe(true);
    expect(apiFetch).toHaveBeenCalledWith(expect.objectContaining({
      path: '/dsgo/v1/apps/sample/abilities',
    }));
  });

  it('routes abilities.invoke to POST /dsgo/v1/apps/<id>/abilities/<name>', async () => {
    const apiFetch = vi.fn(async () => ({ result: 42 }));
    const req = { type: 'dsgo:request', id: 'r2', method: 'abilities.invoke',
      params: { name: 'yoast/x', args: { a: 1 } } } as const;
    const resp = await handleRequest(req, { ...baseDeps, apiFetch });
    expect(resp.ok).toBe(true);
    expect(apiFetch).toHaveBeenCalledWith(expect.objectContaining({
      path: '/dsgo/v1/apps/sample/abilities/yoast/x',
      method: 'POST',
      data: { args: { a: 1 } },
    }));
  });
});

describe('transport — ai.prompt', () => {
  const baseDeps = {
    manifest: { id: 'sample', permissions: { read: ['ai'] as string[] } },
    permMap: { 'ai.prompt': 'ai' } as Record<string, string | null>,
    nonce: 'NONCE',
  };

  it('routes ai.prompt to POST /dsgo/v1/apps/<id>/ai/prompt', async () => {
    const apiFetch = vi.fn(async () => ({
      content: 'hi', usage: { input_tokens: 1, output_tokens: 1 }, tool_calls: [],
    }));
    const req = { type: 'dsgo:request', id: 'r3', method: 'ai.prompt',
      params: { messages: [{ role: 'user', content: 'hi' }] } } as const;
    const resp = await handleRequest(req, { ...baseDeps, apiFetch });
    expect(resp.ok).toBe(true);
    if (resp.ok) {
      expect((resp.data as { content: string }).content).toBe('hi');
    }
    expect(apiFetch).toHaveBeenCalledWith(expect.objectContaining({
      path: '/dsgo/v1/apps/sample/ai/prompt',
      method: 'POST',
    }));
  });
});

describe('transport — media.upload', () => {
  // media.upload has no manifest permission requirement (it's core, opt-out
  // server-side), so the permission map entry is null.
  const baseDeps = {
    manifest: { id: 'sample', permissions: { read: [] as string[] } },
    permMap: { 'media.upload': null } as Record<string, string | null>,
    nonce: 'NONCE',
  };

  it('routes media.upload to POST /dsgo/v1/apps/<id>/media/upload as multipart', async () => {
    const apiFetch = vi.fn(async () => ({
      id: 42,
      url: 'https://example.com/wp-content/uploads/2026/05/foo.png',
      mime_type: 'image/png',
      filename: 'foo.png',
      width: 64,
      height: 64,
      alt_text: 'A red square',
    }));
    const file = new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'image/png' });
    const req = {
      type: 'dsgo:request', id: 'm1', method: 'media.upload',
      params: { file, filename: 'foo.png', alt_text: 'A red square' },
    } as const;
    const resp = await handleRequest(req, { ...baseDeps, apiFetch });
    expect(resp.ok).toBe(true);
    if (resp.ok) {
      expect((resp.data as { id: number }).id).toBe(42);
    }
    const call = apiFetch.mock.calls[0][0] as { path: string; method?: string; body?: BodyInit };
    expect(call.path).toBe('/dsgo/v1/apps/sample/media/upload');
    expect(call.method).toBe('POST');
    expect(call.body).toBeInstanceOf(FormData);
    const fd = call.body as FormData;
    expect(fd.get('filename')).toBe('foo.png');
    expect(fd.get('alt_text')).toBe('A red square');
    expect(fd.get('file')).toBeInstanceOf(Blob);
  });

  it('rejects with invalid_params when "file" is not a Blob', async () => {
    const apiFetch = vi.fn();
    const req = {
      type: 'dsgo:request', id: 'm2', method: 'media.upload',
      params: { file: 'not-a-blob' },
    } as const;
    const resp = await handleRequest(req, { ...baseDeps, apiFetch });
    expect(resp).toMatchObject({
      ok: false,
      error: expect.objectContaining({ code: 'invalid_params' }),
    });
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('falls back to "upload.bin" when no filename is supplied and the Blob has no name', async () => {
    const apiFetch = vi.fn(async () => ({ id: 1, url: 'u', mime_type: 'image/png', filename: 'upload.bin', width: null, height: null, alt_text: '' }));
    const file = new Blob([new Uint8Array([1])], { type: 'image/png' });
    const req = { type: 'dsgo:request', id: 'm3', method: 'media.upload', params: { file } } as const;
    await handleRequest(req, { ...baseDeps, apiFetch });
    const fd = (apiFetch.mock.calls[0][0] as { body: FormData }).body;
    expect(fd.get('filename')).toBe('upload.bin');
  });

  it('maps server payload_too_large back to a typed bridge error', async () => {
    const apiFetch = vi.fn().mockRejectedValue(
      Object.assign(new Error('file exceeds 10485760 bytes (got 20971520)'), {
        code: 'payload_too_large',
        data: { status: 413 },
      }),
    );
    const file = new Blob([new Uint8Array(8)], { type: 'image/png' });
    const req = { type: 'dsgo:request', id: 'm4', method: 'media.upload', params: { file } } as const;
    const resp = await handleRequest(req, { ...baseDeps, apiFetch });
    expect(resp).toMatchObject({
      ok: false,
      error: expect.objectContaining({ code: 'payload_too_large' }),
    });
  });
});

describe('transport — http.fetch', () => {
  // http.fetch's manifest permission lives in permissions.http (not in
  // permissions.read), so the permission map entry is null — the server
  // bridge enforces the allowlist after the request reaches REST.
  const baseDeps = {
    manifest: { id: 'sample', permissions: { read: [] as string[], http: ['api.stripe.com'] } },
    permMap: { 'http.fetch': null } as Record<string, string | null>,
    nonce: 'NONCE',
  };

  it('routes http.fetch to POST /dsgo/v1/apps/<id>/http/fetch with flattened init', async () => {
    const apiFetch = vi.fn(async () => ({
      ok: true, status: 200,
      headers: { 'content-type': 'application/json' },
      body: { id: 'ch_1', amount: 100 },
    }));
    const request = {
      type: 'dsgo:request', id: 'h1', method: 'http.fetch',
      params: {
        url: 'https://api.stripe.com/v1/charges',
        init: { method: 'POST', headers: { Authorization: 'Bearer {{SK}}' }, body: 'amount=100' },
      },
    } as const;
    const resp = await handleRequest(request, { ...baseDeps, apiFetch });
    expect(resp.ok).toBe(true);

    const call = apiFetch.mock.calls[0][0] as { path: string; method?: string; data?: Record<string, unknown> };
    expect(call.path).toBe('/dsgo/v1/apps/sample/http/fetch');
    expect(call.method).toBe('POST');
    // The init object is flattened next to `url` so the REST args[] declaration
    // can validate each field by name.
    expect(call.data).toMatchObject({
      url: 'https://api.stripe.com/v1/charges',
      method: 'POST',
      headers: { Authorization: 'Bearer {{SK}}' },
      body: 'amount=100',
    });
  });

  it('propagates http_rate_limited from the server', async () => {
    const apiFetch = vi.fn().mockRejectedValue(
      Object.assign(new Error('per-app HTTP rate limit exceeded'), {
        code: 'http_rate_limited',
        data: { status: 429, retry_after_seconds: 17 },
      }),
    );
    const request = {
      type: 'dsgo:request', id: 'h2', method: 'http.fetch',
      params: { url: 'https://api.stripe.com/v1/charges', init: {} },
    } as const;
    const resp = await handleRequest(request, { ...baseDeps, apiFetch });
    expect(resp).toMatchObject({
      ok: false,
      error: expect.objectContaining({ code: 'http_rate_limited' }),
    });
  });

  it('propagates http_host_not_allowed when the server rejects the URL', async () => {
    const apiFetch = vi.fn().mockRejectedValue(
      Object.assign(new Error('host "api.notion.com" is not in the manifest allowlist'), {
        code: 'http_host_not_allowed',
        data: { status: 422 },
      }),
    );
    const request = {
      type: 'dsgo:request', id: 'h3', method: 'http.fetch',
      params: { url: 'https://api.notion.com/v1/pages', init: {} },
    } as const;
    const resp = await handleRequest(request, { ...baseDeps, apiFetch });
    expect(resp).toMatchObject({
      ok: false,
      error: expect.objectContaining({ code: 'http_host_not_allowed' }),
    });
  });

  it('forwards minimal init when caller omits everything but the URL', async () => {
    // dsgo.http.fetch(url) — init is undefined; the client passes it through
    // as undefined, the transport flattens `{ url }` with no extra fields.
    const apiFetch = vi.fn(async () => ({ ok: true, status: 200, headers: {}, body: '' }));
    const request = {
      type: 'dsgo:request', id: 'h4', method: 'http.fetch',
      params: { url: 'https://api.stripe.com/v1/balance' },
    } as const;
    await handleRequest(request, { ...baseDeps, apiFetch });
    const call = apiFetch.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(call.data).toEqual({ url: 'https://api.stripe.com/v1/balance' });
  });

  it('rejects a caller-supplied `init.url` override (defense against a buggy wrapper)', async () => {
    // The TS surface forbids `url` inside init, but a non-TS caller (or a
    // wrapper that hasn't been TS-checked) could try to slip one in. The
    // transport flattens with `url` LAST so params.url always wins.
    const apiFetch = vi.fn(async () => ({ ok: true, status: 200, headers: {}, body: '' }));
    const request = {
      type: 'dsgo:request', id: 'h5', method: 'http.fetch',
      params: {
        url: 'https://api.stripe.com/v1/balance',
        // intentionally malicious shape: a "bridge" init with its own URL
        init: { url: 'http://evil.example/private', method: 'POST' },
      },
    } as const;
    await handleRequest(request, { ...baseDeps, apiFetch });
    const call = apiFetch.mock.calls[0][0] as { data: { url: string; method: string } };
    expect(call.data.url).toBe('https://api.stripe.com/v1/balance');
    expect(call.data.method).toBe('POST');
  });
});

describe('transport — help.method', () => {
  const baseDeps = {
    manifest: { id: 'sample', permissions: { read: [] as string[] } },
    permMap: { 'help.method': null } as Record<string, string | null>,
    nonce: 'NONCE',
  };

  it('routes help.method to GET /dsgo/v1/apps/<id>/help/methods/<name>', async () => {
    const apiFetch = vi.fn(async () => ({
      signature: 'dsgo.posts.list(query?: PostsQuery): Promise<{ items: Post[] }>',
      description: 'Paginated list of posts.',
      errors: ['permission_denied', 'invalid_params'],
      examples: ["const { items } = await dsgo.posts.list({ per_page: 20 });"],
    }));
    const request = {
      type: 'dsgo:request', id: 'help1', method: 'help.method',
      params: { name: 'posts.list' },
    } as const;
    const resp = await handleRequest(request, { ...baseDeps, apiFetch });
    expect(resp.ok).toBe(true);
    const call = apiFetch.mock.calls[0][0] as { path: string; method?: string };
    expect(call.path).toBe('/dsgo/v1/apps/sample/help/methods/posts.list');
    // GET — no explicit method should be set (apiFetch defaults to GET).
    expect(call.method).toBeUndefined();
  });

  it('URL-encodes the method name to neutralize path-traversal attempts', async () => {
    // A method name containing `/`, `..`, or other URL-meaningful bytes
    // must not be able to escape the help/methods/<name> path. The
    // registry will still return not_found for the encoded literal, but
    // the request must not reach a sibling REST route by accident.
    const apiFetch = vi.fn(async () => ({ signature: '', description: '', errors: [], examples: [] }));
    const request = {
      type: 'dsgo:request', id: 'help2', method: 'help.method',
      params: { name: '../../wp-admin' },
    } as const;
    await handleRequest(request, { ...baseDeps, apiFetch });
    const call = apiFetch.mock.calls[0][0] as { path: string };
    expect(call.path).toBe('/dsgo/v1/apps/sample/help/methods/..%2F..%2Fwp-admin');
  });

  it('rejects empty name with invalid_params before hitting the server', async () => {
    const apiFetch = vi.fn();
    const request = {
      type: 'dsgo:request', id: 'help3', method: 'help.method',
      params: { name: '' },
    } as const;
    const resp = await handleRequest(request, { ...baseDeps, apiFetch });
    expect(resp).toMatchObject({
      ok: false,
      error: expect.objectContaining({ code: 'invalid_params' }),
    });
    expect(apiFetch).not.toHaveBeenCalled();
  });
});
