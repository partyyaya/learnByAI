# 16｜物件導向進階：繼承、多型、組合

> 這章會把 OOP 推進到實務層級。你會學到如何擴充既有類別、抽象共同行為，並知道什麼時候該用組合而不是繼承。

## 學習目標

- 理解繼承（inheritance）與方法覆寫（override）。
- 能用 `super()` 正確呼叫父類別邏輯。
- 了解多型（polymorphism）帶來的擴充性。
- 分辨「繼承 vs 組合」的使用時機。

## 前置條件

- 已完成 `15` 章（OOP 基礎）。

## 繼承：重用既有類別能力

```python
class Animal:
    def __init__(self, name: str):
        self.name = name

    def speak(self) -> str:
        return "..."


class Dog(Animal):
    def speak(self) -> str:
        return "Woof!"
```

`Dog` 繼承 `Animal`，並覆寫 `speak()`。

## `super()`：延用父類別初始化

```python
class Employee:
    def __init__(self, name: str):
        self.name = name


class Engineer(Employee):
    def __init__(self, name: str, skill: str):
        super().__init__(name)
        self.skill = skill
```

建議在子類別中用 `super()`，避免重複寫父類初始化邏輯。

## 方法覆寫（Override）

```python
class Notification:
    def send(self, message: str):
        print(f"一般通知: {message}")


class EmailNotification(Notification):
    def send(self, message: str):
        print(f"[Email] {message}")
```

這讓子類別可保留相同介面、實作不同細節。

## 多型（Polymorphism）

不同物件只要提供相同方法，呼叫端就可用相同方式操作。

```python
def notify_all(channels, message: str):
    for ch in channels:
        ch.send(message)
```

`channels` 可以混合 Email、SMS、Slack 類別，只要有 `send()` 即可。

## 抽象基底類別（ABC）入門

可明確規範子類別必須實作哪些方法。

```python
from abc import ABC, abstractmethod


class Payment(ABC):
    @abstractmethod
    def pay(self, amount: float) -> None:
        pass


class CreditCardPayment(Payment):
    def pay(self, amount: float) -> None:
        print(f"信用卡付款 {amount}")
```

若子類別未實作抽象方法，無法被實例化。

## 組合（Composition）：常比繼承更彈性

「has-a」關係通常適合組合，「is-a」關係才考慮繼承。

```python
class Engine:
    def start(self):
        print("Engine started")


class Car:
    def __init__(self, engine: Engine):
        self.engine = engine

    def start(self):
        self.engine.start()
        print("Car ready")
```

`Car` 不是 `Engine`，而是擁有一個 `Engine`。

## 何時用繼承，何時用組合

### 使用繼承

- 明確「是同一類型」關係（`Dog` 是 `Animal`）。
- 子類別和父類別介面高度一致。

### 使用組合

- 功能可替換（例如不同付款策略、不同儲存策略）。
- 希望低耦合、易測試、易擴充。

## 多重繼承（先理解風險）

Python 支援多重繼承，但可能造成 MRO（方法解析順序）複雜。  
新手與一般商務專案通常優先用組合，必要時才用多重繼承。

## 特殊方法（dunder methods）入門

```python
class Vector:
    def __init__(self, x, y):
        self.x = x
        self.y = y

    def __add__(self, other):
        return Vector(self.x + other.x, self.y + other.y)

    def __repr__(self):
        return f"Vector({self.x}, {self.y})"
```

讓你的類別可與 Python 語言特性更自然整合。

## 實務範例：支付策略設計

```python
from abc import ABC, abstractmethod


class PaymentStrategy(ABC):
    @abstractmethod
    def pay(self, amount: float) -> None:
        pass


class LinePay(PaymentStrategy):
    def pay(self, amount: float) -> None:
        print(f"Line Pay 扣款 {amount}")


class CreditCard(PaymentStrategy):
    def pay(self, amount: float) -> None:
        print(f"信用卡扣款 {amount}")


class CheckoutService:
    def __init__(self, strategy: PaymentStrategy):
        self.strategy = strategy

    def checkout(self, amount: float):
        self.strategy.pay(amount)
```

這是「多型 + 組合」很典型的商務實作方式。

## 常見錯誤與排查

### 錯誤 1：子類別忘記呼叫 `super().__init__`

父類必要屬性未初始化，後續會 `AttributeError`。

### 錯誤 2：只為重用幾行程式碼就硬用繼承

導致層級混亂。  
修正：優先考慮組合或提取共用函式。

### 錯誤 3：覆寫方法時改壞介面

若父類 `send(message)`，子類改成 `send(message, user)` 會破壞多型一致性。

## 章末練習

- 必做：建立 `Shape` 抽象類別，實作 `Circle`、`Rectangle` 的 `area()`。
- 必做：建立通知系統（Email、SMS）並以同一函式批次發送。
- 選做：將你既有專案中的某段 `if/elif` 分支改成策略類別。

## 本章重點回顧

- 繼承用來表達「is-a」，組合用來表達「has-a」。
- 多型能讓系統在不修改呼叫端的情況下擴充新行為。
- 實務上多數情境優先組合，必要時再用繼承，設計會更穩定。
