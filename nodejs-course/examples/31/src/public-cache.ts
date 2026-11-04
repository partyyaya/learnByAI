import { Redis } from 'ioredis';
import { randomInt } from 'node:crypto';
import { Module, type OnModuleDestroy } from '@nestjs/common';
export const PUBLIC_CACHE = Symbol('PUBLIC_CACHE');
export class PublicCache implements OnModuleDestroy {
  readonly client?: Redis;
  private readonly pending = new Map<string, Promise<unknown>>();
  private readonly counts = { hits: 0, misses: 0, errors: 0, coalesced: 0, writes: 0, invalid: 0, bypass: 0 };
  constructor(url?: string, readonly prefix = 'course31') {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(prefix)) throw new Error('invalid cache namespace');
    if (url) {
      const parsed = new URL(url); if (parsed.protocol !== 'redis:' || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('local cache URL invalid');
      this.client = new Redis(url, { lazyConnect: true, enableOfflineQueue: false, commandTimeout: 150, connectTimeout: 200, maxRetriesPerRequest: 0, retryStrategy: () => 1000 });
      this.client.on('error', () => {});
    }
  }
  onModuleInit() { if (this.client?.status === 'wait') void this.client.connect().catch(() => {}); }
  key(digest: string) { if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('invalid cache key'); return this.prefix + ':' + digest; }
  snapshot() { return { ...this.counts, pending: this.pending.size, ready: this.client?.status === 'ready' }; }
  bypass() { this.counts.bypass++; }
  async invalidate(digest: string) { try { if (this.client?.status === 'ready') await this.client.del(this.key(digest)); } catch { this.counts.errors++; } }
  async remember<T>(digest: string, load: () => Promise<T>, decode: (value: unknown) => T): Promise<T> {
    const key = this.key(digest);
    if (!this.client || this.client.status !== 'ready') { this.counts.bypass++; return load(); }
    try {
      const text = await this.client.get(key);
      if (text !== null) {
        try { if (Buffer.byteLength(text) > 512*1024) throw new Error('oversized cache payload'); const result = decode(JSON.parse(text)); this.counts.hits++; return result; }
        catch { this.counts.invalid++; await this.client.del(key); }
      }
    } catch { this.counts.errors++; }
    this.counts.misses++;
    const existing = this.pending.get(key); if (existing) { this.counts.coalesced++; return existing as Promise<T>; }
    const work = (async () => {
      const result = await load();
      if (result !== null && result !== undefined) {
        // Decode again before writing so a concurrent DB version change cannot fill an old fingerprint.
        try {
          decode(JSON.parse(JSON.stringify(result))); const text = JSON.stringify(result);
          if (Buffer.byteLength(text) <= 512*1024 && this.client?.status === 'ready') { await this.client.set(key, text, 'EX', randomInt(20,31)); this.counts.writes++; }
        } catch { this.counts.errors++; }
      }
      return result;
    })();
    // Bound only the coalescing registry; excess distinct misses execute without joining a queue.
    if (this.pending.size < 64) this.pending.set(key, work);
    try { return await work; } finally { if (this.pending.get(key) === work) this.pending.delete(key); }
  }
  async onModuleDestroy() { if (!this.client) return; try { if (this.client.status === 'ready') await this.client.quit(); } catch {} finally { this.client.disconnect(); } }
}
@Module({ providers: [{ provide: PUBLIC_CACHE, useFactory: () => new PublicCache(process.env.REDIS_CACHE_URL, process.env.CACHE_PREFIX ?? 'course31') }], exports: [PUBLIC_CACHE] })
export class PublicCacheModule {}
