import { randomUUID } from 'node:crypto';
import { Prisma } from './generated/prisma/client.js';
import { databaseSchema, type Database } from './database.js';
interface JobQueue { add(name: string, data: { eventId: string }, options: { jobId: string }): Promise<unknown> }
export async function dispatchOutbox(db: Database, queue: JobQueue, afterAdd?: () => Promise<void>) {
  const table=Prisma.raw(`"${databaseSchema(db)}"."OutboxEvent"`);const token=randomUUID(); const notifications=Prisma.raw(`"${databaseSchema(db)}"."Notification"`);
  const rows=await db.$queryRaw<{id:string}[]>(Prisma.sql`UPDATE ${table} SET "leaseToken"=${token}, "leaseUntil"=CURRENT_TIMESTAMP + INTERVAL '10 seconds', "attempts"="attempts"+1
    WHERE "id" IN (SELECT e."id" FROM ${table} AS e WHERE (e."enqueuedAt" IS NULL OR e."enqueuedAt"<CURRENT_TIMESTAMP - INTERVAL '30 seconds')
      AND NOT EXISTS (SELECT 1 FROM ${notifications} AS n WHERE n."eventId"=e."id")
      AND (e."leaseUntil" IS NULL OR e."leaseUntil"<CURRENT_TIMESTAMP) ORDER BY e."createdAt",e."id" LIMIT 10 FOR UPDATE SKIP LOCKED) RETURNING "id"`);
  let enqueued=0;let failed=0;
  for(const row of rows) {
    try {
      await queue.add('published',{eventId:row.id},{jobId:row.id});await afterAdd?.();
      await db.outboxEvent.updateMany({where:{id:row.id,leaseToken:token},data:{enqueuedAt:new Date(),leaseToken:null,leaseUntil:null}});enqueued++;
    }catch{failed++;await db.outboxEvent.updateMany({where:{id:row.id,leaseToken:token},data:{leaseToken:null,leaseUntil:null}});}
  }
  return {claimed:rows.length,enqueued,failed};
}
