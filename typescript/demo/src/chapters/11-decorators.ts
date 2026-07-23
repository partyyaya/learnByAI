// @ts-nocheck
// ============================================================
// 第 11 章：裝飾器（Decorators）— 範例整理（閱讀參考檔）
// 來源：typescript/11-decorators.md
//
// 說明：第 11 章示範類別/方法/屬性/參數裝飾器與框架應用
//       （NestJS/TypeORM/Angular）。舊版裝飾器需在 tsconfig 開啟
//       experimentalDecorators 與 emitDecoratorMetadata（並安裝
//       reflect-metadata）；框架範例需安裝對應套件。故本檔以
//       @ts-nocheck 作為閱讀參考，不納入型別檢查。要實際執行請
//       參考 demo/README.md 的『測試裝飾器』說明。
// ============================================================

// ===== 11.2 類別裝飾器（Class Decorator）=====

// 基本類別裝飾器
function Sealed(constructor: Function) {
  Object.seal(constructor);
  Object.seal(constructor.prototype);
}

@Sealed
class User {
  name: string;
  constructor(name: string) {
    this.name = name;
  }
}

// 帶參數的裝飾器（Decorator Factory）
function Entity(tableName: string) {
  return function (constructor: Function) {
    Reflect.defineMetadata("tableName", tableName, constructor);
  };
}

@Entity("users")
class User {
  id!: number;
  name!: string;
}

// 日誌裝飾器
function LogClass(message: string) {
  return function <T extends new (...args: any[]) => any>(constructor: T) {
    return class extends constructor {
      constructor(...args: any[]) {
        console.log(`${message}: Creating instance of ${constructor.name}`);
        super(...args);
      }
    };
  };
}

@LogClass("DEBUG")
class UserService {
  constructor(private name: string) {}
}

// ===== 11.3 方法裝飾器（Method Decorator）=====

// 日誌裝飾器
function Log(
  target: any,
  propertyKey: string,
  descriptor: PropertyDescriptor,
): PropertyDescriptor {
  const originalMethod = descriptor.value;

  descriptor.value = function (...args: any[]) {
    console.log(`Calling ${propertyKey} with args:`, args);
    const result = originalMethod.apply(this, args);
    console.log(`${propertyKey} returned:`, result);
    return result;
  };

  return descriptor;
}

class Calculator {
  @Log
  add(a: number, b: number): number {
    return a + b;
  }
}

const calc = new Calculator();
calc.add(3, 5);
// Calling add with args: [3, 5]
// add returned: 8

// ===== 11.3 常用方法裝飾器 =====

// 效能測量
function Measure(
  target: any,
  propertyKey: string,
  descriptor: PropertyDescriptor,
) {
  const original = descriptor.value;

  descriptor.value = async function (...args: any[]) {
    const start = performance.now();
    const result = await original.apply(this, args);
    const end = performance.now();
    console.log(`${propertyKey} took ${(end - start).toFixed(2)}ms`);
    return result;
  };

  return descriptor;
}

// 錯誤處理
function Catch(errorHandler: (error: Error) => void) {
  return function (
    target: any,
    propertyKey: string,
    descriptor: PropertyDescriptor,
  ) {
    const original = descriptor.value;

    descriptor.value = async function (...args: any[]) {
      try {
        return await original.apply(this, args);
      } catch (error) {
        errorHandler(error as Error);
      }
    };

    return descriptor;
  };
}

// 防抖
function Debounce(delay: number) {
  return function (
    target: any,
    propertyKey: string,
    descriptor: PropertyDescriptor,
  ) {
    let timer: ReturnType<typeof setTimeout>;
    const original = descriptor.value;

    descriptor.value = function (...args: any[]) {
      clearTimeout(timer);
      timer = setTimeout(() => original.apply(this, args), delay);
    };

    return descriptor;
  };
}

class SearchService {
  @Measure
  async fetchResults(query: string): Promise<string[]> {
    // API 請求...
    return [];
  }

  @Debounce(300)
  onSearchInput(value: string): void {
    this.fetchResults(value);
  }
}

// ===== 11.4 屬性裝飾器（Property Decorator）=====

// 驗證裝飾器
function MinLength(min: number) {
  return function (target: any, propertyKey: string) {
    let value: string;

    Object.defineProperty(target, propertyKey, {
      get() {
        return value;
      },
      set(newValue: string) {
        if (newValue.length < min) {
          throw new Error(
            `${propertyKey} must be at least ${min} characters`,
          );
        }
        value = newValue;
      },
    });
  };
}

function Required(target: any, propertyKey: string) {
  let value: any;

  Object.defineProperty(target, propertyKey, {
    get() {
      return value;
    },
    set(newValue: any) {
      if (newValue === null || newValue === undefined || newValue === "") {
        throw new Error(`${propertyKey} is required`);
      }
      value = newValue;
    },
  });
}

class UserForm {
  @Required
  @MinLength(2)
  name!: string;

  @Required
  email!: string;
}

const form = new UserForm();
// form.name = "A"; // ❌ Error: name must be at least 2 characters
form.name = "Gary"; // ✅

// ===== 11.5 參數裝飾器（Parameter Decorator）=====

function Validate(
  target: any,
  propertyKey: string,
  parameterIndex: number,
) {
  const existingValidations: number[] =
    Reflect.getOwnMetadata("validate", target, propertyKey) || [];
  existingValidations.push(parameterIndex);
  Reflect.defineMetadata("validate", existingValidations, target, propertyKey);
}

class UserService {
  createUser(@Validate name: string, @Validate email: string) {
    // ...
  }
}

// ===== 11.6 TC39 Stage 3 裝飾器（TypeScript 5.0+）=====

// 新語法的裝飾器
function logged<This, Args extends any[], Return>(
  target: (this: This, ...args: Args) => Return,
  context: ClassMethodDecoratorContext<
    This,
    (this: This, ...args: Args) => Return
  >,
) {
  const methodName = String(context.name);

  function replacementMethod(this: This, ...args: Args): Return {
    console.log(`Calling ${methodName}`);
    const result = target.call(this, ...args);
    console.log(`${methodName} returned`, result);
    return result;
  }

  return replacementMethod;
}

class Calculator {
  @logged
  add(a: number, b: number): number {
    return a + b;
  }
}

// ===== 11.7 裝飾器在框架中的應用 — NestJS =====

import { Controller, Get, Post, Body, Param } from "@nestjs/common";

@Controller("users")
class UserController {
  @Get()
  findAll(): User[] {
    return this.userService.findAll();
  }

  @Get(":id")
  findOne(@Param("id") id: string): User {
    return this.userService.findOne(+id);
  }

  @Post()
  create(@Body() createUserDto: CreateUserDto): User {
    return this.userService.create(createUserDto);
  }
}

// ===== 11.7 裝飾器在框架中的應用 — TypeORM =====

import { Entity, Column, PrimaryGeneratedColumn } from "typeorm";

@Entity()
class User {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  name!: string;

  @Column({ unique: true })
  email!: string;

  @Column({ default: true })
  isActive!: boolean;
}

// ===== 11.7 裝飾器在框架中的應用 — Angular =====

import { Component, Input, Output, EventEmitter } from "@angular/core";

@Component({
  selector: "app-user-card",
  template: `
    <div class="card">
      <h3>{{ name }}</h3>
      <button (click)="onEdit.emit()">Edit</button>
    </div>
  `,
})
class UserCardComponent {
  @Input() name!: string;
  @Output() onEdit = new EventEmitter<void>();
}

// ===== 練習題 3：裝飾器組合（內文骨架，@Controller/@Get/@Post 需自行實作）=====

@Controller("/api/users")
class UserController {
  @Get("/")
  getAll() { /* ... */ }

  @Post("/")
  create() { /* ... */ }

  @Get("/:id")
  getById() { /* ... */ }
}

console.log("第 11 章 裝飾器 範例載入完成 ✅（參考用，已 @ts-nocheck）");
