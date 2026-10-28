import { open } from 'node:fs/promises';
import type { ReadStream } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { HttpError } from './http.js';

// 只提供由伺服器指定的固定檔案；不把 URL 參數拼成磁碟路徑。
export const defaultExportFile = resolve(__dirname, '..', '.data', 'articles.ndjson');
export interface ExportResult {
  outcome: 'complete' | 'interrupted';
  bytesRead: number;
  fileClosed: boolean;
  errorCode?: string;
}

export async function streamExport(res: ServerResponse, filename: string, head: boolean): Promise<ExportResult> {
  const handle = await open(filename, 'r').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') throw new HttpError(404, 'EXPORT_NOT_FOUND', '尚未建立匯出檔案，請先執行 seed');
    throw error;
  });
  let source: ReadStream | undefined;
  const controller = new AbortController();
  const onClose = () => {
    if (!res.writableFinished) controller.abort(new Error('response closed before finish'));
  };
  let outcome: ExportResult['outcome'] = 'complete';
  let errorCode: string | undefined;
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new HttpError(404, 'EXPORT_NOT_FOUND', '匯出來源不是檔案');
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="articles.ndjson"');
    res.setHeader('Content-Length', stat.size);
    if (head) {
      res.end();
    } else {
      // handle 由本函式 finally 關閉，stream 不另外擁有關閉責任。
      source = handle.createReadStream({ highWaterMark: 16 * 1024, autoClose: false });
      res.once('close', onClose);
      if (res.destroyed) controller.abort();
      try {
        await pipeline(source, res, { signal: controller.signal });
      } catch (error: unknown) {
        // pipeline 可能已破壞回應串流；不能在檔案片段後追加 JSON 錯誤。
        outcome = 'interrupted';
        errorCode = error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
          ? error.code : 'STREAM_FAILED';
        res.destroy();
      }
    }
  } finally {
    res.off('close', onClose);
    source?.destroy();
    await handle.close();
  }
  return { outcome, bytesRead: source?.bytesRead ?? 0, fileClosed: handle.fd === -1, ...(errorCode ? { errorCode } : {}) };
}
