import { createObservability, type Observability } from './observability.js';
import type { ErrorReport } from './errors.js';
import { Module, type DynamicModule } from '@nestjs/common';
import type { createShutdown } from './shutdown.js';
import { defaultExportFile, type ExportResult } from './export.js';
import { HTTP_OPTIONS, REQUEST_LIFECYCLE, ERROR_REPORTER, OBSERVABILITY } from './tokens.js';

export interface HttpOptions {
  readonly maxBodyBytes: number;
  readonly bodyTimeoutMs: number;
  readonly exportFile: string;
  readonly onExportFinished?: (result: ExportResult, requestId?: string) => void;
}

// 呼叫端提供設定；功能模組不自行讀 process.env，也不取得 DATABASE_URL。
export function resolveHttpOptions(input: Partial<HttpOptions>): Readonly<HttpOptions> {
  const options = {
    maxBodyBytes: input.maxBodyBytes ?? 16 * 1024,
    bodyTimeoutMs: input.bodyTimeoutMs ?? 2000,
    exportFile: input.exportFile ?? defaultExportFile,
    onExportFinished: input.onExportFinished,
  };
  for (const value of [options.maxBodyBytes, options.bodyTimeoutMs]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error('HTTP 限制必須是正整數');
  }
  if (!options.exportFile) throw new Error('匯出路徑不可為空');
  return Object.freeze(options);
}

@Module({})
export class RuntimeModule {
  static register(options: Readonly<HttpOptions>, lifecycle: ReturnType<typeof createShutdown>, reportError: (report: ErrorReport) => void = () => {}, observation: Observability = createObservability()): DynamicModule {
    return { module: RuntimeModule, providers: [
      { provide: OBSERVABILITY, useValue: observation },
      { provide: HTTP_OPTIONS, useValue: options },
      { provide: ERROR_REPORTER, useValue: reportError },
      { provide: REQUEST_LIFECYCLE, useValue: lifecycle },
    ], exports: [OBSERVABILITY, HTTP_OPTIONS, REQUEST_LIFECYCLE, ERROR_REPORTER] };
  }
}
