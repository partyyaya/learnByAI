const assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const {ormFixture}=require('../.test-dist/test/orm-fixture.js');
(async()=>{const fixture=await ormFixture();try{
 await fixture.reset();
 const signals=spawnSync(process.execPath,['scripts/check-signals.cjs'],{env:{...process.env,DATABASE_URL:fixture.url,COURSE_ENTRYPOINT:'orm'},stdio:'inherit',timeout:45000});assert.ifError(signals.error);assert.equal(signals.status,0);
 await fixture.source.query(`ALTER TABLE "${fixture.schema}"."User" RENAME COLUMN "passwordHash" TO "missing_password"`);
 const missing=spawnSync(process.execPath,['dist/orm-main.js'],{env:{...process.env,DATABASE_URL:fixture.url,PORT:'0'},encoding:'utf8',timeout:12000});assert.ifError(missing.error);assert.equal(missing.status,1);assert.match(missing.stdout,/"event":"startup_failed"/);assert.doesNotMatch(missing.stdout,/"event":"listening"/);
 const prismaUrl=new URL(fixture.url);prismaUrl.pathname='/course';const wrong=spawnSync(process.execPath,['dist/orm-main.js'],{env:{...process.env,DATABASE_URL:prismaUrl.toString(),PORT:'0'},encoding:'utf8',timeout:10000});assert.ifError(wrong.error);assert.equal(wrong.status,1);assert.doesNotMatch(wrong.stdout,/"event":"listening"/);
 console.log('PASS ORM runtime: real signals/drain, missing auth column refuses listen, Prisma database rejected');
 }finally{await fixture.close();}
})().catch(()=>{console.error('ORM_RUNTIME_FAILED');process.exitCode=1;});
