import { z } from 'zod';

// 明確沿用 08 章的 code point 計數，不將欄位長度與 body byte 上限混為一談。
const text = (name: string, max: number) => z.string({ error: `${name} 必須是字串` }).trim()
  .refine(value => [...value].length >= 1 && [...value].length <= max, { error: `${name} 為 1–${max} 個 Unicode code point` });
const title = text('title', 120);
const content = text('content', 4000);
const expectedVersion = z.number({ error: 'expectedVersion 必須是數字' })
  .refine(value => Number.isSafeInteger(value) && value >= 1, { error: 'expectedVersion 必須是正安全整數' });

export const draftSchema = z.strictObject({ title, content });
export const patchSchema = z.strictObject({ title: title.optional(), content: content.optional(), expectedVersion })
  .refine(value => value.title !== undefined || value.content !== undefined, { error: '至少提供 title 或 content' });
export const versionSchema = z.strictObject({ expectedVersion });
export const idSchema = z.strictObject({ id: z.string().min(1) }); // ID 是不透明字串，不限定 UUID。
export const emptyQuerySchema = z.strictObject({});

// query 的原始值必須先是單一十進位字串，再轉數字並檢查範圍。
const queryInteger = (fallback: number, max: number) => z.string({ error: '必須是單一整數字串' })
  .regex(/^[0-9]+$/, { error: '必須是十進位整數字串' })
  .transform(Number)
  .refine(value => Number.isSafeInteger(value) && value >= 1 && value <= max, { error: `必須介於 1 與 ${max}` })
  .default(fallback);
export const paginationSchema = z.strictObject({ page: queryInteger(1, 1000000), pageSize: queryInteger(20, 100) });

export type DraftInput = z.output<typeof draftSchema>;
export type PatchInput = z.output<typeof patchSchema>;
export type VersionInput = z.output<typeof versionSchema>;
export type Pagination = z.output<typeof paginationSchema>;
export type ArticleParams = z.output<typeof idSchema>;
