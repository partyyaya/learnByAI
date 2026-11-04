import { expect, test } from '@jest/globals';
import supertest from 'supertest';
import { createResponseLab } from '../src/response-lab.js';

test('三層 Interceptor 進入由外到內、值通知由內到外，成功值只投影一次', async () => {
  const { app, traces } = await createResponseLab();
  try {
    const result = await supertest(app.getHttpServer()).get('/responses/ok').expect(200);
    expect(result.body).toEqual({ data: { value: 7 } });
    const events = traces[0].events;
    expect(events.filter(value => value.endsWith(':before'))).toEqual(['global:before', 'controller:before', 'route:before']);
    expect(events.filter(value => value.endsWith(':next'))).toEqual(['route:next', 'controller:next', 'global:next']);
    for (const name of ['global', 'controller', 'route']) expect(events.filter(value => value === `${name}:finalize`)).toHaveLength(1);
    expect(events.at(-1)).toBe('response:finish');
  } finally { await app.close(); }
});

test.each([
  ['/responses/route-error', 'route'], ['/responses/controller-error', 'controller'], ['/outside/error', 'global'],
  ['/responses/pipe/bad', 'route'],
])('%s 只有最近的匹配 Filter 處理，不是逐層傳遞的鏈', async (path, scope) => {
  const { app, traces } = await createResponseLab();
  try {
    const response = await supertest(app.getHttpServer()).get(path).expect(422);
    expect(response.body).toEqual({ error: { code: 'LAB_REJECTED', handledBy: scope } });
    expect(traces[0].events.filter(value => value.startsWith('filter:'))).toEqual([`filter:${scope}`]);
    expect(traces[0].events.some(value => value.endsWith(':next'))).toBe(false);
    expect(traces[0].events).toContain('global:finalize');
  } finally { await app.close(); }
});

test('Guard 拒絕不進 Interceptor；route Filter 仍處理 Guard 錯誤', async () => {
  const { app, traces } = await createResponseLab();
  try {
    await supertest(app.getHttpServer()).get('/responses/denied').expect(422);
    expect(traces[0].events).toEqual(['middleware', 'guard:deny', 'filter:route', 'response:finish']);
  } finally { await app.close(); }
});

test('catchError 回傳 of 是刻意恢復成 200；外層看見 next，不會到 Filter', async () => {
  const { app, traces } = await createResponseLab();
  try {
    const result = await supertest(app.getHttpServer()).get('/responses/recovered').expect(200);
    expect(result.body).toEqual({ data: { recovered: true } });
    expect(traces[0].events).toContain('recover'); expect(traces[0].events).toContain('global:next');
    expect(traces[0].events.some(value => value.startsWith('filter:'))).toBe(false);
  } finally { await app.close(); }
});

test('手動 response 與 204 不被投影；HEAD 保留長度且沒有 body', async () => {
  const { app } = await createResponseLab(); const api = supertest(app.getHttpServer());
  try {
    expect((await api.get('/responses/raw').expect(200)).text).toBe('plain');
    expect((await api.get('/responses/empty').expect(204)).text).toBe('');
    const get = await api.get('/responses/ok').expect(200); const head = await api.head('/responses/ok').expect(200);
    expect(head.text).toBeUndefined(); expect(head.headers['content-length']).toBe(get.headers['content-length']);
  } finally { await app.close(); }
});

test('已開始傳輸時 Filter 中止串流，不追加第二份錯誤 JSON', async () => {
  const { app, traces } = await createResponseLab();
  try {
    await expect(supertest(app.getHttpServer()).get('/responses/partial').timeout(2000)).rejects.toThrow();
    expect(traces[0].outcome).toBe('close'); expect(traces[0].events).toContain('filter:controller');
  } finally { await app.close(); }
});

test('並行請求的 events 保留各自範圍，不共用可變的請求陣列', async () => {
  const { app, traces } = await createResponseLab(); const api = supertest(app.getHttpServer());
  try {
    await Promise.all([api.get('/responses/ok').expect(200), api.get('/responses/denied').expect(422)]);
    expect(traces.find(value => value.path === '/responses/ok')!.events).not.toContain('guard:deny');
    expect(traces.find(value => value.path === '/responses/denied')!.events).not.toContain('route:next');
  } finally { await app.close(); }
});
