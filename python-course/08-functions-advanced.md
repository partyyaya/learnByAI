# 08｜函式進階：參數技巧、作用域與常見陷阱

> 這章會讓你從「會寫函式」升級到「會設計函式」。你將學會預設參數、關鍵字參數、可變參數、作用域規則與常見陷阱。

## 學習目標

- 熟悉位置參數、關鍵字參數、預設參數的差異。
- 能使用 `*args`、`**kwargs` 設計彈性函式。
- 理解作用域（LEGB）與 `global` / `nonlocal` 的基本概念。
- 避免可變預設參數等高頻錯誤。

## 前置條件

- 已完成 `07` 章，理解函式定義與回傳值。

## 參數呼叫方式總覽

```python
def register(name, age, city="Taipei"):
    return f"{name} / {age} / {city}"


print(register("Amy", 20))
print(register(name="Ben", age=22, city="Tainan"))
```

- 前者是位置參數呼叫。
- 後者是關鍵字參數呼叫（可讀性更高）。

## 預設參數（default argument）

```python
def power(base, exp=2):
    return base ** exp


print(power(3))    # 9
print(power(3, 3)) # 27
```

### 規則

- 有預設值的參數必須放在後面。
- 預設值通常用於「常見情境」。

## 關鍵字參數（keyword argument）

```python
def create_user(name, role, active=True):
    return {"name": name, "role": role, "active": active}


user = create_user(name="Cathy", role="admin")
print(user)
```

好處：呼叫端一眼看出每個值的意義。

## 可變參數：`*args`

當參數數量不固定時，可用 `*args` 收集為 tuple。

```python
def total(*numbers):
    s = 0
    for n in numbers:
        s += n
    return s


print(total(1, 2, 3))       # 6
print(total(10, 20, 30, 5)) # 65
```

## 關鍵字可變參數：`**kwargs`

可收集不固定的鍵值對為 dict。

```python
def print_profile(**kwargs):
    for key, value in kwargs.items():
        print(f"{key}: {value}")


print_profile(name="Amy", age=20, city="Kaohsiung")
```

## 混合使用參數（常見順序）

常見順序是：

1. 一般位置參數
2. 預設參數
3. `*args`
4. `**kwargs`

```python
def demo(a, b=10, *args, **kwargs):
    print(a, b, args, kwargs)
```

## 作用域（LEGB）入門

Python 尋找變數的順序大致是：

- Local（函式內）
- Enclosing（外層函式）
- Global（模組層）
- Built-in（內建）

```python
x = "global"

def outer():
    x = "outer"
    def inner():
        x = "inner"
        print(x)
    inner()

outer()  # inner
```

## `global` 與 `nonlocal`（先會看懂就好）

### `global`

```python
count = 0

def increase():
    global count
    count += 1
```

### `nonlocal`

```python
def outer():
    count = 0

    def inner():
        nonlocal count
        count += 1
        return count

    return inner
```

實務上建議少用 `global`，避免狀態難追蹤。

## 高頻陷阱：可變預設參數

錯誤示範：

```python
def add_item(item, bucket=[]):
    bucket.append(item)
    return bucket
```

這個 `bucket` 會在多次呼叫間共享，常造成難查 bug。

正確寫法：

```python
def add_item(item, bucket=None):
    if bucket is None:
        bucket = []
    bucket.append(item)
    return bucket
```

## Lambda（匿名函式）入門

```python
square = lambda x: x * x
print(square(5))  # 25
```

適合短小的一次性函式（例如排序 key），不適合複雜邏輯。

## 範例：設計一個彈性折扣函式

```python
def apply_discount(price: float, rate: float = 0.1, *, round_to: int = 2) -> float:
    final = price * (1 - rate)
    return round(final, round_to)


print(apply_discount(1000))                 # 900.0
print(apply_discount(1000, 0.2))            # 800.0
print(apply_discount(1000, round_to=0))     # 900.0
```

`*` 後面的參數只能用關鍵字傳入，可提升可讀性與安全性。

## 常見錯誤與排查

### 錯誤 1：參數順序不合法

有預設值的參數放在無預設值之前會報語法錯誤。

### 錯誤 2：混用位置與關鍵字導致衝突

同一參數重複賦值會 `TypeError`。

### 錯誤 3：`*args` / `**kwargs` 過度使用

太彈性會讓 API 難懂，能明確定義就不要過度泛化。

## 章末練習

- 必做：寫 `calculate_total(*prices)`，回傳總價與平均值。
- 必做：寫 `create_product(name, **attrs)`，回傳商品資訊 dict。
- 選做：實作 `logger(message, level="INFO", **meta)`，輸出帶等級與附加資訊的文字。

## 本章重點回顧

- 你掌握了預設參數、關鍵字參數與可變參數設計。
- 你理解了作用域規則，知道 `global/nonlocal` 的用途與風險。
- 你學會避開可變預設參數這個實務上最常見陷阱之一。
