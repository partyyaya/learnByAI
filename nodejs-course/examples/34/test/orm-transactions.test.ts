import { test,expect } from '@jest/globals';
import { ormFixture } from './orm-fixture.js';
import { createOrmDataSource } from '../src/orm/data-source.js';
import { createOrmArticleRepository } from '../src/orm/article-repository.js';
import { createArticleService } from '../src/article-service.js';
import { ArticleEntity,StatusAuditEntity,CommentEntity,UserEntity } from '../src/orm/entities.js';
const actor={id:'u_demo',role:'member' as const};
test('TypeORM同版本雙pool競爭僅一個成功；SQL條件與affected保護資料',async()=>{
 const f=await ormFixture();const other=createOrmDataSource(f.url);try{await f.reset();await other.initialize();const one=createArticleService(createOrmArticleRepository(f.source));const two=createArticleService(createOrmArticleRepository(other));
  const results=await Promise.allSettled([one.change('a_1',{expectedVersion:1,title:'one'},'edit',actor),two.change('a_1',{expectedVersion:1,title:'two'},'edit',actor)]);expect(results.filter(row=>row.status==='fulfilled')).toHaveLength(1);expect(results.filter(row=>row.status==='rejected')).toHaveLength(1);expect((await f.source.getRepository(ArticleEntity).findOneByOrFail({id:'a_1'})).version).toBe(2);
 }finally{if(other.isInitialized)await other.destroy();await f.close();}
},45000);
test('TypeORM稽核INSERT失敗回滾狀態與版本；QueryRunner rollback不留下資料',async()=>{
 const f=await ormFixture();try{await f.reset();await f.source.query(`ALTER TABLE "${f.schema}"."ArticleStatusAudit" ADD CONSTRAINT reject_test CHECK(false)`);
  const service=createArticleService(createOrmArticleRepository(f.source));await expect(service.change('a_draft',{expectedVersion:1},'publish',actor)).rejects.toThrow();expect(await f.source.getRepository(ArticleEntity).findOneBy({id:'a_draft'})).toMatchObject({status:'draft',version:1});expect(await f.source.getRepository(StatusAuditEntity).count()).toBe(0);
  const runner=f.source.createQueryRunner();await runner.connect();await runner.startTransaction();try{await runner.manager.insert(UserEntity,{id:'rolled_back',displayName:'temporary',email:null,passwordHash:null,role:'member'});await runner.rollbackTransaction();}finally{await runner.release();}expect(await f.source.getRepository(UserEntity).findOneBy({id:'rolled_back'})).toBeNull();
 }finally{await f.close();}
},45000);
test('TypeORM空schema migration up/down/up；非空與非自有schema拒絕revert，無Prisma歷史表',async()=>{
 const f=await ormFixture();try{expect(await f.source.showMigrations()).toBe(false);await f.source.undoLastMigration();expect(await f.source.showMigrations()).toBe(true);await f.source.runMigrations();await f.reset();await expect(f.source.undoLastMigration()).rejects.toThrow('nonempty');expect(await f.source.getRepository(ArticleEntity).count()).toBe(3);const rows=await f.source.query('SELECT table_name FROM information_schema.tables WHERE table_schema=$1',[f.schema]);expect(rows.some((row:{table_name:string})=>row.table_name==='_prisma_migrations')).toBe(false);
 }finally{await f.close();}
},45000);
test('TypeORM留言真正等待archive row lock；並行DELETE檢查affected',async()=>{
 const f=await ormFixture();const url=new URL(f.url);url.searchParams.set('application_name','orm34_comment_race');const other=createOrmDataSource(url.toString());let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);let entered!:()=>void;const held=new Promise<void>(resolve=>entered=resolve);let transaction:Promise<unknown>|undefined;
 try{await f.reset();await other.initialize();const {createOrmCommentStore}=await import('../src/orm/comment-store.js');const store=createOrmCommentStore(other);
  const created=await store.create('a_1','delete race',actor);const deleted=await Promise.allSettled([store.remove(created.data.id,actor),store.remove(created.data.id,actor)]);expect(deleted.filter(row=>row.status==='fulfilled')).toHaveLength(1);expect(deleted.filter(row=>row.status==='rejected')).toHaveLength(1);
  transaction=f.source.transaction(async manager=>{await manager.update(ArticleEntity,{id:'a_1'},{status:'archived'});entered();await gate;});await held;
  const attempt=store.create('a_1','late comment',actor).then(()=> 'created',error=>error.code);const end=Date.now()+4000;
  for(;;){const waiting=await f.source.query("SELECT count(*)::integer AS count FROM pg_stat_activity WHERE application_name='orm34_comment_race' AND wait_event_type='Lock'");if(waiting[0].count>0)break;if(Date.now()>end)throw new Error('row lock not observed');await new Promise(resolve=>setTimeout(resolve,10));}
  release();await transaction;expect(await attempt).toBe('NOT_FOUND');expect(await f.source.getRepository(CommentEntity).count()).toBe(0);
 }finally{release();await transaction;if(other.isInitialized)await other.destroy();await f.close();}
},45000);
test('TypeORM關聯不自動逐筆載入；N+1與明列JOIN各量出實際查詢次數',async()=>{
 const f=await ormFixture();try{await f.reset();let queries=0;f.source.logger={logQuery:()=>{queries++;},logQueryError:()=>{},logQuerySlow:()=>{},logSchemaBuild:()=>{},logMigration:()=>{},log:()=>{}};
  const rows=await f.source.getRepository(ArticleEntity).find();for(const row of rows)await f.source.getRepository(UserEntity).findOneBy({id:row.authorId});expect(queries).toBe(1+rows.length);
  queries=0;const projected=await f.source.getRepository(ArticleEntity).createQueryBuilder('a').leftJoin('a.author','u').select(['a.id','a.title','u.displayName']).getRawMany();expect(queries).toBe(1);expect(projected).toHaveLength(rows.length);expect(JSON.stringify(projected)).not.toMatch(/passwordHash|tokenHash|email/);
 }finally{await f.close();}
},45000);

test('TypeORM readiness在空表仍驗證所有必要欄位，不只COUNT或User欄位',async()=>{
 const f=await ormFixture();try{
  const {checkOrmReady}=await import('../src/orm/readiness.js');await checkOrmReady(f.source);
  for(const [table,column] of [['User','passwordHash'],['Session','expiresAt'],['Article','content'],['ArticleStatusAudit','toVersion'],['Comment','content']]){
   await f.source.query(`ALTER TABLE "${f.schema}"."${table}" RENAME COLUMN "${column}" TO "probe_missing"`);
   try{await expect(checkOrmReady(f.source)).rejects.toThrow();}
   finally{await f.source.query(`ALTER TABLE "${f.schema}"."${table}" RENAME COLUMN "probe_missing" TO "${column}"`);}
  }
  await checkOrmReady(f.source);
 }finally{await f.close();}
},45000);
