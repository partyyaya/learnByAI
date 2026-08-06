import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// 開發時要多開一些洞：Vite 的 HMR 走 WebSocket，React Fast Refresh 會在頁面上
// 注入一段 inline script，Vite dev server 也把 CSS 用 <style> 插進頁面。
const DEV_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self' ws://localhost:5173"
].join("; ");

// 打包後不需要 HMR，也沒有 inline script，所以收緊。
// connect-src 'none'＝這個 App 完全不發網路請求，所有資料都走 IPC 到 main process。
//
// 沒有 frame-ancestors：那個指令只有從 HTTP header 送出才有效，寫在 <meta> 裡會被
// 忽略並在 console 留一行錯誤。要真的擋 iframe 就得改用
// session.defaultSession.webRequest.onHeadersReceived 從 main 端加 header。
const PROD_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'none'",
  // 表單只用 onSubmit + preventDefault 處理，沒有任何一個真的要送到伺服器。
  // 註：<form method="dialog"> 不算導航，所以確認視窗不受影響。
  "form-action 'none'"
].join("; ");

// index.html 裡留一個 <!--CSP--> 註解，建置時換成真正的 meta。
// 這樣「開發」與「打包」可以用兩套政策，而不必為了讓 dev server 跑起來
// 把打包後的安全性也一起放寬。
function injectCsp() {
  return {
    name: "inject-csp",
    transformIndexHtml(html, ctx) {
      const csp = ctx.server ? DEV_CSP : PROD_CSP;
      return html.replace(
        "<!--CSP-->",
        `<meta http-equiv="Content-Security-Policy" content="${csp}" />`
      );
    }
  };
}

export default defineConfig({
  plugins: [react(), injectCsp()],

  // 打包後是用 file:// 載入 index.html，資產路徑必須是相對的，
  // 預設的 "/" 會變成從磁碟根目錄找檔案。
  base: "./",

  build: {
    outDir: "dist-renderer",
    emptyOutDir: true
  },

  server: {
    port: 5173,
    // 換 port 的話 main process 讀到的網址就對不上了，寧可直接失敗
    strictPort: true
  }
});
