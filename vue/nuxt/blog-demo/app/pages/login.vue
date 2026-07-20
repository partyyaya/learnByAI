<script setup>
// 登入 / 註冊（第 11 章）。此頁不需登入即可看，全螢幕表單。
useSeoMeta({ title: '登入' })

const { loggedIn, fetch: refreshSession } = useUserSession()
const route = useRoute()

// 已登入就直接離開登入頁
if (loggedIn.value) {
  await navigateTo(route.query.redirect || '/')
}

const mode = ref('login') // 'login' | 'register'
const email = ref('')
const password = ref('')
const name = ref('')
const err = ref('')
const loading = ref(false)

async function submit() {
  err.value = ''
  loading.value = true
  try {
    const url = mode.value === 'login' ? '/api/auth/login' : '/api/auth/register'
    await $fetch(url, {
      method: 'POST',
      body: { email: email.value, password: password.value, name: name.value },
    })
    await refreshSession() // 重抓 session，讓 loggedIn/user 更新
    await navigateTo(route.query.redirect || '/admin')
  } catch (e) {
    err.value = e.data?.statusMessage || '操作失敗，請重試'
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <section style="max-width: 380px; margin: 0 auto">
    <h1>{{ mode === 'login' ? '登入' : '註冊' }}</h1>

    <form class="form" @submit.prevent="submit">
      <input v-if="mode === 'register'" v-model="name" placeholder="顯示名稱" />
      <input v-model="email" type="email" placeholder="email" autocomplete="username" />
      <input v-model="password" type="password" placeholder="密碼" autocomplete="current-password" />
      <button class="btn" type="submit" :disabled="loading">
        {{ loading ? '處理中…' : (mode === 'login' ? '登入' : '註冊並登入') }}
      </button>
    </form>

    <p v-if="err" class="err">{{ err }}</p>

    <p class="muted" style="cursor: pointer" @click="mode = mode === 'login' ? 'register' : 'login'">
      {{ mode === 'login' ? '還沒有帳號？點此註冊' : '已有帳號？點此登入' }}
    </p>
  </section>
</template>
