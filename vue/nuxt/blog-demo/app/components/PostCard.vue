<script setup>
// 自動匯入的元件（第 4 章）。放在 app/components/，用 <PostCard> 即可，不用 import。
const props = defineProps({ post: Object })

// excerpt / formatDate / authorName 來自 app/utils/format.js，也是自動匯入（第 4 章）
// 顯示邏輯抽成純函式後，那部分可以單獨測（見 tests/unit/format.spec.js，第 15 章）
const summary = computed(() => excerpt(props.post?.content))
const dateLabel = computed(() => formatDate(props.post?.createdAt))
const author = computed(() => authorName(props.post))
</script>

<template>
  <article class="card post-card">
    <div>
      <h2>
        <NuxtLink :to="`/posts/${post.id}`">{{ post.title }}</NuxtLink>
        <span v-if="!post.published" class="badge draft">草稿</span>
      </h2>
      <p class="excerpt">{{ summary }}</p>
      <p class="meta">作者：{{ author }} · {{ dateLabel }}</p>
    </div>
  </article>
</template>
