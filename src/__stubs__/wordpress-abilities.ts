/**
 * Stub for @wordpress/abilities — the real package ships as a WP 7.0
 * script module loaded by WordPress Core (not via npm). This stub provides
 * the TypeScript interface so the source compiles; tests mock this module
 * via `vi.mock('@wordpress/abilities', ...)`.
 */

export interface AbilityRegistration {
  name: string;
  label: string;
  description?: string;
  category?: string;
  input_schema?: Record<string, unknown>;
  output_schema?: Record<string, unknown>;
  annotations?: { readonly?: boolean; destructive?: boolean; idempotent?: boolean };
  callback: (input: unknown) => Promise<unknown> | unknown;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function registerAbility(_registration: AbilityRegistration): void {
  // runtime no-op — overridden by WP Core at runtime and mocked in tests
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function unregisterAbility(_name: string): void {
  // runtime no-op
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function executeAbility(_name: string, _input?: unknown): Promise<unknown> {
  return Promise.resolve(null);
}

export interface AbilityCategoryArgs {
  label: string;
  description?: string;
}

export interface AbilityCategory extends AbilityCategoryArgs {
  name: string;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function registerAbilityCategory(_slug: string, _args: AbilityCategoryArgs): void {
  // runtime no-op
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function getAbilityCategory(_name: string): AbilityCategory | undefined {
  return undefined;
}
