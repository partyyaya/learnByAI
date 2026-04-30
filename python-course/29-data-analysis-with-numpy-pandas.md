# 29｜資料分析入門：NumPy 與 Pandas

> 這章會讓你把「原始資料」轉成「可解讀的洞察」。你會學到 NumPy 陣列運算與 Pandas 表格分析流程，這是資料工作的核心能力。

## 學習目標

- 理解 NumPy 與 Pandas 在分析流程中的角色。
- 能用 Pandas 讀取資料、清理資料、做聚合分析。
- 熟悉缺失值處理、型別轉換、分組統計。
- 能完成一份小型資料分析腳本。

## 前置條件

- 已完成 `14`（JSON/CSV）與 `10`（資料處理模式）。

## 安裝套件

```bash
pip install numpy pandas
```

## NumPy：高效數值運算

```python
import numpy as np

a = np.array([1, 2, 3, 4, 5])
print(a.mean())     # 平均
print(a.sum())      # 總和
print(a * 2)        # 向量化運算
```

NumPy 的優勢是向量化，能比 Python 原生迴圈更快處理大量數值資料。

## Pandas：表格資料分析核心

```python
import pandas as pd

df = pd.read_csv("data/sales.csv")
print(df.head())
print(df.info())
print(df.describe())
```

### 常用快速檢查

- `head()`：看前幾列
- `info()`：看欄位型別與缺失值
- `describe()`：數值欄位統計摘要

## 欄位選取與篩選

```python
sales_only = df[["order_id", "amount"]]
high_sales = df[df["amount"] >= 1000]
```

條件篩選可組合：

```python
target = df[(df["amount"] >= 1000) & (df["region"] == "north")]
```

## 缺失值處理

```python
print(df.isna().sum())  # 每欄缺失值數量

df["customer_name"] = df["customer_name"].fillna("unknown")
df = df.dropna(subset=["amount"])
```

## 型別轉換

```python
df["amount"] = pd.to_numeric(df["amount"], errors="coerce")
df["order_date"] = pd.to_datetime(df["order_date"], errors="coerce")
```

`errors="coerce"` 會把非法值轉成 `NaN/NaT`，便於後續清理。

## 新增欄位與轉換

```python
df["is_large_order"] = df["amount"] >= 2000
df["month"] = df["order_date"].dt.to_period("M").astype(str)
```

## 分組與聚合（GroupBy）

```python
summary = (
    df.groupby("region", as_index=False)
    .agg(
        total_amount=("amount", "sum"),
        avg_amount=("amount", "mean"),
        order_count=("order_id", "count"),
    )
    .sort_values("total_amount", ascending=False)
)

print(summary)
```

## 排序與去重

```python
df = df.sort_values(["order_date", "amount"], ascending=[True, False])
df = df.drop_duplicates(subset=["order_id"])
```

## 合併資料（Join）

```python
orders = pd.read_csv("data/orders.csv")
users = pd.read_csv("data/users.csv")

merged = orders.merge(users, on="user_id", how="left")
```

## 輸出結果

```python
summary.to_csv("output/summary.csv", index=False, encoding="utf-8")
```

## 小型分析實作範例

需求：分析每月營收與高價訂單占比。

```python
import pandas as pd

df = pd.read_csv("data/orders.csv")
df["amount"] = pd.to_numeric(df["amount"], errors="coerce")
df["order_date"] = pd.to_datetime(df["order_date"], errors="coerce")
df = df.dropna(subset=["amount", "order_date"])

df["month"] = df["order_date"].dt.to_period("M").astype(str)
df["is_large"] = df["amount"] >= 2000

monthly = (
    df.groupby("month", as_index=False)
    .agg(
        total_revenue=("amount", "sum"),
        avg_order=("amount", "mean"),
        large_ratio=("is_large", "mean"),
    )
)

monthly["large_ratio"] = (monthly["large_ratio"] * 100).round(2)
print(monthly)
```

## 常見錯誤與排查

### 錯誤 1：忘記處理缺失值

聚合結果異常或報錯。  
修正：先 `isna().sum()` 再決定填補或移除。

### 錯誤 2：數字欄位其實是字串

平均值計算失敗。  
修正：用 `pd.to_numeric` 明確轉型。

### 錯誤 3：日期欄位格式不一致

時間分析結果錯亂。  
修正：用 `pd.to_datetime` 統一轉換。

### 錯誤 4：分析邏輯全寫在一大段程式

修正：拆成 `load/clean/analyze/export` 函式。

## 實務建議

- 每份資料先做資料品質檢查（缺值、型別、範圍）。
- 關鍵清理規則要可追溯，寫入 README 或註解。
- 產出不只要有結果，還要有可重現腳本。

## 章末練習

- 必做：讀取一份 CSV，輸出欄位型別與缺失值統計表。
- 必做：依地區分組計算總營收與平均客單價。
- 選做：做月度趨勢分析，輸出 `monthly_report.csv`。

## 本章重點回顧

- NumPy 擅長數值運算，Pandas 擅長表格資料處理。
- 分析品質取決於清理品質，清理步驟要有紀律。
- 你已具備從原始 CSV 產出商業指標的能力。
