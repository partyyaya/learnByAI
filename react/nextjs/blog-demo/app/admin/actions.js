"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";

// 建立文章：接 useActionState 的 (prevState, formData)
export async function createPost(prevState, formData) {
  await requireUser(); // 第二道防護：Action 也確認登入

  const title = (formData.get("title") ?? "").trim();
  const content = (formData.get("content") ?? "").trim();
  if (!title) return { error: "標題不可為空" };
  if (title.length > 100) return { error: "標題不可超過 100 字" };
  if (!content) return { error: "內容不可為空" };

  await prisma.post.create({
    data: { title, content, published: formData.get("published") === "on" },
  });

  revalidatePath("/admin"); // 後台列表
  revalidatePath("/"); // 首頁列表也可能變
  redirect("/admin");
}

// 刪除：綁在一般 form，用 hidden input 帶 id
export async function deletePost(formData) {
  await requireUser();
  const id = Number(formData.get("id"));
  await prisma.post.delete({ where: { id } });
  revalidatePath("/admin");
  revalidatePath("/");
}

// 切換發佈狀態
export async function togglePublish(formData) {
  await requireUser();
  const id = Number(formData.get("id"));
  const post = await prisma.post.findUnique({ where: { id } });
  if (!post) return;
  await prisma.post.update({
    where: { id },
    data: { published: !post.published },
  });
  revalidatePath("/admin");
  revalidatePath("/");
}
