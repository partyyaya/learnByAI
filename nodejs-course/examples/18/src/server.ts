import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ContractExpressAdapter } from './contract-express.adapter.js';
import type { INestApplication } from '@nestjs/common';
import express from 'express';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { AppModule, type FeatureDependencies } from './app.module.js';
import { RuntimeModule, resolveHttpOptions, type HttpOptions } from './runtime.module.js';
import { ContractExceptionFilter } from './contract-exception.filter.js';
import { HttpError } from './http.js';
import type { ErrorReport } from './errors.js';
import { requestContext, type RequestTrace } from './request-context.js';
import { createShutdown, type ShutdownOptions } from './shutdown.js';

export interface ServerOptions extends ShutdownOptions, Partial<HttpOptions> {
  dependencies: FeatureDependencies;
  onError?: (report: ErrorReport) => void;
  onTrace?: (trace: RequestTrace) => void;
}

export async function createArticleServer(options: ServerOptions) {
  const settings = resolveHttpOptions(options);
  const app = express();
  app.disable('x-powered-by');
  app.disable('etag'); // 本章先固定 200／HEAD 契約，快取驗證留待後續。
  app.set('query parser', 'simple');
  app.set('case sensitive routing', true);
  app.set('strict routing', true);
  const server = createServer({ requestTimeout: 10000, headersTimeout: 5000, maxHeaderSize: 8192 }, (req, res) => {
    // 無法解析的 request-target 可能連 Express 的 middleware 都匹配不到。
    // 在交給框架前檢查，保留 05 章的 INVALID_URL 契約。
    try { new URL(req.url ?? '/', 'http://course.local'); }
    catch {
      const requestId = randomUUID();
      const text = JSON.stringify({ error: { code: 'INVALID_URL', message: '請求 URL 不合法', details: [] }, requestId });
      req.on('error', () => res.destroy()); res.on('error', () => res.destroy()); req.resume();
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text), 'X-Request-ID': requestId, Connection: 'close' });
      res.end(req.method === 'HEAD' ? undefined : text); return;
    }
    app(req, res);
  });
  let nest: INestApplication | undefined;
  const lifecycle = createShutdown(server, {
    ...options,
    closeResources: async signal => {
      // 實際監聽的 server 與登記工作已由協調器等待完畢，才關閉 Nest context。
      try { await nest?.close(); }
      finally { await options.closeResources?.(signal); }
    },
  });
  try {
    const runtime = RuntimeModule.register(settings, lifecycle);
    nest = await NestFactory.create(AppModule.register(options.dependencies, runtime), new ContractExpressAdapter(app), {
      bodyParser: false, logger: false, abortOnError: false,
    });
    app.use(requestContext(options.onTrace));
    app.use((req, res, next) => {
      req.on('error', () => res.destroy()); res.on('error', () => res.destroy());
      if (lifecycle.isDraining) throw new HttpError(503, 'SHUTTING_DOWN', '服務正在關閉');
      res.locals.steps.push('accept');
      next();
    });
    // 舊 Router 的集合根路徑同時接受有／無尾斜線；只正規化這個既有別名。
    // Nest 會移除 decorator path 的尾斜線，不能直接用 @Get('/') 表達此別名。
    app.use((req, _res, next) => {
      if (req.path === '/api/articles/') req.url = req.url.replace('/api/articles/', '/api/articles');
      next();
    });
    nest.useGlobalFilters(new ContractExceptionFilter(options.onError));
    // 所有 HTTP 端點都由 Nest Controller 註冊，包含最後的 404；實際監聽仍由 main.ts 的 server.listen 負責。
    await nest.init();
    return Object.assign(server, { lifecycle });
  } catch (error) {
    await nest?.close();
    throw error;
  }
}
