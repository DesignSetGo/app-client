import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      // @wordpress/abilities ships as a WP 7.0 script module loaded by Core,
      // not via npm. Point to a local stub so TS + Vitest can resolve it;
      // tests override the stub via vi.mock('@wordpress/abilities', ...).
      '@wordpress/abilities': path.resolve(__dirname, 'src/__stubs__/wordpress-abilities.ts'),
    },
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts'],
    coverage: {
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/__stubs__/**'],
    },
  },
});
