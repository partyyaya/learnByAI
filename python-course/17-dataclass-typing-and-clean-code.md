# 17｜dataclass、型別提示與可維護程式碼

> 這章會讓你把程式從「能跑」提升到「好維護」。你會學到 dataclass、typing 與 clean code 基本原則，這些都是職場實務高頻要求。

## 學習目標

- 理解 `@dataclass` 如何簡化資料模型程式碼。
- 熟悉 `typing` 常用型別與函式註記。
- 能用型別提示提升工具檢查與可讀性。
- 掌握幾個高價值的 clean code 原則。

## 前置條件

- 已完成 OOP 章節（`15`、`16`）。

## 為什麼要學這章

- 專案越大，閱讀與維護成本比寫新功能更高。
- dataclass 讓資料模型簡潔。
- typing 讓錯誤更早被發現。
- clean code 讓團隊協作效率提高。

## dataclass 基本用法

```python
from dataclasses import dataclass


@dataclass
class User:
    name: str
    age: int
    email: str
```

這樣就會自動產生：

- `__init__`
- `__repr__`
- `__eq__`（可比較內容）

比手寫類別更精簡。

## dataclass 預設值與 `default_factory`

```python
from dataclasses import dataclass, field


@dataclass
class Cart:
    owner: str
    items: list[str] = field(default_factory=list)
```

### 為什麼不用 `items=[]`

因為可變預設值會被共享。  
`default_factory=list` 可確保每個物件拿到獨立 list。

## `frozen=True`：不可變資料模型

```python
from dataclasses import dataclass


@dataclass(frozen=True)
class Point:
    x: int
    y: int
```

適合配置資料、事件資料等不希望被修改的場景。

## dataclass + 行為方法

dataclass 不只存資料，也可定義方法：

```python
from dataclasses import dataclass


@dataclass
class Product:
    name: str
    price: float
    quantity: int

    def subtotal(self) -> float:
        return self.price * self.quantity
```

## typing 基礎：函式簽名

```python
def calc_total(prices: list[float]) -> float:
    return sum(prices)
```

這會讓 IDE 與型別檢查工具更早提醒錯誤。

## 常用 typing 型別

- `list[int]`
- `dict[str, int]`
- `tuple[int, int]`
- `set[str]`
- `Optional[str]`（可能是 `str` 或 `None`）
- `Union[int, float]`（多種可接受型別）

```python
from typing import Optional, Union


def parse_price(raw: str) -> Optional[float]:
    raw = raw.strip()
    if not raw:
        return None
    return float(raw)


def add(a: Union[int, float], b: Union[int, float]) -> float:
    return float(a + b)
```

## `TypedDict`：給 dict 加結構（入門）

```python
from typing import TypedDict


class UserData(TypedDict):
    name: str
    age: int


def format_user(user: UserData) -> str:
    return f"{user['name']} ({user['age']})"
```

適合與 JSON/dict 資料打交道時提升結構清晰度。

## Clean Code 核心原則（實務版）

### 1) 命名要表意，不要縮寫過度

- 好：`calculate_total_price`
- 差：`ctp`

### 2) 函式小而單一職責

- 一個函式最好只做一件主要事情。

### 3) 避免魔法數字

```python
DISCOUNT_RATE = 0.1
final = price * (1 - DISCOUNT_RATE)
```

### 4) 早回傳（early return）降低巢狀層級

```python
def validate_age(age: int) -> bool:
    if age < 0:
        return False
    if age > 120:
        return False
    return True
```

### 5) 把 I/O 與商業邏輯分開

- 輸入輸出放邊界層。
- 計算規則放純函式，方便測試。

## 重構範例：從雜亂到清楚

### 重構前（過度耦合）

```python
def run():
    raw = input("Price:")
    if raw != "":
        p = float(raw)
        if p > 1000:
            print(p * 0.9)
        else:
            print(p)
```

### 重構後（職責清楚）

```python
def parse_price(raw: str) -> float:
    return float(raw.strip())


def apply_discount(price: float) -> float:
    if price > 1000:
        return price * 0.9
    return price


def main():
    raw = input("Price:")
    price = parse_price(raw)
    final = apply_discount(price)
    print(final)
```

## 常見錯誤與排查

### 錯誤 1：型別提示與實際行為不一致

例如標 `-> int` 卻回傳字串。  
修正：保持註記與實作一致。

### 錯誤 2：dataclass 欄位使用可變預設值

修正：使用 `field(default_factory=...)`。

### 錯誤 3：過度追求「完美架構」

先確保可讀與可測，再逐步重構，不需一次到位。

## 章末練習

- 必做：把一個現有 dict 模型改寫成 `@dataclass`。
- 必做：為 5 個你常用函式補上型別提示。
- 選做：挑一個 50 行以上檔案，做一次 clean code 重構（命名、拆函式、常數化）。

## 本章重點回顧

- dataclass 可快速建立乾淨的資料模型。
- typing 幫你更早發現錯誤，並提升團隊溝通效率。
- clean code 不只美觀，是長期維護與協作的核心能力。
