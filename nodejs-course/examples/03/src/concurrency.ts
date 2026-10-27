// 只限制同時進行數量；拒絕後停止派發新項目，已開始的工作不會自動取消。
export async function mapConcurrent<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError('limit 必須是正整數');
  }
  const results: R[] = new Array(items.length);
  let cursor = 0;
  let stopped = false;

  async function worker(): Promise<void> {
    while (!stopped && cursor < items.length) {
      // 取出索引到遇到 await 之間是同步執行，不會被另一個 worker 插入。
      const index = cursor++;
      try {
        results[index] = await task(items[index], index);
      } catch (error) {
        stopped = true;
        throw error;
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}
