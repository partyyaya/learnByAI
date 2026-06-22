# 第 13 章：測試與品質

> 上線前的保險。沒有測試的 App，每改一行都在賭「會不會弄壞別的地方」。
> Flutter 的測試特別值得學——因為它的測試**跑得快、又能真的「點按鈕、看畫面」**。這章帶你認識三種測試層級、用 Riverpod 的可注入特性做出好測的程式碼，並串起品質工具與 CI。

---

## 13.1 測試金字塔：哪種測試該寫多少

```text
        ╱╲        Integration（整合測試）：少量
       ╱  ╲       跑完整 App、真實流程，最慢最貴
      ╱────╲
     ╱      ╲     Widget（元件測試）：中量
    ╱        ╲    驗證單一畫面/元件的行為，快
   ╱──────────╲
  ╱            ╲  Unit（單元測試）：大量
 ╱______________╲ 純邏輯函式/類別，最快最便宜
```

**原則**：
- **底層多寫**：純邏輯（Repository、Controller、工具函式）用 unit test 大量覆蓋，因為它們最快、最容易測。
- **中層適量**：重要畫面用 widget test 驗「給定狀態，畫面對不對；點了按鈕，行為對不對」。
- **頂層少量**：只對「最關鍵的使用者流程」（登入→下單）寫 integration test，因為它慢。

第 10 章的分層架構在這裡發威：**因為邏輯抽離了 UI、依賴可注入，大部分邏輯都能用最快的 unit test 覆蓋。** 架構好，測試就好寫——這兩件事是一體的。

---

## 13.2 Unit Test：測純邏輯

Flutter 內建 `flutter_test`（新專案就有）。測試檔放在 `test/` 資料夾，檔名以 `_test.dart` 結尾。

```dart
// test/price_calculator_test.dart
import 'package:flutter_test/flutter_test.dart';
import 'package:my_app/price_calculator.dart';

void main() {
  group('PriceCalculator', () {                       // group：把相關測試歸類
    test('套用 10% 折扣', () {
      final result = PriceCalculator.applyDiscount(100, 0.1);
      expect(result, 90);                              // 斷言：結果應該等於 90
    });

    test('折扣不能超過 100%', () {
      expect(
        () => PriceCalculator.applyDiscount(100, 1.5), // 預期會丟例外
        throwsArgumentError,
      );
    });
  });
}
```

逐段解釋：

- **`group('...', () {...})`**：把相關的測試包成一組，報告更清楚。
- **`test('描述', () {...})`**：一個測試案例。描述要寫清楚「測什麼」。
- **`expect(實際值, 期望)`**：**測試的核心**。實際值不等於期望，測試就失敗。
- **`expect(() => ..., throwsArgumentError)`**：驗證「這段程式會丟出特定例外」。
- 跑測試：`flutter test`（跑全部）或 `flutter test test/price_calculator_test.dart`（單檔）。

**結構慣例 AAA**：每個測試分三段——Arrange（準備資料）、Act（執行被測的東西）、Assert（驗證結果）。養成這習慣，測試好讀。

---

## 13.3 測 Repository / Controller：用 mock 隔離依賴

第 10 章的 Repository 依賴 API/資料庫，測試時不該真的連網。用 **mocktail** 做假的依賴：

```bash
flutter pub add --dev mocktail
```

```dart
import 'package:mocktail/mocktail.dart';
import 'package:flutter_test/flutter_test.dart';

// 1) 宣告一個假的 ProductApi
class MockProductApi extends Mock implements ProductApi {}

void main() {
  test('getProducts 成功時回傳清單並寫入快取', () async {
    // Arrange：準備假的依賴與假回應
    final api = MockProductApi();
    final db = MockAppDatabase();
    when(() => api.getProducts(1))                     // 「當有人呼叫 getProducts(1)」
        .thenAnswer((_) async => [Product(id: 1, name: '測試商品', price: 10)]);
    when(() => db.cacheProducts(any())).thenAnswer((_) async {});

    final repo = ProductRepositoryImpl(api, db);

    // Act
    final products = await repo.getProducts();

    // Assert
    expect(products, hasLength(1));
    expect(products.first.name, '測試商品');
    verify(() => db.cacheProducts(any())).called(1);   // 驗證「快取真的被呼叫了一次」
  });
}
```

逐段解釋：

- **`class MockProductApi extends Mock implements ProductApi`**：做一個「假的 API」——它實作了同樣的介面，但行為由我們在測試裡規定。**這能成立，全靠第 10 章 Repository 依賴的是抽象介面、依賴可注入。**
- **`when(() => api.getProducts(1)).thenAnswer(...)`**：規定假 API 的行為——「被這樣呼叫時，回傳這個假資料」。**完全不碰真網路，所以測試快又穩定。**
- **`verify(() => db.cacheProducts(any())).called(1)`**：驗證「某個方法被呼叫了幾次」——確認 repo 真的有去寫快取。
- **測例外**：再寫一個測試，讓 `api.getProducts` `thenThrow(DioException(...))`，驗證 repo 會回傳快取或丟出 `AppException`。

**心智模型**：mock 像「替身演員」。要測導演（Repository）的調度，不需要真的請大明星（真 API/資料庫）來，找個替身按劇本演就好——又快又可控。

### 測 Riverpod provider

```dart
test('productList provider 回傳 repository 的資料', () async {
  final container = ProviderContainer(
    overrides: [
      // 把真 repository 換成假的（第 10 章的 overrideWithValue）
      productRepositoryProvider.overrideWithValue(FakeProductRepository()),
    ],
  );
  addTearDown(container.dispose);                      // 測試結束釋放

  final result = await container.read(productListProvider.future);
  expect(result, isNotEmpty);
});
```

- **`ProviderContainer`**：在「沒有 Widget」的純測試環境裡跑 Riverpod。
- **`overrides`**：注入假依賴——這就是第 10 章依賴注入「為了好測試」的兌現。

---

## 13.4 Widget Test：測畫面與互動

Widget test 能「建立一個畫面、找元件、模擬點擊、驗證結果」，而且**不用真的開模擬器，跑在記憶體裡，很快**。

```dart
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter/material.dart';

void main() {
  testWidgets('計數器點 + 會加 1', (WidgetTester tester) async {
    // 1) 把要測的 Widget 放進測試環境並渲染
    await tester.pumpWidget(const MaterialApp(home: CounterPage()));

    // 2) 一開始畫面有 '0'、沒有 '1'
    expect(find.text('0'), findsOneWidget);
    expect(find.text('1'), findsNothing);

    // 3) 找到 + 按鈕並點它
    await tester.tap(find.byIcon(Icons.add));
    await tester.pump();                               // 觸發重建（處理 setState）

    // 4) 現在應該顯示 '1'
    expect(find.text('1'), findsOneWidget);
  });
}
```

逐段解釋（**這是 widget test 的標準節奏**）：

- **`testWidgets(..., (tester) async {...})`**：widget test 的進入點，`tester` 是你的「機器人」，能渲染、點擊、輸入。
- **`tester.pumpWidget(...)`**：把 Widget 建立並畫出來（建議包一層 `MaterialApp`，提供 Directionality/Theme 等基礎）。
- **`find.text('0')` / `find.byIcon(...)` / `find.byType(...)`**：在畫面上「找元件」。`find` 配合下面的 matcher 使用。
- **`expect(find.text('0'), findsOneWidget)`**：斷言「畫面上正好有一個顯示 0 的 Widget」。其他 matcher：`findsNothing`、`findsNWidgets(n)`、`findsWidgets`。
- **`tester.tap(...)`** 後 **`tester.pump()`**：點擊後**一定要 `pump()`**——它「推進一幀」，讓 setState/狀態變更反映到畫面。**忘了 pump 是 widget test 第一大坑**（點了但畫面沒更新，斷言失敗）。
- **`pumpAndSettle()`**：一直 pump 直到所有動畫結束（測有動畫/轉場的畫面時用）。

### 測有 Riverpod 的 Widget

```dart
await tester.pumpWidget(
  ProviderScope(
    overrides: [productRepositoryProvider.overrideWithValue(FakeProductRepository())],
    child: const MaterialApp(home: ProductPage()),
  ),
);
await tester.pumpAndSettle();                          // 等 FutureProvider 載完
expect(find.text('假商品 A'), findsOneWidget);
```

- 用 `ProviderScope(overrides: ...)` 包起來注入假 repository——**測 UI 時也不碰真網路**。第 10 章架構的好處再次兌現。

---

## 13.5 Integration Test：跑真的 App 流程

整合測試在真實裝置/模擬器上跑完整 App，驗證端到端流程。

```bash
flutter pub add --dev integration_test  # 它來自 sdk，加進 dev_dependencies
```

```dart
// integration_test/login_flow_test.dart
import 'package:integration_test/integration_test.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('登入流程', (tester) async {
    app.main();                                        // 啟動真的 App
    await tester.pumpAndSettle();

    await tester.enterText(find.byKey(const Key('email')), 'test@x.com');
    await tester.enterText(find.byKey(const Key('password')), '123456');
    await tester.tap(find.byKey(const Key('loginBtn')));
    await tester.pumpAndSettle();

    expect(find.text('歡迎回來'), findsOneWidget);       // 驗證有進到首頁
  });
}
```

逐段解釋：

- **`app.main()`**：直接啟動整個 App（不是單一畫面），所以這是「最接近真實使用者」的測試。
- **`tester.enterText(find.byKey(...), '...')`**：往輸入框打字。**這裡用 `Key` 來定位元件**——正式專案會給重要元件加 `key: Key('email')`，讓測試穩定地找到它。
- 跑：`flutter test integration_test/login_flow_test.dart`（需連模擬器/裝置）。
- **因為它慢、要裝置**，只對關鍵流程寫幾條即可（回到 13.1 金字塔）。

---

## 13.6 Golden Test：用「截圖比對」防止 UI 走樣

```dart
testWidgets('商品卡片外觀', (tester) async {
  await tester.pumpWidget(/* 你的 ProductCard */);
  await expectLater(
    find.byType(ProductCard),
    matchesGoldenFile('goldens/product_card.png'),     // 跟基準圖比對
  );
});
```

- **`matchesGoldenFile`**：把當前畫面截圖，跟一張「基準圖」逐像素比對。**UI 不小心改壞了（位移、變色）會被抓出來。**
- 第一次跑 `flutter test --update-goldens` 產生基準圖；之後 UI 變動導致不一致就會失敗。適合「設計系統元件」防退化。

---

## 13.7 靜態品質：analyze、lint、format、coverage

測試之外，這些工具天天用：

```bash
flutter analyze        # 靜態分析：抓出潛在錯誤、未使用的變數、型別問題
dart format .          # 統一程式碼格式
flutter test --coverage  # 跑測試並產生覆蓋率報告（coverage/lcov.info）
```

- **`analysis_options.yaml`**（第 01 章看過）：設定 lint 規則。`flutter_lints` 是官方推薦的基礎組；可以再加 `riverpod_lint`（第 06 章裝過）抓 Riverpod 的誤用。
- **lint 不是龜毛，是省時間**：它在你寫程式當下就提醒「這裡可能有 bug / 該加 const / 沒處理 null」，比上線後出包便宜太多。

---

## 13.8 串進 CI：每次 push 自動把關

把上面這些放進 CI（第 14 章會接上完整的建構/發佈），每次推程式碼自動跑：

```yaml
# .github/workflows/ci.yml（GitHub Actions 示意）
name: CI
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: subosito/flutter-action@v2        # 安裝 Flutter
        with: { channel: stable }
      - run: flutter pub get
      - run: dart format --set-exit-if-changed .  # 格式不對就讓 CI 失敗
      - run: flutter analyze                       # 靜態分析
      - run: flutter test --coverage               # 跑測試
```

逐段解釋：

- **`on: [push, pull_request]`**：每次 push 或開 PR 都觸發。
- **`dart format --set-exit-if-changed`**：如果有人沒格式化就 push，CI 直接失敗——強制全隊風格一致。
- **`flutter analyze` + `flutter test`**：把關。任何一步失敗，PR 上會顯示紅叉，避免壞程式碼合進主幹。
- **這就是「品質自動化」**：人會忘記跑測試，CI 不會。下一章會在這基礎上加「自動打包、自動上架」。

---

## 13.9 動手練習

1. 為第 02 章的 `sum` 或一個折扣計算函式寫 unit test，含正常與例外情況。
2. 用 mocktail 為第 10 章的 `ProductRepositoryImpl` 寫測試：API 成功、API 失敗回快取兩種情境。
3. 為計數器寫 widget test：點 + 三次後顯示 3（注意每次 tap 後 pump）。
4. 設一個 GitHub Actions，push 時自動跑 `analyze` + `test`。

---

## 小結

- 測試金字塔：unit（大量、純邏輯、最快）> widget（適量、畫面互動）> integration（少量、完整流程、慢）。
- **好架構＝好測試**：第 10 章的依賴注入讓你能用 `mock` / `override` 隔離網路與資料庫，邏輯都能快速 unit test。
- Unit：`group`/`test`/`expect`，用 mocktail 的 `when`/`verify` 做假依賴。
- Widget：`testWidgets` + `tester.pumpWidget`/`tap`/`enterText`，**互動後一定要 `pump()`**，用 `find` + matcher 斷言；Riverpod 用 `ProviderScope(overrides:)` 注入假依賴。
- Integration：`app.main()` 跑真流程，用 `Key` 定位元件，只測關鍵路徑。
- 品質工具：`flutter analyze`、`dart format`、`--coverage`、lint 規則；串進 CI 每次 push 自動把關。

---

> 程式碼有測試撐腰了，終於要把它送到使用者手上。下一章——你指定的重頭戲：打包與上版。
> 前往 [第 14 章：打包與上版](./14-build-sign-and-publish.md)。
