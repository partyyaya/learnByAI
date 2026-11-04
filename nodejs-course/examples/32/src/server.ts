import 'reflect-metadata';
import { frontend } from './frontend.js';
import { createObservability, type Observability } from './observability.js';
import { NestFactory } from '@nestjs/core';
import { ContractExpressAdapter } from './contract-express.adapter.js';
import type { INestApplication, DynamicModule, NestApplicationOptions } from '@nestjs/common';
import express from 'express';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { AppModule, type FeatureDependencies } from './app.module.js';
import { RuntimeModule, resolveHttpOptions, type HttpOptions } from './runtime.module.js';
import { HttpError } from './http.js';
import type { ErrorReport } from './errors.js';
import { requestContext, type RequestTrace } from './request-context.js';
import { createShutdown, type ShutdownOptions } from './shutdown.js';

// 組裝入口可以替換容器的建立方式；HTTP 設定、adapter、init 與關閉仍走同一流程。
// 正式入口沿用 NestFactory，TestingModule 的依賴只存在 test/。
export type NestApplicationFactory = (root: DynamicModule, adapter: ContractExpressAdapter,
  options: NestApplicationOptions) => Promise<INestApplication>;
export interface ServerOptions extends ShutdownOptions, Partial<HttpOptions> {
  dependencies: FeatureDependencies;
  applicationFactory?: NestApplicationFactory;
  observability?: Observability;
  installTransports?: (app: express.Application, server: ReturnType<typeof createServer>, nest: INestApplication, lifecycle: ReturnType<typeof createShutdown>) => void;
  onError?: (report: ErrorReport) => void;
  onTrace?: (trace: RequestTrace) => void;
}

export async function createArticleServer(options: ServerOptions) {
  const observation = options.observability ?? createObservability();
  const reportError = (report: ErrorReport) => { observation.error(report); options.onError?.(report); };
  const settings = resolveHttpOptions({ ...options, onExportFinished: (result, requestId) => {
    observation.exported(result, requestId); options.onExportFinished?.(result, requestId);
  } });
  const app = express();
  app.disable('x-powered-by');
  app.disable('etag'); // 本章先固定 200／HEAD 契約，快取驗證留待後續。
  app.set('query parser', 'simple');
  app.set('case sensitive routing', true);
  app.set('strict routing', true);
  const server = createServer({ requestTimeout: 10000, headersTimeout: 5000, maxHeaderSize: 8192 }, (req, res) => {
    const requestId = randomUUID();
    res.setHeader('X-Request-ID', requestId);
    observation.observe(req, res, requestId);
    // 無法解析的 request-target 可能連 Express 的 middleware 都匹配不到。
    // 在交給框架前檢查，保留 05 章的 INVALID_URL 契約。
    try { new URL(req.url ?? '/', 'http://course.local'); }
    catch {
      reportError({ requestId, status: 400, code: 'INVALID_URL', phase: 'before-response' });
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
    onEvent: event => { observation.lifecycle(event); options.onEvent?.(event); },
    closeResources: async signal => {
      // 實際監聽的 server 與登記工作已由協調器等待完畢，才關閉 Nest context。
      try { await nest?.close(); }
      finally { await options.closeResources?.(signal); }
    },
  });
  try {
    const runtime = RuntimeModule.register(settings, lifecycle, reportError, observation);
    const factory: NestApplicationFactory = options.applicationFactory ?? ((root, adapter, settings) => NestFactory.create(root, adapter, settings));
    nest = await factory(AppModule.register(options.dependencies, runtime), new ContractExpressAdapter(app), {
      bodyParser: false, logger: false, abortOnError: false,
    });
    app.use(requestContext(options.onTrace));
    app.use((req, res, next) => {
      req.on('error', () => res.destroy()); res.on('error', () => res.destroy());
      if (lifecycle.isDraining && req.path !== '/health/live' && req.path !== '/health/metrics') throw new HttpError(503, 'SHUTTING_DOWN', '服務正在關閉');
      res.locals.steps.push('accept');
      next();
    });
    // 舊 Router 的集合根路徑同時接受有／無尾斜線；只正規化這個既有別名。
    // Nest 會移除 decorator path 的尾斜線，不能直接用 @Get('/') 表達此別名。
    app.use((req, _res, next) => {
      if (req.path === '/api/articles/') req.url = req.url.replace('/api/articles/', '/api/articles');
      next();
    });
    // JSON API 與最後的 404 由 Nest Controller 註冊；固定前端資產先由此 middleware 處理。
    // 實際監聽仍由 main.ts 的 server.listen 負責。
    options.installTransports?.(app, server, nest, lifecycle);
    app.use(frontend());
    await nest.init();
    return Object.assign(server, { lifecycle, observation });
  } catch (error) {
    await nest?.close();
    throw error;
  }
}
