import { expect, test } from '@jest/globals';
import type { Server } from 'node:http';
import supertest from 'supertest';

// 只依賴 HTTP，不匯入 Express、Prisma 或應用內部型別。
// 每個案例開始前須重建 a_1、a_2、a_draft，並提供獨立匯出檔；見 BASELINE.md。
export function migrationContract(getServer: () => Server, exportText: string) {
  const api = () => supertest(getServer());
  const managed = '/api/me/articles/a_1';
  function errorEnvelope(response: { body: any; headers: Record<string, string> }, code: string) {
    expect(response.body).toEqual({ error: { code, message: expect.any(String), details: expect.any(Array) }, requestId: response.headers['x-request-id'] });
    expect(response.headers['x-request-id']).toEqual(expect.any(String));
    expect(response.headers['x-request-id'].length).toBeGreaterThan(0);
  }

  test('[B01] 文章欄位與日期格式固定，建立後可由 Location 讀回相同資料', async () => {
    const created = await api().post('/api/articles').send({ title: ' 新文章 ', content: ' 內文 ' }).expect(201);
    const row = created.body.data;
    expect(created.body).toEqual({ data: {
      id: expect.any(String), authorId: 'u_demo', title: '新文章', content: '內文', status: 'draft', version: 1,
      createdAt: expect.any(String), updatedAt: expect.any(String),
    } });
    for (const date of [row.createdAt, row.updatedAt]) expect(new Date(date).toISOString()).toBe(date);
    expect(created.headers.location).toBe(`/api/me/articles/${row.id}`);
    expect((await api().get(created.headers.location).expect(200)).body).toEqual(created.body);
  });

  test('[B02] 管理分頁包含草稿，公開列表排除草稿，超出頁數仍回正確 total', async () => {
    const publicList = await api().get('/api/articles').expect(200);
    expect(publicList.body.meta).toEqual({ page: 1, pageSize: 20, total: 2 });
    expect(publicList.body.data.map((row: { id: string }) => row.id)).toEqual(['a_1', 'a_2']);
    const managedList = await api().get('/api/me/articles?page=3&pageSize=1').expect(200);
    expect(managedList.body.meta).toEqual({ page: 3, pageSize: 1, total: 3 });
    expect(managedList.body.data.map((row: { id: string }) => row.id)).toEqual(['a_draft']);
    expect((await api().get('/api/articles?page=99&pageSize=1').expect(200)).body).toEqual({ data: [], meta: { page: 99, pageSize: 1, total: 2 } });
  });

  test('[B03] PATCH 只修改 content，保留 title；失敗寫入不改變文章', async () => {
    const before = (await api().get(managed).expect(200)).body.data;
    const changed = (await api().patch('/api/articles/a_1').send({ content: '只改內文', expectedVersion: 1 }).expect(200)).body.data;
    expect(changed).toMatchObject({ title: before.title, content: '只改內文', status: 'published', version: 2, createdAt: before.createdAt });
    errorEnvelope(await api().patch('/api/articles/a_1').send({ title: '不應寫入', expectedVersion: 1 }).expect(409), 'VERSION_CONFLICT');
    expect((await api().get(managed).expect(200)).body.data).toEqual(changed);
  });

  test('[B04] 封存後公開 404、管理可讀；舊版本先報衝突，最新版本報非法狀態', async () => {
    const archived = (await api().post('/api/articles/a_1/archive').send({ expectedVersion: 1 }).expect(200)).body.data;
    expect(archived).toMatchObject({ status: 'archived', version: 2 });
    errorEnvelope(await api().get('/api/articles/a_1').expect(404), 'NOT_FOUND');
    errorEnvelope(await api().post('/api/articles/a_1/publish').send({ expectedVersion: 1 }).expect(409), 'VERSION_CONFLICT');
    for (const action of ['publish', 'archive']) errorEnvelope(await api().post(`/api/articles/a_1/${action}`).send({ expectedVersion: 2 }).expect(409), 'INVALID_STATE');
    expect((await api().get(managed).expect(200)).body.data).toEqual(archived);
  });

  test('[B05] 已公開不能重複發佈，草稿可直接封存', async () => {
    errorEnvelope(await api().post('/api/articles/a_1/publish').send({ expectedVersion: 1 }).expect(409), 'INVALID_STATE');
    const archived = await api().post('/api/articles/a_draft/archive').send({ expectedVersion: 1 }).expect(200);
    expect(archived.body.data).toMatchObject({ status: 'archived', version: 2 });
    expect((await api().get(managed).expect(200)).body.data.version).toBe(1);
  });

  test.each([
    ['空 PATCH', { expectedVersion: 1 }],
    ['null', { title: null, expectedVersion: 1 }],
    ['缺少版本', { title: 'x' }],
    ['字串版本', { title: 'x', expectedVersion: '1' }],
    ['零版本', { title: 'x', expectedVersion: 0 }],
    ['小數版本', { title: 'x', expectedVersion: 1.5 }],
    ['未知欄位', { title: 'x', expectedVersion: 1, authorId: 'other' }],
  ])('[B06] PATCH 驗證：%s，拒絕後資料完全不變', async (_label, input) => {
    const before = (await api().get(managed).expect(200)).body;
    const result = await api().patch('/api/articles/a_1').send(input).expect(400);
    errorEnvelope(result, 'VALIDATION_ERROR');
    expect(result.body.error.details.length).toBeGreaterThan(0);
    expect((await api().get(managed).expect(200)).body).toEqual(before);
  });

  test.each(['page=0', 'page=1&page=2', 'page=1e2', 'pageSize=101', 'sort=title'])('[B07] 非白名單或不合法 query：%s', async query => {
    errorEnvelope(await api().get(`/api/articles?${query}`).expect(400), 'VALIDATION_ERROR');
  });

  test('[B08] Unicode 長度按 code point；未知欄位不原樣回傳，拒絕不新增文章', async () => {
    const title = '🙂'.repeat(120);
    expect((await api().post('/api/articles').send({ title, content: 'x' }).expect(201)).body.data.title).toBe(title);
    await api().post('/api/articles').send({ title: `${title}🙂`, content: 'x' }).expect(400);
    const invalid = await api().post('/api/articles').send({ title: 'x', content: 'y', SECRET_FIELD: 'SECRET_VALUE' }).expect(400);
    errorEnvelope(invalid, 'VALIDATION_ERROR');
    expect(invalid.body.error.details).toContainEqual({ field: 'body', code: 'UNKNOWN_FIELDS', message: '包含不允許的欄位' });
    expect(JSON.stringify(invalid.body)).not.toContain('SECRET');
    expect((await api().get('/api/me/articles').expect(200)).body.meta.total).toBe(4);
  });

  test('[B09] parser 錯誤分類與 16 KiB body 上限', async () => {
    errorEnvelope(await api().post('/api/articles').set('Content-Type', 'application/json').send('{').expect(400), 'INVALID_JSON');
    // Express 的 strict JSON parser 拒絕頂層 primitive；陣列則由 schema 拒絕。
    for (const primitive of ['null', 'true', '1', '"text"']) {
      errorEnvelope(await api().post('/api/articles').set('Content-Type', 'application/json').send(primitive).expect(400), 'INVALID_JSON');
    }
    errorEnvelope(await api().post('/api/articles').send([]).expect(400), 'VALIDATION_ERROR');
    errorEnvelope(await api().post('/api/articles').set('Content-Type', 'text/plain').send('{}').expect(415), 'UNSUPPORTED_MEDIA_TYPE');
    errorEnvelope(await api().post('/api/articles').set('Content-Encoding', 'gzip').send({ title: 'x', content: 'y' }).expect(415), 'UNSUPPORTED_ENCODING');
    // 欄位本身合法，但 JSON 加上空白後超出 byte 上限；不能以 Zod 長度取代 body 上限。
    const json = JSON.stringify({ title: 'x', content: 'y' });
    await api().post('/api/articles/preview').set('Content-Type', 'application/json').send(json + ' '.repeat(16 * 1024 - Buffer.byteLength(json))).expect(200);
    const body = json + ' '.repeat(16 * 1024);
    errorEnvelope(await api().post('/api/articles').set('Content-Type', 'application/json').send(body).expect(413), 'PAYLOAD_TOO_LARGE');
    expect((await api().get('/api/me/articles').expect(200)).body.meta.total).toBe(3);
  });

  test('[B10] preview 修剪輸入但不新增資料，固定路徑不落入文章 ID', async () => {
    const result = await api().post('/api/articles/preview').send({ title: ' 預覽 ', content: ' 內文 ' }).expect(200);
    expect(result.body).toEqual({ data: { title: '預覽', content: '內文', status: 'draft', preview: true } });
    expect((await api().get('/api/me/articles').expect(200)).body.meta.total).toBe(3);
    await api().get('/api/articles/preview').expect(405).expect('Allow', 'POST');
  });

  test.each([
    ['/api/articles', 'GET, HEAD, POST'], ['/api/articles/a_1', 'GET, HEAD, PATCH'],
    ['/api/articles/a_1/publish', 'POST'], ['/api/me/articles', 'GET, HEAD'],
    ['/api/articles/export', 'GET, HEAD'],
  ])('[B11] 不支援的方法回 405 與 Allow：%s', async (path, allow) => {
    errorEnvelope(await api().delete(path).expect(405).expect('Allow', allow), 'METHOD_NOT_ALLOWED');
  });

  test('[B12] 未知路徑、大小寫、詳細路徑尾斜線與無效 percent encoding', async () => {
    for (const path of ['/missing', '/api/Articles/a_1', '/api/articles/a_1/']) {
      errorEnvelope(await api().get(path).expect(404), 'NOT_FOUND');
    }
    errorEnvelope(await api().get('/api/articles/%ZZ').expect(400), 'INVALID_URL');
    expect((await api().get('/api/articles/').expect(200)).body).toEqual((await api().get('/api/articles').expect(200)).body);
  });

  test('[B13] GET 與 HEAD 的狀態／長度一致，HEAD 成功與錯誤都沒有 body', async () => {
    for (const path of ['/api/articles/a_1', '/api/articles/a_draft']) {
      const get = await api().get(path);
      const head = await api().head(path).expect(get.status);
      expect(head.text).toBeUndefined();
      expect(head.headers['content-length']).toBe(get.headers['content-length']);
      expect(head.headers['content-type']).toMatch(/application\/json/);
    }
  });

  test('[B14] request ID 由伺服器產生；錯誤 body 與 header 一致', async () => {
    const first = await api().get('/missing').set('X-Request-ID', 'untrusted-client-id').expect(404);
    errorEnvelope(first, 'NOT_FOUND');
    expect(first.headers['x-request-id']).not.toBe('untrusted-client-id');
    const second = await api().get('/health/live').expect(200);
    expect(second.body).toEqual({ data: { status: 'ok' } });
    expect(second.headers['x-request-id']).toEqual(expect.any(String));
    expect(second.headers['x-request-id']).not.toBe(first.headers['x-request-id']);
    expect((await api().get('/health/ready').expect(200)).body).toEqual({ data: { status: 'ok' } });
  });

  test('[B15] 匯出是獨立 NDJSON，GET／HEAD metadata 相同且寫文章不改變檔案', async () => {
    await api().post('/api/articles').send({ title: '不應出現在檔案裡', content: 'database only' }).expect(201);
    const get = await api().get('/api/articles/export').expect(200).expect('Content-Type', /application\/x-ndjson/);
    // Supertest 對非 JSON MIME 可能回傳 Buffer；統一以 bytes 比對。
    const bytes = Buffer.isBuffer(get.body) ? get.body : Buffer.from(get.text);
    expect(bytes).toEqual(Buffer.from(exportText));
    expect(get.headers['content-disposition']).toBe('attachment; filename="articles.ndjson"');
    expect(Number(get.headers['content-length'])).toBe(Buffer.byteLength(exportText));
    const head = await api().head('/api/articles/export').expect(200);
    expect(head.text).toBeUndefined();
    expect(head.headers['content-length']).toBe(get.headers['content-length']);
    expect(head.headers['content-type']).toBe(get.headers['content-type']);
    errorEnvelope(await api().get('/api/articles/export?file=../../package.json').expect(400), 'VALIDATION_ERROR');
  });
}
