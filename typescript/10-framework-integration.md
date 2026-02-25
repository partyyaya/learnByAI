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

// 定義 props 型別
interface Props {
  title: string
  count?: number
}

const props = withDefaults(defineProps<Props>(), {
  count: 0,
})

// 定義 emits 型別
const emit = defineEmits<{
  (e: 'update', value: number): void
  (e: 'close'): void
}>()

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
    <p>Count: {{ doubled }}</p>
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
import type { Ref, ComputedRef, PropType } from 'vue'

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
provide(userKey, currentUser)
const user = inject(userKey) // 型別為 User | undefined

// 模板 ref 型別
const inputRef = ref<HTMLInputElement | null>(null)

// Component ref 型別
import MyComponent from './MyComponent.vue'
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

```typescript
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

const { data, pending, error } = await useFetch<User[]>('/api/users')
// data 的型別自動推斷為 Ref<User[] | null>

const route = useRoute()
// route.params 有完整的型別支援
</script>
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
</script>
```

```typescript
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

```typescript
import type { Metadata } from 'next'

// 頁面 Metadata
export const metadata: Metadata = {
  title: 'My App',
  description: 'A TypeScript Next.js app',
}

// Middleware 型別
import { NextRequest, NextResponse } from 'next/server'
import type { NextMiddleware } from 'next/server'

export const middleware: NextMiddleware = (request: NextRequest) => {
  // 中介層邏輯
  return NextResponse.next()
}

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

### 練習 2：React + TypeScript

建立一個 React + TypeScript 的表單元件，包含：
- 帶型別的 Props
- 使用泛型的自定義 Hook
- Context + useReducer 搭配完整型別

### 練習 3：框架遷移

選擇一個既有的 JavaScript 專案（Vue 或 React），按照本章的遷移步驟將其轉換為 TypeScript。

---

> 下一章：[第十一章 — 裝飾器（Decorators）](./11-decorators.md)
