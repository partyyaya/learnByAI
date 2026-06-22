# 第 06 章：狀態管理（Riverpod）

> 這是本課最重要的章節之一。前面 `setState` 只能管「一個 Widget 內部」的狀態，但真實 App 的狀態要**跨頁面共用**（登入資訊、購物車、主題）。
> 我們會先看清 `setState` 的極限與「狀態提升、prop drilling」的痛，理解為什麼需要狀態管理，再進入本課主線 **Riverpod**——並說明它為什麼勝過 Provider、跟 Bloc 怎麼選。

---

## 6.1 先確認痛點：`setState` 撐不住什麼？

`setState` 很好，但它有個硬限制：**狀態被關在某個 State 物件裡，只有那個 Widget 自己能用。**

想像購物車：右上角的「購物車數量」在 A 頁，加入購物車的按鈕在 B 頁的商品詳情。它們是不同的 Widget，`setState` 改不了對方。

新手會嘗試兩種「土法」，但都會踩坑：

**土法一：狀態提升（lifting state up）+ 一路往下傳**

```dart
// 把購物車狀態提到最上層，再用 callback / 參數一層層傳下去
HomePage(cart: cart, onAdd: addToCart)
  → ProductList(cart: cart, onAdd: onAdd)
    → ProductCard(onAdd: onAdd)              // 傳了 3 層才用到
```

- 這就是惡名昭彰的 **prop drilling（屬性鑽透）**：中間那些 Widget 根本用不到 `onAdd`，只是被迫當「傳聲筒」一層層往下遞。
- 加一個新狀態，就要改沿途每一層的建構子。**難維護、易出錯。**

**土法二：丟全域變數**——狀態好存取了，但「資料變了畫面不會自動更新」（沒人通知 Flutter 重建），而且無法追蹤誰改了它。

**所以我們需要一套機制，同時解決三件事**：

1. **任何 Widget 都能直接拿到共用狀態**（不用一層層傳）。
2. **狀態變了，用到它的 Widget 自動重建**（不用手動 setState）。
3. **狀態與 UI 解耦、好測試**（邏輯不卡在 Widget 裡）。

這就是「狀態管理框架」的工作。

---

## 6.2 為什麼選 Riverpod？（順便交代演進）

Flutter 狀態管理的演進，可以看成「一條解決 prop drilling 的路」：

| 方案 | 核心做法 | 痛點 |
|------|---------|------|
| `setState` | Widget 內部狀態 | 不能跨 Widget 共用 |
| `InheritedWidget`（內建） | 祖先把資料放樹上，子孫用 `context` 拿 | 樣板碼多、手寫很痛 |
| **Provider** | 把 InheritedWidget 包好用 | 依賴 `context`、執行期才報錯、巢狀多 |
| **Riverpod** | Provider 作者的重新設計 | （本課選它） |

**Riverpod 相對 Provider 的關鍵升級**（Riverpod 是同一作者，名字就是 Provider 的字母重組）：

- **編譯期安全**：拿錯 provider 在**寫程式時**就報錯，不是跑到一半 crash。
- **不依賴 `BuildContext`**：可以在沒有 context 的地方（純 Dart 邏輯、其他 provider 裡）取用狀態，超好測試。
- **可組合**：一個 provider 可以「watch」另一個 provider，自動形成依賴鏈、自動更新。

**那 Bloc 呢？** Bloc 是另一大主流，走「事件（Event）→ 狀態（State）」的嚴謹事件流，適合超大型團隊、需要嚴格可追溯的場景，但**樣板碼較多、學習曲線較陡**。本課選 Riverpod 是因為它在「好上手」與「夠強大」之間最平衡。觀念通了，之後要轉 Bloc 也不難（兩者都是「把狀態抽離 Widget」）。

> 本課用 **Riverpod 2.x + 程式碼產生（code generation）** 的現代寫法（`@riverpod` 註解）。它比舊的手寫 `StateProvider`/`StateNotifierProvider` 更簡潔、更不易錯，是官方現在推薦的方向。

---

## 6.3 安裝與初始化

```bash
flutter pub add flutter_riverpod riverpod_annotation
flutter pub add --dev riverpod_generator build_runner riverpod_lint custom_lint
```

逐段解釋這幾個套件：

- **`flutter_riverpod`**：Riverpod 本體（含 Widget 整合）。
- **`riverpod_annotation`**：提供 `@riverpod` 註解。
- **`riverpod_generator` + `build_runner`**：程式碼產生器。你寫 `@riverpod`，它幫你產生底層樣板碼（dev 依賴，不進正式包）。
- **`riverpod_lint` + `custom_lint`**：額外的 lint 規則，會提醒你 Riverpod 的常見錯誤。

**第一步：用 `ProviderScope` 包住整個 App**

```dart
void main() {
  runApp(
    const ProviderScope(          // ⭐ 所有 provider 的「儲存空間」
      child: MyApp(),
    ),
  );
}
```

- **`ProviderScope`**：Riverpod 的根容器，**所有狀態都存在這裡面**。少了它，任何 provider 都用不了。把它放在最外層包住整個 App 即可。

**程式碼產生的指令**（之後寫 `@riverpod` 都要跑）：

```bash
# 跑一次
dart run build_runner build --delete-conflicting-outputs

# 開發時持續監聽、自動重跑（推薦開著）
dart run build_runner watch --delete-conflicting-outputs
```

- 你寫 `@riverpod` 的檔案旁邊會生出一個 `xxx.g.dart`（自動產生，別手改、要進版控）。
- `watch` 模式會在你存檔時自動重新產生，開著它開發最順。

---

## 6.4 核心概念三件套：Provider、ref、Consumer

Riverpod 只有三個核心名詞，先建立全貌：

```text
1. Provider  = 「一個狀態的來源」（定義狀態怎麼產生、怎麼變）
2. ref       = 「取用 provider 的遙控器」（讀它、監聽它、操作它）
3. Consumer  = 「會跟著 provider 重建的 Widget」（狀態變→它自動刷新）
```

我們從最簡單的「唯讀狀態」開始。

### 最簡單：一個唯讀的 Provider

```dart
// greeting_provider.dart
import 'package:riverpod_annotation/riverpod_annotation.dart';

part 'greeting_provider.g.dart';     // 指向自動產生的檔案

@riverpod
String greeting(GreetingRef ref) {   // 函式名 greeting → 產生 greetingProvider
  return 'Hello Riverpod';
}
```

逐段解釋：

- **`part 'greeting_provider.g.dart';`**：宣告「自動產生的程式碼是這個檔案的一部分」。檔名規則固定是「原檔名 + `.g.dart`」。
- **`@riverpod`**：告訴產生器「幫這個函式做一個 provider」。
- **`String greeting(GreetingRef ref)`**：函式回傳值（`String`）就是這個 provider 的狀態。`ref` 是 Riverpod 自動給的遙控器（用來在裡面取用別的 provider）。
- **產生結果**：build_runner 會生出一個叫 `greetingProvider` 的東西（函式名首字母大寫前綴 + Provider）給你在 UI 用。

### 在 UI 取用：ConsumerWidget

```dart
class GreetingPage extends ConsumerWidget {       // 注意：ConsumerWidget，不是 StatelessWidget
  const GreetingPage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {   // 多了一個 ref 參數
    final text = ref.watch(greetingProvider);            // 監聽 provider
    return Scaffold(body: Center(child: Text(text)));
  }
}
```

逐段解釋（這是 Riverpod 在 UI 端的標準形狀）：

- **`ConsumerWidget`**：取代 `StatelessWidget`。差別就是它的 `build` 多給你一個 **`WidgetRef ref`**。
- **`ref.watch(greetingProvider)`**：**監聽**這個 provider 的值。「監聽」的意思是——**當這個 provider 的值變了，這個 Widget 會自動重建**。這就取代了手動 `setState`！
- **心智模型**：`ref.watch` ＝「我要訂閱這個狀態，它一變就通知我重畫」。這跟第 03 章「事件→setState→重建」的閉環一樣，只是「通知重建」這件事改由 Riverpod 自動處理了。

---

## 6.5 可變狀態：Notifier（最常用的主力）

唯讀沒意思，真實狀態要能改。用 `Notifier`（搭配 `@riverpod`）：

```dart
// counter_provider.dart
import 'package:riverpod_annotation/riverpod_annotation.dart';
part 'counter_provider.g.dart';

@riverpod
class Counter extends _$Counter {        // 繼承自動產生的 _$Counter
  @override
  int build() => 0;                      // 初始狀態：0

  void increment() => state++;           // 改狀態：直接賦值 state
  void decrement() => state--;
  void reset() => state = 0;
}
```

逐段解釋（這是可變狀態的標準寫法，要記熟）：

- **`class Counter extends _$Counter`**：`_$Counter` 是產生器生出來的基底類別。你只要 `extends` 它。
- **`int build() => 0;`**：定義「初始狀態」。回傳型別 `int` 就是這個狀態的型別。
- **`state`**：這是基底類別提供的「目前狀態」。**改它就等於改狀態**——`state++`、`state = 新值`。
- **關鍵**：你**不需要呼叫 setState**。只要改了 `state`，Riverpod 自動通知所有 `watch` 這個 provider 的 Widget 重建。**這就是 Riverpod 取代 setState 的方式。**

在 UI 用它：

```dart
class CounterPage extends ConsumerWidget {
  const CounterPage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final count = ref.watch(counterProvider);            // 監聽「值」→ 變了就重建
    final controller = ref.read(counterProvider.notifier); // 拿「操作物件」來呼叫方法

    return Scaffold(
      body: Center(child: Text('$count', style: const TextStyle(fontSize: 48))),
      floatingActionButton: Row(
        mainAxisAlignment: MainAxisAlignment.end,
        children: [
          FloatingActionButton(
            onPressed: () => controller.increment(),     // 呼叫方法改狀態
            child: const Icon(Icons.add),
          ),
          const SizedBox(width: 8),
          FloatingActionButton(
            onPressed: () => controller.decrement(),
            child: const Icon(Icons.remove),
          ),
        ],
      ),
    );
  }
}
```

**這裡有個超重要的區分：`ref.watch` vs `ref.read`vs `ref.listen`**：

- **`ref.watch(xxxProvider)`**：取**值**並**訂閱**。值變了 → Widget 重建。**用在 build 裡讀要顯示的資料。**
- **`ref.read(xxxProvider.notifier)`**：取**操作物件**（那個 Notifier 類別），用來**呼叫方法**（`increment()`）。`read` 是「讀一次、不訂閱」，所以**用在事件回呼裡**（onPressed）改狀態——你不希望「按按鈕」這個動作本身觸發重建。
- **`ref.listen(xxxProvider, (prev, next) {...})`**：**監聽變化做副作用**，但不重建畫面。用在「狀態變了要彈出 SnackBar、要導頁」這種情境（下面會用）。

**心智模型**：
- `watch` ＝「我要看著它，它變我就跟著變」（放 build）。
- `read` ＝「我只是要拿它來操作一下」（放 onPressed）。
- `listen` ＝「它變的時候叫我一聲，我去做點別的事（彈窗/導頁），但畫面不用重畫」。

> ⚠️ 新手第一大坑：**在 `onPressed` 裡用 `watch`**，或**在 `build` 裡用 `read` 拿值**。記住口訣：**build 裡 watch 值、回呼裡 read notifier**。

---

## 6.6 非同步狀態：AsyncNotifier 與 AsyncValue（串 API 的核心）

真實 App 的狀態大多來自 API（要等、會失敗）。Riverpod 用 `AsyncValue` 優雅地表達「載入中 / 成功 / 失敗」三態。

```dart
// user_provider.dart
@riverpod
Future<User> currentUser(CurrentUserRef ref) async {
  final repo = ref.watch(userRepositoryProvider);   // 取得資料來源（第 10 章會建）
  return repo.fetchUser();                           // 回傳 Future，Riverpod 自動包成 AsyncValue
}
```

- 這個 provider 回傳 `Future<User>`。Riverpod 會**自動**把它包裝成 `AsyncValue<User>`，幫你管理「載入中、有資料、出錯」三種狀態。

在 UI 端，用 `AsyncValue.when` 一次處理三態：

```dart
class UserPage extends ConsumerWidget {
  const UserPage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final AsyncValue<User> userAsync = ref.watch(currentUserProvider);

    return Scaffold(
      body: userAsync.when(
        loading: () => const Center(child: CircularProgressIndicator()),  // 載入中：轉圈
        error: (err, stack) => Center(child: Text('出錯了：$err')),         // 失敗：顯示錯誤
        data: (user) => Center(child: Text('Hi, ${user.name}')),          // 成功：顯示資料
      ),
    );
  }
}
```

逐段解釋（**這是 Flutter 串 API 最常用、最優雅的模式，務必記熟**）：

- **`AsyncValue<User>`**：一個「三選一」的容器——它要嘛在載入、要嘛有資料、要嘛有錯誤。
- **`.when(loading, error, data)`**：強迫你**把三種狀態都處理掉**。這從根本上避免了新手最常見的兩個 bug：「忘了做 loading 轉圈」「API 失敗整個白畫面/crash」。
- **心智模型**：`AsyncValue.when` ＝「資料的紅綠燈」。Riverpod 逼你紅燈（error）、黃燈（loading）、綠燈（data）都想好畫面，不能只寫綠燈。

**重新整理資料（pull to refresh / 重抓）**：

```dart
// 讓 provider 重新執行（重新打 API）
onRefresh: () => ref.invalidate(currentUserProvider),
```

- **`ref.invalidate(provider)`**：把該 provider「作廢」，下次有人 watch 它就會重新執行 `build`（重新抓資料）。下拉重整就用它。

---

## 6.7 帶參數的 Provider：family

「商品詳情」需要依 `id` 抓不同商品。同一個 provider「依參數產生不同實例」，用 family（在 code-gen 寫法裡，就是給函式加參數）：

```dart
@riverpod
Future<Product> product(ProductRef ref, String id) async {   // 多一個 id 參數
  final repo = ref.watch(productRepositoryProvider);
  return repo.fetchProduct(id);
}
```

UI 取用時把參數帶進去：

```dart
final productAsync = ref.watch(productProvider('42'));   // id=42 一個實例，id=99 另一個
```

逐段解釋：

- **加參數 `String id`**：讓這個 provider 變成「家族（family）」——`productProvider('42')` 和 `productProvider('99')` 是**兩個獨立的狀態**，各自快取、各自更新。
- 這完美對應「列表點哪一筆 → 詳情頁抓那一筆」的需求（搭配第 05 章的路徑參數 `:id`）。

---

## 6.8 Provider 之間的組合與自動釋放

### 一個 Provider 依賴另一個

```dart
@riverpod
int cartItemCount(CartItemCountRef ref) {
  final cart = ref.watch(cartProvider);     // 監聽購物車 provider
  return cart.items.length;                 // 購物車變 → 這個數量自動重算 → UI 自動更新
}
```

- **`ref.watch(另一個 provider)`**：在一個 provider 裡監聽另一個，形成**依賴鏈**。購物車內容一變，`cartItemCount` 自動重算，watch 它的「右上角數字」自動更新。
- 這就是 6.1 那個「購物車跨頁面」痛點的乾淨解法：B 頁 `cartProvider.notifier` 加商品 → A 頁右上角 watch `cartItemCount` 自動更新，**中間完全不用傳參數**。prop drilling 消失了。

### autoDispose：用完自動回收

code-gen 的 `@riverpod` **預設就是 autoDispose**——當沒有任何 Widget 在 watch 某個 provider 時，它的狀態會被自動清掉，回收記憶體。

```dart
@Riverpod(keepAlive: true)            // 想「常駐不回收」才這樣標（例如登入資訊）
class Auth extends _$Auth { /* ... */ }
```

- **預設（autoDispose）**：適合「進某頁才需要、離開就該丟」的狀態（商品詳情、搜尋結果）。
- **`keepAlive: true`**：適合「整個 App 生命週期都要在」的狀態（登入資訊、主題設定）。

**心智模型**：autoDispose ＝「沒人看就關燈省電」。需要常亮的（登入狀態）才設 keepAlive。

---

## 6.9 副作用：狀態變了要彈窗 / 導頁（ref.listen）

回到 6.5 的 `ref.listen`。例如「登入成功後跳首頁、失敗彈錯誤」：

```dart
@override
Widget build(BuildContext context, WidgetRef ref) {
  // 監聽登入狀態的「變化」，做導頁/彈窗，但不重建畫面
  ref.listen(authProvider, (previous, next) {
    next.whenOrNull(
      data: (user) => context.go('/home'),                       // 登入成功 → 跳首頁
      error: (e, _) => ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('登入失敗：$e')),                    // 失敗 → 彈訊息
      ),
    );
  });

  return const LoginForm();
}
```

逐段解釋：

- **`ref.listen(provider, (prev, next) {...})`**：當 provider 從 `prev` 變成 `next` 時，跑這個回呼。**它不會觸發 Widget 重建**，純粹做副作用。
- **為什麼導頁/彈窗要用 listen 而不是 watch？** 因為導頁、彈 SnackBar 是「一次性動作」，不是「畫面的一部分」。如果寫在 build 裡（用 watch），重建時會重複觸發，彈出一堆 SnackBar。**規則：畫面用 watch，一次性副作用用 listen。**

---

## 6.10 Riverpod vs Bloc vs Provider：一張表收尾

| 面向 | Provider | **Riverpod（本課）** | Bloc |
|------|----------|---------------------|------|
| 取用方式 | `context.watch<T>()` | `ref.watch(provider)` | `context.read<Bloc>()` + BlocBuilder |
| 編譯期安全 | 否（拿錯型別執行期才爆） | **是** | 部分 |
| 依賴 context | 是 | **否** | 是 |
| 樣板碼 | 中 | **少（code-gen）** | 多（Event/State 類別） |
| 非同步處理 | 自己接 | **AsyncValue 內建三態** | 需自行設計 state |
| 學習曲線 | 低 | **中** | 較高 |
| 適合 | 小專案 | **中大型、要好測試** | 大型團隊、嚴格事件流 |

**結論**：Riverpod 在「好上手」與「夠用於正式專案」之間最甜。它的 `AsyncValue` 讓串 API 特別舒服（第 08、10 章會大量用到）。

---

## 6.11 動手練習

1. 用 `@riverpod class Counter` 做計數器，UI 用 `ConsumerWidget` + `ref.watch`/`ref.read`，體會「沒有 setState 也能更新」。
2. 做一個 `themeMode` 的 Notifier（值是 `bool isDark`），一個按鈕切換，全 App 主題跟著變（先 watch 值印出來即可，真正套主題第 11 章做）。
3. 做一個 `cartProvider`（Notifier，狀態是 `List<String>`）能 add/remove，再做一個 `cartItemCount` provider watch 它，驗證「加商品 → 數量自動更新」。
4. 寫一個 `FutureProvider` 用 `Future.delayed` 模擬 API（2 秒後回傳一個字串），UI 用 `AsyncValue.when` 顯示 loading→data，並做一個按鈕 `ref.invalidate` 重新載入。

---

## 小結

- 狀態管理解決三件事：**跨 Widget 共用、變了自動更新、與 UI 解耦好測試**。`setState` 只能管單一 Widget。
- 本課用 **Riverpod 2.x + code-gen（`@riverpod`）**：編譯期安全、不依賴 context、可組合。
- 三件套：**Provider**（狀態來源）、**ref**（遙控器）、**Consumer**（會自動重建的 Widget）。
- 三個取用方法：**build 裡 `watch`（看值、訂閱重建）、回呼裡 `read(...notifier)`（拿來操作）、副作用用 `listen`（彈窗/導頁）**。
- 可變狀態用 `Notifier`：改 `state` 即自動通知重建，不用 setState。
- 非同步用 `AsyncValue` + `.when(loading/error/data)`——串 API 的黃金模式。
- `family`（帶參數）、`ref.watch` 組合 provider（解 prop drilling）、autoDispose（沒人看就回收）。

---

> 狀態會管了，下一章處理使用者輸入：表單、各種輸入框、即時驗證，並把表單狀態接上 Riverpod。
> 前往 [第 07 章：表單、輸入與驗證](./07-forms-input-validation.md)。
