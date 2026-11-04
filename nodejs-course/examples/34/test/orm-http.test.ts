import { beforeAll,beforeEach,afterEach,afterAll,describe,test,expect } from '@jest/globals';
import { once } from 'node:events';
import { mkdtemp,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';import { join } from 'node:path';
import raw from 'supertest';
import { createOrmApplication } from '../src/orm/application.js';
import { createOrmDataSource } from '../src/orm/data-source.js';
import { ormFixture } from './orm-fixture.js';
import { loginAs } from './authenticated-test-client.js';
import { loginSession } from './http-fixture.js';
import { demoAccounts } from '../src/seed-database.js';
import { articleContract } from './api-contract.js';import { migrationContract } from './migration-contract.js';
import { CommentEntity,StatusAuditEntity,UserEntity,ArticleEntity } from '../src/orm/entities.js';
describe('TypeORM完整HTTP契約（共用原基準）',()=>{
 let fixture:Awaited<ReturnType<typeof ormFixture>>;let directory:string;let server:Awaited<ReturnType<typeof createOrmApplication>>;let source:ReturnType<typeof createOrmDataSource>;const exportText='{"id":"file_only","title":"獨立教學檔🙂"}\n';
 beforeAll(async()=>{fixture=await ormFixture();directory=await mkdtemp(join(tmpdir(),'course34-http-'));await writeFile(join(directory,'articles.ndjson'),exportText);},45000);
 beforeEach(async()=>{await fixture.reset();source=createOrmDataSource(fixture.url);server=await createOrmApplication({source,exportFile:join(directory,'articles.ndjson')});server.listen(0,'127.0.0.1');await once(server,'listening');await loginAs(server);},45000);
 afterEach(async()=>{await server?.lifecycle.shutdown();});afterAll(async()=>{try{await fixture?.close();}finally{if(directory)await rm(directory,{recursive:true,force:true});}});
 articleContract(()=>server);migrationContract(()=>server,exportText);
 test('真TypeORM認證／留言／稽核：作者決定於Session，admin actor不誤記為作者',async()=>{
  const alice=await loginSession(server);const bob=await loginSession(server,demoAccounts[1]);const admin=await loginSession(server,demoAccounts[2]);
  const result=await bob.agent.post('/api/articles/a_1/comments').set(bob.writeHeaders).send({content:'ORM留言'}).expect(201);expect(result.body.data.authorId).toBe('u_bob');
  await alice.agent.delete('/api/comments/'+result.body.data.id).set(alice.writeHeaders).expect(403);await admin.agent.delete('/api/comments/'+result.body.data.id).set(admin.writeHeaders).expect(204);expect(await fixture.source.getRepository(CommentEntity).count()).toBe(0);
  await admin.agent.post('/api/articles/a_draft/publish').set(admin.writeHeaders).send({expectedVersion:1}).expect(200);expect(await fixture.source.getRepository(StatusAuditEntity).findOneBy({articleId:'a_draft'})).toMatchObject({actorId:'u_admin',toVersion:2});
  await raw(server).get('/api/me/articles').expect(401);await alice.agent.get('/api/admin/articles/a_draft/status-audits').expect(403);
  await fixture.source.getRepository(UserEntity).update({id:'u_demo'},{role:'admin'});await alice.agent.get('/api/admin/articles/a_draft/status-audits').expect(200);
 });
});
