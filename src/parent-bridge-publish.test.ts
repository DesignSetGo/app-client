import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@wordpress/abilities', () => ({
  registerAbility: vi.fn(),
  unregisterAbility: vi.fn(),
  executeAbility: vi.fn(),
  registerAbilityCategory: vi.fn(),
  getAbilityCategory: vi.fn().mockReturnValue(undefined),
}));

import { registerAbility, registerAbilityCategory, getAbilityCategory } from '@wordpress/abilities';

const baseConfig = {
  apps: [
    {
      id: 'sample',
      bundle_url: 'http://example.test/wp-content/uploads/designsetgo-apps/sample/index.html',
      permissions: { read: ['posts'], write: [] },
      abilities: [{
        name: 'sample/echo',
        label: 'Echo',
        description: 'Echoes input back',
        category: 'content',
        annotations: {},
        timeout_seconds: 30,
      }],
    },
  ],
  rest_root: 'http://example.test/wp-json/',
  rest_nonce: 'NONCE',
};

function injectConfigIsland(cfg = baseConfig) {
  document.head.querySelectorAll('#dsgo-publisher-config').forEach((n) => n.remove());
  const tag = document.createElement('script');
  tag.id = 'dsgo-publisher-config';
  tag.type = 'application/json';
  tag.textContent = JSON.stringify(cfg);
  document.head.appendChild(tag);
}

function clearBody(): void {
  while (document.body.firstChild) {
    document.body.removeChild(document.body.firstChild);
  }
}

describe('parent-bridge-publish', () => {
  beforeEach(() => {
    vi.resetModules();
    clearBody();
    document.head.querySelectorAll('script[id^="dsgo-"]').forEach((n) => n.remove());
    (registerAbility as any).mockClear();
    (registerAbilityCategory as any).mockClear();
    (getAbilityCategory as any).mockReset();
    (getAbilityCategory as any).mockReturnValue(undefined);
    (window as any).wp = { apiFetch: vi.fn() };
  });

  afterEach(() => {
    clearBody();
  });

  it('registers each ability via @wordpress/abilities at load', async () => {
    injectConfigIsland();
    await import('./parent-bridge-publish');
    expect(registerAbility).toHaveBeenCalledWith(expect.objectContaining({
      name: 'sample/echo',
      label: 'Echo',
      callback: expect.any(Function),
    }));
  });

  it('first executeAbility call creates a hidden iframe', async () => {
    injectConfigIsland();
    await import('./parent-bridge-publish');
    const callArgs = (registerAbility as any).mock.calls[0][0];
    const callback = callArgs.callback as (input: unknown) => Promise<unknown>;

    void callback({ hello: 'world' });
    const iframe = document.querySelector<HTMLIFrameElement>('iframe[data-dsgo-app-id="sample"]');
    expect(iframe).not.toBeNull();
    expect(iframe!.getAttribute('data-dsgo-publisher-host')).toBe('1');
    expect(iframe!.style.position).toBe('absolute');
  });

  it('reuses visible mount when iframe[data-dsgo-app-id] already exists', async () => {
    const existing = document.createElement('iframe');
    existing.setAttribute('data-dsgo-app-id', 'sample');
    existing.setAttribute('data-dsgo-embed-id', 'block-1');
    document.body.appendChild(existing);
    injectConfigIsland();
    await import('./parent-bridge-publish');

    const callArgs = (registerAbility as any).mock.calls[0][0];
    const callback = callArgs.callback as (input: unknown) => Promise<unknown>;
    void callback({ x: 1 });

    const iframes = document.querySelectorAll('iframe[data-dsgo-app-id="sample"]');
    expect(iframes.length).toBe(1);
    expect(iframes[0].getAttribute('data-dsgo-publisher-host')).toBeNull();
  });

  it('no-op when JSON island is missing', async () => {
    await import('./parent-bridge-publish');
    expect(registerAbility).not.toHaveBeenCalled();
  });

  it('no-op when JSON island has no apps', async () => {
    injectConfigIsland({ ...baseConfig, apps: [] });
    await import('./parent-bridge-publish');
    expect(registerAbility).not.toHaveBeenCalled();
  });

  it('registers the dsgo-app category before any ability', async () => {
    injectConfigIsland();
    await import('./parent-bridge-publish');
    expect(registerAbilityCategory).toHaveBeenCalledWith(
      'dsgo-app',
      expect.objectContaining({ label: expect.any(String) }),
    );
    const catCallOrder = (registerAbilityCategory as any).mock.invocationCallOrder[0];
    const abilityCallOrder = (registerAbility as any).mock.invocationCallOrder[0];
    expect(catCallOrder).toBeLessThan(abilityCallOrder);
  });

  it('does not re-register the category when already present', async () => {
    (getAbilityCategory as any).mockReturnValue({ slug: 'dsgo-app', label: 'DesignSetGo Apps' });
    injectConfigIsland();
    await import('./parent-bridge-publish');
    expect(registerAbilityCategory).not.toHaveBeenCalled();
    expect(registerAbility).toHaveBeenCalled();
  });
});
