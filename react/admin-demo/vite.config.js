import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Vite 設定檔
// - @ 別名指向 src/，讓匯入路徑不會出現 ../../.. 的深層相對路徑。
// - server.proxy 為「真實後端」時的反向代理範例；本專案預設走前端 mock，
//   若日後接真後端，把 VITE_USE_MOCK 設為 false 並在此設定 proxy 即可。
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      // 範例：接真後端時，讓 /api 轉發到後端網域，避免 CORS。
      // '/api': {
      //   target: 'http://your-backend-domain.com',
      //   changeOrigin: true,
      // },
    },
  },
  build: {
    outDir: 'dist',
    rollupOptions: {
      output: {
        // 快取友善：把變動較少的第三方套件拆成獨立 chunk。
        manualChunks: {
          react: ['react', 'react-dom', 'react-router-dom'],
          query: ['@tanstack/react-query'],
        },
      },
    },
  },
})
