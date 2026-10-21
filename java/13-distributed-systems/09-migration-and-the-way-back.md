# 第 09 章：遷移與回頭路

> **上一章**：[第 08 章](08-infrastructure-spring-cloud-vs-k8s.md)把兩個服務搬到本機的 K8s（kind），前面放一個 Gateway API 的入口，逐項量了服務發現、負載平衡、設定、閘道，寫成一份選型文件。它的最後一句：入口的 `HTTPRoute`，一條規則可以有好幾個 backend、各帶一個權重。
>
> **這一章**：這一站的最後一章。到第 08 章為止，兩個服務都是從空的庫開始的；真的拆分不是 —— 單體已經在跑、有資料，買家一直在下單。這一章的起點換成那個樣子：單體也上 kind，入口把 `/api/**` 全部送給它，兩個服務在旁邊等著接手。
>
> 先照第 02 章 2.8.5 的計畫切過去、多做一件事 —— 先切 10% 試試看（9.2）。然後照 Strangler Fig 重排成六步（9.3），一步一步做、一步一步量：
>
> - 新的服務先接單體的庫（9.4）
> - 灰度：入口的權重、兩邊各算各的、雙跑比對、同一個人來回兩邊、回滾（9.5）
> - 資料最後搬：搬家程式、邊寫邊對帳、停寫切換、反方向的搬家程式（9.6），回滾演練（9.7），收尾（9.8）
>
> 最後回到第 00 章的問題：什麼時候該合併回單體（9.9）。然後真的合回去，量合前合後（9.10），寫下拆分決策文件的最後一段（9.11）。
>
> **你手上會有**：從 `d08` 開出來的分支 `d09`。正式程式碼改了兩處：
>
> - `BootstrapAdmin`：兩個行程同時對同一個庫第一次啟動，輸的那一邊不再起不來（9.4.3；第 12 站也有這個 bug，[5.10 的追記](../12-capstone/05-authentication-and-permission.md)）。
> - 訂單服務的庫存副本：起來的時候不完整就自己重建，重建好之前 readiness 是 DOWN（9.4.4）。
>
> 其他：
>
> - `k8s/`：單體（`base/monolith.yaml`、`migrate-monolith` 的 Job）、入口的權重與 `Shop-Route`（`gateway/routes.yaml`）、kind 的設定（兩個服務接單體的庫）；`scripts/d09-kind.sh`。
> - 告警多一條 `ShopJobHigh5xxRatio`（9.5.2）。
> - 實驗 M1～M5，搬家與對帳的工具（`Verifier`、`Cutover`）；`scripts/d09-deploy-coupling.sh`。
>
> 測試 375 個，failsafe 契約驗證 39 個。（📌 第 09 章寫完之後的追記接在同一個分支後面：正式程式碼多四組改動（`products.hot` 的收縮、寫入的開關、兩個告警用的指標、預留的交易死結就重做），測試 380 個、failsafe 契約驗證 39 個 —— 9.13.2。）
>
> **這一章的實測事故**：
>
> - **照第 02 章的計畫切過去、先切 10%：超賣 44 件**（9.2）：400 件賣出 444 件；兩個庫都說「已預留 400」，第 02 章的核對說兩個庫一模一樣。回滾（權重改回去）之後，44 張等付款的訂單在單體的庫裡找不到預留 —— 在新的庫裡也找不到：44 張的預留，都被搬家程式用同一個 id 的另一張訂單的預留蓋掉了。
> - **共用一個庫，訂單服務的 migration Job 驗證失敗**（9.4.2）：單體的庫跑過的版本裡，有 8 個在它不認得的資料夾。
> - **沒有黏性，同一個人看到可售量倒退**（9.5.4）：720 次讀、140 次倒退（19.4%），10 個人都看過，最多一次 12 件。
> - **停寫切換 24.3 秒**（9.6.5）：追完、搬共用表的幾列、核對加起來不到 0.1 秒，其他都是 pod 的關與起；122 張下單 503，新的 pod ready 之後還有幾秒的 503。
> - **之後**：
>   - 程式先搬、資料留在單體的庫：權重 5 → 25 → 50 → 100，兩邊都是 0 個 5xx；回滾（權重改回去）0.3 秒內生效、0 個錯誤；同樣 400 件、兩條路各一半，賣出 400 件（9.5）。
>   - cookie 的黏性：倒退 0 次；黏著的時候回滾，黏在新的那一邊的人馬上回到單體（9.5.4）。
>   - 邊寫邊對帳：故意弄壞一列，報出來的就是那一列（9.6.3）。
>   - 回滾演練（反方向的搬家程式 ＋ 停寫切回）：24.8 秒，0 張訂單找不到預留（9.7）。
>   - 合回去（資料先、程式後）：停寫 28.7 秒、0 張訂單找不到預留；同一個庫上交錯量，下單 p50 35 → 30 ms、p99 358 → 188 ms；每一張下單少一次服務之間的呼叫；記憶體 1,512 → 585 MiB（9.10）。
>   - 這一站 37 個改了正式程式碼的 commit，只動庫存服務的 1 個（9.9.2）。
>
> **⚠️ 寫這一章途中被自己的實驗抓到的**：
>
> - **兩個行程同時第一次啟動，輸的那一個起不來**（9.4.3）：單體與訂單服務接同一個空的庫，`BootstrapAdmin` 兩邊都去建第一個管理員，輸的那一邊撞到唯一索引。第 12 站的單體開兩台也會；兩邊都修了（[第 12 站 5.10 的追記](../12-capstone/05-authentication-and-permission.md)）。
> - **新的路的副本是空的**（9.4.4）：權重 0 的時候雙跑比對，24 個讀的請求有 12 個不一樣，訂單服務說 0 件。第 05 章說「readiness 可以擋」，第 08 章沒有做。
> - **我的實驗台先起服務、後種資料**（9.4.5）：修好之後還是 14 個 0 件 —— 檢查在訂單服務起來的那一刻做，那時候商品表是空的。
> - **對帳的第一版報了假的「不一樣」**（9.6.3）：帳的尾巴那一段一直有新的列；1,000 個商品在同一段、一直有人在下單。
> - **停寫那一段的狀態碼算得太早**（9.6.5）：切換完馬上算，「起來之後 10 秒」只數到 1 張 —— 那 10 秒的請求還沒送出去。
> - **合前合後的延遲，第一版拿不同的時間點比**（9.10.3）：改成兩條路寫同一個庫的那一刻，交錯量。
> - **M3 的讀太密**（9.5.4）：10 個人每 200 ms 讀一次、加上下單，讀的有 110～129 次失敗；改成 400 ms 之後 0 次。推論是「每個 IP 每秒 50 次」，第一版沒有記失敗的狀態碼。
> - **M1 的「賣出」第一版算進了還在 `RESERVING` 的訂單**（9.2）：回了 503、還沒成立的那兩張也算成「賣出」，回滾那一段的數字對不上。改成只算成立的。
>
> **小坑**：
>
> - **`kubectl apply -l 'migrate in (…)'` 把 kustomize 產生的 Secret 也濾掉了**（9.4.2）：Job 起不來（`CreateContainerConfigError`）；`notin` 才會留下沒有這個標籤的。
> - **Envoy 的映像檔裡沒有 curl、wget**（9.5.1）：讀它的 admin 要 port-forward。
> - **Envoy 的 session cookie 不是單純的 base64 位址**（9.5.4）：解開前面還有兩個位元組。
> - **日誌裡的 ERROR 不一定是錯**（9.5.6）：訂單編號撞號時，Hibernate 先記一行 ERROR，應用程式重試、成功。
>
> **這一章沒有達成、或只達成一部分的目標**：
>
> - **停寫沒有縮短**（9.6.5）：24～29 秒幾乎都是 pod 的關與起。要更短，要讓新的 pod 先起來、但還不寫 —— 應用程式要多一個開關，這一章沒有做。（📌 追記：縮短了 —— 兩組 pod 都活著、只換誰在寫：停寫 1.5 秒、15 張 503，9.6.7。）
> - **資料只有幾千筆、只有一個 node**：搬家、對帳的時間不代表真的資料量（第 02 章 2.8.2 的推算）。（📌 追記：三個 node 的實驗在第 08 章 8.6.6；資料量沒有變。）
> - **`ShopJobHigh5xxRatio` 只用 promtool 驗證**（9.5.2）：沒有在 kind 上讓新的那一邊真的壞一陣子。（📌 追記：在 kind 上真的響了一次，9.5.2。）
> - **灰度只做了照比例與 cookie 的黏性**：依使用者分群（例如照 token 裡的使用者）沒有做。（📌 追記：依使用者分群做了，9.5.7。）
> - **搬家用的還是 trigger**：binlog 的變更擷取（第 02 章 2.8.5 的表）沒有做。（📌 追記：binlog 的做了，9.6.8 —— 停寫跟 trigger 的差不多；接上 binlog、新的那一組起來的那一段多了一百多張 503，原因沒有查出來。）
> - **副本的檢查只在起來的那一刻**（9.4.5）。
> - **合回去只合了部署與資料**（9.10.4）：Saga、副本、`Inbox` 這些在單體裡用不太到的程式碼，都沒有拿掉。（📌 追記：量了：第 03～06 章加進正式程式碼的 2,552 行大多單體用不到；仍然沒有拿掉 —— 第 04 章的那些在資料（`REJECTED`、`RESERVING`）與事件的契約裡，9.10.4。）
> - **探索時的 1 張 500 沒有找到原因**（9.6.5）：最後一輪加了記錄之後沒有再出現。（📌 追記：找到了：搬家程式在正本上裝 trigger（DDL）的那一刻，碰上一個做到一半的預留 —— metadata lock 的死結（外鍵讓它成環），被犧牲的是預留；預留的交易改成死結就整個重做，9.6.5。）
> - **前幾章留下的，大多還是沒有做**：每個服務一個資料庫帳號（第 02 章 2.4.4）、Alertmanager 的抑制與依燃燒速率的告警（第 07 章）、尾端抽樣、多 node 與 GitOps（第 08 章）。（📌 追記：都補了 —— 帳號（第 02 章 2.4.4）、Alertmanager 的分組與抑制、燃燒速率的比較（第 07 章 7.11.1、7.11.2）、尾端抽樣（第 07 章 7.8.4）、三個 node 與 GitOps（第 08 章 8.6.6、8.4.6）。）

---

## 9.1 學習目標

讀完這一章，你應該能：

- 說出 Strangler Fig 是什麼、「過渡架構」是什麼，並為一個真的系統排出遷移的步驟：每一步改了什麼、資料的正本在哪裡、回頭路是什麼、要多久。
- 說出為什麼「程式先搬、資料最後搬」，以及灰度與資料搬家為什麼不能同時做（兩個正本）。
- 讓兩個新的服務接到單體的庫，並處理共用一個庫時才會出現的事：migration 只能有一個主人、兩個行程同時第一次啟動、新的路的讀模型要先建好。
- 用入口的權重做灰度：知道它每一個請求挑一次、兩邊的指標要各算各的、全站的告警會被稀釋；用一個 header 做雙跑比對；知道同一個人來回兩邊會看到什麼、黏性怎麼做。
- 在下單不停的時候搬資料：搬家程式、邊寫邊對帳（怎麼分出「還沒追上」與「真的不一樣」）、停寫切換的每一段花多少時間；記得共用表裡屬於搬走的那個服務的那幾列。
- 留一條回頭路（反方向的搬家程式），而且演練它。
- 說出什麼時候該把服務合併回單體，用數字回答，而且知道怎麼合：資料先、程式後。

---

## 9.2 先看見痛：照第 02 章的計畫，先切 10% ★★★

### 9.2.0 開分支

```bash
git switch -c d09 d08
```

這一章的第一個 commit 只放「痛」的實驗（M1）與它需要的部署：正式程式碼還是第 08 章的。kind 的 cluster 沿用第 08 章的定義（`scripts/d08-kind.sh cluster`、`gateway-api`、`observability`），這一章自己的部署在 `scripts/d09-kind.sh`。

到第 08 章為止，kind 上只有兩個服務。這一章的起點是**正式環境的樣子**：單體在跑、有資料，入口把 `/api/**` 全部送給它；兩個服務在旁邊，等著接手。所以第一件事是把單體也放進 kind（`k8s/base/monolith.yaml`，同一個映像檔、`SPRING_PROFILES_ACTIVE=prod`），入口的路由多一個 backend：

```yaml
# 買家、賣家、管理員、金流的回呼：都是 /api/**。庫存服務沒有對外的路由（/internal/** 只給訂單服務）
# 13 站第 09 章：遷移期間，/api/** 有兩個去處 —— 單體與訂單服務，各帶一個權重（Gateway API：一條規則好幾個 backend，照權重分）。
# 權重是相對的：100 與 0 = 全部給單體。灰度就是改這兩個數字
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: shop-api
spec:
  parentRefs: [{name: shop}]
  rules:
    - matches: [{path: {type: PathPrefix, value: /api}}]
      backendRefs:
        - {name: monolith, port: 8080, weight: 100}
        - {name: order-service, port: 8080, weight: 0}
```

（`weight` 是相對的：100 與 0，就是全部給單體。）

### 9.2.1 實驗怎麼做（M1）

第 02 章 2.8.5 寫了切過去的四步：核對通過之後，庫存服務指向新的庫、單體的 `InventoryApi` 換成遠端的實作、恢復接單、舊表先不刪。它沒有寫灰度 —— 「先切一小部分試試看」。最直覺的灰度是這樣：

- 單體在 `shop_d09_mono`，入口送給它的權重 90。
- 第 02 章 2.8.4 的搬家程式（trigger + 變更紀錄 + 整列複製）把庫存的五張表從單體的庫追到 `shop_d09_inv` —— 舊的庫是唯一寫入者，新的庫是它的副本。
- 2.8.5 的第 1、2 步：庫存服務接 `shop_d09_inv`；訂單服務（= 單體的 `InventoryApi` 換成遠端）接單體的庫。入口送給訂單服務的權重 10。

20 個商品、每個只有 20 件，一共 400 件。每秒 10 張下單（開放式負載，第 08 章的 `Load`），每張隨機買其中一個商品的 1 件，60 秒 —— 600 張，買得比賣得多。兩段：

1. **灰度的那 60 秒**：賣出幾件（單體的庫裡、成立而且沒有取消的訂單）、兩個庫各記了多少「已預留」、搬家程式的核對。
2. **回滾**：權重改回 100／0、兩個服務縮到 0。單體看得到那幾張經過訂單服務的訂單的預留嗎？再讓單體接 15 秒的單。

觀察用的一個 trigger 裝在新的庫上（不是搬家的一部分）：一筆預留的 `order_id` 被換成別的，就記下來 —— 整列改寫一筆預留的，只有搬家程式。

```java
            Mig.scale("inventory-service", 2);                                 // 2.8.5 的 1：庫存服務指向新的庫
            Mig.scale("order-service", 1);                                     // 2.8.5 的 2：單體的 InventoryApi 換成遠端 —— 訂單服務，接單體的庫
            Mig.weights(100 - canary, canary);
```

（完整的 `M1NaiveCanaryTest` 在 9.13.1。）

### 9.2.2 結果

```
═══ 9.2 照第 02 章的計畫切過去，先切 10%：20 個商品各 20 件（共 400 件），每秒 10 張下單、每張 1 件 ═══
  搬家程式（第 02 章 2.8.4）：回填 1,403 列，開始追變更紀錄；inventory_reservations 下一個 id：單體的庫 202、庫存服務的庫 202
  第 0 秒：入口的權重 單體 90、訂單服務 10
  ① 灰度 60 秒：下單 [201=444, 409=157]；單體收到 542 張、訂單服務 59 張（9.8%）
     賣出 444 件（單體的庫裡、成立而且沒有取消的訂單）；庫存只有 400 件 → 超賣 44 件；超賣的商品 19 個
     那幾個商品的訂單，依狀態：{PENDING_PAYMENT=444, REJECTED=157}（503 的那幾張：預留成了、回應沒有回來，訂單停在 RESERVING，第 04 章 4.5.5 的排程會收）
     兩個庫的「已預留」：單體的庫 400 件、庫存服務的庫 400 件
     搬家程式：套用 1,200 筆變更紀錄、失敗 0 次
     核對（列數＋CRC32）不一樣的表：[]
  ② 回滾：權重 單體 100、訂單服務 0；兩個服務縮到 0
     單體的庫裡，還在等付款、卻找不到自己的預留的訂單：44 張（共 444 張還在等付款）
       它們的預留在庫存服務的庫裡：還在 0 張；被搬家程式換成另一張訂單的預留 44 張（新的庫裡，預留被換掉 order_id 的一共 44 筆）
     單體以為還能賣 0 件；實際上已經超賣 44 件
     回滾之後單體再接 15 秒：下單 [409=151]；又賣出 0 件 → 超賣 44 件
  （結束時 load { 4.22 8.15 8.21 }）
```

- **① 灰度的那 60 秒**：入口把 59 張（9.8%）送給訂單服務。400 件賣出 444 件，19 個商品賣超過 20 件 —— **超賣 44 件**。這一次沒有 503，成立的訂單就是那 444 張 201（探索的時候有一次出現 2 張 503：預留成了、回應沒有回來，訂單停在 `RESERVING` —— 那一行括號是為它寫的。那一次的「賣出」還把它們算進去：回滾之後單體又接到 2 張 201，「又賣出」卻是 0、超賣反而少了 1 件（推論：排程把那兩張 `RESERVING` 收掉了，第 04 章 4.5.5）。改成只算成立的）。
- **兩個庫都說「已預留 400 件」**：單體自己就把 400 件賣完了；訂單服務那一邊賣掉的 44 件，兩個庫都沒有記。
- **核對：「不一樣的表：[]」。** 第 02 章的核對（列數＋CRC32）說兩個庫一模一樣。
- **② 回滾之後**：還在等付款的 444 張訂單裡，44 張在單體的庫裡找不到自己的預留；它們在庫存服務的庫裡也不在 —— **44 張全部被搬家程式換成了另一張訂單的預留**（觀察用的 trigger 記到的；新的庫裡被換掉 `order_id` 的一共 44 筆）。搬家之後，兩個庫的 `inventory_reservations` 下一個 id 都是 202。
- 這一次單體自己就賣完了，所以它以為還能賣 0 件，回滾之後的 15 秒全部 409，超賣停在 44 件。單體的庫如果還記著「剩幾件」，那幾件其實已經被訂單服務那一邊賣掉了 —— 它會再賣一次：探索時的第一輪，單體以為還能賣 3 件，回滾之後的 15 秒又賣出 3 件，超賣從 41 件變成 44 件。

### 9.2.3 兩個正本

灰度讓同一份資料有了**兩個接受寫入的地方**：

- 單體寫單體的庫：它扣庫存時只看得到單體的庫，看不到訂單服務那一邊賣掉的。
- 庫存服務寫新的庫：它扣庫存時看到的「已預留」，是搬家程式剛從單體的庫複製過來的值 —— 不包括它自己賣掉的，因為那幾筆一下子就被蓋掉了。

所以兩邊各賣各的，加起來超過 400 件。而且搬家程式把每一個「單體改過的列」整列蓋到新的庫，**新的庫裡訂單服務寫的東西會消失**：`inventory` 的那一列被蓋回單體的值；預留那一張表的 id 是兩邊各自 `AUTO_INCREMENT` 發的，搬家之後兩邊的下一個號碼一樣 —— 訂單服務那邊寫下第 N 號預留，等單體也發到第 N 號，搬家程式就用單體的那一列把它整列蓋掉。

最後那一行最危險：**核對說兩個庫一樣**。第 02 章的核對比的是「副本與正本一不一樣」，而它們確實一樣 —— 灰度寫進副本的東西已經被蓋掉了。照第 02 章的規則，這時候是可以切換的。

回滾也救不了：權重改回去之後，那幾張經過訂單服務的訂單還在（訂單本來就在單體的庫），它們的預留兩個庫都沒有。單體的「已預留」少了訂單服務賣掉的那一截 —— 還有剩的話，它會把那幾件再賣一次（9.2.2 的最後一點）。

第 02 章 2.8.5 的最後一句是對的：**搬家的時候，只能有一個寫入者。** 灰度把「切換的那一刻」拉長成一段時間，在那一段時間裡，偷偷變成了兩個。

---

## 9.3 Strangler Fig：完整的流程

### 9.3.1 名字的由來，與一個詞

Martin Fowler 2001 年在澳洲昆士蘭的雨林裡看到絞殺榕（strangler fig）：它是一種藤，在一棵樹的枝椏間發芽，從宿主身上吸養分，往下長到地面生根、往上長到樹冠見光，然後就能自己活下去。他拿它比喻改寫舊系統的一種做法：**不一次重寫、一次切換**，而是讓新的系統長在舊的旁邊，把行為一塊一塊搬過去，直到舊的可以拿掉（<https://martinfowler.com/bliki/StranglerFigApplication.html>，現在的版本是 2024 年 8 月改寫的）。

那一篇裡有一個詞，這一章一直用得到：**過渡架構**（transitional architecture）—— 只為了讓新的與舊的同時存在而寫的東西，遷移完成之後要拆掉。這個專案到這裡已經有好幾個：

| 過渡架構 | 從哪一章來 | 讓什麼可以同時存在 |
|---|---|---|
| 變更紀錄與 trigger、搬家程式 | 第 02 章 2.8.4 | 舊的庫與新的庫 |
| 一個 jar、三種角色 | 第 03 章 3.7 | 單體與兩個服務（同一份程式） |
| 「線上那一版」的契約 | 第 03 章 3.8 | 新舊兩版的訂單服務 |
| 入口的權重、`Shop-Route` | 這一章 9.5 | 單體與訂單服務接同一個入口 |
| 共用的庫 | 這一章 9.4 | 單體與兩個服務接同一份資料 |
| 反方向的搬家程式 | 這一章 9.6.6 | 新的庫是正本，舊的庫還回得去 |

它們都有成本（trigger 讓每一張訂單多 9 句 `INSERT`，第 02 章 2.8.4 ④），所以每一個都要有一個「什麼時候拆」（9.8）。

### 9.3.2 兩條規則

這一章的每一個步驟，都是為了守住兩條規則：

1. **任何時刻，每一份資料只有一個正本。** 幾個行程寫它都可以 —— 它們的交易、鎖、唯一索引都在同一個庫裡。不可以的是兩個庫各自接受寫入，再想辦法讓它們一樣：9.2 就是那樣，第 02 章 2.8.3 的雙寫也是。
2. **每一步都有回頭路，而且回頭路演練過。** 回頭路的代價決定一步可以跨多大：改權重的回頭路是 0.3 秒內生效（9.5.5），換庫的回頭路是一次停寫（9.7）。

### 9.3.3 這個系統的遷移：六步

| 步 | 做什麼 | 庫存的正本 | 回頭路 | 在哪一節 |
|---|---|---|---|---|
| 0 | 入口在單體前面（第 08 章的入口；權重 100／0） | 單體的庫 | —— | 9.4 |
| 1 | 兩個服務上線，**接單體的庫**；權重 0 | 單體的庫 | 縮到 0 | 9.4 |
| 2 | 灰度：權重 5 → 25 → 50 → 100 | 單體的庫 | 改權重 | 9.5 |
| 3 | 單體退場（縮到 0） | 單體的庫 | 單體起來、改權重 | 9.6.1 |
| 4 | 搬資料：搬家程式、邊寫邊對帳、停寫切換 | **新的庫**（切換那一刻起） | 反方向的搬家程式、停寫切回 | 9.6、9.7 |
| 5 | 收尾：拆掉過渡架構 | 新的庫 | 沒有了（要回去，是 9.10 的那一整套） | 9.8 |

跟 9.2 那一條路比，差在一件事：**程式先搬，資料最後搬。**

### 9.3.4 為什麼程式先搬

- **改程式的那幾步，回頭路幾乎是免費的。** 第 1～3 步，資料一直在單體的庫裡。不管入口把一個請求送到哪一邊，讀寫的都是同一份資料 —— 權重改回去，就回去了，沒有什麼要搬回來。
- **風險分開來量。** 新的程式（遠端呼叫、Saga、逾時、熔斷）在灰度裡用真的流量一點一點驗證；資料搬家是另外一件事，等程式已經接下 100% 的流量、跑穩了，才做，而且只做一次。
- **資料那一步沒辦法灰度。** 「10% 的買家寫新的庫、90% 寫舊的庫」就是兩個正本（9.2）。所以這一步只能一次切過去 —— 停寫、追完、核對、切換 —— 能做的是讓它短、讓它有回頭路。

代價是一段**共用的庫**的時間：兩個服務接單體的庫。第 02 章 2.3.2 說共享資料庫藏起來三件事，再加上兩件常見的。這一段時間，它們各靠什麼擋：

| 第 02 章 2.3.2 | 這一段時間 |
|---|---|
| **誰在寫**：連得上的程式都可以寫任何一張表 | 靠程式碼的邊界：三個部署跑的是同一份程式，第 12 站的 `TableOwnershipTest`、第 02 章 2.4.5 的 `ServiceDatabaseTest` 都還在守。資料庫的權限擋不了（第 02 章 2.4.4：每個服務一個帳號，沒有做） |
| **寫到哪**：同名的表有兩份 | 不會發生：每一張表只有一份，就是單體的那一份 —— 第 02 章 2.2 的問題，正是兩邊各有一份庫存表 |
| **少了什麼**：只有拿掉之後才看得見的依賴 | 這一段時間看不見；搬資料（9.6）的時候才會看見 |
| schema 的改動要協調 | 只有單體的 migration Job 在跑（9.4.2） |
| 效能互相拖累 | 擋不了。這一段時間要短 |

**共用的庫是過渡架構，不是終點。** 它的期限寫在第 3、4 步：單體一退場，資料就搬。

---

## 9.4 第一步：新的服務接到單體的庫

### 9.4.1 設定

計畫改了：兩個服務都接單體的庫、單體的 Redis。kind 的 overlay 只改庫存服務那兩個值（訂單服務在 9.2 就已經接單體的庫）：

```diff
 #   映像檔：docker build 出來、kind load 進去的 shop:d08（imagePullPolicy 預設 IfNotPresent：不會去 registry 拉）
 #   外部依賴：compose 的 MySQL、Redis、RabbitMQ，在 host.docker.internal（Docker Desktop 讓容器連得到這台筆電）
 #   資料庫、Redis 的 database、RabbitMQ 的 vhost：這一章自己的，不碰第 12 站的 shop
-#   13 站第 09 章：單體在 shop_d09_mono；訂單服務接手單體的庫，庫存服務搬到 shop_d09_inv（第 02 章 2.8.5 的計畫）
+#   13 站第 09 章：單體在 shop_d09_mono。兩個服務先接單體的庫與 Redis（9.4：程式先搬、資料最後搬）——
+#   第一版照第 02 章 2.8.5 的計畫，庫存服務一開始就接 shop_d09_inv：灰度的那一段有兩個寫入者（9.2）
 #   秘密：只在本機用的值（正式環境由部署平台注入，不在 repo 裡）
 apiVersion: kustomize.config.k8s.io/v1beta1
 kind: Kustomization
…
       - {op: add, path: /data/SPRING_DATA_REDIS_DATABASE, value: "3"}
   - target: {kind: ConfigMap, name: inventory-service}
     patch: |-
-      - {op: replace, path: /data/SHOP_DB_NAME, value: shop_d09_inv}
-      - {op: add, path: /data/SPRING_DATA_REDIS_DATABASE, value: "2"}
+      - {op: replace, path: /data/SHOP_DB_NAME, value: shop_d09_mono}
+      - {op: add, path: /data/SPRING_DATA_REDIS_DATABASE, value: "3"}
```

三個部署接同一個庫、同一個 Redis、同一個 vhost —— 對資料來說，就是「單體多開了兩台，各自只做一部分的事」：

- **同一份資料**：每一張表只有一份，交易、鎖、唯一索引都在同一個庫裡。熱點閘門（Redis 的 `stock:{id}`）也只有一份。
- **同一組佇列**：佇列是一個消費者一個（第 12 站 7.3.2）。單體收每一個佇列，兩個服務各收自己模組的（第 03 章 3.7.3）—— 同一個佇列有兩個行程在收，RabbitMQ 輪流分（第 03 章 3.2.2 量過）。在第 03 章那是 bug：兩個服務的庫不一樣，收錯的那一邊做錯事。這裡兩邊寫同一個庫，誰收到都一樣，`processed_messages` 也是同一張 —— 跟單體開兩台一樣。
- **同一個 outbox**：三個行程的 relay 都在讀同一張 `outbox_events`，靠第 12 站 7.4.2 的租約（`claimed_until`）分工，也跟單體開兩台一樣。

### 9.4.2 migration 只能有一個主人

第 08 章的部署是「每個服務跑自己的 migration Job」：訂單服務的 Job 跑七個資料夾、庫存服務的跑兩個（第 02 章 2.4.2）。三個部署接同一個庫的時候，訂單服務的 Job 在單體的庫上跑：

```
ERROR: Validate failed: Migrations have failed validation
Detected applied migration not resolved locally: 3.
Detected applied migration not resolved locally: 13.
Detected applied migration not resolved locally: 18.
Detected applied migration not resolved locally: 24.
Detected applied migration not resolved locally: 25.
Detected applied migration not resolved locally: 28.
Detected applied migration not resolved locally: 30.
Detected applied migration not resolved locally: 31.
```

單體的庫的 `flyway_schema_history` 裡有庫存那幾個資料夾跑過的版本，訂單服務的 Job 只認得自己的七個資料夾 —— Flyway 預設把「庫裡跑過、本地找不到」當成錯誤（它不知道那是別人的，只知道少了）。庫存服務的 Job 也一樣，少的是另外七個資料夾。

**共用一個庫的時候，migration 只能有一個主人**：單體的 Job，跑每一個資料夾。`scripts/d09-kind.sh` 的 `deploy` 只套它：

```bash
    # 9.4：三個都接單體的庫的時候，只有單體的 Job 跑 migration —— 訂單服務的 Job 只認得七個資料夾，在這個庫上驗證就失敗
    # （Detected applied migration not resolved locally）。notin：沒有這個標籤的（kustomize 產生的 Secret）也算
    k apply -k k8s/kind/migrate -l 'migrate notin (order,inventory)'
    k -n shop wait --for=condition=complete job/migrate-monolith --timeout=180s
```

這也代表：**共用的那一段時間，兩個服務不能各自改 schema。** 要加一個欄位，改的是單體的 Job 跑的那幾個資料夾，跟第 12 站一樣 —— 這段時間要短的另一個理由。

### 9.4.3 ⚠️ 兩個行程同時第一次啟動

在 kind 上把三個部署一起起來（一個空的庫），單體的 `RESTARTS` 是 1。最後一輪在第一個 commit 上部署完，記下每一個 pod 的 `RESTARTS` 與上一次的日誌：

```
NAME                                 RESTARTS
inventory-service-7655d59446-8z9jt   0
inventory-service-7655d59446-md9sr   0
migrate-inventory-p5qtm              0
migrate-monolith-zmd49               0
monolith-67dfb9fc4-g2nc7             1
order-service-6967db698b-tjxn7       0
── monolith-67dfb9fc4-g2nc7 上一次的日誌（有 Duplicate entry 的那幾行）
Duplicate entry 'a***@example.com' for key 'users.uk_users_email'
```

第 12 站 5.10 的 `BootstrapAdmin`：起來的時候，庫裡沒有管理員就用環境變數建一個。單體與訂單服務（都擁有 account 模組）同時起來，**兩邊都看到「沒有管理員」、都去建**，輸的那一邊撞到唯一索引，`ApplicationRunner` 丟例外，整個應用程式起不來。K8s 把它重開，第二次看到「已經有了」，就好了。

這不是遷移才有的 bug：第 12 站的單體開兩台、對一個新的庫同時第一次部署，一樣會撞。它只是一直沒有遇過「兩台同時第一次起來」。

先寫一個測試把那個順序釘住（紅）：A 檢查的時候還沒有（第一次的 `adminCount()` 回 0），A 建的時候 B 已經建好了（庫裡已經有同一個 email 的管理員）：

```java
    @Test
    void anotherProcessCreatedTheAdminInBetween() {
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM user_roles WHERE role = 'ADMIN'", Long.class)).isPositive();
        long users = jdbc.queryForObject("SELECT COUNT(*) FROM users", Long.class);
        FirstLooksEmpty accounts = new FirstLooksEmpty(jdbc, false);

        assertThatCode(() -> new BootstrapAdmin(accounts, encoder, tx, props).run(null)).doesNotThrowAnyException();
        assertThat(accounts.calls).hasValue(2);                                      // 撞到之後再看一次：有了
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM users", Long.class)).isEqualTo(users);
    }
```

```
[ERROR] Tests run: 2, Failures: 1, Errors: 0, Skipped: 0, Time elapsed: 20.17 s <<< FAILURE! -- in com.example.shop.account.internal.BootstrapAdminRaceTest
Expecting code not to raise a throwable but caught
  "org.springframework.dao.DuplicateKeyException: PreparedStatementCallback; Duplicate entry 'admin@example.com' for key 'users.uk_users_email'
Expecting code not to raise a throwable but caught
  "org.springframework.dao.DuplicateKeyException: PreparedStatementCallback; Duplicate entry 'admin@example.com' for key 'users.uk_users_email'
[ERROR] Tests run: 2, Failures: 1, Errors: 0, Skipped: 0
```

修：撞到唯一索引之後再看一次 —— 有管理員了，就是別人剛建好；還是沒有（那個 email 被一個不是管理員的帳號用掉了），才是真的錯，照舊起不來：

```java
        long id;
        try {
            id = tx.execute(s -> accounts.insert(email, encoder.encode(password), "管理員", Role.ADMIN, null));
        } catch (DuplicateKeyException race) {
            // 13 站 9.4.3：另一個行程同時對同一個庫第一次啟動（遷移期間單體與訂單服務接同一個庫；或兩台同時第一次部署）——
            // 兩邊都看到「沒有管理員」、都去建，輸的這一邊撞到 uk_users_email。第一版就這樣起不來（BootstrapAdminRaceTest）。
            // 別人剛建好就是建好了；email 被一個不是管理員的帳號用掉了，才是真的錯，照舊起不來
            if (accounts.adminCount() == 0) throw race;
            log.info("BOOTSTRAP_ADMIN_EXISTS email={}：另一個行程剛建好", Email.mask(email));
            return;
        }
```

### 9.4.4 ⚠️ 新的路的副本是空的

權重還是 0 的時候，可以先比一比兩條路回的東西一不一樣（9.5.3 的雙跑比對）。第一次比，24 個讀的請求有 12 個不一樣，不一樣的欄位都是 `available`：

```
  ⓪ 權重 0，Shop-Route 兩邊各送一次（雙跑比對）：24 個讀的請求，回應一樣 12 個；不一樣的欄位 {available=12}
     例：/api/products/9000236：單體 available=10000000、訂單服務 available=0
     例：/api/products/9000281：單體 available=10000000、訂單服務 available=0
     例：/api/products/9000326：單體 available=10000000、訂單服務 available=0
```

訂單服務的商品頁讀的是**自己庫裡的副本**（第 05 章 5.4 的 `stock_levels`）；單體直接讀庫存的表。三個部署接同一個庫，`stock_levels` 這張表也在那裡 —— 單體一直在維護它（`StockReplica` 在每一個角色裡都在，第 05 章 5.4.4），可是只有**有過 `stock-changed` 事件**的商品才有一列。種子資料是直接寫進庫的，暖機時被下過單的商品有，其他的沒有：灰度的買家打開那些商品頁，會看到 0 件。

第 05 章 5.6.4 遇過同一件事，那時候的結論是「部署之後打一次重建是部署流程的一步；要讓副本還沒建好的訂單服務不接流量，是 readiness 的事」。灰度讓它不能再靠人記得：權重一調上去，沒建好的那一台馬上就接到流量。所以這一章把它做成 readiness：

```java
    @EventListener(ApplicationReadyEvent.class)
    void onReady() {
        Thread.ofVirtual().name("stock-replica-check").start(this::ensureComplete);
    }

    /** 起來之後跑一次：缺的話重建，直到成功一次 */
    void ensureComplete() {
        while (!complete) {
            try {
                long missing = replica.missing();
                if (missing == 0) {
                    state = "完整";
                } else {
                    state = "缺 " + missing + " 個商品，重建中";
                    StockReplica.Rebuilt r = replica.rebuild(500);
                    long left = replica.missing();
                    state = "重建過：缺 " + missing + " 個 → 寫了 " + r.products() + " 個（" + r.millis() + " ms）" + (left > 0 ? "，還缺 " + left + " 個（庫存那一邊沒有）" : "");
                    log.info("STOCK_REPLICA_REBUILT missing={} products={} millis={} left={}", missing, r.products(), r.millis(), left);
                }
                complete = true;
            } catch (RuntimeException e) {
                state = "重建失敗，" + retry.toMillis() + " ms 後再試：" + e;
                log.warn("STOCK_REPLICA_REBUILD_FAILED {}", e.toString());
                try { Thread.sleep(retry); } catch (InterruptedException ie) { return; }
            }
        }
    }
```

```yaml
# 13 站 3.7：同一個 jar 的「訂單服務」—— 庫存以外的八個模組。跟另一個 profile 疊在一起用：
#   本機：--spring.profiles.active=local,order-service      正式：SPRING_PROFILES_ACTIVE=prod,order-service
shop:
  deployment:
    role: order-service
    inventory:
      url: ${SHOP_INVENTORY_URL:http://localhost:8082}
    service-token:
      secret: ${SHOP_SERVICE_TOKEN_SECRET}     # 跟庫存服務同一把；跟 shop.security.jwt-secret 不同
  inventory:
    jobs-enabled: false            # 熱點對帳、INV-2/INV-3 的對帳讀的是庫存的表 —— 那是庫存服務的排程

spring:
  application:
    name: order-service            # 13 站 7.4：trace 的 service.name、JSON 日誌的 service 欄位。單體是 shop；兩個服務都叫 shop 的時候，後端分不出 span 是誰的（7.2）
  jpa:
    hibernate:
      ddl-auto: none               # 庫存的兩個實體還在 jar 裡、表不在這個庫裡：validate 會讓服務起不來（第 02 章 2.4.6）。
                                   # schema 跟實體對不對得上，改由建置時的 EntitySchemaDriftTest、ServiceDatabaseTest 守
  flyway:                          # 本機（local）才會在啟動時跑；正式環境的 migration 是部署的一個步驟（第 12 站 9.4）
    locations: classpath:db/migration/account,classpath:db/migration/cart,classpath:db/migration/catalog,classpath:db/migration/notification,classpath:db/migration/ordering,classpath:db/migration/payment,classpath:db/migration/shared

management:
  endpoint:
    health:
      group:
        readiness:                 # 13 站 9.4.4：application.yml 的兩個，加上庫存的副本要先完整（StockReplicaHealthIndicator：只有訂單服務有它，所以寫在這個 profile）
          include: readinessState,db,stockReplica
```

兩個決定：

- **重建成功一次就算數，不是「一個都不缺」才算。** 快照裡沒有的商品（庫存那一邊沒有那一列，例如建立商品的事件進了死信），重建幾次都不會有 —— 拿它當條件，訂單服務就永遠不 ready。缺的數字寫在 health 的詳細裡、也寫日誌。
- **只在起來的時候檢查一次。** 之後新的商品由事件補上（建立商品 → 庫存建一列 → `stock-changed`）。繞過事件、直接用 SQL 塞進去的商品，它不知道 —— 9.4.5 量到了這一點。

### 9.4.5 ⚠️ 我的實驗台先起服務、後種資料

修好之後再比一次，還是 14 個 0 件：

```
  ⓪ 權重 0，Shop-Route 兩邊各送一次（雙跑比對）：24 個讀的請求，回應一樣 10 個；不一樣的欄位 {available=14}
```

不是修正沒生效，是我的實驗台的順序：`Mig.fresh()` 先把三個部署都重開、等它們 ready，最後才把 1,000 個商品寫進庫 —— 訂單服務起來的那一刻，商品表是空的，檢查說「一個都不缺」，之後種的商品它不知道。

正式環境不是這個順序：單體先帶著資料在跑，新的服務後來才起來。`fresh()` 改成這樣之後，訂單服務起來就重建（`kubectl logs` 看到的那一行：`STOCK_REPLICA_REBUILT missing=1000 products=1000 millis=1739 left=0`，沒有另外存成紀錄），雙跑比對 24 個讀的請求全部一樣（9.5.3）。

這個錯也說明了修正的邊界：它守的是「新的一台起來的那一刻」，不是「任何時候副本都完整」。後者要靠對帳（第 05 章 5.6 的重建、第 12 站的對帳排程）。

### 9.4.6 追記：每個服務一個資料庫帳號

📌 **第 09 章寫完之後補的。** 9.3.4 的表第一列：共用一個庫的那一段，「誰在寫」只靠程式碼的邊界，「資料庫的權限擋不了（第 02 章 2.4.4：每個服務一個帳號，沒有做）」。現在做了（第 02 章 2.4.4 的追記）：單體還是 `shop`（`shop_app`，每一張表），訂單服務是 `order_svc`（庫存以外），庫存服務是 `inventory_svc`（庫存的五張表與 shared）。三個部署照樣接同一個庫。M7 量三件事：

```bash
mvn test -Pexperiments -Dtest=M7AccountsTest
```

```
═══ 2.4.4 的追記：每個服務一個資料庫帳號 —— 三個部署接 shop_d09_mono（第 09 章 9.4 共用的那一段）═══
  monolith          的 SHOP_DB_USER：shop
  order-service     的 SHOP_DB_USER：order_svc
  inventory-service 的 SHOP_DB_USER：inventory_svc
  ① 三個帳號各讀一張庫存的表、一張訂單的表
    shop           inventory → 1000 列 │ orders → 0 列
    order_svc      inventory → SELECT command denied to user 'order_svc'@'172.64.144.78' for table 'inventory' │ orders → 0 列
    inventory_svc  inventory → 1000 列 │ orders → SELECT command denied to user 'inventory_svc'@'172.64.144.78' for table 'orders'
  ② 權重 0／100、單體縮到 0：使用者的一天（每一種動作、每一個狀態碼幾次）
    DELETE 購物車的一項                {200=12}
    GET 商品列表                     {200=12}
    GET 商品頁                      {200=12}
    GET 我的訂單                     {200=12}
    GET 熱門商品                     {200=12}
    GET 管理員的報表                   {200=1}
    GET 管理員的死信                   {200=1}
    GET 管理員看 Saga                {200=4}
    GET 訂單詳情                     {200=12}
    GET 賣家的商品                    {200=1}
    GET 賣家的報表                    {200=1}
    GET 賣家的訂單                    {200=1}
    GET 購物車                      {200=12}
    POST 下單                      {201=12}
    POST 付款（建立＋回呼）               {200=8}
    POST 取消熱點                    {200=1}
    POST 建立商品                    {201=1}
    POST 標成熱點                    {200=1}
    POST 確認收貨                    {200=4}
    POST 補貨                      {200=1}
    POST 買家取消                    {200=4}
    POST 賣家出貨                    {200=4}
    POST 賣家撿貨                    {200=4}
    POST 購物車                     {200=12}
    之後排程再跑 70 秒。兩個服務的日誌裡的「command denied」：沒有
  ③ 設定錯誤：訂單服務打開庫存的排程（庫存服務縮到 0、沒有負載）
    訂單服務用 shop     ：70 秒裡，checkUncounted 那一句跑了 2 次、錯了 0 次；訂單服務的 ERROR 日誌 沒有
    訂單服務用 order_svc：70 秒裡，checkUncounted 那一句跑了 2 次、錯了 2 次；訂單服務的 ERROR 日誌 {TaskUtils$LoggingErrorHandler：Unexpected error occurred in scheduled task=2}
  （結束時 load { 6.62 8.46 9.75 }）
```

- **① 三個帳號**：`order_svc` 讀 `inventory` 被拒絕，`inventory_svc` 讀 `orders` 被拒絕，`shop` 兩張都讀得到。
- **② 使用者的一天**：權重 0／100（`/api/**` 全部給訂單服務）、單體縮到 0，買家、賣家、管理員的每一種動作走過一次以上，再讓兩個服務的排程跑 70 秒：兩個服務的日誌裡**沒有任何一行「command denied」**。第 12 站的 `TableOwnershipTest`（每個模組只碰自己的表）與第 03 章 3.7 的角色守住了這些路徑 —— 這一次是資料庫也同意。
- **③ 一個設定錯誤**：訂單服務的庫存排程本來是關的（第 03 章 3.7 的 `shop.inventory.jobs-enabled`）；這裡用環境變數打開它，模擬「有人改設定時漏了一行」。用 `shop`（第 09 章原本的樣子）：庫存排程裡的一句（`checkUncounted`：每 30 秒找未計入的熱點預留）跑了 2 次、0 個錯，**日誌裡什麼都沒有** —— 訂單服務在讀庫存的表，沒有人知道。用 `order_svc`：同一句跑了 2 次、2 次被拒絕，日誌兩行 ERROR。

②說的是「現在沒有越界的程式」，③說的是「以後有人越界，會在共用的那一段就被看見」—— 9.3.4 那一列的「少了什麼：只有拿掉之後才看得見的依賴」，有了帳號，在搬資料之前就看得見。

> ⚠️ **M7 的第一次，② 有一半是 429。** 我讓工作負載一個請求接一個送，撞到「每個 IP 每秒 50 次」（第 12 站 6.7.2）—— 這一章 9.5.4 的 M3 第一版推論是同一個錯、那一次沒有記狀態碼，這一次記了：429：好幾種動作一半的請求根本沒有走到程式裡，「沒有 command denied」就不算數。改成每一個動作之後停 60 ms 重跑 —— 上面是重跑的那一次。第一次的其中三列：
>
> ```
>     GET 購物車                      {200=6, 429=6}
>     POST 下單                      {201=6, 429=6}
>     POST 補貨                      {429=1}
> ```

---

## 9.5 灰度

三個部署接同一個庫之後，入口的兩個數字就是整個灰度：`monolith` 的權重、`order-service` 的權重。

### 9.5.1 入口的權重：每一個請求挑一次

第 08 章 8.6.1 量過，kube-proxy 在**建立連線**的時候挑 pod —— 訂單服務重用連線，擴容之後新的 pod 要等 30～40 秒才分得到。入口的權重是不是也這樣？看 Envoy 實際的設定（M2 在權重 50／50 的時候，從入口的 Envoy 的 admin 讀出來）：

```
入口的 Envoy 的設定（權重 50／50 的時候）：cluster httproute/shop/shop-api/rule/0：backend 0 權重 50 [10.244.0.31]；backend 1 權重 50 [10.244.0.33]；單體 [10.244.0.31]、訂單服務 [10.244.0.33]
權重 100／0 之後入口的 Envoy 的設定（訂單服務的 pod 還在）：cluster httproute/shop/shop-api/rule/0：backend 0 權重 100 [10.244.0.31]
```

Envoy Gateway 把一條規則的幾個 backend 放進**同一個 cluster**，每一個 backend 是一個 locality，`weight` 變成 locality 的權重。第二行是權重改成 100／0 之後（9.5.5），訂單服務的 pod 都還在：它那一個 locality 直接不見了 —— 權重 0 不是「權重很小」，是不在這個 cluster 裡。Envoy 對 HTTP 是**每一個請求**挑一個上游：先用 locality 的權重做加權輪流（weighted round-robin）挑一個 locality，再在裡面照這個 cluster 的負載平衡挑一台（<https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/upstream/load_balancing/locality_weight>；權重 0 的 locality 怎麼辦，文件沒有寫 —— Envoy Gateway 的做法是不放進去）。入口跟後面的 pod 之間有它自己的連線池，連線是重用的，但「這一個請求送給誰」每一次都重新決定。

M2 每一段 30 秒、每秒 10 張下單，訂單服務實際分到的比例：

```
    訂單服務   5% │ 實際分到   5.3%
    訂單服務  25% │ 實際分到  24.8%
    訂單服務  50% │ 實際分到  49.8%
    訂單服務 100% │ 實際分到 100.0%
```

### 9.5.2 要看什麼：兩邊各算各的

灰度要回答的問題是「新的那一邊，比舊的那一邊差嗎」。所以每一個數字都要**兩邊各算一次**，不能只看全站：

```
  ① 權重一段一段往上，每一段 30 秒
    訂單服務   5% │ 實際分到   5.3% │ 下單 201=302          │ p50   31 ms、p99    95 ms │ 單體 286 張、5xx 0.0%、超過 500 ms 0.0%、平均 31 ms │ 訂單服務 16 張、5xx 0.0%、超過 500 ms 0.0%、平均 67 ms
    訂單服務  25% │ 實際分到  24.8% │ 下單 201=302          │ p50   32 ms、p99   100 ms │ 單體 227 張、5xx 0.0%、超過 500 ms 0.0%、平均 29 ms │ 訂單服務 75 張、5xx 0.0%、超過 500 ms 0.0%、平均 47 ms
    訂單服務  50% │ 實際分到  49.8% │ 下單 201=301          │ p50   35 ms、p99   194 ms │ 單體 151 張、5xx 0.0%、超過 500 ms 0.0%、平均 31 ms │ 訂單服務 150 張、5xx 0.0%、超過 500 ms 0.0%、平均 42 ms
    訂單服務 100% │ 實際分到 100.0% │ 下單 201=301          │ p50   34 ms、p99    79 ms │ 單體 0 張 │ 訂單服務 301 張、5xx 0.0%、超過 500 ms 0.0%、平均 35 ms
```

- **分到的比例**：5% → 5.3%、25% → 24.8%、50% → 49.8%。每一段 30 秒、300 張左右，比例就很接近權重 —— 每一個請求挑一次的結果。
- **兩邊都沒有 5xx、都沒有超過 500 ms 的**。差的是平均：訂單服務在 5% 那一段平均 67 ms、單體 31 ms；到 100% 那一段，訂單服務是 35 ms。新的那一邊是冷的（JVM 剛起來、連線池還沒暖），而且一張下單多一次 HTTP（預留）—— 一開始只分到幾張的那一段，平均被最初的幾張拉高。灰度的頭幾分鐘，「新的比較慢」不一定是新的程式比較慢；要看它是不是一直降下來。
- 每秒 10 張的負載下，這一段沒有什麼好挑的。灰度真的要防的，是只有新的路才有的錯（例如第 08 章 8.6.3 的限流）—— 那種錯在全站的比例裡會被稀釋，所以要兩邊各算。

全站的告警（第 12 站的 `ShopHigh5xxRatio`）只算全站的比例。灰度在 5% 的時候，新的那一邊就算錯 10%，全站也只有 0.5% —— 低於 1% 的門檻，**不會響**。新的一條規則照 `job`（kubernetes_sd 給的，就是 pod 的 `app` 標籤，第 08 章 8.9.1）各算各的：

```yaml
      - alert: ShopJobHigh5xxRatio
        # 13 站 9.5.2：同一件事，每一個接 /api/** 的 job 各算各的。灰度的時候，新的那一邊只分到 5%：它的 5xx 是 10%，全站只有 0.5% ——
        #   上面那一條不會響（被舊的那一邊稀釋了）。這一條看得到，而且 job 標籤就是「哪一邊」。
        # 分到的請求很少的時候，一個 5xx 就是好幾 %：靠 1 分鐘窗與 for 5m —— 要連續 5 分鐘、每一分鐘都還有 5xx 才響
        expr: |
          (sum by (job) (rate(http_server_requests_seconds_count{system="shop",uri=~"/api/.*",status=~"5.."}[5m]))
             / sum by (job) (rate(http_server_requests_seconds_count{system="shop",uri=~"/api/.*"}[5m])) > 0.01)
          and
          (sum by (job) (rate(http_server_requests_seconds_count{system="shop",uri=~"/api/.*",status=~"5.."}[1m]))
             / sum by (job) (rate(http_server_requests_seconds_count{system="shop",uri=~"/api/.*"}[1m])) > 0.01)
        for: 5m
        labels: {severity: page}
        annotations:
          summary: "{{ $labels.job }} 的 5xx 超過 1%（{{ $value | humanizePercentage }}），持續 5 分鐘"
          why: "13 站 9.5.2：灰度時新的那一邊的錯誤，在全站的比例裡會被稀釋。正在灰度的話：先把權重調回去，再查"
```

promtool 的測試把那個稀釋釘住：單體每 15 秒 1,900 個請求、沒有錯；訂單服務 100 個、其中 10 個 503 —— 全站那一條不響，這一條響、而且 `job` 就是 `order-service`；另一組是「只錯了一陣子」，不響：

```
  SUCCESS: 21 rules found
  SUCCESS
```

（這一條沒有在 kind 上「真的讓新的那一邊壞一陣子」驗證過：M2 的每一段都是 0 個 5xx。）

📌 **第 09 章寫完之後的追記：在 kind 上真的壞一陣子。** M9：灰度在 5%（單體 95、訂單服務 5），經過入口每秒 4 張下單、36 個商品頁（下單只占一成：新的那一邊壞掉的時候，它的 5xx 是一成左右，全站只有 0.5%）。第 60 秒讓新的那一邊壞掉 —— 一個只有新的路才有的設定錯誤：訂單服務的 `SHOP_INVENTORY_URL` 指到一個不存在的名字（`kubectl set env`，滾動更新換上去；readiness 看的是自己的庫與副本，不看庫存服務連不連得到，9.4.4 的設定）。之後它的每一張下單都是 503，商品頁照常。每 15 秒問一次 kind 上的 Prometheus：

```bash
mvn test -Pexperiments -Dtest=M9JobAlertTest
```

```
═══ 9.5.2 ShopJobHigh5xxRatio 在 kind 上：灰度 5%，每秒 4 張下單、36 個商品頁；第 60 秒訂單服務的 SHOP_INVENTORY_URL 指錯 ═══
  告警（每 15 秒問一次 /api/v1/alerts；ShopHigh5xxRatio 一次都沒有出現就是沒有 pending 過）：
    第   0 秒 ShopDown{inventory-service} pending
    第   0 秒 ShopServiceGone{inventory-service-next} pending
    第  31 秒 ShopServiceGone{inventory-service-next} firing
    第  46 秒 ShopDown{inventory-service} 解除
    第  72 秒 ── 訂單服務的 SHOP_INVENTORY_URL 指錯（kubectl set env，滾動更新完成）
    第 117 秒 ShopJobHigh5xxRatio{order-service} pending
    第 420 秒 ShopJobHigh5xxRatio{order-service} firing
    第 450 秒 ── 權重改回 100／0（灰度的回滾）
    第 511 秒 ShopJobHigh5xxRatio{order-service} 解除
  下單：[201=1984, 503=63]；商品頁：{200=18415, 429=1}；下單的兩邊各算各的 —— 單體 1,964 張、5xx 0.0%、超過 500 ms 0.2%、平均 43 ms │ 訂單服務 63 張、5xx 100.0%、超過 500 ms 1.6%、平均 59 ms
  壞掉之後（第 72 秒起）的下單：[201=1449, 503=63]
  firing 的那一刻，5 分鐘窗的 5xx 比例（/api/**）：order-service 8.92%、全站 0.45%
  firing：壞掉之後 348 秒；解除：回滾之後 61 秒
  （結束時 load { 8.11 7.24 8.19 }）
```

- **`ShopJobHigh5xxRatio{order-service}` 在壞掉的那一版換上去（第 72 秒）之後 348 秒 firing**：45 秒後進 pending（1 分鐘窗、5 分鐘窗都過了 1%），再等 `for: 5m`。那一刻訂單服務自己的 5xx 是 8.92%，全站 0.45%：**`ShopHigh5xxRatio` 從頭到尾沒有進過 pending** —— 9.5.2 說的稀釋，在真的 cluster 上一樣。
- **權重改回 100／0 之後 61 秒解除**：1 分鐘窗沒有新的 5xx 了。
- **開頭的 `ShopServiceGone{inventory-service-next}`** 是上一個實驗（9.6.7 的 M8）留下的：它抄出來的那一組庫存服務，`app` 標籤是 `inventory-service-next`，Prometheus 拿它當 job；M8 結束時刪掉那一組，這條「15 分鐘內看過、現在一台都沒有」的告警就在 31 秒後 firing（`severity: page`）。這是藍綠切換的一個代價，寫在 9.6.7。

**同一個實驗的第一次是 397 秒**：進了 pending，15 秒之後又解除，再過 15 秒才重新開始數 `for: 5m`：

```
    第  76 秒 ── 訂單服務的 SHOP_INVENTORY_URL 指錯（kubectl set env，滾動更新完成）
    第 152 秒 ShopJobHigh5xxRatio{order-service} pending
    第 167 秒 ShopJobHigh5xxRatio{order-service} 解除
    第 182 秒 ShopJobHigh5xxRatio{order-service} pending
    第 473 秒 ShopJobHigh5xxRatio{order-service} firing
    第 503 秒 ── 權重改回 100／0（灰度的回滾）
    第 564 秒 ShopJobHigh5xxRatio{order-service} 解除
```

事後去查 Prometheus（沒有寫進實驗）：5 分鐘窗的比例在那幾點是 1.14% → 0.91% → 1.16%。新的那一邊每秒只分到兩個請求，5 分鐘窗剛跨過 1% 的時候，差幾個請求就掉回去 —— 分到的流量越少，「剛跨過門檻」的那一段越抖，同一個事故響的時間差了快一分鐘。

### 9.5.3 雙跑比對：`Shop-Route`

權重還是 0 的時候，新的那一邊一個請求都收不到 —— 那怎麼在灰度之前先確定它的回應是對的？入口多兩條規則：帶著 `Shop-Route: order-service` 的請求，不看權重，直接送給訂單服務；`Shop-Route: monolith` 送給單體。

```yaml
# 買家、賣家、管理員、金流的回呼：都是 /api/**。庫存服務沒有對外的路由（/internal/** 只給訂單服務）
# 13 站第 09 章：遷移期間，/api/** 有兩個去處 —— 單體與訂單服務，各帶一個權重（Gateway API：一條規則好幾個 backend，照權重分）。
# 權重是相對的：100 與 0 = 全部給單體。灰度就是改這兩個數字
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: shop-api
spec:
  parentRefs: [{name: shop}]
  rules:
    - matches: [{path: {type: PathPrefix, value: /api}}]
      backendRefs:
        - {name: monolith, port: 8080, weight: 100}
        - {name: order-service, port: 8080, weight: 0}
    # 13 站 9.5.3：帶著 Shop-Route 的請求不看權重，直接去指定的那一邊 —— 權重還是 0 的時候，內部的人先試新的路、值班的人打它的管理 API、
    # 同一個請求兩邊各送一次比結果（雙跑比對）。條件比上面那一條多一個 header，Gateway API 的規則是條件多的優先。
    # 誰都可以帶這個 header：遷移期間兩條路都是正式的，所以可以接受；新的路還不能給外人用的話，要在入口驗證是誰
    - matches: [{path: {type: PathPrefix, value: /api}, headers: [{name: Shop-Route, value: order-service}]}]
      backendRefs: [{name: order-service, port: 8080}]
    - matches: [{path: {type: PathPrefix, value: /api}, headers: [{name: Shop-Route, value: monolith}]}]
      backendRefs: [{name: monolith, port: 8080}]
```

Gateway API 的規則：路徑一樣的時候，header 條件多的那一條優先。它有三個用途：

- **內部的人先試新的路**（權重還是 0）。
- **值班的人打新的那一邊的管理 API**（第 05 章的重建副本只在訂單服務的角色裡，送到單體會是 404）。
- **雙跑比對**：同一個讀的請求，兩邊各送一次，比回應。

M2 的第一段做的就是第三件 —— 20 個商品頁、買家的訂單列表、3 張訂單的詳情，兩邊各送一次：

```
  ⓪ 權重 0，Shop-Route 兩邊各送一次（雙跑比對）：24 個讀的請求，回應一樣 24 個；不一樣的欄位 {}
  ① 權重一段一段往上，每一段 30 秒
```

24 個讀的請求，兩邊的回應一模一樣 —— 包括 9.4.4 那一次不一樣的 `available`：訂單服務起來的時候先重建了副本，重建完才 ready。

雙跑比對只適合**讀**。寫的請求送兩次就是兩張訂單 —— 有冪等鍵也只是讓第二次回同一張，比不出「新的那一邊會怎麼做」。寫的那一邊，靠的是 9.5.2 的兩邊各算各的，與 9.5.6 的不變量。

`Shop-Route` 誰都可以帶：一個買家知道了這個 header，就可以自己挑一邊。遷移期間兩條路都是正式的、做的是同一件事，所以這裡接受它；新的路如果還不能給外面的人用，要在入口驗證是誰（例如只收內部網段、或驗一個內部的 token）。它是過渡架構，9.8 拆掉。

### 9.5.4 同一個人來回兩邊

權重 50／50 的時候，同一個買家連續兩個請求，可能一個到單體、一個到訂單服務。它們寫的是同一個庫，但**讀的不一定是同一個東西**：單體的商品頁直接讀庫存的表，訂單服務讀自己的副本（第 05 章 5.5：副本晚幾十到幾百毫秒）。

M3：5 個商品被持續下單（每秒 10 張），10 個人各盯一個商品、每 400 ms 看一次，各 30 秒。可售量只會往下掉（沒有人取消、沒有人補貨）—— 如果一個人看到它**變多**，就是先讀到新的、再讀到舊的：

```
═══ 9.5.4 同一個人來回兩邊：權重 50／50；5 個商品每秒共 10 張下單，10 個人各盯一個商品、每 400 ms 看一次 ═══
  ① 沒有黏性：讀 720 次（失敗 0）；可售量倒退 140 次（19.4%），10 個人裡 10 個看過倒退，最多倒退 12 件
  ② sessionPersistence（cookie）：讀 730 次（失敗 0）；可售量倒退 0 次（0.0%），10 個人裡 0 個看過倒退，最多倒退 0 件
     黏在哪裡（cookie 解出來的位址）：{monolith=6, order-service=4}；其中一個 cookie 解開的位元組：0a 10 31 30 2e 32 34 34 2e 30 2e 33 36 3a 38 30 38 30
  ③ 黏著的時候回滾（權重 100／0，等 3 秒）：之後 20 秒 讀 490 次（失敗 0）；可售量倒退 0 次（0.0%），10 個人裡 0 個看過倒退，最多倒退 0 件；訂單服務收到的商品頁 0 個（等的那 3 秒 0 個）
     這段時間的下單 [201=882]
  （結束時 load { 5.30 6.21 7.13 }）
```

- **① 沒有黏性**：720 次讀，可售量倒退 140 次（19.4%），10 個人全部看過，最多一次倒退 12 件。單體讀的是現在的值，訂單服務讀的是副本：一個人上一次被送到單體、這一次被送到訂單服務，就會看到它「變多」。
- **② cookie**：`HTTPRoute` 的 `sessionPersistence`（Gateway API 的 experimental channel 才有；Envoy Gateway 1.9.1 的安裝檔帶的就是那一份）。第一次的回應帶一個 `shop-backend` cookie，之後同一個人送到同一台：10 個人裡 6 個黏在單體、4 個黏在訂單服務，**倒退 0 次** —— 每一個人看到的都只有一種讀法。
- **cookie 裡是什麼**：Envoy 的 stateful session 文件說，回應時把「被選中的上游的位址」存進 cookie（<https://www.envoyproxy.io/docs/envoy/latest/configuration/http/http_filters/stateful_session_filter>）；格式文件沒有寫。解開的位元組是 `0a 10` 加上 `10.244.0.36:8080`（16 個字）—— 推論是 protobuf 的一個字串欄位。M3 第一版把整串當成位址去對 pod 的 IP，一個都對不上。
- **③ 黏著的時候回滾**：同一份文件：cookie 指到的那一台「exists in the upstream cluster」才送過去，不在就照一般的負載平衡挑。權重 0 的那一邊不在 cluster 裡（9.5.1），所以黏在訂單服務的那 4 個人，在權重改掉的那一刻就回到單體 —— 訂單服務連等的那 3 秒都沒有收到商品頁。**黏性不會擋住回滾。**
- `sessionPersistence` 是用 `kubectl patch` 加上去的，實驗最後用反向的 JSON patch 拿掉：`kubectl apply` 不會拿掉 patch 加上去的欄位（第 08 章 8.7.1 的同一件事）。

這一節的倒退，換成「剛下單的買家看自己的訂單」也會發生嗎？推論是不會（沒有量）：訂單在兩邊讀的是同一張表。會倒退的，只有一邊讀副本、一邊讀正本的那幾個頁面 —— 灰度之前，先列出新的路上有哪些讀是讀副本的。

### 9.5.5 回滾：改兩個數字

灰度的回滾，是把權重改回去。M2 在權重 100 的時候，負載不停，把它改成 100／0：

```
  ② 回滾：第 10.3 秒把權重改成 100／0（kubectl patch 花 66 ms）；訂單服務最後一次收到下單在切換之後 0.3 秒內
     切換之前 10 秒：下單 [201=104]；切換之後 20 秒：下單 [201=197]
     權重 100／0 之後入口的 Envoy 的設定（訂單服務的 pod 還在）：cluster httproute/shop/shop-api/rule/0：backend 0 權重 100 [10.244.0.31]
```

`kubectl patch` 66 ms；之後每 250 ms 問一次訂單服務的計數器（經過 API server，問一次本身就要幾百毫秒），最後一次看到它增加是切換之後 0.3 秒內。切換前後 30 秒，301 張全部 201：入口把新的請求送去單體，已經在訂單服務那邊的請求照樣做完。

最後一行是切換之後 Envoy 的設定：訂單服務的 pod 都還在，那一個 locality 已經不在 cluster 裡了。

### 9.5.6 賣到完：兩條路、一個庫

最後，用 9.2 的同一個負載再跑一次：20 個商品、各 20 件，每秒 10 張、60 秒 —— 只是這一次兩條路寫同一個庫，權重 50／50：

```
  ④ 賣到完：20 個商品各 20 件（共 400 件），權重 50／50，每秒 10 張、60 秒
     下單 [201=400, 409=201]；單體收到 301 張、訂單服務 300 張；賣出 400 件；賣超過 20 件的商品 0 個
     還在等付款、找不到自己的預留的訂單 0 張；INV-2（reserved 與預留加總對不上的商品）0 個
```

**賣出 400 件，一件不多**；兩邊各收到一半的下單（301／300 張）；找不到預留的訂單 0 張；第 12 站的 INV-2（`reserved` 等於還佔著的預留加總）0 個商品對不上。

跟 9.2 只差一件事：兩條路寫同一個庫。超賣靠的是第 12 站就有的那一道 —— 同一列的條件式 `UPDATE` 與 `CHECK` —— 而它只在**同一個庫**裡成立。

M2 最後一行的 ERROR 日誌是訂單編號撞號（第 12 站 2.4.4：台北日期加隨機 6 碼，撞到唯一索引就重試），那一張照樣成立了。

### 9.5.7 追記：依使用者分群的灰度

📌 **第 09 章寫完之後補的。** 9.5 的灰度有兩種分法：入口的權重（每一個請求挑一次，9.5.1）與 cookie 的黏性（同一個瀏覽器，9.5.4）。常見的第三種是**照使用者**：「先讓兩成的會員用新的」—— 同一個人不管換了幾台裝置，都在同一邊；出事的時候，受影響的是哪些人也說得出來。

入口（Envoy Gateway）做得到，要它先**驗買家的 token**：SecurityPolicy 的 JWT 驗證，把 `sub`（使用者的 id）抄到一個 header，`HTTPRoute` 多一條規則照這個 header 挑一邊。結尾是 0 或 1 的人（兩成）去訂單服務，其他人、沒有登入的請求照權重（100／0：都在單體）：

```yaml
# 13 站第 09 章寫完之後的追記（9.5.7）：依使用者分群的灰度 —— 入口驗買家的 token，把 sub（使用者的 id）抄到 x-shop-user，
# HTTPRoute 的一條規則照這個 header 挑一邊（M10UserCanaryTest 加上去、拿掉）。
#   optional：沒有 token 的請求照樣過（商品頁、金流的回呼）；有 token 但驗不過的，入口直接回 401（應用程式看不到它）
#   recomputeRoute：header 是驗完 token 才有的，路由要重新挑一次（Envoy Gateway 的說明：claimToHeaders 拿來選路由時要開）
#   localJWKS：HS256 的金鑰（第 12 站 5.5.1、第 03 章 3.6.1）—— 入口要驗，就得拿到簽發 token 的同一把；Envoy Gateway 只能從 ConfigMap 讀，
#              不是 Secret。實驗用 kubectl create configmap shop-jwks 從 k8s/kind/secrets.env 產生，不放進 repo
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: SecurityPolicy
metadata:
  name: shop-user
  namespace: shop
spec:
  targetRefs:
    - {group: gateway.networking.k8s.io, kind: HTTPRoute, name: shop-api}
  jwt:
    optional: true
    providers:
      - name: shop
        issuer: shop
        localJWKS:
          type: ValueRef
          valueRef: {group: "", kind: ConfigMap, name: shop-jwks}
        claimToHeaders:
          - {claim: sub, header: x-shop-user}
        recomputeRoute: true
```

```java
    static final String RULE = "{\"matches\":[{\"path\":{\"type\":\"PathPrefix\",\"value\":\"/api\"},\"headers\":[{\"name\":\"x-shop-user\",\"type\":\"RegularExpression\","
            + "\"value\":\"^[0-9]*[01]$\"}]}],\"backendRefs\":[{\"name\":\"order-service\",\"port\":8080}]}";
```

M10 把它套上去、量、再拿掉：

```bash
mvn test -Pexperiments -Dtest=M10UserCanaryTest
```

```
═══ 9.5.7 依使用者分群：入口驗 token、sub → x-shop-user；結尾 0、1 的人去訂單服務，其他照權重（100／0）═══
  SecurityPolicy、規則套上之後 3.1 秒，第一個結尾 0 的人被送到訂單服務
  ① 20 個買家（結尾 0、1 的 4 個）各看 5 次自己的訂單：GET /api/orders 單體 80 個、訂單服務 20 個
  ② 沒有登入的商品頁 20 次：單體 20 個、訂單服務 0 個
  ③ 同一個人一直讀（每秒 10 張下單在那 5 個商品上）：讀 663 次（失敗 0）；可售量倒退 0 次
     這段時間的下單 [201=303]
  ④ 自己帶 x-shop-user：沒有 token、帶 9800010 → order-service；結尾 2 的人的 token、帶 9800010 → monolith；結尾 0 的人的 token、帶 9800012 → order-service
  ⑤ 壞的 token（GET /api/orders）：套上之前，過期 10 分鐘 → 401（WWW-Authenticate: Bearer error="invalid_token"；Content-Type: application/problem+json;charset=UTF-8）{"type":"/problems/unauthenticated","title":"需要登入","status":401,"detail":"token 無效或已過期","i…
     套上之後：簽章不對 → 401（WWW-Authenticate: Bearer realm="http://127.0.0.1:18880/api/orders", error="invalid_token"；Content-Type: text/plain）Jwt verification fails；過期 10 分鐘 → 401（WWW-Authenticate: Bearer realm="http://127.0.0.1:18880/api/orders", error="invalid_token"；Content-Type: text/plain）Jwt is expired；同一個過期的 token 帶 Shop-Route: monolith → 401（WWW-Authenticate: Bearer realm="http://127.0.0.1:18880/api/orders", error="invalid_token"；Content-Type: text/plain）Jwt is expired
  ⑥ 回滾（拿掉那一條規則）：0.4 秒後，結尾 0 的人回到單體
  （結束時 load { 11.73 9.12 8.84 }）
```

- **套上 3.1 秒生效、拿掉 0.4 秒回來**：跟改權重一樣是入口的設定（9.5.1），不用部署。
- **① 分的是人，不是請求**：結尾 0、1 的 4 個買家的每一次都在訂單服務，其他 16 個的每一次都在單體（訂單服務 20 個 = 4 人 × 5 次，單體 80 個）。② 沒有登入的請求沒有 `sub`，照權重走。
- **③ 同一個人不會來回**：一直讀自己剛下單的那幾個商品，663 次裡可售量倒退 0 次 —— 9.5.4 的 cookie 黏性要的是同一件事，這裡換了裝置也成立。
- **④ header 抄的是 token 裡的 `sub`**：有 token 的人自己帶 `x-shop-user`，被 token 蓋掉（結尾 2 的人帶結尾 0 的號碼 → 還是單體）。**沒有 token 的請求自己帶，會被送到訂單服務** —— 跟 9.5.3 的 `Shop-Route` 是同一條旁路（誰都可以挑一邊，9.8 的表裡它要在收尾時拿掉）。要擋，可以用 ClientTrafficPolicy 的 `earlyRequestHeaders` 在路由之前先刪掉這個 header（Envoy Gateway 1.9.1 的原始碼：它變成 Envoy 的 early header mutation，在路由與每一個 filter 之前）—— 沒有做。
- **⑤ 代價：入口開始驗 token。** 簽章不對、過期的 token，入口自己回 401（純文字的 `Jwt verification fails`、`Jwt is expired`），請求到不了應用程式 —— 連帶 `Shop-Route: monolith` 的也一樣。套上之前，過期的 token 是應用程式回的 401（`application/problem+json`、「token 無效或已過期」）。401 的格式從此有兩種。**更大的代價是金鑰**：買家的 token 是 HS256（第 12 站 5.5.1），入口要驗，就得拿到**簽 token 的同一把**；Envoy Gateway 1.9.1 的 localJWKS 只能寫在設定裡或從 ConfigMap 讀（API 的定義：`Inline` 或 ConfigMap 的 `valueRef`），不是 Secret —— 讀得到那個 ConfigMap 的人，就簽得出任何一個買家的 token。M10 量完就刪掉它；要正式用，先換成非對稱的金鑰，入口只拿驗證用的那一半 —— 這一站沒有做（第 03 章開頭的「HS256 的共用金鑰」是服務 token 的同一件事）。
- **沒有做的**：這裡的「兩成」是號碼的結尾，不是隨機也不是名單；要照名單或照百分比（例如 `sub` 的 hash），要在發 token 的時候寫進一個 claim，或在入口寫 Lua／外部授權 —— 都沒有試。

> ⚠️ **M10 的第一次，① 只有 83 個。** 20 個買家各看 5 次，一個接一個送：訂單服務 20 個、單體 63 個，少了 17 個。數的是兩邊的 `http_server_requests{uri="/api/orders"}`；推論是「每個 IP 每秒 50 次」（第 12 站 6.7.2）—— 被限流的請求在 filter 就回了 429，不算在那個 uri 裡（那一版沒有記每一個請求的狀態碼）。9.4.6 的 M7 第一次是同一個錯，我在這裡又犯了一次。改成每一個請求之後停一下，上面是改過之後的那一次。第一次的那一行：
>
> ```
>   ① 20 個買家（結尾 0、1 的 4 個）各看 5 次自己的訂單：GET /api/orders 單體 63 個、訂單服務 20 個
> ```

### 9.5.8 追記：兩個服務的部署順序 —— 擴充、遷移、收縮

📌 **第 09 章寫完之後補的。** 第 03 章 3.8.6 的追記讓 can-i-deploy 說出第 04 章那一版的兩個服務「哪一個都不能先上」：庫存服務的契約要 `order.rejected`（線上的訂單服務送不出來），訂單服務要 `/shippable`（線上的庫存服務沒有）—— 兩個服務互為對方的提供端，一個方向是 HTTP、另一個方向是事件。那一節也寫了解開它的三步 ——「擴充、遷移、收縮（3.8.5 的表），這一次是跨兩個服務、兩個方向」—— 並說「那是第 09 章『新舊版本並存、灰度、回滾』的題目」。第 09 章沒有做；這裡照那三步走一次。

三步：

1. **擴充：先上一版庫存服務**（`aecf152`）。它有 `/shippable`、處理 `order.rejected` 的程式碼也在 —— 只是**契約裡先不要求** `order.rejected`。
2. **遷移：再上訂單服務**（`9933bd9`）：它要的 `/shippable`，線上的庫存服務（`aecf152`）有了。
3. **收縮：最後上完整的庫存服務**（`9933bd9`）：契約要求 `order.rejected`，線上的訂單服務送得出來了。

擴充的那一版，是從第 04 章那一版（`9933bd9`）改一個測試檔 —— 契約是消費者的測試寫出來的（第 03 章 3.8.6）：

```diff
         verify(inventory).consume(7001L);
     }
 
-    @Pact(consumer = "inventory-service")
-    V4Pact rejected(MessagePactBuilder b) {
-        return b.expectsToReceive("order.rejected：熱點品項過了閘門、預留失敗")
-                .withContent(new PactDslJsonBody().integerType("orderId", 7001)
-                        .minArrayLike("hotLines", 1).integerType("productId", 9005).integerType("quantity", 1).closeObject().closeArray())
-                .toPact(V4Pact.class);
-    }
-
-    @Test @PactTestFor(pactMethod = "rejected")
-    void rejected(V4Interaction.AsynchronousMessage m) throws Exception {
-        handle(new InventoryEventHandlers().orderEvents(inventory), "order.rejected", m);
-        verify(inventory).releaseRejected(7001L, List.of(new ReserveLine(9005, 1)));
-    }
+    // 13 站第 09 章寫完之後的追記（9.5.8）：擴充的那一版 —— 處理 order.rejected 的程式碼還在（InventoryEventHandlers），契約裡先不要求它：
+    // 線上的訂單服務（第 03 章那一版）送不出這一則。訂單服務換成會送它的那一版之後，下一版的庫存服務才把它加回契約（收縮）
 
     @Pact(consumer = "inventory-service")
     V4Pact productCreated(MessagePactBuilder b) {
```

每一步照第 03 章 3.8.6 的流程：發布契約、兩個提供端各驗證一次（線上那一版的提供端，用第 03 章的程式碼加上驗證用的四個測試類別 —— 3.8.6 的做法）、問 can-i-deploy、部署了就記下來。broker 清空重來，先放進線上的那一版（`3dc04d0`）；第 ⓪ 段是 3.8.6 的那一次，再跑一次（紀錄濾過，只留每一步的版本、驗證的結果與 can-i-deploy）：

```
════ broker：清空重來，線上那一版 3dc04d0
Created order-service version 3dc04d0 with branch d03
Recorded deployment of order-service version 3dc04d0 to production environment in the Pact Broker.
Recorded deployment of inventory-service version 3dc04d0 to production environment in the Pact Broker.
════ ⓪ 直接上第 04 章那一版（9933bd9）：3.8.6 的結果
Created inventory-service version 9933bd9 with branch d04
Created order-service version 9933bd9 with branch d04
Tests run: 32, Failures: 0, Errors: 0, Skipped: 0 -- in com.example.shop.inventory.internal.web.InventoryProviderBrokerIT
Tests run: 6, Failures: 0, Errors: 0, Skipped: 0 -- in com.example.shop.ordering.internal.OrderEventsProviderBrokerIT
Tests run: 6, Failures: 1, Errors: 0, Skipped: 0 -- in com.example.shop.ordering.internal.OrderEventsProviderBrokerIT
Tests run: 32, Failures: 4, Errors: 1, Skipped: 0 -- in com.example.shop.inventory.internal.web.InventoryProviderBrokerIT
  InventoryProviderBrokerIT>InventoryProviderContract.verify:70 Pact between order-service (9933bd9) and inventory-service - Upon 出貨之前：可以出貨 
  InventoryProviderBrokerIT>InventoryProviderContract.verify:70 Pact between order-service (9933bd9) and inventory-service - Upon 出貨之前：熱點還在落帳 
  InventoryProviderBrokerIT.verify(PactVerificationContext, HttpRequest)[31] Provider state change callback failed
  InventoryProviderBrokerIT.verify(PactVerificationContext, HttpRequest)[32] Provider state change callback failed
  OrderEventsProviderBrokerIT>OrderEventsProviderContract.verify:36 Pact between inventory-service (9933bd9) and order-service - Generates message 'order.rejected：熱點品項過了閘門、預留失敗'  
  InventoryProviderBrokerIT.verify(PactVerificationContext, HttpRequest)[16] » UnsupportedOperation No test target has been configured for AsynchronousMessage interactions
Computer says no ¯\_(ツ)_/¯
CONSUMER          | C.VERSION | PROVIDER          | P.VERSION | SUCCESS? | RESULT#
inventory-service | 9933bd9   | order-service     | 3dc04d0   | false    | 1      
order-service     | 3dc04d0   | inventory-service | 9933bd9   | true     | 2      
The verification for the pact between version 9933bd9 of inventory-service and the version of order-service currently in production (3dc04d0) failed
Computer says no ¯\_(ツ)_/¯
CONSUMER      | C.VERSION | PROVIDER          | P.VERSION | SUCCESS? | RESULT#
order-service | 9933bd9   | inventory-service | 3dc04d0   | false    | 1      
The verification for the pact between version 9933bd9 of order-service and the version of inventory-service currently in production (3dc04d0) failed
════ ① 擴充：庫存服務 aecf152（有 /shippable、處理 order.rejected 的程式碼；契約不要求 order.rejected）
Created inventory-service version aecf152 with branch d04
Created order-service version aecf152 with branch d04
Tests run: 32, Failures: 0, Errors: 0, Skipped: 0 -- in com.example.shop.inventory.internal.web.InventoryProviderBrokerIT
Tests run: 5, Failures: 0, Errors: 0, Skipped: 0 -- in com.example.shop.ordering.internal.OrderEventsProviderBrokerIT
Computer says yes \o/ 
CONSUMER          | C.VERSION | PROVIDER          | P.VERSION | SUCCESS? | RESULT#
inventory-service | aecf152   | order-service     | 3dc04d0   | true     | 1      
order-service     | 3dc04d0   | inventory-service | aecf152   | true     | 2      
All required verification results are published and successful
Recorded deployment of inventory-service version aecf152 to production environment in the Pact Broker.
════ ② 遷移：訂單服務 9933bd9（用 /shippable、送 order.rejected）
Tests run: 32, Failures: 0, Errors: 0, Skipped: 0 -- in com.example.shop.inventory.internal.web.InventoryProviderBrokerIT
Tests run: 5, Failures: 0, Errors: 0, Skipped: 0 -- in com.example.shop.ordering.internal.OrderEventsProviderBrokerIT
Computer says yes \o/ 
CONSUMER          | C.VERSION | PROVIDER          | P.VERSION | SUCCESS? | RESULT#
inventory-service | aecf152   | order-service     | 9933bd9   | true     | 1      
order-service     | 9933bd9   | inventory-service | aecf152   | true     | 2      
All required verification results are published and successful
Recorded deployment of order-service version 9933bd9 to production environment in the Pact Broker.
════ ③ 收縮：庫存服務 9933bd9（契約要求 order.rejected）
Tests run: 17, Failures: 0, Errors: 0, Skipped: 0 -- in com.example.shop.inventory.internal.web.InventoryProviderBrokerIT
Computer says yes \o/ 
CONSUMER          | C.VERSION | PROVIDER          | P.VERSION | SUCCESS? | RESULT#
inventory-service | 9933bd9   | order-service     | 9933bd9   | true     | 1      
order-service     | 9933bd9   | inventory-service | 9933bd9   | true     | 2      
All required verification results are published and successful
Recorded deployment of inventory-service version 9933bd9 to production environment in the Pact Broker.
════ 結束
```

- **⓪ 直接上第 04 章那一版**：跟 3.8.6 一樣，兩個都是 no。兩行 `<<< FAILURE` 是線上那一版（`3dc04d0`）當提供端：訂單服務驗不過庫存服務的新契約（`order.rejected` 送不出來）；庫存服務驗不過訂單服務的新契約 —— `/shippable` 的兩則、它不認得的兩個 provider state，以及一則它沒有設定驗證方式的事件。
- **① 擴充**：庫存服務 `aecf152` 當消費者，它的契約（少了 `order.rejected`）線上的訂單服務驗得過；當提供端，線上那一版訂單服務的契約它也驗得過 —— **yes**。部署、記下來。
- **② 遷移**：訂單服務 `9933bd9` 要的 `/shippable`，線上的庫存服務（`aecf152`）驗得過；它自己送的事件，線上的庫存服務的契約（5 則）也驗得過 —— **yes**。
- **③ 收縮**：完整的庫存服務 `9933bd9`：它要的 `order.rejected`，線上的訂單服務（`9933bd9`）送得出來 —— **yes**。

跟 5.7.9 的 `products.hot` 是同一個形狀，只是這一次的「欄位」是契約裡的一則事件，「兩次部署」變成「三次、兩個服務輪流」。順序是 broker 算的：每一步只問「線上的對方接不接得住我」，不需要有人記得「這一次誰要先上」。

**沒有做的**：這一節只有契約。兩版的程式同時跑（例如 ② 之後、③ 之前，線上的庫存服務收到 `order.rejected`、而它的契約說不需要 —— 它還是會處理，因為程式碼在）沒有在 kind 上跑過；第 04 章開頭的「新舊版本並存沒有真的跑過」，仍然只做到契約。

---

## 9.6 資料最後搬

### 9.6.1 單體先退場

灰度做到 100% 之後，單體一個請求都收不到了 —— 可是它**還在寫**：它的消費者還在收佇列（每一個佇列，9.4.1）、它的排程還在跑（逾時取消、對帳……）。庫存的五張表只要還有兩個行程在寫，搬資料的時候就有兩條路要追。所以搬資料之前，單體先縮到 0：庫存的表只剩庫存服務在寫，搬家程式只要追一個寫入者的變更。

這一步的回頭路還很便宜：單體起來、權重改回去 —— 資料還在單體的庫。

### 9.6.2 搬家程式：第 02 章的那一個

M4 用的就是第 02 章 2.8.4 的 `Copier`：在單體的庫裝 trigger 與變更紀錄、整張表回填、照著變更紀錄追（每一個主鍵再讀一次現在的那一列、整列寫過去；號碼的洞，2.8.4 的 ⚠️）。新的庫先用 Flyway 跑庫存與 shared 兩個資料夾（第 02 章 2.4.2）。下單從頭到尾不停，每秒 10 張：

```
═══ 9.6 資料最後搬：下單全部走訂單服務，單體縮到 0；庫存的五張表還在 shop_d09_mono，只有庫存服務在寫。每秒 10 張下單，從頭到尾不停 ═══
  ① ② 第 1 秒：新的庫跑完庫存與 shared 的 migration；搬家程式回填 1,422 列、開始追
     第 1 秒追上了：回填完的時候落後 6 筆、現在 0 筆
```

### 9.6.3 遷移期的兩套資料怎麼對帳

從回填完到切換的那一刻，兩個庫同時存在、而且**一直在變**。第 02 章的核對（整張表的列數＋CRC32 加總）是停寫之後做的；這段時間比整張表，永遠不一樣 —— 搬家程式總是落後幾百毫秒。可是這段時間正是最需要知道「新的庫對不對」的時候：有錯，要在切換之前發現，不是之後。

`Verifier` 把「一直在變」與「真的不一樣」分開：

```java
/**
 * 13 站 9.6.3：遷移期間的對帳 —— 兩個庫一邊被寫、一邊比。
 *
 * 第 02 章 2.8 的核對（Copier.differences）在停寫之後做：整張表的列數＋CRC32 加總，只說「不一樣」。遷移期間兩邊一直在動，
 * 搬家程式總是落後一點，整張表比永遠不一樣。所以：
 *   ① 依主鍵切段（每段 CHUNK 個主鍵），兩邊各算一段的列數＋CRC32 加總
 *   ② 不一樣的段，等一下再比 —— 搬家程式追上了就一樣了。連續 RECHECKS 次都不一樣，才算「真的不一樣」
 *   ③ 真的不一樣的段，逐列比（兩邊各算每一列的 CRC32）—— 列也一樣：連續 RECHECKS 次都不一樣的那幾列，才報出來
 * 兩邊各自算，不跨庫 JOIN（真的搬家時兩個庫在兩台機器上，第 02 章 2.8.1）。
 *
 * 第一版只有段要連續幾次不一樣，逐列只比一次（M4 第一次）：
 *   帳（inventory_ledger）最尾巴的那一段一直有新的列進來，任何一刻都有一兩列還在路上 —— 段連續 3 次都不一樣，逐列比出來的是那一刻最新的一筆帳
 *   inventory 的 1,000 個商品全在同一段、一直有人在下單：故意弄壞的那一列抓到了，同一段裡正在被下單的兩個商品也一起被報出來
 * 改成逐列也要連續幾次「同一列都不一樣」才報；段也切小成 200 個主鍵
 */
```

```java
                if (chunk(a, t, pk, from, to).equals(chunk(b, t, pk, from, to))) continue;
                first++;
                boolean same = false;
                for (int i = 0; i < RECHECKS && !same; i++) {
                    Thread.sleep(WAIT_MS);
                    same = chunk(a, t, pk, from, to).equals(chunk(b, t, pk, from, to));
                }
                if (same) continue;
                java.util.Set<Long> suspects = null;
                for (int i = 0; i <= RECHECKS && (suspects == null || !suspects.isEmpty()); i++) {
                    if (i > 0) Thread.sleep(WAIT_MS);
                    Map<Long, Long> x = rows(a, t, pk, from, to), y = rows(b, t, pk, from, to);
                    java.util.Set<Long> now = new java.util.TreeSet<>();
                    for (long id = from; id < to; id++) if (!java.util.Objects.equals(x.get(id), y.get(id))) now.add(id);
                    if (suspects == null) suspects = now; else suspects.retainAll(now);
                }
                if (suspects.isEmpty()) continue;
                persistent++;
                for (long id : suspects) rows.add(t + ":" + id);
```

M4 的第 ③～④ 段：先比兩輪；然後**故意弄壞新的庫的一列**（`inventory` 的一個沒有人在買的商品，`on_hand` 多 1 —— 模擬搬家程式的一個 bug），看它抓不抓得到、怎麼修：

```
  ③ 邊寫邊比（第 1 輪，第 1 秒）：比了 11 段：第一次不一樣 1 段、再比 3 次還是不一樣 0 段（3,189 ms）
  ③ 邊寫邊比（第 2 輪，第 4 秒）：比了 11 段：第一次不一樣 1 段、再比 3 次還是不一樣 0 段（2,142 ms）
  ④ 新的庫的 inventory 9000051：on_hand 多 1（模擬搬家程式的一個 bug）
     對帳：比了 11 段：第一次不一樣 3 段、再比 3 次還是不一樣 1 段，不一樣的列 [inventory:9000051]（8,245 ms）
     修（在變更紀錄補一筆 inventory 9000051，讓搬家程式再搬一次）之後：比了 11 段：第一次不一樣 2 段、再比 3 次還是不一樣 0 段（4,155 ms）
```

- **兩輪都一樣**：第一次比有 1 段不一樣，等一下再比就一樣了 —— 搬家程式追上了。
- **弄壞一列之後**：第一次有 3 段不一樣，連續再比之後剩 1 段、1 列：`inventory:9000051`，就是弄壞的那一列。這一輪花了 8.2 秒（不一樣的段與列要等著再比）。
- **修好之後**：0 段。

**修的方法是讓搬家程式再搬一次那一列**：在變更紀錄補一筆那個主鍵。不要直接改新的庫 —— 正本只有一個，新的庫是它的副本；修副本的方法，永遠是「再從正本複製一次」。

> ⚠️ **對帳的第一版，報了兩種假的「不一樣」**（M4 第一次）。第一版只要求「段」連續 3 次不一樣，逐列只比一次：
>
> ```
>   ③ 邊寫邊比（第 1 輪，第 1 秒）：比了 5 段：第一次不一樣 2 段、再比 3 次還是不一樣 1 段，不一樣的列 [inventory_ledger:252]（4,153 ms）
>   ③ 邊寫邊比（第 2 輪，第 5 秒）：比了 5 段：第一次不一樣 1 段、再比 3 次還是不一樣 0 段（3,146 ms）
>   ④ 新的庫的 inventory 9000051：on_hand 多 1（模擬搬家程式的一個 bug）
>      對帳：比了 5 段：第一次不一樣 2 段、再比 3 次還是不一樣 1 段，不一樣的列 [inventory:9000051, inventory:9000234, inventory:9000380]（4,210 ms）
> ```
>
> - 第 1 輪報的 `inventory_ledger:252`，是那一刻**最新的一筆帳**：帳只會新增，最尾巴那一段一直有新的列進來，任何一刻都有一兩列還在路上 —— 每隔一秒比一次，三次都碰得到「還在路上的那一列」，只是每一次是不同的一列。
> - 弄壞一列之後，那一段（`inventory` 的 1,000 個商品全在同一段）一直有人在下單：弄壞的那一列抓到了，同一段裡兩個正在被下單的商品也一起被報出來。
>
> 兩種都是「段」一直在變，不是同一列一直錯。改成逐列也要連續幾次**都是同一列**不一樣才報，段也切小成 200 個主鍵。（同時加了「先等搬家程式追上再比」，以為是原因 —— 加上落後的筆數一印，回填完的時候只落後幾筆（最後一輪：6 筆），它不是原因。）

### 9.6.4 不只五張表

第 02 章搬的是庫存的五張表。真的切換的時候，還有兩樣東西屬於庫存服務、卻不在那五張表裡 —— 它們在 `shared` 的兩張表（每個服務的庫各一份，第 02 章 2.4.3）：

- **`processed_messages` 裡庫存的那幾列**：四個消費者（`inventory.hot-settlement`、`inventory.hot-stock-return`、`inventory.order-events`、`inventory.product-created`）處理過哪些事件，還有 HTTP 命令的冪等鍵（第 03 章 3.5.2 的 `Inbox`：`inventory.http.reserve`、`inventory.http.restock`）。不搬，切換之後 broker 重送一則已經處理過的訊息（at-least-once）、或訂單服務帶著同一個冪等鍵重送一個預留，新的庫的表裡沒有它，就再做一次。它們的 `consumer` 都以 `inventory.` 開頭；這張表只保留 7 天（第 12 站 0.6.7），搬的量有上限。
- **`outbox_events` 裡還沒送出去的事件**：只有在**舊的庫切換之後沒有人送**的時候才要搬。往新的庫切的時候不用 —— 單體的庫還有訂單服務的 relay 在讀，它會把庫存留下的那幾則送出去（relay 不分模組，第 03 章 3.7.3）；從新的庫切回來的時候要搬（9.7）—— 庫存服務一離開，新的庫的 outbox 就沒有人讀了。

這兩樣，第 02 章的實驗都碰不到：那時候的單體沒有開消費者與 relay（第 00 章 `SplitLab.common` 的參數）。

### 9.6.5 切換：停寫

`Cutover` 把切換寫成一段程式，9.7 的回滾、9.10 的合併回去用的也是它：

```java
    public static Result run(Copier copier, String toDb, String toRedis, boolean moveOutbox, Kube.Check beforeStart) throws Exception {
        long t0 = System.nanoTime();
        Mig.scale("inventory-service", 0);
        long t1 = System.nanoTime();
        int drained = 0, n;
        while ((n = copier.apply()) > 0) drained += n;
        int holes = copier.closeHoles();
        int dedup = copy(copier.from, copier.to, "SELECT consumer, message_id, processed_at FROM processed_messages WHERE consumer LIKE 'inventory.%'",
                "INSERT IGNORE INTO processed_messages (consumer, message_id, processed_at) VALUES (?, ?, ?)");
        int outbox = !moveOutbox ? 0 : copy(copier.from, copier.to,
                "SELECT event_id, aggregate_type, aggregate_id, event_type, payload, trace_id, created_at, traceparent FROM outbox_events WHERE published_at IS NULL",
                "INSERT IGNORE INTO outbox_events (event_id, aggregate_type, aggregate_id, event_type, payload, trace_id, created_at, traceparent) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
        if (outbox > 0) Mig.sql(copier.from, "UPDATE outbox_events SET published_at = CURRENT_TIMESTAMP(3) WHERE published_at IS NULL");   // 搬過去了：這一邊不要再送
        long t2 = System.nanoTime();
        Map<String, String> diff = copier.differences();
        long t3 = System.nanoTime();
        if (!diff.isEmpty()) {
            Mig.scale("inventory-service", 2);
            throw new IllegalStateException("核對不過，沒有換庫：" + diff);
        }
        if (beforeStart != null) beforeStart.ok();
        Kube.kubectl("patch", "configmap/inventory-service", "--type=merge", "-p",
                "{\"data\":{\"SHOP_DB_NAME\":\"" + toDb + "\",\"SPRING_DATA_REDIS_DATABASE\":\"" + toRedis + "\"}}");
        Mig.scale("inventory-service", 2);
        long t4 = System.nanoTime();
        return new Result((t1 - t0) / 1_000_000, (t2 - t1) / 1_000_000, drained, holes, dedup, outbox, diff, (t3 - t2) / 1_000_000, (t4 - t3) / 1_000_000);
    }
```

**停寫 = 庫存服務縮到 0。** 它的 pod 都結束了，連線就斷了，MySQL 會 rollback 它還沒 commit 的交易 —— 所以變更紀錄剩下的洞都是 rollback，可以直接關掉（第 02 章 2.8.4 要先查 `innodb_trx`，因為那時候寫入的單體還活著；這裡訂單服務還在寫訂單，`innodb_trx` 不會是 0，但它不寫庫存的表）。

```
  ⑤ 切換（第 20～44 秒）：停寫 24.3 秒 = 縮到 0 13.4 秒 ＋ 追完 366 筆變更、關掉 0 個洞 77 ms ＋ 搬去重紀錄 1,025 列、還沒送出的事件 0 則、核對 22 ms（不一樣的表：沒有）＋ 換設定、起來 10.8 秒
     切換之前 10 秒：下單 [201=100]；停寫的那 24.3 秒：下單 [201=121, 503=122]；起來之後 10 秒：下單 [201=60, 503=40]
     停寫的那一段，每 5 秒：20～25 秒 [201=50]；25～30 秒 [201=50]；30～35 秒 [201=21, 503=29]；35～40 秒 [503=50]；40～45 秒 [503=50]；45～50 秒 [201=17, 503=33]；50～54 秒 [201=43]
```

- **停寫 24.3 秒**，但追完變更、搬共用表的幾列（`processed_messages` 1,025 列；往新的庫切，outbox 不用搬）、核對加起來不到 0.1 秒（77 ms、22 ms）。其他的都是 pod：**縮到 0 花 13.4 秒、新的 pod 起來 10.8 秒**。第 02 章 2.8.4 的停寫是 1.5 秒 —— 那裡停寫只是「單體不接單」，這裡是兩組 pod 的關與起。
- **每 5 秒一格看**：縮到 0 的頭 10 秒，下單照樣 201（50、50）—— 舊的 pod 在 `preStop` 的 10 秒裡還在處理（第 08 章 8.6.4），訂單服務重用的連線還連著它們（第 08 章 8.6.1）。之後大約 15 秒是 503：舊的 JVM 關掉了、新的還沒好。這一段的 122 張 503，是熔斷器與「連不上」回給買家的（M4 結束時訂單服務的 ERROR 日誌：`INVENTORY_UNAVAILABLE op=reserve：送了 N 次都沒有回應：I/O error on PUT` 93 行 —— 切換與回滾兩次停寫加起來）。
- **新的 pod ready 之後，還有大約 4 秒的 503**（起來之後 10 秒：201=60、503=40）。推論：訂單服務的熔斷器在停寫的那一段打開了，第 06 章 6.7 的設定是開 5 秒才試；沒有另外量熔斷器的狀態。
- **探索時的一輪有 1 張 500**，不知道在哪一段（入口的 trace 抽樣 10%，裡面的錯誤 span 都是 503）。最後一輪加了「201、503 以外的狀態碼在哪幾格」與訂單服務的 ERROR 日誌，結果是「沒有」—— 它沒有再出現，原因沒有找到。

📌 **第 09 章寫完之後的追記：那 1 張 500 找到了 —— 搬家程式裝 trigger 的那一刻，跟一個做到一半的預留，metadata lock 的死結。** 探索時的那一輪（切過去、切回來，兩次切換）出了 1 張，沒有記它的內容。M12 把 M4 的切換（縮到 0、換設定、重開）來回做 6 次，每秒 10 張下單不停；每一張不是 201、409、503 的下單記下狀態碼、內容與 traceId，每一個訂單服務、庫存服務的 pod 從起來到結束的日誌都存下來（每秒看一次有沒有新的 pod），事後拿 traceId 去找：

```bash
mvn test -Pexperiments -Dtest=M12FiveHundredTest -Dm12.cycles=6
```

第一次跑，12 次切換、5,382 張下單，不是 201、409、503 的 0 張。最後一輪再跑一次，出現了：

```
═══ 9.6.5 那 1 張 500：M4 的切換（縮到 0、換設定、重開）來回 6 次，每秒 10 張下單不停 ═══
  第 1 次（第 107 秒）：去 停寫 26.0 秒、關掉 0 個洞 ／ 回 停寫 25.1 秒、關掉 0 個洞
  第 2 次（第 194 秒）：去 停寫 29.3 秒、關掉 0 個洞 ／ 回 停寫 27.6 秒、關掉 0 個洞
  第 3 次（第 278 秒）：去 停寫 25.8 秒、關掉 0 個洞 ／ 回 停寫 23.6 秒、關掉 0 個洞
  第 4 次（第 348 秒）：去 停寫 23.4 秒、關掉 2 個洞 ／ 回 停寫 23.3 秒、關掉 0 個洞
  第 5 次（第 417 秒）：去 停寫 23.6 秒、關掉 0 個洞 ／ 回 停寫 22.7 秒、關掉 0 個洞
  第 6 次（第 490 秒）：去 停寫 24.1 秒、關掉 0 個洞 ／ 回 停寫 25.3 秒、關掉 0 個洞
  整段：下單 {201=3003, 500=1, 503=1994}
  不是 201、409、503 的：1 張
    第 288.3 秒 500 {"type":"/problems/internal","title":"系統發生錯誤","status":500,"detail":"系統發生錯誤，請稍後再試","instance":"/api/orders","traceId":"35a1fd81a8889424ea3ac5f3e21552b6"}（traceId 35a1fd81a8889424ea3ac5f3e21552b6）
      日誌：inventory-service-fc5d68959-7zz2r │ ERROR GlobalExceptionHandler：未預期的例外
      日誌：order-service-77b5b94787-fxqwr │ ERROR RemoteInventoryApi：INVENTORY_ERROR op=reserve status=500：{"type":"/problems/internal","title":"系統發生錯誤","status":500,"detail":"系統發生錯誤，請稍後再試","instance":"/internal/inventory/v1/reservations/2162","traceId":"35a1fd81a…
      日誌：order-service-77b5b94787-fxqwr │ ERROR GlobalExceptionHandler：未預期的例外
  每一個 pod 的日誌裡的 ERROR（依 logger 與訊息分組）：{inventory-service GlobalExceptionHandler：未預期的例外=1, order-service GlobalExceptionHandler：未預期的例外=1, order-service RemoteInventoryApi：INVENTORY_ERROR op=reserve status=N：{"type":"/problems/internal","title":"系統發生錯誤=1, order-service RemoteInventoryApi：INVENTORY_UNAVAILABLE op=reserve：送了 N 次都沒有回應：I/O error on PUT request for "http:=558, order-service SqlExceptionHelper：Duplicate entry 'N-N' for key 'orders.uk_orders_order_no'=8}
  （結束時 load { 12.56 11.12 10.82 }）
```

- **第 288.3 秒，一張 500。** 兩邊的日誌用同一個 traceId 串起來：庫存服務記了「未預期的例外」—— M12 存下來的那個 pod 的日誌裡，堆疊是 `CannotAcquireLockException：Deadlock found when trying to get lock; try restarting transaction`，在 `JdbcInventoryService.ledger` ← `reserveCounted`，那一句是 `INSERT INTO inventory_ledger`；訂單服務收到 500，`RemoteInventoryApi.decode` 不認得它（`INVENTORY_ERROR`），買家拿到 500。
- **那一刻在做什麼**：第 3 次在第 278 秒結束，停 10 秒，第 4 次開始 —— 重建新的庫、跑 migration，接著搬家程式在正本上**裝 trigger**（第 02 章 2.8.4 的 `installCapture`：五張表、每張三個 `CREATE TRIGGER`），每秒 10 張的預留照樣在寫那五張表。第 4 次切過去的那一行「關掉 2 個洞」也對得上：死掉的那個交易，前兩句（`UPDATE inventory`、`INSERT inventory_reservations`）已經觸發了剛裝好的 trigger、各寫了一筆變更紀錄，然後整個 rollback —— 號碼留下兩個洞。
- **InnoDB 不知道這件事。** 事後 `SHOW ENGINE INNODB STATUS` 的「最近一次死結」是 10 月 16 日、另一個庫的；`INNODB_METRICS` 的 `lock_deadlocks` 自開機以來 27 次，這一次之後還是 27。InnoDB 偵測到的死結會留下紀錄 —— 這一次不是 InnoDB 的列鎖。
- 其他的 ERROR 都說得出來：預留「送了 N 次都沒有回應」（558 行）是停寫的那一段，買家拿到 503；`Duplicate entry … for key 'orders.uk_orders_order_no'`（8 行）是訂單編號撞號 —— 第 12 站 4.4.4 的「一行嚇人的 ERROR」，換一個號碼重來，那幾張最後都是 201。

**為什麼會死結。** M13 把它拆開量：一個預留的交易 T 做完前兩句停下來，另一條連線 D 對 `inventory_ledger` 下一句 DDL，一秒之後 T 做第三句；每一步看 `performance_schema.metadata_locks`：

```bash
mvn test -Pexperiments -Dtest=M13DdlDeadlockTest        # 只要 compose 的 MySQL
```

```
═══ 9.6.5 那一張 500：預留的交易做到一半，有人對 inventory_ledger 下 DDL ═══
  A M12 的樣子（搬家程式的 trigger 已經裝在 inventory、inventory_reservations；外鍵在）
    T 做完 UPDATE inventory、INSERT inventory_reservations，拿著：d02_changes SHARED_WRITE、inventory SHARED_WRITE、inventory_ledger SHARED_READ、inventory_reservations SHARED_READ、inventory_reservations SHARED_WRITE
    D 送出 1 秒後：還在等；拿著／在等：inventory_ledger EXCLUSIVE（PENDING）、inventory_ledger SHARED_NO_WRITE
    T 的第三句 INSERT inventory_ledger：1213 Deadlock found when trying to get lock; try restarting transaction；D：做完（1029 ms）；InnoDB 的死結計數 27 → 27
  B 沒有 trigger、外鍵在
    T 做完 UPDATE inventory、INSERT inventory_reservations，拿著：inventory SHARED_WRITE、inventory_ledger SHARED_READ、inventory_reservations SHARED_READ、inventory_reservations SHARED_WRITE
    D 送出 1 秒後：還在等；拿著／在等：inventory_ledger EXCLUSIVE（PENDING）、inventory_ledger SHARED_NO_WRITE
    T 的第三句 INSERT inventory_ledger：1213 Deadlock found when trying to get lock; try restarting transaction；D：做完（1029 ms）；InnoDB 的死結計數 27 → 27
  C 有 trigger、inventory_ledger 沒有外鍵
    T 做完 UPDATE inventory、INSERT inventory_reservations，拿著：d02_changes SHARED_WRITE、inventory SHARED_WRITE、inventory_reservations SHARED_READ、inventory_reservations SHARED_WRITE
    D 送出 1 秒後：做完（2 ms）；拿著／在等：（沒有）
    T 的第三句 INSERT inventory_ledger：成功；D：做完（2 ms）；InnoDB 的死結計數 27 → 27
  D 沒有 trigger、外鍵在；DDL 換成 ALTER TABLE … ALGORITHM=INSTANT
    T 做完 UPDATE inventory、INSERT inventory_reservations，拿著：inventory SHARED_WRITE、inventory_ledger SHARED_READ、inventory_reservations SHARED_READ、inventory_reservations SHARED_WRITE
    D 送出 1 秒後：還在等；拿著／在等：#sql-1_1da39 EXCLUSIVE、inventory SHARED_UPGRADABLE、inventory_ledger EXCLUSIVE（PENDING）、inventory_ledger SHARED_UPGRADABLE
    T 的第三句 INSERT inventory_ledger：1213 Deadlock found when trying to get lock; try restarting transaction；D：做完（1183 ms）；InnoDB 的死結計數 27 → 27
  （結束時 load { 7.82 5.34 4.20 }）
```

- **環的一半是外鍵。** T 只做了 `UPDATE inventory`、`INSERT inventory_reservations`，卻拿著 `inventory_ledger` 的 `SHARED_READ` —— `inventory_ledger` 有一條外鍵指向 `inventory`，MySQL 的 metadata lock 會「延伸到外鍵相關的表」（MySQL 8.0 手冊 Metadata Locking 那一節）。D 拿到 `SHARED_NO_WRITE`、要升級成 `EXCLUSIVE`，得等 T 放掉那個 `SHARED_READ`；T 的下一句要 `SHARED_WRITE`，被 D 擋住。B（沒有任何 trigger）一樣死結、C（拿掉外鍵）D 2 ms 就做完、T 照樣成功 —— 跟 trigger 寫的那張表無關。
- **被犧牲的一定是交易。** MySQL 8.0 的原始碼（`sql/mdl.h`、`sql/mdl.cc`）：metadata lock 的死結偵測挑「權重」低的當犧牲者，DML 是 25、DDL 是 100；犧牲者拿到的錯誤碼跟 InnoDB 的死結一樣是 1213 —— 日誌裡分不出來，InnoDB 的紀錄裡也沒有它。
- **不只是搬家程式。** D 換成 migration 常見的 `ALTER TABLE inventory_ledger ADD COLUMN …, ALGORITHM=INSTANT` 也一樣死結。第 08 章 8.4.5 的部署是 migration 的 Job 先跑、舊版的 pod 還在接單 —— 哪一天有一個 migration 改 `inventory_ledger`（或另一張指向 `inventory` 的表），那幾秒裡剛好做到一半的預留就是 500。
- 第 12 站 2.6.2 量過同一條外鍵：先 `INSERT` 帳、再 `UPDATE` 庫存會死結 9,062 次，換成「先 UPDATE 父表」是 0 次 —— 那是 InnoDB 的列鎖。這一次的環在 metadata lock，順序擋不住。那一節也寫了：「每一次死鎖在應用程式裡都是一個 `CannotAcquireLockException`，如果沒有重試，就是一個 500。」

> ⚠️ **我先猜錯了原因。** 第一個猜的是 trigger 寫的那張變更紀錄表：交易拿著它的 `SHARED_WRITE`，我以為 `CREATE TRIGGER` 也要它。B 與 C 推翻了它 —— 沒有任何 trigger 一樣死結，拿掉外鍵就不死結。M13 的四個情境，就是為了把這兩個猜測分開才排的。

**修：死結的那一次，整個交易重做。** 錯誤訊息自己說「try restarting transaction」。只接 1213（1205 是鎖等待逾時，已經等滿了）、只在「自己就是整個交易」的時候重做：

```java
    /** transaction：自己開、自己 commit 的一個交易（TransactionTemplate.execute）。死結 → 整個再做一次，最多 ATTEMPTS 次 */
    public static <T> T retry(String op, Supplier<T> transaction) {
        for (int attempt = 1; ; attempt++) {
            try {
                return transaction.get();
            } catch (RuntimeException e) {
                if (!isDeadlock(e) || attempt >= ATTEMPTS || TransactionSynchronizationManager.isActualTransactionActive()) throw e;
                log.warn("DEADLOCK_RETRY op={} attempt={}：交易被選為死結的犧牲者，整個重做", op, attempt);
            }
        }
    }
```

預留的交易從 `@Transactional` 換成 `TransactionTemplate`，包在它裡面 —— 重做要在交易的外面。重做是安全的：`processed_messages` 那一列（第 04 章 4.5 的冪等）也在同一個交易裡，跟著 rollback 了：

```diff
 import com.example.shop.inventory.ReserveLine;
 import com.example.shop.inventory.ReservationRef;
 import com.example.shop.inventory.StockVersion;
+import com.example.shop.shared.error.Deadlocks;
 import com.example.shop.shared.error.ProblemType;
 import com.example.shop.shared.error.ShopException;
 import com.example.shop.shared.events.EventTypes;
…
 import org.slf4j.LoggerFactory;
 import org.springframework.data.redis.core.StringRedisTemplate;
 import org.springframework.jdbc.core.JdbcTemplate;
+import org.springframework.transaction.PlatformTransactionManager;
 import org.springframework.transaction.support.TransactionSynchronization;
 import org.springframework.transaction.support.TransactionSynchronizationManager;
+import org.springframework.transaction.support.TransactionTemplate;
 import org.springframework.stereotype.Service;
 import org.springframework.transaction.annotation.Propagation;
 import org.springframework.transaction.annotation.Transactional;
…
     private final Counter shortages, consumeConflicts, budgetExpired;
     /** 6.9.2 Redis 不能用的時候，可售量在本機記憶體裡放 5 秒（AC-4 允許的延遲）：不然每一次看商品頁都是一句 MySQL */
     private final java.util.concurrent.ConcurrentHashMap<Long, long[]> degradedAvailable = new java.util.concurrent.ConcurrentHashMap<>();
+    /** 13 站第 09 章寫完之後的追記（9.6.5）：預留的交易用它開 —— 死結的那一次要整個重做（Deadlocks.retry），重做要在交易的外面 */
+    private final TransactionTemplate tx;
 
-    JdbcInventoryService(JdbcTemplate jdbc, HotStock hot, StringRedisTemplate redis, RedisGuard guard, Outbox outbox, Inbox inbox, MeterRegistry meters) {
+    JdbcInventoryService(JdbcTemplate jdbc, HotStock hot, StringRedisTemplate redis, RedisGuard guard, Outbox outbox, Inbox inbox, MeterRegistry meters,
+                         PlatformTransactionManager tm) {
         this.jdbc = jdbc;
         this.hot = hot;
         this.redis = redis;
         this.guard = guard;
         this.outbox = outbox;
         this.inbox = inbox;
+        this.tx = new TransactionTemplate(tm);
         this.shortages = Counter.builder("shop.inventory.hot.shortage")
                 .description("熱點落帳時 MySQL 不夠（Redis 的閘門放進了不存在的庫存）→ 訂單會被取消。正常應該永遠是 0").register(meters);
         this.consumeConflicts = Counter.builder("shop.inventory.consume.conflict")
…
         stockChanged(productId, List.of(productId));
     }
 
-    /** 13 站 4.5：自己的交易（下單 Saga 的一步）。冪等：見 reserveOnce */
+    /**
+     * 13 站 4.5：自己的交易（下單 Saga 的一步）。冪等：見 reserveOnce。
+     * 第 09 章寫完之後的追記（9.6.5）：交易從 @Transactional 換成 TransactionTemplate —— 死結的那一次整個重做（Deadlocks.retry）。
+     * 重做是安全的：processed_messages 那一列也在同一個交易裡，跟著 rollback 了
+     */
     @Override
-    @Transactional
     public void reserve(long orderId, List<ReserveLine> lines, List<ReserveLine> hotLines) {
-        reserveIdempotently(orderId, lines, hotLines);
+        Deadlocks.retry("reserve", () -> tx.execute(s -> reserveIdempotently(orderId, lines, hotLines)));
     }
 
     /**
…
      * 13 站 6.4.3：交易開始的時候連線已經借到了（JpaTransactionManager 在 begin 就拿連線、關掉 autocommit）。
      * 在連線池裡排隊的那一段，可能已經把呼叫端的預算用完：用完了就不做 —— 呼叫端早就走了，做完也沒有人收（6.3 ② 的「早就放棄的」）
      */
-    @Transactional
     public boolean reserveOnce(long orderId, List<ReserveLine> lines, List<ReserveLine> hotLines) {
-        if (Deadline.expired()) {
-            budgetExpired.increment();
-            Deadline.check("預留");
-        }
-        return reserveIdempotently(orderId, lines, hotLines);
+        return Deadlocks.retry("reserve", () -> tx.execute(s -> {
+            if (Deadline.expired()) {
+                budgetExpired.increment();
+                Deadline.check("預留");
+            }
+            return reserveIdempotently(orderId, lines, hotLines);
+        }));
     }
 
     /**
```

`ReserveDdlDeadlockTest` 把那一刻釘住：一個只對這張訂單生效的 trigger 讓預留在 `INSERT inventory_reservations` 之後睡 1 秒，這一秒裡另一條連線 `CREATE TRIGGER ON inventory_ledger`。先寫測試、在還沒修的程式上跑（紅），再修（綠）：

```
9.6.5 的追記：DDL（CREATE TRIGGER ON inventory_ledger）等了 718 ms；預留失敗：CannotAcquireLockException（Deadlock found when trying to get lock; try restarting transaction），死結之後重做 0 次；這張訂單的預留 0 筆、帳 0 筆；InnoDB 的死結計數 0 → 0
```

```
9.6.5 的追記：DDL（CREATE TRIGGER ON inventory_ledger）等了 729 ms；預留成功（第一次），死結之後重做 1 次；這張訂單的預留 1 筆、帳 1 筆；InnoDB 的死結計數 2 → 2
```

> 小坑：修好之後的第一次整套紅了一個 `TableOwnershipTest`（第 12 站：每個模組只碰自己的表）——「shared 模組寫入了 inventory 模組的表」，指的是 `Deadlocks` 的**註解**裡寫了一句像 SQL 的「更新 inventory」。那個守門掃的是原始碼的文字，不分註解；把註解改成不像 SQL 的寫法，再跑一次整套。

**沒有做的：**

- 修了之後沒有再跑 M12：24 次切換才出現 1 張，再跑一次是 0 也證明不了什麼；證明是上面那個固定交錯的測試。
- 只修了預留。庫存的其他寫入（確認、釋放、出庫、補貨）一樣是「先 UPDATE inventory、再寫子表」，一樣可能碰上 DDL —— 它們大多在呼叫端的交易裡（`MANDATORY`），重做是呼叫端的事，這一節沒有一個一個去改。
- 搬家程式自己的 DDL：第 02 章 2.8.6 讀 binlog 的那一個不在正本上裝 trigger，沒有這一句 DDL；但 migration 的那一句還在。

📌 **第 09 章寫完之後的追記**：停寫縮短了 —— 9.6.7。兩組 pod 都活著，只換「誰在寫」：1.5 秒、15 張 503。

### 9.6.6 回頭路：反方向的搬家程式

切換的時候，在新的庫起來之前多做一件事：**在新的庫裝同樣的變更紀錄**，另一個搬家程式反過來追 —— 新的庫是正本，單體的庫變成它的副本（第 02 章 2.8.5 說的「反過來再追一次」）：

```
  ⑥ 切過去之後 60 秒：下單 [201=560, 503=40]；反方向的搬家程式套用 1,680 筆、失敗 0 次
     新的庫：INV-2 對不上的商品 0 個；訂單服務的庫裡，還在等付款、在新的庫找不到預留的訂單 0 張
     單體的庫跟著新的庫嗎（邊寫邊比）：比了 19 段：第一次不一樣 2 段、再比 3 次還是不一樣 0 段（6,207 ms）
```

切過去之後的 60 秒：反方向的搬家程式套用 1,680 筆、0 次失敗；新的庫 INV-2 是 0、找不到預留的訂單 0 張；邊寫邊比單體的庫與新的庫，0 段不一樣 —— **單體的庫一直跟著新的庫**，這就是回頭路。這 60 秒的 40 張 503，是上面「ready 之後的那 4 秒」。

### 9.6.7 追記：停寫縮短 —— 兩組 pod 都活著，只換誰在寫

📌 **第 09 章寫完之後補的。** 9.6.5 的停寫 24.3 秒裡，追完、搬共用表的幾列、核對加起來不到 0.1 秒，其他都是 pod：舊的關掉 13.4 秒、新的起來 10.8 秒。那一節最後說「要更短，要讓新的 pod 先起來、但還不寫 —— 應用程式要多一個開關」。這裡加上那個開關。

**開關：`WriteGate`。** 三個狀態：

```java
 * 13 站第 09 章寫完之後的追記（9.6.7）：寫入的開關。切換資料庫的那一刻要「舊的不再寫、新的還不寫」——
 * 第 09 章用縮到 0、換設定、重開來做：停寫 24～29 秒，幾乎都是 pod 的關與起（9.6.5）。這個開關讓兩組 pod 都活著，只換「誰在寫」：
 *
 *   OPEN     照常
 *   STANDBY  起來就是這個狀態（shop.deployment.standby=true）：新的那一組先起來、連好新的庫，什麼都不寫
 *   FROZEN   從 OPEN 切過來（舊的那一組）：不再接新的寫入，等手上的做完才回
 *
 * 不是 OPEN 的時候：HTTP 的寫入（GET、HEAD 以外）回 503；每一個回應都帶 Connection: close —— 呼叫端重用的連線（第 08 章 8.6.1）
 * 下一次就會重新連線，經過 kube-proxy 換到 Service 現在指的那一組；消費者停下（RabbitConsumers）；庫存的排程跳過（InventoryJobs）。
 * 改它的是管理埠的 /actuator/writes（WriteGateEndpoint，只收管理員）。
 *
 * 「手上的寫入」= enter() 到 exit() 之間：HTTP 的寫入、排程的一輪。消費者手上的那一則，由 container 的 stop() 等它做完（監聽者是同步呼叫的）
```

不是 OPEN 的時候，寫入的 HTTP 請求在 filter 就回 503（`Retry-After: 1`）；**每一個回應都帶 `Connection: close`** —— 訂單服務重用著連到舊的 pod 的連線（第 08 章 8.6.1：kube-proxy 在連線的時候挑 pod），一個回應之後它就得重新連線，新的連線才會照 Service 現在指的那一組走。消費者停下：

```java
        // 13 站 9.6.7 的追記：寫入的開關。凍結 → 停下 container（stop() 等手上的那一則做完、沒有 ack 的回到佇列）；打開 → 接上。
        // 待命（STANDBY）起來的時候一個都不開：佇列跟舊的那一組是同一個，先收就是第二個寫入者
        this.gate = gate;
        gate.onChange(s -> {
            if (!lifecycleRunning) return;
            if (s == com.example.shop.shared.deployment.WriteGate.State.OPEN) startStarter(); else stopContainers();
        });
```

庫存的排程每一輪先問它（`WriteGate.run`）。開關本身是管理埠上的 `/actuator/writes`，只收管理員的 token（`SecurityConfig`）：它能讓整個服務停止寫入，不能從入口打得到。

`WriteGateTest` 守住三件事 —— 待命起來不寫、只有管理員在管理埠打得開、凍結要等手上的寫入做完：

```
9.6.7 凍結等手上的寫入：300 ms 後還在等 = true；凍結之後才來的寫入放不放 = false；Frozen[state=FROZEN, listenersMs=0, waitedMs=410, inFlight=0]
9.6.7 ① 待命：寫入 503 {"type":"/problems/temporarily-unavailable","title":"服務暫時無法使用","status":503,"detail":"正在切換，請稍後再試","instance":"/api/cart/items","traceId":"4fba8d5c889feb0c4e215de314397e80"}（Retry-After 1、Connection close）；讀 200（Connection close）；shop.inventory.order-events 的消費者 0 個
9.6.7 ② 開關：沒有 token 401、買家 403、應用程式的埠 403、管理員 200 {"state":"OPEN","inFlight":0}；之後寫入 409、讀 200（Connection null）；消費者 2 個
9.6.7 ③ 凍結：200 {"waitedMs":848,"listenersMs":848,"inFlight":0,"state":"FROZEN"}；消費者 0 個
```

> ⚠️ **第一版的凍結花了 4.8 秒，而第一版的測試證明錯了東西**（這兩段是寫作途中的終端輸出，當時沒有存成紀錄）。測試在「一個寫入在半路」的時候凍結，300 ms 之後看凍結的請求還沒回來、算它「在等那一個寫入」。它回來時說 `"waitedMs":4813` —— 4.8 秒，幾乎都在停消費者：`RabbitConsumers` 一個一個停 container，每一個的 `stop()` 要等它的消費者那一輪 receive 結束。改成同時停（0.8 秒），測試改成等佇列上的消費者變成 0 再數 300 ms —— 還是紅：佇列上的消費者已經是 0，container 的 `stop()` 還沒回來，那 300 ms 仍然在停消費者。最後「等手上的寫入」改成一個沒有消費者的單元測試（上面的第一行），整合的那一個只驗端點與消費者。

**切換：`Cutover.fast`。** 新的那一組（`inventory-service-next`）事先起來：同一個映像檔、同一份設定，接新的庫與 Redis 2、`SHOP_DEPLOYMENT_STANDBY=true`，Service 還沒有指到它。兩組的管理埠先 port-forward 好（開一條要一兩秒）。然後：

```java
    public static Fast fast(Source copier, Writes from, Writes to, boolean moveOutbox, Kube.Check beforeOpen) throws Exception {
        long t0 = System.nanoTime();
        Map<String, String> frozen = from.post("FROZEN");
        long t1 = System.nanoTime();
        int drained = copier.drain();
        int holes = copier.closeHoles();
        int dedup = copy(copier.from(), copier.to(), "SELECT consumer, message_id, processed_at FROM processed_messages WHERE consumer LIKE 'inventory.%'",
                "INSERT IGNORE INTO processed_messages (consumer, message_id, processed_at) VALUES (?, ?, ?)");
        int outbox = !moveOutbox ? 0 : copy(copier.from(), copier.to(),
                "SELECT event_id, aggregate_type, aggregate_id, event_type, payload, trace_id, created_at, traceparent FROM outbox_events WHERE published_at IS NULL",
                "INSERT IGNORE INTO outbox_events (event_id, aggregate_type, aggregate_id, event_type, payload, trace_id, created_at, traceparent) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
        if (outbox > 0) Mig.sql(copier.from(), "UPDATE outbox_events SET published_at = CURRENT_TIMESTAMP(3) WHERE published_at IS NULL");
        long t2 = System.nanoTime();
        Map<String, String> diff = copier.differences();
        long t3 = System.nanoTime();
        if (!diff.isEmpty()) {
            from.post("OPEN");
            throw new IllegalStateException("核對不過，沒有換：" + diff);
        }
        if (beforeOpen != null) beforeOpen.ok();
        to.post("OPEN");
        long t4 = System.nanoTime();
        Kube.kubectl("patch", "service/inventory-service", "-p", "{\"spec\":{\"selector\":{\"app\":\"" + to.app + "\"}}}");
        long t5 = System.nanoTime();
        return new Fast((t1 - t0) / 1_000_000, (t2 - t1) / 1_000_000, drained, holes, dedup, outbox, diff, (t3 - t2) / 1_000_000,
                (t4 - t3) / 1_000_000, (t5 - t4) / 1_000_000, frozen);
    }
```

M8 是 M4 的同一個場景（下單全部走訂單服務、單體縮到 0、每秒 10 張），換庫的方法換成這一個，切過去再切回來：

```bash
mvn test -Pexperiments -Dtest=M8FastCutoverTest
```

```
═══ 9.6.7 停寫縮短：下單全部走訂單服務、單體縮到 0；庫存的五張表在 shop_d09_mono，只有庫存服務在寫。每秒 10 張下單，從頭到尾不停 ═══
  ① ② 第 1 秒：新的庫跑完庫存與 shared 的 migration；搬家程式回填 1,422 列、追上了
     邊寫邊比：比了 11 段：第一次不一樣 2 段、再比 3 次還是不一樣 0 段（5,288 ms）
  ③ 新的那一組起來（第 6～26 秒，19.8 秒，不算停寫）：{inventory-service-next-dd9c5b58d-lsdgc={"state":"STANDBY","inFlight":0}, inventory-service-next-dd9c5b58d-xgrxz={"state":"STANDBY","inFlight":0}}
     舊的那一組：{inventory-service-cf4f6679d-b7jpj={"state":"OPEN","inFlight":0}, inventory-service-cf4f6679d-zrz5r={"state":"OPEN","inFlight":0}}
  ④ 切換（第 36.1～37.5 秒）：停寫 1,455 ms = 凍結 960 ms（最慢的那一台 935 ms，其中停消費者 935 ms）＋ 追完 3 筆變更、關掉 0 個洞 90 ms ＋ 搬去重紀錄 1,124 列、還沒送出的事件 0 則、核對 48 ms（不一樣的表：沒有）＋ 新的那一組打開 138 ms ＋ 換 Service 的 selector 219 ms
     凍結的回應：{inventory-service-cf4f6679d-b7jpj={"state":"FROZEN","waitedMs":935,"listenersMs":935,"inFlight":0}, inventory-service-cf4f6679d-zrz5r={"waitedMs":822,"state":"FROZEN","inFlight":0,"listenersMs":821}}
     切換前後，每 1 秒：33✓ 34✓ 35✓ 36[503=10] 37[201=5, 503=5] 38✓ 39✓ 40✓ 41✓ 42✓ 43✓ 44✓ 45✓ 46✓ 47✓ 48✓ 49✓
     切換之前 10 秒：下單 [201=100]；停寫的那 1,462 ms 送出的：下單 [503=15]；之後 10 秒：下單 [201=100]
  ⑤ 切過去之後 60 秒：下單 [201=594]；反方向的搬家程式套用 1,782 筆、失敗 0 次；每一個庫存服務的 pod 收到的預留 {inventory-service-cf4f6679d-b7jpj=377.0, inventory-service-cf4f6679d-zrz5r=185.0, inventory-service-next-dd9c5b58d-lsdgc=398.0, inventory-service-next-dd9c5b58d-xgrxz=200.0}
     新的庫：INV-2 對不上的商品 0 個；還在等付款、在新的庫找不到預留的訂單 0 張；單體的庫跟著新的庫嗎：比了 20 段：第一次不一樣 2 段、再比 3 次還是不一樣 0 段（6,251 ms）
  ⑥ 切回來（第 103.8～105.1 秒；舊的那一組一直活著、凍結著）：停寫 1,312 ms = 凍結 1,034 ms（最慢的那一台 1015 ms，其中停消費者 1015 ms）＋ 追完 3 筆變更、關掉 0 個洞 101 ms ＋ 搬去重紀錄 2,448 列、還沒送出的事件 0 則、核對 37 ms（不一樣的表：沒有）＋ 新的那一組打開 51 ms ＋ 換 Service 的 selector 89 ms
     切回來前後，每 1 秒：101✓ 102✓ 103✓ 104[503=10] 105[201=7, 503=3] 106✓ 107✓ 108✓ 109✓ 110✓ 111✓ 112✓ 113✓ 114✓ 115✓ 116✓ 117✓
  ⑦ 切回來之後 30 秒：下單 [201=300]；單體的庫：INV-2 對不上的商品 0 個；還在等付款、找不到預留的訂單 0 張
  整段：下單 [201=1323, 503=28]；不是全部 201 的格（每 5 秒）：35～40 秒 [201=35, 503=15]；100～105 秒 [201=38, 503=12]；105～110 秒 [201=49, 503=1]
     除了 201、503 之外的狀態碼出現在：沒有；訂單服務的 ERROR 日誌：{SqlExceptionHelper：Duplicate entry 'N-N' for key 'orders.uk_orders_order_no'=1}
     庫存服務的 ERROR 日誌：舊的那一組 {}；新的那一組 {}
  （結束時 load { 6.88 8.33 9.42 }）
```

- **停寫 1,455 ms**（9.6.5 是 24.3 秒）。最長的一段是凍結的 960 ms，幾乎都是停消費者（兩台的 `listenersMs` 935 與 821 ms）；追完 3 筆變更 90 ms、核對 48 ms、打開新的那一組 138 ms、換 Service 的 selector 219 ms。
- **這 1.5 秒送出的 15 張下單是 503**，之後 10 秒 100 張全部 201。9.6.5 那一種「新的 pod ready 之後還有 4 秒的 503」沒有出現。推論：熔斷器沒有打開 —— 它看 10 秒的窗、失敗過一半才開（第 06 章 6.7），這 10 秒裡大約 100 次預留、失敗 15 次；沒有另外量熔斷器的狀態。
- **切過去之後的預留全部到了新的那一組**：四個 pod 收到的預留裡，新的兩個加起來 598 個，跟之後 60 秒的 594 張下單差在切換前後的那幾張（舊的兩個的數字是切換之前累積的）。
- **切回來 1,312 ms、13 張 503**：舊的那一組一直活著、凍結著，回頭路就是同一個操作反過來；單體的庫 INV-2 是 0、找不到預留的訂單 0 張。

| | 9.6.5（縮到 0、換設定、重開） | 9.6.7（開關、換 selector） |
|---|---|---|
| 停寫 | 24.3 秒 | 1.5 秒 |
| 切過去的那一段，下單 503 | 122 張，ready 之後還有 40 張 | 15 張 |
| 切回來 | 24.8 秒 | 1.3 秒 |
| 換庫的那一段，cluster 裡的庫存服務 | 0 台 → 2 台 | 4 台（兩組都在） |

**代價與沒有做的：**

- **兩組一起在的那一段，記憶體多一倍**（庫存服務兩個 pod 約 1 GiB，9.10.2）；要留著舊的那一組當回頭路，就一直多一倍，直到決定不回去（9.8）。
- **新的那一組的 `SHOP_DEPLOYMENT_STANDBY` 還是 true**：切過去之後，它的一個 pod 如果重開，會以待命起來、不寫 —— 那一個 pod 的請求都是 503，直到有人再打開它。切換之後要再部署一次（拿掉那個環境變數），這一節沒有做。
- **凍結的將近 1 秒是停消費者**：container 的 receive 一次最多等 1 秒（Spring AMQP 的預設）；調短可以再快，代價是閒的時候多一些輪詢，沒有試。
- **拿掉一組，就叫醒人。** 新的那一組的 `app` 標籤是 `inventory-service-next`，Prometheus 拿它當 job（第 08 章的 scrape 設定）；M8 結束時刪掉它，`ShopServiceGone{inventory-service-next}`（15 分鐘內看過、現在一台都沒有）在下一個實驗開始後 31 秒 firing，`severity: page`（9.5.2 那一段紀錄的開頭）。正式切換之後拿掉舊的那一組也一樣。要嘛兩組用同一個 job（另外一個標籤分顏色），要嘛拿掉之前先把那條告警靜音 —— 這一節兩個都沒有做。
- **新的那一組是實驗裡抄出來的**（`Mig.nextInventory`：照現在的 Deployment 抄一份、改名字與標籤、加三個環境變數）。正式的做法是兩份都寫在 `k8s/` 裡（blue／green），Service 的 selector 是部署的一部分 —— 第 08 章 8.4.6 的 GitOps 之下，selector 的切換也是一個 commit。

### 9.6.8 追記：搬家程式換成讀 binlog

📌 **第 09 章寫完之後補的。** 這一章的搬家程式一直是第 02 章 2.8.4 的 trigger。M11 是 M8（9.6.7）的同一個場景，搬家程式換成讀 binlog 的那一個（第 02 章 2.8.6 的追記），去程、回程都是：

```bash
mvn test -Pexperiments -Dtest=M11BinlogTest
```

```
═══ 9.6.8 binlog 的變更擷取：M8 的場景，搬家程式讀 binlog；每秒 10 張下單，從頭到尾不停 ═══
  正本上的 trigger：0 個（第 02 章的做法每一個表三個）
  ① 第 4 秒：binlog 從 binlog.000016:587498671 接上；回填 1,443 列；之後 2,042 則 binlog 事件、其中搬家的五張表的列 72 個
     邊寫邊比：比了 11 段：第一次不一樣 1 段、再比 3 次還是不一樣 0 段（2,385 ms）
  ② 新的那一組起來（第 7～81 秒，74.6 秒，不算停寫）
  ③ 切換（第 91.1～92.7 秒）：停寫 1,591 ms = 凍結 1,025 ms（最慢的那一台 996 ms，其中停消費者 996 ms）＋ 追完 3 筆變更、關掉 0 個洞 115 ms ＋ 搬去重紀錄 2,059 列、還沒送出的事件 0 則、核對 27 ms（不一樣的表：沒有）＋ 新的那一組打開 254 ms ＋ 換 Service 的 selector 170 ms
     切換前後，每 1 秒：88✓ 89✓ 90✓ 91[503=10] 92[201=3, 503=7] 93✓ 94✓ 95✓ 96✓ 97✓ 98✓ 99✓ 100✓ 101✓ 102✓ 103✓ 104✓
  ④ 切過去之後 60 秒：下單 [201=592, 503=1]；反方向（binlog）搬了 1,908 個主鍵、失敗 0 次
     新的庫：INV-2 對不上的商品 0 個；還在等付款、在新的庫找不到預留的訂單 0 張；單體的庫跟著新的庫嗎：比了 25 段：第一次不一樣 3 段、再比 3 次還是不一樣 0 段（8,387 ms）
  ⑤ 切回來（第 160.5～162.3 秒）：停寫 1,867 ms = 凍結 1,095 ms（最慢的那一台 1049 ms，其中停消費者 1048 ms）＋ 追完 3 筆變更、關掉 0 個洞 326 ms ＋ 搬去重紀錄 3,622 列、還沒送出的事件 0 則、核對 27 ms（不一樣的表：沒有）＋ 新的那一組打開 29 ms ＋ 換 Service 的 selector 390 ms
     切回來前後，每 1 秒：157✓ 158✓ 159✓ 160[503=10] 161[201=1, 503=9] 162✓ 163✓ 164✓ 165✓ 166✓ 167✓ 168✓ 169✓ 170✓ 171✓ 172✓ 173✓
  ⑥ 切回來之後 30 秒：下單 [201=298]；單體的庫：INV-2 對不上的商品 0 個；還在等付款、找不到預留的訂單 0 張
  整段：下單 [201=1781, 503=141]；不是全部 201 的格（每 5 秒）：5～10 秒 [201=18, 503=32]；10～15 秒 [201=42, 503=8]；15～20 秒 [201=41, 503=9]；20～25 秒 [201=44, 503=6]；25～30 秒 [201=32, 503=18]；35～40 秒 [201=40, 503=10]；40～45 秒 [201=36, 503=14]；45～50 秒 [201=42, 503=8]；90～95 秒 [201=33, 503=17]；160～165 秒 [201=31, 503=19]
     訂單服務的 ERROR 日誌：{RemoteInventoryApi：INVENTORY_UNAVAILABLE op=reserve：送了 N 次都沒有回應：I/O error on PUT request for "http://inventor=46, SqlExceptionHelper：Duplicate entry 'N-N' for key 'orders.uk_orders_order_no'=4}
  正本上的 trigger（結束時）：單體的庫 0 個、新的庫 0 個
  （結束時 load { 10.83 13.57 11.13 }）
```

| | M8：trigger（9.6.7） | M11：binlog |
|---|---|---|
| 正本上的 trigger | 每張表一組，搬完才拿掉 | 0 個（結束時也是 0） |
| 切過去：停寫 | 1,455 ms | 1,591 ms |
| 其中「追完」 | 3 筆變更、90 ms | 3 筆、115 ms：先等 binlog 讀到凍結之後的位置 |
| 關掉的洞 | 0 個（凍結之後，手上的寫入都做完了） | 0 個（binlog 沒有洞） |
| 切回來：停寫 | 1,312 ms | 1,867 ms |
| 兩邊的 INV-2、找不到預留的訂單 | 0、0 | 0、0 |

- **停寫的長短差不多。** 兩種的停寫都是凍結（停消費者）主導；追完都在 0.4 秒以內。binlog 換到的不是更短的停寫，是**正本上少一組 trigger**（2.8.4 ④ 的那一筆寫入成本）與**不用想洞的事**。
- **整段的 141 張 503，切換那兩段只占 36 張**（切過去 17、切回來 19）。其他的 105 張全部在第 5～50 秒（上面「不是全部 201 的格」），訂單服務的日誌是預留「送了 N 次都沒有回應」（46 行）—— 剛接上 binlog、新的那一組正在起來的那一段。新的那一組也起得特別慢：74.6 秒，M8 是 19.8 秒。

> ⚠️ **這 105 張的原因沒有查出來，我第一次寫的推論撤回。** 第一次跑 M11 也是這樣（124 張 503 裡 89 張不在切換的那兩段；那一次沒有每 5 秒的格，是事後用 `kubectl logs` 依時間分組，「沒有回應」的 ERROR 有 56 行在新的那一組起來的那一分鐘）。我當時寫的推論是「新的兩台 JVM 起來、跟舊的兩台搶同一個 node 的 CPU，跟 binlog 無關」—— 可是 M8 也一樣先起新的那一組，兩次都沒有這種 503（不是全部 201 的格只有切換的那幾格），新的那一組 20～27 秒就起來了。兩個實驗在這一段的差別只有搬家程式：binlog 的那一個像一台 replica 一樣連著 MySQL、一列一列（不加鎖）讀正本；trigger 的那一個每一批讀一句。哪一件讓舊的那一組的預留逾時，沒有量 —— 要查，下一步是在這一段看 MySQL（`SHOW PROCESSLIST`、等鎖）與兩組 pod 的 CPU。

---

## 9.7 回滾演練

回頭路要演練過才算數。M4 的最後一段：切過去 60 秒之後，用同一個 `Cutover` 切回單體的庫 —— 停寫、追完反方向的變更、搬去重紀錄**與還沒送出的事件**、核對、換回設定：

```
  ⑦ 回滾演練（第 110～135 秒）：停寫 24.8 秒 = 縮到 0 13.7 秒 ＋ 追完 387 筆變更、關掉 0 個洞 123 ms ＋ 搬去重紀錄 2,527 列、還沒送出的事件 23 則、核對 20 ms（不一樣的表：沒有）＋ 換設定、起來 11.0 秒
     停寫的那 24.8 秒：下單 [201=128, 503=120]；回來之後 30 秒：下單 [201=262, 503=39]
     停寫的那一段，每 5 秒：110～115 秒 [201=50]；115～120 秒 [201=50]；120～125 秒 [201=28, 503=22]；125～130 秒 [503=50]；130～135 秒 [503=50]；135～140 秒 [201=13, 503=37]；140～145 秒 [201=48]
     單體的庫：INV-2 對不上的商品 0 個；還在等付款、找不到預留的訂單 0 張（9.2 的回滾是 39 張）
  整段：下單 [201=1331, 503=321]
```

- **停寫 24.8 秒**：縮到 0 13.7 秒、新的 pod 起來 11.0 秒；追完 387 筆變更、搬 2,527 列去重紀錄**與 23 則還沒送出的事件**（新的庫一離開就沒有 relay 了，9.6.4）、核對 20 ms。
- 回來之後，**單體的庫 INV-2 是 0、找不到預留的訂單 0 張**。（輸出裡「9.2 的回滾是 39 張」是寫 M4 那時候的 M1 跑出來的數字；最後一輪的 M1 是 44 張。）
- 回來之後 30 秒裡的 39 張 503，跟 9.6.5 一樣是 ready 之後的那幾秒。

| | 9.2 的回滾（權重改回去） | 9.7 的回滾（反方向的搬家程式 + 停寫切回） |
|---|---|---|
| 寫進新的庫的預留 | 灰度那一段寫的，被搬家程式蓋掉了，兩個庫都沒有 | 切過去之後寫的，每一筆都追回單體的庫 |
| 回滾之後，等付款、找不到預留的訂單 | 44 張 | 0 張 |
| 停多久 | 0（權重改了 0.3 秒內生效） | 24.8 秒 |

便宜的回滾（改權重）只在資料沒有搬的時候是對的；資料搬了，回滾就是另一次搬家。

---

## 9.8 收尾：什麼時候拆掉回頭路

9.6、9.7 結束時，系統裡還留著好幾個過渡架構（9.3.1）。它們每一個都在花錢，而且**留越久，越有人以為它們是系統的一部分**：

| 留著的 | 它的成本 | 什麼時候拆 |
|---|---|---|
| 新的庫上的 trigger 與變更紀錄、反方向的搬家程式 | 每一列寫入多一句 `INSERT`（第 02 章 2.8.4 ④）；一個要有人顧的常駐程式；變更紀錄表一直長 | 決定「不會再回去了」的那一天 —— 例如新的庫穩定跑過一個完整的業務週期（月結、一次大促） |
| 單體的庫裡那五張庫存的表 | 佔空間；更糟的是**有人會讀它**（一句三年前的報表 SQL，第 02 章 2.3.2）—— 反方向的搬家程式一停，它就是過時的資料 | 跟上一列同一天。先改名（`inventory_retired_…`），讓還在讀它的程式大聲壞掉，觀察一段時間再刪 |
| 單體的 Deployment（縮到 0） | 幾乎沒有；但它提醒每一個人「還回得去」—— 只有在上面兩列還在的時候，這句話才是真的 | 跟上面同一天 |
| 入口的權重、`Shop-Route` | 一條誰都可以用的旁路（9.5.3）；權重 0 的那一邊還寫在 `HTTPRoute` 裡（Envoy 的 cluster 裡已經沒有它，9.5.1） | 單體的 Deployment 拿掉的那一天 |
| 「線上那一版」的契約（第 03 章 3.8.5 的檔案、3.8.6 broker 裡記著在 production 的那一版）（第 09 章寫完之後的追記：9.3.1 的表有它，這一張漏了） | 每一次部署，提供端都要多驗證一份舊的呼叫端的契約；舊的那一版不在線上了，它就是在驗證不存在的東西 | 線上已經沒有那一版的那一天：在 broker 記下它不在 production（Pact 的 record-undeployment），手動複製的那一份檔案刪掉 |
| Redis 3 裡庫存留下的 key（`stock:*`） | 不會再有人讀；佔記憶體 | 切換之後就可以清 |
| 共用表裡庫存的那幾列（單體的庫的 `processed_messages`） | 不會再有人讀 | 不用處理：保留 7 天，到期由排程清掉（第 12 站 0.6.7） |

拆掉回頭路是一個**決定**，不是一件雜事：拆掉的那一刻起，要回去就不是「停寫、切回」幾十秒的事，而是 9.10 那一整套。所以它要有一個日期、一個負責的人，寫進遷移計畫。

---

## 9.9 什麼時候該合併回單體

### 9.9.1 這一站的帳

第 00 章用四個代價判斷「該不該拆」（0.2）。到這一章為止，可以照同樣的四欄，把這一站**因為切開才有的**事記一次帳 —— 不算「單體裡本來就有、切開之後才看到」的 bug（那幾個另外列在下面）：

| 代價 | 這一站量到的（因為切開才有） |
|---|---|
| 延遲 | 下單 p50 多 2.5～3 ms、每項一次的寫法 15 → 37 ms（0.2.1）；Saga 在切開的部署每張多 0.4～3.6 ms（4.10.3）；kind 上、同一個庫、交錯量：下單 p50 35 對 30 ms、p99 358 對 188 ms（9.10.3） |
| 一致性 | 失敗之後 300 列孤兒預留（0.2.2）；一刀切斷 7 種交易（1.2）；回應遺失：補貨 +20、重複的預留（3.2.3）；兩個 commit 之間 `kill -9`：卡 30 秒、孤兒、出不了貨的訂單（4.2）；灰度 10%：超賣 44 件（9.2） |
| 一個服務慢，另一個倒 | 庫存慢 3 秒，跟庫存無關的「我的訂單」p50 5.5 → 1,862 ms（0.2.3）；只要一層「再送一次」，慢 10 秒變成 40 秒回不來（6.3.4）；庫存服務停掉，商品頁、購物車全部 503（5.2） |
| 除錯與維運 | traceId 斷在服務的邊界（0.2.4、7.2）；第 12 站 19 條告警裡 16 條切開之後永遠不響（7.9.2）；同一個 jar 部署兩次，兩個服務搶同一個佇列（3.2.2）；沒有認證的內部 API（3.2.4）；副本是空的、副本一則事件都沒收到（5.4.4、5.6）；新開的那一台一個請求都沒收到（8.2）；kube-proxy 平衡的是連線（8.6.1）；庫存服務對訂單服務限流（8.6.3）；入口的信任與「每個 IP」（8.8.2、8.8.3）；遷移期間：migration 只能有一個主人、兩個行程搶著建管理員、新的路的副本不完整（9.4） |

為了收拾這一欄，這一站寫的東西：Saga 與補償、`Inbox` 與冪等鍵、服務之間的 token、契約測試與 Pact Broker、讀模型與重建、逾時預算與重試預算、隔艙與熔斷、跨服務的追蹤、`k8s/` 底下的部署、入口、這一章的搬家與對帳工具。

**途中找到、單體裡本來就有的 bug**：排程裡一張失敗、整批停下（第 02 章 2.5.3 的 S5'）；已付款、已取消、沒有退款單（第 01 章 1.6.7）；single-flight 讀了兩次（第 00 章 0.9 沒找到原因、第 01 章找到）；通知的認領（第 08 章，第 12 站 7.7.2 的追記）；兩台同時第一次啟動，搶著建管理員（9.4.3）。它們常被算成「拆的好處」，其實是**多量、換一個形狀跑**的好處 —— 不拆服務也找得到：多跑幾次整套測試、把一個交錯用 latch 釘住、讓兩台同時起來。

### 9.9.2 判斷：回去問 0.3.2 的六個問題

合併回去的判斷，跟拆的判斷是同一組問題（0.3.2），只是現在手上多了一樣東西：拆開之後的實際經驗。

| # | 0.3.2 的問題 | 拆的時候（第 00 章） | 拆完之後再問一次 |
|---|---|---|---|
| 1 | 某一部分的負載跟其他部分差很多，需要單獨加機器嗎？ | 不：搶購的瓶頸是同一列的鎖 | 庫存服務有沒有真的因為**它自己的**負載單獨擴過？還是只是「每個服務兩台」？ |
| 2 | 某一部分的資料，一個資料庫放不下或不適合？ | 不：三年 31 GB | 拆開之後，庫存的庫有沒有用到單體的庫做不到的東西？ |
| 3 | 不同的團隊，而且在互相等？ | 不：一個團隊 | 邊界兩邊是不是同一群人？（0.4：同一群人守兩個服務，就是分散式單體） |
| 4 | 需要不同的發布節奏？ | 不：庫存被改的 10 次裡 7 次也改了訂單（0.3.3） | 拆完之後，一個改了正式程式碼的 commit 要部署幾個服務？這一站：只動庫存服務的 1 個、兩個都要的 18 個（下面） |
| 5 | 需要不同的技術棧？ | 不 | 兩邊是不是還是同一種語言、同一個框架？（這個專案：連 jar 都是同一個） |
| 6 | 某一部分的故障必須跟其他部分隔離？ | 不：降級與艙壁就夠 | 庫存服務出事的時候，故障有沒有真的被隔開？還是訂單服務照樣 503（6.2）、商品頁照樣壞（5.2）？ |

第 4 題可以直接量。0.3.3 的變更耦合換成「服務」來數：庫存模組的改動 → 庫存服務；`shared` → 兩個都要（同一個 jar 的共用程式碼）；其他七個模組 → 訂單服務。對這一站從第 00 章到第 09 章的歷史跑一次：

```bash
#!/usr/bin/env bash
# 13 站 9.9.2：拆完之後，一個改了正式程式碼的 commit 要部署幾個服務？（0.3.3 的變更耦合，換成「服務」來數）
# 用法：scripts/d09-deploy-coupling.sh <revision range>
# 模組 → 服務：inventory → 庫存服務；shared → 兩個都要（同一個 jar 的共用程式碼，第 03 章 3.7）；其他七個 → 訂單服務。
# 「碰了一個模組」的定義跟 scripts/d00-change-coupling.sh 一樣（src/main 的 Java，或 V<n>__<模組>_….sql）
set -euo pipefail
range="${1:?revision range}"
git log --first-parent --no-merges --name-only --format='@%h %s' "$range" | awk '
  /^@/ { flush(); n++; id = substr($1, 2); next }
  /^src\/main\/java\/com\/example\/shop\/[a-z]+\// { split($0, p, "/"); m[p[7]] = 1; next }
  /^src\/main\/resources\/db\/migration\/([a-z]+\/)?V[0-9]+__[a-z]+_/ { f = $0; sub(/.*\/V[0-9]+__/, "", f); sub(/_.*/, "", f); m[f] = 1; next }
  function flush(   k, inv, ord) {
    inv = 0; ord = 0
    for (k in m) { if (k == "inventory" || k == "shared") inv = 1; if (k != "inventory") ord = 1 }
    if (inv || ord) { touched++; kind[inv && ord ? "兩個都要" : inv ? "只有庫存服務" : "只有訂單服務"]++ }
    delete m
  }
  END {
    flush()
    printf "commit：%d 個；改到正式程式碼的：%d 個\n", n, touched
    split("只有訂單服務 只有庫存服務 兩個都要", ks, " ")
    for (i = 1; i <= 3; i++) printf "  %-8s %3d 個（%4.1f%%）\n", ks[i], kind[ks[i]], 100 * kind[ks[i]] / touched
  }'
```

```
commit：107 個；改到正式程式碼的：37 個
  只有訂單服務  18 個（48.6%）
  只有庫存服務   1 個（ 2.7%）
  兩個都要  18 個（48.6%）
```

這一站從第 00 章到第 09 章，107 個 commit、37 個改了正式程式碼：只動訂單服務的 18 個、**只動庫存服務的 1 個**、兩個都要部署的 18 個。「庫存服務可以自己部署」這件拆分的好處，37 次裡用到 1 次。

這份歷史是寫這一站時的改動，很多本來就是為了切開而做的（Saga、讀模型、韌性），會跨兩邊不奇怪；一個拆完、穩定下來的系統，比例會不一樣。要拿它來判斷，在你自己的系統上，對**拆完、穩定之後**的那一段歷史跑。

六題都還是「不」，帳又是 9.9.1 那個樣子 —— **該合回去。**

幾個常見的、不該當成理由的：

- **「已經花了這麼多力氣拆」**：花掉的已經花掉了。要比的是**從今天起**，維持兩個服務的成本，與合回去的一次成本（9.10 量的那一次）。
- **「合回去就是承認拆錯了」**：拆的時候的判斷，用的是那時候的資訊。0.6 的三個案例 —— Segment 把 140 多個服務合成一個、Istio 把控制平面的五個元件合成一個 `istiod`、Prime Video 把一個監控服務從分散式改回一個行程 —— 都是在拆完、量過之後做的決定（0.6 的 📌：「它們都量了」）。
- **「以後可能還要拆」**：這個專案合回去之後，jar 還是能用三種角色起（第 03 章 3.7），模組的邊界也還在。再拆一次的成本，是這一章的那一套，不是從頭開始。

### 9.9.3 為什麼沒有人敢提

README 的最後一條誤區：「拆完發現不對，卻沒有人敢提『合併回去』—— 因為那聽起來像失敗。」

它聽起來像失敗，是因為「合併回去」常常沒有被當成一條**路**，只被當成一個**結論**。這一章想做的，是讓它變成一條路：

- **有數字**：9.9.1 的帳、9.10 合併前後的量測。「合回去比較好」是一個可以被量、被反駁的主張。
- **有做法**：9.10 的每一步，都是 9.6～9.7 已經演練過的東西倒過來用。
- **有回頭路**：合回去的每一步，也都回得去 —— 跟拆的時候一樣。

把它寫進遷移計畫的第一頁：「如果 ×× 個月後，這幾個數字是這樣，我們合回去」。拆的那一天就寫好，合回去的那一天就不需要有人「敢」。

---

## 9.10 合併回去

### 9.10.1 資料先、程式後

去程是**程式先、資料後**（9.3.4）：資料留在一個地方，程式的那幾步才回得去。回程倒過來 —— **資料先、程式後**，理由一樣：

- 單體只會用本地的 `InventoryApi`（第 03 章 3.7：遠端的那一個只在訂單服務的角色裡）。資料還在庫存服務的庫的時候，單體一起來就是第二個正本 —— 9.2 的兩個正本，換一個方向。
- 所以先把庫存的資料搬回單體的庫，讓三個部署又接同一個庫（9.4 的共用狀態）；這時候程式的那幾步又是免費的：單體起來、權重改回去、兩個服務縮到 0。

| 步 | 去程（9.3.3） | 回程（這一節） |
|---|---|---|
| 資料 | 第 4 步：單體的庫 → 新的庫 | **第 1 步**：新的庫 → 單體的庫 |
| 程式 | 第 1～3 步：服務上線、灰度、單體退場 | **第 2～4 步**：單體上線、權重改回去、服務退場 |

M5 的起點是「拆完、收尾過」的樣子：庫存服務在自己的庫、反方向的搬家程式早就拆了 —— 單體的庫裡那五張庫存的表，停在切換的那一刻。所以搬回去是一次完整的搬家：清空那五張過時的表、回填、追、邊寫邊比、停寫切換，跟 9.6 一樣，方向相反；還沒送出的事件要搬（庫存服務一離開，它的庫就沒有 relay 了，9.6.4）。

```java
            Load load = Load.start(keys, Mig.ENTRY, rate, M5MergeBackTest::anyProduct);
            Mig.sql(Mig.MONO_DB, "SET SESSION foreign_key_checks = 0", "TRUNCATE TABLE inventory_ledger_watermark", "TRUNCATE TABLE inventory_ledger_checkpoints",
                    "TRUNCATE TABLE inventory_ledger", "TRUNCATE TABLE inventory_reservations", "TRUNCATE TABLE inventory");
            Copier back = new Copier(Mig.INV_DB, Mig.MONO_DB);
            back.installCapture();
            long copied = 0;
            for (String t : Copier.TABLES.keySet()) copied += back.backfill(t);
            M4DataSplitTest.Tracker tracker = M4DataSplitTest.Tracker.start(back);
            out.printf("  ② 資料先（第 %.0f 秒）：單體的庫裡過時的五張表清空；搬家程式 %s → %s 回填 %,d 列、開始追%n", load.elapsedMs() / 1000.0, Mig.INV_DB, Mig.MONO_DB, copied);
            out.printf("     邊寫邊比：%s%n", new Verifier(Mig.INV_DB, Mig.MONO_DB).run());
            tracker.stop();
            long freezeAt = load.elapsedMs();
            Cutover.Result cut = Cutover.run(back, Mig.MONO_DB, "3", true, null);
            long liveAt = load.elapsedMs();
            back.dropCapture();
```

### 9.10.2 結果

```
═══ 9.10 合併回去：庫存服務在 shop_d09_inv、訂單服務在 shop_d09_mono、單體縮到 0；反方向的搬家程式已經拆了。每秒 10 張下單 ═══
  ① 拆開的樣子：60 秒下單 [201=601] │ p50 37 ms、p99 649 ms │ 訂單服務呼叫庫存服務 601 次（每張成功的訂單 1.0 次）
     記憶體：inventory-service 2 個 pod 1038 MiB、order-service 1 個 pod 474 MiB；共 1512 MiB
  ② 資料先（第 1 秒）：單體的庫裡過時的五張表清空；搬家程式 shop_d09_inv → shop_d09_mono 回填 2,613 列、開始追
     邊寫邊比：比了 17 段：第一次不一樣 4 段、再比 3 次還是不一樣 0 段（9,426 ms）
     換庫（第 10～39 秒）：停寫 28.7 秒 = 縮到 0 15.4 秒 ＋ 追完 414 筆變更、關掉 0 個洞 138 ms ＋ 搬去重紀錄 2,046 列、還沒送出的事件 34 則、核對 31 ms（不一樣的表：沒有）＋ 換設定、起來 13.1 秒
  ③ 程式後（第 52 秒單體 ready）：權重 50／50 的 30 秒：單體 147 張、5xx 0.0%、超過 500 ms 0.0%、平均 41 ms │ 訂單服務 147 張、5xx 0.0%、超過 500 ms 0.0%、平均 44 ms
     兩條路都在、寫同一個庫：輪流把權重整個切到一邊，各 20 秒、3 輪（交錯量，第 02 章 2.8.4 ④；每一輪切換之後的頭 2 秒不算）
       第 1 輪 兩個服務 │ 下單 201=180      │ p50  35 ms、p99  437 ms
       第 1 輪 單體   │ 下單 201=180      │ p50  32 ms、p99  106 ms
       第 2 輪 單體   │ 下單 201=180      │ p50  31 ms、p99  417 ms
       第 2 輪 兩個服務 │ 下單 201=180      │ p50  36 ms、p99  559 ms
       第 3 輪 兩個服務 │ 下單 201=180      │ p50  37 ms、p99  175 ms
       第 3 輪 單體   │ 下單 201=180      │ p50  27 ms、p99   94 ms
     合計 兩個服務 │ 540 張 │ p50 35 ms、p99 358 ms
     合計 單體   │ 540 張 │ p50 30 ms、p99 188 ms
     權重 100／0 的 15 秒：下單 [201=147]
  ④ 拿掉兩個服務（第 219～248 秒）：下單 [201=385]；②～④ 整段：下單 [201=2406, 503=165]
     ② 換庫停寫的那 28.7 秒：下單 [201=137, 503=150]；每 5 秒：10～15 秒 [201=50]；15～20 秒 [201=50]；20～25 秒 [201=37, 503=13]；25～30 秒 [503=50]；30～35 秒 [503=50]；35～40 秒 [201=3, 503=47]；40～45 秒 [201=45, 503=5]；45～49 秒 [201=37]
     除了 201、503 之外的狀態碼出現在：沒有；訂單服務的 ERROR 日誌：{RemoteInventoryApi：INVENTORY_UNAVAILABLE op=reserve：送了 N 次都沒有回應：I/O error on PUT request for "http://inventor=46, SqlExceptionHelper：Duplicate entry 'N-N' for key 'orders.uk_orders_order_no'=3}
  ⑤ 合併之後：60 秒下單 [201=601] │ p50 26 ms、p99 88 ms │ 訂單服務呼叫庫存服務 0 次（每張成功的訂單 0.0 次）
     記憶體：monolith 1 個 pod 585 MiB；共 585 MiB
     單體的庫：INV-2 對不上的商品 0 個；還在等付款、找不到預留的訂單 0 張
  （結束時 load { 4.46 8.17 8.67 }）
```

- **① 拆開的樣子**：60 秒 601 張全部 201；每一張下單，訂單服務呼叫庫存服務 1.0 次（預留）；三個 pod 的記憶體加起來 1,512 MiB（庫存服務 2 個 pod 1,038 MiB、訂單服務 474 MiB）。
- **② 資料先**：清空單體的庫裡過時的五張表、回填 2,613 列、邊寫邊比 0 段不一樣；換庫停寫 28.7 秒（縮到 0 15.4 秒、起來 13.1 秒；搬了 2,046 列去重紀錄、**34 則還沒送出的事件**），這一段 150 張 503。之後三個部署又接同一個庫。
- **③ 程式後**：單體起來（第 52 秒 ready），權重 50／50 的 30 秒：兩邊都是 0 個 5xx、0 張超過 500 ms。
- **④ 拿掉兩個服務**：權重已經是 100／0，縮到 0 的那一段加上之後 10 秒，385 張全部 201。②～④ 整段的 165 張 503，都在換庫的那一段與它之後的幾秒。
- **⑤ 合併之後**：60 秒 601 張全部 201，服務之間的呼叫 0 次；記憶體 585 MiB；INV-2 0、找不到預留的訂單 0 張。

### 9.10.3 合回去換回了什麼

拿 ① 與 ⑤ 直接比延遲是不公平的：兩次量的時間點不一樣，這台筆電當下的 load、JVM 熱不熱都不一樣（① 的 p99 649 ms、⑤ 的 88 ms，差得比任何合理的推論都多）。所以 ③ 在兩條路都在、寫同一個庫的那一刻，輪流把權重整個切到一邊，交錯量 3 輪（第 02 章 2.8.4 ④ 的做法；每一輪換誰先）：

| | 兩個服務 | 合回去（單體） |
|---|---|---|
| 下單 p50（交錯 3 輪、各 540 張） | 35 ms | 30 ms |
| 下單 p99（同上） | 358 ms | 188 ms |
| 每一張下單，服務之間的呼叫 | 1.0 次 | 0 次 |
| 記憶體（pod 的 working set 加起來） | 1,512 MiB（3 個 pod） | 585 MiB（1 個 pod） |
| 部署（`k8s/base`、`k8s/migrate`） | 兩個 Deployment、兩個 migration Job、兩條 NetworkPolicy、服務之間的 token | 各一個，沒有服務之間的 token |

- **p50 每一輪都是單體比較快**（35／36／37 對 32／31／27 ms），差 5 ms 左右 —— 第 00 章 0.2.1 量到的「多一跳 2.5～3 ms」同一個量級。
- **p99 只能看方向**：同一邊輪與輪就差很多（兩個服務 175～559 ms、單體 94～417 ms）。
- **記憶體的比較要打折**：庫存服務開了 2 個 pod（第 08 章的可用性），單體只開 1 個；正式環境的單體也會開 2 個。一個 pod 一個 pod 比：單體 585 MiB，兩個服務各 474 與 519 MiB 上下 —— 少的主要是「多一個服務就多一個 JVM」。

> ⚠️ **第一版拿 ① 與 ⑤ 比延遲。** M5 第一次跑完，合併之後的 p99 是拆開時的一半不到；那一次這台筆電的 load 在 9 上下（結束時的 5 分鐘平均 9.14），① 與 ⑤ 之間隔了好幾分鐘。改成同一個庫上交錯量。

### 9.10.4 合回去之後，程式碼還留著什麼

這一章只合了**部署與資料**。第 01～08 章為了拆分加進程式碼的東西，在單體裡大多還在、而且還在用：

| 留在單體裡的 | 單體還需要它嗎 |
|---|---|
| 下單的 Saga（`RESERVING`、補償、排程收尾，第 04 章） | 不一定需要：同一個交易就能保證的事，Saga 是多付的代價（4.10.3：單體的下單每張多 3.6～5.1 ms）。拿掉它是一次跟第 04 章一樣大的改動，這一章沒有做 |
| 訂單服務的副本（`stock_levels`，第 05 章） | 單體不讀它，但還在維護它（`StockReplica` 在每一個角色裡都在） |
| `Inbox`、冪等鍵、服務之間的 token、`/internal/**` 的端點 | 單體的角色裡大多不會被走到；留著，是「還能再拆」的成本 |
| 逾時預算、重試預算、熔斷、隔艙（第 06 章） | 呼叫庫存的那幾個用不到；Redis、MySQL、金流的那幾個還有用 |
| 跨服務的追蹤、`ShopServiceGone`、`ShopJobHigh5xxRatio` | 還有用（一個 job 也是 job） |
| 一個 jar、三種角色 | 這是「還能再拆」的那一個選項：拆的成本已經付過了，留著它幾乎不花錢 |

要不要把它們拿掉，是另一個決定：拿掉，單體變簡單；留著，再拆一次的成本是這一章的那一套。**這一章沒有拿掉任何一個。**

📌 **第 09 章寫完之後的追記：量了留下來的有多少，仍然沒有拿掉。** 照章數這一站加進正式程式碼（`src/main`）的行數（`git diff --shortstat`，每一章的分支對上一章的；第 00、01 章是報表、第 12 站的追記與「先拆模組」，不算）：

| 章 | `src/main` | 主要是什麼 | 單體還需要嗎（判斷） |
|---|---|---|---|
| 02 | +338 −13 | 預留 ⇄ 訂單的對帳、建立商品改成事件 | 對帳：同一個庫，一句 JOIN 就夠；建立商品的事件還在用 |
| 03 | +1,011 −27 | 遠端的 `InventoryApi`、內部端點、服務 token、三種角色 | 不需要（`/internal/**` 在單體的角色裡不會被走到） |
| 04 | +629 −147 | 下單的 Saga、補償、`order.rejected` | 不需要，但拿不掉（下面） |
| 05 | +523 −52 | 庫存的副本、熱點名單、旗標搬回庫存 | 副本不需要；旗標的擁有者是模型的修正，留著 |
| 06 | +389 −27 | 逾時預算、重試預算、熔斷、隔艙 | 呼叫庫存的那幾個不需要 |
| 07 | +258 −22 | 跨服務的追蹤 | 需要 |
| 08 | +63 −12 | 通知的租約（bug）、限流認得服務的 token | 租約需要 |
| 09 | +107 −1 | `BootstrapAdmin`（bug）、副本的 readiness | `BootstrapAdmin` 需要 |

逐章加起來，第 02～09 章 +3,318 行（直接比第 01 章與第 09 章的結束是 +3,231：有些行加了又改）；第 03～06 章的 2,552 行，大多是單體用不到的。要拿掉，最難的是第 04 章那一列，因為它不只在程式碼裡：

- **資料裡有它**：`REJECTED` 的訂單已經寫在庫裡、`order_status_history` 記著 `RESERVING`。狀態機要留著這兩個狀態，至少留到那些訂單過了保存期限 —— 跟 `products.hot` 一樣，先不讀不寫、下一次才刪（第 05 章 5.7.9），只是這一次的「下一次」是幾年後。
- **事件的契約裡有它**：`order.rejected` 是庫存那一邊契約的一部分（第 03 章 3.8.6、9.5.8）；只要還有一個消費者認得它，送的那一邊就要繼續送，或者照 9.5.8 的順序先改契約。
- **這一站的實驗靠它**：M1～M12（只開單體的 M6 以外）都要「同一個 jar、三種角色」—— 這是這個 repo 留著它的另一個理由，不是一個正式系統的理由。

所以這一節的結論不變：**拿掉它們是另一個決定**，跟合回去一樣要有一個日期、一個負責的人。它的成本至少是第 04 章那樣大的改動，加上一次資料的收縮。

---

## 9.11 這個專案的結論：拆分決策文件的最後一段

README 的產出第 1 項是一份拆分決策文件。第 00 章寫了第一段（不該拆，0.3.4），第 01 章寫了第二段（如果要拆，第一刀切 notification；庫存第 96 名，不要切，1.5.4），第 03～08 章各補了幾句。這一章寫最後一段：

> **合回去。** 這一站把庫存切出去，是練習台的選擇，不是這個系統的需要（1.5.4）。拆完、量完之後，0.3.2 的六題還是「不」（9.9.2）；拆完之後的 37 個改了正式程式碼的 commit，只動庫存服務的 1 個，兩個服務都要部署的 18 個 —— 獨立部署幾乎沒有被用到。9.9.1 那一欄是這一站付的代價。合回去的那一次（9.10）停寫 28.7 秒、0 張訂單找不到預留；換回的是：下單 p50 少 5 ms、每一張下單少一次服務之間的呼叫、記憶體從 1,512 MiB 變成 585 MiB。
>
> **留下來的**：模組的邊界與守著它的測試（第 12 站）、outbox 與冪等的消費（第 12 站第 07 章）、逾時與熔斷、跨行程的追蹤、K8s 上的部署與入口 —— 它們在單體裡一樣有用。一個 jar、三種角色也留著：再拆一次的成本，已經付過一半。
>
> **什麼時候再拆**：0.3.2 的某一題翻過來的時候 —— 而且先拆那一題指到的那一塊（0.3.2 的 📌），不是庫存。

這一段不是這一站的「答案」，是這一站的**方法**的一個例子：同一組問題，拆之前問一次，拆完之後再問一次，每一次後面都接著數字。

---

## 9.12 流程測試與追溯表

### 9.12.1 這一章新增的測試與實驗

| 名稱 | 種類 | 跑在哪裡 | 守什麼／量什麼 |
|---|---|---|---|
| `BootstrapAdminRaceTest` | 測試（2 個） | Testcontainers | 兩個行程同時第一次啟動：別人剛建好管理員，不是錯；email 被不是管理員的帳號用掉，還是錯（9.4.3） |
| `StockReplicaHealthIndicatorTest` | 測試（4 個） | 單元（Mockito） | 副本不完整 → 重建、重建好之前 DOWN；失敗會再試；重建完還缺也不會永遠 DOWN（9.4.4） |
| `StockReplicaTest` | 測試（多 1 個） | Testcontainers | `missing()` 那一句 SQL（9.4.4） |
| `alerts_test.yml` | promtool（多 2 組） | Docker | `ShopJobHigh5xxRatio`：灰度的稀釋；只錯一陣子不響（9.5.2） |
| M1 `M1NaiveCanaryTest` | 實驗 | kind、第 02 章的搬家程式 | 9.2 |
| M2 `M2CanaryTest` | 實驗 | kind | 9.4.4、9.5 |
| M3 `M3StickyTest` | 實驗 | kind | 9.5.4 |
| M4 `M4DataSplitTest` | 實驗 | kind、搬家程式、`Verifier`、`Cutover` | 9.6、9.7 |
| M5 `M5MergeBackTest` | 實驗 | kind、搬家程式、`Verifier`、`Cutover` | 9.10 |
| `scripts/d09-deploy-coupling.sh` | 量測 | git 的歷史 | 9.9.2 |
| 第 04 章的 E4、第 01 章的 B1 | 實驗（重跑） | —— | 9.12.2 |

預設的測試從第 08 章的 368 個變成 375 個（9.13）。

### 9.12.2 E4、B1 重跑

使用者的一天（第 04 章的 E4）：

```
  訂單服務 → 庫存服務：14 次 HTTP、7 種端點（第 03 章：38 次、10 種）
    POST /api/orders → POST /internal/inventory/v1/hot-gate                                              × 2
    POST /api/orders → PUT /internal/inventory/v1/reservations/{n}                                       × 6
    POST /api/seller/orders/{orderNo}/ship → GET /internal/inventory/v1/reservations/{n}/shippable       × 2
    POST /api/seller/products/{id}/hot → PUT /internal/inventory/v1/products/{n}/hot                     × 1
    POST /api/seller/products/{id}/restock → GET /internal/inventory/v1/stock                            × 1
    POST /api/seller/products/{id}/restock → POST /internal/inventory/v1/products/{n}/restocks           × 1
    排程 ReservationReconciliation.run → GET /internal/inventory/v1/reservations                           × 1
```

跟第 08 章一樣：14 次 HTTP、7 種端點。這一章沒有改任何一次服務之間的呼叫。

B1（第 01 章的邊界地圖）：

```
     9 │ catalog+inventory                   │          0 │          0 │        9 │        1 │    5 │  25.0%（9）
    24 │ inventory                           │          0 │          0 │       10 │        0 │    7 │  22.2%（8）
```

跟第 08 章一樣：庫存這一刀的同步呼叫 10 種、第 24 名。這一章改的 `BootstrapAdmin`（account）、`StockReplica`（catalog）都在模組裡面，沒有新的跨模組呼叫。

### 9.12.3 追溯表：這一站的產出（最後一次）

| README 的產出 | 在哪幾章 | 第 09 章加上的 |
|---|---|---|
| 1. 拆分決策文件 | 00（不該拆）、01（第一刀切 notification；庫存第 96 名）、03～08（每一章的取捨） | **最後一段：合回去**（9.11）；這一站的帳（9.9.1）；拆完之後的部署耦合（9.9.2） |
| 2. 庫存拆成獨立服務、下單改成 Saga | 02（獨立的資料庫、對帳、搬家）、03（正式的服務、契約）、04（Saga、補償、不可補償的清單、注入失敗的演練）、05～08 | **怎麼把正式環境搬過去、怎麼回來**：程式先、資料後；灰度、雙跑比對、回滾；邊寫邊對帳、停寫切換、反方向的搬家程式（9.4～9.7）；合回去（9.10） |
| 　拆分前後的下單延遲對照（p50／p99） | 00（K1）、04（E5、E9） | kind 上、同一個庫、交錯量：兩個服務 p50 35／p99 358 ms，單體 30／188 ms（9.10） |
| 3. 跨服務報表：API 組合版與讀模型版、過時視窗 | 05（報表本身沒有實作新的方案，5.8：API 組合與讀模型做在商品頁、購物車、賣家的列表）| 新的路的讀模型要先建好（9.4.4）；同一個人來回兩邊會看到倒退（9.5.4） |
| 4. 一條完整的 trace、一次排查紀錄 | 07、08（入口 → 訂單 → MQ → 庫存） | （沒有改） |
| 5. 基礎設施選型文件 | 08 | 入口的權重是每一個請求挑一次（9.5.1）；告警要能分開兩邊（9.5.2） |

---

## 9.13 本章完成後的專案

```
（d09，相對於 d08）
k8s/
├── base/monolith.yaml        單體：同一個映像檔、prod（9.2）
├── base/config.yaml          單體的 ConfigMap
├── base/network-policy.yaml  單體也只收入口
├── migrate/jobs.yaml         migrate-monolith；三個 Job 各帶 migrate 標籤（9.4.2）
├── gateway/routes.yaml       兩個 backend 各帶權重；Shop-Route（9.5）
└── kind/                     shop_d09_*、Redis 3／2、vhost shop_d09；兩個服務接單體的庫（9.4.1）
scripts/d09-kind.sh, scripts/d09-deploy-coupling.sh
docker/prometheus/alerts.yml, alerts_test.yml          ShopJobHigh5xxRatio
src/main/java/com/example/shop/
├── account/internal/BootstrapAdmin.java               兩個行程同時第一次啟動（9.4.3）
└── catalog/internal/StockReplica.java、StockReplicaHealthIndicator.java    副本不完整就重建（9.4.4）
src/main/resources/application-order-service.yml       readiness 多一個 stockReplica
src/test/java/com/example/shop/
├── dist09/                   M1～M5、Mig、Verifier、Cutover
├── dist02/Copier.java        改成 public
├── dist08/Load.java          可以指定每一張買哪一個商品
├── account/internal/BootstrapAdminRaceTest.java
└── catalog/internal/StockReplicaHealthIndicatorTest.java、StockReplicaTest.java
```

```
TEST_INFRA testcontainers 啟動 9,886 ms：mysql jdbc:mysql://localhost:55638/shop、redis localhost:55627、rabbitmq localhost:55637
TEST_INFRA MySQL 最多同時 37 條連線（max_connections 151）
[INFO] Tests run: 375, Failures: 0, Errors: 0, Skipped: 0
TEST_INFRA testcontainers 啟動 10,798 ms：mysql jdbc:mysql://localhost:57426/shop、redis localhost:57416、rabbitmq localhost:57424
TEST_INFRA MySQL 最多同時 5 條連線（max_connections 151）
[INFO] Tests run: 39, Failures: 0, Errors: 0, Skipped: 0
[INFO] BUILD SUCCESS
[INFO] Total time:  06:16 min
```

這一章的整套測試跑了兩次，都是 `mvn clean verify`、都在最後的 commit 上：

- **第一次**：最後一輪實驗之前。375 個、failsafe 39 個，全綠，6 分 38 秒。
- **第二次是上面那一份**：最後一輪的最後一步（M1 跑在第一個 commit 上，M2～M5、E4、B1 跑在這一個 commit 上）。

途中另外跑過幾次子集，沒有算在上面：

| 子集 | 結果 |
|---|---|
| `BootstrapAdminRaceTest`，修正之前 | 紅 1 個（`DuplicateKeyException`），這是要它紅的 |
| 修正之後：`BootstrapAdminRaceTest`、`AuthApiTest`，14 個 | 全綠 |
| `StockReplicaHealthIndicatorTest`、`StockReplicaTest`，7 個 | 全綠 |
| promtool：拿掉 `ShopJobHigh5xxRatio` 的 1 分鐘窗（在暫存的副本上） | 「只錯一陣子」那一組紅 —— 證明它測的是那個窗 |

第 12 站的專案也修了同一個 bug（`BootstrapAdmin`）：測試先紅、修正之後整套 235 個全綠（第 12 站 5.10 的追記）。

### 9.13.1 本章其餘檔案的完整內容

**`src/main/java/com/example/shop/account/internal/BootstrapAdmin.java`**（9.4.3）

```diff
 import org.slf4j.LoggerFactory;
 import org.springframework.boot.ApplicationArguments;
 import org.springframework.boot.ApplicationRunner;
+import org.springframework.dao.DuplicateKeyException;
 import org.springframework.security.crypto.password.PasswordEncoder;
 import org.springframework.stereotype.Component;
 import org.springframework.transaction.support.TransactionTemplate;
…
 /**
  * 5.10 US-ACC-3 AC-3：第一個管理員由環境變數建立，程式碼裡沒有任何預設帳密。
  * 資料庫裡已經有管理員 → 什麼都不做（環境變數之後可以拿掉）；一個都沒有、又沒給環境變數 → 啟動失敗（1.7.4：缺設定就起不來）。
+ * 13 站 9.4.3：兩個行程同時第一次啟動，只有一個建得成；另一個看到「已經有了」就照常起來。
  */
 @Component
 class BootstrapAdmin implements ApplicationRunner {
…
         int bytes = password.getBytes(StandardCharsets.UTF_8).length;
         if (password.length() < 12 || bytes > 72)
             throw new IllegalStateException("SHOP_BOOTSTRAP_ADMIN_PASSWORD 至少 12 個字元、最多 72 bytes");
-        long id = tx.execute(s -> accounts.insert(email, encoder.encode(password), "管理員", Role.ADMIN, null));
+        long id;
+        try {
+            id = tx.execute(s -> accounts.insert(email, encoder.encode(password), "管理員", Role.ADMIN, null));
+        } catch (DuplicateKeyException race) {
+            // 13 站 9.4.3：另一個行程同時對同一個庫第一次啟動（遷移期間單體與訂單服務接同一個庫；或兩台同時第一次部署）——
+            // 兩邊都看到「沒有管理員」、都去建，輸的這一邊撞到 uk_users_email。第一版就這樣起不來（BootstrapAdminRaceTest）。
+            // 別人剛建好就是建好了；email 被一個不是管理員的帳號用掉了，才是真的錯，照舊起不來
+            if (accounts.adminCount() == 0) throw race;
+            log.info("BOOTSTRAP_ADMIN_EXISTS email={}：另一個行程剛建好", Email.mask(email));
+            return;
+        }
         log.warn("BOOTSTRAP_ADMIN_CREATED id={} email={}（請把 SHOP_BOOTSTRAP_ADMIN_PASSWORD 從部署設定中移除）", id, Email.mask(email));
     }
 }
```

**`src/main/java/com/example/shop/catalog/internal/StockReplica.java`**（9.4.4）

```diff
         return new Rebuilt(pages, products, (System.nanoTime() - t0) / 1_000_000);
     }
 
+    /** 13 站 9.4.4：有幾個商品在副本裡還沒有一列（StockReplicaHealthIndicator 看它決定要不要重建） */
+    long missing() {
+        return jdbc.queryForObject("SELECT COUNT(*) FROM products p WHERE NOT EXISTS (SELECT 1 FROM stock_levels s WHERE s.product_id = p.id)", Long.class);
+    }
+
     // ───────── 讀 ─────────
 
     Map<Long, Integer> available(Collection<Long> productIds) {
```

**`src/main/java/com/example/shop/catalog/internal/StockReplicaHealthIndicator.java`**（9.4.4）

```java
package com.example.shop.catalog.internal;

import com.example.shop.shared.config.ConditionalOnServiceRole;
import com.example.shop.shared.config.ServiceRole;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.actuate.health.Health;
import org.springframework.boot.actuate.health.HealthIndicator;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;

import java.time.Duration;

/**
 * 13 站 9.4.4：訂單服務的庫存副本（5.4）要先完整，才接流量。
 *
 * 第 05 章 5.6.4 說：副本是空的時候，每一個商品頁都說 0 件；「部署之後打一次重建」是部署流程的一步，要讓還沒建好的訂單服務不接流量是 readiness 的事。
 * 9.4.4 在灰度之前量到了它：接著單體的庫上線的訂單服務，副本裡只有「單體這段時間改過庫存」的那幾個商品（單體也維護這張表，StockReplica 的說明）——
 * 其他的商品，灰度的買家會看到 0 件。
 *
 * 所以：起來之後先數「有幾個商品不在副本裡」。有 → 自己重建（不用有人記得去打 /api/admin/stock-levels/rebuild），重建完成之前 readiness 是 DOWN：
 * 不在 Service 的 endpoints 裡，入口的權重給了它也分不到。重建失敗（庫存服務還沒起來）→ 過一會兒再試。
 * 重建完一次就算數，不再看「還缺幾個」：快照裡沒有的商品（庫存那一邊沒有那一列）重建幾次都不會有 —— 拿它當條件，訂單服務就永遠起不來。
 * 之後的新商品由事件補上（product-created → 庫存建一列 → stock-changed）。
 *
 * application-order-service.yml 把它放進 readiness 的 group（management.endpoint.health.group.readiness.include）。
 */
@Component
@ConditionalOnServiceRole(ServiceRole.ORDER_SERVICE)
class StockReplicaHealthIndicator implements HealthIndicator {

    private static final Logger log = LoggerFactory.getLogger(StockReplicaHealthIndicator.class);
    static final Duration RETRY = Duration.ofSeconds(5);

    private final StockReplica replica;
    private final Duration retry;
    private volatile boolean complete;
    private volatile String state = "還沒檢查";

    @Autowired
    StockReplicaHealthIndicator(StockReplica replica) { this(replica, RETRY); }

    StockReplicaHealthIndicator(StockReplica replica, Duration retry) {
        this.replica = replica;
        this.retry = retry;
    }

    @Override
    public Health health() {
        return (complete ? Health.up() : Health.down()).withDetail("replica", state).build();
    }

    @EventListener(ApplicationReadyEvent.class)
    void onReady() {
        Thread.ofVirtual().name("stock-replica-check").start(this::ensureComplete);
    }

    /** 起來之後跑一次：缺的話重建，直到成功一次 */
    void ensureComplete() {
        while (!complete) {
            try {
                long missing = replica.missing();
                if (missing == 0) {
                    state = "完整";
                } else {
                    state = "缺 " + missing + " 個商品，重建中";
                    StockReplica.Rebuilt r = replica.rebuild(500);
                    long left = replica.missing();
                    state = "重建過：缺 " + missing + " 個 → 寫了 " + r.products() + " 個（" + r.millis() + " ms）" + (left > 0 ? "，還缺 " + left + " 個（庫存那一邊沒有）" : "");
                    log.info("STOCK_REPLICA_REBUILT missing={} products={} millis={} left={}", missing, r.products(), r.millis(), left);
                }
                complete = true;
            } catch (RuntimeException e) {
                state = "重建失敗，" + retry.toMillis() + " ms 後再試：" + e;
                log.warn("STOCK_REPLICA_REBUILD_FAILED {}", e.toString());
                try { Thread.sleep(retry); } catch (InterruptedException ie) { return; }
            }
        }
    }
}
```

**`k8s/base/monolith.yaml`**（9.2）

```yaml
# 13 站第 09 章：單體（第 12 站的那一個，九個模組在同一個行程、同一個庫）。遷移從這裡開始：
# 入口把 /api/** 全部送給它（k8s/gateway 的權重），兩個服務在旁邊等著接手。跟兩個服務是同一個映像檔，只差 profile（第 03 章 3.7）
apiVersion: apps/v1
kind: Deployment
metadata:
  name: monolith
  labels: {app: monolith, system: shop}
spec:
  replicas: 1
  selector:
    matchLabels: {app: monolith}
  strategy:
    type: RollingUpdate
    rollingUpdate: {maxSurge: 1, maxUnavailable: 0}
  template:
    metadata:
      labels: {app: monolith, system: shop}
    spec:
      terminationGracePeriodSeconds: 40
      containers:
        - name: app
          image: shop:latest
          envFrom:
            - configMapRef: {name: shop-common}
            - configMapRef: {name: monolith}
            - secretRef: {name: shop-secrets}
          ports:
            - {name: http, containerPort: 8080}
            - {name: management, containerPort: 8081}
          startupProbe:
            httpGet: {path: /actuator/health/liveness, port: management}
            periodSeconds: 2
            failureThreshold: 90
          readinessProbe:
            httpGet: {path: /actuator/health/readiness, port: management}
            periodSeconds: 5
            failureThreshold: 2
          livenessProbe:
            httpGet: {path: /actuator/health/liveness, port: management}
            periodSeconds: 10
            failureThreshold: 3
          lifecycle:
            preStop:
              sleep: {seconds: 10}
          resources:
            requests: {cpu: 250m, memory: 768Mi}
            limits: {memory: 768Mi}                  # 九個模組都在這裡：比一個服務多一點（compose 上量到最高 640～670 MiB，第 12 站 9.6）
---
apiVersion: v1
kind: Service
metadata:
  name: monolith
  labels: {app: monolith, system: shop}
spec:
  selector: {app: monolith}
  ports:
    - {name: http, port: 8080, targetPort: http}
```

**`k8s/base/config.yaml`**（9.2）

```diff
   SHOP_RABBIT_HOST: rabbitmq
   SHOP_OTLP_ENDPOINT: http://otel-collector.observability:4318/v1/traces
 ---
+# 13 站第 09 章：單體。跟訂單服務一樣在入口後面（trace 的信任、X-Forwarded-For 的兩個值相同）
+apiVersion: v1
+kind: ConfigMap
+metadata:
+  name: monolith
+  labels: {stage: config}
+data:
+  SPRING_PROFILES_ACTIVE: prod
+  SHOP_DB_NAME: shop
+  SHOP_DEPLOYMENT_EDGE_TRUST_TRACEPARENT: "true"
+  SERVER_FORWARD_HEADERS_STRATEGY: native
+---
 apiVersion: v1
 kind: ConfigMap
 metadata:
```

**`k8s/base/kustomization.yaml`**（9.2）

```diff
   - namespace.yaml
   - dependencies.yaml
   - config.yaml
+  - monolith.yaml
   - inventory-service.yaml
   - order-service.yaml
   - prometheus-access.yaml
```

**`k8s/base/network-policy.yaml`**（9.2）

```diff
     - from:
         - namespaceSelector: {matchLabels: {kubernetes.io/metadata.name: observability}}
       ports: [{port: 8081}]
+---
+# 13 站第 09 章：單體跟訂單服務一樣，只有入口連得到 8080
+apiVersion: networking.k8s.io/v1
+kind: NetworkPolicy
+metadata:
+  name: monolith
+spec:
+  podSelector: {matchLabels: {app: monolith}}
+  policyTypes: [Ingress]
+  ingress:
+    - from:
+        - namespaceSelector: {matchLabels: {kubernetes.io/metadata.name: envoy-gateway-system}}
+          podSelector: {matchLabels: {gateway.envoyproxy.io/owning-gateway-name: shop}}
+      ports: [{port: 8080}]
+    - from:
+        - namespaceSelector: {matchLabels: {kubernetes.io/metadata.name: observability}}
+      ports: [{port: 8081}]
```

**`k8s/migrate/jobs.yaml`**（9.2、9.4.2）

```diff
 kind: Job
 metadata:
   name: migrate-inventory
+  labels: {migrate: inventory}
 spec:
   backoffLimit: 3
   template:
…
 kind: Job
 metadata:
   name: migrate-order
+  labels: {migrate: order}
 spec:
   backoffLimit: 3
   template:
…
                  "-connectRetries=10", "migrate"]
           volumeMounts: [{name: migrations, mountPath: /migrations}]
       volumes: [{name: migrations, emptyDir: {}}]
+---
+# 13 站第 09 章：單體跑每一個資料夾（第 12 站的 migrate：一個庫、全部的表）
+apiVersion: batch/v1
+kind: Job
+metadata:
+  name: migrate-monolith
+  labels: {migrate: monolith}
+spec:
+  backoffLimit: 3
+  template:
+    spec:
+      restartPolicy: Never
+      initContainers:
+        - name: copy
+          image: shop:latest
+          command: ["cp", "-r", "/app/BOOT-INF/classes/db/migration/.", "/migrations/"]
+          volumeMounts: [{name: migrations, mountPath: /migrations}]
+      containers:
+        - name: flyway
+          image: flyway/flyway:9.22.3
+          env:
+            - name: DB_NAME
+              valueFrom: {configMapKeyRef: {name: monolith, key: SHOP_DB_NAME}}
+          envFrom:
+            - secretRef: {name: shop-migrator}
+          args: ["-url=jdbc:mysql://mysql:3306/$(DB_NAME)?allowPublicKeyRetrieval=true&useSSL=false", "-user=$(FLYWAY_USER)", "-password=$(FLYWAY_PASSWORD)",
+                 "-locations=filesystem:/migrations/account,filesystem:/migrations/cart,filesystem:/migrations/catalog,filesystem:/migrations/inventory,filesystem:/migrations/notification,filesystem:/migrations/ordering,filesystem:/migrations/payment,filesystem:/migrations/shared",
+                 "-connectRetries=10", "migrate"]
+          volumeMounts: [{name: migrations, mountPath: /migrations}]
+      volumes: [{name: migrations, emptyDir: {}}]
```

**`k8s/kind/kustomization.yaml`**（9.2、9.4.1）

```diff
 #   映像檔：docker build 出來、kind load 進去的 shop:d08（imagePullPolicy 預設 IfNotPresent：不會去 registry 拉）
 #   外部依賴：compose 的 MySQL、Redis、RabbitMQ，在 host.docker.internal（Docker Desktop 讓容器連得到這台筆電）
 #   資料庫、Redis 的 database、RabbitMQ 的 vhost：這一章自己的，不碰第 12 站的 shop
+#   13 站第 09 章：單體在 shop_d09_mono。兩個服務先接單體的庫與 Redis（9.4：程式先搬、資料最後搬）——
+#   第一版照第 02 章 2.8.5 的計畫，庫存服務一開始就接 shop_d09_inv：灰度的那一段有兩個寫入者（9.2）
 #   秘密：只在本機用的值（正式環境由部署平台注入，不在 repo 裡）
 apiVersion: kustomize.config.k8s.io/v1beta1
 kind: Kustomization
…
   - ../base
 images:
   - name: shop
-    newTag: d08
+    newTag: d09
 secretGenerator:
   - name: shop-secrets
     namespace: shop
…
       - {op: replace, path: /spec/externalName, value: host.docker.internal}
   - target: {kind: ConfigMap, name: shop-common}
     patch: |-
-      - {op: add, path: /data/SPRING_RABBITMQ_VIRTUAL_HOST, value: shop_d08}
+      - {op: add, path: /data/SPRING_RABBITMQ_VIRTUAL_HOST, value: shop_d09}
+  - target: {kind: ConfigMap, name: monolith}
+    patch: |-
+      - {op: replace, path: /data/SHOP_DB_NAME, value: shop_d09_mono}
+      - {op: add, path: /data/SPRING_DATA_REDIS_DATABASE, value: "3"}
   - target: {kind: ConfigMap, name: order-service}
     patch: |-
-      - {op: replace, path: /data/SHOP_DB_NAME, value: shop_d08_order}
-      - {op: add, path: /data/SPRING_DATA_REDIS_DATABASE, value: "7"}
+      - {op: replace, path: /data/SHOP_DB_NAME, value: shop_d09_mono}
+      - {op: add, path: /data/SPRING_DATA_REDIS_DATABASE, value: "3"}
   - target: {kind: ConfigMap, name: inventory-service}
     patch: |-
-      - {op: replace, path: /data/SHOP_DB_NAME, value: shop_d08_inv}
-      - {op: add, path: /data/SPRING_DATA_REDIS_DATABASE, value: "6"}
+      - {op: replace, path: /data/SHOP_DB_NAME, value: shop_d09_mono}
+      - {op: add, path: /data/SPRING_DATA_REDIS_DATABASE, value: "3"}
```

**`k8s/kind/migrate/kustomization.yaml`**（9.2）

```diff
   - ../../migrate
 images:
   - name: shop
-    newTag: d08
+    newTag: d09
 secretGenerator:
   - name: shop-migrator
     namespace: shop
```

**`scripts/d09-kind.sh`**（9.2、9.4.2）

```bash
#!/usr/bin/env bash
# 13 站第 09 章：遷移。cluster、入口的控制器、觀測沿用第 08 章（scripts/d08-kind.sh cluster | gateway-api | observability | down），
# 這一支只管這一章的部署：單體、兩個服務、兩個庫。
#   image       docker build 映像檔 shop:d09，kind load 進 cluster
#   databases   這一章自己的兩個庫（shop_d09_mono、shop_d09_inv）、Redis 3／2、vhost shop_d09 —— 每一次都清空重建
#   deploy      設定 → migration（單體的庫，每一個資料夾）→ 單體與兩個服務（9.4：兩個服務也接單體的庫）
#   gateway     入口（k8s/gateway）：/api/** 照權重分給單體與訂單服務
# 用法：scripts/d09-kind.sh image | databases | deploy | gateway
set -euo pipefail
cd "$(dirname "$0")/.."

KIND=${KIND:-kind}
CTX=kind-d08
k() { kubectl --context "$CTX" "$@"; }

case "${1:-}" in
  image)
    docker build -q -t shop:d09 .
    "$KIND" load docker-image shop:d09 --name d08
    ;;
  databases)
    for db in shop_d09_mono shop_d09_inv; do
      docker compose exec -T mysql mysql -uroot -proot -e \
        "DROP DATABASE IF EXISTS $db; CREATE DATABASE $db; GRANT ALL PRIVILEGES ON \`$db\`.* TO 'shop_migrator'@'%' WITH GRANT OPTION;" 2>&1 | grep -v "Using a password" || true
    done
    docker compose exec -T redis sh -c 'redis-cli -n 3 flushdb && redis-cli -n 2 flushdb' > /dev/null
    curl -sf -u shop:shop -X DELETE http://localhost:15672/api/vhosts/shop_d09 || true
    curl -sf -u shop:shop -X PUT http://localhost:15672/api/vhosts/shop_d09
    curl -sf -u shop:shop -X PUT -H 'Content-Type: application/json' -d '{"configure":".*","write":".*","read":".*"}' \
      http://localhost:15672/api/permissions/shop_d09/shop
    ;;
  deploy)
    k apply -k k8s/kind -l stage=config
    k -n shop delete job migrate-monolith migrate-inventory migrate-order --ignore-not-found
    # 9.4：三個都接單體的庫的時候，只有單體的 Job 跑 migration —— 訂單服務的 Job 只認得七個資料夾，在這個庫上驗證就失敗
    # （Detected applied migration not resolved locally）。notin：沒有這個標籤的（kustomize 產生的 Secret）也算
    k apply -k k8s/kind/migrate -l 'migrate notin (order,inventory)'
    k -n shop wait --for=condition=complete job/migrate-monolith --timeout=180s
    k apply -k k8s/kind
    for d in monolith inventory-service order-service; do k -n shop rollout status "deploy/$d" --timeout=300s; done
    ;;
  gateway)
    k -n shop delete service order-service-nodeport --ignore-not-found
    k apply -k k8s/gateway
    k -n shop wait --for=condition=Programmed gateway/shop --timeout=180s
    ;;
  *)
    sed -n '2,9p' "$0"; exit 1
    ;;
esac
```

**`docker/prometheus/alerts_test.yml`**（9.5.2）

```diff
           - exp_labels: {severity: page, job: inventory-service}
             exp_annotations: {summary: "inventory-service 一個能抓到指標的實例都沒有", why: "整個服務不見了（縮到 0、每一台都起不來），或每一台都抓不到"}
       - {eval_time: 5m30s, alertname: ShopDown, exp_alerts: []}             # target 消失，不是 down：第 12 站那一條不會響
-
+  # 13 站 9.5.2：灰度。單體每 15 秒 1,900 個 /api/**（沒有錯）；訂單服務分到 5%：每 15 秒 100 個，其中 10 個 503
+  #   全站 10 / 2,000 = 0.5%：ShopHigh5xxRatio 不響；訂單服務自己 10%：ShopJobHigh5xxRatio 響，而且說是哪一邊
+  - interval: 15s
+    input_series:
+      - series: 'http_server_requests_seconds_count{job="monolith",system="shop",status="201",uri="/api/orders"}'
+        values: '0+1900x60'
+      - series: 'http_server_requests_seconds_count{job="order-service",system="shop",status="201",uri="/api/orders"}'
+        values: '0+90x60'
+      - series: 'http_server_requests_seconds_count{job="order-service",system="shop",status="503",uri="/api/orders"}'
+        values: '0+10x60'
+    alert_rule_test:
+      - {eval_time: 6m, alertname: ShopHigh5xxRatio, exp_alerts: []}
+      - {eval_time: 4m, alertname: ShopJobHigh5xxRatio, exp_alerts: []}
+      - eval_time: 6m
+        alertname: ShopJobHigh5xxRatio
+        exp_alerts:
+          - exp_labels: {severity: page, job: order-service}
+            exp_annotations: {summary: "order-service 的 5xx 超過 1%（10%），持續 5 分鐘", why: "13 站 9.5.2：灰度時新的那一邊的錯誤，在全站的比例裡會被稀釋。正在灰度的話：先把權重調回去，再查"}
+  # 9.5.2 新的那一邊只錯了一陣子：每 15 秒 1 個請求，第 1～3 分鐘有 9 個 503，之後沒有了。5 分鐘窗到第 6 分半還算得到它們，
+  #   1 分鐘窗在第 3 分多鐘就乾淨了 —— 不響（只有 5 分鐘窗的話，第 6 分鐘會響）
+  - interval: 15s
+    input_series:
+      - series: 'http_server_requests_seconds_count{job="order-service",system="shop",status="201",uri="/api/orders"}'
+        values: '0+1x40'
+      - series: 'http_server_requests_seconds_count{job="order-service",system="shop",status="503",uri="/api/orders"}'
+        values: '0 0 0 0 0+1x8 9+0x28'
+    alert_rule_test:
+      - {eval_time: 6m30s, alertname: ShopJobHigh5xxRatio, exp_alerts: []}
```

**`src/test/java/com/example/shop/dist09/Mig.java`**（9.2 之後每一個 M 實驗）

```java
package com.example.shop.dist09;

import com.example.shop.dist00.SplitLab;
import com.example.shop.dist07.Calls;
import com.example.shop.dist08.Kube;
import com.fasterxml.jackson.databind.JsonNode;

import java.sql.Connection;
import java.sql.Statement;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

/**
 * 13 站第 09 章的實驗支架：kind 上的單體與兩個服務（scripts/d09-kind.sh 起的那一組；cluster 是第 08 章的 d08）。
 * 入口照權重把 /api/** 分給單體與訂單服務（k8s/gateway/routes.yaml）；實驗用 kubectl patch 改權重、縮放、換庫。
 */
public final class Mig {

    public static final String MONO_DB = "shop_d09_mono", INV_DB = "shop_d09_inv";
    public static final int ENTRY = Kube.ENTRY;

    private Mig() {}

    public static String script(String step) throws Exception {
        return Kube.sh("env", "KIND=" + System.getProperty("d08.kind", "kind"), "scripts/d09-kind.sh", step);
    }

    /**
     * 清空兩個庫、Redis、vhost，跑 migration；單體重開、種 1,000 個商品與庫存（在單體的庫），兩個服務才重開 ——
     * 單體先帶著資料在跑，新的服務後來才起來（正式環境的順序）。
     * 第一版先重開三個、最後才種資料：訂單服務起來時商品表是空的，副本的檢查（StockReplicaHealthIndicator）說「完整」，之後種的商品它不知道
     */
    public static void fresh() throws Exception {
        script("databases");
        script("deploy");
        Kube.kubectl("rollout", "restart", "deploy/monolith");
        Kube.kubectl("rollout", "status", "deploy/monolith", "--timeout=300s");
        SplitLab.seed(MONO_DB, true, true);
        Kube.kubectl("rollout", "restart", "deploy/inventory-service", "deploy/order-service");
        for (String d : List.of("monolith", "inventory-service", "order-service")) Kube.kubectl("rollout", "status", "deploy/" + d, "--timeout=300s");
        Kube.waitFor(() -> List.of("monolith", "inventory-service", "order-service").stream().allMatch(Mig::settled), 120);
    }

    /** 這個 app 沒有正在結束的 pod */
    static boolean settled(String app) {
        try { return Kube.pods(app).stream().noneMatch(Kube.Pod::terminating); } catch (Exception e) { return false; }
    }

    /** 入口的權重：/api/** 給單體 mono、給訂單服務 order（相對的比例） */
    public static void weights(int mono, int order) throws Exception {
        Kube.kubectl("patch", "httproute/shop-api", "--type=json", "-p",
                "[{\"op\":\"replace\",\"path\":\"/spec/rules/0/backendRefs/0/weight\",\"value\":" + mono + "},"
                        + "{\"op\":\"replace\",\"path\":\"/spec/rules/0/backendRefs/1/weight\",\"value\":" + order + "}]");
    }

    /**
     * 入口的 Envoy 實際的設定：/api/** 那一條規則的 cluster 裡，每一個 locality 的權重與位址（Envoy 的 admin：/config_dump?include_eds）。
     * Envoy 的映像檔裡沒有 curl、wget：port-forward 到這台筆電來讀
     */
    public static String envoyLocalities() throws Exception {
        String pod = Kube.sh("kubectl", "--context", Kube.CTX, "-n", "envoy-gateway-system", "get", "pods", "-l", "gateway.envoyproxy.io/owning-gateway-name=shop",
                "-o", "jsonpath={.items[0].metadata.name}").trim();
        Process pf = new ProcessBuilder("kubectl", "--context", Kube.CTX, "-n", "envoy-gateway-system", "port-forward", "pod/" + pod, "19001:19000")
                .redirectErrorStream(true).start();
        try {
            Thread.sleep(2_000);
            String dump = Kube.sh("curl", "-s", "http://127.0.0.1:19001/config_dump?include_eds&resource=dynamic_endpoint_configs");
            List<String> out = new java.util.ArrayList<>();
            for (JsonNode c : Calls.JSON.readTree(dump).path("configs")) {
                JsonNode e = c.path("endpoint_config");
                if (!e.path("cluster_name").asText().equals("httproute/shop/shop-api/rule/0")) continue;
                for (JsonNode l : e.path("endpoints")) {
                    List<String> ips = new java.util.ArrayList<>();
                    for (JsonNode h : l.path("lb_endpoints")) ips.add(h.path("endpoint").path("address").path("socket_address").path("address").asText());
                    out.add(l.path("locality").path("region").asText().replaceAll(".*/", "backend ") + " 權重 " + l.path("load_balancing_weight").asInt() + " " + ips);
                }
            }
            return "cluster httproute/shop/shop-api/rule/0：" + String.join("；", out);
        } finally {
            pf.destroy();
        }
    }

    /** 縮放到 n 台，等到 n 台都 ready、沒有正在結束的 pod */
    public static void scale(String app, int n) throws Exception {
        Kube.kubectl("scale", "deploy/" + app, "--replicas=" + n);
        Kube.kubectl("rollout", "status", "deploy/" + app, "--timeout=300s");
        Kube.waitFor(() -> settled(app) && Kube.pods(app).stream().filter(Kube.Pod::ready).count() == n, 300);
    }

    /** 這個 app 的每一個 pod，到現在為止收到幾個 POST /api/orders（http_server_requests 的 count，pod 不在了就沒有） */
    public static long placements(String app) throws Exception {
        long n = 0;
        for (Kube.Pod p : Kube.pods(app)) {
            double v = Kube.sum(Kube.metrics(p.name()), "http_server_requests_seconds_count", "uri=\"/api/orders\"", "method=\"POST\"");
            if (!Double.isNaN(v)) n += (long) v;
        }
        return n;
    }

    /** 一個 app 的每一個 pod 收到的 POST /api/orders：幾張、5xx 幾張、超過 500 ms 幾張（SLO 的桶，第 12 站 9.9）、加起來花了幾秒 */
    public record Http(long count, long errors, long slow, double seconds) {
        public Http minus(Http o) { return new Http(count - o.count, errors - o.errors, slow - o.slow, seconds - o.seconds); }

        @Override
        public String toString() {
            return count == 0 ? "0 張" : String.format("%,d 張、5xx %.1f%%、超過 500 ms %.1f%%、平均 %.0f ms", count, 100.0 * errors / count, 100.0 * slow / count, 1000 * seconds / count);
        }
    }

    public static Http http(String app) throws Exception {
        long count = 0, errors = 0, fast = 0;
        double seconds = 0;
        for (Kube.Pod p : Kube.pods(app)) {
            String m = Kube.metrics(p.name());
            if (m == null) continue;
            String uri = "uri=\"/api/orders\"", post = "method=\"POST\"";
            count += (long) Kube.sum(m, "http_server_requests_seconds_count", uri, post);
            errors += (long) Kube.sum(m, "http_server_requests_seconds_count", uri, post, "status=\"5");
            fast += (long) Kube.sum(m, "http_server_requests_seconds_bucket", uri, post, "le=\"0.5\"");
            seconds += Kube.sum(m, "http_server_requests_seconds_sum", uri, post);
        }
        return new Http(count, errors, count - fast, seconds);
    }

    /** 第 12 站 0.4.6 的 INV-2（InventoryReconciliation 的同一句）：reserved 跟還佔著的預留加總對不上的商品 */
    public static final String INV2 = """
            SELECT COUNT(*) FROM inventory i
              LEFT JOIN (SELECT product_id, SUM(quantity) AS q FROM inventory_reservations
                          WHERE status IN ('HELD', 'CONFIRMED') AND counted GROUP BY product_id) r ON r.product_id = i.product_id
             WHERE i.reserved <> COALESCE(r.q, 0)""";

    /** 訂單服務呼叫庫存服務的次數（第 07 章 7.7.1 的 shop.remote.call，每一種操作、每一種結果加起來） */
    public static long remoteCalls() throws Exception {
        long n = 0;
        for (Kube.Pod p : Kube.pods("order-service")) {
            double v = Kube.sum(Kube.metrics(p.name()), "shop_remote_call_seconds_count");
            if (!Double.isNaN(v)) n += (long) v;
        }
        return n;
    }

    /** 每一個 app 的容器加起來的 working set（MiB）與 pod 數 —— kubelet 的 /stats/summary（第 08 章 K10 的做法） */
    public static Map<String, long[]> memory() throws Exception {
        Map<String, long[]> m = new TreeMap<>();
        JsonNode s = Calls.JSON.readTree(Kube.sh("kubectl", "--context", Kube.CTX, "get", "--raw", "/api/v1/nodes/d08-control-plane/proxy/stats/summary"));
        for (JsonNode p : s.path("pods")) {
            String name = p.path("podRef").path("name").asText();
            if (!p.path("podRef").path("namespace").asText().equals(Kube.NS) || name.startsWith("migrate")) continue;
            String app = name.replaceAll("-[a-z0-9]+-[a-z0-9]+$", "");
            long[] v = m.computeIfAbsent(app, k -> new long[2]);
            for (JsonNode c : p.path("containers")) v[0] += c.path("memory").path("workingSetBytes").asLong() / 1_048_576;
            v[1]++;
        }
        return m;
    }

    public static String fmtMemory(Map<String, long[]> m) {
        long total = m.values().stream().mapToLong(v -> v[0]).sum();
        return String.join("、", m.entrySet().stream().map(e -> e.getKey() + " " + e.getValue()[1] + " 個 pod " + e.getValue()[0] + " MiB").toList()) + "；共 " + total + " MiB";
    }

    /** 這個 app 每一個 pod 的日誌裡，level 是 ERROR 的那幾行：依 logger 與訊息的開頭分組數（JSON 日誌，第 12 站 9.7） */
    public static Map<String, Long> errors(String app) throws Exception {
        Map<String, Long> m = new TreeMap<>();
        for (Kube.Pod p : Kube.pods(app))
            for (String line : Kube.shAny("kubectl", "--context", Kube.CTX, "-n", Kube.NS, "logs", p.name()).split("\n")) {
                if (!line.contains("\"level\":\"ERROR\"")) continue;
                try {
                    JsonNode j = Calls.JSON.readTree(line);
                    String msg = j.path("message").asText().replaceAll("\\d+", "N");
                    m.merge(j.path("logger_name").asText().replaceAll(".*\\.", "") + "：" + (msg.length() > 90 ? msg.substring(0, 90) : msg), 1L, Long::sum);
                } catch (Exception notJson) {
                    m.merge("（不是 JSON）", 1L, Long::sum);
                }
            }
        return m;
    }

    /** 不是 201 的那幾格（每 5 秒一格）：整段只看到「500 有 1 張」的時候，要知道它在哪一段 */
    public static String oddWindows(com.example.shop.dist08.Load load) {
        java.util.List<String> w = new java.util.ArrayList<>();
        long end = load.done.stream().mapToLong(com.example.shop.dist08.Load.Done::atMs).max().orElse(0);
        for (long t = 0; t <= end; t += 5_000) {
            Map<Integer, Long> c = load.codes(t, t + 5_000);
            if (c.keySet().stream().anyMatch(k -> k != 201 && k != 503)) w.add(String.format("%.0f～%.0f 秒 %s", t / 1000.0, (t + 5_000) / 1000.0, com.example.shop.dist08.Load.fmt(c)));
        }
        return w.isEmpty() ? "沒有" : String.join("；", w);
    }

    public static void sql(String db, String... statements) throws Exception {
        try (Connection c = SplitLab.root(db); Statement st = c.createStatement()) {
            for (String s : statements) st.execute(s);
        }
    }

    public static long count(String db, String sql) throws Exception {
        return SplitLab.count(db, sql);
    }
}
```

**`src/test/java/com/example/shop/dist09/M1NaiveCanaryTest.java`**（9.2）

```java
package com.example.shop.dist09;

import com.example.shop.dist00.SplitLab;
import com.example.shop.dist02.Copier;
import com.example.shop.dist07.Keys;
import com.example.shop.dist08.Load;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.context.ConfigurableApplicationContext;

import java.io.PrintStream;
import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.Statement;
import java.util.Map;
import java.util.TreeMap;
import java.util.concurrent.ThreadLocalRandom;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;

/**
 * 13 站 9.2：照第 02 章 2.8.5 的計畫切過去，只多做一件事 —— 先切 10% 試試看（灰度）。
 *
 *   單體（入口 100%）在 shop_d09_mono；第 02 章 2.8.4 的搬家程式把庫存的五張表從 mono 追到 shop_d09_inv（舊的庫是唯一寫入者）。
 *   2.8.5 的第 1、2 步：庫存服務接 inv、訂單服務（= 單體的 InventoryApi 換成遠端）接 mono。
 *   入口把 10% 的 /api/** 切給訂單服務。
 *
 * 20 個商品、每個只有 20 件（共 400 件），每秒 N 張下單、每張買其中一個 1 件，買到賣完為止。
 *   ① 灰度的那一段：賣出幾件（單體的庫裡，沒有取消的訂單）、兩個庫的庫存各記了多少
 *   ② 回滾：權重回到 100／0、兩個服務縮到 0 —— 單體看得到那幾張經過訂單服務的訂單的預留嗎？再讓單體接 15 秒的單
 *
 *   mvn test -Pexperiments -Dtest=M1NaiveCanaryTest        （約 6 分鐘）
 */
@Tag("experiment")
class M1NaiveCanaryTest {

    static final int LIMITED = 20, UNITS = 20;
    static final long FIRST = SplitLab.FIRST_PRODUCT, LAST = FIRST + LIMITED - 1;
    static final String RANGE = "product_id BETWEEN " + FIRST + " AND " + LAST;

    final int rate = Integer.getInteger("m1.rate", 10);
    final int seconds = Integer.getInteger("m1.seconds", 60);
    final int canary = Integer.getInteger("m1.canary", 10);
    final PrintStream out = System.out;

    @Test
    void naiveCanary() throws Exception {
        try (ConfigurableApplicationContext keys = Keys.start()) {
            Mig.fresh();
            Mig.scale("order-service", 0);                                    // 新的服務還沒上線
            Mig.scale("inventory-service", 0);
            Mig.sql(Mig.MONO_DB, "UPDATE inventory SET on_hand = " + UNITS + " WHERE " + RANGE);
            try (Load warm = Load.start(keys, Mig.ENTRY, rate, () -> FIRST + 100 + ThreadLocalRandom.current().nextInt(900))) { warm.until(20); }

            out.printf("═══ 9.2 照第 02 章的計畫切過去，先切 %d%%：%d 個商品各 %d 件（共 %d 件），每秒 %d 張下單、每張 1 件 ═══%n",
                    canary, LIMITED, UNITS, LIMITED * UNITS, rate);
            Copier copier = new Copier(Mig.MONO_DB, Mig.INV_DB);
            copier.installCapture();
            long copied = 0;
            for (String t : Copier.TABLES.keySet()) copied += copier.backfill(t);
            AtomicBoolean stop = new AtomicBoolean();
            AtomicLong applied = new AtomicLong(), failed = new AtomicLong();
            Map<String, Long> errors = new TreeMap<>();
            Thread cdc = Thread.ofPlatform().start(() -> {
                while (!stop.get()) {
                    try {
                        int n = copier.apply();
                        applied.addAndGet(n);
                        if (n == 0) Thread.sleep(100);
                    } catch (InterruptedException e) {
                        return;
                    } catch (Exception e) {
                        failed.incrementAndGet();
                        synchronized (errors) { errors.merge(e.getClass().getSimpleName() + "：" + firstLine(e.getMessage()), 1L, Long::sum); }
                        try { Thread.sleep(100); } catch (InterruptedException ie) { return; }
                    }
                }
            });
            out.printf("  搬家程式（第 02 章 2.8.4）：回填 %,d 列，開始追變更紀錄；inventory_reservations 下一個 id：單體的庫 %d、庫存服務的庫 %d%n",
                    copied, nextId(Mig.MONO_DB), nextId(Mig.INV_DB));
            // 觀察用（不是搬家的一部分）：新的庫裡，一筆預留的 order_id 被換掉的那一刻記下來 —— 誰換的？只有搬家程式會整列改寫
            Mig.sql(Mig.INV_DB, "CREATE TABLE d09_overwritten (id BIGINT NOT NULL, old_order BIGINT NOT NULL, new_order BIGINT NOT NULL)",
                    "CREATE TRIGGER d09_watch AFTER UPDATE ON inventory_reservations FOR EACH ROW BEGIN "
                            + "IF OLD.order_id <> NEW.order_id THEN INSERT INTO d09_overwritten VALUES (OLD.id, OLD.order_id, NEW.order_id); END IF; END");

            Mig.scale("inventory-service", 2);                                 // 2.8.5 的 1：庫存服務指向新的庫
            Mig.scale("order-service", 1);                                     // 2.8.5 的 2：單體的 InventoryApi 換成遠端 —— 訂單服務，接單體的庫
            Mig.weights(100 - canary, canary);
            Thread.sleep(3_000);
            long mono0 = Mig.placements("monolith"), order0 = Mig.placements("order-service");
            out.printf("  第 0 秒：入口的權重 單體 %d、訂單服務 %d%n", 100 - canary, canary);

            Load load = Load.start(keys, Mig.ENTRY, rate, () -> FIRST + ThreadLocalRandom.current().nextInt(LIMITED));
            load.until(seconds);
            load.close();
            long mono1 = Mig.placements("monolith") - mono0, order1 = Mig.placements("order-service") - order0;
            out.printf("  ① 灰度 %d 秒：下單 %s；單體收到 %,d 張、訂單服務 %,d 張（%.1f%%）%n", seconds, Load.fmt(load.codes(0, Long.MAX_VALUE)),
                    mono1, order1, 100.0 * order1 / Math.max(1, mono1 + order1));
            long sold = sold();
            out.printf("     賣出 %,d 件（單體的庫裡、成立而且沒有取消的訂單）；庫存只有 %,d 件 → 超賣 %,d 件；超賣的商品 %d 個%n",
                    sold, LIMITED * UNITS, oversold(), count(Mig.MONO_DB, "SELECT COUNT(*) FROM (" + SOLD_BY_PRODUCT + ") s WHERE s.sold > " + UNITS));
            out.printf("     那幾個商品的訂單，依狀態：%s（503 的那幾張：預留成了、回應沒有回來，訂單停在 RESERVING，第 04 章 4.5.5 的排程會收）%n", statuses());
            out.printf("     兩個庫的「已預留」：單體的庫 %,d 件、庫存服務的庫 %,d 件%n",
                    count(Mig.MONO_DB, "SELECT SUM(reserved) FROM inventory WHERE " + RANGE), count(Mig.INV_DB, "SELECT SUM(reserved) FROM inventory WHERE " + RANGE));
            out.printf("     搬家程式：套用 %,d 筆變更紀錄、失敗 %,d 次%n", applied.get(), failed.get());
            synchronized (errors) { errors.forEach((k, v) -> out.printf("       × %,d　%s%n", v, k)); }
            out.printf("     核對（列數＋CRC32）不一樣的表：%s%n", copier.differences().keySet());

            Mig.weights(100, 0);                                               // ② 回滾
            Mig.scale("order-service", 0);
            Mig.scale("inventory-service", 0);
            stop.set(true);
            cdc.join();
            out.printf("  ② 回滾：權重 單體 100、訂單服務 0；兩個服務縮到 0%n");
            String orphans = "FROM shop_d09_mono.orders o JOIN shop_d09_mono.order_items i ON i.order_id = o.id WHERE i." + RANGE
                    + " AND o.status = 'PENDING_PAYMENT' AND NOT EXISTS (SELECT 1 FROM shop_d09_mono.inventory_reservations r WHERE r.order_id = o.id AND r.product_id = i.product_id AND r.status = 'HELD')";
            out.printf("     單體的庫裡，還在等付款、卻找不到自己的預留的訂單：%,d 張（共 %,d 張還在等付款）%n",
                    count("", "SELECT COUNT(*) " + orphans),
                    count(Mig.MONO_DB, "SELECT COUNT(*) FROM orders o JOIN order_items i ON i.order_id = o.id WHERE i." + RANGE + " AND o.status = 'PENDING_PAYMENT'"));
            out.printf("       它們的預留在庫存服務的庫裡：還在 %,d 張；被搬家程式換成另一張訂單的預留 %,d 張（新的庫裡，預留被換掉 order_id 的一共 %,d 筆）%n",
                    count("", "SELECT COUNT(*) " + orphans + " AND EXISTS (SELECT 1 FROM shop_d09_inv.inventory_reservations r WHERE r.order_id = o.id AND r.product_id = i.product_id)"),
                    count("", "SELECT COUNT(*) " + orphans + " AND EXISTS (SELECT 1 FROM shop_d09_inv.d09_overwritten w WHERE w.old_order = o.id)"),
                    count(Mig.INV_DB, "SELECT COUNT(*) FROM d09_overwritten"));
            long left = count(Mig.MONO_DB, "SELECT SUM(on_hand - reserved) FROM inventory WHERE " + RANGE);
            out.printf("     單體以為還能賣 %,d 件；實際上已經超賣 %,d 件%n", left, oversold());
            Load after = Load.start(keys, Mig.ENTRY, rate, () -> FIRST + ThreadLocalRandom.current().nextInt(LIMITED));
            after.until(15);
            after.close();
            long sold2 = sold();
            out.printf("     回滾之後單體再接 15 秒：下單 %s；又賣出 %,d 件 → 超賣 %,d 件%n", Load.fmt(after.codes(0, Long.MAX_VALUE)), sold2 - sold, oversold());
            copier.dropCapture();
            out.printf("  （結束時 load %s）%n", SplitLab.load());
        }
    }

    static final String SOLD_BY_PRODUCT = "SELECT i.product_id, SUM(i.quantity) sold FROM orders o JOIN order_items i ON i.order_id = o.id WHERE i." + RANGE
            + " AND o.status NOT IN ('CANCELLED', 'REJECTED', 'RESERVING') GROUP BY i.product_id";   // 下單成立了的（RESERVING 還沒回 201）

    static Map<String, Long> statuses() throws Exception {
        Map<String, Long> m = new TreeMap<>();
        try (Connection c = SplitLab.root(Mig.MONO_DB); Statement st = c.createStatement();
             ResultSet rs = st.executeQuery("SELECT o.status, COUNT(*) FROM orders o JOIN order_items i ON i.order_id = o.id WHERE i." + RANGE + " GROUP BY o.status")) {
            while (rs.next()) m.put(rs.getString(1), rs.getLong(2));
        }
        return m;
    }

    static long sold() throws Exception { return count(Mig.MONO_DB, "SELECT COALESCE(SUM(s.sold), 0) FROM (" + SOLD_BY_PRODUCT + ") s"); }

    static long oversold() throws Exception {
        return count(Mig.MONO_DB, "SELECT COALESCE(SUM(s.sold - " + UNITS + "), 0) FROM (" + SOLD_BY_PRODUCT + ") s WHERE s.sold > " + UNITS);
    }

    /** 這張表下一個 AUTO_INCREMENT（information_schema 預設快取 24 小時：這一個連線不要快取） */
    static long nextId(String db) throws Exception {
        try (Connection c = SplitLab.root(db); Statement st = c.createStatement()) {
            st.execute("SET SESSION information_schema_stats_expiry = 0");
            try (ResultSet rs = st.executeQuery("SELECT AUTO_INCREMENT FROM information_schema.tables WHERE table_schema = '" + db + "' AND table_name = 'inventory_reservations'")) {
                rs.next();
                return rs.getLong(1);
            }
        }
    }

    static long count(String db, String sql) throws Exception {
        try (Connection c = SplitLab.root(db); Statement st = c.createStatement(); ResultSet rs = st.executeQuery(sql)) {
            rs.next();
            return rs.getLong(1);
        }
    }

    static String firstLine(String s) {
        if (s == null) return "";
        s = s.lines().findFirst().orElse("").replaceAll("\\d+", "N");
        return s.length() > 110 ? s.substring(0, 110) : s;
    }
}
```

**`src/test/java/com/example/shop/dist09/M2CanaryTest.java`**（9.4.4、9.5）

```java
package com.example.shop.dist09;

import com.example.shop.dist00.SplitLab;
import com.example.shop.dist07.Calls;
import com.example.shop.dist07.Keys;
import com.example.shop.dist08.Kube;
import com.example.shop.dist08.Load;
import com.example.shop.support.TestTokens;
import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.context.ConfigurableApplicationContext;

import java.io.PrintStream;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.concurrent.ThreadLocalRandom;

/**
 * 13 站 9.5：灰度 —— 程式先搬，資料留在單體的庫（9.4）。單體與兩個服務接同一個庫、同一個 Redis，入口照權重分。
 *
 *   ⓪ 權重還是 0：帶 Shop-Route 的請求直接去指定的那一邊。同一個讀的請求兩邊各送一次，比回應（雙跑比對）
 *   ① 權重 5 → 25 → 50 → 100，每一段 N 秒、每秒 R 張下單：分到訂單服務的比例、狀態碼、兩邊各自的 5xx 比例與超過 500 ms 的比例
 *   ② 回滾：100 → 0（負載不停），訂單服務多久不再收到下單；切換前後的狀態碼
 *   ③ 再切回 100
 *   ④ 賣到完：20 個商品各 20 件，權重 50／50 —— 跟 9.2 同樣的負載，兩條路寫同一個庫
 *
 *   mvn test -Pexperiments -Dtest=M2CanaryTest        （約 8 分鐘）
 */
@Tag("experiment")
class M2CanaryTest {

    static final long FIRST = SplitLab.FIRST_PRODUCT;
    static final long BUYER = 9_100_001;

    final int rate = Integer.getInteger("m2.rate", 10);
    final int step = Integer.getInteger("m2.step", 30);
    final PrintStream out = System.out;

    @Test
    void canary() throws Exception {
        try (ConfigurableApplicationContext keys = Keys.start()) {
            Mig.fresh();
            Mig.weights(100, 0);
            try (Load warm = Load.start(keys, Mig.ENTRY, rate, M2CanaryTest::anyProduct)) { warm.until(20); }
            out.printf("═══ 9.5 灰度：單體與兩個服務接同一個庫（%s）、同一個 Redis；每秒 %d 張下單 ═══%n", Mig.MONO_DB, rate);

            parallelRun(keys);

            out.printf("  ① 權重一段一段往上，每一段 %d 秒%n", step);
            for (int pct : new int[]{5, 25, 50, 100}) {
                Mig.weights(100 - pct, pct);
                Thread.sleep(3_000);
                Mig.Http m0 = Mig.http("monolith"), o0 = Mig.http("order-service");
                Load load = Load.start(keys, Mig.ENTRY, rate, M2CanaryTest::anyProduct);
                load.until(step);
                load.close();
                Mig.Http m = Mig.http("monolith").minus(m0), o = Mig.http("order-service").minus(o0);
                long[] p = load.p50p99(0, Long.MAX_VALUE);
                out.printf("    訂單服務 %3d%% │ 實際分到 %5.1f%% │ 下單 %-16s │ p50 %4d ms、p99 %5d ms │ 單體 %s │ 訂單服務 %s%n", pct,
                        100.0 * o.count() / Math.max(1, m.count() + o.count()), String.join(" ", Load.fmt(load.codes(0, Long.MAX_VALUE))), p[0], p[1], m, o);
                if (pct == 50) out.printf("      入口的 Envoy 的設定（權重 50／50 的時候）：%s；單體 %s、訂單服務 %s%n", Mig.envoyLocalities(),
                        Kube.pods("monolith").stream().map(Kube.Pod::ip).toList(), Kube.pods("order-service").stream().map(Kube.Pod::ip).toList());
            }

            rollback(keys);

            out.printf("  ③ 再切回 100%n");
            Mig.weights(0, 100);
            Thread.sleep(3_000);
            try (Load again = Load.start(keys, Mig.ENTRY, rate, M2CanaryTest::anyProduct)) {
                again.until(15);
                again.close();
                out.printf("    15 秒：下單 %s%n", Load.fmt(again.codes(0, Long.MAX_VALUE)));
            }

            sellOut(keys);
            out.printf("  ERROR 日誌：單體 %s；訂單服務 %s；庫存服務 %s%n", Mig.errors("monolith"), Mig.errors("order-service"), Mig.errors("inventory-service"));
            out.printf("  （結束時 load %s）%n", SplitLab.load());
        }
    }

    /** 暖機、①～③ 的下單：庫存充足的那 900 個商品 */
    static long anyProduct() { return FIRST + 100 + ThreadLocalRandom.current().nextInt(900); }

    /** ⓪ 同一個讀的請求，Shop-Route 指定兩邊各送一次，比較回應 */
    void parallelRun(ConfigurableApplicationContext keys) throws Exception {
        String buyer = TestTokens.bearer(keys, BUYER);
        List<String> orderNos = new ArrayList<>();
        for (int i = 0; i < 3; i++) {
            Calls.Res r = Calls.send(Mig.ENTRY, "POST", "/api/orders", buyer, Map.of("items", List.of(Map.of("productId", FIRST + 100 + i, "quantity", 1, "unitPrice", new java.math.BigDecimal("100.00")))),
                    Map.of("Idempotency-Key", java.util.UUID.randomUUID().toString(), "Shop-Route", "monolith"));
            orderNos.add(r.json().get("orderNo").asText());
        }
        List<String> paths = new ArrayList<>();
        for (int i = 0; i < 20; i++) paths.add("/api/products/" + (FIRST + 100 + i * 45));
        paths.add("/api/orders");
        orderNos.forEach(n -> paths.add("/api/orders/" + n));
        Map<String, Long> diffs = new TreeMap<>();
        int same = 0;
        List<String> examples = new ArrayList<>();
        for (String path : paths) {
            String token = path.startsWith("/api/orders") ? buyer : null;
            Calls.Res mono = Calls.send(Mig.ENTRY, "GET", path, token, null, Map.of("Shop-Route", "monolith"));
            Calls.Res order = Calls.send(Mig.ENTRY, "GET", path, token, null, Map.of("Shop-Route", "order-service"));
            List<String> d = new ArrayList<>();
            if (mono.status() != order.status()) d.add("status");
            else diff("", mono.json(), order.json(), d);
            if (d.isEmpty()) same++;
            d.forEach(f -> diffs.merge(f, 1L, Long::sum));
            if (!d.isEmpty() && examples.size() < 3)
                examples.add(path + "：單體 " + pick(mono.json(), d.get(0)) + "、訂單服務 " + pick(order.json(), d.get(0)));
        }
        out.printf("  ⓪ 權重 0，Shop-Route 兩邊各送一次（雙跑比對）：%d 個讀的請求，回應一樣 %d 個；不一樣的欄位 %s%n", paths.size(), same, diffs);
        examples.forEach(e -> out.printf("     例：%s%n", e));
    }

    /** 兩份 JSON 不一樣的欄位（巢狀的用 a.b、陣列的用 a[]） */
    static void diff(String at, JsonNode a, JsonNode b, List<String> out) {
        if (a.isObject() && b.isObject()) {
            for (Iterator<String> it = a.fieldNames(); it.hasNext(); ) {
                String f = it.next();
                diff(at.isEmpty() ? f : at + "." + f, a.get(f), b.path(f), out);
            }
        } else if (a.isArray() && b.isArray() && a.size() == b.size()) {
            for (int i = 0; i < a.size(); i++) diff(at + "[]", a.get(i), b.get(i), out);
        } else if (!a.equals(b) && !out.contains(at)) {
            out.add(at);
        }
    }

    static String pick(JsonNode n, String field) {
        JsonNode v = n;
        for (String f : field.replace("[]", "").split("\\.")) v = v.isArray() ? v.path(0).path(f) : v.path(f);
        return field + "=" + v;
    }

    /** ② 負載不停，權重 100 → 0：訂單服務最後一次收到下單是切換之後多久 */
    void rollback(ConfigurableApplicationContext keys) throws Exception {
        Mig.weights(0, 100);
        Thread.sleep(3_000);
        Load load = Load.start(keys, Mig.ENTRY, rate, M2CanaryTest::anyProduct);
        load.until(10);
        long last = Mig.placements("order-service"), switchedAt = load.elapsedMs(), lastChange = switchedAt;
        Mig.weights(100, 0);
        long applied = load.elapsedMs();
        while (load.elapsedMs() - lastChange < 5_000) {                      // 5 秒沒有再增加 = 不再收到了
            long now = Mig.placements("order-service");
            if (now != last) { last = now; lastChange = load.elapsedMs(); }
            Thread.sleep(250);
        }
        load.until(30);
        load.close();
        out.printf("  ② 回滾：第 %.1f 秒把權重改成 100／0（kubectl patch 花 %d ms）；訂單服務最後一次收到下單在切換之後 %.1f 秒內%n",
                switchedAt / 1000.0, applied - switchedAt, (lastChange - switchedAt) / 1000.0);
        out.printf("     切換之前 10 秒：下單 %s；切換之後 20 秒：下單 %s%n",
                Load.fmt(load.codes(0, switchedAt)), Load.fmt(load.codes(switchedAt, Long.MAX_VALUE)));
        out.printf("     權重 100／0 之後入口的 Envoy 的設定（訂單服務的 pod 還在）：%s%n", Mig.envoyLocalities());
    }

    /** ④ 20 個商品各 20 件，兩條路各一半：跟 9.2 同樣的負載 */
    void sellOut(ConfigurableApplicationContext keys) throws Exception {
        int limited = 20, units = 20;
        String range = "product_id BETWEEN " + FIRST + " AND " + (FIRST + limited - 1);
        Mig.sql(Mig.MONO_DB, "UPDATE inventory SET on_hand = reserved + " + units + " WHERE " + range);
        long before = sold(range);
        Mig.weights(50, 50);
        Thread.sleep(3_000);
        Mig.Http m0 = Mig.http("monolith"), o0 = Mig.http("order-service");
        Load load = Load.start(keys, Mig.ENTRY, rate, () -> FIRST + ThreadLocalRandom.current().nextInt(limited));
        load.until(60);
        load.close();
        Mig.Http m = Mig.http("monolith").minus(m0), o = Mig.http("order-service").minus(o0);
        long sold = sold(range) - before;
        out.printf("  ④ 賣到完：%d 個商品各 %d 件（共 %d 件），權重 50／50，每秒 %d 張、60 秒%n", limited, units, limited * units, rate);
        out.printf("     下單 %s；單體收到 %,d 張、訂單服務 %,d 張；賣出 %,d 件；賣超過 %d 件的商品 %d 個%n", Load.fmt(load.codes(0, Long.MAX_VALUE)),
                m.count(), o.count(), sold, units, Mig.count(Mig.MONO_DB, "SELECT COUNT(*) FROM (SELECT i.product_id FROM orders o JOIN order_items i ON i.order_id = o.id WHERE i."
                        + range + " AND o.status NOT IN ('CANCELLED', 'REJECTED', 'RESERVING') GROUP BY i.product_id HAVING SUM(i.quantity) > " + units + ") s"));
        out.printf("     還在等付款、找不到自己的預留的訂單 %d 張；INV-2（reserved 與預留加總對不上的商品）%d 個%n",
                Mig.count(Mig.MONO_DB, "SELECT COUNT(*) FROM orders o JOIN order_items i ON i.order_id = o.id WHERE o.status = 'PENDING_PAYMENT'"
                        + " AND NOT EXISTS (SELECT 1 FROM inventory_reservations r WHERE r.order_id = o.id AND r.product_id = i.product_id AND r.status = 'HELD')"),
                Mig.count(Mig.MONO_DB, Mig.INV2));
    }

    static long sold(String range) throws Exception {
        return Mig.count(Mig.MONO_DB, "SELECT COALESCE(SUM(i.quantity), 0) FROM orders o JOIN order_items i ON i.order_id = o.id WHERE i." + range
                + " AND o.status NOT IN ('CANCELLED', 'REJECTED', 'RESERVING')");
    }
}
```

**`src/test/java/com/example/shop/dist09/M3StickyTest.java`**（9.5.4）

```java
package com.example.shop.dist09;

import com.example.shop.dist00.SplitLab;
import com.example.shop.dist07.Calls;
import com.example.shop.dist07.Keys;
import com.example.shop.dist08.Kube;
import com.example.shop.dist08.Load;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.context.ConfigurableApplicationContext;

import java.io.PrintStream;
import java.net.CookieManager;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.concurrent.ThreadLocalRandom;

/**
 * 13 站 9.5.4：灰度期間，同一個買家來回兩邊。單體的商品頁直接讀庫存的表；訂單服務讀副本（第 05 章 5.4），晚幾百毫秒 ——
 * 一個人連續看同一個商品，可售量會不會「倒退」（先看到 98，再看到 100）？
 *
 * 權重 50／50；5 個商品被持續下單（每秒 N 張），10 個讀的人各盯一個商品、每 400 ms 看一次，各 30 秒。
 *   ① 沒有黏性：每一次讀各自照權重分
 *   ② HTTPRoute 的 sessionPersistence（cookie）：第一次回應帶一個 cookie，之後同一個人送到同一台
 *   ③ 黏著的時候回滾（權重 100／0）：黏在訂單服務的人，會不會被留在訂單服務
 * 讀的人每 400 ms 看一次：10 個人每秒 25 次，加上每秒 10 張下單，在「每個 IP 每秒 50 次」（第 12 站 6.7.2）之下 ——
 * 第一版每 200 ms 一次（每秒 60 個請求），讀的 1,174 次裡 110 次失敗。
 *
 *   mvn test -Pexperiments -Dtest=M3StickyTest        （約 5 分鐘）
 */
@Tag("experiment")
class M3StickyTest {

    static final long FIRST = SplitLab.FIRST_PRODUCT;
    static final int PRODUCTS = 5, READERS = 10;

    final int rate = Integer.getInteger("m3.rate", 10);
    final PrintStream out = System.out;

    @Test
    void sticky() throws Exception {
        try (ConfigurableApplicationContext keys = Keys.start()) {
            Mig.fresh();
            Mig.weights(50, 50);
            Thread.sleep(3_000);
            try (Load warm = Load.start(keys, Mig.ENTRY, rate, M3StickyTest::product)) { warm.until(20); }
            out.printf("═══ 9.5.4 同一個人來回兩邊：權重 50／50；%d 個商品每秒共 %d 張下單，%d 個人各盯一個商品、每 400 ms 看一次 ═══%n", PRODUCTS, rate, READERS);

            Load load = Load.start(keys, Mig.ENTRY, rate, M3StickyTest::product);
            out.printf("  ① 沒有黏性：%s%n", read(30, false));
            Kube.kubectl("patch", "httproute/shop-api", "--type=json", "-p",
                    "[{\"op\":\"add\",\"path\":\"/spec/rules/0/sessionPersistence\",\"value\":{\"sessionName\":\"shop-backend\",\"type\":\"Cookie\"}}]");
            Thread.sleep(3_000);
            out.printf("  ② sessionPersistence（cookie）：%s%n", read(30, true));

            Result sticky = new Result();
            List<HttpClient> clients = clients(true);
            for (int i = 0; i < READERS; i++) get(clients.get(i), FIRST + i % PRODUCTS, sticky, i);   // 先拿到 cookie
            out.printf("     黏在哪裡（cookie 解出來的位址）：%s；其中一個 cookie 解開的位元組：%s%n", pinned(clients), sample(clients.get(0)));
            double before = productGets("order-service");
            Mig.weights(100, 0);
            Thread.sleep(3_000);
            double after0 = productGets("order-service");
            Result r = read(clients, 20, true);
            double after = productGets("order-service");
            out.printf("  ③ 黏著的時候回滾（權重 100／0，等 3 秒）：之後 20 秒 %s；訂單服務收到的商品頁 %.0f 個（等的那 3 秒 %.0f 個）%n",
                    r, after - after0, after0 - before);
            load.close();
            out.printf("     這段時間的下單 %s%n", Load.fmt(load.codes(0, Long.MAX_VALUE)));
            // 復原：kubectl apply 不會拿掉 kubectl patch 加上去的欄位（第 08 章 8.7.1），要用反向的 patch
            Kube.kubectl("patch", "httproute/shop-api", "--type=json", "-p", "[{\"op\":\"remove\",\"path\":\"/spec/rules/0/sessionPersistence\"}]");
            out.printf("  （結束時 load %s）%n", SplitLab.load());
        }
    }

    static long product() { return FIRST + ThreadLocalRandom.current().nextInt(PRODUCTS); }

    static class Result {
        long reads, errors, backwards, maxJump;
        final Map<String, Long> failures = new TreeMap<>();
        final boolean[] sawBackwards = new boolean[READERS];

        synchronized void add(int reader, int prev, int now) {
            reads++;
            if (prev >= 0 && now > prev) {
                backwards++;
                sawBackwards[reader] = true;
                maxJump = Math.max(maxJump, now - prev);
            }
        }

        @Override
        public synchronized String toString() {
            int people = 0;
            for (boolean b : sawBackwards) if (b) people++;
            return String.format("讀 %,d 次（失敗 %d%s）；可售量倒退 %,d 次（%.1f%%），%d 個人裡 %d 個看過倒退，最多倒退 %d 件",
                    reads, errors, failures.isEmpty() ? "" : " " + failures, backwards, 100.0 * backwards / Math.max(1, reads), READERS, people, maxJump);
        }
    }

    List<HttpClient> clients(boolean cookies) {
        List<HttpClient> c = new ArrayList<>();
        for (int i = 0; i < READERS; i++) {
            HttpClient.Builder b = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(2));
            if (cookies) b.cookieHandler(new CookieManager());
            c.add(b.build());
        }
        return c;
    }

    Result read(int seconds, boolean cookies) throws Exception {
        return read(clients(cookies), seconds, cookies);
    }

    /** 每個人各盯一個商品，每 400 ms 看一次 */
    Result read(List<HttpClient> clients, int seconds, boolean cookies) throws Exception {
        Result r = new Result();
        List<Thread> ts = new ArrayList<>();
        long end = System.nanoTime() + seconds * 1_000_000_000L;
        for (int i = 0; i < READERS; i++) {
            int reader = i;
            ts.add(Thread.ofVirtual().start(() -> {
                int prev = -1;
                while (System.nanoTime() < end) {
                    int now = get(clients.get(reader), FIRST + reader % PRODUCTS, r, reader);
                    if (now >= 0) { r.add(reader, prev, now); prev = now; }
                    try { Thread.sleep(400); } catch (InterruptedException e) { return; }
                }
            }));
        }
        for (Thread t : ts) t.join();
        return r;
    }

    static int get(HttpClient c, long product, Result r, int reader) {
        try {
            HttpResponse<String> res = c.send(HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + Mig.ENTRY + "/api/products/" + product))
                    .timeout(Duration.ofSeconds(10)).build(), HttpResponse.BodyHandlers.ofString());
            if (res.statusCode() != 200) { synchronized (r) { r.errors++; r.failures.merge(String.valueOf(res.statusCode()), 1L, Long::sum); } return -1; }
            return Calls.JSON.readTree(res.body()).get("available").asInt();
        } catch (Exception e) {
            synchronized (r) { r.errors++; r.failures.merge(e.getClass().getSimpleName(), 1L, Long::sum); }
            return -1;
        }
    }

    /** 每個人的 shop-backend cookie 解出來是哪一台（Envoy 的 stateful session：cookie 的值是上游的位址，base64） */
    static Map<String, Integer> pinned(List<HttpClient> clients) throws Exception {
        Map<String, String> ipToApp = new TreeMap<>();
        for (String app : List.of("monolith", "order-service")) for (Kube.Pod p : Kube.pods(app)) ipToApp.put(p.ip(), app);
        Map<String, Integer> m = new TreeMap<>();
        for (HttpClient c : clients) {
            String where = "沒有 cookie";
            CookieManager cm = (CookieManager) c.cookieHandler().orElseThrow();
            for (var cookie : cm.getCookieStore().getCookies())
                if (cookie.getName().equals("shop-backend")) {
                    try {
                        // 解出來不只是位址：前面還有一個位元組（第一版直接拿整串去對 pod 的 IP，一個都對不上）—— 用 regex 取 IP
                        String raw = new String(Base64.getDecoder().decode(cookie.getValue()), StandardCharsets.ISO_8859_1);
                        java.util.regex.Matcher ip = java.util.regex.Pattern.compile("(\\d+\\.\\d+\\.\\d+\\.\\d+):\\d+").matcher(raw);
                        where = ip.find() ? ipToApp.getOrDefault(ip.group(1), ip.group()) : "解不出來：" + cookie.getValue();
                    } catch (IllegalArgumentException notBase64) {
                        where = "解不出來：" + cookie.getValue();
                    }
                }
            m.merge(where, 1, Integer::sum);
        }
        return m;
    }

    /** 一個 shop-backend cookie 的值，base64 解開之後的位元組（十六進位）—— 看它裡面到底放了什麼 */
    static String sample(HttpClient c) {
        for (var cookie : ((CookieManager) c.cookieHandler().orElseThrow()).getCookieStore().getCookies())
            if (cookie.getName().equals("shop-backend")) {
                StringBuilder hex = new StringBuilder();
                for (byte b : Base64.getDecoder().decode(cookie.getValue())) hex.append(String.format("%02x ", b));
                return hex.toString().trim();
            }
        return "沒有 cookie";
    }

    /** 訂單服務到現在為止回了幾個商品頁 */
    static double productGets(String app) throws Exception {
        double n = 0;
        for (Kube.Pod p : Kube.pods(app)) {
            double v = Kube.sum(Kube.metrics(p.name()), "http_server_requests_seconds_count", "uri=\"/api/products/{id}\"", "method=\"GET\"");
            if (!Double.isNaN(v)) n += v;
        }
        return n;
    }
}
```

**`src/test/java/com/example/shop/dist09/M4DataSplitTest.java`**（9.6、9.7）

```java
package com.example.shop.dist09;

import com.example.shop.dist00.SplitLab;
import com.example.shop.dist02.Copier;
import com.example.shop.dist07.Keys;
import com.example.shop.dist08.Load;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.context.ConfigurableApplicationContext;

import java.io.PrintStream;
import java.util.concurrent.ThreadLocalRandom;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;

/**
 * 13 站 9.6、9.7：資料最後搬。下單已經全部走訂單服務（權重 0／100），單體縮到 0 —— 庫存的五張表只剩庫存服務在寫，它還在單體的庫裡。
 *
 *   ① 新的庫（shop_d09_inv）：跑庫存與 shared 兩個資料夾
 *   ② 第 02 章 2.8.4 的搬家程式：單體的庫裝變更紀錄、回填、開始追
 *   ③ 邊寫邊比（Verifier）：分段、不一樣的段等一下再比
 *   ④ 故意弄壞新的庫的一列：對帳抓不抓得到、怎麼修
 *   ⑤ 切換（Cutover）：停寫、追完、搬去重紀錄、核對、換設定；新的庫先裝反方向的變更紀錄 —— 回頭路
 *   ⑥ 切過去之後：反方向的搬家程式一直追，單體的庫跟著新的庫
 *   ⑦ 回滾演練：同一個 Cutover，方向反過來
 * 從頭到尾每秒 N 張下單不停；每一段的狀態碼都記下來。
 *
 *   mvn test -Pexperiments -Dtest=M4DataSplitTest        （約 9 分鐘）
 */
@Tag("experiment")
class M4DataSplitTest {

    static final long FIRST = SplitLab.FIRST_PRODUCT, BROKEN = FIRST + 50;    // 下單只買 FIRST+100 以後的商品：BROKEN 沒有人動它

    final int rate = Integer.getInteger("m4.rate", 10);
    final PrintStream out = System.out;

    @Test
    void split() throws Exception {
        try (ConfigurableApplicationContext keys = Keys.start()) {
            Mig.fresh();
            Mig.weights(0, 100);
            Mig.scale("monolith", 0);
            try (Load warm = Load.start(keys, Mig.ENTRY, rate, M4DataSplitTest::anyProduct)) { warm.until(20); }
            out.printf("═══ 9.6 資料最後搬：下單全部走訂單服務，單體縮到 0；庫存的五張表還在 %s，只有庫存服務在寫。每秒 %d 張下單，從頭到尾不停 ═══%n", Mig.MONO_DB, rate);
            Load load = Load.start(keys, Mig.ENTRY, rate, M4DataSplitTest::anyProduct);

            SplitLab.freshDatabase(Mig.INV_DB);
            Flyway.configure().dataSource(SplitLab.url(Mig.INV_DB), "shop_migrator", "shop_migrator")
                    .locations("classpath:db/migration/inventory", "classpath:db/migration/shared").load().migrate();
            Copier copier = new Copier(Mig.MONO_DB, Mig.INV_DB);
            copier.installCapture();
            long copied = 0;
            for (String t : Copier.TABLES.keySet()) copied += copier.backfill(t);
            Tracker forward = Tracker.start(copier);
            out.printf("  ① ② 第 %.0f 秒：新的庫跑完庫存與 shared 的 migration；搬家程式回填 %,d 列、開始追%n", load.elapsedMs() / 1000.0, copied);

            long lag0 = copier.lag();
            while (copier.lag() > 100) Thread.sleep(200);                     // 回填途中累積的變更，先追上再開始比
            out.printf("     第 %.0f 秒追上了：回填完的時候落後 %,d 筆、現在 %,d 筆%n", load.elapsedMs() / 1000.0, lag0, copier.lag());
            Verifier verify = new Verifier(Mig.MONO_DB, Mig.INV_DB);
            for (int round = 1; round <= 2; round++)
                out.printf("  ③ 邊寫邊比（第 %d 輪，第 %.0f 秒）：%s%n", round, load.elapsedMs() / 1000.0, verify.run());

            Mig.sql(Mig.INV_DB, "UPDATE inventory SET on_hand = on_hand + 1 WHERE product_id = " + BROKEN);
            out.printf("  ④ 新的庫的 inventory %d：on_hand 多 1（模擬搬家程式的一個 bug）%n", BROKEN);
            out.printf("     對帳：%s%n", verify.run());
            Mig.sql(Mig.MONO_DB, "INSERT INTO d02_changes (tbl, pk) VALUES ('inventory', " + BROKEN + ")");   // 修：讓搬家程式再搬一次那一列
            Thread.sleep(1_000);
            out.printf("     修（在變更紀錄補一筆 inventory %d，讓搬家程式再搬一次）之後：%s%n", BROKEN, verify.run());

            forward.stop();
            Copier[] reverse = new Copier[1];
            long freezeAt = load.elapsedMs();
            Cutover.Result cut = Cutover.run(copier, Mig.INV_DB, "2", false, () -> {
                reverse[0] = new Copier(Mig.INV_DB, Mig.MONO_DB);                 // 回頭路：新的庫一開始被寫，就有變更紀錄
                reverse[0].installCapture();
                return true;
            });
            long liveAt = load.elapsedMs();
            copier.dropCapture();                                               // 單體的庫：不再是正本，trigger 拿掉
            Tracker back = Tracker.start(reverse[0]);
            out.printf("  ⑤ 切換（第 %.0f～%.0f 秒）：%s%n", freezeAt / 1000.0, liveAt / 1000.0, cut);

            load.until(liveAt / 1000 + 60);                                      // 狀態碼在這之後才算：送出去的要等它們回來（第一版切換完馬上算，「起來之後 10 秒」只數到 1 張）
            out.printf("     切換之前 10 秒：下單 %s；停寫的那 %.1f 秒：下單 %s；起來之後 10 秒：下單 %s%n",
                    Load.fmt(load.codes(freezeAt - 10_000, freezeAt)), (liveAt - freezeAt) / 1000.0, Load.fmt(load.codes(freezeAt, liveAt)),
                    Load.fmt(load.codes(liveAt, liveAt + 10_000)));
            out.printf("     停寫的那一段，每 5 秒：%s%n", windows(load, freezeAt, liveAt + 10_000));
            out.printf("  ⑥ 切過去之後 60 秒：下單 %s；反方向的搬家程式套用 %,d 筆、失敗 %d 次%n",
                    Load.fmt(load.codes(liveAt, liveAt + 60_000)), back.applied.get(), back.failed.get());
            out.printf("     新的庫：INV-2 對不上的商品 %d 個；訂單服務的庫裡，還在等付款、在新的庫找不到預留的訂單 %d 張%n",
                    Mig.count(Mig.INV_DB, Mig.INV2), orphans(Mig.INV_DB));
            out.printf("     單體的庫跟著新的庫嗎（邊寫邊比）：%s%n", new Verifier(Mig.INV_DB, Mig.MONO_DB).run());

            back.stop();
            long rollbackAt = load.elapsedMs();
            Cutover.Result undo = Cutover.run(reverse[0], Mig.MONO_DB, "3", true, null);
            long backAt = load.elapsedMs();
            reverse[0].dropCapture();
            out.printf("  ⑦ 回滾演練（第 %.0f～%.0f 秒）：%s%n", rollbackAt / 1000.0, backAt / 1000.0, undo);
            load.until(backAt / 1000 + 30);
            load.close();
            out.printf("     停寫的那 %.1f 秒：下單 %s；回來之後 30 秒：下單 %s%n", (backAt - rollbackAt) / 1000.0,
                    Load.fmt(load.codes(rollbackAt, backAt)), Load.fmt(load.codes(backAt, Long.MAX_VALUE)));
            out.printf("     停寫的那一段，每 5 秒：%s%n", windows(load, rollbackAt, backAt + 10_000));
            out.printf("     單體的庫：INV-2 對不上的商品 %d 個；還在等付款、找不到預留的訂單 %d 張（9.2 的回滾是 39 張）%n",
                    Mig.count(Mig.MONO_DB, Mig.INV2), orphans(Mig.MONO_DB));
            out.printf("  整段：下單 %s%n", Load.fmt(load.codes(0, Long.MAX_VALUE)));
            out.printf("     除了 201、503 之外的狀態碼出現在：%s；訂單服務的 ERROR 日誌：%s%n", Mig.oddWindows(load), Mig.errors("order-service"));
            out.printf("  （結束時 load %s）%n", SplitLab.load());
        }
    }

    static long anyProduct() { return FIRST + 100 + ThreadLocalRandom.current().nextInt(900); }

    /** [from, to) 每 5 秒一格的狀態碼 */
    static String windows(Load load, long from, long to) {
        java.util.List<String> w = new java.util.ArrayList<>();
        for (long t = from; t < to; t += 5_000)
            w.add(String.format("%.0f～%.0f 秒 %s", t / 1000.0, Math.min(t + 5_000, to) / 1000.0, Load.fmt(load.codes(t, Math.min(t + 5_000, to)))));
        return String.join("；", w);
    }

    /** 訂單在單體的庫（訂單服務接手的那一個）；預留在 inventoryDb */
    static long orphans(String inventoryDb) throws Exception {
        return Mig.count("", "SELECT COUNT(*) FROM " + Mig.MONO_DB + ".orders o JOIN " + Mig.MONO_DB + ".order_items i ON i.order_id = o.id WHERE o.status = 'PENDING_PAYMENT'"
                + " AND NOT EXISTS (SELECT 1 FROM " + inventoryDb + ".inventory_reservations r WHERE r.order_id = o.id AND r.product_id = i.product_id AND r.status = 'HELD')");
    }

    /** 背景一直追：沒有新的就睡 100 ms */
    static final class Tracker {
        final AtomicBoolean stop = new AtomicBoolean();
        final AtomicLong applied = new AtomicLong(), failed = new AtomicLong();
        Thread thread;

        static Tracker start(Copier copier) {
            Tracker t = new Tracker();
            t.thread = Thread.ofPlatform().start(() -> {
                while (!t.stop.get()) {
                    try {
                        int n = copier.apply();
                        t.applied.addAndGet(n);
                        if (n == 0) Thread.sleep(100);
                    } catch (InterruptedException e) {
                        return;
                    } catch (Exception e) {
                        t.failed.incrementAndGet();
                        try { Thread.sleep(100); } catch (InterruptedException ie) { return; }
                    }
                }
            });
            return t;
        }

        void stop() throws InterruptedException {
            stop.set(true);
            thread.join();
        }
    }
}
```

**`src/test/java/com/example/shop/dist09/M5MergeBackTest.java`**（9.10）

```java
package com.example.shop.dist09;

import com.example.shop.dist00.SplitLab;
import com.example.shop.dist02.Copier;
import com.example.shop.dist07.Keys;
import com.example.shop.dist08.Load;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.context.ConfigurableApplicationContext;

import java.io.PrintStream;
import java.util.Map;
import java.util.concurrent.ThreadLocalRandom;

/**
 * 13 站 9.10：合併回去。起點是拆完、收尾過的樣子：庫存服務在 shop_d09_inv，訂單服務在單體的庫，單體縮到 0，反方向的搬家程式早就拆了
 * （單體的庫裡那五張庫存的表停在切換的那一刻）。回頭路是去程倒著走 —— 資料先、程式後：
 *
 *   ① 拆開的樣子：每秒 N 張、60 秒 —— 延遲、每一張訂單幾次服務之間的呼叫、記憶體
 *   ② 資料先：單體的庫裡過時的庫存表清空，搬家程式 inv → 單體的庫（回填、追、邊寫邊比），停寫、換庫 —— 庫存服務回到單體的庫（共用的庫）
 *   ③ 程式後：單體起來，權重 50／50（兩邊都熱起來）；兩條路寫同一個庫的這一刻，輪流把權重整個切到一邊 —— 合前合後的延遲，交錯量（① 與 ⑤ 量的時間點不同，機器的狀態也不同）；最後 100／0
 *   ④ 拿掉兩個服務
 *   ⑤ 合併之後：同樣每秒 N 張、60 秒
 * ②～④ 的負載不停。
 *
 *   mvn test -Pexperiments -Dtest=M5MergeBackTest        （約 10 分鐘）
 */
@Tag("experiment")
class M5MergeBackTest {

    static final long FIRST = SplitLab.FIRST_PRODUCT;

    final int rate = Integer.getInteger("m5.rate", 10);
    final PrintStream out = System.out;

    @Test
    void mergeBack() throws Exception {
        try (ConfigurableApplicationContext keys = Keys.start()) {
            Mig.fresh();
            Mig.weights(0, 100);
            Mig.scale("monolith", 0);
            SplitLab.freshDatabase(Mig.INV_DB);                                // 拆開：9.6 的做法，這裡沒有負載
            Flyway.configure().dataSource(SplitLab.url(Mig.INV_DB), "shop_migrator", "shop_migrator")
                    .locations("classpath:db/migration/inventory", "classpath:db/migration/shared").load().migrate();
            Copier split = new Copier(Mig.MONO_DB, Mig.INV_DB);
            split.installCapture();
            for (String t : Copier.TABLES.keySet()) split.backfill(t);
            Cutover.run(split, Mig.INV_DB, "2", false, null);
            split.dropCapture();
            try (Load warm = Load.start(keys, Mig.ENTRY, rate, M5MergeBackTest::anyProduct)) { warm.until(20); }
            out.printf("═══ 9.10 合併回去：庫存服務在 %s、訂單服務在 %s、單體縮到 0；反方向的搬家程式已經拆了。每秒 %d 張下單 ═══%n", Mig.INV_DB, Mig.MONO_DB, rate);

            out.printf("  ① 拆開的樣子：%s%n", measure(keys));
            out.printf("     記憶體：%s%n", Mig.fmtMemory(Mig.memory()));

            Load load = Load.start(keys, Mig.ENTRY, rate, M5MergeBackTest::anyProduct);
            Mig.sql(Mig.MONO_DB, "SET SESSION foreign_key_checks = 0", "TRUNCATE TABLE inventory_ledger_watermark", "TRUNCATE TABLE inventory_ledger_checkpoints",
                    "TRUNCATE TABLE inventory_ledger", "TRUNCATE TABLE inventory_reservations", "TRUNCATE TABLE inventory");
            Copier back = new Copier(Mig.INV_DB, Mig.MONO_DB);
            back.installCapture();
            long copied = 0;
            for (String t : Copier.TABLES.keySet()) copied += back.backfill(t);
            M4DataSplitTest.Tracker tracker = M4DataSplitTest.Tracker.start(back);
            out.printf("  ② 資料先（第 %.0f 秒）：單體的庫裡過時的五張表清空；搬家程式 %s → %s 回填 %,d 列、開始追%n", load.elapsedMs() / 1000.0, Mig.INV_DB, Mig.MONO_DB, copied);
            out.printf("     邊寫邊比：%s%n", new Verifier(Mig.INV_DB, Mig.MONO_DB).run());
            tracker.stop();
            long freezeAt = load.elapsedMs();
            Cutover.Result cut = Cutover.run(back, Mig.MONO_DB, "3", true, null);
            long liveAt = load.elapsedMs();
            back.dropCapture();
            out.printf("     換庫（第 %.0f～%.0f 秒）：%s%n", freezeAt / 1000.0, liveAt / 1000.0, cut);

            Mig.scale("monolith", 1);
            long monoAt = load.elapsedMs();
            Mig.weights(50, 50);
            Thread.sleep(2_000);
            Mig.Http m0 = Mig.http("monolith"), o0 = Mig.http("order-service");
            load.until(monoAt / 1000 + 32);
            Mig.Http m = Mig.http("monolith").minus(m0), o = Mig.http("order-service").minus(o0);
            out.printf("  ③ 程式後（第 %.0f 秒單體 ready）：權重 50／50 的 30 秒：單體 %s │ 訂單服務 %s%n", monoAt / 1000.0, m, o);
            record Window(String shape, int round, long from, long to) {}
            java.util.List<Window> windows = new java.util.ArrayList<>();
            for (int r = 0; r < ROUNDS; r++) {
                boolean monoFirst = r % 2 == 1;                                 // 每一輪換誰先：第 1 輪先量的那一邊，JVM 還在加速（第 02 章 2.8.4 ④ 的追記）
                for (int k = 0; k < 2; k++) {
                    boolean mono = (k == 0) == monoFirst;
                    if (mono) Mig.weights(100, 0); else Mig.weights(0, 100);
                    long t0 = load.elapsedMs();
                    windows.add(new Window(mono ? "單體" : "兩個服務", r + 1, t0 + 2_000, t0 + ROUND * 1000L));   // 切換之後的頭 2 秒不算
                    load.until(t0 / 1000 + ROUND);
                }
            }
            long allMono = load.elapsedMs();
            Mig.weights(100, 0);
            load.until(allMono / 1000 + 15);                                     // 這 15 秒也讓最後一輪送出去的都回來了，才算
            out.printf("     兩條路都在、寫同一個庫：輪流把權重整個切到一邊，各 %d 秒、%d 輪（交錯量，第 02 章 2.8.4 ④；每一輪切換之後的頭 2 秒不算）%n", ROUND, ROUNDS);
            java.util.Map<String, java.util.List<Long>> ms = new java.util.TreeMap<>();
            for (Window w : windows) {
                long[] p = load.p50p99(w.from(), w.to());
                load.done.stream().filter(d -> d.atMs() >= w.from() && d.atMs() < w.to() && d.status() == 201)
                        .forEach(d -> ms.computeIfAbsent(w.shape(), x -> new java.util.ArrayList<>()).add(d.millis()));
                out.printf("       第 %d 輪 %-4s │ 下單 %-12s │ p50 %3d ms、p99 %4d ms%n", w.round(), w.shape(),
                        String.join(" ", Load.fmt(load.codes(w.from(), w.to()))), p[0], p[1]);
            }
            ms.forEach((shape, list) -> {
                long[] sorted = list.stream().mapToLong(Long::longValue).sorted().toArray();
                out.printf("     合計 %-4s │ %,d 張 │ p50 %d ms、p99 %d ms%n", shape, sorted.length, pct(sorted, 50), pct(sorted, 99));
            });
            out.printf("     權重 100／0 的 15 秒：下單 %s%n", Load.fmt(load.codes(allMono, allMono + 15_000)));

            Map<String, Long> orderErrors = Mig.errors("order-service");        // 縮到 0 之前：pod 不在了，日誌就讀不到
            long retireAt = load.elapsedMs();
            Mig.scale("order-service", 0);
            Mig.scale("inventory-service", 0);
            long retiredAt = load.elapsedMs();
            load.until(retiredAt / 1000 + 10);
            load.close();
            out.printf("  ④ 拿掉兩個服務（第 %.0f～%.0f 秒）：下單 %s；②～④ 整段：下單 %s%n", retireAt / 1000.0, retiredAt / 1000.0,
                    Load.fmt(load.codes(retireAt, Long.MAX_VALUE)), Load.fmt(load.codes(0, Long.MAX_VALUE)));
            out.printf("     ② 換庫停寫的那 %.1f 秒：下單 %s；每 5 秒：%s%n", (liveAt - freezeAt) / 1000.0, Load.fmt(load.codes(freezeAt, liveAt)),
                    M4DataSplitTest.windows(load, freezeAt, liveAt + 10_000));
            out.printf("     除了 201、503 之外的狀態碼出現在：%s；訂單服務的 ERROR 日誌：%s%n", Mig.oddWindows(load), orderErrors);

            out.printf("  ⑤ 合併之後：%s%n", measure(keys));
            out.printf("     記憶體：%s%n", Mig.fmtMemory(Mig.memory()));
            out.printf("     單體的庫：INV-2 對不上的商品 %d 個；還在等付款、找不到預留的訂單 %d 張%n", Mig.count(Mig.MONO_DB, Mig.INV2), M4DataSplitTest.orphans(Mig.MONO_DB));
            out.printf("  （結束時 load %s）%n", SplitLab.load());
        }
    }

    static final int ROUND = Integer.getInteger("m5.round", 20), ROUNDS = Integer.getInteger("m5.rounds", 3);

    static long anyProduct() { return FIRST + 100 + ThreadLocalRandom.current().nextInt(900); }

    static long pct(long[] sorted, int p) {
        return sorted.length == 0 ? 0 : sorted[Math.min(sorted.length - 1, (int) Math.ceil(p / 100.0 * sorted.length) - 1)];
    }

    /** 60 秒的下單：狀態碼、p50／p99、每一張成功的訂單幾次服務之間的呼叫 */
    String measure(ConfigurableApplicationContext keys) throws Exception {
        long calls0 = Mig.remoteCalls();
        Load load = Load.start(keys, Mig.ENTRY, rate, M5MergeBackTest::anyProduct);
        load.until(60);
        load.close();
        long calls = Mig.remoteCalls() - calls0, ok = load.codes(0, Long.MAX_VALUE).getOrDefault(201, 0L);
        long[] p = load.p50p99(0, Long.MAX_VALUE);
        return String.format("60 秒下單 %s │ p50 %d ms、p99 %d ms │ 訂單服務呼叫庫存服務 %,d 次（每張成功的訂單 %.1f 次）",
                Load.fmt(load.codes(0, Long.MAX_VALUE)), p[0], p[1], calls, (double) calls / Math.max(1, ok));
    }
}
```

**`src/test/java/com/example/shop/dist09/Verifier.java`**（9.6.3）

```java
package com.example.shop.dist09;

import com.example.shop.dist00.SplitLab;
import com.example.shop.dist02.Copier;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 13 站 9.6.3：遷移期間的對帳 —— 兩個庫一邊被寫、一邊比。
 *
 * 第 02 章 2.8 的核對（Copier.differences）在停寫之後做：整張表的列數＋CRC32 加總，只說「不一樣」。遷移期間兩邊一直在動，
 * 搬家程式總是落後一點，整張表比永遠不一樣。所以：
 *   ① 依主鍵切段（每段 CHUNK 個主鍵），兩邊各算一段的列數＋CRC32 加總
 *   ② 不一樣的段，等一下再比 —— 搬家程式追上了就一樣了。連續 RECHECKS 次都不一樣，才算「真的不一樣」
 *   ③ 真的不一樣的段，逐列比（兩邊各算每一列的 CRC32）—— 列也一樣：連續 RECHECKS 次都不一樣的那幾列，才報出來
 * 兩邊各自算，不跨庫 JOIN（真的搬家時兩個庫在兩台機器上，第 02 章 2.8.1）。
 *
 * 第一版只有段要連續幾次不一樣，逐列只比一次（M4 第一次）：
 *   帳（inventory_ledger）最尾巴的那一段一直有新的列進來，任何一刻都有一兩列還在路上 —— 段連續 3 次都不一樣，逐列比出來的是那一刻最新的一筆帳
 *   inventory 的 1,000 個商品全在同一段、一直有人在下單：故意弄壞的那一列抓到了，同一段裡正在被下單的兩個商品也一起被報出來
 * 改成逐列也要連續幾次「同一列都不一樣」才報；段也切小成 200 個主鍵
 */
public final class Verifier {

    public static final int CHUNK = 200, RECHECKS = 3;
    public static final long WAIT_MS = 1_000;

    /** chunks：比了幾段；firstPass：第一次就不一樣的段；persistent：再比 RECHECKS 次還是不一樣的段；rows：那幾段裡不一樣的列（表:主鍵） */
    public record Report(int chunks, int firstPass, int persistent, List<String> rows, long millis) {
        @Override
        public String toString() {
            return String.format("比了 %,d 段：第一次不一樣 %d 段、再比 %d 次還是不一樣 %d 段%s（%,d ms）", chunks, firstPass, RECHECKS, persistent,
                    rows.isEmpty() ? "" : "，不一樣的列 " + rows, millis);
        }
    }

    private final String a, b;
    private final Map<String, String> rowExpr = new LinkedHashMap<>();

    public Verifier(String a, String b) throws Exception {
        this.a = a;
        this.b = b;
        try (Connection c = SplitLab.root(a); PreparedStatement ps = c.prepareStatement(
                "SELECT column_name FROM information_schema.columns WHERE table_schema = ? AND table_name = ? ORDER BY ordinal_position")) {
            for (String t : Copier.TABLES.keySet()) {
                ps.setString(1, a); ps.setString(2, t);
                List<String> cols = new ArrayList<>();
                try (ResultSet rs = ps.executeQuery()) { while (rs.next()) cols.add("IFNULL(" + rs.getString(1) + ", '∅')"); }
                rowExpr.put(t, "CRC32(CONCAT_WS('|', " + String.join(", ", cols) + "))");
            }
        }
    }

    public Report run() throws Exception {
        long t0 = System.nanoTime();
        int chunks = 0, first = 0, persistent = 0;
        List<String> rows = new ArrayList<>();
        for (String t : Copier.TABLES.keySet()) {
            String pk = Copier.TABLES.get(t);
            long lo = Math.min(bound(a, t, pk, "MIN"), bound(b, t, pk, "MIN")), hi = Math.max(bound(a, t, pk, "MAX"), bound(b, t, pk, "MAX"));
            for (long from = lo; from <= hi; from += CHUNK) {
                chunks++;
                long to = from + CHUNK;
                if (chunk(a, t, pk, from, to).equals(chunk(b, t, pk, from, to))) continue;
                first++;
                boolean same = false;
                for (int i = 0; i < RECHECKS && !same; i++) {
                    Thread.sleep(WAIT_MS);
                    same = chunk(a, t, pk, from, to).equals(chunk(b, t, pk, from, to));
                }
                if (same) continue;
                java.util.Set<Long> suspects = null;
                for (int i = 0; i <= RECHECKS && (suspects == null || !suspects.isEmpty()); i++) {
                    if (i > 0) Thread.sleep(WAIT_MS);
                    Map<Long, Long> x = rows(a, t, pk, from, to), y = rows(b, t, pk, from, to);
                    java.util.Set<Long> now = new java.util.TreeSet<>();
                    for (long id = from; id < to; id++) if (!java.util.Objects.equals(x.get(id), y.get(id))) now.add(id);
                    if (suspects == null) suspects = now; else suspects.retainAll(now);
                }
                if (suspects.isEmpty()) continue;
                persistent++;
                for (long id : suspects) rows.add(t + ":" + id);
            }
        }
        return new Report(chunks, first, persistent, rows, (System.nanoTime() - t0) / 1_000_000);
    }

    private long bound(String db, String t, String pk, String fn) throws Exception {
        return SplitLab.count(db, "SELECT COALESCE(" + fn + "(" + pk + "), 0) FROM " + t);
    }

    private String chunk(String db, String t, String pk, long from, long to) throws Exception {
        try (Connection c = SplitLab.root(db); Statement st = c.createStatement();
             ResultSet rs = st.executeQuery("SELECT COUNT(*), COALESCE(SUM(" + rowExpr.get(t) + "), 0) FROM " + t + " WHERE " + pk + " >= " + from + " AND " + pk + " < " + to)) {
            rs.next();
            return rs.getLong(1) + "/" + rs.getLong(2);
        }
    }

    private Map<Long, Long> rows(String db, String t, String pk, long from, long to) throws Exception {
        Map<Long, Long> m = new HashMap<>();
        try (Connection c = SplitLab.root(db); Statement st = c.createStatement();
             ResultSet rs = st.executeQuery("SELECT " + pk + ", " + rowExpr.get(t) + " FROM " + t + " WHERE " + pk + " >= " + from + " AND " + pk + " < " + to)) {
            while (rs.next()) m.put(rs.getLong(1), rs.getLong(2));
        }
        return m;
    }
}
```

**`src/test/java/com/example/shop/dist09/Cutover.java`**（9.6.5）

```java
package com.example.shop.dist09;

import com.example.shop.dist00.SplitLab;
import com.example.shop.dist02.Copier;
import com.example.shop.dist08.Kube;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * 13 站 9.6.5：庫存服務換庫 —— 停寫、追完、搬共用表裡屬於庫存的那幾列、核對、換設定、起來。
 * 9.7 的回滾、9.10 的合併回去也是它，只是方向反過來。
 *
 * 停寫 = 庫存服務縮到 0（單體在這之前已經縮到 0：庫存的五張表只剩它在寫）。它的 pod 都結束了，連線就斷了，
 * MySQL 會 rollback 它還沒 commit 的交易 —— 變更紀錄剩下的洞都是 rollback（第 02 章 2.8.4 的 ⚠️），可以關掉。
 * 這段時間要預留的下單會失敗（訂單服務的熔斷器，第 06 章 6.7）：這是這個做法的代價，Result 量它多長。
 *
 * 共用的兩張表（shared 的資料夾，每個服務的庫各一份，第 02 章 2.4.3）裡，有幾列是庫存的：
 *   processed_messages：庫存的四個消費者處理過哪些事件，還有 HTTP 命令的冪等鍵（第 03 章 3.5.2 的 Inbox：inventory.http.*）——
 *                       都是 consumer 以 inventory. 開頭。不搬，換庫之後重送的舊訊息、帶著同一個冪等鍵重送的預留，會被當成新的再做一次
 *   outbox_events     ：還沒送出去的事件。舊的庫換庫之後還有人送（moveOutbox = false：另一個服務的 relay 也讀這個庫）就不用搬
 */
public final class Cutover {

    public record Result(long stopMs, long drainMs, int drained, int holesClosed, int dedupCopied, int outboxMoved,
                         Map<String, String> diff, long verifyMs, long startMs) {
        public long totalMs() { return stopMs + drainMs + verifyMs + startMs; }

        @Override
        public String toString() {
            return String.format("停寫 %,.1f 秒 = 縮到 0 %,.1f 秒 ＋ 追完 %,d 筆變更、關掉 %d 個洞 %,d ms ＋ 搬去重紀錄 %,d 列、還沒送出的事件 %,d 則、核對 %,d ms（不一樣的表：%s）＋ 換設定、起來 %,.1f 秒",
                    totalMs() / 1000.0, stopMs / 1000.0, drained, holesClosed, drainMs, dedupCopied, outboxMoved, verifyMs, diff.isEmpty() ? "沒有" : diff, startMs / 1000.0);
        }
    }

    private Cutover() {}

    /**
     * copier：from → to 的那一個（已經在追）。beforeStart：庫存服務在新的庫起來之前要做的事（裝反方向的變更紀錄）。
     * 核對不過 → 不換：用原來的設定起來，丟例外
     */
    public static Result run(Copier copier, String toDb, String toRedis, boolean moveOutbox, Kube.Check beforeStart) throws Exception {
        long t0 = System.nanoTime();
        Mig.scale("inventory-service", 0);
        long t1 = System.nanoTime();
        int drained = 0, n;
        while ((n = copier.apply()) > 0) drained += n;
        int holes = copier.closeHoles();
        int dedup = copy(copier.from, copier.to, "SELECT consumer, message_id, processed_at FROM processed_messages WHERE consumer LIKE 'inventory.%'",
                "INSERT IGNORE INTO processed_messages (consumer, message_id, processed_at) VALUES (?, ?, ?)");
        int outbox = !moveOutbox ? 0 : copy(copier.from, copier.to,
                "SELECT event_id, aggregate_type, aggregate_id, event_type, payload, trace_id, created_at, traceparent FROM outbox_events WHERE published_at IS NULL",
                "INSERT IGNORE INTO outbox_events (event_id, aggregate_type, aggregate_id, event_type, payload, trace_id, created_at, traceparent) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
        if (outbox > 0) Mig.sql(copier.from, "UPDATE outbox_events SET published_at = CURRENT_TIMESTAMP(3) WHERE published_at IS NULL");   // 搬過去了：這一邊不要再送
        long t2 = System.nanoTime();
        Map<String, String> diff = copier.differences();
        long t3 = System.nanoTime();
        if (!diff.isEmpty()) {
            Mig.scale("inventory-service", 2);
            throw new IllegalStateException("核對不過，沒有換庫：" + diff);
        }
        if (beforeStart != null) beforeStart.ok();
        Kube.kubectl("patch", "configmap/inventory-service", "--type=merge", "-p",
                "{\"data\":{\"SHOP_DB_NAME\":\"" + toDb + "\",\"SPRING_DATA_REDIS_DATABASE\":\"" + toRedis + "\"}}");
        Mig.scale("inventory-service", 2);
        long t4 = System.nanoTime();
        return new Result((t1 - t0) / 1_000_000, (t2 - t1) / 1_000_000, drained, holes, dedup, outbox, diff, (t3 - t2) / 1_000_000, (t4 - t3) / 1_000_000);
    }

    /** 從 from 讀、寫進 to（兩條連線，不跨庫）。回傳讀到幾列（INSERT IGNORE：另一邊已經有的不動） */
    static int copy(String from, String to, String select, String insert) throws Exception {
        List<Object[]> rows = new ArrayList<>();
        try (Connection c = SplitLab.root(from); PreparedStatement ps = c.prepareStatement(select); ResultSet rs = ps.executeQuery()) {
            int cols = rs.getMetaData().getColumnCount();
            while (rs.next()) {
                Object[] r = new Object[cols];
                for (int i = 0; i < cols; i++) r[i] = rs.getObject(i + 1);
                rows.add(r);
            }
        }
        if (rows.isEmpty()) return 0;
        try (Connection c = SplitLab.root(to); PreparedStatement ps = c.prepareStatement(insert)) {
            for (Object[] r : rows) {
                for (int i = 0; i < r.length; i++) ps.setObject(i + 1, r[i]);
                ps.addBatch();
            }
            ps.executeBatch();                                              // rewriteBatchedStatements：回傳的是 SUCCESS_NO_INFO，不是列數
            return rows.size();
        }
    }
}
```

**`src/test/java/com/example/shop/account/internal/BootstrapAdminRaceTest.java`**（9.4.3）

```java
package com.example.shop.account.internal;

import com.example.shop.shared.config.ShopProperties;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.transaction.support.TransactionTemplate;

import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Answers.RETURNS_DEEP_STUBS;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * 13 站 9.4.3：兩個行程同時對同一個庫做第一次啟動（遷移期間，單體與訂單服務接同一個庫；或第 12 站的兩台同時第一次部署）。
 * 兩邊都看到「沒有管理員」、都去建 —— 輸的那一邊撞到 uk_users_email，第一版就這樣起不來（kind 上單體的 RESTARTS 1）。
 *
 * 這裡把那個順序釘住：A「檢查」的時候還沒有管理員（第一次的 adminCount 回 0），A「建」的時候 B 已經建好了 ——
 * 庫裡已經有同一個 email 的管理員（這個測試的 Spring context 起來時建的那一個），A 的 insert 真的撞到唯一索引。
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.NONE, properties = "shop.order.jobs-enabled=false")
class BootstrapAdminRaceTest {

    @Autowired JdbcTemplate jdbc;
    @Autowired PasswordEncoder encoder;
    @Autowired TransactionTemplate tx;
    @Autowired ShopProperties props;

    /** 第一次 adminCount() 回 0（A 檢查的那一刻），之後回庫裡真的數字 */
    static class FirstLooksEmpty extends Accounts {
        final AtomicInteger calls = new AtomicInteger();
        final boolean alwaysEmpty;

        FirstLooksEmpty(JdbcTemplate jdbc, boolean alwaysEmpty) {
            super(jdbc);
            this.alwaysEmpty = alwaysEmpty;
        }

        @Override
        long adminCount() { return calls.incrementAndGet() == 1 || alwaysEmpty ? 0 : super.adminCount(); }
    }

    @Test
    void anotherProcessCreatedTheAdminInBetween() {
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM user_roles WHERE role = 'ADMIN'", Long.class)).isPositive();
        long users = jdbc.queryForObject("SELECT COUNT(*) FROM users", Long.class);
        FirstLooksEmpty accounts = new FirstLooksEmpty(jdbc, false);

        assertThatCode(() -> new BootstrapAdmin(accounts, encoder, tx, props).run(null)).doesNotThrowAnyException();
        assertThat(accounts.calls).hasValue(2);                                      // 撞到之後再看一次：有了
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM users", Long.class)).isEqualTo(users);
    }

    /** email 被一個不是管理員的帳號用掉了：不是「別人剛建好」，照舊起不來（US-ACC-3 AC-3） */
    @Test
    void emailTakenButStillNoAdmin() {
        String email = "bootstrap-race@example.com";
        jdbc.update("DELETE FROM user_roles WHERE user_id IN (SELECT id FROM users WHERE email = ?)", email);
        jdbc.update("DELETE FROM users WHERE email = ?", email);
        new Accounts(jdbc).insert(email, encoder.encode("not-an-admin-1234"), "不是管理員", com.example.shop.shared.web.Role.BUYER, null);
        ShopProperties other = mock(ShopProperties.class, RETURNS_DEEP_STUBS);
        when(other.security().bootstrapAdmin()).thenReturn(new ShopProperties.BootstrapAdmin(true, email, "bootstrap-race-1234"));

        assertThatThrownBy(() -> new BootstrapAdmin(new FirstLooksEmpty(jdbc, true), encoder, tx, other).run(null))
                .isInstanceOf(DuplicateKeyException.class);
    }
}
```

**`src/test/java/com/example/shop/catalog/internal/StockReplicaHealthIndicatorTest.java`**（9.4.4）

```java
package com.example.shop.catalog.internal;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.boot.actuate.health.Health;
import org.springframework.boot.actuate.health.Status;

import java.time.Duration;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/** 13 站 9.4.4：訂單服務的副本不完整 → readiness DOWN、自己重建；重建成功一次才 UP */
class StockReplicaHealthIndicatorTest {

    final StockReplica replica = mock(StockReplica.class);
    final StockReplicaHealthIndicator health = new StockReplicaHealthIndicator(replica, Duration.ofMillis(10));

    @Test @DisplayName("13 站 9.4.4：缺 12 個商品 → 重建之前 DOWN，重建完成之後 UP")
    void rebuildsBeforeReady() {
        when(replica.missing()).thenReturn(12L, 0L);
        when(replica.rebuild(500)).thenReturn(new StockReplica.Rebuilt(2, 1_000, 72));
        assertThat(health.health().getStatus()).isEqualTo(Status.DOWN);

        health.ensureComplete();

        Health h = health.health();
        System.out.println("9.4.4 缺 12 個：" + h);
        assertThat(h.getStatus()).isEqualTo(Status.UP);
        verify(replica).rebuild(500);
    }

    @Test @DisplayName("13 站 9.4.4：重建失敗（庫存服務還沒起來）→ 過一會兒再試，成功了才 UP")
    void retriesUntilRebuilt() {
        when(replica.missing()).thenReturn(12L, 12L, 0L);
        when(replica.rebuild(500)).thenThrow(new IllegalStateException("庫存服務連不上")).thenReturn(new StockReplica.Rebuilt(2, 1_000, 80));

        health.ensureComplete();

        assertThat(health.health().getStatus()).isEqualTo(Status.UP);
        verify(replica, times(2)).rebuild(500);
    }

    @Test @DisplayName("13 站 9.4.4：本來就完整 → 不重建")
    void completeAlready() {
        when(replica.missing()).thenReturn(0L);

        health.ensureComplete();

        assertThat(health.health().getStatus()).isEqualTo(Status.UP);
        verify(replica, never()).rebuild(500);
    }

    @Test @DisplayName("13 站 9.4.4：重建完還缺（庫存那一邊沒有那幾個商品）→ 照樣 UP —— 拿它當條件，訂單服務就永遠起不來")
    void stillMissingAfterRebuildIsNotForever() {
        when(replica.missing()).thenReturn(12L, 2L);
        when(replica.rebuild(500)).thenReturn(new StockReplica.Rebuilt(2, 998, 70));

        health.ensureComplete();

        Health h = health.health();
        System.out.println("9.4.4 重建完還缺 2 個：" + h);
        assertThat(h.getStatus()).isEqualTo(Status.UP);
        assertThat(h.getDetails().get("replica").toString()).contains("還缺 2 個");
    }
}
```

**`src/test/java/com/example/shop/catalog/internal/StockReplicaTest.java`**（9.4.4）

```diff
 @SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.NONE, properties = {"shop.order.jobs-enabled=false", "shop.inventory.jobs-enabled=false"})
 class StockReplicaTest {
 
-    static final long A = 9_900_911, B = 9_900_912, C = 9_900_913;
+    static final long A = 9_900_911, B = 9_900_912, C = 9_900_913, D = 9_900_914;
 
     @Autowired JdbcTemplate jdbc;
     final InventoryApi inventory = mock(InventoryApi.class);
…
 
     @AfterEach
     void cleanup() {
-        jdbc.update("DELETE FROM stock_levels WHERE product_id IN (?, ?, ?)", A, B, C);
+        jdbc.update("DELETE FROM stock_levels WHERE product_id IN (?, ?, ?, ?)", A, B, C, D);
+        jdbc.update("DELETE FROM products WHERE id = ?", D);
     }
 
     @Test @DisplayName("13 站 5.4：亂序 —— 版本 3 先到、版本 2 後到：留下 3 的值；同一個版本再來一次：不變；沒有的商品不在結果裡")
…
         assertThat(r.products()).isEqualTo(3);
         assertThat(got).containsEntry(A, 4).containsEntry(B, 10).containsEntry(C, 0);
     }
+
+    @Test @DisplayName("13 站 9.4.4：missing() 數的是「商品有、副本沒有」的那幾個 —— 多一個沒有副本的商品就多 1，副本補上就少 1")
+    void missingCountsProductsWithoutAReplicaRow() {
+        long before = replica.missing();
+        jdbc.update("INSERT INTO products (id, seller_id, category_id, name, price, status) VALUES (?, 900001, (SELECT MIN(id) FROM categories), '9.4 沒有副本的商品', 100.00, 'ON_SALE')", D);
+        long added = replica.missing();
+        replica.apply(D, 5, false, 1, Instant.now());
+        long filled = replica.missing();
+        System.out.println("9.4.4 missing：" + before + " → " + added + " → " + filled);
+        assertThat(added).isEqualTo(before + 1);
+        assertThat(filled).isEqualTo(before);
+    }
 }
```

**`src/test/java/com/example/shop/dist02/Copier.java`**（9.2：改成 public）

```diff
  *                ⚠️ 變更紀錄的號碼不是 commit 的順序：見 holes
  *   checksum(db, t)：列數與每一列內容的 CRC32 加總。兩邊一樣 = 內容一樣（加總跟列的順序無關）
  */
-final class Copier {
+public final class Copier {
 
     /** 庫存模組的五張表與主鍵。順序：先父表（外鍵） */
-    static final Map<String, String> TABLES = new LinkedHashMap<>();
+    public static final Map<String, String> TABLES = new LinkedHashMap<>();
     static {
         TABLES.put("inventory", "product_id");
         TABLES.put("inventory_reservations", "id");
…
 
     static final int BATCH = 2_000;
 
-    final String from, to;
+    public final String from, to;
     final Map<String, List<String>> columns = new LinkedHashMap<>();
-    volatile boolean targetDown = false;                                    // 2.8：「新的庫連不上」—— 這一段時間寫不進去，等它回來
-    long retries = 0;
+    public volatile boolean targetDown = false;                                    // 2.8：「新的庫連不上」—— 這一段時間寫不進去，等它回來
+    public long retries = 0;
 
     /**
      * 2.8.4 ⚠️ 第一版的 bug：變更紀錄的 seq 是 AUTO_INCREMENT —— 號碼在 trigger INSERT 的那一刻就發了，那一列卻要等它的交易 commit 才看得到。
…
      * 所以記下「洞」：比 maxSeen 小、還沒看到的號碼，每一輪再問一次。過了 HOLE_TTL 還沒出現 → 那個交易 rollback 了（號碼不會還回去）
      */
     static final long HOLE_TTL_MS = 60_000;                                 // > innodb_lock_wait_timeout（50 秒）：拿到號碼之後，交易最久還要等這麼久才 commit
-    long maxSeen = 0;
+    public long maxSeen = 0;
     final Map<Long, Long> holes = new LinkedHashMap<>();                    // seq → 第一次發現它是洞的時間
-    long holesFound, holesFilled, holesExpired;
+    public long holesFound, holesFilled, holesExpired;
 
-    Copier(String from, String to) throws Exception {
+    public Copier(String from, String to) throws Exception {
         this.from = from;
         this.to = to;
         try (Connection c = SplitLab.root(from); PreparedStatement ps = c.prepareStatement(
…
     }
 
     /** 一張表整張複製過去。回傳複製了幾列 */
-    long backfill(String table) throws Exception { return backfill(table, true); }
+    public long backfill(String table) throws Exception { return backfill(table, true); }
 
     /**
      * overwrite = false：新的庫已經有的那一列不動（INSERT IGNORE）—— 2.8.3 雙寫時常見的回填寫法：「雙寫寫進去的比較新，不要蓋掉它」
…
     }
 
     /** 套用變更紀錄：seq > maxSeen 的新紀錄，加上之前的洞裡後來才 commit 的。回傳這一輪處理了幾筆紀錄（0 = 追上了） */
-    int apply() throws Exception {
+    public int apply() throws Exception {
         List<long[]> changes = new ArrayList<>();
         List<String> tables = new ArrayList<>();
         try (Connection src = SplitLab.root(from)) {
…
     }
 
     /** 停寫、確認舊庫上沒有進行中的交易之後：剩下的洞都是 rollback（不會再有人 commit 它們）。回傳關掉幾個 */
-    int closeHoles() {
+    public int closeHoles() {
         int n = holes.size();
         holesExpired += n;
         holes.clear();
…
     }
 
     /** 2.8.4：舊的庫上，每一張表的每一種寫入都記一筆「哪張表、哪一個主鍵」—— 跟那一筆寫入在同一個交易裡 */
-    void installCapture() throws Exception {
+    public void installCapture() throws Exception {
         try (Connection c = SplitLab.root(from); Statement st = c.createStatement()) {
             st.execute("""
                     CREATE TABLE d02_changes (seq BIGINT NOT NULL AUTO_INCREMENT, tbl VARCHAR(40) NOT NULL, pk BIGINT NOT NULL,
…
         }
     }
 
-    void dropCapture() throws Exception {
+    public void dropCapture() throws Exception {
         dropTriggers();
         try (Connection c = SplitLab.root(from); Statement st = c.createStatement()) { st.execute("DROP TABLE IF EXISTS d02_changes"); }
     }
…
     }
 
     /** 變更紀錄裡還沒讀到的有幾筆（不含洞） */
-    long lag() throws Exception {
+    public long lag() throws Exception {
         return SplitLab.count(from, "SELECT COUNT(*) FROM d02_changes WHERE seq > " + maxSeen);
     }
 
     /** 列數、內容的 CRC32 加總 */
-    String checksum(String db, String table) throws Exception {
+    public String checksum(String db, String table) throws Exception {
         String row = "CONCAT_WS('|', " + String.join(", ", columns.get(table).stream().map(c -> "IFNULL(" + c + ", '∅')").toList()) + ")";
         try (Connection c = SplitLab.root(db); Statement st = c.createStatement();
              ResultSet rs = st.executeQuery("SELECT COUNT(*), COALESCE(SUM(CRC32(" + row + ")), 0) FROM " + table)) {
…
     }
 
     /** 每一張表兩邊都一樣？回傳不一樣的那幾張（空 = 全部一樣） */
-    Map<String, String> differences() throws Exception {
+    public Map<String, String> differences() throws Exception {
         Map<String, String> d = new LinkedHashMap<>();
         for (String t : TABLES.keySet()) {
             String a = checksum(from, t), b = checksum(to, t);
…
      * 實驗才算得出來的逐列比對（兩個庫剛好在同一台 MySQL 上）：只在舊庫、只在新庫、兩邊都有但內容不同。
      * 真的搬家時用 checksum —— 它只說「不一樣」，不說哪裡不一樣；要找出哪幾列，就再把範圍切小（依主鍵分段算 checksum）
      */
-    Map<String, long[]> rowDiff() throws Exception {
+    public Map<String, long[]> rowDiff() throws Exception {
         Map<String, long[]> m = new LinkedHashMap<>();
         for (String t : TABLES.keySet()) {
             String pk = TABLES.get(t);
```

**`src/test/java/com/example/shop/dist08/Load.java`**（9.2：可以指定每一張買哪一個商品）

```diff
     private final ExecutorService pool = Executors.newVirtualThreadPerTaskExecutor();
     private final Thread sender;
 
-    private Load(ConfigurableApplicationContext keys, int port, int rate) {
+    private Load(ConfigurableApplicationContext keys, int port, int rate, java.util.function.LongSupplier product) {
         sender = new Thread(() -> {
             long gap = 1_000_000_000L / rate;
             for (long i = 0; !stop.get(); i++) {
…
                     long s0 = System.nanoTime();
                     int status;
                     try {
-                        status = Calls.place(port, TestTokens.bearer(keys, BUYERS.incrementAndGet()),
-                                SplitLab.FIRST_PRODUCT + ThreadLocalRandom.current().nextInt(SplitLab.PRODUCTS)).status();
+                        status = Calls.place(port, TestTokens.bearer(keys, BUYERS.incrementAndGet()), product.getAsLong()).status();
                     } catch (Exception e) {
                         status = -1;
                     }
…
     }
 
     public static Load start(ConfigurableApplicationContext keys, int port, int rate) {
-        return new Load(keys, port, rate);
+        return new Load(keys, port, rate, () -> SplitLab.FIRST_PRODUCT + ThreadLocalRandom.current().nextInt(SplitLab.PRODUCTS));
+    }
+
+    /** 13 站第 09 章：每一張下單買哪一個商品，由 product 決定（例如只買庫存有限的那幾個） */
+    public static Load start(ConfigurableApplicationContext keys, int port, int rate, java.util.function.LongSupplier product) {
+        return new Load(keys, port, rate, product);
     }
 
     /** 從開始算第幾秒（等到那一秒才回來） */
```


### 9.13.2 追記：第 09 章寫完之後，改了、新增的檔案

📌 **第 09 章寫完之後的追記**接在同一個分支後面（第 02 章 2.4.4、2.8.6；第 04 章 4.6；第 05 章 5.7.9；第 07 章 7.8.4、7.9.5、7.11.1、7.11.2；第 08 章 8.4.6、8.6.6、8.7.3、8.9.1；這一章 9.4.6、9.5.2、9.5.7、9.5.8、9.6.5、9.6.7、9.6.8、9.8、9.10.4）：

```
（d09，第 09 章寫完之後的 commit）
src/main/java/com/example/shop/
├── shared/deployment/                       WriteGate、WriteGateFilter、WriteGateEndpoint（9.6.7）
├── shared/messaging/internal/RabbitConsumers.java   凍結時停下消費者（9.6.7）
├── shared/security/SecurityConfig.java      /actuator/writes 只收管理員（9.6.7）
├── shared/config/ShopProperties.java        shop.deployment.standby（9.6.7）
├── shared/error/Deadlocks.java              死結（1213）就整個交易重做（9.6.5）
├── inventory/internal/JdbcInventoryService.java    預留的交易換成 TransactionTemplate、包在 Deadlocks.retry 裡（9.6.5）
├── inventory/internal/InventoryJobs.java    每一輪先問 WriteGate（9.6.7）
├── inventory/internal/HotStock.java         shop.inventory.hot.mismatched（第 07 章 7.9.5）
├── ordering/internal/OrderTransitionService.java    PLACEMENT_EXPIRED 的計數器先註冊（第 07 章 7.9.5）
└── catalog/                                  products.hot 不讀不寫、搬家的端點拿掉（第 05 章 5.7.9）
src/main/resources/
├── application.yml                          管理埠多一個 writes
├── db/grants/{inventory-service,order-service}/    每個服務的角色（第 02 章 2.4.4）
└── db/migration/catalog/V36__catalog_drop_products_hot.sql    第 05 章 5.7.9
docker/prometheus/alerts.yml, alerts_test.yml, alerts-burn-rate.yml, alerts-burn-rate_test.yml, test.sh   第 07 章 7.9.5、7.11.2
docker/alertmanager/alertmanager.yml, sink.py                第 07 章 7.11.1
docker/mysql-init/00-users.sql, scripts/d09-kind.sh          兩個服務的帳號（第 02 章 2.4.4）
k8s/
├── base/{order,inventory}-service.yaml, kind/kustomization.yaml, migrate/jobs.yaml   每個服務的 Secret、Job 跑授權（第 02 章 2.4.4）
├── kind/cluster-3nodes.yaml                 第 08 章 8.6.6
├── gitops/                                  第 08 章 8.4.6
└── lab/                                     user-canary（9.5.7）、otel-collector-tail（第 07 章 7.8.4）、git-server（第 08 章 8.4.6）
pom.xml                                      mysql-binlog-connector-java（test，9.6.8）
src/test/java/com/example/shop/
├── architecture/ServiceGrantsTest.java      第 02 章 2.4.4
├── shared/deployment/WriteGateTest.java     9.6.7
├── inventory/internal/ReserveDdlDeadlockTest.java   9.6.5：預留做到一半、有人下 DDL
├── api/AdminReportApiTest.java, TopProductsApiTest.java   清理先刪狀態歷史（下面）
├── catalog/internal/ProductCacheTest.java 等 21 個檔案   products.hot（第 05 章 5.7.9：第一步 3 個、第二步 18 個寫著它的）
├── dist09/                                  M6～M13、Writes、BinlogCopier；Cutover.fast、Mig.nextInventory；M4、M5 的 Flyway 多跑授權（第 02 章 2.4.4）
├── dist07/H7AlertRoutingTest.java           第 07 章 7.11.1
└── dist08/                                  K12～K15
src/test/resources/openapi/shop-api.json     少一支管理員的 API（第 05 章 5.7.9）
```

**正式程式碼的改動有四組**：收縮（`products.hot`，第 05 章 5.7.9）、寫入的開關（`WriteGate`，9.6.7）、告警要的兩個指標（第 07 章 7.9.5）、預留的交易死結就重做（`Deadlocks`，9.6.5）。一個新的 migration（V36，刪一欄）；兩份授權（`db/grants`，第 02 章 2.4.4：只有 `locations` 包含它的部署會跑）；API 少一支（管理員的搬家端點）；管理埠多一個 `/actuator/writes`。

```
TEST_INFRA testcontainers 啟動 10,606 ms：mysql jdbc:mysql://localhost:60618/shop、redis localhost:60599、rabbitmq localhost:60617
TEST_INFRA MySQL 最多同時 37 條連線（max_connections 151）
[INFO] Tests run: 380, Failures: 0, Errors: 0, Skipped: 0
TEST_INFRA testcontainers 啟動 10,785 ms：mysql jdbc:mysql://localhost:63552/shop、redis localhost:63535、rabbitmq localhost:63550
TEST_INFRA MySQL 最多同時 5 條連線（max_connections 151）
[INFO] Tests run: 39, Failures: 0, Errors: 0, Skipped: 0
[INFO] BUILD SUCCESS
[INFO] Total time:  06:01 min
```

上面是最後一個 commit（`afc87dd`）上的整套。**這一節的紀錄各在哪個 commit 上：** 實驗（M6～M12、K12、K14、K15、H7、P14、promtool）是最後一輪在 `cdafb3f` 上、從刪掉 cluster 開始重跑的；那一輪找到的事，之後有 10 個 commit —— 9.6.5 的那張 500（釘住的測試、修法、M13，M13 在 `a9e5c74` 上跑）、第 08 章 8.6.6 的 K13（入口、指標與速率，在 `afc87dd` 上跑）、兩個只改註解的，以及下面這一件（兩個 commit）。

> ⚠️ **整套在最後幾個 commit 上紅過兩次，都是真的紅。** 第一次是 `TableOwnershipTest`（9.6.5 的小坑）。第二次是第 12 站的 `AdminReportApiTest`：清理刪 `orders` 時撞到 `order_status_history` 的外鍵。這個測試自己關了排程，但同一個 JVM 裡還有別的、排程開著的 Spring context（Spring 的測試會把 context 快取起來，整套跑完才關）；它的 `AUTO_COMPLETE`（出貨超過 7 天就自動完成）剛好在那 0.1 秒裡把這個測試建的兩張 2011 年出貨的訂單轉成 COMPLETED、寫了狀態歷史：
>
> ```
> c.e.shop.ordering.internal.OrderJobs     : 排程 AUTO_COMPLETE：掃到 2 張，轉移 2 張
> Tests run: 6, Failures: 0, Errors: 5, Skipped: 0, Time elapsed: 0.119 s <<< FAILURE! -- in com.example.shop.api.AdminReportApiTest
> ```
>
> 之前的每一次整套都沒有碰上。先寫一個測試在清理之前寫那一列（紅），再讓清理先刪狀態歷史（綠）；`TopProductsApiTest` 是同一種資料、同一種清理，一起改。

正文已經完整列出的：`ProductService` 的 diff 與 V36（第 05 章 5.7.9）、`JdbcInventoryService` 的 diff（9.6.5）、`db/grants/inventory-service`、`k8s/base/order-service.yaml` 的 diff（第 02 章 2.4.4）、`HotStock` 的 diff（第 07 章 7.9.5）、`alertmanager.yml` 的 diff（第 07 章 7.11.1）、`user-canary.yaml`（9.5.7）、`flux.yaml` 與 `k8s/gitops/config`（第 08 章 8.4.6）。其餘的：

**`src/main/java/com/example/shop/shared/deployment/WriteGate.java`**（9.6.7）

```java
package com.example.shop.shared.deployment;

import com.example.shop.shared.config.ShopProperties;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.time.Duration;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Consumer;

/**
 * 13 站第 09 章寫完之後的追記（9.6.7）：寫入的開關。切換資料庫的那一刻要「舊的不再寫、新的還不寫」——
 * 第 09 章用縮到 0、換設定、重開來做：停寫 24～29 秒，幾乎都是 pod 的關與起（9.6.5）。這個開關讓兩組 pod 都活著，只換「誰在寫」：
 *
 *   OPEN     照常
 *   STANDBY  起來就是這個狀態（shop.deployment.standby=true）：新的那一組先起來、連好新的庫，什麼都不寫
 *   FROZEN   從 OPEN 切過來（舊的那一組）：不再接新的寫入，等手上的做完才回
 *
 * 不是 OPEN 的時候：HTTP 的寫入（GET、HEAD 以外）回 503；每一個回應都帶 Connection: close —— 呼叫端重用的連線（第 08 章 8.6.1）
 * 下一次就會重新連線，經過 kube-proxy 換到 Service 現在指的那一組；消費者停下（RabbitConsumers）；庫存的排程跳過（InventoryJobs）。
 * 改它的是管理埠的 /actuator/writes（WriteGateEndpoint，只收管理員）。
 *
 * 「手上的寫入」= enter() 到 exit() 之間：HTTP 的寫入、排程的一輪。消費者手上的那一則，由 container 的 stop() 等它做完（監聽者是同步呼叫的）
 */
@Component
public class WriteGate {

    public enum State { OPEN, STANDBY, FROZEN }

    /** listenersMs：監聽者（消費者停下）花了多久；waitedMs：整個 freeze 花了多久（含 listenersMs） */
    public record Frozen(State state, long listenersMs, long waitedMs, int inFlight) {}

    private static final Logger log = LoggerFactory.getLogger(WriteGate.class);

    private volatile State state;
    private final AtomicInteger inFlight = new AtomicInteger();
    private final List<Consumer<State>> listeners = new CopyOnWriteArrayList<>();

    @org.springframework.beans.factory.annotation.Autowired
    public WriteGate(ShopProperties props) {
        this(props.deployment().standby());
    }

    WriteGate(boolean standby) {
        this.state = standby ? State.STANDBY : State.OPEN;
        if (state == State.STANDBY) log.info("WRITE_GATE STANDBY：起來先不寫（shop.deployment.standby=true），等 /actuator/writes 打開");
    }

    public State state() { return state; }

    public boolean open() { return state == State.OPEN; }

    public int inFlight() { return inFlight.get(); }

    /** 要開始寫：OPEN 才回 true（回 true 的一定要 exit()）。先加再看：freeze() 先改狀態再等數字歸零，兩邊不會錯過彼此 */
    public boolean enter() {
        inFlight.incrementAndGet();
        if (state == State.OPEN) return true;
        inFlight.decrementAndGet();
        return false;
    }

    public void exit() { inFlight.decrementAndGet(); }

    /** 排程的一輪：OPEN 才跑，跑的時候算在「手上的寫入」裡 */
    public void run(Runnable job) {
        if (!enter()) return;
        try { job.run(); } finally { exit(); }
    }

    /** 狀態變了之後同步呼叫（例如消費者停下、接上）。起來時的狀態由註冊的一方自己看 state() */
    public void onChange(Consumer<State> listener) {
        listeners.add(listener);
    }

    /** OPEN → FROZEN：不再接新的寫入；先讓監聽者停下（消費者等手上的那一則），再等手上的寫入做完，最多等 timeout */
    public synchronized Frozen freeze(Duration timeout) throws InterruptedException {
        long t0 = System.nanoTime();
        if (state == State.OPEN) {
            state = State.FROZEN;
            listeners.forEach(l -> l.accept(State.FROZEN));
        }
        long t1 = System.nanoTime(), deadline = t0 + timeout.toNanos();
        while (inFlight.get() > 0 && System.nanoTime() < deadline) Thread.sleep(5);
        Frozen f = new Frozen(state, (t1 - t0) / 1_000_000, (System.nanoTime() - t0) / 1_000_000, inFlight.get());
        log.info("WRITE_GATE {} listeners={}ms waited={}ms inFlight={}", f.state(), f.listenersMs(), f.waitedMs(), f.inFlight());
        return f;
    }

    /** STANDBY 或 FROZEN → OPEN：開始寫（消費者接上、排程照跑） */
    public synchronized State openUp() {
        if (state != State.OPEN) {
            state = State.OPEN;
            listeners.forEach(l -> l.accept(State.OPEN));
            log.info("WRITE_GATE OPEN");
        }
        return state;
    }
}
```

**`src/main/java/com/example/shop/shared/deployment/WriteGateFilter.java`**（9.6.7）

```java
package com.example.shop.shared.deployment;

import com.example.shop.shared.error.ProblemType;
import com.example.shop.shared.web.ProblemWriter;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.web.servlet.FilterRegistrationBean;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;

/**
 * 13 站 9.6.7 的追記：WriteGate 不是 OPEN 的時候 ——
 *   寫入（GET、HEAD 以外）→ 503（Retry-After: 1），不進 controller
 *   每一個回應都帶 Connection: close：呼叫端那一條重用的連線用完就關，下一個請求重新連線（kube-proxy 在連線的時候挑 pod，第 08 章 8.6.1）
 * 管理埠（/actuator/**）不經過它：開關本身要打得到。放在限流（-200）之後、Spring Security（-100）之前
 */
@Configuration(proxyBeanMethods = false)
class WriteGateFilter {

    @Bean
    FilterRegistrationBean<OncePerRequestFilter> writesWhileClosed(WriteGate gate, ProblemWriter problems,
                                                                 @Value("${management.server.port:-1}") int managementPort) {
        OncePerRequestFilter f = new OncePerRequestFilter() {
            @Override
            protected boolean shouldNotFilter(HttpServletRequest req) {
                return req.getRequestURI().startsWith("/actuator/") || (managementPort > 0 && req.getLocalPort() == managementPort);
            }

            @Override
            protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res, FilterChain chain) throws ServletException, IOException {
                boolean write = !"GET".equals(req.getMethod()) && !"HEAD".equals(req.getMethod());
                if (!write) {
                    if (!gate.open()) res.setHeader("Connection", "close");
                    chain.doFilter(req, res);
                    return;
                }
                if (!gate.enter()) {
                    res.setHeader("Connection", "close");
                    res.setHeader("Retry-After", "1");
                    problems.write(req, res, ProblemType.TEMPORARILY_UNAVAILABLE, "正在切換，請稍後再試");
                    return;
                }
                try {
                    chain.doFilter(req, res);
                } finally {
                    gate.exit();
                }
            }
        };
        FilterRegistrationBean<OncePerRequestFilter> reg = new FilterRegistrationBean<>(f);
        reg.setOrder(-150);
        return reg;
    }
}
```

**`src/main/java/com/example/shop/shared/deployment/WriteGateEndpoint.java`**（9.6.7）

```java
package com.example.shop.shared.deployment;

import org.springframework.boot.actuate.endpoint.annotation.Endpoint;
import org.springframework.boot.actuate.endpoint.annotation.ReadOperation;
import org.springframework.boot.actuate.endpoint.annotation.WriteOperation;
import org.springframework.stereotype.Component;

import java.time.Duration;
import java.util.Map;

/**
 * 13 站 9.6.7 的追記：/actuator/writes —— 讀：{"state":"OPEN","inFlight":0}；寫：{"state":"FROZEN"} 或 {"state":"OPEN"}。
 * 只在管理埠、只收管理員（SecurityConfig）：它能讓整個服務停止寫入。FROZEN 等手上的寫入做完才回（最多 10 秒），回應裡有等了多久、還剩幾個
 */
@Component
@Endpoint(id = "writes")
class WriteGateEndpoint {

    static final Duration DRAIN = Duration.ofSeconds(10);

    private final WriteGate gate;

    WriteGateEndpoint(WriteGate gate) { this.gate = gate; }

    @ReadOperation
    Map<String, Object> read() {
        return Map.of("state", gate.state().name(), "inFlight", gate.inFlight());
    }

    @WriteOperation
    Map<String, Object> change(String state) throws InterruptedException {
        return switch (WriteGate.State.valueOf(state)) {
            case FROZEN -> {
                WriteGate.Frozen f = gate.freeze(DRAIN);
                yield Map.of("state", f.state().name(), "listenersMs", f.listenersMs(), "waitedMs", f.waitedMs(), "inFlight", f.inFlight());
            }
            case OPEN -> Map.of("state", gate.openUp().name(), "inFlight", gate.inFlight());
            case STANDBY -> throw new IllegalArgumentException("STANDBY 只在起來的時候（shop.deployment.standby=true）");
        };
    }
}
```

**`src/main/java/com/example/shop/shared/error/Deadlocks.java`**（9.6.5）

```java
package com.example.shop.shared.error;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.transaction.support.TransactionSynchronizationManager;

import java.sql.SQLException;
import java.util.function.Supplier;

/**
 * 13 站第 09 章寫完之後的追記（第 09 章 9.6.5）：死結（MySQL 1213）就把整個交易重做一次 —— 錯誤訊息自己說「try restarting transaction」。
 *
 * 第 12 站 2.6.2 用語句的順序（先 UPDATE 父表、再 INSERT 子表）讓 InnoDB 不死結，也說了「沒有重試，每一次死鎖就是一個 500」。
 * 順序擋不住的一種是 metadata lock 的死結：交易改了 inventory 那一列，就拿著子表 inventory_ledger 的 SHARED_READ（外鍵），
 * 這時候一句 DDL（例如搬家程式的 CREATE TRIGGER ON inventory_ledger）拿了 SHARED_NO_WRITE、等著升級成 EXCLUSIVE，
 * 交易的下一句要寫 inventory_ledger，又等它 —— 一個環，被犧牲的一定是 DML（M13）。InnoDB 的死結紀錄裡沒有它。
 * （這幾行註解不寫成 SQL 的樣子：TableOwnershipTest 掃的是原始碼的文字，shared 裡出現「更新庫存表」的那一句 SQL 就算越界）
 *
 * 只接 1213：1205（鎖等待逾時）已經等滿了 innodb_lock_wait_timeout，再等一次只是讓呼叫端等更久。
 * 只在「自己就是整個交易」的時候重做：外面已經有交易，rollback 掉的是外面那一個，要不要重做是外面的事。
 */
public final class Deadlocks {

    static final int ER_LOCK_DEADLOCK = 1213;
    public static final int ATTEMPTS = 3;

    private static final Logger log = LoggerFactory.getLogger(Deadlocks.class);

    private Deadlocks() {}

    /** transaction：自己開、自己 commit 的一個交易（TransactionTemplate.execute）。死結 → 整個再做一次，最多 ATTEMPTS 次 */
    public static <T> T retry(String op, Supplier<T> transaction) {
        for (int attempt = 1; ; attempt++) {
            try {
                return transaction.get();
            } catch (RuntimeException e) {
                if (!isDeadlock(e) || attempt >= ATTEMPTS || TransactionSynchronizationManager.isActualTransactionActive()) throw e;
                log.warn("DEADLOCK_RETRY op={} attempt={}：交易被選為死結的犧牲者，整個重做", op, attempt);
            }
        }
    }

    public static boolean isDeadlock(Throwable e) {
        for (Throwable t = e; t != null; t = t.getCause())
            if (t instanceof SQLException sql && sql.getErrorCode() == ER_LOCK_DEADLOCK) return true;
        return false;
    }
}
```

**`src/main/java/com/example/shop/shared/messaging/internal/RabbitConsumers.java`**（9.6.7）

```diff
     private final com.example.shop.shared.observability.Traces traces;
     private final List<SimpleMessageListenerContainer> containers = new CopyOnWriteArrayList<>();
     private volatile Thread starter;
+    private final com.example.shop.shared.deployment.WriteGate gate;
+    private volatile boolean lifecycleRunning;
 
     RabbitConsumers(List<EventHandler> handlers, ConnectionFactory cf, RabbitTemplate rabbit, EventDispatcher dispatcher,
-                    ObjectMapper json, ShopProperties props, Clock clock, MeterRegistry meters, com.example.shop.shared.observability.Traces traces) {
+                    ObjectMapper json, ShopProperties props, Clock clock, MeterRegistry meters, com.example.shop.shared.observability.Traces traces,
+                    com.example.shop.shared.deployment.WriteGate gate) {
         // 13 站 3.7：同一個 jar 部署成兩個服務時，每一個服務只收「自己擁有的模組」的訊息。
         // 第 12 站是每一個 EventHandler 都開一個 container —— 兩個服務各開一份，同一個佇列就有兩個服務在搶（3.2 ①）：
         // 輪到訂單服務的那一半，商品的庫存列建不起來、熱點的閘門加回到它自己的 Redis 去了（成功、什麼都沒做）。
…
         this.traces = traces;
         // 9.10：每一個消費者的延遲在啟動時就有一條序列（ShopConsumerLag）—— 不然在第一則訊息之前，「這個消費者」在 Prometheus 裡不存在
         for (EventHandler h : this.handlers) lag(h);
+        // 13 站 9.6.7 的追記：寫入的開關。凍結 → 停下 container（stop() 等手上的那一則做完、沒有 ack 的回到佇列）；打開 → 接上。
+        // 待命（STANDBY）起來的時候一個都不開：佇列跟舊的那一組是同一個，先收就是第二個寫入者
+        this.gate = gate;
+        gate.onChange(s -> {
+            if (!lifecycleRunning) return;
+            if (s == com.example.shop.shared.deployment.WriteGate.State.OPEN) startStarter(); else stopContainers();
+        });
     }
 
     /** 13 站 3.7：這個角色擁有的模組的消費者（handler 的類別在哪一個模組的套件裡） */
…
      */
     @Override
     public void start() {
+        lifecycleRunning = true;
+        if (gate.open()) startStarter();
+        else log.info("CONSUMERS 先不接（WriteGate {}）", gate.state());
+    }
+
+    private synchronized void startStarter() {
+        if (starter != null) return;
         Thread t = new Thread(this::startContainers, "rabbit-consumers-starter");
         t.setDaemon(true);
         starter = t;
…
 
     @Override
     public void stop() {
+        lifecycleRunning = false;
+        stopContainers();
+    }
+
+    /**
+     * 13 站 9.6.7 的追記：同時停。每一個 container 的 stop() 要等它的消費者那一輪 receive 結束（一次最多 receiveTimeout，預設 1 秒）——
+     * 第一版一個一個停，WriteGateTest 量到凍結花了 4.8 秒，幾乎都在這裡
+     */
+    private synchronized void stopContainers() {
         Thread t = starter;
         starter = null;
         if (t != null) t.interrupt();
-        containers.forEach(SimpleMessageListenerContainer::stop);
+        List<Thread> stopping = containers.stream().map(c -> Thread.ofVirtual().start(c::stop)).toList();
+        for (Thread s : stopping) {
+            try { s.join(); } catch (InterruptedException e) { Thread.currentThread().interrupt(); break; }
+        }
         containers.clear();
     }
 
+    /** 13 站 9.6.7 的追記：現在開著幾個 container（測試用） */
+    int activeContainers() { return (int) containers.stream().filter(SimpleMessageListenerContainer::isRunning).count(); }
+
     @Override
-    public boolean isRunning() { return starter != null; }
+    public boolean isRunning() { return lifecycleRunning; }
 
     @Override
     public int getPhase() { return Integer.MAX_VALUE - 200; }
```

**`src/main/java/com/example/shop/shared/security/SecurityConfig.java`**（9.6.7：/actuator/writes 只收管理員）

```diff
         // 忘了設 management.server.port（或測試）→ 這條永遠不成立 → 照舊 denyAll（401）：指標不會因為少了一行設定就變成公開的
         org.springframework.security.web.util.matcher.RequestMatcher scrape = req -> managementPort > 0 && req.getLocalPort() == managementPort
                 && "GET".equals(req.getMethod()) && "/actuator/prometheus".equals(req.getRequestURI());
+        // 13 站 9.6.7 的追記：寫入的開關（/actuator/writes）—— 只在管理埠、只收管理員：它能讓整個服務停止寫入
+        org.springframework.security.web.util.matcher.RequestMatcher writes = req -> managementPort > 0 && req.getLocalPort() == managementPort
+                && "/actuator/writes".equals(req.getRequestURI());
         AuthenticationEntryPoint unauthenticated = (req, res, ex) -> {
             boolean badToken = ex instanceof InvalidBearerTokenException;
             res.setHeader("WWW-Authenticate", badToken ? "Bearer error=\"invalid_token\"" : "Bearer");   // RFC 6750：讓客戶端知道該去 refresh
…
                     .requestMatchers(HttpMethod.GET, "/api/ping").permitAll()
                     .requestMatchers(HttpMethod.GET, "/actuator/health", "/actuator/health/**", "/actuator/info").permitAll()   // 5.2.1 B：readiness 401
                     .requestMatchers(scrape).permitAll()                                                // 9.9：只有管理埠
+                    .requestMatchers(writes).hasRole("ADMIN")                                           // 9.6.7 的追記
                     .requestMatchers(HttpMethod.GET, "/v3/api-docs", "/v3/api-docs/**", "/swagger-ui.html", "/swagger-ui/**").permitAll()
                     .requestMatchers("/error").permitAll()                                           // 5.2.1 B'：不然真正的錯誤會被蓋成 401
                     // ── 依角色（0.8 的前綴；第 03 章的 interceptor 表）──
```

**`src/main/java/com/example/shop/shared/config/ShopProperties.java`**（9.6.7：shop.deployment.standby）

```diff
             @NotNull @DefaultValue("monolith") ServiceRole role,
             @Valid @NotNull @DefaultValue Remote inventory,
             @Valid @NotNull @DefaultValue ServiceToken serviceToken,
-            @Valid @NotNull @DefaultValue Edge edge) {
+            @Valid @NotNull @DefaultValue Edge edge,
+            /** 13 站 9.6.7 的追記：起來先不寫（WriteGate 的 STANDBY）—— 切換資料庫時，新的那一組先起來、等 /actuator/writes 打開 */
+            @DefaultValue("false") boolean standby) {
 
         @jakarta.validation.constraints.AssertTrue(message = "shop.deployment.role=order-service 必須設定 shop.deployment.inventory.url")
         public boolean isInventoryReachable() {
```

**`src/main/java/com/example/shop/inventory/internal/InventoryJobs.java`**（9.6.7）

```diff
     private final HotStock hot;
     private final InventoryReconciliation reconciliation;
     private final ShopProperties props;
+    private final com.example.shop.shared.deployment.WriteGate gate;
 
-    InventoryJobs(HotStock hot, InventoryReconciliation reconciliation, ShopProperties props) {
+    InventoryJobs(HotStock hot, InventoryReconciliation reconciliation, ShopProperties props, com.example.shop.shared.deployment.WriteGate gate) {
         this.hot = hot;
         this.reconciliation = reconciliation;
         this.props = props;
+        this.gate = gate;
     }
 
+    /** 13 站 9.6.7 的追記：每一輪都先問 WriteGate —— 切換資料庫時，舊的那一組凍結之後、新的那一組打開之前，誰都不跑（WriteGate.run） */
     @Override
     public void configureTasks(ScheduledTaskRegistrar registrar) {
-        registrar.addFixedDelayTask(() -> {
+        registrar.addFixedDelayTask(() -> gate.run(() -> {
             int fixed = hot.reconcile();
             if (fixed > 0) log.warn("熱點庫存對帳：修正了 {} 個商品", fixed);
-        }, props.inventory().hotReconcileInterval());
+        }), props.inventory().hotReconcileInterval());
         // 7.10：不在啟動的那一刻跑（對帳要掃整張 inventory_ledger，不要跟啟動搶資源）—— 第一次在一個間隔之後
         var every = props.inventory().invariantCheckInterval();
-        registrar.addFixedDelayTask(new org.springframework.scheduling.config.FixedDelayTask(reconciliation::checkInvariants, every, every));
+        registrar.addFixedDelayTask(new org.springframework.scheduling.config.FixedDelayTask(() -> gate.run(reconciliation::checkInvariants), every, every));
         var week = java.time.Duration.ofDays(7);                           // 9.12：增量的累計每週用全掃校正一次
-        registrar.addFixedDelayTask(new org.springframework.scheduling.config.FixedDelayTask(reconciliation::checkFullAndRebaseline, week, week));
+        registrar.addFixedDelayTask(new org.springframework.scheduling.config.FixedDelayTask(() -> gate.run(reconciliation::checkFullAndRebaseline), week, week));
         var thirty = java.time.Duration.ofSeconds(30);
-        registrar.addFixedDelayTask(new org.springframework.scheduling.config.FixedDelayTask(reconciliation::checkUncounted, thirty, thirty));
+        registrar.addFixedDelayTask(new org.springframework.scheduling.config.FixedDelayTask(() -> gate.run(reconciliation::checkUncounted), thirty, thirty));
     }
 }
```

**`src/main/java/com/example/shop/ordering/internal/OrderTransitionService.java`**（第 07 章 7.9.5）

```diff
         this.outbox = outbox;
         this.clock = clock;
         this.meters = meters;
+        // 13 站第 09 章寫完之後的追記（第 07 章 7.9.5）：告警看 PLACEMENT_EXPIRED，這一條序列要在第一次發生之前就存在（AlertMetricsTest）——
+        // 不然 increase() 在第一次的時候看不到「從 0 變 1」，那一次不會響
+        meters.counter("shop.orders.rejected", "reason", OrderEvent.PLACEMENT_EXPIRED.name());
     }
 
     @Transactional
```

**`src/main/java/com/example/shop/catalog/internal/Product.java`**（第 05 章 5.7.9）

```diff
     @Column(nullable = false, length = 20)
     private ProductStatus status;
 
-    @Column(nullable = false)
-    private boolean hot;
-
     @Column(nullable = false, updatable = false)
     private Instant createdAt;
 
…
 
     boolean ownedBy(long userId) { return sellerId == userId; }
 
-    /** 6.5 熱點商品（0.6.1 第 3 條：由賣家標記）。@return true = 這次真的改變了 */
-    boolean markHot(boolean hot, Instant now) {
-        if (this.hot == hot) return false;
-        this.hot = hot;
-        updatedAt = now;
-        return true;
-    }
-
     /** 金額一律兩位小數：299 與 299.00 在 BigDecimal 裡是兩個「不相等」的值（equals 會比 scale，第 04 章） */
     private static BigDecimal money(BigDecimal v) { return v.setScale(2, java.math.RoundingMode.UNNECESSARY); }
 
…
     String getDescription() { return description; }
     BigDecimal getPrice() { return price; }
     ProductStatus getStatus() { return status; }
-    boolean isHot() { return hot; }
     Instant getCreatedAt() { return createdAt; }
     Instant getUpdatedAt() { return updatedAt; }
     /** 6.4.1：快取用它判斷「哪一個值比較新」。flush 之後才是新的版本 */
```

**`src/main/java/com/example/shop/catalog/internal/ProductCache.java`**（第 05 章 5.7.9）

```diff
 
     /** 商品頁需要的欄位（不含可售數量）。version 是 products.version */
     record Core(long id, long sellerId, String name, String description, BigDecimal price, long categoryId,
-                ProductStatus status, boolean hot, int version) {}
+                ProductStatus status, int version) {}
 
     static final Duration TTL = Duration.ofMinutes(10);
     /** Redis 不能用的時候，本機記憶體裡的副本放多久（US-PRD-3 AC-3：改價後 1 秒內要讀到新價格） */
```

**`src/main/java/com/example/shop/catalog/internal/ProductRepository.java`**（第 05 章 5.7.9）

```diff
 interface ProductRepository extends JpaRepository<Product, Long>, JpaSpecificationExecutor<Product> {
 
     Page<Product> findBySellerId(long sellerId, Pageable pageable);
-
-    /** 13 站 5.7：搬家用 —— 舊的旗標（products.hot）還是 true 的商品 */
-    @org.springframework.data.jpa.repository.Query("select p.id from Product p where p.hot = true")
-    java.util.List<Long> findHotIds();
 }
```

**`src/main/java/com/example/shop/catalog/ProductSnapshot.java`**（第 05 章 5.7.9）

```diff
 import java.math.BigDecimal;
 
 /** 其他模組看到的商品：只有它們需要的欄位，而且是「讀的那一刻」的值。 */
-public record ProductSnapshot(long id, long sellerId, String name, BigDecimal price, ProductStatus status, boolean hot) {
+public record ProductSnapshot(long id, long sellerId, String name, BigDecimal price, ProductStatus status) {
     public boolean purchasable() { return status == ProductStatus.ON_SALE; }
 }
```

**`src/main/resources/application.yml`**（9.6.7）

```diff
   endpoints:
     web:
       exposure:
-        include: health,info,prometheus   # 9.9：prometheus 只在管理埠上（正式環境的 management.server.port，不對外）
+        include: health,info,prometheus,writes   # 9.9：prometheus 只在管理埠上（正式環境的 management.server.port，不對外）；writes：13 站 9.6.7 的追記（WriteGateEndpoint）
   endpoint:
     health:
       probes:
```

**`src/main/resources/db/grants/order-service/afterMigrate__order_app_grants.sql`**（第 02 章 2.4.4）

```sql
-- 13 站第 09 章寫完之後的追記（第 02 章 2.4.4）：訂單服務自己的角色 —— 其他六個有表的模組（account、cart、catalog、notification、ordering、payment；reporting 沒有自己的表）與 shared，一張庫存的表都沒有。
-- 共用一個庫的那一段（第 09 章 9.4），訂單服務的帳號就讀不到、寫不到庫存的五張表：程式碼的邊界之外，多一道資料庫的邊界
CREATE ROLE IF NOT EXISTS order_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON users TO order_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON user_roles TO order_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON refresh_tokens TO order_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON products TO order_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON categories TO order_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON stock_levels TO order_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON cart_items TO order_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON orders TO order_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON order_items TO order_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON order_status_history TO order_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON idempotency_keys TO order_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON payments TO order_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON refunds TO order_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON notifications TO order_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON outbox_events TO order_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON processed_messages TO order_app;
GRANT SELECT, INSERT ON audit_logs TO order_app;
GRANT EXECUTE ON PROCEDURE purge_audit_logs TO order_app;
```

**`docker/prometheus/alerts.yml`**（第 07 章 7.9.5、7.11.2）

```diff
         annotations:
           summary: "5xx 超過 1%（{{ $value | humanizePercentage }}），持續 5 分鐘"
           why: "0.6.6。Redis 掛了的時候熱點下單照設計回 503（0.6.3），這條也會響 —— 那是一次事故，該響"
+      - alert: ShopHigh5xxRatioFast
+        # 13 站第 09 章寫完之後的追記（第 07 章 7.11.2）：整個壞掉的時候，不要等 5 分鐘。一半以上是 5xx、5 分鐘窗與 1 分鐘窗都是，沒有 for ——
+        #   全部 5xx 的事故 2 分半就響（上面那一條是 5 分多鐘）。50% 是判斷：小的、慢慢燒的，留給上面那一條。兩條都響時，Alertmanager 抑制上面那一條
+        expr: |
+          (sum(rate(http_server_requests_seconds_count{system="shop",uri=~"/api/.*",status=~"5.."}[5m]))
+             / sum(rate(http_server_requests_seconds_count{system="shop",uri=~"/api/.*"}[5m])) > 0.5)
+          and
+          (sum(rate(http_server_requests_seconds_count{system="shop",uri=~"/api/.*",status=~"5.."}[1m]))
+             / sum(rate(http_server_requests_seconds_count{system="shop",uri=~"/api/.*"}[1m])) > 0.5)
+        labels: {severity: page}
+        annotations:
+          summary: "5xx 超過一半（{{ $value | humanizePercentage }}）"
+          why: "13 站 7.11.2：整個壞掉的事故不等 5 分鐘"
       - alert: ShopPlaceOrderSlow
         # p99 > 500 ms ⇔ 超過 500 ms 的請求 > 1%。用 SLO 的桶算比例，不估 p99（application.yml 的 slo）
         # 9.10 J8d：第一版只有 5 分鐘窗 —— Redis 停 60 秒，恢復之後 4 分 23 秒才 firing、31 秒後自己解除。加 1 分鐘窗
…
         annotations:
           summary: "下單超過 500 ms 的比例 {{ $value | humanizePercentage }}（> 1% = p99 > 500 ms），持續 5 分鐘"
           why: "0.6.6、0.6.2（熱點下單 p99 500 ms）"
+      - alert: ShopPlaceOrderSlowFast
+        # 13 站第 09 章寫完之後的追記（第 07 章 7.11.2）：同上，下單一半以上超過 500 ms —— 7.11 的演練（每一張都慢 0.6 秒）就是這一種
+        expr: |
+          ((
+            sum(rate(http_server_requests_seconds_count{system="shop",uri="/api/orders",method="POST"}[5m]))
+            - sum(rate(http_server_requests_seconds_bucket{system="shop",uri="/api/orders",method="POST",le="0.5"}[5m]))
+          ) / sum(rate(http_server_requests_seconds_count{system="shop",uri="/api/orders",method="POST"}[5m])) > 0.5)
+          and
+          ((
+            sum(rate(http_server_requests_seconds_count{system="shop",uri="/api/orders",method="POST"}[1m]))
+            - sum(rate(http_server_requests_seconds_bucket{system="shop",uri="/api/orders",method="POST",le="0.5"}[1m]))
+          ) / sum(rate(http_server_requests_seconds_count{system="shop",uri="/api/orders",method="POST"}[1m])) > 0.5)
+        labels: {severity: page}
+        annotations:
+          summary: "下單一半以上超過 500 ms（{{ $value | humanizePercentage }}）"
+          why: "13 站 7.11.2：整個變慢的事故不等 5 分鐘"
       - alert: ShopJobHigh5xxRatio
         # 13 站 9.5.2：同一件事，每一個接 /api/** 的 job 各算各的。灰度的時候，新的那一邊只分到 5%：它的 5xx 是 10%，全站只有 0.5% ——
         #   上面那一條不會響（被舊的那一邊稀釋了）。這一條看得到，而且 job 標籤就是「哪一邊」。
…
         annotations:
           summary: "熱點對帳修正了 Redis 與 MySQL 的差異"
           why: "6.6：正常的系統這個計數器永遠是 0"
+      - alert: ShopHotStockMismatchPersistent
+        # 13 站第 09 章寫完之後的追記（第 07 章 7.9.5；第 04 章 4.2.2 留給第 07 章的那一條）：搶購進行中，熱點對帳一次都不修 ——
+        #   「連續兩輪看到同一組」永遠不成立，上面那一條（修了才加 1）也就不會響。這一條看「每一輪都有對不上的」：15 分鐘裡每一分鐘的最小值都 > 0。
+        #   一張訂單從閘門到落帳的那幾百毫秒裡本來就對不上，所以只要有某一輪對上了，就不響；一場一直有人在買、每一輪都剛好有訂單在路上的搶購，會誤報（推論，沒有量）
+        expr: min_over_time(max(shop_inventory_hot_mismatched{system="shop"})[15m:1m]) > 0
+        labels: {severity: ticket}
+        annotations:
+          summary: "熱點商品的 Redis 與 MySQL，15 分鐘裡每一輪都對不上（最少 {{ $value }} 個）"
+          why: "13 站 4.2.2：閘門扣了之後、訂單寫下之前當掉的那一件，搶購進行中不會被修 —— 少賣，不是超賣"
+      - alert: ShopPlacementsExpired
+        # 13 站第 09 章寫完之後的追記（第 07 章 7.9.5；第 04 章 4.9）：停在 RESERVING 太久、被排程補償掉的下單。
+        #   買家那時候已經拿到 503（ShopHigh5xxRatio 算過了），這一條不叫醒人：它說的是「Saga 卡在中間」—— 協調者當掉、庫存服務沒有回應
+        expr: sum(increase(shop_orders_rejected_total{system="shop",reason="PLACEMENT_EXPIRED"}[15m])) > 0
+        labels: {severity: ticket}
+        annotations:
+          summary: "15 分鐘內有 {{ $value }} 張下單停在 RESERVING、被補償掉"
+          why: "13 站 4.9：RESERVE_FAILED（庫存不足）是正常的業務，PLACEMENT_EXPIRED 不是"
+      - alert: ShopConsumeConflict
+        # 13 站第 09 章寫完之後的追記（第 07 章 7.9.5；第 04 章 4.6.3）：已經出貨的訂單，它的預留卻已經釋放 —— 貨可能出去了、帳上沒扣
+        expr: sum(increase(shop_inventory_consume_conflict_total{system="shop"}[15m])) > 0
+        labels: {severity: ticket}
+        annotations:
+          summary: "出貨時預留已經釋放（{{ $value }} 筆）：要有人去看貨到底在不在"
+          why: "13 站 4.6.3：正常應該永遠是 0"
       - alert: ShopAuditDropped
         expr: sum(increase(shop_audit_dropped_total{system="shop"}[5m])) > 0
         labels: {severity: page}
```

**`docker/prometheus/alerts_test.yml`**（第 07 章 7.9.5）

```diff
         values: '0 0 0 0 0+1x8 9+0x28'
     alert_rule_test:
       - {eval_time: 6m30s, alertname: ShopJobHigh5xxRatio, exp_alerts: []}
+  # 13 站第 09 章寫完之後的追記（第 07 章 7.9.5）：第 04 章留給第 07 章的三個訊號
+  # 搶購進行中：每一輪都有 1～3 個對不上（修不了），15 分鐘 → 響；中間有一輪對上了（0）→ 不響
+  - interval: 1m
+    input_series:
+      - series: 'shop_inventory_hot_mismatched{job="inventory-service",system="shop"}'
+        values: '0 2 1 3 1 2 1 1 2 3 1 2 1 1 2 1 2 1 1 2 1'
+      - series: 'shop_inventory_hot_mismatched{job="inventory-service",system="shop",pod="b"}'
+        values: '0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0'
+    alert_rule_test:
+      - {eval_time: 10m, alertname: ShopHotStockMismatchPersistent, exp_alerts: []}
+      - eval_time: 16m
+        alertname: ShopHotStockMismatchPersistent
+        exp_alerts:
+          - exp_labels: {severity: ticket}
+            exp_annotations: {summary: "熱點商品的 Redis 與 MySQL，15 分鐘裡每一輪都對不上（最少 1 個）", why: "13 站 4.2.2：閘門扣了之後、訂單寫下之前當掉的那一件，搶購進行中不會被修 —— 少賣，不是超賣"}
+  - interval: 1m
+    input_series:
+      - series: 'shop_inventory_hot_mismatched{job="inventory-service",system="shop"}'
+        values: '0 2 1 3 1 2 1 0 2 3 1 2 1 1 2 1 2 1 1 2 1'
+    alert_rule_test:
+      - {eval_time: 16m, alertname: ShopHotStockMismatchPersistent, exp_alerts: []}
+  # PLACEMENT_EXPIRED：序列在啟動時就有（0），之後多 2 → 響；RESERVE_FAILED 多再多也不響
+  - interval: 15s
+    input_series:
+      - series: 'shop_orders_rejected_total{job="order-service",system="shop",reason="PLACEMENT_EXPIRED"}'
+        values: '0 0 0 0 2 2 2 2'
+      - series: 'shop_orders_rejected_total{job="order-service",system="shop",reason="RESERVE_FAILED"}'
+        values: '0+50x7'
+    alert_rule_test:
+      - eval_time: 105s
+        alertname: ShopPlacementsExpired
+        exp_alerts:
+          - exp_labels: {severity: ticket}
+            exp_annotations: {summary: "15 分鐘內有 2 張下單停在 RESERVING、被補償掉", why: "13 站 4.9：RESERVE_FAILED（庫存不足）是正常的業務，PLACEMENT_EXPIRED 不是"}
+  - interval: 15s
+    input_series:
+      - series: 'shop_inventory_consume_conflict_total{job="inventory-service",system="shop"}'
+        values: '0 0 0 1 1 1 1 1'
+    alert_rule_test:
+      - eval_time: 105s
+        alertname: ShopConsumeConflict
+        exp_alerts:
+          - exp_labels: {severity: ticket}
+            exp_annotations: {summary: "出貨時預留已經釋放（1 筆）：要有人去看貨到底在不在", why: "13 站 4.6.3：正常應該永遠是 0"}
```

**`docker/prometheus/alerts-burn-rate.yml`**（第 07 章 7.11.2）

```yaml
# 13 站第 09 章寫完之後的追記（第 07 章 7.11.2）：依燃燒速率的告警（Google SRE Workbook 第 5 章的多窗、多燃燒速率）。
# 這一份只給 promtool 比較用（alerts-burn-rate_test.yml），Prometheus 沒有載入它 —— 為什麼，見 7.11.2。
# SLO：/api/** 的 99% 不是 5xx（第 12 站 0.6.6 的 1%）。錯誤預算 = 1%，一個月 30 天。
#   燃燒速率 14.4：照這個速度，一個月的預算 2 天燒完；1 小時燒掉預算的 2%。長窗 1 小時、短窗 5 分鐘（還在燒才響）
#   燃燒速率 6   ：5 天燒完；6 小時燒掉 5%。長窗 6 小時、短窗 30 分鐘
# 門檻 = 燃燒速率 × 預算：14.4 × 1% = 14.4% 的 5xx、6 × 1% = 6%
groups:
  - name: shop-slo-burn-rate
    rules:
      - alert: ShopErrorBudgetBurn14x
        expr: |
          (sum(rate(http_server_requests_seconds_count{system="shop",uri=~"/api/.*",status=~"5.."}[1h]))
             / sum(rate(http_server_requests_seconds_count{system="shop",uri=~"/api/.*"}[1h])) > 14.4 * 0.01)
          and
          (sum(rate(http_server_requests_seconds_count{system="shop",uri=~"/api/.*",status=~"5.."}[5m]))
             / sum(rate(http_server_requests_seconds_count{system="shop",uri=~"/api/.*"}[5m])) > 14.4 * 0.01)
        labels: {severity: page}
        annotations:
          summary: "錯誤預算燃燒速率 > 14.4（1 小時窗 {{ $value | humanizePercentage }}）"
      - alert: ShopErrorBudgetBurn6x
        expr: |
          (sum(rate(http_server_requests_seconds_count{system="shop",uri=~"/api/.*",status=~"5.."}[6h]))
             / sum(rate(http_server_requests_seconds_count{system="shop",uri=~"/api/.*"}[6h])) > 6 * 0.01)
          and
          (sum(rate(http_server_requests_seconds_count{system="shop",uri=~"/api/.*",status=~"5.."}[30m]))
             / sum(rate(http_server_requests_seconds_count{system="shop",uri=~"/api/.*"}[30m])) > 6 * 0.01)
        labels: {severity: page}
        annotations:
          summary: "錯誤預算燃燒速率 > 6（6 小時窗 {{ $value | humanizePercentage }}）"
```

**`docker/prometheus/alerts-burn-rate_test.yml`**（第 07 章 7.11.2）

```yaml
# 13 站第 09 章寫完之後的追記（第 07 章 7.11.2）：四種事故，四種規則，各在第幾分鐘響（docker/prometheus/test.sh 也跑它）。
# 每一組先有 6 小時乾淨的流量（每 15 秒 1,000 個 /api/**），第 360 分鐘出事：
#   S1 全部 5xx、S2 20% 5xx、S3 2% 5xx、S4 全部 5xx 但只有 3 分鐘
# 規則：ShopHigh5xxRatio（1%、5 分鐘窗＋1 分鐘窗、for 5m）、ShopHigh5xxRatioFast（50%、兩個窗、沒有 for）、
#       ShopErrorBudgetBurn14x（1 小時＋5 分鐘）、ShopErrorBudgetBurn6x（6 小時＋30 分鐘）
rule_files: [alerts.yml, alerts-burn-rate.yml]
evaluation_interval: 15s
tests:
  # S1 全部 5xx
  - interval: 15s
    input_series:
      - series: 'http_server_requests_seconds_count{job="shop",system="shop",status="200",uri="/api/products/{id}"}'
        values: '0+1000x1440 1440000+0x120'
      - series: 'http_server_requests_seconds_count{job="shop",system="shop",status="503",uri="/api/products/{id}"}'
        values: '0+0x1440 0+1000x120'
    alert_rule_test:
      - {eval_time: 362m15s, alertname: ShopHigh5xxRatioFast, exp_alerts: []}
      - {eval_time: 363m, alertname: ShopHigh5xxRatioFast, exp_alerts: [{exp_labels: {severity: page}, exp_annotations: {summary: "5xx 超過一半（59.89%）", why: "13 站 7.11.2：整個壞掉的事故不等 5 分鐘"}}]}
      - {eval_time: 365m, alertname: ShopHigh5xxRatio, exp_alerts: []}
      - {eval_time: 366m, alertname: ShopHigh5xxRatio, exp_alerts: [{exp_labels: {severity: page}, exp_annotations: {summary: "5xx 超過 1%（100%），持續 5 分鐘", why: "0.6.6。Redis 掛了的時候熱點下單照設計回 503（0.6.3），這條也會響 —— 那是一次事故，該響"}}]}
      - {eval_time: 368m15s, alertname: ShopErrorBudgetBurn14x, exp_alerts: []}
      - {eval_time: 369m15s, alertname: ShopErrorBudgetBurn14x, exp_alerts: [{exp_labels: {severity: page}, exp_annotations: {summary: "錯誤預算燃燒速率 > 14.4（1 小時窗 15.07%）"}}]}
      - {eval_time: 381m, alertname: ShopErrorBudgetBurn6x, exp_alerts: []}
      - {eval_time: 382m15s, alertname: ShopErrorBudgetBurn6x, exp_alerts: [{exp_labels: {severity: page}, exp_annotations: {summary: "錯誤預算燃燒速率 > 6（6 小時窗 6.116%）"}}]}
  # S2 20% 5xx：ShopHigh5xxRatio 照樣 5 分鐘；快的那一條不響；14.4 倍要 43 分鐘、6 倍要 108 分鐘
  - interval: 15s
    input_series:
      - series: 'http_server_requests_seconds_count{job="shop",system="shop",status="200",uri="/api/products/{id}"}'
        values: '0+1000x1440 1440000+800x480'
      - series: 'http_server_requests_seconds_count{job="shop",system="shop",status="503",uri="/api/products/{id}"}'
        values: '0+0x1440 0+200x480'
    alert_rule_test:
      - {eval_time: 366m, alertname: ShopHigh5xxRatio, exp_alerts: [{exp_labels: {severity: page}, exp_annotations: {summary: "5xx 超過 1%（20%），持續 5 分鐘", why: "0.6.6。Redis 掛了的時候熱點下單照設計回 503（0.6.3），這條也會響 —— 那是一次事故，該響"}}]}
      - {eval_time: 470m, alertname: ShopHigh5xxRatioFast, exp_alerts: []}
      - {eval_time: 402m30s, alertname: ShopErrorBudgetBurn14x, exp_alerts: []}
      - {eval_time: 404m, alertname: ShopErrorBudgetBurn14x, exp_alerts: [{exp_labels: {severity: page}, exp_annotations: {summary: "錯誤預算燃燒速率 > 14.4（1 小時窗 14.65%）"}}]}
      - {eval_time: 467m, alertname: ShopErrorBudgetBurn6x, exp_alerts: []}
      - {eval_time: 469m, alertname: ShopErrorBudgetBurn6x, exp_alerts: [{exp_labels: {severity: page}, exp_annotations: {summary: "錯誤預算燃燒速率 > 6（6 小時窗 6.046%）"}}]}
  # S3 2% 5xx：只有 ShopHigh5xxRatio 響 —— 而且要 7 分多鐘：5 分鐘窗要過了一半（2.5 分鐘）比例才超過 1%，再 for 5m。
  #   兩條燃燒速率兩個小時都不響（2% < 6%、< 14.4%）
  - interval: 15s
    input_series:
      - series: 'http_server_requests_seconds_count{job="shop",system="shop",status="200",uri="/api/products/{id}"}'
        values: '0+1000x1440 1440000+980x480'
      - series: 'http_server_requests_seconds_count{job="shop",system="shop",status="503",uri="/api/products/{id}"}'
        values: '0+0x1440 0+20x480'
    alert_rule_test:
      - {eval_time: 367m, alertname: ShopHigh5xxRatio, exp_alerts: []}
      - {eval_time: 368m15s, alertname: ShopHigh5xxRatio, exp_alerts: [{exp_labels: {severity: page}, exp_annotations: {summary: "5xx 超過 1%（2%），持續 5 分鐘", why: "0.6.6。Redis 掛了的時候熱點下單照設計回 503（0.6.3），這條也會響 —— 那是一次事故，該響"}}]}
      - {eval_time: 480m, alertname: ShopErrorBudgetBurn14x, exp_alerts: []}
      - {eval_time: 480m, alertname: ShopErrorBudgetBurn6x, exp_alerts: []}
      - {eval_time: 480m, alertname: ShopHigh5xxRatioFast, exp_alerts: []}
  # S4 全部 5xx，但只有 3 分鐘：ShopHigh5xxRatio 不響（1 分鐘窗先乾淨了，for 5m 一直沒有滿）；快的那一條響了一下
  - interval: 15s
    input_series:
      - series: 'http_server_requests_seconds_count{job="shop",system="shop",status="200",uri="/api/products/{id}"}'
        values: '0+1000x1440 1440000+0x12 1440000+1000x60'
      - series: 'http_server_requests_seconds_count{job="shop",system="shop",status="503",uri="/api/products/{id}"}'
        values: '0+0x1440 0+1000x12 12000+0x60'
    alert_rule_test:
      - {eval_time: 362m15s, alertname: ShopHigh5xxRatioFast, exp_alerts: []}
      - {eval_time: 363m, alertname: ShopHigh5xxRatioFast, exp_alerts: [{exp_labels: {severity: page}, exp_annotations: {summary: "5xx 超過一半（59.89%）", why: "13 站 7.11.2：整個壞掉的事故不等 5 分鐘"}}]}
      - {eval_time: 366m, alertname: ShopHigh5xxRatio, exp_alerts: []}
      - {eval_time: 368m, alertname: ShopHigh5xxRatio, exp_alerts: []}
      - {eval_time: 370m, alertname: ShopHigh5xxRatio, exp_alerts: []}
      - {eval_time: 375m, alertname: ShopErrorBudgetBurn14x, exp_alerts: []}
```

**`docker/prometheus/test.sh`**（第 07 章 7.11.2）

```diff
 #!/usr/bin/env bash
 # 9.10：檢查與測試告警規則（只要 Docker）
 cd "$(dirname "$0")"
-docker run --rm -v "$PWD":/rules -w /rules --entrypoint promtool prom/prometheus:v3.5.0 check rules alerts.yml && \
-docker run --rm -v "$PWD":/rules -w /rules --entrypoint promtool prom/prometheus:v3.5.0 test rules alerts_test.yml
+docker run --rm -v "$PWD":/rules -w /rules --entrypoint promtool prom/prometheus:v3.5.0 check rules alerts.yml alerts-burn-rate.yml && \
+docker run --rm -v "$PWD":/rules -w /rules --entrypoint promtool prom/prometheus:v3.5.0 test rules alerts_test.yml alerts-burn-rate_test.yml
```

**`docker/alertmanager/sink.py`**（第 07 章 7.11.1）

```diff
     def do_POST(self):
         body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
         now = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='milliseconds')
+        # 13 站第 09 章寫完之後的追記（第 07 章 7.11.1）：groupKey —— 值班系統（PagerDuty 一類）拿它當「同一張單」：同一組的下一則通知是更新，不是再叫一次
         for a in body.get('alerts', []):
-            print(json.dumps({'received': now, 'status': a['status'], 'alertname': a['labels'].get('alertname'),
+            print(json.dumps({'received': now, 'groupKey': body.get('groupKey'), 'status': a['status'], 'alertname': a['labels'].get('alertname'),
                               'severity': a['labels'].get('severity'), 'summary': a['annotations'].get('summary'),
                               'startsAt': a.get('startsAt')}, ensure_ascii=False), flush=True)
         self.send_response(200); self.end_headers()
```

**`docker/mysql-init/00-users.sql`**（第 02 章 2.4.4）

```diff
 CREATE USER IF NOT EXISTS 'exporter'@'%' IDENTIFIED BY 'exporter' WITH MAX_USER_CONNECTIONS 3;
 GRANT PROCESS, REPLICATION CLIENT, SELECT ON *.* TO 'exporter'@'%';
 FLUSH PRIVILEGES;
+-- 13 站第 09 章寫完之後的追記（第 02 章 2.4.4）：每個服務一個帳號、一個角色（權限由 migration 的 callback 給：db/grants/<服務>/）
+CREATE ROLE IF NOT EXISTS order_app, inventory_app;
+CREATE USER IF NOT EXISTS 'order_svc'@'%' IDENTIFIED BY 'order_svc';
+CREATE USER IF NOT EXISTS 'inventory_svc'@'%' IDENTIFIED BY 'inventory_svc';
+GRANT order_app TO 'order_svc'@'%';
+SET DEFAULT ROLE order_app TO 'order_svc'@'%';
+GRANT inventory_app TO 'inventory_svc'@'%';
+SET DEFAULT ROLE inventory_app TO 'inventory_svc'@'%';
+FLUSH PRIVILEGES;
```

**`scripts/d09-kind.sh`**（第 02 章 2.4.4）

```diff
 # 13 站第 09 章：遷移。cluster、入口的控制器、觀測沿用第 08 章（scripts/d08-kind.sh cluster | gateway-api | observability | down），
 # 這一支只管這一章的部署：單體、兩個服務、兩個庫。
 #   image       docker build 映像檔 shop:d09，kind load 進 cluster
-#   databases   這一章自己的兩個庫（shop_d09_mono、shop_d09_inv）、Redis 3／2、vhost shop_d09 —— 每一次都清空重建
+#   databases   這一章自己的兩個庫（shop_d09_mono、shop_d09_inv）、Redis 3／2、vhost shop_d09 —— 每一次都清空重建；兩個服務的帳號（2.4.4 的追記）
 #   deploy      設定 → migration（單體的庫，每一個資料夾）→ 單體與兩個服務（9.4：兩個服務也接單體的庫）
 #   gateway     入口（k8s/gateway）：/api/** 照權重分給單體與訂單服務
 # 用法：scripts/d09-kind.sh image | databases | deploy | gateway
…
       docker compose exec -T mysql mysql -uroot -proot -e \
         "DROP DATABASE IF EXISTS $db; CREATE DATABASE $db; GRANT ALL PRIVILEGES ON \`$db\`.* TO 'shop_migrator'@'%' WITH GRANT OPTION;" 2>&1 | grep -v "Using a password" || true
     done
+    # 13 站第 09 章寫完之後的追記（第 02 章 2.4.4）：兩個服務各自的帳號與角色（角色的權限由 migration Job 的 callback 給：db/grants/<服務>/）。
+    # 帳號是部署平台的事（跟 docker/mysql-init 建 shop 一樣），不在 migration 裡：密碼不進 repo 的 migration
+    docker compose exec -T mysql mysql -uroot -proot -e "
+      CREATE ROLE IF NOT EXISTS order_app, inventory_app;
+      CREATE USER IF NOT EXISTS 'order_svc'@'%' IDENTIFIED BY 'order_svc';
+      CREATE USER IF NOT EXISTS 'inventory_svc'@'%' IDENTIFIED BY 'inventory_svc';
+      GRANT order_app TO 'order_svc'@'%'; SET DEFAULT ROLE order_app TO 'order_svc'@'%';
+      GRANT inventory_app TO 'inventory_svc'@'%'; SET DEFAULT ROLE inventory_app TO 'inventory_svc'@'%';" 2>&1 | grep -v "Using a password" || true
     docker compose exec -T redis sh -c 'redis-cli -n 3 flushdb && redis-cli -n 2 flushdb' > /dev/null
     curl -sf -u shop:shop -X DELETE http://localhost:15672/api/vhosts/shop_d09 || true
     curl -sf -u shop:shop -X PUT http://localhost:15672/api/vhosts/shop_d09
```

**`k8s/base/inventory-service.yaml`**（第 02 章 2.4.4）

```diff
             - configMapRef: {name: shop-common}
             - configMapRef: {name: inventory-service}
             - secretRef: {name: shop-secrets}
+            # 13 站第 09 章寫完之後的追記（第 02 章 2.4.4）：這個服務自己的資料庫帳號（SHOP_DB_USER、SHOP_DB_PASSWORD）。
+            # 寫在 shop-secrets 後面：envFrom 有同一個 key 時，後面的蓋掉前面的
+            - secretRef: {name: inventory-service-db}
           ports:
             - {name: http, containerPort: 8080}
             - {name: management, containerPort: 8081}
```

**`k8s/kind/kustomization.yaml`**（第 02 章 2.4.4）

```diff
     envs: [secrets.env]
     options:
       labels: {stage: config}
+  # 13 站第 09 章寫完之後的追記（第 02 章 2.4.4）：每個服務一個帳號、一個角色（db/grants/<服務>/ 的 callback 授權）。
+  # 單體還是 shop（shop_app：每一張表）
+  - name: order-service-db
+    namespace: shop
+    literals: [SHOP_DB_USER=order_svc, SHOP_DB_PASSWORD=order_svc]
+    options:
+      labels: {stage: config}
+  - name: inventory-service-db
+    namespace: shop
+    literals: [SHOP_DB_USER=inventory_svc, SHOP_DB_PASSWORD=inventory_svc]
+    options:
+      labels: {stage: config}
 patches:
   - target: {kind: Service, name: mysql}
     patch: |-
```

**`k8s/migrate/jobs.yaml`**（第 02 章 2.4.4）

```diff
       initContainers:
         - name: copy
           image: shop:latest
-          command: ["cp", "-r", "/app/BOOT-INF/classes/db/migration/.", "/migrations/"]
-          volumeMounts: [{name: migrations, mountPath: /migrations}]
+          command: ["cp", "-r", "/app/BOOT-INF/classes/db/.", "/db/"]
+          volumeMounts: [{name: db, mountPath: /db}]
       containers:
         - name: flyway
           image: flyway/flyway:9.22.3
…
           envFrom:
             - secretRef: {name: shop-migrator}
           args: ["-url=jdbc:mysql://mysql:3306/$(DB_NAME)?allowPublicKeyRetrieval=true&useSSL=false", "-user=$(FLYWAY_USER)", "-password=$(FLYWAY_PASSWORD)",
-                 "-locations=filesystem:/migrations/inventory,filesystem:/migrations/shared", "-connectRetries=10", "migrate"]
-          volumeMounts: [{name: migrations, mountPath: /migrations}]
-      volumes: [{name: migrations, emptyDir: {}}]
+                 "-locations=filesystem:/db/migration/inventory,filesystem:/db/migration/shared,filesystem:/db/grants/inventory-service", "-connectRetries=10", "migrate"]
+          volumeMounts: [{name: db, mountPath: /db}]
+      volumes: [{name: db, emptyDir: {}}]
 ---
 apiVersion: batch/v1
 kind: Job
…
       initContainers:
         - name: copy
           image: shop:latest
-          command: ["cp", "-r", "/app/BOOT-INF/classes/db/migration/.", "/migrations/"]
-          volumeMounts: [{name: migrations, mountPath: /migrations}]
+          command: ["cp", "-r", "/app/BOOT-INF/classes/db/.", "/db/"]
+          volumeMounts: [{name: db, mountPath: /db}]
       containers:
         - name: flyway
           image: flyway/flyway:9.22.3
…
             - secretRef: {name: shop-migrator}
           # 庫存以外的每一個資料夾（application-order-service.yml 的 spring.flyway.locations）
           args: ["-url=jdbc:mysql://mysql:3306/$(DB_NAME)?allowPublicKeyRetrieval=true&useSSL=false", "-user=$(FLYWAY_USER)", "-password=$(FLYWAY_PASSWORD)",
-                 "-locations=filesystem:/migrations/account,filesystem:/migrations/cart,filesystem:/migrations/catalog,filesystem:/migrations/notification,filesystem:/migrations/ordering,filesystem:/migrations/payment,filesystem:/migrations/shared",
+                 "-locations=filesystem:/db/migration/account,filesystem:/db/migration/cart,filesystem:/db/migration/catalog,filesystem:/db/migration/notification,filesystem:/db/migration/ordering,filesystem:/db/migration/payment,filesystem:/db/migration/shared,filesystem:/db/grants/order-service",
                  "-connectRetries=10", "migrate"]
-          volumeMounts: [{name: migrations, mountPath: /migrations}]
-      volumes: [{name: migrations, emptyDir: {}}]
+          volumeMounts: [{name: db, mountPath: /db}]
+      volumes: [{name: db, emptyDir: {}}]
 ---
 # 13 站第 09 章：單體跑每一個資料夾（第 12 站的 migrate：一個庫、全部的表）
 apiVersion: batch/v1
…
       initContainers:
         - name: copy
           image: shop:latest
-          command: ["cp", "-r", "/app/BOOT-INF/classes/db/migration/.", "/migrations/"]
-          volumeMounts: [{name: migrations, mountPath: /migrations}]
+          command: ["cp", "-r", "/app/BOOT-INF/classes/db/.", "/db/"]
+          volumeMounts: [{name: db, mountPath: /db}]
       containers:
         - name: flyway
           image: flyway/flyway:9.22.3
…
           envFrom:
             - secretRef: {name: shop-migrator}
           args: ["-url=jdbc:mysql://mysql:3306/$(DB_NAME)?allowPublicKeyRetrieval=true&useSSL=false", "-user=$(FLYWAY_USER)", "-password=$(FLYWAY_PASSWORD)",
-                 "-locations=filesystem:/migrations/account,filesystem:/migrations/cart,filesystem:/migrations/catalog,filesystem:/migrations/inventory,filesystem:/migrations/notification,filesystem:/migrations/ordering,filesystem:/migrations/payment,filesystem:/migrations/shared",
+                 "-locations=filesystem:/db/migration/account,filesystem:/db/migration/cart,filesystem:/db/migration/catalog,filesystem:/db/migration/inventory,filesystem:/db/migration/notification,filesystem:/db/migration/ordering,filesystem:/db/migration/payment,filesystem:/db/migration/shared,filesystem:/db/grants/inventory-service,filesystem:/db/grants/order-service",
                  "-connectRetries=10", "migrate"]
-          volumeMounts: [{name: migrations, mountPath: /migrations}]
-      volumes: [{name: migrations, emptyDir: {}}]
+          volumeMounts: [{name: db, mountPath: /db}]
+      volumes: [{name: db, emptyDir: {}}]
```

**`k8s/kind/cluster-3nodes.yaml`**（第 08 章 8.6.6）

```yaml
# 13 站第 09 章寫完之後的追記（第 08 章 8.6.6）：三個 node 的 kind（一個控制面、兩個 worker）—— K13 量「別台的 kube-proxy 多晚知道」。
#   scripts/d08-kind.sh down && kind create cluster --config k8s/kind/cluster-3nodes.yaml
# 名字一樣是 d08（腳本與實驗都認 kind-d08 這個 context）；extraPortMappings 只開在控制面上：NodePort 在每一個 node 上都聽。
# ⚠️ 但入口的 Service 是 externalTrafficPolicy: Local（Envoy Gateway 的預設）：從控制面進來的只送給控制面上的 Envoy，而 Envoy 在 worker 上 ——
#   連不上。K13 跑的時候先改成 Cluster（K13MultiNodeTest.entryPolicy）
# 控制面有 NoSchedule 的 taint：應用程式的 pod 都在兩個 worker 上
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
name: d08
nodes:
  - role: control-plane
    image: kindest/node:v1.36.4@sha256:099e049362a1526b2db71494e1947aae99bd16290d7c895f2b7ea312e3cbfaed
    extraPortMappings:
      - {containerPort: 30080, hostPort: 18880}
      - {containerPort: 30090, hostPort: 18890}
      - {containerPort: 30686, hostPort: 18886}
  - role: worker
    image: kindest/node:v1.36.4@sha256:099e049362a1526b2db71494e1947aae99bd16290d7c895f2b7ea312e3cbfaed
  - role: worker
    image: kindest/node:v1.36.4@sha256:099e049362a1526b2db71494e1947aae99bd16290d7c895f2b7ea312e3cbfaed
```

**`k8s/gitops/apps/kustomization.yaml`**（第 08 章 8.4.6）

```yaml
# 13 站第 09 章寫完之後的追記（第 08 章 8.4.6）：GitOps。第 08 章 8.4.5 的部署順序（設定 → migration → 應用程式）是腳本裡的三行，
# GitOps 的控制器（Flux）一次套一個 kustomization、不認 kubectl 的 -l —— 順序要寫成「三個 kustomization ＋ dependsOn」（k8s/gitops/flux.yaml）。
# 這裡不重寫 k8s/kind，照它產生、再把不屬於這一份的拿掉（$patch: delete）
# apps：三個 Deployment、它們的 Secret（名字帶 hash，要跟 Deployment 在同一份）、Service、NetworkPolicy、讓 Prometheus 找 pod 的權限
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources: [../../kind]
patches:
  - patch: |-
      $patch: delete
      apiVersion: v1
      kind: Namespace
      metadata: {name: shop}
  - patch: |-
      $patch: delete
      apiVersion: v1
      kind: ConfigMap
      metadata: {name: shop-common, namespace: shop}
  - patch: |-
      $patch: delete
      apiVersion: v1
      kind: ConfigMap
      metadata: {name: monolith, namespace: shop}
  - patch: |-
      $patch: delete
      apiVersion: v1
      kind: ConfigMap
      metadata: {name: order-service, namespace: shop}
  - patch: |-
      $patch: delete
      apiVersion: v1
      kind: ConfigMap
      metadata: {name: inventory-service, namespace: shop}
  - patch: |-
      $patch: delete
      apiVersion: v1
      kind: Service
      metadata: {name: mysql, namespace: shop}
  - patch: |-
      $patch: delete
      apiVersion: v1
      kind: Service
      metadata: {name: redis, namespace: shop}
  - patch: |-
      $patch: delete
      apiVersion: v1
      kind: Service
      metadata: {name: rabbitmq, namespace: shop}
```

**`k8s/gitops/migrate/kustomization.yaml`**（第 08 章 8.4.6）

```yaml
# 13 站第 09 章寫完之後的追記（第 08 章 8.4.6）：GitOps。第 08 章 8.4.5 的部署順序（設定 → migration → 應用程式）是腳本裡的三行，
# GitOps 的控制器（Flux）一次套一個 kustomization、不認 kubectl 的 -l —— 順序要寫成「三個 kustomization ＋ dependsOn」（k8s/gitops/flux.yaml）。
# 這裡不重寫 k8s/kind，照它產生、再把不屬於這一份的拿掉（$patch: delete）
# migrate：只有單體的 Job（第 09 章 9.4.2：共用一個庫的時候 migration 只能有一個主人 —— 腳本用 -l 'migrate notin (order,inventory)'）
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources: [../../kind/migrate]
patches:
  - patch: |-
      $patch: delete
      apiVersion: batch/v1
      kind: Job
      metadata: {name: migrate-order, namespace: shop}
  - patch: |-
      $patch: delete
      apiVersion: batch/v1
      kind: Job
      metadata: {name: migrate-inventory, namespace: shop}
```

**`k8s/gitops/gateway/kustomization.yaml`**（第 08 章 8.4.6）

```yaml
# 13 站第 09 章寫完之後的追記（第 08 章 8.4.6）：GitOps。第 08 章 8.4.5 的部署順序（設定 → migration → 應用程式）是腳本裡的三行，
# GitOps 的控制器（Flux）一次套一個 kustomization、不認 kubectl 的 -l —— 順序要寫成「三個 kustomization ＋ dependsOn」（k8s/gitops/flux.yaml）。
# 這裡不重寫 k8s/kind，照它產生、再把不屬於這一份的拿掉（$patch: delete）
# gateway：入口與 /api/** 的權重（第 09 章 9.5）—— 放進 GitOps 之後，灰度改權重就是一個 commit
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources: [../../gateway]
```

**`k8s/lab/git-server/Dockerfile`**（第 08 章 8.4.6）

```
# 13 站第 09 章寫完之後的追記（第 08 章 8.4.6）：cluster 裡的一個 git server，給 GitOps 的控制器（Flux）拉。
# Flux 只認 HTTP(S) 與 SSH，不認 git://；最小的做法是 lighttpd 用 CGI 跑 git 自帶的 git-http-backend（smart HTTP）。
# 只在 kind 上用：沒有認證、任何人都能 push（repo 設了 http.receivepack）
FROM alpine:3.20
RUN apk add --no-cache git git-daemon lighttpd
COPY lighttpd.conf /etc/lighttpd/lighttpd.conf
RUN mkdir -p /srv/git && git init -q --bare -b main /srv/git/shop.git && git -C /srv/git/shop.git config http.receivepack true \
 && chown -R lighttpd:lighttpd /srv/git
EXPOSE 8080
CMD ["lighttpd", "-D", "-f", "/etc/lighttpd/lighttpd.conf"]
```

**`k8s/lab/git-server/lighttpd.conf`**（第 08 章 8.4.6）

```
# /git/<repo> → git-http-backend（CGI）：clone、fetch、push 都走它
server.modules = ("mod_alias", "mod_cgi", "mod_setenv")
server.port = 8080
server.document-root = "/srv/git"
server.username = "lighttpd"
server.groupname = "lighttpd"
alias.url = ("/git" => "/usr/libexec/git-core/git-http-backend")
$HTTP["url"] =~ "^/git" {
  cgi.assign = ("" => "")
  setenv.add-environment = ("GIT_PROJECT_ROOT" => "/srv/git", "GIT_HTTP_EXPORT_ALL" => "")
}
```

**`k8s/lab/git-server/git-server.yaml`**（第 08 章 8.4.6）

```yaml
# K15 用：flux-system 這個 namespace 裡的 git server（映像檔 git-server:k15，docker build k8s/lab/git-server、kind load）
apiVersion: apps/v1
kind: Deployment
metadata:
  name: git-server
  namespace: flux-system
spec:
  replicas: 1
  selector: {matchLabels: {app: git-server}}
  template:
    metadata: {labels: {app: git-server}}
    spec:
      containers:
        - name: git
          image: git-server:k15
          imagePullPolicy: IfNotPresent
          ports: [{containerPort: 8080}]
---
apiVersion: v1
kind: Service
metadata:
  name: git-server
  namespace: flux-system
spec:
  selector: {app: git-server}
  ports: [{port: 8080, targetPort: 8080}]
```

**`k8s/lab/otel-collector-tail.yaml`**（第 07 章 7.8.4）

```yaml
# 13 站第 09 章寫完之後的追記（第 07 章 7.8.4、第 08 章 8.9.2）：尾端抽樣。K12TailSamplingTest 換上這一份、量完換回 k8s/observability 的那一份。
# 前提：入口與服務都送 100%（入口的 samplingRate 100、MANAGEMENT_TRACING_SAMPLING_PROBABILITY 1.0）—— 頭端已經丟掉的，這裡撿不回來。
# tail_sampling 把同一個 traceId 的 span 收齊、等 decision_wait，再照 policies 決定留不留：任何一條說留就留（OR）
#   errors／server-errors：span 的狀態是 ERROR，或 Micrometer 標的 outcome=SERVER_ERROR（第 08 章：Jaeger v2 上錯誤的 span 帶的是這個屬性）
#   slow：整條 trace 從第一個 span 開始到最後一個結束超過 500 ms（不是請求的長度：事件的消費者也在同一條 trace 上，7.7）
#   rest：其他的抽 10%（跟頭端抽樣同一個比例）
# 只能一台：同一條 trace 的 span 要落在同一台才收得齊（多台要在前面再放一層照 traceId 分的 loadbalancing exporter）
apiVersion: v1
kind: ConfigMap
metadata:
  name: otel-collector-config
  namespace: observability
data:
  config.yaml: |
    receivers:
      otlp:
        protocols:
          http: {endpoint: 0.0.0.0:4318}
          grpc: {endpoint: 0.0.0.0:4317}
    processors:
      memory_limiter: {check_interval: 1s, limit_percentage: 80, spike_limit_percentage: 20}
      tail_sampling:
        decision_wait: 10s
        num_traces: 50000
        policies:
          - {name: errors, type: status_code, status_code: {status_codes: [ERROR]}}
          - {name: server-errors, type: string_attribute, string_attribute: {key: outcome, values: [SERVER_ERROR]}}
          - {name: slow, type: latency, latency: {threshold_ms: 500}}
          - {name: rest, type: probabilistic, probabilistic: {sampling_percentage: 10}}
      batch: {}
    exporters:
      otlp/jaeger:
        endpoint: jaeger:4317
        tls: {insecure: true}
    service:
      pipelines:
        traces:
          receivers: [otlp]
          processors: [memory_limiter, tail_sampling, batch]
          exporters: [otlp/jaeger]
      telemetry:
        metrics:
          readers: [{pull: {exporter: {prometheus: {host: 0.0.0.0, port: 8888}}}}]
```

**`pom.xml`**（9.6.8：mysql-binlog-connector-java）

```diff
     <dependency><groupId>org.testcontainers</groupId><artifactId>mysql</artifactId><scope>test</scope></dependency>
     <dependency><groupId>org.testcontainers</groupId><artifactId>rabbitmq</artifactId><scope>test</scope></dependency>
     <dependency><groupId>org.junit.platform</groupId><artifactId>junit-platform-launcher</artifactId><scope>test</scope></dependency>
+    <!-- 13 站第 09 章寫完之後的追記（第 02 章 2.8.6、9.6.8）：binlog 的變更擷取（dist09.BinlogCopier）—— 像一台 replica 一樣接上 MySQL 讀 binlog。
+         Debezium 的 MySQL connector 底下用的是它的一個 fork（io.debezium 的 mysql-binlog-connector-java）；這裡只拿來知道「哪一個主鍵變了」 -->
+    <dependency><groupId>com.zendesk</groupId><artifactId>mysql-binlog-connector-java</artifactId><version>0.31.0</version><scope>test</scope></dependency>
     <!-- 13 站 3.8：Pact。呼叫端的測試（surefire）產生契約 target/pacts；提供端在 failsafe 那一段驗證它 -->
     <dependency><groupId>au.com.dius.pact.consumer</groupId><artifactId>junit5</artifactId><version>${pact.version}</version><scope>test</scope></dependency>
     <dependency><groupId>au.com.dius.pact.provider</groupId><artifactId>junit5</artifactId><version>${pact.version}</version><scope>test</scope></dependency>
```

**`src/test/java/com/example/shop/architecture/ServiceGrantsTest.java`**（第 02 章 2.4.4）

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
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;
import java.util.function.Predicate;
import java.util.stream.Stream;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 13 站第 09 章寫完之後的追記（第 02 章 2.4.4）：每個服務一個資料庫角色。shop_app 的授權寫在每一個模組的 migration 裡（跑過的不能改內容），
 * 兩個服務的角色由 Flyway 的 afterMigrate callback 另外授權（db/grants/inventory-service、db/grants/order-service）。這個測試守住：
 *
 *   ① 各自的庫（第 02 章 2.4.5 的兩種）：服務的角色對每一張表、每一個程序的權限，跟 shop_app 的一模一樣 —— 新的表、新的權限忘了抄，就紅
 *   ② 共用一個庫（第 09 章 9.4：單體的 Job 跑每一個資料夾，兩個 callback 都跑）：庫存的角色只有庫存的表與 shared，訂單的角色一張庫存的表都沒有
 *
 * 表與模組的對照用第 12 站 TableOwnershipTest 的那一張。是 @SpringBootTest：Testcontainers 的 MySQL 在第一個 Spring 應用程式啟動時才起（TestInfra）
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.NONE)
class ServiceGrantsTest {

    static final String INVENTORY = "inventory_app", ORDER = "order_app", SHOP = "shop_app";

    @Test @DisplayName("13 站 2.4.4 的追記：每個服務的角色，權限跟 shop_app 一樣、只限自己的表；共用一個庫的時候也分得開")
    void eachServiceRoleOwnsExactlyItsTables() throws Exception {
        Predicate<String> inventoryTable = t -> Set.of("inventory", "shared").contains(TableOwnershipTest.OWNER.get(t));
        Predicate<String> orderTable = t -> !"inventory".equals(TableOwnershipTest.OWNER.get(t));
        List<String> others;
        try (Stream<Path> s = Files.list(Path.of("src/main/resources/db/migration"))) {
            others = s.filter(Files::isDirectory).map(p -> p.getFileName().toString()).filter(m -> !m.equals("inventory")).sorted()
                    .map(m -> "classpath:db/migration/" + m).toList();
        }
        List<String> every = new ArrayList<>(others);
        every.add("classpath:db/migration/inventory");

        Map<String, Map<String, Set<String>>> inv = migrate("shop_grants_inventory",
                "classpath:db/migration/inventory", "classpath:db/migration/shared", "classpath:db/grants/inventory-service");
        List<String> rest = new ArrayList<>(others);
        rest.add("classpath:db/grants/order-service");
        Map<String, Map<String, Set<String>>> ord = migrate("shop_grants_order", rest.toArray(String[]::new));
        List<String> all = new ArrayList<>(every);
        all.addAll(List.of("classpath:db/grants/inventory-service", "classpath:db/grants/order-service"));
        Map<String, Map<String, Set<String>>> mono = migrate("shop_grants_mono", all.toArray(String[]::new));

        System.out.printf("13 站 2.4.4 的追記：庫存服務的庫，%s 有權限的表與程序 %d 個；訂單服務的庫，%s %d 個；共用的庫，%s %d 個、%s %d 個（shop_app %d 個）%n",
                INVENTORY, inv.get(INVENTORY).size(), ORDER, ord.get(ORDER).size(), INVENTORY, mono.get(INVENTORY).size(), ORDER, mono.get(ORDER).size(), mono.get(SHOP).size());
        assertThat(inv.get(INVENTORY)).as("庫存服務的庫：跟 shop_app 一樣").isEqualTo(inv.get(SHOP));
        assertThat(inv.get(ORDER)).as("庫存服務的庫：訂單的角色什麼都沒有").isEmpty();
        assertThat(ord.get(ORDER)).as("訂單服務的庫：跟 shop_app 一樣").isEqualTo(ord.get(SHOP));
        assertThat(ord.get(INVENTORY)).as("訂單服務的庫：庫存的角色什麼都沒有").isEmpty();
        assertThat(mono.get(INVENTORY)).as("共用的庫：庫存的角色 = shop_app 在庫存的表與 shared 上的那幾個").isEqualTo(only(mono.get(SHOP), inventoryTable));
        assertThat(mono.get(ORDER)).as("共用的庫：訂單的角色 = shop_app 在庫存以外的表上的那幾個").isEqualTo(only(mono.get(SHOP), orderTable));
        assertThat(mono.get(ORDER).keySet()).as("共用的庫：訂單的角色一張庫存的表都沒有").noneMatch(t -> "inventory".equals(TableOwnershipTest.OWNER.get(t)));
    }

    /** 表（或「程序 名字」）→ 權限，只留 keep 認得的表；程序兩個角色都要（shared 的 purge_audit_logs） */
    static Map<String, Set<String>> only(Map<String, Set<String>> grants, Predicate<String> keep) {
        Map<String, Set<String>> m = new TreeMap<>();
        grants.forEach((k, v) -> { if (k.startsWith("程序 ") || keep.test(k)) m.put(k, v); });
        return m;
    }

    /** 從空的資料庫，用這幾個位置跑 Flyway（跟正式環境一樣用 shop_migrator）；回傳三個角色在這個庫裡的權限：角色 → 表 → 權限 */
    Map<String, Map<String, Set<String>>> migrate(String db, String... locations) {
        JdbcTemplate admin = TestInfra.adminJdbc();
        admin.execute("DROP DATABASE IF EXISTS " + db);
        admin.execute("CREATE DATABASE " + db);
        admin.execute("GRANT ALL PRIVILEGES ON `" + db + "`.* TO 'shop_migrator'@'%' WITH GRANT OPTION");
        Flyway.configure().dataSource(TestInfra.jdbcUrl(db), "shop_migrator", "shop_migrator").locations(locations).load().migrate();
        Map<String, Map<String, Set<String>>> out = new TreeMap<>();
        for (String role : List.of(SHOP, INVENTORY, ORDER)) out.put(role, new TreeMap<>());
        admin.query("SELECT grantee, table_name, privilege_type FROM information_schema.table_privileges WHERE table_schema = ?", rs -> {
            String role = rs.getString(1).replaceAll("'([^']+)'@.*", "$1");
            if (out.containsKey(role)) out.get(role).computeIfAbsent(rs.getString(2), k -> new TreeSet<>()).add(rs.getString(3));
        }, db);
        admin.query("SELECT user, routine_name, proc_priv FROM mysql.procs_priv WHERE db = ?", rs -> {
            if (out.containsKey(rs.getString(1))) out.get(rs.getString(1)).put("程序 " + rs.getString(2), new TreeSet<>(Set.of(rs.getString(3).split(","))));
        }, db);
        admin.execute("DROP DATABASE " + db);
        return out;
    }
}
```

**`src/test/java/com/example/shop/shared/deployment/WriteGateTest.java`**（9.6.7）

```java
package com.example.shop.shared.deployment;

import com.example.shop.ShopApplication;
import com.example.shop.shared.web.Role;
import com.example.shop.support.TestTokens;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.amqp.core.AmqpAdmin;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.context.ConfigurableApplicationContext;

import java.net.ServerSocket;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

/**
 * 13 站 9.6.7 的追記：寫入的開關（WriteGate）。
 *   ① 起來就待命（shop.deployment.standby=true）：寫入 503、讀照常；每一個回應都帶 Connection: close；消費者一個都沒接上
 *   ② /actuator/writes 只在管理埠、只收管理員；打開之後寫入照常、消費者接上、回應不再帶 Connection: close
 *   ③ 凍結：等手上的寫入做完才回（一個卡在半路的寫入）；凍結之後消費者停下
 * 用正式的 ShopApplication 起一個有管理埠、開著消費者的行程（AlertMetricsTest 的做法）：預設的測試設定關掉了消費者，也沒有管理埠
 */
class WriteGateTest {

    static final String QUEUE = "shop.inventory.order-events";
    final HttpClient http = HttpClient.newHttpClient();

    @Test @DisplayName("13 站 9.6.7 的追記：待命起來不寫；管理員打開才寫；凍結等手上的寫入做完、消費者停下")
    void standbyOpenFreeze() throws Exception {
        int mgmt;
        try (ServerSocket s = new ServerSocket(0)) { mgmt = s.getLocalPort(); }
        try (ConfigurableApplicationContext ctx = new SpringApplicationBuilder(ShopApplication.class).run("--server.port=0", "--management.server.port=" + mgmt,
                "--shop.deployment.standby=true", "--shop.order.jobs-enabled=false", "--shop.inventory.jobs-enabled=false",
                "--shop.messaging.consumers-enabled=true", "--spring.main.banner-mode=off", "--logging.level.root=WARN")) {
            int port = Integer.parseInt(ctx.getEnvironment().getProperty("local.server.port"));
            WriteGate gate = ctx.getBean(WriteGate.class);
            AmqpAdmin rabbit = ctx.getBean(AmqpAdmin.class);
            String buyer = TestTokens.bearer(ctx, 9_960_001), admin = TestTokens.bearer(ctx, 990_901, Role.ADMIN);

            // ① 待命
            assertThat(gate.state()).isEqualTo(WriteGate.State.STANDBY);
            HttpResponse<String> write = send(port, "POST", "/api/cart/items", buyer, "{\"productId\": 1, \"quantity\": 1}");
            HttpResponse<String> read = send(port, "GET", "/api/ping", null, null);
            System.out.printf("9.6.7 ① 待命：寫入 %d %s（Retry-After %s、Connection %s）；讀 %d（Connection %s）；%s 的消費者 %d 個%n",
                    write.statusCode(), write.body(), header(write, "Retry-After"), header(write, "Connection"), read.statusCode(), header(read, "Connection"),
                    QUEUE, consumers(rabbit));
            assertThat(write.statusCode()).isEqualTo(503);
            assertThat(write.body()).contains("/problems/temporarily-unavailable");
            assertThat(header(write, "Connection")).isEqualTo("close");
            assertThat(read.statusCode()).isEqualTo(200);
            assertThat(header(read, "Connection")).isEqualTo("close");
            assertThat(consumers(rabbit)).isZero();

            // ② 開關：只在管理埠、只收管理員
            int noToken = send(mgmt, "POST", "/actuator/writes", null, "{\"state\":\"OPEN\"}").statusCode();
            int asBuyer = send(mgmt, "POST", "/actuator/writes", buyer, "{\"state\":\"OPEN\"}").statusCode();
            int appPort = send(port, "POST", "/actuator/writes", admin, "{\"state\":\"OPEN\"}").statusCode();
            HttpResponse<String> opened = send(mgmt, "POST", "/actuator/writes", admin, "{\"state\":\"OPEN\"}");
            await().atMost(Duration.ofSeconds(20)).until(() -> consumers(rabbit) > 0);
            HttpResponse<String> writeAfter = send(port, "POST", "/api/cart/items", buyer, "{\"productId\": 1, \"quantity\": 1}");
            HttpResponse<String> readAfter = send(port, "GET", "/api/ping", null, null);
            System.out.printf("9.6.7 ② 開關：沒有 token %d、買家 %d、應用程式的埠 %d、管理員 %d %s；之後寫入 %d、讀 %d（Connection %s）；消費者 %d 個%n",
                    noToken, asBuyer, appPort, opened.statusCode(), opened.body(), writeAfter.statusCode(), readAfter.statusCode(), header(readAfter, "Connection"), consumers(rabbit));
            assertThat(noToken).isEqualTo(401);
            assertThat(asBuyer).isEqualTo(403);
            assertThat(appPort).isIn(401, 403);
            assertThat(opened.statusCode()).isEqualTo(200);
            assertThat(gate.state()).isEqualTo(WriteGate.State.OPEN);
            assertThat(writeAfter.statusCode()).isNotEqualTo(503);
            assertThat(header(readAfter, "Connection")).isNull();

            // ③ 凍結：消費者停下、寫入 503
            HttpResponse<String> frozen = send(mgmt, "POST", "/actuator/writes", admin, "{\"state\":\"FROZEN\"}");
            System.out.printf("9.6.7 ③ 凍結：%d %s；消費者 %d 個%n", frozen.statusCode(), frozen.body(), consumers(rabbit));
            assertThat(frozen.body()).contains("\"state\":\"FROZEN\"").contains("\"inFlight\":0");
            assertThat(consumers(rabbit)).isZero();
            assertThat(send(port, "POST", "/api/cart/items", buyer, "{\"productId\": 1, \"quantity\": 1}").statusCode()).isEqualTo(503);
        }
    }

    @Test @DisplayName("13 站 9.6.7 的追記：凍結要等手上的寫入做完才回；做完之前進來的寫入一律不放")
    void freezeWaitsForWritesInFlight() throws Exception {
        WriteGate gate = new WriteGate(false);
        assertThat(gate.enter()).isTrue();                                    // 一個寫入在半路
        ExecutorService pool = Executors.newSingleThreadExecutor();
        Future<WriteGate.Frozen> freezing = pool.submit(() -> gate.freeze(Duration.ofSeconds(10)));
        await().atMost(Duration.ofSeconds(5)).until(() -> gate.state() == WriteGate.State.FROZEN);
        boolean newWrite = gate.enter();                                      // 凍結之後才來的
        Thread.sleep(300);
        boolean waiting = !freezing.isDone();
        gate.exit();
        WriteGate.Frozen f = freezing.get();
        pool.shutdown();
        System.out.printf("9.6.7 凍結等手上的寫入：300 ms 後還在等 = %s；凍結之後才來的寫入放不放 = %s；%s%n", waiting, newWrite, f);
        assertThat(waiting).isTrue();
        assertThat(newWrite).isFalse();
        assertThat(f.inFlight()).isZero();
        assertThat(f.waitedMs()).isGreaterThanOrEqualTo(300);
        CountDownLatch never = new CountDownLatch(1);
        assertThat(gate.enter()).isFalse();
        gate.run(never::countDown);                                           // 排程的一輪：不是 OPEN 就不跑
        assertThat(never.getCount()).isEqualTo(1);
    }

    HttpResponse<String> send(int port, String method, String path, String token, String body) throws Exception {
        HttpRequest.Builder b = HttpRequest.newBuilder(URI.create("http://localhost:" + port + path)).timeout(Duration.ofSeconds(30))
                .header("Content-Type", "application/json")
                .method(method, body == null ? HttpRequest.BodyPublishers.noBody() : HttpRequest.BodyPublishers.ofString(body));
        if (token != null) b.header("Authorization", token);
        return http.send(b.build(), HttpResponse.BodyHandlers.ofString());
    }

    static String header(HttpResponse<?> r, String name) { return r.headers().firstValue(name).orElse(null); }

    static int consumers(AmqpAdmin rabbit) {
        var info = rabbit.getQueueInfo(QUEUE);
        return info == null ? 0 : info.getConsumerCount();
    }
}
```

**`src/test/java/com/example/shop/inventory/internal/ReserveDdlDeadlockTest.java`**（9.6.5）

```java
package com.example.shop.inventory.internal;

import com.example.shop.inventory.ReserveLine;
import com.example.shop.support.CapturedLogs;
import com.example.shop.support.TestInfra;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;

import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 13 站第 09 章寫完之後的追記（第 09 章 9.6.5）：M12 抓到的那一張 500。預留的交易做到一半，搬家程式對 inventory_ledger 下 DDL
 * （CREATE TRIGGER，第 02 章 2.8.4 的變更紀錄）—— metadata lock 的死結，被犧牲的是預留（M13 量了為什麼：外鍵）。
 * 固定交錯：一個只對這張訂單生效的 trigger 讓預留在 INSERT inventory_reservations 之後睡 1 秒（UPDATE inventory 已經做了），
 * 這一秒裡另一條連線 CREATE TRIGGER ON inventory_ledger。
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.NONE)
class ReserveDdlDeadlockTest {

    static final long P = 900_961, ORDER = 99_096_100L;

    @Autowired JdbcTemplate jdbc;
    @Autowired JdbcInventoryService inventory;

    @Test @DisplayName("9.6.5 的追記：預留做到一半，有人對 inventory_ledger 下 DDL —— 死結的那一次重做，下單照樣成功、帳只記一次")
    void ddlDuringReserve() throws Exception {
        JdbcTemplate admin = TestInfra.adminJdbc();
        cleanup(admin);
        jdbc.update("INSERT INTO inventory (product_id, on_hand, reserved) VALUES (?, 10, 0)", P);
        jdbc.update("INSERT INTO inventory_ledger (product_id, delta_on_hand, delta_reserved, reason, ref) VALUES (?, 10, 0, 'INITIAL', 'ddl-deadlock')", P);
        admin.execute("""
                CREATE TRIGGER ddl_deadlock_pause AFTER INSERT ON inventory_reservations FOR EACH ROW
                BEGIN
                  IF NEW.order_id = %d THEN DO SLEEP(1); END IF;
                END""".formatted(ORDER));
        ExecutorService pool = Executors.newSingleThreadExecutor();
        try (CapturedLogs logs = CapturedLogs.attach()) {
            long innodb0 = innodbDeadlocks(admin);
            Future<Boolean> reserve = pool.submit(() -> inventory.reserveOnce(ORDER, List.of(new ReserveLine(P, 1)), List.of()));
            Thread.sleep(300);                                              // 預留停在 INSERT inventory_reservations 之後
            long t0 = System.nanoTime();
            admin.execute("""
                    CREATE TRIGGER ddl_deadlock_ddl AFTER INSERT ON inventory_ledger FOR EACH ROW
                    BEGIN
                      IF NEW.product_id = -1 THEN SET @ddl_deadlock = 1; END IF;
                    END""");
            long ddlMs = (System.nanoTime() - t0) / 1_000_000;
            String result;
            try {
                result = "成功（" + (reserve.get(30, TimeUnit.SECONDS) ? "重送" : "第一次") + "）";
            } catch (java.util.concurrent.ExecutionException e) {
                Throwable root = e.getCause();
                while (root.getCause() != null) root = root.getCause();
                result = "失敗：" + e.getCause().getClass().getSimpleName() + "（" + root.getMessage() + "）";
            }
            long retries = logs.events().stream().filter(l -> l.getFormattedMessage().startsWith("DEADLOCK_RETRY op=reserve")).count();
            int reservations = jdbc.queryForObject("SELECT COUNT(*) FROM inventory_reservations WHERE order_id = ?", Integer.class, ORDER);
            int ledger = jdbc.queryForObject("SELECT COUNT(*) FROM inventory_ledger WHERE ref = ?", Integer.class, "order:" + ORDER);
            long innodb1 = innodbDeadlocks(admin);
            System.out.printf("9.6.5 的追記：DDL（CREATE TRIGGER ON inventory_ledger）等了 %d ms；預留%s，死結之後重做 %d 次；這張訂單的預留 %d 筆、帳 %d 筆；InnoDB 的死結計數 %d → %d%n",
                    ddlMs, result, retries, reservations, ledger, innodb0, innodb1);
            assertThat(result).startsWith("成功");
            assertThat(retries).isEqualTo(1);
            assertThat(reservations).isEqualTo(1);
            assertThat(ledger).isEqualTo(1);
            assertThat(innodb1).as("metadata lock 的死結，InnoDB 不算它").isEqualTo(innodb0);
        } finally {
            pool.shutdownNow();
            admin.execute("DROP TRIGGER IF EXISTS ddl_deadlock_pause");
            admin.execute("DROP TRIGGER IF EXISTS ddl_deadlock_ddl");
            cleanup(admin);
        }
    }

    static long innodbDeadlocks(JdbcTemplate admin) {
        return admin.queryForObject("SELECT count FROM information_schema.INNODB_METRICS WHERE name = 'lock_deadlocks'", Long.class);
    }

    void cleanup(JdbcTemplate admin) {
        admin.update("DELETE FROM outbox_events WHERE aggregate_type = 'INVENTORY' AND aggregate_id = ?", ORDER);
        admin.update("DELETE FROM processed_messages WHERE consumer = ? AND message_id = ?", JdbcInventoryService.RESERVE_KEY, Long.toString(ORDER));
        admin.update("DELETE FROM inventory_reservations WHERE product_id = ?", P);
        admin.update("DELETE FROM inventory_ledger WHERE product_id = ?", P);
        admin.update("DELETE FROM inventory WHERE product_id = ?", P);
    }
}
```

**`src/test/java/com/example/shop/api/AdminReportApiTest.java`**（整套撞到的競態，下面）

```diff
         jdbc.update("DELETE f FROM refunds f JOIN orders o ON o.id = f.order_id WHERE o.buyer_id = ?", BUYER);
         jdbc.update("DELETE p FROM payments p JOIN orders o ON o.id = p.order_id WHERE o.buyer_id = ?", BUYER);
         jdbc.update("DELETE i FROM order_items i JOIN orders o ON o.id = i.order_id WHERE o.buyer_id = ?", BUYER);
+        // 13 站第 09 章寫完之後的追記：同一個 JVM 裡別的 context 的排程（OrderJobs 的 AUTO_COMPLETE：出貨超過 7 天）會把這裡的舊訂單轉成 COMPLETED、
+        // 寫一列狀態歷史 —— 不先刪它，下一句刪 orders 會撞外鍵（整套跑到這裡的那一刻剛好有一輪排程，才看得到；AdminReportApiTest.cleanupSurvivesAutoComplete）
+        jdbc.update("DELETE h FROM order_status_history h JOIN orders o ON o.id = h.order_id WHERE o.buyer_id = ?", BUYER);
         jdbc.update("DELETE FROM orders WHERE buyer_id = ?", BUYER);
         jdbc.update("DELETE FROM users WHERE id = ?", S1);
     }
…
         return s.toString();
     }
 
+    @Test @DisplayName("13 站第 09 章寫完之後的追記：別的 context 的排程在測試途中把舊訂單自動完成了 —— 清理照樣刪得掉")
+    void cleanupSurvivesAutoComplete() {
+        // 整套的時候，同一個 JVM 裡還有排程開著的 context：OrderJobs 的 AUTO_COMPLETE（出貨超過 7 天）會把這裡 2011 年出貨的訂單
+        // 轉成 COMPLETED、寫一列狀態歷史。這裡直接寫那一列（跟 OrderHistory 寫的一樣），再清理
+        long shipped = jdbc.queryForObject("SELECT id FROM orders WHERE order_no = '20110930-995101'", Long.class);
+        jdbc.update("""
+                INSERT INTO order_status_history (order_id, from_status, to_status, event, actor_type, actor_id)
+                VALUES (?, 'SHIPPED', 'COMPLETED', 'AUTO_COMPLETE', 'SYSTEM', NULL)""", shipped);
+        cleanup();
+        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM orders WHERE buyer_id = ?", Integer.class, BUYER)).isZero();
+    }
+
     @Test @DisplayName("RPT-3：全站每日一列、依台北切日，兩位賣家加在一起；沒有 groupBy 時 sellers 是 null")
     void siteWide() throws Exception {
         var r = call("/api/admin/reports/daily-sales", admin(), "from", "2011-09-30", "to", "2011-10-02");
```

**`src/test/java/com/example/shop/api/TopProductsApiTest.java`**（同一種清理）

```diff
     @AfterEach
     void cleanup() {
         jdbc.update("DELETE i FROM order_items i JOIN orders o ON o.id = i.order_id WHERE o.buyer_id = ?", BUYER);
+        // 13 站第 09 章寫完之後的追記：同一個 JVM 裡別的 context 的排程（OrderJobs 的 AUTO_COMPLETE：出貨超過 7 天）會把這裡的舊訂單轉成 COMPLETED、
+        // 寫一列狀態歷史 —— 不先刪它，下一句刪 orders 會撞外鍵（整套跑到這裡的那一刻剛好有一輪排程，才看得到；AdminReportApiTest.cleanupSurvivesAutoComplete）
+        jdbc.update("DELETE h FROM order_status_history h JOIN orders o ON o.id = h.order_id WHERE o.buyer_id = ?", BUYER);
         jdbc.update("DELETE FROM orders WHERE buyer_id = ?", BUYER);
         jdbc.update("DELETE FROM products WHERE id BETWEEN ? AND ?", P1, P91);
     }
```

**`src/test/java/com/example/shop/catalog/internal/ProductCacheTest.java`**（第 05 章 5.7.9）

```diff
             return cache.get(PRODUCT, id -> {
                 loads.incrementAndGet();
                 sleep(20);                                                    // 讓「同時」夠寬
-                return Optional.of(new ProductCache.Core(PRODUCT, SELLER, "x", null, new BigDecimal("100.00"), 11, ProductStatus.ON_SALE, false, 0));
+                return Optional.of(new ProductCache.Core(PRODUCT, SELLER, "x", null, new BigDecimal("100.00"), 11, ProductStatus.ON_SALE, 0));
             });
         }));
         go.countDown();
…
         AtomicInteger loads = new AtomicInteger();
         java.util.function.LongFunction<Optional<ProductCache.Core>> loader = id -> {
             loads.incrementAndGet();
-            return Optional.of(new ProductCache.Core(PRODUCT, SELLER, "x", null, new BigDecimal("100.00"), 11, ProductStatus.ON_SALE, false, 0));
+            return Optional.of(new ProductCache.Core(PRODUCT, SELLER, "x", null, new BigDecimal("100.00"), 11, ProductStatus.ON_SALE, 0));
         };
         ExecutorService pool = Executors.newFixedThreadPool(2);
         Future<?> slow = pool.submit(() -> { late[0] = Thread.currentThread(); return c.get(PRODUCT, loader); });
…
         assertThat(loads.get()).isEqualTo(1);
     }
 
+    /** 收縮之前的 Core（多一個 hot）：滾動更新的那一段，舊版還在讀寫同一份快取 */
+    record CoreBeforeContraction(long id, long sellerId, String name, String description, BigDecimal price, long categoryId,
+                                 ProductStatus status, boolean hot, int version) {}
+
+    /**
+     * 13 站第 09 章寫完之後的追記（第 05 章 5.7.9，收縮）：Core 少了 hot。滾動更新的幾十秒裡，新舊兩版讀寫同一份 Redis 的快取 ——
+     *   舊版寫的（多一個 "hot"）新版要讀得懂；新版寫的（少了 "hot"）舊版也要讀得懂。兩個方向都靠 Spring Boot 的 ObjectMapper 的預設：
+     *   多出來的欄位不失敗（FAIL_ON_UNKNOWN_PROPERTIES 是 false）、缺的 primitive 給預設值（false）
+     */
+    @Test @DisplayName("收縮：快取裡舊版寫的值新版讀得懂，新版寫的值舊版也讀得懂")
+    void cacheEntriesAcrossTheContraction() throws Exception {
+        String written = json.writeValueAsString(new CoreBeforeContraction(PRODUCT, SELLER, "x", null, new BigDecimal("100.00"), 11, ProductStatus.ON_SALE, true, 3));
+        redis.opsForValue().set(ProductCache.key(PRODUCT), written);
+        AtomicInteger loads = new AtomicInteger();
+        ProductCache.Core read = cache.get(PRODUCT, id -> { loads.incrementAndGet(); return Optional.empty(); }).orElseThrow();
+        assertThat(loads.get()).isZero();                                     // 讀的是快取，不是 MySQL
+        assertThat(read.version()).isEqualTo(3);
+
+        String byNew = json.writeValueAsString(new ProductCache.Core(PRODUCT, SELLER, "x", null, new BigDecimal("100.00"), 11, ProductStatus.ON_SALE, 4));
+        CoreBeforeContraction old = json.readValue(byNew, CoreBeforeContraction.class);
+        assertThat(old.hot()).isFalse();
+        assertThat(old.version()).isEqualTo(4);
+        System.out.printf("收縮：舊版寫的 %s → 新版讀到 version %d；新版寫的 %s → 舊版讀到 hot=%s%n", written, read.version(), byNew, old.hot());
+    }
+
     @Test @DisplayName("6.4.2：commit 之後寫入失敗（Redis 逾時）→ 記下來，背景重試把舊值刪掉，不會留到 TTL")
     void failedWriteAfterCommitIsRepaired() throws Exception {
         AtomicBoolean failScripts = new AtomicBoolean();
…
             }
         };
         ProductCache c = new ProductCache(flaky, guard, json);
-        ProductCache.Core v1 = new ProductCache.Core(PRODUCT, SELLER, "x", null, new BigDecimal("100.00"), 11, ProductStatus.ON_SALE, false, 1);
-        ProductCache.Core v2 = new ProductCache.Core(PRODUCT, SELLER, "x", null, new BigDecimal("200.00"), 11, ProductStatus.ON_SALE, false, 2);
+        ProductCache.Core v1 = new ProductCache.Core(PRODUCT, SELLER, "x", null, new BigDecimal("100.00"), 11, ProductStatus.ON_SALE, 1);
+        ProductCache.Core v2 = new ProductCache.Core(PRODUCT, SELLER, "x", null, new BigDecimal("200.00"), 11, ProductStatus.ON_SALE, 2);
         assertThat(c.put(v1)).isTrue();                                       // 讀的人先填了舊的值
         failScripts.set(true);
         c.putAfterCommit(() -> v2);                                           // 改價 commit 了，新值寫不進去
```

**`src/test/java/com/example/shop/catalog/internal/G2StampedeTest.java`**（第 05 章 5.7.9）

```diff
                 loads.incrementAndGet();
                 // 跟正式的 load() 一樣是一次 MySQL 讀取（加上 category 那一次 lazy 載入的代價，這裡用 JOIN 一次讀完）
                 return Optional.of(jdbc.queryForObject("""
-                        SELECT p.id, p.seller_id, p.name, p.description, p.price, p.category_id, p.status, p.hot, p.version FROM products p WHERE p.id = ?""",
+                        SELECT p.id, p.seller_id, p.name, p.description, p.price, p.category_id, p.status, p.version FROM products p WHERE p.id = ?""",
                         (rs, i) -> new ProductCache.Core(rs.getLong(1), rs.getLong(2), rs.getString(3), rs.getString(4), rs.getBigDecimal(5),
-                                rs.getLong(6), com.example.shop.catalog.ProductStatus.valueOf(rs.getString(7)), rs.getBoolean(8), rs.getInt(9)), id));
+                                rs.getLong(6), com.example.shop.catalog.ProductStatus.valueOf(rs.getString(7)), rs.getInt(8)), id));
             };
             ObjectMapper json = app.getBean(ObjectMapper.class);
             RedisGuard guard = app.getBean(RedisGuard.class);
```

**`src/test/java/com/example/shop/api/HotToggleApiTest.java`**（第 05 章 5.7.9）

```diff
 
 /**
  * 8.7 覆蓋率報表說的：POST /api/seller/products/{id}/hot（6.5，賣家把商品標成熱點）的「成功」一次都沒有被測過 ——
- * 其他測試都是 UPDATE products SET hot = TRUE；IdorMatrixTest 打過它，但永遠用別人的身分（404）。
+ * 其他測試都是 UPDATE products SET hot = TRUE（13 站 5.7 之後是 inventory.hot；products.hot 在 5.7.9 收縮掉了）；IdorMatrixTest 打過它，但永遠用別人的身分（404）。
  * 標成熱點：commit 之後 Redis 的閘門從 MySQL 的可售量建立（JdbcInventoryService.setHot → HotStock.initialize）；取消：commit 之後刪掉閘門。
  */
 @SpringBootTest(properties = {"shop.order.jobs-enabled=false", "shop.inventory.jobs-enabled=false"})
…
         // 13 站 5.7：旗標的擁有者是庫存 —— 取消熱點之後 inventory.hot 也是 false
         assertThat(jdbc.queryForObject("SELECT hot + 0 FROM inventory WHERE product_id = ?", Integer.class, PRODUCT)).isZero();
     }
-
-    @Test @DisplayName("13 站 5.7：搬家 —— 第 05 章之前標的熱點只在 products.hot；管理員打一次 copy-to-inventory，庫存的旗標跟上、閘門建好")
-    void copyOldFlagsToInventory() throws Exception {
-        jdbc.update("UPDATE products SET hot = TRUE WHERE id = ?", PRODUCT);  // 舊的旗標：第 05 章之前的 setHot 只寫這裡
-        int before = jdbc.queryForObject("SELECT hot + 0 FROM inventory WHERE product_id = ?", Integer.class, PRODUCT);
-        var r = mvc.perform(post("/api/admin/hot-flags/copy-to-inventory").header("Authorization", TestTokens.bearer(tokens, 1, Role.ADMIN)))
-                .andReturn().getResponse();
-        int after = jdbc.queryForObject("SELECT hot + 0 FROM inventory WHERE product_id = ?", Integer.class, PRODUCT);
-        System.out.printf("5.7 搬家：%d %s；inventory.hot %d → %d；閘門 stock:%d = %s%n", r.getStatus(), r.getContentAsString(), before, after,
-                PRODUCT, redis.opsForValue().get("stock:" + PRODUCT));
-        assertThat(r.getStatus()).isEqualTo(200);
-        assertThat(before).isZero();
-        assertThat(after).isEqualTo(1);
-        assertThat(redis.opsForValue().get("stock:" + PRODUCT)).isEqualTo("5");
-    }
 }
```

**`src/test/java/com/example/shop/tools/SeedData.java`**（第 05 章 5.7.9）

```diff
                 String status = u < 0.02 ? "DRAFT" : u < 0.05 ? "OFF_SHELF" : "ON_SALE";
                 Instant created = SEED_NOW.minus(Duration.ofDays(100 + r.nextInt(20)));
                 ps.add(new Product(id, sellerId, name, price, status));
-                rows.add(new Object[]{id, sellerId, cat, name, "「" + name + "」的商品說明。", price, status, id == 1, ts(created), ts(created)});
+                rows.add(new Object[]{id, sellerId, cat, name, "「" + name + "」的商品說明。", price, status, ts(created), ts(created)});
             }
         }
         batch("""
-              INSERT INTO products (id, seller_id, category_id, name, description, price, status, hot, created_at, updated_at)
-              VALUES (?,?,?,?,?,?,?,?,?,?)""", rows);
+              INSERT INTO products (id, seller_id, category_id, name, description, price, status, created_at, updated_at)
+              VALUES (?,?,?,?,?,?,?,?,?)""", rows);
         return ps;
     }
 
…
         for (Product p : products) {
             int[] a = agg.getOrDefault(p.id(), new int[2]);
             int start = a[0] + a[1] + 20 + r.nextInt(280);                 // 期初量 = 已賣 + 預留中 + 20～300 件
-            inv.add(new Object[]{p.id(), start - a[0], a[1], ts(SEED_NOW)});
+            // 1 號商品是熱點。13 站第 09 章寫完之後的追記（第 05 章 5.7.9）：這裡原本寫 products.hot —— 第 05 章之後旗標在 inventory.hot，
+            // 1 號商品從那時候起就不是熱點了；收縮之前找「誰還在寫這一欄」才看到
+            inv.add(new Object[]{p.id(), start - a[0], a[1], p.id() == 1, ts(SEED_NOW)});
             initial.add(new Object[]{p.id(), start, 0, "INITIAL", "seed", ts(SEED_NOW.minus(Duration.ofDays(120)))});
         }
-        batch("INSERT INTO inventory (product_id, on_hand, reserved, updated_at) VALUES (?,?,?,?)", inv);
+        batch("INSERT INTO inventory (product_id, on_hand, reserved, hot, updated_at) VALUES (?,?,?,?,?)", inv);
         batch("INSERT INTO inventory_ledger (product_id, delta_on_hand, delta_reserved, reason, ref, created_at) VALUES (?,?,?,?,?,?)", initial);
         batch("INSERT INTO inventory_ledger (product_id, delta_on_hand, delta_reserved, reason, ref, created_at) VALUES (?,?,?,?,?,?)", ledger);
         batch("""
```

**`src/test/java/com/example/shop/ordering/internal/EventFlowTest.java`**（第 05 章 5.7.9：測試資料（同一種改法的例子））

```diff
         if (!com.example.shop.support.TestInfra.containers()) com.example.shop.support.TestQueues.purgeConsumerQueues(ctx);
         mailer.reset();
         gateway.reset();
-        jdbc.update("INSERT INTO products (id, seller_id, category_id, name, price, status, hot) VALUES (?, ?, 11, '事件一般', 100.00, 'ON_SALE', FALSE), (?, ?, 11, '事件熱點', 100.00, 'ON_SALE', TRUE)",
+        jdbc.update("INSERT INTO products (id, seller_id, category_id, name, price, status) VALUES (?, ?, 11, '事件一般', 100.00, 'ON_SALE'), (?, ?, 11, '事件熱點', 100.00, 'ON_SALE')",
                 NORMAL, SELLER, HOT, SELLER);
         jdbc.update("INSERT INTO inventory (product_id, on_hand, reserved, hot) VALUES (?, 10, 0, FALSE), (?, 5, 0, TRUE)", NORMAL, HOT);   // 13 站 5.7
         jdbc.update("INSERT INTO inventory_ledger (product_id, delta_on_hand, delta_reserved, reason, ref) VALUES (?, 10, 0, 'INITIAL', 'ev'), (?, 5, 0, 'INITIAL', 'ev')", NORMAL, HOT);
…
 
     @Test @DisplayName("9.2.1 沒有人訂閱的事件（order.completed）不能卡住 relay：120 張訂單確認收貨之後，新的一張照樣收到「訂單成立」")
     void unsubscribedEventsDoNotBlockRelay() {
-        jdbc.update("INSERT INTO products (id, seller_id, category_id, name, price, status, hot) VALUES (?, ?, 11, '事件大量', 100.00, 'ON_SALE', FALSE)", BULK, SELLER);
+        jdbc.update("INSERT INTO products (id, seller_id, category_id, name, price, status) VALUES (?, ?, 11, '事件大量', 100.00, 'ON_SALE')", BULK, SELLER);
         jdbc.update("INSERT INTO inventory (product_id, on_hand, reserved) VALUES (?, 200, 0)", BULK);
         long t0 = System.nanoTime();
         for (int i = 0; i < 120; i++) {                                     // 上線第 7 天：第一批訂單走到 COMPLETED（US-ORD-6）
```

**`src/test/java/com/example/shop/dist09/Mig.java`**（9.6.7）

```diff
         Kube.waitFor(() -> List.of("monolith", "inventory-service", "order-service").stream().allMatch(Mig::settled), 120);
     }
 
+    /**
+     * 13 站 9.6.7 的追記：新的那一組庫存服務（inventory-service-next）—— 照現在的 inventory-service 抄一份：同一個映像檔、同一組設定，
+     * 差在 app 標籤（Service 的 selector 還沒有指到它）、接 db 與 Redis 的 redis、起來先待命（SHOP_DEPLOYMENT_STANDBY）。
+     * NetworkPolicy 也抄一份（podSelector 是 app 標籤）。等到每一台都 ready
+     */
+    public static void nextInventory(String db, String redis) throws Exception {
+        com.fasterxml.jackson.databind.node.ObjectNode d = (com.fasterxml.jackson.databind.node.ObjectNode) Calls.JSON.readTree(
+                Kube.kubectl("get", "deploy/inventory-service", "-o", "json"));
+        d.remove("status");
+        com.fasterxml.jackson.databind.node.ObjectNode meta = (com.fasterxml.jackson.databind.node.ObjectNode) d.get("metadata");
+        for (String f : List.of("uid", "resourceVersion", "creationTimestamp", "generation", "managedFields", "annotations")) meta.remove(f);
+        meta.put("name", "inventory-service-next");
+        ((com.fasterxml.jackson.databind.node.ObjectNode) meta.get("labels")).put("app", "inventory-service-next");
+        com.fasterxml.jackson.databind.node.ObjectNode spec = (com.fasterxml.jackson.databind.node.ObjectNode) d.get("spec");
+        ((com.fasterxml.jackson.databind.node.ObjectNode) spec.get("selector").get("matchLabels")).put("app", "inventory-service-next");
+        com.fasterxml.jackson.databind.node.ObjectNode tmpl = (com.fasterxml.jackson.databind.node.ObjectNode) spec.get("template");
+        ((com.fasterxml.jackson.databind.node.ObjectNode) tmpl.get("metadata").get("labels")).put("app", "inventory-service-next");
+        if (tmpl.get("metadata").has("annotations")) ((com.fasterxml.jackson.databind.node.ObjectNode) tmpl.get("metadata")).remove("annotations");
+        com.fasterxml.jackson.databind.node.ObjectNode app = (com.fasterxml.jackson.databind.node.ObjectNode) tmpl.get("spec").get("containers").get(0);
+        com.fasterxml.jackson.databind.node.ArrayNode env = app.putArray("env");      // env 蓋過 envFrom 的同一個 key
+        env.addObject().put("name", "SHOP_DB_NAME").put("value", db);
+        env.addObject().put("name", "SPRING_DATA_REDIS_DATABASE").put("value", redis);
+        env.addObject().put("name", "SHOP_DEPLOYMENT_STANDBY").put("value", "true");
+        com.fasterxml.jackson.databind.node.ObjectNode np = (com.fasterxml.jackson.databind.node.ObjectNode) Calls.JSON.readTree(
+                Kube.kubectl("get", "networkpolicy/inventory-service", "-o", "json"));
+        np.remove("status");
+        com.fasterxml.jackson.databind.node.ObjectNode npMeta = (com.fasterxml.jackson.databind.node.ObjectNode) np.get("metadata");
+        for (String f : List.of("uid", "resourceVersion", "creationTimestamp", "generation", "managedFields", "annotations")) npMeta.remove(f);
+        npMeta.put("name", "inventory-service-next");
+        ((com.fasterxml.jackson.databind.node.ObjectNode) np.get("spec").get("podSelector").get("matchLabels")).put("app", "inventory-service-next");
+        java.nio.file.Path f = java.nio.file.Files.createTempFile(java.nio.file.Path.of("target"), "next-", ".json");
+        java.nio.file.Files.writeString(f, "{\"apiVersion\":\"v1\",\"kind\":\"List\",\"items\":[" + d + "," + np + "]}");
+        Kube.kubectl("apply", "-f", f.toString());
+        java.nio.file.Files.delete(f);
+        Kube.kubectl("rollout", "status", "deploy/inventory-service-next", "--timeout=300s");
+        Kube.waitFor(() -> settled("inventory-service-next"), 120);
+    }
+
+    public static void deleteNext() throws Exception {
+        Kube.kubectl("delete", "deploy/inventory-service-next", "networkpolicy/inventory-service-next", "--ignore-not-found");
+    }
+
     /** 這個 app 沒有正在結束的 pod */
-    static boolean settled(String app) {
+    public static boolean settled(String app) {
         try { return Kube.pods(app).stream().noneMatch(Kube.Pod::terminating); } catch (Exception e) { return false; }
     }
 
```

**`src/test/java/com/example/shop/dist09/Cutover.java`**（9.6.7、9.6.8）

```diff
         return new Result((t1 - t0) / 1_000_000, (t2 - t1) / 1_000_000, drained, holes, dedup, outbox, diff, (t3 - t2) / 1_000_000, (t4 - t3) / 1_000_000);
     }
 
+    /**
+     * 13 站 9.6.8 的追記：搬家程式 —— 第 02 章 trigger 的那一個（Copier），或讀 binlog 的那一個（BinlogCopier）。
+     * fast() 只要它做四件事：停寫之後追完（drain）、關掉剩下的洞、核對、說出兩邊是哪兩個庫
+     */
+    public interface Source {
+        String from();
+        String to();
+        int drain() throws Exception;
+        int closeHoles();
+        Map<String, String> differences() throws Exception;
+
+        static Source of(Copier c) {
+            return new Source() {
+                @Override public String from() { return c.from; }
+                @Override public String to() { return c.to; }
+                @Override public int drain() throws Exception { int n, total = 0; while ((n = c.apply()) > 0) total += n; return total; }
+                @Override public int closeHoles() { return c.closeHoles(); }
+                @Override public Map<String, String> differences() throws Exception { return c.differences(); }
+            };
+        }
+    }
+
+    public record Fast(long freezeMs, long drainMs, int drained, int holesClosed, int dedupCopied, int outboxMoved,
+                       Map<String, String> diff, long verifyMs, long openMs, long switchMs, Map<String, String> frozen) {
+        public long totalMs() { return freezeMs + drainMs + verifyMs + openMs + switchMs; }
+
+        @Override
+        public String toString() {
+            long waited = frozen.values().stream().mapToLong(b -> Long.parseLong(b.replaceAll(".*\"waitedMs\":(\\d+).*", "$1"))).max().orElse(-1);
+            long listeners = frozen.values().stream().mapToLong(b -> Long.parseLong(b.replaceAll(".*\"listenersMs\":(\\d+).*", "$1"))).max().orElse(-1);
+            return String.format("停寫 %,d ms = 凍結 %,d ms（最慢的那一台 %d ms，其中停消費者 %d ms）＋ 追完 %,d 筆變更、關掉 %d 個洞 %,d ms ＋ 搬去重紀錄 %,d 列、還沒送出的事件 %,d 則、核對 %,d ms（不一樣的表：%s）＋ 新的那一組打開 %,d ms ＋ 換 Service 的 selector %,d ms",
+                    totalMs(), freezeMs, waited, listeners, drained, holesClosed, drainMs, dedupCopied, outboxMoved, verifyMs, diff.isEmpty() ? "沒有" : diff, openMs, switchMs);
+        }
+    }
+
+    /**
+     * 13 站 9.6.7 的追記：停寫縮短 —— 兩組 pod 都活著，只換「誰在寫」（WriteGate）。事先：新的那一組（toApp：接新的庫、待命）已經 ready、
+     * 兩組的管理埠都 port-forward 好。然後：
+     *   ① 舊的那一組凍結（等手上的寫入做完才回）—— 停寫從這裡開始
+     *   ② 追完、關洞、搬去重紀錄（與還沒送出的事件）、核對：跟 run() 一樣
+     *   ③ beforeOpen（例如在新的庫裝反方向的變更紀錄）、新的那一組打開
+     *   ④ Service 的 selector 換到新的那一組 —— 訂單服務的新連線就到新的那一組；舊的連線在下一個回應（Connection: close）之後關掉
+     * 舊的那一組還活著、還是凍結的：回頭路就是同一個操作反過來（9.7）；不回頭了，才縮到 0
+     */
+    public static Fast fast(Source copier, Writes from, Writes to, boolean moveOutbox, Kube.Check beforeOpen) throws Exception {
+        long t0 = System.nanoTime();
+        Map<String, String> frozen = from.post("FROZEN");
+        long t1 = System.nanoTime();
+        int drained = copier.drain();
+        int holes = copier.closeHoles();
+        int dedup = copy(copier.from(), copier.to(), "SELECT consumer, message_id, processed_at FROM processed_messages WHERE consumer LIKE 'inventory.%'",
+                "INSERT IGNORE INTO processed_messages (consumer, message_id, processed_at) VALUES (?, ?, ?)");
+        int outbox = !moveOutbox ? 0 : copy(copier.from(), copier.to(),
+                "SELECT event_id, aggregate_type, aggregate_id, event_type, payload, trace_id, created_at, traceparent FROM outbox_events WHERE published_at IS NULL",
+                "INSERT IGNORE INTO outbox_events (event_id, aggregate_type, aggregate_id, event_type, payload, trace_id, created_at, traceparent) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
+        if (outbox > 0) Mig.sql(copier.from(), "UPDATE outbox_events SET published_at = CURRENT_TIMESTAMP(3) WHERE published_at IS NULL");
+        long t2 = System.nanoTime();
+        Map<String, String> diff = copier.differences();
+        long t3 = System.nanoTime();
+        if (!diff.isEmpty()) {
+            from.post("OPEN");
+            throw new IllegalStateException("核對不過，沒有換：" + diff);
+        }
+        if (beforeOpen != null) beforeOpen.ok();
+        to.post("OPEN");
+        long t4 = System.nanoTime();
+        Kube.kubectl("patch", "service/inventory-service", "-p", "{\"spec\":{\"selector\":{\"app\":\"" + to.app + "\"}}}");
+        long t5 = System.nanoTime();
+        return new Fast((t1 - t0) / 1_000_000, (t2 - t1) / 1_000_000, drained, holes, dedup, outbox, diff, (t3 - t2) / 1_000_000,
+                (t4 - t3) / 1_000_000, (t5 - t4) / 1_000_000, frozen);
+    }
+
     /** 從 from 讀、寫進 to（兩條連線，不跨庫）。回傳讀到幾列（INSERT IGNORE：另一邊已經有的不動） */
     static int copy(String from, String to, String select, String insert) throws Exception {
         List<Object[]> rows = new ArrayList<>();
```

**`src/test/java/com/example/shop/dist09/Writes.java`**（9.6.7）

```java
package com.example.shop.dist09;

import com.example.shop.dist00.SplitLab;
import com.example.shop.dist08.Kube;

import java.net.URI;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * 13 站 9.6.7 的追記：一個 app 的每一個 pod 的寫入開關（WriteGateEndpoint：管理埠的 /actuator/writes，只收管理員）。
 * port-forward 事先開好：開一條要一兩秒，不能算在停寫裡。每一次 post 同時送給每一個 pod，全部回來才算完
 */
final class Writes implements AutoCloseable {

    record Pod(String name, int port, Process forward) {}

    static final AtomicInteger NEXT_PORT = new AtomicInteger(19_101);

    final String app;
    final List<Pod> pods = new ArrayList<>();
    private final String admin;

    Writes(String app, String admin) throws Exception {
        this.app = app;
        this.admin = admin;
        for (Kube.Pod p : Kube.pods(app)) {
            if (p.terminating()) continue;
            int port = NEXT_PORT.getAndIncrement();
            Process pf = new ProcessBuilder("kubectl", "--context", Kube.CTX, "-n", Kube.NS, "port-forward", "pod/" + p.name(), port + ":8081")
                    .redirectErrorStream(true).redirectOutput(ProcessBuilder.Redirect.DISCARD).start();
            pods.add(new Pod(p.name(), port, pf));
        }
        Kube.waitFor(() -> pods.stream().allMatch(p -> {
            try { return send(p, "GET", null).statusCode() == 200; } catch (Exception notYet) { return false; }
        }), 30);
    }

    HttpResponse<String> send(Pod p, String method, String body) throws Exception {
        HttpRequest.Builder b = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + p.port() + "/actuator/writes")).timeout(Duration.ofSeconds(20))
                .header("Authorization", admin).header("Content-Type", "application/json")
                .method(method, body == null ? HttpRequest.BodyPublishers.noBody() : HttpRequest.BodyPublishers.ofString(body));
        return SplitLab.CLIENT.send(b.build(), HttpResponse.BodyHandlers.ofString());
    }

    /** 每一個 pod 同時送 {"state": state}；回傳 pod → 回應。有一個不是 200 → 例外 */
    Map<String, String> post(String state) throws Exception {
        List<CompletableFuture<String[]>> fs = new ArrayList<>();
        for (Pod p : pods) fs.add(CompletableFuture.supplyAsync(() -> {
            try {
                HttpResponse<String> r = send(p, "POST", "{\"state\":\"" + state + "\"}");
                if (r.statusCode() != 200) throw new IllegalStateException(p.name() + " " + r.statusCode() + " " + r.body());
                return new String[]{p.name(), r.body()};
            } catch (Exception e) {
                throw new IllegalStateException(e);
            }
        }));
        Map<String, String> out = new TreeMap<>();
        for (var f : fs) { String[] r = f.get(); out.put(r[0], r[1]); }
        return out;
    }

    /** pod → {"state":…,"inFlight":…} */
    Map<String, String> states() throws Exception {
        Map<String, String> out = new TreeMap<>();
        for (Pod p : pods) out.put(p.name(), send(p, "GET", null).body());
        return out;
    }

    @Override
    public void close() {
        pods.forEach(p -> p.forward().destroy());
    }
}
```

**`src/test/java/com/example/shop/dist09/BinlogCopier.java`**（9.6.8）

```java
package com.example.shop.dist09;

import com.example.shop.dist00.SplitLab;
import com.example.shop.dist02.Copier;
import com.github.shyiko.mysql.binlog.BinaryLogClient;
import com.github.shyiko.mysql.binlog.event.DeleteRowsEventData;
import com.github.shyiko.mysql.binlog.event.EventHeaderV4;
import com.github.shyiko.mysql.binlog.event.EventType;
import com.github.shyiko.mysql.binlog.event.TableMapEventData;
import com.github.shyiko.mysql.binlog.event.UpdateRowsEventData;
import com.github.shyiko.mysql.binlog.event.WriteRowsEventData;

import java.io.Serializable;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;

/**
 * 13 站第 09 章寫完之後的追記（第 02 章 2.8.6、第 09 章 9.6.8）：binlog 的變更擷取。第 02 章 2.8.4 的搬家程式（Copier）用 trigger 記「哪一列變了」；
 * 這一個讀 MySQL 本來就在寫的 binlog（ROW 格式：每一列改之前、之後的值）—— 正本上不多寫任何一句。
 *
 * 跟 Copier 同一個做法：binlog 只拿來知道「哪一個主鍵變了」，搬的時候再去正本讀現在的那一列、整列寫過去（正本沒有了就刪）——
 * 寫過去的永遠是正本現在的樣子：同一列變了三次只要搬一次，回填與 binlog 重疊的那一段搬兩次也一樣。
 * 連線用 mysql-binlog-connector-java（Debezium 的 MySQL connector 底下也是它）：像一台 replica 一樣接上去。
 * 帳號要有 REPLICATION SLAVE、REPLICATION CLIENT（實驗用 root）；server_id 要跟其他 replica 不一樣。
 *
 * 起點：回填之前先記 binlog 的位置（SHOW MASTER STATUS）—— 回填途中改的列，接上之後一定看得到。
 * 追完（停寫之後，drain）：再記一次位置，等讀到那裡、排隊的主鍵都搬完。binlog 只有 commit 過的交易、照 commit 的順序寫 ——
 * 沒有 trigger 那種「號碼小的晚 commit」的洞（2.8.4 的 ⚠️），closeHoles() 永遠是 0。
 */
public final class BinlogCopier implements Cutover.Source {

    private final String from, to;
    private final Copier copier;                                             // 回填與核對用第 02 章的那一份（它的回填不需要 trigger）
    private final Map<String, List<String>> columns = new LinkedHashMap<>();
    private final Map<String, Integer> pkIndex = new LinkedHashMap<>();
    private final Map<Long, String> tables = new ConcurrentHashMap<>();       // binlog 的 tableId → 表名（只記 from 這個庫、搬家的那五張）
    private final LinkedHashSet<String> pending = new LinkedHashSet<>();      // 「表:主鍵」
    private final BinaryLogClient client;
    private volatile String file;
    private volatile long position;
    public final AtomicLong events = new AtomicLong(), rowsSeen = new AtomicLong(), applied = new AtomicLong();

    public BinlogCopier(String from, String to, long serverId) throws Exception {
        this.from = from;
        this.to = to;
        this.copier = new Copier(from, to);
        try (Connection c = SplitLab.root(from); PreparedStatement ps = c.prepareStatement(
                "SELECT column_name FROM information_schema.columns WHERE table_schema = ? AND table_name = ? ORDER BY ordinal_position")) {
            for (String t : Copier.TABLES.keySet()) {
                ps.setString(1, from); ps.setString(2, t);
                List<String> cols = new ArrayList<>();
                try (ResultSet rs = ps.executeQuery()) { while (rs.next()) cols.add(rs.getString(1)); }
                columns.put(t, cols);
                pkIndex.put(t, cols.indexOf(Copier.TABLES.get(t)));
            }
        }
        client = new BinaryLogClient("localhost", 3306, "root", "root");
        client.setServerId(serverId);
        client.registerEventListener(e -> {
            events.incrementAndGet();
            EventType type = e.getHeader().getEventType();
            if (type == EventType.TABLE_MAP) {
                TableMapEventData d = e.getData();
                if (d.getDatabase().equals(from) && columns.containsKey(d.getTable())) tables.put(d.getTableId(), d.getTable());
            } else if (EventType.isWrite(type)) {
                WriteRowsEventData d = e.getData();
                changed(d.getTableId(), d.getRows());
            } else if (EventType.isUpdate(type)) {
                UpdateRowsEventData d = e.getData();
                changed(d.getTableId(), d.getRows().stream().map(Map.Entry::getValue).toList());
            } else if (EventType.isDelete(type)) {
                DeleteRowsEventData d = e.getData();
                changed(d.getTableId(), d.getRows());
            }
            if (e.getHeader() instanceof EventHeaderV4 h && h.getNextPosition() > 0) {       // 處理完這一則之後讀到哪裡
                file = client.getBinlogFilename();
                position = h.getNextPosition();
            }
        });
    }

    private void changed(long tableId, List<Serializable[]> rows) {
        String t = tables.get(tableId);
        if (t == null) return;
        int i = pkIndex.get(t);
        synchronized (pending) {
            for (Serializable[] r : rows) { pending.add(t + ":" + ((Number) r[i]).longValue()); rowsSeen.incrementAndGet(); }
        }
    }

    /** 正本現在寫到 binlog 的哪裡 */
    public static String[] masterStatus() throws Exception {
        try (Connection c = SplitLab.root(""); Statement st = c.createStatement(); ResultSet rs = st.executeQuery("SHOW MASTER STATUS")) {
            rs.next();
            return new String[]{rs.getString("File"), String.valueOf(rs.getLong("Position"))};
        }
    }

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

    public void stop() throws Exception { client.disconnect(); }

    /** 排隊的主鍵，每一個去正本讀現在的那一列、寫過去（沒有了就刪）。回傳這一輪搬了幾個 */
    public int apply() throws Exception {
        List<String> batch;
        synchronized (pending) {
            batch = new ArrayList<>(pending);
            pending.clear();
        }
        if (batch.isEmpty()) return 0;
        try (Connection src = SplitLab.root(from); Connection dst = SplitLab.root(to)) {
            dst.setAutoCommit(false);
            try (Statement st = dst.createStatement()) { st.execute("SET SESSION foreign_key_checks = 0"); }
            for (String k : batch) {
                String t = k.substring(0, k.indexOf(':'));
                long id = Long.parseLong(k.substring(k.indexOf(':') + 1));
                List<String> cols = columns.get(t);
                String pk = Copier.TABLES.get(t);
                Object[] row = null;
                try (PreparedStatement ps = src.prepareStatement("SELECT " + String.join(", ", cols) + " FROM " + t + " WHERE " + pk + " = ?")) {
                    ps.setLong(1, id);
                    try (ResultSet rs = ps.executeQuery()) {
                        if (rs.next()) { row = new Object[cols.size()]; for (int i = 0; i < row.length; i++) row[i] = rs.getObject(i + 1); }
                    }
                }
                if (row == null) {
                    try (PreparedStatement ps = dst.prepareStatement("DELETE FROM " + t + " WHERE " + pk + " = ?")) { ps.setLong(1, id); ps.executeUpdate(); }
                } else {
                    String sql = "INSERT INTO " + t + " (" + String.join(", ", cols) + ") VALUES (" + String.join(", ", cols.stream().map(x -> "?").toList())
                            + ") AS new ON DUPLICATE KEY UPDATE " + String.join(", ", cols.stream().map(x -> x + " = new." + x).toList());
                    try (PreparedStatement ps = dst.prepareStatement(sql)) {
                        for (int i = 0; i < row.length; i++) ps.setObject(i + 1, row[i]);
                        ps.executeUpdate();
                    }
                }
            }
            dst.commit();
        }
        applied.addAndGet(batch.size());
        return batch.size();
    }

    public int pending() { synchronized (pending) { return pending.size(); } }

    /** 讀到的位置有沒有到 at（同一個檔案比位置；檔名是遞增的序號，換檔了就比檔名） */
    boolean reached(String[] at) {
        int c = file.compareTo(at[0]);
        return c > 0 || (c == 0 && position >= Long.parseLong(at[1]));
    }

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

    @Override public String from() { return from; }
    @Override public String to() { return to; }
    @Override public int closeHoles() { return 0; }
    @Override public Map<String, String> differences() throws Exception { return copier.differences(); }
}
```

**`src/test/java/com/example/shop/dist09/M4DataSplitTest.java`**（第 02 章 2.4.4：新的庫也要授權）

```diff
 
             SplitLab.freshDatabase(Mig.INV_DB);
             Flyway.configure().dataSource(SplitLab.url(Mig.INV_DB), "shop_migrator", "shop_migrator")
-                    .locations("classpath:db/migration/inventory", "classpath:db/migration/shared").load().migrate();
+                    .locations("classpath:db/migration/inventory", "classpath:db/migration/shared", "classpath:db/grants/inventory-service").load().migrate();   // grants：2.4.4 的追記，庫存服務的帳號
             Copier copier = new Copier(Mig.MONO_DB, Mig.INV_DB);
             copier.installCapture();
             long copied = 0;
```

**`src/test/java/com/example/shop/dist09/M6ContractTest.java`**（第 05 章 5.7.9）

```java
package com.example.shop.dist09;

import com.example.shop.dist00.SplitLab;
import com.example.shop.dist07.Keys;
import com.example.shop.dist08.Kube;
import com.example.shop.dist08.Load;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.context.ConfigurableApplicationContext;

import java.io.File;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.concurrent.ThreadLocalRandom;

/**
 * 13 站第 09 章寫完之後的追記（第 05 章 5.7.9）：收縮 —— 拿掉 products.hot。三個 commit 各建一個映像檔：
 *   shop:m6-before   收縮之前（第 09 章結束的那一個）：Product 還有 hot，每一張下單讀商品（CatalogApi.snapshots）都 SELECT 這一欄
 *   shop:m6-step1    第一步：程式不讀也不寫它；欄位還在
 *   shop:m6-step2    第二步：V36 刪欄位（正式程式碼跟第一步一樣）
 * 部署照第 08 章 8.4.5 的順序：migration 的 Job 跑完，才換應用程式的映像檔（滾動更新）。只開單體（權重 100／0、兩個服務縮到 0），每秒 R 張下單不停：
 *   ① 同一次部署就刪：舊版在跑 → 部署 step2（Job 刪欄位 → 滾動更新）
 *   ② 分兩次：舊版在跑 → 部署 step1（沒有新的 migration → 滾動更新）→ 部署 step2（刪欄位 → 滾動更新）
 * 每一次部署記：Job 開始、Job 跑完、換映像檔、滾動更新完成的時間；每一段的狀態碼；舊的那一個 pod 的 ERROR 日誌（kubectl logs -f 存下來）
 *
 *   mvn test -Pexperiments -Dtest=M6ContractTest -Dm6.before=<commit> -Dm6.step1=<commit> -Dm6.step2=<commit>    （約 10 分鐘）
 */
@Tag("experiment")
class M6ContractTest {

    final int rate = Integer.getInteger("m6.rate", 10);
    final PrintStream out = System.out;

    @Test
    void contract() throws Exception {
        for (String step : List.of("before", "step1", "step2")) build(step, System.getProperty("m6." + step));
        try (ConfigurableApplicationContext keys = Keys.start()) {
            out.printf("═══ 5.7.9 收縮：刪掉 products.hot。只開單體（%s），每秒 %d 張下單；部署 = migration 的 Job 跑完 → 換映像檔（滾動更新）═══%n", Mig.MONO_DB, rate);
            for (String step : List.of("before", "step1", "step2"))
                out.printf("  shop:m6-%-7s ← %s%n", step, Kube.sh("git", "log", "-1", "--format=%h %s", System.getProperty("m6." + step)).trim().replaceAll("^(.{110}).*", "$1…"));

            out.printf("  ① 同一次部署就刪：舊版在跑，部署 step2%n");
            fresh();
            try (Load load = Load.start(keys, Mig.ENTRY, rate, M6ContractTest::anyProduct)) {
                load.until(15);
                Deploy d = deploy(load, "step2");
                load.until((d.settled + 15_000) / 1000);
                load.close();
                report(load, List.of(d));
            }

            out.printf("  ② 分兩次：舊版在跑，部署 step1，再部署 step2%n");
            fresh();
            try (Load load = Load.start(keys, Mig.ENTRY, rate, M6ContractTest::anyProduct)) {
                load.until(15);
                Deploy d1 = deploy(load, "step1");
                load.until((d1.settled + 15_000) / 1000);
                Deploy d2 = deploy(load, "step2");
                load.until((d2.settled + 15_000) / 1000);
                load.close();
                report(load, List.of(d1, d2));
            }
            out.printf("  products 的欄位：%s%n", Kube.sh("docker", "compose", "exec", "-T", "mysql", "mysql", "-uroot", "-proot", "-N", "-e",
                    "SELECT GROUP_CONCAT(column_name ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema = '" + Mig.MONO_DB + "' AND table_name = 'products'")
                    .lines().filter(l -> !l.contains("Using a password")).findFirst().orElse(""));
            out.printf("  （結束時 load %s）%n", SplitLab.load());
        }
    }

    static long anyProduct() { return SplitLab.FIRST_PRODUCT + ThreadLocalRandom.current().nextInt(SplitLab.PRODUCTS); }

    /** git archive 那一個 commit → docker build（context 從 stdin）→ kind load */
    static void build(String step, String commit) throws Exception {
        if (commit == null) throw new IllegalArgumentException("要給 -Dm6." + step + "=<commit>");
        Kube.sh("sh", "-c", "git archive --format=tar " + commit + " | docker build -q -t shop:m6-" + step + " -");
        Kube.sh(System.getProperty("d08.kind", "kind"), "load", "docker-image", "shop:m6-" + step, "--name", "d08");
    }

    /** 清空兩個庫、Redis、vhost；設定 → 舊版的 migration → 三個部署都是舊版的映像檔、兩個服務縮到 0；種 1,000 個商品 */
    void fresh() throws Exception {
        Mig.script("databases");
        Kube.kubectl("apply", "-k", "k8s/kind", "-l", "stage=config");
        migrate("before");
        apply(Kube.sh("kubectl", "kustomize", "k8s/kind").replace("image: shop:d09", "image: shop:m6-before"), null);
        Kube.kubectl("scale", "deploy/order-service", "deploy/inventory-service", "--replicas=0");
        Kube.kubectl("rollout", "restart", "deploy/monolith");                 // 換了庫：新的連線、新的佇列
        Kube.kubectl("rollout", "status", "deploy/monolith", "--timeout=300s");
        Kube.waitFor(() -> Mig.settled("monolith") && Mig.settled("order-service") && Mig.settled("inventory-service"), 120);
        SplitLab.seed(Mig.MONO_DB, true, true);
        Mig.script("gateway");                                                // 權重回到 100／0（routes.yaml）
        Mig.weights(100, 0);
        Thread.sleep(3_000);
    }

    /** 單體的 migration Job，用這個映像檔（Job 的 spec 不能改：先刪再建） */
    static void migrate(String step) throws Exception {
        Kube.kubectl("delete", "job", "migrate-monolith", "--ignore-not-found");
        apply(Kube.sh("kubectl", "kustomize", "k8s/kind/migrate").replace("image: shop:d09", "image: shop:m6-" + step), "migrate notin (order,inventory)");
        Kube.kubectl("wait", "--for=condition=complete", "job/migrate-monolith", "--timeout=180s");
    }

    static void apply(String manifests, String selector) throws Exception {
        Path f = Files.createTempFile(Path.of("target"), "m6-", ".yaml");
        Files.writeString(f, manifests);
        List<String> cmd = new ArrayList<>(List.of("apply", "-f", f.toString()));
        if (selector != null) cmd.addAll(List.of("-l", selector));
        Kube.kubectl(cmd.toArray(String[]::new));
        Files.delete(f);
    }

    record Deploy(String step, long jobStart, long jobDone, long rolloutDone, long settled, String oldPod, Map<String, Long> oldErrors) {}

    /** 第 08 章 8.4.5 的順序：Job 跑完 → 換映像檔 → 等滾動更新完成、舊的 pod 結束。時間都從負載開始算（毫秒） */
    Deploy deploy(Load load, String step) throws Exception {
        String oldPod = Kube.pods("monolith").get(0).name();
        File log = Path.of("target", "m6-" + step + "-" + oldPod + ".log").toFile();
        Process follow = new ProcessBuilder("kubectl", "--context", Kube.CTX, "-n", Kube.NS, "logs", "-f", oldPod).redirectErrorStream(true).redirectOutput(log).start();
        long jobStart = load.elapsedMs();
        migrate(step);
        long jobDone = load.elapsedMs();
        Kube.kubectl("set", "image", "deploy/monolith", "app=shop:m6-" + step);
        Kube.kubectl("rollout", "status", "deploy/monolith", "--timeout=300s");
        long rolloutDone = load.elapsedMs();
        Kube.waitFor(() -> Mig.settled("monolith"), 120);
        long settled = load.elapsedMs();
        follow.destroy();
        Map<String, Long> errors = new TreeMap<>();
        for (String line : Files.readAllLines(log.toPath(), StandardCharsets.UTF_8)) {
            if (!line.contains("\"level\":\"ERROR\"")) continue;
            String msg;
            try { msg = com.example.shop.dist07.Calls.JSON.readTree(line).path("message").asText().replaceAll("\\d+", "N"); }
            catch (Exception notJson) { msg = "（不是 JSON）"; }
            errors.merge(msg.length() > 120 ? msg.substring(0, 120) : msg, 1L, Long::sum);
        }
        return new Deploy(step, jobStart, jobDone, rolloutDone, settled, oldPod, errors);
    }

    void report(Load load, List<Deploy> deploys) {
        long end = load.done.stream().mapToLong(Load.Done::atMs).max().orElse(0);
        for (Deploy d : deploys) {
            out.printf("    部署 %s：Job 第 %.1f～%.1f 秒；換映像檔、滾動更新到第 %.1f 秒；舊的 pod 第 %.1f 秒結束%n",
                    d.step, d.jobStart / 1000.0, d.jobDone / 1000.0, d.rolloutDone / 1000.0, d.settled / 1000.0);
            out.printf("      Job 之前 15 秒 %s │ Job 跑的時候 %s │ Job 跑完 → 舊的 pod 結束 %s │ 之後 %s%n",
                    Load.fmt(load.codes(d.jobStart - 15_000, d.jobStart)), Load.fmt(load.codes(d.jobStart, d.jobDone)),
                    Load.fmt(load.codes(d.jobDone, d.settled)), Load.fmt(load.codes(d.settled, d.settled + 15_000)));
            out.printf("      舊的 pod（%s）的 ERROR 日誌：%s%n", d.oldPod, d.oldErrors.isEmpty() ? "沒有" : d.oldErrors);
        }
        List<String> odd = new ArrayList<>();
        for (long t = 0; t <= end; t += 5_000) {
            Map<Integer, Long> c = load.codes(t, t + 5_000);
            if (c.keySet().stream().anyMatch(k -> k != 201)) odd.add(String.format("%.0f～%.0f 秒 %s", t / 1000.0, (t + 5_000) / 1000.0, Load.fmt(c)));
        }
        out.printf("    整段：下單 %s；不是 201 的格（每 5 秒一格）：%s%n", Load.fmt(load.codes(0, Long.MAX_VALUE)), odd.isEmpty() ? "沒有" : String.join("；", odd));
    }
}
```

**`src/test/java/com/example/shop/dist09/M7AccountsTest.java`**（9.4.6）

```java
package com.example.shop.dist09;

import com.example.shop.dist00.SplitLab;
import com.example.shop.dist03.Shop;
import com.example.shop.dist07.Keys;
import com.example.shop.dist08.Kube;
import com.example.shop.shared.web.Role;
import com.example.shop.support.TestTokens;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.context.ConfigurableApplicationContext;

import java.io.PrintStream;
import java.math.BigDecimal;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.Statement;
import java.time.LocalDate;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

/**
 * 13 站第 09 章寫完之後的追記（第 02 章 2.4.4、第 09 章 9.3.4）：每個服務一個資料庫帳號。kind 上三個部署接單體的庫（9.4 共用的那一段）：
 * 單體用 shop（shop_app：每一張表）、訂單服務用 order_svc（order_app：庫存以外）、庫存服務用 inventory_svc（inventory_app：庫存與 shared）。
 *
 *   ① 三個帳號各讀一張庫存的表、一張訂單的表
 *   ② 權重 0／100（/api/** 全部給訂單服務）、單體縮到 0：使用者的每一種動作走幾次，再讓排程跑 70 秒 ——
 *      兩個服務的日誌裡有沒有「command denied」（程式碼的邊界漏了的地方，資料庫的權限會在這一段就說出來）
 *   ③ 一個設定錯誤：訂單服務打開庫存的排程（SHOP_INVENTORY_JOBSENABLED=true —— 第 03 章 3.7 的角色裡是關的）。庫存服務縮到 0，
 *      訂單服務分別用 shop（第 09 章的樣子）與 order_svc 各跑 70 秒：庫存的排程那一句 SQL 跑了幾次、錯了幾次（performance_schema）、日誌說什麼
 *
 *   mvn test -Pexperiments -Dtest=M7AccountsTest        （約 8 分鐘）
 */
@Tag("experiment")
class M7AccountsTest {

    final PrintStream out = System.out;
    /** InventoryReconciliation.checkUncounted 的那一句（每 30 秒） */
    static final String UNCOUNTED = "%TIMESTAMPDIFF%FROM `inventory_reservations` WHERE `counted` = %";

    @Test
    void accounts() throws Exception {
        try (ConfigurableApplicationContext keys = Keys.start()) {
            Mig.fresh();
            out.printf("═══ 2.4.4 的追記：每個服務一個資料庫帳號 —— 三個部署接 %s（第 09 章 9.4 共用的那一段）═══%n", Mig.MONO_DB);
            for (String app : List.of("monolith", "order-service", "inventory-service"))
                out.printf("  %-17s 的 SHOP_DB_USER：%s%n", app, Kube.kubectl("exec", "deploy/" + app, "--", "printenv", "SHOP_DB_USER").trim());

            out.printf("  ① 三個帳號各讀一張庫存的表、一張訂單的表%n");
            for (String[] u : new String[][]{{"shop", "shop"}, {"order_svc", "order_svc"}, {"inventory_svc", "inventory_svc"}})
                out.printf("    %-14s inventory → %s │ orders → %s%n", u[0], read(u, "inventory"), read(u, "orders"));

            Mig.weights(0, 100);
            Mig.scale("monolith", 0);
            Thread.sleep(3_000);
            Map<String, Long> denied0 = denied();
            Map<String, Map<Integer, Long>> ops = day(keys);
            out.printf("  ② 權重 0／100、單體縮到 0：使用者的一天（每一種動作、每一個狀態碼幾次）%n");
            ops.forEach((op, codes) -> out.printf("    %-28s %s%n", op, codes));
            Thread.sleep(70_000);
            out.printf("    之後排程再跑 70 秒。兩個服務的日誌裡的「command denied」：%s%n", fmt(minus(denied(), denied0)));

            out.printf("  ③ 設定錯誤：訂單服務打開庫存的排程（庫存服務縮到 0、沒有負載）%n");
            Mig.scale("inventory-service", 0);
            for (String user : List.of("shop", "order_svc")) {
                Kube.kubectl("set", "env", "deploy/order-service", "SHOP_INVENTORY_JOBSENABLED=true", "SHOP_DB_USER=" + user, "SHOP_DB_PASSWORD=" + user);
                Kube.kubectl("rollout", "status", "deploy/order-service", "--timeout=300s");
                Kube.waitFor(() -> Mig.settled("order-service"), 120);
                long[] before = digest();
                Thread.sleep(70_000);
                long[] after = digest();
                Map<String, Long> errors = Mig.errors("order-service");
                out.printf("    訂單服務用 %-9s：70 秒裡，checkUncounted 那一句跑了 %d 次、錯了 %d 次；訂單服務的 ERROR 日誌 %s%n",
                        user, after[0] - before[0], after[1] - before[1], errors.isEmpty() ? "沒有" : errors);
            }
            Kube.kubectl("set", "env", "deploy/order-service", "SHOP_INVENTORY_JOBSENABLED-", "SHOP_DB_USER-", "SHOP_DB_PASSWORD-");
            Kube.kubectl("rollout", "status", "deploy/order-service", "--timeout=300s");
            Mig.scale("inventory-service", 2);
            out.printf("  （結束時 load %s）%n", SplitLab.load());
        }
    }

    static String read(String[] user, String table) {
        try (Connection c = DriverManager.getConnection(SplitLab.url(Mig.MONO_DB), user[0], user[1]); Statement st = c.createStatement();
             ResultSet rs = st.executeQuery("SELECT COUNT(*) FROM " + table)) {
            rs.next();
            return rs.getLong(1) + " 列";
        } catch (Exception e) {
            return e.getMessage();
        }
    }

    /** 使用者的一天：買家、賣家、管理員的每一種動作，全部經過入口 */
    Map<String, Map<Integer, Long>> day(ConfigurableApplicationContext keys) throws Exception {
        Shop shop = new Shop(keys, () -> Mig.ENTRY);
        Map<String, Map<Integer, Long>> ops = new TreeMap<>();
        String admin = TestTokens.bearer(keys, 990_901, Role.ADMIN);
        String today = LocalDate.now().toString(), weekAgo = LocalDate.now().minusDays(7).toString();
        for (int i = 0; i < 12; i++) {
            long buyer = 9_700_001 + i, p = SplitLab.FIRST_PRODUCT + 100 + i, q = SplitLab.FIRST_PRODUCT + 200 + i;
            String b = shop.bearer(buyer);
            tally(ops, "GET 商品頁", shop.send("GET", "/api/products/" + p, null, null, Map.of()));
            tally(ops, "GET 商品列表", shop.send("GET", "/api/products?size=5", null, null, Map.of()));
            tally(ops, "GET 熱門商品", shop.send("GET", "/api/products/trending", null, null, Map.of()));
            tally(ops, "POST 購物車", shop.send("POST", "/api/cart/items", b, Map.of("productId", q, "quantity", 1), Map.of()));
            tally(ops, "GET 購物車", shop.send("GET", "/api/cart", b, null, Map.of()));
            tally(ops, "DELETE 購物車的一項", shop.send("DELETE", "/api/cart/items/" + q, b, null, Map.of()));
            Shop.Res placed = shop.place(buyer, java.util.UUID.randomUUID().toString(), p);
            tally(ops, "POST 下單", placed);
            if (placed.status() != 201) continue;
            String orderNo = placed.json().get("orderNo").asText();
            tally(ops, "GET 我的訂單", shop.send("GET", "/api/orders", b, null, Map.of()));
            tally(ops, "GET 訂單詳情", shop.send("GET", "/api/orders/" + orderNo, b, null, Map.of()));
            if (i % 3 == 2) { tally(ops, "POST 買家取消", shop.cancel(buyer, orderNo)); continue; }
            tally(ops, "POST 付款（建立＋回呼）", shop.pay(buyer, orderNo));
            if (i % 3 == 1) continue;
            tally(ops, "POST 賣家撿貨", shop.startPicking(orderNo));
            tally(ops, "POST 賣家出貨", shop.ship(orderNo));
            tally(ops, "POST 確認收貨", shop.send("POST", "/api/orders/" + orderNo + "/confirm-receipt", b, null, Map.of()));
            tally(ops, "GET 管理員看 Saga", shop.send("GET", "/api/admin/orders/" + orderNo + "/saga", admin, null, Map.of()));
        }
        long hot = SplitLab.FIRST_PRODUCT + 300;
        tally(ops, "POST 標成熱點", shop.send("POST", "/api/seller/products/" + hot + "/hot", shop.seller(), Map.of("hot", true), Map.of()));
        tally(ops, "POST 取消熱點", shop.send("POST", "/api/seller/products/" + hot + "/hot", shop.seller(), Map.of("hot", false), Map.of()));
        tally(ops, "POST 補貨", shop.restock(hot, 5));
        tally(ops, "POST 建立商品", shop.send("POST", "/api/seller/products", shop.seller(), Map.of("name", "M7 新商品", "price", new BigDecimal("100.00"),
                "categoryId", 11, "initialStock", 3), Map.of()));
        tally(ops, "GET 賣家的商品", shop.send("GET", "/api/seller/products", shop.seller(), null, Map.of()));
        tally(ops, "GET 賣家的訂單", shop.send("GET", "/api/seller/orders", shop.seller(), null, Map.of()));
        tally(ops, "GET 賣家的報表", shop.send("GET", "/api/seller/reports/daily-sales?from=" + weekAgo + "&to=" + today, shop.seller(), null, Map.of()));
        tally(ops, "GET 管理員的報表", shop.send("GET", "/api/admin/reports/top-products?from=" + weekAgo + "&to=" + today, admin, null, Map.of()));
        tally(ops, "GET 管理員的死信", shop.send("GET", "/api/admin/dead-letters", admin, null, Map.of()));
        return ops;
    }

    /**
     * 每一個動作之後停 60 ms：一個人一秒最多十幾個請求。第一版一個接一個送，撞到「每個 IP 每秒 50 次」（第 12 站 6.7.2），
     * 好幾種動作一半是 429 —— 那幾次根本沒有走到程式裡，也就碰不到資料庫的權限
     */
    static void tally(Map<String, Map<Integer, Long>> ops, String op, Shop.Res r) throws InterruptedException {
        ops.computeIfAbsent(op, k -> new TreeMap<>()).merge(r.status(), 1L, Long::sum);
        Thread.sleep(60);
    }

    /** 兩個服務的日誌裡含「command denied」的 ERROR／WARN 行：依訊息（數字換成 N）分組數 */
    static Map<String, Long> denied() throws Exception {
        Map<String, Long> m = new TreeMap<>();
        for (String app : List.of("order-service", "inventory-service"))
            for (Kube.Pod p : Kube.pods(app))
                for (String line : Kube.shAny("kubectl", "--context", Kube.CTX, "-n", Kube.NS, "logs", p.name()).split("\n"))
                    if (line.contains("command denied")) m.merge(app + "：" + line.replaceAll(".*(\\w+ command denied[^\"\\\\]*).*", "$1").replaceAll("\\d+", "N"), 1L, Long::sum);
        return m;
    }

    static Map<String, Long> minus(Map<String, Long> now, Map<String, Long> before) {
        Map<String, Long> m = new TreeMap<>();
        now.forEach((k, v) -> { long d = v - before.getOrDefault(k, 0L); if (d != 0) m.put(k, d); });
        return m;
    }

    static String fmt(Map<String, Long> m) { return m.isEmpty() ? "沒有" : m.toString(); }

    /** checkUncounted 那一句：performance_schema 的 digest 統計（全部的帳號加起來）—— 跑了幾次、錯了幾次 */
    static long[] digest() throws Exception {
        try (Connection c = SplitLab.root(Mig.MONO_DB); Statement st = c.createStatement();
             ResultSet rs = st.executeQuery("SELECT COALESCE(SUM(count_star), 0), COALESCE(SUM(sum_errors), 0) FROM performance_schema.events_statements_summary_by_digest "
                     + "WHERE schema_name = '" + Mig.MONO_DB + "' AND digest_text LIKE '" + UNCOUNTED + "'")) {
            rs.next();
            return new long[]{rs.getLong(1), rs.getLong(2)};
        }
    }
}
```

**`src/test/java/com/example/shop/dist09/M8FastCutoverTest.java`**（9.6.7）

```java
package com.example.shop.dist09;

import com.example.shop.dist00.SplitLab;
import com.example.shop.dist02.Copier;
import com.example.shop.dist07.Keys;
import com.example.shop.dist08.Kube;
import com.example.shop.dist08.Load;
import com.example.shop.shared.web.Role;
import com.example.shop.support.TestTokens;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.context.ConfigurableApplicationContext;

import java.io.PrintStream;

/**
 * 13 站第 09 章寫完之後的追記（9.6.7）：停寫縮短。M4 的同一個場景（下單全部走訂單服務、單體縮到 0、庫存的五張表還在單體的庫），
 * 換庫的方法換成 Cutover.fast：新的那一組（inventory-service-next：接新的庫、Redis 2、待命）事先起來；舊的凍結、追完、核對、新的打開、
 * Service 的 selector 換過去。然後用同一個方法切回來（回頭路：舊的那一組一直活著、凍結著）。
 *
 *   ① ② 新的庫、搬家程式（跟 M4 一樣）
 *   ③ 新的那一組起來（待命）—— 這一段不算停寫
 *   ④ 切換、⑤ 切過去之後 60 秒、⑥ 切回來、⑦ 之後 30 秒；每 1 秒一格的狀態碼
 * 從頭到尾每秒 N 張下單不停。
 *
 *   mvn test -Pexperiments -Dtest=M8FastCutoverTest        （約 7 分鐘）
 */
@Tag("experiment")
class M8FastCutoverTest {

    final int rate = Integer.getInteger("m8.rate", 10);
    final PrintStream out = System.out;

    @Test
    void fastCutover() throws Exception {
        try (ConfigurableApplicationContext keys = Keys.start()) {
            String admin = TestTokens.bearer(keys, 990_901, Role.ADMIN);
            Mig.fresh();
            Mig.deleteNext();
            Mig.weights(0, 100);
            Mig.scale("monolith", 0);
            try (Load warm = Load.start(keys, Mig.ENTRY, rate, M4DataSplitTest::anyProduct)) { warm.until(20); }
            out.printf("═══ 9.6.7 停寫縮短：下單全部走訂單服務、單體縮到 0；庫存的五張表在 %s，只有庫存服務在寫。每秒 %d 張下單，從頭到尾不停 ═══%n", Mig.MONO_DB, rate);
            Load load = Load.start(keys, Mig.ENTRY, rate, M4DataSplitTest::anyProduct);

            SplitLab.freshDatabase(Mig.INV_DB);
            Flyway.configure().dataSource(SplitLab.url(Mig.INV_DB), "shop_migrator", "shop_migrator")
                    .locations("classpath:db/migration/inventory", "classpath:db/migration/shared", "classpath:db/grants/inventory-service").load().migrate();
            Copier copier = new Copier(Mig.MONO_DB, Mig.INV_DB);
            copier.installCapture();
            long copied = 0;
            for (String t : Copier.TABLES.keySet()) copied += copier.backfill(t);
            M4DataSplitTest.Tracker forward = M4DataSplitTest.Tracker.start(copier);
            while (copier.lag() > 100) Thread.sleep(200);
            out.printf("  ① ② 第 %.0f 秒：新的庫跑完庫存與 shared 的 migration；搬家程式回填 %,d 列、追上了%n", load.elapsedMs() / 1000.0, copied);
            out.printf("     邊寫邊比：%s%n", new Verifier(Mig.MONO_DB, Mig.INV_DB).run());

            long up0 = load.elapsedMs();
            Mig.nextInventory(Mig.INV_DB, "2");
            long up1 = load.elapsedMs();
            try (Writes old = new Writes("inventory-service", admin); Writes next = new Writes("inventory-service-next", admin)) {
                out.printf("  ③ 新的那一組起來（第 %.0f～%.0f 秒，%.1f 秒，不算停寫）：%s%n     舊的那一組：%s%n", up0 / 1000.0, up1 / 1000.0, (up1 - up0) / 1000.0,
                        next.states(), old.states());
                load.until(up1 / 1000 + 10);

                forward.stop();
                Copier[] reverse = new Copier[1];
                long freezeAt = load.elapsedMs();
                Cutover.Fast cut = Cutover.fast(Cutover.Source.of(copier), old, next, false, () -> {
                    reverse[0] = new Copier(Mig.INV_DB, Mig.MONO_DB);             // 回頭路：新的庫一開始被寫，就有變更紀錄
                    reverse[0].installCapture();
                    return true;
                });
                long liveAt = load.elapsedMs();
                copier.dropCapture();
                M4DataSplitTest.Tracker back = M4DataSplitTest.Tracker.start(reverse[0]);
                out.printf("  ④ 切換（第 %.1f～%.1f 秒）：%s%n", freezeAt / 1000.0, liveAt / 1000.0, cut);
                out.printf("     凍結的回應：%s%n", cut.frozen());
                load.until(liveAt / 1000 + 60);
                out.printf("     切換前後，每 1 秒：%s%n", seconds(load, freezeAt - 3_000, liveAt + 12_000));
                out.printf("     切換之前 10 秒：下單 %s；停寫的那 %,d ms 送出的：下單 %s；之後 10 秒：下單 %s%n",
                        Load.fmt(load.codes(freezeAt - 10_000, freezeAt)), liveAt - freezeAt, Load.fmt(load.codes(freezeAt, liveAt)), Load.fmt(load.codes(liveAt, liveAt + 10_000)));
                out.printf("  ⑤ 切過去之後 60 秒：下單 %s；反方向的搬家程式套用 %,d 筆、失敗 %d 次；每一個庫存服務的 pod 收到的預留 %s%n",
                        Load.fmt(load.codes(liveAt, liveAt + 60_000)), back.applied.get(), back.failed.get(), reserves());
                out.printf("     新的庫：INV-2 對不上的商品 %d 個；還在等付款、在新的庫找不到預留的訂單 %d 張；單體的庫跟著新的庫嗎：%s%n",
                        Mig.count(Mig.INV_DB, Mig.INV2), M4DataSplitTest.orphans(Mig.INV_DB), new Verifier(Mig.INV_DB, Mig.MONO_DB).run());

                back.stop();
                long rollbackAt = load.elapsedMs();
                Cutover.Fast undo = Cutover.fast(Cutover.Source.of(reverse[0]), next, old, true, null);
                long backAt = load.elapsedMs();
                reverse[0].dropCapture();
                out.printf("  ⑥ 切回來（第 %.1f～%.1f 秒；舊的那一組一直活著、凍結著）：%s%n", rollbackAt / 1000.0, backAt / 1000.0, undo);
                load.until(backAt / 1000 + 30);
                load.close();
                out.printf("     切回來前後，每 1 秒：%s%n", seconds(load, rollbackAt - 3_000, backAt + 12_000));
                out.printf("  ⑦ 切回來之後 30 秒：下單 %s；單體的庫：INV-2 對不上的商品 %d 個；還在等付款、找不到預留的訂單 %d 張%n",
                        Load.fmt(load.codes(backAt, Long.MAX_VALUE)), Mig.count(Mig.MONO_DB, Mig.INV2), M4DataSplitTest.orphans(Mig.MONO_DB));
                out.printf("  整段：下單 %s；不是全部 201 的格（每 5 秒）：%s%n", Load.fmt(load.codes(0, Long.MAX_VALUE)), odd5s(load));
                out.printf("     除了 201、503 之外的狀態碼出現在：%s；訂單服務的 ERROR 日誌：%s%n", Mig.oddWindows(load), Mig.errors("order-service"));
                out.printf("     庫存服務的 ERROR 日誌：舊的那一組 %s；新的那一組 %s%n", Mig.errors("inventory-service"), Mig.errors("inventory-service-next"));
            }
            Mig.deleteNext();
            out.printf("  （結束時 load %s）%n", SplitLab.load());
        }
    }

    /** 整段裡不是全部 201 的格（每 5 秒一格）：503 落在哪幾段（M11 第一次跑，切換以外還有 89 張 503，那一版沒有記時間） */
    static String odd5s(Load load) {
        java.util.List<String> w = new java.util.ArrayList<>();
        long end = load.done.stream().mapToLong(Load.Done::atMs).max().orElse(0);
        for (long t = 0; t <= end; t += 5_000) {
            java.util.Map<Integer, Long> c = load.codes(t, t + 5_000);
            if (c.keySet().stream().anyMatch(k -> k != 201)) w.add(String.format("%.0f～%.0f 秒 %s", t / 1000.0, (t + 5_000) / 1000.0, Load.fmt(c)));
        }
        return w.isEmpty() ? "沒有" : String.join("；", w);
    }

    /** [from, to) 每 1 秒一格：只列不是全部 201 的那幾格，連續全 201 的合成一段 */
    static String seconds(Load load, long from, long to) {
        java.util.List<String> w = new java.util.ArrayList<>();
        for (long t = from; t < to; t += 1_000) {
            java.util.Map<Integer, Long> c = load.codes(t, t + 1_000);
            w.add(String.format("%.0f%s", t / 1000.0, c.keySet().stream().allMatch(k -> k == 201) ? "✓" : Load.fmt(c).toString()));
        }
        return String.join(" ", w);
    }

    static String reserves() throws Exception {
        java.util.Map<String, Double> m = new java.util.TreeMap<>();
        for (String app : java.util.List.of("inventory-service", "inventory-service-next"))
            for (Kube.Pod p : Kube.pods(app))
                m.put(p.name(), Kube.sum(Kube.metrics(p.name()), "http_server_requests_seconds_count", "uri=\"/internal/inventory/v1/reservations/{orderId}\"", "method=\"PUT\""));
        return m.toString();
    }
}
```

**`src/test/java/com/example/shop/dist09/M9JobAlertTest.java`**（9.5.2）

```java
package com.example.shop.dist09;

import com.example.shop.dist00.SplitLab;
import com.example.shop.dist07.Calls;
import com.example.shop.dist07.Keys;
import com.example.shop.dist08.Kube;
import com.example.shop.dist08.Load;
import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.context.ConfigurableApplicationContext;

import java.io.PrintStream;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ThreadLocalRandom;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;

/**
 * 13 站第 09 章寫完之後的追記（9.5.2）：ShopJobHigh5xxRatio 在 kind 上真的響一次。第 09 章只用 promtool 驗證過它（M2 的每一段都是 0 個 5xx）。
 *
 * 灰度在 5%（單體 95、訂單服務 5），每秒 R 張下單、Q 個商品頁（經過入口，下單 : 讀 = 1 : 9）。第 T 秒「新的那一邊壞掉」：
 * 一個只有新的路才有的設定錯誤 —— 訂單服務的 SHOP_INVENTORY_URL 指到一個不存在的名字（滾動更新換上去；readiness 不檢查庫存服務連不連得到，0.6.3）。
 * 之後訂單服務的每一張下單都是 503、讀照常 —— 它的 5xx 是 10% 左右，全站只有 0.5% 左右。
 * 每 15 秒問一次入口旁邊的 Prometheus（kind 的 18890）：兩條規則各在第幾秒 pending、firing；firing 之後把權重改回 100／0（灰度的回滾），看它多久解除。
 *
 *   mvn test -Pexperiments -Dtest=M9JobAlertTest        （約 14 分鐘）
 */
@Tag("experiment")
class M9JobAlertTest {

    static final int PROM = 18890;
    final int orders = Integer.getInteger("m9.orders", 4), reads = Integer.getInteger("m9.reads", 36), breakAt = Integer.getInteger("m9.break", 60);
    final PrintStream out = System.out;

    @Test
    void jobAlert() throws Exception {
        try (ConfigurableApplicationContext keys = Keys.start()) {
            Mig.fresh();
            Mig.weights(95, 5);
            Thread.sleep(3_000);
            out.printf("═══ 9.5.2 ShopJobHigh5xxRatio 在 kind 上：灰度 5%%，每秒 %d 張下單、%d 個商品頁；第 %d 秒訂單服務的 SHOP_INVENTORY_URL 指錯 ═══%n", orders, reads, breakAt);
            Load load = Load.start(keys, Mig.ENTRY, orders, () -> SplitLab.FIRST_PRODUCT + 100 + ThreadLocalRandom.current().nextInt(900));
            Reader reader = Reader.start(reads);
            Map<String, String> seen = new LinkedHashMap<>();
            List<String> timeline = new ArrayList<>();
            long brokenAt = -1, firingAt = -1, rolledBackAt = -1, resolvedAt = -1;
            Mig.Http m0 = Mig.http("monolith"), o0 = Mig.http("order-service");
            while (true) {
                long s = load.elapsedMs() / 1000;
                if (brokenAt < 0 && s >= breakAt) {
                    Kube.kubectl("set", "env", "deploy/order-service", "SHOP_INVENTORY_URL=http://inventory-service-typo:8080");
                    Kube.kubectl("rollout", "status", "deploy/order-service", "--timeout=300s");
                    brokenAt = load.elapsedMs() / 1000;
                    timeline.add(String.format("第 %3d 秒 ── 訂單服務的 SHOP_INVENTORY_URL 指錯（kubectl set env，滾動更新完成）", brokenAt));
                }
                for (Map.Entry<String, String> a : alerts().entrySet()) {
                    if (a.getValue().equals(seen.get(a.getKey()))) continue;
                    seen.put(a.getKey(), a.getValue());
                    timeline.add(String.format("第 %3d 秒 %s %s", s, a.getKey(), a.getValue()));
                    if (a.getKey().startsWith("ShopJobHigh5xxRatio") && a.getValue().equals("firing") && firingAt < 0) firingAt = s;
                }
                for (String k : new ArrayList<>(seen.keySet()))
                    if (!alerts().containsKey(k) && !seen.get(k).equals("解除")) { seen.put(k, "解除"); timeline.add(String.format("第 %3d 秒 %s 解除", s, k)); }
                if (firingAt >= 0 && rolledBackAt < 0 && s >= firingAt + 30) {
                    Mig.weights(100, 0);
                    rolledBackAt = load.elapsedMs() / 1000;
                    timeline.add(String.format("第 %3d 秒 ── 權重改回 100／0（灰度的回滾）", rolledBackAt));
                }
                if (rolledBackAt >= 0 && seen.entrySet().stream().filter(e -> e.getKey().startsWith("ShopJobHigh5xxRatio")).allMatch(e -> e.getValue().equals("解除"))) {
                    resolvedAt = s;
                    break;
                }
                if (s > breakAt + 900) break;
                Thread.sleep(15_000);
            }
            load.close();
            reader.close();
            Mig.Http m = Mig.http("monolith").minus(m0), o = Mig.http("order-service").minus(o0);
            out.printf("  告警（每 15 秒問一次 /api/v1/alerts；ShopHigh5xxRatio 一次都沒有出現就是沒有 pending 過）：%n");
            timeline.forEach(t -> out.println("    " + t));
            out.printf("  下單：%s；商品頁：%s；下單的兩邊各算各的 —— 單體 %s │ 訂單服務 %s%n", Load.fmt(load.codes(0, Long.MAX_VALUE)), reader.codes, m, o);
            out.printf("  壞掉之後（第 %d 秒起）的下單：%s%n", brokenAt, Load.fmt(load.codes(brokenAt * 1000, rolledBackAt < 0 ? Long.MAX_VALUE : rolledBackAt * 1000)));
            out.printf("  firing 的那一刻，5 分鐘窗的 5xx 比例（/api/**）：%s%n", ratios);
            out.printf("  firing：壞掉之後 %d 秒；解除：回滾之後 %d 秒%n", firingAt - brokenAt, resolvedAt - rolledBackAt);
            Kube.kubectl("set", "env", "deploy/order-service", "SHOP_INVENTORY_URL-");
            Kube.kubectl("rollout", "status", "deploy/order-service", "--timeout=300s");
            out.printf("  （結束時 load %s）%n", SplitLab.load());
        }
    }

    String ratios = "（沒有 firing）";

    /** 現在 pending／firing 的告警：「名字{job}」→ 狀態。ShopJobHigh5xxRatio firing 的那一刻，順便記下每個 job 與全站的比例 */
    Map<String, String> alerts() throws Exception {
        Map<String, String> m = new LinkedHashMap<>();
        for (JsonNode a : Calls.JSON.readTree(Kube.sh("curl", "-s", "http://127.0.0.1:" + PROM + "/api/v1/alerts")).path("data").path("alerts")) {
            String name = a.path("labels").path("alertname").asText();
            if (!name.matches("ShopHigh5xxRatio|ShopJobHigh5xxRatio|ShopPlaceOrderSlow|ShopServiceGone|ShopDown")) continue;
            String job = a.path("labels").path("job").asText("");
            m.put(name + (job.isEmpty() ? "" : "{" + job + "}"), a.path("state").asText());
            if (name.equals("ShopJobHigh5xxRatio") && a.path("state").asText().equals("firing") && ratios.startsWith("（")) ratios = ratioNow();
        }
        return m;
    }

    String ratioNow() throws Exception {
        String byJob = "sum by (job) (rate(http_server_requests_seconds_count{system=\"shop\",uri=~\"/api/.*\",status=~\"5..\"}[5m])) / sum by (job) (rate(http_server_requests_seconds_count{system=\"shop\",uri=~\"/api/.*\"}[5m]))";
        String all = "sum(rate(http_server_requests_seconds_count{system=\"shop\",uri=~\"/api/.*\",status=~\"5..\"}[5m])) / sum(rate(http_server_requests_seconds_count{system=\"shop\",uri=~\"/api/.*\"}[5m]))";
        List<String> parts = new ArrayList<>();
        for (JsonNode r : query(byJob)) parts.add(r.path("metric").path("job").asText() + " " + pct(r));
        for (JsonNode r : query(all)) parts.add("全站 " + pct(r));
        return String.join("、", parts);
    }

    static JsonNode query(String promql) throws Exception {
        return Calls.JSON.readTree(Kube.sh("curl", "-s", "http://127.0.0.1:" + PROM + "/api/v1/query?query=" + URLEncoder.encode(promql, StandardCharsets.UTF_8)))
                .path("data").path("result");
    }

    static String pct(JsonNode r) { return String.format("%.2f%%", 100 * Double.parseDouble(r.path("value").get(1).asText())); }

    /** 開放式的商品頁讀取：每秒 n 個（不等前一個回來），記下每一個狀態碼 */
    static final class Reader implements AutoCloseable {
        final Map<Integer, AtomicLong> byCode = new java.util.concurrent.ConcurrentSkipListMap<>();
        final Map<Integer, Long> codes = new java.util.TreeMap<>();
        final AtomicBoolean stop = new AtomicBoolean();
        final java.util.concurrent.ExecutorService pool = java.util.concurrent.Executors.newVirtualThreadPerTaskExecutor();
        Thread sender;

        static Reader start(int perSecond) {
            Reader r = new Reader();
            long t0 = System.nanoTime(), gap = 1_000_000_000L / perSecond;
            r.sender = Thread.ofPlatform().start(() -> {
                for (long i = 0; !r.stop.get(); i++) {
                    long wait = t0 + i * gap - System.nanoTime();
                    if (wait > 0) try { Thread.sleep(wait / 1_000_000, (int) (wait % 1_000_000)); } catch (InterruptedException e) { return; }
                    r.pool.submit(() -> {
                        int code;
                        try { code = Calls.send(Mig.ENTRY, "GET", "/api/products/" + (SplitLab.FIRST_PRODUCT + ThreadLocalRandom.current().nextInt(SplitLab.PRODUCTS)), null, null, Map.of()).status(); }
                        catch (Exception e) { code = -1; }
                        r.byCode.computeIfAbsent(code, k -> new AtomicLong()).incrementAndGet();
                    });
                }
            });
            return r;
        }

        @Override
        public void close() throws Exception {
            stop.set(true);
            sender.join();
            pool.shutdown();
            pool.awaitTermination(60, java.util.concurrent.TimeUnit.SECONDS);
            byCode.forEach((k, v) -> codes.put(k, v.get()));
        }
    }
}
```

**`src/test/java/com/example/shop/dist09/M10UserCanaryTest.java`**（9.5.7）

```java
package com.example.shop.dist09;

import com.example.shop.dist00.SplitLab;
import com.example.shop.dist07.Calls;
import com.example.shop.dist07.Keys;
import com.example.shop.dist08.Kube;
import com.example.shop.dist08.Load;
import com.example.shop.support.TestTokens;
import com.nimbusds.jose.JWSAlgorithm;
import com.nimbusds.jose.JWSHeader;
import com.nimbusds.jose.crypto.MACSigner;
import com.nimbusds.jwt.JWTClaimsSet;
import com.nimbusds.jwt.SignedJWT;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.context.ConfigurableApplicationContext;

import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Date;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ThreadLocalRandom;

/**
 * 13 站第 09 章寫完之後的追記（9.5.7）：依使用者分群的灰度。9.5 的權重是「每一個請求挑一次」，cookie 的黏性是「同一個瀏覽器」；
 * 這裡是「同一個人」—— 入口驗買家的 token（Envoy Gateway 的 SecurityPolicy：JWT），把 sub 抄到 x-shop-user，
 * HTTPRoute 多一條規則：x-shop-user 結尾是 0 或 1 的人（兩成），不看權重、直接去訂單服務。權重維持 100／0：其他人、沒有登入的請求都在單體。
 *
 *   ① 20 個買家各看 5 次自己的訂單：兩邊各收到幾個（兩邊的計數器）
 *   ② 沒有登入的商品頁 20 次
 *   ③ 同一個人一直讀：10 個人（5 個在訂單服務、5 個在單體）各盯一個商品、每 400 ms 看一次，30 秒；同時每秒 R 張下單（9.5.4 的 M3）
 *   ④ 自己帶 x-shop-user：沒有 token、帶著別人的 token
 *   ⑤ 壞的 token：簽章不對、過期了 —— 誰回的、回什麼（套上 SecurityPolicy 之前，同一個過期的 token 是應用程式自己回的）
 *   ⑥ 回滾：拿掉那一條規則，多久之後那兩成的人回到單體
 *
 *   mvn test -Pexperiments -Dtest=M10UserCanaryTest        （約 5 分鐘）
 */
@Tag("experiment")
class M10UserCanaryTest {

    static final long FIRST_USER = 9_800_000;
    static final String RULE = "{\"matches\":[{\"path\":{\"type\":\"PathPrefix\",\"value\":\"/api\"},\"headers\":[{\"name\":\"x-shop-user\",\"type\":\"RegularExpression\","
            + "\"value\":\"^[0-9]*[01]$\"}]}],\"backendRefs\":[{\"name\":\"order-service\",\"port\":8080}]}";

    final int rate = Integer.getInteger("m10.rate", 10);
    final PrintStream out = System.out;

    @Test
    void userCanary() throws Exception {
        try (ConfigurableApplicationContext keys = Keys.start()) {
            Mig.fresh();
            Mig.weights(100, 0);
            String before = brief(http(Mig.ENTRY, "/api/orders", "Bearer " + token(keysSecret(), FIRST_USER, Instant.now().minusSeconds(600)), Map.of()));
            String secret = Files.readAllLines(Path.of("k8s/kind/secrets.env")).stream().filter(l -> l.startsWith("SHOP_JWT_SECRET=")).findFirst().orElseThrow().substring(16);
            String jwks = "{\"keys\":[{\"kty\":\"oct\",\"alg\":\"HS256\",\"k\":\"" + Base64.getUrlEncoder().withoutPadding().encodeToString(secret.getBytes(StandardCharsets.UTF_8)) + "\"}]}";
            Kube.kubectl("delete", "configmap", "shop-jwks", "--ignore-not-found");
            Kube.kubectl("create", "configmap", "shop-jwks", "--from-literal=jwks=" + jwks);
            Kube.kubectl("apply", "-f", "k8s/lab/user-canary.yaml");
            Kube.kubectl("patch", "httproute/shop-api", "--type=json", "-p", "[{\"op\":\"add\",\"path\":\"/spec/rules/-\",\"value\":" + RULE + "}]");
            long applied = System.nanoTime();
            String a0 = TestTokens.bearer(keys, FIRST_USER);                    // 結尾 0：訂單服務
            Kube.waitFor(() -> sideOf(a0).equals("order-service"), 60);
            out.printf("═══ 9.5.7 依使用者分群：入口驗 token、sub → x-shop-user；結尾 0、1 的人去訂單服務，其他照權重（100／0）═══%n");
            out.printf("  SecurityPolicy、規則套上之後 %.1f 秒，第一個結尾 0 的人被送到訂單服務%n", (System.nanoTime() - applied) / 1e9);

            Map<String, Double> c0 = counts();
            for (long u = FIRST_USER; u < FIRST_USER + 20; u++)
                for (int i = 0; i < 5; i++) {
                    Calls.send(Mig.ENTRY, "GET", "/api/orders", TestTokens.bearer(keys, u), null, Map.of());
                    Thread.sleep(40);   // 第一版一個接一個送：撞到每個 IP 每秒 50 次，被擋下的 429 不算在 /api/orders 的計數器裡（uri 不是它）
                }
            Map<String, Double> c1 = counts();
            out.printf("  ① 20 個買家（結尾 0、1 的 4 個）各看 5 次自己的訂單：GET /api/orders 單體 %.0f 個、訂單服務 %.0f 個%n",
                    c1.get("monolith orders") - c0.get("monolith orders"), c1.get("order-service orders") - c0.get("order-service orders"));
            for (int i = 0; i < 20; i++) { Calls.send(Mig.ENTRY, "GET", "/api/products/" + (SplitLab.FIRST_PRODUCT + i), null, null, Map.of()); Thread.sleep(40); }
            Map<String, Double> c2 = counts();
            out.printf("  ② 沒有登入的商品頁 20 次：單體 %.0f 個、訂單服務 %.0f 個%n",
                    c2.get("monolith products") - c1.get("monolith products"), c2.get("order-service products") - c1.get("order-service products"));

            Load load = Load.start(keys, Mig.ENTRY, rate, () -> SplitLab.FIRST_PRODUCT + ThreadLocalRandom.current().nextInt(5));
            out.printf("  ③ 同一個人一直讀（每秒 %d 張下單在那 5 個商品上）：%s%n", rate, readers(keys, 30));
            load.close();
            out.printf("     這段時間的下單 %s%n", Load.fmt(load.codes(0, Long.MAX_VALUE)));

            out.printf("  ④ 自己帶 x-shop-user：沒有 token、帶 9800010 → %s；結尾 2 的人的 token、帶 9800010 → %s；結尾 0 的人的 token、帶 9800012 → %s%n",
                    sideOf(null, Map.of("x-shop-user", "9800010")), sideOf(TestTokens.bearer(keys, FIRST_USER + 2), Map.of("x-shop-user", "9800010")),
                    sideOf(a0, Map.of("x-shop-user", "9800012")));

            String wrongKey = "Bearer " + token("another-secret-another-secret-0123456789", FIRST_USER, Instant.now().plusSeconds(600));
            String expired = "Bearer " + token(secret, FIRST_USER, Instant.now().minusSeconds(600));
            out.printf("  ⑤ 壞的 token（GET /api/orders）：套上之前，過期 10 分鐘 → %s%n", before);
            out.printf("     套上之後：簽章不對 → %s；過期 10 分鐘 → %s；同一個過期的 token 帶 Shop-Route: monolith → %s%n",
                    brief(http(Mig.ENTRY, "/api/orders", wrongKey, Map.of())), brief(http(Mig.ENTRY, "/api/orders", expired, Map.of())),
                    brief(http(Mig.ENTRY, "/api/orders", expired, Map.of("Shop-Route", "monolith"))));

            int index = Calls.JSON.readTree(Kube.kubectl("get", "httproute/shop-api", "-o", "json")).path("spec").path("rules").size() - 1;
            Kube.kubectl("patch", "httproute/shop-api", "--type=json", "-p", "[{\"op\":\"remove\",\"path\":\"/spec/rules/" + index + "\"}]");
            long removed = System.nanoTime();
            Kube.waitFor(() -> sideOf(a0).equals("monolith"), 60);
            out.printf("  ⑥ 回滾（拿掉那一條規則）：%.1f 秒後，結尾 0 的人回到單體%n", (System.nanoTime() - removed) / 1e9);

            Kube.kubectl("delete", "-f", "k8s/lab/user-canary.yaml");
            Kube.kubectl("delete", "configmap", "shop-jwks");
            out.printf("  （結束時 load %s）%n", SplitLab.load());
        }
    }

    /** 這個 token 的 GET /api/orders 被哪一邊回的（兩邊的計數器，誰多了 1） */
    static String sideOf(String token) throws Exception { return sideOf(token, Map.of()); }

    static String sideOf(String token, Map<String, String> headers) throws Exception {
        String path = token == null ? "/api/products/" + SplitLab.FIRST_PRODUCT : "/api/orders";
        String key = token == null ? "products" : "orders";
        Map<String, Double> before = counts();
        Calls.Res r = Calls.send(Mig.ENTRY, "GET", path, token, null, headers);
        Map<String, Double> after = counts();
        String side = after.get("monolith " + key) > before.get("monolith " + key) ? "monolith"
                : after.get("order-service " + key) > before.get("order-service " + key) ? "order-service" : "兩邊都沒有收到（" + r.status() + "）";
        return side;
    }

    /** 兩邊到現在為止回了幾個 GET /api/orders、GET /api/products/{id} */
    static Map<String, Double> counts() throws Exception {
        Map<String, Double> m = new java.util.TreeMap<>();
        for (String app : List.of("monolith", "order-service")) {
            double orders = 0, products = 0;
            for (Kube.Pod p : Kube.pods(app)) {
                String text = Kube.metrics(p.name());
                double o = Kube.sum(text, "http_server_requests_seconds_count", "uri=\"/api/orders\"", "method=\"GET\"");
                double q = Kube.sum(text, "http_server_requests_seconds_count", "uri=\"/api/products/{id}\"", "method=\"GET\"");
                if (!Double.isNaN(o)) orders += o;
                if (!Double.isNaN(q)) products += q;
            }
            m.put(app + " orders", orders);
            m.put(app + " products", products);
        }
        return m;
    }

    /** 10 個人（5 個結尾 0、1 → 訂單服務；5 個結尾 2～6 → 單體）各盯一個商品，每 400 ms 帶自己的 token 看一次：可售量倒退幾次（M3 的算法） */
    String readers(ConfigurableApplicationContext keys, int seconds) throws Exception {
        long[] users = {FIRST_USER, FIRST_USER + 1, FIRST_USER + 10, FIRST_USER + 11, FIRST_USER + 20, FIRST_USER + 2, FIRST_USER + 3, FIRST_USER + 4, FIRST_USER + 5, FIRST_USER + 6};
        long[] reads = new long[1], backwards = new long[1], errors = new long[1];
        List<Thread> ts = new ArrayList<>();
        long end = System.nanoTime() + seconds * 1_000_000_000L;
        for (int i = 0; i < users.length; i++) {
            String token = TestTokens.bearer(keys, users[i]);
            long product = SplitLab.FIRST_PRODUCT + i % 5;
            ts.add(Thread.ofVirtual().start(() -> {
                int prev = -1;
                while (System.nanoTime() < end) {
                    try {
                        Calls.Res r = Calls.send(Mig.ENTRY, "GET", "/api/products/" + product, token, null, Map.of());
                        if (r.status() != 200) { synchronized (reads) { errors[0]++; } }
                        else {
                            int now = r.json().get("available").asInt();
                            synchronized (reads) { reads[0]++; if (prev >= 0 && now > prev) backwards[0]++; }
                            prev = now;
                        }
                        Thread.sleep(400);
                    } catch (Exception e) {
                        synchronized (reads) { errors[0]++; }
                    }
                }
            }));
        }
        for (Thread t : ts) t.join();
        return String.format("讀 %,d 次（失敗 %d）；可售量倒退 %d 次", reads[0], errors[0], backwards[0]);
    }

    static String token(String secret, long user, Instant exp) throws Exception {
        JWTClaimsSet claims = new JWTClaimsSet.Builder().issuer("shop").subject(Long.toString(user)).issueTime(Date.from(exp.minusSeconds(900)))
                .expirationTime(Date.from(exp)).jwtID(UUID.randomUUID().toString()).claim("roles", List.of("BUYER")).build();
        SignedJWT jwt = new SignedJWT(new JWSHeader(JWSAlgorithm.HS256), claims);
        jwt.sign(new MACSigner(secret.getBytes(StandardCharsets.UTF_8)));
        return jwt.serialize();
    }

    /** 狀態碼、WWW-Authenticate、Content-Type、內容的開頭 */
    static String brief(java.net.http.HttpResponse<String> r) {
        String b = r.body() == null ? "" : r.body().replace('\n', ' ');
        return r.statusCode() + "（WWW-Authenticate: " + r.headers().firstValue("WWW-Authenticate").orElse("沒有") + "；Content-Type: "
                + r.headers().firstValue("Content-Type").orElse("沒有") + "）" + (b.length() > 90 ? b.substring(0, 90) + "…" : b);
    }

    static java.net.http.HttpResponse<String> http(int port, String path, String token, Map<String, String> headers) throws Exception {
        var b = java.net.http.HttpRequest.newBuilder(java.net.URI.create("http://127.0.0.1:" + port + path)).header("Authorization", token);
        headers.forEach(b::header);
        return SplitLab.CLIENT.send(b.build(), java.net.http.HttpResponse.BodyHandlers.ofString());
    }

    static String keysSecret() throws Exception {
        return Files.readAllLines(Path.of("k8s/kind/secrets.env")).stream().filter(l -> l.startsWith("SHOP_JWT_SECRET=")).findFirst().orElseThrow().substring(16);
    }
}
```

**`src/test/java/com/example/shop/dist09/M11BinlogTest.java`**（9.6.8）

```java
package com.example.shop.dist09;

import com.example.shop.dist00.SplitLab;
import com.example.shop.dist07.Keys;
import com.example.shop.dist08.Load;
import com.example.shop.shared.web.Role;
import com.example.shop.support.TestTokens;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.context.ConfigurableApplicationContext;

import java.io.PrintStream;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;

/**
 * 13 站第 09 章寫完之後的追記（第 02 章 2.8.6、第 09 章 9.6.8）：M8 的同一個場景，搬家程式換成讀 binlog 的那一個（BinlogCopier）——
 * 正本上沒有 trigger、沒有變更紀錄表；停寫之後的「追完」是「等 binlog 讀到正本現在的位置」。回頭路也是 binlog（新的庫 → 單體的庫）。
 *
 *   ① 新的庫、BinlogCopier 回填、接上 binlog、追上；邊寫邊比
 *   ② 新的那一組起來（待命）；③ 切換（Cutover.fast）；④ 切過去之後 60 秒；⑤ 切回來；⑥ 之後 30 秒
 * 從頭到尾每秒 N 張下單不停。
 *
 *   mvn test -Pexperiments -Dtest=M11BinlogTest        （約 7 分鐘）
 */
@Tag("experiment")
class M11BinlogTest {

    final int rate = Integer.getInteger("m11.rate", 10);
    final PrintStream out = System.out;

    @Test
    void binlog() throws Exception {
        try (ConfigurableApplicationContext keys = Keys.start()) {
            String admin = TestTokens.bearer(keys, 990_901, Role.ADMIN);
            Mig.fresh();
            Mig.deleteNext();
            Mig.weights(0, 100);
            Mig.scale("monolith", 0);
            try (Load warm = Load.start(keys, Mig.ENTRY, rate, M4DataSplitTest::anyProduct)) { warm.until(20); }
            out.printf("═══ 9.6.8 binlog 的變更擷取：M8 的場景，搬家程式讀 binlog；每秒 %d 張下單，從頭到尾不停 ═══%n", rate);
            out.printf("  正本上的 trigger：%d 個（第 02 章的做法每一個表三個）%n", Mig.count(Mig.MONO_DB, "SELECT COUNT(*) FROM information_schema.triggers WHERE trigger_schema = '" + Mig.MONO_DB + "'"));
            Load load = Load.start(keys, Mig.ENTRY, rate, M4DataSplitTest::anyProduct);

            SplitLab.freshDatabase(Mig.INV_DB);
            Flyway.configure().dataSource(SplitLab.url(Mig.INV_DB), "shop_migrator", "shop_migrator")
                    .locations("classpath:db/migration/inventory", "classpath:db/migration/shared", "classpath:db/grants/inventory-service").load().migrate();
            BinlogCopier forward = new BinlogCopier(Mig.MONO_DB, Mig.INV_DB, 65_001);
            String[] at = BinlogCopier.masterStatus();
            long copied = forward.start();
            Follow f1 = Follow.start(forward);
            while (forward.pending() > 100) Thread.sleep(200);
            Thread.sleep(2_000);
            out.printf("  ① 第 %.0f 秒：binlog 從 %s:%s 接上；回填 %,d 列；之後 %,d 則 binlog 事件、其中搬家的五張表的列 %,d 個%n",
                    load.elapsedMs() / 1000.0, at[0], at[1], copied, forward.events.get(), forward.rowsSeen.get());
            out.printf("     邊寫邊比：%s%n", new Verifier(Mig.MONO_DB, Mig.INV_DB).run());

            long up0 = load.elapsedMs();
            Mig.nextInventory(Mig.INV_DB, "2");
            long up1 = load.elapsedMs();
            try (Writes old = new Writes("inventory-service", admin); Writes next = new Writes("inventory-service-next", admin)) {
                out.printf("  ② 新的那一組起來（第 %.0f～%.0f 秒，%.1f 秒，不算停寫）%n", up0 / 1000.0, up1 / 1000.0, (up1 - up0) / 1000.0);
                load.until(up1 / 1000 + 10);

                f1.stop();
                BinlogCopier[] reverse = new BinlogCopier[1];
                long freezeAt = load.elapsedMs();
                Cutover.Fast cut = Cutover.fast(forward, old, next, false, () -> {
                    reverse[0] = new BinlogCopier(Mig.INV_DB, Mig.MONO_DB, 65_002);  // 回頭路：從現在的位置接上新的庫的 binlog
                    reverse[0].start();
                    return true;
                });
                long liveAt = load.elapsedMs();
                forward.stop();
                Follow f2 = Follow.start(reverse[0]);
                out.printf("  ③ 切換（第 %.1f～%.1f 秒）：%s%n", freezeAt / 1000.0, liveAt / 1000.0, cut);
                load.until(liveAt / 1000 + 60);
                out.printf("     切換前後，每 1 秒：%s%n", M8FastCutoverTest.seconds(load, freezeAt - 3_000, liveAt + 12_000));
                out.printf("  ④ 切過去之後 60 秒：下單 %s；反方向（binlog）搬了 %,d 個主鍵、失敗 %d 次%n",
                        Load.fmt(load.codes(liveAt, liveAt + 60_000)), reverse[0].applied.get(), f2.failed.get());
                out.printf("     新的庫：INV-2 對不上的商品 %d 個；還在等付款、在新的庫找不到預留的訂單 %d 張；單體的庫跟著新的庫嗎：%s%n",
                        Mig.count(Mig.INV_DB, Mig.INV2), M4DataSplitTest.orphans(Mig.INV_DB), new Verifier(Mig.INV_DB, Mig.MONO_DB).run());

                f2.stop();
                long rollbackAt = load.elapsedMs();
                Cutover.Fast undo = Cutover.fast(reverse[0], next, old, true, null);
                long backAt = load.elapsedMs();
                reverse[0].stop();
                out.printf("  ⑤ 切回來（第 %.1f～%.1f 秒）：%s%n", rollbackAt / 1000.0, backAt / 1000.0, undo);
                load.until(backAt / 1000 + 30);
                load.close();
                out.printf("     切回來前後，每 1 秒：%s%n", M8FastCutoverTest.seconds(load, rollbackAt - 3_000, backAt + 12_000));
                out.printf("  ⑥ 切回來之後 30 秒：下單 %s；單體的庫：INV-2 對不上的商品 %d 個；還在等付款、找不到預留的訂單 %d 張%n",
                        Load.fmt(load.codes(backAt, Long.MAX_VALUE)), Mig.count(Mig.MONO_DB, Mig.INV2), M4DataSplitTest.orphans(Mig.MONO_DB));
                out.printf("  整段：下單 %s；不是全部 201 的格（每 5 秒）：%s%n", Load.fmt(load.codes(0, Long.MAX_VALUE)), M8FastCutoverTest.odd5s(load));
                out.printf("     訂單服務的 ERROR 日誌：%s%n", Mig.errors("order-service"));
                out.printf("  正本上的 trigger（結束時）：單體的庫 %d 個、新的庫 %d 個%n",
                        Mig.count(Mig.MONO_DB, "SELECT COUNT(*) FROM information_schema.triggers WHERE trigger_schema = '" + Mig.MONO_DB + "'"),
                        Mig.count(Mig.INV_DB, "SELECT COUNT(*) FROM information_schema.triggers WHERE trigger_schema = '" + Mig.INV_DB + "'"));
            }
            Mig.deleteNext();
            out.printf("  （結束時 load %s）%n", SplitLab.load());
        }
    }

    /** 背景一直搬：沒有排隊的就睡 100 ms（M4 的 Tracker，換成 BinlogCopier） */
    static final class Follow {
        final AtomicBoolean stop = new AtomicBoolean();
        final AtomicLong failed = new AtomicLong();
        Thread thread;

        static Follow start(BinlogCopier c) {
            Follow f = new Follow();
            f.thread = Thread.ofPlatform().start(() -> {
                while (!f.stop.get()) {
                    try {
                        if (c.apply() == 0) Thread.sleep(100);
                    } catch (InterruptedException e) {
                        return;
                    } catch (Exception e) {
                        f.failed.incrementAndGet();
                        try { Thread.sleep(100); } catch (InterruptedException ie) { return; }
                    }
                }
            });
            return f;
        }

        void stop() throws InterruptedException {
            stop.set(true);
            thread.join();
        }
    }
}
```

**`src/test/java/com/example/shop/dist09/M12FiveHundredTest.java`**（9.6.5）

```java
package com.example.shop.dist09;

import com.example.shop.dist00.SplitLab;
import com.example.shop.dist02.Copier;
import com.example.shop.dist07.Calls;
import com.example.shop.dist07.Keys;
import com.example.shop.dist08.Kube;
import com.example.shop.support.TestTokens;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.context.ConfigurableApplicationContext;

import java.io.PrintStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ThreadLocalRandom;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;

/**
 * 13 站第 09 章寫完之後的追記（9.6.5）：探索時的那 1 張 500。M4 第二次跑出 1 張，那一版沒有記它的內容、也沒有日誌，最後一輪沒有再出現。
 * 這裡把 M4 的切換（Cutover.run：縮到 0、換設定、重開）來回 N 次，每秒 R 張下單不停，記下：
 *   ① 每一張不是 201／409／503 的下單：狀態碼、內容、traceId
 *   ② 每一個訂單服務、庫存服務的 pod 從起來到結束的日誌（每秒看一次有沒有新的 pod，有就 kubectl logs -f 存成檔）
 * 有 500 的話，拿它的 traceId 去兩邊的日誌找；沒有的話，就是 N 次都沒有。
 *
 *   mvn test -Pexperiments -Dtest=M12FiveHundredTest -Dm12.cycles=6        （約 12 分鐘）
 */
@Tag("experiment")
class M12FiveHundredTest {

    record Odd(long atMs, int status, String body, String traceId) {}

    final int rate = Integer.getInteger("m12.rate", 10), cycles = Integer.getInteger("m12.cycles", 6);
    final PrintStream out = System.out;
    final Path logs = Path.of("target", "m12-logs");

    @Test
    void fiveHundred() throws Exception {
        Kube.sh("rm", "-rf", logs.toString());
        Files.createDirectories(logs);
        try (ConfigurableApplicationContext keys = Keys.start()) {
            Mig.fresh();
            Mig.weights(0, 100);
            Mig.scale("monolith", 0);
            out.printf("═══ 9.6.5 那 1 張 500：M4 的切換（縮到 0、換設定、重開）來回 %d 次，每秒 %d 張下單不停 ═══%n", cycles, rate);
            AtomicBoolean stop = new AtomicBoolean();
            Thread followers = follow(stop);
            ConcurrentLinkedQueue<Odd> odd = new ConcurrentLinkedQueue<>();
            Map<Integer, AtomicLong> codes = new ConcurrentHashMap<>();
            Thread load = load(keys, stop, odd, codes);
            long t0 = System.nanoTime();
            Thread.sleep(15_000);
            for (int c = 1; c <= cycles; c++) {
                SplitLab.freshDatabase(Mig.INV_DB);
                Flyway.configure().dataSource(SplitLab.url(Mig.INV_DB), "shop_migrator", "shop_migrator")
                        .locations("classpath:db/migration/inventory", "classpath:db/migration/shared", "classpath:db/grants/inventory-service").load().migrate();
                Copier forward = new Copier(Mig.MONO_DB, Mig.INV_DB);
                forward.installCapture();
                for (String t : Copier.TABLES.keySet()) forward.backfill(t);
                while (forward.lag() > 0) { forward.apply(); Thread.sleep(100); }
                Copier[] back = new Copier[1];
                Cutover.Result go = Cutover.run(forward, Mig.INV_DB, "2", false, () -> { back[0] = new Copier(Mig.INV_DB, Mig.MONO_DB); back[0].installCapture(); return true; });
                forward.dropCapture();
                for (int i = 0; i < 100; i++) { back[0].apply(); Thread.sleep(100); }      // 切過去之後 10 秒
                Cutover.Result undo = Cutover.run(back[0], Mig.MONO_DB, "3", true, null);
                back[0].dropCapture();
                out.printf("  第 %d 次（第 %.0f 秒）：去 %s ／ 回 %s%n", c, (System.nanoTime() - t0) / 1e9, brief(go), brief(undo));
                Thread.sleep(10_000);
            }
            stop.set(true);
            load.join();
            followers.join();
            out.printf("  整段：下單 %s%n", new TreeMap<>(Map.copyOf(codes)).toString().replaceAll("(\\d+)=", "$1="));
            out.printf("  不是 201、409、503 的：%d 張%n", odd.size());
            for (Odd o : odd) {
                out.printf("    第 %.1f 秒 %d %s（traceId %s）%n", o.atMs / 1000.0, o.status, o.body.length() > 160 ? o.body.substring(0, 160) + "…" : o.body, o.traceId);
                if (o.traceId != null) for (String hit : grep(o.traceId)) out.printf("      日誌：%s%n", hit);
            }
            out.printf("  每一個 pod 的日誌裡的 ERROR（依 logger 與訊息分組）：%s%n", errors());
            out.printf("  （結束時 load %s）%n", SplitLab.load());
        }
    }

    static String brief(Cutover.Result r) {
        return String.format("停寫 %.1f 秒、關掉 %d 個洞", r.totalMs() / 1000.0, r.holesClosed());
    }

    /** 開放式負載：每秒 rate 張，每一張記狀態碼；不是 201、409、503 的連內容一起記 */
    Thread load(ConfigurableApplicationContext keys, AtomicBoolean stop, ConcurrentLinkedQueue<Odd> odd, Map<Integer, AtomicLong> codes) {
        ExecutorService pool = Executors.newVirtualThreadPerTaskExecutor();
        AtomicLong buyers = new AtomicLong(8_700_000 + ThreadLocalRandom.current().nextInt(100_000) * 10L);
        long t0 = System.nanoTime(), gap = 1_000_000_000L / rate;
        return Thread.ofPlatform().start(() -> {
            for (long i = 0; !stop.get(); i++) {
                long wait = t0 + i * gap - System.nanoTime();
                if (wait > 0) try { Thread.sleep(wait / 1_000_000, (int) (wait % 1_000_000)); } catch (InterruptedException e) { return; }
                long at = (System.nanoTime() - t0) / 1_000_000;
                pool.submit(() -> {
                    try {
                        Calls.Res r = Calls.place(Mig.ENTRY, TestTokens.bearer(keys, buyers.incrementAndGet()), M4DataSplitTest.anyProduct());
                        codes.computeIfAbsent(r.status(), k -> new AtomicLong()).incrementAndGet();
                        if (!Set.of(201, 409, 503).contains(r.status())) odd.add(new Odd(at, r.status(), r.body() == null ? "" : r.body(), r.traceId()));
                    } catch (Exception e) {
                        codes.computeIfAbsent(-1, k -> new AtomicLong()).incrementAndGet();
                        odd.add(new Odd(at, -1, e.toString(), null));
                    }
                });
            }
            pool.shutdown();
            try { pool.awaitTermination(90, java.util.concurrent.TimeUnit.SECONDS); } catch (InterruptedException ignored) { }
        });
    }

    /** 每秒看一次訂單服務、庫存服務有沒有新的 pod；有就 kubectl logs -f 存到 target/m12-logs/<pod>.log（pod 結束時 kubectl 自己會停） */
    Thread follow(AtomicBoolean stop) {
        Set<String> followed = ConcurrentHashMap.newKeySet();
        List<Process> ps = new ArrayList<>();
        return Thread.ofPlatform().start(() -> {
            while (!stop.get()) {
                try {
                    for (String app : List.of("order-service", "inventory-service"))
                        for (Kube.Pod p : Kube.pods(app))
                            if (followed.add(p.name()))
                                ps.add(new ProcessBuilder("kubectl", "--context", Kube.CTX, "-n", Kube.NS, "logs", "-f", p.name())
                                        .redirectErrorStream(true).redirectOutput(logs.resolve(p.name() + ".log").toFile()).start());
                    Thread.sleep(1_000);
                } catch (Exception e) { /* 下一秒再看 */ }
            }
            try { Thread.sleep(3_000); } catch (InterruptedException ignored) { }
            ps.forEach(Process::destroy);
        });
    }

    List<String> grep(String traceId) throws Exception {
        List<String> hits = new ArrayList<>();
        try (var files = Files.list(logs)) {
            for (Path f : files.toList())
                for (String l : Files.readAllLines(f))
                    if (l.contains(traceId)) {
                        String m = l;
                        try { var j = Calls.JSON.readTree(l); m = j.path("level").asText() + " " + j.path("logger_name").asText().replaceAll(".*\\.", "") + "：" + j.path("message").asText(); }
                        catch (Exception notJson) { /* 原樣 */ }
                        hits.add(f.getFileName().toString().replace(".log", "") + " │ " + (m.length() > 220 ? m.substring(0, 220) + "…" : m));
                    }
        }
        return hits;
    }

    Map<String, Long> errors() throws Exception {
        Map<String, Long> m = new TreeMap<>();
        try (var files = Files.list(logs)) {
            for (Path f : files.toList())
                for (String l : Files.readAllLines(f)) {
                    if (!l.contains("\"level\":\"ERROR\"")) continue;
                    String app = f.getFileName().toString().replaceAll("-[a-z0-9]+-[a-z0-9]+\\.log$", "");
                    try {
                        var j = Calls.JSON.readTree(l);
                        String msg = j.path("message").asText().replaceAll("\\d+", "N");
                        m.merge(app + " " + j.path("logger_name").asText().replaceAll(".*\\.", "") + "：" + (msg.length() > 80 ? msg.substring(0, 80) : msg), 1L, Long::sum);
                    } catch (Exception notJson) { m.merge(app + "（不是 JSON）", 1L, Long::sum); }
                }
        }
        return m;
    }
}
```

**`src/test/java/com/example/shop/dist09/M13DdlDeadlockTest.java`**（9.6.5）

```java
package com.example.shop.dist09;

import com.example.shop.dist00.SplitLab;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;

import java.io.PrintStream;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

/**
 * 13 站第 09 章寫完之後的追記（9.6.5）：M12 抓到的那一張 500 是 metadata lock 的死結。這裡量它為什麼會發生。
 * 一個預留的交易 T 做完前兩句（UPDATE inventory、INSERT inventory_reservations）停下來；另一條連線 D 對 inventory_ledger 下一句 DDL；
 * 一秒之後 T 做第三句 INSERT inventory_ledger。四種情境：
 *   A  照 M12 的樣子：inventory、inventory_reservations 已經裝了搬家程式的 trigger；D = CREATE TRIGGER ON inventory_ledger
 *   B  沒有任何 trigger；D 一樣
 *   C  inventory_ledger 拿掉外鍵（fk_ledger_inventory）；D 一樣
 *   D  沒有 trigger、外鍵在；D = ALTER TABLE inventory_ledger ADD COLUMN …, ALGORITHM=INSTANT（migration 在舊版還在接單時跑的那一種）
 * 每一種：T、D 各拿著（或在等）哪些 metadata lock（performance_schema.metadata_locks）、T 的第三句的結果、InnoDB 的死結計數有沒有動。
 *
 *   mvn test -Pexperiments -Dtest=M13DdlDeadlockTest        （不用 kind，只要 compose 的 MySQL；約 10 秒）
 */
@Tag("experiment")
class M13DdlDeadlockTest {

    static final String DB = "shop_d09_m13";
    final PrintStream out = System.out;

    @Test
    void ddlDuringReservation() throws Exception {
        out.printf("═══ 9.6.5 那一張 500：預留的交易做到一半，有人對 inventory_ledger 下 DDL ═══%n");
        run("A M12 的樣子（搬家程式的 trigger 已經裝在 inventory、inventory_reservations；外鍵在）", true, true,
                "CREATE TRIGGER m13_ledger AFTER INSERT ON inventory_ledger FOR EACH ROW INSERT INTO d02_changes (tbl, pk) VALUES ('inventory_ledger', NEW.id)");
        run("B 沒有 trigger、外鍵在", false, true,
                "CREATE TRIGGER m13_ledger AFTER INSERT ON inventory_ledger FOR EACH ROW INSERT INTO d02_changes (tbl, pk) VALUES ('inventory_ledger', NEW.id)");
        run("C 有 trigger、inventory_ledger 沒有外鍵", true, false,
                "CREATE TRIGGER m13_ledger AFTER INSERT ON inventory_ledger FOR EACH ROW INSERT INTO d02_changes (tbl, pk) VALUES ('inventory_ledger', NEW.id)");
        run("D 沒有 trigger、外鍵在；DDL 換成 ALTER TABLE … ALGORITHM=INSTANT", false, true,
                "ALTER TABLE inventory_ledger ADD COLUMN m13 INT NULL, ALGORITHM=INSTANT");
        out.printf("  （結束時 load %s）%n", SplitLab.load());
    }

    void run(String name, boolean triggers, boolean foreignKey, String ddl) throws Exception {
        SplitLab.freshDatabase(DB);
        Flyway.configure().dataSource(SplitLab.url(DB), "shop_migrator", "shop_migrator")
                .locations("classpath:db/migration/inventory", "classpath:db/migration/shared").load().migrate();
        long product = 9_130_001;
        try (Connection c = SplitLab.root(DB); Statement s = c.createStatement()) {
            s.execute("INSERT INTO inventory (product_id, on_hand, reserved) VALUES (" + product + ", 10, 0)");
            s.execute("CREATE TABLE d02_changes (seq BIGINT NOT NULL AUTO_INCREMENT, tbl VARCHAR(40) NOT NULL, pk BIGINT NOT NULL, PRIMARY KEY (seq))");
            if (triggers) {                                                 // 搬家程式（Copier.installTriggers）照 TABLES 的順序裝：inventory、inventory_reservations 先
                s.execute("CREATE TRIGGER m13_inv AFTER UPDATE ON inventory FOR EACH ROW INSERT INTO d02_changes (tbl, pk) VALUES ('inventory', NEW.product_id)");
                s.execute("CREATE TRIGGER m13_res AFTER INSERT ON inventory_reservations FOR EACH ROW INSERT INTO d02_changes (tbl, pk) VALUES ('inventory_reservations', NEW.id)");
            }
            if (!foreignKey) s.execute("ALTER TABLE inventory_ledger DROP FOREIGN KEY fk_ledger_inventory");
        }
        out.printf("  %s%n", name);
        ExecutorService pool = Executors.newSingleThreadExecutor();
        try (Connection t = SplitLab.root(DB); Connection d = SplitLab.root(DB); Connection look = SplitLab.root("")) {
            t.setAutoCommit(false);
            long tId = connectionId(t), dId = connectionId(d);
            try (Statement s = t.createStatement()) {                     // JdbcInventoryService.reserveCounted 的前兩句
                s.executeUpdate("UPDATE inventory SET reserved = reserved + 1, version = version + 1, updated_at = CURRENT_TIMESTAMP(3) WHERE product_id = " + product);
                s.executeUpdate("INSERT INTO inventory_reservations (order_id, product_id, quantity, status) VALUES (1, " + product + ", 1, 'HELD')");
            }
            out.printf("    T 做完 UPDATE inventory、INSERT inventory_reservations，拿著：%s%n", locks(look, tId));
            Future<String> ddlDone = pool.submit(() -> {
                long t0 = System.nanoTime();
                try (Statement s = d.createStatement()) {
                    s.execute(ddl);
                    return "做完（" + (System.nanoTime() - t0) / 1_000_000 + " ms）";
                } catch (SQLException e) {
                    return "失敗（" + (System.nanoTime() - t0) / 1_000_000 + " ms）：" + e.getErrorCode() + " " + e.getMessage();
                }
            });
            Thread.sleep(1_000);
            out.printf("    D 送出 1 秒後：%s；拿著／在等：%s%n", ddlDone.isDone() ? ddlDone.get() : "還在等", locks(look, dId));
            long innodb0 = innodbDeadlocks(look);
            String third;
            try (Statement s = t.createStatement()) {
                s.executeUpdate("INSERT INTO inventory_ledger (product_id, delta_on_hand, delta_reserved, reason, ref) VALUES (" + product + ", 0, 1, 'RESERVE', 'order:1')");
                third = "成功";
                t.commit();
            } catch (SQLException e) {
                third = e.getErrorCode() + " " + e.getMessage();
                t.rollback();
            }
            out.printf("    T 的第三句 INSERT inventory_ledger：%s；D：%s；InnoDB 的死結計數 %d → %d%n", third, ddlDone.get(30, TimeUnit.SECONDS), innodb0, innodbDeadlocks(look));
        } finally {
            pool.shutdownNow();
        }
    }

    static long connectionId(Connection c) throws SQLException {
        try (Statement s = c.createStatement(); ResultSet rs = s.executeQuery("SELECT CONNECTION_ID()")) { rs.next(); return rs.getLong(1); }
    }

    /** 這條連線在這個庫裡的 metadata lock：表名 鎖的種類（不是 GRANTED 的標出來）；同一個重複的只列一次 */
    static String locks(Connection look, long connection) throws SQLException {
        List<String> out = new ArrayList<>();
        try (PreparedStatement ps = look.prepareStatement("""
                SELECT m.OBJECT_NAME, m.LOCK_TYPE, m.LOCK_STATUS FROM performance_schema.metadata_locks m
                  JOIN performance_schema.threads th ON th.THREAD_ID = m.OWNER_THREAD_ID
                 WHERE th.PROCESSLIST_ID = ? AND m.OBJECT_SCHEMA = ? AND m.OBJECT_TYPE = 'TABLE' ORDER BY m.OBJECT_NAME, m.LOCK_TYPE""")) {
            ps.setLong(1, connection);
            ps.setString(2, DB);
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    String l = rs.getString(1) + " " + rs.getString(2) + (rs.getString(3).equals("GRANTED") ? "" : "（" + rs.getString(3) + "）");
                    if (!out.contains(l)) out.add(l);
                }
            }
        }
        return out.isEmpty() ? "（沒有）" : String.join("、", out);
    }

    static long innodbDeadlocks(Connection look) throws SQLException {
        try (Statement s = look.createStatement(); ResultSet rs = s.executeQuery("SELECT count FROM information_schema.INNODB_METRICS WHERE name = 'lock_deadlocks'")) {
            rs.next();
            return rs.getLong(1);
        }
    }
}
```

**`src/test/java/com/example/shop/dist07/H7AlertRoutingTest.java`**（第 07 章 7.11.1）

```java
package com.example.shop.dist07;

import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;

import java.io.PrintStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.TimeUnit;

/**
 * 13 站第 09 章寫完之後的追記（第 07 章 7.11.1、第 08 章 8.9.1）：Alertmanager 的分組與抑制。
 * 一台 Alertmanager（compose 的同一個映像檔）、一個收件人（docker/alertmanager/sink.py），直接把告警送進 Alertmanager 的 API ——
 * 不經過 Prometheus：這裡要量的是「同樣的告警，Alertmanager 送出幾則通知、開了幾張單（groupKey）」，時間照兩次演練實際的順序：
 *   A：7.11 的演練 —— ShopConsumerLag 先 firing，145 秒後 ShopPlaceOrderSlow 也 firing（演練裡是 290 秒與 435 秒）；都解除
 *   B：8.9.1 compose 上單體停掉 —— ShopDown{job=shop} 與 ShopServiceGone{job=shop} 一起 firing
 * 兩份設定各跑一次：第 09 章結束時的（照 alertname 分組、沒有抑制）與現在的（照 severity 分組、ShopServiceGone 抑制同一個 job 的 ShopDown）。
 *
 *   mvn test -Pexperiments -Dtest=H7AlertRoutingTest        （約 11 分鐘）
 */
@Tag("experiment")
class H7AlertRoutingTest {

    static final int PORT = 19093;
    final PrintStream out = System.out;
    final HttpClient http = HttpClient.newHttpClient();

    @Test
    void routing() throws Exception {
        Path dir = Path.of("target", "h7").toAbsolutePath();
        Files.createDirectories(dir.resolve("before"));
        Files.createDirectories(dir.resolve("after"));
        Files.writeString(dir.resolve("before/alertmanager.yml"), sh("git", "show", System.getProperty("h7.before", "9a5e7b1") + ":docker/alertmanager/alertmanager.yml"));
        Files.copy(Path.of("docker/alertmanager/alertmanager.yml"), dir.resolve("after/alertmanager.yml"), java.nio.file.StandardCopyOption.REPLACE_EXISTING);
        out.printf("═══ 7.11.1／8.9.1 Alertmanager 的分組與抑制：同樣的告警，送出幾則通知、開了幾張單（groupKey）═══%n");
        for (String which : List.of("before", "after")) {
            out.printf("  %s%n", which.equals("before") ? "第 09 章結束時的設定（group_by: [alertname]，沒有 inhibit_rules）" : "現在的設定（group_by: [severity]；ShopServiceGone 抑制同一個 job 的 ShopDown）");
            for (String scenario : List.of("A", "B")) {
                start(dir.resolve(which));
                try {
                    if (scenario.equals("A")) {
                        post("ShopConsumerLag", Map.of("consumer", "inventory.hot-settlement"), null);
                        Thread.sleep(145_000);
                        post("ShopPlaceOrderSlow", Map.of(), null);
                        Thread.sleep(75_000);
                        post("ShopConsumerLag", Map.of("consumer", "inventory.hot-settlement"), Instant.now());
                        post("ShopPlaceOrderSlow", Map.of(), Instant.now());
                        Thread.sleep(75_000);
                    } else {
                        post("ShopDown", Map.of("job", "shop"), null);
                        post("ShopServiceGone", Map.of("job", "shop"), null);
                        Thread.sleep(20_000);
                    }
                    out.printf("    %s %s%n", scenario.equals("A") ? "A（下單變慢 + 事件積壓）：" : "B（單體停掉）：", summary(sh("docker", "logs", "h7-sink")));
                } finally {
                    stop();
                }
            }
        }
    }

    /** 收件人的每一行是一則通知裡的一條告警：依（收到的時間、groupKey）分出「幾則通知」，groupKey 有幾個就是「幾張單」 */
    static String summary(String log) throws Exception {
        Map<String, List<String>> notifications = new LinkedHashMap<>();
        Set<String> groups = new LinkedHashSet<>();
        for (String line : log.split("\n")) {
            if (!line.startsWith("{")) continue;
            JsonNode j = Calls.JSON.readTree(line);
            groups.add(j.path("groupKey").asText());
            notifications.computeIfAbsent(j.path("received").asText() + " " + j.path("groupKey").asText(), k -> new ArrayList<>())
                    .add(j.path("alertname").asText() + "（" + j.path("status").asText() + "）");
        }
        List<String> each = new ArrayList<>();
        int i = 1;
        for (var e : notifications.entrySet()) each.add("#" + i++ + " " + e.getValue());
        long firingNotifications = notifications.values().stream().filter(v -> v.stream().anyMatch(s -> s.contains("firing"))).count();
        return String.format("通知 %d 則（其中有 firing 的 %d 則）、單 %d 張：%s", notifications.size(), firingNotifications, groups.size(), String.join("；", each));
    }

    void post(String alertname, Map<String, String> extra, Instant endsAt) throws Exception {
        Map<String, String> labels = new LinkedHashMap<>(Map.of("alertname", alertname, "severity", "page"));
        labels.putAll(extra);
        StringBuilder b = new StringBuilder("[{\"labels\":").append(Calls.JSON.writeValueAsString(labels))
                .append(",\"annotations\":{\"summary\":\"").append(alertname).append("\"}");
        if (endsAt != null) b.append(",\"endsAt\":\"").append(endsAt).append("\"");
        b.append("}]");
        HttpResponse<String> r = http.send(HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + PORT + "/api/v2/alerts")).header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(b.toString())).build(), HttpResponse.BodyHandlers.ofString());
        if (r.statusCode() != 200) throw new IllegalStateException(r.statusCode() + " " + r.body());
    }

    void start(Path config) throws Exception {
        stop();
        sh("docker", "network", "create", "h7net");
        sh("docker", "run", "-d", "--name", "h7-sink", "--network", "h7net", "--network-alias", "alert-sink",
                "-v", Path.of("docker/alertmanager/sink.py").toAbsolutePath() + ":/sink/sink.py:ro", "python:3.12-alpine", "python", "/sink/sink.py");
        sh("docker", "run", "-d", "--name", "h7-alertmanager", "--network", "h7net", "-p", PORT + ":9093", "-v", config + ":/etc/alertmanager:ro", "prom/alertmanager:v0.28.1");
        for (int i = 0; i < 60; i++) {
            try {
                if (http.send(HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + PORT + "/-/ready")).build(), HttpResponse.BodyHandlers.discarding()).statusCode() == 200) return;
            } catch (Exception notYet) { /* 還沒起來 */ }
            Thread.sleep(500);
        }
        throw new IllegalStateException("Alertmanager 沒有起來");
    }

    void stop() throws Exception {
        shAny("docker", "rm", "-f", "h7-alertmanager", "h7-sink");
        shAny("docker", "network", "rm", "h7net");
    }

    static String sh(String... cmd) throws Exception {
        Process p = new ProcessBuilder(cmd).redirectErrorStream(true).start();
        String out = new String(p.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
        if (!p.waitFor(5, TimeUnit.MINUTES) || p.exitValue() != 0) throw new IllegalStateException(String.join(" ", cmd) + "：" + out);
        return out;
    }

    static void shAny(String... cmd) throws Exception {
        Process p = new ProcessBuilder(cmd).redirectErrorStream(true).start();
        p.getInputStream().readAllBytes();
        p.waitFor(5, TimeUnit.MINUTES);
    }
}
```

**`src/test/java/com/example/shop/dist08/K12TailSamplingTest.java`**（第 07 章 7.8.4）

```java
package com.example.shop.dist08;

import com.example.shop.dist00.SplitLab;
import com.example.shop.dist07.Calls;
import com.example.shop.dist07.Keys;
import com.example.shop.dist09.Mig;
import com.example.shop.support.TestTokens;
import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.context.ConfigurableApplicationContext;

import java.io.PrintStream;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ThreadLocalRandom;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;

/**
 * 13 站第 09 章寫完之後的追記（第 07 章 7.8.4、第 08 章 8.9.2）：尾端抽樣。第 07 章 7.8.3 說頭端抽樣「出事的那幾張剛好沒被抽到」——
 * 這裡量它：同一個負載跑兩次，一次頭端（入口抽 10%，後面照著它），一次尾端（每一個都送 100%，Collector 的 tail_sampling 決定）。
 *
 * 負載：每秒 R 張下單，全部走訂單服務 → 庫存服務（權重 0／100、單體縮到 0）。三種商品：
 *   慢的（10%）：庫存的預留那一句多 0.6 秒（單體的庫上的 trigger：DO SLEEP）
 *   錯的（5%）：預留那一句被拒絕（trigger：SIGNAL）→ 庫存服務 500 → 買家 5xx
 *   其他（85%）
 * 每一張記下回應的 X-Trace-Id；跑完等 30 秒（decision_wait 10 秒＋送出），到 Jaeger 一條一條查：三種各找得到幾成。
 * 另外記 Collector 收到、送出的 span 數（它自己的 :8888 指標）與記憶體。
 *
 *   mvn test -Pexperiments -Dtest=K12TailSamplingTest        （約 9 分鐘）
 */
@Tag("experiment")
class K12TailSamplingTest {

    static final long SLOW = SplitLab.FIRST_PRODUCT + 10, ERROR = SplitLab.FIRST_PRODUCT + 20;
    static final int JAEGER = 18886;

    record Sent(long product, int status, long millis, String traceId) {
        String kind() { return product == SLOW ? "慢的" : product == ERROR ? "錯的" : "其他"; }
    }

    final int rate = Integer.getInteger("k12.rate", 10), seconds = Integer.getInteger("k12.seconds", 60);
    final PrintStream out = System.out;

    @Test
    void tailSampling() throws Exception {
        try (ConfigurableApplicationContext keys = Keys.start()) {
            Mig.fresh();
            Mig.weights(0, 100);
            Mig.scale("monolith", 0);
            Mig.sql(Mig.MONO_DB,
                    "DROP TRIGGER IF EXISTS k12_slow_or_fail",
                    "CREATE TRIGGER k12_slow_or_fail BEFORE INSERT ON inventory_reservations FOR EACH ROW BEGIN "
                            + "IF NEW.product_id = " + SLOW + " THEN DO SLEEP(0.6); END IF; "
                            + "IF NEW.product_id = " + ERROR + " THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'K12：模擬預留失敗'; END IF; END");
            out.printf("═══ 7.8.4／8.9.2 尾端抽樣：每秒 %d 張下單、%d 秒；慢的 10%%（預留 +0.6 秒）、錯的 5%%（預留被拒絕）、其他 85%% ═══%n", rate, seconds);
            try {
                out.printf("  ① 頭端抽樣（入口 10%%，後面的服務照著它）%n");
                run(keys);

                Kube.sh("kubectl", "--context", Kube.CTX, "apply", "-f", "k8s/lab/otel-collector-tail.yaml");
                Kube.sh("kubectl", "--context", Kube.CTX, "-n", "observability", "rollout", "restart", "deploy/otel-collector");
                Kube.sh("kubectl", "--context", Kube.CTX, "-n", "observability", "rollout", "status", "deploy/otel-collector", "--timeout=180s");
                Kube.kubectl("patch", "envoyproxy/shop-edge", "--type=merge", "-p", "{\"spec\":{\"telemetry\":{\"tracing\":{\"samplingRate\":100}}}}");
                Kube.kubectl("set", "env", "deploy/order-service", "deploy/inventory-service", "MANAGEMENT_TRACING_SAMPLING_PROBABILITY=1.0");
                for (String d : List.of("order-service", "inventory-service")) Kube.kubectl("rollout", "status", "deploy/" + d, "--timeout=300s");
                Kube.waitFor(() -> Mig.settled("order-service") && Mig.settled("inventory-service"), 120);
                Thread.sleep(10_000);
                out.printf("  ② 尾端抽樣（入口、服務都送 100%%；Collector 的 tail_sampling：錯的、超過 500 ms 的全留，其他抽 10%%）%n");
                run(keys);
            } finally {
                Mig.sql(Mig.MONO_DB, "DROP TRIGGER IF EXISTS k12_slow_or_fail");
                Kube.sh("sh", "-c", "kubectl kustomize --load-restrictor LoadRestrictionsNone k8s/observability | kubectl --context " + Kube.CTX + " apply -f -");
                Kube.sh("kubectl", "--context", Kube.CTX, "-n", "observability", "rollout", "restart", "deploy/otel-collector");
                Kube.sh("kubectl", "--context", Kube.CTX, "apply", "-k", "k8s/gateway");
                Kube.kubectl("set", "env", "deploy/order-service", "deploy/inventory-service", "MANAGEMENT_TRACING_SAMPLING_PROBABILITY-");
            }
            out.printf("  （結束時 load %s）%n", SplitLab.load());
        }
    }

    void run(ConfigurableApplicationContext keys) throws Exception {
        double[] c0 = collector();
        ConcurrentLinkedQueue<Sent> sent = new ConcurrentLinkedQueue<>();
        AtomicLong buyers = new AtomicLong(8_600_000 + ThreadLocalRandom.current().nextInt(100_000) * 10L);
        ExecutorService pool = Executors.newVirtualThreadPerTaskExecutor();
        long t0 = System.nanoTime(), gap = 1_000_000_000L / rate;
        for (long i = 0; i < (long) rate * seconds; i++) {
            long wait = t0 + i * gap - System.nanoTime();
            if (wait > 0) Thread.sleep(wait / 1_000_000, (int) (wait % 1_000_000));
            double u = ThreadLocalRandom.current().nextDouble();
            long product = u < 0.10 ? SLOW : u < 0.15 ? ERROR : SplitLab.FIRST_PRODUCT + 100 + ThreadLocalRandom.current().nextInt(900);
            pool.submit(() -> {
                try {
                    Calls.Res r = Calls.place(Mig.ENTRY, TestTokens.bearer(keys, buyers.incrementAndGet()), product);
                    sent.add(new Sent(product, r.status(), r.millis(), r.traceId()));
                } catch (Exception e) {
                    sent.add(new Sent(product, -1, -1, null));
                }
            });
        }
        pool.shutdown();
        pool.awaitTermination(90, TimeUnit.SECONDS);
        Thread.sleep(30_000);                                                 // decision_wait 10 秒、batch、Jaeger 寫進去
        double[] c1 = collector();

        Map<String, long[]> found = new TreeMap<>();                          // 種類 → {送出, 有 traceId, Jaeger 找得到, 其中整條 trace 超過 500 ms、請求本身沒有}
        Map<String, Map<Integer, Long>> codes = new TreeMap<>();
        long spans = 0;
        for (Sent s : sent) {
            long[] f = found.computeIfAbsent(s.kind(), k -> new long[4]);
            f[0]++;
            codes.computeIfAbsent(s.kind(), k -> new TreeMap<>()).merge(s.status(), 1L, Long::sum);
            if (s.traceId() == null) continue;
            f[1]++;
            JsonNode t = trace(s.traceId());
            if (t == null) continue;
            f[2]++;
            spans += t.path("spans").size();
            long first = Long.MAX_VALUE, last = 0;                            // Jaeger 的 startTime、duration 是微秒
            for (JsonNode sp : t.path("spans")) { first = Math.min(first, sp.path("startTime").asLong()); last = Math.max(last, sp.path("startTime").asLong() + sp.path("duration").asLong()); }
            if ((last - first) / 1000 > 500 && s.millis() <= 500) f[3]++;
        }
        for (var e : found.entrySet()) {
            long[] f = e.getValue();
            out.printf("    %s │ %4d 張 %s │ Jaeger 找得到 %4d 條（%5.1f%%）；其中請求在 500 ms 以內、整條 trace 卻超過 500 ms 的 %d 條%n",
                    e.getKey(), f[0], codes.get(e.getKey()), f[2], 100.0 * f[2] / Math.max(1, f[1]), f[3]);
        }
        out.printf("    Jaeger 裡這幾條 trace 共 %,d 個 span；Collector 收到 %,.0f 個 span、送出 %,.0f 個；Collector 的記憶體 %s%n",
                spans, c1[0] - c0[0], c1[1] - c0[1], collectorMemory());
    }

    /** 一條 trace（Jaeger v2 的 /api/traces/{id}，第 08 章 8.4.5 的 📌）；找不到 → null */
    static JsonNode trace(String id) {
        try {
            JsonNode d = Calls.JSON.readTree(Kube.sh("curl", "-s", "http://127.0.0.1:" + JAEGER + "/api/traces/" + id)).path("data");
            return d.isArray() && d.size() > 0 ? d.get(0) : null;
        } catch (Exception e) {
            return null;
        }
    }

    /** Collector 自己的指標：收到的 span、送出的 span（加總每一個 receiver／exporter） */
    static double[] collector() throws Exception {
        String pod = Kube.sh("kubectl", "--context", Kube.CTX, "-n", "observability", "get", "pods", "-l", "app=otel-collector", "-o", "jsonpath={.items[0].metadata.name}").trim();
        String m = Kube.sh("kubectl", "--context", Kube.CTX, "get", "--raw", "/api/v1/namespaces/observability/pods/" + pod + ":8888/proxy/metrics");
        return new double[]{total(m, "otelcol_receiver_accepted_spans"), total(m, "otelcol_exporter_sent_spans")};
    }

    static double total(String metrics, String name) {
        return metrics.lines().filter(l -> l.startsWith(name + "{") || l.startsWith(name + "_total{") || l.startsWith(name + " ") || l.startsWith(name + "_total "))
                .mapToDouble(l -> Double.parseDouble(l.substring(l.lastIndexOf(' ') + 1))).sum();
    }

    static String collectorMemory() throws Exception {
        JsonNode s = Calls.JSON.readTree(Kube.sh("kubectl", "--context", Kube.CTX, "get", "--raw", "/api/v1/nodes/d08-control-plane/proxy/stats/summary"));
        List<String> out = new ArrayList<>();
        for (JsonNode p : s.path("pods"))
            if (p.path("podRef").path("name").asText().startsWith("otel-collector"))
                for (JsonNode c : p.path("containers")) out.add(c.path("memory").path("workingSetBytes").asLong() / 1_048_576 + " MiB");
        return String.join("、", out);
    }
}
```

**`src/test/java/com/example/shop/dist08/K13MultiNodeTest.java`**（第 08 章 8.6.6）

```java
package com.example.shop.dist08;

import com.example.shop.dist07.Calls;
import com.example.shop.dist07.Keys;
import com.example.shop.dist09.Mig;
import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.context.ConfigurableApplicationContext;

import java.io.PrintStream;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 13 站第 09 章寫完之後的追記（第 08 章 8.6.6）：三個 node（k8s/kind/cluster-3nodes.yaml）。8.6.4 在一個 node 上量滾動更新，有沒有 preStop 都是 0 個錯，
 * 推論的原因之一是「kube-proxy 就在同一台」；也說「多個 node 的時候，別台的 kube-proxy 也比較晚知道」—— 沒有量。這裡量：
 *
 *   ⓪ 訂單服務釘在 worker 1、庫存服務的 2 台釘在 worker 2：每一個預留都跨 node
 *   ① 刪掉一台庫存服務的 pod：EndpointSlice 拿掉它、每一個 node 的 iptables 拿掉它，各在第幾毫秒（每 50 ms 問一次）
 *   ② K3 的滾動更新（每秒 R 張下單）：舊的 pod 有 preStop；③ 拿掉 preStop 再量一次
 * 權重 0／100（下單全部走訂單服務）、單體縮到 0。
 * ⚠️ 入口的 Service 是 externalTrafficPolicy: Local（Envoy Gateway 1.9.1 的預設）：從控制面的 NodePort 進來的，只送給控制面上的 Envoy ——
 * 控制面有 taint，Envoy 在 worker 上，第一次跑每一張下單都連不上（-1），實驗卻照樣跑完。這裡先改成 Cluster、結束時拿掉，並且暖身沒有 201 就停
 * ⚠️ 預留的結果與「沒有回應的送出」是經過 API server 的 pod proxy 讀訂單服務的 8081（Kube.metrics）。NetworkPolicy 只讓 observability 連 8081：
 * 一個 node 的時候 proxy 從同一台 node 連進來、不受限制；三個 node 的時候它從控制面連到 worker 上的 pod —— 被擋，讀到的是 null，印出來是 {} 與 0 次。
 * 這裡跑的時候多加一條 NetworkPolicy（node 連得到 8081）、結束時刪掉，並且暖身之後讀不到就停
 *
 *   mvn test -Pexperiments -Dtest=K13MultiNodeTest -Dk3.rate=10        （約 6 分鐘）
 */
@Tag("experiment")
class K13MultiNodeTest {

    final int rate = Integer.getInteger("k3.rate", 10);                    // 跟 K3RolloutTest 讀同一個、預設也一樣（第一版讀 k13.rate：-Dk3.rate=10 的時候，暖身與標題是 30、滾動更新是 10）
    final PrintStream out = System.out;

    @Test
    void multiNode() throws Exception {
        List<String> workers = new ArrayList<>();
        for (JsonNode n : Calls.JSON.readTree(Kube.sh("kubectl", "--context", Kube.CTX, "get", "nodes", "-o", "json")).path("items"))
            if (!n.path("metadata").path("labels").has("node-role.kubernetes.io/control-plane")) workers.add(n.path("metadata").path("name").asText());
        if (workers.size() < 2) throw new IllegalStateException("要兩個 worker（k8s/kind/cluster-3nodes.yaml），現在：" + workers);
        entryPolicy("Cluster");
        metricsFromNodes(true);
        try (ConfigurableApplicationContext keys = Keys.start()) {
            Mig.fresh();
            Mig.weights(0, 100);
            Mig.scale("monolith", 0);
            pin("order-service", workers.get(0));
            pin("inventory-service", workers.get(1));
            out.printf("═══ 8.6.6 三個 node：訂單服務在 %s、庫存服務在 %s；每秒 %d 張下單 ═══%n", workers.get(0), workers.get(1), rate);
            out.printf("  ⓪ pod 在哪裡：%s；入口的 Envoy：%s（入口的 Service 改成 externalTrafficPolicy: Cluster）%n", where(), envoyNode());
            try (Load warm = Load.start(keys, Kube.ENTRY, rate)) {
                warm.until(20);
                if (warm.codes(0, Long.MAX_VALUE).getOrDefault(201, 0L) == 0)
                    throw new IllegalStateException("暖身的 20 秒一張 201 都沒有，入口連不上：" + Load.fmt(warm.codes(0, Long.MAX_VALUE)));
            }
            if (Kube.reserveOutcomes().isEmpty()) throw new IllegalStateException("讀不到訂單服務的預留指標（Kube.metrics）");

            out.printf("  ① 刪掉一台庫存服務的 pod（沒有負載）：%s%n", propagation());
            Kube.kubectl("rollout", "status", "deploy/inventory-service", "--timeout=300s");
            Kube.waitFor(() -> Mig.settled("inventory-service"), 120);

            K3RolloutTest k3 = new K3RolloutTest();
            k3.measure(keys, "② 舊的 pod 有 preStop: sleep 10");
            Kube.kubectl("patch", "deploy/inventory-service", "--type=json", "-p", "[{\"op\":\"remove\",\"path\":\"/spec/template/spec/containers/0/lifecycle\"}]");
            Kube.kubectl("rollout", "status", "deploy/inventory-service", "--timeout=300s");
            Kube.waitFor(() -> Mig.settled("inventory-service"), 120);
            k3.measure(keys, "③ 舊的 pod 沒有 preStop");
        } finally {
            entryPolicy(null);
            metricsFromNodes(false);
            for (String d : List.of("order-service", "inventory-service"))           // kubectl apply 不會拿掉 patch 加上去的欄位（8.7.1）
                Kube.shAny("kubectl", "--context", Kube.CTX, "-n", Kube.NS, "patch", "deploy/" + d, "--type=json", "-p", "[{\"op\":\"remove\",\"path\":\"/spec/template/spec/nodeSelector\"}]");
            Mig.script("deploy");
        }
    }

    /** 入口的 Service 的 externalTrafficPolicy（EnvoyProxy shop-edge，k8s/gateway）：null = 拿掉，回到預設的 Local */
    static void entryPolicy(String policy) throws Exception {
        if (policy != null)
            Kube.kubectl("patch", "envoyproxy/shop-edge", "--type=merge", "-p", "{\"spec\":{\"provider\":{\"kubernetes\":{\"envoyService\":{\"externalTrafficPolicy\":\"" + policy + "\"}}}}}");
        else
            Kube.shAny("kubectl", "--context", Kube.CTX, "-n", Kube.NS, "patch", "envoyproxy/shop-edge", "--type=json", "-p", "[{\"op\":\"remove\",\"path\":\"/spec/provider/kubernetes/envoyService/externalTrafficPolicy\"}]");
        String want = policy == null ? "Local" : policy;
        Kube.waitFor(() -> Kube.sh("kubectl", "--context", Kube.CTX, "-n", "envoy-gateway-system", "get", "svc", "-l", "gateway.envoyproxy.io/owning-gateway-name=shop",
                "-o", "jsonpath={.items[0].spec.externalTrafficPolicy}").trim().equals(want), 60);
    }

    /** 跑的時候讓 node（API server 的 pod proxy）連得到兩個服務的 8081；NetworkPolicy 是加起來的，結束時刪掉這一條就回到原本的 */
    static void metricsFromNodes(boolean on) throws Exception {
        if (!on) {
            Kube.shAny("kubectl", "--context", Kube.CTX, "-n", Kube.NS, "delete", "networkpolicy", "k13-metrics-from-nodes", "--ignore-not-found");
            return;
        }
        java.nio.file.Path f = java.nio.file.Path.of("target", "k13-metrics-from-nodes.yaml");
        java.nio.file.Files.createDirectories(f.getParent());
        java.nio.file.Files.writeString(f, """
                apiVersion: networking.k8s.io/v1
                kind: NetworkPolicy
                metadata: {name: k13-metrics-from-nodes}
                spec:
                  podSelector: {matchExpressions: [{key: app, operator: In, values: [order-service, inventory-service]}]}
                  policyTypes: [Ingress]
                  ingress:
                    - from: [{ipBlock: {cidr: 0.0.0.0/0}}]
                      ports: [{port: 8081}]
                """);
        Kube.kubectl("apply", "-f", f.toString());
    }

    static String envoyNode() throws Exception {
        return Kube.sh("kubectl", "--context", Kube.CTX, "-n", "envoy-gateway-system", "get", "pods", "-l", "gateway.envoyproxy.io/owning-gateway-name=shop",
                "-o", "jsonpath={.items[*].spec.nodeName}").trim();
    }

    void pin(String app, String node) throws Exception {
        Kube.kubectl("patch", "deploy/" + app, "-p", "{\"spec\":{\"template\":{\"spec\":{\"nodeSelector\":{\"kubernetes.io/hostname\":\"" + node + "\"}}}}}");
        Kube.kubectl("rollout", "status", "deploy/" + app, "--timeout=300s");
        Kube.waitFor(() -> Mig.settled(app), 120);
    }

    static Map<String, String> where() throws Exception {
        Map<String, String> m = new LinkedHashMap<>();
        for (JsonNode p : Calls.JSON.readTree(Kube.kubectl("get", "pods", "-o", "json")).path("items")) {
            String name = p.path("metadata").path("name").asText();
            if (name.startsWith("migrate")) continue;
            m.put(name, p.path("spec").path("nodeName").asText());
        }
        return m;
    }

    /** 刪一台庫存服務的 pod，從 kubectl delete 送出開始算：EndpointSlice 裡它變成不 ready、每一個 node 的 iptables（nat 表）裡它的 IP 不見了 */
    String propagation() throws Exception {
        Kube.Pod victim = Kube.pods("inventory-service").get(0);
        List<String> nodes = new ArrayList<>();
        for (JsonNode n : Calls.JSON.readTree(Kube.sh("kubectl", "--context", Kube.CTX, "get", "nodes", "-o", "json")).path("items")) nodes.add(n.path("metadata").path("name").asText());
        for (String n : nodes)                                                 // 先確認找得到：kube-proxy 如果是 nftables 模式，iptables 裡本來就沒有它
            if (!Kube.shAny("docker", "exec", n, "sh", "-c", "iptables-save -t nat").contains(victim.ip() + ":"))
                return n + " 的 iptables 裡本來就找不到 " + victim.ip() + "（kube-proxy：" + proxyMode() + "）—— 量不了";
        Map<String, Long> gone = new LinkedHashMap<>();
        long t0 = System.nanoTime();
        Process delete = new ProcessBuilder("kubectl", "--context", Kube.CTX, "-n", Kube.NS, "delete", "pod", victim.name(), "--wait=false")
                .redirectErrorStream(true).redirectOutput(ProcessBuilder.Redirect.DISCARD).start();
        while (gone.size() < nodes.size() + 1 && System.nanoTime() - t0 < 60_000_000_000L) {
            if (!gone.containsKey("EndpointSlice") && !Kube.endpoints("inventory-service").contains(victim.name()))
                gone.put("EndpointSlice", (System.nanoTime() - t0) / 1_000_000);
            for (String n : nodes)
                if (!gone.containsKey(n) && !Kube.shAny("docker", "exec", n, "sh", "-c", "iptables-save -t nat").contains(victim.ip() + ":"))
                    gone.put(n, (System.nanoTime() - t0) / 1_000_000);
            Thread.sleep(50);
        }
        delete.waitFor();
        List<String> parts = new ArrayList<>();
        gone.forEach((k, v) -> parts.add(k + " " + v + " ms"));
        return victim.name() + "（" + victim.ip() + "）→ " + String.join("、", parts) + "（kube-proxy：" + proxyMode() + "）";
    }

    static String proxyMode() throws Exception {
        String cm = Kube.shAny("kubectl", "--context", Kube.CTX, "-n", "kube-system", "get", "configmap", "kube-proxy", "-o", "jsonpath={.data.config\\.conf}");
        return cm.lines().filter(l -> l.trim().startsWith("mode:")).map(String::trim).findFirst().orElse("mode 沒有寫");
    }
}
```

**`src/test/java/com/example/shop/dist08/K14ConfigGeneratorTest.java`**（第 08 章 8.7.3）

```java
package com.example.shop.dist08;

import com.example.shop.dist07.Calls;
import com.example.shop.dist07.Keys;
import com.example.shop.dist09.Mig;
import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.context.ConfigurableApplicationContext;

import java.io.PrintStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * 13 站第 09 章寫完之後的追記（第 08 章 8.7.3）：configMapGenerator。8.7.2 說「kubectl rollout undo 換回的是 pod 的樣板，不包括 ConfigMap 的內容」——
 * 這裡量它，再量 kustomize 的 configMapGenerator（名字帶內容的 hash）換到了什麼、代價是什麼。拿單體的付款期限當例子（K8 的做法：下單的回應相減），權重 100／0。
 *
 *   ① 現在的樣子：固定名字的 ConfigMap（monolith）。加一個 SHOP_ORDER_PAYMENTTIMEOUT=20m、rollout restart；然後 rollout undo
 *   ② configMapGenerator：target/k14 的一個 overlay —— k8s/kind 加上「單體的設定改用 generator 產生」（同樣的值，名字是 monolith-config-<hash>）。
 *      15m apply → 改成 20m、apply（不另外重開）→ rollout undo；之後 cluster 裡留下幾個 monolith-*
 *   ③ migration 的 Job：它在另一個 kustomization（k8s/kind/migrate，8.4.4），configMapKeyRef 寫的是 monolith —— 固定名字的那一個不在了會怎樣；
 *      放進同一個 kustomization，名字跟著換 —— 改了設定之後再 apply 會怎樣
 *
 *   mvn test -Pexperiments -Dtest=K14ConfigGeneratorTest        （約 8 分鐘）
 */
@Tag("experiment")
class K14ConfigGeneratorTest {

    final PrintStream out = System.out;
    final Path dir = Path.of("target", "k14");

    @Test
    void generator() throws Exception {
        try (ConfigurableApplicationContext keys = Keys.start()) {
            Mig.fresh();
            Mig.weights(100, 0);
            Mig.scale("order-service", 0);
            Mig.scale("inventory-service", 0);
            out.printf("═══ 8.7.3 configMapGenerator：單體的付款期限（下單的回應相減），權重 100／0 ═══%n");
            out.printf("  一開始：%s%n", K8ConfigTest.deadline(keys));

            Kube.kubectl("patch", "configmap/monolith", "--type=merge", "-p", "{\"data\":{\"SHOP_ORDER_PAYMENTTIMEOUT\":\"20m\"}}");
            restart();
            String after = K8ConfigTest.deadline(keys);
            Kube.kubectl("rollout", "undo", "deploy/monolith");
            settle();
            out.printf("  ① 固定名字的 ConfigMap：改成 20m、rollout restart → %s；rollout undo → %s（ConfigMap 裡還是 %s）%n", after, K8ConfigTest.deadline(keys),
                    Kube.kubectl("get", "configmap/monolith", "-o", "jsonpath={.data.SHOP_ORDER_PAYMENTTIMEOUT}"));
            Kube.kubectl("patch", "configmap/monolith", "--type=json", "-p", "[{\"op\":\"remove\",\"path\":\"/data/SHOP_ORDER_PAYMENTTIMEOUT\"}]");
            restart();

            JsonNode data = Calls.JSON.readTree(Kube.kubectl("get", "configmap/monolith", "-o", "json")).path("data");
            overlay(data, "15m", false);
            apply();
            out.printf("  ② configMapGenerator（monolith 換成 %s）：apply → %s%n", generated(), K8ConfigTest.deadline(keys));
            long t0 = System.nanoTime();
            overlay(data, "20m", false);
            apply();
            out.printf("     改成 20m、只有 apply（沒有 rollout restart）→ %.1f 秒滾完（%s）→ %s%n", (System.nanoTime() - t0) / 1e9, generated(), K8ConfigTest.deadline(keys));
            Kube.kubectl("rollout", "undo", "deploy/monolith");
            settle();
            out.printf("     rollout undo → %s（pod 指回 %s）%n", K8ConfigTest.deadline(keys),
                    Kube.kubectl("get", "deploy/monolith", "-o", "jsonpath={.spec.template.spec.containers[0].envFrom[1].configMapRef.name}"));
            out.printf("     cluster 裡的 monolith 開頭的 ConfigMap：%s%n", configMaps());

            Kube.kubectl("delete", "job", "migrate-monolith", "--ignore-not-found");
            Kube.kubectl("delete", "configmap", "monolith", "--ignore-not-found");     // 固定名字的那一個：generator 的 overlay 不會再建它
            Kube.kubectl("apply", "-k", "k8s/kind/migrate", "-l", "migrate notin (order,inventory)");
            Thread.sleep(20_000);
            out.printf("  ③ Job 在另一個 kustomization、固定名字的 ConfigMap 不在了：%s%n", jobPod());
            Kube.kubectl("delete", "job", "migrate-monolith", "--ignore-not-found");
            overlay(data, "20m", true);
            out.printf("     Job 放進同一個 kustomization：第一次 apply → %s%n", applyAll());
            Kube.kubectl("wait", "--for=condition=complete", "job/migrate-monolith", "--timeout=180s");
            out.printf("       Job 的 configMapKeyRef → %s%n", Kube.kubectl("get", "job/migrate-monolith", "-o", "jsonpath={.spec.template.spec.containers[0].env[0].valueFrom.configMapKeyRef.name}"));
            overlay(data, "25m", true);
            out.printf("     改成 25m、再 apply → %s%n", applyAll());
        } finally {
            Kube.kubectl("delete", "job", "migrate-monolith", "migrate-order", "migrate-inventory", "--ignore-not-found");
            Kube.kubectl("apply", "-k", "k8s/kind");                           // 固定名字的 monolith 回來；generator 產生的那幾個留著（apply 不刪）
            for (String cm : configMaps()) if (cm.matches("monolith-config-[a-z0-9]{10}")) Kube.kubectl("delete", "configmap", cm, "--ignore-not-found");
            restart();
        }
    }

    /**
     * target/k14：k8s/kind，加上 monolith 的設定改用 generator 產生（同樣的值、付款期限 timeout）；withJobs：連 migration 的 Job 一起。
     * generator 不能直接產生一個叫 monolith 的：base 裡已經有一個固定名字的 monolith —— kustomize 要你說 behavior: merge 或 replace，
     * 而 replace 的結果還是不帶 hash 的 monolith（base 的那一個本來就不是 generator 產生的；第一版就停在這裡）。
     * 所以換一個名字（monolith-config），把固定的那一個拿掉、每一個引用它的地方改成新的名字 —— kustomize 再把新的名字換成帶 hash 的
     */
    void overlay(JsonNode data, String timeout, boolean withJobs) throws Exception {
        Files.createDirectories(dir);
        List<String> env = new ArrayList<>();
        data.fields().forEachRemaining(e -> env.add(e.getKey() + "=" + e.getValue().asText()));
        env.add("SHOP_ORDER_PAYMENTTIMEOUT=" + timeout);
        Files.write(dir.resolve("monolith.env"), env);
        Files.writeString(dir.resolve("kustomization.yaml"), """
                # K14 產生的：k8s/kind 加上「單體的設定改用 configMapGenerator」（%s）
                apiVersion: kustomize.config.k8s.io/v1beta1
                kind: Kustomization
                resources:
                  - ../../k8s/kind
                %s
                patches:
                  - patch: |-
                      $patch: delete
                      apiVersion: v1
                      kind: ConfigMap
                      metadata: {name: monolith, namespace: shop}
                  - target: {kind: Deployment, name: monolith}
                    patch: '[{"op":"replace","path":"/spec/template/spec/containers/0/envFrom/1/configMapRef/name","value":"monolith-config"}]'
                %s
                configMapGenerator:
                  - name: monolith-config
                    namespace: shop
                    envs: [monolith.env]
                    options:
                      labels: {stage: config}
                """.formatted(withJobs ? "連 migration 的 Job 一起" : "只有應用程式", withJobs ? "  - ../../k8s/kind/migrate" : "",
                withJobs ? "  - target: {kind: Job, name: migrate-monolith}\n    patch: '[{\"op\":\"replace\",\"path\":\"/spec/template/spec/containers/0/env/0/valueFrom/configMapKeyRef/name\",\"value\":\"monolith-config\"}]'" : ""));
    }

    void apply() throws Exception {
        Kube.kubectl("apply", "-k", dir.toString());
        settle();
    }

    String applyAll() throws Exception {
        String out = Kube.shAny("kubectl", "--context", Kube.CTX, "apply", "-k", dir.toString());
        // Job 的錯誤訊息很長（整份 pod 樣板的 JSON）：只留開頭與「field is immutable」那一段
        List<String> interesting = out.lines().filter(l -> l.contains("job") || l.contains("Error") || l.contains("immutable"))
                .map(l -> l.length() <= 160 ? l : l.substring(0, 80) + " … " + (l.contains("immutable") ? l.substring(Math.max(0, l.indexOf("immutable") - 40), Math.min(l.length(), l.indexOf("immutable") + 30)) : "")).toList();
        return String.join(" │ ", interesting);
    }

    /** migrate-monolith 的 pod：每一個容器（init 與主要的）現在的狀態；在等的話，等什麼 */
    String jobPod() throws Exception {
        List<String> s = new ArrayList<>();
        for (JsonNode p : Calls.JSON.readTree(Kube.kubectl("get", "pods", "-l", "job-name=migrate-monolith", "-o", "json")).path("items"))
            for (String kind : List.of("initContainerStatuses", "containerStatuses"))
                for (JsonNode c : p.path("status").path(kind)) {
                    JsonNode state = c.path("state");
                    String name = state.fieldNames().hasNext() ? state.fieldNames().next() : "?";
                    JsonNode w = state.path("waiting");
                    s.add(c.path("name").asText() + " " + (w.isMissingNode() ? name : w.path("reason").asText() + "：" + w.path("message").asText()));
                }
        return s.isEmpty() ? "沒有 pod" : String.join("；", s);
    }

    String generated() throws Exception {
        return Kube.kubectl("get", "deploy/monolith", "-o", "jsonpath={.spec.template.spec.containers[0].envFrom[1].configMapRef.name}");
    }

    List<String> configMaps() throws Exception {
        List<String> out = new ArrayList<>();
        for (JsonNode c : Calls.JSON.readTree(Kube.kubectl("get", "configmaps", "-o", "json")).path("items")) {
            String n = c.path("metadata").path("name").asText();
            if (n.startsWith("monolith")) out.add(n);
        }
        return out;
    }

    void restart() throws Exception {
        Kube.kubectl("rollout", "restart", "deploy/monolith");
        settle();
    }

    void settle() throws Exception {
        Kube.kubectl("rollout", "status", "deploy/monolith", "--timeout=300s");
        Kube.waitFor(() -> Mig.settled("monolith"), 120);
    }
}
```

**`src/test/java/com/example/shop/dist08/K15GitOpsTest.java`**（第 08 章 8.4.6）

```java
package com.example.shop.dist08;

import com.example.shop.dist07.Calls;
import com.example.shop.dist09.Mig;
import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;

import java.io.PrintStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 13 站第 09 章寫完之後的追記（第 08 章 8.4.6）：GitOps。第 08 章的部署是一支腳本（8.4.5）；這裡換成 Flux：cluster 裡一個 git server（k8s/lab/git-server），
 * 四個 Kustomization 照 dependsOn 一個接一個（k8s/gitops/flux.yaml）。
 *
 *   ① 從空的 namespace 開始：Flux 裝好、repo 推上去、套 flux.yaml —— 四個各在第幾秒好、Job 什麼時候跑完、第一個 pod 什麼時候起來
 *   ② 有人直接 kubectl：縮放（kubectl scale）、改權重（第 09 章 9.5 的 kubectl patch）、加一個環境變數（kubectl set env）—— 哪幾個被改回去、多久
 *   ③ 用 commit 部署：庫存服務 2 台 → 3 台（推到 git server）多久生效；git revert 多久回來
 * 最後拿掉 Flux 的物件（先關掉 prune：不然刪 Kustomization 會把它管的東西一起刪）、照 scripts/d09-kind.sh 重新部署
 *
 *   mvn test -Pexperiments -Dtest=K15GitOpsTest -Dk15.flux=<flux 的執行檔>        （約 12 分鐘）
 */
@Tag("experiment")
class K15GitOpsTest {

    static final List<String> STAGES = List.of("shop-config", "shop-migrate", "shop-apps", "shop-gateway");
    static final int GIT_PORT = 19180;
    final String flux = System.getProperty("k15.flux", "flux");
    final PrintStream out = System.out;
    final Path repo = Path.of("target", "k15-repo").toAbsolutePath();

    @Test
    void gitops() throws Exception {
        Process forward = null;
        try {
            out.printf("═══ 8.4.6 GitOps：Flux 照 repo 收斂 cluster（config → migrate → apps → gateway）═══%n");
            long f0 = System.nanoTime();
            Kube.sh(flux, "install", "--context", Kube.CTX, "--components=source-controller,kustomize-controller", "--timeout=5m");
            Kube.sh("docker", "build", "-q", "-t", "git-server:k15", "k8s/lab/git-server");
            Kube.sh(System.getProperty("d08.kind", "kind"), "load", "docker-image", "git-server:k15", "--name", "d08");
            Kube.sh("kubectl", "--context", Kube.CTX, "apply", "-f", "k8s/lab/git-server/git-server.yaml");
            Kube.sh("kubectl", "--context", Kube.CTX, "-n", "flux-system", "rollout", "status", "deploy/git-server", "--timeout=180s");
            forward = new ProcessBuilder("kubectl", "--context", Kube.CTX, "-n", "flux-system", "port-forward", "svc/git-server", GIT_PORT + ":8080")
                    .redirectErrorStream(true).redirectOutput(ProcessBuilder.Redirect.DISCARD).start();
            Thread.sleep(2_000);
            Kube.sh("rm", "-rf", repo.toString());
            String head = Kube.sh("git", "rev-parse", "HEAD").trim(), common = Path.of(Kube.sh("git", "rev-parse", "--git-common-dir").trim()).toAbsolutePath().normalize().toString();
            Kube.sh("git", "clone", "-q", "--no-checkout", common, repo.toString());
            git("checkout", "-q", "-B", "k15", head);                              // 這一次實驗的 commit（d09 上的某一個）
            git("-c", "http.postBuffer=524288000", "push", "-q", remote(), "HEAD:main");   // 預設的 1 MiB：大的 push 這個 git server 收不了（k8s/lab/git-server）
            out.printf("  Flux（source-controller、kustomize-controller）、git server、推 repo：%.0f 秒（不算在部署裡）%n", (System.nanoTime() - f0) / 1e9);

            Kube.shAny("kubectl", "--context", Kube.CTX, "delete", "namespace", "shop", "--wait=true", "--timeout=180s");
            Mig.script("databases");
            long t0 = System.nanoTime();
            Kube.sh("kubectl", "--context", Kube.CTX, "apply", "-f", "k8s/gitops/flux.yaml");
            Map<String, Double> ready = new LinkedHashMap<>();
            double firstPod = -1, jobDone = -1;
            while (ready.size() < STAGES.size() && (System.nanoTime() - t0) < 600e9) {
                double s = (System.nanoTime() - t0) / 1e9;
                for (String k : STAGES) if (!ready.containsKey(k) && readyNow(k)) ready.put(k, s);
                if (jobDone < 0 && Kube.shAny("kubectl", "--context", Kube.CTX, "-n", "shop", "get", "job", "migrate-monolith", "-o", "jsonpath={.status.succeeded}").trim().equals("1")) jobDone = s;
                if (firstPod < 0 && Kube.shAny("kubectl", "--context", Kube.CTX, "-n", "shop", "get", "pods", "-l", "system=shop", "-o", "name").contains("pod/")) firstPod = s;
                Thread.sleep(1_000);
            }
            out.printf("  ① 從空的 namespace 開始（套上 flux.yaml 起算）：%s；migration 的 Job 第 %.0f 秒跑完；第一個應用程式的 pod 第 %.0f 秒出現%n",
                    fmt(ready), jobDone, firstPod);
            out.printf("     每一個 Kustomization 的狀態：%s%n", status());

            out.printf("  ② 有人直接 kubectl（Kustomization 的 interval 是 1 分鐘）%n");
            Kube.kubectl("scale", "deploy/inventory-service", "--replicas=1");
            out.printf("     kubectl scale 庫存服務 → 1 台：%s%n", until("庫存服務回到 2 台", () -> Kube.kubectl("get", "deploy/inventory-service", "-o", "jsonpath={.spec.replicas}").trim().equals("2"), 180));
            Mig.weights(50, 50);
            out.printf("     kubectl patch 權重 → 50／50：%s%n", until("權重回到 100／0", () -> Kube.kubectl("get", "httproute/shop-api", "-o", "jsonpath={.spec.rules[0].backendRefs[1].weight}").trim().equals("0"), 180));
            Kube.kubectl("set", "env", "deploy/order-service", "SHOP_EXTRA=from-kubectl");
            Thread.sleep(150_000);
            out.printf("     kubectl set env 訂單服務多一個 SHOP_EXTRA：150 秒（兩輪多）之後還在嗎 → %s%n",
                    Kube.kubectl("get", "deploy/order-service", "-o", "jsonpath={.spec.template.spec.containers[0].env}").contains("SHOP_EXTRA") ? "還在" : "不在了");
            Kube.kubectl("set", "env", "deploy/order-service", "SHOP_EXTRA-");

            out.printf("  ③ 用 commit 部署%n");
            Path deploy = repo.resolve("k8s/base/inventory-service.yaml");
            Files.writeString(deploy, Files.readString(deploy).replaceFirst("replicas: 2", "replicas: 3"));
            git("-c", "user.name=k15", "-c", "user.email=k15@example.com", "commit", "-qam", "inventory-service: 3 replicas");
            long c0 = System.nanoTime();
            git("push", "-q", remote(), "HEAD:main");
            out.printf("     commit「庫存服務 3 台」、push：%s%n", until("3 台都 ready", () -> Kube.pods("inventory-service").stream().filter(Kube.Pod::ready).count() == 3, 300, c0));
            git("-c", "user.name=k15", "-c", "user.email=k15@example.com", "revert", "--no-edit", "HEAD");
            long r0 = System.nanoTime();
            git("push", "-q", remote(), "HEAD:main");
            out.printf("     git revert、push：%s%n", until("回到 2 台", () -> Kube.kubectl("get", "deploy/inventory-service", "-o", "jsonpath={.spec.replicas}").trim().equals("2"), 300, r0));
        } finally {
            for (String k : STAGES)
                Kube.shAny("kubectl", "--context", Kube.CTX, "-n", "flux-system", "patch", "kustomization", k, "--type=merge", "-p", "{\"spec\":{\"prune\":false}}");
            Kube.shAny("kubectl", "--context", Kube.CTX, "delete", "-f", "k8s/gitops/flux.yaml", "--wait=true");
            Kube.shAny("kubectl", "--context", Kube.CTX, "delete", "-f", "k8s/lab/git-server/git-server.yaml");
            Kube.shAny(flux, "uninstall", "--context", Kube.CTX, "--silent");
            if (forward != null) forward.destroy();
            Mig.script("deploy");
            Mig.script("gateway");
        }
    }

    String remote() { return "http://127.0.0.1:" + GIT_PORT + "/git/shop.git"; }

    void git(String... args) throws Exception {
        List<String> cmd = new ArrayList<>(List.of("git", "-C", repo.toString()));
        cmd.addAll(List.of(args));
        Kube.sh(cmd.toArray(String[]::new));
    }

    static boolean readyNow(String k) throws Exception {
        String j = Kube.shAny("kubectl", "--context", Kube.CTX, "-n", "flux-system", "get", "kustomization", k, "-o", "json");
        if (!j.trim().startsWith("{")) return false;
        for (JsonNode c : Calls.JSON.readTree(j).path("status").path("conditions"))
            if (c.path("type").asText().equals("Ready")) return c.path("status").asText().equals("True");
        return false;
    }

    static String status() throws Exception {
        List<String> s = new ArrayList<>();
        for (String k : STAGES) {
            String j = Kube.shAny("kubectl", "--context", Kube.CTX, "-n", "flux-system", "get", "kustomization", k, "-o", "json");
            for (JsonNode c : Calls.JSON.readTree(j).path("status").path("conditions"))
                if (c.path("type").asText().equals("Ready")) s.add(k + " " + c.path("reason").asText() + "（" + c.path("message").asText().replaceAll("(.{90}).*", "$1…") + "）");
        }
        return String.join("；", s);
    }

    static String fmt(Map<String, Double> ready) {
        List<String> s = new ArrayList<>();
        ready.forEach((k, v) -> s.add(String.format("%s 第 %.0f 秒", k, v)));
        return String.join("、", s);
    }

    String until(String what, Kube.Check c, int seconds) throws Exception { return until(what, c, seconds, System.nanoTime()); }

    String until(String what, Kube.Check c, int seconds, long t0) throws Exception {
        while ((System.nanoTime() - t0) / 1e9 < seconds) {
            if (c.ok()) return String.format("%s：%.0f 秒", what, (System.nanoTime() - t0) / 1e9);
            Thread.sleep(1_000);
        }
        return what + "：" + seconds + " 秒內沒有";
    }
}
```

---

## 9.14 常見誤區

| 誤區 | 實際上 |
|---|---|
| 灰度，就是把一部分流量切給新的服務 | 新的服務如果寫的是另一個庫，灰度那一段就有兩個正本：400 件賣出 444 件（9.2）。程式可以灰度，資料只能一次切；先搬程式、資料最後搬（9.3.4） |
| 核對通過，就可以切換 | 第 02 章的核對比的是「副本與正本一不一樣」。9.2 裡兩個庫一樣，是因為灰度寫進副本的東西被蓋掉了 —— 核對證明不了「沒有別人在寫副本」 |
| 回滾，就是把權重改回去 | 只有資料沒有搬的時候是對的。9.2 改回去之後，44 張訂單在單體的庫裡找不到預留；資料搬了，回滾是另一次搬家（9.7：反方向的搬家程式，0 張） |
| 全站的錯誤率沒動，新的那一邊就沒問題 | 權重 5% 的那一邊錯 10%，全站只有 0.5%，`ShopHigh5xxRatio` 不會響。每一個數字都要兩邊各算一次（9.5.2） |
| 入口的權重跟 kube-proxy 一樣，是每一條連線分一次 | Envoy Gateway 把幾個 backend 放進同一個 cluster，每一個請求照權重挑一次：5% 分到 5.3%（9.5.1） |
| 加了黏性，回滾就不靈了 | 權重 0 的那一邊不在 Envoy 的 cluster 裡，黏在它身上的人馬上被送回另一邊（9.5.4）。黏性擋的是「同一個人看到可售量倒退」 |
| 搬資料就是搬那幾張表 | 共用表裡還有屬於它的幾列：去重紀錄、HTTP 的冪等鍵、還沒送出的事件（9.6.4）。第 02 章的實驗碰不到它們：那時候的單體沒有開消費者與 relay |
| 遷移期間比一比整張表就知道對不對 | 兩邊一直在動，整張表永遠不一樣。要分段、不一樣的段等一下再比、逐列也要連續幾次都不一樣才算（9.6.3） |
| 停寫切換只要一兩秒（第 02 章 2.8.4 是 1.5 秒） | 追完與核對確實不到一秒；在 K8s 上，停寫的時間幾乎都是「舊的 pod 關掉」加上「新的 pod 起來」：24.3 秒（9.6.5） |
| 新的服務上線，部署流程記得打一次重建就好 | 灰度一調權重，還沒建好的那一台馬上接到流量。讓 readiness 等它（9.4.4） |
| 合併回去，就是承認拆錯了 | 拆的判斷用的是那時候的資訊；合回去是量完之後的決定（9.9） |
| 合併回去，先把單體起來 | 資料還在庫存服務的庫時，單體一起來就是第二個正本。回程倒過來：資料先、程式後（9.10.1） |

---

## 9.15 本章小結

- **9.2**：照第 02 章的計畫切過去、多一個灰度 —— 兩個正本。超賣、核對卻說一樣、回滾之後找不到預留。
- **Strangler Fig**：新的長在舊的旁邊，一塊一塊搬；過渡架構只為了共存，要拆。兩條規則：每一份資料只有一個正本；每一步都有演練過的回頭路。
- **程式先、資料後**：程式的那幾步，資料不動，回頭路是改權重；資料那一步不能灰度，只能停寫、一次切。
- **共用一個庫的那一段**：migration 只能有一個主人；兩個行程同時第一次啟動；新的路的讀模型要先建好 —— 讓 readiness 等它。
- **灰度**：入口每一個請求挑一次；兩邊各算各的，全站的告警會被稀釋；`Shop-Route` 讓權重 0 的時候也能雙跑比對；同一個人來回兩邊會看到可售量倒退，黏性擋得住，也不妨礙回滾。
- **搬資料**：邊寫邊對帳要分出「還沒追上」與「真的不一樣」；修副本的方法是再從正本搬一次；共用表裡還有屬於它的幾列；在 K8s 上，停寫的時間幾乎都是 pod 的關與起。
- **回頭路**：反方向的搬家程式；演練過一次，回滾之後 0 張訂單找不到預留。拆掉它是一個有日期的決定。
- **合併回去**：判斷用同一組問題，這一次有數字；做法是去程倒著走 —— 資料先、程式後。

### 9.15.1 驗收清單

- [ ] 說出 Strangler Fig 與「過渡架構」，並列出你的系統遷移時會有哪幾個過渡架構、各在什麼時候拆。
- [ ] 解釋 9.2 為什麼會超賣、為什麼核對說兩個庫一樣、為什麼回滾之後找不到預留。
- [ ] 為一個拆分排出步驟表：每一步改了什麼、資料的正本在哪、回頭路是什麼。說出為什麼程式先、資料後。
- [ ] 讓新的服務接到舊的庫，並說出共用的那一段時間誰負責 migration、還有哪些「兩個行程同時」的情況。
- [ ] 用入口的權重做灰度，並說出每一段要看哪幾個數字、為什麼要兩邊各算。
- [ ] 用一個 header 讓權重 0 的那一邊也能被比對，並說出它的風險。
- [ ] 說出同一個人來回兩邊會看到什麼、黏性怎麼做、黏性會不會擋住回滾。
- [ ] 在寫入不停的時候對帳兩個庫，並說出怎麼分出「還沒追上」與「真的不一樣」、找到不一樣的列之後怎麼修。
- [ ] 列出搬一個服務的資料時，除了它自己的表，還要搬哪些列。
- [ ] 量一次停寫切換，說出每一段花多少時間、哪一段最長。
- [ ] 演練一次回滾，並說出它跟「把權重改回去」差在哪裡。
- [ ] 用 0.3.2 的六個問題與你自己的數字，判斷一個已經拆開的服務該不該合回去；如果要合，排出步驟。

---

## 9.16 這一站的收尾

這一站從一個結論開始：這個系統不該拆（0.3.4）。然後花了九章把它拆開 —— 不是為了推翻那個結論，是為了讓它**有數字**。

每一章留下的，是一個「拆了之後才會遇到、才量得到」的東西：

| 章 | 拆開之後要付的 | 這一章量到、做出來的 |
|---|---|---|
| 00 | 四個代價 | 延遲、一致性、級聯、除錯，各一個實驗 |
| 01 | 切在哪 | 三把尺、127 種切法；先修模組，再拆行程 |
| 02 | 資料 | 共享資料庫為什麼是反模式；對帳；搬家只能有一個寫入者 |
| 03 | 呼叫 | 介面的粒度、冪等、服務之間的認證、契約 |
| 04 | 交易 | Saga、補償、補償不回來的事 |
| 05 | 查詢 | 讀模型、過時視窗、重建 |
| 06 | 故障 | 逾時預算、重試預算、隔艙、熔斷 |
| 07 | 除錯 | 一個 traceId 穿過 HTTP 與 MQ；告警叫醒誰 |
| 08 | 平台 | K8s 原生的四件事、入口、選型文件 |
| 09 | 遷移與回頭路 | 程式先、資料後；灰度要兩邊各算；邊寫邊對帳；回頭路要演練；合回去是資料先、程式後 |

如果只帶走一件事，是這一站的 README 開頭那一段：Spring Cloud 是一組答案，這一站要教的是**問題**。 該不該拆、拆了之後該不該合，都是同一組問題（0.3.2）；不一樣的，只是你手上有沒有數字。

回到你自己的專案：

- 還沒拆的：把第 00 章的四個實驗、0.3.3 的變更耦合，在你的系統上跑一次。大多數時候，答案跟這個專案一樣 —— 把模組的邊界守好（第 12 站），就夠了。
- 已經拆了的：用 9.9 的那一張表，把六個問題再問一次；把 `scripts/d09-deploy-coupling.sh` 對你的 git 歷史跑一次。
- 正要拆的：先寫好回頭路，再開始搬（9.3.2 的第 2 條）。
