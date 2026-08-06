import { useCallback, useEffect, useRef, useState } from "react";

/**
 * 用原生 <dialog> 做確認視窗，而不是 window.confirm()。
 *
 * window.confirm() 在 Electron 裡有兩個問題：按鈕文字是作業系統語言（中文介面
 * 冒出英文的 OK / Cancel），而且吃不到主題顏色。<dialog> + showModal() 則自帶
 * backdrop、Esc 關閉與焦點鎖定，不必自己做遮罩。
 */
function ConfirmDialog({ title, message, confirmText, cancelText, tone, onResolve }) {
  const dialogRef = useRef(null);

  useEffect(() => {
    // showModal() 必須在元素進 DOM 之後才呼叫，所以放在 effect 而不是 render
    dialogRef.current?.showModal();
  }, []);

  // Esc 與點 backdrop 都會觸發 close 事件，統一在這裡收斂成 false
  const handleClose = () => onResolve(dialogRef.current?.returnValue === "confirm");

  return (
    <dialog ref={dialogRef} className="dialog" onClose={handleClose}>
      <h2 className="dialog__title">{title}</h2>
      <p className="dialog__message">{message}</p>
      {/* <form method="dialog"> 的按鈕會把 value 寫進 dialog.returnValue */}
      <form method="dialog" className="dialog__footer">
        <button type="submit" value="cancel" className="btn btn--ghost">
          {cancelText}
        </button>
        <button
          type="submit"
          value="confirm"
          className={`btn ${tone === "danger" ? "btn--danger" : "btn--primary"}`}
          autoFocus
        >
          {confirmText}
        </button>
      </form>
    </dialog>
  );
}

/**
 * 讓確認視窗可以像 window.confirm() 一樣用 await：
 *
 *   const { confirm, confirmElement } = useConfirm();
 *   if (!(await confirm({ title: "刪除？", message: "…" }))) return;
 *
 * 記得把 confirmElement 放進 JSX，不然視窗不會出現。
 */
export function useConfirm() {
  const [request, setRequest] = useState(null);

  const confirm = useCallback(
    ({ title, message, confirmText = "確定", cancelText = "取消", tone = "primary" }) =>
      // resolve 先存起來，等使用者按下按鈕（或 Esc）才呼叫
      new Promise((resolve) => {
        setRequest({ title, message, confirmText, cancelText, tone, resolve });
      }),
    []
  );

  const handleResolve = useCallback(
    (result) => {
      setRequest(null);
      request?.resolve(result);
    },
    [request]
  );

  const confirmElement = request ? (
    // key 讓每次呼叫都是一個新的 <dialog>，effect 才會重跑 showModal()
    <ConfirmDialog key={request.title + request.message} {...request} onResolve={handleResolve} />
  ) : null;

  return { confirm, confirmElement };
}
