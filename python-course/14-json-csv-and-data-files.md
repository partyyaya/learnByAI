# 14｜JSON、CSV 與資料檔處理

> 這章會讓你把資料「進得來、出得去」。你會學會 JSON/CSV 讀寫、格式轉換、資料清理與常見陷阱處理。

## 學習目標

- 了解 JSON 與 CSV 的用途與差異。
- 能用 Python 讀寫 JSON/CSV 檔案。
- 熟悉資料清理與型別轉換的基本流程。
- 能處理常見錯誤（缺欄位、格式錯誤、編碼問題）。

## 前置條件

- 已完成 `13` 章（檔案與路徑操作）。

## 先理解兩種格式

### JSON

- 結構化、可巢狀，適合 API 與設定檔。
- 對應 Python 常見型別：`dict`、`list`、`str`、`int`、`float`、`bool`、`None`。

### CSV

- 純文字、欄位以分隔符（常見逗號）切開。
- 適合表格資料、試算表匯入匯出。

## JSON 讀取：`json.load()`

```python
import json
from pathlib import Path

path = Path("data/user.json")
with path.open("r", encoding="utf-8") as f:
    data = json.load(f)

print(data["name"])
```

## JSON 寫入：`json.dump()`

```python
import json
from pathlib import Path

data = {"name": "Amy", "age": 20, "skills": ["python", "sql"]}
path = Path("data/output.json")

with path.open("w", encoding="utf-8") as f:
    json.dump(data, f, ensure_ascii=False, indent=2)
```

### 參數說明

- `ensure_ascii=False`：保留中文，不轉成 `\uXXXX`。
- `indent=2`：縮排排版，方便閱讀與版控。

## JSON 字串轉換

```python
import json

raw = '{"name":"Ben","age":25}'
obj = json.loads(raw)      # str -> Python 物件
text = json.dumps(obj)     # Python 物件 -> str
```

## CSV 讀取：`csv.DictReader`

```python
import csv
from pathlib import Path

path = Path("data/students.csv")

with path.open("r", encoding="utf-8", newline="") as f:
    reader = csv.DictReader(f)
    for row in reader:
        print(row["name"], row["score"])
```

## CSV 寫入：`csv.DictWriter`

```python
import csv
from pathlib import Path

rows = [
    {"name": "Amy", "score": 90},
    {"name": "Ben", "score": 80},
]

path = Path("data/result.csv")
with path.open("w", encoding="utf-8", newline="") as f:
    writer = csv.DictWriter(f, fieldnames=["name", "score"])
    writer.writeheader()
    writer.writerows(rows)
```

`newline=""` 是 CSV 官方建議，避免多餘空行問題。

## 資料清理常見流程（實務模板）

1. **讀檔**（JSON/CSV）。
2. **欄位檢查**（缺值、型別、範圍）。
3. **轉型別**（例如字串分數轉 `int`）。
4. **清理異常值**（空字串、負數、錯字）。
5. **輸出新檔**（乾淨資料）。

## 範例：清理學生分數 CSV

```python
import csv
from pathlib import Path

src = Path("data/students_raw.csv")
dst = Path("data/students_clean.csv")

clean_rows = []

with src.open("r", encoding="utf-8", newline="") as f:
    reader = csv.DictReader(f)
    for row in reader:
        name = row.get("name", "").strip()
        raw_score = row.get("score", "").strip()

        if not name or not raw_score.isdigit():
            continue

        score = int(raw_score)
        if not (0 <= score <= 100):
            continue

        clean_rows.append({"name": name, "score": score})

with dst.open("w", encoding="utf-8", newline="") as f:
    writer = csv.DictWriter(f, fieldnames=["name", "score"])
    writer.writeheader()
    writer.writerows(clean_rows)

print("清理完成")
```

## JSON 與 CSV 互轉（常見任務）

### CSV -> JSON（概念）

- 讀 CSV 每行成 dict。
- 把多行放入 list。
- `json.dump()` 輸出。

### JSON -> CSV（概念）

- 讀 JSON list。
- 取欄位名稱作為 `fieldnames`。
- `csv.DictWriter()` 輸出。

## 例外處理建議

```python
import json

try:
    data = json.loads('{"name": "Amy",}')
except json.JSONDecodeError as e:
    print(f"JSON 格式錯誤: {e}")
```

對 CSV 可捕捉 `KeyError`、`ValueError`，並記錄是哪一行出錯。

## 常見錯誤與排查

### 錯誤 1：JSON 逗號或引號格式錯誤

- `JSONDecodeError` 很常見。
- 用格式化工具先驗證 JSON 結構。

### 錯誤 2：CSV 欄位名稱拼錯

- `row["scroe"]` 會 `KeyError`。
- 建議先檢查 `reader.fieldnames`。

### 錯誤 3：型別都被當字串

- CSV 讀進來預設是字串。
- 要手動轉型，如 `int(row["score"])`。

### 錯誤 4：中文亂碼

- 寫入與讀取都統一 `encoding="utf-8"`。

## 實務建議

- 保留「原始檔」與「清理後檔」分開管理。
- 每次清理規則改動都記錄在 README。
- 關鍵欄位先做驗證再進入後續邏輯。

## 章末練習

- 必做：讀取一個 JSON 檔，計算其中陣列長度與平均值。
- 必做：讀取 `orders.csv`，輸出總金額與最大訂單。
- 選做：寫一個小工具，把 CSV 轉成 JSON，並支援欄位白名單。

## 本章重點回顧

- JSON 適合結構化資料，CSV 適合表格資料。
- 資料檔處理不只讀寫，更重要是清理與驗證。
- 你已具備實作 ETL 入門流程（讀取 -> 清理 -> 輸出）的能力。
