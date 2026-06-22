# 第 10 章：應用架構與分層

> 到這裡你已經會 UI、路由、狀態、網路、儲存。但如果把它們全攪在一起，專案一大就變「義大利麵」——一個檔案又打 API、又解析、又改 UI、又寫資料庫，改一個地方爆三個地方。
> 這一章教你怎麼把這些**分層組織**，用 **Repository 模式 + Riverpod 依賴注入**，做出「好讀、好改、好測試」的架構。這是把前面所有技術「黏起來」的章節。

---

## 10.1 先看反例：沒有架構的痛

假設「商品列表頁」直接這樣寫（新手很常見）：

```dart
class ProductPage extends StatefulWidget {/* ... */}
class _ProductPageState extends State<ProductPage> {
  List<Product> products = [];

  @override
  void initState() {
    super.initState();
    // ❌ 在 UI 裡直接打 API、解析、處理 token、改狀態，全擠在一起
    Dio().get('https://api.example.com/products', options: Options(
      headers: {'Authorization': 'Bearer ${某處拿來的token}'},
    )).then((res) {
      setState(() {
        products = (res.data as List).map((j) => Product.fromJson(j)).toList();
      });
    });
  }
  // ...
}
```

這段「能跑」，但問題一籮筐：

1. **無法重用**：別的頁面也要商品資料，又得把這段複製貼上。
2. **無法測試**：商品邏輯綁死在 UI 裡，要測就得跑整個畫面。
3. **改一處動全身**：API 網址變了、token 機制變了、要加快取，每個用到的地方都要改。
4. **混責任**：一個 class 同時管「畫面、網路、解析、認證」——違反「單一職責」。

**架構要解決的，就是「把不同職責的程式碼分開放，讓彼此能獨立替換與測試」。**

---

## 10.2 分層心智模型：資料往上流，事件往下流

我們用一個務實、適合中小型 App 的分層（不用一開始就上完整 Clean Architecture）：

```text
┌─────────────────────────────────────────┐
│  Presentation 層（UI）                     │  Widget / 頁面
│  「畫面長怎樣、使用者點了什麼」              │  ← 只認識 Controller / Provider
├─────────────────────────────────────────┤
│  Application 層（狀態/邏輯）                │  Riverpod Notifier / Controller
│  「畫面該顯示什麼狀態、協調流程」            │  ← 呼叫 Repository
├─────────────────────────────────────────┤
│  Data 層（Repository）                     │  Repository
│  「資料從哪來：API？快取？資料庫？」         │  ← 整合 API client + 本機儲存
├─────────────────────────────────────────┤
│  Data Source（最底層）                     │  Retrofit API / Drift / secure storage
│  「實際去拿/存資料的工具」                  │
└─────────────────────────────────────────┘
```

**核心原則：每一層只跟「下一層」說話，且只透過「抽象介面」。**

- UI 不知道資料是從 API 還是資料庫來，它只問 Application 層「現在的狀態是什麼」。
- Application 層不自己打 API，它叫 Repository「給我商品清單」。
- Repository 才知道「先看本機快取、沒有再打 API、回來順便存起來」這些細節。

**心智模型**：像公司分工。UI 是「櫃台」（只負責接待與展示），Repository 是「倉庫管理員」（你要貨，他自己決定從架上拿還是去叫貨），中間的 Controller 是「組長」（協調流程、回報狀態）。櫃台不該自己跑去倉庫翻箱倒櫃。

---

## 10.3 資料夾結構：feature-first（按功能分，不是按類型分）

兩種常見組織方式：

```text
❌ type-first（按類型）：專案一大就很痛
lib/
├── models/      （所有 model 擠一起）
├── screens/     （所有畫面擠一起）
├── services/
└── widgets/

✅ feature-first（按功能）：本課推薦
lib/
├── core/                    # 跨功能共用
│   ├── network/             # Dio 設定、攔截器
│   ├── storage/             # secure storage、資料庫
│   ├── router/              # go_router 設定
│   └── error/               # AppException 等
├── features/
│   ├── auth/                # 「登入」這個功能，自成一包
│   │   ├── data/            #   repository、api、model
│   │   ├── application/     #   controller / provider
│   │   └── presentation/    #   頁面、widget
│   └── products/            # 「商品」功能，同樣分三層
│       ├── data/
│       ├── application/
│       └── presentation/
└── main.dart
```

逐點解釋為什麼 feature-first 更好：

- **改一個功能，檔案都在同一個資料夾**：要改「登入」，所有相關的東西（畫面、邏輯、API、model）都在 `features/auth/` 裡，不用在 `models/`、`screens/`、`services/` 之間跳來跳去。
- **好刪、好搬**：一個功能不要了，刪掉整個資料夾即可。
- **團隊分工清楚**：不同人負責不同 feature 資料夾，衝突少。
- **`core/`**：放「跨功能共用」的基礎建設（網路、儲存、路由）。

---

## 10.4 主角：Repository 模式

Repository 是這套架構的核心。它的職責：**對上層隱藏「資料到底從哪來」，提供乾淨的方法。**

先定義一個介面（抽象），再寫實作：

```dart
// features/products/data/product_repository.dart

// 1) 抽象介面：定義「能對商品做什麼」，不管怎麼做
abstract interface class ProductRepository {
  Future<List<Product>> getProducts();
  Future<Product> getProduct(int id);
}

// 2) 實作：整合 API + 本機快取
class ProductRepositoryImpl implements ProductRepository {
  final ProductApi _api;             // 第 08 章的 Retrofit client
  final AppDatabase _db;             // 第 09 章的 Drift 資料庫

  ProductRepositoryImpl(this._api, this._db);

  @override
  Future<List<Product>> getProducts() async {
    try {
      final products = await _api.getProducts(1);   // 打 API
      await _db.cacheProducts(products);            // 順便存進本機快取
      return products;
    } on DioException catch (e) {
      // 網路掛了 → 退而求其次，回傳上次快取的資料（離線可用）
      final cached = await _db.getCachedProducts();
      if (cached.isNotEmpty) return cached;
      throw _mapError(e);                            // 真的沒救才丟出「翻譯過」的錯誤
    }
  }

  @override
  Future<Product> getProduct(int id) async {
    try {
      return await _api.getProduct(id);
    } on DioException catch (e) {
      throw _mapError(e);
    }
  }

  // 把技術錯誤翻譯成 App 自己的錯誤型別（第 8 章提過）
  AppException _mapError(DioException e) {
    if (e.type == DioExceptionType.connectionError) {
      return const AppException('網路連線失敗');
    }
    return AppException('載入失敗（${e.response?.statusCode}）');
  }
}
```

逐段解釋（**這是整章最重要的程式碼**）：

- **`abstract interface class ProductRepository`**：先定義「契約」——商品能做哪些事。**上層（Controller）只依賴這個介面，不依賴具體實作。** 這樣測試時可以塞一個假的（FakeProductRepository）。
- **`ProductRepositoryImpl` 整合多個資料來源**：建構子接收 `ProductApi`（遠端）和 `AppDatabase`（本機）。**「資料從哪來」的決策邏輯集中在這一層**：先打 API、存快取；API 掛了就回快取（離線降級）。
- **離線降級**：`catch` 裡先試本機快取——這種「網路不好也能看舊資料」的體驗，正是 Repository 該負責的事，UI 完全不用知道。
- **`_mapError`**：把 `DioException`（技術細節）轉成 `AppException`（App 領域的錯誤）。**這樣上層和 UI 不需要 import dio**，徹底解耦。
- **單一職責**：UI 只管畫、Controller 只管狀態流程、Repository 只管「資料怎麼來」。改 API、加快取、換資料庫——只動 Repository，上層完全不受影響。

**心智模型**：Repository 是「資料的門面」。上層敲門說「給我商品」，門後是 API 還是快取還是兩者合併，敲門的人不需要知道。

---

## 10.5 依賴注入（DI）：用 Riverpod 把零件組起來

上面 Repository 需要 `ProductApi` 和 `AppDatabase`。誰來「提供」這些零件、組裝起來？這就是**依賴注入**。Riverpod 本身就是一個 DI 容器：

```dart
// features/products/data/product_providers.dart

// 最底層零件（第 08、09 章已建）
@riverpod
Dio dio(DioRef ref) { /* baseUrl + 攔截器 */ }

@riverpod
ProductApi productApi(ProductApiRef ref) => ProductApi(ref.watch(dioProvider));

@Riverpod(keepAlive: true)
AppDatabase appDatabase(AppDatabaseRef ref) { /* ... */ }

// ⭐ 組裝 Repository：把它需要的零件 watch 進來注入
@riverpod
ProductRepository productRepository(ProductRepositoryRef ref) {
  return ProductRepositoryImpl(
    ref.watch(productApiProvider),     // 注入 API client
    ref.watch(appDatabaseProvider),    // 注入資料庫
  );
}
```

逐段解釋：

- **每個零件一個 provider**，彼此用 `ref.watch` 串成依賴鏈：`dio → productApi → productRepository`，`appDatabase → productRepository`。
- **`productRepositoryProvider` 回傳的型別是抽象介面 `ProductRepository`**（不是 Impl）。上層拿到的是介面，不知道也不在乎背後是哪個實作。
- **測試時超好換**（第 13 章會用）：

```dart
ProviderScope(
  overrides: [
    // 測試時把真的 repository 換成假的，不碰真網路
    productRepositoryProvider.overrideWithValue(FakeProductRepository()),
  ],
  child: const MyApp(),
)
```

- **`overrideWithValue`**：在測試或不同環境（dev/prod）下，把某個 provider 換成別的實作。**這就是依賴注入的最大好處**——零件可抽換，因為上層只依賴介面、由 Riverpod 統一組裝。

**心智模型**：Riverpod 像「工廠的組裝線」。你定義每個零件怎麼做（provider），它負責在需要時把零件組裝交付，並在測試時讓你抽換任一零件。

---

## 10.6 Application 層：Controller 協調流程

Controller（Riverpod Notifier）夾在 UI 和 Repository 之間，負責「狀態與流程」：

```dart
// features/products/application/product_list_controller.dart
@riverpod
Future<List<Product>> productList(ProductListRef ref) {
  // 只做一件事：跟 Repository 要資料。Riverpod 自動包成 AsyncValue
  return ref.watch(productRepositoryProvider).getProducts();
}
```

對於「有動作」的功能（例如收藏/取消收藏），用 Notifier：

```dart
@riverpod
class FavoriteController extends _$FavoriteController {
  @override
  FutureOr<List<int>> build() => ref.watch(favoriteRepositoryProvider).getFavoriteIds();

  Future<void> toggle(int productId) async {
    final repo = ref.read(favoriteRepositoryProvider);
    state = await AsyncValue.guard(() async {       // 第 07 章學過的 guard
      await repo.toggleFavorite(productId);
      return repo.getFavoriteIds();                 // 回傳更新後的清單
    });
  }
}
```

逐段解釋：

- Controller **不碰網路細節**，只呼叫 `repository.xxx()`。它的工作是「協調」：呼叫 repo、管理 loading/error 狀態（`AsyncValue`）、決定流程。
- 這層讓 UI 變得很薄——UI 只 `watch` 狀態、把使用者動作轉成 `controller.toggle(id)` 呼叫。

---

## 10.7 完整資料流：一次點擊穿越所有層

把整套串起來，看一次「打開商品頁」的完整旅程：

```text
① UI：ProductPage 出現
   ref.watch(productListProvider)
        │ （往下要資料）
        ▼
② Application：productList provider
   呼叫 repository.getProducts()
        │
        ▼
③ Data：ProductRepositoryImpl.getProducts()
   試 API → 存快取 →（失敗則回快取 / 翻譯錯誤）
        │
        ▼
④ Data Source：ProductApi（Retrofit）打 HTTP；AppDatabase 存/讀
        │
        ▲ （資料往上回）
   List<Product> 一路回到 ②，被包成 AsyncValue
        ▲
① UI：AsyncValue.when 畫出 loading / error / data
```

**這就是分層的回報**：
- 想改「資料來源策略」（加 Redis 快取、換 GraphQL）→ 只動 ③ Repository。
- 想改「畫面長相」→ 只動 ① UI。
- 想測「商品邏輯」→ 直接測 ②③，塞假 Repository，不用跑畫面、不用真網路。
- 每一層都能獨立理解、獨立替換。**這就是「好維護」的具體意義。**

---

## 10.8 進階一點：要不要分「API model」和「domain model」？

中大型專案常再多一層：

- **API model（DTO）**：完全對應後端 JSON 結構（第 08 章的 `Product` with `@JsonKey`）。
- **Domain model**：App 內部使用的乾淨模型，不受後端欄位命名/結構影響。
- Repository 負責「把 DTO 轉成 domain model」。

**好處**：後端改欄位名，只要改 Repository 的轉換，App 其他地方不動。**代價**：多寫轉換程式碼。

**建議**：小專案直接用一份 model 就好（別過度設計）；當「後端結構常變」或「同一份資料來自多個來源」時，再引入這層分離。**架構是為了解決痛點，不是為了複雜而複雜。**

---

## 10.9 動手練習

1. 把第 08 章的商品功能重構成分層：`features/products/` 下分 `data`（api + repository）、`application`（provider）、`presentation`（頁面）。
2. 為 `ProductRepository` 寫抽象介面 + 實作，加上「API 失敗回傳本機快取」的降級邏輯。
3. 用 provider 把 `dio → api → repository` 串起來，UI 只 `watch` controller。
4. 寫一個 `FakeProductRepository`（回傳寫死的假資料），用 `overrideWithValue` 在一個測試頁注入它，驗證「不連網也能顯示清單」——體會依賴注入的威力。

---

## 小結

- 沒有架構＝義大利麵：無法重用、無法測試、改一處動全身。
- 分層：**Presentation（UI）→ Application（Controller/狀態）→ Data（Repository）→ Data Source（API/DB）**，每層只跟下一層、只透過抽象介面溝通。
- 資料夾用 **feature-first**（按功能分包），共用的放 `core/`。
- **Repository** 是核心：對上層隱藏「資料從哪來」，集中處理快取/降級/錯誤翻譯，回傳乾淨的領域資料。
- **Riverpod 當 DI 容器**：每個零件一個 provider，用 `ref.watch` 組裝，回傳抽象介面型別；測試/換環境用 `overrideWithValue` 抽換。
- Controller 只協調流程與狀態，不碰網路細節，讓 UI 變薄。
- 架構是為了解決痛點——別過度設計，痛點出現再加層。

---

> 架構穩了，接下來進入「產品化篇」：先讓 App 好看又適應各種螢幕與語言。下一章講主題、響應式佈局與多語系。
> 前往 [第 11 章：主題、響應式與多語系](./11-theming-responsive-i18n.md)。
