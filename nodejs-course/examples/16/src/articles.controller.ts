import { All, Controller, Get, HttpCode, Inject, Patch, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { ArticleService } from './article-service.js';
import type { ArticleAction } from './article-model.js';
import type { createShutdown } from './shutdown.js';
import type { HttpOptions } from './runtime.module.js';
import { ARTICLE_SERVICE, HTTP_OPTIONS, REQUEST_LIFECYCLE } from './tokens.js';
import { draftSchema, patchSchema, versionSchema, paginationSchema, idSchema, emptyQuerySchema } from './schemas.js';
import { parseInput } from './validation.js';
import { present } from './article-presenter.js';
import { streamExport } from './export.js';
import { HttpError } from './http.js';

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
  async export(@Req() req: Request, @Res() res: Response) {
    parseInput(emptyQuerySchema, 'query', req.query);
    await this.run(res, async () => {
      const result = await streamExport(res, this.options.exportFile, req.method === 'HEAD');
      this.options.onExportFinished?.(result);
    });
  }
  @All('export') exportMethod(@Res() res: Response) { methodNotAllowed(res, 'GET, HEAD'); }

  @Post('preview') @HttpCode(200)
  preview(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const input = parseInput(draftSchema, 'body', req.body);
    return this.run(res, async () => ({ data: { ...input, status: 'draft', preview: true } }));
  }
  @All('preview') previewMethod(@Res() res: Response) { methodNotAllowed(res, 'POST'); }

  @Get()
  list(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const query = parseInput(paginationSchema, 'query', req.query);
    return this.run(res, async () => {
      const result = await this.articles.list(query, true);
      return { data: result.data.map(present), meta: result.meta };
    });
  }
  @Post()
  create(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const input = parseInput(draftSchema, 'body', req.body);
    return this.run(res, async () => {
      const article = await this.articles.create(input);
      res.location(`/api/me/articles/${article.id}`);
      return { data: present(article) };
    });
  }
  @All() collectionMethod(@Res() res: Response) { methodNotAllowed(res, 'GET, HEAD, POST'); }

  @Get(':id')
  detail(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const { id } = parseInput(idSchema, 'params', req.params);
    return this.run(res, async () => ({ data: present(await this.articles.detail(id, true)) }));
  }
  @Patch(':id')
  edit(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.change('edit', req, res);
  }
  @All(':id') detailMethod(@Res() res: Response) { methodNotAllowed(res, 'GET, HEAD, PATCH'); }

  @Post(':id/publish') @HttpCode(200)
  publish(@Req() req: Request, @Res({ passthrough: true }) res: Response) { return this.change('publish', req, res); }
  @Post(':id/archive') @HttpCode(200)
  archive(@Req() req: Request, @Res({ passthrough: true }) res: Response) { return this.change('archive', req, res); }
  @All([':id/publish', ':id/archive']) actionMethod(@Res() res: Response) { methodNotAllowed(res, 'POST'); }

  private change(action: ArticleAction, req: Request, res: Response) {
    const { id } = parseInput(idSchema, 'params', req.params);
    const input = parseInput(action === 'edit' ? patchSchema : versionSchema, 'body', req.body);
    return this.run(res, async () => ({ data: present(await this.articles.change(id, input, action)) }));
  }
}

// /me 仍為固定示範作者；認證與授權在 18 章加入。
@Controller('api/me/articles')
export class ManagedArticlesController {
  constructor(
    @Inject(ARTICLE_SERVICE) private readonly articles: ArticleService,
    @Inject(REQUEST_LIFECYCLE) private readonly lifecycle: ReturnType<typeof createShutdown>,
  ) {}
  @Get()
  list(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const query = parseInput(paginationSchema, 'query', req.query);
    res.locals.steps.push('nest:controller');
    return this.lifecycle.track((async () => {
      const result = await this.articles.list(query, false);
      return { data: result.data.map(present), meta: result.meta };
    })());
  }
  @All() collectionMethod(@Res() res: Response) { methodNotAllowed(res, 'GET, HEAD'); }
  @Get(':id')
  detail(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const { id } = parseInput(idSchema, 'params', req.params);
    res.locals.steps.push('nest:controller');
    return this.lifecycle.track((async () => ({ data: present(await this.articles.detail(id, false)) }))());
  }
  @All(':id') detailMethod(@Res() res: Response) { methodNotAllowed(res, 'GET, HEAD'); }
}
