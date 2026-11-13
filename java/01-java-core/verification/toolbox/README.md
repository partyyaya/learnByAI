這個目錄驗證第 14 章「常用標準 API 與工具庫」的可執行範例。

從 repo 根目錄執行：

```bash
python3 java/01-java-core/verification/toolbox/run.py
# Maven 相依套件已下載後：
python3 java/01-java-core/verification/toolbox/run.py --offline
```

需要 JDK 21、Maven 3.9、Python 3。首次執行會從 Maven repository 下載公開依賴；HTTP 測試只使用隨機 localhost 埠，不呼叫公網 API，不需要 Docker。

`prepare.py` 從目前的 [第 14 章](../../14-common-apis-and-libraries.md#tool-index) 原樣擷取 25 個完整 Java 區塊與 POM。產生的程式放在 `target/generated-sources/lessons/`；POM 只額外加上 JUnit、Surefire 與擷取來源目錄，不替換範例實作。

驗證分兩部分：

- 25 個完整 main 範例都會編譯並執行。HttpExamples 無參數時只印出提示，其實際 HTTP 行為由本機 fixture 檢查。
- 18 個行為檢查涵蓋非法日期、貨幣最小單位與溢位、匯率方向與到期、跨幣別相加、國家代碼、電話、Unicode、BOM 與大小上限、JSON 精度、CSV 引號換行、Excel 長編號、PDF 文字、HTML 清理、Validation、YAML 與摘要／DTO 欄位，以及 HTTP 成功、失敗與回應上限。

本次（2026-11-13）在 Temurin 21.0.5、Maven 3.9.16 驗證：**43 個測試，0 failures、0 errors、0 skipped**。這是第 14 章獨立專案的驗證，沒有重新跑第 00～13 章的 Todo 專案。

輸出：

- `target/verification.log`：當次 Maven 與範例輸出。
- `target/surefire-reports/`：JUnit XML／文字報告。
- `target/summary.json`：測試統計。
- `target/classes.txt`：從課文擷取的類別清單。

測試使用虛構固定匯率與模擬資料，不會驗證真實匯率供應商、付款、電話持有人或第三方服務可用性。PDF 範例只處理英文內建字型；中文嵌字型、OCR、大型匯出、完整網路 deadline 與正式環境效能未在此驗收。

需要修改範例時改 Markdown，再重跑此工具；不要直接編輯 `target/`。
