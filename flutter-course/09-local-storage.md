# 第 09 章：本機資料儲存

> 不是所有東西都該每次跟伺服器要。登入 token、使用者偏好設定、離線快取、本機草稿——這些要存在「裝置上」。
> 這一章建立最重要的觀念：**不同性質的資料，要存在不同地方**。然後逐一實作三種主力：
> `shared_preferences`（簡單設定）、`flutter_secure_storage`（機密資料）、**Drift**（關聯式資料庫，本課主推），最後接上 Riverpod。

---

## 9.1 先決策：什麼資料該存哪裡？

新手最常見的錯誤是「全部塞 shared_preferences」或「token 用明文存」。先建立這張**決策表**：

| 資料性質 | 範例 | 該用 | 為什麼 |
|---------|------|------|--------|
| 少量、簡單的設定 | 深色模式、語言、是否第一次開 | **shared_preferences** | 輕量 key-value，夠用就好 |
| **機密 / 敏感** | 登入 token、密碼、金鑰 | **flutter_secure_storage** | 加密存到系統 Keychain/Keystore，明文存會被盜 |
| **大量、有結構、要查詢** | 商品快取、聊天訊息、離線清單 | **Drift（SQLite）** | 關聯式、可複雜查詢、可即時監聽 |
| 大型檔案 | 圖片、影片、下載的 PDF | **檔案系統（path_provider）** | 資料庫不適合塞二進位大檔 |

**心智模型**：
- `shared_preferences` ＝「便利貼」：貼幾個小設定，隨手讀寫。
- `flutter_secure_storage` ＝「保險箱」：放貴重的（token），上鎖加密。
- `Drift` ＝「檔案櫃」：大量資料分門別類，能用條件快速查找。

**⚠️ 鐵則：token、密碼這類機密，絕對不要放 shared_preferences**（它是明文，root/越獄裝置或備份就能讀到）。一律用 secure storage。

---

## 9.2 shared_preferences：簡單設定的便利貼

```bash
flutter pub add shared_preferences
```

```dart
import 'package:shared_preferences/shared_preferences.dart';

// 寫入
Future<void> saveSettings() async {
  final prefs = await SharedPreferences.getInstance();   // 拿到實例（非同步）
  await prefs.setBool('isDarkMode', true);
  await prefs.setString('language', 'zh');
  await prefs.setInt('launchCount', 5);
}

// 讀取
Future<bool> loadDarkMode() async {
  final prefs = await SharedPreferences.getInstance();
  return prefs.getBool('isDarkMode') ?? false;           // 沒存過就回預設 false
}
```

逐段解釋：

- **`SharedPreferences.getInstance()`**：非同步取得實例（第一次會從磁碟讀進記憶體）。
- **`setBool/setString/setInt/setDouble/setStringList`**：只支援這幾種基本型別。**不能直接存物件**（要存物件得先 `jsonEncode` 成字串）。
- **`getBool('key') ?? false`**：讀取。**注意一定要給預設值**（第 02 章的 `??`）——沒存過時回傳 null，不兜底就會出問題。
- **適合**：開關、語言、計數這類**少量、扁平**的設定。資料一多、要查詢，就該換 Drift。

---

## 9.3 flutter_secure_storage：機密資料的保險箱

```bash
flutter pub add flutter_secure_storage
```

```dart
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

class TokenStorage {
  final _storage = const FlutterSecureStorage();

  Future<void> saveToken(String token) async {
    await _storage.write(key: 'access_token', value: token);   // 加密寫入
  }

  Future<String?> readToken() async {
    return await _storage.read(key: 'access_token');           // 解密讀出
  }

  Future<void> clear() async {
    await _storage.delete(key: 'access_token');                // 登出時清掉
  }
}
```

逐段解釋：

- **`FlutterSecureStorage`**：底層在 **iOS 用 Keychain、Android 用 EncryptedSharedPreferences / Keystore**。資料**加密**儲存，不像 shared_preferences 是明文。
- **`write` / `read` / `delete`**：API 跟 shared_preferences 很像，但全程加密。
- **典型用途**：存第 08 章攔截器要用的 `access_token` / `refresh_token`。登入時 `write`、攔截器 `read` 帶進 header、登出 `delete`。
- **這就是第 08 章 `tokenStorage.read()` 的真身**——兩章在這裡接起來了。

---

## 9.4 Drift：型別安全的 SQLite（本課主推）

當資料「量大、有結構、要查詢/排序/關聯」，就需要真正的資料庫。Flutter 生態主要選項：

- **Drift**（建立在 SQLite 上）：**型別安全、可寫 Dart 查詢、可即時監聽（回傳 Stream）**。本課主推。
- **Isar / Hive**：NoSQL（物件導向），寫起來更快但關聯查詢較弱。9.6 補充。

為什麼主推 Drift：**它把「SQL 的強大」和「Dart 的型別安全」結合**——你用 Dart 寫查詢，編譯期就抓出錯誤，而且查詢結果可以是 **Stream**（資料一變，畫面自動更新，完美搭配第 06 章 Riverpod）。

```bash
flutter pub add drift drift_flutter
flutter pub add --dev drift_dev build_runner
```

### 定義資料表

```dart
// database.dart
import 'package:drift/drift.dart';
import 'package:drift_flutter/drift_flutter.dart';
part 'database.g.dart';

// 1) 定義一張「待辦」表
class Todos extends Table {
  IntColumn get id => integer().autoIncrement()();        // 主鍵，自動遞增
  TextColumn get title => text().withLength(min: 1, max: 100)();
  BoolColumn get done => boolean().withDefault(const Constant(false))();
  DateTimeColumn get createdAt => dateTime().withDefault(currentDateAndTime)();
}

// 2) 宣告資料庫，列出有哪些表
@DriftDatabase(tables: [Todos])
class AppDatabase extends _$AppDatabase {
  AppDatabase() : super(_openConnection());

  @override
  int get schemaVersion => 1;                              // 改表結構時要遞增（做 migration）
}

QueryExecutor _openConnection() {
  return driftDatabase(name: 'app_db');                    // 在裝置上建立/開啟資料庫檔
}
```

逐段解釋：

- **`class Todos extends Table`**：用 Dart 類別**描述一張資料表的欄位**。`IntColumn`、`TextColumn`、`BoolColumn` 對應 SQL 欄位型別。
- **`integer().autoIncrement()()`**：注意**結尾兩個括號**——Drift 的 DSL 寫法。`autoIncrement` 讓 id 自動編號當主鍵。
- **`text().withLength(min:1, max:100)()`**：文字欄位，順便定義長度限制（會在寫入時驗證）。
- **`boolean().withDefault(const Constant(false))()`**：布林欄位，預設 false。
- **`@DriftDatabase(tables: [Todos])`**：宣告這個資料庫包含哪些表。產生器會據此生成 `database.g.dart`（含型別安全的查詢方法）。
- **`schemaVersion`**：資料庫版本。**之後改表結構（加欄位）要把它 +1，並寫 migration**（告訴 Drift 舊資料怎麼升級），否則使用者更新 App 後資料庫對不上會崩。先記得有這回事。
- 跑 `dart run build_runner build` 產生程式碼。

### 增刪查改（CRUD）

在 `AppDatabase` 類別裡加方法：

```dart
// 查全部（一次性）
Future<List<Todo>> getAllTodos() => select(todos).get();

// 查全部（即時監聽：資料一變就吐新值）⭐ Drift 的強項
Stream<List<Todo>> watchAllTodos() => select(todos).watch();

// 新增
Future<int> addTodo(String title) {
  return into(todos).insert(TodosCompanion.insert(title: title));
}

// 更新（標記完成）
Future<bool> toggleTodo(Todo todo) {
  return update(todos).replace(todo.copyWith(done: !todo.done));
}

// 刪除
Future<int> removeTodo(int id) {
  return (delete(todos)..where((t) => t.id.equals(id))).go();
}
```

逐段解釋：

- **`select(todos).get()`**：查詢全部，回傳 `Future<List<Todo>>`（`Todo` 是產生器依表自動生的資料類別）。
- **`select(todos).watch()`**：**回傳 `Stream`**——只要這張表的資料有變動（任何地方 insert/update/delete），它就自動吐出最新清單。這是第 02 章 Stream 的實戰，也是「資料庫驅動 UI 自動更新」的關鍵。
- **`into(todos).insert(TodosCompanion.insert(...))`**：新增。`Companion` 是 Drift 用來「只指定部分欄位」的工具（id、createdAt 有預設值就不用給）。
- **`update(...).replace(...)`** / **`(delete(...)..where(...)).go()`**：更新與刪除。`..where(...)` 是第 02 章的 cascade，加上篩選條件。
- **型別安全的威力**：`t.id.equals(id)` 這種查詢，欄位名打錯、型別不對，**編譯期就報錯**——不像手寫 SQL 字串要跑起來才發現拼錯。

---

## 9.5 接上 Riverpod：讓資料庫驅動畫面

把 Drift 的 `watch` Stream 接進 Riverpod 的 `StreamProvider`，就能做到「資料庫一變，畫面自動更新」：

```dart
// 1) 提供資料庫實例（keepAlive：整個 App 共用一個，不要自動回收）
@Riverpod(keepAlive: true)
AppDatabase appDatabase(AppDatabaseRef ref) {
  final db = AppDatabase();
  ref.onDispose(db.close);              // App 結束時關閉資料庫，釋放資源
  return db;
}

// 2) 提供「即時待辦清單」（注意是 Stream，自動成為 AsyncValue）
@riverpod
Stream<List<Todo>> todoList(TodoListRef ref) {
  return ref.watch(appDatabaseProvider).watchAllTodos();
}
```

UI 端：

```dart
class TodoPage extends ConsumerWidget {
  const TodoPage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final todosAsync = ref.watch(todoListProvider);
    final db = ref.read(appDatabaseProvider);

    return Scaffold(
      body: todosAsync.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => Center(child: Text('錯誤：$e')),
        data: (todos) => ListView.builder(
          itemCount: todos.length,
          itemBuilder: (c, i) {
            final todo = todos[i];
            return CheckboxListTile(
              title: Text(todo.title),
              value: todo.done,
              onChanged: (_) => db.toggleTodo(todo),   // 改資料庫 → Stream 自動推新值 → 畫面更新
            );
          },
        ),
      ),
      floatingActionButton: FloatingActionButton(
        onPressed: () => db.addTodo('新待辦'),           // 新增 → 同樣自動反映到畫面
        child: const Icon(Icons.add),
      ),
    );
  }
}
```

逐段解釋（**這是本章最漂亮的地方**）：

- **`@Riverpod(keepAlive: true)`**：資料庫是全 App 共用、不該被自動回收的資源（第 06 章 autoDispose 的例外）。
- **`ref.onDispose(db.close)`**：provider 被銷毀時關閉資料庫。**開了資源就要關**（第 03 章生命週期觀念貫穿到這）。
- **`todoList` 回傳 `Stream`**：Riverpod 自動把它變成 `AsyncValue<List<Todo>>`，UI 照樣用 `.when` 三態。
- **重點閉環**：UI 上勾選 → `db.toggleTodo` 改資料庫 → Drift 的 `watch` Stream 偵測到變動 → 吐出新清單 → `todoListProvider` 更新 → `ref.watch` 它的 UI 自動重建。**你完全沒寫 setState，資料與畫面永遠同步。** 這就是「響應式資料層」的威力。

---

## 9.6 補充：Hive / Isar（NoSQL 替代方案）

如果你的資料「不太需要關聯查詢、就是存一堆物件」，NoSQL 寫起來更快：

- **Hive**：輕量 key-value/物件儲存，純 Dart、跨平台、很快。適合「快取一包 JSON、存簡單物件集合」。
- **Isar**：效能很強的物件資料庫，支援索引與查詢。

**怎麼選（一句話）**：資料有明確關聯、要複雜查詢、想要 reactive Stream → **Drift**；只是存物件、要極簡極快 → Hive/Isar。本課主線用 Drift，因為它最接近「正式 App 的資料層」需求，學會它最有遷移價值。

---

## 9.7 大型檔案：path_provider

資料庫不適合塞圖片、影片這種大二進位檔。要存檔案用 `path_provider` 拿到合法的目錄路徑：

```dart
import 'package:path_provider/path_provider.dart';
import 'dart:io';

Future<File> saveImage(List<int> bytes) async {
  final dir = await getApplicationDocumentsDirectory();   // App 私有的文件目錄
  final file = File('${dir.path}/avatar.png');
  return file.writeAsBytes(bytes);
}
```

- **`getApplicationDocumentsDirectory()`**：拿到「App 專屬、會被備份」的目錄。其他常用：`getTemporaryDirectory()`（暫存，系統可能清掉）、`getApplicationSupportDirectory()`。
- **為什麼不能隨便寫路徑**：手機 App 是沙盒（sandbox），只能寫自己被分配到的目錄。path_provider 幫你拿到合法路徑。

---

## 9.8 動手練習

1. 用 `shared_preferences` 做「深色模式開關」，重開 App 後設定仍在（搭配第 11 章可真正套用主題）。
2. 用 `flutter_secure_storage` 寫一個 `TokenStorage`，能存/讀/刪 token，並接到第 08 章的 Dio 攔截器。
3. 用 Drift 建一張 `Notes` 表（id、title、content、createdAt），實作新增、即時列表（`watch`）、刪除。
4. 把第 3 題接上 Riverpod 的 `StreamProvider`，驗證「新增筆記後清單自動更新、不用手動刷新」。

---

## 小結

- **先決策再儲存**：簡單設定→`shared_preferences`；機密(token)→`flutter_secure_storage`（加密，**絕不用明文存 token**）；大量結構化資料→**Drift**；大檔→檔案系統。
- `shared_preferences`：key-value 便利貼，只存基本型別，讀取記得給 `?? 預設值`。
- `flutter_secure_storage`：用系統 Keychain/Keystore 加密，存 token 的正解，接第 08 章攔截器。
- **Drift**：型別安全的 SQLite，用 Dart 描述表與查詢，`watch()` 回傳 **Stream**，接 Riverpod 的 StreamProvider 達成「資料變→畫面自動更新」。記得 `schemaVersion` 與 migration。
- Hive/Isar 是 NoSQL 替代；大檔用 `path_provider` 拿合法目錄。

---

> 我們已經有了 UI、路由、狀態、網路、儲存。下一章把它們「組織」起來：用 Repository + 依賴注入做出可維護、好測試的分層架構。
> 前往 [第 10 章：應用架構與分層](./10-app-architecture-layering.md)。
