import type { Database } from './database.js';
import { createPrismaArticleRepository } from './prisma-article-repository.js';
import { createArticleService } from './article-service.js';
import { createArticleServer, type ServerOptions } from './server.js';

export interface ApplicationOptions extends Omit<ServerOptions, 'articles' | 'checkReady'> {
  database: Database;
}
// 組裝入口：每個應用建立一組依賴，並承接傳入 database 的關閉責任。
export function createArticleApplication({ database, closeResources, ...options }: ApplicationOptions) {
  const repository = createPrismaArticleRepository(database);
  const articles = createArticleService(repository);
  return createArticleServer({
    ...options, articles,
    checkReady: async () => { await database.article.count(); },
    closeResources: async signal => {
      try { await closeResources?.(signal); }
      finally { await database.$disconnect(); }
    },
  });
}
