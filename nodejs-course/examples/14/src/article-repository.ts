import type { Article, ArticlePage, ArticleScope, ArticleStatus, DraftInput, Pagination } from './article-model.js';

export interface ArticleChanges { title?: string; content?: string; status: ArticleStatus }
export interface ArticleTransaction {
  findById(id: string): Promise<Article | null>;
  // 必須同時比對 id、version、status；成功遞增版本，未匹配回 null。
  updateIfCurrent(current: Article, changes: ArticleChanges): Promise<Article | null>;
}
export interface ArticleRepository {
  list(pagination: Pagination, scope: ArticleScope): Promise<ArticlePage>;
  findVisible(id: string, scope: ArticleScope): Promise<Article | null>;
  create(input: DraftInput & { id: string; authorId: string }): Promise<Article>;
  // callback 成功才提交，拋錯須回滾；tx 只能在 callback 期間使用。
  withTransaction<T>(work: (tx: ArticleTransaction) => Promise<T>): Promise<T>;
}
