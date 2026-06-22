# 第 14 章：打包與上版

> 寫了這麼久，終於要把 App 送到使用者手上。這章是「從程式碼到商店」的完整流程：
> 建構模式、App 身分（名稱/圖示/版本）、多環境（dev/prod）、**Android 簽章與上 Google Play**、**iOS 憑證與上 App Store / TestFlight**，最後用 CI/CD 自動化，並介紹 Shorebird 熱更新。
> 上版是 Flutter 學習曲線最後一道坎——卡關幾乎都在「簽章」與「憑證」。這章把這兩個魔王講清楚。

---

## 14.1 建構模式：debug / profile / release

Flutter 有三種建構模式，先搞懂差別：

| 模式 | 用途 | 特性 |
|------|------|------|
| **debug** | 日常開發 | 有 Hot Reload、assert、除錯資訊；**慢、體積大**（用 JIT，第 00 章） |
| **profile** | 效能分析 | 接近 release 但保留效能追蹤工具 |
| **release** | **上架/正式** | AOT 編譯、最佳化、移除除錯資訊；**快、體積小** |

```bash
flutter run                    # 預設 debug
flutter run --release          # 用 release 跑（測上線效能/體積）
flutter build apk --release    # 建構正式版
```

**鐵則：上架一律 release**。新手常見錯誤是拿 debug 版去評估效能（「怎麼這麼卡？」）——debug 本來就慢，用 release 測才準。

---

## 14.2 App 身分：套件 id、名稱、圖示、啟動畫面

上架前要設定 App 的「身分證」。

### 套件 id（Bundle ID / Application ID）

這是 App 在商店與系統裡的**唯一識別碼**，格式像 `com.yourcompany.appname`。

- **一旦上架就不能改**（改了等於另一個 App）。所以建專案時就用 `--org` 設好（第 01 章）：`flutter create --org com.yourcompany my_app`。
- Android 在 `android/app/build.gradle` 的 `applicationId`；iOS 在 Xcode 的 `Bundle Identifier`。

### App 顯示名稱與圖示

圖示用 `flutter_launcher_icons` 套件一鍵生成各尺寸（手動切幾十種尺寸是惡夢）：

```bash
flutter pub add --dev flutter_launcher_icons
```

```yaml
# pubspec.yaml
flutter_launcher_icons:
  android: true
  ios: true
  image_path: "assets/icon/icon.png"     # 準備一張 1024x1024 的圖
  adaptive_icon_background: "#FFFFFF"      # Android 自適應圖示背景
```

```bash
dart run flutter_launcher_icons            # 一鍵生成所有尺寸並套用
```

- 啟動畫面（splash）可用 `flutter_native_splash` 同理生成。
- 顯示名稱：Android 在 `AndroidManifest.xml` 的 `android:label`；iOS 在 `Info.plist` 的 `CFBundleDisplayName`。

---

## 14.3 版本號：`version: x.y.z+build`（第 01 章的回收）

`pubspec.yaml` 的版本號上架時至關重要：

```yaml
version: 1.2.0+5
#        ↑      ↑
#   versionName  build number / versionCode
```

逐段解釋：

- **`1.2.0`（versionName）**：給使用者看的版本，顯示在商店頁。語意化版本：大改動進位主版號。
- **`+5`（build number）**：**每次上傳到商店都必須比上一次大**。商店靠它分辨「這是新的建構」。**最常見的上架失敗就是「build number 沒遞增」**（商店回「這個版本已存在」）。
- 兩個商店各自記錄，習慣上同步遞增即可。

---

## 14.4 多環境（Flavors）：dev / staging / prod 分開

正式 App 通常有多套環境：開發打測試 API、正式打正式 API。**最簡單的做法用 `--dart-define`** 在建構時注入設定：

```dart
// lib/core/config/env.dart
class Env {
  // 從建構參數讀，沒給就用預設
  static const apiBaseUrl = String.fromEnvironment(
    'API_BASE_URL',
    defaultValue: 'https://dev-api.example.com',
  );
  static const isProd = bool.fromEnvironment('IS_PROD', defaultValue: false);
}
```

```bash
# 開發
flutter run --dart-define=API_BASE_URL=https://dev-api.example.com

# 正式建構
flutter build apk --release \
  --dart-define=API_BASE_URL=https://api.example.com \
  --dart-define=IS_PROD=true
```

逐段解釋：

- **`String.fromEnvironment('KEY')`**：在**編譯期**讀取 `--dart-define` 傳入的值。第 08 章 Dio 的 `baseUrl` 就接 `Env.apiBaseUrl`，這樣同一份程式碼能建出指向不同 API 的版本。
- **為什麼用編譯期注入而非 .env 檔**：編譯期常數會被 tree-shaking 最佳化，且不會把測試環境網址打包進正式版。
- 進階需求（不同環境不同 App id/圖示、同裝置可並存）才需要真正的原生 flavors（Android product flavors / iOS schemes），多管理參數常用 `--dart-define-from-file=config.json`。先用 dart-define 起步。

---

## 14.5 魔王一：Android 簽章與上架

### 為什麼要簽章

每個上架的 Android App 都要用一把「金鑰」簽署，證明「這個更新確實來自原作者」。**這把金鑰（keystore）弄丟了，你就再也無法更新這個 App**（只能重新上架成新 App）——所以**務必妥善備份**。

### 步驟 1：產生 keystore

```bash
keytool -genkey -v -keystore ~/upload-keystore.jks \
  -keyalg RSA -keysize 2048 -validity 10000 -alias upload
```

- 產生一把 `.jks` 金鑰檔，會問你密碼與一些資訊。**密碼與檔案都要備份保存**（建議存進公司的密碼管理庫）。

### 步驟 2：告訴 Gradle 金鑰在哪（且別把密碼進版控）

```properties
# android/key.properties（這個檔要加進 .gitignore，絕不上傳！）
storePassword=你的store密碼
keyPassword=你的key密碼
keyAlias=upload
storeFile=/Users/you/upload-keystore.jks
```

```gradle
// android/app/build.gradle —— 讀 key.properties 並設定簽章
def keystoreProperties = new Properties()
def keystorePropertiesFile = rootProject.file('key.properties')
if (keystorePropertiesFile.exists()) {
    keystoreProperties.load(new FileInputStream(keystorePropertiesFile))
}

android {
    signingConfigs {
        release {
            keyAlias keystoreProperties['keyAlias']
            keyPassword keystoreProperties['keyPassword']
            storeFile file(keystoreProperties['storeFile'])
            storePassword keystoreProperties['storePassword']
        }
    }
    buildTypes {
        release {
            signingConfig signingConfigs.release   // release 版用上面的簽章
        }
    }
}
```

逐段解釋：

- **`key.properties` 一定要 `.gitignore`**：裡面是金鑰密碼，外洩等於別人能冒名更新你的 App。
- Gradle 在建 release 版時讀這個檔，用你的 keystore 簽署。設好一次，之後建構自動簽章。

### 步驟 3：建構上傳檔（用 AAB，不是 APK）

```bash
flutter build appbundle --release
# 產物：build/app/outputs/bundle/release/app-release.aab
```

- **AAB（Android App Bundle）**：Google Play **現在要求的上傳格式**。Play 會依使用者裝置動態產生最佳化的 APK（體積更小）。
- APK（`flutter build apk`）仍可用於「直接安裝/側載/非 Play 商店」，但上 Google Play 用 **AAB**。

### 步驟 4：上 Google Play Console

1. 註冊 [Google Play Console](https://play.google.com/console)（一次性 $25 美金）。
2. 建立應用程式，填寫商店資訊（名稱、描述、截圖、隱私權政策連結——**隱私權政策現在是必填**）。
3. 先傳到「**內部測試（Internal testing）**」軌道，加測試人員 email 試裝——**別一上來就正式發佈**。
4. 填寫內容分級、資料安全表單、目標對象。
5. 確認無誤後，從測試軌道「**升版到正式（Production）**」，提交審核。審核通常數小時到幾天。

---

## 14.6 魔王二：iOS 憑證與上架（需 macOS + Xcode）

iOS 的簽章機制比 Android 複雜，但 Xcode 的「自動簽章」幫你省很多事。

### 前置：Apple Developer Program

- 需加入 [Apple Developer Program](https://developer.apple.com)（年費 $99 美金）。
- 核心概念（了解即可，自動簽章會處理大部分）：
  - **Certificate（憑證）**：證明「你是誰」。
  - **App ID**：你的 Bundle Identifier。
  - **Provisioning Profile（描述檔）**：綁定「憑證 + App ID + 裝置」，授權這個 App 能被安裝/上架。

### 步驟 1：在 Xcode 設定簽章

```bash
open ios/Runner.xcworkspace      # 用 Xcode 打開（注意是 .xcworkspace 不是 .xcodeproj）
```

在 Xcode 的 **Runner → Signing & Capabilities**：

- 勾選 **Automatically manage signing**（自動簽章，強烈建議）。
- 選你的 **Team**（你的 Apple Developer 帳號）。
- 設定 **Bundle Identifier**（要跟 App Store Connect 建立的一致）。
- Xcode 會自動產生並管理憑證與描述檔——**這省掉手動處理憑證的大量痛苦**。

### 步驟 2：在 App Store Connect 建立 App

1. 到 [App Store Connect](https://appstoreconnect.apple.com) → 我的 App → 新增 App。
2. 填 Bundle ID（要跟 Xcode 一致）、名稱、主要語言。

### 步驟 3：建構並上傳

```bash
flutter build ipa --release
# 產物：build/ios/archive/Runner.xcarchive 與 build/ios/ipa/*.ipa
```

上傳方式二選一：

- **Xcode**：打開產生的 archive，用 Organizer 的「Distribute App」上傳。
- **Transporter**（Apple 的 App）：把 `.ipa` 拖進去上傳，最簡單。
- **命令列**：`xcrun altool` / `xcrun notarytool`（CI 常用）。

### 步驟 4：TestFlight → 正式上架

- 上傳後，建構版本會出現在 **TestFlight**。**先用 TestFlight 發給測試人員試用**（內部測試人員免審核、外部測試需簡單審核）——這是 iOS 的「內部測試軌道」。
- 確認沒問題後，到 App Store 頁面填寫商店資訊、截圖、送審。**Apple 審核較嚴格**（會實際操作你的 App），常見退件原因：權限用途說明（第 12 章的 `Info.plist`）不清楚、有 bug、違反設計規範。

---

## 14.7 程式碼混淆（保護程式碼）

```bash
flutter build apk --release --obfuscate --split-debug-info=build/symbols
flutter build ipa --release --obfuscate --split-debug-info=build/symbols
```

逐段解釋：

- **`--obfuscate`**：把 Dart 程式碼的類別/方法名混淆成無意義字串，增加被逆向工程的難度。
- **`--split-debug-info=...`**：把「混淆對照表」單獨存起來。**這個資料夾要保存**——將來線上 crash 報告是混淆後的名字，要靠它「還原」成可讀的堆疊。

---

## 14.8 CI/CD：自動化打包與發佈

第 13 章的 CI 只跑測試，這裡再加「自動建構與上傳」。兩個主流選擇：

- **Codemagic**：專為 Flutter 設計，**內建 iOS 簽章/上傳的 UI 設定**（最省心，新手友善），免費額度夠小團隊用。
- **GitHub Actions**：通用、免費額度多、與 repo 整合好，但 iOS 簽章要自己設定（憑證放進 secrets）。

GitHub Actions 範例（在第 13 章 CI 之上加發佈）：

```yaml
# .github/workflows/release.yml
name: Release
on:
  push:
    tags: ['v*']                              # 打 tag（v1.2.0）時才觸發發佈
jobs:
  android:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: subosito/flutter-action@v2
        with: { channel: stable }
      - run: flutter pub get
      # 從 secrets 還原 keystore（base64 編碼存在 GitHub secrets）
      - run: echo "${{ secrets.KEYSTORE_BASE64 }}" | base64 -d > android/upload.jks
      - run: flutter build appbundle --release --dart-define=IS_PROD=true
      # 用 fastlane 或官方 action 上傳到 Play Console 的內部測試軌道
      - uses: r0adkll/upload-google-play@v1
        with:
          serviceAccountJsonPlainText: ${{ secrets.PLAY_SERVICE_ACCOUNT }}
          packageName: com.yourcompany.app
          releaseFiles: build/app/outputs/bundle/release/app-release.aab
          track: internal
```

逐段解釋：

- **`on: push: tags: ['v*']`**：只在「打版本 tag」時發佈，避免每次 push 都上傳。
- **`secrets.KEYSTORE_BASE64`**：金鑰不能進版控（14.5），所以 base64 編碼後存進 **GitHub Secrets**，CI 時還原成檔案。密碼同理用 secrets 注入。
- **`upload-google-play` action**：自動把 AAB 傳到 Play 的 `internal` 軌道。
- iOS 類似，但需在 macOS runner 上、處理憑證匯入（`apple-actions/import-codesign-certs`）與上傳 TestFlight。
- **`fastlane`**：跨平台的發佈自動化工具（管理憑證、截圖、上傳），CI 裡常與上述搭配。

**心智模型**：CI/CD ＝「打個 tag，機器自動幫你測試→簽章→打包→上架到測試軌道」。一旦設好，發版從「手動半天」變成「打 tag 喝咖啡」。

---

## 14.9 Shorebird：Dart 程式碼熱更新（OTA）

正常更新要重新上架、等審核、等使用者更新。**Shorebird** 讓你「不經商店，直接推送 Dart 程式碼更新」（類似 RN 的 CodePush）：

```bash
shorebird release android       # 發一個可熱更新的版本
# 改完 bug 後：
shorebird patch android         # 推送補丁，使用者下次開 App 自動更新
```

- **適合**：修小 bug、改文案、調邏輯——不用走完整上架流程。
- **限制**：**只能更新 Dart 程式碼**，不能改原生部分（加 plugin、改權限、換圖示）那些仍要正常上架。也要遵守商店政策（不能藉此大改 App 行為）。
- **心智模型**：Shorebird 是「給 Dart 層的熱補丁」。日常小修補走 Shorebird（快），動到原生或大改版走正規上架。

---

## 14.10 上架前檢查清單

```text
□ 版本號 version: x.y.z+build，build number 已遞增
□ 用 release 模式建構（不是 debug）
□ App 圖示、名稱、啟動畫面已設定
□ 套件 id 正確且不再變動
□ 正式環境的 API URL（--dart-define 注入，沒留測試網址）
□ 權限用途說明齊全（iOS Info.plist 的 NSxxxUsageDescription）
□ 隱私權政策連結（兩商店都要）
□ Android：用 AAB、keystore 已備份、key.properties 沒進版控
□ iOS：憑證/描述檔 OK、Bundle ID 與 App Store Connect 一致
□ 先上「內部測試 / TestFlight」實機驗證，再升正式
□ 混淆建構並保存 split-debug-info（給日後 crash 還原）
□ 移除測試用的 print / 假資料 / 寫死的測試帳號
```

---

## 14.11 動手練習

1. 用 `flutter_launcher_icons` 設定一個 App 圖示並套用到雙平台。
2. 設一個 `Env` 類別接 `--dart-define`，讓 dev/prod 用不同 API URL，並用 `flutter run --dart-define=...` 驗證。
3. （Android）產生 keystore、設定 `key.properties` + Gradle 簽章、`flutter build appbundle --release` 產出 AAB。
4. （有帳號者）把 AAB 上傳到 Play Console 的內部測試軌道，用自己的手機安裝。
5. 設一個 GitHub Actions，打 `v*` tag 時自動建構 release AAB（先不上傳，確認能產出檔案即可）。

---

## 小結

- 建構模式：開發 debug、上架一律 **release**（AOT、快、小）。
- App 身分：套件 id（不可改、`--org` 設好）、圖示（`flutter_launcher_icons`）、版本號（**build number 每次上傳必遞增**）。
- 多環境用 `--dart-define` + `String.fromEnvironment` 注入 API URL 等設定。
- **Android**：產 keystore（**務必備份、別進版控**）→ Gradle 簽章 → `build appbundle`（AAB）→ Play Console 內部測試 → 升正式。
- **iOS**：Apple Developer 帳號 → Xcode 自動簽章 → `build ipa` → 上傳 → **TestFlight 測試** → 送審上架。
- 上線保護：`--obfuscate` + 保存 `--split-debug-info`。
- CI/CD：Codemagic（最省心）或 GitHub Actions（金鑰放 secrets），打 tag 自動測試→簽章→打包→上傳測試軌道。
- Shorebird：Dart 層熱更新，小修補免上架；動原生仍要走正規流程。

---

> 所有零件都學完了。最後一章，我們把 00～14 的所有技術串成一個「可上線的完整 App」，做一次端到端的整合驗收。
> 前往 [第 15 章：Capstone 實戰專題](./15-capstone-fullstack-app.md)。
