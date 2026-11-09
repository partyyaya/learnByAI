# Controller 關鍵範例驗證

直接抽取相鄰 Markdown 中的關鍵類別／方法，使用 Java 21、Spring Boot 3.2.5
（Spring 6.1.6 / Security 6.2.4）、Jackson 2.17.2 執行編譯與回歸驗證。

```bash
cd java/04-controller/verification
python3 prepare.py
mvn verify
node reconnect-test.cjs
```

也可用 Docker，主機只需要 Python 3：

```bash
python3 prepare.py
docker run --rm -v "$PWD":/work -v controller-course-m2:/root/.m2 -w /work maven:3.9-eclipse-temurin-21 mvn -B verify
docker run --rm -v "$PWD":/work:ro -w /work node:24-alpine node reconnect-test.cjs
```

`prepare.py` 僅重建 `target/course-tests`、抽出的 JS 與方法檔；不修改教材。
若要清理，先 `mvn clean`，再重新 prepare 與 verify；不要在 prepare 後直接執行 clean。

## 本次執行結果

2026-11-05，以 Docker Java 21 / Boot 3.2.5 執行：
Surefire 33 個、Failsafe 9 個（含 4 個真實 WebSocket 測試），共 **42 個測試通過**；
Node 的 **7 個重連行為檢查通過**。Markdown 圍欄與差異空白檢查亦通過。

## 驗證邊界

- Surefire 執行 `unit`；Failsafe 明確匹配 `*Test` 後執行 `security`，兩階段都拒絕零測試。
- 冪等、body 上限、CORS、SSE 索引、查詢綁定、分頁 JSON、ETag、WebP、錯誤回應使用抽出的實作。
- WebSocket 測試啟動真正的 Tomcat，走握手、CONNECT、SUBSCRIBE／SEND 與 close frame。
- `fixtures/` 僅補上後續課程的領域／外部服務介面、可控 JWT verifier、時鐘身分工具與無輸出的 logger。
  **沒有驗證真實 JWT 簽章、正式 HTTP SecurityFilterChain、JDBC／物件儲存或代理部署。**
- 返回值驗證只抽出 advice 的相關 override，以固定翻譯／記錄替身隔離驗證；不是整個 advice 的整合測試。
- 沒有將全站所有 code fence 組裝成完整 shop-service；也未宣告 Boot 3.4 的相容性。

## 本次修正與檢查對照

| 審閱項目 | 修正 | 檢查 |
|---|---|---|
| 01 訂閱授權未註冊 | inbound channel 明確接上授權 | 真實 socket 拒絕外人對話、允許合法訂閱 |
| 02 broker SEND 繞過 | SEND 只允許受控 /app 路徑，仍驗成員 | 單元與真實 socket 拒絕 topic SEND |
| 03 共用測試介面不相容 | 測試 Store 實作 owner API；稽核依既有 URI | 編譯、owner／scope／audit 行為 |
| 04 Failsafe 漏跑 | includes 與 tags 分開設定，拒絕零測試 | verify 實際執行 security 的 *Test |
| 05 body 截斷漏判 | 多讀至多一 byte 判斷超限，Filter 回 413 | 邊界與不同 chunk 長度 |
| 06 Security 包裝丟 body | WebUtils 找內層 wrapper | 不同 JSON、同 key 得 409 |
| 07 最終指紋混淆 | 實際 URI、長度編碼、SHA-256、檔案內容；截短拒絕 | 路徑／表單／檔案差異與 boundary 穩定性 |
| 08 過期租約接手 | UNKNOWN 保留；所有更新驗 owner | 逾時不接手、過時 owner 無法改新紀錄 |
| 09 成功結果過大釋放 | MEDIUMBLOB，容量不足保留 UNKNOWN | 65537 bytes 成功結果可回放 |
| 10 回放清掉 CORS | resetBuffer、重算 Content-Length | CORS／Vary／trace 留存 |
| 11 CORS 擋商品寫入 | method／Authorization 選規則 | 信任來源可寫、外人不可寫、公開讀取可用 * |
| 12 SSE 競態 | 同一 monitor 更新配額與索引，讀取回快照 | 同時註冊不超額、register/unregister 索引一致 |
| 13 registry 無接線 | transport register/remove、CONNECT 更新、reaper 與關機 | 配額／到期掃描與 socket 認證流程 |
| 14 JS await 語法 | async 與各關閉碼的退避／終止 | Node 解析與 7 個行為檢查 |
| 15 清理失敗不重試 | EXPIRED 待刪狀態、交易撤銷 token、另輪重試 | 先過期，再失敗與成功刪檔 |
| 16 WebP 無 decoder | 起始 POM 加入 ImageIO WebP 插件 | 真實 1×1 WebP 解碼與重編碼 |
| 17 closeCode 未轉譯 | registry 明確關閉 transport | 真實 socket 收到 4001 |
| 18 MDC 執行緒錯誤 | ExecutorChannelInterceptor 套用與還原 | worker 可讀 MDC、caller／worker 原 context 留存 |
| 19 Boot profile 無效 | 移除假切換；明訂獨立 parent 的版本遷移程序 | 靜態核對；本專案僅執行 3.2.5 |
| 20 fallback 狀態與 URI | HTTP 跟隨已登記 Problem 狀態、ERROR_REQUEST_URI | 408／504 正規化、404 保留、instance 正確 |
| 21 回傳值違規誤回 422 | return-value 分支回 500 | Spring 真實驗證例外 |
| 22 查詢契約漂移 | q、amountFrom/To、limit、重複 sort 與 presence | MockMvc 實際綁定、未知參數攔截 |
| 23 分頁外殼漂移 | OFFSET／CURSOR／NONE、hasMore、limit | Jackson 序列化必要欄位 |
| 24 weak If-Match | 強 validator 與 strong comparison；保留 If-None-Match 弱比對 | weak If-Match 不匹配、strong 正常匹配 |

強 ETag 的聚合版本／表述識別完整性，以及 SQL 的交易與 owner 條件，
仍需在真正 Service／Repository 實作的整合測試中驗證。
