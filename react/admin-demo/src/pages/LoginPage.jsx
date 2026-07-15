import { useState } from 'react'
import { Navigate, useLocation, useNavigate } from 'react-router-dom'
import { useMutation } from '@tanstack/react-query'
import { authApi } from '@/services/api/auth.api'
import { useAuthStore, selectIsAuthenticated } from '@/stores/auth.store'
import { Field, TextInput } from '@/components/ui/FormField'
import Button from '@/components/ui/Button'

// 登入頁：整合第 06 章（受控元件 + 驗證）與第 11 章（Zustand 存登入態）。
// 登入這個「非同步寫入動作」用 useMutation 管理 loading / error（第 10 章觀念）。

function validate(form) {
  const errors = {}
  if (!form.username.trim()) errors.username = '請輸入帳號'
  if (!form.password) errors.password = '請輸入密碼'
  else if (form.password.length < 6) errors.password = '密碼至少 6 碼'
  return errors
}

function LoginPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const isAuthenticated = useAuthStore(selectIsAuthenticated)
  const setSession = useAuthStore((state) => state.setSession)

  const [form, setForm] = useState({ username: '', password: '' })
  const [errors, setErrors] = useState({})

  const loginMutation = useMutation({
    mutationFn: authApi.login,
    onSuccess: (data) => {
      setSession(data)
      // 登入後回到原本要去的頁（由 ProtectedRoute 帶入），否則進儀表板。
      const to = location.state?.from?.pathname || '/dashboard'
      navigate(to, { replace: true })
    },
  })

  // 已登入者不該看到登入頁
  if (isAuthenticated) return <Navigate to="/dashboard" replace />

  function updateField(field, value) {
    setForm((prev) => ({ ...prev, [field]: value }))
    setErrors((prev) => ({ ...prev, [field]: undefined }))
  }

  function handleSubmit(event) {
    event.preventDefault()
    const validationErrors = validate(form)
    setErrors(validationErrors)
    if (Object.keys(validationErrors).length > 0) return
    loginMutation.mutate(form)
  }

  function fillDemo(role) {
    setForm(
      role === 'admin'
        ? { username: 'admin', password: 'admin123' }
        : { username: 'editor', password: 'editor123' }
    )
    setErrors({})
  }

  return (
    <div className="login-page">
      <form className="login-card" onSubmit={handleSubmit} noValidate>
        <div className="login-card__brand">
          <span className="sidebar__logo">R</span>
          <span>React Admin Demo</span>
        </div>
        <h1 className="login-card__title">登入後台</h1>
        <p className="login-card__hint">
          課程實戰範例，資料皆為前端 Mock，可安心操作。
        </p>

        <Field label="帳號" error={errors.username}>
          <TextInput
            value={form.username}
            error={errors.username}
            autoComplete="username"
            placeholder="admin 或 editor"
            onChange={(e) => updateField('username', e.target.value)}
          />
        </Field>

        <Field label="密碼" error={errors.password}>
          <TextInput
            type="password"
            value={form.password}
            error={errors.password}
            autoComplete="current-password"
            placeholder="請輸入密碼"
            onChange={(e) => updateField('password', e.target.value)}
          />
        </Field>

        {loginMutation.isError && (
          <p className="login-card__error">{loginMutation.error.message}</p>
        )}

        <Button type="submit" disabled={loginMutation.isPending}>
          {loginMutation.isPending ? '登入中…' : '登入'}
        </Button>

        <div className="login-card__demo">
          <span>快速填入：</span>
          <button type="button" onClick={() => fillDemo('admin')}>
            admin
          </button>
          <button type="button" onClick={() => fillDemo('editor')}>
            editor
          </button>
        </div>
      </form>
    </div>
  )
}

export default LoginPage
