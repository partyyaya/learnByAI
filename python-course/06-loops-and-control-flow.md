# 06｜迴圈與流程控制

> 這章會讓程式「重複做事」而不是只跑一次。你會學會 `for`、`while`、`break`、`continue`，並建立處理批次資料的基礎能力。

## 學習目標

- 能用 `for` 與 `while` 完成重複任務。
- 理解 `range()`、`enumerate()`、`zip()` 常見用法。
- 能正確使用 `break`、`continue`、`pass` 控制流程。
- 避免無限迴圈與巢狀迴圈常見錯誤。

## 前置條件

- 已完成 `05` 章，會使用條件判斷。

## 為什麼需要迴圈

沒有迴圈時，你可能要重複寫很多相似程式碼。  
有了迴圈，就能用一段程式處理多筆資料。

## `for` 迴圈：遍歷序列最常用

```python
fruits = ["apple", "banana", "orange"]

for fruit in fruits:
    print(fruit)
```

`for` 非常適合處理清單、字串、字典等可迭代物件。

## `range()`：建立數字序列

```python
for i in range(5):
    print(i)  # 0, 1, 2, 3, 4
```

### 三種常見形式

- `range(stop)`：從 0 到 `stop - 1`
- `range(start, stop)`：從 `start` 到 `stop - 1`
- `range(start, stop, step)`：每次跳 `step`

```python
for i in range(2, 10, 2):
    print(i)  # 2, 4, 6, 8
```

## `while` 迴圈：條件式重複

```python
count = 0

while count < 3:
    print(count)
    count += 1
```

`while` 常用在「不知道要跑幾次，只知道何時停止」的情境。

## `break`、`continue`、`pass`

### `break`：立刻離開迴圈

```python
for n in range(10):
    if n == 5:
        break
    print(n)
```

### `continue`：跳過本次，進入下一輪

```python
for n in range(6):
    if n % 2 == 0:
        continue
    print(n)  # 1, 3, 5
```

### `pass`：暫時不做事（占位）

```python
for n in range(3):
    if n == 1:
        pass
    print(n)
```

## `enumerate()`：同時拿索引與值

```python
students = ["Amy", "Ben", "Cathy"]

for idx, name in enumerate(students, start=1):
    print(idx, name)
```

很適合列清單、排名、序號輸出。

## `zip()`：平行遍歷多個序列

```python
names = ["Amy", "Ben", "Cathy"]
scores = [90, 80, 95]

for name, score in zip(names, scores):
    print(f"{name}: {score}")
```

## 巢狀迴圈（nested loop）

```python
for i in range(1, 4):
    for j in range(1, 4):
        print(i, j)
```

可處理矩陣、表格、配對問題。  
但巢狀過深會降低可讀性，也可能影響效能。

## 迴圈搭配條件判斷：實務範例

需求：輸入 5 個分數，計算平均，並找出不及格分數數量。

```python
total = 0
fail_count = 0

for i in range(5):
    score = int(input(f"請輸入第 {i + 1} 筆分數："))
    total += score
    if score < 60:
        fail_count += 1

avg = total / 5
print(f"平均分數: {avg:.2f}")
print(f"不及格人數: {fail_count}")
```

## 常見錯誤與排查

### 錯誤 1：`while` 忘記更新變數

```python
count = 0
while count < 5:
    print(count)  # 忘了 count += 1
```

會造成無限迴圈。  
修正：確認每輪都有推進條件的變數更新。

### 錯誤 2：修改遍歷中的容器

在遍歷 `list` 時直接刪除元素，容易出現漏處理。  
建議先建立新清單或倒序處理。

### 錯誤 3：`break` 放錯位置

`break` 只會跳出「當前」那層迴圈，巢狀迴圈要特別注意。

## 實務建議：寫出可讀迴圈

- 每個迴圈只做一個主要任務（計數、過濾、聚合）。
- 變數命名清楚，例如 `total_price`、`valid_count`。
- 若迴圈超過 15 到 20 行，考慮拆成函式。

## 章末練習

- 必做：輸入 10 個整數，計算其中偶數總和。
- 必做：用 `while` 寫一個簡易密碼檢查，輸入正確才結束。
- 選做：輸出九九乘法表（巢狀迴圈）。

## 本章重點回顧

- `for` 用在可迭代資料，`while` 用在條件式重複。
- `break`、`continue` 能精準控制流程，但要用在對的位置。
- 迴圈是處理批次資料的核心能力，之後的資料分析與 API 任務都會用到。
