# 03｜變數與基本資料型別

> 這章是 Python 基礎中的基礎。你會學會如何「存資料、讀資料、轉型別」，並理解程式為什麼常因型別不一致而出錯。

## 學習目標

- 理解變數的意義與命名規則。
- 能分辨並使用 `int`、`float`、`str`、`bool`、`None`。
- 了解動態型別的優點與常見風險。
- 能完成常見型別轉換並排除錯誤。

## 前置條件

- 已完成 `02` 章，會建立 `.py` 檔案並執行。
- 知道 `print()` 與 `input()` 的基本使用。

## 變數是什麼

變數可以想成「有名字的資料」。  
你把資料放進一個名稱，之後程式就能透過這個名稱重複使用它。

```python
name = "Gary"
age = 18
height = 172.5
```

- `name`、`age`、`height` 是變數名稱。
- 等號 `=` 在程式中是「指派」，不是數學上的等於。

## 變數命名規則（務必遵守）

### 合法規則

- 只能由英文字母、數字、底線組成。
- 不可用數字開頭（例如 `1name` 不合法）。
- 區分大小寫（`age` 與 `Age` 是不同變數）。
- 不可使用關鍵字（如 `if`、`for`、`class`）。

### 慣例（團隊可讀性）

- 使用 `snake_case`：例如 `user_name`、`total_price`。
- 名稱要有意義，不要用 `a`、`x1` 這類難懂命名。

## Python 的動態型別

Python 不需要先宣告型別，會在執行時決定變數型別。

```python
value = 10
print(type(value))  # <class 'int'>

value = "ten"
print(type(value))  # <class 'str'>
```

### 優點

- 寫程式快，原型開發效率高。

### 風險

- 型別錯誤常在執行時才出現，需要更注意測試與除錯。

## 基本資料型別總覽

## 1) `int`：整數

```python
count = 42
temperature = -3
```

常見用途：計數、索引、整數運算。

## 2) `float`：浮點數

```python
price = 99.9
pi = 3.14159
```

常見用途：價格、比例、量測值。  
注意：浮點數有精度問題，金額場景可考慮 `decimal`（後續章節補充）。

## 3) `str`：字串

```python
message = "Hello"
city = 'Taipei'
```

常見用途：文字資料、ID、路徑、輸入內容。

## 4) `bool`：布林值

```python
is_active = True
is_admin = False
```

常見用途：條件判斷、狀態開關。

## 5) `None`：空值

```python
result = None
```

表示「目前沒有值」或「尚未設定」。

## 型別檢查與基本運算

```python
age = 20
name = "Amy"
is_student = True

print(type(age))         # <class 'int'>
print(type(name))        # <class 'str'>
print(type(is_student))  # <class 'bool'>
```

## 型別轉換（最常用）

### `str` -> `int`

```python
raw = "18"
age = int(raw)
print(age + 1)  # 19
```

### `str` -> `float`

```python
raw = "3.5"
value = float(raw)
print(value * 2)  # 7.0
```

### 數字 -> 字串

```python
score = 95
text = str(score)
print("分數：" + text)
```

### 轉布林值注意點

```python
print(bool(0))      # False
print(bool(1))      # True
print(bool(""))     # False
print(bool("hi"))   # True
```

空值通常是 False，非空值通常是 True。

## 常見錯誤示範（一定會遇到）

### 錯誤 1：字串和整數直接相加

```python
age = "18"
print(age + 1)  # TypeError
```

修正：

```python
age = "18"
print(int(age) + 1)
```

### 錯誤 2：把含文字的字串轉成數字

```python
raw = "18歲"
age = int(raw)  # ValueError
```

修正策略：先清理資料，再轉型別。

### 錯誤 3：變數覆蓋造成語意混亂

```python
price = 100
price = "100元"
```

同一變數代表兩種型別，後續維護很容易出錯。  
建議分開命名：`price` 與 `price_text`。

## 小練習：用變數描述自己

請建立 `src/profile.py`：

```python
name = "你的名字"
age = 25
height = 170.2
is_engineer = True

print("姓名:", name)
print("年齡:", age)
print("身高:", height)
print("是否為工程師:", is_engineer)
```

再嘗試：

- 把 `age` 改成字串，觀察可能的運算錯誤。
- 用 `type()` 印出每個變數型別。

## 實務建議：少犯錯的寫法

- 從輸入進來的值，先假設是字串，再做轉換與驗證。
- 變數命名要反映型別與用途，例如 `user_count`、`is_valid`。
- 重要資料可在關鍵位置印出 `type()` 協助除錯。

## 章末練習

- 必做：讀取使用者輸入的「年齡」與「體重」，轉換成數字後計算兩者總和。
- 必做：建立 5 個不同型別變數並用 `type()` 印出型別。
- 選做：嘗試輸入非法值（如 `abc`）並觀察錯誤，寫下原因。

## 本章重點回顧

- 變數是帶名字的資料容器，命名規則與可讀性很重要。
- 你掌握了 Python 5 種常見基本型別與使用時機。
- 型別轉換是初學最常用技能，也是最常見錯誤來源。
