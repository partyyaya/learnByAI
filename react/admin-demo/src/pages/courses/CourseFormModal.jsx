import { useEffect, useState } from 'react'
import Modal from '@/components/ui/Modal'
import Button from '@/components/ui/Button'
import { Field, TextInput, Select, TextArea } from '@/components/ui/FormField'
import { CONSTANTS } from '@/mock/db'

// 新增課程表單（第 06 章：受控元件 + 同步驗證）。
// 這是「展示型」元件：自己管表單與驗證，送出時把乾淨 payload 交給 onSubmit，
// 由父層決定怎麼呼叫 mutation（第 10 章樂觀更新）。

const initialForm = {
  title: '',
  level: 'beginner',
  category: '前端',
  minutes: '',
  description: '',
}

function validate(form) {
  const errors = {}
  if (!form.title.trim()) errors.title = '課程名稱為必填'
  else if (form.title.trim().length < 4) errors.title = '課程名稱至少 4 個字'

  const minutes = Number(form.minutes)
  if (!form.minutes) errors.minutes = '課程時長為必填'
  else if (Number.isNaN(minutes) || minutes < 5 || minutes > 300)
    errors.minutes = '時長需介於 5 到 300 分鐘'

  if (!form.description.trim()) errors.description = '課程描述為必填'
  else if (form.description.trim().length < 10)
    errors.description = '課程描述至少 10 個字'

  return errors
}

function CourseFormModal({ open, onClose, onSubmit, pending, errorMessage }) {
  const [form, setForm] = useState(initialForm)
  const [errors, setErrors] = useState({})

  // 每次開啟時重置表單
  useEffect(() => {
    if (open) {
      setForm(initialForm)
      setErrors({})
    }
  }, [open])

  function updateField(field, value) {
    setForm((prev) => ({ ...prev, [field]: value }))
    setErrors((prev) => ({ ...prev, [field]: undefined }))
  }

  function handleSubmit(event) {
    event.preventDefault()
    const validationErrors = validate(form)
    setErrors(validationErrors)
    if (Object.keys(validationErrors).length > 0) return
    onSubmit({ ...form, minutes: Number(form.minutes) })
  }

  return (
    <Modal
      open={open}
      title="新增課程"
      onClose={onClose}
      footer={
        <>
          <Button variant="subtle" onClick={onClose} disabled={pending}>
            取消
          </Button>
          <Button
            type="submit"
            form="course-form"
            disabled={pending}
          >
            {pending ? '送出中…' : '建立課程'}
          </Button>
        </>
      }
    >
      <form id="course-form" className="form-grid" onSubmit={handleSubmit} noValidate>
        <Field
          label="課程名稱"
          error={errors.title}
          hint="輸入含「fail」的名稱可觀察樂觀更新的失敗回滾"
        >
          <TextInput
            value={form.title}
            error={errors.title}
            placeholder="例如：React Router 巢狀路由"
            onChange={(e) => updateField('title', e.target.value)}
          />
        </Field>

        <div className="form-row">
          <Field label="難度" error={errors.level}>
            <Select
              value={form.level}
              onChange={(e) => updateField('level', e.target.value)}
            >
              {CONSTANTS.LEVELS.map((lv) => (
                <option key={lv} value={lv}>
                  {lv}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="分類" error={errors.category}>
            <Select
              value={form.category}
              onChange={(e) => updateField('category', e.target.value)}
            >
              {CONSTANTS.CATEGORIES.map((cat) => (
                <option key={cat} value={cat}>
                  {cat}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="時長（分鐘）" error={errors.minutes}>
            <TextInput
              type="number"
              value={form.minutes}
              error={errors.minutes}
              placeholder="5 ~ 300"
              onChange={(e) => updateField('minutes', e.target.value)}
            />
          </Field>
        </div>

        <Field label="課程描述" error={errors.description}>
          <TextArea
            rows={3}
            value={form.description}
            error={errors.description}
            placeholder="這門課會學到什麼？"
            onChange={(e) => updateField('description', e.target.value)}
          />
        </Field>

        {errorMessage && <p className="login-card__error">{errorMessage}</p>}
      </form>
    </Modal>
  )
}

export default CourseFormModal
