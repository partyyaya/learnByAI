# 第 00 章：課程地圖與 Web 層職責

> 上一站（03-rest-api）你把**契約**設計完了：70 條 URL、22 個 DTO、約 60 個錯誤碼、一份 `orders-api.yaml`。
> 這一站要把它**實作出來**。
>
> 但這一章先不寫 `@GetMapping`。
> 因為 Controller 這一層真正的難題不是語法 —— `@GetMapping` 你 20 分鐘就會了 ——
> 而是**「這段程式碼到底該不該放在這裡」**。
> 我見過 3,000 行的 `OrderController`，也見過 12 行的。它們處理的是同一個需求。
> 差別不在誰比較會寫 Spring，而在誰想清楚了**職責邊界**。

---

## 0.1 學習目標

完成本章後，你應該可以：

- 看著一段程式碼，判斷它屬於 Controller、Service 還是 Repository，並說出判準（不是憑感覺）。
- 說出「商業邏輯寫在 Controller」會造成哪些**具體、可量化**的後果：不能重用、不能測試、交易邊界錯誤、事故。
- 用五個問題（「換掉 HTTP 還需要它嗎？」等）做出邊界判斷。
- 完整說明一個 HTTP 請求在 Spring Boot 裡的旅程：從 Tomcat 執行緒到 `DispatcherServlet`、到 `HandlerAdapter`、到你的方法、再回來。
- 說出 Filter、Interceptor、`HandlerMethodArgumentResolver`、AOP、`@RestControllerAdvice` 各自能看到什麼、不能看到什麼。
- 把一個 800 行的 Controller 重構成 40 行，並說出每一段程式碼搬去了哪裡、為什麼。
- 建好 shop-service 的專案骨架與套件結構，並說明為什麼這樣切。
- 判斷什麼情況該用 WebFlux，什麼情況（大多數）不該。

---

## 0.2 這一站在整條路線的位置

```
           01-java-core     語言 + JVM + 建置 + 測試（已完成）
                ↓
           02-spring-boot   IoC / DI / 自動組態 / AOP / 設定 / 部署（已完成）
                ↓
           03-rest-api      介面契約設計（已完成，產出 orders-api.yaml）
                ↓
[你在這裡] 04-controller    Web 層：接請求、驗參數、回錯誤 ← 把契約實作出來
                ↓
           05-service       商業邏輯層：交易、快取、外部呼叫
                ↓
           06-repository    資料存取層：連線池、查詢抽象
                ↓
           07 / 08          MySQL / JPA / MyBatis
                ↓
           09 / 10          Spring Security / 期末專題
```

### 0.2.1 04、05、06 是同一件事的三個切面

這件事很重要，先講清楚，否則你會覺得這三站在講重複的東西。

**它們不是三個獨立的技術，而是同一個請求路徑上的三段。**

```
HTTP 請求
   │
   ▼
┌──────────────────────────────────────────────────┐
│ Controller（04）                                  │
│ 「翻譯層」：HTTP ⇄ Java                            │
│  · 路由：這條 URL + 方法要呼叫哪個方法              │
│  · 綁定：把 JSON / query string 變成 Java 物件      │
│  · 驗證：格式對不對（不是「業務上合不合理」）         │
│  · 授權的粗篩：這個角色能碰這條端點嗎               │
│  · 翻譯回應：Java 物件 → JSON + 狀態碼 + header      │
│  · 翻譯例外：領域例外 → HTTP 狀態碼 + Problem JSON  │
└──────────────────┬───────────────────────────────┘
                   │ 呼叫介面，傳 Java 型別（不是 HttpServletRequest）
                   ▼
┌──────────────────────────────────────────────────┐
│ Service（05）                                     │
│ 「決策層」：這件事做不做、怎麼做                     │
│  · 業務規則：這張訂單現在可以取消嗎                  │
│  · 計算：小計、折扣、運費、稅                        │
│  · 編排：呼叫幾個 Repository、外部金流、發通知        │
│  · 交易邊界：@Transactional 在這一層                 │
│  · 領域例外：拋 OrderNotCancellableException          │
└──────────────────┬───────────────────────────────┘
                   │
                   ▼
┌──────────────────────────────────────────────────┐
│ Repository（06）                                  │
│ 「存取層」：資料進出                                │
│  · 查詢與寫入，不做業務判斷                          │
│  · 只認識 Entity 與查詢條件                          │
└──────────────────────────────────────────────────┘
```

拆成三站，是為了把「**哪一段程式碼該放哪一層**」講到你不會再猶豫。
實務上它們是同一個 Maven 專案裡的三個套件，一起出現、一起改。

### 0.2.2 這一站的產出

```
第 00 章  專案骨架 + 職責判準 + 一個 800→40 行的重構
第 01 章  路由與參數綁定：把 70 條 URL 對映成方法簽章
第 02 章  Bean Validation：把 DTO 上的驗證全部落地
第 03 章  @RestControllerAdvice：把第 04 章的錯誤目錄（60 個 code）落地 ← 最關鍵的一章
第 04 章  Filter / Interceptor：traceId、請求日誌、分頁參數硬上限
第 05 章  檔案上傳下載、匯出串流、SSE 訂單狀態推播
第 06 章  CORS、內容協商、Jackson 全域設定（金額與時間的序列化）
第 07 章  MockMvc 測試：把契約變成可執行的測試
```

**結束時你會有一組完整可執行的訂單 Controller**：
含驗證、統一錯誤格式、traceId、檔案上傳、SSE、CORS、以及一整套 MockMvc 測試。
唯一缺的是**商業邏輯的實作** —— 那是 05-service 的事。
這一站的 Service 全部是**介面 + 假實作（stub）**，這是刻意的：
它強迫你把「Controller 只依賴介面」這件事真的做到。

---

## 0.3 先看見痛：一個真實的 800 行 Controller

以下這段程式碼是從一個上線三年的電商後台簡化出來的（改名去識別化，行數壓縮到 120 行左右，但每一種問題都保留）。
它**能動**。公司靠它賺錢。它也是整個團隊最怕改的檔案。

```java
@RestController
@RequestMapping("/api/order")
public class OrderController {

    @Autowired private OrderRepository orderRepository;
    @Autowired private OrderItemRepository orderItemRepository;
    @Autowired private ProductRepository productRepository;
    @Autowired private CouponRepository couponRepository;
    @Autowired private CustomerRepository customerRepository;
    @Autowired private JdbcTemplate jdbcTemplate;
    @Autowired private RestTemplate restTemplate;
    @Autowired private StringRedisTemplate redisTemplate;
    @Autowired private JavaMailSender mailSender;
    @Autowired private ObjectMapper objectMapper;

    @PostMapping("/add")
    public Map<String, Object> add(@RequestBody Map<String, Object> body,
                                   HttpServletRequest request) {
        Map<String, Object> result = new HashMap<>();
        try {
            // ── 1. 手寫驗證 ────────────────────────────────
            List<Map<String, Object>> items = (List<Map<String, Object>>) body.get("items");
            if (items == null || items.isEmpty()) {
                result.put("code", -1);
                result.put("msg", "商品不能為空");
                return result;
            }
            String addressId = (String) body.get("addressId");
            if (addressId == null || addressId.trim().equals("")) {
                result.put("code", -1);
                result.put("msg", "地址不能為空");
                return result;
            }

            // ── 2. 從 header 自己解 token ─────────────────
            String token = request.getHeader("Authorization");
            if (token == null) { result.put("code", 401); return result; }
            String customerId = redisTemplate.opsForValue().get("token:" + token.substring(7));
            if (customerId == null) { result.put("code", 401); return result; }

            // ── 3. 業務規則 + 價格計算，全部在這裡 ─────────
            BigDecimal subtotal = BigDecimal.ZERO;
            List<OrderItem> orderItems = new ArrayList<>();
            for (Map<String, Object> item : items) {
                String pid = (String) item.get("productId");
                Integer qty = (Integer) item.get("quantity");

                Product p = productRepository.findById(pid).orElse(null);
                if (p == null) {
                    result.put("code", -1);
                    result.put("msg", "商品不存在：" + pid);
                    return result;                       // ← 前面已經寫進 DB 的呢？
                }
                if (p.getStock() < qty) {
                    result.put("code", -1);
                    result.put("msg", p.getName() + " 庫存不足");
                    return result;
                }
                // 直接扣庫存（沒有鎖，也沒有交易）
                jdbcTemplate.update(
                    "update product set stock = stock - ? where id = ?", qty, pid);

                subtotal = subtotal.add(p.getPrice().multiply(new BigDecimal(qty)));
                OrderItem oi = new OrderItem();
                oi.setProductId(pid);
                oi.setQuantity(qty);
                oi.setUnitPrice(p.getPrice());
                orderItems.add(oi);
            }

            // 折扣碼
            BigDecimal discount = BigDecimal.ZERO;
            String coupon = (String) body.get("coupon");
            if (coupon != null && !coupon.equals("")) {
                Coupon c = couponRepository.findByCode(coupon);
                if (c != null && c.getExpireAt().after(new Date())) {
                    if (c.getType().equals("PERCENT")) {
                        discount = subtotal.multiply(c.getValue())
                                           .divide(new BigDecimal(100));   // ← 沒指定 scale
                    } else {
                        discount = c.getValue();
                    }
                }
            }
            // 運費規則
            BigDecimal shipping = subtotal.compareTo(new BigDecimal(1000)) >= 0
                    ? BigDecimal.ZERO : new BigDecimal(80);

            // ── 4. 寫入 ──────────────────────────────────
            Order order = new Order();
            order.setCustomerId(customerId);
            order.setOrderNo("ORD" + System.currentTimeMillis());
            order.setStatus(1);                                     // ← 魔術數字
            order.setTotal(subtotal.subtract(discount).add(shipping));
            orderRepository.save(order);
            for (OrderItem oi : orderItems) {
                oi.setOrderId(order.getId());
                orderItemRepository.save(oi);
            }

            // ── 5. 呼叫外部系統（同步，沒有 timeout）────────
            try {
                restTemplate.postForObject("http://erp.internal/api/order/sync",
                        order, String.class);
            } catch (Exception e) {
                e.printStackTrace();                                // ← 吞掉
            }

            // ── 6. 寄信（同步，佔用 Tomcat 執行緒 1.5 秒）───
            SimpleMailMessage msg = new SimpleMailMessage();
            msg.setTo(customerRepository.findById(customerId).get().getEmail());
            msg.setSubject("訂單成立");
            msg.setText("您的訂單 " + order.getOrderNo() + " 已成立");
            mailSender.send(msg);

            // ── 7. 回應 ─────────────────────────────────
            result.put("code", 0);
            result.put("data", order);                              // ← 直接回 Entity
            return result;

        } catch (Exception e) {
            e.printStackTrace();
            result.put("code", -1);
            result.put("msg", e.getMessage());                      // ← 可能是 SQL 錯誤訊息
            return result;
        }
    }

    // ... 另外 14 個方法，每個 50～200 行，結構一模一樣 ...
}
```

### 0.3.1 這一個方法做了幾件事？

數一下：

| # | 它做的事 | 該由誰做 |
|---|---|---|
| 1 | 解析 JSON（手動從 `Map` 取值、手動轉型） | Spring 的 `HttpMessageConverter`（01 章） |
| 2 | 驗證必填欄位 | Bean Validation（02 章） |
| 3 | 解 token、查登入者 | Spring Security 的 Filter（09-spring-security） |
| 4 | 查商品、檢查庫存、扣庫存 | Service + Repository（05、06 章） |
| 5 | 計算小計、折扣、運費 | Service（05-service） |
| 6 | 產生訂單編號 | Service（或 Domain） |
| 7 | 寫入 Order 與 OrderItem | Repository（06-repository） |
| 8 | 呼叫 ERP | Service（外部整合，05-service 第 06 章） |
| 9 | 寄信 | Service，而且應該是**非同步**或走事件 |
| 10 | 包裝回應格式 | Controller ✅（唯一真的屬於它的事） |
| 11 | 例外處理 | `@RestControllerAdvice`（03 章） |

**11 件事，只有 1 件真的屬於 Controller。**

### 0.3.2 具體後果（不是「不夠優雅」）

工程師說「這樣寫不好」，主管聽不懂。換成可量化的說法：

**後果 1：這段邏輯不能被重用，只能被複製。**

三個月後有三個新需求：

| 新需求 | 為什麼不能重用 |
|---|---|
| 後台批次匯入訂單（讀 CSV） | 沒有 `HttpServletRequest`、沒有 `Authorization` header |
| 定時任務把購物車轉成訂單 | 同上，而且不在 HTTP 執行緒裡 |
| 給 App 的新版 API（回應格式不同） | 邏輯綁在「回 `Map<String,Object>`」上 |

實際發生的事：這段 120 行的邏輯被**複製成 4 份**。
半年後折扣規則改了，只改了 3 份。第 4 份（批次匯入）算錯了 4 個月，直到財務對帳才發現。

> **這是 Controller 塞邏輯最貴的後果，而且它是「靜默」的** ——
> 不會有例外、不會有紅色的測試，只會有一份對不起來的報表。

**後果 2：沒有交易邊界，錯誤時資料留在半途。**

看第 3 段：迴圈裡逐項扣庫存，扣到第 3 項發現庫存不足就 `return`。
前 2 項的庫存**已經扣掉了**，因為 Controller 方法沒有 `@Transactional`。

```
items = [A(有貨), B(有貨), C(沒貨)]
→ A 庫存 -2 ✅ 已寫入
→ B 庫存 -1 ✅ 已寫入
→ C 庫存不足 → return "庫存不足"
→ 使用者看到失敗，但 A 和 B 的庫存憑空消失了
```

使用者按了 5 次重試 → A 少了 10 個、B 少了 5 個、訂單一張都沒成立。
這在雙十一當天發生過，倉庫顯示缺貨但架上還有 300 件。

⚠️ **為什麼不能把 `@Transactional` 直接加在 Controller 方法上？** 兩個理由：

1. 第 5、6 段有**外部呼叫**（ERP、寄信）。如果整個方法都在交易裡，
   ERP 慢 3 秒 = 資料庫連線與行鎖被佔住 3 秒。
   併發一上來，連線池（預設 HikariCP 10 條）馬上耗盡，**整個服務停止回應**。
2. 交易邊界是**業務語意**（「哪些操作必須一起成功」），不是 HTTP 語意。
   放在 Controller 等於宣告「一個 HTTP 請求 = 一個交易」，但這常常是錯的
   （例：一個請求要開三個獨立交易，其中一個失敗不影響另外兩個）。

（`@Transactional` 的傳播、失效原因、與外部呼叫的正確拆法，是 05-service 第 02 章的主題。）

**後果 3：沒辦法寫測試。**

要測「滿千免運」這條規則，你得：

```java
// 為了測一行運費計算，你需要：
@SpringBootTest                    // 啟動整個 Spring 容器（8～25 秒）
@AutoConfigureMockMvc
class OrderControllerTest {
    @Autowired MockMvc mockMvc;
    // 還需要：
    // · 一個真的（或 Testcontainers 的）MySQL
    // · Redis（因為它從 Redis 讀 token）
    // · 一個假的 ERP HTTP endpoint（否則 RestTemplate 會噴錯）
    // · 一個假的 SMTP server（否則 mailSender 會噴錯）
    // · 資料庫裡要先塞好商品、客戶、折扣碼
}
```

**測一行 `if (subtotal >= 1000)`，要準備四個外部依賴。**

結果就是：沒人寫測試。這個檔案的測試覆蓋率是 0%。
於是每次改動都要手動點頁面驗證，每次上線都是賭博。

正確拆層之後，同一條規則的測試是：

```java
@Test
void 滿千免運() {
    // 不需要 Spring、不需要資料庫、不需要網路
    var fee = new ShippingFeePolicy().calculate(new BigDecimal("1000.00"));
    assertThat(fee).isEqualByComparingTo("0.00");
}
```

**執行時間從 25 秒變成 3 毫秒**，而且可以一次跑 200 個邊界案例。

**後果 4：外部系統一慢，整個服務跟著掛。**

第 5 段的 `restTemplate` 沒有設 timeout。
`RestTemplate` 用 `SimpleClientHttpRequestFactory` 時，**預設 connect / read timeout 都是「無限」**。

那一天 ERP 的資料庫鎖住，HTTP 連線建立成功但不回應。於是：

```
Tomcat 預設 server.tomcat.threads.max = 200
→ 每個下單請求卡在 restTemplate 上
→ 200 個執行緒在 90 秒內全部卡住
→ 第 201 個請求開始排隊（accept queue）
→ 商品頁、購物車、登入 —— 全部無法回應
```

**ERP 是一個「同步訂單」的次要功能，它拖垮了整個網站。**
（這叫**執行緒池耗盡**，02-spring-boot 第 08 章講過；05-service 第 06 章會講正確的外部呼叫防護。）

**後果 5：例外訊息洩漏內部資訊。**

最外層的 `catch (Exception e)` 把 `e.getMessage()` 直接回給前端。
當 SQL 出錯時，使用者的瀏覽器上會出現：

```json
{"code":-1,"msg":"could not execute statement; SQL [insert into t_order (customer_id, order_no, status, total_amount, created_at) values (?,?,?,?,?)]; constraint [uk_order_no]"}
```

**你的資料表名稱、欄位名稱、索引名稱、資料庫種類，全部免費送給攻擊者。**
（第 03 章會處理；03-rest-api 第 04 章 4.7.3 說明過為什麼 5xx 的 `detail` 必須是固定文字。）

**後果 6：改一個地方要讀 800 行。**

需求：「運費規則改成滿 1,200 免運，但 VIP 客戶一律免運。」

這個改動需要：
1. 在 800 行裡找到運費那一行（`Ctrl+F` 找 "80"，找到 6 個結果，其中 3 個是無關的）。
2. 判斷這 6 處哪些要改（因為 `add`、`update`、`recalculate` 各有一份）。
3. 沒有測試，只能手動下單驗證。
4. 上線後才發現 `POST /api/order/preview` 也有一份，忘了改 —— 
   結帳頁顯示免運，實際扣款有運費。客訴 43 筆。

### 0.3.3 把成本算成錢

| 問題 | 可量化代價 |
|---|---|
| 邏輯複製 4 份，改漏 1 份 | 折扣算錯 4 個月，帳差 68 萬，財務人工對帳 3 週 |
| 沒有交易邊界 | 雙十一庫存錯亂，人工盤點 2 天，超賣賠償 12 萬 |
| 沒有測試 | 每次上線 QA 手動回歸 1.5 天；一年 20 次發版 = 30 人天 |
| 外部呼叫無 timeout | 全站中斷 47 分鐘，估算營收損失 210 萬 |
| 錯誤訊息洩漏 | 資安 pentest 開了 3 張 High 單，補救 5 人天 |
| 改一行要讀 800 行 | 新人上手 3 週；一個小需求平均 2.5 天（正常是 0.5 天） |

**這些全部來自同一個原因：一個方法承擔了 11 種職責。**

> 這一站不是在教你「怎麼寫得漂亮」。
> 是在教你**怎麼讓錯誤只發生在一個地方、怎麼讓每條規則都能被單獨測試**。

---

## 0.4 分層架構到底在解什麼問題

### 0.4.1 分層不是為了「乾淨」，是為了「變更的方向性」

軟體會被三種力量推著改：

| 推力 | 例子 | 應該只影響 |
|---|---|---|
| **介面改變** | 前端要新欄位、要支援 GraphQL、要改回應格式 | Controller |
| **規則改變** | 折扣算法改、可取消狀態改、要加風控 | Service |
| **儲存改變** | MySQL 換 PostgreSQL、加 Redis 快取、分庫分表 | Repository |

**分層的價值 = 讓這三種變更彼此隔離。**

一個沒分層的系統，任何一種變更都要動同一個檔案：

```
需求：「訂單列表要加 thumbnailUrl 欄位」（純介面變更）
沒分層 → 改 OrderController.java（800 行的那個），
         而這個檔案同時包含價格計算與扣庫存，
         所以你的 PR 要 review 800 行的上下文，
         而且 code review 的人不敢按 approve。
```

```
有分層 → 改 OrderSummary（DTO，加一個欄位）
        + OrderMapper（怎麼填它）
        兩個檔案，各 5 行。價格計算的程式碼完全沒被碰到。
```

### 0.4.2 依賴方向必須是單向的

```
Controller ──依賴──> Service ──依賴──> Repository
    ✅ 允許                ✅ 允許

Controller <──依賴── Service              ❌ 絕對不行
Repository ──依賴──> Service              ❌ 絕對不行
Controller ──依賴──> Repository           ⚠️ 極少數情況才允許（0.4.4）
```

**「Service 不能依賴 Controller」的具體含意**：Service 的方法簽章裡不准出現這些型別：

```java
// ❌ 這些型別一旦出現在 Service，分層就已經破了
HttpServletRequest, HttpServletResponse, HttpSession
ResponseEntity<?>, MultipartFile, Cookie
org.springframework.http.HttpHeaders
```

**為什麼？** 因為它們是**傳輸協定的細節**。一旦 Service 認識它們：

- 排程任務不能呼叫這個 Service（沒有 request）。
- 單元測試要 mock `HttpServletRequest`（40 行 setup 換 3 行邏輯）。
- 想改成 gRPC / 訊息佇列進入時，Service 全部要重寫。

⚠️ `MultipartFile` 是最常見的違規。正確做法（05 章 5.3 會完整實作）：

```java
// ❌ Service 認識 HTTP
public interface ProductImageService {
    void upload(String productId, MultipartFile file);
}

// ✅ Service 只認識「一份有名字、有型別的位元流」
public interface ProductImageService {
    ImageRef upload(String productId, BinaryPayload payload);
}
public record BinaryPayload(String filename, String contentType,
                            long size, Supplier<InputStream> content) {}
```

Controller 負責把 `MultipartFile` 轉成 `BinaryPayload`。
於是同一個 Service 也能被「從 S3 讀檔的批次任務」呼叫。

### 0.4.3 為什麼 Controller 要依賴「介面」而不是實作

```java
// Controller
private final OrderService orderService;      // ← 介面，不是 OrderServiceImpl
```

三個理由，按重要性排序：

| 理由 | 說明 |
|---|---|
| **1. 測試可以切片** | `@WebMvcTest` 只啟動 Web 層，Service 用 `@MockitoBean` 塞假的。啟動 0.8 秒而不是 20 秒（07 章） |
| **2. 兩層可以並行開發** | 介面先定好，Controller 與 Service 兩個人同時寫。這一站就是這樣：我們只寫介面 |
| **3. 實作可以換** | 加快取版、加重試版、A/B 測試版 —— Controller 不用改 |

⚠️ **但不要為了「將來可能會換」而給每個 Service 都開介面。**
如果一個介面永遠只有一個實作、也不需要 mock（因為沒有測試會切在那裡），那個介面就是純負擔。
判準很簡單：**「我需要在測試裡替換它嗎？」** 需要 → 開介面。不需要 → 直接用 class。

Controller 依賴的 Service **一定**需要（因為 `@WebMvcTest` 要 mock 它），所以一定開介面。

### 0.4.4 Controller 可以直接呼叫 Repository 嗎

**原則上不行。實務上有一個灰色地帶值得誠實討論。**

考慮這個端點：

```java
@GetMapping("/products/{id}")
public ProductDetail get(@PathVariable String id) {
    return productService.findDetail(id);     // Service 裡只有一行 return repo.findById(...)
}
```

這個 Service 什麼都沒做，只是轉呼叫。有人會說這是「貧血的無用層」。

**兩派說法都有道理：**

| 主張 | 論點 | 反駁 |
|---|---|---|
| **「純查詢可以跳過 Service」** | 少一層轉呼叫、少一個檔案 | 一旦要加權限過濾、快取、DTO 組裝，就得回頭補層，而那時候已經有 12 個端點跳過了 |
| **「一律經過 Service」** | 結構一致，加邏輯不用重構 | 短期有樣板程式碼 |

**shop-service 的決定：一律經過 Service。** 理由是實際經驗：

「純查詢」幾乎從不保持純粹。`GET /products/{id}` 三個月後會長出：

```
· 權限：下架商品只有 ADMIN 看得到
· 快取：熱門商品進 Redis
· 組裝：要合併庫存服務的資料
· 統計：記錄瀏覽次數（非同步）
```

這四件事沒有一件屬於 Controller。等到那時候再插入 Service，
你要改的不只是這個端點 —— 而是所有「當初覺得很單純所以跳過」的端點。

> **一句話判準**：轉呼叫的樣板程式碼成本是**一次性的 3 行**；
> 事後補層的成本是**跨 N 個端點的重構 + 一輪回歸測試**。
> 這個賭注不值得。

**唯一真正的例外**：`/actuator/health` 這種**技術性**端點、以及純粹的**唯讀報表查詢層**
（CQRS 的 query side，明確設計成「Controller → QueryService → 手寫 SQL」，
不經過領域模型）。那是一個有意識的架構決策，不是偷懶。

---

## 0.5 Controller 該做的七件事

這是白名單。**不在這張表上的東西，就不該在 Controller 裡。**

| # | 職責 | 具體工作 | 本站章節 |
|---|---|---|---|
| 1 | **路由** | 宣告「這個 URL + 方法 → 這個 Java 方法」 | 01 |
| 2 | **綁定** | path / query / header / body / multipart → Java 型別 | 01 |
| 3 | **格式驗證** | 必填、長度、範圍、正規表示式、跨欄位一致性 | 02 |
| 4 | **翻譯成 Service 的輸入** | DTO → Command 物件（含補上「誰在操作」） | 01、02 |
| 5 | **翻譯 Service 的輸出** | 領域物件 → Response DTO | 01 |
| 6 | **決定 HTTP 語意** | 狀態碼、`Location`、`ETag`、`Cache-Control` | 01、06 |
| 7 | **翻譯例外** | 領域例外 → 狀態碼 + Problem Details JSON | 03 |

注意這七件事的共同點：**全部都是「翻譯」**。
Controller 是一個 adapter，它站在 HTTP 世界和 Java 世界的邊界上，兩邊各說一種語言。

**它不做決策。它只做翻譯。**

一個健康的 Controller 方法長這樣：

```java
@PostMapping
@ResponseStatus(HttpStatus.CREATED)
public CreateOrderResponse create(
        @Valid @RequestBody CreateOrderRequest request,
        @RequestHeader("Idempotency-Key") @NotBlank String idempotencyKey,
        @AuthenticationPrincipal CurrentUser user) {

    var command = orderMapper.toCommand(request, user.customerId(), idempotencyKey);
    var order   = orderService.create(command);          // ← 唯一的一行「做事」
    return orderMapper.toCreateResponse(order);
}
```

**5 行。** 而且這 5 行裡沒有任何一個 `if`。

> **一個經驗法則**：Controller 方法裡出現的 `if`，
> 有 90% 的機率是「應該由 Bean Validation 或 Service 負責的判斷」跑錯地方了。
> 出現 `for` 迴圈的機率則更高 —— 那幾乎一定是業務邏輯。

---

## 0.6 Controller 不該做的十件事

每一項都給 Before / After。這是本章最實用的一節。

### 0.6.1 不該做：業務規則判斷

```java
// ❌ Before
@PostMapping("/{id}/cancellations")
public ResponseEntity<?> cancel(@PathVariable String id) {
    Order order = orderRepository.findById(id).orElseThrow();
    if (!order.getStatus().equals("PENDING_PAYMENT")
            && !order.getStatus().equals("PAID")) {              // ← 業務規則
        return ResponseEntity.status(409).body(Map.of("msg", "無法取消"));
    }
    if (order.getShipments() != null && !order.getShipments().isEmpty()) {  // ← 業務規則
        return ResponseEntity.status(409).body(Map.of("msg", "已出貨"));
    }
    order.setStatus("CANCELLED");
    orderRepository.save(order);
    return ResponseEntity.ok().build();
}
```

```java
// ✅ After — Controller
@PostMapping("/{orderId}/cancellations")
@ResponseStatus(HttpStatus.CREATED)
public CancellationResponse cancel(
        @PathVariable String orderId,
        @Valid @RequestBody CreateCancellationRequest request,
        @AuthenticationPrincipal CurrentUser user) {

    var cancellation = orderService.cancel(
            new CancelOrderCommand(orderId, request.reason(), request.note(), user.actor()));
    return cancellationMapper.toResponse(cancellation);
}
```

```java
// ✅ After — Service（05-service 實作，這裡看它拋什麼）
@Transactional
public Cancellation cancel(CancelOrderCommand cmd) {
    Order order = orderRepository.findById(cmd.orderId())
            .orElseThrow(() -> new ResourceNotFoundException("Order", cmd.orderId()));

    if (!order.isCancellable()) {                                 // ← 規則在領域模型裡
        throw new OrderNotCancellableException(
                order.getOrderNumber(), order.getStatus(), Order.CANCELLABLE_STATUSES);
    }
    ...
}
```

「無法取消 → 409」這個對映關係搬到了 `@RestControllerAdvice`（03 章）。
**Controller 完全不知道 409 這個數字的存在。**

### 0.6.2 不該做：計算

```java
// ❌ Before
BigDecimal total = BigDecimal.ZERO;
for (var item : request.items()) {
    total = total.add(item.price().multiply(BigDecimal.valueOf(item.quantity())));
}
if (total.compareTo(new BigDecimal("1000")) < 0) total = total.add(new BigDecimal("80"));
```

三個問題：
1. 這條規則在 `POST /orders`、`POST /orders/preview`、`POST /carts/current/recalculate` 三個地方各有一份。
2. `item.price()` 是**客戶端傳來的價格** —— 這是一個**改價漏洞**（可以下單付 1 元）。
3. 測不到（見 0.3.2 後果 3）。

```java
// ✅ After：Controller 根本不看金額
public record CreateOrderRequest(
    @NotEmpty @Size(max = 50) List<@Valid Item> items,
    @NotBlank @Size(max = 64) String shippingAddressId,
    @Size(max = 32) String couponCode,
    @Size(max = 200) String customerNote,
    @Valid InvoiceRequest invoice
) {
    public record Item(
        @NotBlank @Size(max = 64) String productId,
        @NotNull @Min(1) @Max(999) Integer quantity
    ) {}
    // ...
}
```

**`Item` 裡沒有 `price`、沒有 `subtotal`、沒有 `total`。**
價格由 Service 從資料庫查當前售價（03-rest-api 第 03 章 3.14.1 的鐵律：
「金額、狀態、編號、時間戳全部由伺服器決定」）。

> 這不只是分層問題，這是**安全問題**。
> 「客戶端能傳的欄位」= 攻擊面。Request DTO 少一個欄位 = 攻擊面少一塊。

### 0.6.3 不該做：直接注入 Repository

```java
// ❌ Before
@Autowired private OrderRepository orderRepository;
```

一旦 Controller 拿到 Repository，就一定會有人在 Controller 裡寫查詢。
而 Repository 的回傳值是 **Entity**，Entity 被回出去就是 03-rest-api 第 03 章 3.2 的六個災難
（洩漏 `passwordHash`、`LazyInitializationException`、無限遞迴、欄位改名炸前端…）。

**檢查方式（一行指令，值得加進 CI）**：

```bash
# 任何 web 套件底下的檔案 import 了 Repository → 立刻失敗
grep -rn "import .*\.repository\." src/main/java/example/shop/*/web/ && exit 1 || exit 0
```

更嚴謹的做法是用 ArchUnit（01-java-core 第 12 章）寫成測試：

```java
@Test
void controller不可依賴repository() {
    JavaClasses classes = new ClassFileImporter().importPackages("example.shop");
    noClasses().that().resideInAPackage("..web..")
        .should().dependOnClassesThat().resideInAPackage("..repository..")
        .check(classes);
}
```

**架構規則要變成會失敗的測試，否則它只是 wiki 上的一段字。**

### 0.6.4 不該做：管交易

```java
// ❌ Before
@Transactional                                    // ← 在 Controller 上
@PostMapping("/orders")
public ... create(...) { ... }
```

除了 0.3.2 後果 2 講的「連線被外部呼叫佔住」，還有一個更隱蔽的問題：

**`@Transactional` 加在 Controller 上時，交易會在 view 渲染 / JSON 序列化「之前」就結束嗎？**

答案是：`@Transactional` 的 proxy 在方法回傳時提交交易，
而 JSON 序列化發生在**方法回傳之後**（由 `HandlerMethodReturnValueHandler` 做）。
所以如果你回傳的物件裡有 lazy 關聯，序列化時 session 已關 → `LazyInitializationException` → 500。

很多團隊的「解法」是開 `spring.jpa.open-in-view=true`（Spring Boot 的**預設值就是 true**，
只會印一行 WARN）。這個設定讓 EntityManager 活到請求結束，於是：

| 開著 `open-in-view` 的代價 | 說明 |
|---|---|
| 資料庫連線被佔到請求結束 | 包含 JSON 序列化、網路寫回的時間 |
| 序列化過程中會偷偷發 SQL | N+1 查詢，而且發生在你看不到的地方 |
| 這些 SQL **不在任何交易裡** | 每一條都是獨立的 autocommit |

**正確做法**：`spring.jpa.open-in-view=false`（明確關掉），
交易邊界在 Service，Service 回傳**已經組裝完成的 DTO 或 detached 物件**。
Controller 拿到的東西不需要資料庫連線就能序列化。

```yaml
spring:
  jpa:
    open-in-view: false        # ★ 明確關掉；預設 true 是歷史包袱
```

（完整討論在 05-service 第 02 章與 08-jpa-mybatis 第 03 章。）

### 0.6.5 不該做：try-catch 包出錯誤回應

```java
// ❌ Before
try {
    ...
} catch (OrderNotFoundException e) {
    return ResponseEntity.status(404).body(Map.of("msg", e.getMessage()));
} catch (Exception e) {
    return ResponseEntity.status(500).body(Map.of("msg", e.getMessage()));
}
```

問題不是「try-catch 很醜」，而是：

1. **格式會分歧。** 15 個方法各寫一份，就會有 15 種錯誤格式（03-rest-api 第 00 章 0.3.1 症狀三）。
2. **會漏。** 新增第 16 個方法時忘了包 → 那支端點回 Tomcat 預設錯誤頁（HTML）→ 前端 `res.json()` 拋 `SyntaxError`。
3. **會洩漏。** `e.getMessage()` 可能是 SQL 語句（0.3.2 後果 5）。
4. **`catch (Exception e)` 會吃掉你不想吃的東西** —— 包括 `InterruptedException`
   （吃掉它會讓執行緒中斷訊號消失）與程式錯誤（`NullPointerException`，被當成「業務失敗」回 500 但沒有告警）。

✅ **After：Controller 裡一個 try-catch 都沒有。** 全部交給第 03 章的 `@RestControllerAdvice`。

### 0.6.6 不該做：發送通知、寄信、推播

這些是**副作用**，屬於 Service（而且通常應該非同步）。
放在 Controller 有三個具體問題：

| 問題 | 說明 |
|---|---|
| 佔用 Tomcat 執行緒 | SMTP 一次 0.8～3 秒。200 個執行緒撐不住 |
| 沒有交易語意 | 訂單寫入失敗回滾了，但信已經寄出 → 使用者收到「訂單成立」但查不到訂單 |
| 失敗無處重試 | `catch { e.printStackTrace(); }` = 信沒寄出，沒人知道 |

正確做法是在 Service 裡發領域事件，用 `@TransactionalEventListener(phase = AFTER_COMMIT)`
接（02-spring-boot 第 06 章講過機制，05-service 第 05 章會完整實作）。

### 0.6.7 不該做：自己解析 token / 判斷權限細節

```java
// ❌ Before
String token = request.getHeader("Authorization");
String customerId = redis.opsForValue().get("token:" + token.substring(7));
if (customerId == null) return ResponseEntity.status(401).build();
```

`token.substring(7)` 在 header 是 `"Bearer"`（沒有空格與值）時會拋 `StringIndexOutOfBoundsException` → 500。
而且這段程式碼在 15 個方法裡各有一份，其中 2 份忘了檢查 `null`。

✅ 認證是 **Filter 層**的事（Spring Security），Controller 只接結果：

```java
public ... create(..., @AuthenticationPrincipal CurrentUser user) { ... }
```

**「粗粒度授權」可以在 Controller**（宣告式，不是程式碼）：

```java
@PreAuthorize("hasRole('WAREHOUSE')")             // ✅ 這條端點誰能打 — 宣告在這裡合理
@PostMapping("/{orderId}/shipments")
public ShipmentResponse ship(...) { ... }
```

**「細粒度授權」必須往下推**：

```java
// ❌ 在 Controller 判斷「這張訂單是不是我的」
if (!order.getCustomerId().equals(user.customerId())) return status(403).build();

// ✅ 在 Service（或 Repository 的查詢條件）
//    因為「資料範圍」是業務規則，而且必須連批次任務、匯出、報表都一致
```

> **為什麼「是不是我的訂單」不能在 Controller 判斷？**
> 因為那個判斷只保護「這一條端點」。
> `GET /orders`（列表）、`POST /order-exports`（匯出）、`GET /customers/{id}/orders` 各有自己的路徑。
> 資料範圍寫在 Controller = 要在 N 個地方寫 N 次 = 一定會漏一個 = **IDOR 漏洞**。
> 寫在 Repository 的查詢條件裡 = 一份。
> （這是 OWASP API Security Top 10 的第一名 BOLA / IDOR；09-spring-security 第 06 章會完整處理。）

### 0.6.8 不該做：接受或回傳 Entity

```java
// ❌ Before
@PostMapping public Order create(@RequestBody Order order) { ... }
```

`@RequestBody Order` 是 **mass assignment 漏洞**：客戶端可以送

```json
{ "items": [...], "status": "PAID", "totalAmount": 1, "customerId": "cus_別人的" }
```

Jackson 會照著填。你的訂單就變成「已付款、金額 1 元、掛在別人頭上」。

（詳見 03-rest-api 第 03 章 3.2.6。這一站的 01、02 章會把 22 個 DTO 全部實作出來。）

### 0.6.9 不該做：把 `HttpServletRequest` 往下傳

```java
// ❌ Before
orderService.create(request);                      // request 是 HttpServletRequest
```

這是 0.4.2 的直接違規。它會像病毒一樣往下擴散：
Service 開始從 request 取值 → Repository 也想拿 IP 寫 audit log → 
最後連 `PriceCalculator` 都要一個 `HttpServletRequest` 才能 new 出來。

✅ Controller 把需要的東西**取出來，變成明確的參數**：

```java
public record RequestContext(
    String traceId, String clientIp, String userAgent, Actor actor) {}

orderService.create(command, requestContext);
```

（更好的做法是把 `traceId` 放進 MDC / `ThreadLocal`，Service 完全不用知道它 —— 04 章 4.4。）

### 0.6.10 不該做：快取、重試、限流的商業層決策

```java
// ❌ Before
String cached = redis.get("order:" + id);
if (cached != null) return objectMapper.readValue(cached, OrderDetail.class);
```

「什麼資料可以快取多久」是業務決策（05-service 第 04 章）。
Controller 只負責 **HTTP 層的快取語意** —— `ETag`、`Cache-Control`、`If-None-Match`
（這些是協定的一部分，屬於 Controller；06 章會實作）。

**兩者的區別**：

| 快取層次 | 決定什麼 | 放哪裡 |
|---|---|---|
| **HTTP 快取** | 要不要讓瀏覽器 / CDN 快取、`ETag` 怎麼算、`304` 什麼時候回 | Controller ✅ |
| **應用快取** | 要不要把 `Product` 放 Redis、TTL 多久、怎麼失效 | Service ✅ |

---

## 0.7 判斷邊界的五個問題

前面兩節是清單，但清單背後有原理。當你遇到清單沒列到的情況時，用這五個問題。
**按順序問，第一個給出答案的就是答案。**

### 問題 1：換掉 HTTP，這段程式碼還需要嗎？

想像同一個功能要多支援三個入口：CLI 指令、Kafka consumer、每天 03:00 的排程。

```
「檢查訂單狀態是否可取消」    → CLI 也需要   → Service
「從 JSON body 解出 reason」  → CLI 不需要   → Controller
「算退款金額」                → 排程也需要   → Service
「回 201 還是 200」            → Kafka 沒有狀態碼 → Controller
```

**這是最有效的一個問題，先問它。**

### 問題 2：這段程式碼認識 HTTP 的詞彙嗎？

如果一段程式碼裡出現這些字，它屬於 Controller（或更外層）：

```
狀態碼（200/404/409）、header、cookie、query string、
multipart、Content-Type、ETag、Location、CORS、session
```

如果出現這些字，它屬於 Service：

```
訂單、庫存、折扣、退款、狀態機、對帳、風控、可取消、逾時
```

⚠️ **兩邊的詞彙都出現的那一行，就是層次錯位的地方。**

```java
// 這一行同時有「已出貨」（業務）和「409」（HTTP）→ 錯位
if (order.isShipped()) return ResponseEntity.status(409).body(...);
```

修法：業務判斷留在 Service（拋領域例外），`409` 的對映搬到 advice（03 章）。

### 問題 3：這個判斷需要知道「現在的資料狀態」嗎？

這個問題劃出 **Controller 驗證** 與 **Service 驗證** 的界線。

| 判斷 | 需要查資料庫嗎 | 屬於 |
|---|---|---|
| `quantity` 是不是 1～999 的整數 | ❌ | Controller（Bean Validation） |
| `productId` 不是空字串、長度 ≤ 64 | ❌ | Controller |
| `couponCode` 符合 `^[A-Z0-9]{4,32}$` | ❌ | Controller |
| `type=COMPANY` 時 `taxId` 必填 | ❌（只看請求內部） | Controller（跨欄位驗證，02 章） |
| `productId` 真的存在 | ✅ | Service |
| 庫存夠不夠 | ✅ | Service |
| 折扣碼還在有效期、還沒用完 | ✅ | Service |
| 這張訂單現在可以取消 | ✅ | Service |

**規則：不需要查資料就能判斷的 → Controller；需要查的 → Service。**

理由不是教條，是效能與安全：

- Controller 的驗證是**便宜的門神**。它在第一時間擋掉明顯無效的請求，
  不讓它們消耗資料庫連線。惡意流量送 `quantity=-999999` 的時候，這一層擋住 100%。
- Service 的驗證是**真相的來源**。它在交易裡、看得到即時狀態，是唯一能保證正確的地方。

⚠️ **兩層都要有，不是二選一。** 常見錯誤是「Controller 驗過了 Service 就不驗」——
但 Service 還會被排程、批次匯入、內部呼叫使用，那些路徑沒有經過 Controller。
（這叫**驗證的多層防禦**，03-rest-api 第 09 章「每一層都是別人的安全網」。）

### 問題 4：這段程式碼失敗時，要回滾什麼？

```
「要回滾資料庫寫入」→ 需要交易 → Service
「什麼都不用回滾」→ 可以在 Controller
```

Controller 做的事（解析、驗證、翻譯）都是**純函式式的**：失敗了什麼都不用清理。
一旦某段程式碼失敗需要「補償」，它就已經在做業務操作了。

### 問題 5：我要為這段程式碼寫測試時，需要啟動什麼？

```
「需要 MockMvc / HTTP」          → 它在 Controller，這樣測是對的
「只需要 new 出來就能測」        → 它應該在 Service 或 Domain
「需要 MockMvc 才能測業務規則」  → ⚠️ 層次錯位了
```

第三種是最重要的警訊。如果你發現「要測滿千免運必須發一個 HTTP 請求」，
那條規則就放錯地方了。

### 0.7.1 決策流程圖

```
                    這段程式碼……
                          │
        ┌─────────────────┴──────────────────┐
        │ 換成 CLI / 排程 / Kafka 還需要它嗎？│
        └─────────────────┬──────────────────┘
                  不需要  │  需要
              ┌───────────┴──────────┐
              ▼                      ▼
      ┌──────────────┐      ┌──────────────────────┐
      │ 它在講 HTTP  │      │ 它需要查資料庫才能判斷│
      │ 的詞彙嗎？   │      │ 或需要寫入 / 回滾嗎？ │
      └──────┬───────┘      └──────────┬───────────┘
        是   │  否                 是  │  否
             │   │                     │   │
             ▼   ▼                     ▼   ▼
      Controller │              Service    │
                 ▼                         ▼
        ⚠️ 兩邊都不是 →          Domain（純規則，
        可能是基礎設施：           不需要 I/O 的
        Filter / Interceptor /     計算與狀態判斷）
        Advice（04 章）
```

---

## 0.8 一個請求的完整旅程

這一節是「地圖」。後面每一章都會回頭指這張圖上的某個點。
**內容以 Spring Boot 3.2 / Spring Framework 6.1 / 內嵌 Tomcat 10.1 為準。**

### 0.8.1 全景

```
① 網路
   TCP 連線 → Tomcat NIO Acceptor 接受 → 註冊到 Poller
   資料到齊 → 從執行緒池取一個工作執行緒（http-nio-8080-exec-7）
   ★ 從這裡開始到 ⑬ 結束，全程都在同一條執行緒上（ThreadLocal 可用）

② Tomcat 容器
   CoyoteAdapter → Engine → Host → Context(/) → Wrapper(dispatcherServlet)

③ Filter Chain（Servlet 規格；看得到 raw request/response）
   ┌ CharacterEncodingFilter        （Ordered.HIGHEST_PRECEDENCE）
   ├ ServerHttpObservationFilter    （HIGHEST_PRECEDENCE + 1；埋 metrics/trace）
   ├ FormContentFilter              （-9900；讓 PUT/PATCH 也能讀 form 參數）
   ├ RequestContextFilter           （-105；把 request 放進 ThreadLocal）
   ├ springSecurityFilterChain      （-100；認證、授權、CORS 預檢）
   ├ 你的 TraceIdFilter             （04 章；建議 order = -101，早於 Security）
   └ 你的 RequestLoggingFilter      （04 章）
                    │
                    ▼
④ DispatcherServlet.doDispatch()
   │
   ├─ checkMultipart()          ← MultipartResolver（05 章）
   ├─ getHandler()              ← RequestMappingHandlerMapping 比對 @RequestMapping
   │                              找不到 → NoHandlerFoundException（404）
   │                              找到但方法不對 → HttpRequestMethodNotSupportedException（405）
   ├─ getHandlerAdapter()       ← RequestMappingHandlerAdapter
   │
   ├─ ⑤ Interceptor.preHandle()     （Spring MVC 的；已知道要打哪個 handler）
   │
   ├─ ⑥ HandlerMethodArgumentResolver（逐一解析方法參數）
   │     · @PathVariable      → PathVariableMethodArgumentResolver
   │     · @RequestParam      → RequestParamMethodArgumentResolver
   │     · @RequestHeader     → RequestHeaderMethodArgumentResolver
   │     · @RequestBody       → RequestResponseBodyMethodProcessor
   │                            └→ HttpMessageConverter（MappingJackson2HttpMessageConverter）
   │                               └→ Jackson ObjectMapper.readValue()
   │                            └→ @Valid → LocalValidatorFactoryBean → Hibernate Validator
   │                               失敗 → MethodArgumentNotValidException
   │     · Pageable          → PageableHandlerMethodArgumentResolver
   │     · 你自訂的           → 04 章 4.6
   │
   ├─ ⑦ 你的 Controller 方法執行   ← 這裡是你寫的 5 行
   │     └→ Service（可能開交易）→ Repository → JDBC → MySQL
   │
   ├─ ⑧ HandlerMethodReturnValueHandler
   │     · 回傳 DTO      → RequestResponseBodyMethodProcessor
   │                        └→ 內容協商（06 章）決定 Content-Type
   │                        └→ HttpMessageConverter.write() → Jackson 寫 JSON
   │     · 回傳 ResponseEntity → HttpEntityMethodProcessor（可帶 header / 狀態碼）
   │     · 回傳 SseEmitter / StreamingResponseBody → 進入非同步模式（05 章）
   │
   ├─ ⑨ Interceptor.postHandle()   （⚠️ 例外發生時不會執行）
   │
   ├─ ⑩ processDispatchResult()
   │     有例外 → HandlerExceptionResolver 鏈：
   │       1. ExceptionHandlerExceptionResolver ← @RestControllerAdvice 在這裡（03 章）
   │       2. ResponseStatusExceptionResolver   ← @ResponseStatus / ResponseStatusException
   │       3. DefaultHandlerExceptionResolver   ← Spring MVC 內建例外的預設處理
   │     全都處理不了 → 往上拋給 Servlet 容器 → /error（BasicErrorController）
   │
   └─ ⑪ Interceptor.afterCompletion()  （★ 一定會執行，適合清理 MDC）

⑫ 回程穿過 Filter Chain（順序相反）
   ⚠️ 此時 response 可能已經 committed，改不了狀態碼

⑬ Tomcat 寫回 socket，執行緒歸還執行緒池
```

### 0.8.2 四種攔截機制的能力對照 ★

這張表是 04 章的核心，先在這裡建立印象。**選錯機制是最常見的錯誤之一。**

| 能力 | Filter | Interceptor | ArgumentResolver | AOP (`@Around`) | `@ControllerAdvice` |
|---|---|---|---|---|---|
| 規格層級 | Servlet | Spring MVC | Spring MVC | Spring AOP | Spring MVC |
| 能拿到原始 request/response | ✅ | ✅ | ✅ | ❌ | ⚠️ 需注入 |
| 能**包裝** request/response | ✅ 唯一 | ❌ | ❌ | ❌ | ❌ |
| 能讀 request body **並讓後面還能讀** | ✅（用 `ContentCachingRequestWrapper`） | ❌ | ✅（它就是在讀） | ❌ | ❌ |
| 知道要打哪個 Controller 方法 | ❌ | ✅ | ✅ | ✅ | ✅ |
| 拿得到已綁定 / 已驗證的參數 | ❌ | ❌ | ⚠️ 自己解 | ✅ | ✅ |
| 能終止請求 | ✅ 不呼叫 `chain.doFilter` | ✅ 回 `false` | ✅ 拋例外 | ✅ 拋例外 | — |
| 拋出的例外會被 advice 接到 | ❌ **不會** | ⚠️ `preHandle` 會 | ✅ 會 | ✅ 會 | — |
| 對非 Controller 的請求也生效（靜態檔、`/actuator`） | ✅ | ⚠️ 看 pattern | ❌ | ❌ | ❌ |
| 能改回應內容 | ✅（需包裝） | ⚠️ 有限 | — | ✅ | ✅ |

**三個最容易踩的坑，先預告：**

1. **Filter 拋的例外不會進 `@RestControllerAdvice`。**
   因為 advice 是 `DispatcherServlet` 內部的機制，而 Filter 在它外面。
   Filter 拋例外 → Tomcat 的錯誤頁（HTML）→ 前端 `res.json()` 爆掉。
   👉 Filter 裡要**自己**寫 JSON 回應。（04 章 4.3.5 給完整程式碼）

2. **Spring Security 的 401 / 403 也不會進 advice。**
   它們由 `AuthenticationEntryPoint` / `AccessDeniedHandler` 產生，
   而那兩個東西在 Filter 層。（09-spring-security 第 03 章；03 章會先給一版設定）

3. **`postHandle` 在例外發生時不執行，`afterCompletion` 一定執行。**
   所以「清理 MDC」「歸還資源」一律寫在 `afterCompletion`。
   寫在 `postHandle` 的清理程式碼，會在錯誤路徑上洩漏 —— 
   而錯誤路徑正是你最需要那些資訊正確的時候。

### 0.8.3 一次真實的 timing 分解

用 `GET /orders/{id}` 的實測（本機、資料已在 buffer pool、p50）：

| 階段 | 耗時 | 佔比 |
|---|---|---|
| Tomcat 接受 + 交給 Servlet | 0.08 ms | 2% |
| Filter chain（含 Security 驗 JWT） | 0.35 ms | 9% |
| HandlerMapping 找 handler | 0.02 ms | <1% |
| 參數綁定（`@PathVariable`，無 body） | 0.01 ms | <1% |
| **Controller → Service → Repository → MySQL** | **2.9 ms** | **74%** |
| DTO 組裝（mapper） | 0.12 ms | 3% |
| Jackson 序列化（20 個欄位 + 2 個子物件） | 0.31 ms | 8% |
| 回程 filter + 寫回 socket | 0.13 ms | 3% |
| **合計** | **≈ 3.9 ms** | |

**兩個結論：**

1. **框架的開銷很小（約 1 ms）。** 效能問題 99% 在資料查詢，不在 Spring MVC。
   所以「換 WebFlux 讓 API 變快」通常是錯的方向（0.9 節）。
2. **Jackson 序列化是第二名。** 回應欄位越多越慢，
   這是「不要無腦回傳所有欄位」的效能理由（03-rest-api 第 03 章 3.8.3 的 `?fields=`）。

⚠️ 這些數字只是量級參考，你的環境一定不同。重點是**比例**，不是絕對值。

---

## 0.9 Spring MVC 還是 WebFlux

這一站全部用 **Spring MVC**（`spring-boot-starter-web`）。先講清楚為什麼，免得你後來看到 WebFlux 的文章覺得學錯了。

### 0.9.1 兩者的差別在哪

| | Spring MVC | Spring WebFlux |
|---|---|---|
| 模型 | 一個請求一條執行緒（thread-per-request） | 事件驅動，少量 event loop 執行緒 |
| API | `OrderDetail get()` | `Mono<OrderDetail> get()` |
| 阻塞 | 允許（執行緒就是給你擋的） | ❌ **一次阻塞就毀掉整個 event loop** |
| 資料庫 | JDBC（阻塞） | R2DBC（非阻塞，生態遠小於 JDBC） |
| 除錯 | stack trace 完整、可讀 | stack trace 是 reactor 內部，難讀 |
| ThreadLocal / MDC | 直接可用 | 需要 `Context` + hook，容易漏 |
| 學習曲線 | 平 | 陡（`flatMap`、背壓、冷熱流） |

### 0.9.2 判斷表

| 你的情況 | 選 |
|---|---|
| CRUD + 關聯式資料庫（**90% 的專案**） | **MVC** |
| 團隊沒有 reactive 經驗 | **MVC** |
| 需要 JPA / MyBatis | **MVC**（它們是阻塞的） |
| 大量並行的**外部 HTTP 呼叫**聚合（API Gateway、BFF） | WebFlux（或 MVC + 虛擬執行緒） |
| 長連線很多（SSE / WebSocket 上萬條） | WebFlux |
| 需要背壓（串流處理） | WebFlux |

### 0.9.3 Java 21 虛擬執行緒改變了什麼

這是 2023 年之後最重要的變化，值得單獨講。

「MVC 的問題」向來被描述成：一條執行緒被 I/O 阻塞時什麼也不做，
而作業系統執行緒很貴（每條約 1 MB stack），所以池子開不大（通常 200）。

**Java 21 的虛擬執行緒（JEP 444，正式版）讓這個前提不成立了。**
虛擬執行緒阻塞時會**卸載（unmount）**掉底層的載體執行緒，成本接近 reactive 的效果，
但你寫的還是同步、可讀、stack trace 完整的程式碼。

Spring Boot 3.2+ 開一行設定就好：

```yaml
spring:
  threads:
    virtual:
      enabled: true          # Tomcat 用虛擬執行緒處理請求（需 Java 21+）
```

**開之前務必知道的三件事** ★

| 注意事項 | 說明 |
|---|---|
| **`synchronized` 會 pin 住載體執行緒** | Java 21 裡，在 `synchronized` 區塊內阻塞會讓虛擬執行緒無法卸載，失去全部好處。舊版函式庫（部分 JDBC driver、連線池）有這問題。改用 `ReentrantLock`。<br>⚠️ JDK 24+（JEP 491）解決了大部分 pinning，但你若跑在 21 LTS 上就要注意 |
| **`ThreadLocal` 語意變了** | 虛擬執行緒不重用，所以 `ThreadLocal` 不會殘留（好事），但**執行緒池型的快取**（例如 per-thread 的 `SimpleDateFormat`）會失去效果，反而變慢 |
| **連線池仍然是瓶頸** | 你有 10,000 條虛擬執行緒不代表能同時打 10,000 條 SQL。HikariCP 只有 10 條連線 —— 瓶頸只是從執行緒池搬到連線池 |

> **結論**：2026 年做一個新的 Spring Boot 後端，
> **預設選 MVC；需要高並行 I/O 時先試虛擬執行緒；只有在真的需要背壓或超大量長連線時才考慮 WebFlux。**
>
> WebFlux 的複雜度是**持續性成本**（每個新人都要學、每次除錯都要付），
> 而虛擬執行緒的成本是**一行 YAML**。

---

## 0.10 完整重構：800 行 → 40 行

現在把 0.3 那段程式碼真的拆完。這一節是本章的壓軸。

### 0.10.1 拆解對照表

| 原始程式碼段落 | 搬去哪裡 | 章節 |
|---|---|---|
| 手動從 `Map` 取值、轉型 | `CreateOrderRequest` record + Jackson | 01 |
| `if (items == null \|\| items.isEmpty())` | `@NotEmpty` | 02 |
| `if (addressId == null \|\| trim().equals(""))` | `@NotBlank` | 02 |
| 解 `Authorization` header、查 Redis | Spring Security filter → `@AuthenticationPrincipal` | 09 |
| 查商品、檢查庫存、扣庫存 | `OrderService` + `InventoryService` | 05 |
| 算小計 / 折扣 / 運費 | `OrderPricingService`（純函式，好測） | 05 |
| 產生訂單編號 | `OrderNumberGenerator` | 05 |
| 寫 Order / OrderItem | `OrderRepository`（在 Service 的交易裡） | 06 |
| 呼叫 ERP | `ErpClient`（有 timeout、有熔斷），交易外 | 05 |
| 寄信 | `OrderCreatedEvent` + `AFTER_COMMIT` listener，非同步 | 05 |
| `result.put("code", ...)` 包裝 | `CreateOrderResponse` DTO | 01 |
| `catch (Exception e)` | `@RestControllerAdvice` | 03 |
| 冪等（原本沒有！） | `Idempotency-Key` header + Interceptor | 04 |
| traceId（原本沒有！） | `TraceIdFilter` + MDC | 04 |

### 0.10.2 重構後的 Controller

```java
package example.shop.order.web;

import example.shop.common.web.ApiHeaders;
import example.shop.order.service.OrderService;
import example.shop.order.web.dto.CreateOrderRequest;
import example.shop.order.web.dto.CreateOrderResponse;
import example.shop.security.CurrentUser;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.servlet.support.ServletUriComponentsBuilder;
import org.springframework.http.ResponseEntity;

@RestController
@RequestMapping(path = "/orders", produces = MediaType.APPLICATION_JSON_VALUE)
public class OrderController {

    private final OrderService orderService;
    private final OrderWebMapper mapper;

    // ★ 建構子注入，不用 @Autowired 欄位注入（理由見 0.10.4）
    public OrderController(OrderService orderService, OrderWebMapper mapper) {
        this.orderService = orderService;
        this.mapper = mapper;
    }

    @PostMapping(consumes = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<CreateOrderResponse> create(
            @Valid @RequestBody CreateOrderRequest request,
            @RequestHeader(ApiHeaders.IDEMPOTENCY_KEY) @NotBlank @Size(max = 64) String idempotencyKey,
            @AuthenticationPrincipal CurrentUser user) {

        var order = orderService.create(mapper.toCommand(request, user.actor(), idempotencyKey));
        var body  = mapper.toCreateResponse(order);

        var location = ServletUriComponentsBuilder.fromCurrentRequest()
                .path("/{orderId}")
                .buildAndExpand(body.orderId())
                .toUri();

        return ResponseEntity.created(location).body(body);       // 201 + Location
    }

    @GetMapping("/{orderId}")
    public OrderDetail get(@PathVariable String orderId,
                           @AuthenticationPrincipal CurrentUser user) {
        return mapper.toDetail(orderService.findById(orderId, user.actor()), user.role());
    }

    @PatchMapping(path = "/{orderId}", consumes = MediaType.APPLICATION_JSON_VALUE)
    public OrderDetail patch(@PathVariable String orderId,
                             @Valid @RequestBody UpdateOrderRequest request,
                             @AuthenticationPrincipal CurrentUser user) {
        return mapper.toDetail(
                orderService.update(mapper.toCommand(orderId, request, user.actor())),
                user.role());
    }
}
```

**三個方法，40 行（含 import）。** 每個方法的結構完全一樣：

```
綁定 → 驗證（註解做的）→ 轉 Command → 呼叫 Service → 轉 Response → 決定狀態碼
```

**這個結構之後 70 條端點都一樣。** 這就是「瘦 Controller」的實際樣子 ——
不是「行數少」，而是**「每個方法都長得一樣，沒有一個特例」**。

### 0.10.3 Mapper 長什麼樣

Controller 瘦下來的程式碼不會消失，一部分變成 mapper。這是划算的交換，因為 mapper 是**純函式**。

```java
package example.shop.order.web;

import example.shop.order.service.command.CreateOrderCommand;
import org.springframework.stereotype.Component;

@Component
public class OrderWebMapper {

    public CreateOrderCommand toCommand(CreateOrderRequest req, Actor actor, String idempotencyKey) {
        return new CreateOrderCommand(
                actor,
                idempotencyKey,
                req.items().stream()
                   .map(i -> new CreateOrderCommand.Line(i.productId(), i.quantity()))
                   .toList(),
                req.shippingAddressId(),
                req.couponCode(),
                req.customerNote(),
                toInvoiceSpec(req.invoice())
        );
    }

    public CreateOrderResponse toCreateResponse(Order order) {
        return new CreateOrderResponse(
                order.getId(),
                order.getOrderNumber(),
                order.getStatus().name(),
                order.getStatus().label(),
                order.getStatus().category().name(),
                order.allowedActions().stream().map(Enum::name).toList(),
                toAmounts(order),
                order.getCurrency().getCurrencyCode(),
                order.totalItemQuantity(),
                toCoupon(order.getAppliedCoupon()),
                order.getCreatedAt(),
                order.getExpiresAt()
        );
    }
    // ...
}
```

**注意 `toCommand` 多塞了兩個東西**：`actor`（誰在操作）與 `idempotencyKey`。
它們不在請求 body 裡 —— 一個來自認證、一個來自 header。
**「把散落在 HTTP 各處的資訊收攏成一個 Java 物件」就是 Controller 的核心價值。**

測試它不需要 Spring：

```java
@Test
void toCommand_把header與認證資訊一起收攏() {
    var mapper = new OrderWebMapper();
    var cmd = mapper.toCommand(
            new CreateOrderRequest(List.of(new Item("P-1", 2)), "addr_1", null, null, null),
            new Actor(ActorType.CUSTOMER, "cus_1"),
            "idem-abc");

    assertThat(cmd.actor().id()).isEqualTo("cus_1");
    assertThat(cmd.idempotencyKey()).isEqualTo("idem-abc");
    assertThat(cmd.lines()).hasSize(1);
}
```

### 0.10.4 為什麼建構子注入而不是 `@Autowired` 欄位注入

0.3 那段程式碼用了 10 個 `@Autowired` 欄位。除了「10 個依賴本身就是設計問題」之外，
**欄位注入的形式本身也有四個問題**：

| 問題 | 說明 |
|---|---|
| **依賴數量被藏起來** | 建構子有 10 個參數時，IDE 和 code review 都會刺眼；10 個欄位散在檔案裡看不出來。**這是最重要的理由：建構子是天然的複雜度警報器** |
| **不能宣告 `final`** | 欄位注入的欄位可以被改，也可能在初始化順序問題下是 `null` |
| **不能不靠 Spring 建立物件** | 單元測試要 `new OrderController(mockService, mapper)`，欄位注入做不到（只能用反射或 `@InjectMocks`） |
| **鼓勵循環依賴** | 建構子注入時，A↔B 循環會在啟動時直接失敗；欄位注入會「成功啟動然後在某個路徑上 NPE」 |

Spring 4.3+ 起，**只有一個建構子時可以省略 `@Autowired`**。
搭配 Lombok 的 `@RequiredArgsConstructor` 可以更短，但這一站刻意寫出完整建構子，
讓你看得見依賴清單。

---

## 0.11 shop-service 專案骨架

### 0.11.1 套件結構：package-by-feature

兩種切法：

```
❌ package-by-layer（按技術分層）
example.shop
├── controller     ← 70 個 Controller 全部塞這裡
├── service
├── repository
├── dto
└── entity
```

```
✅ package-by-feature（按領域分，內部再分層）
example.shop
├── order
│   ├── web            ← OrderController、mapper、DTO
│   ├── service        ← 介面 + command 型別（實作在 05-service）
│   └── domain         ← Order、OrderStatus、狀態機
├── product
├── cart
├── payment
└── common             ← 跨領域共用的基礎設施
```

**為什麼選後者？** 四個具體理由：

| 理由 | 說明 |
|---|---|
| **一個需求 = 一個資料夾** | 「訂單取消要加審核」→ 全部改動都在 `order/`。不用在 5 個套件之間跳 |
| **可以用 package-private 收斂** | `OrderWebMapper` 只有 `order.web` 用得到，就不用是 `public`。編譯器幫你守邊界 |
| **依賴一目了然** | `order` 套件 import 了 `payment.domain` → 立刻看得出跨領域耦合。ArchUnit 也好寫規則 |
| **要拆微服務時，資料夾直接搬** | package-by-layer 要拆的話得把 5 個套件各挑一部分出來 |

> package-by-layer 唯一的優勢是「新人一眼知道 Controller 在哪」。
> 但那個優勢在專案超過 20 個類別後就消失了，而且是**永久性的成本**。

### 0.11.2 完整骨架

```
shop-service/
├── pom.xml
├── src/main/java/example/shop/
│   ├── ShopServiceApplication.java
│   │
│   ├── common/                                 ← 跨領域基礎設施（04 章大量產出在這裡）
│   │   ├── web/
│   │   │   ├── ApiHeaders.java                 常數：Idempotency-Key、X-Request-Id…
│   │   │   ├── PageResponse.java               統一的分頁外殼（03-rest-api 3.11）
│   │   │   ├── ApiExceptionHandler.java        @RestControllerAdvice   ← 03 章
│   │   │   ├── ProblemFactory.java             組 RFC 9457 回應         ← 03 章
│   │   │   ├── TraceIdFilter.java              traceId + MDC           ← 04 章
│   │   │   ├── RequestLoggingFilter.java       請求日誌                 ← 04 章
│   │   │   ├── PageableGuardInterceptor.java   分頁參數硬上限           ← 04 章
│   │   │   └── resolver/
│   │   │       └── CurrentActorArgumentResolver.java                   ← 04 章
│   │   ├── error/
│   │   │   ├── ErrorCode.java                  錯誤碼註冊表（enum）     ← 03 章
│   │   │   ├── BusinessException.java          領域例外基底
│   │   │   ├── ResourceNotFoundException.java
│   │   │   └── ValidationFailedException.java
│   │   ├── validation/
│   │   │   ├── SortWhitelist.java              自訂驗證註解             ← 02 章
│   │   │   └── ValidInvoice.java
│   │   └── config/
│   │       ├── WebMvcConfig.java               interceptor / resolver 註冊
│   │       ├── JacksonConfig.java              全域序列化設定           ← 06 章
│   │       ├── CorsConfig.java                                          ← 06 章
│   │       └── ApiLimitProperties.java         @ConfigurationProperties
│   │
│   ├── order/
│   │   ├── web/
│   │   │   ├── OrderController.java
│   │   │   ├── OrderItemController.java
│   │   │   ├── OrderPaymentController.java
│   │   │   ├── OrderCancellationController.java
│   │   │   ├── OrderShipmentController.java
│   │   │   ├── OrderExportController.java                              ← 05 章
│   │   │   ├── OrderEventStreamController.java  SSE                    ← 05 章
│   │   │   ├── OrderWebMapper.java
│   │   │   └── dto/
│   │   │       ├── CreateOrderRequest.java
│   │   │       ├── UpdateOrderRequest.java
│   │   │       ├── CreateOrderResponse.java
│   │   │       ├── OrderSummary.java
│   │   │       ├── OrderDetail.java
│   │   │       ├── OrderDetailForSupport.java
│   │   │       ├── OrderFilter.java             查詢參數綁定物件
│   │   │       └── …（共 22 個，見 03-rest-api 3.14.5）
│   │   ├── service/
│   │   │   ├── OrderService.java                ★ 只有介面
│   │   │   ├── command/
│   │   │   │   ├── CreateOrderCommand.java
│   │   │   │   ├── CancelOrderCommand.java
│   │   │   │   └── …
│   │   │   └── exception/
│   │   │       ├── OrderNotCancellableException.java
│   │   │       └── InsufficientStockException.java
│   │   └── domain/
│   │       ├── Order.java
│   │       ├── OrderStatus.java                 含狀態機與 allowedActions
│   │       └── Actor.java
│   │
│   ├── product/  …（同樣結構）
│   ├── cart/     …
│   └── payment/  …
│
├── src/main/resources/
│   ├── application.yml
│   ├── application-local.yml
│   └── messages_zh_TW.properties                驗證訊息 i18n            ← 02 章
│
└── src/test/java/example/shop/
    ├── order/web/
    │   ├── OrderControllerTest.java             @WebMvcTest              ← 07 章
    │   ├── OrderControllerValidationTest.java
    │   └── OrderControllerErrorTest.java
    └── common/web/
        ├── ApiExceptionHandlerTest.java
        └── TraceIdFilterTest.java
```

### 0.11.3 `pom.xml`

```xml
<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0
                             https://maven.apache.org/xsd/maven-4.0.0.xsd">
  <modelVersion>4.0.0</modelVersion>

  <parent>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-parent</artifactId>
    <version>3.2.5</version>
    <relativePath/>
  </parent>

  <groupId>example</groupId>
  <artifactId>shop-service</artifactId>
  <version>0.0.1-SNAPSHOT</version>

  <properties>
    <java.version>21</java.version>
  </properties>

  <dependencies>
    <!-- Web 層本體：Spring MVC + 內嵌 Tomcat + Jackson -->
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-web</artifactId>
    </dependency>

    <!-- ★ Bean Validation：Boot 2.3 起「不再」隨 web starter 附帶，必須自己加 -->
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-validation</artifactId>
    </dependency>

    <!-- 02 章：JsonNullable（PATCH 的三態語意） -->
    <dependency>
      <groupId>org.openapitools</groupId>
      <artifactId>jackson-databind-nullable</artifactId>
      <version>0.2.6</version>
    </dependency>

    <!-- 07 章：OpenAPI 文件（springdoc，Boot 3 要用 2.x） -->
    <dependency>
      <groupId>org.springdoc</groupId>
      <artifactId>springdoc-openapi-starter-webmvc-ui</artifactId>
      <version>2.5.0</version>
    </dependency>

    <!-- 04 章：/actuator/mappings 用來檢查路由 -->
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-actuator</artifactId>
    </dependency>

    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-test</artifactId>
      <scope>test</scope>
    </dependency>
  </dependencies>

  <build>
    <plugins>
      <plugin>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-maven-plugin</artifactId>
      </plugin>
      <plugin>
        <groupId>org.apache.maven.plugins</groupId>
        <artifactId>maven-compiler-plugin</artifactId>
        <configuration>
          <!-- ★ 讓 @RequestParam("x") 的 "x" 可以省略（見 01 章 1.4.3） -->
          <parameters>true</parameters>
        </configuration>
      </plugin>
    </plugins>
  </build>
</project>
```

⚠️ **兩個一定會踩的坑先講**：

1. **`spring-boot-starter-validation` 必須自己加。**
   Spring Boot 2.3 起把它從 web starter 移出來了。
   沒加的話 `@Valid`、`@NotBlank` **完全不會生效，也不會有任何錯誤訊息** ——
   請求會帶著 `null` 一路衝進 Service。這是最常見的「驗證沒生效」原因。
2. **`<parameters>true</parameters>`**：Spring Framework 6.1 起，
   如果沒有這個編譯選項，`@RequestParam String status` 這種**省略名稱**的寫法會在啟動時直接失敗
   （以前是靠 `-parameters` 或 ASM 猜；6.1 開始不再猜了）。
   `spring-boot-starter-parent` 其實已經幫你設了，但如果你不用它當 parent 就要自己加。

### 0.11.4 `application.yml`（Web 層相關設定）

```yaml
spring:
  application:
    name: shop-service

  mvc:
    problemdetails:
      enabled: true                 # 內建例外也回 application/problem+json
                                    # ⚠️ 03 章會把這一行改成 false —— 它註冊的內部 advice
                                    #    order=0，會蓋掉我們自己的 advice（03 章 3.7.5）
    throw-exception-if-no-handler-found: true    # 404 走 advice 而不是 /error
    hiddenmethod:
      filter:
        enabled: false              # Boot 3 預設就是 false，明確寫出來
  web:
    resources:
      add-mappings: false           # 關掉靜態資源對映，純 API 服務不需要
                                    # ⚠️ 03 章會改回 true —— 它會讓 Swagger UI 404，
                                    #    而 Boot 3.2 的 NoResourceFoundException 已經
                                    #    能讓 404 進 advice（03 章 3.8.2）

  jackson:
    default-property-inclusion: non_null      # 06 章會詳談
    deserialization:
      fail-on-unknown-properties: true        # ★ 未知欄位報錯（03-rest-api 3.13.4）
    serialization:
      write-dates-as-timestamps: false        # 用 ISO-8601 而不是 epoch
      fail-on-empty-beans: false
    time-zone: UTC

  jpa:
    open-in-view: false             # ★ 0.6.4；預設 true 是歷史包袱

  servlet:
    multipart:
      max-file-size: 10MB           # 05 章
      max-request-size: 20MB
      file-size-threshold: 1MB

  data:
    web:
      pageable:
        default-page-size: 20
        max-page-size: 100          # ⚠️ 預設 2000；而且是靜默夾取（04 章 4.5）
        one-indexed-parameters: false

server:
  port: 8080
  error:
    include-message: never          # ★ 不洩漏例外訊息
    include-binding-errors: never
    include-stacktrace: never
    include-exception: false
  tomcat:
    threads:
      max: 200
    max-http-form-post-size: 2MB
    connection-timeout: 5s
  compression:
    enabled: true
    mime-types: application/json,application/problem+json
    min-response-size: 2048

# 自訂的 API 限制（04、05 章會用到）
api:
  limits:
    max-page-size: 100
    max-offset: 10000               # 深分頁上限
    max-request-body-bytes: 1048576
    max-json-depth: 20

logging:
  pattern:
    # ★ 把 traceId 放進每一行日誌（04 章 4.4）
    console: "%d{HH:mm:ss.SSS} [%thread] %-5level [%X{traceId:-}] %logger{36} - %msg%n"

management:
  endpoints:
    web:
      exposure:
        include: health,info,mappings,metrics
```

> ⚠️ **這份 YAML 有兩行會在 03 章被推翻**（`problemdetails.enabled` 與 `add-mappings`）。
> 這裡先給「教科書版」的設定，等你在 03 章實作出完整的 advice 之後，
> 才會知道為什麼那兩行要改。**兩處都有 inline 註解指向 03 章。**

**`spring.web.resources.add-mappings: false` 是一個很容易漏的設定。**
它的預設值 `true` 會註冊一個「什麼路徑都吃」的 `ResourceHttpRequestHandler`。
結果是：打一個不存在的 `/ordres`（打錯字）時，
`RequestMappingHandlerMapping` 找不到 → 交給 resource handler → 找不到檔案 → 
回 Spring Boot 的預設 `/error` 頁面，**而不是你的 advice 產生的 404 Problem JSON**。

搭配 `throw-exception-if-no-handler-found: true`，你才能讓 404 也走統一格式（03 章 3.6 會驗證）。

### 0.11.5 這一站要實作的端點（對照 03-rest-api 的契約）

從 70 條端點裡挑出這一站要做的（其餘在 10-capstone 補完）：

| 章節 | 實作的端點 |
|---|---|
| 01 | `GET /orders`、`POST /orders`、`GET /orders/{id}`、`PATCH /orders/{id}`、`GET /orders/{id}/items`、`GET /orders/{id}/status-changes`、`PUT /orders/{id}/invoice` |
| 02 | 上述全部端點的驗證 + `POST /orders/{id}/payments`（卡號、發票的跨欄位驗證） |
| 03 | 全部端點的錯誤路徑（約 60 個 code 落地） |
| 04 | `POST /orders`（冪等鍵）、`GET /orders`（分頁上限）、全站 traceId |
| 05 | `POST /products/{id}/images`、`POST /order-exports`、`GET /order-exports/{id}/file`、`GET /orders/{id}/events`（SSE） |
| 06 | 全站 CORS + Jackson；`GET /orders/{id}` 的 `ETag` |
| 07 | 上述全部的 MockMvc 測試 |

---

## 0.12 把專案跑起來（15 分鐘）

在讀 01 章之前，先確認你有一個能動的骨架。

### 0.12.1 產生專案

```bash
curl https://start.spring.io/starter.zip \
  -d dependencies=web,validation,actuator \
  -d javaVersion=21 \
  -d bootVersion=3.2.5 \
  -d type=maven-project \
  -d groupId=example \
  -d artifactId=shop-service \
  -d packageName=example.shop \
  -o shop-service.zip
unzip shop-service.zip -d shop-service
cd shop-service
```

### 0.12.2 一個最小可跑的 Controller

```java
// src/main/java/example/shop/order/web/OrderProbeController.java
package example.shop.order.web;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.time.Instant;
import java.util.Map;

/** 純粹用來確認環境可用；01 章開始就會被真正的 OrderController 取代。 */
@RestController
@RequestMapping("/orders")
public class OrderProbeController {

    @GetMapping("/{orderId}")
    public Map<String, Object> probe(@PathVariable String orderId) {
        return Map.of(
                "orderId", orderId,
                "status", "PENDING_PAYMENT",
                "serverTime", Instant.now().toString()
        );
    }
}
```

```bash
./mvnw spring-boot:run
```

```bash
curl -s localhost:8080/orders/ord_123 | jq
```

```json
{
  "orderId": "ord_123",
  "status": "PENDING_PAYMENT",
  "serverTime": "2026-08-20T02:11:37.412Z"
}
```

### 0.12.3 立刻做四件事，看見 0.8 那張圖

**① 看所有已註冊的路由**

```bash
curl -s localhost:8080/actuator/mappings \
  | jq '.contexts.application.mappings.dispatcherServlets.dispatcherServlet[]
        | {pattern: .details.requestMappingConditions.patterns[0],
           methods: .details.requestMappingConditions.methods,
           handler: .handler}'
```

這是**排查「為什麼我的端點 404」的第一招**：先確認它到底有沒有被註冊。

**② 看所有已註冊的 Filter 與順序**

```java
// 貼進 ShopServiceApplication，啟動時印出來
@Bean
ApplicationRunner printFilters(ApplicationContext ctx) {
    return args -> ctx.getBeansOfType(jakarta.servlet.Filter.class)
            .forEach((name, f) -> {
                int order = (f instanceof org.springframework.core.Ordered o)
                        ? o.getOrder() : Integer.MAX_VALUE;
                System.out.printf("%-6d %s%n", order, name);
            });
}
```

**③ 開啟 `DispatcherServlet` 的 TRACE 日誌**

```yaml
logging:
  level:
    org.springframework.web: TRACE
```

再打一次請求，你會看到 0.8.1 那條路徑上每一步的日誌：

```
DispatcherServlet   : GET "/orders/ord_123", parameters={}
RequestMappingHandlerMapping : Mapped to example.shop.order.web.OrderProbeController#probe(String)
RequestResponseBodyMethodProcessor : Using 'application/json', given [*/*] ...
RequestResponseBodyMethodProcessor : Writing [{orderId=ord_123, ...}]
DispatcherServlet   : Completed 200 OK
```

**這四行日誌對應 0.8.1 的 ④ → getHandler → ⑧ → ⑬。**
排查 Web 層問題時，先開這個日誌，通常 30 秒內就知道卡在哪一步。

**④ 確認執行緒名稱**

```java
@GetMapping("/thread")
public String thread() { return Thread.currentThread().toString(); }
```

```
Thread[#43,http-nio-8080-exec-1,5,main]
```

打開 `spring.threads.virtual.enabled=true` 再看一次：

```
VirtualThread[#65]/runnable@ForkJoinPool-1-worker-1
```

**這是 0.9.3 的實際證據**，也是判斷「虛擬執行緒有沒有真的生效」最快的方法。

---

## 0.13 常見誤區

**誤區 1：「Controller 很薄就代表分層做對了」**

薄不等於對。這個 Controller 只有 3 行，但它是錯的：

```java
@PostMapping("/orders")
public Order create(@RequestBody Order order) {
    return orderRepository.save(order);          // ← 薄，但同時犯了 3 條規則
}
```

它違反 0.6.3（注入 Repository）、0.6.8（Entity 進出）、0.6.4（沒有交易與業務規則）。
**判準不是行數，是「這些行在做翻譯還是做決策」。**

**誤區 2：「分層就是多寫幾個檔案，是過度設計」**

過度設計是「為了想像中的需求增加抽象」。分層解決的是**已經發生的**問題
（0.3.2 的六個後果都是真的發生過的）。

但確實有過度的版本：為一個純 CRUD 的內部後台開 `Controller → Service → 
DomainService → Repository → Mapper → Entity → DTO → VO`，
每層都只是轉呼叫。判準：**每一層都要能回答「你阻止了什麼變更擴散？」**
答不出來的那一層就是多的。

**誤區 3：「DTO 和 Entity 長得一樣，所以直接用 Entity」**

它們**現在**長得一樣，因為系統還小。
一年後 Entity 會多出 `deletedAt`、`version`、`createdBy`、`tenantId`、`passwordHash`、
`internalRiskScore` —— 而 DTO 不該有這些。
「現在一樣」不是理由，因為改變它的成本會隨端點數線性增加。

**誤區 4：「錯誤處理當然要 try-catch，不然怎麼回錯誤訊息」**

這是把「例外處理」和「例外處理的位置」搞混了。
例外當然要處理，但處理它的地方應該是**一個**地方（advice），不是 70 個地方。
（03 章會證明這件事：70 條端點，一個 advice 類別。）

**誤區 5：「我們是小專案 / MVP，先塞在一起，以後再拆」**

「以後」的成本不是線性的。
5 個端點時拆層要 2 小時；50 個端點時要 2 週，而且需要一輪完整回歸測試
（因為沒有測試 —— 沒有測試正是不分層的直接後果，0.3.2 後果 3）。

更現實的觀察：**「以後再拆」的專案，98% 沒有拆。**
因為到了那時候，「重構但沒有新功能」的 PR 排不進 sprint。

**誤區 6：「用了 Spring Boot 就自動有分層」**

Spring Boot 只提供 `@RestController`、`@Service`、`@Repository` 三個註解。
它**不會**阻止你在 `@RestController` 裡注入 `JdbcTemplate`。
分層是你的紀律，框架只提供工具。
👉 所以要用 ArchUnit（0.6.3）把紀律變成會失敗的測試。

**誤區 7：「`@Service` 這個註解讓那個類別變成 Service 層」**

`@Service` 和 `@Component` 在功能上**完全等價**（`@Service` 的定義就是加了 `@Component`）。
它只是給人看的語意標記，也是 AOP pointcut 可以抓的標的。
把一個 1,000 行的類別加上 `@Service`，它還是 1,000 行的爛程式碼。

---

## 0.14 本章練習

### 練習 1：判斷這 15 段程式碼屬於哪一層

對每一段回答：**Controller / Service / Repository / Domain / 基礎設施（Filter 等）**，並說出你用了哪個問題（0.7 的五問）。

```java
// (1)
if (request.quantity() > 999) throw new ValidationException("數量上限 999");

// (2)
if (product.getStock() < quantity) throw new InsufficientStockException(...);

// (3)
response.setHeader("ETag", "\"v" + order.getVersion() + "\"");

// (4)
BigDecimal total = subtotal.subtract(discount).add(shippingFee);

// (5)
return jdbcTemplate.query("select * from t_order where customer_id = ?", mapper, customerId);

// (6)
MDC.put("traceId", UUID.randomUUID().toString().replace("-", "").substring(0, 16));

// (7)
if (!order.getStatus().isCancellable()) throw new OrderNotCancellableException(...);

// (8)
return ResponseEntity.created(URI.create("/orders/" + id)).body(dto);

// (9)
if (actor.type() != ActorType.SUPPORT) spec = spec.and(ownedBy(actor.id()));

// (10)
String orderNumber = "ORD-" + LocalDate.now(ZONE_TW).format(BASIC_ISO_DATE)
                   + "-" + String.format("%04d", sequence.next());

// (11)
if (!"application/json".equals(request.getContentType())) return status(415).build();

// (12)
eventPublisher.publishEvent(new OrderCreatedEvent(order.getId()));

// (13)
public boolean isCancellable() {
    return this == PENDING_PAYMENT || this == PAID;
}

// (14)
if (request.getHeader("Idempotency-Key") == null) throw new IdempotencyKeyRequiredException();

// (15)
Cache.put("product:" + id, product, Duration.ofMinutes(5));
```

<details>
<summary>解答</summary>

| # | 屬於 | 判準 |
|---|---|---|
| (1) | **Controller**（而且應該用 `@Max(999)` 而不是手寫 `if`） | 問題 3：不用查資料就能判斷 |
| (2) | **Service** | 問題 3：需要當前庫存 |
| (3) | **Controller** | 問題 2：`ETag` 是 HTTP 詞彙。（實務上用 `ResponseEntity.eTag()` 或 `ShallowEtagHeaderFilter`，06 章） |
| (4) | **Domain**（`Order` 或 `PricingPolicy`），由 Service 呼叫 | 問題 1：排程與批次都需要；問題 3：純計算不需要 I/O |
| (5) | **Repository** | 它在講 SQL |
| (6) | **基礎設施（Filter）** | 問題 1：換掉 HTTP 就沒有「請求」的概念了；而且要在所有請求上生效，包含 404 與被 Security 攔掉的 |
| (7) | **Service** | 問題 3：需要訂單當前狀態。⚠️ 注意規則本體在 `OrderStatus`（見 13），Service 只是使用它 |
| (8) | **Controller** | 問題 2：`201`、`Location` 是 HTTP 詞彙 |
| (9) | **Repository 的查詢條件**（由 Service 組出來） | 0.6.7：資料範圍必須在最靠近資料的地方，否則會漏一條路徑 = IDOR |
| (10) | **Service / Domain** | 問題 1：批次匯入也要編號 |
| (11) | **不用寫**！Spring 用 `consumes = APPLICATION_JSON_VALUE` 自動回 415（01 章） | 問題 2 判給 Controller，但框架已經做了 |
| (12) | **Service**，而且必須在交易裡發、在 commit 後執行 listener | 問題 4：它跟資料寫入的成敗綁在一起 |
| (13) | **Domain**（`OrderStatus` enum 的方法） | 問題 3：不需要 I/O。放在 enum 裡讓狀態機成為單一真相來源 |
| (14) | **Controller**（宣告成 `@RequestHeader(required = true)`）或 **Interceptor**（若要套用到多條端點） | 問題 2：header 是 HTTP 詞彙 |
| (15) | **Service** | 0.6.10：應用快取是業務決策（HTTP 快取才是 Controller 的） |

**最容易答錯的三題：(7) vs (13)、(9)、(11)。**

- **(7) vs (13)**：規則的**定義**在 Domain，規則的**執行時機**在 Service。
  這個分工讓「可取消的狀態有哪些」只有一份定義，
  而 `GET /orders/{id}` 的 `allowedActions` 欄位也能重用它。
- **(9)**：很多人答 Service。放 Service 也比放 Controller 好，
  但最安全的是變成查詢條件 —— 因為「忘記加條件」和「忘記呼叫檢查方法」的失敗模式不同：
  前者頂多查不到資料，後者是資料外洩。
- **(11)**：這題的陷阱是「這個判斷正確但不該由你寫」。
  Web 層有很多事框架已經做了，自己寫一份等於多一個會不一致的地方。

</details>

### 練習 2：把這段 Controller 拆層

```java
@RestController
@RequestMapping("/api/coupon")
public class CouponController {

    @Autowired private CouponRepository couponRepo;
    @Autowired private CartRepository cartRepo;
    @Autowired private StringRedisTemplate redis;

    @PostMapping("/apply")
    @Transactional
    public Map<String, Object> apply(@RequestBody Map<String, String> body,
                                     HttpServletRequest req) {
        Map<String, Object> r = new HashMap<>();
        String code = body.get("code");
        if (code == null || code.length() < 4) {
            r.put("code", -1); r.put("msg", "折扣碼格式錯誤"); return r;
        }
        String customerId = (String) req.getSession().getAttribute("customerId");

        Coupon c = couponRepo.findByCode(code.toUpperCase());
        if (c == null) { r.put("code", -1); r.put("msg", "折扣碼不存在"); return r; }
        if (c.getExpireAt().isBefore(LocalDateTime.now())) {
            r.put("code", -1); r.put("msg", "折扣碼已過期"); return r;
        }
        if (redis.opsForSet().isMember("coupon:used:" + code, customerId)) {
            r.put("code", -1); r.put("msg", "已使用過"); return r;
        }
        Cart cart = cartRepo.findByCustomerId(customerId);
        BigDecimal subtotal = cart.getItems().stream()
                .map(i -> i.getPrice().multiply(BigDecimal.valueOf(i.getQty())))
                .reduce(BigDecimal.ZERO, BigDecimal::add);
        if (subtotal.compareTo(c.getMinAmount()) < 0) {
            r.put("code", -1);
            r.put("msg", "未達最低消費 " + c.getMinAmount());
            return r;
        }
        BigDecimal discount = c.getType().equals("PERCENT")
                ? subtotal.multiply(c.getValue()).divide(new BigDecimal(100))
                : c.getValue();
        cart.setCouponCode(code);
        cart.setDiscount(discount);
        cartRepo.save(cart);
        redis.opsForSet().add("coupon:used:" + code, customerId);

        r.put("code", 0);
        r.put("data", Map.of("discount", discount, "total", subtotal.subtract(discount)));
        return r;
    }
}
```

要求：
1. 列出這個方法違反了 0.6 的哪幾條。
2. 找出**兩個功能性 bug**（不是架構問題，是會算錯或會出錯的 bug）。
3. 寫出重構後的 Controller、Service 介面、DTO。
4. 這條端點的 URL 也是錯的 —— 按 03-rest-api 第 01 章應該是什麼？

<details>
<summary>解答</summary>

**1. 違反的規則**

| 條 | 違反內容 |
|---|---|
| 0.6.1 | 業務規則（過期、已使用、最低消費）全在 Controller |
| 0.6.2 | 小計與折扣計算在 Controller |
| 0.6.3 | 直接注入兩個 Repository |
| 0.6.4 | `@Transactional` 在 Controller 上 |
| 0.6.5 | 用 `Map` 回錯誤，格式與其他端點不一致 |
| 0.6.7 | 從 `HttpSession` 自己取登入者 |
| 0.6.8 | `@RequestBody Map<String,String>` — 沒有型別、沒有驗證 |
| 0.6.10 | Redis 的使用紀錄邏輯在 Controller |

**2. 兩個功能性 bug**

**Bug A：`divide` 沒有指定 scale 與 rounding → 可能拋 `ArithmeticException`。**

```java
subtotal.multiply(c.getValue()).divide(new BigDecimal(100))
```

`BigDecimal.divide(BigDecimal)` 在結果是**無限小數**時直接拋
`ArithmeticException: Non-terminating decimal expansion; no exact representable decimal result`。

`subtotal = 1000`、`value = 33`（33% off）→ `33000 / 100 = 330`，沒事。
但 `subtotal = 100.05`、`value = 3` → `300.15 / 100 = 3.0015`，也沒事。
真正會炸的是除數不是 10 的次方時，例如折扣規則改成「打 7 折」寫成 `divide(new BigDecimal(3))`。

即使不炸，**scale 也是錯的**：`3.0015` 元沒有意義，而且累加後會和帳務對不起來。

```java
// ✅ 金額計算一定要明確指定 scale 與 rounding
discount = subtotal.multiply(c.getValue())
                   .divide(new BigDecimal("100"), 2, RoundingMode.HALF_UP);
```

⚠️ 順便：`new BigDecimal(100)` 應寫成 `new BigDecimal("100")`。
用 `int` 的建構子這裡剛好沒事，但 `new BigDecimal(0.1)` 會得到
`0.1000000000000000055511151231257827021181583404541015625`。
**規則：`BigDecimal` 一律用字串建構子。**

**Bug B：折扣碼的「已使用」被記錄在 Redis，但套用購物車是資料庫交易 —— 兩者不一致。**

```java
cartRepo.save(cart);                                    // 資料庫（在交易裡）
redis.opsForSet().add("coupon:used:" + code, customerId);  // Redis（不在交易裡）
```

如果 `cartRepo.save` 之後、方法回傳前發生任何例外（或交易在提交時失敗），
**資料庫回滾了，但 Redis 的「已使用」記錄留著。**
使用者的折扣碼永久失效，而且他從來沒真的用到。

而反過來也會出事：Redis 寫入失敗（連線斷）→ 例外 → 交易回滾 →
但如果有人把這個 Redis 呼叫包在 try-catch 裡忽略，就變成折扣碼可以無限重用。

（正確做法：用資料庫的 UNIQUE 約束當真相，Redis 只當快取；
或用 `@TransactionalEventListener(AFTER_COMMIT)`。05-service 第 02、04 章。）

**額外 bug（送你第三個）**：`redis.opsForSet().add(...)` 在**訂單還沒成立**時就標記「已使用」。
使用者只是套用折扣碼到購物車，還沒結帳。他把折扣碼移除再套用一次 → 
`isMember` 為 true → 「已使用過」。**折扣碼一碰就消失。**

**3. 重構後**

URL 先定案（見第 4 題）：`PUT /carts/current/coupon`。

```java
// ── DTO ──────────────────────────────────────────
package example.shop.cart.web.dto;

public record ApplyCouponRequest(
    @NotBlank(message = "請輸入折扣碼")
    @Size(min = 4, max = 32)
    @Pattern(regexp = "^[A-Za-z0-9]+$", message = "折扣碼只能包含英數字")
    String code
) {}

public record CartResponse(
    String cartId,
    List<CartItemResponse> items,
    Amounts amounts,
    String currency,
    AppliedCoupon appliedCoupon,       // 沒套用時為 null
    int itemCount,
    Instant updatedAt
) {
    public record Amounts(String subtotal, String discount,
                          String shippingFee, String total) {}
    public record AppliedCoupon(String code, String discountAmount, String description) {}
}
```

```java
// ── Service 介面（實作在 05-service）────────────
package example.shop.cart.service;

public interface CartService {
    /**
     * 套用折扣碼到目前購物車。冪等：同一個碼重複套用結果相同。
     *
     * @throws CouponNotFoundException          折扣碼不存在
     * @throws CouponExpiredException           已過期／尚未生效
     * @throws CouponAlreadyUsedException       此客戶已在「已完成的訂單」中用過
     * @throws CouponMinAmountNotMetException   未達最低消費
     * @throws CouponNotApplicableException     不適用於購物車內商品
     */
    Cart applyCoupon(ApplyCouponCommand command);
}

public record ApplyCouponCommand(Actor actor, String couponCode) {}
```

```java
// ── Controller ──────────────────────────────────
package example.shop.cart.web;

@RestController
@RequestMapping(path = "/carts/current/coupon", produces = APPLICATION_JSON_VALUE)
public class CartCouponController {

    private final CartService cartService;
    private final CartWebMapper mapper;

    public CartCouponController(CartService cartService, CartWebMapper mapper) {
        this.cartService = cartService;
        this.mapper = mapper;
    }

    /** PUT 而不是 POST：套用折扣碼是冪等的（03-rest-api 第 02 章）。 */
    @PutMapping(consumes = APPLICATION_JSON_VALUE)
    public CartResponse apply(@Valid @RequestBody ApplyCouponRequest request,
                              @AuthenticationPrincipal CurrentUser user) {
        var cart = cartService.applyCoupon(
                new ApplyCouponCommand(user.actor(), request.code()));
        return mapper.toResponse(cart);
    }

    @DeleteMapping
    public CartResponse remove(@AuthenticationPrincipal CurrentUser user) {
        return mapper.toResponse(cartService.removeCoupon(user.actor()));
    }
}
```

**Controller 從 45 行變成 8 行，而且沒有一個 `if`。**

錯誤處理去哪了？→ advice（03 章）。對照 03-rest-api 第 04 章 4.13.5 的錯誤碼：

| 例外 | `code` | 狀態碼 |
|---|---|---|
| `CouponNotFoundException` | `COUPON_NOT_FOUND` | 404 |
| `CouponExpiredException` | `COUPON_EXPIRED` | 422 |
| `CouponAlreadyUsedException` | `COUPON_ALREADY_USED` | 409 |
| `CouponMinAmountNotMetException` | `COUPON_MIN_AMOUNT_NOT_MET` | 422 |
| `CouponNotApplicableException` | `COUPON_NOT_APPLICABLE` | 422 |

**4. URL 應該是什麼**

原本：`POST /api/coupon/apply` — 動詞在 URL、`/api` 前綴無意義、看不出對誰套用。

正確：`PUT /carts/current/coupon`

理由（03-rest-api 第 01 章 1.14.2）：
- 「購物車的折扣碼」是購物車的**單例子資源**（一個購物車最多一個折扣碼）。
- 套用是**冪等**的 → `PUT`。重複送兩次結果一樣，可以安全重試。
- 移除折扣碼自然就是 `DELETE /carts/current/coupon`（原本的設計裡沒有這個功能，得再開一支 `/coupon/remove`）。
- 「驗證折扣碼是否有效」（不套用）是另一個資源：`GET /coupons/{code}`。

</details>

### 練習 3：讀懂請求旅程

一位同事說：「我在 Filter 裡拋 `BusinessException`，但 `@RestControllerAdvice` 沒接到，
前端拿到一坨 HTML。這是 Spring 的 bug 嗎？」

請回答：
1. 為什麼沒接到？（用 0.8.1 的圖說明）
2. 給兩種解法，並說明各自的取捨。
3. 如果改成在 `HandlerInterceptor.preHandle` 裡拋，會被接到嗎？為什麼？

<details>
<summary>解答</summary>

**1. 為什麼沒接到**

`@RestControllerAdvice` 是由 `ExceptionHandlerExceptionResolver` 驅動的，
而它是 `DispatcherServlet.processDispatchResult()` 內部的機制（0.8.1 的 ⑩）。

Filter 在 0.8.1 的 **③**，**在 `DispatcherServlet` 外面**。
Filter 拋出的例外根本沒進到 `DispatcherServlet`，
它會沿著 Filter chain 往外傳到 Servlet 容器（Tomcat），
由容器的錯誤頁機制處理 → Spring Boot 的 `BasicErrorController`（`/error`）→
`Accept` header 不是 JSON 或協商失敗時，回 HTML 的 Whitelabel Error Page。

不是 bug，是**規格層級的邊界**：Servlet 規格的 Filter 不知道 Spring MVC 的存在。

**2. 兩種解法**

**解法 A：Filter 自己寫 JSON（推薦）**

```java
public class TraceIdFilter extends OncePerRequestFilter {

    private final ObjectMapper objectMapper;
    private final ProblemFactory problems;

    @Override
    protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res,
                                    FilterChain chain) throws IOException, ServletException {
        try {
            // ... 正常邏輯
            chain.doFilter(req, res);
        } catch (BusinessException e) {
            writeProblem(res, e);
        }
    }

    private void writeProblem(HttpServletResponse res, BusinessException e) throws IOException {
        if (res.isCommitted()) return;              // ★ 已經開始寫回應就來不及了
        res.reset();
        res.setStatus(e.errorCode().status().value());
        res.setContentType("application/problem+json");
        res.setCharacterEncoding("UTF-8");
        objectMapper.writeValue(res.getOutputStream(), problems.from(e));
    }
}
```

取捨：
- ✅ 完全掌控，一定是 JSON。
- ❌ 錯誤格式的組裝邏輯有兩份（Filter 一份、advice 一份）。
  👉 解法：把組裝抽成 `ProblemFactory`，兩邊共用（03 章 3.4 就是這樣設計的）。

**解法 B：把邏輯從 Filter 搬到 Interceptor 或 ArgumentResolver**

如果那個檢查**不需要**「包裝 request」或「對所有請求生效」這兩個 Filter 專屬能力，
就搬到 Interceptor（0.8.2 的表）。

取捨：
- ✅ 例外會進 advice，只有一份錯誤格式。
- ❌ 對非 Controller 請求（靜態資源、`/actuator`）不生效。
- ❌ 拿不到「包裝 request」的能力，所以「讀 body 並讓後面還能讀」做不到。

**判斷方式**：問「這件事需要在 Spring MVC 之外也成立嗎？」
- traceId → 需要（連 404、被 Security 擋掉的請求都要有）→ **Filter**
- 冪等鍵檢查 → 不需要（只對特定端點）→ **Interceptor**

**3. 在 `preHandle` 裡拋會被接到嗎？**

**會。** 因為 `applyPreHandle()` 在 `doDispatch()` 內部（0.8.1 的 ⑤），
它拋出的例外會被 `doDispatch` 的 `catch` 抓到，
存進 `dispatchException`，最後交給 `processDispatchResult()` → `HandlerExceptionResolver` → advice。

⚠️ 但有兩個細節：

1. **`preHandle` 回 `false` 和拋例外不一樣。**
   回 `false` 表示「我已經自己處理完回應了」，`DispatcherServlet` 直接結束，
   **不會**走 advice。所以你要自己寫完整回應（包含狀態碼與 body）。
2. **`preHandle` 拋例外時，`postHandle` 不會執行，但已經成功 `preHandle` 的
   interceptor 的 `afterCompletion` 會執行。**
   `DispatcherServlet` 用一個 `interceptorIndex` 記錄走到哪，回頭只清理已經成功的那些。
   這就是為什麼清理要寫在 `afterCompletion`（0.8.2 第 3 個坑）。

</details>

### 練習 4：設計一條端點的分層

需求（來自客服團隊）：

> 「客服要能幫客戶『改收件地址』。規則是：
> 訂單在 `PENDING_PAYMENT` 或 `PAID` 狀態才能改；
> 改了要留紀錄（誰改的、什麼時候、改成什麼）；
> 如果新地址跨縣市，運費要重算，差額由公司吸收（不向客戶收）；
> 改完要寄一封通知信給客戶；
> 同一張訂單一天最多改 3 次。」

請寫出：
1. URL 與方法（依 03-rest-api 第 01 章的規則）。
2. Request / Response DTO。
3. Controller 方法（完整程式碼）。
4. Service 介面（含 javadoc 標明會拋的例外）。
5. 這五條規則各屬於哪一層。
6. 需要新增哪些錯誤碼（`code` + 狀態碼）。

<details>
<summary>解答</summary>

**1. URL 與方法**

```
PATCH /orders/{orderId}/shipping-address
```

思考過程：
- 「改收件地址」是修改訂單的**一部分**，不是新建資源 → `PATCH`（不是 `POST`）。
- 為什麼不是 `PATCH /orders/{orderId}` 帶 `shippingAddress` 欄位？
  因為（a）權限不同（只有客服能改地址，客戶能改備註）；
  （b）副作用不同（會重算運費、會寄信、有次數限制）。
  **當一個欄位的修改有獨立的權限與副作用時，把它變成獨立的子資源端點**（1.7 手法 4）。
- 為什麼不是 `PUT`？地址是完整替換沒錯，`PUT /orders/{orderId}/shipping-address` 也合理。
  ⚠️ 但 `PUT` 語意上要求「送完整表述」，而我們希望允許只改 `line2`（樓層）。
  這裡選 `PATCH` 並在文件標明「未送的欄位保持不變」。
  （若團隊決定一律送完整地址，`PUT` 更好，因為它是冪等的 —— 這是可辯論的設計選擇。）
- 「改地址的紀錄」是另一個資源：`GET /orders/{orderId}/address-changes`。

**2. DTO**

```java
public record UpdateShippingAddressRequest(
    @Size(max = 30) String recipient,
    @Pattern(regexp = "^09\\d{8}$", message = "手機號碼格式錯誤") String phone,
    @Pattern(regexp = "^\\d{3,6}$", message = "郵遞區號格式錯誤") String postalCode,
    @Size(max = 20) String city,
    @Size(max = 20) String district,
    @Size(max = 100) String line1,
    @Size(max = 100) String line2,

    @NotBlank(message = "請填寫修改原因")
    @Size(max = 200) String reason              // ★ 客服操作一律要求原因（稽核）
) {}
```

⚠️ **注意所有地址欄位都不是 `@NotBlank`** —— 因為 `PATCH` 允許只送部分欄位。
但這帶來 03-rest-api 第 03 章 3.7 的三態問題：`null` 是「不改」還是「清空」？

`line2`（樓層／備註）是唯一真的需要「清空」語意的欄位，所以：

```java
    @Size(max = 100) JsonNullable<String> line2,     // 缺欄位=不改；null=清空；有值=設定
```

（`JsonNullable` 的完整用法在 01 章 1.6.4。）

```java
public record ShippingAddressChangeResponse(
    String orderId,
    String orderNumber,
    AddressResponse shippingAddress,          // 改完的地址
    ShippingFeeAdjustment feeAdjustment,      // 運費變動（可能為 null）
    int changesRemainingToday,                // ★ 讓客服知道還能改幾次
    ChangeRecord change,
    Instant updatedAt
) {
    public record ShippingFeeAdjustment(
        String previousFee, String newFee, String difference,
        String absorbedBy,                    // "COMPANY"
        String note                           // "跨縣市運費差額由公司吸收"
    ) {}
    public record ChangeRecord(
        String changeId, String changedBy, String changedByName,
        String reason, Instant changedAt) {}
}
```

**`changesRemainingToday` 是高價值欄位**：客服不用試到第 4 次才被拒絕。
（同 03-rest-api 第 04 章對 `alternativeAction` 的評論：把限制變成可見的資訊。）

**3. Controller**

```java
@RestController
@RequestMapping(path = "/orders/{orderId}/shipping-address",
                produces = APPLICATION_JSON_VALUE)
public class OrderShippingAddressController {

    private final OrderService orderService;
    private final OrderWebMapper mapper;

    public OrderShippingAddressController(OrderService orderService, OrderWebMapper mapper) {
        this.orderService = orderService;
        this.mapper = mapper;
    }

    @PatchMapping(consumes = APPLICATION_JSON_VALUE)
    @PreAuthorize("hasRole('SUPPORT')")                  // ★ 粗粒度授權：宣告在這裡合理
    public ShippingAddressChangeResponse update(
            @PathVariable String orderId,
            @Valid @RequestBody UpdateShippingAddressRequest request,
            @AuthenticationPrincipal CurrentUser user) {

        var result = orderService.changeShippingAddress(
                mapper.toChangeAddressCommand(orderId, request, user.actor()));
        return mapper.toAddressChangeResponse(result);
    }
}
```

**又是 5 行，又是零個 `if`。** 五條業務規則一條都不在這裡。

**4. Service 介面**

```java
public interface OrderService {

    /**
     * 客服代客戶修改收件地址。
     *
     * <p>行為：
     * <ul>
     *   <li>僅 {@code PENDING_PAYMENT} 與 {@code PAID} 狀態可修改。</li>
     *   <li>寫入一筆 address-change 稽核紀錄（誰、何時、改前改後、原因）。</li>
     *   <li>若運送區域改變，重算運費；差額記為公司補貼，不向客戶收取。</li>
     *   <li>提交後（AFTER_COMMIT）非同步寄出地址變更通知信。</li>
     *   <li>同一訂單同一營業日最多修改 3 次。</li>
     * </ul>
     *
     * @throws ResourceNotFoundException            訂單不存在
     * @throws OrderAddressNotEditableException     狀態不允許修改
     * @throws AddressChangeLimitExceededException  今日修改次數已達上限
     * @throws UndeliverableAddressException        新地址不在配送範圍
     */
    ShippingAddressChangeResult changeShippingAddress(ChangeShippingAddressCommand command);
}

public record ChangeShippingAddressCommand(
    String orderId,
    Actor actor,
    String reason,
    AddressPatch patch                    // 只含「有送」的欄位
) {}
```

**javadoc 標明會拋什麼例外，是 Controller 與 Service 之間的實質契約。**
03 章要為每個例外配一個狀態碼，靠的就是這份清單。

**5. 五條規則的歸屬**

| 規則 | 層 | 理由 |
|---|---|---|
| 只有 `PENDING_PAYMENT` / `PAID` 能改 | **Domain**（`OrderStatus.isAddressEditable()`）+ Service 執行 | 問題 3：需要當前狀態；規則定義放 enum 才有單一真相 |
| 留修改紀錄 | **Service**（同一交易內寫入） | 問題 4：要跟地址變更一起回滾 |
| 跨縣市重算運費、公司吸收 | **Domain**（`ShippingFeePolicy`）計算，**Service** 決定入帳 | 問題 3：純計算 → Domain；「記為補貼」涉及寫入 → Service |
| 寄通知信 | **Service** 發事件，`AFTER_COMMIT` 的 listener 非同步執行 | 0.6.6：副作用不能在交易裡、不能佔 Tomcat 執行緒 |
| 一天最多 3 次 | **Service**（查當日紀錄數）⚠️ 並發下需要鎖或 UNIQUE 約束 | 問題 3：需要查歷史紀錄 |

⚠️ 最後一條有個併發陷阱：兩個客服同時送第 3 次修改，
兩邊都查到「已改 2 次」→ 都通過 → 變成 4 次。
正確做法是把計數放進同一個交易並用悲觀鎖 `SELECT ... FOR UPDATE`，
或建一個 `(order_id, business_date, seq)` 的 UNIQUE 約束當最後防線。
（05-service 第 02 章、07-mysql 第 04 章。）

**「Controller 完全看不到這個問題」正是分層的價值** —— 
併發控制需要交易，而交易在 Service。如果這段程式碼在 Controller，
你會很自然地寫出上面那個有 race condition 的版本，而且沒有地方可以修。

**6. 新增的錯誤碼**

| `code` | 狀態碼 | `title` | `userMessage` | 擴充欄位 |
|---|---|---|---|---|
| `ORDER_ADDRESS_NOT_EDITABLE` | 409 | 訂單地址無法修改 | 此訂單已{statusLabel}，無法修改收件地址。 | `orderNumber`, `currentStatus`, `editableStatuses[]` |
| `ADDRESS_CHANGE_LIMIT_EXCEEDED` | 429 | 修改次數已達上限 | 此訂單今日已修改 3 次，請明天再試或聯絡主管。 | `limit`, `used`, `resetAt` |
| `UNDELIVERABLE_ADDRESS` | 422 | 地址不在配送範圍 | 此地址目前無法配送（{reason}）。 | `postalCode`, `reason` |

**為什麼 `ADDRESS_CHANGE_LIMIT_EXCEEDED` 是 429 而不是 409？**
可辯論。429 的語意是「請求過於頻繁」，帶 `Retry-After` 能表達「明天可以」。
若團隊認為 429 專屬於技術限流（避免和限流的監控混在一起），
用 `409` + `resetAt` 也合理 —— **但要在錯誤目錄裡寫下決定，不要兩種混用**。

</details>

---

## 0.15 驗收清單

- [ ] 我能說出 0.3 那個 Controller 做了 11 件事，並指出只有 1 件屬於它。
- [ ] 我能說出「邏輯寫在 Controller」的六個具體後果，而且每個都能舉出可量化的代價。
- [ ] 我知道為什麼「同一段邏輯被複製 4 份、改漏 1 份」是最貴的後果（它是靜默的）。
- [ ] 我能解釋為什麼 `@Transactional` 不該放在 Controller（連線佔用 + 交易邊界是業務語意）。
- [ ] 我知道 `spring.jpa.open-in-view` 預設是 `true`，也知道為什麼要改成 `false`。
- [ ] 我能說出分層的目的是「隔離三種變更方向」，不是「乾淨」。
- [ ] 我知道依賴方向必須單向，也知道 `HttpServletRequest` / `MultipartFile` 出現在 Service 就是破層。
- [ ] 我能說出 Controller 依賴介面的三個理由，第一個是「測試可以切片」。
- [ ] 我對「Controller 可不可以直接呼叫 Repository」有立場，也知道反方論點。
- [ ] 我能背出 Controller 該做的七件事，並注意到它們全部是「翻譯」。
- [ ] 我能對 0.6 的十件事各舉一個 Before / After。
- [ ] 我知道「Request DTO 少一個欄位 = 攻擊面少一塊」，也知道改價漏洞怎麼發生。
- [ ] 我知道細粒度授權（「這是我的訂單嗎」）不能寫在 Controller，否則會漏路徑造成 IDOR。
- [ ] 我能用五個問題判斷任何一段程式碼的歸屬，並知道問題 1 最有效。
- [ ] 我知道「不查資料就能判斷 → Controller，要查 → Service」，也知道兩層都要驗。
- [ ] 我能畫出請求從 socket 到回應的完整旅程，並標出 Filter / Interceptor / ArgumentResolver / advice 的位置。
- [ ] 我知道 Filter 拋的例外**不會**進 `@RestControllerAdvice`，也知道兩種解法。
- [ ] 我知道 Security 的 401 / 403 也不會進 advice。
- [ ] 我知道 `postHandle` 在例外時不執行，清理要寫在 `afterCompletion`。
- [ ] 我知道框架開銷約 1 ms，效能問題幾乎都在資料查詢。
- [ ] 我能說明 MVC 與 WebFlux 的取捨，並知道虛擬執行緒改變了什麼。
- [ ] 我知道虛擬執行緒的三個注意事項（`synchronized` pinning、`ThreadLocal` 語意、連線池仍是瓶頸）。
- [ ] 我能把 0.3 的 Controller 拆成 40 行，並說出每一段搬去哪裡。
- [ ] 我知道為什麼用建構子注入，尤其是「建構子是天然的複雜度警報器」這個理由。
- [ ] 我能說出 package-by-feature 的四個理由。
- [ ] 我建好了 shop-service 骨架，`GET /orders/{id}` 能回 JSON。
- [ ] 我知道 `spring-boot-starter-validation` 必須自己加，否則驗證**靜默失效**。
- [ ] 我知道 `spring.web.resources.add-mappings: false` + `throw-exception-if-no-handler-found: true` 才能讓 404 走 advice。
- [ ] 我會用 `/actuator/mappings` 查路由、用 `org.springframework.web=TRACE` 追旅程。
- [ ] 我知道 ArchUnit 可以把架構規則變成會失敗的測試。

---

## 0.16 下一章預告

01 章要把 03-rest-api 的 **70 條 URL** 變成方法簽章。內容包括：

- `@RequestMapping` 家族的完整語意，以及**路由衝突時 Spring 怎麼選**（優先順序規則）。
- `@PathVariable` / `@RequestParam` / `@RequestBody` / `@RequestHeader` / `@CookieValue` / `@ModelAttribute` 的完整行為與陷阱。
- **`required` 與 `Optional` 與 `defaultValue` 的三角關係**（以及為什麼 `@RequestParam(required=false) int` 會 500）。
- 把 12 個查詢參數綁成**一個物件**（`OrderFilter`），而不是 12 個方法參數。
- `Pageable` 的自動綁定與它的三個坑。
- 列舉綁定：`?status=paid` 要不要接受小寫？找不到值時怎麼回 422 而不是 500。
- `JsonNullable` 與 `PATCH` 的三態語意。
- `ResponseEntity` vs 直接回 DTO vs `@ResponseStatus` 的取捨。
- Spring Boot 3.x 的兩個 breaking change：**尾斜線比對**與**路徑變數的正規表示式**。

---

完成後請前往 [01-request-mapping-and-binding.md](./01-request-mapping-and-binding.md)。
