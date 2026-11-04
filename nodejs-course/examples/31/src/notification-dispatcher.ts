import { setTimeout as delay } from 'node:timers/promises';
import { createDatabase } from './database.js';
import { databaseUrlFrom } from './runtime-config.js';
import { publicationQueue } from './notification-queue.js';
import { dispatchOutbox } from './outbox-dispatcher.js';
async function main(){
 const db=createDatabase(databaseUrlFrom(process.env));const controller=new AbortController();const stop=()=>controller.abort();process.on('SIGTERM',stop);process.on('SIGINT',stop);
 try {await db.$connect();await db.outboxEvent.count();console.log('{"event":"dispatcher_ready"}');
  while(!controller.signal.aborted){const queue=publicationQueue(process.env.REDIS_JOB_URL??'redis://job-redis:6379',process.env.QUEUE_PREFIX??'course31');try{await dispatchOutbox(db,queue);}catch{console.log('{"event":"dispatcher_retry_pending"}');}finally{await queue.close().catch(()=>{});}try{await delay(500,undefined,{signal:controller.signal});}catch{}}
 }finally{await db.$disconnect();console.log('{"event":"dispatcher_closed"}');}
}
if(require.main===module)void main().catch(()=>{console.error('{"event":"dispatcher_failed"}');process.exitCode=1;});
