# 27｜網頁爬蟲實務：requests + BeautifulSoup

> 這章會教你用 Python 把網頁資訊轉成可分析資料。你會學到合法抓取、HTML 解析、資料清理與反爬常見對策。

## 學習目標

- 理解爬蟲流程：請求 -> 解析 -> 清理 -> 儲存。
- 能用 `requests` 抓取網頁，用 `BeautifulSoup` 解析內容。
- 熟悉 CSS Selector 與常見資料擷取技巧。
- 知道 robots、頻率控制與合法使用原則。

## 前置條件

- 已完成 `24`（HTTP/API）與 `14`（資料檔處理）。

## 合法與倫理先講清楚

- 先看網站使用條款與 `robots.txt`。
- 不要抓取受保護、需授權或違規資料。
- 控制請求頻率，避免影響對方服務。
- 商業用途前務必確認法規與授權。

## 安裝套件

```bash
pip install beautifulsoup4 requests
```

## 第一個爬蟲範例

```python
import requests
from bs4 import BeautifulSoup

url = "https://example.com"
resp = requests.get(url, timeout=10)
resp.raise_for_status()

soup = BeautifulSoup(resp.text, "html.parser")
title = soup.find("h1")
print(title.text.strip() if title else "No title")
```

## 常見解析方法

### `find` / `find_all`

```python
cards = soup.find_all("div", class_="card")
for c in cards:
    print(c.get_text(strip=True))
```

### CSS Selector（推薦）

```python
titles = soup.select("article h2.title")
for t in titles:
    print(t.get_text(strip=True))
```

## 擷取屬性

```python
links = soup.select("a.post-link")
for a in links:
    href = a.get("href")
    text = a.get_text(strip=True)
    print(text, href)
```

## 相對連結轉絕對連結

```python
from urllib.parse import urljoin

base_url = "https://news.example.com"
relative = "/post/123"
print(urljoin(base_url, relative))
```

## 資料清理常見技巧

```python
def clean_text(text: str) -> str:
    return " ".join(text.split())
```

- 去掉多餘空白、換行。
- 清除無意義字元（例如 `\xa0`）。
- 做欄位格式化（日期、價格、數字）。

## 多頁抓取（Pagination）

```python
import requests
from bs4 import BeautifulSoup

all_titles = []
for page in range(1, 4):
    url = f"https://example.com/articles?page={page}"
    resp = requests.get(url, timeout=10)
    resp.raise_for_status()
    soup = BeautifulSoup(resp.text, "html.parser")

    for el in soup.select("h2.title"):
        all_titles.append(el.get_text(strip=True))

print(f"抓到 {len(all_titles)} 筆標題")
```

## 控制請求頻率（避免過載）

```python
import time

for url in urls:
    # 抓取邏輯...
    time.sleep(1.0)
```

## User-Agent 與 Header

```python
headers = {
    "User-Agent": "Mozilla/5.0 (compatible; LearnByAI-Bot/1.0)"
}
resp = requests.get(url, headers=headers, timeout=10)
```

某些網站會拒絕缺少合理 header 的請求。

## 把結果寫成 CSV

```python
import csv
from pathlib import Path

rows = [
    {"title": "A", "url": "https://example.com/a"},
    {"title": "B", "url": "https://example.com/b"},
]

path = Path("output/articles.csv")
path.parent.mkdir(parents=True, exist_ok=True)

with path.open("w", encoding="utf-8", newline="") as f:
    writer = csv.DictWriter(f, fieldnames=["title", "url"])
    writer.writeheader()
    writer.writerows(rows)
```

## 動態網站怎麼辦

若內容由 JavaScript 動態渲染：

- 先用瀏覽器 DevTools 看是否有可直接呼叫的 API（優先）。
- 若無 API，可用瀏覽器自動化工具（如 Playwright）。
- 動態抓取成本高，優先找穩定資料來源。

## 常見錯誤與排查

### 錯誤 1：Selector 不穩定

網站改版後抓不到資料。  
修正：選語義化、穩定的節點，不依賴易變 class。

### 錯誤 2：沒處理請求失敗

修正：加 `timeout`、`raise_for_status`、例外處理與重試。

### 錯誤 3：資料清理不足

造成後續分析困難。  
修正：建立標準化清理函式。

### 錯誤 4：抓太快被封鎖

修正：降低頻率、分批抓取、遵守網站規範。

## 實務建議

- 把「抓取」與「解析」邏輯分成兩個函式，方便測試。
- 先抓少量樣本驗證，再擴大規模。
- 保留原始 HTML（可選）方便除錯。

## 章末練習

- 必做：抓取一個公開網站的文章標題與連結，輸出 CSV。
- 必做：加上逾時、錯誤處理與簡單重試。
- 選做：支援多頁抓取並統計關鍵字出現次數。

## 本章重點回顧

- 爬蟲核心流程是請求、解析、清理、儲存。
- BeautifulSoup 適合靜態頁面解析，搭配 requests 效率高。
- 合法合規與頻率控制是實務爬蟲不可省略的底線。
