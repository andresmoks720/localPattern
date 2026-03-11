import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  base: './',
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
