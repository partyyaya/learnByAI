# Nginx 完整教學課程

> 從零開始學習 Nginx，涵蓋基礎觀念、實務設定、效能調校到上線問題排查的完整課程。

---

## 課程目錄

| 章節 | 檔案 | 主題 |
|------|------|------|
| 01 | [01-introduction.md](./01-introduction.md) | Nginx 簡介與安裝 |
| 02 | [02-config-basics.md](./02-config-basics.md) | 設定檔結構與基礎語法 |
| 03 | [03-virtual-host.md](./03-virtual-host.md) | 虛擬主機（Server Block）設定 |
| 04 | [04-reverse-proxy.md](./04-reverse-proxy.md) | 反向代理（Reverse Proxy） |
| 05 | [05-load-balancing.md](./05-load-balancing.md) | 負載均衡（Load Balancing） |
| 06 | [06-ssl-https.md](./06-ssl-https.md) | SSL / HTTPS 憑證設定 |
| 07 | [07-performance.md](./07-performance.md) | 效能優化與快取策略 |
| 08 | [08-security.md](./08-security.md) | 安全性設定與防護 |
| 09 | [09-logging-monitoring.md](./09-logging-monitoring.md) | 日誌管理與監控 |
| 10 | [10-troubleshooting.md](./10-troubleshooting.md) | 上線網站問題排查 |
| 11 | [11-real-world-scenarios.md](./11-real-world-scenarios.md) | 實際情境與解決方案 |
| 12 | [12-high-availability.md](./12-high-availability.md) | 高可用架構與容災設計 |

---

## 課程特色

- **理論 + 實務並重**：每個章節都附有完整的設定範例
- **情境導向學習**：涵蓋開發到上線會遇到的真實問題
- **問題排查指南**：系統性的除錯流程，快速定位並解決問題
- **生產環境最佳實踐**：負載均衡、高可用、安全防護一次到位

## 適合對象

- 後端工程師想了解 Web Server 的運作原理
- DevOps / SRE 工程師需要管理 Nginx 部署
- 全端工程師想自己部署與維護網站
- 對網站上線流程有興趣的開發者

## 學習路線建議

```
基礎篇（必修）
  01 簡介與安裝 → 02 設定檔基礎 → 03 虛擬主機

進階篇（核心技能）
  04 反向代理 → 05 負載均衡 → 06 SSL/HTTPS

實戰篇（上線必備）
  07 效能優化 → 08 安全性設定 → 09 日誌與監控

高手篇（架構師之路）
  10 問題排查 → 11 實際情境 → 12 高可用架構
```

## 環境需求

- 作業系統：Linux（推薦 Ubuntu 22.04+）/ macOS / Windows（WSL2）
- Nginx 版本：1.24+（建議使用穩定版）
- 建議搭配工具：curl、openssl、htop、ab（Apache Bench）

---

> 準備好了嗎？讓我們從 [第一章：Nginx 簡介與安裝](./01-introduction.md) 開始吧！
