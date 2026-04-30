# 35｜專題實作 B：API 服務專題

> 這章會帶你做一個可部署的 API 專題，整合 FastAPI、SQLite、測試與文件，形成完整後端作品。

## 學習目標

- 能完成具備 CRUD 與驗證的 API 專案。
- 熟悉路由、服務層、儲存層分工。
- 能為 API 撰寫測試與基本錯誤處理。
- 能產出可展示給面試官的專題交付物。

## 前置條件

- 已完成 `25`（FastAPI）與 `26`（資料庫）。
- 已完成 `33`（專題規劃）。

## 專題題目示例：Todo API

核心功能：

- 新增任務
- 查詢任務（單筆/列表）
- 更新狀態
- 刪除任務

加值功能：

- 關鍵字搜尋
- 分頁
- 簡易 token 驗證

## 建議專案結構

```text
todo-api/
  src/
    app/
      main.py
      db.py
      models.py
      schemas.py
      repositories/
        todo_repo.py
      services/
        todo_service.py
      api/
        routes/
          todos.py
  tests/
    test_todos_api.py
  pyproject.toml
  README.md
```

## 步驟 1：資料模型與 schema

`models.py`（SQLAlchemy）：

```python
from sqlalchemy.orm import Mapped, mapped_column, DeclarativeBase
from sqlalchemy import Integer, String, Boolean


class Base(DeclarativeBase):
    pass


class Todo(Base):
    __tablename__ = "todos"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    title: Mapped[str] = mapped_column(String(100), nullable=False)
    done: Mapped[bool] = mapped_column(Boolean, default=False)
```

`schemas.py`（Pydantic）：

```python
from pydantic import BaseModel, Field


class TodoCreate(BaseModel):
    title: str = Field(min_length=1, max_length=100)


class TodoOut(BaseModel):
    id: int
    title: str
    done: bool
```

## 步驟 2：Repository 層

把資料存取集中，避免路由直接操作 DB。

```python
from sqlalchemy.orm import Session
from sqlalchemy import select
from app.models import Todo


def create_todo(db: Session, title: str) -> Todo:
    todo = Todo(title=title, done=False)
    db.add(todo)
    db.commit()
    db.refresh(todo)
    return todo


def list_todos(db: Session) -> list[Todo]:
    return list(db.scalars(select(Todo).order_by(Todo.id)))
```

## 步驟 3：Service 層

在 service 層放規則（例如不可建立重複標題）。

## 步驟 4：API 路由

`routes/todos.py`：

```python
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from app.db import get_db
from app.schemas import TodoCreate, TodoOut
from app.repositories import todo_repo

router = APIRouter(prefix="/todos", tags=["todos"])


@router.post("", response_model=TodoOut)
def create_todo(payload: TodoCreate, db: Session = Depends(get_db)):
    return todo_repo.create_todo(db, payload.title)


@router.get("", response_model=list[TodoOut])
def list_todos(db: Session = Depends(get_db)):
    return todo_repo.list_todos(db)


@router.patch("/{todo_id}", response_model=TodoOut)
def complete_todo(todo_id: int, db: Session = Depends(get_db)):
    todo = db.get(todo_repo.Todo, todo_id)
    if not todo:
        raise HTTPException(status_code=404, detail="Todo not found")
    todo.done = True
    db.commit()
    db.refresh(todo)
    return todo
```

## 步驟 5：主程式與啟動

`main.py`：

```python
from fastapi import FastAPI
from app.api.routes.todos import router as todos_router

app = FastAPI(title="Todo API")
app.include_router(todos_router)


@app.get("/healthz")
def healthz():
    return {"ok": True}
```

## 步驟 6：API 測試（pytest）

```python
from fastapi.testclient import TestClient
from app.main import app

client = TestClient(app)


def test_create_and_list_todo():
    r = client.post("/todos", json={"title": "write test"})
    assert r.status_code == 200
    created = r.json()
    assert created["title"] == "write test"

    r2 = client.get("/todos")
    assert r2.status_code == 200
    assert len(r2.json()) >= 1
```

## 步驟 7：文件與展示

README 建議包含：

- 系統架構圖（文字或簡圖）
- 啟動流程
- API 列表與範例
- 測試與品質檢查指令

## 常見加分點

- 分頁（`limit`, `offset`）
- 搜尋（`q`）
- 排序（`order_by`）
- 統一錯誤格式
- 健康檢查與版本端點

## 常見錯誤與排查

### 錯誤 1：路由層過重

修正：把規則搬到 service，DB 操作放 repository。

### 錯誤 2：資料驗證不足

修正：在 Pydantic schema 設定欄位限制。

### 錯誤 3：沒有測試錯誤情境

修正：補 404、422、空值等測試。

### 錯誤 4：文件不足

修正：README 與 `/docs` 都要可被新手理解。

## 驗收標準

- [ ] CRUD 端點可用
- [ ] 至少 5 個 API 測試
- [ ] 錯誤處理與狀態碼正確
- [ ] README 能讓他人快速啟動與驗證

## 章末練習

- 必做：完成 Todo API MVP（含資料庫）。
- 必做：加入分頁與關鍵字搜尋。
- 選做：加上簡易 token 驗證（Dependency）。

## 本章重點回顧

- API 專題是展示後端能力最直接的作品形式。
- 分層架構（route/service/repository）是可維護關鍵。
- 測試 + 文件 + 可部署性，決定作品專業度。
