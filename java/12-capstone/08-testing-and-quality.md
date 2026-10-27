# 第 08 章：測試與品質：Testcontainers、覆蓋率門檻、獨立行程的壓測與 CI

> 第 07 章結束時，`mvn clean test` 是 178 個綠燈、4 分 22 秒。但那 178 個綠燈都是在同一台筆電上綠的：它連著一組 `docker compose` 起了好幾天的 MySQL、Redis、RabbitMQ，裡面有 10 萬張種子訂單與每一章實驗留下的東西；7.12.1 花了一整節處理「測試之間共用同一台 broker」。
> 而壓測從第 04 章起就是「客戶端跟伺服器在同一個 JVM」：4.8.3 的虛擬執行緒、6.4.5 的 Redis 逾時、6.9.2 演練裡那 48 個客戶端逾時、7.6.6 的熱點 p99、7.9.5 那 204 個熱點 503，六次寫著「第 08 章用獨立行程的壓測工具重量」。0.6.8 的覆蓋率門檻與 CI，一行都還沒有寫。
>
> **這一章讓測試只需要 Docker，然後問三個問題：這些綠燈綠得對嗎？它們沒看到什麼？之前那些「跟這台機器分不開」的數字，分開之後是多少？** 先把測試換到每一次建置自己起的容器上，看哪些綠燈其實靠著那台筆電；再讀覆蓋率報表裡沒跑到的那幾行、故意弄壞程式碼七次；然後用一個只換「同一個 JVM」這一個變數的壓測工具，把 0.6.2 的七列與兩個演練重量一次；最後在一台真的什麼都沒有的機器上跑 CI。
>
> 這一章結束時，你手上會有：
>
> - **每一次建置自己的 MySQL、Redis、RabbitMQ**（8.4）：一個 JVM 一組、第一個 Spring Boot 應用程式啟動時才起（純單元測試一個容器都不起：15.2 秒 → 2.5 秒）、子行程連同一組；實驗照舊連 compose。
> - **一個 3 分 45 秒的 `mvn verify`**（8.10）：188 個測試、四個覆蓋率門檻（整體 92.6%；`ordering` 96.6%、`inventory` 93.7%、`payment` 93.1%）。在一個空的容器裡（沒有 compose、沒有 `~/.m2`、UTC）是 4 分 21 秒（8.8）。
> - **一個獨立行程的壓測工具**（8.6）：正式的 jar 一個行程、壓測工具一個行程，客戶端的程式碼跟 E7、G10、G8、H6 一模一樣；連線池與 Redis 的數字經過 JMX 讀。**0.6.2 的七列第一次全部在負載下量過：五列達成。**
> - **10 個新的測試**（8.9.2）、一份 CI 的流程（8.8）、0.10.6 的腳本變成的 `HealthProbeTest`（8.9.1）。沒有新的 migration、沒有新的 API；正式程式碼改了 4 個檔案。

## 8.1 學習目標

完成本章後，你應該可以：

- 把一個連著「開發用的那一台資料庫」的測試套件，換到每一次建置自己起的容器上，並且找出換了之後**還綠、但綠得不對**的測試：寫死的位址、偷用的種子資料、子行程、在空表上通過的對帳（8.2.1、8.4.3）。
- 寫一個「一個 JVM 一組、第一個 Spring Boot 應用程式啟動時才起」的 Testcontainers 設定，說出它跟「每個測試類別一組」各要付什麼（8.4.2、8.5）。
- 說出容器的埠與綁定位址怎麼改變故障的樣子：`stop` 之後換埠；綁 127.0.0.1 時 `stop` 變成 `pause`（8.4.4）。
- 用一次「時間花在哪裡」的量測，取代「測試很慢所以要重寫」的直覺（8.2.2 的 Tomcat 12 秒）。
- 讀覆蓋率報表裡**沒跑到的那幾行**，把它們分成死碼、沒測過的功能、失敗路徑、沒有行為的程式碼，各自處理；再設門檻（8.7）。
- 用手工突變回答「這一行錯了，有沒有測試會發現」，並把「只有實驗在證明」的性質搬進回歸測試（8.7.5）。
- 寫一個只換「同一個 JVM」這一個變數的獨立行程壓測工具，並說出它拿掉了什麼、拿不掉什麼（8.6）。
- 寫一份 CI 的流程，並在一台真的什麼都沒有的機器上確認它跑得起來（8.8）。

---

## 8.2 先看見痛：綠燈是在哪一台機器上綠的

### 8.2.0 實驗環境

第 07 章結束時，`mvn clean test` 是這樣（重跑一次，load average 4.1 → 6.1）：

```
[WARNING] Tests run: 178, Failures: 0, Errors: 0, Skipped: 1
[INFO] BUILD SUCCESS
[INFO] Total time:  04:36 min
```

178 個綠燈。這一章要問的是：**這 178 個綠燈，有幾個是因為「這台筆電剛好長這樣」才綠的？**

這台筆電長這樣：

- `docker compose` 起的 MySQL、Redis、RabbitMQ 已經跑了好幾天。MySQL 裡有第 02 章的 10 萬張種子訂單、2 萬個種子帳號，以及第 02～07 章每一個實驗留下來的東西。
- 一個 VPN 用戶端開著（`utun4`，一個 `2606:4700:…` 的 IPv6 位址）。
- 8 核、16 GB；Docker Desktop 的 VM 分到 8 核、7.65 GB；Docker Engine 29.1.3。

本章的實驗命名接著第 07 章的 H1～H9：I1～I12。實驗照舊標 `@Tag("experiment")`、用 `-Pexperiments` 跑；**這一章起，實驗連的是 docker compose 的那一組**（`-Pexperiments` 會設 `shop.test.infra=compose`，8.4），預設的 `mvn test` 連的是每次建置自己起的容器。

| 實驗 | 放在哪裡 | 用什麼 | 量什麼 |
|---|---|---|---|
| I1 Tomcat 關門 | `ch08/I1ContextCloseTest` | 跟驗收測試一樣啟動、關閉應用程式；`server.address` 兩種設定交錯 | 啟動、關閉各幾毫秒；關閉時執行緒停在哪裡 |
| I2 換一個空的資料庫 | 整套 `mvn clean test` | 測試一行都不改，只把連線換到 Testcontainers；再把 compose 整組停掉跑一次 | 哪些測試紅、哪些「綠得不對」 |
| I3 埠與 `docker stop` | `ch08/I3LettuceStopTest` ＋ 兩支小腳本 | 一樣的 `redis:7.2`，兩種綁定方式；一個 Lettuce 客戶端每 100 ms 一個 GET | stop／start 之後埠變不變；stop 之後指令是立刻失敗還是等 500 ms |
| I4 測試之間的隔離 | 整套 `mvn clean test` | relay 與消費者對每一個測試都打開（I4）；拿掉一條隔離的規矩（I4b、I4c） | 7.12.1 的規矩哪幾條還需要 |
| I5 搶購，獨立行程 | `scripts/i5-flash-interleave.sh`、`i5b-flash-busy.sh` | E7 的客戶端原封不動搬到另一個 JVM，跟 H5 交錯；機器閒、機器忙各一組 | 熱點 p99、執行緒數 |
| I6 虛擬執行緒，第二次 | `scripts/i6-virtual-threads.sh` | 4.8.3 那一組，同一個 JVM 與獨立行程交錯 | 平台 vs 虛擬 |
| I7 0.6.2 的每一列 | `scripts/i7-detail-orders.sh` | 商品詳情（跟 G10 交錯）、搜尋、一般下單、我的訂單、付款回呼、賣家日報表 | p95、p99 |
| I8 手工突變 | `mutants.py`（不提供，8.7.5） | 七個一行的 bug，每一個跑一次完整的 `mvn clean test` | 哪些 bug 測試抓得到 |
| I9 降級演練，獨立行程 | `scripts/i9-drills.sh` ＋ `loadtest/ExternalDrill` | G8（Redis）與 H6（RabbitMQ）的流量，stop 與 pause；H6 再加一組機器忙的 | 0.6.3 的兩欄、7.9.5 的熱點 503 |
| I10 MySQL 卡住時的 readiness | `HealthProbeTest` ＋ 兩種 `validation-timeout` | 0.10.6 的腳本，MySQL 用 pause | 三個端點各多久回答 |
| I11 一台什麼都沒有的機器 | `git archive \| docker run maven:3.9-eclipse-temurin-21 …` | 只有 commit 了的檔案、空的 `~/.m2`、UTC、Linux | `mvn -B -ntp verify` |
| I12 新人上手 | 一個新的 `git clone` | `docker compose up -d --wait && mvn spring-boot:run` | 兩個命令夠不夠 |

兩條規矩照舊：**一次只跑一個實驗**；延遲的比較**交錯執行**，每一段輸出旁邊記下 load average。

### 8.2.1 事故一：換一個全新的資料庫 ★★★

做法是 0.13.1 早就寫好的：「Testcontainers（MySQL + Redis + RabbitMQ）」。先做最少的事 —— 一個在 JUnit 開始時啟動三個容器、把連線資訊寫成 System properties 的類別（8.4 會把它改好），**測試一行都不改**：

```bash
mvn clean test
```

```
TEST_INFRA testcontainers 啟動 9,639 ms：mysql jdbc:mysql://localhost:59750/shop、redis localhost:59749、rabbitmq localhost:59746
[ERROR] Tests run: 178, Failures: 1, Errors: 1, Skipped: 1
[ERROR] com.example.shop.acceptance.CapstoneAcceptanceTest.q9_outboxSurvivesCrash -- Time elapsed: 18.65 s <<< ERROR!
[ERROR] com.example.shop.acceptance.CapstoneAcceptanceTest.q8_redisOutageDegrades -- Time elapsed: 80.20 s <<< FAILURE!
[INFO] Total time:  04:20 min
```

（在這之前還有一次是一個測試都沒跑起來的 —— Testcontainers 的版本，8.4.1。）

**178 個裡只紅了 2 個。** 我原本預期會紅一大片：第 02 章 2.8.1 說測試資料要「自己建、自己清」，但我知道有測試偷用了種子資料。只紅 2 個，看起來是好消息。

它不是。先看紅的兩個：

**Q9**：`EmptyResultDataAccessException: expected 1, actual 0`。子行程（7.11.1 那個被 `kill -9` 的 JVM）是用 `new ProcessBuilder(...)` 啟動的 —— **它讀不到這個 JVM 的 System properties**，所以它照 `application-local.yml` 連到了 compose 的 MySQL，訂單建在那裡；測試在容器的 MySQL 裡找那張訂單，找不到。

**Q8**：

```
Q8：Redis 正常       → [商品詳情 200, 熱點商品詳情 200, 熱點下單 201, 一般下單 201, readiness 200（UP）, 熱門排行 200（…）, 登入 401]
Q8：停掉後第  5 秒   → [商品詳情 200, 熱點商品詳情 200, 熱點下單 201, 一般下單 201, readiness 200（UP）, 熱門排行 200（…）, 登入 401]
  ……
Q8：停掉後第 45 秒   → [……, 熱點下單 201, ……, 登入 429]
```

兩件事：

- **Redis「停掉」了，熱點下單還是 201。** Q8 寫的是 `docker stop shop-redis-1` —— 那是 compose 的 Redis。應用程式連的是容器的那一台，它好好的。
- **登入是 401，後來變成 429。** Q8 用 `buyer00001@example.com` / `password123` 登入 —— 那是第 02 章種子資料的帳號。空的資料庫裡沒有這個人；連續失敗幾次之後，US-ACC-2 AC-3 的鎖定接手，變成 429。**這是我知道的那一個「偷用種子資料」的測試。**

然後是綠的那 176 個裡，兩個我沒有預期到的。

**InvariantReconciliationTest**：

| | 執行時間 | 印出來的第一行 |
|---|---|---|
| 第 07 章（compose） | 3.938 秒 | `═══ 對帳（目前 100,005 張訂單）═══` |
| 換成容器 | **0.008 秒** | `═══ 對帳（目前 0 張訂單）═══` |

**它沒有變快，它變成什麼都沒檢查。** 五條對帳 SQL 在空的表上各回一個 0 —— 「差異 0 筆」。這個類別的 javadoc 從第 02 章就寫著「空資料庫會直接通過」，當時那是一句說明；換成每次全新的容器之後，**它變成了每一次建置的事實**。

**Q6**：照樣綠。它寫的是 `jdbc:mysql://localhost:3306/` —— compose 的 MySQL。換了容器，它還是去 compose 那台建 `shop_q6`。

要知道到底有幾個測試靠著 compose，最直接的辦法是**把 compose 整組停掉**，再跑一次（這比較接近一台乾淨的 CI 機器）：

```bash
docker stop shop-mysql-1 shop-redis-1 shop-rabbitmq-1
mvn clean test
```

```
[ERROR] Tests run: 178, Failures: 1, Errors: 2, Skipped: 1
[ERROR] com.example.shop.acceptance.CapstoneAcceptanceTest.q9_outboxSurvivesCrash -- Time elapsed: 74.16 s <<< ERROR!
[ERROR] com.example.shop.acceptance.CapstoneAcceptanceTest.q6_migrationFromScratch -- Time elapsed: 0.006 s <<< ERROR!
[ERROR] com.example.shop.acceptance.CapstoneAcceptanceTest.q8_redisOutageDegrades -- Time elapsed: 80.07 s <<< FAILURE!
[INFO] Total time:  05:14 min
```

Q6 現在紅了（`CannotGetJdbcConnectionException`）；Q9 的子行程連不上資料庫，等滿 60 秒（`Communications link failure`）。另外還有一個副作用：跑完之後 `docker ps` 裡 `shop-redis-1` 是「Up About a minute」—— **Q8 的 `finally` 執行了 `docker start shop-redis-1`，把我刻意停掉的 compose Redis 打開了**。一個測試在一台「乾淨」的機器上，順手啟動了開發環境的容器。

所以第 07 章的 178 個綠燈裡：

| | 幾個 | 是誰 | 靠的是什麼 |
|---|---|---|---|
| 換了資料庫就紅 | 2 | Q8、Q9 | 寫死的容器名稱、種子帳號；子行程讀不到 System properties |
| 換了資料庫還綠，compose 一停就紅 | 1 | Q6 | 寫死的 `localhost:3306` |
| 永遠綠，但什麼都沒檢查 | 1 | InvariantReconciliationTest | 10 萬張種子訂單 |

**四個。全部是驗收題或對帳 —— 整個專題裡最重要的那幾個測試。** 它們不是寫錯了，它們都在「我的筆電」上被寫出來、被驗證過，而那台筆電上，compose 一直開著、種子資料一直在。

> 📌 **「換一個空的環境」最可怕的結果不是紅燈，是綠燈。** 紅燈會被修；一個在空資料庫上 0.008 秒通過的對帳測試，會在每一次建置裡一直綠下去。
> 換環境之後要看的不只是「有沒有紅」，還有**每一個測試的時間變了多少**：3.9 秒變成 0.008 秒的那一個，比紅掉的那兩個更值得看。

修法在 8.4.3。

### 8.2.2 事故二：四分半鐘裡，兩分鐘在等 Tomcat 關門 ★★

0.6.8：「`mvn verify` 在筆電上 < 5 分鐘（含 Testcontainers 整合測試）」。第 07 章的 4 分 36 秒還沒有容器，加上去之後一定更長。先看時間花在哪裡（surefire 的報告，第 07 章結束時的那一次）：

```
208.671 acceptance.CapstoneAcceptanceTest
 12.096 api.DeadLetterReplayTest
  8.759 ordering.internal.EventFlowTest
  7.232 api.AuthApiTest
  5.588 reporting.internal.TrendingTest
  4.276 ordering.internal.OrderFlowTest
  ……（其他 25 個類別加起來 22 秒）
```

**驗收測試一個類別佔了 76%。** 每一題的時間：

```
q1 13.693  q2 13.934  q3 14.041  q4 13.622  q5 14.48  q6 2.327  q7 0.0  q8 80.326  q9 36.873  q10 18.076  q11 1.276
```

Q1～Q5 每一題 13～14 秒。第 04、05 章都寫過「驗收測試每一題各起一個應用程式，第 08 章會處理」—— 所以我以為是啟動慢。但同一份日誌裡，`@SpringBootTest` 的 context 暖機之後是這樣：

```
Started AuditPlacementTest in 0.735 seconds
Started EventFlowTest in 0.53 seconds
Started OrderApiTest in 0.807 seconds
```

**不到 1 秒。** 那 13 秒在哪裡？每一題結束的時候，日誌都有這一行：

```
WARN 87288 --- [shop] [           main] org.apache.tomcat.util.net.Acceptor      : The acceptor thread [http-nio-auto-1-Acceptor] did not stop cleanly
```

I1 把「啟動」與「關閉」分開量。跟驗收測試的 `startApp()` 一樣的參數，三種情況（不送請求、送一個請求、送一個請求並關掉 HttpClient），各兩次：

```bash
mvn test -Pexperiments -Dtest=I1ContextCloseTest#closeTime
```

```
═══ 8.2 驗收測試的一個應用程式：啟動與關閉各花多久 ═══
  ① 沒有送請求                      啟動  1,075 ms │ 關閉 12,136 ms
  ② 送一個請求、client 留著            啟動  1,056 ms │ 關閉 12,149 ms
  ③ 送一個請求、client 關掉            啟動    973 ms │ 關閉 12,134 ms
  ① 沒有送請求                      啟動  1,214 ms │ 關閉 12,137 ms
  ② 送一個請求、client 留著            啟動    845 ms │ 關閉 12,142 ms
  ③ 送一個請求、client 關掉            啟動  1,008 ms │ 關閉 12,123 ms
```

（load average 3.5。）**啟動 1 秒，關閉 12.1 秒 —— 每一次，跟有沒有送請求無關。** 關閉的途中每 500 ms 看一次 `main` 與 Acceptor 執行緒停在哪裡：

```bash
mvn test -Pexperiments -Dtest=I1ContextCloseTest#whereCloseWaits
```

```
═══ 8.2 ctx.close() 的途中，main 與 Acceptor 停在哪裡（每 500 ms）═══
    0.5 秒 │ http-nio-auto-1-Acceptor       │ 最上面 Net.accept                   │ NioEndpoint.serverSocketAccept:513 ← NioEndpoint.serverSocketAccept:71 ← Acceptor.run:128
    0.5 秒 │ main                           │ 最上面 Net.poll                     │ AbstractEndpoint.unlockAccept:1149 ← NioEndpoint.unlockAccept:382 ← AbstractEndpoint.pause:1419
    ……（2.0 秒為止都一樣）
    2.5 秒 │ main                           │ 最上面 Unsafe.park                  │ Acceptor.stop:179 ← NioEndpoint.stopInternal:299 ← AbstractEndpoint.stop:1435
    ……（12.1 秒為止都一樣；Acceptor 一直停在 Net.accept）
   12.1 秒 │ main                           │ 最上面 ThreadLocal$ThreadLocalMap.remove │ Acceptor.stop:180 ← NioEndpoint.stopInternal:299 ← AbstractEndpoint.stop:1435
  關閉花了 12,287 ms
```

兩段：

1. **前 2 秒，`main` 在 `unlockAccept` 裡的 `Net.poll`。** Acceptor 執行緒卡在 `accept()`，等下一個連線。Tomcat 要叫醒它，做法是**自己連自己一次**：開一個 socket 連到自己正在聽的那個埠，`accept()` 就會回來。這個連線 2 秒沒有連上。
2. **後 10 秒，`main` 在 `Acceptor.stop` 裡等。** 沒有被叫醒的 Acceptor 還在 `accept()`，Tomcat 等它 10 秒，然後印出那一行 `did not stop cleanly`，放棄。

為什麼「連自己」會連不上？Tomcat 預設綁在萬用位址（`::`，所有介面）上。萬用位址不是一個能「連過去」的地址，所以 `unlockAccept` 要先挑一個。我用 `javap -c` 看了 Tomcat 10.1.20 的 `AbstractEndpoint.getUnlockAddress`（這個專案的版本），它的邏輯是：依序看每一個網路介面的每一個位址，**跟綁定的位址同一個家族（IPv6 或 IPv4）、不是 loopback、也不是 link-local 的第一個，直接用它**；找不到才退回 loopback、link-local。

這台筆電上，依序是哪些位址？I1 的一支小程式（`UnlockProbe.java`，一個綁在萬用位址的 `ServerSocketChannel`，從每一個介面的每一個位址連它一次，最多等 2 秒；它是一次性的探查程式，不在 shop repo 裡，這一章不提供）：

```
綁定的位址：/[0:0:0:0:0:0:0:0]:59413
  utun3    fe80:0:0:0:ce81:b1c:bd2c:69e%utun3       loopback=false linkLocal=true  │  2008 ms │ SocketTimeoutException: Connect timed out
  utun2    fe80:0:0:0:d3ab:8df7:b57:6f46%utun2      loopback=false linkLocal=true  │  2002 ms │ SocketTimeoutException: Connect timed out
  utun1    fe80:0:0:0:5a9:a08c:aaec:d63f%utun1      loopback=false linkLocal=true  │  2001 ms │ SocketTimeoutException: Connect timed out
  utun0    fe80:0:0:0:db10:278b:60e3:8735%utun0     loopback=false linkLocal=true  │  2001 ms │ SocketTimeoutException: Connect timed out
  llw0     fe80:0:0:0:5c18:42ff:fe8e:6f72%llw0      loopback=false linkLocal=true  │     3 ms │ 連上了
  awdl0    fe80:0:0:0:5c18:42ff:fe8e:6f72%awdl0     loopback=false linkLocal=true  │  2002 ms │ SocketTimeoutException: Connect timed out
  utun4    2606:4700:110:89bc:546d:ba65:b17b:4d32%utun4 loopback=false linkLocal=false │  2000 ms │ SocketTimeoutException: Connect timed out
  utun4    fe80:0:0:0:227b:d2ff:fe21:b88c%utun4     loopback=false linkLocal=true  │  2002 ms │ SocketTimeoutException: Connect timed out
  utun4    172.16.0.2                               loopback=false linkLocal=false │  2001 ms │ SocketTimeoutException: Connect timed out
  en5      fe80:0:0:0:18d7:650c:9db8:cc1a%en5       loopback=false linkLocal=true  │     0 ms │ 連上了
  en5      172.27.2.135                             loopback=false linkLocal=false │     0 ms │ 連上了
  lo0      ……（loopback，全部 0 ms 連上）
```

照 Tomcat 的規則，前面六個都是 link-local（跳過），**第一個「IPv6、不是 loopback、不是 link-local」的，是 `utun4` 上的 `2606:4700:…` —— VPN 的介面，連它要等滿 2 秒逾時。** 那就是 `Net.poll` 的 2 秒；叫不醒 Acceptor，再加 10 秒。

（我沒有關掉 VPN 再量一次。所以「VPN 關掉就沒事」是從上面這張表推的，不是量到的。可以確定的是下面這一組。）

修法不需要動 VPN：**讓測試的 Tomcat 只聽 127.0.0.1**。綁的是 loopback，`unlockAccept` 就直接連 127.0.0.1：

```bash
mvn test -Pexperiments -Dtest=I1ContextCloseTest#loopbackOnly
```

```
═══ 8.2 同樣的應用程式，server.address 的兩種設定交錯 ═══
  預設（萬用位址）                     啟動  1,187 ms │ 關閉 12,146 ms
  server.address=127.0.0.1     啟動  1,024 ms │ 關閉    108 ms
  預設（萬用位址）                     啟動    962 ms │ 關閉 12,143 ms
  server.address=127.0.0.1     啟動  1,007 ms │ 關閉    108 ms
  預設（萬用位址）                     啟動    824 ms │ 關閉 12,121 ms
  server.address=127.0.0.1     啟動    903 ms │ 關閉    123 ms
```

**12.1 秒 → 0.1 秒。** 放進 `src/test/resources/config/application.yml`（只影響測試；正式環境要聽得到外面的請求）。整套 `mvn clean test` 前後各跑一次（其他條件都一樣，8.4 的修正都已經在裡面）：

| | 總時間 | `did not stop cleanly` | 驗收測試 | Q1 | Q9 |
|---|---|---|---|---|---|
| 沒有 `server.address`（load 6.4） | 4:45 | 8 次 | 205.8 秒 | 13.5 秒 | 36.6 秒 |
| `server.address: 127.0.0.1`（load 6.8） | **3:06** | **0 次** | **98.9 秒** | **1.3 秒** | **12.4 秒** |

**少了 99 秒；8 次 × 12 秒是 96 秒。** 第 04、05 章說「每一題各起一個應用程式，所以慢」—— 起一個應用程式不到 1 秒，慢的是關掉它。

> ⚠️ **自己重跑 I1 之前要知道的一件事。** 上面 I1 的三段輸出，是在加這一行設定**之前**量的。`src/test/resources/config/application.yml` 對每一個測試都生效，包括 `-Pexperiments` 的實驗 —— 所以在這一章結束時的程式碼上，`I1ContextCloseTest` 裡標著「預設（萬用位址）」的那一組（`closeTime`、`whereCloseWaits`，以及 `loopbackOnly` 的一半），其實也綁在 127.0.0.1，量不到 12 秒。要在本章的程式碼上重現，讓「預設」那一組自己帶 `--server.address=::`：8.2 量的時候 `server.address` 沒有設定，Tomcat 綁的就是 `::`（上面 UnlockProbe 的第一行）。不要用 0.0.0.0：那是 IPv4 的萬用位址，照上面的規則 Tomcat 挑的會是第一個「IPv4、不是 loopback、不是 link-local」的位址，不是 `::` 那一組；這個組合沒有量過。
>
> `I1ContextCloseTest` 用一個常數，`closeTime`（含暖機）、`whereCloseWaits`、`loopbackOnly` 的「預設」組都帶上它（參考實作的 `ch08` 分支上還是改之前的寫法）：
>
> ```java
> /** 8.2 量的「預設」是沒有設定 server.address 的 Tomcat —— 綁 ::。測試設定已經改成 127.0.0.1（8.2.2），「預設」組要自己綁回來 */
> static final String WILDCARD = "--server.address=::";
> ```
>
> 在第 09 章結束時的程式碼上重跑三個方法（load average 4.0；這台筆電的 VPN 還開著）：
>
> ```
> ═══ 8.2 驗收測試的一個應用程式：啟動與關閉各花多久 ═══
>   ① 沒有送請求                      啟動    874 ms │ 關閉 12,136 ms
>   ② 送一個請求、client 留著            啟動    835 ms │ 關閉 12,121 ms
>   ③ 送一個請求、client 關掉            啟動    877 ms │ 關閉 12,146 ms
>   ① 沒有送請求                      啟動    836 ms │ 關閉 12,142 ms
>   ② 送一個請求、client 留著            啟動    766 ms │ 關閉 12,137 ms
>   ③ 送一個請求、client 關掉            啟動    747 ms │ 關閉 12,144 ms
> ═══ 8.2 同樣的應用程式，server.address 的兩種設定交錯 ═══
>   預設（萬用位址）                     啟動    686 ms │ 關閉 12,136 ms
>   server.address=127.0.0.1     啟動    684 ms │ 關閉    118 ms
>   預設（萬用位址）                     啟動    679 ms │ 關閉 12,132 ms
>   server.address=127.0.0.1     啟動    730 ms │ 關閉    106 ms
>   預設（萬用位址）                     啟動    655 ms │ 關閉 12,132 ms
>   server.address=127.0.0.1     啟動    712 ms │ 關閉    107 ms
> ```
>
> `whereCloseWaits` 的那一次關閉花了 12,271 ms。12.1 秒對 0.1 秒，跟上面一樣 —— 這一次是在本章之後的程式碼上量到的。

> 📌 **「測試很慢」先量時間花在哪裡，再決定要優化什麼。** 我原本的計畫是把驗收題改成共用一個 context（第 04、05 章答應的那件事），那要改十幾個測試的寫法，而且會讓它們互相干擾。量了之後，答案是一行設定。
> 這一個坑只在「開著某一種 VPN 的筆電」上出現 —— CI 的機器多半不會有。**同一份程式碼、同一個測試套件，在不同的機器上可以差兩分鐘，而且沒有任何一個測試是紅的。**

---

## 8.3 測試金字塔：這個專案的測試長什麼樣子

README 寫的這一章第一個主題是「測試金字塔」。教科書的金字塔是：底下很多快的單元測試，中間一些整合測試，最上面幾個端到端。這個專案的長什麼樣子，不用畫，數得出來 —— 依「它需要什麼才跑得起來」分四層，用 8.7.4 那一次 `mvn clean verify` 的 surefire 報告（186 個測試，3 分 25 秒；最後的 188 個在 8.10）：

| 層 | 需要什麼 | 例子 | 測試 | 時間 |
|---|---|---|---|---|
| ① 單元 | 什麼都不要（沒有 Spring、沒有容器） | 狀態機 67 格、ArchUnit、`RedisGuardTest`、`TrendingDegradedTest`、驗收 Q11 | 87（47%） | 6.4 秒（3%） |
| ② Spring context ＋ 容器 | 一個 `@SpringBootTest`（多半是 MockMvc 或直接呼叫 Service）、MySQL、Redis、RabbitMQ | `OrderFlowTest`、`EventFlowTest`、`IdorMatrixTest`、`OrderHttpFlowTest` | 89（48%） | 85.3 秒（45%） |
| ③ 整個應用程式 | `new SpringApplicationBuilder(...).run()`、真的 HTTP 埠 | 驗收 Q1～Q6、Q8、Q10 | 8（4%） | 85.1 秒（45%） |
| ④ 不只一個行程 | 另一個 JVM，`kill -9` | 驗收 Q9 | 1 | 13.2 秒（7%） |

（第 ② 層的 85.3 秒裡，有 11.9 秒是三個容器的啟動 —— 算在第一個起 Spring 的測試類別頭上，這一次是 `TrendingTest` 的 19.2 秒。第 ③ 層的 85.1 秒裡，**Q8 一個就佔了 68.4 秒**：它的題目是「Redis 停止 60 秒」。）

依「個數」，它是一個金字塔：一半在最底下。依「時間」，它是倒過來的：**最底下那一半測試用了 3% 的時間，最上面 9 個用了 52%。**

這不是問題，是一個事實，而且它決定了兩件事：

- **快的測試要真的快。** 第 ① 層的 87 個加起來 6.4 秒；但在 8.4.2 改之前，單獨跑其中一個要 15 秒 —— 那 15 秒裡有 10 秒在起它根本不用的容器。一層的速度，不能被另一層的成本拖累。
- **慢的測試要值得它的時間。** Q8 的 68 秒是需求裡的 60 秒；8.2.2 那 99 秒是一個 Tomcat 的設定。前者是在測東西，後者是在等東西 —— 只有量了才分得出來。

第 ② 層是這個專案的主力，也是 Testcontainers 改變最大的那一層：以前它們連的是我的筆電上那一台什麼都有的 MySQL，現在每一次建置都是一台空的。8.5 會看那一層的「互不干擾」還差什麼；8.7.5 會看四層各自抓到了哪些 bug。

---

## 8.4 Testcontainers：每一次建置自己的 MySQL、Redis、RabbitMQ

這一章的改動散在 8.2～8.9 好幾節。如果你手上是第 07 章結束時的專案，要一步一步做出這一章的專案，照這個順序（只列出處；8.4～8.9 只給了片段的檔案，完整內容在 8.10.1）：

| 步驟 | 做什麼 | 在哪一節 |
|---|---|---|
| 1 | pom：`testcontainers.version`、三個測試依賴；`test.infra` 與 surefire 的 `systemPropertyVariables`；`-Pexperiments`、`-Pseed` 改成 compose | 8.4.1、8.4.2 |
| 2 | `support/TestInfra.java`、兩個 `META-INF` 檔 | 8.4.2（全文 8.10.1） |
| 3 | 驗收 Q6、Q8、Q9 不再靠 compose；`RandomOrderWorkload` 與 `InvariantReconciliationTest` | 8.4.3（全文 8.10.1） |
| 4 | `TrendingService` 的修正與 `TrendingDegradedTest` | 8.4.5 |
| 5 | `src/test/resources/config/application.yml` 加 `server.address: 127.0.0.1` | 8.2.2 |
| 6 | `EventFlowTest`、`DeadLetterReplayTest`：只在 compose 模式下清空消費者的佇列 | 8.5 |
| 7 | 8.7.3 的新測試；`InventoryReconciliation` 加 INV-3'；刪掉 `restockBatch` | 8.7.2、8.7.3（全文 8.10.1） |
| 8 | JaCoCo 的 `prepare-agent`、`report` 與四個 `check` —— **一定在第 7 步之後** | 8.7.1、8.7.4 |
| 9 | `EventFlowTest.refundResponseLostOnce`；`ProductCacheTest` 的每一個等待加上限 | 8.7.5、8.8.2 |
| 10 | `TestInfra.docker()`，刪掉 `CapstoneAcceptanceTest` 自己的 `docker()`；`HealthProbeTest` | 8.8.2、8.9.1（全文 8.10.1） |
| 11 | `.github/workflows/ci.yml` | 8.8.1 |
| 12 | （可選）實驗與壓測工具：`ch08/`、`loadtest/`、`LoadTestTokens`、`scripts/`；`H5HotFlashSaleTest` 多印一行 | 8.2.2、8.4.4、8.6（全文 8.10.1） |

做完第 11 步，`mvn clean verify` 應該是 8.10 那個樣子。想先看到 8.2.1 那種「換了資料庫，哪些測試靠著筆電」：做完第 1、2 步、先不做第 3 步就跑一次 `mvn clean test` —— 但 8.2.1 那一次用的是 `TestInfra` 的第一版（JUnit 一開始就起容器、Redis 用隨機的埠），我沒有用最後這一版重跑那一次，紅的不一定一模一樣。

### 8.4.1 第一次：「找不到 Docker」

pom 加上三個依賴（版本由 Spring Boot 管理）與一個測試用的類別，跑一個最簡單的測試：

```xml
<dependency><groupId>org.testcontainers</groupId><artifactId>mysql</artifactId><scope>test</scope></dependency>
<dependency><groupId>org.testcontainers</groupId><artifactId>rabbitmq</artifactId><scope>test</scope></dependency>
<dependency><groupId>org.junit.platform</groupId><artifactId>junit-platform-launcher</artifactId><scope>test</scope></dependency>
```

第三個是給 8.4.2 的 `TestInfra` 用的：它實作 `LauncherSessionListener`，那個介面在 `junit-platform-launcher` 裡。`spring-boot-starter-test` 帶進來的是 `junit-jupiter`（api、params、engine），沒有 launcher —— 少了這一行，`src/test` 編譯不過。Redis 不需要另一個模組：`GenericContainer` 在 Testcontainers 的核心裡，`mysql` 模組會把它帶進來。

```
ERROR org.testcontainers.dockerclient.DockerClientProviderStrategy -- Could not find a valid Docker environment. Please check configuration. Attempted configurations were:
	UnixSocketClientProviderStrategy: failed with exception BadRequestException (Status 400: {"ID":"","Containers":0,"ContainersRunning":0,…,"Labels":["com.docker.desktop.address=unix:///Users/…/docker-cli.sock"],…})
	DockerDesktopClientProviderStrategy: failed with exception BadRequestException (Status 400: {"ID":"","Containers":0,…})
[ERROR] java.util.concurrent.CompletionException: java.lang.IllegalStateException: Could not find a valid Docker environment. Please see logs and check configuration
```

Docker 明明開著（`docker ps` 列得出三個 compose 的容器）。錯誤訊息說「找不到」，但那兩行其實是**找到了、而且 Docker 回了話**：HTTP 400，加上一份全部是空值的 `Info`。

Spring Boot 3.2.5 管理的 Testcontainers 是 1.19.7。這台機器的 Docker Engine 是 29.1.3：

```
Server: Docker Desktop 4.56.0 (214940)
 Engine:
  Version:          29.1.3
  API version:      1.52 (minimum version 1.44)
```

**最低 API 1.44。** 用 curl 直接問 Docker 的 socket，兩個版本各問一次：

```bash
curl -s --unix-socket /var/run/docker.sock http://localhost/v1.32/info
curl -s --unix-socket /var/run/docker.sock http://localhost/v1.44/version
```

```
{"ID":"","Containers":0,"ContainersRunning":0,"ContainersPaused":0,"ContainersStopped":0,"Images":0,"Driver":"",…
{"Platform":{"Name":"Docker Desktop 4.56.0 (214940)"},"Version":"29.1.3","ApiVersion":"1.52","MinAPIVersion":"1.44",…
```

用 1.32 問，拿到的就是錯誤訊息裡那一份空的 `Info` —— Testcontainers 1.19.7 用的是 1.32。換版本試（`-Dtestcontainers.version=…` 覆寫 Boot 的管理版本）：

| Testcontainers | 結果 |
|---|---|
| 1.19.7（Boot 3.2.5 管理的） | Could not find a valid Docker environment |
| 1.21.3 | Could not find a valid Docker environment |
| 1.21.4 | `TEST_INFRA testcontainers 啟動 9,516 ms`，`OrderStateMachineTest` 67 個綠 |

```xml
<!-- 8.4.1：Boot 3.2.5 管理的是 1.19.7。它跟 Docker Engine 29（最低 API 1.44）講不上話，錯誤訊息卻是「找不到 Docker」；1.21.3 也一樣，1.21.4 才可以 -->
<testcontainers.version>1.21.4</testcontainers.version>
```

> 📌 **「Spring Boot 管理版本」管的是「這些函式庫彼此相容」，不是「它們跟你機器上的 Docker 相容」。** Docker Engine 升級，一個兩年前的 Spring Boot 版本裡的 Testcontainers 就講不上話了 —— 而 CI 的機器會在你不知道的時候升級 Docker。覆寫一個管理版本的時候，在旁邊寫下為什麼、以及你試過哪幾個。

### 8.4.2 一個 JVM 一組，等到真的有人要才起

`support/TestInfra` 的形狀：

```java
/**
 * 一個 JVM（一次 mvn test）只起一組，所有測試共用；在這個 JVM 裡「第一個 Spring Boot 應用程式啟動的時候」才起（EnvironmentPostProcessor），
 * 把連線資訊寫成 System properties —— @SpringBootTest 與 new SpringApplicationBuilder(...).run() 都讀得到（System properties 比 application.yml 優先）。
 * 只有 JUnit 的那個 JVM 會起（LauncherSessionListener 標記）：子行程（驗收 Q9、實驗 H2）不會自己再起一組，它們用 childArgs() 連同一組。
 */
public class TestInfra implements LauncherSessionListener, EnvironmentPostProcessor {

    public static final String MODE = System.getProperty("shop.test.infra", "testcontainers");

    @Override public void launcherSessionOpened(LauncherSession session) { junit = true; }

    @Override
    public void postProcessEnvironment(ConfigurableEnvironment environment, SpringApplication application) {
        if (junit && containers()) start();
    }

    static synchronized void start() {
        if (mysql != null) return;
        mysql = new MySQLContainer<>(DockerImageName.parse("mysql:8.0"))
                .withDatabaseName("shop").withUsername("shop").withPassword("shop")
                .withCommand("--character-set-server=utf8mb4", "--collation-server=utf8mb4_0900_ai_ci",
                        "--default-time-zone=+00:00", "--transaction-isolation=REPEATABLE-READ")
                .withCopyFileToContainer(MountableFile.forHostPath("docker/mysql-init/01-databases.sql"), "/docker-entrypoint-initdb.d/01-databases.sql");
        int redisPort = freePort();                                         // 8.4.4
        redis = new GenericContainer<>(DockerImageName.parse("redis:7.2")).withExposedPorts(6379)
                .withCommand("redis-server", "--maxmemory", "256mb", "--maxmemory-policy", "noeviction")
                .withCreateContainerCmdModifier(cmd -> cmd.getHostConfig()
                        .withPortBindings(new PortBinding(Ports.Binding.bindPort(redisPort), ExposedPort.tcp(6379))));
        rabbit = new RabbitMQContainer(DockerImageName.parse("rabbitmq:3.13-management"));
        Startables.deepStart(mysql, redis, rabbit).join();                  // 三個一起起：總時間 ≈ 最慢的那一個
        for (String[] p : properties()) System.setProperty(p[0], p[1]);
    }
}
```

```
# src/test/resources/META-INF/services/org.junit.platform.launcher.LauncherSessionListener
com.example.shop.support.TestInfra
# src/test/resources/META-INF/spring.factories
org.springframework.boot.env.EnvironmentPostProcessor=com.example.shop.support.TestInfra
```

（上面只是形狀。欄位宣告、`containers()`、`properties()` 的九個屬性、`jdbcUrl()`、`adminDataSource()`、`childArgs()`、`redisContainer()`、`mysqlContainer()`、`freePort()`、8.8.2 的 `docker()`，以及印出 `TEST_INFRA testcontainers 啟動 …` 那一行的 `printf`，完整的檔案在 8.10.1。）

五個決定，每一個都有一個「為什麼不是另一種」：

**① 一個 JVM 一組，不是一個測試類別一組。** 三個容器一起起要 9.3～14.7 秒（這一章十一次完整建置的 `TEST_INFRA` 那一行，包括 8.8 的三次乾淨機器）。測試類別有 30 幾個，一個類別一組就是 5 分鐘以上 —— 0.6.8 的預算整個用完。代價是：**同一次建置裡的測試，還是共用同一台 MySQL、同一台 RabbitMQ**。8.5 會量這個代價。

**② 不用 `@Testcontainers` + `@ServiceConnection`。** 那是給 `@SpringBootTest` 用的；這個專案最重要的測試 —— 驗收題、實驗 —— 是 `new SpringApplicationBuilder(ShopApplication.class).run(...)` 自己起應用程式的（每一題要自己的埠、要被關掉、Q9 還要被 `kill -9`）。System properties 是兩種寫法都讀得到的地方。

**③ 跟 compose 同一個映像檔、同一組伺服器參數、同一份初始化腳本。** `mysql:8.0`、`utf8mb4_0900_ai_ci`、`+00:00`、`REPEATABLE-READ`，以及 `docker/mysql-init/01-databases.sql`。測試的 MySQL 跟開發、正式環境的不一樣，測到的就是另一個資料庫的行為 —— 第 02 章的時區、第 04 章的隔離等級都是在這些參數上量的。（少了初始化腳本，驗收 Q6 的 `shop` 帳號在 `shop_q6` 上 `Access denied for user 'shop'@'%' to database 'shop_q6'`，8.4.3。）

**④ 等到第一個 Spring Boot 應用程式啟動才起。** 第一版是 JUnit 一開始（`launcherSessionOpened`）就起。結果是單獨跑一個 0.8 秒的單元測試要等 15 秒：

```bash
mvn test -Dtest=TrendingDegradedTest          # 第一版
```

```
TEST_INFRA testcontainers 啟動 10,005 ms：……
[ERROR] Tests run: 1, Failures: 1, Errors: 0, Skipped: 0, Time elapsed: 0.816 s <<< FAILURE! -- in com.example.shop.reporting.internal.TrendingDegradedTest
[INFO] Total time:  15.216 s
```

（那個 FAILURE 是 8.4.5 的 bug，跟這裡無關。）改成 `EnvironmentPostProcessor` 之後，純單元測試一個容器都不起：

```bash
mvn test -Dtest='TrendingDegradedTest,OrderStateMachineTest'
```

```
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.847 s -- in com.example.shop.reporting.internal.TrendingDegradedTest
[INFO] Tests run: 67, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.083 s -- in com.example.shop.ordering.internal.OrderStateMachineTest
[INFO] Total time:  2.539 s
```

**15.2 秒 → 2.5 秒。** 寫單元測試的人一天跑它幾十次；讓它們付整合測試的啟動成本，等於叫人不要寫單元測試。

為什麼還要 `LauncherSessionListener`？因為 `spring.factories` 在 classpath 上，**Q9 的子行程、H2 的子行程也會讀到它** —— 它們用的是同一個 classpath。只靠 `EnvironmentPostProcessor` 的話，每一個子行程都會自己再起一組容器，連到另一個資料庫（這是從程式碼推的；我沒有拿掉 listener 去試）。`launcherSessionOpened` 只在 JUnit 的那個 JVM 裡被呼叫，它把 `junit` 設成 true；子行程裡它是 false，什麼都不起，用 `childArgs()` 傳進來的連線。

**⑤ 實驗照舊連 compose。** `-Pexperiments` 設 `shop.test.infra=compose`：實驗要 10 萬張訂單的種子資料、要跟第 06 章的 worktree 交錯量測同一個資料庫、要 `docker stop shop-rabbitmq-1`。它們量的是效能與故障，不是正確性的回歸；它們不在 `mvn test` 裡。

```xml
<properties>
  <test.infra>testcontainers</test.infra>
</properties>
<!-- surefire -->
<systemPropertyVariables><shop.test.infra>${test.infra}</shop.test.infra></systemPropertyVariables>
<!-- -Pexperiments、-Pseed -->
<properties>…<test.infra>compose</test.infra><jacoco.skip>true</jacoco.skip></properties>
```

（`jacoco.skip` 是 8.7 的：覆蓋率的 agent 會改寫每一個類別的位元碼，掛在一個量延遲的實驗上，量到的就不是同一個程式。）

### 8.4.3 四個測試的修法

**Q9：子行程帶著連線資訊。**

```java
cmd.addAll(com.example.shop.support.TestInfra.childArgs());          // 8.2.1：子行程讀不到這個 JVM 的 System properties —— 第一版連去了 compose 的資料庫
Process child = new ProcessBuilder(cmd).redirectErrorStream(true).redirectOutput(log.toFile()).start();
```

`childArgs()` 是 `--spring.datasource.url=…` 那九個參數；compose 模式下是空的。

⚠️ **Q9 還有一件事：第一次換到 Testcontainers 時，Q9 在 `kill -9` 之前就失敗了**（8.2.1 那個 `expected 1, actual 0`）—— 子行程沒有人殺，活了一個半小時，連著 compose 的資料庫、每小時跑一次 relay。`kill -9` 寫在測試的正常路徑上；測試在那之前失敗，就沒有人收它。改成子行程一起動，`try` 就開始，`finally` 一定收：

```java
Process child = new ProcessBuilder(cmd).redirectErrorStream(true).redirectOutput(log.toFile()).start();
try {
    …（等它起來、下單、kill -9、重啟、斷言：跟第 07 章一樣）
} finally {
    // 第一次換到 Testcontainers 時，Q9 在 kill -9 之前就失敗了 —— 子行程沒有人殺，活了一個半小時，
    // 連著 compose 的資料庫、每小時跑一次 relay。測試失敗的時候，它開的行程也要收掉
    if (child.isAlive()) child.destroyForcibly().waitFor();
}
```

**Q6：用測試的那台 MySQL 建 `shop_q6`。**

```java
// 8.2.1：第一版寫死 localhost:3306 —— 換成 Testcontainers 之後它照樣綠，因為它一直連著 docker compose 的那台（compose 停掉才紅）
JdbcTemplate admin = new JdbcTemplate(com.example.shop.support.TestInfra.adminDataSource());
```

容器裡用 root（`MySQLContainer` 讓 root 的密碼跟 `withPassword` 一樣），compose 裡照舊用 `shop`。第 02 章 2.10 說「第 08 章改用 Testcontainers 之後，`shop_q6` 會換成一個每次都是全新的容器，這個測試的內容不用改」—— 後半句成立（測試內容只改了這兩行），前半句我沒有照做：Q6 要的是「空的資料庫」，每一次建置的 MySQL 本來就是全新的，`shop_q6` 在裡面；為它多起一個容器要多 8～10 秒。

**Q8：停掉應用程式真的在用的那一台，用自己註冊的帳號登入。**

```java
docker("stop", com.example.shop.support.TestInfra.redisContainer());   // 8.2.1：第一版寫死 shop-redis-1（compose 的那一台）
```

```java
/** 8.2.1：第一版用種子資料的 buyer00001@example.com 登入 —— 空的資料庫裡沒有這個人（401，幾次之後 429）。測試資料要自己建（2.8.1） */
static final String Q8_LOGIN = "q8-login@acceptance.example.com";
```

Q8 開始時用 Q5 的 `signUpAndLogin` 真的註冊一個帳號，結束時刪掉。`finally` 裡原本那一句 `DELETE FROM refresh_tokens WHERE user_id = 1001`（清種子買家的 token）也跟著拿掉了。具體是三處：

- `degradationColumn` 裡登入的那一個請求，帳號改成 `Q8_LOGIN`，密碼要跟 `signUpAndLogin` 註冊時用的一樣（`q5-password-1234`）：`"{\"email\": \"%s\", \"password\": \"q5-password-1234\"}".formatted(Q8_LOGIN)`。
- 刪這個帳號，要連它在 `audit_logs`、`refresh_tokens`、`user_roles` 的列一起刪：

```java
Runnable forgetLoginUser = () -> {
    for (long id : jdbc.queryForList("SELECT id FROM users WHERE email = ?", Long.class, Q8_LOGIN)) {
        jdbc.update("DELETE FROM audit_logs WHERE actor_id = ?", id);
        jdbc.update("DELETE FROM refresh_tokens WHERE user_id = ?", id);
        jdbc.update("DELETE FROM user_roles WHERE user_id = ?", id);
        jdbc.update("DELETE FROM users WHERE id = ?", id);
    }
};
```

- `try` 一開始先 `forgetLoginUser.run()`（上一次失敗留下的）、再 `signUpAndLogin(port, Q8_LOGIN)`；`finally` 裡再 `forgetLoginUser.run()` 一次。

（這裡的 `docker(...)` 還是 `CapstoneAcceptanceTest` 自己那個 `new ProcessBuilder("docker", …)` 的版本；8.8.2 會把它換掉。）

**InvariantReconciliationTest：自己製造要對的帳。** 它需要「很多真的經過程式的資料」。種子資料不行：種子是一個產生器**照著不變量寫出來的**，用它來驗證不變量，驗證的是產生器。改成一串固定亂數種子的**真的操作**（`ordering.internal.RandomOrderWorkload`，測試程式碼）：

```java
/**
 * 8.4.3 讓對帳有東西可以對：一串固定亂數種子的「真的操作」—— 下單（一般、熱點、兩個品項）、付款、買家取消、賣家取消、
 * 撿貨、出貨、確認收貨、付款逾時、事件交付（InlineEvents，時機也是亂數決定的）。全部走正式的服務，不直接寫表。
 */
```

八成的操作挑一張「這個動作在它身上合法」的訂單，兩成隨便挑 —— 不合法的轉移也要被走到。400 步：

```
═══ 對帳（目前 162 張訂單；其中工作負載 162 張：{CANCELLED=61, COMPLETED=11, PAID=18, PENDING_PAYMENT=66, PICKING=4, SHIPPED=2}）═══
  工作負載的操作：{下單 成功=162, 交付事件 成功=14, 付款 → INVALID_STATE=8, 付款 成功=66, 付款逾時 成功=7, 出貨 → INVALID_STATE=18, 出貨 → TEMPORARILY_UNAVAILABLE=5, 出貨 成功=13, 撿貨 → INVALID_STATE=2, 撿貨 成功=19, 確認收貨 → INVALID_STATE=11, 確認收貨 成功=11, 買家取消 成功=46, 賣家取消 → INVALID_STATE=2, 賣家取消 成功=16}
```

（每一步都隨便挑的話：庫存 40 件很快賣完，85 次下單被擋、只有 1 張出貨、0 張完成 —— 對帳對的大多是「取消」。八成挑合法的、庫存 150 件，是上面這樣。）`出貨 → TEMPORARILY_UNAVAILABLE=5` 是 7.6.4 的「熱點的落帳還沒完成，不能出貨」—— 交付事件的時機是亂數，有幾次出貨排在落帳之前。

測試先檢查「有東西被對到」—— 六種最後狀態至少四種：

```java
assertThat(w.statuses()).as("工作負載的最後狀態").hasSizeGreaterThanOrEqualTo(4);
```

這一句是為了 8.2.1 的那個 0.008 秒：**一個對帳測試，第一件事是證明它不是在對一張空表。** 這個測試後來還改了一次（8.7.3：它自己留的那份 SQL，跟正式的對帳排程不一樣）。`RandomOrderWorkload`（`run(ctx, seed, steps)`、`FIRST_PRODUCT`、`cleanup(ctx)`）與改完之後的 `InvariantReconciliationTest`，完整內容在 8.10.1。

### 8.4.4 ⚠️ 埠：stop 之後換了一個；綁錯地方，stop 變成 pause

Q8 要 `docker stop` Redis、60 秒後 `docker start`。Testcontainers 預設把容器的埠對應到主機上一個**隨機的**埠。I3 先看 `docker stop` / `start` 之後那個埠還在不在：

```bash
id=$(docker run -d -p 127.0.0.1::6379 redis:7.2)       # 主機的埠讓 Docker 挑
docker port $id 6379; docker stop $id; docker start $id; docker port $id 6379   # ……三次
```

```
建立：127.0.0.1:60865
第 1 次 stop → start：127.0.0.1:60867
第 2 次 stop → start：127.0.0.1:60871
第 3 次 stop → start：127.0.0.1:60873
pause → unpause：127.0.0.1:60873
```

**每一次 `start` 都換一個埠。** 應用程式手上的是 60865，Redis 回來之後在 60867 —— Q8 的「Redis 恢復之後」永遠恢復不了。（`pause` 不會換：行程沒有停、埠沒有放掉。）

所以 `TestInfra` 在啟動時自己挑一個空的埠、固定綁上去。第一版是這樣綁的：

```java
.withPortBindings(new PortBinding(Ports.Binding.bindIpAndPort("127.0.0.1", redisPort), ExposedPort.tcp(6379)))
```

只綁 127.0.0.1，看起來比較安全（測試的 Redis 不該讓區網裡的人連到）。整套跑一次，Q8 紅了，而且紅得很奇怪：

```
Q8：停掉後第 18 秒   → [商品詳情 200, 熱點商品詳情 200, 熱點下單 503（…）, 一般下單 201, readiness 200（UP）, 熱門排行 200（[{"productId":9900851,…,"quantity":2},…] X-Degraded: —）, 登入 200]
Q8：停掉後第 30 秒   → [……]
Q8：停掉後第 43 秒   → [……]
Q8：停掉後第 56 秒   → [……]
```

```
expected: "[] X-Degraded: trending"
 but was: "[{"productId":9900851,"name":"驗收商品 9900851","quantity":2},{"productId":9900852,"name":"驗收商品 9900852","quantity":1}] X-Degraded: —"
```

兩個不對：第一次取樣應該在第 5 秒，卻是第 18 秒 —— **一次「逐格檢查」（7 個請求）花了 13 秒**；以及 Redis 停著，熱門排行卻回了一份資料、沒有 `X-Degraded`。日誌裡，同一個時間點的 Lettuce 是這樣：

```
11:24:06.779 WARN i.l.core.protocol.ConnectionWatchdog Cannot reconnect to [localhost/<unresolved>:62368]: Connection closed prematurely
11:24:24.872 WARN c.e.shop.account.internal.LoginAttempts LOGIN_LOCKOUT_DEGRADED Redis 無法使用，5 秒內暫停登入失敗鎖定（0.6.3 fail-open）：Redis command timed out
11:24:40.401 WARN i.l.core.protocol.ConnectionWatchdog Cannot reconnect to [localhost/<unresolved>:62368]: Connection refused: localhost/127.0.0.1:62368
```

而第 07 章（compose 的 Redis）同一個測試是：

```
10:56:00.327 WARN i.l.core.protocol.ConnectionWatchdog Cannot reconnect to [localhost/<unresolved>:6379]: Connection reset
10:56:05.547 WARN c.example.shop.shared.redis.RedisGuard REDIS_DEGRADED product-cache.put 失敗（1 秒內第 3 次），5 秒內所有 Redis 呼叫改走降級路徑：Redis exception
```

**compose 那一次，指令是立刻失敗（`Redis exception`）；容器這一次，指令是等滿 500 ms 才失敗（`Redis command timed out`）。** 立刻失敗的話，一個請求裡碰 Redis 的幾次很快湊滿「1 秒內 3 次」，`RedisGuard` 跳開，後面全部走降級路徑；每一次都等 500 ms 的話，一個客戶端一個一個送，一秒最多失敗 2 次 —— **永遠湊不滿 3 次，`RedisGuard` 永遠不跳開**，每一個請求都在付 500 ms 的逾時。那就是 13 秒。

差別只有一個：compose 是 `ports: ["6379:6379"]`（綁在所有介面），我綁在 127.0.0.1。是它嗎？`I3LettuceStopTest` 把它單獨拿出來：兩個一樣的 `redis:7.2`，一個 `-p 127.0.0.1:埠:6379`、一個 `-p 埠:6379`；一個 Lettuce 客戶端（逾時 500 ms，跟應用程式一樣）每 100 ms 一個 GET，第 3 秒 `docker stop`：

```bash
mvn test -Pexperiments -Dtest=I3LettuceStopTest
```

```
═══ Testcontainers 那樣綁 127.0.0.1（-p 127.0.0.1:63582:6379）═══
   0 秒 │ {成功 <450ms=11}
   1 秒 │ {成功 <450ms=9}
  第 3 秒 docker stop（花了 328 ms）
  stop 之後，主機上誰在聽這個埠：
  新的例外：RedisCommandTimeoutException: Command timed out after 500 millisecond(s)
   2 秒 │ {RedisCommandTimeoutException（逾時） ≥450ms=1, 成功 <450ms=8}
   3 秒 │ {RedisCommandTimeoutException（逾時） ≥450ms=1}
   4 秒 │ {RedisCommandTimeoutException（逾時） ≥450ms=2}
   ……（到第 9 秒都是每秒 1～2 個逾時）
═══ compose 那樣綁 0.0.0.0（-p 63605:6379）═══
   0 秒 │ {成功 <450ms=11}
   1 秒 │ {成功 <450ms=9}
  第 3 秒 docker stop（花了 216 ms）
  stop 之後，主機上誰在聽這個埠：
  新的例外：RedisException: java.net.SocketException: Connection reset
   2 秒 │ {RedisException <450ms=1, 成功 <450ms=9}
   3 秒 │ {RedisException <450ms=8}
   4 秒 │ {RedisException <450ms=9}
   ……（到第 9 秒都是每秒 9～10 個立刻失敗）
```

（「第 3 秒 docker stop」印在「2 秒」那一列之前，是因為那一列是在下一秒開始時才印的。這個實驗跑了兩次（25 秒、10 秒），兩次的形狀一樣。）

**綁 0.0.0.0：`docker stop` 的那一刻，已經連著的那條連線收到 reset，之後每一個指令立刻失敗。綁 127.0.0.1：那條連線收不到任何東西 —— 對 Lettuce 來說它還活著，每一個指令送進去、等滿 500 ms。** `lsof` 說兩種情況下，stop 之後主機上都沒有人在聽那個埠了；差別在**已經建立的那條連線**被怎麼處理。這是 Docker Desktop 的轉送層在兩種綁定下的行為差異，我觀察到了，但沒有往裡面查（另一個小實驗用**新的**連線去連 127.0.0.1 那個埠，stop 之後是立刻 `refused` —— 會等的只有舊的那一條）。

**換句話說：我的 127.0.0.1 讓 Q8 的 `docker stop` 變成了 `docker pause`** —— 6.9.2 量過，pause 是「每一個指令等滿逾時」的那一種。Q8 的題目是「Redis 停止」，它在測的就變成了另一件事。改成跟 compose 一樣綁所有介面：

```java
// 8.4.4：驗收 Q8 要 docker stop / start 這個 Redis。隨機的對外埠每次 start 都會換一個（I3），應用程式就再也連不回來 ——
// 所以在啟動時挑一個空的埠、固定綁上去。綁在所有介面（跟 compose 一樣）：第一版綁 127.0.0.1，docker stop 之後
// 已經連著的 Lettuce 收不到 reset，每一個指令等滿 500 ms —— stop 變成了 pause（I3LettuceStopTest）
.withPortBindings(new PortBinding(Ports.Binding.bindPort(redisPort), ExposedPort.tcp(6379)))
```

代價是測試的 Redis 在跑測試的那幾分鐘裡，區網裡的人連得到 —— 跟 compose 的 `6379:6379` 一樣。

> 📌 **測試環境跟真實環境不一樣的每一個地方，都是測試可能說謊的地方 —— 包括「埠綁在哪個位址」這種沒有人會寫在需求裡的東西。** 第 06、07 章說「`stop` 與 `pause` 都要演練」，因為正式環境兩種都會發生（行程死了 vs 網路斷了）；這一節說的是另一面：**你以為你在演練哪一種，要用日誌確認**，不要看命令。

### 8.4.5 ⚠️ 那一次 Q8 順便抓到的 bug

回頭看那一次的另一個不對：Redis 停著，熱門排行回了一份資料、沒有 `X-Degraded`。0.6.3 那一格寫的是「熱門排行 × Redis 掛了 = 200 空清單 + X-Degraded」，`TrendingService` 的 javadoc 也寫著「Redis 不能用：回空清單，『不』退回 MySQL」。

```java
public Result top10() {
    if (!guard.available()) return new Result(List.of(), true);
    Optional<String> cached = guard.call("trending.get", () -> redis.opsForValue().get(KEY));
    if (cached.isPresent()) return new Result(parse(cached.get()), false);
    if (!guard.available()) return new Result(List.of(), true);         // 剛剛那一次 GET 失敗了
    List<Item> items = compute();
    …
```

`guard.call` 在兩種情況回 empty：Redis 裡沒有這個 key，以及 Redis 失敗了。這段程式用「GET 之後，guard 還 available 嗎」來分辨這兩種 —— **它假設失敗一次就會跳開**。那是 6.3.3 第一版 `RedisGuard` 的行為；6.4.5 把它改成「1 秒內 3 次才跳開」之後，失敗一次 guard 還是 available，這個失敗就被當成「沒有快取」，改用 MySQL 算一份、回一份「不是降級」的資料。

為什麼第 06 章的 Q8、G8 都沒抓到？因為它們的 Redis 是「立刻失敗」的（8.4.4 的 0.0.0.0）：一個請求裡的前幾次 Redis 呼叫很快湊滿 3 次，guard 跳開，輪到排行的時候 `available()` 已經是 false。G8 的 `pause` 是「等滿逾時」的那一種，但它每秒 300 多個請求，幾十個同時逾時，一樣很快跳開。**要「慢的失敗」加上「很少的流量」才看得到** —— 剛好就是 8.4.4 那一次的 Q8。

先寫一個會紅的測試，不需要 Spring、不需要 Redis：一個「GET 會逾時」的 `StringRedisTemplate`（Mockito），一個記錄自己有沒有被呼叫的 mapper，一個真的 `RedisGuard`：

```java
when(ops.get(anyString())).thenThrow(new QueryTimeoutException("Redis command timed out"));   // Lettuce 的逾時，Spring 轉成的例外
AtomicInteger sql = new AtomicInteger();
TrendingMapper mapper = (since, limit) -> { sql.incrementAndGet(); return List.of(); };
RedisGuard guard = new RedisGuard(Clock.systemUTC(), new SimpleMeterRegistry());

TrendingService.Result r = new TrendingService(mapper, redis, guard, new ObjectMapper(), Clock.systemUTC()).top10();

assertThat(guard.available()).as("一次失敗不會跳開（6.4.5）").isTrue();
assertThat(r.degraded()).isTrue();
assertThat(r.items()).isEmpty();
assertThat(sql.get()).as("不退回 MySQL").isZero();
```

```
8.2.1 Redis GET 逾時一次：guard.available()=true，degraded=false，items=[]，MySQL 被查了 1 次
[ERROR] Tests run: 1, Failures: 1, Errors: 0, Skipped: 0, Time elapsed: 0.816 s <<< FAILURE! -- in com.example.shop.reporting.internal.TrendingDegradedTest
```

紅了：`degraded=false`、MySQL 被查了 1 次。修法不需要改 `RedisGuard` 的介面 —— 讓 GET 回傳「有沒有這個 key」本身，外面再包一層 `guard.call` 的 Optional：

```java
// 外層 empty = Redis 失敗（或正在退避）；內層 empty = Redis 好好的、只是沒有這個 key。
// 8.4.5：第一版用「GET 之後 guard 還 available 嗎」來分辨 —— 6.4.5 改成「1 秒內 3 次才跳開」之後，失敗一次 guard 仍然 available，
// 失敗就被當成「沒有快取」，改用 MySQL 算、回一份沒有 X-Degraded 的資料（TrendingDegradedTest）
Optional<Optional<String>> read = guard.call("trending.get", () -> Optional.ofNullable(redis.opsForValue().get(KEY)));
if (read.isEmpty()) return new Result(List.of(), true);
if (read.get().isPresent()) return new Result(parse(read.get().get()), false);
```

```
8.2.1 Redis GET 逾時一次：guard.available()=true，degraded=true，items=[]，MySQL 被查了 0 次
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.246 s -- in com.example.shop.reporting.internal.TrendingDegradedTest
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 5.751 s -- in com.example.shop.reporting.internal.TrendingTest
```

**同樣的寫法還有兩處，我沒有改**：`ProductCache.get()` 與 `JdbcInventoryService.available()`，也是「GET 之後看 `guard.available()`」。它們的後果不一樣：商品詳情在 Redis 不能用時本來就要「走 MySQL」（0.6.3），差別只是多付一次寫回快取的 500 ms 逾時、以及沒有用到 6.9.2 的本機降級副本。那是效能，不是錯的回應；而且只在「慢的失敗 + 很少的流量」時發生。我把它留給練習二。

> 📌 **6.4.5 改了 `RedisGuard` 的一個門檻，改的時候想的是「每秒 1,000 個請求、偶發的一次逾時」。** 它的五個呼叫端（`ProductCache`、`HotStock`、`JdbcInventoryService`、`TrendingService`、`RateLimiter`）裡，有三個暗中依賴「失敗一次就跳開」—— 那個假設寫在一行註解裡（「剛剛那一次 GET 失敗了」），沒有寫在任何一個測試裡。改一個共用元件的行為之前，要找的不只是「誰呼叫它」，還有「誰依賴它現在的行為」；後者只有測試找得到。

### 8.4.6 結果

四個修正、一個 bug、`server.address`，每一步都整套跑一次：

| | 測試 | 結果 | 時間 | load average |
|---|---|---|---|---|
| 第 07 章（compose） | 178 | 0 紅、1 跳過 | 4:36 | 4.1 → 6.1 |
| 換成容器，測試不改 | 178 | 2 紅（Q8、Q9） | 4:20 | 8.6 → 4.6 |
| 　＋ compose 整組停掉 | 178 | 3 紅（＋Q6） | 5:14 | 4.5 → 4.8 |
| 四個修正（Redis 第一版綁 127.0.0.1） | 178 | 2 紅（Q6 權限、Q8 stop 變 pause） | 4:45 | 4.3 → 5.7 |
| ＋ 初始化腳本、綁所有介面、`TrendingService` | 179 | **0 紅**、1 跳過 | 4:45 | 6.4 → 6.1 |
| ＋ `server.address: 127.0.0.1` | 179 | 0 紅、1 跳過 | **3:06** | 6.8 → 7.8 |

（「換成容器，測試不改」那一次比第 07 章快了 16 秒，而它多起了三個容器：Q9 的子行程連到 compose、很快就失敗了 —— 18.6 秒，第 07 章是 36.9 秒；InvariantReconciliationTest 從 3.9 秒變成 0.008 秒。快的部分是**少做的事**。）

**第一次，這個專題的測試不需要任何一台已經開著的伺服器。** 要的只有 Docker。8.8 會在一台真的什麼都沒有的機器上確認這件事。

---

## 8.5 測試互不干擾：7.12.1 的規矩拿掉了幾條

7.16 寫的是：「7.12.1 那些『讓測試不互相干擾』的規矩，有一半可以拿掉。」那是寫在 Testcontainers 之前的一句預告。現在可以量了。

7.12.1 與它前面幾章累積下來的規矩，依「它在防什麼」分兩種：

| 規矩 | 防的是 | 來自 |
|---|---|---|
| ① 測試環境預設關掉 relay 與消費者 | **同一次建置裡**，A 類別的 context 還活著，它的消費者吃掉 B 類別的訊息 | 7.12.1 |
| ② `InlineEvents`：不經過 broker、交付順序由測試決定 | 結果要確定；某些測試要「某件事比另一件事早到」 | 7.12.1 |
| ③ 開始前清空消費者的佇列（`TestQueues.purgeConsumerQueues`） | **上一次**建置、上一個實驗（H2 的子行程只送不收）留在佇列裡的一千多則 | 7.12.1 |
| ④ `InlineEvents.skipBacklog`、Q9 的「別人的事件先標成已送出」 | **同一次建置裡**，別的測試類別寫進 outbox、從來沒有人送的事件（relay 預設關著） | 7.12.1 |
| ⑤ 要數死信的測試，先等死信落定再清（`purgeDeadLettersWhenQuiet`） | context 一啟動，relay 把 ④ 的那些事件送出去；它們的資料早就刪了，走完重試階梯才進死信 | 7.13 |
| ⑥ 每一個測試用專屬的 id 範圍、結束時清掉自己的資料 | 同一次建置裡的別的測試；**以及上一次建置留下的** | 第 03 章起 |
| ⑦ 用 SQL 建商品的測試要 `TestRedis.forgetProducts` | 同一個 id 的商品被重建，version 又是 0，快取裡那一份「一樣新」 | 6.2.3 |
| ⑧ `PENDING_PAYMENT` 的測試訂單，付款期限設在未來 | 別的 context 的付款逾時排程，在測試途中把它取消 | 6.11 |

Testcontainers 給的是「**每一次建置**一台新的 MySQL、Redis、RabbitMQ」。它拿掉的是「上一次建置」那一半；「同一次建置裡」的那一半，它碰不到 —— 8.4.2 ① 選了一個 JVM 一組容器，30 幾個測試類別還是共用同一台。

先驗證 ①。7.12.1 寫它的時候承認：「這是寫測試之前就做的決定，靠的是推理，我沒有把它們全部打開跑一次來證明它。」在 compose 上這樣做有風險（會弄亂開發用的佇列）；在一次就丟的容器上沒有。I4：對每一個測試都打開 relay 與消費者：

```bash
mvn clean test -Dshop.messaging.relay-enabled=true -Dshop.messaging.consumers-enabled=true
```

```
[ERROR] Tests run: 188, Failures: 3, Errors: 5, Skipped: 1
[ERROR] com.example.shop.acceptance.CapstoneAcceptanceTest.q10_idempotentConsumer -- Time elapsed: 35.20 s <<< ERROR!
[ERROR] com.example.shop.ordering.internal.HotSettlementTest.shipWaitsForSettlement -- Time elapsed: 0.091 s <<< FAILURE!
[ERROR] com.example.shop.ordering.internal.EventFlowTest.placedNotifies -- Time elapsed: 20.16 s <<< ERROR!
[ERROR] com.example.shop.ordering.internal.EventFlowTest.mailerDownDeadLetters -- Time elapsed: 20.18 s <<< ERROR!
[ERROR] com.example.shop.ordering.internal.EventFlowTest.refundResponseLostOnce -- Time elapsed: 0.331 s <<< FAILURE!
[ERROR] com.example.shop.ordering.internal.EventFlowTest.cancelPaidRefunds -- Time elapsed: 20.32 s <<< ERROR!
[ERROR] com.example.shop.ordering.internal.HotStockFlowTest.gateThenSoldOut -- Time elapsed: 0.070 s <<< FAILURE!
[ERROR] com.example.shop.api.DeadLetterReplayTest.replayAfterFix -- Time elapsed: 34.26 s <<< ERROR!
[INFO] Total time:  05:58 min
```

（load average 3.8 → 4.7。surefire 有把 `-D` 傳進測試的 JVM：這一次的日誌有 672 行 `MAIL_SENT`，平常是 448 行。）

**8 個紅。** 兩種：

- **`HotSettlementTest`、`HotStockFlowTest`**：它們用 `InlineEvents` 自己決定「落帳什麼時候到」（②），例如「落帳還沒完成時出貨要被擋」。真的消費者在幾毫秒內就把落帳做完了，測試想製造的那個時間差不存在了 —— `Expecting code to raise a throwable`。
- **`EventFlowTest` 的 4 個、`DeadLetterReplayTest`、Q10**：這幾個本來就打開消費者。它們等的通知「沒有寄出」（20 秒逾時）—— 但日誌裡，那幾封信**有**寄：

```
[a.Spring.bean-1] MAIL_SENT user=990711 type=ORDER_PLACED 訂單 20261005-227728 已成立，請在 15 分鐘內完成付款
[a.Spring.bean-2] MAIL_SENT user=990711 type=ORDER_PAID 訂單 20261005-894673 付款成功
```

`990711` 是 `EventFlowTest` 的買家。寄信的是**另一個還活著的 context 的消費者**，用的是那個 context 的 `SimulatedMailer` —— `EventFlowTest` 手上的那一個什麼都沒收到。退款也一樣：`refundResponseLostOnce` 的「金流被呼叫 2 次」，呼叫發生在別的 context 的金流上。**7.12.1 的推理是對的，而且現在有了 8 個紅燈當證據。** 規矩 ① 留著。

然後一條一條拿掉「防上一次建置」的那幾條，每一種跑兩次：

```
I4b 第 1 次 拿掉 TestQueues.purgeConsumerQueues（開始前清空消費者的佇列）｜load { 3.77 5.25 5.87 }｜211 秒｜('188', '0', '0', '1')｜紅的：沒有
I4b 第 2 次 拿掉 TestQueues.purgeConsumerQueues（開始前清空消費者的佇列）｜load { 8.07 6.78 6.36 }｜206 秒｜('188', '0', '0', '1')｜紅的：沒有
I4c 第 1 次 purgeDeadLettersWhenQuiet 換成直接清空死信佇列｜load { 6.08 6.73 6.48 }｜205 秒｜('188', '1', '0', '1')｜紅的：['com.example.shop.api.DeadLetterReplayTest.replayAfterFix']
I4c 第 2 次 purgeDeadLettersWhenQuiet 換成直接清空死信佇列｜load { 5.15 6.19 6.33 }｜203 秒｜('188', '1', '0', '1')｜紅的：['com.example.shop.api.DeadLetterReplayTest.replayAfterFix']
```

（I4c 是改成「一開始就清空、直接 return」。如果把等待的迴圈改成 `while (false)`，Java 說那是 unreachable statement，編譯不過，6 秒就結束，一個測試都沒有跑。）

- **③ 清空消費者的佇列：拿掉，兩次全綠。** 它防的是「上一次留下的」，而每一次建置的 RabbitMQ 都是新的。但我沒有刪掉它，而是改成只在 compose 模式下做 —— 用 `-Dshop.test.infra=compose` 跑這些測試的人，broker 還是那一台活了好幾天的：

```java
// 8.5：這一條只防「上一次建置、上一個實驗留在佇列裡的」—— broker 比建置活得久（compose）才需要。I4b：拿掉它，容器上連跑兩次全綠
if (!com.example.shop.support.TestInfra.containers()) com.example.shop.support.TestQueues.purgeConsumerQueues(ctx);
```

- **⑤ 等死信落定：拿掉，兩次都紅。** 預期 1 則死信，實際 12 則 —— 7.13 遇過的那一種（那一次是 47 則）。它防的是**同一次建置裡**別的測試類別留在 outbox 的事件：`DeadLetterReplayTest` 的 context 一啟動，relay 就把它們送出去，它們的資料早就被各自的測試刪掉了，處理失敗、走完重試階梯才進死信。新的容器不會讓這件事消失 —— 那些事件是**這一次**建置寫的。

其他幾條我沒有逐一拿掉來試；依它們防的東西推：④（outbox 裡別人的事件）、⑥（同一次建置裡別人的資料）、⑦（同一個 id 被重建）、⑧（別的 context 的排程）都是「同一次建置裡」的事，跟 ⑤ 同一類，留著。⑥ 有一半是「上一次建置留下的」—— 那一半現在不會發生了，但清理的程式碼本身沒有改：它也在保護同一次建置裡的別人。3.6.3 寫的時候預期「改用 Testcontainers 之後，每個測試都會有自己的空資料庫，就不需要這種清理了」—— 在一個 JVM 一組容器的選擇下（8.4.2 ①），有自己的空資料庫的是每一次建置，不是每一個測試。

| | 幾條 | 哪幾條 | 證據 |
|---|---|---|---|
| 證明了還需要 | 2 | ①、⑤ | I4：8 個紅；I4c：兩次都紅 |
| 證明了不需要（只在 compose 時做） | 1 | ③ | I4b：兩次全綠 |
| 沒有試，推論還需要 | 5 | ②、④、⑥、⑦、⑧ | 它們防的是同一次建置裡的事 |

**7.16 說「有一半可以拿掉」—— 量了之後是 8 條裡的 1 條。** 那句預告錯在把兩件事當成一件：Testcontainers 解決的是「建置與建置之間」的隔離（每一次都是乾淨的開始，8.2.1 的那四個測試就是被它抓到的）；「測試與測試之間」的隔離，要嘛每一個測試類別一組容器（8.4.2：5 分鐘以上），要嘛每一個測試自己守規矩。這個專題選了後者，而那些規矩大部分還在。

> 📌 **「每一次建置都是乾淨的」與「每一個測試都是乾淨的」是兩個不同的保證，價格差三十幾倍。** 前者是一次建置 10 秒的容器啟動；後者，在這個專題的形狀下，是 35 個測試類別各 10 秒。知道你買到的是哪一個，才知道哪些規矩可以丟。

---

## 8.6 獨立行程的壓測工具

### 8.6.1 只換一個變數

第 04、06、07 章的壓測（E7、G6、G8、G10、H5、H6）都是同一個形狀：測試在自己的 JVM 裡 `new SpringApplicationBuilder(ShopApplication.class).run(...)`，然後**從同一個 JVM** 送請求。六次「第 08 章用獨立行程的壓測工具重量」都是因為這件事：

- 4.8.3：虛擬執行緒的 p99 比較好，「最可能的解釋是一個量測環境的偏差」—— 8 條載體執行緒跟同一個 JVM 裡的 400 條壓測執行緒搶 CPU。
- 6.4.5：Redis 逾時的根因沒有追到，「比較可能的是客戶端這一側的排隊」—— 壓測的客戶端、Tomcat 的 200 條執行緒、Lettuce 那一條 I/O 執行緒全部在同一個 JVM 裡。
- 6.9.2：演練裡「所有 API 一起變少、變慢」的那幾個 5 秒，連壓測程式自己的計時執行緒也慢了。
- 7.6.6、7.9.5：熱點 p99 與熱點 503，都只能說「跟這台機器的條件分不開」。

這個 JVM 裡到底有多少東西？H5（7.6.6 的搶購）跑完之後多印一行（`ThreadMXBean.getPeakThreadCount()`）：

```
  這個 JVM（客戶端 + 伺服器）的執行緒最多 2755 條
```

**2,755 條執行緒在一個 JVM 裡**：2,000 條等著送出的客戶端（`newCachedThreadPool()`，每一個買家一條）、HttpClient 的 200 條、Tomcat 的 200 條、Hikari、Lettuce、RabbitMQ 用戶端、relay、消費者。分開之後（下面 8.6.2 的同一組）是：

```
  壓測工具這個 JVM 的執行緒最多 2618 條
  應用程式那個 JVM 的執行緒最多 291 條（jvm.threads.peak）
```

所以這一節的工具只改一件事：**應用程式是另一個行程**。它是 `mvn package` 出來的那個 jar，用 `java -jar` 啟動 —— 跟正式環境一樣。壓測工具（`loadtest/ExternalLoad`，測試程式碼）是第三個 JVM：

```bash
scripts/loadtest.sh flash hot=true rps=200 rounds=3        # E7 / H5 的搶購
scripts/loadtest.sh detail                                 # G10 的 1,000 rps
scripts/loadtest.sh orders rps=100 seconds=10              # 0.6.2 的「我的訂單」
scripts/loadtest.sh report                                 # 0.6.2 的「賣家日報表（90 天）」
scripts/loadtest.sh drill mix=h6 target=shop-rabbitmq-1 mode=pause   # H6 的演練
```

```bash
# scripts/loadtest.sh（節錄；全文在 8.10.1）
java -Dcom.sun.management.jmxremote.port=9010 -Dcom.sun.management.jmxremote.authenticate=false -Dcom.sun.management.jmxremote.ssl=false \
  -Djava.rmi.server.hostname=127.0.0.1 \
  -jar "$jar" --server.port=18080 --shop.order.jobs-enabled=false \
  --shop.messaging.relay-enabled=${RELAY:-true} --shop.messaging.consumers-enabled=${CONSUMERS:-true} --shop.inventory.jobs-enabled=${INVENTORY_JOBS:-true} \
  --shop.rate-limit.requests-per-ip-per-second=1000000 \
  --spring.jmx.enabled=true --spring.datasource.hikari.register-mbeans=true --management.endpoints.jmx.exposure.include=metrics \
  --spring.main.banner-mode=off --logging.level.root=WARN ${APP_ARGS:-} > target/loadtest-app.log 2>&1 &
…
java -cp "target/test-classes:target/classes:$(cat target/test-classpath.txt)" com.example.shop.loadtest.ExternalLoad "$mode" "$@"
```

relay、消費者、庫存排程預設打開（跟 E7、H5 一樣）；要關掉就在前面帶環境變數，例如 `RELAY=false CONSUMERS=false INVENTORY_JOBS=false scripts/loadtest.sh detail`（8.6.4 的商品詳情、8.6.5 的 G8 就是這樣跑的）。`ExternalLoad`、`ExternalDrill`、`LoadTestTokens`、`loadtest.sh` 與五支交錯腳本的完整內容在 8.10.1。

**客戶端的程式碼刻意一行都不改。** `ExternalLoad.flash()` 是 `E7FlashSaleLoadTest.flashSale()` 的複製：一樣的 `newCachedThreadPool()`（2,000 個買家各一條執行緒，睡到預定的時刻才送）、一樣的 `HttpClient`（200 條執行緒的 executor）、一樣**從預定送出的時間**算延遲（4.8.1 的 coordinated omission）、503 一樣用同一個 `Idempotency-Key` 在一秒後重送一次。`detail()` 是 G10 的複製，`ExternalDrill` 是 G8、H6 的複製。如果客戶端換了一種寫法（例如改用非同步、少開幾千條執行緒），量到的差別就分不清是「換了行程」還是「換了客戶端」。

改了的只有三個地方，各有理由：

- **token**：沒有 Spring 的 context，拿不到 `AccessTokens` 這個 bean。`TestTokens` 的規矩是「不自己組 JWT」（自己組的會跟正式的分家，壓測照樣 201），所以 `shared.security.LoadTestTokens` 放在跟 `AccessTokens` 同一個套件，直接用正式的類別簽。
- **連線池與 Redis 的計數器**：E7 每 5 ms 在同一個 JVM 裡讀 Hikari 的 MXBean；隔著行程，改成每 100 ms 經過 **JMX** 讀同一個 MBean（`com.zaxxer.hikari:type=Pool (HikariPool-1)`）—— 粗了 20 倍，所以「連線池：等待最多」這一欄**不能**跟同一個 JVM 的版本直接比。Redis 的失敗與跳開，經過 JMX 讀 Spring Boot 的 Metrics endpoint。⚠️ 不要走 HTTP 的 `/actuator/metrics`：`SecurityConfig` 的 `anyRequest().denyAll()` 會擋掉（401），`metric()` 如果把「不是 200」當成 0 —— **連線池、Redis 的數字會全部是 0，而且沒有任何錯誤**（一次 2 秒的煙霧測試就看得出來）。所以讀不到就印一行 `⚠️ 指標讀不到`、回 NaN，不回 0。（沒有為了壓測去打開 `/actuator/metrics`：它本來就不該對外。）
- **應用程式的設定**：測試的 `src/test/resources/config/application.yml` 不在 jar 裡，那裡面的「每 IP 每秒 100 萬次」要用參數帶進去（所有請求都從 127.0.0.1 來）。

它**沒有**改的一件事：**它還是在同一台機器上**。三個 JVM、MySQL、Redis、RabbitMQ 一樣搶這 8 個核心。獨立的行程拿掉的是「同一個 JVM」的那一部分 —— 共用的 GC 停頓、共用的 safepoint、幾千條執行緒擠在同一個排程器裡、Lettuce 的 I/O 執行緒跟壓測執行緒搶 CPU。「同一台機器」的那一部分，它拿不掉；那要第二台機器，這個專題沒有。所以每一段輸出旁邊照樣記 load average。

還有一件它跟 0.6.2 不一樣的地方：0.6.2 的量測環境寫的是「應用程式 `-Xmx512m`」，`loadtest.sh` 的 `java -jar` 沒有帶 `-Xmx`，heap 是 JVM 依機器記憶體算出來的預設值。同一個 JVM 的那幾個實驗（surefire 的 JVM）也沒有帶，所以「同一個 JVM vs 獨立行程」這個比較裡，heap 不是被換掉的變數 —— 但兩邊都不是 0.6.2 寫的那個環境。

跑之前要有的東西（腳本不會替你檢查）：

- **compose 開著，而且跑過種子資料**（`mvn test -Pseed`，2.8）：壓測工具連的是 compose 的那一組。`orders` 每一個請求抽一位種子買家（1001～21000），`report` 查的是種子資料裡的賣家 2。
- **compose 的 MySQL root 密碼是 `root`**：工具用 root 讀 `SHOW GLOBAL STATUS`（列鎖等待、`Questions`）。
- **18080（應用程式）與 9010（JMX）空著。**
- **jar 與 `target/test-classpath.txt` 只在不存在的時候才建**：改了程式碼之後，先 `mvn -DskipTests package`，或刪掉這兩個檔案，不然量的是舊的那一份。
- **交錯腳本用 `sysctl -n vm.loadavg` 記 load average**，那是 macOS 的命令；Linux 上改成 `cat /proc/loadavg`。

### 8.6.2 熱點搶購：ORD-1b AC-2，第三次

同一個 E7 的情境（2,000 個買家搶 500 件、每秒 200 個、503 用同一個鍵重送），第 07 章的 H5（同一個 JVM）與獨立行程交錯三次，各自暖機一輪、量兩輪（`scripts/i5-flash-interleave.sh`）：

```
### 同一個 JVM（H5HotFlashSaleTest）第 1 次 load { 4.71 5.18 5.82 }
  ch07 熱點 HTTP {201=500, 409=1500} │ 10.00 秒 │ p50    11  p95   220  p99   387  最慢   715 ms │ reserved=500 明細=500 RESERVE 帳=500 │ 連線池：同時使用最多 20、等待最多 41 │ 最後一個回應之後 2 ms 全部落帳 │ 列鎖等待 930 次、共 10,826 ms
  ch07 熱點 HTTP {201=500, 409=1500} │ 10.01 秒 │ p50    11  p95   235  p99   401  最慢   675 ms │ reserved=500 明細=500 RESERVE 帳=500 │ 連線池：同時使用最多 20、等待最多 51 │ 最後一個回應之後 2 ms 全部落帳 │ 列鎖等待 886 次、共 11,667 ms
### 獨立行程（scripts/loadtest.sh flash）第 1 次 load { 6.92 5.79 6.01 }
  external （暖機） HTTP {201=500, 409=1500} │ 10.01 秒 │ p50    13  p95  1351  p99  2186  最慢  2843 ms │ reserved=500 明細=500 RESERVE 帳=500 │ 連線池：同時使用最多 5、等待最多 0 │ 最後一個回應之後 4 ms 全部落帳 │ 列鎖等待 597 次、共 4,422 ms
  external  HTTP {201=500, 409=1500} │ 10.01 秒 │ p50    11  p95    83  p99   119  最慢   149 ms │ reserved=500 明細=500 RESERVE 帳=500 │ 連線池：同時使用最多 20、等待最多 7 │ 最後一個回應之後 2 ms 全部落帳 │ 列鎖等待 969 次、共 9,680 ms
  external  HTTP {201=500, 409=1500} │ 10.01 秒 │ p50    10  p95    68  p99   108  最慢   142 ms │ reserved=500 明細=500 RESERVE 帳=500 │ 連線池：同時使用最多 20、等待最多 1 │ 最後一個回應之後 6 ms 全部落帳 │ 列鎖等待 972 次、共 8,691 ms
### 同一個 JVM（H5HotFlashSaleTest）第 2 次 load { 6.32 5.92 6.04 }
  ch07 熱點 HTTP {201=500, 409=1500} │ 10.00 秒 │ p50    11  p95   129  p99   166  最慢   239 ms │ … │ 連線池：同時使用最多 20、等待最多 16 │ …
  ch07 熱點 HTTP {201=500, 409=1500} │ 10.01 秒 │ p50    11  p95    78  p99   134  最慢   213 ms │ … │ 連線池：同時使用最多 20、等待最多 15 │ …
### 獨立行程（scripts/loadtest.sh flash）第 2 次 load { 6.08 5.90 6.03 }
  external （暖機） HTTP {201=500, 409=1500} │ 10.00 秒 │ p50    12  p95   592  p99  1030  最慢  1385 ms │ …
  external  HTTP {201=500, 409=1500} │ 10.01 秒 │ p50    11  p95   111  p99   187  最慢   267 ms │ … │ 連線池：同時使用最多 20、等待最多 10 │ …
  external  HTTP {201=500, 409=1500} │ 10.00 秒 │ p50    11  p95    81  p99   111  最慢   140 ms │ … │ 連線池：同時使用最多 20、等待最多 3 │ …
### 同一個 JVM（H5HotFlashSaleTest）第 3 次 load { 7.68 6.49 6.24 }
  ch07 熱點 HTTP {201=500, 409=1500} │ 10.01 秒 │ p50    12  p95   258  p99   429  最慢   827 ms │ … │ 連線池：同時使用最多 20、等待最多 45 │ …
  ch07 熱點 HTTP {201=500, 409=1500} │ 10.01 秒 │ p50    11  p95   122  p99   176  最慢   230 ms │ … │ 連線池：同時使用最多 20、等待最多 23 │ …
### 獨立行程（scripts/loadtest.sh flash）第 3 次 load { 9.92 7.45 6.62 }
  external （暖機） HTTP {201=500, 409=1500} │ 10.01 秒 │ p50    18  p95  1781  p99  2673  最慢  3318 ms │ …
  external  HTTP {201=500, 409=1500} │ 10.01 秒 │ p50    11  p95   188  p99   331  最慢   528 ms │ … │ 連線池：同時使用最多 20、等待最多 38 │ …
  external  HTTP {201=500, 409=1500} │ 10.00 秒 │ p50    11  p95   156  p99   280  最慢   523 ms │ … │ 連線池：同時使用最多 20、等待最多 35 │ …
### done load { 8.70 7.64 6.75 }
```

（`…` 是省略的、跟第 1 次同樣格式的欄位：每一輪都是 `reserved=500 明細=500 RESERVE 帳=500`、最後一個回應之後 1～6 ms 全部落帳、列鎖等待 886～981 次。）

| load 4.7～9.9 | p99（ms），量的那 6 輪 | p99 < 500 ms |
|---|---|---|
| 同一個 JVM | 387、401、166、134、429、176 | 6 / 6 |
| 獨立行程 | 119、108、187、111、331、280 | 6 / 6 |
| 獨立行程的暖機輪 | 2,186、1,030、2,673 | 0 / 3 |

**這一次，兩種都 12 輪全部在 500 ms 以下。** 一對一對看：第 1 對獨立行程明顯比較低（387、401 vs 119、108），第 2、3 對差不多（166、134 vs 187、111；429、176 vs 331、280）—— **範圍重疊，我不能說「搬到另一個行程讓熱點下單變快了」**。 這一組的 load average 跟 7.6.6「機器閒下來的時候」那一組差不多（4.7～9.0），結果也差不多（第 07 章那一組 6 輪裡 5 輪）。

**多出來的發現是暖機那一輪。** 獨立行程的應用程式是一個新啟動的 JVM，第一輪 10 秒的 p99 是 1.0～2.7 秒 —— JIT 還沒編譯熱的那幾條路。同一個 JVM 的 H5 看不到這件事：它的暖機輪跟量的那兩輪在同一個 JVM 裡，第三次重開 Spring context 的時候，程式碼早就編譯好了。**一台剛部署好的機器，前 10 秒的熱點 p99 是秒級** —— 正式環境裡，那是滾動部署之後、或是擴容出來的新實例的前 10 秒。（這一章沒有處理它；常見的做法是 readiness 之前先自己打一輪暖機的請求。練習四。）

那機器忙的時候呢？7.6.6 的秒級 p99 都在 load 10～27。I5b 用 6 個 `yes > /dev/null` 佔住 6 個核心，同樣交錯兩次（`scripts/i5b-flash-busy.sh`）：

```
### 忙：同一個 JVM（H5HotFlashSaleTest）第 1 次 load { 7.25 7.31 6.68 }
  ch07 熱點 HTTP {201=500, 409=1447, 503=53} │ 10.01 秒 │ p50    85  p95  3168  p99  4155  最慢  5733 ms │ reserved=500 明細=500 RESERVE 帳=500 │ 連線池：同時使用最多 20、等待最多 185 │ 最後一個回應之後 6,956 ms 全部落帳 │ 列鎖等待 700 次、共 19,598 ms
  ch07 熱點 HTTP {201=496, 409=1412, 503=92} │ 10.01 秒 │ p50   139  p95  3317  p99  4406  最慢  5899 ms │ reserved=500 明細=500 RESERVE 帳=500 │ 連線池：同時使用最多 20、等待最多 186 │ 最後一個回應之後 4,476 ms 全部落帳 │ 列鎖等待 814 次、共 33,016 ms
### 忙：獨立行程（scripts/loadtest.sh flash）第 1 次 load { 25.24 13.16 8.99 }
  external （暖機） HTTP {201=488, 409=1294, 503=218} │ 10.88 秒 │ p50  2371  p95  5857  p99  6664  最慢  8217 ms │ …
       └ 503 的請求用同一個 Idempotency-Key 重送 → HTTP {201=3, 409=215}
  external  HTTP {201=497, 409=1415, 503=88} │ 10.03 秒 │ p50   130  p95  3309  p99  4500  最慢  6230 ms │ reserved=500 明細=500 RESERVE 帳=500 │ 連線池：同時使用最多 20、等待最多 186 │ …
  external  HTTP {201=494, 409=1405, 503=101} │ 10.04 秒 │ p50   276  p95  3729  p99  4670  最慢  6087 ms │ reserved=500 明細=500 RESERVE 帳=500 │ 連線池：同時使用最多 20、等待最多 185 │ …
### 忙：同一個 JVM（H5HotFlashSaleTest）第 2 次 load { 36.96 22.42 13.15 }
  ch07 熱點 HTTP {201=499, 409=1349, 503=152} │ 10.04 秒 │ p50  1092  p95  4631  p99  5631  最慢  6820 ms │ … │ 連線池：同時使用最多 20、等待最多 186 │ …
  ch07 熱點 HTTP {201=495, 409=1341, 503=164} │ 10.48 秒 │ p50   369  p95  3975  p99  4651  最慢  6534 ms │ … │ 連線池：同時使用最多 20、等待最多 185 │ …
       └ 503 的請求用同一個 Idempotency-Key 重送 → HTTP {503=164}
### 忙：獨立行程（scripts/loadtest.sh flash）第 2 次 load { 31.68 24.70 15.01 }
  external （暖機） HTTP {201=487, 409=1314, 503=199} │ 11.01 秒 │ p50  2521  p95  6075  p99  6867  最慢  8197 ms │ …
  external  HTTP {201=498, 409=1379, 503=123} │ 10.01 秒 │ p50  1110  p95  4783  p99  5399  最慢  6952 ms │ …
  external  HTTP {201=497, 409=1445, 503=58} │ 10.00 秒 │ p50    92  p95  3040  p99  3881  最慢  5773 ms │ …
### done load { 32.59 28.54 17.70 }
```

| 機器很忙（load 7 → 37） | p99（ms），量的那 4 輪 | 連線池等待（最多） |
|---|---|---|
| 同一個 JVM | 4,155、4,406、5,631、4,651 | 185～186 |
| 獨立行程 | 4,500、4,670、5,399、3,881 | 185～186 |

**一樣是秒級，而且範圍完全重疊。** 機器被佔滿的時候，把客戶端搬到另一個行程沒有任何幫助 —— 等的是 CPU，不是「同一個 JVM」。

（這一組還有一件我沒有追的事：每一輪的明細都是 500 筆，但 201 只有 494～499 個，那幾個買家拿到 503，一秒後用同一個鍵重送拿到 409。E7 只記狀態碼，那個 409 是「已售完」還是「這個鍵還在處理中」（4.8.2 說過的兩種），我分不出來。訂單沒有多、也沒有少；是回應沒有告訴買家他買到了。）

所以 6.4.5、7.6.6 寫的「要用獨立行程的壓測工具重量」，答案是：

- **機器還有餘裕的時候，熱點下單的 p99 在 500 ms 以下**：獨立行程 6 輪 108～331 ms，同一個 JVM 6 輪 134～429 ms。
- **機器沒有餘裕的時候，兩者一樣是 3.9～5.6 秒。** 之前那些秒級的數字，主因是「這台機器很忙」，不是「客戶端跟伺服器在同一個 JVM」。
- **新啟動的實例，第一個 10 秒是 1～2.7 秒。** 這是同一個 JVM 的量法量不到的。

ORD-1b AC-2 我記成：**暖機之後、機器沒有被佔滿時達成（12 / 12）；新實例的前 10 秒與機器飽和時沒有達成。** 一台筆電上能給的答案就到這裡；要知道「正式環境的那一台會不會被佔滿」，要在正式環境的規格上量 —— 那是第 09 章的部署環境的事。

### 8.6.3 虛擬執行緒，第二次

4.8.3 的結論是「不開」，三個理由的第一個是：「我們不確定為什麼它比較好。最可能的解釋是一個量測環境的偏差（客戶端與伺服器在同一個 JVM）」—— 虛擬執行緒只有 8 條載體執行緒，跟同一個 JVM 裡幾百條壓測執行緒搶 CPU，變成一個意外的併發限制器。並且說「第 08 章會用獨立行程的壓測工具重跑這一組」。

I6 就是那一組：第 04 章的 E7 原封不動（一般商品、封閉式 200 個客戶端、開放式每秒 200 個，平台與虛擬各兩輪），與獨立行程的同樣四種組合交錯兩次（`scripts/i6-virtual-threads.sh`；獨立行程那邊用 `--spring.threads.virtual.enabled` 切換，各自暖機一輪、量兩輪）。load average 6.4～9.5。只列 p99 與連線池：

| p99（ms） | 平台執行緒 | 虛擬執行緒 |
|---|---|---|
| 封閉式，同一個 JVM | 3,050、3,053、2,236、3,007 | 1,719、1,726、2,332、1,716 |
| 封閉式，獨立行程 | 2,263、2,418、2,741、2,563 | 1,520、1,748、1,789、1,855 |
| 開放式 200 rps，同一個 JVM | 1,052、1,114、621、322 | 2,332、1,003、1,393、1,044 |
| 開放式 200 rps，獨立行程 | 1,165、934、1,496、1,398 | 1,873、1,048、1,454、1,083 |
| 連線池「同時使用最多」 | 20（每一輪） | **12～13（每一輪，兩種量法都是）** |
| 5xx | 封閉式 8 輪裡 4 輪有 1～3 個 503 | 0 |
| 應用程式那個 JVM 的執行緒最多 | 292～294 | 89～93 |

（完整的輸出這一章不提供；每一輪都是 `reserved=500 明細=500 RESERVE 帳=500`。獨立行程的暖機輪：平台 3,269～3,553 ms、虛擬 2,543～3,937 ms，不列入。）

**4.8.3 的形狀，在獨立行程裡原封不動地出現了：** 封閉式負載下，虛擬執行緒的 p99 每一輪都比較好、沒有 503；開放式負載下互有勝負，平台執行緒多半比較好。

**而 4.8.3 的那個解釋不成立。** 「同時使用的連線最多 12～13 條」在獨立行程裡一樣 —— 應用程式那個 JVM 裡已經沒有任何壓測執行緒了，它的 8 條載體執行緒沒有人搶，併發還是被限在 13 左右。**那個限制器是虛擬執行緒在這個應用程式裡本來的樣子，不是量測的偏差。**為什麼是 13（Connector/J 的 `synchronized` 造成的 pinning？Tomcat 的虛擬執行緒 executor？），這一章沒有查 —— 4.8.3 用 `-Djdk.tracePinnedThreads=short` 沒有看到被釘住的堆疊，我沒有在獨立行程裡再做一次。練習五。

那要不要翻轉 4.8.3 的決定？它說「如果虛擬執行緒還是明顯比較好，再用數字翻轉」。0.6.2 寫的是**開放式**負載（每秒 200 個），而在開放式負載下，跟同一個位置的平台執行緒比，虛擬執行緒 8 輪裡 4 輪明顯差（2,332 vs 1,052、1,393 vs 621、1,044 vs 322、1,873 vs 1,165）、3 輪差不多、1 輪比較好（1,083 vs 1,398）。**不翻轉，維持平台執行緒** —— 但理由換了：不是「數字不乾淨」，是「它的好處（封閉式、不會 503）是一個隱性的併發上限帶來的，而在 0.6.2 的負載形狀下，這個上限讓排隊從連線池搬到了載體執行緒前面，p99 沒有變好」。如果要那個上限，6.9.1 的艙壁是明寫的版本。

### 8.6.4 0.6.2 的每一列

0.6.2 有七列 SLO。到第 07 章為止，**真的在負載下量過的只有兩列**：熱點下單（E7、G6、H5）與商品詳情（G10）。搜尋、我的訂單、賣家日報表，第 03 章的 D6 量的是「一次一個請求」，並寫著「壓測（0.6.2 的「100 rps」「1,000 rps」）在第 04、06 章」—— 第 04、06 章做的是熱點與商品詳情，另外幾列就這樣一直沒有人量。一般商品下單與付款回呼的「量測方式」寫的是「第 04 章」，第 04 章也沒有量。第 03 章的追溯表還有一列「RPT-1 AC-4 ｜ ✅ 03（負載下在 08）」。

所以獨立行程的工具多了四種模式，每一種都照 0.6.2 那一列的負載條件寫：

| 模式 | 0.6.2 的條件 | 怎麼送 |
|---|---|---|
| `search` | 100 rps，隨機關鍵字 | D6 的那 14 個關鍵字 × 5 個分類，排序 `price,asc`，一頁 20 筆 |
| `place` | 50 rps，分散在 1,000 個商品 | 工具自己建 1,000 個商品（不碰種子資料的庫存），每一張訂單一位新的買家 |
| `orders` | 100 rps | 每一個請求一位**隨機的**種子買家（2.8.2 的 1001～21000，包含 3,000 張訂單的那一位）（3.9.2 的 D6 有一個 bug：隨機的買家 id 在組 header 的那一刻就決定了，那 300 次其實是同一位買家；這裡每一個請求各自抽一位。D6 本身的修正與修前修後的對照在 3.9.2） |
| `callback` | 50 rps | 先用 HTTP 建好 500 張訂單與 500 筆付款（不計時），再照時間表送真的簽章的回呼 |
| `report` | 5 rps，90 天 | 賣家 2（種子資料裡最大的賣家），2026-07-01～09-28（跟 D6 同一個區間） |

全部是開放式負載、延遲從預定送出的時間算起，每一種暖機一輪、量兩輪（「我的訂單」量三輪）；整組跑兩次（`scripts/i7-detail-orders.sh`，load average 4.3～6.0）。商品詳情照樣跟同一個 JVM 的 G10 交錯 —— 為了只差「同一個 JVM」這一件事，獨立行程的那一個也關掉了 relay、消費者與庫存排程（G10 在測試的設定下跑，它們本來就是關的）。

⚠️ **關掉它們的時候，小心一個工具自己的 bug。** 如果把 `relay-enabled` 放在 `APP_ARGS` 裡又給一次 —— 命令列上同一個參數出現兩次，Spring 把兩個值合成 `"true,false"`，應用程式起不來；而腳本照樣開始送，壓測工具卡在一個連不上的埠上。做法有兩個：開關用 `RELAY`、`CONSUMERS`、`INVENTORY_JOBS` 三個環境變數（8.6.1），每一個參數只出現一次；以及送之前先確認應用程式真的起來了：

```bash
for i in $(seq 1 120); do curl -sf localhost:18080/api/ping >/dev/null && break; sleep 0.5; done
# 起不來就停（8.6.4：第一版把 relay-enabled 在 APP_ARGS 裡又給了一次，Spring 把兩個值合成 "true,false"，應用程式沒起來，
# 壓測工具照樣開始送 —— 然後卡在一個連不上的埠上）
if ! curl -sf localhost:18080/api/ping >/dev/null; then echo "  ⚠️ 應用程式沒有起來："; grep -m3 -E 'APPLICATION FAILED|Reason|Description' -A2 target/loadtest-app.log; exit 1; fi
```

```
### 獨立行程（scripts/loadtest.sh detail）第 1 次 load { 6.12 5.45 6.70 }
  external 商品 3（一般）HTTP {200=10000} │ p50   1.4  p95  18.5  p99   45.0  最慢   99.3 ms │ MySQL    1 句/秒 │ Redis 失敗 0 次、跳開 0 次
  external 商品 1（熱點）HTTP {200=10000} │ p50   1.3  p95  28.0  p99   67.0  最慢   91.2 ms │ MySQL    1 句/秒 │ Redis 失敗 0 次、跳開 0 次
  ……
### 我的訂單、賣家日報表 第 1 次 load { 4.86 5.80 6.59 }
  external （暖機） GET /api/orders 每秒 100 次、10 秒（979 位不同的買家）HTTP {200=1000} │ p50   9.7  p95  43.3  p99  238.3  最慢  328.2 ms
  external  GET /api/orders 每秒 100 次、10 秒（978 位不同的買家）HTTP {200=1000} │ p50   7.9  p95  14.5  p99   35.1  最慢   55.1 ms
  external  GET /api/orders 每秒 100 次、10 秒（970 位不同的買家）HTTP {200=1000} │ p50   7.9  p95  15.5  p99   44.2  最慢   52.3 ms
  external  GET /api/orders 每秒 100 次、10 秒（974 位不同的買家）HTTP {200=1000} │ p50   7.7  p95  20.9  p99  171.3  最慢  252.6 ms
  external （暖機） 賣家日報表 90 天，每秒 5 次、30 秒 HTTP {200=150} │ p50   49.7  p95   67.5  p99  156.2  最慢  356.1 ms
  external  賣家日報表 90 天，每秒 5 次、30 秒 HTTP {200=150} │ p50   48.6  p95   70.8  p99  145.7  最慢  150.4 ms
  external  賣家日報表 90 天，每秒 5 次、30 秒 HTTP {200=150} │ p50   49.1  p95   62.2  p99   70.5  最慢   93.6 ms
  external （暖機） 搜尋 每秒 100 次、10 秒 HTTP {200=1000} │ p50    8.4  p95   30.2  p99  168.5  最慢  281.6 ms
  external  搜尋 每秒 100 次、10 秒 HTTP {200=1000} │ p50    7.1  p95   11.1  p99   40.9  最慢   82.2 ms
  external  搜尋 每秒 100 次、10 秒 HTTP {200=1000} │ p50    6.8  p95   10.3  p99   28.9  最慢   43.7 ms
  external （暖機） 一般商品下單 每秒 50 次、10 秒、1,000 個商品 HTTP {201=500} │ p50   23.3  p95  112.9  p99  359.0  最慢  457.8 ms
  external  一般商品下單 每秒 50 次、10 秒、1,000 個商品 HTTP {201=500} │ p50   18.0  p95   40.9  p99  112.7  最慢  146.6 ms
  external  一般商品下單 每秒 50 次、10 秒、1,000 個商品 HTTP {201=500} │ p50   20.3  p95  122.8  p99  248.3  最慢  313.4 ms
  external （暖機） 付款回呼 每秒 50 次、10 秒 HTTP {200=500} │ p50    9.6  p95   23.9  p99  125.9  最慢  196.8 ms │ 到目前為止 PAID 500 張
  external  付款回呼 每秒 50 次、10 秒 HTTP {200=500} │ p50   10.0  p95   47.1  p99  109.2  最慢  129.2 ms │ 到目前為止 PAID 1000 張
  external  付款回呼 每秒 50 次、10 秒 HTTP {200=500} │ p50    9.2  p95   17.2  p99   35.5  最慢   51.9 ms │ 到目前為止 PAID 1500 張
```

（第二次的完整輸出這一章不提供；下表列兩次全部的量測輪。）

| 0.6.2 | 負載 | SLO | 量到的（不含暖機輪） | |
|---|---|---|---|---|
| 商品詳情（快取命中） | 1,000 rps，同一個商品 | p95 20、p99 **50** ms | 獨立行程 p99 19.5～103.3，12 輪裡 7 輪 < 50；同一個 JVM 12 輪裡 6 輪 | **部分** |
| 搜尋 | 100 rps | p95 150、p99 300 | p95 10.3～15.9、p99 28.9～55.1（4 輪） | ✅ |
| 一般商品下單 | 50 rps，1,000 個商品 | p95 150、p99 **300** | p95 40.9～122.8、p99 112.7～273.5（4 輪） | ✅ |
| 熱點下單 | 200 rps，同一個商品 | p95 250、p99 **500** | 8.6.2：機器有餘裕時 p99 108～331（6 輪）；忙的時候、新實例的前 10 秒是秒級 | **部分** |
| 我的訂單 | 100 rps | p95 100、p99 200 | p95 14.5～30.7、p99 35.1～171.3（6 輪） | ✅ |
| 付款回呼 | 50 rps | p95 300、p99 **1 s** | p95 17.2～47.1、p99 35.5～109.2（4 輪） | ✅ |
| 賣家日報表（90 天） | 5 rps | p95 **1 s**、p99 2 s | p95 62.2～70.8、p99 70.5～145.7（4 輪） | ✅ |

**七列裡五列達成，而且大多有好幾倍的餘裕；沒達成的兩列，就是第 06、07 章一直在追的那兩列。** 所以「第 03 章以來一直沒人量的那幾列」沒有藏著問題 —— 但在量之前，沒有人知道。

兩件值得記下來的事：

- **商品詳情跟第 06 章不一樣的地方是：24 輪裡 Redis 一次都沒有失敗。** 6.4.5 的第三次量到四輪各 163～338 次逾時，並推測「比較可能的是客戶端這一側的排隊」。這一章的同一個 JVM 版本也是 0 次 —— 所以我**不能**說「搬到另一個行程讓 Redis 不再逾時」：那個逾時這一次根本沒有出現。p99 50 ms 在兩種量法下都是一半一半；它卡在 p99 那 1% 的請求偶爾等了幾十毫秒，而 0.6.2 只給了 50 ms。這一列我記成「部分」，6.4.5 的練習五（讀快取的逾時要比 SLO 短）還是它的下一步。
- **每一種的暖機輪都比較慢**：我的訂單 238、318 ms，搜尋 169、187 ms，一般下單 359、408 ms。跟 8.6.2 同一件事：新啟動的 JVM，第一個 10 秒是另一個系統。

### 8.6.5 演練，第三次：G8、H6 與 7.9.5 的那 204 個 503

兩個演練各留了一件「第 08 章要特別看」的事：

- **6.9.2 的 G8**：`stop` 的 85～90 秒，48 個商品詳情在客戶端逾時（10 秒沒有回應）—— 那一次演練裡唯一的 `0`，原因沒有找到。
- **7.9.5 的 H6**：第 1 次（load 17.5）熱點下單出現 63、141 個 503，一般下單同時全是 201。推測是「機器很忙 → Redis 的 500 ms 逾時 → `RedisGuard` 跳開 → 熱點照 0.6.3 回 503」，但那一次沒有 Redis 的欄位，沒辦法證實。

`ExternalDrill` 照抄兩個演練的流量與時間表（G8：每 5 ms 一個 tick，詳情約 366 次/秒、排行 20、熱點 20、一般 5；H6：每 20 ms 一個 tick，詳情 50、一般 10、熱點 10），第 20 秒 `docker stop`／`pause`、第 80 秒恢復；Redis 的失敗與跳開、連線池的等待經過 JMX 讀（8.6.1）。G8 那兩次關掉了 relay 與消費者（跟 6.9.2 的 G8 一樣，它是第 06 章的系統）—— 所以那兩張表的 outbox 欄只會長、不會降。先在機器閒的時候跑四次（`scripts/i9-drills.sh`，load 4.0～6.4），只摘總結：

```
### G8 stop load { 4.03 5.07 5.68 }
  停機期間（20～80 秒）：{一般下單={201=293}, 排行={200=1177}, 熱點下單={201=3, 503=1226}, 詳情={200=21941}}
  恢復之後（80～100 秒）：{一般下單={201=99}, 排行={200=396}, 熱點下單={201=287, 503=115}, 詳情={200=7325}}
### G8 pause load { 6.38 5.73 5.85 }
  停機期間（20～80 秒）：{一般下單={201=302}, 排行={200=1197}, 熱點下單={201=1, 503=1197}, 詳情={200=21969}}
  恢復之後（80～100 秒）：{一般下單={201=100}, 排行={200=401}, 熱點下單={201=393, 503=1}, 詳情={200=7336}}
### H6 stop load { 5.22 5.80 5.88 }
  停機期間（20～80 秒）：{一般下單={201=600}, 熱點下單={201=602}, 詳情={200=3000}}
  恢復之後（80～100 秒）：{一般下單={201=200}, 熱點下單={201=200}, 詳情={200=1000}}
### H6 pause load { 6.34 6.07 5.98 }
  停機期間（20～80 秒）：{一般下單={201=602}, 熱點下單={201=599}, 詳情={200=3000}}
  恢復之後（80～100 秒）：{一般下單={201=199}, 熱點下單={201=201}, 詳情={200=1000}}
```

**0.6.3 的兩欄，每一格都對上了。** Redis 停著：詳情、排行、一般下單全部 200／201，熱點下單 503；RabbitMQ 停著：全部 201／200。四次裡**沒有任何一個客戶端逾時**（狀態碼 `0`）。G8 `stop` 的 85～90 秒是這樣：

```
   80-85  正常   │      704   │    10.4  {200=1832}            │     9.8  {503=100}          │    32.0  {201=24}       │ {200=99}         │      810      │      0       │ 4／1
   85-90  正常   │      596   │    24.5  {200=1825}            │    69.6  {201=85, 503=15}   │    42.1  {201=25}       │ {200=99}         │      834      │      0       │ 0／0
```

詳情 1,825 個全部 200、p99 24.5 ms —— 6.9.2 那 48 個逾時沒有再出現。熱點下單在 Redis 回來之後約 6～7 秒恢復（6.9.2 的前三次是 5～7 秒）。**同一個位置、同樣的流量，這一次沒事；我還是不知道那一次為什麼有事** —— 6.9.2 那一次的 load average 是 7～11，這四次是 4～6，客戶端也不在同一個 JVM 裡了，兩個變數一起換了，分不開。（G8 `pause` 的詳情 p99 在停機期間是 507～525 ms：6.9.2 說過的「每 5 秒重試一次 Redis、每一次等滿 500 ms」，這一次一樣。）

然後是 7.9.5 的那個推測。同一個 H6，6 個 `yes > /dev/null`：

```
### 忙：H6 stop load { 10.58 7.54 6.58 }
  秒      依賴 │ MySQL 句/秒 │ 詳情 p99    狀態                  │ 熱點下單 p99  狀態              │ 一般下單 p99  狀態          │ 排行 狀態         │ outbox 未送出 │ 等連線（最多）│ Redis 失敗／跳開
   ……（0～80 秒：全部 200／201）
   75-80  停了   │      569   │    53.9  {200=250}             │   144.4  {201=52}           │   116.7  {201=49}       │ —                │     1087      │      0       │ 0／0
   80-85  正常   │      435   │   867.8  {200=250}             │  1291.5  {201=38, 503=6}    │  1234.2  {201=50}       │ —                │     1188      │      0       │ 4／1
   85-90  正常   │      368   │    69.1  {200=250}             │   168.7  {201=3, 503=47}    │   726.9  {201=49}       │ —                │     1265      │      0       │ 0／0
   90-95  正常   │      445   │   601.0  {200=250}             │  1623.3  {201=51}           │  2296.8  {201=49}       │ —                │     1327      │     14       │ 0／0
   95-100 正常   │      551   │   323.5  {200=250}             │   586.1  {201=52}           │   941.9  {201=51}       │ —                │     1413      │      0       │ 0／0
  停機期間（20～80 秒）：{一般下單={201=599}, 熱點下單={201=600}, 詳情={200=3000}}
  恢復之後（80～100 秒）：{一般下單={201=199}, 熱點下單={201=144, 503=53}, 詳情={200=1000}}
### 忙：H6 pause load { 31.94 18.28 11.16 }
  ……
  停機期間（20～80 秒）：{一般下單={201=602}, 熱點下單={201=593}, 詳情={200=3000}}
  恢復之後（80～100 秒）：{一般下單={201=203}, 熱點下單={201=202}, 詳情={200=1000}}
### done load { 26.31 22.23 14.07 }
```

**7.9.5 的形狀出現了：RabbitMQ 恢復之後，熱點下單 53 個 503，一般下單同時全是 201。** 這一次有那一欄：80～85 秒 **Redis 失敗 4 次、跳開 1 次**；那 10 秒的「等連線」是 0（所以不是連線池）。跳開一次 = 5 秒內熱點下單一律 503（6.9.1 的艙壁），H6 的熱點每秒 10 張 —— **5 秒 × 10 張 ≈ 50，量到的是 53。** 數字對得上。

所以 7.9.5 的推測，這一次有了證據：**機器很忙的時候，RabbitMQ 恢復的那一刻（relay 一口氣送一千多則、消費者一口氣落帳），Redis 的指令逾時、`RedisGuard` 跳開，熱點下單照 0.6.3 回 503 五秒。** 它是 0.6.3「Redis 掛了」那一欄的行為（503，不是錯的 201），不是錯帳。我能說的就到這裡：那 4 次失敗是哪一個呼叫、為什麼在那一刻逾時，我沒有看到 —— 那一次應用程式的日誌被下一次演練覆蓋掉了（`target/loadtest-app.log` 只留最後一次）。同一個「忙」的條件下 `pause` 那一次沒有 503：RabbitMQ 在 85～90 秒就把 outbox 送完了（1,197 → 3），沒有那一波。

還有一件我沒有查的：**忙的 `stop` 那一次，RabbitMQ 回來之後 20 秒，outbox 還在長**（1,188 → 1,413）；閒的時候 `stop` 是 5～10 秒就清空（1,302 → 2）。7.9.3 第 1 次也是這個形狀，當時推測「broker 開機要重新載入 quorum 佇列，機器又很忙」。這一次一樣只是推測：我沒有量 `docker start` 之後 RabbitMQ 多久才接受連線。

---

## 8.7 覆蓋率：先讀沒跑到的那幾行，再設門檻

### 8.7.1 量

0.6.8：「整體行覆蓋 ≥ 70%；`ordering`、`inventory`、`payment` 三個模組 ≥ 85%」。JaCoCo 掛在 surefire 的 JVM 上，`verify` 產生報告：

```xml
<plugin>
  <groupId>org.jacoco</groupId>
  <artifactId>jacoco-maven-plugin</artifactId>
  <version>0.8.15</version>
  <executions>
    <execution><id>prepare-agent</id><goals><goal>prepare-agent</goal></goals></execution>
    <execution><id>report</id><phase>verify</phase><goals><goal>report</goal></goals></execution>
  </executions>
</plugin>
```

為什麼沒有 Failsafe、沒有 `*IT`？0.6.8 說的「含 Testcontainers 整合測試」，在這個專案裡全部在 surefire 的 `test` phase 跑：8.4.2 ① 要的是所有測試在**同一個 JVM** 裡共用一組容器。拆成 Failsafe，整合測試會在另一個 JVM 裡跑，就是兩組容器；JaCoCo 也要多掛一個 `prepare-agent-integration`、再把兩份結果合起來。`mvn verify` 照樣會跑到它們 —— `test` 在 `verify` 之前。

先不設門檻，只量。JaCoCo 的 `PACKAGE` 只看單一套件（`ordering.internal` 與 `ordering.internal.web` 是兩個），0.6.8 說的是「模組」，所以用一支小腳本把 `jacoco.csv` 依模組加總（`coverage_by_module.py`）。這支腳本不在 shop repo 裡，這一章不提供；要自己寫的話，它要做的事是：讀 `target/site/jacoco/jacoco.csv`，取 `PACKAGE` 欄 `com.example.shop.` 後面的第一段當模組，加總 `LINE_MISSED`、`LINE_COVERED`、`BRANCH_MISSED`、`BRANCH_COVERED`：

```bash
mvn clean verify        # 3:20，load 5.4 → 9.5；179 個測試全綠
python3 coverage_by_module.py target/site/jacoco/jacoco.csv
```

```
  模組                          行      行覆蓋             分支     分支覆蓋
  account           225 / 238       94.5%      73 / 98       74.5%
  cart               56 / 62        90.3%      18 / 26       69.2%
  catalog           190 / 215       88.4%      58 / 86       67.4%
  inventory         246 / 296       83.1%      79 / 112      70.5%
  notification       58 / 62        93.5%      19 / 22       86.4%
  ordering          466 / 495       94.1%     168 / 205      82.0%
  payment           114 / 130       87.7%      24 / 36       66.7%
  reporting          31 / 53        58.5%       8 / 20       40.0%
  shared            702 / 795       88.3%     154 / 230      67.0%
  ＝ 全部             2089 / 2349      88.9%     601 / 835      72.0%
```

（還有一列 `(root)`：`ShopApplication` 的 3 行裡跑了 1 行 —— `main()` 只有 `java -jar` 會呼叫。）

**整體 88.9%、`ordering` 94.1%、`payment` 87.7%：過了。`inventory` 83.1%：沒過。** 最直接的反應是去替 `inventory` 補幾個測試，把它推過 85%。在那之前，先看**那 50 行是哪 50 行**。

### 8.7.2 讀沒跑到的那幾行

另一支小腳本（`uncovered.py`，同樣不提供）從 `jacoco.xml` 列出每一個原始檔裡「一個指令都沒執行過」的行，連同原始碼。不寫腳本也看得到同一件事：`target/site/jacoco/index.html` 一路點進原始檔，紅色的行就是。`inventory` 的：

```
── inventory/internal/JdbcInventoryService.java：16 行沒跑到
     72 │ if (isHot) {
     73 │ if (!TransactionSynchronizationManager.isSynchronizationActive()) { hot.initialize(productId); return; }
     74 │ TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
     76 │ public void afterCommit() { hot.initialize(productId); }       // commit 之後才讀 MySQL：讀到的是這次之後的可售量
     79 │ hot.removeAfterCommit(productId);
    243 │ List<Object[]> upd = new ArrayList<>(lines.size()), led = new ArrayList<>(lines.size());
    244 │ for (RestockLine l : lines) {
    ……（到 254 行）
── inventory/internal/InventoryReconciliation.java：8 行沒跑到
     58 │ Map<String, Long> out = new LinkedHashMap<>();
     59 │ CHECKS.forEach((name, sql) -> {
     60 │ long diff = jdbc.queryForObject(sql, Long.class);
     ……
── inventory/internal/HotStock.java：10 行沒跑到
    103 │ throw unavailable();
    112 │ log.warn("HOT_STOCK_GIVE_BACK_FAILED {}（等對帳修正：在那之前這些數量賣不出去）", lines);
    124 │ throw new IllegalStateException("Redis 不能用，熱點庫存加不回去：" + lines);
    155 │ Runnable del = () -> guard.run("hot-stock.remove", () -> redis.delete(key(productId)));
    ……
── inventory/internal/Inventory.java：5 行沒跑到           ← JPA entity 的 getter
── inventory/internal/Reservation.java：5 行沒跑到         ← 同上
── inventory/internal/InventoryEventHandlers.java：2 行沒跑到   ← 加回 Redis 進了死信時的一行日誌
```

把它們分成四種：

| 種類 | 哪幾行 | 怎麼辦 |
|---|---|---|
| **沒有人用的程式碼** | `restockBatch()`（243～254） | 刪掉 |
| **沒有被測過的功能** | `setHot()`（72～81）、`InventoryReconciliation.checkInvariants()`（58～65）、`HotStock.removeAfterCommit()`（155～161） | 寫測試 |
| 失敗的路徑 | `HotStock` 的 103、112、124；`InventoryEventHandlers` 的死信日誌 | 看情況 |
| 沒有行為的程式碼 | entity 的 getter | 不管 |

> ⚠️ **刪之前先看第 01 章的 B1**：`src/test/java/com/example/shop/ch01/B1BypassOwnerTest` 的做法三呼叫了 `InventoryApi.restockBatch()`（1.2.1）。`grep -rn restockBatch src/main` 找不到它，因為它在 `src/test`；刪掉介面方法之後測試編譯會失敗。把 B1 的做法三刪掉（它要示範的「交給主人、一次批次」已經量完了），或整個 B1 刪掉。

**`restockBatch()`：沒有任何呼叫者。** 它是第 01 章 1.2.1 舉例用的「批次補貨，給匯入功能用」—— 這個專題沒有匯入功能（0.7 也沒有列）。`grep -rn restockBatch src/main` 只找到它自己的宣告與實作。**沒有人用的公開 API，不寫測試，刪掉**：它是 `InventoryApi` 上的一個方法，別的模組隨時可以開始依賴它，而它從來沒有被執行過。（刪之前我看了一眼它有沒有藏著 bug：它把 `0` 當成 outbox 的 aggregate id 傳進去 —— 奇怪，但無害。）

**`setHot()`：賣家把商品標成熱點的那支 API（`POST /api/seller/products/{id}/hot`，6.5）。** 第 06 章之後的每一個熱點測試，都是 `UPDATE products SET hot = TRUE` 直接改表；`IdorMatrixTest` 打過這支 API，但永遠用**別人**的身分（404）。「標成熱點 → commit 之後從 MySQL 建 Redis 的閘門」「取消熱點 → commit 之後刪掉閘門」這兩條路，**從來沒有被任何測試走過**。

**`InventoryReconciliation.checkInvariants()`：第 07 章 7.10 的每小時對帳排程。** 7.12.3 的追溯表那一列寫的是「INV-2、INV-3 ｜ `InvariantReconciliationTest`；對帳排程 `InventoryReconciliation`（7.10）｜ ✅ 02、07」。**排程的程式碼，一行都沒有被測試執行過** —— 它每小時一次，第一次在啟動之後一個小時（7.10 刻意的），而沒有一個測試活那麼久。`InvariantReconciliationTest` 用的是它自己的一份 SQL。

而那兩份 SQL 已經不一樣了：

```java
// InventoryReconciliation（正式的排程）
CHECKS.put("INV-2", …);
CHECKS.put("INV-3", …);

// InvariantReconciliationTest（測試）
CHECKS.put("INV-2 reserved = Σ 有效且已計入的預留", …);
CHECKS.put("INV-3 on_hand = Σ ledger.delta_on_hand", …);
CHECKS.put("INV-3' reserved = Σ ledger.delta_reserved", …);     ← 排程沒有這一條
```

INV-3' 是第 02 章 2.5.5 加的（「`reserved` 的兩個獨立驗證：跟預留表比、跟帳比」）；第 07 章把對帳搬進排程時沒有搬它。**測試一直在檢查一件排程從來不檢查的事** —— 測試是綠的，正式環境的每小時對帳少了一條。

其他模組也看一遍（只列有意思的）：

```
── ordering/internal/web/OrderCommandController.java：3 行沒跑到
     58 │ return commands.cancelByBuyer(user.require(Role.BUYER).id(), orderNo);
     63 │ return commands.confirmReceipt(user.require(Role.BUYER).id(), orderNo);
     69 │ return commands.startPayment(user.require(Role.BUYER).id(), orderNo);
── ordering/internal/web/SellerOrderCommandController.java：3 行沒跑到
     22 │ return commands.startPicking(user.require(Role.SELLER).id(), orderNo);
     27 │ return commands.ship(user.require(Role.SELLER).id(), orderNo, req.carrier().strip(), req.trackingNo().strip());
     32 │ return commands.cancelBySeller(user.require(Role.SELLER).id(), orderNo);
── ordering/internal/web/PaymentCallbackController.java：3 行沒跑到
     27 │ service.handle(new PaymentApi.Callback(req.paymentId(), req.providerTxnId(), req.amount(),
     28 │ "SUCCEEDED".equals(req.result()), req.signature()));
── ordering/internal/IdempotencyKeys.java：4 行沒跑到
     97 │ int n = jdbc.update("""
    100 │ Timestamp.from(now.plus(LEASE)), buyerId, key, Timestamp.from(now));
    101 │ return n == 1 ? new Claimed() : new InProgress();
── reporting/internal/SalesReportService.java：20 行沒跑到       ← 整個類別
```

**`ordering` 94.1% 的那個模組，六個訂單動作的 HTTP 入口、金流回呼的 HTTP 入口，一個都沒有跑過。** 訂單的每一條 AC 都由 `OrderFlowTest` 驗證過 —— 直接呼叫 Service；HTTP 這一層（JSON 怎麼變成參數、`"SUCCEEDED"` 這個字串怎麼變成 boolean、物流單號前後的空白、哪一個例外變成哪一個狀態碼）沒有。ORD-2 AC-3 寫的是「簽章錯誤 → **401**」、AC-4「金額不符 → **400**」—— 這兩個數字，沒有一個測試看過。

（這裡有一個 JaCoCo 的細節：`IdorMatrixTest` 其實打過其中五支 API —— 用別人的身分，Service 丟出 404。**JaCoCo 的探針放在「一個呼叫之後」，呼叫丟出例外的那一行，算成沒有執行**。所以那幾行的正確讀法是「**從來沒有被成功地呼叫過**」。補了成功路徑的測試之後，`OrderCommandController` 第 58 行從「9 個指令沒跑、0 個跑了」變成「0 個沒跑、9 個跑了」。）

**`IdempotencyKeys` 97～101：「租約過期，接手」**（4.5.1 的 V11）。冪等鍵被 claim 了、還沒 complete，行程就死了 —— 30 秒後下一個帶同一個鍵的請求要能接手。7.2.2 的每一次 `kill -9` 都可能留下這樣的一列（行程死在 claim 之後、complete 之前），但沒有一個測試驗證過接手的那三行。

**`SalesReportService`：整個賣家日報表（US-RPT-1），0%。** 第 03 章量它的 D4、D6 都是**實驗**（`@Tag("experiment")`），跑在 10 萬張種子訂單上 —— 不在 `mvn test` 裡。第 03 章追溯表的那一列是「RPT-1 AC-1～3 ｜ `SalesReportService`（每日一列、台北切日、366 天上限）｜ ✅ 03」—— **驗證方式那一欄寫的是一個類別，不是一個測試**。每一次建置，都沒有人檢查它。（下一列「RPT-1 AC-4 ｜ ✅ 03（負載下在 08）」是這一章的另一筆債，8.6。）

> 📌 **覆蓋率報表最有用的時候，不是看百分比，是一行一行讀沒跑到的地方** —— 它會告訴你追溯表在哪裡說謊。這一節找到的四件事（一個排程從沒被執行、一份 SQL 已經漂移、六個 HTTP 入口沒走過成功的路、一張報表只有實驗在量），沒有一件是「把 inventory 從 83% 推到 85%」會找到的：**`ordering` 是 94%，`reporting` 根本沒有門檻。**

### 8.7.3 補什麼、刪什麼

| 新的測試（或改的） | 守什麼 | 第一次跑 |
|---|---|---|
| `api.OrderHttpFlowTest`（3 個） | 下單 → 付款 → 回呼（真的簽章）→ 撿貨 → 出貨 → 確認收貨，全部走 HTTP；回呼的 AC-3～AC-8 的狀態碼；賣家取消已付款的訂單 | 綠 |
| `api.HotToggleApiTest` | 標成熱點 → 閘門 = MySQL 可售量、下單走閘門；取消熱點 → 閘門刪掉、下單回到 MySQL | 綠 |
| `api.SellerReportApiTest`（2 個） | RPT-1 AC-1～AC-3：三張卡在台北午夜的訂單、沒有訂單的日子也有一列、366 天上限 | 綠 |
| `OrderFlowTest.processingLeaseTakeover` | 租約還在 → 409 in-progress；租約過期 → 接手並成立 | 綠 |
| `InvariantReconciliationTest` | 改成呼叫正式的 `InventoryReconciliation`；故意弄壞一筆，確認它抓得到 | 綠 |
| `InventoryReconciliation` | ＋ INV-3' | —— |
| `InventoryApi.restockBatch` | 刪掉 | —— |

（`OrderHttpFlowTest`、`HotToggleApiTest`、`SellerReportApiTest`、`OrderFlowTest.processingLeaseTakeover` 與改過的 `InvariantReconciliationTest`，完整內容在 8.10.1。）

**五個新的測試，第一次跑全部是綠的。** 它們沒有找到 bug —— 它們把「沒有人看過」變成「每次建置都有人看」。（8.4.5 那一個 bug 是 Testcontainers 找到的，不是覆蓋率。）其中幾段輸出：

```
8.7 HTTP：回呼 200（12 ms）→ PAID；撿貨 200 → PICKING；出貨 200 → SHIPPED {carrier=黑貓, tracking_no=T-861}；確認收貨 200 → COMPLETED
8.7 HTTP 回呼：簽章錯 401（稽核 1 筆）、金額錯 400、FAILED 200 → 訂單 PENDING_PAYMENT、付款 FAILED；成功 200、重送 200 → PAID；取消 200 之後晚到 200 → CANCELLED、退款 [LATE_PAYMENT]
8.7 標熱點 200 → stock:9900881 = 5；下單 201 → 4（counted=0）；取消熱點 200 → 閘門還在 false；下單 201（counted=1）
8.7 RPT-1（Asia/Taipei）HTTP 200
    2026-09-30 訂單 1、付款 0.0、退款 0.0、淨額 0.0
    2026-10-01 訂單 2、付款 400.0、退款 0.0、淨額 400.0
    2026-10-02 訂單 0、付款 0.0、退款 50.0、淨額 -50.0
8.7 RPT-1 AC-3：367 天 → 400，結束日早於開始日 → 400
```

（回呼 12 ms：ORD-2 AC-8 要的是 3 秒。出貨的 `"  黑貓  "` 存進去是 `黑貓` —— `.strip()` 那一行第一次被執行。）

對帳的那一個，改成呼叫正式的排程，並且**證明它抓得到東西**。有一個編譯上的小問題：`InventoryReconciliation` 是 `inventory.internal` 的 package-private 類別，這個測試在 `schema` 套件，直接呼叫編譯不過。`invariants()` 用反射拿 bean、呼叫它的 `checkInvariants()` —— 跟 `HotSettlementTest` 呼叫 `HotStock.reconcile` 同一招：

```java
Object job = ctx.getBean(Class.forName("com.example.shop.inventory.internal.InventoryReconciliation"));
var m = job.getClass().getDeclaredMethod("checkInvariants");
m.setAccessible(true);
return (Map<String, Long>) m.invoke(job);
```

```java
// 它抓得到東西嗎？把工作負載的一個商品的 reserved 多加 1（模擬一個「改了數字、沒寫預留也沒記帳」的 bug）
jdbc.update("UPDATE inventory SET reserved = reserved + 1 WHERE product_id = ?", victim);
Map<String, Long> broken = invariants();
double gauge = ctx.getBean(io.micrometer.core.instrument.MeterRegistry.class).get("shop.reconciliation.diff").tag("check", "INV-2").gauge().value();
jdbc.update("UPDATE inventory SET reserved = reserved - 1 WHERE product_id = ?", victim);
```

```
  正式的對帳排程 InventoryReconciliation {INV-2=0, INV-3=0, INV-3'=0}        5 ms
  故意讓商品 9908001 的 reserved 多 1 → {INV-2=1, INV-3=0, INV-3'=1}；指標 shop.reconciliation.diff{check=INV-2} = 1
```

**一個對帳測試要證明兩件事：對的時候它說 0，錯的時候它不說 0。** 第 02 章以來它只證明了前一件。

### 8.7.4 門檻

0.6.8 的四個數字，各是一個 `check` execution；模組用 `includes` 圈出來：

```xml
<!-- 0.6.8：整體行覆蓋 ≥ 70%；ordering、inventory、payment 三個模組各 ≥ 85%。
     JaCoCo 的 PACKAGE 只看單一套件（ordering.internal 與 ordering.internal.web 是兩個），所以「模組」用 includes 圈出來，各自當一個 BUNDLE 檢查 -->
<execution>
  <id>coverage-overall</id><phase>verify</phase><goals><goal>check</goal></goals>
  <configuration>
    <rules><rule><element>BUNDLE</element><limits><limit><counter>LINE</counter><value>COVEREDRATIO</value><minimum>0.70</minimum></limit></limits></rule></rules>
  </configuration>
</execution>
<execution>
  <id>coverage-inventory</id><phase>verify</phase><goals><goal>check</goal></goals>
  <configuration>
    <includes><include>com/example/shop/inventory/**</include></includes>
    <rules><rule><element>BUNDLE</element><limits><limit><counter>LINE</counter><value>COVEREDRATIO</value><minimum>0.85</minimum></limit></limits></rule></rules>
  </configuration>
</execution>
<!-- coverage-ordering、coverage-payment 一樣 -->
```

門檻要先看它會紅。把同一份 pom 套到補測試之前的那個 commit（另一個 worktree）：

```
[WARNING] Tests run: 179, Failures: 0, Errors: 0, Skipped: 1
[INFO] All coverage checks have been met.
[INFO] All coverage checks have been met.
[WARNING] Rule violated for bundle shop: lines covered ratio is 0.83, but expected minimum is 0.85
[INFO] BUILD FAILURE
[ERROR] Failed to execute goal org.jacoco:jacoco-maven-plugin:0.8.15:check (coverage-inventory) on project shop: Coverage checks have not been met. See log for details. -> [Help 1]
```

如果你是照著這一章一步一步做：**先補 8.7.3 的測試、刪掉 `restockBatch`，再加這四個 `check`**；順序反過來，`mvn clean verify` 會像上面一樣停在 `coverage-inventory`。想先看看自己的數字，可以先在每一個 `check` 的 `<configuration>` 裡加 `<haltOnFailure>false</haltOnFailure>` 跑一次（沒過只印 `WARNING`，不讓建置失敗），看完再拿掉 —— 你的程式碼跟這裡的不會一行不差，百分比也不會一樣。

兩個小坑：**`WARNING` 那一行只說「bundle shop」，是哪一個模組要看 `ERROR` 那一行的 execution id**（`coverage-inventory`）—— 這是我把 id 取成模組名稱的理由；以及 **Maven 在第一個沒過的 `check` 就停了**，`coverage-payment` 根本沒有跑，所以一次只看得到一個模組沒過。

補完測試、刪掉 `restockBatch` 之後：

```bash
mvn clean verify
```

```
[WARNING] Tests run: 186, Failures: 0, Errors: 0, Skipped: 1
[INFO] All coverage checks have been met.
[INFO] All coverage checks have been met.
[INFO] All coverage checks have been met.
[INFO] All coverage checks have been met.
[INFO] BUILD SUCCESS
[INFO] Total time:  03:25 min
```

```
  模組                          行      行覆蓋             分支     分支覆蓋
  account           225 / 238       94.5%      73 / 98       74.5%
  cart               56 / 62        90.3%      18 / 26       69.2%
  catalog           200 / 215       93.0%      60 / 86       69.8%
  inventory         268 / 286       93.7%      84 / 108      77.8%
  notification       58 / 62        93.5%      19 / 22       86.4%
  ordering          478 / 495       96.6%     170 / 205      82.9%
  payment           114 / 130       87.7%      24 / 36       66.7%
  reporting          53 / 53       100.0%      17 / 20       85.0%
  shared            707 / 795       88.9%     156 / 230      67.8%
  ＝ 全部             2160 / 2339      92.3%     621 / 831      74.7%
```

`inventory` 83.1% → 93.7%：分母少了 10 行（`restockBatch`），分子多了 22 行。**兩邊都是 inventory 真的變了**，不是為了數字。

### 8.7.5 92% 的覆蓋率，抓得到 bug 嗎

覆蓋率說的是「這一行被執行過」，不是「這一行錯了會有人發現」。I8 是一個手工的突變測試：在覆蓋率很高、而且最重要的地方，各放一個**只改一行、看起來很合理**的 bug，跑完整的 `mvn clean test`，看哪些測試紅：

```bash
python3 mutants.py <shop> I8-mutants.log      # 每一個：改一行 → mvn clean test → git checkout 改回來（mutants.py 不提供）
```

| 突變 | 改了什麼 | 紅了幾個 | 被誰抓到 |
|---|---|---|---|
| M1 | 取消時不記 `RELEASE` 的帳（`JdbcInventoryService.release` 少一行） | 2 | `OrderRaceRegressionTest.threeSchedulers`、`InvariantReconciliationTest`（INV-3'） |
| M2 | 取消時連「還沒計入」的熱點預留也減 `reserved`（`if (h.counted())` → `if (true)`） | 3 | `HotSettlementTest.cancelBeforeSettlement`、`HotStockFlowTest.cancelAndRestockAddBack`、`InvariantReconciliationTest` |
| M3 | 退款的冪等鍵每次都不一樣（`"refund-" + refundId` → `"refund-" + UUID.randomUUID()`） | **0** | **沒有 —— 突變存活** |
| M4 | 通知的認領不檢查 `attempts`（`AND attempts = ?` 拿掉） | 1 | 驗收 Q10 |
| M5 | 金額比對只擋「付太多」（`!= 0` → `< 0`） | 3 | `OrderHttpFlowTest.callbackStatusCodes`、`AuditPlacementTest.amountMismatch`、`OrderFlowTest.badCallbacks` |
| M6 | `RedisGuard` 失敗一次就跳開（`TRIP_AFTER = 3` → `1`，6.4.5 的第一版） | 1 ＋ **建置卡住 19 分鐘** | `TrendingDegradedTest`；`ProductCacheTest` 永遠等下去 |
| M7 | 冪等鍵的租約判斷反過來（`isAfter` → `isBefore`） | 1 | `OrderFlowTest.processingLeaseTakeover`（8.7.3 才加的） |

（每一個突變一次完整的 `mvn clean test`，194～210 秒，load average 4.1～11.1；M6 是 1,149 秒，下面說。跑完之後 `git status` 是空的：七個都改回去了。）

**七個裡抓到六個。** 但每一個「抓到」都值得再看一眼：

**M3 存活：186 個測試，全部綠。** 退款的冪等鍵是第 07 章 7.2.3 整個事故的答案（「沒有冪等鍵：20 筆退款退了 40 次錢」）。證明它的是 H3 —— 一個**實驗**。`mvn test` 裡唯一的退款測試（`EventFlowTest.cancelPaidRefunds`）斷言「金流實際退款 1 次」，但那一次的回應從來沒有丟過：冪等鍵根本沒有被用到，換成什麼都一樣。**這一行有被執行（覆蓋率 100%），它的意義沒有被測試。**

把 H3 的 ③ 搬進 `EventFlowTest`：讓模擬的金流「錢退了、回應沒回來」一次，經過真的 RabbitMQ 與重試階梯：

```java
gateway.loseResponseNext(1);                                        // 第一次呼叫：錢退了、回應逾時
commands.cancelByBuyer(BUYER, o.orderNo());
await().atMost(WAIT).until(() -> … refunds … contains("SUCCEEDED"));
assertThat(gateway.calls()).as("第一次 + 重試").isEqualTo(2);
assertThat(gateway.moneyOutFor(pid)).isEqualTo(1);
assertThat(refund).containsEntry("attempts", 2);
```

```
7.2.3 ③：回應丟了一次 → 退款 {status=SUCCEEDED, attempts=2}；金流被呼叫 2 次、實際退款 1 次
```

同一個 M3 再跑一次：

```
M3 退款的冪等鍵每次都不一樣｜load { 7.97 7.51 6.73 }｜211 秒｜('188', '1', '0', '1')｜紅的：['com.example.shop.ordering.internal.EventFlowTest.refundResponseLostOnce']
```

**H3 證明過一次的事，現在每一次建置都證明一次。** 實驗量的是「多嚴重」，回歸測試守的是「還成立嗎」—— 7.2.3 的 ① ② ③ 是前者；這一個是後者。

**M6 抓到了，但代價是一個不會結束的建置。** `TrendingDegradedTest`（8.4.5 寫的）紅了 —— 它斷言「一次失敗不會跳開」。真正的問題是另一個：`ProductCacheTest.waitersSeeTheOriginalException` 停在這一行，19 分鐘：

```java
loading.await();                     // 等「負責讀 MySQL 的那一個」開始
```

M6 讓前面某個測試的一次注入失敗把**共用的** `RedisGuard` 跳開了，`cache.get` 走降級路徑、根本沒有呼叫 loader —— `loading` 永遠不會倒數。我在第 19 分鐘取了執行緒堆疊、把那個 JVM 殺掉。**一個沒有上限的等待，把「一個 bug」變成「一個卡住的建置」**：在 CI 上，它會等到 `timeout-minutes`（8.8：20 分鐘），然後告訴你「逾時」，而不是告訴你哪一個測試、為什麼。改成：

```java
// 8.7.5：第一版是 loading.await()，沒有上限。I8 的突變 M6（RedisGuard 失敗一次就跳開）讓別的測試的一次失敗把共用的 guard 跳開，
// cache.get 走降級路徑、根本沒有呼叫 loader —— 這一行等了 19 分鐘，整個建置停在這裡。等不到要變成紅燈，不是永遠等
assertThat(loading.await(5, TimeUnit.SECONDS)).as("負責讀 MySQL 的那一個開始了（guard 沒有跳開）").isTrue();
```

（同一個測試裡的 `release.await()`、`leader.get()`、`waiter.get()` 也都加了上限。）

**M7 只被一個測試抓到 —— 8.7.3 因為覆蓋率報表才加的那一個。** 把同一個 M7 套到補測試之前的那個 commit（179 個測試）：

```
M7 冪等鍵的租約判斷反過來｜load { 6.74 7.99 7.20 }｜177 秒｜('179', '0', '0', '1')｜紅的：沒有 —— 突變存活
```

**179 個全綠。** 驗收 Q3（同一個鍵同時送 10 次）走的是「租約還在」的那一半：`isAfter` 換成 `isBefore` 之後，租約還在的請求落到下面的條件式 UPDATE（`locked_until <= now`），一樣什麼都改不到、回 `InProgress` —— 結果碰巧一樣。壞掉的是「租約過期、接手」的那一半，而那一半只有覆蓋率報表看得到它沒人測過。

**M1 是「對帳抓到」的。** `OrderRaceRegressionTest.threeSchedulers` 數的是 `RELEASE` 帳的筆數；`InvariantReconciliationTest` 抓到的是 INV-3'（`reserved` 跟帳對不上）—— **8.7.3 才從測試搬進正式排程的那一條**。在第 07 章的寫法下（對帳跑在種子資料上、種子資料是產生器寫的、不經過 `release()`），這個 bug 只會被 `threeSchedulers` 抓到。

依 8.3 的四層看，抓到這七個突變的測試：第 ① 層 1 個（`TrendingDegradedTest`：M6）、第 ② 層 5 個（M1、M2、M5、M7，以及補了測試之後的 M3）、第 ③ 層 1 個（驗收 Q10：M4）。**第 ④ 層（Q9，`kill -9`）一個都沒有抓到** —— 它守的是「行程死掉的時候事件不會掉」，不是任何一行邏輯；它花 11～13 秒，是在為另一種 bug 付錢。反過來，最便宜的第 ① 層只抓到一個，因為這七個突變有六個都在「SQL 與交易」裡，那一層的單元測試碰不到。

> ⚠️ **M4 的那一行已經不在了。** Q10 抓到 M4，是因為 10 份投遞同時到、讀到同一個 `attempts`。但「條件是 `attempts` 還是 n」本身就擋不住另一個順序 —— 一份在另一份認領之後、寄完之前才讀（7.7.2）。Q10 偶爾紅（`notification_attempts=2`），抓到的就是它：**同一個驗收測試，在這裡是突變的偵測器，在那裡是一個真的 bug 的偵測器，只是它只有在時機剛好時才看得到後者。** 修正把認領改成租約（V26 `claimed_until`），`AND attempts = ?` 跟著拿掉了。同一個意思的突變換成「拿掉租約的條件」，只跑 `NotificationClaimTest`：3 個裡紅 2 個（第 ② 層，每一次都紅，不靠時機）。參考實作的 `ch08` 分支上還是改之前的寫法。

> 📌 **覆蓋率與突變回答不同的問題：** 覆蓋率問「這一行有沒有被執行」，突變問「這一行錯了，有沒有人會發現」。M3 的那一行覆蓋率是 100%，意義是 0%。
> 這一節是手工的七個，挑的是我知道重要的地方；工具（例如 PIT）會在每一行自動做這件事 —— 對一個要起容器的測試套件來說，一個突變 3 分鐘，七個就是 25 分鐘。這是練習三。

---

## 8.8 CI：一台什麼都沒有的機器

### 8.8.1 流程

0.6.8 要「OpenAPI 的破壞性變更在 CI 檢查」、第 02 章說「CI 永遠從 `mvn clean verify` 開始」。`.github/workflows/ci.yml`：

```yaml
# 第 08 章（8.8）：每一次 push、每一個 PR，都從一台什麼都沒有的機器開始。
# 這台機器上沒有 docker compose、沒有種子資料、沒有任何人的 ~/.m2 —— 測試要的 MySQL、Redis、RabbitMQ 由 Testcontainers 自己起（8.4）。
# mvn verify 包含：單元與整合測試、驗收題、OpenAPI 快照（3.8.2）、ArchUnit（第 01 章）、覆蓋率門檻（8.7.4）。
name: ci

on:
  push:
    branches: [master]
  pull_request:

jobs:
  verify:
    runs-on: ubuntu-latest
    timeout-minutes: 20            # 筆電上 3～4 分鐘；超過 20 分鐘多半是某個測試在等一個不會來的東西（7.9.4）
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-java@v4
        with:
          distribution: temurin
          java-version: '21'
          cache: maven             # ~/.m2 的快取：只省下載的時間，不影響測試（每一次的容器都是新的）
      - name: mvn verify
        run: mvn -B -ntp verify
      - name: 測試與覆蓋率報告
        if: always()               # 紅了更要看
        uses: actions/upload-artifact@v4
        with:
          name: reports
          path: |
            target/surefire-reports/
            target/site/jacoco/
            target/q9-child.log
```

**整個流程只有一行在做事：`mvn -B -ntp verify`。** 那是刻意的 —— CI 做的事跟你在筆電上打的命令一模一樣，CI 紅了，你在自己的機器上打同一行就看得到同一個紅燈。CI 裡沒有任何「只在 CI 才跑」的步驟，也沒有任何「CI 上跳過」的測試。

**這個專題的 shop repo 沒有放到 GitHub 上，這個檔案在 GitHub 上一次都沒有跑過。** 所以 8.8.2 用另一個方法確認「它在一台什麼都沒有的機器上跑得起來」。

### 8.8.2 一台真的什麼都沒有的機器

`ubuntu-latest` 的 runner 跟我的筆電差在哪裡？沒有 compose、沒有種子資料、沒有 `~/.m2`、時區是 UTC、作業系統是 Linux、只有 repo 裡**有 commit 的**檔案。I11 用一個新的容器模擬它：

```bash
git archive --format=tar HEAD | docker run -i --rm \
  -v /var/run/docker.sock:/var/run/docker.sock -e TESTCONTAINERS_HOST_OVERRIDE=host.docker.internal \
  maven:3.9-eclipse-temurin-21 bash -c 'mkdir /work && cd /work && tar -x && mvn -B -ntp verify'
```

- `git archive HEAD`：只有 commit 了的檔案（我的工作目錄裡沒有 commit 的東西進不去）。
- `maven:3.9-eclipse-temurin-21`：Java 21.0.12、Maven 3.9.16，`~/.m2` 是空的（每一個依賴都要重新下載），時區 UTC，`LANG=en_US.UTF-8`。
- 掛進 Docker 的 socket：Testcontainers 在容器裡起的 MySQL、Redis、RabbitMQ 是它的「兄弟」容器，`TESTCONTAINERS_HOST_OVERRIDE` 讓它用 `host.docker.internal` 連過去（GitHub 的 runner 上不需要這一行：測試直接跑在有 Docker 的機器上）。
- `host.docker.internal` 是 Docker Desktop 提供的名字。在 Linux 原生的 Docker 上，容器裡預設解析不到它，要在 `docker run` 多帶一個 `--add-host=host.docker.internal:host-gateway`。這一節的三次都是在 Docker Desktop 上跑的，Linux 的版本我沒有跑過。

**第一次：**

```
TEST_INFRA testcontainers 啟動 11,912 ms：mysql jdbc:mysql://host.docker.internal:54406/shop、redis host.docker.internal:35153、rabbitmq host.docker.internal:54403
[ERROR] com.example.shop.acceptance.CapstoneAcceptanceTest.q8_redisOutageDegrades -- Time elapsed: 1.389 s <<< ERROR!
[ERROR] com.example.shop.acceptance.HealthProbeTest.probesFollowDependencies -- Time elapsed: 1.076 s <<< ERROR!
[ERROR] Tests run: 188, Failures: 0, Errors: 2, Skipped: 1
[INFO] Total time:  03:02 min
```

```
java.lang.IllegalStateException: docker start dbf2f92add2c9161bdb231a63a3283a0fa07f5bfbc175ec9b0f1943f1b33c471
Caused by: java.io.IOException: Cannot run program "docker": Exec failed, error: 2 (No such file or directory)
```

**這個映像檔裡沒有 `docker` 這個程式** —— 只有掛進來的 socket。Q8 與 `HealthProbeTest` 用 `new ProcessBuilder("docker", "stop", …)` 停容器。（例外訊息說的是 `docker start`：`docker stop` 先失敗了，`finally` 裡的 `docker start` 又失敗一次，蓋掉了原本那一個 —— `finally` 裡會丟例外的程式碼，會吃掉真正的原因。）GitHub 的 `ubuntu-latest` 有 docker 的命令列，所以在那裡這兩個測試大概不會紅；但「CI 的機器上剛好有某個程式」跟「compose 剛好開著」是同一種依賴。Testcontainers 本來就有一個跟 Docker daemon 講話的用戶端，改用它：

```java
/**
 * docker stop / start / pause / unpause 一個容器（驗收 Q8、HealthProbeTest）。
 * 8.8：第一版是 new ProcessBuilder("docker", ...) —— CI 的映像檔（maven:3.9-eclipse-temurin-21）裡沒有 docker 這個程式，
 * 只有掛進來的 socket。Testcontainers 本來就有一個跟 daemon 講話的用戶端，用它（compose 模式下一樣可以用容器名稱）
 */
public static void docker(String action, String container) {
    var client = org.testcontainers.DockerClientFactory.instance().client();
    try {
        switch (action) {
            case "stop" -> client.stopContainerCmd(container).exec();
            case "start" -> client.startContainerCmd(container).exec();
            case "pause" -> client.pauseContainerCmd(container).exec();
            case "unpause" -> client.unpauseContainerCmd(container).exec();
            default -> throw new IllegalArgumentException(action);
        }
    } catch (com.github.dockerjava.api.exception.NotModifiedException | com.github.dockerjava.api.exception.ConflictException already) {
        // 已經是那個狀態了（Q8 的 finally 會再 start 一次）：docker 的命令列在這種情況下什麼都不說，這裡也一樣
    }
}
```

（那個 `catch` 是換了之後才知道要的：命令列的 `docker start` 對一個已經在跑的容器什麼都不說，API 會回 304 `NotModifiedException`；Q8 在中間 start 一次、`finally` 又 start 一次。）

換了之後，`CapstoneAcceptanceTest` 自己那個 `static void docker(String... args)`（`new ProcessBuilder("docker", …)`）刪掉，Q8 的三處呼叫 —— `stop`、60 秒後的 `start`、`finally` 裡的 `start` —— 全部改成 `com.example.shop.support.TestInfra.docker(…, com.example.shop.support.TestInfra.redisContainer())`。

**第二次：**

```
[ERROR] com.example.shop.ordering.internal.EventFlowTest.cancelPaidRefunds -- Time elapsed: 0.407 s <<< FAILURE!
Expecting actual:
  ["REFUND_SUCCEEDED",
    "ORDER_PAID",
    "ORDER_PLACED",
    "ORDER_CANCELLED",
    "REFUND_SUCCEEDED"]
to contain exactly in any order:
  ["ORDER_PLACED", "ORDER_PAID", "ORDER_CANCELLED", "REFUND_SUCCEEDED"]
but the following elements were unexpected:
  ["REFUND_SUCCEEDED"]
[ERROR] Tests run: 188, Failures: 1, Errors: 0, Skipped: 1
[INFO] Total time:  04:18 min
```

Q8 與 `HealthProbeTest` 綠了，**另一個紅了 —— 是我自己在 8.7.5 加的那一個測試造成的。** 買家收到兩封「退款成功」，第一封還排在「付款成功」之前：它是上一個測試 `refundResponseLostOnce` 的。那個測試等到退款單變成 `SUCCEEDED` 就結束了，但「退款成功」的通知還在路上（重試階梯之後才寄）；寄到的時候 `cancelPaidRefunds` 已經開始、已經 `mailer.reset()` —— 兩個測試用的是同一位買家。在四次完整的本機建置（I4b、I4c 各兩次）、一次單獨跑、第一次乾淨機器上它都是綠的；這一次的容器裡比較慢，信晚了幾百毫秒。

這就是 8.5 的規矩 ⑥（同一次建置裡的別人）—— 我自己剛寫的測試違反了它。修法是讓它等自己的信寄完才結束：

```java
// 8.8：第一版到這裡就結束了。「退款成功」的通知還在路上（重試階梯之後才寄），寄到的時候下一個測試已經開始、
// 已經 mailer.reset() —— cancelPaidRefunds 的買家（同一位）多了一封 REFUND_SUCCEEDED。CI 的容器比較慢，才看得到
await().atMost(WAIT).until(() -> sentTypes(BUYER, null).contains("REFUND_SUCCEEDED"));
```

（一個時間上的競態，重跑幾次是證明不了它消失的；我能說的是「它發生的那個機制被拿掉了」。）

**第三次：**

```
### CI 乾淨的機器 第 3 次 start 2026-10-05 15:25:43 load { 3.75 5.82 8.39 } commit afb32ef
TEST_INFRA testcontainers 啟動 9,299 ms：mysql jdbc:mysql://host.docker.internal:56151/shop、redis host.docker.internal:45319、rabbitmq host.docker.internal:56150
[WARNING] Tests run: 188, Failures: 0, Errors: 0, Skipped: 1
[INFO] All coverage checks have been met.
[INFO] All coverage checks have been met.
[INFO] All coverage checks have been met.
[INFO] All coverage checks have been met.
[INFO] BUILD SUCCESS
[INFO] Total time:  04:21 min
real	4m22.454s
```

**全綠，4 分 21 秒，包括把每一個依賴從網路下載到一個空的 `~/.m2`**（容器開始到第一行應用程式日誌是 65 秒：下載、編譯、前面幾個單元測試）。0.6.8 的「`mvn verify` < 5 分鐘（含 Testcontainers 整合測試）」—— 筆電上 3 分 45 秒（8.10），乾淨的機器上 4 分 21 秒。

三次乾淨機器的建置，抓到的三件事都是「我的筆電上剛好有」：

| | 我的筆電上有 | 乾淨的機器上沒有 | 誰靠著它 |
|---|---|---|---|
| 8.2.1 | compose 的 MySQL、Redis、RabbitMQ；10 萬張種子訂單 | 都沒有 | Q6、Q8、Q9、對帳測試 |
| 8.8.2 第一次 | `/usr/local/bin/docker` | 只有 socket | Q8、`HealthProbeTest` |
| 8.8.2 第二次 | 一個比較快的 CPU | 一個比較慢的容器 | `refundResponseLostOnce` 與它後面的那一個 |

而它們**沒有**抓到的一件：時區。這台筆電是 `Asia/Taipei`，容器是 UTC，188 個測試裡沒有一個因此紅 —— 第 02 章「資料庫存 UTC、連線 `connectionTimeZone=UTC`」與第 03 章「台北切日由 Java 換算」的決定，在這裡被一台 UTC 的機器確認了一次。

### 8.8.3 新人上手：兩個命令

0.6.8 的最後一列：「clone 之後 `docker compose up -d --wait && mvn spring-boot:run` **兩個命令**就能跑起來」。I12 在一個新的 `git clone` 裡照做：

```
### 新人：git clone 之後兩個命令 15:34:35 load { 7.45 7.60 8.10 }
 Container shop-rabbitmq-1 Healthy 
 Container shop-redis-1 Healthy 
 Container shop-mysql-1 Healthy 
```

```
***************************
APPLICATION FAILED TO START
***************************

Description:

Web server failed to start. Port 8080 was already in use.
```

**第二個命令失敗了：8080 被這台機器上另一個專案的容器佔著。** 那不是這個專題的東西，我沒有動它。換一個埠，同樣的兩個命令：

```bash
mvn spring-boot:run -Dspring-boot.run.arguments=--server.port=18090
```

```
Started ShopApplication in 4.687 seconds (process running for 4.846)
ping={"service":"shop","time":"2026-10-05T07:35:57.295304Z"} readiness={"status":"UP","components":{"db":{"status":"UP","details":{"database" 商品3=200
```

**兩個命令成立，前提是 8080 是空的。** 這一列我記成「✅，前提是 8080、3306、6379、5672、15672 都空著」（8.9.3）—— 一個「兩個命令」的承諾，最常壞在第三件沒寫出來的事上。（`compose.yaml` 的 3306、6379、5672、15672 也一樣：這台機器上它們剛好就是 compose 自己。）

（這一次用的是 compose 已經在跑的那一組容器，`up -d --wait` 8 秒就回來了；我沒有在一台連映像檔都沒有的機器上量第一次 `up` 要多久。）

---

## 8.9 流程測試與追溯表

### 8.9.1 0.10.6 的腳本，變成一個測試

0.12.2 的追溯表有一列「0.6.3 readiness / liveness ｜ 0.10.6 的腳本 → 改寫成整合測試 ｜ 00 ✅、08」。0.10.6 的腳本依序讓 Redis、MySQL 停掉，每一次看 `health`、`health/liveness`、`health/readiness` 三個端點。`acceptance/HealthProbeTest` 做一樣的事，只有一個不同：**MySQL 用 `pause`，不用 `stop`** —— 那一台是整次建置共用的，`stop` 之後埠會換（8.4.4），後面所有的測試都連不上。每一個請求最多等 10 秒（`HttpRequest` 的 `timeout`），等不到記成「沒有回應」。MySQL 用 `TestInfra.docker("pause", TestInfra.mysqlContainer())`，恢復之後等 2 秒再看最後一列；完整內容在 8.10.1：

```
0.10.6 全部正常                   health HTTP 200（434 ms）       liveness HTTP 200（6 ms）         readiness HTTP 200（4 ms）
0.10.6 Redis 停掉               health HTTP 503（9 ms）         liveness HTTP 200（11 ms）        readiness HTTP 200（14 ms）
0.10.6 MySQL 卡住（pause）        health 沒有回應（10003 ms）         liveness HTTP 200（20 ms）        readiness HTTP 503（5019 ms）
0.10.6 全部恢復                   health HTTP 200（12 ms）        liveness HTTP 200（2 ms）         readiness HTTP 200（5 ms）
```

前兩列與最後一列跟 0.10.6 一模一樣。第三列是 0.10.6 沒有量過的：**MySQL 是「卡住」而不是「不在」的時候，readiness 還是 503，但要 5 秒才回答；完整的 `/actuator/health` 10 秒都沒有回答。**

那 5 秒是什麼？我的第一個猜測是 Hikari 的 `validationTimeout`（預設 5 秒：借出一條閒置的連線之前，先用 `isValid()` 檢查它）。改成 1 秒再跑一次（`-Dspring.datasource.hikari.validation-timeout=1000`）：

```
### validation-timeout=1000 load { 12.89 19.15 13.44 }
0.10.6 MySQL 卡住（pause）        health 沒有回應（10002 ms）         liveness HTTP 200（15 ms）        readiness HTTP 503（3017 ms）
### validation-timeout=5000 load { 9.88 17.54 13.14 }
0.10.6 MySQL 卡住（pause）        health 沒有回應（10005 ms）         liveness HTTP 200（22 ms）        readiness HTTP 503（5017 ms）
```

**1 秒的時候是 3 秒，不是 1 秒 —— 那個猜測只對了一半。** 3 秒是 `connection-timeout`（0.10.4 設的 3,000 ms）：驗證失敗、那一條連線被丟掉之後，Hikari 要建一條新的，而 MySQL 卡著，建不起來，等滿 `connection-timeout`。所以 readiness 的回答時間大約是兩個逾時裡比較長的那一個。（這是從兩個數字推的；我沒有再試第三組。）

這兩個數字還說了一件事：**這個專案的設定本身不對。** HikariCP 的文件寫的是 `validationTimeout` 要比 `connectionTimeout` 小；這裡是預設的 5,000 對 0.10.4 的 3,000，反過來了，而 Boot 3.2.5 用的 HikariCP 5.0.1 不會替你改正（它只檢查兩個值有沒有小於 250 ms）。readiness 的那 5 秒，就是這個組合。下一步是把 `spring.datasource.hikari.validation-timeout` 設得比 3,000 小（例如 1,000～2,000）。

> 📌 **改了，也量了。** `application.yml`（正式的設定，不只是測試）加了一行（參考實作的 `ch08` 分支上還是改之前的寫法）：
>
> ```yaml
> spring:
>   datasource:
>     hikari:
>       connection-timeout: 3000
>       validation-timeout: 1000   # 要比 connection-timeout 小：驗證失敗之後，3 秒的預算還剩 2 秒建一條新的（8.9.1）
> ```
>
> 先用 `javap -c` 確認 HikariCP 5.0.1 自己不會改正這個組合：`HikariConfig.validateNumerics()` 對 `validationTimeout` 只檢查它是不是小於 250 ms（`com.zaxxer.hikari.timeoutMs.floor`），小於就改回預設的 5,000；**沒有任何一行拿它跟 `connectionTimeout` 比**。另外看到 `PoolBase.isConnectionDead` 呼叫的是 `isValid(max(1000, validationTimeout) / 1000)` —— 傳給 JDBC 的是**整秒**、最少 1 秒，所以 1,000～1,999 的效果一樣。
> 在第 09 章結束時的程式碼上跑整套 `mvn clean verify`，`HealthProbeTest` 那四列：
>
> ```
> 0.10.6 全部正常                   health HTTP 200（417 ms）       liveness HTTP 200（5 ms）         readiness HTTP 200（3 ms）
> 0.10.6 Redis 停掉               health HTTP 503（13 ms）        liveness HTTP 200（8 ms）         readiness HTTP 200（13 ms）
> 0.10.6 MySQL 卡住（pause）        health 沒有回應（10014 ms）         liveness HTTP 200（33 ms）        readiness HTTP 503（3019 ms）
> 0.10.6 全部恢復                   health HTTP 200（18 ms）        liveness HTTP 200（5 ms）         readiness HTTP 200（5 ms）
> ```
>
> readiness 從 5 秒變成 3 秒 —— 跟上面 `-Dspring.datasource.hikari.validation-timeout=1000` 那一次一樣，這一次是設定本身。完整的 health 照舊 10 秒不回答。
> 一個要留意的代價：負載很高的時候（這個專題量過 load 27～29），`isValid` 如果超過 1 秒，一條其實健康的連線會被判成死的、丟掉重建。整套測試、第 09 章的驗收都是綠的；E7、G6、H5、H8 這幾個在高負載下數 503 的實驗沒有重跑。

對 Kubernetes 來說這個 5 秒不是問題 —— readiness probe 的預設逾時是 1 秒，逾時就算失敗，結果一樣是「摘掉」。對「完整的 health 10 秒不回答」我沒有往下查：它不被拿來決定流量（0.10.6），但它每被打一次，就佔住一條 Tomcat 的執行緒 10 秒以上。

### 8.9.2 這一章新增與改了的測試

| 測試 | 幾個 | 守什麼 |
|---|---|---|
| `api.OrderHttpFlowTest` | 3 | 訂單的六個動作、金流回呼，第一次走 HTTP；ORD-2 AC-3～AC-8 的狀態碼（8.7.3） |
| `api.HotToggleApiTest` | 1 | 賣家標／取消熱點：閘門的建立與刪除（8.7.3） |
| `api.SellerReportApiTest` | 2 | RPT-1 AC-1～AC-3，第一次在 `mvn test` 裡（8.7.3） |
| `acceptance.HealthProbeTest` | 1 | 0.10.6 的腳本：Redis 停、MySQL 卡住時的三個端點（8.9.1） |
| `reporting.internal.TrendingDegradedTest` | 1 | Redis 失敗一次、guard 還沒跳開 → 排行照樣降級（8.4.5） |
| `OrderFlowTest.processingLeaseTakeover` | ＋1 | 冪等鍵的租約過期、接手（8.7.3；I8 的 M7 只有它抓得到） |
| `EventFlowTest.refundResponseLostOnce` | ＋1 | 7.2.3 的 ③：回應丟了、重試同一個冪等鍵、錢只退一次（8.7.5；I8 的 M3） |
| `InvariantReconciliationTest` | 改 | 自己製造工作負載；呼叫正式的對帳排程；證明它抓得到一筆錯（8.4.3、8.7.3） |
| 驗收 Q6、Q8、Q9 | 改 | 不再靠 compose：管理用的連線、自己註冊的帳號、停掉真的在用的那台 Redis、子行程帶連線資訊並且一定會被收掉（8.4.3） |
| `ProductCacheTest` | 改 | 每一個等待都有上限（8.7.5 的 M6） |
| `EventFlowTest`、`DeadLetterReplayTest` | 改 | 只在 compose 模式下清空佇列（8.5 的 I4b） |

支援的程式碼：`support/TestInfra`（8.4）、`ordering.internal.RandomOrderWorkload`（8.4.3）、`shared.security.LoadTestTokens` 與 `loadtest/{ExternalLoad,ExternalDrill}`（8.6）。實驗：`ch08/I1ContextCloseTest`、`ch08/I3LettuceStopTest`；I2、I4～I12 是整套建置或腳本（`scripts/`，全文在 8.10.1；I4b、I4c、I8 用的 `rules.py`、`mutants.py` 不在 shop repo 裡，這一章不提供）。

### 8.9.3 追溯表更新

| 需求 | 驗證方式 | 狀態 |
|---|---|---|
| 0.6.8 建置 < 5 分鐘（含 Testcontainers） | 筆電 `mvn clean verify` 3:45（8.10）；乾淨的容器（含下載所有依賴）4:21（8.8.2） | ✅ 08 |
| 0.6.8 覆蓋率：整體 ≥ 70%、`ordering`／`inventory`／`payment` ≥ 85% | JaCoCo 的四個 `check`（8.7.4）；最後一次：92.6%、96.6%、93.7%、93.1% | ✅ 08 |
| 0.6.8 模組邊界 | ArchUnit（第 01 章）；在 CI 的 `mvn verify` 裡 | ✅ 01、08 |
| 0.6.8 OpenAPI 的破壞性變更在 CI 檢查 | `OpenApiContractTest` 的快照（3.8.2）；在 CI 的 `mvn verify` 裡 | ✅ 03、08（GitHub 上的那一份沒有真的跑過，8.8） |
| 0.6.8 新人上手：兩個命令 | I12（8.8.3）：新的 clone，兩個命令起得來、ping、readiness UP、商品詳情 200 | ✅ 08（前提：8080、3306、6379、5672、15672 都空著 —— 這台機器的 8080 不是） |
| 0.6.3 readiness / liveness | `HealthProbeTest`（8.9.1）；驗收 Q8 | ✅ 00、06、08 |
| 0.6.3「Redis」「RabbitMQ」兩欄，流量下 | I9（8.6.5）：閒的時候四次逐格對上；忙的時候 RabbitMQ 恢復那一刻熱點 503 五秒，Redis 失敗 4、跳開 1 | ✅ 06、07、08 |
| 0.6.5 MyBatis 禁用 `${}` | `MapperXmlSafetyTest`（第 03 章就有了） | ✅ 03 |
| 0.6.2 商品詳情 p99 50 ms | I7：12 輪裡 7 輪（獨立行程）、6 輪（同一個 JVM）；Redis 0 次失敗 | **部分** |
| 0.6.2 搜尋 | I7：p99 28.9～55.1 ms（SLO 300） | ✅ 08 |
| 0.6.2 一般商品下單 | I7：p99 112.7～273.5 ms（SLO 300） | ✅ 08 |
| 0.6.2 熱點下單、ORD-1b AC-2 | I5：機器有餘裕時 12 / 12 < 500 ms；機器飽和、新實例的前 10 秒沒有 | **部分**（09：正式環境的規格與暖機） |
| 0.6.2 我的訂單 | I7：p99 35.1～171.3 ms（SLO 200） | ✅ 08 |
| 0.6.2 付款回呼 | I7：p99 35.5～109.2 ms（SLO 1 s） | ✅ 08 |
| 0.6.2 賣家日報表、RPT-1 AC-4 | I7：p95 62.2～70.8 ms（SLO 1 s） | ✅ 03、08 |
| RPT-1 AC-1～AC-3 | `SellerReportApiTest`（第 03 章的那一列寫的是一個類別，不是測試） | ✅ 08 |
| ORD-5 AC-2（0.12.2 預定 03、08） | 驗收 Q4，現在跑在每一次建置的空資料庫上（8.2.1 換成空資料庫時它沒有紅） | ✅ 03、08 |
| ORD-2 AC-3～AC-8（HTTP 層） | `OrderHttpFlowTest` | ✅ 04、08 |
| 0.5.4 退款的冪等（7.2.3 的 ③） | `EventFlowTest.refundResponseLostOnce`（之前只有實驗 H3） | ✅ 07、08 |
| CI | `.github/workflows/ci.yml`；乾淨的容器跑了三次（8.8.2），第三次全綠 | 部分（GitHub 上沒有真的跑過） |
| INV-2、INV-3、INV-3' | `InvariantReconciliationTest` 呼叫正式的 `InventoryReconciliation`；排程多了 INV-3' | ✅ 02、07、08 |
| 4.8.3 虛擬執行緒 | I6：「量測環境的偏差」不成立；開放式負載下不比較好 → 維持平台執行緒 | 決定（08） |
| Q1～Q6、Q8～Q11 | 驗收（Testcontainers 上） | ✅ |
| Q7 | —— | 09 |

---

## 8.10 本章完成後的專案

```
shop/
├── .github/workflows/ci.yml                             ← 新增：mvn -B -ntp verify（8.8）
├── pom.xml                                              ← + testcontainers 1.21.4（mysql、rabbitmq）、junit-platform-launcher、jacoco 0.8.15 與四個 check；
│                                                          test.infra（預設 testcontainers；-Pexperiments、-Pseed 是 compose，並關掉 jacoco）
├── scripts/
│   ├── loadtest.sh                                      ← 新增：正式的 jar 一個行程、壓測工具一個行程（8.6.1）
│   └── i5-flash-interleave.sh、i5b-flash-busy.sh、i6-virtual-threads.sh、i7-detail-orders.sh、i9-drills.sh   ← 新增：這一章的交錯量測
└── src/
    ├── main/java/com/example/shop/
    │   ├── inventory/
    │   │   ├── InventoryApi.java                        ← － restockBatch、RestockLine（沒有人用，8.7.2）
    │   │   └── internal/
    │   │       ├── JdbcInventoryService.java            ← － restockBatch
    │   │       └── InventoryReconciliation.java         ← + INV-3'（測試一直在檢查、排程從來沒有，8.7.2）
    │   └── reporting/internal/TrendingService.java      ← Redis 失敗與「沒有快取」分開（8.4.5）
    └── test/
        ├── java/com/example/shop/
        │   ├── support/TestInfra.java                   ← 新增：一個 JVM 一組容器、第一個 Spring Boot 應用程式啟動時才起；childArgs、adminDataSource、docker()（8.4、8.8.2）
        │   ├── acceptance/
        │   │   ├── CapstoneAcceptanceTest.java          ← Q6、Q8、Q9 不再靠 compose；Q9 的子行程一定會被收掉（8.4.3、8.8.2）
        │   │   └── HealthProbeTest.java                 ← 新增：0.10.6 的腳本（8.9.1）
        │   ├── api/{OrderHttpFlow,HotToggleApi,SellerReportApi}Test.java   ← 新增（8.7.3）
        │   ├── api/DeadLetterReplayTest.java            ← 只在 compose 時清佇列（8.5）
        │   ├── ordering/internal/
        │   │   ├── RandomOrderWorkload.java             ← 新增：對帳的資料來源（8.4.3）
        │   │   ├── OrderFlowTest.java                   ← + processingLeaseTakeover（8.7.3）
        │   │   └── EventFlowTest.java                   ← + refundResponseLostOnce（8.7.5、8.8.2）；只在 compose 時清佇列
        │   ├── reporting/internal/TrendingDegradedTest.java   ← 新增（8.4.5）
        │   ├── schema/InvariantReconciliationTest.java  ← 工作負載 + 正式的對帳排程 + 故意弄壞一筆（8.4.3、8.7.3）
        │   ├── catalog/internal/ProductCacheTest.java   ← 每一個等待都有上限（8.7.5）
        │   ├── shared/security/LoadTestTokens.java      ← 新增：沒有 context 也用正式的 AccessTokens 簽（8.6.1）
        │   ├── loadtest/{ExternalLoad,ExternalDrill}.java   ← 新增：獨立行程的壓測工具（8.6）
        │   ├── ch07/H5HotFlashSaleTest.java             ← 多印一行：這個 JVM 的執行緒最多幾條
        │   └── ch08/{I1ContextClose,I3LettuceStop}Test.java   ← 新增：實驗
        └── resources/
            ├── config/application.yml                   ← + server.address: 127.0.0.1（8.2.2）
            └── META-INF/
                ├── services/org.junit.platform.launcher.LauncherSessionListener   ← 新增：TestInfra
                └── spring.factories                     ← 新增：TestInfra（EnvironmentPostProcessor）
```

**沒有新的 migration，沒有新的 API。** 正式程式碼改了 4 個檔案：刪掉一個沒有人用的方法、對帳排程多一條、排行的降級修好。其他都在 `src/test` 與 `scripts/`。（`git diff --stat ch07..ch08`：34 個檔案，+2,063／−106 行。）

```bash
mvn clean verify
```

```
[INFO] Results:
[INFO] 
[WARNING] Tests run: 188, Failures: 0, Errors: 0, Skipped: 1
[INFO] 
……
[INFO] --- jacoco:0.8.15:check (coverage-overall) @ shop ---
[INFO] Analyzed bundle 'shop' with 188 classes
[INFO] All coverage checks have been met.
[INFO] 
[INFO] --- jacoco:0.8.15:check (coverage-ordering) @ shop ---
[INFO] Analyzed bundle 'shop' with 38 classes
[INFO] All coverage checks have been met.
[INFO] 
[INFO] --- jacoco:0.8.15:check (coverage-inventory) @ shop ---
[INFO] Analyzed bundle 'shop' with 15 classes
[INFO] All coverage checks have been met.
[INFO] 
[INFO] --- jacoco:0.8.15:check (coverage-payment) @ shop ---
[INFO] Analyzed bundle 'shop' with 10 classes
[INFO] All coverage checks have been met.
[INFO] ------------------------------------------------------------------------
[INFO] BUILD SUCCESS
[INFO] ------------------------------------------------------------------------
[INFO] Total time:  03:45 min
```

（load average 5.5 → 7.8；這一次 compose 開著，但沒有任何一個測試連它 —— 8.8.2 的乾淨機器證明了這件事。）

**188 個測試、0 個失敗、1 個跳過**（第 07 章 178 個）。多出來的 10 個：`OrderHttpFlowTest` 3 個、`SellerReportApiTest` 2 個、`HotToggleApiTest`、`HealthProbeTest`、`TrendingDegradedTest`、`OrderFlowTest.processingLeaseTakeover`、`EventFlowTest.refundResponseLostOnce` 各 1 個。跳過的還是 Q7（第 09 章）。

覆蓋率（`coverage_by_module.py`）：

```
  account           225 / 238       94.5%      73 / 98       74.5%
  cart               56 / 62        90.3%      18 / 26       69.2%
  catalog           200 / 215       93.0%      60 / 86       69.8%
  inventory         268 / 286       93.7%      85 / 108      78.7%
  notification       58 / 62        93.5%      19 / 22       86.4%
  ordering          478 / 495       96.6%     170 / 205      82.9%
  payment           121 / 130       93.1%      25 / 36       69.4%
  reporting          53 / 53       100.0%      17 / 20       85.0%
  shared            707 / 795       88.9%     156 / 230      67.8%
  ＝ 全部             2167 / 2339      92.6%     623 / 831      75.0%
```

（`payment` 比 8.7.4 那一次的 87.7% 高，是 8.7.5 的 `refundResponseLostOnce`：退款失敗、重試的那幾行第一次被執行。）

| | 第 07 章 | 第 08 章 |
|---|---|---|
| 測試 | 178（跳過 1） | 188（跳過 1） |
| 要什麼才跑得起來 | docker compose（開著好幾天的那一組）＋ 10 萬張種子訂單 | Docker |
| `mvn clean test` / `verify` | 4:36（`test`） | 3:45（`verify`，含覆蓋率） |
| 驗收測試一個類別 | 208.7 秒 | 97.0 秒 |
| 覆蓋率門檻 | 沒有 | 四個 |
| 一個單元測試單獨跑 | （沒有容器可以起） | 2.5 秒（8.4.2） |

時間最多的幾個類別：驗收測試 97.0 秒（其中 Q8 的 68.3 秒是它題目裡的 60 秒）、`TrendingTest` 23.2 秒（第一個起 Spring 的類別：容器 14.7 秒算在它頭上）、`HealthProbeTest` 20.8 秒（MySQL 卡住的那一列要等 10 秒）、`DeadLetterReplayTest` 14.3 秒、`InvariantReconciliationTest` 13.1 秒（400 步的工作負載）。

### 8.10.1 本章其餘檔案的完整內容

8.4～8.9 只給了片段或只有描述的檔案，完整內容在這裡，是 shop repo 第 08 章結束時的樣子，原樣貼上。註解裡的節號是寫程式時的編號，有幾處跟這一章最後的節號不一樣；這裡貼出的版本已依課文更正（例如 `RandomOrderWorkload` 的 8.2.2 → 8.4.3、`TestInfra` 的 8.2.1 → 8.4.4、`InvariantReconciliationTest` 的 8.2.2 → 8.2.1、`OrderFlowTest` 的 4.4.1 → 4.5.1），參考實作的 `ch08` 分支裡仍是舊的節號。測試**印出來**的字串不在此限：8.4.5 的輸出開頭的「8.2.1」是當時實際印出的樣子。`scripts/` 的六支要 `chmod +x`。

**`src/test/java/com/example/shop/support/TestInfra.java`**

```java
package com.example.shop.support;

import com.github.dockerjava.api.model.ExposedPort;
import com.github.dockerjava.api.model.PortBinding;
import com.github.dockerjava.api.model.Ports;
import org.junit.platform.launcher.LauncherSession;
import org.junit.platform.launcher.LauncherSessionListener;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.env.EnvironmentPostProcessor;
import org.springframework.core.env.ConfigurableEnvironment;
import org.testcontainers.utility.MountableFile;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.testcontainers.containers.GenericContainer;
import org.testcontainers.containers.MySQLContainer;
import org.testcontainers.containers.RabbitMQContainer;
import org.testcontainers.lifecycle.Startables;
import org.testcontainers.utility.DockerImageName;

import javax.sql.DataSource;
import java.net.ServerSocket;
import java.util.ArrayList;
import java.util.List;

/**
 * 第 08 章：每一次建置自己起一台 MySQL、Redis、RabbitMQ（0.6.8、7.16）。
 *
 * 一個 JVM（一次 mvn test）只起一組，所有測試共用；在這個 JVM 裡「第一個 Spring Boot 應用程式啟動的時候」才起（EnvironmentPostProcessor），
 * 把連線資訊寫成 System properties —— @SpringBootTest 與 new SpringApplicationBuilder(...).run() 都讀得到（System properties 比 application.yml 優先）。
 * 只有 JUnit 的那個 JVM 會起（LauncherSessionListener 標記）：子行程（驗收 Q9、實驗 H2）不會自己再起一組，它們用 childArgs() 連同一組（8.2.1）。
 * 純單元測試（狀態機、ArchUnit）一個容器都不起（8.4.2：第一版在 JUnit 一開始就起，單獨跑一個 0.8 秒的單元測試要 15 秒）。
 *
 * -Dshop.test.infra=compose：不起容器，照舊連 docker compose 的那一組。實驗（-Pexperiments）用這個：
 * 它們要 10 萬張訂單的種子資料、要跟第 06 章的 worktree 交錯量測，量的是同一個資料庫。
 */
public class TestInfra implements LauncherSessionListener, EnvironmentPostProcessor {

    public static final String MODE = System.getProperty("shop.test.infra", "testcontainers");

    static MySQLContainer<?> mysql;
    static GenericContainer<?> redis;
    static RabbitMQContainer rabbit;

    static volatile boolean junit;

    /** JUnit 的 JVM：記下來就好，容器等到真的有人要的時候才起 */
    @Override
    public void launcherSessionOpened(LauncherSession session) {
        junit = true;
    }

    /** 這個 JVM 裡每一個 Spring Boot 應用程式啟動時都會經過這裡；第一個經過的負責起容器 */
    @Override
    public void postProcessEnvironment(ConfigurableEnvironment environment, SpringApplication application) {
        if (junit && containers()) start();
    }

    static synchronized void start() {
        if (mysql != null) return;
        long t0 = System.nanoTime();
        // 跟 compose.yaml 同一個映像檔、同一組伺服器參數：測試量到的行為要跟本機開發、正式環境的 MySQL 一樣
        mysql = new MySQLContainer<>(DockerImageName.parse("mysql:8.0"))
                .withDatabaseName("shop").withUsername("shop").withPassword("shop")
                .withCommand("--character-set-server=utf8mb4", "--collation-server=utf8mb4_0900_ai_ci",
                        "--default-time-zone=+00:00", "--transaction-isolation=REPEATABLE-READ")
                // 跟 compose 同一份初始化腳本：shop_lab、shop_c2、shop_q6 的權限（8.2.1：少了它，驗收 Q6 的 shop 帳號建不了 shop_q6 的表）
                .withCopyFileToContainer(MountableFile.forHostPath("docker/mysql-init/01-databases.sql"), "/docker-entrypoint-initdb.d/01-databases.sql");
        // 8.4.4：驗收 Q8 要 docker stop / start 這個 Redis。隨機的對外埠每次 start 都會換一個（I3），應用程式就再也連不回來 ——
        // 所以在啟動時挑一個空的埠、固定綁上去。綁在所有介面（跟 compose 一樣）：第一版綁 127.0.0.1，docker stop 之後
        // 已經連著的 Lettuce 收不到 reset，每一個指令等滿 500 ms —— stop 變成了 pause（I3LettuceStopTest）
        int redisPort = freePort();
        redis = new GenericContainer<>(DockerImageName.parse("redis:7.2")).withExposedPorts(6379)
                .withCommand("redis-server", "--maxmemory", "256mb", "--maxmemory-policy", "noeviction")
                .withCreateContainerCmdModifier(cmd -> cmd.getHostConfig()
                        .withPortBindings(new PortBinding(Ports.Binding.bindPort(redisPort), ExposedPort.tcp(6379))));
        rabbit = new RabbitMQContainer(DockerImageName.parse("rabbitmq:3.13-management"));
        Startables.deepStart(mysql, redis, rabbit).join();                  // 三個一起起：總時間 ≈ 最慢的那一個
        for (String[] p : properties()) System.setProperty(p[0], p[1]);
        System.out.printf("TEST_INFRA testcontainers 啟動 %,d ms：mysql %s、redis %s:%d、rabbitmq %s:%d%n", (System.nanoTime() - t0) / 1_000_000,
                mysql.getJdbcUrl(), redis.getHost(), redis.getMappedPort(6379), rabbit.getHost(), rabbit.getAmqpPort());
    }

    public static boolean containers() {
        return MODE.equals("testcontainers");
    }

    static List<String[]> properties() {
        List<String[]> p = new ArrayList<>();
        p.add(new String[]{"spring.datasource.url", jdbcUrl("shop")});
        p.add(new String[]{"spring.datasource.username", "shop"});
        p.add(new String[]{"spring.datasource.password", "shop"});
        p.add(new String[]{"spring.data.redis.host", redis.getHost()});
        p.add(new String[]{"spring.data.redis.port", String.valueOf(redis.getMappedPort(6379))});
        p.add(new String[]{"spring.rabbitmq.host", rabbit.getHost()});
        p.add(new String[]{"spring.rabbitmq.port", String.valueOf(rabbit.getAmqpPort())});
        p.add(new String[]{"spring.rabbitmq.username", rabbit.getAdminUsername()});
        p.add(new String[]{"spring.rabbitmq.password", rabbit.getAdminPassword()});
        return p;
    }

    /** 某一個資料庫的 JDBC URL（應用程式的參數照 application-local.yml） */
    public static String jdbcUrl(String database) {
        if (containers()) start();
        String hostPort = containers() ? mysql.getHost() + ":" + mysql.getMappedPort(3306) : "localhost:3306";
        return "jdbc:mysql://" + hostPort + "/" + database + "?useSSL=false&allowPublicKeyRetrieval=true&connectionTimeZone=UTC&rewriteBatchedStatements=true";
    }

    /** 可以建資料庫的帳號（驗收 Q6）：容器裡是 root；compose 裡是 shop（docker/mysql-init 給了它 shop_q6 的權限） */
    public static DataSource adminDataSource() {
        if (containers()) start();
        return containers() ? new DriverManagerDataSource(jdbcUrl(""), "root", mysql.getPassword())
                : new DriverManagerDataSource(jdbcUrl(""), "shop", "shop");
    }

    /** 驗收 Q9 的子行程：同一組容器 */
    public static List<String> childArgs() {
        if (!containers()) return List.of();
        start();
        return properties().stream().map(p -> "--" + p[0] + "=" + p[1]).toList();
    }

    /** 驗收 Q8 要停掉的那一個 Redis 容器 */
    public static String redisContainer() {
        if (containers()) start();
        return containers() ? redis.getContainerId() : "shop-redis-1";
    }

    /** 停掉 MySQL 用的：容器 id（compose 模式是 shop-mysql-1） */
    public static String mysqlContainer() {
        if (containers()) start();
        return containers() ? mysql.getContainerId() : "shop-mysql-1";
    }

    /**
     * docker stop / start / pause / unpause 一個容器（驗收 Q8、HealthProbeTest）。
     * 8.8：第一版是 new ProcessBuilder("docker", ...) —— CI 的映像檔（maven:3.9-eclipse-temurin-21）裡沒有 docker 這個程式，
     * 只有掛進來的 socket。Testcontainers 本來就有一個跟 daemon 講話的用戶端，用它（compose 模式下一樣可以用容器名稱）
     */
    public static void docker(String action, String container) {
        var client = org.testcontainers.DockerClientFactory.instance().client();
        try {
            switch (action) {
                case "stop" -> client.stopContainerCmd(container).exec();
                case "start" -> client.startContainerCmd(container).exec();
                case "pause" -> client.pauseContainerCmd(container).exec();
                case "unpause" -> client.unpauseContainerCmd(container).exec();
                default -> throw new IllegalArgumentException(action);
            }
        } catch (com.github.dockerjava.api.exception.NotModifiedException | com.github.dockerjava.api.exception.ConflictException already) {
            // 已經是那個狀態了（Q8 的 finally 會再 start 一次）：docker 的命令列在這種情況下什麼都不說，這裡也一樣
        }
    }

    static int freePort() {
        try (ServerSocket s = new ServerSocket(0)) {
            return s.getLocalPort();
        } catch (java.io.IOException e) {
            throw new IllegalStateException(e);
        }
    }
}
```

**`src/test/java/com/example/shop/ordering/internal/RandomOrderWorkload.java`**

```java
package com.example.shop.ordering.internal;

import com.example.shop.ordering.OrderingApi;
import com.example.shop.payment.PaymentApi;
import com.example.shop.payment.internal.CallbackSignature;
import com.example.shop.shared.config.ShopProperties;
import com.example.shop.shared.error.ShopException;
import com.example.shop.support.InlineEvents;
import com.example.shop.support.TestRedis;
import org.springframework.context.ApplicationContext;
import org.springframework.jdbc.core.JdbcTemplate;

import java.math.BigDecimal;
import java.time.Clock;
import java.util.*;

/**
 * 8.4.3 讓對帳有東西可以對：一串固定亂數種子的「真的操作」—— 下單（一般、熱點、兩個品項）、付款、買家取消、賣家取消、
 * 撿貨、出貨、確認收貨、付款逾時、事件交付（InlineEvents，時機也是亂數決定的）。全部走正式的服務，不直接寫表。
 *
 * 第 07 章以前，InvariantReconciliationTest 跑在本機那個有 10 萬張種子訂單的資料庫上；換成每次全新的容器之後，
 * 它在一個空的資料庫上 0.008 秒就「通過」了 —— 什麼都沒檢查。這個工作負載是它的新資料來源。
 */
public final class RandomOrderWorkload {
    private RandomOrderWorkload() {}

    public static final long FIRST_PRODUCT = 9_908_001, FIRST_BUYER = 990_810, SELLER = 2;
    public static final int PRODUCTS = 3, BUYERS = 20;                       // 第三個商品是熱點
    static final BigDecimal PRICE = new BigDecimal("100");

    /** outcomes：每一種操作的結果（成功，或被哪一種 ShopException 擋下）；statuses：最後每一種訂單狀態各幾張 */
    public record Result(Map<String, Integer> outcomes, Map<String, Long> statuses, int orders) {}

    public static Result run(ApplicationContext ctx, long seed, int steps) {
        JdbcTemplate jdbc = ctx.getBean(JdbcTemplate.class);
        OrderingApi ordering = ctx.getBean(OrderingApi.class);
        OrderCommands commands = ctx.getBean(OrderCommands.class);
        PaymentCallbackService callbacks = ctx.getBean(PaymentCallbackService.class);
        ShopProperties props = ctx.getBean(ShopProperties.class);
        OrderJobs jobs = new OrderJobs(jdbc, ctx.getBean(OrderTransitionService.class), ctx.getBean(Clock.class), props);
        cleanup(ctx);
        InlineEvents.skipBacklog(ctx);                                       // 別的測試留下、沒有送出的事件：它們的資料早就刪了
        for (int i = 0; i < PRODUCTS; i++) {
            long id = FIRST_PRODUCT + i;
            jdbc.update("INSERT INTO products (id, seller_id, category_id, name, price, status, hot) VALUES (?, ?, 11, ?, 100.00, 'ON_SALE', ?)",
                    id, SELLER, "對帳工作負載 " + i, i == PRODUCTS - 1);
            jdbc.update("INSERT INTO inventory (product_id, on_hand, reserved) VALUES (?, 150, 0)", id);
            jdbc.update("INSERT INTO inventory_ledger (product_id, delta_on_hand, delta_reserved, reason, ref) VALUES (?, 150, 0, 'INITIAL', 'workload')", id);
        }
        Random r = new Random(seed);
        Map<String, Integer> outcomes = new TreeMap<>();
        List<String[]> orders = new ArrayList<>();                          // {orderNo, buyerId}
        for (int step = 0; step < steps; step++) {
            int dice = r.nextInt(100);
            String action;
            try {
                if (dice < 40 || orders.isEmpty()) {
                    action = "下單";
                    long buyer = FIRST_BUYER + r.nextInt(BUYERS);
                    List<OrderingApi.OrderLine> lines = new ArrayList<>();
                    int first = r.nextInt(PRODUCTS);
                    lines.add(new OrderingApi.OrderLine(FIRST_PRODUCT + first, 1 + r.nextInt(3), PRICE));
                    if (r.nextInt(4) == 0) lines.add(new OrderingApi.OrderLine(FIRST_PRODUCT + (first + 1) % PRODUCTS, 1 + r.nextInt(2), PRICE));
                    var placed = ordering.placeOrder(buyer, "wl-" + seed + "-" + step, lines);
                    orders.add(new String[]{placed.orderNo(), String.valueOf(buyer)});
                } else {
                    String[] o = pick(jdbc, r, orders, dice);
                    long buyer = Long.parseLong(o[1]);
                    if (dice < 60) {
                        action = "付款";
                        long pid = commands.startPayment(buyer, o[0]).paymentId();
                        BigDecimal amount = jdbc.queryForObject("SELECT total_amount FROM orders WHERE order_no = ?", BigDecimal.class, o[0]);
                        String txn = "wl-" + seed + "-" + step;
                        callbacks.handle(new PaymentApi.Callback(pid, txn, amount, true,
                                CallbackSignature.sign(props.payment().callbackSecret(), CallbackSignature.canonical(pid, txn, amount, true))));
                    } else if (dice < 70) { action = "買家取消"; commands.cancelByBuyer(buyer, o[0]); }
                    else if (dice < 75) { action = "賣家取消"; commands.cancelBySeller(SELLER, o[0]); }
                    else if (dice < 83) { action = "撿貨"; commands.startPicking(SELLER, o[0]); }
                    else if (dice < 91) { action = "出貨"; commands.ship(SELLER, o[0], "黑貓", "WL" + step); }
                    else if (dice < 95) { action = "確認收貨"; commands.confirmReceipt(buyer, o[0]); }
                    else if (dice < 97) {
                        action = "付款逾時";
                        jdbc.update("UPDATE orders SET payment_deadline = NOW(3) - INTERVAL 1 SECOND WHERE order_no = ? AND status = 'PENDING_PAYMENT'", o[0]);
                        while (jobs.cancelExpired() > 0) { }
                    } else { action = "交付事件"; InlineEvents.deliver(ctx, x -> true); }
                }
                outcomes.merge(action + " 成功", 1, Integer::sum);
            } catch (ShopException e) {
                outcomes.merge(actionName(dice, orders.isEmpty()) + " → " + e.type().name(), 1, Integer::sum);
            }
        }
        InlineEvents.deliver(ctx, x -> true);                               // 最後把還在 outbox 裡的都交付：落帳、加回、通知、退款
        Map<String, Long> statuses = new TreeMap<>();
        jdbc.query("SELECT status, COUNT(*) FROM orders WHERE buyer_id BETWEEN ? AND ? GROUP BY status",
                rs -> { statuses.put(rs.getString(1), rs.getLong(2)); }, FIRST_BUYER, FIRST_BUYER + BUYERS - 1);
        return new Result(outcomes, statuses, orders.size());
    }

    /** 八成挑一張「這個操作在它身上合法」的訂單；兩成隨便挑一張 —— 不合法的轉移（INVALID_STATE）也要被走到 */
    static String[] pick(JdbcTemplate jdbc, Random r, List<String[]> orders, int dice) {
        String want = dice < 60 ? "PENDING_PAYMENT" : dice < 70 ? "PENDING_PAYMENT,PAID" : dice < 75 ? "PAID,PICKING" : dice < 83 ? "PAID"
                : dice < 91 ? "PICKING" : dice < 95 ? "SHIPPED" : "PENDING_PAYMENT";
        if (r.nextInt(10) < 8) {
            List<String> nos = jdbc.queryForList("SELECT order_no FROM orders WHERE buyer_id BETWEEN ? AND ? AND FIND_IN_SET(status, ?) ORDER BY id",
                    String.class, FIRST_BUYER, FIRST_BUYER + BUYERS - 1, want);
            if (!nos.isEmpty()) {
                String no = nos.get(r.nextInt(nos.size()));
                for (String[] o : orders) if (o[0].equals(no)) return o;
            }
        }
        return orders.get(r.nextInt(orders.size()));
    }

    static String actionName(int dice, boolean noOrders) {
        if (dice < 40 || noOrders) return "下單";
        if (dice < 60) return "付款";
        if (dice < 70) return "買家取消";
        if (dice < 75) return "賣家取消";
        if (dice < 83) return "撿貨";
        if (dice < 91) return "出貨";
        if (dice < 95) return "確認收貨";
        if (dice < 97) return "付款逾時";
        return "交付事件";
    }

    public static void cleanup(ApplicationContext ctx) {
        JdbcTemplate jdbc = ctx.getBean(JdbcTemplate.class);
        long lo = FIRST_BUYER, hi = FIRST_BUYER + BUYERS - 1;
        jdbc.update("DELETE n FROM notifications n JOIN orders o ON o.id = n.payload->>'$.aggregateId' WHERE o.buyer_id BETWEEN ? AND ?", lo, hi);
        jdbc.update("DELETE FROM notifications WHERE user_id BETWEEN ? AND ?", lo, hi);
        jdbc.update("DELETE a FROM audit_logs a JOIN payments p ON a.target_type = 'PAYMENT' AND a.target_id = p.id JOIN orders o ON o.id = p.order_id WHERE o.buyer_id BETWEEN ? AND ?", lo, hi);
        jdbc.update("DELETE a FROM audit_logs a JOIN orders o ON a.target_type = 'ORDER' AND a.target_id = o.order_no WHERE o.buyer_id BETWEEN ? AND ?", lo, hi);
        for (String t : List.of("refunds", "payments", "order_status_history", "order_items"))
            jdbc.update("DELETE x FROM " + t + " x JOIN orders o ON o.id = x.order_id WHERE o.buyer_id BETWEEN ? AND ?", lo, hi);
        jdbc.update("DELETE FROM idempotency_keys WHERE buyer_id BETWEEN ? AND ?", lo, hi);
        jdbc.update("DELETE FROM orders WHERE buyer_id BETWEEN ? AND ?", lo, hi);
        long[] ids = new long[PRODUCTS];
        for (int i = 0; i < PRODUCTS; i++) {
            long id = FIRST_PRODUCT + i;
            ids[i] = id;
            jdbc.update("DELETE FROM inventory_reservations WHERE product_id = ?", id);
            jdbc.update("DELETE FROM inventory_ledger WHERE product_id = ?", id);
            jdbc.update("DELETE FROM inventory WHERE product_id = ?", id);
            jdbc.update("DELETE FROM products WHERE id = ?", id);
        }
        TestRedis.forgetProducts(ctx, ids);
    }
}
```

**`src/test/java/com/example/shop/schema/InvariantReconciliationTest.java`**

```java
package com.example.shop.schema;

import com.example.shop.ordering.internal.RandomOrderWorkload;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.ApplicationContext;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;

import java.util.LinkedHashMap;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 0.4.6 的不變量裡，CHECK 寫不出來的那幾條（2.5.4），改用對帳 SQL 檢查。
 * 空資料庫會直接通過；跑完種子資料（2.8）之後再跑一次，差異也必須是 0。
 * 第 07 章：熱點商品的預留在落帳之前 counted = FALSE（7.6），INV-2 只算已經計入的；同樣的 SQL 也放進了每小時的對帳排程（7.10）。
 * 第 08 章：每次建置的資料庫都是空的 —— 「空資料庫會直接通過」從一句說明變成了每一次的事實（8.2.1：3.9 秒變成 0.008 秒）。
 * 所以先跑一串固定亂數種子的真實操作（RandomOrderWorkload），再對帳；而且先確認「有東西被對到」。
 * 8.7：庫存的三條（INV-2、INV-3、INV-3'）改成呼叫正式的對帳排程（InventoryReconciliation）—— 覆蓋率報表說它的程式碼一次都沒被測試執行過，
 * 而這個測試自己留的那份 SQL 比排程多一條 INV-3'。兩份會漂移的 SQL，留一份；並且故意弄壞一筆，確認它真的抓得到。
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.NONE, properties = {"shop.order.jobs-enabled=false", "shop.inventory.jobs-enabled=false"})
class InvariantReconciliationTest {

    @Autowired JdbcTemplate jdbc;
    @Autowired ApplicationContext ctx;

    public static final Map<String, String> CHECKS = new LinkedHashMap<>();
    static {
        // 庫存的 INV-2、INV-3、INV-3' 在正式的 InventoryReconciliation 裡（invariants()）；這裡只留訂單的兩條
        CHECKS.put("訂單金額 = Σ 明細金額", """
                SELECT COUNT(*) FROM orders o
                  JOIN (SELECT order_id, SUM(line_amount) AS s FROM order_items GROUP BY order_id) x ON x.order_id = o.id
                 WHERE o.total_amount <> x.s""");
        CHECKS.put("每張訂單至少一個明細", """
                SELECT COUNT(*) FROM orders o WHERE NOT EXISTS (SELECT 1 FROM order_items i WHERE i.order_id = o.id)""");
    }

    /** 正式的對帳排程（inventory.internal 的 package-private 類別；跟 HotSettlementTest 呼叫 HotStock.reconcile 一樣用反射） */
    @SuppressWarnings("unchecked")
    Map<String, Long> invariants() {
        try {
            Object job = ctx.getBean(Class.forName("com.example.shop.inventory.internal.InventoryReconciliation"));
            var m = job.getClass().getDeclaredMethod("checkInvariants");
            m.setAccessible(true);
            return (Map<String, Long>) m.invoke(job);
        } catch (ReflectiveOperationException e) {
            throw new IllegalStateException(e);
        }
    }

    @Test
    void invariantsHold() {
        try {
            var w = RandomOrderWorkload.run(ctx, 2026, 400);
            long orders = jdbc.queryForObject("SELECT COUNT(*) FROM orders", Long.class);
            System.out.printf("═══ 對帳（目前 %,d 張訂單；其中工作負載 %d 張：%s）═══%n  工作負載的操作：%s%n", orders, w.orders(), w.statuses(), w.outcomes());
            // 不能是空的：至少四種最後狀態，代表付款、取消、出貨的路都走過了
            assertThat(w.statuses()).as("工作負載的最後狀態").hasSizeGreaterThanOrEqualTo(4);
            long t0 = System.nanoTime();
            Map<String, Long> inventory = invariants();
            System.out.printf("  正式的對帳排程 InventoryReconciliation %s   %,6.0f ms%n", inventory, (System.nanoTime() - t0) / 1e6);
            assertThat(inventory).containsOnlyKeys("INV-2", "INV-3", "INV-3'").allSatisfy((k, v) -> assertThat(v).as(k).isZero());
            CHECKS.forEach((name, sql) -> {
                long t1 = System.nanoTime();
                long diff = jdbc.queryForObject(sql, Long.class);
                System.out.printf("  %-38s 差異 %,d 筆   %,6.0f ms%n", name, diff, (System.nanoTime() - t1) / 1e6);
                assertThat(diff).as(name).isZero();
            });

            // 它抓得到東西嗎？把工作負載的一個商品的 reserved 多加 1（模擬一個「改了數字、沒寫預留也沒記帳」的 bug）
            long victim = RandomOrderWorkload.FIRST_PRODUCT;
            jdbc.update("UPDATE inventory SET reserved = reserved + 1 WHERE product_id = ?", victim);
            Map<String, Long> broken = invariants();
            double gauge = ctx.getBean(io.micrometer.core.instrument.MeterRegistry.class).get("shop.reconciliation.diff").tag("check", "INV-2").gauge().value();
            jdbc.update("UPDATE inventory SET reserved = reserved - 1 WHERE product_id = ?", victim);
            System.out.printf("  故意讓商品 %d 的 reserved 多 1 → %s；指標 shop.reconciliation.diff{check=INV-2} = %.0f%n", victim, broken, gauge);
            assertThat(broken).containsEntry("INV-2", 1L).containsEntry("INV-3", 0L).containsEntry("INV-3'", 1L);
            assertThat(gauge).isEqualTo(1.0);
        } finally {
            RandomOrderWorkload.cleanup(ctx);
        }
    }
}
```

**`src/test/java/com/example/shop/ordering/internal/OrderFlowTest.java`**（只列 8.7.3 加的 `processingLeaseTakeover`，放在 `expiredKeyIsNew` 之前；其他測試跟第 07 章一樣）

```java
    @Test @DisplayName("ORD-1a（4.5.1 的租約）：PROCESSING 的鍵 —— 租約還在 → 409 in-progress；租約過期（前一個處理者死了）→ 接手並成立")
    void processingLeaseTakeover() {
        // 8.7：覆蓋率報表說「租約過期、接手」那一段（IdempotencyKeys.existing 的最後三行）從來沒有被執行過。
        // 用跟正式程式一樣的 request hash 放一列 PROCESSING —— 就是「claim 了、還沒 complete 就被 kill -9」留下的樣子
        var lines = List.of(new OrderingApi.OrderLine(PRODUCT, 1, new BigDecimal("100")));
        jdbc.update("""
                INSERT INTO idempotency_keys (buyer_id, idem_key, request_hash, status, locked_until, expires_at)
                VALUES (?, 'lease-key', ?, 'PROCESSING', NOW(3) + INTERVAL 20 SECOND, NOW(3) + INTERVAL 1 DAY)""", BUYER, PlaceOrderService.hash(lines));
        assertThatThrownBy(() -> ordering.placeOrder(BUYER, "lease-key", lines)).isInstanceOf(ShopException.class)
                .satisfies(e -> assertThat(((ShopException) e).type()).isEqualTo(ProblemType.IDEMPOTENCY_IN_PROGRESS));
        jdbc.update("UPDATE idempotency_keys SET locked_until = NOW(3) - INTERVAL 1 SECOND WHERE buyer_id = ? AND idem_key = 'lease-key'", BUYER);
        var placed = ordering.placeOrder(BUYER, "lease-key", lines);
        assertThat(placed.replayed()).isFalse();
        assertThat(status(placed.orderNo())).isEqualTo("PENDING_PAYMENT");
        assertThat(jdbc.queryForMap("SELECT status, order_id FROM idempotency_keys WHERE buyer_id = ? AND idem_key = 'lease-key'", BUYER))
                .containsEntry("status", "SUCCEEDED").containsEntry("order_id", placed.orderId());
    }
```

**`src/test/java/com/example/shop/api/OrderHttpFlowTest.java`**

```java
package com.example.shop.api;

import com.example.shop.payment.internal.CallbackSignature;
import com.example.shop.shared.config.ShopProperties;
import com.example.shop.shared.security.AccessTokens;
import com.example.shop.shared.web.Role;
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

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 8.7 覆蓋率報表說的：訂單的六個動作與金流回呼，HTTP 這一層的「成功」從來沒有被走過 ——
 * OrderFlowTest 直接呼叫 Service；IdorMatrixTest 打的是 HTTP，但永遠用「別人」的身分（404）。
 * 這個類別用 HTTP 把一張訂單走完：下單 → 建付款 → 金流回呼（真的簽章）→ 撿貨 → 出貨 → 確認收貨；以及回呼的 AC-3～AC-7 的 HTTP 狀態碼。
 */
@SpringBootTest(properties = {"shop.order.jobs-enabled=false", "shop.inventory.jobs-enabled=false"})
@AutoConfigureMockMvc
class OrderHttpFlowTest {

    static final long BUYER = 990_861, SELLER = 990_871, PRODUCT = 9_900_861;

    @Autowired MockMvc mvc;
    @Autowired AccessTokens tokens;
    @Autowired ShopProperties props;
    @Autowired JdbcTemplate jdbc;
    @Autowired StringRedisTemplate redis;
    @Autowired ObjectMapper json;

    @BeforeEach
    void setUp() {
        cleanup();
        jdbc.update("INSERT INTO products (id, seller_id, category_id, name, price, status) VALUES (?, ?, 11, 'HTTP 流程', 100.00, 'ON_SALE')", PRODUCT, SELLER);
        jdbc.update("INSERT INTO inventory (product_id, on_hand, reserved) VALUES (?, 10, 0)", PRODUCT);
        jdbc.update("INSERT INTO inventory_ledger (product_id, delta_on_hand, delta_reserved, reason, ref) VALUES (?, 10, 0, 'INITIAL', 'http-flow')", PRODUCT);
    }

    @AfterEach
    void cleanup() {
        jdbc.update("DELETE a FROM audit_logs a JOIN payments p ON a.target_type = 'PAYMENT' AND a.target_id = p.id JOIN orders o ON o.id = p.order_id WHERE o.buyer_id = ?", BUYER);
        jdbc.update("DELETE a FROM audit_logs a JOIN orders o ON a.target_type = 'ORDER' AND a.target_id = o.order_no WHERE o.buyer_id = ?", BUYER);
        for (String t : List.of("refunds", "payments", "order_status_history", "order_items"))
            jdbc.update("DELETE x FROM " + t + " x JOIN orders o ON o.id = x.order_id WHERE o.buyer_id = ?", BUYER);
        jdbc.update("DELETE FROM idempotency_keys WHERE buyer_id = ?", BUYER);
        jdbc.update("DELETE FROM orders WHERE buyer_id = ?", BUYER);
        jdbc.update("DELETE FROM inventory_reservations WHERE product_id = ?", PRODUCT);
        jdbc.update("DELETE FROM inventory_ledger WHERE product_id = ?", PRODUCT);
        jdbc.update("DELETE FROM inventory WHERE product_id = ?", PRODUCT);
        jdbc.update("DELETE FROM products WHERE id = ?", PRODUCT);
        TestRedis.forgetProducts(redis, PRODUCT);
    }

    MockHttpServletResponse call(String method, String path, Long actor, Role role, String body) throws Exception {
        var b = MockMvcRequestBuilders.request(method, java.net.URI.create(path)).contentType(MediaType.APPLICATION_JSON).characterEncoding(StandardCharsets.UTF_8);
        if (actor != null) b.header("Authorization", TestTokens.bearer(tokens, actor, role));
        if (path.equals("/api/orders")) b.header("Idempotency-Key", "http-flow-" + System.nanoTime());
        if (body != null) b.content(body);
        return mvc.perform(b).andReturn().getResponse();
    }

    JsonNode body(MockHttpServletResponse r) throws Exception { return json.readTree(r.getContentAsString(StandardCharsets.UTF_8)); }

    String place() throws Exception {
        var r = call("POST", "/api/orders", BUYER, Role.BUYER, "{\"items\": [{\"productId\": %d, \"quantity\": 2, \"unitPrice\": 100}]}".formatted(PRODUCT));
        assertThat(r.getStatus()).isEqualTo(201);
        return body(r).get("orderNo").asText();
    }

    long startPayment(String orderNo) throws Exception {
        var r = call("POST", "/api/orders/" + orderNo + "/payments", BUYER, Role.BUYER, null);
        assertThat(r.getStatus()).as("ORD-2 AC-1").isEqualTo(201);
        return body(r).get("paymentId").asLong();
    }

    /** 金流送來的 JSON：result 是字串（SUCCEEDED / FAILED），簽章算在 canonical 上 */
    MockHttpServletResponse callback(long paymentId, String txn, String amount, String result, boolean goodSignature) throws Exception {
        BigDecimal a = new BigDecimal(amount);
        String sig = goodSignature ? CallbackSignature.sign(props.payment().callbackSecret(), CallbackSignature.canonical(paymentId, txn, a, "SUCCEEDED".equals(result)))
                : "0".repeat(64);
        return call("POST", "/api/payments/callback", null, null,
                "{\"paymentId\": %d, \"providerTxnId\": \"%s\", \"amount\": %s, \"result\": \"%s\", \"signature\": \"%s\"}".formatted(paymentId, txn, amount, result, sig));
    }

    String status(String orderNo) { return jdbc.queryForObject("SELECT status FROM orders WHERE order_no = ?", String.class, orderNo); }

    @Test @DisplayName("ORD-2、ORD-6 全部走 HTTP：下單 → 付款 → 回呼 → 撿貨 → 出貨 → 確認收貨")
    void wholeLifecycleOverHttp() throws Exception {
        String no = place();
        long pid = startPayment(no);
        long t0 = System.nanoTime();
        var cb = callback(pid, "http-tx-1", "200.00", "SUCCEEDED", true);
        long cbMs = (System.nanoTime() - t0) / 1_000_000;
        assertThat(cb.getStatus()).isEqualTo(200);
        assertThat(body(cb).get("status").asText()).isEqualTo("received");
        assertThat(status(no)).isEqualTo("PAID");

        var picking = call("POST", "/api/seller/orders/" + no + "/start-picking", SELLER, Role.SELLER, null);
        var shipped = call("POST", "/api/seller/orders/" + no + "/ship", SELLER, Role.SELLER, "{\"carrier\": \"  黑貓  \", \"trackingNo\": \" T-861 \"}");
        var carrier = jdbc.queryForMap("SELECT carrier, tracking_no FROM orders WHERE order_no = ?", no);
        var done = call("POST", "/api/orders/" + no + "/confirm-receipt", BUYER, Role.BUYER, null);
        System.out.printf("8.7 HTTP：回呼 %d（%d ms）→ %s；撿貨 %d → %s；出貨 %d → %s %s；確認收貨 %d → %s%n", cb.getStatus(), cbMs, status(no).isEmpty() ? "" : "PAID",
                picking.getStatus(), body(picking).get("status").asText(), shipped.getStatus(), body(shipped).get("status").asText(), carrier, done.getStatus(), body(done).get("status").asText());
        assertThat(cbMs).as("ORD-2 AC-8：3 秒內回應").isLessThan(3000);
        assertThat(picking.getStatus()).isEqualTo(200);
        assertThat(body(picking).get("status").asText()).isEqualTo("PICKING");
        assertThat(shipped.getStatus()).isEqualTo(200);
        assertThat(carrier).containsEntry("carrier", "黑貓").containsEntry("tracking_no", "T-861");   // 前後的空白被去掉
        assertThat(done.getStatus()).isEqualTo(200);
        assertThat(body(done).get("status").asText()).isEqualTo("COMPLETED");
    }

    @Test @DisplayName("ORD-2 AC-3～AC-7 的 HTTP 狀態碼：簽章錯 401、金額錯 400、失敗 200 且維持待付款、重送 200、取消後晚到 200 + 退款")
    void callbackStatusCodes() throws Exception {
        String no = place();
        long pid = startPayment(no);
        var badSig = callback(pid, "http-tx-2", "200.00", "SUCCEEDED", false);
        var badAmount = callback(pid, "http-tx-2", "1.00", "SUCCEEDED", true);
        var failed = callback(pid, "http-tx-2", "200.00", "FAILED", true);
        String afterFailed = status(no);
        String paymentAfterFailed = jdbc.queryForObject("SELECT status FROM payments WHERE id = ?", String.class, pid);
        long pid2 = startPayment(no);
        var ok = callback(pid2, "http-tx-3", "200.00", "SUCCEEDED", true);
        var again = callback(pid2, "http-tx-3", "200.00", "SUCCEEDED", true);
        long signatureAudits = jdbc.queryForObject("SELECT COUNT(*) FROM audit_logs WHERE action = 'PAYMENT_SIGNATURE_INVALID' AND target_type = 'PAYMENT' AND target_id = ?", Long.class, String.valueOf(pid));

        String other = place();                                              // AC-6：取消之後才到的成功回呼
        long pid3 = startPayment(other);
        var cancel = call("POST", "/api/orders/" + other + "/cancel", BUYER, Role.BUYER, null);
        var late = callback(pid3, "http-tx-4", "200.00", "SUCCEEDED", true);
        List<String> refunds = jdbc.queryForList("SELECT f.reason FROM refunds f JOIN orders o ON o.id = f.order_id WHERE o.order_no = ?", String.class, other);
        System.out.printf("8.7 HTTP 回呼：簽章錯 %d（稽核 %d 筆）、金額錯 %d、FAILED %d → 訂單 %s、付款 %s；成功 %d、重送 %d → %s；取消 %d 之後晚到 %d → %s、退款 %s%n",
                badSig.getStatus(), signatureAudits, badAmount.getStatus(), failed.getStatus(), afterFailed, paymentAfterFailed, ok.getStatus(), again.getStatus(), status(no),
                cancel.getStatus(), late.getStatus(), status(other), refunds);
        assertThat(badSig.getStatus()).as("AC-3").isEqualTo(401);
        assertThat(signatureAudits).as("AC-3 稽核").isEqualTo(1);
        assertThat(badAmount.getStatus()).as("AC-4").isEqualTo(400);
        assertThat(failed.getStatus()).as("AC-7").isEqualTo(200);
        assertThat(afterFailed).isEqualTo("PENDING_PAYMENT");
        assertThat(paymentAfterFailed).isEqualTo("FAILED");
        assertThat(ok.getStatus()).isEqualTo(200);
        assertThat(again.getStatus()).as("AC-5").isEqualTo(200);
        assertThat(status(no)).isEqualTo("PAID");
        assertThat(cancel.getStatus()).isEqualTo(200);
        assertThat(late.getStatus()).as("AC-6").isEqualTo(200);
        assertThat(status(other)).isEqualTo("CANCELLED");
        assertThat(refunds).hasSize(1);
    }

    @Test @DisplayName("賣家取消已付款的訂單（HTTP）→ CANCELLED、退款一筆")
    void sellerCancelOverHttp() throws Exception {
        String no = place();
        callback(startPayment(no), "http-tx-5", "200.00", "SUCCEEDED", true);
        var r = call("POST", "/api/seller/orders/" + no + "/cancel", SELLER, Role.SELLER, null);
        assertThat(r.getStatus()).isEqualTo(200);
        assertThat(body(r).get("status").asText()).isEqualTo("CANCELLED");
        assertThat(jdbc.queryForList("SELECT f.reason FROM refunds f JOIN orders o ON o.id = f.order_id WHERE o.order_no = ?", String.class, no)).containsExactly("SELLER_CANCEL");
    }
}
```

**`src/test/java/com/example/shop/api/HotToggleApiTest.java`**

```java
package com.example.shop.api;

import com.example.shop.shared.security.AccessTokens;
import com.example.shop.shared.web.Role;
import com.example.shop.support.InlineEvents;
import com.example.shop.support.TestRedis;
import com.example.shop.support.TestTokens;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.ApplicationContext;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.web.servlet.MockMvc;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;

/**
 * 8.7 覆蓋率報表說的：POST /api/seller/products/{id}/hot（6.5，賣家把商品標成熱點）的「成功」一次都沒有被測過 ——
 * 其他測試都是 UPDATE products SET hot = TRUE；IdorMatrixTest 打過它，但永遠用別人的身分（404）。
 * 標成熱點：commit 之後 Redis 的閘門從 MySQL 的可售量建立（JdbcInventoryService.setHot → HotStock.initialize）；取消：commit 之後刪掉閘門。
 */
@SpringBootTest(properties = {"shop.order.jobs-enabled=false", "shop.inventory.jobs-enabled=false"})
@AutoConfigureMockMvc
class HotToggleApiTest {

    static final long SELLER = 990_881, BUYER = 990_891, PRODUCT = 9_900_881;

    @Autowired MockMvc mvc;
    @Autowired AccessTokens tokens;
    @Autowired JdbcTemplate jdbc;
    @Autowired StringRedisTemplate redis;
    @Autowired ApplicationContext ctx;

    @BeforeEach
    void setUp() {
        cleanup();
        InlineEvents.skipBacklog(ctx);
        jdbc.update("INSERT INTO products (id, seller_id, category_id, name, price, status) VALUES (?, ?, 11, '標熱點', 100.00, 'ON_SALE')", PRODUCT, SELLER);
        jdbc.update("INSERT INTO inventory (product_id, on_hand, reserved) VALUES (?, 5, 0)", PRODUCT);
        jdbc.update("INSERT INTO inventory_ledger (product_id, delta_on_hand, delta_reserved, reason, ref) VALUES (?, 5, 0, 'INITIAL', 'hot-toggle')", PRODUCT);
    }

    @AfterEach
    void cleanup() {
        for (String t : List.of("order_status_history", "order_items")) jdbc.update("DELETE x FROM " + t + " x JOIN orders o ON o.id = x.order_id WHERE o.buyer_id BETWEEN ? AND ?", BUYER, BUYER + 9);
        jdbc.update("DELETE FROM idempotency_keys WHERE buyer_id BETWEEN ? AND ?", BUYER, BUYER + 9);
        jdbc.update("DELETE FROM orders WHERE buyer_id BETWEEN ? AND ?", BUYER, BUYER + 9);
        jdbc.update("DELETE FROM inventory_reservations WHERE product_id = ?", PRODUCT);
        jdbc.update("DELETE FROM inventory_ledger WHERE product_id = ?", PRODUCT);
        jdbc.update("DELETE FROM inventory WHERE product_id = ?", PRODUCT);
        jdbc.update("DELETE FROM products WHERE id = ?", PRODUCT);
        TestRedis.forgetProducts(redis, PRODUCT);
    }

    int hot(boolean on) throws Exception {
        return mvc.perform(post("/api/seller/products/" + PRODUCT + "/hot").header("Authorization", TestTokens.bearer(tokens, SELLER, Role.SELLER))
                .contentType(MediaType.APPLICATION_JSON).content("{\"hot\": " + on + "}")).andReturn().getResponse().getStatus();
    }

    int order(long buyer) throws Exception {
        return mvc.perform(post("/api/orders").header("Authorization", TestTokens.bearer(tokens, buyer)).header("Idempotency-Key", "toggle-" + buyer)
                .contentType(MediaType.APPLICATION_JSON).content("{\"items\": [{\"productId\": %d, \"quantity\": 1, \"unitPrice\": 100}]}".formatted(PRODUCT)))
                .andReturn().getResponse().getStatus();
    }

    Object counted(long buyer) {
        return jdbc.queryForObject("SELECT r.counted + 0 FROM inventory_reservations r JOIN orders o ON o.id = r.order_id WHERE o.buyer_id = ?", Integer.class, buyer);
    }

    @Test @DisplayName("6.5：賣家標成熱點 → Redis 閘門 = MySQL 可售量、下單走閘門；取消熱點 → 閘門刪掉、下單回到 MySQL 的條件式 UPDATE")
    void markAndUnmark() throws Exception {
        int on = hot(true);
        String gateAfterMark = redis.opsForValue().get("stock:" + PRODUCT);
        int o1 = order(BUYER);
        String gateAfterOrder = redis.opsForValue().get("stock:" + PRODUCT);
        Object counted1 = counted(BUYER);
        int off = hot(false);
        Boolean gateAfterUnmark = redis.hasKey("stock:" + PRODUCT);
        int o2 = order(BUYER + 1);
        Object counted2 = counted(BUYER + 1);
        System.out.printf("8.7 標熱點 %d → stock:%d = %s；下單 %d → %s（counted=%s）；取消熱點 %d → 閘門還在 %s；下單 %d（counted=%s）%n",
                on, PRODUCT, gateAfterMark, o1, gateAfterOrder, counted1, off, gateAfterUnmark, o2, counted2);
        assertThat(on).isEqualTo(200);
        assertThat(gateAfterMark).isEqualTo("5");
        assertThat(o1).isEqualTo(201);
        assertThat(gateAfterOrder).isEqualTo("4");
        assertThat(counted1).as("熱點：下單只寫預留列，數量之後由消費者計入（7.6）").isEqualTo(0);
        assertThat(off).isEqualTo(200);
        assertThat(gateAfterUnmark).isFalse();
        assertThat(o2).isEqualTo(201);
        assertThat(counted2).as("不是熱點：下單交易裡就計入").isEqualTo(1);
    }
}
```

**`src/test/java/com/example/shop/api/SellerReportApiTest.java`**

```java
package com.example.shop.api;

import com.example.shop.shared.security.AccessTokens;
import com.example.shop.shared.web.Role;
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
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.test.web.servlet.MockMvc;

import java.nio.charset.StandardCharsets;
import java.sql.Timestamp;
import java.time.Instant;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;

/**
 * 8.7 覆蓋率報表說的：賣家日報表（US-RPT-1）在 mvn test 裡一行都沒有被執行過 —— 第 03 章量它的 D4、D6 都是實驗（@Tag("experiment")），
 * 而且跑在 10 萬張種子訂單上。追溯表寫的是 ✅，但每次建置都沒有人檢查它。
 * 這裡用三張「卡在台北午夜」的訂單，把 AC-1～AC-3 寫成每次建置都會跑的測試。
 */
@SpringBootTest(properties = {"shop.order.jobs-enabled=false", "shop.inventory.jobs-enabled=false"})
@AutoConfigureMockMvc
class SellerReportApiTest {

    static final long SELLER = 990_901, BUYER = 990_911;

    @Autowired MockMvc mvc;
    @Autowired AccessTokens tokens;
    @Autowired JdbcTemplate jdbc;
    @Autowired ObjectMapper json;

    long order(String no, String createdUtc, String paidUtc, String status, String total) {
        jdbc.update("""
                INSERT INTO orders (order_no, buyer_id, seller_id, status, total_amount, payment_deadline, paid_at, created_at)
                VALUES (?, ?, ?, ?, ?, ? + INTERVAL 15 MINUTE, ?, ?)""",
                no, BUYER, SELLER, status, total, Timestamp.from(Instant.parse(createdUtc)), paidUtc == null ? null : Timestamp.from(Instant.parse(paidUtc)),
                Timestamp.from(Instant.parse(createdUtc)));
        return jdbc.queryForObject("SELECT id FROM orders WHERE order_no = ?", Long.class, no);
    }

    @BeforeEach
    void setUp() {
        cleanup();
        order("20260930-990901", "2026-09-30T15:59:59Z", "2026-09-30T16:05:00Z", "PAID", "100.00");   // 台北 9/30 23:59:59 成立、10/01 00:05 付款
        order("20261001-990902", "2026-09-30T16:00:00Z", null, "PENDING_PAYMENT", "200.00");          // 台北 10/01 00:00:00 成立（UTC 還是 9/30）
        long c = order("20261001-990903", "2026-10-01T03:00:00Z", "2026-10-01T03:01:00Z", "PAID", "300.00");
        jdbc.update("INSERT INTO payments (order_id, amount, status, provider, provider_txn_id) VALUES (?, 300.00, 'SUCCEEDED', 'SIM', 'rpt-990903')", c);
        long pid = jdbc.queryForObject("SELECT id FROM payments WHERE provider_txn_id = 'rpt-990903'", Long.class);
        jdbc.update("INSERT INTO refunds (payment_id, order_id, amount, reason, status, created_at) VALUES (?, ?, 50.00, 'SELLER_CANCEL', 'SUCCEEDED', ?)",
                pid, c, Timestamp.from(Instant.parse("2026-10-01T17:00:00Z")));                          // 台北 10/02 01:00 退款
    }

    @AfterEach
    void cleanup() {
        jdbc.update("DELETE f FROM refunds f JOIN orders o ON o.id = f.order_id WHERE o.seller_id = ?", SELLER);
        jdbc.update("DELETE p FROM payments p JOIN orders o ON o.id = p.order_id WHERE o.seller_id = ?", SELLER);
        jdbc.update("DELETE FROM orders WHERE seller_id = ?", SELLER);
    }

    MockHttpServletResponse report(String from, String to) throws Exception {
        return mvc.perform(get("/api/seller/reports/daily-sales").param("from", from).param("to", to)
                .header("Authorization", TestTokens.bearer(tokens, SELLER, Role.SELLER))).andReturn().getResponse();
    }

    @Test @DisplayName("RPT-1 AC-1、AC-2：每日一列（沒有訂單的日子也有）、依台北的日曆日切；訂單數看成立、付款看付款時間、退款看退款時間")
    void dailyRowsInTaipeiDays() throws Exception {
        var r = report("2026-09-30", "2026-10-02");
        JsonNode body = json.readTree(r.getContentAsString(StandardCharsets.UTF_8));
        StringBuilder rows = new StringBuilder();
        for (JsonNode d : body.get("days"))
            rows.append(String.format("%n    %s 訂單 %d、付款 %s、退款 %s、淨額 %s", d.get("day").asText(), d.get("orderCount").asLong(),
                    d.get("paidAmount").asText(), d.get("refundAmount").asText(), d.get("netAmount").asText()));
        System.out.println("8.7 RPT-1（" + body.get("timeZone").asText() + "）HTTP " + r.getStatus() + rows);
        assertThat(r.getStatus()).isEqualTo(200);
        assertThat(body.get("timeZone").asText()).isEqualTo("Asia/Taipei");
        assertThat(body.get("days")).hasSize(3);
        JsonNode d930 = body.get("days").get(0), d1001 = body.get("days").get(1), d1002 = body.get("days").get(2);
        assertThat(d930.get("orderCount").asLong()).isEqualTo(1);                // 23:59:59 那一張
        assertThat(d930.get("paidAmount").decimalValue()).isEqualByComparingTo("0");
        assertThat(d1001.get("orderCount").asLong()).isEqualTo(2);               // 00:00:00 那一張 + 中午那一張
        assertThat(d1001.get("paidAmount").decimalValue()).isEqualByComparingTo("400");   // 9/30 成立、10/01 付款的 100 算 10/01
        assertThat(d1002.get("orderCount").asLong()).isZero();                   // AC-1：沒有訂單的日子也要有一列
        assertThat(d1002.get("refundAmount").decimalValue()).isEqualByComparingTo("50");
        assertThat(d1002.get("netAmount").decimalValue()).isEqualByComparingTo("-50");
        assertThat(body.get("totalNet").decimalValue()).isEqualByComparingTo("350");
    }

    @Test @DisplayName("RPT-1 AC-3：區間超過 366 天 → 400；結束日早於開始日 → 400")
    void rangeLimits() throws Exception {
        var tooLong = report("2025-01-01", "2026-01-02");
        var reversed = report("2026-10-02", "2026-09-30");
        System.out.println("8.7 RPT-1 AC-3：367 天 → " + tooLong.getStatus() + "，結束日早於開始日 → " + reversed.getStatus());
        assertThat(tooLong.getStatus()).isEqualTo(400);
        assertThat(reversed.getStatus()).isEqualTo(400);
    }
}
```

**`src/test/java/com/example/shop/acceptance/HealthProbeTest.java`**

```java
package com.example.shop.acceptance;

import com.example.shop.ShopApplication;
import com.example.shop.support.TestInfra;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.boot.web.context.WebServerApplicationContext;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 0.12.2 追溯表：「0.6.3 readiness / liveness ｜ 0.10.6 的腳本 → 改寫成整合測試 ｜ 00 ✅、08」。
 * 0.10.6 的腳本：全部正常 → Redis 停掉 → MySQL 停掉 → 全部恢復，每一次看 health、liveness、readiness 三個端點的狀態碼。
 * 這裡的 MySQL 是所有測試共用的那一台（8.4.2）：stop 之後它的埠會換（8.4.4），後面的測試就連不上了 —— 所以 MySQL 用 pause。
 * 那正好是 0.10.6 沒有量過的那一種（它用的是 docker compose stop）。每一個請求最多等 10 秒：等不到記成 0。
 */
class HealthProbeTest {

    record Probe(int status, long ms) {
        @Override public String toString() { return (status == 0 ? "沒有回應" : "HTTP " + status) + "（" + ms + " ms）"; }
    }

    static Probe probe(HttpClient http, int port, String path) {
        long t0 = System.nanoTime();
        int st;
        try {
            st = http.send(HttpRequest.newBuilder(URI.create("http://localhost:" + port + "/actuator/" + path)).timeout(Duration.ofSeconds(10)).build(),
                    HttpResponse.BodyHandlers.discarding()).statusCode();
        } catch (Exception e) { st = 0; }
        return new Probe(st, (System.nanoTime() - t0) / 1_000_000);
    }

    static List<Probe> row(String label, HttpClient http, int port) {
        List<Probe> r = new ArrayList<>();
        for (String p : List.of("health", "health/liveness", "health/readiness")) r.add(probe(http, port, p));
        System.out.printf("0.10.6 %-22s health %-22s liveness %-22s readiness %s%n", label, r.get(0), r.get(1), r.get(2));
        return r;
    }

    @Test @DisplayName("0.6.3 最後兩列：Redis 停掉 → liveness、readiness 都 UP；MySQL 卡住 → liveness UP、readiness 不是 UP；恢復 → 全部 200")
    void probesFollowDependencies() throws Exception {
        try (var ctx = new SpringApplicationBuilder(ShopApplication.class).run("--server.port=0", "--shop.order.jobs-enabled=false",
                "--shop.inventory.jobs-enabled=false", "--spring.main.banner-mode=off", "--logging.level.root=ERROR")) {
            int port = ((WebServerApplicationContext) ctx).getWebServer().getPort();
            HttpClient http = HttpClient.newHttpClient();
            String redis = TestInfra.redisContainer(), mysql = TestInfra.mysqlContainer();
            List<Probe> ok = row("全部正常", http, port), redisDown, mysqlFrozen, back;
            try {
                TestInfra.docker("stop", redis);
                redisDown = row("Redis 停掉", http, port);
            } finally {
                TestInfra.docker("start", redis);
            }
            try {
                TestInfra.docker("pause", mysql);
                mysqlFrozen = row("MySQL 卡住（pause）", http, port);
            } finally {
                TestInfra.docker("unpause", mysql);
            }
            Thread.sleep(2000);
            back = row("全部恢復", http, port);

            assertThat(ok).extracting(Probe::status).containsExactly(200, 200, 200);
            assertThat(redisDown).extracting(Probe::status).containsExactly(503, 200, 200);
            assertThat(mysqlFrozen.get(1).status()).as("liveness 不看任何依賴").isEqualTo(200);
            assertThat(mysqlFrozen.get(2).status()).as("readiness：MySQL 卡住就不能接流量").isNotEqualTo(200);
            assertThat(back).extracting(Probe::status).containsExactly(200, 200, 200);
        }
    }
}
```

**`src/test/java/com/example/shop/shared/security/LoadTestTokens.java`**

```java
package com.example.shop.shared.security;

import com.example.shop.shared.config.ShopProperties;
import com.example.shop.shared.web.Role;
import org.springframework.boot.context.properties.bind.Binder;
import org.springframework.core.env.MapPropertySource;
import org.springframework.core.env.StandardEnvironment;

import java.time.Clock;
import java.util.EnumSet;
import java.util.Map;

/**
 * 8.6 獨立行程的壓測工具：它沒有 Spring 的 context，但 token 還是要由「正式的」AccessTokens 簽（TestTokens 的理由：
 * 自己組的 JWT 會跟正式的分家，壓測卻照樣是 201）。AccessTokens 的建構子是 package-private，所以這個類別放在同一個套件。
 */
public final class LoadTestTokens {
    private final AccessTokens tokens;

    public LoadTestTokens(String jwtSecret) {
        var env = new StandardEnvironment();
        env.getPropertySources().addFirst(new MapPropertySource("loadtest", Map.of("shop.security.jwt-secret", jwtSecret)));
        ShopProperties props = Binder.get(env).bind("shop", ShopProperties.class).get();     // 只綁 security；其他段落是 null，AccessTokens 用不到
        this.tokens = new AccessTokens(props, Clock.systemUTC());
    }

    public String bearer(long userId) {
        return bearer(userId, Role.BUYER);
    }

    public String bearer(long userId, Role role) {
        return "Bearer " + tokens.issue(userId, EnumSet.of(role)).token();
    }
}
```

**`src/test/java/com/example/shop/loadtest/ExternalLoad.java`**

```java
package com.example.shop.loadtest;

import com.example.shop.shared.security.LoadTestTokens;
import com.rabbitmq.client.ConnectionFactory;
import io.lettuce.core.RedisClient;
import io.lettuce.core.api.StatefulRedisConnection;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.Statement;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 8.6 獨立行程的壓測工具：應用程式是另一個 JVM（scripts/loadtest.sh 用 java -jar 啟動的正式 jar），這個行程只負責送請求、量時間。
 *
 * 第 04、06、07 章的 E7、G10、H5 都是「客戶端跟伺服器在同一個 JVM」：2,000 條等著送出的客戶端執行緒、200 條 HttpClient 的執行緒、
 * Tomcat 的 200 條、Lettuce 的 I/O 執行緒、GC 全部在一起。這裡的客戶端程式碼刻意跟 E7 / G10 一模一樣（同樣的執行緒模型、
 * 同樣從「預定送出的時間」算延遲），讓「同一個 JVM 或不是」成為唯一的變數。
 *
 *   flash   E7（4.8.1）：BUYERS 個買家搶 STOCK 件，open 每秒 rps 個（rps=0：封閉式 200 個客戶端）
 *   detail  G10（6.4.5）：同一個商品每秒 1,000 次 GET /api/products/{id}，10 秒
 *   orders  0.6.2：GET /api/orders 每秒 100 次、10 秒，每一次是隨機的一位種子買家（D6 那種「其實都是同一位」不算）
 *   report  0.6.2、US-RPT-1 AC-4：賣家日報表 90 天，每秒 5 次、30 秒（賣家 2：種子資料裡最大的賣家）
 *   search  0.6.2：搜尋每秒 100 次、隨機關鍵字（D6 的那一組）
 *   place   0.6.2：一般商品下單每秒 50 次、分散在 1,000 個商品（這個工具自己建的商品）
 *   callback 0.6.2：付款回呼每秒 50 次（先建好訂單與付款，再照時間表送有簽章的回呼）
 */
public final class ExternalLoad {

    static final String SHOP_JDBC = "jdbc:mysql://localhost:3306/shop?useSSL=false&allowPublicKeyRetrieval=true&connectionTimeZone=UTC";
    static String base;
    static Map<String, String> opt;

    public static void main(String[] args) throws Exception {
        try { run(args); } catch (Throwable t) { t.printStackTrace(); System.exit(1); }   // HttpClient 的執行緒不是 daemon：例外之後不 exit，行程會一直掛著
        System.exit(0);
    }

    static void run(String[] args) throws Exception {
        opt = new HashMap<>();
        for (int i = 1; i < args.length; i++) { String[] kv = args[i].split("=", 2); opt.put(kv[0], kv.length > 1 ? kv[1] : "true"); }
        base = opt.getOrDefault("base", "http://localhost:18080");
        switch (args[0]) {
            case "flash" -> flash();
            case "detail" -> detail();
            case "orders" -> orders();
            case "report" -> report();
            case "search" -> search();
            case "place" -> place();
            case "callback" -> callback();
            case "peak" -> System.out.printf("  應用程式那個 JVM 的執行緒最多 %.0f 條（jvm.threads.peak）%n", metric("jvm.threads.peak"));
            case "drill" -> ExternalDrill.main(Arrays.copyOfRange(args, 1, args.length));
            default -> throw new IllegalArgumentException(args[0]);
        }
    }

    static long[] lockWaits(Connection root) throws Exception {
        long[] r = new long[2];
        try (Statement s = root.createStatement(); ResultSet rs = s.executeQuery("SHOW GLOBAL STATUS WHERE Variable_name IN ('Innodb_row_lock_waits', 'Innodb_row_lock_time')")) {
            while (rs.next()) if (rs.getString(1).equals("Innodb_row_lock_waits")) r[0] = rs.getLong(2); else r[1] = rs.getLong(2);
        }
        return r;
    }

    static long questions(Connection root) throws Exception {
        try (Statement s = root.createStatement(); ResultSet rs = s.executeQuery("SHOW GLOBAL STATUS LIKE 'Questions'")) { rs.next(); return rs.getLong(2); }
    }

    static long one(Connection c, String sql, Object... params) throws Exception {
        try (var ps = c.prepareStatement(sql)) {
            for (int i = 0; i < params.length; i++) ps.setObject(i + 1, params[i]);
            try (ResultSet rs = ps.executeQuery()) { rs.next(); return rs.getLong(1); }
        }
    }

    static void exec(Connection c, String sql, Object... params) throws Exception {
        try (var ps = c.prepareStatement(sql)) {
            for (int i = 0; i < params.length; i++) ps.setObject(i + 1, params[i]);
            ps.executeUpdate();
        }
    }

    /**
     * 應用程式那一側的一個指標目前的值，經過 JMX（scripts/loadtest.sh 打開了 9010）。
     * 第一版走 HTTP 的 /actuator/metrics：SecurityConfig 的 anyRequest().denyAll() 擋掉了（401），而這個方法把「不是 200」當成 0 ——
     * 連線池、Redis 的數字全部是 0，而且沒有任何錯誤。煙霧測試才看出來。現在讀不到就大聲說，不回 0。
     *   hikaricp.connections.active / pending → Hikari 自己的 MBean（跟 E7 在 JVM 裡讀的是同一個東西）
     *   其他 → Spring Boot 的 Metrics endpoint MBean
     */
    static javax.management.MBeanServerConnection jmx;

    static synchronized double metric(String name) {
        try {
            if (jmx == null) jmx = javax.management.remote.JMXConnectorFactory.connect(
                    new javax.management.remote.JMXServiceURL("service:jmx:rmi:///jndi/rmi://127.0.0.1:9010/jmxrmi")).getMBeanServerConnection();
            if (name.startsWith("hikaricp.connections.")) {
                var pool = jmx.queryNames(new javax.management.ObjectName("com.zaxxer.hikari:type=Pool (*"), null).iterator().next();
                return ((Number) jmx.getAttribute(pool, name.endsWith("pending") ? "ThreadsAwaitingConnection" : "ActiveConnections")).doubleValue();
            }
            Object r = jmx.invoke(new javax.management.ObjectName("org.springframework.boot:type=Endpoint,name=Metrics"), "metric",
                    new Object[]{name, null}, new String[]{"java.lang.String", "java.util.List"});
            if (r == null) return 0;                                         // 這個指標還沒有被註冊過（例如還沒有任何一次 Redis 失敗）
            var m = (List<?>) ((Map<?, ?>) r).get("measurements");
            return ((Number) ((Map<?, ?>) m.get(0)).get("value")).doubleValue();
        } catch (Exception e) {
            System.out.println("  ⚠️ 指標 " + name + " 讀不到：" + e);
            return Double.NaN;
        }
    }

    // ─────────────── flash：E7 ───────────────

    static final long HOT = 9_900_701;
    static final int STOCK = 500, BUYERS = 2_000, CLIENTS = 200;
    static final long FIRST_BUYER = 3_000_000;

    static void cleanup(Connection c, StatefulRedisConnection<String, String> redis) throws Exception {
        // 跟 E7FlashSaleLoadTest.cleanup 同樣的順序
        exec(c, "DELETE n FROM notifications n JOIN orders o ON o.id = n.payload->>'$.aggregateId' WHERE o.buyer_id >= ? AND o.buyer_id < ?", FIRST_BUYER, FIRST_BUYER + BUYERS);
        exec(c, "DELETE FROM notifications WHERE user_id >= ? AND user_id < ?", FIRST_BUYER, FIRST_BUYER + BUYERS);
        exec(c, "DELETE h FROM order_status_history h JOIN orders o ON o.id = h.order_id WHERE o.buyer_id >= ? AND o.buyer_id < ?", FIRST_BUYER, FIRST_BUYER + BUYERS);
        exec(c, "DELETE i FROM order_items i JOIN orders o ON o.id = i.order_id WHERE o.buyer_id >= ? AND o.buyer_id < ?", FIRST_BUYER, FIRST_BUYER + BUYERS);
        exec(c, "DELETE FROM idempotency_keys WHERE buyer_id >= ? AND buyer_id < ?", FIRST_BUYER, FIRST_BUYER + BUYERS);
        exec(c, "DELETE FROM orders WHERE buyer_id >= ? AND buyer_id < ?", FIRST_BUYER, FIRST_BUYER + BUYERS);
        exec(c, "DELETE FROM inventory_reservations WHERE product_id = ?", HOT);
        exec(c, "DELETE FROM inventory_ledger WHERE product_id = ?", HOT);
        exec(c, "DELETE FROM inventory WHERE product_id = ?", HOT);
        exec(c, "DELETE FROM products WHERE id = ?", HOT);
        redis.sync().del("product:v1:" + HOT, "stock:" + HOT, "available:" + HOT, "trending:24h:top10");   // TestRedis.forgetProducts
    }

    static void flash() throws Exception {
        boolean hot = Boolean.parseBoolean(opt.getOrDefault("hot", "true"));
        int rps = Integer.parseInt(opt.getOrDefault("rps", "200"));
        int rounds = Integer.parseInt(opt.getOrDefault("rounds", "3"));      // 第一輪是暖機（E7 / H5 也是）
        String label = opt.getOrDefault("label", "external");
        LoadTestTokens tokens = new LoadTestTokens(opt.getOrDefault("jwt-secret", "local-dev-only-secret-0123456789abcdef"));
        try (Connection c = DriverManager.getConnection(SHOP_JDBC, "shop", "shop");
             Connection root = DriverManager.getConnection(SHOP_JDBC, "root", "root");
             RedisClient rc = RedisClient.create("redis://localhost:6379");
             StatefulRedisConnection<String, String> redis = rc.connect();
             var amqp = amqp().newConnection(); var ch = amqp.createChannel()) {
            for (int round = 0; round < rounds; round++) {
                cleanup(c, redis);
                exec(c, "INSERT INTO products (id, seller_id, category_id, name, price, status, hot) VALUES (?, 2, 11, '限量商品', 1990.00, 'ON_SALE', ?)", HOT, hot);
                exec(c, "INSERT INTO inventory (product_id, on_hand, reserved) VALUES (?, ?, 0)", HOT, STOCK);
                exec(c, "INSERT INTO inventory_ledger (product_id, delta_on_hand, delta_reserved, reason, ref) VALUES (?, ?, 0, 'INITIAL', 'e7')", HOT, STOCK);
                long[] lw0 = lockWaits(root);

                HttpClient http = HttpClient.newBuilder().executor(Executors.newFixedThreadPool(CLIENTS)).build();
                ExecutorService clients = rps > 0 ? Executors.newCachedThreadPool() : Executors.newFixedThreadPool(CLIENTS);
                ConcurrentHashMap<Integer, AtomicInteger> statuses = new ConcurrentHashMap<>();
                ConcurrentLinkedQueue<Long> lat = new ConcurrentLinkedQueue<>();
                ConcurrentLinkedQueue<HttpRequest> unavailable = new ConcurrentLinkedQueue<>();
                AtomicInteger maxActive = new AtomicInteger(), maxPending = new AtomicInteger();
                ScheduledExecutorService sampler = Executors.newSingleThreadScheduledExecutor();
                sampler.scheduleAtFixedRate(() -> {                           // E7 是每 5 ms 讀 MXBean；這裡隔著 HTTP，每 100 ms 一次
                    maxActive.accumulateAndGet((int) metric("hikaricp.connections.active"), Math::max);
                    maxPending.accumulateAndGet((int) metric("hikaricp.connections.pending"), Math::max);
                }, 0, 100, TimeUnit.MILLISECONDS);
                CountDownLatch go = new CountDownLatch(1);
                List<Future<?>> fs = new ArrayList<>();
                long[] start = new long[1];
                for (int i = 0; i < BUYERS; i++) {
                    long buyer = FIRST_BUYER + i;
                    long offset = rps > 0 ? i * 1_000_000_000L / rps : 0;
                    fs.add(clients.submit(() -> {
                        go.await();
                        long due = start[0] + offset;
                        if (rps > 0) { long wait = due - System.nanoTime(); if (wait > 0) TimeUnit.NANOSECONDS.sleep(wait); }
                        HttpRequest req = HttpRequest.newBuilder(URI.create(base + "/api/orders"))
                                .header("Authorization", tokens.bearer(buyer)).header("Content-Type", "application/json")
                                .header("Idempotency-Key", "e7-" + buyer)
                                .POST(HttpRequest.BodyPublishers.ofString("{\"items\":[{\"productId\":" + HOT + ",\"quantity\":1,\"unitPrice\":1990}]}"))
                                .build();
                        long s = rps > 0 ? due : System.nanoTime();
                        int status = http.send(req, HttpResponse.BodyHandlers.discarding()).statusCode();
                        lat.add(System.nanoTime() - s);
                        statuses.computeIfAbsent(status, k -> new AtomicInteger()).incrementAndGet();
                        if (status == 503) unavailable.add(req);
                        return null;
                    }));
                }
                long t0 = System.nanoTime();
                start[0] = t0;
                go.countDown();
                for (Future<?> f : fs) f.get();
                double secs = (System.nanoTime() - t0) / 1e9;
                sampler.shutdown();
                clients.shutdown();
                Map<Integer, Integer> retried = new TreeMap<>();
                if (!unavailable.isEmpty()) Thread.sleep(1000);
                for (HttpRequest req : unavailable) retried.merge(http.send(req, HttpResponse.BodyHandlers.discarding()).statusCode(), 1, Integer::sum);
                long settleStart = System.nanoTime();
                while (one(c, "SELECT COUNT(*) FROM inventory_reservations WHERE product_id = ? AND counted = FALSE AND status IN ('HELD', 'CONFIRMED')", HOT) > 0
                        && System.nanoTime() - settleStart < 120_000_000_000L) Thread.sleep(20);
                long settledMs = (System.nanoTime() - settleStart) / 1_000_000;
                for (int i = 0; i < 300; i++) {                               // 這一輪的通知寄完，才開始下一輪（E7 一樣）
                    if (ch.queueDeclarePassive("shop.notification.order-events").getMessageCount() == 0) break;
                    Thread.sleep(100);
                }
                long[] lw1 = lockWaits(root);
                long[] a = lat.stream().mapToLong(Long::longValue).sorted().toArray();
                Map<Integer, Integer> st = new TreeMap<>();
                statuses.forEach((k, v) -> st.put(k, v.get()));
                System.out.printf("  %s %s HTTP %s │ %5.2f 秒 │ p50 %5.0f  p95 %5.0f  p99 %5.0f  最慢 %5.0f ms │ reserved=%d 明細=%d RESERVE 帳=%d │ 連線池：同時使用最多 %d、等待最多 %d │ 最後一個回應之後 %,d ms 全部落帳 │ 列鎖等待 %,d 次、共 %,d ms%s%n",
                        label, round == 0 ? "（暖機）" : "", st, secs, a[a.length / 2] / 1e6, a[(int) (a.length * 0.95)] / 1e6, a[(int) (a.length * 0.99)] / 1e6, a[a.length - 1] / 1e6,
                        one(c, "SELECT reserved FROM inventory WHERE product_id = ?", HOT), one(c, "SELECT COUNT(*) FROM order_items WHERE product_id = ?", HOT),
                        one(c, "SELECT COUNT(*) FROM inventory_ledger WHERE product_id = ? AND reason = 'RESERVE'", HOT), maxActive.get(), maxPending.get(), settledMs,
                        lw1[0] - lw0[0], lw1[1] - lw0[1], retried.isEmpty() ? "" : "\n       └ 503 的請求用同一個 Idempotency-Key 重送 → HTTP " + retried);
                http.close();
            }
            cleanup(c, redis);
        }
        System.out.printf("  壓測工具這個 JVM 的執行緒最多 %d 條%n", java.lang.management.ManagementFactory.getThreadMXBean().getPeakThreadCount());
    }

    static ConnectionFactory amqp() {
        ConnectionFactory f = new ConnectionFactory();
        f.setHost("localhost");
        f.setUsername("shop");
        f.setPassword("shop");
        return f;
    }

    // ─────────────── detail：G10 ───────────────

    static void detail() throws Exception {
        String label = opt.getOrDefault("label", "external");
        try (Connection root = DriverManager.getConnection(SHOP_JDBC, "root", "root")) {
            HttpClient http = HttpClient.newBuilder().executor(Executors.newFixedThreadPool(200)).build();
            for (long id : new long[]{3, 1, 3, 1, 3, 1}) {
                URI uri = URI.create(base + "/api/products/" + id);
                for (int i = 0; i < 500; i++) http.send(HttpRequest.newBuilder(uri).build(), HttpResponse.BodyHandlers.discarding());   // 暖機、填快取（G10 一樣）
                double failures0 = metric("shop.redis.failures"), trips0 = metric("shop.redis.trips");
                long q0 = questions(root);
                ConcurrentLinkedQueue<Long> lat = new ConcurrentLinkedQueue<>();
                ConcurrentHashMap<Integer, Integer> statuses = new ConcurrentHashMap<>();
                long start = System.nanoTime() + 100_000_000L;
                List<CompletableFuture<?>> fs = new ArrayList<>();
                for (int i = 0; i < 10_000; i++) {
                    long due = start + i * 1_000_000L;
                    long w = due - System.nanoTime();
                    if (w > 0) TimeUnit.NANOSECONDS.sleep(w);
                    fs.add(http.sendAsync(HttpRequest.newBuilder(uri).build(), HttpResponse.BodyHandlers.discarding()).whenComplete((r, e) -> {
                        lat.add(System.nanoTime() - due);
                        statuses.merge(e == null ? r.statusCode() : 0, 1, Integer::sum);
                    }));
                }
                CompletableFuture.allOf(fs.toArray(CompletableFuture[]::new)).exceptionally(e -> null).join();
                double secs = (System.nanoTime() - start) / 1e9;
                long[] l = lat.stream().mapToLong(Long::longValue).sorted().toArray();
                System.out.printf("  %s 商品 %d（%s）HTTP %s │ p50 %5.1f  p95 %5.1f  p99 %6.1f  最慢 %6.1f ms │ MySQL %4.0f 句/秒 │ Redis 失敗 %.0f 次、跳開 %.0f 次%n",
                        label, id, id == 1 ? "熱點" : "一般", new TreeMap<>(statuses), l[l.length / 2] / 1e6, l[(int) (l.length * 0.95)] / 1e6, l[(int) (l.length * 0.99)] / 1e6,
                        l[l.length - 1] / 1e6, (questions(root) - q0) / secs, metric("shop.redis.failures") - failures0, metric("shop.redis.trips") - trips0);
            }
        }
    }

    // ─────────────── 0.6.2 的其他幾列：search、place、callback ───────────────

    /** 開放式負載的共用部分：每秒 rps 個、seconds 秒，延遲從預定送出的時間算起；回傳一行統計 */
    static String open(HttpClient http, int rps, int seconds, java.util.function.IntFunction<HttpRequest> request) throws Exception {
        int n = rps * seconds;
        ConcurrentLinkedQueue<Long> lat = new ConcurrentLinkedQueue<>();
        ConcurrentHashMap<Integer, Integer> statuses = new ConcurrentHashMap<>();
        long start = System.nanoTime() + 100_000_000L;
        List<CompletableFuture<?>> fs = new ArrayList<>();
        for (int i = 0; i < n; i++) {
            long due = start + i * (1_000_000_000L / rps);
            long w = due - System.nanoTime();
            if (w > 0) TimeUnit.NANOSECONDS.sleep(w);
            fs.add(http.sendAsync(request.apply(i), HttpResponse.BodyHandlers.discarding()).whenComplete((x, e) -> {
                lat.add(System.nanoTime() - due);
                statuses.merge(e == null ? x.statusCode() : 0, 1, Integer::sum);
            }));
        }
        CompletableFuture.allOf(fs.toArray(CompletableFuture[]::new)).exceptionally(e -> null).join();
        long[] l = lat.stream().mapToLong(Long::longValue).sorted().toArray();
        return String.format("HTTP %s │ p50 %6.1f  p95 %6.1f  p99 %6.1f  最慢 %6.1f ms", new TreeMap<>(statuses),
                l[l.length / 2] / 1e6, l[(int) (l.length * 0.95)] / 1e6, l[(int) (l.length * 0.99)] / 1e6, l[l.length - 1] / 1e6);
    }

    static final String[] WORDS = {"耳機", "充電器", "鍵盤", "T 恤", "洋裝", "慢跑鞋", "平底鍋", "枕", "精華", "唇膏", "堅果", "咖啡", "#12", "無線"};   // D6 的那一組

    /** 0.6.2：搜尋 100 rps、隨機關鍵字 → p95 150 ms、p99 300 ms（3.9.2 的 D6 只量過一次一個請求） */
    static void search() throws Exception {
        String label = opt.getOrDefault("label", "external");
        HttpClient http = HttpClient.newBuilder().executor(Executors.newFixedThreadPool(200)).build();
        Random r = new Random(3);
        int[] categories = {11, 12, 13, 21, 22};
        for (int round = 0; round < 3; round++) {
            String line = open(http, 100, 10, i -> HttpRequest.newBuilder(URI.create(base + "/api/products?q="
                    + java.net.URLEncoder.encode(WORDS[r.nextInt(WORDS.length)], java.nio.charset.StandardCharsets.UTF_8)
                    + "&categoryId=" + categories[r.nextInt(categories.length)] + "&sort=price,asc&size=20")).build());
            System.out.printf("  %s %s 搜尋 每秒 100 次、10 秒 %s%n", label, round == 0 ? "（暖機）" : "", line);
        }
    }

    static final long PLACE_FIRST_PRODUCT = 9_910_001, PLACE_FIRST_BUYER = 3_100_000;
    static final int PLACE_PRODUCTS = 1_000;

    static void placeCleanup(Connection c, StatefulRedisConnection<String, String> redis, long lo, long hi) throws Exception {
        exec(c, "DELETE n FROM notifications n JOIN orders o ON o.id = n.payload->>'$.aggregateId' WHERE o.buyer_id >= ? AND o.buyer_id < ?", lo, hi);
        exec(c, "DELETE FROM notifications WHERE user_id >= ? AND user_id < ?", lo, hi);
        for (String t : List.of("refunds", "payments", "order_status_history", "order_items"))
            exec(c, "DELETE x FROM " + t + " x JOIN orders o ON o.id = x.order_id WHERE o.buyer_id >= ? AND o.buyer_id < ?", lo, hi);
        exec(c, "DELETE FROM idempotency_keys WHERE buyer_id >= ? AND buyer_id < ?", lo, hi);
        exec(c, "DELETE FROM orders WHERE buyer_id >= ? AND buyer_id < ?", lo, hi);
        long p0 = PLACE_FIRST_PRODUCT, p1 = PLACE_FIRST_PRODUCT + PLACE_PRODUCTS;
        exec(c, "DELETE FROM inventory_reservations WHERE product_id >= ? AND product_id < ?", p0, p1);
        exec(c, "DELETE FROM inventory_ledger WHERE product_id >= ? AND product_id < ?", p0, p1);
        exec(c, "DELETE FROM inventory WHERE product_id >= ? AND product_id < ?", p0, p1);
        exec(c, "DELETE FROM products WHERE id >= ? AND id < ?", p0, p1);
        List<String> keys = new ArrayList<>();
        for (long id = p0; id < p1; id++) keys.addAll(List.of("product:v1:" + id, "stock:" + id, "available:" + id));
        redis.sync().del(keys.toArray(String[]::new));
    }

    /** 0.6.2：一般商品下單 50 rps、分散在 1,000 個商品 → p95 150 ms、p99 300 ms。商品是這個工具自己建的（不碰種子資料的庫存） */
    static void place() throws Exception {
        String label = opt.getOrDefault("label", "external");
        LoadTestTokens tokens = new LoadTestTokens(opt.getOrDefault("jwt-secret", "local-dev-only-secret-0123456789abcdef"));
        long lo = PLACE_FIRST_BUYER, hi = PLACE_FIRST_BUYER + 10_000;
        try (Connection c = DriverManager.getConnection(SHOP_JDBC, "shop", "shop");
             RedisClient rc = RedisClient.create("redis://localhost:6379"); StatefulRedisConnection<String, String> redis = rc.connect()) {
            placeCleanup(c, redis, lo, hi);
            for (int i = 0; i < PLACE_PRODUCTS; i++) {
                long id = PLACE_FIRST_PRODUCT + i;
                exec(c, "INSERT INTO products (id, seller_id, category_id, name, price, status) VALUES (?, 2, 11, ?, 100.00, 'ON_SALE')", id, "壓測一般 " + i);
                exec(c, "INSERT INTO inventory (product_id, on_hand, reserved) VALUES (?, 100000, 0)", id);
                exec(c, "INSERT INTO inventory_ledger (product_id, delta_on_hand, delta_reserved, reason, ref) VALUES (?, 100000, 0, 'INITIAL', 'loadtest')", id);
            }
            HttpClient http = HttpClient.newBuilder().executor(Executors.newFixedThreadPool(200)).build();
            Random r = new Random(50);
            AtomicLong buyer = new AtomicLong(lo);
            for (int round = 0; round < 3; round++) {
                String line = open(http, 50, 10, i -> {
                    long b = buyer.getAndIncrement();
                    return HttpRequest.newBuilder(URI.create(base + "/api/orders")).header("Authorization", tokens.bearer(b))
                            .header("Idempotency-Key", "place-" + b).header("Content-Type", "application/json")
                            .POST(HttpRequest.BodyPublishers.ofString("{\"items\":[{\"productId\":" + (PLACE_FIRST_PRODUCT + r.nextInt(PLACE_PRODUCTS)) + ",\"quantity\":1,\"unitPrice\":100}]}")).build();
                });
                System.out.printf("  %s %s 一般商品下單 每秒 50 次、10 秒、1,000 個商品 %s%n", label, round == 0 ? "（暖機）" : "", line);
            }
            Thread.sleep(3000);                                               // 讓通知的消費者把這幾輪的信寄完，再清
            placeCleanup(c, redis, lo, hi);
        }
    }

    /** 0.6.2：付款回呼 50 rps → p99 1 s（金流 3 秒逾時）。先用 HTTP 建好訂單與付款（不計時），再照時間表送有簽章的回呼 */
    static void callback() throws Exception {
        String label = opt.getOrDefault("label", "external");
        String secret = opt.getOrDefault("callback-secret", "local-dev-only-payment-callback-secret-0123");
        LoadTestTokens tokens = new LoadTestTokens(opt.getOrDefault("jwt-secret", "local-dev-only-secret-0123456789abcdef"));
        long lo = PLACE_FIRST_BUYER + 20_000, hi = lo + 10_000;
        try (Connection c = DriverManager.getConnection(SHOP_JDBC, "shop", "shop");
             RedisClient rc = RedisClient.create("redis://localhost:6379"); StatefulRedisConnection<String, String> redis = rc.connect()) {
            placeCleanup(c, redis, lo, hi);
            for (int i = 0; i < 100; i++) {
                long id = PLACE_FIRST_PRODUCT + i;
                exec(c, "INSERT INTO products (id, seller_id, category_id, name, price, status) VALUES (?, 2, 11, ?, 100.00, 'ON_SALE')", id, "壓測回呼 " + i);
                exec(c, "INSERT INTO inventory (product_id, on_hand, reserved) VALUES (?, 100000, 0)", id);
                exec(c, "INSERT INTO inventory_ledger (product_id, delta_on_hand, delta_reserved, reason, ref) VALUES (?, 100000, 0, 'INITIAL', 'loadtest')", id);
            }
            HttpClient http = HttpClient.newBuilder().executor(Executors.newFixedThreadPool(200)).build();
            long b = lo;
            for (int round = 0; round < 3; round++) {
                long[] payments = new long[500];
                for (int i = 0; i < payments.length; i++, b++) {                // 準備：500 張訂單、500 筆付款（循序、不計時）
                    String bearer = tokens.bearer(b);
                    HttpResponse<String> o = http.send(HttpRequest.newBuilder(URI.create(base + "/api/orders")).header("Authorization", bearer)
                            .header("Idempotency-Key", "cb-" + b).header("Content-Type", "application/json")
                            .POST(HttpRequest.BodyPublishers.ofString("{\"items\":[{\"productId\":" + (PLACE_FIRST_PRODUCT + i % 100) + ",\"quantity\":1,\"unitPrice\":100}]}")).build(),
                            HttpResponse.BodyHandlers.ofString());
                    String orderNo = o.body().replaceAll(".*\"orderNo\":\"([^\"]+)\".*", "$1");
                    HttpResponse<String> p = http.send(HttpRequest.newBuilder(URI.create(base + "/api/orders/" + orderNo + "/payments")).header("Authorization", bearer)
                            .POST(HttpRequest.BodyPublishers.noBody()).build(), HttpResponse.BodyHandlers.ofString());
                    payments[i] = Long.parseLong(p.body().replaceAll(".*\"paymentId\":(\\d+).*", "$1"));
                }
                String line = open(http, 50, 10, i -> {
                    long pid = payments[i];
                    String txn = "lt-" + pid;
                    java.math.BigDecimal amount = new java.math.BigDecimal("100.00");
                    String sig = com.example.shop.payment.internal.CallbackSignature.sign(secret,
                            com.example.shop.payment.internal.CallbackSignature.canonical(pid, txn, amount, true));
                    return HttpRequest.newBuilder(URI.create(base + "/api/payments/callback")).header("Content-Type", "application/json")
                            .POST(HttpRequest.BodyPublishers.ofString("{\"paymentId\":%d,\"providerTxnId\":\"%s\",\"amount\":100.00,\"result\":\"SUCCEEDED\",\"signature\":\"%s\"}"
                                    .formatted(pid, txn, sig))).build();
                });
                long paid = one(c, "SELECT COUNT(*) FROM orders WHERE buyer_id >= ? AND buyer_id < ? AND status = 'PAID'", lo, hi);
                System.out.printf("  %s %s 付款回呼 每秒 50 次、10 秒 %s │ 到目前為止 PAID %d 張%n", label, round == 0 ? "（暖機）" : "", line, paid);
            }
            Thread.sleep(3000);
            placeCleanup(c, redis, lo, hi);
        }
    }

    // ─────────────── report：0.6.2 的「賣家日報表（90 天）」───────────────

    static void report() throws Exception {
        String label = opt.getOrDefault("label", "external");
        int rps = Integer.parseInt(opt.getOrDefault("rps", "5")), seconds = Integer.parseInt(opt.getOrDefault("seconds", "30"));
        LoadTestTokens tokens = new LoadTestTokens(opt.getOrDefault("jwt-secret", "local-dev-only-secret-0123456789abcdef"));
        HttpClient http = HttpClient.newBuilder().executor(Executors.newFixedThreadPool(50)).build();
        // 種子資料的「現在」是 2026-09-29（2.8.2）：90 天 = 07-01 ～ 09-28，跟 3.9.2 的 D6 同一個區間
        URI uri = URI.create(base + "/api/seller/reports/daily-sales?from=2026-07-01&to=2026-09-28");
        String bearer = tokens.bearer(2, com.example.shop.shared.web.Role.SELLER);
        for (int round = 0; round < 3; round++) {                            // 第一輪暖機
            int n = rps * seconds;
            ConcurrentLinkedQueue<Long> lat = new ConcurrentLinkedQueue<>();
            ConcurrentHashMap<Integer, Integer> statuses = new ConcurrentHashMap<>();
            long start = System.nanoTime() + 100_000_000L;
            List<CompletableFuture<?>> fs = new ArrayList<>();
            for (int i = 0; i < n; i++) {
                long due = start + i * (1_000_000_000L / rps);
                long w = due - System.nanoTime();
                if (w > 0) TimeUnit.NANOSECONDS.sleep(w);
                fs.add(http.sendAsync(HttpRequest.newBuilder(uri).header("Authorization", bearer).build(), HttpResponse.BodyHandlers.discarding()).whenComplete((x, e) -> {
                    lat.add(System.nanoTime() - due);
                    statuses.merge(e == null ? x.statusCode() : 0, 1, Integer::sum);
                }));
            }
            CompletableFuture.allOf(fs.toArray(CompletableFuture[]::new)).exceptionally(e -> null).join();
            long[] l = lat.stream().mapToLong(Long::longValue).sorted().toArray();
            System.out.printf("  %s %s 賣家日報表 90 天，每秒 %d 次、%d 秒 HTTP %s │ p50 %6.1f  p95 %6.1f  p99 %6.1f  最慢 %6.1f ms%n",
                    label, round == 0 ? "（暖機）" : "", rps, seconds, new TreeMap<>(statuses),
                    l[l.length / 2] / 1e6, l[(int) (l.length * 0.95)] / 1e6, l[(int) (l.length * 0.99)] / 1e6, l[l.length - 1] / 1e6);
        }
    }

    // ─────────────── orders：0.6.2 的「我的訂單」 ───────────────

    static void orders() throws Exception {
        String label = opt.getOrDefault("label", "external");
        int rps = Integer.parseInt(opt.getOrDefault("rps", "100")), seconds = Integer.parseInt(opt.getOrDefault("seconds", "10"));
        LoadTestTokens tokens = new LoadTestTokens(opt.getOrDefault("jwt-secret", "local-dev-only-secret-0123456789abcdef"));
        HttpClient http = HttpClient.newBuilder().executor(Executors.newFixedThreadPool(200)).build();
        Random r = new Random(62);
        for (int round = 0; round < 4; round++) {                            // 第一輪暖機
            int n = rps * seconds;
            long[] buyers = new long[n];
            for (int i = 0; i < n; i++) buyers[i] = 1001 + r.nextInt(20_000);  // 種子資料的 2 萬位買家（2.8.2：1001～21000，含三位重度買家）
            ConcurrentLinkedQueue<Long> lat = new ConcurrentLinkedQueue<>();
            ConcurrentHashMap<Integer, Integer> statuses = new ConcurrentHashMap<>();
            long start = System.nanoTime() + 100_000_000L;
            List<CompletableFuture<?>> fs = new ArrayList<>();
            for (int i = 0; i < n; i++) {
                long due = start + i * (1_000_000_000L / rps);
                long w = due - System.nanoTime();
                if (w > 0) TimeUnit.NANOSECONDS.sleep(w);
                HttpRequest req = HttpRequest.newBuilder(URI.create(base + "/api/orders?page=0&size=20")).header("Authorization", tokens.bearer(buyers[i])).build();
                fs.add(http.sendAsync(req, HttpResponse.BodyHandlers.discarding()).whenComplete((x, e) -> {
                    lat.add(System.nanoTime() - due);
                    statuses.merge(e == null ? x.statusCode() : 0, 1, Integer::sum);
                }));
            }
            CompletableFuture.allOf(fs.toArray(CompletableFuture[]::new)).exceptionally(e -> null).join();
            long[] l = lat.stream().mapToLong(Long::longValue).sorted().toArray();
            System.out.printf("  %s %s GET /api/orders 每秒 %d 次、%d 秒（%,d 位不同的買家）HTTP %s │ p50 %5.1f  p95 %5.1f  p99 %6.1f  最慢 %6.1f ms%n",
                    label, round == 0 ? "（暖機）" : "", rps, seconds, Arrays.stream(buyers).distinct().count(), new TreeMap<>(statuses),
                    l[l.length / 2] / 1e6, l[(int) (l.length * 0.95)] / 1e6, l[(int) (l.length * 0.99)] / 1e6, l[l.length - 1] / 1e6);
        }
    }
}
```

**`src/test/java/com/example/shop/loadtest/ExternalDrill.java`**

```java
package com.example.shop.loadtest;

import com.example.shop.shared.security.LoadTestTokens;
import io.lettuce.core.RedisClient;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.Statement;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;

/**
 * 8.6 降級演練，壓測的客戶端在另一個行程：第 06 章的 G8（Redis）與第 07 章的 H6（RabbitMQ），流量的組成與時間表照抄，
 * 應用程式是 scripts/loadtest.sh 用 java -jar 啟動的那一個。第 20 秒 docker stop / pause，第 80 秒恢復，每 5 秒一列。
 *
 *   drill mix=g8 target=shop-redis-1 mode=stop      G8：詳情（100 個商品）、排行、熱點下單、一般下單
 *   drill mix=h6 target=shop-rabbitmq-1 mode=pause  H6：一般下單、熱點下單、詳情
 *
 * 延遲跟 G8、H6 一樣從「真的送出」算起（它們是演練，不是 SLO 的量測）。Redis 的失敗與跳開、連線池的等待，從應用程式的 /actuator/metrics 讀。
 */
public final class ExternalDrill {

    record Sample(String api, int status, long nanos) {}

    static final long HOT = 9_908_601, NORMAL = 9_908_602, BUYER = 3_860_000;

    public static void main(String[] args) throws Exception {
        Map<String, String> opt = new HashMap<>();
        for (String a : args) { String[] kv = a.split("=", 2); opt.put(kv[0], kv.length > 1 ? kv[1] : "true"); }
        String base = opt.getOrDefault("base", "http://localhost:18080"), mix = opt.getOrDefault("mix", "g8");
        String target = opt.getOrDefault("target", mix.equals("g8") ? "shop-redis-1" : "shop-rabbitmq-1"), mode = opt.getOrDefault("mode", "stop");
        ExternalLoad.base = base;
        LoadTestTokens tokens = new LoadTestTokens(opt.getOrDefault("jwt-secret", "local-dev-only-secret-0123456789abcdef"));
        try (Connection c = DriverManager.getConnection(ExternalLoad.SHOP_JDBC, "shop", "shop");
             Connection root = DriverManager.getConnection(ExternalLoad.SHOP_JDBC, "root", "root")) {
            cleanup(c);
            ExternalLoad.exec(c, "INSERT INTO products (id, seller_id, category_id, name, price, status, hot) VALUES (?, 2, 11, '演練熱點', 100.00, 'ON_SALE', TRUE)", HOT);
            ExternalLoad.exec(c, "INSERT INTO products (id, seller_id, category_id, name, price, status) VALUES (?, 2, 11, '演練一般', 100.00, 'ON_SALE')", NORMAL);
            for (long id : new long[]{HOT, NORMAL}) ExternalLoad.exec(c, "INSERT INTO inventory (product_id, on_hand, reserved) VALUES (?, 100000, 0)", id);
            ExternalLoad.exec(c, "UPDATE outbox_events SET published_at = CURRENT_TIMESTAMP(3) WHERE published_at IS NULL");   // 別人留下的（7.12.1）
            List<Long> products = new ArrayList<>();
            try (Statement s = c.createStatement(); ResultSet rs = s.executeQuery("SELECT id FROM products WHERE status = 'ON_SALE' AND NOT hot ORDER BY id LIMIT 100")) {
                while (rs.next()) products.add(rs.getLong(1));
            }
            HttpClient http = HttpClient.newBuilder().executor(Executors.newFixedThreadPool(64)).build();
            for (long id : products) http.send(HttpRequest.newBuilder(URI.create(base + "/api/products/" + id)).build(), HttpResponse.BodyHandlers.discarding());

            @SuppressWarnings("unchecked") ConcurrentLinkedQueue<Sample>[] buckets = new ConcurrentLinkedQueue[20];
            for (int i = 0; i < 20; i++) buckets[i] = new ConcurrentLinkedQueue<>();
            long[] questions = new long[21];
            double[] failures = new double[21], trips = new double[21];
            int[] poolWait = new int[20];
            long[] outbox = new long[20];
            ScheduledExecutorService clock = Executors.newScheduledThreadPool(3);
            ExecutorService senders = Executors.newCachedThreadPool();
            long t0 = System.nanoTime();
            AtomicLong buyerSeq = new AtomicLong(BUYER);
            Random rnd = new Random(8);
            boolean g8 = mix.equals("g8");
            long tickNanos = g8 ? 5_000_000L : 20_000_000L;
            ScheduledFuture<?> ticker = clock.scheduleAtFixedRate(() -> {
                long now = System.nanoTime();
                int bucket = (int) ((now - t0) / 5_000_000_000L);
                if (bucket >= 20) return;
                long tick = (now - t0) / tickNanos;
                List<String[]> reqs = new ArrayList<>();
                if (g8) {                                                      // G8：每 5 ms 一個 tick
                    reqs.add(new String[]{"詳情", "/api/products/" + products.get(rnd.nextInt(products.size()))});
                    if (tick % 2 == 0) reqs.add(new String[]{"詳情", "/api/products/" + products.get(rnd.nextInt(products.size()))});
                    if (tick % 3 == 0) reqs.add(new String[]{"詳情", "/api/products/" + products.get(rnd.nextInt(products.size()))});
                    if (tick % 10 == 0) reqs.add(new String[]{"排行", "/api/products/trending"});
                    if (tick % 10 == 5) reqs.add(new String[]{"熱點下單", "" + HOT});
                    if (tick % 40 == 0) reqs.add(new String[]{"一般下單", "" + NORMAL});
                } else {                                                       // H6：每 20 ms 一個 tick
                    reqs.add(new String[]{"詳情", "/api/products/" + NORMAL});
                    if (tick % 5 == 0) reqs.add(new String[]{"一般下單", "" + NORMAL});
                    if (tick % 5 == 2) reqs.add(new String[]{"熱點下單", "" + HOT});
                }
                for (String[] r : reqs) senders.submit(() -> {
                    long s = System.nanoTime();
                    HttpRequest.Builder b;
                    if (!r[0].endsWith("下單")) b = HttpRequest.newBuilder(URI.create(base + r[1])).timeout(java.time.Duration.ofSeconds(10));
                    else {
                        long buyer = buyerSeq.getAndIncrement();
                        b = HttpRequest.newBuilder(URI.create(base + "/api/orders")).timeout(java.time.Duration.ofSeconds(10))
                                .header("Authorization", tokens.bearer(buyer)).header("Idempotency-Key", "drill-" + buyer).header("Content-Type", "application/json")
                                .POST(HttpRequest.BodyPublishers.ofString("{\"items\":[{\"productId\":" + r[1] + ",\"quantity\":1,\"unitPrice\":100}]}"));
                    }
                    int status;
                    try { status = http.send(b.build(), HttpResponse.BodyHandlers.discarding()).statusCode(); } catch (Exception e) { status = 0; }
                    buckets[bucket].add(new Sample(r[0], status, System.nanoTime() - s));
                });
            }, 0, tickNanos, TimeUnit.NANOSECONDS);
            ScheduledFuture<?> sampler = clock.scheduleAtFixedRate(() -> {     // 每 200 ms：連線池在等的執行緒（應用程式那一側）
                int b = (int) ((System.nanoTime() - t0) / 5_000_000_000L);
                if (b < 20) poolWait[b] = Math.max(poolWait[b], (int) ExternalLoad.metric("hikaricp.connections.pending"));
            }, 0, 200, TimeUnit.MILLISECONDS);
            for (int i = 0; i <= 20; i++) {
                long due = t0 + i * 5_000_000_000L;
                while (System.nanoTime() < due) Thread.sleep(20);
                questions[i] = ExternalLoad.questions(root);
                failures[i] = ExternalLoad.metric("shop.redis.failures");
                trips[i] = ExternalLoad.metric("shop.redis.trips");
                if (i < 20) outbox[i] = ExternalLoad.one(root, "SELECT COUNT(*) FROM outbox_events WHERE published_at IS NULL");
                if (i == 4) docker(mode, target);
                if (i == 16) docker(mode.equals("stop") ? "start" : "unpause", target);
            }
            ticker.cancel(false);
            sampler.cancel(false);
            senders.shutdown();
            senders.awaitTermination(30, TimeUnit.SECONDS);
            clock.shutdown();

            System.out.printf("═══ 8.6 降級演練（客戶端在另一個行程）：%s 的流量，docker %s %s（第 20～80 秒）═══%n", mix.toUpperCase(), mode, target);
            System.out.println("  秒      依賴 │ MySQL 句/秒 │ 詳情 p99    狀態                  │ 熱點下單 p99  狀態              │ 一般下單 p99  狀態          │ 排行 狀態         │ outbox 未送出 │ 等連線（最多）│ Redis 失敗／跳開");
            Map<String, Map<Integer, Integer>> during = new TreeMap<>(), after = new TreeMap<>();
            for (int i = 0; i < 20; i++) {
                Map<String, List<Sample>> by = new TreeMap<>();
                for (Sample s : buckets[i]) by.computeIfAbsent(s.api(), k -> new ArrayList<>()).add(s);
                for (Sample s : buckets[i]) (i >= 4 && i < 16 ? during : i >= 16 ? after : new TreeMap<String, Map<Integer, Integer>>())
                        .computeIfAbsent(s.api(), k -> new TreeMap<>()).merge(s.status(), 1, Integer::sum);
                System.out.printf("  %3d-%-3d %-4s │ %8.0f   │ %7.1f  %-21s │ %7.1f  %-18s │ %7.1f  %-14s │ %-16s │ %8d      │ %6d       │ %.0f／%.0f%n",
                        i * 5, i * 5 + 5, i >= 4 && i < 16 ? "停了" : "正常", (questions[i + 1] - questions[i]) / 5.0,
                        p99(by.get("詳情")), statuses(by.get("詳情")), p99(by.get("熱點下單")), statuses(by.get("熱點下單")),
                        p99(by.get("一般下單")), statuses(by.get("一般下單")), statuses(by.get("排行")), outbox[i], poolWait[i],
                        failures[i + 1] - failures[i], trips[i + 1] - trips[i]);
            }
            System.out.println("  停機期間（20～80 秒）：" + during);
            System.out.println("  恢復之後（80～100 秒）：" + after);
        } finally {
            docker("unpause", target);
            docker("start", target);
        }
        Thread.sleep(8000);                                                   // 讓 relay、消費者把這一次的事件處理完，再清
        try (Connection c = DriverManager.getConnection(ExternalLoad.SHOP_JDBC, "shop", "shop")) { cleanup(c); }
        System.exit(0);
    }

    static double p99(List<Sample> s) {
        if (s == null || s.isEmpty()) return 0;
        long[] l = s.stream().mapToLong(Sample::nanos).sorted().toArray();
        return l[(int) (l.length * 0.99)] / 1e6;
    }

    static String statuses(List<Sample> s) {
        if (s == null) return "—";
        Map<Integer, Integer> m = new TreeMap<>();
        for (Sample x : s) m.merge(x.status(), 1, Integer::sum);
        return m.toString();
    }

    static void cleanup(Connection c) throws Exception {
        long lo = BUYER, hi = BUYER + 100_000;
        ExternalLoad.exec(c, "DELETE n FROM notifications n JOIN orders o ON o.id = n.payload->>'$.aggregateId' WHERE o.buyer_id >= ? AND o.buyer_id < ?", lo, hi);
        ExternalLoad.exec(c, "DELETE FROM notifications WHERE user_id >= ? AND user_id < ?", lo, hi);
        for (String t : List.of("order_status_history", "order_items"))
            ExternalLoad.exec(c, "DELETE x FROM " + t + " x JOIN orders o ON o.id = x.order_id WHERE o.buyer_id >= ? AND o.buyer_id < ?", lo, hi);
        ExternalLoad.exec(c, "DELETE FROM idempotency_keys WHERE buyer_id >= ? AND buyer_id < ?", lo, hi);
        ExternalLoad.exec(c, "DELETE FROM orders WHERE buyer_id >= ? AND buyer_id < ?", lo, hi);
        for (long id : new long[]{HOT, NORMAL}) {
            ExternalLoad.exec(c, "DELETE FROM inventory_reservations WHERE product_id = ?", id);
            ExternalLoad.exec(c, "DELETE FROM inventory_ledger WHERE product_id = ?", id);
            ExternalLoad.exec(c, "DELETE FROM inventory WHERE product_id = ?", id);
            ExternalLoad.exec(c, "DELETE FROM products WHERE id = ?", id);
        }
        try (RedisClient rc = RedisClient.create("redis://localhost:6379"); var redis = rc.connect()) {
            for (long id : new long[]{HOT, NORMAL}) redis.sync().del("product:v1:" + id, "stock:" + id, "available:" + id);
            redis.sync().del("trending:24h:top10");
        } catch (Exception ignored) {}                                        // Redis 可能剛恢復、還沒好：留下的只是快取
    }

    static void docker(String... args) throws Exception {
        List<String> cmd = new ArrayList<>(List.of("docker"));
        cmd.addAll(List.of(args));
        Process p = new ProcessBuilder(cmd).redirectErrorStream(true).start();
        p.getInputStream().readAllBytes();
        p.waitFor();
    }
}
```

**`scripts/loadtest.sh`**

```bash
#!/usr/bin/env bash
# 8.6 獨立行程的壓測：應用程式（正式的 jar）是一個行程，壓測工具（ExternalLoad）是另一個行程。
#   scripts/loadtest.sh flash hot=true rps=200 rounds=3
#   APP_ARGS="--spring.threads.virtual.enabled=true" scripts/loadtest.sh flash hot=false rps=0
#   scripts/loadtest.sh detail
#   scripts/loadtest.sh orders rps=100 seconds=10
# 連的是 docker compose 的那一組（10 萬張訂單的種子資料），跟第 04～07 章的 E7、G10、H5 同一個資料庫。
set -euo pipefail
cd "$(dirname "$0")/.."
mode=$1; shift
jar=target/shop-0.0.1-SNAPSHOT.jar
[ -f "$jar" ] || mvn -q -DskipTests package
[ -f target/test-classpath.txt ] || mvn -q dependency:build-classpath -Dmdep.outputFile=target/test-classpath.txt -Dmdep.includeScope=test
# 跟 E7 的 in-JVM 版本同樣的設定：付款逾時的排程關掉、relay 與消費者打開；限流放寬（所有請求都從 127.0.0.1 來，同 src/test/resources/config/application.yml）
# JMX 只為了讓壓測工具讀連線池（Hikari 的 MBean）與 Redis 的計數器（Boot 的 Metrics endpoint）——
# HTTP 的 /actuator/metrics 被 SecurityConfig 擋掉，而且它本來就不該對外
java -Dcom.sun.management.jmxremote.port=9010 -Dcom.sun.management.jmxremote.authenticate=false -Dcom.sun.management.jmxremote.ssl=false \
  -Djava.rmi.server.hostname=127.0.0.1 \
  -jar "$jar" --server.port=18080 --shop.order.jobs-enabled=false \
  --shop.messaging.relay-enabled=${RELAY:-true} --shop.messaging.consumers-enabled=${CONSUMERS:-true} --shop.inventory.jobs-enabled=${INVENTORY_JOBS:-true} \
  --shop.rate-limit.requests-per-ip-per-second=1000000 \
  --spring.jmx.enabled=true --spring.datasource.hikari.register-mbeans=true --management.endpoints.jmx.exposure.include=metrics \
  --spring.main.banner-mode=off --logging.level.root=WARN ${APP_ARGS:-} > target/loadtest-app.log 2>&1 &
app=$!
trap 'kill $app 2>/dev/null || true; wait $app 2>/dev/null || true' EXIT
for i in $(seq 1 120); do curl -sf localhost:18080/api/ping >/dev/null && break; sleep 0.5; done
# 起不來就停（8.6.4：第一版把 relay-enabled 在 APP_ARGS 裡又給了一次，Spring 把兩個值合成 "true,false"，應用程式沒起來，
# 壓測工具照樣開始送 —— 然後卡在一個連不上的埠上）
if ! curl -sf localhost:18080/api/ping >/dev/null; then echo "  ⚠️ 應用程式沒有起來："; grep -m3 -E 'APPLICATION FAILED|Reason|Description' -A2 target/loadtest-app.log; exit 1; fi
echo "  （應用程式 pid ${app}，java -jar；壓測工具是另一個 JVM）"
java -cp "target/test-classes:target/classes:$(cat target/test-classpath.txt)" com.example.shop.loadtest.ExternalLoad "$mode" "$@"
java -cp "target/test-classes:target/classes:$(cat target/test-classpath.txt)" com.example.shop.loadtest.ExternalLoad peak
```

**`scripts/i5-flash-interleave.sh`**

```bash
#!/usr/bin/env bash
# 8.6.2 熱點搶購：第 07 章的 H5（客戶端在同一個 JVM）與獨立行程的版本交錯，各 3 次（每次暖機一輪、量兩輪）
cd "$(dirname "$0")/.."
for i in 1 2 3; do
  echo "### 同一個 JVM（H5HotFlashSaleTest）第 $i 次 load $(sysctl -n vm.loadavg)"
  mvn -q test -Pexperiments -Dtest=H5HotFlashSaleTest 2>&1 | grep -E '^  (ch07|這個 JVM)|└'
  echo "### 獨立行程（scripts/loadtest.sh flash）第 $i 次 load $(sysctl -n vm.loadavg)"
  scripts/loadtest.sh flash hot=true rps=200 rounds=3 label=external 2>&1 | grep -E '^  (external|壓測工具|應用程式)|└'
done
echo "### done load $(sysctl -n vm.loadavg)"
```

**`scripts/i5b-flash-busy.sh`**

```bash
#!/usr/bin/env bash
# 8.6.2 同一組交錯，但機器很忙：6 個 yes > /dev/null 佔住 6 個核心（7.2.2 用過同樣的方法），等 20 秒讓 load average 爬上去
cd "$(dirname "$0")/.."
hogs=(); for i in 1 2 3 4 5 6; do yes > /dev/null & hogs+=($!); done
trap 'kill ${hogs[*]} 2>/dev/null' EXIT
sleep 20
for i in 1 2; do
  echo "### 忙：同一個 JVM（H5HotFlashSaleTest）第 $i 次 load $(sysctl -n vm.loadavg)"
  mvn -q test -Pexperiments -Dtest=H5HotFlashSaleTest 2>&1 | grep -E '^  (ch07|這個 JVM)|└'
  echo "### 忙：獨立行程（scripts/loadtest.sh flash）第 $i 次 load $(sysctl -n vm.loadavg)"
  scripts/loadtest.sh flash hot=true rps=200 rounds=3 label=external 2>&1 | grep -E '^  (external|壓測工具|應用程式)|└'
done
echo "### done load $(sysctl -n vm.loadavg)"
```

**`scripts/i6-virtual-threads.sh`**

```bash
#!/usr/bin/env bash
# 8.6.3 4.8.3 的虛擬執行緒，第二次：一般商品（hot=false）、封閉式（200 個客戶端）與開放式（每秒 200 個），平台 vs 虛擬
# 同一個 JVM（E7FlashSaleLoadTest#flashSale，第 04 章原封不動）與獨立行程交錯，各 2 次
cd "$(dirname "$0")/.."
for i in 1 2; do
  echo "### 同一個 JVM（E7FlashSaleLoadTest）第 $i 次 load $(sysctl -n vm.loadavg)"
  mvn -q test -Pexperiments -Dtest='E7FlashSaleLoadTest#flashSale' 2>&1 | grep -E '═══|平台|虛擬|└'
  for rps in 0 200; do
    for vt in false true; do
      echo "### 獨立行程 rps=$rps virtual=$vt 第 $i 次 load $(sysctl -n vm.loadavg)"
      APP_ARGS="--spring.threads.virtual.enabled=$vt" scripts/loadtest.sh flash hot=false rps=$rps rounds=3 label="$([ $vt = true ] && echo 虛擬執行緒 || echo 平台執行緒)" 2>&1 | grep -E '^  (平台|虛擬|壓測工具|應用程式)|└'
    done
  done
done
echo "### done load $(sysctl -n vm.loadavg)"
```

**`scripts/i7-detail-orders.sh`**

```bash
#!/usr/bin/env bash
# 8.6.4 0.6.2 的每一列。商品詳情（G10：同一個商品每秒 1,000 次）—— 同一個 JVM 與獨立行程交錯各 2 次；然後「我的訂單」與「賣家日報表」（只有獨立行程）
# G10 在測試的設定下跑：relay、消費者、庫存排程都關著 —— 獨立行程的那一個也關掉，只差「同一個 JVM」
cd "$(dirname "$0")/.."
for i in 1 2; do
  echo "### 同一個 JVM（G10DetailSloTest）第 $i 次 load $(sysctl -n vm.loadavg)"
  mvn -q test -Pexperiments -Dtest=G10DetailSloTest 2>&1 | grep -E '═══|商品'
  echo "### 獨立行程（scripts/loadtest.sh detail）第 $i 次 load $(sysctl -n vm.loadavg)"
  RELAY=false CONSUMERS=false INVENTORY_JOBS=false scripts/loadtest.sh detail 2>&1 | grep -E '^  (external|應用程式)'
done
for i in 1 2; do
  echo "### 我的訂單、賣家日報表 第 $i 次 load $(sysctl -n vm.loadavg)"
  scripts/loadtest.sh orders rps=100 seconds=10 2>&1 | grep -E '^  external'
  scripts/loadtest.sh report rps=5 seconds=30 2>&1 | grep -E '^  external'
  scripts/loadtest.sh search 2>&1 | grep -E '^  external'
  scripts/loadtest.sh place 2>&1 | grep -E '^  external'
  scripts/loadtest.sh callback 2>&1 | grep -E '^  (external|  ⚠️)'
done
echo "### done load $(sysctl -n vm.loadavg)"
```

**`scripts/i9-drills.sh`**

```bash
#!/usr/bin/env bash
# 8.6.5 降級演練，客戶端在另一個行程：G8（Redis，6.9.2）與 H6（RabbitMQ，7.9），stop 與 pause；
# 然後 H6 再跑一次，機器很忙（6 個 yes）—— 7.9.5 那一次熱點 503 是在 load 17.5 的時候
cd "$(dirname "$0")/.."
for mode in stop pause; do
  echo "### G8 $mode load $(sysctl -n vm.loadavg)"
  RELAY=false CONSUMERS=false INVENTORY_JOBS=false scripts/loadtest.sh drill mix=g8 target=shop-redis-1 mode=$mode 2>&1 | grep -vE '^\s*$|（應用程式 pid'
done
for mode in stop pause; do
  echo "### H6 $mode load $(sysctl -n vm.loadavg)"
  INVENTORY_JOBS=false scripts/loadtest.sh drill mix=h6 target=shop-rabbitmq-1 mode=$mode 2>&1 | grep -vE '^\s*$|（應用程式 pid'
done
hogs=(); for i in 1 2 3 4 5 6; do yes > /dev/null & hogs+=($!); done
trap 'kill ${hogs[*]} 2>/dev/null' EXIT
sleep 20
for mode in stop pause; do
  echo "### 忙：H6 $mode load $(sysctl -n vm.loadavg)"
  INVENTORY_JOBS=false scripts/loadtest.sh drill mix=h6 target=shop-rabbitmq-1 mode=$mode 2>&1 | grep -vE '^\s*$|（應用程式 pid'
done
echo "### done load $(sysctl -n vm.loadavg)"
```

---

## 8.11 常見誤區

**① 「測試在我的機器上是綠的，所以它們是對的」**

8.2.1：178 個綠燈裡，Q6 連的是寫死的 `localhost:3306`、Q8 用的是種子資料的帳號與 compose 的容器名稱、Q9 的子行程照著 `application-local.yml` 連 compose、對帳測試靠 10 萬張種子訂單才有東西可以對。**它們都在「我的筆電」上被寫出來、被驗證過。** 換一台空的資料庫，紅了 2 個；把 compose 停掉，紅了 3 個；還有 1 個永遠綠、什麼都沒檢查。

**② 「換了環境之後全綠，就沒事了」**

`InvariantReconciliationTest` 從 3.9 秒變成 0.008 秒，照樣是綠的（8.2.1）。**換環境之後要看每一個測試的時間變了多少**；快了兩個數量級的那一個，多半是不再做事了。一個對帳測試的第一件事，是證明它不是在對一張空表（8.4.3）。

**③ 「Spring Boot 管理的版本，一定能用」**

Boot 3.2.5 的 Testcontainers 1.19.7 跟 Docker Engine 29 講不上話，錯誤訊息是「找不到 Docker」（8.4.1）。管理版本保證的是函式庫彼此相容，不是跟你機器上的其他東西相容。

**④ 「容器的埠反正是隨機的，測試不用管」**

隨機的對外埠在每一次 `docker start` 都會換（8.4.4 的 I3）；要演練「停掉再起來」，埠要固定。而**綁在哪個位址**也會改變故障的樣子：綁 127.0.0.1，`docker stop` 之後已經連著的那條連線收不到 reset —— 你以為在演練 stop，其實是 pause。

**⑤ 「一次失敗不跳開，只會讓那一次比較慢」**

6.4.5 把 `RedisGuard` 改成「1 秒內 3 次才跳開」時是這麼想的。但有三個呼叫端用「呼叫之後 guard 還 available 嗎」來分辨「失敗」與「沒有資料」；其中 `TrendingService` 因此在 Redis 失敗時改去查 MySQL、回了一份沒有 `X-Degraded` 的資料（8.4.5）。**改一個共用元件的行為，要找的是「誰依賴它現在的行為」，不只是「誰呼叫它」。**

**⑥ 「驗收測試很慢，因為每一題都要起一個應用程式」**

起一個應用程式不到 1 秒；關掉它 12 秒 —— Tomcat 叫醒 Acceptor 時挑了一個 VPN 介面的位址（8.2.2）。**先量時間花在哪裡。** 一行 `server.address: 127.0.0.1`，整套少了 99 秒。

**⑦ 「Testcontainers 讓每一個測試都是乾淨的」**

它讓**每一次建置**是乾淨的。一個 JVM 一組容器，同一次建置裡的測試照樣共用同一台 MySQL、同一台 RabbitMQ：把消費者全部打開，8 個紅（8.5 的 I4）；7.12.1 的 8 條規矩，只有 1 條可以拿掉。

**⑧ 「覆蓋率 94%，這個模組測得很好」**

`ordering` 94.1% 的時候，六個訂單動作與金流回呼的 HTTP 入口一個都沒有成功地跑過；`reporting` 根本沒有門檻，它的日報表 0%；正式的對帳排程一行都沒被執行過（8.7.2）。**覆蓋率報表的價值在「沒跑到的那幾行是誰」，不在百分比。**

**⑨ 「為了過門檻，補幾個測試就好」**

`inventory` 從 83.1% 到 93.7%：分母少了 10 行（刪掉一個沒有人用的 API），分子多了 22 行（兩個從來沒被測過的功能）。如果只是「補幾個測試」，`restockBatch` 會多一個測試、繼續留在公開的 API 上（8.7.3）。

**⑩ 「被執行過的程式碼，就是被測過的程式碼」**

退款的冪等鍵那一行覆蓋率 100%；把它換成每次一個新的 UUID，186 個測試全綠（8.7.5 的 M3）。它只有一個實驗（H3）在證明。**覆蓋率問「有沒有跑」，突變問「錯了有沒有人發現」。**

**⑪ 「`await()` 不設上限也沒關係，反正條件一定會成立」**

條件成立的前提是程式是對的。M6 讓 `ProductCacheTest` 的一個 `CountDownLatch.await()` 等了 19 分鐘（8.7.5）。**測試裡每一個等待都要有上限** —— 等不到要變成一個紅燈，而不是一個卡住的建置。

**⑫ 「測試失敗了，它開的行程自然會結束」**

Q9 在 `kill -9` 之前失敗，那個子行程活了一個半小時，連著 compose 的資料庫、每小時跑一次 relay（8.4.3）。**測試開的行程，要在 `finally` 裡收。**

**⑬ 「壓測的客戶端搬到另一個行程，數字就乾淨了」**

它拿掉的是「同一個 JVM」；拿不掉「同一台機器」。機器閒的時候兩種量法都 < 500 ms，機器被佔滿的時候兩種一樣是 3.9～5.6 秒（8.6.2）。之前那些秒級的數字，主因是機器很忙。而它多看到一件同一個 JVM 看不到的事：新啟動的實例，第一個 10 秒的 p99 是 1～2.7 秒。

**⑭ 「指標讀不到的時候回 0 就好」**

壓測工具如果隔著 HTTP 讀 `/actuator/metrics`，會被 Spring Security 擋掉，讀到的全部是 0（8.6.1）—— 一個「連線池從來沒有人等過」的漂亮表格。**讀不到要大聲說**，0 是一個很有說服力的假數字。

---

## 8.12 本章小結

**這一章建立了五件事**：

1. **每一次建置自己的 MySQL、Redis、RabbitMQ**（8.4）：一個 JVM 一組、第一個 Spring Boot 應用程式啟動時才起、子行程用同一組；實驗照舊連 compose。換過去的途中，找出了四個「綠得不對」的測試（8.2.1）、一個 Testcontainers 跟 Docker 29 講不上話的版本（8.4.1）、兩個埠的陷阱（8.4.4），以及一個從第 06 章就在的 bug（8.4.5）。
2. **一個 3 分 45 秒的 `mvn verify`**（8.2.2、8.10）：起一個應用程式不到 1 秒，關掉它 12 秒 —— 一行 `server.address`，少了 99 秒。
3. **覆蓋率門檻，以及讀「沒跑到的那幾行」**（8.7）：一個沒有人用的 API（刪掉）、一個從沒被執行的對帳排程（而且它的 SQL 已經跟測試的那一份不一樣）、六個沒有成功地走過 HTTP 的訂單動作、一張只有實驗在量的報表。七個手工突變裡，一個存活、一個讓建置卡住 19 分鐘、一個只有覆蓋率逼出來的那個測試抓得到。
4. **一個只換一個變數的獨立行程壓測工具**（8.6）：0.6.2 的七列第一次全部在負載下量過，五列達成。之前那些秒級的熱點 p99，主因是這台機器很忙，不是客戶端在同一個 JVM；虛擬執行緒的好處也不是量測的偏差。7.9.5 那 204 個熱點 503 的推測，第一次有了證據。
5. **一份 CI 的流程，以及三次在一台什麼都沒有的機器上的建置**（8.8）：第一次缺 `docker` 這個程式，第二次抓到我自己剛寫的測試漏到下一個測試，第三次全綠，4 分 21 秒。

**以及這一章自己抓到的**：指標讀不到時回 0 的壓測工具（8.6.1）、一個應用程式根本沒起來、壓測工具卻照樣開始送的腳本（8.6.4）、一個在 `kill -9` 之前就失敗、活了一個半小時的子行程（8.4.3）、一個沒有上限的 `await()`（8.7.5）、一個在 CI 上才看得到的時序（8.8.2）。它們全部是**測試與量測工具自己的 bug** —— 這一章的主角。

**如果這一章只能記一句話**：

> **一個綠燈只說明「在這台機器上、這個時候，它沒有紅」。要知道它在測什麼，換一台空的機器、讀它沒跑到的那幾行、故意弄壞它一次。**

### 8.12.1 驗收清單

做得到才往下走：

- [ ] 把 compose 整組停掉（`docker stop shop-mysql-1 shop-redis-1 shop-rabbitmq-1`），`mvn clean test` 仍然全綠；再 `docker start` 回來。
- [ ] 說出 8.2.1 那四個測試各自靠著什麼，以及為什麼 `InvariantReconciliationTest` 的 0.008 秒比紅燈更值得注意。
- [ ] 說出 `TestInfra` 為什麼同時是 `LauncherSessionListener` 與 `EnvironmentPostProcessor`；單獨跑 `OrderStateMachineTest`，確認沒有任何容器被起（沒有 `TEST_INFRA` 那一行）。
- [ ] 跑 `I3LettuceStopTest`，說出 127.0.0.1 與 0.0.0.0 兩種綁定在 `docker stop` 之後的差別，以及它對 Q8 的影響。（8.4.4 量的是 Docker Desktop 的轉送層；Linux 原生的 Docker 上不一定是同一個樣子。）
- [ ] 跑 `I1ContextCloseTest#loopbackOnly`。本章結束時測試設定已經綁 127.0.0.1（8.2.2 的 ⚠️），「預設」那一組要先改成自己帶 `--server.address=::`（8.2.2），才是在比兩種綁定。你的機器上，關閉要多久？如果不是 12 秒，列出這台機器的網路介面（`NetworkInterface.getNetworkInterfaces()`），照 8.2.2 的規則找 Tomcat 會挑到哪一個位址。
- [ ] 把 `TrendingService.top10()` 改回第一版，跑 `TrendingDegradedTest`，看它紅；說出這個 bug 為什麼第 06 章的 Q8、G8 都抓不到。
- [ ] `mvn clean verify`，打開 `target/site/jacoco/index.html`，在 `inventory` 裡找一行沒跑到的，說出它屬於 8.7.2 的哪一種。
- [ ] 選一個 I8 的突變（例如 M3），自己改一次、跑一次，再改回來。
- [ ] `scripts/loadtest.sh orders rps=100 seconds=10`（先確認 8.6.1「跑之前要有的東西」），看 0.6.2 的「我的訂單」在你的機器上是多少。
- [ ] 說出 8.6.2 的獨立行程拿掉了什麼、拿不掉什麼，以及「暖機那一輪」為什麼只有它量得到。
- [ ] 用 8.8.2 的 `git archive | docker run …` 在一個乾淨的容器裡跑一次 `mvn -B -ntp verify`。
- [ ] `mvn clean verify` 顯示 `Tests run: 188, Failures: 0, Errors: 0, Skipped: 1` 與四行 `All coverage checks have been met.`

### 8.12.2 本章練習

**練習一（30 分鐘）：一個測試類別一組容器，要多少錢**

8.4.2 ① 估「一個類別一組就是 5 分鐘以上」，沒有量。把 `TestInfra` 改成每一個測試類別各起一組（例如一個 JUnit extension，`beforeAll` 起、`afterAll` 關），量 `mvn clean test` 的時間；然後把 8.5 的規矩 ①、④、⑤ 拿掉，看它們是不是真的不需要了。再試 Testcontainers 的 `reuse`：它省了什麼、又放棄了什麼（提示：8.2.1）？

**練習二（20 分鐘）：另外兩個「失敗 vs 沒有」**

8.4.5 只修了 `TrendingService`。`ProductCache.get()` 與 `JdbcInventoryService.available()` 也用「GET 之後 guard 還 available 嗎」分辨失敗與沒有快取。用 `TrendingDegradedTest` 的寫法（一個會逾時的 `StringRedisTemplate`）各寫一個測試：失敗的那一次，它們做了什麼？多付了幾次 500 ms？要不要改？

**練習三（進階，半天）：PIT**

用 PIT（`pitest-maven`）對 `ordering.internal.OrderStateMachine` 與 `inventory.internal` 跑一次突變測試。8.7.5 手工的七個要 25 分鐘；PIT 會產生幾百個 —— 你要怎麼讓它只跑相關的測試？存活下來的突變裡，有沒有像 M3 那樣「這一行覆蓋率 100%、意義沒人測」的？

**練習四（40 分鐘）：新實例的前 10 秒**

8.6.2 量到新啟動的應用程式第一輪的熱點 p99 是 1.0～2.7 秒。寫一個在 readiness 變成 UP 之前，先自己打一輪暖機請求的元件（提示：`ApplicationRunner` 在 `ApplicationReadyEvent` 之前跑，readiness 的 `AvailabilityChangeEvent`（`ACCEPTING_TRAFFIC`）在那之後才發），用 `scripts/loadtest.sh flash rounds=1` 量暖機輪變成多少。注意：`loadtest.sh` 等的是 `/api/ping`，而 Tomcat 在 runner 執行時已經在接連線 —— 不先把腳本的等待改成 `/actuator/health/readiness` 回 200，壓測會在你的暖機還沒做完時就開始，量不出差別。它要打哪些 API？打了會不會寫出不該寫的資料？

**練習五（進階，60 分鐘）：為什麼是 13 條連線**

8.6.3：虛擬執行緒在兩種量法下都只用到 12～13 條連線。在獨立行程的應用程式上加 `-Djdk.tracePinnedThreads=short`（或用 JFR 錄 `jdk.VirtualThreadPinned`），看是誰在限制併發。如果是 pinning，Connector/J 的哪一個版本改善了它？

**練習六（30 分鐘）：真的在 GitHub 上跑一次**

把 shop 推到你自己的一個 repo，讓 `.github/workflows/ci.yml` 真的跑一次。它跟 8.8.2 的乾淨容器差多少時間？`cache: maven` 第二次省了多少？`HealthProbeTest` 在 `ubuntu-latest` 上的那個「MySQL 卡住」要多久？

**練習七（30 分鐘）：完整的 health 為什麼 10 秒不回答**

8.9.1：MySQL 卡住時，readiness 5 秒回 503，完整的 `/actuator/health` 10 秒都沒有回答。它包含 `db`、`redis`、`rabbit`、`diskSpace`、`ping`…… 是哪一個在等？用 `management.endpoint.health.group` 或 `HealthContributorRegistry` 一個一個關掉找出來，並決定要不要給它一個逾時。

**練習八（40 分鐘）：G8 的 85～90 秒**

6.9.2 那 48 個客戶端逾時，8.6.5 在 load 4～6、獨立行程的條件下沒有再出現 —— 兩個變數一起換了。把 G8（同一個 JVM）在 load 7～11（用 3～4 個 `yes`）下再跑兩次，把兩個變數拆開。

---

## 8.13 下一章預告

這一章讓「它們都還是對的」不再需要一台很吵的筆電來證明：測試要的只有 Docker，CI 的流程寫好了，0.6.2 的每一列都在負載下量過一次。

但它也把幾件事推得更清楚，而它們都不是測試能回答的：

- **熱點下單的 p99**：機器有餘裕時 12 輪全部 < 500 ms；機器被佔滿、或是新實例的前 10 秒，是秒級（8.6.2）。「正式環境的那一台會不會被佔滿」，要在正式環境的規格上量。
- **7.9.5 的熱點 503**：這一次知道了是 Redis 逾時讓 `RedisGuard` 跳開（8.6.5），但不知道是哪一個呼叫、為什麼在那一刻 —— 因為那一次的日誌被覆蓋了。要知道「哪一個呼叫」，要的是結構化的日誌與帶著 traceId 的指標，而不是一份 `target/loadtest-app.log`。
- **這一章裡被當成告警寫下來、卻沒有人接的數字**：`shop.redis.trips`、`shop.reconciliation.diff`（8.7.3 證明了它會變成 1）、`shop.outbox.oldest_age_seconds`、`shop.inventory.hot.shortage`、HTTP 的 503 率。

下一章（09）是**部署與可觀測性**：

- **Dockerfile 與完整的 compose**：應用程式也在容器裡，它要哪些埠、哪些環境變數，寫在 compose 裡，而不是寫在「新人上手」那一句的前提裡（8.8.3）。
- **結構化日誌與 traceId**：驗收 Q7（HTTP → DB → MQ 消費端），第 07 章的練習九。
- **指標與告警**：上面那幾個數字，0.6.6 的告警線。
- **INV-5 與稽核表的權限**：應用程式的資料庫帳號沒有 `inventory_ledger`、`audit_logs` 的 `UPDATE`、`DELETE`。第 05 章說過，到那時候測試的清理「要換一個帳號，或者整個換成第 08 章的用完即丟的資料庫」—— 兩樣這一章都有了（8.4 的容器與 `adminDataSource()`）。
- **對帳改成增量的**、**上線檢查清單**。

這一章讓綠燈值得相信；下一章讓紅燈 —— 在正式環境裡的那一種 —— 被看見。
