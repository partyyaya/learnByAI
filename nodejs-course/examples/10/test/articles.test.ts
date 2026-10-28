import { expect, test } from '@jest/globals';
import { once } from 'node:events';
import { request } from 'node:http';
import { createArticleServer } from '../src/server.js';

async function start() {
  const server = createArticleServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  const port = address.port;
  function call(path: string, method = 'GET', input?: unknown) {
    return new Promise<{ status: number; body: any; headers: import('node:http').IncomingHttpHeaders }>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path, method, agent: false,
        headers: input === undefined ? {} : { 'Content-Type': 'application/json' } }, res => {
        let text = ''; res.on('data', chunk => { text += chunk; }); res.on('error', reject);
        res.on('end', () => {
          try { resolve({ status: res.statusCode!, body: text ? JSON.parse(text) : undefined, headers: res.headers }); }
          catch (error) { reject(error); }
        });
      }); req.on('error', reject); req.end(input === undefined ? undefined : JSON.stringify(input));
    });
  }
  return { call, close: () => server.lifecycle.shutdown() };
}

test('建立 → 管理查詢 → 部分修改 → 發佈 → 公開查詢 → 封存，維持版本與 Location 契約', async () => {
  const api = await start();
  try {
    const created = await api.call('/api/articles', 'POST', { title: ' 新文章 ', content: ' 內容 ' });
    expect(created.status).toBe(201);
    const article = created.body.data; const path = `/api/articles/${article.id}`;
    expect(article).toMatchObject({ authorId: 'u_demo', title: '新文章', content: '內容', status: 'draft', version: 1 });
    expect(new Date(article.createdAt).toISOString()).toBe(article.createdAt);
    expect(created.headers.location).toBe(`/api/me/articles/${article.id}`);
    expect((await api.call(created.headers.location!)).body.data).toEqual(article);
    expect((await api.call(path)).status).toBe(404);
    expect((await api.call('/api/articles')).body.meta.total).toBe(2);
    const edited = await api.call(path, 'PATCH', { title: '修訂', expectedVersion: 1 });
    expect(edited.status).toBe(200);
    expect(edited.body.data).toMatchObject({ title: '修訂', content: '內容', version: 2, status: 'draft', createdAt: article.createdAt });
    const published = await api.call(`${path}/publish`, 'POST', { expectedVersion: 2 });
    expect(published.status).toBe(200); expect(published.body.data.version).toBe(3);
    expect((await api.call(path)).body.data.status).toBe('published');
    expect((await api.call('/api/articles')).body.meta.total).toBe(3);
    const archived = await api.call(`${path}/archive`, 'POST', { expectedVersion: 3 });
    expect(archived.status).toBe(200); expect(archived.body.data).toMatchObject({ status: 'archived', version: 4 });
    expect((await api.call(path)).status).toBe(404);
    expect((await api.call('/api/articles')).body.meta.total).toBe(2);
    expect((await api.call(created.headers.location!)).body.data.status).toBe('archived');
  } finally { await api.close(); }
});

test('兩個相同版本的修改只有一個成功，衝突不覆蓋成功結果', async () => {
  const api = await start();
  try {
    const results = await Promise.all(['first', 'second'].map(title => api.call('/api/articles/a_1', 'PATCH', { title, expectedVersion: 1 })));
    expect(results.map(result => result.status).sort()).toEqual([200, 409]);
    expect(results.find(result => result.status === 409)?.body.error.code).toBe('VERSION_CONFLICT');
    expect((await api.call('/api/articles/a_1')).body.data).toEqual(results.find(result => result.status === 200)?.body.data);
  } finally { await api.close(); }
});

test.each([
  { expectedVersion: 1 }, { title: null, expectedVersion: 1 }, { title: '', expectedVersion: 1 },
  { title: 'x', expectedVersion: '1' }, { title: 'x', expectedVersion: 0 },
  { title: 'x', expectedVersion: 1, authorId: 'attacker' }, { title: 'x', expectedVersion: 1, status: 'published' },
])('非法 PATCH 不應修改資料：%j', async input => {
  const api = await start();
  try {
    const before = await api.call('/api/articles/a_1');
    expect((await api.call('/api/articles/a_1', 'PATCH', input)).status).toBe(400);
    expect((await api.call('/api/articles/a_1')).body).toEqual(before.body);
  } finally { await api.close(); }
});

test.each(['authorId', 'status', 'version', 'role'])('建立文章拒絕由用戶指定 %s', async key => {
  const api = await start();
  try {
    expect((await api.call('/api/articles', 'POST', { title: 'x', content: 'y', [key]: 'injected' })).status).toBe(400);
    expect((await api.call('/api/me/articles')).body.meta.total).toBe(3);
  } finally { await api.close(); }
});

test('重複發佈及封存後的編輯／發佈／封存均被拒絕', async () => {
  const api = await start();
  try {
    const repeated = await api.call('/api/articles/a_1/publish', 'POST', { expectedVersion: 1 });
    expect(repeated.status).toBe(409); expect(repeated.body.error.code).toBe('INVALID_STATE');
    expect((await api.call('/api/articles/a_draft/archive', 'POST', { expectedVersion: 1 })).status).toBe(200);
    for (const [suffix, method, input] of [
      ['', 'PATCH', { title: '不能修改', expectedVersion: 2 }],
      ['/publish', 'POST', { expectedVersion: 2 }], ['/archive', 'POST', { expectedVersion: 2 }],
    ] as const) {
      const result = await api.call(`/api/articles/a_draft${suffix}`, method, input);
      expect(result.status).toBe(409); expect(result.body.error.code).toBe('INVALID_STATE');
    }
  } finally { await api.close(); }
});

test('修改與狀態操作找不到文章時回 404', async () => {
  const api = await start();
  try {
    expect((await api.call('/api/articles/missing', 'PATCH', { title: 'x', expectedVersion: 1 })).status).toBe(404);
    expect((await api.call('/api/articles/missing/publish', 'POST', { expectedVersion: 1 })).status).toBe(404);
  } finally { await api.close(); }
});

test('管理列表含草稿，公開分頁總數不洩漏草稿；超過頁數回空列表', async () => {
  const api = await start();
  try {
    expect((await api.call('/api/me/articles')).body.data.map((a: { id: string }) => a.id)).toEqual(['a_1', 'a_2', 'a_draft']);
    expect((await api.call('/api/articles?page=99')).body).toEqual({ data: [], meta: { page: 99, pageSize: 20, total: 2 } });
  } finally { await api.close(); }
});

test('記憶體資料隔離於服務實例，新實例不會繼承另一個實例建立的文章', async () => {
  const first = await start(); const second = await start();
  try {
    const created = await first.call('/api/articles', 'POST', { title: 'x', content: 'y' });
    expect((await first.call(created.headers.location!)).status).toBe(200);
    expect((await second.call(created.headers.location!)).status).toBe(404);
  } finally { await first.close(); await second.close(); }
});

test('未提供文章永久刪除，已知路由回 405；未知路徑回 404', async () => {
  const api = await start();
  try {
    const result = await api.call('/api/articles/a_1', 'DELETE');
    expect(result.status).toBe(405); expect(result.headers.allow).toBe('GET, HEAD, PATCH');
    expect((await api.call('/api/articles/a_1/unknown', 'POST', {})).status).toBe(404);
    expect((await api.call('/api/articles/%ZZ')).status).toBe(400);
  } finally { await api.close(); }
});
