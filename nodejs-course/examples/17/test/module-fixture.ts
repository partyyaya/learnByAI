import { Module, type Provider } from '@nestjs/common';
import type { FeatureDependencies } from '../src/app.module.js';
import { ARTICLE_SERVICE, CHECK_READY } from '../src/tokens.js';

// 僅供 HTTP 邊界測試；exports 同樣必須明列，不能靠根容器的非 strict get 掩蓋缺漏。
@Module({})
class TestDependenciesModule {}
export function testDependencies(providers: Provider[]): FeatureDependencies {
  const shared = { module: TestDependenciesModule, providers, exports: [ARTICLE_SERVICE, CHECK_READY] };
  return { articles: shared, readiness: shared };
}
