# 05 — `this`、原型與類別

> `this` 不是「這個函式屬於誰」，而是「這次是誰呼叫的」。`class` 也不是新的物件模型，而是原型機制的語法糖。

寫過 Java、C# 的人看到 `class`、`extends`、`this`，會以為它們和原本的語言一樣。大部分時候確實很像，但底層機制不同，差異會在把方法當 callback 傳出去、或解構方法時冒出來。這一章先講 `this` 的規則，再講物件之間怎麼透過原型共用方法，最後才是 `class` 語法。

## 5.1 `this` 由呼叫方式決定

一般函式（不是箭頭函式）裡的 `this`，在**每次呼叫時**依呼叫方式決定：

| 呼叫方式 | `this` |
|---------|--------|
| `obj.method()` | `obj` |
| `fn()` | `undefined`（嚴格模式） |
| `new Fn()` | 新建立的物件 |
| `fn.call(x)`、`fn.apply(x)`、`fn.bind(x)()` | `x` |
| 箭頭函式 | 沒有自己的 `this`，沿用定義位置外層的 `this` |

```js
const counter = {
  count: 0,
  increment() {
    this.count += 1;
    return this.count;
  },
};

counter.increment(); // 1，this 是 counter

const inc = counter.increment;
inc(); // TypeError: Cannot read properties of undefined (reading 'count')
```

`inc` 和 `counter.increment` 是**同一個函式**，差別只在呼叫方式：`counter.increment()` 前面有 `counter.`，所以 `this` 是 `counter`；`inc()` 前面沒有東西，嚴格模式下 `this` 是 `undefined`。

### 方法被當成 callback 傳出去時

這是 `this` 出問題最常見的情境：

```js
setTimeout(counter.increment, 1000);              // this 不是 counter
button.addEventListener("click", counter.increment); // this 是 button
const { increment } = counter;                    // 解構也一樣，失去 this
```

傳出去的只是函式本身，之後由 `setTimeout` 或瀏覽器呼叫，它們不知道這個函式原本「屬於」`counter`。解法是用箭頭函式包一層，或用 `bind`：

```js
setTimeout(() => counter.increment(), 1000);
setTimeout(counter.increment.bind(counter), 1000);
```

`addEventListener` 呼叫一般函式時，會把 `this` 設成觸發事件的元素。這是瀏覽器的規則，和上表不衝突：瀏覽器呼叫時用的是 `fn.call(element, event)`。

## 5.2 `call`、`apply`、`bind`

```js
function introduce(greeting, punct) {
  return `${greeting}, I'm ${this.name}${punct}`;
}

introduce.call({ name: "Ann" }, "Hi", "!");     // "Hi, I'm Ann!"
introduce.apply({ name: "Bob" }, ["Hey", "."]); // "Hey, I'm Bob."

const bound = counter.increment.bind(counter);
bound(); // this 永遠是 counter
```

- `call`、`apply` 立即呼叫，第一個參數指定 `this`；差別只在其餘參數是逐一傳還是放在陣列裡。
- `bind` 不呼叫，回傳一個 `this` 固定的新函式。綁定後再 `call` 也改不了它的 `this`。

## 5.3 箭頭函式沒有自己的 `this`

箭頭函式裡的 `this`，就是**定義它的那個位置**的 `this`，和怎麼呼叫無關。這正好解決了方法裡的 callback 問題：

```js
const timer = {
  seconds: 0,
  start() {
    // 箭頭函式：this 沿用 start 的 this，也就是 timer
    setInterval(() => {
      this.seconds += 1;
    }, 1000);
  },
  startBroken() {
    // 一般函式：由 setInterval 呼叫，this 不是 timer
    setInterval(function () {
      this.seconds += 1; // 出錯
    }, 1000);
  },
};
```

反過來，**物件的方法不要寫成箭頭函式**：

```js
const obj = {
  name: "obj",
  hello: () => this.name, // this 是定義物件時外層的 this，不是 obj
};
```

在模組最上層，外層的 `this` 是 `undefined`，呼叫 `obj.hello()` 會丟出 `TypeError`。

規則整理：**方法用方法簡寫，方法裡的 callback 用箭頭函式。**

## 5.4 原型鏈

JavaScript 的物件可以直接從另一個物件繼承。每個物件都有一個內部的**原型**（prototype）連結，讀取屬性時，自己沒有就沿著原型往上找：

```js
const animal = {
  eats: true,
  describe() {
    return `eats=${this.eats}`;
  },
};

const rabbit = Object.create(animal); // 建立一個原型是 animal 的物件
rabbit.jumps = true;

rabbit.eats;       // true，從 animal 找到
rabbit.describe(); // "eats=true"
Object.getPrototypeOf(rabbit) === animal; // true
Object.hasOwn(rabbit, "eats");            // false，不是自己的屬性
```

**寫入**不會往上找，而是直接在物件自己身上建立屬性，遮蔽原型上的同名屬性：

```js
rabbit.eats = false;
rabbit.describe(); // "eats=false"，this 是 rabbit
animal.eats;       // true，原型沒被改到
```

注意 `rabbit.describe()` 裡的 `this` 是 `rabbit`：方法在原型上找到，但 `this` 依然由呼叫方式決定（`rabbit.` 開頭）。這是原型能共用方法的關鍵：方法只有一份，`this` 指向各自的物件。

### 內建物件也是這樣運作

```js
const arr = [1, 2];
Object.getPrototypeOf(arr) === Array.prototype;            // true
Object.getPrototypeOf(Array.prototype) === Object.prototype; // true
Object.getPrototypeOf(Object.prototype);                   // null，鏈的終點
```

`arr.map` 是在 `Array.prototype` 上找到的；`arr.hasOwnProperty` 是再往上在 `Object.prototype` 找到的。所有陣列共用同一份 `map`。

不要修改內建物件的原型（例如替 `Array.prototype` 加方法）。它會影響頁面上所有程式碼，未來語言加入同名方法時還會衝突。

## 5.5 建構函式與 `new`

在 `class` 語法出現之前，用函式加 `new` 建立同一類的物件：

```js
function Person(name) {
  this.name = name;
}
Person.prototype.greet = function () {
  return `Hi, ${this.name}`;
};

const p = new Person("Ann");
p.greet(); // "Hi, Ann"
Object.getPrototypeOf(p) === Person.prototype; // true
```

`new Person("Ann")` 做了四件事：

1. 建立一個新的空物件。
2. 把它的原型設成 `Person.prototype`。
3. 以這個新物件當 `this` 呼叫 `Person`。
4. 回傳這個物件（除非 `Person` 自己回傳了另一個物件）。

所以 `name` 在每個實例自己身上，`greet` 在共用的 `Person.prototype` 上。下一節的 `class` 做的是同一件事，只是寫法不同。

## 5.6 `class` 語法

```js
class Account {
  static #count = 0; // 靜態私有欄位
  #balance = 0;      // 實例私有欄位
  owner;             // 公開欄位

  constructor(owner) {
    this.owner = owner;
    Account.#count += 1;
  }

  deposit(amount) {
    if (amount <= 0) throw new RangeError("amount must be positive");
    this.#balance += amount;
    return this; // 回傳 this 讓呼叫可以串接
  }

  get balance() {
    return this.#balance;
  }

  static get count() {
    return Account.#count;
  }

  static from(json) {
    return new Account(json.owner).deposit(json.balance);
  }
}

const acc = new Account("Ann").deposit(100).deposit(50);
acc.balance;    // 150，透過 getter 讀取
Account.count;  // 1
acc.balance = 999; // TypeError：只有 getter，沒有 setter
// acc.#balance;  // 寫在 class 外面是 SyntaxError，整個檔案都無法執行
```

對照上一節：

- `typeof Account` 是 `"function"`，class 就是一個建構函式。
- `deposit`、`balance` 定義在 `Account.prototype` 上，所有實例共用。
- 欄位（`owner`、`#balance`）在每個實例自己身上。
- `static` 成員屬於 class 本身，用 `Account.count` 存取，常用於工廠方法（`Account.from`）。

和建構函式寫法的差別：class 一定要用 `new` 呼叫，直接呼叫 `Account()` 會丟出 `TypeError`；class 內部自動是嚴格模式；class 宣告有 TDZ，不能在宣告前使用。

### 私有欄位

`#` 開頭的欄位是語言層級的私有：class 外部無法存取，也不會出現在 `Object.keys` 或 `JSON.stringify` 的結果裡：

```js
Object.keys(acc);       // ["owner"]
JSON.stringify(acc);    // '{"owner":"Ann"}'
```

舊程式碼用底線開頭（`_balance`）表示「請不要從外面用」，但那只是慣例，外面仍然讀得到。

## 5.7 繼承

```js
class SavingsAccount extends Account {
  constructor(owner, rate) {
    super(owner); // 一定要先呼叫 super，才能用 this
    this.rate = rate;
  }

  addInterest() {
    return this.deposit(Math.round(this.balance * this.rate));
  }

  deposit(amount) {
    console.log("savings deposit", amount);
    return super.deposit(amount); // 呼叫父類別的版本
  }
}

const s = new SavingsAccount("Cy", 0.1).deposit(1000).addInterest();
s.balance;                  // 1100
s instanceof SavingsAccount; // true
s instanceof Account;        // true
```

- 子類別有 `constructor` 時，**必須先呼叫 `super(...)` 才能使用 `this`**，否則丟出 `ReferenceError`。
- `super.method()` 呼叫父類別的同名方法。
- `instanceof` 檢查的是原型鏈：`Account.prototype` 在 `s` 的原型鏈上，所以為 `true`。
- 子類別存取不到父類別的 `#` 私有欄位，只能透過父類別公開的方法或 getter。

繼承層級不要太深。需要共用的只是一部分功能時，把功能寫成獨立的函式或物件、傳進來使用（組合），通常比多一層繼承容易修改。

## 5.8 class 欄位裡的箭頭函式

5.1 節的 `this` 遺失問題，在 class 裡有一個常見的解法：把方法寫成**欄位**，值是箭頭函式：

```js
class Button {
  label = "OK";
  handleArrow = () => this.label; // 欄位：每個實例各有一個，this 固定
  handleMethod() {                // 方法：放在原型上，this 由呼叫方式決定
    return this?.label;
  }
}

const btn = new Button();
const { handleArrow, handleMethod } = btn;
handleArrow();  // "OK"
handleMethod(); // undefined，this 已經遺失
```

欄位的初始值在 constructor 裡執行，那時的 `this` 就是新的實例，所以箭頭函式抓住了它。代價是：

- 這個函式在**每個實例上各建立一份**，不在原型上共用。實例很多時佔記憶體。
- 子類別不能用 `super.handleArrow()` 呼叫它，因為它不在原型上。

要當事件處理器傳出去的方法，適合這樣寫；其他方法照一般方法寫。

## 5.9 什麼時候用 class

JavaScript 不要求用 class。很多情況下，物件字面值加函式就夠了：

```js
// 不需要 class：只是一組相關的函式
export function formatPrice(cents) { /* ... */ }
export function applyDiscount(cents, rate) { /* ... */ }

// 不需要 class：只是資料
const user = { id: 1, name: "Ann" };
```

適合用 class 的情況：

- 要建立**很多個**有相同行為的物件，而且物件有自己的內部狀態（例如 `Account`、連線、播放器）。
- 需要用 `instanceof` 判斷種類，例如自訂錯誤類別（[8.4 節](08-error-handling.md#84-自訂錯誤類別)）。
- API 要求繼承某個類別，例如 `HTMLElement`（自訂元素）、`Error`。

React 的函式元件、Vue 的 Composition API 都偏向函式加閉包的寫法；Angular、NestJS 則大量使用 class 與裝飾器。兩種風格都要看得懂。

## 5.10 本章小結

- 一般函式的 `this` 由呼叫方式決定：`obj.f()` 是 `obj`，`f()` 是 `undefined`，`new` 是新物件，`call`／`apply`／`bind` 明確指定。
- 方法被當 callback 傳出去或被解構時會失去 `this`；用箭頭函式包一層或 `bind`。
- 箭頭函式沒有自己的 `this`：方法裡的 callback 用箭頭函式，方法本身不要用。
- 讀取屬性時沿原型鏈往上找，寫入時只寫在自己身上；方法放在原型上共用，`this` 指向各自的物件。
- `class` 是建構函式與原型的語法糖；`#` 是真正的私有欄位；子類別先 `super()` 才能用 `this`。
- class 欄位裡的箭頭函式可以固定 `this`，但每個實例各有一份。

下一章：[06 — 字串、正規表達式、日期與 Intl](06-strings-regex-dates-and-intl.md)。

---

[上一章：物件與陣列](04-objects-and-arrays.md) · [返回課程總覽](README.md) · [下一章：字串、正規表達式、日期與 Intl](06-strings-regex-dates-and-intl.md)
