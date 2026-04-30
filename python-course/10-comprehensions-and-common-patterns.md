# 10｜推導式與常見資料處理寫法

> 這章會教你把「可讀的迴圈」進一步精簡成「簡潔又清楚的資料處理寫法」。你會學會 list/dict/set 推導式，以及排序、去重、過濾等實務高頻技巧。

## 學習目標

- 能使用 list、set、dict 推導式完成常見資料轉換。
- 理解推導式與一般迴圈的取捨。
- 熟悉排序、去重、過濾、聚合等高頻模式。
- 寫出可讀性高、維護成本低的資料處理程式。

## 前置條件

- 已完成 `06`（迴圈）與 `09`（容器）。

## 什麼是推導式（Comprehension）

推導式是一種「把迴圈 + 條件 + 產生新容器」寫在一行的語法。  
目標是提升表達力，不是盲目縮短程式。

## List Comprehension

### 基本寫法

```python
nums = [1, 2, 3, 4, 5]
squares = [n * n for n in nums]
print(squares)  # [1, 4, 9, 16, 25]
```

### 帶條件過濾

```python
evens = [n for n in nums if n % 2 == 0]
print(evens)  # [2, 4]
```

### 含 `if/else` 表達式

```python
labels = ["even" if n % 2 == 0 else "odd" for n in nums]
print(labels)  # ['odd', 'even', 'odd', 'even', 'odd']
```

## Set Comprehension

```python
names = ["Amy", "amy", "Ben", "BEN"]
normalized = {n.lower() for n in names}
print(normalized)  # {'amy', 'ben'}
```

適合做去重與正規化。

## Dict Comprehension

```python
prices = {"apple": 30, "banana": 20, "orange": 40}
discounted = {k: int(v * 0.9) for k, v in prices.items()}
print(discounted)
```

也能加條件：

```python
high_price = {k: v for k, v in prices.items() if v >= 30}
```

## 何時用推導式，何時不用

### 適合用推導式

- 1 到 2 層邏輯（轉換 + 簡單條件）。
- 重點是「產生新容器」。

### 不適合用推導式

- 巢狀層級太多。
- 邏輯需要多段判斷與錯誤處理。
- 可讀性下降時，請回到一般 `for`。

## 常見資料處理模式

## 1) 排序：`sorted()` + `key`

```python
students = [
    {"name": "Amy", "score": 90},
    {"name": "Ben", "score": 75},
    {"name": "Cathy", "score": 95},
]

by_score_desc = sorted(students, key=lambda s: s["score"], reverse=True)
print(by_score_desc)
```

## 2) 去重（有無保留順序）

```python
items = ["a", "b", "a", "c"]
unique_no_order = list(set(items))
unique_keep_order = list(dict.fromkeys(items))
```

## 3) 過濾資料

```python
passed = [s for s in students if s["score"] >= 60]
```

## 4) 聚合（總和、平均、最大最小）

```python
scores = [s["score"] for s in students]
total = sum(scores)
avg = total / len(scores)
mx = max(scores)
mn = min(scores)
```

## 5) 任何/全部判斷：`any()`、`all()`

```python
scores = [90, 80, 70]
print(any(s < 60 for s in scores))  # 是否有人不及格
print(all(s >= 60 for s in scores)) # 是否全部及格
```

## 綜合範例：訂單資料整理

```python
orders = [
    {"id": "A01", "amount": 1200, "status": "paid"},
    {"id": "A02", "amount": 500, "status": "unpaid"},
    {"id": "A03", "amount": 2200, "status": "paid"},
]

# 1) 只留已付款訂單
paid_orders = [o for o in orders if o["status"] == "paid"]

# 2) 取出金額
paid_amounts = [o["amount"] for o in paid_orders]

# 3) 統計
total_paid = sum(paid_amounts)
max_paid = max(paid_amounts)

print(f"已付款總額: {total_paid}")
print(f"最高付款金額: {max_paid}")
```

## 可讀性準則（很重要）

- 一行超過約 100 字元或語意過載，就拆行或改回普通迴圈。
- 推導式中不要塞太多巢狀條件。
- 寫給未來自己看的程式，清楚勝過炫技。

## 常見錯誤與排查

### 錯誤 1：推導式邏輯過多看不懂

修正：先寫普通 `for`，確認正確後再精簡。

### 錯誤 2：`lambda` 過度複雜

修正：改成具名函式讓邏輯可測試、可重用。

### 錯誤 3：對空清單做 `max()` / `min()`

會拋出 `ValueError`。  
修正：先判斷是否為空，或提供預設處理。

## 章末練習

- 必做：把一個整數 list 轉成平方 list，並只保留偶數平方。
- 必做：給一組姓名清單，做小寫正規化並去重。
- 選做：對 `students`（dict list）做排名，輸出前 3 名。

## 本章重點回顧

- 推導式是高效率資料轉換工具，但可讀性永遠優先。
- `sorted`、`any`、`all`、`sum` 是資料處理高頻基本功。
- 你已具備把原始資料整理成可分析結果的核心能力。
