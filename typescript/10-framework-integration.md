# 第十章：前端框架整合（Vue / React / Nuxt / Next.js）

本章將詳細說明如何在各大前端框架中確認並啟用 TypeScript 支援，涵蓋**新專案建立**與**既有專案遷移**兩種情境。

---

## 10.1 Vue + TypeScript

### 新專案：使用 create-vue 建立

```bash
# 官方推薦方式（Vue 3）
npm create vue@latest

# 互動式選項中選擇：
# ✔ Add TypeScript? Yes
# ✔ Add JSX Support? Yes (optional)
# ✔ Add Vue Router? Yes (optional)
# ✔ Add Pinia? Yes (optional)
```

建立後的專案結構：

```
my-vue-app/
├── src/
│   ├── App.vue
│   ├── main.ts          ← 進入點已經是 .ts
│   ├── components/
│   │   └── HelloWorld.vue
│   └── views/
├── tsconfig.json         ← 自動產生
├── tsconfig.app.json
├── tsconfig.node.json
├── env.d.ts              ← 環境型別宣告
├── vite.config.ts        ← Vite 設定也使用 .ts
└── package.json
```

### 確認 Vue 專案可執行 TypeScript 的檢查清單

**1. 檢查 package.json 依賴**

```json
{
  "devDependencies": {
    "typescript": "~5.6.0",
    "vue-tsc": "^2.0.0",
    "@vitejs/plugin-vue": "^5.0.0",
    "@tsconfig/node20": "^20.1.0",
    "@vue/tsconfig": "^0.7.0"
  }
}
```

> 關鍵依賴：`typescript` 和 `vue-tsc`（Vue 專用的 TypeScript 檢查工具）。

**2. 檢查 tsconfig.json**

```json
{
  "files": [],
  "references": [
    { "path": "./tsconfig.app.json" },
    { "path": "./tsconfig.node.json" }
  ]
}
```

```json
// tsconfig.app.json
{
  "extends": "@vue/tsconfig/tsconfig.dom.json",
  "compilerOptions": {
    "composite": true,
    "baseUrl": ".",
    "paths": {
      "@/*": ["./src/*"]
    }
  },
  "include": ["env.d.ts", "src/**/*", "src/**/*.vue"]
}
```

**3. 確認 env.d.ts 存在**

```typescript
// env.d.ts — 讓 TypeScript 認識 .vue 檔案
/// <reference types="vite/client" />
```

**4. 檢查 .vue 檔案使用 `<script setup lang="ts">`**

```vue
<script setup lang="ts">
import { ref, computed } from 'vue'

interface User {
  id: number
  name: string
  email: string
}

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
</script>

<template>
  <div>
    <h1>{{ props.title }}</h1>
    <p>{{ message }}</p>
    <p>Count: {{ doubled }} / local: {{ count }}</p>
    <p v-if="user">{{ user.name }}</p>
    <button type="button" @click="emit('update', doubled)">Update</button>
    <button type="button" @click="emit('close')">Close</button>
  </div>
</template>
```

### 既有 Vue 專案遷移到 TypeScript

```bash
# 步驟 1：安裝必要依賴
npm install -D typescript vue-tsc @vue/tsconfig

# 步驟 2：建立 tsconfig.json
npx tsc --init

# 步驟 3：建立 env.d.ts
echo '/// <reference types="vite/client" />' > src/env.d.ts
```

```json
// 步驟 4：修改 tsconfig.json
{
  "extends": "@vue/tsconfig/tsconfig.dom.json",
  "compilerOptions": {
    "target": "ES2020",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noEmit": true,
    "baseUrl": ".",
    "paths": {
      "@/*": ["./src/*"]
    }
  },
  "include": ["src/**/*.ts", "src/**/*.tsx", "src/**/*.vue", "src/env.d.ts"]
}
```

```bash
# 步驟 5：逐步將 .js 改為 .ts，.vue 檔案加上 lang="ts"
# 步驟 6：在 package.json 加入型別檢查指令
```

```json
{
  "scripts": {
    "type-check": "vue-tsc --build --force"
  }
}
```

### Vue + TypeScript 常用型別

```typescript
import { ref, computed, reactive, provide, inject } from 'vue'
import type { Ref, ComputedRef, PropType, InjectionKey } from 'vue'
import MyComponent from './MyComponent.vue'

// 本節範例共用的 User 型別
interface User {
  id: number
  name: string
  email: string
}

// Ref 型別
const name: Ref<string> = ref('Gary')

// ComputedRef 型別
const greeting: ComputedRef<string> = computed(() => `Hello, ${name.value}`)

// PropType：runtime props 標註複雜型別（Options API / 物件語法）
// `<script setup>` 更推薦 defineProps<T>()，見上方 SFC 範例
defineProps({
  user: {
    type: Object as PropType<User>,
    required: true,
  },
  role: {
    type: String as PropType<'admin' | 'member'>,
    default: 'member',
  },
})

// Reactive 物件
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
const userKey: InjectionKey<User> = Symbol('user')
const currentUser: User = { id: 1, name: 'Gary', email: 'gary@example.com' }
provide(userKey, currentUser)
const user = inject(userKey) // 型別為 User | undefined

// 模板 ref 型別
const inputRef = ref<HTMLInputElement | null>(null)

// Component ref 型別
const compRef = ref<InstanceType<typeof MyComponent> | null>(null)
```

---

## 10.2 React + TypeScript

### 新專案：使用 Vite 建立

```bash
# 使用 Vite（推薦）
npm create vite@latest my-react-app -- --template react-ts

cd my-react-app
npm install
npm run dev
```

建立後的專案結構：

```
my-react-app/
├── src/
│   ├── App.tsx           ← JSX 使用 .tsx 副檔名
│   ├── main.tsx
│   ├── App.css
│   └── vite-env.d.ts     ← Vite 環境型別
├── tsconfig.json
├── tsconfig.app.json
├── tsconfig.node.json
├── vite.config.ts
└── package.json
```

### 確認 React 專案可執行 TypeScript 的檢查清單

**1. 檢查 package.json 依賴**

```json
{
  "dependencies": {
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  },
  "devDependencies": {
    "typescript": "~5.6.0",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@vitejs/plugin-react": "^4.0.0"
  }
}
```

> 關鍵依賴：`typescript`、`@types/react`、`@types/react-dom`。

> 💡 **React 19 新增**：函式元件現在可以直接把 `ref` 當成一般 prop 傳入與讀取，不需要再用 `forwardRef` 包裝元件。

**2. 檢查 tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noEmit": true,
    "jsx": "react-jsx",
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "isolatedModules": true,
    "skipLibCheck": true,
    "baseUrl": ".",
    "paths": {
      "@/*": ["./src/*"]
    }
  },
  "include": ["src"]
}
```

> 關鍵設定：`"jsx": "react-jsx"` 啟用 React 17+ 的 JSX 轉換。

**3. 確認 .tsx / .ts 副檔名**

- React 元件：使用 `.tsx`
- 工具函式/型別：使用 `.ts`

**4. 檢查 vite-env.d.ts 存在**

```typescript
// vite-env.d.ts
/// <reference types="vite/client" />
```

### React 元件的 TypeScript 寫法

```tsx
import { useState, useEffect, useRef } from 'react'
import type { ReactNode, Ref } from 'react'

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
  children: ReactNode
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

// React 19：ref 是一般 prop，不需要 forwardRef
interface SearchBoxProps {
  placeholder?: string
  ref?: Ref<HTMLInputElement>
}

function SearchBox({ placeholder, ref }: SearchBoxProps) {
  return <input ref={ref} placeholder={placeholder} />
}

function SearchPanel() {
  const inputRef = useRef<HTMLInputElement>(null)
  return <SearchBox ref={inputRef} placeholder="搜尋…" />
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
```

### 既有 React 專案遷移到 TypeScript

```bash
# 步驟 1：安裝依賴
npm install -D typescript @types/react @types/react-dom

# 步驟 2：建立 tsconfig.json
npx tsc --init
```

```json
// 步驟 3：設定 tsconfig.json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noEmit": true,
    "jsx": "react-jsx",
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "isolatedModules": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["src"]
}
```

```bash
# 步驟 4：逐步重新命名檔案
# .js → .ts（非 JSX 檔案）
# .jsx → .tsx（含 JSX 的檔案）

# 步驟 5：加入型別檢查指令
```

```json
{
  "scripts": {
    "type-check": "tsc --noEmit"
  }
}
```

### React 常用 TypeScript 型別

```tsx
import { useRef, createContext, useContext, useReducer } from 'react'
import type { ChangeEvent, FormEvent, MouseEvent } from 'react'

function UserForm() {
  const inputRef = useRef<HTMLInputElement>(null)
  const divRef = useRef<HTMLDivElement>(null)

  const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
    console.log(e.target.value)
  }

  const handleSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
  }

  const handleClick = (e: MouseEvent<HTMLButtonElement>) => {
    console.log('clicked')
  }

  return (
    <div ref={divRef}>
      <form onSubmit={handleSubmit}>
        <input ref={inputRef} onChange={handleChange} />
        <button type="submit" onClick={handleClick}>送出</button>
      </form>
    </div>
  )
}

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

function ThemeToggle() {
  const { theme, toggleTheme } = useTheme()
  return <button onClick={toggleTheme}>目前主題：{theme}</button>
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

function Counter() {
  const [state, dispatch] = useReducer(reducer, { count: 0 })

  return (
    <>
      <button onClick={() => dispatch({ type: 'DECREMENT' })}>-</button>
      <span>{state.count}</span>
      <button onClick={() => dispatch({ type: 'INCREMENT' })}>+</button>
      <button onClick={() => dispatch({ type: 'SET', payload: 0 })}>Reset</button>
    </>
  )
}
```

---

## 10.3 Nuxt + TypeScript

Nuxt 3 **原生內建 TypeScript 支援**，無需額外設定。

### 新專案：使用 nuxi 建立

```bash
# 建立 Nuxt 3 專案（預設就支援 TypeScript）
npx nuxi@latest init my-nuxt-app

cd my-nuxt-app
npm install
npm run dev
```

建立後的專案結構：

```
my-nuxt-app/
├── app.vue
├── nuxt.config.ts        ← 設定檔直接使用 .ts
├── tsconfig.json          ← 自動產生
├── server/
│   └── api/
│       └── hello.ts       ← API 路由也使用 .ts
├── pages/
│   └── index.vue
├── components/
├── composables/
└── package.json
```

### 確認 Nuxt 專案可執行 TypeScript 的檢查清單

**1. 檢查 package.json**

```json
{
  "devDependencies": {
    "nuxt": "^3.15.0",
    "typescript": "^5.6.0",
    "vue-tsc": "^2.0.0"
  }
}
```

> Nuxt 3 自帶 TypeScript 支援，只需要確認有安裝 `typescript` 和 `vue-tsc`。

**2. 檢查 tsconfig.json**

Nuxt 3 會自動產生 `.nuxt/tsconfig.json`，你的根目錄 `tsconfig.json` 只需要繼承它：

```json
{
  "extends": "./.nuxt/tsconfig.json"
}
```

**3. 啟用嚴格的型別檢查（推薦）**

```typescript
// nuxt.config.ts
export default defineNuxtConfig({
  typescript: {
    strict: true,      // 開啟嚴格模式
    typeCheck: true,    // 在開發時啟用型別檢查（使用 vue-tsc）
  },
})
```

**4. 確認自動匯入的型別支援**

```vue
<script setup lang="ts">
// Nuxt 3 自動匯入 — 不需要 import
// ref, computed, watch 等來自 Vue
// useRoute, useRouter, useFetch 等來自 Nuxt

// 本節範例共用的 User 型別
interface User {
  id: number
  name: string
  email: string
}

const { data, pending, error } = await useFetch<User[]>('/api/users')
// data 的型別自動推斷為 Ref<User[] | null>

const route = useRoute()
const router = useRouter()

watch(data, (users) => {
  if (users?.length === 0) {
    router.push('/')
  }
})
</script>

<template>
  <p>目前路徑：{{ route.path }}</p>
  <p v-if="pending">載入中…</p>
  <p v-else-if="error">載入失敗</p>
  <ul v-else>
    <li v-for="u in data" :key="u.id">{{ u.name }}</li>
  </ul>
</template>
```

### Nuxt 3 TypeScript 實戰

```vue
<!-- pages/users/[id].vue -->
<script setup lang="ts">
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
</script>

<template>
  <p v-if="pending">載入中…</p>
  <p v-else-if="error">載入失敗</p>
  <div v-else-if="user">
    <h1>{{ user.name }}</h1>
    <p>{{ user.email }}（{{ user.role }}）</p>
  </div>
</template>
```

```typescript
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
```

```typescript
// composables/useAuth.ts

// 與上面 pages/users/[id].vue 相同的 User 型別，這裡整段複製供本檔案獨立閱讀
interface User {
  id: number
  name: string
  email: string
  role: 'admin' | 'user'
}

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
```

### 型別檢查指令

```json
{
  "scripts": {
    "typecheck": "nuxi typecheck"
  }
}
```

```bash
# 執行型別檢查
npm run typecheck
```

---

## 10.4 Next.js + TypeScript

Next.js 同樣**原生支援 TypeScript**，在建立專案時選擇 TypeScript 即可。

### 新專案：使用 create-next-app 建立

```bash
# 建立 Next.js 專案（預設就包含 TypeScript）
npx create-next-app@latest my-next-app

# 互動式選項：
# ✔ Would you like to use TypeScript? Yes
# ✔ Would you like to use ESLint? Yes
# ✔ Would you like to use Tailwind CSS? Yes (optional)
# ✔ Would you like your code inside a `src/` directory? Yes
# ✔ Would you like to use App Router? Yes
# ✔ Would you like to use Turbopack? Yes (optional)

cd my-next-app
npm run dev
```

建立後的專案結構（App Router）：

```
my-next-app/
├── src/
│   ├── app/
│   │   ├── layout.tsx       ← 使用 .tsx
│   │   ├── page.tsx
│   │   ├── globals.css
│   │   └── api/
│   │       └── hello/
│   │           └── route.ts ← API 路由使用 .ts
│   └── components/
├── tsconfig.json
├── next.config.ts           ← 設定檔使用 .ts
├── next-env.d.ts            ← Next.js 型別宣告
└── package.json
```

### 確認 Next.js 專案可執行 TypeScript 的檢查清單

**1. 檢查 package.json 依賴**

```json
{
  "dependencies": {
    "next": "^15.0.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  },
  "devDependencies": {
    "typescript": "^5.6.0",
    "@types/node": "^22.0.0",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0"
  }
}
```

> 關鍵依賴：`typescript`、`@types/node`、`@types/react`、`@types/react-dom`。

**2. 檢查 tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2017",
    "lib": ["dom", "dom.iterable", "esnext"],
    "allowJs": true,
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "preserve",
    "incremental": true,
    "plugins": [{ "name": "next" }],
    "paths": {
      "@/*": ["./src/*"]
    }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
```

> 關鍵設定：`plugins` 中的 `"next"` 提供 Next.js 專屬的型別支援。

**3. 確認 next-env.d.ts 存在**

```typescript
// next-env.d.ts（由 Next.js 自動維護，不要手動修改）
/// <reference types="next" />
/// <reference types="next/image-types/global" />
```

### Next.js App Router TypeScript 實戰

```tsx
// src/app/page.tsx — Server Component（預設）
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
```

```tsx
// src/app/users/[id]/page.tsx — 動態路由

// 與 src/app/page.tsx 相同的 User 型別，這裡整段複製供本檔案獨立閱讀
interface User {
  id: number
  name: string
  email: string
}

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
```

```tsx
// src/app/api/users/route.ts — API Route
import { NextRequest, NextResponse } from 'next/server'

// 與 src/app/page.tsx 相同的 User 型別，這裡整段複製供本檔案獨立閱讀
interface User {
  id: number
  name: string
  email: string
}

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams
  const page = Number(searchParams.get('page') ?? '1')

  const users: User[] = [
    { id: 1, name: 'Gary', email: 'gary@example.com' },
  ]

  return NextResponse.json({ page, users })
}

export async function POST(request: NextRequest) {
  const body: Omit<User, 'id'> = await request.json()
  const created: User = { id: 1, ...body }
  return NextResponse.json(created, { status: 201 })
}
```

```tsx
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
```

### 既有 Next.js JS 專案遷移到 TypeScript

```bash
# Next.js 會自動偵測並設定 TypeScript
# 步驟 1：建立空的 tsconfig.json
touch tsconfig.json

# 步驟 2：啟動開發伺服器，Next.js 會自動安裝依賴並設定
npm run dev
# Next.js 會提示你安裝 typescript、@types/react 等

# 步驟 3：逐步重新命名
# .js → .ts
# .jsx → .tsx

# 步驟 4：加入型別標註
```

### Next.js 常用型別

```tsx
import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import { NextRequest, NextResponse } from 'next/server'
import type { NextMiddleware } from 'next/server'

// 頁面 Metadata
export const metadata: Metadata = {
  title: 'My App',
  description: 'A TypeScript Next.js app',
}

// Middleware 型別
export const middleware: NextMiddleware = (request: NextRequest) => {
  if (request.nextUrl.pathname.startsWith('/admin')) {
    return NextResponse.redirect(new URL('/login', request.url))
  }
  return NextResponse.next()
}

// Layout 型別
interface LayoutProps {
  children: ReactNode
}

export default function RootLayout({ children }: LayoutProps) {
  return (
    <html lang="zh-TW">
      <body>{children}</body>
    </html>
  )
}
```

---

## 10.5 各框架 TypeScript 設定對照表

| 項目 | Vue | React | Nuxt | Next.js |
|------|-----|-------|------|---------|
| 建立指令 | `npm create vue@latest` | `npm create vite@latest -- --template react-ts` | `npx nuxi init` | `npx create-next-app@latest` |
| 核心依賴 | `typescript`, `vue-tsc` | `typescript`, `@types/react`, `@types/react-dom` | `typescript`, `vue-tsc`（Nuxt 自帶支援） | `typescript`, `@types/node`, `@types/react` |
| 元件副檔名 | `.vue`（加 `lang="ts"`） | `.tsx` | `.vue`（加 `lang="ts"`） | `.tsx` |
| 設定檔 | `tsconfig.json` | `tsconfig.json` | 自動產生（`.nuxt/tsconfig.json`） | 自動偵測產生 |
| 型別檢查指令 | `vue-tsc --build` | `tsc --noEmit` | `nuxi typecheck` | `tsc --noEmit` |
| jsx 設定 | 不需要 | `"jsx": "react-jsx"` | 不需要 | `"jsx": "preserve"` |
| 模組解析 | `"bundler"` | `"bundler"` | 自動設定 | `"bundler"` |
| 原生支援 | 需手動選擇 | 需選擇 ts 模板 | 原生內建 | 原生內建 |

---

## 10.6 共通最佳實踐

### 1. 一律開啟嚴格模式

```json
{
  "compilerOptions": {
    "strict": true
  }
}
```

### 2. 統一型別定義位置

```
src/
├── types/
│   ├── user.ts
│   ├── product.ts
│   ├── api.ts
│   └── index.ts      ← barrel file 統一匯出
```

### 3. 設定 CI/CD 型別檢查

```json
// package.json
{
  "scripts": {
    "type-check": "vue-tsc --build --force",  // Vue / Nuxt
    "type-check": "tsc --noEmit",             // React / Next.js
    "lint": "eslint .",
    "build": "npm run type-check && npm run lint && vite build"
  }
}
```

### 4. 使用 ESLint + TypeScript

```bash
# 安裝 TypeScript ESLint
npm install -D @typescript-eslint/parser @typescript-eslint/eslint-plugin
```

### 5. 善用路徑別名

各框架都支援 `@/` 路徑別名，在 `tsconfig.json` 和打包工具中同時設定：

```json
{
  "compilerOptions": {
    "baseUrl": ".",
    "paths": {
      "@/*": ["./src/*"]
    }
  }
}
```

---

## 練習題

### 練習 1：Vue + TypeScript

建立一個 Vue 3 + TypeScript 的 Todo App，包含：
- 帶型別的 Props 和 Emits
- 使用 `defineProps<T>()` 和 `defineEmits<T>()`
- Pinia store 搭配 TypeScript

<details>
<summary>參考解答</summary>

用 Pinia setup store 管理 `Todo[]` 與衍生的「未完成數量」，子元件 `TodoItem` 用 `defineProps<T>()` 收 todo、用 Vue 3.3+ 型別字面值的 `defineEmits` 對外發出 `toggle`/`remove` 事件，父層再把事件接到 store 的 action。

```typescript
// stores/todos.ts
import { ref, computed } from 'vue'
import { defineStore } from 'pinia'

export interface Todo {
  id: number
  text: string
  done: boolean
}

export const useTodoStore = defineStore('todos', () => {
  const todos = ref<Todo[]>([])
  const remaining = computed(() => todos.value.filter((t) => !t.done).length)

  function add(text: string): void {
    todos.value.push({ id: Date.now(), text, done: false })
  }
  function toggle(id: number): void {
    const todo = todos.value.find((t) => t.id === id)
    if (todo) todo.done = !todo.done
  }
  function remove(id: number): void {
    todos.value = todos.value.filter((t) => t.id !== id)
  }

  return { todos, remaining, add, toggle, remove }
})
```

```vue
<!-- components/TodoItem.vue -->
<script setup lang="ts">
import type { Todo } from '@/stores/todos'

// 帶型別的 props
defineProps<{ todo: Todo }>()

// 帶型別的 emits（Vue 3.3+ 型別字面值簡寫）
const emit = defineEmits<{
  toggle: [id: number]
  remove: [id: number]
}>()
</script>

<template>
  <li>
    <label>
      <input
        type="checkbox"
        :checked="todo.done"
        @change="emit('toggle', todo.id)"
      />
      <span :class="{ done: todo.done }">{{ todo.text }}</span>
    </label>
    <button type="button" @click="emit('remove', todo.id)">刪除</button>
  </li>
</template>
```

```vue
<!-- App.vue -->
<script setup lang="ts">
import { ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useTodoStore } from '@/stores/todos'
import TodoItem from '@/components/TodoItem.vue'

const store = useTodoStore()
const { todos, remaining } = storeToRefs(store) // 保留響應性
const draft = ref('')

function addTodo(): void {
  const text = draft.value.trim()
  if (!text) return
  store.add(text)
  draft.value = ''
}
</script>

<template>
  <section>
    <h1>待辦事項（剩 {{ remaining }} 項）</h1>
    <form @submit.prevent="addTodo">
      <input v-model="draft" placeholder="新增待辦…" />
      <button type="submit">新增</button>
    </form>
    <ul>
      <TodoItem
        v-for="todo in todos"
        :key="todo.id"
        :todo="todo"
        @toggle="store.toggle"
        @remove="store.remove"
      />
    </ul>
  </section>
</template>
```

重點：`storeToRefs` 解構 store 才不會弄丟響應性（action 可以直接解構）；`defineProps`/`defineEmits` 用純型別參數（不傳執行期物件），TypeScript 就能對 props 傳值與事件參數做完整檢查。更完整的版本（含路由與 API）見 [projects/vue-app](./projects/vue-app/)。

</details>

### 練習 2：React + TypeScript

建立一個 React + TypeScript 的表單元件，包含：
- 帶型別的 Props
- 使用泛型的自定義 Hook
- Context + useReducer 搭配完整型別

<details>
<summary>參考解答</summary>

用**可辨識聯合**描述 `useReducer` 的 action，並用映射型別讓每個 `field` 與它的 `value` 型別互相對應；Context 同時提供 `state` 與 `dispatch`；泛型 hook `useField<K>` 綁定單一欄位，讓 `value` 與 `setValue` 的型別都跟著該欄位走。

```tsx
import {
  createContext,
  useContext,
  useReducer,
  type Dispatch,
  type ReactNode,
} from 'react'

interface FormState {
  username: string
  email: string
  age: number
}

// 每個欄位各自產生一個 action 成員，讓 field 與 value 的型別互相對應
type FieldAction = {
  [K in keyof FormState]: { type: 'setField'; field: K; value: FormState[K] }
}[keyof FormState]

type FormAction = FieldAction | { type: 'reset' }

const initialState: FormState = { username: '', email: '', age: 0 }

function reducer(state: FormState, action: FormAction): FormState {
  switch (action.type) {
    case 'setField':
      return { ...state, [action.field]: action.value }
    case 'reset':
      return initialState
  }
}

// Context 同時帶完整型別的 state 與 dispatch
interface FormContextValue {
  state: FormState
  dispatch: Dispatch<FormAction>
}
const FormContext = createContext<FormContextValue | null>(null)

function FormProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState)
  return (
    <FormContext.Provider value={{ state, dispatch }}>
      {children}
    </FormContext.Provider>
  )
}

function useFormContext(): FormContextValue {
  const ctx = useContext(FormContext)
  if (!ctx) throw new Error('useFormContext 必須在 <FormProvider> 內使用')
  return ctx
}

// 泛型自訂 Hook：綁定單一欄位，value 與 setValue 都對應到該欄位型別
function useField<K extends keyof FormState>(
  field: K,
): { value: FormState[K]; setValue: (value: FormState[K]) => void } {
  const { state, dispatch } = useFormContext()
  return {
    value: state[field],
    // 在泛型 K 之下，TS 無法把 field/value 關聯回聯合的某一個成員（相關聯合的已知限制），
    // 這裡斷言為 FieldAction；對外 API（setValue 的參數是 FormState[K]）仍受完整型別檢查
    setValue: (value) =>
      dispatch({ type: 'setField', field, value } as FieldAction),
  }
}

// 帶型別 props 的字串輸入元件
interface TextFieldProps {
  label: string
  field: 'username' | 'email' // 只接受字串欄位
}
function TextField({ label, field }: TextFieldProps) {
  const { value, setValue } = useField(field) // value 推斷為 string
  return (
    <label>
      {label}
      <input value={value} onChange={(e) => setValue(e.target.value)} />
    </label>
  )
}

function AgeField() {
  const { value, setValue } = useField('age') // value 推斷為 number
  return (
    <label>
      年齡
      <input
        type="number"
        value={value}
        onChange={(e) => setValue(Number(e.target.value))}
      />
    </label>
  )
}

// 使用時，所有讀取欄位的元件都要在 Provider 之內
export function SignupForm() {
  return (
    <FormProvider>
      <TextField label="帳號" field="username" />
      <TextField label="Email" field="email" />
      <AgeField />
    </FormProvider>
  )
}
```

重點：用映射型別 `{ [K in keyof FormState]: {...} }[keyof FormState]` 展開成可辨識聯合，是讓 `dispatch({ type:'setField', field, value })` 能檢查「`age` 只能配 `number`」的關鍵；`createContext<FormContextValue | null>(null)` 搭配 `useFormContext` 的 null 檢查，能在漏包 Provider 時立即報錯而不是拿到 `null`。

</details>

### 練習 3：框架遷移

選擇一個既有的 JavaScript 專案（Vue 或 React），按照本章的遷移步驟將其轉換為 TypeScript。

<details>
<summary>參考解答</summary>

遷移的核心心法是**漸進式**：先讓 TypeScript 與 JavaScript 並存、全部能編譯，再一個檔案一個檔案補型別、最後才收緊 `strict`。不要一次把整包改完又同時開最嚴格模式，否則會被成百上千個錯誤淹沒。

**步驟：**

1. **安裝工具鏈**
   ```bash
   # React
   npm install -D typescript @types/react @types/react-dom
   # Vue（改用 vue-tsc 做型別檢查）
   npm install -D typescript vue-tsc
   ```

2. **加入一份「寬鬆起步」的 tsconfig.json**，先允許 JS 與 TS 並存：
   ```json
   {
     "compilerOptions": {
       "target": "ES2020",
       "module": "ESNext",
       "moduleResolution": "bundler",
       "jsx": "react-jsx",
       "allowJs": true,        // 允許 .js 與 .ts 並存，邊遷移邊編譯
       "checkJs": false,       // 先不檢查 .js
       "strict": false,        // 起步先關掉，最後才逐項打開
       "skipLibCheck": true,
       "noEmit": true
     },
     "include": ["src"]
   }
   ```

3. **逐檔改副檔名並補型別**：把 `.js` 改成 `.ts`、含 JSX 的 `.jsx` 改成 `.tsx`，從「葉子」模組（被依賴最少的工具函式、型別定義）開始往上改。每改一個檔就修掉它冒出來的型別錯誤，維持整體可編譯。

4. **補上框架需要的環境宣告**：Vite 專案加 `src/vite-env.d.ts`（React）或 `env.d.ts`（Vue）並寫入 `/// <reference types="vite/client" />`；Vue 還要確認編輯器安裝 Vue 官方外掛（Volar）才認得 `.vue` 檔。

5. **逐步收緊嚴格度**：等大部分檔案都轉成 TS 後，把 `strict` 打開（或先一項項開 `noImplicitAny`、`strictNullChecks`…），再把新冒出的錯誤清乾淨；最後視情況開 `checkJs` 或移除殘留的 `allowJs`。

6. **接上 CI 型別檢查**：在 `package.json` 加 `"type-check": "tsc --noEmit"`（Vue 用 `"vue-tsc --build"`），把它納入 build/CI，之後型別錯誤就不會再溜進主分支。

重點：`allowJs` + 由葉子往上、`strict` 最後才開，是把「大爆炸式重寫」拆成「隨時可編譯的小步驟」的關鍵。完整、已經設定好的成品結構可對照 [projects/vue-app](./projects/vue-app/) 與 [projects/react-app](./projects/react-app/)。

</details>

---

## 延伸：兩個可執行的實戰專案

本章講的是「怎麼在框架裡設定並啟用 TypeScript」。如果想看設定好之後、一個帶有**狀態管理、路由、API 串接**的真實專案長什麼樣，課程另外附了兩個**可實際執行**、功能互相對應的範例專案，方便左右對照同一件事在 Vue 與 React 各怎麼用 TypeScript 寫：

- [projects/vue-app](./projects/vue-app/) — Vue 3 + Pinia + Vue Router + axios
- [projects/react-app](./projects/react-app/) — React 19 + Zustand + React Router + axios

兩者都串接公開的 JSONPlaceholder API，示範型別化的 axios 封裝、store 型別推論、型別化路由參數與泛型 composable/hook。總覽與對照請見 [projects/README.md](./projects/README.md)。

---

> 下一章：[第十一章 — 裝飾器（Decorators）](./11-decorators.md)
