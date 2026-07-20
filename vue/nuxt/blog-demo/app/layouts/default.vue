<script setup>
// 前台版面（第 3 章）：頁首導覽 + 登入狀態（第 11 章的 useUserSession）
const { loggedIn, user, clear } = useUserSession()

async function logout() {
  await $fetch('/api/auth/logout', { method: 'POST' })
  await clear()
  await navigateTo('/')
}
</script>

<template>
  <div class="layout">
    <header class="topbar">
      <NuxtLink to="/" class="brand">📝 Nuxt Blog</NuxtLink>
      <nav>
        <NuxtLink to="/">首頁</NuxtLink>
        <NuxtLink v-if="loggedIn" to="/admin">後台</NuxtLink>
      </nav>
      <div class="spacer" />
      <template v-if="loggedIn">
        <span class="user">{{ user.name }}</span>
        <button class="btn link" @click="logout">登出</button>
      </template>
      <NuxtLink v-else to="/login" class="btn link">登入</NuxtLink>
    </header>

    <main class="container">
      <slot />
    </main>

    <footer class="foot">Nuxt 4 全端部落格範例 · 課程第 16 章期末專題</footer>
  </div>
</template>
