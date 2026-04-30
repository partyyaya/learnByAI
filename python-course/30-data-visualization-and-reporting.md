# 30｜資料視覺化與報告輸出

> 這章會教你把分析結果「說清楚」。你會學會圖表選型、Matplotlib/Seaborn 繪圖、輸出報告，讓資料真正能被決策使用。

## 學習目標

- 理解不同圖表的適用場景。
- 能使用 Matplotlib 與 Seaborn 畫常用商業圖表。
- 掌握圖表可讀性原則（標題、軸標籤、註解）。
- 能把分析結果輸出成圖檔與簡易報告。

## 前置條件

- 已完成 `29`（NumPy/Pandas 分析流程）。

## 安裝套件

```bash
pip install matplotlib seaborn pandas
```

## 圖表選型速查

- **折線圖**：看趨勢（時間序列）
- **長條圖**：比大小（分類比較）
- **堆疊圖**：看組成比例變化
- **直方圖**：看分布
- **箱型圖**：看中位數、離群值
- **散點圖**：看兩變數關係

## Matplotlib 基本範例

```python
import matplotlib.pyplot as plt

months = ["2026-01", "2026-02", "2026-03"]
revenue = [120000, 150000, 142000]

plt.figure(figsize=(8, 4))
plt.plot(months, revenue, marker="o")
plt.title("Monthly Revenue")
plt.xlabel("Month")
plt.ylabel("Revenue")
plt.grid(alpha=0.3)
plt.tight_layout()
plt.show()
```

## 長條圖與數值標註

```python
import matplotlib.pyplot as plt

regions = ["North", "South", "East", "West"]
amounts = [320000, 280000, 210000, 190000]

plt.figure(figsize=(8, 4))
bars = plt.bar(regions, amounts)
plt.title("Revenue by Region")
plt.ylabel("Revenue")

for bar in bars:
    y = bar.get_height()
    plt.text(bar.get_x() + bar.get_width() / 2, y, f"{int(y)}", ha="center", va="bottom")

plt.tight_layout()
plt.show()
```

## Seaborn：更高階視覺化

```python
import seaborn as sns
import matplotlib.pyplot as plt
import pandas as pd

df = pd.read_csv("data/orders.csv")
df["amount"] = pd.to_numeric(df["amount"], errors="coerce")

sns.set_theme(style="whitegrid")
plt.figure(figsize=(8, 4))
sns.histplot(df["amount"].dropna(), bins=20, kde=True)
plt.title("Order Amount Distribution")
plt.xlabel("Amount")
plt.tight_layout()
plt.show()
```

## 箱型圖觀察離群值

```python
plt.figure(figsize=(8, 4))
sns.boxplot(data=df, x="region", y="amount")
plt.title("Amount Distribution by Region")
plt.tight_layout()
plt.show()
```

## 使用 Pandas 快速畫圖

```python
monthly = (
    df.groupby("month", as_index=False)["amount"]
    .sum()
    .sort_values("month")
)

monthly.plot(x="month", y="amount", kind="line", marker="o", figsize=(8, 4), title="Monthly Revenue")
plt.tight_layout()
plt.show()
```

## 輸出圖檔

```python
plt.figure(figsize=(8, 4))
plt.plot(months, revenue, marker="o")
plt.title("Monthly Revenue")
plt.tight_layout()
plt.savefig("output/monthly_revenue.png", dpi=200)
```

實務上常把圖檔輸出給簡報、報表或通知系統。

## 報告撰寫建議（分析 -> 故事）

建議每份報告最少有：

1. 問題定義（你要回答什麼）
2. 資料來源與期間
3. 核心指標與圖表
4. 主要發現（3 點內）
5. 行動建議（可執行）

## 自動產生 Markdown 報告（簡化示例）

```python
from pathlib import Path

report = """
# Monthly Report

## Key Metrics
- Total Revenue: 1,230,000
- Avg Order Value: 780

## Charts
![Monthly Revenue](./monthly_revenue.png)
"""

Path("output/report.md").write_text(report, encoding="utf-8")
```

## 視覺化常見陷阱

### 陷阱 1：圖表太花但資訊不清

修正：先確保訊息清楚，再考慮美化。

### 陷阱 2：y 軸截斷造成誤導

修正：明確標示刻度，避免不當放大差異。

### 陷阱 3：一次放太多維度

修正：拆成多張圖，各圖只回答一個問題。

### 陷阱 4：缺少標題與單位

修正：每張圖加標題、軸標籤、必要註解。

## 實務建議

- 先畫草稿再正式出圖，確認圖表是否回答問題。
- 圖表與數字要互相驗證，避免計算與視覺不一致。
- 用固定樣式模板，報告可讀性與一致性更高。

## 章末練習

- 必做：針對一份銷售資料畫 3 張圖（趨勢、分布、比較）。
- 必做：輸出 PNG 圖檔與一份簡短 Markdown 報告。
- 選做：在圖表中加入關鍵事件註解（例如促銷活動時間點）。

## 本章重點回顧

- 視覺化是分析結果的溝通工具，不是裝飾品。
- 好圖表要清楚、準確、可解讀，並直接回答問題。
- 你已能從資料分析延伸到可交付的報告輸出。
