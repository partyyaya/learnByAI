# 第 01 章：邊界怎麼切

> **上一章**：[第 00 章](00-course-map-should-you-split.md)把第 12 站的庫存模組切成另一個行程、另一個資料庫，量了四個代價，結論是「不該拆」。它還留了一個沒回答的問題：**那一刀為什麼切在庫存？** 0.2 直接拿 `InventoryApi` 開刀，因為它的介面最清楚 —— 0.3.3 的變更耦合卻說，庫存跟訂單總是一起改。
>
> **這一章**：不再憑感覺選刀。先做三把尺 —— **跨模組的同步呼叫、交易邊界、變更耦合** —— 在第 12 站的單體上跑一遍「使用者的一天」（八個模組的 35 支 API 全部走到），量出模組之間的每一條線；再把八個模組所有可能的切法（127 種）一一算出「這一刀會切斷什麼」。然後做「先拆模組、再拆行程」的第一步：**還沒拆的時候**，先把邊界上「現在很便宜、切開之後很貴」的那一類呼叫修掉，再用一個測試守住。
>
> **你手上會有**：從 `d00` 開出來的分支 `d01`。`src/test` 多一個 `dist01` 套件（三把尺、工作負載、兩個實驗、一個守門測試）；正式程式碼改了三個類別（`ProductService`、`CartService`、`PlaceOrderService`），另外帶著第 12 站的兩個追記（`ProductCache`、`JdbcPaymentService`，都是這一章途中找到的 bug）—— 沒有新的 migration，沒有改任何一支 API 的回應。230 個測試。
>
> **這一章的實測事故**：
>
> - **第 00 章只量到一種交易**（1.2）。同一刀（把庫存切出去）其實切斷了 **7 種交易**：下單、付款回呼、出貨、買家取消、賣家取消、逾時排程、**建立商品**；以及 **12 種同步呼叫**，其中 10 種發生在呼叫端的交易裡。第 00 章的實驗走到的是下單那一種。
> - **127 種切法裡，庫存排第 96**（1.5）。第 1 名是 notification：0 種交易、0 種同步呼叫，只有 5 種事件跨過去；第 2 名是 account。**每一種把庫存切出去的切法，都至少切斷 6 種交易。**
> - **一個唯讀的頁面，也會拖垮整個服務**（1.6.5）。切開的部署，庫存服務的可售量查詢慢 3 秒，每秒看 20 次購物車 —— 第 12 站的寫法：購物車 400 次裡 225 次 503、訂單服務的連線池 20 條全滿（最多 62 個請求在排隊）、跟庫存無關的「我的訂單」p50 從 9.8 ms 變成 2,064 ms。把那一次查詢移到交易外面（這一章的改動）：購物車 400 次全部 200（每一次都慢 3 秒）、「我的訂單」p50 8.9 ms、連線池最多 1 條在用。
>
> **⚠️ 寫這一章途中被自己的實驗抓到的**：
>
> - **第一版的工作負載少走了 3 支 API**，也沒走到管理員報表的 `groupBy=seller` —— account 因此看起來「跟誰都沒有關係」。補齊之後，多出一條「reporting 直接讀 `users` 表」的線（1.4.4）。**量邊界的工具，只量得到你走過的路。**
> - **同一份程式碼連跑兩次，B1 的數字不一樣。** 資料庫每次重建，商品與使用者的 id 每次都從同一個號碼開始；Redis 卻沒有清 —— 第二次的熱門排行直接走了上一次留下的快取，「讀別人的表」少了 3 句。B1 起來之後先清空自己的 Redis database（1.4.5）。
> - **d01 的第一次整套 `mvn clean verify` 紅了一個第 12 站的測試**：`AuthApiTest.perIpLimit`，預期 429、拿到 401。不是這一章的改動造成的 —— 那 21 個請求剛好跨過整分鐘，第 12 站的固定窗從 1 重新計數（1.9，第 12 站 5.6.4 的追記）。
> - **推「`succeededPaymentOf` 能不能移出取消的交易」時，找到第 12 站的一個 bug：已付款、已取消、沒有退款單。** 買家取消的交易第一句讀就建立了快照；金流回呼如果整個落在那一句讀與取消的 UPDATE 之間，取消照樣成立，但「退哪一筆」那一句讀還在用舊快照，看不到那一筆 `SUCCEEDED`。用一個確定性的測試重現（`訂單 CANCELLED、付款 SUCCEEDED、退款單 []`），改成當前讀（`FOR SHARE`）之後是 `退款單 [BUYER_CANCEL]`（1.6.7，第 12 站 4.6.2 的追記）。
> - **第 00 章沒找到原因的那一個偶發失敗，找到了**：`ProductCacheTest.singleFlight` 的「MySQL 讀了 2 次」。用 latch 把推測的交錯釘住，穩定重現；修法是搶到讀取權之後再看一次快取（第 12 站 6.4.3 的再追記）。這個分支已經包含這個修正。
>
> **小坑**：
>
> - `OrderJobs` 只在 `shop.order.jobs-enabled=true` 時才存在。工作負載要直接呼叫逾時排程，第一版拿不到這個 bean（`No bean named 'orderJobs' available`）。改成打開排程、把間隔拉到 1 小時，啟動之後等它自己的第一次跑完再開始量（1.4.4）。
> - 把讀移出交易之後，B1 數到的「commit 的交易」從 191 個變成 227 個。不是變多了：原本包在同一個交易裡的幾句讀，現在各自 autocommit，各算一個（1.6.5）。
>
> **這一章沒有達成、或只達成一部分的目標**：
>
> - **工作負載不是正式環境的流量。** 每一個功能只走一兩次，所以 1.5 的排名看的是切斷了「幾**種**」，不是「每秒切斷幾次」。真的要做決定，要拿正式環境的請求比例加權 —— 這一章沒有那份資料。
> - **事件只看得到工作負載觸發的那幾種**：10 種事件走到 8 種（`order.completed` 沒有消費者，`refund.failed` 沒有觸發）。
> - **還在交易裡的 12 種跨模組呼叫，一種都沒拿出來**（1.6.7）。它們全是「寫」，要拿出來就得換掉 `@Transactional` —— 那是第 04 章的 Saga。這一章只保證它們不會再變多。
> - **「熱點商品」這個業務能力散在三個模組裡**（1.3.3）：看出來了，沒有修。要修，庫存模組得有自己的一份熱點旗標與快取，那是另一個工程。（📌 第 04 章寫完之後的追記：留給第 05 章，第 04 章 4.14。）（📌 再追記：第 05 章 5.7 搬了 —— 旗標的擁有者是庫存。）
> - 變更耦合用的仍是課程參考實作的 git 歷史，0.3.3 的 ⚠️ 照樣成立：數字不能直接搬，方法可以。

---

## 1.1 學習目標

完成本章後，你應該可以：

- 說出第 00 章那一刀實際切斷了哪 7 種交易，以及為什麼第 00 章的實驗只看到其中一種（1.2）。
- 分辨「依業務能力切」與「依名詞切」，指出第 12 站的九個模組各是哪一種，並舉出一個被名詞切散了的業務能力（1.3）。
- 做出三把量邊界的尺：用一個 Spring AOP 的 Advisor 記錄跨模組的同步呼叫、用 MySQL 驅動的 query interceptor 記錄每一個交易寫了哪些模組的表、用 git 歷史算變更耦合 —— 全部在 `src/test`，正式程式碼一行都不用改（1.4）。
- 說出「量邊界的工具只量得到你走過的路」，並用 API 覆蓋率檢查自己的工作負載（1.4.4）。
- 用五個數字評估一刀：切斷的交易、交易內的呼叫、同步呼叫、直接讀表、變更耦合，並說明排序的理由（1.5.1）。
- 用「聚合」解釋為什麼庫存跟訂單分不開：哪些寫入必須在同一個交易裡（1.5.3）。
- 說出「先拆模組、再拆行程」的第一步具體做什麼：**在還沒拆的時候，把跨模組的讀移出本地交易**，並用一個 A/B 實驗說出它換到了什麼（1.6）。
- 用一個測試守住「在交易裡呼叫別的模組」只會變少、不會變多（1.6.6）。
- 列出切錯邊界的六個症狀，每一個都說得出用哪一把尺量（1.7）。

---

## 1.2 先看見痛：第 00 章只量到一種交易 ★★★

第 00 章把 `InventoryApi.reserve()` 換成 HTTP 呼叫，量了下單。可是 `InventoryApi` 有 13 個方法（`available` 有兩個多載），下單用到其中四個（`gateHot`、`reserve`、`holdHot`、`returnHot`），第 00 章的實驗只走到 `reserve`。**庫存模組切出去之後，還有誰在呼叫它、在什麼時候呼叫？**

這一章的第一個實驗（B1，1.4 會一步一步做出來）在第 12 站的單體上，把每一個功能都走一遍，記下所有跨模組的呼叫與交易。這裡先看結果 —— 如果把庫存切出去，切斷了什麼：

```
═══ 1.5 切出 inventory：切斷了什麼 ═══
  切斷的交易：
    POST /api/orders  寫 [cart, inventory, ordering]
    POST /api/orders/{orderNo}/cancel  寫 [inventory, ordering, payment]
    POST /api/payments/callback  寫 [inventory, ordering, payment]
    POST /api/seller/orders/{orderNo}/cancel  寫 [inventory, ordering, payment]
    POST /api/seller/orders/{orderNo}/ship  寫 [inventory, ordering]
    POST /api/seller/products  寫 [catalog, inventory]
    排程 OrderJobs.cancelExpired  寫 [inventory, ordering]
  交易內的同步呼叫：
    cart → InventoryApi.available
    catalog → InventoryApi.available
    catalog → InventoryApi.initialize
    catalog → InventoryApi.restock
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
    catalog → InventoryApi.initialize
    catalog → InventoryApi.restock
    catalog → InventoryApi.setHot
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
  變更耦合：8／36 個 commit（22.2%）
```

**「切斷的交易」那 7 行，每一行都是一個第 00 章 0.2.2 的孤兒來源。** 第 00 章只做了第一行（下單）。其他六行：

- **付款回呼**（`POST /api/payments/callback`）：一個交易裡寫了付款紀錄、訂單狀態（PAID）、預留狀態（HELD → CONFIRMED）。切開之後，付款與訂單成立了、預留沒有確認 —— 逾時排程會把一張**已付款**訂單的預留釋放掉（第 12 站 US-ORD-3 AC-4 防的就是這件事）。
- **出貨**（`ship`）：訂單變 SHIPPED、庫存的 `on_hand` 與 `reserved` 一起減。切開之後，兩邊各自 commit，中間失敗 = 出了貨、庫存沒扣，或反過來。
- **兩種取消、逾時排程**：訂單變 CANCELLED、預留釋放、（已付款的）退款單建立。切開之後，訂單取消了、庫存沒還 —— 0.2.2 的孤兒，換一個方向。
- **建立商品**（`POST /api/seller/products`）：**跟訂單無關的一個交易**。商品與它的期初庫存在同一個交易裡建立（12 站 1.5.2 的 `MANDATORY`）。切開之後，商品建立了、庫存列沒有 —— 這正是第 00 章 0.2.3 那個商品頁 500 的形狀（`EmptyResultDataAccessException`），只是這一次不是實驗的失誤，是正式的流程。

「交易內的同步呼叫」那 10 行，每一行都是 0.2.3 的級聯：呼叫端開著交易、佔著資料庫連線在等。第 00 章的 K3 量的是 `reserve()`；購物車、賣家的商品列表與編輯、補貨、標熱點 —— 它們全都在交易裡呼叫庫存。

**第 00 章那個商品頁的 500 其實是一個警告**：一個只讀的頁面，也多了一個跨服務的依賴。這一章要做的第一件事，是把「還有哪些」全部找出來，而且不是靠讀程式碼一行一行找 —— 是量出來。

接著是更重要的問題：**如果庫存這一刀這麼貴，哪一刀便宜？** 要回答它，得先有尺。

---

## 1.3 依業務能力切，還是依名詞切

### 1.3.1 兩種切法

拆服務的文章裡最常見的建議是「依業務能力（business capability）切」。這句話的反面比較好懂：**不要依名詞切**。

- **依名詞切**：系統裡有哪些東西 —— 商品、庫存、購物車、訂單、使用者 —— 一個名詞一個服務。好處是畫得很快；問題是**一個名詞會被很多件事用到**。「商品」被瀏覽用、被購物車用、被下單用、被報表用、被賣家管理用 —— 每一件事都要來問商品服務。
- **依業務能力切**：系統在**做**哪些事 —— 讓買家找到商品、收款、履約（預留、出貨、退貨）、通知、對帳與報表 —— 一件事一個服務，這件事需要的資料歸它管。一件事的規則與資料在同一個地方，所以改這件事，通常只改一個服務。

第 00 章 0.6.1 的 Segment 就是依名詞切的：每一種「目的地」一個服務。目的地有上百種，服務就有上百個；而它們做的其實是同一件事（把資料轉送出去），所以每一次改「轉送」這件事，就要改上百個服務。

兩種切法在畫架構圖的時候分不出好壞 —— 每一個方塊看起來都很合理。分得出來的地方在**執行的時候**：一個請求進來，要跨幾個方塊、在哪裡需要一個交易；以及**改程式的時候**：一個功能的改動，落在幾個方塊裡。這正是 1.4 的三把尺在量的東西。

### 1.3.2 第 12 站的九個模組是哪一種

第 12 站的九個模組是在第 12 站 1.4.2 一次畫好的，之後每一個模組擁有自己的表（12 站 1.6.4）—— 當時沒有用「能力」或「名詞」去想它。現在拿這兩個詞回頭看：

| 模組 | 擁有的表 | 比較像 | 從 1.2 與 1.5 的數字看得到的 |
|---|---|---|---|
| `account` | `users`、`user_roles`、`refresh_tokens` | 能力：身分與登入 | 沒有任何模組同步呼叫它 —— 驗證 JWT 不需要查 `users` 表（第 12 站 5.3.2）。只有 reporting 直接讀了一次 `users` |
| `catalog` | `products`、`categories` | 名詞：商品 | 被 cart、ordering 呼叫；它自己又呼叫 inventory 的 5 個方法 |
| `inventory` | `inventory`、`inventory_reservations`、`inventory_ledger`…… | 名詞：庫存 | **被三個模組呼叫，12 種呼叫（11 個方法）**；它的預留、確認、扣減、釋放都由訂單的狀態機觸發 |
| `cart` | `cart_items` | 名詞：購物車 | 呼叫 catalog、inventory；被 ordering 在下單交易裡清掉 |
| `ordering` | `orders`、`order_items`、`order_status_history`、`idempotency_keys` | 能力：下單與訂單生命週期 | 呼叫所有人；7 種跨模組交易裡，6 種是它開的 |
| `payment` | `payments`、`refunds` | 能力：收款與退款 | 只被 ordering 呼叫；收款與訂單狀態在同一個交易裡 |
| `notification` | `notifications` | 能力：通知 | **沒有任何同步呼叫**，只收事件 |
| `reporting` | （沒有自己的表） | 能力：報表 | 不呼叫任何人，直接讀別人的表（第 12 站 1.6.4 的例外） |
| `shared` | outbox、冪等消費、稽核 | 函式庫 | 拆開之後每個服務各帶一份 |

規律很明顯：**名詞模組被很多人呼叫，能力模組的介面很窄。** notification、account、reporting 跟別人之間幾乎沒有同步的線；inventory、catalog 被大家來問。

inventory 是最典型的名詞模組：除了賣家建立商品與補貨，「庫存」的每一個變化都是**別的事**造成的：下單造成預留、付款造成確認、出貨造成扣減、取消造成釋放。這些「別的事」全在 ordering 裡。用能力的說法，它們是同一件事：**履約**（把一張訂單從成立走到出貨或取消）。依名詞把「訂單」和「庫存」切成兩個服務，就是把一件事切成兩半 —— 1.2 的 7 種切斷的交易，有 6 種都是訂單生命週期的一步。

> 📌 **第 12 站把它們分成兩個模組沒有錯。** 模組之間可以共享一個交易（`MANDATORY`，12 站 1.5.2），所以「名詞模組」在單體裡沒有代價 —— 程式碼依名詞組織，讀起來清楚。問題只在**行程**的邊界上：交易過不去。**模組邊界可以依名詞畫，行程邊界不行。** 這是「先拆模組、再拆行程」的另一個理由：兩條邊界不一定要畫在同一個地方。

### 1.3.3 一個被名詞切散的能力：熱點商品

第 12 站第 06 章做了熱點商品：賣家把一個商品標成「熱點」，之後它的下單先過 Redis 的閘門，搶不到的人不碰 MySQL。這是一件事（**搶購**），但它的程式散在三個模組：

| 模組 | 它做的那一塊 |
|---|---|
| catalog | 存「這個商品是不是熱點」（`products.hot`）、賣家標熱點的 API；標的時候呼叫 `inventory.setHot()` 讓庫存建立 Redis 閘門 |
| ordering | 下單時先問 catalog「這些商品裡哪些是熱點」（`hotProducts`），把熱點品項拿去過閘門（`inventory.gateHot`），交易裡再分兩路寫（`reserve` 給一般品項、`holdHot` 給熱點品項），失敗時把閘門加回去（`returnHot`） |
| inventory | Redis 閘門本身、熱點的落帳（`settleHot`）、對帳、落帳失敗時發事件讓訂單取消 |

`products.hot` 這個欄位，**catalog 自己從來不用**：商品頁的回應裡沒有它（`ProductDetail` 沒有這個欄位），它唯一的用途是讓 ordering 決定要不要呼叫 inventory 的閘門。一個屬於庫存行為的旗標，存在商品的表上，由訂單模組轉手。

變更的歷史也是這個形狀：第 12 站做熱點的那個 commit（`ch06 cache, hot stock, rate limit, trending`）同時改了 catalog、inventory、ordering（它也包含快取、限流、熱門排行，不全是熱點）；把熱點落帳移出下單交易的那一個（`ch07: outbox, …, hot settlement out of tx, …`）同時改了 inventory、ordering。**搶購的規則每改一次，就要動兩三個模組。**

在一個行程裡，這只是「改的時候要多開幾個檔案」。如果庫存與目錄、訂單是三個服務，每一次改搶購就是三個服務一起改、一起部署，而且順序要對。

這一章**不修**它：要修，庫存模組得有自己的一份熱點旗標，而且下單時要能在不碰 MySQL 的情況下讀到它（ordering 現在是讀 catalog 的 Redis 快取）—— 等於在庫存模組裡再做一次第 12 站 6.4 的商品快取。那是另一個工程，這一章不做。這裡要記住的是**怎麼認出它**：一個功能的程式散在幾個模組、一個模組存著只有別人用的欄位、一個 commit 總是同時改這幾個模組。1.7 會把這些整理成症狀表。

---

## 1.4 三把尺

這一節做出量邊界的工具。全部放在 `src/test/java/com/example/shop/dist01/`，**正式程式碼一行都不用改** —— 跟第 00 章的實驗支架一樣，用開關（`lab.d01.probe`）才會出現。

| 尺 | 量什麼 | 怎麼量 | 檔案 |
|---|---|---|---|
| 第一把：同步呼叫 | 誰呼叫哪個模組的哪個方法；呼叫的那一刻，**呼叫端**有沒有開著交易 | Spring AOP：在每一個模組公開介面（`*Api`）的方法上記一筆 | `ApiTap.java` |
| 第二把：交易邊界 | 每一個 commit 了的交易，寫了哪些模組的表；哪一句 SQL 讀了**別的**模組的表 | MySQL 驅動的 query interceptor：每一句送出去的 SQL（包括 `commit`）都先經過它 | `SqlTap.java` |
| 第三把：變更耦合 | 歷史上的每一個 commit，同時改了哪幾個模組 | `git log`，規則跟 0.3.3 的腳本一樣 | `CutEvaluator.commitsOf()` |
| （跑的東西） | 一個使用者的一天：每一個功能走一兩次 | HTTP 打真的應用程式；事件與排程直接交付 | `D01Workload.java` |

另外兩個小檔案：`Probe`（三把尺量到的東西都記在這裡）、`OpTag`（「現在這個執行緒在做哪一個使用者動作」）。

### 1.4.0 開分支

```bash
cd shop
git switch -c d01 d00
mkdir -p src/test/java/com/example/shop/dist01
```

第 00 章的 `SplitLab` 是 package-private 的（它只給 `dist00` 自己用）。這一章的實驗在另一個套件，要回來用同一套支架，把 class 與幾個工具方法改成 `public`：

```diff
-final class SplitLab {
+public final class SplitLab {
-    static Connection root(String db) throws Exception {
+    public static Connection root(String db) throws Exception {
-    static void freshDatabase(String db) throws Exception {
+    public static void freshDatabase(String db) throws Exception {
-    static String url(String db) {
+    public static String url(String db) {
-    static long count(String db, String sql) throws Exception {
+    public static long count(String db, String sql) throws Exception {
-    static List<String> common(String db, int redisDb) {
+    public static List<String> common(String db, int redisDb) {
-    static int port(ConfigurableApplicationContext ctx) {
+    public static int port(ConfigurableApplicationContext ctx) {
-    static final HttpClient CLIENT = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(2)).build();
+    public static final HttpClient CLIENT = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(2)).build();
-    static String load() {
+    public static String load() {
```

（1.6.5 的 B2 還會再多用幾個，到時候一起改；完整的 `SplitLab` 在 1.9.1。）

> 📌 **第 12 站有三個追記，是寫這一章途中找到的**：6.4.3 的再追記（single-flight 的「讀了 2 次」）、4.6.2 的追記（取消時少退一筆錢，1.6.7）、5.6.4 的追記（`perIpLimit` 撞到整分鐘）。照著改了的話，這個分支也帶著它們 —— 這一章的實驗不依賴它們，但整套 `mvn clean verify` 會多三個測試（1.9）。

### 1.4.1 第一把：跨模組的同步呼叫

**先放一個記錄的地方。** 三把尺量到的東西都是 static 的 —— 第二把尺的 `SqlTap` 是 MySQL 驅動建的物件，不是 Spring 的 bean，拿不到注入：

```java
package com.example.shop.dist01;

import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentLinkedQueue;

/**
 * 13 站 1.4：三把尺量到的東西，全部記在這裡（static：SqlTap 是 MySQL 驅動建的，不是 Spring 的 bean）。
 *
 *   Call  ：一次跨模組的同步呼叫 —— 誰呼叫誰的哪一個方法、呼叫的時候「呼叫端」有沒有開著交易（ApiTap）
 *   Tx    ：一個 commit 了的交易 —— 寫了哪些模組的表、讀了哪些模組的表（SqlTap）
 *   Read  ：一句 SQL 讀了「別的模組」的表（SqlTap）
 *   Event ：一個事件交給了一個消費者 —— 發送的模組 → 消費的模組（D01Workload 交付事件時記）
 *
 * 每一筆都帶 op：這是哪一個使用者動作（HTTP 的 method + 路徑樣式）、哪一個事件消費者、哪一個排程造成的（OpTag）。
 */
final class Probe {

    private Probe() {}

    record Call(String op, String caller, String callee, String method, boolean inTx, boolean readOnlyTx) {}
    record Tx(String op, Set<String> wrote, Set<String> read, int statements) {}
    record Read(String op, String reader, String owner, String table) {}
    record Event(String op, String type, String publisher, String consumer, String consumerModule) {}

    static final ConcurrentLinkedQueue<Call> CALLS = new ConcurrentLinkedQueue<>();
    static final ConcurrentLinkedQueue<Tx> TXS = new ConcurrentLinkedQueue<>();
    static final ConcurrentLinkedQueue<Read> READS = new ConcurrentLinkedQueue<>();
    static final ConcurrentLinkedQueue<Event> EVENTS = new ConcurrentLinkedQueue<>();
    /** 走過的 HTTP 動作（路徑樣式）：工作負載有沒有漏掉哪一支 API */
    static final java.util.Set<String> OPS = java.util.concurrent.ConcurrentHashMap.newKeySet();

    static void reset() {
        CALLS.clear(); TXS.clear(); READS.clear(); EVENTS.clear(); OPS.clear();
    }

    /** 第 12 站 TableOwnershipTest 的那張表（12 站 1.6.4）。shared 的表（outbox、冪等消費、稽核）拆開之後每個服務各一份，不算「跨」 */
    static final Map<String, String> OWNER = Map.ofEntries(
            Map.entry("users", "account"), Map.entry("user_roles", "account"), Map.entry("refresh_tokens", "account"),
            Map.entry("products", "catalog"), Map.entry("categories", "catalog"),
            Map.entry("inventory", "inventory"), Map.entry("inventory_reservations", "inventory"), Map.entry("inventory_ledger", "inventory"),
            Map.entry("inventory_ledger_checkpoints", "inventory"), Map.entry("inventory_ledger_watermark", "inventory"),
            Map.entry("cart_items", "cart"),
            Map.entry("orders", "ordering"), Map.entry("order_items", "ordering"),
            Map.entry("order_status_history", "ordering"), Map.entry("idempotency_keys", "ordering"),
            Map.entry("payments", "payment"), Map.entry("refunds", "payment"),
            Map.entry("notifications", "notification"),
            Map.entry("outbox_events", "shared"), Map.entry("processed_messages", "shared"), Map.entry("audit_logs", "shared"));

    /** 可以被切開的八個模組（shared 是函式庫，拆開之後每個服務各帶一份） */
    static final List<String> MODULES = List.of("account", "cart", "catalog", "inventory", "notification", "ordering", "payment", "reporting");

    /**
     * 呼叫堆疊上，第一個屬於某個模組的 frame 是哪一個模組。
     * 跳過：Spring 產生的代理（類別名稱有 $$）、實驗與測試支援的套件、shared（outbox、事件分派是「代替某個模組」做事）。
     * 都沒有 → "shared"（例如事件分派器自己寫 processed_messages）。
     */
    static String moduleOnStack() {
        return StackWalker.getInstance().walk(s -> s
                .map(StackWalker.StackFrame::getClassName)
                .filter(c -> c.startsWith("com.example.shop.") && !c.contains("$$"))
                .map(c -> c.substring("com.example.shop.".length()))
                .map(c -> c.contains(".") ? c.substring(0, c.indexOf('.')) : "")
                .filter(MODULES::contains)
                .findFirst()).orElse("shared");
    }
}
```

兩個地方值得停一下：

- **`OWNER` 就是第 12 站 `TableOwnershipTest` 的那張表**（12 站 1.6.4）。shared 的三張表（outbox、冪等消費、稽核）不算任何一個模組的：拆開之後，每一個服務各有一份自己的 outbox。
- **`moduleOnStack()` 用呼叫堆疊判斷「現在是哪一個模組在做事」。** 從最裡面往外找第一個 `com.example.shop.<模組>` 的類別；跳過 Spring 產生的代理（類別名稱有 `$$`）、跳過 shared（outbox 的 `JdbcOutbox` 是**代替**下單的那個模組寫 outbox 的）。

**再放一個「這是哪一個動作」的標籤：**

```java
package com.example.shop.dist01;

/**
 * 13 站 1.4：「現在這個執行緒在做哪一個使用者動作」。
 * HTTP 請求由 ApiTap 的 HandlerInterceptor 在進入 controller 之前設定（method + 路徑樣式，例如 POST /api/orders/{orderNo}/cancel）；
 * 事件與排程不經過 HTTP，由 D01Workload 自己設定。沒有設定 = 背景執行緒（commit 之後的快取寫入、重試……）。
 */
final class OpTag {

    private OpTag() {}

    private static final ThreadLocal<String> CURRENT = new ThreadLocal<>();

    static String current() {
        String op = CURRENT.get();
        return op == null ? "(背景)" : op;
    }

    static void set(String op) { CURRENT.set(op); }

    static void clear() { CURRENT.remove(); }

    static void run(String op, Runnable r) {
        set(op);
        try {
            r.run();
        } finally {
            clear();
        }
    }
}
```

**然後是尺本身。** 在每一個模組公開介面的方法上記一筆：

```java
package com.example.shop.dist01;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.aopalliance.intercept.MethodInterceptor;
import org.springframework.aop.Advisor;
import org.springframework.aop.support.DefaultPointcutAdvisor;
import org.springframework.aop.support.StaticMethodMatcherPointcut;
import org.springframework.beans.factory.config.BeanDefinition;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Role;
import org.springframework.core.Ordered;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import org.springframework.util.ClassUtils;
import org.springframework.web.servlet.HandlerInterceptor;
import org.springframework.web.servlet.HandlerMapping;
import org.springframework.web.servlet.config.annotation.InterceptorRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

import java.lang.reflect.Method;
import java.util.Arrays;

/**
 * 13 站 1.4.1 第一把尺：跨模組的同步呼叫。每一次呼叫某個模組的公開介面（com.example.shop.<模組>.*Api），記下
 * 誰呼叫、呼叫誰的哪一個方法、呼叫的那一刻「呼叫端」有沒有開著交易。
 *
 * 做法：一個 Spring AOP 的 Advisor。第 12 站沒有 spring-boot-starter-aop，但 @Transactional 已經有一個自動代理建立器
 * （InfrastructureAdvisorAutoProxyCreator），它只收「基礎設施」角色的 Advisor —— 所以這個 bean 要標 @Role(ROLE_INFRASTRUCTURE)。
 * 排在最外層（HIGHEST_PRECEDENCE）：在被呼叫端的 @Transactional 開交易「之前」看，看到的才是呼叫端的交易。
 *
 * 只在 lab.d01.probe=true 時出現（0.9 的教訓：@Bean 方法跟著這個類別的條件走，不會被元件掃描單獨掃到）。
 */
@Configuration
@ConditionalOnProperty(name = "lab.d01.probe", havingValue = "true")
class ApiTap {

    @Bean
    @Role(BeanDefinition.ROLE_INFRASTRUCTURE)
    static Advisor d01ApiCallAdvisor() {
        MethodInterceptor record = inv -> {
            Class<?> api = apiOf(inv.getThis().getClass(), inv.getMethod());
            String callee = moduleOf(api);
            String caller = Probe.moduleOnStack();
            if (!caller.equals(callee))
                Probe.CALLS.add(new Probe.Call(OpTag.current(), caller, callee, api.getSimpleName() + "." + inv.getMethod().getName(),
                        TransactionSynchronizationManager.isActualTransactionActive(),
                        TransactionSynchronizationManager.isActualTransactionActive() && TransactionSynchronizationManager.isCurrentTransactionReadOnly()));
            return inv.proceed();
        };
        DefaultPointcutAdvisor advisor = new DefaultPointcutAdvisor(new StaticMethodMatcherPointcut() {
            @Override
            public boolean matches(Method method, Class<?> targetClass) {
                return apiOf(targetClass, method) != null;
            }
        }, record);
        advisor.setOrder(Ordered.HIGHEST_PRECEDENCE);
        return advisor;
    }

    /** 這個方法是哪一個模組公開介面（com.example.shop.<模組>.XxxApi）上的方法？不是 → null */
    static Class<?> apiOf(Class<?> targetClass, Method method) {
        for (Class<?> i : ClassUtils.getAllInterfacesForClassAsSet(targetClass)) {
            String n = i.getName();
            if (!n.startsWith("com.example.shop.") || !i.getSimpleName().endsWith("Api")) continue;
            if (n.substring("com.example.shop.".length()).split("\\.").length != 2) continue;     // 模組的根套件，不是 internal
            boolean declared = Arrays.stream(i.getMethods()).anyMatch(m -> m.getName().equals(method.getName())
                    && Arrays.equals(m.getParameterTypes(), method.getParameterTypes()));
            if (declared) return i;
        }
        return null;
    }

    static String moduleOf(Class<?> api) {
        return api.getName().split("\\.")[3];
    }

    /** HTTP 請求：進 controller 之前，把「這是哪一個動作」記在執行緒上（路徑樣式，不是實際的路徑：/api/orders/{orderNo}/cancel） */
    @Bean
    WebMvcConfigurer d01OpTagging() {
        return new WebMvcConfigurer() {
            @Override
            public void addInterceptors(InterceptorRegistry registry) {
                registry.addInterceptor(new HandlerInterceptor() {
                    @Override
                    public boolean preHandle(HttpServletRequest req, HttpServletResponse res, Object handler) {
                        Object pattern = req.getAttribute(HandlerMapping.BEST_MATCHING_PATTERN_ATTRIBUTE);
                        OpTag.set(req.getMethod() + " " + (pattern == null ? req.getRequestURI() : pattern));
                        Probe.OPS.add(OpTag.current());
                        return true;
                    }

                    @Override
                    public void afterCompletion(HttpServletRequest req, HttpServletResponse res, Object handler, Exception ex) {
                        OpTag.clear();
                    }
                });
            }
        };
    }
}
```

三個決定：

1. **為什麼是 `@Role(ROLE_INFRASTRUCTURE)` 的 Advisor，不是 `@Aspect`。** 第 12 站沒有 `spring-boot-starter-aop`（沒有 AspectJ），寫 `@Aspect` 不會有任何效果。但 `@Transactional` 本來就靠一個自動代理建立器運作 —— `InfrastructureAdvisorAutoProxyCreator`，它只收「基礎設施」角色的 Advisor。標上 `@Role(ROLE_INFRASTRUCTURE)`，它就會把這個 Advisor 跟交易的那一個一起包進同一個代理。方法是 `static`：Advisor 要在其他 bean 被代理**之前**就存在，`static` 的 `@Bean` 方法不需要先建出 `ApiTap` 這個設定類別。
2. **為什麼是 `HIGHEST_PRECEDENCE`。** 要看的是「**呼叫端**有沒有開著交易」。被呼叫的方法自己可能也有 `@Transactional`（`InventoryApi.reserve()` 是 `MANDATORY`、`available()` 是 `readOnly`）—— 這個 Advisor 排在最外層，在它們開交易之前就看完了。`isActualTransactionActive()` 包含唯讀交易：唯讀交易一樣佔著一條資料庫連線（0.2.3 的級聯不分讀寫），所以一起算，另外再記一個 `readOnlyTx`。
3. **動作的名字用路徑樣式**（`BEST_MATCHING_PATTERN_ATTRIBUTE`）：`POST /api/orders/{orderNo}/cancel`，而不是 `/api/orders/20261012-538337/cancel` —— 同一個動作的每一次請求，算在同一行。它要在 `HandlerInterceptor` 裡取，不是 servlet filter：filter 執行的時候，Spring MVC 還沒決定由哪一個 controller 處理。

> ⚠️ **整個類別、包括 `@Bean` 方法，都在 `@ConditionalOnProperty` 底下。** 第 00 章 0.9 的教訓是 static 巢狀的 `@RestController` 會被元件掃描**單獨**掃到；這裡沒有巢狀的元件，只有 `@Bean` 方法 —— 它們跟著外層類別的條件走。整套 `mvn clean verify` 裡，第 12 站的 `SecurityRouteCoverageTest` 與 `OpenApiContractTest` 都沒有因為它變紅（1.9）。

### 1.4.2 第二把：交易邊界

第一把尺看得到「誰呼叫誰」，看不到「這些呼叫最後寫了哪些表、是不是同一個交易」。要知道一個交易寫了什麼，最直接的地方是 **SQL 送出去的那一刻**。

MySQL 的 JDBC 驅動（Connector/J）有一個掛勾：`queryInterceptors`。在 JDBC URL 加一個參數，驅動就會替**每一條連線**建一個你的物件，每一句要送到 MySQL 的 SQL 都先經過它 —— 包括 Spring 交易結束時的 `commit` 與 `rollback`：

```java
package com.example.shop.dist01;

import com.mysql.cj.MysqlConnection;
import com.mysql.cj.Query;
import com.mysql.cj.interceptors.QueryInterceptor;
import com.mysql.cj.log.Log;
import com.mysql.cj.protocol.Resultset;
import com.mysql.cj.protocol.ServerSession;

import java.sql.Connection;
import java.util.HashSet;
import java.util.Properties;
import java.util.Set;
import java.util.function.Supplier;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 13 站 1.4.2 第二把尺：交易邊界。MySQL 驅動（Connector/J）的 query interceptor —— 每一句送到 MySQL 的 SQL 都會先經過這裡，
 * 包括 Spring 交易結束時的 commit、rollback。不用改任何一行正式程式碼，也不用包 DataSource：在 JDBC URL 加一個參數就好
 *   jdbc:mysql://…/shop_d01?…&queryInterceptors=com.example.shop.dist01.SqlTap
 *
 * 驅動替「每一條連線」建一個 SqlTap，所以「這條連線上、從上一次 commit 到這一次 commit 之間寫了哪些表」就是一個交易。
 * 表 → 模組用第 12 站的擁有者表（Probe.OWNER）；shared 的表不算。
 */
public class SqlTap implements QueryInterceptor {

    /** INSERT INTO t、REPLACE INTO t、UPDATE t、DELETE FROM t、DELETE x FROM t */
    private static final Pattern WRITE = Pattern.compile(
            "(?is)^\\s*(?:insert\\s+(?:ignore\\s+)?into|replace\\s+into|update|delete\\s+(?:\\w+\\s+)?from)\\s+`?(\\w+)`?");
    private static final Pattern READ = Pattern.compile("(?i)\\b(?:from|join)\\s+`?(\\w+)`?");

    private Connection conn;
    private final Set<String> wrote = new HashSet<>(), read = new HashSet<>();
    private int statements;
    private String op;

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
        if (t.equalsIgnoreCase("commit")) { flush(true); return null; }
        if (t.equalsIgnoreCase("rollback")) { flush(false); return null; }

        String written = null;
        Matcher w = WRITE.matcher(t);
        if (w.find() && Probe.OWNER.containsKey(w.group(1).toLowerCase())) written = w.group(1).toLowerCase();
        Set<String> readTables = new HashSet<>();
        Matcher r = READ.matcher(t);
        while (r.find()) {
            String table = r.group(1).toLowerCase();
            if (Probe.OWNER.containsKey(table) && !table.equals(written)) readTables.add(table);
        }
        if (written == null && readTables.isEmpty()) return null;            // SET、SELECT 1、SHOW……

        String module = Probe.moduleOnStack();
        if (op == null) op = OpTag.current();
        statements++;
        if (written != null && !Probe.OWNER.get(written).equals("shared")) wrote.add(Probe.OWNER.get(written));
        for (String table : readTables) {
            String owner = Probe.OWNER.get(table);
            if (owner.equals("shared")) continue;
            read.add(owner);
            if (!module.equals("shared") && !module.equals(owner)) Probe.READS.add(new Probe.Read(OpTag.current(), module, owner, table));
        }
        if (autoCommit()) flush(true);                                       // 沒有交易：一句就是一個交易
        return null;
    }

    private boolean autoCommit() {
        try {
            return conn.getAutoCommit();
        } catch (Exception e) {
            return true;
        }
    }

    private void flush(boolean committed) {
        if (committed && statements > 0) Probe.TXS.add(new Probe.Tx(op, Set.copyOf(wrote), Set.copyOf(read), statements));
        wrote.clear();
        read.clear();
        statements = 0;
        op = null;
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

- **一條連線一個 `SqlTap`**，所以「這條連線上，從上一次 `commit` 到這一次 `commit` 之間寫了哪些表」就是一個交易。連線池把連線借給下一個請求之前，上一個交易一定已經 commit 或 rollback 了。
- **沒有開交易的 SQL**（autocommit）一句就是一個交易：`conn.getAutoCommit()` 是 true 就立刻記一筆。
- **只認得 `OWNER` 裡的表。** `SET autocommit=0`、`SELECT 1`、Flyway 自己的表都會被略過。
- **讀了別的模組的表**，記一筆 `Read`（讀的模組用 `moduleOnStack()`）。第 12 站只有一個模組會這樣做：reporting（12 站 1.6.4 的例外）。

> 📌 **它看不到 Redis。** 熱點商品的閘門（`gateHot`）只動 Redis，第二把尺看不到它 —— 第一把尺看得到（它是一次 `InventoryApi` 的呼叫）。三把尺各有盲點，所以要一起看。

### 1.4.3 第三把：變更耦合

第 00 章 0.3.3 已經有一支腳本。這一章要拿同一份資料算 127 種切法，所以在 Java 裡再讀一次 `git log`，規則一模一樣 —— 一個 commit「碰了一個模組」= 改了 `src/main/java/com/example/shop/<模組>/` 底下的檔案，或是檔名 `V<n>__<模組>_….sql` 的 migration：

```java
    // ───────── 第三把尺：git 歷史（跟 0.3.3 的 d00-change-coupling.sh 同一套規則）─────────

    private static final Pattern SRC = Pattern.compile("^src/main/java/com/example/shop/([a-z]+)/");
    private static final Pattern MIGRATION = Pattern.compile("^src/main/resources/db/migration/V[0-9]+__([a-z]+)_");

    static List<Set<String>> commitsOf(String range) throws Exception {
        Process p = new ProcessBuilder("git", "log", "--first-parent", "--no-merges", "--name-only", "--format=@%h", range)
                .redirectErrorStream(true).start();
        List<Set<String>> result = new ArrayList<>();
        Set<String> current = null;
        try (BufferedReader r = new BufferedReader(new InputStreamReader(p.getInputStream(), StandardCharsets.UTF_8))) {
            for (String line; (line = r.readLine()) != null; ) {
                if (line.startsWith("@")) {
                    if (current != null && !current.isEmpty()) result.add(current);
                    current = new HashSet<>();
                    continue;
                }
                Matcher m = SRC.matcher(line);
                if (m.find() && current != null) { current.add(m.group(1)); continue; }
                m = MIGRATION.matcher(line);
                if (m.find() && current != null) current.add(m.group(1));
            }
        }
        if (current != null && !current.isEmpty()) result.add(current);
        if (p.waitFor() != 0) throw new IllegalStateException("git log " + range + " 失敗");
        return result;
    }
```

### 1.4.4 工作負載：使用者的一天

尺要量東西，得有東西跑。`D01Workload` 把第 12 站的每一個功能走一兩次，全部走 HTTP（跟真的客戶端一樣：JWT、冪等鍵、付款回呼的簽章都是真的）：

| 段落 | 走了什麼 |
|---|---|
| 帳號 | 註冊、登入、換發 token、`/api/me`；管理員把一個人設成賣家、把另一個人停權 |
| 商品 | 賣家上架 4 個商品（其中一個標成熱點、一個上架後下架）、改說明、補貨、看自己的商品 |
| 逛 | 搜尋、兩次商品詳情（一般、熱點）、熱門排行 |
| 購物車 | 加入、改數量、加入再刪除、看購物車 |
| 訂單 1 | 一般商品：下單 → 付款 → 撿貨 → 出貨 → 確認收貨；看「我的訂單」與訂單詳情 |
| 訂單 2 | 熱點商品：下單（過 Redis 閘門）→ 付款 → 買家取消 → 退款 |
| 訂單 3 | 付款之後，賣家取消（缺貨）→ 退款 |
| 訂單 4 | 不付款，逾時取消（排程） |
| 訂單 5 | 出貨之後不確認，自動完成（排程） |
| 訂單 6 | 熱點商品，但 MySQL 的可售量被人為歸零：Redis 的閘門放行 → 落帳發現不夠 → `inventory.hot-settlement-failed` → 訂單模組取消訂單（第 12 站 7.6.3） |
| 報表 | 賣家的日報與熱銷、管理員的日報（含 `groupBy=seller`）與熱銷 |
| 庫存的排程 | 熱點對帳、不變式檢查 |

**事件不經過 RabbitMQ。** 第 00 章的支架把 relay 與消費者都關了（`SplitLab.common()`）；這裡跟第 12 站 7.12.1 的 `InlineEvents` 同一個做法 —— 從 outbox 讀出還沒送的事件，直接交給訂閱它的每一個 `EventHandler`，並且把這一次交付標成「事件 X → 消費者 Y」：

```java
    /** outbox 裡還沒送出的事件，交給訂閱它的每一個消費者（不經過 RabbitMQ），直到沒有新的事件。每一次交付標成「事件 X → 消費者」 */
    private void events() throws Exception {
        EventDispatcher dispatcher = ctx.getBean(EventDispatcher.class);
        Map<String, EventHandler> handlers = ctx.getBeansOfType(EventHandler.class);
        for (int round = 0; round < 10; round++) {
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
            if (pending.isEmpty()) return;
            for (Event e : pending)
                for (EventHandler h : handlers.values())
                    if (h.eventTypes().contains(e.type())) {
                        String consumerModule = moduleOfClass(AopTestUtils.getUltimateTargetObject(h).getClass().getName());
                        Probe.EVENTS.add(new Probe.Event("事件 " + e.type() + " → " + h.consumer(), e.type(), publisherOf(e.type()), h.consumer(), consumerModule));
                        OpTag.run("事件 " + e.type() + " → " + h.consumer(), () -> dispatcher.dispatch(h, e));
                    }
            for (long id : ids) sql("UPDATE outbox_events SET published_at = NOW(3) WHERE id = ?", id);
        }
        throw new IllegalStateException("事件一直產生新的事件，交付了 10 輪還沒停");
    }
```

**排程也直接呼叫。** 排程的方法是 package-private 的（第 12 站沒打算讓別人呼叫它們），實驗用反射：

```java
    /** 排程的方法是 package-private（第 12 站沒有打算讓別人呼叫它們）：實驗用反射直接呼叫，標成「排程 X」 */
    private void job(String op, String bean, String method) {
        Object target = AopTestUtils.getUltimateTargetObject(ctx.getBean(bean));
        OpTag.run(op, () -> ReflectionTestUtils.invokeMethod(target, method));
        steps.add(new Step(op, 0));
    }
```

> ⚠️ **小坑：`OrderJobs` 只在 `shop.order.jobs-enabled=true` 時存在。** 第 00 章的支架把排程關掉了（`--shop.order.jobs-enabled=false`），第一次跑 B1 就停在 `No bean named 'orderJobs' available`。改成打開排程、間隔拉到 1 小時：排程啟動時會自己先跑一次（空的資料庫，什麼都不做），等 1 秒再把記錄清空，之後它不會再自己跑。

> ⚠️ **寫這一章途中被自己的實驗抓到的：第一版的工作負載少走了 3 支 API。** 停權、下架、從購物車刪除，第一版都沒有；管理員日報也只打了不帶 `groupBy` 的那一種。那一版的結果裡，account 的五個數字全是 0 —— 「account 跟誰都沒有關係」。補齊之後，`GET /api/admin/reports/daily-sales?groupBy=seller` 走到了 reporting 裡**唯一**一句 `JOIN users` 的 SQL：account 多了一條「被 reporting 直接讀表」的線。所以 B1 現在會印出「走過的 API」，拿去跟第 12 站 `SecurityRouteCoverageTest` 的那張表比 —— 八個模組的 API 一共 35 支（`/api/ping` 與管理員看稽核、死信的 3 支屬於 shared，不算），35 支都要在。**量邊界的工具只量得到你走過的路；你沒走到的那一條，在報表上就是「沒有耦合」。**

### 1.4.5 跑起來：B1

`B1BoundaryMapTest` 起一個第 12 站的單體（一個行程、一個資料庫 `shop_d01`，跟第 00 章的三個庫分開），JDBC URL 多帶 `queryInterceptors`，打開 `lab.d01.probe`，然後跑工作負載：

```java
        SplitLab.freshDatabase(DB);
        List<String> args = new ArrayList<>(SplitLab.common(DB, 14));
        args.removeIf(a -> a.startsWith("--spring.datasource.url="));        // 同一個參數給兩次，Spring 會把兩個值用逗號接起來
        args.add("--spring.datasource.url=" + SplitLab.url(DB) + "&queryInterceptors=" + SqlTap.class.getName());
        args.add("--lab.d01.probe=true");
        args.removeIf(a -> a.startsWith("--shop.order.jobs-enabled="));    // 要有 OrderJobs 這個 bean（逾時、自動完成），間隔拉長到不會自己跑第二次
        args.addAll(List.of("--shop.order.jobs-enabled=true", "--shop.order.timeout-scan-interval=1h"));
        D01Workload w;
        try (ConfigurableApplicationContext ctx = new SpringApplicationBuilder(ShopApplication.class).run(args.toArray(String[]::new))) {
            Thread.sleep(1000);                                              // 排程在啟動時各跑一次（空的資料庫）：等它跑完
            // 資料庫每次重建，商品與使用者的 id 每次都從同一個號碼開始 —— Redis 不清的話，上一次執行的熱門排行、商品快取、熱點閘門都還在。
            // 第一版沒有清：同一份程式碼連跑兩次，第二次的熱門排行走了快取，「讀別人的表」少了 3 句
            ctx.getBean(org.springframework.data.redis.core.StringRedisTemplate.class).execute((org.springframework.data.redis.core.RedisCallback<Void>) c -> {
                c.serverCommands().flushDb();
                return null;
            });
            Probe.reset();                                                   // Flyway、啟動時的查詢、排程的第一次都不算
            w = new D01Workload(ctx, DB);
            w.run();
        }
```

> ⚠️ **那一段 `flushDb()` 是後來加的。** 第一版沒有它：同一份程式碼連跑兩次，第二次「讀別人的表」少了 3 句、「commit 的交易」少了 1 個。原因是 B1 每次重建資料庫，商品、使用者的 id 每次都從同一個號碼開始，而 Redis 的 14 號 database 還留著上一次的東西 —— 熱門排行的快取讓 `GET /api/products/trending` 根本沒有查 MySQL。同樣留著的還有商品快取與熱點商品的閘門（`stock:hot:{id}`，數量是上一次剩下的）。**量測要可以重複，每一次都要從同一個狀態開始，資料庫與快取都是。**

```bash
mvn test -Pexperiments -Dtest=B1BoundaryMapTest -Dd01.range=ch09      # ch09：你第 12 站結束時的分支或 tag（變更耦合用）
```

約 10 秒。前半段的輸出是三把尺量到的每一條線：

```
═══ 1.4 使用者的一天：61 個 HTTP 請求、31 次事件交付、4 個排程（load { 4.86 5.40 5.96 }）═══
  記到：跨模組的同步呼叫 84 次、commit 的交易 191 個、讀別人的表 18 句
  走過的 API：35 支 [DELETE /api/cart/items/{productId}, GET /api/admin/reports/daily-sales, GET /api/admin/reports/top-products, GET /api/cart, GET /api/me, GET /api/orders, GET /api/orders/{orderNo}, GET /api/products, GET /api/products/trending, GET /api/products/{id}, GET /api/seller/orders, GET /api/seller/products, GET /api/seller/reports/daily-sales, GET /api/seller/reports/top-products, PATCH /api/cart/items/{productId}, PATCH /api/seller/products/{id}, POST /api/admin/users/{id}/roles, POST /api/admin/users/{id}/suspend, POST /api/auth/login, POST /api/auth/refresh, POST /api/auth/register, POST /api/cart/items, POST /api/orders, POST /api/orders/{orderNo}/cancel, POST /api/orders/{orderNo}/confirm-receipt, POST /api/orders/{orderNo}/payments, POST /api/payments/callback, POST /api/seller/orders/{orderNo}/cancel, POST /api/seller/orders/{orderNo}/ship, POST /api/seller/orders/{orderNo}/start-picking, POST /api/seller/products, POST /api/seller/products/{id}/hot, POST /api/seller/products/{id}/publish, POST /api/seller/products/{id}/restock, POST /api/seller/products/{id}/unpublish]
═══ 1.4.1 第一把尺：跨模組的同步呼叫（呼叫端 → 介面.方法：次數，其中幾次在呼叫端的交易裡；哪些動作）═══
  cart → CatalogApi.snapshots                   9 次（交易裡  9，唯讀  1）  [DELETE /api/cart/items/{productId}, GET /api/cart, PATCH /api/cart/items/{productId}, POST /api/cart/items]
  cart → InventoryApi.available                 6 次（交易裡  6，唯讀  1）  [DELETE /api/cart/items/{productId}, GET /api/cart, PATCH /api/cart/items/{productId}, POST /api/cart/items]
  catalog → InventoryApi.available              9 次（交易裡  9，唯讀  1）  [GET /api/seller/products, PATCH /api/seller/products/{id}, POST /api/seller/products/{id}/hot, POST /api/seller/products/{id}/publish, POST /api/seller/products/{id}/restock, POST /api/seller/products/{id}/unpublish]
  catalog → InventoryApi.availableForDisplay    2 次（交易裡  0，唯讀  0）  [GET /api/products/{id}]
  catalog → InventoryApi.initialize             4 次（交易裡  4，唯讀  0）  [POST /api/seller/products]
  catalog → InventoryApi.restock                1 次（交易裡  1，唯讀  0）  [POST /api/seller/products/{id}/restock]
  catalog → InventoryApi.setHot                 1 次（交易裡  1，唯讀  0）  [POST /api/seller/products/{id}/hot]
  ordering → CartApi.removeItems                6 次（交易裡  6，唯讀  0）  [POST /api/orders]
  ordering → CatalogApi.hotProducts             6 次（交易裡  0，唯讀  0）  [POST /api/orders]
  ordering → CatalogApi.snapshots               6 次（交易裡  6，唯讀  0）  [POST /api/orders]
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
  POST /api/seller/products  寫 [catalog, inventory]                                          × 4
  排程 OrderJobs.cancelExpired  寫 [inventory, ordering]                                        × 1
  （commit 的交易一共 191 個，寫了兩個以上模組的 19 個）
═══ 1.4.2 一句 SQL 讀了別的模組的表（讀的模組 → 表：句數；哪些動作）═══
  reporting → orders（ordering）                  7 句  [GET /api/admin/reports/daily-sales, GET /api/admin/reports/top-products, GET /api/products/trending, GET /api/seller/reports/daily-sales, GET /api/seller/reports/top-products]
  reporting → order_items（ordering）             3 句  [GET /api/admin/reports/top-products, GET /api/products/trending, GET /api/seller/reports/top-products]
  reporting → products（catalog）                 3 句  [GET /api/admin/reports/top-products, GET /api/products/trending, GET /api/seller/reports/top-products]
  reporting → refunds（payment）                  4 句  [GET /api/admin/reports/daily-sales, GET /api/seller/reports/daily-sales]
  reporting → users（account）                    1 句  [GET /api/admin/reports/daily-sales]
═══ 事件：發送的模組 → 消費者（消費者所在的模組）═══
  inventory ─ inventory.stock-returned → inventory.hot-stock-return（inventory）   × 4
  ordering ─ order.placed → notification.order-events（notification）              × 6
  ordering ─ order.placed → inventory.hot-settlement（inventory）                  × 6
  ordering ─ order.paid → notification.order-events（notification）                × 4
  ordering ─ order.shipped → notification.order-events（notification）             × 2
  payment ─ refund.requested → payment.refunds（payment）                          × 2
  ordering ─ order.cancelled → notification.order-events（notification）           × 4
  payment ─ refund.succeeded → notification.order-events（notification）           × 2
  inventory ─ inventory.hot-settlement-failed → ordering.stock-shortage（ordering） × 1
```

**怎麼讀：**

- **第一把尺的 20 行，就是第 12 站模組之間所有的同步線。** 呼叫端只有 cart、catalog、ordering 三個；被呼叫的只有 cart、catalog、inventory、payment 四個。account、notification、reporting 跟任何人之間都沒有同步呼叫。
- **「交易裡」的比例高得驚人。** 20 種呼叫裡 17 種至少有一次發生在呼叫端的交易裡；而且大多是**寫的交易**，不是唯讀的（「唯讀」那一欄幾乎都是 0）—— 例如賣家改商品說明，商品的 UPDATE 與「去問庫存還剩多少」在同一個交易裡。在一個行程裡這沒有任何代價；1.6 會回來處理它。
- **第二把尺：寫了兩個以上模組的交易一共 7 種**（19 個）。除了建立商品，其他 6 種都是 ordering 開的。
- **讀別人的表的，全是 reporting**；連 `GET /api/products/trending`（熱門排行，看起來是商品的功能）也是 reporting 在讀 `orders`、`order_items`、`products`。
- **事件**：9 種「發送 → 消費」的組合，跨模組的有 7 種（`stock-returned → hot-stock-return`、`refund.requested → payment.refunds` 是模組自己發、自己收）。

---

## 1.5 127 種切法

### 1.5.1 一刀切斷什麼：五個數字

「一刀」= 八個模組分成兩邊：一邊（S）變成另一個服務 —— 另一個行程、另一個資料庫 —— 另一邊留在原地。ordering 是這個系統的中心，固定留在原地；S 就是其他七個模組的任何一個非空子集：2⁷ − 1 = **127 種**。

每一種切法，用三把尺量到的東西算出五個數字：

| 數字 | 意思 | 切開之後的代價 | 解決在 |
|---|---|---|---|
| **切斷的交易** | 有幾種動作，它的一個交易寫了兩邊的表 | 0.2.2：一個交易變兩個，中間失敗就不一致 | 第 04 章（Saga） |
| **交易內呼叫** | 有幾種跨過這一刀的呼叫，發生在呼叫端的交易裡 | 0.2.3：等遠端的時候佔著連線，一邊慢、兩邊倒 | 1.6、第 04、06 章 |
| **同步呼叫** | 有幾種跨過這一刀的呼叫 | 0.2.1：每一種都是網路往返；介面粒度不對就乘上 n | 第 03 章 |
| **直接讀表** | 有幾種「一句 SQL 讀了另一邊的表」 | 那句 SQL 切開之後不存在 | 第 02、05 章 |
| **變更耦合** | 改到正式程式碼的 commit 裡，同時改了兩邊的比例 | 0.3.3：兩個服務一起改、一起部署 | 第 01 章（現在） |

另外記一個**事件**：跨過這一刀的事件有幾種。它不計分 —— 事件本來就是非同步的、本來就走 outbox（第 12 站第 07 章），切開之後把「直接交給消費者」換成真的 broker 就好。**事件是切開之後最便宜的那一種線。**

數的是**種類**，不是次數：工作負載裡每個動作只走一兩次，「下單切斷了 6 次」只代表下單走了 6 次。

排名的順序是有意的 —— 先比會**弄錯資料**的，再比會**弄倒服務**的，再比會**變慢**的，最後才是**改起來麻煩**的：

```java
    static final Comparator<Score> RANK = Comparator.<Score>comparingInt(s -> s.brokenTx().size())
            .thenComparingInt(s -> s.inTxCalls().size())
            .thenComparingInt(s -> s.calls().size())
            .thenComparingInt(s -> s.reads().size())
            .thenComparingDouble(Score::changePct);

    private final List<Set<String>> commits;                                 // 每一個改到正式程式碼的 commit 碰了哪些模組（不含 shared）

    CutEvaluator(List<Set<String>> commits) {
        this.commits = commits;
    }

    List<Score> all() {
        List<String> movable = Probe.MODULES.stream().filter(m -> !m.equals("ordering")).toList();
        List<Score> scores = new ArrayList<>();
        for (int mask = 1; mask < (1 << movable.size()); mask++) {
            Set<String> cut = new TreeSet<>();
            for (int i = 0; i < movable.size(); i++) if ((mask & (1 << i)) != 0) cut.add(movable.get(i));
            scores.add(score(cut));
        }
        scores.sort(RANK);
        return scores;
    }

    Score score(Set<String> cut) {
        Set<String> brokenTx = new TreeSet<>(), inTx = new TreeSet<>(), calls = new TreeSet<>(), reads = new TreeSet<>(), events = new TreeSet<>();
        for (Probe.Tx t : Probe.TXS)
            if (crosses(t.wrote(), cut)) brokenTx.add(t.op() + "  寫 " + new TreeSet<>(t.wrote()));
        for (Probe.Call c : Probe.CALLS)
            if (cut.contains(c.caller()) != cut.contains(c.callee())) {
                String k = c.caller() + " → " + c.method();
                calls.add(k);
                if (c.inTx()) inTx.add(k);
            }
        for (Probe.Read r : Probe.READS)
            if (cut.contains(r.reader()) != cut.contains(r.owner())) reads.add(r.reader() + " 讀 " + r.table());
        for (Probe.Event e : Probe.EVENTS)
            if (!e.consumerModule().equals("shared") && cut.contains(e.publisher()) != cut.contains(e.consumerModule()))
                events.add(e.type() + " → " + e.consumer());
        int crossing = (int) commits.stream().filter(m -> crosses(m, cut)).count();
        return new Score(cut, brokenTx, inTx, calls, reads, events, crossing, commits.size());
    }
```

變更耦合放最後，還有一個理由：它是這門課的參考實作的 git 歷史，粒度很粗（0.3.3 的 ⚠️），是五個數字裡最弱的證據。

### 1.5.2 結果

B1 的後半段：

```
═══ 1.5 127 種切法（ordering 留在原地，S 切出去）；變更耦合：ch09，36 個改到正式程式碼的 commit ═══
  名次 │ 切出去的 S                          │ 切斷的交易 │ 交易內呼叫 │ 同步呼叫 │ 直接讀表 │ 事件 │ 變更耦合
     1 │ notification                        │          0 │          0 │        0 │        0 │    5 │   8.3%（3）
     2 │ account                             │          0 │          0 │        0 │        1 │    0 │  11.1%（4）
     3 │ account+notification                │          0 │          0 │        0 │        1 │    5 │  13.9%（5）
     4 │ account+reporting                   │          0 │          0 │        0 │        4 │    0 │  19.4%（7）
     5 │ account+notification+reporting      │          0 │          0 │        0 │        4 │    5 │  22.2%（8）
     6 │ reporting                           │          0 │          0 │        0 │        5 │    0 │  11.1%（4）
     7 │ notification+reporting              │          0 │          0 │        0 │        5 │    5 │  16.7%（6）
     8 │ cart                                │          1 │          3 │        3 │        0 │    0 │  11.1%（4）
     9 │ cart+notification                   │          1 │          3 │        3 │        0 │    5 │  13.9%（5）
    10 │ account+cart                        │          1 │          3 │        3 │        1 │    0 │  16.7%（6）
    11 │ account+cart+notification           │          1 │          3 │        3 │        1 │    5 │  19.4%（7）
    12 │ account+cart+reporting              │          1 │          3 │        3 │        4 │    0 │  22.2%（8）
    16 │ catalog                             │          1 │          6 │        8 │        1 │    0 │  25.0%（9）
    32 │ payment                             │          3 │          4 │        4 │        1 │    1 │  19.4%（7）
    72 │ catalog+inventory                   │          6 │          8 │       10 │        1 │    2 │  25.0%（9）
    96 │ inventory                           │          7 │         10 │       12 │        0 │    2 │  22.2%（8）
  （127 種全部：target/d01-cuts.txt）
  包含 inventory 的 64 種切法：切斷的交易最少 6 種；前三名：
    第  64 名 cart+catalog+inventory              交易 6、交易內呼叫 7、同步呼叫 9
    第  65 名 cart+catalog+inventory+notification 交易 6、交易內呼叫 7、同步呼叫 9
    第  66 名 account+cart+catalog+inventory      交易 6、交易內呼叫 7、同步呼叫 9
```

（只印前 12 名與幾個指定的切法；127 種全部寫在 `target/d01-cuts.txt`。）

**前 7 名都是 notification、account、reporting 的組合**：0 種切斷的交易、0 種同步呼叫。它們跟其他模組之間只有兩種線：事件（notification）、直接讀表（reporting 讀 5 張表；account 被 reporting 讀了 `users`）。

- **第 1 名 notification**：只有 5 種事件跨過去，變更耦合 8.3%（36 個 commit 裡 3 個）。它在第 12 站本來就是「只收事件」的消費者（第 12 站 7.3.2），切出去幾乎是免費的。
- **reporting 排在 account 後面**，因為它有 5 種直接讀表 —— 報表要 JOIN 訂單、明細、商品、退款、使用者。切出去之後，這些 JOIN 都要換成別的東西（第 05 章的讀模型）。
- **cart 第 8**：1 種切斷的交易（下單時清購物車，跟訂單同一個交易）、3 種同步呼叫。
- **catalog 第 16**：1 種切斷的交易（建立商品，連同期初庫存），但有 6 種交易內的呼叫 —— 它是名詞模組，下單、購物車都在交易裡問它。
- **payment 第 32**：3 種切斷的交易（付款回呼、兩種取消 —— 收款與退款都跟訂單狀態在同一個交易裡）。
- **inventory 第 96**：7、10、12、0。

**每一種把 inventory 切出去的切法，都至少切斷 6 種交易。** 把 catalog、cart 一起帶走也一樣（上面最後那幾行）：建立商品那一種跟著回到同一邊，訂單生命週期的 6 種還在。**只要 ordering 留在原地，庫存就切不乾淨** —— 1.3.2 說的「履約是同一件事」，這是它的數字。

### 1.5.3 聚合與交易邊界：預留屬於誰

為什麼庫存跟訂單分不開？看 1.2 的那 6 種交易，它們都在同時改兩樣東西：**訂單的狀態**與**預留的狀態**。

| 動作 | 訂單 | 預留 | 庫存數量 |
|---|---|---|---|
| 下單 | 建立（PENDING_PAYMENT） | 建立（HELD） | `reserved` 增加 |
| 付款回呼 | → PAID | HELD → CONFIRMED | 不變 |
| 出貨 | → SHIPPED | CONFIRMED → CONSUMED | `on_hand`、`reserved` 一起減 |
| 取消、逾時 | → CANCELLED | → RELEASED | `reserved` 減少 |

DDD 把「每一個交易結束時必須一致的一組資料」叫做一個**聚合**（aggregate），常見的經驗法則是：**一個交易只改一個聚合；聚合之間，用最終一致**。用這個詞看第 12 站：

- **訂單**是一個聚合：`orders`、`order_items`、`order_status_history` 必須一起一致。
- **一個商品的庫存**是一個聚合：`inventory` 那一列的 `on_hand`、`reserved`，加上它的帳 —— 第 12 站 INV-2 說 `reserved` 必須等於所有計入的有效預留的總和。
- **預留**（`inventory_reservations` 的一列）**同時被兩條規則綁著**：INV-2 把它跟庫存綁在一起；而「每一筆有效預留都屬於一張有效的訂單、PAID 的訂單它的預留必須是 CONFIRMED」把它跟訂單綁在一起（0.2.2 那句「合起來是錯的」，說的就是後面這一條）。

第 12 站用一個交易同時改訂單與庫存，兩條規則都免費成立。**切開之後，預留不管放在哪一邊，總有一條規則要跨過那一刀。** 這就是 1.5.2 那個「至少 6 種」的來源，它不是程式寫得不好 —— 是這個業務本身的形狀。

只剩兩條路：

1. **不要在這裡切。** 「下單與履約」留在同一個服務裡（1.3.2 的能力觀點）。
2. **選一條規則改成最終一致**：讓預留跟庫存在同一個交易裡（庫存服務內部一致），訂單與預留之間用一連串有補償的步驟收斂 —— 這就是 **Saga**（第 04 章）。

> 📌 **第 12 站其實已經在單體裡做過一次第 2 條路。** 熱點商品的落帳（第 12 站 7.6）：下單交易只寫一列 `counted = FALSE` 的預留，`reserved` 由消費者**之後**才加；不夠的時候發 `inventory.hot-settlement-failed`，訂單模組收到之後取消訂單。這就是一個兩步的 Saga，連補償都有。它在單體裡是為了避開熱點列的鎖（第 12 站 6.5）；第 04 章會把同一個形狀推廣到每一張訂單。

### 1.5.4 決定：這個系統的第一刀，與這一站接下來切哪裡

README 的產出一是「一份拆分決策文件」。第 00 章寫了它的第一段（不該拆，0.3.4）；這一章加上第二段：

> **如果有一天 0.3.2 的某一題翻過來、真的要拆，第一刀切 notification。** 0 種切斷的交易、0 種同步呼叫，只有 5 種事件跨過去，36 個 commit 裡只有 3 個同時改了它和別的模組。切出去要做的事只有一件：把 outbox 的 relay 接到一個真的 broker（第 12 站第 07 章已經做好了）。**account 第二**：同樣沒有交易與同步呼叫，代價是 reporting 那一句 `JOIN users` 要換掉（第 05 章）。**inventory 第 96 名，不要切。**

那這一站接下來為什麼**還是切庫存**？因為它是第 96 名。

把 notification 切出去，學不到什麼：它跟其他模組之間沒有交易、沒有同步呼叫，這一站要教的 Saga、跨服務查詢、級聯故障，一個都不會出現。庫存這一刀，把所有難題都帶出來了：6 種要變成 Saga 的交易（第 04 章）、商品頁與購物車的可售量（第 05 章）、交易裡的遠端呼叫（第 06 章）。**練習台要選最難的那一個；決策要選最便宜的那一個 —— 不要把這兩件事搞混。** 這一站的每一章都會照實寫出「這是練習，不是建議」。

---

## 1.6 先拆模組：修呼叫的時機

### 1.6.1 第 12 站的邊界管「誰」，沒管「什麼時候」

第 12 站的模組邊界有四道防線（12 站 1.6.1）：編譯器、`ModuleBoundaryTest`、`TableOwnershipTest`、資料庫權限。它們守的都是「**誰**可以呼叫誰、誰可以碰哪張表」。1.4.5 的輸出看到的是另一件事 —— **在什麼時候呼叫**：

| | 種類 | 在一個行程裡 | 切開之後 |
|---|---|---|---|
| 跨模組呼叫 | 20 | 方法呼叫，幾奈秒 | 網路往返（0.2.1） |
| 其中在呼叫端的交易裡 | **17** | 跟呼叫端共用一個交易、一條連線 | 交易開著等遠端，佔著連線（0.2.3）；寫的那些還失去了「一起 rollback」（0.2.2） |

這 17 種分成兩類：

- **12 種是寫**：`reserve`、`holdHot`、`confirm`、`consume`、`release`、`initialize`、`setHot`、`removeItems`，以及 payment 的 4 種。它們在交易裡是**有意的** —— 要跟呼叫端的寫入一起 commit、一起 rollback（12 站 1.5.2 的 `MANDATORY`）。拿出來就是換掉交易，那是第 04 章。
- **5 種是讀、或者交易只是為了它而開的**：
  - `cart → CatalogApi.snapshots`、`cart → InventoryApi.available`：購物車的每一個動作，整個方法是 `@Transactional`，最後組畫面時去問商品與庫存。
  - `catalog → InventoryApi.available`：賣家改商品、上下架、標熱點、看自己的商品列表，回應裡要帶可售量 —— 在 catalog 的交易裡問。
  - `ordering → CatalogApi.snapshots`：下單交易的第一步，讀商品的名稱、價格、狀態。
  - `catalog → InventoryApi.restock`：補貨。它是寫，但 catalog 的那個交易**只是為了它而開的** —— catalog 只做了一件事：確認這個商品是你的（一句讀），自己什麼都沒寫。

**這 5 種，在一個行程裡改，幾乎沒有成本；切開之後不改，就是 0.2.3 的級聯。** 「先拆模組、再拆行程」的第一步就是它們：還沒拆的時候，先把跨模組的**讀**移到本地交易之外。規則只有一句：

> **本地交易只包住「自己模組的表」的那幾句；要問別的模組，在交易開始之前，或 commit 之後。**

做法都一樣：

```java
// 第 12 站
@Transactional
public ProductDetail update(...) {
    Product p = owned(sellerId, productId);
    p.update(...);                                            // 寫自己的表
    return detailOf(p, inventory.available(productId));       // ← 交易還開著，就去問別的模組
}

// 第 01 章
public ProductDetail update(...) {
    ProductDetail d = tx.execute(s -> {                       // 交易只包住自己的那一段
        Product p = owned(sellerId, productId);
        p.update(...);
        return detailOf(p, 0);
    });
    return withAvailable(d, inventory.available(productId)); // ← commit 之後才問
}
```

### 1.6.2 動手 ①：catalog 的賣家 API

`ProductService` 有六個方法要改：`update`、`publish`、`unpublish`、`setHot`、`restock`、`mine`。前四個完全照上面的形狀：拿掉 `@Transactional`，把「只動 catalog 的那一段」包進 `tx.execute()`，可售量在外面補上。

**① 加一個寫的 `TransactionTemplate`**（唯讀的那一個 `readOnly` 本來就有，給快取沒命中時的 `load()` 用）：

```java
    private final TransactionTemplate readOnly;
    private final TransactionTemplate tx;
    // 建構子裡：
        this.tx = new TransactionTemplate(tm);
```

**② 一個把可售量補上的小工具**（`ProductDetail` 是 record，換一個欄位就是建一個新的）：

```java
    private static ProductDetail withAvailable(ProductDetail d, int available) {
        return new ProductDetail(d.id(), d.sellerId(), d.name(), d.description(), d.price(), d.categoryId(), d.status(), available);
    }
```

為什麼在交易**裡面**先組好 `ProductDetail`（可售量先填 0），而不是把 `Product` 帶出交易再組？`detailOf()` 要讀 `p.getCategory().getId()`，`Category` 是 LAZY 的 —— 出了交易（session 關了）再讀，可能是 `LazyInitializationException`。`load()` 的註解說的是同一件事。**把要帶出交易的東西，在交易裡變成不再需要 session 的值。**

**③ `update`、`publish`、`unpublish`、`setHot`** 照 1.6.1 的形狀改。`setHot` 有一點不同：`inventory.setHot()` 要留在交易裡（它是 `MANDATORY`，要在 commit 之後才建立 Redis 閘門），只有最後的可售量移出去：

```java
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
```

**④ `restock`：先確認，再補貨。** 第 12 站把「確認是你的商品」與「補貨」包在 catalog 的同一個交易裡，而那個交易 catalog 自己什麼都沒寫 —— 它存在的唯一理由，是讓 `inventory.restock()` 加入它。拆成兩步：確認用 catalog 自己的唯讀交易，補貨用 inventory 自己的交易（`restock()` 是 `@Transactional`，沒有外層交易就自己開一個）：

```java
    public ProductDetail restock(long sellerId, long productId, RestockRequest req) {
        ProductDetail d = readOnly.execute(s -> detailOf(owned(sellerId, productId), 0));
        inventory.restock(productId, req.quantity(), req.note() == null ? "seller-restock" : "seller-restock:" + req.note());
        return withAvailable(d, inventory.available(productId));
    }
```

確認與補貨之間，商品有可能被轉給別的賣家嗎？第 12 站沒有「轉移商品」這個功能，`seller_id` 建立之後不會變。**這種「中間會不會被改」的檢查，每一次把一個交易拆成兩個都要做一次** —— 拆不拆得開，取決於業務規則，不取決於程式。

**⑤ `mine`**（賣家的商品列表）：分頁查詢在唯讀交易裡、`Category` 的 id 在交易裡取出，可售量在外面一次問完：

```java
    public PageResponse<SellerProductView> mine(long sellerId, Pageable pageable) {
        PageResponse<SellerProductView> page = readOnly.execute(s -> PageResponse.of(products.findBySellerId(sellerId, pageable),
                p -> new SellerProductView(p.getId(), p.getName(), p.getPrice(), p.getStatus(), p.getCategory().getId(), 0, p.getUpdatedAt())));
        Map<Long, Integer> available = inventory.available(page.content().stream().map(SellerProductView::id).toList());   // 13 站 1.6：交易之外
        return new PageResponse<>(page.content().stream().map(v -> new SellerProductView(v.id(), v.name(), v.price(), v.status(),
                v.categoryId(), available.getOrDefault(v.id(), 0), v.updatedAt())).toList(), page.page(), page.size(), page.totalElements(), page.totalPages());
    }
```

`create`（建立商品，連同期初庫存）**不改**：商品與它的庫存列要一起建立，那是 12 種「寫」之一（1.6.7）。

### 1.6.3 動手 ②：購物車

`CartService` 的四個動作（加入、改數量、刪除、看購物車）整個方法都是 `@Transactional`，最後都呼叫 `view()` 去問商品與庫存。改法：

```diff
+    private final TransactionTemplate tx;
-    CartService(JdbcTemplate jdbc, CatalogApi catalog, InventoryApi inventory) {
+    CartService(JdbcTemplate jdbc, CatalogApi catalog, InventoryApi inventory, PlatformTransactionManager tm) {
+        this.tx = new TransactionTemplate(tm);

-    @Transactional
     public CartView add(long buyerId, AddItemRequest req) {
-        ProductSnapshot p = catalog.snapshots(List.of(req.productId())).get(req.productId());
+        ProductSnapshot p = catalog.snapshots(List.of(req.productId())).get(req.productId());     // 交易之外（13 站 1.6）
         if (p == null || !p.purchasable()) throw ……;
-        Integer distinct = ……;  if (……) throw ……;  try { jdbc.update(INSERT …… ON DUPLICATE KEY ……); } catch (……) { …… }
+        tx.executeWithoutResult(s -> {
+            Integer distinct = ……;  if (……) throw ……;  try { jdbc.update(INSERT …… ON DUPLICATE KEY ……); } catch (……) { …… }
+        });
         return view(buyerId);
     }

-    @Transactional
     public CartView change(……) {    // 一句 UPDATE，不需要另外開交易
-    @Transactional
     public CartView remove(……) {    // 一句 DELETE

-    @Transactional(readOnly = true)
     public CartView view(long buyerId) {   // 三句查詢各自讀：自己的 cart_items、商品快照、可售量
```

`add` 的那兩句（數一數有幾種商品、upsert）留在一個交易裡，跟第 12 站一樣；`change`、`remove` 只有一句 SQL，本來就不需要交易。

**`view()` 拿掉唯讀交易，失去了什麼？** 第 12 站的 `view()` 在一個唯讀交易裡讀三樣東西：購物車、商品、可售量 —— InnoDB 的一致性讀讓它們是**同一個時間點**的快照。現在三句各自讀，各自看到「當下」的值：讀完購物車、還沒讀商品之間改了價，畫面上的價格是新的。對一個每次打開都重新整理的購物車畫面，這沒有差別；而且**切開之後，這個「同一個快照」本來就不存在** —— 三樣東西在兩個資料庫裡。附帶的好處是第 12 站 6.2.3 量過的那件事：一個 `@Transactional` 方法，就算只讀，MySQL 也要多收 `SET autocommit`、`commit` 這幾句。

### 1.6.4 動手 ③：下單的商品快照

`PlaceOrderService.placeInTransaction()` 的第一步是 `catalog.snapshots(ids)`，接著三個檢查（可購買、同一位賣家、價格沒變），然後才 INSERT 訂單。把快照與檢查拆成一個方法，移到冪等鍵之後、下單交易之前：

```diff
@@ -119,9 +120,13 @@ class PlaceOrderService implements OrderingApi {
         if (claim instanceof IdempotencyKeys.InProgress)
             throw new ShopException(ProblemType.IDEMPOTENCY_IN_PROGRESS, "相同的下單請求正在處理中").with("retryAfter", 1);
         try {
+            // 13 站 1.6：商品快照在下單交易「之前」讀 —— 第 12 站是在交易裡讀的。那是一句不加鎖的讀（一致性讀），
+            // 放在交易裡也擋不住「讀完之後賣家改價」，只是讓交易多開一段；切開之後，這一段是一次遠端呼叫。
+            // 放在冪等鍵之後：重送（Existing）不需要快照，也不該因為價格變了而失敗
+            Map<Long, ProductSnapshot> products = checkedSnapshots(lines);
             for (int attempt = 1; ; attempt++) {
                 try {
-                    return tx.execute(s -> placeInTransaction(buyerId, idempotencyKey, lines, hot));
+                    return tx.execute(s -> placeInTransaction(buyerId, idempotencyKey, lines, hot, products));
                 } catch (DataIntegrityViolationException e) {
                     // 2.4.4：訂單編號撞號（一天約 12 次）。整個交易已經 rollback，換一個號碼重來
                     if (attempt >= ORDER_NO_ATTEMPTS || !ConstraintViolations.isViolationOf(e, "uk_orders_order_no")) throw e;
@@ -134,7 +139,8 @@ class PlaceOrderService implements OrderingApi {
         }
     }
 
-    private PlacedOrder placeInTransaction(long buyerId, String key, List<OrderLine> lines, List<ReserveLine> hot) {
+    /** 商品快照與三個檢查（可購買、同一位賣家、價格沒變）。全部在交易之外 */
+    private Map<Long, ProductSnapshot> checkedSnapshots(List<OrderLine> lines) {
         List<Long> ids = lines.stream().map(OrderLine::productId).toList();
         Map<Long, ProductSnapshot> products = catalog.snapshots(ids);
 
@@ -156,9 +162,13 @@ class PlaceOrderService implements OrderingApi {
         }
         if (!changed.isEmpty())
             throw new ShopException(ProblemType.PRICE_CHANGED, "價格已變動，請確認後重新下單").with("changes", changed);
+        return products;
+    }
 
+    private PlacedOrder placeInTransaction(long buyerId, String key, List<OrderLine> lines, List<ReserveLine> hot, Map<Long, ProductSnapshot> products) {
+        List<Long> ids = lines.stream().map(OrderLine::productId).toList();
         Instant now = clock.instant();
-        Order order = Order.place(OrderNumbers.next(now), buyerId, sellers.iterator().next(), now, now.plus(paymentTimeout));
+        Order order = Order.place(OrderNumbers.next(now), buyerId, products.get(ids.get(0)).sellerId(), now, now.plus(paymentTimeout));
         for (OrderLine l : lines) {
             ProductSnapshot p = products.get(l.productId());
             order.addItem(p.id(), p.name(), p.price(), l.quantity());      // 快照：下單當下的名稱與價格（1.5.5）
```

這一個要多想兩件事：

- **移出交易，會不會讓「價格檢查」變弱？** 不會。`snapshots()` 是一句不加鎖的 SELECT（一致性讀）：就算在交易裡，它也擋不住「讀完之後、commit 之前賣家改價」—— 第 12 站沒有鎖商品列（那會讓改價跟下單互相等）。移出交易，保證跟原本一樣：訂單記下的，是讀的那一刻的價格。
- **為什麼放在冪等鍵之後，不是最前面？** 重送（同一個 `Idempotency-Key`，`Existing`）要直接拿到原本那張訂單（第 12 站 4.5），不需要快照，也**不該**因為價格後來改了而回 409。放在 `claim()` 之後，重送的行為不變。快照只讀一次：訂單編號撞號重試（12 站 2.4.4）不會重讀。

改完，下單交易裡跨模組的呼叫只剩兩種「寫」：`inventory.reserve()`／`holdHot()`、`cart.removeItems()`。

> ⚠️ **這一步不是免費的。** `snapshots()` 本身是 `@Transactional(readOnly = true)`：以前它**加入**下單交易，現在它在交易之外，自己開、自己 commit 一個唯讀交易 —— 每一張訂單多一個短交易（第 12 站 6.2.3：多幾句 `SET`、`commit`）。1.8.2 在這個分支上重跑了 K1，吞吐的數字比第 00 章低一點，但第 00 章自己兩次執行就差了 8%，**這一章沒有把這個代價單獨量出來**。

### 1.6.5 量：B1 重跑、B2 購物車的級聯

**B1 重跑**（同一個工作負載）。第一把尺那一段的「交易裡」欄：

```
═══ 1.4.1 第一把尺：跨模組的同步呼叫（呼叫端 → 介面.方法：次數，其中幾次在呼叫端的交易裡；哪些動作）═══
  cart → CatalogApi.snapshots                   9 次（交易裡  0，唯讀  0）  [DELETE /api/cart/items/{productId}, GET /api/cart, PATCH /api/cart/items/{productId}, POST /api/cart/items]
  cart → InventoryApi.available                 6 次（交易裡  0，唯讀  0）  [DELETE /api/cart/items/{productId}, GET /api/cart, PATCH /api/cart/items/{productId}, POST /api/cart/items]
  catalog → InventoryApi.available              9 次（交易裡  0，唯讀  0）  [GET /api/seller/products, PATCH /api/seller/products/{id}, POST /api/seller/products/{id}/hot, POST /api/seller/products/{id}/publish, POST /api/seller/products/{id}/restock, POST /api/seller/products/{id}/unpublish]
  catalog → InventoryApi.availableForDisplay    2 次（交易裡  0，唯讀  0）  [GET /api/products/{id}]
  catalog → InventoryApi.initialize             4 次（交易裡  4，唯讀  0）  [POST /api/seller/products]
  catalog → InventoryApi.restock                1 次（交易裡  0，唯讀  0）  [POST /api/seller/products/{id}/restock]
  catalog → InventoryApi.setHot                 1 次（交易裡  1，唯讀  0）  [POST /api/seller/products/{id}/hot]
  ordering → CartApi.removeItems                6 次（交易裡  6，唯讀  0）  [POST /api/orders]
  ordering → CatalogApi.hotProducts             6 次（交易裡  0，唯讀  0）  [POST /api/orders]
  ordering → CatalogApi.snapshots               6 次（交易裡  0，唯讀  0）  [POST /api/orders]
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
```

**交易內的跨模組呼叫，從 17 種變成 12 種**；剩下的 12 種全是寫。127 種切法的表也跟著變了：

```
═══ 1.5 127 種切法（ordering 留在原地，S 切出去）；變更耦合：ch09，36 個改到正式程式碼的 commit ═══
  名次 │ 切出去的 S                          │ 切斷的交易 │ 交易內呼叫 │ 同步呼叫 │ 直接讀表 │ 事件 │ 變更耦合
     1 │ notification                        │          0 │          0 │        0 │        0 │    5 │   8.3%（3）
     2 │ account                             │          0 │          0 │        0 │        1 │    0 │  11.1%（4）
     3 │ account+notification                │          0 │          0 │        0 │        1 │    5 │  13.9%（5）
     4 │ account+reporting                   │          0 │          0 │        0 │        4 │    0 │  19.4%（7）
     5 │ account+notification+reporting      │          0 │          0 │        0 │        4 │    5 │  22.2%（8）
     6 │ reporting                           │          0 │          0 │        0 │        5 │    0 │  11.1%（4）
     7 │ notification+reporting              │          0 │          0 │        0 │        5 │    5 │  16.7%（6）
     8 │ cart                                │          1 │          1 │        3 │        0 │    0 │  11.1%（4）
     9 │ cart+notification                   │          1 │          1 │        3 │        0 │    5 │  13.9%（5）
    10 │ account+cart                        │          1 │          1 │        3 │        1 │    0 │  16.7%（6）
    11 │ account+cart+notification           │          1 │          1 │        3 │        1 │    5 │  19.4%（7）
    12 │ account+cart+reporting              │          1 │          1 │        3 │        4 │    0 │  22.2%（8）
    16 │ catalog                             │          1 │          2 │        8 │        1 │    0 │  25.0%（9）
    32 │ payment                             │          3 │          4 │        4 │        1 │    1 │  19.4%（7）
    64 │ catalog+inventory                   │          6 │          5 │       10 │        1 │    2 │  25.0%（9）
    96 │ inventory                           │          7 │          7 │       12 │        0 │    2 │  22.2%（8）
  （127 種全部：target/d01-cuts.txt）
  包含 inventory 的 64 種切法：切斷的交易最少 6 種；前三名：
    第  64 名 catalog+inventory                   交易 6、交易內呼叫 5、同步呼叫 10
    第  65 名 catalog+inventory+notification      交易 6、交易內呼叫 5、同步呼叫 10
    第  66 名 account+catalog+inventory           交易 6、交易內呼叫 5、同步呼叫 10
```

| 切出去的 S | 交易內呼叫：第 12 站 → 第 01 章 |
|---|---|
| inventory | 10 → 7 |
| catalog | 6 → 2 |
| cart | 3 → 1 |
| catalog+inventory | 8 → 5 |
| payment | 4 → 4（沒有動 payment） |

**名次幾乎沒變** —— 排名第一優先看的是「切斷的交易」，這一章一種都沒有減少（那 7 種都要等 Saga）。變的是第二個數字。

注意最後那三行：**「把庫存切出去時，最好連誰一起帶走」的答案變了。** 改之前是 cart+catalog+inventory（第 64 名）：購物車在交易裡問商品、問庫存，把它一起帶走，這 2 種回到同一邊，換來「下單時在交易裡清購物車」那 1 種跨過去 —— 交易內呼叫 8 → 7，划算。改之後，購物車問商品與庫存已經不在交易裡了，帶著它只剩下那 1 種跨過去 —— 交易內呼叫 5 → 6，最佳的變成 catalog+inventory（`target/d01-cuts.txt`：cart+catalog+inventory 掉到第 72 名）。**邊界的最佳位置不是固定的，它跟著程式碼一起變** —— 所以 B1 要每一章重跑。

> ⚠️ **小坑：commit 的交易從 191 個變成 227 個。** 不是交易變多了：以前包在同一個交易裡的幾句讀（購物車的三句、賣家列表的兩句），現在各自 autocommit，`SqlTap` 一句算一個。

**「交易內呼叫少了 3 種」換到了什麼？** 數字說不出來，要量。B2 用第 00 章 K3 的同一個做法，換成**購物車**：切開的部署（訂單服務呼叫庫存服務的 `available()` 是一次 HTTP），每秒固定看 20 次購物車（開放式負載）；同時每 200 ms 看一次「我的訂單」（只查訂單服務自己的資料庫）。三段各 20 秒：正常 → **庫存服務的可售量查詢慢 3 秒** → 恢復。

為了讓庫存服務的查詢能變慢，第 00 章的 `LabInventoryService` 多一個開關（`/lab/inventory/delay?what=available&ms=…`），`SplitLab` 多一個 `inventoryAvailableDelay()`；完整內容在 1.9.1。

**同一個實驗跑兩次，只有正式程式碼不同。** 「第 12 站」那一次，把 `src/main` 換回這一章改之前的版本：

```bash
git checkout <改之前的 commit> -- src/main
mvn test -Pexperiments -Dtest=B2CartCascadeTest -Dd01.variant=第12站
git checkout HEAD -- src/main
mvn test -Pexperiments -Dtest=B2CartCascadeTest -Dd01.variant=第01章
```

```
═══ 1.6.5 庫存服務的可售量查詢變慢：訂單服務怎麼了（第12站；每秒 20 次購物車；load { 12.06 8.64 7.13 }）═══
  正常    │ 購物車    │  400 次 │ p50     14.8 ms │ p99     51.7 ms │ max    134.3 ms │ {200=400}
  正常    │ 我的訂單   │   93 次 │ p50      9.8 ms │ p99     93.6 ms │ max     93.6 ms │ {200=93}
  慢 3 秒 │ 購物車    │  400 次 │ p50   3009.4 ms │ p99   6021.9 ms │ max   6077.2 ms │ {200=175, 503=225}
  慢 3 秒 │ 我的訂單   │   12 次 │ p50   2063.6 ms │ p99   3007.5 ms │ max   3007.5 ms │ {200=11, 503=1}
  恢復    │ 購物車    │  400 次 │ p50     14.0 ms │ p99   1278.8 ms │ max   1473.5 ms │ {200=400}
  恢復    │ 我的訂單   │   87 次 │ p50      9.3 ms │ p99     27.8 ms │ max     27.8 ms │ {200=87}
  連線池（每秒）：
      1 秒 正常    active  1 pending   0
      ……（正常的 20 秒裡，active 0～2、pending 0）
     21 秒 慢 3 秒 active 20 pending   2
     22 秒 慢 3 秒 active 20 pending  23
     23 秒 慢 3 秒 active 20 pending  42
      ……
     29 秒 慢 3 秒 active 20 pending  62
      ……
     40 秒 慢 3 秒 active 20 pending  61
     41 秒 恢復    active 20 pending  61
     42 秒 恢復    active  0 pending   0
      ……（之後 active 0～1、pending 0）
  （結束時 load { 6.95 7.77 6.91 }）
```

```
═══ 1.6.5 庫存服務的可售量查詢變慢：訂單服務怎麼了（第01章；每秒 20 次購物車；load { 9.54 8.30 7.12 }）═══
  正常    │ 購物車    │  400 次 │ p50     13.8 ms │ p99     74.3 ms │ max    161.5 ms │ {200=400}
  正常    │ 我的訂單   │   94 次 │ p50     10.0 ms │ p99     29.8 ms │ max     29.8 ms │ {200=94}
  慢 3 秒 │ 購物車    │  400 次 │ p50   3017.0 ms │ p99   3060.3 ms │ max   3119.9 ms │ {200=400}
  慢 3 秒 │ 我的訂單   │   93 次 │ p50      8.9 ms │ p99     67.4 ms │ max     67.4 ms │ {200=93}
  恢復    │ 購物車    │  400 次 │ p50     12.3 ms │ p99     87.3 ms │ max   3015.2 ms │ {200=400}
  恢復    │ 我的訂單   │   94 次 │ p50      8.7 ms │ p99     27.5 ms │ max     27.5 ms │ {200=94}
  連線池（每秒）：
      1 秒 正常    active  0 pending   0
      ……（正常的 20 秒裡，active 0～1、pending 0）
      ……（慢的 20 秒裡，active 0～1、pending 0）
     41 秒 恢復    active  1 pending   0
     42 秒 恢復    active  1 pending   0
      ……（之後 active 0～1、pending 0）
  （結束時 load { 6.56 7.66 6.96 }）
```

**同一個慢，兩種結果。**

- **第 12 站的寫法**：購物車的唯讀交易一開，就拿著一條連線去等庫存服務 3 秒。每秒 20 次 × 3 秒 = 需要 60 條，連線池只有 20 條 —— 1 秒內滿了，最多 62 個請求在排隊，購物車 400 次裡 225 次 503（拿不到連線；日誌裡 226 行 `Connection is not available`，另外那 1 行是「我的訂單」的 503）。**跟庫存毫無關係的「我的訂單」也倒了**：它只是要一條連線。這跟第 00 章 K3 是同一個機制，差別是這一次**沒有任何一個寫入** —— 一個唯讀的頁面就夠了。
- **第 01 章**：購物車照樣慢 3 秒（庫存服務真的慢，這一章沒有解決「慢」—— 那是第 06 章的逾時與熔斷），但連線池在那 20 秒裡最多只有 1 條在用、沒有人排隊；「我的訂單」p50 8.9 ms，一個 503 都沒有。慢被**留在**購物車裡，沒有沿著連線池傳出去。

**一個行程的時候，這兩個版本的行為一模一樣** —— 1.9 的 230 個測試全是綠的，沒有任何一個能分辨它們。差別只在切開之後才出現；而改它的成本，在一個行程裡是三個類別、一個下午，在兩個服務之間是兩邊的程式、一次協調好的部署。**這就是「先拆模組」：在它還便宜的時候改。**

### 1.6.6 守住：`CrossModuleCallInTxTest`

改好了，怎麼確保下一個人不會再把一個跨模組的讀放進交易裡？第 12 站的 `ModuleBoundaryTest` 用 ArchUnit 看的是**靜態**的依賴：A 類別引用了 B 類別。「在交易裡呼叫」是**執行時**的事 —— 交易可能是呼叫端的呼叫端開的，ArchUnit 看不到。

所以用第一把尺本身當守門員。這個測試開著 `ApiTap`，用 HTTP 把會跨模組的功能各走一次，然後檢查：**呼叫端開著交易的跨模組呼叫，每一種都在一張清單上**，而清單上的每一種都寫了它會在哪一章被處理：

```java
package com.example.shop.dist01;

import com.example.shop.payment.internal.CallbackSignature;
import com.example.shop.shared.config.ShopProperties;
import com.example.shop.shared.security.AccessTokens;
import com.example.shop.shared.web.Role;
import com.example.shop.support.TestInfra;
import com.example.shop.support.TestRedis;
import com.example.shop.support.TestTokens;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders;

import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.stream.Collectors;

import static java.util.Map.entry;
import static org.assertj.core.api.Assertions.assertThat;

/**
 * 13 站 1.6.6：守住「在交易裡呼叫別的模組」只會變少、不會變多。
 *
 * 第 12 站的 ModuleBoundaryTest 守的是「誰能呼叫誰」；它看不到「在什麼時候呼叫」。這個測試開著 ApiTap（1.4.1），
 * 用 HTTP 把會跨模組的功能各走一次，然後檢查：呼叫端開著交易的跨模組呼叫，每一種都在下面的清單上，而且清單上寫了它會在哪一章被處理。
 * 新的一種出現 → 紅。要嘛把它移到交易外面（1.6），要嘛有理由地加進清單。
 */
@SpringBootTest(properties = {"shop.order.jobs-enabled=false", "shop.inventory.jobs-enabled=false", "lab.d01.probe=true"})
@AutoConfigureMockMvc
class CrossModuleCallInTxTest {

    /** 第 01 章結束時，還在交易裡的跨模組呼叫：全部是「寫」，全部要等 Saga（第 04 章）才拿得出來 */
    static final Map<String, String> ALLOWED = Map.ofEntries(
            entry("catalog → InventoryApi.initialize", "建立商品：期初庫存跟商品同一個交易（第 04 章）"),
            entry("catalog → InventoryApi.setHot", "標熱點：MANDATORY，commit 之後建立 Redis 閘門（第 04 章）"),
            entry("ordering → CartApi.removeItems", "下單：清購物車跟訂單同一個交易（第 04 章）"),
            entry("ordering → InventoryApi.reserve", "下單：預留跟訂單同一個交易（第 04 章）"),
            entry("ordering → InventoryApi.holdHot", "下單：熱點預留列跟訂單同一個交易（第 04 章）"),
            entry("ordering → InventoryApi.confirm", "付款成功：預留確認跟訂單狀態同一個交易（第 04 章）"),
            entry("ordering → InventoryApi.consume", "出貨：扣庫存跟訂單狀態同一個交易（第 04 章）"),
            entry("ordering → InventoryApi.release", "取消：釋放預留跟訂單狀態同一個交易（第 04 章）"),
            entry("ordering → PaymentApi.create", "建立付款：跟訂單同一個交易（第 04 章）"),
            entry("ordering → PaymentApi.record", "金流回呼：付款紀錄跟訂單狀態同一個交易（第 04 章）"),
            entry("ordering → PaymentApi.succeededPaymentOf", "取消：決定要不要退款（第 04 章）"),
            entry("ordering → PaymentApi.requestRefund", "取消：退款單跟訂單狀態同一個交易（第 04 章）"));

    static final long SELLER = 990_961, BUYER = 990_962, PRODUCT = 9_900_961, HOT = 9_900_962;

    @Autowired MockMvc mvc;
    @Autowired AccessTokens tokens;
    @Autowired ShopProperties props;
    @Autowired JdbcTemplate jdbc;
    @Autowired StringRedisTemplate redis;
    @Autowired ObjectMapper json;

    @BeforeEach
    void setUp() {
        cleanup();
        for (long id : new long[]{PRODUCT, HOT}) {
            jdbc.update("INSERT INTO products (id, seller_id, category_id, name, price, status) VALUES (?, ?, 11, '交易內呼叫', 100.00, 'ON_SALE')", id, SELLER);
            jdbc.update("INSERT INTO inventory (product_id, on_hand, reserved) VALUES (?, 50, 0)", id);
            jdbc.update("INSERT INTO inventory_ledger (product_id, delta_on_hand, delta_reserved, reason, ref) VALUES (?, 50, 0, 'INITIAL', 'd01-guard')", id);
        }
        Probe.reset();
    }

    @AfterEach
    void cleanup() {
        List<Long> products = jdbc.queryForList("SELECT id FROM products WHERE seller_id = ?", Long.class, SELLER);
        JdbcTemplate admin = TestInfra.adminJdbc();
        admin.update("DELETE a FROM audit_logs a JOIN payments p ON a.target_type = 'PAYMENT' AND a.target_id = p.id JOIN orders o ON o.id = p.order_id WHERE o.buyer_id = ?", BUYER);
        admin.update("DELETE a FROM audit_logs a JOIN orders o ON a.target_type = 'ORDER' AND a.target_id = o.order_no WHERE o.buyer_id = ?", BUYER);
        for (String t : List.of("refunds", "payments", "order_status_history", "order_items"))
            jdbc.update("DELETE x FROM " + t + " x JOIN orders o ON o.id = x.order_id WHERE o.buyer_id = ?", BUYER);
        jdbc.update("DELETE FROM idempotency_keys WHERE buyer_id = ?", BUYER);
        jdbc.update("DELETE FROM orders WHERE buyer_id = ?", BUYER);
        jdbc.update("DELETE FROM cart_items WHERE buyer_id = ?", BUYER);
        for (long id : products) {
            jdbc.update("DELETE FROM inventory_reservations WHERE product_id = ?", id);
            admin.update("DELETE FROM inventory_ledger WHERE product_id = ?", id);
            jdbc.update("DELETE FROM inventory WHERE product_id = ?", id);
            admin.update("DELETE FROM audit_logs WHERE target_type = 'PRODUCT' AND target_id = ?", String.valueOf(id));
            TestRedis.forgetProducts(redis, id);
        }
        jdbc.update("DELETE FROM products WHERE seller_id = ?", SELLER);
    }

    @Test @DisplayName("13 站 1.6.6：呼叫端開著交易的跨模組呼叫，每一種都在清單上（新的一種 → 紅）")
    void crossModuleCallsInsideTransactionsAreKnown() throws Exception {
        String seller = TestTokens.bearer(tokens, SELLER, Role.SELLER), buyer = TestTokens.bearer(tokens, BUYER);

        // 賣家：建立、改、上下架、標熱點、補貨、看自己的商品
        long created = body(call("POST", "/api/seller/products", seller, """
                {"name": "交易內呼叫 新商品", "price": 100, "categoryId": 11, "initialStock": 5}""", 201)).get("id").asLong();
        call("POST", "/api/seller/products/" + created + "/publish", seller, null, 200);
        call("POST", "/api/seller/products/" + created + "/unpublish", seller, null, 200);
        call("PATCH", "/api/seller/products/" + PRODUCT, seller, "{\"description\": \"改說明\"}", 200);
        call("POST", "/api/seller/products/" + HOT + "/hot", seller, "{\"hot\": true}", 200);
        call("POST", "/api/seller/products/" + PRODUCT + "/restock", seller, "{\"quantity\": 5}", 200);
        call("GET", "/api/seller/products", seller, null, 200);
        call("GET", "/api/products/" + PRODUCT, null, null, 200);

        // 買家：購物車的四個動作
        call("POST", "/api/cart/items", buyer, "{\"productId\": %d, \"quantity\": 2}".formatted(PRODUCT), 200);
        call("PATCH", "/api/cart/items/" + PRODUCT, buyer, "{\"quantity\": 1}", 200);
        call("GET", "/api/cart", buyer, null, 200);
        call("DELETE", "/api/cart/items/" + PRODUCT, buyer, null, 200);

        // 訂單：一般商品走完付款 → 出貨；熱點商品下單後取消；付款後賣家取消（退款）
        String o1 = place(buyer, PRODUCT);
        pay(buyer, o1, "d01-guard-1");
        call("POST", "/api/seller/orders/" + o1 + "/start-picking", seller, null, 200);
        call("POST", "/api/seller/orders/" + o1 + "/ship", seller, "{\"carrier\": \"黑貓\", \"trackingNo\": \"G-1\"}", 200);
        String o2 = place(buyer, HOT);
        call("POST", "/api/orders/" + o2 + "/cancel", buyer, null, 200);
        String o3 = place(buyer, PRODUCT);
        pay(buyer, o3, "d01-guard-3");
        call("POST", "/api/seller/orders/" + o3 + "/cancel", seller, null, 200);

        Set<String> inTx = Probe.CALLS.stream().filter(Probe.Call::inTx).map(c -> c.caller() + " → " + c.method()).collect(Collectors.toCollection(TreeSet::new));
        Set<String> outside = Probe.CALLS.stream().filter(c -> !c.inTx()).map(c -> c.caller() + " → " + c.method()).collect(Collectors.toCollection(TreeSet::new));
        Set<String> unknown = new TreeSet<>(inTx);
        unknown.removeAll(ALLOWED.keySet());
        System.out.printf("13 站 1.6.6：交易裡的跨模組呼叫 %d 種 %s%n            交易外 %d 種 %s%n", inTx.size(), inTx, outside.size(), outside);
        assertThat(unknown).as("新的「在交易裡呼叫別的模組」—— 移到交易外面（13 站 1.6），或有理由地加進 ALLOWED").isEmpty();
        assertThat(inTx).as("清單上的每一種都有被走到（不然這個測試守不住它）").containsExactlyInAnyOrderElementsOf(ALLOWED.keySet());
    }

    String place(String buyer, long product) throws Exception {
        return body(call("POST", "/api/orders", buyer, "{\"items\": [{\"productId\": %d, \"quantity\": 1, \"unitPrice\": 100}]}".formatted(product), 201))
                .get("orderNo").asText();
    }

    void pay(String buyer, String orderNo, String txn) throws Exception {
        JsonNode p = body(call("POST", "/api/orders/" + orderNo + "/payments", buyer, null, 201));
        long id = p.get("paymentId").asLong();
        BigDecimal amount = new BigDecimal(p.get("amount").asText());
        String sig = CallbackSignature.sign(props.payment().callbackSecret(), CallbackSignature.canonical(id, txn, amount, true));
        call("POST", "/api/payments/callback", null, """
                {"paymentId": %d, "providerTxnId": "%s", "amount": %s, "result": "SUCCEEDED", "signature": "%s"}""".formatted(id, txn, amount, sig), 200);
    }

    MockHttpServletResponse call(String method, String path, String token, String body, int expect) throws Exception {
        var b = MockMvcRequestBuilders.request(method, java.net.URI.create(path)).contentType(MediaType.APPLICATION_JSON).characterEncoding(StandardCharsets.UTF_8);
        if (token != null) b.header("Authorization", token);
        if (path.equals("/api/orders")) b.header("Idempotency-Key", "d01-guard-" + System.nanoTime());
        if (body != null) b.content(body);
        MockHttpServletResponse r = mvc.perform(b).andReturn().getResponse();
        assertThat(r.getStatus()).as(method + " " + path + "：" + r.getContentAsString(StandardCharsets.UTF_8)).isEqualTo(expect);
        return r;
    }

    JsonNode body(MockHttpServletResponse r) throws Exception {
        return json.readTree(r.getContentAsString(StandardCharsets.UTF_8));
    }
}
```

- **它在預設的測試組裡**（沒有 `@Tag("experiment")`），跑 Testcontainers，跟其他 227 個一起跑。它自己的 Spring context 多開一個（`lab.d01.probe=true`），約 20 秒。
- **兩個斷言**：① 沒有清單之外的種類（新的一種 → 紅）；② 清單上的每一種都有被走到 —— 不然它守不住那一種（1.4.4 的教訓：沒走到的路，看起來就是沒有問題）。
- **清單只會變短。** 第 04 章把下單改成 Saga 之後，`reserve`、`removeItems` 那幾行會從清單上消失；有人想加一行，要寫出理由與「哪一章會拿掉它」。

綠的時候：

```
13 站 1.6.6：交易裡的跨模組呼叫 12 種 [catalog → InventoryApi.initialize, catalog → InventoryApi.setHot, ordering → CartApi.removeItems, ordering → InventoryApi.confirm, ordering → InventoryApi.consume, ordering → InventoryApi.holdHot, ordering → InventoryApi.release, ordering → InventoryApi.reserve, ordering → PaymentApi.create, ordering → PaymentApi.record, ordering → PaymentApi.requestRefund, ordering → PaymentApi.succeededPaymentOf]
            交易外 8 種 [cart → CatalogApi.snapshots, cart → InventoryApi.available, catalog → InventoryApi.available, catalog → InventoryApi.availableForDisplay, catalog → InventoryApi.restock, ordering → CatalogApi.hotProducts, ordering → CatalogApi.snapshots, ordering → InventoryApi.gateHot]
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 20.85 s -- in com.example.shop.dist01.CrossModuleCallInTxTest
```

**故意把它弄紅一次。** 把 `CartService.view()` 改回第 12 站的 `@Transactional(readOnly = true)`：

```
13 站 1.6.6：交易裡的跨模組呼叫 14 種 [cart → CatalogApi.snapshots, cart → InventoryApi.available, catalog → InventoryApi.initialize, catalog → InventoryApi.setHot, ordering → CartApi.removeItems, ordering → InventoryApi.confirm, ordering → InventoryApi.consume, ordering → InventoryApi.holdHot, ordering → InventoryApi.release, ordering → InventoryApi.reserve, ordering → PaymentApi.create, ordering → PaymentApi.record, ordering → PaymentApi.requestRefund, ordering → PaymentApi.succeededPaymentOf]
[ERROR] Tests run: 1, Failures: 1, Errors: 0, Skipped: 0, Time elapsed: 18.01 s <<< FAILURE! -- in com.example.shop.dist01.CrossModuleCallInTxTest
[新的「在交易裡呼叫別的模組」—— 移到交易外面（13 站 1.6），或有理由地加進 ALLOWED] 
Expecting empty but was: ["cart → CatalogApi.snapshots", "cart → InventoryApi.available"]
```

紅得很具體：哪兩種、從哪個模組呼叫哪個方法。改回來就綠了。

### 1.6.7 沒有動的：12 種寫，以及熱點

清單上那 12 種，這一章一種都沒拿出來：

| 呼叫 | 為什麼在交易裡 | 拿出來需要 |
|---|---|---|
| `ordering → InventoryApi.reserve`、`holdHot`、`confirm`、`consume`、`release` | 預留的狀態必須跟訂單的狀態一起變（1.5.3） | Saga、補償、對帳（第 04 章） |
| `ordering → CartApi.removeItems` | 下單成立 = 購物車清掉（US-ORD-1 AC-4） | 改成事件（訂單成立之後清），或接受「清不掉」（第 04 章） |
| `ordering → PaymentApi.create`、`record`、`requestRefund` | 付款紀錄、退款單跟訂單狀態一起變 | 第 04 章 |
| `ordering → PaymentApi.succeededPaymentOf` | 它是**讀**，但它決定同一個交易裡的寫（取消時要不要建退款單），跟訂單狀態的條件式更新綁在一起（第 12 站 4.6）。推這一行的時候發現它在第 12 站就有一個窗口，已經改成當前讀（`FOR SHARE`，表下面的 📌） | 第 04 章 |
| `catalog → InventoryApi.initialize` | 商品與它的期初庫存一起建立 —— 1.2 那個「建立商品」的交易 | 第 04 章（或第 02 章：庫存列晚一點出現，可售量先當 0） |
| `catalog → InventoryApi.setHot` | `MANDATORY`：commit 之後才建立 Redis 閘門 | 跟 1.3.3 的熱點一起處理 |

**熱點商品（1.3.3）也沒有動。** 要讓庫存模組自己知道「哪些商品是熱點」，就要在庫存模組裡有一份熱點旗標，而且下單時讀它不能碰 MySQL（第 12 站第 06 章的前提：搶不到的人不碰 MySQL）—— 等於在庫存模組裡再做一次第 12 站 6.4 的快取，連同它的失效與降級。那不是「移一行程式碼」等級的修正，這一章不做。

📌 **`succeededPaymentOf` 為什麼不能照 1.6 的方法移出交易。** 把它移出去 —— 在取消的交易開始之前先問「這張訂單有沒有成功的付款」—— 會出錯的交錯是這樣的（推論，沒有實作「移出去」的版本）：

```
買家取消（PENDING_PAYMENT 的訂單）              金流回呼（同一張訂單付款成功）
① 交易外：succeededPaymentOf() → 沒有
                                                ② 回呼的交易：payments 記成功、訂單 → PAID、commit
③ 取消的交易：讀訂單 → PAID；
   狀態機：PAID 也可以取消 → CANCELLED，要退款
   退哪一筆？用 ① 的結果：「沒有付款」→ 不建退款單
④ commit：一張「已付款、已取消、沒有退款」的訂單
```

**推這張圖的時候，我本來接著要寫「第 12 站把它放在交易裡，所以沒有這個窗口」—— 寫之前去核對，發現不對。** 第 12 站的取消交易是這樣走的（12 站 4.6）：

1. 第一句是一般的 SELECT（`OrderAccess.buyers()`：這張訂單是不是你的）—— InnoDB 在這裡建立這個交易的**一致性讀快照**（REPEATABLE READ）。
2. 條件式 `UPDATE orders … WHERE status = 'PENDING_PAYMENT'`。
3. 影響 0 列 → `FOR UPDATE` 重讀（12 站 4.6.2 特別處理過：一般的重讀會讀到舊快照）。
4. `succeededPaymentOf()`：**一般的 SELECT** —— 用的還是 1 的快照。

回呼的交易如果整個落在 1 與 2 之間，3 看到 `PAID`、決定要退款，4 卻看不到那一筆 `SUCCEEDED`。**跟上面那張圖是同一個結果，只是窗口小得多** —— 4.6.2 修好了重讀，漏了重讀之後的那一句讀。

推論要能重現才算數。`CancelRefundSnapshotTest`（第 12 站，`ordering.internal`）用一個外層交易先做 1 那一句讀、等另一條執行緒把回呼整個做完並 commit，再在同一個交易裡呼叫 `cancelByBuyer()`（`REQUIRED`，加入外層交易、用同一個快照）：

```
取消的第一句讀到 PENDING_PAYMENT；回呼 200；取消 →
  訂單 CANCELLED、付款 SUCCEEDED、退款單 []
[已付款、已取消：錢要退]
Expected size: 1 but was: 0 in:
```

修法：`succeededPaymentOf()` 改成**當前讀**（SQL 結尾加 `FOR SHARE`），永遠讀最新提交的版本：

```
取消的第一句讀到 PENDING_PAYMENT；回呼 200；取消 →
  訂單 CANCELLED、付款 SUCCEEDED、退款單 [BUYER_CANCEL]
```

加鎖讀會不會帶來死鎖？我第一次推的時候說「會」：回呼拿著付款列的鎖、還沒碰到訂單，取消又要讀那一筆付款 —— 互等。**沒有對照狀態機就下結論，錯了**：只有訂單已經是 `PAID`（讓它變成 `PAID` 的回呼早就 commit 了）的取消才會走到這一句。最接近的情境是同一張訂單付了兩次錢、第二筆的回呼與取消同時進行；`CancelVsSecondPaymentTest` 把它釘住，結果兩邊都成功、兩筆都退 —— 回呼看到訂單是 `PAID`，只建退款單、不改訂單那一列，不等取消手上的鎖。測試、修法與這一段推論的更正，在第 12 站 4.6.2 的追記。

**兩個結論：**

- 1.6 那條規則的邊界：**用來顯示的讀可以移出交易；用來決定同一個交易裡要寫什麼的讀，不行** —— 而且在交易裡，它還得是**當前讀**，不然它看到的「同一個交易」其實是交易開始那一刻的世界。
- **在一個行程裡都會漏掉的交錯，切開之後只會更多。** 這一個 bug 從第 12 站第 04 章一直藏到專題寫完，因為它的窗口只有幾微秒；把付款切成另一個服務，這個「讀」會變成一次網路呼叫，窗口變成幾毫秒。

---

## 1.7 切錯的症狀

0.12 預告了「切錯邊界的症狀」。有了三把尺，每一個症狀都對得上一個數字 —— 不需要等到拆完、上線、出事才知道：

| # | 症狀（拆完之後你會聽到的話） | 用哪一把尺看 | 切 inventory | 切 notification |
|---|---|---|---|---|
| 1 | 「這個功能要兩個服務一起改」 | 變更耦合 | 22.2%（36 個 commit 裡 8 個） | 8.3%（3 個） |
| 2 | 「這兩個服務每次都要一起部署，而且順序要對」 | 變更耦合 ＋ 同步呼叫 | 同上；12 種同步呼叫，介面一改兩邊都要動 | 只有事件：加欄位可以各自部署（第 12 站 7.3.1 的事件契約） |
| 3 | 「要什麼資料都得去問另一個服務」 | 同步呼叫 | 12 種，來自 3 個模組 | 0 |
| 4 | 「一個動作要兩個服務都成功才算數」 | 切斷的交易 | 7 種 | 0 |
| 5 | 「它一慢，我們也跟著倒」 | 交易內呼叫 | 10 種（第 01 章之後 7 種） | 0 |
| 6 | 「報表要的資料散在兩個資料庫，JOIN 不起來」 | 直接讀表 | 0 | 0（但切 reporting 是 5） |

再加兩個看程式碼就看得出來的（1.3.3 的熱點）：

| # | 症狀 | 在哪裡看 |
|---|---|---|
| 7 | 一個模組存著只有別的模組在用的欄位 | `products.hot`：catalog 自己不用，只給 ordering 決定要不要呼叫 inventory |
| 8 | 一個功能的程式散在好幾個模組，而且總是一起改 | 搶購：catalog、ordering、inventory；第 06、07 章的 commit |

**1～6 同時出現，就是「分散式單體」**（0.4）：所有分散式的壞處（網路、部分失敗、兩份日誌），加上單體的耦合（一起改、一起部署）。第 00 章的庫存那一刀，六個症狀佔了五個。

> 📌 **這張表也可以反過來用：已經拆了的系統，拿它來找「該合回去」的那一刀。** 症狀 4、5 持續出現 —— 每一次事故都是同一對服務 —— 就是第 09 章「合回單體」的候選。

---

## 1.8 流程測試與追溯表

### 1.8.1 這一章新增的測試與實驗

| 名稱 | 種類 | 跑在哪裡 | 量／守什麼 |
|---|---|---|---|
| `B1BoundaryMapTest` | 實驗（`@Tag("experiment")`） | compose 的 MySQL、Redis；一個行程、一個資料庫 `shop_d01` | 三把尺量到的每一條線、127 種切法（1.4、1.5） |
| `B2CartCascadeTest` | 實驗 | 切開的部署（第 00 章的兩個 JVM、兩個資料庫） | 可售量查詢慢 3 秒時的購物車與「我的訂單」（1.6.5） |
| `CrossModuleCallInTxTest` | **測試**（預設的測試組） | Testcontainers | 呼叫端開著交易的跨模組呼叫只有清單上那 12 種（1.6.6） |
| `ProductCacheTest.singleFlightLateMiss` | 測試（第 12 站 6.4.3 的再追記） | Testcontainers | 「讀快取沒命中」與「搶讀取權」之間的那個交錯，MySQL 只讀 1 次 |
| `CancelRefundSnapshotTest` | 測試（第 12 站 4.6.2 的追記，1.6.7） | Testcontainers | 金流回呼落在取消的「第一句讀」與 UPDATE 之間 → 已付款的那一筆要有退款單 |
| `CancelVsSecondPaymentTest` | 測試（第 12 站 4.6.2 的追記） | Testcontainers | 同一張訂單第二筆付款的回呼與取消同時進行 → 不死鎖、兩筆都退 |

預設的測試組從第 00 章的 226 個，變成 230 個（1.9）：這一章的守門員 1 個、第 12 站的追記 3 個。

### 1.8.2 回頭量：四個代價

第 00 章說「0.2 的實驗支架會一直留著：每一章改完，都回來量同樣的四個代價」。這一章改了下單（商品快照移出交易）、購物車、賣家的商品 API —— 重跑 K1、K2、K3、K5：

```bash
mvn test -Pexperiments -Dtest=K1SplitLatencyTest      # 然後 K2、K3、K5，一次一個
```

```
═══ 0.2.1 一張一張送：每種 5 輪 × 100 張、三種部署交錯（load { 5.29 6.43 6.14 }）═══
   1 個品項 │ 一個行程       │ p50  10.59 ms │ p90  12.91 ms │ p99  18.77 ms │ {201=500}
   1 個品項 │ 切開：一次呼叫    │ p50  13.27 ms │ p90  16.36 ms │ p99  32.08 ms │ {201=500}
   1 個品項 │ 切開：每項一次    │ p50  13.29 ms │ p90  16.30 ms │ p99  27.58 ms │ {201=500}
   3 個品項 │ 一個行程       │ p50  11.57 ms │ p90  20.05 ms │ p99  42.39 ms │ {201=500}
   3 個品項 │ 切開：一次呼叫    │ p50  14.18 ms │ p90  18.67 ms │ p99  37.10 ms │ {201=500}
   3 個品項 │ 切開：每項一次    │ p50  19.65 ms │ p90  30.61 ms │ p99  54.46 ms │ {201=500}
  10 個品項 │ 一個行程       │ p50  14.30 ms │ p90  17.79 ms │ p99  29.22 ms │ {201=500}
  10 個品項 │ 切開：一次呼叫    │ p50  16.67 ms │ p90  21.18 ms │ p99  33.16 ms │ {201=500}
  10 個品項 │ 切開：每項一次    │ p50  33.92 ms │ p90  42.21 ms │ p99  70.51 ms │ {201=500}
═══ 0.2.1 16 條執行緒同時送 3 個品項的訂單：每種 15 秒 × 2 輪、交錯（load { 5.66 6.27 6.10 }）═══
  一個行程       │ 10,475 張（每秒   349）│ p50  42.29 ms │ p99   97.66 ms │ {201=10475}
  切開：一次呼叫    │  8,369 張（每秒   279）│ p50  51.97 ms │ p99  137.85 ms │ {201=8369}
  切開：每項一次    │  6,857 張（每秒   229）│ p50  63.44 ms │ p99  146.55 ms │ {201=6857}
  （結束時 load { 8.92 7.22 6.48 }）
```

```
═══ 0.2.2 ① reserve() 之後、commit 之前失敗：每種部署 100 張（load { 8.24 7.18 6.49 }）═══
  一個行程   │ 回應 {500=100} │ 這位買家的訂單 0 張 │ 沒有訂單的預留 +0 列 │ reserved +0 件
  切開     │ 回應 {500=100} │ 這位買家的訂單 0 張 │ 沒有訂單的預留 +300 列 │ reserved +300 件
═══ 0.2.2 ② 庫存服務 commit 之後慢 1.5 秒才回應，訂單服務只等 1 秒：20 張（load { 7.98 7.15 6.48 }）═══
  第一次送   │ 回應 {500=20} │ 訂單 +0 張 │ 沒有訂單的預留 +60 列 │ reserved +60 件
  同一個鍵重送 │ 回應 {201=20} │ 訂單 +20 張 │ 沒有訂單的預留 +60 列 │ reserved +120 件
  （結束時 load { 5.75 6.69 6.33 }）
```

```
═══ 0.2.3 庫存服務變慢：訂單服務的其他 API 怎麼了（每秒 20 張下單；load { 5.60 6.58 6.30 }）═══
  正常    │ 下單       │  400 次 │ p50     22.4 ms │ p99     48.3 ms │ max    107.9 ms │ {201=400}
  正常    │ 商品詳情     │   93 次 │ p50      5.8 ms │ p99     21.8 ms │ max     21.8 ms │ {200=93}
  正常    │ 我的訂單     │   93 次 │ p50      5.1 ms │ p99     27.9 ms │ max     27.9 ms │ {200=93}
  慢 3 秒 │ 下單       │  400 次 │ p50   7369.7 ms │ p99  13478.9 ms │ max  14112.0 ms │ {201=213, 503=187}
  慢 3 秒 │ 商品詳情     │   13 次 │ p50      6.5 ms │ p99      9.0 ms │ max      9.0 ms │ {200=13}
  慢 3 秒 │ 我的訂單     │   13 次 │ p50   2056.9 ms │ p99   3016.1 ms │ max   3016.1 ms │ {200=12, 503=1}
  恢復    │ 下單       │  400 次 │ p50     22.0 ms │ p99   2011.0 ms │ max   2175.4 ms │ {201=400}
  恢復    │ 商品詳情     │   82 次 │ p50      5.4 ms │ p99    107.4 ms │ max    107.4 ms │ {200=82}
  恢復    │ 我的訂單     │   82 次 │ p50      4.8 ms │ p99    206.5 ms │ max    206.5 ms │ {200=82}
  連線池：慢的那 20 秒，active 一直是 20，pending 最多 180
```

```
═══ 0.2.4 ① 訂單服務呼叫庫存時，送出了哪些 trace header（假的庫存服務，只記錄 header）（load { 4.40 5.96 6.09 }）═══
  自己 RestClient.builder()          │ 訂單服務 201，X-Trace-Id 6acca9ca57dd8883be89fc82595dd531
                                   │ 送出的 header：（沒有任何 trace header）
  Spring 的 RestClient.Builder      │ 訂單服務 201，X-Trace-Id 6acca9ccd05a6cf82174762a26995c27
                                   │ 送出的 header：traceparent=[00-6acca9ccd05a6cf82174762a26995c27-b777afba3d48d229-00]
═══ 0.2.4 ② 同一張訂單，兩個服務的 traceId（真的庫存服務）（load { 4.85 6.03 6.11 }）═══
  自己 RestClient.builder()          │ 訂單服務 201 20261012-219065，X-Trace-Id 6acca9ce6e291e1a16c9cb960f666d53
                                   │ 庫存服務 [.1-18311-exec-3] [6acca9ce73c900d395be874e154436cb-d131d36102716aeb] c.e.shop.dist00.LabInventoryService      : D00_RESERVE orderId=1 traceparent=null
  Spring 的 RestClient.Builder      │ 訂單服務 201 20261012-437748，X-Trace-Id 6acca9d0659537ea6a7618239f227b9a
                                   │ 庫存服務 [.1-18311-exec-5] [6acca9d0f9d55a5ef3713cc1bf4a0ac0-3170ce7739c5e8f1] c.e.shop.dist00.LabInventoryService      : D00_RESERVE orderId=2 traceparent=null
```

| | 第 00 章 | 第 01 章之後 | 這一章有沒有改到它 |
|---|---|---|---|
| K1 一張一張送：10 個品項，一次呼叫 / 每項一次（p50） | 17.76 / 37.34 ms | 16.67 / 33.92 ms | 沒有：遠端呼叫的次數沒變 |
| K1 16 條執行緒：一個行程 / 一次呼叫 / 每項一次（每秒） | 376 / 307 / 247 | 349 / 279 / 229 | 見下面 |
| K2 ① 孤兒預留；② 同一個鍵重送後 `reserved` 多出來的 | 300 列；120 件 | 300 列；120 件 | 沒有：切斷的交易一種都沒少 |
| K3 慢 3 秒：下單 503；「我的訂單」p50 | 192 張；1,862 ms | 187 張；2,057 ms | 沒有：`reserve()` 還在下單交易裡 |
| K5 traceId | 兩邊都斷 | 兩邊都斷 | 沒有 |

**四個代價，這一章一個都沒有減少** —— 這是預期中的：它們量的都是**下單**，而下單交易裡的 `reserve()` 要等第 04 章才拿得出來。這一章換到的東西，K1～K5 量不到，要看 1.6.5 的 B2。

K1 的吞吐三種部署都低了 7%～9%。是 1.6.4 多出來的那個唯讀交易嗎？**不能這樣歸因**：第 00 章自己兩次執行（0.2.1 的表）就差了 8%（一個行程 376 vs 406），而這一次三種部署一起低，連「一個行程」也低 —— 比較像這台機器那一刻的狀態。要確定，得把兩個版本的程式碼放在同一次執行裡交錯量，這一章沒有做。

### 1.8.3 追溯表：這一站的產出

| README 的產出 | 第 00 章 | 第 01 章加上的 |
|---|---|---|
| 1. 拆分決策文件 | 不該拆（0.3.4）；四個代價、六個問題、變更耦合 | **如果要拆，第一刀切 notification、第二刀 account；庫存第 96 名**（1.5.4）；127 種切法的五個數字；切錯的症狀表（1.7） |
| 2. 庫存拆成獨立服務、下單改成 Saga | `SplitLab` 的兩種部署 | 庫存這一刀要處理的完整清單：7 種交易、12 種呼叫（1.2）；其中 5 種讀已經移出交易（1.6），剩下 12 種寫有守門員（1.6.6） |
| 3. 跨服務報表 | 商品頁的可售量 | reporting 讀的 5 張表（1.4.5）：切 reporting 或它讀的任何一個模組，這些 JOIN 都要換掉 |
| 4. 一條完整的 trace | K5 | （沒有變） |
| 5. 基礎設施選型 | 維運清單 | （沒有變） |

---

## 1.9 本章完成後的專案

```
shop/                                                       ← 分支 d01（從 d00 開出來）
├── src/main/java/com/example/shop/
│   ├── cart/internal/CartService.java                      ← 1.6.3：問商品與庫存，移到交易之外
│   ├── catalog/internal/ProductService.java                ← 1.6.2：賣家 API 的可售量移到交易之外；補貨拆成兩步
│   ├── catalog/internal/ProductCache.java                  ← 第 12 站 6.4.3 的再追記：搶到讀取權之後再看一次快取
│   ├── ordering/internal/PlaceOrderService.java            ← 1.6.4：商品快照移到下單交易之前
│   └── payment/internal/JdbcPaymentService.java            ← 第 12 站 4.6.2 的追記：succeededPaymentOf() 改成 FOR SHARE
└── src/test/java/com/example/shop/
    ├── dist00/
    │   ├── SplitLab.java                                   ← 1.4.0、1.6.5：public；inventoryAvailableDelay()
    │   └── LabInventoryService.java                        ← 1.6.5：可售量查詢也能變慢
    ├── dist01/                                             ← + 這一章的尺、實驗、守門員
    │   ├── Probe.java、OpTag.java                           ← 1.4.1
    │   ├── ApiTap.java                                     ← 1.4.1 第一把尺
    │   ├── SqlTap.java                                     ← 1.4.2 第二把尺
    │   ├── CutEvaluator.java                               ← 1.4.3 第三把尺、1.5
    │   ├── D01Workload.java                                ← 1.4.4
    │   ├── B1BoundaryMapTest.java                          ← 1.4.5、1.5、1.6.5（實驗）
    │   ├── B2CartCascadeTest.java                          ← 1.6.5（實驗）
    │   └── CrossModuleCallInTxTest.java                    ← 1.6.6（預設的測試組）
    ├── api/AuthApiTest.java                                ← 第 12 站 5.6.4 的追記
    ├── catalog/internal/ProductCacheTest.java              ← 第 12 站 6.4.3 的再追記（singleFlightLateMiss）
    └── ordering/internal/
        ├── CancelRefundSnapshotTest.java                   ← 第 12 站 4.6.2 的追記：取消時少退款
        └── CancelVsSecondPaymentTest.java                  ← 第 12 站 4.6.2 的追記：加鎖讀不會死鎖
```

**沒有新的 migration、沒有新的 API、沒有改任何一支 API 的回應。** 正式程式碼的五個檔案裡，三個是這一章的「先拆模組」（1.6），兩個是第 12 站的追記（這一章途中找到的兩個 bug）。

完整跑一次（預設的 Testcontainers；B1、B2 標了 `experiment`，不在裡面）：

```bash
mvn clean verify
```

```
TEST_INFRA MySQL 最多同時 25 條連線（max_connections 151）
[INFO] Tests run: 230, Failures: 0, Errors: 0, Skipped: 0
[INFO] All coverage checks have been met.
[INFO] All coverage checks have been met.
[INFO] All coverage checks have been met.
[INFO] All coverage checks have been met.
[INFO] BUILD SUCCESS
[INFO] Total time:  04:11 min
```

**230 個測試**：第 00 章的 226 個，加上這一章的 `CrossModuleCallInTxTest`，以及第 12 站的追記帶來的 `ProductCacheTest.singleFlightLateMiss`、`CancelRefundSnapshotTest`、`CancelVsSecondPaymentTest`。（開始時 load { 4.96 4.64 5.03 }。）

**這是第五次。** 前四次：

- **第一次（228 個，1 個紅）**：`AuthApiTest.perIpLimit`，預期 429、拿到 401。這一章沒有碰登入 —— 那 21 個請求從 17:18:59.5 送到 17:19:01.2，跨過了整分鐘，第 12 站的固定窗從 1 重新計數。修的是測試（離整分鐘不到 5 秒就等下一分鐘），記在第 12 站 5.6.4 的追記。
- **第二次（228 個，全綠，4:33）**：那時還沒有 `CancelRefundSnapshotTest`。
- **第三次（229 個，全綠，4:07）**：加上 1.6.7 找到的退款修正。
- **第四次（229 個，全綠，4:08）**：改了 B1（`flushDb()`，1.4.5）之後再跑的 —— B1 不在預設的測試組裡，但要讓這一節的輸出就是當時最後的程式碼。
- 最後加了 `CancelVsSecondPaymentTest`（第 12 站 4.6.2 的追記：查證「加鎖讀會不會死鎖」），再跑一次，就是上面那一次。

### 1.9.1 本章其餘檔案的完整內容

正文已經完整列出的：`Probe`、`OpTag`、`ApiTap`、`SqlTap`（1.4.1、1.4.2）、`CrossModuleCallInTxTest`（1.6.6）。第 12 站的追記改到的 `ProductCache`、`ProductCacheTest`、`AuthApiTest`、`JdbcPaymentService`，改的那幾行在第 12 站 6.4.3、5.6.4、4.6.2 的追記裡。下面是其餘每一個新增或改過的檔案（`d01` 分支上的版本）：

**`src/test/java/com/example/shop/dist01/CutEvaluator.java`**（1.4.3 第三把尺、1.5 的 127 種切法）

```java
package com.example.shop.dist01;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Comparator;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 13 站 1.5：一刀切下去，三把尺各量到什麼。
 *
 * 「一刀」= 八個模組分成兩邊：S 這一邊變成另一個服務（另一個行程、另一個資料庫），其他留在原地。ordering 永遠留在原地，
 * 所以 S 是其他七個模組的非空子集：2^7 − 1 = 127 種切法。
 *
 *   交易（第二把尺）  ：commit 了的交易裡，寫了兩邊的表 → 切開之後它不再是一個交易（0.2.2）
 *   交易內呼叫（第一把）：呼叫端開著交易、呼叫另一邊 → 等待佔著連線（0.2.3）；被呼叫端要是 MANDATORY，連交易語意都沒了
 *   同步呼叫（第一把）  ：所有跨過這一刀的方法呼叫 → 每一個都變成一次網路往返（0.2.1）
 *   直接讀表（第二把）  ：一句 SQL 讀了另一邊的表 → 切開之後這句 SQL 不存在（第 02、05 章）
 *   事件              ：跨過這一刀的事件 → 本來就是非同步、走 outbox，切開之後換成真的 broker 就好（第 12 站第 07 章）
 *   變更（第三把尺）  ：正式程式碼的 commit 裡，同時改了兩邊的比例（0.3.3）
 *
 * 「種類」是不同的地方（不同的動作、不同的呼叫點），不是次數：工作負載每個動作只走一兩次，次數沒有意義。
 */
final class CutEvaluator {

    record Score(Set<String> cut, Set<String> brokenTx, Set<String> inTxCalls, Set<String> calls, Set<String> reads,
                 Set<String> events, int crossingCommits, int commits) {
        double changePct() { return commits == 0 ? 0 : 100.0 * crossingCommits / commits; }
        String name() { return String.join("+", cut); }
    }

    static final Comparator<Score> RANK = Comparator.<Score>comparingInt(s -> s.brokenTx().size())
            .thenComparingInt(s -> s.inTxCalls().size())
            .thenComparingInt(s -> s.calls().size())
            .thenComparingInt(s -> s.reads().size())
            .thenComparingDouble(Score::changePct);

    private final List<Set<String>> commits;                                 // 每一個改到正式程式碼的 commit 碰了哪些模組（不含 shared）

    CutEvaluator(List<Set<String>> commits) {
        this.commits = commits;
    }

    List<Score> all() {
        List<String> movable = Probe.MODULES.stream().filter(m -> !m.equals("ordering")).toList();
        List<Score> scores = new ArrayList<>();
        for (int mask = 1; mask < (1 << movable.size()); mask++) {
            Set<String> cut = new TreeSet<>();
            for (int i = 0; i < movable.size(); i++) if ((mask & (1 << i)) != 0) cut.add(movable.get(i));
            scores.add(score(cut));
        }
        scores.sort(RANK);
        return scores;
    }

    Score score(Set<String> cut) {
        Set<String> brokenTx = new TreeSet<>(), inTx = new TreeSet<>(), calls = new TreeSet<>(), reads = new TreeSet<>(), events = new TreeSet<>();
        for (Probe.Tx t : Probe.TXS)
            if (crosses(t.wrote(), cut)) brokenTx.add(t.op() + "  寫 " + new TreeSet<>(t.wrote()));
        for (Probe.Call c : Probe.CALLS)
            if (cut.contains(c.caller()) != cut.contains(c.callee())) {
                String k = c.caller() + " → " + c.method();
                calls.add(k);
                if (c.inTx()) inTx.add(k);
            }
        for (Probe.Read r : Probe.READS)
            if (cut.contains(r.reader()) != cut.contains(r.owner())) reads.add(r.reader() + " 讀 " + r.table());
        for (Probe.Event e : Probe.EVENTS)
            if (!e.consumerModule().equals("shared") && cut.contains(e.publisher()) != cut.contains(e.consumerModule()))
                events.add(e.type() + " → " + e.consumer());
        int crossing = (int) commits.stream().filter(m -> crosses(m, cut)).count();
        return new Score(cut, brokenTx, inTx, calls, reads, events, crossing, commits.size());
    }

    static boolean crosses(Collection<String> modules, Set<String> cut) {
        boolean in = false, out = false;
        for (String m : modules) {
            if (m.equals("shared")) continue;
            if (cut.contains(m)) in = true; else out = true;
        }
        return in && out;
    }

    // ───────── 第三把尺：git 歷史（跟 0.3.3 的 d00-change-coupling.sh 同一套規則）─────────

    private static final Pattern SRC = Pattern.compile("^src/main/java/com/example/shop/([a-z]+)/");
    private static final Pattern MIGRATION = Pattern.compile("^src/main/resources/db/migration/V[0-9]+__([a-z]+)_");

    static List<Set<String>> commitsOf(String range) throws Exception {
        Process p = new ProcessBuilder("git", "log", "--first-parent", "--no-merges", "--name-only", "--format=@%h", range)
                .redirectErrorStream(true).start();
        List<Set<String>> result = new ArrayList<>();
        Set<String> current = null;
        try (BufferedReader r = new BufferedReader(new InputStreamReader(p.getInputStream(), StandardCharsets.UTF_8))) {
            for (String line; (line = r.readLine()) != null; ) {
                if (line.startsWith("@")) {
                    if (current != null && !current.isEmpty()) result.add(current);
                    current = new HashSet<>();
                    continue;
                }
                Matcher m = SRC.matcher(line);
                if (m.find() && current != null) { current.add(m.group(1)); continue; }
                m = MIGRATION.matcher(line);
                if (m.find() && current != null) current.add(m.group(1));
            }
        }
        if (current != null && !current.isEmpty()) result.add(current);
        if (p.waitFor() != 0) throw new IllegalStateException("git log " + range + " 失敗");
        return result;
    }

    /** 給報表用：依 key 分組、數次數，保持第一次出現的順序 */
    static <T> Map<String, List<T>> group(Collection<T> items, java.util.function.Function<T, String> key) {
        Map<String, List<T>> m = new LinkedHashMap<>();
        for (T t : items) m.computeIfAbsent(key.apply(t), k -> new ArrayList<>()).add(t);
        return m;
    }
}
```

**`src/test/java/com/example/shop/dist01/D01Workload.java`**（1.4.4 使用者的一天）

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
 */
final class D01Workload {

    record Step(String op, int status) {}

    static final long ADMIN = 990_901;                                       // JWT 不查資料庫（TestTokens 的說明）：管理員不需要真的存在

    private final ConfigurableApplicationContext ctx;
    private final String db;
    private final ObjectMapper json = new ObjectMapper();
    final List<Step> steps = new ArrayList<>();

    D01Workload(ConfigurableApplicationContext ctx, String db) {
        this.ctx = ctx;
        this.db = db;
    }

    void run() throws Exception {
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
        job("排程 OrderJobs.cancelExpired", "orderJobs", "cancelExpired");
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
        job("排程 OrderJobs.autoComplete", "orderJobs", "autoComplete");
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
        job("排程 HotStock.reconcile", "hotStock", "reconcile");
        job("排程 InventoryReconciliation.checkInvariants", "inventoryReconciliation", "checkInvariants");
    }

    // ───────── 一步一步 ─────────

    private long createAndPublish(String seller, String name) throws Exception {
        long id = call("POST", "/api/seller/products", seller, Map.of("name", name, "price", new BigDecimal("100.00"),
                "categoryId", 11, "initialStock", 100), 201).get("id").asLong();
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

    /** outbox 裡還沒送出的事件，交給訂閱它的每一個消費者（不經過 RabbitMQ），直到沒有新的事件。每一次交付標成「事件 X → 消費者」 */
    private void events() throws Exception {
        EventDispatcher dispatcher = ctx.getBean(EventDispatcher.class);
        Map<String, EventHandler> handlers = ctx.getBeansOfType(EventHandler.class);
        for (int round = 0; round < 10; round++) {
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
            if (pending.isEmpty()) return;
            for (Event e : pending)
                for (EventHandler h : handlers.values())
                    if (h.eventTypes().contains(e.type())) {
                        String consumerModule = moduleOfClass(AopTestUtils.getUltimateTargetObject(h).getClass().getName());
                        Probe.EVENTS.add(new Probe.Event("事件 " + e.type() + " → " + h.consumer(), e.type(), publisherOf(e.type()), h.consumer(), consumerModule));
                        OpTag.run("事件 " + e.type() + " → " + h.consumer(), () -> dispatcher.dispatch(h, e));
                    }
            for (long id : ids) sql("UPDATE outbox_events SET published_at = NOW(3) WHERE id = ?", id);
        }
        throw new IllegalStateException("事件一直產生新的事件，交付了 10 輪還沒停");
    }

    /** 事件的名字就是它的發送模組：order.* → ordering、refund.* → payment、inventory.* → inventory（第 12 站 7.3.1 的 EventTypes） */
    static String publisherOf(String type) {
        return switch (type.substring(0, type.indexOf('.'))) {
            case "order" -> "ordering";
            case "refund" -> "payment";
            default -> type.substring(0, type.indexOf('.'));
        };
    }

    static String moduleOfClass(String className) {
        return className.substring("com.example.shop.".length()).split("\\.")[0];
    }

    /** 排程的方法是 package-private（第 12 站沒有打算讓別人呼叫它們）：實驗用反射直接呼叫，標成「排程 X」 */
    private void job(String op, String bean, String method) {
        Object target = AopTestUtils.getUltimateTargetObject(ctx.getBean(bean));
        OpTag.run(op, () -> ReflectionTestUtils.invokeMethod(target, method));
        steps.add(new Step(op, 0));
    }

    private void sql(String sql, Object arg) throws Exception {
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

**`src/test/java/com/example/shop/dist01/B1BoundaryMapTest.java`**（1.4.5、1.5、1.6.5（實驗））

```java
package com.example.shop.dist01;

import com.example.shop.ShopApplication;
import com.example.shop.dist00.SplitLab;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.context.ConfigurableApplicationContext;

import java.io.PrintStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 13 站 1.4～1.5：把第 12 站的單體跑一遍「使用者的一天」，用三把尺量模組之間的每一條線，再算出 127 種切法各切斷了什麼。
 *
 *   mvn test -Pexperiments -Dtest=B1BoundaryMapTest -Dd01.range=ch09      ← ch09：你自己第 12 站結束時的分支（變更耦合用）
 *
 * 一個行程、一個資料庫（shop_d01，跟第 00 章的三個庫分開）。Redis 用 14 號 database。
 */
@Tag("experiment")
class B1BoundaryMapTest {

    static final String DB = "shop_d01";

    @Test
    void boundaryMap() throws Exception {
        SplitLab.freshDatabase(DB);
        List<String> args = new ArrayList<>(SplitLab.common(DB, 14));
        args.removeIf(a -> a.startsWith("--spring.datasource.url="));        // 同一個參數給兩次，Spring 會把兩個值用逗號接起來
        args.add("--spring.datasource.url=" + SplitLab.url(DB) + "&queryInterceptors=" + SqlTap.class.getName());
        args.add("--lab.d01.probe=true");
        args.removeIf(a -> a.startsWith("--shop.order.jobs-enabled="));    // 要有 OrderJobs 這個 bean（逾時、自動完成），間隔拉長到不會自己跑第二次
        args.addAll(List.of("--shop.order.jobs-enabled=true", "--shop.order.timeout-scan-interval=1h"));
        D01Workload w;
        try (ConfigurableApplicationContext ctx = new SpringApplicationBuilder(ShopApplication.class).run(args.toArray(String[]::new))) {
            Thread.sleep(1000);                                              // 排程在啟動時各跑一次（空的資料庫）：等它跑完
            // 資料庫每次重建，商品與使用者的 id 每次都從同一個號碼開始 —— Redis 不清的話，上一次執行的熱門排行、商品快取、熱點閘門都還在。
            // 第一版沒有清：同一份程式碼連跑兩次，第二次的熱門排行走了快取，「讀別人的表」少了 3 句
            ctx.getBean(org.springframework.data.redis.core.StringRedisTemplate.class).execute((org.springframework.data.redis.core.RedisCallback<Void>) c -> {
                c.serverCommands().flushDb();
                return null;
            });
            Probe.reset();                                                   // Flyway、啟動時的查詢、排程的第一次都不算
            w = new D01Workload(ctx, DB);
            w.run();
        }
        String range = System.getProperty("d01.range", "HEAD");
        CutEvaluator eval = new CutEvaluator(CutEvaluator.commitsOf(range));
        List<CutEvaluator.Score> all = eval.all();

        PrintStream out = System.out;
        out.printf("═══ 1.4 使用者的一天：%d 個 HTTP 請求、%d 次事件交付、%d 個排程（load %s）═══%n",
                w.steps.stream().filter(s -> s.status() > 0).count(), Probe.EVENTS.size(), w.steps.stream().filter(s -> s.status() == 0).count(), SplitLab.load());
        out.printf("  記到：跨模組的同步呼叫 %d 次、commit 的交易 %d 個、讀別人的表 %d 句%n", Probe.CALLS.size(), Probe.TXS.size(), Probe.READS.size());
        out.printf("  走過的 API：%d 支 %s%n", Probe.OPS.size(), new TreeSet<>(Probe.OPS));

        out.println("═══ 1.4.1 第一把尺：跨模組的同步呼叫（呼叫端 → 介面.方法：次數，其中幾次在呼叫端的交易裡；哪些動作）═══");
        CutEvaluator.group(Probe.CALLS, c -> c.caller() + " → " + c.method()).entrySet().stream()
                .sorted(Map.Entry.comparingByKey())
                .forEach(e -> out.printf("  %-44s %2d 次（交易裡 %2d，唯讀 %2d）  %s%n", e.getKey(), e.getValue().size(),
                        e.getValue().stream().filter(Probe.Call::inTx).count(), e.getValue().stream().filter(Probe.Call::readOnlyTx).count(),
                        new TreeSet<>(e.getValue().stream().map(Probe.Call::op).toList())));

        out.println("═══ 1.4.2 第二把尺：寫了兩個以上模組的表的交易（動作：寫了哪些模組 × 個數）═══");
        Map<String, Integer> multi = new TreeMap<>();
        for (Probe.Tx t : Probe.TXS) if (t.wrote().size() > 1) multi.merge(t.op() + "  寫 " + new TreeSet<>(t.wrote()), 1, Integer::sum);
        multi.forEach((k, n) -> out.printf("  %-90s × %d%n", k, n));
        out.printf("  （commit 的交易一共 %d 個，寫了兩個以上模組的 %d 個）%n", Probe.TXS.size(), Probe.TXS.stream().filter(t -> t.wrote().size() > 1).count());

        out.println("═══ 1.4.2 一句 SQL 讀了別的模組的表（讀的模組 → 表：句數；哪些動作）═══");
        CutEvaluator.group(Probe.READS, r -> r.reader() + " → " + r.table() + "（" + r.owner() + "）").forEach((k, v) ->
                out.printf("  %-44s %2d 句  %s%n", k, v.size(), new TreeSet<>(v.stream().map(Probe.Read::op).toList())));

        out.println("═══ 事件：發送的模組 → 消費者（消費者所在的模組）═══");
        CutEvaluator.group(Probe.EVENTS, e -> e.publisher() + " ─ " + e.type() + " → " + e.consumer() + "（" + e.consumerModule() + "）").forEach((k, v) ->
                out.printf("  %-78s × %d%n", k, v.size()));

        out.printf("═══ 1.5 127 種切法（ordering 留在原地，S 切出去）；變更耦合：%s，%d 個改到正式程式碼的 commit ═══%n", range, all.get(0).commits());
        out.println("  名次 │ 切出去的 S                          │ 切斷的交易 │ 交易內呼叫 │ 同步呼叫 │ 直接讀表 │ 事件 │ 變更耦合");
        for (int i = 0; i < all.size(); i++) {
            CutEvaluator.Score s = all.get(i);
            boolean named = Set.of("inventory", "catalog", "cart", "payment", "account", "notification", "reporting", "catalog+inventory").contains(s.name());
            if (i < 12 || named) out.printf("  %4d │ %-35s │ %10d │ %10d │ %8d │ %8d │ %4d │ %5.1f%%（%d）%n", i + 1, s.name(),
                    s.brokenTx().size(), s.inTxCalls().size(), s.calls().size(), s.reads().size(), s.events().size(), s.changePct(), s.crossingCommits());
        }
        try (PrintStream f = new PrintStream(Files.newOutputStream(Path.of("target/d01-cuts.txt")))) {
            for (int i = 0; i < all.size(); i++) {
                CutEvaluator.Score s = all.get(i);
                f.printf("%4d %-50s 交易 %2d  交易內呼叫 %2d  同步呼叫 %2d  讀表 %2d  事件 %2d  變更 %5.1f%%%n", i + 1, s.name(),
                        s.brokenTx().size(), s.inTxCalls().size(), s.calls().size(), s.reads().size(), s.events().size(), s.changePct());
            }
        }
        out.println("  （127 種全部：target/d01-cuts.txt）");
        List<CutEvaluator.Score> withInventory = all.stream().filter(x -> x.cut().contains("inventory")).toList();
        out.printf("  包含 inventory 的 %d 種切法：切斷的交易最少 %d 種；前三名：%n", withInventory.size(), withInventory.get(0).brokenTx().size());
        for (CutEvaluator.Score x : withInventory.subList(0, 3))
            out.printf("    第 %3d 名 %-35s 交易 %d、交易內呼叫 %d、同步呼叫 %d%n", all.indexOf(x) + 1, x.name(), x.brokenTx().size(), x.inTxCalls().size(), x.calls().size());

        for (String name : List.of("inventory", "notification")) {
            CutEvaluator.Score s = eval.score(new TreeSet<>(List.of(name.split("\\+"))));
            out.printf("═══ 1.5 切出 %s：切斷了什麼 ═══%n", name);
            out.println("  切斷的交易：");        s.brokenTx().forEach(x -> out.println("    " + x));
            out.println("  交易內的同步呼叫："); s.inTxCalls().forEach(x -> out.println("    " + x));
            out.println("  所有同步呼叫：");     s.calls().forEach(x -> out.println("    " + x));
            out.println("  直接讀表：");         s.reads().forEach(x -> out.println("    " + x));
            out.println("  跨過去的事件：");     s.events().forEach(x -> out.println("    " + x));
            out.printf("  變更耦合：%d／%d 個 commit（%.1f%%）%n", s.crossingCommits(), s.commits(), s.changePct());
        }
        out.printf("  （結束時 load %s）%n", SplitLab.load());

        assertThat(Probe.CALLS).isNotEmpty();
        assertThat(Probe.TXS).isNotEmpty();
    }
}
```

**`src/test/java/com/example/shop/dist01/B2CartCascadeTest.java`**（1.6.5（實驗））

```java
package com.example.shop.dist01;

import io.micrometer.core.instrument.MeterRegistry;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.context.ConfigurableApplicationContext;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ThreadLocalRandom;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

import static com.example.shop.dist00.SplitLab.*;

/**
 * 13 站 1.6.5：把跨模組的讀移出交易，切開之後差在哪裡。K3（0.2.3）的同一個做法，換成「購物車」：
 * 切開的部署，每秒固定看 20 次購物車（開放式負載）；同時每 200 ms 看一次「我的訂單」（只查訂單服務自己的資料庫）。
 * 三段，每段 20 秒：正常 → 庫存服務的可售量查詢慢 3 秒 → 恢復。每秒記一次訂單服務的連線池。
 *
 * 同一個實驗跑兩次，只有正式程式碼不同：
 *   mvn test -Pexperiments -Dtest=B2CartCascadeTest -Dd01.variant=第12站     ← src/main 換回這一章之前的版本
 *   mvn test -Pexperiments -Dtest=B2CartCascadeTest -Dd01.variant=第01章
 */
@Tag("experiment")
class B2CartCascadeTest {

    record Sample(long atMs, String what, int status, long nanos) {}

    static final long FIRST_BUYER = 5_100_001;
    static final int BUYERS = 400;

    @Test
    void cartCascade() throws Exception {
        String variant = System.getProperty("d01.variant", "?");
        freshDatabase(ORDER_DB); freshDatabase(INV_DB);
        Process inv = startInventoryService();
        try (ConfigurableApplicationContext split = startSplitOrder(false, 10_000)) {
            seed(INV_DB, false, true);
            seed(ORDER_DB, true, false);
            fillCarts();
            MeterRegistry meters = split.getBean(MeterRegistry.class);
            long probeBuyer = 4_242_424;
            for (int i = 0; i < 5; i++) placeOrder(split, probeBuyer, 1, null);              // 讓「我的訂單」有東西可查
            for (int i = 0; i < 200; i++) get(split, "/api/cart", buyer());            // 暖機

            System.out.printf("═══ 1.6.5 庫存服務的可售量查詢變慢：訂單服務怎麼了（%s；每秒 20 次購物車；load %s）═══%n", variant, load());
            long t0 = System.nanoTime();
            AtomicBoolean stop = new AtomicBoolean();
            ConcurrentLinkedQueue<Sample> carts = new ConcurrentLinkedQueue<>(), probes = new ConcurrentLinkedQueue<>();
            ExecutorService load = Executors.newVirtualThreadPerTaskExecutor();
            Thread sender = new Thread(() -> {
                for (long i = 0; !stop.get(); i++) {
                    long due = t0 + i * 50_000_000L;                       // 每 50 ms 一次 = 每秒 20 次
                    long wait = due - System.nanoTime();
                    if (wait > 0) try { Thread.sleep(wait / 1_000_000, (int) (wait % 1_000_000)); } catch (InterruptedException e) { return; }
                    long sentAt = (System.nanoTime() - t0) / 1_000_000;
                    load.submit(() -> {
                        Result r = get(split, "/api/cart", buyer());
                        carts.add(new Sample(sentAt, "cart", r.status(), r.nanos()));
                    });
                }
            });
            sender.start();
            Thread prober = new Thread(() -> {
                while (!stop.get()) {
                    long at = (System.nanoTime() - t0) / 1_000_000;
                    Result o = get(split, "/api/orders", probeBuyer);
                    probes.add(new Sample(at, "myorders", o.status(), o.nanos()));
                    try { Thread.sleep(200); } catch (InterruptedException e) { return; }
                }
            });
            prober.start();
            List<String> pool = new ArrayList<>();
            String[] phase = {"正常", "慢 3 秒", "恢復"};
            for (int p = 0; p < 3; p++) {
                inventoryAvailableDelay(p == 1 ? 3_000 : 0);
                for (int s = 0; s < 20; s++) {
                    Thread.sleep(1_000);
                    pool.add(String.format("%3d 秒 %-5s active %2.0f pending %3.0f", (System.nanoTime() - t0) / 1_000_000_000L, phase[p],
                            meters.get("hikaricp.connections.active").gauge().value(), meters.get("hikaricp.connections.pending").gauge().value()));
                }
            }
            stop.set(true);
            sender.join();
            prober.join();
            load.shutdown();
            load.awaitTermination(60, TimeUnit.SECONDS);
            inventoryAvailableDelay(0);

            for (int p = 0; p < 3; p++) {
                long from = p * 20_000L, to = from + 20_000L;
                for (String what : new String[]{"cart", "myorders"}) {
                    var src = what.equals("cart") ? carts : probes;
                    List<Sample> in = src.stream().filter(x -> x.atMs() >= from && x.atMs() < to).toList();
                    long[] s = in.stream().mapToLong(Sample::nanos).sorted().toArray();
                    Map<Integer, Integer> codes = new TreeMap<>();
                    in.forEach(x -> codes.merge(x.status(), 1, Integer::sum));
                    System.out.printf("  %-5s │ %-6s │ %4d 次 │ p50 %8.1f ms │ p99 %8.1f ms │ max %8.1f ms │ %s%n", phase[p],
                            what.equals("cart") ? "購物車" : "我的訂單", in.size(), pct(s, 50), pct(s, 99), pct(s, 100), codes);
                }
            }
            System.out.println("  連線池（每秒）：");
            for (String line : pool) System.out.println("    " + line);
            System.out.printf("  （結束時 load %s）%n", load());
        } finally {
            inv.destroy();
            inv.waitFor(30, TimeUnit.SECONDS);
        }
    }

    static long buyer() {
        return FIRST_BUYER + ThreadLocalRandom.current().nextInt(BUYERS);
    }

    /** 400 位買家，每人的購物車裡 3 個不同的商品 */
    static void fillCarts() throws Exception {
        try (Connection c = root(ORDER_DB); PreparedStatement ps = c.prepareStatement(
                "INSERT INTO cart_items (buyer_id, product_id, quantity, unit_price_at_add) VALUES (?, ?, 1, 100.00)")) {
            for (int b = 0; b < BUYERS; b++)
                for (int i = 0; i < 3; i++) {
                    ps.setLong(1, FIRST_BUYER + b);
                    ps.setLong(2, FIRST_PRODUCT + (b * 3L + i) % PRODUCTS);
                    ps.addBatch();
                }
            ps.executeBatch();
        }
    }
}
```

**`src/test/java/com/example/shop/dist00/SplitLab.java`**（第 00 章的實驗支架；1.4.0、1.6.5 改成 public、多了 inventoryAvailableDelay()）

```java
package com.example.shop.dist00;

import com.example.shop.ShopApplication;
import com.example.shop.support.TestTokens;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.boot.web.context.WebServerApplicationContext;
import org.springframework.context.ConfigurableApplicationContext;

import java.io.File;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.Statement;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.ThreadLocalRandom;

/**
 * 13 站 0.2 的實驗支架：同一份第 12 站的程式碼，兩種部署。
 *
 *   一個行程（mono）    ：ShopApplication，一個資料庫 shop_d00_mono。下單交易裡 reserve() 是本地呼叫，跟訂單一起 commit。
 *   切開（split）       ：訂單服務 = ShopApplication + RemoteInventoryApi，資料庫 shop_d00_order；
 *                         庫存服務 = 另一個 JVM 的 ShopApplication + LabInventoryService，資料庫 shop_d00_inv。
 *
 * 用的是第 12 站 compose 的那一台 MySQL、Redis（不碰 shop 這個庫；Redis 用 11～13 號 database，跟 shop 的 0 號分開）。
 * 資料庫比照驗收 Q6：root 建庫、shop_migrator 跑 migration、應用程式的 shop 只拿 shop_app 這個角色（第 12 站 9.11）。
 *
 * 第 01 章起：class 與幾個工具方法改成 public —— 之後每一章的實驗在自己的套件（dist01、dist02……），回來用同一套支架。
 */
public final class SplitLab {

    public static final String MONO_DB = "shop_d00_mono", ORDER_DB = "shop_d00_order", INV_DB = "shop_d00_inv";
    public static final int INV_PORT = 18311;
    public static final long SELLER = 900_001, FIRST_PRODUCT = 9_000_001;
    public static final int PRODUCTS = 1_000;

    private SplitLab() {}

    // ───────── 資料庫 ─────────

    public static Connection root(String db) throws Exception {
        return DriverManager.getConnection("jdbc:mysql://localhost:3306/" + db + "?useSSL=false&allowPublicKeyRetrieval=true&connectionTimeZone=UTC&rewriteBatchedStatements=true", "root", "root");
    }

    public static void freshDatabase(String db) throws Exception {
        try (Connection c = root(""); Statement st = c.createStatement()) {
            st.execute("DROP DATABASE IF EXISTS " + db);
            st.execute("CREATE DATABASE " + db);
            st.execute("GRANT ALL PRIVILEGES ON `" + db + "`.* TO 'shop_migrator'@'%' WITH GRANT OPTION");
        }
    }

    public static String url(String db) {
        return "jdbc:mysql://localhost:3306/" + db + "?useSSL=false&allowPublicKeyRetrieval=true&connectionTimeZone=UTC&rewriteBatchedStatements=true";
    }

    /** 1,000 個上架的商品（同一位賣家，單價 100）；withInventory：每個 1,000 萬件，不讓「庫存不足」混進延遲 */
    public static void seed(String db, boolean products, boolean withInventory) throws Exception {
        try (Connection c = root(db)) {
            c.setAutoCommit(false);
            if (products) {
                long category;
                try (Statement st = c.createStatement(); ResultSet rs = st.executeQuery("SELECT MIN(id) FROM categories")) { rs.next(); category = rs.getLong(1); }
                try (PreparedStatement ps = c.prepareStatement("INSERT INTO products (id, seller_id, category_id, name, price, status) VALUES (?, ?, ?, ?, 100.00, 'ON_SALE')")) {
                    for (int i = 0; i < PRODUCTS; i++) {
                        ps.setLong(1, FIRST_PRODUCT + i); ps.setLong(2, SELLER); ps.setLong(3, category); ps.setString(4, "d00 商品 " + i);
                        ps.addBatch();
                    }
                    ps.executeBatch();
                }
            }
            if (withInventory) {
                try (PreparedStatement ps = c.prepareStatement("INSERT INTO inventory (product_id, on_hand, reserved) VALUES (?, 10000000, 0)")) {
                    for (int i = 0; i < PRODUCTS; i++) { ps.setLong(1, FIRST_PRODUCT + i); ps.addBatch(); }
                    ps.executeBatch();
                }
            }
            c.commit();
        }
    }

    public static long count(String db, String sql) throws Exception {
        try (Connection c = root(db); Statement st = c.createStatement(); ResultSet rs = st.executeQuery(sql)) { rs.next(); return rs.getLong(1); }
    }

    // ───────── 應用程式 ─────────

    public static List<String> common(String db, int redisDb) {
        return new ArrayList<>(List.of("--server.port=0", "--spring.datasource.url=" + url(db),
                "--shop.order.jobs-enabled=false", "--shop.inventory.jobs-enabled=false",
                "--shop.messaging.relay-enabled=false", "--shop.messaging.consumers-enabled=false",
                "--shop.rate-limit.enabled=false", "--spring.data.redis.database=" + redisDb,
                "--spring.main.banner-mode=off", "--logging.level.root=WARN"));
    }

    static ConfigurableApplicationContext startMono() {
        return new SpringApplicationBuilder(ShopApplication.class).run(common(MONO_DB, 11).toArray(String[]::new));
    }

    public static ConfigurableApplicationContext startSplitOrder(boolean perLine, long readTimeoutMs) {
        List<String> a = common(ORDER_DB, 12);
        a.addAll(List.of("--lab.d00.remote-inventory-url=http://127.0.0.1:" + INV_PORT, "--lab.d00.per-line=" + perLine,
                "--lab.d00.read-timeout-ms=" + readTimeoutMs));
        return new SpringApplicationBuilder(ShopApplication.class).run(a.toArray(String[]::new));
    }

    /** 庫存服務：另一個 JVM（同一個 classpath），日誌寫到 target/d00-inventory-service.log */
    public static Process startInventoryService() throws Exception {
        List<String> cmd = new ArrayList<>(List.of(ProcessHandle.current().info().command().orElse("java"),
                "-Dshop.test.infra=compose", "-cp", System.getProperty("java.class.path"), ShopApplication.class.getName()));
        List<String> a = common(INV_DB, 13);
        a.set(0, "--server.port=" + INV_PORT);
        a.add("--lab.d00.inventory-service=true");
        a.add("--logging.level.com.example.shop.dist00=INFO");               // 0.2.4：D00_RESERVE 那一行
        cmd.addAll(a);
        Process p = new ProcessBuilder(cmd).redirectErrorStream(true).redirectOutput(new File("target/d00-inventory-service.log")).start();
        HttpClient c = HttpClient.newHttpClient();
        for (int i = 0; i < 120; i++) {
            try {
                if (c.send(HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + INV_PORT + "/actuator/health/readiness")).build(),
                        HttpResponse.BodyHandlers.discarding()).statusCode() == 200) return p;
            } catch (Exception notYet) { /* 還沒開始聽 */ }
            if (!p.isAlive()) throw new IllegalStateException("庫存服務沒有起來，看 target/d00-inventory-service.log");
            Thread.sleep(500);
        }
        p.destroy();
        throw new IllegalStateException("庫存服務 60 秒內沒有 ready");
    }

    /** 13 站 1.6.5：可售量查詢（GET /lab/inventory/available）回應之前多等多久 */
    public static void inventoryAvailableDelay(long ms) throws Exception {
        HttpClient.newHttpClient().send(HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + INV_PORT + "/lab/inventory/delay?what=available&ms=" + ms))
                .POST(HttpRequest.BodyPublishers.noBody()).build(), HttpResponse.BodyHandlers.discarding());
    }

    public static void inventoryDelay(long ms) throws Exception {
        HttpClient.newHttpClient().send(HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + INV_PORT + "/lab/inventory/delay?ms=" + ms))
                .POST(HttpRequest.BodyPublishers.noBody()).build(), HttpResponse.BodyHandlers.discarding());
    }

    public static int port(ConfigurableApplicationContext ctx) {
        return ((WebServerApplicationContext) ctx).getWebServer().getPort();
    }

    // ───────── 下單 ─────────

    public record Result(int status, long nanos, String body) {}

    public static final HttpClient CLIENT = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(2)).build();

    /** 一張 n 個品項的訂單（隨機挑 n 個不同的商品，避開熱點列的鎖競爭），走 HTTP，跟真的客戶端一樣 */
    public static Result placeOrder(ConfigurableApplicationContext ctx, long buyerId, int lines, String key) {
        long[] ids = ThreadLocalRandom.current().longs(0, PRODUCTS).distinct().limit(lines).map(i -> FIRST_PRODUCT + i).toArray();
        String items = String.join(",", Arrays.stream(ids).mapToObj(id -> "{\"productId\":" + id + ",\"quantity\":1,\"unitPrice\":100.00}").toList());
        HttpRequest req = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port(ctx) + "/api/orders"))
                .timeout(Duration.ofSeconds(30))
                .header("Content-Type", "application/json")
                .header("Authorization", TestTokens.bearer(ctx, buyerId))
                .header("Idempotency-Key", key == null ? UUID.randomUUID().toString() : key)
                .POST(HttpRequest.BodyPublishers.ofString("{\"items\":[" + items + "]}")).build();
        long t0 = System.nanoTime();
        try {
            HttpResponse<String> r = CLIENT.send(req, HttpResponse.BodyHandlers.ofString());
            return new Result(r.statusCode(), System.nanoTime() - t0, r.body());
        } catch (Exception e) {
            return new Result(-1, System.nanoTime() - t0, e.toString());
        }
    }

    public static Result get(ConfigurableApplicationContext ctx, String path, long buyerId) {
        HttpRequest.Builder b = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port(ctx) + path)).timeout(Duration.ofSeconds(30));
        if (buyerId > 0) b.header("Authorization", TestTokens.bearer(ctx, buyerId));
        long t0 = System.nanoTime();
        try {
            HttpResponse<String> r = CLIENT.send(b.build(), HttpResponse.BodyHandlers.ofString());
            return new Result(r.statusCode(), System.nanoTime() - t0, r.body());
        } catch (Exception e) {
            return new Result(-1, System.nanoTime() - t0, e.toString());
        }
    }

    // ───────── 統計 ─────────

    public static double pct(long[] sortedNanos, double p) {
        if (sortedNanos.length == 0) return Double.NaN;
        int i = (int) Math.ceil(p / 100.0 * sortedNanos.length) - 1;
        return sortedNanos[Math.max(0, Math.min(i, sortedNanos.length - 1))] / 1e6;
    }

    public static String load() {
        try {
            Process p = new ProcessBuilder("sysctl", "-n", "vm.loadavg").start();
            return new String(p.getInputStream().readAllBytes()).strip();
        } catch (Exception e) {
            return "?";
        }
    }
}
```

**`src/test/java/com/example/shop/dist00/LabInventoryService.java`**（第 00 章的庫存服務；1.6.5 多了可售量查詢的延遲）

```java
package com.example.shop.dist00;

import com.example.shop.inventory.InsufficientStockException;
import com.example.shop.inventory.InventoryApi;
import com.example.shop.inventory.ReserveLine;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.annotation.Order;
import org.springframework.http.ResponseEntity;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configurers.AbstractHttpConfigurer;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.Map;

/**
 * 13 站 0.2：「庫存服務」那一側。同一份程式碼、另一個行程、另一個資料庫 —— 只多了一支給訂單服務呼叫的 HTTP 端點。
 * 只在 lab.d00.inventory-service=true 時存在：其他測試的 context 掃得到這個類別，但不會建立它。
 *
 * reserve() 在第 12 站是 MANDATORY（必須在下單交易裡）。到了另一個行程，「下單交易」不存在了 —— 這裡只能自己開一個交易、自己 commit。
 * 這一行 tx.executeWithoutResult 就是整個 0.2.2 的來源。
 */
@Configuration
@ConditionalOnProperty(name = "lab.d00.inventory-service", havingValue = "true")
class LabInventoryService {

    /** 0.2.2 ②、0.2.3：回應之前（預留已經 commit 之後）多等多久。模擬「庫存服務變慢了」 */
    static volatile long delayMs = 0;
    /** 13 站 1.6.5：可售量查詢回應之前多等多久。模擬「庫存服務的查詢變慢了」 */
    static volatile long availableDelayMs = 0;

    record ReserveRequest(long orderId, List<ReserveLine> lines) {}

    /**
     * 自己也要標條件：static 巢狀類別會被元件掃描「單獨」掃到，外層的 @ConditionalOnProperty 管不到它。
     * 第一版沒有標 —— 每一個測試的 context 都多了 /lab/** 兩支 API，SecurityRouteCoverageTest 與 OpenApiContractTest 紅了（0.9）。
     */
    @RestController
    @ConditionalOnProperty(name = "lab.d00.inventory-service", havingValue = "true")
    static class Endpoint {
        private final InventoryApi inventory;
        private final TransactionTemplate tx;

        Endpoint(InventoryApi inventory, PlatformTransactionManager tm) {
            this.inventory = inventory;
            this.tx = new TransactionTemplate(tm);
        }

        @PostMapping("/lab/inventory/reserve")
        ResponseEntity<?> reserve(@RequestBody ReserveRequest req,
                                  @org.springframework.web.bind.annotation.RequestHeader(value = "traceparent", required = false) String traceparent) throws InterruptedException {
            // 0.2.4：這一行日誌的 traceId（MDC，第 12 站 9.8）跟訂單服務那一張訂單的是不是同一個？
            org.slf4j.LoggerFactory.getLogger(LabInventoryService.class).info("D00_RESERVE orderId={} traceparent={}", req.orderId(), traceparent);
            try {
                tx.executeWithoutResult(s -> inventory.reserve(req.orderId(), req.lines()));   // 自己的交易，在這裡就 commit 了
            } catch (InsufficientStockException e) {
                return ResponseEntity.status(409).body(Map.of("productId", e.productId()));
            }
            long d = delayMs;
            if (d > 0) Thread.sleep(d);
            return ResponseEntity.noContent().build();
        }

        /** 0.2.3：商品頁的可售量。第 12 站它是 inventory 模組的一次本地查詢（5 秒快取）；切開之後，訂單服務只能來問 */
        @org.springframework.web.bind.annotation.GetMapping("/lab/inventory/available")
        Map<Long, Integer> available(@RequestParam List<Long> productIds) throws InterruptedException {
            Map<Long, Integer> r = inventory.available(productIds);
            long d = availableDelayMs;
            if (d > 0) Thread.sleep(d);
            return r;
        }

        /** what=reserve（預設）：預留之後慢；what=available：可售量查詢慢（13 站 1.6.5） */
        @PostMapping("/lab/inventory/delay")
        Map<String, Long> delay(@RequestParam long ms, @RequestParam(defaultValue = "reserve") String what) {
            if (what.equals("available")) availableDelayMs = ms; else delayMs = ms;
            return Map.of("delayMs", delayMs, "availableDelayMs", availableDelayMs);
        }
    }

    /** 第 12 站的 SecurityConfig 對沒列出的路徑一律 denyAll —— 實驗用的端點另開一條鏈，排在它前面 */
    @Bean
    @Order(0)
    SecurityFilterChain labChain(HttpSecurity http) throws Exception {
        return http.securityMatcher("/lab/**")
                .csrf(AbstractHttpConfigurer::disable)
                .authorizeHttpRequests(a -> a.anyRequest().permitAll())
                .build();
    }
}
```

**`src/main/java/com/example/shop/catalog/internal/ProductService.java`**（1.6.2）

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

    ProductService(ProductRepository products, CategoryRepository categories, InventoryApi inventory, Clock clock, AuditLog audit,
                   ProductCache cache, PlatformTransactionManager tm) {
        this.products = products;
        this.categories = categories;
        this.inventory = inventory;
        this.clock = clock;
        this.audit = audit;
        this.cache = cache;
        this.readOnly = new TransactionTemplate(tm);
        this.readOnly.setReadOnly(true);
        this.tx = new TransactionTemplate(tm);
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
        inventory.initialize(p.getId(), req.initialStock(), "product-created");      // 同一個交易（MANDATORY）
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

**`src/main/java/com/example/shop/cart/internal/CartService.java`**（1.6.3）

```java
package com.example.shop.cart.internal;

import com.example.shop.cart.CartApi;
import com.example.shop.cart.internal.CartDtos.*;
import org.springframework.transaction.annotation.Propagation;
import com.example.shop.catalog.CatalogApi;
import com.example.shop.catalog.ProductSnapshot;
import com.example.shop.inventory.InventoryApi;
import com.example.shop.shared.error.ProblemType;
import com.example.shop.shared.error.ShopException;
import com.example.shop.shared.error.ConstraintViolations;
import org.springframework.dao.DataAccessException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionTemplate;

import java.math.BigDecimal;
import java.util.*;

/**
 * 購物車。只有一張表、沒有關聯、寫入需要「不存在就新增、存在就相加」—— 這正是 JPA 表達不好的東西，
 * 所以這個模組直接用 JdbcTemplate（08-jpa-mybatis/09 的選型：用最能表達這個操作的工具）。
 *
 * 13 站 1.6：問 catalog（商品快照）、問 inventory（可售量）都在交易「之外」。交易只包住 cart_items 自己的那幾句。
 * 第 12 站的 add/change/remove/view 整個方法是 @Transactional，別的模組的查詢也在裡面 —— 一個行程裡看不出差別，
 * 切開之後那就是「交易開著、等遠端回應」（13 站 0.2.3）。
 */
@Service
public class CartService implements CartApi {

    static final int MAX_DISTINCT_ITEMS = 50;          // US-CART-1 AC-3

    private final JdbcTemplate jdbc;
    private final CatalogApi catalog;
    private final InventoryApi inventory;
    private final TransactionTemplate tx;

    CartService(JdbcTemplate jdbc, CatalogApi catalog, InventoryApi inventory, PlatformTransactionManager tm) {
        this.jdbc = jdbc;
        this.catalog = catalog;
        this.inventory = inventory;
        this.tx = new TransactionTemplate(tm);
    }

    record Row(long productId, int quantity, BigDecimal priceAtAdd) {}

    List<Row> rows(long buyerId) {
        return jdbc.query("SELECT product_id, quantity, unit_price_at_add FROM cart_items WHERE buyer_id = ? ORDER BY added_at, product_id",
                (rs, i) -> new Row(rs.getLong(1), rs.getInt(2), rs.getBigDecimal(3)), buyerId);
    }

    /** US-CART-1 AC-1：已存在就數量相加。一句 SQL，沒有「先查再寫」的競態（3.6.1） */
    public CartView add(long buyerId, AddItemRequest req) {
        ProductSnapshot p = catalog.snapshots(List.of(req.productId())).get(req.productId());     // 交易之外（13 站 1.6）
        if (p == null || !p.purchasable()) throw new ShopException(ProblemType.PRODUCT_UNAVAILABLE, "商品目前無法購買").with("productId", req.productId());
        tx.executeWithoutResult(s -> {
            Integer distinct = jdbc.queryForObject("SELECT COUNT(*) FROM cart_items WHERE buyer_id = ? AND product_id <> ?",
                    Integer.class, buyerId, req.productId());
            if (distinct >= MAX_DISTINCT_ITEMS)
                throw new ShopException(ProblemType.VALIDATION, "購物車最多 " + MAX_DISTINCT_ITEMS + " 種商品");
            try {
                jdbc.update("""
                        INSERT INTO cart_items (buyer_id, product_id, quantity, unit_price_at_add) VALUES (?, ?, ?, ?) AS new
                        ON DUPLICATE KEY UPDATE quantity = cart_items.quantity + new.quantity, updated_at = CURRENT_TIMESTAMP(3)""",
                        buyerId, req.productId(), req.quantity(), p.price());
            } catch (DataAccessException e) {
                // 相加之後超過 99：由 ck_cart_items_quantity 在資料庫裡原子地判斷（兩個請求同時加，也只會有一個成功）。
                // 注意接的是 DataAccessException：CHECK 違反在 Spring 眼中是 UncategorizedSQLException，不是 DataIntegrityViolationException（3.6.1）
                if (!ConstraintViolations.isViolationOf(e, "ck_cart_items_quantity")) throw e;
                throw new ShopException(ProblemType.VALIDATION, "同一個商品最多 99 件").with("productId", req.productId());
            }
        });
        return view(buyerId);
    }

    public CartView change(long buyerId, long productId, ChangeQuantityRequest req) {
        int n = jdbc.update("UPDATE cart_items SET quantity = ?, updated_at = CURRENT_TIMESTAMP(3) WHERE buyer_id = ? AND product_id = ?",
                req.quantity(), buyerId, productId);                         // 一句 SQL，不需要另外開交易
        if (n == 0) throw ShopException.notFound("購物車品項");
        return view(buyerId);
    }

    public CartView remove(long buyerId, long productId) {
        jdbc.update("DELETE FROM cart_items WHERE buyer_id = ? AND product_id = ?", buyerId, productId);   // 冪等：刪不存在的也回 200
        return view(buyerId);
    }

    @Override
    @Transactional(propagation = Propagation.MANDATORY)
    public void removeItems(long buyerId, Collection<Long> productIds) {
        if (productIds.isEmpty()) return;
        String in = String.join(",", productIds.stream().map(x -> "?").toList());
        List<Object> args = new ArrayList<>();
        args.add(buyerId);
        args.addAll(productIds);
        jdbc.update("DELETE FROM cart_items WHERE buyer_id = ? AND product_id IN (" + in + ")", args.toArray());
    }

    /** US-CART-2：最新的價格、可購買狀態、庫存提示，依賣家分組。三句查詢各自讀（13 站 1.6：不包在一個唯讀交易裡等別的模組） */
    public CartView view(long buyerId) {
        List<Row> rows = rows(buyerId);
        List<Long> ids = rows.stream().map(Row::productId).toList();
        Map<Long, ProductSnapshot> products = catalog.snapshots(ids);      // 一句 SQL（不是每個品項一句）
        Map<Long, Integer> available = inventory.available(ids);          // 一句 SQL
        Map<Long, List<CartLine>> bySeller = new LinkedHashMap<>();
        for (Row r : rows) {
            ProductSnapshot p = products.get(r.productId());
            if (p == null) continue;                                       // 商品不存在（本專題不硬刪，理論上不會發生）
            boolean changed = p.price().compareTo(r.priceAtAdd()) != 0;    // compareTo，不是 equals（第 04 章會看到為什麼）
            List<String> warnings = new ArrayList<>();
            if (available.getOrDefault(p.id(), 0) < r.quantity()) warnings.add("INSUFFICIENT_STOCK");   // AC-5：提醒，不擋
            bySeller.computeIfAbsent(p.sellerId(), k -> new ArrayList<>()).add(new CartLine(p.id(), p.name(), p.price(), r.quantity(),
                    changed, changed ? r.priceAtAdd() : null, !p.purchasable(), warnings));
        }
        List<SellerGroup> groups = bySeller.entrySet().stream().map(e -> new SellerGroup(e.getKey(), e.getValue(),
                e.getValue().stream().filter(l -> !l.unavailable())
                        .map(l -> l.unitPrice().multiply(BigDecimal.valueOf(l.quantity()))).reduce(BigDecimal.ZERO, BigDecimal::add))).toList();
        return new CartView(groups, rows.size());
    }
}
```

**`src/main/java/com/example/shop/ordering/internal/PlaceOrderService.java`**（1.6.4）

```java
package com.example.shop.ordering.internal;

import com.example.shop.cart.CartApi;
import com.example.shop.catalog.CatalogApi;
import com.example.shop.catalog.ProductSnapshot;
import com.example.shop.inventory.InsufficientStockException;
import com.example.shop.inventory.InventoryApi;
import com.example.shop.inventory.ReserveLine;
import com.example.shop.ordering.OrderingApi;
import com.example.shop.shared.config.ShopProperties;
import com.example.shop.shared.error.ConstraintViolations;
import com.example.shop.shared.error.ProblemType;
import com.example.shop.shared.error.ShopException;
import com.example.shop.shared.events.EventTypes;
import com.example.shop.shared.events.Outbox;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.*;

/**
 * 4.4 下單。交易邊界：
 *   ① IdempotencyKeys.claim()   —— 短交易，取得這個鍵
 *   ② placeInTransaction()      —— 下單交易：訂單、明細、預留、庫存帳、狀態歷史、冪等鍵完成、清購物車、Outbox。全有或全無（Q1）
 *   ③ 失敗時 IdempotencyKeys.release() —— 短交易，讓重試可以重新執行
 * ② 裡「只有 SQL」：沒有外部呼叫、沒有 sleep、沒有遠端日誌（0.11.5 的第一條設計約束：持鎖 ≤ 2 ms）
 * 13 站 1.6：商品快照與檢查移到 ① 與 ② 之間（checkedSnapshots）—— ② 裡跨模組的呼叫只剩「寫」：預留、清購物車
 */
@Service
class PlaceOrderService implements OrderingApi {

    private static final org.slf4j.Logger log = org.slf4j.LoggerFactory.getLogger(PlaceOrderService.class);

    static final int MAX_LINES = 50;
    static final int ORDER_NO_ATTEMPTS = 3;

    private final CatalogApi catalog;
    private final InventoryApi inventory;
    private final CartApi cart;
    private final OrderRepository orders;
    private final OrderHistory history;
    private final IdempotencyKeys keys;
    private final Outbox outbox;
    private final TransactionTemplate tx;
    private final Clock clock;
    private final Duration paymentTimeout;

    PlaceOrderService(CatalogApi catalog, InventoryApi inventory, CartApi cart, OrderRepository orders, OrderHistory history,
                      IdempotencyKeys keys, Outbox outbox, PlatformTransactionManager tm, Clock clock, ShopProperties props,
                      io.micrometer.core.instrument.MeterRegistry meters) {
        this.catalog = catalog;
        this.inventory = inventory;
        this.cart = cart;
        this.orders = orders;
        this.history = history;
        this.keys = keys;
        this.outbox = outbox;
        this.tx = new TransactionTemplate(tm);
        this.clock = clock;
        this.paymentTimeout = props.order().paymentTimeout();
        this.placed = meters.counter("shop.orders.placed");
        this.insufficient = meters.counter("shop.inventory.insufficient");
        this.collisions = meters.counter("shop.orders.number_collisions");
    }

    private final io.micrometer.core.instrument.Counter placed, insufficient, collisions;

    /**
     * 6.5.2 熱點商品的品項先過 Redis 的閘門 —— 在冪等鍵與下單交易「之前」：搶不到的人（2,000 人裡的 1,500 人）完全不碰 MySQL。
     * 閘門過了之後，任何一條失敗的路徑都要把減掉的加回去（6.2.4：漏了一條 = 少賣）。
     */
    @Override
    public PlacedOrder placeOrder(long buyerId, String idempotencyKey, List<OrderLine> lines) {
        try {
            return placeOrderGated(buyerId, idempotencyKey, lines);
        } catch (InsufficientStockException e) {
            // 9.9：0.6.6「依 productId 前 N 名」。productId 不當指標的 tag（J7：1 萬個商品 = 1 萬條序列、每次 scrape 600 KB），寫進日誌，前 N 名從日誌查
            insufficient.increment();
            log.info("INSUFFICIENT_STOCK productId={} buyerId={}", e.productId(), buyerId);
            throw e;
        }
    }

    private PlacedOrder placeOrderGated(long buyerId, String idempotencyKey, List<OrderLine> lines) {
        validate(lines);
        Set<Long> hotIds = catalog.hotProducts(lines.stream().map(OrderLine::productId).toList());
        List<ReserveLine> hot = lines.stream().filter(l -> hotIds.contains(l.productId()))
                .map(l -> new ReserveLine(l.productId(), l.quantity())).toList();
        inventory.gateHot(hot);                                             // 不夠 → 409；Redis 不能用 → 503
        try {
            PlacedOrder placed = placeGated(buyerId, idempotencyKey, lines, hot);
            // 9.8：第一版成功的下單一行日誌都沒有 —— 出事的時候，「這張訂單是哪一個請求建的」只能從 traceId 往回找
            if (!placed.replayed()) this.placed.increment();
            if (!placed.replayed()) log.info("ORDER_PLACED orderNo={} buyerId={} lines={} hot={}", placed.orderNo(), buyerId, lines.size(), hot.size());
            return placed;
        } catch (RuntimeException e) {
            // 第 06 章這裡多一個 catch (InsufficientStockException)：「那一個品項不加回去」（6.5.3）。7.6 之後熱點品項在交易裡只寫預留列（holdHot），
            // 這裡的 InsufficientStockException 只可能來自一般品項 —— 熱點品項一律加回。MySQL 說熱點不夠，是落帳（settleHot）的事
            inventory.returnHot(hot);
            throw e;
        }
    }

    private PlacedOrder placeGated(long buyerId, String idempotencyKey, List<OrderLine> lines, List<ReserveLine> hot) {
        IdempotencyKeys.Claim claim = keys.claim(buyerId, idempotencyKey, hash(lines));
        if (claim instanceof IdempotencyKeys.Existing e) {
            inventory.returnHot(hot);                                       // 重送：訂單早就成立了，這一次減掉的要還回去
            Order o = orders.findById(e.orderId()).orElseThrow();
            return new PlacedOrder(o.getId(), o.getOrderNo(), true);
        }
        if (claim instanceof IdempotencyKeys.InProgress)
            throw new ShopException(ProblemType.IDEMPOTENCY_IN_PROGRESS, "相同的下單請求正在處理中").with("retryAfter", 1);
        try {
            // 13 站 1.6：商品快照在下單交易「之前」讀 —— 第 12 站是在交易裡讀的。那是一句不加鎖的讀（一致性讀），
            // 放在交易裡也擋不住「讀完之後賣家改價」，只是讓交易多開一段；切開之後，這一段是一次遠端呼叫。
            // 放在冪等鍵之後：重送（Existing）不需要快照，也不該因為價格變了而失敗
            Map<Long, ProductSnapshot> products = checkedSnapshots(lines);
            for (int attempt = 1; ; attempt++) {
                try {
                    return tx.execute(s -> placeInTransaction(buyerId, idempotencyKey, lines, hot, products));
                } catch (DataIntegrityViolationException e) {
                    // 2.4.4：訂單編號撞號（一天約 12 次）。整個交易已經 rollback，換一個號碼重來
                    if (attempt >= ORDER_NO_ATTEMPTS || !ConstraintViolations.isViolationOf(e, "uk_orders_order_no")) throw e;
                    collisions.increment();                                 // 9.10：4.4.4「日誌照實記錄，另外用指標數撞號次數」—— 那一行 ERROR 不拿來告警
                }
            }
        } catch (RuntimeException e) {
            keys.release(buyerId, idempotencyKey);                          // AC-4：失敗的結果不快取
            throw e;
        }
    }

    /** 商品快照與三個檢查（可購買、同一位賣家、價格沒變）。全部在交易之外 */
    private Map<Long, ProductSnapshot> checkedSnapshots(List<OrderLine> lines) {
        List<Long> ids = lines.stream().map(OrderLine::productId).toList();
        Map<Long, ProductSnapshot> products = catalog.snapshots(ids);

        List<Long> unavailable = ids.stream().filter(id -> products.get(id) == null || !products.get(id).purchasable()).toList();
        if (!unavailable.isEmpty())
            throw new ShopException(ProblemType.PRODUCT_UNAVAILABLE, "有商品目前無法購買").with("productIds", unavailable);

        Set<Long> sellers = new HashSet<>();
        products.values().forEach(p -> sellers.add(p.sellerId()));
        if (sellers.size() != 1)
            throw new ShopException(ProblemType.VALIDATION, "一次只能結帳同一位賣家的商品（0.3.5）");

        // AC-6：使用者同意付的是他看到的價格。比較用 compareTo —— 299 與 299.00 是同一個價格（4.2.4）
        List<Map<String, Object>> changed = new ArrayList<>();
        for (OrderLine l : lines) {
            BigDecimal now = products.get(l.productId()).price();
            if (now.compareTo(l.clientUnitPrice()) != 0)
                changed.add(Map.of("productId", l.productId(), "yourPrice", l.clientUnitPrice(), "currentPrice", now));
        }
        if (!changed.isEmpty())
            throw new ShopException(ProblemType.PRICE_CHANGED, "價格已變動，請確認後重新下單").with("changes", changed);
        return products;
    }

    private PlacedOrder placeInTransaction(long buyerId, String key, List<OrderLine> lines, List<ReserveLine> hot, Map<Long, ProductSnapshot> products) {
        List<Long> ids = lines.stream().map(OrderLine::productId).toList();
        Instant now = clock.instant();
        Order order = Order.place(OrderNumbers.next(now), buyerId, products.get(ids.get(0)).sellerId(), now, now.plus(paymentTimeout));
        for (OrderLine l : lines) {
            ProductSnapshot p = products.get(l.productId());
            order.addItem(p.id(), p.name(), p.price(), l.quantity());      // 快照：下單當下的名稱與價格（1.5.5）
        }
        orders.saveAndFlush(order);                                         // IDENTITY：這裡就 INSERT 了，撞號也在這裡炸

        // 7.6 熱點品項（已經過了 Redis 的閘門）只寫預留列，數量由消費者之後計入；其他品項照第 04 章，在這個交易裡計入
        Set<Long> hotIds = new HashSet<>();
        hot.forEach(h -> hotIds.add(h.productId()));
        List<ReserveLine> normal = lines.stream().filter(l -> !hotIds.contains(l.productId())).map(l -> new ReserveLine(l.productId(), l.quantity())).toList();
        if (!normal.isEmpty()) inventory.reserve(order.getId(), normal);
        if (!hot.isEmpty()) inventory.holdHot(order.getId(), hot);
        history.record(order.getId(), null, order.getStatus(), "PLACE_ORDER", OrderHistory.Actor.buyer(buyerId), now);
        keys.complete(buyerId, key, order.getId());
        cart.removeItems(buyerId, ids);                                     // AC-4
        // 0.5.4 右欄：通知「訂單成立」、熱點商品的落帳（7.6）。跟訂單一起 commit —— 訂單不存在，這一列也不存在
        outbox.add("ORDER", order.getId(), EventTypes.ORDER_PLACED, Map.of("orderId", order.getId(), "orderNo", order.getOrderNo(),
                "buyerId", buyerId, "sellerId", order.getSellerId(), "totalAmount", order.getTotalAmount(),
                "hotProductIds", hotIds.stream().sorted().toList()));
        return new PlacedOrder(order.getId(), order.getOrderNo(), false);
    }

    static void validate(List<OrderLine> lines) {
        if (lines == null || lines.isEmpty() || lines.size() > MAX_LINES)
            throw new ShopException(ProblemType.VALIDATION, "品項數量必須是 1～" + MAX_LINES);
        if (lines.stream().map(OrderLine::productId).distinct().count() != lines.size())
            throw new ShopException(ProblemType.VALIDATION, "同一個商品只能出現一次");
    }

    /** AC-2：同一個鍵、不同的內容 → 422。內容的「指紋」與品項順序無關、與價格的 scale 無關 */
    static String hash(List<OrderLine> lines) {
        StringBuilder sb = new StringBuilder();
        lines.stream().sorted(Comparator.comparingLong(OrderLine::productId)).forEach(l ->
                sb.append(l.productId()).append(':').append(l.quantity()).append(':')
                  .append(l.clientUnitPrice().stripTrailingZeros().toPlainString()).append(';'));
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(sb.toString().getBytes(StandardCharsets.UTF_8)));
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }
}
```

**`src/test/java/com/example/shop/ordering/internal/CancelRefundSnapshotTest.java`**（第 12 站 4.6.2 的追記；1.6.7）

```java
package com.example.shop.ordering.internal;

import com.example.shop.payment.internal.CallbackSignature;
import com.example.shop.shared.config.ShopProperties;
import com.example.shop.shared.security.AccessTokens;
import com.example.shop.shared.web.Role;
import com.example.shop.support.TestInfra;
import com.example.shop.support.TestRedis;
import com.example.shop.support.TestTokens;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.concurrent.CompletableFuture;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 專題寫完之後（13 站第 01 章 1.6.7 的推論）：買家取消與金流回呼「幾乎同時」到。
 *
 * 取消的交易：① 第一句讀（OrderAccess.buyers，一般的 SELECT）→ InnoDB 在這裡建立這個交易的一致性讀快照
 *            ② 條件式 UPDATE orders … WHERE status = 'PENDING_PAYMENT' → 0 列（回呼已經把它改成 PAID 了）
 *            ③ FOR UPDATE 重讀 → PAID → 狀態機：可以取消、要退款 → UPDATE … WHERE status = 'PAID' → 1 列
 *            ④ succeededPaymentOf()：一般的 SELECT —— 用的是 ① 的快照，看不到回呼 commit 的那一筆 SUCCEEDED
 * 回呼的交易如果整個落在 ① 與 ② 之間，④ 就說「沒有付款」→ 不建退款單。
 *
 * 用一個外層交易把 ① 提前做掉、等回呼 commit，再在同一個交易裡呼叫 cancelByBuyer()（REQUIRED，加入外層交易，用同一個快照）——
 * 跟真的取消在 ① 與 ② 之間被搶走 CPU 是同一個順序。
 */
@SpringBootTest(properties = {"shop.order.jobs-enabled=false", "shop.inventory.jobs-enabled=false"})
@AutoConfigureMockMvc
class CancelRefundSnapshotTest {

    static final long BUYER = 990_971, SELLER = 990_972, PRODUCT = 9_900_971;

    @Autowired MockMvc mvc;
    @Autowired AccessTokens tokens;
    @Autowired ShopProperties props;
    @Autowired JdbcTemplate jdbc;
    @Autowired StringRedisTemplate redis;
    @Autowired ObjectMapper json;
    @Autowired OrderCommands commands;
    @Autowired PlatformTransactionManager tm;

    @BeforeEach
    void setUp() {
        cleanup();
        jdbc.update("INSERT INTO products (id, seller_id, category_id, name, price, status) VALUES (?, ?, 11, '取消與回呼', 100.00, 'ON_SALE')", PRODUCT, SELLER);
        jdbc.update("INSERT INTO inventory (product_id, on_hand, reserved) VALUES (?, 10, 0)", PRODUCT);
        jdbc.update("INSERT INTO inventory_ledger (product_id, delta_on_hand, delta_reserved, reason, ref) VALUES (?, 10, 0, 'INITIAL', 'cancel-snapshot')", PRODUCT);
    }

    @AfterEach
    void cleanup() {
        JdbcTemplate admin = TestInfra.adminJdbc();
        admin.update("DELETE a FROM audit_logs a JOIN payments p ON a.target_type = 'PAYMENT' AND a.target_id = p.id JOIN orders o ON o.id = p.order_id WHERE o.buyer_id = ?", BUYER);
        admin.update("DELETE a FROM audit_logs a JOIN orders o ON a.target_type = 'ORDER' AND a.target_id = o.order_no WHERE o.buyer_id = ?", BUYER);
        for (String t : List.of("refunds", "payments", "order_status_history", "order_items"))
            jdbc.update("DELETE x FROM " + t + " x JOIN orders o ON o.id = x.order_id WHERE o.buyer_id = ?", BUYER);
        jdbc.update("DELETE FROM idempotency_keys WHERE buyer_id = ?", BUYER);
        jdbc.update("DELETE FROM orders WHERE buyer_id = ?", BUYER);
        jdbc.update("DELETE FROM inventory_reservations WHERE product_id = ?", PRODUCT);
        admin.update("DELETE FROM inventory_ledger WHERE product_id = ?", PRODUCT);
        jdbc.update("DELETE FROM inventory WHERE product_id = ?", PRODUCT);
        jdbc.update("DELETE FROM products WHERE id = ?", PRODUCT);
        TestRedis.forgetProducts(redis, PRODUCT);
    }

    @Test @DisplayName("取消的交易已經讀過、回呼在它 UPDATE 之前 commit → 取消成立時，已付款的那一筆要有退款單")
    void callbackCommitsBetweenCancelsFirstReadAndItsUpdate() throws Exception {
        String orderNo = body(call("POST", "/api/orders", BUYER, Role.BUYER,
                "{\"items\": [{\"productId\": %d, \"quantity\": 1, \"unitPrice\": 100}]}".formatted(PRODUCT))).get("orderNo").asText();
        JsonNode p = body(call("POST", "/api/orders/" + orderNo + "/payments", BUYER, Role.BUYER, null));
        long paymentId = p.get("paymentId").asLong();
        BigDecimal amount = new BigDecimal(p.get("amount").asText());

        new TransactionTemplate(tm).executeWithoutResult(s -> {
            // ① 取消的第一句讀（跟 OrderAccess.buyers 一樣是一般的 SELECT）：快照在這裡建立
            String before = jdbc.queryForObject("SELECT status FROM orders WHERE order_no = ?", String.class, orderNo);
            // 回呼在另一條執行緒、另一個交易裡整個做完、commit
            int cb = CompletableFuture.supplyAsync(() -> {
                try {
                    String sig = CallbackSignature.sign(props.payment().callbackSecret(), CallbackSignature.canonical(paymentId, "snap-tx-1", amount, true));
                    return call("POST", "/api/payments/callback", null, null, """
                            {"paymentId": %d, "providerTxnId": "snap-tx-1", "amount": %s, "result": "SUCCEEDED", "signature": "%s"}""".formatted(paymentId, amount, sig)).getStatus();
                } catch (Exception e) {
                    throw new IllegalStateException(e);
                }
            }).join();
            // ②～④ 同一個交易裡取消
            commands.cancelByBuyer(BUYER, orderNo);
            System.out.printf("取消的第一句讀到 %s；回呼 %d；取消 →%n", before, cb);
        });

        String status = jdbc.queryForObject("SELECT status FROM orders WHERE order_no = ?", String.class, orderNo);
        String payment = jdbc.queryForObject("SELECT status FROM payments WHERE id = ?", String.class, paymentId);
        List<String> refunds = jdbc.queryForList("SELECT reason FROM refunds WHERE payment_id = ?", String.class, paymentId);
        System.out.printf("  訂單 %s、付款 %s、退款單 %s%n", status, payment, refunds);
        assertThat(status).isEqualTo("CANCELLED");
        assertThat(payment).isEqualTo("SUCCEEDED");
        assertThat(refunds).as("已付款、已取消：錢要退").hasSize(1);
    }

    MockHttpServletResponse call(String method, String path, Long actor, Role role, String body) throws Exception {
        var b = MockMvcRequestBuilders.request(method, java.net.URI.create(path)).contentType(MediaType.APPLICATION_JSON).characterEncoding(StandardCharsets.UTF_8);
        if (actor != null) b.header("Authorization", TestTokens.bearer(tokens, actor, role));
        if (path.equals("/api/orders")) b.header("Idempotency-Key", "cancel-snapshot-" + System.nanoTime());
        if (body != null) b.content(body);
        return mvc.perform(b).andReturn().getResponse();
    }

    JsonNode body(MockHttpServletResponse r) throws Exception { return json.readTree(r.getContentAsString(StandardCharsets.UTF_8)); }
}
```

**`src/test/java/com/example/shop/ordering/internal/CancelVsSecondPaymentTest.java`**（第 12 站 4.6.2 的追記：加鎖讀不會讓「第二筆付款 vs 取消」死鎖）

```java
package com.example.shop.ordering.internal;

import com.example.shop.payment.PaymentApi;
import com.example.shop.payment.internal.CallbackSignature;
import com.example.shop.shared.config.ShopProperties;
import com.example.shop.shared.security.AccessTokens;
import com.example.shop.shared.web.Role;
import com.example.shop.support.TestInfra;
import com.example.shop.support.TestRedis;
import com.example.shop.support.TestTokens;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 專題寫完之後（13 站第 01 章，4.6.2 的追記）：同一張訂單付了兩次錢，第二筆的回呼與買家取消同時進行。
 *
 *   第二筆的回呼：① 鎖住第二筆付款（FOR UPDATE）、改成 SUCCEEDED ……（這裡停 500 ms）…… ③ 套用到訂單
 *   買家取消    ：② 訂單是 PAID → 條件式 UPDATE（拿到訂單那一列的鎖）→ 要退款 → succeededPaymentOf() 用 FOR SHARE 掃這張訂單的付款
 *
 * 寫這個測試時以為會死鎖：② 的 FOR SHARE 等 ① 鎖住的第二筆，③ 又要等 ② 鎖住的訂單。實測沒有 ——
 * 訂單是 PAID 時，③ 是 PAID + PAY_SUCCEEDED（另一筆）= REFUND_ONLY，只建退款單、不改訂單那一列，不等 ②。
 * 這個測試留著守住這件事：兩個都成功，第一筆退款（BUYER_CANCEL），第二筆退款（DUPLICATE_PAYMENT —— ③ 讀到的訂單還是 PAID）。
 */
@SpringBootTest(properties = {"shop.order.jobs-enabled=false", "shop.inventory.jobs-enabled=false"})
@AutoConfigureMockMvc
class CancelVsSecondPaymentTest {

    static final long BUYER = 990_981, SELLER = 990_982, PRODUCT = 9_900_981;

    @Autowired MockMvc mvc;
    @Autowired AccessTokens tokens;
    @Autowired ShopProperties props;
    @Autowired JdbcTemplate jdbc;
    @Autowired StringRedisTemplate redis;
    @Autowired ObjectMapper json;
    @Autowired OrderCommands commands;
    @Autowired OrderTransitionService transitions;
    @Autowired PaymentApi payments;
    @Autowired PlatformTransactionManager tm;

    @BeforeEach
    void setUp() {
        cleanup();
        jdbc.update("INSERT INTO products (id, seller_id, category_id, name, price, status) VALUES (?, ?, 11, '付兩次', 100.00, 'ON_SALE')", PRODUCT, SELLER);
        jdbc.update("INSERT INTO inventory (product_id, on_hand, reserved) VALUES (?, 10, 0)", PRODUCT);
        jdbc.update("INSERT INTO inventory_ledger (product_id, delta_on_hand, delta_reserved, reason, ref) VALUES (?, 10, 0, 'INITIAL', 'second-payment')", PRODUCT);
    }

    @AfterEach
    void cleanup() {
        JdbcTemplate admin = TestInfra.adminJdbc();
        admin.update("DELETE a FROM audit_logs a JOIN payments p ON a.target_type = 'PAYMENT' AND a.target_id = p.id JOIN orders o ON o.id = p.order_id WHERE o.buyer_id = ?", BUYER);
        admin.update("DELETE a FROM audit_logs a JOIN orders o ON a.target_type = 'ORDER' AND a.target_id = o.order_no WHERE o.buyer_id = ?", BUYER);
        for (String t : List.of("refunds", "payments", "order_status_history", "order_items"))
            jdbc.update("DELETE x FROM " + t + " x JOIN orders o ON o.id = x.order_id WHERE o.buyer_id = ?", BUYER);
        jdbc.update("DELETE FROM idempotency_keys WHERE buyer_id = ?", BUYER);
        jdbc.update("DELETE FROM orders WHERE buyer_id = ?", BUYER);
        jdbc.update("DELETE FROM inventory_reservations WHERE product_id = ?", PRODUCT);
        admin.update("DELETE FROM inventory_ledger WHERE product_id = ?", PRODUCT);
        jdbc.update("DELETE FROM inventory WHERE product_id = ?", PRODUCT);
        jdbc.update("DELETE FROM products WHERE id = ?", PRODUCT);
        TestRedis.forgetProducts(redis, PRODUCT);
    }

    @Test @DisplayName("第二筆付款的回呼與取消同時進行：不死鎖，兩個都成功，兩筆錢都退")
    void secondPaymentCallbackRacesCancel() throws Exception {
        String orderNo = body(call("POST", "/api/orders", BUYER, Role.BUYER,
                "{\"items\": [{\"productId\": %d, \"quantity\": 1, \"unitPrice\": 100}]}".formatted(PRODUCT))).get("orderNo").asText();
        long p1 = body(call("POST", "/api/orders/" + orderNo + "/payments", BUYER, Role.BUYER, null)).get("paymentId").asLong();
        long p2 = body(call("POST", "/api/orders/" + orderNo + "/payments", BUYER, Role.BUYER, null)).get("paymentId").asLong();
        assertThat(call("POST", "/api/payments/callback", null, null, callbackJson(p1, "two-tx-1")).getStatus()).isEqualTo(200);   // 第一筆：訂單 PAID

        CountDownLatch locked = new CountDownLatch(1);
        CompletableFuture<String> callback = CompletableFuture.supplyAsync(() -> {
            try {
                new TransactionTemplate(tm).executeWithoutResult(s -> {      // PaymentCallbackService.handle() 的同一個順序，中間停一下
                    PaymentApi.Recorded r = payments.record(callback(p2, "two-tx-2"));            // ① 鎖住第二筆付款
                    locked.countDown();
                    sleep(500);
                    transitions.apply(r.orderId(), OrderEvent.PAY_SUCCEEDED, OrderHistory.Actor.paymentProvider(),   // ③ 改訂單
                            OrderTransitionService.EventData.payment(r.paymentId()));
                });
                return "ok";
            } catch (RuntimeException e) {
                return e.getClass().getSimpleName() + ": " + e.getMessage();
            }
        });
        assertThat(locked.await(10, TimeUnit.SECONDS)).isTrue();
        String cancel;
        try {
            commands.cancelByBuyer(BUYER, orderNo);                           // ② 取消（自己的交易）
            cancel = "ok";
        } catch (RuntimeException e) {
            cancel = e.getClass().getSimpleName() + ": " + e.getMessage();
        }
        String cb = callback.get(30, TimeUnit.SECONDS);

        String status = jdbc.queryForObject("SELECT status FROM orders WHERE order_no = ?", String.class, orderNo);
        List<Map<String, Object>> refunds = jdbc.queryForList(
                "SELECT f.payment_id, f.reason FROM refunds f JOIN orders o ON o.id = f.order_id WHERE o.order_no = ? ORDER BY f.payment_id", orderNo);
        System.out.printf("第二筆的回呼：%s%n取消：%s%n訂單 %s、退款單 %s%n", cb, cancel, status, refunds);
        assertThat(cancel).isEqualTo("ok");
        assertThat(cb).isEqualTo("ok");
        assertThat(status).isEqualTo("CANCELLED");
        assertThat(refunds).extracting(r -> ((Number) r.get("payment_id")).longValue() + " " + r.get("reason"))
                .containsExactly(p1 + " BUYER_CANCEL", p2 + " DUPLICATE_PAYMENT");
    }

    PaymentApi.Callback callback(long paymentId, String txn) {
        BigDecimal amount = new BigDecimal("100.00");
        return new PaymentApi.Callback(paymentId, txn, amount, true,
                CallbackSignature.sign(props.payment().callbackSecret(), CallbackSignature.canonical(paymentId, txn, amount, true)));
    }

    String callbackJson(long paymentId, String txn) {
        PaymentApi.Callback c = callback(paymentId, txn);
        return """
                {"paymentId": %d, "providerTxnId": "%s", "amount": %s, "result": "SUCCEEDED", "signature": "%s"}""".formatted(paymentId, txn, c.amount(), c.signature());
    }

    static void sleep(long ms) {
        try { Thread.sleep(ms); } catch (InterruptedException e) { throw new IllegalStateException(e); }
    }

    MockHttpServletResponse call(String method, String path, Long actor, Role role, String body) throws Exception {
        var b = MockMvcRequestBuilders.request(method, java.net.URI.create(path)).contentType(MediaType.APPLICATION_JSON).characterEncoding(StandardCharsets.UTF_8);
        if (actor != null) b.header("Authorization", TestTokens.bearer(tokens, actor, role));
        if (path.equals("/api/orders")) b.header("Idempotency-Key", "second-payment-" + System.nanoTime());
        if (body != null) b.content(body);
        return mvc.perform(b).andReturn().getResponse();
    }

    JsonNode body(MockHttpServletResponse r) throws Exception { return json.readTree(r.getContentAsString(StandardCharsets.UTF_8)); }
}
```

---

## 1.10 常見誤區

**「模組邊界已經畫好了，照著模組切，就是對的服務邊界。」**
第 12 站的模組是依名詞畫的（1.3.2），在一個行程裡沒有問題 —— 模組之間可以共享交易。行程的邊界不行：庫存這個模組的邊界很清楚（`InventoryApi`、`ModuleBoundaryTest`），切成行程卻是第 96 名。**模組邊界與行程邊界不一定畫在同一個地方**；前者可以依名詞，後者要依能力與交易。

**「先切最核心、最複雜的那一塊，最有價值。」**
最核心的那一塊，通常跟所有人都有線。1.5 的前幾名都是邊緣的能力：通知、身分、報表。第一刀要切在線最少的地方 —— 如果真的要切的話。

**「兩個模組之間沒有同步呼叫，就沒有耦合。」**
reporting 不呼叫任何人，卻直接讀 5 張別人的表（1.4.5）；notification 不被任何人呼叫，卻收 5 種事件。三把尺各量一種線，**少看一把，就會把一條線當成不存在**（1.4.2 的 📌：第二把尺看不到 Redis）。

**「工具說耦合是 0，就是 0。」**
第一版的工作負載少走了 3 支 API，account 的五個數字全是 0（1.4.4）。量出來的「沒有」，只代表「走過的路上沒有」。先確認覆蓋率，再相信 0。

**「把讀移出交易，資料就會不一致。」**
不加鎖的讀（一致性讀）在交易裡也擋不住「讀完之後別人改了」（1.6.4）。移出交易失去的，是「幾句讀看到同一個時間點」（1.6.3 的購物車）—— 切開之後它本來就不存在。真正需要加鎖讀的地方（`SELECT … FOR UPDATE`），一個都沒有移。

**「架構測試守得住所有的邊界。」**
ArchUnit 看得到「A 類別引用 B 類別」，看不到「這個呼叫發生在誰開的交易裡」（1.6.6）。執行時的規則，要用執行時的測試守。

**「這一站切庫存，所以庫存是該切的那一刀。」**
不是。庫存是**最難**的那一刀，所以拿來練習（1.5.4）。決策文件上寫的是 notification。

---

## 1.11 本章小結

第 00 章切了庫存、量了下單；這一章先問「該切在哪裡」：

1. **做了三把尺**（1.4）：跨模組的同步呼叫（Spring AOP 的 Advisor，搭 `@Transactional` 已經有的自動代理）、交易邊界（MySQL 驅動的 query interceptor）、變更耦合（git 歷史）。全部在 `src/test`，正式程式碼不用改。
2. **跑了一個使用者的一天**（1.4.4），35 支模組 API 全部走到 —— 第一版少走 3 支，就少看到一條線。
3. **算了 127 種切法**（1.5）：notification 第 1、account 第 2、inventory 第 96。每一種切出 inventory 的切法都至少切斷 6 種交易，因為預留同時被庫存與訂單兩條規則綁著（1.5.3，聚合）。
4. **先拆模組**（1.6）：還沒拆的時候，把 5 種跨模組的讀移出本地交易。在一個行程裡，行為一模一樣、230 個測試全綠；在切開的部署裡，「可售量慢 3 秒」從拖垮整個訂單服務，變成只有購物車慢（B2）。
5. **守住它**（1.6.6）：一個測試確保「在交易裡呼叫別的模組」只有清單上的 12 種，而且只會變少。

**這一章沒有讓第 00 章的四個代價變小**（1.8.2）—— 那 7 種切斷的交易要等第 04 章。它做的是兩件事：知道切在哪裡會痛多少，以及趁還沒切的時候，把最便宜的那一部分先修好。

### 1.11.1 驗收清單

- [ ] 從 `d00` 開出 `d01`，`mvn test -Pexperiments -Dtest=B1BoundaryMapTest -Dd01.range=<你的第 12 站分支>` 印出 1.4.5 與 1.5.2 的兩段，「走過的 API」是 35 支。
- [ ] **不看課文**，說出第 00 章那一刀切斷的 7 種交易，以及為什麼「建立商品」也在裡面。
- [ ] 說出第 12 站九個模組裡，哪三個跟其他模組之間沒有同步呼叫，各自用什麼方式跟別人連在一起。
- [ ] 解釋 `ApiTap` 為什麼要標 `@Role(ROLE_INFRASTRUCTURE)`、為什麼排在 `HIGHEST_PRECEDENCE`。
- [ ] 解釋 `SqlTap` 怎麼知道「一個交易」從哪裡開始、到哪裡結束。
- [ ] 說出 1.5 的五個數字的排序理由。
- [ ] 用「聚合」說明：預留放在哪一邊，都有一條規則要跨過那一刀。
- [ ] 跑 B2 兩次（換回改之前的 `src/main` 一次），說出兩次「我的訂單」的差別，以及為什麼一個唯讀的購物車頁面能拖垮它。
- [ ] 把 `CartService.view()` 改回 `@Transactional(readOnly = true)`，看 `CrossModuleCallInTxTest` 紅，再改回來。
- [ ] `mvn clean verify` 全綠，230 個測試（1.9）。

---

## 1.12 下一章預告

這一章知道了庫存這一刀切斷什麼；第 02 章要真的切開它的**資料**：

- **庫存的表搬到自己的資料庫。** `inventory`、`inventory_reservations`、`inventory_ledger` 搬家；`shop_app` 的權限、Flyway 的歷史、`TableOwnershipTest` 的那張表，各自要怎麼分。
- **外鍵消失之後，參照完整性誰守？** `inventory_reservations.order_id` 本來就沒有外鍵（第 12 站刻意不建跨模組外鍵）；`inventory.product_id` 呢？
- **跨資料庫的 JOIN 消失了。** 第 00 章 0.2.2 那句數孤兒的 SQL 跨了兩個資料庫；不用 JOIN 的版本，變成正式的對帳。
- **建立商品那一個交易**（1.2）：商品在 catalog 的資料庫、庫存列在庫存的資料庫 —— 先建誰、建到一半怎麼辦。
- **雙寫過渡期**：搬家的那幾天，兩邊都有資料，誰是對的。

B1 會在第 02 章結束時重跑一次：資料庫拆開之後，「直接讀表」那一欄會不會冒出新的線。

