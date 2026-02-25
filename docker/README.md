# Docker 完整教學課程

> 從零開始學習 Docker，涵蓋容器基礎、Dockerfile 撰寫、Docker Compose 編排到生產環境部署的完整課程。

---

## 課程目錄

| 章節 | 檔案 | 主題 |
|------|------|------|
| 01 | [01-introduction.md](./01-introduction.md) | Docker 簡介與安裝 |
| 02 | [02-images-containers.md](./02-images-containers.md) | 映像檔與容器基礎操作 |
| 03 | [03-dockerfile.md](./03-dockerfile.md) | Dockerfile 撰寫與映像建構 |
| 04 | [04-docker-compose.md](./04-docker-compose.md) | Docker Compose 多容器編排 |
| 05 | [05-networking-volumes.md](./05-networking-volumes.md) | Docker 網路與資料持久化 |
| 06 | [06-dev-environment.md](./06-dev-environment.md) | 開發環境實戰案例 |
| 07 | [07-registry-image-mgmt.md](./07-registry-image-mgmt.md) | Registry 與映像管理 |
| 08 | [08-debugging-troubleshooting.md](./08-debugging-troubleshooting.md) | 除錯與問題排查 |
| 09 | [09-security.md](./09-security.md) | 安全性最佳實踐 |
| 10 | [10-production-cicd.md](./10-production-cicd.md) | 生產環境部署與 CI/CD |

---

## 課程特色

- **理論 + 實務並重**：每個章節都附有完整的設定範例與可執行的指令
- **Dockerfile 深度解析**：從基礎語法到 Multi-stage Build 的最佳實踐
- **Docker Compose 完整教學**：單機多容器編排、服務相依性管理、環境變數配置
- **情境導向學習**：涵蓋開發到部署會遇到的真實問題與解決方案
- **問題排查指南**：系統性的除錯流程，快速定位並解決容器化常見問題

## 適合對象

- 後端工程師想將應用程式容器化
- DevOps / SRE 工程師需要管理容器化部署
- 全端工程師想用 Docker 統一開發環境
- 對 CI/CD 與容器化部署有興趣的開發者

## 學習路線建議

```
基礎篇（必修）
  01 簡介與安裝 → 02 映像檔與容器操作 → 03 Dockerfile 撰寫

編排篇（核心技能）
  04 Docker Compose → 05 網路與資料持久化 → 06 開發環境實戰

維運篇（上線必備）
  07 Registry 與映像管理 → 08 除錯與問題排查 → 09 安全性設定

進階篇（架構師之路）
  10 生產環境部署與 CI/CD
```

## 環境需求

- 作業系統：macOS / Linux（推薦 Ubuntu 22.04+）/ Windows（WSL2）
- Docker Engine：24.0+（建議使用最新穩定版）
- Docker Compose：V2（已內建於 Docker Desktop）
- 建議搭配工具：curl、jq、dive（映像分析）、lazydocker（TUI 管理工具）

---

> 準備好了嗎？讓我們從 [第一章：Docker 簡介與安裝](./01-introduction.md) 開始吧！
