<script setup lang="ts">
import { RouterView } from 'vue-router'
import NavBar from '@/components/NavBar.vue'
</script>

<template>
  <NavBar />
  <main class="content">
    <RouterView />
  </main>
</template>

<style scoped>
.content {
  max-width: 900px;
  margin: 0 auto;
  padding: 1.5rem 1.25rem;
}
</style>
