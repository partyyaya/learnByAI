import type { Article } from './article-model.js';

// 明列公開欄位，避免日後 model 新增內部欄位時自動洩漏。
export function present(article: Article) {
  return {
    id: article.id, authorId: article.authorId, title: article.title, content: article.content,
    status: article.status, version: article.version,
    createdAt: article.createdAt.toISOString(), updatedAt: article.updatedAt.toISOString(),
  };
}
