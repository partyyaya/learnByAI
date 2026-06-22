# 第 01 章：開發環境與專案初始化

> 這一章我們把環境裝起來，建立第一個專案，跑起來，然後**逐段看懂**預設專案裡的每個檔案與每一行程式碼在做什麼。
> 目標不是「能跑就好」，而是「跑起來後，你知道每個東西為什麼在那裡」。

---

## 1.1 安裝前的心智模型：Flutter 需要哪些東西？

很多人裝環境裝到崩潰，是因為不知道「為什麼要裝這麼多東西」。先建立全貌：

```text
┌─ Flutter SDK ────────────── 核心：dart + flutter 指令、框架原始碼
│
├─ 要做 Android App ─→ 需要 Android Studio（提供 Android SDK + 模擬器）
│
├─ 要做 iOS App（限 macOS）─→ 需要 Xcode（提供 iOS SDK + 模擬器）+ CocoaPods
│
└─ 編輯器（擇一）─→ VS Code（輕量）或 Android Studio（整合度高）
```

**白話翻譯**：
- **Flutter SDK** 是主角，給你 `flutter` 這個指令。
- 但 Flutter「自己畫畫面」之後，還是要把成品**裝到 iOS / Android** 上，所以你需要各平台的「工具鏈」：Android 靠 Android Studio 帶來的 Android SDK，iOS 靠 Xcode。
- 你**不需要兩個平台都裝齊才能開始**。只想先在 Android 模擬器或 Chrome 上看效果，先裝 Android（或只用 Web）就行。

---

## 1.2 安裝 Flutter SDK

### macOS / Windows / Linux 通用觀念

最穩的做法是用官方安裝包或版本管理工具。這裡示範**手動安裝**（最透明，你會知道東西裝在哪）。

```bash
# 1) 到官網下載對應作業系統的 Flutter SDK 壓縮檔，解壓到一個固定位置
#    例如 macOS / Linux 放在 ~/development/flutter
#    （路徑不要有空白或中文，避免某些工具出錯）

# 2) 把 flutter 的 bin 加進 PATH，讓終端機能找到 flutter 指令
#    以 macOS（zsh）為例，編輯 ~/.zshrc 加上這行：
export PATH="$PATH:$HOME/development/flutter/bin"

# 3) 重開終端機，或執行 source ~/.zshrc 讓設定生效
source ~/.zshrc

# 4) 驗證：印出版本就代表 flutter 指令找得到了
flutter --version
```

逐段解釋：

- **「解壓到固定位置」**：Flutter SDK 不是裝進系統，而是一個資料夾。你之後升級 Flutter，常常就是換這個資料夾的內容。**路徑別用中文或空白**是血淚經驗，某些原生建構工具會因此爆掉。
- **`export PATH=...`**：`PATH` 是作業系統「去哪裡找指令」的清單。把 `flutter/bin` 加進去，你在任何資料夾打 `flutter` 才找得到它。這跟 Node.js 安裝後能用 `node` 指令是同個道理。
- **`flutter --version`**：第一個檢查點。印得出版本＝SDK 安裝成功。

> 💡 也可以用版本管理工具 [`fvm`（Flutter Version Management）](https://fvm.app)，讓不同專案用不同 Flutter 版本，團隊協作時很實用。初學先用手動或官方安裝即可，等多專案再導入 fvm。

---

## 1.3 `flutter doctor`：你最該學會的第一個指令

裝完之後，**最重要的一步**是跑健康檢查：

```bash
flutter doctor
```

它會逐項檢查你的環境，輸出長這樣（你的會依平台不同）：

```text
[✓] Flutter (Channel stable, 3.x.x, on macOS ...)
[✓] Android toolchain - develop for Android devices
[!] Xcode - develop for iOS and macOS
    ✗ CocoaPods not installed.
[✓] Chrome - develop for the web
[✓] VS Code
[✓] Connected device (2 available)
```

怎麼讀這份報告：

- **`[✓]`**：這項 OK，不用管。
- **`[!]`**：有警告或缺東西，下面會用 `✗` 告訴你**缺什麼、怎麼補**。例如上面缺 CocoaPods，它通常會附上修復指令。
- **核心心法**：**`flutter doctor` 怎麼說，你就照做。** 它不只報錯，還會給修復建議。初學階段 90% 的環境問題，答案都在這份報告裡。
- 你**不需要把每項都弄成 ✓**。如果這台機器你只想做 Android，iOS（Xcode）那項是 `[!]` 也無所謂。

加上 `-v` 可以看更詳細的診斷：

```bash
flutter doctor -v   # verbose，問題排查時很有用
```

---

## 1.4 裝編輯器與外掛

推薦 **VS Code**（輕量、啟動快）：

1. 安裝 VS Code。
2. 在擴充市集裝兩個官方擴充：**Flutter** 與 **Dart**（裝 Flutter 會自動把 Dart 一起裝上）。
3. 這兩個擴充會給你：自動補全、存檔自動格式化、一鍵 Run/Debug、Hot Reload 按鈕、Widget 大綱檢視。

> Android Studio 也是很好的選擇，整合度更高（模擬器管理、Gradle 設定都在裡面）。兩者擇一即可，本課指令在哪個編輯器都能用。

---

## 1.5 建立第一個專案

```bash
# 在你放專案的資料夾下執行
flutter create my_first_app
cd my_first_app
```

逐段解釋：

- **`flutter create my_first_app`**：用官方範本產生一個完整可跑的專案。`my_first_app` 是專案名，**必須用小寫 + 底線（snake_case）**，不能用大寫或減號——這是 Dart 套件命名規則，違反會直接報錯。
- 這個指令會一次生出 Android、iOS、Web、桌面所有平台的殼，所以資料夾看起來檔案很多，別被嚇到，下一節會逐一拆解。

常用參數（先知道有這些就好）：

```bash
# 指定組織名（會影響套件 id，例如 com.example.myFirstApp）
flutter create --org com.yourcompany my_first_app

# 只產生特定平台的殼（例如只要 Android + iOS）
flutter create --platforms=android,ios my_first_app
```

---

## 1.6 把它跑起來

```bash
# 先看有哪些可用裝置（模擬器、實體機、Chrome）
flutter devices

# 啟動 App（會自動挑一個裝置；多個裝置會問你選哪個）
flutter run
```

- **`flutter devices`**：列出目前抓得到的執行目標。沒有模擬器的話，先在 Android Studio 開一個 Android 模擬器，或用 `flutter run -d chrome` 跑在瀏覽器。
- **`flutter run`**：編譯並安裝到裝置。第一次會比較久（要編譯原生部分），之後就快了。

App 跑起來後，終端機會出現一段提示，這是 **Flutter 開發體驗的核心**：

```text
Flutter run key commands.
r Hot reload.        ← 按 r：熱重載（保留狀態，最常用）
R Hot restart.       ← 按 R：熱重啟（重置狀態，狀態壞掉時用）
q Quit.              ← 按 q：結束
```

- **Hot Reload（`r`）**：改完程式碼存檔，按 `r`，**1 秒內畫面更新，而且保留你當前的狀態**（例如計數器的數字不會歸零）。在 VS Code 裡直接存檔通常就會自動觸發。
- **Hot Restart（`R`）**：整個 App 重來、狀態歸零，但仍比「重新編譯」快很多。當你改了 `main()` 或狀態邏輯、Hot Reload 沒反應時用它。

**心智模型**：Hot Reload 是「把新的畫面程式碼塞進還在跑的 App」，所以狀態留著；Hot Restart 是「App 重開，但跳過重新編譯」。改 UI 用 `r`，改架構/初始化用 `R`。

---

## 1.7 逐一拆解專案資料夾

`flutter create` 生出來的結構（精簡列出重點）：

```text
my_first_app/
├── lib/                  ← ⭐ 你 99% 的時間都在這裡寫 Dart
│   └── main.dart         ← App 進入點
├── test/                 ← 測試程式碼（第 13 章會用到）
├── pubspec.yaml          ← ⭐ 專案設定 + 套件依賴清單（超重要）
├── pubspec.lock          ← 鎖定實際安裝的套件版本（自動產生，別手改）
├── analysis_options.yaml ← 程式碼風格與靜態檢查規則
├── android/              ← Android 原生殼（Gradle、權限、簽章設定）
├── ios/                  ← iOS 原生殼（Xcode 專案、Info.plist）
├── web/                  ← Web 殼（index.html）
├── macos/ windows/ linux/← 桌面平台殼
└── build/                ← 編譯產物（自動產生，會被 .gitignore）
```

關鍵理解：

- **`lib/`**：你寫的所有 Dart 程式碼都放這。後面章節我們會在這裡分出 `features/`、`models/`、`services/` 等子資料夾（第 10 章講架構）。
- **`pubspec.yaml`**：專案的「身分證 + 購物清單」。套件依賴、App 名稱、版本號、要打包的圖片字型，全在這。**這個檔案你會天天改**，下一節專門講。
- **`android/`、`ios/`**：平時很少進去，但**上版時很關鍵**（簽章、權限、App 圖示都在這裡設定，第 14 章詳述）。現在知道「它們是各平台的原生殼」就好。
- **`build/`**：編譯出來的東西，刪掉也沒關係（會重新生成），通常不進版控。

---

## 1.8 `pubspec.yaml` 逐段解讀

這是你最常打交道的設定檔。預設長這樣（節錄並加註解）：

```yaml
name: my_first_app          # 套件名稱，必須 snake_case，程式裡 import 會用到
description: "A new Flutter project."
publish_to: 'none'          # 'none' 代表這是私有 App，不會被誤傳到 pub.dev

version: 1.0.0+1            # ⭐ 版本號：1.0.0 是「給人看的版本」，+1 是「build number」

environment:
  sdk: ^3.5.0              # 這個專案需要的 Dart SDK 版本範圍

dependencies:              # ⭐ 正式執行需要的套件
  flutter:
    sdk: flutter           # Flutter 框架本身
  cupertino_icons: ^1.0.8  # iOS 風格的圖示集

dev_dependencies:          # 只在「開發/測試」需要的套件，不會打包進正式 App
  flutter_test:
    sdk: flutter
  flutter_lints: ^4.0.0    # 程式碼規範檢查規則

flutter:
  uses-material-design: true   # 啟用 Material Design 的圖示等資源
  # assets:                    # 之後要打包圖片/JSON 時在這裡列
  #   - assets/images/
```

逐段解釋幾個重點：

- **`version: 1.0.0+1`**：這個格式要記住。`+` 左邊（`1.0.0`）是 **versionName**，給使用者看的（顯示在商店）；`+` 右邊（`1`）是 **build number / versionCode**，每次上架都要遞增，商店靠它判斷「這是不是更新的版本」。第 14 章上版時會反覆用到。
- **`dependencies` vs `dev_dependencies`**：這個分界很重要。
  - `dependencies`：App 跑起來真的會用到的（例如 Dio 網路套件、Riverpod）。**會被打包進正式 App。**
  - `dev_dependencies`：只有開發時需要的（測試框架、程式碼產生器 build_runner、lint 規則）。**不會進正式包**，所以不會讓 App 變肥。
  - **心智模型**：跟 Node.js 的 `dependencies` / `devDependencies`、或後端的「執行期依賴 / 編譯期依賴」是一樣的概念。
- **`^1.0.8`** 這種 `^`（caret）符號：代表「相容範圍」。`^1.0.8` 表示「>=1.0.8 且 <2.0.0」，也就是允許不破壞相容性的小版本更新。實際裝了哪個版本，記錄在 `pubspec.lock`。

### 怎麼裝套件

```bash
# 方法 A：用指令加（推薦，會自動寫進 pubspec.yaml 並抓最新相容版本）
flutter pub add dio

# 方法 B：手動在 pubspec.yaml 的 dependencies 加一行，再執行：
flutter pub get      # 依 pubspec.yaml 下載/更新套件

# 加只在開發用的套件（寫進 dev_dependencies）
flutter pub add --dev build_runner
```

- **`flutter pub add <套件>`**：到 [pub.dev](https://pub.dev) 找套件、寫進 `pubspec.yaml`、下載，一步到位。**這是現在推薦的做法。**
- **`flutter pub get`**：當你手動改了 `pubspec.yaml`，或剛 clone 別人的專案時，用它把套件補齊。

---

## 1.9 逐段讀懂預設的 `main.dart`

`flutter create` 會生一個「計數器 App」。我們**把它精簡並逐段拆解**——這短短幾十行，藏了 Flutter 最核心的觀念。

```dart
import 'package:flutter/material.dart';

void main() {
  runApp(const MyApp());
}
```

逐段解釋：

- **`import 'package:flutter/material.dart';`**：匯入 Material Design 元件庫。`Scaffold`、`AppBar`、`Text`、`FloatingActionButton` 這些現成元件都來自這裡。`package:` 開頭代表「從套件匯入」（對比 `import './xxx.dart'` 是匯入自己的檔案）。
- **`void main()`**：每個 Dart 程式的進入點，就像 C / Java 的 `main`。Flutter App 從這裡開始跑。
- **`runApp(const MyApp())`**：Flutter 框架的啟動函式。你把「最上層的 Widget」交給它，它就會把這個 Widget 撐滿整個螢幕、開始繪製。`const` 是效能優化（這個 Widget 永遠長一樣，編譯期就建好，不用每次重建）——第 03 章會解釋。

```dart
class MyApp extends StatelessWidget {
  const MyApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'My First App',
      theme: ThemeData(primarySwatch: Colors.blue),
      home: const CounterPage(),
    );
  }
}
```

逐段解釋：

- **`class MyApp extends StatelessWidget`**：定義一個 Widget。`StatelessWidget`＝「無狀態 Widget」，意思是「它畫出來之後，內容不會自己變」（第 03 章會對比 `StatefulWidget`）。
- **`const MyApp({super.key})`**：建構子。`key` 是 Flutter 用來辨識 Widget 的身分證（同樣留到第 03 章詳談），這裡照範本寫 `super.key` 即可。
- **`Widget build(BuildContext context)`**：**整個 Flutter 的核心方法**。Flutter 需要畫這個 Widget 時，就會呼叫 `build`，你要在這裡「回傳這個 Widget 長什麼樣」。
  - **心智模型**：`build` 就像一個函式「輸入狀態 → 輸出畫面」。狀態變了，Flutter 再次呼叫 `build`，畫面就更新。這跟 React 的 render 概念幾乎一樣。
- **`MaterialApp(...)`**：幾乎每個 App 最外層都包這個。它提供路由、主題、語系等「全 App 共用」的基礎建設。
  - `title`：給作業系統看的 App 標題（例如 Android 多工切換畫面）。
  - `theme`：全 App 的配色與樣式（第 11 章深入）。
  - `home`：App 一打開顯示的第一個畫面。

```dart
class CounterPage extends StatefulWidget {
  const CounterPage({super.key});

  @override
  State<CounterPage> createState() => _CounterPageState();
}

class _CounterPageState extends State<CounterPage> {
  int _counter = 0;   // 這就是「狀態」：會變的資料

  void _increment() {
    setState(() {     // ⭐ 告訴 Flutter：「資料變了，請重畫」
      _counter++;
    });
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('計數器')),
      body: Center(
        child: Text('你按了 $_counter 次', style: const TextStyle(fontSize: 24)),
      ),
      floatingActionButton: FloatingActionButton(
        onPressed: _increment,
        child: const Icon(Icons.add),
      ),
    );
  }
}
```

這段是精華，逐段拆：

- **`StatefulWidget`**：有狀態的 Widget。因為計數器的數字「會變」，所以用它而不是 `StatelessWidget`。
- **`State<CounterPage> createState() => _CounterPageState();`**：`StatefulWidget` 的狀態被拆到另一個 `State` 類別裡保管。**為什麼要拆兩個類別？** 因為 Widget 本身會被反覆丟棄重建，但 `State` 物件會被 Flutter「留著」，狀態才不會每次重建就消失（第 03 章詳解這個設計）。
- **`int _counter = 0;`**：這就是**狀態**——會隨使用者操作改變的資料。前面底線 `_` 在 Dart 代表「私有」（只有這個檔案能存取）。
- **`setState(() { _counter++; })`**：**整個 Flutter 互動的核心**。
  - 你不能只寫 `_counter++` 就期待畫面變。你要把「改資料」這件事**包在 `setState` 裡**。
  - `setState` 做兩件事：①執行你給的函式（這裡是 `_counter++`）②**通知 Flutter「這個 Widget 的狀態髒了，請重新呼叫它的 `build`」**。
  - **心智模型**：`setState` ＝「資料改了，請刷新畫面」的開關。沒呼叫它，畫面不會動。這也是初學者最常踩的坑：「我明明改了變數，畫面怎麼沒變？」——因為忘了 `setState`。
  - （補充：到第 06 章學 Riverpod 後，我們會用更好的方式管理狀態，但 `setState` 的原理一定要先懂。）
- **`Scaffold`**：Material 頁面的「鷹架」，提供標準版面：頂部 `appBar`、主體 `body`、浮動按鈕 `floatingActionButton` 等。幾乎每個頁面都用它打底。
- **`Center` → `Text`**：把文字置中。注意這又是「Widget 包 Widget」（第 00 章講的組合）。
- **`Text('你按了 $_counter 次')`**：`$_counter` 是 Dart 的字串插值（string interpolation），把變數塞進字串。每次 `build` 被呼叫，這裡就讀到最新的 `_counter` 值。
- **`floatingActionButton` 的 `onPressed: _increment`**：把「按下去要做的事」設成 `_increment` 函式。注意是 `_increment`（傳函式本身）不是 `_increment()`（那會立刻執行）。

**把整個流程串起來（這就是 Flutter 互動的閉環）**：

```text
使用者按 + 按鈕
   → 觸發 onPressed → 執行 _increment()
   → setState 裡 _counter++，並通知 Flutter「髒了」
   → Flutter 重新呼叫 build()
   → build 裡的 Text 讀到新的 _counter
   → 畫面顯示新數字
```

記住這個閉環：**事件 → 改狀態（setState）→ 重新 build → 畫面更新**。後面所有互動，本質都是這個循環的變形。

---

## 1.10 常用 CLI 指令小抄

```bash
flutter create <name>     # 建立專案
flutter run               # 跑起來（開發模式）
flutter run -d chrome     # 指定跑在 Chrome
flutter devices           # 列出可用裝置
flutter pub add <pkg>     # 加套件
flutter pub get           # 依 pubspec 下載套件
flutter clean             # 清掉 build 產物（遇到怪錯誤先試這個）
flutter doctor            # 環境健檢
flutter analyze           # 靜態檢查程式碼問題
dart format .             # 格式化所有 Dart 檔
```

> 💡 遇到「莫名其妙、改了也沒用」的錯誤，老手的第一反應通常是：`flutter clean` → `flutter pub get` → 重跑。清掉舊的編譯快取常常就好了。

---

## 1.11 動手練習

1. 建一個專案、跑起來，確認看得到計數器、按了會加。
2. 試著把 `Text('你按了 $_counter 次')` 改成你自己的文字，**存檔觸發 Hot Reload**，觀察：數字有沒有歸零？（不會，因為 Hot Reload 保留狀態）
3. 在 `_increment` 裡把 `_counter++` 改成 `_counter += 2`，看看每次加 2。
4. **故意製造一個 bug**：把 `setState(() { _counter++; });` 改成只寫 `_counter++;`（拿掉 setState），重跑，按按鈕——你會發現數字「沒變」（其實變了，只是畫面沒刷新）。**親手體驗一次「忘記 setState」的後果**，你就永遠記得它了。

---

## 小結

- Flutter 環境＝SDK + 各平台工具鏈（Android Studio / Xcode）+ 編輯器；`flutter doctor` 是你最好的嚮導。
- `lib/main.dart` 是進入點，`pubspec.yaml` 是依賴與設定的中樞（記住 `version: x.y.z+build` 與 `dependencies` / `dev_dependencies` 的差別）。
- 預設計數器 App 教會我們：`StatelessWidget` vs `StatefulWidget`、`build()` 是「狀態→畫面」、**`setState` 是觸發畫面更新的開關**。
- 核心閉環：**事件 → setState 改狀態 → 重新 build → 畫面更新**。

---

> 下一章我們補齊語言基礎：Dart。會 JS / Java / Kotlin 的你會很快，但 null safety 與 async/Stream 有些 Flutter 特有的眉角一定要弄懂。
> 前往 [第 02 章：Dart 語言核心](./02-dart-language-core.md)。
