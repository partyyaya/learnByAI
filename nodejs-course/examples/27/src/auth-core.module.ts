import { Module, type DynamicModule } from '@nestjs/common';
import type { Database } from './database.js';
import type { AuthOptions } from './auth-options.js';
import type { AuthRepository } from './auth-repository.js';
import { createPrismaAuthRepository } from './prisma-auth-repository.js';
import { createAuthService } from './auth-service.js';
import { AUTH_OPTIONS, AUTH_REPOSITORY, AUTH_SERVICE, DATABASE } from './tokens.js';

@Module({})
export class AuthCoreModule {
  static register(database: DynamicModule, options: Readonly<AuthOptions>): DynamicModule {
    return { module: AuthCoreModule, imports: [database], providers: [
      { provide: AUTH_OPTIONS, useValue: options },
      { provide: AUTH_REPOSITORY, inject: [DATABASE], useFactory: (db: Database) => createPrismaAuthRepository(db) },
      { provide: AUTH_SERVICE, inject: [AUTH_REPOSITORY, AUTH_OPTIONS],
        useFactory: (repository: AuthRepository, config: Readonly<AuthOptions>) => createAuthService(repository, config) },
    ], exports: [AUTH_SERVICE, AUTH_OPTIONS] };
  }
}
