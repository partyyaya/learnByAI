# 第 06 章：版本控管與相容性

> 前面五章教你怎麼把 API 設計對。這一章教你**在設計錯了之後怎麼活下去**。
> 因為你一定會設計錯 —— 需求會變、業務會轉向、三年前的假設會失效。
> 真正區分「能維護五年的 API」和「三個月就要重寫的 API」的，不是第一版設計得多好，
> 而是**它能不能在不打壞任何 consumer 的前提下持續演進**。
>
> 這一章的核心主張只有一句：**大部分你以為需要開 v2 的變更，其實不需要。**

---

## 6.1 學習目標

完成本章後，你應該可以：

- 算出「開一個 v2」的真實成本，並解釋為什麼它是最後手段而不是預設手段。
- 用一張完整的判定表，在 30 秒內判斷任何變更是不是破壞性的。
- 說出「取決於客戶端實作」的六種灰色變更，以及如何用 Consumer Contract 把灰色變成黑白。
- 撰寫一份 **Consumer Contract**：你對客戶端的要求，以及你給客戶端的保證。
- 比較四種版本策略（URL / Header / 日期 / 查詢參數），並說出 Stripe、GitHub、Twilio、Azure 各自為什麼那樣選。
- 用 **Expand–Contract** 六步流程完成欄位改名、型別變更、拆分、合併、必填性變更，全程不開新版本。
- 設計完整的棄用流程：`Deprecation` / `Sunset` header、用量監控、漸進降級（brownout）。
- 在 CI 上自動偵測破壞性變更（OpenAPI diff）。
- 說明資料庫 schema 遷移為什麼是同一個問題，並用同一套六步流程處理。
- 完成 shop-service 的版本策略、PR checklist 與棄用登記表。

---

## 6.2 版本控管的真實成本

### 6.2.1 先算「開 v2」要花多少錢

大部分團隊對「出 v2」的想像是「複製一份 Controller，改一下」。實際成本清單：

| 項目 | 一次性成本 | 持續成本（每個月） |
|---|---|---|
| 複製／改寫 Controller + DTO | 3～10 人天 | — |
| 兩套 mapper（v1 DTO ↔ 領域 ↔ v2 DTO） | 2～5 人天 | 每次領域模型變更都要改兩處 |
| 兩套測試 | 3～8 人天 | 每次業務邏輯變更都要改兩套測試 |
| 兩套 OpenAPI 文件 | 1～3 人天 | 每次改欄位都要同步兩份 |
| 兩套錯誤碼對映 | 1 人天 | — |
| 監控／告警要分版本切 | 1～2 人天 | 每個面板都要多一個維度 |
| 通知所有 consumer + 遷移支援 | 2～5 人天 | 回答「v1 和 v2 差在哪」的工單 |
| 灰度／路由設定 | 1～2 人天 | — |
| **合計** | **14～36 人天** | **每次變更多 30～60% 的工作量** |

**而且最貴的不是這些，是「認知成本」**：

```
新人問：「訂單狀態的邏輯要改，我改哪裡？」
答：「v1 的 OrderController 和 v2 的 OrderV2Controller，
     還有 v1 專用的 OrderStatusLegacyMapper，
     但 v2 的狀態機在 OrderStateMachine，
     v1 是用舊的 if-else 版本因為當初沒重構⋯⋯」
```

**這個對話會在你的專案裡重複 N 年。**

### 6.2.2 「先做 v1，改壞了再出 v2」為什麼是最貴的策略

這個想法的問題在於：**它假設 v2 之後就不會再錯。**

實際軌跡：

```
2024 Q1  上線 v1
2024 Q4  發現 v1 的訂單狀態設計不夠用 → 出 v2
2025 Q2  發現 v2 的金額欄位型別有問題 → 出 v3
2025 Q4  App 還有 8% 在用 v1，廠商 A 還在 v1，廠商 B 在 v2
         → 三套並存
2026 Q2  領域模型要大改 → 三套 mapper 都要改 → 沒人敢動
2026 Q3  決定「凍結 v1、v2，只在 v3 加功能」
         → 但 v1 的 bug 還是要修（有人在用）
         → 修一個 bug 要在三個地方驗證
```

**這叫「版本債」，而且它是複利的。**

**正確的心態轉換**：

| ❌ 舊心態 | ✅ 新心態 |
|---|---|
| 版本是「改介面」的工具 | 版本是「**放棄相容性**」的最後手段 |
| 有需求就開新版本 | **先問：能不能用「加」達成？** |
| v2 上線後 v1 就可以砍 | v1 要活到「用量歸零」，可能 2～5 年 |
| 版本號代表進步 | 版本數量代表**技術債的數量** |

**業界的實證**：

| 服務 | 主版本數 | 存在多久 |
|---|---|---|
| **Stripe** | 從 2011 年至今**沒有 v2** | 13+ 年 —— 全靠日期版本 + Expand-Contract |
| **Twilio** | `/2010-04-01/` 用到現在 | 14+ 年沒換過路徑版本 |
| **GitHub REST** | v3 用了十年，v4 是 GraphQL（不是 REST v4） | — |
| **Slack** | 沒有版本號 | 靠「只加不改」 |

**這些是全世界最複雜、consumer 最多的 API，而它們幾乎不出新主版本。**
不是因為它們不變 —— 是因為它們用 6.7 的手法變。

### 6.2.3 為什麼語意化版本（SemVer）不適用於 API

```
SemVer：MAJOR.MINOR.PATCH
        破壞性.新功能.修 bug
```

**問題**：對 HTTP API 的 consumer 來說，`MINOR` 和 `PATCH` 是**不可見的**。

```
你發布 v1.3.0（新增了一個欄位）
→ consumer 要不要改 URL？不用
→ consumer 需要知道嗎？看文件就好
→ 那這個版本號給誰看的？
```

**結論**：API 的**外部**版本只需要標示「破壞性變更」，
所以只有 `MAJOR`（`/v1`、`/v2`）或日期（`2026-08-19`）有意義。

`MINOR` / `PATCH` 屬於**內部**版本（你的 jar 版本、changelog），
和 URL 無關。

> ⚠️ **不要做 `/v1.2/orders`**。這會讓 consumer 以為每次小改都要換 URL，
> 而且你會被迫維護幾十個「版本」。

---

## 6.3 破壞性變更判定表 ★ 本章最重要的產出

**判準：這個變更會讓「一個正確實作了 Consumer Contract 的既有客戶端」壞掉嗎？**

（Consumer Contract 見 6.4。沒有它，這個判準無法運作 —— 這是本章的關鍵洞察。）

### 6.3.1 Request 方向（客戶端送給你的）

| 變更 | 破壞性？ | 說明 |
|---|---|---|
| 新增**選填**欄位 | ✅ 安全 | 舊客戶端不送，走預設值 |
| 新增**必填**欄位 | 🔴 **破壞** | 舊客戶端不送 → `422` |
| 移除欄位 | ⚠️ 看實作 | 若「忽略未知欄位」→ 安全；若「未知欄位回 400」→ 破壞 |
| 欄位**必填 → 選填** | ✅ 安全 | 放寬 |
| 欄位**選填 → 必填** | 🔴 **破壞** | 收緊 |
| 欄位改名 | 🔴 **破壞** | 等於「移除舊 + 新增必填」 |
| 型別放寬（`int` → `int \| string`） | ✅ 安全 | 舊值仍可接受 |
| 型別收緊（`string` → `int`） | 🔴 **破壞** | |
| 驗證規則放寬（`max=50` → `max=100`） | ✅ 安全 | |
| 驗證規則收緊（`max=100` → `max=50`） | 🔴 **破壞** | 舊客戶端送 80 就掛 |
| 列舉**新增**可接受值 | ✅ 安全 | 舊客戶端不會送新值 |
| 列舉**移除**可接受值 | 🔴 **破壞** | 舊客戶端可能還在送 |
| 新增端點 | ✅ 安全 | |
| 移除端點 | 🔴 **破壞** | |
| 支援新的 `Content-Type` | ✅ 安全 | |
| 移除支援的 `Content-Type` | 🔴 **破壞** | |
| 查詢參數改名 | 🔴 **破壞** | ⚠️ 而且如果「未知參數靜默忽略」→ **靜默破壞**（第 05 章 5.8.6） |
| 新增速率限制 | ⚠️ 看額度 | 若額度高於現有用量 → 實質安全；否則破壞 |
| 開始要求 `Idempotency-Key` | 🔴 **破壞** | 舊客戶端不帶 → `400` |

### 6.3.2 Response 方向（你回給客戶端的）

| 變更 | 破壞性？ | 說明 |
|---|---|---|
| 新增欄位 | ✅ 安全※ | ※ 前提：客戶端忽略未知欄位（6.4） |
| 移除欄位 | 🔴 **破壞** | |
| 欄位改名 | 🔴 **破壞** | |
| 欄位**可能為 `null` → 一定有值** | ✅ 安全 | 放寬 |
| 欄位**一定有值 → 可能為 `null`／省略** | 🔴 **破壞** | 客戶端的非 optional 型別會炸（Swift `Codable`、Kotlin non-null） |
| 型別變更（`number` → `string`） | 🔴🔴 **靜默破壞** | 最危險（第 00 章 0.8.2） |
| **單位/語意變更**（元 → 分） | 🔴🔴 **靜默破壞** | 最危險，且不會拋錯 |
| 陣列 → 單一物件（或反之） | 🔴 **破壞** | |
| 巢狀層級變更（扁平 ↔ 巢狀） | 🔴 **破壞** | |
| 列舉**新增**可能回傳的值 | ⚠️ 看實作 | 若有 `default` 分支 → 安全；否則破壞（第 00 章 0.8.3 的災難） |
| 列舉**移除**可能回傳的值 | ✅ 通常安全 | 客戶端的 case 只是用不到。⚠️ 但 Kotlin `when` / TS exhaustive check 可能編譯失敗 |
| 陣列元素順序變更 | ⚠️ 看契約 | 若文件沒承諾順序 → 安全；但客戶端可能已依賴 |
| 集合的**預設排序**變更 | 🔴 **破壞** | 分頁遍歷會重複／漏（第 05 章 5.9.3） |
| 分頁預設 `size` 變小 | ⚠️ 通常安全 | 但「一次拉全部」的客戶端會壞 |
| 分頁 `page` 0-based ↔ 1-based | 🔴🔴 **靜默破壞** | 第 05 章 5.3.3 的對帳災難 |
| 成功狀態碼變更（`200` → `201`） | ⚠️ 看實作 | 若客戶端檢查 `status === 200` → 破壞；若 `res.ok` → 安全 |
| 錯誤狀態碼變更（`400` → `422`） | ⚠️ 看實作 | 同上 |
| 新增可能回傳的錯誤狀態碼 | ⚠️ 看實作 | 客戶端要有 fallback |
| 新增錯誤 `code` | ⚠️ 看實作 | 同列舉：要有 fallback（顯示 `userMessage`） |
| 移除錯誤 `code` | ✅ 通常安全 | |
| 改 `userMessage` 文案 | ✅ 安全 | 只要客戶端不用訊息內容做判斷（6.4） |
| 改 `detail` 內容 | ✅ 安全 | |
| 新增 `Link` / `ETag` 等 header | ✅ 安全 | ⚠️ 但跨來源要記得 `Access-Control-Expose-Headers` |
| 移除 header | 🔴 **破壞** | |
| 開始回 `304`（原本總是 `200`） | ⚠️ 看實作 | 客戶端若沒處理 `304` 會以為是錯誤 |
| 加入 `Cache-Control: max-age` | ⚠️ 小心 | 客戶端可能拿到過期資料 → 「為什麼我改了沒生效」 |
| 效能變慢（P99 從 100ms → 3s） | 🔴 **實質破壞** | 客戶端的超時設定會觸發 |

### 6.3.3 三種「最危險」的變更

**這三種要用紅字寫在你的 PR checklist 上**：

| # | 變更 | 為什麼最危險 |
|---|---|---|
| 1 | **型別變更** | 不拋錯。`total + amount` 從加法變字串拼接，畫面顯示錯的數字 |
| 2 | **單位／語意變更** | 不拋錯。「元 → 分」讓所有金額 ×100，財務三天後才發現 |
| 3 | **分頁基準／排序變更** | 不拋錯。遍歷時重複或漏資料，資料寫進廠商帳務系統 |

**共同特徵：客戶端「成功地」拿到了「錯誤的」資料。**

**規則：改語意必須改名字。**（第 00 章 0.8.3 已提，這裡是它的完整理由。）

```
❌ amount: 1280.00（元） → amount: 128000（分）
   → 已改的客戶端和沒改的客戶端「都是壞的」，而且無法偵測

✅ 新增 amountMinor: 128000，保留 amount: 1280.00
   → 兩種客戶端都是對的
   → 而且你可以監控「還有誰在讀 amount」（6.8.3）
```

### 6.3.4 判定流程圖

```
                    我要改一個東西
                          │
          ┌───────────────┴───────────────┐
          │  這是「加東西」嗎？             │
          └───────────────┬───────────────┘
              是 │                    │ 否
                 ▼                    ▼
     ┌─────────────────────┐   ┌──────────────────────────┐
     │ 加的是 Request 的    │   │ 這是「改」還是「減」？      │
     │ 必填欄位嗎？          │   └────┬──────────────┬──────┘
     └──┬───────────┬──────┘     改 │              │ 減
     是 │           │ 否             ▼              ▼
        ▼           ▼        ┌──────────────┐  ┌──────────┐
   🔴 破壞性     ✅ 安全      │ 改的是型別／  │  │ 🔴 破壞性 │
   → 6.7        （但仍要      │ 單位／語意？  │  │ → 6.7    │
                 遵守 6.4）   └──┬───────┬───┘  └──────────┘
                              是 │       │ 否
                                 ▼       ▼
                        🔴🔴 靜默破壞  ⚠️ 查 6.3.2 表
                        → 必須改名字   → 看 Consumer
                        → 6.7          Contract 有沒有
                                       覆蓋這一項
```

**最後一格是關鍵**：很多「⚠️ 看實作」的變更，
只要你的 **Consumer Contract 明確要求過**，就變成「✅ 安全」。

**這就是下一節的價值。**

---

## 6.4 Consumer Contract：把灰色變成黑白

### 6.4.1 問題：一半的變更「取決於客戶端怎麼寫」

```
新增一個列舉值 PARTIALLY_SHIPPED
→ 有 default 的客戶端：沒事
→ 沒 default 的客戶端：狀態欄空白（第 00 章 0.8.3）
```

**如果你沒有明確要求過「必須有 default」，那這是你的問題。**
如果你要求過、文件寫過、提供過測試工具（第 03 章 3.10.2），
那這是客戶端沒遵守契約 —— **你可以放心新增列舉值。**

**Consumer Contract 的本質是：把「相容性」從一個模糊的道德問題，變成一份雙向的明確約定。**

### 6.4.2 shop-service 的 Consumer Contract

放在文件的最前面（也放進 OpenAPI 的 `info.description`）：

```markdown
# Consumer Contract（客戶端契約）

本 API 承諾遵守以下相容性規則。作為交換，我們要求客戶端遵守下列實作要求。
**未遵守要求的客戶端，可能因為我們的「非破壞性變更」而故障 —— 那不在我們的相容性保證範圍內。**

## 我們的保證（Our Guarantees）

1. **不移除欄位**：已發布的回應欄位不會被移除或改名。
2. **不改變型別與單位**：欄位的 JSON 型別、單位、時區、語意一經發布即固定。
   若需改變，我們會**新增一個不同名字的欄位**，並依 §棄用流程 退場舊欄位。
3. **不改變 URL 與方法**：已發布的端點路徑與 HTTP 方法不變。
4. **不收緊 Request 驗證**：不會把選填欄位變必填、不會縮小允許的值域。
5. **不改變分頁基準**：`page` 永遠 0-based。集合的預設排序不變。
6. **錯誤的 `code` 語意固定**：`code` 一經發布，其語意與對應的 HTTP 狀態碼不變。
7. **退場前必有公告期**：任何欄位／端點的移除，至少提前 **180 天** 公告，
   並在回應中附上 `Deprecation` 與 `Sunset` header。

## 我們可能做的事（Non-Breaking Changes We Will Make）

以下變更**不另行公告**，可能隨時發生。請確保你的客戶端能承受：

1. **新增回應欄位** —— 隨時可能發生。
2. **新增列舉值** —— `status`、`code`、`paymentMethod` 等會持續擴充。
3. **新增錯誤 `code` 與 HTTP 狀態碼** —— 新的業務規則會帶來新的錯誤。
4. **修改 `title`、`detail`、`userMessage` 的文案** —— 隨時可能調整。
5. **新增選填的 Request 欄位與查詢參數**。
6. **新增回應 header**。
7. **調整回應中欄位的 JSON 順序、空白、縮排**。
8. **調整 `Cache-Control` 與 `ETag` 的值**。

## 我們對你的要求（Your Obligations）

| # | 要求 | 不遵守的後果 |
|---|---|---|
| 1 | **忽略未知欄位** | 新增欄位時你的解析會失敗 |
| 2 | **處理未知列舉值**：`switch` 必有 `default`；顯示請優先用 `statusLabel`、邏輯請用 `allowedActions` / `statusCategory` | 新增狀態時你的畫面空白或 crash |
| 3 | **處理未知錯誤 `code`**：fallback 顯示 `userMessage` | 新增錯誤時你顯示不出訊息 |
| 4 | **用 `code` 做程式判斷，不要用 `title` / `detail` / `userMessage` 的文字** | 我們改文案時你的邏輯壞掉 |
| 5 | **用狀態碼類別判斷**（`res.ok`、`status >= 500`），不要 `status === 200` | 我們從 `200` 改成 `201` 時你壞掉 |
| 6 | **不要依賴陣列元素順序**，除非文件明確承諾 | 排序最佳化時你壞掉 |
| 7 | **不要依賴回應的 JSON 字串形式**（不要對 body 做字串比對或雜湊） | 欄位順序變更時你壞掉 |
| 8 | **分頁請跟著 `links.next` 走**，不要自己組 `page+1` | 我們調整分頁機制時你壞掉 |
| 9 | **不要用 `items.length < size` 判斷結束**，請用 `hasMore` | 我們夾取 `size` 時你少拿資料（第 05 章 5.2.4） |
| 10 | **關鍵寫入操作必須帶 `Idempotency-Key`** | 網路重試時可能重複扣款 |
| 11 | **重試必須用指數退避 + 抖動**，並遵守 `Retry-After` | 你的重試會變成對我們的 DDoS |
| 12 | **儲存 ID 請用字串**，不要當數字處理 | 大數字精度遺失（第 01 章 1.4.5） |
| 13 | **時間請當 UTC Instant 處理**，顯示時才轉當地時區 | 跨時區顯示錯誤 |
| 14 | **金額請用 decimal 函式庫**，不要用浮點數運算 | 累加誤差 |
| 15 | **訂閱我們的 CHANGELOG 與棄用公告** | 錯過退場期限 |

## 我們提供的工具

| 工具 | 用途 |
|---|---|
| `GET /v1/openapi.yaml` | 機器可讀的契約 |
| `https://api.shop.example/changelog` | 所有變更公告（含 RSS） |
| `GET /v1/deprecations` | 目前所有已棄用項目與退場日期 |
| Staging 環境的 `?_injectUnknownEnum=<field>` | **讓你能真的測試「未知列舉值」**（第 03 章 3.10.2） |
| Staging 環境的 `?_injectUnknownField=true` | 回應會多一個 `__test_unknown_field` 欄位，測試你的解析器 |
| Prism mock server（見第 07 章） | 用契約起 mock，不用等我們 |
```

### 6.4.3 為什麼「提供測試工具」是這份契約的關鍵

**光寫「請處理未知列舉值」沒有人會做。**

**必須讓 consumer 能「真的測到」**：

```http
# Staging 環境專用（正式環境不提供）
GET /orders?_injectUnknownEnum=status
Authorization: Bearer <staging token>

→ 200 OK
{
  "items": [
    { "orderId": "ord_...", "status": "__FUTURE_STATUS_FOR_TESTING__",
      "statusLabel": "（測試用未知狀態）", "statusCategory": "IN_PROGRESS",
      "allowedActions": [], ... }
  ]
}
```

**這讓 consumer 可以寫一個自動化測試**：

```typescript
// consumer 的測試
it('未知的訂單狀態不會讓畫面爆掉', async () => {
  const res = await api.get('/orders?_injectUnknownEnum=status');
  const { container } = render(<OrderList orders={res.items} />);
  expect(container).not.toHaveTextContent('undefined');
  expect(container).not.toHaveTextContent('NaN');
  // 應該顯示 statusLabel 而不是空白
  expect(container).toHaveTextContent('（測試用未知狀態）');
});
```

**投報率極高的一個功能**：幾十行程式碼，換來「你可以自由新增列舉值」。

### 6.4.4 Postel's Law（穩健性原則）

```
Be conservative in what you send, be liberal in what you accept.
（保守地發送，寬容地接收）
```

**應用到 API 的兩側**：

| | 你（伺服器） | Consumer |
|---|---|---|
| **發送時保守** | 只回文件承諾的欄位／格式；不回不該有的東西 | 只送文件定義的欄位 |
| **接收時寬容** | 忽略未知的 Request 欄位（第 03 章 3.13.4） | 忽略未知的 Response 欄位 |

**⚠️ 但「寬容」有限度**（這是常被誤用的地方）：

```
✅ 寬容：忽略未知欄位
✅ 寬容：接受 "2026-08-19" 和 "2026-08-19T00:00:00Z" 兩種日期格式
❌ 過度寬容：接受 amount: "1,280.50"（含逗號）→ 猜使用者的意思
❌ 過度寬容：status 大小寫不敏感 → 之後想加 case-sensitive 的值就不行了
❌ 過度寬容：未知的查詢參數靜默忽略 → 第 05 章 5.8.6 的災難
```

**判準：寬容應該用在「無關緊要的差異」，不能用在「會影響語意的猜測」。**

「猜使用者的意思」會變成事實上的契約 —— 你之後想收緊就是破壞性變更。

---

## 6.5 四種版本策略

### 6.5.1 策略 A：URL 路徑版本

```http
GET /v1/orders
GET /v2/orders
```

**誰在用**：Twilio（`/2010-04-01/`）、Facebook Graph（`/v18.0/`）、大部分企業內部 API。

| 優點 | 缺點 |
|---|---|
| ★ 最直觀（一看就知道版本） | 違反「同一個資源一個 URI」（同一筆訂單有兩個 URL） |
| 路由層可分流（Nginx / Gateway 直接切） | 版本升級要改所有 URL（客戶端改動大） |
| 可以完全獨立部署兩個版本的服務 | 快取要分兩份 |
| 用 `curl` 測試最方便 | 鼓勵「整站升版」而不是「漸進遷移」 |
| 文件與 SDK 好分版本 | — |

### 6.5.2 策略 B：Header 版本

**B-1：自訂 header**

```http
GET /orders
X-Api-Version: 2
```

**誰在用**：GitHub（`X-GitHub-Api-Version: 2022-11-28`）、Azure DevOps。

**B-2：`Accept` media type（內容協商）**

```http
GET /orders
Accept: application/vnd.shop.v2+json
```

**誰在用**：GitHub（`Accept: application/vnd.github+json`）、部分「純 REST」派系。

| 優點 | 缺點 |
|---|---|
| ★ URL 乾淨，同一個資源一個 URI（符合 REST） | 🔴 **不能貼連結**（`curl` 要多打 `-H`） |
| 可以按端點漸進遷移 | 🔴 **瀏覽器直接開會拿到預設版本**（除錯困難） |
| — | ⚠️ 快取必須 `Vary: X-Api-Version`（漏了 → 快取污染） |
| — | ⚠️ 很多代理／CDN 不會把自訂 header 納入快取鍵 |
| — | ⚠️ CORS preflight（第 02 章 2.7.2） |
| — | 文件工具支援較差 |

### 6.5.3 策略 C：日期版本 ★ Stripe 模式

```http
POST /v1/charges
Stripe-Version: 2024-06-20
```

**核心機制不只是「用日期」，而是三件事的組合**：

```
① 版本用「發布日期」標示，而不是遞增數字
② 每個帳號（API key）有一個「釘住的預設版本」
   → 客戶端不帶 header 時，用他註冊當天的版本
   → 所以「不改任何程式碼」的客戶端永遠不會壞
③ 升級是「顯式的、每個帳號自己決定的」
   → 客戶端在 dashboard 上按一個按鈕升級，或在請求裡帶 header 測試
```

**這個組合為什麼強大**：

| 問題 | Stripe 的解法 |
|---|---|
| 「我不想改程式碼」 | 不改就永遠用舊版本（釘住） |
| 「我想試新版本」 | 帶一次 header 就能試，不影響其他請求 |
| 「我升級到一半發現有問題」 | 改回舊 header，或 dashboard 回滾 |
| 「我有 50 個微服務要逐步遷移」 | 每個服務各自帶 header 遷移 |
| 「你們有幾個版本？」 | 幾十個 —— 但**每個都只是一組轉換規則**，不是一整套程式碼 |

**⚠️ 實作代價**：Stripe 內部維護的是**一條「版本轉換鏈」**：

```
內部領域模型（最新）
    ↓ 套用 2024-06-20 的轉換
    ↓ 套用 2024-04-10 的轉換
    ↓ 套用 2023-10-16 的轉換
    ↓ ...
輸出給釘在 2023-10-16 的客戶端
```

每次破壞性變更 = 寫**一個轉換函式**（把新格式轉回舊格式），
而不是**複製一整套 Controller**。

**這是關鍵的架構差異**：

| | 路徑版本（複製程式碼） | 日期版本（轉換鏈） |
|---|---|---|
| 新增一個版本的成本 | 複製一整套 Controller/DTO/測試 | 寫一個轉換函式 + 測試 |
| 領域邏輯變更時 | 要改 N 套 | 只改一套 |
| 版本數量的可承受度 | 2～3 個就痛苦 | 幾十個仍可管理 |
| 實作複雜度 | 低（但重複） | ★ 高（要設計轉換框架） |

**Java 的簡化實作草稿**：

```java
public interface ResponseTransformer {
    /** 這個轉換適用於「釘住版本 < effectiveFrom」的客戶端 */
    LocalDate effectiveFrom();
    /** 把新格式轉回舊格式 */
    ObjectNode downgrade(ObjectNode current, String resourceType);
}

@Component
public class AmountMinorToDecimalTransformer implements ResponseTransformer {
    @Override public LocalDate effectiveFrom() { return LocalDate.of(2026, 9, 1); }

    @Override
    public ObjectNode downgrade(ObjectNode node, String resourceType) {
        if (!"order".equals(resourceType)) return node;
        // 2026-09-01 之後我們改用 amountMinor（整數分）
        // 對舊客戶端，把它轉回 amount（decimal 字串）
        if (node.has("amountMinor")) {
            long minor = node.get("amountMinor").asLong();
            node.put("amount", BigDecimal.valueOf(minor, 2).toPlainString());
            node.remove("amountMinor");
        }
        return node;
    }
}

@Component
public class VersionTransformChain {
    private final List<ResponseTransformer> transformers;   // 按 effectiveFrom 降序排列

    public ObjectNode apply(ObjectNode latest, LocalDate clientVersion, String type) {
        ObjectNode out = latest;
        for (ResponseTransformer t : transformers) {
            if (clientVersion.isBefore(t.effectiveFrom())) {
                out = t.downgrade(out, type);       // ★ 逐層往回轉
            }
        }
        return out;
    }
}
```

**⚠️ 誠實的評估**：這個架構很優雅，但它要求：
- 統一的序列化管線（所有回應都要經過轉換層）。
- 每個轉換函式都要有測試（而且是**跨版本**的測試矩陣）。
- 團隊有紀律（每次破壞性變更都寫轉換，不能偷懶）。

**小團隊做不起來。** Stripe 有專門的團隊維護這個。

### 6.5.4 策略 D：查詢參數版本

```http
GET /orders?api-version=2026-08-19
```

**誰在用**：Azure（幾乎所有 Azure REST API 都是 `?api-version=`）。

| 優點 | 缺點 |
|---|---|
| 可以貼連結 | 🔴 版本混在業務參數裡，語意混亂 |
| 不需要改路徑 | ⚠️ 容易忘記帶（Azure 的做法是**強制必填**，不帶就 `400`） |
| 快取天然分開（在 URL 裡） | 每個請求都要多帶一個參數 |

**Azure 的一個好做法值得學**：**`api-version` 是必填的**。

```http
GET /orders
→ 400 Bad Request
{ "code": "API_VERSION_REQUIRED",
  "userMessage": "請指定 api-version 參數。",
  "hint": "目前支援的版本：2026-08-19（最新）、2025-11-01",
  "supportedVersions": ["2026-08-19", "2025-11-01"] }
```

**強制必填的好處**：不會有「客戶端不知道自己在用哪個版本」的情況。
**壞處**：對新手不友善（第一個請求就失敗）。

### 6.5.5 完整比較表

| 面向 | A. URL 路徑 | B. Header | C. 日期 + 釘住 | D. 查詢參數 |
|---|---|---|---|---|
| 可貼連結／`curl` 友善 | ★★★ | ★ | ★★ | ★★★ |
| URL 乾淨（REST 純度） | ★ | ★★★ | ★★★ | ★★ |
| 路由層可分流 | ★★★ | ★★ | ★ | ★★ |
| 快取正確性 | ★★★ | ★（要 `Vary`） | ★（要 `Vary`） | ★★★ |
| 漸進遷移（按端點） | ★ | ★★★ | ★★★ | ★★ |
| 「不改程式碼就不會壞」 | ★★★ | ★★ | ★★★ | ★★★ |
| 實作複雜度 | ★★★（低） | ★★ | ★（高） | ★★★（低） |
| 可承受的版本數量 | 2～3 | 3～5 | 幾十 | 3～5 |
| 文件／SDK 工具支援 | ★★★ | ★ | ★★ | ★★ |
| 適合 | 內部 API、版本少 | 純 REST 派、漸進遷移 | 公開平台、consumer 極多 | 雲端服務、需要強制明示 |

### 6.5.6 shop-service 的選擇

```
主策略：URL 路徑版本 /v1/，且「盡量永遠停在 v1」
輔助：  對「單一欄位級別」的變更，用 Expand-Contract（6.7），不動版本
未來：  如果 consumer 數量成長到需要更細的控制，再引入日期版本 + 釘住
```

**理由（誠實的取捨）**：

| 理由 | 說明 |
|---|---|
| 團隊規模 | 沒有專門團隊維護版本轉換鏈（6.5.3 的代價） |
| Consumer 數量 | 目前 3 家廠商 + 自家 Web/App —— 可以直接溝通遷移 |
| `curl` / 除錯友善 | 內部除錯與客服排查大量使用 `curl`（第 00 章 0.11） |
| 快取正確性 | 路徑版本天然分開快取鍵，不用擔心漏 `Vary` |
| **最重要**：我們的目標是**永遠不出 v2** | 6.7 的 Expand-Contract 可以處理 95% 的變更 |

**`/v1` 前綴的細節決定**：

```
✅ https://api.shop.example/v1/orders
❌ https://api.shop.example/api/v1/orders        （/api 冗餘）
❌ https://v1.api.shop.example/orders            （子網域版本 → DNS/憑證管理成本）
❌ https://api.shop.example/v1.2/orders          （不要 MINOR，6.2.3）
```

**Webhook 不帶版本前綴**（第 01 章 1.16 練習 4）：

```
POST /webhooks/payments/newebpay
```

理由：webhook 的格式由**對方**決定，我們的版本號在這裡沒有意義。
如果我們**發送** webhook 給廠商，那才需要版本（放在 payload 裡的 `apiVersion` 欄位）。

---

## 6.6 版本的粒度

### 6.6.1 三種粒度

| 粒度 | 例子 | 評價 |
|---|---|---|
| **全站版本** | `/v1/*` 整站一起升 | ★ 簡單；但升級成本大（全部 consumer 一起動） |
| **端點版本** | `/v1/orders` 和 `/v2/orders` 並存，但 `/v1/products` 沒有 v2 | ⚠️ 靈活；但 consumer 要記「哪個端點是哪個版本」→ 混亂 |
| **欄位版本** | 同一個端點，用 Expand-Contract 讓新舊欄位並存 | ★★★ **最細、最便宜**（6.7） |

**shop-service 的規則**：

```
優先序：欄位級（Expand-Contract）> 全站版本 > 端點版本
端點版本「不採用」—— 它的認知成本太高
```

**為什麼不採用端點版本**（真實的混亂）：

```
consumer 的程式碼：
  GET /v1/orders          ← 訂單還是 v1
  GET /v2/orders/{id}     ← 但詳情已經 v2 了？
  GET /v1/products        ← 商品沒有 v2
  POST /v2/orders/{id}/payments   ← 付款是 v2

→ 每次寫程式都要查「這支到底有沒有 v2」
→ 而且 v1 的 OrderSummary 和 v2 的 OrderDetail 欄位不一致
```

### 6.6.2 Feature Flag / 灰度：比版本更輕的工具

**很多「需要版本」的需求，其實只需要 feature flag。**

```java
// 依 client 版本／API key 決定行為
if (features.isEnabled("EXTENDED_ORDER_STATUS", clientContext)) {
    return actualStatus.name();
} else {
    return downgradeStatus(actualStatus);      // 第 03 章 3.17 練習 4 的降級對映
}
```

**適用場景**：

| 場景 | 用 feature flag 而不是版本 |
|---|---|
| 新增列舉值，但要先讓已就緒的客戶端試 | ✅ 按 client 版本開關 |
| 新演算法（新的運費計算） | ✅ 灰度 5% → 50% → 100% |
| 新欄位，但只給特定廠商用（beta） | ✅ 按 API key 開關 |
| 要改型別 | ❌ **不行** —— 這需要新欄位（6.7） |

**Feature flag 的紀律**：

```
□ 每個 flag 都要有「移除日期」（否則會累積成永久的 if 森林）
□ flag 的狀態要能從 API 回應看出來（例如 x-features header 或 /me/features 端點）
□ flag 的預設值必須是「舊行為」（保守）
```

**⚠️ Feature flag 不是版本的替代品，是它的補充**：
flag 適合「暫時的、要收斂的」差異；版本適合「永久的、不會收斂的」差異。

---

## 6.7 Expand–Contract：不開新版本的做法 ★ 本章核心

### 6.7.1 六步流程

```
① Expand（擴展）：新增新的東西，舊的保留
       ↓
② Dual-write（雙寫）：寫入時同時維護新舊兩份
       ↓
③ Backfill（回填）：把歷史資料補齊新格式
       ↓
④ Migrate consumers（遷移消費端）：通知 + 支援 + 監控用量
       ↓
⑤ Deprecate（棄用）：標記舊的，發 Deprecation/Sunset header
       ↓
⑥ Contract（收縮）：用量歸零後移除舊的
```

**關鍵洞察：①～④ 都是「零風險」的，只有 ⑥ 有風險，而且 ⑥ 可以無限延後。**

「無限延後」不是偷懶 —— **保留一個欄位的成本非常低**（幾行 mapper 程式碼），
而移除它的收益也很低。所以「⑥ 永遠不執行」常常是理性的選擇。

### 6.7.2 案例 1：欄位型別／單位變更（第 00 章練習 4 的完整版）

**需求**：`amount`（浮點數，單位元）改成整數分，避免精度問題。

```jsonc
// 階段 ①：Expand（Day 0，零風險，今天就能上線）
{
  "amount": 1280.50,          // 保留（標記 deprecated）
  "amountMinor": 128050,      // 新增
  "currency": "TWD"           // 順手補上（原本隱含 TWD 也是個坑）
}
```

**Java 實作**：

```java
public record OrderDetail(
    @Deprecated(since = "2026-09-01", forRemoval = true)
    @Schema(deprecated = true, description = "已棄用，請改用 amountMinor。將於 2027-03-01 移除。")
    BigDecimal amount,

    long amountMinor,
    String currency,
    ...
) {
    /** 從單一來源產生兩個欄位，避免不一致 */
    public static OrderDetail from(Order o) {
        long minor = o.getTotalAmount()
                      .movePointRight(2)
                      .setScale(0, RoundingMode.HALF_UP)
                      .longValueExact();
        return new OrderDetail(
                BigDecimal.valueOf(minor, 2),      // ★ 從 minor 反推，保證兩者一致
                minor,
                o.getCurrency(),
                ...);
    }
}
```

**⚠️ 這個「從 minor 反推 amount」的細節很重要**：
如果兩個欄位各自從不同來源算，遲早會出現「`amount: 1280.50` 但 `amountMinor: 128049`」的不一致，
然後你會花一整天找為什麼。**單一來源 + 推導。**

```
階段 ②：Dual-write —— 這個案例不需要（沒有改資料庫）
        如果資料庫也要改（DECIMAL → BIGINT），見 6.10

階段 ③：Backfill —— 不需要（是計算出來的）

階段 ④：Migrate consumers（Day 0 ～ Day 180）
        - 發 CHANGELOG + email 給 3 家廠商
        - Web 前端 Day 1～7 改完
        - App Day 7～21 改完並送審
        - 監控「還有誰在讀 amount」（6.8.3）

階段 ⑤：Deprecate（Day 0 就開始）
        Deprecation: @1755561600
        Sunset: Mon, 01 Mar 2027 00:00:00 GMT
        Link: <https://api.shop.example/changelog/2026-08-19-amount-minor>; rel="deprecation"

階段 ⑥：Contract（Day 560+，或永不執行）
        用量歸零後移除 amount
        ⚠️ 但保留它的成本只是 3 行 mapper —— 「永不移除」也是合理選擇
```

### 6.7.3 案例 2：欄位改名

**需求**：`displayName` 改名為 `nickname`（DBA 說更精確）。

```jsonc
// ① Expand
{
  "displayName": "王小明",     // 保留
  "nickname": "王小明"         // 新增（同一個值）
}
```

**⚠️ 這裡有一個容易忽略的問題：Request 方向怎麼辦？**

```java
public record UpdateCustomerRequest(
    @Deprecated JsonNullable<String> displayName,
    JsonNullable<String> nickname
) {
    /** 兩個都送且不同 → 422；只送一個 → 用那個 */
    public JsonNullable<String> resolvedNickname() {
        if (nickname.isPresent() && displayName.isPresent()
                && !Objects.equals(nickname.get(), displayName.get())) {
            throw new FieldValidationException("nickname",
                    "displayName 與 nickname 不可同時提供不同的值（displayName 已棄用）");
        }
        return nickname.isPresent() ? nickname : displayName;
    }
}
```

**「兩個都送但值不同 → `422`」是必須處理的情況**。
如果你「後者覆蓋前者」，那 JSON 欄位順序就變成語意的一部分（違反 6.4.2 要求 7），
而且會有客戶端因為序列化順序不同而得到不同結果。

**明確拒絕比猜測好。**

### 6.7.4 案例 3：欄位拆分

**需求**：`address`（一個字串）拆成結構化欄位。

```jsonc
// 舊
{ "address": "台北市中山區民生東路三段 10 號 5 樓" }

// ① Expand
{
  "address": "台北市中山區民生東路三段 10 號 5 樓",     // 保留（由新欄位組合而成）
  "addressDetail": {
    "postalCode": "10491",
    "city": "台北市",
    "district": "中山區",
    "line1": "民生東路三段 10 號",
    "line2": "5 樓"
  }
}
```

**兩個方向的處理**：

| 方向 | 處理 |
|---|---|
| Response | `address` = `city + district + line1 + line2` 拼接（單一來源是結構化欄位） |
| Request（舊客戶端只送 `address`） | ⚠️ 需要**地址解析**（parsing）—— 這是這個案例最難的部分 |

**Request 方向的三種選擇**：

| 選擇 | 說明 |
|---|---|
| **A. 解析 `address` 字串** | ⚠️ 台灣地址解析不簡單（「三段」「巷」「弄」「之1」）；可以用第三方 API |
| **B. 存原始字串，結構化欄位為 `null`** | ✅ 誠實：舊客戶端送的資料就是非結構化的 |
| **C. 拒絕舊格式**（要求必須用新欄位） | 🔴 破壞性變更 |

**shop-service 選 B + 逐步改善**：

```java
// 舊客戶端只送 address
if (req.address().isPresent() && req.addressDetail().isEmpty()) {
    entity.setRawAddress(req.address().get());
    entity.setAddressParseStatus(UNPARSED);      // ★ 標記
    // 非同步嘗試解析（失敗就保持 UNPARSED）
    events.publish(new AddressNeedsParsing(entity.getId()));
}
```

**回應時誠實標示**：

```jsonc
{
  "address": "台北市中山區民生東路三段10號5樓",
  "addressDetail": null,
  "addressParseStatus": "UNPARSED"     // ★ 讓客戶端知道「結構化資料不可用」
}
```

**這比「猜一個結構化結果」好得多** —— 猜錯會導致包裹寄錯。

### 6.7.5 案例 4：欄位合併

**需求**：`firstName` + `lastName` 合併成 `fullName`（因為中文姓名不適合拆）。

```jsonc
// ① Expand
{
  "firstName": "小明",      // 保留
  "lastName": "王",         // 保留
  "fullName": "王小明"      // 新增
}
```

**Request 方向的規則**（要明確定義優先序）：

```java
public String resolveFullName(UpdateRequest req) {
    if (req.fullName().isPresent()) {
        // 新欄位優先。若同時給了舊欄位且不一致 → 422
        if ((req.firstName().isPresent() || req.lastName().isPresent())
                && !matches(req.fullName().get(), req.lastName(), req.firstName())) {
            throw new FieldValidationException("fullName",
                    "fullName 與 firstName/lastName 不一致");
        }
        return req.fullName().get();
    }
    // 只給舊欄位 → 組合（⚠️ 順序要按文化慣例，而且要記錄假設）
    return req.lastName().orElse("") + req.firstName().orElse("");
}
```

**⚠️ 這裡有一個文化假設的陷阱**：
`lastName + firstName` 是中文順序，`firstName + lastName` 是英文順序。
如果你的系統有外國客戶，這個組合會產生「Ming Wang」變成「WangMing」。

**所以「合併」比「拆分」更需要小心** —— 合併會丟失資訊（順序、分界）。

**shop-service 的處理**：保留 `nameFormat` 欄位記錄原始意圖：

```jsonc
{
  "fullName": "王小明",
  "nameFormat": "FAMILY_FIRST",       // FAMILY_FIRST / GIVEN_FIRST
  "firstName": "小明",                 // deprecated
  "lastName": "王"                     // deprecated
}
```

### 6.7.6 案例 5：必填 → 選填，以及選填 → 必填

```
必填 → 選填：✅ 直接改，安全（放寬）
選填 → 必填：🔴 破壞性 —— 需要三階段
```

**「選填 → 必填」的三階段**：

```
階段 1（Day 0）：欄位仍選填，但沒送時回一個 warning
{
  "orderId": "...",
  "warnings": [
    { "code": "FIELD_WILL_BECOME_REQUIRED",
      "message": "shippingAddressId 將於 2027-03-01 起成為必填欄位。",
      "field": "shippingAddressId",
      "effectiveDate": "2027-03-01" }
  ]
}
+ 監控「有多少請求沒送這個欄位」+ 記錄是哪些 consumer

階段 2（Day 90）：對「已知已就緒」的 consumer 開始強制（feature flag，6.6.2）
                  對其他 consumer 仍只給 warning

階段 3（Sunset 日）：全面強制 → 422
```

**⚠️ 這個變更的本質是「業務規則收緊」，所以要先問**：

```
真的需要必填嗎？還是可以給一個合理的預設值？
  → 「收件地址」→ 可以用客戶的預設地址 ✅ 不用改成必填
  → 「statutory 稅務欄位」→ 法規要求，必須必填 ❌ 只能走三階段
```

**很多「要改成必填」的需求，用「合理的預設值」就解決了。**

### 6.7.7 Expand–Contract 的兩個反面案例（什麼時候它不夠）

**反例 1：整個資源模型改變**

```
訂單原本是「一張訂單 = 一次配送」
現在要支援「一張訂單 = 多次配送，每次不同地址」
→ shippingAddress（單一物件）要變成 shipments[].shippingAddress
→ 這不是「加一個欄位」，是「資源結構重組」
```

**判準：如果新舊模型無法用「同一份資料的兩種視圖」表達，Expand-Contract 就不夠。**

```jsonc
// 還是可以 Expand，但會很醜
{
  "shippingAddress": { ... },              // deprecated：第一個 shipment 的地址
  "shipments": [
    { "shipmentId": "...", "shippingAddress": { ... } },
    { "shipmentId": "...", "shippingAddress": { ... } }
  ]
}
```

**這個「醜」是可以接受的**（`shippingAddress` = `shipments[0].shippingAddress`），
只要文件寫清楚。**真正需要 v2 的，是連這種降級都做不到的情況。**

**反例 2：認證機制變更**

```
從 API key（header）改成 OAuth 2.0
→ 無法「兩種並存後漸進遷移」嗎？
→ 其實可以（同時支援兩種認證方式）
→ 但如果新機制要求「不同的權限模型」（scope vs role），
   那同一個端點在兩種認證下的行為不同 → 混亂
```

**這種情況通常用「新的路徑」而不是「新的版本」**：

```
/v1/orders           API key 認證（deprecated）
/v1/orders           OAuth 認證（同一個端點，兩種認證都支援）
```

大部分情況同時支援兩種認證就好 —— **認證機制通常不需要版本。**

### 6.7.8 何時真的需要新版本

**只有這四種情況**：

| 情況 | 說明 |
|---|---|
| 1. 資源模型根本重組 | 6.7.7 反例 1 的極端版本（無法用視圖表達） |
| 2. 錯誤格式整體更換 | 例如從自訂格式改成 Problem Details，且無法並存 |
| 3. 分頁機制無法並存 | 例如從「回全部」改成「強制分頁」（第 05 章 5.2.4） |
| 4. 累積太多 deprecated 欄位，文件已經無法閱讀 | ⚠️ 這是「品質」理由，優先序最低 |

**第 3 個值得說明**：

```
v1：GET /orders 回全部（幾千筆）
   → 現在資料長到 300 萬筆，必須強制分頁
   → 加 ?page= 是安全的，但「不帶參數時回全部」必須改
   → 這是破壞性變更，而且無法用 Expand-Contract 避免
```

**折衷做法**：漸進降級（brownout，6.8.5）——
先把「不帶參數」的預設從「全部」降到「10,000 筆 + warning」，
再降到「1,000 筆」，最後降到「20 筆」。

**這樣不用開 v2，但要接受「有些客戶端會在某個階段發現資料不完整」。**
所以要配合強力的溝通與監控。

---

## 6.8 棄用與退場流程

### 6.8.1 完整時程表

```
Day -30   ① 內部決策與 ADR（架構決策紀錄）
          ② 評估影響：誰在用？用量多少？（6.8.3）
          ③ 準備遷移指引（含程式碼範例）

Day 0     ④ Expand：新的東西上線（零風險）
          ⑤ 發布 CHANGELOG（含 RSS）
          ⑥ 回應開始附 Deprecation / Sunset header
          ⑦ OpenAPI 標記 deprecated: true
          ⑧ 直接 email／Slack 通知已知的 consumer
          ⑨ 建立追蹤看板：每個 consumer 的舊欄位用量

Day 7     ⑩ 第一次提醒（給還沒動的 consumer）

Day 30    ⑪ 檢查：Web 前端應該已遷移完
Day 60    ⑫ 檢查：App 應該已發版（含審核時間）
Day 90    ⑬ 第二次提醒 + 一對一聯繫還在用的 consumer

Day 150   ⑭ 最後通知（30 天前警告）
          ⑮ 若仍有高用量 consumer → 評估延期（並公告延期）

Day 165   ⑯ 漸進降級開始（brownout，6.8.5）：
             每天在固定時段回舊格式 → 讓對方「感受到」但不致命

Day 180   ⑰ Sunset：正式移除
          ⑱ 舊欄位／端點回 410 Gone（不是 404，第 02 章 2.6.2）

Day 180+  ⑲ 保留 410 回應 90 天（附遷移指引），之後才變 404
```

**⑱ 和 ⑲ 是很多人漏掉的細節**：

```jsonc
// 移除後的 90 天，回 410 而不是 404
{
  "type": "https://api.shop.example/problems/endpoint-removed",
  "title": "端點已移除",
  "status": 410,
  "detail": "GET /v1/orders/{id}/legacy-summary was removed on 2027-03-01.",
  "code": "ENDPOINT_REMOVED",
  "userMessage": "此功能已停止提供。",
  "removedAt": "2027-03-01T00:00:00Z",
  "replacement": {
    "endpoint": "GET /v1/orders/{id}",
    "migrationGuide": "https://api.shop.example/changelog/2026-08-19-legacy-summary-removal"
  }
}
```

**`410` + `replacement` 讓「壞掉的 consumer」自己就能找到答案**，
不用開工單問你。**這一個欄位可能省下十封 email。**

### 6.8.2 Header 規格

```http
HTTP/1.1 200 OK
Deprecation: @1755561600
Sunset: Mon, 01 Mar 2027 00:00:00 GMT
Link: <https://api.shop.example/changelog/2026-08-19-amount-minor>; rel="deprecation"; type="text/html"
Warning: 299 - "The 'amount' field is deprecated; use 'amountMinor'. Sunset: 2027-03-01"
Access-Control-Expose-Headers: Deprecation, Sunset, Link, Warning
```

| Header | 標準狀態 | 格式 | 說明 |
|---|---|---|---|
| `Sunset` | **RFC 8594**（正式） | HTTP-date | 「何時停止提供」 |
| `Deprecation` | IETF **draft**（`draft-ietf-httpapi-deprecation-header`） | `@<unix timestamp>` 或 HTTP-date | 「何時開始棄用」 |
| `Link; rel="deprecation"` | 同上 draft | URI | 指向說明文件 |
| `Link; rel="sunset"` | RFC 8594 | URI | 同上 |
| `Warning` | ⚠️ **RFC 9111 已廢除此 header** | — | 仍有人用；建議改用上面三個 |

**⚠️ 要誠實**：`Deprecation` header 目前仍是 draft，
所以不同工具的支援程度不一。但它是**業界事實慣例**（Zalando、IETF HTTP APIs 工作組推動），
值得使用。

`Sunset` 是**正式 RFC**，一定要用。

**⚠️ `Warning` header 在 RFC 9111（2022）已被移除**（因為「幾乎沒有正確實作」）。
不要依賴它，但加著也無害（作為給人看的線索）。

**Java 實作（給棄用的欄位）**：

```java
@Component
public class DeprecationHeaderAdvice implements ResponseBodyAdvice<Object> {

    private final DeprecationRegistry registry;

    @Override
    public Object beforeBodyWrite(Object body, MethodParameter param, MediaType mt,
                                  Class converterType, ServerHttpRequest req,
                                  ServerHttpResponse res) {
        registry.findFor(param.getMethod())
                .ifPresent(d -> {
                    HttpHeaders h = res.getHeaders();
                    h.add("Deprecation", "@" + d.deprecatedAt().getEpochSecond());
                    h.add("Sunset", RFC_1123_DATE_TIME.format(d.sunsetAt()));
                    h.add("Link", "<%s>; rel=\"deprecation\"; type=\"text/html\""
                            .formatted(d.docUrl()));
                });
        return body;
    }
}
```

### 6.8.3 用量監控：誰還在用 ★ 這是整個流程的關鍵

**沒有用量監控，你永遠不敢移除任何東西。**

**三種監控層次**：

**層次 1：端點層級（容易）**

```java
Counter.builder("api.deprecated.usage")
       .tag("item", "GET /v1/orders/{id}/legacy-summary")
       .tag("consumer", consumerId(auth))        // ★ 關鍵：要能識別是誰
       .register(registry)
       .increment();
```

**層次 2：欄位層級（較難但更有價值）**

「誰還在讀 `amount` 這個欄位？」—— HTTP 沒辦法告訴你客戶端讀了哪些欄位。

**三種近似做法**：

| 做法 | 說明 |
|---|---|
| **A. 讓客戶端明示**（`?fields=` 或 `Prefer` header） | ✅ 精確；但要客戶端配合（可以列進 Consumer Contract） |
| **B. 用 client 版本推斷** | 記錄 `User-Agent` / `X-Client-Version`，配合「哪個版本改用新欄位」的紀錄 |
| **C. 影子移除（shadow removal）** | ★ 見下 |

**做法 C：影子移除**

```
在 Sunset 前 30 天，對 1% 的請求「不回」舊欄位
→ 如果那 1% 的客戶端壞了，他們會回報／你會看到他們的錯誤率上升
→ 你就知道「還有人在用」
→ 逐步提高比例：1% → 5% → 20% → 100%
```

**這是最可靠的做法**，因為它直接測試「移除會不會出事」。

⚠️ **但要小心**：
- 只在**低風險**的欄位上做（不要對金額欄位做，客戶端可能顯示 `NaN` 給真實使用者看）。
- 要能**立刻回滾**（feature flag）。
- 要**事先公告**（「我們將在 X 月進行影子移除測試」）。

**層次 3：Consumer 識別（前提）**

```
沒有 consumer 識別，用量監控就沒有意義
（你知道「還有 5% 的請求在用舊欄位」，但不知道要通知誰）
```

**shop-service 的 consumer 識別**：

| Consumer 類型 | 識別方式 |
|---|---|
| 廠商 ERP | API key → `consumer_id`（註冊時分配） |
| 自家 Web | `X-Client-Id: shop-web` + `X-Client-Version: 3.2.1` |
| 自家 App | `X-Client-Id: shop-ios` + `X-Client-Version: 4.1.0` |
| 內部服務 | `X-Client-Id: inventory-service` |
| 未識別 | 🔴 記錄 `User-Agent` + IP，並在文件裡**要求**帶 `X-Client-Id` |

**把「帶 `X-Client-Id`」列進 Consumer Contract**：

```markdown
16. **每個請求必須帶 `X-Client-Id` 與 `X-Client-Version`**
    這讓我們能在棄用時精準通知你，也讓我們能為你的版本做相容處理。
    未帶此 header 的 consumer 將無法收到針對性的棄用通知。
```

**「無法收到通知」是很有效的誘因** —— 比「請帶這個 header」有用得多。

### 6.8.4 棄用登記表（`GET /v1/deprecations`）

**把棄用資訊變成一個 API 端點**，讓 consumer 可以程式化檢查：

```http
GET /v1/deprecations
```
```jsonc
{
  "items": [
    {
      "id": "dep_2026_08_amount",
      "kind": "FIELD",
      "target": "OrderDetail.amount",
      "endpoints": ["GET /v1/orders/{orderId}", "GET /v1/orders"],
      "deprecatedAt": "2026-08-19T00:00:00Z",
      "sunsetAt": "2027-03-01T00:00:00Z",
      "replacement": "OrderDetail.amountMinor",
      "reason": "浮點數金額有精度問題，改用整數最小單位",
      "migrationGuide": "https://api.shop.example/changelog/2026-08-19-amount-minor",
      "yourUsage": {
        "last7Days": 148213,
        "lastSeenAt": "2026-08-19T05:58:12Z",
        "status": "STILL_IN_USE"
      }
    },
    {
      "id": "dep_2026_06_legacy_summary",
      "kind": "ENDPOINT",
      "target": "GET /v1/orders/{orderId}/legacy-summary",
      "deprecatedAt": "2026-06-01T00:00:00Z",
      "sunsetAt": "2026-12-01T00:00:00Z",
      "replacement": "GET /v1/orders/{orderId}",
      "yourUsage": { "last7Days": 0, "lastSeenAt": null, "status": "NOT_USED" }
    }
  ]
}
```

**`yourUsage` 是這個端點最有價值的部分**：
consumer 可以在自己的 CI 上跑一個檢查：

```bash
# consumer 的 CI 檢查
curl -s -H "Authorization: Bearer $KEY" https://api.shop.example/v1/deprecations \
  | jq -e '[.items[] | select(.yourUsage.status == "STILL_IN_USE")] | length == 0' \
  || { echo "⚠️ 你還在使用已棄用的 API 項目，請查看上方清單"; exit 1; }
```

**這把「棄用溝通」從推播（我 email 你）變成拉取（你自己檢查）。**

### 6.8.5 漸進降級（brownout）

**用途**：Sunset 前讓 consumer「痛一下但不致死」，逼出那些沒讀 email 的人。

```
Day 165  每天 03:00-03:15（低流量時段），舊端點回 410
Day 170  每天 03:00-04:00
Day 174  每小時的第 0-5 分鐘
Day 178  50% 的請求回 410
Day 180  100%（正式 Sunset）
```

**這是 Kubernetes、Python、Rust 等大型專案在移除 API 時的實際做法。**

**必要的配套**：

| 配套 | 說明 |
|---|---|
| **事先公告 brownout 時程** | 否則對方以為是你的服務不穩定 |
| **回應要明確說明這是 brownout** | 不能只回 `410`，要說「這是計畫性降級，正式移除日 = X」 |
| **要能立刻停止** | feature flag（出事就關掉） |
| **只對非關鍵路徑做** | ⚠️ **絕對不要對付款、下單做 brownout** |

```jsonc
{
  "type": "https://api.shop.example/problems/scheduled-brownout",
  "title": "計畫性服務降級",
  "status": 410,
  "detail": "This endpoint is in scheduled brownout before its sunset on 2027-03-01.",
  "code": "SCHEDULED_BROWNOUT",
  "userMessage": "此功能即將停止提供，請盡快遷移。",
  "brownout": {
    "isBrownout": true,
    "sunsetAt": "2027-03-01T00:00:00Z",
    "nextBrownoutWindow": "2027-02-14T03:00:00Z/2027-02-14T04:00:00Z",
    "migrationGuide": "https://api.shop.example/changelog/..."
  },
  "replacement": { "endpoint": "GET /v1/orders/{orderId}" }
}
```

**`isBrownout: true` 讓 consumer 能程式化判斷「這不是真的故障」** ——
避免他們的告警系統誤判並半夜叫人起床。

---

## 6.9 相容性測試：在 CI 上抓破壞性變更

### 6.9.1 OpenAPI diff

**核心工具**：`oasdiff`（Go 寫的，功能最完整）。

```bash
# 安裝
brew install oasdiff       # 或 go install github.com/oasdiff/oasdiff@latest

# 檢查破壞性變更
oasdiff breaking \
  openapi-base.yaml \
  openapi-revision.yaml \
  --fail-on ERR

# 產生人類可讀的變更報告
oasdiff changelog openapi-base.yaml openapi-revision.yaml --format markdown
```

**CI pipeline**：

```yaml
# .github/workflows/api-compat.yml
name: API 相容性檢查

on: [pull_request]

jobs:
  breaking-change:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }

      - name: 取出 base 分支的契約
        run: git show origin/${{ github.base_ref }}:api/orders-api.yaml > /tmp/base.yaml

      - name: 產生本次的契約
        run: ./mvnw -q spring-boot:run &
             sleep 30
             curl -s localhost:8080/v3/api-docs.yaml > /tmp/head.yaml

      - name: 檢查破壞性變更
        run: |
          docker run --rm -v /tmp:/specs tufin/oasdiff breaking \
            /specs/base.yaml /specs/head.yaml --fail-on ERR

      - name: 產生變更報告（貼到 PR）
        if: always()
        run: |
          docker run --rm -v /tmp:/specs tufin/oasdiff changelog \
            /specs/base.yaml /specs/head.yaml --format markdown > /tmp/changelog.md
          gh pr comment ${{ github.event.number }} --body-file /tmp/changelog.md
```

**「貼變更報告到 PR」比「只擋住」有用得多**：
reviewer 可以直接看到「這個 PR 對契約做了什麼」。

**`oasdiff` 認得的破壞性變更（部分）**：

```
- 移除端點 / 方法
- 新增必填的 request 欄位或參數
- 移除 response 欄位（在 required 裡的）
- 型別變更
- 縮小列舉的可接受值（request 方向）
- 擴大列舉的可能值（response 方向，若標為 breaking）
- 移除回應狀態碼
- 收緊驗證（maxLength 變小、pattern 變嚴）
- 移除 security scheme
```

### 6.9.2 破壞性變更的「例外核准」流程

**有時候你真的要做破壞性變更**（例如修一個資安漏洞）。
CI 不能只是「擋住然後沒辦法」。

```yaml
# api/breaking-changes-allowlist.yaml
# 每一筆都要有 PR 連結、理由、核准人、以及通知記錄
allowed:
  - id: 2026-08-19-remove-idnumber
    change: "response-property-removed: CustomerDetail.idNumber"
    reason: "個資外洩修補（資安事件 SEC-2026-014）。此欄位本不該回傳。"
    approvedBy: ["tech-lead@shop.example", "dpo@shop.example"]
    prUrl: "https://github.com/shop/api/pull/1842"
    consumersNotified: true
    notifiedAt: "2026-08-18T09:00:00Z"
    expiresAt: "2026-09-19"          # ★ allowlist 條目要過期，避免永久累積
```

```bash
oasdiff breaking /tmp/base.yaml /tmp/head.yaml \
  --fail-on ERR \
  --exclude-elements $(yq -r '.allowed[].change' api/breaking-changes-allowlist.yaml | tr '\n' ',')
```

**`expiresAt` 很重要**：allowlist 沒有過期機制的話，
三年後會有 200 條「當初核准過」的例外，然後 CI 檢查形同虛設。

### 6.9.3 契約快照測試（不依賴 OpenAPI）

**如果你沒有 OpenAPI**（或想要更直接的保護），用**回應快照**：

```java
@WebMvcTest(OrderController.class)
class OrderResponseContractTest {

    /**
     * ★ 這個測試的目的不是「驗證邏輯」，是「偵測契約變更」。
     * 任何欄位的新增、移除、改名、型別變更都會讓它失敗，
     * 迫使開發者「有意識地」更新快照並在 PR 說明理由。
     */
    @Test
    void 訂單詳情的回應結構() throws Exception {
        String json = mockMvc.perform(get("/v1/orders/ord_test_001")
                        .header("Authorization", "Bearer " + TEST_TOKEN))
                .andExpect(status().isOk())
                .andReturn().getResponse().getContentAsString();

        // 只比對「結構」（欄位路徑 + 型別），不比對「值」
        String shape = JsonShape.of(json);          // 自訂工具：產生結構指紋
        assertThat(shape).isEqualTo(readResource("contracts/order-detail.shape.txt"));
    }
}
```

`order-detail.shape.txt` 長這樣：

```
orderId: string
orderNumber: string
status: string
statusLabel: string
statusCategory: string
allowedActions: array<string>
customer.customerId: string
customer.displayName: string
items: array
items[].itemId: string
items[].quantity: number
items[].unitPrice: string
amounts.subtotal: string
amounts.total: string
currency: string
createdAt: string
traceId: string
```

**這種測試的價值**：

| 價值 | 說明 |
|---|---|
| 不需要 OpenAPI | 適合還沒有契約文件的專案 |
| 抓得到「不小心多回一個欄位」 | 🔴 **這是資安護欄**：新增 Entity 欄位時不會意外外洩（第 03 章 3.2.9） |
| diff 很好讀 | 一眼看出改了什麼 |
| 迫使「有意識地」變更 | 更新快照是一個明確的動作，會出現在 PR diff 裡 |

**⚠️ 快照測試的常見反模式**：「測試失敗就直接重新產生快照」。
要在 PR template 裡要求「快照變更必須在 PR 說明中解釋」。

### 6.9.4 消費者驅動契約（CDC）

**概念**：每個 consumer 宣告「我需要哪些欄位」，provider 的 CI 驗證所有 consumer 的需求都滿足。

```javascript
// consumer（前端）的 Pact 測試
provider.given('訂單 ord_1 存在')
  .uponReceiving('取得訂單詳情')
  .withRequest({ method: 'GET', path: '/v1/orders/ord_1' })
  .willRespondWith({
    status: 200,
    body: {
      orderId: like('ord_1'),
      status: like('PAID'),
      statusLabel: like('已付款'),
      amounts: { total: like('1280.50') },   // ★ 只宣告「我需要的」
      // 我不需要 items → 不宣告 → provider 可以自由改它
    },
  });
```

**CDC 的獨特價值**：**它讓你知道「哪些欄位真的有人在用」** ——
這正是 6.8.3 用量監控想解決的問題，而 CDC 在**編譯期**就給你答案。

完整流程在第 09 章 9.3。

---

## 6.10 資料庫遷移：同一個問題

### 6.10.1 為什麼放在這一章

**API 版本和 schema 遷移是同一個問題的兩面**：

```
API：  舊客戶端和新客戶端同時存在 → 回應要兼容兩者
Schema：舊程式和新程式同時存在（滾動更新期間）→ schema 要兼容兩者
```

**而且 API 的 Expand-Contract 常常需要 schema 也做 Expand-Contract。**

### 6.10.2 滾動更新期間的雙版本問題

```
K8s 滾動更新（3 個 Pod）：
T1  Pod A(舊) Pod B(舊) Pod C(舊)
T2  Pod A(新) Pod B(舊) Pod C(舊)     ← 🔴 新舊同時跑，共用同一個資料庫
T3  Pod A(新) Pod B(新) Pod C(舊)
T4  Pod A(新) Pod B(新) Pod C(新)
```

**所以任何 schema 變更都必須「舊程式也能跑」**：

| 變更 | 舊程式能跑嗎 | 說明 |
|---|---|---|
| 新增可為 NULL 的欄位 | ✅ | 舊程式不知道它存在 |
| 新增 NOT NULL 但有 DEFAULT 的欄位 | ✅ | 舊程式的 INSERT 不指定 → 用 default |
| 新增 NOT NULL 無 DEFAULT 的欄位 | 🔴 | 舊程式的 INSERT 會失敗 |
| 移除欄位 | 🔴 | 舊程式的 `SELECT *` 或 INSERT 會失敗 |
| 欄位改名 | 🔴 | 同上 |
| 擴大型別（`VARCHAR(50)` → `VARCHAR(100)`） | ✅ | |
| 縮小型別 | 🔴 | 可能截斷 + 舊程式寫入失敗 |
| 新增索引 | ✅ | ⚠️ 但大表加索引可能鎖表（MySQL 8.0 的 online DDL 大多不鎖） |
| 移除索引 | ✅（功能上） | ⚠️ 但舊程式的查詢會變慢 |
| 新增唯一約束 | 🔴 | 舊程式可能寫入重複值 |

### 6.10.3 欄位改名的六步（和 6.7.1 完全對應）

**需求**：`orders.amount DECIMAL(19,4)` 改成 `orders.amount_minor BIGINT`。

```sql
-- ① Expand：加新欄位（可為 NULL）
-- V20260819_01__add_amount_minor.sql
ALTER TABLE orders ADD COLUMN amount_minor BIGINT NULL COMMENT '總金額（最小單位）';
```

```java
// ② Dual-write：程式同時寫兩個欄位
@PrePersist @PreUpdate
void syncAmountFields() {
    if (totalAmount != null) {
        this.amountMinor = totalAmount.movePointRight(2)
                                      .setScale(0, RoundingMode.HALF_UP)
                                      .longValueExact();
    }
}
```

**⚠️ 雙寫必須在同一個交易裡，而且要有「不一致偵測」**：

```java
// 定期對帳（02-spring-boot 第 06 章的排程）
@Scheduled(cron = "0 0 4 * * *")
void detectAmountDrift() {
    long mismatches = jdbc.queryForObject("""
            SELECT COUNT(*) FROM orders
            WHERE amount_minor IS NOT NULL
              AND amount_minor <> ROUND(amount * 100)
            """, Long.class);
    if (mismatches > 0) {
        log.error("金額欄位不一致 count={}", mismatches);
        meterRegistry.counter("migration.amount.drift").increment(mismatches);
    }
}
```

**「雙寫必有漂移」是經驗法則** —— 一定要有偵測，否則你不敢做第 ⑤ 步。

```sql
-- ③ Backfill：分批回填歷史資料（不要一次 UPDATE 300 萬筆）
-- V20260820_01__backfill_amount_minor.sql（或用應用程式的批次工作）
-- ⚠️ 一次 UPDATE 300 萬筆會：長交易、大量 undo log、鎖競爭、複寫延遲
UPDATE orders
SET amount_minor = ROUND(amount * 100)
WHERE amount_minor IS NULL
  AND id BETWEEN ? AND ?              -- 每批 5,000 筆，中間 sleep 100ms
LIMIT 5000;
```

**分批回填的實務要點**：

| 要點 | 說明 |
|---|---|
| 每批 1,000～10,000 筆 | 太大 → 長交易；太小 → 總時間過長 |
| 批次間 sleep | 讓複寫（replication）跟上，讓其他查詢有機會執行 |
| 監控複寫延遲 | `SHOW SLAVE STATUS` 的 `Seconds_Behind_Master` > 5 就暫停 |
| 可中斷可續跑 | 記錄進度（`WHERE amount_minor IS NULL` 天然可續跑） |
| 在低流量時段跑 | — |

```java
// ④ Dual-read：讀取時優先用新欄位，fallback 到舊欄位
public long amountMinor(Order o) {
    if (o.getAmountMinor() != null) return o.getAmountMinor();
    // fallback（回填還沒跑完的資料）
    return o.getTotalAmount().movePointRight(2)
            .setScale(0, RoundingMode.HALF_UP).longValueExact();
}
```

```sql
-- ⑤ 切換：確認回填 100% 完成 + 漂移為 0，才能加約束
-- V20260901_01__amount_minor_not_null.sql
-- 前置檢查（放在 migration 裡，失敗就中止）
-- SELECT COUNT(*) FROM orders WHERE amount_minor IS NULL;  → 必須是 0
ALTER TABLE orders MODIFY COLUMN amount_minor BIGINT NOT NULL;
```

```sql
-- ⑥ Contract：移除舊欄位（★ 最後一步，而且要等 API 的 amount 欄位也退場後）
-- V20270301_01__drop_amount.sql
ALTER TABLE orders DROP COLUMN amount;
```

**⚠️ 第 ⑥ 步的時機**：必須等
① API 的 `amount` 欄位過了 Sunset
② 所有程式碼都不再讀 `amount` 欄位
③ 有備份可以回滾

**很多團隊永遠不執行第 ⑥ 步。** 一個沒用的欄位佔的成本很低，
而 `DROP COLUMN` 在大表上是不可逆的操作。**「留著」常常是理性的。**

### 6.10.4 Flyway 的版本管理

```
src/main/resources/db/migration/
├── V20260101_01__init_schema.sql
├── V20260819_01__add_amount_minor.sql          ① Expand
├── V20260820_01__backfill_amount_minor.sql     ③ Backfill（或用 Java migration）
├── V20260901_01__amount_minor_not_null.sql     ⑤ 切換
└── V20270301_01__drop_amount.sql               ⑥ Contract
```

**規則**（07-mysql 會詳談）：

```
□ 每個 migration 都必須是「舊程式也能跑」的（6.10.2）
□ 不可修改已執行過的 migration（Flyway 會用 checksum 檢查）
□ 大表的 DDL 要評估鎖影響（MySQL 8.0 的 online DDL / gh-ost / pt-online-schema-change）
□ 回填不要放在 Flyway 裡（會拖慢啟動、無法分批控速）→ 用獨立的批次工作
□ 每個 migration 都要能在 staging 用「和正式環境同等資料量」測過
```

**最後一條是最常被跳過、也最常出事的**：
在 100 筆的開發資料庫上跑 0.1 秒的 migration，
在 300 萬筆的正式環境可能鎖表 20 分鐘。

---

## 6.11 shop-service 的版本策略定案

### 6.11.1 規則

```markdown
# shop-service API 版本策略

## 1. 版本標示
- 路徑前綴 `/v1/`，目前且預期長期只有 v1。
- Webhook 路徑不帶版本前綴（格式由對方決定）。
- 內部 jar 版本（SemVer）與 API 版本無關。

## 2. 變更的優先序（由上而下嘗試）
1. **加東西**（新增選填欄位／參數／端點／列舉值）→ 直接做，不公告
2. **Expand–Contract**（新增替代品 + 棄用舊的）→ 走 §4 流程
3. **Feature flag / 灰度** → 暫時性差異
4. **開 v2** → 需要技術長核准 + ADR + 至少 3 位資深工程師 review

## 3. 絕對禁止（無論如何都不做）
- 改變已發布欄位的型別、單位、時區、語意 → 一律新增欄位
- 改變 `page` 的 0-based 基準
- 改變集合的預設排序
- 改變已發布錯誤 `code` 的語意或對應狀態碼
- 在沒有 180 天公告期的情況下移除任何東西
  （例外：資安漏洞修補，需 DPO + 技術長核准，並記入 allowlist）

## 4. 棄用流程（180 天）
Day 0    Expand + CHANGELOG + Deprecation/Sunset header + OpenAPI deprecated
         + 通知已知 consumer + 建立用量看板
Day 7/90/150  三次提醒
Day 165  漸進降級（brownout，僅非關鍵端點）
Day 180  Sunset → 回 410（附 replacement + migrationGuide）
Day 270  410 → 404

## 5. CI 強制檢查
- oasdiff breaking（--fail-on ERR）+ allowlist（條目必須有 expiresAt）
- 回應結構快照測試
- 契約報告自動貼到 PR

## 6. Consumer 識別（必要條件）
所有請求必須帶 `X-Client-Id` 與 `X-Client-Version`。
未帶者無法收到針對性的棄用通知（列入 Consumer Contract §要求 16）。
```

### 6.11.2 PR Checklist（放進 `.github/pull_request_template.md`）

```markdown
## API 契約影響

- [ ] 本 PR **不影響** API 契約（跳過以下所有項目）

### 若有影響，逐項確認：

#### 破壞性變更檢查（第 06 章 6.3）
- [ ] 沒有移除任何 response 欄位
- [ ] 沒有改變任何欄位的**型別**
- [ ] 沒有改變任何欄位的**單位／時區／語意** 🔴
- [ ] 沒有把選填的 request 欄位改成必填
- [ ] 沒有收緊任何驗證規則（`max`、`pattern`、列舉值域）
- [ ] 沒有改變 `page` 基準或集合預設排序 🔴
- [ ] 沒有改變已發布錯誤 `code` 的語意或狀態碼
- [ ] 沒有移除任何 response header

#### 若新增了東西
- [ ] 新增的 request 欄位是**選填**的
- [ ] 新增的列舉值：Consumer Contract 已涵蓋（客戶端須有 `default`）
- [ ] 新增的錯誤 `code`：已加入錯誤目錄（第 04 章 4.13）並有 `userMessage`
- [ ] 新增的欄位已加入 OpenAPI 與回應快照

#### 若這是 Expand–Contract 的一部分
- [ ] 新舊欄位由**單一來源推導**（不會不一致）
- [ ] Request 方向處理了「兩個都送」的情況（→ `422`）
- [ ] 已建立棄用登記（`/v1/deprecations`）
- [ ] 已加上 `Deprecation` / `Sunset` header 與 OpenAPI `deprecated: true`
- [ ] 已撰寫 CHANGELOG 與遷移指引（含程式碼範例）
- [ ] 已建立用量監控（能回答「還有誰在用」）
- [ ] 已通知已知的 consumer（列出通知對象與日期）

#### 若涉及 schema 變更
- [ ] 此 migration 在滾動更新期間「舊程式也能跑」（第 06 章 6.10.2）
- [ ] 大表的 DDL 已評估鎖影響
- [ ] 回填是分批的、可中斷可續跑的、不在 Flyway 裡
- [ ] 有雙寫漂移偵測

#### CI
- [ ] `oasdiff breaking` 通過（或已加入 allowlist 並附核准紀錄）
- [ ] 回應快照已更新，且**在下方說明變更原因**

### 契約變更說明
<!-- 若快照或 OpenAPI 有變更，說明改了什麼、為什麼、對 consumer 的影響 -->
```

### 6.11.3 棄用登記表（實際資料）

| id | kind | target | deprecatedAt | sunsetAt | replacement | 狀態 |
|---|---|---|---|---|---|---|
| `dep_2026_08_amount` | FIELD | `OrderDetail.amount` | 2026-08-19 | 2027-03-01 | `amountMinor` + `currency` | 🟡 Web 已遷移；App 4.1 已遷移；廠商 A/B 未遷移 |
| `dep_2026_08_display_name` | FIELD | `CustomerRef.displayName` | 2026-08-19 | 2027-03-01 | `nickname` | 🟢 全部已遷移，可執行 Contract |
| `dep_2026_06_legacy_summary` | ENDPOINT | `GET /v1/orders/{id}/legacy-summary` | 2026-06-01 | 2026-12-01 | `GET /v1/orders/{id}` | 🟢 用量 0，Day 165 起 brownout |
| `dep_2026_08_status_int` | FIELD | `OrderSummary.statusCode`（數字狀態） | 2026-08-19 | 2027-06-01 | `status`（字串列舉） | 🔴 廠商 C 的 ERP 重度依賴，需一對一協調 |

**這張表要放在**：
① 內部 wiki（含 consumer 聯絡人與協調紀錄）
② `GET /v1/deprecations`（給 consumer 看，含 `yourUsage`）
③ CHANGELOG 頁面

---

## 6.12 常見誤區

**誤區 1：「有需求就開 v2」**
6.2.1：一個 v2 的一次性成本 14～36 人天，持續成本是每次變更 +30～60%。
Stripe 13 年沒有 v2。

**誤區 2：「API 版本要用 SemVer」**
6.2.3：`MINOR` / `PATCH` 對 consumer 不可見。只有 `MAJOR` 或日期有意義。

**誤區 3：「新增欄位一定安全」**
6.3.2：**前提是客戶端忽略未知欄位**。沒有 Consumer Contract，這個前提不成立。

**誤區 4：「新增列舉值是相容的」**
6.3.2 + 第 00 章 0.8.3：對沒有 `default` 的客戶端是破壞性的。
要靠 Consumer Contract + `statusLabel` + 測試工具三層防護。

**誤區 5：「移除欄位就是把它從 DTO 刪掉」**
6.8.1：需要 180 天流程 + 用量監控 + 通知 + brownout + `410` 過渡期。

**誤區 6：「Deprecation header 是標準」**
6.8.2：`Sunset` 是 RFC 8594（正式），`Deprecation` 仍是 IETF draft，
`Warning` 已在 RFC 9111 被廢除。要誠實知道哪個是哪個。

**誤區 7：「我們不知道還有誰在用，所以不敢移除」**
6.8.3：這是**可以解決的問題**（consumer 識別 + 用量指標 + 影子移除）。
「不敢移除」的真正原因是「沒有建監控」。

**誤區 8：「改語意但保留欄位名比較省事」**
6.3.3：這會讓「已改的客戶端」和「沒改的客戶端」**都是壞的**，
而且沒有任何方法能偵測。**改語意必須改名字。**

**誤區 9：「Expand-Contract 的最後一步一定要做」**
6.7.1 + 6.10.3：保留一個欄位的成本很低。「永不 Contract」常常是理性選擇。

**誤區 10：「schema 遷移和 API 版本沒關係」**
6.10：滾動更新期間新舊程式共用同一個資料庫 —— 這是完全相同的相容性問題。

**誤區 11：「CI 擋住破壞性變更就夠了」**
6.9.2：沒有「例外核准流程」的話，遇到必須做的破壞性變更（資安修補）就會有人繞過檢查。
要設計 allowlist（且條目要過期）。

**誤區 12：「Consumer Contract 寫了就有效」**
6.4.3：**必須提供可測試的工具**（未知列舉值注入、未知欄位注入），
否則沒有 consumer 會真的實作那些要求。

---

## 6.13 本章練習

### 練習 1：破壞性變更判定

判斷以下變更是否為破壞性的。若「取決於客戶端」，說明 Consumer Contract 的哪一條可以把它變成安全的。

```
1.  OrderDetail 新增 businessDate 欄位
2.  OrderDetail 的 items 從「總是存在」改成「只在 ?expand=items 時存在」
3.  訂單狀態新增 PENDING_REFUND
4.  錯誤回應的 userMessage 從「庫存不足」改成「這個商品被搶光了」
5.  GET /orders 的預設 size 從 20 改成 50
6.  GET /orders 的預設排序從 createdAt,desc 改成 updatedAt,desc
7.  POST /orders 開始要求 Idempotency-Key
8.  POST /orders 的 items 陣列上限從 50 改成 100
9.  POST /orders 的 customerNote 長度上限從 500 改成 200
10. OrderDetail.totalAmount 從 "1280.50"（字串）改成 1280.50（數字）
11. 錯誤的 HTTP 狀態碼從 400 改成 422（code 不變）
12. GET /orders 開始回 ETag，並支援 304
13. GET /products/{id} 對已下架商品從 404 改成 410
14. 新增一個 GET /v1/orders/{id}/timeline 端點
15. OrderSummary.thumbnailUrl 從 CDN A 換到 CDN B（網址網域變了）
```

<details>
<summary>參考解答</summary>

| # | 判定 | 說明 |
|---|---|---|
| 1 | ✅ **安全** | 新增回應欄位。前提：Consumer Contract **要求 1（忽略未知欄位）** |
| 2 | 🔴 **破壞** | 等於「移除欄位」（對不帶 `expand` 的客戶端）。<br>正確做法：新端點或新參數預設**保持舊行為**（預設帶 items），要精簡的客戶端明確加 `?expand=` 的反向參數（例如 `?exclude=items`） |
| 3 | ⚠️ → ✅ | 靠 Consumer Contract **要求 2（處理未知列舉值 + 用 `statusLabel` 顯示）** + 測試工具（6.4.3）。<br>建議仍發 CHANGELOG（雖然契約上不需要） |
| 4 | ✅ **安全** | Consumer Contract **要求 4（用 `code` 判斷，不用訊息文字）** 明確涵蓋。<br>這是 `code` / `userMessage` 分離的直接回報（第 04 章 4.7.2） |
| 5 | ⚠️ → ✅ | 靠 Consumer Contract **要求 9（用 `hasMore` 不用 `items.length < size`）**。<br>⚠️ 但要注意：payload 變大 2.5 倍，行動網路的客戶端可能超時 → **實務上仍應公告** |
| 6 | 🔴 **破壞** | 集合預設排序變更 → 遍歷會重複／漏（第 05 章 5.9.3）。<br>6.11.1 §3 明確禁止。<br>正確做法：文件承諾預設排序永不變；要換就讓客戶端明確帶 `?sort=` |
| 7 | 🔴 **破壞** | 舊客戶端不帶 → `400`。<br>正確做法：三階段（6.7.6）—— 先 warning、再對已就緒的 consumer 強制、最後全面強制 |
| 8 | ✅ **安全** | 放寬驗證 |
| 9 | 🔴 **破壞** | 收緊驗證。舊客戶端送 300 字就 `422`。<br>⚠️ 而且這通常是「靜默」的：客戶端不會每次都送 300 字，所以只有部分請求失敗 → 很難重現 |
| 10 | 🔴🔴 **靜默破壞** | 型別變更（6.3.3 第 1 名）。<br>字串 → 數字會讓 JS 的精度問題出現，而且客戶端的 `parseFloat(amount)` 變成 `parseFloat(1280.50)`（碰巧能跑）→ **更難發現** |
| 11 | ⚠️ → ✅ | 靠 Consumer Contract **要求 5（用狀態碼類別判斷，不用 `=== 200`）**。<br>兩者都是 4xx → 一個正確實作的客戶端會走同一條錯誤處理路徑。<br>⚠️ 但若客戶端有 `if (status === 400) showFormErrors()` 就會壞 → 仍建議公告 |
| 12 | ⚠️ 小心 | 新增 header 是安全的，但**開始回 `304`** 需要客戶端處理。<br>若客戶端把 `304` 當錯誤（`res.ok` 是 `false`！）→ 破壞。<br>⚠️ `304` 的 `res.ok === false` 是很多人踩過的坑。<br>**折衷：只在客戶端主動帶 `If-None-Match` 時回 `304`** → 帶了就代表它懂 |
| 13 | ⚠️ → ✅ | `404` → `410` 都是 4xx。Consumer Contract 要求 5 涵蓋。<br>✅ 而且 `410` 帶了 `replacementProductId`（第 02 章 2.6.2），是實質改善 |
| 14 | ✅ **安全** | 新增端點 |
| 15 | ⚠️ **可能破壞** | 🔴 **這題最容易答錯**。<br>看起來只是換網址，但：<br>① 客戶端可能把 CDN 網域加入 CSP 白名單 → 圖片全部載不出來<br>② 客戶端可能對網址做字串處理（`url.replace('cdn-a.example', ...)` 加上尺寸參數）<br>③ App 可能有網域的憑證釘選（certificate pinning）<br>**任何「客戶端會拿去用的字串」都是契約的一部分。**<br>正確做法：公告 + 給過渡期（兩個網域同時可用）+ 提示客戶端不要解析網址結構 |

**這題的三個核心洞察**：

1. **一半的變更是「⚠️ 取決於客戶端」，而 Consumer Contract 決定它們落在哪一邊。**
   這就是為什麼 6.4 的那份文件是本章最有價值的產出 ——
   **沒有它，你無法安全地做任何變更。**

2. **第 12 題揭露一個常見盲點**：`304` 的 `res.ok` 是 `false`（`fetch` 只把 200-299 算 ok）。
   所以「加入快取支援」看起來無害，實際可能讓客戶端把它當錯誤。
   **只在客戶端主動帶 `If-None-Match` 時回 `304`** 是很優雅的解法。

3. **第 15 題提醒：契約不只是 JSON schema。**
   URL、網域、ID 格式、時間精度、陣列順序 —— 任何客戶端「看得到並可能依賴」的東西都是契約。

</details>

### 練習 2：設計 Expand–Contract 遷移

**需求**：訂單的 `shippingAddress` 目前是一個內嵌物件。
現在要支援「一張訂單分多個包裹寄到不同地址」。

目前：
```jsonc
{
  "orderId": "ord_1",
  "shippingAddress": { "recipient": "王小明", "line1": "民生東路...", ... },
  "items": [ { "itemId": "oi_1", "quantity": 2 }, { "itemId": "oi_2", "quantity": 1 } ]
}
```

目標：
```jsonc
{
  "orderId": "ord_1",
  "shipments": [
    { "shipmentId": "shp_1",
      "shippingAddress": { "recipient": "王小明", ... },
      "items": [ { "itemId": "oi_1", "quantity": 2 } ] },
    { "shipmentId": "shp_2",
      "shippingAddress": { "recipient": "李大華", ... },
      "items": [ { "itemId": "oi_2", "quantity": 1 } ] }
  ]
}
```

Consumer：Web、iOS App（30 萬使用者）、3 家廠商 ERP、2 個內部服務、1 個對帳批次。

設計完整的遷移計畫。特別說明「一張訂單多個地址時，舊客戶端看到什麼」。

<details>
<summary>參考解答</summary>

**第一步：判斷這需不需要 v2**

```
問：新舊模型能不能用「同一份資料的兩種視圖」表達？
答：可以 —— 舊的 shippingAddress 可以定義為「第一個 shipment 的地址」
→ ✅ 不需要 v2，用 Expand-Contract
```

**但有一個關鍵的語意問題必須先決定**：

```
一張訂單有兩個地址時，舊客戶端的 shippingAddress 應該是什麼？
  選項 A：第一個 shipment 的地址          ← 部分正確（會誤導）
  選項 B：null                            ← 舊客戶端可能 crash
  選項 C:  不允許舊客戶端建立多地址訂單     ← ✅ 見下
```

**shop-service 的決定：選項 A + C 的組合。**

| 方向 | 決定 |
|---|---|
| **Request**（建立訂單） | 舊格式（單一 `shippingAddress`）→ 建立**單一 shipment** 的訂單。<br>多地址**只能**用新格式建立 → 所以「多地址訂單」一定是新客戶端建的 |
| **Response**（讀取訂單） | `shippingAddress` = `shipments[0].shippingAddress`，<br>**並且**新增一個 `hasMultipleShipments: true` 旗標警示 |

**這個組合很重要**：它讓「舊客戶端看到誤導資訊」的機率降到最低 ——
因為舊客戶端建的訂單一定只有一個地址。
只有當**新客戶端建的多地址訂單**被**舊客戶端讀取**時才有問題。

---

**完整遷移計畫**

```
═══ 階段 ① Expand（Day 0，零風險） ═══════════════════════

Response：兩種視圖並存
{
  "orderId": "ord_1",

  // ── 舊視圖（deprecated，但保證永遠有值） ──
  "shippingAddress": { "recipient": "王小明", ... },   // = shipments[0].shippingAddress
  "hasMultipleShipments": false,                        // ★ 新增的警示旗標

  // ── 新視圖 ──
  "shipments": [
    { "shipmentId": "shp_1",
      "shippingAddress": { ... },
      "items": [ { "itemId": "oi_1", "quantity": 2 } ] }
  ],

  "items": [ { "itemId": "oi_1", "quantity": 2 } ]      // 保留（所有 shipment 的 items 聯集）
}

Request：兩種格式並存
// 舊格式（單一地址）
POST /v1/orders
{ "items": [...], "shippingAddressId": "addr_1" }
→ 建立一個 shipment

// 新格式（多地址）
POST /v1/orders
{
  "shipments": [
    { "shippingAddressId": "addr_1", "items": [{ "productId": "P-1", "quantity": 2 }] },
    { "shippingAddressId": "addr_2", "items": [{ "productId": "P-2", "quantity": 1 }] }
  ]
}
→ 建立兩個 shipment

// 兩種都送 → 422（6.7.3 的規則）
{
  "code": "VALIDATION_FAILED",
  "errors": [{ "field": "shipments", "code": "INVALID_COMBINATION",
               "message": "shippingAddressId 與 shipments 不可同時提供",
               "constraint": { "conflictsWith": ["shippingAddressId"] } }]
}
```

**⚠️ 關鍵設計：`hasMultipleShipments` 旗標**

```jsonc
// 多地址訂單，被舊客戶端讀取時
{
  "orderId": "ord_2",
  "shippingAddress": { "recipient": "王小明", ... },   // 只是第一個！
  "hasMultipleShipments": true,                          // 🔴 警示
  "shipmentCount": 2,
  "shipments": [ { ... }, { ... } ]
}
```

**這個旗標讓「有心的舊客戶端」可以做出正確的降級行為**：

```typescript
// 舊客戶端（已升級到讀取旗標，但還沒實作完整的多地址 UI）
if (order.hasMultipleShipments) {
  showBanner(`此訂單分 ${order.shipmentCount} 個包裹寄送，請至網頁版查看完整資訊`);
}
showAddress(order.shippingAddress);    // 仍顯示第一個，但使用者知道還有別的
```

**這是「兩階段遷移」的中間站**：先讓客戶端知道「有這件事」（一行程式碼），
再讓它實作完整的 UI（大改動）。

```
═══ 階段 ② Dual-write（Day 0，同一個 PR） ═════════════════

Schema（6.10.3 的六步）：
① ALTER TABLE orders ADD COLUMN legacy_shipping_address JSON NULL;  -- 保留舊快照
   CREATE TABLE shipments (
       id VARCHAR(40) PRIMARY KEY,
       order_id VARCHAR(40) NOT NULL,
       shipping_address JSON NOT NULL,
       sequence_no INT NOT NULL,
       ...
       KEY idx_shipments_order (order_id, sequence_no)
   );
   ALTER TABLE order_items ADD COLUMN shipment_id VARCHAR(40) NULL;

② 建立訂單時：一律寫入 shipments 表（單地址也是一筆）
   同時保留 orders.legacy_shipping_address（給回滾用）

⚠️ 漂移偵測：
   SELECT COUNT(*) FROM orders o
   WHERE JSON_EXTRACT(o.legacy_shipping_address, '$.recipient')
     <> (SELECT JSON_EXTRACT(s.shipping_address, '$.recipient')
         FROM shipments s WHERE s.order_id = o.id ORDER BY s.sequence_no LIMIT 1);
   → 必須是 0

═══ 階段 ③ Backfill（Day 1～3） ═══════════════════════════

把歷史訂單（300 萬筆）的 shippingAddress 轉成一筆 shipment：
- 分批，每批 5,000 筆
- 批次間 sleep 100ms
- 監控複寫延遲
- 可中斷可續跑（WHERE NOT EXISTS (SELECT 1 FROM shipments WHERE order_id = o.id)）
- 預估：300 萬 / 5,000 = 600 批 × (執行 + sleep) ≈ 2～4 小時

═══ 階段 ④ Migrate consumers（Day 0 ～ Day 180） ═════════

按「風險」排優先序，而不是按「難度」：

Consumer          風險    處理
─────────────────────────────────────────────────────────────
對帳批次          🔴 最高  Day 0 立刻改（會影響帳務！）
                          → 它讀 shippingAddress 只為了「寄送地區統計」
                          → 多地址會讓統計錯 → 必須改讀 shipments[]
廠商 ERP × 3      🔴 高    Day 0 通知，Day 30 前完成
                          → 它們的出貨流程假設「一單一地址」
                          → 🔴 關鍵：要問「你們的系統支援一單多址嗎？」
                            如果不支援 → 需要「拆單」機制（見下）
內部服務 × 2      🟡 中    Day 0～14（可協調排程）
Web               🟡 中    Day 7 前完成（含多地址 UI）
iOS App           🟢 低    Day 7 讀旗標（小改動 + 送審）
                          Day 60 完整多地址 UI（大改動）

⚠️ 廠商 ERP 的特殊處理（這題最現實的困難）：
   如果廠商的系統結構上無法處理「一單多址」，
   → 提供一個「拆單視圖」：GET /v1/orders?splitByShipment=true
     讓一張多地址訂單「看起來像」多張單地址訂單
     { "items": [
         { "orderId": "ord_2#shp_1", "shippingAddress": {...}, "items": [...] },
         { "orderId": "ord_2#shp_2", "shippingAddress": {...}, "items": [...] }
       ] }
   → 這比「要求廠商改造整個 ERP」現實得多

═══ 階段 ⑤ Deprecate（Day 0 起） ═════════════════════════

OpenAPI:
  OrderDetail:
    properties:
      shippingAddress:
        deprecated: true
        description: |
          ⚠️ 已棄用。此欄位僅代表**第一個** shipment 的地址。
          若 hasMultipleShipments 為 true，此欄位不足以描述完整的配送資訊。
          請改用 shipments[]。Sunset: 2027-06-01。

Header:
  Deprecation: @1755561600
  Sunset: Tue, 01 Jun 2027 00:00:00 GMT
  Link: <https://api.shop.example/changelog/2026-08-19-multi-shipment>; rel="deprecation"

用量監控（6.8.3）：
  - 端點層級：無法區分（同一個端點）
  - 欄位層級：用 client 版本推斷 + 影子測試
  - ★ 最有效的指標：「多地址訂單被舊版客戶端讀取的次數」
    Counter.builder("api.multi_shipment.read_by_legacy_client")
           .tag("consumer", consumerId)
           .increment();
    → 這個數字 > 0 就代表「有人正在看到誤導的資訊」→ 優先處理

═══ 階段 ⑥ Contract（Day 560+，或永不） ═══════════════════

⚠️ 這個案例的 Contract 有特殊考量：
   shippingAddress 是「shipments[0] 的投影」，維護成本只有幾行 mapper。
   而移除它會打壞任何還沒改完的 consumer。
   → 建議：永不移除，只保留 deprecated 標記
   → 但要移除 orders.legacy_shipping_address 欄位（DB 層的重複資料）
```

---

**「舊客戶端看到什麼」的完整矩陣**

| 訂單類型 | 建立者 | 舊客戶端讀取時看到 | 風險 |
|---|---|---|---|
| 單地址（歷史訂單） | — | `shippingAddress` 正確、`hasMultipleShipments: false` | ✅ 無 |
| 單地址（舊客戶端建立） | 舊客戶端 | 同上 | ✅ 無 |
| 單地址（新客戶端建立） | 新客戶端 | 同上 | ✅ 無 |
| **多地址** | **新客戶端** | `shippingAddress` = 第一個地址<br>`hasMultipleShipments: true` | ⚠️ **會誤導** |

**唯一有風險的是最後一列，而它的發生條件是「新客戶端建立 + 舊客戶端讀取」。**

**降低風險的三個措施**：

| 措施 | 說明 |
|---|---|
| 1. 多地址功能**灰度開放** | Day 0～90 只對 Web 開放建立多地址訂單；<br>Day 90+（App 已能讀旗標）才對 App 開放 |
| 2. `hasMultipleShipments` 旗標 | 讓有心的舊客戶端能顯示警示 |
| 3. 監控指標 | `multi_shipment.read_by_legacy_client` —— 這個數字告訴你風險的實際規模 |

**第 1 個措施是最有效的**：**控制「誰能製造出讓舊客戶端困惑的資料」。**

這是很重要的一般性原則：

> **Expand-Contract 的風險不在「新增欄位」，而在「新功能製造出舊視圖無法表達的資料」。**
> 所以新功能要灰度開放，等 consumer 都能處理了才全開。

</details>

### 練習 3：設計棄用流程

你要移除 `GET /v1/orders/{id}/legacy-summary` 這個端點（三年前為某個已下線的舊 App 版本做的）。

已知：
- 過去 30 天有 148,000 次呼叫。
- 來源分布：`X-Client-Id` 為空的 89%、`shop-ios/3.x` 的 8%、`vendor-c-erp` 的 3%。
- 你不知道那 89% 是誰。

設計完整的移除計畫。

<details>
<summary>參考解答</summary>

**第一步：不要急著設 Sunset 日期 —— 先解決「89% 是誰」**

**這是整個計畫的關鍵。** 沒有 consumer 識別，任何 Sunset 日期都是猜的。

```
Day -30 ~ Day 0：識別階段
```

**五種識別手法（並行使用）**：

| 手法 | 做法 | 能得到什麼 |
|---|---|---|
| **1. `User-Agent` 分析** | 記錄並分群 | `okhttp/4.9.0`（Android）、`CFNetwork`（iOS）、`python-requests/2.28`（腳本）、`PostmanRuntime`（人工測試） |
| **2. API key / token 反查** | 每個請求都有 token → 查它屬於哪個帳號／應用 | ★ **最有效** —— token 一定有主人 |
| **3. IP 分群 + reverse DNS** | 找出是哪個機房／公司 | 廠商的固定 IP 很好認 |
| **4. 呼叫模式分析** | 每 15 分鐘一次的規律呼叫 = 排程；隨機分布 = 真人使用 | 區分「人」和「機器」 |
| **5. 加一個回應 header 要求識別** | `Warning: 299 - "請帶 X-Client-Id，否則將於 X 日後無法使用此端點"` | ⚠️ 只有會讀 header 的人會看到 |

**實際做下來的典型結果**：

```
89% 未識別 → 用 token 反查後拆解成：
  52%  shop-ios/3.x（沒帶 X-Client-Id 的舊版本）  ← 原來是自家 App
  21%  一個內部的資料同步腳本（三年前寫的，作者已離職）  ← 🔴 最麻煩
  11%  vendor-a-erp（token 屬於廠商 A，但沒帶 header）
   4%  監控系統的健康檢查（打錯端點了）
   1%  真正不明（可能是外洩的 token）  ← 🔴 資安議題
```

**這個拆解改變了整個計畫**：
- 「52% 是自家舊 App」→ 要查那些 App 版本的使用者數與升級曲線。
- 「21% 是無主腳本」→ 要找出它在哪台機器上跑、做什麼用。
- 「1% 不明」→ 這是資安事件，要單獨處理（可能要作廢那個 token）。

---

**完整計畫**

```
═══ Day -30 ~ 0：識別與評估 ═════════════════════════════

□ 用上述五種手法完成 consumer 識別
□ 對「1% 不明」啟動資安調查（token 是否外洩）
□ 找出那個無主腳本：
   - 從 IP 找到機器 → 從 crontab / systemd timer 找到腳本
   - 讀它的程式碼，判斷它到底需要什麼資料
   - ★ 可能發現：它只需要 legacy-summary 裡的兩個欄位，
     而那兩個欄位在 GET /v1/orders/{id} 裡也有 → 改一行就好
□ 查 shop-ios/3.x 的使用者數與版本分布
   - 若 3.x 還有 5 萬使用者 → Sunset 至少要 12 個月
   - 若只有 800 個 → 可以考慮強制升級 App
□ 撰寫遷移指引（含「legacy-summary 的每個欄位對應到新端點的哪裡」的對照表）

═══ Day 0：正式啟動 ═════════════════════════════════════

□ 發布 CHANGELOG + RSS
□ 端點開始回：
   Deprecation: @1755561600
   Sunset: Sat, 01 Jan 2028 00:00:00 GMT      ← 依 iOS 3.x 的用戶數決定
   Link: <.../changelog/2026-08-19-legacy-summary>; rel="deprecation"
   Warning: 299 - "This endpoint is deprecated. Use GET /v1/orders/{id}. Sunset: 2028-01-01"
□ OpenAPI 標記 deprecated: true
□ 加入 GET /v1/deprecations（含 yourUsage）
□ 一對一通知：
   - iOS 團隊（要規劃強制升級或補一個 3.x 的 hotfix）
   - 廠商 A（正式函文 + 技術聯絡人）
   - 廠商 C（同上）
   - 無主腳本的機器負責人（運維團隊）
   - 監控團隊（他們打錯端點了，5 分鐘就能改）
□ 建立看板：每個 consumer 的每日呼叫數 + 趨勢

═══ Day 30：第一次檢查 ═══════════════════════════════════

預期：監控系統（4%）已改完 → 用量降到 96%
     無主腳本（21%）已改完 → 降到 75%
□ 若無主腳本還在跑 → 升級處理：找它的業務 owner，評估「直接關掉」的影響

═══ Day 90：第二次檢查 + 廠商協調 ════════════════════════

預期：廠商 A、C（14%）已改完 → 降到 61%
□ 廠商若未動 → 電話會議 + 提供技術支援（甚至幫他們寫 patch）
□ ⚠️ 廠商合約若有「API 變更需 N 個月通知」條款 → 法務確認

═══ Day 180 ~ Day 400：等 App 汰換 ═══════════════════════

□ 每月檢查 iOS 3.x 的用量曲線
□ 若曲線平緩（有人永遠不升級）→ 考慮 App 內強制升級提示
   （iOS 的做法：3.x 啟動時檢查版本，顯示「請更新」的阻擋畫面）
□ ⚠️ 強制升級要謹慎：會流失使用者。要和產品團隊一起決定

═══ Day 480（Sunset 前 60 天）：最後通知 ══════════════════

□ 第三次通知（email + 電話 + 帳號內通知）
□ 公告 brownout 時程
□ 若仍有 > 1% 用量 → 決策點：
   選項 A：延期 6 個月（並公告延期，說明原因）
   選項 B：照計畫執行，接受那 1% 會壞
   ★ 判準：那 1% 是「誰」？如果是廠商的帳務系統 → 延期。
           如果是無主腳本 → 執行。

═══ Day 520（Sunset 前 20 天）：Brownout ═════════════════

Day 520  每天 03:00-03:15 回 410
Day 525  每天 03:00-04:00
Day 530  每小時的第 0-5 分鐘
Day 535  50% 的請求
Day 540  100%（Sunset）

⚠️ Brownout 期間的回應要明確標示（6.8.5 的 isBrownout: true）
⚠️ 要有 feature flag 能立刻停止
⚠️ 這個端點是「摘要查詢」（非關鍵路徑）→ 適合 brownout ✅

═══ Day 540：Sunset ═════════════════════════════════════

□ 端點回 410 Gone + replacement + migrationGuide
□ 監控 410 的呼叫量與來源（誰還在打）
□ 保留 410 回應 90 天

═══ Day 630：410 → 404 ══════════════════════════════════

□ 移除路由
□ 移除程式碼與測試
□ 從 OpenAPI 移除
□ 棄用登記表標記為 REMOVED
```

---

**這題的五個核心教訓**

| # | 教訓 |
|---|---|
| 1 | **「不知道是誰在用」不是無解的問題** —— token 反查、`User-Agent`、IP、呼叫模式四種手法可以識別 95%+ |
| 2 | **識別完成後，計畫會完全改變**。原本以為「89% 是外部未知使用者」，實際上一半是自家 App、五分之一是無主腳本 |
| 3 | **Sunset 日期由「最慢的那個 consumer」決定**，而通常是 App（1～3 年，第 00 章 0.8.1） |
| 4 | **「無主腳本」常常是最容易解決的**（改一行就好），但要先找到它 —— 這需要運維協助 |
| 5 | **1% 不明用量可能是資安事件**（外洩的 token），要單獨處理，不要只當成「遷移問題」 |

**最重要的一點**：這整個計畫花了 630 天（21 個月）。

**如果三年前就有 consumer 識別（`X-Client-Id` 強制），這個流程只需要 180 天。**
所以「要求 consumer 帶識別 header」不是官僚，是**未來省下 15 個月的投資**。

</details>

### 練習 4：schema 遷移的相容性

你要把 `orders.status` 從 `VARCHAR(32)` 改成 `TINYINT`（DBA 說省空間、索引更快）。

現況：
- 300 萬筆訂單。
- K8s 三個 Pod，滾動更新。
- 7 個狀態值。
- `status` 有索引，且是最常用的篩選條件。

1. 這個變更值得做嗎？
2. 如果要做，寫出完整的遷移步驟。
3. API 層要不要跟著改？

<details>
<summary>參考解答</summary>

**1. 這個變更值得做嗎？—— 先算，不要直接動手**

**空間節省**：

```
VARCHAR(32) 存 'PENDING_PAYMENT'：1 byte 長度 + 15 bytes = 16 bytes
TINYINT：                                                    1 byte
每筆省 15 bytes × 300 萬 = 45 MB

索引（status, created_at, id）：
  VARCHAR(32) 版本：32 + 5 + 8 + 主鍵開銷 ≈ 50 bytes/項 → 150 MB
  TINYINT 版本：     1 + 5 + 8 + 主鍵開銷 ≈ 20 bytes/項 →  60 MB
  省 90 MB

合計省約 135 MB
```

**135 MB。** 現代伺服器的 buffer pool 通常是 8～64 GB。

**成本**：

| 成本 | 估計 |
|---|---|
| 遷移工程（6 個 migration + 雙寫 + 回填 + 對帳） | 5～8 人天 |
| 300 萬筆回填的執行風險 | 2～4 小時的批次作業 + 監控 |
| 滾動更新期間的雙版本相容 | 需要仔細設計 |
| 🔴 **log / 除錯的可讀性永久下降** | `status=2` vs `status=PAID`（第 03 章 3.5.5） |
| 🔴 **列舉順序變更的風險** | 有人在 enum 中間插值 → 所有資料語意改變（第 03 章 3.5.5 的災難） |
| 對帳／報表 SQL 全部要改 | 未知（可能有幾十份） |

**結論：不值得做。**

```
效益：省 135 MB（約 buffer pool 的 0.5%）
成本：8 人天 + 永久的可讀性損失 + 一類新的災難風險
```

**如果 DBA 的真正動機是「索引效能」**，有更便宜的做法：

| 替代方案 | 效果 |
|---|---|
| `VARCHAR(32)` → `VARCHAR(20)` | 縮短到實際最長值（`PARTIALLY_SHIPPED` = 18 字元）。⚠️ 但 VARCHAR 是變長的，實際佔用取決於內容，所以效果有限 |
| 改用 `ENUM('PENDING_PAYMENT', ...)` | MySQL 的 `ENUM` **內部存 1～2 bytes**，但**查詢時用字串** ★ 兼得兩者 |
| 確認索引的欄位順序正確 | 通常這才是真正的效能問題（第 05 章 5.9.4） |
| 確認 charset / collation | `utf8mb4` 的 VARCHAR(32) 在**索引**裡可能保留 32×4 bytes（依版本與索引類型） |

**`ENUM` 值得認真考慮**：

```sql
ALTER TABLE orders MODIFY COLUMN status
    ENUM('PENDING_PAYMENT','PAID','PARTIALLY_SHIPPED','SHIPPED',
         'COMPLETED','CANCELLED','RETURNED') NOT NULL;
```

| | `VARCHAR(32)` | `ENUM` | `TINYINT` |
|---|---|---|---|
| 儲存 | 1+len bytes | **1～2 bytes** | 1 byte |
| 查詢時的寫法 | `= 'PAID'` | **`= 'PAID'`** ✅ | `= 2` ❌ |
| log 可讀性 | ✅ | ✅ | ❌ |
| 新增值 | 免費 | ⚠️ 需要 `ALTER TABLE`（MySQL 8.0 加在**尾端**是 instant DDL） | 免費 |
| 移除／重排值 | 免費 | 🔴 危險（會改變內部序號） | 🔴 危險 |
| 應用層對映 | 直接 | 直接 | 需要對照表 |

**`ENUM` 的取捨**：省了空間、保留可讀性，但新增狀態要 `ALTER TABLE`。
⚠️ 而且 `ENUM` 有一個知名的坑：**不要移除或重排值**（內部是序號，和 `TINYINT` 有同樣的風險）。

**shop-service 的建議**：

```
1. 先確認索引設計正確（第 05 章 5.11.2）—— 這通常是真正的瓶頸
2. 若空間真的是問題，改用 ENUM（保留可讀性）
3. 不要改成 TINYINT
```

---

**2. 如果組織決定要做（假設 DBA 堅持），完整步驟**

```sql
-- ① Expand（Day 0）：加新欄位，可為 NULL
-- V20260819_01__add_status_code.sql
ALTER TABLE orders ADD COLUMN status_code TINYINT NULL COMMENT '狀態（數字，遷移中）';

-- ⚠️ 對照表必須寫進版控且永不改變順序
-- 1=PENDING_PAYMENT 2=PAID 3=PARTIALLY_SHIPPED 4=SHIPPED
-- 5=COMPLETED 6=CANCELLED 7=RETURNED
-- 🔴 新增狀態一律用 8, 9, 10...；絕不重用、絕不重排
```

```java
// ② Dual-write（Day 0，同一個部署）
@Entity
public class Order {
    @Enumerated(EnumType.STRING)                  // ★ 一定是 STRING，不是 ORDINAL
    @Column(name = "status", nullable = false)
    private OrderStatus status;

    @Column(name = "status_code")
    private Byte statusCode;

    @PrePersist @PreUpdate
    void syncStatusCode() {
        this.statusCode = status == null ? null : status.code();   // ★ 明確的 code()，不是 ordinal()
    }
}

public enum OrderStatus {
    PENDING_PAYMENT((byte) 1),
    PAID((byte) 2),
    PARTIALLY_SHIPPED((byte) 3),
    SHIPPED((byte) 4),
    COMPLETED((byte) 5),
    CANCELLED((byte) 6),
    RETURNED((byte) 7);
    // 🔴 絕對不要用 ordinal()！在中間插一個值就全毀（第 03 章 3.5.5）

    private final byte code;
    OrderStatus(byte code) { this.code = code; }
    public byte code() { return code; }

    private static final Map<Byte, OrderStatus> BY_CODE =
            Arrays.stream(values()).collect(toMap(OrderStatus::code, identity()));

    public static OrderStatus ofCode(byte c) {
        OrderStatus s = BY_CODE.get(c);
        if (s == null) throw new IllegalStateException("未知的狀態代碼: " + c);
        return s;
    }
}
```

**⚠️ 滾動更新相容性檢查**（6.10.2）：

```
新增可為 NULL 的欄位 → 舊 Pod 的 INSERT 不指定它 → status_code 是 NULL
→ ✅ 舊 Pod 可以正常運作
→ ⚠️ 但舊 Pod 建立的訂單會有 status_code = NULL
→ 所以回填要在「所有 Pod 都是新版」之後才能算完成
```

**這是很容易踩的坑**：回填跑完了，但滾動更新還沒完成，
舊 Pod 又建了一批 `status_code IS NULL` 的訂單。
**解法：回填要跑「兩次」—— 一次批次回填歷史資料，一次在滾動更新完成後補漏。**

```java
// ③ Backfill（Day 1）：分批，不放在 Flyway 裡
@Component
public class StatusCodeBackfillJob {

    private static final int BATCH = 5_000;

    public void run() {
        long lastId = loadCheckpoint();
        while (true) {
            int updated = jdbc.update("""
                    UPDATE orders SET status_code = CASE status
                        WHEN 'PENDING_PAYMENT'    THEN 1
                        WHEN 'PAID'               THEN 2
                        WHEN 'PARTIALLY_SHIPPED'  THEN 3
                        WHEN 'SHIPPED'            THEN 4
                        WHEN 'COMPLETED'          THEN 5
                        WHEN 'CANCELLED'          THEN 6
                        WHEN 'RETURNED'           THEN 7
                    END
                    WHERE status_code IS NULL AND id > ?
                    ORDER BY id
                    LIMIT ?
                    """, lastId, BATCH);
            if (updated == 0) break;

            lastId = jdbc.queryForObject(
                    "SELECT MAX(id) FROM orders WHERE status_code IS NOT NULL", Long.class);
            saveCheckpoint(lastId);

            waitForReplication();          // ★ 監控複寫延遲，> 5 秒就等
            sleep(100);
        }
    }
}
```

```java
// ④ Dual-read（Day 3）：新程式優先讀 status_code，fallback 到 status
// ⚠️ 實務上這一步常常可以跳過 —— 因為 Entity 裡兩個欄位都在，
//    真正的「切換」發生在查詢條件上：
//    WHERE status = 'PAID'        →  WHERE status_code = 2
//    這個切換要等 ⑤ 之後（確保 status_code 沒有 NULL）
```

```sql
-- ⑤ 切換（Day 14）：加約束 + 建索引 + 切換查詢
-- V20260902_01__status_code_not_null.sql

-- 前置檢查（失敗就中止 migration）
-- SELECT COUNT(*) FROM orders WHERE status_code IS NULL;  → 必須是 0

ALTER TABLE orders MODIFY COLUMN status_code TINYINT NOT NULL;

-- 建新索引（ALGORITHM=INPLACE 避免鎖表；大表建議用 gh-ost）
CREATE INDEX idx_orders_statuscode_created
    ON orders (status_code, created_at DESC, id DESC) ALGORITHM=INPLACE;

-- ⚠️ 不要立刻 DROP 舊索引 —— 等確認新索引真的被使用、效能真的更好
```

**⚠️ 切換查詢條件是一個獨立的部署**（不要和 migration 同一次）：

```
部署 N：  加欄位 + 雙寫（查詢仍用 status）
部署 N+1：回填完成後，加約束 + 建索引
部署 N+2：查詢切換到 status_code
部署 N+3：（觀察兩週後）移除 status 欄位與舊索引
```

**每一步之間要有觀察期。** 一次做完的話，出問題時你不知道是哪一步造成的。

```sql
-- ⑥ Contract（Day 90+）
-- V20261101_01__drop_status_varchar.sql
DROP INDEX idx_orders_status_created ON orders;
ALTER TABLE orders DROP COLUMN status;
```

**⚠️ 但這一步之前必須確認**：
- 所有報表／對帳 SQL 都改了（`WHERE status = 'PAID'` → `WHERE status_code = 2`）。
- BI 工具的資料模型改了。
- 沒有任何 `SELECT *` 依賴欄位順序。
- 🔴 **有完整備份，且演練過回滾**。

---

**3. API 層要不要跟著改？—— 🔴 絕對不要**

```jsonc
// ✅ API 回應永遠是字串列舉
{ "status": "PAID", "statusLabel": "已付款", "statusCategory": "IN_PROGRESS" }

// 🔴 絕對不要因為資料庫改成 TINYINT 就把 API 也改成數字
{ "status": 2 }
```

**理由**：

| 理由 | 說明 |
|---|---|
| 第 03 章 3.5.5 | 魔術數字讓 log、除錯、前端都變難 |
| 6.3.3 | 這是**型別 + 語意變更** = 最危險的破壞性變更 |
| **分層原則** | 資料庫的儲存格式是**實作細節**，不該洩漏到 API 契約（第 01 章規則 7） |

**這題最重要的一點**：

> **資料庫的最佳化不應該影響 API 契約。**
> 如果一個「省 135 MB 的儲存最佳化」導致你要做破壞性 API 變更，
> 那說明你的分層有問題 —— **Entity 到 DTO 的 mapper 就是為了隔離這種變化而存在的**（第 03 章 3.15）。

**mapper 只要一行**：

```java
// Entity 存 status_code (TINYINT)，DTO 回 status (String)
.status(OrderStatus.ofCode(entity.getStatusCode()).name())
```

**這一行就是「分層」的全部價值。**

</details>

### 練習 5：設計 Consumer Contract 的測試工具

第 6.4.3 提到「必須提供可測試的工具」。請設計三個工具，讓 consumer 能真的驗證自己遵守了 Consumer Contract。

<details>
<summary>參考解答</summary>

**工具 1：未知值注入（`?_inject=`）**

**目的**：驗證 Consumer Contract 要求 1（忽略未知欄位）與要求 2（處理未知列舉值）。

```http
GET /orders?_inject=unknownEnum:status,unknownField,newErrorCode
Authorization: Bearer <staging token>
X-Client-Id: shop-ios
```

**⚠️ 這個參數只在 staging 生效**（正式環境回 `400 UNKNOWN_QUERY_PARAMETER`）。

```jsonc
{
  "items": [
    {
      "orderId": "ord_test_001",
      "status": "__FUTURE_STATUS_FOR_TESTING__",        // ← unknownEnum:status
      "statusLabel": "（測試用未知狀態）",
      "statusCategory": "IN_PROGRESS",                   // 粗粒度分類仍然是已知值
      "allowedActions": ["VIEW_DETAIL"],
      "__test_unknown_field": {                          // ← unknownField
        "note": "這是一個測試用的未知欄位。你的解析器應該完全忽略它。",
        "nested": { "arbitrary": [1, 2, 3] }
      },
      "totalAmount": "1280.50",
      "currency": "TWD",
      ...
    }
  ],
  "page": { "mode": "OFFSET", "number": 0, "size": 20, "totalElements": 1, "hasMore": false },
  "__test_injection": {
    "applied": ["unknownEnum:status", "unknownField"],
    "notApplied": ["newErrorCode"],
    "reason": { "newErrorCode": "此注入只在錯誤回應中生效，請用 ?_inject=newErrorCode&_forceError=true" }
  }
}
```

**支援的注入類型**：

| 注入 | 效果 | 驗證的契約條款 |
|---|---|---|
| `unknownEnum:status` | `status` 回一個未定義的值 | 要求 2 |
| `unknownEnum:paymentMethod` | 同上 | 要求 2 |
| `unknownField` | 每個物件多一個 `__test_unknown_field` | 要求 1 |
| `newErrorCode` | 錯誤回應用一個未定義的 `code` | 要求 3 |
| `reorderFields` | 回應的 JSON 欄位順序隨機化 | 要求 7 |
| `reorderArray` | `items` 陣列順序隨機化（但仍符合排序語意） | 要求 6 |
| `status201` | `POST` 回 `201` 而不是 `200`（或反之） | 要求 5 |
| `nullOptionalFields` | 所有選填欄位回 `null` | — |
| `omitOptionalFields` | 所有選填欄位省略 | — |
| `maxLengthValues` | 所有字串欄位回最大長度的值 | 驗證 UI 不會爆版 |
| `largeIds` | ID 回 `MAX_SAFE_INTEGER` 以上的數值字串 | 要求 12 |
| `slowResponse:3000` | 延遲 3 秒回應 | 要求 11（超時處理） |

**Consumer 的測試**：

```typescript
describe('Consumer Contract 合規測試', () => {
  it('要求 1：忽略未知欄位', async () => {
    const res = await api.get('/orders?_inject=unknownField');
    expect(res.items).toHaveLength(1);          // 解析成功，沒有拋錯
  });

  it('要求 2：處理未知列舉值', async () => {
    const res = await api.get('/orders?_inject=unknownEnum:status');
    const { container } = render(<OrderList orders={res.items} />);
    expect(container).not.toHaveTextContent('undefined');
    expect(container).not.toHaveTextContent('NaN');
    expect(container).toHaveTextContent('（測試用未知狀態）');   // 用了 statusLabel ✅
  });

  it('要求 6：不依賴陣列順序', async () => {
    const a = await api.get('/orders?_inject=reorderArray&_seed=1');
    const b = await api.get('/orders?_inject=reorderArray&_seed=2');
    // 兩次的順序不同，但我的邏輯結果應該一樣
    expect(computeTotal(a.items)).toEqual(computeTotal(b.items));
  });

  it('要求 12：ID 用字串處理', async () => {
    const res = await api.get('/orders?_inject=largeIds');
    const id = res.items[0].orderId;
    expect(typeof id).toBe('string');
    // 用這個 ID 再查一次，應該拿到同一筆（沒有精度遺失）
    const detail = await api.get(`/orders/${id}`);
    expect(detail.orderId).toBe(id);
  });
});
```

**實作要點**：

```java
@Component
@Profile({"local", "staging"})                  // ★ 只在非正式環境註冊
public class TestInjectionAdvice implements ResponseBodyAdvice<Object> {

    @Override
    public boolean supports(MethodParameter p, Class<? extends HttpMessageConverter<?>> c) {
        return true;
    }

    @Override
    public Object beforeBodyWrite(Object body, ...) {
        String inject = currentRequest().getParameter("_inject");
        if (inject == null || inject.isBlank()) return body;

        // ★ 審計：記錄誰在用注入功能（幫助你知道哪些 consumer 認真在測）
        log.info("測試注入 consumer={} inject={}", consumerId(), inject);
        meterRegistry.counter("test.injection.used",
                "consumer", consumerId(), "type", inject).increment();

        return injectionEngine.apply(body, parse(inject));
    }
}
```

**「記錄誰在用」是很有價值的副產品**：
它讓你知道「哪些 consumer 真的在測試合規性」——
那些從沒用過注入功能的 consumer，就是你新增列舉值時最可能壞掉的。

---

**工具 2：契約合規報告（`GET /v1/compliance/my-report`）**

**目的**：讓 consumer 知道「我目前有哪些不合規的行為」。

```http
GET /v1/compliance/my-report
Authorization: Bearer <consumer token>
```

```jsonc
{
  "consumer": { "clientId": "vendor-c-erp", "displayName": "廠商 C ERP" },
  "period": { "from": "2026-08-12", "to": "2026-08-19" },
  "overallStatus": "WARN",
  "checks": [
    {
      "requirement": 8,
      "title": "分頁請跟著 links.next 走",
      "status": "FAIL",
      "detail": "偵測到 1,204 次「自行組裝 page 參數」的請求（page 遞增但未帶我們回傳的 links.next 對應的參數組合）。",
      "risk": "我們調整分頁機制時你會拿到重複或遺漏的資料。",
      "evidence": { "sampleRequests": ["/v1/orders?page=1&size=100", "/v1/orders?page=2&size=100"] },
      "guide": "https://api.shop.example/docs/pagination#follow-links"
    },
    {
      "requirement": 10,
      "title": "關鍵寫入操作必須帶 Idempotency-Key",
      "status": "FAIL",
      "detail": "POST /v1/orders 的 48 次請求中，48 次未帶 Idempotency-Key。",
      "risk": "網路重試時可能重複建立訂單。",
      "guide": "https://api.shop.example/docs/idempotency"
    },
    {
      "requirement": 16,
      "title": "每個請求必須帶 X-Client-Id 與 X-Client-Version",
      "status": "WARN",
      "detail": "98% 的請求已帶 X-Client-Id，但 X-Client-Version 缺失。",
      "risk": "我們無法為你的版本做針對性的相容處理與通知。"
    },
    {
      "requirement": 11,
      "title": "重試必須用指數退避 + 抖動",
      "status": "PASS",
      "detail": "偵測到 12 次重試，退避間隔符合指數分布。"
    },
    {
      "requirement": 15,
      "title": "訂閱 CHANGELOG 與棄用公告",
      "status": "WARN",
      "detail": "你目前使用 2 個已棄用的項目，其中 1 個將於 68 天後 Sunset。",
      "deprecations": [
        { "id": "dep_2026_08_status_int", "target": "OrderSummary.statusCode",
          "sunsetAt": "2027-06-01", "yourUsage7d": 8421 }
      ]
    }
  ],
  "summary": { "pass": 11, "warn": 3, "fail": 2, "notApplicable": 0 }
}
```

**這個端點的價值**：

| 價值 | 說明 |
|---|---|
| **把「相容性」變成可量測的** | consumer 有一個明確的分數可以改善 |
| **CI 可以檢查** | `curl ... \| jq -e '.summary.fail == 0'` |
| **讓「我不知道我不合規」不再是藉口** | 你提供了工具，責任明確 |
| **給你談判的依據** | 「你們的合規報告有 2 個 FAIL，這是你們壞掉的原因」 |

**⚠️ 實作的難點**：這些檢查需要**分析歷史請求**（不是單一請求）。
所以要有一個離線的分析管線（讀 access log / trace，產生每個 consumer 的合規指標）。

**成本不低**，但對「consumer 很多且你控制不了他們」的公開 API 來說，投報率很高。

---

**工具 3：契約測試套件（給 consumer 用的可執行測試包）**

**目的**：讓 consumer 不用自己寫測試 —— 我們提供。

```bash
# consumer 在自己的 CI 上跑
npx @shop/api-contract-test \
  --base-url https://staging-api.shop.example \
  --token $STAGING_TOKEN \
  --client-id vendor-c-erp \
  --adapter ./my-order-parser.js
```

```javascript
// consumer 提供一個 adapter，告訴我們的測試套件「怎麼呼叫你的解析邏輯」
// my-order-parser.js
export default {
  /** 把 API 的訂單回應餵給你的解析／渲染邏輯，回傳你解析後的結果 */
  parseOrderList: (json) => myApp.parseOrders(json),
  parseOrderDetail: (json) => myApp.parseOrder(json),
  parseError: (status, json) => myApp.handleApiError(status, json),
  /** 你的分頁遍歷邏輯 */
  paginateAll: (fetchFn) => myApp.fetchAllOrders(fetchFn),
};
```

```
執行結果：

  Consumer Contract 合規測試  vendor-c-erp

  要求 1  忽略未知欄位
    ✅ 回應含未知欄位時解析成功
    ✅ 巢狀的未知欄位不影響解析

  要求 2  處理未知列舉值
    ✅ 未知 status 不拋錯
    ❌ 未知 status 的顯示結果是 "undefined"
       → 你的 parseOrderList 對未知狀態回傳了 undefined。
         請 fallback 到 statusLabel 或顯示原始值。
         參考：https://api.shop.example/docs/enums#unknown-values

  要求 5  用狀態碼類別判斷
    ✅ POST 回 201 時仍視為成功
    ✅ 錯誤從 400 改成 422 時走同一條處理路徑

  要求 8  分頁跟著 links.next 走
    ❌ paginateAll 自行組裝了 page 參數
       → 偵測到你呼叫了 /v1/orders?page=1，但我們回傳的 links.next 是
         /v1/orders?cursor=eyJ...
         請改用 res.links.next。

  要求 9  用 hasMore 判斷結束
    ❌ 當我們回傳的筆數少於你要求的 size 時，你停止了分頁
       → 我們夾取了 size（100 → 20），你只拿到 20 筆就停了。
         實際上還有 1,480 筆。請改用 res.page.hasMore。

  要求 12 ID 用字串處理
    ✅ 大數字 ID 沒有精度遺失

  要求 13 時間當 UTC 處理
    ❌ 你把 "2026-08-19T06:12:44Z" 解析成當地時間
       → 你的 parseOrderDetail 回傳的 createdAt 是 2026-08-19T06:12:44（無時區），
         應該是 2026-08-19T14:12:44+08:00 或保持 UTC。

  結果：10 通過、4 失敗
  詳細報告：./contract-test-report.html
```

**這個工具的三個關鍵設計**：

| 設計 | 理由 |
|---|---|
| **consumer 只需寫 adapter**（10～30 行） | 降低採用門檻。要求 consumer 自己寫 20 個測試，沒人會做 |
| **錯誤訊息包含「你做了什麼、應該做什麼、文件在哪」** | 讓 consumer 能自己修，不用開工單 |
| **可以在 CI 上跑並 fail build** | 讓合規變成硬性要求，不是建議 |

---

**三個工具的定位**

| 工具 | 誰用 | 何時用 | 成本 |
|---|---|---|---|
| **1. 注入參數** | consumer 的開發者 | 寫自己的測試時 | ★ 低（幾百行） |
| **2. 合規報告** | consumer 的 tech lead / 你的 API 治理團隊 | 定期檢視、談判時 | 高（需要離線分析管線） |
| **3. 測試套件** | consumer 的 CI | 每次 build | 中（要維護一個 npm 套件 + adapter 介面） |

**建議的導入順序**：**1 → 3 → 2**。

工具 1 成本最低、立刻有用。工具 3 是工具 1 的包裝（讓 consumer 不用自己寫）。
工具 2 最貴，只有在 consumer 數量多到無法一對一溝通時才值得。

---

**最後一個洞察**

> **Consumer Contract 的執行力，等於你提供的工具的品質。**
>
> 一份寫得再好的契約文件，如果 consumer 無法「跑一個指令就知道自己合不合規」，
> 那它就只是一份免責聲明 —— 而免責聲明不能防止你的 API 在新增列舉值時打壞 30 萬個 App。
>
> **相容性不是靠文件維持的，是靠工具維持的。**

</details>

---

## 6.14 驗收清單

- [ ] 我能算出「開一個 v2」的一次性與持續成本，並說明為什麼它是最後手段。
- [ ] 我知道 Stripe 13 年沒有 v2、Twilio 14 年沒換路徑版本，也知道它們是怎麼做到的。
- [ ] 我知道 SemVer 不適用於 API 的外部版本（`MINOR`/`PATCH` 對 consumer 不可見）。
- [ ] 我能用判定表在 30 秒內判斷任何變更是不是破壞性的。
- [ ] 我能說出三種最危險的變更（型別、單位／語意、分頁基準／排序），並解釋它們為什麼「靜默」。
- [ ] 我知道「改語意必須改名字」，也能解釋為什麼保留原名會讓「新舊客戶端都是壞的」。
- [ ] 我能撰寫一份 Consumer Contract，包含我的保證、我可能做的事、對 consumer 的要求。
- [ ] 我知道 Consumer Contract 決定了「⚠️ 取決於客戶端」的變更落在安全還是破壞那一邊。
- [ ] 我知道**必須提供可測試的工具**（未知值注入），否則沒有 consumer 會遵守契約。
- [ ] 我理解 Postel's Law，也知道「過度寬容」會讓「猜測」變成事實上的契約。
- [ ] 我能比較四種版本策略，並說出 Stripe / GitHub / Twilio / Azure 各自的取捨。
- [ ] 我知道日期版本 + 帳號釘住的核心是「版本轉換鏈」而不是「複製程式碼」，也知道它的實作代價。
- [ ] 我知道 Header 版本的最大風險是漏了 `Vary`，以及 `curl` 除錯不便。
- [ ] 我知道為什麼「端點級版本」的認知成本太高，不該採用。
- [ ] 我知道 feature flag 適合「暫時的差異」，版本適合「永久的差異」，且 flag 必須有移除日期。
- [ ] 我能用 Expand–Contract 六步流程處理欄位改名、型別變更、拆分、合併、必填性變更。
- [ ] 我知道新舊欄位必須由**單一來源推導**，否則遲早不一致。
- [ ] 我知道「兩個欄位都送但值不同」必須回 `422`，不能「後者覆蓋前者」。
- [ ] 我知道「選填 → 必填」要走三階段（warning → 部分強制 → 全面強制），也知道先問「能不能用預設值解決」。
- [ ] 我知道 Expand–Contract 的第 ⑥ 步（Contract）常常不執行是理性的。
- [ ] 我知道 Expand-Contract 的風險在「新功能製造出舊視圖無法表達的資料」，所以新功能要灰度開放。
- [ ] 我能設計完整的 180 天棄用流程，包含 `410` 過渡期（不是直接 `404`）。
- [ ] 我知道 `Sunset` 是 RFC 8594（正式）、`Deprecation` 是 draft、`Warning` 已被 RFC 9111 廢除。
- [ ] 我知道 `410` 回應要帶 `replacement` 與 `migrationGuide`，這能省下十封 email。
- [ ] 我知道 consumer 識別是用量監控的前提，也知道用 token 反查、`User-Agent`、IP、呼叫模式四種手法。
- [ ] 我知道「影子移除」是驗證「能不能安全移除」最可靠的方法，也知道它的三個限制。
- [ ] 我能設計 `GET /v1/deprecations` 含 `yourUsage`，把棄用溝通從推播變成拉取。
- [ ] 我知道 brownout 的時程設計、必要配套，以及「絕不對付款／下單做 brownout」。
- [ ] 我能在 CI 上用 `oasdiff` 偵測破壞性變更，並把變更報告貼到 PR。
- [ ] 我知道 allowlist 的每個條目都要有 `expiresAt`，否則檢查會形同虛設。
- [ ] 我知道回應結構快照測試同時是**資安護欄**（防止意外多回欄位）。
- [ ] 我知道 CDC 的獨特價值是「在編譯期就知道哪些欄位真的有人用」。
- [ ] 我知道 schema 遷移和 API 版本是同一個問題，也知道滾動更新期間的雙版本相容規則。
- [ ] 我能寫出欄位改名的六步 migration，包含分批回填、漂移偵測、以及「回填要跑兩次」的坑。
- [ ] 我知道資料庫的儲存最佳化**不該**影響 API 契約，而 mapper 就是為了隔離它而存在。
- [ ] 我完成了 shop-service 的版本策略、PR checklist 與棄用登記表。

---

完成後請前往 [07-openapi-and-documentation.md](./07-openapi-and-documentation.md)。
