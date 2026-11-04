import { SerializeResponse, userResponse, loginResponse } from './response-projection.js';
import { All, Body, Controller, Get, HttpCode, Inject, Module, Post, Req, Res, UseGuards, type DynamicModule, type NestModule, type MiddlewareConsumer, RequestMethod } from '@nestjs/common';
import type { RequestHandler, Response } from 'express';
import type { AuthService } from './auth-service.js';
import type { AuthOptions } from './auth-options.js';
import type { HttpOptions } from './runtime.module.js';
import { AUTH_OPTIONS, AUTH_SERVICE, HTTP_OPTIONS } from './tokens.js';
import { readSessionCookie, setSessionCookie, clearSessionCookie, type AuthRequest } from './auth-http.js';
import { SessionGuard, CsrfGuard, AdminGuard, AuthThrottleGuard, AllowMissingLogout } from './auth.guards.js';
import { ZodValidationPipe } from './zod-validation.pipe.js';
import { loginSchema, registerSchema, logoutSchema, type LoginDto, type RegisterDto } from './auth.schemas.js';
import { jsonBody } from './json-body.js';
import { HttpError } from './http.js';

@Controller('api/auth')
export class AuthController {
  constructor(@Inject(AUTH_SERVICE) private readonly auth: AuthService, @Inject(AUTH_OPTIONS) private readonly options: Readonly<AuthOptions>) {}
  @Get('csrf')
  @UseGuards(AuthThrottleGuard)
  async csrf(@Req() req: AuthRequest, @Res({ passthrough: true }) res: Response) {
    res.setHeader('Cache-Control', 'no-store');
    const result = await this.auth.csrf(readSessionCookie(req, this.options));
    if (result.token) setSessionCookie(res, result.token, result.session.expiresAt, this.options);
    return { data: { csrfToken: result.session.csrfToken } };
  }
  @Post('register')
  @SerializeResponse(userResponse)
  @UseGuards(CsrfGuard, AuthThrottleGuard)
  async register(@Body(new ZodValidationPipe(registerSchema)) input: RegisterDto) {
    return this.auth.register(input); // 註冊固定 member，之後另行登入。
  }
  @Post('login') @HttpCode(200)
  @SerializeResponse(loginResponse)
  @UseGuards(CsrfGuard, AuthThrottleGuard)
  async login(@Body(new ZodValidationPipe(loginSchema)) input: LoginDto, @Req() req: AuthRequest, @Res({ passthrough: true }) res: Response) {
    const result = await this.auth.login(input, req.authSession!);
    setSessionCookie(res, result.token, result.session.expiresAt, this.options);
    return { user: result.session.user, csrfToken: result.session.csrfToken };
  }
  @Post('logout') @HttpCode(204)
  @AllowMissingLogout() @UseGuards(CsrfGuard)
  async logout(@Body(new ZodValidationPipe(logoutSchema)) _body: Record<string, never>, @Req() req: AuthRequest, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(req.authSession ?? null);
    clearSessionCookie(res, this.options);
  }
  @Get('me') @UseGuards(SessionGuard)
  @SerializeResponse(userResponse)
  me(@Req() req: AuthRequest) { return req.authSession!.user; }
  @All(['csrf', 'me']) readMethod(@Res() res: Response) {
    res.setHeader('Allow', 'GET, HEAD'); throw new HttpError(405, 'METHOD_NOT_ALLOWED', '此路由不支援該方法');
  }
  @All(['register', 'login', 'logout']) writeMethod(@Res() res: Response) {
    res.setHeader('Allow', 'POST'); throw new HttpError(405, 'METHOD_NOT_ALLOWED', '此路由不支援該方法');
  }
}

@Module({ controllers: [AuthController], providers: [SessionGuard, CsrfGuard, AdminGuard, AuthThrottleGuard] })
export class AuthModule implements NestModule {
  constructor(@Inject(HTTP_OPTIONS) private readonly options: Readonly<HttpOptions>) {}
  static register(core: DynamicModule, runtime: DynamicModule): DynamicModule {
    return { module: AuthModule, imports: [core, runtime], exports: [core.module, SessionGuard, CsrfGuard, AdminGuard, AuthThrottleGuard] };
  }
  configure(consumer: MiddlewareConsumer) {
    const parse = jsonBody(this.options.maxBodyBytes, this.options.bodyTimeoutMs);
    const body: RequestHandler = (req, res, next) => {
      if (req.path.endsWith('/')) return next();
      res.locals.steps.push('json:start');
      return parse(req, res, error => {
        if (!error) res.locals.steps.push('json:parsed');
        next(error);
      });
    };
    consumer.apply(body).forRoutes(
      ...['register', 'login', 'logout'].map(action => ({ path: `api/auth/${action}`, method: RequestMethod.POST })),
    );
  }
}
