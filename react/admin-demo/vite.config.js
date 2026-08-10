/// <reference types="vitest" />
import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Vite 設定檔
// - @ 別名指向 src/，讓匯入路徑不會出現 ../../.. 的深層相對路徑。
// - server.proxy 為「真實後端」時的反向代理範例；本專案預設走前端 mock，
//   若日後接真後端，把 VITE_USE_MOCK 設為 false 並在此設定 proxy 即可。
// - test 區塊給 Vitest 用（第 14 章）。Vitest 直接讀這份設定，
//   所以上面的 @ 別名在測試檔裡同樣有效，不必再設定一次。
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
  test: {
    // jsdom：在 Node 裡模擬瀏覽器 DOM，元件才有地方可以 render。
    environment: 'jsdom',
    // globals：讓 describe / it / expect 免 import 就能用（也讓 jest-dom 正確擴充 expect）。
    globals: true,
    // 每個測試檔開跑前先執行的共用設定（載入 jest-dom 斷言、重設全域狀態）。
    setupFiles: './src/test/setup.js',
    // 只把 src 下的 *.test.js(x) 當測試，避免掃到 node_modules。
    include: ['src/**/*.test.{js,jsx}'],
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
