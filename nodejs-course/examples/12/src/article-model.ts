// 應用自己的型別；不匯入 Express、Zod 或 Prisma。
export type ArticleStatus = 'draft' | 'published' | 'archived';
export interface Article {
  id: string;
  authorId: string;
  title: string;
  content: string;
  status: ArticleStatus;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}
export interface DraftInput { title: string; content: string }
export interface VersionInput { expectedVersion: number }
export interface PatchInput extends VersionInput { title?: string; content?: string }
export interface Pagination { page: number; pageSize: number }
export type ArticleAction = 'edit' | 'publish' | 'archive';
export type ArticleScope = { kind: 'public' } | { kind: 'author'; authorId: string };
export interface ArticlePage { data: Article[]; meta: Pagination & { total: number } }

export type ArticleErrorCode = 'NOT_FOUND' | 'VERSION_CONFLICT' | 'INVALID_STATE' | 'VERSION_LIMIT';
const messages: Record<ArticleErrorCode, string> = {
  NOT_FOUND: '找不到文章',
  VERSION_CONFLICT: '文章已更新，請重新讀取',
  INVALID_STATE: '目前狀態不允許此操作',
  VERSION_LIMIT: '版本已達欄位上限',
};
export class ArticleError extends Error {
  constructor(readonly code: ArticleErrorCode) { super(messages[code]); }
}
