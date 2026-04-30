# 02｜第一支 Python 程式與執行模型

> 這章會帶你從「我寫了一段程式」到「電腦到底怎麼執行它」的完整過程。你不只會跑程式，也會理解程式怎麼被執行。

## 學習目標

- 能在 REPL 與 `.py` 檔案中執行 Python 程式。
- 理解 Python 程式從原始碼到執行結果的流程。
- 知道 `if __name__ == "__main__":` 的用途與使用時機。
- 能讀懂常見錯誤訊息並快速修正。

## 前置條件

- 已完成 `01` 章，環境已可正常執行 Python。
- 知道如何開啟終端機與編輯器。

## 先做一件事：讓程式真的跑起來

建立檔案 `src/hello.py`：

```python
print("Hello, Python!")
```

執行：

```bash
python src/hello.py
```

你會看到：

```text
Hello, Python!
```

這是你第一個完整的「寫程式 -> 執行 -> 得到結果」迴圈。

## 兩種執行方式：REPL vs 腳本

### 1) REPL（互動模式）

```bash
python
```

進入後可直接輸入：

```python
2 + 3
```

會立即得到 `5`。  
REPL 適合：

- 快速測試一行語法。
- 驗證某個函式結果。
- 做小規模實驗。

### 2) 腳本模式（`.py` 檔）

- 內容可保存、可重複執行、可版控。
- 真正做專案時，主要都用腳本模式。

## 第一個稍微像樣的程式

建立 `src/greet.py`：

```python
def greet(name: str) -> str:
    return f"Hi, {name}! Welcome to Python."


def main():
    user_name = input("請輸入你的名字：")
    message = greet(user_name)
    print(message)


if __name__ == "__main__":
    main()
```

### 這段程式你要看懂的 4 件事

- `def greet(...)`：定義一個可以重複使用的函式。
- `input(...)`：從使用者取得輸入（型別是字串）。
- `main()`：把主流程集中在一個地方，程式更清楚。
- `if __name__ == "__main__":`：只有「直接執行此檔案」時才跑 `main()`。

## `if __name__ == "__main__":` 為什麼重要

當你直接跑 `python src/greet.py`：

- `__name__` 的值是 `"__main__"`。
- 條件成立，`main()` 會執行。

當別的檔案 `import greet`：

- `__name__` 變成模組名稱（例如 `"greet"`）。
- 條件不成立，`main()` 不會自動執行。

這可避免「匯入模組時副作用太多」的問題，是良好工程習慣。

## Python 執行模型（新手可理解版本）

你可以把 Python 執行想成 4 個步驟：

1. **讀取原始碼**：Python 先讀你的 `.py` 檔案。
2. **語法解析與編譯為位元碼（bytecode）**：轉成 Python 虛擬機可理解的中間形式。
3. **交給 Python Virtual Machine（PVM）執行**。
4. **輸出結果或拋出錯誤**。

你通常不用手動管理這些步驟，但知道流程會幫你更快理解錯誤來源。

## 常見錯誤訊息：你應該怎麼看

### 1) `SyntaxError`（語法錯誤）

範例：

```python
print("Hello"
```

少了右括號，程式還沒開始跑就失敗。  
解法：先看錯誤指向行號，檢查括號、引號、冒號是否配對。

### 2) `NameError`（變數名稱不存在）

範例：

```python
message = "Hi"
print(mesage)
```

`mesage` 拼錯。  
解法：確認變數拼字一致，善用編輯器補全。

### 3) `TypeError`（型別不支援該操作）

範例：

```python
age = "18"
print(age + 1)
```

字串不能直接和整數相加。  
解法：先轉型別。

```python
age = "18"
print(int(age) + 1)
```

### 4) `IndentationError`（縮排錯誤）

Python 用縮排表示程式區塊，縮排不一致會報錯。  
解法：固定使用 4 個空白縮排，不要混用 Tab 與空白。

## 執行流程的基本模板（建議背起來）

```python
def main():
    # 1. 取得輸入
    # 2. 處理邏輯
    # 3. 輸出結果
    pass


if __name__ == "__main__":
    main()
```

這個模板對 CLI 工具、資料處理腳本、小型 API 啟動檔都很有用。

## 實作練習：成績判定小程式

請建立 `src/score.py`，需求如下：

- 輸入一個分數（0 到 100）。
- 輸出等級：
  - 90 以上：A
  - 80 到 89：B
  - 70 到 79：C
  - 60 到 69：D
  - 59 以下：F

參考版本：

```python
def grade(score: int) -> str:
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
    raw = input("請輸入分數(0-100)：")
    score = int(raw)
    result = grade(score)
    print(f"你的等級是：{result}")


if __name__ == "__main__":
    main()
```

## 新手除錯 SOP（照著做，效率會高很多）

1. 先重現問題，不要同時改很多地方。
2. 看錯誤類型（`SyntaxError`、`TypeError`...）。
3. 看錯誤行號與上下文。
4. 用 `print()` 暫時輸出中間值確認流程。
5. 每次只改一件事，再執行驗證。

## 章末練習

- 必做：把 `greet.py` 改成同時問「名字」與「學習目標」，輸出完整句子。
- 必做：故意製造 3 種錯誤（語法、名稱、型別），並寫下你如何修正。
- 選做：把 `score.py` 拆成兩個函式，提升可讀性。

## 本章重點回顧

- 你會用 REPL 與腳本兩種方式執行 Python。
- 你理解了 Python 的基本執行流程：讀原始碼 -> 轉 bytecode -> PVM 執行。
- 你學會用 `main` 結構與錯誤訊息做基本除錯，已具備寫小程式的起點。
