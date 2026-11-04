import { expect, test } from '@jest/globals';
import { catchError, defer, finalize, firstValueFrom, from, map, Observable, of, tap, throwError } from 'rxjs';
import { errorResponse } from '../src/errors.js';
import { HttpError } from '../src/http.js';

test('map 改變輸出，tap 的 return 不改值；沒有 subscribe 時 defer 不執行', async () => {
  let calls = 0; const observed: number[] = [];
  const source = defer(() => { calls++; return of(3); }).pipe(tap(value => { observed.push(value); return 99; }), map(value => value * 2));
  expect(calls).toBe(0); expect(await firstValueFrom(source)).toBe(6);
  expect(observed).toEqual([3]); expect(calls).toBe(1);
  await firstValueFrom(source); expect(calls).toBe(2); // 額外訂閱可能重做 handler／寫入，不在 Interceptor 自行 subscribe。
});

test('catchError 用 throwError 保留錯誤，of 則恢復；finalize 不代表成功', async () => {
  const failure = new Error('SECRET'); let completed = 0;
  await expect(firstValueFrom(throwError(() => failure).pipe(catchError(error => throwError(() => error)), finalize(() => { completed++; }))))
    .rejects.toBe(failure);
  expect(completed).toBe(1);
  expect(await firstValueFrom(throwError(() => failure).pipe(catchError(() => of('fallback'))))).toBe('fallback');
});

test('明確 unsubscribe 也執行 finalize，且 Observable 的 teardown 會呼叫', () => {
  let tornDown = 0; let finalized = 0;
  const subscription = new Observable<never>(() => () => { tornDown++; }).pipe(finalize(() => { finalized++; })).subscribe();
  subscription.unsubscribe(); subscription.unsubscribe();
  expect(tornDown).toBe(1); expect(finalized).toBe(1);
});

test('from(Promise) 取消訂閱不取消原本的工作，不能把 finalize 當資料庫已停止', async () => {
  let release!: () => void; let finished = false; let finalized = false; let delivered = false;
  const work = new Promise<void>(resolve => { release = resolve; }).then(() => { finished = true; return 7; });
  const subscription = from(work).pipe(finalize(() => { finalized = true; })).subscribe(() => { delivered = true; });
  subscription.unsubscribe(); expect(finalized).toBe(true); expect(finished).toBe(false);
  release(); await work; expect(finished).toBe(true); expect(delivered).toBe(false);
});

test('錯誤回應投影複製安全 details，不回傳附帶的內部欄位，也不修改原錯誤', () => {
  const detail = { field: 'body.title', code: 'INVALID_VALUE', message: '欄位不合法', input: 'SECRET' };
  const error = new HttpError(400, 'VALIDATION_ERROR', '輸入不合法', [detail]);
  const result = errorResponse(error, 'r_test');
  expect(result.body.error.details).toEqual([{ field: 'body.title', code: 'INVALID_VALUE', message: '欄位不合法' }]);
  expect(JSON.stringify(result)).not.toContain('SECRET'); expect(detail.input).toBe('SECRET');
  expect(result.body.requestId).toBe('r_test');
});
