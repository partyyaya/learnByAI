import { describe, expect, test } from '@jest/globals';
import { mapConcurrent } from '../src/concurrency.js';

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('有限併發', () => {
  test('只啟動允許數量，完成順序不同時仍依輸入排序', async () => {
    const gates = [gate(), gate(), gate()];
    const started: number[] = [];
    let active = 0;
    let peak = 0;
    const thirdStarted = gate();
    const work = mapConcurrent([0, 1, 2], 2, async (id) => {
      started.push(id);
      active += 1;
      peak = Math.max(peak, active);
      if (id === 2) thirdStarted.resolve();
      await gates[id].promise;
      active -= 1;
      return `result-${id}`;
    });
    expect(started).toEqual([0, 1]);
    gates[1].resolve();
    await thirdStarted.promise;
    expect(started).toEqual([0, 1, 2]);
    gates[2].resolve();
    gates[0].resolve();
    await expect(work).resolves.toEqual(['result-0', 'result-1', 'result-2']);
    expect(peak).toBe(2);
  });

  test('拒絕後不再派發，但已開始的工作仍會繼續', async () => {
    const pending = gate();
    const finished = gate();
    const started: number[] = [];
    let completed = false;
    const work = mapConcurrent([0, 1, 2], 2, async (id) => {
      started.push(id);
      if (id === 0) throw new Error('lookup failed');
      await pending.promise;
      completed = true;
      finished.resolve();
      return id;
    });
    await expect(work).rejects.toThrow('lookup failed');
    expect(completed).toBe(false);
    pending.resolve();
    await finished.promise;
    expect(started).toEqual([0, 1]);
    expect(completed).toBe(true);
  });

  test('空輸入不執行工作', async () => {
    let calls = 0;
    await expect(mapConcurrent([], 2, async () => { calls++; })).resolves.toEqual([]);
    expect(calls).toBe(0);
  });

  test.each([0, -1, 1.5, NaN, Infinity])('拒絕非法上限 %s', async (limit) => {
    await expect(mapConcurrent([1], limit, async (value) => value)).rejects.toThrow(RangeError);
  });
});
