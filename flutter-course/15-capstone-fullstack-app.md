# 第 15 章：Capstone 實戰專題

> 收尾章。我們把 00～14 的所有技術串成一個**可上線的完整 App**——「**書架（BookShelf）**」：登入、瀏覽線上書單、收藏到本機、深色模式切換、上架。
> 這章不教新東西，而是教你「**怎麼把零件組成一台完整的車**」。我們會走一遍架構、目錄、關鍵接線，並逐段解釋「為什麼這樣接」。

---

## 15.1 專案規格：書架 App

| 功能 | 用到的章節 |
|------|-----------|
| 登入（帳密 → token 存 secure storage） | 07 表單、08 Dio、09 secure storage |
| 瀏覽線上書單（API 抓取，下拉重整） | 06 Riverpod、08 Retrofit、04 ListView |
| 書籍詳情頁（傳 id、deep link） | 05 go_router |
| 收藏（存本機 Drift，即時更新） | 09 Drift、06 StreamProvider |
| 底部導覽（書單 / 收藏 / 設定） | 05 ShellRoute |
| 深色模式 + 記住設定 | 11 主題、09 preferences |
| 登入守衛（未登入導去登入頁） | 05 redirect、06 Riverpod |
| 測試 + 打包上架 | 13 測試、14 上版 |

---

## 15.2 目錄結構（feature-first，第 10 章）

```text
lib/
├── main.dart
├── app.dart                       # MaterialApp.router + 主題 + 路由
├── core/
│   ├── network/
│   │   ├── dio_provider.dart       # Dio + token 攔截器（08）
│   │   └── book_api.dart           # Retrofit API client（08）
│   ├── storage/
│   │   ├── token_storage.dart      # secure storage（09）
│   │   ├── prefs_provider.dart     # shared_preferences（09/11）
│   │   └── database.dart           # Drift 資料庫（09）
│   ├── router/
│   │   └── app_router.dart         # go_router + 守衛（05）
│   ├── theme/
│   │   ├── app_theme.dart          # 淺/深主題（11）
│   │   └── theme_controller.dart   # 主題切換 + 記憶（11）
│   └── error/
│       └── app_exception.dart      # 統一錯誤型別（08/10）
└── features/
    ├── auth/
    │   ├── data/auth_repository.dart        # 登入/登出/狀態（10）
    │   ├── application/auth_controller.dart # 登入流程狀態（07）
    │   └── presentation/login_screen.dart   # 登入表單（07）
    ├── books/
    │   ├── data/book_repository.dart        # API + 快取（10）
    │   ├── application/book_list_controller.dart
    │   └── presentation/{book_list,book_detail}_screen.dart
    ├── favorites/
    │   ├── data/favorite_repository.dart    # Drift CRUD（09）
    │   ├── application/favorite_controller.dart
    │   └── presentation/favorites_screen.dart
    └── settings/
        └── presentation/settings_screen.dart
```

**為什麼這樣分**（回顧第 10 章）：跨功能共用的基礎建設放 `core/`；每個功能（auth/books/favorites/settings）自成一包，內部再分 `data`/`application`/`presentation` 三層。要改「收藏」功能，所有相關檔案都在 `features/favorites/`。

---

## 15.3 進入點：main.dart 與 app.dart

```dart
// main.dart
void main() async {
  WidgetsFlutterBinding.ensureInitialized();          // 用到原生（prefs）前要先初始化

  // 預先載入 shared_preferences，讓 provider 能同步讀取（避免一開始閃白屏）
  final prefs = await SharedPreferences.getInstance();

  runApp(
    ProviderScope(                                      // 第 06 章：所有狀態的根容器
      overrides: [
        prefsProvider.overrideWithValue(prefs),         // 把載好的 prefs 注入
      ],
      child: const BookShelfApp(),
    ),
  );
}
```

逐段解釋：

- **`WidgetsFlutterBinding.ensureInitialized()`**：在 `runApp` 之前要用到 plugin（讀 prefs）時必須先呼叫，否則原生通道還沒準備好會報錯。
- **預載 prefs + `overrideWithValue`**：shared_preferences 的讀取是非同步的，但我們希望主題 provider 能「同步」拿到初始值（不然 App 啟動瞬間會先閃淺色再變深色）。所以在 `main` 先 `await` 載好，用第 10 章的 `overrideWithValue` 注入。**這是處理「啟動時就需要的非同步設定」的標準手法。**

```dart
// app.dart
class BookShelfApp extends ConsumerWidget {
  const BookShelfApp({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final themeMode = ref.watch(themeModeControllerProvider);   // 11 章
    final router = ref.watch(routerProvider);                   // 05 章

    return MaterialApp.router(
      title: 'BookShelf',
      theme: AppTheme.light,
      darkTheme: AppTheme.dark,
      themeMode: themeMode,                                     // 主題跟著 provider
      routerConfig: router,                                     // 路由交給 go_router
    );
  }
}
```

- App 根是 `ConsumerWidget`，`watch` 主題與路由 provider——使用者切主題、登入狀態改變導致路由重導，這裡都會自動反映。**這就是全 App 的「總接線盒」。**

---

## 15.4 接線一：登入 → token → 全 App 認證

這條線串起 07（表單）、08（Dio 攔截器）、09（secure storage）：

```dart
// auth_repository.dart
class AuthRepository {
  final BookApi _api;
  final TokenStorage _tokenStorage;
  AuthRepository(this._api, this._tokenStorage);

  Future<void> login(String email, String password) async {
    final res = await _api.login(LoginRequest(email, password));  // 08：打登入 API
    await _tokenStorage.saveToken(res.accessToken);                // 09：token 存進保險箱
  }

  Future<void> logout() => _tokenStorage.clear();
  Future<bool> get isLoggedIn async => (await _tokenStorage.readToken()) != null;
}
```

```dart
// dio_provider.dart —— 攔截器自動帶 token（08）
@riverpod
Dio dio(DioRef ref) {
  final dio = Dio(BaseOptions(baseUrl: Env.apiBaseUrl));          // 14：dart-define 注入
  dio.interceptors.add(InterceptorsWrapper(
    onRequest: (options, handler) async {
      final token = await ref.read(tokenStorageProvider).readToken();
      if (token != null) options.headers['Authorization'] = 'Bearer $token';
      handler.next(options);
    },
  ));
  return dio;
}
```

**這條線的閉環**：登入表單送出 → `authRepository.login` 打 API 拿 token → 存進 secure storage → 之後每個 API 請求，Dio 攔截器自動從 secure storage 讀 token 帶進 header。**使用者只登入一次，全 App 自動認證。**

---

## 15.5 接線二：登入狀態驅動路由守衛

串起 05（redirect）、06（Riverpod）：

```dart
// app_router.dart
@riverpod
GoRouter router(RouterRef ref) {
  final isLoggedIn = ref.watch(authControllerProvider).maybeWhen(
    data: (loggedIn) => loggedIn,
    orElse: () => false,
  );

  return GoRouter(
    initialLocation: '/books',
    redirect: (context, state) {
      final goingToLogin = state.matchedLocation == '/login';
      if (!isLoggedIn && !goingToLogin) return '/login';      // 未登入 → 踢去登入
      if (isLoggedIn && goingToLogin) return '/books';        // 已登入 → 不准回登入頁
      return null;
    },
    routes: [
      GoRoute(path: '/login', builder: (c, s) => const LoginScreen()),
      StatefulShellRoute.indexedStack(                        // 底部導覽（05）
        builder: (c, s, shell) => ScaffoldWithNavBar(navigationShell: shell),
        branches: [
          StatefulShellBranch(routes: [
            GoRoute(path: '/books', builder: (c, s) => const BookListScreen()),
            GoRoute(path: '/books/:id', builder: (c, s) =>
                BookDetailScreen(id: s.pathParameters['id']!)),   // 路徑參數（05）
          ]),
          StatefulShellBranch(routes: [
            GoRoute(path: '/favorites', builder: (c, s) => const FavoritesScreen()),
          ]),
          StatefulShellBranch(routes: [
            GoRoute(path: '/settings', builder: (c, s) => const SettingsScreen()),
          ]),
        ],
      ),
    ],
  );
}
```

逐段解釋：

- **`router` 本身是個 provider，`watch` 登入狀態**：登入狀態一變（登入/登出），這個 provider 重建出新的 GoRouter，`redirect` 重新評估——**登出瞬間自動被導回登入頁**，登入後自動進書單。狀態與導航完全聯動，不用手動 `context.go`。
- 三個 branch 對應底部三個 tab，書單 tab 內含詳情子路由（在該 tab 內 push，返回不影響其他 tab）。

---

## 15.6 接線三：書單（API）+ 收藏（本機）的混合畫面

這是最能展現「遠端 + 本機資料整合」的地方——串 06、08、09、10：

```dart
// book_list_controller.dart
@riverpod
Future<List<Book>> bookList(BookListRef ref) {
  return ref.watch(bookRepositoryProvider).getBooks();        // 08+10：API（含快取降級）
}

// favorite_controller.dart —— 收藏 id 集合，來自 Drift 的即時 Stream（09）
@riverpod
Stream<Set<int>> favoriteIds(FavoriteIdsRef ref) {
  return ref.watch(favoriteRepositoryProvider).watchFavoriteIds();
}
```

書單畫面：

```dart
class BookListScreen extends ConsumerWidget {
  const BookListScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final booksAsync = ref.watch(bookListProvider);
    final favIds = ref.watch(favoriteIdsProvider).valueOrNull ?? {};

    return Scaffold(
      appBar: AppBar(title: const Text('書架')),
      body: RefreshIndicator(                                  // 下拉重整
        onRefresh: () async => ref.invalidate(bookListProvider),  // 06：重抓
        child: booksAsync.when(                                // 06：AsyncValue 三態
          loading: () => const Center(child: CircularProgressIndicator()),
          error: (e, _) => _ErrorView(message: '$e', onRetry: () => ref.invalidate(bookListProvider)),
          data: (books) => ListView.builder(                   // 04：長清單用 builder
            itemCount: books.length,
            itemBuilder: (c, i) {
              final book = books[i];
              final isFav = favIds.contains(book.id);          // 本機收藏狀態
              return ListTile(
                title: Text(book.title),
                subtitle: Text(book.author),
                trailing: IconButton(
                  icon: Icon(isFav ? Icons.favorite : Icons.favorite_border,
                      color: isFav ? Colors.red : null),
                  onPressed: () => ref.read(favoriteRepositoryProvider).toggle(book.id),
                ),
                onTap: () => context.push('/books/${book.id}'), // 05：帶 id 進詳情
              );
            },
          ),
        ),
      ),
    );
  }
}
```

逐段解釋（**這個畫面是整個 App 的縮影**）：

- **同時 watch 兩個來源**：`bookListProvider`（遠端書單，AsyncValue）+ `favoriteIdsProvider`（本機收藏，Stream）。畫面把兩者合併——書來自 API，愛心狀態來自本機資料庫。
- **`favIds.contains(book.id)`**：判斷這本書有沒有被收藏。
- **點愛心 → `favoriteRepository.toggle`** → 寫 Drift → Drift 的 `watch` Stream 吐新值 → `favoriteIdsProvider` 更新 → 這個畫面**自動重建**，愛心即時變色。**全程沒有 setState**（第 09 章的響應式資料層）。
- **`RefreshIndicator` + `ref.invalidate`**：下拉重抓 API（第 06 章）。
- **三態 + 重試**：`error` 給一個帶「重試」按鈕的視圖——這是成熟 App 的細節，不是白屏。

---

## 15.7 接線四：設定頁（主題切換 + 登出）

```dart
class SettingsScreen extends ConsumerWidget {
  const SettingsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final themeMode = ref.watch(themeModeControllerProvider);

    return ListView(
      children: [
        SwitchListTile(
          title: const Text('深色模式'),
          value: themeMode == ThemeMode.dark,
          onChanged: (on) => ref.read(themeModeControllerProvider.notifier)
              .setMode(on ? ThemeMode.dark : ThemeMode.light),   // 11：切換+記憶
        ),
        ListTile(
          title: const Text('登出'),
          trailing: const Icon(Icons.logout),
          onTap: () async {
            await ref.read(authControllerProvider.notifier).logout();
            // 登出後 authController 狀態變 → router provider 重建 → redirect 自動踢回 /login
          },
        ),
      ],
    );
  }
}
```

逐段解釋：

- **深色開關**：改 `themeModeControllerProvider` → `app.dart` 的 `MaterialApp` 重建換主題 + 存進 prefs（第 11 章）。
- **登出的優雅之處**：只要呼叫 `logout()` 改登入狀態，**不需要手動導頁**——15.5 的 router 在 watch 登入狀態，狀態一變自動重導回 `/login`。**這就是「狀態驅動導航」的威力**：你管好狀態，導航自己會對。

---

## 15.8 整體資料流回顧（一張圖看懂全貌）

```text
                ┌─────────────── ProviderScope（全 App 狀態根）──────────────┐
                │                                                            │
 使用者操作 ───→ Presentation（畫面）                                         │
                │   ref.watch(狀態) / ref.read(notifier).動作()              │
                ▼                                                            │
            Application（Controller / Provider）                            │
                │   協調流程、管理 AsyncValue 三態                            │
                ▼                                                            │
              Data（Repository）                                            │
                │   決定資料來源：API？快取？資料庫？翻譯錯誤                  │
        ┌───────┴────────┐                                                  │
        ▼                ▼                                                  │
  BookApi(Dio/Retrofit)  Drift / SecureStorage / Prefs                     │
  （遠端，含 token 攔截器） （本機：收藏、token、設定）                        │
                │                                                          │
                └─→ 資料變動 → Stream/AsyncValue 推新值 → watch 的 UI 自動重建 ┘
```

**這張圖就是這門課的總結**：每一層各司其職，狀態由 Riverpod 串接，遠端與本機資料各得其所，UI 永遠是「當前狀態的反映」。你改任何一層，其他層不受影響——這就是「可維護、可測試、可上線」的架構。

---

## 15.9 從這裡到上架

照第 14 章把這個 App 推上線：

1. `flutter test` 全綠（第 13 章：repository / controller 的 unit test + 關鍵畫面 widget test）。
2. 設定圖示、名稱、版本號，用 `--dart-define` 指向正式 API。
3. Android：簽章 → `build appbundle` → Play 內部測試 → 升正式。
4. iOS：Xcode 自動簽章 → `build ipa` → TestFlight → 送審。
5. 接上 CI/CD（Codemagic / GitHub Actions），之後打 tag 自動發版。

---

## 15.10 延伸練習（把它變成你的作品集）

1. **完整把書架 App 做出來**：用免費 API（如 Google Books API 或 jsonplaceholder 改造）當書單來源，登入可先用假驗證。
2. 加「搜尋」功能：搜尋框（07）+ `CancelToken` 取消舊請求（08）+ 查詢結果用 family provider（06）。
3. 收藏頁加「離線可用」：即使沒網路，收藏的書（存在 Drift）仍能看詳情。
4. 加 i18n（11）支援中英切換、加 golden test（13）鎖定書籍卡片外觀。
5. 真的上架一次（哪怕只到內部測試軌道）——**走完一次上架流程，你對 Flutter 的理解會完全不同。**

---

## 課程總結：你現在會什麼

走完這 16 章，你已經具備「獨立開發並上架一個正式 Flutter App」的完整能力：

- **心智模型**：Flutter 自己畫像素、三棵樹、約束模型、狀態驅動 UI——你不再把任何行為當魔法。
- **核心技能**：Widget 組合、go_router 導航、**Riverpod 狀態管理**、表單驗證。
- **資料層**：**Dio + Retrofit 串 API**、**Drift / secure storage / preferences 本機儲存**、Repository 分層架構。
- **產品化**：主題/響應式/多語系、原生整合、測試、**簽章打包上架雙平台**、CI/CD。

接下來的路：挑一個你真正想做的 App，從零做到上架。遇到不會的，回來翻對應章節；遇到本課沒講的，你已經有足夠的心智模型去讀官方文件與 pub.dev。**最好的學習，是把學到的東西做成一個真的、有人會用的產品。**

---

> 🎉 恭喜你完成整門 Flutter 課程！回到 [課程首頁](./README.md) 可隨時複習任一章節。
