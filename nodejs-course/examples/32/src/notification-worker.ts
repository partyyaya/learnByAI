import 'reflect-metadata';
import { Module, Inject, type DynamicModule } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { BullModule, Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { DATABASE } from './tokens.js';
import { createDatabase, type Database } from './database.js';
import { databaseUrlFrom } from './runtime-config.js';
import { jobConnection, queuePrefix } from './notification-queue.js';
import { safeProcessPublication } from './notification-processing.js';
@Processor('notifications',{concurrency:2,lockDuration:2000,stalledInterval:1000})
export class NotificationWorker extends WorkerHost {
  constructor(@Inject(DATABASE) private readonly database:Database){super();}
  process(job:Job){return safeProcessPublication(this.database,job.data);}
  @OnWorkerEvent('error') error(){ /* fixed-state metrics may be added; never print driver errors */ }
}
@Module({})
export class NotificationWorkerModule {
  static register(database:Database,url:string,prefix:string):DynamicModule {
    return {module:NotificationWorkerModule,imports:[BullModule.forRoot({connection:jobConnection(url,true),prefix:queuePrefix(prefix)}),BullModule.registerQueue({name:'notifications'})],providers:[{provide:DATABASE,useValue:database},NotificationWorker]};
  }
}
export async function startNotificationWorker(database:Database,url:string,prefix:string) {
  try {const context=await NestFactory.createApplicationContext(NotificationWorkerModule.register(database,url,prefix),{logger:false,abortOnError:false});return {context,async close(){try{await context.close();}finally{await database.$disconnect();}}};}
  catch(error){await database.$disconnect();throw error;}
}
async function main(){
  const db=createDatabase(databaseUrlFrom(process.env));const app=await startNotificationWorker(db,process.env.REDIS_JOB_URL??'redis://job-redis:6379',process.env.QUEUE_PREFIX??'course32');
  console.log('{"event":"notification_worker_ready"}');let stopping=false;
  const stop=()=>{if(stopping)return;stopping=true;const watchdog=setTimeout(()=>process.exit(1),7000);void app.close().then(()=>{clearTimeout(watchdog);console.log('{"event":"notification_worker_closed"}');},()=>process.exit(1));};
  process.on('SIGTERM',stop);process.on('SIGINT',stop);
}
if(require.main===module)void main().catch(()=>{console.error('{"event":"notification_worker_failed"}');process.exitCode=1;});
