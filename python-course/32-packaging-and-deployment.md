# 32｜專案打包與部署入門

> 這章會讓你把「本地可跑」的程式，變成「他人可安裝、可部署」的服務。這是從學習者走向可交付工程師的重要一步。

## 學習目標

- 理解 Python 專案打包的基本概念。
- 能建立 `pyproject.toml` 並以可編輯模式安裝專案。
- 掌握 Docker 化的基礎流程。
- 了解部署前檢查與常見上線風險。

## 前置條件

- 已完成 `20`（專案結構）與 `25`（FastAPI）會更好。

## 為什麼要打包

- 讓專案有明確入口與依賴定義。
- 其他人可用 `pip install` 安裝。
- CI/CD 與部署流程更標準化。

## `pyproject.toml` 最小範例

```toml
[build-system]
requires = ["setuptools>=68", "wheel"]
build-backend = "setuptools.build_meta"

[project]
name = "learnbyai-course-demo"
version = "0.1.0"
description = "Python course demo project"
requires-python = ">=3.11"
dependencies = [
  "fastapi",
  "uvicorn",
]
```

## 可編輯安裝（開發常用）

在專案根目錄：

```bash
pip install -e .
```

好處：

- 修改 `src` 程式碼不用重裝套件。
- 適合本地開發與測試。

## 設定 CLI 入口（可選）

```toml
[project.scripts]
lbai = "my_project.cli:main"
```

之後可直接用 `lbai` 指令啟動。

## 部署前檢查清單

- [ ] 所有測試通過（`pytest`）
- [ ] lint/format/type check 通過
- [ ] 環境變數與密鑰管理完成
- [ ] README 與啟動指令完整
- [ ] 例外處理、日誌、健康檢查可用

## Docker 基礎範例

建立 `Dockerfile`：

```dockerfile
FROM python:3.11-slim

WORKDIR /app

COPY pyproject.toml ./
COPY src ./src

RUN pip install --no-cache-dir -e .

EXPOSE 8000
CMD ["uvicorn", "src.main:app", "--host", "0.0.0.0", "--port", "8000"]
```

建置與執行：

```bash
docker build -t my-fastapi-app .
docker run -p 8000:8000 my-fastapi-app
```

## `.dockerignore` 建議

```text
.venv
__pycache__
.pytest_cache
.mypy_cache
.git
```

可減少映像大小與建置時間。

## 環境變數管理

部署時不要把敏感資訊硬編碼在程式。

```python
import os

db_url = os.getenv("DATABASE_URL")
if not db_url:
    raise RuntimeError("Missing DATABASE_URL")
```

## 常見部署目標（概念）

- **PaaS**：Render、Railway、Fly.io（新手友善）
- **雲端容器**：AWS ECS/GCP Cloud Run（較彈性）
- **自管主機**：Docker + Nginx + systemd（控制高、成本較高）

## CI/CD 入門流程

1. Push 到 GitHub
2. CI 自動跑測試與品質檢查
3. 通過後自動部署到 staging
4. 驗證完成再部署 production

## 健康檢查（Health Check）

部署服務建議加：

```python
@app.get("/healthz")
def healthz():
    return {"ok": True}
```

平台可用這個端點判斷服務是否健康。

## 版本與回滾策略

- 每次部署要有版本標記（tag 或 build number）。
- 發生嚴重問題時能快速回到上一版。
- 重大變更先灰度或 staging 驗證。

## 常見錯誤與排查

### 錯誤 1：本地可跑，容器不能跑

通常是路徑、依賴或環境變數問題。  
修正：在 Docker 中重現本地啟動流程。

### 錯誤 2：映像太大，部署慢

修正：用 slim base image、清理 cache、正確 `.dockerignore`。

### 錯誤 3：啟動命令寫錯

修正：確認 `uvicorn` module path 與 app 物件名稱正確。

### 錯誤 4：沒有健康檢查與日誌

修正：加 `/healthz`、結構化日誌、錯誤告警。

## 章末練習

- 必做：為你的 FastAPI 專案建立 `pyproject.toml` 與 `pip install -e .`。
- 必做：建立 Dockerfile，成功在本機容器啟動。
- 選做：新增 `/healthz` 與版本資訊端點。

## 本章重點回顧

- 打包是讓專案可安裝、可重用的基礎。
- Docker 化讓部署環境更一致、可重現。
- 你已具備把 Python 專案推向實際上線流程的入門能力。
