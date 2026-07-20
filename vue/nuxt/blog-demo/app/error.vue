<script setup>
// 全站錯誤頁（第 3、13 章）。不會套 layout，所以自帶最小樣式。
defineProps({ error: Object })

function goHome() {
  clearError({ redirect: '/' })
}
</script>

<template>
  <div class="error-wrap">
    <h1>{{ error?.statusCode || 500 }}</h1>
    <p>{{ error?.statusMessage || '發生了一點問題' }}</p>
    <button class="btn" @click="goHome">回首頁</button>
  </div>
</template>

<style scoped>
.error-wrap {
  max-width: 420px; margin: 90px auto; text-align: center;
  font-family: -apple-system, "Segoe UI", sans-serif;
}
.error-wrap h1 { font-size: 72px; margin: 0; color: #00dc82; }
.error-wrap p { color: #6b7280; }
.btn {
  margin-top: 12px; padding: 10px 20px; border: none; border-radius: 10px;
  background: #111827; color: #fff; cursor: pointer;
}
</style>
