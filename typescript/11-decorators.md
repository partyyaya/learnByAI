# 第十一章：裝飾器（Decorators）

## 11.1 什麼是裝飾器？

裝飾器是一種特殊的**語法糖**，可以附加在類別、方法、屬性、參數上，用來**修改或擴展**它們的行為。裝飾器在許多框架中被廣泛使用（如 Angular、NestJS、TypeORM）。

### 啟用裝飾器

```json
// tsconfig.json
{
  "compilerOptions": {
    "experimentalDecorators": true,    // 啟用舊版裝飾器
    "emitDecoratorMetadata": true      // 啟用元資料反射（搭配 reflect-metadata）
  }
}
```

> TypeScript 5.0+ 也支援 [TC39 Stage 3 裝飾器](https://github.com/tc39/proposal-decorators)（不需要 `experimentalDecorators`），但目前大部分框架仍使用舊版裝飾器。

---

## 11.2 類別裝飾器（Class Decorator）

```typescript
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
```

---

## 11.3 方法裝飾器（Method Decorator）

```typescript
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
```

### 常用方法裝飾器

```typescript
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
```

---

## 11.4 屬性裝飾器（Property Decorator）

```typescript
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
```

---

## 11.5 參數裝飾器（Parameter Decorator）

```typescript
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
```

---

## 11.6 TC39 Stage 3 裝飾器（TypeScript 5.0+）

TypeScript 5.0 引入了新的標準裝飾器語法，不需要 `experimentalDecorators` 旗標。

```typescript
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
```

---

## 11.7 裝飾器在框架中的應用

### NestJS

```typescript
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
```

### TypeORM

```typescript
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
```

### Angular

```typescript
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
```

---

## 練習題

### 練習 1：方法裝飾器

建立一個 `@Retry(maxRetries: number)` 方法裝飾器，在方法失敗時自動重試。

### 練習 2：屬性裝飾器

建立一組驗證裝飾器：`@IsEmail`、`@IsPositive`、`@MaxLength(n)`。

### 練習 3：裝飾器組合

設計一個小型的路由系統，使用裝飾器定義路由：

```typescript
@Controller("/api/users")
class UserController {
  @Get("/")
  getAll() { /* ... */ }

  @Post("/")
  create() { /* ... */ }

  @Get("/:id")
  getById() { /* ... */ }
}
```

---

> 下一章：[第十二章 — 最佳實踐與常見模式](./12-best-practices.md)
