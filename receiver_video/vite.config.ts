import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  base: './',
  resolve: {
    alias: {
      '@qr-data-bridge/protocol': resolve(__dirname, '../protocol/src/index.ts')
    }
  },
  build: {
    sourcemap: false,
    minify: 'esbuild'
  }
});
