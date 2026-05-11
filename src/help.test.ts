import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BridgeContext, BridgeMethodHelp } from './shared';

const sampleContext: BridgeContext = {
  bridgeVersion: 1,
  appId: 'sample',
  mode: 'page',
  locale: 'en-US',
  theme: 'light',
  blockProps: null,
  routeParams: {},
  path: '/',
  search: '',
  hash: '',
  mountPrefix: null,
};

function dispatchFromParent(data: unknown) {
  window.dispatchEvent(new MessageEvent('message', {
    data,
    source: window.parent as MessageEventSource,
  }));
}

function findRequest(postSpy: ReturnType<typeof vi.fn>, method: string) {
  const call = postSpy.mock.calls.find(c => {
    const m = c[0];
    return m?.type === 'dsgo:request' && m.method === method;
  });
  if (!call) throw new Error(`no dsgo:request for ${method}`);
  return call[0] as { type: 'dsgo:request'; id: string; method: string; params?: unknown };
}

describe('dsgo.help.method', () => {
  let postMessageSpy: ReturnType<typeof vi.fn>;
  let realParent: Window;

  beforeEach(() => {
    postMessageSpy = vi.fn();
    realParent = window.parent;
    Object.defineProperty(window, 'parent', {
      value: { postMessage: postMessageSpy },
      configurable: true,
      writable: true,
    });
    vi.resetModules();
  });

  afterEach(() => {
    Object.defineProperty(window, 'parent', { value: realParent, configurable: true, writable: true });
  });

  it('round-trips name parameter to the parent and resolves with the registry entry', async () => {
    const { dsgo } = await import('./client');
    dispatchFromParent({ type: 'dsgo:context', payload: sampleContext });
    await dsgo.ready;

    const promise = dsgo.help.method('posts.list');
    await Promise.resolve();

    const sent = findRequest(postMessageSpy, 'help.method');
    expect(sent.params).toEqual({ name: 'posts.list' });

    const fixture: BridgeMethodHelp = {
      signature:   'dsgo.posts.list(opts?: {...}): Promise<Post[]>',
      description: 'List published posts.',
      errors:      ['permission_denied'],
      examples:    ["const posts = await dsgo.posts.list();"],
    };
    dispatchFromParent({ type: 'dsgo:response', id: sent.id, ok: true, data: fixture });

    await expect(promise).resolves.toEqual(fixture);
  });

  it('rejects with not_found when the method name is unknown', async () => {
    const { dsgo, BridgeRequestError } = await import('./client');
    dispatchFromParent({ type: 'dsgo:context', payload: sampleContext });
    await dsgo.ready;

    const promise = dsgo.help.method('frob.nicate');
    await Promise.resolve();

    const sent = findRequest(postMessageSpy, 'help.method');
    dispatchFromParent({
      type: 'dsgo:response',
      id: sent.id,
      ok: false,
      error: { code: 'not_found', message: 'Unknown bridge method: frob.nicate' },
    });

    await expect(promise).rejects.toBeInstanceOf(BridgeRequestError);
    await expect(promise).rejects.toHaveProperty('code', 'not_found');
  });
});
