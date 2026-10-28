import { expect, test } from '@jest/globals';
import { once } from 'node:events';
import { request } from 'node:http';
import { createArticleServer } from '../src/server.js';
import type { RequestTrace } from '../src/request-context.js';
import { runLab } from '../src/middleware-lab.js';
import { paginationSchema } from '../src/schemas.js';

async function start() {
  const traces: RequestTrace[] = [];
  const server = createArticleServer({ onTrace: trace => traces.push(trace) });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  const port = address.port;
  function call(path: string, method = 'GET', text?: string, extra: Record<string, string> = {}) {
    return new Promise<{ status: number; body: any; headers: import('node:http').IncomingHttpHeaders }>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path, method, agent: false,
        headers: { ...(text === undefined ? {} : { 'Content-Type': 'application/json' }), ...extra } }, res => {
        let data = ''; res.on('data', chunk => { data += chunk; }); res.on('error', reject);
        res.on('end', () => {
          try { resolve({ status: res.statusCode!, body: data ? JSON.parse(data) : undefined, headers: res.headers }); }
          catch (error) { reject(error); }
        });
      }); req.on('error', reject); req.end(text);
    });
  }
  return { call, traces, close: () => server.lifecycle.shutdown() };
}

test('成功的建立依序解析、驗證、執行 handler；採用 schema 的 trim 輸出', async () => {
  const api = await start();
  try {
    const result = await api.call('/api/articles', 'POST', JSON.stringify({ title: '  中文🙂  ', content: ' 內容 ' }));
    expect(result.status).toBe(201); expect(result.body.data).toMatchObject({ title: '中文🙂', content: '內容' });
    expect(api.traces).toHaveLength(1);
    expect(api.traces[0]).toEqual({ requestId: result.headers['x-request-id'], outcome: 'finished', status: 201,
      steps: ['request', 'accept', 'router:articles', 'json:start', 'json:parsed', 'validate:body', 'handler:create', 'response:finish'] });
  } finally { await api.close(); }
});

test('JSON 語法失敗跳過 schema 與寫入；錯誤沿用相同 request ID', async () => {
  const api = await start();
  try {
    const result = await api.call('/api/articles', 'POST', '{');
    expect(result.status).toBe(400); expect(result.body.error.code).toBe('INVALID_JSON');
    expect(result.body.requestId).toBe(result.headers['x-request-id']);
    expect(api.traces[0].steps).toEqual(['request', 'accept', 'router:articles', 'json:start', 'error:INVALID_JSON', 'response:finish']);
    expect((await api.call('/api/me/articles')).body.meta.total).toBe(3);
  } finally { await api.close(); }
});

test('schema 失敗提供欄位線索，不進入 handler，也不回傳原始輸入', async () => {
  const api = await start();
  try {
    const result = await api.call('/api/articles', 'POST', JSON.stringify({ title: 123, content: 'PRIVATE_TEXT', role: 'PRIVATE_ROLE' }));
    expect(result.status).toBe(400);
    expect(result.body.error.details).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'body.title', code: 'INVALID_VALUE' }),
      expect.objectContaining({ field: 'body', code: 'UNKNOWN_FIELDS' }),
    ]));
    expect(JSON.stringify(result.body)).not.toContain('PRIVATE_');
    expect(api.traces[0].steps).toEqual(['request', 'accept', 'router:articles', 'json:start', 'json:parsed', 'validate:body', 'error:VALIDATION_ERROR', 'response:finish']);
    expect((await api.call('/api/me/articles')).body.meta.total).toBe(3);
  } finally { await api.close(); }
});

test('媒體類型在 parser 前拒絕，不會以 schema 失敗掩蓋 415', async () => {
  const api = await start();
  try {
    const result = await api.call('/api/articles', 'POST', '{}', { 'Content-Type': 'text/plain' });
    expect(result.status).toBe(415);
    expect(api.traces[0].steps).not.toContain('json:parsed');
    expect(api.traces[0].steps).not.toContain('validate:body');
  } finally { await api.close(); }
});

test('每個請求有自己的 ID 與紀錄，不直接採信外部 X-Request-ID', async () => {
  const api = await start();
  try {
    const results = await Promise.all([1, 2].map(() => api.call('/health/live', 'GET', undefined, { 'X-Request-ID': 'untrusted' })));
    const ids = results.map(result => result.headers['x-request-id']);
    expect(new Set(ids).size).toBe(2); expect(ids).not.toContain('untrusted');
    expect(api.traces).toHaveLength(2);
    for (const trace of api.traces) expect(trace.steps).toEqual(['request', 'accept', 'response:finish']);
  } finally { await api.close(); }
});

test.each(['', '1e2', '0x10', '+1', '-1', '1.5', ' 1', '9007199254740992'])('分頁拒絕寬鬆轉型輸入：%s', async value => {
  const api = await start();
  try {
    const result = await api.call(`/api/articles?page=${encodeURIComponent(value)}`);
    expect(result.status).toBe(400); expect(result.body.error.code).toBe('VALIDATION_ERROR');
    expect(api.traces[0].steps).not.toContain('handler:list');
  } finally { await api.close(); }
});

test('query schema 產生數字與預設值，但不改寫輸入物件', () => {
  const input = { page: '2', pageSize: '1' };
  expect(paginationSchema.parse(input)).toEqual({ page: 2, pageSize: 1 });
  expect(input).toEqual({ page: '2', pageSize: '1' });
  expect(paginationSchema.parse({})).toEqual({ page: 1, pageSize: 20 });
});

test.each([120, 121])('Unicode 標題以 code point 計數：%i 個 emoji', async length => {
  const api = await start();
  try {
    const result = await api.call('/api/articles/preview', 'POST', JSON.stringify({ title: '🙂'.repeat(length), content: 'x' }));
    expect(result.status).toBe(length === 120 ? 200 : 400);
  } finally { await api.close(); }
});

test('狀態操作也拒絕額外欄位；錯誤不改變文章版本', async () => {
  const api = await start();
  try {
    const result = await api.call('/api/articles/a_draft/publish', 'POST', '{"expectedVersion":1,"title":"injected"}');
    expect(result.status).toBe(400);
    expect((await api.call('/api/me/articles/a_draft')).body.data).toMatchObject({ status: 'draft', version: 1 });
  } finally { await api.close(); }
});

test('驗證輸入後仍須檢查目前版本；schema 不取代業務規則', async () => {
  const api = await start();
  try {
    const result = await api.call('/api/articles/a_1', 'PATCH', '{"title":"x","expectedVersion":99}');
    expect(result.status).toBe(409); expect(result.body.error.code).toBe('VERSION_CONFLICT');
    expect(api.traces[0].steps).toContain('handler:edit');
  } finally { await api.close(); }
});

test('next 後的程式先於非同步 handler 結束，不能當成完成通知', async () => {
  expect(await runLab('async')).toEqual(['before next', 'handler start', 'after next', 'handler end', 'response finish']);
});
test('直接回應且 return 時，不會執行後面的 handler', async () => {
  expect(await runLab('stop')).toEqual(['before next', 'short circuit', 'after next', 'response finish']);
});
test('next(error) 跳過一般 handler 並進入錯誤處理', async () => {
  expect(await runLab('error')).toEqual(['before next', 'next(error)', 'error handler', 'after next', 'response finish']);
});
