import { expect, test } from '@jest/globals';
import { z } from 'zod';
import { ZodValidationPipe } from '../src/zod-validation.pipe.js';
import { draftSchema, patchSchema, versionSchema, paginationSchema, idSchema } from '../src/schemas.js';
import { HttpError } from '../src/http.js';

test('schema 輸出修剪後 DTO，不修改原始物件；不依賴 metatype 反射', () => {
  const raw = Object.freeze({ title: ' 中文🙂 ', content: ' 本文 ' });
  const dto = new ZodValidationPipe(draftSchema).transform(raw, { type: 'body', metatype: Object });
  expect(dto).toEqual({ title: '中文🙂', content: '本文' });
  expect(dto).not.toBe(raw);
  expect(raw.title).toBe(' 中文🙂 ');
});

test('整個 query 補預設值與轉型；空字串不是省略', () => {
  const pipe = new ZodValidationPipe(paginationSchema);
  expect(pipe.transform({}, { type: 'query' })).toEqual({ page: 1, pageSize: 20 });
  expect(pipe.transform({ page: '0002', pageSize: '100' }, { type: 'query' })).toEqual({ page: 2, pageSize: 100 });
  expect(() => pipe.transform({ page: '' }, { type: 'query' })).toThrow(HttpError);
});

test.each(['1e2', '0x10', '1.5', '-1', '0', ' 2 ', '1000001', '9007199254740993', ['1', '2'], null, true, 2])(
  'query 不以寬鬆 Number coercion 接受 %j', value => {
    expect(() => new ZodValidationPipe(paginationSchema).transform({ page: value }, { type: 'query' })).toThrow(HttpError);
  },
);

test('未知欄位拒絕而非靜默剝除；錯誤只含安全的 field／code／message', () => {
  let error: unknown;
  try { new ZodValidationPipe(draftSchema).transform({ title: 'x', content: 'y', SECRET_NAME: 'SECRET_VALUE' }, { type: 'body' }); }
  catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(HttpError);
  expect((error as HttpError).details).toEqual([{ field: 'body', code: 'UNKNOWN_FIELDS', message: '包含不允許的欄位' }]);
  expect(JSON.stringify(error)).not.toContain('SECRET');
});

test('metadata 的 param 映射為契約 params；巢狀欄位保留完整路徑', () => {
  const schema = z.strictObject({ nested: z.strictObject({ count: z.number() }) });
  try { new ZodValidationPipe(schema).transform({ nested: { count: 'x' } }, { type: 'param' }); }
  catch (error) {
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).details[0].field).toBe('params.nested.count'); return;
  }
  throw new Error('應拒絕巢狀錯誤輸入');
});

test('PATCH 省略 title 不補預設值；只提供 expectedVersion 不算修改', () => {
  const pipe = new ZodValidationPipe(patchSchema);
  const dto = pipe.transform({ content: ' 新內容 ', expectedVersion: 1 }, { type: 'body' });
  expect(dto).toEqual({ content: '新內容', expectedVersion: 1 });
  expect(Object.hasOwn(dto, 'title')).toBe(false);
  expect(() => pipe.transform({ expectedVersion: 1 }, { type: 'body' })).toThrow(HttpError);
});

test.each([null, '', '   ', 42, false])('PATCH title=%j 不被 optional 略過', title => {
  expect(() => new ZodValidationPipe(patchSchema).transform({ title, expectedVersion: 1 }, { type: 'body' })).toThrow(HttpError);
});

test.each(['1', null, true, 1.5, 0, Number.MAX_SAFE_INTEGER + 1])('expectedVersion=%j 不自動轉成版本號', expectedVersion => {
  expect(() => new ZodValidationPipe(versionSchema).transform({ expectedVersion }, { type: 'body' })).toThrow(HttpError);
});

test('文章 ID 維持不透明字串；Unicode 長度按 code point 計算', () => {
  expect(new ZodValidationPipe(idSchema).transform({ id: 'a_demo' }, { type: 'param' })).toEqual({ id: 'a_demo' });
  const pipe = new ZodValidationPipe(draftSchema);
  expect(pipe.transform({ title: '🙂'.repeat(120), content: 'x' }, { type: 'body' }).title).toHaveLength(240);
  expect(() => pipe.transform({ title: '🙂'.repeat(121), content: 'x' }, { type: 'body' })).toThrow(HttpError);
});

test('錯誤綁定屬程式設定錯誤，不能偽裝成使用者的 400', () => {
  const pipe = new ZodValidationPipe(draftSchema);
  for (const metadata of [{ type: 'body' as const, data: 'title' }, { type: 'custom' as const }]) {
    expect(() => pipe.transform({}, metadata)).toThrow('必須綁定完整');
  }
});
