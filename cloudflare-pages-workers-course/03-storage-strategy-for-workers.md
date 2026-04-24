# 03｜儲存策略與資料設計

> 這章會把 KV、D1、R2、Durable Objects、Queues 的差異講清楚，讓你能依據資料特性做組合設計。

## 學習目標

- 了解 Cloudflare 常用儲存元件的定位與邊界。
- 能依「讀寫型態、查詢需求、一致性」做儲存選型。
- 能設計前端 + Workers 常見的混合儲存架構。

## 前置條件

- 已完成 `02` 章的方案選型。
- 理解基本資料庫觀念（主鍵、索引、查詢、交易）。

## 儲存選型速查

| 服務 | 擅長場景 | 不適合場景 |
|---|---|---|
| KV | 高讀取、低延遲、Key-Value 快取與設定 | 複雜查詢、強交易需求 |
| D1 | 關聯資料、SQL 查詢、中小型業務資料 | 大量二進位檔案、極大規模分析 |
| R2 | 檔案與物件儲存（圖片、報表、備份） | 需要 SQL 查詢的結構化資料 |
| Durable Objects | 單一實體強一致、聊天室/房間狀態 | 大量關聯查詢 |
| Queues | 非同步任務、解耦尖峰寫入 | 需要同步立即回應的查詢 |

## 前端產品最常見三種組合

### 組合 A：D1 + KV（推薦起手）

- D1 放核心業務資料（使用者、訂單、設定）。
- KV 放快取結果或 feature flag。
- 適合：大多數中小型 SaaS 前後端專案。

### 組合 B：D1 + R2 + Queues

- D1 放 metadata。
- R2 放圖片/附件。
- Queues 負責縮圖、轉檔、通知等背景作業。
- 適合：有檔案上傳流程的產品。

### 組合 C：Durable Objects + KV

- Durable Objects 維護單一房間或會話狀態。
- KV 做跨請求快取或設定分發。
- 適合：即時協作、聊天室、多人互動狀態同步。

## 選型決策問題（照順序問）

1. 你要存的是「結構化資料」還是「檔案」？
2. 你需要 SQL 查詢或交易嗎？
3. 是否需要單一實體強一致（例如房間狀態）？
4. 某些工作可否改成非同步（Queue）？
5. 哪些資料值得快取（KV）？

## 綁定設定範例（`wrangler.toml`）

```toml
name = "worker-api"
main = "src/index.js"
compatibility_date = "2026-04-24"

[[d1_databases]]
binding = "DB"
database_name = "app-db"
database_id = "replace-with-real-id"

[[kv_namespaces]]
binding = "CACHE"
id = "replace-with-real-kv-id"

[[r2_buckets]]
binding = "ASSETS"
bucket_name = "app-assets"
```

## Worker 端最小範例（D1 + KV）

```js
export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    if (url.pathname === "/api/profile") {
      const cacheKey = "profile:demo-user";
      const cached = await env.CACHE.get(cacheKey);
      if (cached) {
        return new Response(cached, {
          headers: { "content-type": "application/json" },
        });
      }

      const row = await env.DB.prepare(
        "SELECT id, name, email FROM users WHERE id = ?"
      )
        .bind("demo-user")
        .first();

      const payload = JSON.stringify(row ?? {});
      await env.CACHE.put(cacheKey, payload, { expirationTtl: 60 });
      return new Response(payload, {
        headers: { "content-type": "application/json" },
      });
    }

    return new Response("Not Found", { status: 404 });
  },
};
```

## 常見錯誤與排查

- **所有資料都塞到同一服務**：會讓可維護性與成本一起惡化。
- **沒設快取失效策略**：快取命中率低，反而增加複雜度。
- **同步流程塞太多工作**：可非同步的工作應交給 Queues。

## 章末練習

- 必做：為你的產品畫一張「資料分類圖」：核心資料、快取資料、檔案資料、非同步任務。
- 必做：寫出第一版儲存組合（例如 D1 + KV）與你不採用其他組合的理由。
- 選做：定義 2 個快取 key 命名規則與失效策略。

## 章節重點回顧

- 儲存選型沒有萬用解，一定要看資料型態與存取模式。
- 前端產品多半可從 D1 + KV 起步，再依需求擴展到 R2、Queues、DO。
- 下一階段將進入前端部署與實際串接流程。
