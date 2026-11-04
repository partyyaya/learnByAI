import type { z } from 'zod';
import type { draftSchema, patchSchema, versionSchema, paginationSchema, idSchema, emptyQuerySchema, publicArticleListSchema, managedArticleListSchema } from './schemas.js';

// DTO 描述 HTTP 邊界傳遞的資料。以 schema 推導，避免另寫一套不同步的欄位規則。
// 這些是編譯期型別；執行期驗證來自裝飾器明確綁定的 schema，不依賴 metatype。
export type CreateArticleDto = z.output<typeof draftSchema>;
export type PatchArticleDto = z.output<typeof patchSchema>;
export type ChangeArticleStateDto = z.output<typeof versionSchema>;
export type ArticleParamsDto = z.output<typeof idSchema>;
export type ArticlePaginationDto = z.output<typeof paginationSchema>;
export type ExportQueryDto = z.output<typeof emptyQuerySchema>;

// query 的 wire 輸入是字串；Pipe 輸出才是已補預設值與檢查範圍的數字。
export type PaginationQueryInput = z.input<typeof paginationSchema>;

export type PublicArticleListDto = z.output<typeof publicArticleListSchema>;
export type ManagedArticleListDto = z.output<typeof managedArticleListSchema>;
