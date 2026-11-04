import { Module, type DynamicModule, type FactoryProvider } from '@nestjs/common';
import type { Database } from './database.js';
import { DATABASE_INPUT, DATABASE, CHECK_READY, type ReadinessCheck } from './tokens.js';

@Module({})
export class DatabaseModule {
  static register(database: Database): DynamicModule {
    return {
      module: DatabaseModule,
      providers: [
        { provide: DATABASE_INPUT, useValue: database },
        { provide: DATABASE, inject: [DATABASE_INPUT], useFactory: async (db: Database) => {
          await db.$connect(); return db;
        } } satisfies FactoryProvider<Database>,
        { provide: CHECK_READY, inject: [DATABASE], useFactory: (db: Database): ReadinessCheck => async () => {
          await db.article.count();
          await db.articleStatusAudit.count();
          await db.comment.count();
          await db.session.count();
          await db.user.findFirst({ select: { email: true, passwordHash: true, role: true } });
        } } satisfies FactoryProvider<ReadinessCheck>,
      ],
      // client 的建立輸入不公開；關閉所有權仍在 application，不加第二個 shutdown hook。
      exports: [DATABASE, CHECK_READY],
    };
  }
}
