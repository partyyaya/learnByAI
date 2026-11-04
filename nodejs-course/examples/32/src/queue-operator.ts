import { publicationQueue } from './notification-queue.js';
(async()=>{const command=process.argv[2]??'status';const queue=publicationQueue(process.env.REDIS_JOB_URL??'redis://job-redis:6379',process.env.QUEUE_PREFIX??'course32');try{
 if(command==='status'){const failed=await queue.getFailed(0,19);console.log(JSON.stringify({counts:await queue.getJobCounts('waiting','active','delayed','completed','failed'),failed:failed.map(job=>({id:job.id,attemptsMade:job.attemptsMade}))}));}
 else if(command==='retry-failed'){const id=process.argv[3];if(!id||!/^evt_[a-f0-9-]{36}$/.test(id))throw new Error('invalid event');const job=await queue.getJob(id);if(!job||await job.getState()!=='failed')throw new Error('not failed');await job.retry('failed');console.log('{"event":"notification_retry_requested"}');}
 else throw new Error('unknown command');
}finally{await queue.close().catch(()=>{});}})().catch(()=>{console.error('QUEUE_OPERATOR_FAILED');process.exitCode=1;});
