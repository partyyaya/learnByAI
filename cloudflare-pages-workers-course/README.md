# Cloudflare Pages + Workers 課程

> 這套課程專為前端工程師設計，目標是讓你可以從零到一完成 Cloudflare Pages + Workers 的部署、串接、儲存選型與 CI/CD 自動化。

---

## 課程目錄

| 章節 | 檔案 | 主題 | 狀態 |
|------|------|------|------|
| 00 | [00-setup-and-learning-path.md](./00-setup-and-learning-path.md) | 課程導覽與環境準備 | 已完成 |
| 01 | [01-pages-workers-overview.md](./01-pages-workers-overview.md) | Pages + Workers 架構全覽 | 已完成 |
| 02 | [02-workers-plan-selection.md](./02-workers-plan-selection.md) | Workers 方案選型 | 已完成 |
| 03 | [03-storage-strategy-for-workers.md](./03-storage-strategy-for-workers.md) | 儲存策略與資料設計 | 已完成 |
| 04 | [04-frontend-build-to-pages.md](./04-frontend-build-to-pages.md) | 前端打包與部署到 Pages | 已完成 |
| 05 | [05-pages-iteration-preview-rollbacks.md](./05-pages-iteration-preview-rollbacks.md) | Preview、迭代與回滾 | 已完成 |
| 06 | [06-connect-frontend-to-workers.md](./06-connect-frontend-to-workers.md) | 前端串接 Workers API | 已完成 |
| 07 | [07-local-dev-integration-testing.md](./07-local-dev-integration-testing.md) | 本地整合開發與測試 | 已完成 |
| 08 | [08-cicd-for-pages-and-workers.md](./08-cicd-for-pages-and-workers.md) | CI/CD 流程設計 | 已完成 |
| 09 | [09-observability-security-and-cost.md](./09-observability-security-and-cost.md) | 監控、安全與成本管理 | 已建立骨架 |
| 10 | [10-capstone-and-production-checklist.md](./10-capstone-and-production-checklist.md) | 實戰專題與上線檢查清單 | 已建立骨架 |

---

## 四大學習目標對應

- 目標 1：怎麼選擇合適的 Workers 方案與儲存資料方式
  - 對應章節：`02`、`03`
- 目標 2：如何將打包的前端檔案上傳到 Pages 並持續迭代
  - 對應章節：`04`、`05`
- 目標 3：如何與 Workers 串接
  - 對應章節：`06`、`07`
- 目標 4：是否有建議的 CI/CD 方法
  - 對應章節：`08`（搭配 `09` 的營運面）

## 建議學習順序

1. 觀念與決策：`00` ~ `03`
2. 部署與整合：`04` ~ `07`
3. 自動化與上線：`08` ~ `10`
