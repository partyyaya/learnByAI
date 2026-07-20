<script setup>
// 首頁（前台）：SSR 抓已發佈文章（第 6 章）+ SEO meta（第 12 章）
useSeoMeta({
  title: '首頁',
  description: '用 Nuxt 4 打造的全端部落格範例：檔案式路由、SSR、Nitro API、Prisma、認證與 SEO。',
  ogTitle: 'Nuxt Blog',
  ogDescription: '用 Nuxt 4 打造的全端部落格範例',
  ogType: 'website',
})

const { data: posts } = await useFetch('/api/posts')
</script>

<template>
  <section>
    <h1>最新文章</h1>

    <p v-if="!posts?.length" class="muted">
      還沒有文章。<NuxtLink to="/login">登入</NuxtLink> 後可到後台發表第一篇。
    </p>

    <PostCard v-for="post in posts" :key="post.id" :post="post" />
  </section>
</template>
