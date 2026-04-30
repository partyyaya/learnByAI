# 12｜模組、套件與 import 實務

> 到這章你會從「單一檔案程式」升級到「多檔案可維護專案」。這是 Python 工程化能力的起點。

## 學習目標

- 理解模組（module）與套件（package）的差異。
- 熟悉 `import` 常見寫法與最佳實踐。
- 能把一個小程式拆成多個檔案並互相引用。
- 了解 Python 如何搜尋模組，並排除 `ModuleNotFoundError`。

## 前置條件

- 已完成 B 區塊（`03` 到 `11`）。
- 可在專案中建立多個 `.py` 檔案。

## 先理解兩個名詞

- **模組（module）**：一個 `.py` 檔案就是一個模組。
- **套件（package）**：一個包含多個模組的資料夾（通常含 `__init__.py`）。

## 為什麼要拆模組

- 降低單檔案複雜度，程式更好讀。
- 功能重用更容易。
- 測試與維護成本更低。
- 團隊協作時可以分工開發。

## `import` 基本寫法

### 寫法 1：匯入整個模組

```python
import math
print(math.sqrt(16))
```

### 寫法 2：只匯入需要的符號

```python
from math import sqrt
print(sqrt(25))
```

### 寫法 3：使用別名

```python
import numpy as np
from datetime import datetime as dt
```

別名可讓程式碼更精簡，但要保持可讀性。

## `import` 的選擇建議

- 優先 `import module`，可讀性高、命名衝突較少。
- `from module import name` 適合經常使用的少量符號。
- 避免 `from module import *`，容易污染命名空間。

## 專案拆分範例

假設專案結構如下：

```text
src/
  app.py
  utils/
    __init__.py
    calculator.py
```

`calculator.py`：

```python
def add(a: float, b: float) -> float:
    return a + b
```

`app.py`：

```python
from utils.calculator import add


def main():
    result = add(2, 3)
    print(f"結果: {result}")


if __name__ == "__main__":
    main()
```

## `__init__.py` 的角色

- 讓 Python 明確知道該資料夾是套件。
- 可放套件初始化邏輯（通常簡潔即可）。
- 可在這裡重新匯出常用函式，簡化匯入路徑。

例如 `utils/__init__.py`：

```python
from .calculator import add
```

這樣可用：

```python
from utils import add
```

## 相對匯入與絕對匯入

### 絕對匯入（推薦）

```python
from utils.calculator import add
```

可讀性高、重構時較穩定。

### 相對匯入

```python
from .calculator import add
```

常見於套件內部模組互相引用。  
注意：直接執行子模組時可能遇到路徑問題。

## `if __name__ == "__main__":` 與模組重用

把「測試或啟動邏輯」放在這個區塊，可避免被 import 時自動執行：

```python
def add(a, b):
    return a + b


if __name__ == "__main__":
    print(add(1, 2))
```

## Python 模組搜尋路徑（重要）

Python 會依序在以下位置找模組：

1. 目前執行檔案目錄
2. 環境變數 `PYTHONPATH`
3. 標準函式庫與 site-packages

可查看：

```python
import sys
print(sys.path)
```

## 常見錯誤：`ModuleNotFoundError`

### 可能原因

- 執行指令目錄不正確。
- 匯入路徑寫錯。
- 忘記建立 `__init__.py`（某些情境）。
- 套件未安裝在目前虛擬環境。

### 排查步驟

1. 先確認目前在哪個資料夾執行。
2. 確認使用的是專案 `.venv` 的 Python。
3. 檢查檔案結構與匯入路徑拼字。
4. 必要時印出 `sys.path`。

## 模組命名建議

- 檔名用小寫與底線：`data_loader.py`。
- 不要與標準庫同名（例如 `json.py`、`random.py`）。
- 套件名稱要具語意（`services`、`repositories`、`utils`）。

## 公開 API 與內部實作

可以用底線表示內部函式：

```python
def _parse_raw_data(text: str) -> list[str]:
    ...

def load_users(path: str):
    ...
```

團隊慣例通常視 `_name` 為內部使用，不建議外部直接依賴。

## 章末練習

- 必做：把你之前的分數程式拆成兩個模組（輸入處理與等級計算）。
- 必做：建立 `src/utils/text_tools.py`，實作 `to_slug(text)` 並在主程式匯入使用。
- 選做：在 `__init__.py` 統一導出常用函式，讓主程式匯入更簡潔。

## 本章重點回顧

- 模組是檔案，套件是資料夾中的模組集合。
- `import` 不只是語法，背後是可維護性與架構設計。
- 學會模組化後，你的程式可以從練習題升級為真正專案。
