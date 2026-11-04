import { z } from 'zod';
import type { Database } from './database.js';
const payload=z.strictObject({eventId:z.string().regex(/^evt_[0-9a-f-]{36}$/)});
export async function processPublication(db:Database,input:unknown) {
  const {eventId}=payload.parse(input);
  return db.$transaction(async tx=>{
    const event=await tx.outboxEvent.findUniqueOrThrow({where:{id:eventId}});
    // Assign sequence AFTER taking the recipient lock; concurrent commits cannot reorder that user's cursor.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${event.userId}, 0))`;
    const previous=await tx.notification.findUnique({where:{eventId}});if(previous)return {seq:previous.seq.toString(),created:false};
    const row=await tx.notification.create({data:{eventId,userId:event.userId,articleId:event.articleId,articleVersion:event.articleVersion}});
    return {seq:row.seq.toString(),created:true};
  },{isolationLevel:'ReadCommitted',timeout:5000,maxWait:2000});
}
export async function safeProcessPublication(db:Database,input:unknown) {
  try{return await processPublication(db,input);}catch{throw new Error('NOTIFICATION_WORK_FAILED');}
}
