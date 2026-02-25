import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { VitePWA } from 'vite-plugin-pwa'

const appVersion = process.env.npm_package_version || '0.0.0'

export default defineConfig({
  server: {
    allowedHosts: ['.ngrok-free.app', '.ngrok.app', '.ngrok.io'],
  },
  plugins: [
    vue(),
    VitePWA({
      mode: 'development',
      // registerType: 'autoUpdate',
      registerType: 'prompt',
      includeAssets: ['apple-touch-icon.png', 'icons/icon-192.png', 'icons/icon-512.png'],
      manifest: {
        name: 'QR掃碼PWA',
        short_name: 'QR掃碼',
        description: 'Vue3 SPA QR code scanner with offline support',
        theme_color: '#111111',
        background_color: '#000000',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        scope: '/',
        icons: [
          {
            src: '/icons/icon-192.png',
            sizes: '192x192',
            type: 'image/png',
          },
          {
            src: '/icons/icon-512.png',
            sizes: '512x512',
            type: 'image/png',
          },
          {
            src: '/icons/icon-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,webmanifest}'],
      },
      devOptions: {
        enabled: true,
      },
    }),
  ],
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
  },
})
