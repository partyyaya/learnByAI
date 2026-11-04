import 'reflect-metadata';
import { Controller, Get, Inject, Injectable, Module, Scope } from '@nestjs/common';
import { NestFactory, REQUEST } from '@nestjs/core';
import { randomUUID } from 'node:crypto';
import type { Request } from 'express';

export const STAMP_ALIAS = Symbol('STAMP_ALIAS');
export const SECOND_STAMP = Symbol('SECOND_STAMP');

@Injectable()
export class SingletonStamp { readonly id = randomUUID(); }

@Injectable({ scope: Scope.TRANSIENT })
export class TransientStamp { readonly id = randomUUID(); }

@Injectable()
export class ConsumerA {
  constructor(readonly stamp: TransientStamp) {}
}

@Injectable()
export class ConsumerB {
  constructor(readonly stamp: TransientStamp) {}
}

@Injectable({ scope: Scope.REQUEST })
export class RequestStamp {
  readonly id = randomUUID();
  readonly label: string;
  constructor(@Inject(REQUEST) request: Request) {
    // 僅供隔離實驗，不當成身分、授權資訊或正式 request ID。
    const raw = request.headers['x-lab-label'];
    this.label = typeof raw === 'string' ? raw : 'unlabelled';
  }
}

// 沒有宣告 REQUEST，仍因依賴 RequestStamp 而沿依賴鏈變成每請求建立。
@Injectable()
export class RequestConsumer {
  readonly id = randomUUID();
  constructor(readonly stamp: RequestStamp) {}
}

@Controller('scope')
export class ScopeController {
  private readonly id = randomUUID();
  constructor(
    private readonly shared: SingletonStamp,
    @Inject(STAMP_ALIAS) private readonly alias: SingletonStamp,
    @Inject(SECOND_STAMP) private readonly second: SingletonStamp,
    private readonly a: ConsumerA,
    private readonly b: ConsumerB,
    private readonly requestStamp: RequestStamp,
    private readonly requestConsumer: RequestConsumer,
    private readonly local: TransientStamp,
  ) {}

  @Get()
  inspect() {
    return {
      label: this.requestStamp.label,
      singleton: this.shared.id, alias: this.alias.id, secondSingleton: this.second.id,
      request: this.requestStamp.id, requestViaConsumer: this.requestConsumer.stamp.id,
      requestConsumer: this.requestConsumer.id, controller: this.id,
      transientA: this.a.stamp.id, transientB: this.b.stamp.id, transientController: this.local.id,
    };
  }
}

@Module({
  controllers: [ScopeController],
  providers: [
    SingletonStamp,
    { provide: STAMP_ALIAS, useExisting: SingletonStamp },
    { provide: SECOND_STAMP, useClass: SingletonStamp },
    TransientStamp, ConsumerA, ConsumerB, RequestStamp, RequestConsumer,
  ],
})
export class ScopeLabModule {}

// 獨立實驗，不掛入文章 API；只建立一般物件，沒有為每個請求開資料庫連線池。
export async function createScopeLab() {
  const app = await NestFactory.create(ScopeLabModule, { logger: false, abortOnError: false });
  try { await app.init(); return app; }
  catch (error) { await app.close(); throw error; }
}
