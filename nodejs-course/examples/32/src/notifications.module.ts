import { All, Controller, Get, Inject, Module, Query, Res, UseGuards, type DynamicModule } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { SessionGuard } from './auth.guards.js';
import { CurrentActor } from './auth-http.js';
import type { Actor } from './auth-model.js';
import { DATABASE } from './tokens.js';
import type { Database } from './database.js';
import { HttpError } from './http.js';
import { ZodValidationPipe } from './zod-validation.pipe.js';
export const cursorSchema=z.string().regex(/^(0|[1-9][0-9]{0,18})$/).pipe(z.string().refine(value=>value.trim()===value&&BigInt(value)<=9223372036854775807n));
const querySchema=z.strictObject({after:cursorSchema.default('0'),limit:z.string().regex(/^[1-9][0-9]?$/).transform(Number).refine(value=>value<=50).default(20)});
export async function readNotifications(db:Database,userId:string,after:string,limit=20){
 const rows=await db.notification.findMany({where:{userId,seq:{gt:BigInt(after)}},orderBy:{seq:'asc'},take:limit,select:{seq:true,articleId:true,articleVersion:true,createdAt:true}});
 return rows.map(row=>({...row,seq:row.seq.toString()}));
}
@Controller('api/me/notifications')
@UseGuards(SessionGuard)
export class NotificationsController {
 constructor(@Inject(DATABASE) private readonly database:Database){}
 @Get() async list(@Query(new ZodValidationPipe(querySchema)) query:z.output<typeof querySchema>,@CurrentActor() actor:Actor,@Res({passthrough:true}) res:Response){res.setHeader('Cache-Control','no-store');const data=await readNotifications(this.database,actor.id,query.after,query.limit);return {data,meta:{after:query.after,nextAfter:data.at(-1)?.seq??query.after,limit:query.limit}};}
 @All() method(@Res() res:Response){res.setHeader('Allow','GET, HEAD');throw new HttpError(405,'METHOD_NOT_ALLOWED','此路由不支援該方法');}
}
@Module({controllers:[NotificationsController]})
export class NotificationsModule{static register(database:DynamicModule,auth:DynamicModule):DynamicModule{return {module:NotificationsModule,imports:[database,auth]};}}
