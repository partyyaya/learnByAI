import { randomUUID } from 'node:crypto';
import { HttpError } from './http.js';
import type { DraftInput, PatchInput, VersionInput, Pagination } from './schemas.js';

export interface Article {
  id: string;
  authorId: string;
  title: string;
  content: string;
  status: 'draft' | 'published' | 'archived';
  version: number;
  createdAt: string;
  updatedAt: string;
}

// 本機教學用固定作者；不是登入結果，也不讀取用戶提供的 authorId。
export const demoAuthorId = 'u_demo';
export function createArticles() {
  const records = new Map<string, Article>();
  for (const [id, title, status, date] of [
    ['a_1', '認識 Node HTTP', 'published', '2026-01-03T00:00:00.000Z'],
    ['a_2', '請求與回應', 'published', '2026-01-02T00:00:00.000Z'],
    ['a_draft', '未公開草稿', 'draft', '2026-01-01T00:00:00.000Z'],
  ] as const) {
    records.set(id, { id, authorId: demoAuthorId, title, content: '文章內容', status, version: 1, createdAt: date, updatedAt: date });
  }
  function find(id: string): Article {
    const value = records.get(id);
    if (!value) throw new HttpError(404, 'NOT_FOUND', '找不到文章');
    return value;
  }
  function list({ page, pageSize }: Pagination, publicOnly: boolean) {
    const visible = [...records.values()].filter(item => publicOnly ? item.status === 'published' : item.authorId === demoAuthorId);
    // ISO UTC 時間可按字串排序；同時間再按 ID 降冪。
    visible.sort((a, b) => a.createdAt === b.createdAt ? (a.id < b.id ? 1 : a.id > b.id ? -1 : 0) : (a.createdAt < b.createdAt ? 1 : -1));
    return { data: visible.slice((page - 1) * pageSize, page * pageSize).map(item => ({ ...item })), meta: { page, pageSize, total: visible.length } };
  }
  function detail(id: string, publicOnly: boolean) {
    const article = find(id);
    if (publicOnly ? article.status !== 'published' : article.authorId !== demoAuthorId) throw new HttpError(404, 'NOT_FOUND', '找不到文章');
    return { ...article };
  }
  function create(draft: DraftInput) {
    const now = new Date().toISOString(); const id = `a_${randomUUID()}`;
    const article: Article = { id, authorId: demoAuthorId, ...draft, status: 'draft', version: 1, createdAt: now, updatedAt: now };
    records.set(id, article); return { ...article };
  }
  function change(id: string, input: PatchInput | VersionInput, action: 'edit' | 'publish' | 'archive') {
    // 輸入已由路由的 schema middleware 驗證；狀態與版本仍在這裡檢查。
    const patch: Partial<Pick<Article, 'title' | 'content'>> = {};
    if (action === 'edit') {
      if ('title' in input && input.title !== undefined) patch.title = input.title;
      if ('content' in input && input.content !== undefined) patch.content = input.content;
    }
    const article = find(id);
    if (article.version !== input.expectedVersion) throw new HttpError(409, 'VERSION_CONFLICT', '文章已更新，請重新讀取');
    if (article.status === 'archived' || (action === 'publish' && article.status !== 'draft')) {
      throw new HttpError(409, 'INVALID_STATE', '目前狀態不允許此操作');
    }
    // 此段沒有 await：只保證同一程序內這段同步操作不被另一個 handler 插入。
    const updated: Article = { ...article, ...patch,
      status: action === 'edit' ? article.status : action === 'publish' ? 'published' : 'archived',
      version: article.version + 1, updatedAt: new Date().toISOString() };
    records.set(id, updated); return { ...updated };
  }
  return { list, detail, create, change };
}

