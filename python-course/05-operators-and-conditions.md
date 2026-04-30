# 05｜運算子與條件判斷

> 這章會讓你的程式「會思考」。你將用運算子表達規則，再用 `if/elif/else` 做流程分支，建立真正有邏輯的程式。

## 學習目標

- 熟悉算術、比較、邏輯、指派運算子。
- 了解真值（truthy/falsy）與條件判斷的關係。
- 能正確使用 `if/elif/else` 實作商業規則。
- 避免條件判斷常見錯誤（優先順序、邊界值、型別混用）。

## 前置條件

- 已完成 `03`、`04` 章（型別、輸入輸出）。

## 算術運算子（數值計算）

```python
a = 10
b = 3

print(a + b)   # 13
print(a - b)   # 7
print(a * b)   # 30
print(a / b)   # 3.333...
print(a // b)  # 3   (整除)
print(a % b)   # 1   (餘數)
print(a ** b)  # 1000
```

## 比較運算子（產生布林值）

```python
x = 10
print(x > 5)    # True
print(x >= 10)  # True
print(x < 3)    # False
print(x == 10)  # True
print(x != 10)  # False
```

### 重點提醒

- `==` 是比較是否相等。
- `=` 是指派值，兩者不可混淆。

## 邏輯運算子（組合條件）

```python
age = 20
has_ticket = True

print(age >= 18 and has_ticket)  # True
print(age < 18 or has_ticket)    # True
print(not has_ticket)            # False
```

- `and`：全部為真才真。
- `or`：任一為真就真。
- `not`：反轉真假。

## 指派運算子（簡寫）

```python
count = 5
count += 2  # count = count + 2
count *= 3  # count = count * 3
print(count)  # 21
```

## 成員與身份運算子（常用）

### `in` / `not in`

```python
name = "python"
print("py" in name)      # True
print("java" not in name)  # True
```

### `is` / `is not`

- `is` 比的是「是否同一個物件」。
- 一般值比較請用 `==`，不要濫用 `is`。

## 條件判斷：`if/elif/else`

```python
score = 85

if score >= 90:
    print("A")
elif score >= 80:
    print("B")
elif score >= 70:
    print("C")
else:
    print("D or below")
```

### 執行規則

- 由上而下判斷。
- 第一個符合的分支會執行，後面分支不再檢查。

## 真值（truthy / falsy）

在 Python 中，不一定要寫出 `== True`。

```python
if "":          # 空字串 -> False
    print("A")

if [1, 2, 3]:   # 非空 list -> True
    print("B")
```

### 常見 falsy 值

- `0`
- `0.0`
- `""`（空字串）
- `[]`、`{}`、`set()`（空容器）
- `None`

## 條件判斷實作範例：運費規則

需求：

- 訂單金額 `>= 1000` 免運。
- 否則若會員等級為 `gold`，運費 `30`。
- 其他運費 `60`。

```python
amount = 850
level = "gold"

if amount >= 1000:
    shipping_fee = 0
elif level == "gold":
    shipping_fee = 30
else:
    shipping_fee = 60

print(f"運費: {shipping_fee}")
```

## 條件順序很重要（邊界值陷阱）

錯誤寫法：

```python
score = 95
if score >= 60:
    print("及格")
elif score >= 90:
    print("優秀")
```

`score >= 90` 永遠不會被執行。  
修正：把更嚴格條件放前面。

## 簡潔寫法：三元運算式

```python
age = 18
status = "成人" if age >= 18 else "未成年"
print(status)
```

適合簡單分支；若邏輯複雜，請維持一般 `if/elif/else` 可讀性更好。

## 常見錯誤與排查

### 錯誤 1：把 `=` 寫在條件裡

- `if score = 90:` 是語法錯誤。
- 應改成 `if score == 90:`。

### 錯誤 2：字串比較數字

```python
score = input("分數：")  # str
if score >= 60:          # TypeError
    ...
```

修正：先 `int(score)`。

### 錯誤 3：條件太長難維護

- 可拆成中介變數，例如 `is_vip = level in ["gold", "platinum"]`。

## 章末練習

- 必做：輸入年齡，判斷「兒童 / 青少年 / 成人」。
- 必做：輸入金額與是否會員，依規則計算折扣後金額。
- 選做：輸入三邊長，判斷是否可構成三角形（提示：任兩邊和大於第三邊）。

## 本章重點回顧

- 運算子是邏輯判斷的語言，`if/elif/else` 是流程控制核心。
- 真值觀念能讓程式更精簡，但要避免可讀性過低。
- 條件順序與邊界值檢查，是寫對商業規則的關鍵。
