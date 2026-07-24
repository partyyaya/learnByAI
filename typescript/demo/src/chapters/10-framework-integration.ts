// @ts-nocheck

/*
 * 第 10 章 前端框架整合(Vue / React / Nuxt / Next.js)
 *
 * 第 10 章示範 Vue / React / Nuxt / Next.js 的 TypeScript 整合。
 * 這些依賴各框架的套件與型別,此 demo 未安裝,故本檔以 @ts-nocheck 作為
 * 閱讀參考,不納入型別檢查;要實際執行請在對應框架專案中使用。
 *
 * 說明:
 * - 保留原文的 import 寫法(vue / react / next 等)。
 * - .vue 檔案取其 <script> 段落照放,<template> 樣板以區塊註解保留。
 * - 含 JSX 標籤的 React 範例因本檔副檔名為 .ts 不支援 JSX,整段改為區塊
 *   註解保留(需置於 .tsx 才能編譯)。
 */

// ===== 10.1 Vue:env.d.ts(讓 TypeScript 認識 .vue 檔案)=====
/// <reference types="vite/client" />

// ===== 10.1 Vue:.vue 使用 <script setup lang="ts">(HelloWorld.vue 的 script 段)=====
import { ref, computed } from 'vue'

// 定義 props 型別
interface Props {
  title: string
  count?: number
}

const props = withDefaults(defineProps<Props>(), {
  count: 0,
})

// 定義 emits 型別（呼叫簽章寫法，Vue 3.0+ 皆可用）
const emit = defineEmits<{
  (e: 'update', value: number): void
  (e: 'close'): void
}>()

// Vue 3.3+ 起可用更簡潔的「型別字面值」寫法（推薦用於新專案）：
// const emit = defineEmits<{
//   update: [value: number]
//   close: []
// }>()

// ref 會自動推斷型別
const message = ref('Hello')         // Ref<string>
const count = ref(0)                  // Ref<number>

// 明確指定 ref 型別
const user = ref<User | null>(null)

// computed 自動推斷
const doubled = computed(() => props.count * 2) // ComputedRef<number>

/* HelloWorld.vue 的 <template>(Vue 樣板,非 TypeScript,僅供參考)
<template>
  <div>
    <h1>{{ props.title }}</h1>
    <p>Count: {{ doubled }}</p>
  </div>
</template>
*/

// ===== 10.1 Vue:常用型別 =====
import type { Ref, ComputedRef, PropType } from 'vue'

// 本節範例共用的 User 型別
interface User {
  id: number
  name: string
  email: string
}

// Ref 型別
const name: Ref<string> = ref('Gary')

// Reactive 物件
import { reactive } from 'vue'

interface State {
  users: User[]
  loading: boolean
  error: string | null
}

const state = reactive<State>({
  users: [],
  loading: false,
  error: null,
})

// Provide / Inject 型別
import type { InjectionKey } from 'vue'

const userKey: InjectionKey<User> = Symbol('user')
const currentUser: User = { id: 1, name: 'Gary', email: 'gary@example.com' }
provide(userKey, currentUser)
const user = inject(userKey) // 型別為 User | undefined

// 模板 ref 型別
const inputRef = ref<HTMLInputElement | null>(null)

// Component ref 型別
import MyComponent from './MyComponent.vue'
const compRef = ref<InstanceType<typeof MyComponent> | null>(null)

// ===== 10.2 React:vite-env.d.ts =====
/// <reference types="vite/client" />

// ===== 10.2 React:元件的 TypeScript 寫法(JSX 範例,置於 .tsx 才能編譯,此處僅供參考)=====
/*
import { useState, useEffect } from 'react'

// Props 介面
interface UserCardProps {
  name: string
  email: string
  avatar?: string
  onEdit?: (id: number) => void
}

// 函式元件
function UserCard({ name, email, avatar, onEdit }: UserCardProps) {
  return (
    <div className="user-card">
      {avatar && <img src={avatar} alt={name} />}
      <h3>{name}</h3>
      <p>{email}</p>
      {onEdit && <button onClick={() => onEdit(1)}>Edit</button>}
    </div>
  )
}

// 帶有 children 的元件
interface LayoutProps {
  children: React.ReactNode
  title: string
}

function Layout({ children, title }: LayoutProps) {
  return (
    <div>
      <header><h1>{title}</h1></header>
      <main>{children}</main>
    </div>
  )
}

// 使用 useState 搭配型別
interface User {
  id: number
  name: string
  email: string
}

function UserList() {
  const [users, setUsers] = useState<User[]>([])
  const [loading, setLoading] = useState(false)        // 自動推斷 boolean
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const fetchUsers = async () => {
      setLoading(true)
      try {
        const res = await fetch('/api/users')
        const data: User[] = await res.json()
        setUsers(data)
      } catch (e) {
        setError((e as Error).message)
      } finally {
        setLoading(false)
      }
    }
    fetchUsers()
  }, [])

  if (loading) return <p>Loading...</p>
  if (error) return <p>Error: {error}</p>

  return (
    <ul>
      {users.map((user) => (
        <li key={user.id}>{user.name}</li>
      ))}
    </ul>
  )
}
*/

// ===== 10.2 React:常用 TypeScript 型別(無 JSX)=====
// 事件型別
const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
  console.log(e.target.value)
}

const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
  e.preventDefault()
}

const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
  console.log('clicked')
}

// Ref 型別
const inputRef = useRef<HTMLInputElement>(null)
const divRef = useRef<HTMLDivElement>(null)

// Context 型別
interface ThemeContext {
  theme: 'light' | 'dark'
  toggleTheme: () => void
}

const ThemeCtx = createContext<ThemeContext | null>(null)

function useTheme(): ThemeContext {
  const ctx = useContext(ThemeCtx)
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider')
  return ctx
}

// Reducer 型別
type Action =
  | { type: 'INCREMENT' }
  | { type: 'DECREMENT' }
  | { type: 'SET'; payload: number }

interface State {
  count: number
}

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'INCREMENT':
      return { count: state.count + 1 }
    case 'DECREMENT':
      return { count: state.count - 1 }
    case 'SET':
      return { count: action.payload }
  }
}

// ===== 10.3 Nuxt:啟用嚴格型別檢查(nuxt.config.ts)=====
export default defineNuxtConfig({
  typescript: {
    strict: true,      // 開啟嚴格模式
    typeCheck: true,    // 在開發時啟用型別檢查(使用 vue-tsc)
  },
})

// ===== 10.3 Nuxt:自動匯入的型別支援(script setup)=====
// Nuxt 3 自動匯入 — 不需要 import
// ref, computed, watch 等來自 Vue
// useRoute, useRouter, useFetch 等來自 Nuxt

const { data, pending, error } = await useFetch<User[]>('/api/users')
// data 的型別自動推斷為 Ref<User[] | null>

const route = useRoute()
// route.params 有完整的型別支援

// ===== 10.3 Nuxt:實戰 pages/users/[id].vue(script setup)=====
// pages/users/[id].vue
interface User {
  id: number
  name: string
  email: string
  role: 'admin' | 'user'
}

// 路由參數型別
const route = useRoute()
const userId = computed(() => Number(route.params.id))

// useFetch 搭配泛型
const { data: user, pending, error } = await useFetch<User>(
  `/api/users/${userId.value}`
)

// Server API 路由
// server/api/users/[id].get.ts
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  // 回傳值自動成為 API 回應型別
  return {
    id: Number(id),
    name: 'Gary',
    email: 'gary@example.com',
    role: 'admin' as const,
  }
})

// ===== 10.3 Nuxt:composables/useAuth.ts =====
// composables/useAuth.ts
interface AuthState {
  user: User | null
  isAuthenticated: boolean
}

export function useAuth() {
  const state = useState<AuthState>('auth', () => ({
    user: null,
    isAuthenticated: false,
  }))

  async function login(email: string, password: string): Promise<boolean> {
    try {
      const user = await $fetch<User>('/api/auth/login', {
        method: 'POST',
        body: { email, password },
      })
      state.value.user = user
      state.value.isAuthenticated = true
      return true
    } catch {
      return false
    }
  }

  function logout(): void {
    state.value.user = null
    state.value.isAuthenticated = false
  }

  return {
    ...toRefs(state.value),
    login,
    logout,
  }
}

// ===== 10.4 Next.js:next-env.d.ts =====
// next-env.d.ts(由 Next.js 自動維護,不要手動修改)
/// <reference types="next" />
/// <reference types="next/image-types/global" />

// ===== 10.4 Next.js:App Router 實戰 — Server Component(JSX 範例,置於 .tsx 才能編譯,此處僅供參考)=====
/*
// src/app/page.tsx — Server Component(預設)
interface User {
  id: number
  name: string
  email: string
}

async function getUsers(): Promise<User[]> {
  const res = await fetch('https://api.example.com/users', {
    cache: 'no-store', // 或 next: { revalidate: 60 }
  })
  if (!res.ok) throw new Error('Failed to fetch')
  return res.json()
}

export default async function UsersPage() {
  const users = await getUsers()

  return (
    <ul>
      {users.map((user) => (
        <li key={user.id}>{user.name} — {user.email}</li>
      ))}
    </ul>
  )
}
*/

// ===== 10.4 Next.js:App Router 實戰 — 動態路由(JSX 範例,置於 .tsx 才能編譯,此處僅供參考)=====
/*
// src/app/users/[id]/page.tsx — 動態路由
interface PageProps {
  params: Promise<{ id: string }>
}

export default async function UserPage({ params }: PageProps) {
  const { id } = await params
  const res = await fetch(`https://api.example.com/users/${id}`)
  const user: User = await res.json()

  return (
    <div>
      <h1>{user.name}</h1>
      <p>{user.email}</p>
    </div>
  )
}

// 產生靜態路徑
export async function generateStaticParams() {
  const users: User[] = await fetch('https://api.example.com/users').then((r) =>
    r.json()
  )
  return users.map((user) => ({ id: String(user.id) }))
}
*/

// ===== 10.4 Next.js:App Router 實戰 — API Route(無 JSX)=====
// src/app/api/users/route.ts — API Route
import { NextRequest, NextResponse } from 'next/server'

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams
  const page = searchParams.get('page') ?? '1'

  const users: User[] = [
    { id: 1, name: 'Gary', email: 'gary@example.com' },
  ]

  return NextResponse.json(users)
}

export async function POST(request: NextRequest) {
  const body = await request.json()
  // 處理建立使用者邏輯
  return NextResponse.json({ id: 1, ...body }, { status: 201 })
}

// ===== 10.4 Next.js:App Router 實戰 — Client Component(JSX 範例,置於 .tsx 才能編譯,此處僅供參考)=====
/*
// src/components/Counter.tsx — Client Component
'use client'

import { useState } from 'react'

interface CounterProps {
  initialCount?: number
}

export default function Counter({ initialCount = 0 }: CounterProps) {
  const [count, setCount] = useState(initialCount)

  return (
    <div>
      <p>Count: {count}</p>
      <button onClick={() => setCount((c) => c + 1)}>+1</button>
    </div>
  )
}
*/

// ===== 10.4 Next.js:常用型別 — Metadata / Middleware(無 JSX)=====
import type { Metadata } from 'next'

// 頁面 Metadata
export const metadata: Metadata = {
  title: 'My App',
  description: 'A TypeScript Next.js app',
}

// Middleware 型別
import type { NextMiddleware } from 'next/server'

export const middleware: NextMiddleware = (request: NextRequest) => {
  // 中介層邏輯
  return NextResponse.next()
}

// ===== 10.4 Next.js:常用型別 — Layout(JSX 範例,置於 .tsx 才能編譯,此處僅供參考)=====
/*
// Layout 型別
interface LayoutProps {
  children: React.ReactNode
}

export default function RootLayout({ children }: LayoutProps) {
  return (
    <html lang="zh-TW">
      <body>{children}</body>
    </html>
  )
}
*/

console.log("第 10 章 前端框架整合 範例載入完成 ✅(參考用,已 @ts-nocheck)");
