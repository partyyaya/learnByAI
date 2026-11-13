# Service 課程關鍵範例驗證

本目錄從相鄰 Markdown 抽取本次修正的類別、方法與 SQL，使用 Java 21、
Spring Boot 3.2.5／Spring 6.1.6、Spring Data Redis 3.2.5、Jackson 2.17.2、
ArchUnit 1.3.0、ClassGraph 4.8.172 編譯並驗證修正後的行為。
不是把全章的省略片段拼成完整 shop-service。

```sh
cd java/05-service/verification
python3 prepare.py
mvn test
```

有 Docker 時可使用下列方式，Maven 快取使用專用 volume：

```sh
python3 prepare.py
docker run --rm -v "$PWD":/work -v service-course-m2:/root/.m2 -w /work maven:3.9-eclipse-temurin-21 mvn -B test
python3 mysql-smoke.py
```

`prepare.py` 只重建 `target/course-tests`，並產生來源雜湊及 SQL 清單；不修改教材。
若執行 `mvn clean`，要重新 prepare 再測試，不能在 prepare 後直接 clean。
`mysql-smoke.py` 會啟動一次性的 `mysql:8.0` 容器，無對外連接埠、無外部網路，
資料放在 tmpfs，測試結束後自動移除該容器；不會操作其他既有容器。

2026-11-09 實際以 Docker 執行：**34 個 JUnit 測試、0 failure、0 error、0 skipped**。
另以真實 MySQL 8 通過 DDL 與狀態 SQL smoke check。
`AFTER_COMMIT` listener 故意拋例外的測試會出現預期的 ERROR 日誌，
其斷言是原呼叫端正常返回、資料已提交，且後續 listener 仍執行。

| 審閱項目 | 調整內容 | 驗證方式 |
|---|---|---|
| R01 Async order | 保留預設 BPP order，區分處理順序與 advisor 順序 | 抽取三個 Enable 設定；worker 有交易且失敗後資料為 0 筆 |
| R02 sent marker | 移除會提前清理且不能證明已送達的 ThreadLocal 判斷 | 抽取 charge catch；I/O 失敗回 UNKNOWN，沒有自動再扣一次 |
| R03 502／503 | 通用 5xx／429 預設 UNKNOWN；重試白名單限已確認未執行 | HTTP handler 測 429、500、502、503、504；同步調整練習答案與 YAML |
| R04 庫存保留 | 檢查 tryReserve 的 false，失敗拋例外 | 抽取庫存迴圈；失敗後不執行持久化接續步驟 |
| R05 outbox 自呼叫 | delivery 與短交易 state Bean 分開 | 實際 Spring proxy＋H2：投遞沒有交易，state 在獨立交易提交 |
| R06 claim／lease | lease_until、claim_token、更新筆數及 next_attempt_at 重驗 | 抽取 SQL，H2＋MySQL 驗到期時間、過期 owner、重試資格與崩潰次數上限 |
| R07 同聚合順序 | DEAD 阻擋後續；即時路徑也走同一 claim | H2／MySQL 驗候選篩選，H2 驗即時呼叫不可越過 DEAD |
| R08 分攤負數 | 最小貨幣單位＋最大餘數，同餘數依原索引 | 原教材分攤測試、小額分攤、零權重、三種幣別與非法輸入 |
| R09 重複商品列 | 本次出貨累計；完成度按商品總訂購量比對 | 超額拒絕且不改狀態；訂購 2＋3，出貨 3 為部分、再出 2 才完成 |
| R10 過期取消 | 新交易內重驗 isExpired，Domain 也限制逾時原因 | 已付款／未到期不取消、不釋放庫存；真正過期者正常取消 |
| R11 冪等內容 | 持久保存完整 intent，命中時先比對 | 同內容可重播，改商品／數量／地址／券／備註／發票均拒絕 |
| R12 CallerRuns context | finally 還原執行執行緒原值 | 真實池滿時保留 caller MDC／Locale／Security；worker 拋錯仍還原 context |
| R13 交易事件例外 | 區分註解式 AFTER_COMMIT 與手動 synchronization | 實際 commit、同步例外傳播及後續 listener 對照 |
| R14 ArchUnit 反轉 | 改用 methods().should(會送 violated 的條件) | 抽取兩條規則，違規 fixture 必須失敗，合法 BEFORE_COMMIT／唯讀快取通過 |
| R15 分頁 API | 01 與 03 均改用目前 PageInfo 六參數契約 | 以 04-controller 的真實 PageResponse 編譯，驗 JSON metadata 與可存取上限 |
| R16 測試 builder | place／markPaid／ship／markDelivered／cancel | 實際聚合各狀態與付款、出貨事實；transitionTo 維持 private |
| R17 負退款 | Refund 要求正金額 | 負數、零拒絕；累計上限及超額退款拒絕 |
| R18 取消角色 | cancel 明確拒絕非本人且非特權角色 | 匿名 actor guard=false，實際取消也失敗且不改狀態 |
| R19 null cache | NullValue serializer 與精確 marker 型別白名單 | 真實 RedisCache＋記憶體 writer 的 null round trip；未放行任意 java.io 型別 |
| R20 Redis 鎖粒度 | 明確寫成 3.2.5 的 cache-wide JVM 鎖 | 真實 RedisCache#get，不同 key 的 loader 仍序列化 |
| R21 ClassGraph | class info 已包含間接子類別 | Base→Middle→Leaf；比較 classInfo 與 allInfo 的集合 |
| R22 fake 共享參考 | save 與 find 均經 codec.copy | 修改原物件或查回物件，未 save 都不影響儲存狀態 |
| R23 fixedRate | 更正同一週期任務不重疊的說明 | Java 21 多 worker、任務長於週期，最大並行仍為 1 |

驗證邊界：

- 抽出的核心實作包含 Money、Order、Payment、Refund、builder、intent、cache mapper、
  context decorator、HTTP handler、outbox state／delivery／poller；不覆蓋全站所有 code fence。
- `fixtures/` 與 prepare 產生的例外 stub 補齊未組裝的依賴，
  不驗證完整 ErrorCode／錯誤回應、授權入口、優惠券策略或金流供應商契約。
- 分頁測試只替換與本次無關的 View mapping；過期取消測試抽取 Service 方法並補 collaborators。
  庫存測試驗分支中止，不宣稱已測真實庫存 SQL 的 rollback。
- fake 使用只支援無折扣待付款訂單的 fixture codec。驗證 copy 邊界與隔離行為，
  不宣稱 01 章完整 snapshot／restore 已實作或已驗證所有歷史資料。
- Outbox JDBC adapter 依文字協定組裝，SQL 取自教材；Spring 邊界測試使用 H2。
  MySQL smoke check 確認 SQL 相容與狀態條件，**未做多程序 stream 鎖競爭／死鎖壓測**。
- 未啟動真實 Redis／MQ，沒有呼叫真實支付商、郵件或 ERP，也未做 K8s 關機與壓測。
  已明確保留 claim 租約失效後可能重複及晚到的限制；端到端順序仍需消費端版本檢查。
