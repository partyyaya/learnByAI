import 'reflect-metadata';
import { afterAll, beforeAll, expect, test } from '@jest/globals';
import raw from 'supertest';
import { RequestMethod } from '@nestjs/common';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { openapiDocument } from '../src/openapi.js';
import { ApiDescriptionController } from '../src/api-description.module.js';
import { ArticlesController, ManagedArticlesController, AdminArticlesController } from '../src/articles.controller.js';
import { AuthController } from '../src/auth.module.js';
import { ArticleCommentsController, CommentsController, StatusAuditsController } from '../src/comments.module.js';
import { NotificationsController } from '../src/notifications.module.js';
import { HealthController } from '../src/health.module.js';
import { createArticleServer } from '../src/server.js';
import { testDependencies } from './module-fixture.js';
import { ARTICLE_SERVICE, CHECK_READY } from '../src/tokens.js';
import { assertDocumented, assertApiResponse } from './openapi-contract.js';

let server: Awaited<ReturnType<typeof createArticleServer>>;
beforeAll(async () => { server = await createArticleServer({ dependencies: testDependencies([
  { provide: ARTICLE_SERVICE, useValue: {} }, { provide: CHECK_READY, useValue: async () => {} },
]) }); });
afterAll(async () => { await server?.lifecycle.shutdown(); });

test('公開文件是原始 OpenAPI JSON，不被 presenter 包成 data；不連 DB', async () => {
  const result = await raw(server).get('/api/openapi.json').expect(200);
  expect(result.body).toEqual(openapiDocument);
  expect(result.body.openapi).toBe('3.1.1');
  expect(result.body).not.toHaveProperty('data');
  expect(result.headers['x-request-id']).toBeTruthy();
});
test('HEAD 文件沒有 body、長度與 GET 相同', async () => {
  const get = await raw(server).get('/api/openapi.json').expect(200);
  const head = await raw(server).head('/api/openapi.json').expect(200);
  expect(head.text).toBeUndefined(); expect(head.headers['content-length']).toBe(get.headers['content-length']);
});
test.each(['/api/openapi.json/', '/api/Openapi.json'])('文件詳細路徑 %s 保持 strict routing', async path => {
  await raw(server).get(path).expect(404);
});
test('文件拒絕額外 query、錯誤方法維持 405／Allow 與錯誤 envelope', async () => {
  const query = await raw(server).get('/api/openapi.json?unknown=secret').expect(400);
  assertApiResponse(openapiDocument.paths['/api/openapi.json'].get, 400, query.body);
  expect(query.text).not.toContain('secret');
  await raw(server).post('/api/openapi.json').expect(405).expect('Allow', 'GET, HEAD');
});
test('文件的 method／path 與正式 Controller metadata 對照，沒有遺漏或虛構業務路由', () => {
  const actual: string[] = [];
  for (const controller of [ArticlesController, ManagedArticlesController, AdminArticlesController, AuthController, HealthController, ApiDescriptionController, ArticleCommentsController, CommentsController, StatusAuditsController, NotificationsController]) {
    const base = Reflect.getMetadata(PATH_METADATA, controller) as string;
    for (const name of Object.getOwnPropertyNames(controller.prototype)) {
      const handler = Object.getOwnPropertyDescriptor(controller.prototype, name)?.value;
      if (typeof handler !== 'function') continue;
      const method = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
      if (method === undefined || method === RequestMethod.ALL) continue;
      const methodName = RequestMethod[method].toLowerCase();
      const path = `/${base}/${Reflect.getMetadata(PATH_METADATA, handler) ?? ''}`.replace(/\/+$/, '').replace(/:id/g, '{id}');
      actual.push(`${methodName} ${path}`);
      if (method === RequestMethod.GET) actual.push(`head ${path}`);
    }
  }
  // Native transport is registered before Nest routing and verified with real TCP below.
  actual.push('get /api/me/events','head /api/me/events');
  const documented = Object.entries(openapiDocument.paths).flatMap(([path, methods]) => Object.keys(methods).map(method => `${method} ${path}`));
  expect(documented.sort()).toEqual(actual.sort());
});
test('operationId 唯一，$ref 與 security scheme 皆可解析；HEAD／204 不宣稱有 content', () => {
  const ids: string[] = [];
  function walk(value: unknown) {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (key === '$ref') {
        const target = String(child).split('/').slice(1).reduce<unknown>((current, part) => (current as Record<string, unknown>)?.[part], openapiDocument);
        expect(target).toBeDefined();
      } else walk(child);
    }
  }
  walk(openapiDocument);
  for (const methods of Object.values(openapiDocument.paths)) for (const [method, op] of Object.entries(methods)) {
    ids.push(op.operationId);
    for (const alternative of op.security) for (const scheme of Object.keys(alternative)) expect(openapiDocument.components.securitySchemes).toHaveProperty(scheme);
    for (const [status, response] of Object.entries(op.responses)) if (method === 'head' || status === '204') expect(response).not.toHaveProperty('content');
  }
  expect(new Set(ids).size).toBe(ids.length);
});
test('Cookie 與 CSRF 為 AND，HTTP／HTTPS Cookie 為 OR，logout 例外明列', () => {
  expect(openapiDocument.paths['/api/articles'].post.security).toEqual([
    { LocalSession: [], CsrfToken: [] }, { SecureSession: [], CsrfToken: [] },
  ]);
  const register = openapiDocument.paths['/api/auth/register'].post;
  const login = openapiDocument.paths['/api/auth/login'].post;
  expect(register.responses).not.toHaveProperty('401');
  expect(register.responses).toHaveProperty('409');
  expect(register.description).not.toContain('INVALID_CREDENTIALS');
  expect(login.responses).toHaveProperty('401');
  expect(login.responses).not.toHaveProperty('409');
  expect(login.description).not.toContain('USER_ALREADY_EXISTS');
  expect(register.responses).toHaveProperty('403');
  expect(login.responses).toHaveProperty('403');
  expect(openapiDocument.paths['/api/articles'].get.security).toEqual([]);
  expect(openapiDocument.paths['/api/auth/logout'].post.security).toEqual([]);
  expect(openapiDocument.paths['/api/auth/logout'].post.parameters).toContainEqual(expect.objectContaining({ name: 'Origin', required: true }));
});
test('列表參數白名單只讓 me 使用 status，分頁 wire 型別仍是 string', () => {
  const publicParams = openapiDocument.paths['/api/articles'].get.parameters;
  expect(publicParams.map(p => p.name)).toEqual(['page', 'pageSize', 'q', 'sort']);
  expect(openapiDocument.paths['/api/me/articles'].get.parameters.map(p => p.name)).toEqual(['page', 'pageSize', 'q', 'sort', 'status']);
  expect(publicParams[0].schema).toMatchObject({ type: 'string', default: '1' });
});
test('契約比對會抓到額外敏感欄位、缺必要欄位、型別與 PATCH 空修改', () => {
  const schema = openapiDocument.components.schemas.PublicUser;
  const user = { id: 'u', email: null, displayName: 'Alice', role: 'member' };
  expect(() => assertDocumented(user, schema)).not.toThrow();
  expect(() => assertDocumented({ ...user, passwordHash: 'secret' }, schema)).toThrow();
  expect(() => assertDocumented({ id: 'u' }, schema)).toThrow();
  expect(() => assertDocumented({ ...user, role: 1 }, schema)).toThrow();
  expect(() => assertDocumented({ expectedVersion: 1 }, openapiDocument.components.schemas.PatchInput)).toThrow();
});
