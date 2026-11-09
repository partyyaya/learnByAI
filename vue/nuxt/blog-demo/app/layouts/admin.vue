<script setup>
// 後台版面（第 3 章）：和前台不同的外框，標示「管理模式」
const { user, clear } = useUserSession()

async function logout() {
  // clear() 會打模組內建的 DELETE /api/_auth/session 清掉 session cookie，並清空前端狀態
  await clear()
  await navigateTo('/login')
}
</script>

<template>
  <div class="layout">
    <header class="topbar" style="background:#0b3d2e">
      <NuxtLink to="/admin" class="brand">🛠️ 後台管理</NuxtLink>
      <nav>
        <NuxtLink to="/admin">文章管理</NuxtLink>
        <NuxtLink to="/">← 回前台</NuxtLink>
      </nav>
      <div class="spacer" />
      <span class="user">{{ user?.name }}</span>
      <button class="btn link" @click="logout">登出</button>
    </header>

    <main class="container">
      <slot />
    </main>
  </div>
</template>
