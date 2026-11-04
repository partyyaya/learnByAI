import { expect, test } from '@jest/globals';
import express from 'express';
import supertest from 'supertest';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs';
import { setImmediate as immediate } from 'node:timers/promises';
import { errorHandler, type ErrorReport } from '../src/errors.js';
import { requestContext } from '../src/request-context.js';
import { HttpError } from '../src/http.js';

// 故障路由只存在於測試 app，不掛到文章 API。
function laboratory() {
  const reports: ErrorReport[] = [];
  const app = express(); app.use(requestContext());
  app.get('/sync', () => { throw new Error('SECRET connection string'); });
  app.get('/async', async () => { await immediate(); throw new Error('SECRET query'); });
  app.get('/callback', (_req, _res, next) => { readFile('/nonexistent-course-fixture', error => { if (error) next(error); }); });
  app.get('/event', (_req, _res, next) => {
    const emitter = new EventEmitter(); emitter.once('error', next); emitter.emit('error', new Error('SECRET event'));
  });
  app.get('/expected', () => { throw new HttpError(409, 'VERSION_CONFLICT', '文章已更新'); });
  app.get('/untrusted', () => { throw { status: 418, message: 'SECRET message' }; });
  app.get('/partial', async (_req, res) => { res.write('partial content'); await immediate(); throw new Error('SECRET late failure'); });
  app.get('/ended', (_req, res, next) => { res.json({ data: 'sent once' }); next(new Error('late')); });
  app.use(errorHandler(report => reports.push(report)));
  return { app, reports };
}

test.each(['sync', 'async', 'callback', 'event', 'untrusted'])('%s：500 有穩定 JSON、request ID，不洩漏內部錯誤', async path => {
  const { app, reports } = laboratory();
  const response = await supertest(app).get(`/${path}`).expect(500).expect('Content-Type', /json/);
  expect(response.body).toEqual({ error: { code: 'INTERNAL_ERROR', message: '內部錯誤', details: [] }, requestId: response.headers['x-request-id'] });
  expect(JSON.stringify(response.body)).not.toContain('SECRET');
  expect(reports).toEqual([{ requestId: response.headers['x-request-id'], status: 500, code: 'INTERNAL_ERROR', phase: 'before-response' }]);
});
test('可預期錯誤保留 HTTP 狀態與公開代碼', async () => {
  const { app } = laboratory();
  const response = await supertest(app).get('/expected').expect(409);
  expect(response.body.error.code).toBe('VERSION_CONFLICT');
});
test('部分內容送出後中斷傳輸，不偽裝成第二份 JSON 回應', async () => {
  const { app, reports } = laboratory();
  await expect(supertest(app).get('/partial').timeout(2000)).rejects.toThrow();
  expect(reports).toHaveLength(1); expect(reports[0].phase).toBe('streaming');
});
test('已 end 後的錯誤不再寫入第二份回應', async () => {
  const { app, reports } = laboratory();
  const result = await supertest(app).get('/ended').expect(200);
  expect(result.body).toEqual({ data: 'sent once' });
  expect(reports).toHaveLength(1); expect(reports[0].phase).toBe('ended');
});
