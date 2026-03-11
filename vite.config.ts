import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@protocol': resolve(__dirname, 'protocol/src')
    }
  }
});
