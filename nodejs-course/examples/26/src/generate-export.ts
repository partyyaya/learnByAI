import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { defaultExportFile } from './export.js';

async function main(): Promise<void> {
  const rawCount = process.argv[2] ?? '20000';
  const count = Number(rawCount);
  if (!/^[0-9]+$/.test(rawCount) || !Number.isInteger(count) || count < 1 || count > 1000000) {
    throw new Error('筆數必須是 1–1000000 的整數');
  }
  await mkdir(dirname(defaultExportFile), { recursive: true });
  const temp = `${defaultExportFile}.${randomUUID()}.tmp`;
  function* lines() {
    for (let index = 1; index <= count; index++) {
      yield Buffer.from(JSON.stringify({ id: `a_${index}`, title: `文章 ${index}`, content: '串流資料。'.repeat(8), status: 'published' }) + '\n');
    }
  }
  try {
    await pipeline(
      Readable.from(lines(), { objectMode: false, highWaterMark: 16 * 1024 }),
      createWriteStream(temp, { flags: 'wx' }),
    );
    // 完成後才替換固定入口，避免讀者下載正在寫入的半成品。
    await rename(temp, defaultExportFile);
    console.log(`已建立 ${count} 筆 NDJSON：${defaultExportFile}`);
  } finally {
    await rm(temp, { force: true });
  }
}

void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
