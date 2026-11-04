import { Injectable, Inject, SetMetadata, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { timingSafeEqual } from 'node:crypto';
import type { Response } from 'express';
import type { AuthService } from './auth-service.js';
import type { AuthOptions } from './auth-options.js';
import { resolveRequestSession, type AuthRequest } from './auth-http.js';
import { AUTH_OPTIONS, AUTH_SERVICE } from './tokens.js';
import { HttpError } from './http.js';

const allowMissing = Symbol('allow missing session at logout');
export const AllowMissingLogout = () => SetMetadata(allowMissing, true);

@Injectable()
export class SessionGuard implements CanActivate {
  constructor(@Inject(AUTH_SERVICE) private readonly auth: AuthService, @Inject(AUTH_OPTIONS) private readonly options: Readonly<AuthOptions>) {}
  async canActivate(context: ExecutionContext) {
    const http = context.switchToHttp(); http.getResponse<Response>().setHeader('Cache-Control', 'no-store');
    const session = await resolveRequestSession(http.getRequest<AuthRequest>(), this.auth, this.options);
    if (!session?.user) throw new HttpError(401, 'UNAUTHENTICATED', '請先登入');
    return true;
  }
}
@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(@Inject(AUTH_SERVICE) private readonly auth: AuthService, @Inject(AUTH_OPTIONS) private readonly options: Readonly<AuthOptions>,
    private readonly reflector: Reflector) {}
  async canActivate(context: ExecutionContext) {
    const http = context.switchToHttp(); const req = http.getRequest<AuthRequest>();
    http.getResponse<Response>().setHeader('Cache-Control', 'no-store');
    if (req.headers.origin !== this.options.origin) throw new HttpError(403, 'CSRF_REJECTED', '請求來源或 CSRF 驗證失敗');
    const session = await resolveRequestSession(req, this.auth, this.options);
    if (!session && this.reflector.get<boolean>(allowMissing, context.getHandler())) return true;
    const token = req.headers['x-csrf-token'];
    if (!session || typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token) ||
        !timingSafeEqual(Buffer.from(token), Buffer.from(session.csrfToken))) {
      throw new HttpError(403, 'CSRF_REJECTED', '請求來源或 CSRF 驗證失敗');
    }
    return true;
  }
}
@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    if (context.switchToHttp().getRequest<AuthRequest>().authSession?.user?.role !== 'admin') {
      throw new HttpError(403, 'FORBIDDEN', '沒有操作權限');
    }
    return true;
  }
}
@Injectable()
export class AuthThrottleGuard implements CanActivate {
  constructor(@Inject(AUTH_SERVICE) private readonly auth: AuthService) {}
  canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<AuthRequest>();
    context.switchToHttp().getResponse<Response>().setHeader('Cache-Control', 'no-store');
    this.auth.consumeAttempt(req.socket.remoteAddress ?? 'unknown'); // 不信任 X-Forwarded-For。
    return true;
  }
}
