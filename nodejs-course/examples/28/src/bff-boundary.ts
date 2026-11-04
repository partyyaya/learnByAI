import { randomUUID } from 'node:crypto';
import { z } from 'zod';
const summaries = z.object({ data: z.array(z.object({ id: z.string(), title: z.string(), status: z.enum(['draft', 'published', 'archived']), version: z.number().int().positive() })),
  meta: z.object({ page: z.number().int(), pageSize: z.number().int(), total: z.number().int() }) });
// 只實作 GET 本人摘要，沒有任意 URL、service token、角色或跨使用者快取。
export function createBffBoundary(apiOrigin: string, publicOrigin: string) {
  const upstream = new URL(apiOrigin); const browser = new URL(publicOrigin);
  if (upstream.origin !== apiOrigin || browser.origin !== publicOrigin || !['http:', 'https:'].includes(upstream.protocol) || !['http:', 'https:'].includes(browser.protocol)) throw new Error('BFF origin 不合法');
  const name = browser.protocol === 'https:' ? '__Host-course_session' : 'course_session';
  return {
    async listOwn(request: Request): Promise<Response> {
      const requestId = randomUUID();
      const fail = (status: number, code: string) => Response.json({ error: { code, message: '無法取得本人摘要', details: [] }, requestId }, { status, headers: { 'Cache-Control': 'no-store', 'X-Request-ID': requestId, ...(status === 405 ? { Allow: 'GET' } : {}) } });
      if (request.method !== 'GET') return fail(405, 'METHOD_NOT_ALLOWED');
      const cookies = (request.headers.get('cookie') ?? '').split(';').map(value => value.trim()).filter(value => value.startsWith(name + '='));
      if (cookies.length !== 1 || !new RegExp(`^${name}=[A-Za-z0-9_-]{43}$`).test(cookies[0])) return fail(401, 'UNAUTHENTICATED');
      const deadline = AbortSignal.timeout(1000); let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      try {
        const response = await fetch(apiOrigin + '/api/me/articles?pageSize=5', { headers: { Cookie: cookies[0], Accept: 'application/json' }, cache: 'no-store', redirect: 'error', signal: AbortSignal.any([request.signal, deadline]) });
        if (response.status !== 200) { await response.body?.cancel(); return fail([401, 403].includes(response.status) ? response.status : 502, 'BFF_UPSTREAM_FAILED'); }
        if (response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json' || Number(response.headers.get('content-length')) > 128 * 1024 || !response.body) { await response.body?.cancel(); throw new Error('bad response'); }
        reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
        for (;;) { const item = await reader.read(); if (item.done) break; size += item.value.byteLength; if (size > 128 * 1024) throw new Error('too large'); chunks.push(item.value); }
        const value = summaries.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))));
        return Response.json(value, { headers: { 'Cache-Control': 'no-store', 'X-Request-ID': requestId } });
      } catch { return fail(deadline.aborted ? 504 : request.signal.aborted ? 503 : 502, 'BFF_UPSTREAM_FAILED'); }
      finally { if (reader) { try { await reader.cancel(); } catch {} reader.releaseLock(); } }
    },
  };
}
