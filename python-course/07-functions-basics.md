# 07｜函式基礎：把程式寫成可重用的積木

> 到這章開始，你會從「一段很長的程式」進化成「可以重複使用、可維護的模組化程式」。函式是工程能力的第一道門檻。

## 學習目標

- 理解函式存在的目的與價值。
- 能定義函式、傳入參數、回傳結果。
- 了解區域變數與函式作用域。
- 能把重複邏輯抽成可重用函式。

## 前置條件

- 已完成 `06` 章，會用條件與迴圈解題。

## 為什麼要用函式

如果你發現同一段程式碼複製貼上超過 2 次，就該考慮抽成函式。

函式的價值：

- **降低重複**：一次修改，多處生效。
- **提高可讀性**：透過名稱表達意圖。
- **便於測試**：小函式更容易驗證正確性。

## 函式基本語法

```python
def add(a, b):
    return a + b


result = add(3, 5)
print(result)  # 8
```

### 組成元素

- `def`：宣告函式。
- 函式名稱：如 `add`。
- 參數：`a`, `b`。
- `return`：回傳值給呼叫者。

## 參數與引數

- **參數（parameter）**：函式定義時的變數名稱。
- **引數（argument）**：呼叫函式時實際傳入的值。

```python
def greet(name):   # name 是參數
    return f"Hi, {name}"


msg = greet("Amy")  # "Amy" 是引數
print(msg)
```

## `return` 與 `print` 的差異

- `print()`：只是印在畫面上。
- `return`：把值交還給呼叫者，讓後續程式可繼續使用。

```python
def bad_add(a, b):
    print(a + b)


def good_add(a, b):
    return a + b


x = good_add(2, 3)
print(x * 10)  # 50
```

## 無回傳值的函式

如果函式沒有 `return`，預設回傳 `None`。

```python
def say_hello():
    print("Hello")


result = say_hello()
print(result)  # None
```

## 區域變數與作用域（scope）

函式內部變數通常只在函式內可用。

```python
def demo():
    message = "inside"
    print(message)


demo()
# print(message)  # NameError
```

這個特性可避免不同區塊互相污染資料。

## 為函式加上型別提示（入門）

```python
def calc_tax(amount: float, rate: float) -> float:
    return amount * rate
```

型別提示不會強制執行，但能提升可讀性與工具提示品質。

## Docstring：替函式加說明

```python
def calc_bmi(weight: float, height: float) -> float:
    """計算 BMI，回傳浮點數結果。"""
    return weight / (height ** 2)
```

好處：未來自己或同事一看就知道函式用途。

## 範例：把長流程拆成函式

需求：輸入分數，輸出等級。

```python
def parse_score(raw: str) -> int:
    return int(raw.strip())


def get_grade(score: int) -> str:
    if score >= 90:
        return "A"
    if score >= 80:
        return "B"
    if score >= 70:
        return "C"
    if score >= 60:
        return "D"
    return "F"


def main():
    raw = input("請輸入分數：")
    score = parse_score(raw)
    grade = get_grade(score)
    print(f"等級：{grade}")


if __name__ == "__main__":
    main()
```

### 為什麼這樣拆比較好

- 解析輸入、商業規則、互動流程各自獨立。
- 未來要改等級規則時，只改 `get_grade()`。

## 常見錯誤與排查

### 錯誤 1：忘記 `return`

```python
def add(a, b):
    a + b
```

呼叫後得到 `None`。  
修正：明確寫 `return a + b`。

### 錯誤 2：參數數量不一致

```python
def add(a, b):
    return a + b

add(1)  # TypeError
```

修正：確認呼叫端引數數量與函式定義一致。

### 錯誤 3：函式做太多事

一個函式同時處理輸入、驗證、運算、輸出，會很難維護。  
修正：依責任拆小函式。

## 實務建議：函式設計 3 原則

- **一個函式一個主要責任**。
- **名稱要像句子，能看出用途**（如 `calculate_total`）。
- **優先回傳值，不要過度依賴全域變數**。

## 章末練習

- 必做：寫 `is_even(n)`，判斷是否偶數並回傳布林值。
- 必做：寫 `calculate_discount(price, rate)`，回傳折扣後價格。
- 選做：把你在第 6 章的一個迴圈題目改寫成「至少 2 個函式」版本。

## 本章重點回顧

- 函式讓程式碼可重用、可讀、可測試。
- `return` 是函式真正的輸出機制，不只是 `print()`。
- 學會拆函式，是從新手邁向工程實作最關鍵的一步。
