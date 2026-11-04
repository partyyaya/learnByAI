import { Module, type Provider } from '@nestjs/common';
import type { FeatureDependencies } from '../src/app.module.js';
import { ARTICLE_SERVICE, CHECK_READY, AUTH_OPTIONS, AUTH_SERVICE } from '../src/tokens.js';
import { resolveAuthOptions } from '../src/auth-options.js';
import type { AuthService } from '../src/auth-service.js';
import { testActor, testToken, testCsrf } from './authenticated-test-client.js';

// 替身僅用於 HTTP/DI 測試；Guard 仍實際執行。安全整合測試使用真正 PostgreSQL Session。
export function authDouble(): AuthService {
  const unused = async (): Promise<never> => { throw new Error('此替身不實作認證寫入'); };
  return { consumeAttempt: () => {}, register: unused, login: unused, csrf: unused, logout: unused,
    resolve: async token => token === testToken ? { tokenHash: 'test-only', csrfToken: testCsrf,
      expiresAt: new Date('2099-01-01Z'), user: { ...testActor, email: 'alice@example.test', displayName: 'Alice' } } : null };
}
@Module({})
class TestDependenciesModule {}
export function testDependencies(providers: Provider[]): FeatureDependencies {
  const shared = { module: TestDependenciesModule, providers: [
    { provide: AUTH_OPTIONS, useValue: resolveAuthOptions() }, { provide: AUTH_SERVICE, useValue: authDouble() }, ...providers,
  ], exports: [ARTICLE_SERVICE, CHECK_READY, AUTH_OPTIONS, AUTH_SERVICE] };
  return { articles: shared, readiness: shared, auth: shared };
}
