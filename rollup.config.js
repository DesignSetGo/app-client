import typescript from '@rollup/plugin-typescript';
import dts from 'rollup-plugin-dts';

// Plugin runtime bundles ship inside the free plugin at dsgo-apps/assets/.
// They are loaded via plugins_url('assets/<file>.js', DSGO_APPS_FILE) so the
// rollup output path must match the on-disk plugin directory.
const PLUGIN_ASSETS = '../dsgo-apps/assets';

export default [
  // IIFE: bridge-client.js auto-injected into apps' iframes
  {
    input: 'src/client.ts',
    output: {
      file: `${PLUGIN_ASSETS}/bridge-client.js`,
      format: 'iife',
      name: 'DSGoAppClient',
      sourcemap: true,
    },
    plugins: [typescript({ tsconfig: './tsconfig.json', outDir: PLUGIN_ASSETS, declaration: false, declarationMap: false })],
  },
  // IIFE: parent-bridge.js loaded on the iframe-loader page
  {
    input: 'src/parent-bridge.ts',
    output: {
      file: `${PLUGIN_ASSETS}/parent-bridge.js`,
      format: 'iife',
      name: 'DSGoParentBridge',
      sourcemap: true,
    },
    plugins: [typescript({ tsconfig: './tsconfig.json', outDir: PLUGIN_ASSETS, declaration: false, declarationMap: false })],
  },
  // IIFE: bridge-client-inline.js auto-injected into inline-mode apps
  {
    input: 'src/client.ts',
    output: {
      file: `${PLUGIN_ASSETS}/bridge-client-inline.js`,
      format: 'iife',
      name: 'DSGoAppClient',
      sourcemap: true,
    },
    plugins: [typescript({ tsconfig: './tsconfig.json', outDir: PLUGIN_ASSETS, declaration: false, declarationMap: false })],
  },
  // IIFE: parent-bridge-inline.js loaded for inline-mode apps
  {
    input: 'src/parent-bridge-inline.entry.ts',
    output: {
      file: `${PLUGIN_ASSETS}/parent-bridge-inline.js`,
      format: 'iife',
      name: 'DSGoParentBridgeInline',
      sourcemap: true,
    },
    plugins: [typescript({ tsconfig: './tsconfig.json', outDir: PLUGIN_ASSETS, declaration: false, declarationMap: false })],
  },
  // ES module: parent-bridge-publish.js for wp-admin (imports @wordpress/abilities)
  {
    input: 'src/parent-bridge-publish.ts',
    output: {
      file: `${PLUGIN_ASSETS}/parent-bridge-publish.js`,
      format: 'es',
      sourcemap: true,
    },
    external: ['@wordpress/abilities'],
    plugins: [typescript({ tsconfig: './tsconfig.json', outDir: PLUGIN_ASSETS, declaration: false, declarationMap: false })],
  },
  // ESM npm output
  {
    input: 'src/client.ts',
    output: [
      { file: 'dist/client.mjs', format: 'es', sourcemap: true },
      { file: 'dist/client.cjs', format: 'cjs', sourcemap: true, exports: 'named' },
    ],
    plugins: [typescript({ tsconfig: './tsconfig.json', declaration: true, declarationDir: 'dist', rootDir: 'src' })],
  },
  // Type declarations bundle
  {
    input: 'src/client.ts',
    output: { file: 'dist/client.d.ts', format: 'es' },
    plugins: [dts()],
  },
];
