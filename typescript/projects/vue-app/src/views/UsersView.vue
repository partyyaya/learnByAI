<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { storeToRefs } from 'pinia'
import { useUsersStore } from '@/stores/users'
import UserCard from '@/components/UserCard.vue'

const usersStore = useUsersStore()
// storeToRefs 保留響應性，同時維持型別
const { users, loading, error } = storeToRefs(usersStore)

// 本地搜尋字串（client 端過濾）
const keyword = ref('')

const filteredUsers = computed(() => {
  const q = keyword.value.trim().toLowerCase()
  if (!q) return users.value
  return users.value.filter(
    (u) =>
      u.name.toLowerCase().includes(q) ||
      u.username.toLowerCase().includes(q),
  )
})

onMounted(() => {
  usersStore.fetchUsers()
})
</script>

<template>
  <section class="users">
    <h1>使用者列表</h1>

    <input
      v-model="keyword"
      class="search"
      type="search"
      placeholder="以姓名或帳號搜尋…"
      aria-label="搜尋使用者"
    />

    <p v-if="loading" class="status">載入中…</p>
    <p v-else-if="error" class="status error">發生錯誤：{{ error }}</p>
    <p v-else-if="filteredUsers.length === 0" class="status">
      找不到符合的使用者
    </p>

    <div v-else class="list">
      <UserCard v-for="user in filteredUsers" :key="user.id" :user="user" />
    </div>
  </section>
</template>

<style scoped>
.users h1 {
  margin-top: 0;
}

.search {
  width: 100%;
  max-width: 360px;
  padding: 0.5rem 0.75rem;
  margin-bottom: 1rem;
  border: 1px solid #cbd5e1;
  border-radius: 6px;
}

.status {
  color: #64748b;
}

.status.error {
  color: #dc2626;
}

.list {
  display: grid;
  gap: 0.75rem;
}
</style>
