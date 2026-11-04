import type { ArgumentMetadata, PipeTransform } from '@nestjs/common';
import type { z } from 'zod';
import { parseInput } from './validation.js';

// 無可變請求狀態、沒有 I/O。每個參數明確綁定自己的 schema，回傳新的驗證結果。
export class ZodValidationPipe<T extends z.ZodType> implements PipeTransform<unknown, z.output<T>> {
  constructor(private readonly schema: T) {}

  transform(value: unknown, metadata: ArgumentMetadata): z.output<T> {
    // 本課驗證整個物件才能拒絕額外欄位；不支援 @Body('title') 等逐欄位綁定。
    if (metadata.data !== undefined || !['body', 'query', 'param'].includes(metadata.type)) {
      throw new Error('ZodValidationPipe 必須綁定完整 Body、Query 或 Param 物件');
    }
    const source = metadata.type === 'param' ? 'params' : metadata.type as 'body' | 'query';
    return parseInput(this.schema, source, value);
  }
}
