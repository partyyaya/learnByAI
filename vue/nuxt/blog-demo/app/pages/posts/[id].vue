<script setup>
// 文章詳情：動態路由（第 2 章）+ 動態 SEO（第 12 章）+ 查無走 404（第 3 章）
definePageMeta({
  validate: (route) => /^\d+$/.test(route.params.id),
})

const route = useRoute()
const { data: post, error } = await useFetch(`/api/posts/${route.params.id}`, {
  key: `post-${route.params.id}`,
})

if (error.value) {
  throw createError({ statusCode: 404, statusMessage: '找不到文章' })
}

// SEO 跟著文章內容變（因為上面已 await，SSR 端就是正確值）
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
      {{ new Date(post.createdAt).toLocaleString('zh-TW') }}
    </p>
    <p style="white-space: pre-wrap; margin-top: 16px">{{ post.content }}</p>
  </article>
</template>
