import { expect, test } from '@jest/globals';
import supertest from 'supertest';
import { createValidationLab, UncheckedDraftDto, ValidationLabController } from '../src/validation-lab.js';

test('class DTO 有 metadata 也不會自動驗證 JSON 或建立 class instance', async () => {
  const app = await createValidationLab();
  try {
    expect(Reflect.getMetadata('design:paramtypes', ValidationLabController.prototype, 'unchecked')).toEqual([UncheckedDraftDto]);
    const invalid = { title: 123, content: 'x', extra: true };
    const result = await supertest(app.getHttpServer()).post('/validation/unchecked').send(invalid).expect(200);
    expect(result.body).toEqual({ data: invalid, classInstance: false });
  } finally { await app.close(); }
});

test('綁定 Pipe 後拒絕同一非法輸入；合法 DTO 修剪字串但不覆寫 raw body', async () => {
  const app = await createValidationLab();
  try {
    const api = supertest(app.getHttpServer());
    await api.post('/validation/checked').send({ title: 123, content: 'x' }).expect(400);
    const result = await api.post('/validation/checked').send({ title: ' 標題 ', content: ' 本文 ' }).expect(200);
    expect(result.body).toEqual({ data: { title: '標題', content: '本文' }, rawTitle: ' 標題 ' });
  } finally { await app.close(); }
});

test('Query DTO 的數字與預設值是 Pipe 回傳值，原 query 仍是字串或缺少欄位', async () => {
  const app = await createValidationLab();
  try {
    const api = supertest(app.getHttpServer());
    expect((await api.get('/validation/query?page=2&pageSize=3').expect(200)).body).toEqual({
      data: { page: 2, pageSize: 3 }, raw: { page: '2', pageSize: '3' },
    });
    expect((await api.get('/validation/query').expect(200)).body).toEqual({ data: { page: 1, pageSize: 20 }, raw: {} });
  } finally { await app.close(); }
});

test('獨立 nullable 實驗區分省略、null、字串及空字串，沒有更改文章 schema', async () => {
  const app = await createValidationLab();
  try {
    const api = supertest(app.getHttpServer());
    expect((await api.post('/validation/nullable').send({}).expect(200)).body).toEqual({ data: {}, hasNickname: false });
    expect((await api.post('/validation/nullable').send({ nickname: null }).expect(200)).body).toEqual({ data: { nickname: null }, hasNickname: true });
    expect((await api.post('/validation/nullable').send({ nickname: ' 小明 ' }).expect(200)).body).toEqual({ data: { nickname: '小明' }, hasNickname: true });
    for (const nickname of ['', '   ', false, 123]) await api.post('/validation/nullable').send({ nickname }).expect(400);
    await api.post('/validation/checked').send({ title: null, content: 'x' }).expect(400);
  } finally { await app.close(); }
});
