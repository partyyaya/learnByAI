import type { Database } from './database.js';
import { DatabaseModule } from './database.module.js';
import { ArticleCoreModule } from './article-core.module.js';
import { createArticleServer, type ServerOptions } from './server.js';

export interface ApplicationOptions extends Omit<ServerOptions, 'dependencies'> {
  database: Database;
}
// 組裝入口：每個應用建立一組依賴，並承接傳入 database 的關閉責任。
export async function createArticleApplication({ database, closeResources, ...options }: ApplicationOptions) {
  try {
    const databaseModule = DatabaseModule.register(database);
    return await createArticleServer({
      ...options, dependencies: { articles: ArticleCoreModule.register(databaseModule), readiness: databaseModule },
      closeResources: async signal => {
        try { await closeResources?.(signal); }
        finally { await database.$disconnect(); }
      },
    });
  } catch (error) {
    await database.$disconnect();
    throw error;
  }
}
