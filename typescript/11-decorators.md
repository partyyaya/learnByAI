# 第十一章：裝飾器（Decorators）

裝飾器用 `@` 把額外行為貼在類別、方法、屬性或參數上，在**宣告當下**執行，用來擴充行為而不改原本實作。NestJS、TypeORM、Angular 都大量使用。

本章先把框架仍在用的**舊版裝飾器**講完，最後才對照 TypeScript 5.0+ 的**標準裝飾器**。兩套語法不相容，一個專案一次編譯只能選一種。

閱讀順序：11.1 認語法 → 11.2 啟用與共用寫法 → 11.3～11.6 四種附加位置 → 11.7 標準裝飾器（選讀）→ 11.8 框架怎麼用。

---

## 11.1 什麼是裝飾器？

裝飾器是一種**語法糖**：寫在宣告正上方的 `@Foo` 或 `@Foo(...)`，編譯後會變成「對該宣告呼叫一個函式」。它在 **class 宣告被求值時**就跑完，不是每次 `new`。之後 `new User()` 不會再執行 `@Sealed` 或 `@Log`。

四種附加位置如下（名稱只是地圖，實作見後面對應小節）：

```typescript
@Sealed                            // 類別 → 11.3（最後才套）
class User {
  @Required                        // 屬性 → 11.5
  name!: string;

  constructor(@Validate id: number) {} // 參數 → 11.6（比成員晚、比類別早）

  @Log                             // 方法 → 11.4
  save() {}
}
```

舊版裝飾器依附加位置，拿到的參數不一樣：

| 附加位置 | 函式參數 | 執行時機 |
|---|---|---|
| 類別 | `constructor` | `class` 宣告完成時，一次 |
| 方法 | `target, propertyKey, descriptor` | 該方法宣告時 |
| 屬性 | `target, propertyKey`（沒有 descriptor） | 該欄位宣告時 |
| 參數 | `target, propertyKey, parameterIndex` | 該參數宣告時 |

### 同一個 class 裡誰先跑？

舊版的套用順序是固定的（與建構子寫在原始碼哪一行無關）：

1. 每個**實例成員**（由上到下）：先該成員的參數裝飾器，再方法／屬性裝飾器
2. 每個**靜態成員**（同樣先參數、再方法／屬性）
3. **建構子參數**裝飾器
4. **類別**裝飾器

所以上面地圖實際順序是：`@Required` → `@Log` → `@Validate` → `@Sealed`。`constructor` 雖然寫在 `save` 前面，建構子參數仍比方法晚、只比類別裝飾器早。

### 同一個宣告上有多個 `@`

兩件事要分開記：

| | 方向 | 意思 |
|---|---|---|
| Factory 被呼叫（`@A()` 裡的 `A()`） | **由上往下** | 先算外層傳進去的參數 |
| 裝飾器函式真正套上 | **由下往上** | 最靠近宣告的先包，等價於函數合成 `A(B(x))` |

```typescript
function A() {
  console.log("A(): evaluated");
  return function (..._args: any[]) {
    console.log("A(): applied");
  };
}
function B() {
  console.log("B(): evaluated");
  return function (..._args: any[]) {
    console.log("B(): applied");
  };
}

class Demo {
  @A()
  @B()
  save() {}
}

// A(): evaluated
// B(): evaluated
// B(): applied
// A(): applied
```

`@A() @B() save()` 等價於 `A(B(save))`：先套內層 `B`，再套外層 `A`。11.4 的 `@Catch` 在上、`@Measure` 在下，就是先測時間再攔錯。同一方法若有多個參數裝飾器，套用時由**右到左**（最後一個參數先）。

標準裝飾器（11.7）堆疊同樣是由內而外；整份 class 的求值細節與舊版不完全相同，兩套仍不要混用。

---

## 11.2 啟用方式與共用寫法

### 本章預設：舊版裝飾器

```json
// tsconfig.json
{
  "compilerOptions": {
    "experimentalDecorators": true,    // 啟用舊版裝飾器語法
    "emitDecoratorMetadata": true      // 可選：讓編譯器順便輸出 design:type 等內建中繼資料
  }
}
```

`emitDecoratorMetadata` 要搭配 `reflect-metadata` 套件才有執行期效果。自己用 `Reflect.defineMetadata` 存自訂鍵值時，套件仍要裝，但不必開這個旗標。細節見 11.6。

### 舊版 vs 標準（TC39）

| | 舊版（`experimentalDecorators`） | 標準（TC39 Stage 3，TS 5.0+） |
|---|---|---|
| 啟用 | tsconfig 開 `"experimentalDecorators": true` | 不需旗標 |
| 函式簽章 | 依位置不同（見上表） | 統一 `(value, context) => ...` |
| 參數裝飾器 | ✅（NestJS `@Param` / `@Body` 這類） | ❌ 規格已刪除，見 11.6 |
| 中繼資料 | `emitDecoratorMetadata` + `reflect-metadata` | `context.metadata`（TS 5.2+，見 11.7） |
| 誰在用 | NestJS、TypeORM、Angular（遷移前） | 尚無主流後端框架 |

> ⚠️ 兩套不能混用：整個 tsconfig 要嘛開 `experimentalDecorators` 走舊版，要嘛不開走標準版。

### 三條共用規則

後面四種位置都會用到，先記在這裡：

1. **`@Foo` 和 `@Foo()` 不是同一件事。** `@Foo` 把 `Foo` 當裝飾器；`@Foo()` 是先呼叫 `Foo()`，再用它的**回傳值**當裝飾器。不需要參數就寫 `@Foo`，需要參數就寫工廠（下一點）。寫錯成 `@Sealed()` 會拿到 `undefined`，等於沒套上。
2. **要帶參數就寫 Decorator Factory**：外層 `(...args) => decorator`，內層才是真正的裝飾器。`@Entity("users")`、`@Get("/")`、`@Retry(3)` 都是這個模式。
3. **有沒有 `return` 決定是否取代原物。** 沒有 `return`（或回傳 `undefined`）= 就地修改；有 `return` = 用新的 constructor / 新的 descriptor 取代。

---

## 11.3 類別裝飾器（Class Decorator）

參數是**類別的建構函式**。在 `class` 宣告完成時執行一次，不是每次 `new`。三種常見用法：就地修改、貼中繼資料、回傳子類別攔截 `new`。

### 就地修改：用 `Object.seal` 鎖定類別

`Object.seal(obj)` 是 JavaScript **執行期** API，把物件「密封」：不能再新增或刪除屬性，既有屬性變成 non-configurable。原本 writable 的**值仍可改**。和相近 API 的差別：

| | 新增屬性 | 刪除屬性 | 改既有屬性的值 |
|---|---|---|---|
| 普通物件 | ✅ | ✅ | ✅ |
| `Object.preventExtensions` | ❌ | ✅ | ✅ |
| `Object.seal` | ❌ | ❌ | ✅（writable 的仍可改） |
| `Object.freeze` | ❌ | ❌ | ❌（只凍一層） |

為什麼要封兩次？

- `constructor`：靜態成員掛在這裡。封住後不能再 `User.helper = ...`。
- `constructor.prototype`：實例方法掛在這裡。封住後不能再 `User.prototype.greet = ...`。

這跟 TypeScript 的 `readonly` 不同：型別檢查不知道類別被封住。它也**不會**阻止對單一實例加欄位（`new User("Gary").age = 18` 仍可以），因為那是加在實例上，不是 prototype。類別本體是嚴格模式，違規會丟 `TypeError`。

```typescript
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

// User.prototype.greet = function () {}; // TypeError：prototype 已被密封
// User.helper = () => {};                // TypeError：建構函式已被密封
```

### 貼中繼資料：Factory + `Reflect.defineMetadata`

`@Entity("users")` 需要參數，所以外層是工廠。內層把「這個 class 對應哪張表」記在 constructor 上，之後 ORM 再讀。`defineMetadata` 本身不會建表，原理見 11.6。

```typescript
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

Reflect.getMetadata("tableName", User); // "users"
```

### 回傳新類別：攔截建構

`return` 一個新的 constructor 會**取代**被裝飾的類別，適合每次 `new` 都要多做的事（打 log、單例、代理）。

`T extends new (...args: any[]) => any` 用來保留原本建構子型別。內層必須 `super(...args)`，否則原來的欄位初始化不會跑。

```typescript
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

new UserService("auth");
// DEBUG: Creating instance of UserService
```

和 `Entity` 的差別：`Entity` 只貼資料、不 `return`；`LogClass` 回傳子類別，之後的 `new UserService` 實際 new 到的是那層包裝。

---

## 11.4 方法裝飾器（Method Decorator）

方法宣告時執行，拿到三個參數：

| 參數 | 意義 |
|---|---|
| `target` | 實例方法是 `prototype`；靜態方法是 constructor |
| `propertyKey` | 方法名稱 |
| `descriptor` | 該方法的 `PropertyDescriptor`，真正的函式在 `descriptor.value` |

典型寫法：先存原方法，再換成包裝函式。就地改 `descriptor.value` 或 `return descriptor` 都可以。

```typescript
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

### 常用組合：測時間、攔錯、防抖

三者都是「包一層 `descriptor.value`」。`Catch`、`Debounce` 要參數，所以是 Factory。

```typescript
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
  @Catch((err) => console.error(err))
  @Measure
  async fetchResults(query: string): Promise<string[]> {
    return [];
  }

  @Debounce(300)
  onSearchInput(value: string): void {
    this.fetchResults(value);
  }
}
```

多個 `@` 的順序見 11.1：這裡 `@Catch` 在上、`@Measure` 在下，所以先套 `Measure` 再套 `Catch`，計時包在 try/catch 裡。

---

## 11.5 屬性裝飾器（Property Decorator）

只有 `target` 與 `propertyKey`，**沒有 descriptor**，所以不能像方法那樣直接換函式。常見做法是用 `Object.defineProperty` 在 prototype 上裝 getter/setter，攔截賦值。

兩個陷阱（正式程式都要避開）：

1. 閉包變數 `value` 會讓**所有實例共用同一份值**。應改用 `WeakMap` 依實例存（見練習 2）。
2. `useDefineForClassFields: true`（`target` 為 ES2022+ 時的預設）會在**實例**上再定義同名屬性，蓋掉 prototype 上的 setter，驗證會**靜默失效**。要讓舊版屬性裝飾器生效，設 `"useDefineForClassFields": false`，或把 `target` 降到 ES2021 以下。

```typescript
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

## 11.6 參數裝飾器與 `reflect-metadata`

參數裝飾器只負責**記住第幾個參數需要處理**，本身不會包一層函式。真正檢查發生在方法被呼叫時，所以通常再搭配一個方法裝飾器，用中繼資料把兩邊串起來。

### `Reflect.defineMetadata` 是什麼？

原生 `Reflect` **沒有** `defineMetadata`。它來自套件 [`reflect-metadata`](https://www.npmjs.com/package/reflect-metadata)，在進入點 `import "reflect-metadata"` 之後，才在 `Reflect` 上掛出這些方法。

把它想成掛在 target 上的小筆記本：

```typescript
Reflect.defineMetadata(key, value, target, propertyKey?);
Reflect.getMetadata(key, target, propertyKey?);
```

- 11.3 的 `@Entity("users")`：key 是 `"tableName"`，target 是 class。
- 下面的 `@Validate`：key 是 `"validate"`，value 是參數 index 陣列，貼在方法上。

和 tsconfig 的 `emitDecoratorMetadata` 不同：那個旗標是讓**編譯器**自動寫入 `design:type` / `design:paramtypes`；`defineMetadata` 是你自己寫自訂鍵。兩者都需要這個套件才能在執行期讀到。

```typescript
function Validate(
  target: any,
  propertyKey: string,
  parameterIndex: number,
) {
  const existing: number[] =
    Reflect.getOwnMetadata("validate", target, propertyKey) || [];
  existing.push(parameterIndex);
  Reflect.defineMetadata("validate", existing, target, propertyKey);
}

function ValidateArgs(
  target: any,
  propertyKey: string,
  descriptor: PropertyDescriptor,
) {
  const original = descriptor.value;
  const indexes: number[] =
    Reflect.getOwnMetadata("validate", target, propertyKey) || [];

  descriptor.value = function (...args: any[]) {
    for (const i of indexes) {
      if (args[i] == null || args[i] === "") {
        throw new Error(`${propertyKey} 的第 ${i + 1} 個參數不可為空`);
      }
    }
    return original.apply(this, args);
  };
}

class UserService {
  @ValidateArgs
  createUser(@Validate name: string, @Validate email: string) {
    return { name, email };
  }
}
```

> 📌 標準（TC39）裝飾器**完全沒有參數裝飾器**這個類別。這是 NestJS、Angular 這類仰賴建構子參數注入（`@Param`、`@Body`）的框架，短期內無法搬到新語法的原因。

---

## 11.7 標準裝飾器（TypeScript 5.0+）

不需要 `experimentalDecorators`。簽章統一成 `(value, context)`，`context` 帶有 `kind`、`name`、`metadata` 等資訊。下面這段**不要**和舊版裝飾器放在同一個 tsconfig 裡編譯。

```typescript
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

### Accessor 與 Decorator Metadata（TypeScript 5.2+）

標準裝飾器新增 `accessor`：欄位會自動產生底層 get/set，裝飾器才能包讀寫。一般的 `@Decorator field: T` 包不住 get/set。

`context.metadata` 是掛在該類別 `Symbol.metadata` 上的共用物件，多個裝飾器可以互相留言，不必自建 `WeakMap`。

```typescript
function trackChanges<This, Value>(
  target: ClassAccessorDecoratorTarget<This, Value>,
  context: ClassAccessorDecoratorContext<This, Value>,
): ClassAccessorDecoratorResult<This, Value> {
  const fieldName = String(context.name);

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
settings.theme = "dark"; // theme changed to dark

console.log(Settings[Symbol.metadata]?.theme); // "tracked"
```

> 💡 若提示 `Symbol.metadata` 不存在，把 tsconfig 的 `lib` 加上 `esnext`（這份型別目前掛在這裡，`ES2022` 還沒內建）。

---

## 11.8 框架中的應用

下面都是**舊版裝飾器 + Factory**（11.2～11.6 那套）。看到 `@Get()`、`@Column()`、`@Component({...})`，就是外層先收參數、內層再改 class / 方法 / 屬性。

### NestJS：類別 + 方法 + 參數

`@Controller` 是類別裝飾器，`@Get` / `@Post` 是方法裝飾器，`@Param` / `@Body` 是參數裝飾器。執行期靠 `reflect-metadata` 組路由與 DI。

```typescript
import { Controller, Get, Post, Body, Param } from "@nestjs/common";

@Controller("users")
class UserController {
  constructor(private readonly userService: UserService) {}

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

### TypeORM：類別 + 屬性

`@Entity` 對應 11.3 貼表名；`@Column` 是屬性裝飾器，把欄位對應寫進 metadata。

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

### Angular：類別 Factory + 屬性

`@Component({...})` 是帶設定物件的類別工廠；`@Input` / `@Output` 是屬性裝飾器。

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

用**舊版裝飾器**（`experimentalDecorators`，與 11.4 同一套）。思路：在工廠裡包一層迴圈，攔截 `descriptor.value`，用 `try/catch` 反覆呼叫原方法；第一次是正常呼叫，之後最多再重試 `maxRetries` 次，全部失敗才把最後一個錯誤丟出去。方法可能是非同步，包裝後統一 `await`。

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

重點：`maxRetries` 是「重試次數」，所以總嘗試次數是 `maxRetries + 1`；包裝後方法一律回傳 `Promise`，記得呼叫端要 `await`。此範例需開啟 `experimentalDecorators`。

</details>

### 練習 2：屬性裝飾器

建立一組驗證裝飾器：`@IsEmail`、`@IsPositive`、`@MaxLength(n)`。

<details>
<summary>參考解答</summary>

同樣走**舊版裝飾器**，沿用 11.5 的手法：用 `Object.defineProperty` 攔截 `set`，賦值當下就驗證。跟 11.5 範例的差別是改用 `WeakMap` 依實例存值，避免多個實例共用同一個閉包變數。`@IsEmail`、`@IsPositive` 不帶參數；`@MaxLength(n)` 需要參數所以多包一層工廠。

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

重點：屬性裝飾器拿不到 `descriptor`，驗證要靠 getter/setter；用 `WeakMap` 綁定實例可避開「所有實例共用一份值」。此範例需開啟 `experimentalDecorators`。

> ⚠️ `useDefineForClassFields`：`target` 為 ES2022+ 時預設 `true`，`email!` 會在**實例**上蓋掉 prototype 的 setter，驗證會靜默失效。舊版屬性裝飾器請設 `"useDefineForClassFields": false`（或 `target` 降到 ES2021 以下）。

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

用**舊版裝飾器**搭配類別 + 方法裝飾器，且刻意**不依賴 `reflect-metadata`**：把每個 controller 的路由暫存在它自己的 `prototype` 上。方法裝飾器 `@Get` / `@Post` 把 `{ method, path, handlerName }` 推進陣列；類別裝飾器 `@Controller(basePath)` 建立實例、合併路徑後註冊進全域表，最後用 `dispatch` 依 method + path 呼叫 handler。

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

重點：`@Controller` 是類別裝飾器、`@Get` 等是方法裝飾器，兩者透過 prototype 上的中繼資料串起來；`hasOwnProperty` 確保每個 controller 各自一份陣列。真實框架（NestJS）會用 `reflect-metadata` 做同一件事。此範例需開啟 `experimentalDecorators`。

</details>

---

> 下一章：[第十二章 — 最佳實踐與常見模式](./12-best-practices.md)
