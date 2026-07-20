"use client";
// 顯示表單送出中的狀態（第 8 章）。必須放在 <form> 內的子元件，才讀得到該表單狀態。
import { useFormStatus } from "react-dom";

export default function SubmitButton({ children, className = "btn" }) {
  const { pending } = useFormStatus();
  return (
    <button className={className} type="submit" disabled={pending}>
      {pending ? "處理中…" : children}
    </button>
  );
}
