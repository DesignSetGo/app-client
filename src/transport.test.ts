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
