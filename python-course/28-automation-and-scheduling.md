# 28｜自動化腳本與排程實務

> 這章會把 Python 直接變成你的效率槓桿。你會把重複工作腳本化，並透過排程讓任務自動執行。

## 學習目標

- 能辨識適合自動化的任務類型。
- 能設計可重複執行且穩定的自動化腳本。
- 熟悉排程方案（cron / 系統排程器）基本用法。
- 建立日誌、重試、通知等生產級習慣。

## 前置條件

- 已完成 `13`（檔案 I/O）、`24`（HTTP/API）、`19`（標準庫）。

## 哪些任務適合自動化

- 每天重複的資料抓取與整理。
- 固定時間產生報表並寄送。
- 批次改檔名、格式轉換、資料清理。
- 定期檢查服務健康狀態並通知。

判斷原則：**重複、規則明確、人工容易出錯**。

## 自動化腳本標準結構

```python
def load_input():
    ...


def process_data(data):
    ...


def save_output(result):
    ...


def main():
    data = load_input()
    result = process_data(data)
    save_output(result)


if __name__ == "__main__":
    main()
```

分層清楚，維護成本低。

## 加入命令列參數（argparse）

```python
import argparse


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--date", required=True, help="報表日期 YYYY-MM-DD")
    parser.add_argument("--output", default="output/report.csv")
    return parser.parse_args()
```

讓同一腳本可處理不同輸入情境。

## 加入 logging（取代 print）

```python
import logging

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
)

logging.info("task started")
```

## 逾時與重試（網路任務必備）

```python
import time
import requests


def fetch_with_retry(url: str, retries: int = 3):
    for i in range(retries):
        try:
            resp = requests.get(url, timeout=10)
            resp.raise_for_status()
            return resp.json()
        except requests.RequestException:
            if i == retries - 1:
                raise
            time.sleep(2)
```

## 排程方式 1：cron（Unix-like 常見）

查看與編輯：

```bash
crontab -e
```

範例：每天早上 8:30 執行腳本

```text
30 8 * * * /path/to/project/.venv/bin/python /path/to/project/src/job.py
```

### cron 注意事項

- 使用完整絕對路徑。
- 明確指定 `.venv` 內 Python。
- 輸出導到 log 檔方便排查。

## 排程方式 2：系統工作排程器

- macOS 可考慮 launchd。
- Windows 可用 Task Scheduler。

不同環境都要先驗證路徑、權限與環境變數。

## 範例：每日報表任務

```python
from pathlib import Path
from datetime import datetime
import csv


def generate_daily_report():
    today = datetime.now().strftime("%Y-%m-%d")
    rows = [
        {"metric": "orders", "value": 123},
        {"metric": "revenue", "value": 45678},
    ]

    out = Path("output") / f"report-{today}.csv"
    out.parent.mkdir(parents=True, exist_ok=True)

    with out.open("w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=["metric", "value"])
        writer.writeheader()
        writer.writerows(rows)

    return out


def main():
    path = generate_daily_report()
    print(f"報表已輸出: {path}")
```

## 自動化品質原則（非常重要）

### 1) 冪等性（idempotent）

同一任務重跑不應產生重複或錯誤狀態。

### 2) 可觀測性

至少要有開始/結束/錯誤日誌。

### 3) 失敗可恢復

發生錯誤時可安全重跑，或從中斷點繼續。

### 4) 通知機制

關鍵任務失敗要能通知（Email/Slack/Webhook）。

## 常見錯誤與排查

### 錯誤 1：本地跑得動，排程跑不起來

通常是環境路徑不同。  
修正：在腳本記錄 `sys.executable` 與工作目錄。

### 錯誤 2：任務重複執行互相覆蓋

修正：加鎖或建立執行中標記。

### 錯誤 3：沒有錯誤通知

修正：在 `except` 區塊補通知機制。

### 錯誤 4：輸出檔案命名不一致

修正：統一命名規則與目錄結構，避免後續流程找不到檔案。

## 章末練習

- 必做：建立一支每日抓取 API 並輸出 CSV 的腳本。
- 必做：加上 logging、timeout、retry。
- 選做：把任務掛到 cron，實際觀察 1 天輸出與 log。

## 本章重點回顧

- 自動化的本質是把重複、明確規則的工作交給程式。
- 穩定自動化需要排程、重試、日誌與通知整套設計。
- 你已具備把 Python 應用到日常效率與維運流程的能力。
