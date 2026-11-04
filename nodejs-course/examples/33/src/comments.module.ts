import { responsePort, rawRequest, rawResponse } from './http-platform.js';
import { All, Body, Controller, Delete, Get, HttpCode, Inject, Module, Param, Post, Query, Res, UseGuards, RequestMethod, type DynamicModule, type NestModule, type MiddlewareConsumer } from '@nestjs/common';
import type { Response, RequestHandler } from 'express';
import { z } from 'zod';
import { createCommentStore, type CommentStore } from './comment-store.js';
import type { Database } from './database.js';
import { DATABASE, HTTP_OPTIONS } from './tokens.js';
import type { HttpOptions } from './runtime.module.js';
import { ZodValidationPipe } from './zod-validation.pipe.js';
import { idSchema, paginationSchema, emptyQuerySchema, type Pagination } from './schemas.js';
import { SessionGuard, CsrfGuard, AdminGuard } from './auth.guards.js';
import { CurrentActor } from './auth-http.js';
import type { Actor } from './auth-model.js';
import { jsonBody } from './json-body.js';
import { HttpError } from './http.js';
const STORE = Symbol('COMMENT_STORE');
export const commentInput = z.strictObject({ content: z.string().trim().refine(value => [...value].length >= 1 && [...value].length <= 1000 && !value.includes('\0'), { error: '留言為 1–1000 個 Unicode code points，不能含 NUL' }) });
const params = new ZodValidationPipe(idSchema); const page = new ZodValidationPipe(paginationSchema);
function method(res: Response, allow: string): never { responsePort(res).setHeader('Allow', allow); throw new HttpError(405, 'METHOD_NOT_ALLOWED', '此路由不支援該方法'); }
@Controller('api/articles/:id/comments')
export class ArticleCommentsController {
  constructor(@Inject(STORE) private readonly store: CommentStore) {}
  @Get() list(@Param(params) { id }: { id: string }, @Query(page) query: Pagination) { return this.store.list(id, query); }
  @Post() @UseGuards(SessionGuard, CsrfGuard)
  async create(@Param(params) { id }: { id: string }, @Query(new ZodValidationPipe(emptyQuerySchema)) _query: object,
    @Body(new ZodValidationPipe(commentInput)) input: { content: string }, @CurrentActor() actor: Actor) { return this.store.create(id, input.content, actor); }
  @All() method(@Res() res: Response) { return method(res, 'GET, HEAD, POST'); }
}
@Controller('api/comments/:id')
export class CommentsController {
  constructor(@Inject(STORE) private readonly store: CommentStore) {}
  @Delete() @HttpCode(204) @UseGuards(SessionGuard, CsrfGuard)
  async remove(@Param(params) { id }: { id: string }, @Query(new ZodValidationPipe(emptyQuerySchema)) _query: object, @CurrentActor() actor: Actor) { await this.store.remove(id, actor); }
  @All() method(@Res() res: Response) { return method(res, 'DELETE'); }
}
@Controller('api/admin/articles/:id/status-audits')
@UseGuards(SessionGuard, AdminGuard)
export class StatusAuditsController {
  constructor(@Inject(STORE) private readonly store: CommentStore) {}
  @Get() list(@Param(params) { id }: { id: string }, @Query(page) query: Pagination) { return this.store.audits(id, query); }
  @All() method(@Res() res: Response) { return method(res, 'GET, HEAD'); }
}
@Module({})
export class CommentsCoreModule {
  static register(database: DynamicModule): DynamicModule {
    return { module: CommentsCoreModule, imports: [database], providers: [{ provide: STORE, inject: [DATABASE], useFactory: (db: Database) => createCommentStore(db) }], exports: [STORE] };
  }
}
@Module({ controllers: [ArticleCommentsController, CommentsController, StatusAuditsController] })
export class CommentsModule implements NestModule {
  constructor(@Inject(HTTP_OPTIONS) private readonly options: HttpOptions) {}
  static register(core: DynamicModule, runtime: DynamicModule, auth: DynamicModule): DynamicModule { return { module: CommentsModule, imports: [core, runtime, auth] }; }
  configure(consumer: MiddlewareConsumer) {
    const parse = jsonBody(this.options.maxBodyBytes, this.options.bodyTimeoutMs);
    const body: RequestHandler = (req, res, next) => req.path.endsWith('/') ? next() : parse(req, res, next);
    const emptyBody: RequestHandler = (req, _res, next) => {
      if (req.headers['transfer-encoding'] || Number(req.headers['content-length'] ?? 0) !== 0) { rawRequest(req).resume(); next(new HttpError(400, 'VALIDATION_ERROR', 'DELETE 不接受 body')); } else next();
    };
    consumer.apply(body).forRoutes({ path: 'api/articles/:id/comments', method: RequestMethod.POST });
    consumer.apply(emptyBody).forRoutes({ path: 'api/comments/:id', method: RequestMethod.DELETE });
  }
}
