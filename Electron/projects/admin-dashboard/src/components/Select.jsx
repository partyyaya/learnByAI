import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { IconCheck, IconChevronDown } from "./icons";

/**
 * 取代原生 <select> 的下拉選單。
 *
 * 原生 select 的觸發框可以用 CSS 畫成跟介面一致，但展開的選項清單是作業系統畫的
 * （在 Electron/macOS 上是一片淺色、帶模糊效果的原生選單），深色主題底下就會冒出一塊
 * 風格完全不搭的白色選單——而且每個頁面的下拉都長這樣，看起來各自不一致。
 * 所以整個選單（觸發框＋選項清單）都自己畫，才能保證深色／淺色主題下、每個頁面都是
 * 同一套樣式。
 *
 * 面板用 createPortal 掛到 body，並用 getBoundingClientRect 量出來的座標定位
 * （position: fixed）：如果照 DOM 結構原地展開，遇到會橫向捲動的表格容器
 * （.table-wrap 設了 overflow）面板就會被裁掉。掛到 body 就不受任何祖先層的
 * overflow 影響。副作用是頁面一捲動座標就過期，所以捲動時直接把面板關掉。
 */
export function Select({
  value,
  onChange,
  options,
  placeholder,
  disabled,
  className = "",
  "aria-label": ariaLabel
}) {
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState(null);
  const triggerRef = useRef(null);
  const panelRef = useRef(null);
  const listId = useId();

  const items = placeholder != null ? [{ value: "", label: placeholder }, ...options] : options;
  const selected = items.find((item) => item.value === value) ?? items[0];

  function openPanel() {
    if (disabled) return;
    setRect(triggerRef.current.getBoundingClientRect());
    setOpen(true);
  }

  useEffect(() => {
    if (!open) return undefined;

    const close = () => setOpen(false);
    const handlePointerDown = (event) => {
      if (triggerRef.current?.contains(event.target)) return;
      if (panelRef.current?.contains(event.target)) return;
      close();
    };
    const handleKeyDown = (event) => {
      if (event.key === "Escape") close();
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    // capture 階段才能收到內部可捲動容器（例如表格）的 scroll，不會只聽到 window 本身
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  function choose(item) {
    setOpen(false);
    if (item.value !== value) onChange(item.value);
  }

  return (
    <div className={`select ${className}`.trim()}>
      <button
        type="button"
        ref={triggerRef}
        className={`select__trigger${open ? " is-open" : ""}`}
        onClick={() => (open ? setOpen(false) : openPanel())}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-label={ariaLabel}
      >
        <span className="select__value">{selected?.label}</span>
        <IconChevronDown size={14} className="select__caret" />
      </button>

      {open && rect
        ? createPortal(
            <ul
              ref={panelRef}
              className="select__panel"
              role="listbox"
              id={listId}
              aria-label={ariaLabel}
              style={{ top: rect.bottom + 6, left: rect.left, minWidth: rect.width }}
            >
              {items.map((item) => (
                <li
                  key={item.value}
                  role="option"
                  aria-selected={item.value === value}
                  className={`select__option${item.value === value ? " is-selected" : ""}`}
                  onClick={() => choose(item)}
                >
                  <span>{item.label}</span>
                  {item.value === value ? <IconCheck size={14} /> : null}
                </li>
              ))}
            </ul>,
            document.body
          )
        : null}
    </div>
  );
}
