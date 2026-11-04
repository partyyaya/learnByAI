import { Test, type TestingModule, type TestingModuleBuilder } from '@nestjs/testing';
import { createArticleApplication, type ApplicationOptions } from '../src/application.js';

export async function createTestingApplication(options: Omit<ApplicationOptions, 'applicationFactory'>,
  configure: (builder: TestingModuleBuilder) => void = () => {}) {
  let context: TestingModule | undefined;
  const server = await createArticleApplication({ ...options, applicationFactory: async (root, adapter, settings) => {
    const builder = Test.createTestingModule({ imports: [root] });
    configure(builder); // 必須在 compile 之前 override。
    context = await builder.compile();
    try { return context.createNestApplication(adapter, settings); }
    catch (error) { await context.close(); throw error; }
  } });
  if (!context) throw new Error('TestingModule 尚未建立');
  // 不另外呼叫 context.close；正式 lifecycle 會先排空工作，再關 Nest 與 database。
  return { server, context };
}
