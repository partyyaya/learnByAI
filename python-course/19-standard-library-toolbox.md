# 19｜標準函式庫工具箱（Standard Library）

> Python 內建標準庫非常強大。這章會帶你掌握實務最常用模組，讓你少造輪子、開發更快。

## 學習目標

- 熟悉常用標準庫模組與典型場景。
- 能用標準庫完成時間處理、統計、資料轉換、命令列參數解析等任務。
- 理解「先用標準庫，再評估第三方套件」的工程策略。

## 前置條件

- 已完成 C 前面章節與基礎資料處理能力。

## `datetime`：日期時間處理

```python
from datetime import datetime, timedelta

now = datetime.now()
tomorrow = now + timedelta(days=1)

print(now.strftime("%Y-%m-%d %H:%M:%S"))
print(tomorrow)
```

### 常見用途

- 報表日期區間
- 到期時間計算
- 日誌時間戳

## `collections`：高效資料結構

### `Counter`：快速計數

```python
from collections import Counter

words = ["python", "api", "python", "data"]
c = Counter(words)
print(c["python"])  # 2
print(c.most_common(1))
```

### `defaultdict`：避免 key 不存在錯誤

```python
from collections import defaultdict

grouped = defaultdict(list)
grouped["A"].append(90)
grouped["A"].append(80)
print(grouped)
```

### `deque`：雙端佇列

```python
from collections import deque

q = deque([1, 2, 3])
q.appendleft(0)
q.append(4)
print(q)
```

## `itertools`：高效迭代工具

```python
from itertools import product, combinations

print(list(product([1, 2], ["A", "B"])))
print(list(combinations([1, 2, 3], 2)))
```

常見於排列組合、測試資料生成、批次配對。

## `statistics`：簡單統計

```python
import statistics as stats

scores = [80, 90, 75, 95]
print(stats.mean(scores))
print(stats.median(scores))
```

對基礎報表非常夠用。

## `math` / `random`：數學與隨機

```python
import math
import random

print(math.sqrt(16))
print(round(math.pi, 2))
print(random.randint(1, 10))
```

## `pathlib`：路徑處理（再次強調）

```python
from pathlib import Path

for p in Path("data").glob("*.json"):
    print(p.name)
```

跨平台可靠，優先於字串拼路徑。

## `argparse`：命令列工具參數解析

```python
import argparse

parser = argparse.ArgumentParser()
parser.add_argument("--name", required=True)
args = parser.parse_args()

print(f"Hello, {args.name}")
```

可讓你的腳本變成可重用 CLI 工具。

## `logging`：比 `print` 更正式的日誌

```python
import logging

logging.basicConfig(level=logging.INFO)
logging.info("服務啟動")
logging.warning("快取未命中")
logging.error("資料庫連線失敗")
```

### 為什麼用 logging

- 可分級（INFO/WARNING/ERROR）。
- 可輸出到檔案與外部系統。
- 更適合正式環境。

## `json` / `csv` / `hashlib`（常用補充）

### 快速計算內容雜湊

```python
import hashlib

text = "hello"
sha = hashlib.sha256(text.encode("utf-8")).hexdigest()
print(sha)
```

可用於資料完整性檢查或快取 key。

## 實作範例：簡易 log 分析器

```python
from collections import Counter
from pathlib import Path
from datetime import datetime

path = Path("app.log")
counter = Counter()

for line in path.read_text(encoding="utf-8").splitlines():
    if "ERROR" in line:
        counter["ERROR"] += 1
    elif "WARNING" in line:
        counter["WARNING"] += 1
    elif "INFO" in line:
        counter["INFO"] += 1

print(f"分析時間: {datetime.now()}")
print(counter)
```

## 工程建議：選工具順序

1. 先想「標準庫可否解決」。
2. 若需求超出標準庫，再選成熟第三方套件。
3. 避免為小需求引入大型依賴。

## 常見錯誤與排查

### 錯誤 1：時區概念混亂

`datetime.now()` 預設是本地時間，跨系統常要明確處理時區。

### 錯誤 2：在正式環境大量使用 `print`

改用 `logging`，才有等級與集中管理能力。

### 錯誤 3：過早引入太多第三方套件

先掌握標準庫，通常能解決 60% 到 80% 常見需求。

## 章末練習

- 必做：寫 CLI 腳本，輸入一個資料夾路徑，統計其中 `.txt` 檔數量。
- 必做：讀一份分數清單，用 `statistics` 輸出平均與中位數。
- 選做：用 `logging` 寫一個簡易任務流程記錄器（開始、成功、失敗）。

## 本章重點回顧

- Python 標準庫是高效率開發的基礎武器庫。
- 學會 `datetime`、`collections`、`argparse`、`logging`，可大幅提升實務能力。
- 優先用標準庫能降低依賴複雜度與維護風險。
