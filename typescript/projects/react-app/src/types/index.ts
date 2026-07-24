// 領域型別（Domain Types）
// 這些介面與姊妹專案（Vue 版）共用完全相同的形狀，方便對照學習。

export interface Geo {
  lat: string
  lng: string
}

export interface Address {
  street: string
  suite: string
  city: string
  zipcode: string
  geo: Geo
}

export interface Company {
  name: string
  catchPhrase: string
  bs: string
}

export interface User {
  id: number
  name: string
  username: string
  email: string
  phone: string
  website: string
  company: Company
  address: Address
}

export interface Post {
  userId: number
  id: number
  title: string
  body: string
}

// API 錯誤統一形狀：攔截器會把 AxiosError 正規化成這個結構
export interface ApiError {
  status: number
  message: string
}

// 型別守衛：確認 catch 到的 unknown 值「真的」是 ApiError 形狀
// （不只檢查欄位存在，還檢查型別，避免誤判 { status: "x", message: 1 } 這種假形狀）
export function isApiError(error: unknown): error is ApiError {
  return (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    'message' in error &&
    typeof (error as Record<string, unknown>).status === 'number' &&
    typeof (error as Record<string, unknown>).message === 'string'
  )
}
