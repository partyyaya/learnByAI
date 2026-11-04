import { expect, test } from '@jest/globals';
import request from 'supertest';
import { createArticleServer } from '../src/server.js';
import { testDependencies } from './module-fixture.js';
import { ARTICLE_SERVICE, CHECK_READY } from '../src/tokens.js';
import { createCorsLab } from '../src/cors-lab.js';
import { once } from 'node:events';

test('正式組裝提供同源 HTML／module、CSP、no-store、HEAD；不將 UI 算成 API schema', async () => {
  const server = await createArticleServer({ dependencies: testDependencies([{ provide: ARTICLE_SERVICE, useValue: {} }, { provide: CHECK_READY, useValue: async () => {} }]) });
  try {
    const page = await request(server).get('/').expect(200).expect('Cache-Control', 'no-store').expect('X-Content-Type-Options', 'nosniff');
    expect(page.headers['content-security-policy']).toContain("connect-src 'self'"); expect(page.text).toContain('文章工作台');
    await request(server).head('/').expect(200); await request(server).get('/api-client.js').expect(200);
    await request(server).post('/').expect(405).expect('Allow', 'GET, HEAD');
    await request(server).get('/../package.json').expect(404);
    const cors = await request(server).get('/cors.html').expect(200); expect(cors.headers['content-security-policy']).toContain('http://127.0.0.1:4033');
  } finally { await server.lifecycle.shutdown(); }
});
test('CORS lab 只允許固定來源／方法／header，沒有 wildcard 或實際 Session 資料', async () => {
  const lab = createCorsLab('http://127.0.0.1:3033'); lab.server.listen(0, '127.0.0.1'); await once(lab.server, 'listening');
  try {
    await request(lab.server).options('/lab/state').set('Origin', 'http://127.0.0.1:3033').set('Access-Control-Request-Method', 'GET').set('Access-Control-Request-Headers', 'x-lab-token').expect(204).expect('Access-Control-Allow-Origin', 'http://127.0.0.1:3033').expect('Access-Control-Allow-Credentials', 'true');
    const denied = await request(lab.server).get('/lab/state').set('Origin', 'http://evil.example').expect(403); expect(denied.headers).not.toHaveProperty('access-control-allow-origin');
    await request(lab.server).options('/lab/state').set('Origin', 'http://127.0.0.1:3033').set('Access-Control-Request-Method', 'DELETE').set('Access-Control-Request-Headers', 'x-lab-token').expect(403);
  } finally { await new Promise<void>(resolve => lab.server.close(() => resolve())); }
});
