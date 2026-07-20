// 路由中介層（第 9 章）：未登入就導向登入頁，並記住原本要去哪。
// 注意：這是「體驗」層的守衛；真正的安全靠 server API 的 requireUserSession（第 11 章）。
export default defineNuxtRouteMiddleware((to) => {
  const { loggedIn } = useUserSession()
  if (!loggedIn.value) {
    return navigateTo({ path: '/login', query: { redirect: to.fullPath } })
  }
})
