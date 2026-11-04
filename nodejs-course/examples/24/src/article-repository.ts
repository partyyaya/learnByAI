import type { Article, ArticlePage, ArticleScope, ArticleStatus, DraftInput, ArticleListQuery } from './article-model.js';

export interface StatusAuditInput {
  id: string;
  articleId: string;
  actorId: string;
  action: 'publish' | 'archive';
  fromStatus: ArticleStatus;
  toStatus: ArticleStatus;
  fromVersion: number;
  toVersion: number;
}
export interface ArticleChanges { title?: string; content?: string; status: ArticleStatus }
export interface ArticleTransaction {
  findById(id: string): Promise<Article | null>;
  appendStatusAudit(input: StatusAuditInput): Promise<void>;
  // 必須同時比對 id、authorId、version、status；成功遞增版本，未匹配回 null。
  updateIfCurrent(current: Article, changes: ArticleChanges): Promise<Article | null>;
}
export interface ArticleRepository {
  list(pagination: ArticleListQuery, scope: ArticleScope): Promise<ArticlePage>;
  findVisible(id: string, scope: ArticleScope): Promise<Article | null>;
  create(input: DraftInput & { id: string; authorId: string }): Promise<Article>;
  // callback 成功才提交，拋錯須回滾；tx 只能在 callback 期間使用。
  withTransaction<T>(work: (tx: ArticleTransaction) => Promise<T>): Promise<T>;
}
