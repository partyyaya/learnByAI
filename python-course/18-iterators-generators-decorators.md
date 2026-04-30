# 18｜迭代器、生成器、裝飾器

> 這章會讓你理解 Python 很有代表性的進階語言特性。學完後你會寫出更省記憶體、更可重用的流程，也能看懂大量第三方套件的設計。

## 學習目標

- 理解 iterable 與 iterator 的差異。
- 能使用 `iter()`、`next()` 與自訂迭代器概念。
- 熟悉生成器（`yield`）與其節省記憶體特性。
- 了解裝飾器（decorator）本質並能寫簡單實用範例。

## 前置條件

- 已完成函式與 OOP 基礎章節。

## iterable vs iterator

### Iterable（可迭代物件）

- 可以被 `for` 迴圈遍歷。
- 例如 `list`、`tuple`、`dict`、`str`。

### Iterator（迭代器）

- 具備 `__next__()`，每次取下一個值。
- 取完會拋 `StopIteration`。

```python
nums = [10, 20, 30]
it = iter(nums)

print(next(it))  # 10
print(next(it))  # 20
print(next(it))  # 30
```

## 為什麼要理解這個

很多 Python API（檔案讀取、itertools、生成器）都建立在迭代協定上。  
懂迭代器，你就能掌握 Python 資料流核心。

## 生成器（Generator）基礎

使用 `yield` 的函式會回傳生成器物件。

```python
def count_up_to(n: int):
    i = 1
    while i <= n:
        yield i
        i += 1


for x in count_up_to(3):
    print(x)
```

### 生成器特性

- 惰性計算（需要時才產生下一個值）。
- 不一次把所有資料載入記憶體。
- 適合大資料流與串流處理。

## 生成器表達式

```python
squares = (x * x for x in range(5))
print(next(squares))  # 0
print(next(squares))  # 1
```

語法像 list comprehension，但用 `()`，結果是生成器。

## 生成器 vs list 的記憶體差異（觀念）

- `list`：一次建好全部資料。
- `generator`：逐步產生資料。

在大規模資料處理下，生成器可明顯降低記憶體壓力。

## 實務範例：逐行過濾檔案

```python
from pathlib import Path


def error_lines(path: Path):
    with path.open("r", encoding="utf-8") as f:
        for line in f:
            if "ERROR" in line:
                yield line.strip()


for line in error_lines(Path("app.log")):
    print(line)
```

這種寫法可避免一次把整份 log 載入記憶體。

## 裝飾器本質：函式包函式

裝飾器是「接收函式，回傳新函式」的語法糖。

```python
def my_decorator(func):
    def wrapper():
        print("before")
        func()
        print("after")
    return wrapper


@my_decorator
def hello():
    print("hello")
```

`@my_decorator` 等價於 `hello = my_decorator(hello)`。

## 帶參數與回傳值的裝飾器

```python
from functools import wraps


def log_call(func):
    @wraps(func)
    def wrapper(*args, **kwargs):
        print(f"calling {func.__name__}")
        result = func(*args, **kwargs)
        print(f"done {func.__name__}")
        return result
    return wrapper


@log_call
def add(a, b):
    return a + b


print(add(2, 3))
```

`@wraps` 可保留原函式名稱與文件資訊，實務上建議一定加。

## 帶設定的裝飾器（decorator factory）

```python
from functools import wraps


def repeat(times: int):
    def decorator(func):
        @wraps(func)
        def wrapper(*args, **kwargs):
            result = None
            for _ in range(times):
                result = func(*args, **kwargs)
            return result
        return wrapper
    return decorator


@repeat(3)
def greet(name: str):
    print(f"Hi, {name}")
```

## 常見裝飾器應用

- 日誌記錄（function call logging）
- 執行時間測量
- 權限驗證
- 快取（memoization）
- 重試機制（retry）

## 常見錯誤與排查

### 錯誤 1：生成器只能消耗一次

用完後要重新建立，否則不會再有資料。

### 錯誤 2：裝飾器忘記回傳 wrapper

會造成函式變成 `None`。

### 錯誤 3：裝飾器沒處理 `*args/**kwargs`

容易限制原函式可用性。  
修正：通用 wrapper 幾乎都要接 `*args, **kwargs`。

## 章末練習

- 必做：寫一個生成器，輸出 1 到 n 的偶數。
- 必做：寫一個 `@timer` 裝飾器，輸出函式耗時。
- 選做：寫一個讀取 CSV 的生成器，每次回傳一列 dict。

## 本章重點回顧

- 迭代器是 Python 資料流核心。
- 生成器讓你以低記憶體處理大量資料。
- 裝飾器能優雅地為函式加上橫切能力（log、監控、權限等）。
