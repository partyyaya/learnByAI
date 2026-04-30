# 26｜資料庫入門：SQLite 與 SQLAlchemy

> 這章會讓你的程式從「記憶體暫存」進化到「可持久化儲存」。你會學會 SQLite 基礎、SQLAlchemy ORM 與 CRUD 實作流程。

## 學習目標

- 理解資料庫、資料表、欄位、主鍵等基本概念。
- 能用 SQLite 建立本地資料庫並查詢資料。
- 熟悉 SQLAlchemy ORM 模型定義與 Session 操作。
- 能完成基本 CRUD（新增、查詢、更新、刪除）。

## 前置條件

- 已完成 `25`（FastAPI 基礎）會更容易整合。
- 了解 `dict/list` 與函式設計。

## 為什麼先學 SQLite

- 免安裝伺服器，單檔案即可使用。
- 很適合教學、小工具、原型開發。
- 後續可平滑遷移到 PostgreSQL/MySQL。

## 安裝 SQLAlchemy

```bash
pip install sqlalchemy
```

## 先看原生 SQLite（觀念）

```python
import sqlite3

conn = sqlite3.connect("app.db")
cur = conn.cursor()

cur.execute(
    """
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        age INTEGER NOT NULL
    )
    """
)

cur.execute("INSERT INTO users (name, age) VALUES (?, ?)", ("Amy", 20))
conn.commit()

cur.execute("SELECT id, name, age FROM users")
print(cur.fetchall())

conn.close()
```

這段能幫你理解 SQL 的本質，接著用 ORM 提升可維護性。

## ORM 是什麼

ORM（Object-Relational Mapping）可把資料表映射成 Python 類別。  
你操作類別與物件，ORM 幫你轉成 SQL。

## SQLAlchemy 2.x 基本設定

```python
from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, sessionmaker


class Base(DeclarativeBase):
    pass


engine = create_engine("sqlite:///app.db", echo=False)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)
```

## 定義資料模型

```python
from sqlalchemy import Integer, String
from sqlalchemy.orm import Mapped, mapped_column


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    age: Mapped[int] = mapped_column(Integer, nullable=False)
```

建立資料表：

```python
Base.metadata.create_all(bind=engine)
```

## CRUD 實作範例

```python
from sqlalchemy import select


def create_user(name: str, age: int) -> User:
    with SessionLocal() as db:
        user = User(name=name, age=age)
        db.add(user)
        db.commit()
        db.refresh(user)
        return user


def list_users() -> list[User]:
    with SessionLocal() as db:
        stmt = select(User).order_by(User.id)
        return list(db.scalars(stmt))


def update_user_age(user_id: int, age: int) -> User | None:
    with SessionLocal() as db:
        user = db.get(User, user_id)
        if not user:
            return None
        user.age = age
        db.commit()
        db.refresh(user)
        return user


def delete_user(user_id: int) -> bool:
    with SessionLocal() as db:
        user = db.get(User, user_id)
        if not user:
            return False
        db.delete(user)
        db.commit()
        return True
```

## 交易與 rollback 觀念

- `commit()`：確認寫入。
- 發生錯誤時需 `rollback()`，避免 Session 狀態混亂。

範例：

```python
def safe_create_user(name: str, age: int):
    with SessionLocal() as db:
        try:
            user = User(name=name, age=age)
            db.add(user)
            db.commit()
            db.refresh(user)
            return user
        except Exception:
            db.rollback()
            raise
```

## 在 FastAPI 中注入 DB Session（常見）

```python
from collections.abc import Generator
from sqlalchemy.orm import Session


def get_db() -> Generator[Session, None, None]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
```

路由中：

```python
from fastapi import Depends


@app.get("/users")
def list_users_api(db: Session = Depends(get_db)):
    return db.query(User).all()
```

## Migration（資料表版本管理）觀念

專案進入協作後，不建議一直用 `create_all` 自動調整。  
建議使用 `alembic` 做 migration 管理（新增欄位、修改結構有紀錄）。

## 常見錯誤與排查

### 錯誤 1：Session 沒關閉

長期會造成連線資源問題。  
修正：用 context manager 或 dependency 保障 close。

### 錯誤 2：忘記 commit

資料看起來新增成功，但重開程式就不見。  
修正：寫入操作後明確 `commit()`。

### 錯誤 3：模型與資料表不同步

修正：使用 migration 工具維護 schema 版本。

### 錯誤 4：直接拼接 SQL 字串

有 SQL injection 風險。  
修正：使用 ORM 或參數化查詢。

## 實務建議

- Repository 層集中資料存取，路由層不要直接寫大量 SQL。
- 核心查詢加索引與分頁，避免一次載入過多資料。
- 任何 DB 變更前先備份資料。

## 章末練習

- 必做：建立 `products` 表（id/name/price/stock）並完成 CRUD。
- 必做：在 FastAPI 中建立 `products` API，資料儲存在 SQLite。
- 選做：加入「價格不可為負」驗證與錯誤處理。

## 本章重點回顧

- SQLite 適合入門與原型，SQLAlchemy 提供更高可維護性。
- Session 與交易管理是資料庫穩定性的關鍵。
- 你已具備把 API 與資料庫串起來的核心能力。
