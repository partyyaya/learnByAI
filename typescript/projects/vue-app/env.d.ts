/// <reference types="vite/client" />

// 為 import.meta.env 補上型別，讓 VITE_API_BASE_URL 有型別提示。
// 標成可選（?）才誠實：沒有建立 .env(.local) 檔案時這個變數就不存在，
// api/client.ts 也確實是用 `?? fallback` 處理「沒設定」的情況。
interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
