# 09｜四大容器：list、tuple、set、dict

> 這章會建立你處理資料的核心能力。選對容器，程式就會更簡單、更快、更好維護。

## 學習目標

- 了解 `list`、`tuple`、`set`、`dict` 的差異與使用時機。
- 能完成新增、查詢、修改、刪除與遍歷操作。
- 知道常見效能差異與選型原則。
- 避免「資料結構選錯」造成的程式複雜化。

## 前置條件

- 已完成 `06`、`07` 章（迴圈與函式）。

## 容器選型先記一句話

- **有順序、可重複、可修改**：`list`
- **有順序、可重複、不可修改**：`tuple`
- **無順序、不重複**：`set`
- **鍵值對對應資料**：`dict`

## 1) `list`：最常用的序列容器

```python
scores = [90, 75, 88]
print(scores[0])  # 90
```

### 常見操作

```python
scores.append(95)        # 新增
scores[1] = 80           # 修改
removed = scores.pop()   # 刪除最後一項
print(len(scores))       # 長度
```

### 切片（slicing）

```python
nums = [10, 20, 30, 40, 50]
print(nums[1:4])   # [20, 30, 40]
print(nums[:3])    # [10, 20, 30]
print(nums[::2])   # [10, 30, 50]
```

## 2) `tuple`：不可變序列

```python
point = (10, 20)
print(point[0])  # 10
```

特性：

- 建立後不可修改，適合固定資料（座標、設定值）。
- 可當 dict key（若元素可 hash）。

單元素 tuple 寫法注意：

```python
single = (5,)  # 要有逗號
```

## 3) `set`：不重複元素集合

```python
tags = {"python", "api", "python"}
print(tags)  # {'python', 'api'}（自動去重）
```

### 常見操作

```python
tags.add("backend")
tags.remove("api")
print("python" in tags)
```

### 集合運算

```python
a = {1, 2, 3}
b = {3, 4, 5}

print(a | b)  # 聯集 {1, 2, 3, 4, 5}
print(a & b)  # 交集 {3}
print(a - b)  # 差集 {1, 2}
```

## 4) `dict`：鍵值對資料結構

```python
user = {"name": "Amy", "age": 20, "city": "Taipei"}
print(user["name"])  # Amy
```

### 常見操作

```python
user["age"] = 21             # 修改
user["email"] = "a@mail.com" # 新增
del user["city"]             # 刪除
```

### 安全取值：`get()`

```python
print(user.get("phone"))          # None（不報錯）
print(user.get("phone", "N/A"))   # N/A
```

### 遍歷 dict

```python
for key, value in user.items():
    print(key, value)
```

## 實務選型範例

### 情境 1：要保留輸入順序，且可能重複

- 用 `list`

### 情境 2：儲存固定欄位資料（如座標）

- 用 `tuple`

### 情境 3：快速判斷元素是否存在、去重

- 用 `set`

### 情境 4：描述一筆實體資料（使用者、商品）

- 用 `dict`

## 綜合範例：成績統計

```python
students = [
    {"name": "Amy", "score": 90},
    {"name": "Ben", "score": 75},
    {"name": "Cathy", "score": 90},
]

total = 0
score_set = set()

for s in students:
    total += s["score"]
    score_set.add(s["score"])

avg = total / len(students)
print(f"平均: {avg:.2f}")
print(f"有幾種分數: {len(score_set)}")
```

這個例子同時用到 `list + dict + set`，是實務常見組合。

## 常見錯誤與排查

### 錯誤 1：用不存在的 key 直接取值

```python
user = {"name": "Amy"}
print(user["age"])  # KeyError
```

修正：用 `get("age")` 或先檢查 `if "age" in user:`。

### 錯誤 2：把 list 當 set 用

需要頻繁做「是否存在」判斷時，用 list 會慢且冗長。  
修正：改用 set。

### 錯誤 3：嘗試修改 tuple

```python
point = (1, 2)
point[0] = 10  # TypeError
```

tuple 是不可變，需重建新 tuple。

## 小技巧：快速去重但保留順序

```python
items = ["a", "b", "a", "c", "b"]
unique_items = list(dict.fromkeys(items))
print(unique_items)  # ['a', 'b', 'c']
```

## 章末練習

- 必做：建立一個商品 `dict`（名稱、價格、庫存），並更新庫存。
- 必做：輸入一串單字（用空白分隔），統計不重複單字數量。
- 選做：建立 `students` 清單（每筆是 dict），計算最高分與平均分。

## 本章重點回顧

- 四大容器各有最佳使用場景，選對結構能簡化 50% 以上程式複雜度。
- `dict` 與 `list` 是實務最常見組合，`set` 常用於去重與快速查找。
- 你已具備處理中小型資料結構的核心能力，能進入更高效寫法（下一章推導式）。
