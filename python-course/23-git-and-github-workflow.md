# 23｜Git 與 GitHub 協作工作流

> 這章會讓你把程式能力連接到團隊協作能力。你會學會從本地開發、分支管理到 Pull Request 的完整流程，這是職場開發必備技能。

## 學習目標

- 理解 Git 基本概念與常用指令。
- 能使用分支進行功能開發與錯誤修復。
- 熟悉 GitHub Pull Request 協作流程。
- 了解常見衝突與回滾策略（非破壞式）。

## 前置條件

- 已完成 `20`（專案結構）與 `21`、`22`（測試與品質工具）。

## Git 核心觀念

- **Repository**：專案版本資料庫。
- **Commit**：一次有意義的變更快照。
- **Branch**：平行開發線。
- **Merge**：把分支變更整合回主線。

## 新專案初始化

```bash
git init
git add .
git commit -m "chore: initialize project"
```

## 基本日常指令

```bash
git status
git add <file>
git add .
git commit -m "feat: add score calculator"
git log --oneline
```

### 建議

- 每次 commit 聚焦一件事。
- commit 訊息寫清楚「為什麼改」。

## 分支工作流（推薦）

### 建立功能分支

```bash
git switch -c feat/add-discount-rule
```

### 開發與提交

```bash
git add .
git commit -m "feat: add vip discount logic"
```

### 切回主分支並合併

```bash
git switch main
git merge feat/add-discount-rule
```

團隊通常透過 PR 進行，不直接在本地 merge 到 main。

## GitHub PR 流程（實務）

1. 從 `main` 拉新分支。
2. 開發功能並提交。
3. `git push` 到遠端分支。
4. 在 GitHub 發 PR。
5. 通過 CI、Code Review。
6. Merge 到 `main`。

## Commit Message 建議格式

可採用簡單 Conventional Commits：

- `feat:` 新功能
- `fix:` bug 修正
- `refactor:` 重構（不改行為）
- `test:` 測試相關
- `docs:` 文件更新
- `chore:` 雜項維護

範例：

```text
feat: add order total calculation service
fix: handle empty score input in CLI
docs: update setup instructions
```

## `.gitignore` 再提醒

不要提交：

- `.venv/`
- `.env`
- 暫存與快取檔
- 大型生成檔（除非必要）

## 處理 merge conflict（入門流程）

1. 拉最新主分支並嘗試合併。
2. 找到衝突標記（`<<<<<<<`、`=======`、`>>>>>>>`）。
3. 手動整合保留內容。
4. 重新測試。
5. `git add` + `git commit` 完成衝突解決。

## 安全回退策略（非破壞）

### `git revert`

建立一個新 commit 反向撤銷舊 commit，適合共享分支。

```bash
git revert <commit_hash>
```

### `git restore`（檔案層級）

```bash
git restore src/main.py
```

可還原未提交變更（請先確認是否真的要捨棄）。

## 常見錯誤與排查

### 錯誤 1：在 `main` 直接開發

修正：功能一律在 feature branch 開發。

### 錯誤 2：一次 commit 太多無關變更

修正：拆成多個小 commit，Review 才清楚。

### 錯誤 3：沒先拉最新主分支就開 PR

修正：開 PR 前 rebase/merge 最新主分支並重跑測試。

### 錯誤 4：提交敏感資訊

修正：馬上移除、旋轉金鑰、補 `.gitignore`，並建立掃描機制。

## 建議的提交前檢查清單

- [ ] 測試全部通過（`pytest`）。
- [ ] lint/format/type check 通過。
- [ ] 只提交本次需求相關檔案。
- [ ] commit message 清楚可讀。
- [ ] README/文件是否需要同步更新。

## 章末練習

- 必做：建立一個 feature branch，完成小功能後發一個 PR（可自建練習 repo）。
- 必做：模擬一次 merge conflict 並手動解決。
- 選做：制定你自己的 commit message 規範草案。

## 本章重點回顧

- Git 是版本控制工具，GitHub 是協作平台。
- 分支開發 + PR 審查是團隊開發基本流程。
- 穩定的提交與審查習慣，能大幅降低整體維護成本與上線風險。
