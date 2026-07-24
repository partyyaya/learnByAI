<script setup lang="ts">
import { computed, watch } from 'vue'
import { useRoute } from 'vue-router'
import { storeToRefs } from 'pinia'
import { useUsersStore } from '@/stores/users'
import { useFavoritesStore } from '@/stores/favorites'
import { useAsync } from '@/composables/useAsync'
import { getUserPosts } from '@/api/users'
import type { Post } from '@/types'

const route = useRoute()
// route.params.id 型別為 string | string[]，需自行轉成 number
const userId = computed<number>(() => {
  const raw = route.params.id
  return Number(Array.isArray(raw) ? raw[0] : raw)
})
const isInvalidId = computed(() => Number.isNaN(userId.value))

const usersStore = useUsersStore()
const { current, loading, error } = storeToRefs(usersStore)

const favorites = useFavoritesStore()

// 以泛型 composable 載入這位使用者的文章
const {
  data: posts,
  loading: postsLoading,
  error: postsError,
  run: loadPosts,
} = useAsync<Post[]>(() => getUserPosts(userId.value))

// 監看路由參數而非只在掛載時抓一次：Vue Router 對同一個具名路由（user-detail）
// 在不同 :id 間導覽時會重用同一個元件實例；若只在 onMounted 抓資料，
// 之後只要有入口能從一個詳情頁直接連到另一個詳情頁，畫面就會停在舊資料。
// useAsync 內建的過期結果保護，也能避免快速切換時舊請求覆蓋新結果。
watch(
  userId,
  (id) => {
    if (Number.isNaN(id)) return // 無效代碼：不發請求，畫面另外顯示錯誤訊息
    usersStore.fetchUser(id)
    loadPosts()
  },
  { immediate: true },
)
</script>

<template>
  <section class="detail">
    <p v-if="isInvalidId" class="status error">無效的使用者代碼</p>
    <p v-else-if="loading" class="status">載入中…</p>
    <p v-else-if="error" class="status error">發生錯誤：{{ error }}</p>

    <template v-else-if="current">
      <header class="header">
        <div>
          <h1>{{ current.name }}</h1>
          <p class="username">@{{ current.username }}</p>
        </div>
        <button
          class="fav-btn"
          type="button"
          :aria-pressed="favorites.isFavorite(current.id)"
          @click="favorites.toggle(current.id)"
        >
          {{ favorites.isFavorite(current.id) ? '★ 已收藏' : '☆ 收藏' }}
        </button>
      </header>

      <dl class="fields">
        <dt>Email</dt>
        <dd>{{ current.email }}</dd>
        <dt>電話</dt>
        <dd>{{ current.phone }}</dd>
        <dt>網站</dt>
        <dd>{{ current.website }}</dd>
        <dt>公司</dt>
        <dd>{{ current.company.name }} — {{ current.company.catchPhrase }}</dd>
        <dt>城市</dt>
        <dd>{{ current.address.city }}</dd>
      </dl>

      <h2>文章</h2>
      <p v-if="postsLoading" class="status">載入文章中…</p>
      <p v-else-if="postsError" class="status error">
        文章載入失敗：{{ postsError }}
      </p>
      <ul v-else-if="posts && posts.length" class="posts">
        <li v-for="post in posts" :key="post.id">
          <h3>{{ post.title }}</h3>
          <p>{{ post.body }}</p>
        </li>
      </ul>
      <p v-else class="status">這位使用者還沒有文章</p>
    </template>
  </section>
</template>

<style scoped>
.detail h1 {
  margin: 0;
}

.header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
}

.username {
  margin: 0.25rem 0 0;
  color: #64748b;
}

.fav-btn {
  flex-shrink: 0;
  padding: 0.5rem 1rem;
  border: 1px solid #f59e0b;
  border-radius: 6px;
  background: #fff7ed;
  color: #b45309;
  cursor: pointer;
}

.fields {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 0.4rem 1rem;
  margin: 1.25rem 0;
}

.fields dt {
  font-weight: 600;
  color: #334155;
}

.fields dd {
  margin: 0;
  color: #475569;
}

.posts {
  list-style: none;
  padding: 0;
  display: grid;
  gap: 0.75rem;
}

.posts li {
  padding: 0.75rem 1rem;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  background: #ffffff;
}

.posts h3 {
  margin: 0 0 0.35rem;
  font-size: 1rem;
  text-transform: capitalize;
}

.posts p {
  margin: 0;
  color: #64748b;
  font-size: 0.9rem;
}

.status {
  color: #64748b;
}

.status.error {
  color: #dc2626;
}
</style>
