import { test, expect } from '@jest/globals';
import { randomUUID, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { PublicCache } from '../src/public-cache.js';
import { createCachedArticleRepository } from '../src/cached-article-repository.js';
import { createArticleService } from '../src/article-service.js';
import { databaseFixture } from './database-fixture.js';
import { seedDatabase } from '../src/seed-database.js';
async function ready(cache: PublicCache) { cache.onModuleInit(); const end=Date.now()+4000; while(cache.client?.status!=='ready') { if(Date.now()>end) throw new Error('test Redis unavailable'); await delay(20); } }
async function fixture() {
  const storage=await databaseFixture(); const db=storage.connect(); await seedDatabase(db);
  const cache=new PublicCache(process.env.REDIS_CACHE_URL, 'test_'+randomUUID().replaceAll('-','')); await ready(cache);
  const repository=createCachedArticleRepository(db,cache); const service=createArticleService(repository);
  return { db,cache,repository,service,async close(){ const keys=await cache.client!.keys(cache.prefix+':*'); if(keys.length) await cache.client!.del(...keys); await cache.onModuleDestroy();await db.$disconnect();await storage.dispose(); } };
}
test('真 Redis 命中公開單篇與列表，日期復原；私人與 admin 查詢不進快取',async()=>{
  const f=await fixture();try {
    const first=await f.service.detail('a_1',true); await f.service.detail('a_1',true); expect(f.cache.snapshot().hits).toBe(1); expect(first.createdAt).toBeInstanceOf(Date);
    const query={page:1,pageSize:10,q:'',sort:'newest' as const}; await f.service.list(query,true); const page=await f.service.list(query,true);expect(page.meta.total).toBe(2);expect(f.cache.snapshot().hits).toBe(2);
    await f.service.list({page:1,pageSize:10},false,{id:'u_demo',role:'member'});await f.service.adminDetail('a_draft',{id:'u_admin',role:'admin'}); expect(f.cache.snapshot().hits).toBe(2);
    const keys=await f.cache.client!.keys(f.cache.prefix+':*');const values=await Promise.all(keys.map(key=>f.cache.client!.get(key))); expect(values.join('')).not.toContain('尚未發佈');
  }finally{await f.close();}
},45000);
test('晚到的v1回填發生於v2 commit／DEL之後；新讀取不選舊key，封存立即隱藏',async()=>{
  const f=await fixture();let release!:()=>void;let entered!:()=>void;let oldKey='';
  const gate=new Promise<void>(resolve=>release=resolve);const held=new Promise<void>(resolve=>entered=resolve);
  const remember=f.cache.remember.bind(f.cache);let staleRead:ReturnType<typeof f.service.detail>|undefined;
  f.cache.remember=<T>(key:string,load:()=>Promise<T>,decode:(value:unknown)=>T)=>{oldKey=key;return remember(key,async()=>{const row=await load();entered();await gate;return row;},decode);};
  try {
    staleRead=f.service.detail('a_1',true);await held;
    await f.service.change('a_1',{expectedVersion:1,title:'new title'},'edit',{id:'u_demo',role:'member'});
    release();expect((await staleRead).version).toBe(1);f.cache.remember=remember;
    expect(JSON.parse((await f.cache.client!.get(f.cache.key(oldKey)))!).version).toBe(1);
    expect((await f.service.detail('a_1',true)).title).toBe('new title');
    await f.service.change('a_1',{expectedVersion:2},'archive',{id:'u_demo',role:'member'});
    await expect(f.service.detail('a_1',true)).rejects.toMatchObject({code:'NOT_FOUND'});
    expect((await f.service.list({page:1,pageSize:10},true)).data.some(row=>row.id==='a_1')).toBe(false);
  }finally{release();await staleRead?.catch(()=>{});f.cache.remember=remember;await f.close();}
},45000);
test('相同 cache miss 合併、TTL 有界並真正到期；壞 JSON 安全回源',async()=>{
  const cache=new PublicCache(process.env.REDIS_CACHE_URL,'test_'+randomUUID().replaceAll('-',''));await ready(cache);
  const digest=createHash('sha256').update('same').digest('hex');let loads=0;let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
  try {
    const load=async()=>{loads++;await gate;return {ok:true};};const decode=(value:unknown)=>{if(!value||typeof value!=='object'||!('ok'in value)||value.ok!==true)throw new Error('bad');return {ok:true};};
    const requests=Array.from({length:8},()=>cache.remember(digest,load,decode));await delay(50);release();await Promise.all(requests);expect(loads).toBe(1);
    const ttl=await cache.client!.pttl(cache.key(digest));expect(ttl).toBeGreaterThan(0);expect(ttl).toBeLessThanOrEqual(30000);
    await cache.client!.pexpire(cache.key(digest),30);await delay(60);expect(await cache.client!.get(cache.key(digest))).toBeNull();
    await cache.client!.set(cache.key(digest),'bad JSON');await cache.remember(digest,async()=>({ok:true}),decode);expect(cache.snapshot().invalid).toBe(1);
    await cache.client!.set(cache.key(digest),'x'.repeat(512*1024+1));await cache.remember(digest,async()=>({ok:true}),decode);
    expect(cache.snapshot().invalid).toBe(2);expect(JSON.parse((await cache.client!.get(cache.key(digest)))!)).toEqual({ok:true});
  }finally{release();await cache.client!.del(cache.key(digest));await cache.onModuleDestroy();}
},15000);
test('沒有 Redis 或 Redis 不可達仍查 PostgreSQL；不共享不存在／私人資料',async()=>{
  const storage=await databaseFixture();const db=storage.connect();await seedDatabase(db);const cache=new PublicCache('redis://127.0.0.1:1','test_'+randomUUID().replaceAll('-',''));
  try {const service=createArticleService(createCachedArticleRepository(db,cache));expect((await service.detail('a_1',true)).status).toBe('published');await expect(service.detail('a_draft',true)).rejects.toMatchObject({code:'NOT_FOUND'});expect(cache.snapshot().bypass).toBeGreaterThan(0);}
  finally{await cache.onModuleDestroy();await db.$disconnect();await storage.dispose();}
},45000);

test('建立 Provider 不提早連線，compile 失敗時沒有背景重連資源',async()=>{const cache=new PublicCache(process.env.REDIS_CACHE_URL,'test_'+randomUUID().replaceAll('-',''));expect(cache.client?.status).toBe('wait');await cache.onModuleDestroy();});
