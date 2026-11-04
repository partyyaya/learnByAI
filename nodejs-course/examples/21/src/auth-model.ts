export type Role = 'member' | 'admin';
export interface Actor { id: string; role: Role }
export interface PublicUser extends Actor { email: string | null; displayName: string }
export interface AuthUser extends PublicUser { passwordHash: string | null }
export interface SessionRecord {
  tokenHash: string;
  csrfToken: string;
  userId: string | null;
  expiresAt: Date;
  revokedAt: Date | null;
  user: PublicUser | null;
}
export interface SessionContext {
  tokenHash: string;
  csrfToken: string;
  expiresAt: Date;
  user: PublicUser | null;
}
export interface LoginInput { email: string; password: string }
export interface RegisterInput extends LoginInput { displayName: string }
export type AuthErrorCode = 'UNAUTHENTICATED' | 'INVALID_CREDENTIALS' | 'USER_ALREADY_EXISTS' | 'AUTH_BUSY' | 'RATE_LIMITED';
const messages: Record<AuthErrorCode, string> = {
  UNAUTHENTICATED: '請先登入', INVALID_CREDENTIALS: '登入資料不正確', USER_ALREADY_EXISTS: '此登入識別已被使用',
  AUTH_BUSY: '密碼驗證忙碌，請稍後重試', RATE_LIMITED: '認證請求過於頻繁，請稍後重試',
};
export class AuthError extends Error {
  constructor(readonly code: AuthErrorCode) { super(messages[code]); }
}
export function publicUser(user: AuthUser): PublicUser {
  return { id: user.id, email: user.email, displayName: user.displayName, role: user.role };
}
