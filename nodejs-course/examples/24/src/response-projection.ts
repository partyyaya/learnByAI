import { Injectable, SetMetadata, type CallHandler, type ExecutionContext, type NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { map } from 'rxjs';
import type { Article, ArticlePage } from './article-model.js';
import type { PublicUser } from './auth-model.js';
import { present } from './article-presenter.js';

export const responsePresenter = Symbol('response presenter');
// 裝飾器無法驗證 handler 的回傳型別；此處只儲存已審查的 presenter，HTTP 測試驗證綁定。
export function SerializeResponse<T, R>(project: (value: T) => R): MethodDecorator {
  return SetMetadata(responsePresenter, project);
}
@Injectable()
export class ResponseProjectionInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}
  intercept(context: ExecutionContext, next: CallHandler) {
    const project = this.reflector.get<(value: unknown) => unknown>(responsePresenter, context.getHandler());
    // 未標記路由保留原結果；匯出、204、preview 與健康端點不自動包 data。
    return project ? next.handle().pipe(map(value => project(value))) : next.handle();
  }
}
export function articleResponse(article: Article) { return { data: present(article) }; }
export function articlePageResponse(page: ArticlePage) {
  return { data: page.data.map(present), meta: { page: page.meta.page, pageSize: page.meta.pageSize, total: page.meta.total } };
}
function userFields(user: PublicUser) {
  return { id: user.id, email: user.email, displayName: user.displayName, role: user.role };
}
export function userResponse(user: PublicUser) { return { data: userFields(user) }; }
export function loginResponse(value: { user: PublicUser | null; csrfToken: string }) {
  if (!value.user) throw new Error('登入成功回應缺少 user');
  return { data: { user: userFields(value.user), csrfToken: value.csrfToken } };
}
