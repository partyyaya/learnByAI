# 第 11 章：Session 與 token 撤銷

> 09 章的鎖、10 章的限流與冪等，都在 Redis 上存了一份「**只有一份、而且必須是對的**」狀態。
> 這一章存的是另一種：**使用者的登入狀態**。
>
> 開場先看一個症狀。同一個瀏覽器、同一個 cookie，連續八個請求：
>
> ```
>   第 1 個請求 → 打到 18081 ： ✅ alice       sessionId=71BDF7B3C1F7
>   第 2 個請求 → 打到 18082 ： ⚠️ (未登入)   sessionId=—
>   第 3 個請求 → 打到 18081 ： ✅ alice       sessionId=71BDF7B3C1F7
>   第 4 個請求 → 打到 18082 ： ⚠️ (未登入)   sessionId=—
>   ...
> ```
>
> 📌 **「登入了又沒登入」不是一個玄學問題，它是一個很精確的現象**：
> **偶數次請求登出，奇數次請求正常。** 因為你有兩台機器。
>
> 而這一章真正難的不是把它接到 Redis（那只要一個依賴、零行程式碼），是後面這四件事：
>
> | 問題 | 節 | 這一章量到的數字 |
> |---|---|---|
> | Session 存進 Redis 之後佔多少記憶體 | 11.6.3 | 空 Session **2,592 bytes** → 100 萬使用者 **2.4 GB**；購物車 200 件 → **14 GB** |
> | 預設序列化器有多浪費 | 11.5.1 | 存一個 `Long` 的 `creationTime` 要 **82 bytes**（JSON 版 13 bytes） |
> | 記憶體滿了會怎樣 | 11.6.4 | `allkeys-lru`：**驅逐 108 個 key，alice 被登出、購物車消失**；`noeviction`：**335 次寫入失敗** |
> | Redis 掛掉會怎樣 | 11.11.1 | `pause` → **每個請求 500、等 1.5 秒**；`stop` → 500、13 毫秒；**重開之後所有人一起登出** |
>
> ⚠️ 而 08 章 8.8 的決策表在 Session 這一行寫的是 **「直接失敗（401/503）」**——
> 理由跟 09、10 章一樣：**「Redis 查不到，就當作已登入」是一個安全漏洞，不是降級策略。**

---

## 11.1 學習目標

完成本章後，你應該可以：

- 重現「多實例之後 Session 不見了」，並說出它為什麼在單機測試環境**永遠不會出現**（11.2）。
- 用 Spring Session Redis 解決它，並說出 cookie 為什麼從 `JSESSIONID` 變成 `SESSION`（11.3）。
- 分辨 `default` 與 `indexed` 兩種 repository，說出它們在 Redis 裡的 key 結構與**每個請求的命令數**差別（11.4）。
- ⚠️ 指出 Session 預設序列化器的三個問題，並正確地換成 JSON（11.5）。
- 算出你的使用者規模下 Session 要吃多少記憶體，並說出 `maxmemory` 滿了之後**誰會被登出**（11.6）。
- 實作「查詢某個使用者的所有 Session」與「強制所有裝置下線」（11.8）。
- 說明 JWT 為什麼**撤銷不掉**，以及兩種把它撤掉的做法各自的代價（11.9、11.10）。
- ⚠️ 決定 Redis 不可用時登入狀態該怎麼處理，並說出為什麼這裡**沒有 fail-open 的選項**（11.11）。

---

## 11.2 先重現：「登入了又沒登入」

### 11.2.1 兩台機器，一個瀏覽器

`HttpSession` 預設存在**那一台機器的記憶體裡**。所以：

```
                    ┌──────────────┐
    瀏覽器 ──────▶  │ 負載平衡器    │
    cookie:         └───┬──────┬───┘
    JSESSIONID=71BD...  │      │
                        ▼      ▼
                   ┌────────┐ ┌────────┐
                   │ 機器 A │ │ 機器 B │
                   │        │ │        │
                   │ 71BD.. │ │  (空)  │   ← ⚠️ 同一個 sessionId，B 完全不認識
                   │ →alice │ │        │
                   └────────┘ └────────┘
```

> 📌 **這就是為什麼它在測試環境永遠不會出現**：
> 開發機上只有一台，`docker compose` 裡通常也只有一台。
> **它在「上線那天把副本數從 1 改成 2」的那一刻出現。**

### 11.2.2 實測

把同一個 jar 起兩份（18081、18082），用 `--spring.autoconfigure.exclude` 把 Spring Session 關掉，
退回 Tomcat 自己的記憶體 Session：

```bash
java -jar lab10.jar --server.port=18081 \
     --spring.autoconfigure.exclude=org.springframework.boot.autoconfigure.session.SessionAutoConfiguration
java -jar lab10.jar --server.port=18082 \
     --spring.autoconfigure.exclude=...（同上）
```

用一個 cookie jar 模擬同一個瀏覽器，請求輪流打到兩台：

```bash
curl -c cookies.txt -X POST "http://localhost:18081/session/login?user=alice"
for i in 1..8; do
  PORT=（奇數打 18081，偶數打 18082）
  curl -b cookies.txt "http://localhost:$PORT/session/whoami"
done
```

```
  ① 在 18081 登入
     {"new":true,"sessionId":"71BDF7B3C1F7699B21CBD7F1FFFFE789","user":"alice","instance":18081}
     瀏覽器拿到的 cookie：
     JSESSIONID = 71BDF7B3C1F7699B21CBD7F1FFFF...

  ② 接下來 8 個請求，輪流打到兩台
     第 1 個請求 → 打到 18081 ： ✅ alice       sessionId=71BDF7B3C1F7
     第 2 個請求 → 打到 18082 ： ⚠️ (未登入)   sessionId=—
     第 3 個請求 → 打到 18081 ： ✅ alice       sessionId=71BDF7B3C1F7
     第 4 個請求 → 打到 18082 ： ⚠️ (未登入)   sessionId=—
     第 5 個請求 → 打到 18081 ： ✅ alice       sessionId=71BDF7B3C1F7
     第 6 個請求 → 打到 18082 ： ⚠️ (未登入)   sessionId=—
     第 7 個請求 → 打到 18081 ： ✅ alice       sessionId=71BDF7B3C1F7
     第 8 個請求 → 打到 18082 ： ⚠️ (未登入)   sessionId=—
```

> ⚠️ **注意 18082 回的是 `sessionId=—`，不是「錯的 session」。**
> 它根本沒有建立 Session——`request.getSession(false)` 回 `null`。
>
> 📌 **使用者看到的是什麼**：購物車一下有東西一下空的、
> 明明剛登入卻被導回登入頁、填到一半的表單送出後說「請先登入」。
> **而且重整一次就好了**（因為輪詢到了另一台）——所以回報上來的敘述會是「有時候會這樣」。

### 11.2.3 三個「看起來可以」的解法

在接 Redis 之前，先把另外三條路走完，因為你一定會在某個會議上聽到它們：

| 做法 | 怎麼運作 | ⚠️ 代價 |
|---|---|---|
| **Sticky session**（IP hash / cookie 綁定） | 負載平衡器讓同一個使用者永遠打到同一台 | ⚠️ **那台重開，那批使用者全部登出**；擴容時流量不會重新分配；灰度發布很痛苦 |
| **Session 複製**（Tomcat cluster / Hazelcast） | 每台機器都存一份全部的 Session | ⚠️ **N 台機器 = N 份記憶體**；每次寫入要廣播到所有機器，機器越多越慢 |
| **完全不用 Session**（JWT） | 狀態放在 token 裡，伺服器不存 | ⚠️ **撤銷不掉**（11.9），而且每個請求都在傳 207 bytes 而不是 36 bytes |
| ✅ **集中存放**（Redis） | 所有機器讀同一份 | Redis 掛掉大家一起登出（11.11） |

> 📌 **Sticky session 不是錯的，它只是把問題換成另一個問題。**
> 真正的判斷點是：**你能接受「一台機器重開 = 那批使用者登出」嗎？**
> 對後台管理系統來說通常可以；對電商來說不行（那是購物車）。

---

## 11.3 Spring Session Redis

### 11.3.1 一個依賴，零行程式

```xml
<dependency>
  <groupId>org.springframework.session</groupId>
  <artifactId>spring-session-data-redis</artifactId>
</dependency>
```

**就這樣。** 依賴一加上去，`SessionAutoConfiguration` 就會用一個
`SessionRepositoryFilter` 把 `HttpServletRequest` 包起來，
之後所有 `request.getSession()` 拿到的都是 Redis 版的 Session——
**你的 Controller 一行都不用改。**

```java
// 這段程式碼在接 Redis 前後完全一樣
@PostMapping("/login")
public Map<String, Object> login(@RequestParam String user, HttpSession session) {
    session.setAttribute("user", user);
    session.setAttribute("cart", new ArrayList<>(List.of("商品A", "商品B")));
    return Map.of("sessionId", session.getId(), "user", user);
}
```

> 📌 **`SessionRepositoryFilter` 的順序是 `Integer.MIN_VALUE + 50`**——
> 比 Spring Security 的過濾鏈更早，比 10 章那個 `@Order(1)` 的限流 Filter 更早。
> **所以限流 Filter 裡拿不拿得到 Session？拿得到。**
> ⚠️ 但**不要在限流 Filter 裡碰 Session**——那會讓每一個被限流的請求都去讀一次 Redis
> （10.7.4 說過：429 的路徑必須便宜）。

### 11.3.2 實測：同一個 Session 在兩台之間

```
  ① 在 18081 登入
     {"instance":18081,"user":"alice","sessionId":"a9a81ca5-1802-48f6-b4aa-c0f05afca13e","new":true}
     瀏覽器拿到的 cookie：
     SESSION = YTlhODFjYTUtMTgwMi00OGY2LWI0...

  ② 接下來 8 個請求，輪流打到兩台
     第 1 個請求 → 打到 18081 ： ✅ alice      sessionId=a9a81ca5-1802-
     第 2 個請求 → 打到 18082 ： ✅ alice      sessionId=a9a81ca5-1802-
     第 3 個請求 → 打到 18081 ： ✅ alice      sessionId=a9a81ca5-1802-
     第 4 個請求 → 打到 18082 ： ✅ alice      sessionId=a9a81ca5-1802-
     ...（八個全部 ✅）
```

### 11.3.3 三個看得見的變化

**① cookie 名字從 `JSESSIONID` 變成 `SESSION`**

⚠️ 這件事會打到：前端寫死 cookie 名稱的程式、`SameSite` 設定、
CDN／WAF 的 cookie 白名單、以及**部署當下所有已登入的使用者**（舊 cookie 不再被認得 → 全部登出）。

**想要沿用舊名字**：

```java
@Bean
public CookieSerializer cookieSerializer() {
    DefaultCookieSerializer s = new DefaultCookieSerializer();
    s.setCookieName("JSESSIONID");     // ⚠️ 但這樣也無法避免「上線那一刻全部登出」
    s.setSameSite("Lax");
    s.setUseHttpOnlyCookie(true);
    s.setUseSecureCookie(true);
    return s;
}
```

**② sessionId 從 32 個十六進位字元變成 UUID**

Tomcat 是 `71BDF7B3C1F7699B21CBD7F1FFFFE789`，Spring Session 是
`a9a81ca5-1802-48f6-b4aa-c0f05afca13e`，而且 **cookie 裡是它的 Base64**。

**③ Session 不再「跟著那台機器死掉」**

這是接 Redis 真正買到的東西：**滾動更新的時候，使用者不會被登出。**

---

## 11.4 它在 Redis 裡長什麼樣子

### 11.4.1 ⚠️ 先決定：`default` 還是 `indexed`

Spring Session 3.x（Boot 3.x）有**兩種** Redis repository，而**預設是功能比較少的那個**：

```yaml
spring:
  session:
    redis:
      repository-type: default    # ← 預設值
      # repository-type: indexed  # ← 要「強制下線」的話必須用這個
```

| | `default`（`RedisSessionRepository`） | `indexed`（`RedisIndexedSessionRepository`） |
|---|---|---|
| Redis 裡幾種 key | **1 種** | **4 種** |
| 過期靠什麼 | **Redis 原生 TTL** | 自己維護的 `expirations` 桶 + keyspace 事件 |
| 查「某使用者的所有 Session」 | ❌ | ✅ `findByPrincipalName` |
| `SessionDestroyedEvent` | ❌ | ✅ |
| 每個請求的 Redis 命令 | **6 個** | **8 個** |
| 需要 keyspace notification | ❌ | ✅（`notify-keyspace-events Egx`） |

> ⚠️ **很多人是在寫「強制下線」功能的時候，才發現自己一直用的是 `default`。**
> 那時候 `FindByIndexNameSessionRepository` 這個 bean 根本不存在：
>
> ```
> {"error":"找不到 FindByIndexNameSessionRepository —— repository-type 沒設成 indexed"}
> ```

### 11.4.2 `default`：一個 Hash

```
spring:session:sessions:35d74b44-02c5-4e90-aa41-6f251e3bc0ec    hash   TTL=1800
```

20 個請求的命令分布：

```
  cmdstat_hgetall:calls=40        ← 每個請求 2 次
  cmdstat_exists:calls=40         ← 每個請求 2 次
  cmdstat_hmset:calls=20          ← 每個請求 1 次（寫回 lastAccessedTime）
  cmdstat_pexpireat:calls=20      ← 每個請求 1 次（續期）
```

**每個請求 6 個命令。**

### 11.4.3 `indexed`：四種 key

```
spring:session:sessions:453ceec2-…                    hash   TTL=2100   ← 資料本體
spring:session:sessions:expires:453ceec2-…            string TTL=1800   ← 真正的到期時鐘
spring:session:expirations:1789707300000              set    TTL=2099   ← 「這一分鐘要過期的人」
spring:session:index:…PRINCIPAL_NAME_INDEX_NAME:alice set    TTL=-1     ← ⚠️ 沒有 TTL
```

**這四個 key 的分工是這一節最值得看懂的東西：**

```
  sessions:expires:<id>   TTL = 1800（＝ 你設的 session timeout）
        │
        └─ 它過期時，Redis 發出 keyspace 事件（__keyevent@0__:expired）
              │
              └─ Spring Session 收到 → 清掉 index、發 SessionDestroyedEvent

  sessions:<id>           TTL = 1800 + 300  ← ⚠️ 多五分鐘的「寬限期」
        │
        └─ 為什麼要多五分鐘：Redis 的過期事件**不保證準時**（01 章 1.5 的惰性刪除 +
           定期抽樣）。資料如果跟時鐘一起消失，事件送到時就沒有東西可以清了。

  expirations:<對齊到分鐘的時間戳>
        └─ 一個備援：Spring Session 每分鐘掃一次「這一分鐘該過期的人」，
           補上 keyspace 事件沒送到的那些。
```

> 📌 **`spring:session:expirations:1789707300000` 那個數字是對齊到整分鐘的毫秒時間戳**
> （`1789707300000` → `2026-09-18 12:55:00`）。
> 所有在這一分鐘到期的 Session 都被丟進同一個 Set。
>
> ⚠️ **這是一個潛在的熱點**（12 章的 hot key）：
> 如果你的流量有明顯的整點尖峰，**那一分鐘的桶會特別大**。

20 個請求的命令分布：

```
  cmdstat_hgetall:calls=40        ← 2 / 請求
  cmdstat_hmset:calls=20          ← 1 / 請求
  cmdstat_append:calls=20         ← 1 / 請求（碰一下 expires key）
  cmdstat_pexpire:calls=60        ← 3 / 請求（hash + expires + expirations 桶）
  cmdstat_sadd:calls=20           ← 1 / 請求（重新登記到新的桶）
  cmdstat_srem:calls=1            ← 從舊的桶移出來
```

**每個請求 8 個命令**，而且 TTL 確實被續期了（實測 `2082 → 2100`、`1782 → 1800`）。

### 11.4.4 ⚠️ 這個成本要乘上你的 QPS

```
  5,000 QPS × 8 個命令 = 40,000 Redis 命令/秒  ← 只是為了「維持登入狀態」
```

03 章說過 Redis 是單執行緒的。**這 4 萬個命令跟你的快取、鎖、限流搶同一顆 CPU。**

📌 **三個可以省的地方**：

1. **靜態資源不要進 Session 過濾鏈**（`/css/**`、`/js/**`、`/images/**`）。
2. **`default` 而不是 `indexed`**，除非你真的需要強制下線（省 25%）。
3. ⚠️ **不要在每個請求都寫 Session**。`flushMode` 預設是 `ON_SAVE`（請求結束時寫一次），
   改成 `IMMEDIATE` 的話**每一次 `setAttribute` 都是一次 Redis 往返**。

---

## 11.5 ⚠️ 序列化：06 章那個坑的 Session 版

### 11.5.1 預設是 JDK 序列化

把一個登入後的 Session 拆開看：

```
sessionAttr:user                      12 bytes
sessionAttr:cart                      78 bytes
sessionAttr:loginAt                   82 bytes
sessionAttr:SPRING_SECURITY_CONTEXT 1202 bytes
creationTime                          82 bytes
lastAccessedTime                      82 bytes
maxInactiveInterval                   81 bytes
                                    ─────────
MEMORY USAGE                        3040 bytes
```

```
creationTime 的原始內容：
  "\xac\xed\x00\x05sr\x00\x0ejava.lang.Long;\x8b\xe4\x90\xcc\x8f#\xdf\x02\x00\x01J\x00\x05valuexr\x00\x10java.lang.Number\x86\xac\x95\x1d\x0b\x94\xe0\x8b\x02\x00\x00xp\x00\x00\x01\xa0\xb2\xbf1\x19"

user 的原始內容：
  "\xac\xed\x00\x05t\x00\x05alice"
```

> ⚠️ **`\xac\xed\x00\x05` ——06 章 6.4 的老朋友。**
>
> 📌 **請看 `creationTime`：82 bytes 存一個 `long`。**
> 裡面有 `java.lang.Long`、`java.lang.Number` 兩個完整類名，
> 真正的資料只有最後 8 個 byte。`maxInactiveInterval`（一個 `int`）是 81 bytes。
>
> **光是三個「時間戳與設定值」就吃掉 245 bytes，而它們跟你的業務完全無關。**

### 11.5.2 換成 JSON

```java
@Configuration
public class SessionSerializerConfig {

    /** ⚠️ bean 名稱必須是 springSessionDefaultRedisSerializer，Spring Session 只認這個名字。 */
    @Bean("springSessionDefaultRedisSerializer")
    public RedisSerializer<Object> springSessionDefaultRedisSerializer() {
        ObjectMapper mapper = new ObjectMapper();
        // ⚠️ 少了這一行，SecurityContext 反序列化會直接失敗（11.5.4）
        mapper.registerModules(SecurityJackson2Modules.getModules(getClass().getClassLoader()));
        return new GenericJackson2JsonRedisSerializer(mapper);
    }
}
```

同一個 Session：

| 欄位 | JDK | JSON | |
|---|---|---|---|
| `creationTime` | **82 B** | **13 B** | `1789705279882` |
| `lastAccessedTime` | 82 B | 13 B | |
| `maxInactiveInterval` | 81 B | **4 B** | `1800` |
| `sessionAttr:user` | 12 B | 7 B | `"alice"` |
| `sessionAttr:cart` | 78 B | 45 B | |
| `sessionAttr:SPRING_SECURITY_CONTEXT` | 1202 B | **780 B** | |
| **`MEMORY USAGE`** | **3040 B** | **2220 B** | **省 27%** |

而且 `redis-cli` 裡**看得懂**：

```json
{
  "@class": "org.springframework.security.core.context.SecurityContextImpl",
  "authentication": {
    "@class": "org.springframework.security.authentication.UsernamePasswordAuthenticationToken",
    "authorities": ["java.util.Collections$UnmodifiableRandomAccessList", [...]],
    "principal": { "@class": "org.springframework.security.core.userdetails.User", ... }
  }
}
```

> 📌 **`@class` 是 06 章 6.5 那個型別資訊。**
> `SecurityJackson2Modules` 除了註冊一堆 mixin，**還會打開 default typing**——
> 這正是 06 章 6.5.5 警告過「自訂 `ObjectMapper` 會關掉型別資訊」的反例：
> 這裡 Spring Security 幫你打開了。

### 11.5.3 ⚠️ 少了 `SecurityJackson2Modules` 會怎樣

**不會在啟動時失敗，也不會在寫入時失敗。**

```
登入 → HTTP 200 ✅
Redis 裡存的是：
  {"authentication":{"authorities":[{"authority":"ROLE_USER"}],"details":null,
   "authenticated":true,"principal":{"password":"pw","username":"alice",...}}}
       ↑
   ⚠️ 沒有 @class
```

**下一個請求才爆**：

```
GET /session/secwhoami → HTTP 500

org.springframework.expression.spel.SpelEvaluationException: EL1008E:
  Property or field 'authentication' cannot be found on object of type 'java.util.LinkedHashMap'
```

> ⚠️ **「寫得進去，讀不回來」——06 章 6.5.3 那個 `List.of(...)` 的完整重演。**
>
> 沒有型別資訊，Jackson 把 `SecurityContextImpl` 讀回來變成 `LinkedHashMap`，
> 然後 Spring Security 拿它去取 `authentication` 欄位，炸在一個
> **跟序列化完全無關的 SpEL 錯誤訊息上**。
>
> 📌 **這種 bug 的形狀**：改設定的那次部署完全正常（新 Session 才有問題），
> 而錯誤訊息會把你導向 Spring Security 的表達式，**不是序列化器**。

### 11.5.4 ⚠️ 順帶一個安全問題：Session 裡有密碼

不論 JDK 還是 JSON，`UserDetails` 都被完整序列化了：

```json
"principal": {
  "@class": "org.springframework.security.core.userdetails.User",
  "password": "pw",              ← ⚠️
  "username": "alice",
  ...
}
```

JDK 版也一樣（`grep` 得到 `password` 欄位）。

> 📌 **這不是序列化器的問題，是 `eraseCredentials` 的問題。**
> Spring Security 的 `ProviderManager` 在認證成功後**預設會呼叫
> `Authentication.eraseCredentials()`**，把密碼清成 `null`。
> 上面這個實驗是手動組 `Authentication`（繞過 `ProviderManager`）才會留著。
>
> ⚠️ **但你自己寫的 `UserDetails` 實作要自己確認**：
> `User.eraseCredentials()` 只清 `password` 那一個欄位。
> 如果你的 `principal` 裡還放了身分證號、手機、API 金鑰，
> **它們全部都會被寫進 Redis，而且不會過期得比 Session 早。**
>
> **檢查方法**：`redis-cli` 裡把一個真實使用者的 Session `HGETALL` 出來看一眼。
> ⚠️ 這件事本身就要小心——**你正在把正式環境的個資印到終端機上。**

### 11.5.5 選哪一個

| | JDK（預設） | **JSON** |
|---|---|---|
| 記憶體 | 3040 B | **2220 B（省 27%）** |
| `redis-cli` 裡看得懂 | ❌ | ✅ |
| 改了類別之後舊 Session | ⚠️ **`InvalidClassException`，全部讀不回來** | 多／少欄位可以容忍 |
| 換語言／換服務讀得到 | ❌ | ✅ |
| 設定成本 | 0 | 要記得 `SecurityJackson2Modules` |
| ⚠️ 反序列化攻擊面 | **大**（JDK 序列化的老問題） | 小（有 default typing 仍要注意白名單） |

> 📌 **建議：用 JSON。** 但 ⚠️ **切換的那一刻，所有既有 Session 都會讀不回來**
> （舊的是 JDK bytes，新的解析器看不懂）——
> **等於全站登出一次。** 請排在維護窗口，或是接受它。

---

## 11.6 TTL 與記憶體

### 11.6.1 Session 該活多久

```yaml
server:
  servlet:
    session:
      timeout: 30m        # ⚠️ 這個在接了 Spring Session 之後仍然有效
spring:
  session:
    timeout: 30m          # 也可以用這個（優先）
```

**它是「閒置多久」，不是「總共活多久」**——每個請求都會重設（11.4.3 實測過續期）。

### 11.6.2 ⚠️ 索引那個 key 沒有 TTL

回頭看 11.4.3 那張表最後一列：

```
spring:session:index:…PRINCIPAL_NAME_INDEX_NAME:alice   set   TTL=-1
```

**`-1` ＝ 永不過期**（01 章 1.4）。

Spring Session 會在 Session 銷毀時把成員從這個 Set 移掉，
但**這件事依賴 keyspace 事件送達**。而 keyspace 事件：

- ⚠️ **是 fire-and-forget 的**（Redis 不保證送達，客戶端沒連上就沒了）；
- ⚠️ **不會跨 replica 送**（13 章）；
- ⚠️ **應用重啟的那幾秒收不到**。

```
  漏掉一次 ──▶ 這個 Set 裡多一個指向已經不存在的 Session 的 id
        │
        └─ 一年之後：一個有幾萬個死成員的 Set
              └─ 而 findByPrincipalName 每次都要把它們全部撈出來再一個個檢查
```

📌 **`expirations` 桶那個備援掃描會補掉大部分**，但要確認它有在跑：

```bash
docker exec redis-lab redis-cli CONFIG SET notify-keyspace-events Egx
```

⚠️ **沒設這一行的話，`indexed` 模式的清理完全靠那個每分鐘的掃描**，
而 `SessionDestroyedEvent` **一個都不會發出來**。

### 11.6.3 實測：一個 Session 佔多少

（四個 key 加總：hash + expires + expirations + index）

```
  購物車裡幾件商品   MEMORY USAGE    100 萬個使用者
  0 件              2,592 bytes     2,472 MB
  10 件             3,620 bytes     3,452 MB
  50 件             5,924 bytes     5,650 MB
  200 件           15,140 bytes    14,439 MB
```

> 📌 **一個「什麼都沒放」的 Session 就要 2.5 KB。**
> 100 萬個同時在線的使用者 = **2.4 GB**，而那還沒有算你放進去的東西。
>
> ⚠️ 購物車 200 件就是 **14 GB**——
> 而「購物車放在 Session 裡」是一個非常常見的設計。

### 11.6.4 ⚠️ 記憶體滿了：被驅逐的是別人的購物車

`maxmemory` 設成 3mb（空的 Redis 本身就佔 1.3 MB），
alice 登入並放了 100 件商品，然後 300 個新使用者進來：

```
  ── maxmemory 3mb，策略 allkeys-lru ──
     300 個新使用者（每人購物車 100 件）→ 失敗 0 次
     used_memory=2.93M  evicted_keys=108  dbsize=496
     ⚠️ alice 還登入著嗎 → (未登入)
        她的購物車 → 不見了

  ── maxmemory 3mb，策略 noeviction ──
     300 個新使用者（每人購物車 100 件）→ 失敗 335 次
     used_memory=3.04M  evicted_keys=0  dbsize=538
     ⚠️ alice 的請求 → HTTP 500
```

app log 裡：

```
212 次  RedisSystemException → RedisCommandExecutionException:
        OOM command not allowed when used memory > 'maxmemory'.
```

> ⚠️ **這是 04 章那一章的具體後果，而且兩種策略都很糟：**
>
> | 策略 | 發生什麼 | 使用者看到 |
> |---|---|---|
> | `allkeys-lru` | **驅逐 108 個 key** | **隨機有人被登出，購物車消失**，而且**沒有任何錯誤被記錄** |
> | `noeviction` | 寫入被拒絕 | **500**，新的人登不進來，舊的人也動不了 |
>
> 📌 **`allkeys-lru` 那一列才是真正危險的**：
> **它沒有錯誤率、沒有告警、沒有日誌。**
> 你只會收到客服轉來的「我的購物車不見了」，而且重現不了。
>
> ⚠️ **所以：Session 的 Redis 不要跟快取共用同一台。**
> 快取被驅逐是設計的一部分（07 章），Session 被驅逐是事故。
> 兩者混在一起時，**熱門商品的快取會把使用者的登入狀態擠掉。**

### 11.6.5 三條規則

1. **Session 用獨立的 Redis 實例**（或至少獨立的 `db`＋自己的記憶體預算）。
2. ⚠️ **`maxmemory-policy` 用 `volatile-lru` 而不是 `allkeys-lru`**——
   至少讓沒有 TTL 的 key（例如那個 index）不會被踢掉。
   **但這只是減害，真正的答案是「不要讓它滿」。**
3. **Session 裡只放識別用的最小資料**（下一節）。

---

## 11.7 Session 裡該放什麼

```
✅ 使用者 id、角色、租戶 id、語系、CSRF token
⚠️ 購物車（可以，但要知道 11.6.3 那個 14 GB）
❌ 商品明細、查詢結果、上一頁的表單內容、任何「可以再查一次」的東西
❌ 任何個資（11.5.4）
```

> 📌 **一個好用的判準**：
> **「這筆資料如果消失了，使用者會不會損失他做過的事？」**
>
> - 會（購物車、填到一半的表單）→ ⚠️ **那它不該只存在 Session 裡**，
>   應該落到資料庫，Session 只存一個 id。
> - 不會（語系、上次瀏覽的分類）→ 放 Session 沒問題。
>
> **換句話說：Session 應該是可以隨時消失的。**
> 如果你的系統「Session 掉了會出事」，那不是 Redis 的問題，是設計的問題。

---

## 11.8 強制下線

### 11.8.1 先設成 `indexed`

```yaml
spring:
  session:
    redis:
      repository-type: indexed
```

然後 Redis 那一側：

```bash
docker exec redis-lab redis-cli CONFIG SET notify-keyspace-events Egx
```

### 11.8.2 查詢一個使用者的所有 Session

```java
private final FindByIndexNameSessionRepository<? extends Session> sessions;

@GetMapping("/sessions")
public Object listSessions(@RequestParam String user) {
    Map<String, ? extends Session> found = sessions.findByPrincipalName(user);
    ...
}
```

⚠️ **索引只有在「Spring Security 真的做過認證」時才會建立。**
自己手動 `session.setAttribute("user", ...)` 是**不會**進索引的——
Spring Session 認的是 `SPRING_SECURITY_CONTEXT` 這個屬性裡的 principal 名字。

### 11.8.3 實測：三個裝置

alice 在 web（18081）、phone（18082）、tablet（18081）各登入一次，bob 也登入一次：

```
═══ 同一個使用者在三個裝置上登入 ═══
  {"sessionId":"295265f2-…","user":"alice","instance":18081,"device":"web"}
  {"sessionId":"7c23e11b-…","user":"alice","instance":18082,"device":"phone"}
  {"sessionId":"a0d0646a-…","user":"alice","instance":18081,"device":"tablet"}

  alice 的所有 Session（從 18082 查，它從來沒處理過其中兩個）：
     count = 3
       { "device": "web",    "sessionId": "295265f2-b4a1…", "lastAccessed": "2026-09-18T04:19:58.358Z" }
       { "device": "phone",  "sessionId": "7c23e11b-76fa…", "lastAccessed": "2026-09-18T04:19:58.439Z" }
       { "device": "tablet", "sessionId": "a0d0646a-bdcd…", "lastAccessed": "2026-09-18T04:19:58.476Z" }
```

Redis 裡：

```
spring:session:index:…PRINCIPAL_NAME_INDEX_NAME:alice   set   SCARD=3
spring:session:index:…PRINCIPAL_NAME_INDEX_NAME:bob     set   SCARD=1
```

> 📌 **「從 18082 查，它從來沒處理過其中兩個」** 是這個實驗的重點：
> 這就是集中存放買到的能力——**任何一台機器都能看到全部的登入狀態。**

### 11.8.4 實測：踢掉

```java
@PostMapping("/kill")
public Object kill(@RequestParam String user) {
    Map<String, ? extends Session> found = sessions.findByPrincipalName(user);
    found.keySet().forEach(sessions::deleteById);
    return Map.of("user", user, "killed", found.size());
}
```

```
  踢之前：web/phone/tablet 三個都是 alice ✅

  在 18082 執行 kill（web 與 tablet 這兩個 Session 是 18081 建的）
     {"killed":3,"user":"alice"}

  踢之後：
     web     → {"instance":18081,"user":"(未登入)"}
     phone   → {"instance":18081,"user":"(未登入)"}
     tablet  → {"instance":18081,"user":"(未登入)"}
     bob     → {"user":"bob",...}     ← 沒被影響
```

### 11.8.5 ⚠️ 踢掉之後，key 還在 Redis 上五分鐘

```
  Redis 裡剩下的 session key：
     spring:session:sessions:7c23e11b-…     TTL=286    ← alice（已經踢掉）
     spring:session:sessions:a0d0646a-…     TTL=286    ← alice（已經踢掉）
     spring:session:sessions:295265f2-…     TTL=286    ← alice（已經踢掉）
     spring:session:sessions:8f45e74c-…     TTL=2086   ← bob（還活著）
```

> 📌 **`deleteById` 做的事情是**：
> ① 把 principal index 清掉（`SCARD` 歸零）→ 所以查不到了；
> ② 刪掉 `sessions:expires:<id>`；
> ③ **把 `maxInactiveInterval` 設成 0 再存回去** → hash 的 TTL 變成那 5 分鐘的寬限期。
>
> 使用者**立刻**就登不進來了（`maxInactiveInterval=0` → 讀出來就算過期），
> 但 **key 會在 Redis 上再待 5 分鐘**，讓 `SessionDestroyedEvent` 有東西可以帶。
>
> ⚠️ **所以不要用 `KEYS`／`DBSIZE` 判斷「還有幾個人在線上」**——
> 那個數字會包含最近五分鐘內所有被踢掉與過期的 Session。

---

## 11.9 JWT：換一種做法

### 11.9.1 它跟 Session 的根本差別

```
Session：  cookie 裡是一把「鑰匙」（36 bytes），資料在伺服器這邊
              └─ 每個請求都要去 Redis 拿一次（11.4.4 的 8 個命令）
              └─ ✅ 你隨時可以把那份資料刪掉 ＝ 撤銷

JWT：      token 裡就是「資料本身」（207 bytes），伺服器什麼都不存
              └─ 驗證只需要密鑰 + 簽章 + 過期時間，不用問任何人
              └─ ⚠️ 正因為不用問任何人，所以你也沒有地方可以說「這個不算數」
```

### 11.9.2 實測：它撤不掉

```
═══ 11.9.2 JWT 本身：發出去之後你什麼都做不了 ═══
  token 長度 = 207 bytes（Session cookie 是 36 bytes）
  eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJhbGljZSIsImp…
  解出來 → sub=alice jti=ea88dcff… 還有 3600 秒到期
  ⚠️ 使用者按了「登出」——伺服器能做什麼？
     驗證這個 token 需要：密鑰 ✅、簽章 ✅、有沒有過期 ✅
     完全不需要問任何人，所以「撤銷」這個動作沒有地方可以放。
```

> ⚠️ **「登出」在純 JWT 下只是「請前端把 token 刪掉」。**
> 而那個 token **在到期之前都還是有效的**——
> 如果它已經被記錄在某個 log、某個瀏覽器擴充套件、某個代理伺服器的快取裡，
> **你什麼都做不了。**
>
> 📌 **這在下面這些場景是不能接受的**：
> 密碼被改掉（可能是因為外洩）、帳號被停權、權限被降級、
> 使用者說「我的筆電被偷了」。

### 11.9.3 「無狀態」換來什麼、失去什麼

| | Session（Redis） | JWT |
|---|---|---|
| 每個請求的 Redis 成本 | **6 ～ 8 個命令** | **0** |
| 傳輸大小 | 36 bytes | **207 bytes**（放了角色與宣告會更大） |
| 撤銷 | ✅ 立刻 | ❌ **做不到**（除非 11.10） |
| 改權限立刻生效 | ✅ | ❌ 要等 token 過期 |
| Redis 掛掉 | ❌ 全部登出（11.11） | ✅ 不受影響 |
| 跨服務 / 跨網域 | 要共用 Redis | ✅ 只要共用公鑰 |
| ⚠️ 資料外洩面 | 在伺服器 | **在使用者的裝置上、在每一個 log 裡** |

> 📌 **一句話**：
> **JWT 把「每次都問一下」換成「一次講清楚」。**
> 而「撤銷」的本質就是「我改變主意了」——**你不可能對一句已經講完的話改變主意。**

---

## 11.10 撤銷 JWT

### 11.10.1 兩種做法

```
① jti 黑名單        ── 撤銷「這一個 token」
     └─ key: jwt:blacklist:<jti>，TTL = 這個 token 還剩多久

② notbefore 時間戳  ── 撤銷「這個人現在手上的全部 token」
     └─ key: jwt:notbefore:<user>，值 = 現在的時間戳
        驗證時：token 的 iat < notbefore  →  拒絕
```

```java
@Service
public class TokenRevocationService {

    /** ① 撤銷一個 token。⚠️ TTL 只要撐到它自己過期就好。 */
    public long revoke(Jwt.Claims c) {
        long remaining = c.exp() - Instant.now().getEpochSecond();
        if (remaining <= 0) return 0;                       // 已經過期了，不用記
        redis.opsForValue().set("jwt:blacklist:" + c.jti(), "1", Duration.ofSeconds(remaining));
        return remaining;
    }

    /** ② 一次撤銷某個使用者的所有 token。 */
    public void revokeAllFor(String user, Duration maxTokenTtl) {
        redis.opsForValue().set("jwt:notbefore:" + user,
                String.valueOf(Instant.now().getEpochSecond()), maxTokenTtl);
    }

    public boolean isValid(Jwt.Claims c) {
        if (Boolean.TRUE.equals(redis.hasKey("jwt:blacklist:" + c.jti()))) return false;
        String notBefore = redis.opsForValue().get("jwt:notbefore:" + c.sub());
        return notBefore == null || c.iat() >= Long.parseLong(notBefore);
    }
}
```

### 11.10.2 實測

```
═══ 11.10.2 jti 黑名單：撤銷單一 token ═══
  撤銷前 isValid = true
  撤銷（黑名單 TTL = 300 秒 ＝ 這個 token 還剩的壽命）
  撤銷後 isValid = false
  Redis 裡：jwt:blacklist:722c70e8-…  TTL=300  MEMORY=96 bytes
```

```
═══ 11.10.2 一次撤銷一個人的所有 token ═══
  撤銷前：alice/web=true alice/phone=true bob=true
  撤銷 alice 的全部 token（只寫了一個 key）
  撤銷後：alice/web=false alice/phone=false bob=true
  撤銷之後重新登入拿到的新 token → true（要能用）
  Redis 裡只有：jwt:notbefore:alice
```

> 📌 **`notbefore` 那個做法只寫一個 key，就撤銷了這個人手上所有的 token**，
> 而且**之後新發的還能用**（因為新 token 的 `iat` 比 `notbefore` 大）。
>
> **這是「改密碼後強制所有裝置重新登入」的標準做法。**

### 11.10.3 ⚠️ 秒級精度的競態

上面那段測試裡有一行 `Thread.sleep(1100)`，它不是為了讓輸出好看：

```
  發 token（iat = 1789705279）
  同一秒內撤銷（notbefore = 1789705279）
        │
        └─ 驗證：iat >= notbefore  →  1789705279 >= 1789705279  →  ✅ 通過
                                                 ⚠️ 這個 token 沒有被撤銷
```

**JWT 的 `iat` / `exp` 單位是秒**（RFC 7519）。所以「撤銷」與「簽發」如果落在同一秒，
那個 token 會活下來。

📌 **兩個修法**：

```java
// ① notbefore 往後推一秒（寧可多撤銷一點）
redis.opsForValue().set(key, String.valueOf(Instant.now().getEpochSecond() + 1), ttl);

// ② 驗證改成嚴格大於
return notBefore == null || c.iat() > Long.parseLong(notBefore);
```

⚠️ **兩個都會讓「撤銷後立刻重新登入」的那個 token 也被撤掉**，
所以登入流程要能容忍「拿到 token 之後第一次呼叫失敗，重新登入一次」。
**這是正確性與體驗之間的取捨，但方向只有一個：寧可多撤銷。**

### 11.10.4 黑名單會長多大

```
═══ 11.10.4 黑名單會長多大 ═══
  1000 個被撤銷的 token → 1000 個 key，used_memory=1.5 MB
  單一 key = 96 bytes
```

> 📌 **黑名單不會無限成長**，因為每個 key 的 TTL 就是那個 token 的剩餘壽命。
> **token 過期的那一刻，黑名單項目也自己消失**——它本來就不需要活得更久。
>
> ⚠️ **所以 access token 的有效期要短。**
> 有效期 7 天的話，黑名單要背 7 天的量；有效期 15 分鐘的話，**最多只背 15 分鐘的量**。

### 11.10.5 refresh token：真正該存的那一個

```
access token   有效 15 分鐘    ── 不查 Redis（除非在黑名單裡）
refresh token  有效 30 天      ── ⚠️ 每次使用都要查 Redis，而且用完就換一個
```

```java
// 換發：舊的立刻作廢（rotation）
public Tokens refresh(String refreshToken) {
    String userId = redis.opsForValue().get("rt:" + refreshToken);
    if (userId == null) throw new InvalidTokenException();

    redis.delete("rt:" + refreshToken);                    // ⚠️ 一定要先刪，且只能成功一次
    String next = UUID.randomUUID().toString();
    redis.opsForValue().set("rt:" + next, userId, Duration.ofDays(30));
    redis.opsForSet().add("rt:user:" + userId, next);      // 讓「踢掉所有裝置」做得到
    return new Tokens(Jwt.issue(userId, 900), next);
}
```

⚠️ **「舊的 refresh token 又被用了一次」代表 token 被偷了。**
標準做法（OAuth 2.0 BCP 的 refresh token rotation）是：
**偵測到重用時，把這個使用者的所有 refresh token 全部作廢**——
因為你分不出來現在用的是真的使用者還是小偷。

> 📌 **這一段跟 09 章的鎖是同一個形狀**：
> `GET` 之後 `DELETE` 之間有一道縫（兩個人同時拿同一個 refresh token 去換），
> **所以它應該是一段 Lua**：
>
> ```lua
> local uid = redis.call('GET', KEYS[1])
> if uid == false then return nil end
> redis.call('DEL', KEYS[1])
> return uid
> ```

### 11.10.6 ⚠️ 加了黑名單，它還算「無狀態」嗎

**不算了，而且這是一個要誠實面對的取捨：**

| | 純 JWT | JWT + 黑名單 | Session |
|---|---|---|---|
| 每個請求查 Redis | 0 次 | **1 次**（`hasKey`） | 6 ～ 8 次 |
| 撤銷 | ❌ | ✅ | ✅ |
| Redis 掛掉 | ✅ 不受影響 | ⚠️ **見下方** | ❌ 全部登出 |

> ⚠️ **「JWT + 黑名單」在 Redis 掛掉時，你要回答一個很尷尬的問題**：
> **查不到黑名單，要放行還是拒絕？**
>
> - 放行 → **被撤銷的 token 在這段期間全部復活**（包含被偷走的那個）。
> - 拒絕 → 跟 Session 一樣全部登出，**那你當初選 JWT 的理由就沒了**。
>
> 📌 **一個實務上的折衷**：
> **黑名單查詢 fail-open，但把 access token 的有效期壓到 5 ～ 15 分鐘。**
> 這樣「復活視窗」最多就是那 15 分鐘，而且要求 refresh 的時候一定會查到 Redis。
> ⚠️ **這個決定要寫在文件裡**，因為它是一個明確的安全取捨，不是一個實作細節。

---

## 11.11 ⚠️ Redis 掛掉的時候

### 11.11.1 實測

alice 已登入，然後 `docker pause redis-lab`：

```
═══ 11.11.1 Redis 掛掉的時候，已登入的使用者看到什麼 ═══
  正常：{"user":"alice",...} [200] 0.017s

  --- docker pause redis-lab ---
  第 1 次： [500] 1.564s
  第 2 次： [500] 1.537s
  第 3 次： [500] 1.544s
  新的登入： [500] 2.093s

  --- unpause 之後 ---
  alice：{"user":"alice",...} [200]      ← 自己恢復了

  app log：
   12 次  QueryTimeoutException: Redis command timed out
   12 次  RedisCommandTimeoutException: Command timed out after 500 millisecond(s)
```

`docker stop`（行程消失）：

```
  已登入： [500] 0.013s      ← 快速失敗
```

> ⚠️ **請看 `pause` 那三個 1.5 秒。**
>
> 06 章設的 `timeout` 是 **500 毫秒**，但一個請求花了 **1.5 秒**——
> 因為 11.4.3 量到的那 8 個命令裡，**有三個是逐一逾時的**。
>
> 📌 **這是 08 章 8.2.4 的完整重演，而且更糟**：
> 快取的問題只影響有快取的 API，**Session 的問題影響「每一個需要登入的 API」**。
> 50 條 Tomcat 執行緒 ÷ 1.5 秒 = **每秒 33 個請求**（8.4.1 的 Little's Law）。

### 11.11.2 ⚠️ Redis 重開之後：所有人一起登出

```
  docker start redis-lab
  （Redis 重開之後，資料是空的）alice：{"instance":18081,"user":"(未登入)"}
```

> ⚠️ **這比「Redis 掛掉」嚴重得多**，因為它是**靜默**的：
> 沒有錯誤、沒有 500、沒有告警——**只是所有人同時被登出。**
>
> 📌 **這是 04 章的持久化那一章唯一一個「快取可以不持久化，但這個不行」的例子**：
> - 快取掉了 → 重新查一次資料庫（07 章）。
> - **Session 掉了 → 全站使用者重新登入一次。**
>
> ⚠️ **所以 Session 用的 Redis 要開 AOF**（04 章 4.8），
> 而且 `appendfsync everysec` 是可以接受的——
> **掉一秒鐘的 Session 更新（＝ 幾個人的 `lastAccessedTime`）不會有人發現。**

### 11.11.3 那該怎麼辦

**沒有 fail-open 這個選項。**

```java
// ⚠️ 絕對不要
catch (RedisConnectionFailureException e) {
    return anonymousButTreatAsLoggedIn();     // ⚠️⚠️⚠️
}
```

**「Redis 查不到，就當作已登入」＝ 任何人送一個隨機 sessionId 就能變成任何人。**

**能做的是這四件事**：

| | 做法 |
|---|---|
| ① 把逾時壓下來 | Session 的 `RedisTemplate` 用**更短**的逾時（150 ～ 200 毫秒），理由同 10.11.3 |
| ② 回**503** 而不是 500 | 帶 `Retry-After`，讓客戶端知道這是暫時的（10.7.1） |
| ③ ⚠️ **不要把登入頁也擋掉** | 靜態頁、健康檢查、`/login` 本身不該依賴 Redis |
| ④ **高可用** | Session 的 Redis 要有主從 / Sentinel（13 章），而且**開 AOF** |

> 📌 **⚠️ 再加一條 08 章 8.6 的提醒**：
> **不要把「Redis 可用」放進 readiness 探針。**
> Redis 掛掉時，那會讓**整個叢集一起從負載平衡上消失**——
> 本來只是「登入功能壞了」，變成「網站不存在」。

---

## 11.12 落地：shop-service

### 11.12.1 設定

```yaml
spring:
  session:
    timeout: 30m
    redis:
      repository-type: indexed         # 11.8：要強制下線就必須
      namespace: shop:session          # ⚠️ 不要用預設的 spring:session（跟別的服務撞）
      flush-mode: on_save              # 11.4.4：不要用 immediate
      cleanup-cron: "0 * * * * *"      # 備援掃描，每分鐘

server:
  servlet:
    session:
      cookie:
        name: SHOPSESSION
        http-only: true
        secure: true
        same-site: lax

lab10:
  session:
    serializer: json                   # 11.5
    redis:
      timeout: 200ms                   # ⚠️ 11.11.3：比一般操作短
  jwt:
    access-ttl: 15m                    # 11.10.4：短，黑名單才不會長
    refresh-ttl: 30d
    blacklist-fail-open: true          # ⚠️ 11.10.6：這是一個安全決策，要寫進文件
```

Redis 那一側（`indexed` 必需）：

```bash
docker exec redis-lab redis-cli CONFIG SET notify-keyspace-events Egx
# ⚠️ 正式環境寫進 redis.conf，不要只 CONFIG SET（重啟就沒了）
```

### 11.12.2 三條規約（接續 10 章 10.12.4 的第 29 條）

30. **Session 的 Redis 與快取的 Redis 分開。**
    ⚠️ 共用的話，熱門商品的快取會把使用者的登入狀態擠掉（11.6.4），
    而且**不會留下任何痕跡**。
31. **Session 裡只放「消失了也不會讓使用者損失做過的事」的資料**（11.7）。
    購物車要落資料庫，Session 只存 id。
32. ⚠️ **登入狀態沒有 fail-open。**
    任何 `catch (RedisConnectionFailureException)` 裡都不可以有「當作已登入」的分支（11.11.3）。

### 11.12.3 四個該接告警的指標（接續 10 章 10.12.5）

| 指標 | 告警條件 | 代表什麼 |
|---|---|---|
| **`session.redis.errors`** | **> 0** | 有人正在被 500 擋在門外 |
| **`redis.evicted_keys`（Session 那台）** | **> 0 就是事故** | **有人的購物車被踢掉了**（11.6.4），⚠️ 這是唯一會看到它的方法 |
| `session.count`（`index` 的 `SCARD` 總和） | 突然掉一半 | Redis 重開過（11.11.2），或清理任務出問題 |
| **`jwt.blacklist.size`** | 持續成長不下降 | ⚠️ 黑名單的 TTL 設錯了（11.10.4） |

---

## 11.13 常見誤區

**① 「Session 問題在測試環境重現不了，應該不是什麼大事」**

11.2.2：它**只在多實例時出現**。測試環境只有一台，所以它保證不會出現——直到上線。

**② 「用 sticky session 就好了」**

11.2.3：那等於「一台機器重開 = 那批使用者登出」。滾動更新的時候每台都會重開一次。

**③ 「加了 spring-session-data-redis 就完成了」**

11.3.3：cookie 名字變了（前端可能寫死）、序列化是 JDK 的（11.5）、
預設是 `default` repository（11.4.1，沒有強制下線）。

**④ 「Session 資料很小，不用擔心記憶體」**

11.6.3：**一個空的 Session 就 2.5 KB**，100 萬人 = 2.4 GB；購物車 200 件 = 14 GB。

**⑤ 「Session 跟快取放同一台 Redis，反正都是 Redis」**

11.6.4：`allkeys-lru` 之下，**熱門商品的快取會把使用者的登入狀態擠掉**，
而且**沒有錯誤、沒有日誌、沒有告警**。

**⑥ 「序列化器不用管，預設能跑就好」**

11.5：82 bytes 存一個 `Long`；改了類別之後舊 Session 全部 `InvalidClassException`。

**⑦ 「換成 JSON 就好了」**

11.5.3：⚠️ 少了 `SecurityJackson2Modules` 會**寫得進去讀不回來**，
而且錯誤訊息指向 SpEL，不是序列化器。

**⑧ 「`spring.session.redis.repository-type` 是什麼？沒設過」**

11.4.1：那你用的是 `default`，`FindByIndexNameSessionRepository` 這個 bean 不存在。

**⑨ 「踢掉之後 `DBSIZE` 沒變少，是不是沒踢掉」**

11.8.5：`deleteById` 把 TTL 改成 5 分鐘的寬限期，**使用者已經登不進來了**，key 晚點才消失。

**⑩ 「JWT 是無狀態的，所以登出只要前端刪掉 token」**

11.9.2：那個 token **在到期前都還有效**。密碼被改、帳號被停權、筆電被偷——你什麼都做不了。

**⑪ 「JWT 加黑名單，就兼具兩者優點」**

11.10.6：⚠️ 它**不再是無狀態的**了，而且 Redis 掛掉時你要在
「被撤銷的 token 復活」與「全部登出」之間選一個。

**⑫ 「黑名單會無限成長」**

11.10.4：不會——每個項目的 TTL 就是那個 token 的剩餘壽命。⚠️ **前提是 access token 有效期要短。**

**⑬ 「Redis 是快取，掛了重開就好，Session 再登入一次而已」**

11.11.2：那是**全站使用者同時被登出**，而且**沒有任何錯誤訊息**。
⚠️ Session 的 Redis 要開 AOF。

---

## 11.14 本章小結

```
      多實例 ──▶ Session 不見了（11.2）
                    │
                    └─ Spring Session Redis（11.3）── 一個依賴，零行程式
                              │
                              ├─ ⚠️ 序列化（11.5）── JDK：82 bytes 存一個 Long
                              ├─ ⚠️ 記憶體（11.6）── 空 Session 2.5 KB × 100 萬 = 2.4 GB
                              │        └─ 滿了 ──▶ 別人的購物車被驅逐，而且沒有告警
                              ├─ 強制下線（11.8）── 需要 indexed + keyspace 事件
                              └─ ⚠️ Redis 掛掉（11.11）── 沒有 fail-open

      不想付這個成本 ──▶ JWT（11.9）
                              └─ ⚠️ 但它撤不掉
                                     └─ 撤得掉的方法（11.10）＝ 又回去查 Redis 了
```

> 📌 **這一章真正的結論**：
> **「無狀態」不是一個可以免費拿到的性質。**
>
> 你可以不存 Session，但只要你需要「**立刻讓某個人失效**」，
> 那個狀態就必須存在某個地方——不是 Session 就是黑名單。
> **差別只在於你每個請求查 8 次，還是查 1 次。**

### 11.14.1 驗收清單

- [ ] 重現得出「偶數次請求登出」的現象，並說得出為什麼是偶數次。
- [ ] 說得出 sticky session 與 Session 複製各自的代價。
- [ ] 說得出 `default` 與 `indexed` 在 Redis 裡的 key 結構差別，以及各自每請求幾個命令。
- [ ] 說得出 `sessions:<id>` 的 TTL 為什麼比 `sessions:expires:<id>` 多五分鐘。
- [ ] 說得出預設序列化器存一個 `Long` 要幾 bytes，以及為什麼。
- [ ] ⚠️ 說得出少了 `SecurityJackson2Modules` 會在**什麼時候**、以**什麼訊息**爆炸。
- [ ] 算得出你的使用者規模下 Session 的記憶體，並說出 `maxmemory` 滿了之後誰會被登出。
- [ ] 說得出為什麼 Session 的 Redis 不該跟快取共用。
- [ ] 實作出「查詢某使用者的所有 Session」與「強制下線」，並說出它需要哪兩個前置設定。
- [ ] 說得出 JWT 為什麼撤銷不掉，以及 `jti` 黑名單與 `notbefore` 各撤銷什麼。
- [ ] ⚠️ 說得出 `iat` 秒級精度造成的那個競態，以及修法的方向為什麼是「寧可多撤銷」。
- [ ] 說得出 Redis 重開之後會發生什麼，以及為什麼那比「Redis 掛掉」更需要注意。

### 11.14.2 本章練習

**練習一（15 分鐘）**：把 11.2.2 的實驗跑起來。然後把負載平衡改成
「前 5 個請求打 A、後 5 個打 B」，**觀察使用者的體驗差在哪裡**——
哪一種比較容易被回報？哪一種比較容易被忽略？

**練習二（20 分鐘）**：分別用 `default` 與 `indexed` 跑一次，
用 `CONFIG RESETSTAT` + `INFO commandstats` 量出每個請求的命令數。
然後算一次：**你的服務在尖峰 QPS 下，光是 Session 就要吃掉 Redis 多少 QPS？**

**練習三（25 分鐘，核心）**：把序列化器換成 JSON，然後：
① 量一次 `MEMORY USAGE` 的差別；
② ⚠️ **在「已經有舊 Session」的情況下切換**，看看會發生什麼；
③ 把 `SecurityJackson2Modules` 那一行拿掉，記錄**在哪一步爆、錯誤訊息長什麼樣**。

**練習四（30 分鐘）**：重現 11.6.4 的驅逐實驗：
① `CONFIG SET maxmemory 3mb`、`maxmemory-policy allkeys-lru`；
② 讓一個使用者登入並放 100 件商品；
③ 灌進 300 個新使用者；
④ ⚠️ **確認第一個使用者被登出了，然後去你的監控上找找看有沒有任何一條線變化。**
⑤ 換成 `noeviction` 再做一次，比較兩者的差別。
**記得把 `maxmemory` 改回 0。**

**練習五（30 分鐘）**：實作強制下線：
① 設成 `indexed` + `notify-keyspace-events Egx`；
② 同一個使用者在三個「裝置」登入；
③ 從**沒有處理過那些 Session 的那一台**執行 kill；
④ ⚠️ 把 `notify-keyspace-events` 關掉再做一次，**觀察 index 有沒有被清乾淨**。

**練習六（進階，40 分鐘）**：實作 11.10 的兩種撤銷，然後：
① 重現 11.10.3 的秒級競態（撤銷與簽發在同一秒）；
② 用兩種修法各修一次，並說明它們對「登出後立刻重新登入」的影響；
③ 量一次「黑名單有 10 萬個項目」時 `hasKey` 的延遲。

**練習七（進階，40 分鐘）**：用 08 章的壓測骨架量一次
「Redis `pause` 60 秒」對**登入 API** 的影響：
① 錯誤率、p50、被拒絕數；
② 把 Session 的 `RedisTemplate` 逾時從 500ms 改成 200ms，再量一次；
③ ⚠️ **回答一個問題：這兩組數字裡，有哪一個是可以接受的？如果都不行，你的方案是什麼？**

---

## 11.15 下一章預告

09、10、11 章都在用 Redis 保護「**不能出錯**」的東西：鎖、配額、冪等、登入狀態。

12 章把它們全部用上，做一件從第一章就一直在預告的事：**扛住搶購**。

- **三種防超賣方案從零寫一次**：資料庫悲觀鎖、資料庫樂觀鎖、Redis 預扣庫存——
  三種都會量一次**吞吐量與正確性**，然後給一張決策表。
- **Redis 預扣 + 資料庫落帳的完整流程**，以及 ⚠️ **中間斷掉時怎麼把帳補回來**
  （10 章的冪等在這裡是必要條件，不是加分項）。
- 原子計數與排行榜（ZSet），以及它們在搶購當下的成本。
- ⚠️ **hot key**：一個商品被十萬人同時搶時，03 章的「單執行緒」會變成什麼樣子，
  以及**庫存分桶**能救多少、會帶來什麼新問題（「明明還有貨卻買不到」）。

> 📌 **而 09 章 9.10.4 留下的那句話會在 12 章被兌現**：
> **「Redis 的鎖負責減少衝突，資料庫負責保證正確。」**
> 12 章會把那個 `UPDATE ... WHERE stock > 0` 完整展開。
