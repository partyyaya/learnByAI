# 第 05 章：導航與路由（go_router）

> App 不會只有一頁。這一章讓你的 App「能換頁」：點商品 → 進詳情頁、點返回 → 回列表。
> 我們先理解 Flutter 內建的 `Navigator`（命令式），看清它的痛點，再升級到 **go_router**（宣告式路由）——這是現在 Flutter 社群與官方都推薦的方案，也是本課的主線。

---

## 5.1 先懂內建的 Navigator：頁面就是一疊卡片

Flutter 內建的導航模型是一個**堆疊（stack）**。把每個頁面想成一張卡片，疊在一起，你只看得到最上面那張：

```text
push 新頁  →  ┌─────────┐ ← 你現在看到的（最上面）
              │ 詳情頁   │
              ├─────────┤
              │ 列表頁   │
              ├─────────┤
              │ 首頁     │ ← 最早的，被蓋在底下
              └─────────┘
pop 回上頁 →  把最上面那張拿掉，露出下面那張
```

最基本的命令式操作：

```dart
// 進到新頁（往堆疊上「推」一張）
Navigator.push(
  context,
  MaterialPageRoute(builder: (context) => const DetailPage()),
);

// 回上一頁（把最上面那張「彈」掉）
Navigator.pop(context);
```

逐段解釋：

- **`Navigator.push`**：把新頁面「推」上堆疊。`MaterialPageRoute` 提供平台預設的轉場動畫（iOS 從右滑入、Android 淡入上移）。
- **`Navigator.pop`**：移除最上面的頁面，回到下面那張。手機的實體/手勢返回鍵也是觸發 pop。
- **`context`**：還記得第 03 章嗎？Navigator 也是靠 `context` 往上找到「最近的 Navigator」來操作。

**這套能用，但專案一大就出現痛點**：

1. **頁面路徑散落各處**：每個 `push` 都直接 new 一個頁面 Widget，整個 App 有哪些頁、路徑長怎樣，沒有一個地方總覽。
2. **深層連結（deep link）很難搞**：使用者點一個 `myapp://product/42` 的連結要直接進到商品 42，命令式做起來很痛。
3. **Web 網址列對不上**：跑在 Web 時，網址不會跟著頁面變。
4. **巢狀導航（底部 tab 各自有堆疊）麻煩**。

**這就是 go_router 要解決的**：把「全 App 有哪些路徑、各對應哪個頁面」集中宣告在一個地方，並原生支援 deep link 與網址同步。

---

## 5.2 安裝與最小設定

```bash
flutter pub add go_router
```

最小可跑的設定：

```dart
import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

// 1) 把所有路由集中宣告在這裡
final router = GoRouter(
  initialLocation: '/',                    // App 一開啟的路徑
  routes: [
    GoRoute(
      path: '/',                           // 路徑
      builder: (context, state) => const HomePage(),   // 對應的頁面
    ),
    GoRoute(
      path: '/settings',
      builder: (context, state) => const SettingsPage(),
    ),
  ],
);

// 2) 用 MaterialApp.router 接上 go_router
void main() {
  runApp(MyApp());
}

class MyApp extends StatelessWidget {
  @override
  Widget build(BuildContext context) {
    return MaterialApp.router(
      routerConfig: router,                // ⭐ 注意是 .router 版本
    );
  }
}
```

逐段解釋：

- **`GoRouter(routes: [...])`**：這就是「全 App 路由地圖」。一眼能看出有 `/`、`/settings` 兩條路徑、各對應哪個頁面。**這就是「宣告式」的精神：路由是一份可總覽的設定，不是散在各處的 push 呼叫。**
- **`GoRoute(path, builder)`**：一條路由。`path` 是網址形式的路徑，`builder` 回傳該路徑要顯示的頁面。
- **`state`**：`builder` 的第二個參數，裝著「這次導航的資訊」——路徑參數、查詢參數、傳遞的物件等（下面會用到）。
- **`MaterialApp.router(routerConfig: router)`**：注意**不是**第 01 章的 `MaterialApp(home: ...)`，而是 `.router` 版本，把 `GoRouter` 接上去。這樣 App 的導航就交給 go_router 管了。

---

## 5.3 切換頁面：`context.go` vs `context.push`

go_router 在 `context` 上加了好用的方法：

```dart
// 方式 A：go —— 「直接切換到這個路徑」（取代當前路由堆疊）
context.go('/settings');

// 方式 B：push —— 「在當前頁面上『疊』一個新頁」（保留返回）
context.push('/settings');
```

**這兩個的差別是新手最常困惑的，講清楚**：

- **`context.go('/x')`**：把整個導航狀態「設定成 `/x`」。常用於「切換主分頁」「登入後跳到首頁」這種「我要去那裡，不需要保留回頭路」的情境。
- **`context.push('/x')`**：在現有堆疊**上面再疊一頁**，所以會有返回鍵、能 `pop` 回來。常用於「列表 → 詳情」這種「看完要回去」的情境。

**心智模型**：
- `go` ＝「重新設定目的地」（像重新輸入網址）。
- `push` ＝「往前走一步，留著回頭路」（像點連結進子頁）。

返回：

```dart
context.pop();                  // 回上一頁
if (context.canPop()) context.pop();   // 先確認有沒有上一頁可回（避免空堆疊報錯）
```

---

## 5.4 傳參數：路徑參數與查詢參數

實務最常見：列表點某一筆 → 詳情頁要知道「是哪一筆」。go_router 用網址的方式傳。

### 路徑參數（path parameter）

```dart
GoRoute(
  path: '/product/:id',          // :id 是動態片段
  builder: (context, state) {
    final id = state.pathParameters['id']!;   // 取出 id
    return ProductDetailPage(productId: id);
  },
),
```

逐段解釋：

- **`/product/:id`**：`:id` 是「佔位符」，代表這段是變動的。`/product/42`、`/product/99` 都會match到這條路由。
- **`state.pathParameters['id']`**：把網址裡那段（`42`）取出來。它是 `String`，所以拿到後常要 `int.parse(id)` 轉型。
- 導航過去：

```dart
context.push('/product/42');                 // 寫死
context.push('/product/${product.id}');      // 用變數組路徑
```

### 查詢參數（query parameter）

適合「可選的、篩選/排序之類」的參數：

```dart
// 路由不用特別宣告 query，直接從 state 拿
GoRoute(
  path: '/search',
  builder: (context, state) {
    final keyword = state.uri.queryParameters['q'] ?? '';   // ?q=xxx
    final sort = state.uri.queryParameters['sort'] ?? 'new';
    return SearchPage(keyword: keyword, sort: sort);
  },
),

// 導航：用 ? 接查詢字串
context.go('/search?q=flutter&sort=hot');
```

- **`state.uri.queryParameters`**：取 `?` 後面的鍵值對。沒有就用 `?? 預設值` 兜底（第 02 章的 null 合併）。

### 傳整個物件（extra）

有時你已經有整個物件了，不想只傳 id 再去重抓。用 `extra`：

```dart
context.push('/product/detail', extra: product);   // 直接把 product 物件帶過去

GoRoute(
  path: '/product/detail',
  builder: (context, state) {
    final product = state.extra as Product;          // 取回來，記得轉型
    return ProductDetailPage(product: product);
  },
),
```

- **`extra`** 適合「App 內部已有物件、想直接帶過去省一次抓取」。
- **注意**：`extra` 不會出現在網址裡，所以**不支援 deep link / Web 重整**（重整後 extra 就沒了）。需要被分享、被深連結的頁面，請用路徑參數傳 id，到頁面再用 id 去抓資料。

---

## 5.5 巢狀導航：底部導覽列（ShellRoute / StatefulShellRoute）

大部分 App 有底部 tab（首頁 / 搜尋 / 我的），切 tab 時**外框（底部列）不動，只換中間內容**，而且**每個 tab 各自保留自己的捲動位置與返回堆疊**。go_router 用 `StatefulShellRoute` 處理：

```dart
final router = GoRouter(
  initialLocation: '/home',
  routes: [
    StatefulShellRoute.indexedStack(
      // builder：負責畫「共用外框」（含底部導覽列），navigationShell 是切換器
      builder: (context, state, navigationShell) {
        return ScaffoldWithNavBar(navigationShell: navigationShell);
      },
      branches: [
        // 每個 branch 是一個 tab，各自有獨立的路由堆疊
        StatefulShellBranch(routes: [
          GoRoute(path: '/home', builder: (c, s) => const HomePage()),
          GoRoute(path: '/home/detail/:id', builder: (c, s) => DetailPage(...)),
        ]),
        StatefulShellBranch(routes: [
          GoRoute(path: '/search', builder: (c, s) => const SearchPage()),
        ]),
        StatefulShellBranch(routes: [
          GoRoute(path: '/profile', builder: (c, s) => const ProfilePage()),
        ]),
      ],
    ),
  ],
);
```

外框 Widget：

```dart
class ScaffoldWithNavBar extends StatelessWidget {
  final StatefulNavigationShell navigationShell;
  const ScaffoldWithNavBar({super.key, required this.navigationShell});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: navigationShell,                       // 當前 tab 的內容顯示在這
      bottomNavigationBar: NavigationBar(
        selectedIndex: navigationShell.currentIndex,    // 目前在第幾個 tab
        onDestinationSelected: (index) {
          // 點底部按鈕 → 切到對應 branch
          navigationShell.goBranch(
            index,
            initialLocation: index == navigationShell.currentIndex,  // 再點同一個 tab → 回到該 tab 的起始頁
          );
        },
        destinations: const [
          NavigationDestination(icon: Icon(Icons.home), label: '首頁'),
          NavigationDestination(icon: Icon(Icons.search), label: '搜尋'),
          NavigationDestination(icon: Icon(Icons.person), label: '我的'),
        ],
      ),
    );
  }
}
```

逐段解釋（這段是底部 tab App 的標準骨架）：

- **`StatefulShellRoute.indexedStack`**：「狀態保留型」的殼。`indexedStack` 代表它用 `IndexedStack` 同時保留所有 tab 的畫面（切換時不重建、捲動位置與狀態都留著）。
- **`branches`**：每個 `StatefulShellBranch` 是一個 tab 的「獨立小世界」，可以有自己的子路由堆疊（例如首頁 tab 裡再 push 詳情頁，返回鍵只在這個 tab 內運作）。
- **`navigationShell`**：go_router 給你的「切換器」。`body: navigationShell` 把當前 tab 內容塞進畫面；`navigationShell.currentIndex` 知道現在第幾個；`navigationShell.goBranch(index)` 切換 tab。
- **`NavigationBar`**：Material 3 的底部導覽列（舊版叫 `BottomNavigationBar`）。`destinations` 是每個按鈕。

**心智模型**：Shell ＝「不變的外框（底部列）」，Branch ＝「每個 tab 自己的房間」。切 tab 是換房間，外框不動，而且每個房間維持你離開時的樣子。

---

## 5.6 路由守衛：登入才能進的頁（redirect）

很多頁要「登入後才能看」。go_router 用 `redirect` 在導航前攔截、決定要不要改道：

```dart
final router = GoRouter(
  initialLocation: '/home',
  // 全域 redirect：每次導航前都會問一次
  redirect: (context, state) {
    final loggedIn = authService.isLoggedIn;            // 你的登入狀態
    final goingToLogin = state.matchedLocation == '/login';

    // 沒登入、又不是要去登入頁 → 強制改道去 /login
    if (!loggedIn && !goingToLogin) return '/login';

    // 已登入卻還想去登入頁 → 改道回首頁
    if (loggedIn && goingToLogin) return '/home';

    return null;                                        // 回傳 null = 放行，不改道
  },
  routes: [ /* ... */ ],
);
```

逐段解釋：

- **`redirect`**：每次導航**之前**都會呼叫。回傳一個路徑＝「改道去那裡」；回傳 `null`＝「放行」。
- 這就是「登入守衛（auth guard）」的標準做法：未登入一律踢到 `/login`。
- **`state.matchedLocation`**：使用者「本來想去」的路徑。用它判斷「是不是正要去登入頁」，避免無限改道（一直把人踢去 login，又因為要去 login 再踢一次…）。
- 實務上 `authService.isLoggedIn` 之後會由第 06 章的 Riverpod 提供，並讓 router 監聽登入狀態變化自動重導。這裡先建立觀念。

---

## 5.7 找不到的頁面：錯誤處理

```dart
GoRouter(
  routes: [ /* ... */ ],
  errorBuilder: (context, state) => Scaffold(
    body: Center(child: Text('找不到頁面：${state.uri}')),
  ),
);
```

- **`errorBuilder`**：當使用者（或 deep link）導到一個不存在的路徑時顯示的畫面。正式 App 通常做一個友善的 404 頁。

---

## 5.8 Deep Link（深層連結）：go_router 的甜頭

「Deep link」就是「點一個連結直接跳進 App 的某個內頁」，例如：
- 推播通知點開 → 直接進「訂單 #123」。
- 朋友分享 `myapp://product/42` → 直接進商品 42。

**go_router 的最大好處**：因為你的路由本來就是用網址形式（`/product/:id`）宣告的，**deep link 幾乎是免費附送**——系統把外部連結的路徑交給 go_router，它就照同一套路由規則 match 到對應頁面。你只需要在 Android (`AndroidManifest.xml`) 與 iOS (`Info.plist`) 設定「我要接收哪個 scheme/網域的連結」（這部分屬於原生設定，第 12、14 章會帶）。

**心智模型**：命令式 Navigator 要為 deep link 寫一堆「解析連結 → 手動 push 對應頁」的膠水；go_router 因為「路徑即路由」，deep link 自然就通。這正是當初要從 Navigator 升級到 go_router 的關鍵理由之一。

---

## 5.9 實務建議：把路由集中、用常數避免打錯字

```dart
// routes.dart —— 把路徑字串集中成常數，避免到處手打字串打錯
abstract class Routes {
  static const home = '/home';
  static const search = '/search';
  static String productDetail(String id) => '/product/$id';   // 帶參數的用方法產生
}

// 使用
context.go(Routes.home);
context.push(Routes.productDetail('42'));
```

逐段解釋為什麼這樣做：

- 直接到處寫 `context.go('/home')` 的字串，打錯一個字（`/hmoe`）編譯不會報錯，跑起來才發現導不過去。
- 把路徑集中成常數/方法，**打錯字會在編譯期被抓到**，改路徑也只要改一處。這是中大型專案的標配做法（第 10 章架構會再強化）。

---

## 5.10 動手練習

1. 建兩個頁面 `HomePage`、`AboutPage`，用 go_router 設定 `/` 與 `/about`，首頁放按鈕 `context.push('/about')`，About 頁能返回。
2. 加一條 `/user/:id` 路由，首頁傳 `context.push('/user/7')`，User 頁顯示「使用者 7」。
3. 用 `StatefulShellRoute` 做一個三 tab（首頁/搜尋/我的）的底部導覽列，確認切 tab 時各自的捲動位置會保留。
4. 加一個全域 `redirect`：用一個 `bool isLoggedIn = false;` 模擬，讓所有頁面在未登入時都被導去 `/login`。把 `isLoggedIn` 改成 `true` 看是否放行。

---

## 小結

- 內建 `Navigator` 是頁面堆疊（`push`/`pop`），能用但路由散落、deep link 難搞。
- **go_router** 把路由集中宣告成「網址地圖」，原生支援 deep link 與 Web 網址同步——本課主線。
- `context.go`（重設目的地、不留回頭路）vs `context.push`（疊頁、保留返回）——分清楚用途。
- 傳參：路徑參數 `:id`（可 deep link）、查詢參數 `?q=`、`extra`（傳物件但不可 deep link）。
- 底部 tab 用 `StatefulShellRoute.indexedStack` + `NavigationBar`，各 tab 狀態獨立保留。
- `redirect` 做登入守衛、`errorBuilder` 做 404。

---

> 能換頁了，但頁面之間、跨頁面的「共用狀態」怎麼管？下一章進入本課最重要的主線之一：用 Riverpod 做狀態管理。
> 前往 [第 06 章：狀態管理（Riverpod）](./06-state-management-riverpod.md)。
