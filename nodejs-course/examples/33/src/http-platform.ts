import type { Request,Response,CookieOptions } from 'express';
import type { FastifyReply,FastifyRequest } from 'fastify';
import type { ServerResponse } from 'node:http';
import type {} from '@fastify/cookie';
export interface ResponsePort {
 locals: {requestId?:string;steps:string[]}; readonly destroyed:boolean;readonly writableEnded:boolean;readonly headersSent:boolean;readonly statusCode:number;
 shouldKeepAlive:boolean;setHeader:(name:string,value:string|number|readonly string[])=>unknown;getHeader:(name:string)=>unknown;
 status:(code:number)=>ResponsePort;json:(body:unknown)=>unknown;send:(body:string)=>unknown;type:(mime:string)=>unknown;location:(url:string)=>unknown;
 cookie:(name:string,value:string,options:CookieOptions)=>unknown;clearCookie:(name:string,options:CookieOptions)=>unknown;destroy:()=>unknown;
}
export const rawRequest=(req:Request|FastifyRequest):Request=>('raw'in req?req.raw:req) as Request;
export function rawResponse(reply:Response|FastifyReply,hijack=false):ServerResponse {
 if('raw'in reply){if(hijack)reply.hijack();return reply.raw;}return reply;
}
export function responsePort(reply:Response|FastifyReply):ResponsePort {
 if(!('raw'in reply)){
  if(typeof reply.status==='function')return reply as unknown as ResponsePort;
  const native=reply as Response;
  const write=(body:string,mime:string)=>{native.setHeader('Content-Type',mime);native.setHeader('Content-Length',Buffer.byteLength(body));native.end(native.req.method==='HEAD'?undefined:body);};
  const port:ResponsePort={locals:native.locals as ResponsePort['locals'],get destroyed(){return native.destroyed;},get writableEnded(){return native.writableEnded;},get headersSent(){return native.headersSent;},get statusCode(){return native.statusCode;},get shouldKeepAlive(){return native.shouldKeepAlive;},set shouldKeepAlive(value){native.shouldKeepAlive=value;},setHeader:(key,value)=>native.setHeader(key,value),getHeader:key=>native.getHeader(key),status:code=>{native.statusCode=code;return port;},json:body=>write(JSON.stringify(body),'application/json; charset=utf-8'),send:body=>write(body,String(native.getHeader('Content-Type')??'text/plain; charset=utf-8')),type:mime=>native.setHeader('Content-Type',mime),location:url=>native.setHeader('Location',url),destroy:()=>native.destroy(),cookie:()=>{throw new Error('raw Cookie writer not configured');},clearCookie:()=>{throw new Error('raw Cookie writer not configured');}};
  return port;
 }
 const native=reply.raw as ServerResponse&{locals:ResponsePort['locals']};
 const port:ResponsePort={locals:native.locals as ResponsePort['locals'],get destroyed(){return native.destroyed;},get writableEnded(){return native.writableEnded;},get headersSent(){return native.headersSent;},get statusCode(){return native.statusCode;},get shouldKeepAlive(){return native.shouldKeepAlive;},set shouldKeepAlive(value){native.shouldKeepAlive=value;},
  setHeader:(key,value)=>reply.header(key,value),getHeader:key=>reply.getHeader(key),status:code=>{reply.code(code);return port;},json:body=>reply.send(body),send:body=>reply.send(body),type:mime=>reply.type(mime),location:url=>reply.header('Location',url),destroy:()=>native.destroy(),
  cookie:(name,value,options)=>reply.setCookie(name,value,{...options,...(options.maxAge===undefined?{}:{maxAge:Math.floor(options.maxAge/1000)})} as Parameters<FastifyReply['setCookie']>[2]),
  clearCookie:(name,options)=>reply.clearCookie(name,options as Parameters<FastifyReply['clearCookie']>[1]),
 };return port;
}
