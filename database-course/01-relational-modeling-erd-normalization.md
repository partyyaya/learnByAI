# 第 01 章：關聯式建模、ERD、正規化與反正規化

> 關聯式資料庫最難的不是 `SELECT` 怎麼寫，而是「資料一開始要怎麼放」。
> 表設計錯了，後面 SQL、索引、API、報表都會跟著痛苦。這章會從資料建模開始，教你把真實需求轉成資料表。

---

## 1.1 學習目標

完成本章後，你應該可以：

- 說明 entity、attribute、relationship 的意思。
- 判斷一對一、一對多、多對多關係。
- 設計 primary key、foreign key 與 unique constraint。
- 看懂並畫出基本 ERD。
- 理解第一、第二、第三正規化。
- 知道什麼時候可以反正規化。
- 為學生選課系統與電商訂單系統設計資料表。

---

## 1.2 從需求文字找出資料模型

假設產品經理說：

> 我們要做一個線上課程平台。老師可以建立課程，每門課有多個章節。學生可以購買課程，購買後可以記錄觀看進度。

你不要急著寫 SQL。先拆三件事：

1. 有哪些「東西」需要被記錄？
2. 每個東西有哪些屬性？
3. 這些東西之間有什麼關係？

### Entity：系統裡重要的名詞

從需求可以找出：

- 老師
- 學生
- 課程
- 章節
- 購買紀錄
- 觀看進度

這些就是 entity，通常會變成資料表。

### Attribute：entity 的欄位

例如課程可能有：

- 課程 ID
- 課程名稱
- 課程描述
- 價格
- 上架狀態
- 建立時間

### Relationship：entity 之間的關係

例如：

- 一位老師可以建立多門課。
- 一門課有多個章節。
- 一位學生可以購買多門課。
- 一門課也可以被多位學生購買。

關係會決定你要不要放 foreign key，或要不要建立中介表。

---

## 1.3 主鍵 Primary Key

Primary key 是一筆資料的唯一識別。

範例：

```sql
CREATE TABLE students (
  id BIGSERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  email VARCHAR(255) NOT NULL
);
```

這裡 `id` 是主鍵。它的責任是：

- 唯一識別一位學生。
- 讓其他資料表可以引用這位學生。
- 通常不應該頻繁改變。

### 自然鍵 vs 代理鍵

自然鍵是現實世界本來就存在的唯一值，例如：

- 身分證字號
- Email
- ISBN

代理鍵是系統自己產生的 ID，例如：

- `id BIGSERIAL`
- UUID
- Snowflake ID

實務上多數表會使用代理鍵當 primary key，再用 unique constraint 保護自然唯一值。

範例：

```sql
CREATE TABLE users (
  id BIGSERIAL PRIMARY KEY,
  email VARCHAR(255) NOT NULL UNIQUE,
  name VARCHAR(100) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

為什麼不直接拿 email 當 primary key？

- 使用者可能改 email。
- email 字串較長，作為其他表的 foreign key 不方便。
- 用數字 ID 或 UUID 當關聯鍵更穩定。

---

## 1.4 外鍵 Foreign Key

Foreign key 表示「這個欄位引用另一張表的資料」。

範例：一門課屬於一位老師。

```sql
CREATE TABLE teachers (
  id BIGSERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL
);

CREATE TABLE courses (
  id BIGSERIAL PRIMARY KEY,
  teacher_id BIGINT NOT NULL REFERENCES teachers(id),
  title VARCHAR(200) NOT NULL,
  price NUMERIC(10, 2) NOT NULL
);
```

`courses.teacher_id` 指向 `teachers.id`。

這代表：

- 每門課都必須有一位存在的老師。
- 不能建立 `teacher_id = 9999`，但 teachers 表裡根本沒有 id 9999 的資料。

這就是資料完整性。

---

## 1.5 一對一、一對多、多對多

### 一對一 One-to-One

例子：一個使用者有一份個人設定。

```sql
CREATE TABLE users (
  id BIGSERIAL PRIMARY KEY,
  email VARCHAR(255) NOT NULL UNIQUE
);

CREATE TABLE user_profiles (
  user_id BIGINT PRIMARY KEY REFERENCES users(id),
  display_name VARCHAR(100),
  bio TEXT
);
```

注意 `user_profiles.user_id` 同時是 primary key 與 foreign key，代表一個 user 最多只能有一份 profile。

適合一對一拆表的情境：

- 某些欄位很少用，不想每次查 user 都載入。
- 敏感資料需要更嚴格權限。
- 資料生命週期不同。

### 一對多 One-to-Many

例子：一位老師有多門課。

```sql
CREATE TABLE teachers (
  id BIGSERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL
);

CREATE TABLE courses (
  id BIGSERIAL PRIMARY KEY,
  teacher_id BIGINT NOT NULL REFERENCES teachers(id),
  title VARCHAR(200) NOT NULL
);
```

外鍵放在「多」的那邊。因為一門課只屬於一位老師，所以 `courses` 放 `teacher_id`。

### 多對多 Many-to-Many

例子：學生與課程。

- 一位學生可以選多門課。
- 一門課可以被多位學生選。

不能在 `students` 放 `course_ids` 字串，也不應該在 `courses` 放 `student_ids` 字串。正確做法是建立中介表。

```sql
CREATE TABLE students (
  id BIGSERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL
);

CREATE TABLE courses (
  id BIGSERIAL PRIMARY KEY,
  title VARCHAR(200) NOT NULL
);

CREATE TABLE enrollments (
  student_id BIGINT NOT NULL REFERENCES students(id),
  course_id BIGINT NOT NULL REFERENCES courses(id),
  enrolled_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (student_id, course_id)
);
```

`enrollments` 是中介表。它表示「某位學生選了某門課」。

`PRIMARY KEY (student_id, course_id)` 的意思是：

- 同一位學生不能重複選同一門課。
- 這本身也建立了唯一性約束。

---

## 1.6 ERD 心智模型

ERD 是 Entity Relationship Diagram，用圖表示表與表之間的關係。

學生選課系統可以用文字表示成：

```text
students 1 --- N enrollments N --- 1 courses
```

意思是：

- 一個 student 可以有多筆 enrollment。
- 一個 course 可以有多筆 enrollment。
- enrollment 把 student 與 course 連起來。

線上課程平台可以表示成：

```text
teachers 1 --- N courses 1 --- N chapters
students 1 --- N purchases N --- 1 courses
students 1 --- N lesson_progress N --- 1 chapters
```

建模時先畫出這種文字 ERD，再寫 SQL，會比直接開資料庫建表安全很多。

---

## 1.7 正規化

正規化的目的不是炫技，而是減少重複資料與更新錯誤。

### 第一正規化 1NF：欄位不可再切

錯誤設計：

```sql
CREATE TABLE students (
  id BIGSERIAL PRIMARY KEY,
  name VARCHAR(100),
  phones VARCHAR(500)
);
```

`phones` 可能塞：

```text
0911-111-111,0922-222-222
```

問題：

- 很難查某支電話屬於誰。
- 很難保證格式。
- 很難單獨新增或刪除一支電話。

較好的設計：

```sql
CREATE TABLE students (
  id BIGSERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL
);

CREATE TABLE student_phones (
  id BIGSERIAL PRIMARY KEY,
  student_id BIGINT NOT NULL REFERENCES students(id),
  phone VARCHAR(30) NOT NULL
);
```

### 第二正規化 2NF：非鍵欄位要依賴整個主鍵

這通常出現在複合主鍵。

錯誤設計：

```sql
CREATE TABLE enrollments (
  student_id BIGINT NOT NULL,
  course_id BIGINT NOT NULL,
  student_name VARCHAR(100) NOT NULL,
  course_title VARCHAR(200) NOT NULL,
  enrolled_at TIMESTAMP NOT NULL,
  PRIMARY KEY (student_id, course_id)
);
```

問題：

- `student_name` 只依賴 `student_id`，不是依賴 `(student_id, course_id)`。
- `course_title` 只依賴 `course_id`。
- 同一位學生選 5 門課，名字重複存 5 次。

較好的設計：

```sql
CREATE TABLE students (
  id BIGSERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL
);

CREATE TABLE courses (
  id BIGSERIAL PRIMARY KEY,
  title VARCHAR(200) NOT NULL
);

CREATE TABLE enrollments (
  student_id BIGINT NOT NULL REFERENCES students(id),
  course_id BIGINT NOT NULL REFERENCES courses(id),
  enrolled_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (student_id, course_id)
);
```

### 第三正規化 3NF：非鍵欄位不要依賴其他非鍵欄位

錯誤設計：

```sql
CREATE TABLE orders (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL,
  user_email VARCHAR(255) NOT NULL,
  user_level VARCHAR(30) NOT NULL,
  discount_rate NUMERIC(5, 2) NOT NULL
);
```

如果 `discount_rate` 是由 `user_level` 決定，例如 VIP 固定 0.9，白金會員固定 0.8，那它不應該每筆訂單都重複保存。

較好的設計：

```sql
CREATE TABLE membership_levels (
  level_code VARCHAR(30) PRIMARY KEY,
  discount_rate NUMERIC(5, 2) NOT NULL
);

CREATE TABLE users (
  id BIGSERIAL PRIMARY KEY,
  email VARCHAR(255) NOT NULL UNIQUE,
  level_code VARCHAR(30) NOT NULL REFERENCES membership_levels(level_code)
);

CREATE TABLE orders (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id),
  total_amount NUMERIC(12, 2) NOT NULL
);
```

---

## 1.8 反正規化

正規化不是永遠越高越好。為了查詢效能或歷史正確性，有時會故意保存重複資料，這叫反正規化。

### 情境 1：訂單需要保存當下商品名稱與價格

錯誤心智模型：

> 商品表已經有商品名稱與價格，訂單明細只要存 product_id 就好。

問題：

- 商品日後改名，舊訂單顯示的商品名稱也會跟著變。
- 商品日後調價，舊訂單金額可能對不起來。

正確做法：

```sql
CREATE TABLE order_items (
  id BIGSERIAL PRIMARY KEY,
  order_id BIGINT NOT NULL REFERENCES orders(id),
  product_id BIGINT NOT NULL REFERENCES products(id),
  product_name VARCHAR(200) NOT NULL,
  unit_price NUMERIC(12, 2) NOT NULL,
  quantity INT NOT NULL,
  subtotal NUMERIC(12, 2) NOT NULL
);
```

`product_name` 與 `unit_price` 是下單當下的快照。這是有意義的反正規化。

### 情境 2：文章列表需要顯示留言數

如果每次查文章列表都即時計算留言數：

```sql
SELECT
  p.id,
  p.title,
  COUNT(c.id) AS comment_count
FROM posts p
LEFT JOIN comments c ON c.post_id = p.id
GROUP BY p.id, p.title;
```

文章與留言很多時會變慢。

可以在 `posts` 表保存 `comment_count`：

```sql
ALTER TABLE posts ADD COLUMN comment_count INT NOT NULL DEFAULT 0;
```

新增留言時同步更新：

```sql
UPDATE posts
SET comment_count = comment_count + 1
WHERE id = 1001;
```

代價是：

- 寫入邏輯變複雜。
- 要處理一致性。
- 可能需要定期校正。

所以反正規化不是偷懶，而是有意識地用寫入複雜度換讀取效能。

---

## 1.9 完整範例：學生選課系統

需求：

- 學生可以註冊。
- 課程由老師開設。
- 學生可以選多門課。
- 一門課有人數上限。
- 要能查詢某學生選了哪些課。
- 要能查詢某課程有哪些學生。

### Step 1：找 entity

- students
- teachers
- courses
- enrollments

### Step 2：找關係

```text
teachers 1 --- N courses
students N --- N courses
students 1 --- N enrollments N --- 1 courses
```

### Step 3：設計資料表

```sql
CREATE TABLE students (
  id BIGSERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  email VARCHAR(255) NOT NULL UNIQUE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE teachers (
  id BIGSERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  email VARCHAR(255) NOT NULL UNIQUE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE courses (
  id BIGSERIAL PRIMARY KEY,
  teacher_id BIGINT NOT NULL REFERENCES teachers(id),
  title VARCHAR(200) NOT NULL,
  capacity INT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (capacity > 0)
);

CREATE TABLE enrollments (
  student_id BIGINT NOT NULL REFERENCES students(id),
  course_id BIGINT NOT NULL REFERENCES courses(id),
  enrolled_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (student_id, course_id)
);
```

### Step 4：為常見查詢補索引

`PRIMARY KEY (student_id, course_id)` 已經適合查某學生選了哪些課。

但如果要常查某課程有哪些學生，還需要：

```sql
CREATE INDEX idx_enrollments_course_id
ON enrollments(course_id);
```

原因：

- 複合索引 `(student_id, course_id)` 最左欄是 `student_id`。
- 查 `WHERE course_id = ?` 時，不一定能有效使用這個索引。

第 03 章會詳細講索引最左前綴。

---

## 1.10 完整範例：電商訂單

需求：

- 使用者可以下訂單。
- 一張訂單可以包含多個商品。
- 商品價格未來可能變動。
- 舊訂單必須保存下單當下的商品名稱與價格。

### 資料表設計

```sql
CREATE TABLE users (
  id BIGSERIAL PRIMARY KEY,
  email VARCHAR(255) NOT NULL UNIQUE,
  name VARCHAR(100) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE products (
  id BIGSERIAL PRIMARY KEY,
  name VARCHAR(200) NOT NULL,
  price NUMERIC(12, 2) NOT NULL,
  stock INT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (price >= 0),
  CHECK (stock >= 0)
);

CREATE TABLE orders (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id),
  status VARCHAR(30) NOT NULL,
  total_amount NUMERIC(12, 2) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (total_amount >= 0)
);

CREATE TABLE order_items (
  id BIGSERIAL PRIMARY KEY,
  order_id BIGINT NOT NULL REFERENCES orders(id),
  product_id BIGINT NOT NULL REFERENCES products(id),
  product_name VARCHAR(200) NOT NULL,
  unit_price NUMERIC(12, 2) NOT NULL,
  quantity INT NOT NULL,
  subtotal NUMERIC(12, 2) NOT NULL,
  CHECK (unit_price >= 0),
  CHECK (quantity > 0),
  CHECK (subtotal >= 0)
);
```

### 為什麼 `order_items` 要保存 `product_name` 與 `unit_price`

這是刻意反正規化。

假設使用者在 1 月用 1000 元買了「初階 SQL 課程」，3 月商品改名為「SQL 完整班」且價格變成 2000 元。

舊訂單仍然應該顯示：

```text
初階 SQL 課程，單價 1000
```

而不是顯示新名稱與新價格。

---

## 1.11 常見錯誤

### 錯誤 1：用逗號字串保存多個值

錯誤：

```sql
CREATE TABLE posts (
  id BIGSERIAL PRIMARY KEY,
  title VARCHAR(200),
  tag_names VARCHAR(500)
);
```

`tag_names = 'database,sql,index'`

問題：

- 很難查詢所有包含 `sql` 的文章。
- 很難避免重複 tag。
- 很難統計每個 tag 有幾篇文章。

正確：

```sql
CREATE TABLE tags (
  id BIGSERIAL PRIMARY KEY,
  name VARCHAR(50) NOT NULL UNIQUE
);

CREATE TABLE post_tags (
  post_id BIGINT NOT NULL REFERENCES posts(id),
  tag_id BIGINT NOT NULL REFERENCES tags(id),
  PRIMARY KEY (post_id, tag_id)
);
```

### 錯誤 2：沒有 unique constraint

只在程式碼檢查 email 是否重複是不夠的。

錯誤：

```sql
CREATE TABLE users (
  id BIGSERIAL PRIMARY KEY,
  email VARCHAR(255) NOT NULL
);
```

如果兩個請求同時註冊同一個 email，程式檢查可能都通過，最後插入兩筆重複資料。

正確：

```sql
CREATE TABLE users (
  id BIGSERIAL PRIMARY KEY,
  email VARCHAR(255) NOT NULL UNIQUE
);
```

唯一性要由資料庫保證，程式碼檢查只是為了給使用者友善錯誤訊息。

### 錯誤 3：所有欄位都允許 NULL

如果欄位在業務上必填，就應該 `NOT NULL`。

錯誤：

```sql
CREATE TABLE courses (
  id BIGSERIAL PRIMARY KEY,
  title VARCHAR(200),
  price NUMERIC(10, 2)
);
```

正確：

```sql
CREATE TABLE courses (
  id BIGSERIAL PRIMARY KEY,
  title VARCHAR(200) NOT NULL,
  price NUMERIC(10, 2) NOT NULL
);
```

資料庫約束可以防止壞資料進入系統。

---

## 1.12 本章練習

### 練習 1：判斷關係類型

請判斷以下關係是一對一、一對多，還是多對多：

1. 一位作者可以寫多篇文章，一篇文章只有一位主要作者。
2. 一位學生可以加入多個社團，一個社團也有多位學生。
3. 一位使用者有一份帳號安全設定。
4. 一張訂單有多個訂單明細，一筆訂單明細只屬於一張訂單。

#### 參考解答

1. 作者與文章：一對多。

外鍵應放在文章表：

```sql
CREATE TABLE articles (
  id BIGSERIAL PRIMARY KEY,
  author_id BIGINT NOT NULL REFERENCES authors(id),
  title VARCHAR(200) NOT NULL
);
```

2. 學生與社團：多對多。

需要中介表：

```sql
CREATE TABLE club_memberships (
  student_id BIGINT NOT NULL REFERENCES students(id),
  club_id BIGINT NOT NULL REFERENCES clubs(id),
  joined_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (student_id, club_id)
);
```

3. 使用者與帳號安全設定：一對一。

可用 `user_id` 同時作為 primary key 與 foreign key：

```sql
CREATE TABLE user_security_settings (
  user_id BIGINT PRIMARY KEY REFERENCES users(id),
  mfa_enabled BOOLEAN NOT NULL DEFAULT FALSE
);
```

4. 訂單與訂單明細：一對多。

外鍵放在訂單明細：

```sql
CREATE TABLE order_items (
  id BIGSERIAL PRIMARY KEY,
  order_id BIGINT NOT NULL REFERENCES orders(id)
);
```

### 練習 2：設計文章與標籤系統

需求：

- 一篇文章可以有多個標籤。
- 一個標籤可以套用到多篇文章。
- 標籤名稱不能重複。
- 同一篇文章不能重複套用同一個標籤。

請設計資料表。

#### 參考解答

```sql
CREATE TABLE posts (
  id BIGSERIAL PRIMARY KEY,
  title VARCHAR(200) NOT NULL,
  body TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE tags (
  id BIGSERIAL PRIMARY KEY,
  name VARCHAR(50) NOT NULL UNIQUE
);

CREATE TABLE post_tags (
  post_id BIGINT NOT NULL REFERENCES posts(id),
  tag_id BIGINT NOT NULL REFERENCES tags(id),
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (post_id, tag_id)
);

CREATE INDEX idx_post_tags_tag_id
ON post_tags(tag_id);
```

解釋：

- `posts` 保存文章。
- `tags.name UNIQUE` 保證標籤名稱不重複。
- `post_tags` 解決多對多。
- `PRIMARY KEY (post_id, tag_id)` 保證同一篇文章不能重複套同一個標籤。
- `idx_post_tags_tag_id` 讓「查某個 tag 底下有哪些文章」更快。

### 練習 3：找出不合理設計

下面是一個訂單表：

```sql
CREATE TABLE orders (
  id BIGSERIAL PRIMARY KEY,
  user_email VARCHAR(255),
  product_ids VARCHAR(500),
  product_names VARCHAR(1000),
  total_amount NUMERIC(12, 2)
);
```

請指出問題並改成較好的設計。

#### 參考解答

問題：

- `user_email` 沒有連到 users 表，無法保證使用者存在。
- `product_ids` 與 `product_names` 用逗號字串保存多個值，違反 1NF。
- 一張訂單有多個商品，應該拆出 `order_items`。
- 欄位缺少 `NOT NULL`。
- 沒有保存商品下單當下的單價與數量。

較好的設計：

```sql
CREATE TABLE users (
  id BIGSERIAL PRIMARY KEY,
  email VARCHAR(255) NOT NULL UNIQUE
);

CREATE TABLE products (
  id BIGSERIAL PRIMARY KEY,
  name VARCHAR(200) NOT NULL,
  price NUMERIC(12, 2) NOT NULL
);

CREATE TABLE orders (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id),
  total_amount NUMERIC(12, 2) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE order_items (
  id BIGSERIAL PRIMARY KEY,
  order_id BIGINT NOT NULL REFERENCES orders(id),
  product_id BIGINT NOT NULL REFERENCES products(id),
  product_name VARCHAR(200) NOT NULL,
  unit_price NUMERIC(12, 2) NOT NULL,
  quantity INT NOT NULL,
  subtotal NUMERIC(12, 2) NOT NULL
);
```

---

## 1.13 驗收清單

- [ ] 我能從需求文字找出 entity、attribute、relationship。
- [ ] 我能判斷一對一、一對多、多對多。
- [ ] 我知道多對多需要中介表。
- [ ] 我知道 primary key、foreign key、unique constraint 的用途。
- [ ] 我能說明正規化與反正規化的差異。
- [ ] 我能替學生選課或電商訂單設計基本資料表。

---

完成後請前往 [02-sql-crud-join-transaction.md](./02-sql-crud-join-transaction.md)。
