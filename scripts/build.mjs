import { build } from 'esbuild';

await build({
  entryPoints: ['src/gateway/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  outfile: 'dist/gateway.js',
  packages: 'external',
  sourcemap: true,
  logLevel: 'info',
});
