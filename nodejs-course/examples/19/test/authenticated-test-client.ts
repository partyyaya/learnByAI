import rawSupertest from 'supertest';
import type { Server } from 'node:http';
import { demoAccounts } from '../src/seed-database.js';
import type { Actor } from '../src/auth-model.js';

export const testActor: Actor = { id: 'u_demo', role: 'member' };
export const testToken = 's'.repeat(43);
export const testCsrf = 'c'.repeat(43);
export const origin = 'http://127.0.0.1:3019';
export const testHeaders = { Cookie: `course_session=${testToken}`, Origin: origin, 'X-CSRF-Token': testCsrf };
const credentials = new WeakMap<Server, typeof testHeaders>();
export async function loginAs(server: Server, account = demoAccounts[0]) {
  const anonymous = await rawSupertest(server).get('/api/auth/csrf').expect(200);
  const cookie = anonymous.headers['set-cookie'][0].split(';')[0];
  const result = await rawSupertest(server).post('/api/auth/login').set('Cookie', cookie)
    .set('Origin', origin).set('X-CSRF-Token', anonymous.body.data.csrfToken)
    .send({ email: account.email, password: account.password }).expect(200);
  credentials.set(server, { Cookie: result.headers['set-cookie'][0].split(';')[0], Origin: origin,
    'X-CSRF-Token': result.body.data.csrfToken });
}
export function reuseCredentials(from: Server, to: Server) {
  const value = credentials.get(from); if (!value) throw new Error('尚未登入');
  credentials.set(to, value);
}
// 既有文章測試使用已登入的請求；正式應用必須先 loginAs，固定 token 只供明確的 DI 替身。
export default function authenticatedApi(server: Server) {
  const api = rawSupertest(server);
  for (const method of ['get', 'head', 'post', 'patch', 'put', 'delete', 'options'] as const) {
    const original = api[method].bind(api);
    api[method] = (url: string) => original(url).set(credentials.get(server) ?? testHeaders);
  }
  return api;
}
