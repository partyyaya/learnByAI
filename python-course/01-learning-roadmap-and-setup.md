# 01｜學習地圖與開發環境建置

> 這章的目標是讓你把學習路線看清楚，並一次把開發環境設好。學完後，你的電腦應該可以穩定執行 Python 專案。

## 學習目標

- 看懂從新手到可做專案的完整學習路徑。
- 正確安裝 Python 與常用工具（終端機、VS Code、套件管理）。
- 建立第一個可維護的 Python 專案資料夾。
- 知道 `venv`（虛擬環境）為什麼重要，並能實際使用。

## 前置條件

- 已完成 `00` 章，知道 Python 的主要應用方向。
- 可使用電腦安裝軟體與打開終端機。

## 全課程學習地圖（先看大圖）

### 階段 1：語法與基礎觀念（你正在這裡）

- 目標：可以獨立寫小程式，處理輸入、運算、輸出。
- 你會學到：變數、條件、迴圈、函式、資料結構、例外處理。

### 階段 2：工程化能力

- 目標：從「能跑」進化到「可維護、可擴充」。
- 你會學到：模組化、套件管理、測試、lint、型別提示。

### 階段 3：實務應用

- 目標：能做出對工作有價值的功能。
- 你會學到：API、資料庫、資料分析、自動化、爬蟲、非同步。

### 階段 4：專題與作品集

- 目標：完成可展示的專案，能講清楚設計與取捨。
- 你會產出：CLI 工具、API 服務、資料分析報告其中至少一種。

## 先決策：你的 Python 版本策略

建議使用 **Python 3.11 或以上**（例如 3.11、3.12、3.13）。

- 新版通常有更好的效能與語法支援。
- 套件相容性目前也普遍良好。
- 課程示範以 Python 3 為主，不使用 Python 2 語法。

## 安裝步驟（macOS 優先）

你可以二選一，建議新手選方法 A。

### 方法 A：官方安裝包（新手友善）

1. 到 Python 官方網站下載最新穩定版安裝包。
2. 依預設步驟安裝完成。
3. 在終端機驗證：

```bash
python3 --version
pip3 --version
```

如果能看到版本號，表示安裝成功。

### 方法 B：Homebrew 安裝（開發者常用）

```bash
brew update
brew install python
python3 --version
pip3 --version
```

如果你已使用 Homebrew 管理工具，這方式會更一致。

## VS Code 建議設定（本課程預設編輯器）

### 建議安裝擴充套件

- `Python`（官方）
- `Pylance`
- `Error Lens`（可選，讓錯誤提示更明顯）

### 為什麼要裝這些

- 即時語法提示，減少拼字錯誤。
- 自動補全與跳轉，提高學習效率。
- 型別與錯誤提醒，幫你更快定位問題。

## 建立你的第一個專案資料夾

以下流程建議每個專案都照做一次。

```bash
mkdir python-learning-project
cd python-learning-project
python3 -m venv .venv
source .venv/bin/activate
python --version
```

看到 `(.venv)` 出現在終端機前面，表示虛擬環境啟用成功。

## 為什麼一定要用虛擬環境（`venv`）

- 每個專案使用自己的套件版本，避免互相衝突。
- 你可以安全升級或降級某個套件，不影響其他專案。
- 團隊協作時，環境更容易重現。

## 套件安裝與管理（最小必備）

### 安裝示範

```bash
pip install requests
```

### 產生依賴清單

```bash
pip freeze > requirements.txt
```

### 用依賴清單重建環境

```bash
pip install -r requirements.txt
```

## 推薦的專案基本結構

```text
python-learning-project/
  .venv/
  src/
    main.py
  tests/
  requirements.txt
  README.md
  .gitignore
```

## `.gitignore` 新手最常漏的內容

```gitignore
.venv/
__pycache__/
*.pyc
.DS_Store
```

避免把不必要的暫存或本地環境檔案提交到版本控制。

## 第一個可執行檔案（環境驗證）

建立 `src/main.py`：

```python
def main():
    print("Hello, Python learner!")


if __name__ == "__main__":
    main()
```

在專案根目錄執行：

```bash
python src/main.py
```

若看到 `Hello, Python learner!`，表示你的開發環境已可正常工作。

## 常見安裝問題與排查

### 問題 1：`python` 指到錯的版本

- 現象：`python --version` 不是你預期的版本。
- 做法：先用 `python3` 執行，並在 VS Code 選正確 Interpreter。

### 問題 2：`pip` 安裝成功但程式找不到套件

- 原因：你安裝在系統 Python，不在目前專案的 `.venv`。
- 做法：先 `source .venv/bin/activate` 再 `pip install`。

### 問題 3：VS Code 沒有提示或出現紅線

- 做法：
  1. 確認已安裝 Python/Pylance 擴充。
  2. 透過「Python: Select Interpreter」選到 `.venv`。
  3. 重新開啟視窗。

### 問題 4：指令可在終端機跑，VS Code 卻不行

- 原因：兩邊使用的是不同 Python 環境。
- 做法：統一到同一個 `.venv`，再重試。

## 你應該建立的學習節奏（務實版本）

- 每週至少 3 次，每次 45 到 90 分鐘。
- 單次流程：`20 分鐘學習 + 25 分鐘實作 + 10 分鐘整理筆記`。
- 每週至少產出 1 個可執行小成果（即使只有 30 行程式也可以）。

## 本章檢查清單（全部打勾再進下一章）

- [ ] 我能在終端機看到正確的 `python3 --version`。
- [ ] 我已建立 `.venv` 並成功啟用。
- [ ] 我能安裝一個套件並匯出 `requirements.txt`。
- [ ] 我能執行 `src/main.py` 並看到正確輸出。
- [ ] VS Code 已選到正確的 Python Interpreter。

## 章末練習

- 必做：在你的專案中新增 `src/intro.py`，輸出你的姓名與學習目標。
- 必做：重建一次環境（刪除後重建 `.venv`），確認自己可獨立完成。
- 選做：安裝 `pytest` 並嘗試執行 `pytest --version`。

## 本章重點回顧

- 你先看懂了學習路線，再建好可持續使用的開發環境。
- `venv` 是 Python 專案最重要的工程習慣之一。
- 從現在開始，每個新專案都照同一套流程建立，能大幅降低問題率。
