import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { VitePWA } from 'vite-plugin-pwa';

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
  },
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg'],
      manifest: {
        name: 'QR Data Bridge Sender',
        short_name: 'QDB Sender',
        start_url: './',
        display: 'standalone',
        background_color: '#101826',
        theme_color: '#101826',
        icons: []
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico}']
      }
    })
  ]
});
