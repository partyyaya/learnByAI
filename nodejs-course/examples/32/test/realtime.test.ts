import { test,expect } from '@jest/globals';
import raw from 'supertest';
import { WebSocket } from 'ws';
import { once } from 'node:events';
import { createConnection,type Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { httpFixture } from './http-fixture.js';
import { origin } from './authenticated-test-client.js';
import { demoAccounts } from '../src/seed-database.js';
import { processPublication } from '../src/notification-processing.js';
import { realtimeSnapshot } from '../src/realtime.js';
async function session(server:import('node:http').Server,account=demoAccounts[0]){const csrf=await raw(server).get('/api/auth/csrf');const anon=csrf.headers['set-cookie'][0].split(';')[0];const result=await raw(server).post('/api/auth/login').set('Cookie',anon).set('Origin',origin).set('X-CSRF-Token',csrf.body.data.csrfToken).send({email:account.email,password:account.password}).expect(200);return {cookie:result.headers['set-cookie'][0].split(';')[0] as string,csrf:result.body.data.csrfToken as string};}
async function until(work:()=>boolean|Promise<boolean>){const end=Date.now()+6000;while(!await work()){if(Date.now()>end)throw new Error('realtime deadline');await delay(10);}}
async function notify(db:Awaited<ReturnType<typeof httpFixture>>['database'],userId='u_demo'){const id='evt_'+randomUUID();await db.outboxEvent.create({data:{id,userId,articleId:'a_1',articleVersion:100+await db.outboxEvent.count()}});return processPublication(db,{eventId:id});}
async function nextEvent(reader:ReadableStreamDefaultReader<Uint8Array>){let text='';for(;;){const result=await reader.read();if(result.done)throw new Error('stream closed');text+=new TextDecoder().decode(result.value);const frames=text.split('\n\n').slice(0,-1);const frame=frames.find(value=>value.includes('event: article-published'));if(frame){const line=frame.split('\n').find(value=>value.startsWith('data: '));return JSON.parse(line!.slice(6));}}}
test('SSE需Session，支援Last-Event-ID補抓；本人資料隔離、重複query與Origin拒絕',async()=>{
 const f=await httpFixture();let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;const cancel=new AbortController();try{
  const alice=await session(f.server);const first=await notify(f.database);const second=await notify(f.database);const bob=await session(f.server,demoAccounts[1]);
  await raw(f.server).get('/api/me/events').expect(401);await raw(f.server).get('/api/me/events?userId=u_bob').set('Cookie',alice.cookie).expect(400);await raw(f.server).get('/api/me/events').set('Cookie',alice.cookie).set('Origin','http://bad.example').expect(403);
  const response=await fetch(`http://127.0.0.1:${f.port}/api/me/events`,{headers:{Cookie:alice.cookie,'Last-Event-ID':first.seq},signal:cancel.signal});expect(response.status).toBe(200);reader=response.body!.getReader();expect((await nextEvent(reader)).seq).toBe(second.seq);
  const list=await raw(f.server).get('/api/me/notifications').set('Cookie',bob.cookie).expect(200);expect(list.body.data).toEqual([]);
  for(const cursor of ['abc','1.2','01','9223372036854775808']) {
   await raw(f.server).get('/api/me/events').query({after:cursor}).set('Cookie',alice.cookie).expect(400);
   await raw(f.server).get('/api/me/events').set('Last-Event-ID',cursor).set('Cookie',alice.cookie).expect(400);
  }
  await raw(f.server).head('/api/me/events').set('Cookie',alice.cookie).expect(200);
 }finally{cancel.abort();await reader?.cancel().catch(()=>{});await f.dispose();}
},45000);
test('WS在升級前驗Cookie與精確Origin；只接受本人cursor，logout／expiry會關連線',async()=>{
 const f=await httpFixture();let ws:WebSocket|undefined;try{
  const alice=await session(f.server);const reject=new WebSocket(`ws://127.0.0.1:${f.port}/api/me/socket`,{headers:{Cookie:alice.cookie,Origin:'http://bad.example'}});let status=0;reject.on('unexpected-response',(_req,res)=>{status=res.statusCode!;res.resume();reject.terminate();});reject.on('error',()=>{});await until(()=>status===403);
  ws=new WebSocket(`ws://127.0.0.1:${f.port}/api/me/socket`,{headers:{Cookie:alice.cookie,Origin:origin}});ws.on('error',()=>{});await once(ws,'open');const message=once(ws,'message');ws.send(JSON.stringify({after:'0'}));const event=await notify(f.database);expect(JSON.parse((await message)[0].toString()).seq).toBe(event.seq);
  const closed=once(ws,'close');await f.database.session.updateMany({where:{userId:'u_demo'},data:{expiresAt:new Date(Date.now()-1000)}});await closed;await until(()=>realtimeSnapshot(f.server)!.connections===0 && realtimeSnapshot(f.server)!.timers===0);expect(realtimeSnapshot(f.server)!.timers).toBe(0);
 }finally{ws?.terminate();await f.dispose();}
},45000);
test('每人最多2連線，SSE離線與drain清理timer／listener；不等永久連線才開始shutdown',async()=>{
 const f=await httpFixture();const controllers=[new AbortController(),new AbortController()];const readers:ReadableStreamDefaultReader<Uint8Array>[]=[];
 try{
  const alice=await session(f.server);for(const controller of controllers){const response=await fetch(`http://127.0.0.1:${f.port}/api/me/events`,{headers:{Cookie:alice.cookie},signal:controller.signal});expect(response.status).toBe(200);readers.push(response.body!.getReader());}
  await raw(f.server).get('/api/me/events').set('Cookie',alice.cookie).expect(503);await raw(f.server).head('/api/me/events').set('Cookie',alice.cookie).expect(200);controllers[0].abort();await readers[0].cancel().catch(()=>{});await until(()=>realtimeSnapshot(f.server)!.connections===1);
  await f.server.lifecycle.shutdown();expect(realtimeSnapshot(f.server)!.connections).toBe(0);expect(realtimeSnapshot(f.server)!.timers).toBe(0);
 }finally{controllers.forEach(item=>item.abort());for(const reader of readers)await reader.cancel().catch(()=>{});await f.dispose();}
},45000);

test('WS非法游標只關閉該連線；服務存活，active與初始預約在drain皆回1001',async()=>{
 const f=await httpFixture();const sockets:WebSocket[]=[];try{
  const alice=await session(f.server);
  const open=async()=>{const socket=new WebSocket(`ws://127.0.0.1:${f.port}/api/me/socket`,{headers:{Cookie:alice.cookie,Origin:origin}});sockets.push(socket);socket.on('error',()=>{});await once(socket,'open');return socket;};
  for(const payload of [{after:'abc'},{after:'1\n'},{after:'1.2'},{after:'1e3'},{after:'01'},{after:'9223372036854775808'},null,{after:'0',userId:'u_bob'}]){
   const socket=await open();const closed=once(socket,'close');socket.send(JSON.stringify(payload));expect((await closed)[0]).toBe(1008);
   await until(()=>realtimeSnapshot(f.server)!.timers===0);await raw(f.server).get('/health/live').expect(200);
  }
  const active=await open();active.send(JSON.stringify({after:'0'}));await until(()=>realtimeSnapshot(f.server)!.connections===1);
  const reserved=await open();await until(()=>realtimeSnapshot(f.server)!.connections===2);
  const closing=[once(active,'close'),once(reserved,'close')];await f.server.lifecycle.shutdown();
  expect((await Promise.all(closing)).map(result=>result[0])).toEqual([1001,1001]);expect(realtimeSnapshot(f.server)!.timers).toBe(0);
 }finally{for(const socket of sockets)socket.terminate();await f.dispose();}
},45000);

test('Upgrade拒絕送完後銷毀socket；client保留半開連線也不阻止關閉',async()=>{
 const f=await httpFixture();let client:Socket|undefined;try{
  const accepted=once(f.server,'connection');client=createConnection({host:'127.0.0.1',port:f.port,allowHalfOpen:true});client.on('error',()=>{});
  await once(client,'connect');const [remote]=await accepted as [Socket];let response='';client.on('data',chunk=>response+=chunk.toString());const ended=once(client,'end');
  client.write('GET /api/me/socket HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nOrigin: http://bad.example\r\n\r\n');
  await ended;expect(response).toContain('HTTP/1.1 403');await until(()=>remote.destroyed);
  await f.server.lifecycle.shutdown();expect(realtimeSnapshot(f.server)!.connections).toBe(0);
 }finally{client?.destroy();await f.dispose();}
},45000);
