export type ArticleStatus = 'draft' | 'published' | 'archived';

export interface Article {
  id: string;
  authorId: string;
  title: string;
  content: string;
  status: ArticleStatus;
  version: number;
}

// 本章只練習狀態規則；呼叫者是本機示範程式，尚未接收 HTTP 輸入。
// 身分、權限、外部輸入驗證與資料庫版本比對會在後續章節實作。
export function publishArticle(article: Article): Article {
  if (article.status !== 'draft') {
    throw new Error('INVALID_ARTICLE_STATE');
  }

  return {
    ...article,
    status: 'published',
    version: article.version + 1,
  };
}
