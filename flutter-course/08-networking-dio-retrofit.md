# 第 08 章：網路 API 串接（Dio + Retrofit）

> App 要有用，就得跟伺服器連線：登入、抓清單、送資料。這一章把「網路」這條線完整打通。
> 我們會從內建的 `http` 看起，理解它的不足，再升級到 **Dio**（功能完整的 HTTP client），加上 **json_serializable**（自動把 JSON 轉成 Dart 物件）與 **Retrofit**（用註解產生型別安全的 API client）。
> 這三者的組合是 Flutter 串 API 的黃金陣容，也是本課第 10 章架構的基礎。

---

## 8.1 先回顧：一次 API 請求到底在做什麼

```text
你的 App  ──── HTTP 請求 (GET/POST...) ───→  伺服器
            ↑                                  │
            └──── HTTP 回應 (JSON 資料) ────────┘
```

- **請求方法**：`GET`（拿資料）、`POST`（新增）、`PUT/PATCH`（更新）、`DELETE`（刪除）。
- **回應**：通常是一段 **JSON 字串**，加上一個**狀態碼**（200 成功、401 未授權、404 找不到、500 伺服器錯誤）。
- App 的工作：**送出請求 → 等回應 → 把 JSON 字串解析成 Dart 物件 → 顯示在畫面**。

這一章的每個工具，都是在優化這條流程的某一段。

---

## 8.2 內建的 `http`：能用，但很「手工」

Flutter 官方有個輕量套件 `http`：

```dart
import 'package:http/http.dart' as http;
import 'dart:convert';

Future<List<Product>> fetchProducts() async {
  final res = await http.get(Uri.parse('https://api.example.com/products'));

  if (res.statusCode == 200) {
    final List<dynamic> jsonList = jsonDecode(res.body);          // 手動解析 JSON
    return jsonList.map((j) => Product.fromJson(j)).toList();     // 手動轉物件
  } else {
    throw Exception('載入失敗：${res.statusCode}');                 // 手動判斷錯誤
  }
}
```

逐段看它**每件事都要手做**：

- 手動 `jsonDecode`（把字串變成 Map/List）。
- 手動判斷 `statusCode`。
- 手動處理逾時、重試、加 token header……每個 API 都重寫一遍。

`http` 適合「偶爾打一兩個簡單請求」。但正式 App 需要：統一加認證 token、統一處理錯誤、逾時、重試、log——**這些 Dio 都內建了**。

---

## 8.3 Dio：功能完整的 HTTP client

```bash
flutter pub add dio
```

建立一個設定好的 Dio 實例：

```dart
final dio = Dio(
  BaseOptions(
    baseUrl: 'https://api.example.com',          // 共同網址前綴，之後只寫路徑
    connectTimeout: const Duration(seconds: 10), // 連線逾時
    receiveTimeout: const Duration(seconds: 10), // 接收逾時
    headers: {'Accept': 'application/json'},      // 共同 header
  ),
);
```

逐段解釋：

- **`BaseOptions`**：整個 Dio 的「預設設定」。設了 `baseUrl`，之後呼叫只要寫 `/products`，不用每次打完整網址。
- **`connectTimeout` / `receiveTimeout`**：逾時保護。沒設的話，網路爛的時候請求會一直卡著，使用者乾等。**正式 App 一定要設逾時。**
- **`headers`**：每個請求都會帶的共同標頭。

發請求：

```dart
// GET
final res = await dio.get('/products', queryParameters: {'page': 1});
print(res.data);   // Dio 已自動幫你把 JSON 解析成 Map/List 了！

// POST
final res2 = await dio.post('/login', data: {'email': e, 'password': p});
```

**Dio 比 `http` 好在哪（逐點）**：

- **自動解析 JSON**：`res.data` 直接是解析好的 `Map`/`List`，不用自己 `jsonDecode`。
- **自動拋錯**：非 2xx 狀態碼會自動丟 `DioException`，你用 try/catch 接就好，不用每次比對 statusCode。
- **攔截器（interceptor）**：可以「統一在所有請求前後插入邏輯」（加 token、log、refresh token）——這是它最強的地方，8.6 詳講。

---

## 8.4 JSON ↔ Dart 物件：json_serializable

伺服器回來的是 JSON，但我們在 App 裡想用「型別安全的物件」（`product.name` 而不是 `json['name']`，後者打錯字不會報錯）。手寫 `fromJson` 很煩又易錯，用 **json_serializable** 自動產生。

```bash
flutter pub add json_annotation
flutter pub add --dev build_runner json_serializable
```

定義模型：

```dart
// product.dart
import 'package:json_annotation/json_annotation.dart';
part 'product.g.dart';                    // 自動產生的檔案

@JsonSerializable()
class Product {
  final int id;
  final String name;
  final int price;

  @JsonKey(name: 'image_url')             // JSON 欄位叫 image_url，Dart 想用 imageUrl
  final String? imageUrl;

  Product({
    required this.id,
    required this.name,
    required this.price,
    this.imageUrl,
  });

  // 把 JSON Map 轉成 Product（內容由產生器補）
  factory Product.fromJson(Map<String, dynamic> json) => _$ProductFromJson(json);

  // 把 Product 轉回 JSON Map（送 POST 時用）
  Map<String, dynamic> toJson() => _$ProductToJson(this);
}
```

逐段解釋：

- **`@JsonSerializable()`**：告訴產生器「幫這個類別做 JSON 轉換」。
- **`@JsonKey(name: 'image_url')`**：處理「JSON 用 snake_case、Dart 慣例用 camelCase」的命名差異。沒這行的話，`imageUrl` 對不到 `image_url` 會變 null。
- **`factory Product.fromJson(...) => _$ProductFromJson(json);`**：第 02 章講的 factory 建構子。實作 `_$ProductFromJson` 由產生器補（在 `product.g.dart`）。
- **`toJson()`**：反向，把物件變回 JSON，POST/PUT 送資料時用。
- 跑 `dart run build_runner build --delete-conflicting-outputs` 產生 `product.g.dart`。

**心智模型**：你只負責「描述這個資料長怎樣」（欄位 + 註解），「怎麼跟 JSON 互轉」的苦工交給產生器。改欄位只要改一處、重跑產生器，不會有手寫 fromJson 漏掉某欄位的 bug。

---

## 8.5 Retrofit：用註解產生型別安全的 API client

有了 Dio + 模型，我們還可以更進一步：用 **Retrofit** 把「API 長怎樣」寫成一個**介面**，產生器自動生出實作。這樣呼叫 API 就像呼叫普通函式，型別安全又乾淨。

```bash
flutter pub add retrofit
flutter pub add --dev retrofit_generator build_runner
```

定義 API client：

```dart
// product_api.dart
import 'package:dio/dio.dart';
import 'package:retrofit/retrofit.dart';
import 'product.dart';
part 'product_api.g.dart';

@RestApi()                                       // 標記這是 Retrofit API
abstract class ProductApi {
  factory ProductApi(Dio dio, {String baseUrl}) = _ProductApi;   // 產生器實作

  @GET('/products')                              // GET /products
  Future<List<Product>> getProducts(@Query('page') int page);

  @GET('/products/{id}')                         // 路徑參數
  Future<Product> getProduct(@Path('id') int id);

  @POST('/products')
  Future<Product> createProduct(@Body() Product product);   // @Body 自動 toJson

  @DELETE('/products/{id}')
  Future<void> deleteProduct(@Path('id') int id);
}
```

逐段解釋（**這就是現代 Flutter 串 API 最乾淨的樣子**）：

- **`@RestApi()`** + **`abstract class`**：你只「宣告」API 有哪些端點，**不寫實作**。實作由 `retrofit_generator` 產生到 `product_api.g.dart`。
- **`@GET('/products')`**：標記這個方法對應 `GET /products`。`@POST`、`@PUT`、`@DELETE` 同理。
- **`@Query('page') int page`**：自動變成 `?page=1` 查詢參數。
- **`@Path('id') int id`**：自動填進路徑 `/products/{id}`。
- **`@Body() Product product`**：自動把物件 `toJson()` 當請求 body 送出。
- **回傳 `Future<List<Product>>`**：Retrofit + json_serializable 會**自動把回應 JSON 解析成 `List<Product>`**——你完全不碰 `jsonDecode`、不碰 `fromJson`。

用起來：

```dart
final api = ProductApi(dio);                    // dio 就是 8.3 設定好的那個
final products = await api.getProducts(1);      // 直接拿到 List<Product>！
final one = await api.getProduct(42);           // 拿到 Product
```

**對比一下進步**：

```text
http：       手動組網址 + jsonDecode + 手動 fromJson + 手動判 statusCode
Dio：        自動解析 + 自動拋錯，但仍要自己寫每個請求
Dio+Retrofit：宣告介面 → api.getProducts(1) 直接拿型別安全的物件
```

**心智模型**：Retrofit 讓「呼叫遠端 API」感覺起來跟「呼叫本地函式」一樣。後端有什麼端點，你就在介面宣告什麼方法，剩下交給產生器。

---

## 8.6 攔截器（Interceptor）：統一處理 token、log、錯誤

這是 Dio 的殺手鐧。**攔截器讓你在「所有請求送出前 / 回應回來後 / 出錯時」插入統一邏輯**，不用在每個 API 重複寫。

### 自動加認證 token

```dart
dio.interceptors.add(
  InterceptorsWrapper(
    onRequest: (options, handler) {
      final token = tokenStorage.read();             // 從第 09 章的 secure storage 拿
      if (token != null) {
        options.headers['Authorization'] = 'Bearer $token';  // 每個請求自動帶上
      }
      handler.next(options);                          // 放行，繼續送出
    },
  ),
);
```

逐段解釋：

- **`onRequest`**：每個請求送出**前**都會經過這裡。我們在這統一把 token 塞進 header。
- **`handler.next(options)`**：「放行」——把（可能改過的）請求往下送。**忘了呼叫 `handler.next` 請求會卡住**，這是新手常見坑。
- **好處**：登入後存一次 token，**全 App 所有 API 自動帶上認證**，不用每支 API 各寫一遍。改認證方式也只改這一處。

### 自動 log（開發期除錯神器）

```dart
dio.interceptors.add(LogInterceptor(
  requestBody: true,
  responseBody: true,
));   // 每個請求/回應都印出來，方便對照後端
```

### 統一錯誤處理 / token 過期自動更新

```dart
dio.interceptors.add(
  InterceptorsWrapper(
    onError: (DioException e, handler) async {
      if (e.response?.statusCode == 401) {
        // token 過期 → 嘗試用 refresh token 換新的，再重送原請求
        final ok = await authService.refreshToken();
        if (ok) {
          final clone = await dio.fetch(e.requestOptions);   // 帶新 token 重送
          return handler.resolve(clone);                     // 用重送的結果當作回應
        }
      }
      handler.next(e);                                        // 其他錯誤照常往下拋
    },
  ),
);
```

- **`onError`**：請求出錯時統一進這裡。經典用途：**401（token 過期）自動 refresh 再重試**，使用者完全無感。這種「無痛續登」邏輯集中在一處，非常乾淨。

**心智模型**：攔截器是「請求的安檢通道」。所有請求進出都過同一個安檢——統一蓋章（加 token）、統一拍照存證（log）、統一處理異常（401 續登）。

---

## 8.7 錯誤處理：DioException 與「把錯誤翻譯成人話」

網路一定會錯（沒網、逾時、伺服器掛）。Dio 把錯誤包成 `DioException`：

```dart
try {
  final products = await api.getProducts(1);
} on DioException catch (e) {
  // 依錯誤類型給使用者看得懂的訊息
  final message = switch (e.type) {
    DioExceptionType.connectionTimeout ||
    DioExceptionType.receiveTimeout => '連線逾時，請檢查網路',
    DioExceptionType.badResponse => switch (e.response?.statusCode) {
        401 => '請重新登入',
        404 => '找不到資料',
        500 => '伺服器忙線中，請稍後再試',
        _ => '發生錯誤（${e.response?.statusCode}）',
      },
    DioExceptionType.connectionError => '無法連線，請檢查網路',
    _ => '發生未知錯誤',
  };
  print(message);
}
```

逐段解釋：

- **`on DioException catch (e)`**：只接 Dio 的錯誤（第 02 章 try/catch）。
- **`e.type`**：錯誤分類（逾時、連線失敗、伺服器回非 2xx 等）。
- **`switch` 表達式**：Dart 的現代寫法（類似 pattern matching），把每種錯誤對應成**使用者看得懂的中文**。
- **重點觀念**：**別把 `DioException` 或 `500` 直接丟給使用者看**。在這層把技術錯誤「翻譯成人話」，是專業 App 的細節。實務上我們會在 Repository 層（第 10 章）把它轉成自訂的 `AppException`，再讓 UI 顯示。

---

## 8.8 取消請求與重試

```dart
// 取消：例如使用者離開頁面、或搜尋框又輸入了新關鍵字，舊請求該取消
final cancelToken = CancelToken();
dio.get('/search', queryParameters: {'q': 'flutter'}, cancelToken: cancelToken);
// 需要時：
cancelToken.cancel('使用者離開了頁面');
```

- **`CancelToken`**：給請求一個「取消開關」。搜尋即時建議（每打一個字就查）時，新請求發出前先取消舊的，避免「舊結果蓋掉新結果」的競態 bug。

重試可以用攔截器或社群套件（如 `dio_smart_retry`）做「逾時自動重試 N 次」。先知道有這回事，需要時再導入。

---

## 8.9 接上 Riverpod：預告 Repository

把 Dio/Retrofit 接進 Riverpod，UI 就能用第 06 章的 `AsyncValue.when` 享受三態：

```dart
// 1) 提供設定好的 Dio
@riverpod
Dio dio(DioRef ref) {
  final dio = Dio(BaseOptions(baseUrl: 'https://api.example.com'));
  dio.interceptors.add(/* token 攔截器 */);
  return dio;
}

// 2) 提供 API client
@riverpod
ProductApi productApi(ProductApiRef ref) => ProductApi(ref.watch(dioProvider));

// 3) 提供「商品清單」狀態（自動變成 AsyncValue）
@riverpod
Future<List<Product>> productList(ProductListRef ref) {
  return ref.watch(productApiProvider).getProducts(1);
}
```

UI 端：

```dart
final productsAsync = ref.watch(productListProvider);
return productsAsync.when(
  loading: () => const Center(child: CircularProgressIndicator()),
  error: (e, _) => Center(child: Text('載入失敗：$e')),
  data: (products) => ListView.builder(
    itemCount: products.length,
    itemBuilder: (c, i) => ListTile(title: Text(products[i].name)),
  ),
);
```

逐段解釋：

- 從 `dioProvider` → `productApiProvider` → `productListProvider`，形成第 06 章的**依賴鏈**。任一層換掉（例如測試時換成假 Dio），下游自動跟著換。
- UI 完全不碰網路細節，只 `watch` 一個 `AsyncValue` 然後 `.when` 畫三態。**這就是乾淨架構的雛形**，第 10 章會正式把中間補上「Repository」這一層（負責「翻譯錯誤、合併本機快取」等）。

---

## 8.10 動手練習

> 可用免費的測試 API：`https://jsonplaceholder.typicode.com`（有 `/posts`、`/users` 等端點）。

1. 設定一個 Dio（baseUrl 指向 jsonplaceholder），加上 `LogInterceptor`，GET `/posts` 印出結果。
2. 用 json_serializable 定義 `Post` 模型（`id`、`title`、`body`、`userId` 注意是 `@JsonKey(name:'userId')`），跑產生器。
3. 用 Retrofit 定義 `PostApi`，`getPosts()` 回傳 `List<Post>`、`getPost(id)` 回傳 `Post`。
4. 接上 Riverpod：做 `postListProvider`，UI 用 `AsyncValue.when` 顯示 loading→清單，並加一個下拉重整 `ref.invalidate`。
5. 故意把 baseUrl 改錯，觀察 `DioException`，並把它翻譯成「無法連線」顯示給使用者。

---

## 小結

- 一次 API＝送請求→等回應→JSON 轉物件→顯示；每個工具優化其中一段。
- 內建 `http` 太手工；**Dio** 自動解析 JSON、自動拋錯、有攔截器。
- **json_serializable**：用 `@JsonSerializable` + `@JsonKey` 自動生成 `fromJson`/`toJson`，告別手寫易錯的解析。
- **Retrofit**：用 `@RestApi` + `@GET/@POST/@Path/@Query/@Body` 宣告 API 介面，呼叫遠端就像呼叫本地函式，型別安全。
- **攔截器**是 Dio 殺手鐧：統一加 token（`onRequest`）、log、401 自動續登（`onError`）。
- 錯誤處理：接 `DioException`、依 `type`/`statusCode` **翻譯成人話**，別把技術錯誤丟給使用者。
- `CancelToken` 取消請求；接 Riverpod 後用 `AsyncValue.when` 享受 loading/error/data 三態。

---

> 資料能從遠端拿了，但有些東西要存在「裝置本機」：登入 token、使用者設定、離線資料。下一章講本機儲存。
> 前往 [第 09 章：本機資料儲存](./09-local-storage.md)。
