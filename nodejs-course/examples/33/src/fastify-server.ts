import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import cookie from '@fastify/cookie';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { Request,Response } from 'express';
import { AppModule } from './app.module.js';
import type { ServerOptions } from './server.js';
import { RuntimeModule,resolveHttpOptions } from './runtime.module.js';
import { createShutdown } from './shutdown.js';
import { createObservability } from './observability.js';
import { requestContext } from './request-context.js';
import { HttpError } from './http.js';
import { normalizeError,sendHttpError } from './errors.js';
import { frontend } from './frontend.js';
class CourseFastifyAdapter extends FastifyAdapter {
 override setErrorHandler(handler:any){return super.setErrorHandler((error,request,reply)=>handler(normalizeError(error),request,reply));}
 override all(...args:any[]) {
  const url=args[0];const handler=args.at(-1);
  // Express's first-match GET + ALL fallbacks cannot register duplicate Fastify methods.
  for(const method of this.getInstance().supportedMethods){if(!this.getInstance().hasRoute({method,url}))this.getInstance().route({method,url,handler});}
  return this.getInstance();
 }
}
export async function createFastifyArticleServer(options:ServerOptions){
 const observation=options.observability??createObservability();const report=(value:Parameters<typeof observation.error>[0])=>{observation.error(value);options.onError?.(value);};
 const settings=resolveHttpOptions({...options,onExportFinished:(result,id)=>{observation.exported(result,id);options.onExportFinished?.(result,id);}});
 let nest:INestApplication|undefined;
 const adapter=new CourseFastifyAdapter({logger:false,routerOptions:{caseSensitive:true,ignoreTrailingSlash:false,maxParamLength:1000},requestIdHeader:false,trustProxy:false,
  serverFactory:(handler:import('node:http').RequestListener)=>createServer({requestTimeout:10000,headersTimeout:5000,maxHeaderSize:8192},(nativeReq,nativeRes)=>{
   const req=nativeReq as Request;const res=nativeRes as Response;res.locals={};const id=randomUUID();res.setHeader('X-Request-ID',id);observation.observe(req,res,id);
   requestContext(options.onTrace)(req,res,()=>{
    try{new URL(req.url??'/','http://course.local');const path=(req.url??'/').split('?')[0];decodeURI(path);Object.defineProperty(req,'path',{value:path,configurable:true});
     if(lifecycle.isDraining&&!['/health/live','/health/metrics'].includes(path))throw new HttpError(503,'SHUTTING_DOWN','服務正在關閉');
     res.locals.steps.push('accept');if(path==='/api/articles/')req.url=req.url.replace('/api/articles/','/api/articles');Object.defineProperty(req,'path',{value:req.url?.split('?')[0],configurable:true});
     // Fixed assets use the same native HTTP boundary; JSON still goes through Fastify/Nest.
     frontend()(req,res,error=>{if(error)sendHttpError(error,req,res,report);else handler(req,res);});
    }catch(error){sendHttpError(error instanceof TypeError?new HttpError(400,'INVALID_URL','URL不合法'):error,req,res,report);}
   });
  })});
 const server=adapter.getHttpServer();
 const lifecycle=createShutdown(server,{...options,onEvent:event=>{observation.lifecycle(event);options.onEvent?.(event);},closeResources:async signal=>{try{await nest?.close();}finally{await options.closeResources?.(signal);}}});
 try{
  const fastify=adapter.getInstance();await fastify.register(cookie);
  fastify.removeAllContentTypeParsers();fastify.addContentTypeParser('*',(request,_stream,done)=>done(null,(request.raw as Request).body));
  const root=AppModule.register(options.dependencies,RuntimeModule.register(settings,lifecycle,report,observation));
  const config={bodyParser:false,logger:false as const,abortOnError:false};
  nest=options.applicationFactory?await options.applicationFactory(root,adapter as never,config):await NestFactory.create(root,adapter,config);
  await nest.init();await fastify.ready();
  // Fastify's own URI/parser errors must keep the shared safe envelope.

  return Object.assign(server,{lifecycle,observation});
 }catch(error){await nest?.close();throw error;}
}
