import { useEffect } from 'react'

// 對話框。open 為 false 時不渲染。
// 用 useEffect 監聽 Esc 關閉，並在開啟時鎖住背景捲動——這也是第 07 章
// 「副作用 + cleanup」的實際應用（掛事件 → 卸載/關閉時移除）。
function Modal({ open, title, onClose, children, footer }) {
  useEffect(() => {
    if (!open) return

    function onKeyDown(e) {
      if (e.key === 'Escape') onClose?.()
    }
    document.addEventListener('keydown', onKeyDown)
    document.body.style.overflow = 'hidden'

    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = ''
    }
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal__head">
          <h3>{title}</h3>
          <button className="modal__close" onClick={onClose} aria-label="關閉">
            ×
          </button>
        </header>
        <div className="modal__body">{children}</div>
        {footer && <footer className="modal__foot">{footer}</footer>}
      </div>
    </div>
  )
}

export default Modal
