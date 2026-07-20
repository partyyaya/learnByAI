<script setup>
// 後台（第 3、9、10、11 章）：要登入、用 admin 版面、可發表/刪除文章
definePageMeta({
  layout: 'admin',
  middleware: ['auth'], // 未登入會被踢到 /login
})

useSeoMeta({ title: '文章管理' })

const { user } = useUserSession()

// 後台要看全部（含草稿），帶 ?all=true（server 端會再驗登入）
const { data: posts, refresh } = await useFetch('/api/posts', {
  query: { all: 'true' },
  key: 'admin-posts',
})

// 新增表單
const title = ref('')
const content = ref('')
const published = ref(true)
const err = ref('')

async function add() {
  err.value = ''
  if (!title.value) {
    err.value = '標題必填'
    return
  }
  try {
    await $fetch('/api/posts', {
      method: 'POST',
      body: { title: title.value, content: content.value, published: published.value },
    })
    title.value = ''
    content.value = ''
    published.value = true
    await refresh()
  } catch (e) {
    err.value = e.data?.statusMessage || '新增失敗'
  }
}

// 樂觀刪除（第 10 章）：先改畫面，失敗再還原
async function remove(id) {
  const backup = posts.value
  posts.value = posts.value.filter((p) => p.id !== id)
  try {
    await $fetch(`/api/posts/${id}`, { method: 'DELETE' })
  } catch (e) {
    posts.value = backup
    alert(e.data?.statusMessage || '刪除失敗')
  }
}
</script>

<template>
  <section>
    <h1>文章管理</h1>

    <form class="form" @submit.prevent="add">
      <input v-model="title" placeholder="文章標題" />
      <textarea v-model="content" placeholder="文章內容" />
      <label class="row">
        <input type="checkbox" v-model="published" style="width:auto" />
        立即發佈（取消則存為草稿，不會出現在首頁）
      </label>
      <div class="row">
        <button class="btn" type="submit">發表文章</button>
        <span v-if="err" class="err">{{ err }}</span>
      </div>
    </form>

    <h2 style="font-size:18px">所有文章</h2>
    <article v-for="p in posts" :key="p.id" class="card post-card">
      <div>
        <h2>
          {{ p.title }}
          <span class="badge" :class="{ draft: !p.published }">
            {{ p.published ? '已發佈' : '草稿' }}
          </span>
        </h2>
        <p class="meta">作者：{{ p.author?.name || '站長' }}</p>
      </div>
      <!-- 只有自己的文章才顯示刪除鈕（示範文章 authorId 為 null，不顯示） -->
      <button v-if="p.authorId === user.id" class="btn danger" @click="remove(p.id)">
        刪除
      </button>
    </article>
  </section>
</template>
