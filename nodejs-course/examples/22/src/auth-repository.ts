import type { AuthUser, PublicUser, SessionRecord } from './auth-model.js';
export interface NewSession { tokenHash: string; csrfToken: string; userId: string | null; expiresAt: Date }
export interface AuthRepository {
  findUser(email: string): Promise<AuthUser | null>;
  createUser(input: { id: string; email: string; passwordHash: string; displayName: string }): Promise<PublicUser | null>;
  findSession(tokenHash: string): Promise<SessionRecord | null>;
  createSession(input: NewSession): Promise<void>;
  rotateSession(previousHash: string, next: NewSession, now: Date): Promise<boolean>;
  revokeSession(tokenHash: string, now: Date): Promise<void>;
}
