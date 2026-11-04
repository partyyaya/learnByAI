import { CommentsCoreModule } from './comments.module.js';
import type { Database } from './database.js';
import { DatabaseModule } from './database.module.js';
import { ArticleCoreModule } from './article-core.module.js';
import { createArticleServer, type ServerOptions } from './server.js';
import { AuthCoreModule } from './auth-core.module.js';
import { resolveAuthOptions, type AuthOptions } from './auth-options.js';

export interface ApplicationOptions extends Omit<ServerOptions, 'dependencies'> {
  database: Database;
  auth?: Partial<AuthOptions>;
}
// 組裝入口：每個應用建立一組依賴，並承接傳入 database 的關閉責任。
export async function createArticleApplication({ database, closeResources, auth, ...options }: ApplicationOptions) {
  try {
    const databaseModule = DatabaseModule.register(database);
    return await createArticleServer({
      ...options, dependencies: { notifications: databaseModule, comments: CommentsCoreModule.register(databaseModule), articles: ArticleCoreModule.register(databaseModule), readiness: databaseModule,
        auth: AuthCoreModule.register(databaseModule, resolveAuthOptions(auth)) },
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
