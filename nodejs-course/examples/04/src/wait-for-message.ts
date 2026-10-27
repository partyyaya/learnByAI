import { EventEmitter } from 'node:events';

export function waitForMessage(source: EventEmitter, signal: AbortSignal): Promise<string> {
  if (signal.aborted) return Promise.reject(signal.reason);

  return new Promise<string>((resolve, reject) => {
    function cleanup(): void {
      source.off('message', onMessage);
      source.off('error', onError);
      signal.removeEventListener('abort', onAbort);
    }
    function onMessage(value: unknown): void {
      cleanup();
      if (typeof value !== 'string') reject(new TypeError('message 必須是字串'));
      else resolve(value);
    }
    function onError(error: unknown): void {
      cleanup();
      reject(error instanceof Error ? error : new Error('訊息來源失敗'));
    }
    function onAbort(): void {
      cleanup();
      reject(signal.reason);
    }
    // 先註冊再觸發來源；成功、來源錯誤、取消都移除自己註冊的 listener。
    source.on('message', onMessage);
    source.on('error', onError);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
