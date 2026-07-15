import React from 'react'
import ReactDOM from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ReactQueryDevtools } from '@tanstack/react-query-devtools'
import { BrowserRouter } from 'react-router-dom'
import App from './App'

import './styles/base.css'
import './styles/layout.css'
import './styles/components.css'

// QueryClient 全域預設（第 09 章）：重試、staleTime、視窗聚焦不重抓。
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 30_000,
      refetchOnWindowFocus: false,
    },
  },
})

// 進入點：先啟動 mock（若開啟），再組裝三個 Provider 後掛載。
// 用 async bootstrap 包起來，確保 mock 在任何請求之前完成，且不使用 top-level await。
async function bootstrap() {
  if (import.meta.env.VITE_USE_MOCK === 'true') {
    const { setupMock } = await import('./mock')
    setupMock()
  }

  ReactDOM.createRoot(document.getElementById('root')).render(
    <React.StrictMode>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <App />
        </BrowserRouter>
        <ReactQueryDevtools initialIsOpen={false} />
      </QueryClientProvider>
    </React.StrictMode>
  )
}

bootstrap()
