# 第 11 章：主題、響應式與多語系

> 功能會了，接著讓 App「像個成熟產品」：統一的視覺主題、支援深色模式、適應各種螢幕尺寸、能切換語言。
> 這三件事的共同精神都是：**別把樣式/尺寸/文字寫死，而是讓它們「跟著環境變」**——跟著主題、跟著螢幕、跟著語系。

---

## 11.1 主題（Theme）：別把顏色寫死

新手常把顏色直接寫在每個 Widget：`color: Color(0xFF6750A4)`。問題是——改一次品牌色要改幾百處，而且做不了深色模式。**正解是把樣式集中在「主題」，Widget 從主題取色。**

```dart
MaterialApp(
  theme: ThemeData(
    useMaterial3: true,                                 // 啟用 Material 3
    colorScheme: ColorScheme.fromSeed(                  // ⭐ 從一個「種子色」自動生成整套配色
      seedColor: const Color(0xFF6750A4),
    ),
  ),
  home: const HomePage(),
)
```

逐段解釋：

- **`useMaterial3: true`**：採用最新的 Material 3 設計語言（圓角、新配色系統）。新專案建議都開。
- **`ColorScheme.fromSeed(seedColor: ...)`**：**這是 Material 3 的核心魔法**。你只給「一個品牌主色（種子）」，Flutter 自動推算出一整套協調的配色（主色、次色、背景、錯誤色、文字色…），而且會自動算出對比度合格的搭配。**你不用手調幾十個顏色。**
- **心智模型**：種子色像「一滴顏料」，Flutter 幫你調出整個調色盤。改品牌色＝只換那一滴。

### 從 Widget 取用主題色（而不是寫死）

```dart
@override
Widget build(BuildContext context) {
  final scheme = Theme.of(context).colorScheme;        // 第 03 章學過的 .of(context)
  return Container(
    color: scheme.primary,                              // 用主題的主色
    child: Text(
      '標題',
      style: Theme.of(context).textTheme.headlineSmall  // 用主題定義的文字樣式
          ?.copyWith(color: scheme.onPrimary),          // onPrimary = 「在主色上」該用的文字色
    ),
  );
}
```

逐段解釋：

- **`Theme.of(context).colorScheme`**：往上拿到當前主題的配色。`scheme.primary`、`scheme.surface`、`scheme.error` 等都是語意化的名字。
- **`onPrimary` / `onSurface`**：Material 3 的命名慣例——`onX` 代表「畫在 X 顏色之上的內容色」。主色背景上的文字用 `onPrimary`，自動保證對比度。
- **`textTheme.headlineSmall`**：主題預先定義好的一組文字樣式（標題、內文、說明）。用它而不是每次自己設 `fontSize`，整個 App 字級才一致。
- **`.copyWith(...)`**：在既有樣式上「微調某幾個屬性」，其他保留。常用。

**為什麼一定要從主題取色？** 因為下一節的深色模式，就是靠「同一個 Widget、不同主題下取到不同顏色」實現的。寫死顏色＝深色模式直接放棄。

---

## 11.2 深色模式：定義兩套主題 + 一個開關

```dart
MaterialApp(
  theme: ThemeData(                                       // 淺色主題
    useMaterial3: true,
    colorScheme: ColorScheme.fromSeed(seedColor: seed),
  ),
  darkTheme: ThemeData(                                   // 深色主題
    useMaterial3: true,
    colorScheme: ColorScheme.fromSeed(
      seedColor: seed,
      brightness: Brightness.dark,                        // 同種子色、深色版
    ),
  ),
  themeMode: ThemeMode.system,                            // 跟隨系統 / light / dark
  home: const HomePage(),
)
```

逐段解釋：

- **`theme` + `darkTheme`**：定義淺色、深色兩套。同一個種子色加 `brightness: Brightness.dark` 就生出協調的深色版。
- **`themeMode`**：決定用哪套。`ThemeMode.system`（跟隨系統設定）、`.light`、`.dark`。
- 因為你的 Widget 都用 `Theme.of(context).colorScheme.xxx` 取色（沒寫死），**切換主題時所有畫面自動換色，一行 Widget 都不用改**。這就是 11.1 堅持「別寫死顏色」的回報。

### 接上 Riverpod：做一個「使用者可切換」的主題開關

把第 06 章的 Riverpod、第 09 章的 shared_preferences 接起來，做「記住使用者選的主題」：

```dart
// theme_controller.dart
@riverpod
class ThemeModeController extends _$ThemeModeController {
  @override
  ThemeMode build() {
    // 啟動時從 shared_preferences 讀使用者上次的選擇
    final saved = ref.watch(prefsProvider).getString('themeMode');
    return switch (saved) {
      'dark' => ThemeMode.dark,
      'light' => ThemeMode.light,
      _ => ThemeMode.system,
    };
  }

  Future<void> setMode(ThemeMode mode) async {
    state = mode;                                          // 改狀態 → UI 自動換主題
    await ref.read(prefsProvider).setString('themeMode', mode.name);  // 存起來
  }
}
```

接到 App：

```dart
class MyApp extends ConsumerWidget {
  const MyApp({super.key});
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final themeMode = ref.watch(themeModeControllerProvider);   // 監聽
    return MaterialApp.router(
      theme: lightTheme,
      darkTheme: darkTheme,
      themeMode: themeMode,                                     // 跟著 provider 變
      routerConfig: ref.watch(routerProvider),
    );
  }
}
```

逐段解釋：

- `themeMode` 由 Riverpod 提供，使用者一切換 → `setMode` 改 `state` → `ref.watch` 它的 `MaterialApp` 重建 → 整個 App 換主題，同時把選擇存進 shared_preferences。
- **這就是前面所有章節的綜合應用**：狀態管理（06）+ 本機儲存（09）+ 主題。下次開 App，`build` 從 prefs 讀回上次的選擇——設定被記住了。

---

## 11.3 響應式 vs 自適應：先分清兩個詞

- **響應式（Responsive）**：**同一套 UI**，依螢幕大小調整尺寸/排列（手機單欄、平板雙欄）。
- **自適應（Adaptive）**：依**平台或裝置特性**給不同的元件/行為（iOS 用 Cupertino 風格、Android 用 Material；有滑鼠時顯示 hover）。

手機 App 最常用的是**響應式**（處理不同手機尺寸、橫豎屏、平板），這節重點講它。

---

## 11.4 響應式工具一：MediaQuery（拿螢幕資訊）

```dart
@override
Widget build(BuildContext context) {
  final size = MediaQuery.sizeOf(context);              // 螢幕邏輯尺寸
  final isTablet = size.width >= 600;                   // 自訂斷點：>=600 當平板

  return GridView.count(
    crossAxisCount: isTablet ? 4 : 2,                   // 平板一排 4 個、手機 2 個
    children: [/* ... */],
  );
}
```

逐段解釋：

- **`MediaQuery.sizeOf(context)`**：拿到螢幕的寬高（邏輯像素）。也有 `MediaQuery.paddingOf`（瀏海/狀態列）、`viewInsetsOf`（鍵盤高度）等。
- **`MediaQuery.sizeOf` 而非舊的 `MediaQuery.of(context).size`**：新版的 `sizeOf` 只在「尺寸真的變」時才重建，效能較好（舊的任何 MediaQuery 屬性變都重建）。
- **斷點（breakpoint）**：用寬度判斷裝置類型。常見斷點：手機 `<600`、平板 `600~840`、桌面 `>840`（Material 的建議值）。
- **缺點**：`MediaQuery` 拿的是「整個螢幕」，不是「這個 Widget 實際拿到的空間」。當 Widget 只佔畫面一部分（例如在分割視圖裡），用 MediaQuery 會判斷錯——這時該用 `LayoutBuilder`。

---

## 11.5 響應式工具二：LayoutBuilder（拿「父層給的空間」）

```dart
LayoutBuilder(
  builder: (context, constraints) {
    // constraints 是「父層實際給這個位置的約束」（回想第 04 章約束模型）
    if (constraints.maxWidth >= 600) {
      return _TwoColumnLayout();      // 空間夠寬 → 雙欄
    } else {
      return _SingleColumnLayout();   // 空間窄 → 單欄
    }
  },
)
```

逐段解釋：

- **`LayoutBuilder`**：給你 `constraints`——**這個 Widget 在它的位置上「實際能用多大空間」**（第 04 章的約束）。
- **跟 MediaQuery 的差別**：MediaQuery 是「整個螢幕多大」，LayoutBuilder 是「我這塊區域多大」。做「元件層級」的響應式（例如一張卡片在不同容器裡自適應）要用 LayoutBuilder；做「頁面層級」（手機/平板切版型）用哪個都行。
- **心智模型**：MediaQuery 問「房子多大」，LayoutBuilder 問「我這個房間多大」。

### 處理橫豎屏

```dart
final orientation = MediaQuery.orientationOf(context);
final columns = orientation == Orientation.landscape ? 3 : 2;   // 橫屏多放一欄
```

---

## 11.6 多語系（i18n）：讓 App 會說多國語言

Flutter 官方的多語系方案是 `flutter_localizations` + `intl` + ARB 檔，由工具自動產生型別安全的翻譯類別。

### 設定

`pubspec.yaml`：

```yaml
dependencies:
  flutter_localizations:
    sdk: flutter
  intl: any

flutter:
  generate: true            # ⭐ 開啟自動產生翻譯程式碼
```

專案根目錄建 `l10n.yaml`：

```yaml
arb-dir: lib/l10n            # 翻譯檔放哪
template-arb-file: app_en.arb # 以哪個語言為範本
output-localization-file: app_localizations.dart  # 產生的檔名
```

### 寫翻譯檔（ARB）

```jsonc
// lib/l10n/app_en.arb（英文，範本）
{
  "helloUser": "Hello, {name}!",
  "@helloUser": {
    "placeholders": { "name": { "type": "String" } }
  },
  "itemCount": "{count} items"
}
```

```jsonc
// lib/l10n/app_zh.arb（中文）
{
  "helloUser": "你好，{name}！",
  "itemCount": "{count} 個項目"
}
```

逐段解釋：

- **ARB（Application Resource Bundle）**：就是一個 JSON，key 是「字串代號」，value 是該語言的譯文。
- **`{name}` 佔位符**：可以把變數插進譯文。`@helloUser` 區塊宣告這個佔位符的型別（讓產生的方法是型別安全的 `helloUser(String name)`）。
- 每多一種語言，就多一個 `app_xx.arb`，key 要一致。
- 跑 `flutter gen-l10n`（或直接 `flutter run`，`generate: true` 會自動跑），產生 `AppLocalizations` 類別。

### 在 App 接上 + 使用

```dart
MaterialApp(
  localizationsDelegates: AppLocalizations.localizationsDelegates,
  supportedLocales: AppLocalizations.supportedLocales,   // 支援的語言清單
  // locale: const Locale('zh'),   // 不設＝跟隨系統語言
  home: const HomePage(),
)
```

```dart
@override
Widget build(BuildContext context) {
  final l10n = AppLocalizations.of(context)!;            // 拿到當前語言的翻譯
  return Column(
    children: [
      Text(l10n.helloUser('Amy')),                       // 英文→Hello, Amy! 中文→你好，Amy！
      Text(l10n.itemCount(5)),
    ],
  );
}
```

逐段解釋：

- **`AppLocalizations.of(context)`**：又是 `.of(context)`（第 03 章）——往上拿到「當前語系的翻譯包」。系統語言是中文就拿到中文那套。
- **`l10n.helloUser('Amy')`**：呼叫產生出來的**型別安全方法**。打錯 key 或漏傳參數，編譯期就報錯——比到處寫 `'你好'` 字串安全太多。
- **切換語言**：把 `locale` 接到一個 Riverpod provider（做法跟 11.2 的主題開關一模一樣），使用者選語言 → 改 provider → 全 App 重新從對應 ARB 取字。

**心智模型**：i18n ＝「把所有寫死的文字抽成代號，依當前語言查表」。`l10n.helloUser` 就是查表動作，表（ARB）依語系切換。

---

## 11.7 小提醒：別忘了字級也要能放大

無障礙（accessibility）使用者會把系統字級調大。**別用固定 `fontSize` 硬寫死到絕對不能變**——用 `textTheme` 的語意樣式，Flutter 會尊重使用者的字級設定。測試時把系統字級調到最大，確認版面不會爆掉（搭配第 04 章的 overflow 處理）。

---

## 11.8 動手練習

1. 用 `ColorScheme.fromSeed` 設一個你喜歡的品牌色，做出淺/深兩套主題，加一個按鈕切換 `themeMode`（先用 `StatefulWidget` 或 Riverpod 皆可）。
2. 把主題選擇用 shared_preferences 記住，重開 App 仍保留。
3. 用 `LayoutBuilder` 做一個清單頁：寬度 >=600 時兩欄、否則一欄。
4. 設定 i18n，加入中英兩種 ARB，做一個帶 `{name}` 佔位符的歡迎字串，並做一個語言切換開關。

---

## 小結

- **別寫死樣式**：把顏色/字級集中到 `ThemeData`，Widget 用 `Theme.of(context).colorScheme` / `textTheme` 取用。Material 3 的 `ColorScheme.fromSeed` 一個種子色生成整套配色。
- 深色模式＝定義 `theme` + `darkTheme` + `themeMode`；因為沒寫死顏色，切換時全自動換色。接 Riverpod + shared_preferences 可記住使用者選擇。
- 響應式（同 UI 依尺寸調整）用 **MediaQuery**（整個螢幕）或 **LayoutBuilder**（這塊區域實際空間）；用斷點（600/840）切版型。
- 多語系：`flutter_localizations` + `intl` + ARB 檔，`flutter gen-l10n` 產生型別安全的 `AppLocalizations`，用 `l10n.xxx()` 取字。
- 共同精神：**樣式、尺寸、文字都「跟著環境變」**，不寫死。

---

> App 好看又能適應環境了。下一章讓它「碰得到裝置」：相機、定位、權限、推播——透過 Platform Channel 與原生能力整合。
> 前往 [第 12 章：原生整合與裝置能力](./12-native-integration-device.md)。
