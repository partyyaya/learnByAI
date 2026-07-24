<script setup lang="ts">
import { RouterLink } from 'vue-router'
import { useFavoritesStore } from '@/stores/favorites'

// 直接使用 store，模板即可讀到即時的收藏數量
const favorites = useFavoritesStore()
</script>

<template>
  <nav class="navbar">
    <div class="brand">使用者與文章瀏覽器</div>
    <div class="links">
      <RouterLink to="/">首頁</RouterLink>
      <RouterLink to="/users">使用者列表</RouterLink>
    </div>
    <div class="favorites">★ 收藏 {{ favorites.count }}</div>
  </nav>
</template>

<style scoped>
.navbar {
  display: flex;
  align-items: center;
  gap: 1.5rem;
  padding: 0.75rem 1.25rem;
  background: #1e293b;
  color: #f8fafc;
}

.brand {
  font-weight: 700;
}

.links {
  display: flex;
  gap: 1rem;
}

.links a {
  color: #cbd5e1;
  text-decoration: none;
}

.links a:hover,
.links a.router-link-active {
  color: #ffffff;
  text-decoration: underline;
}

.favorites {
  margin-left: auto;
  font-size: 0.9rem;
}
</style>
