const { mkdir, writeFile } = require('node:fs/promises');
const { openapiDocument } = require('../dist/openapi.js');
(async () => {
  await mkdir('.data', { recursive: true });
  await writeFile('.data/openapi.json', JSON.stringify(openapiDocument, null, 2) + '\n');
  console.log('已輸出 .data/openapi.json（OpenAPI 3.1.1）；不連資料庫，不含憑證。');
})().catch(() => { console.error('OPENAPI_EXPORT_FAILED：請先 build'); process.exitCode = 1; });
