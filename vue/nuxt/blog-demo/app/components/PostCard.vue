<script setup>
// 自動匯入的元件（第 4 章）。放在 app/components/，用 <PostCard> 即可，不用 import。
const props = defineProps({ post: Object })

// 內容摘要
const excerpt = computed(() => {
  const c = props.post?.content ?? ''
  return c.length > 60 ? c.slice(0, 60) + '…' : c
})
</script>

<template>
  <article class="card post-card">
    <div>
      <h2>
        <NuxtLink :to="`/posts/${post.id}`">{{ post.title }}</NuxtLink>
        <span v-if="!post.published" class="badge draft">草稿</span>
      </h2>
      <p class="excerpt">{{ excerpt }}</p>
      <p class="meta">
        作者：{{ post.author?.name || '站長' }} ·
        {{ new Date(post.createdAt).toLocaleDateString('zh-TW') }}
      </p>
    </div>
  </article>
</template>
