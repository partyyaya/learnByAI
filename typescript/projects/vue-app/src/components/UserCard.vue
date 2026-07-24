<script setup lang="ts">
import { useRouter } from 'vue-router'
import { useFavoritesStore } from '@/stores/favorites'
import type { User } from '@/types'

// 以泛型宣告 props，取得完整型別檢查
const props = defineProps<{ user: User }>()

// Vue 3.3+ 的型別字面量 defineEmits 簡寫
const emit = defineEmits<{
  select: [id: number]
}>()

const router = useRouter()
const favorites = useFavoritesStore()

// 點卡片導覽到詳細頁，同時對外發出 select 事件
function goToDetail(): void {
  emit('select', props.user.id)
  router.push({ name: 'user-detail', params: { id: props.user.id } })
}

// 切換收藏；stop 避免觸發卡片的點擊導覽
function onToggleFavorite(): void {
  favorites.toggle(props.user.id)
}
</script>

<template>
  <article class="user-card" @click="goToDetail">
    <div class="info">
      <h3>{{ user.name }}</h3>
      <p class="email">{{ user.email }}</p>
      <p class="company">{{ user.company.name }}</p>
    </div>
    <button
      class="fav-btn"
      type="button"
      :aria-pressed="favorites.isFavorite(user.id)"
      @click.stop="onToggleFavorite"
    >
      {{ favorites.isFavorite(user.id) ? '★ 已收藏' : '☆ 收藏' }}
    </button>
  </article>
</template>

<style scoped>
.user-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding: 1rem;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  background: #ffffff;
  cursor: pointer;
  transition: box-shadow 0.15s ease;
}

.user-card:hover {
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
}

.info h3 {
  margin: 0 0 0.25rem;
  font-size: 1.05rem;
}

.info p {
  margin: 0;
  font-size: 0.85rem;
  color: #64748b;
}

.fav-btn {
  flex-shrink: 0;
  padding: 0.4rem 0.75rem;
  border: 1px solid #f59e0b;
  border-radius: 6px;
  background: #fff7ed;
  color: #b45309;
  cursor: pointer;
}

.fav-btn:hover {
  background: #ffedd5;
}
</style>
