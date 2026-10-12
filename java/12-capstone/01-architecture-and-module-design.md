# 第 01 章：架構設計與模組邊界

> 第 00 章結束時，骨架會走路了：一個 `ShopApplication`、一個 `PingController`，
> 以及一張寫在文件裡的模組表（0.3.4）—— 九個模組、每張表只屬於一個模組、誰可以呼叫誰。
>
> **這一章要讓那張表從「文件」變成「程式碼的形狀」，而且讓它破不了。**
>
> 這一章結束時，你手上會有：
>
> - 九個模組的**套件結構**，每個模組分成「對外的 API」和「對內的 `internal`」（1.4）。
> - 兩個真的在工作的模組 API：`InventoryApi` 與 `OrderingApi`，以及一次**跨模組、同一個交易**的下單（1.5）。
> - **三道自動防線**：編譯器（package-private）、ArchUnit 的 6 條模組規則、一個掃描 SQL 字串的表歸屬測試（1.6）。
> - 一套 **local / prod** 分開的設定、一個啟動時就驗證的 `ShopProperties`、一個「缺環境變數就拒絕啟動」的檢查，
>   以及一個**在 `mvn test` 就抓到設定鍵打錯字**的守門員（1.7）。
>
> 「模組邊界」聽起來像是架構師的潔癖。這一章有**四個實測事故**，每一個都在說明它不是：
>
> - **為了快，繞過了庫存模組。** 1.2.1：後台「批次匯入補貨」直接 `UPDATE inventory`，比走 API 快了 **52 倍**（每筆 1.99 ms → 0.038 ms）。
>   一小時後對帳：**500 個商品、10,000 件庫存「帳外」**—— 沒有人知道是誰、什麼時候、為什麼加的。
>   ⚠️ 而且 1.6.3 會證明：**ArchUnit 的 6 條規則對這段程式碼全部綠燈。**
>   真正的解法也不是「禁止」，而是**請庫存模組開一個批次 API** —— 實測 0.052 ms/筆，跟繞過去幾乎一樣快。
> - **設定檔少打一個字母。** 1.2.2：`timeout: 500ms` 寫成 `timeot: 500ms`。
>   Spring Boot **沒有任何警告**，Redis 的逾時從 **0.51 秒變成 60.01 秒** —— 那是 Lettuce 的預設值。
>   0.6.3 那張降級矩陣的前提（「Redis 掛了 0.5 秒就放棄」）就這樣默默消失了。
> - **正式環境少了 8 個環境變數，應用程式「啟動成功」。** 1.7.4：`Started ShopApplication in 1.731 seconds`、liveness `UP`。
>   直到第一個請求進來，才在一百多行的堆疊深處出現 `UnknownHostException: ${SHOP_DB_HOST}` —— 字面上的 `${SHOP_DB_HOST}`。
> - **把模組呼叫換成 HTTP，延遲幾乎沒變，資料卻開始出錯。** 1.2.3：同一個 JVM、同一台 MySQL，
>   HTTP 版的 p50 只多了 **0.24 ms**。但下單 1,000 筆、其中 55 筆在預留之後失敗 ——
>   直接呼叫的版本**訂單 945 張、預留 945 件**；HTTP 版**訂單 945 張、預留 1,000 件**，**55 筆孤兒預留**永遠佔著庫存。
>   **拆成服務的代價不是延遲，是交易。**
>
> 📌 四個事故分別在 1.6、1.7.5、1.7.4、1.3 被修好或被說清楚。
>
> ⚠️ **寫這一章途中被自己的實驗抓到的**：
>
> - **`ConfigKeyGuardTest` 第一次跑，抓到的是我們自己。** 設定處理器剛加進 `pom.xml`，Maven 的增量編譯沒有重新編譯 `ShopProperties`，
>   annotation processor 沒有執行 —— 4 筆 `shop.*` 設定鍵被報成未知（已知屬性 2,320 個）；`mvn clean` 之後 2,323 個、全部通過（1.7.5）。
> - **約束的預設訊息只翻了一半。** 第一版 `ShopProperties` 沒有寫 `message`，輸出是 `必須短於  or equal to 60 minutes` —— 它跟著 JVM 的語系走（1.7.3）。
>
> 小坑：
>
> - ArchUnit 1.x 預設把「規則什麼都沒檢查到」當成失敗：一條針對 `shared.messaging`（第 07 章才有）的肯定句規則，現在就紅（1.6.3 違規四）。
> - Spring Modulith 的 `@NamedInterface` 寫在正式程式碼的 `package-info.java` 上，只加 `test` 範圍的依賴會編譯失敗：`package org.springframework.modulith does not exist`（1.6.5）。
> - 環境變數名稱打錯字（`SPRING_DATA_REDIS_TIMEOT=5s`）照樣 `Started ShopApplication in 1.749 seconds`，`ConfigKeyGuardTest` 也看不到它（1.7.2）。
>
> 以及**沒達成、部分達成的**：
>
> - **驗收 Q11（broker 隔離）**：規則五已經寫好，但現在沒有任何 broker 程式碼可以檢查，要等第 07 章才算通過（1.8）。
> - **`PlaceOrderService` 的「跨模組、同一個交易」沒有任何測試直接呼叫它**（1.5.4）。1.2.3 的交易實驗是在測試裡自己組 `insertOrder()` + `inventory.reserve()`；
>   「庫存不足時訂單一起 rollback」沒有在正式的 `placeOrder()` 上驗證過。第 02 章會把這個簡化版刪掉，第 04 章再寫完整版。

---

## 1.1 學習目標

完成本章後，你應該可以：

- 用 1.2.3 的數字說明**為什麼本專題是模組化單體而不是微服務**，以及「拆」真正的代價在哪裡（1.3）。
- 比較 **package-by-layer** 與 **package-by-module** 兩種套件結構，並說出前者為什麼**表達不了**「這張表是誰的」（1.4）。
- 說明 **Java 的 package-private 能保護什麼、不能保護什麼**，並解釋為什麼本專題還需要 ArchUnit（1.4.3）。
- 設計一個模組的**對外 API**：用介面、用自己的 DTO、在邊界轉換型別、用 `Propagation.MANDATORY` 表達「必須在你的交易裡呼叫我」（1.5）。
- 說出**模組之間的三種互動方式**（同步 API、事件、唯讀查詢），以及每一種用在什麼時候（1.5.1）。
- 說明**跨模組為什麼只用 id、不用 JPA 關聯**（1.5.5）。
- 用 ArchUnit 寫出本專題的 **6 條模組規則**，並看懂它們被違反時的輸出（1.6.2～1.6.3）。
- 說出 **ArchUnit 看不到什麼**（SQL 字串），以及 `TableOwnershipTest` 怎麼補上那一塊（1.6.4）。
- 比較 ArchUnit 與 **Spring Modulith**，說出本專題選前者的理由（1.6.5）。
- 設計 **local / prod** 兩套設定，並說出什麼可以進 repo、什麼一定要走環境變數（1.7.1、1.7.6）。
- 用 `@ConfigurationProperties` + `@Validated` 讓錯誤的設定**在啟動時就失敗**（1.7.3）。
- 重現「缺環境變數卻啟動成功」，並用 `UnresolvedPlaceholderCheck` 修好它（1.7.4）。
- 用 `ConfigKeyGuardTest` 在 `mvn test` 就抓到 `spring.*` 設定鍵的打錯字（1.7.5）。

---

## 1.2 先看見痛：邊界不是潔癖

> 📌 本節三個實驗都需要 `compose.yaml` 起的 MySQL 與 Redis（`docker compose up -d --wait`）。
> 程式碼放在 `src/test/java/com/example/shop/ch01/`，用到的正式程式碼（`InventoryApi` 等）在 1.5 會完整列出 —— 這裡先看它們被用的樣子。
> **操作順序**：先讀完 1.2，等 1.5.2～1.5.3 的 `InventoryApi`、`ReserveLine`、`InsufficientStockException`、`JdbcInventoryService` 都建好之後，
> 再回來跑 B1、B3（在那之前它們編譯不過）。B2 不用到任何正式程式碼，只需要 Redis 與兩個 yml，隨時可以跑。
>
> 本章的表結構是**暫時的**，放在 `src/test/resources/ch01-schema.sql`，每個測試開始前用 `@Sql` 重建。
> 第 02 章會改成 Flyway 管理的正式 schema。

```sql
-- 第 01 章的暫時 schema。第 02 章會改由 Flyway 管理。
DROP TABLE IF EXISTS inventory_ledger;
DROP TABLE IF EXISTS inventory;
DROP TABLE IF EXISTS orders;

CREATE TABLE inventory (
  product_id BIGINT PRIMARY KEY,
  on_hand    INT NOT NULL,
  reserved   INT NOT NULL DEFAULT 0,
  CONSTRAINT ck_inventory_reserved CHECK (reserved >= 0 AND reserved <= on_hand)
);

CREATE TABLE inventory_ledger (
  id             BIGINT AUTO_INCREMENT PRIMARY KEY,
  product_id     BIGINT NOT NULL,
  delta_on_hand  INT NOT NULL,
  delta_reserved INT NOT NULL,
  reason         VARCHAR(20) NOT NULL,
  ref            VARCHAR(100),
  created_at     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_ledger_product (product_id)
);

CREATE TABLE orders (
  id         BIGINT AUTO_INCREMENT PRIMARY KEY,
  buyer_id   BIGINT NOT NULL,
  status     VARCHAR(20) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
);
```

### 1.2.1 事故一：批次匯入補貨，繞過了庫存模組 ★★★

**情境**：賣家反映「500 個商品一個一個補貨太慢了，能不能上傳 CSV？」
負責商品模組的工程師接下了這個需求，先看了一下庫存模組的 `InventoryApi.restock()` —— 一次只能補一個商品、每次一個交易。
500 個商品就是 500 個交易。**太慢了。**

接著打開資料庫，看到 `inventory` 表只有三個欄位。「反正只是把數字加上去」—— 於是寫了一句 `batchUpdate`。

這個實驗把 1,500 個商品分成三組，用三種做法各補貨 +20：

```java
package com.example.shop.ch01;

import com.example.shop.inventory.InventoryApi;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.jdbc.Sql;
import org.springframework.transaction.support.TransactionTemplate;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * 1.2.1 「批次匯入補貨」為了快，繞過庫存模組直接寫表。
 */
@SpringBootTest
@Sql("/ch01-schema.sql")
class B1BypassOwnerTest {

    static final int PRODUCTS = 1_500;
    static final int GROUP = 500;

    @Autowired JdbcTemplate jdbc;
    @Autowired InventoryApi inventory;
    @Autowired TransactionTemplate tx;

    void seed() {
        List<Object[]> inv = new ArrayList<>(), led = new ArrayList<>();
        for (long id = 1; id <= PRODUCTS; id++) {
            inv.add(new Object[]{id, 100});
            led.add(new Object[]{id, 100, 0, "INITIAL", "seed"});
        }
        jdbc.batchUpdate("INSERT INTO inventory(product_id, on_hand) VALUES (?, ?)", inv);
        jdbc.batchUpdate("INSERT INTO inventory_ledger(product_id, delta_on_hand, delta_reserved, reason, ref) VALUES (?,?,?,?,?)", led);
    }

    /** INV-3：on_hand 必須等於帳上所有 delta_on_hand 的總和 */
    List<Map<String, Object>> reconcile() {
        return jdbc.queryForList("""
                SELECT i.product_id, i.on_hand, COALESCE(SUM(l.delta_on_hand), 0) AS ledger_sum
                  FROM inventory i LEFT JOIN inventory_ledger l ON l.product_id = i.product_id
                 GROUP BY i.product_id, i.on_hand
                HAVING i.on_hand <> ledger_sum
                 ORDER BY i.product_id""");
    }

    @Test
    void bypassTheOwner() {
        seed();
        System.out.println("═══ 1.2.1 批次匯入補貨：走 API vs 直接寫表 ═══");
        System.out.printf("  %,d 個商品，每個補貨 +20，分三組、三種做法%n%n", PRODUCTS);

        // 做法一：透過庫存模組，一筆一筆（每筆一個交易，每筆寫一筆 ledger）
        long t0 = System.nanoTime();
        for (long id = 1; id <= GROUP; id++) inventory.restock(id, 20, "import:2026-09-24.csv");
        long apiMs = (System.nanoTime() - t0) / 1_000_000;

        // 做法二：「反正只是加數字」——直接 batch UPDATE，一個交易
        List<Object[]> args = new ArrayList<>();
        for (long id = GROUP + 1; id <= 2 * GROUP; id++) args.add(new Object[]{20, id});
        long t1 = System.nanoTime();
        tx.executeWithoutResult(s ->
                jdbc.batchUpdate("UPDATE inventory SET on_hand = on_hand + ? WHERE product_id = ?", args));
        long directMs = (System.nanoTime() - t1) / 1_000_000;

        // 做法三：請庫存模組加一個批次 API
        List<InventoryApi.RestockLine> lines = new ArrayList<>();
        for (long id = 2 * GROUP + 1; id <= 3 * GROUP; id++) lines.add(new InventoryApi.RestockLine(id, 20));
        long t2 = System.nanoTime();
        inventory.restockBatch(lines, "import:2026-09-24.csv");
        long batchApiMs = (System.nanoTime() - t2) / 1_000_000;

        System.out.printf("  一：InventoryApi.restock() 逐筆 （商品    1～ 500） : %,5d ms  （%.3f ms/筆）%n", apiMs, apiMs / (double) GROUP);
        System.out.printf("  二：直接 batch UPDATE 繞過模組  （商品  501～1000） : %,5d ms  （%.3f ms/筆）%n", directMs, directMs / (double) GROUP);
        System.out.printf("  三：InventoryApi.restockBatch() （商品 1001～1500） : %,5d ms  （%.3f ms/筆）%n%n", batchApiMs, batchApiMs / (double) GROUP);

        List<Map<String, Object>> diff = reconcile();
        System.out.printf("  ── 一小時後，對帳排程（INV-3：on_hand = Σ ledger）──%n");
        System.out.printf("  差異商品數 : %,d / %,d%n", diff.size(), PRODUCTS);
        diff.stream().limit(3).forEach(r -> System.out.printf("    product %s : on_hand=%s  帳上=%s  差 %d%n",
                r.get("product_id"), r.get("on_hand"), r.get("ledger_sum"),
                ((Number) r.get("on_hand")).intValue() - ((Number) r.get("ledger_sum")).intValue()));
        if (diff.size() > 3) System.out.println("    ...");
        Integer ghost = jdbc.queryForObject("""
                SELECT SUM(i.on_hand) - (SELECT SUM(delta_on_hand) FROM inventory_ledger) FROM inventory i""", Integer.class);
        System.out.printf("  帳外庫存合計 : %,d 件  ← 誰加的？什麼時候？為什麼？ledger 裡沒有任何紀錄%n", ghost);
    }
}
```

**輸出**：

```
═══ 1.2.1 批次匯入補貨：走 API vs 直接寫表 ═══
  1,500 個商品，每個補貨 +20，分三組、三種做法

  一：InventoryApi.restock() 逐筆 （商品    1～ 500） :   995 ms  （1.990 ms/筆）
  二：直接 batch UPDATE 繞過模組  （商品  501～1000） :    19 ms  （0.038 ms/筆）
  三：InventoryApi.restockBatch() （商品 1001～1500） :    26 ms  （0.052 ms/筆）

  ── 一小時後，對帳排程（INV-3：on_hand = Σ ledger）──
  差異商品數 : 500 / 1,500
    product 501 : on_hand=120  帳上=100  差 20
    product 502 : on_hand=120  帳上=100  差 20
    product 503 : on_hand=120  帳上=100  差 20
    ...
  帳外庫存合計 : 10,000 件  ← 誰加的？什麼時候？為什麼？ledger 裡沒有任何紀錄
```

（跑了四次，做法一在 986～1,087 ms 之間、做法二 19～21 ms、做法三 24～26 ms。）

**先看做法一與做法二：這位工程師的判斷是對的。**

逐筆走 API 每筆 **1.99 ms**，直接 batch 每筆 **0.038 ms**，**快了 52 倍**。
差別來自 0.11 量過的那件事：每一次 commit 都要 fsync。500 個交易 = 500 次 fsync；一個交易 = 1 次。

所以這不是一個「偷懶的工程師」的故事。**效能分析完全正確**，只是選了一個錯的修法。

**再看對帳：500 個商品、10,000 件庫存不在帳上。**

`inventory.on_hand` 是 120，`inventory_ledger` 的總和是 100。
這 20 件是真的 —— 賣家真的補了貨、倉庫真的有貨。但 0.4.6 的 INV-3 說「`onHand` = Σ ledger」，現在這條不變量**對 500 個商品不成立**。

一小時後對帳排程告警（0.6.6）。值班的人打開 ledger 想查原因 ——
**沒有紀錄。** 沒有 `reason`、沒有 `ref`、沒有時間。值班的人沒辦法區分這 20 件是「賣家補貨」、「有人手動改資料庫」、還是「某個 bug 多加了 20」。
**對帳的價值就是能回答「為什麼差」。繞過擁有者的寫入，讓這個問題永遠無解。**

**最後看做法三：0.052 ms/筆。**

跟直接寫表（0.038）幾乎一樣快，而且帳是平的（商品 1001～1500 沒有出現在差異清單裡）。

`restockBatch()` 做的事情跟做法二一模一樣 —— 一個交易、一句 batch UPDATE —— **只是多了一句 batch INSERT 到 ledger**。
那多出來的 0.014 ms/筆，就是「每一件庫存的來龍去脈都查得到」的代價。

**這一節要帶走的**：

1. **速度來自「批次」，不是來自「繞過」。** 做法二快的原因是「一個交易 + batch」，不是「沒有經過 InventoryApi」。
   把同樣的批次放進擁有者的模組裡，你就兩者都有。
2. **擁有者知道你不知道的不變量。** 商品模組的工程師看到的是「三個欄位」，庫存模組知道的是「每一次 `on_hand` 變化都要進帳」。
   **模組邊界的真正作用，是讓不變量只存在一個地方** —— [05-service/00](../05-service/00-course-map-business-layer-role.md) 問的「不變量該守在哪裡」，本專題的答案是 0.5.1 的「一個不變量只能有一個主人」。
3. **正確的反應是「請擁有者開 API」，不是「自己寫」。** 需要的功能擁有者沒提供，這是一個**需求**，不是一個**授權**。
4. ⚠️ **這段繞過的程式碼，在 1.6 的 ArchUnit 規則面前全部綠燈。** 因為它沒有 `import` 任何庫存模組的類別 —— 它只寫了一個**字串**。
   1.6.4 會補上這一塊。

### 1.2.2 事故二：`timeout` 少了一個 `u` ★★

0.10.4 設定了 `spring.data.redis.timeout: 500ms`，理由是 Lettuce 的預設逾時是 **60 秒**，Redis 一卡住，執行緒池會被瞬間吃光。
0.6.3 那張降級矩陣的**每一格「Redis 掛了 → 降級」**，都建立在「0.5 秒內放棄」這個前提上。

現在假設有人在整理設定檔時，打錯了一個字：

```yaml
# src/test/resources/ch01-correct.yml
spring:
  data:
    redis:
      host: localhost
      port: 6379
      timeout: 500ms
```

```yaml
# src/test/resources/ch01-typo.yml
spring:
  data:
    redis:
      host: localhost
      port: 6379
      timeot: 500ms        # ← 少了一個 u
```

實驗：各起一個只有 Redis 自動組態的迷你 Spring 環境，先成功寫一次（建立連線），
然後用 `docker compose pause redis` 讓 Redis **卡住**（行程還在、但不回應任何封包 —— 等同網路斷線，或 Redis 正在執行一個很慢的命令），
再讀一次，量它要多久才放棄。

> 📌 **前置條件**：這個測試會從 JVM 裡執行 `docker compose pause/unpause redis`，所以本機要有 `docker` 命令，
> 而且 `mvn` 要在專案根目錄（`compose.yaml` 所在的目錄）執行 —— `docker compose` 靠目前目錄找到專案。
> 測試跑到一半被中斷（例如 Ctrl-C）時，Redis 可能停在 paused，之後所有碰 Redis 的東西都會卡住：手動跑一次 `docker compose unpause redis`。

```java
package com.example.shop.ch01;

import org.junit.jupiter.api.Test;
import org.springframework.boot.WebApplicationType;
import org.springframework.boot.autoconfigure.ImportAutoConfiguration;
import org.springframework.boot.autoconfigure.data.redis.RedisAutoConfiguration;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.data.redis.core.StringRedisTemplate;

/**
 * 1.2.2 設定檔打錯一個字：沒有警告、沒有錯誤，Redis 逾時從 0.5 秒變成 60 秒。
 * 需要 compose.yaml 的 Redis；測試會自己 pause / unpause 它。
 */
class B2ConfigTypoTest {

    @TestConfiguration(proxyBeanMethods = false)
    @ImportAutoConfiguration(RedisAutoConfiguration.class)
    static class RedisOnly {}

    static void compose(String... args) throws Exception {
        String[] cmd = new String[args.length + 2];
        cmd[0] = "docker"; cmd[1] = "compose";
        System.arraycopy(args, 0, cmd, 2, args.length);
        new ProcessBuilder(cmd).redirectErrorStream(true).start().waitFor();
    }

    static void run(String configName) throws Exception {
        try (ConfigurableApplicationContext ctx = new SpringApplicationBuilder(RedisOnly.class)
                .web(WebApplicationType.NONE)
                .properties("spring.config.name=" + configName, "spring.main.banner-mode=off",
                        "logging.level.root=WARN")
                .run()) {
            StringRedisTemplate redis = ctx.getBean(StringRedisTemplate.class);
            redis.opsForValue().set("ch01:k", "v");              // 先建立連線

            compose("pause", "redis");                           // Redis 卡住（等同網路斷、或 Redis 在做一個很慢的命令）
            long t0 = System.nanoTime();
            String outcome;
            try {
                redis.opsForValue().get("ch01:k");
                outcome = "成功";
            } catch (Exception e) {
                outcome = e.getClass().getSimpleName() + ": " + e.getMessage();
            }
            double sec = (System.nanoTime() - t0) / 1e9;
            compose("unpause", "redis");
            System.out.printf("  %-14s → 一次 GET 等了 %6.2f 秒後失敗%n", configName + ".yml", sec);
            System.out.printf("  %-14s   %s%n", "", outcome);
        }
    }

    @Test
    void typoMakesTimeoutSixtySeconds() throws Exception {
        System.out.println("═══ 1.2.2 設定打錯一個字 ═══");
        run("ch01-correct");
        run("ch01-typo");
    }
}
```

**輸出**：

```
═══ 1.2.2 設定打錯一個字 ═══
  ch01-correct.yml → 一次 GET 等了   0.51 秒後失敗
                   QueryTimeoutException: Redis command timed out
  ch01-typo.yml  → 一次 GET 等了  60.01 秒後失敗
                   QueryTimeoutException: Redis command timed out
```

**0.51 秒 vs 60.01 秒。例外型別一模一樣，訊息一模一樣。**

更重要的是**沒有輸出的東西**：日誌等級設在 `WARN`，兩次啟動**都沒有任何一行警告**。
Spring Boot 不會告訴你「`spring.data.redis.timeot` 不是一個已知的屬性」—— 對它來說，那只是一個沒有人讀取的鍵。

把 60 秒放回 0.6.1 的情境：尖峰每秒 250 個請求，Tomcat 預設 200 條執行緒，而且假設每個請求都會先查一次快取（商品頁、購物車都會）。Redis 卡住的那一刻：

```
每個碰到 Redis 的請求卡 60 秒
→ 200 條執行緒在 0.8 秒內全部卡住
→ 第 201 個請求開始排隊
→ 連 /api/ping 都回不了（沒有執行緒）
→ 接下來的 59 秒，整台機器對外等同當機
```

**0.6.3 那張降級矩陣的每一格「200（走 MySQL）」都不會發生** —— 因為請求根本等不到「逾時之後走降級」的那一刻。

**這一節要帶走的**：

1. **Spring Boot 對未知的設定鍵是沉默的。** 這是刻意的設計（設定來源太多，無法判斷一個鍵是不是「給別人用的」），但它代表**打錯字不會被發現**。
2. **最危險的打錯字，是讓設定「回到預設值」的那種。** 應用程式能起來、功能都正常，只有在故障的那一刻才會露餡 —— 而那正是你最需要它正確的時刻。
3. **所以設定鍵要有自動檢查。** 1.7.5 的 `ConfigKeyGuardTest` 會在 `mvn test` 時抓到這個錯字，耗時 0.15 秒。

### 1.2.3 事故三：如果庫存是另一個服務 ★★★

這個實驗回答一個每個團隊都會問的問題：**「既然模組邊界這麼清楚了，為什麼不乾脆拆成服務？」**

為了只看「拆」本身的影響，實驗把**同一個** `InventoryApi` 包成一個 HTTP 端點，讓兩種呼叫方式打**同一個 JVM、同一台 MySQL、同一段程式碼**。
唯一的差別是中間有沒有隔一次 HTTP：

```
直接呼叫：  訂單程式碼 ──(方法呼叫)──▶ InventoryApi ──▶ MySQL
HTTP 呼叫： 訂單程式碼 ──(HTTP)──▶ Controller ──▶ InventoryApi ──▶ MySQL
                                   └── 遠端有自己的交易，回應時就 commit 了
```

```java
package com.example.shop.ch01;

import com.example.shop.inventory.InventoryApi;
import com.example.shop.inventory.ReserveLine;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.context.annotation.Import;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.jdbc.Sql;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.client.RestClient;

import java.util.Arrays;
import java.util.List;
import java.util.Random;

/**
 * 1.2.3 如果庫存是另一個服務：把同一個 InventoryApi 包成 HTTP，比較延遲與交易語意。
 * 兩邊打的是同一個 JVM、同一台 MySQL —— 差別只有「中間隔了一次 HTTP」。
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@Import(B3InProcessVsHttpTest.RemoteInventory.class)
@Sql("/ch01-schema.sql")
class B3InProcessVsHttpTest {

    /** 假裝這是「庫存服務」對外的 HTTP API */
    @TestConfiguration
    @RestController
    @RequestMapping("/internal/inventory")
    static class RemoteInventory {
        final InventoryApi inventory;
        final TransactionTemplate tx;

        RemoteInventory(InventoryApi inventory, TransactionTemplate tx) {
            this.inventory = inventory;
            this.tx = tx;
        }

        @GetMapping("/{id}/available")
        int available(@PathVariable long id) { return inventory.available(id); }

        /** 遠端服務有自己的交易：請求結束時就 commit 了 */
        @PostMapping("/reserve")
        void reserve(@RequestParam long orderId, @RequestParam long productId, @RequestParam int qty) {
            tx.executeWithoutResult(s -> inventory.reserve(orderId, List.of(new ReserveLine(productId, qty))));
        }
    }

    @LocalServerPort int port;
    @Autowired InventoryApi inventory;
    @Autowired JdbcTemplate jdbc;
    @Autowired TransactionTemplate tx;

    static String stats(long[] ns) {
        long[] s = ns.clone();
        Arrays.sort(s);
        return "p50 %6.3f ms   p99 %6.3f ms".formatted(s[s.length / 2] / 1e6, s[(int) (s.length * 0.99)] / 1e6);
    }

    long insertOrder() {
        jdbc.update("INSERT INTO orders(buyer_id, status) VALUES (1, 'PENDING_PAYMENT')");
        return jdbc.queryForObject("SELECT LAST_INSERT_ID()", Long.class);
    }

    @Test
    void inProcessVsHttp() {
        jdbc.update("INSERT INTO inventory(product_id, on_hand) VALUES (1, 1000000)");
        RestClient http = RestClient.create("http://localhost:" + port);
        int n = 5_000;

        // 暖機
        for (int i = 0; i < 1_000; i++) { inventory.available(1); http.get().uri("/internal/inventory/1/available").retrieve().body(Integer.class); }

        long[] local = new long[n], remote = new long[n];
        for (int i = 0; i < n; i++) {
            long t = System.nanoTime(); inventory.available(1); local[i] = System.nanoTime() - t;
        }
        for (int i = 0; i < n; i++) {
            long t = System.nanoTime();
            http.get().uri("/internal/inventory/1/available").retrieve().body(Integer.class);
            remote[i] = System.nanoTime() - t;
        }
        System.out.println("═══ 1.2.3 模組呼叫 vs HTTP 呼叫（同一個 JVM、同一台 MySQL）═══");
        System.out.println("  ── 延遲：查一次可售庫存，各 5,000 次 ──");
        System.out.println("  直接呼叫 InventoryApi   : " + stats(local));
        System.out.println("  透過 HTTP（localhost）  : " + stats(remote));

        // ── 交易語意：下單 1,000 筆，5% 在預留庫存「之後」失敗（例如寫明細時違反約束）──
        int orders = 1_000;
        Random r = new Random(1);
        boolean[] fail = new boolean[orders];
        for (int i = 0; i < orders; i++) fail[i] = r.nextDouble() < 0.05;

        int failedLocal = 0;
        for (int i = 0; i < orders; i++) {
            boolean f = fail[i];
            try {
                tx.executeWithoutResult(s -> {
                    long id = insertOrder();
                    inventory.reserve(id, List.of(new ReserveLine(1, 1)));
                    if (f) throw new IllegalStateException("寫明細失敗");
                });
            } catch (IllegalStateException e) { failedLocal++; }
        }
        int reservedLocal = jdbc.queryForObject("SELECT reserved FROM inventory WHERE product_id = 1", Integer.class);
        int ordersLocal = jdbc.queryForObject("SELECT COUNT(*) FROM orders", Integer.class);

        jdbc.update("UPDATE inventory SET reserved = 0 WHERE product_id = 1");
        jdbc.update("DELETE FROM orders");
        jdbc.update("DELETE FROM inventory_ledger");

        int failedRemote = 0;
        for (int i = 0; i < orders; i++) {
            boolean f = fail[i];
            try {
                tx.executeWithoutResult(s -> {
                    long id = insertOrder();
                    http.post().uri("/internal/inventory/reserve?orderId={o}&productId=1&qty=1", id).retrieve().toBodilessEntity();
                    if (f) throw new IllegalStateException("寫明細失敗");
                });
            } catch (IllegalStateException e) { failedRemote++; }
        }
        int reservedRemote = jdbc.queryForObject("SELECT reserved FROM inventory WHERE product_id = 1", Integer.class);
        int ordersRemote = jdbc.queryForObject("SELECT COUNT(*) FROM orders", Integer.class);
        Integer orphan = jdbc.queryForObject("""
                SELECT COUNT(*) FROM inventory_ledger l
                 WHERE l.reason = 'RESERVE'
                   AND NOT EXISTS (SELECT 1 FROM orders o WHERE CONCAT('order:', o.id) = l.ref)""", Integer.class);

        System.out.println("\n  ── 交易語意：下單 1,000 筆，其中一部分在「預留之後」失敗 ──");
        System.out.printf("  直接呼叫：失敗 %d 筆 → 訂單 %d 張、reserved = %d   （一致）%n", failedLocal, ordersLocal, reservedLocal);
        System.out.printf("  透過 HTTP：失敗 %d 筆 → 訂單 %d 張、reserved = %d   （多預留了 %d 件）%n",
                failedRemote, ordersRemote, reservedRemote, reservedRemote - ordersRemote);
        System.out.printf("  找不到訂單的預留（孤兒） : %d 筆  ← 這些庫存會被永遠佔住，直到有人寫補償程式%n", orphan);
    }
}
```

**輸出**：

```
═══ 1.2.3 模組呼叫 vs HTTP 呼叫（同一個 JVM、同一台 MySQL）═══
  ── 延遲：查一次可售庫存，各 5,000 次 ──
  直接呼叫 InventoryApi   : p50  0.847 ms   p99  1.164 ms
  透過 HTTP（localhost）  : p50  1.091 ms   p99  2.602 ms

  ── 交易語意：下單 1,000 筆，其中一部分在「預留之後」失敗 ──
  直接呼叫：失敗 55 筆 → 訂單 945 張、reserved = 945   （一致）
  透過 HTTP：失敗 55 筆 → 訂單 945 張、reserved = 1000   （多預留了 55 件）
  找不到訂單的預留（孤兒） : 55 筆  ← 這些庫存會被永遠佔住，直到有人寫補償程式
```

**先看延遲：比你以為的小。**

| | p50 | p99 |
|---|---|---|
| 直接呼叫 | 0.847 ms | 1.164 ms |
| HTTP | 1.091 ms | 2.602 ms |
| **差** | **+0.24 ms** | **+1.44 ms** |

直接呼叫的 0.847 ms 幾乎全是 MySQL 往返（一句 `SELECT`）。HTTP 只多了 0.24 ms ——
localhost 上的 TCP、Tomcat 分派、JSON 序列化加起來，就這麼多。
換到兩台機器之間（同一個機房），通常再多 0.2～1 ms；跨可用區再多 1～2 ms。

很多「要不要拆」的討論卡在延遲上。**這個數字說明延遲通常不是決定性因素** —— 一次下單呼叫三個服務，多 1～3 ms，使用者感覺不到。

**再看交易：這才是真正的代價。**

同樣 1,000 筆下單、同樣 55 筆在預留之後失敗（`Random(1)` 固定）：

- **直接呼叫**：`inventory.reserve()` 跑在呼叫端的交易裡（1.5.2 的 `Propagation.MANDATORY`）。
  訂單寫入失敗 → 整個交易 rollback → **預留也一起 rollback**。945 張訂單、945 件預留，**分毫不差**。
- **HTTP**：遠端的 `reserve` 在**遠端自己的交易**裡，HTTP 回應回來的那一刻就 commit 了。
  本地的訂單寫入失敗 → 本地 rollback → **遠端的預留已經 commit，回不去了**。
  **55 筆預留指向不存在的訂單。** 這 55 件庫存會被永遠佔住（0.2.1 讀法 B 的「永不歸還」）。

在單體裡，這個問題**不存在** —— 你甚至不需要想它。拆成服務之後，這 55 筆需要：

```
一個「預留逾時自動釋放」機制（庫存服務要知道「這筆預留等了太久還沒被確認」）
  ＋ 一個「取消預留」的補償 API
  ＋ 一個在本地失敗時呼叫補償 API 的程式（而補償本身也可能失敗 → 要重試 → 要冪等）
  ＋ 一個對帳程式（抓出補償失敗、重試也失敗的那些）
```

這就是 **Saga 與補償交易** —— [13-distributed-systems/](../13-distributed-systems/) 要花整整一章處理的東西。
而在單體裡，它的全部成本是一行 `@Transactional`。

> 📌 注意這個實驗還**低估**了 HTTP 版的問題。它只模擬了「本地在遠端成功之後失敗」。真實世界還有：
> - **遠端 commit 了，但 HTTP 回應在網路上丟了** → 本地以為失敗、重試 → **預留兩次**（需要冪等）。
> - **遠端處理到一半逾時** → 本地不知道遠端到底有沒有 commit。
> - **遠端服務整個掛了** → 本地要決定「下單失敗」還是「先成立、之後再補預留」。
>
> 每一種都是一個需要設計、實作、測試的新問題。

**這一節要帶走的**：

1. **拆服務的主要代價不是延遲（+0.24 ms），而是失去跨模組的交易（55 筆孤兒）。**
2. **模組邊界 ≠ 服務邊界。** 模組讓你得到「清楚的所有權」和「可以被測試的邊界」，**同時保留一個交易**。
   服務讓你得到「獨立部署」和「獨立擴展」，**代價是那個交易**。
3. **所以要拆，必須有一個「獨立部署」或「獨立擴展」的需求，值得付出失去交易的代價。** 1.3 會用第 00 章的數字檢查本專題有沒有這種需求。

---

## 1.3 為什麼是模組化單體

### 1.3.1 三個選項

| | 單體（大泥球） | **模組化單體** | 微服務 |
|---|---|---|---|
| 部署單位 | 1 個 | **1 個** | N 個 |
| 資料庫 | 1 個，任何程式碼可以碰任何表 | **1 個，每張表有主人**（0.3.4） | 每個服務一個 |
| 模組之間 | 隨便呼叫 | **只透過公開 API**，由測試強制（1.6） | 只透過網路 |
| 跨模組交易 | ✅ 有 | ✅ **有** | ❌ 沒有（Saga、補償） |
| 獨立部署 / 擴展 | ❌ | ❌ | ✅ |
| 本地開發 | 1 個行程 | **1 個行程** | N 個行程 + 服務發現 + … |
| 除錯一個請求 | 一條堆疊 | **一條堆疊** | 分散式追蹤 |
| 「這張表是誰的」 | 沒人知道 | **寫在測試裡** | 寫在網路拓撲裡 |

**模組化單體拿的是左右兩邊的優點**：它有微服務的「清楚所有權」，又保留單體的「一個交易、一個行程、一條堆疊」。
它**放棄**的只有一件事：獨立部署與獨立擴展。

### 1.3.2 本專題需要獨立部署或獨立擴展嗎？

用第 00 章的數字檢查：

| 可能的拆分理由 | 本專題的情況 | 結論 |
|---|---|---|
| 某個模組的**負載**遠高於其他模組，需要單獨擴展 | 0.6.1：一般流量的瞬間尖峰約 250 QPS（下單只有 0.2 張/秒），一台就夠；搶購的瓶頸是**同一列的鎖**（0.11），加機器解決不了，要靠 Redis（第 06 章） | ❌ |
| 某個模組的**資料量**大到一個資料庫放不下 | 0.6.1：三年 31 GB | ❌ |
| 不同模組由**不同團隊**負責，發布節奏互相卡住 | 本專題是一個人（或一個小團隊）的專案 | ❌ |
| 某個模組需要**不同的技術棧**（例如 Python 做推薦） | 0.7：不做推薦、不做搜尋引擎 | ❌ |
| 某個模組的**故障隔離**要求很高（它掛了不能拖垮別人） | 0.6.3：用降級與艙壁處理（熱點下單 503、其他照常），不需要行程隔離 | ❌ |

**五個理由，一個都不成立。** 而 1.2.3 量過了代價：每一個跨服務的寫入，都要用 Saga 換回你本來免費擁有的交易。

> 📌 **這不是說微服務不好。** 這是說「要不要拆」是一個**有數字可以回答的問題**，
> 而本專題的數字說不要。你的專案數字不一樣時，答案也可能不一樣 —— [13-distributed-systems/](../13-distributed-systems/) 的第一章就是這張表的完整版。

### 1.3.3 那為什麼要「模組化」？直接寫單體不就好了？

因為模組邊界**現在**就有價值，跟將來拆不拆無關：

1. **不變量有一個主人。** 1.2.1：庫存帳只能由庫存模組寫，INV-3 才守得住。
2. **改一個模組時，你知道會影響誰。** 1.6.2 的依賴表告訴你：改 `InventoryApi` 會影響 `cart` 與 `ordering`，**不會**影響 `account`、`catalog`、`payment`……
3. **測試可以按模組切。** 第 08 章的整合測試可以只起一個模組需要的東西。
4. **如果有一天真的要拆**，邊界已經畫好、已經被測試守住了。拆的成本從「先花三個月理清誰呼叫誰」變成「把一個模組的 API 換成 HTTP client」—— 以及處理 1.2.3 那 55 筆孤兒。

---

## 1.4 套件結構：先切層，還是先切模組？

### 1.4.1 package-by-layer：大部分教學的寫法

```
com.example.shop/
├── controller/
│   ├── ProductController.java
│   ├── CartController.java
│   ├── OrderController.java
│   ├── PaymentCallbackController.java
│   └── ...（每個模組一個以上）
├── service/
│   ├── ProductService.java
│   ├── InventoryService.java
│   ├── CartService.java
│   ├── OrderService.java
│   └── ...
├── repository/
│   ├── ProductRepository.java
│   ├── InventoryRepository.java
│   ├── InventoryLedgerRepository.java
│   ├── OrderRepository.java
│   └── ...
├── entity/
│   └── ...
└── dto/
    └── ...
```

前面各站的範例大多長這樣，因為它們只有一兩個業務概念。放到本專題的規模，它有三個問題：

**問題一：每個類別都必須是 `public`。**
`OrderService`（在 `service` 套件）要用 `InventoryRepository`（在 `repository` 套件），跨套件 → `InventoryRepository` 必須是 `public` → **任何人都能用它**。
1.2.1 的繞過，在這個結構裡連 `JdbcTemplate` 都不用寫 —— 直接注入 `InventoryRepository` 就行了，**而且看起來完全正常**。

**問題二：一個功能散在五個資料夾。**
「賣家補貨」這個功能要改 `controller/`、`service/`、`repository/`、`dto/`、可能還有 `entity/`。
五個資料夾裡各有十幾個不相干的類別。**你打開 `service/` 資料夾，看到的是 9 個模組的 service 混在一起。**

**問題三：「這張表是誰的」表達不出來。**
`repository/` 底下有 20 個 repository，它們全部平起平坐。沒有任何結構告訴你 `InventoryLedgerRepository` 只能被 `InventoryService` 用。
0.3.4 那張表，**在這個結構裡沒有地方放**。

### 1.4.2 package-by-module：本專題的寫法

```
com.example.shop/
├── ShopApplication.java
├── inventory/                          ← 模組
│   ├── InventoryApi.java               ← 公開：其他模組只能看到這一層
│   ├── ReserveLine.java                ← 公開：API 用的 DTO
│   ├── InsufficientStockException.java ← 公開：API 會丟的例外
│   ├── package-info.java               ← 模組說明：擁有哪些表
│   └── internal/                       ← 私有：實作、資料存取、Web 層
│       └── JdbcInventoryService.java   ← package-private
├── ordering/
│   ├── OrderingApi.java
│   ├── package-info.java
│   └── internal/
│       └── PlaceOrderService.java      ← package-private
├── account/ catalog/ cart/ payment/ notification/ reporting/
│   └── package-info.java               ← 第 01 章先建空殼，後面各章填入
└── shared/
    ├── package-info.java
    ├── config/                          ← ShopProperties、啟動檢查
    └── web/                             ← PingController（第 03 章起：錯誤處理）
```

**每個模組只有兩層**：

| 層 | 放什麼 | 誰可以用 |
|---|---|---|
| **模組根套件**（`inventory/`） | 介面（`InventoryApi`）、DTO（`ReserveLine`）、例外、事件 | **所有模組**（依 1.6.2 的依賴表） |
| **`internal/`** | 實作、Entity、Repository、Controller、MyBatis mapper | **只有自己** |

對照 1.4.1 的三個問題：

1. **`public` 的只有根套件。** `JdbcInventoryService` 是 package-private —— 下一節會看到，別的模組**連編譯都過不了**。
2. **一個功能在一個資料夾。** 「賣家補貨」的所有程式碼都在 `inventory/` 底下。
3. **「這張表是誰的」變成了資料夾結構**：`inventory_ledger` 的存取程式碼只可能出現在 `inventory/internal/`。

> 📌 **Controller 放在哪裡？** 放在 `internal/` 裡（第 03 章起），例如 `catalog/internal/web/ProductController.java`。
> Controller 是 HTTP 的入口，但**不是其他模組的入口** —— 沒有任何其他模組應該呼叫一個 Controller。
> 這跟 1.4.1 的直覺相反：在 package-by-layer 裡 Controller 是「最外層」，在 package-by-module 裡它是某個模組的**內部實作細節**。

#### 動手：建立九個模組的空殼，並把 `PingController` 搬家

從第 00 章結束時的專案出發，先把上面的形狀建出來（`inventory`、`ordering` 裡的類別在 1.5 才寫）。

**① 九個 `package-info.java`**，每個模組的根套件一個：

```java
// src/main/java/com/example/shop/account/package-info.java
/** account 模組。 */
package com.example.shop.account;

// src/main/java/com/example/shop/cart/package-info.java
/** cart 模組。 */
package com.example.shop.cart;

// src/main/java/com/example/shop/catalog/package-info.java
/** catalog 模組。 */
package com.example.shop.catalog;

// src/main/java/com/example/shop/inventory/package-info.java
/**
 * 庫存模組。擁有：inventory、inventory_reservations、inventory_ledger。
 * 對外只提供 {@link com.example.shop.inventory.InventoryApi}；internal 子套件不得被其他模組引用。
 */
package com.example.shop.inventory;

// src/main/java/com/example/shop/notification/package-info.java
/** notification 模組。 */
package com.example.shop.notification;

// src/main/java/com/example/shop/ordering/package-info.java
/** 訂單模組。擁有：orders、order_items、order_status_history、idempotency_keys。 */
package com.example.shop.ordering;

// src/main/java/com/example/shop/payment/package-info.java
/** payment 模組。 */
package com.example.shop.payment;

// src/main/java/com/example/shop/reporting/package-info.java
/** reporting 模組。 */
package com.example.shop.reporting;

// src/main/java/com/example/shop/shared/package-info.java
/** shared 模組。 */
package com.example.shop.shared;
```

這九個檔案**不只是說明文件**。到本章結束時，`account`、`cart`、`catalog`、`notification`、`payment`、`reporting` 六個模組
除了 `package-info` 之外**一個類別都沒有**；而 1.6.2 的規則一（`layeredArchitecture()`）預設要求**每一層都不是空的**，
少建其中任何一個，ArchUnit 會以那一層為空而判定規則一失敗。

**② 把 `PingController` 搬進 `shared.web`**：把第 00 章的 `src/main/java/com/example/shop/PingController.java`
移到 `src/main/java/com/example/shop/shared/web/PingController.java`，第一行改成 `package com.example.shop.shared.web;`，其餘不變；根套件的舊檔刪掉。
`@SpringBootApplication` 的元件掃描涵蓋所有子套件，`/api/ping` 照常回應。根套件從此只剩 `ShopApplication`。

### 1.4.3 編譯器是第一道防線

`JdbcInventoryService` 宣告成 package-private（沒有 `public`）：

```java
@Service
class JdbcInventoryService implements InventoryApi {
```

Spring 可以建立 package-private 類別的 bean（它用反射），`@Transactional` 的 CGLIB 代理也能正常運作（代理類別生成在同一個套件裡）。
**但 Java 編譯器不允許其他套件的程式碼引用它。** 試試看在 `ordering` 裡直接用實作類別：

```java
package com.example.shop.ordering.internal;

import com.example.shop.inventory.internal.JdbcInventoryService;

class SneakyOrderService {
    private final JdbcInventoryService inventory;   // 想直接用實作類別，繞過 InventoryApi

    SneakyOrderService(JdbcInventoryService inventory) { this.inventory = inventory; }
}
```

```
[ERROR] .../ordering/internal/SneakyOrderService.java:[3,43] com.example.shop.inventory.internal.JdbcInventoryService is not public in com.example.shop.inventory.internal; cannot be accessed from outside package
[ERROR] .../ordering/internal/SneakyOrderService.java:[6,19] com.example.shop.inventory.internal.JdbcInventoryService is not public in com.example.shop.inventory.internal; cannot be accessed from outside package
[ERROR] .../ordering/internal/SneakyOrderService.java:[8,24] com.example.shop.inventory.internal.JdbcInventoryService is not public in com.example.shop.inventory.internal; cannot be accessed from outside package
```

**連 `mvn compile` 都過不了。** 這是最便宜、最可靠的防線 —— 不需要任何工具，IDE 在你打字的時候就會畫紅線。
（看完錯誤訊息，把 `SneakyOrderService.java` 刪掉。）

**但它有一個結構性的限制**：Java 的 package-private 是「**同一個套件**」，不是「同一個套件**以及子套件**」。

```
inventory/internal/JdbcInventoryService.java          ← package: ...inventory.internal
inventory/internal/web/InventoryAdminController.java   ← package: ...inventory.internal.web
```

`InventoryAdminController` 在子套件 `internal.web` 裡，**它也看不到 package-private 的 `JdbcInventoryService`**。
一旦模組內部長出子套件（第 03 章之後一定會：`web/`、`persistence/`、`domain/`），模組內部彼此呼叫的類別就**被迫改成 `public`** ——
而一旦是 `public`，**別的模組也看得到了**。

| 模組內部的形狀 | 編譯器能擋住別的模組嗎？ | 代價 |
|---|---|---|
| `internal/` 只有一層，全部 package-private | ✅ 能 | 模組長大後，`internal/` 裡會有幾十個類別擠在一起 |
| `internal/` 有子套件 | ❌ 子套件之間要用的類別必須 `public` → 別人也看得到 | —— |

**這就是本專題還需要 ArchUnit 的原因**（1.6）：編譯器守得住「單層」，ArchUnit 守得住「整棵 `internal/` 子樹」。
本專題的策略是：**能 package-private 就 package-private**（讓編譯器擋），擋不住的由 ArchUnit 擋。

> 📌 **Java Platform Module System（JPMS，`module-info.java`）呢？** 它能做到「只 export 某些套件」，是真正的語言層級封裝。
> 但 JPMS 的單位是 **jar**，不是套件 —— 要用它，每個模組就要是一個獨立的 Maven 模組（一個 jar）。
> 那會讓本專題變成 9 個 Maven 子模組、9 個 `pom.xml`，而且 Spring 的元件掃描、反射、代理在 JPMS 下都需要額外的 `opens` 設定。
> **成本遠大於收益**，所以本專題用「單一 Maven 模組 + 套件慣例 + ArchUnit」。
> 如果你的團隊已經在用多模組 Maven，那「每個業務模組一個 Maven 子模組」也是一個很好的選項 —— 依賴方向會直接由 `pom.xml` 強制。

---

## 1.5 模組之間可以看見什麼

### 1.5.1 三種互動方式

| 方式 | 什麼時候用 | 本專題的例子 | 交易 |
|---|---|---|---|
| **① 同步呼叫對方的 API** | 你**需要結果**，而且這件事要跟你的寫入**一起成功或一起失敗** | `ordering` 呼叫 `InventoryApi.reserve()`：預留失敗，訂單就不能成立 | **同一個交易** |
| **② 發布事件，對方訂閱** | 你**不需要結果**，而且對方做失敗了**不該讓你失敗** | 訂單成立 → `notification` 寄信；寄信失敗不能讓下單失敗 | 對方在**你的交易提交後**，另開交易 |
| **③ 唯讀查詢對方的表** | 只有 `reporting` 可以（0.3.4） | 銷售報表 JOIN `orders`、`order_items`、`products` | —— |

**判斷用 ① 還是 ② 的一個問題**：

> 「如果對方失敗了，我的這個操作應該算成功還是失敗？」
> - 應該算失敗 → ①（預留庫存失敗 → 下單失敗）
> - 應該算成功 → ②（寄信失敗 → 下單仍然成功，信之後補寄）

這個問題的答案**就在 0.5.4 那張副作用表裡**：左欄「同一個交易內」是 ①，右欄「提交後」是 ②。

**本章只實作 ①。** ② 在 1.5.6 先講機制，第 07 章換成 Outbox 才算完成。

### 1.5.2 `InventoryApi`：一個模組的對外介面

```java
package com.example.shop.inventory;

import java.util.List;

/**
 * 庫存模組唯一的對外入口。其他模組只能透過這個介面改變庫存。
 * 每一個會改變數量的方法，都會在同一個交易裡寫一筆 inventory_ledger（INV-3）。
 */
public interface InventoryApi {

    /**
     * 為一張訂單預留庫存。全有或全無：任何一個品項不足就丟例外，呼叫端的交易應該 rollback。
     * 必須在呼叫端既有的交易內呼叫（Propagation.MANDATORY）。
     */
    void reserve(long orderId, List<ReserveLine> lines);

    /** 補貨：onHand 增加，並記一筆 RESTOCK。自己開交易。 */
    void restock(long productId, int quantity, String note);

    /** 批次補貨：一個交易、兩句 batch（UPDATE + ledger INSERT）。給匯入功能用。 */
    void restockBatch(List<RestockLine> lines, String note);

    record RestockLine(long productId, int quantity) {}

    /** 可售庫存 = onHand - reserved。 */
    int available(long productId);
}
```

```java
package com.example.shop.inventory;

public record ReserveLine(long productId, int quantity) {
    public ReserveLine {
        if (quantity <= 0) throw new IllegalArgumentException("quantity must be positive");
    }
}
```

```java
package com.example.shop.inventory;

public class InsufficientStockException extends RuntimeException {
    private final long productId;

    public InsufficientStockException(long productId) {
        super("insufficient stock: product " + productId);
        this.productId = productId;
    }

    public long productId() { return productId; }
}
```

**五個設計決定**：

**① 介面，不是類別。**
其他模組依賴的是 `InventoryApi`，不是 `JdbcInventoryService`。第 04 章會大幅改寫這個實作的內部（預留列、加鎖的順序），
而 `reserve()` 的**呼叫端一行都不用改**。這不是「為了介面而介面」（[05-service/01](../05-service/01-service-design-and-dependency.md) 1.3 討論過那種）：
這裡的介面有一個明確的目的 —— **它是模組邊界本身**。

**② 參數與回傳值只用基本型別與本模組的 DTO。**
`reserve(long orderId, List<ReserveLine> lines)` —— `orderId` 是 `long`，不是 `Order` entity。
庫存模組**不需要知道訂單長什麼樣**，它只需要一個「這筆預留屬於誰」的參考。
如果參數是 `Order`，庫存模組就依賴了訂單模組 —— 而訂單模組已經依賴了庫存模組 —— **循環**（1.6.3 會看到 ArchUnit 怎麼抓它）。

**③ 例外是 API 的一部分。**
`InsufficientStockException` 放在模組根套件、是 `public`、帶著 `productId`。
呼叫端（第 03 章的 Controller）會把它轉成 409 `/problems/insufficient-stock`，並用 `productId` 告訴使用者**哪一個**品項不足（US-ORD-1 AC-5）。

**④ `reserve()` 用 `Propagation.MANDATORY`。**
這是整個介面最重要的一個註解。它的意思是：**「你必須已經在一個交易裡才能呼叫我；如果沒有，我拒絕執行。」**

```
org.springframework.transaction.IllegalTransactionStateException:
  No existing transaction found for transaction marked with propagation 'mandatory'
```

為什麼不用預設的 `REQUIRED`（沒有交易就自己開一個）？因為 `reserve()` **單獨執行是沒有意義的** ——
一筆沒有對應訂單的預留，就是 1.2.3 的孤兒。`MANDATORY` 把「預留必須跟訂單在同一個交易裡」從**文件上的約定**變成**執行期的檢查**。
（[05-service/02](../05-service/02-transaction-management-in-depth.md) 講過七種傳播行為，`MANDATORY` 是其中最少被用、但在模組邊界上最有用的一種。）

反過來，`restock()` 用 `REQUIRED`：補貨**本身就是一個完整的業務動作**，自己開交易是合理的。

**⑤ 每一個改數量的方法都寫 ledger —— 在介面的 Javadoc 裡寫明。**
這是 INV-3 的**承諾**。呼叫端不需要（也不應該）自己寫 ledger。

### 1.5.3 實作：package-private

```java
package com.example.shop.inventory.internal;

import com.example.shop.inventory.InsufficientStockException;
import com.example.shop.inventory.InventoryApi;
import com.example.shop.inventory.ReserveLine;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

import java.util.ArrayList;
import java.util.List;

/**
 * 注意：這個類別是 package-private。其他模組在編譯期就看不到它，只能拿到 InventoryApi。
 * （後面各章會改寫這個實作的內部；呼叫端只看得到 InventoryApi。）
 */
@Service
class JdbcInventoryService implements InventoryApi {

    private final JdbcTemplate jdbc;

    JdbcInventoryService(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    @Override
    @Transactional(propagation = Propagation.MANDATORY)
    public void reserve(long orderId, List<ReserveLine> lines) {
        for (ReserveLine l : lines) {
            int n = jdbc.update("""
                    UPDATE inventory SET reserved = reserved + ?
                     WHERE product_id = ? AND on_hand - reserved >= ?""",
                    l.quantity(), l.productId(), l.quantity());
            if (n == 0) throw new InsufficientStockException(l.productId());
            ledger(l.productId(), 0, l.quantity(), "RESERVE", "order:" + orderId);
        }
    }

    @Override
    @Transactional
    public void restock(long productId, int quantity, String note) {
        if (quantity <= 0) throw new IllegalArgumentException("quantity must be positive");
        jdbc.update("UPDATE inventory SET on_hand = on_hand + ? WHERE product_id = ?", quantity, productId);
        ledger(productId, quantity, 0, "RESTOCK", note);
    }

    @Override
    @Transactional
    public void restockBatch(List<RestockLine> lines, String note) {
        List<Object[]> upd = new ArrayList<>(lines.size()), led = new ArrayList<>(lines.size());
        for (RestockLine l : lines) {
            if (l.quantity() <= 0) throw new IllegalArgumentException("quantity must be positive");
            upd.add(new Object[]{l.quantity(), l.productId()});
            led.add(new Object[]{l.productId(), l.quantity(), 0, "RESTOCK", note});
        }
        jdbc.batchUpdate("UPDATE inventory SET on_hand = on_hand + ? WHERE product_id = ?", upd);
        jdbc.batchUpdate("""
                INSERT INTO inventory_ledger(product_id, delta_on_hand, delta_reserved, reason, ref)
                VALUES (?, ?, ?, ?, ?)""", led);
    }

    @Override
    @Transactional(readOnly = true)
    public int available(long productId) {
        Integer v = jdbc.queryForObject(
                "SELECT on_hand - reserved FROM inventory WHERE product_id = ?", Integer.class, productId);
        return v == null ? 0 : v;
    }

    private void ledger(long productId, int deltaOnHand, int deltaReserved, String reason, String ref) {
        jdbc.update("""
                INSERT INTO inventory_ledger(product_id, delta_on_hand, delta_reserved, reason, ref)
                VALUES (?, ?, ?, ?, ?)""", productId, deltaOnHand, deltaReserved, reason, ref);
    }
}
```

幾個細節：

- **`reserve()` 用條件式 UPDATE**：`WHERE on_hand - reserved >= ?`，影響 0 列就代表不足。這是 0.5.5 那條硬規則的第一次出現，第 04 章會完整分析它為什麼不會超賣。
- **多品項時的「全有或全無」**：第二個品項不足時丟例外，第一個品項已經執行的 UPDATE 和 ledger INSERT 會**跟著呼叫端的交易一起 rollback** —— 這正是 `MANDATORY` 的意義。
- **為什麼是 `JdbcTemplate` 不是 JPA？** 本章還沒有 Entity（第 02 章才有 schema）。本專題之後各章的庫存實作也一直沿用 `JdbcTemplate`；
  第 04 章會大幅改寫這個類別的內部，**`reserve()` 的呼叫端不受影響** —— 那就是一次「介面就是邊界」的實際驗證。

### 1.5.4 `OrderingApi`：在邊界上轉換型別

```java
package com.example.shop.ordering;

import java.util.List;

/** 訂單模組的對外入口。 */
public interface OrderingApi {

    /** 下單：寫訂單並預留庫存，同一個交易。回傳訂單 id。 */
    long placeOrder(long buyerId, List<OrderLine> lines);

    /** 訂單模組自己的 DTO —— 不直接暴露 inventory 的 ReserveLine。 */
    record OrderLine(long productId, int quantity) {}
}
```

```java
package com.example.shop.ordering.internal;

import com.example.shop.inventory.InventoryApi;
import com.example.shop.inventory.ReserveLine;
import com.example.shop.ordering.OrderingApi;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.support.GeneratedKeyHolder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.sql.PreparedStatement;
import java.sql.Statement;
import java.util.List;

/**
 * 第 01 章的簡化版下單：寫訂單 + 呼叫庫存模組預留，同一個交易。
 * 第 04 章會換成完整版（狀態機、冪等、價格快照）。
 */
@Service
class PlaceOrderService implements OrderingApi {

    private final JdbcTemplate jdbc;
    private final InventoryApi inventory;   // ← 只看得到介面

    PlaceOrderService(JdbcTemplate jdbc, InventoryApi inventory) {
        this.jdbc = jdbc;
        this.inventory = inventory;
    }

    @Override
    @Transactional
    public long placeOrder(long buyerId, List<OrderLine> lines) {
        GeneratedKeyHolder key = new GeneratedKeyHolder();
        jdbc.update(con -> {
            PreparedStatement ps = con.prepareStatement(
                    "INSERT INTO orders(buyer_id, status) VALUES (?, 'PENDING_PAYMENT')",
                    Statement.RETURN_GENERATED_KEYS);
            ps.setLong(1, buyerId);
            return ps;
        }, key);
        long orderId = key.getKey().longValue();
        List<ReserveLine> reserve = lines.stream()
                .map(l -> new ReserveLine(l.productId(), l.quantity()))   // 在邊界上轉換，不讓對方的型別外洩
                .toList();
        inventory.reserve(orderId, reserve);     // 同一個交易：任何一個品項不足，訂單一起 rollback
        return orderId;
    }
}
```

**為什麼 `OrderLine` 和 `ReserveLine` 長得一模一樣，還要分成兩個？**

因為它們**現在**長得一樣，但它們屬於不同的模組、會為了不同的理由改變：

- 第 04 章，`OrderLine` 會多一個 `clientUnitPrice`（US-ORD-1 AC-6：客戶端看到的價格）。**庫存模組完全不在乎價格。**
- 第 06 章，`ReserveLine` 可能會多一個 `hot` 旗標（熱點商品走 Redis 路徑）。**訂單的呼叫端不該知道這件事。**

如果 `OrderingApi` 直接用 `ReserveLine`，那麼每一個 `OrderingApi` 的呼叫端（第 03 章的 Controller、測試）都**間接依賴了庫存模組**，
庫存模組改一個 DTO，訂單的呼叫端就要跟著重新編譯、可能跟著改。
**在邊界上多寫一行 `map`，換來的是「兩個模組可以各自演化」。**

> 📌 這條規則有一個例外：**真正共用的值型別**（例如 `Money`、`ProductId`）可以放在 `shared`，讓所有模組共用。
> 判斷標準是「它有沒有任何一個模組專屬的語意」。`Money` 在每個模組的意思都一樣；`ReserveLine` 只在庫存模組有意義。

### 1.5.5 跨模組只用 id，不用 JPA 關聯

第 02 章建 Entity 時，你會很想寫這個：

```java
// ❌ ordering 模組的 Entity
@Entity
class OrderItem {
    @ManyToOne(fetch = FetchType.LAZY)
    private Product product;          // ← catalog 模組的 Entity
    private int quantity;
}
```

本專題的規則是：**跨模組只存 id**。

```java
// ✅
@Entity
class OrderItem {
    private long productId;           // ← 只是一個數字
    private String productName;       // ← 下單當下的快照
    private BigDecimal unitPrice;     // ← 下單當下的快照（0.3.5「價格快照」）
    private int quantity;
}
```

**四個理由**：

| 理由 | 說明 |
|---|---|
| **所有權** | `@ManyToOne Product` 讓訂單模組**拿到了一個 catalog 的 Entity**，可以讀它的任何欄位、呼叫它的任何方法、甚至改它（JPA 的髒檢查會在 commit 時寫回去）。這是 1.2.1 的繞過，只是換成了 JPA 的形式 |
| **語意** | 訂單要的不是「這個商品**現在**的樣子」，而是「下單**那一刻**的樣子」（價格快照）。`@ManyToOne` 給你的是現在的樣子 —— 賣家改名、改價，一年前的訂單明細跟著變 |
| **效能** | [08-jpa-mybatis/04](../08-jpa-mybatis/04-lazy-loading-and-n-plus-1.md) 的 N+1：訂單列表 20 筆 × 3 個品項 = 60 次 `SELECT products`。只存 id 與快照，列表頁**完全不需要**碰 `products` 表 |
| **將來** | 如果有一天 catalog 真的被拆出去，`@ManyToOne` 會讓你改 Entity、改所有查詢、改所有 JPQL；只存 id 的話，**什麼都不用改** |

同一條規則也適用於外鍵：**第 02 章的 schema 裡，`order_items.product_id` 不會有指向 `products` 的 `FOREIGN KEY`。**
這聽起來很反直覺（外鍵不是保護資料完整性的嗎？），第 02 章會完整討論這個取捨 —— 簡短的版本是：
**跨模組的外鍵，是資料庫層級的跨模組依賴**，它會讓 catalog 模組「刪不掉一個商品」的原因藏在訂單模組的表裡。
（本專題的商品本來就不硬刪（US-PRD-4 AC-4），所以這個外鍵本來就擋不到任何東西。）

### 1.5.6 事件：先講機制，第 07 章才算完成

「訂單成立 → 寄通知」是 1.5.1 的 ② —— 下單不需要等寄信、寄信失敗不能讓下單失敗。
Spring 內建的機制是 `ApplicationEventPublisher` + `@TransactionalEventListener`：

```java
// ordering 模組：發布事件（事件類別放在 ordering 的根套件，是公開 API 的一部分）
public record OrderPlaced(long orderId, long buyerId, Instant at) {}

@Transactional
public long placeOrder(...) {
    // ... 寫訂單、預留庫存
    events.publishEvent(new OrderPlaced(orderId, buyerId, Instant.now()));
    return orderId;
}

// notification 模組：訂閱
@TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
void on(OrderPlaced e) { ... 寄信 ... }
```

注意依賴方向：**`notification` 依賴 `ordering`**（它要知道 `OrderPlaced` 長什麼樣），**`ordering` 不依賴 `notification`**。
訂單模組只管「發生了什麼事」，不管「誰在乎」。這讓 1.6.2 的依賴表裡，`ordering` 不需要出現 `notification`。

> ⚠️ **這個機制有一個洞**，[11-messaging/02](../11-messaging/02-outbox-and-transactional-consistency.md) 實測過：
> `AFTER_COMMIT` 只保證「提交之後才執行」，**不保證一定會執行**。交易提交完、監聽器執行前被 `kill -9` —— 事件就消失了，而且沒有任何紀錄。
> 這就是驗收 Q9。**第 07 章會把「發布事件」換成「在同一個交易裡寫一筆 Outbox」**，
> 而 `ordering` 這一側的程式碼幾乎不變 —— 這也是為什麼現在就要讓模組之間**只透過事件類別**溝通。

> 📌 那 1.6.2 依賴表裡為什麼 `notification` 只能用 `shared`、不能用 `ordering`？
> 因為**本章還沒有事件**。第 07 章加入事件時，依賴表會新增 `notification → ordering`（只能用 `ordering` 根套件的事件類別），
> 那一行改動本身就是一次「架構變更」，會出現在 code review 裡 —— **這正是把依賴表寫成測試的好處**。

### 1.5.7 `shared`：不是垃圾桶

每個模組化專案都會有一個 `shared`（或 `common`、`core`），而它最常見的結局是**變成第十個、最大的模組**，什麼都往裡面放。
本專題對 `shared` 的規則：

| 規則 | 怎麼強制 |
|---|---|
| **`shared` 不依賴任何業務模組** | ArchUnit 規則一：`whereLayer("shared").mayNotAccessAnyLayer()` |
| 只放**技術性的**、**所有模組都需要的**東西：設定、Web 基礎設施（錯誤處理、traceId）、Outbox、稽核、共用值型別（`Money`） | code review |
| **不放任何業務邏輯**。「兩個模組都需要計算運費」不是把運費邏輯放進 `shared` 的理由 —— 那代表運費是**第十個模組**，或者屬於其中一個模組 | code review |

> 📌 一個簡單的檢查：`shared` 裡的任何一個類別，如果你**說得出它屬於哪一個業務模組**，它就不該在 `shared` 裡。

---

## 1.6 讓邊界破不了

### 1.6.1 四道防線

「模組邊界」如果只寫在文件裡，六個月後一定會被打破 —— 不是因為有人故意，而是因為**打破它永遠比遵守它快**（1.2.1：快 52 倍）。
所以每一條邊界規則都要有一個**會自動失敗的東西**守著：

| 防線 | 擋什麼 | 什麼時候擋 | 擋不住什麼 |
|---|---|---|---|
| **① 編譯器**（package-private） | 別的模組引用 `internal` 裡的非 public 類別 | 打字的時候（IDE）/ `mvn compile` | `internal` 子套件裡被迫 `public` 的類別（1.4.3） |
| **② ArchUnit**（`ModuleBoundaryTest`） | 違反依賴表、碰別人的 `internal`、循環、broker 外洩、資料存取外洩 | `mvn test` | **SQL 字串**、反射 |
| **③ 表歸屬測試**（`TableOwnershipTest`） | SQL 裡寫了別的模組的表 | `mvn test` | 動態組出來的表名 |
| **④ 對帳**（INV-2、INV-3，第 07 章） | 以上都漏掉之後，資料上的不一致 | 正式環境，每小時 | ——（它是最後一道網） |

**越前面的防線越便宜、越早發現**。①在你按下存檔之前就擋住了；④要等到資料已經錯了一小時。
設計的原則是：**讓每一種違規，都在能擋住它的最前面那一道防線被擋住。**

### 1.6.2 `ModuleBoundaryTest`：把 0.3.4 寫成 6 條規則

先加依賴（測試範圍）：

```xml
<dependency>
  <groupId>com.tngtech.archunit</groupId>
  <artifactId>archunit-junit5</artifactId>
  <version>1.3.0</version>
  <scope>test</scope>
</dependency>
```

```java
package com.example.shop.architecture;

import com.tngtech.archunit.core.importer.ImportOption;
import com.tngtech.archunit.junit.AnalyzeClasses;
import com.tngtech.archunit.junit.ArchTest;
import com.tngtech.archunit.lang.ArchRule;

import static com.tngtech.archunit.lang.syntax.ArchRuleDefinition.classes;
import static com.tngtech.archunit.lang.syntax.ArchRuleDefinition.noClasses;
import static com.tngtech.archunit.library.Architectures.layeredArchitecture;
import static com.tngtech.archunit.library.dependencies.SlicesRuleDefinition.slices;

/**
 * 0.3.4 的模組表，寫成測試。任何一條被違反，mvn test 就紅。
 */
@AnalyzeClasses(packages = "com.example.shop", importOptions = ImportOption.DoNotIncludeTests.class)
class ModuleBoundaryTest {

    /** 規則一：誰可以呼叫誰 —— 直接對應 0.3.4 的「會呼叫誰」那一欄 */
    @ArchTest
    static final ArchRule module_dependencies_follow_the_table = layeredArchitecture()
            .consideringOnlyDependenciesInLayers()
            .layer("account").definedBy("com.example.shop.account..")
            .layer("catalog").definedBy("com.example.shop.catalog..")
            .layer("inventory").definedBy("com.example.shop.inventory..")
            .layer("cart").definedBy("com.example.shop.cart..")
            .layer("ordering").definedBy("com.example.shop.ordering..")
            .layer("payment").definedBy("com.example.shop.payment..")
            .layer("notification").definedBy("com.example.shop.notification..")
            .layer("reporting").definedBy("com.example.shop.reporting..")
            .layer("shared").definedBy("com.example.shop.shared..")
            .whereLayer("account").mayOnlyAccessLayers("shared")
            .whereLayer("catalog").mayOnlyAccessLayers("shared")
            .whereLayer("inventory").mayOnlyAccessLayers("shared")
            .whereLayer("cart").mayOnlyAccessLayers("catalog", "inventory", "shared")
            .whereLayer("ordering").mayOnlyAccessLayers("cart", "catalog", "inventory", "payment", "shared")
            .whereLayer("payment").mayOnlyAccessLayers("shared")
            .whereLayer("notification").mayOnlyAccessLayers("shared")
            .whereLayer("reporting").mayOnlyAccessLayers("shared")
            .whereLayer("shared").mayNotAccessAnyLayer();

    /** 規則二：別的模組不能碰你的 internal —— 就算那個類別是 public */
    @ArchTest
    static final ArchRule internals_are_private_to_their_module = classes()
            .that().resideInAPackage("com.example.shop..")
            .should(new NotTouchOtherModulesInternals());

    /** 規則三：模組的公開 API（根套件）不能把 internal 型別露出去 */
    @ArchTest
    static final ArchRule api_does_not_leak_internals = noClasses()
            .that().resideInAPackage("com.example.shop.(*)")
            .should().dependOnClassesThat().resideInAPackage("..internal..")
            .as("模組根套件（公開 API）不得依賴 internal");

    /** 規則四：模組之間不能有循環 */
    @ArchTest
    static final ArchRule no_cycles_between_modules = slices()
            .matching("com.example.shop.(*)..")
            .should().beFreeOfCycles();

    /** 規則五（驗收 Q11）：broker 相關程式碼只能出現在 shared.messaging */
    @ArchTest
    static final ArchRule broker_is_isolated = noClasses()
            .that().resideOutsideOfPackage("com.example.shop.shared.messaging..")
            .should().dependOnClassesThat().resideInAnyPackage("org.springframework.amqp..", "com.rabbitmq..")
            .as("只有 shared.messaging 可以直接使用 RabbitMQ");

    /** 規則六：JDBC / JPA 只能在 internal 裡 */
    @ArchTest
    static final ArchRule persistence_only_in_internal = noClasses()
            .that().resideOutsideOfPackage("..internal..")
            .should().dependOnClassesThat().resideInAnyPackage("org.springframework.jdbc..", "jakarta.persistence..")
            .as("資料存取只能出現在模組的 internal 套件");
}
```

規則二需要同時知道「呼叫端在哪個模組」和「被呼叫端在哪個模組」，ArchUnit 的流暢 API 表達不了，所以自己寫一個 `ArchCondition`：

```java
package com.example.shop.architecture;

import com.tngtech.archunit.core.domain.Dependency;
import com.tngtech.archunit.core.domain.JavaClass;
import com.tngtech.archunit.lang.ArchCondition;
import com.tngtech.archunit.lang.ConditionEvents;
import com.tngtech.archunit.lang.SimpleConditionEvent;

import java.util.Optional;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** 呼叫端所在模組 ≠ 被呼叫端所在模組，且被呼叫端在 internal 裡 → 違規 */
class NotTouchOtherModulesInternals extends ArchCondition<JavaClass> {

    private static final Pattern MODULE = Pattern.compile("com\\.example\\.shop\\.([a-z]+)(\\..*)?");
    private static final Pattern INTERNAL = Pattern.compile("com\\.example\\.shop\\.([a-z]+)\\.internal(\\..*)?");

    NotTouchOtherModulesInternals() { super("不依賴其他模組的 internal 套件"); }

    static Optional<String> moduleOf(String pkg) {
        Matcher m = MODULE.matcher(pkg);
        return m.matches() ? Optional.of(m.group(1)) : Optional.empty();
    }

    @Override
    public void check(JavaClass clazz, ConditionEvents events) {
        String caller = moduleOf(clazz.getPackageName()).orElse("?");
        for (Dependency d : clazz.getDirectDependenciesFromSelf()) {
            Matcher m = INTERNAL.matcher(d.getTargetClass().getPackageName());
            if (m.matches() && !m.group(1).equals(caller)) {
                events.add(SimpleConditionEvent.violated(d,
                        "[%s → %s.internal] %s".formatted(caller, m.group(1), d.getDescription())));
            }
        }
    }
}
```

**逐條看規則在守什麼**：

| 規則 | 守的是 | 對應 |
|---|---|---|
| 一 依賴表 | 0.3.4「會呼叫誰」那一欄。**依賴方向是架構決策**，改它要改這個測試 —— 會出現在 code review 裡 | 0.3.4 |
| 二 不碰別人的 `internal` | 1.4.3 編譯器擋不住的那一半（`internal` 子套件裡被迫 `public` 的類別） | 1.4.3 |
| 三 API 不外洩 `internal` | 根套件的介面、DTO **不能**在簽名裡出現 `internal` 的型別。否則呼叫端雖然沒 import，卻間接依賴了實作 | 1.5.2 ② |
| 四 無循環 | 規則一只看「允許的方向」，規則四看「整體有沒有環」。兩者重疊但錯誤訊息不同 —— 循環的訊息會把整個環印出來 | 1.5.2 ② |
| 五 broker 隔離 | 驗收 Q11。第 07 章才有 RabbitMQ 程式碼，**現在先把規則立好** | 0.9.2 ③ |
| 六 資料存取只在 `internal` | `JdbcTemplate`、JPA 註解不能出現在 API 套件或 `shared` 的非 internal 部分 | 1.4.2 |

> 📌 **為什麼用 `layeredArchitecture` 表達模組依賴？** 它原本是給「Controller → Service → Repository」這種分層用的，
> 但它的核心能力是「**每一層只能存取哪些層**」—— 把「層」換成「模組」，它就是一張依賴白名單。
> `consideringOnlyDependenciesInLayers()` 讓它只看專案內部的依賴，忽略 Spring、JDK 等外部類別。

跑一次：

```bash
mvn test -Dtest=ModuleBoundaryTest
```

```
[INFO] Tests run: 6, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.525 s -- in com.example.shop.architecture.ModuleBoundaryTest
```

**6 條規則、0.5 秒。** 現在的程式碼乾淨，所以全綠。接下來故意弄髒它。

### 1.6.3 實測：四種違規

**違規一：`internal` 裡有一個 `public` 類別被別的模組用了**

某天有人為了「方便」，在庫存模組的 `internal` 裡加了一個 `public` record，訂單模組拿去用：

```java
package com.example.shop.inventory.internal;

/** 某天有人為了「方便」把它改成 public */
public record InventoryRow(long productId, int onHand, int reserved) {}
```

```java
package com.example.shop.ordering.internal;

import com.example.shop.inventory.internal.InventoryRow;
import org.springframework.stereotype.Service;

@Service
class OrderSummaryService {
    String describe(InventoryRow row) {                       // ← 編譯會過
        return row.productId() + " 剩 " + (row.onHand() - row.reserved());
    }
}
```

`mvn compile` —— **過了**（`InventoryRow` 是 `public`）。`mvn test`：

```
[ERROR] Tests run: 6, Failures: 1, Errors: 0, Skipped: 0, Time elapsed: 0.576 s <<< FAILURE! -- in com.example.shop.architecture.ModuleBoundaryTest
[ERROR] ModuleBoundaryTest.internals_are_private_to_their_module -- Time elapsed: 0.002 s <<< FAILURE!
Architecture Violation [Priority: MEDIUM] - Rule 'classes that reside in a package 'com.example.shop..' should 不依賴其他模組的 internal 套件' was violated (4 times):
[ordering → inventory.internal] Method <com.example.shop.ordering.internal.OrderSummaryService.describe(com.example.shop.inventory.internal.InventoryRow)> calls method <com.example.shop.inventory.internal.InventoryRow.onHand()> in (OrderSummaryService.java:9)
[ordering → inventory.internal] Method <com.example.shop.ordering.internal.OrderSummaryService.describe(com.example.shop.inventory.internal.InventoryRow)> calls method <com.example.shop.inventory.internal.InventoryRow.productId()> in (OrderSummaryService.java:9)
[ordering → inventory.internal] Method <com.example.shop.ordering.internal.OrderSummaryService.describe(com.example.shop.inventory.internal.InventoryRow)> calls method <com.example.shop.inventory.internal.InventoryRow.reserved()> in (OrderSummaryService.java:9)
[ordering → inventory.internal] Method <com.example.shop.ordering.internal.OrderSummaryService.describe(com.example.shop.inventory.internal.InventoryRow)> has parameter of type <com.example.shop.inventory.internal.InventoryRow> in (OrderSummaryService.java:0)
```

**編譯器放行的，ArchUnit 抓住了。** 注意錯誤訊息開頭的 `[ordering → inventory.internal]` —— 這是 `NotTouchOtherModulesInternals` 自己加的前綴，
讓你**不用讀完整個方法簽名**就知道是哪兩個模組之間出了問題。每一筆都帶著檔名和行號。

看完輸出，把 `InventoryRow` 與 `OrderSummaryService` 刪掉（1.6.5 的 Modulith 對照會請你再放回來一次）。

**違規二：反向依賴 + 循環**

產品經理：「商品頁要顯示『已售出 N 件』。」於是商品模組呼叫了訂單模組。
同時，訂單模組本來就需要查商品目前的價格（US-ORD-1 AC-6）：

```java
package com.example.shop.catalog;

import java.math.BigDecimal;

public interface CatalogApi {
    BigDecimal currentPrice(long productId);
}
```

```java
package com.example.shop.ordering.internal;

import com.example.shop.catalog.CatalogApi;
import org.springframework.stereotype.Component;

@Component
class PriceCheck {                                   // ordering → catalog：合法（表上有）
    private final CatalogApi catalog;
    PriceCheck(CatalogApi catalog) { this.catalog = catalog; }
}
```

```java
package com.example.shop.catalog.internal;

import com.example.shop.ordering.OrderingApi;
import org.springframework.stereotype.Component;

/** 產品經理：「商品頁要顯示『已售出 N 件』」——於是 catalog 呼叫了 ordering */
@Component
class SoldCountBadge {
    private final OrderingApi ordering;
    SoldCountBadge(OrderingApi ordering) { this.ordering = ordering; }
}
```

兩個類別都只用了對方的**公開 API**（`CatalogApi`、`OrderingApi`），規則二不會抓。但：

```
[ERROR] Failures:
[ERROR]   Architecture Violation [Priority: MEDIUM] - Rule 'Layered architecture considering only dependencies in layers, consisting of
layer 'account' ('com.example.shop.account..')
...
where layer 'catalog' may only access layers ['shared']
...
where layer 'shared' may not access any layer' was violated (2 times):
Constructor <com.example.shop.catalog.internal.SoldCountBadge.<init>(com.example.shop.ordering.OrderingApi)> has parameter of type <com.example.shop.ordering.OrderingApi> in (SoldCountBadge.java:0)
Field <com.example.shop.catalog.internal.SoldCountBadge.ordering> has type <com.example.shop.ordering.OrderingApi> in (SoldCountBadge.java:0)
[ERROR]   Architecture Violation [Priority: MEDIUM] - Rule 'slices matching 'com.example.shop.(*)..' should be free of cycles' was violated (1 times):
Cycle detected: Slice catalog ->
                Slice ordering ->
                Slice catalog
  1. Dependencies of Slice catalog
    - Constructor <com.example.shop.catalog.internal.SoldCountBadge.<init>(com.example.shop.ordering.OrderingApi)> has parameter of type <com.example.shop.ordering.OrderingApi> in (SoldCountBadge.java:0)
    - Field <com.example.shop.catalog.internal.SoldCountBadge.ordering> has type <com.example.shop.ordering.OrderingApi> in (SoldCountBadge.java:0)
  2. Dependencies of Slice ordering
```

（中間重複的層定義省略。）

**兩條規則同時紅**：規則一說「catalog 只能用 shared」，規則四把整個環畫出來 `catalog → ordering → catalog`。

**那「已售出 N 件」這個需求怎麼辦？** 規則不是在說「不能做」，是在說「**不能這樣做**」。三個合法的選項：

| 做法 | 依賴方向 | 取捨 |
|---|---|---|
| 由 `reporting` 提供（它可以唯讀查 `orders`） | 前端分別呼叫 `catalog` 與 `reporting` | 最簡單；「已售出」本來就是統計數字 |
| `ordering` 發 `OrderShipped` 事件，`catalog` 訂閱並維護自己的 `sold_count` 欄位 | `catalog → ordering`（只依賴事件類別），**依賴表要改** | 最快（商品頁不用 JOIN），但多一個要保持一致的副本 |
| 由 Controller 層組合兩個模組的結果 | 組合的地方依賴兩者 | 要決定「組合」這個程式碼屬於哪個模組 |

本專題選第一個 —— 它**不需要改依賴表**。第二個是第 07 章事件驅動的典型用法，如果選它，**要先改規則一的依賴表，而那個改動會在 code review 被看見**。

看完輸出，把 `CatalogApi`、`PriceCheck`、`SoldCountBadge` 刪掉。尤其 `CatalogApi` 沒有任何實作 ——
留著的話，`@Component` 的 `PriceCheck` 注入不到它，每一個 `@SpringBootTest`（B1、B3）都會啟動失敗。

**違規三：1.2.1 的繞過 —— ArchUnit 全綠**

把 1.2.1 的「批次匯入」放進商品模組：

```java
package com.example.shop.catalog.internal;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;

/** 1.2.1 的那段「反正只是加數字」 */
@Component
class BulkRestockImporter {
    private final JdbcTemplate jdbc;
    BulkRestockImporter(JdbcTemplate jdbc) { this.jdbc = jdbc; }

    @Transactional
    void importCsv(List<Object[]> rows) {
        jdbc.batchUpdate("UPDATE inventory SET on_hand = on_hand + ? WHERE product_id = ?", rows);
    }
}
```

```
[INFO] Tests run: 6, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.586 s -- in com.example.shop.architecture.ModuleBoundaryTest
```

**6 條規則全部通過。** 為什麼？

- 規則一：`BulkRestockImporter` 沒有依賴任何 `inventory` 的類別 —— 它依賴的是 `JdbcTemplate`（外部類別，`consideringOnlyDependenciesInLayers` 不看）。
- 規則二：沒有碰 `inventory.internal`。
- 規則六：`JdbcTemplate` 在 `catalog.internal` 裡使用 —— 合法，每個模組都可以在自己的 `internal` 裡用 JDBC。

**ArchUnit 分析的是位元碼裡的類別依賴。`"UPDATE inventory ..."` 是一個字串常數 —— 它不是依賴。**
這正是 1.6.1 表格裡「②擋不住：SQL 字串」那一格。下一節補上它。

**違規四：規則「還沒有東西可以檢查」**

規則五（broker 隔離）寫成「**不在** `shared.messaging` 的類別，**不能**依賴 RabbitMQ」—— 這是一條**否定句**，現在所有類別都滿足它。
如果寫成**肯定句**呢？例如「`shared.messaging` 裡的類別，名稱必須以 `Publisher` 或 `Listener` 結尾」：

```java
package com.example.shop.architecture;

import com.tngtech.archunit.core.importer.ImportOption;
import com.tngtech.archunit.junit.AnalyzeClasses;
import com.tngtech.archunit.junit.ArchTest;
import com.tngtech.archunit.lang.ArchRule;

import static com.tngtech.archunit.lang.syntax.ArchRuleDefinition.classes;

/** 1.6.3 違規四的示範用類別。看完輸出就刪掉，不要併進 ModuleBoundaryTest。 */
@AnalyzeClasses(packages = "com.example.shop", importOptions = ImportOption.DoNotIncludeTests.class)
class EmptyShouldDemoTest {

    @ArchTest
    static final ArchRule messaging_classes_are_adapters = classes()
            .that().resideInAPackage("com.example.shop.shared.messaging..")
            .should().haveSimpleNameEndingWith("Publisher")
            .orShould().haveSimpleNameEndingWith("Listener");
}
```

```
java.lang.AssertionError: Rule 'classes that reside in a package 'com.example.shop.shared.messaging..' should have simple name ending with 'Publisher' or should have simple name ending with 'Listener'' failed to check any classes. This means either that no classes have been passed to the rule at all, or that no classes passed to the rule matched the `that()` clause. To allow rules being evaluated without checking any classes you can either use `ArchRule.allowEmptyShould(true)` on a single rule or set the configuration property `archRule.failOnEmptyShould = false` to change the behavior globally.
```

`shared.messaging` 套件**還不存在**（第 07 章才有），`that()` 選不到任何類別 —— ArchUnit 1.x **預設把「什麼都沒檢查到」當成失敗**。

這是一個**好的預設**：它防止你寫了一條規則、打錯了套件名、然後這條規則**永遠綠燈、從來沒有檢查過任何東西**。
對「現在還沒有、以後會有」的規則，明確加上 `.allowEmptyShould(true)`：

```java
            .orShould().haveSimpleNameEndingWith("Listener")
            .allowEmptyShould(true);
```

```
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.531 s -- in com.example.shop.architecture.EmptyShouldDemoTest
```

> ⚠️ **不要**用全域的 `archRule.failOnEmptyShould = false`。那會讓所有規則的打錯字都變成永遠綠燈 —— 就像 1.2.2 的 `timeot`。
> **逐條允許**，並在第 07 章 `shared.messaging` 出現之後，**把 `allowEmptyShould(true)` 拿掉**。

示範完把 `EmptyShouldDemoTest.java` 刪掉 —— 本專題的正式規則裡沒有這一條（規則五是否定句，現在就有類別可以檢查）。

### 1.6.4 `TableOwnershipTest`：ArchUnit 看不到的那一塊

1.6.3 違規三證明了：**表的所有權是用 SQL 字串表達的，而 ArchUnit 不讀字串。**
所以寫一個直接讀原始碼的測試 —— 它很粗糙（正規表示式），但它守住的是 1.2.1 那 10,000 件帳外庫存：

```java
package com.example.shop.architecture;

import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.*;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * ArchUnit 看得到 import，看不到 SQL 字串。這個測試補上那一塊：
 * 掃描 src/main 底下每一個 .java 與 mapper .xml，找出 SQL 裡提到的表，
 * 對照 0.3.4 的「資料歸屬」—— 寫入別人的表一律違規；讀取別人的表只有 reporting 可以。
 */
class TableOwnershipTest {

    /** 0.3.4：每張表只屬於一個模組 */
    static final Map<String, String> OWNER = Map.ofEntries(
            Map.entry("users", "account"), Map.entry("user_roles", "account"), Map.entry("refresh_tokens", "account"),
            Map.entry("products", "catalog"), Map.entry("categories", "catalog"),
            Map.entry("inventory", "inventory"), Map.entry("inventory_reservations", "inventory"), Map.entry("inventory_ledger", "inventory"),
            Map.entry("cart_items", "cart"),
            Map.entry("orders", "ordering"), Map.entry("order_items", "ordering"),
            Map.entry("order_status_history", "ordering"), Map.entry("idempotency_keys", "ordering"),
            Map.entry("payments", "payment"), Map.entry("refunds", "payment"),
            Map.entry("notifications", "notification"),
            Map.entry("outbox_events", "shared"), Map.entry("processed_messages", "shared"), Map.entry("audit_logs", "shared"));

    static final Pattern WRITE = Pattern.compile("(?i)\\b(?:INSERT\\s+INTO|UPDATE|DELETE\\s+FROM)\\s+`?(\\w+)`?");
    static final Pattern READ = Pattern.compile("(?i)\\b(?:FROM|JOIN)\\s+`?(\\w+)`?");
    static final Pattern MODULE = Pattern.compile("com[/\\\\]example[/\\\\]shop[/\\\\]([a-z]+)[/\\\\]");

    @Test
    void modulesOnlyTouchTheirOwnTables() throws IOException {
        List<String> violations = new ArrayList<>();
        int files = 0;
        try (Stream<Path> paths = Files.walk(Path.of("src/main"))) {
            for (Path p : paths.filter(f -> f.toString().endsWith(".java") || f.toString().endsWith(".xml")).toList()) {
                Matcher mm = MODULE.matcher(p.toString());
                if (!mm.find()) continue;
                String module = mm.group(1);
                files++;
                List<String> lines = Files.readAllLines(p);
                for (int i = 0; i < lines.size(); i++) {
                    check(WRITE, "寫入", module, p, i, lines.get(i), violations, false);
                    check(READ, "讀取", module, p, i, lines.get(i), violations, true);
                }
            }
        }
        System.out.printf("掃描 %d 個檔案%n", files);
        violations.forEach(v -> System.out.println("  ✗ " + v));
        assertThat(violations).as("模組只能存取自己擁有的表（reporting 例外：可唯讀）").isEmpty();
    }

    static void check(Pattern pattern, String verb, String module, Path file, int lineNo, String line,
                      List<String> out, boolean readOnly) {
        Matcher m = pattern.matcher(line);
        while (m.find()) {
            String table = m.group(1).toLowerCase(Locale.ROOT);
            String owner = OWNER.get(table);
            if (owner == null || owner.equals(module)) continue;
            if (readOnly && module.equals("reporting")) continue;
            out.add("%s 模組%s了 %s 模組的表 `%s`（%s:%d）".formatted(module, verb, owner, table, file.getFileName(), lineNo + 1));
        }
    }
}
```

同時放進違規三的 `BulkRestockImporter`，以及一個**合法的**跨模組讀取（`reporting` 查 `orders`）：

```java
package com.example.shop.reporting.internal;

class SalesReportQuery {
    static final String DAILY = """
            SELECT DATE(o.created_at), COUNT(*) FROM orders o
              JOIN order_items i ON i.order_id = o.id GROUP BY DATE(o.created_at)""";
}
```

```bash
mvn test -Dtest='TableOwnershipTest,ModuleBoundaryTest'
```

```
掃描 20 個檔案
  ✗ catalog 模組寫入了 inventory 模組的表 `inventory`（BulkRestockImporter.java:17）
[ERROR] Tests run: 1, Failures: 1, Errors: 0, Skipped: 0, Time elapsed: 0.054 s <<< FAILURE! -- in com.example.shop.architecture.TableOwnershipTest
[INFO] Tests run: 6, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.586 s -- in com.example.shop.architecture.ModuleBoundaryTest
[ERROR] Tests run: 7, Failures: 1, Errors: 0, Skipped: 0
```

**同一份程式碼：ArchUnit 6 條全綠，表歸屬測試抓到了。** 而 `reporting` 讀 `orders`、`order_items` 沒有被報 —— 它是 0.3.4 允許的例外。

看完輸出，把 `BulkRestockImporter` 與 `SalesReportQuery` 都刪掉（後者雖然合法，但它只是這個示範的對照組）。

**這個測試的限制**（誠實列出來）：

| 限制 | 例子 | 本專題的處理 |
|---|---|---|
| 動態組出來的表名 | `"UPDATE " + table + " SET ..."` | 禁止動態表名（code review）；MyBatis 的 `${}` 依 0.6.5 禁用（第 08 章用測試掃描 mapper 強制） |
| JPA 的表名在 `@Table` 註解裡，不在 SQL 裡 | `@Entity @Table(name = "inventory")` 放在 `catalog` 裡 | 第 02 章加一條 ArchUnit 規則：`@Table(name)` 的值要對照同一張 `OWNER` 表 |
| JPQL 用的是 Entity 名，不是表名 | `UPDATE InventoryEntity e SET ...` | Entity 本身在 `internal` 裡，規則二已經擋住別的模組引用它 |
| 誤判 | 註解或日誌字串裡剛好有 `FROM orders` | 可接受 —— 它會讓你多看一眼，不會讓錯誤溜過去 |

> 📌 **更強的做法是資料庫層級的隔離**：每個模組一個 MySQL 使用者，只對自己的表有 `INSERT` / `UPDATE` / `DELETE` 權限。
> 那樣連動態 SQL 都擋得住，但代價是**每個模組一個連線池**，而且 1.2.3 那個「跨模組同一個交易」就沒了（不同使用者 = 不同連線 = 不同交易）。
> 本專題只在一個地方用資料庫權限：INV-5（`inventory_ledger` 不可 `UPDATE` / `DELETE`），第 09 章設定。

### 1.6.5 對照組：Spring Modulith

Spring 官方有一個專門做這件事的專案：**Spring Modulith**。它的思路跟 ArchUnit 手寫規則相反 —— **用慣例推導模組，不用你寫規則**：

- `@SpringBootApplication` 所在套件的**每一個直接子套件**就是一個模組。
- 模組的**根套件**是公開 API，**子套件**全部是內部。
- 內建檢查：循環依賴、存取別的模組的內部。

實際試一次（`spring-modulith-bom` 1.1.6，對應 Boot 3.2）：

```xml
<dependencyManagement>
  <dependencies>
    <dependency>
      <groupId>org.springframework.modulith</groupId>
      <artifactId>spring-modulith-bom</artifactId>
      <version>1.1.6</version>
      <type>pom</type>
      <scope>import</scope>
    </dependency>
  </dependencies>
</dependencyManagement>

<dependency>
  <groupId>org.springframework.modulith</groupId>
  <artifactId>spring-modulith-starter-test</artifactId>
  <scope>test</scope>
</dependency>
```

```java
class ModulithVerifyTest {

    static final ApplicationModules MODULES = ApplicationModules.of(ShopApplication.class);

    @Test
    void printModules() {
        System.out.println(MODULES);
    }

    @Test
    void verify() {
        MODULES.verify();
    }
}
```

`printModules` 的輸出（節錄）—— **它自己認出了九個模組，以及它們之間的依賴**：

```
# Shared
> Logical name: shared
> Base package: com.example.shop.shared
> Direct module dependencies: none
> Spring beans:
  o ….config.ShopProperties
  o ….config.UnresolvedPlaceholderCheck
  o ….web.PingController

# Ordering
> Logical name: ordering
> Base package: com.example.shop.ordering
> Direct module dependencies: inventory
> Spring beans:
  o ….internal.PlaceOrderService

# Inventory
> Logical name: inventory
> Base package: com.example.shop.inventory
> Direct module dependencies: none
> Spring beans:
  o ….internal.JdbcInventoryService
...
```

同時放進違規一（`InventoryRow`）與違規二（`SoldCountBadge` + `PriceCheck`），`verify()`：

```
org.springframework.modulith.core.Violations:
- Cycle detected: Slice catalog ->
                Slice ordering ->
                Slice catalog
  ...
- Module 'ordering' depends on non-exposed type com.example.shop.inventory.internal.InventoryRow within module 'inventory'!
Method <com.example.shop.ordering.internal.OrderSummaryService.describe(com.example.shop.inventory.internal.InventoryRow)> calls method <com.example.shop.inventory.internal.InventoryRow.productId()> in (OrderSummaryService.java:9)
...
```

**零規則、同樣抓到了循環與內部存取。** 但也實測到三個差異：

**差異一：「catalog 不准依賴 ordering」它不知道。**
Modulith 只抓到循環。如果只有 `catalog → ordering`、沒有反方向，**它不會報錯** —— 依賴白名單要自己在每個模組的 `package-info.java` 加 `@ApplicationModule(allowedDependencies = ...)`。

**差異二：`shared.config` 被當成 `shared` 的內部。**
讓訂單模組注入 `ShopProperties`（這是完全合理的用法）：

```
- Module 'ordering' depends on non-exposed type com.example.shop.shared.config.ShopProperties within module 'shared'!
- Module 'ordering' depends on non-exposed type com.example.shop.shared.config.ShopProperties$Order within module 'shared'!
```

依慣例，`shared.config` 是子套件 = 內部。解法是在 `shared/config/package-info.java` 標 `@NamedInterface("config")`，把它宣告成公開介面 ——

**差異三：而那個註解需要 Modulith 進到正式程式碼的 classpath。**

```
[ERROR] .../shared/config/package-info.java:[4,30] package org.springframework.modulith does not exist
```

`@NamedInterface` 在 `spring-modulith-api` 裡，必須是 `compile` 範圍的依賴，不能只是 `test`。加上之後 `verify()` 通過。

**比較**：

| | ArchUnit 手寫規則 | Spring Modulith |
|---|---|---|
| 模組怎麼定義 | 你寫 | 慣例（直接子套件） |
| 內部存取、循環 | 要寫（規則二、四） | **內建** |
| 依賴白名單 | 規則一，一張表看完 | 分散在每個模組的 `package-info.java` |
| SQL 字串 | ❌（要另寫 `TableOwnershipTest`） | ❌ |
| 正式程式碼的依賴 | **無**（全部是 `test` 範圍） | 用到 `@NamedInterface` / `@ApplicationModule` 時需要 `spring-modulith-api` |
| 額外功能 | —— | 產生模組文件與圖、模組層級的整合測試（`@ApplicationModuleTest`）、事件發布登記（Event Publication Registry，類似 Outbox） |

**本專題主線用 ArchUnit**，理由是：
依賴白名單（規則一）是本專題最重要的一條規則，它應該**集中在一個檔案裡**、在 code review 時一眼看完；
而且正式程式碼不需要為了架構測試多一個依賴。

**但 Modulith 是一個完全合理的選擇**，尤其是當你想要它的額外功能時 —— 它的 Event Publication Registry 解決的正是第 07 章 Outbox 的問題。
練習七會讓你把本專題的規則用 Modulith 完整表達一次。

> 📌 **對照做完要還原**：主線不用 Modulith。刪掉 `ModulithVerifyTest.java` 與 `shared/config/package-info.java`（`@NamedInterface`），
> `pom.xml` 移除 `spring-modulith-bom`、`spring-modulith-starter-test`，以及為了 `@NamedInterface` 加的 `spring-modulith-api`；
> 再刪掉為了這個對照放回去的違規一、違規二類別，以及差異二裡讓訂單模組注入 `ShopProperties` 的那段程式碼。

---

## 1.7 設定管理

### 1.7.1 三個檔案，三種角色

第 00 章只有一個 `application.yml`，本機的帳密直接寫在裡面。這一章把它拆成三個：

```
src/main/resources/
├── application.yml          ← 所有環境共用、而且「不是秘密」的設定
├── application-local.yml    ← 本機開發：連 compose.yaml 的容器
└── application-prod.yml     ← 正式環境：所有連線資訊與秘密都來自環境變數，而且沒有預設值
```

**`application.yml`**：

```yaml
spring:
  application:
    name: shop
  profiles:
    default: local          # 沒有指定 profile 時，當成本機開發
  datasource:
    hikari:
      maximum-pool-size: 20
      connection-timeout: 3000
  data:
    redis:
      timeout: 500ms
      connect-timeout: 500ms

shop:
  order:
    payment-timeout: 15m
    timeout-scan-interval: 30s

management:
  endpoints:
    web:
      exposure:
        include: health,info
  endpoint:
    health:
      probes:
        enabled: true
      group:
        liveness:
          include: livenessState,ping
        readiness:
          include: readinessState,db
```

**`application-local.yml`**：

```yaml
# 本機開發：連 compose.yaml 起的容器。這裡的帳密只存在你的筆電上。
spring:
  datasource:
    url: jdbc:mysql://localhost:3306/shop?useSSL=false&allowPublicKeyRetrieval=true&connectionTimeZone=UTC&rewriteBatchedStatements=true
    username: shop
    password: shop
  data:
    redis:
      host: localhost
      port: 6379
  rabbitmq:
    host: localhost
    port: 5672
    username: shop
    password: shop

shop:
  security:
    jwt-secret: local-dev-only-secret-0123456789abcdef

management:
  endpoint:
    health:
      show-details: always
```

**`application-prod.yml`**：

```yaml
# 正式環境：所有連線資訊與秘密都來自環境變數，而且「沒有預設值」。
# 少給一個，應用程式就起不來 —— 這是刻意的。
spring:
  datasource:
    url: jdbc:mysql://${SHOP_DB_HOST}:${SHOP_DB_PORT:3306}/${SHOP_DB_NAME:shop}?sslMode=REQUIRED&connectionTimeZone=UTC&rewriteBatchedStatements=true
    username: ${SHOP_DB_USER}
    password: ${SHOP_DB_PASSWORD}
  data:
    redis:
      host: ${SHOP_REDIS_HOST}
      port: ${SHOP_REDIS_PORT:6379}
      password: ${SHOP_REDIS_PASSWORD}
  rabbitmq:
    host: ${SHOP_RABBIT_HOST}
    username: ${SHOP_RABBIT_USER}
    password: ${SHOP_RABBIT_PASSWORD}

shop:
  security:
    jwt-secret: ${SHOP_JWT_SECRET}

management:
  endpoint:
    health:
      show-details: when-authorized
```

**幾個設計決定**：

| 決定 | 理由 |
|---|---|
| `spring.profiles.default: local` | 開發者 clone 下來直接 `mvn spring-boot:run` 就能跑（0.6.8「兩個命令」），不用記得加 `-Dspring.profiles.active=local`。正式環境**一定**要設 `SPRING_PROFILES_ACTIVE=prod` —— 1.7.4 會讓「忘了設」變成啟動失敗 |
| 逾時、連線池大小放在**共用**檔 | 它們是**行為**，不是**環境**。本機與正式環境用不同的逾時，就等於本機測不到正式環境的行為 |
| `payment-timeout: 15m` 放在共用檔 | 這是**業務規則**（US-ORD-3），不是環境設定。放在共用檔、而不是散在各 profile，才不會出現「測試環境是 15 分鐘、正式環境是 30 分鐘」 |
| prod 的秘密**沒有預設值**（`${SHOP_DB_PASSWORD}`，不是 `${SHOP_DB_PASSWORD:shop}`） | 有預設值的秘密 = 忘了設也能啟動 = 正式環境用 `shop` 當密碼 |
| prod 的非秘密**可以有**預設值（`${SHOP_DB_PORT:3306}`） | 3306 不是秘密，而且它幾乎永遠是 3306 |
| prod 的 JDBC URL 用 `sslMode=REQUIRED`，沒有 `allowPublicKeyRetrieval` | 0.10.4 說過後者「只用於本機」 |

### 1.7.2 誰蓋過誰

Spring Boot 從很多地方讀設定，**後面的蓋過前面的**。本專題會用到的五層（由低到高）：

| 優先序 | 來源 | 本專題的用途 |
|---|---|---|
| 1（最低） | `application.yml`（jar 內） | 共用預設 |
| 2 | `application-{profile}.yml`（jar 內） | 環境差異 |
| 3 | 作業系統環境變數 | **正式環境的秘密與連線資訊** |
| 4 | Java 系統屬性（`-Dshop.order.payment-timeout=20m`） | 臨時覆蓋 |
| 5（最高） | 命令列參數（`--shop.order.payment-timeout=20m`） | 臨時覆蓋、本章的實驗 |

**環境變數的命名規則**（relaxed binding）：全部大寫、`.` 換成 `_`、**`-` 直接拿掉**。

| 屬性 | 環境變數 |
|---|---|
| `spring.datasource.password` | `SPRING_DATASOURCE_PASSWORD` |
| `spring.data.redis.timeout` | `SPRING_DATA_REDIS_TIMEOUT` |
| `shop.order.payment-timeout` | `SHOP_ORDER_PAYMENTTIMEOUT`（官方文件的寫法）；`SHOP_ORDER_PAYMENT_TIMEOUT` 也綁得上 |

最後一列實測過（用 `90m` 故意觸發驗證失敗，看 `Origin`）：

```
#### SHOP_ORDER_PAYMENTTIMEOUT=90m
    Property: shop.order.paymentTimeout
    Origin: System Environment Property "SHOP_ORDER_PAYMENTTIMEOUT"
    Reason: 付款期限不可超過 60 分鐘（US-ORD-3）
#### SHOP_ORDER_PAYMENT_TIMEOUT=90m
    Property: shop.order.paymentTimeout
    Origin: System Environment Property "SHOP_ORDER_PAYMENT_TIMEOUT"
    Reason: 付款期限不可超過 60 分鐘（US-ORD-3）
```

兩種寫法都綁上了（Boot 對含 `-` 的屬性也接受「`-` 換成 `_`」的舊寫法）。**真正的坑是環境變數名稱打錯字**：

```bash
SPRING_DATA_REDIS_TIMEOT=5s java -jar target/shop-0.0.1-SNAPSHOT.jar
```

```
Started ShopApplication in 1.749 seconds
```

日誌裡**沒有任何一行**提到 `TIMEOT`。又是一次 1.2.2 —— 而且這次 1.7.5 的 `ConfigKeyGuardTest` 也幫不上忙，因為它只掃 `application*.yml`，**看不到部署平台上的環境變數**。

> 📌 **這就是本專題的 `application-prod.yml` 刻意用自己命名的環境變數**（`SHOP_DB_HOST`），而不讓部署端直接設 `SPRING_DATASOURCE_URL` 的理由：
> - 部署端要設哪些變數，**全部列在 `application-prod.yml` 一個檔案裡**，看一眼就知道。
> - 部署端把 `SHOP_DB_HOST` 打成 `SHOP_DB_HOTS` 時，**正確的那個名字就缺了** —— 1.7.4 的啟動檢查會直接拒絕啟動，並列出 `SHOP_DB_HOST`。
>   反過來，如果 `application-prod.yml` 不宣告 Redis 主機、改由部署端直接設 `SPRING_DATA_REDIS_HOST`，
>   打成 `SPRING_DATA_REDIS_HSOT` 時就只是一個沒人讀的環境變數 —— 應用程式會默默用 Boot 的預設值 `localhost`，
>   而 Redis 是延遲連線的，要到第一次用快取時才會失敗。
>
> **把「部署端可以設的東西」收斂成一份有檢查的清單，打錯字才有地方被抓到。**

### 1.7.3 `ShopProperties`：本專題自己的設定，啟動時就驗證

前面的 `payment-timeout`、`jwt-secret` 不是 Spring 的屬性，是本專題的業務設定。
把它們集中成一個型別安全、有驗證的類別：

```java
package com.example.shop.shared.config;

import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import org.hibernate.validator.constraints.time.DurationMax;
import org.hibernate.validator.constraints.time.DurationMin;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.validation.annotation.Validated;

import java.time.Duration;

/**
 * 本專題自己的設定，全部集中在 shop.* 底下。
 * 啟動時就驗證；任何一個值不合法，應用程式直接起不來。
 */
@Validated
@ConfigurationProperties(prefix = "shop", ignoreUnknownFields = false)
public record ShopProperties(@Valid @NotNull Order order, @Valid @NotNull Security security) {

    /** US-ORD-3：付款期限 */
    public record Order(
            @NotNull @DurationMin(minutes = 1, message = "付款期限至少 1 分鐘")
            @DurationMax(minutes = 60, message = "付款期限不可超過 60 分鐘（US-ORD-3）") Duration paymentTimeout,
            @NotNull @DurationMin(seconds = 10, message = "逾時掃描間隔至少 10 秒") Duration timeoutScanInterval) {}

    /** 0.6.5：JWT 金鑰至少 256 bits（32 bytes） */
    public record Security(
            @NotBlank @Size(min = 32, message = "JWT 金鑰至少 32 bytes（256 bits，0.6.5）") String jwtSecret) {}
}
```

```java
@SpringBootApplication
@ConfigurationPropertiesScan
public class ShopApplication { ... }
```

需要的依賴（驗證註解）：

```xml
<dependency>
  <groupId>org.springframework.boot</groupId>
  <artifactId>spring-boot-starter-validation</artifactId>
</dependency>
```

**四個關鍵字**：

| | 作用 |
|---|---|
| `record` | 不可變。建立之後沒有 setter，**不會有程式碼在執行期偷偷改設定** |
| `@Validated` + 欄位上的約束 | 綁定完立刻驗證，**不合法就啟動失敗** |
| `@Valid`（在 `Order`、`Security` 上） | 明確宣告「驗證要遞迴進巢狀的 record」。Spring Boot 綁定時其實已經會驗證每一個**有值被綁進去**的巢狀物件；`@Valid` 是官方文件建議的寫法，保證連「一個值都沒綁到」的巢狀物件也會被驗證（見下面的 ⚠️） |
| `ignoreUnknownFields = false` | `shop.*` 底下出現**任何**沒有對應欄位的鍵 → 啟動失敗。這是 1.2.2 的解藥（只對 `shop.*` 有效） |

> ⚠️ **專題寫完之後的更正：這一格原本寫的是「沒有它，`Order` 裡的 `@DurationMax` 不會被檢查」—— 那是錯的。** 當時沒有量，寫的是一般 Bean Validation 的規則（巢狀物件要 `@Valid` 才會被遞迴驗證）。
> 拿掉 `@Valid` 實測（Spring Boot 3.2.5，`ApplicationContextRunner`）：
>
> | 設定 | 沒有 `@Valid` 的結果 |
> |---|---|
> | `payment-timeout=90m` | 啟動失敗：`shop.order.paymentTimeout` 付款期限不可超過 60 分鐘（US-ORD-3） |
> | `payment-timeout=30m`、少了 `timeout-scan-interval` | 啟動失敗：`shop.order.timeoutScanInterval` 不得是空值 |
> | `shop.order.*` 一個都沒給 | 啟動失敗：`shop.order` 不得是空值（外層的 `@NotNull`） |
>
> 原因是 Boot 的 `ValidationBindHandler` 在綁完**每一個**巢狀物件時就驗證它，不經過 Bean Validation 的 `@Valid` 遞迴。在這個專案的形狀（record、外層 `@NotNull`）裡，`@Valid` 拿掉也擋得住同樣的錯；本專題照樣留著它 —— 它讓「這裡要遞迴驗證」寫在程式碼上，換成有預設值、沒有任何鍵被綁到的巢狀物件時也不會漏。

**實測：三種錯誤的設定**

```bash
java -jar target/shop-0.0.1-SNAPSHOT.jar --shop.order.payment-timeout=90m
```

```
***************************
APPLICATION FAILED TO START
***************************

Description:

Binding to target com.example.shop.shared.config.ShopProperties failed:

    Property: shop.order.paymentTimeout
    Value: "PT1H30M"
    Origin: "shop.order.payment-timeout" from property source "commandLineArgs"
    Reason: 付款期限不可超過 60 分鐘（US-ORD-3）


Action:

Update your application's configuration
```

注意 `Origin` —— 它告訴你這個值**從哪裡來**（命令列參數）。如果是從 `application-prod.yml` 來的，會寫檔名和行號。
這在「正式環境為什麼是這個值」的時候非常有用：**五層來源，它直接告訴你是哪一層贏了。**

```bash
java -jar target/shop-0.0.1-SNAPSHOT.jar --shop.order.paymnet-timeout=20m
```

```
Binding to target [Bindable@3111631d type = com.example.shop.shared.config.ShopProperties, ...] failed:

    Property: shop.order.paymnet-timeout
    Value: "20m"
    Origin: "shop.order.paymnet-timeout" from property source "commandLineArgs"
    Reason: The elements [shop.order.paymnet-timeout] were left unbound.
```

**打錯字（`paymnet`）被抓到了** —— 這是 `ignoreUnknownFields = false` 的效果。對照 1.2.2：`spring.data.redis.timeot` 沒有被抓到，因為 `spring.*` 不歸我們管。

```bash
java -jar target/shop-0.0.1-SNAPSHOT.jar --shop.security.jwt-secret=short
```

```
    Property: shop.security.jwtSecret
    Value: "short"
    Origin: "shop.security.jwt-secret" from property source "commandLineArgs"
    Reason: JWT 金鑰至少 32 bytes（256 bits，0.6.5）
```

三種錯誤都在**啟動的 1.5 秒內**失敗，而且訊息直接指向問題。

> ⚠️ **為什麼每個約束都自己寫 `message`？** 第一版沒有寫，輸出是這樣的：
>
> ```
>     Reason: 必須短於  or equal to 60 minutes
> ```
>
> ```
>     Reason: 大小必須在 32 和 2147483647 之間
> ```
>
> Hibernate Validator 的預設訊息**跟著 JVM 的語系走**（這台機器是 zh_TW），而 `@DurationMax` 的中文翻譯只翻了一半。
> 同一個 jar 放到英文語系的伺服器上，訊息又變成英文。
> **自己寫 `message`**：訊息固定、可以帶上需求編號（`US-ORD-3`）—— 看到錯誤的人直接知道去哪裡查為什麼有這個限制。
>
> 📌 注意：US-ORD-3 本身只規定 **15 分鐘**。「1～60 分鐘」這個範圍是本專題替設定值加的**防呆上限**，不是寫在需求裡的數字 ——
> 訊息裡的 `US-ORD-3` 說的是「這個設定屬於哪一條需求」，而不是「60 分鐘出自這條需求」。

### 1.7.4 事故：正式環境少了 8 個環境變數，應用程式「啟動成功」★★★

`application-prod.yml` 刻意讓秘密沒有預設值，期待的效果是「少給一個就起不來」。實測：

```bash
java -jar target/shop-0.0.1-SNAPSHOT.jar --spring.profiles.active=prod
```

```
Binding to target com.example.shop.shared.config.ShopProperties failed:

    Property: shop.security.jwtSecret
    Value: "${SHOP_JWT_SECRET}"
    Origin: class path resource [application-prod.yml] from shop-0.0.1-SNAPSHOT.jar - 20:17
    Reason: 大小必須在 32 和 2147483647 之間
```

（這是加上自訂 `message` 之前的輸出。）

**看 `Value` 那一行**：`"${SHOP_JWT_SECRET}"` —— `@ConfigurationProperties` 綁定遇到**解析不出來的 placeholder，會把它當成字面字串**。
這次它被擋下來，**純粹是運氣**：`${SHOP_JWT_SECRET}` 這個字串只有 18 個字元，剛好違反了「至少 32」。

那如果 JWT 金鑰有設，其他 8 個沒設呢？

```bash
SHOP_JWT_SECRET=this-is-a-forty-character-long-secret-xx \
  java -jar target/shop-0.0.1-SNAPSHOT.jar --spring.profiles.active=prod --server.port=8081
```

```
... INFO 72049 --- [shop] [           main] com.example.shop.ShopApplication         : Started ShopApplication in 1.731 seconds (process running for 1.963)
```

**啟動成功。** 資料庫的主機、帳號、密碼，Redis 的主機、密碼，RabbitMQ 的主機、帳號、密碼 —— 一個都沒有給。

```bash
curl -s -w '\nHTTP %{http_code}\n' localhost:8081/api/ping
curl -s -w '\nHTTP %{http_code}\n' localhost:8081/actuator/health/liveness
curl -s -w '\nHTTP %{http_code}\n' localhost:8081/actuator/health/readiness
```

```
{"service":"shop","time":"2026-09-23T07:25:38.161565Z"}
HTTP 200
{"status":"UP"}
HTTP 200
{"status":"DOWN"}
HTTP 503
```

`/api/ping` 200、liveness UP。**只有 readiness 是 DOWN** —— 0.10.6 的設計在這裡救了一次：負載平衡器不會把流量送進來。
但如果你在部署管線裡的檢查是「行程有沒有起來」或「liveness 有沒有 UP」，**這次部署會被判定成功**。

日誌裡的錯誤要到 readiness 第一次被呼叫（第一次需要資料庫連線）時才出現：

```
... ERROR 72049 --- [shop] [nio-8081-exec-6] com.zaxxer.hikari.pool.HikariPool        : HikariPool-1 - Exception during pool initialization.
com.mysql.cj.jdbc.exceptions.CommunicationsException: Communications link failure
```

`Communications link failure` —— 這是 MySQL 驅動最沒有資訊量的錯誤訊息，網路不通、防火牆、資料庫沒起來、帳密錯誤，全部都可能是它。
真正的原因要往下翻到第 138 行：

```
Caused by: java.net.UnknownHostException: ${SHOP_DB_HOST}: nodename nor servname provided, or not known
```

**主機名稱是字面上的 `${SHOP_DB_HOST}`。**

**為什麼會這樣？** 兩件事疊在一起：

1. **`@ConfigurationProperties` 綁定時，解析不出來的 placeholder 會原樣保留**（不丟例外）。`DataSourceProperties`、`RedisProperties` 都是 `@ConfigurationProperties`。
2. **連線是延遲建立的**。本章還沒有 JPA、沒有 Flyway —— 啟動期間**沒有任何東西需要連資料庫**，HikariCP 要到第一次 `getConnection()` 才初始化。

第 02 章加入 Flyway 之後，Flyway 會在啟動時連資料庫，這個例子會變成啟動失敗。
**但 Redis 和 RabbitMQ 的連線依然是延遲的**，同樣的問題換個地方繼續存在。

**修正：啟動時主動把每一個設定值解析一次**

```java
package com.example.shop.shared.config;

import org.springframework.beans.factory.InitializingBean;
import org.springframework.core.env.ConfigurableEnvironment;
import org.springframework.core.env.EnumerablePropertySource;
import org.springframework.core.env.PropertySource;
import org.springframework.stereotype.Component;

import java.util.Set;
import java.util.TreeSet;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 啟動時把所有設定值解析一次；任何一個 ${...} 解析不出來，就拒絕啟動，並一次列出全部缺少的變數。
 *
 * 為什麼需要它：@ConfigurationProperties 綁定遇到解析不出來的 placeholder 時，會「原樣保留字串」，
 * 而 DataSource / Redis 要到第一次被使用時才連線 —— 應用程式會「成功啟動」，然後在第一個請求時才炸。
 */
@Component
class UnresolvedPlaceholderCheck implements InitializingBean {

    private static final Pattern MISSING = Pattern.compile("Could not resolve placeholder '([^']+)'");

    private final ConfigurableEnvironment env;

    UnresolvedPlaceholderCheck(ConfigurableEnvironment env) {
        this.env = env;
    }

    @Override
    public void afterPropertiesSet() {
        Set<String> missing = new TreeSet<>();
        Set<String> affected = new TreeSet<>();
        for (PropertySource<?> ps : env.getPropertySources()) {
            if (!(ps instanceof EnumerablePropertySource<?> eps)) continue;
            if (!ps.getName().contains("application")) continue;         // 只檢查我們自己的設定檔
            for (String key : eps.getPropertyNames()) {
                try {
                    env.getProperty(key);
                } catch (IllegalArgumentException e) {
                    Matcher m = MISSING.matcher(e.getMessage());
                    if (m.find()) missing.add(m.group(1));
                    affected.add(key);
                }
            }
        }
        if (!missing.isEmpty()) {
            throw new IllegalStateException("""
                    缺少必要的環境變數：%s
                    受影響的設定：%s
                    （active profiles = %s）""".formatted(missing, affected, String.join(",", env.getActiveProfiles())));
        }
    }
}
```

它利用了一個差異：`@ConfigurationProperties` 的綁定器對解析失敗**寬容**（保留原字串），
但 `Environment.getProperty()` 對解析失敗**嚴格**（丟 `IllegalArgumentException: Could not resolve placeholder 'X'`）。
把我們自己的設定檔（property source 名稱含 `application`）裡的每一個鍵都用嚴格的方式讀一次，就能**在啟動時**抓到所有漏掉的變數。

重跑同一個命令：

```
Caused by: java.lang.IllegalStateException: 缺少必要的環境變數：[SHOP_DB_HOST, SHOP_DB_PASSWORD, SHOP_DB_USER, SHOP_RABBIT_HOST, SHOP_RABBIT_PASSWORD, SHOP_RABBIT_USER, SHOP_REDIS_HOST, SHOP_REDIS_PASSWORD]
受影響的設定：[spring.data.redis.host, spring.data.redis.password, spring.datasource.password, spring.datasource.url, spring.datasource.username, spring.rabbitmq.host, spring.rabbitmq.password, spring.rabbitmq.username]
（active profiles = prod）
```

**一次列出全部 8 個缺少的變數**，以及它們影響了哪 8 個設定。部署的人不用「補一個、重啟、看下一個錯誤、再補一個」。
本機（`local` profile，沒有任何 placeholder 缺值）照常啟動：

```
Started ShopApplication in 1.996 seconds (process running for 2.217)
```

> 📌 **有預設值的 placeholder（`${SHOP_DB_PORT:3306}`）不會被報告** —— 它解析得出來。
> 這正是 1.7.1 的設計：**秘密沒有預設值，所以漏掉就啟動失敗；非秘密有預設值，所以可以省略。**
> 你在 `application-prod.yml` 裡寫的每一個 `${X}`（沒有冒號），都是一個**必填**的環境變數宣告。

### 1.7.5 `spring.*` 打錯字：`ConfigKeyGuardTest`

`ignoreUnknownFields = false` 只管得到 `shop.*`。1.2.2 的 `spring.data.redis.timeot` 需要另一個方法。

**思路**：每一個 Spring Boot 的 starter jar 裡都有一份 `META-INF/spring-configuration-metadata.json`，列出它支援的所有屬性 ——
IDE 的設定檔自動完成就是讀這個檔案。那麼測試也可以讀它：**`application*.yml` 裡的每一個鍵，都必須出現在某一份 metadata 裡。**

我們自己的 `ShopProperties` 也需要一份 metadata，加上設定處理器（編譯期的 annotation processor）就會自動產生：

```xml
<dependency>
  <groupId>org.springframework.boot</groupId>
  <artifactId>spring-boot-configuration-processor</artifactId>
  <optional>true</optional>
</dependency>
```

```java
package com.example.shop.architecture;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.springframework.core.io.Resource;
import org.springframework.core.io.support.PathMatchingResourcePatternResolver;
import org.yaml.snakeyaml.Yaml;

import java.io.InputStream;
import java.util.*;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 1.7.5 設定鍵守門員：application*.yml 裡的每一個鍵，都必須是某個 jar（或我們自己的
 * ShopProperties）宣告過的屬性。打錯字的鍵在 mvn test 就會被抓到，而不是在 Redis 卡住的那一刻。
 */
class ConfigKeyGuardTest {

    static final PathMatchingResourcePatternResolver RESOLVER = new PathMatchingResourcePatternResolver();

    /** 從 classpath 上所有 jar 的 metadata 收集「已知屬性」與「Map 型別的屬性前綴」 */
    static void loadMetadata(Set<String> exact, Set<String> mapPrefixes) throws Exception {
        ObjectMapper om = new ObjectMapper();
        for (String pattern : List.of("classpath*:META-INF/spring-configuration-metadata.json",
                                      "classpath*:META-INF/additional-spring-configuration-metadata.json")) {
            for (Resource r : RESOLVER.getResources(pattern)) {
                try (InputStream in = r.getInputStream()) {
                    JsonNode props = om.readTree(in).path("properties");
                    for (JsonNode p : props) {
                        String name = p.path("name").asText();
                        String type = p.path("type").asText("");
                        exact.add(name);
                        if (type.startsWith("java.util.Map")) mapPrefixes.add(name + ".");
                    }
                }
            }
        }
    }

    @SuppressWarnings("unchecked")
    static void flatten(String prefix, Object node, List<String> out) {
        if (node instanceof Map<?, ?> m) {
            m.forEach((k, v) -> flatten(prefix.isEmpty() ? k.toString() : prefix + "." + k, v, out));
        } else {
            out.add(prefix);
        }
    }

    @Test
    void everyKeyInApplicationYamlIsKnown() throws Exception {
        Set<String> exact = new HashSet<>(), mapPrefixes = new HashSet<>();
        loadMetadata(exact, mapPrefixes);

        List<String> unknown = new ArrayList<>();
        int checked = 0;
        for (Resource yml : RESOLVER.getResources("file:src/main/resources/application*.yml")) {
            List<String> keys = new ArrayList<>();
            try (InputStream in = yml.getInputStream()) {
                for (Object doc : new Yaml().loadAll(in)) if (doc != null) flatten("", doc, keys);
            }
            for (String k : keys) {
                checked++;
                boolean known = exact.contains(k) || mapPrefixes.stream().anyMatch(k::startsWith);
                if (!known) unknown.add(yml.getFilename() + " → " + k);
            }
        }
        System.out.printf("已知屬性 %,d 個（Map 前綴 %,d 個）；檢查了 %d 個設定鍵%n", exact.size(), mapPrefixes.size(), checked);
        unknown.forEach(u -> System.out.println("  ✗ 未知的設定鍵：" + u));
        assertThat(unknown).as("application*.yml 裡有沒有任何 jar 宣告過的設定鍵（打錯字？）").isEmpty();
    }
}
```

> 📌 **Map 前綴**是為了 `management.endpoint.health.group.liveness.include` 這種鍵：
> metadata 裡宣告的是 `management.endpoint.health.group`（型別 `Map<String, Group>`），`liveness` 是**你自己取的名字**。
> 同理 `logging.level.com.example.shop`。所以 Map 型別的屬性，底下任何鍵都算已知。

**第一次跑，它抓到了……我們自己**：

```
已知屬性 2,320 個（Map 前綴 73 個）；檢查了 34 個設定鍵
  ✗ 未知的設定鍵：application-local.yml → shop.security.jwt-secret
  ✗ 未知的設定鍵：application-prod.yml → shop.security.jwt-secret
  ✗ 未知的設定鍵：application.yml → shop.order.payment-timeout
  ✗ 未知的設定鍵：application.yml → shop.order.timeout-scan-interval
```

設定處理器剛加進 `pom.xml`，但 Maven 的**增量編譯**判斷「原始碼沒變」，沒有重新編譯 `ShopProperties` → annotation processor 沒有執行 → 沒有產生 metadata。

```bash
mvn clean test -Dtest=ConfigKeyGuardTest
```

```
已知屬性 2,323 個（Map 前綴 73 個）；檢查了 34 個設定鍵
```

多了 3 個（`shop.order.payment-timeout`、`shop.order.timeout-scan-interval`、`shop.security.jwt-secret`），全部通過。
產生出來的 `target/classes/META-INF/spring-configuration-metadata.json` 也讓 IDE 對 `shop.*` 有了自動完成。

> ⚠️ **加了任何 annotation processor（設定處理器、Lombok、MapStruct）之後，第一次要 `mvn clean`。** 這個坑不限於本章。

**現在把 1.2.2 的錯字放回 `application.yml`**：

```
已知屬性 2,323 個（Map 前綴 73 個）；檢查了 34 個設定鍵
  ✗ 未知的設定鍵：application.yml → spring.data.redis.timeot
[ERROR] Tests run: 1, Failures: 1, Errors: 0, Skipped: 0, Time elapsed: 0.148 s <<< FAILURE! -- in com.example.shop.architecture.ConfigKeyGuardTest
```

**0.15 秒。** 對照 1.2.2：沒有這個測試時，這個錯字要等到**Redis 卡住的那一刻**、以 60 秒的逾時被「發現」。

確認抓到之後，**把 `timeot` 改回 `timeout`**，再跑一次 `ConfigKeyGuardTest` 確認綠燈 —— 1.8 的完整建置需要它是綠的。

### 1.7.6 什麼可以進 repo

| 東西 | 進 repo？ | 放哪裡 |
|---|---|---|
| 逾時、連線池、業務規則（付款期限） | ✅ | `application.yml` |
| 本機容器的帳密（`shop` / `shop`） | ✅ | `application-local.yml`、`compose.yaml` —— 它們只存在於你的筆電 |
| 正式環境**需要哪些**變數 | ✅ | `application-prod.yml` 的 `${X}`（這就是清單） |
| 正式環境的**值**（主機、帳密、JWT 金鑰） | ❌ **絕不** | 部署平台的秘密管理（第 09 章） |
| 本機的 JWT 金鑰 | ✅，但**名字要看起來就像假的**（`local-dev-only-secret-...`） | `application-local.yml` |

> 📌 本機 JWT 金鑰取名 `local-dev-only-secret-...` 不是開玩笑。
> 如果有一天它出現在正式環境的日誌或設定裡，**任何人看到都會知道出事了**。
> 取名 `x7Kp2mQ9...` 的假金鑰，被誤用到正式環境時沒有人會發現。

---

## 1.8 本章完成後的專案

```
shop/
├── .gitignore                                 ← 0.10.2：只有一行 target/
├── compose.yaml
├── pom.xml                                    ← + validation、configuration-processor、archunit
└── src/
    ├── main/
    │   ├── java/com/example/shop/
    │   │   ├── ShopApplication.java           ← + @ConfigurationPropertiesScan
    │   │   ├── account/package-info.java
    │   │   ├── cart/package-info.java
    │   │   ├── catalog/package-info.java
    │   │   ├── inventory/
    │   │   │   ├── InventoryApi.java
    │   │   │   ├── ReserveLine.java
    │   │   │   ├── InsufficientStockException.java
    │   │   │   ├── package-info.java
    │   │   │   └── internal/JdbcInventoryService.java
    │   │   ├── notification/package-info.java
    │   │   ├── ordering/
    │   │   │   ├── OrderingApi.java
    │   │   │   ├── package-info.java
    │   │   │   └── internal/PlaceOrderService.java
    │   │   ├── payment/package-info.java
    │   │   ├── reporting/package-info.java
    │   │   └── shared/
    │   │       ├── package-info.java
    │   │       ├── config/ShopProperties.java
    │   │       ├── config/UnresolvedPlaceholderCheck.java
    │   │       └── web/PingController.java     ← 從根套件搬過來
    │   └── resources/
    │       ├── application.yml
    │       ├── application-local.yml
    │       └── application-prod.yml
    └── test/
        ├── java/com/example/shop/
        │   ├── acceptance/CapstoneAcceptanceTest.java
        │   ├── architecture/                   ← 永久的守門員
        │   │   ├── ModuleBoundaryTest.java
        │   │   ├── NotTouchOtherModulesInternals.java
        │   │   ├── TableOwnershipTest.java
        │   │   └── ConfigKeyGuardTest.java
        │   ├── ch00/…
        │   └── ch01/                           ← 本章的實驗
        │       ├── B1BypassOwnerTest.java
        │       ├── B2ConfigTypoTest.java
        │       └── B3InProcessVsHttpTest.java
        └── resources/
            ├── ch01-schema.sql                 ← 第 02 章會被 Flyway 取代
            ├── ch01-correct.yml
            └── ch01-typo.yml
```

**每個模組的 `package-info.java` 寫明它擁有的表**，例如：

```java
/**
 * 庫存模組。擁有：inventory、inventory_reservations、inventory_ledger。
 * 對外只提供 {@link com.example.shop.inventory.InventoryApi}；internal 子套件不得被其他模組引用。
 */
package com.example.shop.inventory;
```

它跟 `TableOwnershipTest.OWNER` 是同一份資訊的兩種形式：一份給人讀，一份給測試執行。

**跑之前，確認示範用的東西都已經清掉**（它們不在上面的檔案樹裡；留著任何一個，下面的數字就對不上）：

| 檔案 | 出處 | 留著會怎樣 |
|---|---|---|
| `ordering/internal/SneakyOrderService.java` | 1.4.3 | 編譯失敗 |
| `inventory/internal/InventoryRow.java`、`ordering/internal/OrderSummaryService.java` | 1.6.3 違規一 | 規則二紅 |
| `catalog/CatalogApi.java`、`ordering/internal/PriceCheck.java`、`catalog/internal/SoldCountBadge.java` | 1.6.3 違規二 | 規則一、四紅；`CatalogApi` 沒有實作，B1、B3 的 context 起不來 |
| `catalog/internal/BulkRestockImporter.java` | 1.6.3 違規三、1.6.4 | `TableOwnershipTest` 紅 |
| `reporting/internal/SalesReportQuery.java` | 1.6.4 | 不會紅，但它不屬於專案 |
| `architecture/EmptyShouldDemoTest.java` | 1.6.3 違規四 | 測試數多 1 |
| `ModulithVerifyTest.java`、`shared/config/package-info.java`、`pom.xml` 的 Modulith 依賴 | 1.6.5 | 測試數多 2；正式程式碼多一個依賴 |
| 1.6.5 差異二：讓訂單模組注入 `ShopProperties` 的那段程式碼 | 1.6.5 | 不會紅（`shared` 是誰都可以用的模組），但它是對照用的，不屬於專案 |
| `application.yml` 裡的 `timeot` | 1.7.5 | `ConfigKeyGuardTest` 紅 |

**完整跑一次**：

```bash
docker compose up -d --wait
mvn clean test
```

```
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 36.20 s -- in com.example.shop.ch00.A3HotRowCeilingTest
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.073 s -- in com.example.shop.ch00.A2FlagsVsStateMachineTest
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.003 s -- in com.example.shop.ch00.A1WhenToDeductTest
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 3.135 s -- in com.example.shop.ch01.B1BypassOwnerTest
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 61.86 s -- in com.example.shop.ch01.B2ConfigTypoTest
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 19.25 s -- in com.example.shop.ch01.B3InProcessVsHttpTest
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.054 s -- in com.example.shop.architecture.ConfigKeyGuardTest
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.010 s -- in com.example.shop.architecture.TableOwnershipTest
[WARNING] Tests run: 11, Failures: 0, Errors: 0, Skipped: 11, Time elapsed: 0.002 s -- in com.example.shop.acceptance.CapstoneAcceptanceTest
[INFO] Tests run: 6, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.525 s -- in com.example.shop.architecture.ModuleBoundaryTest
[WARNING] Tests run: 25, Failures: 0, Errors: 0, Skipped: 11
[INFO] BUILD SUCCESS
[INFO] Total time:  02:15 min
```

> 📌 **專題寫完之後重跑：`mvn clean verify`。** 上面是寫這一章時跑的 `mvn clean test`。專題寫完之後（2026-10-12），在本章結束時的程式碼上、用一套全新的 compose（空的資料庫，Flyway 從第一個 migration 開始）重跑了一次 `mvn clean verify`（load average 3.71 → 3.98）：

```bash
mvn clean verify
```

```
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 36.24 s -- in com.example.shop.ch00.A3HotRowCeilingTest
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.075 s -- in com.example.shop.ch00.A2FlagsVsStateMachineTest
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.004 s -- in com.example.shop.ch00.A1WhenToDeductTest
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 3.069 s -- in com.example.shop.ch01.B1BypassOwnerTest
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 61.48 s -- in com.example.shop.ch01.B2ConfigTypoTest
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 19.21 s -- in com.example.shop.ch01.B3InProcessVsHttpTest
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.054 s -- in com.example.shop.architecture.TableOwnershipTest
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.023 s -- in com.example.shop.architecture.ConfigKeyGuardTest
[WARNING] Tests run: 11, Failures: 0, Errors: 0, Skipped: 11, Time elapsed: 0.002 s -- in com.example.shop.acceptance.CapstoneAcceptanceTest
[INFO] Tests run: 6, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.513 s -- in com.example.shop.architecture.ModuleBoundaryTest
[WARNING] Tests run: 25, Failures: 0, Errors: 0, Skipped: 11
[INFO] ...
[INFO] Building jar: …/target/shop-0.0.1-SNAPSHOT.jar
[INFO] ...
[INFO] BUILD SUCCESS
[INFO] ...
[INFO] Total time:  02:15 min
```

25 個測試、跳過 11 個 —— 跟上面一樣。`verify` 比 `test` 多做的是打包 jar（`spring-boot:repackage`）；覆蓋率門檻要到第 08 章才有。

**25 個測試、`Skipped: 11`（驗收題一題都還沒變綠，符合 0.12.1 的進度表）、2 分 15 秒。**

注意時間分布：

| 測試 | 耗時 | 性質 |
|---|---|---|
| `B2ConfigTypoTest` | 61.86 s | **實驗**（它本來就要等 60 秒） |
| `A3HotRowCeilingTest` | 36.20 s | **量測** |
| `B3InProcessVsHttpTest` | 19.25 s | **實驗** |
| `architecture/*` 三個測試類別 | **0.59 s** 合計 | **守門員** —— 每次都要跑 |
| 其他 | < 4 s | —— |

**約 120 秒是實驗（A3、B1、B2、B3）、不到 1 秒是守門員。** 0.15.2 的練習八（`@Tag("benchmark")`）現在該做了 —— 本章練習一會延伸它。

**追溯表更新**（0.12.2）：「0.6.8 模組邊界 | ArchUnit | 01」這一列 → ✅。
驗收 Q11 的規則五已經寫好，但**要等第 07 章真的有 broker 程式碼、而且它全部在 `shared.messaging` 裡**，Q11 才算通過。

#### 追溯表：本章的守門員守的是哪些需求

| 守門員 | 守的需求 | 本章的證據 |
|---|---|---|
| 編譯器（package-private 的 `JdbcInventoryService`） | 0.6.8 模組邊界 | 1.4.3：`SneakyOrderService` 編譯失敗 |
| `ModuleBoundaryTest` 規則一～四、六 | 0.6.8 模組邊界、0.3.4「會呼叫誰」 | 1.6.3 違規一、違規二 |
| `ModuleBoundaryTest` 規則五 | 驗收 Q11（0.9.2 ③） | 規則已立；第 07 章才有東西可以檢查 |
| `TableOwnershipTest` | 0.3.4 資料歸屬；INV-3 不被繞過 | 1.6.4：抓到 `BulkRestockImporter`，ArchUnit 6 條全綠 |
| `Propagation.MANDATORY`（`InventoryApi.reserve()`） | US-ORD-1 AC-5 全有或全無 | 1.2.3：直接呼叫版訂單 945 張、預留 945 件；`placeOrder()` 本身沒有測試（見開頭「部分達成」） |
| `ShopProperties`（`@Validated`、`ignoreUnknownFields = false`） | US-ORD-3 的付款期限設定、0.6.5 JWT 金鑰 ≥ 256 bits | 1.7.3：三種錯誤設定都在啟動時失敗 |
| `UnresolvedPlaceholderCheck` | 0.6.5 秘密一律走環境變數 | 1.7.4：一次列出 8 個缺少的變數 |
| `ConfigKeyGuardTest` | 0.10.4 的 Redis 逾時 500 ms（0.6.3 降級矩陣的前提） | 1.7.5：抓到 `timeot`，0.15 秒 |

---

## 1.9 常見誤區

**① 「模組化就是把資料夾分好」**

資料夾是最弱的邊界 —— 1.4.1 的結構也有資料夾。
**邊界要有會自動失敗的東西守著**：編譯器、ArchUnit、表歸屬測試（1.6.1 的四道防線）。沒有守門員的資料夾，六個月後就是大泥球。

**② 「有 ArchUnit 就夠了」**

1.6.3 違規三：`"UPDATE inventory ..."` 在 ArchUnit 面前 **6 條全綠**。ArchUnit 看的是類別依賴，**看不到 SQL 字串**。
而 1.2.1 那 10,000 件帳外庫存，正是一個 SQL 字串造成的。

**③ 「繞過模組是因為工程師偷懶」**

1.2.1：逐筆 API 1.99 ms/筆、直接寫表 0.038 ms/筆 —— **效能分析是對的**。
正確的反應不是「禁止」，而是**讓擁有者提供它缺的 API**（`restockBatch`，0.052 ms/筆）。
守門員的作用是讓「繞過」變成一個**會被看見的決定**，而不是讓需求無法被滿足。

**④ 「每個模組都用別人的 DTO，少寫一點程式碼」**

1.5.4：`OrderLine` 和 `ReserveLine` 現在長得一樣，但第 04 章 `OrderLine` 會多一個價格、第 06 章 `ReserveLine` 可能多一個熱點旗標。
**在邊界上多一行 `map`，換來兩個模組各自演化。**

**⑤ 「`@ManyToOne Product` 比較方便」**

1.5.5：它讓訂單模組拿到一個可以被修改的 catalog Entity，給你的是商品**現在**的樣子而不是**下單時**的樣子，還附贈一個 N+1。
**跨模組只存 id 和快照。**

**⑥ 「微服務延遲高，所以不拆」**

1.2.3：HTTP 只多了 **0.24 ms**（p50）。**延遲不是理由**。
真正的理由是**失去交易**：55 筆孤兒預留，以及為了收拾它們要寫的 Saga、補償、對帳。

**⑦ 「`shared` 就是放共用程式碼的地方」**

1.5.7：`shared` 不能依賴任何業務模組，也不放任何業務邏輯。
**如果你說得出 `shared` 裡某個類別屬於哪個模組，它就不該在 `shared` 裡。**

**⑧ 「設定打錯字，啟動時就會發現」**

1.2.2：`spring.data.redis.timeot` —— **沒有警告**，逾時 0.51 秒 → 60.01 秒。
Spring Boot 對未知的鍵是沉默的。`shop.*` 用 `ignoreUnknownFields = false`，`spring.*` 用 `ConfigKeyGuardTest`。

**⑨ 「秘密沒有預設值，漏了就起不來」**

1.7.4：**起得來**，`Started ShopApplication in 1.731 seconds`。
`@ConfigurationProperties` 把 `${SHOP_DB_HOST}` 當成字面字串，而連線是延遲建立的。需要 `UnresolvedPlaceholderCheck` 主動檢查。

**⑩ 「`failOnEmptyShould` 很煩，全域關掉」**

1.6.3 違規四：這個預設是在保護你 —— 打錯套件名的規則會**永遠綠燈、從未檢查過任何東西**。
**逐條** `allowEmptyShould(true)`，並在那個套件出現後拿掉。

---

## 1.10 本章小結

**這一章建立了四件事**：

1. **一個判斷**（1.2.3、1.3）：本專題是模組化單體，因為**拆的代價是交易**（55 筆孤兒），而第 00 章的數字裡**沒有任何一個拆分理由成立**。
2. **一個形狀**（1.4、1.5）：九個模組，每個模組 = 根套件（公開 API）+ `internal/`（實作）；
   模組之間只用介面、只用自己的 DTO、只存 id；`MANDATORY` 把「必須在同一個交易裡」變成執行期檢查。
3. **四道防線**（1.6）：編譯器 → ArchUnit 6 條規則 → 表歸屬測試 → 對帳。
   每一道都實測過它擋得住什麼、**擋不住什麼**。
4. **一套不會默默出錯的設定**（1.7）：三個檔案分工；`ShopProperties` 啟動即驗證；
   缺環境變數拒絕啟動；`spring.*` 打錯字在 `mvn test` 就被抓到。

**如果這一章只能記一句話**：

> **邊界的價值，等於守著它的那個測試的價值。沒有會自動失敗的東西守著的邊界，只是一個建議。**

### 1.10.1 驗收清單

做得到才往下走：

- [ ] 跑完 1.2.1，說出三種做法的每筆耗時，以及「速度來自哪裡」。
- [ ] 說出為什麼 1.2.1 的繞過在 ArchUnit 面前全綠，以及 `TableOwnershipTest` 怎麼抓到它。
- [ ] 跑完 1.2.2，說出 `timeot` 為什麼不會有任何警告，以及 60 秒從哪裡來。
- [ ] 跑完 1.2.3，說出延遲差多少、孤兒預留從哪裡來，以及為什麼直接呼叫的版本沒有孤兒。
- [ ] 說出本專題不拆成微服務的五個理由（1.3.2 那張表），並說出**什麼樣的數字**會讓答案改變。
- [ ] 說出 package-private 為什麼在 `internal` 有子套件之後就不夠用了。
- [ ] 說出 `InventoryApi.reserve()` 為什麼用 `MANDATORY`，以及沒有交易時呼叫它會發生什麼。
- [ ] 說出 `OrderLine` 與 `ReserveLine` 為什麼要分開。
- [ ] 說出跨模組為什麼不用 `@ManyToOne`（四個理由）。
- [ ] 故意寫一段 `catalog → ordering` 的依賴，看 `ModuleBoundaryTest` 怎麼報錯，然後刪掉。
- [ ] 說出 `failOnEmptyShould` 在保護你什麼。
- [ ] 說出 ArchUnit 與 Spring Modulith 的三個實測差異。
- [ ] 說出環境變數名稱打錯字（`SPRING_DATA_REDIS_TIMEOT`）為什麼不會被任何東西抓到，以及本專題為什麼只讓部署端設 `SHOP_*` 變數。
- [ ] 用 `--spring.profiles.active=prod` 啟動，看到 `UnresolvedPlaceholderCheck` 列出 8 個缺少的變數。
- [ ] 在 `application.yml` 故意打錯一個 `spring.*` 的鍵，看 `ConfigKeyGuardTest` 抓到它。
- [ ] `mvn clean verify` 顯示 `Tests run: 25, Failures: 0, Errors: 0, Skipped: 11`。

### 1.10.2 本章練習

**練習一（15 分鐘）：把實驗和守門員分開**

延續 0.15.2 的練習八：給 `A3HotRowCeilingTest`、`B2ConfigTypoTest`、`B3InProcessVsHttpTest` 加上 `@Tag("experiment")`，
用 0.15.2 練習八的屬性中介排除它們：`<excludedGroups>${test.excluded}</excludedGroups>`，`test.excluded` 預設 `experiment`。
（如果你做過 0.15.2 練習八，`A3HotRowCeilingTest` 身上是 `@Tag("benchmark")`、`test.excluded` 是 `benchmark`：一起改成 `experiment`，之後各章都用這個名字。）
**確認 `mvn test` 從 2 分 15 秒降到 10 秒以內**，而 `mvn test -Dtest.excluded=none -Dgroups=experiment` 只跑那三個。
（專題寫完之後的更正：這一題第一版要你在 surefire 直接寫死 `<excludedGroups>experiment</excludedGroups>`、再用 `-Dgroups=experiment` 只跑實驗 —— 那正是 0.15.2 練習八的 ⚠️ 說不能做的事：exclude 優先，照做的話 `-Dgroups=experiment` 一個測試都跑不到。第 02 章 2.11.1 在真的專案上踩到了同一個坑。）
`B1BypassOwnerTest` 要不要也加？（提示：它有 assert 嗎？它在驗證什麼？）

**練習二（20 分鐘）：讓 1.2.1 的繞過在第一道防線就被擋住**

目前 `TableOwnershipTest` 在第三道防線擋住 `BulkRestockImporter`。
**有沒有辦法讓它在更前面就被擋住？** 試試看：把 `JdbcTemplate` 的使用限制成「只有擁有表的模組才能注入 `JdbcTemplate`」—— 用 ArchUnit 寫得出來嗎？
（提示：`catalog` 將來也需要 `JdbcTemplate` 存取自己的 `products` 表。這條規則會不會太嚴？）
寫下你的結論：**哪些違規適合在哪一道防線擋？**

**練習三（15 分鐘）：`MANDATORY` 的另一面**

寫一個測試：在**沒有交易**的情況下呼叫 `inventory.reserve()`，斷言丟出 `IllegalTransactionStateException`。
然後把 `JdbcInventoryService.reserve()` 的 `MANDATORY` 改成預設的 `REQUIRED`，重跑 1.2.3。
**直接呼叫的版本還會一致嗎？** 為什麼？（提示：`REQUIRED` 在「已有交易」時的行為跟 `MANDATORY` 一樣。那 `MANDATORY` 多保護了什麼？）

**練習四（20 分鐘）：HTTP 版的連線池**

1.2.3 的 HTTP 版有一個沒有量的問題：本地交易**握著一條資料庫連線**等 HTTP 回應，而遠端處理又需要**另一條**連線。
把 `spring.datasource.hikari.maximum-pool-size` 設成 **4**，用 8 條執行緒並行跑 HTTP 版的下單。
**發生了什麼事？** 看 `hikaricp.connections.pending` 或 `Connection is not available, request timed out` 的日誌。
這就是「同一個服務呼叫自己」與「服務 A 呼叫服務 B、兩者共用一個資料庫」會遇到的**連線池死鎖**：每條執行緒都握著一條連線、等著另一條連線，池子一空就沒有人能前進，最後全部以 `Connection is not available` 逾時收場
（這個錯誤的診斷流程見 [06-repository/01](../06-repository/01-datasource-and-connection-pool.md) 1.9）。

**練習五（10 分鐘）：環境變數的打錯字**

用 `--spring.profiles.active=prod` 啟動，給齊 1.7.4 列出的 8 個缺少的變數（加上 `SHOP_JWT_SECRET` 共 9 個），但**故意把 `SHOP_DB_HOST` 打成 `SHOP_DB_HOTS`**。
`UnresolvedPlaceholderCheck` 報了什麼？
然後改成直接設 `SPRING_DATASOURCE_URL`（繞過 `SHOP_DB_HOST`），再把它打成 `SPRING_DATASOURCE_ULR`。**這次誰抓得到？**
寫下結論：為什麼「部署端只能設 `SHOP_*`」這條規則，讓打錯字從「沒人知道」變成「啟動失敗」。

**練習六（20 分鐘）：為 `cart` 模組設計 API**

依照 1.5 的原則，寫出 `CartApi` 介面（只寫介面和 DTO，不寫實作）。它需要支援 US-CART-1、US-CART-2，
並提供 `ordering` 在下單時需要的東西（US-ORD-1 AC-4：下單成功的品項要從購物車移除）。
**回答**：「從購物車移除」應該是 `ordering` 呼叫 `CartApi.remove()`（同步，同一個交易），還是 `cart` 訂閱 `OrderPlaced` 事件（非同步）？
用 1.5.1 的那個問題（「如果對方失敗了，我的操作應該算成功還是失敗？」）決定，並寫下理由。

**練習七（進階，40 分鐘）：用 Spring Modulith 完整表達本專題的規則**

加上 Modulith（1.6.5），在每個模組的 `package-info.java` 用 `@ApplicationModule(allowedDependencies = {...})` 表達 1.6.2 規則一的依賴表，
並用 `@NamedInterface` 處理 `shared.config` 與 `shared.web`。
**讓 `ApplicationModules.verify()` 抓到 1.6.3 的違規二（在沒有循環的情況下，只有 `catalog → ordering`）。**
然後用 `new Documenter(MODULES).writeModulesAsPlantUml()` 產生模組圖，跟 0.3.4 的表比對。
**寫下你的比較**：哪一種寫法，在 code review 時比較容易看出「有人改了依賴方向」？

**練習八（進階，30 分鐘）：`@Table` 的歸屬檢查**

1.6.4 的限制表提到：JPA 的表名在 `@Table(name = "...")` 裡，`TableOwnershipTest` 看不到。
用 ArchUnit 寫一條規則：**所有標了 `@jakarta.persistence.Table` 的類別，其 `name` 必須是它所在模組擁有的表**（對照 `TableOwnershipTest.OWNER`）。
（提示：`JavaClass.getAnnotationOfType(Table.class).name()`；自己寫一個 `ArchCondition`。）
第 02 章建 Entity 時會直接用到它。

---

## 1.11 下一章預告

下一章（02）回答一個問題：**0.3.4 那 19 張表，要長什麼樣子？**

本章的 `ch01-schema.sql` 是一份「剛好夠用」的暫時 schema —— 三張表、沒有外鍵、沒有索引規劃、由測試手動建立。
下一章要把它換成**正式的**：

- **ERD 與每一張表的欄位設計**：`inventory_reservations` 需要哪些欄位才能支撐 0.5 的狀態機？`orders` 的 `version` 欄位是給誰用的？
  `order_items` 要存哪些快照（1.5.5）？
- **約束就是不變量**：INV-1（`CHECK (reserved <= on_hand)`）、INV-4（一張訂單對一個商品最多一筆有效預留）要怎麼寫成資料庫約束？
  MySQL 8.0 的 `CHECK` 真的會被執行嗎？（8.0.16 之前**會被解析、然後被忽略** —— 下一章會實測你的版本。）
- **跨模組要不要外鍵**：1.5.5 說「不要」，下一章會實測「要」的時候會發生什麼事 —— 以及同一個模組內部的外鍵為什麼**要**。
- **索引規劃**：從 0.8 的 API 草案與 0.6.2 的 SLO 反推每一張表需要哪些索引，並用 `EXPLAIN` 驗證（[07-mysql/03](../07-mysql/03-index-and-explain.md)）。
- **Flyway**：每個模組一支 `V{n}__{模組}_create_tables.sql` 的遷移腳本、`ddl-auto=validate`、以及**驗收 Q6** —— 空資料庫啟動，從 V1 跑到最新版。
- **10 萬張訂單的種子資料**：US-RPT-1 AC-4 的效能要求需要真實量級的資料，而用 JPA 一筆一筆塞會花多久？（0.10.4 就放進 URL 的 `rewriteBatchedStatements`，會在這裡被實測。）

地基的形狀定了。下一章灌水泥。
