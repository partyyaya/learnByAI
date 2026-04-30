# 13｜檔案讀寫與 pathlib

> 這章會讓你的程式真正接觸「外部世界」：讀資料、寫結果、處理路徑。這是資料處理、自動化、後端任務的核心能力。

## 學習目標

- 熟悉文字檔與二進位檔的基本讀寫方式。
- 理解 `with open(...)` 的資源管理意義。
- 能使用 `pathlib` 做跨平台路徑處理。
- 避免常見錯誤（編碼、路徑、檔案不存在）。

## 前置條件

- 已完成 `12` 章（模組化基礎）。

## 為什麼檔案 I/O 重要

- 讀取設定檔、資料檔（JSON、CSV）。
- 輸出報表、日誌、分析結果。
- 做批次任務時大量使用檔案操作。

## `open()` 基本模式

```python
with open("notes.txt", "r", encoding="utf-8") as f:
    content = f.read()
    print(content)
```

### 為什麼要用 `with`

- 區塊結束自動關閉檔案。
- 遇到例外也會確保資源釋放。
- 這是 Python 檔案操作最佳實踐。

## 檔案模式（mode）速記

- `"r"`：讀取（檔案需存在）
- `"w"`：覆寫寫入（不存在會建立）
- `"a"`：附加寫入
- `"x"`：建立新檔（已存在會報錯）
- `"b"`：二進位模式（如圖片）
- `"t"`：文字模式（預設）

可組合使用，例如 `"rb"`、`"wb"`。

## 文字檔讀取方式

### 全部讀入：`read()`

```python
with open("log.txt", "r", encoding="utf-8") as f:
    text = f.read()
```

適合小檔案。

### 一次一行：`for line in f`

```python
with open("log.txt", "r", encoding="utf-8") as f:
    for line in f:
        print(line.strip())
```

適合大檔案，記憶體較省。

### 讀取所有行：`readlines()`

```python
with open("log.txt", "r", encoding="utf-8") as f:
    lines = f.readlines()
```

回傳 list，每行一個字串。

## 文字檔寫入方式

### 覆寫寫入

```python
with open("report.txt", "w", encoding="utf-8") as f:
    f.write("第一行\n")
    f.write("第二行\n")
```

### 追加寫入

```python
with open("report.txt", "a", encoding="utf-8") as f:
    f.write("新增一行\n")
```

## 二進位檔案（圖片、音檔）

```python
with open("input.png", "rb") as src, open("copy.png", "wb") as dst:
    dst.write(src.read())
```

## `pathlib`：現代路徑處理方式（推薦）

```python
from pathlib import Path

base = Path("data")
file_path = base / "users.txt"
print(file_path)
```

`/` 運算子可拼接路徑，清楚且跨平台。

## `pathlib` 常見操作

```python
from pathlib import Path

p = Path("data/users.txt")

print(p.exists())       # 是否存在
print(p.is_file())      # 是否為檔案
print(p.parent)         # 上層目錄
print(p.name)           # 檔名
print(p.suffix)         # 副檔名
```

## 用 `Path` 直接讀寫文字

```python
from pathlib import Path

p = Path("notes.txt")
p.write_text("Hello\nPython\n", encoding="utf-8")
content = p.read_text(encoding="utf-8")
print(content)
```

## 建立資料夾與遞迴建立

```python
from pathlib import Path

out_dir = Path("output/reports")
out_dir.mkdir(parents=True, exist_ok=True)
```

- `parents=True`：需要時連上層一起建立。
- `exist_ok=True`：已存在不報錯。

## 列出目錄內容

```python
from pathlib import Path

data_dir = Path("data")

for p in data_dir.iterdir():
    print(p)
```

篩選副檔名：

```python
for p in data_dir.glob("*.txt"):
    print(p.name)
```

## 實作範例：批次合併文字檔

```python
from pathlib import Path

source_dir = Path("logs")
target = Path("merged.txt")

all_lines = []
for file in source_dir.glob("*.txt"):
    all_lines.append(f"# {file.name}\n")
    all_lines.append(file.read_text(encoding="utf-8"))
    all_lines.append("\n")

target.write_text("".join(all_lines), encoding="utf-8")
print("合併完成")
```

## 常見錯誤與排查

### 錯誤 1：`FileNotFoundError`

- 原因：路徑錯誤或檔案不存在。
- 解法：先用 `Path.exists()` 檢查，再讀檔。

### 錯誤 2：`UnicodeDecodeError`

- 原因：編碼不一致。
- 解法：明確指定 `encoding="utf-8"`，必要時確認原始檔編碼。

### 錯誤 3：覆寫掉舊檔案

- 原因：誤用 `"w"` 模式。
- 解法：先備份或改用 `"a"`，重要檔案可加確認機制。

## 安全寫入建議（進階但實用）

- 先寫到暫存檔，再替換正式檔，降低中途失敗造成損壞風險。
- 寫入前做輸入資料驗證，避免垃圾資料進入結果檔。

## 章末練習

- 必做：讀取 `input.txt`，統計總行數與總字數並輸出。
- 必做：建立 `output/summary.txt`，把分析結果寫入檔案。
- 選做：批次讀取某資料夾所有 `.log`，只保留含 `ERROR` 的行到新檔案。

## 本章重點回顧

- `with open(...)` 是檔案操作標準寫法。
- `pathlib` 讓路徑操作更安全、清楚、跨平台。
- 你已具備處理本地資料檔案的核心能力，後續 JSON/CSV 章節會直接沿用。
