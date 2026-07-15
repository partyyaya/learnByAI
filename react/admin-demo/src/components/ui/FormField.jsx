// 表單欄位包裝：label + 控制項 + 錯誤訊息。
// 對應第 06 章「受控元件 + 驗證錯誤呈現」。傳 error 字串即顯示紅字。

export function Field({ label, error, children, hint }) {
  return (
    <label className={`field ${error ? 'field--error' : ''}`}>
      <span className="field__label">{label}</span>
      {children}
      {hint && !error && <small className="field__hint">{hint}</small>}
      {error && <small className="field__error">{error}</small>}
    </label>
  )
}

// 受控 input
export function TextInput({ error, ...rest }) {
  return <input className={`input ${error ? 'input--error' : ''}`} {...rest} />
}

// 受控 select
export function Select({ error, children, ...rest }) {
  return (
    <select className={`input ${error ? 'input--error' : ''}`} {...rest}>
      {children}
    </select>
  )
}

// 受控 textarea
export function TextArea({ error, ...rest }) {
  return (
    <textarea className={`input ${error ? 'input--error' : ''}`} {...rest} />
  )
}
