import { EventEmitter } from 'node:events';
import { TimeoutError, withDeadline } from './deadline.js';
import { waitForMessage } from './wait-for-message.js';

async function main(): Promise<void> {
  const results: { scenario: string; outcome: string; listeners: number }[] = [];
  for (const scenario of ['success', 'source-error', 'timeout', 'cancel'] as const) {
    const source = new EventEmitter();
    const parent = new AbortController();
    let producerTimer: NodeJS.Timeout | undefined;
    let outcome = '';
    try {
      outcome = await withDeadline(scenario === 'timeout' ? 10 : 1000, (signal) => {
        const pending = waitForMessage(source, signal);
        if (scenario !== 'timeout') {
          producerTimer = setTimeout(() => {
            if (scenario === 'success') source.emit('message', 'article-ready');
            if (scenario === 'source-error') source.emit('error', new Error('source unavailable'));
            if (scenario === 'cancel') parent.abort(new Error('user cancelled'));
          }, 5);
        }
        return pending;
      }, parent.signal);
    } catch (error) {
      outcome = error instanceof TimeoutError ? 'timeout' : error instanceof Error ? error.message : 'unknown';
    } finally {
      // timer 的建立者也要停止來源；解除等待並不等於停止生產資料。
      clearTimeout(producerTimer);
    }
    results.push({ scenario, outcome, listeners: source.listenerCount('message') + source.listenerCount('error') });
  }
  console.log(JSON.stringify(results, null, 2));
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
