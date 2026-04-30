# 04｜輸入、輸出與格式化

> 這章會讓你的程式開始「和人互動」。你會學會接收輸入、清楚輸出、格式化結果，並避免最常見的輸入型別錯誤。

## 學習目標

- 熟練 `input()` 與 `print()` 的基本與進階用法。
- 理解「所有輸入預設都是字串」這個關鍵事實。
- 能使用 f-string 做清楚且可控的輸出格式。
- 能建立一個基本互動式 CLI 程式。

## 前置條件

- 已完成 `03` 章，理解基本型別與型別轉換。

## 輸入：`input()` 的核心概念

`input()` 會從終端機讀取一行文字，**回傳值永遠是 `str`**。

```python
name = input("請輸入姓名：")
print(name)
print(type(name))  # <class 'str'>
```

### 為什麼這很重要

很多新手錯誤都來自「把字串當數字用」。

```python
age = input("請輸入年齡：")
print(age + 1)  # TypeError
```

修正：

```python
age = int(input("請輸入年齡："))
print(age + 1)
```

## 輸出：`print()` 的常見用法

### 1) 基本輸出

```python
print("Hello")
print(123)
print(True)
```

### 2) 一次輸出多個值

```python
name = "Amy"
age = 20
print("姓名:", name, "年齡:", age)
```

### 3) `sep`：自訂分隔符號

```python
print("2026", "04", "28", sep="-")  # 2026-04-28
```

### 4) `end`：自訂結尾

```python
print("Loading", end="...")
print("Done")
```

輸出會是 `Loading...Done`（第一行不換行）。

## 格式化輸出：f-string（最推薦）

f-string 可讀性最好，也是實務最常見方式。

```python
name = "Gary"
score = 95
print(f"{name} 的分數是 {score}")
```

### 常見格式控制

```python
price = 12.34567
print(f"{price:.2f}")   # 12.35（小數兩位）

ratio = 0.876
print(f"{ratio:.1%}")   # 87.6%（百分比）

order_id = 23
print(f"{order_id:05d}")  # 00023（補零）
```

## 多行字串與排版

```python
report = """
=== 本日報表 ===
營收: 12000
訂單: 87
"""
print(report)
```

用在報表、提示訊息、CLI 幫助文字很方便。

## 使用者輸入的安全處理（入門版）

### 1) 去掉頭尾空白

```python
name = input("姓名：").strip()
```

### 2) 轉型前先檢查

```python
raw_age = input("年齡：").strip()
if raw_age.isdigit():
    age = int(raw_age)
    print(f"你明年 {age + 1} 歲")
else:
    print("請輸入有效整數")
```

這種先驗證再轉換的寫法，能大幅減少 `ValueError`。

## 實作範例：BMI 計算器（互動式）

```python
name = input("請輸入姓名：").strip()
raw_height = input("請輸入身高(公尺)：").strip()
raw_weight = input("請輸入體重(公斤)：").strip()

height = float(raw_height)
weight = float(raw_weight)
bmi = weight / (height ** 2)

print(f"{name} 的 BMI 是 {bmi:.2f}")
```

你可以再加入判斷區間（例如過輕、正常、過重）。

## 常見錯誤與排查

### 錯誤 1：忘記轉型別

- 現象：`TypeError: can only concatenate str...`
- 修正：`int(...)` 或 `float(...)`。

### 錯誤 2：輸入非數字造成 `ValueError`

- 現象：`invalid literal for int()`
- 修正：用 `isdigit()` 或 `try/except`。

### 錯誤 3：輸出混亂、不易讀

- 修正：統一使用 f-string，必要時加上欄位格式。

## 實務寫法建議

- **輸入階段**：`strip()` 清洗。
- **轉換階段**：型別轉換 + 驗證。
- **輸出階段**：f-string + 明確單位。

這三步驟固定下來，程式可讀性會明顯提升。

## 章末練習

- 必做：做一個「薪資試算」小程式，輸入時薪與工時，輸出本月薪資（保留 2 位小數）。
- 必做：做一個「溫度轉換」程式，輸入攝氏，輸出華氏。
- 選做：讓程式在輸入錯誤時，提示使用者重新輸入（可先用 `while`，下一章會更完整）。

## 本章重點回顧

- `input()` 回傳永遠是字串，型別轉換是必要步驟。
- `print()` 的 `sep`、`end` 能讓輸出更符合需求。
- f-string 是最推薦的格式化方式，清楚又強大。
