import type { Request, Response } from 'express';
import type { ArticleService } from './article-service.js';
import type { Article, ArticleAction } from './article-model.js';
import type { ArticleParams, DraftInput, Pagination, PatchInput, VersionInput } from './schemas.js';

// 明列公開欄位，避免日後 model 新增內部欄位時自動洩漏。
function present(article: Article) {
  return {
    id: article.id, authorId: article.authorId, title: article.title, content: article.content,
    status: article.status, version: article.version,
    createdAt: article.createdAt.toISOString(), updatedAt: article.updatedAt.toISOString(),
  };
}
export function createArticleController(service: ArticleService) {
  return {
    list: (publicOnly: boolean) => async (_req: Request, res: Response) => {
      const result = await service.list(res.locals.query as Pagination, publicOnly);
      res.json({ data: result.data.map(present), meta: result.meta });
    },
    detail: (publicOnly: boolean) => async (_req: Request, res: Response) => {
      const article = await service.detail((res.locals.params as ArticleParams).id, publicOnly);
      res.json({ data: present(article) });
    },
    create: async (_req: Request, res: Response) => {
      const article = await service.create(res.locals.body as DraftInput);
      res.location(`/api/me/articles/${article.id}`).status(201).json({ data: present(article) });
    },
    change: (action: ArticleAction) => async (_req: Request, res: Response) => {
      const article = await service.change((res.locals.params as ArticleParams).id, res.locals.body as PatchInput | VersionInput, action);
      res.json({ data: present(article) });
    },
  };
}
