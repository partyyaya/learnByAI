import { responsePort, rawRequest, rawResponse } from './http-platform.js';
import type { Request, Response } from 'express';
import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { AuthOptions } from './auth-options.js';
import type { Actor, SessionContext } from './auth-model.js';
import type { AuthService } from './auth-service.js';
import { validToken } from './auth-service.js';
import { HttpError } from './http.js';

export interface AuthRequest extends Request { sessionLookup?: Promise<SessionContext | null>; authSession?: SessionContext | null }
export const cookieName = (options: Readonly<AuthOptions>) => options.secureCookies ? '__Host-course_session' : 'course_session';
export function readSessionCookie(req: Request, options: Readonly<AuthOptions>): string | null {
  const values = (req.headers.cookie ?? '').split(';').map(part => part.trim()).filter(part => part.startsWith(`${cookieName(options)}=`));
  if (values.length !== 1) return null; // 重複 Cookie 不猜測採用哪一個。
  const value = values[0].slice(cookieName(options).length + 1);
  return validToken(value) ? value : null;
}
export async function resolveRequestSession(req: AuthRequest, service: AuthService, options: Readonly<AuthOptions>) {
  req.sessionLookup ??= service.resolve(readSessionCookie(req, options));
  req.authSession = await req.sessionLookup;
  return req.authSession;
}
export function setSessionCookie(res: Response, token: string, expiresAt: Date, options: Readonly<AuthOptions>) {
  responsePort(res).cookie(cookieName(options), token, { httpOnly: true, secure: options.secureCookies, sameSite: 'lax', path: '/',
    expires: expiresAt, maxAge: Math.max(0, expiresAt.getTime() - options.now().getTime()) });
}
export function clearSessionCookie(res: Response, options: Readonly<AuthOptions>) {
  responsePort(res).clearCookie(cookieName(options), { httpOnly: true, secure: options.secureCookies, sameSite: 'lax', path: '/' });
}
export const CurrentActor = createParamDecorator((_data: unknown, context: ExecutionContext): Actor => {
  const user = context.switchToHttp().getRequest<AuthRequest>().authSession?.user;
  if (!user) throw new HttpError(401, 'UNAUTHENTICATED', '請先登入');
  return { id: user.id, role: user.role };
});
