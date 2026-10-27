import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';

function busyWait(ms: number): void {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    // 刻意浪費 CPU，僅用來觀察阻塞，不是正式專案的等待方式。
  }
}

export async function observeLatency(mode: 'waiting' | 'cpu') {
  const events: string[] = [];
  const start = performance.now();
  let probeMs = 0;
  const probe = delay(0).then(() => {
    probeMs = performance.now() - start;
    events.push('probe');
  });

  async function slowTask(): Promise<void> {
    events.push('slow:start');
    if (mode === 'waiting') await delay(120);
    else busyWait(120); // 加上 async 並沒有把這段搬到背景。
    events.push('slow:end');
  }

  await Promise.all([slowTask(), probe]);
  return { mode, events, probeMs: Math.round(probeMs), totalMs: Math.round(performance.now() - start) };
}
