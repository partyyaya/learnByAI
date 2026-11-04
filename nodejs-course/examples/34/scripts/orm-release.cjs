const { databaseUrlFrom } = require('../dist/runtime-config.js');
const { createOrmDataSource } = require('../dist/orm/data-source.js');
(async()=>{
 const task=process.argv[2];if(!['deploy','status','seed'].includes(task))throw new Error('unknown ORM task');
 const source=createOrmDataSource(databaseUrlFrom(process.env));await source.initialize();
 try{
  if(task==='deploy')await source.runMigrations();
  else if(task==='status'){if(await source.showMigrations())throw new Error('pending ORM migrations');}
  else{if(process.env.DEMO_AUTH_SEED!=='1')throw new Error('explicit demo seed required');await require('../dist/orm/seed.js').seedOrm(source);}
  console.log(JSON.stringify({event:'orm_release_completed',task}));
 }finally{await source.destroy();}
})().catch(()=>{console.error('{"event":"orm_release_failed"}');process.exitCode=1;});
