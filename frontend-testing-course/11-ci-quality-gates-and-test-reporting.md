# 11｜CI、品質門檻與測試報表

> 寫完測試只是開始。這章會把測試接上 CI，讓品質控制變成團隊流程，而不是個人習慣。

## 學習目標

- 建立 pull request 自動測試流程。
- 設計合理的品質門檻（quality gates）。
- 讀懂測試報表並快速定位失敗原因。
- 讓團隊對「測試紅燈」有一致處理規範。

## 前置知識

- 已完成 `10` 章，具備可維護測試資料與案例架構。
- 熟悉 GitHub Actions、GitLab CI 或其他 CI 平台基本概念。

## CI 測試分層策略

### PR 階段（快速回饋）

- 單元測試
- 核心整合測試
- Smoke E2E（少量高價值案例）

### Nightly 或主分支階段（完整驗證）

- 全量整合測試
- 完整 E2E 套件
- 視覺回歸與可近用性檢查

## 品質門檻設計

建議先從可執行門檻開始，而非一開始就拉滿：

- 測試必須全綠。
- 覆蓋率設定最低門檻（例如 lines 70%、branches 60%）。
- 重要目錄（如 `src/features/checkout`）可逐步提高門檻。
- 嚴禁忽略 flaky test，必須追蹤與修復。

## GitHub Actions 範例

```yaml
name: ci

on:
  pull_request:
  push:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - run: npm run test
      - run: npm run test:e2e
```

## 失敗排查順序建議

1. 先看是否環境問題（依賴安裝、瀏覽器驅動、測試資料）。
2. 再看是否測試腳本脆弱（selector、等待條件、污染）。
3. 最後確認是否真實功能回歸。

## 常見錯誤

- 全部測試都塞 PR pipeline，造成回饋過慢。
- 覆蓋率門檻訂太高，導致團隊以「湊數測試」應付。
- 紅燈時直接 rerun，不處理根因。

## 面試與實務延伸

- 你會如何設計一個兼顧速度與品質的 CI 測試流程？
- 如果團隊抱怨 CI 太慢，你會先優化哪三件事？
- 為什麼 flaky test 是技術債，而不是可以忽略的噪音？

## 本章練習

1. 在專案建立 PR 測試 workflow。
2. 設定最小覆蓋率門檻。
3. 定義「測試紅燈處理規範」：誰修、何時修、如何追蹤。

## 驗收清單

- [ ] PR 開啟時會自動跑測試。
- [ ] 我有明確品質門檻與例外規範。
- [ ] 測試失敗時能快速分類環境/腳本/真實缺陷。

---

完成後請前往 [12-legacy-code-safety-and-refactor-strategy.md](./12-legacy-code-safety-and-refactor-strategy.md)。
