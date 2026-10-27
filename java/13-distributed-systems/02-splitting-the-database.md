# 第 02 章：資料庫拆分

> **上一章**：[第 01 章](01-service-boundaries.md)用三把尺量出庫存這一刀切斷什麼 —— 7 種交易、12 種同步呼叫，127 種切法裡排第 96；這一站仍然拿它當練習台（1.5.4）。它也做了「先拆模組」的第一步：5 種跨模組的讀移出本地交易，剩下的 12 種寫用 `CrossModuleCallInTxTest` 守著。
>
> **這一章**：切開**資料**。第 00 章的兩個資料庫其實是同一份 schema（兩邊都跑了全部的 migration）—— 這一章先用一個實驗讓這件事現形，再讓它們變成真的：庫存服務的庫只有庫存的表，訂單服務的庫一張庫存的表都沒有。然後處理資料庫分開之後消失的三樣東西：**交易**（切斷的交易失敗時留下什麼）、**JOIN**（「每一筆預留都屬於一張存在的訂單」不能再用一句 SQL 檢查）、**同一個時間點**（已經有資料的庫存，怎麼在單體照常營業的時候搬過去）。
>
> **你手上會有**：從 `d01` 開出來的分支 `d02`。正式程式碼：migration 依模組分資料夾（25 個檔案，內容一個字都沒改）；ordering 多一個預留 ⇄ 訂單的對帳（`ReservationReconciliation`）與它的排程；建立商品改成發一個 `product.created`（不再在建立商品的交易裡呼叫庫存）；以及第 12 站的一個修正（`OrderJobs`）。`src/test` 多一個 `dist02` 套件（兩個服務、兩個「誠實的」資料庫、四個實驗、一套搬家程式）與四個預設的測試。234 個測試。

---

## 2.1 學習目標

完成本章後，你應該可以：

- 說出第 00 章那兩個資料庫「只有一半是真的」：兩邊都跑了全部的 migration，所以有 9 個庫存的方法一直在讀寫訂單服務自己那一份空的庫存表 —— 而且用一個實驗量出來，不是讀程式碼猜出來（2.2）。
- 說出共享資料庫藏起來的三件事（誰在寫、寫到哪、少了什麼），以及「資料所有權」與「唯一寫入者」各是什麼意思（2.3）。
- 把一個模組的表搬進自己的資料庫：migration 依模組分資料夾、每個服務只跑自己的資料夾加上 `shared`、`flyway_schema_history` 各一份、授權跟著表走 —— 並用一個測試守住「每個服務的資料夾自己跑得起來」（2.4）。
- 說明第 12 站沒有跨模組的外鍵，參照完整性一直是**交易**給的；資料庫分開之後，列出跨過那一刀的參照與不變量（2.5.1、2.5.2）。
- 用失敗注入說出「切斷的交易」失敗之後各留下什麼，以及哪一種會自己收斂、哪一種不會（2.5.3）。
- 用模組的 API 取代跨庫的 JOIN，寫出一個對帳：兩個方向各掃一次、keyset 分頁、grace、只自動修「安全」的那幾種（2.6）。
- 用「另一邊會不會拒絕」決定一個跨服務的寫要用事件還是 Saga，並把「建立商品」從一個交易改成一個事件（2.7）。
- 量出三種搬家做法的代價：停寫搬家要停多久、應用程式雙寫錯在哪裡、讓舊的庫當唯一寫入者並照著變更紀錄追，最後停寫幾秒核對（2.8）。

---

## 2.2 先看見痛：第 00 章的兩個資料庫，是同一份 schema ★★★

第 00 章把庫存切成另一個服務、另一個資料庫，量了四個代價。但那兩個資料庫是怎麼建的？`SplitLab.freshDatabase()` 建好空的庫之後，兩個服務**都用第 12 站的 25 個 migration** 把它建起來 —— 訂單服務的庫裡有一份（空的）庫存表，庫存服務的庫裡也有一份（空的）商品表、訂單表。實驗的資料再分別灌進去：商品灌進訂單服務的庫，庫存灌進庫存服務的庫（0.2.0）。

而第 00 章的 `RemoteInventoryApi` 只把 `reserve()` 與可售量（三個方法；熱點商品的可售量仍然讀本地的 Redis 副本）換成了 HTTP，`InventoryApi` 其他 9 個方法「照舊交給本地的實作」（0.2.0、0.2.3）。本地的實作連的是訂單服務自己的庫。

K1～K5 都只走下單，所以這件事從來沒有出過問題。**一個真的使用者走一遍會怎樣？** 這一章的第一個實驗（C1，2.4.6 會一步一步做出來）把第 01 章的「使用者的一天」（1.4.4）跑在三種部署上。先看前兩種：

- ① **第 00 章的切法**：兩個庫都跑了全部的 migration，只有 `reserve` 與可售量走 HTTP。
- ② **誠實的庫**：庫存服務的庫只有庫存的表，訂單服務的庫一張庫存的表都沒有；程式碼照第 00 章。

另外在兩個服務的 JDBC URL 上各掛一個 query interceptor（`DbTap`，跟第 01 章的 `SqlTap` 同一個掛勾）：每一句碰到庫存表的 SQL，送到了**哪一個資料庫**、是**哪一段程式碼**送的。

```bash
mvn test -Pexperiments -Dtest=C1SharedSchemaTest
```

```
═══ 2.2 ① 第 00 章的切法：兩個庫都跑了全部的 migration，只有 reserve 與可售量走 HTTP（load { 3.13 4.24 4.88 }）═══
  使用者的一天：走了 33 個 HTTP 請求，停在一個不是預期的回應 —— POST /api/orders → 409（預期 201）：{"type":"/problems/insufficient-stock","title":"庫存不足","status":409,"detail":"商品 1 的可售庫存不足","instance":"/api/orders","traceId":"6acde1bc4adfedb0fd350728425023c5","productId":1}
  庫存的表收到的 SQL（送出的程式碼 → 哪一個庫：句數）：
    HotStock.initialize                            → shop_d02_order：1
    JdbcInventoryService.available                 → shop_d02_inv：16
    JdbcInventoryService.initialize                → shop_d02_order：4
    JdbcInventoryService.ledger                    → shop_d02_order：5
    JdbcInventoryService.reserve                   → shop_d02_inv：1
    JdbcInventoryService.restock                   → shop_d02_order：1
  shop_d02_order ：inventory 4 列、inventory_reservations 0 列、inventory_ledger 5 列
  shop_d02_inv   ：inventory 0 列、inventory_reservations 0 列、inventory_ledger 0 列
═══ 2.2 ② 誠實的庫：訂單服務的庫沒有庫存的表、庫存服務的庫只有庫存的表；程式碼照第 00 章（load { 3.49 4.28 4.89 }）═══
  庫存服務起不來：SchemaManagementException: Schema-validation: missing table [categories]
  訂單服務起不來：SchemaManagementException: Schema-validation: missing table [inventory]
  ── 兩個服務都關掉 ddl-auto=validate 再起一次 ──
  使用者的一天：走了 10 個 HTTP 請求，停在一個不是預期的回應 —— POST /api/seller/products → 500（預期 201）：{"type":"/problems/internal","title":"系統發生錯誤","status":500,"detail":"系統發生錯誤，請稍後再試","instance":"/api/seller/products","traceId":"6acde1c33fd45fe457be767c2474b1b1"}
  庫存的表收到的 SQL（送出的程式碼 → 哪一個庫：句數）：
    JdbcInventoryService.initialize                → shop_d02_order：1
  訂單服務的 ERROR 日誌：未預期的例外 ← SQLSyntaxErrorException: Table 'shop_d02_order.inventory' doesn't exist
```

**① 的第一個錯誤是第 33 個請求：買家下單，409「商品 1 的可售庫存不足」。** 賣家幾秒鐘前才建立了這個商品，期初庫存 100 件，還補了 10 件。前 32 個請求全部是預期的回應 —— 建立商品 201、補貨 200、標熱點 200、加入購物車 200。

看 `DbTap` 那幾行就知道為什麼：

- **賣家這一邊的每一句庫存 SQL，都送到了訂單服務的庫**（`shop_d02_order`）：`initialize` 4 句（4 個商品的庫存列）、帳 5 句（4 筆 INITIAL、1 筆 RESTOCK）、補貨 1 句，以及建立熱點閘門時讀可售量的 1 句。
- **買家這一邊的每一句，都送到了庫存服務的庫**（`shop_d02_inv`）：可售量 16 句、預留 1 句。
- 庫存服務的庫裡，`inventory` 一列都沒有。可售量查了 16 次，每一次都查不到 —— 回傳 0，**沒有任何錯誤**：商品頁顯示「0 件」、購物車多一個「庫存不足」的提醒（第 12 站 US-CART-1 AC-5：只提醒、不擋）。一直到預留那一句 `UPDATE … WHERE on_hand - reserved >= ?` 影響 0 列，才變成一個看得見的錯。

**② 讓錯誤變大聲了。** 訂單服務的庫裡沒有庫存的表，兩個服務都起不來：第 12 站的 `ddl-auto=validate`（第 12 站 0.6.7）會檢查每一個 JPA 實體對得上一張表 —— 庫存服務的庫沒有 `categories`，訂單服務的庫沒有 `inventory`（庫存模組有兩個只用來驗證 schema 的實體）。把驗證關掉再起一次：第 10 個請求，建立商品，500，日誌裡是 `Table 'shop_d02_order.inventory' doesn't exist`。

**兩種部署，同一份程式碼，同一個 bug —— 只差在你看不看得到它。** 第 00 章「拆」的是行程，資料庫留了一份沒人用的舊表，於是：

- 有 9 個方法一直在讀寫**錯的庫**，而且每一句都成功；
- 兩邊的資料慢慢分岔（訂單服務的庫有庫存列、庫存服務的庫沒有），每一邊自己看都「正確」；
- 第一個錯誤出現的地方（下單 409），離真正的原因（建立商品寫錯了庫）有 32 個請求遠。

這不只是實驗支架的問題。真的拆分常常就是這樣開始的：新的服務上線了，單體裡那幾張表「先留著，以防萬一」—— 然後單體裡某個沒人記得的排程、報表、後台功能，繼續讀它、寫它。**留著舊表，就是留著一條看不見的依賴。** 這一章的第一件事，是讓資料庫跟行程一樣真的分開；第二件事，是處理分開之後才看得見的那些東西。

---

## 2.3 共享資料庫為什麼是反模式

### 2.3.1 共享資料庫：好用的那一面

先說公道話。兩個服務共用一個資料庫，好處是真的：

- **交易還在。** 下單、預留、帳在同一個 commit 裡，全有或全無（第 12 站 US-ORD-1 AC-5）。
- **JOIN 還在。** 「每一筆預留都屬於一張存在的訂單」是一句 SQL（0.2.2 數孤兒的那一句）。報表、後台、對帳，想看什麼就 JOIN 什麼。
- **搬家不用搬。** 服務拆出去，資料一列都不用動。

所以「先拆服務、資料庫之後再說」是一條很常見的路 —— 第 00 章也是這樣做的。問題在於「之後」常常不會來，而共享資料庫會把拆分的好處一樣一樣吃掉。

### 2.3.2 它藏起來的三件事

2.2 的三個現象，各對應共享資料庫藏起來的一件事：

| 2.2 看到的 | 共享資料庫藏起來的 | 後果 |
|---|---|---|
| 9 個方法一直讀寫訂單服務那一份庫存表，每一句都成功 | **誰在寫**：任何一個連得上這個庫的程式，都可以寫任何一張表 | 「庫存服務是庫存的唯一寫入者」只是一句話；你拆出去的服務管不住它的資料 |
| 兩邊各自「正確」，合起來是錯的 | **寫到哪**：同名的表有兩份，SQL 不會告訴你它寫的是哪一份 | 資料分岔，而且沒有任何錯誤；要靠使用者回報才發現 |
| 驗證關掉之後才知道少了什麼 | **少了什麼**：在一個庫裡永遠找得到的表、永遠成立的交易、永遠寫得出來的 JOIN | 依賴只有在「拿掉之後」才看得見 |

還有兩件 2.2 沒有量、但同樣常見的：

- **schema 的改動要兩個團隊一起協調。** 庫存團隊要把 `inventory.reserved` 改名，得先確認沒有別的服務在讀它 —— 而那個「別的服務」可能是三年前某個人寫的一句報表 SQL。第 12 站 2.9.4 的 `MigrationOwnershipTest` 守住了 migration 的邊界，但守不住「別人的程式碼讀我的表」。
- **效能互相拖累。** 第 12 站的報表（`reporting` 模組）直接讀訂單與商品的表；一張跑 3 秒的報表，搶的是同一台 MySQL 的 CPU 與 buffer pool。拆成兩個服務、共用一個庫，這件事一點都沒有變。

### 2.3.3 資料所有權與唯一寫入者

兩個詞，這一站之後會一直用：

- **資料所有權（data ownership）**：一張表屬於一個模組（拆開之後：一個服務）。它的 schema 由這個模組決定，它的 migration 放在這個模組的資料夾，它的不變量（第 12 站的 INV-1～INV-5）由這個模組負責。
- **唯一寫入者（single writer）**：只有擁有者能寫這張表。其他人要改變它，只能透過擁有者的 API 或擁有者訂閱的事件。

讀呢？讀比寫寬鬆，但也有代價。其他人要讀，有三種做法：

| 讀的方式 | 例子 | 代價 |
|---|---|---|
| 問擁有者的 API | 購物車問 `InventoryApi.available()`（切開之後是一次 HTTP） | 一次網路往返；擁有者慢，你就慢（第 01 章 1.6.5 的 B2） |
| 自己存一份（由事件更新） | 第 12 站的熱點閘門：Redis 裡的 `stock:{id}` 是可售量的副本 | 過時視窗；要對帳（第 12 站 6.6） |
| 直接讀擁有者的庫（唯讀） | 第 12 站的 `reporting` | 擁有者改 schema 你就壞；它是共享資料庫的一種 —— 只是少了「寫」 |

第 12 站其實已經把「所有權」寫成了規則：`TableOwnershipTest` 規定每一個模組只能讀寫自己的表（`reporting` 例外：唯讀），`MigrationOwnershipTest` 規定 migration 只能動自己模組的表，每個模組在自己的 migration 裡替自己的表授權（第 12 站 1.6.4、2.9.4、9.11）。**它缺的是物理上的那一步**：所有模組都在同一個資料庫、用同一個帳號 —— 規則是測試守的，資料庫本身不知道。

### 2.3.4 從一個資料庫到兩個：三個階段

| 階段 | 長什麼樣子 | 跨模組的交易 | 跨模組的 JOIN | 誰能寫別人的表 |
|---|---|---|---|---|
| ① 一個 schema（第 12 站） | 所有的表在同一個庫 | ✅ | ✅ | 規則與測試說不行；資料庫說可以 |
| ② 一台伺服器、每個服務一個 schema | 兩個庫在同一台 MySQL | ✅ 同一條連線可以寫兩個庫（InnoDB） | ✅ 寫得出來（`shop_d02_inv.inventory`） | 看帳號：同一個角色就可以（2.4.4） |
| ③ 每個服務自己的伺服器 | 兩台 MySQL | ❌ | ❌ | 連不到 |

這一站的實驗一直在 ②：一台 compose 的 MySQL、兩個庫。**② 是一個很好的過渡階段，也是一個很危險的終點**：它看起來已經拆了，但跨庫的交易與 JOIN 都還寫得出來 —— 只要有一個人寫了，你就回到 ①，而且這一次沒有 `TableOwnershipTest` 守著。

這一章的做法：**用 ② 做實驗，但程式碼照 ③ 寫**。也就是：

- 每個服務只跑自己的 migration，自己的庫只有自己的表（2.4）；
- 程式碼裡不出現任何跨庫的 SQL —— 對帳用 API（2.6）、建立商品用事件（2.7）、搬家用兩條連線（2.8）；
- 跨庫的 JOIN 只出現在實驗裡，用來當「標準答案」，而且每一次出現都會標出來。

### 2.3.5 第 12 站已經做了一半

第 12 站的幾個決定，到這一章才看得出它們值多少：

| 第 12 站的決定 | 這一章省下來的 |
|---|---|
| 跨模組不建外鍵（1.5.5、2.2.3） | 搬表的時候，沒有外鍵要拆 —— `inventory.product_id`、`inventory_reservations.order_id` 本來就只是 id |
| 跨模組只用 id，不用 JPA 關聯（1.5.5） | 庫存模組的程式碼裡沒有任何一個 `@ManyToOne Product` |
| 每個模組在自己的 migration 裡替自己的表授權（9.11） | 庫存的 migration 帶著自己的 `GRANT` 搬家；新的庫一跑完，授權就在了 |
| migration 檔名帶模組（2.9.4） | 依模組分資料夾是一個 `git mv` 的迴圈（2.4.1） |
| 只有 `InventoryApi` 能改變庫存（1.5.2） | 2.4.6 要遠端化的介面只有 13 個方法 |

沒做到的那一半，就是這一章要做的：資料真的分開、分開之後消失的東西怎麼補。

---

## 2.4 動手：把庫存的資料切出來

這一節做四件事：migration 依模組分資料夾（正式程式碼）、每個服務只跑自己的資料夾、一個守門測試、一套「誠實的」實驗支架。做完之後，2.2 的 ③ —— 誠實的庫、13 個方法全部走 HTTP —— 跑得完使用者的一天。

### 2.4.0 開分支

```bash
cd shop
git switch -c d02 d01
mkdir -p src/test/java/com/example/shop/dist02
```

> 📌 **這個分支也帶著第 12 站的一個 bug 修正與一個測試的修正**：2.5.3 的 S5'（排程一張訂單失敗，同一批的其他張都不處理，第 12 站 4.7.1）、`EventFlowTest.mailerDownDeadLetters` 讀死信佇列讀得太早（2.10，第 12 站 7.7.3）。照著改了的話，整套 `mvn clean verify` 多一個測試（`OrderJobsIsolationTest`）。

### 2.4.1 migration 依模組分資料夾

第 12 站的 25 個 migration 全部放在 `db/migration/` 底下，檔名帶模組（第 12 站 2.9.4：`V3__inventory_create_tables.sql`）。拆開之後，庫存服務只該跑庫存的那幾個 —— 最直接的做法是**一個模組一個資料夾**：

```bash
cd src/main/resources/db/migration
for f in V*.sql; do
  m=$(echo $f | sed -E 's/^V[0-9]+__([a-z]+)_.*/\1/')     # 檔名裡的模組
  mkdir -p $m && git mv $f $m/$f
done
cd -
```

```
db/migration/
├── account/       V1、V16
├── cart/          V4、V19
├── catalog/       V2、V9、V10、V17
├── inventory/     V3、V13、V18、V24、V25
├── notification/  V7、V22
├── ordering/      V5、V11、V12、V20
├── payment/       V6、V21
└── shared/        V8、V14、V15、V23
```

**單體一行設定都不用改。** Flyway 掃描 `classpath:db/migration` 時會往下走進子資料夾，所以單體照舊看到 25 個 migration。

**已經有資料的庫呢？** `flyway_schema_history` 記的是版本、說明、檔名與 checksum —— 檔案內容沒變，checksum 就沒變；記的檔名也只是檔名，不含資料夾。拿第 01 章的實驗庫（`shop_d01`，25 個 migration 都跑過）起一次單體，看 Flyway 怎麼說：

```bash
mvn -q spring-boot:run -Dspring-boot.run.arguments="--spring.datasource.url=jdbc:mysql://localhost:3306/shop_d01?useSSL=false&allowPublicKeyRetrieval=true&connectionTimeZone=UTC --server.port=18399 --shop.order.jobs-enabled=false --shop.inventory.jobs-enabled=false --shop.messaging.relay-enabled=false --shop.messaging.consumers-enabled=false"
```

```
2026-10-13T15:49:47.571+08:00  INFO 67053 --- [shop] [           main] [                                                 ] o.f.c.internal.license.VersionPrinter    : Flyway Community Edition 9.22.3 by Redgate
2026-10-13T15:49:47.597+08:00  INFO 67053 --- [shop] [           main] [                                                 ] org.flywaydb.core.FlywayExecutor         : Database: jdbc:mysql://localhost:3306/shop_d01 (MySQL 8.0)
2026-10-13T15:49:47.655+08:00  INFO 67053 --- [shop] [           main] [                                                 ] o.f.core.internal.command.DbValidate     : Successfully validated 25 migrations (execution time 00:00.029s)
2026-10-13T15:49:47.666+08:00  INFO 67053 --- [shop] [           main] [                                                 ] o.f.core.internal.command.DbMigrate      : Current version of schema `shop_d01`: 25
2026-10-13T15:49:47.668+08:00  INFO 67053 --- [shop] [           main] [                                                 ] o.f.core.internal.command.DbMigrate      : Schema `shop_d01` is up to date. No migration necessary.
2026-10-13T15:49:49.788+08:00  INFO 67053 --- [shop] [           main] [                                                 ] com.example.shop.ShopApplication         : Started ShopApplication in 3.978 seconds (process running for 4.134)
```

驗證通過、沒有要跑的 migration。（看到這幾行就可以 Ctrl-C。）

> ⚠️ **搬完檔案一定要 `mvn clean`。** 沒有 clean 就跑：
> ```
> org.flywaydb.core.api.FlywayException: Found more than one migration with version 1
> Offenders:
> -> …/target/classes/db/migration/V1__account_create_tables.sql (SQL)
> -> …/target/classes/db/migration/account/V1__account_create_tables.sql (SQL)
> ```
> `target/classes` 裡舊位置的檔案還在 —— 第 12 站 2.9.5 的第四條規則（刪了 migration，要 `mvn clean`），搬檔案也算刪。下面示範 `MigrationOwnershipTest` 變紅、把 V18 搬走又搬回來之後，也要 `mvn clean`（不然是 `version 18`）。

還有四個地方用「`db/migration/` 底下直接就是檔案」的假設讀這個資料夾，要一起改：

- **`MigrationOwnershipTest`**（第 12 站 2.9.4）：`Files.list` 改成 `Files.walk`，並多一條規則 ——**資料夾就是檔名裡的那個模組**。之後有人把庫存的 migration 放錯資料夾，庫存服務就會少跑一個：

```diff
  *  ③ V10 之後，一個檔案最多一句 DDL（2.2.2 坑二：MySQL 的 DDL 不在交易裡）
+ *  ④ 13 站 2.4.1：檔案放在 db/migration/<模組>/ 底下，資料夾就是檔名裡的那個模組 —— 拆開之後，每個服務只跑自己的資料夾（加上 shared）
  */
…
-        try (Stream<Path> s = Files.list(DIR)) { files = s.sorted().toList(); }
+        try (Stream<Path> s = Files.walk(DIR)) { files = s.filter(Files::isRegularFile).sorted().toList(); }
…
+            String folder = DIR.relativize(p.getParent()).toString();
+            if (!folder.equals(f.group(2)))
+                violations.add("%s：放在 %s，應該放在 db/migration/%s/（13 站 2.4.1）".formatted(name, folder.isEmpty() ? "db/migration/" : "db/migration/" + folder + "/", f.group(2)));
```

  故意把 `V18__inventory_app_grants.sql` 搬進 `shared/`：
  ```
  檢查了 25 個 migration
    ✗ V18__inventory_app_grants.sql：放在 db/migration/shared/，應該放在 db/migration/inventory/（13 站 2.4.1）
  ```

- **驗收 Q6**（`CapstoneAcceptanceTest.q6_migrationFromScratch`，第 12 站 9.11）：它用 `Files.list` 數「磁碟上最新的版本」、讀每一個檔案裡宣告的 CHECK 與索引 —— 兩處都改成 `Files.walk(…).filter(Files::isRegularFile)`。不改的話它會把八個資料夾的名稱當成檔名去解析版本號。
- **第 00 章的變更耦合腳本**（`scripts/d00-change-coupling.sh`）與**第 01 章的 `CutEvaluator`**：比對 migration 路徑的正規表示式，多允許一層資料夾（`(?:[a-z]+/)?`）。以前的歷史沒有那一層，兩種都要認得。

### 2.4.2 每個服務跑自己的資料夾

部署的時候用 Spring Boot 現成的 `spring.flyway.locations` 決定跑哪些資料夾：

| 部署 | `spring.flyway.locations` |
|---|---|
| 單體（第 12 站、這一章的正式程式碼） | `classpath:db/migration`（預設，沒有改） |
| 庫存服務 | `classpath:db/migration/inventory,classpath:db/migration/shared` |
| 訂單服務（其他七個模組） | 其他每一個資料夾，加上 `shared` |

跑完之後兩個庫各有什麼（C1 ③ 的前兩行）：

```
  訂單服務的庫：[audit_logs, cart_items, categories, idempotency_keys, notifications, order_items, order_status_history, orders, outbox_events, payments, processed_messages, products, refresh_tokens, refunds, user_roles, users]
  庫存服務的庫：[audit_logs, inventory, inventory_ledger, inventory_ledger_checkpoints, inventory_ledger_watermark, inventory_reservations, outbox_events, processed_messages]
```

**`flyway_schema_history` 各一份，版本號有洞：**

```bash
docker exec shop-mysql-1 mysql -uroot -proot -e "SELECT version, script FROM shop_d02_inv.flyway_schema_history ORDER BY installed_rank"
```

```
version	script
3	V3__inventory_create_tables.sql
8	V8__shared_create_tables.sql
13	V13__inventory_reservation_counted.sql
14	V14__shared_outbox_claim_lease.sql
15	V15__shared_app_role.sql
18	V18__inventory_app_grants.sql
23	V23__shared_audit_retention.sql
24	V24__inventory_ledger_checkpoints.sql
25	V25__inventory_ledger_watermark.sql
```

版本號跳著走（3、8、13……）沒有關係：Flyway 只要求「比已經跑過的大」。真正要想的是**之後的版本號誰來發**：

- **還在同一個 repo 的時候**（這一站一直是）：版本號是全專案共用的 —— 單體還在跑全部 25 個，`V26` 不能同時有兩個。這也是一個協調點：兩個團隊同一天加 migration，會撞號。
- **庫存服務搬到自己的 repo 之後**：它的歷史就只有它自己的，版本號可以自己發。常見的做法是在那一刻做一個 **baseline**：新 repo 的第一個 migration 就是「目前的庫存 schema」，舊的那 9 個不再需要從頭跑（`spring.flyway.baseline-on-migrate`、`baseline-version`）。這一站不做這一步 —— 程式碼一直在同一個 repo 裡。

### 2.4.3 `shared` 的三張表：每個服務一份

`shared` 的 migration 建的是 `outbox_events`、`processed_messages`、`audit_logs`（第 12 站 V8、V14、V15、V23）。它們不屬於任何一個業務模組，所以兩個服務**各帶一份**，而不是放在「第三個共用的庫」：

- **outbox 一定要跟業務資料在同一個庫。** outbox 的整個意義是「事件跟業務的寫入在同一個交易裡 commit」（第 12 站 7.4.1）。庫存服務釋放預留時寫的 `inventory.stock-returned`、落帳失敗時寫的 `inventory.hot-settlement-failed`，要跟 `inventory_reservations` 的那一句 UPDATE 一起成立 —— 只有放在庫存服務自己的庫裡才做得到。
- **`processed_messages` 也是。** 消費者的冪等是「這一列跟消費的效果在同一個交易裡」（第 12 站 7.5.2）。庫存服務消費 `order.placed` 做熱點落帳，那一列要在庫存服務的庫。
- **稽核**：每個服務記自己的。查詢「一個使用者在所有服務做了什麼」變成一個跨服務的查詢（第 05、07 章）。

所以 `shared` 不是一個服務，是**每個服務都會帶的一組基礎設施**：程式碼（`shared` 套件）與它的 migration 一起，在每一個服務裡各有一份。

### 2.4.4 帳號與權限

第 12 站 9.11 讓每個模組在自己的 migration 裡替自己的表授權（`V18__inventory_app_grants.sql`：`GRANT … ON inventory TO shop_app`）。這個授權跟著資料夾一起搬：庫存服務的庫一跑完 migration，`shop_app` 就有那幾張表的權限，`inventory_ledger` 照樣只能新增（INV-5）。2.4.5 的測試檢查這件事。

**但授權跟著角色走，不跟著服務走。** 兩個服務用同一個帳號（`shop`，角色 `shop_app`）、兩個庫在同一台 MySQL 上：庫存的 migration 在 `shop_d02_inv` 裡把那幾張表授權給 `shop_app`，訂單服務拿的也是 `shop_app`。C1 ③ 順便試了一句：

```
  訂單服務的帳號（shop）讀庫存服務的庫：SELECT COUNT(*) FROM shop_d02_inv.inventory → 4（讀得到）
```

**訂單服務的帳號讀得到庫存服務的庫** —— 2.3.4 的 ② 那一格：「看帳號」。這一章的實驗沒有修它（兩個庫在同一台機器上，是實驗的簡化），但正式環境裡兩種做法擇一：

- 兩個服務在**兩台 MySQL**（2.3.4 的 ③）：連不到，就讀不到。
- 同一台 MySQL 上：**每個服務一個角色、一個帳號**（`inventory_app`、`ordering_app`……）。卡住的地方是第 12 站的 migration 把角色名稱寫死了（`TO shop_app`），而跑過的 migration 不能改內容（checksum）。出路有三條：兩台 MySQL（同一個角色名稱在兩台機器上是兩個不同的角色）；同一台、只在庫存服務的部署多跑一段授權（例如只有庫存服務的 `spring.flyway.locations` 才包含的 Flyway callback `afterMigrate.sql` —— 不能寫成 `db/migration/inventory/` 裡的新 migration，單體也跑那個資料夾）；搬到自己的 repo 時，新的 baseline 用 Flyway 的 placeholder 寫角色名稱。

**走第二條出路。** 這一段的程式碼在 `d09` 分支上（第 09 章結束的 `9a5e7b1` 之後的 commit），部署的部分用第 08、09 章的 kind 環境。每個服務一個角色（`inventory_app`、`order_app`）、一個帳號（`inventory_svc`、`order_svc`）；角色的權限由 Flyway 的 **afterMigrate callback** 給，放在 migration 之外的資料夾 —— 只有 `locations` 包含它的部署會跑：

```sql
-- 13 站 2.4.4：庫存服務自己的角色。shop_app 是每一個 migration 寫死的名字（跑過的不能改內容），
-- 兩個服務都拿它，訂單服務的帳號就讀得到庫存的表。這裡另外給一個只有庫存的表與 shared 的角色，庫存服務的帳號只拿它。
-- Flyway 的 callback：只有「這個資料夾在 locations 裡」的部署會跑它（庫存服務的 Job；共用一個庫的那一段，單體的 Job 兩個都跑）。
-- 每一次 migrate 之後都跑：GRANT 本來就可以重複。權限跟 shop_app 對同一張表的一樣 —— ServiceGrantsTest 守這一條
CREATE ROLE IF NOT EXISTS inventory_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON inventory TO inventory_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON inventory_reservations TO inventory_app;
GRANT SELECT, INSERT ON inventory_ledger TO inventory_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON inventory_ledger_checkpoints TO inventory_app;
GRANT SELECT, UPDATE ON inventory_ledger_watermark TO inventory_app;
-- shared：每個服務的庫各一份（第 02 章 2.4.3）；共用一個庫的時候，就是同一份
GRANT SELECT, INSERT, UPDATE, DELETE ON outbox_events TO inventory_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON processed_messages TO inventory_app;
GRANT SELECT, INSERT ON audit_logs TO inventory_app;
GRANT EXECUTE ON PROCEDURE purge_audit_logs TO inventory_app;
```

訂單服務的那一份（`db/grants/order-service/`）是其他六個有表的模組（帳號、購物車、商品、通知、訂單、付款；報表沒有自己的表）與 shared，一張庫存的表都沒有。三個 migration 的 Job 各自多一個位置：庫存服務的 Job 跑 `db/grants/inventory-service`、訂單服務的跑 `db/grants/order-service`、單體的兩個都跑（第 09 章 9.4：三個部署共用一個庫的那一段，只有單體的 Job 在跑）。帳號是部署平台的事，跟第 12 站建 `shop` 一樣，不寫在 migration 裡；kind 上是 `scripts/d09-kind.sh databases` 建的，Secret 每個服務一份，接在 `shop-secrets` 後面（`envFrom` 同一個 key，後面的蓋掉前面的）：

```diff
             - configMapRef: {name: shop-common}
             - configMapRef: {name: order-service}
             - secretRef: {name: shop-secrets}
+            # 13 站 2.4.4：這個服務自己的資料庫帳號（SHOP_DB_USER、SHOP_DB_PASSWORD）。
+            # 寫在 shop-secrets 後面：envFrom 有同一個 key 時，後面的蓋掉前面的
+            - secretRef: {name: order-service-db}
           ports:
             - {name: http, containerPort: 8080}
             - {name: management, containerPort: 8081}
```

授權是一份手抄的清單 —— `shop_app` 的授權在每一個模組的 migration 裡，callback 只能照抄。抄漏了不會有任何錯誤，只是那個服務讀不到一張新的表。`ServiceGrantsTest` 守住它：從空的庫跑三種部署的組合（庫存服務自己的庫、訂單服務自己的庫、共用的庫），比對每一個角色在每一張表、每一個程序上的權限，必須跟 `shop_app` 對同一張表的一樣，而且只限自己的表：

```
13 站 2.4.4 的追記：庫存服務的庫，inventory_app 有權限的表與程序 9 個；訂單服務的庫，order_app 18 個；共用的庫，inventory_app 9 個、order_app 18 個（shop_app 23 個）
```

這個帳號在共用一個庫的那一段擋住了什麼、什麼都沒擋住，量在第 09 章 9.4.6。

### 2.4.5 守住：`ServiceDatabaseTest`

`MigrationOwnershipTest` 檢查每一個檔案只動自己模組的表；它不知道「把庫存的資料夾單獨拿出來跑」會不會成功。一個 migration 只要用到別的模組的表（外鍵、`INSERT … SELECT`、一個 view），在單體的庫裡跑得過，在庫存服務的庫裡就失敗 —— 那是部署的那一刻才會發現的事。

所以多一個測試：**從空的資料庫，只用庫存的資料夾加上 `shared` 跑一次 Flyway；再用其他資料夾跑一次**。兩邊建出來的表，要剛好等於第 12 站 `TableOwnershipTest` 那張對照表裡各自的那一份；庫存服務的庫，每一張表都要授權給 `shop_app`。

```java
package com.example.shop.architecture;

import com.example.shop.support.TestInfra;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;
import java.util.stream.Collectors;
import java.util.stream.Stream;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 13 站 2.4.5：拆開之後，每一個服務只跑自己的 migration 資料夾（加上 shared）。這個測試守住「各自跑得起來，而且剛好是自己的表」：
 *
 *   庫存服務：db/migration/inventory + shared → 剛好是庫存模組的表 + shared 的三張，每一張都授權給 shop_app（AppGrantsTest 的規則）
 *   其他    ：其餘每一個資料夾       → 剛好是其他模組的表 + shared 的三張，一張庫存的表都沒有
 *
 * 會紅的例子：庫存的資料夾裡有一個 migration 用到了別的模組的表（外鍵、INSERT … SELECT）—— 在一個資料庫裡跑得過，自己跑就失敗；
 * 或者新的庫存表忘了授權。表與模組的對照用第 12 站 TableOwnershipTest 的那一張。
 * 是 @SpringBootTest：Testcontainers 的 MySQL 在第一個 Spring 應用程式啟動時才起（TestInfra）
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.NONE)
class ServiceDatabaseTest {

    @Test @DisplayName("13 站 2.4.5：庫存的資料夾＋shared、其他資料夾＋shared，各自從空資料庫跑得起來，而且剛好是自己的表")
    void eachServiceBuildsItsOwnDatabase() throws Exception {
        Map<String, String> owner = TableOwnershipTest.OWNER;
        Set<String> inventory = owner.entrySet().stream().filter(e -> Set.of("inventory", "shared").contains(e.getValue()))
                .map(Map.Entry::getKey).collect(Collectors.toCollection(TreeSet::new));
        Set<String> rest = owner.entrySet().stream().filter(e -> !e.getValue().equals("inventory"))
                .map(Map.Entry::getKey).collect(Collectors.toCollection(TreeSet::new));
        List<String> others;
        try (Stream<Path> s = Files.list(Path.of("src/main/resources/db/migration"))) {
            others = s.filter(Files::isDirectory).map(p -> p.getFileName().toString()).filter(m -> !m.equals("inventory")).sorted()
                    .map(m -> "classpath:db/migration/" + m).toList();
        }
        Map<String, Set<String>> got = new TreeMap<>();
        got.put("inventory", migrate("shop_svc_inventory", "classpath:db/migration/inventory", "classpath:db/migration/shared"));
        got.put("其他", migrate("shop_svc_rest", others.toArray(String[]::new)));
        System.out.printf("13 站 2.4.5：庫存服務的庫 %d 張表 %s%n            其他的庫 %d 張表%n", got.get("inventory").size(), got.get("inventory"), got.get("其他").size());
        assertThat(got.get("inventory")).isEqualTo(inventory);
        assertThat(got.get("其他")).isEqualTo(rest);
        Map<String, Set<String>> grants = inventoryGrants;
        assertThat(grants.keySet()).as("庫存服務的庫：每一張表都授權給 shop_app").isEqualTo(inventory);
        assertThat(grants.get("inventory_ledger")).as("INV-5：帳只能新增").isEqualTo(Set.of("SELECT", "INSERT"));
    }

    Map<String, Set<String>> inventoryGrants = new TreeMap<>();

    /** 從空的資料庫，只用這幾個資料夾跑 Flyway（跟正式環境一樣用 shop_migrator）；回傳建出來的表（庫存服務的庫順便記下授權） */
    Set<String> migrate(String db, String... locations) {
        JdbcTemplate admin = TestInfra.adminJdbc();
        admin.execute("DROP DATABASE IF EXISTS " + db);
        admin.execute("CREATE DATABASE " + db);
        admin.execute("GRANT ALL PRIVILEGES ON `" + db + "`.* TO 'shop_migrator'@'%' WITH GRANT OPTION");
        Flyway.configure().dataSource(TestInfra.jdbcUrl(db), "shop_migrator", "shop_migrator").locations(locations).load().migrate();
        Set<String> tables = new TreeSet<>(admin.queryForList(
                "SELECT table_name FROM information_schema.tables WHERE table_schema = ? AND table_name <> 'flyway_schema_history'", String.class, db));
        if (db.equals("shop_svc_inventory"))
            admin.query("SELECT table_name, privilege_type FROM information_schema.table_privileges WHERE table_schema = ? AND grantee = \"'shop_app'@'%'\"",
                    rs -> { inventoryGrants.computeIfAbsent(rs.getString(1), k -> new TreeSet<>()).add(rs.getString(2)); }, db);
        admin.execute("DROP DATABASE " + db);
        return tables;
    }

}
```

- 它在預設的測試組裡（Testcontainers）。在整套裡約 1 秒（兩次 Flyway）；單獨跑一次約 18 秒，大部分是在等 Testcontainers 的 MySQL 起來 —— 它標 `@SpringBootTest`，就是為了這件事：容器在第一個 Spring 應用程式啟動時才起（第 12 站 8.4.2）。
- 用的是 `shop_migrator`，跟正式環境一樣（第 12 站 9.11）。
- **`TableOwnershipTest` 那張表不用分**：它本來就是「表 → 模組」的對照，這個測試直接拿它當答案。它現在多了一個用途 —— 決定每一個服務的庫裡該有哪幾張表。程式碼真的分成兩個 repo 的那一天，各帶走自己那幾行；在那之前，它是兩個服務共同的「誰擁有什麼」。

綠的時候：

```
13 站 2.4.5：庫存服務的庫 8 張表 [audit_logs, inventory, inventory_ledger, inventory_ledger_checkpoints, inventory_ledger_watermark, inventory_reservations, outbox_events, processed_messages]
            其他的庫 16 張表
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.946 s -- in com.example.shop.architecture.ServiceDatabaseTest
```

**故意把它弄紅一次** —— 用最誘人的那個錯誤：庫存跟商品「明明有關係」，把外鍵加回去。在 `inventory/` 加一個 `V26__inventory_product_fk.sql`：

```sql
ALTER TABLE inventory ADD CONSTRAINT fk_inventory_product FOREIGN KEY (product_id) REFERENCES products (id);
```

```
  ✗ V26__inventory_product_fk.sql：屬於 inventory 模組，卻動了 catalog 模組的表 `products`
[ERROR] Tests run: 1, Failures: 1, Errors: 0, Skipped: 0, Time elapsed: 0.130 s <<< FAILURE! -- in com.example.shop.architecture.MigrationOwnershipTest
[ERROR] Tests run: 1, Failures: 0, Errors: 1, Skipped: 0, Time elapsed: 15.23 s <<< FAILURE! -- in com.example.shop.architecture.ServiceDatabaseTest
Message    : Failed to open the referenced table 'products'
Caused by: java.sql.SQLException: Failed to open the referenced table 'products'
[ERROR]   MigrationOwnershipTest.migrationsFollowModuleOwnership:64 
[ERROR]   ServiceDatabaseTest.eachServiceBuildsItsOwnDatabase:48->migrate:66 » FlywayMigrate Migration V26__inventory_product_fk.sql failed
```

兩個守門員都紅了，說的是同一件事的兩面：`MigrationOwnershipTest` 說「你動了 catalog 的表」，`ServiceDatabaseTest` 說「你在庫存服務的庫裡，打不開 `products`」。在單體的庫裡，這個 migration 會成功 —— 而且會帶來第 12 站 2.2.3 量過的那種鎖：賣家改價時，下單要等外鍵檢查。刪掉那個檔案，`mvn clean`。

### 2.4.6 實驗支架：一個 JVM、兩個服務

第 00 章的支架（`SplitLab`）還在，K1～K5 照舊用它。這一章另外做一套，差在三件事：

| | 第 00 章 | 這一章（`dist02`） |
|---|---|---|
| 資料庫 | 兩個庫都跑全部的 migration（`Schema.SHARED`） | 各跑各的資料夾（`Schema.HONEST`） |
| `InventoryApi` 走 HTTP 的 | `reserve`、可售量 | **13 個方法全部** |
| 庫存服務 | 另一個 JVM（`ProcessBuilder`） | 同一個 JVM 的另一個 Spring context |

**為什麼這一次放在同一個 JVM**：第 00 章量的是延遲與連線池，兩個 JVM 才誠實（兩個服務不共用執行緒、不共用 JIT）。這一章量的是「資料落在哪裡」，而使用者的一天要把事件交給**另一個服務**的消費者（例如訂單服務寫的 `order.placed`，交給庫存服務的熱點落帳）—— 在同一個 JVM 裡，才拿得到另一個服務的 bean。

`src/test/java/com/example/shop/dist02/` 這一節的五個檔案：

```
dist02/
├── Split.java               ← 建兩個庫、起兩個服務（誠實的或第 00 章的）
├── RemoteInventory.java     ← 訂單服務那一側：InventoryApi 的 13 個方法全部走 HTTP（lab.d02.remote-inventory-url）
├── InventoryEndpoints.java  ← 庫存服務那一側：POST /lab/d02/inventory/{op}（lab.d02.inventory-service=true）
├── DbTap.java               ← 每一句碰到模組的表的 SQL，送到了哪一個庫、是哪一段程式碼送的
└── C1SharedSchemaTest.java  ← 2.2、2.4.7
```

**`Split`：起服務的關鍵幾行**

```java
    static List<String> args(String db, int redisDb, Schema schema, boolean inventoryService, boolean validate) throws Exception {
        List<String> a = new ArrayList<>(SplitLab.common(db, redisDb));
        a.removeIf(x -> x.startsWith("--spring.datasource.url="));          // 同一個參數給兩次，Spring 會用逗號接起來（第 01 章 1.4.5）
        a.add("--spring.datasource.url=" + SplitLab.url(db) + "&queryInterceptors=" + DbTap.class.getName());
        if (schema == Schema.HONEST)
            a.add("--spring.flyway.locations=" + (inventoryService ? INVENTORY_ONLY : withoutInventory()));
        // 2.4.6 小坑：第 12 站的 ddl-auto=validate 檢查「所有」實體 —— 庫存的兩個實體在訂單服務的庫找不到表，商品、訂單的實體在庫存服務的庫找不到
        if (!validate) a.add("--spring.jpa.hibernate.ddl-auto=none");
        if (inventoryService) a.add("--shop.security.bootstrap-admin.enabled=false");   // 庫存服務的庫沒有 users 表
        a.add("--lab.d01.probe=true");                                      // 第 01 章的 ApiTap：HTTP 請求標上「哪一個動作」（OpTag）
        return a;
    }
```

三個開關各有一個故事：

- **`spring.flyway.locations`**：2.4.2 的那張表。`withoutInventory()` 列出 `db/migration` 底下除了 `inventory` 的每一個資料夾 —— 之後多一個模組的資料夾，不用改這裡。
- **`ddl-auto=none`**：2.2 ② 的那兩行 `Schema-validation: missing table`。第 12 站的 `validate` 是對的（schema 只由 Flyway 管，Hibernate 只檢查），但它檢查的是**整個單體**的實體。拆開之後，每個服務該驗證的只有自己的實體 —— 那要等程式碼也分開（每個服務一個 jar）。實驗裡兩個服務跑同一個 jar，只好關掉。
- **`bootstrap-admin.enabled=false`**：第 12 站「一個管理員都沒有時建立第一個」（US-ACC-3 AC-3）會查 `users` —— 庫存服務的庫沒有這張表，起不來。**同一個 jar、兩個角色**（哪些 bean 該在哪個服務上活著）是第 03 章 3.7 的事；這一章用開關湊過去。

**`RemoteInventory`：13 個方法全部走 HTTP**

```java
    private JsonNode call(String op, Map<String, ?> body) {
        String res = http.post().uri("/lab/d02/inventory/" + op).body(body).retrieve()
                .onStatus(HttpStatusCode::isError, (req, r) -> { throw decode(r.getStatusCode().value(), new String(r.getBody().readAllBytes())); })
                .body(String.class);
        try {
            return res == null || res.isEmpty() ? json.createObjectNode() : json.readTree(res);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    /** 庫存服務的 Problem Details → 呼叫端在本地會拿到的同一個例外 */
    RuntimeException decode(int status, String body) {
        try {
            JsonNode p = json.readTree(body);
            String type = p.path("type").asText();
            for (ProblemType pt : ProblemType.values()) {
                if (!pt.type().toString().equals(type) || pt == ProblemType.INTERNAL) continue;
                if (pt == ProblemType.INSUFFICIENT_STOCK) return new InsufficientStockException(p.get("productId").asLong());
                ShopException e = new ShopException(pt, p.path("detail").asText());
                for (Iterator<Map.Entry<String, JsonNode>> it = p.fields(); it.hasNext(); ) {
                    var f = it.next();
                    if (!STANDARD.contains(f.getKey())) e.with(f.getKey(), f.getValue().isNumber() ? f.getValue().numberValue() : f.getValue().asText());
                }
                return e;
            }
        } catch (Exception notJson) { /* 落到下面 */ }
        return new IllegalStateException("庫存服務回應 " + status + "：" + body);
    }

    @Override public void initialize(long productId, int onHand, String note) { call("initialize", Map.of("productId", productId, "onHand", onHand, "note", note)); }
    @Override public void reserve(long orderId, List<ReserveLine> lines) { call("reserve", Map.of("orderId", orderId, "lines", lines)); }
    @Override public void holdHot(long orderId, List<ReserveLine> lines) { call("hold-hot", Map.of("orderId", orderId, "lines", lines)); }
    @Override public void confirm(long orderId) { call("confirm", Map.of("orderId", orderId)); }
    @Override public void release(long orderId) { call("release", Map.of("orderId", orderId)); }
    @Override public void consume(long orderId) { call("consume", Map.of("orderId", orderId)); }
```

- **錯誤照第 12 站的 Problem Details 傳回來**，在這裡還原成同一個例外：庫存不足還是 `InsufficientStockException`（呼叫端照舊回 409），出貨時「還在落帳」還是 503 的 `ShopException`。呼叫端的程式碼一行都不用改 —— 這是這一章要的：先讓資料分開，介面的樣子是第 03 章的事。
- **它不是服務之間該有的介面**：13 個 Java 方法原封不動搬到 HTTP 上（`POST /lab/d02/inventory/{op}`），沒有版本、沒有認證、沒有冪等鍵。第 03 章重做。

**`InventoryEndpoints`：第 12 站標 `MANDATORY` 的 7 個方法，在這裡自己開交易**

```java
        @PostMapping("/lab/d02/inventory/{op}")
        Map<?, ?> call(@PathVariable String op, @RequestBody JsonNode b) {
            switch (op) {
                case "initialize" -> tx.executeWithoutResult(s -> inventory.initialize(b.get("productId").asLong(), b.get("onHand").asInt(), b.get("note").asText()));
                case "reserve" -> tx.executeWithoutResult(s -> inventory.reserve(b.get("orderId").asLong(), lines(b)));
                case "hold-hot" -> tx.executeWithoutResult(s -> inventory.holdHot(b.get("orderId").asLong(), lines(b)));
                case "confirm" -> tx.executeWithoutResult(s -> inventory.confirm(b.get("orderId").asLong()));
                case "release" -> tx.executeWithoutResult(s -> inventory.release(b.get("orderId").asLong()));
                case "consume" -> tx.executeWithoutResult(s -> inventory.consume(b.get("orderId").asLong()));
                case "set-hot" -> tx.executeWithoutResult(s -> inventory.setHot(b.get("productId").asLong(), b.get("hot").asBoolean()));
                case "restock" -> inventory.restock(b.get("productId").asLong(), b.get("quantity").asInt(), b.get("note").asText());
                case "gate-hot" -> inventory.gateHot(lines(b));
                case "return-hot" -> inventory.returnHot(lines(b));
                case "available-for-display" -> { return Map.of("value", inventory.availableForDisplay(b.get("productId").asLong(), b.get("hot").asBoolean())); }
                case "available-one" -> { return Map.of("value", inventory.available(b.get("productId").asLong())); }
                case "available" -> {
                    List<Long> ids = new ArrayList<>();
                    b.get("productIds").forEach(x -> ids.add(x.asLong()));
                    return inventory.available(ids);
                }
                case "active-reservations" -> {
                    return Map.of("rows", inventory.activeReservations(b.get("afterId").asLong(), java.time.Instant.parse(b.get("createdBefore").asText()), b.get("limit").asInt()));
                }
                case "reservations-of" -> {
                    List<Long> ids = new ArrayList<>();
                    b.get("orderIds").forEach(x -> ids.add(x.asLong()));
                    return Map.of("rows", inventory.reservationsOf(ids).values().stream().flatMap(List::stream).toList());
                }
                case "release-abandoned" -> inventory.releaseAbandoned(b.get("orderId").asLong());
                default -> throw new IllegalArgumentException("沒有這個操作：" + op);
            }
            return Map.of();
        }
```

第 00 章 0.2.0 那一行 `tx.executeWithoutResult` —— 「呼叫端的交易在另一個行程，這裡只能自己開一個、自己 commit」—— 現在是 7 行。**每一行都是一個被切成兩半的交易**，2.5.3 會一個一個讓它失敗。

**`DbTap`：SQL 落在哪一個庫**

跟第 01 章的 `SqlTap` 同一個掛勾（Connector/J 的 query interceptor），問的問題不一樣：`SqlTap` 問「一個交易寫了哪些模組」，`DbTap` 問「這一句送到哪一個資料庫、是哪一段程式碼送的」。兩個服務在同一個 JVM 裡，記在同一個地方：

```java
    @Override
    public <T extends Resultset> T preProcess(Supplier<String> sql, Query query) {
        …                                                                   // 找出這一句碰到哪一張模組的表（寫優先，其次是 FROM／JOIN）
        STMTS.add(new Stmt(db(), table, Probe.OWNER.get(table), write, site(), OpTag.current()));
        return null;
    }

    private String db() {
        try {
            return conn.getCatalog();                                       // Connector/J 記著目前的資料庫，不會再問一次 MySQL
        } catch (Exception e) {
            return "?";
        }
    }

    /** 呼叫堆疊上第一個「模組 internal」的 frame：JdbcInventoryService.initialize、ProductService.create…… */
    static String site() { … }
```

**`D01Workload`：使用者的一天跑在兩個服務上**

第 01 章的工作負載假設「一個 context、一個資料庫」。改成每一個模組屬於一個服務（一個 context、一個資料庫）：HTTP 一律打訂單服務（它是使用者看到的那一個）；事件從**每一個服務自己的 outbox** 讀出來，交給「擁有那個消費者所屬模組」的服務；排程在擁有它的服務上跑；直接改資料的 SQL 送到擁有那張表的庫。一個行程的時候，八個模組（第 01 章 1.4 的那八個，`shared` 不算）都屬於同一個 context —— 行為跟第 01 章一模一樣（B1 照舊能跑，2.9.3）。

```java
    /**
     * outbox 裡還沒送出的事件，交給訂閱它的每一個消費者（不經過 RabbitMQ），直到沒有新的事件。每一次交付標成「事件 X → 消費者」。
     * 切開的部署：每一個服務的資料庫各有一個 outbox；消費者交給「擁有它所屬模組」的那個服務（用那個服務的 EventDispatcher：processed_messages 在它自己的庫）
     */
    void events() throws Exception {
        for (int round = 0; round < 10; round++) {
            boolean any = false;
            for (String db : new java.util.TreeSet<>(dbOf.values())) {
                List<Event> pending = new ArrayList<>();
                List<Long> ids = new ArrayList<>();
                try (Connection c = SplitLab.root(db); PreparedStatement ps = c.prepareStatement(
                        "SELECT id, event_id, aggregate_type, aggregate_id, event_type, payload, created_at FROM outbox_events WHERE published_at IS NULL ORDER BY id");
                     ResultSet rs = ps.executeQuery()) {
                    while (rs.next()) {
                        ids.add(rs.getLong(1));
                        pending.add(new Event(rs.getString(2), rs.getString(5), rs.getString(3), rs.getLong(4), rs.getTimestamp(7).toInstant(),
                                json.readTree(rs.getString(6)), 1));
                    }
                }
                if (pending.isEmpty()) continue;
                any = true;
                for (Event e : pending)
                    for (ConfigurableApplicationContext owner : new java.util.LinkedHashSet<>(ctxOf.values()))
                        for (EventHandler h : owner.getBeansOfType(EventHandler.class).values()) {
                            if (!h.eventTypes().contains(e.type())) continue;
                            String consumerModule = moduleOfClass(AopTestUtils.getUltimateTargetObject(h).getClass().getName());
                            if (ctxOf.get(consumerModule) != owner) continue;            // 這個消費者的模組不在這個服務上
                            EventDispatcher dispatcher = owner.getBean(EventDispatcher.class);
                            Probe.EVENTS.add(new Probe.Event("事件 " + e.type() + " → " + h.consumer(), e.type(), publisherOf(e.type()), h.consumer(), consumerModule));
                            OpTag.run("事件 " + e.type() + " → " + h.consumer(), () -> dispatcher.dispatch(h, e));
                        }
                try (Connection c = SplitLab.root(db); PreparedStatement ps = c.prepareStatement("UPDATE outbox_events SET published_at = NOW(3) WHERE id = ?")) {
                    for (long id : ids) { ps.setLong(1, id); ps.executeUpdate(); }
                }
            }
            if (!any) return;
        }
        throw new IllegalStateException("事件一直產生新的事件，交付了 10 輪還沒停");
    }
```

`OpTag`、`Probe` 與 `D01Workload` 為此改成 `public`（`dist02` 在另一個套件）。完整的檔案在 2.10.1。

### 2.4.7 跑起來：使用者的一天在誠實的兩個庫上

C1 的 ③：誠實的庫、`RemoteInventory`。

```
═══ 2.4.7 ③ 誠實的庫，InventoryApi 的 13 個方法全部走 HTTP（load { 3.25 4.21 4.85 }）═══
  訂單服務的庫：[audit_logs, cart_items, categories, idempotency_keys, notifications, order_items, order_status_history, orders, outbox_events, payments, processed_messages, products, refresh_tokens, refunds, user_roles, users]
  庫存服務的庫：[audit_logs, inventory, inventory_ledger, inventory_ledger_checkpoints, inventory_ledger_watermark, inventory_reservations, outbox_events, processed_messages]
  使用者的一天：61 個 HTTP 請求全部是預期的回應
  庫存的表收到的 SQL（送出的程式碼 → 哪一個庫：句數）：
    HotStock.initialize                            → shop_d02_inv：1
    HotStock.reconcile                             → shop_d02_inv：1
    InventoryReconciliation.checkIncremental       → shop_d02_inv：1
    InventoryReconciliation.lambda$checkIncremental$5 → shop_d02_inv：3
    JdbcInventoryService.activeReservations        → shop_d02_inv：1
    JdbcInventoryService.available                 → shop_d02_inv：16
    JdbcInventoryService.confirm                   → shop_d02_inv：4
    JdbcInventoryService.consume                   → shop_d02_inv：8
    JdbcInventoryService.held                      → shop_d02_inv：6
    JdbcInventoryService.holdHot                   → shop_d02_inv：2
    JdbcInventoryService.initialize                → shop_d02_inv：4
    JdbcInventoryService.ledger                    → shop_d02_inv：17
    JdbcInventoryService.release                   → shop_d02_inv：6
    JdbcInventoryService.reserve                   → shop_d02_inv：10
    JdbcInventoryService.restock                   → shop_d02_inv：1
    JdbcInventoryService.settleHot                 → shop_d02_inv：8
  shop_d02_order ：沒有庫存的表
  shop_d02_inv   ：inventory 4 列、inventory_reservations 7 列、inventory_ledger 17 列
  訂單服務的帳號（shop）讀庫存服務的庫：SELECT COUNT(*) FROM shop_d02_inv.inventory → 4（讀得到）
  訂單服務在自己的交易裡呼叫庫存服務：10 種（動作 × 方法）—— 每一種都是「兩個交易」
    POST /api/orders                                 InventoryApi.holdHot
    POST /api/orders                                 InventoryApi.reserve
    POST /api/orders/{orderNo}/cancel                InventoryApi.release
    POST /api/payments/callback                      InventoryApi.confirm
    POST /api/seller/orders/{orderNo}/cancel         InventoryApi.release
    POST /api/seller/orders/{orderNo}/ship           InventoryApi.consume
    POST /api/seller/products                        InventoryApi.initialize
    POST /api/seller/products/{id}/hot               InventoryApi.setHot
    事件 inventory.hot-settlement-failed → ordering.stock-shortage InventoryApi.release
    排程 OrderJobs.cancelExpired                       InventoryApi.release
  （結束時 load { 3.47 4.23 4.86 }）
```

**61 個請求全部是預期的回應**，`DbTap` 記到的每一句庫存 SQL 都在 `shop_d02_inv`，訂單服務的庫沒有任何一張庫存的表。資料真的分開了。

最後那張清單才是這一節真正的結果：**訂單服務在自己的交易裡呼叫庫存服務，10 種。** 其中 8 種就是第 01 章 1.2 那 7 種切斷的交易（下單用了兩個方法：`reserve`、`holdHot`）：付款回呼（`confirm`）、出貨（`consume`）、兩種取消與逾時排程（`release`）、建立商品（`initialize`）。另外兩種：標熱點（`setHot`：在 catalog 的交易裡呼叫，但它只在 commit 之後寫 Redis，所以第 01 章沒有把它算成切斷的交易）、落帳失敗的消費者（`release`：這一次它要釋放的那一列已經是 `RELEASED`，沒寫到庫存的表）。在一個資料庫裡，它們每一個都是一個交易；現在，每一個都是**兩個**：庫存服務的那一個在回應之前就 commit 了，訂單服務的那一個之後才 commit —— 或者 rollback。

**全綠不代表對。** 使用者的一天走的都是快樂的路徑，兩個交易都成功。下一節讓第二個失敗。

---

## 2.5 外鍵消失之後：參照完整性誰守

### 2.5.1 第 12 站本來就沒有跨模組的外鍵

「拆資料庫最痛的是外鍵」—— 這句話在很多系統是對的，在第 12 站不是。第 12 站 1.5.5 決定跨模組只存 id、不建外鍵，2.2.3 量過理由（跨模組外鍵讓賣家批次改價時全站無法下單）。V3 的兩行註解：

```sql
  product_id  BIGINT       NOT NULL,                     -- catalog.products.id：跨模組，不建外鍵
  …
  order_id    BIGINT       NOT NULL,                     -- ordering.orders.id：跨模組，不建外鍵
```

庫存模組**裡面**的兩個外鍵（預留 → 庫存列、帳 → 庫存列）跟著搬家，在新的庫裡照樣成立。所以這一刀切下去，沒有任何一個外鍵要拆。

那「每一筆預留都屬於一張存在的訂單」以前是誰守的？**交易。** 預留跟訂單在同一個交易裡建立、在同一個交易裡改變狀態 —— 要嘛一起成立，要嘛一起不存在。沒有外鍵，參照完整性照樣成立，因為根本沒有一個時間點讓它們分開。

**資料庫分開之後，消失的不是外鍵，是那個交易。** 2.4.7 那 10 種交易內的遠端呼叫，每一種都是一個被切成兩半的交易。

### 2.5.2 跨過這一刀的參照與不變量

把「一起成立」寫成具體的規則。跨過庫存這一刀的參照有兩條：

| 參照 | 以前誰保證 | 拆開之後會出現的不一致 |
|---|---|---|
| `inventory.product_id` → 商品 | 建立商品的交易（`initialize` 是 `MANDATORY`，第 12 站 1.5.2） | 有商品、沒有庫存列（商品頁 500，第 00 章 0.2.3 的 ⚠️）；有庫存列、沒有商品 |
| `inventory_reservations.order_id` → 訂單 | 下單、付款、出貨、取消的交易 | 有預留、沒有訂單（第 00 章 0.2.2 的孤兒）；預留的狀態跟訂單的狀態對不上 |

第二條不只是「存在」，還有**狀態要對得上**。照第 12 站的狀態機（0.5.1）與 `OrderTransitionService.sideEffects()`：

| 訂單 | 它的每一筆預留應該是 |
|---|---|
| 不存在、`CANCELLED` | 沒有，或 `RELEASED` |
| `PENDING_PAYMENT` | `HELD` |
| `PAID`、`PICKING` | `CONFIRMED` |
| `SHIPPED`、`COMPLETED` | `CONSUMED` |

這張表在一個資料庫裡是「交易保證的事實」，拆開之後變成「要有人檢查的不變量」—— 跟第 12 站的 INV-2、INV-3 一樣，從「寫入時保證」退到「事後對帳」（第 12 站 0.4.6 的 📌：對帳承認一件事：你的程式會有 bug）。差別是：INV-2、INV-3 在一個資料庫裡，一句 SQL 就能檢查；這一條跨兩個資料庫（2.6）。

### 2.5.3 切斷的交易失敗時，留下什麼

2.4.7 的使用者的一天全部成功。現在讓訂單服務那一半失敗：**庫存服務的交易已經 commit，訂單服務的交易接著 rollback。** 失敗的注入跟第 00 章 0.2.2 ① 同一招 —— 訂單服務的庫上一個 trigger，寫訂單狀態歷史的那一句被拒絕。第 12 站每一次狀態轉移都是「改訂單 → 副作用（呼叫庫存）→ 寫歷史 → outbox」（`OrderTransitionService.apply()`），所以拒絕「寫歷史」就是「遠端已經做完、本地在最後失敗」：

```java
    void installTrigger() throws Exception {
        exec(Split.ORDER_DB, "CREATE TABLE d02_fail (buyer_id BIGINT NOT NULL, order_no VARCHAR(30) NOT NULL, to_status VARCHAR(20) NOT NULL)");
        exec(Split.ORDER_DB, """
                CREATE TRIGGER d02_fail_after_remote BEFORE INSERT ON order_status_history FOR EACH ROW
                BEGIN
                  IF EXISTS (SELECT 1 FROM d02_fail f JOIN orders o ON o.id = NEW.order_id
                              WHERE f.to_status = NEW.to_status AND (f.order_no = o.order_no OR f.buyer_id = o.buyer_id)) THEN
                    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'd02: injected failure after the remote inventory call';
                  END IF;
                END""");
    }
```

（`Ops.java`：哪一張訂單、轉移到哪一個狀態時失敗，寫在 `d02_fail` 這張表；把一張訂單走到某個狀態的 HTTP 動作也在這裡。完整的檔案在 2.10.1。）

每一種情境一張新的訂單、一個新的商品（庫存 100 件，±1 才看得出來），看兩個庫各剩下什麼；然後看**下一步** —— 使用者再按一次、或者做了別的事：

```bash
mvn test -Pexperiments -Dtest=C2BrokenTransactionTest
```

```
═══ 2.5.3 切斷的交易：庫存服務已經 commit，訂單服務的交易接著失敗（load { 4.87 5.47 4.57 }）═══
  情境                         │ 回應 │ 訂單            │ 預留       │ 庫存 on_hand / reserved │ 付款 / 退款單
  S1 下單                        │  500 │ （不存在）           │ HELD（沒有訂單） │ 100 / 1                 │ — / 0
     同一個鍵重送                    │  201 │ PENDING_PAYMENT │ HELD（沒有訂單）,HELD │ 100 / 2                 │ — / 0
  S2 付款回呼                      │  500 │ PENDING_PAYMENT │ CONFIRMED  │ 100 / 1                 │ PENDING / 0
     金流重送同一個回呼                 │  200 │ PAID            │ CONFIRMED  │ 100 / 1                 │ SUCCEEDED / 0
  S3 買家取消（已付款）                 │  500 │ PAID            │ RELEASED   │ 100 / 0                 │ SUCCEEDED / 0
     買家再按一次取消                  │  200 │ CANCELLED       │ RELEASED   │ 100 / 0                 │ SUCCEEDED / 1
  S3' 買家取消（已付款）                │  500 │ PAID            │ RELEASED   │ 100 / 0                 │ SUCCEEDED / 0
     賣家沒注意到，開始撿貨               │  200 │ PICKING         │ RELEASED   │ 100 / 0                 │ SUCCEEDED / 0
     出貨                        │  409 │ PICKING         │ RELEASED   │ 100 / 0                 │ SUCCEEDED / 0
      出貨的回應：{"type":"/problems/invalid-state","title":"目前的狀態不允許這個動作","status":409,"detail":"這張訂單有商品庫存不足，即將取消，不能出貨","instance":"/api/seller/orders/20261013-302015/ship","traceId":"6acdde963c27a1972cac2e75f25cda3c"}
  S4 出貨                        │  500 │ PICKING         │ CONSUMED   │ 99 / 0                  │ SUCCEEDED / 0
     賣家再按一次出貨                  │  200 │ SHIPPED         │ CONSUMED   │ 99 / 0                  │ SUCCEEDED / 0
  S4' 出貨                       │  500 │ PICKING         │ CONSUMED   │ 99 / 0                  │ SUCCEEDED / 0
     賣家以為沒出成，改成取消              │  200 │ CANCELLED       │ CONSUMED   │ 99 / 0                  │ SUCCEEDED / 1
  S5 逾時排程                      │    — │ PENDING_PAYMENT │ RELEASED   │ 100 / 0                 │ — / 0
     排程的下一輪                    │    — │ CANCELLED       │ RELEASED   │ 100 / 0                 │ — / 0
  S5' 逾時排程：第一張（失敗）             │    — │ PENDING_PAYMENT │ RELEASED   │ 100 / 0                 │ — / 0
      第二張（沒有注入失敗）              │    — │ CANCELLED       │ RELEASED   │ 100 / 0                 │ — / 0
  （結束時 load { 4.87 5.47 4.57 }）
```

每一個情境的第一行，使用者看到的都是 500（或排程的一行錯誤日誌）。**差別全在第二行：下一步做了什麼。**

**重做同一件事，會收斂**（S1 以外）：

- **S2 金流重送回呼** → `PAID` + `CONFIRMED`。`confirm()` 只改 `status = 'HELD'` 的那幾列，第二次是 0 列。
- **S3 買家再按一次取消** → `CANCELLED` + `RELEASED`，退款單也建了。`release()` 只釋放 `HELD`、`CONFIRMED`，第二次什麼都不做。
- **S4 賣家再按一次出貨** → `SHIPPED`，庫存只扣了一次（99）。`consume()` 只處理 `CONFIRMED`，第二次是 0 列。
- **S5 排程的下一輪** → `CANCELLED`。排程本來就每 30 秒重試一次。

它們會收斂，是因為第 12 站的庫存操作**都用狀態當條件** —— 那是為了別的理由寫的（重複的回呼、兩個排程實例，第 12 站 4.7.2），切開之後變成了「遠端那一半可以重做」的保證。**這是 Saga 的前提之一：每一步都要能安全地重做**（第 04 章）。

**S1 是例外：重做會變成另一張訂單。** 冪等鍵在第一次失敗時被釋放了（第 12 站 4.5.1 AC-4），同一個鍵重送是一張新的訂單、一筆新的預留 —— 第一筆預留沒有人會回來收（第 00 章 0.2.2 ② 的同一件事）。

**改做別的事，就不會收斂：**

- **S3'：已付款的取消做了一半，賣家沒注意到，開始撿貨、出貨。** 撿貨成功（訂單是 `PAID`，可以撿）；出貨 409：「這張訂單有商品庫存不足，即將取消，不能出貨」。這句話來自第 12 站 7.6.4 —— 為熱點落帳失敗寫的防線（落帳發現不夠、預留已經 `RELEASED`、取消的事件還在路上）。它在這裡擋對了：庫存已經還回去了，再出貨就是出一件不存在的貨。**但「即將取消」不會發生**：這一次沒有任何事件在路上。這張訂單**已付款、庫存已經不在、出不了貨、也不會被取消** —— 永遠卡在 `PICKING`，直到有人發現。
- **S4'：出貨做了一半，賣家以為沒出成，改成取消。** 取消成功、退款單也建了；但 `consume()` 已經 commit：`on_hand` 少了 1 件。**貨還在倉庫裡，帳上說它已經出去了** —— 這件商品以後永遠少賣 1 件，直到盤點。

兩個都是「兩邊各自都正確」：S3' 的訂單服務說「已付款、撿貨中」，庫存服務說「這張訂單的預留已經釋放」；各自的不變量（第 12 站的 INV-1～INV-5）全部成立。錯的是 2.5.2 那張表。

> 📌 **S3'、S4' 在第 04 章的 Saga 上重跑過，兩個都收斂**（第 04 章 4.10.6 的 E7：同一個失敗的注入、同樣的下一步，事件走 RabbitMQ）。失敗的那一刻，兩個庫**都沒變** —— 付款、取消、出貨、逾時的交易裡已經沒有遠端呼叫，通知庫存的事件跟訂單的狀態寫在同一個交易裡，rollback 就兩個都沒有。S3' 的賣家照常撿貨、出貨（取消沒有發生，買家看到的是那一次的 500）；S4' 改成取消之後，預留釋放、退款單建了，`on_hand` 一件都沒少。最後跑一輪對帳：0 張。

> ⚠️ **S5' 碰到的是第 12 站的一個 bug。** 沒有修的話，S5' 是這樣：
> ```
>   S5' 逾時排程：第一張（失敗）             │    — │ PENDING_PAYMENT │ RELEASED   │ 100 / 0                 │ — / 0
>       第二張（沒有注入失敗）              │    — │ PENDING_PAYMENT │ HELD       │ 100 / 1                 │ — / 0
>       排程丟出例外：SQLException: d02: injected failure after the remote inventory call
> ```
> 同一輪排程有兩張逾時的訂單，第一張失敗，**第二張就沒有被取消** —— 例外跳出了整個迴圈。`OrderJobs` 的註解寫著「每張訂單各自一個交易：一張失敗不影響其他張」（第 12 站 4.7.1 ①），但 `applyEach()` 只接 `ShopException`（業務上的拒絕）；資料庫錯誤（死鎖、鎖等待逾時）是 `DataAccessException`，不在裡面。在單體裡這很少見；**切開之後，遠端呼叫的每一種失敗（逾時、連不上、對方 500）都是這一種例外**，而且失敗的那一張排在最前面（`ORDER BY payment_deadline`）—— 它每一輪都會再失敗一次，後面的訂單一張都取消不了。
> 修法是多接一層 `RuntimeException`（記一筆 ERROR、繼續下一張），測試是 `OrderJobsIsolationTest`（第 12 站，`ordering.internal`）：用一個 trigger 讓第一張的取消在資料庫裡失敗，看第二張。修正前紅（`UncategorizedSQLException` 跳出 `cancelExpired()`），修正後 `取消了 1 張；第一張（注入失敗）PENDING_PAYMENT、第二張 CANCELLED`。細節在第 12 站 4.7.1。上面那張表是修正之後跑的。

**這一節的結論：**

1. **切斷的交易，失敗之後留下的是「庫存領先訂單」的狀態**：遠端呼叫在本地 commit 之前，所以只會是「庫存那一邊做了、訂單這一邊沒做」，不會反過來。
2. **重做同一件事會收斂；改做別的事、或沒有人重做，就不會。** 而「沒有人重做」正是最常見的情況：使用者看到 500，可能就走了。
3. 所以需要一個**不靠使用者**的機制，去找出這些狀態 —— 2.6 的對帳。它找得到的，也只有一部分修得了（2.6.4）。真正讓它們不再產生的，是第 04 章。

---

## 2.6 JOIN 消失之後：對帳

### 2.6.1 最直接的做法，少了什麼

第 00 章 0.2.2 那句數孤兒的 SQL 跨了兩個資料庫。兩個庫在兩台機器上的時候，最直接的做法是兩邊各問一次、在程式裡做差集：keyset 分頁（`WHERE id > ? ORDER BY id LIMIT 500`）讀庫存那邊還佔著庫存（`HELD`、`CONFIRMED`）的預留，每一批用 `IN` 問訂單那邊這些 `order_id` 哪些存在。

它要兩個前提才不會誤判：

- **grace：只看建立超過一段時間的預留。** 0.2.2 的順序是訂單 INSERT → 預留（庫存服務**自己 commit**）→ 歷史、冪等鍵、outbox → 訂單 commit。在最後那個 commit 之前，「預留已經在、訂單還不存在」—— 每一張**正常的**訂單在這幾毫秒（慢的時候幾秒）裡看起來都是孤兒。grace 要比最長的下單請求還長；代價是一筆孤兒最快也要 grace 之後才會被發現。
- **rollback 掉的 `order_id` 不會被重用。** 訂單 id 是 MySQL 的自動遞增，rollback 不會把號碼還回去，MySQL 8 也會把計數器存下來 —— 所以「孤兒的訂單之後才出現」不會發生。如果訂單 id 改成由外部產生（例如客戶端給的 UUID），這個前提要重新檢查。

把它放進正式程式碼之前，拿 2.5.3 的表對一下：它只找得到 **S1**（沒有訂單的預留）。S3'（已付款、預留已釋放）、S4（撿貨中、預留已出庫）、S2（待付款、預留已確認）—— 訂單都存在，「孤兒」的定義抓不到。要檢查的是 2.5.2 那張**狀態對照表**，不只是「存在」。

還有三件它沒有回答的事：

- **放在哪裡**：最直接的寫法是一支程式同時連兩個庫；正式的程式碼不能這樣（每個服務只連自己的庫，2.4.4）。
- **找到之後做什麼**：只數不夠。
- **多久跑一次、多貴**：第 12 站的種子資料是 30 萬筆預留。

### 2.6.2 對帳放在哪一個模組

兩個選擇：

- **庫存**：它擁有預留。但它要問「這些訂單存在嗎、是什麼狀態」—— 庫存模組就要依賴訂單模組。第 12 站的依賴是 `ordering → inventory`，反過來就是一個循環（`ModuleBoundaryTest` 的 `no_cycles_between_modules` 會紅）。
- **訂單**：它已經依賴庫存（下單、取消都在呼叫 `InventoryApi`），而 2.5.2 那張表本來就是**訂單的規則**：「這張訂單此刻應該佔著什麼庫存」是訂單的狀態機決定的。

放在 ordering。這也跟第 04 章接得起來：Saga 的編排者（orchestrator）就是訂單，「下單流程卡在一半」由它負責收尾 —— 對帳是它的最後一道防線。

**資料怎麼拿**：訂單那一邊，ordering 自己讀 `orders`（自己的表）；庫存那一邊，透過 `InventoryApi` 問。一個行程的時候是方法呼叫，切開之後是 HTTP —— **對帳的程式碼不用改**，這是「先拆模組」的那一步：在還沒拆的時候，就把跨模組的 JOIN 換成 API。

### 2.6.3 庫存那一邊多三個方法

```java
    // ───────── 13 站 2.6：跨模組的對帳（ordering 的 ReservationReconciliation）─────────
    // 「預留」與「訂單」在同一個資料庫裡時，一句 JOIN 就能對；拆開之後，兩邊各問各的、在程式裡比。這三個方法是庫存那一邊

    /** 還佔著庫存（HELD、CONFIRMED）、建立早於 createdBefore 的預留，依 id 由小到大（keyset 分頁：id > afterId）。不開交易：一句 SELECT */
    List<ReservationRef> activeReservations(long afterId, java.time.Instant createdBefore, int limit);

    /** 這些訂單的預留，各是什麼狀態（一張訂單有幾個品項就有幾筆）。沒有任何預留的訂單不會出現在結果裡 */
    Map<Long, List<ReservationRef>> reservationsOf(Collection<Long> orderIds);

    /**
     * 釋放一張「不存在、或已經取消」的訂單還佔著的預留：跟 release() 做一樣的事，但自己開交易 —— release() 是 MANDATORY，
     * 因為它本來要跟訂單的狀態一起 commit；對帳找到的這種預留，訂單那邊沒有東西要一起 commit。冪等：已經釋放的不會再釋放。
     * 「這張訂單不存在或已取消」由呼叫端（ordering）判斷：庫存模組不知道訂單
     */
    void releaseAbandoned(long orderId);
```

`ReservationRef` 是庫存模組公開套件裡的一個 record（`id, orderId, productId, quantity, status`）：別的模組看得到預留的 id 與狀態，看不到 `Reservation` 這個實體（它在 `internal`）。

`JdbcInventoryService` 的實作：

```java
    @Override
    public List<ReservationRef> activeReservations(long afterId, java.time.Instant createdBefore, int limit) {
        return jdbc.query("""
                SELECT id, order_id, product_id, quantity, status FROM inventory_reservations
                 WHERE id > ? AND status IN ('HELD', 'CONFIRMED') AND created_at < ? ORDER BY id LIMIT ?""",
                (rs, i) -> new ReservationRef(rs.getLong(1), rs.getLong(2), rs.getLong(3), rs.getInt(4), rs.getString(5)),
                afterId, java.sql.Timestamp.from(createdBefore), limit);
    }

    @Override
    public Map<Long, List<ReservationRef>> reservationsOf(Collection<Long> orderIds) {
        Map<Long, List<ReservationRef>> result = new HashMap<>();
        if (orderIds.isEmpty()) return result;
        String in = String.join(",", orderIds.stream().map(id -> "?").toList());
        jdbc.query("SELECT id, order_id, product_id, quantity, status FROM inventory_reservations WHERE order_id IN (" + in + ") ORDER BY id",
                rs -> { result.computeIfAbsent(rs.getLong(2), k -> new ArrayList<>())
                        .add(new ReservationRef(rs.getLong(1), rs.getLong(2), rs.getLong(3), rs.getInt(4), rs.getString(5))); },
                orderIds.toArray());                                         // uk_reservations_order_product 的最左欄
        return result;
    }

    @Override
    @Transactional
    public void releaseAbandoned(long orderId) {
        release(orderId);                                                   // 同一個物件裡呼叫：不經過代理，MANDATORY 不檢查 —— 這個交易就是它的交易
    }
```

- 兩個讀都**沒有** `@Transactional(readOnly = true)`：一句 SELECT，不需要交易；有的話 MySQL 多收 5 句（第 12 站 6.2.3）。
- `releaseAbandoned` 為什麼可以放心釋放：「訂單不存在」的那幾張，是 rollback 掉的訂單 —— 訂單 id 是 MySQL 的自動遞增，rollback 不會把號碼還回去（2.6.1 的第二個前提），所以它**永遠不會**再出現；「訂單已取消」的，本來就該釋放。兩種都沒有人會再用到那些庫存。

### 2.6.4 `ReservationReconciliation`：兩個方向、五種不一致、只修兩種

```java
package com.example.shop.ordering.internal;

import com.example.shop.inventory.InventoryApi;
import com.example.shop.inventory.ReservationRef;
import com.example.shop.shared.config.ShopProperties;
import io.micrometer.core.instrument.Gauge;
import io.micrometer.core.instrument.MeterRegistry;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

import java.sql.Timestamp;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Collection;
import java.util.EnumMap;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.atomic.AtomicLong;

/**
 * 13 站 2.6：預留 ⇄ 訂單的跨模組對帳。
 *
 * 一個資料庫的時候，「每一筆預留都屬於一張存在的訂單」是一句 JOIN（第 00 章 0.2.2 數孤兒的那一句）；
 * 庫存搬到另一個資料庫之後，那句 JOIN 不存在 —— 兩邊各問各的，在這裡比。放在 ordering：ordering 本來就依賴 inventory
 * （反過來會變成循環，ModuleBoundaryTest），而且「這張訂單此刻應該佔著什麼」是訂單的規則。
 *
 * 訂單的狀態 → 它的預留應該是什麼（2.5.2）：
 *   不存在、CANCELLED    → 沒有，或 RELEASED
 *   PENDING_PAYMENT      → HELD
 *   PAID、PICKING        → CONFIRMED
 *   SHIPPED、COMPLETED   → CONSUMED
 *
 * 兩個方向各掃一次（keyset 分頁，一批 500）：
 *   ① 庫存那一邊還佔著（HELD、CONFIRMED）的預留 → 它的訂單
 *   ② 訂單這一邊還沒結束（PENDING_PAYMENT、PAID、PICKING）的訂單 → 它的預留
 * 只有 X-1、X-2 自動修（釋放）：訂單不存在或已取消，沒有人會再用到那些庫存。其他的只告警 —— 要不要重新預留、要不要取消一張已付款的訂單，
 * 是人的決定（2.6.4）。
 * 比 grace 新的都不看：下單的交易可能還沒 commit（2.6.1）、熱點落帳的事件可能還在路上（第 12 站 7.6）。
 */
@Component
class ReservationReconciliation {

    private static final Logger log = LoggerFactory.getLogger(ReservationReconciliation.class);

    enum Check {
        X1("預留還佔著，訂單不存在", true),
        X2("預留還佔著，訂單已取消", true),
        X3("訂單還沒結束，預留已釋放或不存在", false),
        X4("訂單還沒出貨，預留已出庫", false),
        X5("訂單與預留的狀態對不上（其他）", false);

        final String meaning;
        final boolean autoRelease;

        Check(String meaning, boolean autoRelease) {
            this.meaning = meaning;
            this.autoRelease = autoRelease;
        }

        String id() { return "X-" + name().substring(1); }
    }

    record Finding(Check check, long orderId, String orderStatus, List<String> reservations) {}

    /** millis：整輪；inventorySideMillis、orderSideMillis：① 與 ② 各花多久（2.6.6 量規模用） */
    record Result(int reservationsScanned, int ordersScanned, int batches, List<Finding> findings, int released, long millis,
                  long inventorySideMillis, long orderSideMillis) {
        long count(Check c) { return findings.stream().filter(f -> f.check() == c).count(); }
    }

    static final int BATCH = 500;
    static final List<String> LIVE = List.of("PENDING_PAYMENT", "PAID", "PICKING");

    private final JdbcTemplate jdbc;
    private final InventoryApi inventory;
    private final Clock clock;
    private final ShopProperties props;
    private final Map<Check, AtomicLong> last = new EnumMap<>(Check.class);

    ReservationReconciliation(JdbcTemplate jdbc, InventoryApi inventory, Clock clock, ShopProperties props, MeterRegistry meters) {
        this.jdbc = jdbc;
        this.inventory = inventory;
        this.clock = clock;
        this.props = props;
        for (Check c : Check.values()) {
            last.put(c, new AtomicLong());
            Gauge.builder("shop.reconciliation.cross", last.get(c), AtomicLong::get).tag("check", c.id())
                    .description("預留 ⇄ 訂單的對帳，上一輪找到幾張訂單（13 站 2.6）：X-1、X-2 已自動釋放；其他要有人看").register(meters);
        }
    }

    Result run() { return run(props.order().reservationGrace()); }

    Result run(Duration grace) {
        long t0 = System.nanoTime();
        Instant cutoff = clock.instant().minus(grace);
        List<Finding> findings = new ArrayList<>();
        int reservations = 0, orders = 0, batches = 0;

        // ① 庫存那一邊：還佔著庫存的預留，它的訂單在不在、是什麼狀態
        long after = 0;
        while (true) {
            List<ReservationRef> page = inventory.activeReservations(after, cutoff, BATCH);
            if (page.isEmpty()) break;
            batches++;
            reservations += page.size();
            after = page.get(page.size() - 1).id();
            Map<Long, List<ReservationRef>> byOrder = new HashMap<>();
            page.forEach(r -> byOrder.computeIfAbsent(r.orderId(), k -> new ArrayList<>()).add(r));
            Map<Long, String> status = statuses(byOrder.keySet());
            byOrder.forEach((orderId, rs) -> {
                String s = status.get(orderId);
                Check c = s == null ? Check.X1
                        : s.equals("CANCELLED") ? Check.X2
                        : s.equals("PENDING_PAYMENT") && rs.stream().anyMatch(r -> r.status().equals("CONFIRMED")) ? Check.X5
                        : s.equals("SHIPPED") || s.equals("COMPLETED") ? Check.X5
                        : null;
                if (c != null) findings.add(new Finding(c, orderId, s, rs.stream().map(ReservationRef::status).toList()));
            });
        }

        long t1 = System.nanoTime();

        // ② 訂單這一邊：還沒結束的訂單，它的預留還在不在
        long afterOrder = 0;
        while (true) {
            List<long[]> page = new ArrayList<>();
            Map<Long, String> status = new HashMap<>();
            jdbc.query("""
                    SELECT id, status FROM orders WHERE id > ? AND status IN ('PENDING_PAYMENT', 'PAID', 'PICKING') AND updated_at < ?
                     ORDER BY id LIMIT ?""", rs -> {
                page.add(new long[]{rs.getLong(1)});
                status.put(rs.getLong(1), rs.getString(2));
            }, afterOrder, Timestamp.from(cutoff), BATCH);
            if (page.isEmpty()) break;
            batches++;
            orders += page.size();
            afterOrder = page.get(page.size() - 1)[0];
            Map<Long, List<ReservationRef>> rs = inventory.reservationsOf(status.keySet());
            status.forEach((orderId, s) -> {
                List<String> mine = rs.getOrDefault(orderId, List.of()).stream().map(ReservationRef::status).toList();
                String want = s.equals("PENDING_PAYMENT") ? "HELD" : "CONFIRMED";
                Check c = mine.isEmpty() || mine.contains("RELEASED") ? Check.X3
                        : mine.contains("CONSUMED") ? Check.X4
                        : mine.stream().anyMatch(x -> !x.equals(want)) && !s.equals("PENDING_PAYMENT") ? Check.X5   // 待付款 + CONFIRMED 在 ① 已經算過
                        : null;
                if (c != null) findings.add(new Finding(c, orderId, s, mine));
            });
        }

        long t2 = System.nanoTime();

        // X-1、X-2：釋放。一張失敗不影響其他張（第 12 站 4.7.1 ① 的追記）
        int released = 0;
        Set<Long> abandoned = new LinkedHashSet<>();
        findings.stream().filter(f -> f.check().autoRelease).forEach(f -> abandoned.add(f.orderId()));
        for (long orderId : abandoned) {
            try {
                inventory.releaseAbandoned(orderId);
                released++;
            } catch (RuntimeException e) {
                log.error("CROSS_RECONCILIATION 釋放訂單 {} 的預留失敗（下一輪再試）", orderId, e);
            }
        }

        for (Check c : Check.values()) last.get(c).set(findings.stream().filter(f -> f.check() == c).count());
        findings.stream().limit(20).forEach(f -> {
            if (f.check().autoRelease) log.warn("CROSS_RECONCILIATION {} {}：訂單 {}（{}）的預留 {} —— 已釋放", f.check().id(), f.check().meaning, f.orderId(), f.orderStatus(), f.reservations());
            else log.error("CROSS_RECONCILIATION {} {}：訂單 {}（{}）的預留 {}", f.check().id(), f.check().meaning, f.orderId(), f.orderStatus(), f.reservations());
        });
        Result r = new Result(reservations, orders, batches, findings, released, (System.nanoTime() - t0) / 1_000_000,
                (t1 - t0) / 1_000_000, (t2 - t1) / 1_000_000);
        if (!findings.isEmpty() || log.isDebugEnabled())
            log.info("CROSS_RECONCILIATION 掃了 {} 筆預留、{} 張訂單（{} 批，{} ms）：找到 {} 張，釋放 {} 張",
                    r.reservationsScanned(), r.ordersScanned(), r.batches(), r.millis(), findings.size(), released);
        return r;
    }

    /** 這些訂單各是什麼狀態；不存在的不會在結果裡 */
    private Map<Long, String> statuses(Collection<Long> ids) {
        Map<Long, String> m = new HashMap<>();
        if (ids.isEmpty()) return m;
        String in = String.join(",", ids.stream().map(x -> "?").toList());
        jdbc.query("SELECT id, status FROM orders WHERE id IN (" + in + ")", rs -> { m.put(rs.getLong(1), rs.getString(2)); }, ids.toArray());
        return m;
    }
}
```

**兩個方向各掃一次**，因為各有一半的不一致只有從那一邊看得到：

| 方向 | 掃什麼 | 找得到 | 找不到 |
|---|---|---|---|
| ① 庫存那一邊 | 還佔著庫存（`HELD`、`CONFIRMED`）的預留 → 問它的訂單 | X-1 沒有訂單（S1）、X-2 已取消、X-5 待付款卻已確認（S2） | 預留已經不佔庫存的：S3'、S4 |
| ② 訂單這一邊 | 還沒結束（待付款、已付款、撿貨中）的訂單 → 問它的預留 | X-3 預留已釋放或不存在（S3'、S5）、X-4 已出庫（S4） | 訂單已經不存在、或已經結束的：S1 |

**只自動修 X-1、X-2**：訂單不存在或已取消，那些庫存沒有人會再用到 —— 釋放是唯一正確的動作，而且冪等。其他三種**只告警**，因為正確的動作要看情況：

| | 不一致 | 自動修？ | 正確的動作 |
|---|---|---|---|
| X-1 | 預留還佔著，訂單不存在 | ✅ 釋放 | —— |
| X-2 | 預留還佔著，訂單已取消 | ✅ 釋放 | —— |
| X-3 | 訂單還沒結束，預留已釋放或不存在 | ❌ 告警 | 重新預留（可能已經不夠了）？還是取消一張**已付款**的訂單、退款？—— 要看庫存、要聯絡買家，是人的決定 |
| X-4 | 訂單還沒出貨，預留已出庫 | ❌ 告警 | 貨出了沒有？出了就補按出貨；沒出就要把庫存加回去（盤點）—— 系統不知道倉庫裡發生了什麼 |
| X-5 | 其他對不上（待付款卻已確認……） | ❌ 告警 | 多半會自己收斂（金流重送回呼、逾時排程）；放太久才需要人 |

**為什麼不讓對帳把 X-3 修掉？** 2.5.3 的 S3' 是「買家取消了、但取消只做了一半」—— 正確的結果是「取消、退款」。可是對帳看到的只有「已付款的訂單、預留已釋放」；同樣的狀態也可能來自「熱點落帳失敗、取消的事件還在路上」（第 12 站 7.6.3），那時候正確的結果是「等事件送到」。**對帳知道兩邊對不上，不知道為什麼** —— 自動修只能修那些「不管為什麼，答案都一樣」的。

**grace**：比它新的都不看（預設 5 分鐘）。在一個行程裡也會有短暫的不一致 —— 熱點落帳失敗時，預留先變成 `RELEASED`、訂單幾秒後才被取消（第 12 站 7.6.3）；在 grace 之內的不算。

**排程**：`ReconciliationJobs`，跟逾時取消同一個開關（`shop.order.jobs-enabled`），每 5 分鐘一次，不在啟動的那一刻跑：

```java
package com.example.shop.ordering.internal;

import com.example.shop.shared.config.ShopProperties;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.annotation.EnableScheduling;
import org.springframework.scheduling.annotation.SchedulingConfigurer;
import org.springframework.scheduling.config.FixedDelayTask;
import org.springframework.scheduling.config.ScheduledTaskRegistrar;

/**
 * 13 站 2.6.4：預留 ⇄ 訂單的對帳排程。跟逾時取消一樣由 shop.order.jobs-enabled 開關（實驗要可重現的資料時關掉）。
 * 不在啟動的那一刻跑：第一次在一個間隔之後（跟第 12 站 7.10 的庫存對帳同一個理由）。
 * 多台機器同時跑不需要鎖：釋放是冪等的（已經 RELEASED 的不會再釋放），告警重複一次無妨。
 */
@Configuration(proxyBeanMethods = false)
@EnableScheduling
@ConditionalOnProperty(name = "shop.order.jobs-enabled", havingValue = "true", matchIfMissing = true)
class ReconciliationJobs implements SchedulingConfigurer {

    private final ReservationReconciliation reconciliation;
    private final ShopProperties props;

    ReconciliationJobs(ReservationReconciliation reconciliation, ShopProperties props) {
        this.reconciliation = reconciliation;
        this.props = props;
    }

    @Override
    public void configureTasks(ScheduledTaskRegistrar registrar) {
        var every = props.order().reservationCheckInterval();
        registrar.addFixedDelayTask(new FixedDelayTask(reconciliation::run, every, every));
    }
}
```

兩個新設定加在 `ShopProperties.Order`（`ignoreUnknownFields = false`：新設定一定要是 record 的欄位，第 12 站 1.7.3）：

```diff
             /** 逾時取消與自動完成的排程（4.7）。實驗需要可重現的資料時關掉它 */
-            @DefaultValue("true") boolean jobsEnabled) {}
+            @DefaultValue("true") boolean jobsEnabled,
+            /** 13 站 2.6：預留 ⇄ 訂單的跨模組對帳（ReservationReconciliation）多久跑一次 */
+            @NotNull @DefaultValue("5m") @DurationMin(seconds = 10) Duration reservationCheckInterval,
+            /** 13 站 2.6：比這個新的不一致不算 —— 下單的交易可能還沒 commit、熱點落帳的事件可能還在路上 */
+            @NotNull @DefaultValue("5m") @DurationMin(seconds = 1) Duration reservationGrace) {}
```

**指標**：`shop.reconciliation.cross{check="X-1"…"X-5"}`，上一輪找到幾張。第 12 站 9.10 的告警規則可以照 `shop.reconciliation.diff` 的寫法加一條（X-3、X-4 大於 0 就要有人看）—— 這一章沒有改 `alerts.yml`。

### 2.6.5 測試

一個資料庫裡也測得到：用 SQL 直接做出 2.5.3 在切開的部署裡留下的那幾種狀態，每一種一張訂單；再加一筆「太新」的孤兒（在 grace 裡，不能動）與一張一致的訂單（不能被報出來）：

```java
package com.example.shop.ordering.internal;

import com.example.shop.support.TestInfra;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;

import java.time.Duration;
import java.util.Map;
import java.util.TreeMap;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 13 站 2.6.5：預留 ⇄ 訂單的對帳。一個資料庫裡也測得到 —— 用 SQL 直接做出第 2.5.3 節（C2）在切開的部署裡留下的那幾種狀態，
 * 每一種一張訂單；再加一筆「太新」的孤兒（還在 grace 裡，不能動）和一張一致的訂單（不能被報出來）。
 * 其他測試留下的資料也會被掃到（同一個資料庫）：只檢查這裡自己的訂單。
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.NONE, properties = "shop.order.jobs-enabled=false")
class ReservationReconciliationTest {

    static final long P = 900_881, BUYER = 990_088, BASE = 99_088_000L;
    static final long ORPHAN = BASE, CANCELLED = BASE + 1, PAID_RELEASED = BASE + 2, PICKING_CONSUMED = BASE + 3,
            PENDING_CONFIRMED = BASE + 4, YOUNG_ORPHAN = BASE + 5, FINE = BASE + 6;

    @Autowired JdbcTemplate jdbc;
    @Autowired ReservationReconciliation reconciliation;

    @Test @DisplayName("2.6：孤兒與已取消 → 釋放；已付款卻已釋放、撿貨中卻已出庫、待付款卻已確認 → 告警；太新的、一致的不動")
    void findsAndReleases() {
        JdbcTemplate admin = TestInfra.adminJdbc();
        cleanup(admin);
        try {
            // 庫存：on_hand 100，reserved = 還佔著的那幾筆（孤兒 1、已取消 1、待付款卻已確認 1、太新的孤兒 1、一致的 1）
            jdbc.update("INSERT INTO inventory (product_id, on_hand, reserved) VALUES (?, 100, 5)", P);
            admin.update("INSERT INTO inventory_ledger (product_id, delta_on_hand, delta_reserved, reason, ref) VALUES (?, 100, 0, 'INITIAL', 'x'), (?, 0, 5, 'RESERVE', 'x')", P, P);
            order(CANCELLED, "CANCELLED");
            order(PAID_RELEASED, "PAID");
            order(PICKING_CONSUMED, "PICKING");
            order(PENDING_CONFIRMED, "PENDING_PAYMENT");
            order(FINE, "PAID");
            reservation(ORPHAN, "HELD", true);                               // C2 的 S1：下單失敗，預留留下來
            reservation(CANCELLED, "CONFIRMED", true);
            reservation(PAID_RELEASED, "RELEASED", true);                    // C2 的 S3'：已付款、庫存已經還回去
            reservation(PICKING_CONSUMED, "CONSUMED", true);                 // C2 的 S4：出庫了、訂單還沒出貨
            reservation(PENDING_CONFIRMED, "CONFIRMED", true);               // C2 的 S2：付款回呼只做了一半
            reservation(YOUNG_ORPHAN, "HELD", false);                        // 剛建立：下單的交易可能還沒 commit
            reservation(FINE, "CONFIRMED", true);

            ReservationReconciliation.Result r = reconciliation.run(Duration.ofMinutes(1));

            Map<Long, String> mine = new TreeMap<>();
            r.findings().stream().filter(f -> f.orderId() >= BASE && f.orderId() < BASE + 100).forEach(f -> mine.put(f.orderId(), f.check().id()));
            Map<Long, String> after = new TreeMap<>();
            jdbc.query("SELECT order_id, status FROM inventory_reservations WHERE product_id = ?", rs -> { after.put(rs.getLong(1), rs.getString(2)); }, P);
            int reserved = jdbc.queryForObject("SELECT reserved FROM inventory WHERE product_id = ?", Integer.class, P);
            System.out.printf("2.6 對帳：%s；之後的預留 %s；reserved %d；這一輪全部 %d 筆預留、%d 張訂單、%d ms%n",
                    mine, after, reserved, r.reservationsScanned(), r.ordersScanned(), r.millis());

            assertThat(mine).containsExactlyInAnyOrderEntriesOf(Map.of(ORPHAN, "X-1", CANCELLED, "X-2", PAID_RELEASED, "X-3",
                    PICKING_CONSUMED, "X-4", PENDING_CONFIRMED, "X-5"));
            assertThat(after).containsEntry(ORPHAN, "RELEASED").containsEntry(CANCELLED, "RELEASED")
                    .containsEntry(YOUNG_ORPHAN, "HELD").containsEntry(PENDING_CONFIRMED, "CONFIRMED").containsEntry(FINE, "CONFIRMED");
            assertThat(reserved).as("釋放了兩筆").isEqualTo(3);
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM inventory_ledger WHERE product_id = ? AND reason = 'RELEASE'", Integer.class, P)).isEqualTo(2);
        } finally {
            cleanup(admin);
        }
    }

    void order(long id, String status) {
        jdbc.update("""
                INSERT INTO orders (id, order_no, buyer_id, seller_id, status, total_amount, payment_deadline, cancel_reason, paid_at, cancelled_at, created_at, updated_at)
                VALUES (?, ?, ?, 2, ?, 100, NOW(3), ?, ?, ?, NOW(3) - INTERVAL 10 MINUTE, NOW(3) - INTERVAL 10 MINUTE)""",
                id, "20990188-%06d".formatted(id - BASE), BUYER, status,
                status.equals("CANCELLED") ? "BUYER" : null,
                status.equals("PAID") || status.equals("PICKING") ? new java.sql.Timestamp(System.currentTimeMillis()) : null,
                status.equals("CANCELLED") ? new java.sql.Timestamp(System.currentTimeMillis()) : null);
    }

    void reservation(long orderId, String status, boolean old) {
        jdbc.update("INSERT INTO inventory_reservations (order_id, product_id, quantity, status, created_at) VALUES (?, ?, 1, ?, NOW(3) - INTERVAL ? MINUTE)",
                orderId, P, status, old ? 10 : 0);
    }

    void cleanup(JdbcTemplate admin) {
        admin.update("DELETE FROM outbox_events WHERE aggregate_type = 'INVENTORY' AND aggregate_id >= ? AND aggregate_id < ?", BASE, BASE + 100);
        admin.update("DELETE FROM orders WHERE buyer_id = ?", BUYER);
        admin.update("DELETE FROM inventory_reservations WHERE product_id = ?", P);
        admin.update("DELETE FROM inventory_ledger WHERE product_id = ?", P);
        admin.update("DELETE FROM inventory WHERE product_id = ?", P);
    }
}
```

```
2.6 對帳：{99088000=X-1, 99088001=X-2, 99088002=X-3, 99088003=X-4, 99088004=X-5}；之後的預留 {99088000=RELEASED, 99088001=RELEASED, 99088002=RELEASED, 99088003=CONSUMED, 99088004=CONFIRMED, 99088005=HELD, 99088006=CONFIRMED}；reserved 3；這一輪全部 4 筆預留、4 張訂單、18 ms
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.087 s -- in com.example.shop.ordering.internal.ReservationReconciliationTest
```

### 2.6.6 在切開的部署裡跑（C3）

測試證明規則寫對了；C3 證明它在切開的部署裡找得到**真的**不一致 —— 而且跟「標準答案」一樣。標準答案用跨庫 JOIN 算：兩個庫剛好在同一台 MySQL 上才寫得出來（2.3.4 的 ②），真的拆開之後它不存在。這是這一章**唯一**用到跨庫 SQL 的地方，用來檢查不能用跨庫 SQL 的那個程式。

```bash
mvn test -Pexperiments -Dtest=C3ReconciliationTest
```

```
═══ 2.6.6 ① 對帳在切開的部署裡：找得到第 2.5.3 節的不一致嗎（load { 5.35 5.55 4.61 }）═══
  做出來的：一般的訂單 50 張；下單失敗 100 張（各 3 個品項）；S2、S3'、S4 各 1 張
  跨庫 JOIN（標準答案）：{X-1=100, X-2=0, X-3=1, X-4=1, X-5=1}
  對帳（grace 2 秒）：掃了 401 筆預留、53 張訂單，2 批（549 ms：① 21 ms、② 5 ms）→ {X-1=100, X-2=0, X-3=1, X-4=1, X-5=1}；釋放 100 張
  釋放之後：庫存的 reserved 合計 401 → 101（少了 300 件）
  再跑一次：{X-1=0, X-2=0, X-3=1, X-4=1, X-5=1}；跨庫 JOIN：{X-1=0, X-2=0, X-3=1, X-4=1, X-5=1}
```

- **跟跨庫 JOIN 一樣**，五種都一樣。
- **釋放了 100 張、300 件**：第 00 章 0.2.2 ① 的那 300 件孤兒，現在有人收了。總共 549 ms，其中兩次掃描各 21 ms、5 ms，其餘是 100 次 `releaseAbandoned` —— 每一次都是一次 HTTP 加庫存服務的一個交易。
- **再跑一次，X-3、X-4、X-5 還在**：它們只告警，不會自己消失。這是設計，不是 bug。
- X-2 是 0：在這一章的程式碼裡，遠端呼叫都在本地 commit **之前**（2.5.3 的結論 1），「訂單已取消、預留還佔著」不會因為這種失敗出現。對帳照樣檢查它：第 04 章把釋放移到訂單 commit **之後**（事件驅動），它就會出現。

**多貴**：照第 12 站種子資料的規模（10 萬張訂單、30 萬筆預留；1% 待付款、2% 已付款，其他已完成）：

```
═══ 2.6.6 ② 多貴：10 萬張訂單、30 萬筆預留（灌資料 3.1 秒；load { 5.09 5.47 4.60 }）═══
  還佔著庫存的預留 9,000 筆、還沒結束的訂單 3,000 張
  第 1 輪：掃了 9000 筆預留、3000 張訂單，24 批（240 ms：① 庫存那一邊 168 ms、② 訂單那一邊 71 ms）→ 找到 {X-1=0, X-2=0, X-3=0, X-4=0, X-5=0}
  第 2 輪：掃了 9000 筆預留、3000 張訂單，24 批（268 ms：① 庫存那一邊 174 ms、② 訂單那一邊 94 ms）→ 找到 {X-1=0, X-2=0, X-3=0, X-4=0, X-5=0}
  第 3 輪：掃了 9000 筆預留、3000 張訂單，24 批（258 ms：① 庫存那一邊 189 ms、② 訂單那一邊 69 ms）→ 找到 {X-1=0, X-2=0, X-3=0, X-4=0, X-5=0}
  EXPLAIN（shop_d02_inv）[type=range key=PRIMARY rows=149283 filtered=6.67 Extra=Using where]
  EXPLAIN（shop_d02_order）[type=range key=idx_orders_status_deadline rows=3001 filtered=16.66 Extra=Using index condition; Using where; Using filesort]
  對照：跨庫 JOIN 算同一件事 190 ms → {X-1=0, X-2=0, X-3=0, X-4=0, X-5=0}
  （結束時 load { 5.48 5.55 4.63 }）
```

- **一輪 240～268 ms、24 批**（18 批預留 × 500、6 批訂單 × 500）—— 每 5 分鐘一次，可以接受；跟一句跨庫 JOIN（190 ms）差不多。
- **但兩個方向的成本長得不一樣。** ② 走 `idx_orders_status_deadline`：只碰還沒結束的那 3,000 張，跟歷史有多少張無關。① 走的是主鍵的範圍掃描（`rows=149283 filtered=6.67`）：為了找 9,000 筆還佔著的預留，**每一輪都把 30 萬筆整個掃過一次** —— 還佔著的預留散在整張表裡，每一批要往後掃很遠才湊得滿 500 筆。第 12 站 0.6.1 估三年 1,642 萬筆訂單明細 —— 每一筆明細一筆預留：同一個寫法，一輪要掃 1,600 多萬筆。
- 那時候的兩個選擇：加一個 `(status, id)` 的索引（一個 migration，庫存模組自己的事）；或者只掃「最近的」（還佔著的預留最老也就是付款期限加出貨期 —— 但一筆三個月前的孤兒就找不到了）。**這一章沒有加索引**：30 萬筆的時候 170 ms，加了也省不了多少；把這個「什麼時候該加」寫在這裡，跟第 12 站 9.12「對帳改成增量的」是同一類的決定 —— 那一次是帳本長到 5,000 萬筆（同一個 0.6.1 的估算）才改。

### 2.6.7 報表與維運查詢

README 說這一章要回答「跨服務 JOIN 消失之後報表怎麼辦」。對**庫存這一刀**，答案短得出乎意料：

- **第 12 站的報表沒有讀庫存的表。** 第 01 章的第二把尺量過（1.4.5）：`reporting` 讀了 `orders`、`order_items`、`products`、`users`、`categories` 五張表，一張庫存的都沒有。B1 在這一章結束時重跑（2.9.3），「直接讀表」那一欄沒有新的線。
- **會壞的是「人」的查詢。** 維運的時候常寫的那幾句 —— 「熱點商品還剩多少」（`products.hot` JOIN `inventory`）、「這張訂單的預留在哪」（`orders` JOIN `inventory_reservations`）—— 在切開之後都寫不出來了。它們要嘛變成兩次查詢（先查一邊、再拿 id 去查另一邊），要嘛靠一個把兩邊合在一起的讀模型。
- 如果切的是 catalog 或 ordering，`reporting` 的五張表就有一半在別的服務了 —— 那是**第 05 章**的主題（API 組合、CQRS 讀模型，以及「報表服務該不該直連別人的資料庫」）。

---

## 2.7 建立商品：一個交易，兩個資料庫

### 2.7.1 四種做法

第 01 章 1.2 說建立商品是一種「跟訂單無關、但也被切斷的交易」：第 12 站的 `ProductService.create()` 在同一個交易裡寫 `products`、呼叫 `inventory.initialize()`（`MANDATORY`：商品沒建成，庫存列也不能存在，第 12 站 1.5.2）。1.6.7 的表上，它那一列寫的是「第 04 章（或第 02 章：庫存列晚一點出現，可售量先當 0）」。這一節做括號裡的那一個。

庫存在另一個資料庫之後，有四種寫法：

| | 做法 | 失敗的時候 | 代價 |
|---|---|---|---|
| A | 照舊：交易裡呼叫遠端的 `initialize()`（2.4.7 的現況） | 庫存服務 commit、商品的交易 rollback → **有庫存列、沒有商品**（無害的垃圾，但對帳要認得它） | 一次遠端呼叫在商品的交易裡：庫存服務慢，賣家的「建立商品」就佔著連線（第 01 章 1.6.5 的 B2） |
| B | 商品先 commit，再呼叫遠端的 `initialize()` | 商品建好了、呼叫失敗 → **期初庫存不見了**：賣家填的 100 件，沒有任何地方記得 | 要嘛回 500（但商品已經建了 —— 賣家再按一次，就是兩個商品），要嘛回 201（但庫存是 0） |
| C | 先建庫存、再建商品 | 商品的 id 是 `products` 的自動遞增 —— 建庫存的時候還不知道它 | 要改成由外部產生 id（UUID、號碼服務）：改的是主鍵，牽動整個系統 |
| D | **商品與一個 `product.created` 事件同一個交易**（outbox）；庫存模組收到之後建立庫存列 | 事件一定會送到（第 12 站第 07 章的 at-least-once）；重複送到由 `processed_messages` 擋掉 | 「商品存在、庫存列還沒出現」的那一段時間：通常不到一秒（2.7.5）；這段時間可售量是 0 |

D 的那個代價，在第 12 站的業務規則裡正好是無害的：**新商品一律是草稿**（US-PRD-1 AC-1：狀態 `DRAFT`），買家看不到、不能下單。賣家要先「上架」—— 等他按下去，庫存列早就在了。

### 2.7.2 判斷的關鍵：另一邊會不會拒絕 ★

為什麼建立商品用一個事件就夠了，下單卻要等第 04 章的 Saga？

**看另一邊會不會拒絕。**

- 庫存模組收到 `product.created`，要做的是「建一列、記一筆帳」。**它沒有任何理由拒絕**：期初庫存是非負的整數（API 已經驗證過），商品 id 不會重複（重複送到的事件被 `processed_messages` 擋掉）。只要事件會送到，結果就一定會發生 —— 唯一的不確定是「什麼時候」。
- 下單的 `reserve()` **會拒絕**：庫存不夠就是不夠（`InsufficientStockException`）。如果下單只發一個事件、讓庫存模組「之後」預留，那訂單已經成立了才發現沒貨 —— 要有人把訂單取消、通知買家、（如果付款了）退款。那就是**補償**，也就是 Saga（第 04 章）。

| 另一邊 | 做法 | 例子 |
|---|---|---|
| 不會拒絕（只是「之後會發生」） | 事件（outbox）就夠了：最終一致 | 建立商品 → 建庫存列；取消 → 加回熱點閘門（第 12 站 7.6.5） |
| 會拒絕 | 要嘛同步問（拿到答案再決定）、要嘛 Saga（先做、被拒絕就補償） | 下單 → 預留；付款 → 扣款 |

第 12 站其實已經用過一次這條規則：熱點商品的預留「之後才計入」（7.6），因為 Redis 的閘門已經先擋過一次 —— 落帳**幾乎**不會拒絕。那個「幾乎」，就是 7.6.3 的「偏高的代價變了」：落帳偶爾會發現不夠，訂單在 201 之後被取消。**「會不會拒絕」不是是非題，是一個機率 —— 機率越高，越需要 Saga。**

### 2.7.3 動手

**catalog**：交易裡不再呼叫庫存，改寫一個事件：

```diff
         Product p = products.save(Product.draft(sellerId, category, req.name().strip(), req.description(), req.price(), clock.instant()));
-        inventory.initialize(p.getId(), req.initialStock(), "product-created");      // 同一個交易（MANDATORY）
+        // 13 站 2.7：第 12 站在這裡呼叫 inventory.initialize()（MANDATORY，跟商品同一個交易）。庫存搬到另一個資料庫之後，那不再是一個交易 ——
+        // 改成跟商品一起寫一個事件（outbox，同一個交易），庫存模組收到之後建立庫存列。庫存那一邊不會拒絕「建立」，所以事件就夠了，不需要 Saga。
+        // 回應裡的可售量是賣家填的期初庫存：庫存列在事件送到之後才建立（通常不到一秒），這段時間 GET 看到的是 0 —— 商品是草稿，買家看不到
+        outbox.add("PRODUCT", p.getId(), EventTypes.PRODUCT_CREATED,
+                Map.of("productId", p.getId(), "sellerId", sellerId, "initialStock", req.initialStock()));
         return detailOf(p, req.initialStock());
```

（`ProductService` 的建構子多注入一個 `Outbox`。）`EventTypes` 多一種：

```java
    // ── catalog：13 站 2.7 ──
    /** productId, sellerId, initialStock —— 建立商品。庫存模組收到之後建立庫存列、記一筆 INITIAL（第 12 站是同一個交易裡的 initialize()） */
    public static final String PRODUCT_CREATED = "product.created";
```

事件是契約（第 12 站 7.3.1）：payload 自己帶齊庫存需要的欄位，庫存模組不用回頭問 catalog。

**inventory**：多一個消費者。RabbitMQ 的佇列與綁定是從 `EventHandler` 自動產生的（第 12 站 7.5.1），不用改拓撲：

```java
    /**
     * 13 站 2.7：建立商品的期初庫存。第 12 站是 catalog 在建立商品的交易裡呼叫 initialize()（MANDATORY）；
     * 庫存搬到自己的資料庫之後，那不再是同一個交易，改成收 product.created。冪等由 EventDispatcher 負責（processed_messages）
     */
    @Bean
    EventHandler productCreated(JdbcInventoryService inventory) {
        return new EventHandler() {
            @Override public String consumer() { return "inventory.product-created"; }
            @Override public Set<String> eventTypes() { return Set.of(EventTypes.PRODUCT_CREATED); }
            @Override public void handle(Event e) {
                inventory.initialize(e.getLong("productId"), e.payload().get("initialStock").asInt(), "product-created");
            }
        };
    }
```

`initialize()` 還是 `MANDATORY` —— 它在消費者的交易裡（`EventDispatcher` 開的，`processed_messages` 那一列跟它一起 commit，第 12 站 7.5.2）。

**「庫存列還不在」的那一段時間，庫存模組的每一個方法都要說得出它的行為**。逐一檢查 13 個方法，三個要改：

```diff
     public void initialize(long productId, int onHand, String note) {
         if (onHand < 0) throw new IllegalArgumentException("onHand must not be negative");
-        jdbc.update("INSERT INTO inventory (product_id, on_hand, reserved) VALUES (?, ?, 0)", productId, onHand);
+        // 13 站 2.7：補貨可能比 product.created 先到（restock 會先建一列）—— 已經有就加上去，帳照記（INV-3 照樣成立）
+        jdbc.update("""
+                INSERT INTO inventory (product_id, on_hand, reserved) VALUES (?, ?, 0) AS new
+                ON DUPLICATE KEY UPDATE on_hand = inventory.on_hand + new.on_hand, updated_at = CURRENT_TIMESTAMP(3)""", productId, onHand);
         if (onHand > 0) ledger(productId, onHand, 0, "INITIAL", note);     // ck_ledger_delta：數量為 0 就不記帳
     }
…
     public void restock(long productId, int quantity, String note) {
         if (quantity <= 0) throw new IllegalArgumentException("quantity must be positive");
-        jdbc.update("UPDATE inventory SET on_hand = on_hand + ? WHERE product_id = ?", quantity, productId);
+        // 13 站 2.7：庫存列還沒建立（product.created 還沒送到）也要補得進去 —— 不然下一句帳撞外鍵（fk_ledger_inventory）
+        jdbc.update("""
+                INSERT INTO inventory (product_id, on_hand, reserved) VALUES (?, ?, 0) AS new
+                ON DUPLICATE KEY UPDATE on_hand = inventory.on_hand + new.on_hand, updated_at = CURRENT_TIMESTAMP(3)""", productId, quantity);
         ledger(productId, quantity, 0, "RESTOCK", note);
…
     public int available(long productId) {
-        Integer v = jdbc.queryForObject(
-                "SELECT on_hand - reserved FROM inventory WHERE product_id = ?", Integer.class, productId);
-        return v == null ? 0 : v;
+        // 13 站 2.7：沒有庫存列 = 0（queryForObject 在這裡會丟 EmptyResultDataAccessException —— 第 00 章那個商品頁的 500）
+        List<Integer> v = jdbc.queryForList("SELECT on_hand - reserved FROM inventory WHERE product_id = ?", Integer.class, productId);
+        return v.isEmpty() || v.get(0) == null ? 0 : v.get(0);
     }
```

| 方法 | 庫存列還不在的時候 | 改了嗎 |
|---|---|---|
| `available(id)` | 第 12 站：`queryForObject` → `EmptyResultDataAccessException` → **500**（第 00 章 0.2.3 的 ⚠️ 就是它） | 改：回 0 |
| `available(ids)` | 不在結果裡；呼叫的人都用 `getOrDefault(id, 0)` | 不用 |
| `restock` | 第 12 站：`UPDATE` 影響 0 列，下一句帳撞外鍵 → 500 | 改：沒有就先建一列 |
| `initialize` | 補貨先到的話，列已經在了 → 第 12 站的 `INSERT` 撞主鍵 → 消費者重試 5 次之後進死信 | 改：已經有就加上去 |
| `reserve`、`holdHot` | `UPDATE … WHERE on_hand - reserved >= ?` 影響 0 列 → 庫存不足（409） | 不用：沒有庫存就是庫存不足 |
| `setHot` → 建立熱點閘門 | `queryForObject(GATE_BASE_SQL)` → 例外，而且是在 `afterCommit` 裡丟 | 改：不建閘門、記一行 WARN（下一次 `gateHot` 會再試） |
| `confirm`、`release`、`consume` | 一定先有預留，才會呼叫到它們 —— 有預留就有庫存列 | 不用 |

熱點閘門那一個，**為什麼不乾脆用 0 建**：Redis 的 `stock:{id}` 是「可售量的副本」，0 建下去之後，`product.created` 送到、庫存列建好了，Redis 照樣是 0 —— 一直少賣到熱點對帳（第 12 站 6.6，每分鐘）把它修正。不建，下一次有人下單時 `gateHot` 發現 key 不存在，會再從 MySQL 建一次（6.5.3），那時候庫存列多半已經在了。

### 2.7.4 需求變了：US-PRD-1 AC-1

第 12 站的 US-PRD-1 AC-1：「201；狀態 `DRAFT`；…；`inventory.onHand = initialStock`；`inventory_ledger` 一筆 `reason=INITIAL`」—— 201 回來的那一刻，庫存列與帳**都已經在了**。

這一節之後不是了。201 回來的那一刻，`products` 有一列、`outbox_events` 有一個 `product.created`；庫存列在不到一秒之後才出現。**拆資料庫改的不只是程式碼，還有驗收條件。** 改成：

> AC-1：201；狀態 `DRAFT`；`sellerId` 為目前使用者；回應的可售量等於 `initialStock`；**`product.created` 送達之後**，`inventory.onHand = initialStock`、`inventory_ledger` 一筆 `INITIAL`。在那之前，查詢可售量得到 0。

這個改動要跟寫需求的人談 —— 它是業務規則的改變，不是實作細節。這一次談得成，靠的是另一條業務規則（新商品一律是草稿）；如果第 12 站的商品建立就直接上架，這段「可售量是 0」的時間買家看得到，就要重新評估（例如：上架要等庫存列出現）。

### 2.7.5 測試

**第 12 站的測試**：`CatalogCartApiTest` 用 MockMvc 建商品，`@Transactional`（測試結束 rollback）。建完之後，用第 12 站 7.12.1 的 `InlineEvents` 把這個商品的 `product.created` 交給庫存的消費者（在同一個測試交易裡，跟著 rollback）：

```diff
     long createProduct(String name, String price, int stock) throws Exception {
         JsonNode p = body(mvc.perform(as(SELLER, "BUYER,SELLER", post("/api/seller/products")
                 .content("""
                         {"name": "%s", "price": %s, "categoryId": 11, "initialStock": %d}""".formatted(name, price, stock)))));
-        return p.get("id").asLong();
+        long id = p.get("id").asLong();
+        deliverProductCreated(id);                                          // 13 站 2.7：庫存列由 product.created 建立
+        return id;
     }
+
+    /** 13 站 2.7：把這個商品的 product.created 交給庫存模組的消費者（InlineEvents：測試的交易裡，跟著 rollback） */
+    void deliverProductCreated(long productId) {
+        com.example.shop.support.InlineEvents.deliver(ctx, r -> r.aggregateType().equals("PRODUCT") && r.aggregateId() == productId);
+    }
```

AC-1 的那一個測試，把「之前、之後」都寫出來：

```diff
-    @Test @DisplayName("PRD-1 AC-1：sellerId 來自目前使用者、狀態一律 DRAFT、庫存列與 INITIAL 帳同時建立")
+    @Test @DisplayName("PRD-1 AC-1：sellerId 來自目前使用者、狀態一律 DRAFT；庫存列與 INITIAL 帳在 product.created 送到之後建立（13 站 2.7）")
…
         assertThat(p.get("price").decimalValue()).isEqualByComparingTo("1290.00");
-        assertThat(jdbc.queryForObject("SELECT CONCAT(reason, ':', delta_on_hand) FROM inventory_ledger WHERE product_id = ?",
-                String.class, p.get("id").asLong())).isEqualTo("INITIAL:30");
+        long id = p.get("id").asLong();
+        // 13 站 2.7：第 12 站在建立商品的同一個交易裡建立庫存列；現在是跟商品一起寫一個 product.created，由庫存模組的消費者建立
+        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM inventory WHERE product_id = ?", Integer.class, id)).as("事件送到之前").isZero();
+        assertThat(jdbc.queryForObject("SELECT event_type FROM outbox_events WHERE aggregate_type = 'PRODUCT' AND aggregate_id = ?", String.class, id))
+                .isEqualTo("product.created");
+        deliverProductCreated(id);
+        assertThat(jdbc.queryForObject("SELECT CONCAT(reason, ':', delta_on_hand) FROM inventory_ledger WHERE product_id = ?",
+                String.class, id)).isEqualTo("INITIAL:30");
```

> ⚠️ **不改 `createProduct` 的話，購物車那個測試照樣是綠的 —— 理由錯了。** `cart()` 建一個 3 件的商品，加 5 件進購物車，檢查有「庫存不足」的提醒。庫存列還沒建立時可售量是 0，0 < 5 —— 一樣有提醒。測試綠著，量的卻不是它以為的東西。

**端到端**：真的 relay、真的 RabbitMQ、真的消費者（第 12 站 7.12 `EventFlowTest` 的做法），而且量「商品已經 commit、庫存列還不在」的那段時間有多長：

```java
package com.example.shop.catalog.internal;

import com.example.shop.support.InlineEvents;
import com.example.shop.support.TestInfra;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.ApplicationContext;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.annotation.DirtiesContext;

import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 13 站 2.7：建立商品 → product.created → 庫存模組建立庫存列。端到端：真的 relay、真的 RabbitMQ、真的消費者（第 12 站 7.12 EventFlowTest 的做法）。
 * 量的是「商品已經 commit、庫存列還不在」的那段時間 —— 第 12 站是 0（同一個交易），現在是一次 relay 加一次消費。
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.NONE, properties = {"shop.order.jobs-enabled=false", "shop.inventory.jobs-enabled=false",
        "shop.messaging.relay-enabled=true", "shop.messaging.consumers-enabled=true"})
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
class ProductCreatedFlowTest {

    static final long SELLER = 990_271;
    static final int N = 20;

    @Autowired ProductService products;
    @Autowired JdbcTemplate jdbc;
    @Autowired ApplicationContext ctx;

    @Test @DisplayName("13 站 2.7：建立商品之後，庫存列與 INITIAL 帳由 product.created 建立（真的 relay 與 RabbitMQ）")
    void initialStockArrivesThroughTheEvent() throws Exception {
        cleanup();
        InlineEvents.skipBacklog(ctx);
        List<Long> waitedMs = new ArrayList<>();
        List<Long> ids = new ArrayList<>();
        try {
            for (int i = 0; i < N; i++) {
                long id = products.create(SELLER, new ProductDtos.CreateProductRequest("事件建立 " + i, null, new BigDecimal("100"), 11L, 7 + i)).id();
                long t0 = System.nanoTime();                                // create() 回來 = 商品已經 commit
                ids.add(id);
                while (jdbc.queryForObject("SELECT COUNT(*) FROM inventory WHERE product_id = ?", Integer.class, id) == 0) {
                    if (System.nanoTime() - t0 > 10_000_000_000L) throw new AssertionError("商品 " + id + " 10 秒內沒有庫存列");
                    Thread.sleep(2);
                }
                waitedMs.add((System.nanoTime() - t0) / 1_000_000);
            }
            List<Long> sorted = waitedMs.stream().sorted().toList();
            System.out.printf("13 站 2.7：%d 個商品，商品 commit 之後多久有庫存列：p50 %d ms、最長 %d ms（relay 間隔 100 ms）%n",
                    N, sorted.get(N / 2), sorted.get(N - 1));
            for (int i = 0; i < N; i++)
                assertThat(jdbc.queryForObject("SELECT CONCAT(i.on_hand, '/', l.reason, ':', l.delta_on_hand) FROM inventory i JOIN inventory_ledger l ON l.product_id = i.product_id WHERE i.product_id = ?",
                        String.class, ids.get(i))).isEqualTo((7 + i) + "/INITIAL:" + (7 + i));
        } finally {
            cleanup();
        }
    }

    void cleanup() {
        JdbcTemplate admin = TestInfra.adminJdbc();
        List<Long> ids = jdbc.queryForList("SELECT id FROM products WHERE seller_id = ?", Long.class, SELLER);
        for (long id : ids) {
            admin.update("DELETE FROM inventory_ledger WHERE product_id = ?", id);
            jdbc.update("DELETE FROM inventory WHERE product_id = ?", id);
            jdbc.update("DELETE FROM outbox_events WHERE aggregate_type = 'PRODUCT' AND aggregate_id = ?", id);
        }
        jdbc.update("DELETE FROM products WHERE seller_id = ?", SELLER);
    }
}
```

```
13 站 2.7：20 個商品，商品 commit 之後多久有庫存列：p50 119 ms、最長 291 ms（relay 間隔 100 ms）
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 7.062 s -- in com.example.shop.catalog.internal.ProductCreatedFlowTest
```

**中位數 119 ms、最長 291 ms**（這一章跑了三次：p50 109、109、119 ms，最長 146、298、291 ms）：relay 每 100 ms 輪一次（第 12 站 7.4.3），加上送出、消費、commit。第 12 站是 0（同一個交易）。

**守門員少了一行。** `CrossModuleCallInTxTest`（第 01 章 1.6.6）的清單從 12 種變成 11 種 —— 「`catalog → InventoryApi.initialize`」拿掉了：

```diff
-    /** 第 01 章結束時，還在交易裡的跨模組呼叫：全部是「寫」，全部要等 Saga（第 04 章）才拿得出來 */
+    /**
+     * 第 01 章結束時，還在交易裡的跨模組呼叫：全部是「寫」，全部要等 Saga（第 04 章）才拿得出來。
+     * 13 站 2.7：「catalog → InventoryApi.initialize」拿掉了 —— 建立商品改成寫一個 product.created，期初庫存由庫存模組的消費者建立（12 → 11 種）
+     */
     static final Map<String, String> ALLOWED = Map.ofEntries(
-            entry("catalog → InventoryApi.initialize", "建立商品：期初庫存跟商品同一個交易（第 04 章）"),
```

```
13 站 1.6.6：交易裡的跨模組呼叫 11 種 [catalog → InventoryApi.setHot, ordering → CartApi.removeItems, ordering → InventoryApi.confirm, ordering → InventoryApi.consume, ordering → InventoryApi.holdHot, ordering → InventoryApi.release, ordering → InventoryApi.reserve, ordering → PaymentApi.create, ordering → PaymentApi.record, ordering → PaymentApi.requestRefund, ordering → PaymentApi.succeededPaymentOf]
            交易外 8 種 [cart → CatalogApi.snapshots, cart → InventoryApi.available, catalog → InventoryApi.available, catalog → InventoryApi.availableForDisplay, catalog → InventoryApi.restock, ordering → CatalogApi.hotProducts, ordering → CatalogApi.snapshots, ordering → InventoryApi.gateHot]
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 1.154 s -- in com.example.shop.dist01.CrossModuleCallInTxTest
```

第 01 章說這張清單「只會變短」—— 這是第一次。

### 2.7.6 在切開的部署裡

C1 的 ③ 再跑一次（這一節之後的程式碼）：

```
═══ 2.4.7 ③ 誠實的庫，InventoryApi 的 13 個方法全部走 HTTP（load { 4.32 4.38 4.89 }）═══
  訂單服務的庫：[audit_logs, cart_items, categories, idempotency_keys, notifications, order_items, order_status_history, orders, outbox_events, payments, processed_messages, products, refresh_tokens, refunds, user_roles, users]
  庫存服務的庫：[audit_logs, inventory, inventory_ledger, inventory_ledger_checkpoints, inventory_ledger_watermark, inventory_reservations, outbox_events, processed_messages]
  使用者的一天：61 個 HTTP 請求全部是預期的回應
  庫存的表收到的 SQL（送出的程式碼 → 哪一個庫：句數）：
    HotStock.initialize                            → shop_d02_inv：1
    HotStock.reconcile                             → shop_d02_inv：1
    InventoryReconciliation.checkIncremental       → shop_d02_inv：1
    InventoryReconciliation.lambda$checkIncremental$5 → shop_d02_inv：3
    JdbcInventoryService.activeReservations        → shop_d02_inv：1
    JdbcInventoryService.available                 → shop_d02_inv：16
    JdbcInventoryService.confirm                   → shop_d02_inv：4
    JdbcInventoryService.consume                   → shop_d02_inv：8
    JdbcInventoryService.held                      → shop_d02_inv：6
    JdbcInventoryService.holdHot                   → shop_d02_inv：2
    JdbcInventoryService.initialize                → shop_d02_inv：4
    JdbcInventoryService.ledger                    → shop_d02_inv：17
    JdbcInventoryService.release                   → shop_d02_inv：6
    JdbcInventoryService.reserve                   → shop_d02_inv：10
    JdbcInventoryService.restock                   → shop_d02_inv：1
    JdbcInventoryService.settleHot                 → shop_d02_inv：8
  shop_d02_order ：沒有庫存的表
  shop_d02_inv   ：inventory 4 列、inventory_reservations 7 列、inventory_ledger 17 列
  訂單服務的帳號（shop）讀庫存服務的庫：SELECT COUNT(*) FROM shop_d02_inv.inventory → 4（讀得到）
  訂單服務在自己的交易裡呼叫庫存服務：9 種（動作 × 方法）—— 每一種都是「兩個交易」
    POST /api/orders                                 InventoryApi.holdHot
    POST /api/orders                                 InventoryApi.reserve
    POST /api/orders/{orderNo}/cancel                InventoryApi.release
    POST /api/payments/callback                      InventoryApi.confirm
    POST /api/seller/orders/{orderNo}/cancel         InventoryApi.release
    POST /api/seller/orders/{orderNo}/ship           InventoryApi.consume
    POST /api/seller/products/{id}/hot               InventoryApi.setHot
    事件 inventory.hot-settlement-failed → ordering.stock-shortage InventoryApi.release
    排程 OrderJobs.cancelExpired                       InventoryApi.release
  （結束時 load { 4.22 4.35 4.88 }）
```

**交易內的遠端呼叫從 10 種變成 9 種**：「`POST /api/seller/products  InventoryApi.initialize`」不見了。`product.created` 從訂單服務的 outbox 出發，交給庫存服務的消費者 —— 在使用者的一天裡，它是 `D01Workload.events()` 從訂單服務的庫讀出來、交給庫存服務的 `EventDispatcher` 的；正式環境裡，它走 RabbitMQ（兩個服務各自的 relay 與消費者，第 03 章）。

---

## 2.8 搬家：雙寫過渡期

### 2.8.1 問題：已經有資料的庫存

到這裡為止，每一個實驗的兩個庫都是**空的**開始的。真的拆分不是：單體已經營業了三年，`inventory_reservations` 與 `inventory_ledger` 加起來幾千萬列；庫存服務上線的那一天，這些資料要在它的庫裡 —— 而單體**一直在寫它們**（每一張訂單寫 3 列預留、3 筆帳、改 3 列庫存）。

要決定的事：

1. **搬的時候，誰是正本？** 同一列在兩個庫裡不一樣時，信哪一個。
2. **搬的時候，單體還接不接單？** 不接，要停多久；接，新的寫怎麼跟著過去。
3. **怎麼知道搬對了？** 而且是在切過去**之前**知道。

這一節的實驗（C4）用第 12 站種子資料的規模：1,000 個商品、30 萬筆預留、60 萬筆帳（10 萬張舊訂單的歷史），單體一邊營業（8 條執行緒不停地下單，三分之一取消、三分之一付款），一邊把庫存的五張表搬到一個新的庫（`shop_d02_newinv`，只跑庫存與 `shared` 的資料夾，2.4.2）。三種做法：

| | 做法 | 正本 | 單體接單嗎 |
|---|---|---|---|
| ① | 停寫搬家：不接單，整張複製，核對，切過去 | 舊的庫 | 不接（停多久就是這一節要量的） |
| ② | 應用程式雙寫：照常接單，每一個交易 commit 之後在新的庫再寫一次；同時把舊資料回填過去 | 舊的庫（新的寫失敗就算了） | 接 |
| ③ | 舊的庫是唯一寫入者：trigger 在同一個交易裡記下「哪一列變了」，搬家程式回填之後照著紀錄追；追上之後停寫幾秒、追完、核對 | 舊的庫 | 接；最後停幾秒 |

搬家的程式用兩條連線：一條讀舊的、一條寫新的。實驗裡兩個庫在同一台 MySQL 上，但**不用跨庫的 `INSERT … SELECT`** —— 真的搬家時它們在兩台機器上，那句 SQL 不存在（2.3.4）。核對用**列數與每一列內容的 CRC32 加總**（跟列的順序無關），兩個庫各算一次再比：

```java
    /** 列數、內容的 CRC32 加總 */
    String checksum(String db, String table) throws Exception {
        String row = "CONCAT_WS('|', " + String.join(", ", columns.get(table).stream().map(c -> "IFNULL(" + c + ", '∅')").toList()) + ")";
        try (Connection c = SplitLab.root(db); Statement st = c.createStatement();
             ResultSet rs = st.executeQuery("SELECT COUNT(*), COALESCE(SUM(CRC32(" + row + ")), 0) FROM " + table)) {
            rs.next();
            return rs.getLong(1) + "/" + rs.getLong(2);
        }
    }
```

（`Copier.java`，完整的檔案在 2.10.1。）實驗另外做一個**逐列比對**（只在舊庫、只在新庫、兩邊都有但內容不同）—— 那要跨庫 JOIN，只有實驗做得到；正式的搬家只有 checksum：它說「不一樣」，不說哪裡不一樣。

```bash
mvn test -Pexperiments -Dtest=C4DataMigrationTest
```

### 2.8.2 ① 停寫搬家：要停多久

```
═══ 2.8 舊的庫（單體）：inventory 1,000 列、inventory_reservations 300,000 列、inventory_ledger 600,000 列（load { 4.34 4.37 4.88 }）═══
  對照（不搬家）　│ 10 秒：下單 1,753 張（每秒 175，p50 31.3 ms）、取消 580、付款 581、錯誤 0
═══ 2.8.2 ① 停寫搬家：不接單，整張複製，核對（load { 5.99 4.74 5.00 }）═══
  複製 inventory                          1,000 列     0.0 秒
  複製 inventory_reservations           306,882 列     4.2 秒
  複製 inventory_ledger                 609,105 列     6.7 秒
  複製 inventory_ledger_checkpoints           0 列     0.0 秒
  複製 inventory_ledger_watermark             1 列     0.0 秒
  複製 916,988 列 11.0 秒（每秒 83,154 列）＋ 核對（五張表的列數與 CRC32）1.1 秒 = 停寫 12.2 秒；兩邊不一樣的表：沒有
```

**91 萬列，12 秒停寫。** 複製 11 秒、核對 1 秒，兩邊完全一樣 —— 最簡單，也最對：單體不寫，就沒有「搬的時候它又變了」的問題。

這 12 秒是**下限**：兩個庫在同一台機器上，沒有網路；真的跨機器、真的 5,000 萬筆帳（第 12 站 0.6.1 的三年估算，這裡的 80 倍左右），同樣的做法是十幾分鐘（推算，沒有量）。這段時間**不能下單**（每一張訂單都要寫庫存的表）。對一個每天 5,000 張訂單的系統，凌晨停十幾分鐘可能是最便宜的答案 —— 這一節後面的每一種做法，都比這一種複雜得多。**先算停機的代價，再決定要不要不停機。**

### 2.8.3 ② 應用程式雙寫：差了多少

最常見的「不停機」寫法：單體照舊寫舊的庫；每一個交易 commit 之後，把它寫進庫存五張表的那幾句 SQL，在新的庫再執行一次。新的庫寫失敗就記下來、不影響使用者 —— 舊的庫才是正本（雙寫的人通常都這樣決定，不然新的庫一掛，單體也跟著掛）。同時，一支回填程式把舊的資料搬過去；**回填用 `INSERT IGNORE`**：新的庫已經有的那一列不動 ——「雙寫寫進去的比較新，不要蓋掉它」。

實驗裡的雙寫做在 JDBC 驅動那一層（`DualWriteTap`，跟第 01 章的 `SqlTap` 同一個掛勾）：不用改正式程式碼，而且**所有的寫**都抓得到 —— 包括事件的消費者、排程，那些不經過 `InventoryApi` 的寫。寫在 service 那一層的雙寫，常常漏掉它們（第 12 站的熱點落帳 `settleHot()` 就不經過 `InventoryApi`）。

```java
    @Override
    public <T extends Resultset> T postProcess(Supplier<String> sql, Query query, T originalResultSet, ServerSession serverSession) {
        String s = sql.get();
        if (s == null || pending.isEmpty()) return null;
        boolean commit = s.strip().equalsIgnoreCase("commit");
        boolean auto;
        try { auto = conn.getAutoCommit(); } catch (Exception e) { auto = false; }
        if (commit || auto) {                                                 // 舊的庫 commit 了（或者沒有交易、一句就是一個交易）
            List<String> batch = new ArrayList<>(pending);
            pending.clear();
            replay(batch);
        }
        return null;
    }
```

（`preProcess` 收集這個交易裡寫庫存五張表的 SQL —— Connector/J 交給 interceptor 的是**已經代入參數**的 SQL 文字；`replay` 在新的庫用一條連線、一個交易執行它們。）

時間線：雙寫先開始，2 秒後回填開始；第 8 秒新的庫「斷線」2 秒（`DualWriteTap.down`）；營業 20 秒後停止，等回填結束，逐列比對：

```
═══ 2.8.3 ② 應用程式雙寫：照常接單，commit 之後在新的庫再寫一次；同時回填（load { 5.22 4.64 4.96 }）═══
  單體　　　　　　│ 20 秒：下單 2,736 張（每秒 136，p50 37.4 ms）、取消 873、付款 944、錯誤 0
  雙寫：成功 3,230 個交易；失敗 1,323 個交易（11,027 句沒寫進新的庫）；回填 1,000 列（回填失敗：java.sql.BatchUpdateException: Deadlock found when trying to get lock; try restarting transaction）
    失敗的原因 × 424：Duplicate entry 'N' for key 'inventory_reservations.PRIMARY'
    失敗的原因 × 301：Cannot add or update a child row: a foreign key constraint fails (`shop_dN_newinv`.`inventory_reservations`, CONSTRAINT 
    失敗的原因 × 2：Check constraint 'ck_inventory_reserved' is violated.
    失敗的原因 × 6：Deadlock found when trying to get lock; try restarting transaction
    失敗的原因 × 488：新的庫連不上
    失敗的原因 × 102：Cannot add or update a child row: a foreign key constraint fails (`shop_dN_newinv`.`inventory_ledger`, CONSTRAINT `fk_le
  逐列比對（實驗才做得到）：只在舊庫 / 只在新庫 / 內容不同
    inventory                            0 /       0 /   1,000
    inventory_reservations           2,037 /       0 /   5,175
    inventory_ledger               612,744 /       0 /   7,188
    inventory_ledger_checkpoints         0 /       0 /       0
    inventory_ledger_watermark           1 /       0 /       0
    inventory 的 reserved 對不上的商品：846 個，差的件數合計 1,842
```

**同一段程式碼跑了四次，四次的錯都不一樣。** 上面是最後一次：回填自己死在一個死鎖上（`INSERT IGNORE` 的那一批跟雙寫的 `INSERT` 搶同一段主鍵的鎖），60 萬筆帳一筆都沒搬過去。第二、第三次也死在死鎖上（雙寫失敗 1,406、1,180 個交易）。只有第一次回填跑完了（92 萬列），結果是：

```
  雙寫：成功 2,393 個交易；失敗 1,640 個交易（13,792 句沒寫進新的庫）；回填 925,199 列
    失敗的原因 × 300：Duplicate entry 'N' for key 'inventory_ledger.PRIMARY'
    失敗的原因 × 381：Duplicate entry 'N' for key 'inventory_reservations.PRIMARY'
    失敗的原因 × 274：Cannot add or update a child row: a foreign key constraint fails (`shop_dN_newinv`.`inventory_reservations`, CONSTRAINT 
    失敗的原因 × 21：Check constraint 'ck_inventory_reserved' is violated.
    失敗的原因 × 1：Deadlock found when trying to get lock; try restarting transaction
    失敗的原因 × 560：新的庫連不上
    失敗的原因 × 103：Cannot add or update a child row: a foreign key constraint fails (`shop_dN_newinv`.`inventory_ledger`, CONSTRAINT `fk_le
  逐列比對（實驗才做得到）：只在舊庫 / 只在新庫 / 內容不同
    inventory                            0 /       0 /     997
    inventory_reservations           2,607 /       0 /   3,615
    inventory_ledger                     0 /       0 /   5,202
    inventory_ledger_checkpoints         0 /       0 /       0
    inventory_ledger_watermark           0 /       0 /       0
    inventory 的 reserved 對不上的商品：897 個，差的件數合計 2,291
```

（第一次沒有先熱身 JVM，2.8.4 ④ 說明；雙寫與回填的程式碼四次都一樣。）

**回填跑完了，1,000 個商品還有 997 個的庫存對不上。** 每一種失敗原因都是一個雙寫的經典問題：

| 失敗 | 怎麼發生的 | 雙寫的哪一個問題 |
|---|---|---|
| 主鍵撞號（預留、帳） | 雙寫的 `INSERT` 沒有帶 id，新的庫自己發號（從 1 開始）；回填帶著舊的 id 過來 —— 同一個號碼，兩列不同的資料 | **自動產生的 id 不會跟著過去。** 舊庫的預留 101 號，在新庫可能是另一筆預留 |
| 內容不同（預留） | 第 12 站的 `release()`、`consume()` 用 id 更新預留（`UPDATE inventory_reservations … WHERE id = ?`）—— 在新的庫，那個 id 是另一筆 | 同上：**重播的 SQL 改到了別的列** |
| 外鍵失敗（預留、帳） | 雙寫來的時候，回填還沒搬到那個商品的庫存列 —— 先寫子表、父表還不在 | **順序**：雙寫與回填誰先到，沒有人保證 |
| `ck_inventory_reserved` 違反 | 新庫那一列是回填搬來的「某一刻的值」，雙寫重播的是「+1、−1」：基準不一樣，加減之後超出了範圍 | **相對的更新**（`reserved = reserved + 1`）只有在兩邊起點一樣時才對 |
| 死鎖 | 雙寫與回填同時寫同一段主鍵 | 兩個寫入者 |
| 新的庫連不上（560 個交易） | 斷線的 2 秒 | **第二次寫失敗了，然後呢？** 舊的庫已經 commit，這一筆就永遠不會到新的庫 |
| 997 個商品對不上 | 以上全部 | —— |

最後一行最重要：**雙寫讓「誰是對的」變成一個每一列都要問的問題。** 舊的庫是正本，但你不知道新的庫哪幾列跟它一樣 —— checksum 只說「不一樣」。要知道，就要逐列比；比完了要修，修的時候單體還在寫。

> 📌 **雙寫可以做對嗎？** 可以，但要處理上面每一行：id 由應用程式產生（不靠新庫的自動遞增）、只寫「整列的值」不寫「+1」、第二次寫失敗要排隊重試（而不是丟掉）、回填要能蓋掉舊值又不能蓋掉新值（要有版本號）……做完這些，你寫的已經不是「雙寫」，而是一個複寫系統 —— 那不如直接用一個（2.8.4、2.8.5）。

### 2.8.4 ③ 舊的庫是唯一寫入者，新的跟著它

換一個想法：**不要有兩個寫入者。** 舊的庫照舊是唯一被寫的地方；新的庫只是它的一個**副本**，由一支搬家程式負責追。要追，就要知道「哪些列變了」：

```java
    /** 2.8.4：舊的庫上，每一張表的每一種寫入都記一筆「哪張表、哪一個主鍵」—— 跟那一筆寫入在同一個交易裡 */
    void installCapture() throws Exception {
        try (Connection c = SplitLab.root(from); Statement st = c.createStatement()) {
            st.execute("""
                    CREATE TABLE d02_changes (seq BIGINT NOT NULL AUTO_INCREMENT, tbl VARCHAR(40) NOT NULL, pk BIGINT NOT NULL,
                                              at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), PRIMARY KEY (seq))""");
        }
        installTriggers();
    }

    void installTriggers() throws Exception {
        try (Connection c = SplitLab.root(from); Statement st = c.createStatement()) {
            for (var e : TABLES.entrySet())
                for (String op : List.of("INSERT", "UPDATE", "DELETE"))
                    st.execute("CREATE TRIGGER d02_cdc_%s_%s AFTER %s ON %s FOR EACH ROW INSERT INTO d02_changes (tbl, pk) VALUES ('%s', %s.%s)"
                            .formatted(e.getKey(), op.toLowerCase().substring(0, 3), op, e.getKey(), e.getKey(), op.equals("DELETE") ? "OLD" : "NEW", e.getValue()));
        }
    }
```

五張表、三種寫入，15 個 trigger。trigger 跟觸發它的那一句**在同一個交易裡** —— 那一筆寫入成立，紀錄就成立；rollback，紀錄也不見。紀錄只有「哪張表、哪一個主鍵」，**不記值**。

搬家程式做兩件事：

1. **回填**：每一張表照主鍵的順序一批一批讀，寫進新的庫 —— 寫的是**整列的值，包括 id**；已經有就整列蓋掉。
2. **追**：讀變更紀錄，每一個主鍵「**再讀一次舊庫現在的那一列**」，整列寫進新的庫；舊庫已經沒有那一列就刪掉。

第 2 步是整個做法的關鍵：**不重播 SQL、不重播「+1」，只複製最新的值。** 所以：

- 同一列變了十次，搬家程式只要搬最後那一次 —— 順序不重要；
- 同一筆紀錄處理兩次，結果一樣 —— 重複不重要；
- 回填與追同時發生，誰先到都一樣 —— 最後一次寫的一定是「舊庫現在的值」。

順序是：**先裝 trigger，再回填**。回填途中變了的列，一定有一筆紀錄，追的時候會再搬一次；回填之前就變了的列，回填讀到的就是新的值。

**最後的切換**：等搬家程式幾乎追上（落後不到 1,000 筆），單體停止接單；確認舊庫上沒有進行中的交易；把最後的紀錄追完；核對。核對通過 —— 這時候才把庫存服務指向新的庫（流量的那一步，第 09 章）。

```java
        Thread sync = new Thread(() -> {
            try {
                for (String t : Copier.TABLES.keySet()) copier.backfill(t);
                out.printf("    回填完成（%s）%n", sizes(NEW));
                while (!stop[0]) {
                    try {
                        int n = copier.apply();
                        applied[0] += n;
                        if (n == 0) Thread.sleep(50);
                    } catch (java.sql.SQLTransientConnectionException down) {
                        retries[0]++;
                        Thread.sleep(100);                                  // 新的庫連不上：紀錄還在舊的庫裡，等一下再追
                    }
                }
            } catch (Exception e) { copierError[0] = e; }
        });
        long freeze0, freeze1, drained;
        List<Long> lags = new ArrayList<>();
        try (Load load = new Load(mono, THREADS)) {
            sync.start();
            for (int s = 1; s <= 80; s++) {
                Thread.sleep(1_000);
                if (s == 8) copier.targetDown = true;                       // 新的庫斷線 2 秒
                if (s == 10) copier.targetDown = false;
                long lag = copier.lag();
                lags.add(lag);
                maxLag[0] = Math.max(maxLag[0], lag);
                if (s >= 20 && lag < 1_000) break;                          // 營業 20 秒以上、而且幾乎追上了，才停寫
            }
            load.close();                                                   // 停寫：從這一刻起單體不接單
            freeze0 = System.nanoTime();
            out.println("  單體　　　　　　│ " + load.summary());
        }
        out.println("  變更紀錄落後幾筆（每秒）：" + String.join(" ", lags.stream().map(x -> String.format("%,d", x)).toList()));
        stop[0] = true;
        sync.join();
        if (copierError[0] != null) throw copierError[0];
        int last;
        do { last = copier.apply(); applied[0] += last; } while (last > 0);   // 追完
        // 洞：舊庫上還有沒有進行中的交易？沒有 → 剩下的洞都是 rollback 了（號碼發了、交易沒成立）
        long inFlight = SplitLab.count(OLD, "SELECT COUNT(*) FROM information_schema.innodb_trx WHERE trx_mysql_thread_id <> CONNECTION_ID()");
        int closed = inFlight == 0 ? copier.closeHoles() : -1;
        drained = System.nanoTime();
```

> ⚠️ **回填也要能接著做。** 新的庫在回填途中斷線（實驗第 8 秒起的那 2 秒），回填如果不能「從上一批接著做」，整個執行緒就停了，只能整張表重來。所以寫不進去就等一下、同一批再來一次（寫的是整列的值，重做無妨）：
> ```java
>                 try {
>                     if (overwrite) upsert(dst, table, rows); else insertIgnore(dst, table, rows);
>                 } catch (java.sql.SQLTransientConnectionException down) {
>                     // 2.8.4 第一版沒有這一段：新的庫在回填途中斷線，搬家程式整個停了。回填要能從「上一批」接著做 —— 這一批重來（整列蓋掉，重做無妨）
>                     retries++;
>                     Thread.sleep(100);
>                     continue;
>                 }
> ```

搬家程式如果把變更紀錄的號碼當成順序（讀到哪一號，就記下「這一號以前都處理過了」），追上了才停寫，結果是這樣的：

```
═══ 2.8.4 ③ 舊的庫是唯一寫入者：trigger 記下變更，回填之後照著追；最後停寫、追完、核對（load { 9.70 6.62 5.08 }）═══
    回填完成（inventory 1,000 列、inventory_reservations 317,928 列、inventory_ledger 635,364 列）
  單體　　　　　　│ 30 秒：下單 5,243 張（每秒 172，p50 30.5 ms）、取消 1,765、付款 1,722、錯誤 2
  變更紀錄落後幾筆（每秒）：2,091 4,161 6,345 8,598 10,566 12,546 14,694 17,127 19,659 22,050 24,087 26,289 28,701 31,413 33,366 35,667 38,046 40,413 42,783 45,252 47,469 49,695 52,005 54,570 56,994 59,451 61,905 44,104 6,405 116
  搬家程式：套用了 68,206 筆變更紀錄；最多落後 61,905 筆；新的庫斷線時重試了 19 次（回填 19 次、追變更 0 次）
  停寫 1367 ms：追完最後的變更 18 ms ＋ 核對 1348 ms；兩邊不一樣的表：{inventory=舊 1000/2175827840263 ≠ 新 1000/2177705278900, inventory_reservations=舊 327711/703794364776830 ≠ 新 327707/703788352181111, inventory_ledger=舊 637086/1367802356748636 ≠ 新 637079/1367782634858705}
  逐列比對（實驗才做得到）：只在舊庫 / 只在新庫 / 內容不同
    inventory                            0 /       0 /      11
    inventory_reservations               4 /       0 /       0
    inventory_ledger                     7 /       0 /       0
    inventory_ledger_checkpoints         0 /       0 /       0
    inventory_ledger_watermark           0 /       0 /       0
    inventory 的 reserved 對不上的商品：11 個，差的件數合計 12
```

> ⚠️ **搬家程式漏了東西：11 個商品的庫存對不上，4 筆預留、7 筆帳沒搬過去。** 跟 ② 不一樣的是，這一次的「漏」完全可以解釋 —— 而且第 12 站已經犯過一次同樣的錯。
>
> 變更紀錄的 `seq` 是 `AUTO_INCREMENT`：**號碼在 trigger 的 `INSERT` 那一刻就發了，那一列卻要等它的交易 commit 才看得到。** 號碼小的交易可以比號碼大的晚 commit。搬家程式讀到 101 號，就記下「101 以前都處理過了」—— 而 100 號那時候還在路上（它的交易還沒 commit）；等它 commit 了，搬家程式已經不會再回頭看。
>
> 第 12 站 9.12 的 J11b 是同一件事：對帳的水位線越過了一筆還沒 commit 的帳，那一筆就永遠不會被加進累計。那一次的修法是「水位線只前進到夠舊的帳」（5 分鐘）。
>
> **這個錯只有在搬家程式追上的時候才看得到。** 搬家程式如果一直落在後面幾萬筆，讀到的永遠是「早就 commit 了」的紀錄，最後在停寫之後一口氣追完 —— 漏不掉。「追上了才停寫」，搬家程式才會在單體還在寫的時候讀到紀錄的**尾巴**，正在 commit 的那幾個交易就在那裡。

修法：記下「洞」—— 比讀到的最大號碼小、但還沒看到的號碼 —— 每一輪再問一次；**過了 60 秒還沒出現，才當成 rollback**（60 秒大於 `innodb_lock_wait_timeout` 的 50 秒：一個交易拿到號碼之後，最久還要等這麼久才 commit）。停寫的時候，先確認舊庫上沒有進行中的交易（`information_schema.innodb_trx`），剩下的洞才全部當成 rollback：

```java
    /**
     * 2.8.4 ⚠️ 第一版的 bug：變更紀錄的 seq 是 AUTO_INCREMENT —— 號碼在 trigger INSERT 的那一刻就發了，那一列卻要等它的交易 commit 才看得到。
     * 號碼小的交易可以比號碼大的晚 commit：讀到 101 的時候，100 可能還在路上。第一版直接記「讀到 101 了」，100 就永遠被跳過
     * （第 12 站 9.12 J11b 的同一個錯：水位線越過了還沒 commit 的那一列）。
     * 所以記下「洞」：比 maxSeen 小、還沒看到的號碼，每一輪再問一次。過了 HOLE_TTL 還沒出現 → 那個交易 rollback 了（號碼不會還回去）
     */
    static final long HOLE_TTL_MS = 60_000;                                 // > innodb_lock_wait_timeout（50 秒）：拿到號碼之後，交易最久還要等這麼久才 commit
    long maxSeen = 0;
    final Map<Long, Long> holes = new LinkedHashMap<>();                    // seq → 第一次發現它是洞的時間
    long holesFound, holesFilled, holesExpired;

    …

        long now = System.currentTimeMillis();
        for (long[] c : changes) {
            long seq = c[0];
            if (holes.remove(seq) != null) { holesFilled++; continue; }   // 洞補上了：那個交易後來 commit 了
            if (seq > maxSeen) {
                for (long h = maxSeen + 1; h < seq; h++) { holes.put(h, now); holesFound++; }
                maxSeen = seq;
            }
        }
        holes.entrySet().removeIf(e -> {                                    // 太久沒出現：rollback 了
            if (now - e.getValue() <= HOLE_TTL_MS) return false;
            holesExpired++;
            return true;
        });
        if (changes.isEmpty()) return 0;

    …

    /** 停寫、確認舊庫上沒有進行中的交易之後：剩下的洞都是 rollback（不會再有人 commit 它們）。回傳關掉幾個 */
    int closeHoles() {
        int n = holes.size();
        holesExpired += n;
        holes.clear();
        return n;
    }
```

修好之後：

```
═══ 2.8.4 ③ 舊的庫是唯一寫入者：trigger 記下變更，回填之後照著追；最後停寫、追完、核對（load { 6.01 4.86 5.03 }）═══
    回填完成（inventory 1,000 列、inventory_reservations 321,588 列、inventory_ledger 639,968 列）
  單體　　　　　　│ 28 秒：下單 5,380 張（每秒 189，p50 28.3 ms）、取消 1,799、付款 1,773、錯誤 0
  變更紀錄落後幾筆（每秒）：2,541 5,022 7,116 9,261 11,478 14,136 16,644 19,473 22,233 25,062 27,600 30,099 32,655 35,283 37,746 40,014 42,246 44,721 47,400 49,197 51,483 54,201 56,421 59,166 61,893 64,752 27,200 69
  搬家程式：套用了 69,930 筆變更紀錄；最多落後 64,752 筆；新的庫斷線時重試了 19 次（回填 19 次、追變更 0 次）
  號碼的洞：發現 14 個，之後補上 14 個（那個交易比後面的晚 commit），過期 0 個；停寫時舊庫上進行中的交易 0 個 → 剩下的 0 個洞當成 rollback
  停寫 1482 ms：追完最後的變更 32 ms ＋ 核對 1450 ms；兩邊不一樣的表：沒有
  逐列比對（實驗才做得到）：只在舊庫 / 只在新庫 / 內容不同
    inventory                            0 /       0 /       0
    inventory_reservations               0 /       0 /       0
    inventory_ledger                     0 /       0 /       0
    inventory_ledger_checkpoints         0 /       0 /       0
    inventory_ledger_watermark           0 /       0 /       0
    inventory 的 reserved 對不上的商品：0 個，差的件數合計 0
```

- **五張表、逐列比對全部是 0。** 新的庫斷線的那 2 秒，搬家程式重試了 19 次 —— 變更紀錄還在舊的庫裡，等它回來接著追就好。② 那幾百個「寫不進去就算了」的交易（488～560 個），在這裡不存在。
- **號碼的洞**：發現 14 個，**14 個後來全部補上了** —— 14 次「號碼小的交易比號碼大的晚 commit」，不記洞的話會把它們全部跳過。0 個過期；停寫時舊庫上沒有進行中的交易，所以也沒有洞要當成 rollback。
- **停寫 1,482 ms**：追完最後的變更、核對。① 是 12 秒。這段時間主要是核對（兩個庫各掃一次五張表）；真的 5,000 萬筆帳，核對也要分段做（例如只核對「這一次搬家期間變過的那些主鍵」，加上事前已經做過的全表核對）。
- **落後的那一行**：回填的十幾秒裡，紀錄一直累積（單體照常營業）；回填完之後搬家程式開始追，追的速度比單體寫的速度快，落後才降下來。**這是「能不能不停機」的真正條件：搬家程式追的速度，要比單體寫的速度快。** 追不上，就永遠等不到停寫的那一刻。

**trigger 的代價**：每一列的寫入多一句 `INSERT`（同一個交易裡）。一張三個品項的訂單，下單時多 9 句（3 列庫存、3 筆預留、3 筆帳）。有、沒有 trigger 各 5 秒、交錯 4 輪：

```
═══ 2.8.4 ④ trigger 的代價：有／沒有 trigger 各 5 秒、交錯 4 輪（load { 7.24 5.32 5.19 }）═══
  沒有         │ 下單 4,713 張（每秒 236）│ p50 22.6 ms │ p99 54.1 ms
  有 trigger  │ 下單 4,342 張（每秒 217）│ p50 24.0 ms │ p99 76.6 ms
  變更紀錄這段時間多了 56,451 筆
  （結束時 load { 8.85 5.96 5.43 }）
```

**兩次量的結果不一樣。** 這一次有 trigger 的吞吐少了 8%、p50 多 1.4 ms、p99 多 22 ms；同一段程式碼的前一次是：

```
  沒有         │ 下單 4,674 張（每秒 234）│ p50 23.1 ms │ p99 45.8 ms
  有 trigger  │ 下單 4,635 張（每秒 232）│ p50 23.1 ms │ p99 52.6 ms
```

吞吐只少 1%、p50 一樣、p99 多 7 ms。方向一致（有 trigger 比較慢、尾巴比較長），大小不確定 —— 一張訂單多 9 句 `INSERT`，在這台機器上是幾個百分點的量級。要更確定，就要更多輪、更長的時間（下面的 📌）。搬家通常只開幾天，這個代價多半付得起；它的另一個代價是**每一張表都要裝、要記得拆**。

> ⚠️ **為什麼要交錯量。** 拿「營業的前 10 秒」（沒有 trigger）跟「③ 那 20 秒」（有 trigger）比，對照是每秒 136 張，③ 每秒 203 張：**有 trigger 比沒有快**。不是 trigger 讓它變快，是第一段的 JVM 剛起來、還沒 JIT（同一個單體，第一次跑 10 秒的數字一定吃虧）。所以先熱身 5 秒，代價用交錯量（第 00 章 0.2.1 的做法）。

> 📌 **多量幾輪 —— 「少 8%」是雜訊。** `C4DataMigrationTest` 多一個只量這一件事的方法（程式碼在 `d04` 分支上：第 04 章結束的 `4512f05` 之後的 commit `a208c4e`；下面的數字是在第 02 章的程式碼上量的）：單體起來、裝好變更紀錄、熱身 5 秒，然後有／沒有 trigger 各 10 秒、交錯 10 輪，每一輪各印一行（只印合計的話，看不出輪與輪之間差多少）：
>
> ```diff
>                  (freeze1 - drained) / 1e6, diff.isEmpty() ? "沒有" : diff);
>          report(copier);
>          assertThat(diff).isEmpty();
> -        triggerCost(mono, copier);
> +        triggerCost(mono, copier, 4, 5);
>          copier.dropCapture();
>      }
>
> -    /** ④ trigger 的代價：每一列的寫入多一句 INSERT（同一個交易）。有、沒有 trigger 各 5 秒，交錯 4 輪 —— 不交錯的比較會被機器當下的狀態蓋過去 */
> -    void triggerCost(ConfigurableApplicationContext mono, Copier copier) throws Exception {
> -        out.printf("═══ 2.8.4 ④ trigger 的代價：有／沒有 trigger 各 5 秒、交錯 4 輪（load %s）═══%n", SplitLab.load());
> +    /**
> +     * 2.8.4 ④ 的追記：只量 trigger 的代價，多量幾輪。第一版（上面 capture() 的最後）只有各 5 秒 × 4 輪，兩次執行的結果差很多。
> +     *   mvn test -Pexperiments -Dtest='C4DataMigrationTest#triggerCostOnly' -Dd02.rounds=10 -Dd02.seconds=10
> +     */
> +    @Test
> +    void triggerCostOnly() throws Exception {
> +        SplitLab.freshDatabase(OLD);
> +        SplitLab.freshDatabase(NEW);
> +        List<String> a = new ArrayList<>(SplitLab.common(OLD, 8));             // 跟 migration() 一樣的單體（同一個 DualWriteTap）
> +        a.removeIf(x -> x.startsWith("--spring.datasource.url="));
> +        a.add("--spring.datasource.url=" + SplitLab.url(OLD) + "&queryInterceptors=" + DualWriteTap.class.getName());
> +        try (ConfigurableApplicationContext mono = Split.flushed(new SpringApplicationBuilder(ShopApplication.class).run(a.toArray(String[]::new)))) {
> +            Flyway.configure().dataSource(SplitLab.url(NEW), "shop_migrator", "shop_migrator")
> +                    .locations("classpath:db/migration/inventory", "classpath:db/migration/shared").load().migrate();
> +            seed();
> +            Copier copier = new Copier(OLD, NEW);
> +            copier.installCapture();
> +            try (Load warm = new Load(mono, THREADS)) { Thread.sleep(5_000); }
> +            triggerCost(mono, copier, Integer.getInteger("d02.rounds", 10), Integer.getInteger("d02.seconds", 10));
> +            copier.dropCapture();
> +            out.printf("  （結束時 load %s）%n", SplitLab.load());
> +        }
> +    }
> +
> +    /**
> +     * ④ trigger 的代價：每一列的寫入多一句 INSERT（同一個交易）。有、沒有 trigger 各 seconds 秒，交錯 rounds 輪 —— 不交錯的比較會被機器當下的狀態蓋過去。
> +     * 追記：每一輪各印一行（第一版只印合計，看不出輪與輪之間差多少）
> +     */
> +    void triggerCost(ConfigurableApplicationContext mono, Copier copier, int rounds, int seconds) throws Exception {
> +        out.printf("═══ 2.8.4 ④ trigger 的代價：有／沒有 trigger 各 %d 秒、交錯 %d 輪（load %s）═══%n", seconds, rounds, SplitLab.load());
>          long[] placed = new long[2];
>          List<List<Long>> nanos = List.of(new ArrayList<>(), new ArrayList<>());
> -        for (int round = 0; round < 4; round++)
> +        for (int round = 0; round < rounds; round++) {
> +            long[] perRound = new long[2];
>              for (int with = 0; with < 2; with++) {
>                  if (with == 1) copier.installTriggers(); else copier.dropTriggers();
>                  try (Load load = new Load(mono, THREADS)) {
> -                    Thread.sleep(5_000);
> +                    Thread.sleep(seconds * 1_000L);
>                      load.close();
> +                    perRound[with] = load.placed.get();
>                      placed[with] += load.placed.get();
>                      nanos.get(with).addAll(load.placeNanos);
>                  }
>              }
> +            if (rounds > 4) out.printf("  第 %2d 輪 │ 沒有 %,d 張、有 trigger %,d 張（%+.1f%%）%n", round + 1, perRound[0], perRound[1], 100.0 * (perRound[1] - perRound[0]) / perRound[0]);
> +        }
>          for (int with = 0; with < 2; with++) {
>              long[] s = nanos.get(with).stream().mapToLong(Long::longValue).sorted().toArray();
> -            out.printf("  %-10s │ 下單 %,d 張（每秒 %.0f）│ p50 %.1f ms │ p99 %.1f ms%n", with == 1 ? "有 trigger" : "沒有", placed[with], placed[with] / 20.0,
> +            out.printf("  %-10s │ 下單 %,d 張（每秒 %.0f）│ p50 %.1f ms │ p99 %.1f ms%n", with == 1 ? "有 trigger" : "沒有", placed[with], placed[with] / (double) (rounds * seconds),
>                      SplitLab.pct(s, 50), SplitLab.pct(s, 99));
>          }
>          out.printf("  變更紀錄這段時間多了 %,d 筆%n", SplitLab.count(OLD, "SELECT COUNT(*) FROM d02_changes WHERE seq > " + copier.maxSeen));
> ```
>
> ```bash
> mvn test -Pexperiments -Dtest='C4DataMigrationTest#triggerCostOnly' -Dd02.rounds=10 -Dd02.seconds=10
> ```
>
> ```
> ═══ 2.8.4 ④ trigger 的代價：有／沒有 trigger 各 10 秒、交錯 10 輪（load { 10.84 11.03 8.85 }）═══
>   第  1 輪 │ 沒有 1,239 張、有 trigger 1,420 張（+14.6%）
>   第  2 輪 │ 沒有 1,751 張、有 trigger 1,687 張（-3.7%）
>   第  3 輪 │ 沒有 1,912 張、有 trigger 1,780 張（-6.9%）
>   第  4 輪 │ 沒有 2,034 張、有 trigger 1,949 張（-4.2%）
>   第  5 輪 │ 沒有 1,952 張、有 trigger 1,862 張（-4.6%）
>   第  6 輪 │ 沒有 1,923 張、有 trigger 1,906 張（-0.9%）
>   第  7 輪 │ 沒有 2,137 張、有 trigger 2,187 張（+2.3%）
>   第  8 輪 │ 沒有 2,163 張、有 trigger 1,971 張（-8.9%）
>   第  9 輪 │ 沒有 1,919 張、有 trigger 1,945 張（+1.4%）
>   第 10 輪 │ 沒有 2,271 張、有 trigger 2,101 張（-7.5%）
>   沒有         │ 下單 19,301 張（每秒 193）│ p50 26.7 ms │ p99 78.5 ms
>   有 trigger  │ 下單 18,808 張（每秒 188）│ p50 27.3 ms │ p99 81.8 ms
>   變更紀錄這段時間多了 251,007 筆
>   （結束時 load { 12.78 12.55 10.01 }）
> ```
>
> 跑了三次（上面是第 2 次）：
>
> | | 第 1 次 | 第 2 次 | 第 3 次 |
> |---|---|---|---|
> | 沒有 / 有 trigger：每秒 | 204 / 205 | 193 / 188 | 198 / 194 |
> | 吞吐的差（合計的張數） | +0.5% | -2.6% | -2.3% |
> | 拿掉第 1 輪之後 | -0.1% | -3.7% | -3.3% |
> | p99：沒有 / 有 | 63.2 / 62.4 ms | 78.5 / 81.8 ms | 74.4 / 81.4 ms |
> | 同一次執行裡，每一輪的差 | -12.2%～+18.1% | -8.9%～+14.6% | -32.7%～+10.4% |
> | load（開始時） | 13.47 | 10.84 | 11.05 |
>
> 三件事：
>
> - **輪與輪之間的差，比 trigger 的代價大一個數量級。** 同一次執行、同一個 JVM，相鄰兩段 10 秒就可以差 10%～30%（第 3 次的第 5 輪：-32.7%）。trigger 的代價在三次合計裡是 0～3%：上面那兩次量（少 1%、少 8%）都落在雜訊裡，「少 8%」不是 trigger。
> - **一個偏差：每一輪都先量「沒有」。** 熱身之後的第一輪，JVM 還在加速（第 1 輪的每一段 1,239～1,650 張，之後的輪多半是 1,800～2,300 張）—— 三次的第 1 輪，「有 trigger」都比較多（+6.9%、+14.6%、+10.4%）。拿掉第 1 輪，差是 -0.1%～-3.7%。上面那兩次只有 4 輪，第 1 輪佔四分之一，這個偏差更重。要消掉它，順序要輪流（這一輪先「沒有」、下一輪先「有」），這一節沒有再做。
> - **能說的：一張訂單多 9 句 `INSERT`，吞吐少 0～4%、p99 多 0～7 ms。** 這台機器這一段時間的 load 是 10～13（同時還有別的程式在跑），量得出方向、量不出精確的大小。結論跟上面一樣：搬家只開幾天，付得起。

### 2.8.5 切過去、回得來

③ 的最後一步「核對通過」之後，才輪到流量：

1. 庫存服務指向新的庫，起來（它跑自己的資料夾：新的庫已經有那 9 個 migration 的歷史嗎？—— 新的庫是用庫存服務自己的 Flyway 建的，2.4.2，有）。
2. 單體的 `InventoryApi` 換成遠端的實作（2.4.6 的 `RemoteInventory` 那一種，第 03 章做成正式的）。
3. 單體恢復接單。
4. 拆掉舊庫上的 trigger 與變更紀錄；舊庫的庫存表**先不刪**。

**回得來嗎？** 切過去之後，新的庫才是正本，舊庫的庫存表從那一刻起就過時了。要能回滾，就要**反過來再追一次**：在新的庫裝同樣的變更紀錄，讓搬家程式把新庫的變更搬回舊庫。回滾的時候，同樣「停寫、追完、核對、切回來」。不做這一步，「回滾」就是「接受遺失切換之後的每一筆庫存變更」。第 09 章處理遷移的這一面（灰度、回滾計畫）。

**真的搬家用什麼工具。** 這一節用 trigger，是因為它在一台 compose 的 MySQL 上就做得到，而且每一步都看得見。正式環境裡更常見的兩種：

| | trigger（這一節） | binlog 的變更擷取（Debezium、Maxwell…） | MySQL 的複寫（只複寫這幾張表） |
|---|---|---|---|
| 寫入的額外成本 | 每一列多一句 `INSERT`，在同一個交易裡 | 幾乎沒有：讀的是 MySQL 本來就在寫的 binlog | 同左 |
| 順序 | 號碼不是 commit 的順序 —— 要處理洞（2.8.4 的 ⚠️） | **binlog 就是 commit 的順序**，沒有洞的問題 | 同左 |
| 要多架什麼 | 不用 | 一個常駐的擷取服務（Debezium 通常搭 Kafka） | 新的庫要是一台 MySQL，設成 replica、加表的過濾 |
| 新的庫可以長得不一樣嗎 | 可以（搬家程式自己寫） | 可以 | 不行：表要一樣 |

**binlog 是 commit 的順序** —— 這一節那個洞，就是 trigger 這種做法天生要處理的問題。用 binlog 的工具，第一件得到的就是這個。

這一節最重要的結論不是工具，是那條原則：**搬家的時候，只能有一個寫入者。** ② 的每一種錯，都來自兩個寫入者；③ 的每一個步驟，都是為了讓新的庫只是一個副本，直到切換的那一刻。

> 📌 **上面的四步，加一個灰度就不成立。** 第 09 章 9.2 照這四步切過去，只多做一件事 —— 先切 10% 的流量試試看：搬家程式繼續追，庫存服務接新的庫。灰度的那一段，新的庫同時被庫存服務與搬家程式寫，「直到切換的那一刻」變成了一段時間：庫存超賣，而這一節的核對說兩個庫一樣（灰度寫進新的庫的，被搬家程式蓋掉了）。第 09 章把順序反過來：**程式先搬、資料最後搬**（9.3.4）—— 兩個服務先接舊的庫，灰度、回滾都在同一份資料上做；資料最後一次切，用的是這一節的搬家程式，加上遷移期的對帳（9.6.3）、切換時一起搬的共用表的幾列（9.6.4），以及上面「回得來嗎」那一段的反方向搬家程式（9.6.6、9.7）。

### 2.8.6 binlog 的變更擷取

這一節的程式碼在 `d09` 分支上（第 09 章結束的 `9a5e7b1` 之後的 commit），實驗（M11）要第 08、09 章的 kind 環境。

2.8.5 的表說「binlog 的變更擷取（Debezium、Maxwell…）」是正式環境更常見的做法，前面一直用 trigger。這裡做一個讀 binlog 的搬家程式（`BinlogCopier`，在第 09 章的實驗目錄），其他都不變：

- **只拿 binlog 來知道「哪一個主鍵變了」**，搬的時候照 2.8.4 的做法，再去正本讀現在的那一列、整列寫過去（正本沒有了就刪）。寫過去的永遠是正本現在的樣子：同一列變了三次只搬一次，回填與 binlog 重疊的那一段搬兩次也一樣。
- **接上 binlog** 用 mysql-binlog-connector-java（`com.zendesk` 發布的 0.31.0；Debezium 的 MySQL connector 底下用的是它的一個 fork）：像一台 replica 一樣連上 MySQL（這台 compose 的 MySQL 8.0 預設就開著 binlog、ROW 格式）。帳號要有 `REPLICATION SLAVE`、`REPLICATION CLIENT`（實驗用 root），`server_id` 不能跟別的 replica 撞。
- **起點**：回填之前先記下 binlog 的位置（`SHOW MASTER STATUS`），回填完從那裡接上 —— 回填途中改的列，接上之後一定看得到。
- **追完**（停寫之後）：再記一次位置，等讀到那裡、排隊的主鍵都搬完。

```java
    /** 記下位置 → 回填五張表 → 從記下的位置接上 binlog（背景執行緒）。回傳回填了幾列 */
    public long start() throws Exception {
        String[] at = masterStatus();
        long copied = 0;
        for (String t : Copier.TABLES.keySet()) copied += copier.backfill(t);
        client.setBinlogFilename(at[0]);
        client.setBinlogPosition(Long.parseLong(at[1]));
        file = at[0];
        position = Long.parseLong(at[1]);
        client.connect(10_000);
        return copied;
    }
```

```java
    /** 停寫之後：等 binlog 讀到正本現在的位置，再把排隊的搬完。回傳搬了幾個 */
    @Override
    public int drain() throws Exception {
        String[] at = masterStatus();
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30);
        while (!reached(at)) {
            if (System.nanoTime() > deadline) throw new IllegalStateException("30 秒內 binlog 沒有讀到 " + String.join(":", at) + "（現在 " + file + ":" + position + "）");
            Thread.sleep(5);
        }
        int n, total = 0;
        while ((n = apply()) > 0) total += n;
        return total;
    }
```

跟 2.8.4 的 trigger 比，少了兩樣東西：**正本上沒有 trigger、沒有變更紀錄表**（2.8.4 ④ 量的那一筆寫入成本沒有了），以及 **2.8.4 的那個洞** —— binlog 只有 commit 過的交易、照 commit 的順序寫，「號碼小的晚 commit」不會發生，`closeHoles()` 永遠是 0。多了一樣：一個像 replica 一樣常駐、讀著**整台 MySQL** 的 binlog 的程式（不是只有那幾張表：M11 接上之後的頭幾秒就讀了 2,042 則事件，其中搬家的五張表的列 72 個）。

在真的流量下切一次、切回來一次，量在第 09 章 9.6.8。

---

## 2.9 流程測試與追溯表

### 2.9.1 這一章新增的測試與實驗

| 名稱 | 種類 | 跑在哪裡 | 量／守什麼 |
|---|---|---|---|
| `ServiceDatabaseTest` | **測試**（預設的測試組） | Testcontainers | 庫存的資料夾＋`shared`、其他資料夾＋`shared`，各自從空資料庫跑得起來，剛好是自己的表與授權（2.4.5） |
| `ReservationReconciliationTest` | **測試** | Testcontainers | 對帳：X-1、X-2 釋放；X-3、X-4、X-5 告警；grace 之內的、一致的不動（2.6.5） |
| `ProductCreatedFlowTest` | **測試** | Testcontainers（真的 relay、RabbitMQ） | 建立商品 → `product.created` → 庫存列與 INITIAL 帳；「沒有庫存列」的那段時間（2.7.5） |
| `OrderJobsIsolationTest` | 測試（第 12 站 4.7.1） | Testcontainers | 同一批排程裡一張訂單的取消丟出資料庫錯誤，另一張照樣取消（2.5.3 的 S5'） |
| `EventFlowTest.mailerDownDeadLetters` | 測試（改；第 12 站 7.7.3） | Testcontainers（真的 RabbitMQ） | 看到 `FAILED` 之後，等死信到了才讀佇列（2.10） |
| `MigrationOwnershipTest` | 測試（改） | —— | 多一條規則：資料夾 = 模組（2.4.1） |
| `CatalogCartApiTest`、驗收 Q6、`CrossModuleCallInTxTest` | 測試（改） | Testcontainers | 交付 `product.created`；`Files.walk`；清單 12 → 11 種（2.4.1、2.7.5） |
| `C1SharedSchemaTest` | 實驗 | 兩個服務、一個 JVM（`shop_d02_order`、`shop_d02_inv`） | 三種部署跑使用者的一天：SQL 落在哪一個庫（2.2、2.4.7、2.7.6） |
| `C2BrokenTransactionTest` | 實驗 | 同上 | 切斷的交易在遠端 commit 之後失敗：留下什麼、下一步會不會收斂（2.5.3） |
| `C3ReconciliationTest` | 實驗 | 同上 | 對帳 vs 跨庫 JOIN；10 萬張訂單、30 萬筆預留的成本（2.6.6） |
| `C4DataMigrationTest` | 實驗 | 單體（`shop_d02_mono`）→ 新的庫（`shop_d02_newinv`） | 停寫搬家、雙寫、變更紀錄 + 回填 + 停寫核對；trigger 的代價（2.8） |

預設的測試組從第 01 章的 230 個，變成 234 個（2.10）。

### 2.9.2 回頭量：四個代價

K1～K5 用的是第 00 章的支架（兩個庫都跑全部的 migration、只有 `reserve` 與可售量走 HTTP）—— 這一章沒有改它，也沒有改下單的路徑。重跑一次，確認沒有變壞：

```bash
mvn test -Pexperiments -Dtest=K1SplitLatencyTest      # 然後 K2、K3、K5，一次一個
```

```
═══ 0.2.1 一張一張送：每種 5 輪 × 100 張、三種部署交錯（load { 6.94 6.75 5.31 }）═══
   1 個品項 │ 一個行程       │ p50  10.19 ms │ p90  13.41 ms │ p99  29.15 ms │ {201=500}
   1 個品項 │ 切開：一次呼叫    │ p50  13.07 ms │ p90  16.14 ms │ p99  28.67 ms │ {201=500}
   1 個品項 │ 切開：每項一次    │ p50  12.84 ms │ p90  16.95 ms │ p99  26.62 ms │ {201=500}
   3 個品項 │ 一個行程       │ p50  10.80 ms │ p90  14.28 ms │ p99  26.71 ms │ {201=500}
   3 個品項 │ 切開：一次呼叫    │ p50  14.09 ms │ p90  18.81 ms │ p99  43.42 ms │ {201=500}
   3 個品項 │ 切開：每項一次    │ p50  18.09 ms │ p90  22.85 ms │ p99  41.42 ms │ {201=500}
  10 個品項 │ 一個行程       │ p50  14.88 ms │ p90  21.15 ms │ p99  37.84 ms │ {201=500}
  10 個品項 │ 切開：一次呼叫    │ p50  16.25 ms │ p90  21.33 ms │ p99  32.74 ms │ {201=500}
  10 個品項 │ 切開：每項一次    │ p50  33.75 ms │ p90  44.26 ms │ p99  73.78 ms │ {201=500}
═══ 0.2.1 16 條執行緒同時送 3 個品項的訂單：每種 15 秒 × 2 輪、交錯（load { 4.18 5.88 5.11 }）═══
  一個行程       │ 11,202 張（每秒   373）│ p50  39.29 ms │ p99   87.85 ms │ {201=11202}
  切開：一次呼叫    │  8,570 張（每秒   286）│ p50  49.64 ms │ p99  156.91 ms │ {201=8570}
  切開：每項一次    │  6,521 張（每秒   217）│ p50  64.90 ms │ p99  191.68 ms │ {201=6521}
  （結束時 load { 13.25 8.39 6.14 }）
```

```
═══ 0.2.2 ① reserve() 之後、commit 之前失敗：每種部署 100 張（load { 10.99 8.12 6.08 }）═══
  一個行程   │ 回應 {500=100} │ 這位買家的訂單 0 張 │ 沒有訂單的預留 +0 列 │ reserved +0 件
  切開     │ 回應 {500=100} │ 這位買家的訂單 0 張 │ 沒有訂單的預留 +300 列 │ reserved +300 件
═══ 0.2.2 ② 庫存服務 commit 之後慢 1.5 秒才回應，訂單服務只等 1 秒：20 張（load { 10.35 8.04 6.06 }）═══
  第一次送   │ 回應 {500=20} │ 訂單 +0 張 │ 沒有訂單的預留 +60 列 │ reserved +60 件
  同一個鍵重送 │ 回應 {201=20} │ 訂單 +20 張 │ 沒有訂單的預留 +60 列 │ reserved +120 件
  （結束時 load { 7.96 7.67 5.99 }）
```

```
═══ 0.2.3 庫存服務變慢：訂單服務的其他 API 怎麼了（每秒 20 張下單；load { 7.07 7.50 5.97 }）═══
  正常    │ 下單       │  400 次 │ p50     21.7 ms │ p99     49.9 ms │ max    108.9 ms │ {201=400}
  正常    │ 商品詳情     │   94 次 │ p50      5.3 ms │ p99     23.8 ms │ max     23.8 ms │ {200=94}
  正常    │ 我的訂單     │   94 次 │ p50      5.0 ms │ p99     24.2 ms │ max     24.2 ms │ {200=94}
  慢 3 秒 │ 下單       │  400 次 │ p50   6044.1 ms │ p99  13950.4 ms │ max  14243.3 ms │ {201=223, 503=177}
  慢 3 秒 │ 商品詳情     │   13 次 │ p50      6.8 ms │ p99     11.1 ms │ max     11.1 ms │ {200=13}
  慢 3 秒 │ 我的訂單     │   13 次 │ p50   1867.9 ms │ p99   3006.5 ms │ max   3006.5 ms │ {200=12, 503=1}
  恢復    │ 下單       │  400 次 │ p50     21.1 ms │ p99   1662.3 ms │ max   1913.9 ms │ {201=400}
  恢復    │ 商品詳情     │   85 次 │ p50      4.7 ms │ p99     73.0 ms │ max     73.0 ms │ {200=85}
  恢復    │ 我的訂單     │   85 次 │ p50      4.2 ms │ p99    185.2 ms │ max    185.2 ms │ {200=85}
  （連線池：慢的那 20 秒，active 一直是 20，pending 最多 155）
```

```
═══ 0.2.4 ② 同一張訂單，兩個服務的 traceId（真的庫存服務）（load { 4.10 6.43 5.69 }）═══
  自己 RestClient.builder()          │ 訂單服務 201 20261013-492523，X-Trace-Id 6acde088b71c2547c50a967f07735376
                                   │ 庫存服務 [.1-18311-exec-3] [6acde0883a3d6a583057c3750bf475c5-c9fb40fe323b9850] c.e.shop.dist00.LabInventoryService      : D00_RESERVE orderId=1 traceparent=null
  Spring 的 RestClient.Builder      │ 訂單服務 201 20261013-894525，X-Trace-Id 6acde08a4b90b4675d8c7c5a7b2b8f9f
                                   │ 庫存服務 [.1-18311-exec-5] [6acde08a952a04e12a67d08d040d2801-a7d03ee94d23ac38] c.e.shop.dist00.LabInventoryService      : D00_RESERVE orderId=2 traceparent=null
```

（K3 的連線池逐秒的那 60 行、K5 的 ① 沒有列出來；這裡只摘要。）

| | 第 00 章 | 第 01 章之後 | 第 02 章之後 | 這一章有沒有改到它 |
|---|---|---|---|---|
| K1 一張一張送：10 個品項，一次呼叫 / 每項一次（p50） | 17.76 / 37.34 ms | 16.67 / 33.92 ms | 16.25 / 33.75 ms | 沒有 |
| K1 16 條執行緒：一個行程 / 一次呼叫 / 每項一次（每秒） | 376 / 307 / 247 | 349 / 279 / 229 | 373 / 286 / 217 | 沒有（見下面） |
| K2 ① 孤兒預留；② 同一個鍵重送後 `reserved` 多出來的 | 300 列；120 件 | 300 列；120 件 | 300 列；120 件 | 沒有 —— 但現在有人收（C3） |
| K3 慢 3 秒：下單 503；「我的訂單」p50 | 192 張；1,862 ms | 187 張；2,057 ms | 177 張；1,868 ms | 沒有：`reserve()` 還在下單交易裡 |
| K5 traceId | 兩邊都斷 | 兩邊都斷 | 兩邊都斷 | 沒有 |

**四個代價，這一章一個都沒有減少** —— 跟第 01 章一樣，這是預期的：它們量的都是下單，而下單交易裡的遠端呼叫要等第 04 章。K1 的吞吐三種部署這一次都高了一些（一個行程 349 → 373），第 01 章說過不能拿單次執行的差別歸因（兩次執行就差 8%），這裡也一樣。

這一章換到的東西，K1～K5 量不到：

- **0.2.2 的孤兒現在有人收。** K2 留下的 300 件，在切開的部署裡會被對帳在一輪之內找到、釋放（C3 ①：100 張、300 件，跟跨庫 JOIN 一樣）—— 但要等 grace（5 分鐘）之後，這段時間那 300 件賣不出去。
- **資料庫真的分開了**（C1 ③）：K1～K5 的支架仍然是「兩個庫都有全部的表」的那一種；第 03 章起，實驗改用這一章的誠實的庫。

### 2.9.3 B1 重跑：直接讀表有沒有新的線

第 01 章 1.12 說「B1 會在第 02 章結束時重跑一次：資料庫拆開之後，『直接讀表』那一欄會不會冒出新的線」。工作負載多走了兩件事：建立商品之後交付 `product.created`、最後跑一次 `ReservationReconciliation`：

```bash
mvn test -Pexperiments -Dtest=B1BoundaryMapTest -Dd01.range=ch09
```

```
═══ 1.4 使用者的一天：61 個 HTTP 請求、35 次事件交付、5 個排程（load { 9.06 7.02 5.32 }）═══
  記到：跨模組的同步呼叫 81 次、commit 的交易 233 個、讀別人的表 18 句
  走過的 API：35 支 [DELETE /api/cart/items/{productId}, GET /api/admin/reports/daily-sales, GET /api/admin/reports/top-products, GET /api/cart, GET /api/me, GET /api/orders, GET /api/orders/{orderNo}, GET /api/products, GET /api/products/trending, GET /api/products/{id}, GET /api/seller/orders, GET /api/seller/products, GET /api/seller/reports/daily-sales, GET /api/seller/reports/top-products, PATCH /api/cart/items/{productId}, PATCH /api/seller/products/{id}, POST /api/admin/users/{id}/roles, POST /api/admin/users/{id}/suspend, POST /api/auth/login, POST /api/auth/refresh, POST /api/auth/register, POST /api/cart/items, POST /api/orders, POST /api/orders/{orderNo}/cancel, POST /api/orders/{orderNo}/confirm-receipt, POST /api/orders/{orderNo}/payments, POST /api/payments/callback, POST /api/seller/orders/{orderNo}/cancel, POST /api/seller/orders/{orderNo}/ship, POST /api/seller/orders/{orderNo}/start-picking, POST /api/seller/products, POST /api/seller/products/{id}/hot, POST /api/seller/products/{id}/publish, POST /api/seller/products/{id}/restock, POST /api/seller/products/{id}/unpublish]
═══ 1.4.1 第一把尺：跨模組的同步呼叫（呼叫端 → 介面.方法：次數，其中幾次在呼叫端的交易裡；哪些動作）═══
  cart → CatalogApi.snapshots                   9 次（交易裡  0，唯讀  0）  [DELETE /api/cart/items/{productId}, GET /api/cart, PATCH /api/cart/items/{productId}, POST /api/cart/items]
  cart → InventoryApi.available                 6 次（交易裡  0，唯讀  0）  [DELETE /api/cart/items/{productId}, GET /api/cart, PATCH /api/cart/items/{productId}, POST /api/cart/items]
  catalog → InventoryApi.available              9 次（交易裡  0，唯讀  0）  [GET /api/seller/products, PATCH /api/seller/products/{id}, POST /api/seller/products/{id}/hot, POST /api/seller/products/{id}/publish, POST /api/seller/products/{id}/restock, POST /api/seller/products/{id}/unpublish]
  catalog → InventoryApi.availableForDisplay    2 次（交易裡  0，唯讀  0）  [GET /api/products/{id}]
  catalog → InventoryApi.restock                1 次（交易裡  0，唯讀  0）  [POST /api/seller/products/{id}/restock]
  catalog → InventoryApi.setHot                 1 次（交易裡  1，唯讀  0）  [POST /api/seller/products/{id}/hot]
  ordering → CartApi.removeItems                6 次（交易裡  6，唯讀  0）  [POST /api/orders]
  ordering → CatalogApi.hotProducts             6 次（交易裡  0，唯讀  0）  [POST /api/orders]
  ordering → CatalogApi.snapshots               6 次（交易裡  0，唯讀  0）  [POST /api/orders]
  ordering → InventoryApi.activeReservations    1 次（交易裡  0，唯讀  0）  [排程 ReservationReconciliation.run]
  ordering → InventoryApi.confirm               4 次（交易裡  4，唯讀  0）  [POST /api/payments/callback]
  ordering → InventoryApi.consume               2 次（交易裡  2，唯讀  0）  [POST /api/seller/orders/{orderNo}/ship]
  ordering → InventoryApi.gateHot               6 次（交易裡  0，唯讀  0）  [POST /api/orders]
  ordering → InventoryApi.holdHot               2 次（交易裡  2，唯讀  0）  [POST /api/orders]
  ordering → InventoryApi.release               4 次（交易裡  4，唯讀  0）  [POST /api/orders/{orderNo}/cancel, POST /api/seller/orders/{orderNo}/cancel, 事件 inventory.hot-settlement-failed → ordering.stock-shortage, 排程 OrderJobs.cancelExpired]
  ordering → InventoryApi.reserve               4 次（交易裡  4，唯讀  0）  [POST /api/orders]
  ordering → PaymentApi.create                  4 次（交易裡  4，唯讀  0）  [POST /api/orders/{orderNo}/payments]
  ordering → PaymentApi.record                  4 次（交易裡  4，唯讀  0）  [POST /api/payments/callback]
  ordering → PaymentApi.requestRefund           2 次（交易裡  2，唯讀  0）  [POST /api/orders/{orderNo}/cancel, POST /api/seller/orders/{orderNo}/cancel]
  ordering → PaymentApi.succeededPaymentOf      2 次（交易裡  2，唯讀  0）  [POST /api/orders/{orderNo}/cancel, POST /api/seller/orders/{orderNo}/cancel]
═══ 1.4.2 第二把尺：寫了兩個以上模組的表的交易（動作：寫了哪些模組 × 個數）═══
  POST /api/orders  寫 [cart, inventory, ordering]                                            × 6
  POST /api/orders/{orderNo}/cancel  寫 [inventory, ordering, payment]                        × 1
  POST /api/payments/callback  寫 [inventory, ordering, payment]                              × 4
  POST /api/seller/orders/{orderNo}/cancel  寫 [inventory, ordering, payment]                 × 1
  POST /api/seller/orders/{orderNo}/ship  寫 [inventory, ordering]                            × 2
  排程 OrderJobs.cancelExpired  寫 [inventory, ordering]                                        × 1
  （commit 的交易一共 233 個，寫了兩個以上模組的 15 個）
═══ 1.4.2 一句 SQL 讀了別的模組的表（讀的模組 → 表：句數；哪些動作）═══
  reporting → orders（ordering）                  7 句  [GET /api/admin/reports/daily-sales, GET /api/admin/reports/top-products, GET /api/products/trending, GET /api/seller/reports/daily-sales, GET /api/seller/reports/top-products]
  reporting → order_items（ordering）             3 句  [GET /api/admin/reports/top-products, GET /api/products/trending, GET /api/seller/reports/top-products]
  reporting → products（catalog）                 3 句  [GET /api/admin/reports/top-products, GET /api/products/trending, GET /api/seller/reports/top-products]
  reporting → refunds（payment）                  4 句  [GET /api/admin/reports/daily-sales, GET /api/seller/reports/daily-sales]
  reporting → users（account）                    1 句  [GET /api/admin/reports/daily-sales]
═══ 事件：發送的模組 → 消費者（消費者所在的模組）═══
  catalog ─ product.created → inventory.product-created（inventory）               × 4
  inventory ─ inventory.stock-returned → inventory.hot-stock-return（inventory）   × 4
  ordering ─ order.placed → notification.order-events（notification）              × 6
  ordering ─ order.placed → inventory.hot-settlement（inventory）                  × 6
  ordering ─ order.paid → notification.order-events（notification）                × 4
  ordering ─ order.shipped → notification.order-events（notification）             × 2
  payment ─ refund.requested → payment.refunds（payment）                          × 2
  ordering ─ order.cancelled → notification.order-events（notification）           × 4
  payment ─ refund.succeeded → notification.order-events（notification）           × 2
  inventory ─ inventory.hot-settlement-failed → ordering.stock-shortage（ordering） × 1
═══ 1.5 127 種切法（ordering 留在原地，S 切出去）；變更耦合：ch09，36 個改到正式程式碼的 commit ═══
  名次 │ 切出去的 S                          │ 切斷的交易 │ 交易內呼叫 │ 同步呼叫 │ 直接讀表 │ 事件 │ 變更耦合
     1 │ notification                        │          0 │          0 │        0 │        0 │    5 │   8.3%（3）
     2 │ account                             │          0 │          0 │        0 │        1 │    0 │  11.1%（4）
     3 │ account+notification                │          0 │          0 │        0 │        1 │    5 │  13.9%（5）
     4 │ account+reporting                   │          0 │          0 │        0 │        4 │    0 │  19.4%（7）
     5 │ account+notification+reporting      │          0 │          0 │        0 │        4 │    5 │  22.2%（8）
     6 │ reporting                           │          0 │          0 │        0 │        5 │    0 │  11.1%（4）
     7 │ notification+reporting              │          0 │          0 │        0 │        5 │    5 │  16.7%（6）
     8 │ catalog                             │          0 │          1 │        7 │        1 │    1 │  25.0%（9）
     9 │ catalog+notification                │          0 │          1 │        7 │        1 │    6 │  27.8%（10）
    10 │ account+catalog                     │          0 │          1 │        7 │        2 │    1 │  27.8%（10）
    11 │ account+catalog+notification        │          0 │          1 │        7 │        2 │    6 │  30.6%（11）
    12 │ account+catalog+reporting           │          0 │          1 │        7 │        3 │    1 │  27.8%（10）
    16 │ cart                                │          1 │          1 │        3 │        0 │    0 │  11.1%（4）
    32 │ payment                             │          3 │          4 │        4 │        1 │    1 │  19.4%（7）
    64 │ catalog+inventory                   │          6 │          5 │       11 │        1 │    2 │  25.0%（9）
    80 │ inventory                           │          6 │          6 │       12 │        0 │    3 │  22.2%（8）
  （127 種全部：target/d01-cuts.txt）
  包含 inventory 的 64 種切法：切斷的交易最少 6 種；前三名：
    第  64 名 catalog+inventory                   交易 6、交易內呼叫 5、同步呼叫 11
    第  65 名 catalog+inventory+notification      交易 6、交易內呼叫 5、同步呼叫 11
    第  66 名 account+catalog+inventory           交易 6、交易內呼叫 5、同步呼叫 11
═══ 1.5 切出 inventory：切斷了什麼 ═══
  切斷的交易：
    POST /api/orders  寫 [cart, inventory, ordering]
    POST /api/orders/{orderNo}/cancel  寫 [inventory, ordering, payment]
    POST /api/payments/callback  寫 [inventory, ordering, payment]
    POST /api/seller/orders/{orderNo}/cancel  寫 [inventory, ordering, payment]
    POST /api/seller/orders/{orderNo}/ship  寫 [inventory, ordering]
    排程 OrderJobs.cancelExpired  寫 [inventory, ordering]
  交易內的同步呼叫：
    catalog → InventoryApi.setHot
    ordering → InventoryApi.confirm
    ordering → InventoryApi.consume
    ordering → InventoryApi.holdHot
    ordering → InventoryApi.release
    ordering → InventoryApi.reserve
  所有同步呼叫：
    cart → InventoryApi.available
    catalog → InventoryApi.available
    catalog → InventoryApi.availableForDisplay
    catalog → InventoryApi.restock
    catalog → InventoryApi.setHot
    ordering → InventoryApi.activeReservations
    ordering → InventoryApi.confirm
    ordering → InventoryApi.consume
    ordering → InventoryApi.gateHot
    ordering → InventoryApi.holdHot
    ordering → InventoryApi.release
    ordering → InventoryApi.reserve
  直接讀表：
  跨過去的事件：
    inventory.hot-settlement-failed → ordering.stock-shortage
    order.placed → inventory.hot-settlement
    product.created → inventory.product-created
  變更耦合：8／36 個 commit（22.2%）
  （結束時 load { 9.06 7.02 5.32 }）
```

| | 第 01 章 1.6 之後 | 第 02 章之後 |
|---|---|---|
| inventory 這一刀的名次 | 第 96 | **第 80** |
| 切斷的交易 / 交易內呼叫 / 同步呼叫 / 直接讀表 / 事件 | 7 / 7 / 12 / 0 / 2 | **6 / 6** / 12 / 0 / **3** |
| catalog 這一刀的名次 | 第 16 | **第 8** |
| catalog：切斷的交易 / 交易內呼叫 / 同步呼叫 | 1 / 2 / 8 | **0 / 1 / 7** |
| commit 的交易 | 227 | 233 |

- **「建立商品」那一行從「寫了兩個以上模組的交易」消失了**，變成「事件」那一欄的一條新的線：`catalog ─ product.created → inventory.product-created`。這是第 01 章 1.5 的五個數字裡**唯一**變好的方向：一種交易變成一個事件。
- **「直接讀表」那一欄沒有新的線**：還是 `reporting` 讀的那五張表，沒有一句讀庫存的表。對帳用的是 API（`ordering → InventoryApi.activeReservations`，不在交易裡）。
- inventory 的同步呼叫還是 12 種：少了 `initialize`、多了 `activeReservations`。`reservationsOf` 沒有出現 —— 使用者的一天裡，沒有一張還沒結束的訂單比 grace（5 分鐘）舊，對帳的 ② 一批都沒掃到。
- commit 的交易多了 6 個，對得上：4 個商品各多一個（`product.created` 的消費者自己一個交易），加上對帳的兩句讀（各自 autocommit，`SqlTap` 一句算一個）。（這是算的，沒有逐一核對。）

### 2.9.4 追溯表：這一站的產出

| README 的產出 | 第 00 章 | 第 01 章 | 第 02 章加上的 |
|---|---|---|---|
| 1. 拆分決策文件 | 不該拆；四個代價 | 第一刀切 notification；庫存第 96 名 | 資料的三個階段（2.3.4）；搬家三種做法的代價（2.8）：停寫 12 秒 vs 不停機要多做什麼 |
| 2. 庫存拆成獨立服務（**含獨立資料庫**）、下單改成 Saga | 兩種部署 | 7 種交易、12 種呼叫的清單；5 種讀移出交易 | **獨立的資料庫**：誠實的兩個庫、`ServiceDatabaseTest`；7 種交易 → 6 種（建立商品改成事件）；對帳 X-1～X-5；Saga 仍在第 04 章 |
| 3. 跨服務報表 | 商品頁的可售量 | reporting 讀的 5 張表 | 庫存這一刀不切斷任何報表（B1）；維運查詢會壞（2.6.7） |
| 4. 一條完整的 trace | K5 | （沒有變） | （沒有變） |
| 5. 基礎設施選型 | 維運清單 | （沒有變） | 「同一個 jar、兩個角色」：`ddl-auto`、`bootstrap-admin` 這種開關（2.4.6）—— 第 03 章 3.7 |

---

## 2.10 本章完成後的專案

```
shop/                                                          ← 分支 d02（從 d01 開出來）
├── scripts/d00-change-coupling.sh                             ← 2.4.1：migration 路徑多一層資料夾
├── src/main/java/com/example/shop/
│   ├── catalog/internal/ProductService.java                   ← 2.7.3：建立商品寫 product.created，不再呼叫 initialize()
│   ├── inventory/InventoryApi.java                            ← 2.6.3：對帳的三個方法
│   ├── inventory/ReservationRef.java                          ← + 2.6.3
│   ├── inventory/internal/JdbcInventoryService.java           ← 2.6.3；2.7.3：沒有庫存列 = 0、initialize 與 restock 遇到已有的列就加上去
│   ├── inventory/internal/HotStock.java                       ← 2.7.3：沒有庫存列就先不建閘門
│   ├── inventory/internal/InventoryEventHandlers.java         ← 2.7.3：product.created 的消費者
│   ├── ordering/internal/ReservationReconciliation.java       ← + 2.6.4
│   ├── ordering/internal/ReconciliationJobs.java              ← + 2.6.4
│   ├── ordering/internal/OrderJobs.java                       ← 第 12 站 4.7.1 的追記（2.5.3 的 S5'）
│   ├── shared/config/ShopProperties.java                      ← 2.6.4：reservationCheckInterval、reservationGrace
│   └── shared/events/EventTypes.java                          ← 2.7.3：PRODUCT_CREATED
├── src/main/resources/db/migration/<模組>/V*.sql               ← 2.4.1：25 個檔案搬進 8 個資料夾，內容一個字都沒改
└── src/test/java/com/example/shop/
    ├── dist02/                                                ← + 這一章的支架與實驗
    │   ├── Split.java、DbTap.java                              ← 2.4.6
    │   ├── RemoteInventory.java、InventoryEndpoints.java       ← 2.4.6、2.6.3
    │   ├── Ops.java                                           ← 2.5.3
    │   ├── Copier.java、DualWriteTap.java、Load.java            ← 2.8
    │   ├── C1SharedSchemaTest.java                            ← 2.2、2.4.7、2.7.6（實驗）
    │   ├── C2BrokenTransactionTest.java                       ← 2.5.3（實驗）
    │   ├── C3ReconciliationTest.java                          ← 2.6.6（實驗）
    │   └── C4DataMigrationTest.java                           ← 2.8（實驗）
    ├── dist01/
    │   ├── D01Workload.java                                   ← 2.4.6：跑在切開的部署上；2.7、2.6：交付 product.created、跑對帳
    │   ├── OpTag.java、Probe.java                              ← 2.4.6：public
    │   ├── CutEvaluator.java                                  ← 2.4.1
    │   └── CrossModuleCallInTxTest.java                       ← 2.7.5：12 → 11 種
    ├── dist00/RemoteInventoryApi.java                         ← 2.6.3：三個新方法交給本地
    ├── architecture/MigrationOwnershipTest.java                ← 2.4.1：資料夾 = 模組
    ├── architecture/ServiceDatabaseTest.java                  ← + 2.4.5
    ├── acceptance/CapstoneAcceptanceTest.java                 ← 2.4.1：Q6 用 Files.walk
    ├── api/CatalogCartApiTest.java                            ← 2.7.5
    ├── catalog/internal/ProductCreatedFlowTest.java           ← + 2.7.5
    └── ordering/internal/
        ├── ReservationReconciliationTest.java                 ← + 2.6.5
        ├── OrderJobsIsolationTest.java                        ← 第 12 站 4.7.1 的追記
        └── EventFlowTest.java                                 ← 第 12 站 7.7.3 的追記（等死信到了再讀佇列）
```

**沒有新的 migration**（只有搬家），**沒有改任何一支 API 的回應**（`OpenApiContractTest` 照樣綠）。正式程式碼的改動有三組：migration 分資料夾（2.4.1）、對帳（2.6）、建立商品改成事件（2.7）；加上第 12 站的兩個修正（一個 bug、一個測試的競態）。

完整跑一次（預設的 Testcontainers；C1～C4 標了 `experiment`，不在裡面）：

```bash
mvn clean verify
```

```
TEST_INFRA MySQL 最多同時 25 條連線（max_connections 151）
[INFO] Tests run: 234, Failures: 0, Errors: 0, Skipped: 0
[INFO] All coverage checks have been met.
[INFO] All coverage checks have been met.
[INFO] All coverage checks have been met.
[INFO] All coverage checks have been met.
[INFO] BUILD SUCCESS
[INFO] Total time:  04:14 min
```

**234 個測試**：第 01 章的 230 個，加上 `ServiceDatabaseTest`、`ReservationReconciliationTest`、`ProductCreatedFlowTest`，以及第 12 站的修正帶來的 `OrderJobsIsolationTest`。

**`EventFlowTest.mailerDownDeadLetters` 偶爾會紅**：`expected: 1 but was: 0` ——「死信佇列 0 則」，而通知是 `FAILED`、試了 6 次。這一章沒有碰通知與死信：第 12 站的 `RabbitConsumers` 先呼叫 `onDeadLetter()`（寫 `FAILED`）、才把訊息送進死信佇列，測試看到 `FAILED` 就立刻讀佇列 —— 那一刻死信可能還在路上。很少發生；原因是從程式碼的順序推出來的，沒有用確定的方式重現。改的是測試（等死信到了再讀，最多 5 秒），記在第 12 站 7.7.3。

### 2.10.1 本章其餘檔案的完整內容

正文已經完整列出的：`ReservationReconciliation`、`ReconciliationJobs`（2.6.4）、`ReservationReconciliationTest`（2.6.5）、`ServiceDatabaseTest`（2.4.5）、`ProductCreatedFlowTest`（2.7.5）。只改了幾行、正文已經列出那幾行的：`ShopProperties`、`EventTypes`（2.6.4、2.7.3）、`MigrationOwnershipTest`、驗收 Q6、`CutEvaluator`、`d00-change-coupling.sh`（2.4.1）、`CatalogCartApiTest`、`CrossModuleCallInTxTest`（2.7.5）。`OpTag`、`Probe` 只是把 class 與幾個成員改成 `public`；`RemoteInventoryApi`（第 00 章）多三行，把對帳的三個方法交給本地。第 12 站的修正改到的 `OrderJobs`、`OrderJobsIsolationTest` 在第 12 站 4.7.1 裡，`EventFlowTest` 改的那幾行在 7.7.3 裡。

下面是其餘每一個新增或改過的檔案（`d02` 分支上的版本）：

**`src/main/java/com/example/shop/inventory/InventoryApi.java`**（2.6.3、2.7.3）

```java
package com.example.shop.inventory;

import java.util.Collection;
import java.util.List;
import java.util.Map;

/**
 * 庫存模組唯一的對外入口。其他模組只能透過這個介面改變庫存。
 * 每一個會改變數量的方法，都會在同一個交易裡寫一筆 inventory_ledger（INV-3）。
 */
public interface InventoryApi {

    /**
     * 建立一個商品的庫存列（US-PRD-1 AC-1），並記一筆 INITIAL。MANDATORY。
     * 13 站 2.7：呼叫的人從 catalog（建立商品的交易裡）變成 product.created 的消費者；庫存列已經在（補貨比事件先到）就加上去
     */
    void initialize(long productId, int onHand, String note);

    /**
     * 為一張訂單預留庫存（每個品項一筆 HELD 預留）。全有或全無：任何一個品項不足就丟例外，呼叫端的交易應該 rollback。
     * 內部會依 productId 排序後才加鎖（4.2.3：避免兩張訂單以相反的順序鎖同樣兩個商品而死鎖）。
     * 必須在呼叫端既有的交易內呼叫（Propagation.MANDATORY）。
     */
    void reserve(long orderId, List<ReserveLine> lines);

    /**
     * 7.6 熱點商品的預留：只寫預留列（HELD、counted = FALSE），**不碰 inventory 那一列**。
     * 數量由 inventory.hot-settlement 消費者在 commit 之後計入 reserved、記一筆 RESERVE（最終一致，0.6.4：60 秒）。
     * 呼叫之前一定已經過了 Redis 的閘門（gateHot）。MANDATORY。
     */
    void holdHot(long orderId, List<ReserveLine> lines);

    /** 付款成功：這張訂單的預留 HELD → CONFIRMED（不再能被逾時釋放）。數量不變，不記帳。MANDATORY。 */
    void confirm(long orderId);

    /** 取消：這張訂單的預留 → RELEASED，reserved 減回，每個品項一筆 RELEASE。已釋放的不重複釋放（冪等）。MANDATORY。 */
    void release(long orderId);

    /**
     * 出貨：CONFIRMED → CONSUMED，onHand 與 reserved 同時減少，每個品項一筆 SHIP。MANDATORY。
     * 7.6.4：還沒計入 reserved 的熱點預留（落帳還沒完成）→ 503，稍後再出貨。
     */
    void consume(long orderId);

    /** 補貨：onHand 增加，並記一筆 RESTOCK。自己開交易。13 站 2.7：庫存列還沒建立（product.created 還沒送到）也可以補，先建一列 */
    void restock(long productId, int quantity, String note);

    // 8.7：第 01 章的 restockBatch(List<RestockLine>)（「給匯入功能用」）拿掉了 —— 覆蓋率報表說它從來沒被執行過，
    // 而且整個 main 裡沒有任何人呼叫它：專題沒有匯入功能（0.7 也沒有列）。沒有人用的公開 API，不寫測試，刪掉

    // ───────── 第 06 章：熱點商品（6.5）─────────

    /**
     * 熱點商品的閘門：在下單交易「之前」、交易「之外」呼叫，先在 Redis 減掉這些品項。
     * 不夠 → InsufficientStockException（409，連 MySQL 都不碰）；Redis 不能用 → 503（0.6.3 的艙壁）。
     * 之後的下單交易仍然會做 reserve() 的條件式 UPDATE —— MySQL 才是最後一道防線。
     */
    void gateHot(List<ReserveLine> hotLines);

    /** 閘門過了、下單卻失敗了（價格變了、資料庫錯誤……）：把減掉的加回去（6.2.4） */
    void returnHot(List<ReserveLine> hotLines);

    /** 商品被標成（或取消）熱點：commit 之後建立（或刪除）Redis 的庫存副本。MANDATORY */
    void setHot(long productId, boolean hot);

    /** 商品頁顯示用的可售量（US-PRD-3 AC-4：最多 5 秒的延遲）。熱點商品讀 Redis 的副本；其他商品快取 5 秒 */
    int availableForDisplay(long productId, boolean hot);

    /** 可售庫存 = onHand - reserved。13 站 2.7：沒有庫存列（product.created 還沒送到）= 0 */
    int available(long productId);

    /** 一次查多個商品的可售庫存（一句 SQL）。沒有庫存列的商品不會出現在結果裡。 */
    Map<Long, Integer> available(Collection<Long> productIds);

    // ───────── 13 站 2.6：跨模組的對帳（ordering 的 ReservationReconciliation）─────────
    // 「預留」與「訂單」在同一個資料庫裡時，一句 JOIN 就能對；拆開之後，兩邊各問各的、在程式裡比。這三個方法是庫存那一邊

    /** 還佔著庫存（HELD、CONFIRMED）、建立早於 createdBefore 的預留，依 id 由小到大（keyset 分頁：id > afterId）。不開交易：一句 SELECT */
    List<ReservationRef> activeReservations(long afterId, java.time.Instant createdBefore, int limit);

    /** 這些訂單的預留，各是什麼狀態（一張訂單有幾個品項就有幾筆）。沒有任何預留的訂單不會出現在結果裡 */
    Map<Long, List<ReservationRef>> reservationsOf(Collection<Long> orderIds);

    /**
     * 釋放一張「不存在、或已經取消」的訂單還佔著的預留：跟 release() 做一樣的事，但自己開交易 —— release() 是 MANDATORY，
     * 因為它本來要跟訂單的狀態一起 commit；對帳找到的這種預留，訂單那邊沒有東西要一起 commit。冪等：已經釋放的不會再釋放。
     * 「這張訂單不存在或已取消」由呼叫端（ordering）判斷：庫存模組不知道訂單
     */
    void releaseAbandoned(long orderId);
}
```

**`src/main/java/com/example/shop/inventory/ReservationRef.java`**（2.6.3）

```java
package com.example.shop.inventory;

/**
 * 13 站 2.6.3：一筆預留，給跨模組的對帳用。只有 id 與狀態 —— 別的模組看不到 Reservation 這個實體（internal）。
 * status：HELD、CONFIRMED、CONSUMED、RELEASED（V3 的 ck_reservations_status）
 */
public record ReservationRef(long id, long orderId, long productId, int quantity, String status) {}
```

**`src/main/java/com/example/shop/inventory/internal/JdbcInventoryService.java`**（2.6.3、2.7.3）

```java
package com.example.shop.inventory.internal;

import com.example.shop.inventory.InsufficientStockException;
import com.example.shop.inventory.InventoryApi;
import com.example.shop.inventory.ReserveLine;
import com.example.shop.inventory.ReservationRef;
import com.example.shop.shared.error.ProblemType;
import com.example.shop.shared.error.ShopException;
import com.example.shop.shared.events.EventTypes;
import com.example.shop.shared.events.Outbox;
import com.example.shop.shared.redis.RedisGuard;
import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

import java.time.Duration;
import java.util.ArrayList;
import java.util.Optional;
import java.util.Collection;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

@Service
class JdbcInventoryService implements InventoryApi {

    /** US-PRD-3 AC-4：一般商品的可售量顯示，允許 5 秒的延遲 */
    static final Duration DISPLAY_TTL = Duration.ofSeconds(5);

    private static final Logger log = LoggerFactory.getLogger(JdbcInventoryService.class);

    private final JdbcTemplate jdbc;
    private final HotStock hot;
    private final StringRedisTemplate redis;
    private final RedisGuard guard;
    private final Outbox outbox;
    private final Counter shortages;
    /** 6.9.2 Redis 不能用的時候，可售量在本機記憶體裡放 5 秒（AC-4 允許的延遲）：不然每一次看商品頁都是一句 MySQL */
    private final java.util.concurrent.ConcurrentHashMap<Long, long[]> degradedAvailable = new java.util.concurrent.ConcurrentHashMap<>();

    JdbcInventoryService(JdbcTemplate jdbc, HotStock hot, StringRedisTemplate redis, RedisGuard guard, Outbox outbox, MeterRegistry meters) {
        this.jdbc = jdbc;
        this.hot = hot;
        this.redis = redis;
        this.guard = guard;
        this.outbox = outbox;
        this.shortages = Counter.builder("shop.inventory.hot.shortage")
                .description("熱點落帳時 MySQL 不夠（Redis 的閘門放進了不存在的庫存）→ 訂單會被取消。正常應該永遠是 0").register(meters);
    }

    @Override
    public void gateHot(List<ReserveLine> hotLines) {
        if (!hotLines.isEmpty()) hot.gate(hotLines);
    }

    @Override
    public void returnHot(List<ReserveLine> hotLines) {
        hot.giveBack(hotLines);
    }

    @Override
    @Transactional(propagation = Propagation.MANDATORY)
    public void setHot(long productId, boolean isHot) {
        if (isHot) {
            if (!TransactionSynchronizationManager.isSynchronizationActive()) { hot.initialize(productId); return; }
            TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
                @Override
                public void afterCommit() { hot.initialize(productId); }       // commit 之後才讀 MySQL：讀到的是這次之後的可售量
            });
        } else {
            hot.removeAfterCommit(productId);
        }
    }

    @Override
    public int availableForDisplay(long productId, boolean isHot) {
        if (isHot) {
            Optional<Integer> v = hot.display(productId);
            if (v.isPresent()) return Math.max(0, v.get());
        }
        String key = "available:" + productId;
        Optional<String> cached = guard.call("available.get", () -> redis.opsForValue().get(key));
        if (cached.isPresent()) return Integer.parseInt(cached.get());
        long now = System.currentTimeMillis();
        if (!guard.available()) {
            long[] l = degradedAvailable.get(productId);                    // {值, 到期時間}
            if (l != null && l[1] > now) return (int) l[0];
        }
        int v = available(productId);
        if (guard.available()) guard.run("available.put", () -> redis.opsForValue().set(key, String.valueOf(v), DISPLAY_TTL));
        else degradedAvailable.put(productId, new long[]{v, now + DISPLAY_TTL.toMillis()});
        return v;
    }

    @Override
    @Transactional(propagation = Propagation.MANDATORY)
    public void initialize(long productId, int onHand, String note) {
        if (onHand < 0) throw new IllegalArgumentException("onHand must not be negative");
        // 13 站 2.7：補貨可能比 product.created 先到（restock 會先建一列）—— 已經有就加上去，帳照記（INV-3 照樣成立）
        jdbc.update("""
                INSERT INTO inventory (product_id, on_hand, reserved) VALUES (?, ?, 0) AS new
                ON DUPLICATE KEY UPDATE on_hand = inventory.on_hand + new.on_hand, updated_at = CURRENT_TIMESTAMP(3)""", productId, onHand);
        if (onHand > 0) ledger(productId, onHand, 0, "INITIAL", note);     // ck_ledger_delta：數量為 0 就不記帳
    }

    @Override
    @Transactional(propagation = Propagation.MANDATORY)
    public void reserve(long orderId, List<ReserveLine> lines) {
        List<ReserveLine> sorted = lines.stream().sorted(Comparator.comparingLong(ReserveLine::productId)).toList();
        for (ReserveLine l : sorted) {
            int n = jdbc.update("""
                    UPDATE inventory SET reserved = reserved + ?, updated_at = CURRENT_TIMESTAMP(3)
                     WHERE product_id = ? AND on_hand - reserved >= ?""",
                    l.quantity(), l.productId(), l.quantity());
            if (n == 0) throw new InsufficientStockException(l.productId());
            // 先 UPDATE 父表（拿 X 鎖）、再 INSERT 子表（2.6.2）
            jdbc.update("INSERT INTO inventory_reservations (order_id, product_id, quantity, status) VALUES (?, ?, ?, 'HELD')",
                    orderId, l.productId(), l.quantity());
            ledger(l.productId(), 0, l.quantity(), "RESERVE", "order:" + orderId);
        }
    }

    @Override
    @Transactional(propagation = Propagation.MANDATORY)
    public void holdHot(long orderId, List<ReserveLine> lines) {
        // 只有預留列。inventory 那一列一個字都不碰 —— 搶購時 500 個交易排的就是那一列的鎖（6.5.4）
        for (ReserveLine l : lines.stream().sorted(Comparator.comparingLong(ReserveLine::productId)).toList())
            jdbc.update("INSERT INTO inventory_reservations (order_id, product_id, quantity, status, counted) VALUES (?, ?, ?, 'HELD', FALSE)",
                    orderId, l.productId(), l.quantity());
    }

    /**
     * 7.6.2 熱點落帳：把這張訂單還沒計入的預留，加到 inventory.reserved。由 inventory.hot-settlement 消費者呼叫（交易由 EventDispatcher 開）。
     *
     *   ① 鎖住這張訂單還沒計入的預留列（跟 release() 同一個順序：先預留列、再 inventory 列 —— 取消與落帳不會死鎖）
     *   ② 鎖住每一個商品的 inventory 列，先全部檢查夠不夠（全有或全無：US-ORD-1 AC-5）
     *   ③ 夠 → reserved += 、counted = TRUE、記一筆 RESERVE
     *      不夠 → Redis 的閘門放進了 MySQL 沒有的庫存（7.6.3）：那一列 RELEASED，發一個 inventory.hot-settlement-failed，訂單模組會取消訂單；
     *             閘門減掉的數量裡「真的存在」的那一部分加回 Redis（6.5.3 的 ⚠️、練習九，見下面）
     * 預留列已經 RELEASED（訂單先被取消了）或已經 counted（重複的訊息）→ ① 什麼都找不到，直接結束。
     * @return 計入了幾列；-1 = 庫存不足
     */
    int settleHot(long orderId) {
        List<Held> lines = jdbc.query("""
                SELECT id, product_id, quantity, counted FROM inventory_reservations
                 WHERE order_id = ? AND status IN ('HELD', 'CONFIRMED') AND counted = FALSE ORDER BY product_id FOR UPDATE""",
                (rs, i) -> new Held(rs.getLong(1), rs.getLong(2), rs.getInt(3), rs.getBoolean(4)), orderId);
        for (Held h : lines) {
            Integer available = jdbc.queryForObject("SELECT on_hand - reserved FROM inventory WHERE product_id = ? FOR UPDATE", Integer.class, h.productId());
            if (available == null || available < h.quantity()) {
                jdbc.update("UPDATE inventory_reservations SET status = 'RELEASED', updated_at = CURRENT_TIMESTAMP(3) WHERE id = ?", h.id());
                outbox.add("ORDER", orderId, EventTypes.HOT_SETTLEMENT_FAILED, Map.of("orderId", orderId, "productId", h.productId(),
                        "requested", h.quantity(), "available", available == null ? 0 : available));
                // 6.5.3 的 ⚠️、練習九：閘門放行代表 Redis 有 R ≥ q，減完剩 R − q。這一列 RELEASED 之後，取消時的 release() 看不到它，
                // 第 06 章的「那一個品項不加回去」在這裡原封不動：q = 1 時 R − 1 ≥ 0 = MySQL，是修正了一次偏高；
                // q > 1 時不一定 —— Redis 3、MySQL 可售 2、買 3 件：Redis 變成 0，MySQL 還有 2 件（偏低，少賣 2 件，要等對帳）。
                // 修法：只加回「真的存在」的那一部分 —— 閘門該有的值（GATE_BASE_SQL，已經不含這一列）。不是一律加回 q：
                // 7.6.3 之後偏高的代價是「回了 201 之後取消」，能不放出去的就不放。不需要多讀 Redis：R ≥ q，所以 R − q + base ≥ base，不會偏低。
                // 這一句的 SUM 是一致性讀：讀到的快照比 FOR UPDATE 舊的話，在那之間 commit 的取消、補貨各有自己的 stock-returned 會加回；
                // 在那之間成立、還沒計入的新訂單沒被扣到 → 偏高（安全的方向）。加回走 7.6.5 的事件，跟這個交易一起 commit。
                Integer base = jdbc.queryForObject(HotStock.GATE_BASE_SQL, Integer.class, h.productId());
                int giveBack = base == null ? 0 : Math.max(0, Math.min(h.quantity(), base));
                if (giveBack > 0) returnToHotStock(orderId, List.of(new ReserveLine(h.productId(), giveBack)));
                shortages.increment();
                log.warn("HOT_SETTLEMENT_SHORTAGE orderId={} productId={} requested={} available={} giveBack={}（訂單會被取消）",
                        orderId, h.productId(), h.quantity(), available, giveBack);
                return -1;
            }
        }
        for (Held h : lines) {
            int n = jdbc.update("""
                    UPDATE inventory SET reserved = reserved + ?, updated_at = CURRENT_TIMESTAMP(3)
                     WHERE product_id = ? AND on_hand - reserved >= ?""", h.quantity(), h.productId(), h.quantity());
            if (n != 1) throw new IllegalStateException("inventory " + h.productId() + " 已經鎖住而且檢查過了，UPDATE 卻沒有成功");
            jdbc.update("UPDATE inventory_reservations SET counted = TRUE, updated_at = CURRENT_TIMESTAMP(3) WHERE id = ?", h.id());
            ledger(h.productId(), 0, h.quantity(), "RESERVE", "order:" + orderId);
        }
        return lines.size();
    }

    @Override
    @Transactional(propagation = Propagation.MANDATORY)
    public void confirm(long orderId) {
        jdbc.update("""
                UPDATE inventory_reservations SET status = 'CONFIRMED', updated_at = CURRENT_TIMESTAMP(3)
                 WHERE order_id = ? AND status = 'HELD'""", orderId);
    }

    @Override
    @Transactional(propagation = Propagation.MANDATORY)
    public void release(long orderId) {
        List<ReserveLine> released = new ArrayList<>();
        for (Held h : held(orderId, "'HELD', 'CONFIRMED'")) {
            released.add(new ReserveLine(h.productId(), h.quantity()));
            if (h.counted()) {
                jdbc.update("UPDATE inventory SET reserved = reserved - ?, updated_at = CURRENT_TIMESTAMP(3) WHERE product_id = ?",
                        h.quantity(), h.productId());
                ledger(h.productId(), 0, -h.quantity(), "RELEASE", "order:" + orderId);
            }                                                               // 7.6：還沒計入的熱點預留 —— reserved 本來就沒有加，只改狀態
            jdbc.update("UPDATE inventory_reservations SET status = 'RELEASED', updated_at = CURRENT_TIMESTAMP(3) WHERE id = ?", h.id());
        }
        returnToHotStock(orderId, released);                                // 熱點商品：Redis 的閘門要加回去（7.6.5）
    }

    @Override
    @Transactional(propagation = Propagation.MANDATORY)
    public void consume(long orderId) {
        List<Held> rows = held(orderId, "'CONFIRMED'");
        if (rows.stream().anyMatch(h -> !h.counted()))                      // 7.6.4：落帳還沒完成。幾秒後就會好 —— 出貨不差這幾秒
            throw new ShopException(ProblemType.TEMPORARILY_UNAVAILABLE, "這張訂單的庫存還在落帳，請稍後再出貨").with("retryAfter", 5);
        // 7.6.4：落帳發現不夠、那一列已經 RELEASED，取消的事件還在路上。這時候出貨 = 出一件不存在的貨（onHand 不會減）
        Integer released = jdbc.queryForObject("SELECT COUNT(*) FROM inventory_reservations WHERE order_id = ? AND status = 'RELEASED'", Integer.class, orderId);
        if (released != null && released > 0)
            throw new ShopException(ProblemType.INVALID_STATE, "這張訂單有商品庫存不足，即將取消，不能出貨");
        for (Held h : rows) {
            jdbc.update("""
                    UPDATE inventory SET on_hand = on_hand - ?, reserved = reserved - ?, updated_at = CURRENT_TIMESTAMP(3)
                     WHERE product_id = ?""", h.quantity(), h.quantity(), h.productId());
            jdbc.update("UPDATE inventory_reservations SET status = 'CONSUMED', updated_at = CURRENT_TIMESTAMP(3) WHERE id = ?", h.id());
            ledger(h.productId(), -h.quantity(), -h.quantity(), "SHIP", "order:" + orderId);
        }
    }

    record Held(long id, long productId, int quantity, boolean counted) {}

    /**
     * 這張訂單還佔著庫存的預留，依 productId 排序。先鎖預留列（FOR UPDATE），再依序改 inventory：
     * 同一張訂單的兩個釋放（例如兩個排程實例）會在第一句就排隊，第二個進來時看到的已經是 RELEASED —— 不會重複減。
     * 註：這裡的 statuses 只會是程式裡的常數，不是使用者輸入。
     */
    private List<Held> held(long orderId, String statuses) {
        return jdbc.query("""
                SELECT id, product_id, quantity, counted FROM inventory_reservations
                 WHERE order_id = ? AND status IN (%s) ORDER BY product_id FOR UPDATE""".formatted(statuses),
                (rs, i) -> new Held(rs.getLong(1), rs.getLong(2), rs.getInt(3), rs.getBoolean(4)), orderId);
    }

    @Override
    @Transactional
    public void restock(long productId, int quantity, String note) {
        if (quantity <= 0) throw new IllegalArgumentException("quantity must be positive");
        // 13 站 2.7：庫存列還沒建立（product.created 還沒送到）也要補得進去 —— 不然下一句帳撞外鍵（fk_ledger_inventory）
        jdbc.update("""
                INSERT INTO inventory (product_id, on_hand, reserved) VALUES (?, ?, 0) AS new
                ON DUPLICATE KEY UPDATE on_hand = inventory.on_hand + new.on_hand, updated_at = CURRENT_TIMESTAMP(3)""", productId, quantity);
        ledger(productId, quantity, 0, "RESTOCK", note);
        returnToHotStock(productId, List.of(new ReserveLine(productId, quantity)));
    }

    /**
     * 7.6.5 熱點商品的閘門要加回去（取消、補貨）。第 06 章是 afterCommit 直接加：commit 之後、加之前行程死掉，Redis 就少了這幾件（6.5.3）。
     * 改成跟這個交易一起寫一個事件：一定會被加回去；重複送到時會多加 —— 偏高，是 6.5.3 說的安全方向。
     * 不是熱點的商品，Redis 裡沒有 key，消費者什麼都不做。
     */
    private void returnToHotStock(long aggregateId, List<ReserveLine> lines) {
        if (lines.isEmpty()) return;
        outbox.add("INVENTORY", aggregateId, EventTypes.STOCK_RETURNED,
                Map.of("lines", lines.stream().map(l -> Map.of("productId", l.productId(), "quantity", l.quantity())).toList()));
    }

    @Override
    @Transactional(readOnly = true)
    public int available(long productId) {
        // 13 站 2.7：沒有庫存列 = 0（queryForObject 在這裡會丟 EmptyResultDataAccessException —— 第 00 章那個商品頁的 500）
        List<Integer> v = jdbc.queryForList("SELECT on_hand - reserved FROM inventory WHERE product_id = ?", Integer.class, productId);
        return v.isEmpty() || v.get(0) == null ? 0 : v.get(0);
    }

    @Override
    @Transactional(readOnly = true)
    public Map<Long, Integer> available(Collection<Long> productIds) {
        Map<Long, Integer> result = new HashMap<>();
        if (productIds.isEmpty()) return result;
        String in = String.join(",", productIds.stream().map(id -> "?").toList());
        jdbc.query("SELECT product_id, on_hand - reserved FROM inventory WHERE product_id IN (" + in + ")",
                rs -> { result.put(rs.getLong(1), rs.getInt(2)); }, productIds.toArray());
        return result;
    }

    // ───────── 13 站 2.6：對帳用 ─────────

    @Override
    public List<ReservationRef> activeReservations(long afterId, java.time.Instant createdBefore, int limit) {
        return jdbc.query("""
                SELECT id, order_id, product_id, quantity, status FROM inventory_reservations
                 WHERE id > ? AND status IN ('HELD', 'CONFIRMED') AND created_at < ? ORDER BY id LIMIT ?""",
                (rs, i) -> new ReservationRef(rs.getLong(1), rs.getLong(2), rs.getLong(3), rs.getInt(4), rs.getString(5)),
                afterId, java.sql.Timestamp.from(createdBefore), limit);
    }

    @Override
    public Map<Long, List<ReservationRef>> reservationsOf(Collection<Long> orderIds) {
        Map<Long, List<ReservationRef>> result = new HashMap<>();
        if (orderIds.isEmpty()) return result;
        String in = String.join(",", orderIds.stream().map(id -> "?").toList());
        jdbc.query("SELECT id, order_id, product_id, quantity, status FROM inventory_reservations WHERE order_id IN (" + in + ") ORDER BY id",
                rs -> { result.computeIfAbsent(rs.getLong(2), k -> new ArrayList<>())
                        .add(new ReservationRef(rs.getLong(1), rs.getLong(2), rs.getLong(3), rs.getInt(4), rs.getString(5))); },
                orderIds.toArray());                                         // uk_reservations_order_product 的最左欄
        return result;
    }

    @Override
    @Transactional
    public void releaseAbandoned(long orderId) {
        release(orderId);                                                   // 同一個物件裡呼叫：不經過代理，MANDATORY 不檢查 —— 這個交易就是它的交易
    }

    private void ledger(long productId, int deltaOnHand, int deltaReserved, String reason, String ref) {
        jdbc.update("""
                INSERT INTO inventory_ledger(product_id, delta_on_hand, delta_reserved, reason, ref)
                VALUES (?, ?, ?, ?, ?)""", productId, deltaOnHand, deltaReserved, reason, ref);
    }
}
```

**`src/main/java/com/example/shop/inventory/internal/InventoryEventHandlers.java`**（2.7.3）

```java
package com.example.shop.inventory.internal;

import com.example.shop.inventory.ReserveLine;
import com.example.shop.shared.events.Event;
import com.example.shop.shared.events.EventHandler;
import com.example.shop.shared.events.EventTypes;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import java.util.ArrayList;
import java.util.List;
import java.util.Set;

/** 7.6 庫存模組的兩個消費者 */
@Configuration(proxyBeanMethods = false)
class InventoryEventHandlers {

    private static final Logger log = LoggerFactory.getLogger(InventoryEventHandlers.class);

    /**
     * 7.6.2 熱點落帳：order.placed 帶著 hotProductIds 的，把預留的數量計入 inventory.reserved。
     * 交易與冪等由 EventDispatcher 負責：processed_messages 那一列跟 reserved += 一起 commit（驗收 Q10）。
     */
    @Bean
    EventHandler hotSettlement(JdbcInventoryService inventory) {
        return new EventHandler() {
            @Override public String consumer() { return "inventory.hot-settlement"; }
            @Override public Set<String> eventTypes() { return Set.of(EventTypes.ORDER_PLACED); }
            @Override public void handle(Event e) {
                if (e.getLongs("hotProductIds").isEmpty()) return;          // 一般商品：下單交易裡就計入了（第 04 章的路徑）
                inventory.settleHot(e.getLong("orderId"));
            }
        };
    }

    /**
     * 13 站 2.7：建立商品的期初庫存。第 12 站是 catalog 在建立商品的交易裡呼叫 initialize()（MANDATORY）；
     * 庫存搬到自己的資料庫之後，那不再是同一個交易，改成收 product.created。冪等由 EventDispatcher 負責（processed_messages）
     */
    @Bean
    EventHandler productCreated(JdbcInventoryService inventory) {
        return new EventHandler() {
            @Override public String consumer() { return "inventory.product-created"; }
            @Override public Set<String> eventTypes() { return Set.of(EventTypes.PRODUCT_CREATED); }
            @Override public void handle(Event e) {
                inventory.initialize(e.getLong("productId"), e.payload().get("initialStock").asInt(), "product-created");
            }
        };
    }

    /**
     * 7.6.5 取消、補貨之後，熱點商品的 Redis 閘門加回去。Redis 的 INCRBY 不在 MySQL 的交易裡：
     * INCRBY 成功、commit 之前行程死掉 → 重送時再加一次 → 偏高（6.5.3 的安全方向）；反過來的順序會偏低，所以 INCRBY 在交易「裡面」做。
     */
    @Bean
    EventHandler hotStockReturn(HotStock hot) {
        return new EventHandler() {
            @Override public String consumer() { return "inventory.hot-stock-return"; }
            @Override public Set<String> eventTypes() { return Set.of(EventTypes.STOCK_RETURNED); }
            @Override public void handle(Event e) {
                List<ReserveLine> lines = new ArrayList<>();
                e.payload().get("lines").forEach(l -> lines.add(new ReserveLine(l.get("productId").asLong(), l.get("quantity").asInt())));
                hot.giveBackOrFail(lines);
            }
            @Override public void onDeadLetter(Event e, Exception lastError) {
                log.error("HOT_STOCK_RETURN_DEAD 熱點庫存沒有加回去（Redis 掛太久）：{}；Redis 偏低，等對帳（6.6）修正", e.payload());
            }
        };
    }
}
```

**`src/main/java/com/example/shop/inventory/internal/HotStock.java`**（2.7.3）

```java
package com.example.shop.inventory.internal;

import com.example.shop.inventory.InsufficientStockException;
import com.example.shop.inventory.ReserveLine;
import com.example.shop.shared.error.ProblemType;
import com.example.shop.shared.error.ShopException;
import com.example.shop.shared.redis.DistributedLock;
import com.example.shop.shared.redis.RedisGuard;
import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.data.redis.core.Cursor;
import org.springframework.data.redis.core.ScanOptions;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.core.script.RedisScript;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;

import java.time.Duration;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Optional;

/**
 * 6.5 熱點商品的閘門（0.6.1 第 3 條）：Redis 的 stock:{id} 是 MySQL 可售量的「快速副本」（0.3.3）。
 *
 * 一條原則決定了這個類別的每一個方法：**MySQL 的條件式 UPDATE 仍然是最後一道防線（4.2.1 ⑥），Redis 只是擋在前面的閘門。**
 *  - Redis 的數字「偏高」：多放一些請求進 MySQL，MySQL 會擋下（409）—— 浪費，但不會超賣。
 *  - Redis 的數字「偏低」：該賣的沒賣出去（少賣）—— 這才是要避免、而且要被對帳抓到的方向。
 *
 * 所以：
 *  - 減（下單）在 MySQL 之前：Redis 先減，MySQL 失敗再加回來（6.2.4：漏了加回來 = 少賣）。
 *  - 加（取消、補貨）在 MySQL commit 之後：commit 失敗就不加。
 *  - 修正（對帳）只在「Redis 的值從頭到尾沒變」時才寫入（CAS，6.6）：只可能多算，不可能少算。
 *
 * ⚠️ 第 07 章改變了「偏高」的代價（7.6.3）：熱點商品的 MySQL 預留移到了交易之外，MySQL 不再「當場」擋下 ——
 * 偏高 = 下單回了 201，幾秒後落帳發現不夠，訂單被取消（MySQL 仍然不會超賣）。偏高從「浪費」變成「失信」，仍然好過少賣，但要被看見：
 * shop.inventory.hot.shortage。
 */
@Component
class HotStock {

    private static final Logger log = LoggerFactory.getLogger(HotStock.class);

    /** 全有或全無：每一個品項都夠才一起減。回傳 {0,0} = 成功；{-1,i} = 第 i 個 key 不存在；{-2,i} = 第 i 個不夠 */
    static final RedisScript<List> GATE = RedisScript.of("""
            for i, k in ipairs(KEYS) do
              local v = redis.call('GET', k)
              if not v then return {-1, i} end
              if tonumber(v) < tonumber(ARGV[i]) then return {-2, i} end
            end
            for i, k in ipairs(KEYS) do redis.call('DECRBY', k, ARGV[i]) end
            return {0, 0}""", List.class);

    /** 加回去，但只加「存在的」key：不存在代表 Redis 的資料丟了，下一次用到時會從 MySQL 重建（6.5.3） */
    static final RedisScript<Long> RETURN = RedisScript.of("""
            for i, k in ipairs(KEYS) do
              if redis.call('EXISTS', k) == 1 then redis.call('INCRBY', k, ARGV[i]) end
            end
            return 1""", Long.class);

    /** 對帳的寫入：只有在值還是 ARGV[1]（讀的時候看到的那個）才改成 ARGV[2] */
    static final RedisScript<Long> CAS = RedisScript.of("""
            if redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('SET', KEYS[1], ARGV[2]) return 1 end
            return 0""", Long.class);

    private final StringRedisTemplate redis;
    private final RedisGuard guard;
    private final DistributedLock locks;
    private final JdbcTemplate jdbc;
    private final Counter drift;
    private final java.util.concurrent.ConcurrentHashMap<Long, String> lastMismatch = new java.util.concurrent.ConcurrentHashMap<>();

    HotStock(StringRedisTemplate redis, RedisGuard guard, DistributedLock locks, JdbcTemplate jdbc, MeterRegistry meters) {
        this.redis = redis;
        this.guard = guard;
        this.locks = locks;
        this.jdbc = jdbc;
        this.drift = Counter.builder("shop.inventory.hot.drift").description("對帳發現 Redis 與 MySQL 不一致、並修正的次數").register(meters);
    }

    static String key(long productId) { return "stock:" + productId; }

    /**
     * 下單前（交易外）：在 Redis 減掉這些熱點品項。不夠 → 409；Redis 不能用 → 503（0.6.3：熱點商品 × Redis 掛了 = 503，艙壁）。
     */
    void gate(List<ReserveLine> lines) {
        List<ReserveLine> sorted = lines.stream().sorted(Comparator.comparingLong(ReserveLine::productId)).toList();
        List<String> keys = sorted.stream().map(l -> key(l.productId())).toList();
        Object[] qty = sorted.stream().map(l -> String.valueOf(l.quantity())).toArray();
        for (int attempt = 0; attempt < 3; attempt++) {
            List<?> r = guard.call("hot-stock.gate", () -> redis.execute(GATE, keys, qty)).orElseThrow(HotStock::unavailable);
            int code = ((Number) r.get(0)).intValue(), i = ((Number) r.get(1)).intValue();
            if (code == 0) return;
            long productId = sorted.get(i - 1).productId();
            if (code == -2) throw new InsufficientStockException(productId);
            initialize(productId);                                          // -1：key 不存在 → 從 MySQL 建，再試一次
        }
        throw unavailable();
    }

    /** 下單失敗（價格變了、商品下架、資料庫錯誤……）：把減掉的加回去。失敗就只能等對帳（少賣，6.2.4） */
    void giveBack(List<ReserveLine> lines) {
        if (lines.isEmpty()) return;
        List<String> keys = lines.stream().map(l -> key(l.productId())).toList();
        Object[] qty = lines.stream().map(l -> String.valueOf(l.quantity())).toArray();
        if (!guard.run("hot-stock.give-back", () -> redis.execute(RETURN, keys, qty)))
            log.warn("HOT_STOCK_GIVE_BACK_FAILED {}（等對帳修正：在那之前這些數量賣不出去）", lines);
    }

    /**
     * 7.6.5 取消、補貨之後加回去（inventory.stock-returned 的消費者）。第 06 章的 giveBackAfterCommit 換成了事件：
     * 失敗就丟例外 —— 讓訊息走重試階梯，而不是像 giveBack() 一樣記一行日誌、等對帳。
     */
    void giveBackOrFail(List<ReserveLine> lines) {
        if (lines.isEmpty()) return;
        List<String> keys = lines.stream().map(l -> key(l.productId())).toList();
        Object[] qty = lines.stream().map(l -> String.valueOf(l.quantity())).toArray();
        if (!guard.run("hot-stock.give-back", () -> redis.execute(RETURN, keys, qty)))
            throw new IllegalStateException("Redis 不能用，熱點庫存加不回去：" + lines);
    }

    /**
     * Redis 的 stock:{id} 應該是多少（6.5.1 建立、6.6 對帳）。7.6 之後要再減掉「已經過了閘門、預留列寫了、還沒計入 reserved」的那些 ——
     * 否則對帳會把它們再放出去一次，閘門就放進了 MySQL 沒有的庫存（7.6.3）。
     * 一句 SQL：預留列的 counted 從 FALSE 變成 TRUE、reserved 加上同一個數，是在同一個交易裡發生的 —— 這句讀到的永遠是其中一邊。
     */
    static final String GATE_BASE_SQL = """
            SELECT i.on_hand - i.reserved - COALESCE((SELECT SUM(r.quantity) FROM inventory_reservations r
                                                       WHERE r.product_id = i.product_id AND r.status IN ('HELD', 'CONFIRMED')
                                                         AND r.counted = FALSE), 0)
              FROM inventory i WHERE i.product_id = ?""";

    /**
     * key 不存在（剛標成熱點、或 Redis 的資料丟了）：從 MySQL 的可售量建立。
     * 鎖不是為了正確性（SET NX 只會有一個人成功），是為了「100 個請求同時發現 key 不存在」時，只有一個去讀 MySQL。
     */
    void initialize(long productId) {
        Optional<DistributedLock.Handle> lock = guard.call("hot-stock.lock", () -> locks.tryLock("lock:" + key(productId), Duration.ofSeconds(2)).orElse(null));
        if (lock.isEmpty()) { sleep(20); return; }                          // 別人在建：等一下再試
        try {
            // 13 站 2.7：庫存列還沒建立（product.created 還沒送到）—— 不建 key：用 0 建，事件送到之後 Redis 會一直少那些庫存，直到對帳
            List<Integer> rows = jdbc.queryForList(GATE_BASE_SQL, Integer.class, productId);
            if (rows.isEmpty()) { log.warn("HOT_STOCK_NO_ROW productId={}：還沒有庫存列，先不建閘門", productId); return; }
            Integer available = rows.get(0);
            guard.run("hot-stock.init", () -> redis.opsForValue().setIfAbsent(key(productId), String.valueOf(available)));
        } finally {
            guard.run("hot-stock.unlock", () -> locks.unlock(lock.get()));
        }
    }

    /** 不再是熱點：刪掉 key（commit 之後） */
    void removeAfterCommit(long productId) {
        Runnable del = () -> guard.run("hot-stock.remove", () -> redis.delete(key(productId)));
        if (!TransactionSynchronizationManager.isSynchronizationActive()) { del.run(); return; }
        TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
            @Override
            public void afterCommit() { del.run(); }
        });
    }

    /** 商品頁顯示用（US-PRD-3 AC-4：允許約略值）。Redis 沒有或不能用 → empty */
    Optional<Integer> display(long productId) {
        return guard.call("hot-stock.display", () -> redis.opsForValue().get(key(productId))).map(Integer::valueOf);
    }

    /**
     * 6.6 對帳（0.6.4：Redis 預扣 ⇄ MySQL，差異必須為 0）：每一個 stock:* 讀一次 Redis、讀一次 MySQL，不一樣就用 CAS 改成 MySQL 的值。
     * CAS 失敗 = 這段期間有人動過它（下單、取消、補貨）—— 不改，下一輪再看。
     * 同一組不一致要「連續兩輪」都看到才改：搶購進行中，一張訂單在「Redis 已減、MySQL 還沒 commit」的那幾毫秒裡，兩邊本來就不一樣。
     * @return 這一輪修正了幾個
     */
    int reconcile() {
        List<Long> ids = new ArrayList<>();
        guard.run("hot-stock.scan", () -> {
            try (Cursor<String> c = redis.scan(ScanOptions.scanOptions().match("stock:*").count(500).build())) {
                c.forEachRemaining(k -> ids.add(Long.parseLong(k.substring("stock:".length()))));
            }
        });
        int fixed = 0;
        for (long id : ids) {
            Optional<String> before = guard.call("hot-stock.read", () -> redis.opsForValue().get(key(id)));
            if (before.isEmpty()) continue;
            Integer db = jdbc.queryForObject(GATE_BASE_SQL, Integer.class, id);
            String seen = before.get() + "/" + db;
            if (db == null || before.get().equals(String.valueOf(db))) { lastMismatch.remove(id); continue; }
            if (!seen.equals(lastMismatch.put(id, seen))) continue;            // 第一次看到：先記下來
            lastMismatch.remove(id);
            boolean swapped = guard.call("hot-stock.cas", () -> redis.execute(CAS, List.of(key(id)), before.get(), String.valueOf(db))).orElse(0L) == 1L;
            if (swapped) {
                fixed++;
                drift.increment();
                log.warn("HOT_STOCK_DRIFT productId={} redis={} mysql={}（已修正成 MySQL 的值）", id, before.get(), db);
            }
        }
        return fixed;
    }

    static ShopException unavailable() {
        return new ShopException(ProblemType.TEMPORARILY_UNAVAILABLE, "熱門商品暫時無法下單，請稍後再試").with("retryAfter", 5);
    }

    private static void sleep(long ms) {
        try { Thread.sleep(ms); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
    }
}
```

**`src/main/java/com/example/shop/catalog/internal/ProductService.java`**（2.7.3）

```java
package com.example.shop.catalog.internal;

import com.example.shop.catalog.CatalogApi;
import com.example.shop.catalog.ProductSnapshot;
import com.example.shop.catalog.ProductStatus;
import com.example.shop.catalog.internal.ProductDtos.*;
import com.example.shop.inventory.InventoryApi;
import com.example.shop.shared.audit.AuditAction;
import com.example.shop.shared.audit.AuditEntry;
import com.example.shop.shared.audit.AuditLog;
import com.example.shop.shared.error.ProblemType;
import com.example.shop.shared.error.ShopException;
import com.example.shop.shared.events.EventTypes;
import com.example.shop.shared.events.Outbox;
import com.example.shop.shared.web.PageResponse;
import com.example.shop.shared.web.Role;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.domain.Specification;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionTemplate;

import java.math.BigDecimal;
import java.time.Clock;
import java.util.*;
import java.util.function.Function;
import java.util.stream.Collectors;

/**
 * catalog 模組的應用層。public 是因為 internal.web 的 Controller 要用它（1.4.3：子套件之間要 public），
 * 別的模組不能用它 —— ModuleBoundaryTest 規則二。別的模組只能用 CatalogApi。
 */
@Service
public class ProductService implements CatalogApi {

    private final ProductRepository products;
    private final CategoryRepository categories;
    private final InventoryApi inventory;
    private final Clock clock;
    private final AuditLog audit;
    private final ProductCache cache;
    private final TransactionTemplate readOnly;
    private final TransactionTemplate tx;
    private final Outbox outbox;

    ProductService(ProductRepository products, CategoryRepository categories, InventoryApi inventory, Clock clock, AuditLog audit,
                   ProductCache cache, PlatformTransactionManager tm, Outbox outbox) {
        this.products = products;
        this.categories = categories;
        this.inventory = inventory;
        this.clock = clock;
        this.audit = audit;
        this.cache = cache;
        this.readOnly = new TransactionTemplate(tm);
        this.readOnly.setReadOnly(true);
        this.tx = new TransactionTemplate(tm);
        this.outbox = outbox;
    }

    /** 快取沒有的時候才從 MySQL 載入 —— 只有這一步需要交易（Category 是 LAZY，讀它的 id 要在 session 裡） */
    private Optional<ProductCache.Core> load(long id) {
        return readOnly.execute(s -> products.findById(id).map(ProductService::core));
    }

    static ProductCache.Core core(Product p) {
        return new ProductCache.Core(p.getId(), p.getSellerId(), p.getName(), p.getDescription(), p.getPrice(), p.getCategory().getId(),
                p.getStatus(), p.isHot(), p.getVersion());
    }

    /** 6.4.1 每一個改商品的方法最後都呼叫它：commit 之後，把新的值（新的版本）寫進快取 */
    private void refreshCacheAfterCommit(Product p) {
        cache.putAfterCommit(() -> core(p));
    }

    @Transactional
    public ProductDetail create(long sellerId, CreateProductRequest req) {
        Category category = categories.findById(req.categoryId())
                .orElseThrow(() -> new ShopException(ProblemType.VALIDATION, "分類不存在").with("field", "categoryId"));
        Product p = products.save(Product.draft(sellerId, category, req.name().strip(), req.description(), req.price(), clock.instant()));
        // 13 站 2.7：第 12 站在這裡呼叫 inventory.initialize()（MANDATORY，跟商品同一個交易）。庫存搬到另一個資料庫之後，那不再是一個交易 ——
        // 改成跟商品一起寫一個事件（outbox，同一個交易），庫存模組收到之後建立庫存列。庫存那一邊不會拒絕「建立」，所以事件就夠了，不需要 Saga。
        // 回應裡的可售量是賣家填的期初庫存：庫存列在事件送到之後才建立（通常不到一秒），這段時間 GET 看到的是 0 —— 商品是草稿，買家看不到
        outbox.add("PRODUCT", p.getId(), EventTypes.PRODUCT_CREATED,
                Map.of("productId", p.getId(), "sellerId", sellerId, "initialStock", req.initialStock()));
        return detailOf(p, req.initialStock());
    }

    // 13 站 1.6：下面幾個方法回傳的可售量，是 commit「之後」才問 inventory 的 —— 不在 catalog 的交易裡呼叫別的模組。
    // 一個行程的時候這只是順序的差別；切開之後，交易裡的遠端呼叫會一直佔著資料庫連線（13 站 0.2.3）。
    // 所以這幾個方法沒有 @Transactional：交易用 tx.execute() 包住「只動 catalog 的那一段」，可售量在外面補上

    public ProductDetail update(long sellerId, long productId, UpdateProductRequest req) {
        ProductDetail d = tx.execute(s -> {
            Product p = owned(sellerId, productId);
            Category category = req.categoryId() == null ? null : categories.findById(req.categoryId())
                    .orElseThrow(() -> new ShopException(ProblemType.VALIDATION, "分類不存在").with("field", "categoryId"));
            BigDecimal before = p.getPrice();
            p.update(req.name() == null ? null : req.name().strip(), req.description(), req.price(), category, clock.instant());
            if (p.getPrice().compareTo(before) != 0)                                  // 299 與 299.00 不算改價（3.5.2、4.2.4）
                audit.record(AuditEntry.of(AuditAction.PRODUCT_PRICE_CHANGED, sellerId, Role.SELLER.name(), "PRODUCT", productId,
                        Map.of("oldPrice", before, "newPrice", p.getPrice())));
            refreshCacheAfterCommit(p);                                      // US-PRD-3 AC-3：改價後 1 秒內讀到新價格
            return detailOf(p, 0);
        });
        return withAvailable(d, inventory.available(productId));
    }

    public ProductDetail publish(long sellerId, long productId) {
        ProductDetail d = tx.execute(s -> {
            Product p = owned(sellerId, productId);
            p.publish(clock.instant());
            refreshCacheAfterCommit(p);
            return detailOf(p, 0);
        });
        return withAvailable(d, inventory.available(productId));
    }

    public ProductDetail unpublish(long sellerId, long productId) {
        ProductDetail d = tx.execute(s -> {
            Product p = owned(sellerId, productId);
            if (!p.unpublish(clock.instant()))
                throw new ShopException(ProblemType.INVALID_STATE, "草稿狀態的商品不能下架").with("productStatus", p.getStatus());
            refreshCacheAfterCommit(p);                                      // US-PRD-4 AC-1：下架 1 秒內從詳情頁消失
            return detailOf(p, 0);
        });
        return withAvailable(d, inventory.available(productId));
    }

    /**
     * 6.5 標記熱點商品（0.6.1 第 3 條：由賣家標記 hot=true）。熱點商品的下單先過 Redis 的閘門。
     * 庫存的 Redis 副本由 inventory 在 commit 之後建立（InventoryApi.setHot）
     */
    public ProductDetail setHot(long sellerId, long productId, boolean hot) {
        ProductDetail d = tx.execute(s -> {
            Product p = owned(sellerId, productId);
            if (p.markHot(hot, clock.instant())) {
                inventory.setHot(productId, hot);                            // 這一個還在交易裡（MANDATORY）：13 站 1.6.7
                refreshCacheAfterCommit(p);
            }
            return detailOf(p, 0);
        });
        return withAvailable(d, inventory.available(productId));
    }

    /**
     * 補貨只改 inventory 的表。第 12 站把「確認是你的商品」與「補貨」包在 catalog 的同一個交易裡 —— 那個交易只為了讓 inventory.restock()
     * 加入它；catalog 自己什麼都沒寫。13 站 1.6：先確認（catalog 自己的唯讀交易），再補貨（inventory 自己的交易）
     */
    public ProductDetail restock(long sellerId, long productId, RestockRequest req) {
        ProductDetail d = readOnly.execute(s -> detailOf(owned(sellerId, productId), 0));
        inventory.restock(productId, req.quantity(), req.note() == null ? "seller-restock" : "seller-restock:" + req.note());
        return withAvailable(d, inventory.available(productId));
    }

    @Transactional(readOnly = true)
    public PageResponse<ProductSummary> search(SearchCriteria c, Pageable pageable) {
        Specification<Product> spec = Specification.where(ProductSpecs.onSale())
                .and(ProductSpecs.inCategory(c.categoryId()))
                .and(ProductSpecs.priceBetween(c.minPrice(), c.maxPrice()))
                .and(ProductSpecs.nameContains(c.q()));
        Page<Product> page = products.findAll(spec, pageable);
        return PageResponse.of(page, p -> new ProductSummary(p.getId(), p.getName(), p.getPrice(), p.getCategory().getId()));
    }

    /**
     * US-PRD-3：商品詳情。先讀快取（6.4），沒有才讀 MySQL；可售量另外讀（熱點商品讀 Redis 的副本，其他商品快取 5 秒，AC-4）。
     * AC-2：非 ON_SALE 的商品，只有賣家本人看得到；其他人一律 404（跟「不存在」長得一模一樣）
     * 方法上「沒有」@Transactional（6.2.3）：有的話，快取命中時 MySQL 一樣收到 5 句（SET autocommit、commit……）、拿一條連線。
     * 只有快取沒命中時的 load() 需要交易，它自己開。
     */
    public ProductDetail detail(long productId, Long viewerId) {
        ProductCache.Core c = cache.get(productId, this::load)
                .orElseThrow(() -> ShopException.notFound("商品"));
        boolean visible = c.status() == ProductStatus.ON_SALE || (viewerId != null && c.sellerId() == viewerId);
        if (!visible) throw ShopException.notFound("商品");
        return new ProductDetail(c.id(), c.sellerId(), c.name(), c.description(), c.price(), c.categoryId(), c.status(),
                inventory.availableForDisplay(productId, c.hot()));
    }

    public PageResponse<SellerProductView> mine(long sellerId, Pageable pageable) {
        PageResponse<SellerProductView> page = readOnly.execute(s -> PageResponse.of(products.findBySellerId(sellerId, pageable),
                p -> new SellerProductView(p.getId(), p.getName(), p.getPrice(), p.getStatus(), p.getCategory().getId(), 0, p.getUpdatedAt())));
        Map<Long, Integer> available = inventory.available(page.content().stream().map(SellerProductView::id).toList());   // 13 站 1.6：交易之外
        return new PageResponse<>(page.content().stream().map(v -> new SellerProductView(v.id(), v.name(), v.price(), v.status(),
                v.categoryId(), available.getOrDefault(v.id(), 0), v.updatedAt())).toList(), page.page(), page.size(), page.totalElements(), page.totalPages());
    }

    @Override
    public Set<Long> hotProducts(Collection<Long> productIds) {
        Set<Long> hot = new HashSet<>();
        for (long id : productIds)
            cache.get(id, this::load).filter(ProductCache.Core::hot).ifPresent(c -> hot.add(id));
        return hot;
    }

    @Override
    @Transactional(readOnly = true)
    public Map<Long, ProductSnapshot> snapshots(Collection<Long> productIds) {
        if (productIds.isEmpty()) return Map.of();
        return products.findAllById(productIds).stream()
                .map(p -> new ProductSnapshot(p.getId(), p.getSellerId(), p.getName(), p.getPrice(), p.getStatus(), p.isHot()))
                .collect(Collectors.toMap(ProductSnapshot::id, Function.identity()));
    }

    /** US-PRD-1 AC-4：別人的商品 → 404，不是 403；存在但不是你的 → 另外記一筆 ACCESS_DENIED（US-AUD-1，5.8） */
    private Product owned(long sellerId, long productId) {
        Optional<Product> found = products.findById(productId);
        return found.filter(p -> p.ownedBy(sellerId)).orElseThrow(() -> {
            if (found.isPresent())
                audit.recordRejectionLater(AuditEntry.of(AuditAction.ACCESS_DENIED, sellerId, Role.SELLER.name(), "PRODUCT", productId, null));
            return ShopException.notFound("商品");
        });
    }

    private static ProductDetail withAvailable(ProductDetail d, int available) {
        return new ProductDetail(d.id(), d.sellerId(), d.name(), d.description(), d.price(), d.categoryId(), d.status(), available);
    }

    private static ProductDetail detailOf(Product p, int available) {
        return new ProductDetail(p.getId(), p.getSellerId(), p.getName(), p.getDescription(), p.getPrice(),
                p.getCategory().getId(), p.getStatus(), available);
    }
}
```

**`src/test/java/com/example/shop/dist02/Split.java`**（2.4.6）

```java
package com.example.shop.dist02;

import com.example.shop.ShopApplication;
import com.example.shop.dist00.SplitLab;
import com.example.shop.dist01.Probe;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.data.redis.connection.RedisConnection;
import org.springframework.data.redis.core.RedisCallback;
import org.springframework.data.redis.core.StringRedisTemplate;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;

/**
 * 13 站 2.4.6：第 02 章的實驗支架。跟第 00 章一樣是「同一份程式碼、兩個服務」，差在三件事：
 *
 *   ① 資料庫是「誠實的」（Schema.HONEST）：庫存服務的庫只跑 db/migration/inventory 與 shared，訂單服務的庫跑其他所有資料夾 ——
 *      訂單服務的庫裡沒有任何一張庫存的表，庫存服務的庫裡也沒有商品、訂單。第 00 章是兩個庫都跑全部的 migration（Schema.SHARED）。
 *   ② InventoryApi 的 13 個方法全部走 HTTP（Remote.FULL：RemoteInventory → InventoryEndpoints）。第 00 章只換了 reserve 與可售量（Remote.CH00）。
 *   ③ 兩個服務在同一個 JVM 裡（兩個 Spring context）：使用者的一天要把事件交給「另一個服務」的消費者，在同一個 JVM 裡才拿得到它的 bean。
 *      第 00 章的庫存服務在另一個 JVM（量延遲與連線池時，兩個 JVM 才誠實）—— 這一章量的是「資料落在哪裡」，不是延遲。
 *
 * 資料庫：shop_d02_order、shop_d02_inv（比照第 00 章：root 建庫、shop_migrator 跑 migration、應用程式只拿 shop_app 這個角色）。
 * Redis：訂單服務 10 號、庫存服務 9 號 database（第 00 章用 11～13、第 01 章用 14）。每次啟動先清空。
 */
public final class Split {

    public static final String ORDER_DB = "shop_d02_order", INV_DB = "shop_d02_inv";
    public static final int ORDER_REDIS = 10, INV_REDIS = 9;

    /** SHARED：第 00 章的做法，兩個庫都跑全部的 migration；HONEST：各跑各的資料夾（2.4.2） */
    public enum Schema { SHARED, HONEST }

    /** CH00：第 00 章的 RemoteInventoryApi / LabInventoryService（只有 reserve 與可售量走 HTTP）；FULL：13 個方法全部走 HTTP（2.4.6） */
    public enum Remote { CH00, FULL }

    private Split() {}

    public static void freshDatabases() throws Exception {
        SplitLab.freshDatabase(ORDER_DB);
        SplitLab.freshDatabase(INV_DB);
    }

    /** db/migration 底下除了 inventory 的每一個資料夾（第 2.4.1 節之後一個模組一個資料夾） */
    static String withoutInventory() throws Exception {
        try (Stream<Path> s = Files.list(Path.of("src/main/resources/db/migration"))) {
            return String.join(",", s.filter(Files::isDirectory).map(p -> p.getFileName().toString())
                    .filter(m -> !m.equals("inventory")).sorted().map(m -> "classpath:db/migration/" + m).toList());
        }
    }

    static final String INVENTORY_ONLY = "classpath:db/migration/inventory,classpath:db/migration/shared";

    static List<String> args(String db, int redisDb, Schema schema, boolean inventoryService, boolean validate) throws Exception {
        List<String> a = new ArrayList<>(SplitLab.common(db, redisDb));
        a.removeIf(x -> x.startsWith("--spring.datasource.url="));          // 同一個參數給兩次，Spring 會用逗號接起來（第 01 章 1.4.5）
        a.add("--spring.datasource.url=" + SplitLab.url(db) + "&queryInterceptors=" + DbTap.class.getName());
        if (schema == Schema.HONEST)
            a.add("--spring.flyway.locations=" + (inventoryService ? INVENTORY_ONLY : withoutInventory()));
        // 2.4.6 小坑：第 12 站的 ddl-auto=validate 檢查「所有」實體 —— 庫存的兩個實體在訂單服務的庫找不到表，商品、訂單的實體在庫存服務的庫找不到
        if (!validate) a.add("--spring.jpa.hibernate.ddl-auto=none");
        if (inventoryService) a.add("--shop.security.bootstrap-admin.enabled=false");   // 庫存服務的庫沒有 users 表
        a.add("--lab.d01.probe=true");                                      // 第 01 章的 ApiTap：HTTP 請求標上「哪一個動作」（OpTag）
        return a;
    }

    public static ConfigurableApplicationContext inventoryService(Schema schema, Remote remote, boolean validate) throws Exception {
        List<String> a = args(INV_DB, INV_REDIS, schema, true, validate);
        a.add(remote == Remote.CH00 ? "--lab.d00.inventory-service=true" : "--lab.d02.inventory-service=true");
        return flushed(new SpringApplicationBuilder(ShopApplication.class).run(a.toArray(String[]::new)));
    }

    public static ConfigurableApplicationContext orderService(Schema schema, Remote remote, ConfigurableApplicationContext inventory, boolean validate) throws Exception {
        List<String> a = args(ORDER_DB, ORDER_REDIS, schema, false, validate);
        String url = "http://127.0.0.1:" + SplitLab.port(inventory);
        a.add(remote == Remote.CH00 ? "--lab.d00.remote-inventory-url=" + url : "--lab.d02.remote-inventory-url=" + url);
        a.removeIf(x -> x.startsWith("--shop.order.jobs-enabled="));         // 使用者的一天直接呼叫 OrderJobs（第 01 章 1.4.4 的小坑）：要有這個 bean，
        a.addAll(List.of("--shop.order.jobs-enabled=true", "--shop.order.timeout-scan-interval=1h"));   // 間隔拉長到不會自己跑第二次
        ConfigurableApplicationContext ctx = new SpringApplicationBuilder(ShopApplication.class).run(a.toArray(String[]::new));
        Thread.sleep(1000);                                                  // 排程在啟動時各跑一次（空的資料庫）：等它跑完
        return flushed(ctx);
    }

    /** 資料庫每次重建，id 每次從同一個號碼開始 —— 上一次留在 Redis 的商品快取、熱點閘門會被讀到（第 01 章 1.4.5 的 ⚠️） */
    static ConfigurableApplicationContext flushed(ConfigurableApplicationContext ctx) {
        ctx.getBean(StringRedisTemplate.class).execute((RedisCallback<Void>) (RedisConnection c) -> {
            c.serverCommands().flushDb();
            return null;
        });
        return ctx;
    }

    /** 使用者的一天（第 01 章 1.4.4）在切開的部署上：庫存屬於庫存服務，其他八個模組屬於訂單服務 */
    public static Map<String, ConfigurableApplicationContext> owners(ConfigurableApplicationContext order, ConfigurableApplicationContext inventory) {
        Map<String, ConfigurableApplicationContext> m = new HashMap<>();
        for (String module : Probe.MODULES) m.put(module, module.equals("inventory") ? inventory : order);
        return m;
    }

    public static Map<String, String> databases() {
        Map<String, String> m = new HashMap<>();
        for (String module : Probe.MODULES) m.put(module, module.equals("inventory") ? INV_DB : ORDER_DB);
        return m;
    }

    /** 一個資料庫裡有哪些表（不含 flyway_schema_history） */
    public static List<String> tables(String db) throws Exception {
        List<String> t = new ArrayList<>();
        try (var c = SplitLab.root(db); var ps = c.prepareStatement(
                "SELECT table_name FROM information_schema.tables WHERE table_schema = ? AND table_name <> 'flyway_schema_history' ORDER BY 1")) {
            ps.setString(1, db);
            try (var rs = ps.executeQuery()) { while (rs.next()) t.add(rs.getString(1)); }
        }
        return t;
    }
}
```

**`src/test/java/com/example/shop/dist02/DbTap.java`**（2.4.6）

```java
package com.example.shop.dist02;

import com.example.shop.dist01.OpTag;
import com.example.shop.dist01.Probe;
import com.mysql.cj.MysqlConnection;
import com.mysql.cj.Query;
import com.mysql.cj.interceptors.QueryInterceptor;
import com.mysql.cj.log.Log;
import com.mysql.cj.protocol.Resultset;
import com.mysql.cj.protocol.ServerSession;

import java.sql.Connection;
import java.util.Properties;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.function.Supplier;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 13 站 2.2、2.4.7：每一句碰到模組的表的 SQL，送到了「哪一個資料庫」、是哪一段程式碼送的。
 * 跟第 01 章的 SqlTap 同一個掛勾（Connector/J 的 query interceptor，JDBC URL 加 queryInterceptors=…），問的問題不一樣：
 * SqlTap 問「一個交易寫了哪些模組」，這裡問「庫存模組的 SQL 落在哪一個庫」—— 兩個服務在同一個 JVM 裡，記在同一個地方。
 */
public class DbTap implements QueryInterceptor {

    /** db：連線當下的資料庫；site：送出這句 SQL 的程式碼（呼叫堆疊上第一個模組 internal 的類別.方法） */
    public record Stmt(String db, String table, String owner, boolean write, String site, String op) {}

    public static final ConcurrentLinkedQueue<Stmt> STMTS = new ConcurrentLinkedQueue<>();

    public static void reset() { STMTS.clear(); }

    private static final Pattern WRITE = Pattern.compile(
            "(?is)^\\s*(?:insert\\s+(?:ignore\\s+)?into|replace\\s+into|update|delete\\s+(?:\\w+\\s+)?from)\\s+`?(\\w+)`?");
    private static final Pattern READ = Pattern.compile("(?i)\\b(?:from|join)\\s+`?(\\w+)`?");

    private Connection conn;

    @Override
    public QueryInterceptor init(MysqlConnection c, Properties props, Log log) {
        this.conn = (Connection) c;
        return this;
    }

    @Override
    public <T extends Resultset> T preProcess(Supplier<String> sql, Query query) {
        String s = sql.get();
        if (s == null) return null;
        String t = s.strip();
        Matcher w = WRITE.matcher(t);
        String table = null;
        boolean write = false;
        if (w.find() && Probe.OWNER.containsKey(w.group(1).toLowerCase())) { table = w.group(1).toLowerCase(); write = true; }
        if (table == null) {
            Matcher r = READ.matcher(t);
            while (r.find()) if (Probe.OWNER.containsKey(r.group(1).toLowerCase())) { table = r.group(1).toLowerCase(); break; }
        }
        if (table == null) return null;
        STMTS.add(new Stmt(db(), table, Probe.OWNER.get(table), write, site(), OpTag.current()));
        return null;
    }

    private String db() {
        try {
            return conn.getCatalog();                                       // Connector/J 記著目前的資料庫，不會再問一次 MySQL
        } catch (Exception e) {
            return "?";
        }
    }

    /** 呼叫堆疊上第一個「模組 internal」的 frame：JdbcInventoryService.initialize、ProductService.create…… */
    static String site() {
        return StackWalker.getInstance().walk(st -> st
                .filter(f -> f.getClassName().startsWith("com.example.shop.") && f.getClassName().contains(".internal.")
                        && !f.getClassName().contains("$$"))
                .map(f -> f.getClassName().substring(f.getClassName().lastIndexOf('.') + 1) + "." + f.getMethodName())
                .findFirst()).orElse("(其他)");
    }

    @Override
    public boolean executeTopLevelOnly() { return true; }

    @Override
    public void destroy() {}

    @Override
    public <T extends Resultset> T postProcess(Supplier<String> sql, Query query, T originalResultSet, ServerSession serverSession) {
        return null;
    }
}
```

**`src/test/java/com/example/shop/dist02/RemoteInventory.java`**（2.4.6、2.6.3）

```java
package com.example.shop.dist02;

import com.example.shop.inventory.InsufficientStockException;
import com.example.shop.inventory.InventoryApi;
import com.example.shop.inventory.ReservationRef;
import com.example.shop.inventory.ReserveLine;
import com.example.shop.shared.error.ProblemType;
import com.example.shop.shared.error.ShopException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Primary;
import org.springframework.http.HttpStatusCode;
import org.springframework.http.client.JdkClientHttpRequestFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;

import java.net.http.HttpClient;
import java.time.Duration;
import java.util.Collection;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * 13 站 2.4.6：訂單服務那一側的 InventoryApi —— 13 個方法「全部」走 HTTP（第 00 章的 RemoteInventoryApi 只換了 reserve 與可售量，
 * 其他 9 個照舊在本地執行、讀寫訂單服務自己的庫：2.2）。
 *
 * 錯誤照第 12 站的 Problem Details（RFC 9457）傳回來，這裡還原成同一個例外：庫存不足 → InsufficientStockException（呼叫端照舊 409），
 * 其他業務錯誤 → 同一個 ProblemType 的 ShopException（例如出貨時「還在落帳」的 503）。系統錯誤 → IllegalStateException（呼叫端 500）。
 *
 * ⚠️ 這不是服務之間該有的介面（第 03 章）：它只是把 13 個 Java 方法原封不動搬到 HTTP 上，讓這一章可以專心看「資料」。
 * 交易語意也照搬不了 —— 呼叫端開著交易，這一次 HTTP 在庫存服務那一側是另一個交易，回應之前就 commit 了（第 00 章 0.2.2）。
 */
@Component
@Primary
@ConditionalOnProperty(name = "lab.d02.remote-inventory-url")
class RemoteInventory implements InventoryApi {

    private static final Set<String> STANDARD = Set.of("type", "title", "status", "detail", "instance", "traceId");

    private final RestClient http;
    private final ObjectMapper json = new ObjectMapper();

    RemoteInventory(@Value("${lab.d02.remote-inventory-url}") String url) {
        JdkClientHttpRequestFactory f = new JdkClientHttpRequestFactory(HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(1)).build());
        f.setReadTimeout(Duration.ofSeconds(10));
        this.http = RestClient.builder().baseUrl(url).requestFactory(f).build();
    }

    private JsonNode call(String op, Map<String, ?> body) {
        String res = http.post().uri("/lab/d02/inventory/" + op).body(body).retrieve()
                .onStatus(HttpStatusCode::isError, (req, r) -> { throw decode(r.getStatusCode().value(), new String(r.getBody().readAllBytes())); })
                .body(String.class);
        try {
            return res == null || res.isEmpty() ? json.createObjectNode() : json.readTree(res);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    /** 庫存服務的 Problem Details → 呼叫端在本地會拿到的同一個例外 */
    RuntimeException decode(int status, String body) {
        try {
            JsonNode p = json.readTree(body);
            String type = p.path("type").asText();
            for (ProblemType pt : ProblemType.values()) {
                if (!pt.type().toString().equals(type) || pt == ProblemType.INTERNAL) continue;
                if (pt == ProblemType.INSUFFICIENT_STOCK) return new InsufficientStockException(p.get("productId").asLong());
                ShopException e = new ShopException(pt, p.path("detail").asText());
                for (Iterator<Map.Entry<String, JsonNode>> it = p.fields(); it.hasNext(); ) {
                    var f = it.next();
                    if (!STANDARD.contains(f.getKey())) e.with(f.getKey(), f.getValue().isNumber() ? f.getValue().numberValue() : f.getValue().asText());
                }
                return e;
            }
        } catch (Exception notJson) { /* 落到下面 */ }
        return new IllegalStateException("庫存服務回應 " + status + "：" + body);
    }

    @Override public void initialize(long productId, int onHand, String note) { call("initialize", Map.of("productId", productId, "onHand", onHand, "note", note)); }
    @Override public void reserve(long orderId, List<ReserveLine> lines) { call("reserve", Map.of("orderId", orderId, "lines", lines)); }
    @Override public void holdHot(long orderId, List<ReserveLine> lines) { call("hold-hot", Map.of("orderId", orderId, "lines", lines)); }
    @Override public void confirm(long orderId) { call("confirm", Map.of("orderId", orderId)); }
    @Override public void release(long orderId) { call("release", Map.of("orderId", orderId)); }
    @Override public void consume(long orderId) { call("consume", Map.of("orderId", orderId)); }
    @Override public void restock(long productId, int quantity, String note) { call("restock", Map.of("productId", productId, "quantity", quantity, "note", note)); }
    @Override public void gateHot(List<ReserveLine> hotLines) { call("gate-hot", Map.of("lines", hotLines)); }
    @Override public void returnHot(List<ReserveLine> hotLines) { call("return-hot", Map.of("lines", hotLines)); }
    @Override public void setHot(long productId, boolean hot) { call("set-hot", Map.of("productId", productId, "hot", hot)); }
    @Override public int availableForDisplay(long productId, boolean hot) { return call("available-for-display", Map.of("productId", productId, "hot", hot)).get("value").asInt(); }
    @Override public int available(long productId) { return call("available-one", Map.of("productId", productId)).get("value").asInt(); }

    // ── 2.6 對帳 ──
    @Override
    public List<ReservationRef> activeReservations(long afterId, java.time.Instant createdBefore, int limit) {
        List<ReservationRef> out = new java.util.ArrayList<>();
        call("active-reservations", Map.of("afterId", afterId, "createdBefore", createdBefore.toString(), "limit", limit)).get("rows").forEach(r -> out.add(ref(r)));
        return out;
    }

    @Override
    public Map<Long, List<ReservationRef>> reservationsOf(Collection<Long> orderIds) {
        Map<Long, List<ReservationRef>> out = new HashMap<>();
        if (orderIds.isEmpty()) return out;
        call("reservations-of", Map.of("orderIds", orderIds)).get("rows").forEach(r -> out.computeIfAbsent(r.get("orderId").asLong(), k -> new java.util.ArrayList<>()).add(ref(r)));
        return out;
    }

    @Override public void releaseAbandoned(long orderId) { call("release-abandoned", Map.of("orderId", orderId)); }

    static ReservationRef ref(JsonNode r) {
        return new ReservationRef(r.get("id").asLong(), r.get("orderId").asLong(), r.get("productId").asLong(), r.get("quantity").asInt(), r.get("status").asText());
    }

    @Override
    public Map<Long, Integer> available(Collection<Long> productIds) {
        Map<Long, Integer> out = new HashMap<>();
        if (productIds.isEmpty()) return out;
        call("available", Map.of("productIds", productIds)).fields().forEachRemaining(f -> out.put(Long.parseLong(f.getKey()), f.getValue().asInt()));
        return out;
    }
}
```

**`src/test/java/com/example/shop/dist02/InventoryEndpoints.java`**（2.4.6、2.6.3）

```java
package com.example.shop.dist02;

import com.example.shop.inventory.InventoryApi;
import com.example.shop.inventory.ReserveLine;
import com.fasterxml.jackson.databind.JsonNode;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.annotation.Order;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configurers.AbstractHttpConfigurer;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * 13 站 2.4.6：庫存服務那一側。InventoryApi 的 13 個方法，各一支 POST /lab/d02/inventory/{op}。
 * 第 12 站標 MANDATORY 的那 7 個（initialize、reserve、holdHot、confirm、release、consume、setHot）在這裡自己開交易、自己 commit ——
 * 呼叫端的交易在另一個行程、另一個資料庫，等不到它（第 00 章 0.2.0 的那一行 tx.executeWithoutResult，現在是 7 行）。
 * 業務錯誤（庫存不足、還在落帳……）交給第 12 站的 GlobalExceptionHandler，照常回 Problem Details。
 *
 * 只在 lab.d02.inventory-service=true 時存在；巢狀的 @RestController 自己也標條件（第 00 章 0.9 的教訓）。
 */
@Configuration
@ConditionalOnProperty(name = "lab.d02.inventory-service", havingValue = "true")
class InventoryEndpoints {

    @RestController
    @ConditionalOnProperty(name = "lab.d02.inventory-service", havingValue = "true")
    static class Endpoint {
        private final InventoryApi inventory;
        private final TransactionTemplate tx;

        Endpoint(@Qualifier("jdbcInventoryService") InventoryApi inventory, PlatformTransactionManager tm) {
            this.inventory = inventory;
            this.tx = new TransactionTemplate(tm);
        }

        @PostMapping("/lab/d02/inventory/{op}")
        Map<?, ?> call(@PathVariable String op, @RequestBody JsonNode b) {
            switch (op) {
                case "initialize" -> tx.executeWithoutResult(s -> inventory.initialize(b.get("productId").asLong(), b.get("onHand").asInt(), b.get("note").asText()));
                case "reserve" -> tx.executeWithoutResult(s -> inventory.reserve(b.get("orderId").asLong(), lines(b)));
                case "hold-hot" -> tx.executeWithoutResult(s -> inventory.holdHot(b.get("orderId").asLong(), lines(b)));
                case "confirm" -> tx.executeWithoutResult(s -> inventory.confirm(b.get("orderId").asLong()));
                case "release" -> tx.executeWithoutResult(s -> inventory.release(b.get("orderId").asLong()));
                case "consume" -> tx.executeWithoutResult(s -> inventory.consume(b.get("orderId").asLong()));
                case "set-hot" -> tx.executeWithoutResult(s -> inventory.setHot(b.get("productId").asLong(), b.get("hot").asBoolean()));
                case "restock" -> inventory.restock(b.get("productId").asLong(), b.get("quantity").asInt(), b.get("note").asText());
                case "gate-hot" -> inventory.gateHot(lines(b));
                case "return-hot" -> inventory.returnHot(lines(b));
                case "available-for-display" -> { return Map.of("value", inventory.availableForDisplay(b.get("productId").asLong(), b.get("hot").asBoolean())); }
                case "available-one" -> { return Map.of("value", inventory.available(b.get("productId").asLong())); }
                case "available" -> {
                    List<Long> ids = new ArrayList<>();
                    b.get("productIds").forEach(x -> ids.add(x.asLong()));
                    return inventory.available(ids);
                }
                case "active-reservations" -> {
                    return Map.of("rows", inventory.activeReservations(b.get("afterId").asLong(), java.time.Instant.parse(b.get("createdBefore").asText()), b.get("limit").asInt()));
                }
                case "reservations-of" -> {
                    List<Long> ids = new ArrayList<>();
                    b.get("orderIds").forEach(x -> ids.add(x.asLong()));
                    return Map.of("rows", inventory.reservationsOf(ids).values().stream().flatMap(List::stream).toList());
                }
                case "release-abandoned" -> inventory.releaseAbandoned(b.get("orderId").asLong());
                default -> throw new IllegalArgumentException("沒有這個操作：" + op);
            }
            return Map.of();
        }

        static List<ReserveLine> lines(JsonNode b) {
            List<ReserveLine> out = new ArrayList<>();
            b.get("lines").forEach(l -> out.add(new ReserveLine(l.get("productId").asLong(), l.get("quantity").asInt())));
            return out;
        }
    }

    /** 第 12 站的 SecurityConfig 對沒列出的路徑一律 denyAll —— 跟第 00 章一樣另開一條鏈（服務之間的認證是第 03 章的事） */
    @Bean
    @Order(0)
    SecurityFilterChain d02LabChain(HttpSecurity http) throws Exception {
        return http.securityMatcher("/lab/**")
                .csrf(AbstractHttpConfigurer::disable)
                .authorizeHttpRequests(a -> a.anyRequest().permitAll())
                .build();
    }
}
```

**`src/test/java/com/example/shop/dist02/C1SharedSchemaTest.java`**（2.2、2.4.7、2.7.6（實驗））

```java
package com.example.shop.dist02;

import ch.qos.logback.classic.Level;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.classic.spi.IThrowableProxy;
import com.example.shop.dist00.SplitLab;
import com.example.shop.dist01.D01Workload;
import com.example.shop.dist01.Probe;
import com.example.shop.support.CapturedLogs;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.context.ConfigurableApplicationContext;

import java.io.PrintStream;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 13 站 2.2、2.4.7：第 01 章「使用者的一天」，跑在三種切開的部署上。
 *
 *   ① 第 00 章的切法：兩個庫都跑了全部的 migration；只有 reserve 與可售量走 HTTP
 *   ② 誠實的庫（各跑各的資料夾），程式碼照第 00 章
 *   ③ 誠實的庫，13 個方法全部走 HTTP（這一章的 RemoteInventory）
 *
 *   mvn test -Pexperiments -Dtest=C1SharedSchemaTest
 */
@Tag("experiment")
class C1SharedSchemaTest {

    final PrintStream out = System.out;

    @Test
    void threeDeployments() throws Exception {
        out.printf("═══ 2.2 ① 第 00 章的切法：兩個庫都跑了全部的 migration，只有 reserve 與可售量走 HTTP（load %s）═══%n", SplitLab.load());
        Split.freshDatabases();
        try (ConfigurableApplicationContext inv = Split.inventoryService(Split.Schema.SHARED, Split.Remote.CH00, true);
             ConfigurableApplicationContext order = Split.orderService(Split.Schema.SHARED, Split.Remote.CH00, inv, true)) {
            // 第 00 章：庫存服務只有兩支 HTTP，其他的庫存程式碼都在訂單服務裡跑 —— 所以九個模組都「屬於」訂單服務
            Map<String, ConfigurableApplicationContext> all = Split.owners(order, order);
            Map<String, String> dbs = new TreeMap<>();
            all.keySet().forEach(m -> dbs.put(m, Split.ORDER_DB));
            day(new D01Workload(order, all, dbs));
            rows();
        }

        out.printf("═══ 2.2 ② 誠實的庫：訂單服務的庫沒有庫存的表、庫存服務的庫只有庫存的表；程式碼照第 00 章（load %s）═══%n", SplitLab.load());
        Split.freshDatabases();
        try (ConfigurableApplicationContext inv = Split.inventoryService(Split.Schema.HONEST, Split.Remote.CH00, true)) {
            out.println("  庫存服務起來了（不應該）");
        } catch (Exception e) {
            out.println("  庫存服務起不來：" + root(e));
        }
        Split.freshDatabases();
        try (ConfigurableApplicationContext inv = Split.inventoryService(Split.Schema.HONEST, Split.Remote.CH00, false);
             ConfigurableApplicationContext order = Split.orderService(Split.Schema.HONEST, Split.Remote.CH00, inv, true)) {
            out.println("  訂單服務起來了（不應該）");
        } catch (Exception e) {
            out.println("  訂單服務起不來：" + root(e));
        }
        out.println("  ── 兩個服務都關掉 ddl-auto=validate 再起一次 ──");
        Split.freshDatabases();
        try (ConfigurableApplicationContext inv = Split.inventoryService(Split.Schema.HONEST, Split.Remote.CH00, false);
             ConfigurableApplicationContext order = Split.orderService(Split.Schema.HONEST, Split.Remote.CH00, inv, false);
             CapturedLogs logs = CapturedLogs.attach()) {
            Map<String, ConfigurableApplicationContext> all = Split.owners(order, order);
            Map<String, String> dbs = new TreeMap<>();
            all.keySet().forEach(m -> dbs.put(m, Split.ORDER_DB));
            day(new D01Workload(order, all, dbs));
            logs.events().stream().filter(e -> e.getLevel() == Level.ERROR && e.getThrowableProxy() != null).findFirst()
                    .ifPresent(e -> out.println("  訂單服務的 ERROR 日誌：" + e.getFormattedMessage() + " ← " + root(e.getThrowableProxy())));
        }

        out.printf("═══ 2.4.7 ③ 誠實的庫，InventoryApi 的 13 個方法全部走 HTTP（load %s）═══%n", SplitLab.load());
        Split.freshDatabases();
        try (ConfigurableApplicationContext inv = Split.inventoryService(Split.Schema.HONEST, Split.Remote.FULL, false);
             ConfigurableApplicationContext order = Split.orderService(Split.Schema.HONEST, Split.Remote.FULL, inv, false)) {
            out.println("  訂單服務的庫：" + Split.tables(Split.ORDER_DB));
            out.println("  庫存服務的庫：" + Split.tables(Split.INV_DB));
            boolean done = day(new D01Workload(order, Split.owners(order, inv), Split.databases()));
            rows();
            // 2.4.4：兩個庫在同一台 MySQL、兩個服務用同一個帳號（shop，角色 shop_app）—— 庫存的 migration 把那幾張表授權給 shop_app，
            // 授權跟著角色走，不跟著「哪一個服務」走
            try (var c = java.sql.DriverManager.getConnection(SplitLab.url(Split.ORDER_DB), "shop", "shop"); var st = c.createStatement();
                 var rs = st.executeQuery("SELECT COUNT(*) FROM " + Split.INV_DB + ".inventory")) {
                rs.next();
                out.printf("  訂單服務的帳號（shop）讀庫存服務的庫：SELECT COUNT(*) FROM %s.inventory → %d（讀得到）%n", Split.INV_DB, rs.getLong(1));
            } catch (java.sql.SQLException e) {
                out.println("  訂單服務的帳號（shop）讀庫存服務的庫 → " + e.getMessage());
            }
            // 只算訂單服務那一側（庫存服務的 /lab 端點在自己的交易裡呼叫自己的模組，不算）
            List<String> inTx = Probe.CALLS.stream().filter(c -> c.callee().equals("inventory") && c.inTx() && !c.op().startsWith("POST /lab/"))
                    .map(c -> String.format("%-48s %s", c.op(), c.method())).distinct().sorted().toList();
            out.printf("  訂單服務在自己的交易裡呼叫庫存服務：%d 種（動作 × 方法）—— 每一種都是「兩個交易」%n", inTx.size());
            inTx.forEach(x -> out.println("    " + x));
            assertThat(done).isTrue();
            assertThat(DbTap.STMTS.stream().filter(s -> s.owner().equals("inventory")).allMatch(s -> s.db().equals(Split.INV_DB))).isTrue();
        }
        out.printf("  （結束時 load %s）%n", SplitLab.load());
    }

    /** 跑一次使用者的一天，到第一個「不是預期的回應」為止；然後印出：庫存模組的 SQL 落在哪一個庫 */
    boolean day(D01Workload w) {
        DbTap.reset();
        Probe.reset();
        boolean done;
        try {
            w.run();
            out.printf("  使用者的一天：%d 個 HTTP 請求全部是預期的回應%n", w.steps.stream().filter(s -> s.status() > 0).count());
            done = true;
        } catch (Exception e) {
            boolean http = e instanceof IllegalStateException && e.getMessage() != null && e.getMessage().contains(" → ");
            out.printf("  使用者的一天：走了 %d 個 HTTP 請求，停在%s —— %s%n", w.steps.stream().filter(s -> s.status() > 0).count(),
                    http ? "一個不是預期的回應" : "交付事件或跑排程的時候", http ? oneLine(e.getMessage()) : root(e));
            done = false;
        }
        Map<String, Integer> where = new TreeMap<>();
        for (DbTap.Stmt s : DbTap.STMTS)
            if (s.owner().equals("inventory")) where.merge(String.format("%-46s → %s", s.site(), s.db()), 1, Integer::sum);
        out.println("  庫存的表收到的 SQL（送出的程式碼 → 哪一個庫：句數）：");
        where.forEach((k, n) -> out.printf("    %s：%d%n", k, n));
        Map<String, Integer> foreign = new TreeMap<>();
        for (DbTap.Stmt s : DbTap.STMTS)
            if (s.db().equals(Split.INV_DB) && !s.owner().equals("inventory") && !s.owner().equals("shared"))
                foreign.merge(s.table() + "（" + s.owner() + "）", 1, Integer::sum);
        if (!foreign.isEmpty()) out.println("  庫存服務的庫收到別的模組的 SQL：" + foreign);
        return done;
    }

    void rows() throws Exception {
        for (String db : List.of(Split.ORDER_DB, Split.INV_DB)) {
            List<String> t = Split.tables(db);
            if (!t.contains("inventory")) { out.printf("  %-15s：沒有庫存的表%n", db); continue; }
            out.printf("  %-15s：inventory %d 列、inventory_reservations %d 列、inventory_ledger %d 列%n", db,
                    SplitLab.count(db, "SELECT COUNT(*) FROM inventory"), SplitLab.count(db, "SELECT COUNT(*) FROM inventory_reservations"),
                    SplitLab.count(db, "SELECT COUNT(*) FROM inventory_ledger"));
        }
    }

    static String oneLine(String s) {
        if (s == null) return "";
        s = s.replace('\n', ' ');
        return s.length() > 300 ? s.substring(0, 300) + "…" : s;
    }

    static String root(Throwable t) {
        while (t.getCause() != null) t = t.getCause();
        return t.getClass().getSimpleName() + ": " + oneLine(t.getMessage());
    }

    static String root(IThrowableProxy t) {
        while (t.getCause() != null) t = t.getCause();
        return t.getClassName().substring(t.getClassName().lastIndexOf('.') + 1) + ": " + oneLine(t.getMessage());
    }
}
```

**`src/test/java/com/example/shop/dist02/Ops.java`**（2.5.3）

```java
package com.example.shop.dist02;

import com.example.shop.dist00.SplitLab;
import com.example.shop.payment.internal.CallbackSignature;
import com.example.shop.shared.config.ShopProperties;
import com.example.shop.shared.web.Role;
import com.example.shop.support.TestTokens;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.context.ConfigurableApplicationContext;

import java.math.BigDecimal;
import java.net.URI;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.Statement;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * 13 站 2.5.3、2.6.6：在切開的部署上，把一張訂單走到某個狀態（全部走 HTTP，跟真的客戶端一樣），以及「讓訂單服務的交易在遠端呼叫之後失敗」。
 *
 * 失敗的注入跟第 00 章 0.2.2 ① 一樣：訂單服務的庫上一個 trigger，寫訂單狀態歷史的那一句被拒絕 —— 遠端的庫存服務已經 commit 了，
 * 訂單服務的交易 rollback。要失敗的是哪一張、哪一個轉移，寫在 d02_fail 這張表（實驗自己建的，不是 migration）。
 */
final class Ops {

    static final long SELLER = SplitLab.SELLER;

    final ConfigurableApplicationContext order;
    final ObjectMapper json = new ObjectMapper();
    String last = "";

    Ops(ConfigurableApplicationContext order) { this.order = order; }

    // ───────── 注入失敗 ─────────

    void installTrigger() throws Exception {
        exec(Split.ORDER_DB, "CREATE TABLE d02_fail (buyer_id BIGINT NOT NULL, order_no VARCHAR(30) NOT NULL, to_status VARCHAR(20) NOT NULL)");
        exec(Split.ORDER_DB, """
                CREATE TRIGGER d02_fail_after_remote BEFORE INSERT ON order_status_history FOR EACH ROW
                BEGIN
                  IF EXISTS (SELECT 1 FROM d02_fail f JOIN orders o ON o.id = NEW.order_id
                              WHERE f.to_status = NEW.to_status AND (f.order_no = o.order_no OR f.buyer_id = o.buyer_id)) THEN
                    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'd02: injected failure after the remote inventory call';
                  END IF;
                END""");
    }

    /** buyer：這位買家的每一張訂單；orderNo：只有這一張。toStatus：轉移到這個狀態時失敗（PENDING_PAYMENT = 下單） */
    void fail(long buyer, String orderNo, String toStatus) throws Exception {
        try (Connection c = SplitLab.root(Split.ORDER_DB); PreparedStatement ps = c.prepareStatement("INSERT INTO d02_fail VALUES (?, ?, ?)")) {
            ps.setLong(1, buyer); ps.setString(2, orderNo == null ? "" : orderNo); ps.setString(3, toStatus);
            ps.executeUpdate();
        }
    }

    void unfail() throws Exception { exec(Split.ORDER_DB, "DELETE FROM d02_fail"); }

    // ───────── 一張訂單走到某個狀態 ─────────

    String place(long buyer, long... products) throws Exception {
        String[] no = new String[1];
        int s = placeStatus(buyer, UUID.randomUUID().toString(), no, products);
        if (s != 201) throw new IllegalStateException("下單 " + s + "：" + last);
        return no[0];
    }

    int placeStatus(long buyer, String key, String[] orderNo, long... products) throws Exception {
        List<Map<String, Object>> items = new ArrayList<>();
        for (long p : products) items.add(Map.of("productId", p, "quantity", 1, "unitPrice", new BigDecimal("100.00")));
        HttpResponse<String> r = send("POST", "/api/orders", bearer(buyer), Map.of("items", items), Map.of("Idempotency-Key", key));
        if (r.statusCode() == 201) orderNo[0] = json.readTree(r.body()).get("orderNo").asText();
        return r.statusCode();
    }

    /** 建立付款、算好簽章的金流回呼（還沒送） */
    Map<String, Object> callback(long buyer, String orderNo) throws Exception {
        HttpResponse<String> r = send("POST", "/api/orders/" + orderNo + "/payments", bearer(buyer), null, Map.of());
        JsonNode p = json.readTree(r.body());
        long paymentId = p.get("paymentId").asLong();
        BigDecimal amount = new BigDecimal(p.get("amount").asText());
        String txn = "d02-" + UUID.randomUUID();
        String secret = order.getBean(ShopProperties.class).payment().callbackSecret();
        return Map.of("paymentId", paymentId, "providerTxnId", txn, "amount", amount, "result", "SUCCEEDED",
                "signature", CallbackSignature.sign(secret, CallbackSignature.canonical(paymentId, txn, amount, true)));
    }

    String paid(long buyer, long product) throws Exception {
        String no = place(buyer, product);
        if (post("/api/payments/callback", null, callback(buyer, no)) != 200) throw new IllegalStateException("付款：" + last);
        return no;
    }

    String picking(long buyer, long product) throws Exception {
        String no = paid(buyer, product);
        if (post("/api/seller/orders/" + no + "/start-picking", seller(), null) != 200) throw new IllegalStateException("撿貨：" + last);
        return no;
    }

    // ───────── HTTP ─────────

    String bearer(long buyer) { return TestTokens.bearer(order, buyer); }
    String seller() { return TestTokens.bearer(order, SELLER, Role.SELLER); }

    int post(String path, String token, Object body) throws Exception {
        return send("POST", path, token, body, Map.of()).statusCode();
    }

    HttpResponse<String> send(String method, String path, String token, Object body, Map<String, String> headers) throws Exception {
        HttpRequest.Builder b = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + SplitLab.port(order) + path))
                .timeout(Duration.ofSeconds(30)).header("Content-Type", "application/json")
                .method(method, body == null ? HttpRequest.BodyPublishers.noBody() : HttpRequest.BodyPublishers.ofString(json.writeValueAsString(body)));
        if (token != null) b.header("Authorization", token);
        headers.forEach(b::header);
        HttpResponse<String> r = SplitLab.CLIENT.send(b.build(), HttpResponse.BodyHandlers.ofString());
        last = r.body().length() > 220 ? r.body().substring(0, 220) + "…" : r.body();
        return r;
    }

    static void exec(String db, String sql) throws Exception {
        try (Connection c = SplitLab.root(db); Statement st = c.createStatement()) { st.execute(sql); }
    }
}
```

**`src/test/java/com/example/shop/dist02/C2BrokenTransactionTest.java`**（2.5.3（實驗））

```java
package com.example.shop.dist02;

import com.example.shop.dist00.SplitLab;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.test.util.AopTestUtils;
import org.springframework.test.util.ReflectionTestUtils;

import java.io.PrintStream;
import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * 13 站 2.5.3：第 01 章說庫存這一刀切斷 7 種交易。切開之後，每一種都變成「庫存服務的交易（已經 commit）＋ 訂單服務的交易」。
 * 這裡讓訂單服務的交易在遠端呼叫「之後」失敗（Ops 的 trigger：寫訂單狀態歷史的那一句被拒絕），看兩個庫各剩下什麼；
 * 然後看下一步 —— 使用者再按一次、或者做了別的事 —— 會不會收斂。
 *
 *   mvn test -Pexperiments -Dtest=C2BrokenTransactionTest
 */
@Tag("experiment")
class C2BrokenTransactionTest {

    final PrintStream out = System.out;
    Ops ops;
    ConfigurableApplicationContext order;
    long nextProduct = SplitLab.FIRST_PRODUCT, nextBuyer = 820_001;

    @Test
    void brokenTransactions() throws Exception {
        Split.freshDatabases();
        try (ConfigurableApplicationContext inv = Split.inventoryService(Split.Schema.HONEST, Split.Remote.FULL, false);
             ConfigurableApplicationContext o = Split.orderService(Split.Schema.HONEST, Split.Remote.FULL, inv, false)) {
            order = o;
            ops = new Ops(o);
            SplitLab.seed(Split.ORDER_DB, true, false);                      // 商品在訂單服務（catalog 還在它身上）
            SplitLab.seed(Split.INV_DB, false, true);                        // 庫存在庫存服務
            Ops.exec(Split.INV_DB, "UPDATE inventory SET on_hand = 100");    // 數字小一點才看得出 ±1
            ops.installTrigger();
            out.printf("═══ 2.5.3 切斷的交易：庫存服務已經 commit，訂單服務的交易接著失敗（load %s）═══%n", SplitLab.load());
            out.println("  情境                         │ 回應 │ 訂單            │ 預留       │ 庫存 on_hand / reserved │ 付款 / 退款單");

            // ── 下單：reserve() 之後失敗（第 00 章的 K2）──
            long buyer = buyer(), p = product();
            String key = UUID.randomUUID().toString();
            ops.fail(buyer, null, "PENDING_PAYMENT");
            show("S1 下單", ops.placeStatus(buyer, key, new String[1], p), buyer, p);
            ops.unfail();
            show("   同一個鍵重送", ops.placeStatus(buyer, key, new String[1], p), buyer, p);

            // ── 付款回呼：confirm() 之後失敗 ──
            buyer = buyer(); p = product();
            String o2 = ops.place(buyer, p);
            Map<String, Object> cb = ops.callback(buyer, o2);
            ops.fail(0, o2, "PAID");
            show("S2 付款回呼", ops.post("/api/payments/callback", null, cb), buyer, p);
            ops.unfail();
            show("   金流重送同一個回呼", ops.post("/api/payments/callback", null, cb), buyer, p);

            // ── 買家取消（已付款）：release() 之後失敗 ──
            buyer = buyer(); p = product();
            String o3 = ops.paid(buyer, p);
            ops.fail(0, o3, "CANCELLED");
            show("S3 買家取消（已付款）", ops.post("/api/orders/" + o3 + "/cancel", ops.bearer(buyer), null), buyer, p);
            ops.unfail();
            show("   買家再按一次取消", ops.post("/api/orders/" + o3 + "/cancel", ops.bearer(buyer), null), buyer, p);

            buyer = buyer(); p = product();
            String o3b = ops.paid(buyer, p);
            ops.fail(0, o3b, "CANCELLED");
            show("S3' 買家取消（已付款）", ops.post("/api/orders/" + o3b + "/cancel", ops.bearer(buyer), null), buyer, p);
            ops.unfail();
            show("   賣家沒注意到，開始撿貨", ops.post("/api/seller/orders/" + o3b + "/start-picking", ops.seller(), null), buyer, p);
            show("   出貨", ops.post("/api/seller/orders/" + o3b + "/ship", ops.seller(), Map.of("carrier", "黑貓", "trackingNo", "C2-" + o3b)), buyer, p);
            out.println("      出貨的回應：" + ops.last);

            // ── 出貨：consume() 之後失敗 ──
            buyer = buyer(); p = product();
            String o4 = ops.picking(buyer, p);
            ops.fail(0, o4, "SHIPPED");
            show("S4 出貨", ops.post("/api/seller/orders/" + o4 + "/ship", ops.seller(), Map.of("carrier", "黑貓", "trackingNo", "C2-" + o4)), buyer, p);
            ops.unfail();
            show("   賣家再按一次出貨", ops.post("/api/seller/orders/" + o4 + "/ship", ops.seller(), Map.of("carrier", "黑貓", "trackingNo", "C2-" + o4)), buyer, p);

            buyer = buyer(); p = product();
            String o4b = ops.picking(buyer, p);
            ops.fail(0, o4b, "SHIPPED");
            show("S4' 出貨", ops.post("/api/seller/orders/" + o4b + "/ship", ops.seller(), Map.of("carrier", "黑貓", "trackingNo", "C2-" + o4b)), buyer, p);
            ops.unfail();
            show("   賣家以為沒出成，改成取消", ops.post("/api/seller/orders/" + o4b + "/cancel", ops.seller(), null), buyer, p);

            // ── 逾時排程：release() 之後失敗 ──
            buyer = buyer(); p = product();
            String o5 = ops.place(buyer, p);
            Ops.exec(Split.ORDER_DB, "UPDATE orders SET payment_deadline = NOW(3) - INTERVAL 1 MINUTE WHERE order_no = '" + o5 + "'");
            ops.fail(0, o5, "CANCELLED");
            cancelExpired();
            show("S5 逾時排程", 0, buyer, p);
            ops.unfail();
            cancelExpired();
            show("   排程的下一輪", 0, buyer, p);

            // ── 同一輪排程裡有兩張逾時的訂單，第一張失敗：第二張呢？──
            long b1 = buyer(), p1 = product(), b2 = buyer(), p2 = product();
            String first = ops.place(b1, p1), second = ops.place(b2, p2);
            Ops.exec(Split.ORDER_DB, "UPDATE orders SET payment_deadline = NOW(3) - INTERVAL 2 MINUTE WHERE order_no = '" + first + "'");
            Ops.exec(Split.ORDER_DB, "UPDATE orders SET payment_deadline = NOW(3) - INTERVAL 1 MINUTE WHERE order_no = '" + second + "'");
            ops.fail(0, first, "CANCELLED");
            ops.last = "";
            cancelExpired();
            show("S5' 逾時排程：第一張（失敗）", 0, b1, p1);
            show("    第二張（沒有注入失敗）", 0, b2, p2);
            if (!ops.last.isEmpty()) out.println("      " + ops.last);
            ops.unfail();
            out.printf("  （結束時 load %s）%n", SplitLab.load());
        }
    }

    long buyer() { return nextBuyer++; }
    long product() { return nextProduct++; }

    void cancelExpired() {
        Object jobs = AopTestUtils.getUltimateTargetObject(order.getBean("orderJobs"));
        try {
            ReflectionTestUtils.invokeMethod(jobs, "cancelExpired");
        } catch (Exception e) {
            ops.last = "排程丟出例外：" + C1SharedSchemaTest.root(e);
        }
    }

    /** 兩個庫各剩下什麼：這位買家的訂單、這個商品的預留與庫存、付款與退款單 */
    void show(String label, int status, long buyer, long product) throws Exception {
        String orders, reservations, inventory, payments;
        List<Long> ids = new ArrayList<>();
        try (Connection c = SplitLab.root(Split.ORDER_DB); Statement st = c.createStatement();
             ResultSet rs = st.executeQuery("SELECT id, status FROM orders WHERE buyer_id = " + buyer + " ORDER BY id")) {
            List<String> s = new ArrayList<>();
            while (rs.next()) { ids.add(rs.getLong(1)); s.add(rs.getString(2)); }
            orders = s.isEmpty() ? "（不存在）" : String.join(",", s);
        }
        try (Connection c = SplitLab.root(Split.ORDER_DB); Statement st = c.createStatement();
             ResultSet rs = st.executeQuery("""
                     SELECT (SELECT GROUP_CONCAT(p.status) FROM payments p JOIN orders o ON o.id = p.order_id WHERE o.buyer_id = %d),
                            (SELECT COUNT(*) FROM refunds r JOIN payments p ON p.id = r.payment_id JOIN orders o ON o.id = p.order_id WHERE o.buyer_id = %d)"""
                     .formatted(buyer, buyer))) {
            rs.next();
            payments = (rs.getString(1) == null ? "—" : rs.getString(1)) + " / " + rs.getInt(2);
        }
        try (Connection c = SplitLab.root(Split.INV_DB); Statement st = c.createStatement()) {
            try (ResultSet rs = st.executeQuery("SELECT order_id, status FROM inventory_reservations WHERE product_id = " + product + " ORDER BY id")) {
                List<String> r = new ArrayList<>();
                while (rs.next()) r.add(rs.getString(2) + (ids.contains(rs.getLong(1)) ? "" : "（沒有訂單）"));
                reservations = r.isEmpty() ? "（沒有）" : String.join(",", r);
            }
            try (ResultSet rs = st.executeQuery("SELECT on_hand, reserved FROM inventory WHERE product_id = " + product)) {
                rs.next();
                inventory = rs.getInt(1) + " / " + rs.getInt(2);
            }
        }
        out.printf("  %-28s │ %4s │ %-15s │ %-10s │ %-23s │ %s%n", label, status == 0 ? "—" : String.valueOf(status), orders, reservations, inventory, payments);
    }
}
```

**`src/test/java/com/example/shop/dist02/C3ReconciliationTest.java`**（2.6.6（實驗））

```java
package com.example.shop.dist02;

import com.example.shop.dist00.SplitLab;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.test.util.ReflectionTestUtils;

import java.io.PrintStream;
import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.Statement;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 13 站 2.6.6：預留 ⇄ 訂單的對帳（ReservationReconciliation，ordering 模組），跑在切開的部署上。
 *
 *   ① 對不對：做出第 2.5.3 節的那幾種不一致（K2 式的 100 張下單失敗、S2、S3'、S4），讓對帳去找；
 *      標準答案用跨庫 JOIN 算 —— 兩個庫剛好在同一台 MySQL 上才寫得出來，真的拆開之後它不存在
 *   ② 多貴：10 萬張訂單、30 萬筆預留（第 12 站種子資料的規模），一輪對帳要多久、問了對方幾次
 *
 *   mvn test -Pexperiments -Dtest=C3ReconciliationTest
 */
@Tag("experiment")
class C3ReconciliationTest {

    static final String INV = Split.INV_DB, ORD = Split.ORDER_DB;
    final PrintStream out = System.out;

    @Test
    void reconciliation() throws Exception {
        correctness();
        scale();
        out.printf("  （結束時 load %s）%n", SplitLab.load());
    }

    void correctness() throws Exception {
        Split.freshDatabases();
        try (ConfigurableApplicationContext inv = Split.inventoryService(Split.Schema.HONEST, Split.Remote.FULL, false);
             ConfigurableApplicationContext order = Split.orderService(Split.Schema.HONEST, Split.Remote.FULL, inv, false)) {
            Ops ops = new Ops(order);
            SplitLab.seed(ORD, true, false);
            SplitLab.seed(INV, false, true);
            ops.installTrigger();
            out.printf("═══ 2.6.6 ① 對帳在切開的部署裡：找得到第 2.5.3 節的不一致嗎（load %s）═══%n", SplitLab.load());
            long p = SplitLab.FIRST_PRODUCT;
            for (int i = 0; i < 50; i++) ops.place(830_000 + i, p + i * 3, p + i * 3 + 1);          // 一般的訂單：不應該被報出來
            ops.fail(777_777, null, "PENDING_PAYMENT");
            int failed = 0;
            for (int i = 0; i < 100; i++)
                if (ops.placeStatus(777_777, java.util.UUID.randomUUID().toString(), new String[1], p + 300 + i * 3, p + 301 + i * 3, p + 302 + i * 3) == 500) failed++;
            ops.unfail();
            String s2 = ops.place(830_101, p + 700);                         // S2：付款回呼只做了一半
            var cb = ops.callback(830_101, s2);
            ops.fail(0, s2, "PAID");
            ops.post("/api/payments/callback", null, cb);
            ops.unfail();
            String s3 = ops.paid(830_102, p + 701);                          // S3'：已付款的取消只做了一半，之後沒人管
            ops.fail(0, s3, "CANCELLED");
            ops.post("/api/orders/" + s3 + "/cancel", ops.bearer(830_102), null);
            ops.unfail();
            String s4 = ops.picking(830_103, p + 702);                       // S4：出貨只做了一半
            ops.fail(0, s4, "SHIPPED");
            ops.post("/api/seller/orders/" + s4 + "/ship", ops.seller(), java.util.Map.of("carrier", "黑貓", "trackingNo", "C3-" + s4));
            ops.unfail();
            out.printf("  做出來的：一般的訂單 50 張；下單失敗 %d 張（各 3 個品項）；S2、S3'、S4 各 1 張%n", failed);

            Thread.sleep(3000);                                               // grace 2 秒：剛剛那些都要「夠舊」
            Map<String, Long> truth = truth(2);
            out.println("  跨庫 JOIN（標準答案）：" + truth);
            long reservedBefore = SplitLab.count(INV, "SELECT SUM(reserved) FROM inventory");

            Object rec = order.getBean("reservationReconciliation");
            Object r = ReflectionTestUtils.invokeMethod(rec, "run", Duration.ofSeconds(2));
            Map<String, Long> found = counts(r);
            out.printf("  對帳（grace 2 秒）：掃了 %s 筆預留、%s 張訂單，%s 批（%s ms：① %s ms、② %s ms）→ %s；釋放 %s 張%n",
                    get(r, "reservationsScanned"), get(r, "ordersScanned"), get(r, "batches"), get(r, "millis"),
                    get(r, "inventorySideMillis"), get(r, "orderSideMillis"), found, get(r, "released"));
            long reservedAfter = SplitLab.count(INV, "SELECT SUM(reserved) FROM inventory");
            out.printf("  釋放之後：庫存的 reserved 合計 %,d → %,d（少了 %d 件）%n", reservedBefore, reservedAfter, reservedBefore - reservedAfter);
            Map<String, Long> again = counts(ReflectionTestUtils.invokeMethod(rec, "run", Duration.ofSeconds(2)));
            out.println("  再跑一次：" + again + "；跨庫 JOIN：" + truth(2));
            assertThat(found).isEqualTo(truth);
        }
    }

    void scale() throws Exception {
        Split.freshDatabases();
        try (ConfigurableApplicationContext inv = Split.inventoryService(Split.Schema.HONEST, Split.Remote.FULL, false);
             ConfigurableApplicationContext order = Split.orderService(Split.Schema.HONEST, Split.Remote.FULL, inv, false)) {
            long t0 = System.nanoTime();
            SplitLab.seed(INV, false, true);
            try (Connection c = SplitLab.root(ORD); Statement st = c.createStatement()) {
                st.execute("SET SESSION cte_max_recursion_depth = 1000000");
                // 1% 待付款、2% 已付款、97% 已完成（第 12 站的種子資料大多是已完成的舊訂單）；一天前建立
                st.execute("""
                        INSERT INTO orders (id, order_no, buyer_id, seller_id, status, total_amount, payment_deadline, carrier, tracking_no,
                                            paid_at, shipped_at, completed_at, created_at, updated_at)
                        WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 100000)
                        SELECT i, CONCAT('20990101-', LPAD(i, 6, '0')), 800000 + i % 5000, 900001,
                               CASE WHEN i % 100 = 0 THEN 'PENDING_PAYMENT' WHEN i % 100 IN (1, 2) THEN 'PAID' ELSE 'COMPLETED' END,
                               300, NOW(3) + INTERVAL 15 MINUTE,
                               IF(i % 100 > 2, '黑貓', NULL), IF(i % 100 > 2, CONCAT('T', i), NULL),
                               IF(i % 100 > 0, NOW(3) - INTERVAL 1 DAY, NULL), IF(i % 100 > 2, NOW(3) - INTERVAL 1 DAY, NULL),
                               IF(i % 100 > 2, NOW(3) - INTERVAL 1 DAY, NULL), NOW(3) - INTERVAL 1 DAY, NOW(3) - INTERVAL 1 DAY
                          FROM n""");
            }
            try (Connection c = SplitLab.root(INV); Statement st = c.createStatement()) {
                st.execute("SET SESSION cte_max_recursion_depth = 1000000");
                st.execute("""
                        INSERT INTO inventory_reservations (order_id, product_id, quantity, status, created_at, updated_at)
                        WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 100000)
                        SELECT i, %d + (i * 3 + k.k) %% 1000, 1,
                               CASE WHEN i %% 100 = 0 THEN 'HELD' WHEN i %% 100 IN (1, 2) THEN 'CONFIRMED' ELSE 'CONSUMED' END,
                               NOW(3) - INTERVAL 1 DAY, NOW(3) - INTERVAL 1 DAY
                          FROM n CROSS JOIN (SELECT 0 AS k UNION ALL SELECT 1 UNION ALL SELECT 2) k ORDER BY i, k.k""".formatted(SplitLab.FIRST_PRODUCT));
                st.execute("ANALYZE TABLE inventory_reservations");
            }
            try (Connection c = SplitLab.root(ORD); Statement st = c.createStatement()) { st.execute("ANALYZE TABLE orders"); }
            out.printf("═══ 2.6.6 ② 多貴：10 萬張訂單、30 萬筆預留（灌資料 %.1f 秒；load %s）═══%n", (System.nanoTime() - t0) / 1e9, SplitLab.load());
            out.printf("  還佔著庫存的預留 %,d 筆、還沒結束的訂單 %,d 張%n",
                    SplitLab.count(INV, "SELECT COUNT(*) FROM inventory_reservations WHERE status IN ('HELD', 'CONFIRMED')"),
                    SplitLab.count(ORD, "SELECT COUNT(*) FROM orders WHERE status IN ('PENDING_PAYMENT', 'PAID', 'PICKING')"));

            Object rec = order.getBean("reservationReconciliation");
            for (int i = 1; i <= 3; i++) {
                Object r = ReflectionTestUtils.invokeMethod(rec, "run", Duration.ofMinutes(5));
                out.printf("  第 %d 輪：掃了 %s 筆預留、%s 張訂單，%s 批（%s ms：① 庫存那一邊 %s ms、② 訂單那一邊 %s ms）→ 找到 %s%n", i,
                        get(r, "reservationsScanned"), get(r, "ordersScanned"), get(r, "batches"), get(r, "millis"),
                        get(r, "inventorySideMillis"), get(r, "orderSideMillis"), counts(r));
            }
            explain(INV, "SELECT id, order_id, product_id, quantity, status FROM inventory_reservations WHERE id > 0 AND status IN ('HELD', 'CONFIRMED') AND created_at < NOW(3) - INTERVAL 5 MINUTE ORDER BY id LIMIT 500");
            explain(ORD, "SELECT id, status FROM orders WHERE id > 0 AND status IN ('PENDING_PAYMENT', 'PAID', 'PICKING') AND updated_at < NOW(3) - INTERVAL 5 MINUTE ORDER BY id LIMIT 500");
            long j0 = System.nanoTime();
            Map<String, Long> truth = truth(300);
            out.printf("  對照：跨庫 JOIN 算同一件事 %.0f ms → %s%n", (System.nanoTime() - j0) / 1e6, truth);
        }
    }

    // ───────── 標準答案：跨庫 JOIN（只有實驗裡寫得出來）─────────

    Map<String, Long> truth(int graceSeconds) throws Exception {
        String r = INV + ".inventory_reservations", o = ORD + ".orders";
        String cutR = "r.created_at < NOW(3) - INTERVAL " + graceSeconds + " SECOND", cutO = "o.updated_at < NOW(3) - INTERVAL " + graceSeconds + " SECOND";
        Map<String, Long> m = new LinkedHashMap<>();
        m.put("X-1", SplitLab.count("", "SELECT COUNT(DISTINCT r.order_id) FROM " + r + " r LEFT JOIN " + o + " o ON o.id = r.order_id WHERE r.status IN ('HELD', 'CONFIRMED') AND " + cutR + " AND o.id IS NULL"));
        m.put("X-2", SplitLab.count("", "SELECT COUNT(DISTINCT r.order_id) FROM " + r + " r JOIN " + o + " o ON o.id = r.order_id WHERE r.status IN ('HELD', 'CONFIRMED') AND " + cutR + " AND o.status = 'CANCELLED'"));
        String live = "o.status IN ('PENDING_PAYMENT', 'PAID', 'PICKING') AND " + cutO;
        String x3 = "(NOT EXISTS (SELECT 1 FROM " + r + " r WHERE r.order_id = o.id) OR EXISTS (SELECT 1 FROM " + r + " r WHERE r.order_id = o.id AND r.status = 'RELEASED'))";
        m.put("X-3", SplitLab.count("", "SELECT COUNT(*) FROM " + o + " o WHERE " + live + " AND " + x3));
        m.put("X-4", SplitLab.count("", "SELECT COUNT(*) FROM " + o + " o WHERE " + live + " AND NOT " + x3
                + " AND EXISTS (SELECT 1 FROM " + r + " r WHERE r.order_id = o.id AND r.status = 'CONSUMED')"));
        m.put("X-5", SplitLab.count("", "SELECT COUNT(DISTINCT o.id) FROM " + o + " o JOIN " + r + " r ON r.order_id = o.id WHERE "
                + "(o.status = 'PENDING_PAYMENT' AND r.status = 'CONFIRMED' AND " + cutR + ")"
                + " OR (o.status IN ('SHIPPED', 'COMPLETED') AND r.status IN ('HELD', 'CONFIRMED') AND " + cutR + ")"
                + " OR (o.status IN ('PAID', 'PICKING') AND " + cutO + " AND r.status = 'HELD' AND NOT EXISTS (SELECT 1 FROM " + r
                + " r2 WHERE r2.order_id = o.id AND r2.status IN ('RELEASED', 'CONSUMED')))"));
        return m;
    }

    // ───────── 讀 Result（ordering.internal 的 package-private record）─────────

    static Object get(Object result, String accessor) { return ReflectionTestUtils.invokeMethod(result, accessor); }

    static Map<String, Long> counts(Object result) {
        Map<String, Long> m = new TreeMap<>();
        for (String c : List.of("X-1", "X-2", "X-3", "X-4", "X-5")) m.put(c, 0L);
        List<?> findings = ReflectionTestUtils.invokeMethod(result, "findings");
        for (Object f : findings) {
            Object check = ReflectionTestUtils.invokeMethod(f, "check");
            m.merge(ReflectionTestUtils.invokeMethod(check, "id"), 1L, Long::sum);
        }
        return new LinkedHashMap<>(m);
    }

    void explain(String db, String sql) throws Exception {
        try (Connection c = SplitLab.root(db); Statement st = c.createStatement(); ResultSet rs = st.executeQuery("EXPLAIN " + sql)) {
            List<String> rows = new ArrayList<>();
            while (rs.next())
                rows.add("type=%s key=%s rows=%s filtered=%s Extra=%s".formatted(rs.getString("type"), rs.getString("key"), rs.getString("rows"),
                        rs.getString("filtered"), rs.getString("Extra")));
            out.printf("  EXPLAIN（%s）%s%n", db, rows);
        }
    }
}
```

**`src/test/java/com/example/shop/dist02/Copier.java`**（2.8）

```java
package com.example.shop.dist02;

import com.example.shop.dist00.SplitLab;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * 13 站 2.8：把庫存的五張表，從舊的資料庫（單體的）搬到新的資料庫（庫存服務的）。兩條連線，一條讀舊的、一條寫新的 ——
 * 實驗裡兩個庫在同一台 MySQL 上，但這裡不用跨庫的 INSERT … SELECT：真的搬家時它們在兩台機器上，那句 SQL 不存在。
 *
 *   backfill(t)：照主鍵的順序一批一批讀出來，寫進新的庫。寫的是「整列的值」（包括 id），已經有就整列蓋掉 —— 重做幾次結果都一樣
 *   apply()    ：讀舊庫的變更紀錄（d02_changes，trigger 寫的：哪張表、哪一個主鍵），每一個主鍵「再讀一次舊庫現在的那一列」寫進新的庫；
 *                舊庫已經沒有那一列就刪掉。不重播 SQL、不重播「+1」，只複製最新的值 —— 所以順序、重複都不影響結果（2.8.4）。
 *                ⚠️ 變更紀錄的號碼不是 commit 的順序：見 holes
 *   checksum(db, t)：列數與每一列內容的 CRC32 加總。兩邊一樣 = 內容一樣（加總跟列的順序無關）
 */
final class Copier {

    /** 庫存模組的五張表與主鍵。順序：先父表（外鍵） */
    static final Map<String, String> TABLES = new LinkedHashMap<>();
    static {
        TABLES.put("inventory", "product_id");
        TABLES.put("inventory_reservations", "id");
        TABLES.put("inventory_ledger", "id");
        TABLES.put("inventory_ledger_checkpoints", "product_id");
        TABLES.put("inventory_ledger_watermark", "id");
    }

    static final int BATCH = 2_000;

    final String from, to;
    final Map<String, List<String>> columns = new LinkedHashMap<>();
    volatile boolean targetDown = false;                                    // 2.8：「新的庫連不上」—— 這一段時間寫不進去，等它回來
    long retries = 0;

    /**
     * 2.8.4 ⚠️ 第一版的 bug：變更紀錄的 seq 是 AUTO_INCREMENT —— 號碼在 trigger INSERT 的那一刻就發了，那一列卻要等它的交易 commit 才看得到。
     * 號碼小的交易可以比號碼大的晚 commit：讀到 101 的時候，100 可能還在路上。第一版直接記「讀到 101 了」，100 就永遠被跳過
     * （第 12 站 9.12 J11b 的同一個錯：水位線越過了還沒 commit 的那一列）。
     * 所以記下「洞」：比 maxSeen 小、還沒看到的號碼，每一輪再問一次。過了 HOLE_TTL 還沒出現 → 那個交易 rollback 了（號碼不會還回去）
     */
    static final long HOLE_TTL_MS = 60_000;                                 // > innodb_lock_wait_timeout（50 秒）：拿到號碼之後，交易最久還要等這麼久才 commit
    long maxSeen = 0;
    final Map<Long, Long> holes = new LinkedHashMap<>();                    // seq → 第一次發現它是洞的時間
    long holesFound, holesFilled, holesExpired;

    Copier(String from, String to) throws Exception {
        this.from = from;
        this.to = to;
        try (Connection c = SplitLab.root(from); PreparedStatement ps = c.prepareStatement(
                "SELECT column_name FROM information_schema.columns WHERE table_schema = ? AND table_name = ? ORDER BY ordinal_position")) {
            for (String t : TABLES.keySet()) {
                ps.setString(1, from); ps.setString(2, t);
                List<String> cols = new ArrayList<>();
                try (ResultSet rs = ps.executeQuery()) { while (rs.next()) cols.add(rs.getString(1)); }
                columns.put(t, cols);
            }
        }
    }

    /** 一張表整張複製過去。回傳複製了幾列 */
    long backfill(String table) throws Exception { return backfill(table, true); }

    /**
     * overwrite = false：新的庫已經有的那一列不動（INSERT IGNORE）—— 2.8.3 雙寫時常見的回填寫法：「雙寫寫進去的比較新，不要蓋掉它」
     */
    long backfill(String table, boolean overwrite) throws Exception {
        String pk = TABLES.get(table);
        List<String> cols = columns.get(table);
        long after = Long.MIN_VALUE, copied = 0;
        try (Connection src = SplitLab.root(from); Connection dst = target()) {
            while (true) {
                List<Object[]> rows = new ArrayList<>();
                try (PreparedStatement ps = src.prepareStatement("SELECT " + String.join(", ", cols) + " FROM " + table + " WHERE " + pk + " > ? ORDER BY " + pk + " LIMIT " + BATCH)) {
                    ps.setLong(1, after);
                    try (ResultSet rs = ps.executeQuery()) {
                        while (rs.next()) {
                            Object[] r = new Object[cols.size()];
                            for (int i = 0; i < r.length; i++) r[i] = rs.getObject(i + 1);
                            rows.add(r);
                        }
                    }
                }
                if (rows.isEmpty()) return copied;
                try {
                    if (overwrite) upsert(dst, table, rows); else insertIgnore(dst, table, rows);
                } catch (java.sql.SQLTransientConnectionException down) {
                    // 2.8.4 第一版沒有這一段：新的庫在回填途中斷線，搬家程式整個停了。回填要能從「上一批」接著做 —— 這一批重來（整列蓋掉，重做無妨）
                    retries++;
                    Thread.sleep(100);
                    continue;
                }
                copied += rows.size();
                after = ((Number) rows.get(rows.size() - 1)[cols.indexOf(pk)]).longValue();
            }
        }
    }

    /** 套用變更紀錄：seq > maxSeen 的新紀錄，加上之前的洞裡後來才 commit 的。回傳這一輪處理了幾筆紀錄（0 = 追上了） */
    int apply() throws Exception {
        List<long[]> changes = new ArrayList<>();
        List<String> tables = new ArrayList<>();
        try (Connection src = SplitLab.root(from)) {
            try (PreparedStatement ps = src.prepareStatement("SELECT seq, tbl, pk FROM d02_changes WHERE seq > ? ORDER BY seq LIMIT 5000")) {
                ps.setLong(1, maxSeen);
                try (ResultSet rs = ps.executeQuery()) {
                    while (rs.next()) { changes.add(new long[]{rs.getLong(1), rs.getLong(3)}); tables.add(rs.getString(2)); }
                }
            }
            if (!holes.isEmpty())
                try (PreparedStatement ps = src.prepareStatement("SELECT seq, tbl, pk FROM d02_changes WHERE seq IN ("
                        + String.join(",", holes.keySet().stream().map(String::valueOf).toList()) + ")")) {
                    try (ResultSet rs = ps.executeQuery()) {
                        while (rs.next()) { changes.add(new long[]{rs.getLong(1), rs.getLong(3)}); tables.add(rs.getString(2)); }
                    }
                }
        }
        long now = System.currentTimeMillis();
        for (long[] c : changes) {
            long seq = c[0];
            if (holes.remove(seq) != null) { holesFilled++; continue; }   // 洞補上了：那個交易後來 commit 了
            if (seq > maxSeen) {
                for (long h = maxSeen + 1; h < seq; h++) { holes.put(h, now); holesFound++; }
                maxSeen = seq;
            }
        }
        holes.entrySet().removeIf(e -> {                                    // 太久沒出現：rollback 了
            if (now - e.getValue() <= HOLE_TTL_MS) return false;
            holesExpired++;
            return true;
        });
        if (changes.isEmpty()) return 0;
        Map<String, Set<Long>> touched = new LinkedHashMap<>();
        for (int i = 0; i < changes.size(); i++) touched.computeIfAbsent(tables.get(i), k -> new LinkedHashSet<>()).add(changes.get(i)[1]);
        try (Connection src = SplitLab.root(from); Connection dst = target()) {
            for (String table : TABLES.keySet()) {                          // 父表先
                Set<Long> pks = touched.get(table);
                if (pks == null) continue;
                String pk = TABLES.get(table);
                List<String> cols = columns.get(table);
                List<Object[]> present = new ArrayList<>();
                Set<Long> gone = new LinkedHashSet<>(pks);
                String in = String.join(",", pks.stream().map(x -> "?").toList());
                try (PreparedStatement ps = src.prepareStatement("SELECT " + String.join(", ", cols) + " FROM " + table + " WHERE " + pk + " IN (" + in + ")")) {
                    int i = 1;
                    for (long id : pks) ps.setLong(i++, id);
                    try (ResultSet rs = ps.executeQuery()) {
                        while (rs.next()) {
                            Object[] r = new Object[cols.size()];
                            for (int j = 0; j < r.length; j++) r[j] = rs.getObject(j + 1);
                            present.add(r);
                            gone.remove(((Number) r[cols.indexOf(pk)]).longValue());
                        }
                    }
                }
                if (!present.isEmpty()) upsert(dst, table, present);
                checkTarget();
                if (!gone.isEmpty())
                    try (PreparedStatement del = dst.prepareStatement("DELETE FROM " + table + " WHERE " + pk + " = ?")) {
                        for (long id : gone) { del.setLong(1, id); del.addBatch(); }
                        del.executeBatch();
                    }
            }
            dst.commit();
        }
        return changes.size();
    }

    /** 停寫、確認舊庫上沒有進行中的交易之後：剩下的洞都是 rollback（不會再有人 commit 它們）。回傳關掉幾個 */
    int closeHoles() {
        int n = holes.size();
        holesExpired += n;
        holes.clear();
        return n;
    }

    /** 新的庫：整批寫完才 commit；外鍵檢查關掉（搬家的時候子表可能比父表先到 —— 一般的搬資料工具也是這樣做） */
    private Connection target() throws Exception {
        checkTarget();
        Connection c = SplitLab.root(to);
        c.setAutoCommit(false);
        try (Statement st = c.createStatement()) { st.execute("SET SESSION foreign_key_checks = 0"); }
        return c;
    }

    private void checkTarget() throws java.sql.SQLTransientConnectionException {
        if (targetDown) throw new java.sql.SQLTransientConnectionException("新的庫連不上（實驗模擬）");
    }

    private void upsert(Connection dst, String table, List<Object[]> rows) throws Exception {
        checkTarget();
        List<String> cols = columns.get(table);
        String sql = "INSERT INTO " + table + " (" + String.join(", ", cols) + ") VALUES (" + String.join(", ", cols.stream().map(x -> "?").toList())
                + ") AS new ON DUPLICATE KEY UPDATE " + String.join(", ", cols.stream().map(x -> x + " = new." + x).toList());
        try (PreparedStatement ps = dst.prepareStatement(sql)) {
            for (Object[] r : rows) {
                for (int i = 0; i < r.length; i++) ps.setObject(i + 1, r[i]);
                ps.addBatch();
            }
            ps.executeBatch();
        }
        dst.commit();
    }

    private void insertIgnore(Connection dst, String table, List<Object[]> rows) throws Exception {
        checkTarget();
        List<String> cols = columns.get(table);
        try (PreparedStatement ps = dst.prepareStatement("INSERT IGNORE INTO " + table + " (" + String.join(", ", cols) + ") VALUES ("
                + String.join(", ", cols.stream().map(x -> "?").toList()) + ")")) {
            for (Object[] r : rows) {
                for (int i = 0; i < r.length; i++) ps.setObject(i + 1, r[i]);
                ps.addBatch();
            }
            ps.executeBatch();
        }
        dst.commit();
    }

    /** 新的庫的五張表清空（每一種做法從零開始） */
    void truncateTarget() throws Exception {
        try (Connection c = SplitLab.root(to); Statement st = c.createStatement()) {
            st.execute("SET SESSION foreign_key_checks = 0");
            for (String t : TABLES.keySet()) st.execute("TRUNCATE TABLE " + t);
        }
    }

    /** 2.8.4：舊的庫上，每一張表的每一種寫入都記一筆「哪張表、哪一個主鍵」—— 跟那一筆寫入在同一個交易裡 */
    void installCapture() throws Exception {
        try (Connection c = SplitLab.root(from); Statement st = c.createStatement()) {
            st.execute("""
                    CREATE TABLE d02_changes (seq BIGINT NOT NULL AUTO_INCREMENT, tbl VARCHAR(40) NOT NULL, pk BIGINT NOT NULL,
                                              at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), PRIMARY KEY (seq))""");
        }
        installTriggers();
    }

    void installTriggers() throws Exception {
        try (Connection c = SplitLab.root(from); Statement st = c.createStatement()) {
            for (var e : TABLES.entrySet())
                for (String op : List.of("INSERT", "UPDATE", "DELETE"))
                    st.execute("CREATE TRIGGER d02_cdc_%s_%s AFTER %s ON %s FOR EACH ROW INSERT INTO d02_changes (tbl, pk) VALUES ('%s', %s.%s)"
                            .formatted(e.getKey(), op.toLowerCase().substring(0, 3), op, e.getKey(), e.getKey(), op.equals("DELETE") ? "OLD" : "NEW", e.getValue()));
        }
    }

    void dropCapture() throws Exception {
        dropTriggers();
        try (Connection c = SplitLab.root(from); Statement st = c.createStatement()) { st.execute("DROP TABLE IF EXISTS d02_changes"); }
    }

    void dropTriggers() throws Exception {
        try (Connection c = SplitLab.root(from); Statement st = c.createStatement()) {
            for (String t : TABLES.keySet())
                for (String op : List.of("ins", "upd", "del")) st.execute("DROP TRIGGER IF EXISTS d02_cdc_" + t + "_" + op);
        }
    }

    /** 變更紀錄裡還沒讀到的有幾筆（不含洞） */
    long lag() throws Exception {
        return SplitLab.count(from, "SELECT COUNT(*) FROM d02_changes WHERE seq > " + maxSeen);
    }

    /** 列數、內容的 CRC32 加總 */
    String checksum(String db, String table) throws Exception {
        String row = "CONCAT_WS('|', " + String.join(", ", columns.get(table).stream().map(c -> "IFNULL(" + c + ", '∅')").toList()) + ")";
        try (Connection c = SplitLab.root(db); Statement st = c.createStatement();
             ResultSet rs = st.executeQuery("SELECT COUNT(*), COALESCE(SUM(CRC32(" + row + ")), 0) FROM " + table)) {
            rs.next();
            return rs.getLong(1) + "/" + rs.getLong(2);
        }
    }

    /** 每一張表兩邊都一樣？回傳不一樣的那幾張（空 = 全部一樣） */
    Map<String, String> differences() throws Exception {
        Map<String, String> d = new LinkedHashMap<>();
        for (String t : TABLES.keySet()) {
            String a = checksum(from, t), b = checksum(to, t);
            if (!a.equals(b)) d.put(t, "舊 " + a + " ≠ 新 " + b);
        }
        return d;
    }

    /**
     * 實驗才算得出來的逐列比對（兩個庫剛好在同一台 MySQL 上）：只在舊庫、只在新庫、兩邊都有但內容不同。
     * 真的搬家時用 checksum —— 它只說「不一樣」，不說哪裡不一樣；要找出哪幾列，就再把範圍切小（依主鍵分段算 checksum）
     */
    Map<String, long[]> rowDiff() throws Exception {
        Map<String, long[]> m = new LinkedHashMap<>();
        for (String t : TABLES.keySet()) {
            String pk = TABLES.get(t);
            String row = "CONCAT_WS('|', " + String.join(", ", columns.get(t).stream().map(c -> "IFNULL(x." + c + ", '∅')").toList()) + ")";
            String a = from + "." + t, b = to + "." + t;
            long onlyOld = SplitLab.count("", "SELECT COUNT(*) FROM " + a + " x LEFT JOIN " + b + " y ON y." + pk + " = x." + pk + " WHERE y." + pk + " IS NULL");
            long onlyNew = SplitLab.count("", "SELECT COUNT(*) FROM " + b + " x LEFT JOIN " + a + " y ON y." + pk + " = x." + pk + " WHERE y." + pk + " IS NULL");
            long differ = SplitLab.count("", "SELECT COUNT(*) FROM " + a + " x JOIN " + b + " y ON y." + pk + " = x." + pk
                    + " WHERE CRC32(" + row + ") <> CRC32(" + row.replace("x.", "y.") + ")");
            m.put(t, new long[]{onlyOld, onlyNew, differ});
        }
        return m;
    }
}
```

**`src/test/java/com/example/shop/dist02/DualWriteTap.java`**（2.8.3）

```java
package com.example.shop.dist02;

import com.example.shop.dist00.SplitLab;
import com.mysql.cj.MysqlConnection;
import com.mysql.cj.Query;
import com.mysql.cj.interceptors.QueryInterceptor;
import com.mysql.cj.log.Log;
import com.mysql.cj.protocol.Resultset;
import com.mysql.cj.protocol.ServerSession;

import java.sql.Connection;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Properties;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.Supplier;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 13 站 2.8.3：「應用程式雙寫」—— 最常見的搬家寫法，也是這一節要量的那一種。
 * 單體照舊寫舊的庫；每一個交易 commit 之後，把它寫進庫存五張表的那幾句 SQL，原封不動在新的庫再執行一次（同一條執行緒、自己一個交易）。
 * 新的庫寫失敗 → 記下來、不影響使用者（舊的庫才是正本 —— 雙寫的人通常都這樣決定，不然新的庫一掛，單體也跟著掛）。
 *
 * 做在 JDBC 驅動這一層（跟第 01 章的 SqlTap 同一個掛勾）：不用改任何一行正式程式碼，而且所有的寫都抓得到 ——
 * 包括事件的消費者、排程，那些不經過 InventoryApi 的寫。寫在 service 那一層的雙寫，常常漏掉它們。
 */
public class DualWriteTap implements QueryInterceptor {

    public static volatile boolean enabled = false;
    /** 新的庫「連不上」：這段時間的寫全部失敗（2.8.3 模擬兩秒） */
    public static volatile boolean down = false;
    public static volatile String target = "";

    public static final AtomicLong txReplayed = new AtomicLong(), txFailed = new AtomicLong(), stmtsLost = new AtomicLong();
    public static final Map<String, AtomicLong> errors = new ConcurrentHashMap<>();

    public static void reset() {
        txReplayed.set(0); txFailed.set(0); stmtsLost.set(0); errors.clear();
    }

    private static final Pattern WRITE = Pattern.compile(
            "(?is)^\\s*(?:insert\\s+(?:ignore\\s+)?into|replace\\s+into|update|delete\\s+(?:\\w+\\s+)?from)\\s+`?(\\w+)`?");

    private java.sql.Connection conn;
    private final List<String> pending = new ArrayList<>();
    private static final ThreadLocal<Connection> NEW = new ThreadLocal<>();

    @Override
    public QueryInterceptor init(MysqlConnection c, Properties props, Log log) {
        this.conn = (java.sql.Connection) c;
        return this;
    }

    @Override
    public <T extends Resultset> T preProcess(Supplier<String> sql, Query query) {
        String s = sql.get();
        if (s == null) return null;
        String t = s.strip();
        if (t.equalsIgnoreCase("rollback")) { pending.clear(); return null; }
        if (!enabled) return null;
        Matcher w = WRITE.matcher(t);
        if (w.find() && Copier.TABLES.containsKey(w.group(1).toLowerCase())) pending.add(t);
        return null;
    }

    @Override
    public <T extends Resultset> T postProcess(Supplier<String> sql, Query query, T originalResultSet, ServerSession serverSession) {
        String s = sql.get();
        if (s == null || pending.isEmpty()) return null;
        boolean commit = s.strip().equalsIgnoreCase("commit");
        boolean auto;
        try { auto = conn.getAutoCommit(); } catch (Exception e) { auto = false; }
        if (commit || auto) {                                                 // 舊的庫 commit 了（或者沒有交易、一句就是一個交易）
            List<String> batch = new ArrayList<>(pending);
            pending.clear();
            replay(batch);
        }
        return null;
    }

    static void replay(List<String> batch) {
        if (down) { fail(batch, "新的庫連不上"); return; }
        try {
            Connection c = NEW.get();
            if (c == null || c.isClosed()) {
                c = SplitLab.root(target);
                c.setAutoCommit(false);
                NEW.set(c);
            }
            try (Statement st = c.createStatement()) {
                for (String q : batch) st.execute(q);
                c.commit();
                txReplayed.incrementAndGet();
            } catch (Exception e) {
                c.rollback();
                fail(batch, e.getMessage());
            }
        } catch (Exception e) {
            fail(batch, e.getMessage());
        }
    }

    static void fail(List<String> batch, String why) {
        txFailed.incrementAndGet();
        stmtsLost.addAndGet(batch.size());
        String key = why == null ? "?" : why.replaceAll("\\d+", "N");
        errors.computeIfAbsent(key.length() > 120 ? key.substring(0, 120) : key, k -> new AtomicLong()).incrementAndGet();
    }

    @Override
    public boolean executeTopLevelOnly() { return true; }

    @Override
    public void destroy() {}
}
```

**`src/test/java/com/example/shop/dist02/Load.java`**（2.8）

```java
package com.example.shop.dist02;

import com.example.shop.dist00.SplitLab;
import org.springframework.context.ConfigurableApplicationContext;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ThreadLocalRandom;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;

/**
 * 13 站 2.8：搬家期間，單體照常營業。threads 條執行緒不停地：下一張 3 個品項的訂單，然後三分之一取消、三分之一付款、三分之一放著 ——
 * 庫存的五張表裡，會被寫到的那幾種（預留、確認、釋放、帳）都有。全部走 HTTP。
 */
final class Load implements AutoCloseable {

    final AtomicLong placed = new AtomicLong(), cancelled = new AtomicLong(), paid = new AtomicLong(), errors = new AtomicLong();
    final ConcurrentLinkedQueue<Long> placeNanos = new ConcurrentLinkedQueue<>();
    private final ExecutorService pool;
    private volatile boolean stop;
    private final long started = System.nanoTime();
    private static final AtomicLong nextBuyer = new AtomicLong(860_000);

    Load(ConfigurableApplicationContext app, int threads) {
        pool = Executors.newFixedThreadPool(threads);
        for (int i = 0; i < threads; i++)
            pool.submit(() -> {
                Ops ops = new Ops(app);
                while (!stop) {
                    long buyer = nextBuyer.getAndIncrement();
                    long[] ps = ThreadLocalRandom.current().longs(0, SplitLab.PRODUCTS).distinct().limit(3).map(x -> SplitLab.FIRST_PRODUCT + x).toArray();
                    try {
                        long t0 = System.nanoTime();
                        String no = ops.place(buyer, ps);
                        placeNanos.add(System.nanoTime() - t0);
                        placed.incrementAndGet();
                        switch (ThreadLocalRandom.current().nextInt(3)) {
                            case 0 -> { if (ops.post("/api/orders/" + no + "/cancel", ops.bearer(buyer), null) == 200) cancelled.incrementAndGet(); else errors.incrementAndGet(); }
                            case 1 -> { if (ops.post("/api/payments/callback", null, ops.callback(buyer, no)) == 200) paid.incrementAndGet(); else errors.incrementAndGet(); }
                            default -> { }
                        }
                    } catch (Exception e) {
                        errors.incrementAndGet();
                    }
                }
                return null;
            });
    }

    @Override
    public void close() throws Exception {
        stop = true;
        pool.shutdown();
        pool.awaitTermination(60, TimeUnit.SECONDS);
    }

    String summary() {
        double secs = (System.nanoTime() - started) / 1e9;
        List<Long> l = new ArrayList<>(placeNanos);
        long[] s = l.stream().mapToLong(Long::longValue).sorted().toArray();
        return String.format("%.0f 秒：下單 %,d 張（每秒 %.0f，p50 %.1f ms）、取消 %,d、付款 %,d、錯誤 %d", secs, placed.get(), placed.get() / secs,
                SplitLab.pct(s, 50), cancelled.get(), paid.get(), errors.get());
    }
}
```

**`src/test/java/com/example/shop/dist02/C4DataMigrationTest.java`**（2.8（實驗））

```java
package com.example.shop.dist02;

import com.example.shop.ShopApplication;
import com.example.shop.dist00.SplitLab;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.context.ConfigurableApplicationContext;

import java.io.PrintStream;
import java.sql.Connection;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 13 站 2.8：單體還在營業，把庫存的五張表搬到庫存服務的新資料庫。三種做法：
 *
 *   ① 停寫搬家：不接單、整張複製、核對、切過去 —— 要停多久？
 *   ② 應用程式雙寫：照常接單，每一個交易 commit 之後在新的庫再寫一次（DualWriteTap）；同時回填舊資料。中間新的庫斷線 2 秒
 *   ③ 舊的庫是唯一寫入者：trigger 在同一個交易裡記下「哪一列變了」，搬家程式回填之後照著紀錄追（Copier.apply）；
 *      最後停寫幾秒、追完、核對 —— 同樣讓新的庫斷線 2 秒
 *
 * 舊的庫照第 12 站的規模灌：1,000 個商品、30 萬筆預留、60 萬筆帳。單體跟第 00 章一樣在測試的 JVM 裡起（Redis 8 號 database）。
 *
 *   mvn test -Pexperiments -Dtest=C4DataMigrationTest
 */
@Tag("experiment")
class C4DataMigrationTest {

    static final String OLD = "shop_d02_mono", NEW = "shop_d02_newinv";
    static final int THREADS = 8;
    final PrintStream out = System.out;

    @Test
    void migration() throws Exception {
        SplitLab.freshDatabase(OLD);
        SplitLab.freshDatabase(NEW);
        List<String> a = new ArrayList<>(SplitLab.common(OLD, 8));
        a.removeIf(x -> x.startsWith("--spring.datasource.url="));
        a.add("--spring.datasource.url=" + SplitLab.url(OLD) + "&queryInterceptors=" + DualWriteTap.class.getName());
        try (ConfigurableApplicationContext mono = Split.flushed(new SpringApplicationBuilder(ShopApplication.class).run(a.toArray(String[]::new)))) {
            Flyway.configure().dataSource(SplitLab.url(NEW), "shop_migrator", "shop_migrator")                // 庫存服務的庫：只有它自己的資料夾（2.4.2）
                    .locations("classpath:db/migration/inventory", "classpath:db/migration/shared").load().migrate();
            seed();
            Copier copier = new Copier(OLD, NEW);
            out.printf("═══ 2.8 舊的庫（單體）：%s（load %s）═══%n", sizes(OLD), SplitLab.load());

            // ── 對照：什麼都不做的時候，這台機器上的下單（先熱身 5 秒：剛起來的 JVM 還沒 JIT）──
            try (Load warm = new Load(mono, THREADS)) { Thread.sleep(5_000); }
            try (Load load = new Load(mono, THREADS)) { Thread.sleep(10_000); load.close(); out.println("  對照（不搬家）　│ " + load.summary()); }

            stopTheWorld(copier);
            dualWrite(mono, copier);
            capture(mono, copier);
            out.printf("  （結束時 load %s）%n", SplitLab.load());
        }
    }

    // ───────── ① 停寫搬家 ─────────

    void stopTheWorld(Copier copier) throws Exception {
        out.printf("═══ 2.8.2 ① 停寫搬家：不接單，整張複製，核對（load %s）═══%n", SplitLab.load());
        copier.truncateTarget();
        long t0 = System.nanoTime();
        long rows = 0;
        for (String t : Copier.TABLES.keySet()) {
            long s = System.nanoTime();
            long n = copier.backfill(t);
            rows += n;
            out.printf("  複製 %-30s %,9d 列  %6.1f 秒%n", t, n, (System.nanoTime() - s) / 1e9);
        }
        long t1 = System.nanoTime();
        Map<String, String> diff = copier.differences();
        long t2 = System.nanoTime();
        out.printf("  複製 %,d 列 %.1f 秒（每秒 %,.0f 列）＋ 核對（五張表的列數與 CRC32）%.1f 秒 = 停寫 %.1f 秒；兩邊不一樣的表：%s%n",
                rows, (t1 - t0) / 1e9, rows / ((t1 - t0) / 1e9), (t2 - t1) / 1e9, (t2 - t0) / 1e9, diff.isEmpty() ? "沒有" : diff);
    }

    // ───────── ② 應用程式雙寫 ─────────

    void dualWrite(ConfigurableApplicationContext mono, Copier copier) throws Exception {
        out.printf("═══ 2.8.3 ② 應用程式雙寫：照常接單，commit 之後在新的庫再寫一次；同時回填（load %s）═══%n", SplitLab.load());
        copier.truncateTarget();
        DualWriteTap.reset();
        DualWriteTap.target = NEW;
        DualWriteTap.enabled = true;
        long[] backfilled = new long[1];
        Exception[] backfillError = new Exception[1];
        try (Load load = new Load(mono, THREADS)) {
            Thread.sleep(2_000);                                            // 雙寫先開始，回填後到（「新的寫先進去，再把舊的補齊」）
            Thread backfill = new Thread(() -> {
                try { for (String t : Copier.TABLES.keySet()) backfilled[0] += copier.backfill(t, false); }
                catch (Exception e) { backfillError[0] = e; }
            });
            backfill.start();
            Thread.sleep(6_000);
            DualWriteTap.down = true;                                       // 新的庫斷線 2 秒
            Thread.sleep(2_000);
            DualWriteTap.down = false;
            Thread.sleep(10_000);
            load.close();
            backfill.join();
            DualWriteTap.enabled = false;
            out.println("  單體　　　　　　│ " + load.summary());
        }
        out.printf("  雙寫：成功 %,d 個交易；失敗 %,d 個交易（%,d 句沒寫進新的庫）；回填 %,d 列%s%n", DualWriteTap.txReplayed.get(), DualWriteTap.txFailed.get(),
                DualWriteTap.stmtsLost.get(), backfilled[0], backfillError[0] == null ? "" : "（回填失敗：" + backfillError[0] + "）");
        DualWriteTap.errors.forEach((k, v) -> out.printf("    失敗的原因 × %,d：%s%n", v.get(), k));
        report(copier);
    }

    // ───────── ③ 舊的庫是唯一寫入者，新的跟著它 ─────────

    void capture(ConfigurableApplicationContext mono, Copier copier) throws Exception {
        out.printf("═══ 2.8.4 ③ 舊的庫是唯一寫入者：trigger 記下變更，回填之後照著追；最後停寫、追完、核對（load %s）═══%n", SplitLab.load());
        copier.truncateTarget();
        copier.installCapture();
        copier.maxSeen = 0;
        boolean[] stop = new boolean[1];
        long[] maxLag = new long[1], applied = new long[1], retries = new long[1];
        Exception[] copierError = new Exception[1];
        Thread sync = new Thread(() -> {
            try {
                for (String t : Copier.TABLES.keySet()) copier.backfill(t);
                out.printf("    回填完成（%s）%n", sizes(NEW));
                while (!stop[0]) {
                    try {
                        int n = copier.apply();
                        applied[0] += n;
                        if (n == 0) Thread.sleep(50);
                    } catch (java.sql.SQLTransientConnectionException down) {
                        retries[0]++;
                        Thread.sleep(100);                                  // 新的庫連不上：紀錄還在舊的庫裡，等一下再追
                    }
                }
            } catch (Exception e) { copierError[0] = e; }
        });
        long freeze0, freeze1, drained;
        List<Long> lags = new ArrayList<>();
        try (Load load = new Load(mono, THREADS)) {
            sync.start();
            for (int s = 1; s <= 80; s++) {
                Thread.sleep(1_000);
                if (s == 8) copier.targetDown = true;                       // 新的庫斷線 2 秒
                if (s == 10) copier.targetDown = false;
                long lag = copier.lag();
                lags.add(lag);
                maxLag[0] = Math.max(maxLag[0], lag);
                if (s >= 20 && lag < 1_000) break;                          // 營業 20 秒以上、而且幾乎追上了，才停寫
            }
            load.close();                                                   // 停寫：從這一刻起單體不接單
            freeze0 = System.nanoTime();
            out.println("  單體　　　　　　│ " + load.summary());
        }
        out.println("  變更紀錄落後幾筆（每秒）：" + String.join(" ", lags.stream().map(x -> String.format("%,d", x)).toList()));
        stop[0] = true;
        sync.join();
        if (copierError[0] != null) throw copierError[0];
        int last;
        do { last = copier.apply(); applied[0] += last; } while (last > 0);   // 追完
        // 洞：舊庫上還有沒有進行中的交易？沒有 → 剩下的洞都是 rollback 了（號碼發了、交易沒成立）
        long inFlight = SplitLab.count(OLD, "SELECT COUNT(*) FROM information_schema.innodb_trx WHERE trx_mysql_thread_id <> CONNECTION_ID()");
        int closed = inFlight == 0 ? copier.closeHoles() : -1;
        drained = System.nanoTime();
        Map<String, String> diff = copier.differences();
        freeze1 = System.nanoTime();
        out.printf("  搬家程式：套用了 %,d 筆變更紀錄；最多落後 %,d 筆；新的庫斷線時重試了 %d 次（回填 %d 次、追變更 %d 次）%n",
                applied[0], maxLag[0], copier.retries + retries[0], copier.retries, retries[0]);
        out.printf("  號碼的洞：發現 %,d 個，之後補上 %,d 個（那個交易比後面的晚 commit），過期 %,d 個；停寫時舊庫上進行中的交易 %d 個 → 剩下的 %d 個洞當成 rollback%n",
                copier.holesFound, copier.holesFilled, copier.holesExpired - Math.max(closed, 0), inFlight, closed);
        out.printf("  停寫 %.0f ms：追完最後的變更 %.0f ms ＋ 核對 %.0f ms；兩邊不一樣的表：%s%n", (freeze1 - freeze0) / 1e6, (drained - freeze0) / 1e6,
                (freeze1 - drained) / 1e6, diff.isEmpty() ? "沒有" : diff);
        report(copier);
        assertThat(diff).isEmpty();
        triggerCost(mono, copier);
        copier.dropCapture();
    }

    /** ④ trigger 的代價：每一列的寫入多一句 INSERT（同一個交易）。有、沒有 trigger 各 5 秒，交錯 4 輪 —— 不交錯的比較會被機器當下的狀態蓋過去 */
    void triggerCost(ConfigurableApplicationContext mono, Copier copier) throws Exception {
        out.printf("═══ 2.8.4 ④ trigger 的代價：有／沒有 trigger 各 5 秒、交錯 4 輪（load %s）═══%n", SplitLab.load());
        long[] placed = new long[2];
        List<List<Long>> nanos = List.of(new ArrayList<>(), new ArrayList<>());
        for (int round = 0; round < 4; round++)
            for (int with = 0; with < 2; with++) {
                if (with == 1) copier.installTriggers(); else copier.dropTriggers();
                try (Load load = new Load(mono, THREADS)) {
                    Thread.sleep(5_000);
                    load.close();
                    placed[with] += load.placed.get();
                    nanos.get(with).addAll(load.placeNanos);
                }
            }
        for (int with = 0; with < 2; with++) {
            long[] s = nanos.get(with).stream().mapToLong(Long::longValue).sorted().toArray();
            out.printf("  %-10s │ 下單 %,d 張（每秒 %.0f）│ p50 %.1f ms │ p99 %.1f ms%n", with == 1 ? "有 trigger" : "沒有", placed[with], placed[with] / 20.0,
                    SplitLab.pct(s, 50), SplitLab.pct(s, 99));
        }
        out.printf("  變更紀錄這段時間多了 %,d 筆%n", SplitLab.count(OLD, "SELECT COUNT(*) FROM d02_changes WHERE seq > " + copier.maxSeen));
    }

    // ───────── 共用 ─────────

    void report(Copier copier) throws Exception {
        out.println("  逐列比對（實驗才做得到）：只在舊庫 / 只在新庫 / 內容不同");
        copier.rowDiff().forEach((t, d) -> out.printf("    %-30s %,7d / %,7d / %,7d%n", t, d[0], d[1], d[2]));
        out.printf("    inventory 的 reserved 對不上的商品：%d 個，差的件數合計 %,d%n",
                SplitLab.count("", "SELECT COUNT(*) FROM " + OLD + ".inventory o JOIN " + NEW + ".inventory n USING (product_id) WHERE o.reserved <> n.reserved"),
                SplitLab.count("", "SELECT COALESCE(SUM(ABS(o.reserved - n.reserved)), 0) FROM " + OLD + ".inventory o JOIN " + NEW + ".inventory n USING (product_id)"));
    }

    String sizes(String db) throws Exception {
        return String.format("inventory %,d 列、inventory_reservations %,d 列、inventory_ledger %,d 列",
                SplitLab.count(db, "SELECT COUNT(*) FROM inventory"), SplitLab.count(db, "SELECT COUNT(*) FROM inventory_reservations"),
                SplitLab.count(db, "SELECT COUNT(*) FROM inventory_ledger"));
    }

    /** 1,000 個商品；歷史：10 萬張舊訂單 × 3 個品項的預留（已出庫或已釋放）、60 萬筆帳。舊訂單的 id 從 1,000 萬開始，不會撞到搬家期間的新訂單 */
    void seed() throws Exception {
        SplitLab.seed(OLD, true, true);
        try (Connection c = SplitLab.root(OLD); Statement st = c.createStatement()) {
            st.execute("SET SESSION cte_max_recursion_depth = 1000000");
            st.execute("""
                    INSERT INTO inventory_reservations (order_id, product_id, quantity, status, created_at, updated_at)
                    WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 100000)
                    SELECT 10000000 + i, %d + (i * 3 + k.k) %% 1000, 1, IF(i %% 10 = 0, 'RELEASED', 'CONSUMED'),
                           NOW(3) - INTERVAL 30 DAY, NOW(3) - INTERVAL 29 DAY
                      FROM n CROSS JOIN (SELECT 0 AS k UNION ALL SELECT 1 UNION ALL SELECT 2) k ORDER BY i, k.k""".formatted(SplitLab.FIRST_PRODUCT));
            st.execute("""
                    INSERT INTO inventory_ledger (product_id, delta_on_hand, delta_reserved, reason, ref, created_at)
                    SELECT product_id, 0, 1, 'RESERVE', CONCAT('order:', order_id), created_at FROM inventory_reservations ORDER BY id""");
            st.execute("""
                    INSERT INTO inventory_ledger (product_id, delta_on_hand, delta_reserved, reason, ref, created_at)
                    SELECT product_id, IF(status = 'CONSUMED', -1, 0), -1, IF(status = 'CONSUMED', 'SHIP', 'RELEASE'), CONCAT('order:', order_id), updated_at
                      FROM inventory_reservations ORDER BY id""");
        }
    }
}
```

**`src/test/java/com/example/shop/dist01/D01Workload.java`**（第 01 章 1.4.4；2.4.6：跑在切開的部署上；2.6、2.7：跑對帳、交付 product.created）

```java
package com.example.shop.dist01;

import com.example.shop.dist00.SplitLab;
import com.example.shop.payment.internal.CallbackSignature;
import com.example.shop.shared.config.ShopProperties;
import com.example.shop.shared.events.Event;
import com.example.shop.shared.events.EventHandler;
import com.example.shop.shared.events.internal.EventDispatcher;
import com.example.shop.shared.web.Role;
import com.example.shop.support.TestTokens;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.test.util.AopTestUtils;
import org.springframework.test.util.ReflectionTestUtils;

import java.math.BigDecimal;
import java.net.URI;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.time.Duration;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * 13 站 1.4.4：「一個使用者的一天」。第 12 站的每一個功能各走一次，全部走 HTTP（跟真的客戶端一樣）；
 * 事件與排程不經過 HTTP —— 由這裡直接交給消費者、直接呼叫排程的方法（跟第 12 站 7.12.1 的 InlineEvents 同一個做法），並且標上「這是哪一個動作」。
 *
 * 它不是負載測試：每一個動作只走一兩次。量的是「這個動作會不會跨過那一刀」，不是「多常跨」。
 *
 * 13 站 2.4.6：也可以跑在切開的部署上（第 02 章的 dist02）—— 每一個模組屬於一個服務（一個 context、一個資料庫）：
 * HTTP 一律打 gateway（訂單服務）；事件從每一個服務自己的 outbox 讀出來，交給「擁有那個消費者所屬模組」的服務；
 * 排程在擁有它的服務上跑；直接改資料的 SQL 送到擁有那張表的資料庫。一個行程的時候，八個模組都屬於同一個 context —— 行為跟第 01 章一樣。
 */
public final class D01Workload {

    public record Step(String op, int status) {}

    static final long ADMIN = 990_901;                                       // JWT 不查資料庫（TestTokens 的說明）：管理員不需要真的存在

    private final ConfigurableApplicationContext ctx;                         // gateway：HTTP、JWT、金流回呼的簽章
    private final Map<String, ConfigurableApplicationContext> ctxOf;          // 模組 → 擁有它的服務
    private final Map<String, String> dbOf;                                   // 模組 → 那個服務的資料庫
    private final ObjectMapper json = new ObjectMapper();
    public final List<Step> steps = new ArrayList<>();

    /** 一個行程、一個資料庫（第 01 章） */
    D01Workload(ConfigurableApplicationContext ctx, String db) {
        this(ctx, everyModule(ctx), everyModule(db));
    }

    /** 切開的部署：ctxOf、dbOf 要涵蓋 Probe.MODULES 的每一個模組，加上 shared（outbox 所在的庫：每個服務各一份，這裡不用） */
    public D01Workload(ConfigurableApplicationContext gateway, Map<String, ConfigurableApplicationContext> ctxOf, Map<String, String> dbOf) {
        this.ctx = gateway;
        this.ctxOf = ctxOf;
        this.dbOf = dbOf;
    }

    private static <T> Map<String, T> everyModule(T v) {
        Map<String, T> m = new java.util.HashMap<>();
        for (String module : Probe.MODULES) m.put(module, v);
        return m;
    }

    public void run() throws Exception {
        String admin = TestTokens.bearer(ctx, ADMIN, Role.ADMIN);
        String tag = Long.toString(System.nanoTime() % 1_000_000_000L);

        // ── 帳號（account）：註冊、登入、換發、我是誰；管理員把一個人設成賣家 ──
        long buyerId = call("POST", "/api/auth/register", null, Map.of("email", "d01-buyer-" + tag + "@example.com",
                "password", "d01-password", "displayName", "d01 買家"), 201).get("id").asLong();
        JsonNode login = call("POST", "/api/auth/login", null, Map.of("email", "d01-buyer-" + tag + "@example.com", "password", "d01-password"), 200);
        String buyer = "Bearer " + login.get("accessToken").asText();
        call("POST", "/api/auth/refresh", null, Map.of("refreshToken", login.get("refreshToken").asText()), 200);
        call("GET", "/api/me", buyer, null, 200);
        long sellerId = call("POST", "/api/auth/register", null, Map.of("email", "d01-seller-" + tag + "@example.com",
                "password", "d01-password", "displayName", "d01 賣家"), 201).get("id").asLong();
        call("POST", "/api/admin/users/" + sellerId + "/roles", admin, Map.of("role", "SELLER"), 200);
        String seller = "Bearer " + call("POST", "/api/auth/login", null,
                Map.of("email", "d01-seller-" + tag + "@example.com", "password", "d01-password"), 200).get("accessToken").asText();
        long spammer = call("POST", "/api/auth/register", null, Map.of("email", "d01-spam-" + tag + "@example.com",
                "password", "d01-password", "displayName", "d01 停權"), 201).get("id").asLong();
        call("POST", "/api/admin/users/" + spammer + "/suspend", admin, null, 200);

        // ── 商品（catalog）：上架三個商品，其中一個標成熱點；改說明、補貨、看自己的商品 ──
        long a = createAndPublish(seller, "d01 商品 A"), b = createAndPublish(seller, "d01 商品 B"), h = createAndPublish(seller, "d01 熱點商品");
        call("POST", "/api/seller/products/" + h + "/hot", seller, Map.of("hot", true), 200);
        long c = createAndPublish(seller, "d01 商品 C");
        call("POST", "/api/seller/products/" + c + "/unpublish", seller, null, 200);
        call("PATCH", "/api/seller/products/" + a, seller, Map.of("description", "改了說明"), 200);
        call("POST", "/api/seller/products/" + a + "/restock", seller, Map.of("quantity", 10, "note", "d01"), 200);
        call("GET", "/api/seller/products", seller, null, 200);

        // ── 逛（catalog、reporting）──
        call("GET", "/api/products?q=d01", null, null, 200);
        call("GET", "/api/products/" + a, null, null, 200);
        call("GET", "/api/products/" + h, null, null, 200);
        call("GET", "/api/products/trending", null, null, 200);

        // ── 購物車（cart）──
        call("POST", "/api/cart/items", buyer, Map.of("productId", a, "quantity", 1), 200);
        call("POST", "/api/cart/items", buyer, Map.of("productId", b, "quantity", 2), 200);
        call("PATCH", "/api/cart/items/" + b, buyer, Map.of("quantity", 1), 200);
        call("POST", "/api/cart/items", buyer, Map.of("productId", h, "quantity", 1), 200);
        call("DELETE", "/api/cart/items/" + h, buyer, null, 200);
        call("GET", "/api/cart", buyer, null, 200);

        // ── 訂單 1：一般商品，付款 → 撿貨 → 出貨 → 確認收貨 ──
        String o1 = place(buyer, Map.of(a, 1, b, 1));
        events();
        pay(buyer, o1);
        events();
        call("GET", "/api/seller/orders", seller, null, 200);
        call("POST", "/api/seller/orders/" + o1 + "/start-picking", seller, null, 200);
        call("POST", "/api/seller/orders/" + o1 + "/ship", seller, Map.of("carrier", "黑貓", "trackingNo", "T-" + tag), 200);
        events();
        call("POST", "/api/orders/" + o1 + "/confirm-receipt", buyer, null, 200);
        events();
        call("GET", "/api/orders", buyer, null, 200);
        call("GET", "/api/orders/" + o1, buyer, null, 200);

        // ── 訂單 2：熱點商品，付款之後買家取消 → 退款 ──
        String o2 = place(buyer, Map.of(h, 1));
        events();                                                            // 熱點落帳（7.6）
        pay(buyer, o2);
        events();
        call("POST", "/api/orders/" + o2 + "/cancel", buyer, null, 200);
        events();                                                            // 退款、通知、熱點閘門加回去

        // ── 訂單 3：已付款，賣家取消（缺貨）──
        String o3 = place(buyer, Map.of(b, 1));
        events();
        pay(buyer, o3);
        events();
        call("POST", "/api/seller/orders/" + o3 + "/cancel", seller, null, 200);
        events();

        // ── 訂單 4：不付款，逾時取消（排程）──
        String o4 = place(buyer, Map.of(a, 1));
        events();
        sql("UPDATE orders SET payment_deadline = NOW(3) - INTERVAL 1 MINUTE WHERE order_no = ?", o4);
        job("排程 OrderJobs.cancelExpired", "ordering", "orderJobs", "cancelExpired");
        events();

        // ── 訂單 5：出貨之後沒有確認收貨，自動完成（排程）──
        String o5 = place(buyer, Map.of(b, 1));
        events();
        pay(buyer, o5);
        events();
        call("POST", "/api/seller/orders/" + o5 + "/start-picking", seller, null, 200);
        call("POST", "/api/seller/orders/" + o5 + "/ship", seller, Map.of("carrier", "黑貓", "trackingNo", "T5-" + tag), 200);
        events();
        sql("UPDATE orders SET shipped_at = NOW(3) - INTERVAL 30 DAY WHERE order_no = ?", o5);
        job("排程 OrderJobs.autoComplete", "ordering", "orderJobs", "autoComplete");
        events();

        // ── 訂單 6：熱點落帳時 MySQL 不夠（7.6.3）→ 訂單模組收到事件、取消訂單。人為製造 Redis 與 MySQL 不一致：MySQL 的可售量歸零 ──
        sql("UPDATE inventory SET on_hand = reserved WHERE product_id = ?", h);
        place(buyer, Map.of(h, 1));                                          // Redis 的閘門還以為有 → 201
        events();                                                            // 落帳：不夠 → inventory.hot-settlement-failed → 取消

        // ── 報表（reporting）──
        String range = "?from=" + LocalDate.now().minusDays(7) + "&to=" + LocalDate.now();
        call("GET", "/api/seller/reports/daily-sales" + range, seller, null, 200);
        call("GET", "/api/seller/reports/top-products" + range, seller, null, 200);
        call("GET", "/api/admin/reports/daily-sales" + range, admin, null, 200);
        call("GET", "/api/admin/reports/daily-sales" + range + "&groupBy=seller", admin, null, 200);
        call("GET", "/api/admin/reports/top-products" + range, admin, null, 200);

        // ── 庫存的排程（inventory）：熱點對帳、不變式檢查 ──
        job("排程 HotStock.reconcile", "inventory", "hotStock", "reconcile");
        job("排程 InventoryReconciliation.checkInvariants", "inventory", "inventoryReconciliation", "checkInvariants");
        // 13 站 2.6：預留 ⇄ 訂單的對帳（ordering）—— 第 02 章新增的排程，也要走到
        job("排程 ReservationReconciliation.run", "ordering", "reservationReconciliation", "run");
    }

    // ───────── 一步一步 ─────────

    private long createAndPublish(String seller, String name) throws Exception {
        long id = call("POST", "/api/seller/products", seller, Map.of("name", name, "price", new BigDecimal("100.00"),
                "categoryId", 11, "initialStock", 100), 201).get("id").asLong();
        events();                                                            // 13 站 2.7：期初庫存由 product.created 建立
        call("POST", "/api/seller/products/" + id + "/publish", seller, null, 200);
        return id;
    }

    private String place(String buyer, Map<Long, Integer> lines) throws Exception {
        List<Map<String, Object>> items = new ArrayList<>();
        lines.forEach((id, q) -> items.add(Map.of("productId", id, "quantity", q, "unitPrice", new BigDecimal("100.00"))));
        return call("POST", "/api/orders", buyer, Map.of("items", items), 201).get("orderNo").asText();
    }

    private void pay(String buyer, String orderNo) throws Exception {
        JsonNode p = call("POST", "/api/orders/" + orderNo + "/payments", buyer, null, 201);
        long paymentId = p.get("paymentId").asLong();
        BigDecimal amount = new BigDecimal(p.get("amount").asText());
        String txn = "d01-" + UUID.randomUUID();
        String secret = ctx.getBean(ShopProperties.class).payment().callbackSecret();
        String sig = CallbackSignature.sign(secret, CallbackSignature.canonical(paymentId, txn, amount, true));
        call("POST", "/api/payments/callback", null, Map.of("paymentId", paymentId, "providerTxnId", txn, "amount", amount,
                "result", "SUCCEEDED", "signature", sig), 200);
    }

    /**
     * outbox 裡還沒送出的事件，交給訂閱它的每一個消費者（不經過 RabbitMQ），直到沒有新的事件。每一次交付標成「事件 X → 消費者」。
     * 切開的部署：每一個服務的資料庫各有一個 outbox；消費者交給「擁有它所屬模組」的那個服務（用那個服務的 EventDispatcher：processed_messages 在它自己的庫）
     */
    void events() throws Exception {
        for (int round = 0; round < 10; round++) {
            boolean any = false;
            for (String db : new java.util.TreeSet<>(dbOf.values())) {
                List<Event> pending = new ArrayList<>();
                List<Long> ids = new ArrayList<>();
                try (Connection c = SplitLab.root(db); PreparedStatement ps = c.prepareStatement(
                        "SELECT id, event_id, aggregate_type, aggregate_id, event_type, payload, created_at FROM outbox_events WHERE published_at IS NULL ORDER BY id");
                     ResultSet rs = ps.executeQuery()) {
                    while (rs.next()) {
                        ids.add(rs.getLong(1));
                        pending.add(new Event(rs.getString(2), rs.getString(5), rs.getString(3), rs.getLong(4), rs.getTimestamp(7).toInstant(),
                                json.readTree(rs.getString(6)), 1));
                    }
                }
                if (pending.isEmpty()) continue;
                any = true;
                for (Event e : pending)
                    for (ConfigurableApplicationContext owner : new java.util.LinkedHashSet<>(ctxOf.values()))
                        for (EventHandler h : owner.getBeansOfType(EventHandler.class).values()) {
                            if (!h.eventTypes().contains(e.type())) continue;
                            String consumerModule = moduleOfClass(AopTestUtils.getUltimateTargetObject(h).getClass().getName());
                            if (ctxOf.get(consumerModule) != owner) continue;            // 這個消費者的模組不在這個服務上
                            EventDispatcher dispatcher = owner.getBean(EventDispatcher.class);
                            Probe.EVENTS.add(new Probe.Event("事件 " + e.type() + " → " + h.consumer(), e.type(), publisherOf(e.type()), h.consumer(), consumerModule));
                            OpTag.run("事件 " + e.type() + " → " + h.consumer(), () -> dispatcher.dispatch(h, e));
                        }
                try (Connection c = SplitLab.root(db); PreparedStatement ps = c.prepareStatement("UPDATE outbox_events SET published_at = NOW(3) WHERE id = ?")) {
                    for (long id : ids) { ps.setLong(1, id); ps.executeUpdate(); }
                }
            }
            if (!any) return;
        }
        throw new IllegalStateException("事件一直產生新的事件，交付了 10 輪還沒停");
    }

    /** 事件的名字就是它的發送模組：order.* → ordering、refund.* → payment、inventory.* → inventory（第 12 站 7.3.1 的 EventTypes） */
    static String publisherOf(String type) {
        return switch (type.substring(0, type.indexOf('.'))) {
            case "order" -> "ordering";
            case "refund" -> "payment";
            case "product" -> "catalog";                                     // 13 站 2.7
            default -> type.substring(0, type.indexOf('.'));
        };
    }

    static String moduleOfClass(String className) {
        return className.substring("com.example.shop.".length()).split("\\.")[0];
    }

    /** 排程的方法是 package-private（第 12 站沒有打算讓別人呼叫它們）：實驗用反射直接呼叫，標成「排程 X」。在擁有 module 的那個服務上跑 */
    private void job(String op, String module, String bean, String method) {
        Object target = AopTestUtils.getUltimateTargetObject(ctxOf.get(module).getBean(bean));
        OpTag.run(op, () -> ReflectionTestUtils.invokeMethod(target, method));
        steps.add(new Step(op, 0));
    }

    private static final java.util.regex.Pattern UPDATED = java.util.regex.Pattern.compile("(?i)^UPDATE\\s+(\\w+)");

    /** 直接改資料（製造逾時、製造不一致）：送到擁有那張表的資料庫 */
    private void sql(String sql, Object arg) throws Exception {
        java.util.regex.Matcher m = UPDATED.matcher(sql);
        if (!m.find()) throw new IllegalArgumentException(sql);
        String db = dbOf.get(Probe.OWNER.get(m.group(1).toLowerCase()));
        try (Connection c = SplitLab.root(db); PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setObject(1, arg);
            ps.executeUpdate();
        }
    }

    private JsonNode call(String method, String path, String token, Object body, int expect) throws Exception {
        HttpRequest.Builder r = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + SplitLab.port(ctx) + path))
                .timeout(Duration.ofSeconds(30)).header("Content-Type", "application/json")
                .method(method, body == null ? HttpRequest.BodyPublishers.noBody() : HttpRequest.BodyPublishers.ofString(json.writeValueAsString(body)));
        if (token != null) r.header("Authorization", token);
        if (method.equals("POST") && path.equals("/api/orders")) r.header("Idempotency-Key", UUID.randomUUID().toString());
        HttpResponse<String> res = SplitLab.CLIENT.send(r.build(), HttpResponse.BodyHandlers.ofString());
        steps.add(new Step(method + " " + path, res.statusCode()));
        if (res.statusCode() != expect)
            throw new IllegalStateException(method + " " + path + " → " + res.statusCode() + "（預期 " + expect + "）：" + res.body());
        return res.body().isEmpty() ? json.createObjectNode() : json.readTree(res.body());
    }
}
```

---

## 2.11 常見誤區

- **「服務先拆，資料庫之後再說。」** 2.2：第 00 章就是這樣做的，9 個方法一直在讀寫錯的庫，而每一句都成功。「之後」常常不會來，而留著的舊表是一條看不見的依賴。
- **「兩個 schema 在同一台 MySQL 上，就算拆了。」** 跨庫的交易、跨庫的 JOIN 都還寫得出來；兩個服務用同一個角色，彼此的庫都讀得到（2.4.4）。這是很好的過渡階段，不是終點（2.3.4）。
- **「拆資料庫最痛的是外鍵。」** 第 12 站一個跨模組的外鍵都沒有，照樣痛：消失的是**交易**（2.5.1）。要檢查的不是「id 存在」，是「兩邊的狀態對得上」（2.5.2）。
- **「`shared` 的表放一個大家共用的庫。」** outbox 必須跟業務資料在同一個交易裡，所以必須在同一個庫；`processed_messages` 也是。每個服務各帶一份（2.4.3）。
- **「使用者的一天全綠，資料庫就拆好了。」** 2.4.7 全綠，10 種交易各被切成兩半；讓第二半失敗才看得到（2.5.3）。
- **「失敗了，使用者會重試。」** 重做同一件事會收斂；但使用者常常不重試，或者改做別的事 —— S3' 卡住一張已付款的訂單、S4' 讓帳上少了 1 件（2.5.3）。
- **「對帳找到不一致，就自動修掉。」** 對帳知道兩邊對不上，不知道為什麼。只有「不管為什麼，答案都一樣」的才能自動修（X-1、X-2）；其他的交給人（2.6.4）。
- **「對帳是一句 JOIN 的事。」** 拆開之後那句 JOIN 不存在。用 API 兩邊各問各的：要決定放在哪個模組、keyset 分頁、grace、兩個方向各掃一次（2.6）。
- **「跨服務的寫，一律發事件。」** 另一邊會拒絕的，事件不夠 —— 那要 Saga（2.7.2）。另一邊不會拒絕的（建立商品），事件就夠了。
- **「拆資料庫只改程式碼。」** 它也改驗收條件：US-PRD-1 AC-1 的「同時建立」變成「事件送到之後」（2.7.4）。
- **「雙寫就能不停機搬家。」** 2.8.3：四次跑出四種錯，1,000 個商品有 996～1,000 個對不上。搬家的時候只能有一個寫入者（2.8.4）。
- **「用自動遞增的號碼當變更的順序。」** 號碼是 INSERT 的順序，不是 commit 的順序；讀到尾巴的時候會跳過還在路上的那幾筆（2.8.4 的 ⚠️，第 12 站 9.12 J11b 的同一個錯）。
- **「先想辦法不停機。」** 停寫搬家 12 秒（2.8.2）。先算停機的代價，再決定值不值得做不停機的那一整套。

---

## 2.12 本章小結

第 00 章拆了行程，這一章拆資料：

1. **讓資料庫跟行程一樣真的分開**（2.2、2.4）：migration 依模組分資料夾，每個服務只跑自己的資料夾加上 `shared`；`ServiceDatabaseTest` 守住「各自跑得起來、剛好是自己的表」。第 00 章的兩個庫是同一份 schema —— 9 個方法一直在讀寫錯的庫。
2. **消失的不是外鍵，是交易**（2.5）：第 12 站沒有跨模組的外鍵，參照完整性一直是交易給的。切開之後，10 種交易內的遠端呼叫各是兩個交易；讓第二個失敗，重做同一件事會收斂，改做別的事就不會。
3. **JOIN 換成對帳**（2.6）：放在 ordering、透過 `InventoryApi`、兩個方向各掃一次、只自動修 X-1、X-2。在切開的部署裡，它找到的跟跨庫 JOIN 一樣，30 萬筆預留一輪 250 ms 左右。
4. **建立商品從一個交易變成一個事件**（2.7）：判斷的關鍵是「另一邊會不會拒絕」。7 種切斷的交易少了 1 種，需求跟著改。
5. **搬家只能有一個寫入者**（2.8）：停寫搬家 12 秒；雙寫四次四種錯；照著變更紀錄追、最後停寫 1.5 秒核對，0 差異 —— 變更紀錄的號碼不是 commit 的順序，搬家程式要處理「洞」。

這一章也修了第 12 站的一個 bug（排程一張失敗，整批停下，第 12 站 4.7.1）與一個偶發紅的測試（7.7.3）。**第 00 章的四個代價，這一章仍然一個都沒有減少**（2.9.2）：剩下的 6 種切斷的交易、下單路徑上的遠端呼叫，要等第 04 章。

### 2.12.1 驗收清單

- [ ] 從 `d01` 開出 `d02`，migration 搬進 8 個資料夾，`mvn clean` 之後用一個已經跑過 25 個 migration 的庫起一次單體：Flyway 驗證通過、沒有要跑的 migration（2.4.1）。
- [ ] `mvn test -Pexperiments -Dtest=C1SharedSchemaTest` 印出三種部署：① 停在第 33 個請求（下單 409）；② 兩個服務起不來，關掉驗證之後停在建立商品；③ 61 個請求全部是預期的回應（2.2、2.4.7）。
- [ ] **不看課文**，說出 ① 的第一個錯誤（下單 409）跟真正的原因（建立商品寫錯了庫）為什麼隔了 32 個請求。
- [ ] 把一個「加回外鍵」的 migration 放進 `inventory/`，看 `MigrationOwnershipTest` 與 `ServiceDatabaseTest` 一起紅，再刪掉、`mvn clean`（2.4.5）。
- [ ] 跑 C2，說出哪幾個情境「重做同一件事」會收斂、為什麼；S3' 為什麼永遠卡住（2.5.3）。
- [ ] 說出對帳為什麼放在 ordering、為什麼要兩個方向各掃一次、為什麼 X-3 不能自動修（2.6）。
- [ ] 跑 C3，對帳的五個數字跟跨庫 JOIN 一樣（2.6.6）。
- [ ] 用「另一邊會不會拒絕」說明：建立商品可以用事件，下單不行（2.7.2）。
- [ ] 跑 C4，說出 ② 的每一種失敗原因各是雙寫的哪一個問題，以及 ③ 為什麼不怕重複、不怕亂序（2.8）。
- [ ] 說出變更紀錄的號碼為什麼不是 commit 的順序，以及搬家程式怎麼處理「洞」（2.8.4）。
- [ ] `mvn clean verify` 全綠，234 個測試（2.10）。

---

## 2.13 下一章預告

這一章讓資料分開了，但兩個服務之間的那條線還是臨時的：`RemoteInventory` 把 13 個 Java 方法原封不動搬到 HTTP 上（`POST /lab/d02/inventory/{op}`），沒有版本、沒有認證、沒有冪等鍵；事件在兩個服務之間，是實驗程式自己讀 outbox、自己交給另一個服務的消費者。

第 03 章處理**服務之間的那條線**：

- **介面的粒度與形狀**：第 00 章 0.2.1 的「每項一次」、這一章那 13 個方法 —— 哪些該合併、哪些該消失（例如 `setHot` 與熱點旗標的歸屬，第 01 章 1.3.3）。用 `@HttpExchange` 宣告型別化的客戶端，取代手寫的 `RestClient`。
- **服務之間的冪等**：第 00 章 0.2.2 ② 的重送、這一章 2.5.3 的「重做同一件事」—— 讓遠端的每一步都能安全地重做，而不是碰巧可以。
- **契約測試**：庫存服務改了回應的欄位，訂單服務在部署之前就知道（Pact）。第 12 站 3.8.2 的 API 快照，延伸到兩個服務之間。
- **服務之間的認證**：這一章兩條 `/lab/**` 都是 `permitAll`。
- **事件真的走 broker**：兩個服務各自的 relay 與消費者 —— 以及「同一個 jar、兩個角色」時，兩個服務會不會搶同一個佇列裡的訊息。

第 03 章起，實驗改用這一章的誠實的兩個庫（`Split`）。
