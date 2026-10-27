export class TimeoutError extends Error {
  constructor(ms: number) {
    super(`工作超過 ${ms} ms`);
    this.name = 'TimeoutError';
  }
}

// 回傳值有等待上限；底層工作必須配合 signal，才能同時停止實際操作。
export async function withDeadline<T>(
  ms: number,
  operation: (signal: AbortSignal) => Promise<T>,
  parentSignal?: AbortSignal,
): Promise<T> {
  if (!Number.isInteger(ms) || ms < 1 || ms > 60000) {
    throw new RangeError('期限必須是 1–60000 ms 的整數');
  }
  parentSignal?.throwIfAborted();
  const controller = new AbortController();
  let rejectAbort!: (reason: unknown) => void;
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const onAbort = () => rejectAbort(controller.signal.reason);
  const onParentAbort = () => controller.abort(parentSignal!.reason);
  controller.signal.addEventListener('abort', onAbort, { once: true });
  parentSignal?.addEventListener('abort', onParentAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new TimeoutError(ms)), ms);

  try {
    // 同步 throw 也會成為 Promise rejection；取消早於工作開始時不執行 operation。
    const work = Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      return operation(controller.signal);
    });
    return await Promise.race([work, aborted]);
  } finally {
    clearTimeout(timer);
    controller.signal.removeEventListener('abort', onAbort);
    parentSignal?.removeEventListener('abort', onParentAbort);
  }
}
