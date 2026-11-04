import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { AuthError, publicUser, type LoginInput, type RegisterInput, type SessionContext } from './auth-model.js';
import type { AuthRepository } from './auth-repository.js';
import type { AuthOptions } from './auth-options.js';
import { dummyPasswordHash, hashPassword, verifyPassword } from './password.js';

export const validToken = (value: string) => /^[A-Za-z0-9_-]{43}$/.test(value);
export const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
export function createAuthService(repository: AuthRepository, options: Readonly<AuthOptions>) {
  const attempts = new Map<string, { count: number; until: number }>();
  function consumeAttempt(client: string) {
    const now = options.now().getTime();
    for (const [key, value] of attempts) if (value.until <= now) attempts.delete(key);
    const entry = attempts.get(client);
    if ((entry && entry.count >= 20) || (!entry && attempts.size >= 1000)) throw new AuthError('RATE_LIMITED');
    if (entry) entry.count++;
    else attempts.set(client, { count: 1, until: now + 60000 });
  }
  async function resolve(token: string | null): Promise<SessionContext | null> {
    if (!token || !validToken(token)) return null;
    const session = await repository.findSession(tokenHash(token));
    if (!session || session.revokedAt || session.expiresAt <= options.now()) return null;
    return { tokenHash: session.tokenHash, csrfToken: session.csrfToken, expiresAt: session.expiresAt, user: session.user };
  }
  function fresh(userId: string | null) {
    const token = randomBytes(32).toString('base64url');
    const record = { tokenHash: tokenHash(token), csrfToken: randomBytes(32).toString('base64url'), userId,
      expiresAt: new Date(options.now().getTime() + (userId ? options.sessionTtlMs : options.anonymousTtlMs)) };
    return { token, record };
  }
  async function csrf(token: string | null) {
    const current = await resolve(token);
    if (current) return { session: current, token: undefined };
    const next = fresh(null); await repository.createSession(next.record);
    return { session: { ...next.record, user: null } satisfies SessionContext, token: next.token };
  }
  async function register(input: RegisterInput) {
    const user = await repository.createUser({ id: `u_${randomUUID()}`, email: input.email, displayName: input.displayName,
      passwordHash: await hashPassword(input.password) });
    if (!user) throw new AuthError('USER_ALREADY_EXISTS');
    return user;
  }
  async function login(input: LoginInput, previous: SessionContext) {
    const user = await repository.findUser(input.email);
    const verified = await verifyPassword(input.password, user?.passwordHash ?? dummyPasswordHash);
    if (!user?.passwordHash || !verified) throw new AuthError('INVALID_CREDENTIALS');
    const next = fresh(user.id);
    // 同一個舊 Session 的並行登入最多一個成功；新 Session 永遠不用客戶端提供的 ID。
    if (!await repository.rotateSession(previous.tokenHash, next.record, options.now())) throw new AuthError('UNAUTHENTICATED');
    return { token: next.token, session: { ...next.record, user: publicUser(user) } satisfies SessionContext };
  }
  async function logout(session: SessionContext | null) {
    if (session) await repository.revokeSession(session.tokenHash, options.now());
  }
  return { consumeAttempt, resolve, csrf, register, login, logout };
}
export type AuthService = ReturnType<typeof createAuthService>;
