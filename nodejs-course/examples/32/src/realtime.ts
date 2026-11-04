import type { Server, IncomingMessage } from 'node:http';
import type { Application, Request, Response } from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { z } from 'zod';
import type { Database } from './database.js';
import type { AuthService } from './auth-service.js';
import type { AuthOptions } from './auth-options.js';
import { readSessionCookie } from './auth-http.js';
import { readNotifications, cursorSchema } from './notifications.module.js';
import type { createShutdown } from './shutdown.js';
import { HttpError } from './http.js';
import { sendHttpError } from './errors.js';
interface Connection { userId:string; stop:()=>void; timer:NodeJS.Timeout }
const instances=new WeakMap<Server,{snapshot:()=>{connections:number;timers:number;polls:number}}>();
export const realtimeSnapshot=(server:Server)=>instances.get(server)?.snapshot();
export function installRealtime(app:Application,server:Server,database:Database,auth:AuthService,options:Readonly<AuthOptions>,lifecycle:ReturnType<typeof createShutdown>,pollMs=500) {
 const connections=new Set<Connection>();const closing=new Set<NodeJS.Timeout>();const wsServer=new WebSocketServer({noServer:true,maxPayload:1024,perMessageDeflate:false});let accepting=true;let polls=0;
 const capacity=(userId:string)=>accepting&&connections.size<32&&[...connections].filter(item=>item.userId===userId).length<2;
 const token=(req:IncomingMessage)=>readSessionCookie(req as Request,options);
 const source=(req:IncomingMessage,required=false)=>req.headers.origin===options.origin||!required&&req.headers.origin===undefined;
 function attach(userId:string,cookie:string|null,after:string,write:(data:string)=>boolean,stopTransport:(code:number)=>void){
  let cursor=after;let busy=false;let stopped=false;let lastPing=Date.now();
  const stop=(code=lifecycle.isDraining?1001:1008)=>{if(stopped)return;stopped=true;clearInterval(connection.timer);connections.delete(connection);stopTransport(code);};
  const tick=async()=>{
   if(busy||stopped)return;if(lifecycle.isDraining){stop();return;}busy=true;
   try{const session=await auth.resolve(cookie);if(!session?.user||session.user.id!==userId){stop();return;}
    const rows=await readNotifications(database,userId,cursor,20);polls++;
    if(stopped)return;
    for(const row of rows){if(!write(JSON.stringify({type:'article-published',...row}))){stop(1013);return;}cursor=row.seq;}
    if(Date.now()-lastPing>=2000){lastPing=Date.now();if(!write(''))stop(1013);}
   }catch{stop();}finally{busy=false;}
  };
  const connection:Connection={userId,stop,timer:setInterval(()=>{void lifecycle.track(tick());},pollMs)};connections.add(connection);void lifecycle.track(tick());return stop;
 }
 app.all('/api/me/events',(req,res,next)=>{void lifecycle.track((async()=>{
  if(!source(req))throw new HttpError(403,'FORBIDDEN','來源不允許');
  const session=await auth.resolve(token(req));if(!session?.user)throw new HttpError(401,'UNAUTHENTICATED','請先登入');
  if(!['GET','HEAD'].includes(req.method)){res.setHeader('Allow','GET, HEAD');throw new HttpError(405,'METHOD_NOT_ALLOWED','此路由不支援該方法');}
  const query=z.strictObject({after:cursorSchema.optional()}).safeParse(req.query);if(!query.success)throw new HttpError(400,'VALIDATION_ERROR','游標格式不正確');
  const after=cursorSchema.safeParse(req.headers['last-event-id']??query.data.after??'0');if(!after.success)throw new HttpError(400,'VALIDATION_ERROR','游標格式不正確');
  if(res.destroyed)return;
  if(req.method!=='HEAD'&&!capacity(session.user.id))throw new HttpError(503,'REALTIME_BUSY','連線額度已滿');
  res.setHeader('Content-Type','text/event-stream; charset=utf-8');res.setHeader('Cache-Control','no-store');res.setHeader('X-Accel-Buffering','no');
  if(req.method==='HEAD'){res.end();return;}res.write('retry: 1000\n\n');
  let stop=()=>{};stop=attach(session.user.id,token(req),after.data,text=>{
    if(!text)return res.write(': heartbeat\n\n');const row=JSON.parse(text);return res.write(`id: ${row.seq}\nevent: article-published\ndata: ${text}\n\n`);
  },()=>{res.off('close',stop);res.end();});res.once('close',stop);
 })()).catch(error=>sendHttpError(error,req,res));});
 app.all('/api/me/socket',(_req,res)=>{res.setHeader('Upgrade','websocket');res.status(426).json({error:{code:'UPGRADE_REQUIRED',message:'需要WebSocket升級',details:[]},requestId:res.locals.requestId});});
 const upgrade=(req:IncomingMessage,socket:import('node:stream').Duplex,head:Buffer)=>{
  socket.on('error',()=>{});
  void lifecycle.track((async()=>{
   const reject=(status:number)=>{socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,()=>socket.destroy());};
   if(req.url!=='/api/me/socket'||req.method!=='GET'){reject(400);return;}
   if(!source(req,true)){reject(403);return;}
   const session=await auth.resolve(token(req));if(!session?.user){reject(401);return;}
   if(!capacity(session.user.id)||socket.destroyed){reject(503);return;}
   wsServer.handleUpgrade(req,socket,head,ws=>{
    let lastPong=Date.now();ws.on('pong',()=>{lastPong=Date.now();});
    let activeStop: (()=>void)|undefined;
    const terminate=(code=1008)=>{ws.close(code,'reconnect with current Session');if(ws.readyState!==WebSocket.CLOSED){const timer=setTimeout(()=>{closing.delete(timer);ws.terminate();},500);closing.add(timer);ws.once('close',()=>{clearTimeout(timer);closing.delete(timer);});}};
    const releaseReservation=()=>{clearTimeout(reserved.timer);connections.delete(reserved);};
    const reserved:Connection={userId:session.user!.id,stop:()=>{releaseReservation();terminate(lifecycle.isDraining?1001:1008);},timer:setTimeout(()=>{releaseReservation();terminate();},2000)};
    connections.add(reserved);
    ws.on('error',()=>{releaseReservation();activeStop?.();});
    ws.once('message',(buffer:Buffer,isBinary:boolean)=>{
     if(!connections.has(reserved)||ws.readyState!==WebSocket.OPEN||!accepting){terminate(lifecycle.isDraining?1001:1008);return;}
     if(isBinary){releaseReservation();terminate(1008);return;}
     const parsed=z.strictObject({after:cursorSchema}).safeParse((()=>{try{return JSON.parse(buffer.toString('utf8'));}catch{return null;}})());
     releaseReservation();if(!parsed.success){terminate();return;}
     activeStop=attach(session.user!.id,token(req),parsed.data.after,text=>{
      if(ws.readyState!==WebSocket.OPEN||ws.bufferedAmount>32768)return false;
      if(text)ws.send(text,error=>{if(error)activeStop?.();});else {if(Date.now()-lastPong>6000)return false;ws.ping();}return true;
     },terminate);ws.on('message',()=>activeStop?.());
    });
    ws.once('close',()=>{releaseReservation();activeStop?.();});
   });
  })()).catch(()=>socket.destroy());
 };
 server.on('upgrade',upgrade);
 const result={snapshot:()=>({connections:connections.size,timers:connections.size+closing.size,polls}),drain(){accepting=false;for(const connection of [...connections])connection.stop();},async close(){this.drain();server.off('upgrade',upgrade);await new Promise<void>(resolve=>wsServer.close(()=>resolve()));for(const timer of closing)clearTimeout(timer);closing.clear();}}; instances.set(server,result);return result;
}
