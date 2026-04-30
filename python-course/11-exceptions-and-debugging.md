# 11｜例外處理與除錯思維

> 這章會教你面對錯誤，而不是害怕錯誤。你會學會讀 traceback、使用 `try/except`、保留正確錯誤資訊，建立可維護的除錯流程。

## 學習目標

- 理解例外（Exception）在 Python 的角色。
- 能使用 `try/except/else/finally` 安全處理錯誤。
- 能看懂 traceback 並定位錯誤根因。
- 建立一套可重複的除錯 SOP。

## 前置條件

- 已完成 `03` 到 `10`，至少寫過數個小程式。

## 什麼是例外（Exception）

當程式執行到無法繼續的狀況時，Python 會拋出例外。  
例外不是壞事，它是「錯誤訊號」，提醒你處理異常情況。

常見例外：

- `ValueError`：型別格式正確但值不合法。
- `TypeError`：型別操作不相容。
- `KeyError`：dict 取不存在的 key。
- `IndexError`：list 索引越界。
- `ZeroDivisionError`：除以 0。
- `FileNotFoundError`：檔案不存在。

## `try/except` 基本結構

```python
raw = input("請輸入整數：")

try:
    value = int(raw)
    print(value + 10)
except ValueError:
    print("輸入格式錯誤，請輸入整數。")
```

### 核心原則

- 只包住「可能出錯」的最小範圍。
- `except` 盡量捕捉具體例外類型。

## 多種例外處理

```python
try:
    data = {"name": "Amy"}
    age = int(input("年齡："))
    print(data["age"] + age)
except ValueError:
    print("年齡請輸入數字")
except KeyError:
    print("資料中缺少必要欄位")
```

## `else` 與 `finally`

```python
try:
    num = int(input("請輸入數字："))
except ValueError:
    print("格式錯誤")
else:
    print(f"輸入成功: {num}")
finally:
    print("流程結束（不論成功失敗都會執行）")
```

- `else`：只有在沒有例外時執行。
- `finally`：一定會執行，常用於清理資源（檔案、連線）。

## 主動拋出錯誤：`raise`

```python
def withdraw(balance: int, amount: int) -> int:
    if amount <= 0:
        raise ValueError("提款金額必須大於 0")
    if amount > balance:
        raise ValueError("餘額不足")
    return balance - amount
```

當輸入不符合業務規則時，主動拋例外比默默失敗更安全。

## 自訂例外（入門）

```python
class InvalidCouponError(Exception):
    pass


def apply_coupon(code: str):
    if code != "SAVE10":
        raise InvalidCouponError("優惠碼無效")
```

自訂例外可讓錯誤語意更清楚，方便大型專案維護。

## 不要這樣寫：吞掉所有錯誤

```python
try:
    do_something()
except:
    pass
```

這會讓錯誤被隱藏，後續更難查。  
至少要記錄錯誤資訊或重新拋出。

## Traceback 要怎麼讀

閱讀順序建議：

1. 看最後一行例外類型與訊息（例如 `ValueError: ...`）。
2. 看對應檔案與行號。
3. 往上追呼叫路徑（誰呼叫了誰）。
4. 先修最底層根因，不要只改表面。

## 實務除錯 SOP（可重複）

1. **重現問題**：確保每次都能穩定觸發。
2. **縮小範圍**：先定位到函式或區塊。
3. **觀察資料**：用 `print()` 或除錯器看中間值。
4. **提出假設**：先猜一個最可能根因。
5. **最小修改驗證**：一次只改一件事。
6. **補測試避免回歸**：同類型錯誤不再發生。

## 實作範例：安全除法工具

```python
def safe_divide(a: float, b: float) -> float:
    if b == 0:
        raise ZeroDivisionError("除數不可為 0")
    return a / b


def main():
    try:
        x = float(input("被除數："))
        y = float(input("除數："))
        result = safe_divide(x, y)
    except ValueError:
        print("請輸入有效數字")
    except ZeroDivisionError as e:
        print(f"計算失敗：{e}")
    else:
        print(f"結果：{result:.2f}")


if __name__ == "__main__":
    main()
```

這個版本把「輸入錯誤」與「商業邏輯錯誤」清楚分開處理。

## `assert`（開發期檢查）

```python
def calc_unit_price(total: float, qty: int) -> float:
    assert qty > 0, "qty 必須大於 0"
    return total / qty
```

`assert` 常用於開發時快速驗證不變條件，不應拿來取代正式錯誤處理。

## 常見錯誤與排查

### 錯誤 1：一次捕捉太多例外

會讓真正根因被掩蓋。  
修正：先抓具體錯誤，必要時再補一般處理。

### 錯誤 2：只印「發生錯誤」無細節

修正：至少印出例外訊息，必要時記錄 traceback。

### 錯誤 3：例外處理寫在錯位置

把整個程式包進巨大 `try` 區塊會難以定位。  
修正：縮小 `try` 範圍。

## 章末練習

- 必做：做一個安全輸入程式，直到使用者輸入合法整數才結束。
- 必做：寫一個函式 `get_dict_value(data, key)`，若 key 不存在要回傳友善訊息。
- 選做：自訂一個 `InvalidAgeError`，對年齡區間做驗證。

## 本章重點回顧

- 例外處理是程式穩定性核心，不是附加功能。
- `try/except/else/finally` 各有角色，應分工清楚。
- 你已具備系統化除錯能力，能處理多數新手期常見錯誤。
