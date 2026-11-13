# Spring Security 教材驗證

驗證程式每次從目前 Markdown 擷取成品 Java 與 SQL，避免維護另一份已修好、卻與課文不同的實作。

```bash
bash java/09-spring-security/verification/run.sh
```

需要 Python 3、Docker、可取得 Maven 相依的網路。腳本預設 MySQL `8.0.46` 與 Maven／JDK 21 映像，每次建立獨立的臨時 MySQL，結束後刪除，不發布主機資料庫連接埠。測試內會清除專用 `lab09` 的測試資料，不能把連線改為既有資料庫。

本機若已有相同版本的 `mysql:8.0` 映像與 Maven cache，可離線執行：

```bash
MYSQL_IMAGE=mysql:8.0 \
MAVEN_CACHE_DIR="$HOME/.m2/repository" \
bash java/09-spring-security/verification/run.sh
```

`MAVEN_CACHE_DIR` 以唯讀掛載，需預先備齊 pom 相依與 Maven plugins；未指定時下載到本目錄被忽略的 `target/m2`。`prepare.py` 的擷取結果、SQL、JUnit 報告均位於被忽略的 `target/`。

## 檢查範圍

| 測試 | 覆蓋內容 |
|---|---|
| `SecretContractTest` | 缺少、空白、過短 JWT secret 都無法啟動 |
| `SecurityIntegrationTest` | 無實驗 profile 的成品接線與方法授權、401／403 JSON、公開商品、退款／刪除／報表權限 |
| 同上 | JWT 的本地 userId 與跨使用者資源查詢；拒絕非 HS256、篡改、過期、帳號刪除後的 token |
| 同上 | 社群帳號禁止本地密碼、OIDC 檢查停用／鎖定／帳號期限，停用同時撤銷表單／OIDC session、access／refresh |
| 同上 | 實際 JSON 與表單登入的密碼／四種帳號狀態、認證事件、第五次後鎖定、CSRF、忽略客戶端偽造的 X-Forwarded-For |
| 同上 | JSON 登入與 refresh 發行流程、併發 rotation 只有一次成功且重用撤銷整條 family、子 token INSERT 失敗回滾父 token 消耗 |
| 同上 | JVM 時區切換不影響 refresh 期限、CORS 白名單與 exposedHeaders |
| 同上 | 真實 SQL 錯誤與業務例外回滾時只有失敗稽核；拒絕讓稽核外層加入既有交易 |
| `CommitAuditTest` | 模擬交易提交前失敗，確認業務與 SUCCESS 回滾，FAILURE 獨立提交 |

資料庫表與成品類別都取自課文。HTTP fixture 只補受保護路徑，退款與身分／權限／持久化沿用課文原碼。Google 不連外：以已驗證的 OIDC id_token fixture 驗證真實 user-service 與本地帳號整合，未涵蓋 Google 的完整重新導向／token 交換協定。Basic CSRF 與 Hibernate Filter 的修正屬於說明及適用範圍，沒有宣稱用裸 HTTP client 取代真瀏覽器驗證。

## 本輪驗證

Docker MySQL 實際版本 `8.0.46`、UTC session、Connector/J `8.3.0`、Boot `3.2.5`、Security `6.2.4`、Hibernate `6.4.4.Final`、JJWT `0.12.5`；Docker JDK 為 `21.0.12.1`。本輪 **22 個測試全部通過，0 failures／errors／skipped**；詳細結果位於 `target/surefire-reports/`，執行紀錄為 `target/verification.log`。

教材沿用課程固定版本驗證；此處沒有把固定版本解讀為正式環境的最新維護版本。金流退款、多節點限速、可靠稽核投遞等仍屬各章明示的延伸範圍。
