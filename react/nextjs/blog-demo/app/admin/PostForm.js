"use client";
import { useActionState } from "react";
import { createPost } from "./actions";
import SubmitButton from "./SubmitButton";

export default function PostForm() {
  const [state, formAction] = useActionState(createPost, { error: null });

  return (
    <form action={formAction} className="post-item" style={{ marginBottom: 24 }}>
      <h2 style={{ marginTop: 0 }}>發表新文章</h2>
      <div className="field">
        <label htmlFor="title">標題</label>
        <input id="title" name="title" placeholder="輸入標題…" />
      </div>
      <div className="field">
        <label htmlFor="content">內容</label>
        <textarea id="content" name="content" rows={4} placeholder="輸入內容…" />
      </div>
      <label className="checkbox-row">
        <input type="checkbox" name="published" defaultChecked />
        立即發佈（取消勾選則存為草稿）
      </label>
      <SubmitButton>發表文章</SubmitButton>
      {state?.error && <p className="err">{state.error}</p>}
    </form>
  );
}
