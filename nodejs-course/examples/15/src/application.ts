import type { Database } from './database.js';
import { createArticleProviders } from './article.providers.js';
import { createArticleServer, type ServerOptions } from './server.js';

export interface ApplicationOptions extends Omit<ServerOptions, 'providers'> {
  database: Database;
}
// 組裝入口：每個應用建立一組依賴，並承接傳入 database 的關閉責任。
export async function createArticleApplication({ database, closeResources, ...options }: ApplicationOptions) {
  try {
    return await createArticleServer({
      ...options, providers: createArticleProviders(database),
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
