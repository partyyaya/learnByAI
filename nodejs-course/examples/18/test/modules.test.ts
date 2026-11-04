import 'reflect-metadata';
import { expect, jest, test } from '@jest/globals';
import { Injectable, Inject, Module, type DynamicModule } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { ArticleCoreModule } from '../src/article-core.module.js';
import { DatabaseModule } from '../src/database.module.js';
import { createDatabase } from '../src/database.js';
import { ARTICLE_REPOSITORY, ARTICLE_SERVICE, DATABASE } from '../src/tokens.js';
import { resolveHttpOptions } from '../src/runtime.module.js';

const PORT = Symbol('PORT');
@Injectable()
class Consumer {
  constructor(@Inject(PORT) readonly port: object) {}
}
@Module({})
class OwnerModule {}
@Module({})
class ConsumerModule {}

test('imports 只讓消費端取得被 exports 的 token；未匯出即使在整個容器中存在也不可注入', async () => {
  const owner = { module: OwnerModule, providers: [{ provide: PORT, useValue: {} }] };
  await expect(Test.createTestingModule({ imports: [
    { module: ConsumerModule, imports: [owner], providers: [Consumer] },
  ] }).compile()).rejects.toThrow(/PORT/);
  const value = {};
  const context = await Test.createTestingModule({ imports: [
    { module: ConsumerModule, imports: [{ ...owner, providers: [{ provide: PORT, useValue: value }], exports: [PORT] }], providers: [Consumer] },
  ] }).compile();
  try { expect(context.get(Consumer).port).toBe(value); }
  finally { await context.close(); }
});

test('父模組的 Provider 不會自動流入 imports 的子模組', async () => {
  await expect(Test.createTestingModule({
    providers: [{ provide: PORT, useValue: {} }],
    imports: [{ module: ConsumerModule, providers: [Consumer] }],
  }).compile()).rejects.toThrow(/PORT/);
});

test('重新匯出模組才傳遞可見性；只 imports 不等於 re-export', async () => {
  @Module({}) class FacadeModule {}
  const value = {};
  const owner = { module: OwnerModule, providers: [{ provide: PORT, useValue: value }], exports: [PORT] };
  const facade = { module: FacadeModule, imports: [owner] };
  await expect(Test.createTestingModule({ imports: [facade], providers: [Consumer] }).compile()).rejects.toThrow(/PORT/);
  const context = await Test.createTestingModule({ imports: [{ ...facade, exports: [OwnerModule] }], providers: [Consumer] }).compile();
  try { expect(context.get(Consumer).port).toBe(value); }
  finally { await context.close(); }
});

test('兩個功能模組匯入同一個已註冊模組，使用同一個 factory 結果', async () => {
  @Module({}) class FirstModule {}
  @Module({}) class SecondModule {}
  const factory = jest.fn(() => ({ id: randomUUID() }));
  const owner = { module: OwnerModule, providers: [{ provide: PORT, useFactory: factory }], exports: [PORT] };
  const first = { module: FirstModule, imports: [owner], providers: [Consumer] };
  const second = { module: SecondModule, imports: [owner], providers: [Consumer] };
  const context = await Test.createTestingModule({ imports: [first, second] }).compile();
  try {
    expect(factory).toHaveBeenCalledTimes(1);
    expect(context.select(first).get(Consumer, { strict: true }).port).toBe(context.select(second).get(Consumer, { strict: true }).port);
  } finally { await context.close(); }
});

test('在兩個模組重複 providers 註冊，DEFAULT 仍建立兩份，並非程序全域 singleton', async () => {
  @Module({}) class FirstModule {}
  @Module({}) class SecondModule {}
  const factory = jest.fn(() => ({ id: randomUUID() }));
  const providers = [{ provide: PORT, useFactory: factory }, Consumer];
  const first = { module: FirstModule, providers }; const second = { module: SecondModule, providers };
  const context = await Test.createTestingModule({ imports: [first, second] }).compile();
  try {
    expect(factory).toHaveBeenCalledTimes(2);
    expect(context.select(first).get(Consumer, { strict: true }).port).not.toBe(context.select(second).get(Consumer, { strict: true }).port);
  } finally { await context.close(); }
});

test('正式 ArticleCoreModule 只公開 Service；外部模組不能注入內部 Repository', async () => {
  const database = createDatabase('postgresql://course:course_local@127.0.0.1:1/course_test');
  const core = ArticleCoreModule.register(DatabaseModule.register(database));
  const attempt = (token: symbol) => Test.createTestingModule({ imports: [core], providers: [
    { provide: PORT, inject: [token], useFactory: (value: unknown) => value },
  ] }).overrideProvider(DATABASE).useValue(database).compile();
  try {
    await expect(attempt(ARTICLE_REPOSITORY)).rejects.toThrow(/ARTICLE_REPOSITORY/);
    const context = await attempt(ARTICLE_SERVICE);
    try { expect(context.get(PORT)).toBe(context.get(ARTICLE_SERVICE)); }
    finally { await context.close(); }
  } finally { await database.$disconnect(); }
});

test('設定在組裝時驗證且複製為唯讀快照，不因呼叫端後續修改而改變', () => {
  const input = { maxBodyBytes: 256, bodyTimeoutMs: 100 };
  const options = resolveHttpOptions(input);
  input.maxBodyBytes = 1;
  expect(options.maxBodyBytes).toBe(256);
  expect(Object.isFrozen(options)).toBe(true);
  expect(resolveHttpOptions({}).maxBodyBytes).toBe(16 * 1024);
  for (const value of [0, -1, 1.5, NaN, Infinity]) {
    expect(() => resolveHttpOptions({ bodyTimeoutMs: value })).toThrow('HTTP 限制');
  }
});

test('抽出流程協調者後，兩個葉模組不互相依賴，也能依序完成流程', async () => {
  // 獨立教學實驗，不新增文章 API、通知功能或背景工作。
  const WRITE = Symbol('WRITE'); const NOTICE = Symbol('NOTICE'); const FLOW = Symbol('FLOW');
  @Module({}) class WriteModule {}
  @Module({}) class NoticeModule {}
  const events: string[] = [];
  const writer: DynamicModule = { module: WriteModule, providers: [{ provide: WRITE, useValue: async () => { events.push('write'); return 'a_demo'; } }], exports: [WRITE] };
  const notice: DynamicModule = { module: NoticeModule, providers: [{ provide: NOTICE, useValue: async (id: string) => { events.push(`notice:${id}`); } }], exports: [NOTICE] };
  const context = await Test.createTestingModule({ imports: [writer, notice], providers: [{
    provide: FLOW, inject: [WRITE, NOTICE],
    useFactory: (write: () => Promise<string>, notify: (id: string) => Promise<void>) => async () => { await notify(await write()); },
  }] }).compile();
  try { await context.get<() => Promise<void>>(FLOW)(); expect(events).toEqual(['write', 'notice:a_demo']); }
  finally { await context.close(); }
});
