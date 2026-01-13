import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    preact(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.png', 'apple-touch-icon.png', 'dove.svg'],
      manifest: {
        name: 'Zajel - Secure Messaging',
        short_name: 'Zajel',
        description: 'End-to-end encrypted peer-to-peer messaging and file transfer',
        theme_color: '#4a90d9',
        background_color: '#1a1a2e',
        display: 'standalone',
        orientation: 'portrait-primary',
        start_url: '/',
        scope: '/',
        icons: [
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'pwa-maskable-192x192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
          { src: 'pwa-maskable-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
        ]
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff,woff2}'],
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/.*\.(?:png|jpg|jpeg|svg|gif|webp)$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'images-cache',
              expiration: { maxEntries: 50, maxAgeSeconds: 30 * 24 * 60 * 60 }
            }
          }
        ]
      },
      devOptions: { enabled: false }
    })
  ],
  root: 'src',
  publicDir: 'public',
  build: {
    outDir: '../dist',
    emptyDirFirst: true,
  },
  server: {
    port: 3847,
    host: '127.0.0.1',
  },
  preview: {
    port: 3847,
    host: '127.0.0.1',
  },
});
