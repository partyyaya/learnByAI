import { randomUUID } from 'node:crypto';
import { HttpError, validateDraft } from './http.js';

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
  function list(query: Record<string, unknown>, publicOnly: boolean) {
    if (Object.keys(query).some(key => key !== 'page' && key !== 'pageSize')) invalid('只接受 page 與 pageSize');
    function integer(name: string, fallback: number, max: number) {
      const raw = query[name];
      if (raw === undefined) return fallback;
      if (typeof raw !== 'string' || !/^[0-9]+$/.test(raw)) invalid(`${name} 必須是單一整數`);
      const value = Number(raw);
      if (!Number.isSafeInteger(value) || value < 1 || value > max) invalid(`${name} 超出範圍`);
      return value;
    }
    const page = integer('page', 1, 1000000); const pageSize = integer('pageSize', 20, 100);
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
  function create(body: unknown) {
    const draft = validateDraft(body);
    const now = new Date().toISOString(); const id = `a_${randomUUID()}`;
    const article: Article = { id, authorId: demoAuthorId, ...draft, status: 'draft', version: 1, createdAt: now, updatedAt: now };
    records.set(id, article); return { ...article };
  }
  function change(id: string, body: unknown, action: 'edit' | 'publish' | 'archive') {
    const input = object(body);
    const allowed = action === 'edit' ? ['title', 'content', 'expectedVersion'] : ['expectedVersion'];
    if (Object.keys(input).some(key => !allowed.includes(key))) invalid('包含不允許修改的欄位');
    if (typeof input.expectedVersion !== 'number' || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) invalid('expectedVersion 必須是正整數');
    const patch: Partial<Pick<Article, 'title' | 'content'>> = {};
    if (action === 'edit') {
      if (!Object.hasOwn(input, 'title') && !Object.hasOwn(input, 'content')) invalid('至少提供 title 或 content');
      if (Object.hasOwn(input, 'title')) patch.title = validateDraft({ title: input.title, content: 'placeholder' }).title;
      if (Object.hasOwn(input, 'content')) patch.content = validateDraft({ title: 'placeholder', content: input.content }).content;
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

function invalid(message: string): never { throw new HttpError(400, 'VALIDATION_ERROR', message); }
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid('body 必須是物件');
  return value as Record<string, unknown>;
}
