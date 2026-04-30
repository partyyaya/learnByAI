# 34｜專題實作 A：CLI 工具專題

> 這章會帶你完整做一個可展示的 CLI 專題。你會從需求、架構、功能實作到測試與打包，走完一個小型產品流程。

## 學習目標

- 能完成一個有實際用途的 CLI 工具。
- 熟悉 CLI 參數設計與子命令模式。
- 建立可維護的模組化專案結構。
- 補齊測試、文件與發布準備。

## 前置條件

- 已完成 `33` 專題規劃。
- 已具備 `argparse`、檔案 I/O、測試基礎。

## 專題題目示例：Task Tracker CLI

功能目標：

- 新增任務
- 列出任務
- 標記完成
- 刪除任務

資料儲存：本地 `JSON` 檔案。

## 建議專案結構

```text
task-tracker/
  src/
    task_tracker/
      __init__.py
      cli.py
      models.py
      service.py
      storage.py
  tests/
    test_service.py
  data/
    tasks.json
  README.md
  pyproject.toml
```

## 步驟 1：資料模型設計

`models.py`：

```python
from dataclasses import dataclass


@dataclass
class Task:
    id: int
    title: str
    done: bool = False
```

## 步驟 2：儲存層（JSON）

`storage.py`：

```python
import json
from pathlib import Path

DATA_PATH = Path("data/tasks.json")


def load_tasks() -> list[dict]:
    if not DATA_PATH.exists():
        return []
    return json.loads(DATA_PATH.read_text(encoding="utf-8"))


def save_tasks(tasks: list[dict]) -> None:
    DATA_PATH.parent.mkdir(parents=True, exist_ok=True)
    DATA_PATH.write_text(
        json.dumps(tasks, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
```

## 步驟 3：商業邏輯層

`service.py`：

```python
from .storage import load_tasks, save_tasks


def add_task(title: str) -> dict:
    tasks = load_tasks()
    next_id = max((t["id"] for t in tasks), default=0) + 1
    task = {"id": next_id, "title": title, "done": False}
    tasks.append(task)
    save_tasks(tasks)
    return task


def list_tasks() -> list[dict]:
    return load_tasks()


def complete_task(task_id: int) -> bool:
    tasks = load_tasks()
    updated = False
    for t in tasks:
        if t["id"] == task_id:
            t["done"] = True
            updated = True
            break
    if updated:
        save_tasks(tasks)
    return updated


def delete_task(task_id: int) -> bool:
    tasks = load_tasks()
    new_tasks = [t for t in tasks if t["id"] != task_id]
    if len(new_tasks) == len(tasks):
        return False
    save_tasks(new_tasks)
    return True
```

## 步驟 4：CLI 子命令設計

`cli.py`：

```python
import argparse
from .service import add_task, list_tasks, complete_task, delete_task


def main():
    parser = argparse.ArgumentParser(prog="task-tracker")
    sub = parser.add_subparsers(dest="command", required=True)

    p_add = sub.add_parser("add")
    p_add.add_argument("title")

    sub.add_parser("list")

    p_done = sub.add_parser("done")
    p_done.add_argument("id", type=int)

    p_del = sub.add_parser("delete")
    p_del.add_argument("id", type=int)

    args = parser.parse_args()

    if args.command == "add":
        task = add_task(args.title)
        print(f"新增成功: {task}")
    elif args.command == "list":
        for t in list_tasks():
            mark = "x" if t["done"] else " "
            print(f"[{mark}] {t['id']}: {t['title']}")
    elif args.command == "done":
        ok = complete_task(args.id)
        print("已完成" if ok else "找不到任務")
    elif args.command == "delete":
        ok = delete_task(args.id)
        print("已刪除" if ok else "找不到任務")


if __name__ == "__main__":
    main()
```

## 步驟 5：測試核心邏輯

`tests/test_service.py`（示意）：

```python
from task_tracker import service


def test_add_task(monkeypatch, tmp_path):
    fake_path = tmp_path / "tasks.json"

    monkeypatch.setattr("task_tracker.storage.DATA_PATH", fake_path)
    task = service.add_task("read docs")

    assert task["id"] == 1
    assert task["title"] == "read docs"
    assert task["done"] is False
```

## 步驟 6：README 與展示

README 至少包含：

- 安裝方式
- 指令範例（add/list/done/delete）
- 專案架構簡介
- 測試執行方式

## 進階加值功能（選做）

- 支援優先級與截止日期
- 支援關鍵字搜尋與篩選
- 匯出 CSV
- 加入顏色輸出（rich）

## 常見錯誤與排查

### 錯誤 1：CLI 與商業邏輯耦合

修正：CLI 只負責解析參數與輸出，邏輯放 service。

### 錯誤 2：ID 產生重複

修正：用 `max + 1` 並保證刪除後仍唯一。

### 錯誤 3：資料檔路徑不穩定

修正：集中在 storage 層管理，並加入可測試覆寫機制。

## 驗收標準（你可以用這個檢查）

- [ ] 四個核心指令可執行。
- [ ] 錯誤輸入有友善訊息。
- [ ] 至少 3 個核心測試通過。
- [ ] README 能讓他人 5 分鐘內跑起來。

## 章末練習

- 必做：按本章完成一個可用 CLI 工具 MVP。
- 必做：新增至少 2 個測試與 1 個錯誤情境處理。
- 選做：打包成可安裝指令（`pip install -e .` + entry point）。

## 本章重點回顧

- CLI 專題很適合展示你的工程基本功與實務落地能力。
- 成功關鍵是：分層、可測試、可執行、可說明。
- 你已具備完成第一個可展示作品的完整流程。
