import { setTimeout as delay } from 'node:timers/promises';
import { mapConcurrent } from './concurrency.js';
import { observeLatency } from './latency.js';

async function main(): Promise<void> {
  const waiting = await observeLatency('waiting');
  const cpu = await observeLatency('cpu');
  let active = 0;
  let peak = 0;
  const results = await mapConcurrent([1, 2, 3, 4], 2, async (id) => {
    active += 1;
    peak = Math.max(peak, active);
    try {
      await delay(15);
      return `article-${id}`;
    } finally {
      active -= 1;
    }
  });
  console.log(JSON.stringify({ waiting, cpu, concurrency: { peak, results } }, null, 2));
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
