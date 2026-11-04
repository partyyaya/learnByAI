import { Queue, type ConnectionOptions } from 'bullmq';
export function jobConnection(raw: string, worker = false): ConnectionOptions {
  const url = new URL(raw);
  if (url.protocol !== 'redis:' || !['job-redis','127.0.0.1','localhost'].includes(url.hostname) || url.username || url.password || url.pathname !== '' && url.pathname !== '/' || url.search || url.hash) throw new Error('local job Redis URL invalid');
  return { host: url.hostname, port: Number(url.port || 6379), connectTimeout: 300,
    enableOfflineQueue: worker, maxRetriesPerRequest: worker ? null : 0,
    ...(worker ? { retryStrategy: () => 1000 } : { retryStrategy: () => null, commandTimeout: 800 }) };
}
export function queuePrefix(value: string) { if(!/^[A-Za-z0-9_-]{1,80}$/.test(value)) throw new Error('invalid queue prefix');return value; }
class PublicationQueue extends Queue {
  // BullMQ 5.58.5 removes RedisConnection error listeners in close(). Let its
  // initialization promise settle first, including fail-fast connection errors.
  override async close() { await this.waitUntilReady().catch(()=>{}); return super.close(); }
}
export function publicationQueue(url: string, prefix: string) {
  const queue = new PublicationQueue('notifications', { connection: jobConnection(url), prefix: queuePrefix(prefix), defaultJobOptions: { attempts: 3, backoff: { type: 'exponential', delay: 100 }, removeOnComplete: 100, removeOnFail: 100 } });
  queue.on('error',()=>{}); return queue;
}
