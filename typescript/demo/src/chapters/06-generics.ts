// =====================================================================
// 第六章：泛型（Generics）
// 來源：typescript/06-generics.md
// 每個獨立範例都包在自己的 { ... } 區塊內，避免同名宣告互相衝突，
// 並把用到的型別/介面整段複製進來，讓每塊自成一體。
// =====================================================================

// ===== 6.1 什麼是泛型？ =====

// 範例 A：不使用泛型 — 缺乏型別安全
{
  function getFirst(arr: any[]): any {
    return arr[0];
  }

  const result = getFirst([1, 2, 3]); // result 的型別是 any，失去了型別資訊
  console.log("6.1 any 版本 getFirst:", result);
}

// 範例 B：使用泛型 — 保留型別資訊
{
  function getFirst<T>(arr: T[]): T {
    return arr[0];
  }

  const num = getFirst([1, 2, 3]); // num 的型別是 number
  const str = getFirst(["a", "b", "c"]); // str 的型別是 string
  console.log("6.1 泛型版本 getFirst:", num, str);
}

// ===== 6.2 泛型函式 =====
{
  // 基本泛型函式
  function identity<T>(value: T): T {
    return value;
  }

  // 明確指定型別
  identity<string>("hello"); // "hello"
  identity<number>(42); // 42

  // 型別推論（推薦）
  identity("hello"); // TypeScript 自動推斷 T = string
  identity(42); // TypeScript 自動推斷 T = number

  // 多個型別參數
  function pair<A, B>(first: A, second: B): [A, B] {
    return [first, second];
  }

  const p = pair("hello", 42); // 型別為 [string, number]
  console.log("6.2 pair:", p);

  // 泛型箭頭函式
  const toArray = <T>(value: T): T[] => [value];

  // 在 TSX 中需要加逗號避免被解析成 JSX
  const toArray2 = <T,>(value: T): T[] => [value];
  console.log("6.2 toArray:", toArray(1), toArray2("a"));
}

// ===== 6.2 NoInfer<T>（TS 5.4+）避免推斷型別被意外撐大 =====
{
  // 沒有 NoInfer：fallbackRole 的型別也會拿去推斷 T，讓 T 被意外撐大
  function pickRole<T extends string>(roles: T[], fallbackRole?: T): T {
    return fallbackRole ?? roles[0];
  }

  const role = pickRole(["admin", "user"], "guest");
  // role 的型別被撐大成 "admin" | "user" | "guest"，
  // 即使 "guest" 根本不在 roles 陣列裡，也不會報錯

  // 用 NoInfer<T> 排除 fallbackRole 對 T 的推斷貢獻，只讓 roles 陣列決定 T
  function pickRoleFixed<T extends string>(roles: T[], fallbackRole?: NoInfer<T>): T {
    return fallbackRole ?? roles[0];
  }

  const roleFixed = pickRoleFixed(["admin", "user"], "admin"); // ✅ T 只會是 "admin" | "user"
  // pickRoleFixed(["admin", "user"], "guest");
  // ❌ Argument of type '"guest"' is not assignable to parameter of type '"admin" | "user" | undefined'

  console.log("6.2 NoInfer:", role, roleFixed);
}

// ===== 6.3 泛型約束（Generic Constraints）=====
{
  // 約束 T 必須有 length 屬性
  function logLength<T extends { length: number }>(value: T): void {
    console.log(`Length: ${value.length}`);
  }

  logLength("hello"); // ✅ string 有 length
  logLength([1, 2, 3]); // ✅ 陣列有 length
  // logLength(42);        // ❌ number 沒有 length

  // 使用介面約束
  interface HasId {
    id: number;
  }

  function findById<T extends HasId>(items: T[], id: number): T | undefined {
    return items.find((item) => item.id === id);
  }

  const users = [
    { id: 1, name: "Alice" },
    { id: 2, name: "Bob" },
  ];

  const user = findById(users, 1); // 型別為 { id: number; name: string } | undefined
  console.log("6.3 findById:", user);
}

// ===== 6.3 keyof 約束 =====
{
  // T 是物件，K 是 T 的鍵
  function getProperty<T, K extends keyof T>(obj: T, key: K): T[K] {
    return obj[key];
  }

  const user = { name: "Gary", age: 30, email: "gary@example.com" };

  getProperty(user, "name"); // 回傳型別為 string
  getProperty(user, "age"); // 回傳型別為 number
  // getProperty(user, "phone"); // ❌ "phone" 不是 user 的鍵
  console.log("6.3 getProperty:", getProperty(user, "name"), getProperty(user, "age"));
}

// ===== 6.3 keyof 約束 — 場景 1：通用表格元件 =====
{
  interface Column<T> {
    key: keyof T; // 只能是 T 真的有的欄位名
    title: string;
  }

  function renderTable<T>(data: T[], columns: Column<T>[]): string[] {
    const header = columns.map((col) => col.title).join(" | ");
    const rows = data.map((row) => columns.map((col) => String(row[col.key])).join(" | "));
    return [header, ...rows];
  }

  interface Employee {
    id: number;
    name: string;
    age: number;
  }

  const employees: Employee[] = [
    { id: 1, name: "Alice", age: 28 },
    { id: 2, name: "Bob", age: 35 },
  ];

  const table = renderTable(employees, [
    { key: "name", title: "姓名" },
    { key: "age", title: "年齡" },
    // { key: "phone", title: "電話" }, // ❌ Employee 沒有 phone
  ]);

  console.log("6.3 renderTable:", table);
}

// ===== 6.3 keyof 約束 — 場景 2：sortBy / pluck（回傳型別跟著 key 變）=====
{
  function sortBy<T, K extends keyof T>(items: T[], key: K): T[] {
    return [...items].sort((a, b) => (a[key] > b[key] ? 1 : -1));
  }

  function pluck<T, K extends keyof T>(items: T[], key: K): T[K][] {
    return items.map((item) => item[key]);
  }

  const staff = [
    { id: 1, name: "Alice", age: 28 },
    { id: 2, name: "Bob", age: 35 },
  ];

  const names = pluck(staff, "name"); // string[]
  const ages = pluck(staff, "age"); // number[]
  const sorted = sortBy(staff, "age"); // 依年齡排序

  console.log("6.3 pluck / sortBy:", names, ages, sorted);
}

// ===== 6.3 keyof 約束 — 場景 3：key 與 value 必須對得起來 =====
{
  function setField<T, K extends keyof T>(obj: T, key: K, value: T[K]): T {
    return { ...obj, [key]: value };
  }

  const profile = { name: "Gary", age: 30 };

  const updated = setField(profile, "age", 31); // ✅
  // setField(profile, "age", "31"); // ❌ age 是 number，不能塞字串
  // setField(profile, "name", 100); // ❌ name 是 string，不能塞數字

  console.log("6.3 setField:", updated);
}

// ===== 6.4 泛型介面 =====
{
  // 泛型介面
  interface ApiResponse<T> {
    data: T;
    status: number;
    message: string;
    timestamp: string;
  }

  interface User {
    id: number;
    name: string;
  }

  interface Product {
    id: number;
    title: string;
    price: number;
  }

  // 使用泛型介面
  type UserResponse = ApiResponse<User>;
  type ProductListResponse = ApiResponse<Product[]>;

  // 泛型介面搭配函式
  async function fetchApi<T>(url: string): Promise<ApiResponse<T>> {
    const response = await fetch(url);
    return response.json();
  }

  // 呼叫時指定型別 — 刻意不執行這個 IIFE：fetch("/api/users/1") 是相對路徑，
  // 在 Node.js 環境下會直接丟出 "Failed to parse URL" 而讓整個範例中斷，
  // 這裡只是要展示呼叫時的型別標注寫法，不需要真的發出網路請求
  async () => {
    const userRes = await fetchApi<User>("/api/users/1");
    // userRes.data 的型別是 User
    console.log("6.4 fetchApi:", userRes.data);
  };

  // 讓型別別名被使用一下，避免被視為完全孤立
  const _demoUserResponse: UserResponse = {
    data: { id: 1, name: "Gary" },
    status: 200,
    message: "ok",
    timestamp: "2026-07-23",
  };
  const _demoProductResponse: ProductListResponse = {
    data: [{ id: 1, title: "Book", price: 100 }],
    status: 200,
    message: "ok",
    timestamp: "2026-07-23",
  };
  console.log("6.4 ApiResponse:", _demoUserResponse.data, _demoProductResponse.data);
}

// ===== 6.4 型別變異標記 in / out（TS 4.7+）=====
// 「變異」在問：Dog 是 Animal 的子型別，那包上泛型後 Producer<Dog> 還是 Producer<Animal> 的子型別嗎？
// 答案取決於 T 是被拿來「產出」還是「接收」。
{
  // out T：T 只出現在「回傳值」位置 → 這個介面只負責產出 T（協變）
  interface Producer<out T> {
    produce(): T;
  }

  // in T：T 只出現在「參數」位置 → 這個介面只負責接收 T（逆變）
  interface Consumer<in T> {
    consume(value: T): void;
  }

  class Animal {
    name = "animal";
  }
  class Dog extends Animal {
    bark() {}
  }

  // ---------- 協變 out：方向跟繼承一樣 ----------
  const dogProducer: Producer<Dog> = { produce: () => new Dog() };

  // ✅ 狗工廠可以當動物工廠用：呼叫端拿到狗，而狗本來就是動物 —— 給得比承諾的更具體，安全
  const producer: Producer<Animal> = dogProducer;

  const animalProducer: Producer<Animal> = { produce: () => new Animal() };
  // ❌ 反過來不行：呼叫端以為會拿到狗、想呼叫 .bark()，但工廠可能生出一隻貓
  // const wrong: Producer<Dog> = animalProducer;
  void animalProducer;

  // ---------- 逆變 in：方向跟繼承相反 ----------
  const animalConsumer: Consumer<Animal> = { consume: (a) => console.log(a.name) };

  // ✅ 「什麼動物都能處理」可以當成「處理狗」用：呼叫端只餵狗，而它連任何動物都接得住 —— 接受得比需求更寬，安全
  const consumer: Consumer<Dog> = animalConsumer;

  const dogConsumer: Consumer<Dog> = { consume: (d) => d.bark() };
  // ❌ 反過來不行：呼叫端可能餵一隻貓，而 consume 內部會呼叫 .bark()，執行期就炸了
  // const wrong2: Consumer<Animal> = dogConsumer;
  void dogConsumer;

  // 口訣：產出可以更具體，接收可以更寬鬆。

  console.log("6.4 variance in/out:", producer.produce(), typeof consumer.consume);
}

// ===== 6.4 沒有 in 標記時的雙變（bivariant）漏洞 =====
{
  class Animal {
    name = "animal";
  }
  class Dog extends Animal {
    bark() {}
  }

  // 沒有 in 標記，且用 method 語法宣告參數 → TypeScript 預設是「雙變」，兩個方向都放行
  interface ConsumerNoMark<T> {
    consume(value: T): void;
  }

  const dogOnly: ConsumerNoMark<Dog> = { consume: (d) => d.bark() };
  // ⚠️ 這行沒有報錯，但其實不安全；如果 ConsumerNoMark 寫成 <in T> 就會在這裡被擋下來
  const anyAnimal: ConsumerNoMark<Animal> = dogOnly;

  // anyAnimal.consume(new Animal()); // 真的呼叫下去會執行期爆炸：Animal 沒有 bark()
  console.log("6.4 bivariance 漏洞:", typeof anyAnimal.consume);
}

// ===== 6.4 泛型介面 — Repository 模式 =====
{
  interface User {
    id: number;
    name: string;
  }

  interface Repository<T extends { id: number }> {
    findAll(): Promise<T[]>;
    findById(id: number): Promise<T | null>;
    create(data: Omit<T, "id">): Promise<T>;
    update(id: number, data: Partial<T>): Promise<T>;
    delete(id: number): Promise<boolean>;
  }

  class UserRepository implements Repository<User> {
    // 原文的方法本體為 /* ... */，這裡補上最小可編譯實作
    async findAll(): Promise<User[]> {
      return [];
    }
    async findById(id: number): Promise<User | null> {
      return null;
    }
    async create(data: Omit<User, "id">): Promise<User> {
      return { id: 0, ...data };
    }
    async update(id: number, data: Partial<User>): Promise<User> {
      return { id, name: "unknown", ...data };
    }
    async delete(id: number): Promise<boolean> {
      return true;
    }
  }

  const repo = new UserRepository();
  console.log("6.4 Repository:", repo instanceof UserRepository);
}

// ===== 6.5 泛型類別 =====
{
  interface User {
    id: number;
    name: string;
  }

  class DataStore<T> {
    private items: T[] = [];

    add(item: T): void {
      this.items.push(item);
    }

    getAll(): T[] {
      return [...this.items];
    }

    find(predicate: (item: T) => boolean): T | undefined {
      return this.items.find(predicate);
    }

    filter(predicate: (item: T) => boolean): T[] {
      return this.items.filter(predicate);
    }

    remove(predicate: (item: T) => boolean): void {
      this.items = this.items.filter((item) => !predicate(item));
    }
  }

  // 使用
  const userStore = new DataStore<User>();
  userStore.add({ id: 1, name: "Alice" });
  userStore.add({ id: 2, name: "Bob" });

  const alice = userStore.find((u) => u.name === "Alice");
  console.log("6.5 DataStore:", alice, userStore.getAll());
}

// ===== 6.6 泛型預設值 =====
{
  interface User {
    id: number;
    name: string;
  }

  // 給泛型指定預設型別
  interface PaginatedList<T = unknown> {
    items: T[];
    page: number;
    pageSize: number;
    total: number;
  }

  // 不指定型別時使用預設值
  const list: PaginatedList = {
    items: [],
    page: 1,
    pageSize: 10,
    total: 0,
  };

  // 也可以指定具體型別
  const userList: PaginatedList<User> = {
    items: [{ id: 1, name: "Gary" }],
    page: 1,
    pageSize: 10,
    total: 1,
  };
  console.log("6.6 PaginatedList:", list.total, userList.items);
}

// ===== 6.7 常見泛型模式 — Result 模式（錯誤處理）=====
// 用途：把「這個函式可能會失敗」寫進回傳型別，讓編譯器強迫呼叫端處理錯誤。
// 對比 try/catch：函式簽章看不出會不會 throw，呼叫端容易漏掉；catch (e) 的 e 還是 unknown。
{
  // 可辨識聯合：用 success 這個字面量欄位當「標籤」；E 預設為 Error
  type Result<T, E = Error> =
    | { success: true; data: T } // 成功時只有 data
    | { success: false; error: E }; // 失敗時只有 error

  // 回傳型別直接宣告「我可能失敗，失敗時錯誤是 string」
  function divide(a: number, b: number): Result<number, string> {
    if (b === 0) {
      // 除以零是「預期內」的失敗，不是程式 bug，所以用回傳值而非 throw
      return { success: false, error: "Cannot divide by zero" };
    }
    return { success: true, data: a / b };
  }

  const result = divide(10, 2);

  // 檢查 success 後 TypeScript 會自動縮窄型別；沒先檢查就存取 data 會編譯錯誤
  if (result.success) {
    console.log("6.7 Result 成功:", result.data); // 型別縮窄為 number
  } else {
    console.error("6.7 Result 失敗:", result.error); // 型別縮窄為 string
  }

  // console.log(result.data); // ❌ 沒先檢查 success，data 不存在於失敗分支

  // 失敗情境
  const failed = divide(10, 0);
  console.log("6.7 Result 除以零:", failed.success ? failed.data : failed.error);

  // 判準：失敗是業務流程的一部分 → 用 Result；是不該發生的 bug → 用 throw
}

// ===== 6.7 常見泛型模式 — Builder 模式 =====
// 用途：把「參數很多、大多選填、要一步步組出來」的物件，改成可讀性高的鏈式呼叫。
// 不用 Builder 通常會變成吃十幾個參數的函式，或塞滿 undefined 的設定物件。
{
  interface User {
    id: number;
    name: string;
    age: number;
  }

  // 泛型 T 代表「這個 query 在查哪張表」；有了 T，orderBy 才能限制欄位名
  class QueryBuilder<T> {
    // 中間狀態都設為 private：外部只能透過方法修改
    private conditions: string[] = [];
    private orderByField?: string;
    private limitValue?: number;

    where(condition: string): QueryBuilder<T> {
      this.conditions.push(condition); // 累加，所以可以連續呼叫多次 where
      return this; // 回傳自己 → 才能接著 .orderBy().limit()，這就是鏈式呼叫的原理
    }

    // keyof T 擋掉不存在的欄位；& string 是因為 keyof T 可能含 symbol/number，
    // 而這裡要拼進 SQL 字串，必須確保是 string
    orderBy(field: keyof T & string): QueryBuilder<T> {
      this.orderByField = field;
      return this;
    }

    limit(count: number): QueryBuilder<T> {
      this.limitValue = count;
      return this;
    }

    // 終結方法：結束鏈式呼叫，把累積的狀態轉成最終產物
    // 回傳 string 而不是 this，所以鏈到這裡就必須停下來
    build(): string {
      let query = "SELECT * FROM table";
      if (this.conditions.length) {
        query += ` WHERE ${this.conditions.join(" AND ")}`;
      }
      if (this.orderByField) {
        query += ` ORDER BY ${this.orderByField}`;
      }
      if (this.limitValue) {
        query += ` LIMIT ${this.limitValue}`;
      }
      return query;
    }
  }

  // 每個設定都有名字、都可以省略，順序也不影響結果
  const query = new QueryBuilder<User>()
    .where("age > 18")
    .orderBy("name") // ✅ name 是 User 的欄位
    // .orderBy("phone") // ❌ User 沒有 phone，編譯期就擋下來
    .limit(10)
    .build();
  console.log("6.7 Builder:", query);
}

// ===== 練習 1：泛型函式 groupBy =====
{
  function groupBy<T>(arr: T[], key: keyof T): Record<string, T[]> {
    // 練習參考解答
    return arr.reduce((acc, item) => {
      const groupKey = String(item[key]);
      (acc[groupKey] ??= []).push(item);
      return acc;
    }, {} as Record<string, T[]>);
  }

  // 使用
  const users = [
    { name: "Alice", role: "admin" },
    { name: "Bob", role: "user" },
    { name: "Charlie", role: "admin" },
  ];

  console.log("練習 1 groupBy:", groupBy(users, "role"));
  // { admin: [Alice, Charlie], user: [Bob] }
}

// ===== 練習 2：泛型類別 EventEmitter<T> =====
// EventEmitter 就是「訂閱 / 發佈」機制：on() 訂閱、emit() 發佈。
// button.addEventListener("click", handler) 就是這個東西。
// 目標：用泛型把「事件名稱」和「該事件的資料形狀」綁在一起。
{
  // 練習參考解答：T 是一張「事件名稱 -> 該事件的資料形狀」對照表
  // 約束成 Record<string, unknown>：鍵是事件名（字串），值是任意資料形狀
  class EventEmitter<T extends Record<string, unknown>> {
    // 映射型別：逐一走訪 T 的每個鍵 K，替它建一個「監聽器陣列」欄位
    //   [K in keyof T] → 對 T 的每個事件名各產生一個欄位
    //   ?              → 選填，因為一開始是 {}，還沒人訂閱的事件根本沒有這個 key
    //   T[K]           → 該事件對應的資料型別，讓回呼的 payload 型別自動對上
    // 代入 AppEvents 後實際展開成：
    //   { login?: Array<(p: { userId: number }) => void>;
    //     logout?: Array<(p: { userId: number; reason: string }) => void>; }
    private listeners: { [K in keyof T]?: Array<(payload: T[K]) => void> } = {};

    // K 宣告在「方法」上而不是類別上：同一個 emitter 要能處理多個不同事件，
    // 每次呼叫 on 時 K 才被決定成這次訂閱的那一個事件名
    on<K extends keyof T>(event: K, listener: (payload: T[K]) => void): void {
      // ??= 是「不存在才指定」：第一次訂閱時先建立空陣列，再把監聽器推進去
      (this.listeners[event] ??= []).push(listener);
    }

    // event 與 payload 共用同一個 K，兩者型別因此被綁死：
    // 選了 "login"，payload 就必須是 T["login"]
    emit<K extends keyof T>(event: K, payload: T[K]): void {
      // ?. 是因為該事件可能一個訂閱者都沒有（欄位是選填的，值可能是 undefined）
      this.listeners[event]?.forEach((listener) => listener(payload));
    }
  }

  // 用 type（而非 interface）才能滿足 Record<string, unknown> 的索引簽章約束
  interface AppEventsBad {
    login: { userId: number };
  }
  // new EventEmitter<AppEventsBad>();
  // ❌ interface 沒有索引簽章，不滿足 Record<string, unknown> 的約束

  type AppEvents = {
    login: { userId: number };
    logout: { userId: number; reason: string };
  };

  const emitter = new EventEmitter<AppEvents>();

  // 訂閱：K 被推斷成 "login"，所以 payload 自動是 { userId: number }，不用手動標註
  emitter.on("login", (payload) => console.log(`User ${payload.userId} logged in`));
  emitter.on("logout", (payload) =>
    console.log(`User ${payload.userId} logged out: ${payload.reason}`)
  );

  // 發佈：事件名與資料形狀都會被檢查
  emitter.emit("login", { userId: 1 });
  emitter.emit("logout", { userId: 1, reason: "timeout" });

  // emitter.emit("login", { reason: "x" }); // ❌ login 事件需要 { userId: number }
  // emitter.emit("logni", { userId: 1 });   // ❌ 事件名打錯，"logni" 不是 AppEvents 的鍵

  // 型別參數的分工：
  //   T 在類別上 → 整張事件表，new EventEmitter<AppEvents>() 時決定
  //   K 在方法上 → 這一次操作的是哪個事件，每次呼叫 on / emit 時決定
}

// ===== 練習 2 補充：為什麼事件表只能用 type，不能用 interface？ =====
// Record<string, unknown> 展開就是 { [key: string]: unknown }，
// 意思是「不管用哪個字串當鍵去存取，都必須取得到一個 unknown」。
// 編譯器要放行，必須先確定「這個型別的屬性就這些，不會再多」。
{
  // interface 是「開放」的：同名 interface 可以在任何地方再宣告一次，欄位自動合併
  interface OpenConfig {
    port: number;
  }
  // 完全合法！這就是宣告合併（Declaration Merging），
  // 別的檔案、甚至別人的套件都能這樣追加欄位
  interface OpenConfig {
    host: string;
  }
  const open: OpenConfig = { port: 3000, host: "localhost" }; // 兩個欄位都在

  // 正因為隨時可能被追加欄位，編譯器無法保證現在看到的欄位就是全部，
  // 所以拒絕替 interface 推導出隱式索引簽章
  // const dict1: Record<string, unknown> = open;
  // ❌ Index signature for type 'string' is missing in type 'OpenConfig'

  // type 別名是「封閉」的：宣告即定案，同名再宣告會直接報「重複識別符」
  type ClosedConfig = { port: number; host: string };
  const closed: ClosedConfig = { port: 3000, host: "localhost" };
  const dict2: Record<string, unknown> = closed; // ✅ 通過

  console.log("練習 2 補充 interface vs type:", open.host, dict2.port);

  // 解法：interface 自己補上明確的索引簽章 —— 能過，但通常不建議，
  // 補了之後任何字串鍵都變合法，打錯鍵名反而不會報錯，等於自廢武功
  interface WithIndex {
    [key: string]: unknown;
    login: { userId: number };
  }
  const withIndex: WithIndex = { login: { userId: 1 } };
  const dict3: Record<string, unknown> = withIndex; // ✅
  console.log("練習 2 補充 明確索引簽章:", dict3.login, withIndex.anyKeyIsFine);
}

// ===== 練習 3：泛型約束 merge =====
{
  function merge<T extends object, U extends object>(a: T, b: U): T & U {
    // 練習參考解答
    return { ...a, ...b };
  }

  const merged = merge({ name: "Gary" }, { age: 30 });
  console.log("練習 3 merge:", merged.name, merged.age);
}

console.log("第 6 章 泛型 範例載入完成 ✅");

export {};
