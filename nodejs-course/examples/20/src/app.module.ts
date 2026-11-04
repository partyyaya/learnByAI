import { ResponseProjectionInterceptor } from './response-projection.js';
import { ContractExceptionFilter } from './contract-exception.filter.js';
import { Module, type DynamicModule } from '@nestjs/common';
import { ArticlesModule } from './articles.module.js';
import { HealthModule } from './health.module.js';
import { AuthModule } from './auth.module.js';
import { APP_GUARD, APP_INTERCEPTOR, APP_FILTER } from '@nestjs/core';
import { RequestWorkGuard, RequestWorkInterceptor } from './request-work.js';

export interface FeatureDependencies {
  articles: DynamicModule;
  readiness: DynamicModule;
  auth: DynamicModule;
}

@Module({})
export class AppModule {
  static register(dependencies: FeatureDependencies, runtime: DynamicModule): DynamicModule {
    const auth = AuthModule.register(dependencies.auth, runtime);
    return { module: AppModule, imports: [runtime, auth,
      ArticlesModule.register(dependencies.articles, runtime, auth),
      HealthModule.register(dependencies.readiness, runtime),
    ], providers: [
      { provide: APP_GUARD, useClass: RequestWorkGuard },
      { provide: APP_INTERCEPTOR, useClass: RequestWorkInterceptor },
      { provide: APP_INTERCEPTOR, useClass: ResponseProjectionInterceptor },
      { provide: APP_FILTER, useClass: ContractExceptionFilter },
    ] };
  }
}
