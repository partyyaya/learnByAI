# 22｜程式品質工具：Lint、Format、Type Check

> 這章會把你帶進「團隊級工程品質流程」。你將學會用工具自動檢查錯誤、統一程式風格、提前發現型別問題。

## 學習目標

- 理解 lint、format、type check 三者差異。
- 能用 `ruff` 做語法/風格檢查與自動修正。
- 能用 `black`（或 ruff format）統一格式。
- 能用 `mypy` 進行型別檢查並修正常見問題。

## 前置條件

- 已完成 `17`（typing）與 `21`（測試）會更好上手。

## 三種工具在做什麼

- **Lint**：抓錯誤與可疑寫法（未使用變數、潛在 bug）。
- **Format**：自動統一程式排版（縮排、換行、引號風格）。
- **Type Check**：檢查型別註記與實作是否一致。

三者不是互斥，而是互補。

## 安裝建議

```bash
pip install ruff black mypy
```

## `ruff`：快速 lint（也可 format）

### 檢查

```bash
ruff check src tests
```

### 自動修復可修問題

```bash
ruff check src tests --fix
```

### 只做格式化（可選）

```bash
ruff format src tests
```

## `black`：統一格式

```bash
black src tests
```

建議團隊固定一種 formatter，避免來回變更風格。

## `mypy`：型別檢查

```bash
mypy src
```

`mypy` 會根據型別註記分析程式，抓出型別不一致問題。

## `pyproject.toml` 基本配置範例

```toml
[tool.ruff]
line-length = 100
target-version = "py311"

[tool.black]
line-length = 100
target-version = ["py311"]

[tool.mypy]
python_version = "3.11"
warn_return_any = true
warn_unused_configs = true
disallow_untyped_defs = false
```

把品質工具配置集中管理，專案更一致。

## 常見問題與修正示例

### 1) 未使用的匯入

```python
import os
import json

print("hello")
```

`os`、`json` 沒用到，lint 會提醒。  
修正：刪除未使用匯入。

### 2) 型別不一致

```python
def get_age() -> int:
    return "18"
```

`mypy` 會報錯。  
修正：回傳 `int` 或修正註記。

### 3) 函式缺型別提示

某些嚴格設定會要求所有公開函式帶型別。  
修正：逐步補註記，不必一次全部完成。

## 建議的本地開發流程

每次提交前跑：

1. `ruff check src tests --fix`
2. `black src tests`（或 `ruff format src tests`）
3. `mypy src`
4. `pytest`

如果四步都過，程式品質與穩定性通常會好很多。

## 整合到 CI（觀念）

在 CI 中執行上述檢查，可確保：

- 每次 PR 都遵守同一品質標準。
- 不會因個人環境差異漏掉問題。

## pre-commit（可選但推薦）

```bash
pip install pre-commit
```

使用 pre-commit 可以在 `git commit` 前自動跑 lint/format。  
好處是把品質檢查前移，減少 CI 才發現問題的成本。

## 常見錯誤與排查

### 錯誤 1：工具互相打架

例如 formatter 規則不一致。  
修正：固定工具與配置（例如只用 `ruff format` 或只用 `black`）。

### 錯誤 2：一次開超嚴格 mypy

舊專案會被大量錯誤淹沒。  
修正：先從核心模組開始，逐步提高嚴格度。

### 錯誤 3：只在 CI 跑，不在本地跑

會導致反覆推送修格式。  
修正：本地先跑一輪再提交。

## 章末練習

- 必做：在專案加入 `ruff`，修掉所有 lint 警告。
- 必做：為核心模組加上型別註記並通過 `mypy`。
- 選做：建立 pre-commit 設定，提交前自動跑品質檢查。

## 本章重點回顧

- lint、format、type check 是工程品質三支柱。
- 工具不是限制，而是幫你提早攔截錯誤。
- 建立固定品質流程後，團隊開發速度與穩定性都會提升。
