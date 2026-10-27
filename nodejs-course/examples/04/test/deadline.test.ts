import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { getEventListeners } from 'node:events';
import { TimeoutError, withDeadline } from '../src/deadline.js';

describe('等待期限與取消', () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

  test('成功後清除期限 timer 與父 signal listener', async () => {
    const parent = new AbortController();
    await expect(withDeadline(100, async () => 'ok', parent.signal)).resolves.toBe('ok');
    expect(jest.getTimerCount()).toBe(0);
    expect(getEventListeners(parent.signal, 'abort')).toHaveLength(0);
  });

  test('同步 throw 也能傳給呼叫端，並清除 timer', async () => {
    await expect(withDeadline(100, () => { throw new Error('sync failure'); })).rejects.toThrow('sync failure');
    expect(jest.getTimerCount()).toBe(0);
  });

  test('工作拒絕時保留原始錯誤', async () => {
    const error = new Error('lookup failed');
    await expect(withDeadline(100, async () => { throw error; })).rejects.toBe(error);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('期限到達時回傳 TimeoutError，並通知工作取消', async () => {
    let observed: AbortSignal | undefined;
    const work = withDeadline(20, (signal) => {
      observed = signal;
      return new Promise<string>(() => {});
    });
    const assertion = expect(work).rejects.toBeInstanceOf(TimeoutError);
    await jest.advanceTimersByTimeAsync(20);
    await assertion;
    expect(observed?.aborted).toBe(true);
    expect(getEventListeners(observed!, 'abort')).toHaveLength(0);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('已取消的父 signal 不會啟動工作', async () => {
    const parent = new AbortController();
    const reason = new Error('already cancelled');
    parent.abort(reason);
    const task = jest.fn(async () => 'should not run');
    await expect(withDeadline(100, task, parent.signal)).rejects.toBe(reason);
    expect(task).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  test('開始後收到父取消，保留原因並解除父 listener', async () => {
    const parent = new AbortController();
    let observed: AbortSignal | undefined;
    const work = withDeadline(100, (signal) => {
      observed = signal;
      return new Promise<string>(() => {});
    }, parent.signal);
    const reason = new Error('user cancelled');
    const assertion = expect(work).rejects.toBe(reason);
    await Promise.resolve();
    parent.abort(reason);
    await assertion;
    expect(observed?.reason).toBe(reason);
    expect(getEventListeners(parent.signal, 'abort')).toHaveLength(0);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('不配合 signal 的工作在呼叫端逾時後仍會完成', async () => {
    let completed = false;
    const work = withDeadline(10, async () => new Promise<void>((resolve) => {
      setTimeout(() => { completed = true; resolve(); }, 50);
    }));
    const assertion = expect(work).rejects.toBeInstanceOf(TimeoutError);
    await jest.advanceTimersByTimeAsync(10);
    await assertion;
    expect(completed).toBe(false);
    expect(jest.getTimerCount()).toBe(1); // 工作自己的 timer 還在。
    await jest.advanceTimersByTimeAsync(40);
    expect(completed).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
  });

  test.each([0, -1, 1.5, 60001, NaN])('拒絕非法期限 %s', async (ms) => {
    await expect(withDeadline(ms, async () => 'ok')).rejects.toThrow(RangeError);
    expect(jest.getTimerCount()).toBe(0);
  });
});
