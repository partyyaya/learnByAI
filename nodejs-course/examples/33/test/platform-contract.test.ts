import { beforeAll,beforeEach,afterAll,afterEach,describe,test,expect } from '@jest/globals';
import { once } from 'node:events';
import { mkdtemp,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import raw from 'supertest';
import { createArticleApplication } from '../src/application.js';
import { databaseFixture } from './database-fixture.js';
import { seedDatabase,demoAccounts } from '../src/seed-database.js';
import { loginAs } from './authenticated-test-client.js';
import { loginSession } from './http-fixture.js';
import { articleContract } from './api-contract.js';
import { migrationContract } from './migration-contract.js';
for(const platform of ['express','fastify'] as const)describe('同一完整HTTP契約 / '+platform,()=>{
 let storage:Awaited<ReturnType<typeof databaseFixture>>;let directory:string;let server:Awaited<ReturnType<typeof createArticleApplication>>;const exportText='{"id":"file_only","title":"獨立教學檔🙂"}\n';
 beforeAll(async()=>{storage=await databaseFixture();directory=await mkdtemp(join(tmpdir(),'course33-'));await writeFile(join(directory,'articles.ndjson'),exportText);},45000);
 beforeEach(async()=>{const db=storage.connect();await db.comment.deleteMany();await db.session.deleteMany();await db.articleStatusAudit.deleteMany();await db.article.deleteMany();await db.user.deleteMany();await seedDatabase(db);server=await createArticleApplication({database:db,platform,exportFile:join(directory,'articles.ndjson')});server.listen(0,'127.0.0.1');await once(server,'listening');await loginAs(server);},45000);
 afterEach(async()=>{await server?.lifecycle.shutdown();});afterAll(async()=>{try{await storage?.dispose();}finally{if(directory)await rm(directory,{recursive:true,force:true});}});
 articleContract(()=>server);migrationContract(()=>server,exportText);
 test('Cookie／CSRF、留言與管理稽核相同，不由平台名稱放寬權限',async()=>{
  const alice=await loginSession(server);const bob=await loginSession(server,demoAccounts[1]);const admin=await loginSession(server,demoAccounts[2]);
  const comment=await bob.agent.post('/api/articles/a_1/comments').set(bob.writeHeaders).send({content:'跨平台留言🙂'}).expect(201);
  await alice.agent.delete('/api/comments/'+comment.body.data.id).set(alice.writeHeaders).expect(403);await bob.agent.delete('/api/comments/'+comment.body.data.id).set(bob.writeHeaders).expect(204);
  await alice.agent.post('/api/articles/a_draft/publish').set(alice.writeHeaders).send({expectedVersion:1}).expect(200);
  const audits=await admin.agent.get('/api/admin/articles/a_draft/status-audits').expect(200);expect(audits.body.data[0]).toMatchObject({actorId:'u_demo',toVersion:2});
  await raw(server).get('/api/me/articles').expect(401);await alice.agent.post('/api/articles').set(alice.writeHeaders).set('Origin','http://bad.example').send({title:'no',content:'no'}).expect(403);
  const metrics=await raw(server).get('/health/metrics').expect(200);expect(metrics.text).toContain('course_http_requests_total');
 });
});
