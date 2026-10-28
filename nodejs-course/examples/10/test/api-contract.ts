import { expect, test } from '@jest/globals';
import supertest from 'supertest';
import type { Server } from 'node:http';

// 10 章用記憶體實作，11 章把同一份契約接到真正 PostgreSQL。
export function articleContract(getServer: () => Server) {
  test('建立、Location、私有狀態可見範圍、PATCH、publish、archive', async () => {
    const api = supertest(getServer());
    const created = await api.post('/api/articles').send({ title: ' 契約 ', content: '內容' }).expect(201);
    const id = created.body.data.id; const path = `/api/articles/${id}`;
    expect(created.headers.location).toBe(`/api/me/articles/${id}`);
    expect(created.body.data).toMatchObject({ title: '契約', authorId: 'u_demo', status: 'draft', version: 1 });
    await api.get(path).expect(404);
    await api.get(created.headers.location).expect(200);
    const edited = await api.patch(path).send({ title: '修訂', expectedVersion: 1 }).expect(200);
    expect(edited.body.data).toMatchObject({ title: '修訂', content: '內容', version: 2 });
    await api.post(`${path}/publish`).send({ expectedVersion: 2 }).expect(200);
    await api.get(path).expect(200);
    await api.post(`${path}/archive`).send({ expectedVersion: 3 }).expect(200);
    await api.get(path).expect(404);
    const locked = await api.patch(path).send({ title: 'x', expectedVersion: 4 }).expect(409);
    expect(locked.body.error.code).toBe('INVALID_STATE');
  });
  test('JSON、schema、404、405、版本衝突的錯誤分類', async () => {
    const api = supertest(getServer());
    const malformed = await api.post('/api/articles').set('Content-Type', 'application/json').send('{').expect(400);
    expect(malformed.body.error.code).toBe('INVALID_JSON');
    const invalid = await api.post('/api/articles').send({ title: 'x', content: 'y', role: 'admin' }).expect(400);
    expect(invalid.body.error.code).toBe('VALIDATION_ERROR');
    expect(invalid.body.requestId).toBe(invalid.headers['x-request-id']);
    await api.get('/api/articles/missing').expect(404);
    await api.delete('/api/articles/a_1').expect(405).expect('Allow', 'GET, HEAD, PATCH');
    const stale = await api.patch('/api/articles/a_1').send({ title: 'x', expectedVersion: 99 }).expect(409);
    expect(stale.body.error.code).toBe('VERSION_CONFLICT');
  });
  test('公開分頁只計公開文章，HEAD 不帶 body', async () => {
    const api = supertest(getServer());
    const list = await api.get('/api/articles?page=2&pageSize=1').expect(200);
    expect(list.body).toMatchObject({ data: [{ id: 'a_2' }], meta: { page: 2, pageSize: 1, total: 2 } });
    const head = await api.head('/api/articles/a_1').expect(200);
    expect(head.text).toBeUndefined(); expect(Number(head.headers['content-length'])).toBeGreaterThan(0);
  });
}
