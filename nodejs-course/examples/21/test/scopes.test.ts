import { expect, test } from '@jest/globals';
import { ContextIdFactory } from '@nestjs/core';
import supertest from 'supertest';
import { createScopeLab, RequestStamp, RequestConsumer, SingletonStamp, STAMP_ALIAS, SECOND_STAMP } from '../src/scope-lab.js';

test('DEFAULT 跨請求共享；useExisting 別名與 useClass 另一個註冊不同', async () => {
  const app = await createScopeLab();
  try {
    const first = (await supertest(app.getHttpServer()).get('/scope').expect(200)).body;
    const second = (await supertest(app.getHttpServer()).get('/scope').expect(200)).body;
    expect(first.singleton).toBe(second.singleton);
    expect(first.singleton).toBe(first.alias);
    expect(first.secondSingleton).not.toBe(first.singleton);
    expect(first.secondSingleton).toBe(second.secondSingleton);
    expect(app.get(STAMP_ALIAS)).toBe(app.get(SingletonStamp));
    expect(app.get(SECOND_STAMP)).not.toBe(app.get(SingletonStamp));
  } finally { await app.close(); }
});

test('TRANSIENT 按消費者建立；singleton 消費者的實例跨請求不變', async () => {
  const app = await createScopeLab();
  try {
    const first = (await supertest(app.getHttpServer()).get('/scope').expect(200)).body;
    const second = (await supertest(app.getHttpServer()).get('/scope').expect(200)).body;
    expect(first.transientA).not.toBe(first.transientB);
    expect(first.transientA).toBe(second.transientA);
    expect(first.transientB).toBe(second.transientB);
    expect(first.transientController).not.toBe(second.transientController);
  } finally { await app.close(); }
});

test('並行 HTTP 請求隔離 REQUEST，scope 沿 Consumer 到 Controller 傳遞', async () => {
  const app = await createScopeLab();
  try {
    const labels = ['alpha', 'beta', 'gamma', 'delta'];
    const responses = await Promise.all(labels.map(label => supertest(app.getHttpServer()).get('/scope').set('X-Lab-Label', label).expect(200)));
    for (const [index, response] of responses.entries()) {
      expect(response.body.label).toBe(labels[index]);
      expect(response.body.request).toBe(response.body.requestViaConsumer);
    }
    for (const key of ['request', 'requestConsumer', 'controller']) {
      expect(new Set(responses.map(response => response.body[key])).size).toBe(labels.length);
    }
    expect(new Set(responses.map(response => response.body.singleton)).size).toBe(1);
  } finally { await app.close(); }
});

test('get 不適合 REQUEST；resolve 共用 context 時共用同一依賴樹', async () => {
  const app = await createScopeLab();
  try {
    expect(() => app.get(RequestStamp)).toThrow();
    const firstContext = ContextIdFactory.create();
    const secondContext = ContextIdFactory.create();
    app.registerRequestByContextId({ headers: { 'x-lab-label': 'first' } }, firstContext);
    app.registerRequestByContextId({ headers: { 'x-lab-label': 'second' } }, secondContext);
    const first = await app.resolve(RequestStamp, firstContext);
    expect(await app.resolve(RequestStamp, firstContext)).toBe(first);
    expect((await app.resolve(RequestConsumer, firstContext)).stamp).toBe(first);
    const second = await app.resolve(RequestStamp, secondContext);
    expect(second).not.toBe(first);
    expect([first.label, second.label]).toEqual(['first', 'second']);
  } finally { await app.close(); }
});

test('singleton 的範圍是應用容器，另一個 app 不共用該實例', async () => {
  const first = await createScopeLab();
  try {
    const second = await createScopeLab();
    try { expect(first.get(SingletonStamp)).not.toBe(second.get(SingletonStamp)); }
    finally { await second.close(); }
  } finally { await first.close(); }
});
