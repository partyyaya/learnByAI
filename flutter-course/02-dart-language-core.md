# 第 02 章：Dart 語言核心

> Flutter 用 Dart 寫。如果你會任何一種 C 系語言（JavaScript / Java / Kotlin / Swift），Dart 的 80% 你一看就懂。
> 這一章我們**只挑「寫 Flutter 一定會用到、而且容易踩雷」的部分**深入講：null safety、async/Future/Stream、類別與 mixin、集合語法。
> 純語法的細節（迴圈、運算子）我們快速帶過，把篇幅留給「會影響你 debug 的關鍵概念」。

---

## 2.1 變數宣告：`var` / `final` / `const` 的差別

```dart
var name = 'Flutter';     // 型別自動推斷為 String，值可以再改
String city = 'Taipei';   // 明確標型別
final age = 30;           // 「只能賦值一次」，之後不能改
const pi = 3.14159;       // 「編譯期常數」，比 final 更嚴格

name = 'Dart';            // ✅ OK，var 可變
// age = 31;              // ❌ 編譯錯誤，final 不可再賦值
```

`final` 和 `const` 是 Flutter 新手最常搞混的，講清楚：

- **`final`**：「執行期常數」——值在**執行到那一行時**才確定，但確定後不能改。例如 `final now = DateTime.now();` 合法，因為時間是跑到那行才知道。
- **`const`**：「編譯期常數」——值在**編譯時就要能算出來**，所以 `const now = DateTime.now();` 會報錯（編譯時還不知道現在幾點）。

**為什麼這在 Flutter 超重要？** 因為 Widget 大量用 `const`：

```dart
const Text('Hello')   // 這個 Widget 永遠長一樣 → 用 const
```

當一個 Widget 標成 `const`，Flutter **在重繪時可以直接跳過它**（因為它不可能變），這是重要的效能優化。所以實務心法是：**能加 `const` 就加 `const`**（編輯器的 lint 也會提醒你）。

**心智模型**：`var`＝會變的；`final`＝設定一次就定終身；`const`＝編譯時就刻死、且 Flutter 可拿來省效能。

---

## 2.2 Null Safety：Dart 最該先搞懂的特性

Dart 是 **null-safe** 語言：**預設情況下，變數不能是 null**。這個設計幫你在編譯期擋掉大量「呼叫了 null 的東西」的 crash（就是惡名昭彰的 `NullPointerException`）。

```dart
String a = 'hi';
// a = null;        // ❌ 編譯錯誤：String 不允許 null

String? b = 'hi';   // 加上 ? 代表「這個可以是 null」
b = null;           // ✅ OK
```

逐段解釋這些 null 相關符號（**每個你都會天天用**）：

```dart
String? name;                  // ? : 可空型別，預設值就是 null

int len = name?.length ?? 0;   // ?. 與 ?? 連用
```

- **`?`（可空型別）**：`String?` 表示「字串或 null」。沒加 `?` 的型別就保證不是 null。
- **`?.`（安全呼叫）**：`name?.length`＝「如果 name 不是 null 才取 length，否則整段結果是 null」。避免對 null 取屬性而爆炸。
- **`??`（null 合併）**：`x ?? y`＝「x 不是 null 就用 x，否則用 y」。上面整行：name 是 null 時，`name?.length` 是 null，於是 `?? 0` 讓 `len` 變成 0。

```dart
String? maybe = fetchName();
print(maybe!.toUpperCase());   // ! : 「我跟你保證它不是 null」
```

- **`!`（非空斷言）**：強制告訴編譯器「這裡絕對不是 null，放行」。**但這是把雙面刃**——如果你保證錯了、它真的是 null，執行期就會 crash。**初學者請少用 `!`**，多用 `?.` / `??` 或先做 null 檢查。

```dart
late String token;             // late : 「我晚點才給值，但保證用之前一定有給」

void init() {
  token = loadToken();         // 之後才賦值
}
```

- **`late`**：用在「宣告時還沒值，但用之前一定會賦值」的情況。常見於需要在 `initState`（第 03 章）裡才初始化的變數。**風險**：如果你在賦值前就讀它，會直接 crash。

**心智模型**：把 `?` 想成「這個盒子可能是空的」，編譯器會逼你每次打開前先確認「空不空」。這很煩，但它把「半夜 crash」變成「寫程式當下的紅字」，是非常值得的交換。

---

## 2.3 函式：具名參數是 Flutter 的日常

Dart 函式本身很普通，但 **Flutter 大量使用「具名參數（named parameters）」**，這點一定要熟，因為你建立每個 Widget 都在用它。

```dart
// 一般位置參數（positional）
int add(int a, int b) {
  return a + b;
}

// 箭頭函式：單一表達式可省略 { return ... }
int addArrow(int a, int b) => a + b;
```

**具名參數**——這是重點：

```dart
// 參數用 { } 包起來，呼叫時要寫參數名
void createUser({required String name, int age = 18, String? email}) {
  print('$name, $age, $email');
}

// 呼叫：用「名稱: 值」，順序可任意
createUser(name: 'Amy', age: 25);
createUser(age: 30, name: 'Bob');     // 順序換了也行
// createUser(age: 30);               // ❌ name 是 required，沒給會報錯
```

逐段解釋：

- **`{ }` 包住的參數**＝具名參數，呼叫時必須寫出參數名（`name: 'Amy'`）。
- **`required`**：標記「這個具名參數一定要給」。沒給會編譯錯誤。
- **`age = 18`**：預設值。沒傳 `age` 時就用 18。
- **`String? email`**：可空又沒預設值的具名參數，不傳就是 null。

**為什麼 Flutter 愛用具名參數？** 因為一個 Widget 動輒十幾個設定（顏色、邊距、對齊、事件…），如果用位置參數，你會看到 `Container(true, 16, null, Colors.red, ...)` 完全看不懂。具名參數讓呼叫處自我說明：

```dart
Container(
  width: 100,
  height: 50,
  color: Colors.blue,
  child: Text('hi'),
)   // 每個值是什麼一目了然
```

**這就是為什麼你看 Flutter 程式碼，全都是 `參數名: 值` 的形式。**

---

## 2.4 集合：List / Map / Set 與好用語法糖

```dart
// List（陣列）
List<int> nums = [1, 2, 3];
var names = <String>['Amy', 'Bob'];   // <String> 指定元素型別

// Map（鍵值對，類似 JS 的物件 / 字典）
Map<String, int> ages = {'Amy': 25, 'Bob': 30};
print(ages['Amy']);                   // 25

// Set（不重複集合）
Set<int> unique = {1, 2, 2, 3};       // 自動去重 → {1, 2, 3}
```

Flutter 寫 UI 時，這幾個語法糖**超常用**，務必認得：

```dart
// 1) spread 展開運算子 ...
var a = [1, 2];
var b = [0, ...a, 3];          // → [0, 1, 2, 3]

// 2) collection-if：在 list 裡根據條件決定要不要放某個元素
var widgets = [
  Text('總是顯示'),
  if (isLoggedIn) Text('登入後才顯示'),   // 條件成立才放進去
];

// 3) collection-for：在 list 裡用迴圈生成元素
var items = [for (var n in nums) Text('第 $n 項')];
```

逐段解釋為什麼這在 Flutter 很關鍵：

- 建 UI 時，`children: [...]` 裡常需要「依條件顯示某元件」或「用資料陣列生成一排元件」。
- **`if (條件) Widget`** 讓你**直接在 children 陣列裡**寫條件，不用先建空陣列再 `if { list.add(...) }`，程式碼乾淨很多。
- **`for (...) Widget`** 讓你把一個資料 List 直接「map」成一排 Widget。這比寫 `.map().toList()` 在某些情境更直覺（兩種都會看到）。

---

## 2.5 類別、建構子與你會遇到的變化型

```dart
class User {
  final String name;
  final int age;

  // 一般建構子：this.xxx 直接把參數賦值給欄位
  User(this.name, this.age);

  // 具名建構子：給「另一種建立方式」一個名字
  User.guest() : name = '訪客', age = 0;

  // 方法
  String greet() => 'Hi, I am $name';
}

void main() {
  var u1 = User('Amy', 25);
  var u2 = User.guest();          // 用具名建構子
  print(u1.greet());
}
```

逐段解釋：

- **`User(this.name, this.age);`**：Dart 的簡寫——`this.name` 直接表示「把這個參數的值存進 `name` 欄位」，不用再寫 `name = name`。
- **具名建構子 `User.guest()`**：同一個類別可以有多種「建立方式」，每種給個名字。`: name = '訪客', age = 0` 是 initializer list（在建構子本體執行前初始化 final 欄位）。
- 實務上你會大量用具名建構子的形式，例如 `User.fromJson(json)`（從 API 回來的 JSON 建物件，第 08 章會寫）。

**`factory` 建構子**（進階一點，但 API 串接會用到）：

```dart
class User {
  final String name;
  User(this.name);

  // factory：可以「不一定要 new 一個新的」，能回傳快取的、或做轉換邏輯
  factory User.fromJson(Map<String, dynamic> json) {
    return User(json['name'] as String);
  }
}
```

- **`factory`** 跟一般建構子差在：一般建構子一定回傳「全新實例」，`factory` 可以自己決定回傳什麼（例如回傳已存在的快取物件，或做完邏輯再回傳）。
- 最常見用途就是 `fromJson`：把 API 回來的 `Map`（解析 JSON 得到的）轉成你的物件。第 08 章我們會用工具自動生成這段。

---

## 2.6 繼承、抽象類別與 Mixin

```dart
// 抽象類別：不能直接 new，定義「子類別必須實作什麼」
abstract class Animal {
  void makeSound();              // 沒有實作，逼子類別自己寫
  void breathe() => print('呼吸');// 有預設實作
}

class Dog extends Animal {
  @override
  void makeSound() => print('汪汪');   // 必須實作
}
```

- **`abstract`**：定義「規格」，不能直接建立實例。子類別 `extends` 它就必須補上沒實作的方法。
- **`@override`**：標記「我在覆寫父類別的方法」。加上它，萬一你打錯方法名，編譯器會提醒你。

**Mixin（混入）**——這個 Dart 特色你在 Flutter 會遇到：

```dart
mixin Swimmer {
  void swim() => print('游泳');
}

mixin Flyer {
  void fly() => print('飛');
}

// 一個類別可以 with 多個 mixin，把它們的能力「混進來」
class Duck extends Animal with Swimmer, Flyer {
  @override
  void makeSound() => print('呱呱');
}

void main() {
  Duck()..swim()..fly()..makeSound();   // 鴨子會游也會飛
}
```

- **`mixin`**：一包「可以被混進別人」的能力。Dart 不支援多重繼承（一個類別只能 `extends` 一個父類別），但可以 `with` 多個 mixin 來「組合多種能力」。
- 在 Flutter 你會看到像 `with SingleTickerProviderStateMixin`（做動畫時提供時間訊號）這種寫法——那就是把動畫所需的能力混進你的 State 類別。
- **`..`（cascade 串接）**：`Duck()..swim()..fly()` 表示「在同一個物件上連續呼叫多個方法」，不用一直寫 `duck.`。

---

## 2.7 非同步：Future 與 async / await（重中之重）

App 一定會做「要等一下」的事：打 API、讀檔、查資料庫。這些都是**非同步**操作，Dart 用 `Future` 表達。

**心智模型**：`Future<T>` ＝「一張未來會兌現成 T 的提貨單」。現在給你單子，東西之後才到。（等同 JS 的 `Promise`。）

```dart
// 一個會「等 2 秒才回傳結果」的非同步函式
Future<String> fetchUserName() async {
  await Future.delayed(Duration(seconds: 2));   // 模擬網路延遲
  return 'Amy';
}
```

逐段解釋：

- **`Future<String>`**：回傳型別。代表「現在先回你一張單子，未來會兌現成一個 String」。
- **`async`**：標記這是非同步函式。**只有標了 `async` 的函式裡才能用 `await`。**
- **`await Future.delayed(...)`**：`await` ＝「在這裡等它完成，拿到結果再往下」。`Future.delayed` 模擬「等 2 秒」。

怎麼用它：

```dart
Future<void> loadData() async {
  print('開始載入');
  String name = await fetchUserName();   // 在這等 2 秒，拿到 'Amy'
  print('載入完成：$name');
}
```

- **`await fetchUserName()`**：程式會在這行「暫停」，等 Future 兌現，把結果（`'Amy'`）拿出來給 `name`。但**它不會卡住整個 App**——UI 仍然能動、能捲動，這就是非同步的好處。
- **沒有 `await` 會怎樣？** 如果寫 `String name = fetchUserName();` 會型別錯誤（你拿到的是 `Future<String>` 不是 `String`）。忘記 `await` 是新手常見 bug：你以為拿到資料了，其實手上是一張還沒兌現的單子。

**錯誤處理**——API 會失敗，一定要會：

```dart
Future<void> loadData() async {
  try {
    String name = await fetchUserName();
    print('成功：$name');
  } catch (e) {
    print('失敗：$e');               // 網路錯誤、解析錯誤都會被接到這
  } finally {
    print('不管成功失敗都會跑這');     // 例如關掉 loading 圈圈
  }
}
```

- **`try / catch / finally`**：跟其他語言一樣。`await` 的操作若丟出例外，會被 `catch` 接住。第 08 章串 API 時，這是標配。

---

## 2.8 Stream：多次回傳的非同步（Future 的「連續版」）

`Future` 只兌現**一次**。但有些東西會「持續產生多個值」：例如 WebSocket 訊息、感測器讀數、資料庫的即時查詢結果。這時用 **`Stream`**。

**心智模型**：
- `Future<T>`＝「一次性的提貨單」（餐廳出一道菜給你）。
- `Stream<T>`＝「一條輸送帶」（壽司店的迴轉帶，菜會一個接一個來）。

```dart
// 一個每秒吐一個數字、共吐 3 次的 Stream
Stream<int> countStream() async* {     // async* 代表這是會產生 stream 的函式
  for (int i = 1; i <= 3; i++) {
    await Future.delayed(Duration(seconds: 1));
    yield i;                           // yield = 「往輸送帶放一個值」
  }
}

Future<void> listen() async {
  await for (final n in countStream()) {  // await for = 一個一個接收
    print('收到：$n');                    // 每秒印一次：1, 2, 3
  }
}
```

逐段解釋：

- **`async*`**（注意有星號）：標記「這是產生 Stream 的函式」。
- **`yield`**：把一個值「丟上輸送帶」。每 `yield` 一次，監聽端就收到一個值。
- **`await for (final n in ...)`**：訂閱這條 stream，每來一個值就跑一次迴圈。

你也會看到用 `.listen()` 的寫法：

```dart
final sub = countStream().listen(
  (n) => print('收到 $n'),        // 每個值
  onError: (e) => print('錯誤 $e'),
  onDone: () => print('結束'),
);
// sub.cancel();                  // 不需要時要取消訂閱，避免記憶體洩漏
```

**為什麼 Flutter 開發者一定要懂 Stream？** 因為：
1. Flutter 內建的 `StreamBuilder`（第 04 章）可以「自動跟著 stream 重繪畫面」。
2. 第 06 章的 Riverpod、第 09 章的 Drift 資料庫即時查詢，底層都建立在 Stream 上。
3. 很多套件（FCM 推播、藍牙、定位）都用 Stream 回傳連續事件。

現在不用精通，但要建立「Future 是一次、Stream 是多次」這個直覺。

---

## 2.9 一個你天天看到的細節：cascade 與箭頭

```dart
// cascade ..：對同一物件連續操作，省略重複的變數名
final paint = Paint()
  ..color = Colors.red
  ..strokeWidth = 4
  ..style = PaintingStyle.stroke;
// 等同於：paint.color=...; paint.strokeWidth=...; paint.style=...;

// 箭頭 => ：函式 body 只有一個表達式時的簡寫
onPressed: () => print('按了'),
```

- **`..`**：讀作「在這個物件上再做…」。連續設定一個物件的多個屬性時很常見。
- **`() => 表達式`**：匿名函式的簡寫。Flutter 的事件回呼（`onPressed`、`onTap`）幾乎都長這樣。

---

## 2.10 動手練習

1. 寫一個 `Future<int> sum(int a, int b)`，等 1 秒後回傳 `a + b`，用 `await` 印出結果。
2. 把上面的 `sum` 改成「a 或 b 是負數就 throw 例外」，用 `try/catch` 接住並印出錯誤訊息。
3. 寫一個 `User` 類別，含 `name`、`age`、一個 `User.fromJson(Map)` 的 factory 建構子，從 `{'name': 'Amy', 'age': 25}` 建出物件。
4. 用 collection-for 把 `[1,2,3,4,5]` 變成 `['#1','#2',...]` 的字串 List。

---

## 小結

- `var`（可變）/ `final`（設定一次）/ `const`（編譯期常數，Flutter 拿來省效能，能加就加）。
- Null safety：`?`（可空）、`?.`（安全呼叫）、`??`（給預設值）、`!`（強制非空，少用）、`late`（晚點賦值）。
- Flutter 大量用**具名參數** `name: value` 與 `required`——這就是你看到的每個 Widget 的樣子。
- 集合語法糖：`...` 展開、`if`/`for` 直接寫在 list 裡，建 UI 超常用。
- 類別：`this.x` 簡寫、具名建構子、`factory`（常用於 `fromJson`）、`mixin`（用 `with` 組合能力）。
- **非同步是重點**：`Future`＝一次性提貨單（`async`/`await`/`try-catch`）；`Stream`＝連續輸送帶（`async*`/`yield`/`await for`）。

---

> 語言基礎齊了。下一章進入 Flutter 的靈魂：Widget。我們會解開「一切皆 Widget」「三棵樹」「為什麼 setState 能高效更新」這些核心謎題。
> 前往 [第 03 章：Widget 思維與 UI 基礎](./03-widget-thinking-and-ui-basics.md)。
