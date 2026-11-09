<script setup>
// 文章詳情：動態路由（第 2 章）+ 動態 SEO（第 12 章）+ 查無走 404（第 3 章）
definePageMeta({
  validate: (route) => /^\d+$/.test(route.params.id),
})

const route = useRoute()
const { data: post, error } = await useFetch(`/api/posts/${route.params.id}`, {
  key: `post-${route.params.id}`,
})

// fatal: true → 首次載入與站內切頁都會顯示 error.vue
if (error.value) {
  throw createError({ status: 404, message: '找不到文章', fatal: true })
}

// SEO 跟著文章內容變（SSR 會等 useFetch 抓完，所以 server 端就是正確值）
useSeoMeta({
  title: () => post.value?.title,
  description: () => post.value?.content?.slice(0, 80),
  ogTitle: () => post.value?.title,
  ogDescription: () => post.value?.content?.slice(0, 80),
  ogType: 'article',
})
</script>

<template>
  <article v-if="post">
    <p><NuxtLink to="/" class="back">← 回首頁</NuxtLink></p>
    <h1>{{ post.title }}</h1>
    <p class="meta muted">
      作者：{{ post.author?.name || '站長' }} ·
      {{ new Date(post.createdAt).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' }) }}
    </p>
    <p style="white-space: pre-wrap; margin-top: 16px">{{ post.content }}</p>
  </article>
</template>
