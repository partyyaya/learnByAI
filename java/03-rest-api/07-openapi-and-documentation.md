# 第 07 章：OpenAPI 與文件

> 前面六章的所有決定，都存在你的腦袋和幾份 Markdown 表格裡。
> 這一章要把它們變成**一份機器可讀的契約** —— 因為只有機器讀得懂的東西，才不會過期。
>
> 這一章的產出是 `orders-api.yaml`：一份可以拿去產生文件、產生 mock server、產生 client SDK、
> 在 CI 上檢查破壞性變更、驗證實際回應是否符合契約的檔案。
> **它不是「文件」，它是契約。文件只是它的一種呈現方式。**

---

## 7.1 學習目標

完成本章後，你應該可以：

- 說出「手寫文件一定會過期」的三個結構性原因，以及「文件即契約」如何解決它。
- 完整說明 OpenAPI 3.1 的結構，以及 3.0 → 3.1 的五個關鍵差異。
- 在 Design-first 與 Code-first 之間做出有理由的選擇，並設計混合流程。
- 用 `components` 把共用的參數、回應、schema 抽出來，讓 83 條端點的契約不到 2000 行。
- 用 `oneOf` + `discriminator` 描述「同一個端點的多種回應形狀」（分頁模式、錯誤型別）。
- 寫出讓人真正看得懂的 `description` 與 `examples`，而不是重複欄位名。
- 用 springdoc-openapi 從程式碼產生契約，並知道十個「讓產出不要爛」的設定。
- 用 Prism 起 mock server，讓前端不用等後端。
- 用 Spectral 在 CI 上 lint 契約，並自訂符合你 style guide 的規則。
- 完成 shop-service 的 `orders-api.yaml`。

---

## 7.2 為什麼手寫文件一定會過期

### 7.2.1 三個結構性原因

**不是因為工程師懶。** 是因為結構上必然：

| 原因 | 說明 |
|---|---|
| **① 文件和程式碼是兩份事實** | 改程式碼不會讓文件失敗。沒有任何機制強迫它們一致 |
| **② 更新文件的人不是讀文件的人** | 寫的人已經知道答案（所以不覺得需要寫清楚），讀的人不知道（所以看不懂） |
| **③ 文件的正確性沒有回饋迴路** | 程式碼錯了會有測試失敗、會有使用者回報；文件錯了通常沒人說（讀者只會默默去問人或猜） |

**第 ③ 點最關鍵。** 所以解法不是「更努力地維護文件」,而是**建立回饋迴路**：

```
契約（機器可讀）
    ├─→ 產生文件         ← 文件不會和契約不一致（因為是產生的）
    ├─→ 產生 mock server ← 前端用 mock 開發，契約錯了前端立刻發現
    ├─→ 驗證實際回應     ← 測試會失敗（第 09 章 9.4）
    ├─→ CI 檢查破壞性變更 ← PR 會被擋（第 06 章 6.9.1）
    └─→ 產生 client SDK  ← consumer 的編譯會失敗
```

**每一條箭頭都是一個回饋迴路。** 有了它們，「文件過期」在機制上變得困難。

### 7.2.2 真實案例：一份 Word 文件的生命週期

```
Day 0    後端寫了一份「訂單 API 規格 v1.0.docx」放在共用磁碟
         → 22 頁，有表格、有範例、寫得很認真

Day 14   前端發現 status 的值和文件不一樣（文件寫 "paid"，實際是 "PAID"）
         → Slack 問後端 → 後端說「哦對，改成大寫了」
         → 文件沒改

Day 30   後端加了 statusLabel 欄位
         → 前端不知道，自己維護了一份中文對照表
         → 兩份對照表，之後不同步

Day 60   有人把文件複製一份改成「訂單 API 規格 v1.1.docx」
         → 現在有兩份，不知道哪個是最新的

Day 90   新人問「訂單 API 文件在哪」
         → 得到三個不同的連結

Day 120  廠商 A 要對接
         → 傳了 v1.0.docx 給他（因為那是搜尋結果的第一個）
         → 廠商照著做，全部對不上
         → 三週的來回 email

Day 180  沒有人再打開那份文件
         → 唯一的真相來源變成「去問王工程師」
         → 王工程師離職
```

**這個軌跡在幾乎每個團隊都發生過。** 而它的每一步都很合理 —— 沒有人做錯事。

### 7.2.3 「文件即契約」vs「文件即說明」

| | 文件即說明 | 文件即契約 |
|---|---|---|
| 形式 | Word / Confluence / Markdown | **OpenAPI YAML/JSON** |
| 讀者 | 只有人 | **人 + 機器** |
| 一致性保證 | 靠人 | 靠 CI |
| 過期方式 | 靜默過期 | **CI 失敗** |
| 能產生什麼 | 什麼都不能 | 文件頁、mock、SDK、測試、diff |
| 版控 | ⚠️ 通常不在 | ✅ 在 repo，跟著 PR review |

**兩者都需要**：

```
OpenAPI（契約）      ← 精確、機器可讀、CI 驗證
    +
Markdown 指南（說明）← 「怎麼串接付款流程」「為什麼要冪等鍵」這類敘事
```

**判準**：

| 內容 | 放哪 |
|---|---|
| 端點、參數、欄位、型別、狀態碼、錯誤碼 | **OpenAPI** |
| 「訂單狀態機」的流程圖 | Markdown（並在 OpenAPI 的 `description` 連結過去） |
| 「怎麼從零開始串接」的教學 | Markdown |
| Consumer Contract（第 06 章 6.4） | Markdown + 嵌入 OpenAPI 的 `info.description` |
| CHANGELOG | Markdown |
| 錯誤碼目錄 | **OpenAPI**（每個 `type` 一個 schema）+ Markdown 索引頁 |

---

## 7.3 OpenAPI 3.1 結構總覽

### 7.3.1 頂層結構

```yaml
openapi: 3.1.0                # 版本宣告（必填）

info:                         # 元資料（必填）
  title: shop-service API
  version: "1.0.0"
  description: |
    ...（可以放 Consumer Contract）
  contact: { name: ..., email: ... }
  license: { name: ..., identifier: ... }

servers:                      # 可用的伺服器
  - url: https://api.shop.example/v1
    description: 正式環境

security:                     # 全域的認證要求
  - bearerAuth: []

tags:                         # 端點分組（決定文件的側邊欄）
  - name: Orders
    description: 訂單管理

paths:                        # ★ 端點定義（主體）
  /orders:
    get: { ... }
    post: { ... }

webhooks:                     # ★ 3.1 新增：你「發出」的 webhook
  orderShipped:
    post: { ... }

components:                   # ★ 可重用的元件（讓契約不要重複）
  schemas: { ... }
  parameters: { ... }
  responses: { ... }
  requestBodies: { ... }
  headers: { ... }
  examples: { ... }
  securitySchemes: { ... }
  pathItems: { ... }          # 3.1 新增

externalDocs:                 # 外部文件連結
  url: https://api.shop.example/docs
```

### 7.3.2 OpenAPI 3.0 → 3.1 的五個關鍵差異

| # | 差異 | 3.0 | 3.1 |
|---|---|---|---|
| 1 | **JSON Schema 對齊** | 自訂的 schema 子集（不完全相容 JSON Schema） | ★ **完整的 JSON Schema 2020-12** |
| 2 | **`nullable`** | `type: string` + `nullable: true` | `type: [string, "null"]` |
| 3 | **`example` → `examples`** | `example: "abc"`（單一） | `examples: ["abc", "def"]`（陣列） |
| 4 | **`exclusiveMinimum`** | `minimum: 0` + `exclusiveMinimum: true`（布林） | `exclusiveMinimum: 0`（數值） |
| 5 | **`webhooks`** | 不支援（只能用 `callbacks`） | ★ 頂層 `webhooks` |

**其他 3.1 的改進**：

```yaml
# ① $schema 可以指定（讓 schema 可以獨立驗證）
components:
  schemas:
    Order:
      $schema: "https://json-schema.org/draft/2020-12/schema"

# ② const（單一值）
apiVersion:
  const: "1.0"

# ③ $ref 旁邊可以有其他關鍵字（3.0 不行）
customer:
  $ref: '#/components/schemas/CustomerRef'
  description: 訂單所屬客戶      # ← 3.0 會被忽略，3.1 有效

# ④ 支援 if/then/else、dependentSchemas 等進階 JSON Schema
# ⑤ requestBody 可以出現在 GET（技術上；但不要用，第 01 章 1.9.2）
```

**⚠️ 工具支援的現實**：

| 工具 | 3.1 支援度（2026 年的狀況） |
|---|---|
| Swagger UI | ✅ 支援 |
| Redoc | ✅ 支援 |
| Scalar | ✅ 支援 |
| springdoc-openapi | ✅ 支援（`springdoc.api-docs.version=openapi_3_1`） |
| Prism（mock） | ✅ 支援 |
| Spectral（lint） | ✅ 支援 |
| oasdiff | ✅ 支援 |
| openapi-generator | ⚠️ **部分 generator 尚不完整** —— 這是選 3.1 最大的風險 |

**shop-service 的決定**：用 **3.1**，理由：
- `nullable` 的處理更乾淨（3.0 的 `nullable: true` 是 OpenAPI 特有的 hack）。
- `webhooks` 頂層支援（我們要描述發給廠商的 webhook）。
- 需要產生 SDK 時，先用 `oasdiff` 或轉換工具降到 3.0 給 generator 用。

> ⚠️ **如果你的主要用途是產生多語言 SDK，選 3.0.3 更安全。**
> 這是一個工具生態的現實取捨，不是技術優劣問題。

---

## 7.4 Design-first vs Code-first

### 7.4.1 兩種流程

**Design-first（契約先行）**

```
① 寫 orders-api.yaml
② Spectral lint + review（前端／廠商一起看）
③ 起 Prism mock server
④ 前端開始開發（用 mock）  ┐
⑤ 後端開始開發（照契約）  ┘ 並行
⑥ 整合：用契約驗證實際回應（第 09 章 9.4）
```

**Code-first（程式碼先行）**

```
① 寫 Controller + DTO + 註解
② springdoc 自動產生 /v3/api-docs
③ 匯出成 orders-api.yaml（進版控）
④ 前端看產生的文件開發
⑤ CI 檢查產生的契約是否有破壞性變更（第 06 章 6.9.1）
```

### 7.4.2 完整比較

| 面向 | Design-first | Code-first |
|---|---|---|
| 契約與實作的一致性 | ⚠️ 可能不一致（要靠測試驗證） | ★ 天然一致（就是從程式碼來的） |
| 前後端並行開發 | ★★★ 可以（有 mock） | ★ 難（要等後端寫完） |
| 討論契約的成本 | ★ 低（改 YAML 很快） | 高（要改程式碼才能看到效果） |
| 「先想清楚再寫」的紀律 | ★★★ 強制 | ⚠️ 容易變成「寫完才發現設計不好」 |
| 文件品質（description、examples） | ★★★ 好（因為是人寫的） | ⚠️ 常常很爛（見 7.6.4） |
| 維護成本 | ⚠️ 兩份要同步 | ★ 一份 |
| 學習曲線 | 要學 OpenAPI 語法 | 要學註解 |
| 適合 | 對外 API、多方協作、契約重要 | 內部 API、單一團隊、快速迭代 |

### 7.4.3 兩者的典型失敗模式

**Design-first 的失敗**：

```
① 花兩週寫了一份完美的 YAML
② 開始實作，發現「這個欄位資料庫拿不到」「這個效能做不到」
③ 改了實作但沒改 YAML
④ 三個月後 YAML 和實際差了 30%
⑤ 沒人相信 YAML → 回到 Code-first
```

**根因**：**沒有驗證機制**。Design-first 必須配合「用契約驗證實際回應」的測試（第 09 章 9.4）。

**Code-first 的失敗**：

```
① 加了 springdoc，產生出文件
② 但 description 全是空的、範例全是 "string"、錯誤回應完全沒描述
③ 前端說「這個文件看不懂」
④ 後端說「那你來寫註解」
⑤ 沒人寫 → 文件變成一份「欄位清單」而不是文件
```

**根因**：**產生出的東西不等於有用的文件**。要花力氣寫註解（7.6.4）。

### 7.4.4 shop-service 的混合流程 ★

```
新端點：Design-first
  ① 在 orders-api.yaml 手寫契約
  ② Spectral lint → PR review（前端 + 相關廠商參與）
  ③ Prism mock → 前端開始開發
  ④ 後端實作

既有端點的小改動：Code-first
  ① 改程式碼與註解
  ② springdoc 產生 → 和手寫的 yaml 做 diff
  ③ 差異必須解釋（要嘛改程式碼、要嘛改 yaml）

驗證（兩種流程都要）：
  ④ 測試用 orders-api.yaml 驗證實際回應（第 09 章 9.4）
  ⑤ CI 用 oasdiff 檢查破壞性變更（第 06 章 6.9.1）
```

**關鍵是第 ② 和第 ④ 步**：

| 步驟 | 解決什麼 |
|---|---|
| ② springdoc 產生 vs 手寫 yaml 做 diff | 抓到「程式碼改了但契約沒改」 |
| ④ 用契約驗證實際回應 | 抓到「契約改了但程式碼沒改」 |

**兩個方向都檢查，才能保證一致。**

**實作 ② 的做法**：

```bash
#!/usr/bin/env bash
# scripts/check-contract-drift.sh
set -euo pipefail

# 啟動應用程式，取出 springdoc 產生的契約
./mvnw -q spring-boot:run -Dspring-boot.run.profiles=contract-check &
APP_PID=$!
trap 'kill $APP_PID' EXIT

for i in {1..60}; do
  curl -sf localhost:8080/actuator/health >/dev/null && break || sleep 1
done

curl -sf localhost:8080/v3/api-docs.yaml > /tmp/generated.yaml

# 和手寫的契約比對（只比「結構」，忽略 description / examples）
docker run --rm -v "$PWD/api:/api" -v /tmp:/tmp tufin/oasdiff diff \
  /api/orders-api.yaml /tmp/generated.yaml \
  --exclude-elements description,examples,extensions \
  --format text > /tmp/drift.txt

if [ -s /tmp/drift.txt ]; then
  echo "🔴 契約與實作不一致："
  cat /tmp/drift.txt
  echo
  echo "請選擇："
  echo "  (a) 實作是對的 → 更新 api/orders-api.yaml"
  echo "  (b) 契約是對的 → 修改實作"
  exit 1
fi
echo "✅ 契約與實作一致"
```

**`--exclude-elements description,examples` 很重要**：
手寫的契約有豐富的 description 和 examples，springdoc 產生的沒有 ——
如果不排除，diff 永遠是紅的。

---

## 7.5 建構 orders-api.yaml ★ 本章核心產出

### 7.5.1 檔案結構

```
api/
├── orders-api.yaml              # 主檔（$ref 到下面的檔案）
├── paths/
│   ├── orders.yaml
│   ├── order-actions.yaml
│   ├── products.yaml
│   ├── carts.yaml
│   └── jobs.yaml
├── components/
│   ├── schemas/
│   │   ├── order.yaml
│   │   ├── product.yaml
│   │   ├── common.yaml          # PageResponse、Money、Address...
│   │   └── problem.yaml         # 錯誤（第 04 章）
│   ├── parameters.yaml          # 分頁／篩選／排序（第 05 章）
│   ├── responses.yaml           # 共用錯誤回應
│   └── security.yaml
├── examples/
│   ├── order-detail.json
│   └── problems/
│       ├── insufficient-stock.json
│       └── validation-failed.json
└── docs/
    ├── consumer-contract.md     # 第 06 章 6.4
    └── order-state-machine.md
```

**為什麼要拆檔案**：一個 83 條端點的契約，單一檔案會是 4000+ 行 —— 無法 review。

**⚠️ 拆檔案的代價**：
- 有些工具對外部 `$ref` 支援不完整（尤其是相對路徑）。
- 需要一個「打包」步驟產生單一檔案給那些工具用。

```bash
# 用 redocly CLI 打包成單一檔案
npx @redocly/cli bundle api/orders-api.yaml -o dist/orders-api.bundled.yaml
```

**shop-service 的規則**：
- **開發時**用拆檔案（好 review）。
- **CI 產出**打包後的單一檔案（給工具用，並發布給 consumer）。

### 7.5.2 `info` 與 Consumer Contract

```yaml
openapi: 3.1.0

info:
  title: shop-service API
  version: "1.0.0"
  summary: 電商訂單系統 API
  description: |
    # shop-service API

    電商訂單系統的 REST API。涵蓋商品、購物車、訂單、付款、出貨、退貨。

    ## 快速開始

    ```bash
    # 1. 取得 token
    curl -X POST https://api.shop.example/v1/auth/tokens \
      -H 'Content-Type: application/json' \
      -d '{"email":"you@example.com","password":"..."}'

    # 2. 查詢訂單
    curl https://api.shop.example/v1/orders \
      -H "Authorization: Bearer $TOKEN" \
      -H "X-Client-Id: my-app" \
      -H "X-Client-Version: 1.0.0"
    ```

    ## 必要的請求 header

    | Header | 必填 | 說明 |
    |---|---|---|
    | `Authorization` | ✅（除公開端點） | `Bearer <token>` |
    | `X-Client-Id` | ✅ | 你的應用識別（用於棄用通知，見 Consumer Contract §16） |
    | `X-Client-Version` | ✅ | 你的應用版本 |
    | `Idempotency-Key` | 部分端點 | 見各端點說明 |

    ## Consumer Contract（客戶端契約）

    **使用本 API 前請務必閱讀 [Consumer Contract](https://api.shop.example/docs/consumer-contract)。**

    ### 我們的保證
    1. 不移除已發布的回應欄位、不改變其型別／單位／語意
    2. 不收緊 request 驗證、不把選填欄位改必填
    3. `page` 永遠 0-based；集合預設排序不變
    4. 任何移除至少提前 180 天公告（附 `Deprecation` / `Sunset` header）

    ### 我們可能隨時做的事（不另行公告）
    1. **新增回應欄位** → 你必須忽略未知欄位
    2. **新增列舉值**（`status`、`code`、`paymentMethod`…）→ 你的 `switch` 必須有 `default`
    3. **新增錯誤 `code` 與狀態碼** → 未知 `code` 請 fallback 顯示 `userMessage`
    4. **修改 `title` / `detail` / `userMessage` 文案** → 請用 `code` 做程式判斷

    ### 測試你的合規性
    在 staging 環境使用注入參數驗證你的客戶端：
    ```bash
    # 注入未知的列舉值
    curl 'https://staging-api.shop.example/v1/orders?_inject=unknownEnum:status' ...
    # 注入未知欄位
    curl 'https://staging-api.shop.example/v1/orders?_inject=unknownField' ...
    ```

    ## 相關資源

    - [訂單狀態機](https://api.shop.example/docs/order-state-machine)
    - [錯誤碼目錄](https://api.shop.example/docs/error-codes)
    - [棄用清單（含你的用量）](https://api.shop.example/v1/deprecations)
    - [CHANGELOG](https://api.shop.example/changelog)（[RSS](https://api.shop.example/changelog.rss)）

  contact:
    name: shop-service API 團隊
    email: api@shop.example
    url: https://api.shop.example/support
  license:
    name: Proprietary
  termsOfService: https://shop.example/terms

servers:
  - url: https://api.shop.example/v1
    description: 正式環境
  - url: https://staging-api.shop.example/v1
    description: 測試環境（支援 ?_inject= 注入參數）
  - url: http://localhost:8080/v1
    description: 本機開發

externalDocs:
  description: 完整文件與教學
  url: https://api.shop.example/docs

tags:
  - name: Orders
    description: |
      訂單的建立、查詢、修改。
      訂單狀態機請見 [訂單狀態機文件](https://api.shop.example/docs/order-state-machine)。
  - name: Order Actions
    description: |
      訂單的動作型子資源：付款、取消、出貨、退貨、通知。

      這些操作**都會產生可查詢的紀錄**（而不是只改一個欄位），
      因此設計成 `POST` 到子資源集合，而非 `PATCH` 訂單本身。
  - name: Products
    description: 商品與庫存
  - name: Carts
    description: 購物車
  - name: Payments
    description: 付款與退款（跨訂單查詢）
  - name: Jobs
    description: |
      非同步工作：匯出、匯入、對帳。
      所有工作都遵循「`POST` 建立 → `202` + `Location` → 輪詢」的模式。
  - name: Deprecations
    description: 已棄用項目清單（含你的用量）
```

**這份 `info.description` 的設計要點**：

| 要點 | 為什麼 |
|---|---|
| 開頭就是「快速開始」的 `curl` | 新 consumer 的第一件事是「讓一個請求成功」 |
| 必要 header 用表格列出 | 這是最常漏的東西 |
| **Consumer Contract 的摘要嵌進來** | 沒人會去點連結；摘要放在這裡才會被讀到 |
| 「我們可能隨時做的事」用粗體 | 這是最需要被注意的部分（第 06 章 6.4.2） |
| 附上測試注入的 `curl` | 讓「合規」可執行（第 06 章 6.4.3） |
| `tags` 的 description 解釋**設計理由** | 「為什麼付款是子資源」比「付款相關端點」有用 |

### 7.5.3 `securitySchemes`

```yaml
components:
  securitySchemes:
    bearerAuth:
      type: http
      scheme: bearer
      bearerFormat: JWT
      description: |
        使用 `POST /auth/tokens` 取得的 access token。

        有效期 15 分鐘。過期時回 `401` + `code: TOKEN_EXPIRED`，
        請用 refresh token 呼叫 `POST /auth/tokens/refresh` 換新的
        （不要重新登入，也不要對 `401` 直接重試）。

    apiKeyAuth:
      type: apiKey
      in: header
      name: X-Api-Key
      description: |
        廠商系統對接用的長期金鑰。請聯絡 api@shop.example 申請。

        ⚠️ API key 具有完整的資料存取權限，請勿放在前端程式碼或版控中。

security:
  - bearerAuth: []          # 全域預設：需要 Bearer token
```

**個別端點覆寫**：

```yaml
paths:
  /products:
    get:
      security: []          # ★ 空陣列 = 不需要認證（公開端點）
      ...
  /orders:
    get:
      security:
        - bearerAuth: []
        - apiKeyAuth: []    # ★ 兩者皆可（OR 關係）
      ...
```

**⚠️ `security` 的 AND / OR 語意很容易搞錯**：

```yaml
# OR：任一個即可
security:
  - bearerAuth: []
  - apiKeyAuth: []

# AND：兩個都要
security:
  - bearerAuth: []
    apiKeyAuth: []
```

**注意縮排差異** —— 這是 OpenAPI 最容易寫錯的地方之一。

### 7.5.4 共用參數（第 05 章的規格）

```yaml
components:
  parameters:

    # ── 分頁（offset 模式）──────────────────────────
    Page:
      name: page
      in: query
      required: false
      description: |
        頁碼，**從 0 開始**（0 = 第一頁）。

        ⚠️ 此參數的基準永不變更（Consumer Contract §保證 3）。
        若你的系統採 1-based，請在呼叫端做 -1 轉換。

        與 `cursor` 互斥。
      schema:
        type: integer
        format: int32
        minimum: 0
        maximum: 500
        default: 0
      examples:
        firstPage: { value: 0, summary: 第一頁 }
        thirdPage: { value: 2, summary: 第三頁 }

    Size:
      name: size
      in: query
      required: false
      description: |
        每頁筆數。

        ⚠️ 超過上限會回 `400`（**不會**靜默夾取）。
        若需大量資料，請改用 `cursor` 分頁或 `POST /order-exports`。

        額外限制：`page × size` 不得超過 10000（深分頁上限）。
      schema:
        type: integer
        format: int32
        minimum: 1
        maximum: 100
        default: 20

    # ── 分頁（cursor 模式）──────────────────────────
    Cursor:
      name: cursor
      in: query
      required: false
      description: |
        **不透明的**分頁游標。請直接使用回應中 `page.nextCursor`
        或 `links.next` 的值，**不要解析或自行建構**。

        - 與 `page` 互斥（同時提供回 `400`）
        - 與 `q` 互斥（搜尋結果不支援 cursor 分頁）
        - 變更 `sort` 或任何篩選條件後**不可**沿用舊 cursor
          （會回 `400` + `code: CURSOR_QUERY_MISMATCH`）

        建議做法：跟著 `links.next` 走（Consumer Contract §要求 8）。
      schema:
        type: string
        maxLength: 512
        pattern: '^[A-Za-z0-9_-]+$'

    Limit:
      name: limit
      in: query
      required: false
      description: cursor 模式的每頁筆數（`size` 的別名）。
      schema: { type: integer, format: int32, minimum: 1, maximum: 100, default: 20 }

    # ── 排序 ────────────────────────────────────────
    OrderSort:
      name: sort
      in: query
      required: false
      description: |
        排序，格式 `<欄位>,<asc|desc>`。可重複最多 3 次（優先序由左至右）。

        系統會自動附加 `id` 作為 tie-breaker 以保證分頁穩定性。

        部分欄位需搭配篩選條件（否則回 `400` + `code: SORT_REQUIRES_FILTER`）：
        | 欄位 | 需搭配 |
        |---|---|
        | `totalAmount` | `status` 或 `createdFrom` |
        | `status` | 任一其他篩選條件 |
      explode: true
      style: form
      schema:
        type: array
        maxItems: 3
        items:
          type: string
          pattern: '^(createdAt|updatedAt|totalAmount|orderNumber|status)(,(asc|desc))?$'
        default: ["createdAt,desc"]
      examples:
        byCreatedDesc:
          value: ["createdAt,desc"]
          summary: 最新的在前（預設）
        byAmountThenDate:
          value: ["totalAmount,desc", "createdAt,desc"]
          summary: 金額高的在前，同金額則新的在前

    # ── 篩選 ────────────────────────────────────────
    OrderStatusFilter:
      name: status
      in: query
      required: false
      description: |
        依訂單狀態篩選。可重複（OR 關係）。

        ⚠️ 此列舉會持續新增值（Consumer Contract §我們可能做的事 2）。
      explode: true
      style: form
      schema:
        type: array
        maxItems: 10
        items: { $ref: '#/components/schemas/OrderStatus' }
      examples:
        singleStatus: { value: ["PAID"] }
        multipleStatuses:
          value: ["PAID", "PARTIALLY_SHIPPED", "SHIPPED"]
          summary: 已付款且尚未完成的訂單

    CreatedFrom:
      name: createdFrom
      in: query
      required: false
      description: |
        建立時間下界（**包含**）。

        接受兩種格式：
        - **純日期** `2026-08-01` → 解讀為 `Asia/Taipei` 該日 00:00:00
        - **時間點** `2026-08-01T00:00:00Z` → 精確時間點

        ⚠️ 使用時區偏移（如 `+08:00`）時，`+` 必須編碼為 `%2B`。
        **建議一律使用純日期或 UTC `Z` 格式**以避免此問題。

        與 `createdTo` 的區間上限為 366 天。
      schema:
        type: string
        pattern: '^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2}))?$'
      examples:
        dateOnly: { value: "2026-08-01", summary: 純日期（台北時間整天） }
        instant:  { value: "2026-08-01T00:00:00Z", summary: 精確時間點（UTC） }

    CreatedTo:
      name: createdTo
      in: query
      required: false
      description: |
        建立時間上界。

        - **純日期** `2026-08-31` → **包含該日整天**（等同 `< 2026-09-01T00:00:00+08:00`）
        - **時間點** `2026-08-31T23:59:59Z` → 包含該時間點

        ⚠️ 純日期與時間點的語意不同，請注意選擇。
        統計「8 月營收」請用 `createdFrom=2026-08-01&createdTo=2026-08-31`（純日期）。
      schema:
        type: string
        pattern: '^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2}))?$'

    Query:
      name: q
      in: query
      required: false
      description: |
        關鍵字搜尋。系統會**自動辨識輸入格式**並使用對應的索引：

        | 輸入格式 | 搜尋欄位 |
        |---|---|
        | `ORD-20260819-0001` | 訂單編號（精確） |
        | `ORD-20260819` / `20260819` | 訂單編號（前綴） |
        | `0912345678` | 收件人電話（精確） |
        | `2345678`（3～7 位數字） | 收件人電話（後綴） |
        | 含 `@` | 客戶 Email（前綴） |
        | 10～20 位英數 | 物流單號 |
        | 其他 | 收件人姓名（精確） |

        回應的 `searchMeta.detectedType` 會告知實際使用的搜尋方式。

        ⚠️ 與 `cursor` 互斥；深分頁上限為 1000。
      schema: { type: string, minLength: 1, maxLength: 100 }
      examples:
        orderNumber: { value: "ORD-20260819-0001" }
        phoneSuffix: { value: "2345678", summary: 電話後 7 碼 }
        name:        { value: "王小明" }

    Include:
      name: include
      in: query
      required: false
      description: |
        要求額外的（成本較高的）資料。

        | 值 | 說明 | 成本 |
        |---|---|---|
        | `totalCount` | 精確總筆數（否則只回 10000+ 的下限） | 高（可能超時，超時則回 `warnings`） |
        | `aggregates` | 金額與狀態統計 | 高 |

        ⚠️ 帶 `totalCount` 的請求有較嚴格的限流（每分鐘 30 次）。
      explode: false
      style: form
      schema:
        type: array
        maxItems: 2
        items: { type: string, enum: [totalCount, aggregates] }

    AsOf:
      name: asOf
      in: query
      required: false
      description: |
        凍結查詢基準時間。只回傳此時間點之前建立的資料。

        **用途**：在 offset 分頁遍歷多頁時，避免新資料插入導致重複／遺漏。
        建議做法：第一次請求不帶此參數，之後把回應中的 `asOf` 值帶回來。

        ⚠️ 此參數只解決「新增」造成的漂移，不解決「刪除／狀態變更」。
        若需完全穩定的遍歷，請改用 `cursor` 分頁。
      schema: { type: string, format: date-time }

    # ── 路徑參數 ────────────────────────────────────
    OrderId:
      name: orderId
      in: path
      required: true
      description: 訂單的系統識別碼（`ord_` + ULID）。
      schema:
        type: string
        pattern: '^ord_[0-9A-HJKMNP-TV-Z]{26}$'
      examples:
        default: { value: "ord_01J5GKQ8Z4W9V2X3Y6N7M8P0QR" }

    # ── Header 參數 ─────────────────────────────────
    IdempotencyKey:
      name: Idempotency-Key
      in: header
      required: true
      description: |
        客戶端產生的唯一鍵（建議 UUID v4），用於安全地重試。

        - 相同 key + 相同請求內容 → 回傳**首次**的結果（不重複執行）
        - 相同 key + **不同**請求內容 → `409` + `code: IDEMPOTENCY_KEY_REUSED`
        - 有效期 **24 小時**

        ⚠️ 修改請求內容後請產生**新的** key。
        詳見 [冪等性文件](https://api.shop.example/docs/idempotency)。
      schema: { type: string, minLength: 16, maxLength: 128 }
      examples:
        default: { value: "8f14e45f-ea36-4a1b-9c2e-77e8f1a3b0c1" }

    IfMatch:
      name: If-Match
      in: header
      required: true
      description: |
        前次 `GET` 取得的 `ETag` 值，用於樂觀鎖。

        - 相符 → 執行更新，回傳新的 `ETag`
        - 不符 → `412` + `code: OPTIMISTIC_LOCK_CONFLICT`（含 `modifiedBy` / `currentVersion`）
        - 未提供 → `428` + `code: IF_MATCH_REQUIRED`

        此資源可能被多人同時編輯，因此本參數為**必填**。
      schema: { type: string }
      examples:
        default: { value: '"v7"' }

    ClientId:
      name: X-Client-Id
      in: header
      required: true
      description: |
        你的應用識別碼（例如 `shop-web`、`shop-ios`、`vendor-a-erp`）。

        ⚠️ **未提供此 header 的 consumer 無法收到針對性的棄用通知**
        （Consumer Contract §要求 16）。
      schema: { type: string, maxLength: 64, pattern: '^[a-z0-9][a-z0-9-]*$' }

    ClientVersion:
      name: X-Client-Version
      in: header
      required: true
      description: 你的應用版本（例如 `3.2.1`）。用於相容性處理與棄用影響評估。
      schema: { type: string, maxLength: 32 }
```

**這一節示範了 OpenAPI 最重要的實踐：`description` 要寫「為什麼」與「怎麼用」，不是重複參數名。**

對照一下：

```yaml
# ❌ 沒有價值的 description（springdoc 自動產生常常長這樣）
Page:
  name: page
  description: page
  schema: { type: integer }

# ✅ 有價值的 description
Page:
  name: page
  description: |
    頁碼，**從 0 開始**（0 = 第一頁）。
    ⚠️ 此參數的基準永不變更。若你的系統採 1-based，請在呼叫端做 -1 轉換。
    與 `cursor` 互斥。
  schema: { type: integer, minimum: 0, maximum: 500, default: 0 }
```

**第二個版本回答了 consumer 真正會問的三個問題**：從 0 還是 1？會不會改？和其他參數的關係？

### 7.5.5 共用回應（錯誤，第 04 章）

```yaml
components:
  responses:

    BadRequest:
      description: |
        請求格式錯誤（語法層面）。**這通常代表呼叫端的程式錯誤**，
        正常使用者不應遇到 —— 建議上報到你的錯誤追蹤系統。
      content:
        application/problem+json:
          schema: { $ref: '#/components/schemas/Problem' }
          examples:
            malformedJson:
              summary: JSON 格式錯誤
              value:
                type: https://api.shop.example/problems/malformed-request
                title: 請求格式錯誤
                status: 400
                detail: "JSON parse error: Unexpected end-of-input"
                code: MALFORMED_REQUEST
                userMessage: 系統錯誤，請稍後再試。
                retryable: false
                traceId: 4f2c8a1e9b7d3f60
            deepPagination:
              summary: 深分頁超過上限
              value:
                type: https://api.shop.example/problems/deep-pagination-not-supported
                title: 不支援深分頁
                status: 400
                detail: "page × size must not exceed 10000. Requested offset is 100000."
                code: DEEP_PAGINATION_NOT_SUPPORTED
                userMessage: 無法瀏覽這麼深的頁數，請縮小篩選條件。
                maxOffset: 10000
                requestedOffset: 100000
                hint: 若需完整資料請改用 cursor 分頁或 POST /order-exports 匯出。
                retryable: false
                traceId: 4f2c8a1e9b7d3f60
            unknownParameter:
              summary: 未知的查詢參數
              value:
                type: https://api.shop.example/problems/unknown-query-parameter
                title: 未知的查詢參數
                status: 400
                detail: "Unknown query parameter(s): stauts. Did you mean 'status'?"
                code: UNKNOWN_QUERY_PARAMETER
                userMessage: 查詢參數有誤，請聯絡技術支援。
                errors:
                  - field: stauts
                    code: UNKNOWN_PARAMETER
                    message: 未知的參數，是否要用 status？
                    constraint: { suggestion: status }
                retryable: false
                traceId: 4f2c8a1e9b7d3f60

    Unauthorized:
      description: |
        未認證或憑證無效。

        **處理建議**：
        - `TOKEN_EXPIRED` → 用 refresh token 換新 token 後**重試原請求**
        - `INVALID_TOKEN` / `TOKEN_REVOKED` → 導向登入
        - ⚠️ **不要**對 `401` 直接重試同一個 token（會無限迴圈）
      headers:
        WWW-Authenticate:
          description: 認證方式與錯誤原因（RFC 6750）
          schema: { type: string }
          example: 'Bearer realm="shop-api", error="invalid_token"'
      content:
        application/problem+json:
          schema: { $ref: '#/components/schemas/Problem' }
          examples:
            tokenExpired:
              value:
                type: https://api.shop.example/problems/token-expired
                title: 憑證已過期
                status: 401
                code: TOKEN_EXPIRED
                userMessage: 登入已逾時，請重新登入。
                expiredAt: "2026-08-19T06:00:00Z"
                retryable: true
                retryStrategy: REFRESH_TOKEN_THEN_RETRY
                traceId: 4f2c8a1e9b7d3f60

    Forbidden:
      description: |
        已認證但權限不足。**重試不會成功**，需要不同的權限或帳號。
      content:
        application/problem+json:
          schema: { $ref: '#/components/schemas/Problem' }
          examples:
            insufficientRole:
              value:
                type: https://api.shop.example/problems/insufficient-role
                title: 權限不足
                status: 403
                code: INSUFFICIENT_ROLE
                userMessage: 您沒有權限執行此操作。
                requiredRole: SUPPORT
                retryable: false
                traceId: 4f2c8a1e9b7d3f60

    NotFound:
      description: |
        資源不存在。

        ⚠️ 為避免洩漏資源存在性，**存取他人的資源也會回 `404`**（而非 `403`）。
      content:
        application/problem+json:
          schema: { $ref: '#/components/schemas/Problem' }
          examples:
            orderNotFound:
              value:
                type: https://api.shop.example/problems/resource-not-found
                title: 資源不存在
                status: 404
                code: RESOURCE_NOT_FOUND
                userMessage: 找不到此訂單。
                resourceType: order
                resourceId: ord_01J5GKQ8Z4W9V2X3Y6N7M8P0QR
                retryable: false
                traceId: 4f2c8a1e9b7d3f60

    UnprocessableContent:
      description: |
        語法正確但內容驗證失敗。**這是正常的使用者輸入錯誤**，
        請將 `errors[]` 標示到對應的表單欄位上。

        `errors[].field` 使用 JSON path 格式（含陣列索引），可直接對應表單欄位。
      content:
        application/problem+json:
          schema: { $ref: '#/components/schemas/Problem' }
          examples:
            validationFailed:
              summary: 多個欄位驗證失敗
              externalValue: https://api.shop.example/examples/problems/validation-failed.json

    Conflict:
      description: |
        與資源當前狀態衝突。

        **`409` 與 `422` 的差別**：
        - `409` → 資源狀態問題。重新讀取資源後**可能**可以成功
        - `422` → 請求內容問題。不改內容則永遠失敗

        本回應通常包含幫助恢復的欄位（如 `available`、`currentStatus`、`alternativeAction`）。
      content:
        application/problem+json:
          schema: { $ref: '#/components/schemas/Problem' }
          examples:
            insufficientStock:
              summary: 庫存不足
              externalValue: https://api.shop.example/examples/problems/insufficient-stock.json
            orderNotCancellable:
              summary: 訂單已出貨，無法取消
              value:
                type: https://api.shop.example/problems/order-not-cancellable
                title: 訂單無法取消
                status: 409
                detail: "Order ORD-20260819-0001 is in SHIPPED state; cancellable states are PENDING_PAYMENT, PAID."
                code: ORDER_NOT_CANCELLABLE
                userMessage: 此訂單已出貨，無法取消。您可以在收到商品後 7 天內申請退貨。
                orderNumber: ORD-20260819-0001
                currentStatus: SHIPPED
                currentStatusLabel: 已出貨
                cancellableStatuses: [PENDING_PAYMENT, PAID]
                alternativeAction:
                  code: REQUEST_RETURN
                  label: 申請退貨
                  href: /v1/orders/ord_01J5GKQ8Z4W9V2X3Y6N7M8P0QR/returns
                  method: POST
                  availableUntil: "2026-08-28"
                retryable: false
                traceId: 4f2c8a1e9b7d3f60

    PreconditionFailed:
      description: |
        `If-Match` 與資源當前版本不符 —— 資料已被其他人修改。

        **處理建議**：重新 `GET` 取得最新資料與 `ETag`，
        向使用者顯示衝突（回應含 `modifiedBy` / `modifiedAt`），讓其決定如何合併。
      headers:
        ETag:
          description: 資源**當前**的版本（用此值重試）
          schema: { type: string }
          example: '"v8"'
      content:
        application/problem+json:
          schema: { $ref: '#/components/schemas/Problem' }

    PreconditionRequired:
      description: |
        此操作必須提供 `If-Match` header。

        請先 `GET` 該資源取得 `ETag`，再帶著它送出寫入請求。
      content:
        application/problem+json:
          schema: { $ref: '#/components/schemas/Problem' }

    TooManyRequests:
      description: 超過速率限制。請依 `Retry-After` 等待後重試（含抖動）。
      headers:
        Retry-After:
          description: 建議等待的秒數
          schema: { type: integer }
          example: 42
        RateLimit-Limit:
          schema: { type: integer }
          example: 100
        RateLimit-Remaining:
          schema: { type: integer }
          example: 0
        RateLimit-Reset:
          description: 距離配額重置的秒數
          schema: { type: integer }
          example: 42
      content:
        application/problem+json:
          schema: { $ref: '#/components/schemas/Problem' }

    InternalServerError:
      description: |
        伺服器內部錯誤。**這是我們的問題**，已自動記錄並告警。

        請將 `traceId` 提供給客服以協助排查。回應**不包含**內部細節。
      content:
        application/problem+json:
          schema: { $ref: '#/components/schemas/Problem' }

    ServiceUnavailable:
      description: |
        服務暫時無法使用（維護、過載、下游異常、查詢超時）。

        **可重試** —— 請依 `Retry-After` 等待並使用指數退避 + 抖動。
      headers:
        Retry-After:
          schema: { type: integer }
          example: 30
      content:
        application/problem+json:
          schema: { $ref: '#/components/schemas/Problem' }
```

**這一節的三個實踐要點**：

| 要點 | 說明 |
|---|---|
| **`description` 寫「處理建議」** | 「`401` 要刷新 token 而不是重試」這種資訊比「未認證」有用一百倍 |
| **每個回應至少一個 `examples`** | 開發者第一件事是看範例，不是讀 schema |
| **`externalValue` 引用外部檔案** | 長範例（驗證錯誤有 6 個 error）放外部檔案，YAML 才不會爆 |

⚠️ **`externalValue` 的工具支援不完整**（部分 UI 不會抓取外部 URL）。
若需要最大兼容性，用內嵌 `value`；若範例很長且工具支援，用 `externalValue`。

### 7.5.6 Schemas：共用型別

```yaml
components:
  schemas:

    # ── 值物件 ──────────────────────────────────────
    Money:
      type: string
      pattern: '^-?\d{1,13}(\.\d{1,2})?$'
      description: |
        金額，以**十進位字串**表示（避免浮點精度問題）。

        - 一律保留該幣別的小數位數（TWD/USD 為 2 位，JPY 為 0 位）
        - 負數表示折扣或退款
        - ⚠️ 請使用 decimal 函式庫運算，**不要用浮點數**
          （Consumer Contract §要求 14）
      examples: ["1280.50", "-300.00", "0.00"]

    Currency:
      type: string
      pattern: '^[A-Z]{3}$'
      description: ISO 4217 幣別代碼。
      examples: ["TWD", "USD", "JPY"]

    Amounts:
      type: object
      required: [subtotal, discount, shippingFee, tax, total]
      properties:
        subtotal:    { $ref: '#/components/schemas/Money', description: 商品小計（未折扣） }
        discount:    { $ref: '#/components/schemas/Money', description: 折扣金額（負數） }
        shippingFee: { $ref: '#/components/schemas/Money', description: 運費 }
        tax:         { $ref: '#/components/schemas/Money', description: 稅額 }
        total:       { $ref: '#/components/schemas/Money', description: 應付總額 }
      description: |
        金額明細。`total = subtotal + discount + shippingFee + tax`
        （`discount` 為負數，故為加法）。

        ⚠️ 請直接使用 `total`，**不要在客戶端重算**
        （促銷規則可能包含未在此揭露的計算）。

    # ── 列舉 ────────────────────────────────────────
    OrderStatus:
      type: string
      enum:
        - PENDING_PAYMENT
        - PAID
        - PARTIALLY_SHIPPED
        - SHIPPED
        - COMPLETED
        - CANCELLED
        - RETURNED
      x-extensible-enum: true
      description: |
        訂單狀態。

        ⚠️ **此列舉會持續新增值**（Consumer Contract §我們可能做的事 2）。
        客戶端必須：
        - **顯示**：使用 `statusLabel`（後端已翻譯），不要自行維護對照表
        - **分組**：使用 `statusCategory`（粗粒度，很少變動）
        - **邏輯**：使用 `allowedActions`，不要用 `status` 判斷可執行的操作
        - **兜底**：`switch` 必須有 `default`

        狀態機請見 [訂單狀態機文件](https://api.shop.example/docs/order-state-machine)。

    OrderStatusCategory:
      type: string
      enum: [IN_PROGRESS, DONE, CANCELLED]
      description: |
        訂單狀態的粗粒度分類。用於 UI 分頁籤（進行中／已完成／已取消）。

        對映關係：
        | category | 包含的 status |
        |---|---|
        | `IN_PROGRESS` | `PENDING_PAYMENT`, `PAID`, `PARTIALLY_SHIPPED`, `SHIPPED` |
        | `DONE` | `COMPLETED` |
        | `CANCELLED` | `CANCELLED`, `RETURNED` |

        此列舉**極少新增值**，可安全用於 `switch`。

    OrderAction:
      type: string
      enum: [PAY, CANCEL, EDIT_INVOICE, EDIT_ADDRESS, REQUEST_RETURN, REQUEST_INVOICE, VIEW_SHIPMENT, CONTACT_SUPPORT]
      x-extensible-enum: true
      description: |
        可對訂單執行的操作。用於決定 UI 按鈕的顯示與啟用狀態。

        **業務規則（哪些狀態能做哪些操作）由後端計算**，
        客戶端只需檢查此陣列是否包含對應的值。

    # ── 分頁 ────────────────────────────────────────
    OffsetPageInfo:
      type: object
      required: [mode, number, size, hasMore]
      properties:
        mode:
          const: OFFSET
          description: 分頁模式的判別欄位。
        number: { type: integer, description: 當前頁碼（0-based） }
        size:   { type: integer, description: 每頁筆數 }
        hasMore: { type: boolean, description: 是否還有下一頁 }
        totalElements:
          type: [integer, "null"]
          format: int64
          description: |
            符合條件的總筆數。

            ⚠️ 預設為**上限計數**（最多數到 10000）。請務必檢查
            `totalElementsRelation`：若為 `GREATER_THAN_OR_EQUAL`，
            實際筆數可能遠大於此值。

            需要精確值請帶 `?include=totalCount`（成本較高，限流較嚴）。
        totalElementsRelation:
          type: string
          enum: [EQUAL, GREATER_THAN_OR_EQUAL]
          description: |
            `totalElements` 的精確性。
            - `EQUAL` → 精確值
            - `GREATER_THAN_OR_EQUAL` → 下限（UI 建議顯示為「10000+ 筆」）
        totalPages: { type: [integer, "null"] }
        totalPagesRelation:
          type: string
          enum: [EQUAL, GREATER_THAN_OR_EQUAL]
        maxAccessibleElements:
          type: integer
          description: |
            透過分頁**最多可存取**的筆數（深分頁上限）。
            超過此範圍請改用 cursor 分頁或匯出。

    CursorPageInfo:
      type: object
      required: [mode, limit, hasMore]
      properties:
        mode:
          const: CURSOR
        limit: { type: integer }
        hasMore: { type: boolean }
        nextCursor:
          type: [string, "null"]
          description: |
            下一頁的游標。`null` 表示已到最後一頁。

            ⚠️ **不透明字串**，請勿解析或建構。
            建議直接使用 `links.next`（Consumer Contract §要求 8）。
        prevCursor:
          type: [string, "null"]

    NoPageInfo:
      type: object
      required: [mode]
      properties:
        mode:
          const: NONE
          description: 此集合不分頁（業務上有硬性數量上限）。
        totalElements: { type: integer }

    PageInfo:
      oneOf:
        - $ref: '#/components/schemas/OffsetPageInfo'
        - $ref: '#/components/schemas/CursorPageInfo'
        - $ref: '#/components/schemas/NoPageInfo'
      discriminator:
        propertyName: mode
        mapping:
          OFFSET: '#/components/schemas/OffsetPageInfo'
          CURSOR: '#/components/schemas/CursorPageInfo'
          NONE:   '#/components/schemas/NoPageInfo'
      description: |
        分頁資訊。請先檢查 `mode` 欄位再存取其他屬性。

    PageLinks:
      type: object
      properties:
        self:  { type: string, format: uri-reference }
        next:  { type: [string, "null"], format: uri-reference }
        prev:  { type: [string, "null"], format: uri-reference }
        first: { type: [string, "null"], format: uri-reference }
        last:  { type: [string, "null"], format: uri-reference }
      description: |
        分頁導航連結（保留原請求的所有篩選與排序參數）。

        **建議做法**：遍歷資料時跟著 `next` 走，直到它為 `null`。
        這樣我們調整分頁機制時你不需要改程式碼。

        ```javascript
        let url = '/v1/orders?limit=100';
        const all = [];
        while (url) {
          const res = await get(url);
          all.push(...res.items);
          url = res.links.next;
        }
        ```

    Warning:
      type: object
      required: [code, message]
      properties:
        code:
          type: string
          enum: [TOTAL_COUNT_CAPPED, TOTAL_COUNT_UNAVAILABLE, RESULT_TRUNCATED,
                 FILTER_PARTIALLY_APPLIED, FIELD_WILL_BECOME_REQUIRED]
          x-extensible-enum: true
        message: { type: string }
        field: { type: string }
      description: |
        非致命的警示。請求**已成功**，但有需要注意的事項。

        ⚠️ 客戶端應記錄 `warnings`（至少寫進 log），
        它們通常預告了未來的破壞性變更或資料不完整。
```

**這一節示範了三個 OpenAPI 3.1 的特性**：

| 特性 | 用在哪 | 3.0 的寫法 |
|---|---|---|
| `type: [integer, "null"]` | `totalElements` | `type: integer, nullable: true` |
| `const: OFFSET` | discriminator 欄位 | `enum: [OFFSET]` |
| `$ref` 旁邊加 `description` | `Amounts.subtotal` | 3.0 會忽略 description |

### 7.5.7 `oneOf` + `discriminator`：多形回應

**`PageInfo` 的 `oneOf` 讓同一個端點可以回三種分頁模式。**

**客戶端的 TypeScript 型別（由 openapi-typescript 產生）**：

```typescript
type PageInfo =
  | { mode: 'OFFSET'; number: number; size: number; hasMore: boolean;
      totalElements: number | null; totalElementsRelation: 'EQUAL' | 'GREATER_THAN_OR_EQUAL'; ... }
  | { mode: 'CURSOR'; limit: number; hasMore: boolean; nextCursor: string | null; ... }
  | { mode: 'NONE'; totalElements: number };

// ★ TS 的 discriminated union → 型別安全的分支
function renderPagination(page: PageInfo) {
  switch (page.mode) {
    case 'OFFSET': return <PageNumbers current={page.number} total={page.totalPages} />;
    case 'CURSOR': return <LoadMoreButton disabled={!page.hasMore} />;
    case 'NONE':   return null;
  }
}
```

**`discriminator` 的價值**：沒有它，產生的型別是「三種的聯集，所有欄位都選填」——
客戶端要處處 `if (page.number !== undefined)`。

**⚠️ `discriminator` 的三個限制**：

| 限制 | 說明 |
|---|---|
| 判別欄位必須是**必填**的 | `mode` 在三個 schema 裡都要在 `required` |
| 判別欄位必須是 string | 不能用 boolean 或 number |
| 部分工具不支援 `mapping` | 只支援「schema 名稱 = 判別值」的隱含對映 |

### 7.5.8 端點定義：`GET /orders`

```yaml
paths:
  /orders:
    get:
      operationId: listOrders
      summary: 查詢訂單列表
      description: |
        查詢訂單列表，支援篩選、排序、搜尋與兩種分頁模式。

        ## 權限與範圍

        | 角色 | 預設範圍 | 可用的額外參數 |
        |---|---|---|
        | `CUSTOMER` | **僅自己的訂單** | — |
        | `SUPPORT` | 所負責區域的全部訂單 | `customerId`、`assigneeId`、`hasAssignee` |
        | `SUPPORT_MANAGER` | 全部訂單 | 同上 + `allRegions` |

        ⚠️ `CUSTOMER` 帶 `customerId` 參數會回 `403`（**不會**靜默忽略）。

        ## 分頁模式

        | 模式 | 參數 | 適合 |
        |---|---|---|
        | offset | `page` + `size` | 需要跳頁、顯示總頁數的表格 UI |
        | cursor | `cursor` + `limit` | App 無限滾動、批次同步（**大量資料請用此模式**） |

        `page` 與 `cursor` 互斥。offset 模式的深分頁上限為 `page × size <= 10000`。

        ## 效能建議

        - 遍歷大量資料 → **cursor 模式**（`sort=updatedAt,asc`）
        - 下載完整資料 → `POST /order-exports`（非同步匯出）
        - 只需最近幾頁 → offset 模式即可

      tags: [Orders]
      parameters:
        - $ref: '#/components/parameters/ClientId'
        - $ref: '#/components/parameters/ClientVersion'
        - $ref: '#/components/parameters/OrderStatusFilter'
        - name: statusCategory
          in: query
          description: 依粗粒度狀態分類篩選（用於 UI 分頁籤）。
          explode: true
          style: form
          schema:
            type: array
            items: { $ref: '#/components/schemas/OrderStatusCategory' }
        - name: customerId
          in: query
          description: |
            依客戶篩選。⚠️ **需要 `SUPPORT` 權限**，否則回 `403` +
            `code: FORBIDDEN_PARAMETER`。
          explode: true
          style: form
          schema:
            type: array
            maxItems: 50
            items: { type: string, pattern: '^cus_[0-9A-HJKMNP-TV-Z]{26}$' }
        - name: orderNumber
          in: query
          description: 依訂單編號精確查詢（走唯一索引，最快）。
          schema: { type: string, pattern: '^ORD-\d{8}-\d{4}$' }
        - $ref: '#/components/parameters/CreatedFrom'
        - $ref: '#/components/parameters/CreatedTo'
        - name: updatedFrom
          in: query
          description: |
            更新時間下界（含）。**增量同步請使用此參數搭配 cursor 模式**：
            `?updatedFrom=<上次的 safeWatermark>&sort=updatedAt,asc&limit=500`

            ⚠️ 本端點的同步語意為 **at-least-once**（訂單被更新時會重複出現），
            消費端必須以 `orderId` 做 upsert。
          schema: { type: string, format: date-time }
        - name: amountFrom
          in: query
          schema: { $ref: '#/components/schemas/Money' }
        - name: amountTo
          in: query
          schema: { $ref: '#/components/schemas/Money' }
        - name: hasCoupon
          in: query
          description: |
            是否使用了折扣碼。
            **不提供此參數 = 不篩選**（三態）。
          schema: { type: boolean }
        - name: hasShipment
          in: query
          schema: { type: boolean }
        - $ref: '#/components/parameters/Query'
        - $ref: '#/components/parameters/OrderSort'
        - $ref: '#/components/parameters/Page'
        - $ref: '#/components/parameters/Size'
        - $ref: '#/components/parameters/Cursor'
        - $ref: '#/components/parameters/Limit'
        - $ref: '#/components/parameters/Include'
        - $ref: '#/components/parameters/AsOf'

      responses:
        '200':
          description: |
            查詢成功。**空結果也回 `200` + `items: []`**（不是 `404`）。
          headers:
            Link:
              description: 分頁導航（RFC 8288）。跨來源請求需已設定 `Access-Control-Expose-Headers`。
              schema: { type: string }
            X-Total-Count:
              description: 總筆數（可能是上限計數的下限值）
              schema: { type: integer }
            Cache-Control:
              description: 訂單列表為私有資料，一律 `private, no-store`
              schema: { type: string }
              example: private, no-store
          content:
            application/json:
              schema: { $ref: '#/components/schemas/OrderListResponse' }
              examples:
                offsetMode:
                  summary: offset 模式（管理後台）
                  externalValue: https://api.shop.example/examples/order-list-offset.json
                cursorMode:
                  summary: cursor 模式（App / 批次同步）
                  externalValue: https://api.shop.example/examples/order-list-cursor.json
                empty:
                  summary: 無符合資料
                  value:
                    items: []
                    page: { mode: OFFSET, number: 0, size: 20, hasMore: false,
                            totalElements: 0, totalElementsRelation: EQUAL, totalPages: 0 }
                    links: { self: "/v1/orders?page=0&size=20" }
        '400': { $ref: '#/components/responses/BadRequest' }
        '401': { $ref: '#/components/responses/Unauthorized' }
        '403': { $ref: '#/components/responses/Forbidden' }
        '422': { $ref: '#/components/responses/UnprocessableContent' }
        '429': { $ref: '#/components/responses/TooManyRequests' }
        '500': { $ref: '#/components/responses/InternalServerError' }
        '503': { $ref: '#/components/responses/ServiceUnavailable' }

    post:
      operationId: createOrder
      summary: 建立訂單
      description: |
        從購物車或指定的商品清單建立訂單。

        ## 冪等性

        **必須**提供 `Idempotency-Key` header。
        重試（相同 key + 相同內容）會回傳**首次**的結果，狀態碼為 `200`（而非 `201`），
        並附上 `Idempotent-Replay: true` header。

        ## 由伺服器決定的欄位

        以下欄位**不接受客戶端指定**（送了會被忽略）：
        `orderId`、`orderNumber`、`status`、`unitPrice`、`amounts`、`createdAt`。

        商品價格一律由伺服器查詢當前價格，並在訂單成立時**快照**
        （後續商品調價不影響已成立的訂單）。

        ## 訂單有效期

        建立後的訂單狀態為 `PENDING_PAYMENT`，
        **30 分鐘內未付款會自動取消**（回應中的 `expiresAt` 為實際期限）。
      tags: [Orders]
      parameters:
        - $ref: '#/components/parameters/ClientId'
        - $ref: '#/components/parameters/ClientVersion'
        - $ref: '#/components/parameters/IdempotencyKey'
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/CreateOrderRequest' }
            examples:
              singleShipment:
                summary: 單一收件地址
                value:
                  items:
                    - { productId: "P-1001", quantity: 2 }
                    - { productId: "P-2003", quantity: 1 }
                  shippingAddressId: "addr_01J5GKQ8Z4W9V2X3Y6N7M8P0QR"
                  couponCode: "SUMMER20"
                  customerNote: "麻煩包裝仔細一點"
                  invoice: { type: PERSONAL, carrierId: "/ABC+123" }
              companyInvoice:
                summary: 公司發票
                value:
                  items: [{ productId: "P-1001", quantity: 10 }]
                  shippingAddressId: "addr_01J5GKQ8Z4W9V2X3Y6N7M8P0QR"
                  invoice: { type: COMPANY, taxId: "12345678", companyName: "某某股份有限公司" }
      responses:
        '201':
          description: 訂單建立成功
          headers:
            Location:
              description: 新建立訂單的 URI
              schema: { type: string, format: uri-reference }
              example: /v1/orders/ord_01J5GKQ8Z4W9V2X3Y6N7M8P0QR
            ETag:
              schema: { type: string }
              example: '"v1"'
          content:
            application/json:
              schema: { $ref: '#/components/schemas/OrderDetail' }
              examples:
                created:
                  externalValue: https://api.shop.example/examples/order-detail.json
        '200':
          description: |
            **冪等重播** —— 此 `Idempotency-Key` 已處理過，回傳首次的結果。
            注意狀態碼是 `200` 而非 `201`。
          headers:
            Idempotent-Replay:
              schema: { type: boolean }
              example: true
            Location:
              schema: { type: string, format: uri-reference }
          content:
            application/json:
              schema: { $ref: '#/components/schemas/OrderDetail' }
        '400':
          $ref: '#/components/responses/BadRequest'
        '401': { $ref: '#/components/responses/Unauthorized' }
        '409':
          description: |
            衝突。可能原因：
            - `INSUFFICIENT_STOCK` — 庫存不足（回應含 `available`，可據此調整數量）
            - `COUPON_EXHAUSTED` — 折扣碼已用完
            - `IDEMPOTENCY_KEY_REUSED` — 相同 key 但請求內容不同（請產生新 key）
          content:
            application/problem+json:
              schema: { $ref: '#/components/schemas/Problem' }
              examples:
                insufficientStock:
                  externalValue: https://api.shop.example/examples/problems/insufficient-stock.json
                idempotencyKeyReused:
                  value:
                    type: https://api.shop.example/problems/idempotency-key-reused
                    title: 冪等鍵已用於不同的請求
                    status: 409
                    code: IDEMPOTENCY_KEY_REUSED
                    userMessage: 請求內容已變更，請重新送出。
                    hint: 修改請求內容後請產生新的 Idempotency-Key。
                    retryable: false
                    traceId: 4f2c8a1e9b7d3f60
        '422': { $ref: '#/components/responses/UnprocessableContent' }
        '429': { $ref: '#/components/responses/TooManyRequests' }
        '500': { $ref: '#/components/responses/InternalServerError' }
        '503': { $ref: '#/components/responses/ServiceUnavailable' }
```

**這一段展示了六個關鍵實踐**：

| 實踐 | 說明 |
|---|---|
| `operationId` 一定要有 | 產生 SDK 時它是方法名。沒有的話 generator 會產生 `ordersGet_1` 這種東西 |
| `description` 寫**權限矩陣** | 「誰能看到什麼」是 consumer 最常問的問題 |
| `description` 寫**效能建議** | 引導 consumer 用對的工具（第 05 章 5.3.5 防線 3） |
| **`200` 和 `201` 都列出** | 冪等重播回 `200` —— 不寫出來 consumer 會以為是 bug |
| **每個錯誤都列出可能的 `code`** | 讓 consumer 知道要處理哪些情況 |
| `headers` 明確列出 | `Location`、`ETag`、`Link`、`Idempotent-Replay` 都是契約的一部分 |

### 7.5.9 `webhooks`（OpenAPI 3.1）

```yaml
webhooks:
  orderStatusChanged:
    post:
      operationId: onOrderStatusChanged
      summary: 訂單狀態變更通知
      description: |
        訂單狀態變更時，我們會 `POST` 到你註冊的 webhook URL。

        ## 你必須做的事

        1. **驗證簽章**（見 `X-Shop-Signature`）—— 未驗證等於接受任意來源的偽造通知
        2. **立即回 `2xx`**（建議 `204`），把處理丟進佇列
           ⚠️ **不要**在 webhook 處理中做耗時操作（我們的超時是 5 秒）
        3. **以 `eventId` 去重** —— 我們保證 at-least-once，同一事件可能重送
        4. **忽略未知的 `eventType` 與未知欄位** —— 我們會新增事件類型

        ## 重試策略

        非 `2xx` 回應（或超時）會重試：
        1 分鐘 → 5 分鐘 → 30 分鐘 → 2 小時 → 6 小時 → 24 小時（共 6 次）。
        全部失敗後標記為 `FAILED`，可在管理後台手動重送。

        ⚠️ **業務層面的錯誤也請回 `2xx`**（例如「找不到對應的訂單」）。
        回 `4xx` 我們會持續重試 24 小時。
      parameters:
        - name: X-Shop-Signature
          in: header
          required: true
          description: |
            HMAC-SHA256 簽章，格式 `t=<timestamp>,v1=<hex>`。

            驗證方式：
            ```
            signedPayload = timestamp + "." + rawRequestBody
            expected = HMAC_SHA256(webhookSecret, signedPayload)
            ```
            並檢查 `timestamp` 與當前時間差 < 5 分鐘（防重放攻擊）。

            ⚠️ 請使用**常數時間比較**（如 `MessageDigest.isEqual`），
            不要用 `String.equals`（會有時序攻擊風險）。
          schema: { type: string }
          example: "t=1755561600,v1=a3f5c9e1..."
        - name: X-Shop-Event-Id
          in: header
          required: true
          description: 事件 ID（用於去重）。與 body 的 `eventId` 相同。
          schema: { type: string }
        - name: X-Shop-Delivery-Attempt
          in: header
          required: true
          description: 第幾次投遞（1 = 首次）。
          schema: { type: integer, minimum: 1 }
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/WebhookEvent' }
            examples:
              orderPaid:
                value:
                  eventId: "evt_01J5GKQ8Z4W9V2X3Y6N7M8P0QR"
                  eventType: "order.status_changed"
                  apiVersion: "1.0"
                  occurredAt: "2026-08-19T06:14:58Z"
                  data:
                    orderId: "ord_01J5GKQ8Z4W9V2X3Y6N7M8P0QR"
                    orderNumber: "ORD-20260819-0001"
                    previousStatus: "PENDING_PAYMENT"
                    status: "PAID"
                    statusLabel: "已付款"
      responses:
        '2XX':
          description: |
            已收到（我們不檢查具體的 2xx 碼與 body 內容）。建議回 `204`。
        default:
          description: |
            任何非 `2xx` 回應都會觸發重試。
            ⚠️ 請確保業務錯誤也回 `2xx`，否則我們會重試 24 小時。
```

**⚠️ `webhooks` 是 OpenAPI 3.1 的新功能**，在 3.0 只能用 `callbacks`
（而 `callbacks` 的語意是「這個請求會觸發回呼」，不是「我們會主動發送」）。

**這一段的三個關鍵設計**（第 01 章 1.16 練習 4 的完整版）：

| 設計 | 為什麼 |
|---|---|
| 明確要求「業務錯誤也回 `2xx`」 | webhook 的錯誤語意和一般 API **相反** |
| 提供簽章驗證的**完整演算法**與常數時間比較的警告 | 這是資安關鍵，不能只說「請驗證簽章」 |
| 明確的重試時程表 | 讓 consumer 能規劃自己的處理容量 |

---

## 7.6 springdoc-openapi（Code-first）

### 7.6.1 依賴與基本設定

```xml
<dependency>
    <groupId>org.springdoc</groupId>
    <artifactId>springdoc-openapi-starter-webmvc-ui</artifactId>
    <version>2.6.0</version>
</dependency>
```

```yaml
springdoc:
  api-docs:
    path: /v3/api-docs
    version: openapi_3_1            # ★ 預設是 3.0.1，要明確指定 3.1
    enabled: true
  swagger-ui:
    path: /swagger-ui.html
    operations-sorter: alpha        # 端點按字母排序（預設是「隨機」）
    tags-sorter: alpha
    display-request-duration: true  # 顯示請求耗時（很實用）
    doc-expansion: none             # 預設收合（端點多時必要）
    persist-authorization: true     # ★ 重新整理後保留 token（否則每次都要重貼）
    try-it-out-enabled: true
  default-produces-media-type: application/json
  default-consumes-media-type: application/json
  # ★ 不要暴露 actuator 與內部端點
  paths-to-exclude: /actuator/**, /internal/**
  # ★ 讓 schema 用 record 的參數名（而非 getter 推導）
  writer-with-order-by-keys: true   # schema 屬性按字母排序（讓 diff 穩定）
```

**⚠️ 正式環境要關掉 Swagger UI**：

```yaml
# application-prod.yml
springdoc:
  swagger-ui:
    enabled: false
  api-docs:
    enabled: false        # ⚠️ 或至少加上認證
```

**理由**：Swagger UI 會暴露完整的 API 結構、內部端點、schema 細節 ——
這是攻擊者最想要的偵查資訊。

**但契約本身要能取得**（給 consumer 用）：
建議做法是在 CI 產生 `orders-api.yaml` 並發布到獨立的文件站，
而不是讓正式環境的服務動態提供。

### 7.6.2 `OpenAPI` bean：全域元資料

```java
@Configuration
public class OpenApiConfig {

    @Bean
    OpenAPI shopServiceOpenApi(@Value("${app.version}") String version,
                               @Value("${app.docs-base-url}") String docsUrl) {
        return new OpenAPI()
                .info(new Info()
                        .title("shop-service API")
                        .version(version)
                        .summary("電商訂單系統 API")
                        .description(loadClasspathResource("openapi/info-description.md"))  // ★ 從檔案讀
                        .contact(new Contact()
                                .name("shop-service API 團隊")
                                .email("api@shop.example"))
                        .license(new License().name("Proprietary")))
                .servers(List.of(
                        new Server().url("https://api.shop.example/v1").description("正式環境"),
                        new Server().url("https://staging-api.shop.example/v1")
                                    .description("測試環境（支援 ?_inject= 注入參數）")))
                .externalDocs(new ExternalDocumentation()
                        .description("完整文件與教學").url(docsUrl))
                .tags(List.of(
                        new Tag().name("Orders").description(load("openapi/tags/orders.md")),
                        new Tag().name("Order Actions").description(load("openapi/tags/order-actions.md"))))
                .components(new Components()
                        .addSecuritySchemes("bearerAuth", new SecurityScheme()
                                .type(SecurityScheme.Type.HTTP)
                                .scheme("bearer")
                                .bearerFormat("JWT")
                                .description(load("openapi/security/bearer.md")))
                        // ★ 全域共用的錯誤回應（避免每個端點重複）
                        .addResponses("BadRequest", problemResponse(400, "請求格式錯誤"))
                        .addResponses("Unauthorized", problemResponse(401, "未認證"))
                        .addResponses("Forbidden", problemResponse(403, "權限不足"))
                        .addResponses("NotFound", problemResponse(404, "資源不存在"))
                        .addResponses("Conflict", problemResponse(409, "狀態衝突"))
                        .addResponses("UnprocessableContent", problemResponse(422, "驗證失敗"))
                        .addResponses("TooManyRequests", problemResponse(429, "超過速率限制"))
                        .addResponses("InternalServerError", problemResponse(500, "系統錯誤")))
                .addSecurityItem(new SecurityRequirement().addList("bearerAuth"));
    }

    /** ★ 把長的 description 放在 Markdown 檔案裡，而不是 Java 字串 */
    private static String load(String path) {
        try (var in = new ClassPathResource(path).getInputStream()) {
            return new String(in.readAllBytes(), UTF_8);
        } catch (IOException e) {
            throw new IllegalStateException("找不到文件資源: " + path, e);
        }
    }
}
```

**「description 放在 Markdown 檔案」是很重要的實踐**：

| 好處 | 說明 |
|---|---|
| Java 字串裡寫 Markdown 表格是地獄 | `"| 角色 | 範圍 |\n|---|---|\n..."` 無法維護 |
| 可以請非工程師編輯 | PM／技術寫作者可以直接改 `.md` |
| diff 好讀 | 改文案時 PR diff 清楚 |
| 可以重用 | 同一段說明可以同時給 OpenAPI 和文件站用 |

### 7.6.3 全域註冊共用參數與回應（`OpenApiCustomizer`）

**問題**：如果每個 Controller 方法都要寫一遍 `@ApiResponse(responseCode = "401", ...)`，
83 條端點會有 500 行重複的註解。

**解法**：用 `OpenApiCustomizer` 批次加上。

```java
@Bean
OpenApiCustomizer commonResponsesCustomizer() {
    return openApi -> openApi.getPaths().values().forEach(pathItem ->
        pathItem.readOperations().forEach(op -> {
            ApiResponses r = op.getResponses();
            // ★ 所有端點都可能回這些
            r.addApiResponse("401", refResponse("Unauthorized"));
            r.addApiResponse("429", refResponse("TooManyRequests"));
            r.addApiResponse("500", refResponse("InternalServerError"));
            r.addApiResponse("503", refResponse("ServiceUnavailable"));

            // ★ 寫入操作額外加上
            if (isWriteOperation(op)) {
                r.addApiResponse("400", refResponse("BadRequest"));
                r.addApiResponse("422", refResponse("UnprocessableContent"));
            }
        }));
}

@Bean
OpenApiCustomizer clientHeadersCustomizer() {
    return openApi -> openApi.getPaths().values().forEach(pathItem ->
        pathItem.readOperations().forEach(op -> {
            // ★ 所有端點都要求 X-Client-Id / X-Client-Version
            op.addParametersItem(new Parameter()
                    .$ref("#/components/parameters/ClientId"));
            op.addParametersItem(new Parameter()
                    .$ref("#/components/parameters/ClientVersion"));
        }));
}

private static ApiResponse refResponse(String name) {
    return new ApiResponse().$ref("#/components/responses/" + name);
}
```

**這 20 行取代了 500 行重複註解，而且保證一致。**

### 7.6.4 讓產出不要爛：十個必做的事

**springdoc 的預設產出通常是這樣**：

```yaml
# ❌ springdoc 的預設輸出（沒寫註解時）
/orders:
  get:
    tags: [order-controller]                    # ← 類別名，很醜
    operationId: list                            # ← 方法名，不夠明確
    parameters:
      - name: filter
        in: query
        schema: { $ref: '#/components/schemas/OrderFilter' }   # ← ⚠️ 物件當 query 參數，錯的
    responses:
      '200':
        description: OK                          # ← 沒有資訊
        content:
          '*/*':                                 # ← 應該是 application/json
            schema: { $ref: '#/components/schemas/PageResponseOrderSummary' }  # ← 泛型名稱很醜
```

**十個修正**：

**① `@Tag` 用可讀的名稱**

```java
@RestController
@RequestMapping("/v1/orders")
@Tag(name = "Orders", description = "訂單的建立、查詢、修改")     // ★ 不要讓它用類別名
public class OrderController { }
```

**② `@Operation` 給 `operationId` 與 `summary`**

```java
@GetMapping
@Operation(
    operationId = "listOrders",                    // ★ SDK 的方法名
    summary = "查詢訂單列表",
    description = """
        查詢訂單列表，支援篩選、排序、搜尋與兩種分頁模式。

        ## 權限與範圍
        | 角色 | 預設範圍 |
        |---|---|
        | `CUSTOMER` | 僅自己的訂單 |
        | `SUPPORT` | 所負責區域的全部訂單 |

        ⚠️ `CUSTOMER` 帶 `customerId` 參數會回 `403`。
        """)
public PageResponse<OrderSummary> list(...) { }
```

**⚠️ Java 21 的 text block（`"""`）讓寫 Markdown 變得可行** ——
但超過 20 行還是應該放外部檔案（7.6.2）。

**③ 展開 query 物件（`@ParameterObject`）**

```java
// ❌ 沒加註解 → 產生「一個叫 filter 的物件參數」（錯的）
public PageResponse<OrderSummary> list(OrderFilter filter, Pageable pageable) { }

// ✅ 展開成個別的 query 參數
public PageResponse<OrderSummary> list(
        @ParameterObject OrderFilter filter,
        @ParameterObject Pageable pageable) { }
```

**④ 修正 `Pageable` 的產出**

springdoc 對 `Pageable` 的預設產出是 `page` / `size` / `sort`，但：
- `sort` 的 schema 是 `array of string`，**沒有 pattern 也沒有說明**。
- 沒有 `maximum`（不知道 `size` 上限是 100）。

```java
// ★ 不要用 Pageable，用自己的 record（可以完整標註）
public record OrderPageQuery(
    @Parameter(description = """
        頁碼，**從 0 開始**。與 `cursor` 互斥。
        ⚠️ 此參數的基準永不變更。
        """, example = "0")
    @Min(0) @Max(500)
    Integer page,

    @Parameter(description = """
        每頁筆數。⚠️ 超過上限回 `400`（不會靜默夾取）。
        額外限制：`page × size <= 10000`。
        """, example = "20")
    @Min(1) @Max(100)
    Integer size,

    @Parameter(description = "不透明分頁游標。請使用 `links.next`，不要自行建構。")
    @Size(max = 512)
    String cursor,

    @ArraySchema(
        arraySchema = @Schema(description = "排序，格式 `<欄位>,<asc|desc>`，最多 3 個"),
        schema = @Schema(allowableValues = {"createdAt", "updatedAt", "totalAmount",
                                            "orderNumber", "status"}),
        maxItems = 3)
    List<String> sort
) {}
```

**這也順便解決了第 05 章 5.13.2 的三個坑**（自己的 record 可以做完整驗證）。

**⑤ 給每個 `@ApiResponse` 寫 `description` 與 `examples`**

```java
@ApiResponses({
    @ApiResponse(responseCode = "201",
        description = "訂單建立成功",
        headers = {
            @Header(name = "Location", description = "新建立訂單的 URI",
                    schema = @Schema(type = "string")),
            @Header(name = "ETag", description = "版本標記（用於後續的 If-Match）",
                    schema = @Schema(type = "string"))
        },
        content = @Content(mediaType = "application/json",
            schema = @Schema(implementation = OrderDetail.class),
            examples = @ExampleObject(name = "created",
                    externalValue = "https://api.shop.example/examples/order-detail.json"))),
    @ApiResponse(responseCode = "200",
        description = """
            **冪等重播** —— 此 `Idempotency-Key` 已處理過，回傳首次的結果。
            注意狀態碼是 `200` 而非 `201`。
            """,
        headers = @Header(name = "Idempotent-Replay",
                          schema = @Schema(type = "boolean"))),
    @ApiResponse(responseCode = "409",
        description = """
            衝突。可能的 `code`：
            - `INSUFFICIENT_STOCK` — 庫存不足（含 `available`）
            - `COUPON_EXHAUSTED` — 折扣碼已用完
            - `IDEMPOTENCY_KEY_REUSED` — 相同 key 但內容不同
            """,
        content = @Content(mediaType = "application/problem+json",
            schema = @Schema(implementation = ApiProblem.class)))
})
```

**⑥ 修正泛型的 schema 名稱**

```java
// springdoc 會產生 PageResponseOrderSummary 這種名字
// ★ 用 @Schema(name = ...) 指定
@Schema(name = "OrderListResponse", description = "訂單列表回應")
public record PageResponse<T>(List<T> items, PageInfo page, PageLinks links) {}
```

**⚠️ 泛型的處理是 springdoc 最大的痛點。** 更可靠的做法是**不要用泛型 DTO**：

```java
// 為每個列表回應定義具名的 record（囉唆但 schema 乾淨）
@Schema(name = "OrderListResponse")
public record OrderListResponse(List<OrderSummary> items, PageInfo page, PageLinks links) {}

@Schema(name = "ProductListResponse")
public record ProductListResponse(List<ProductSummary> items, PageInfo page, PageLinks links) {}
```

**這是 Code-first 的一個真實代價**：為了讓產出的 schema 好看，你要犧牲一點 Java 的簡潔。

**⑦ 標註 `nullable` 與 `required`**

```java
public record OrderDetail(
    @Schema(requiredMode = REQUIRED, description = "訂單系統識別碼",
            example = "ord_01J5GKQ8Z4W9V2X3Y6N7M8P0QR")
    String orderId,

    @Schema(requiredMode = REQUIRED, description = "對外訂單編號（客服與包裝使用）",
            example = "ORD-20260819-0001", pattern = "^ORD-\\d{8}-\\d{4}$")
    String orderNumber,

    @Schema(requiredMode = NOT_REQUIRED, nullable = true,
            description = """
                取消資訊。**永遠出現此欄位**（未取消時為 `null`），
                讓客戶端能區分「概念存在但未發生」與「不支援此概念」。
                """)
    CancellationResponse cancellation,

    @ArraySchema(arraySchema = @Schema(description = """
            出貨紀錄。**空集合回 `[]` 而非 `null`**。
            可能有多筆（分批出貨）。
            """))
    List<ShipmentResponse> shipments
) {}
```

**⑧ 隱藏內部端點與欄位**

```java
@Hidden                                          // 整個 Controller 不出現在文件
@RestController
@RequestMapping("/internal/admin")
public class InternalAdminController { }

@Operation(hidden = true)                        // 單一端點隱藏
@PostMapping("/orders/{id}/force-cancel")
public void forceCancel(...) { }

public record OrderDetailForSupport(
    ...,
    @Schema(hidden = true)                       // 欄位不出現在 schema
    FraudCheck internalFraudCheck
) {}
```

**⚠️ `@Hidden` 只是「不寫進文件」，不是「不能呼叫」。**
安全控制要靠 Spring Security（09-spring-security），不是靠隱藏。

**⑨ 產生檔案並進版控**

```xml
<plugin>
    <groupId>org.springdoc</groupId>
    <artifactId>springdoc-openapi-maven-plugin</artifactId>
    <version>1.4</version>
    <executions>
        <execution>
            <id>generate-openapi</id>
            <phase>integration-test</phase>
            <goals><goal>generate</goal></goals>
        </execution>
    </executions>
    <configuration>
        <apiDocsUrl>http://localhost:8080/v3/api-docs.yaml</apiDocsUrl>
        <outputFileName>orders-api.generated.yaml</outputFileName>
        <outputDir>${project.basedir}/api</outputDir>
    </configuration>
</plugin>
```

**⚠️ 這個 plugin 需要應用程式在跑**（它是打 HTTP 端點），所以要配合
`spring-boot-maven-plugin` 的 `start` / `stop` goal。

**更可靠的做法：用測試產生**（不需要啟動完整的伺服器）：

```java
@SpringBootTest(webEnvironment = RANDOM_PORT)
class OpenApiSnapshotTest {

    @Autowired TestRestTemplate rest;

    @Test
    void 產生並比對契約快照() throws Exception {
        String generated = rest.getForObject("/v3/api-docs.yaml", String.class);
        Path snapshot = Path.of("api/orders-api.generated.yaml");

        if (Boolean.getBoolean("updateSnapshots")) {
            Files.writeString(snapshot, generated);
            return;
        }

        assertThat(generated)
                .as("""
                    契約已變更。若這是預期的，請執行：
                      ./mvnw test -DupdateSnapshots=true -Dtest=OpenApiSnapshotTest
                    並在 PR 說明變更原因。
                    """)
                .isEqualTo(Files.readString(snapshot));
    }
}
```

**`as(...)` 裡的錯誤訊息很重要** —— 它告訴下一個踩到這個測試的人該怎麼做。

**⑩ 讓輸出穩定（可 diff）**

```yaml
springdoc:
  writer-with-order-by-keys: true       # schema 屬性按字母排序
  writer-with-default-pretty-printer: true
```

**沒有這個設定的話**，springdoc 產生的 YAML 的欄位順序可能因為
反射的順序、HashMap 的迭代順序而改變 → **每次都有假的 diff**。

### 7.6.5 springdoc 的五個常見問題

| 問題 | 原因 | 解法 |
|---|---|---|
| `record` 的欄位描述沒出現 | 需要 `-parameters` 編譯旗標（第 03 章 3.4.2） | Spring Boot parent 已包含；自訂 POM 要自己加 |
| `oneOf` / `discriminator` 產不出來 | springdoc 需要明確的註解 | `@Schema(oneOf = {A.class, B.class}, discriminatorProperty = "mode")` |
| `Instant` 產出 `type: number` | Jackson 設定沒被 springdoc 讀到 | 確認 `spring.jackson.serialization.write-dates-as-timestamps: false`；或 `@Schema(type = "string", format = "date-time")` |
| `Problem` 的擴充欄位不出現 | `Map<String, Object>` 無法表達 | 為每個錯誤型別定義具名 schema（見下） |
| `ProblemDetail` 的 schema 很醜 | Spring 的 `ProblemDetail` 有 `properties` map | 用自訂的 `ApiProblem` record（第 04 章 4.4.6） |

**第 4 個問題的解法（錯誤型別的 schema）**：

```java
// 基底
@Schema(name = "Problem", description = "RFC 9457 Problem Details")
public record ApiProblem(
    @Schema(requiredMode = REQUIRED, format = "uri") String type,
    @Schema(requiredMode = REQUIRED) String title,
    @Schema(requiredMode = REQUIRED) Integer status,
    String detail,
    @Schema(format = "uri-reference") String instance,
    @Schema(requiredMode = REQUIRED) String code,
    @Schema(requiredMode = REQUIRED) String userMessage,
    @Schema(requiredMode = REQUIRED) String traceId,
    Boolean retryable,
    RetryStrategy retryStrategy,
    List<FieldError> errors
) {}

// 特定錯誤型別（讓客戶端知道有哪些擴充欄位）
@Schema(name = "InsufficientStockProblem",
        description = "庫存不足（`code: INSUFFICIENT_STOCK`）",
        allOf = { ApiProblem.class })
public record InsufficientStockProblem(
    @Schema(requiredMode = REQUIRED) String productId,
    @Schema(requiredMode = REQUIRED) String productName,
    @Schema(requiredMode = REQUIRED) Integer requested,
    @Schema(requiredMode = REQUIRED, description = "當前可用數量。客戶端可據此提供「改為 N 件」的操作。")
    Integer available,
    @Schema(format = "date") String restockEstimatedAt
) {}
```

**這讓 consumer 的 TypeScript 有型別安全的擴充欄位**（第 04 章 4.14.1）。

---

## 7.7 寫出人看得懂的文件

### 7.7.1 `description` 該寫什麼

**判準：`description` 要回答「schema 本身回答不了的問題」。**

```yaml
# ❌ 重複欄位名（零資訊）
orderNumber:
  type: string
  description: 訂單編號

# ⚠️ 只說「是什麼」（有一點資訊）
orderNumber:
  type: string
  description: 對外的訂單編號

# ✅ 回答 consumer 真正會問的問題
orderNumber:
  type: string
  pattern: '^ORD-\d{8}-\d{4}$'
  description: |
    對外的訂單編號，格式 `ORD-<yyyyMMdd>-<當日流水號>`。

    - **給人看的**：客服對答案、包裝標籤、發票、客戶詢問時使用
    - 與 `orderId`（系統識別碼）**不同** —— API 路徑請用 `orderId`
    - 可用於查詢：`GET /orders?orderNumber=ORD-20260819-0001`
    - 一經建立永不變更
  examples: ["ORD-20260819-0001"]
```

**`description` 應該回答的五類問題**：

| 類別 | 例子 |
|---|---|
| **這是給誰用的** | 「給人看的」vs「給程式用的」 |
| **和其他欄位的關係** | 「與 `orderId` 不同」、「與 `cursor` 互斥」 |
| **會不會變** | 「一經建立永不變更」、「此列舉會持續新增值」 |
| **怎麼用** | 「可用於 `?orderNumber=` 查詢」 |
| **陷阱與注意事項** | 「⚠️ 請用 decimal 函式庫運算」 |

### 7.7.2 好範例 vs 壞範例

```yaml
# ❌ 壞範例（springdoc 的預設）
examples: ["string"]

# ❌ 壞範例（假資料，看不出格式）
examples: ["test", "abc", "123"]

# ⚠️ 一般（正確但無脈絡）
examples: ["ORD-20260819-0001"]

# ✅ 好範例（有名稱、有摘要、涵蓋不同情境）
examples:
  normal:
    summary: 一般訂單
    value: "ORD-20260819-0001"
  highVolumeDay:
    summary: 高流量日（流水號到 4 位）
    value: "ORD-20261111-9999"
```

**回應範例的設計原則**：

| 原則 | 說明 |
|---|---|
| **至少三個範例**：最簡、完整、邊界 | 「最少欄位的成功回應」「所有欄位都有值」「空集合」 |
| **範例之間要一致** | 同一個 `orderId` 在不同範例裡要是同一個值（否則讀者以為它們是不同的訂單） |
| **範例要能真的跑** | ⚠️ 用 Prism mock 起來測一次（7.8）—— 假範例會誤導 |
| **錯誤範例和成功範例一樣重要** | 開發者 80% 的時間在處理錯誤 |
| **金額／時間要用真實的格式** | `"1280.50"` 而不是 `"0"`；`"2026-08-19T06:12:44Z"` 而不是 `"2024-01-01"` |

**shop-service 的做法：範例存在外部檔案並且被測試驗證**

```java
@Test
void OpenAPI_的回應範例必須符合_schema() throws Exception {
    OpenAPI api = new OpenAPIV3Parser().read("api/orders-api.yaml");
    JsonSchemaValidator validator = JsonSchemaValidator.from(api);

    for (Path exampleFile : Files.list(Path.of("api/examples")).toList()) {
        String json = Files.readString(exampleFile);
        String schemaRef = inferSchemaRef(exampleFile);      // 從檔名推導

        assertThat(validator.validate(json, schemaRef))
                .as("範例 %s 不符合 schema %s", exampleFile, schemaRef)
                .isEmpty();
    }
}
```

**這個測試防止「範例過期」** —— 加了新的必填欄位但忘記更新範例時，測試會失敗。

### 7.7.3 端點的 `description` 模板

```markdown
（一句話說明這個端點做什麼）

## 權限與範圍
（誰能呼叫、看到什麼、有哪些額外參數）

## 業務規則
（前置條件、狀態限制、副作用）

## 冪等性
（是否需要 Idempotency-Key、重試的行為）

## 效能建議
（大量資料該用什麼、上限是什麼）

## 常見錯誤
（最容易遇到的 2～3 個錯誤與處理方式）

## 相關端點
（下一步通常會呼叫什麼）
```

**「相關端點」這一段常被忽略但很有價值**：

```markdown
## 相關端點
- 建立訂單後付款：`POST /orders/{orderId}/payments`
- 取消未付款訂單：`POST /orders/{orderId}/cancellations`
- 查詢訂單狀態變更歷史：`GET /orders/{orderId}/status-changes`
```

**它把「一份端點清單」變成「一條可以走的路徑」。**

---

## 7.8 Mock Server：讓前端不用等後端

### 7.8.1 Prism

```bash
npm install -g @stoplight/prism-cli

# 起 mock server（用 schema 產生假資料）
prism mock api/orders-api.yaml --port 4010

# 用契約裡的 examples 回應（★ 更好，因為範例是真實的）
prism mock api/orders-api.yaml --port 4010 --example

# 動態模式：驗證請求是否符合契約，不符合就回錯誤
prism mock api/orders-api.yaml --port 4010 --errors
```

```bash
# 前端指向 mock
VITE_API_BASE_URL=http://localhost:4010/v1 npm run dev
```

**`--errors` 模式的價值**：它讓 mock 變成**契約的守門員**。

```bash
# 前端漏了必填的 header
curl http://localhost:4010/v1/orders
→ 422 { "type": "...", "detail": "Request header X-Client-Id is required" }
                                    ↑ Prism 依契約驗證，前端立刻發現

# 前端送了錯的 enum
curl -X POST http://localhost:4010/v1/orders -d '{"items":[],"invoice":{"type":"WRONG"}}'
→ 422 { "detail": "Request body property invoice.type must be equal to one of the allowed values" }
```

**這比「等後端寫好再發現」快了幾天。**

### 7.8.2 指定要哪一個範例

```bash
# 用 Prefer header 選擇特定的回應與範例
curl http://localhost:4010/v1/orders/ord_1 \
  -H 'Prefer: code=404'

curl http://localhost:4010/v1/orders \
  -H 'Prefer: example=empty'

curl -X POST http://localhost:4010/v1/orders \
  -H 'Prefer: code=409, example=insufficientStock'
```

**這讓前端可以測試所有錯誤路徑，而不用想辦法在真實後端製造出那些錯誤。**

**前端的測試**：

```typescript
// 測試「庫存不足」的 UI
it('庫存不足時顯示「改為 N 件」按鈕', async () => {
  server.use(
    http.post('/v1/orders', () =>
      HttpResponse.json(insufficientStockProblem, { status: 409 }))
  );

  render(<Checkout cart={cart} />);
  await userEvent.click(screen.getByRole('button', { name: '結帳' }));

  expect(await screen.findByText(/僅剩 3 件/)).toBeVisible();
  expect(screen.getByRole('button', { name: '改為 3 件' })).toBeVisible();
});
```

**⚠️ 這裡用的是 MSW（Mock Service Worker）而不是 Prism** ——
兩者的定位不同：

| 工具 | 定位 |
|---|---|
| **Prism** | 起一個真的 HTTP server，前端的 dev server 指向它 → **開發時**用 |
| **MSW** | 在瀏覽器／Node 裡攔截 fetch → **測試時**用 |
| **WireMock** | JVM 生態的 mock server → **後端測試外部依賴時**用 |

**shop-service 的用法**：
- 前端開發 → Prism（`--example --errors`）
- 前端測試 → MSW（範例直接從 `api/examples/` 載入，保證一致）
- 後端測試金流商 → WireMock

**「MSW 的 mock 資料從 `api/examples/` 載入」是關鍵**：
這樣前端測試用的假資料和契約的範例是同一份 —— 契約改了測試會失敗。

### 7.8.3 契約先行的完整協作流程

```
Day 1  【需求討論】PM + 前端 + 後端 一起看需求
       → 產出：需要哪些端點、大致的資料形狀

Day 1  【後端】在 api/orders-api.yaml 寫契約（1～3 小時）
       → 不寫任何實作

Day 2  【Review】前端 + 後端 + （若涉及廠商）廠商 一起 review PR
       → 前端檢查：「這些欄位夠我畫畫面嗎？」「有沒有 N+1 API 的問題？」
       → 後端檢查：「這些欄位我拿得到嗎？」「效能可以嗎？」
       → 廠商檢查：「我的系統結構能處理嗎？」
       → ★ 這是整個流程最有價值的一步：在寫任何程式碼前發現設計問題

Day 2  【合併契約】PR merge → CI 產生打包後的 yaml + 部署 mock server
       → mock server 網址：https://mock.shop.example/v1

Day 3  【並行開發】
       前端：指向 mock，開始寫畫面 + 測試（用 examples）
       後端：照契約實作 + 用契約驗證回應的測試（第 09 章 9.4）

Day 8  【整合】後端部署到 staging
       → 前端把 base URL 從 mock 換成 staging
       → ★ 如果契約遵守了，這一步應該「什麼都不用改」

Day 9  【驗收】
       → 用契約驗證測試（第 09 章 9.4）確認實作符合契約
       → 若有落差 → 修實作（而不是修契約）
```

**這個流程的三個關鍵**：

| 關鍵 | 為什麼 |
|---|---|
| **Day 2 的 review 是核心** | 改 YAML 的成本是 10 分鐘，改已實作的 API 是 3 天 |
| **前端在 review 時要檢查「夠我畫畫面嗎」** | 這是避免 N+1 API 最有效的時機（第 00 章 0.3.1） |
| **Day 8 的「什麼都不用改」是驗收標準** | 如果要改，說明契約沒被遵守 → 要追究原因 |

**真實的效益**：

```
傳統流程（後端先做完）：
  後端 5 天 → 前端 5 天 → 整合 2 天 = 12 天

契約先行：
  契約 0.5 天 → review 0.5 天 → 並行 5 天 → 整合 1 天 = 7 天
```

**而且省下的不只是時間，是「整合時才發現設計不對」的返工。**

---

## 7.9 Lint 與 CI

### 7.9.1 Spectral

```bash
npm install -g @stoplight/spectral-cli
spectral lint api/orders-api.yaml
```

**內建規則集**：

```yaml
# .spectral.yaml
extends: ["spectral:oas"]        # OpenAPI 的官方規則集
```

`spectral:oas` 會檢查：語法正確性、`operationId` 唯一、`$ref` 可解析、
`description` 不為空、tag 有定義、範例符合 schema…

### 7.9.2 自訂規則：把 style guide 變成 lint

**這是 Spectral 最有價值的用法** —— 把前面六章的規則自動化。

```yaml
# .spectral.yaml
extends: ["spectral:oas"]

functions: [pathCasing, noVerbInPath]
functionsDir: "./spectral-functions"

rules:
  # ── 第 01 章：URL 命名 ──────────────────────────
  path-must-be-kebab-case:
    description: URL 路徑必須是小寫 kebab-case（第 01 章規則 3、4）
    severity: error
    given: "$.paths[*]~"
    then:
      function: pattern
      functionOptions:
        match: "^(/[a-z0-9]+(-[a-z0-9]+)*|/\\{[a-zA-Z]+\\})+$"

  path-must-not-contain-verb:
    description: |
      URL 不可含動詞（第 01 章規則 1）。
      白名單：recalculate、purge、refresh（見 style guide 的動詞白名單）
    severity: error
    given: "$.paths[*]~"
    then:
      function: noVerbInPath

  path-must-be-plural:
    description: 集合路徑必須是複數（第 01 章規則 2）
    severity: warn
    given: "$.paths[*]~"
    then:
      function: pattern
      functionOptions:
        notMatch: "/(order|product|customer|payment|shipment|item|address)(/|$)"

  path-no-trailing-slash:
    description: 路徑不可有尾斜線（第 01 章規則 6）
    severity: error
    given: "$.paths[*]~"
    then:
      function: pattern
      functionOptions:
        notMatch: ".+/$"

  # ── 第 02 章：方法與狀態碼 ──────────────────────
  post-must-return-201-or-202:
    description: POST 建立資源應回 201（或非同步的 202）（第 02 章 2.4.2）
    severity: warn
    given: "$.paths[*].post.responses"
    then:
      function: schema
      functionOptions:
        schema:
          anyOf:
            - required: ["201"]
            - required: ["202"]
            - required: ["200"]     # 動作型端點可以回 200

  created-must-have-location-header:
    description: 201 必須帶 Location header（第 02 章 2.4.2）
    severity: error
    given: "$.paths[*].post.responses.201"
    then:
      field: headers.Location
      function: truthy

  no-content-must-not-have-body:
    description: 204 不可有 body（第 02 章 2.8.2）
    severity: error
    given: "$.paths[*][*].responses.204"
    then:
      field: content
      function: falsy

  method-not-allowed-must-have-allow:
    description: 405 必須帶 Allow header（第 02 章 2.8.4）
    severity: error
    given: "$.paths[*][*].responses.405"
    then:
      field: headers.Allow
      function: truthy

  unauthorized-must-have-www-authenticate:
    description: 401 必須帶 WWW-Authenticate（第 02 章 2.9.1）
    severity: error
    given: "$..responses.401"
    then:
      field: headers.WWW-Authenticate
      function: truthy

  rate-limited-must-have-retry-after:
    description: 429 與 503 必須帶 Retry-After（第 02 章 2.8.5）
    severity: error
    given: "$..responses[?(@property === '429' || @property === '503')]"
    then:
      field: headers.Retry-After
      function: truthy

  # ── 第 03 章：DTO 設計 ──────────────────────────
  property-must-be-camel-case:
    description: JSON 欄位必須是 camelCase（第 03 章 3.5.1）
    severity: error
    given: "$.components.schemas..properties[*]~"
    then:
      function: casing
      functionOptions: { type: camel }

  no-sensitive-field-names:
    description: |
      🔴 回應不可包含敏感欄位（第 03 章 3.2.9）。
      這是資安護欄 —— 任何符合這些名稱的欄位都必須被 review。
    severity: error
    given: "$.components.schemas..properties[*]~"
    then:
      function: pattern
      functionOptions:
        notMatch: "(?i)(password|passwordHash|pwd|secret|salt|privateKey|idNumber|ssn|creditCard|cvv|internalCost|marginRate|riskScore)"

  money-must-be-string:
    description: 金額欄位必須是字串（第 03 章 3.5.3）
    severity: error
    given: "$.components.schemas..properties[?(@property.match(/(amount|price|fee|total|subtotal|discount|tax)$/i))]"
    then:
      field: type
      function: pattern
      functionOptions: { match: "^string$" }

  id-must-be-string:
    description: ID 欄位必須是字串（第 03 章 3.5.4）
    severity: error
    given: "$.components.schemas..properties[?(@property.match(/Id$/))]"
    then:
      field: type
      function: pattern
      functionOptions: { match: "^string$" }

  timestamp-must-be-date-time:
    description: xxxAt 欄位必須是 date-time 格式（第 03 章 3.6）
    severity: error
    given: "$.components.schemas..properties[?(@property.match(/At$/))]"
    then:
      field: format
      function: pattern
      functionOptions: { match: "^date-time$" }

  array-must-not-be-nullable:
    description: 陣列不可為 null（第 03 章 3.7.2）
    severity: error
    given: "$.components.schemas..properties[?(@.type === 'array')]"
    then:
      field: nullable
      function: falsy

  # ── 第 04 章：錯誤設計 ──────────────────────────
  error-must-use-problem-json:
    description: 4xx/5xx 必須用 application/problem+json（第 04 章 4.4.5）
    severity: error
    given: "$..responses[?(@property.match(/^[45]/))].content"
    then:
      field: "application/problem+json"
      function: truthy

  error-must-have-example:
    description: 錯誤回應必須有範例（開發者最需要的就是錯誤範例）
    severity: warn
    given: "$..responses[?(@property.match(/^[45]/))].content['application/problem+json']"
    then:
      field: examples
      function: truthy

  # ── 第 05 章：分頁 ──────────────────────────────
  list-must-have-pagination:
    description: 回傳集合的端點必須有分頁參數（第 05 章 5.2）
    severity: error
    given: "$.paths[?(!@property.match(/\\{/))]get"
    then:
      function: schema
      functionOptions:
        schema:
          properties:
            parameters:
              type: array
              contains:
                anyOf:
                  - properties: { $ref: { const: "#/components/parameters/Page" } }
                  - properties: { $ref: { const: "#/components/parameters/Cursor" } }

  size-must-have-maximum:
    description: size / limit 參數必須有 maximum（第 05 章 5.2.3）
    severity: error
    given: "$.components.parameters[?(@.name === 'size' || @.name === 'limit')].schema"
    then:
      field: maximum
      function: truthy

  # ── 第 06 章：相容性 ────────────────────────────
  extensible-enum-must-be-documented:
    description: |
      列舉必須標註 x-extensible-enum 並在 description 說明客戶端該如何處理未知值
      （第 06 章 6.4.2）
    severity: warn
    given: "$.components.schemas[?(@.enum)]"
    then:
      - field: description
        function: truthy
      - field: description
        function: pattern
        functionOptions: { match: "(?i)(未知|unknown|default|extensible)" }

  deprecated-must-have-sunset-info:
    description: 標記 deprecated 的項目必須在 description 說明 Sunset 日期與替代方案
    severity: error
    given: "$..[?(@.deprecated === true)]"
    then:
      field: description
      function: pattern
      functionOptions: { match: "(?i)(sunset|替代|請改用)" }

  # ── 通用品質 ────────────────────────────────────
  operation-must-have-operation-id:
    description: 每個操作必須有 operationId（SDK 產生器需要）
    severity: error
    given: "$.paths[*][get,post,put,patch,delete]"
    then:
      field: operationId
      function: truthy

  operation-description-must-be-meaningful:
    description: description 至少 50 字元（避免「訂單列表」這種零資訊的說明）
    severity: warn
    given: "$.paths[*][get,post,put,patch,delete]"
    then:
      field: description
      function: length
      functionOptions: { min: 50 }

  no-example-placeholder:
    description: 範例不可是 "string" / "abc" 這類佔位符
    severity: error
    given: "$..examples[*].value"
    then:
      function: pattern
      functionOptions:
        notMatch: "^(string|abc|test|foo|bar|xxx|todo|\\?\\?\\?)$"
```

**自訂函式（`noVerbInPath`）**：

```javascript
// spectral-functions/noVerbInPath.js
const VERB_ALLOWLIST = new Set(['recalculate', 'purge', 'refresh', 'verification']);

const VERBS = /\b(get|post|put|delete|create|update|remove|fetch|list|query|search|add|save|submit|cancel|send|export|import|login|logout|do|exec|invoke|process|handle)\b/i;

export default function noVerbInPath(path) {
  const segments = path.split('/').filter(Boolean);
  const results = [];
  for (const seg of segments) {
    if (seg.startsWith('{')) continue;
    if (VERB_ALLOWLIST.has(seg)) continue;
    if (VERBS.test(seg)) {
      results.push({
        message: `路徑片段 "${seg}" 含動詞。請改用名詞 + HTTP 方法（第 01 章規則 1）。` +
                 `若真的需要動詞（控制器資源），請加入 style guide 的白名單並在 PR 說明理由。`,
      });
    }
  }
  return results;
}
```

**這 25 條規則把「六章的 style guide」變成 CI 可執行的檢查。**

**⚠️ 導入時要漸進**（第 05 章 5.8.6 的同一個原則）：

```
階段 1：全部設 severity: info → 只顯示，不擋
階段 2：修完既有違規 → 逐條升級到 warn
階段 3：升級到 error（擋 PR）
```

**突然開啟 25 條 error 規則會讓所有 PR 都紅 → 大家會加 `--skip-rule` 繞過。**

### 7.9.3 完整的 CI pipeline

```yaml
# .github/workflows/api-contract.yml
name: API 契約檢查

on:
  pull_request:
    paths: ['api/**', 'src/main/java/**/api/**', 'src/main/java/**/web/**']

jobs:
  lint:
    name: Lint 契約
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }

      - name: 打包契約（解析 $ref）
        run: npx @redocly/cli bundle api/orders-api.yaml -o /tmp/bundled.yaml

      - name: Spectral lint
        run: npx @stoplight/spectral-cli lint /tmp/bundled.yaml
                --ruleset .spectral.yaml
                --fail-severity error
                --format github-actions

      - name: 驗證範例符合 schema
        run: node scripts/validate-examples.mjs

  breaking-change:
    name: 破壞性變更檢查
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }

      - name: 取出 base 契約
        run: |
          git show origin/${{ github.base_ref }}:api/orders-api.yaml > /tmp/base-raw.yaml
          npx @redocly/cli bundle /tmp/base-raw.yaml -o /tmp/base.yaml
          npx @redocly/cli bundle api/orders-api.yaml -o /tmp/head.yaml

      - name: 檢查破壞性變更
        run: |
          ALLOW=$(yq -r '.allowed[] | select(.expiresAt > (now | strftime("%Y-%m-%d"))) | .change' \
                  api/breaking-changes-allowlist.yaml | paste -sd, -)
          docker run --rm -v /tmp:/specs tufin/oasdiff breaking \
            /specs/base.yaml /specs/head.yaml \
            --fail-on ERR ${ALLOW:+--exclude-elements "$ALLOW"}

      - name: 產生變更報告並貼到 PR
        if: always()
        run: |
          docker run --rm -v /tmp:/specs tufin/oasdiff changelog \
            /specs/base.yaml /specs/head.yaml --format markdown > /tmp/changelog.md
          if [ -s /tmp/changelog.md ]; then
            gh pr comment ${{ github.event.number }} \
              --body "## 📋 API 契約變更$(cat /tmp/changelog.md)"
          fi
        env: { GH_TOKEN: '${{ secrets.GITHUB_TOKEN }}' }

  drift:
    name: 契約與實作一致性
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-java@v4
        with: { java-version: '21', distribution: 'temurin', cache: maven }

      - name: 產生 springdoc 契約並與手寫契約比對
        run: ./scripts/check-contract-drift.sh

  mock-smoke:
    name: Mock server 冒煙測試
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: 起 Prism 並驗證所有範例可用
        run: |
          npx @redocly/cli bundle api/orders-api.yaml -o /tmp/bundled.yaml
          npx @stoplight/prism-cli mock /tmp/bundled.yaml --port 4010 --errors &
          sleep 8
          # ★ 驗證每個端點的每個範例都能正常回應
          node scripts/smoke-test-mock.mjs http://localhost:4010

  publish:
    name: 發布文件與 mock
    if: github.ref == 'refs/heads/main'
    needs: [lint, breaking-change, drift, mock-smoke]
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: 打包並產生靜態文件
        run: |
          npx @redocly/cli bundle api/orders-api.yaml -o dist/orders-api.yaml
          npx @redocly/cli build-docs dist/orders-api.yaml -o dist/index.html
      - name: 部署到文件站
        run: ./scripts/deploy-docs.sh dist/
      - name: 部署 mock server
        run: ./scripts/deploy-mock.sh dist/orders-api.yaml
```

**五個 job 各自守住一個方向**：

| Job | 守住什麼 |
|---|---|
| `lint` | 契約符合 style guide + 範例有效 |
| `breaking-change` | 沒有意外的破壞性變更（第 06 章 6.9） |
| `drift` | 契約和實作一致（7.4.4） |
| `mock-smoke` | 契約真的可以起 mock（範例不是假的） |
| `publish` | 文件與 mock 自動更新（不會過期） |

**`mock-smoke` 這一步常被忽略但很重要**：
它證明「這份契約是可用的」，而不只是「語法正確」。

---

## 7.10 產生 client SDK

### 7.10.1 `openapi-generator`

```bash
npm install -g @openapitools/openapi-generator-cli

# TypeScript（給前端）
openapi-generator-cli generate \
  -i dist/orders-api.yaml \
  -g typescript-fetch \
  -o clients/typescript \
  --additional-properties=supportsES6=true,withInterfaces=true,useSingleRequestParameter=true

# Java（給內部其他服務）
openapi-generator-cli generate \
  -i dist/orders-api.yaml \
  -g java \
  -o clients/java \
  --additional-properties=library=resttemplate,useJakartaEe=true,dateLibrary=java8
```

### 7.10.2 更輕量的選擇：只產生型別

**大部分前端專案不需要完整的 SDK，只需要型別。**

```bash
npm install -D openapi-typescript

npx openapi-typescript dist/orders-api.yaml -o src/api/schema.d.ts
```

```typescript
import type { paths, components } from './api/schema';

type OrderDetail = components['schemas']['OrderDetail'];
type ListOrdersQuery = paths['/orders']['get']['parameters']['query'];
type ListOrdersResponse =
  paths['/orders']['get']['responses']['200']['content']['application/json'];

// 搭配 openapi-fetch（型別安全的 fetch 包裝，只有 6KB）
import createClient from 'openapi-fetch';
const api = createClient<paths>({ baseUrl: 'https://api.shop.example/v1' });

const { data, error } = await api.GET('/orders', {
  params: { query: { status: ['PAID'], page: 0, size: 20 } },
  //                  ↑ 型別安全：打錯 enum 值會編譯失敗
});

if (error) {
  // error 的型別是 Problem（含 code、userMessage、traceId）
  handleApiError(error);
} else {
  // data 的型別是 OrderListResponse
  data.items.forEach(o => console.log(o.orderNumber));
}
```

### 7.10.3 產生 SDK 的取捨

| | 完整 SDK（`openapi-generator`） | 只產生型別（`openapi-typescript`） |
|---|---|---|
| 程式碼量 | 大（幾千行產生的程式碼） | ★ 小（一個 `.d.ts`） |
| 客製化 | ⚠️ 難（要改 template 或 patch 產生的程式碼） | ★ 完全自由（你自己寫 client） |
| 錯誤處理 | 產生的通常很簡陋（拋一個泛用的例外） | ★ 你自己寫（第 04 章 4.14） |
| 冪等鍵、重試、退避 | ⚠️ 通常沒有 | ★ 你自己加 |
| 型別安全 | ✅ | ✅ |
| 版本升級 | ⚠️ 重新產生可能有大量 diff | ★ 只有型別檔變 |
| 適合 | 多語言 consumer（廠商用 C#、Python） | ★ 自家前端 |

**shop-service 的決定**：

| Consumer | 方案 |
|---|---|
| 自家 Web / App（TS） | `openapi-typescript` + 自己寫的 `api/client.ts`（含冪等鍵、重試、錯誤處理） |
| 內部 Java 服務 | 手寫 `RestClient` 封裝（可以共用領域型別，不需要產生） |
| 廠商 | 提供 `orders-api.yaml`，讓他們自己產生自己語言的 SDK ★ |

**「讓廠商自己產生」是最好的策略**：
你不用維護五種語言的 SDK，而廠商可以用他們熟悉的工具鏈。

**⚠️ 但要為此做一件事：確保契約能被主流 generator 處理。**

```bash
# CI 上驗證契約可以產生出各語言的 SDK
for GEN in typescript-fetch java python csharp php; do
  openapi-generator-cli generate -i dist/orders-api.yaml -g $GEN -o /tmp/sdk-$GEN \
    || { echo "🔴 $GEN generator 失敗 —— 契約可能用了不支援的特性"; exit 1; }
done
```

**這個檢查會抓到「OpenAPI 3.1 的某些特性某些 generator 不支援」的問題**（7.3.2）。

---

## 7.11 文件的發布與呈現

### 7.11.1 三種 UI 的取捨

| | Swagger UI | Redoc | Scalar |
|---|---|---|---|
| 可以直接發請求（Try it out） | ★★★ | ❌（唯讀） | ★★★ |
| 排版與可讀性 | ⚠️ 普通 | ★★★ 最好（三欄式） | ★★★ |
| 大型契約的效能 | ⚠️ 慢（83 端點會卡） | ★★ | ★★ |
| 範例的呈現 | ★★ | ★★★（右欄常駐） | ★★★ |
| 客製化 | ★★（有限） | ★★（付費版更多） | ★★★ |
| 深色模式 | ⚠️ 需外掛 | ✅ | ✅ |
| 適合 | 內部開發、除錯 | ★ 對外文件 | 對外文件 |

**shop-service 的做法：兩種都提供**

```
內部（開發環境）：Swagger UI（可以直接發請求測試）
對外（文件站）：  Redoc（可讀性最好，且唯讀較安全）
```

### 7.11.2 文件站的結構

```
https://api.shop.example/docs/
├── /                         → 首頁（快速開始、認證、必要 header）
├── /reference                → Redoc（OpenAPI 產生）
├── /guides/
│   ├── /authentication       → 認證與 token 生命週期
│   ├── /pagination           → 分頁完整指南（含程式碼範例）
│   ├── /idempotency          → 冪等鍵
│   ├── /errors               → 錯誤處理與錯誤碼目錄
│   ├── /webhooks             → Webhook 設定與簽章驗證
│   ├── /order-state-machine  → 訂單狀態機（含流程圖）
│   └── /consumer-contract    → Consumer Contract（第 06 章 6.4）
├── /changelog                → 變更紀錄（+ RSS）
├── /deprecations             → 棄用清單（連到 API 端點）
└── /openapi.yaml             → 契約本身（可下載）
```

**「OpenAPI 產生的 reference」和「手寫的 guides」分開，兩者互相連結**：

```yaml
# OpenAPI 裡連到 guide
parameters:
  Cursor:
    description: |
      不透明的分頁游標。
      完整說明與程式碼範例請見 [分頁指南](https://api.shop.example/docs/guides/pagination)。
```

```markdown
<!-- guide 裡連到 reference -->
## 相關 API

- [`GET /orders`](/docs/reference#operation/listOrders) — 訂單列表
```

### 7.11.3 內部文件 vs 外部文件

**同一份契約，兩種輸出**：

```bash
# 外部版本：移除內部端點與內部欄位
npx @redocly/cli bundle api/orders-api.yaml \
  --remove-unused-components \
  -o dist/orders-api.public.yaml

# 用 x-internal 標記要移除的部分
```

```yaml
paths:
  /internal/orders/{orderId}/force-cancel:
    x-internal: true              # ★ 打包時移除
    post: { ... }

components:
  schemas:
    OrderDetailForSupport:
      x-internal: true
      ...
```

```javascript
// scripts/strip-internal.mjs
import { bundle, loadConfig } from '@redocly/openapi-core';

const doc = await bundle({ ref: 'api/orders-api.yaml', config: await loadConfig() });
stripInternal(doc.bundle.parsed);
writeFileSync('dist/orders-api.public.yaml', stringify(doc.bundle.parsed));

function stripInternal(node) {
  if (Array.isArray(node)) return node.forEach(stripInternal);
  if (node === null || typeof node !== 'object') return;
  for (const [k, v] of Object.entries(node)) {
    if (v && typeof v === 'object' && v['x-internal'] === true) {
      delete node[k];
    } else {
      stripInternal(v);
    }
  }
}
```

**⚠️ 移除內部端點只是「不揭露」，不是「安全」** ——
安全要靠授權（09-spring-security）。但不揭露仍然有價值：
攻擊者少了一份地圖。

---

## 7.12 常見誤區

**誤區 1：「有 Swagger UI 就等於有文件」**
7.6.4：springdoc 的預設產出是「欄位清單」，不是文件。
`description: OK`、`example: "string"` 對 consumer 毫無幫助。

**誤區 2：「文件寫好就不會過期」**
7.2.1：文件過期是結構性問題（沒有回饋迴路）。
要靠 CI 的四道檢查（lint / breaking / drift / mock-smoke）。

**誤區 3：「Design-first 比 Code-first 好」**
7.4.2：兩者各有失敗模式。Design-first 沒有驗證機制會漂移，
Code-first 沒有註解會產出爛文件。**混合流程 + 雙向檢查**才是答案。

**誤區 4：「OpenAPI 3.1 比 3.0 好，所以要用 3.1」**
7.3.2：3.1 語法更乾淨，但**部分 SDK generator 支援不完整**。
如果你的主要用途是產生多語言 SDK，3.0.3 更安全。

**誤區 5：「`nullable: true` 在 3.1 還能用」**
7.3.2：3.1 移除了 `nullable`，要用 `type: [string, "null"]`。
寫了 `nullable` 會被忽略（不會報錯，所以更危險）。

**誤區 6：「範例隨便寫就好」**
7.7.2：範例是開發者第一個看的東西。
`"string"` 的範例比沒有範例更糟（它讓人以為那就是格式）。
而且**範例要被測試驗證**，否則會過期。

**誤區 7：「`description` 寫欄位的中文名稱就夠了」**
7.7.1：`description` 要回答 schema 回答不了的問題 ——
會不會變、和其他欄位的關係、有什麼陷阱。

**誤區 8：「正式環境開 Swagger UI 沒關係」**
7.6.1：它會暴露完整的 API 結構與內部端點。要關掉，
契約用 CI 產生後發布到獨立文件站。

**誤區 9：「用 `Pageable` 讓 springdoc 自動產生分頁參數就好」**
7.6.4 ④：產出的 `size` 沒有 `maximum`、`sort` 沒有 pattern 與說明。
用自己的 record 才能完整描述（而且順便解決第 05 章 5.13.2 的坑）。

**誤區 10：「Spectral 規則越多越好」**
7.9.2：突然開啟 25 條 error 規則會讓所有 PR 都紅，
然後大家會學會用 `--skip-rule` 繞過。**要漸進導入**（info → warn → error）。

**誤區 11：「產生 SDK 給每個 consumer 用」**
7.10.3：維護五種語言的 SDK 成本很高。
**給契約，讓廠商自己產生** —— 但要在 CI 驗證契約能被主流 generator 處理。

**誤區 12：「mock server 只是給前端玩的」**
7.8.1：`prism mock --errors` 會**依契約驗證請求**，
讓前端在寫程式時就發現「我漏了必填 header」「我送了錯的 enum 值」。
它是契約的守門員。

---

## 7.13 本章練習

### 練習 1：找出契約的問題

以下是某專案的 OpenAPI 片段。找出所有問題。

```yaml
openapi: 3.0.1
info:
  title: API
  version: 1.0

paths:
  /getOrderList:
    post:
      tags: [order-controller]
      operationId: getOrderList_1
      parameters:
        - name: userId
          in: query
          schema: { type: integer }
      requestBody:
        content:
          '*/*':
            schema:
              type: object
              properties:
                status: { type: integer }
                page: { type: integer }
      responses:
        '200':
          description: OK
          content:
            '*/*':
              schema:
                type: object
                properties:
                  code: { type: integer }
                  msg: { type: string }
                  data:
                    type: array
                    items:
                      type: object
                      properties:
                        ID: { type: integer, format: int64 }
                        amount: { type: number, format: double }
                        createTime: { type: string }
                        passwordHash: { type: string }
                        items: { type: array, nullable: true, items: { type: object } }
```

<details>
<summary>參考解答</summary>

**契約層面（8 個）**

| # | 問題 | 修正 |
|---|---|---|
| 1 | `info.title` 是 "API"（無意義） | `shop-service API` |
| 2 | `info.version` 是 `1.0`（YAML 會解析成**數字** `1.0`，不是字串） | `version: "1.0.0"`（加引號） |
| 3 | 沒有 `info.description` | 加上快速開始、必要 header、Consumer Contract 摘要 |
| 4 | 沒有 `servers` | 列出正式／測試／本機 |
| 5 | 沒有 `security` / `securitySchemes` | 這支端點需要認證嗎？沒說 |
| 6 | `tags: [order-controller]` 用類別名 | `tags: [Orders]` + 在頂層定義 tag 的 description |
| 7 | `operationId: getOrderList_1` | `listOrders`（`_1` 是 springdoc 撞名時的後綴 → 說明有兩個同名方法） |
| 8 | 沒有任何 `description` 或 `examples` | 逐項補上 |

**REST 設計層面（7 個，第 01～02 章）**

| # | 問題 | 修正 |
|---|---|---|
| 9 | URL 有動詞 + 非複數：`/getOrderList` | `GET /orders` |
| 10 | 讀取用 `POST` | 改 `GET` |
| 11 | 分頁參數在 body（`page` 在 requestBody） | 移到 query |
| 12 | 篩選參數在 body（`status`） | 移到 query |
| 13 | `userId` 在 query → IDOR 風險（第 01 章 1.4.1） | 顧客從 token 推導；客服用 `customerId` 且需權限 |
| 14 | 只有 `200`，沒有任何錯誤回應 | 補 `400`/`401`/`403`/`422`/`429`/`500`/`503` |
| 15 | 沒有分頁上限（`page` 沒有 `maximum`，也沒有 `size`） | 加 `Page` / `Size` 參數（含 `maximum`） |

**Content-Type（2 個）**

| # | 問題 | 修正 |
|---|---|---|
| 16 | `'*/*'` 而非 `application/json` | 明確指定（`*/*` 是 springdoc 沒設定 `produces` 時的預設） |
| 17 | 錯誤回應沒有 `application/problem+json` | 第 04 章 4.4.5 |

**DTO 層面（8 個，第 03 章）**

| # | 問題 | 嚴重度 | 修正 |
|---|---|---|---|
| 18 | 🔴 **`passwordHash` 在回應裡** | 極高 | 移除（第 03 章 3.2.2）。Spectral 的 `no-sensitive-field-names` 規則會擋 |
| 19 | 統一包裝層 `{code, msg, data}` | 中 | 直接回資源 + `{items, page}`（第 03 章 3.9） |
| 20 | `ID` 全大寫且是 `integer` | 高 | `orderId`（camelCase）+ `type: string`（第 03 章 3.5.4） |
| 21 | `amount` 是 `number/double` | 🔴 高 | `type: string` + pattern + `currency`（第 03 章 3.5.3） |
| 22 | `createTime` 命名 + 沒有 `format` | 中 | `createdAt` + `format: date-time`（第 03 章 3.6） |
| 23 | `status` 是 `integer`（魔術數字） | 高 | 字串列舉 + `statusLabel` + `statusCategory`（第 03 章 3.10） |
| 24 | 🔴 **`items` 是 `nullable: true`** | 高 | 陣列不可為 `null`（第 03 章 3.7.2） |
| 25 | `items` 的元素是 `type: object`（無結構） | 中 | 定義 `OrderItemResponse` schema |

**可重用性（3 個）**

| # | 問題 | 修正 |
|---|---|---|
| 26 | 所有 schema 都內嵌，沒有 `components` | 抽到 `components/schemas` |
| 27 | 沒有共用的錯誤回應 | `components/responses` |
| 28 | 沒有共用的分頁參數 | `components/parameters` |

**總計 28 個問題。**

**修正後（節錄）**

```yaml
openapi: 3.1.0
info:
  title: shop-service API
  version: "1.0.0"
  description: |
    # shop-service API
    ...（快速開始、必要 header、Consumer Contract 摘要）
servers:
  - url: https://api.shop.example/v1
    description: 正式環境
security:
  - bearerAuth: []
tags:
  - name: Orders
    description: 訂單的建立、查詢、修改

paths:
  /orders:
    get:
      operationId: listOrders
      summary: 查詢訂單列表
      description: |
        查詢訂單列表，支援篩選、排序、搜尋與兩種分頁模式。

        ## 權限與範圍
        | 角色 | 預設範圍 |
        |---|---|
        | `CUSTOMER` | 僅自己的訂單 |
        | `SUPPORT` | 所負責區域的全部訂單 |

        ⚠️ `CUSTOMER` 帶 `customerId` 參數會回 `403`。
      tags: [Orders]
      parameters:
        - $ref: '#/components/parameters/ClientId'
        - $ref: '#/components/parameters/OrderStatusFilter'
        - $ref: '#/components/parameters/Page'
        - $ref: '#/components/parameters/Size'
        - $ref: '#/components/parameters/OrderSort'
      responses:
        '200':
          description: "查詢成功。空結果也回 `200` + `items: []`。"
          content:
            application/json:
              schema: { $ref: '#/components/schemas/OrderListResponse' }
              examples:
                normal: { externalValue: 'https://.../examples/order-list-offset.json' }
                empty:
                  value:
                    items: []
                    page: { mode: OFFSET, number: 0, size: 20, hasMore: false,
                            totalElements: 0, totalElementsRelation: EQUAL }
        '400': { $ref: '#/components/responses/BadRequest' }
        '401': { $ref: '#/components/responses/Unauthorized' }
        '403': { $ref: '#/components/responses/Forbidden' }
        '422': { $ref: '#/components/responses/UnprocessableContent' }
        '429': { $ref: '#/components/responses/TooManyRequests' }
        '500': { $ref: '#/components/responses/InternalServerError' }
        '503': { $ref: '#/components/responses/ServiceUnavailable' }

components:
  schemas:
    OrderSummary:
      type: object
      required: [orderId, orderNumber, status, statusLabel, totalAmount, currency, createdAt]
      properties:
        orderId:
          type: string
          pattern: '^ord_[0-9A-HJKMNP-TV-Z]{26}$'
          description: 訂單系統識別碼。API 路徑請使用此值。
          examples: ["ord_01J5GKQ8Z4W9V2X3Y6N7M8P0QR"]
        orderNumber:
          type: string
          pattern: '^ORD-\d{8}-\d{4}$'
          description: |
            對外訂單編號（給人看的）。客服對答案、包裝標籤、發票使用。
            可用於查詢：`GET /orders?orderNumber=...`
          examples: ["ORD-20260819-0001"]
        status: { $ref: '#/components/schemas/OrderStatus' }
        statusLabel:
          type: string
          description: |
            狀態的顯示文字（依 `Accept-Language` 翻譯）。
            ★ **請優先使用此欄位顯示**，不要自行維護 status 對照表 ——
            新增狀態時你的畫面不會空白。
          examples: ["已付款"]
        statusCategory: { $ref: '#/components/schemas/OrderStatusCategory' }
        totalAmount: { $ref: '#/components/schemas/Money' }
        currency: { $ref: '#/components/schemas/Currency' }
        itemCount: { type: integer, description: 商品項數 }
        createdAt: { type: string, format: date-time, examples: ["2026-08-19T06:12:44Z"] }
        # ⚠️ 沒有 passwordHash、沒有 items（用 itemCount + 獨立端點）
```

**這一題的核心教訓**：

> **這份契約的 28 個問題，有 25 個是「springdoc 沒有註解時的預設產出」造成的。**
>
> 也就是說：**只加 springdoc 依賴、不寫註解，產出的契約會有二十幾個問題。**
> 而其中一個（`passwordHash`）是資安事故。
>
> Spectral 的 `no-sensitive-field-names` 和 `no-example-placeholder` 規則
> 就是為了在 CI 擋住這一類問題。

</details>

### 練習 2：用 `oneOf` 描述多形回應

`POST /orders/{orderId}/payments` 的回應有三種形狀：

1. 付款成功 → `201` + `PaymentResponse`
2. 需要 3DS 驗證 → `202` + 含 `nextAction`（要導向銀行頁面）
3. 冪等重播 → `200` + 首次的 `PaymentResponse`

而 `nextAction` 本身也有三種型別（重導向、顯示 QR code、輪詢等待）。

請寫出 OpenAPI 定義。

<details>
<summary>參考解答</summary>

```yaml
paths:
  /orders/{orderId}/payments:
    post:
      operationId: createPayment
      summary: 對訂單付款
      description: |
        對訂單建立一筆付款。

        ## 三種可能的成功回應

        | 狀態碼 | 情況 | 客戶端該做什麼 |
        |---|---|---|
        | `201` | 付款直接成功 | 顯示成功，導向訂單詳情 |
        | `202` | **需要額外驗證**（3DS、QR code） | 依 `nextAction.type` 處理，完成後輪詢付款狀態 |
        | `200` | 冪等重播（此 key 已處理過） | 同 `201`，但不要重複顯示「付款成功」動畫 |

        ⚠️ **務必處理 `202`** —— 台灣的信用卡交易大多需要 3DS 驗證，
        這是最常見的路徑，不是例外情況。

        ## 付款失敗的狀態碼

        | 狀態碼 | 情況 |
        |---|---|
        | `402` | 卡片被銀行拒絕（含 `declineCode`） |
        | `409` | 訂單已付款、狀態不允許、已有進行中的付款 |
        | `422` | 卡片資料格式錯誤、金額不符 |
        | `504` | 金流商超時 —— **結果未知**，請查詢狀態，不要重試 |
      tags: [Order Actions]
      parameters:
        - $ref: '#/components/parameters/OrderId'
        - $ref: '#/components/parameters/IdempotencyKey'
        - $ref: '#/components/parameters/ClientId'
        - $ref: '#/components/parameters/ClientVersion'
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/CreatePaymentRequest' }
            examples:
              creditCard:
                summary: 信用卡
                value: { method: CREDIT_CARD, cardToken: "tok_visa_4242", amount: "1280.50" }
              atmTransfer:
                summary: ATM 轉帳
                value: { method: ATM_TRANSFER, amount: "1280.50" }

      responses:
        '201':
          description: 付款成功（無需額外驗證）
          headers:
            Location:
              description: 新建立付款的 URI
              schema: { type: string, format: uri-reference }
              example: /v1/payments/pay_01J5GKQ8Z4W9V2X3Y6N7M8P0QR
          content:
            application/json:
              schema: { $ref: '#/components/schemas/PaymentSucceededResponse' }
              examples:
                succeeded:
                  value:
                    paymentId: pay_01J5GKQ8Z4W9V2X3Y6N7M8P0QR
                    status: SUCCEEDED
                    statusLabel: 付款成功
                    method: CREDIT_CARD
                    methodLabel: 信用卡
                    cardBrand: VISA
                    cardLast4: "4242"
                    amount: "1280.50"
                    currency: TWD
                    paidAt: "2026-08-19T06:14:58Z"
                    orderStatus: PAID

        '202':
          description: |
            已接受，但**需要額外驗證**才能完成付款。

            請依 `nextAction.type` 處理：
            - `REDIRECT` → 導向 `nextAction.redirectUrl`（3DS 驗證頁）
            - `DISPLAY_QR_CODE` → 顯示 `nextAction.qrCodeImageUrl` 給使用者掃描
            - `AWAIT_EXTERNAL` → 顯示等待畫面（例如 ATM 轉帳的匯款資訊）

            完成後請輪詢 `nextAction.statusCheckUrl` 確認最終結果
            （不要假設驗證完成就等於付款成功）。
          headers:
            Location:
              description: 付款資源的 URI（用於輪詢狀態）
              schema: { type: string, format: uri-reference }
            Retry-After:
              description: 建議的輪詢間隔（秒）
              schema: { type: integer }
              example: 3
          content:
            application/json:
              schema: { $ref: '#/components/schemas/PaymentActionRequiredResponse' }
              examples:
                threeDs:
                  summary: 3DS 驗證（信用卡最常見）
                  value:
                    paymentId: pay_01J5GKQ8Z4W9V2X3Y6N7M8P0QR
                    status: REQUIRES_ACTION
                    statusLabel: 待完成驗證
                    method: CREDIT_CARD
                    amount: "1280.50"
                    currency: TWD
                    nextAction:
                      type: REDIRECT
                      redirectUrl: "https://3ds.bank.example/verify?token=abc123"
                      returnUrl: "https://shop.example/orders/ord_01J5GK/payment-return"
                      expiresAt: "2026-08-19T06:29:58Z"
                      statusCheckUrl: "/v1/payments/pay_01J5GKQ8Z4W9V2X3Y6N7M8P0QR"
                      pollIntervalSeconds: 3
                convenienceStore:
                  summary: 超商代碼繳費
                  value:
                    paymentId: pay_01J5GL...
                    status: REQUIRES_ACTION
                    statusLabel: 待繳費
                    method: CONVENIENCE_STORE
                    amount: "1280.50"
                    currency: TWD
                    nextAction:
                      type: AWAIT_EXTERNAL
                      instructions: 請於 3 日內至 7-ELEVEN ibon 輸入繳費代碼
                      referenceCode: "LLA1234567890"
                      expiresAt: "2026-08-22T23:59:59Z"
                      statusCheckUrl: "/v1/payments/pay_01J5GL..."
                      pollIntervalSeconds: 60
                linePay:
                  summary: LINE Pay QR code
                  value:
                    paymentId: pay_01J5GM...
                    status: REQUIRES_ACTION
                    statusLabel: 待掃碼付款
                    method: LINE_PAY
                    amount: "1280.50"
                    currency: TWD
                    nextAction:
                      type: DISPLAY_QR_CODE
                      qrCodeImageUrl: "https://cdn.shop.example/qr/pay_01J5GM.png"
                      qrCodeContent: "https://pay.line.me/payments/..."
                      expiresAt: "2026-08-19T06:24:58Z"
                      statusCheckUrl: "/v1/payments/pay_01J5GM..."
                      pollIntervalSeconds: 2

        '200':
          description: |
            **冪等重播** —— 此 `Idempotency-Key` 已處理過，回傳首次的結果。

            ⚠️ 回應的形狀與首次相同（可能是 `PaymentSucceededResponse`
            或 `PaymentActionRequiredResponse`），請用 `status` 欄位判斷。
          headers:
            Idempotent-Replay:
              schema: { type: boolean }
              example: true
            Location:
              schema: { type: string, format: uri-reference }
          content:
            application/json:
              schema: { $ref: '#/components/schemas/PaymentResponse' }

        '402':
          description: |
            付款被拒絕（卡片問題）。**請求本身正確**，是外部系統拒絕。

            可能的 `code`：`INSUFFICIENT_FUNDS`、`CARD_DECLINED`、
            `CARD_LOST_OR_STOLEN`、`EXCEEDS_CREDIT_LIMIT`、`PAYMENT_DECLINED`（風控）。

            ⚠️ `retryable: false` —— 重試同一張卡不會成功，請引導使用者更換付款方式。
          content:
            application/problem+json:
              schema: { $ref: '#/components/schemas/PaymentDeclinedProblem' }
              examples:
                insufficientFunds:
                  value:
                    type: https://api.shop.example/problems/card-declined
                    title: 卡片被拒絕
                    status: 402
                    code: INSUFFICIENT_FUNDS
                    userMessage: 您的卡片餘額不足，請改用其他付款方式。
                    declineCode: insufficient_funds
                    cardLast4: "4242"
                    retryable: false
                    retryStrategy: MODIFY_REQUEST
                    alternativeAction:
                      code: CHANGE_PAYMENT_METHOD
                      label: 更換付款方式
                      supportedMethods: [CREDIT_CARD, ATM_TRANSFER, CONVENIENCE_STORE, LINE_PAY]
                    traceId: 4f2c8a1e9b7d3f60

        '409': { $ref: '#/components/responses/Conflict' }
        '422': { $ref: '#/components/responses/UnprocessableContent' }
        '429': { $ref: '#/components/responses/TooManyRequests' }
        '500': { $ref: '#/components/responses/InternalServerError' }
        '503': { $ref: '#/components/responses/ServiceUnavailable' }
        '504':
          description: |
            金流商超時 —— **付款結果未知**（可能成功也可能失敗）。

            ⚠️ **不要重試**。請輪詢 `statusCheckUrl` 確認實際結果。
            回應的 `retryStrategy` 為 `CHECK_STATUS`。
          content:
            application/problem+json:
              schema: { $ref: '#/components/schemas/Problem' }
              examples:
                outcomeUnknown:
                  value:
                    type: https://api.shop.example/problems/payment-outcome-unknown
                    title: 付款結果未知
                    status: 504
                    code: PAYMENT_OUTCOME_UNKNOWN
                    userMessage: 付款正在處理中，請稍候並查看訂單狀態。請勿重複付款。
                    retryable: false
                    retryStrategy: CHECK_STATUS
                    statusCheckUrl: /v1/orders/ord_01J5GK/payments
                    recommendedCheckAfterSeconds: 10
                    traceId: 4f2c8a1e9b7d3f60

components:
  schemas:
    # ── 付款狀態 ────────────────────────────────────
    PaymentStatus:
      type: string
      enum: [PENDING, REQUIRES_ACTION, PROCESSING, SUCCEEDED, FAILED, REFUNDED, PARTIALLY_REFUNDED]
      x-extensible-enum: true
      description: |
        付款狀態。

        ⚠️ 此列舉會持續新增值。請用 `statusLabel` 顯示、
        `switch` 必須有 `default`（Consumer Contract §要求 2）。

    # ── 回應的共同部分 ──────────────────────────────
    PaymentBase:
      type: object
      required: [paymentId, status, statusLabel, method, methodLabel, amount, currency]
      properties:
        paymentId:
          type: string
          pattern: '^pay_[0-9A-HJKMNP-TV-Z]{26}$'
        status: { $ref: '#/components/schemas/PaymentStatus' }
        statusLabel: { type: string }
        method: { $ref: '#/components/schemas/PaymentMethod' }
        methodLabel: { type: string }
        amount: { $ref: '#/components/schemas/Money' }
        currency: { $ref: '#/components/schemas/Currency' }
        cardBrand: { type: [string, "null"] }
        cardLast4: { type: [string, "null"], pattern: '^\d{4}$' }
        createdAt: { type: string, format: date-time }

    # ── 成功 ────────────────────────────────────────
    PaymentSucceededResponse:
      allOf:
        - $ref: '#/components/schemas/PaymentBase'
        - type: object
          required: [status, paidAt, orderStatus]
          properties:
            status:
              const: SUCCEEDED
            paidAt: { type: string, format: date-time }
            orderStatus:
              $ref: '#/components/schemas/OrderStatus'
              description: 付款後訂單的新狀態（通常是 `PAID`）
            nextAction:
              const: null
              description: 成功時此欄位為 `null`

    # ── 需要額外動作 ────────────────────────────────
    PaymentActionRequiredResponse:
      allOf:
        - $ref: '#/components/schemas/PaymentBase'
        - type: object
          required: [status, nextAction]
          properties:
            status:
              const: REQUIRES_ACTION
            nextAction: { $ref: '#/components/schemas/PaymentNextAction' }

    # ── 兩種回應的聯集（用於 200 冪等重播）──────────
    PaymentResponse:
      oneOf:
        - $ref: '#/components/schemas/PaymentSucceededResponse'
        - $ref: '#/components/schemas/PaymentActionRequiredResponse'
      discriminator:
        propertyName: status
        mapping:
          SUCCEEDED:       '#/components/schemas/PaymentSucceededResponse'
          REQUIRES_ACTION: '#/components/schemas/PaymentActionRequiredResponse'
      description: |
        付款回應。請先檢查 `status` 欄位：
        - `SUCCEEDED` → 付款完成
        - `REQUIRES_ACTION` → 需依 `nextAction` 處理

    # ── nextAction 的三種型別 ───────────────────────
    NextActionBase:
      type: object
      required: [type, expiresAt, statusCheckUrl, pollIntervalSeconds]
      properties:
        type:
          type: string
          enum: [REDIRECT, DISPLAY_QR_CODE, AWAIT_EXTERNAL]
          x-extensible-enum: true
          description: |
            ⚠️ 此列舉會新增值（未來可能支援生物辨識、App 內驗證等）。
            遇到未知的 `type` 請顯示 `instructions`（若有）並導向
            `statusCheckUrl` 讓使用者在網頁完成，**不要當作錯誤**。
        expiresAt:
          type: string
          format: date-time
          description: 此動作的有效期限。逾期後付款會自動失敗。
        statusCheckUrl:
          type: string
          format: uri-reference
          description: 輪詢付款最終狀態的 URI。
        pollIntervalSeconds:
          type: integer
          description: 建議的輪詢間隔。
        instructions:
          type: [string, "null"]
          description: 給使用者看的操作說明（各 `type` 皆可能提供）。

    RedirectAction:
      allOf:
        - $ref: '#/components/schemas/NextActionBase'
        - type: object
          required: [type, redirectUrl, returnUrl]
          properties:
            type: { const: REDIRECT }
            redirectUrl:
              type: string
              format: uri
              description: |
                導向此 URL 完成驗證（通常是發卡行的 3DS 頁面）。

                ⚠️ 建議用**整頁導向**而非 iframe —— 部分銀行會拒絕在 iframe 中顯示
                （`X-Frame-Options: DENY`）。
            returnUrl:
              type: string
              format: uri
              description: 驗證完成後銀行會導回此 URL（由我們預先設定）。

    DisplayQrCodeAction:
      allOf:
        - $ref: '#/components/schemas/NextActionBase'
        - type: object
          required: [type, qrCodeImageUrl, qrCodeContent]
          properties:
            type: { const: DISPLAY_QR_CODE }
            qrCodeImageUrl:
              type: string
              format: uri
              description: QR code 圖片（PNG，512×512）。
            qrCodeContent:
              type: string
              description: |
                QR code 的內容。**行動裝置上請提供「直接開啟」的按鈕**
                （使用者在手機上無法用同一台手機掃自己的畫面）。

    AwaitExternalAction:
      allOf:
        - $ref: '#/components/schemas/NextActionBase'
        - type: object
          required: [type, referenceCode]
          properties:
            type: { const: AWAIT_EXTERNAL }
            referenceCode:
              type: string
              description: 繳費代碼／虛擬帳號。請以易於抄寫的格式顯示（分組、大字體、可複製）。
            bankCode: { type: [string, "null"] }
            virtualAccount: { type: [string, "null"] }

    PaymentNextAction:
      oneOf:
        - $ref: '#/components/schemas/RedirectAction'
        - $ref: '#/components/schemas/DisplayQrCodeAction'
        - $ref: '#/components/schemas/AwaitExternalAction'
      discriminator:
        propertyName: type
        mapping:
          REDIRECT:        '#/components/schemas/RedirectAction'
          DISPLAY_QR_CODE: '#/components/schemas/DisplayQrCodeAction'
          AWAIT_EXTERNAL:  '#/components/schemas/AwaitExternalAction'
```

**客戶端的 TypeScript（由契約產生）**

```typescript
type PaymentResponse =
  | { status: 'SUCCEEDED'; paidAt: string; orderStatus: OrderStatus; nextAction: null; ... }
  | { status: 'REQUIRES_ACTION'; nextAction: PaymentNextAction; ... };

type PaymentNextAction =
  | { type: 'REDIRECT'; redirectUrl: string; returnUrl: string; ... }
  | { type: 'DISPLAY_QR_CODE'; qrCodeImageUrl: string; qrCodeContent: string; ... }
  | { type: 'AWAIT_EXTERNAL'; referenceCode: string; bankCode: string | null; ... };

async function pay(orderId: string, req: CreatePaymentRequest) {
  const res = await api.POST('/orders/{orderId}/payments', {
    params: { path: { orderId } },
    headers: { 'Idempotency-Key': crypto.randomUUID() },
    body: req,
  });

  if (res.error) return handleApiError(res.error);

  // ★ discriminated union → 型別安全的分支
  switch (res.data.status) {
    case 'SUCCEEDED':
      return showSuccess(res.data.paidAt);

    case 'REQUIRES_ACTION':
      switch (res.data.nextAction.type) {
        case 'REDIRECT':
          return window.location.assign(res.data.nextAction.redirectUrl);
        case 'DISPLAY_QR_CODE':
          return showQrCode(res.data.nextAction.qrCodeImageUrl,
                            res.data.nextAction.qrCodeContent);
        case 'AWAIT_EXTERNAL':
          return showPaymentCode(res.data.nextAction.referenceCode,
                                 res.data.nextAction.expiresAt);
        default:
          // ★ 未知的 nextAction type（Consumer Contract §要求 2）
          return showGenericWaitingScreen(res.data.nextAction);
      }

    default:
      // ★ 未知的 status
      return showGenericStatus(res.data);
  }
}
```

**這題的五個設計要點**

| # | 要點 | 說明 |
|---|---|---|
| 1 | **用 `allOf` 抽出共同部分** | `PaymentBase` 避免三個 schema 重複 15 個欄位 |
| 2 | **用 `const` 固定判別欄位的值** | `status: { const: SUCCEEDED }` 讓 discriminator 生效 |
| 3 | **兩層 `oneOf`** | 外層是回應型別，內層是 `nextAction` 型別 |
| 4 | **`description` 寫「客戶端該做什麼」** | 「⚠️ 建議整頁導向而非 iframe」這種資訊只有寫在契約裡才會被讀到 |
| 5 | **每種 `nextAction` 都有 `statusCheckUrl` + `pollIntervalSeconds`** | 放在 `NextActionBase` → 保證所有型別都有 → 客戶端可以統一處理輪詢 |

**⚠️ 一個容易漏掉的重點**：
`202` 的 `description` 特別強調「務必處理，這不是例外情況」——
因為台灣的信用卡交易大多需要 3DS。

**如果不強調，很多前端會只實作 `201` 的路徑，然後在正式環境發現「大部分付款都沒反應」。**
這種「契約裡有寫但沒被讀到」的問題，要靠**在 description 裡明確標示重要性**來解決。

</details>

### 練習 3：設計 Spectral 規則

你的 team style guide 有以下規則。請寫出對應的 Spectral 規則。

```
1. 所有 POST/PUT/PATCH/DELETE 端點都必須要求 X-Client-Id header
2. 所有涉及金錢的 POST 端點（路徑含 payments/refunds/orders）必須要求 Idempotency-Key
3. 所有回集合的 GET 端點的 200 回應必須包含 page 欄位
4. 所有 PATCH 端點必須要求 If-Match header
5. 任何 schema 的屬性名不可以是 data、result、info、object、value（太籠統）
6. 所有 date-time 欄位的名稱必須以 At 結尾
7. 標記 deprecated 的欄位必須在 description 提供替代欄位名
```

<details>
<summary>參考解答</summary>

```yaml
# .spectral.yaml
extends: ["spectral:oas"]

functions:
  - requiresHeader
  - hasReplacementField
functionsDir: "./spectral-functions"

rules:
  # ── 1. 寫入操作必須要求 X-Client-Id ────────────────
  write-must-require-client-id:
    description: |
      所有寫入操作必須要求 X-Client-Id header。
      這讓我們能在棄用時精準通知 consumer（第 06 章 6.8.3）。
    severity: error
    given: "$.paths[*][post,put,patch,delete]"
    then:
      function: requiresHeader
      functionOptions:
        headerName: X-Client-Id
        parameterRef: "#/components/parameters/ClientId"

  # ── 2. 金錢相關的 POST 必須要求 Idempotency-Key ────
  money-post-must-require-idempotency-key:
    description: |
      涉及金錢的 POST 端點必須要求 Idempotency-Key（第 02 章 2.2.4）。
      沒有冪等鍵的話，網路重試會造成重複扣款。
    severity: error
    given: "$.paths[?(@property.match(/(payments|refunds|orders|charges|payouts)/))].post"
    then:
      function: requiresHeader
      functionOptions:
        headerName: Idempotency-Key
        parameterRef: "#/components/parameters/IdempotencyKey"
        mustBeRequired: true

  # ── 3. 集合端點的 200 必須有 page 欄位 ─────────────
  # 步驟 a：先確認 schema 有 items 陣列的端點
  list-response-must-have-page:
    description: |
      回傳集合的端點必須在 200 回應中包含 page 欄位（第 05 章 5.2）。
      沒有分頁資訊，客戶端只能用 items.length 猜有沒有下一頁。
    severity: error
    given: >-
      $.paths[?(!@property.match(/\{[^}]+\}$/))].get.responses.200.content['application/json'].schema
    then:
      function: schema
      functionOptions:
        schema:
          type: object
          oneOf:
            # 直接定義：必須有 items 與 page
            - required: [required]
              properties:
                required:
                  type: array
                  allOf:
                    - contains: { const: items }
                    - contains: { const: page }
            # 或是 $ref（由另一條規則檢查被 ref 的 schema）
            - required: ["$ref"]

  # 步驟 b：檢查所有名為 *ListResponse 的 schema
  list-response-schema-shape:
    description: 名為 XxxListResponse 的 schema 必須有 items 與 page 欄位
    severity: error
    given: "$.components.schemas[?(@property.match(/ListResponse$/))]"
    then:
      - field: required
        function: schema
        functionOptions:
          schema:
            type: array
            allOf:
              - contains: { const: items }
              - contains: { const: page }
      - field: properties.page
        function: truthy
      - field: properties.items
        function: truthy

  # ── 4. PATCH 必須要求 If-Match ─────────────────────
  patch-must-require-if-match:
    description: |
      所有 PATCH 端點必須要求 If-Match header（第 02 章 2.11.3）。
      沒有樂觀鎖，兩個人同時編輯會互相覆寫。

      若某個資源確實不需要（例如只有自己會改的 /me），
      請在該端點加上 x-no-optimistic-lock: true 並在 PR 說明理由。
    severity: error
    given: "$.paths[*].patch"
    then:
      function: requiresHeader
      functionOptions:
        headerName: If-Match
        parameterRef: "#/components/parameters/IfMatch"
        mustBeRequired: true
        exemptionExtension: x-no-optimistic-lock

  # ── 5. 禁止籠統的屬性名 ────────────────────────────
  no-vague-property-names:
    description: |
      屬性名不可為 data / result / info / object / value / content / payload。
      這些名稱不傳達任何語意，consumer 無法從名稱理解內容。
      請用具體的名稱（例如 items、order、amounts）。
    severity: error
    given: "$.components.schemas..properties[*]~"
    then:
      function: pattern
      functionOptions:
        notMatch: "^(data|result|results|info|object|value|content|payload|body|response|res|obj|tmp|temp)$"

  # ── 6. date-time 欄位必須以 At 結尾 ────────────────
  date-time-property-must-end-with-at:
    description: |
      date-time 型別的欄位名必須以 At 結尾（createdAt、expiresAt）。
      這讓 consumer 從名稱就知道「這是時間點，需要做時區轉換」（第 03 章 3.5.2）。

      若是純日期（format: date），請用 Date 或 On 結尾（birthDate、effectiveOn）。
    severity: error
    given: "$.components.schemas..properties[?(@.format === 'date-time')]~"
    then:
      function: pattern
      functionOptions:
        match: "At$"

  # 反向檢查：以 At 結尾的欄位必須是 date-time
  at-suffix-must-be-date-time:
    description: "以 At 結尾的欄位必須是 format: date-time（避免誤導）"
    severity: error
    given: "$.components.schemas..properties[?(@property.match(/At$/))]"
    then:
      field: format
      function: pattern
      functionOptions:
        match: "^date-time$"

  # 純日期欄位的命名
  date-property-naming:
    description: "format: date 的欄位名必須以 Date 或 On 結尾"
    severity: warn
    given: "$.components.schemas..properties[?(@.format === 'date')]~"
    then:
      function: pattern
      functionOptions:
        match: "(Date|On)$"

  # ── 7. deprecated 必須提供替代方案 ─────────────────
  deprecated-must-name-replacement:
    description: |
      標記 deprecated 的欄位／端點必須在 description 中明確提供替代方案與 Sunset 日期
      （第 06 章 6.8.1）。

      格式要求：description 必須包含
        - 「請改用 `<替代欄位名>`」或「Use `<replacement>` instead」
        - 「Sunset: YYYY-MM-DD」
    severity: error
    given: "$..[?(@.deprecated === true)]"
    then:
      function: hasReplacementField
```

**自訂函式 1：`requiresHeader`**

```javascript
// spectral-functions/requiresHeader.js
export default function requiresHeader(operation, options, context) {
  const { headerName, parameterRef, mustBeRequired = false, exemptionExtension } = options;

  // 豁免標記
  if (exemptionExtension && operation[exemptionExtension] === true) {
    return [];
  }

  const params = operation.parameters ?? [];

  const found = params.some(p => {
    // 直接定義
    if (p.name === headerName && p.in === 'header') {
      return !mustBeRequired || p.required === true;
    }
    // 透過 $ref
    if (p.$ref === parameterRef) {
      // ⚠️ 這裡假設被 ref 的 parameter 定義正確
      //    （另有一條規則檢查 components.parameters 的 required）
      return true;
    }
    return false;
  });

  if (found) return [];

  return [{
    message:
      `此操作必須要求 ${headerName} header。` +
      `請加入 { $ref: "${parameterRef}" } 到 parameters` +
      (exemptionExtension
        ? `，或若確實不需要，加上 ${exemptionExtension}: true 並在 PR 說明理由。`
        : '。'),
    path: [...context.path, 'parameters'],
  }];
}
```

**自訂函式 2：`hasReplacementField`**

```javascript
// spectral-functions/hasReplacementField.js
const REPLACEMENT_PATTERNS = [
  /請改用\s*`[^`]+`/,
  /use\s+`[^`]+`\s+instead/i,
  /replaced\s+by\s+`[^`]+`/i,
  /替代[方案欄位]*[：:]\s*`[^`]+`/,
];

const SUNSET_PATTERN = /sunset[：:]?\s*\d{4}-\d{2}-\d{2}/i;

export default function hasReplacementField(target, _options, context) {
  const desc = target.description ?? '';
  const results = [];

  if (!REPLACEMENT_PATTERNS.some(p => p.test(desc))) {
    results.push({
      message:
        '標記 deprecated 的項目必須在 description 中明確提供替代方案。' +
        '請加入「請改用 `<替代欄位名>`」或「Use `<replacement>` instead」。',
      path: [...context.path, 'description'],
    });
  }

  if (!SUNSET_PATTERN.test(desc)) {
    results.push({
      message:
        '標記 deprecated 的項目必須在 description 中提供 Sunset 日期。' +
        '請加入「Sunset: YYYY-MM-DD」。',
      path: [...context.path, 'description'],
    });
  }

  return results;
}
```

**驗證這些規則有效（★ 很重要）**

**Spectral 規則本身也需要測試** —— 否則你不知道規則真的會擋住問題。

```yaml
# api/__tests__/spectral-fixtures/bad-missing-idempotency-key.yaml
openapi: 3.1.0
info: { title: Test, version: "1.0.0" }
paths:
  /orders/{orderId}/payments:
    post:
      operationId: createPayment
      parameters:
        - { name: X-Client-Id, in: header, required: true, schema: { type: string } }
        # ⚠️ 故意漏掉 Idempotency-Key
      responses: { '201': { description: Created } }
```

```javascript
// api/__tests__/spectral.test.mjs
import { Spectral } from '@stoplight/spectral-core';
import { bundleAndLoadRuleset } from '@stoplight/spectral-ruleset-bundler/with-loader';
import { readFileSync, readdirSync } from 'node:fs';
import { test, expect } from 'vitest';

const spectral = new Spectral();
spectral.setRuleset(await bundleAndLoadRuleset('.spectral.yaml', { fs, fetch }));

// 每個 bad-*.yaml 必須觸發對應的規則
for (const file of readdirSync('api/__tests__/spectral-fixtures')) {
  const expectedRule = file.replace(/^bad-/, '').replace(/\.yaml$/, '');

  test(`規則 ${expectedRule} 應該擋住 ${file}`, async () => {
    const results = await spectral.run(readFileSync(`api/__tests__/spectral-fixtures/${file}`, 'utf8'));
    const codes = results.map(r => r.code);
    expect(codes).toContain(ruleNameFor(expectedRule));
  });
}

// 正確的契約不應該有任何 error
test('實際的契約沒有 error 級別的違規', async () => {
  const results = await spectral.run(readFileSync('dist/orders-api.yaml', 'utf8'));
  const errors = results.filter(r => r.severity === 0);
  expect(errors, JSON.stringify(errors, null, 2)).toHaveLength(0);
});
```

**這一題的三個核心教訓**

| # | 教訓 |
|---|---|
| 1 | **style guide 只要能寫成規則，就應該寫成規則。** 靠人在 code review 檢查 7 條規則 × 每週 10 個 PR = 一定會漏 |
| 2 | **每條規則都要有「豁免機制」**（`x-no-optimistic-lock`）。沒有豁免機制的規則，遇到合理的例外時大家會直接關掉整條規則 |
| 3 | **規則的錯誤訊息要說「怎麼修」**，而不只是「你錯了」。`「請加入 { $ref: ... }，或若確實不需要，加上 x-no-optimistic-lock: true 並在 PR 說明理由」` 比 `「missing header」` 有用得多 |

**額外洞察：反向規則**

注意第 6 條我寫了**兩個方向**的規則：

```
date-time 欄位 → 名稱必須以 At 結尾
以 At 結尾的欄位 → 必須是 date-time
```

**只有單向會有漏洞**：

```yaml
# 只有第一條規則時，這個可以通過
expiresAt:
  type: string        # ← 沒有 format
  description: 過期時間
# → consumer 不知道格式，可能收到 "2026-08-19 06:12:44"（非 ISO）
```

**命名慣例的規則通常都要雙向檢查。**

</details>

### 練習 4：設計契約先行的協作流程

你的團隊：3 個後端、2 個前端、1 個 iOS、1 個 PM，還要對接 2 家廠商。
目前的流程是「後端做完 → 給 Postman collection → 前端開始做」。

設計一個契約先行的流程，並說明遇到的阻力該怎麼處理。

<details>
<summary>參考解答</summary>

**現況的問題診斷（先量測，不要直接改流程）**

```
問卷／訪談要問的問題：
□ 前端平均等後端多久才能開始？                    → 假設答案：5～8 天
□ 整合階段平均花多久？                            → 假設答案：2～4 天
□ 整合時發現的問題有幾成是「設計不對」而非「bug」？ → 假設答案：6 成
□ 前端一週問後端幾次「這個欄位是什麼意思」？        → 假設答案：15～20 次
□ 廠商對接平均要來回幾次 email？                   → 假設答案：20+ 次
□ Postman collection 多久沒更新？                  → 假設答案：3 週
```

**用這些數字算出成本**（說服管理層需要數字）：

```
每個功能：
  前端閒置 6 天 × 2 人 = 12 人天
  整合返工 3 天 × 3 人 = 9 人天
  溝通成本 15 次 × 20 分鐘 × 2 人 = 10 人時
  ────────────────────────────────
  每個功能約浪費 22 人天

一季 6 個功能 → 132 人天 ≈ 6 個人月
```

---

**新流程設計**

```
═══ 階段 0：一次性準備（2 週） ═══════════════════════════

W1  □ 把現有的 API 寫成 orders-api.yaml
       - 不要一次寫完 83 條！先寫 3 條最常用的（訂單列表、詳情、建立）
       - ★ 用 springdoc 產生初版，再手動補 description 與 examples
    □ 建立 CI：Spectral lint（先全部 severity: info）
    □ 部署 mock server（Prism）到 https://mock.shop.example

W2  □ 一場 1 小時的內部分享：
       - 為什麼要這樣做（用上面算出的 132 人天）
       - 怎麼讀 OpenAPI（給前端）
       - 怎麼寫 OpenAPI（給後端）
       - 怎麼用 mock（給前端與 iOS）
    □ 挑一個「小而完整」的新功能做試點

═══ 階段 1：試點（1 個功能） ════════════════════════════

Day 1  【需求討論】PM + 1 後端 + 1 前端 + iOS（30 分鐘）
       產出：需要哪些端點、大致的資料形狀（白板照片就好）

Day 1  【後端寫契約】1 人 × 2 小時
       - 在 api/orders-api.yaml 新增端點
       - 必須有：description（含權限矩陣）、examples（成功 + 至少 2 個錯誤）
       - 開 PR，標題加 [contract]

Day 2  【契約 Review】★ 這是新流程的核心
       參與者：PM、前端 × 2、iOS、後端 × 3、（若涉及）廠商
       形式：30 分鐘會議 + PR 留言
       檢查清單：
         前端／iOS：
           □ 這些欄位夠我畫完整個畫面嗎？（避免 N+1 API）
           □ 錯誤情境我知道怎麼顯示嗎？
           □ 有沒有欄位我需要但沒有？
           □ 列舉值我要怎麼顯示？有 statusLabel 嗎？
         後端：
           □ 這些欄位我拿得到嗎？效能可以嗎？
           □ 有沒有欄位不該暴露？
         PM：
           □ 這符合需求嗎？
           □ 有沒有遺漏的情境？
         廠商（若涉及）：
           □ 我的系統結構能處理這個格式嗎？

Day 2  【合併】PR merge → CI 自動：
       - lint 通過
       - 打包成 bundled.yaml
       - 部署 mock server
       - 發布文件到 docs 站
       - Slack 通知：「契約已更新，mock 可用：https://mock.shop.example」

Day 3-7 【並行開發】
       前端：VITE_API_BASE_URL=https://mock.shop.example/v1 開始寫
             測試用 MSW + api/examples/ 的範例
       iOS： 同上（用 mock 的 URL）
       後端：實作 + 寫「用契約驗證回應」的測試（第 09 章 9.4）

Day 8  【整合】後端部署 staging → 前端切換 base URL
       ★ 驗收標準：切換後「不需要改任何前端程式碼」
       若需要改 → 開 retro，找出為什麼契約沒被遵守

Day 9  【驗收 + Retro】
       量測：前端閒置幾天？整合花幾天？改了幾行前端程式碼？
       和舊流程的數字對照

═══ 階段 2：推廣（2～3 個月） ═══════════════════════════

□ 試點成功 → 所有新功能都走這個流程
□ Spectral 規則逐步從 info → warn → error（7.9.2）
□ 逐步把既有的 83 條端點補進契約（每個 sprint 補 5～10 條）
□ 加入 drift 檢查（7.4.4）確保契約與實作一致
□ 廠商對接改成「先給契約 + mock，再給正式環境」

═══ 階段 3：常態化 ══════════════════════════════════════

□ 契約變更是 PR review 的一部分（不是另外的流程）
□ 新人 onboarding 的第一件事：讀 orders-api.yaml
□ 每季檢視：Spectral 規則要不要增減
```

---

**六種阻力與處理**

**阻力 1：後端「多做一件事」**

```
說法：「我還要另外寫 YAML？程式碼裡寫註解不就好了？」
```

**處理**：

| 手段 | 說明 |
|---|---|
| **用數字說服** | 「你現在平均花 15 次回答前端的問題，寫契約要 2 小時，但省下那 15 次」 |
| **降低門檻** | 提供 template + 用 springdoc 產生初版再手改（不是從零寫） |
| **讓好處立即可見** | 試點時特別記錄「前端這次問了幾次問題」（通常從 15 降到 2～3） |
| ⚠️ **不要說「這是最佳實踐」** | 這對工程師沒有說服力。要說「這會讓你少被打擾」 |

**阻力 2：前端不會讀 OpenAPI**

```
說法：「這個 YAML 我看不懂，能不能給我 Postman？」
```

**處理**：

| 手段 | 說明 |
|---|---|
| **不要讓他們讀 YAML** | 給他們 Redoc 產生的文件站（7.11.1） |
| **給他們 mock server** | 「你不用讀，直接打 mock 看回應」 |
| **給他們型別** | `openapi-typescript` 產生的 `.d.ts` → IDE 自動完成 |
| **保留 Postman** | 從契約產生 Postman collection（`openapi-to-postman`）—— 不要剝奪他們熟悉的工具 |

**最後一項很重要**：**不要用「更好的工具」逼人放棄「熟悉的工具」。**
從契約產生 Postman collection，兩邊都滿足。

**阻力 3：「Day 2 的 review 會議是多開一個會」**

```
說法：「我們已經太多會了」
```

**處理**：

| 手段 | 說明 |
|---|---|
| **時間盒 30 分鐘** | 超時就在 PR 留言繼續 |
| **取代而非新增** | 它取代了「整合階段的三次協調會」 |
| **不是所有變更都要開會** | 新增選填欄位 → PR 留言就好；新端點才開會 |
| **異步優先** | 契約 PR 開了 24 小時，有意見的人留言；只有意見衝突時才開會 |

**阻力 4：契約和實作漂移**

```
症狀：三個月後契約和實際差了 20%，大家又不相信契約了
```

**處理**：**這是最需要「機制」而非「紀律」的地方**。

| 機制 | 說明 |
|---|---|
| drift 檢查（7.4.4） | CI 比對 springdoc 產出 vs 手寫契約 |
| 契約驗證測試（第 09 章 9.4） | 用契約驗證實際回應 |
| **兩者都在 CI，都會擋 PR** | 靠紀律一定會漂移，靠 CI 才不會 |

**阻力 5：廠商不配合**

```
說法：「我們習慣拿 Word 規格書」
```

**處理**：

| 手段 | 說明 |
|---|---|
| **兩者都給** | Redoc 產生的 HTML 可以列印成 PDF —— 「這就是你們的規格書」 |
| **強調 mock 的好處** | 「你們可以在我們寫完之前就開始測試」（這對廠商是實質好處） |
| **不要求他們用工具** | 他們只要拿到文件和 mock URL，不需要碰 YAML |

**阻力 6：「舊的 83 條端點怎麼辦」**

```
說法：「補完全部要花好久」
```

**處理**：

| 原則 | 說明 |
|---|---|
| **不要一次補完** | 這是最常見的失敗原因（花三週補契約，然後沒人維護） |
| **新功能強制，舊功能機會主義** | 動到哪一條就補那一條 |
| **用 springdoc 產生「不完整但可用」的版本** | 有欄位清單比什麼都沒有好 |
| **優先補「consumer 最多」的端點** | 訂單列表、詳情、建立 —— 這三條的價值超過剩下 67 條 |

---

**成功指標（試點後要量測的）**

| 指標 | 舊流程 | 目標 |
|---|---|---|
| 前端開始開發前的等待天數 | 6 天 | **0 天**（有 mock） |
| 整合階段天數 | 3 天 | **≤ 1 天** |
| 整合階段改動的前端程式碼行數 | 未量測 | **≤ 20 行** |
| 前端每週問後端的 API 問題次數 | 15～20 | **≤ 5** |
| 廠商對接的 email 往返次數 | 20+ | **≤ 8** |
| 契約與實作的漂移率 | N/A | **0%**（CI 保證） |

**⚠️ 誠實的預期**：

| 現實 | 說明 |
|---|---|
| 第一個試點**不會**很順 | 契約會寫錯、review 會發現一堆問題（這正是價值！但當下感覺像「變慢了」） |
| 前 2～3 個功能可能**比舊流程慢** | 學習曲線 + 建立工具鏈 |
| 第 4 個功能開始才會明顯變快 | 要在試點前就說明這一點，否則第一次不順就會被放棄 |

**這一題最重要的一點**：

> **流程變更失敗的原因，90% 不是「新流程不好」，是「導入方式不對」。**
>
> 三個關鍵：
> 1. **用數字說服**（不是「最佳實踐」）
> 2. **從小開始**（3 條端點、1 個功能的試點，不是 83 條全補）
> 3. **靠機制不靠紀律**（CI 檢查，不是「大家記得更新契約」）

</details>

---

## 7.14 驗收清單

- [ ] 我能說出「文件一定會過期」的三個結構性原因，特別是「沒有回饋迴路」。
- [ ] 我能列出「契約」能產生的五樣東西（文件、mock、SDK、驗證、diff），每一樣都是一個回饋迴路。
- [ ] 我知道 OpenAPI 放什麼、Markdown guide 放什麼，以及兩者要互相連結。
- [ ] 我能說出 OpenAPI 3.0 → 3.1 的五個關鍵差異，包含 `nullable` 被移除。
- [ ] 我知道選 3.1 的風險是「部分 SDK generator 支援不完整」，也知道什麼情況該選 3.0.3。
- [ ] 我能說出 Design-first 與 Code-first 各自的失敗模式，並設計出雙向檢查的混合流程。
- [ ] 我知道 drift 檢查要排除 `description` / `examples`，否則 diff 永遠是紅的。
- [ ] 我會用 `components` 抽出共用的參數、回應、schema，並知道拆檔案需要打包步驟。
- [ ] 我知道 `security` 的 AND / OR 只差一個縮排，這是最容易寫錯的地方。
- [ ] 我能寫出有價值的參數 `description`（回答「從 0 還是 1」「會不會改」「和誰互斥」）。
- [ ] 我知道共用回應的 `description` 要寫「處理建議」（例如「`401` 要刷新 token 而不是重試」）。
- [ ] 我能用 `oneOf` + `discriminator` 描述多形回應，也知道判別欄位必須是必填的 string。
- [ ] 我知道 `const` 是 3.1 的新特性，用來固定 discriminator 的值。
- [ ] 我能為端點寫出含「權限矩陣」與「效能建議」的 `description`。
- [ ] 我知道冪等重播的 `200` 一定要寫進 responses，否則 consumer 會以為是 bug。
- [ ] 我能用 3.1 的頂層 `webhooks` 描述發出的 webhook，並在其中強調「業務錯誤也要回 `2xx`」。
- [ ] 我知道 springdoc 的十個「讓產出不要爛」設定，特別是 `writer-with-order-by-keys`（讓 diff 穩定）。
- [ ] 我知道正式環境要關掉 Swagger UI，契約要用 CI 產生後發布到獨立文件站。
- [ ] 我會用 `OpenApiCustomizer` 批次加上共用回應與 header，取代 500 行重複註解。
- [ ] 我知道長的 `description` 要放在 Markdown 檔案裡，不要寫在 Java 字串。
- [ ] 我知道不該用 `Pageable` 讓 springdoc 自動產生（沒有 `maximum`、`sort` 沒有 pattern）。
- [ ] 我知道泛型 DTO 會產生醜的 schema 名稱，也知道具名 record 是可靠的解法。
- [ ] 我知道 `@Hidden` 只是「不寫進文件」，不是安全控制。
- [ ] 我能寫出好範例（有名稱、有摘要、涵蓋最簡／完整／邊界／錯誤），並用測試驗證它們符合 schema。
- [ ] 我知道 `description` 要回答的五類問題（給誰用、和誰的關係、會不會變、怎麼用、陷阱）。
- [ ] 我會用 Prism 起 mock server，也知道 `--example` 與 `--errors` 的價值。
- [ ] 我知道 Prism（開發）、MSW（測試）、WireMock（後端測外部依賴）的定位差異。
- [ ] 我知道前端測試的 mock 資料應該從 `api/examples/` 載入，讓契約改變時測試會失敗。
- [ ] 我能設計契約先行的協作流程，並知道「Day 2 的 review」是整個流程最有價值的一步。
- [ ] 我知道驗收標準是「切換 base URL 後不需要改前端程式碼」。
- [ ] 我能寫出 25 條 Spectral 規則，把前六章的 style guide 變成 CI 檢查。
- [ ] 我知道 Spectral 規則要漸進導入（info → warn → error），否則大家會學會繞過。
- [ ] 我知道每條規則都要有豁免機制，錯誤訊息要說「怎麼修」。
- [ ] 我知道 Spectral 規則本身也需要測試（bad fixture 必須被擋住）。
- [ ] 我知道命名慣例的規則通常要雙向檢查（`date-time` → `At`，且 `At` → `date-time`）。
- [ ] 我能設計五個 job 的 CI pipeline（lint / breaking / drift / mock-smoke / publish）。
- [ ] 我知道 `mock-smoke` 這一步證明「契約真的可用」，而不只是「語法正確」。
- [ ] 我能在完整 SDK 與「只產生型別」之間做出選擇，也知道「給廠商契約讓他們自己產生」是最好的策略。
- [ ] 我知道要在 CI 驗證契約能被主流 generator 處理。
- [ ] 我能設計文件站的結構（reference + guides + changelog + deprecations）。
- [ ] 我知道用 `x-internal` 標記並在打包時移除內部端點，也知道這只是「不揭露」不是「安全」。
- [ ] 我完成了 shop-service 的 `orders-api.yaml`。

---

完成後請前往 [08-idempotency-caching-and-rate-limit.md](./08-idempotency-caching-and-rate-limit.md)。
