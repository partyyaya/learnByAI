# 15｜物件導向基礎（OOP Basics）

> 這章會讓你從「資料 + 函式分開」進化到「資料與行為打包在一起」。OOP 是中大型專案常見的建模方式。

## 學習目標

- 理解類別（class）與物件（object）的關係。
- 能設計屬性（attribute）與方法（method）。
- 熟悉 `__init__`、`self`、實例變數與類別變數。
- 能把真實需求轉成基本類別模型。

## 前置條件

- 已完成函式、模組與資料結構章節。

## 為什麼需要 OOP

當程式變大，單靠函式可能會遇到：

- 狀態分散在各處，難追蹤。
- 功能與資料脫節，維護成本上升。

OOP 把「資料（狀態）」與「操作（行為）」放在一起，讓程式結構更貼近真實世界。

## 類別與物件

- **類別（class）**：藍圖或規格。
- **物件（object/instance）**：依藍圖建立的實體。

```python
class User:
    pass


u1 = User()
u2 = User()
print(type(u1))  # <class '__main__.User'>
```

## `__init__`：初始化物件

```python
class User:
    def __init__(self, name: str, age: int):
        self.name = name
        self.age = age


u = User("Amy", 20)
print(u.name)  # Amy
```

- `self` 代表「當前物件本身」。
- `self.name` 是每個物件自己的屬性。

## 定義方法（method）

```python
class User:
    def __init__(self, name: str):
        self.name = name

    def greet(self) -> str:
        return f"Hi, I am {self.name}"


u = User("Ben")
print(u.greet())
```

方法本質上是綁定在類別上的函式。

## 實例變數 vs 類別變數

```python
class Product:
    tax_rate = 0.05  # 類別變數（所有物件共享）

    def __init__(self, name: str, price: float):
        self.name = name      # 實例變數
        self.price = price


p1 = Product("Keyboard", 1200)
p2 = Product("Mouse", 800)

print(p1.tax_rate, p2.tax_rate)
```

## `__repr__`：讓除錯輸出更友善

```python
class Product:
    def __init__(self, name: str, price: float):
        self.name = name
        self.price = price

    def __repr__(self) -> str:
        return f"Product(name={self.name!r}, price={self.price!r})"
```

加上後，`print(product)` 的可讀性會更好。

## 封裝（Encapsulation）入門

Python 沒有嚴格私有，但有慣例：

- `_name`：表示內部使用，不建議外部直接依賴。
- `__name`：名稱改寫（name mangling），增加外部直接存取難度。

```python
class BankAccount:
    def __init__(self, balance: float):
        self._balance = balance

    def deposit(self, amount: float):
        if amount <= 0:
            raise ValueError("amount 必須大於 0")
        self._balance += amount

    def get_balance(self) -> float:
        return self._balance
```

## 實作範例：購物車類別

```python
class Cart:
    def __init__(self):
        self.items = []

    def add_item(self, name: str, price: float):
        self.items.append({"name": name, "price": price})

    def total(self) -> float:
        return sum(item["price"] for item in self.items)


cart = Cart()
cart.add_item("Book", 300)
cart.add_item("Pen", 50)
print(f"總價: {cart.total()}")
```

這個例子顯示「狀態（items）」與「行為（add/total）」放在同一個物件裡。

## 類別方法與靜態方法（先入門）

```python
class User:
    count = 0

    def __init__(self, name: str):
        self.name = name
        User.count += 1

    @classmethod
    def get_count(cls):
        return cls.count

    @staticmethod
    def is_valid_name(name: str) -> bool:
        return len(name.strip()) >= 2
```

- `@classmethod` 常用於操作類別狀態。
- `@staticmethod` 常用於與類別相關但不需物件狀態的工具函式。

## 常見錯誤與排查

### 錯誤 1：忘記在方法第一個參數放 `self`

會 `TypeError`。  
修正：實例方法第一個參數必須是 `self`。

### 錯誤 2：在類別中誤用全域變數

應使用 `self.xxx` 或 `ClassName.xxx` 明確指出來源。

### 錯誤 3：類別職責過大

一個類別同時做太多事會難維護。  
修正：依責任拆分類別。

## 何時適合用 OOP

- 你有多個「有狀態的實體」要管理（使用者、訂單、商品）。
- 行為跟資料高度綁定。
- 專案會長期維護、多人協作。

若只是一次性資料轉換腳本，函式式寫法可能更簡潔。

## 章末練習

- 必做：建立 `Student` 類別（姓名、分數），新增 `is_passed()` 方法。
- 必做：建立 `BankAccount` 類別，支援存款、提款、查詢餘額。
- 選做：為你的類別加上 `__repr__`，讓輸出更可讀。

## 本章重點回顧

- 類別是藍圖，物件是實例。
- OOP 核心是把資料與行為封裝在一起。
- 你已可建立基本可維護的類別模型，下一章會進到繼承與多型。
