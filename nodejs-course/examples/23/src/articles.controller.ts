import { All, Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { ArticleService } from './article-service.js';
import type { ArticleAction } from './article-model.js';
import type { createShutdown } from './shutdown.js';
import type { HttpOptions } from './runtime.module.js';
import { ARTICLE_SERVICE, HTTP_OPTIONS, REQUEST_LIFECYCLE } from './tokens.js';
import { draftSchema, patchSchema, versionSchema, publicArticleListSchema, managedArticleListSchema, idSchema, emptyQuerySchema } from './schemas.js';
import { ZodValidationPipe } from './zod-validation.pipe.js';
import type { CreateArticleDto, PatchArticleDto, ChangeArticleStateDto, ArticleParamsDto, PublicArticleListDto, ManagedArticleListDto, ExportQueryDto } from './article.dto.js';
import { SerializeResponse, articleResponse, articlePageResponse } from './response-projection.js';
import { streamExport } from './export.js';
import { HttpError } from './http.js';
import { SessionGuard, CsrfGuard, AdminGuard } from './auth.guards.js';
import { CurrentActor } from './auth-http.js';
import type { Actor } from './auth-model.js';

export function methodNotAllowed(res: Response, allow: string): never {
  res.setHeader('Allow', allow);
  throw new HttpError(405, 'METHOD_NOT_ALLOWED', '此路由不支援該方法');
}

@Controller('api/articles')
export class ArticlesController {
  constructor(
    @Inject(ARTICLE_SERVICE) private readonly articles: ArticleService,
    @Inject(REQUEST_LIFECYCLE) private readonly lifecycle: ReturnType<typeof createShutdown>,
    @Inject(HTTP_OPTIONS) private readonly options: Readonly<HttpOptions>,
  ) {}

  private run<T>(res: Response, work: () => Promise<T>): Promise<T> {
    res.locals.steps.push('nest:controller');
    return this.lifecycle.track((async () => {
      const result = await work(); res.locals.steps.push('nest:return'); return result;
    })());
  }

  // 固定路徑及其 405 必須排在 :id 前，避免被當成文章 ID。
  @Get('export')
  async export(@Query(new ZodValidationPipe(emptyQuerySchema)) _query: ExportQueryDto, @Req() req: Request, @Res() res: Response) {
    await this.run(res, async () => {
      const result = await streamExport(res, this.options.exportFile, req.method === 'HEAD');
      this.options.onExportFinished?.(result);
    });
  }
  @All('export') exportMethod(@Res() res: Response) { methodNotAllowed(res, 'GET, HEAD'); }

  @Post('preview') @HttpCode(200)
  preview(@Body(new ZodValidationPipe(draftSchema)) input: CreateArticleDto, @Res({ passthrough: true }) res: Response) {
    return this.run(res, async () => ({ data: { ...input, status: 'draft', preview: true } }));
  }
  @All('preview') previewMethod(@Res() res: Response) { methodNotAllowed(res, 'POST'); }

  @Get()
  @SerializeResponse(articlePageResponse)
  list(@Query(new ZodValidationPipe(publicArticleListSchema)) query: PublicArticleListDto, @Res({ passthrough: true }) res: Response) {
    return this.run(res, async () => {
      const result = await this.articles.list(query, true);
      return result;
    });
  }
  @Post()
  @SerializeResponse(articleResponse)
  @UseGuards(SessionGuard, CsrfGuard)
  create(@Body(new ZodValidationPipe(draftSchema)) input: CreateArticleDto, @CurrentActor() actor: Actor, @Res({ passthrough: true }) res: Response) {
    return this.run(res, async () => {
      const article = await this.articles.create(input, actor);
      res.location(`/api/me/articles/${article.id}`);
      return article;
    });
  }
  @All() collectionMethod(@Res() res: Response) { methodNotAllowed(res, 'GET, HEAD, POST'); }

  @Get(':id')
  @SerializeResponse(articleResponse)
  detail(@Param(new ZodValidationPipe(idSchema)) { id }: ArticleParamsDto, @Res({ passthrough: true }) res: Response) {
    return this.run(res, () => this.articles.detail(id, true));
  }
  @Patch(':id')
  @SerializeResponse(articleResponse)
  @UseGuards(SessionGuard, CsrfGuard)
  edit(@Param(new ZodValidationPipe(idSchema)) params: ArticleParamsDto,
    @Body(new ZodValidationPipe(patchSchema)) input: PatchArticleDto, @CurrentActor() actor: Actor, @Res({ passthrough: true }) res: Response) {
    return this.change('edit', params, input, actor, res);
  }
  @All(':id') detailMethod(@Res() res: Response) { methodNotAllowed(res, 'GET, HEAD, PATCH'); }

  @Post(':id/publish') @HttpCode(200)
  @SerializeResponse(articleResponse)
  @UseGuards(SessionGuard, CsrfGuard)
  publish(@Param(new ZodValidationPipe(idSchema)) params: ArticleParamsDto,
    @Body(new ZodValidationPipe(versionSchema)) input: ChangeArticleStateDto, @CurrentActor() actor: Actor, @Res({ passthrough: true }) res: Response) {
    return this.change('publish', params, input, actor, res);
  }
  @Post(':id/archive') @HttpCode(200)
  @SerializeResponse(articleResponse)
  @UseGuards(SessionGuard, CsrfGuard)
  archive(@Param(new ZodValidationPipe(idSchema)) params: ArticleParamsDto,
    @Body(new ZodValidationPipe(versionSchema)) input: ChangeArticleStateDto, @CurrentActor() actor: Actor, @Res({ passthrough: true }) res: Response) {
    return this.change('archive', params, input, actor, res);
  }
  @All([':id/publish', ':id/archive']) actionMethod(@Res() res: Response) { methodNotAllowed(res, 'POST'); }

  private change(action: ArticleAction, { id }: ArticleParamsDto, input: PatchArticleDto | ChangeArticleStateDto, actor: Actor, res: Response) {
    return this.run(res, () => this.articles.change(id, input, action, actor));
  }
}

@Controller('api/me/articles')
export class ManagedArticlesController {
  constructor(
    @Inject(ARTICLE_SERVICE) private readonly articles: ArticleService,
    @Inject(REQUEST_LIFECYCLE) private readonly lifecycle: ReturnType<typeof createShutdown>,
  ) {}
  @Get()
  @SerializeResponse(articlePageResponse)
  @UseGuards(SessionGuard)
  list(@Query(new ZodValidationPipe(managedArticleListSchema)) query: ManagedArticleListDto, @CurrentActor() actor: Actor, @Res({ passthrough: true }) res: Response) {
    res.locals.steps.push('nest:controller');
    return this.lifecycle.track((async () => {
      const result = await this.articles.list(query, false, actor);
      return result;
    })());
  }
  @All() collectionMethod(@Res() res: Response) { methodNotAllowed(res, 'GET, HEAD'); }
  @Get(':id')
  @SerializeResponse(articleResponse)
  @UseGuards(SessionGuard)
  detail(@Param(new ZodValidationPipe(idSchema)) { id }: ArticleParamsDto, @CurrentActor() actor: Actor, @Res({ passthrough: true }) res: Response) {
    res.locals.steps.push('nest:controller');
    return this.lifecycle.track(this.articles.detail(id, false, actor));
  }
  @All(':id') detailMethod(@Res() res: Response) { methodNotAllowed(res, 'GET, HEAD'); }
}

@Controller('api/admin/articles')
export class AdminArticlesController {
  constructor(@Inject(ARTICLE_SERVICE) private readonly articles: ArticleService) {}
  @Get(':id') @UseGuards(SessionGuard, AdminGuard)
  @SerializeResponse(articleResponse)
  async detail(@Param(new ZodValidationPipe(idSchema)) { id }: ArticleParamsDto, @CurrentActor() actor: Actor) {
    return this.articles.adminDetail(id, actor);
  }
  @All(':id') detailMethod(@Res() res: Response) { methodNotAllowed(res, 'GET, HEAD'); }
}
