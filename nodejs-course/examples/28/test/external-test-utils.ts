import { setTimeout as delay } from 'node:timers/promises';
export async function waitUntil(condition: () => boolean, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error('等待測試條件超過期限');
    await delay(5);
  }
}
