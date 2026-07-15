import MockAdapter from 'axios-mock-adapter'
import http from '@/services/http'
import { registerAuthMock } from './auth.mock'
import { registerDashboardMock } from './dashboard.mock'
import { registerCourseMock } from './course.mock'
import { registerUserMock } from './user.mock'

// 啟動前端 mock：把 axios-mock-adapter 掛到共用的 http 實例上，
// 再逐一註冊各 domain 的攔截規則。
//
// 只在 VITE_USE_MOCK=true 時由 main.jsx 呼叫；關閉後 http 直接打真實後端，
// 而 services / hooks / pages 完全不需要改動——這是「mock 只存在於邊界」的價值。
export function setupMock() {
  // delayResponse 模擬網路延遲，讓 loading 狀態看得見。
  const mock = new MockAdapter(http, { delayResponse: 450 })

  registerAuthMock(mock)
  registerDashboardMock(mock)
  registerCourseMock(mock)
  registerUserMock(mock)

  // 未被規則命中的請求就照舊送出（本專案不會發生，保底用）。
  mock.onAny().passThrough()

  // eslint-disable-next-line no-console
  console.info('[mock] 前端 Mock 已啟用（axios-mock-adapter）')
  return mock
}
