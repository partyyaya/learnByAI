<script setup lang="ts">
import { RouterLink } from 'vue-router'
</script>

<template>
  <section class="home">
    <h1>使用者與文章瀏覽器</h1>
    <p>
      這是一個以 Vue 3 + TypeScript 打造的小型範例應用，資料來自免費的公開 API
      JSONPlaceholder。它示範了在真實專案結構下如何整合：型別化的 axios API
      層、Pinia 狀態管理、Vue Router 路由、型別化的 props/emits，以及可重用的
      composable。
    </p>
    <RouterLink class="cta" to="/users">開始瀏覽使用者 →</RouterLink>
  </section>
</template>

<style scoped>
.home {
  max-width: 640px;
}

.home h1 {
  margin-top: 0;
}

.home p {
  line-height: 1.7;
  color: #334155;
}

.cta {
  display: inline-block;
  margin-top: 1rem;
  padding: 0.6rem 1.2rem;
  background: #2563eb;
  color: #ffffff;
  border-radius: 6px;
  text-decoration: none;
}

.cta:hover {
  background: #1d4ed8;
}
</style>
