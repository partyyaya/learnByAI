import { All, Controller, Get, Module, Query, Res } from '@nestjs/common';
import { openapiDocument } from './openapi.js';
import { methodNotAllowed } from './articles.controller.js';
import type { Response } from 'express';
import { ZodValidationPipe } from './zod-validation.pipe.js';
import { emptyQuerySchema } from './schemas.js';

@Controller('api/openapi.json')
export class ApiDescriptionController {
  @Get()
  document(@Query(new ZodValidationPipe(emptyQuerySchema)) _query: Record<string, never>) { return openapiDocument; }
  @All()
  method(@Res() res: Response) { methodNotAllowed(res, 'GET, HEAD'); }
}
@Module({ controllers: [ApiDescriptionController] })
export class ApiDescriptionModule {}
