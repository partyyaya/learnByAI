import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { EventEmitter, getEventListeners } from 'node:events';
import { TimeoutError, withDeadline } from '../src/deadline.js';
import { waitForMessage } from '../src/wait-for-message.js';

describe('等待事件的資源生命週期', () => {
  test('成功後移除自己的 listener，保留原有訂閱者', async () => {
    const source = new EventEmitter();
    const existing = jest.fn();
    source.on('message', existing);
    const controller = new AbortController();
    const pending = waitForMessage(source, controller.signal);
    source.emit('message', 'ready');
    await expect(pending).resolves.toBe('ready');
    expect(source.listeners('message')).toEqual([existing]);
    expect(source.listenerCount('error')).toBe(0);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    source.off('message', existing);
  });

  test('來源錯誤時拒絕並清理全部自有 listener', async () => {
    const source = new EventEmitter();
    const controller = new AbortController();
    const error = new Error('source failed');
    const assertion = expect(waitForMessage(source, controller.signal)).rejects.toBe(error);
    source.emit('error', error);
    await assertion;
    expect(source.eventNames()).toEqual([]);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  test('取消時清理，後來的 message 不再被消費', async () => {
    const source = new EventEmitter();
    const controller = new AbortController();
    const reason = new Error('cancelled');
    const assertion = expect(waitForMessage(source, controller.signal)).rejects.toBe(reason);
    controller.abort(reason);
    await assertion;
    expect(source.emit('message', 'too late')).toBe(false);
    expect(source.eventNames()).toEqual([]);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  test('已取消時不註冊 listener', async () => {
    const source = new EventEmitter();
    const controller = new AbortController();
    controller.abort(new Error('stopped'));
    await expect(waitForMessage(source, controller.signal)).rejects.toThrow('stopped');
    expect(source.eventNames()).toEqual([]);
  });

  test('非字串 payload 也會失敗並清理', async () => {
    const source = new EventEmitter();
    const controller = new AbortController();
    const assertion = expect(waitForMessage(source, controller.signal)).rejects.toThrow(TypeError);
    source.emit('message', 123);
    await assertion;
    expect(source.eventNames()).toEqual([]);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });
});

describe('期限與事件等待整合', () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

  test('多次逾時後 timer 與 listener 都不累積', async () => {
    const source = new EventEmitter();
    for (let index = 0; index < 20; index++) {
      const assertion = expect(withDeadline(10, signal => waitForMessage(source, signal))).rejects.toBeInstanceOf(TimeoutError);
      await jest.advanceTimersByTimeAsync(10);
      await assertion;
      expect(source.eventNames()).toEqual([]);
      expect(jest.getTimerCount()).toBe(0);
    }
  });
});
