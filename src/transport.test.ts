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

  it('dispatches site.info to apiFetch on success', async () => {
    const apiFetch = vi.fn().mockResolvedValue({
      name: 'My Site',
      description: 'A site',
      url: 'https://example.com',
      email: 'admin@example.com',
      language: 'en-US',
      timezone_string: 'UTC',
      gmt_offset: 0,
      date_format: 'Y-m-d',
      time_format: 'H:i',
    });
    const deps = makeDeps({ apiFetch });
    const res = await handleRequest(req('site.info'), deps);
    expect(apiFetch).toHaveBeenCalled();
    expect(res).toMatchObject({
      type: 'dsgo:response',
      id: 'r1',
      ok: true,
      data: expect.objectContaining({ title: 'My Site' }),
    });
  });
});
