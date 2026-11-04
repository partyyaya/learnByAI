import 'reflect-metadata';
import { Body, Controller, Get, HttpCode, Module, Post, Query, Req } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import express, { type Request } from 'express';
import { z } from 'zod';
import { ContractExpressAdapter } from './contract-express.adapter.js';
import { ContractExceptionFilter } from './contract-exception.filter.js';
import { requestContext } from './request-context.js';
import { jsonBody } from './json-body.js';
import { ZodValidationPipe } from './zod-validation.pipe.js';
import { draftSchema, paginationSchema } from './schemas.js';
import type { CreateArticleDto, ArticlePaginationDto } from './article.dto.js';

// 僅為反例：class 與屬性型別本身不會驗證收到的 JSON。
export class UncheckedDraftDto {
  title!: string;
  content!: string;
}

// 獨立示範欄位，不是文章 API 新功能；null 表示刻意清空，省略表示不修改。
export const nicknameSchema = z.strictObject({ nickname: z.string().trim().min(1).nullable().optional() });
type NicknameDto = z.output<typeof nicknameSchema>;

@Controller('validation')
export class ValidationLabController {
  @Post('unchecked') @HttpCode(200)
  unchecked(@Body() dto: UncheckedDraftDto) {
    return { data: dto, classInstance: dto instanceof UncheckedDraftDto };
  }

  @Post('checked') @HttpCode(200)
  checked(@Body(new ZodValidationPipe(draftSchema)) dto: CreateArticleDto, @Req() req: Request) {
    return { data: dto, rawTitle: req.body.title };
  }

  @Get('query')
  query(@Query(new ZodValidationPipe(paginationSchema)) dto: ArticlePaginationDto, @Req() req: Request) {
    return { data: dto, raw: req.query };
  }

  @Post('nullable') @HttpCode(200)
  nullable(@Body(new ZodValidationPipe(nicknameSchema)) dto: NicknameDto) {
    return { data: dto, hasNickname: Object.hasOwn(dto, 'nickname') };
  }
}

@Module({ controllers: [ValidationLabController] })
class ValidationLabModule {}

// 不匯入正式 AppModule，不連資料庫，不把未驗證反例掛入文章 API。
export async function createValidationLab() {
  const expressApp = express();
  expressApp.set('query parser', 'simple');
  const app = await NestFactory.create(ValidationLabModule, new ContractExpressAdapter(expressApp), {
    bodyParser: false, logger: false, abortOnError: false,
  });
  try {
    app.use(requestContext());
    const parse = jsonBody(16 * 1024, 2000);
    expressApp.use((req, res, next) => req.method === 'POST' ? parse(req, res, next) : next());
    app.useGlobalFilters(new ContractExceptionFilter());
    await app.init();
    return app;
  } catch (error) { await app.close(); throw error; }
}
