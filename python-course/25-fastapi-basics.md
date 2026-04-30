# 25｜FastAPI 入門：建立你的第一個 API 服務

> 這章會把你從 API 呼叫端推進到 API 提供端。你會用 FastAPI 建立可測試、可擴充、帶自動文件的後端服務。

## 學習目標

- 能建立 FastAPI 專案並啟動服務。
- 熟悉路由、Path/Query 參數、Request Body 驗證。
- 理解 Pydantic 模型在資料驗證中的角色。
- 能處理常見錯誤並撰寫基本 API 結構。

## 前置條件

- 已完成 `24`（HTTP 與 requests）。
- 具備函式、模組化與例外處理基礎。

## 安裝與啟動

```bash
pip install fastapi uvicorn
```

建立 `src/main.py`：

```python
from fastapi import FastAPI

app = FastAPI(title="LearnByAI API", version="1.0.0")


@app.get("/")
def root():
    return {"message": "Hello FastAPI"}
```

啟動：

```bash
uvicorn src.main:app --reload
```

打開：

- `http://127.0.0.1:8000/docs`（Swagger UI）
- `http://127.0.0.1:8000/redoc`

## 路由與 HTTP Method

```python
from fastapi import FastAPI

app = FastAPI()


@app.get("/items")
def list_items():
    return [{"id": 1, "name": "book"}]


@app.post("/items")
def create_item():
    return {"ok": True}
```

## Path 與 Query 參數

```python
from fastapi import FastAPI

app = FastAPI()


@app.get("/users/{user_id}")
def get_user(user_id: int, verbose: bool = False):
    return {"user_id": user_id, "verbose": verbose}
```

- `user_id` 來自 URL path。
- `verbose` 是 query 參數（如 `?verbose=true`）。

## Request Body 驗證（Pydantic）

```python
from fastapi import FastAPI
from pydantic import BaseModel, Field

app = FastAPI()


class ItemCreate(BaseModel):
    name: str = Field(min_length=1, max_length=50)
    price: float = Field(gt=0)
    in_stock: bool = True


@app.post("/items")
def create_item(payload: ItemCreate):
    return {"item": payload}
```

FastAPI 會自動驗證輸入，不合法會回 `422 Unprocessable Entity`。

## Response Model（回傳資料結構約束）

```python
from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI()


class ItemOut(BaseModel):
    id: int
    name: str


@app.get("/items/{item_id}", response_model=ItemOut)
def get_item(item_id: int):
    return {"id": item_id, "name": "Keyboard", "extra": "ignored"}
```

多餘欄位會被過濾，回傳契約更穩定。

## 錯誤處理：`HTTPException`

```python
from fastapi import FastAPI, HTTPException

app = FastAPI()
FAKE_DB = {1: {"id": 1, "name": "Amy"}}


@app.get("/users/{user_id}")
def get_user(user_id: int):
    user = FAKE_DB.get(user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    return user
```

## 依賴注入（Dependency）入門

```python
from fastapi import Depends, FastAPI

app = FastAPI()


def get_current_user():
    return {"id": 1, "name": "Admin"}


@app.get("/me")
def me(user=Depends(get_current_user)):
    return user
```

這是 FastAPI 很重要的擴充點（認證、DB Session、設定注入）。

## 專案結構建議（入門版）

```text
src/
  main.py
  api/
    routes/
      items.py
      users.py
  schemas/
    item.py
    user.py
  services/
  repositories/
```

先分路由、資料模型、商業邏輯，可避免全部塞在 `main.py`。

## 小型 CRUD 範例（記憶體版）

```python
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

app = FastAPI()


class TodoIn(BaseModel):
    title: str = Field(min_length=1, max_length=100)


class Todo(TodoIn):
    id: int
    done: bool = False


TODOS: list[Todo] = []


@app.post("/todos", response_model=Todo)
def create_todo(payload: TodoIn):
    todo = Todo(id=len(TODOS) + 1, title=payload.title, done=False)
    TODOS.append(todo)
    return todo


@app.get("/todos", response_model=list[Todo])
def list_todos():
    return TODOS


@app.patch("/todos/{todo_id}", response_model=Todo)
def finish_todo(todo_id: int):
    for todo in TODOS:
        if todo.id == todo_id:
            todo.done = True
            return todo
    raise HTTPException(status_code=404, detail="Todo not found")
```

## 常見錯誤與排查

### 錯誤 1：`uvicorn` 路徑寫錯

`uvicorn src.main:app --reload` 中 `src.main` 是模組路徑，`app` 是物件名。

### 錯誤 2：把商業邏輯全寫在路由函式

短期可跑，長期難維護。  
修正：拆到 `services` / `repositories`。

### 錯誤 3：未定義 response model

回傳格式容易漂移。  
修正：關鍵 API 定義 `response_model`。

### 錯誤 4：沒有處理驗證與例外

修正：使用 Pydantic 驗證 + `HTTPException`。

## 開發習慣建議

- 每個 API 端點都寫清楚輸入與回傳模型。
- 用 `/docs` 自動文件做快速驗證。
- 每新增業務規則就補測試。
- 先做小而完整的 CRUD，再逐步擴充。

## 章末練習

- 必做：建立 `products` CRUD（至少 list/create/get）。
- 必做：為 `create` API 加上欄位驗證（字串長度、價格 > 0）。
- 選做：加一個簡易 token 驗證 dependency。

## 本章重點回顧

- FastAPI 讓你快速建立現代 API，並內建資料驗證與文件。
- Pydantic + `response_model` 是 API 契約穩定的關鍵。
- 你已具備從腳本進入後端服務開發的核心能力。
