# 24｜HTTP 與 API 實戰（requests）

> 這章會帶你進入「程式與外部服務溝通」的核心能力。你會用 `requests` 呼叫 API、處理錯誤、做重試與逾時控制，這是後端與自動化任務的基本功。

## 學習目標

- 理解 HTTP 基本概念（Method、Status Code、Header、Body）。
- 能用 `requests` 發送 GET/POST/PATCH/DELETE。
- 熟悉 query、JSON payload、token 認證、逾時設定。
- 能設計穩定的 API 呼叫流程（錯誤處理、重試、日誌）。

## 前置條件

- 已完成 `13`、`14`（檔案與 JSON/CSV）。
- 具備函式、例外處理與模組化能力。

## HTTP 快速心智模型

- **Client**：你的 Python 程式。
- **Server**：API 服務端。
- **Request**：你送出去的請求。
- **Response**：伺服器回傳結果。

### 常見 Method

- `GET`：讀資料
- `POST`：新增資料
- `PUT`：完整更新
- `PATCH`：部分更新
- `DELETE`：刪除資料

### 常見 Status Code

- `200`：成功
- `201`：建立成功
- `400`：請求錯誤
- `401`：未授權
- `403`：禁止
- `404`：找不到資源
- `500`：伺服器錯誤

## 安裝與第一個請求

```bash
pip install requests
```

```python
import requests

url = "https://httpbin.org/get"
resp = requests.get(url, timeout=10)

print(resp.status_code)
print(resp.json())
```

## GET：帶 query 參數

```python
import requests

url = "https://httpbin.org/get"
params = {"q": "python", "page": 2}

resp = requests.get(url, params=params, timeout=10)
resp.raise_for_status()
data = resp.json()

print(data["args"])
```

`params` 會自動轉成 URL query string。

## POST：送 JSON payload

```python
import requests

url = "https://httpbin.org/post"
payload = {"name": "Amy", "role": "student"}

resp = requests.post(url, json=payload, timeout=10)
resp.raise_for_status()

print(resp.json()["json"])
```

使用 `json=` 比自己 `json.dumps` + `data=` 更簡潔。

## Header 與 Token 認證

```python
import requests

token = "YOUR_TOKEN"
headers = {
    "Authorization": f"Bearer {token}",
    "Accept": "application/json",
}

resp = requests.get("https://api.example.com/profile", headers=headers, timeout=10)
```

## 逾時與錯誤處理（務必加）

```python
import requests

try:
    resp = requests.get("https://api.example.com/data", timeout=8)
    resp.raise_for_status()
    result = resp.json()
except requests.Timeout:
    print("請求逾時，請稍後重試")
except requests.HTTPError as e:
    print(f"HTTP 錯誤: {e}")
except requests.RequestException as e:
    print(f"網路或請求錯誤: {e}")
```

`RequestException` 是 requests 錯誤的基底類別。

## `raise_for_status()` 何時用

- 想把 `4xx/5xx` 當成例外流程處理時使用。
- 若 API 會在 `200` 內包業務錯誤，還要再檢查 body 欄位。

## Session：重用連線、共享 Header

```python
import requests

session = requests.Session()
session.headers.update({"Authorization": "Bearer YOUR_TOKEN"})

resp1 = session.get("https://api.example.com/users", timeout=10)
resp2 = session.get("https://api.example.com/orders", timeout=10)
```

`Session` 在多次呼叫同一服務時更有效率。

## 重試策略（實務）

簡化版可自行包函式重試：

```python
import time
import requests


def get_with_retry(url: str, retries: int = 3, delay: float = 1.0):
    last_error = None
    for _ in range(retries):
        try:
            resp = requests.get(url, timeout=8)
            resp.raise_for_status()
            return resp.json()
        except requests.RequestException as e:
            last_error = e
            time.sleep(delay)
    raise RuntimeError(f"重試後仍失敗: {last_error}")
```

注意：重試前先判斷 API 是否可安全重試（例如 GET 通常可，POST 視情況）。

## API Client 封裝範例

```python
import requests


class TodoApiClient:
    def __init__(self, base_url: str, token: str):
        self.base_url = base_url.rstrip("/")
        self.session = requests.Session()
        self.session.headers.update(
            {
                "Authorization": f"Bearer {token}",
                "Accept": "application/json",
            }
        )

    def list_todos(self):
        url = f"{self.base_url}/todos"
        resp = self.session.get(url, timeout=10)
        resp.raise_for_status()
        return resp.json()

    def create_todo(self, title: str):
        url = f"{self.base_url}/todos"
        resp = self.session.post(url, json={"title": title}, timeout=10)
        resp.raise_for_status()
        return resp.json()
```

把 API 呼叫集中封裝，可測試、可重用、可維護。

## 常見錯誤與排查

### 錯誤 1：沒設定 timeout

請求可能卡住很久。  
修正：所有 requests 呼叫都加 `timeout`。

### 錯誤 2：只看 `status_code` 不看 response body

API 有時會在 body 提供錯誤細節。  
修正：失敗時記錄 `resp.text`（注意敏感資料）。

### 錯誤 3：把敏感 token 寫死在程式碼

修正：使用環境變數，不要硬編碼。

### 錯誤 4：無條件重試所有請求

某些請求非冪等，重試可能造成重複寫入。  
修正：依 Method 與業務規則設計重試策略。

## 實務建議清單

- 統一 API client 模組，避免各處散落 requests。
- 每個請求都加 timeout 與錯誤處理。
- 記錄 request id、status、耗時，方便追蹤問題。
- 對外部 API 設計 fallback（降級策略）。

## 章末練習

- 必做：呼叫公開 API（如匯率、天氣），印出 3 個關鍵欄位。
- 必做：封裝一個 `ApiClient`，至少包含 `get` 與 `post` 兩個方法。
- 選做：加入重試與簡易快取（同 URL 10 秒內不重抓）。

## 本章重點回顧

- HTTP 是 API 溝通基礎，requests 是 Python 最常用客戶端工具。
- 穩定 API 呼叫的關鍵是：逾時、錯誤處理、重試、日誌。
- 你已具備串接第三方服務的實務起點。
