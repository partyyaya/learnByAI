import type { Server } from 'node:http';

export interface ShutdownOptions {
  timeoutMs?: number;
  closeResources?: (signal: AbortSignal) => Promise<void>;
  onEvent?: (event: string) => void;
}

export class ShutdownTimeoutError extends Error {
  constructor() { super('關閉超過期限'); }
}

// 只管理本課的 HTTP/1 服務；WebSocket、背景 worker 需另行登記與關閉。
export function createShutdown(server: Server, options: ShutdownOptions = {}) {
  const timeoutMs = options.timeoutMs ?? 3000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('關閉期限必須是正整數');
  const tasks = new Set<Promise<unknown>>();
  const controller = new AbortController();
  let draining = false;
  let completion: Promise<void> | undefined;

  function track<T>(task: Promise<T>): Promise<T> {
    tasks.add(task);
    // then 的成功與失敗分支都清理；不另外製造未處理的 rejected Promise。
    void task.then(() => tasks.delete(task), () => tasks.delete(task));
    return task;
  }

  function shutdown(): Promise<void> {
    if (completion) return completion;
    draining = true;
    options.onEvent?.('draining');
    let timer: NodeJS.Timeout;
    const deadline = new Promise<never>((_, reject) => {
      // 保留 ref：即使只剩尚未完成的 Promise，也要活到完成或超時。
      timer = setTimeout(() => {
        controller.abort(new ShutdownTimeoutError());
        server.closeAllConnections();
        options.onEvent?.('deadline');
        reject(new ShutdownTimeoutError());
      }, timeoutMs);
    });
    const drain = async () => {
      const httpClosed = new Promise<void>((resolve, reject) => {
        server.close(error => {
          if (error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
          else resolve();
        });
      });
      // 先等 HTTP 關閉：停止前接受的請求可能稍後才讀完 body、登記工作。
      // 客戶端離線也不代表那些工作已完成，不能只等 shutdown 當下的快照。
      await httpClosed;
      while (tasks.size > 0) {
        controller.signal.throwIfAborted();
        await Promise.allSettled([...tasks]);
      }
      // draining 後入口須拒絕新請求；背景工作須在所屬工作結束前登記。
      controller.signal.throwIfAborted();
      options.onEvent?.('http-drained');
      await options.closeResources?.(controller.signal);
      controller.signal.throwIfAborted();
      options.onEvent?.('closed');
    };
    completion = Promise.race([drain(), deadline]).finally(() => clearTimeout(timer));
    return completion;
  }

  return { track, shutdown, get isDraining() { return draining; } };
}
