<script setup lang="ts">
import { RouterLink } from 'vue-router'
</script>

<template>
  <section class="not-found">
    <h1>404</h1>
    <p>找不到這個頁面。</p>
    <RouterLink to="/">回首頁</RouterLink>
  </section>
</template>

<style scoped>
.not-found {
  text-align: center;
  padding: 3rem 1rem;
}

.not-found h1 {
  font-size: 3rem;
  margin: 0 0 0.5rem;
  color: #94a3b8;
}

.not-found p {
  margin: 0 0 1rem;
  color: #64748b;
}
</style>
