# GitHub 協作專案指南（與他人共同創作）

> 這份文件會用「實際可執行」的角度，說明如何在 GitHub 上與其他創作者協作，以及如何建立一個可讓其他人順利參與的新專案。

---

## 目錄

1. [先了解兩種常見協作模式](#1-先了解兩種常見協作模式)
2. [協作時需注意的細節](#2-協作時需注意的細節)
3. [參與既有專案：逐步流程](#3-參與既有專案逐步流程)
4. [建立新專案並邀請他人參與：逐步流程](#4-建立新專案並邀請他人參與逐步流程)
5. [常見錯誤與避免方式](#5-常見錯誤與避免方式)
6. [快速檢查清單](#6-快速檢查清單)

---

## 1. 先了解兩種常見協作模式

### 模式 A：Collaborator（同倉庫協作）

- 專案擁有者直接把你加入該 Repository。
- 你可以在同一個 repo 建分支、推送分支、開 PR。
  - 註解：PR（Pull Request）是「合併請求」，意思是你把某個分支的修改提交給維護者審查，請他們決定是否合併到目標分支（通常是 `main`）。
- 適合：公司內部團隊、固定協作者、私有專案。

### 模式 B：Fork + Pull Request（開源最常見）

- 你先 Fork 專案到自己的帳號，再從自己的 repo 開 PR 回原專案。
- 原專案維護者不需先給你寫入權限。
- 適合：開源社群、陌生貢獻者、跨組織協作。

---

## 2. 協作時需注意的細節

### 2.1 權限與安全

- 盡量使用最小權限原則（Least Privilege），只給需要的權限。
- 建議開啟 GitHub 兩步驟驗證（2FA）。
- 使用 SSH Key 或 Fine-grained PAT，不要把密鑰寫進程式碼或 commit。
- `.env`、金鑰、憑證必須放進 `.gitignore`。

### 2.2 分支策略

- `main`（或 `master`）應視為穩定分支，避免直接 push。
- 每個功能或修正使用獨立分支，例如：
  - `feature/login-page`
  - `fix/order-total-rounding`
  - `docs/github-collaboration-guide`
- Pull Request 要小而清楚，方便 reviewer 理解與回饋。

### 2.3 Commit 與 PR 品質

- Commit 訊息盡量清楚，描述「為什麼改」而不只是「改了什麼」。
- 一個 commit 專注一件事，避免把重構、修 bug、排版混在同一個 commit。
- PR 內容至少包含：
  - 目的與背景
  - 主要改動
  - 測試方式
  - 可能風險

### 2.4 Review 與溝通

- 先讀專案規範（`README`、`CONTRIBUTING`、`CODE_OF_CONDUCT`）。
- 被 review 時，針對每則留言回應「已修改 / 不採用原因」。
- 討論聚焦在程式與需求，避免人身語氣。

### 2.5 CI/CD 與品質門檻

- 建議設定 PR 必須通過 CI（測試、lint、build）才能合併。
- 重要分支開啟 Branch Protection（必須 review、禁止強推、必須通過檢查）。
- 優先使用 Squash Merge 或 Rebase Merge，保持歷史可讀性。

### 2.6 法務與文件

- 開源專案務必有 `LICENSE`（如 MIT、Apache-2.0）。
- 建議補齊：
  - `README.md`
  - `CONTRIBUTING.md`
  - `CODE_OF_CONDUCT.md`
  - Issue/PR templates

---

## 3. 參與既有專案：逐步流程

以下以「Fork + PR」為範例（開源最常見）。

### 步驟 1：閱讀專案規範與任務

1. 先看 `README`、`CONTRIBUTING`、Issue 標籤與 PR 規範。
2. 選擇一個適合的新手或目前可處理的 Issue。
3. 如果需求不清楚，先在 Issue 留言確認再動手。

### 步驟 2：Fork 與 Clone

```bash
# 先在 GitHub 網頁 Fork 專案到你的帳號
# 再 clone 你的 fork
git clone git@github.com:<your-name>/<repo>.git
cd <repo>
```

### 步驟 3：設定 upstream（追蹤原專案）

```bash
# 將原專案設為 upstream，方便同步最新進度
git remote add upstream git@github.com:<original-owner>/<repo>.git
git remote -v
```

### 步驟 4：建立功能分支

```bash
git checkout -b feature/<short-description>
```

### 步驟 5：開發與自我檢查

```bash
# 開發中建議多次小 commit
git add .
git commit -m "feat: add xxx behavior"

# 依專案規範執行測試（示意）
npm run lint
npm test
```

### 步驟 6：同步原專案最新變更

```bash
# 從原專案遠端 upstream 抓最新提交到本地（不會直接改動目前分支）
git fetch upstream

# 切換到本地 main 分支，先更新主幹內容
git checkout main

# 將 upstream/main 合併進本地 main，讓本地 main 與原專案同步
git merge upstream/main

# 切回你正在開發的功能分支
git checkout feature/<short-description>

# 把功能分支的提交重放到最新 main 之上，降低後續合併衝突
git rebase main
```

> 若團隊偏好 merge 而非 rebase，可改用 `git merge main`。

### 步驟 7：推送分支到你的 fork

```bash
# 將本地功能分支推送到你的 fork（remote 名稱通常是 origin）
# -u（= --set-upstream）會建立本地分支與遠端分支的追蹤關係
git push -u origin feature/<short-description>
```

為什麼可以直接用 `origin`？

- 在步驟 2 你是用 `git clone git@github.com:<your-name>/<repo>.git` 下載你的 fork。
- `git clone` 會自動建立一個名為 `origin` 的 remote，指向「你 clone 的那個倉庫」。
- 所以這裡可以直接寫 `git push origin ...`。
- 可用以下指令確認：

```bash
git remote -v
```

`-u` 是什麼意思？

- `-u` 等同 `--set-upstream`。
- 第一次 push 時加上它，會把本地分支（例如 `feature/x`）綁定到遠端分支（`origin/feature/x`）。
- 設定完成後，後續同一分支通常只要 `git push` / `git pull`，不用每次都寫完整分支名稱。

> 補充：本文件中 `upstream` 是「原專案」，`origin` 是「你的 fork」。

### 步驟 8：建立 Pull Request

1. 到你的 fork 頁面點擊 `Compare & pull request`。
2. Base 選原專案分支（通常是 `main`）。
3. 描述清楚：背景、改動、測試方式、影響範圍。

### 步驟 9：回應 Code Review

```bash
# 根據 review 修改後再 commit
git add .
git commit -m "refactor: address review comments"
git push
```

- 保持同一支分支，PR 會自動更新。
- 每次回覆 reviewer，說明你處理了什麼。

### 步驟 10：合併後清理分支

```bash
# 本地刪除已合併分支
git checkout main
git pull upstream main
git branch -d feature/<short-description>

# 刪除 fork 上遠端分支
git push origin --delete feature/<short-description>
```

---

## 4. 建立新專案並邀請他人參與：逐步流程

以下流程適用「你是專案擁有者，想讓其他人共同開發」的情境。

### 步驟 1：建立 GitHub Repository

1. 前往 [GitHub New Repository](https://github.com/new)。
2. 決定專案名稱、公開或私有（Public / Private）。
3. 建議勾選初始化 `README` 與 `.gitignore`（新專案通常較方便）。

### 步驟 2：初始化本地專案並首次推送

```bash
git clone git@github.com:<your-name>/<new-repo>.git
cd <new-repo>

# 放入初始程式碼後
git add .
git commit -m "chore: initial project setup"
git push origin main
```

### 步驟 3：補齊協作文件（非常重要）

至少建立下列檔案：

- `README.md`：專案目的、安裝方式、使用方式。
- `CONTRIBUTING.md`：開發流程、命名規範、PR 規範。
- `CODE_OF_CONDUCT.md`：社群互動守則。
- `LICENSE`：授權條款（開源必備）。
- `SECURITY.md`（選用）：漏洞回報流程。

### 步驟 4：設計分支與合併策略

建議先定義：

- 預設分支：`main`
- 開發分支（可選）：`develop`
- 功能分支：`feature/*`
- 修正分支：`fix/*`
- 發版分支（可選）：`release/*`

### 步驟 5：設定 Branch Protection

在 `Settings -> Branches` 設定保護規則，建議包含：

- 禁止直接 push 到 `main`
- 必須至少 1 位 reviewer 才能 merge
- 必須通過 CI checks
- 禁止 force push
- 必須解決所有對話（Resolve conversations）

### 步驟 6：建立 Issue 與 PR 模板

在 `.github/` 目錄新增模板可降低溝通成本：

- `.github/ISSUE_TEMPLATE/bug_report.md`
- `.github/ISSUE_TEMPLATE/feature_request.md`
- `.github/PULL_REQUEST_TEMPLATE.md`

模板內建議欄位：

- 背景/問題
- 期望行為
- 重現步驟
- 測試方式
- 風險與回滾方式

### 步驟 7：設定自動化檢查（GitHub Actions）

最基本建議：

- PR 觸發 `lint + test + build`
- `main` 合併後可觸發部署（視專案需求）

這樣可以避免「本機可以、合併後壞掉」的情況。

### 步驟 8：邀請協作者加入

#### 個人倉庫

1. `Settings -> Collaborators`
2. 輸入 GitHub 帳號並發出邀請
3. 對方接受後即可參與

#### 組織（Organization）倉庫

- 透過 Team 管理權限（Read / Triage / Write / Maintain / Admin）
- 建議以 Team 配權，不要逐人手動設定

### 步驟 9：建立協作節奏

建議規範：

- Issue 要先被確認再開工
- PR 至少一位 reviewer
- 每次合併前 CI 必須全綠
- 固定 release 節奏（例如每週一次）

### 步驟 10：提供新成員上手流程（Onboarding）

可在 `README` 加入「10 分鐘上手」章節：

1. 安裝必要工具（Git、Node、Python...）
2. clone 專案
3. 啟動指令
4. 測試指令
5. 提交與 PR 流程

---

## 5. 常見錯誤與避免方式

- **直接在 `main` 開發並 push**  
  -> 用分支 + PR，並啟用 branch protection。

- **一次 PR 改太多內容**  
  -> 切小 PR，單一目標、單一風險。

- **沒有先同步上游就開發**  
  -> 開工前先 `git fetch` / `git rebase` 或 `merge`。

- **缺少測試與重現步驟**  
  -> PR 必附測試方式，CI 要能自動驗證。

- **沒有協作文件，導致每次都口頭說明**  
  -> 建立 `CONTRIBUTING`、模板與範例命名規則。

---

## 6. 快速檢查清單

### 我是貢獻者

- [ ] 已閱讀 `README` 與 `CONTRIBUTING`
- [ ] 已建立獨立功能分支
- [ ] 已通過 lint / test / build
- [ ] PR 說明包含背景、改動、測試方式
- [ ] 已回應 reviewer 的每個意見

### 我是專案維護者

- [ ] 有 `README`、`CONTRIBUTING`、`LICENSE`
- [ ] `main` 已設定 branch protection
- [ ] PR 必須通過 CI 與 review
- [ ] 有 Issue / PR 模板
- [ ] 新人可依文件在短時間內完成第一次貢獻

---

如果你想，我可以再幫你補一版「團隊實戰範本」：包含標準 `CONTRIBUTING.md`、`PULL_REQUEST_TEMPLATE.md`、以及分支命名與 commit message 規範範本。
