# 36｜專題實作 C：資料分析專題

> 這章會帶你做出一個「從資料到決策」的完整作品。你會走完問題定義、資料清理、分析建模、視覺化與結論報告的全流程。

## 學習目標

- 能以商業問題導向規劃資料分析專題。
- 能建立可重現的資料處理與分析流程。
- 能產出具說服力的圖表與結論報告。
- 能清楚說明分析限制與下一步建議。

## 前置條件

- 已完成 `29` 與 `30`（分析與視覺化）。
- 已完成 `33`（專題規劃）。

## 專題題目示例

- 銷售資料分析：找出成長/下滑關鍵因素
- 用戶行為分析：提升留存與轉換率
- 爬蟲 + 分析：追蹤市場價格變化

建議先選「資料品質相對穩定」的題目。

## 分析專題標準流程（強烈建議照做）

1. 問題定義（Business Question）
2. 資料蒐集與理解
3. 資料清理與前處理
4. 探索式分析（EDA）
5. 指標與圖表輸出
6. 結論與建議
7. 可重現交付（腳本 + 報告）

## 專案結構建議

```text
data-project/
  data/
    raw/
    processed/
  notebooks/
  src/
    load.py
    clean.py
    analyze.py
    report.py
  output/
    charts/
    tables/
    report.md
  README.md
```

## 步驟 1：定義分析問題

範例：

- 「近 6 個月營收變化趨勢是什麼？」
- 「哪個地區客單價最高？」
- 「高價訂單比例是否提升？」

問題要可量化、可驗證，避免太抽象。

## 步驟 2：資料品質檢查

```python
import pandas as pd

df = pd.read_csv("data/raw/orders.csv")
print(df.shape)
print(df.isna().sum())
print(df.dtypes)
```

先看資料狀態，再決定清理策略。

## 步驟 3：清理與前處理

```python
df["amount"] = pd.to_numeric(df["amount"], errors="coerce")
df["order_date"] = pd.to_datetime(df["order_date"], errors="coerce")
df = df.dropna(subset=["amount", "order_date", "region"])
df = df[df["amount"] >= 0]
df["month"] = df["order_date"].dt.to_period("M").astype(str)
```

把規則寫進腳本，避免只在 notebook 手動操作。

## 步驟 4：核心分析指標

```python
monthly = (
    df.groupby("month", as_index=False)
    .agg(
        revenue=("amount", "sum"),
        order_count=("order_id", "count"),
        avg_order=("amount", "mean"),
    )
)

region_summary = (
    df.groupby("region", as_index=False)
    .agg(
        revenue=("amount", "sum"),
        avg_order=("amount", "mean"),
    )
    .sort_values("revenue", ascending=False)
)
```

## 步驟 5：輸出圖表

```python
import matplotlib.pyplot as plt

plt.figure(figsize=(8, 4))
plt.plot(monthly["month"], monthly["revenue"], marker="o")
plt.title("Monthly Revenue Trend")
plt.xlabel("Month")
plt.ylabel("Revenue")
plt.xticks(rotation=45)
plt.tight_layout()
plt.savefig("output/charts/monthly_revenue.png", dpi=200)
```

## 步驟 6：產生報告骨架

建議報告章節：

1. 研究問題
2. 資料來源與範圍
3. 方法與清理規則
4. 主要發現（3-5 點）
5. 行動建議
6. 分析限制與後續規劃

## `report.md` 範例段落

```text
## 主要發現
1. 月營收在 2026-03 達到高峰，較前月成長 18%。
2. North 區域貢獻 42% 營收，但客單價略低於 East。
3. 高價訂單占比由 12% 提升到 17%，顯示高單價策略有效。
```

## 分析限制（一定要寫）

- 資料缺失比例與可能偏差
- 觀測期間長短
- 無法控制的外部因素（季節、促銷、政策）

能講限制，才代表你有分析成熟度。

## 驗收標準（建議）

- [ ] 有明確問題與指標
- [ ] 有可重現清理腳本
- [ ] 有至少 3 張關鍵圖表
- [ ] 有可讀報告與行動建議
- [ ] 有限制說明

## 面試展示要點

- 先講商業問題，不要先講工具。
- 說明你做了哪些資料品質決策。
- 圖表要能回答問題，不要只是漂亮。
- 講出一個你做過的取捨（例如缺值處理方案）。

## 常見錯誤與排查

### 錯誤 1：只做圖，不回答問題

修正：每張圖都要對應一個分析問題。

### 錯誤 2：清理規則不透明

修正：把規則明確寫進程式與報告。

### 錯誤 3：結論過度推論

修正：只在資料支持範圍內下結論。

### 錯誤 4：沒有可重現流程

修正：把分析流程腳本化，避免只靠 notebook 手動操作。

## 章末練習

- 必做：完成一份資料分析 mini 專題（至少 1 個問題、3 張圖、1 份報告）。
- 必做：寫出資料清理函式並輸出 `processed` 資料檔。
- 選做：把報告流程自動化（執行腳本一次產出圖表與 Markdown）。

## 本章重點回顧

- 好的資料專題不是「跑很多圖」，而是「回答明確問題」。
- 可重現流程與限制說明是專業度關鍵。
- 你已能交付一份可展示於求職或團隊分享的分析作品。
