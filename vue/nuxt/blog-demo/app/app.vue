<script setup>
// App 根元件（第 1、3 章）。用 NuxtLayout 包 NuxtPage，並設全站標題模板（第 12 章）。
useHead({
  titleTemplate: (title) => (title ? `${title}｜Nuxt Blog` : 'Nuxt Blog'),
})
</script>

<template>
  <div>
    <!-- 切頁時上方的載入進度條 -->
    <NuxtLoadingIndicator color="#00dc82" />
    <NuxtLayout>
      <NuxtPage />
    </NuxtLayout>
  </div>
</template>
