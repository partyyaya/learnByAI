const assert=require('node:assert/strict');
const {fork}=require('node:child_process');
const {once}=require('node:events');
const {performance,monitorEventLoopDelay}=require('node:perf_hooks');
const {mkdir,writeFile}=require('node:fs/promises');
async function child(platform){
 const {databaseFixture}=require('../.test-dist/test/database-fixture.js');
 const {seedDatabase}=require('../.test-dist/src/seed-database.js');
 const {createArticleApplication}=require('../.test-dist/src/application.js');
 const storage=await databaseFixture();let server;
 try{const database=storage.connect();await seedDatabase(database);server=await createArticleApplication({database,platform});server.listen(0,'127.0.0.1');await once(server,'listening');
  const url=`http://127.0.0.1:${server.address().port}/api/articles?pageSize=20`;
  async function request(){const start=performance.now();const response=await fetch(url);assert.equal(response.status,200);const body=await response.json();assert.equal(body.data.length,2);return performance.now()-start;}
  for(let n=0;n<5;n++)await request();const histogram=monitorEventLoopDelay({resolution:10});histogram.enable();const utilization=performance.eventLoopUtilization();const start=performance.now();const latencies=[];let next=0;
  await Promise.all(Array.from({length:4},async()=>{while(next++<40)latencies.push(await request());}));
  const elapsedMs=performance.now()-start;const elu=performance.eventLoopUtilization(utilization);histogram.disable();latencies.sort((a,b)=>a-b);
  process.send({platform,requests:40,concurrency:4,successes:latencies.length,elapsedMs,p50Ms:latencies[19],p95Ms:latencies[37],eventLoopUtilization:elu.utilization,eventLoopDelayMaxMs:histogram.max/1e6});
 }finally{await server?.lifecycle.shutdown();await storage.dispose();}
}
if(process.argv[2]==='--child')child(process.argv[3]).then(()=>process.disconnect()).catch(()=>{console.error('PLATFORM_CHILD_FAILED');process.exitCode=1;process.disconnect();});
else (async()=>{const rows=[];for(const platform of ['express','fastify']){const worker=fork(__filename,['--child',platform],{stdio:['ignore','ignore','pipe','ipc']});let result;worker.stderr.resume();worker.on('message',value=>result=value);const timer=setTimeout(()=>worker.kill('SIGKILL'),45000);const [code]=await once(worker,'exit');clearTimeout(timer);assert.equal(code,0);assert.equal(result.successes,40);rows.push(result);}
 await mkdir('.data',{recursive:true});await writeFile('.data/platform-comparison.json',JSON.stringify({node:process.version,warmup:5,scenario:'same public PostgreSQL article list, fresh child per adapter',samples:rows,speedThreshold:false},null,2)+'\n');
 console.log('PASS separate Express/Fastify processes: same fixture, 40 requests, concurrency 4; descriptive measurements only');
})().catch(()=>{console.error('PLATFORM_COMPARISON_FAILED');process.exitCode=1;});
