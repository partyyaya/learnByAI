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

### 舊版裝飾器 vs 標準（TC39）裝飾器

| | 舊版裝飾器（Legacy，`experimentalDecorators`） | 標準裝飾器（TC39 Stage 3，TS 5.0+） |
|---|---|---|
| 啟用方式 | tsconfig 設定 `"experimentalDecorators": true` | 不需要任何 tsconfig 旗標，TS 5.0+ 預設支援 |
| 裝飾器函式簽章 | 依附加位置不同：`(target, propertyKey, descriptor)`、`(target, propertyKey, parameterIndex)` … | 統一為 `(value, context) => ...`，`context` 帶有 `kind`/`name`/`metadata` 等資訊 |
| 參數裝飾器 | ✅ 支援（`@Validate` 這類建構子參數注入寫法） | ❌ 規格已完全移除，見 11.5 說明 |
| DI / 元資料反射 | 搭配 `emitDecoratorMetadata` + `reflect-metadata` 可做執行期型別反射 | 沒有內建型別反射；改用 `context.metadata`（Decorator Metadata，TS 5.2+，見 11.6b） |
| 主要使用框架 | NestJS、TypeORM、Angular（遷移前）等 | 目前尚無主流後端框架採用 |

> ⚠️ 這兩套系統語法、語意都不相容，**一個專案的一次編譯只能二選一**：整個 tsconfig 要嘛開 `experimentalDecorators` 走舊版，要嘛不開走標準版，無法在同一份設定裡混用兩種裝飾器。

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

> ⚠️ 這種「把 getter/setter 定義到 prototype 上」的屬性裝飾器，遇到 `useDefineForClassFields: true`（`target` 為 ES2022 以上時的預設值）會**靜默失效**：`name!: string` 這類欄位宣告會在建構時於**實例**上定義同名屬性，蓋過 prototype 上的 setter，於是驗證完全不會被觸發、也不報錯。要讓範例如預期運作，需在 tsconfig 設 `"useDefineForClassFields": false`（或把 `target` 降到 ES2021 以下）。此外這裡用單一閉包變數 `value` 會讓所有實例共用同一份值，正式程式應改用 `WeakMap` 依實例存值（見本章練習 2 的解答）。

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

> 📌 標準（TC39）裝飾器規格**完全移除了參數裝飾器**這個類別——不是語法改了，而是新規格裡根本沒有對應的擴充點。這正是 NestJS、Angular 這類仰賴建構子參數注入（constructor-injection，如上面的 `@Validate`、下一節 NestJS 範例的 `@Param`/`@Body`）的框架，短期內無法搬到新裝飾器語法的根本原因。

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

## 11.6b Accessor 裝飾器與 Decorator Metadata（TypeScript 5.2+）

標準裝飾器新增了 `accessor` 這個欄位修飾字——加了它之後，類別欄位會自動產生底層的 get/set，也因此可以被裝飾器包裝讀寫行為（一般的 `@Decorator field: T` 屬性欄位是包不住 get/set 的）。搭配 `context.metadata`（一個掛在該類別 `Symbol.metadata` 上的共用物件，TS 5.2+ 支援的 Decorator Metadata 提案），多個裝飾器之間可以互相留言、傳資料，不需要額外自建 `Map`/`WeakMap`。

```typescript
function trackChanges<This, Value>(
  target: ClassAccessorDecoratorTarget<This, Value>,
  context: ClassAccessorDecoratorContext<This, Value>,
): ClassAccessorDecoratorResult<This, Value> {
  const fieldName = String(context.name);

  // context.metadata：把資訊寫進去，之後透過 Symbol.metadata 讀回來
  (context.metadata as Record<string, unknown>)[fieldName] = "tracked";

  return {
    get(this: This): Value {
      return target.get.call(this);
    },
    set(this: This, value: Value) {
      console.log(`${fieldName} changed to`, value);
      target.set.call(this, value);
    },
  };
}

class Settings {
  @trackChanges accessor theme: string = "light";
}

const settings = new Settings();
settings.theme = "dark"; // 印出：theme changed to dark

// 透過 Symbol.metadata 讀取裝飾器附加的中繼資料
console.log(Settings[Symbol.metadata]?.theme); // "tracked"
```

> 💡 若編譯器提示 `Symbol.metadata` 不存在，代表 tsconfig 的 `lib` 需要包含 `esnext`（Decorator Metadata 提案的型別宣告目前掛在這裡，`ES2022` 尚未內建）。

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

<details>
<summary>參考解答</summary>

用**舊版裝飾器**（`experimentalDecorators`，與 11.3 的方法裝飾器同一套）。思路：在裝飾器工廠裡包一層迴圈，攔截原方法的 `descriptor.value`，用 `try/catch` 反覆呼叫原方法；第一次是正常呼叫，之後最多再重試 `maxRetries` 次，全部失敗才把最後一個錯誤丟出去。因為方法可能是非同步，包裝後統一 `await`。

```typescript
function Retry(maxRetries: number) {
  return function (
    _target: any,
    propertyKey: string,
    descriptor: PropertyDescriptor,
  ): PropertyDescriptor {
    const original = descriptor.value;

    descriptor.value = async function (...args: any[]) {
      let lastError: unknown;
      // 第 0 次是正常呼叫，之後最多再重試 maxRetries 次
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          return await original.apply(this, args);
        } catch (error) {
          lastError = error;
          console.warn(
            `${propertyKey} 第 ${attempt + 1} 次呼叫失敗：${(error as Error).message}`,
          );
        }
      }
      throw lastError;
    };

    return descriptor;
  };
}

class ApiClient {
  private count = 0;

  @Retry(3)
  async fetchData(): Promise<string> {
    this.count++;
    if (this.count < 3) {
      throw new Error(`服務尚未就緒（第 ${this.count} 次）`);
    }
    return "成功取得資料";
  }
}

const client = new ApiClient();
console.log(await client.fetchData()); // 前兩次失敗、第三次成功
```

重點：`maxRetries` 是「重試次數」，所以總嘗試次數是 `maxRetries + 1`；包裝後方法一律回傳 `Promise`，記得呼叫端要 `await`。此範例需在 tsconfig 開啟 `experimentalDecorators`。

</details>

### 練習 2：屬性裝飾器

建立一組驗證裝飾器：`@IsEmail`、`@IsPositive`、`@MaxLength(n)`。

<details>
<summary>參考解答</summary>

同樣走**舊版裝飾器**，沿用 11.4 的手法：用 `Object.defineProperty` 攔截屬性的 `set`，賦值當下就驗證，不合法直接丟錯。跟 11.4 的差別在於這裡改用 `WeakMap` 依 `this`（實例）存值，避免多個實例共用同一個閉包變數而互相污染。`@IsEmail`、`@IsPositive` 不帶參數（簽章是 `(target, propertyKey)`），`@MaxLength(n)` 需要參數所以多包一層工廠。

```typescript
function IsEmail(target: any, propertyKey: string) {
  const store = new WeakMap<object, string>();
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  Object.defineProperty(target, propertyKey, {
    get(this: object) {
      return store.get(this);
    },
    set(this: object, newValue: string) {
      if (!emailRegex.test(newValue)) {
        throw new Error(`${propertyKey} 不是合法的 email：${newValue}`);
      }
      store.set(this, newValue);
    },
    enumerable: true,
    configurable: true,
  });
}

function IsPositive(target: any, propertyKey: string) {
  const store = new WeakMap<object, number>();
  Object.defineProperty(target, propertyKey, {
    get(this: object) {
      return store.get(this);
    },
    set(this: object, newValue: number) {
      if (newValue <= 0) {
        throw new Error(`${propertyKey} 必須是正數，收到 ${newValue}`);
      }
      store.set(this, newValue);
    },
    enumerable: true,
    configurable: true,
  });
}

function MaxLength(max: number) {
  return function (target: any, propertyKey: string) {
    const store = new WeakMap<object, string>();
    Object.defineProperty(target, propertyKey, {
      get(this: object) {
        return store.get(this);
      },
      set(this: object, newValue: string) {
        if (newValue.length > max) {
          throw new Error(`${propertyKey} 長度不可超過 ${max}`);
        }
        store.set(this, newValue);
      },
      enumerable: true,
      configurable: true,
    });
  };
}

class RegisterForm {
  @IsEmail email!: string;
  @MaxLength(10) username!: string;
  @IsPositive age!: number;
}

const form = new RegisterForm();
form.email = "gary@example.com"; // ✅
form.username = "gary"; // ✅
form.age = 30; // ✅
// form.email = "not-an-email";           // ❌ Error：email 不是合法的 email
// form.username = "this_is_way_too_long"; // ❌ Error：username 長度不可超過 10
// form.age = -1;                          // ❌ Error：age 必須是正數
```

重點：屬性裝飾器拿不到 `descriptor`（只有 `target` 與 `propertyKey`），驗證要靠改寫 property 的 getter/setter；用 `WeakMap` 綁定實例可避開「所有實例共用一份值」的陷阱。此範例需開啟 `experimentalDecorators`。

> ⚠️ 這個範例還有一個容易忽略、但會讓驗證**靜默失效**的關鍵設定：`useDefineForClassFields`。當 `target` 是 ES2022（含）以上時它預設為 `true`，`email!` 這類欄位宣告會在建構時用 `Object.defineProperty` 在**實例**上定義同名屬性，蓋掉裝飾器裝在 **prototype** 上的 getter/setter——結果賦值不會經過驗證、也不會報錯。要讓舊版屬性裝飾器如預期運作，必須額外設 `"useDefineForClassFields": false`（或把 `target` 設在 ES2021 以下）。這是舊版裝飾器 + 現代 `target` 常見的陷阱。

</details>

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

<details>
<summary>參考解答</summary>

用**舊版裝飾器**（`experimentalDecorators`）搭配類別 + 方法裝飾器，且刻意**不依賴 `reflect-metadata`**：改把每個 controller 的路由暫存在它自己的 `prototype` 上。方法裝飾器 `@Get`/`@Post`… 把 `{ method, path, handlerName }` 累積成一個陣列；類別裝飾器 `@Controller(basePath)` 建立實例、把 base path 與各方法路徑合併後註冊進全域路由表，最後用一個 `dispatch` 依 method + path 找到並呼叫對應 handler。

```typescript
type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";

interface RouteDefinition {
  method: HttpMethod;
  path: string;
  handlerName: string;
}

// 把單一 controller 的路由暫存在它的 prototype 上（用不可列舉的專屬鍵）
const ROUTES_KEY = "__routes__";

// 方法裝飾器工廠：產生 @Get / @Post / @Put / @Delete
function createMethodDecorator(method: HttpMethod) {
  return function (path: string) {
    return function (
      target: any,
      propertyKey: string,
      _descriptor: PropertyDescriptor,
    ) {
      // 確保每個 class 的 prototype 有自己的路由陣列
      if (!Object.prototype.hasOwnProperty.call(target, ROUTES_KEY)) {
        Object.defineProperty(target, ROUTES_KEY, {
          value: [] as RouteDefinition[],
          enumerable: false,
        });
      }
      (target[ROUTES_KEY] as RouteDefinition[]).push({
        method,
        path,
        handlerName: propertyKey,
      });
    };
  };
}

const Get = createMethodDecorator("GET");
const Post = createMethodDecorator("POST");
const Put = createMethodDecorator("PUT");
const Delete = createMethodDecorator("DELETE");

// 全域路由表
interface RegisteredRoute {
  method: HttpMethod;
  fullPath: string;
  handler: () => unknown;
}
const registry: RegisteredRoute[] = [];

// 類別裝飾器：把 base path 與各方法路由合併後註冊進 registry
function Controller(basePath: string) {
  return function <T extends new (...args: any[]) => any>(constructor: T) {
    const instance = new constructor();
    const routes: RouteDefinition[] = constructor.prototype[ROUTES_KEY] ?? [];
    for (const route of routes) {
      const fullPath = (basePath + route.path).replace(/\/+$/, "") || "/";
      registry.push({
        method: route.method,
        fullPath,
        handler: () => instance[route.handlerName](),
      });
    }
  };
}

@Controller("/api/users")
class UserController {
  @Get("/")
  getAll() {
    return ["Gary", "Ada"];
  }

  @Post("/")
  create() {
    return { created: true };
  }

  @Get("/:id")
  getById() {
    return { id: 1, name: "Gary" };
  }
}

// 簡單的分派：依 method + path 找到對應 handler
function dispatch(method: HttpMethod, path: string): unknown {
  const route = registry.find(
    (r) => r.method === method && r.fullPath === path,
  );
  if (!route) throw new Error(`404 找不到路由：${method} ${path}`);
  return route.handler();
}

console.log(dispatch("GET", "/api/users")); // ["Gary","Ada"]
console.log(dispatch("GET", "/api/users/:id")); // { id: 1, name: "Gary" }
console.log(dispatch("POST", "/api/users")); // { created: true }
```

重點：`@Controller` 是類別裝飾器、`@Get` 等是方法裝飾器，兩者透過暫存在 prototype 上的中繼資料串起來；用 `hasOwnProperty` 檢查確保每個 controller 各自持有一份路由陣列。真實框架（NestJS）會用 `reflect-metadata` 存這些資料，這裡用純物件屬性達成相同效果。此範例需開啟 `experimentalDecorators`。

</details>

---

> 下一章：[第十二章 — 最佳實踐與常見模式](./12-best-practices.md)
