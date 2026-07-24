// 領域型別（DTO）：與後端 JSONPlaceholder 回傳的資料結構對齊。
// 注意：同一組型別也用於平行開發的 React 專案，請保持形狀一致。

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

// 統一的錯誤形狀：由 axios 攔截器把任何錯誤正規化成這個結構
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
