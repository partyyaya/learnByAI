// 明確維護 wire 契約；TypeScript DTO 不會自動變成 OpenAPI 或執行期驗證。
// 標準 JSON Schema 無法表達 trim、bytes 限制與資料權限，這些需文字與 HTTP 測試。
export type ApiSchema = Record<string, unknown>;
export interface ApiOperation {
  operationId: string;
  summary: string;
  parameters: Record<string, unknown>[];
  security: Record<string, string[]>[];
  responses: Record<string, Record<string, unknown>>;
  requestBody?: Record<string, unknown>;
  description?: string;
  'x-query-unknown-fields'?: string;
}
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const object = (properties: Record<string, ApiSchema>, required = Object.keys(properties)): ApiSchema =>
  ({ type: 'object', properties, required, additionalProperties: false });
const string: ApiSchema = { type: 'string' };
const id: ApiSchema = { type: 'string', minLength: 1, description: '不透明 ID，不限定 UUID。' };
const version: ApiSchema = { type: 'integer', minimum: 1, maximum: 2147483647 };
const token: ApiSchema = { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$' };
const status: ApiSchema = { type: 'string', enum: ['draft', 'published', 'archived'] };
const date: ApiSchema = { type: 'string', format: 'date-time' };
const trimmed = (max: number): ApiSchema => ({ type: 'string', description: `先 trim，再檢查 1–${max} 個 Unicode code points；不 normalize。`,
  'x-trimmed-min-code-points': 1, 'x-trimmed-max-code-points': max });
const expected: ApiSchema = { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER,
  description: '必填，正安全整數，不接受字串；與目前版本不同回 409。' };
const cookieSecurity = (csrf = false) => [
  { LocalSession: [], ...(csrf ? { CsrfToken: [] } : {}) },
  { SecureSession: [], ...(csrf ? { CsrfToken: [] } : {}) },
] as Record<string, string[]>[];
const requestId = { description: '與錯誤 body.requestId 相同。', schema: string };
const errorResponse = { description: '安全錯誤；詳細 code 與優先序見教材及各 operation。',
  headers: { 'X-Request-ID': requestId }, content: { 'application/json': { schema: ref('ErrorResponse') } } };
const json = (schema: ApiSchema, description = '成功。') => ({ description, headers: { 'X-Request-ID': requestId },
  content: { 'application/json': { schema } } });
const body = (name: string) => ({ required: true, description: 'UTF-8 application/json，最多 16 KiB；拒絕壓縮與未知欄位。',
  content: { 'application/json': { schema: ref(name) } } });
const origin = { name: 'Origin', in: 'header', required: true, schema: { type: 'string', example: 'http://127.0.0.1:3025' },
  description: '必須精確符合 APP_ORIGIN，不接受 null、尾斜線或其他來源。' };
const pathId = { name: 'id', in: 'path', required: true, schema: id };
const pageParameter = (name: string, fallback: number, max: number) => ({ name, in: 'query', required: false,
  schema: { type: 'string', pattern: '^[0-9]+$', default: String(fallback) },
  description: `單一十進位字串，轉數字後必須介於 1 與 ${max}；重複參數拒絕。` });
const listParameters = [pageParameter('page', 1, 1000000), pageParameter('pageSize', 20, 100),
  { name: 'q', in: 'query', required: false, schema: trimmed(80), description: 'title 的不分大小寫字面子字串；trim 後 1–80 code points，拒絕 NUL；%、_、反斜線不作 wildcard。' },
  { name: 'sort', in: 'query', required: false, schema: { type: 'string', enum: ['newest', 'oldest'], default: 'newest' }, description: 'createdAt、id 同方向；newest DESC，oldest ASC。' },
];
const schemas: Record<string, ApiSchema> = {
  Article: object({ id, authorId: id, title: { type: 'string', minLength: 1, maxLength: 120 },
    content: { type: 'string', minLength: 1, maxLength: 4000 }, status, version, createdAt: date, updatedAt: date }),
  ArticleResponse: object({ data: ref('Article') }),
  ArticlePage: object({ data: { type: 'array', items: ref('Article') },
    meta: object({ page: { type: 'integer', minimum: 1, maximum: 1000000 }, pageSize: { type: 'integer', minimum: 1, maximum: 100 }, total: { type: 'integer', minimum: 0 } }) }),
  DraftInput: object({ title: trimmed(120), content: trimmed(4000) }),
  PatchInput: { ...object({ title: trimmed(120), content: trimmed(4000), expectedVersion: expected }, ['expectedVersion']),
    anyOf: [{ required: ['title'] }, { required: ['content'] }], description: '至少一個 title／content；省略保留，null 拒絕。' },
  VersionInput: object({ expectedVersion: expected }),
  PreviewResponse: object({ data: object({ title: string, content: string, status: { const: 'draft' }, preview: { const: true } }) }),
  PublicUser: object({ id, email: { type: ['string', 'null'] }, displayName: string, role: { type: 'string', enum: ['member', 'admin'] } }),
  UserResponse: object({ data: ref('PublicUser') }),
  CsrfResponse: object({ data: object({ csrfToken: token }) }),
  LoginResponse: object({ data: object({ user: ref('PublicUser'), csrfToken: token }) }),
  LoginInput: object({ email: { type: 'string', description: 'trim、小寫後驗證 email 格式，最多 254 字元。' },
    password: { type: 'string', minLength: 15, maxLength: 128, description: '不 trim／normalize，最多 512 UTF-8 bytes。' } }),
  RegisterInput: object({ email: { type: 'string', description: 'trim、小寫後驗證 email 格式，最多 254 字元。' },
    password: { type: 'string', minLength: 15, maxLength: 128, description: '不 trim／normalize，最多 512 UTF-8 bytes。' }, displayName: trimmed(80) }),
  LogoutInput: object({}),
  HealthResponse: object({ data: object({ status: { const: 'ok' } }) }),
  ErrorResponse: object({ error: object({ code: string, message: string,
    details: { type: 'array', items: object({ field: string, code: string, message: string }) } }), requestId: string }),
};

const paths: Record<string, Record<string, ApiOperation>> = {};
function add(path: string, method: string, operationId: string, summary: string, response: Record<string, unknown>, options: {
  parameters?: Record<string, unknown>[]; secure?: boolean; csrf?: boolean; allowAnonymousSession?: boolean; input?: string; status?: string; description?: string;
} = {}) {
  const errorStatuses = new Set(['400', '405', '500', '503']);
  if ((options.secure && !options.allowAnonymousSession) || options.input === 'LoginInput') errorStatuses.add('401');
  if (options.csrf || path.includes('/admin/')) errorStatuses.add('403');
  if (path.includes('{id}') || path.endsWith('/export')) errorStatuses.add('404');
  if (options.input) for (const code of ['408', '413', '415']) errorStatuses.add(code);
  if (['PatchInput', 'VersionInput', 'RegisterInput'].includes(options.input ?? '')) errorStatuses.add('409');
  if (path.startsWith('/api/auth/') && !['/api/auth/me', '/api/auth/logout'].includes(path)) errorStatuses.add('429');
  if (path === '/api/auth/logout') errorStatuses.add('403');
  const op: ApiOperation = { operationId, summary, parameters: options.parameters ?? [], security: options.secure ? cookieSecurity(options.csrf) : [],
    responses: { ...Object.fromEntries([...errorStatuses].map(code => [code, errorResponse])), [options.status ?? '200']: response, default: errorResponse },
    ...(options.input ? { requestBody: body(options.input) } : {}), ...(options.description ? { description: options.description } : {}) };
  paths[path] ??= {}; paths[path][method] = op;
  if (method === 'get') {
    const responses = Object.fromEntries(Object.entries(op.responses).map(([code, value]) => {
      const { content: _content, ...headersOnly } = value; return [code, headersOnly];
    }));
    paths[path].head = { ...op, operationId: `${operationId}Head`, summary: `${summary}（HEAD，無 body）`, responses };
  }
}
add('/health/metrics', 'get', 'metrics', '公開的程序內彙總指標', {
  description: 'Prometheus text 0.0.4；無使用者資料。重啟歸零，HEAD 無 body，拒絕 query。',
  headers: { 'X-Request-ID': requestId, 'Cache-Control': { schema: { const: 'no-store' } } },
  content: { 'text/plain': { schema: { type: 'string' } } },
}, { description: '路由、method、status_group、outcome 均為有限 label；HTTP finish 不代表用戶已收到。draining 仍可讀，直到 listener 關閉。' });
add('/health/live', 'get', 'live', '程序存活', json(ref('HealthResponse')));
add('/health/ready', 'get', 'ready', '必要資料可讀', json(ref('HealthResponse')), { description: '檢查 Article、稽核、Session 與 User 認證欄位；失敗 503 NOT_READY。draining 為 503 SHUTTING_DOWN，listener 關閉後無 HTTP 回應。' });
add('/api/articles', 'get', 'listPublicArticles', '公開文章列表', json(ref('ArticlePage')), { parameters: listParameters,
  description: '所有角色只讀 published，拒絕 status／authorId query；先套可見範圍與搜尋再分頁及 count。data／total 使用同一 RepeatableRead 快照。' });
paths['/api/articles'].get['x-query-unknown-fields'] = 'reject';
paths['/api/articles'].head['x-query-unknown-fields'] = 'reject';
add('/api/me/articles', 'get', 'listOwnArticles', '只查本人文章，admin 也相同', json(ref('ArticlePage')), { secure: true,
  parameters: [...listParameters, { name: 'status', in: 'query', required: false, schema: status }],
  description: 'status 省略為自己的全部狀態；不可指定 authorId。拒絕未知及重複 query；private 回應 no-store。' });
paths['/api/me/articles'].get['x-query-unknown-fields'] = 'reject';
paths['/api/me/articles'].head['x-query-unknown-fields'] = 'reject';
add('/api/articles', 'post', 'createArticle', '由登入 actor 建立草稿', { ...json(ref('ArticleResponse')),
  headers: { 'X-Request-ID': requestId, Location: { schema: string, description: '/api/me/articles/{id}' } } },
  { secure: true, csrf: true, parameters: [origin], input: 'DraftInput', status: '201' });
add('/api/articles/preview', 'post', 'previewArticle', '公開預覽，不寫入', json(ref('PreviewResponse')), { input: 'DraftInput' });
add('/api/articles/export', 'get', 'exportTeachingFile', '獨立 NDJSON 教學檔，非資料庫備份', {
  description: '拒絕所有 query。串流獨立檔案；缺檔 404 EXPORT_NOT_FOUND，已送 header 的錯誤可能中斷連線。',
  headers: { 'X-Request-ID': requestId, 'Content-Length': { schema: { type: 'integer', minimum: 0 } },
    'Content-Disposition': { schema: string } }, content: { 'application/x-ndjson': { schema: { type: 'string', description: '每行一個 JSON。' } } },
});
for (const [path, name, summary, secure] of [
  ['/api/articles/{id}', 'publicArticle', '只讀 published，草稿／封存為 404', false],
  ['/api/me/articles/{id}', 'ownArticle', '只讀本人，其他作者為 404', true],
  ['/api/admin/articles/{id}', 'adminArticle', '僅 admin，任意作者與狀態；member 為 403', true],
] as const) add(path, 'get', name, summary, json(ref('ArticleResponse')), { parameters: [pathId], secure });
const changeDescription = '作者或 admin；不存在 404 → 無權限 403 → 版本 409 VERSION_CONFLICT → 狀態 409 INVALID_STATE → 上限 409 VERSION_LIMIT。成功 version + 1；未知 DB 錯誤為安全 500。';
add('/api/articles/{id}', 'patch', 'editArticle', '編輯草稿或公開文章，不新增狀態稽核', json(ref('ArticleResponse')),
  { secure: true, csrf: true, parameters: [pathId, origin], input: 'PatchInput', description: changeDescription });
for (const action of ['publish', 'archive']) add(`/api/articles/{id}/${action}`, 'post', action, '狀態與稽核同一交易提交', json(ref('ArticleResponse')),
  { secure: true, csrf: true, parameters: [pathId, origin], input: 'VersionInput', description: changeDescription });
add('/api/auth/csrf', 'get', 'csrf', '取得或建立匿名 Session 與 CSRF', {
  ...json(ref('CsrfResponse')), headers: { 'X-Request-ID': requestId, 'Set-Cookie': { schema: string, description: '需要時建立匿名 HttpOnly Cookie；HEAD 也可能建立。' } },
}, { description: '匿名期限 10 分鐘，登入 30 分鐘，不滑動續期；認證限流每 IP 每分鐘共 20 次，超過 429。' });
for (const [action, response, input, code] of [
  ['register', 'UserResponse', 'RegisterInput', '201'], ['login', 'LoginResponse', 'LoginInput', '200'],
] as const) add(`/api/auth/${action}`, 'post', action, action === 'register' ? '註冊固定 member，不自動登入' : '登入輪替 Session 與 CSRF',
  { ...json(ref(response)), ...(action === 'login' ? { headers: { 'X-Request-ID': requestId, 'Set-Cookie': { schema: string, description: '替換舊 Cookie。' } } } : {}) },
  { secure: true, csrf: true, allowAnonymousSession: true, parameters: [origin], input, status: code,
    description: 'Cookie 可為匿名 Session；缺少有效 Session 或 CSRF 錯誤為 403。' +
      (action === 'register' ? '重複 email 409 USER_ALREADY_EXISTS。' : '錯誤帳密 401 INVALID_CREDENTIALS；輪替時 Session 失效或競爭失敗為 401 UNAUTHENTICATED。') +
      '限流 429；KDF 忙碌 503 AUTH_BUSY。' });
add('/api/auth/me', 'get', 'currentUser', '目前登入使用者', json(ref('UserResponse')), { secure: true });
add('/api/auth/logout', 'post', 'logout', '撤銷 Session 並清 Cookie', { description: '204，無 body。',
  headers: { 'X-Request-ID': requestId, 'Set-Cookie': { schema: string, description: '清除 Cookie。' } } },
  { input: 'LogoutInput', status: '204', parameters: [origin, { name: 'X-CSRF-Token', in: 'header', required: false, schema: token,
    description: '有效 Session 時必填；缺少、過期或撤銷 Session 時不要求此 token，仍要求正確 Origin。' }],
    description: 'security 為空允許缺少 Session；有效 Session 缺 CSRF 仍為 403，重複登出為 204。' });
add('/api/openapi.json', 'get', 'openapi', '本課 API 契約，無 Swagger UI', json({ type: 'object' }), {
  description: '拒絕未知 query；文件不會安裝 Guard 或執行驗證，實際行為由程式與測試確認。' });

export const openapiDocument = {
  openapi: '3.1.1', jsonSchemaDialect: 'https://json-schema.org/draft/2020-12/schema',
  info: { title: 'Node.js Course Articles API', version: '24.0.0', description: '第 24 章。保留文章與認證契約，新增公開彙總指標。錯誤 envelope 固定；未知錯誤不洩漏 SQL、stack 或憑證。' },
  servers: [{ url: '/', description: '同源；本機 http://127.0.0.1:3025。HTTPS 使用 SecureSession Cookie。' }],
  paths, components: { schemas, securitySchemes: {
    LocalSession: { type: 'apiKey', in: 'cookie', name: 'course_session', description: '僅本機 loopback HTTP。HttpOnly、SameSite=Lax、Path=/，server-side Session。' },
    SecureSession: { type: 'apiKey', in: 'cookie', name: '__Host-course_session', description: 'HTTPS；Secure、HttpOnly、SameSite=Lax、Path=/、無 Domain。' },
    CsrfToken: { type: 'apiKey', in: 'header', name: 'X-CSRF-Token', description: '綁定 Session；另外必須帶精確 Origin。登入時輪替。' },
  } },
};
