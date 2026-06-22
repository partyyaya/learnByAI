# 第 12 章：原生整合與裝置能力

> Flutter 自己畫畫面（第 00 章），但「相機、定位、推播、藍牙」這些**裝置能力**屬於作業系統，Flutter 必須跟原生溝通才能用。
> 這一章講三件事：①用現成 plugin 使用裝置能力（最常見）②處理權限 ③當沒有現成 plugin 時，用 **Platform Channel** 自己跟原生橋接。最後帶推播（FCM）。

---

## 12.1 心智模型：Flutter 跟裝置能力的關係

回顧第 00 章：Flutter 跟系統只要「一塊畫布 + 觸控事件」，UI 全自己畫。但「打開相機」「讀 GPS」「發推播」這些**不是畫畫**，是要呼叫 iOS/Android 的系統 API。

```text
你的 Dart 程式  ──呼叫──→  Plugin（Dart 介面）
                              │
                              ▼  （Platform Channel 橋接）
                         原生程式碼（Swift / Kotlin）
                              │
                              ▼
                         系統 API（相機 / GPS / 推播…）
```

**好消息**：99% 的常見能力，社群已經寫好 plugin 幫你把原生那段包好了。你大多數時候只是「裝個 plugin、呼叫 Dart 方法」。只有當你要用「冷門的原生功能、或公司自己的原生 SDK」時，才需要自己寫 Platform Channel（12.5）。

---

## 12.2 用現成 plugin：以 image_picker 為例

到 [pub.dev](https://pub.dev) 找官方/高評分的 plugin。例如選照片：

```bash
flutter pub add image_picker
```

```dart
import 'package:image_picker/image_picker.dart';

Future<void> pickImage() async {
  final picker = ImagePicker();
  // 從相簿選一張（也可改 ImageSource.camera 開相機拍）
  final XFile? image = await picker.pickImage(source: ImageSource.gallery);

  if (image == null) return;            // 使用者取消了
  print('選到：${image.path}');
  // image.path 可丟給 Image.file(File(image.path)) 顯示，或上傳（第 8 章）
}
```

逐段解釋：

- **`ImagePicker().pickImage(source: ...)`**：呼叫起來就像普通 async 函式（第 02 章）——背後 plugin 已經幫你橋接到原生的相簿/相機 UI。
- **回傳 `XFile?`**：可能是 null（使用者按取消），所以一定要判斷（第 02 章 null safety）。
- **每個 plugin 都要看文件做「原生設定」**：大多數涉及隱私的能力，要在 iOS 的 `Info.plist`、Android 的 `AndroidManifest.xml` 加說明文字與權限宣告（下一節）。**這是最常被忘記、導致「在某平台閃退」的坑。**

其他常見 plugin（用法都是「裝 → 呼叫 Dart 方法」）：`geolocator`（定位）、`url_launcher`（開網址/打電話）、`share_plus`（分享）、`local_auth`（指紋/臉部辨識）、`connectivity_plus`（網路狀態）、`camera`（自訂相機）。

---

## 12.3 權限：先要到，才能用（permission_handler）

涉及隱私的能力（相機、定位、麥克風、通知）**必須先取得使用者授權**。沒處理權限是 App 閃退與被商店拒絕的常見原因。

```bash
flutter pub add permission_handler
```

**第一步：在原生設定宣告權限與用途說明**（缺這步 iOS 直接 crash）：

```xml
<!-- ios/Runner/Info.plist：告訴使用者「為什麼要這個權限」 -->
<key>NSCameraUsageDescription</key>
<string>需要使用相機來拍攝商品照片</string>
<key>NSLocationWhenInUseUsageDescription</key>
<string>需要定位來顯示附近的店家</string>
```

```xml
<!-- android/app/src/main/AndroidManifest.xml -->
<uses-permission android:name="android.permission.CAMERA"/>
<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION"/>
```

**第二步：在程式裡請求與檢查**：

```dart
import 'package:permission_handler/permission_handler.dart';

Future<bool> ensureCameraPermission() async {
  final status = await Permission.camera.status;       // 先查目前狀態

  if (status.isGranted) return true;                   // 已授權，直接用

  if (status.isPermanentlyDenied) {
    // 使用者選了「永不允許」→ 程式無法再彈窗，只能引導去系統設定
    await openAppSettings();
    return false;
  }

  final result = await Permission.camera.request();     // 跳出系統授權彈窗
  return result.isGranted;
}
```

逐段解釋（**權限的標準處理流程**）：

- **`Permission.camera.status`**：先查狀態，別每次都直接 `request`（已授權還彈窗很煩）。
- **`isGranted`**：已授權。
- **`isPermanentlyDenied`**：使用者勾了「不要再問」。**這時 `request()` 不會再彈窗**（系統限制），唯一出路是 `openAppSettings()` 引導他去系統設定手動開。這個分支新手最常漏掉，導致「按了沒反應」。
- **`request()`**：跳出系統授權對話框，回傳使用者的選擇。
- **iOS 額外坑**：`Info.plist` 沒寫用途說明字串（`NSxxxUsageDescription`），App 一請求權限就**直接閃退**。一定要先加。

**心智模型**：權限像「進門要先敲門」。先看門開了沒（status），沒開就敲（request），門被反鎖了（permanentlyDenied）就只能請對方去開鎖（系統設定）。

---

## 12.4 平台判斷：給不同平台不同行為

有時要依平台做不同的事：

```dart
import 'dart:io' show Platform;

if (Platform.isIOS) {
  // iOS 專屬邏輯
} else if (Platform.isAndroid) {
  // Android 專屬邏輯
}
```

- **`Platform.isIOS` / `isAndroid`**：判斷目前在哪個平台。
- **⚠️ 注意**：`dart:io` 的 `Platform` 在 **Web 上會報錯**（Web 沒有檔案系統概念）。如果 App 要支援 Web，改用 `kIsWeb`（來自 `package:flutter/foundation.dart`）先判斷是不是 Web。

---

## 12.5 Platform Channel：沒有現成 plugin 時，自己跟原生橋接

當你要用「公司自己的原生 SDK」或「冷門系統功能」，沒有 plugin，就得自己寫橋接。這就是第 00 章說的「橋」，Flutter 叫 **MethodChannel**。

**概念**：Dart 端和原生端約定一個「頻道名稱」，透過它互傳訊息。

### Dart 端

```dart
import 'package:flutter/services.dart';

class BatteryService {
  // 約定一個頻道名稱（兩端要一致）
  static const _channel = MethodChannel('com.myapp/battery');

  Future<int> getBatteryLevel() async {
    // 呼叫原生的 'getBatteryLevel' 方法，等它回傳
    final int level = await _channel.invokeMethod('getBatteryLevel');
    return level;
  }
}
```

逐段解釋：

- **`MethodChannel('com.myapp/battery')`**：建立一條命名通道。名稱通常用「反向網域 + 功能」避免衝突，**Dart 端和原生端必須用同一個字串**。
- **`invokeMethod('getBatteryLevel')`**：透過通道喊「原生那邊，幫我跑 `getBatteryLevel`」，並 `await` 它的回傳。傳參數可加第二個參數。

### 原生端（Android / Kotlin，示意）

```kotlin
// MainActivity.kt
class MainActivity : FlutterActivity() {
  override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
    super.configureFlutterEngine(flutterEngine)
    MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "com.myapp/battery")
      .setMethodCallHandler { call, result ->
        if (call.method == "getBatteryLevel") {
          val level = getBatteryLevel()      // 呼叫真正的 Android API
          result.success(level)              // 把結果傳回 Dart
        } else {
          result.notImplemented()
        }
      }
  }
}
```

逐段解釋：

- 原生端用**同名頻道**註冊一個 handler，根據 `call.method` 判斷 Dart 要呼叫哪個方法，做完用 `result.success(...)` 回傳。
- iOS 端（Swift）概念一樣，在 `AppDelegate.swift` 用 `FlutterMethodChannel` 註冊。
- **可傳的資料型別有限**：基本型別、List、Map（會自動序列化），不能直接傳自訂物件——要先轉成 Map。

**心智模型**：MethodChannel 就是第 00 章那座「橋」。平常 plugin 幫你把橋蓋好了；當你要過一座沒人蓋的橋，就自己用 MethodChannel 蓋——Dart 喊話、原生接住做事、再把結果喊回來。

> 實務建議：能找到維護良好的 plugin 就別自己寫 channel（原生程式碼要 iOS/Android 各寫一份、各自測）。自己寫通常是為了包公司既有的原生 SDK。

---

## 12.6 推播通知（FCM）：概念與接入流程

推播（Push Notification）讓伺服器主動通知使用者（新訊息、促銷）。跨平台標準方案是 **Firebase Cloud Messaging（FCM）**，iOS 底層走 APNs、Android 走 FCM，`firebase_messaging` 幫你統一。

```bash
flutter pub add firebase_core firebase_messaging
```

**接入流程（高層次，細節依 Firebase 文件）**：

1. 到 Firebase Console 建專案，下載設定檔（Android 的 `google-services.json`、iOS 的 `GoogleService-Info.plist`）放進對應原生資料夾。iOS 還要在 Apple Developer 設定 APNs 金鑰。
2. 初始化並請求通知權限：

```dart
Future<void> setupPush() async {
  await Firebase.initializeApp();
  final messaging = FirebaseMessaging.instance;

  // 請求通知權限（iOS 必須；Android 13+ 也要）
  await messaging.requestPermission();

  // 取得這台裝置的 token —— 後端用它「指定推給這台裝置」
  final token = await messaging.getToken();
  print('FCM token: $token');     // 通常上傳給你的後端存起來

  // 收到推播時的處理
  FirebaseMessaging.onMessage.listen((message) {        // App 在前景時
    print('前景收到：${message.notification?.title}');
  });
  FirebaseMessaging.onMessageOpenedApp.listen((message) {// 使用者點推播打開 App
    // 這裡常做 deep link：依 message.data 導到對應頁面（第 5 章 go_router）
  });
}
```

逐段解釋：

- **`getToken()`**：每台裝置的「收件地址」。後端拿到這個 token 才能精準推給特定使用者。登入後通常把它上傳後端。
- **`onMessage`**（前景）/ **`onMessageOpenedApp`**（點通知開啟）/ 背景訊息（要設背景 handler）——**三種狀態要分別處理**，這是推播最容易出錯的地方。
- **點推播導頁**：`onMessageOpenedApp` 裡讀 `message.data`（後端帶的自訂資料，例如 `{"route": "/order/123"}`），用 go_router `context.go(...)` 導過去——這正是第 05 章 deep link 的延伸。

> 推播完整設定（憑證、背景處理、通知樣式）較繁瑣，建議照 Firebase 官方文件一步步來。這裡建立「token＝裝置地址、三種接收狀態、點擊導頁」的核心心智模型即可。

---

## 12.7 動手練習

1. 用 `image_picker` 做「選一張相簿照片並用 `Image.file` 顯示」，記得補 iOS/Android 的權限設定。
2. 用 `permission_handler` 實作完整權限流程：已授權→直接用、未授權→request、永久拒絕→引導去設定。
3. 用 `url_launcher` 做「點按鈕撥打電話 / 開啟網頁」。
4. （進階）寫一個 `MethodChannel` 取得電池電量（Android 端用 Kotlin 實作 handler），體驗 Dart↔原生橋接。

---

## 小結

- Flutter 自己畫 UI，但裝置能力（相機/定位/推播）屬於系統，需透過 plugin 或 Platform Channel 跟原生溝通。
- 多數情況：到 pub.dev 找維護良好的 plugin，呼叫 Dart 方法即可——但**別忘了補 iOS `Info.plist` / Android `Manifest` 的權限與用途說明**（漏了會閃退）。
- 權限流程：先查 `status` → 未授權 `request` → `permanentlyDenied` 引導 `openAppSettings`。
- `Platform.isIOS/isAndroid` 做平台分支（Web 要先用 `kIsWeb` 擋）。
- 沒 plugin 時用 **MethodChannel**：Dart 與原生約定同名頻道，`invokeMethod` 喊話、原生 handler 回傳——就是第 00 章那座「橋」。
- 推播用 FCM：`getToken` 是裝置地址、分前景/背景/點擊三種接收、點擊可接 go_router 導頁。

---

> App 功能完整了。上線前最後的保險：測試。下一章講 unit / widget / integration 測試與品質把關。
> 前往 [第 13 章：測試與品質](./13-testing-and-quality.md)。
