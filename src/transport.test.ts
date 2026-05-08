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
