import { test,expect } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import raw from 'supertest';
import { databaseFixture } from './database-fixture.js';
import { seedDatabase, demoAccounts } from '../src/seed-database.js';
import { createArticleService } from '../src/article-service.js';
import { createPrismaArticleRepository } from '../src/prisma-article-repository.js';
import { publicationQueue } from '../src/notification-queue.js';
import { dispatchOutbox } from '../src/outbox-dispatcher.js';
import { processPublication } from '../src/notification-processing.js';
import { startNotificationWorker } from '../src/notification-worker.js';
import { httpFixture,loginSession } from './http-fixture.js';
async function until(check:()=>Promise<boolean>){const end=Date.now()+10000;while(!await check()){if(Date.now()>end)throw new Error('queue test deadline');await delay(20);}}
async function fixture(){const storage=await databaseFixture();const db=storage.connect();await seedDatabase(db);const service=createArticleService(createPrismaArticleRepository(db));return {storage,db,service,async close(){await db.$disconnect();await storage.dispose();}};}
test('publish／稽核／Outbox 同交易；Outbox INSERT 失敗時全部回滾；recipient 不是代操作admin',async()=>{
 const f=await fixture();try{
  await f.db.$executeRawUnsafe(`ALTER TABLE "${f.storage.schema}"."OutboxEvent" ADD CONSTRAINT reject_test CHECK(false)`);
  await expect(f.service.change('a_draft',{expectedVersion:1},'publish',{id:'u_admin',role:'admin'})).rejects.toThrow();
  expect((await f.db.article.findUniqueOrThrow({where:{id:'a_draft'}})).status).toBe('draft');expect(await f.db.articleStatusAudit.count()).toBe(0);expect(await f.db.outboxEvent.count()).toBe(0);
  await f.db.$executeRawUnsafe(`ALTER TABLE "${f.storage.schema}"."OutboxEvent" DROP CONSTRAINT reject_test`);
  await f.service.change('a_draft',{expectedVersion:1},'publish',{id:'u_admin',role:'admin'});
  expect(await f.db.outboxEvent.findFirst()).toMatchObject({userId:'u_demo',articleId:'a_draft',articleVersion:2,enqueuedAt:null});
  await f.service.change('a_draft',{expectedVersion:2,title:'edit'},'edit',{id:'u_demo',role:'member'});await f.service.change('a_draft',{expectedVersion:3},'archive',{id:'u_demo',role:'member'});expect(await f.db.outboxEvent.count()).toBe(1);
 }finally{await f.close();}
},45000);
test('Redis 不可達時已提交的 publish 保留，dispatcher 失敗不標為已入列',async()=>{
 const f=await fixture();const q=publicationQueue('redis://127.0.0.1:1','test_'+randomUUID().replaceAll('-',''));try{
  await f.service.change('a_draft',{expectedVersion:1},'publish',{id:'u_demo',role:'member'});
  expect(await dispatchOutbox(f.db,q)).toMatchObject({claimed:1,enqueued:0,failed:1});
  expect(await f.db.outboxEvent.findFirst()).toMatchObject({enqueuedAt:null,leaseToken:null});
 }finally{await q.close().catch(()=>{});await f.close();}
},45000);
test('enqueue後標記前失敗可補送，真Nest worker去重；移除job後重送仍只有一筆通知',async()=>{
 const f=await fixture();const q=publicationQueue(process.env.REDIS_JOB_URL!,'test_'+randomUUID().replaceAll('-',''));let worker:Awaited<ReturnType<typeof startNotificationWorker>>|undefined;
 try{
  await f.service.change('a_draft',{expectedVersion:1},'publish',{id:'u_demo',role:'member'});
  expect((await dispatchOutbox(f.db,q,async()=>{throw new Error('simulated post-add crash');})).failed).toBe(1);
  expect((await dispatchOutbox(f.db,q)).enqueued).toBe(1);expect(await q.getWaitingCount()).toBe(1);
  worker=await startNotificationWorker(f.storage.connect(),process.env.REDIS_JOB_URL!,q.opts.prefix!);await until(async()=>await f.db.notification.count()===1);
  const event=await f.db.outboxEvent.findFirstOrThrow();expect((await processPublication(f.db,{eventId:event.id})).created).toBe(false);
  await until(async()=>(await q.getJob(event.id))?.getState().then(state=>state==='completed')??false);
  await(await q.getJob(event.id))!.remove();const delayed=await q.add('published',{eventId:event.id},{jobId:event.id,delay:250});expect(await delayed.getState()).toBe('delayed');await until(async()=>(await q.getJob(event.id))?.getState().then(state=>state==='completed')??false);
  expect(await f.db.notification.count()).toBe(1);
  const bad=await q.add('published',{eventId:'evt_'+randomUUID()},{jobId:'bad_'+randomUUID()});await until(async()=>await bad.getState()==='failed');
  const failed=await q.getJob(bad.id!);expect(failed?.attemptsMade).toBe(3);expect(failed?.failedReason).toBe('NOTIFICATION_WORK_FAILED');
 }finally{await worker?.close();await q.obliterate({force:true});await q.close();await f.close();}
},45000);
test('兩個dispatcher以lease分工，通知seq按recipient序列；HTTP本人列表不接受userId',async()=>{
 const f=await httpFixture();const q=publicationQueue(process.env.REDIS_JOB_URL!,'test_'+randomUUID().replaceAll('-',''));try{
  const alice=await loginSession(f.server);await alice.agent.post('/api/articles/a_draft/publish').set(alice.writeHeaders).send({expectedVersion:1}).expect(200);
  const result=await Promise.all([dispatchOutbox(f.database,q),dispatchOutbox(f.database,q)]);expect(result.reduce((n,r)=>n+r.enqueued,0)).toBe(1);
  const event=await f.database.outboxEvent.findFirstOrThrow();await processPublication(f.database,{eventId:event.id});
  const list=await alice.agent.get('/api/me/notifications').expect(200);expect(list.body.data).toHaveLength(1);expect(list.body.data[0]).toMatchObject({articleId:'a_draft',articleVersion:2});
  const bob=await loginSession(f.server,demoAccounts[1]);expect((await bob.agent.get('/api/me/notifications').expect(200)).body.data).toEqual([]);
  await raw(f.server).get('/api/me/notifications').expect(401);await alice.agent.get('/api/me/notifications?userId=u_bob').expect(400);for(const cursor of ['-1','abc','1.2','1e3','01','1\n','0\r\n','9223372036854775808']) {
   const rejected=await alice.agent.get('/api/me/notifications').query({after:cursor}).expect(400);expect(rejected.body.error.code).toBe('VALIDATION_ERROR');
  }
  expect((await alice.agent.get('/api/me/notifications?after=9223372036854775807').expect(200)).body.data).toEqual([]);
 }finally{await q.obliterate({force:true});await q.close();await f.dispose();}
},45000);

test('Redis工作遺失後，逾30秒未完成的Outbox可重建；不清空其他前綴',async()=>{
 const f=await fixture();const q=publicationQueue(process.env.REDIS_JOB_URL!,'test_'+randomUUID().replaceAll('-',''));try{
  await f.service.change('a_draft',{expectedVersion:1},'publish',{id:'u_demo',role:'member'});await dispatchOutbox(f.db,q);await q.obliterate({force:true});
  await f.db.outboxEvent.updateMany({data:{enqueuedAt:new Date('2000-01-01T00:00:00Z')}});expect((await dispatchOutbox(f.db,q)).enqueued).toBe(1);expect(await q.getWaitingCount()).toBe(1);
  expect(await f.db.outboxEvent.findFirst()).toMatchObject({leaseToken:null,leaseUntil:null});expect((await dispatchOutbox(f.db,q)).claimed).toBe(0);
 }finally{await q.obliterate({force:true});await q.close();await f.close();}
},45000);
