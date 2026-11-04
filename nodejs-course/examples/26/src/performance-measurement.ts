import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { setImmediate as immediate } from 'node:timers/promises';
import { positiveInteger } from './performance-policy.js';

export function createMeasurements() {
  const delay = monitorEventLoopDelay({ resolution: 10 }); delay.enable();
  const cpuStart = process.cpuUsage(); const loopStart = performance.eventLoopUtilization(); const start = performance.now();
  let stopped = false;
  return {
    sample() {
      const elapsedMs = performance.now() - start; const cpu = process.cpuUsage(cpuStart);
      const memory = process.memoryUsage(); const loop = performance.eventLoopUtilization(loopStart);
      return { elapsedMs, cpuMs: (cpu.user + cpu.system) / 1000, cpuPerWall: elapsedMs > 0 ? (cpu.user + cpu.system) / (elapsedMs * 1000) : 0,
        eventLoopUtilization: loop.utilization, eventLoop: { idleMs: loop.idle, activeMs: loop.active }, eventLoopDelay: delay.count > 0 ? { samples: delay.count,
          meanMs: delay.mean / 1e6, p99Ms: delay.percentile(99) / 1e6, maxMs: delay.max / 1e6 } : null,
        memory: { rssBytes: memory.rss, heapUsedBytes: memory.heapUsed }, stopped };
    },
    stop() { if (!stopped) { stopped = true; delay.disable(); } },
  };
}
// 相同迭代數與結果；yield 只讓同一執行緒交錯工作，不會平行加速 CPU。
export async function cpuDigest(iterations: number, yielding: boolean, signal?: AbortSignal) {
  positiveInteger(iterations, 50000000, 'cpuIterations');
  let digest = 2166136261; const chunk = 250000;
  for (let start = 0; start < iterations; start += chunk) {
    signal?.throwIfAborted();
    for (let i = start; i < Math.min(start + chunk, iterations); i++) digest = Math.imul(digest ^ i, 16777619) >>> 0;
    if (yielding && start + chunk < iterations) await immediate(undefined, { signal });
  }
  return digest;
}
