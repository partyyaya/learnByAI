# 20｜虛擬環境、依賴管理與專案結構

> 這章是「把程式寫成可交付專案」的關鍵。你會建立穩定環境、可重現依賴、清晰目錄，讓專案可長期維護與團隊協作。

## 學習目標

- 熟練 `venv` 建立、啟用與重建流程。
- 建立依賴管理習慣（`requirements.txt`、分層需求）。
- 規劃可擴充的 Python 專案結構。
- 理解環境一致性與可重現性的重要性。

## 前置條件

- 已完成 C 區塊前面章節，能撰寫多檔案程式。

## 為什麼這章很重要

很多「我這台能跑、你那台不能跑」的問題，本質上是環境與依賴管理失敗。  
這章的目標就是讓你的專案在任何人機器上都能重現。

## `venv` 標準流程

```bash
python3 -m venv .venv
source .venv/bin/activate
python --version
pip --version
```

### 常用指令

```bash
deactivate
```

離開虛擬環境。

## 依賴安裝與鎖定

### 安裝依賴

```bash
pip install requests
pip install pytest
```

### 匯出依賴

```bash
pip freeze > requirements.txt
```

### 重建依賴

```bash
pip install -r requirements.txt
```

## 建議分層依賴

可拆成：

- `requirements.txt`（正式執行依賴）
- `requirements-dev.txt`（測試、lint、型別檢查）

`requirements-dev.txt` 可以 include 正式依賴：

```text
-r requirements.txt
pytest
mypy
ruff
```

## 專案結構建議（中小型）

```text
my-project/
  .venv/
  src/
    my_project/
      __init__.py
      main.py
      services/
      models/
      utils/
  tests/
    test_main.py
  scripts/
  requirements.txt
  requirements-dev.txt
  .gitignore
  README.md
```

### 為什麼推薦 `src/` 佈局

- 減少路徑混亂與匯入歧義。
- 讓測試更接近實際安裝使用方式。

## `.gitignore` 基本必備

```gitignore
.venv/
__pycache__/
*.pyc
.pytest_cache/
.mypy_cache/
.ruff_cache/
.DS_Store
.env
```

避免提交不必要或敏感檔案。

## 環境變數與 `.env`（觀念）

- API key、密碼、連線字串不要硬編碼在程式裡。
- 放在環境變數或 `.env`，並確保 `.env` 不提交到 Git。

範例：

```python
import os

api_key = os.getenv("API_KEY")
if not api_key:
    raise RuntimeError("缺少 API_KEY 環境變數")
```

## README 最少要寫哪些內容

- 專案目的與功能簡述
- 安裝與啟動步驟
- 環境需求（Python 版本）
- 測試方式
- 常見問題

README 是讓其他人快速上手專案的第一入口。

## 版本相容性策略

- 在 README 或設定檔中明確標示 Python 版本。
- 升級 Python 或套件前先跑測試。
- 定期更新依賴，避免一次升級太多造成風險。

## 實作流程範例（從零到可跑）

```bash
mkdir my-project
cd my-project
python3 -m venv .venv
source .venv/bin/activate
mkdir -p src/my_project tests
touch src/my_project/__init__.py
touch src/my_project/main.py
touch tests/test_main.py
pip install pytest
pip freeze > requirements.txt
```

## 常見錯誤與排查

### 錯誤 1：忘記啟用 `.venv`

- 現象：套件明明安裝卻 `ModuleNotFoundError`。
- 解法：確認終端機前綴有 `(.venv)`。

### 錯誤 2：`requirements.txt` 過舊

- 現象：別人安裝後版本衝突。
- 解法：每次新增依賴後更新清單，並提交版本控制。

### 錯誤 3：專案結構混亂

- 現象：找不到程式入口、匯入路徑一團亂。
- 解法：固定目錄慣例，並把啟動點清楚寫在 README。

## 工程習慣清單（建議固定）

- 新專案第一步就建 `.venv`。
- 任何依賴改動都更新 `requirements`。
- 每次提交前至少跑一次測試與格式檢查。
- 專案目錄與命名遵守同一套規則。

## 章末練習

- 必做：建立一個符合本章結構的新專案骨架。
- 必做：安裝 `pytest` 與 `ruff`，更新 `requirements-dev.txt`。
- 選做：撰寫一份最小可用 README（安裝、啟動、測試三段）。

## 本章重點回顧

- 環境管理與依賴管理是專案可重現的基礎。
- 良好目錄結構讓程式更容易維護與擴充。
- 你已具備從「學習腳本」走向「可交付專案」的工程能力。
