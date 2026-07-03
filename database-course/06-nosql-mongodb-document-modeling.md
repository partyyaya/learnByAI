# 第 06 章：NoSQL 與 MongoDB 文件建模

> 很多人以為「NoSQL = 不用設計 schema，很自由」。這是最危險的誤會。
> NoSQL 不是不用設計，而是**把設計重心從「正規化」搬到「查詢模式」**。
> 這章以 MongoDB 為主，教你如何用「你打算怎麼查」來決定「資料怎麼放」，並附完整範例與練習解答。

---

## 6.1 學習目標

完成本章後，你應該可以：

- 說明文件型資料庫和關聯式資料庫的核心差異。
- 用「查詢驅動設計」決定資料結構。
- 判斷資料該用「內嵌（embed）」還是「引用（reference）」。
- 寫出 MongoDB 基本 CRUD 與聚合查詢。
- 為 MongoDB 建立合理索引。
- 理解 NoSQL 的一致性取捨，避免把 NoSQL 當萬用解。

---

## 6.2 先破除迷思：NoSQL 不是「沒有 schema」

關聯式資料庫是 **schema-on-write**：寫入前 schema 已固定，欄位型別、約束都先定義好。

MongoDB 這類文件庫是 **schema-on-read**：資料庫本身不強制欄位結構，結構的責任落到「應用程式讀寫時」。

這代表：

- 你「可以」在同一個 collection 放結構不同的文件。
- 但你「應該」有清楚的隱性結構，否則程式會被各種例外情況淹沒。

**心智模型**：關聯式是「資料庫幫你把關結構」；文件庫是「你自己要把關結構」。自由的代價是紀律。

---

## 6.3 關聯式 vs 文件型：什麼時候選哪個

| 面向 | 關聯式（MySQL/PostgreSQL） | 文件型（MongoDB） |
|------|---------------------------|-------------------|
| 資料結構 | 固定欄位、強型別 | 彈性欄位、巢狀結構 |
| 關係處理 | JOIN、外鍵 | 內嵌或應用層組裝 |
| 交易 | 成熟的多表 ACID | 支援交易，但設計上盡量避免跨文件 |
| 適合場景 | 訂單、金流、關係複雜的核心資料 | 內容管理、商品規格、事件日誌、彈性結構 |
| 設計重心 | 正規化，消除重複 | 查詢模式，允許適度重複 |

一句話總結：

- **關係複雜、需要強一致 → 關聯式。**
- **結構彈性、以「整份文件」為讀寫單位 → 文件型。**

很多系統是「兩者並用」：核心交易放 PostgreSQL，彈性內容放 MongoDB。

---

## 6.4 查詢驅動設計（Query-Driven Design）

關聯式建模你先想「實體與關係」，再正規化。文件建模順序相反：**先想「應用程式會怎麼查、怎麼顯示」，再決定文件怎麼放。**

問自己三個問題：

1. 最高頻的查詢是什麼？（例如：打開文章頁，要顯示文章 + 作者名 + 留言）
2. 這些資料是「一起被讀」還是「分開被讀」？
3. 這些資料多久變一次？誰會變？

答案決定你要內嵌還是引用。

---

## 6.5 內嵌 vs 引用：文件建模最核心的決策

### 內嵌（Embedding）：把關聯資料放進同一份文件

```json
{
  "_id": "post_1",
  "title": "資料庫入門",
  "author": { "id": "u_1", "name": "Alice" },
  "comments": [
    { "user": "Bob", "text": "很棒", "created_at": "2026-07-03T10:00:00Z" },
    { "user": "Cathy", "text": "推", "created_at": "2026-07-03T10:05:00Z" }
  ]
}
```

一次查詢就拿到文章、作者、留言，不用 JOIN。

**適合內嵌的情況：**

- 資料「總是一起被讀」（打開文章就要看留言）。
- 子資料「屬於」父資料，離開父資料沒意義。
- 子資料數量有上限、不會無限成長。

**內嵌的風險：**

- MongoDB 單文件有 16MB 上限。若留言可能有幾十萬則，內嵌會撐爆文件。
- 若作者改名，所有內嵌了該作者的文件都要更新（資料重複的代價）。

### 引用（Referencing）：只存 ID，另一個 collection 放完整資料

```json
// posts collection
{ "_id": "post_1", "title": "資料庫入門", "author_id": "u_1" }

// users collection
{ "_id": "u_1", "name": "Alice", "email": "alice@example.com" }
```

讀取時分兩步：先查文章，再用 `author_id` 查作者（類似關聯式的做法）。

**適合引用的情況：**

- 被引用的資料「獨立存在、會被很多地方共用」（作者、商品）。
- 子資料會無限成長（留言、訂單）。
- 子資料需要單獨查詢或分頁。

### 決策口訣

```text
一起讀、數量有限、從屬關係 → 內嵌
獨立存在、無限成長、需單獨查 → 引用
```

實務常混用：文章內嵌「最新 3 則留言」做預覽（讀取快），完整留言另存 collection 用引用（可分頁）。

---

## 6.6 取得與啟動 MongoDB

```bash
docker run --name course-mongo -p 27017:27017 -d mongo:7
docker exec -it course-mongo mongosh
```

切換資料庫（不存在會自動建立）：

```javascript
use course_db
```

---

## 6.7 基本 CRUD

### 新增

```javascript
db.products.insertOne({
  name: "機械鍵盤",
  category: "keyboard",
  price: 2990,
  attributes: { switch: "brown", layout: "75%", bluetooth: true }
})

db.products.insertMany([
  { name: "滑鼠", category: "mouse", price: 890 },
  { name: "耳機", category: "audio", price: 1990 }
])
```

注意：`keyboard` 有 `attributes`，`mouse` 沒有，這在文件庫是允許的。

### 查詢

```javascript
db.products.find({ category: "keyboard" })

db.products.find({ price: { $gte: 1000 } })

db.products.find(
  { category: "keyboard" },
  { name: 1, price: 1, _id: 0 }        // 只回傳 name 與 price
)

db.products.find().sort({ price: -1 }).limit(10)
```

查巢狀欄位用點記法：

```javascript
db.products.find({ "attributes.bluetooth": true })
```

### 更新

```javascript
db.products.updateOne(
  { _id: ObjectId("...") },
  { $set: { price: 3200 } }
)

// 對陣列 push 一個元素
db.posts.updateOne(
  { _id: "post_1" },
  { $push: { comments: { user: "Dan", text: "讚", created_at: new Date() } } }
)

// 原子遞增
db.products.updateOne({ _id: "p_1" }, { $inc: { stock: -1 } })
```

### 刪除

```javascript
db.products.deleteOne({ _id: ObjectId("...") })
db.products.deleteMany({ category: "obsolete" })
```

---

## 6.8 聚合管線（Aggregation Pipeline）

聚合是 MongoDB 版的 `GROUP BY`，用「管線」一步步處理資料。

範例：統計每個分類的商品數與平均價格。

```javascript
db.products.aggregate([
  { $match: { price: { $gt: 0 } } },              // 類似 WHERE
  { $group: {
      _id: "$category",                            // 類似 GROUP BY category
      count: { $sum: 1 },
      avgPrice: { $avg: "$price" }
  }},
  { $sort: { count: -1 } }                         // 類似 ORDER BY
])
```

對照 SQL：

```sql
SELECT category, COUNT(*) AS count, AVG(price) AS avg_price
FROM products
WHERE price > 0
GROUP BY category
ORDER BY count DESC;
```

常用管線階段：

- `$match`：過濾（放最前面才能用索引、減少後續資料量）。
- `$group`：分組聚合。
- `$sort`：排序。
- `$project`：挑選/重塑欄位。
- `$lookup`：類似 LEFT JOIN，關聯另一個 collection（能用但別當常態，頻繁 `$lookup` 通常代表建模該調整）。
- `$limit` / `$skip`：分頁。

---

## 6.9 索引

MongoDB 沒索引一樣會全集合掃描（`COLLSCAN`）。查詢模式固定後就要建索引。

```javascript
db.products.createIndex({ category: 1 })

// 複合索引，順序原則和關聯式一樣（最左前綴）
db.products.createIndex({ category: 1, price: -1 })

// 唯一索引
db.users.createIndex({ email: 1 }, { unique: true })
```

用 `explain` 檢查是否吃到索引：

```javascript
db.products.find({ category: "keyboard" }).explain("executionStats")
```

看 `stage` 是 `IXSCAN`（走索引）還是 `COLLSCAN`（掃全集合）。這和第 03 章的 `EXPLAIN` 思路完全一致。

---

## 6.10 完整範例：部落格系統的文件設計

需求：

- 打開文章頁：顯示文章內容、作者名、最新 3 則留言（高頻）。
- 留言可以分頁往下載入（可能上千則）。
- 作者資料會在很多文章出現，且可能改名。

### 設計決策

- 作者：**引用**（獨立存在、多處共用、會改名）。但把 `author_name` 冗餘一份到文章，讓文章頁不用再查一次作者。
- 最新留言預覽：**內嵌** 3 則到文章（讀取快）。
- 完整留言：獨立 collection，用 `post_id` **引用**（無限成長、要分頁）。

### 文件結構

```json
// posts
{
  "_id": "post_1",
  "title": "資料庫入門",
  "body": "...",
  "author_id": "u_1",
  "author_name": "Alice",
  "recent_comments": [
    { "user_name": "Bob", "text": "很棒", "created_at": "2026-07-03T10:00:00Z" }
  ],
  "comment_count": 128,
  "created_at": "2026-07-01T09:00:00Z"
}

// comments
{
  "_id": "c_501",
  "post_id": "post_1",
  "user_id": "u_9",
  "user_name": "Bob",
  "text": "很棒",
  "created_at": "2026-07-03T10:00:00Z"
}
```

### 對應查詢

打開文章頁（一次查詢就有內容 + 作者名 + 預覽留言）：

```javascript
db.posts.findOne({ _id: "post_1" })
```

留言分頁：

```javascript
db.comments.find({ post_id: "post_1" })
  .sort({ created_at: -1 })
  .limit(20)

db.comments.createIndex({ post_id: 1, created_at: -1 })
```

新增留言時（同時維護冗餘）：

```javascript
// 1. 寫入完整留言
db.comments.insertOne({ post_id: "post_1", user_id: "u_9", user_name: "Bob", text: "讚", created_at: new Date() })

// 2. 更新文章的預覽留言與計數（保持最新 3 則）
db.posts.updateOne(
  { _id: "post_1" },
  {
    $inc: { comment_count: 1 },
    $push: {
      recent_comments: { $each: [{ user_name: "Bob", text: "讚", created_at: new Date() }], $slice: -3 }
    }
  }
)
```

### 處理「作者改名」

因為冗餘了 `author_name`，作者改名要同步更新：

```javascript
db.posts.updateMany({ author_id: "u_1" }, { $set: { author_name: "Alice Chen" } })
```

這就是文件建模的取捨：**用「寫入時多做一點」換「讀取時快很多」**。這和第 01 章的反正規化、第 05 章的快取一致性是同一種思維。

---

## 6.11 一致性與交易

MongoDB 4.0 起支援多文件交易：

```javascript
const session = db.getMongo().startSession()
session.startTransaction()
try {
  // 多個操作
  session.commitTransaction()
} catch (e) {
  session.abortTransaction()
}
```

但要注意心態：

- 在文件庫，**跨文件交易應該是例外，不是常態**。如果你發現大量需要跨文件交易，通常代表「這些資料本來就該內嵌在一起」，或「這個場景本來就更適合關聯式資料庫」。
- 好的文件設計讓「一個業務操作 = 一份文件的原子更新」，天然就一致。

**分散式系統的 CAP 提醒**：MongoDB 副本集在網路分區時會在一致性與可用性間取捨。預設寫入關注（write concern）與讀取關注（read concern）決定了你能容忍多少不一致，正式環境要依業務調整。

---

## 6.12 常見錯誤

### 錯誤 1：把關聯式表原封不動搬進 MongoDB

有人把 `users`、`orders`、`order_items` 三張表照搬成三個 collection，然後到處 `$lookup`。這是「用文件庫寫關聯式」，兩邊的好處都拿不到。要嘛好好內嵌，要嘛就用關聯式。

### 錯誤 2：無限成長的陣列內嵌

把「使用者所有訂單」內嵌進 user 文件，訂單越來越多，文件越來越大，直到撞上 16MB 上限、更新越來越慢。無限成長的資料要用引用。

### 錯誤 3：完全不設計，什麼欄位都隨手加

同一個 collection 裡有的文件叫 `price`、有的叫 `cost`、有的是字串 `"2990"`、有的是數字 `2990`。查詢和聚合會變成惡夢。schema-on-read 不代表沒有 schema，代表 schema 的紀律在你身上。

### 錯誤 4：不建索引

小資料量測試沒問題，上線資料一多，`COLLSCAN` 讓查詢慢到不可用。固定查詢模式就要建索引。

### 錯誤 5：以為 NoSQL 一定比 SQL 快/好

NoSQL 在「符合它設計假設」的場景快。訂單金流這種強關係、強一致場景，硬用文件庫通常更痛苦。選型要回到第 00 章的判斷框架。

---

## 6.13 本章練習

### 練習 1：判斷內嵌還是引用

為下列關係選擇內嵌或引用，並說明理由：

1. 訂單與訂單明細（明細數量有限、總是跟訂單一起讀、不會單獨查）。
2. 使用者與他發過的貼文（可能成千上萬則、需要分頁、可單獨查）。
3. 商品與它的規格屬性（固定跟著商品、數量少）。
4. 貼文與按讚的使用者清單（可能非常多、只想知道總數和「我是否按過」）。

#### 參考解答

1. 訂單明細 → **內嵌**。數量有限、總是跟訂單一起讀、從屬於訂單，內嵌成一份文件最自然。

2. 使用者的貼文 → **引用**。無限成長、需要分頁、可單獨查詢，貼文獨立成 collection，用 `author_id` 引用。

3. 商品規格 → **內嵌**。固定跟著商品、數量少、離開商品沒意義，內嵌成 `attributes` 子文件。

4. 按讚使用者 → **引用 + 冗餘計數**。完整按讚紀錄可能極多，另存 collection（`{ post_id, user_id }` 並建唯一索引防重複按讚）；同時在貼文冗餘一個 `like_count`。要判斷「我是否按過」時查 likes collection，不必把整份名單塞進貼文。

### 練習 2：寫聚合查詢

`orders` collection 文件如下：

```json
{ "_id": "o_1", "user_id": "u_1", "status": "paid", "total": 1290, "created_at": ISODate("2026-07-01") }
```

請寫出「統計每位使用者的已付款訂單數與總金額，只列出總金額 >= 5000 的使用者，依總金額由高到低排序」。

#### 參考解答

```javascript
db.orders.aggregate([
  { $match: { status: "paid" } },
  { $group: {
      _id: "$user_id",
      orderCount: { $sum: 1 },
      totalAmount: { $sum: "$total" }
  }},
  { $match: { totalAmount: { $gte: 5000 } } },
  { $sort: { totalAmount: -1 } }
])
```

重點：

- 第一個 `$match` 先過濾 `paid`，能用索引且減少後續資料量。
- 分組後的條件（`totalAmount >= 5000`）必須用「分組後的第二個 `$match`」，類似 SQL 的 `HAVING`。

### 練習 3：改善一個爛設計

某人把使用者所有觀看歷史都內嵌進 user 文件：

```json
{ "_id": "u_1", "name": "Alice", "watch_history": [ { "video_id": "...", "watched_at": "..." }, ... 十萬筆 ... ] }
```

問題是什麼？怎麼改？

#### 參考解答

問題：

- `watch_history` 無限成長，文件會越來越大，逼近甚至撞上 16MB 上限。
- 每次新增一筆觀看紀錄都要更新整個大文件，寫入越來越慢。
- 無法對觀看歷史單獨分頁、排序、查詢。

改法：把觀看歷史拆成獨立 collection，用引用：

```json
// watch_history collection
{ "_id": "wh_1", "user_id": "u_1", "video_id": "v_9", "watched_at": ISODate("2026-07-03") }
```

```javascript
db.watch_history.createIndex({ user_id: 1, watched_at: -1 })

// 查某使用者最近 20 筆
db.watch_history.find({ user_id: "u_1" }).sort({ watched_at: -1 }).limit(20)
```

若首頁要顯示「最近看過的 5 部」，可額外在 user 文件冗餘一個 `recent_watched` 陣列並用 `$slice: -5` 維持長度，兼顧讀取速度。

### 練習 4：選型判斷

一個銀行核心帳務系統，要記錄每筆轉帳、保證餘額絕不出錯、需要跨帳戶的強一致交易。適合用 MongoDB 當主資料庫嗎？

#### 參考解答

不適合當主資料庫。

理由：

- 帳務是強關係、強一致場景，核心是「跨帳戶的多筆更新必須原子且一致」（呼應第 02 章的轉帳交易）。
- 這正是關聯式資料庫成熟的多表 ACID 交易最擅長的領域。
- 在文件庫需要頻繁跨文件交易，等於逆著它的設計假設用，得不到文件庫的好處還增加風險。

建議：核心帳務用 PostgreSQL/MySQL（或需要水平擴展時用 NewSQL）。MongoDB 可用於周邊彈性資料，例如交易的附加描述、風控事件日誌。

---

## 6.14 驗收清單

- [ ] 我能說明 schema-on-read 不等於「不用設計 schema」。
- [ ] 我會用「查詢驅動設計」而不是先正規化。
- [ ] 我能依「一起讀/無限成長/是否單獨查」判斷內嵌或引用。
- [ ] 我會寫 MongoDB 基本 CRUD 與聚合管線。
- [ ] 我知道要用 `explain` 檢查索引，並為固定查詢建索引。
- [ ] 我知道跨文件交易應是例外，強一致關係型場景仍該用關聯式。

---

完成後請前往 [07-search-and-analytics-databases.md](./07-search-and-analytics-databases.md)。
