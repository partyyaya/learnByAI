# 21｜使用 pytest 進行測試

> 這章會讓你建立「寫完程式不是結束，驗證正確才算完成」的工程習慣。pytest 是 Python 最主流測試框架之一，語法簡潔、學習成本低。

## 學習目標

- 理解測試在開發流程中的角色。
- 能使用 pytest 撰寫與執行基本單元測試。
- 熟悉 fixture、參數化測試與例外測試。
- 建立測試覆蓋率與回歸防護的觀念。

## 前置條件

- 已完成 C 區塊並具備函式/模組化能力。

## 為什麼要測試

- 減少手動重複驗證時間。
- 改功能時更安心，降低回歸 bug。
- 團隊協作時可快速判斷變更是否破壞既有行為。

## 安裝與執行

```bash
pip install pytest
pytest
```

pytest 會自動尋找 `test_*.py` 或 `*_test.py` 檔案。

## 第一個測試

`src/my_project/math_utils.py`：

```python
def add(a: int, b: int) -> int:
    return a + b
```

`tests/test_math_utils.py`：

```python
from my_project.math_utils import add


def test_add_two_numbers():
    assert add(2, 3) == 5
```

執行：

```bash
pytest -q
```

## 測試命名建議

- 測試函式名稱以 `test_` 開頭。
- 名稱應描述行為，例如 `test_discount_applies_for_vip_user`。

## Arrange-Act-Assert 模板

建議每個測試用 AAA 結構：

1. Arrange：準備資料
2. Act：執行行為
3. Assert：驗證結果

```python
def test_apply_discount_for_large_order():
    # Arrange
    amount = 1200

    # Act
    final = amount * 0.9

    # Assert
    assert final == 1080
```

## 參數化測試：`@pytest.mark.parametrize`

```python
import pytest


def grade(score: int) -> str:
    if score >= 90:
        return "A"
    if score >= 80:
        return "B"
    return "C"


@pytest.mark.parametrize(
    "score,expected",
    [
        (95, "A"),
        (85, "B"),
        (70, "C"),
    ],
)
def test_grade(score, expected):
    assert grade(score) == expected
```

可避免重複撰寫相似測試。

## 測試例外：`pytest.raises`

```python
import pytest


def divide(a: float, b: float) -> float:
    if b == 0:
        raise ZeroDivisionError("b 不可為 0")
    return a / b


def test_divide_by_zero():
    with pytest.raises(ZeroDivisionError):
        divide(10, 0)
```

## Fixture：重用測試前置資料

```python
import pytest


@pytest.fixture
def sample_user():
    return {"name": "Amy", "age": 20}


def test_user_name(sample_user):
    assert sample_user["name"] == "Amy"
```

fixture 可讓測試準備更集中、更乾淨。

## monkeypatch（入門）

當你想替換環境變數或外部依賴，可用 `monkeypatch`：

```python
def get_api_url():
    import os
    return os.getenv("API_URL", "http://localhost")


def test_get_api_url(monkeypatch):
    monkeypatch.setenv("API_URL", "https://api.example.com")
    assert get_api_url() == "https://api.example.com"
```

## 覆蓋率（coverage）概念

可搭配 `pytest-cov`：

```bash
pip install pytest-cov
pytest --cov=src --cov-report=term-missing
```

注意：覆蓋率高不代表測試一定有效，但可作為參考指標。

## 測試策略（實務建議）

- 優先測試核心商業規則。
- 針對邊界值與錯誤情境寫測試。
- 每修一個 bug，補一個對應測試。

## 常見錯誤與排查

### 錯誤 1：只測 happy path

缺少錯誤輸入、邊界值測試，容易漏 bug。

### 錯誤 2：測試依賴外部狀態

例如依賴真實資料庫或網路，導致測試不穩。  
修正：隔離依賴，使用 mock/fixture。

### 錯誤 3：測試名稱太模糊

`test_1`、`test_case` 不利維護。  
修正：改成行為描述名稱。

## 章末練習

- 必做：為你的一個函式寫 3 個測試（正常、邊界、錯誤）。
- 必做：用 `parametrize` 改寫重複測試案例。
- 選做：使用 fixture 建立共用測試資料。

## 本章重點回顧

- pytest 讓測試撰寫與執行變得簡單高效。
- 好的測試應該涵蓋正常流程、邊界條件與異常情境。
- 測試是品質保證與穩定迭代的核心能力。
