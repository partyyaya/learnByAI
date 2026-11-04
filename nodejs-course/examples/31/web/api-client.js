export class ApiFailure extends Error {
  constructor(code, message, requestId = '', status = 0) { super(message); this.code = code; this.requestId = requestId; this.status = status; }
}
export function createApiClient(fetcher = globalThis.fetch, timeoutMs = 5000) {
  let csrf;
  return {
    setCsrf(value) { if (value !== undefined && !/^[A-Za-z0-9_-]{43}$/.test(value)) throw new Error('invalid CSRF'); csrf = value; },
    async request(path, { method = 'GET', body, signal } = {}) {
      if (!path.startsWith('/api/') || path.includes('\\') || path.includes('#') || !['GET', 'POST', 'PATCH', 'DELETE'].includes(method)) throw new Error('固定同源 API 路徑');
      const deadline = new AbortController(); const timer = setTimeout(() => deadline.abort(), timeoutMs);
      try {
        const response = await fetcher(path, { method, credentials: 'same-origin', cache: 'no-store', redirect: 'error',
          headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(method === 'GET' || !csrf ? {} : { 'X-CSRF-Token': csrf }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal });
        if (response.status === 204 && response.ok) return undefined;
        let value;
        try { value = await response.json(); } catch (error) { if (signal?.aborted || deadline.signal.aborted) throw error; throw new ApiFailure('BAD_RESPONSE', '伺服器回應格式錯誤'); }
        if (!response.ok) {
          const code = typeof value?.error?.code === 'string' ? value.error.code : 'HTTP_ERROR';
          // 只使用已知固定訊息，不將任意 proxy body／exception 當畫面內容。
          const message = ({ VERSION_CONFLICT: '資料已更新，請重新載入再決定修改內容。', UNAUTHENTICATED: '請重新登入。', CSRF_REJECTED: '驗證已失效，請重新整理或登入。', FORBIDDEN: '沒有操作權限。', VALIDATION_ERROR: '輸入格式不正確。', RATE_LIMITED: '操作過於頻繁，請稍後再試。', INVALID_STATE: '文章狀態不允許此操作。' })[code] ?? `操作未完成（HTTP ${response.status}）。`;
          const id = response.headers.get('x-request-id') ?? '';
          throw new ApiFailure(code, message, /^[0-9a-f-]{36}$/.test(id) ? id : '', response.status);
        }
        if (!value || typeof value !== 'object' || !Object.hasOwn(value, 'data')) throw new ApiFailure('BAD_RESPONSE', '伺服器回應格式錯誤');
        return value;
      } catch (error) {
        if (error instanceof ApiFailure) throw error;
        if (signal?.aborted) throw new ApiFailure('CANCELLED', '已取消載入。');
        if (deadline.signal.aborted) throw new ApiFailure('TIMEOUT', '等待逾時，寫入結果可能尚未確定，請先重新查詢。');
        throw new ApiFailure('NETWORK_ERROR', '連線失敗；寫入結果可能尚未確定，請先重新查詢。');
      } finally { clearTimeout(timer); }
    },
  };
}
