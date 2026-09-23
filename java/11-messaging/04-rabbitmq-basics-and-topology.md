# 第 04 章：RabbitMQ 拓撲與 Spring AMQP

> 前三章的每一個實驗都在用同一個寫法：`rabbit.convertAndSend("order.q", body)`。
> 一個佇列、一行程式、能跑。所以你很可能會說：
>
> > **「我沒有用 exchange。」**
>
> ⚠️ **錯。你一直在用一個 exchange，只是它的名字是空字串。**
>
> 4.2.1 會把它列出來給你看 —— 它在 broker 上真的存在、型別是 `direct`、
> 而且你的每一個佇列都被**自動綁**了一條 `routing_key = 佇列名` 的 binding。
> 你甚至**不能刪掉它、也不能自己加 binding**（實測：`ACCESS_REFUSED`）。
>
> 這一章把 broker 上的東西攤開來看，而且會量出四件事：
>
> **一、同一則訊息送進四種 exchange，落點完全不同。** 4.3.1 用 12 個佇列一次測完，
> 其中最反直覺的一組：topic exchange 上，`order.*` **收不到** `order.created.vip`，
> 而 `order.#` **收得到**。⚠️ 這兩個字元的差別，足以讓一個消費者在上線後永遠收不到訊息。
>
> **二、`convertAndSend` 送一個 Java 物件，線路上是 `\xac\xed\x00\x05`。**
> 4.5.1 實測：118 bytes 的 Java 序列化，裡面**明碼寫著你的套件名**。
> 上游把 `v1` 改成 `v2`（長度一樣），下游立刻 `MessageConversionException`。
> 而換成 JSON **也救不了你** —— 4.5.3 實測，Jackson 把套件名搬到 `__TypeId__` header，
> 一樣炸。
> ⚠️ **而 4.5.4 量出來的答案跟直覺相反**：大家最常查到的那個修法（`DefaultClassMapper`）
> 在這個情境下**完全無效**，真正擋住它的東西**你根本不用設** ——
> 但有一行「看起來像在修 bug」的設定會**把那個保護關掉**。
>
> **三、改一個佇列屬性，會讓「同一批」的其他佇列全部沒建起來。**
> 4.6.1 實測：四個佇列，只有第二個帶了新的 `x-dead-letter-exchange` 參數，
> 結果是 `PRECONDITION_FAILED` → **第三、第四個佇列根本沒被建立**，
> 而且 Spring 在那裡**重試了 5 次、卡了 12 秒**才放棄。
> 這就是 [01 章 1.4.1](./01-reliable-delivery-three-hops.md) 那個 `inequivalent arg` 回來咬人的樣子。
>
> **四、多環境共用一台 broker 有兩種做法，其中一種會讓「打錯一個字」變成無聲遺失。**
> 4.7.1 兩種都實測。

---

## 4.1 學習目標

完成本章後，你應該可以：

- 說出 exchange / queue / binding **三個東西各自負責什麼**，
  以及「生產者只認 exchange、消費者只認 queue」為什麼是這個設計的全部價值（4.2）。
- 說明**預設 exchange**是什麼、為什麼 `convertAndSend(queueName, body)` 能動，
  以及它的三個限制（4.2）。
- 判斷四種 exchange 各自的路由規則，並在拿到需求時選對一種（4.3）。
- 正確使用 topic 的 `*` 與 `#`，並說出 `order.*` 與 `order.#` 對 `order.created.vip` 的差別（4.4）。
- 說出 `convertAndSend` 送 Java 物件時**線路上實際的位元組**，以及為什麼那是個地雷（4.5）。
- 說出 `__TypeId__` 這顆地雷**什麼時候會炸、什麼時候不會**，以及哪一行設定會把保護關掉（4.5.4）。
- 說出 Java 反序列化的允許清單預設是什麼，以及為什麼它值得你關心（4.5.5）。
- 決定拓撲宣告要寫在哪裡（三種策略各自的代價），並說出哪一種適合你的團隊（4.6.3）。
- 說出佇列的哪些屬性是**不可變的**，以及要改它們時**唯一安全的流程**（4.6.4、4.6.5）。
- 讓 `dev` / `staging` / `prod` 共用一台 broker 而不打到對方，
  並說出 vhost 與前綴兩種做法的差別（4.7）。
- 用 `@RabbitListener` 寫出一個正確的消費者，並說明 `@Bean` 拓撲的寫法（4.8）。

---

## 4.2 你一直在用一個 exchange

### 4.2.1 實測：把它列出來

先看協定層面。AMQP 0-9-1 的 `basic.publish` 長這樣：

```
basic.publish(exchange, routing-key, mandatory, immediate, properties, body)
                 ▲          ▲
                 │          └── 必填
                 └── 必填
```

📌 **「不指定 exchange」在協定上不存在。** 你填的是空字串，而空字串是一個真的 exchange。

```java
package com.example.lab11.ch04;

@SpringBootTest
class F0DefaultExchangeTest {

    static final String Q = "ch04.default.q";

    @Test
    void theExchangeYouHaveBeenUsingAllAlong() throws Exception {
        admin.declareQueue(new Queue(Q, true, false, false));

        // ① 前三章一直在用的寫法（三參數版）
        rabbit.convertAndSend("", Q, "A：convertAndSend(\"\", Q, body)");
        // ② 兩參數版 —— 完全等價，Spring 幫你把 exchange 填成空字串
        rabbit.convertAndSend(Q, "B：convertAndSend(Q, body)");

        // ③ 用最原始的 AMQP 客戶端送：exchange 參數逃不掉
        try (Connection c = raw()) {
            Channel ch = c.createChannel();
            ch.basicPublish("", Q, null, "C：basicPublish(\"\", Q, ...)".getBytes());
        }

        // ④ 把 broker 上所有 exchange 列出來
        // ⑤ 看看這個佇列有哪些 binding（我一條都沒宣告）
        // ⑥ 把 routing key 改成 "ch04.default"（少了 .q）再送一則
        // ⑦ 試著自己綁一條「別名」到預設 exchange
        // ⑧ 試著刪掉預設 exchange
    }
}
```

**輸出**：

```
═══ 4.2.1 你一直在用的那個 exchange ═══
  ① convertAndSend("", "ch04.default.q", body) → 積壓 = 2
  ② basicPublish(exchange="", routingKey="ch04.default.q") → 積壓 = 3

  📌 AMQP 協定的 basic.publish 有兩個必填參數：exchange 與 routing key。
     「不指定 exchange」在協定上不存在 —— 你填的是空字串，而空字串是一個真的 exchange。

── broker 上實際有哪些 exchange（rabbitmqctl list_exchanges）──
  name	type	durable	internal
  	direct	true	false            ← 名字是空的，型別是 direct
  amq.fanout	fanout	true	false
  amq.topic	topic	true	false
  amq.rabbitmq.trace	topic	true	true
  amq.match	headers	true	false
  amq.direct	direct	true	false
  amq.headers	headers	true	false

── 這個佇列的 binding（我沒有宣告任何 binding）──
  source_name  destination_name  routing_key
               ch04.default.q    ch04.default.q     ← 自動產生的

  ③ routing key 改成 "ch04.default"（少了 .q）→ 積壓 = 3（沒變）

── 試著自己綁一條「別名」到預設 exchange ──
  ❌ IOException: channel error; protocol method: #method<channel.close>(reply-code=403,
     reply-text=ACCESS_REFUSED - operation not permitted on the default exchange,
     class-id=50, method-id=20)

── 試著刪掉預設 exchange ──
  ❌ IOException: channel error; protocol method: #method<channel.close>(reply-code=403,
     reply-text=ACCESS_REFUSED - operation not permitted on the default exchange,
     class-id=40, method-id=20)
```

**這段輸出說了四件事**：

| 觀察 | 結論 |
|---|---|
| 第一列 exchange 的 `name` 是空的、`type` 是 `direct` | **預設 exchange 是一個 direct exchange，名字是空字串** |
| 我沒宣告任何 binding，但 `list_bindings` 有一條 | **每建一個佇列，broker 自動把它綁到預設 exchange，binding key = 佇列名** |
| routing key 少兩個字元（`.q`）→ 積壓沒變 | 它是 direct 型，**routing key 必須完全相等**。差一個字就被丟掉（[01 章 1.3.1](./01-reliable-delivery-three-hops.md) 那個事故） |
| 綁 binding 與刪除都是 `403 ACCESS_REFUSED` | **你不能改它。** 它是 broker 內建的，不是一個普通 exchange |

📌 **所以 `convertAndSend("order.q", body)` 的完整意思是**：

```
送到「名字是空字串的那個 direct exchange」，routing key 是 "order.q"
   → 那個 exchange 找到一條 binding key = "order.q" 的 binding
   → 那條 binding 指向佇列 order.q
   → 訊息進去
```

**你一直在走完整的路由流程，只是每一步都剛好是預設值。**

> ⚠️ 那六個 `amq.` 開頭的 exchange 也是 broker 內建的（`amq.direct`、`amq.topic`、
> `amq.fanout`、`amq.headers`、`amq.match`、`amq.rabbitmq.trace`）。
> **不要用它們。** 它們是給「懶得自己建 exchange」的情境用的，
> 而在正式專案裡，用內建的 exchange 等於**所有服務共用一個命名空間** ——
> 你沒辦法用權限把它們分開，也沒辦法從名字看出是誰的。

### 4.2.2 三個東西，各自負責什麼

```
   生產者                                                     消費者
     │                                                          │
     │ basic.publish(exchange, routingKey, body)                │
     ▼                                                          │
  ┌────────────┐   binding(key)   ┌──────────┐   basic.consume  │
  │  exchange  │─────────────────▶│  queue   │◀─────────────────┘
  │            │                  └──────────┘
  │  「規則」   │   binding(key)   ┌──────────┐
  │            │─────────────────▶│  queue   │
  └────────────┘                  └──────────┘
        ▲                              ▲
        │                              │
   生產者只認這個              消費者只認這個
```

| | 是什麼 | 誰決定它 | 存不存訊息 |
|---|---|---|---|
| **exchange** | 一組**路由規則**。收到訊息，決定要複製給哪幾個佇列 | 生產者端的契約 | ❌ **不存**。找不到佇列就丟掉 |
| **queue** | 一個**有序的訊息緩衝區** | 消費者端的所有物 | ✅ 存 |
| **binding** | 一條「exchange → queue」的規則，帶一個 **binding key** | **消費者端宣告**（「我要聽這種訊息」） | —— |

⚠️ **最容易搞混的兩個名詞**：

| | 誰帶著它 | 什麼時候用 |
|---|---|---|
| **routing key** | **訊息**帶著它（`basic.publish` 的參數） | 每一則訊息都有一個 |
| **binding key** | **binding** 帶著它（`queueBind` 的參數） | 建立 binding 時設定一次 |

**exchange 做的事就是：拿訊息的 routing key，去比對所有 binding 的 binding key。**
怎麼比對，取決於 exchange 的型別 —— 那就是 4.3。

📌 **exchange 不存訊息，這件事有兩個後果，都很重要**：

1. **沒有佇列綁上去的 exchange，訊息全部丟掉**（[01 章 1.3.1](./01-reliable-delivery-three-hops.md)
   那個「500 則、0 個例外」）。`publisher-returns` 就是為了抓這件事。
2. **「這個 exchange 積壓多少」這個問題沒有意義。** 積壓只存在於佇列上。
   管理介面的 Exchanges 分頁只有速率沒有積壓，原因就是這個。

### 4.2.3 這個設計買到了什麼

**一句話：生產者不需要知道有誰在聽。**

```java
// 生產者。上線三年，這一行沒改過。
rabbit.convertAndSend("order.x", "order.created.vip", event);
```

- 第一年只有「寄信」在聽 → 一個佇列綁 `order.created.#`。
- 第二年加了「倉儲」→ **新增一個佇列 + 一條 binding**。生產者一行都不用改。
- 第三年風控說「VIP 的我要」→ **再加一條 binding**。生產者還是一行都不用改。

⚠️ **這正是預設 exchange 做不到的事**：預設 exchange 的 routing key 就是佇列名，
所以「送到 `order.q`」這件事**把生產者跟那個特定佇列焊死了**。
要加第二個消費者，你只有兩條路：改生產者送兩次，或是換掉那個消費者。

📌 **這就是本章的核心判斷**：

> **只要你預期「未來可能有第二個人想聽這件事」，就不要用預設 exchange。**
> 而在事件驅動的系統裡，這個「預期」幾乎總是成立的。

**預設 exchange 什麼時候是對的？** 當語意真的是「派工」而不是「事件」的時候：

```java
// ✅ 這是合理的：一個明確的、只有一個處理者的工作
rabbit.convertAndSend("", "pdf-render.q", job);
```

**「產這張 PDF」不是一個事件，是一個指令**，而指令天生只有一個收件人。
（[00 章 0.4.4](./00-course-map-why-message-queue.md) 那張表的第一列。）

---

## 4.3 四種 exchange

### 4.3.1 實測：同一則訊息送進四種，分別落在哪幾個佇列

建四個 exchange，每個綁三個佇列，然後送**同一則訊息**進去：
routing key = `order.created.vip`，header = `{type=order, level=vip}`。

```java
package com.example.lab11.ch04;

@SpringBootTest
class F1FourExchangeTypesTest {

    @Test
    void sameMessageIntoFourExchangeTypes() {
        admin.declareExchange(new DirectExchange("ch04.direct.x", true, false));
        admin.declareExchange(new TopicExchange("ch04.topic.x", true, false));
        admin.declareExchange(new FanoutExchange("ch04.fanout.x", true, false));
        admin.declareExchange(new HeadersExchange("ch04.headers.x", true, false));

        // direct：三種 binding key
        bind("ch04.d1.q", "ch04.direct.x", "order.created.vip");
        bind("ch04.d2.q", "ch04.direct.x", "order.created");
        bind("ch04.d3.q", "ch04.direct.x", "order.*");
        // topic：三種 binding key
        bind("ch04.t1.q", "ch04.topic.x", "order.created.vip");
        bind("ch04.t2.q", "ch04.topic.x", "order.*");
        bind("ch04.t3.q", "ch04.topic.x", "order.#");
        // fanout：故意給三種完全不同的 binding key
        bind("ch04.f1.q", "ch04.fanout.x", "");
        bind("ch04.f2.q", "ch04.fanout.x", "order.created.vip");
        bind("ch04.f3.q", "ch04.fanout.x", "完全不相關的鍵");
        // headers：x-match 的 all 與 any
        bindArgs("ch04.h1.q", "ch04.headers.x", Map.of("x-match", "all", "type", "order", "level", "vip"));
        bindArgs("ch04.h2.q", "ch04.headers.x", Map.of("x-match", "any", "type", "order", "level", "svip"));
        bindArgs("ch04.h3.q", "ch04.headers.x", Map.of("x-match", "all", "type", "order", "level", "svip"));

        MessagePostProcessor withHeaders = m -> {
            m.getMessageProperties().setHeader("type", "order");
            m.getMessageProperties().setHeader("level", "vip");
            return m;
        };
        for (String x : List.of(dx, tx, fx, hx))
            rabbit.convertAndSend(x, "order.created.vip", "同一則訊息", withHeaders);
        // ... 印出每個佇列的積壓
    }
}
```

**輸出**：

```
═══ 4.3.1 同一則訊息送進四種 exchange，分別落在哪幾個佇列 ═══
  訊息：routing key = "order.created.vip"，header = {type=order, level=vip}

  ── ch04.direct.x（direct）──
    ch04.d1.q    binding key = "order.created.vip"（完全相同）        → ✅ 收到
    ch04.d2.q    binding key = "order.created"（前綴）              → ❌ 沒收到
    ch04.d3.q    binding key = "order.*"（direct 不吃萬用字元）         → ❌ 沒收到

  ── ch04.topic.x（topic）──
    ch04.t1.q    binding key = "order.created.vip"（完全相同）        → ✅ 收到
    ch04.t2.q    binding key = "order.*"（一段）                    → ❌ 沒收到
    ch04.t3.q    binding key = "order.#"（零到多段）                  → ✅ 收到

  ── ch04.fanout.x（fanout）──
    ch04.f1.q    binding key = ""（空字串）                          → ✅ 收到
    ch04.f2.q    binding key = "order.created.vip"              → ✅ 收到
    ch04.f3.q    binding key = "完全不相關的鍵"                        → ✅ 收到

  ── ch04.headers.x（headers）──
    ch04.h1.q    x-match=all, {type=order, level=vip}           → ✅ 收到
    ch04.h2.q    x-match=any, {type=order, level=svip}          → ✅ 收到
    ch04.h3.q    x-match=all, {type=order, level=svip}          → ❌ 沒收到

  四則訊息（每種 exchange 各一則）→ 總共落進 8 個佇列
```

### 4.3.2 逐行解讀

**① direct：binding key 必須跟 routing key 完全相等。**

`ch04.d3.q` 綁的是 `order.*` —— 在 direct exchange 上，
**那不是萬用字元，那是一個字面上叫做 `order.*` 的鍵**。
⚠️ **這是一個真的會發生的錯誤**：以為自己在用 topic，實際上宣告的是 direct，
於是那個 `order.*` binding 永遠一則都收不到，而且**沒有任何錯誤訊息**。

**② topic：`*` 是「剛好一段」，`#` 是「零到多段」。**

`order.created.vip` 有三段。`order.*` 要求「`order` + 剛好一段」= 兩段 → 不匹配。
`order.#` 要求「`order` + 零到多段」→ 匹配。
👉 **4.4 會把這件事完整測一遍，它值得一整節。**

**③ fanout：binding key 被完全忽略。**

三個佇列的 binding key 分別是空字串、一個像樣的 key、跟一串中文 —— **三個都收到了**。
fanout 的規則是「綁上來的全部給一份」，routing key 連看都不看。

📌 **所以 fanout 不是「比較簡單的 topic」，它是「明確表達『這是廣播』」。**
用 topic + `#` 也可以做到一樣的事，但下一個人讀你的設定時，
`fanout` 一眼就知道意圖，`#` 則要想一下。

**④ headers：用 header 比對，`x-match` 決定「全中」還是「中一個就好」。**

| 佇列 | `x-match` | 條件 | 訊息的 header | 結果 |
|---|---|---|---|---|
| `h1` | `all` | `type=order` **且** `level=vip` | `{type=order, level=vip}` | ✅ 兩個都中 |
| `h2` | `any` | `type=order` **或** `level=svip` | 同上 | ✅ `type` 中了 |
| `h3` | `all` | `type=order` **且** `level=svip` | 同上 | ❌ `level` 不合 |

⚠️ **headers exchange 在實務上很少用，而且通常是個警訊。**
理由有三個：① 效能比 topic 差（要逐一比對 map，不能用 trie）、
② 管理介面上很難一眼看懂路由、③ 幾乎所有「需要 headers」的需求，
**都可以用設計得好一點的 routing key 解決**。
📌 真正該用它的情境只有一種：**路由條件有多個維度，而且維度之間沒有階層關係**
（例如「地區 × 幣別 × 優先級」三個正交的軸）。硬塞進 routing key 會變成 `tw.twd.high` 這種
「順序錯了就全錯」的東西。

### 4.3.3 選哪一種

| 你的需求 | 用 | 理由 |
|---|---|---|
| 一個事件只有一個處理者，而且以後也不會變 | **預設 exchange** | 最少的東西。但這個「以後也不會變」通常是錯的 |
| 固定的幾種類型，各自去固定的佇列（`order.created` / `order.cancelled`） | **direct** | 意圖最明確、效能最好 |
| 路由規則有階層，而且**未來會長出新的訂閱者** | **topic** | 新訂閱者加一條 binding 就好 |
| 一個事實，所有人都要一份 | **fanout** | 意圖明確：這是廣播 |
| 多個正交維度的條件 | **headers** | 最後的選項。先想想能不能改 routing key |

📌 **一個值得做的自我檢查**：打開 `rabbitmqctl list_exchanges name type`，
看看你的專案裡 `direct` 跟 `topic` 的比例。
⚠️ **如果 `direct` 明顯偏多，那通常不是因為需求，
是因為「當初第一個人這樣寫，後面的人照抄」** —— 值得回頭看一下那些 exchange
是不是其實會長出第二個訂閱者。

> **一則訊息可以進好幾個佇列 —— 這就是扇出。**
> 上面的實驗總共送了四則訊息（每種 exchange 各一則），最後落進 **8 個佇列**。
> 光 fanout 那一則就變成三份。
> ⚠️ **這對容量規劃有直接影響**：broker 上的訊息數不等於生產者送出的訊息數，
> **它等於「送出量 × 平均扇出倍數」**。一個綁了 5 個佇列的 fanout exchange，
> 每秒 1,000 則的輸入，在 broker 上是每秒 5,000 則的寫入。

---

## 4.4 topic 的 `*` 與 `#` ★★

### 4.4.1 實測：六個 binding × 六個 routing key

這一節只做一件事，但它值得一整節：**把所有組合列出來。**

```java
package com.example.lab11.ch04;

@SpringBootTest
class F2TopicWildcardTest {

    @Test
    void starVsHash() {
        List<String> patterns = List.of("order.*", "order.#", "order.*.*",
                                        "*.created.#", "order.created.*", "#");
        List<String> keys = List.of("order", "order.created", "order.created.vip",
                                    "order.created.vip.tw", "payment.created.vip", "(空字串)");

        admin.declareExchange(new TopicExchange("ch04.wild.x", true, false));
        for (int i = 0; i < patterns.size(); i++)
            bind("ch04.w" + i + ".q", "ch04.wild.x", patterns.get(i));

        for (String k : keys) {
            purgeAll();
            rabbit.convertAndSend("ch04.wild.x", k.equals("(空字串)") ? "" : k, "m");
            // ... 印出哪幾個佇列收到了
        }
    }
}
```

**輸出**：

```
═══ 4.4.1 topic 的 * 與 # —— 六個 binding × 六個 routing key ═══

  送出的 routing key           order.*         order.#         order.*.*       *.created.#     order.created.* #
  ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
  order                       ·               ✅               ·               ·               ·               ✅
  order.created               ✅               ✅               ·               ✅               ·               ✅
  order.created.vip           ·               ✅               ✅               ✅               ✅               ✅
  order.created.vip.tw        ·               ✅               ·               ✅               ·               ✅
  payment.created.vip         ·               ·               ·               ✅               ·               ✅
  (空字串)                       ·               ·               ·               ·               ·               ✅
```

整理成規則：

| 符號 | 匹配 | 例子 |
|---|---|---|
| `*` | **剛好一段** | `order.*` 只匹配 `order.XXX` |
| `#` | **零到多段** | `order.#` 匹配 `order`、`order.a`、`order.a.b.c` |

**那「一段」可以是空的嗎？** 這個問題會影響「routing key 的某個欄位是 null」時的行為，所以量一下：

```java
    @Test
    void doesStarMatchAnEmptySegment() {
        // binding: order.*  /  order.*.vip  /  *
        // routing key: "order."  /  "order..vip"  /  ""
    }
```

```
═══ 4.4.1b topic 的「一段」可以是空的嗎 ═══

  送出的 routing key   order.*         order.*.vip     *
  "order."            ✅               ·               ·
  "order..vip"        ·               ✅               ·
  (空字串)               ·               ·               ·
```

📌 **兩個結論**：

1. **空段算一段。** `order.` 有兩段（第二段是空的），所以 `order.*` 匹配；
   `order..vip` 有三段（中間那段是空的），所以 `order.*.vip` 匹配。
2. ⚠️ **但空字串的 routing key 是「零段」，`*` 匹配不到它** ——
   只有 `#` 可以（4.4.1 那張表最後一列）。

⚠️ **第 1 點在實務上會這樣咬你**：
`String rk = "order." + level + ".created";` 而 `level` 是 `null` 或空字串時，
routing key 變成 `order..created` —— **它照樣會被 `order.*.created` 收到**，
所以你不會收到任何錯誤，只會在下游看到一堆 `level` 是空的訂單。
📌 **routing key 是用字串拼出來的，就一定要驗證每一段都非空。**


**這張表裡有四件事值得停下來看**：

**① `order.*` 收不到 `order.created.vip`。**

這是本章開頭提的那一條，也是實務上最常見的 topic 錯誤：

```
binding key = order.*
routing key = order.created.vip     → ❌ 收不到（三段 vs 要求兩段）
```

⚠️ **它的症狀是最糟的那一種**：程式沒有錯誤、broker 沒有警告、
生產者 `convertAndSend` 回傳成功、**消費者就是一則都收不到**。

**而且 [01 章 1.3.3](./01-reliable-delivery-three-hops.md) 那個 `publisher-returns`
在這裡有一個盲點，值得量出來**：

```java
    @Test
    void returnsCannotDetectPartialRouting() {
        // A：exchange 上只有 order.* 這一條 binding
        // B：多綁一條 # 的稽核佇列，送同一則訊息
    }
```

```
═══ 4.4.1c 有別人收到的時候，publisher-returns 救不救得了你 ═══

  A：只有 order.* 這條 binding，送 order.created.vip
     order.* 佇列收到 : 0 則
     publisher return : 1 次   ← 抓得到

  B：多綁一條 # 的稽核佇列，送同一則
     order.* 佇列收到 : 0 則   ← 還是沒收到
     # 佇列收到       : 1 則
     publisher return : 0 次   ← ⚠️ 抓不到了
```

📌 **`publisher-returns` 回答的問題是「這則訊息有沒有進到『任何一個』佇列」，
不是「有沒有進到『我期待的那個』佇列」。**

⚠️ **這件事跟 4.8.1 的建議正好衝突**：那裡說「建一個綁 `#` 的分析佇列很值得」，
而這裡證明**那個佇列會讓 `publisher-returns` 對所有路由錯誤失效**。

📌 **兩者都要的話，監控就不能只靠 return** ——
你需要的是「**每個佇列**的 `deliver` 速率是不是符合預期」，
而不是「有沒有 NO_ROUTE」。（10 章會設這個監控。）

**② `order.#` 收得到 `order` 本身。**

`#` 是「零到多段」，所以 `order.#` 匹配 `order`。
📌 **這常常是你要的**，但也常常不是 —— 如果你的意思是「`order` 底下的所有事件，
但不包含 `order` 這個裸鍵本身」，`#` 就太寬了。

**③ `#` 匹配空字串的 routing key。**

`#` 是唯一會匹配空 routing key 的 pattern。
👉 這對「稽核 / 分析佇列」很有用（4.8.1 那個綁 `#` 的分析佇列就是這樣），
⚠️ **但也代表它會收到那些「路由 key 忘了填」的訊息** —— 這其實是個好處，
因為那些訊息本來會無聲消失，現在至少會出現在你的分析佇列裡。

**④ `payment.created.vip` 跑進了 `*.created.#`。**

這提醒你：**`*` 也可以放在第一段**。
`*.created.#` 的意思是「任何領域的 created 事件」，
在做跨領域稽核時很好用，但如果你不小心這樣綁了生產佇列，
**別的團隊新增一個 `shipment.created` 事件時，你的消費者會突然收到不認識的東西。**

### 4.4.2 routing key 該怎麼設計

📌 **一句話：從左到右，由粗到細，而且左邊的段位永遠不能變。**

```
   <領域>   .   <事件>    .   <細分>
   order    .   created   .   vip
   payment  .   failed    .   card
   shipment .   delayed   .   overseas
```

**為什麼左邊不能變？** 因為所有 binding 都是從左邊開始比對的。
你把 `order.created.vip` 改成 `created.order.vip`，
**所有綁 `order.#` 的消費者立刻全部失聯**，而且沒有任何錯誤。

⚠️ **一個很常見的設計陷阱**：把「會變的東西」放進 routing key。

```
❌ order.created.vip.tw.20260921        ← 日期
❌ order.created.customer-88213          ← 客戶 ID
❌ order.created.380000                  ← 金額
```

**放進去的每一段，都是一個未來的 binding 維護成本。**
routing key 是**路由用的**，不是拿來傳資料的 —— 資料放 body。

📌 **判斷標準：「會有人想用這一段來訂閱嗎？」**
沒有人會訂閱「金額剛好 380000 的訂單」，所以金額不該進 routing key。
但「VIP 的訂單」會有人訂閱，所以 `vip` 可以進。

### 4.4.3 ⚠️ 加一段，就會有人失聯

這是 4.8.1 那個實驗**刻意留下的一個瑕疵**，先看它的輸出：

```
  送出 routing key = order.high-value.vip     OrderCreated[ORD-3, 380000]
    ch04.shop.confirm-mail.q ·        ← 沒收到！
    ch04.shop.warehouse.q    ·        ← 沒收到！
    ch04.shop.risk.q         ✅ 收到 1 則
    ch04.shop.analytics.q    ✅ 收到 1 則
```

**這是一張真的訂單，但寄信跟倉儲都沒收到。**

原因：寄信與倉儲綁的是 `order.created.#`，
而有人為了讓風控收到高額訂單，把 routing key 從 `order.created.vip`
改成了 `order.high-value.vip`。

⚠️ **這是 routing key 設計最貴的一課**：

> **routing key 的每一段都是一份契約。**
> 改掉任何一段 = 悄悄地解除了某些人的訂閱，而且**沒有任何一方會收到錯誤**。

**正確的做法是「加一條 binding，不是改一個 routing key」**：

```java
// ❌ 錯：改 routing key（會讓既有訂閱者失聯）
rabbit.convertAndSend("order.x", "order.high-value.vip", event);

// ✅ 對：routing key 不變，讓風控多綁一條 binding
rabbit.convertAndSend("order.x", "order.created.vip", event);
// 風控端：
@Bean Binding riskHighValue() {
    return BindingBuilder.bind(riskQ()).to(orderX()).with("order.created.vip");
}
// 「金額 > 10 萬」這個條件在風控自己的程式裡判斷 —— 它本來就不是路由問題
```

📌 **一條判斷原則**：
**如果一個條件「未來可能會改數字」（金額門檻、天數、比例），它就不該進 routing key。**
`10 萬` 這個門檻改成 `5 萬` 的那一天，你不會想去改所有 binding。

---

## 4.5 訊息轉換器：那串 `\xac\xed` ★★★

### 4.5.1 實測：`convertAndSend` 一個 Java 物件，線路上是什麼

前三章送的都是字串，所以這個地雷沒被踩到。現在送一個物件：

```java
package com.example.lab11.ch04.v1;

public class OrderCreated implements Serializable {       // ← 注意這個 Serializable
    private String orderId;
    private long amount;
    // getter / setter / toString
}
```

```java
package com.example.lab11.ch04;

@SpringBootTest
class F3MessageConverterTest {

    @Test
    void whatIsActuallyOnTheWire() throws Exception {
        OrderCreated evt = new OrderCreated("ORD-1001", 29900);

        // ① 用 Boot 給你的 RabbitTemplate 直接送
        rabbit.convertAndSend("", Q, evt);
        // 再用原生客戶端把位元組原封不動撈出來看
        GetResponse r = ch.basicGet(Q, true);
        System.out.println(dump(r.getBody(), 64));       // dump: 不可印的位元組印成 \xNN
        // ...
    }
}
```

**輸出**：

```
═══ 4.5.1 convertAndSend 一個 Java 物件，線路上到底是什麼 ═══

  ① RabbitTemplate 現在掛的轉換器 : org.springframework.amqp.support.converter.SimpleMessageConverter
     content_type : application/x-java-serialized-object
     payload_bytes: 118
     前 64 個位元組: \xac\xed\x00\x05sr\x00&com.example.lab11.ch04.v1.OrderCreated\x09\xc8;"D\x84n\xfb\x02\x00\x02J\x00\x06amou …
```

⚠️ **停下來看這一行。**

```
\xac\xed\x00\x05sr\x00&com.example.lab11.ch04.v1.OrderCreated …
└────┬────┘        └───────────────┬────────────────────────┘
  Java 序列化的魔數            你的套件名，明碼寫在訊息裡
  (0xACED = STREAM_MAGIC)
```

📌 **`\xac\xed\x00\x05` 是 Java 序列化格式的開頭**，你在任何地方看到這四個位元組，
就知道那是一個 `ObjectOutputStream` 的輸出。

**這代表三件事，每一件都是問題**：

| | |
|---|---|
| **只有 Java 讀得懂** | 想用 Python / Go / Node 寫一個消費者？不可能。你連 `payload` 在管理介面上都看不懂（會顯示 base64） |
| **套件名寫死在訊息裡** | 生產者改套件名 → 消費者炸（下一節實測） |
| **欄位改動的相容性由 `serialVersionUID` 管** | 而 99% 的人沒有明寫 `serialVersionUID`，於是**加一個欄位就會 `InvalidClassException`** |

⚠️ **這是 Spring AMQP 的預設行為，而且 Boot 不會幫你換掉。**
`RabbitTemplate` 預設掛的是 `SimpleMessageConverter`：
`String` / `byte[]` 原樣送，**其他任何 `Serializable` 物件 → Java 序列化**。

### 4.5.2 實測：上游改個套件名，下游全部炸掉

上游把 `com.example.lab11.ch04.v1` 重構成 `...v2`（這是一次很平常的重構）。
在線路上，這只是那 118 個位元組裡的一個字元從 `1` 變成 `2`：

```java
        String from = "com.example.lab11.ch04.v1.OrderCreated";
        String to   = "com.example.lab11.ch04.v2.OrderCreated";   // 長度一樣，且不存在
        byte[] patched = new String(javaBytes, ISO_8859_1).replace(from, to).getBytes(ISO_8859_1);
        ch.basicPublish("", Q, props, patched);
        // 消費者照舊 receiveAndConvert
```

**輸出**：

```
  ② 把線路上那串類別名 v1 → v2（模擬「上游把套件改名了」）
     長度變了嗎 : 118 → 118
     ❌ 消費者炸了 : MessageConversionException → com.example.lab11.ch04.v2.OrderCreated
```

**一個字元。整個消費者停擺。**

⚠️ **而且這個故障的形狀特別惡劣**：

- 上游的人**完全不知道**自己做了破壞性變更 —— 他只是按了 IDE 的 Rename Package。
- 上游的測試全部會過（他那邊的類別是一致的）。
- 下游的消費者一路丟例外 → 預設設定會 requeue →
  **變成 [00 章 0.5.2](./00-course-map-why-message-queue.md) 那個三秒 11,191 次的風暴。**
- 而且那些訊息**還在佇列裡**，你得先修好程式才能處理它們。

### 4.5.3 那換成 JSON 就安全了嗎？

換上 `Jackson2JsonMessageConverter`：

```java
RabbitTemplate json = new RabbitTemplate(rabbit.getConnectionFactory());
json.setMessageConverter(new Jackson2JsonMessageConverter());
json.convertAndSend("", Q, evt);
```

**輸出**：

```
  ③ 換成 Jackson2JsonMessageConverter
     content_type : application/json
     payload_bytes: 37
     payload      : {"orderId":"ORD-1001","amount":29900}
     headers      : {__TypeId__=com.example.lab11.ch04.v1.OrderCreated}

  ── 兩種格式的大小 ──
     Java 序列化 : 118 bytes
     JSON        : 37 bytes  （31%）
```

**好消息**：payload 是人看得懂的 JSON，而且只有 Java 序列化的 **31% 大小**。

⚠️ **壞消息在最後一行**：

```
headers : {__TypeId__=com.example.lab11.ch04.v1.OrderCreated}
```

**套件名沒有消失，它搬到 header 上去了。**

```
  ④ 那 JSON 就安全了嗎？把 __TypeId__ 這個 header 的 v1 改成 v2
     ❌ 消費者炸了 : MessageConversionException → com.example.lab11.ch04.v2.OrderCreated
```

📌 **完全一樣的故障。** 換 JSON 解決了「跨語言」跟「payload 看不懂」，
**但沒有解決「型別耦合」** —— 因為 `Jackson2JsonMessageConverter` 預設的
`typePrecedence` 是 `TYPE_ID`：**訊息上寫什麼型別，它就試著載入什麼型別。**

### 4.5.4 真正的答案：`@RabbitListener` 預設就免疫 ★★

**大家最常查到的解法是 `DefaultClassMapper.setDefaultType()`。實測它：**

```java
Jackson2JsonMessageConverter safeA = new Jackson2JsonMessageConverter();
DefaultClassMapper cm = new DefaultClassMapper();
cm.setDefaultType(OrderCreated.class);
safeA.setClassMapper(cm);
```

```
  ⑤ 正解 A：DefaultClassMapper.setDefaultType() —— 消費端說了算
     ❌ IllegalArgumentException → The class 'com.example.lab11.ch04.v2.OrderCreated' is not in
        the trusted packages: [java.util, java.lang]. If you believe this class is safe to
        deserialize, please provide its name. If the serialization is only done by a trusted
        source, you can also enable trust all (*).
```

⚠️ **它沒有救到你。** 錯誤訊息甚至變得更難懂了。

**原因**：`DefaultClassMapper` 的 `defaultType` **只在「訊息上沒有 `__TypeId__`」時才會用**。
只要那個 header 存在，它就會照著 header 去找類別 ——
找不到就撞上「信任套件清單」那道牆，丟 `IllegalArgumentException`。

**那 `DefaultClassMapper` 什麼時候有用？** 當訊息**真的沒有** `__TypeId__` 的時候
—— 也就是**生產者不是 Spring（Python、Go、或別的語言）**的時候：

```
  ⑤b 同一顆 DefaultClassMapper，但這次訊息「沒有」__TypeId__ header
     沒設 classMapper  : java.util.LinkedHashMap → {orderId=ORD-1001, amount=29900}
     設了 defaultType  : com.example.lab11.ch04.v1.OrderCreated → OrderCreated[ORD-1001, 29900]
```

⚠️ **先不要下結論。** 上面那兩行是用 `fromMessage()` 直接測轉換器的結果，
而「沒設 classMapper 就會拿到 `LinkedHashMap`」這句話，**在 `@RabbitListener` 上是不成立的**
—— 下一節會證明。

**真正的答案：`@RabbitListener` 早就已經免疫了，而且是預設行為。**

先把預設值印出來（不要憑印象）：

```java
Jackson2JsonMessageConverter c = new Jackson2JsonMessageConverter();
System.out.println(c.getJavaTypeMapper().getTypePrecedence());
```

```
═══ 4.5.4 到底是誰擋掉了壞掉的 __TypeId__ ═══
  Jackson2JsonMessageConverter 預設的 typePrecedence : INFERRED
```

⚠️ **預設就是 `INFERRED`。** 那為什麼 ④ 還是炸了？

因為 **`INFERRED` 的意思是「有推得出來的型別就用它，推不出來才退回 `__TypeId__`」** ——
而「推得出來」的前提是**有人告訴轉換器目標型別是什麼**。
`@RabbitListener` 的 adapter 會做這件事（把方法參數的型別寫進
`MessageProperties.inferredArgumentType`），**`RabbitTemplate.receiveAndConvert()` 不會。**

四種情況一次測完：

```java
package com.example.lab11.ch04;

@SpringBootTest
class F3bInferredTypeTest {

    @Component
    static class L {
        @RabbitListener(queues = Q)
        void onMessage(OrderCreated e) { received.set(e.toString()); }   // ← 方法參數宣告了型別
    }

    @Test
    void whoActuallyFixesTheBrokenTypeId() throws Exception {
        byte[] json = "{\"orderId\":\"ORD-1001\",\"amount\":29900}".getBytes();
        String broken = "com.example.lab11.ch04.v2.OrderCreated";   // 不存在的類別
        // ① RabbitTemplate.receiveAndConvert
        // ② @RabbitListener(OrderCreated e)，轉換器完全用預設的
        // ③ 預設轉換器 + 手動 setInferredArgumentType
        // ④ 把 typePrecedence 改成 TYPE_ID
    }
}
```

**輸出**：

```
  ① RabbitTemplate.receiveAndConvert（沒有方法參數可推型別）
     ❌ MessageConversionException → com.example.lab11.ch04.v2.OrderCreated

  ② @RabbitListener(OrderCreated e)，轉換器用完全預設的
     → OrderCreated[ORD-1001, 29900]

  ③ 預設轉換器 + 手動 setInferredArgumentType
     → OrderCreated[ORD-1001, 29900]

  ④ typePrecedence=TYPE_ID + 同樣有 inferredArgumentType
     ❌ IllegalArgumentException → The class 'com.example.lab11.ch04.v2.OrderCreated' is not in
        the trusted packages: [java.util, java.lang]. ...
```

📌 **這四行把責任歸屬釘死了**：

| | 有「推得出來的型別」嗎 | 結果 |
|---|---|---|
| ① `receiveAndConvert()` | ❌ 沒有 | **炸** |
| ② `@RabbitListener(OrderCreated e)` | ✅ 方法參數 | ✅ **預設就安全** |
| ③ 手動 `setInferredArgumentType` | ✅ | ✅（②的內部機制長這樣） |
| ④ `typePrecedence = TYPE_ID` | ✅ 但被要求忽略 | **炸** —— 你手動把保護關掉了 |

**所以正確的結論是這三句，而不是「要設定什麼」**：

> **① `@RabbitListener` + 明確的方法參數型別 = 預設就免疫。什麼都不用設。**
>
> **② 危險的是 `RabbitTemplate.receiveAndConvert()`、
> 以及方法參數寫成 `Object` / 原始 `Map` 的 listener** —— 它們沒有型別可推，
> 於是回頭聽訊息上的 `__TypeId__`。
>
> **③ ⚠️ 最危險的是「有人為了解決別的問題，把 `typePrecedence` 設成 `TYPE_ID`」。**
> 那一行 commit 通常寫著「修正型別轉換問題」，而它其實是**把保護關掉**。

⚠️ **④ 那個錯誤訊息還揭露了第二道防線**：
`The class '...' is not in the trusted packages: [java.util, java.lang]`。
`DefaultJackson2JavaTypeMapper` 有一份**信任套件清單**，預設只有 `java.util` 與 `java.lang`。
📌 所以就算走 `TYPE_ID` 那條路，攻擊者也不能叫你載入任意類別 ——
**除非有人設了 `setTrustedPackages("*")`，而那是網路上最常被複製貼上的一行。**

**那 `DefaultClassMapper` 呢？** 它的用途是「**沒有** `__TypeId__` 的訊息」，也就是外部系統送來的 JSON
（4.5.4 前面那個 ⑤b 就是在測這件事）：

**那「外部系統送來、完全沒有 `__TypeId__`」的 JSON 呢？**
⑤b 用 `fromMessage()` 量到的是 `LinkedHashMap`，
但那是「沒有型別可推」的路徑。**換成真的 `@RabbitListener` 再量一次**：

```java
package com.example.lab11.ch04;

@Component
static class L {
    @RabbitListener(queues = LQ)
    void onMessage(OrderCreated e) { delivered.incrementAndGet(); failure.set(String.valueOf(e)); }
}

// 用原生客戶端送一則「沒有任何 header」的 JSON
ch.basicPublish("", LQ, new AMQP.BasicProperties.Builder()
        .contentType("application/json").build(),          // ← 沒有 __TypeId__
        "{\"orderId\":\"ORD-1\",\"amount\":100}".getBytes());
```

**輸出**：

```
═══ 4.5.4b 訊息沒有 __TypeId__ 時，listener 會怎樣 ═══
  送一則沒有 __TypeId__ 的 JSON 給 @RabbitListener(OrderCreated e)
     listener 方法被呼叫了 1 次
     收到的物件 : OrderCreated[ORD-1, 100]
     佇列積壓 = 0

  對照組：同一則訊息用 receiveAndConvert() 讀
     拿到的型別 : java.util.LinkedHashMap
     內容        : {orderId=ORD-1, amount=100}
```

⚠️ **`@RabbitListener` 直接拿到了完整的 `OrderCreated`，連 `DefaultClassMapper` 都不需要。**

📌 **所以 `INFERRED` 這個預設值買到的是三件事，不是一件**：

| 訊息上的 `__TypeId__` | `@RabbitListener(OrderCreated e)` | `receiveAndConvert()` |
|---|---|---|
| **正確** | ✅ | ✅ |
| **壞掉的**（上游改了套件名） | ✅ **不受影響** | ❌ 炸 |
| **完全沒有**（外部系統送的） | ✅ **直接轉成 `OrderCreated`** | ⚠️ 拿到 `LinkedHashMap` |

**完整的決策表**：

| 你的情境 | 該怎麼做 |
|---|---|
| `@RabbitListener` 方法參數有明確型別 | **什麼都不用設。** 三種情況都對 |
| 要用 `RabbitTemplate.receiveAndConvert()` | 改用 `receive()` + `fromMessage(msg, Class)`，或 `receiveAndConvert(queue, ParameterizedTypeReference)` |
| 真的沒有型別可推（listener 參數是 `Object` / 通用轉發） | `DefaultClassMapper` + `setDefaultType()` |
| 看到程式碼裡有 `setTypePrecedence(TYPE_ID)` 或 `setTrustedPackages("*")` | ⚠️ **回頭問清楚為什麼** |

📌 **這張表顛覆了一件事**：網路上關於「Spring AMQP 的 JSON 型別問題」的文章，
**大多數在教你設定 `DefaultClassMapper` 或 `setTrustedPackages`** ——
而 4.5.4 的四個實測顯示，**只要你的 listener 方法參數寫了明確型別，那些設定一個都不需要**，
其中一個（`TYPE_ID`）甚至會**把保護關掉**。

### 4.5.5 順帶一提：Java 反序列化的允許清單，預設是空的

回到 4.5.1 那支測試（`F3MessageConverterTest`）的最後一段：

```java
var smc = new SimpleMessageConverter();
var fld = AllowedListDeserializingMessageConverter.class.getDeclaredField("allowedListPatterns");
fld.setAccessible(true);
System.out.println(fld.get(smc));
```

```
  ⑦ SimpleMessageConverter 預設的反序列化允許清單
     allowedListPatterns = []  ← 空的 = 什麼類別都反序列化
```

⚠️ **空的清單表示「不設限」，不是「都不准」。**

`SimpleMessageConverter` 繼承自 `AllowedListDeserializingMessageConverter`。
沒設清單時，任何進入這個佇列的位元組都會被送進 `ObjectInputStream` ——
**那是 Java 反序列化攻擊的標準入口**（攻擊者送一段精心構造的位元組，
在你的 JVM 裡執行程式碼，完全不需要你的類別配合）。

**如果你因為任何理由必須繼續用 Java 序列化，至少要設清單**：

```java
SimpleMessageConverter converter = new SimpleMessageConverter();
converter.setAllowedListPatterns(List.of("com.example.shop.event.*"));
```

📌 **但更好的答案是：不要用 Java 序列化。**
上面那三件事（跨語言、可讀性、型別耦合）任何一件都足以說服你，
而這第四件（反序列化攻擊面）讓它變成一個**不需要討論的決定**。

### 4.5.6 事件物件的相容性規則

換成 JSON 之後，你還是需要一套規則，否則改一個欄位一樣會出事。

| 變更 | JSON + `INFERRED` | 安全嗎 |
|---|---|---|
| **加一個欄位** | 舊消費者忽略它（Jackson 預設 `FAIL_ON_UNKNOWN_PROPERTIES=true`⚠️） | ⚠️ **要先關掉那個預設** |
| **刪一個欄位** | 新消費者拿到 `null` / `0` | ⚠️ 要確認下游有處理 |
| **改欄位型別** | `String` → `long` 之類 | ❌ **不安全**，等於換一個事件 |
| **改欄位名** | 舊消費者拿到 `null` | ❌ **不安全** |
| **改 Java 套件名** | 完全沒事 | ✅ ⚠️ **前提是消費端用 `@RabbitListener` + 明確方法參數型別**（4.5.4） |

⚠️ **那個 `FAIL_ON_UNKNOWN_PROPERTIES` 一定要關**，否則「加一個欄位」就變成破壞性變更：

```java
@Bean
MessageConverter jsonMessageConverter() {
    ObjectMapper om = JsonMapper.builder()
            .disable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES)   // ← 這一行
            .build();
    return new Jackson2JsonMessageConverter(om);
    // ⚠️ 不需要碰 typePrecedence —— 4.5.4 實測它預設就是 INFERRED
}
```

📌 **注意這個 bean 只有一行是必要的**：關掉 `FAIL_ON_UNKNOWN_PROPERTIES`。
型別安全那部分**什麼都不用設**（4.5.4）。

📌 **兩條規則就夠了**：

1. **只能加欄位，不能刪、不能改名、不能改型別。**
2. **真的要改，就發一個新事件**（`order.created.v2`），
   讓新舊兩個事件並行一段時間，等所有消費者都搬過去再停掉舊的。

> ⚠️ **這一節沒有處理事件版本管理的完整做法**（schema registry、相容性檢查、
> 契約測試）—— 那是一個獨立的主題，不在本課範圍。
> 這裡只給「不會立刻出事」的最低標準。

---

## 4.6 拓撲宣告該寫在哪 ★★★

[01 章 1.4.1](./01-reliable-delivery-three-hops.md) 留下了這句話：

> ⚠️ **`durable` 是佇列的不可變屬性。** 佇列一旦建立，`durable` 就不能改了。
> 你重新宣告一個同名但 `durable` 不同的佇列，會得到
> `PRECONDITION_FAILED - inequivalent arg 'durable' for queue 'xxx'`。
> 👉 **04 章 4.6 會講「拓撲宣告該寫在哪、怎麼安全地改」。**

現在來看它到底有多貴。

### 4.6.1 實測：改一個屬性，整批宣告一起死

場景：一個上線三個月的服務，有兩個佇列 `a`、`b`。
這次要發版：**幫 `b` 加上死信交換器**（很合理的需求，06 章就會這樣做），
順便新增兩個佇列 `c`、`d`。

```java
package com.example.lab11.ch04;

@SpringBootTest
class F4TopologyDeclarationTest {

    @Test
    void inequivalentArgTakesDownTheWholeChannel() {
        // 第一次部署：a、b 兩個 durable 佇列
        admin.declareQueue(new Queue("ch04.topo.a.q", true, false, false));
        admin.declareQueue(new Queue("ch04.topo.b.q", true, false, false));

        // 第二次部署：b 加了 DLX，同一批還新增 c、d
        GenericApplicationContext ctx = new GenericApplicationContext();
        ctx.registerBean("a", Queue.class, () -> new Queue("ch04.topo.a.q", true, false, false));
        ctx.registerBean("b", Queue.class, () -> QueueBuilder.durable("ch04.topo.b.q")
                .deadLetterExchange("ch04.dlx").build());          // ← 唯一的改動
        ctx.registerBean("c", Queue.class, () -> new Queue("ch04.topo.c.q", true, false, false));
        ctx.registerBean("d", Queue.class, () -> new Queue("ch04.topo.d.q", true, false, false));
        ctx.refresh();

        RabbitAdmin deploying = new RabbitAdmin(cf);
        deploying.setApplicationContext(ctx);
        deploying.afterPropertiesSet();     // ← Spring 啟動時就是做這件事
        // ... 印出 broker 上實際有哪些佇列
    }
}
```

**輸出**：

```
═══ 4.6.1 改一個佇列屬性，整批宣告一起死 ═══

  ── 第一次部署（上線三個月了）──
    ch04.topo.a.q    存在（積壓 0）
    ch04.topo.b.q    存在（積壓 0）
    ch04.topo.c.q    不存在
    ch04.topo.d.q    不存在

  ── 第二次部署：有人幫 b 加了 x-dead-letter-exchange，同一批還新增 c 與 d ──
    ❌ 宣告丟了例外 : AmqpIOException → channel error; protocol method:
       #method<channel.close>(reply-code=406, reply-text=PRECONDITION_FAILED -
       inequivalent arg 'x-dead-letter-exchange' for queue 'ch04.topo.b.q' in vhost '/':
       received the value 'ch04.dlx' of type 'longstr' but current is none,
       class-id=50, method-id=10)
    這一步花了 : 12,073 ms（RabbitAdmin 內建 RetryTemplate 會重試）

  ── 宣告完之後，broker 上實際有什麼 ──
    ch04.topo.a.q    存在（積壓 0）
    ch04.topo.b.q    存在（積壓 0）
    ch04.topo.c.q    不存在      ← 沒建起來
    ch04.topo.d.q    不存在      ← 沒建起來
```

⚠️ **停下來看最後兩行。**

**`c` 與 `d` 是全新的佇列，跟 `b` 完全無關，但它們沒有被建立。**

**原因是 AMQP 的一個協定特性**：

```
一條 channel 上：
   queueDeclare(a)  ✅
   queueDeclare(b)  ❌ 406 PRECONDITION_FAILED
                    └──▶ broker 直接把「整條 channel」關掉
   queueDeclare(c)     ← 這時候 channel 已經死了，根本送不出去
   queueDeclare(d)     ← 同上
```

📌 **AMQP 的錯誤不是「這個操作失敗」，是「這條 channel 從此作廢」。**
`RabbitAdmin` 的所有宣告都在**同一條 channel** 上跑，
所以**一個失敗會帶走它後面的全部**。

⚠️ **而「後面的全部」是哪些，取決於 bean 的宣告順序** ——
`RabbitAdmin` 是用 `applicationContext.getBeansOfType(Queue.class)` 拿到清單的，
**那個順序是你的 `@Configuration` 裡方法出現的順序**。
換句話說：**你的哪幾個佇列會消失，取決於你當初把方法寫在哪一行。**

**還有第二個代價：那 12 秒。**

`RabbitAdmin.afterPropertiesSet()` 內建一個 `RetryTemplate`，失敗會重試。
日誌上你會看到同一個錯誤出現**五次**，間隔大約 1s / 2s / 4s / 5s / 5s：

```
17:46:56 ERROR ... PRECONDITION_FAILED - inequivalent arg 'x-dead-letter-exchange' ...
17:46:57 ERROR ... （同上）
17:46:59 ERROR ... （同上）
17:47:03 ERROR ... （同上）
17:47:08 ERROR ... （同上）
```

**在 Kubernetes 上，這 12 秒可能就是你的 readiness probe 的全部預算。**

### 4.6.2 那 Spring Boot 會不會因此拒絕啟動？

這是一個直接影響你部署流程的問題，所以量出來：

```java
    @Test
    void whatSpringDoesWhenDeclarationFailsAtStartup() {
        admin.declareQueue(new Queue("ch04.startup.q", true, false, false));   // 既有：durable

        // 新版程式把它宣告成 durable=false
        ctx.registerBean("q", Queue.class, () -> new Queue("ch04.startup.q", false, false, false));

        // ① 預設
        RabbitAdmin a2 = new RabbitAdmin(cf);
        a2.setApplicationContext(ctx);
        a2.afterPropertiesSet();

        // ② 打開 ignoreDeclarationExceptions
        RabbitAdmin a3 = new RabbitAdmin(cf);
        a3.setApplicationContext(ctx);
        a3.setIgnoreDeclarationExceptions(true);
        a3.afterPropertiesSet();
    }
```

**輸出**：

```
═══ 4.6.2 宣告失敗的時候，Spring Boot 會不會拒絕啟動 ═══
  broker 上既有的佇列 : ch04.startup.q durable=true

  ① RabbitAdmin 預設（ignoreDeclarationExceptions = false）
     ❌ AmqpIOException → channel error; protocol method: #method<channel.close>(
        reply-code=406, reply-text=PRECONDITION_FAILED - inequivalent arg 'durable'
        for queue 'ch04.startup.q' in vhost '/': received 'false' but current is 'true',
        class-id=50, method-id=10)

  ② 把 ignoreDeclarationExceptions 打開
     afterPropertiesSet() 沒丟例外 → 服務會正常啟動
     但 broker 上那個佇列 durable 改成 false 了嗎 : 沒有，還是原來的

  ③ Boot 自動組態那顆 RabbitAdmin 的 ignoreDeclarationExceptions 預設值
     false
```

📌 **三個結論**：

| | |
|---|---|
| **宣告是在 `afterPropertiesSet()` 發生的** | 不是「第一次送訊息時」。**服務一啟動就會撞上** |
| **預設會丟例外 → 服務啟動失敗** | ⚠️ 這其實是**好事**：你在部署時就知道了，而不是上線三天後才發現 |
| **`ignoreDeclarationExceptions=true` 只是不吵** | **佇列的屬性還是舊的。** 服務啟起來了，但它以為的拓撲跟 broker 上的不一樣 |

⚠️ **`ignoreDeclarationExceptions=true` 是一個危險的「解法」。**
它把一個「部署時就會發現」的問題，變成「上線後某天才會發現」的問題 ——
而且發現的形式通常是「為什麼訊息沒有進死信佇列」。

### 4.6.3 三種策略

| | 誰建拓撲 | 好處 | 代價 |
|---|---|---|---|
| **A：`@Bean` 宣告** | 應用程式啟動時 | 拓撲跟程式在同一個 repo、同一次 code review、本機一跑就有 | ⚠️ 服務需要**設定 broker 的權限**；4.6.1 那個故障；每個服務都要小心別動到別人的佇列 |
| **B：`@RabbitListener` 自動宣告** | 同上，但更隱性 | 最少的程式碼 | ⚠️ **拓撲散落在各個 listener 上**，沒有一個地方看得到全貌 |
| **C：完全不讓應用程式碰** | 部署流程（Terraform / `rabbitmqadmin` 腳本 / 平台團隊） | 拓撲變更走正式流程、應用程式只需要讀寫權限、不會有 4.6.1 那種啟動失敗 | 拓撲與程式分在兩個 repo，**很容易不同步**；本機開發要先跑一個建拓撲的腳本 |

**A 長這樣**（最常見，也是本站 4.8.3 與 [06 章 6.9](./06-rabbitmq-retry-delay-and-cluster.md) 用的）：

```java
@Configuration
public class RabbitTopology {

    @Bean TopicExchange orderX() { return ExchangeBuilder.topicExchange("order.x").durable(true).build(); }

    @Bean Queue mailQ() { return QueueBuilder.durable("order.confirm-mail.q").build(); }

    @Bean Binding mailBinding() {
        return BindingBuilder.bind(mailQ()).to(orderX()).with("order.created.#");
    }
}
```

**B 長這樣**：

```java
@RabbitListener(bindings = @QueueBinding(
        value    = @Queue(name = "order.confirm-mail.q", durable = "true"),
        exchange = @Exchange(name = "order.x", type = ExchangeTypes.TOPIC, durable = "true"),
        key      = "order.created.#"))
public void onMessage(OrderCreated event) { ... }
```

⚠️ **關於 B，先破解一個很常見的說法**：
網路上不少文章說「`@Queue` 不寫 `durable` 就是非持久化佇列」。**實測不是這樣**：

```java
// ① 完全不寫 durable
@RabbitListener(bindings = @QueueBinding(
        value = @Queue(name = "ch04.qb.nodurable.q"), ...))
// ② 明寫 durable = "true"
@RabbitListener(bindings = @QueueBinding(
        value = @Queue(name = "ch04.qb.durable.q", durable = "true"), ...))
// ③ queuesToDeclare
@RabbitListener(queuesToDeclare = @Queue(name = "ch04.qb.declare.q"))
```

```
═══ 4.6.3 @QueueBinding / @Queue 的 durable 預設是什麼 ═══
  @Queue.durable() 這個註解屬性的預設值 : ""

  name	durable	auto_delete	exclusive
  ch04.qb.declare.q	true	false	false
  ch04.qb.nodurable.q	true	false	false
  ch04.qb.durable.q	true	false	false

  ── docker restart rabbit-lab 之後 ──
  name	durable
  ch04.qb.declare.q	true
  ch04.qb.nodurable.q	true
  ch04.qb.durable.q	true
```

📌 **註解屬性的預設值是空字串 `""`，而 Spring AMQP 3.1.4 把空字串解析成 `durable=true`。**
而且三個佇列**真的過了一次 `docker restart`** —— `durable` 的意思就是這個
（[01 章 1.4.1](./01-reliable-delivery-three-hops.md) 那張四種組合表）。

**所以 B 真正的壞處不是 `durable`，是「拓撲散落在各個 listener 上」**：
你要回答「這個服務總共宣告了哪些佇列與 binding」，
**只能靠 grep**，而不是打開一個檔案就看到全貌。
⚠️ 而那正是 4.6.1 那種故障最需要的東西 —— 你得先知道宣告順序，才知道誰會被帶走。

**C 長這樣**（拓撲是一份可以 review 的檔案）：

```bash
# topology.sh —— 走 CI/CD，不在應用程式裡
docker exec rabbit-lab rabbitmqadmin -u lab -p lab \
  declare exchange name=order.x type=topic durable=true
docker exec rabbit-lab rabbitmqadmin -u lab -p lab \
  declare queue name=order.confirm-mail.q durable=true
docker exec rabbit-lab rabbitmqadmin -u lab -p lab \
  declare binding source=order.x destination=order.confirm-mail.q routing_key='order.created.#'
```

> ⚠️ **`rabbitmqadmin` 有一個坑**：它處理不了空字串參數
> （`source=""` 會噴 `KeyError: 'source'` 的 Python traceback）。
> 要操作預設 exchange，只能用 AMQP 客戶端或管理介面的 HTTP API。

📌 **本站的建議**：

> **小團隊、服務數量 < 10 → 用 A。** 拓撲跟程式在一起的價值遠大於它的風險。
> **多團隊共用一台 broker → 用 C。** 因為 A 的前提是「每個服務都可以宣告拓撲」，
> 而那等於「每個服務都有可能改壞別人的佇列」。
> **任何情況下都不要只用 B。** 要用也要搭配 A，讓拓撲有一個集中的地方。

⚠️ **不管用哪一種，都要把「消費者聽的佇列」與「生產者送的 exchange」分開想**：
生產者**不該**宣告佇列（它不知道有誰在聽，也不該知道），
消費者**不該**宣告別人的 exchange（除非那個 exchange 本來就是它的）。

### 4.6.4 實測：要改一個不可變屬性，唯一安全的流程

現況：`ch04.mig.mail.q` 已經上線、有 300 則積壓、**而且還在收新訊息**。
需求：幫它加上 `x-dead-letter-exchange`（不可變參數，改不了）。

```java
package com.example.lab11.ch04;

@SpringBootTest
class F7SafeMigrationTest {

    @Test
    void addAnArgumentWithoutLosingAnything() {
        // 步驟 1：建「新名字」的佇列，帶上想要的參數，並且也綁到同一個 exchange
        admin.declareQueue(QueueBuilder.durable(V2).deadLetterExchange("ch04.mig.dlx").build());
        admin.declareBinding(new Binding(V2, QUEUE, X, RK, null));

        // 步驟 2：解掉舊 binding（新訊息只進 V2）
        admin.removeBinding(new Binding(V1, QUEUE, X, RK, null));

        // 步驟 3：把舊佇列消化乾淨（這段期間消費者兩個佇列都要聽）
        while (d(V1) > 0) { if (rabbit.receive(V1, 200) != null) drained++; else break; }

        // 步驟 4：確認積壓是 0，才刪
        admin.deleteQueue(V1);
    }
}
```

**輸出**：

```
═══ 4.6.4 要改一個不可變屬性，唯一安全的做法 ═══

  步驟 0：現況 —— ch04.mig.mail.q 積壓 = 300（而且沒有 DLX 參數）
  步驟 1：新佇列上線、兩邊都綁 order.created
          ch04.mig.mail.q        積壓 = 400
          ch04.mig.mail.v2.q     積壓 = 100   ← 新訊息開始進來了

  步驟 2：解掉舊 binding
          ch04.mig.mail.q        積壓 = 400   ← 不再增加
          ch04.mig.mail.v2.q     積壓 = 200

  步驟 3：舊佇列消化完 —— 共處理 400 則，積壓 = 0
  步驟 4：刪掉舊佇列（積壓 = 0，確認是 0 才能刪）

  結果：ch04.mig.mail.q 不存在 = true，ch04.mig.mail.v2.q 積壓 = 200

  ── 對帳 ──
     生產者總共送出        : 500 則
     舊佇列處理掉          : 400 則
     新佇列裡還有          : 200 則
     合計                  : 600 則  ← 比送出的多 100 則
     ⚠️  步驟 1 那 100 則「兩個 binding 都命中」的訊息，被複製成兩份。
        → 雙綁期間一定會有重複，所以這個流程的前提是消費者已經冪等（03 章）。
```

📌 **最後三行是這一節真正的重點。**

**「同時綁兩個佇列」這個手法，代價是那段期間的訊息會被處理兩次。**
所以這個遷移流程**有一個前置條件**：

> ⚠️ **你的消費者必須先是冪等的**（[03 章](./03-idempotent-consumer.md)），
> 否則這個「安全」的遷移流程，會讓 100 位客戶收到兩封確認信。

**完整的 SOP**：

| 步驟 | 做什麼 | 驗證點 |
|---|---|---|
| **0** | 確認消費者是冪等的 | 送同一則訊息兩次，業務結果一樣 |
| **1** | 建 `xxx.v2.q`（帶新參數），綁**同一條** binding key | 兩邊積壓都在增加 |
| **2** | 消費者**同時聽兩個佇列**，部署 | 兩個佇列的積壓都在下降 |
| **3** | 解掉舊佇列的 binding | 舊佇列積壓**不再增加** |
| **4** | 等舊佇列積壓歸零 | `messages` 與 `messages_unacknowledged` **都是 0** |
| **5** | 刪掉舊佇列、消費者拿掉舊佇列、部署 | —— |

⚠️ **步驟 4 要看兩個數字，不是一個。**
`messages=0` 但 `messages_unacknowledged=3` 表示還有三則在某個消費者手上
（[01 章 1.5.1](./01-reliable-delivery-three-hops.md) 的第三種狀態）。
這時候刪掉佇列，那三則就真的沒了。

### 4.6.5 哪些屬性是不可變的

📌 **一句話：佇列宣告時傳的東西，幾乎都不可變。**

| 屬性 | 可變？ | 改了會怎樣 |
|---|---|---|
| `durable` | ❌ | `PRECONDITION_FAILED - inequivalent arg 'durable'` |
| `exclusive` / `auto-delete` | ❌ | 同上 |
| `x-dead-letter-exchange` / `x-dead-letter-routing-key` | ❌ 宣告不可變<br>⚠️ **沒宣告過的話，可以用 policy 補** | 同上（4.6.1 實測的就是這個） |
| `x-max-priority` | ❌ | 同上（06 章 6.6 會用到） |
| `x-queue-type`（classic / quorum） | ❌ | 同上（06 章 6.7） |
| `x-message-ttl` / `x-max-length` / `x-max-length-bytes` | ❌ 宣告不可變<br>⚠️ **沒宣告過的話，可以用 policy 補** | 見下方 |
| **binding** | ✅ | binding 不是佇列的屬性，隨時可以加減 |

**那個「可以用 policy 補」是一個很有用的逃生門** —— 它不碰佇列宣告，所以不會撞上 `PRECONDITION_FAILED`：

```bash
# 不改佇列宣告，用 policy 幫一批佇列加上 TTL
docker exec rabbit-lab rabbitmqctl set_policy ttl-1h "^order\." \
  '{"message-ttl":3600000}' --apply-to queues
```

📌 **policy 是 broker 端的設定，可以隨時改、隨時套用到一批佇列上。**

**但 policy 與宣告參數同時存在時，誰贏？實測**：

```java
// A：宣告時完全沒有 DLX 參數
admin.declareQueue(new Queue("ch04.pol.noarg.q", true, false, false));
// B：宣告時就指定 DLX = ch04.pol.dlx.declared.x
admin.declareQueue(QueueBuilder.durable("ch04.pol.witharg.q")
        .deadLetterExchange("ch04.pol.dlx.declared.x").build());

// 再套一條 policy，把兩個佇列的 DLX 都設成 ch04.pol.dlx.policy.x
// rabbitmqctl set_policy ch04-dlx '^ch04\.pol\.(noarg|witharg)' \
//   '{"dead-letter-exchange":"ch04.pol.dlx.policy.x"}' --apply-to queues
```

**輸出**：

```
═══ 4.6.5 policy 與宣告參數，誰贏 ═══

  套上 policy：^ch04\.pol\. → dead-letter-exchange = ch04.pol.dlx.policy.x
  name                  policy    effective_policy_definition
  ch04.pol.noarg.q      ch04-dlx  [{<<"dead-letter-exchange">>, ch04.pol.dlx.policy.x}]
  ch04.pol.witharg.q    ch04-dlx  [{<<"dead-letter-exchange">>, ch04.pol.dlx.policy.x}]

  ── 死信落點 ──
     ch04.pol.noarg.q      （宣告時沒設 DLX）
        → policy 指的死信佇列 = 1，宣告指的 = 0
     ch04.pol.witharg.q    （宣告時設了 DLX）
        → policy 指的死信佇列 = 0，宣告指的 = 1  ← 宣告參數贏
```

⚠️ **看第二列的陷阱**：`effective_policy_definition` 那一欄**兩個佇列都顯示 policy 生效了**，
但實際的死信卻走了宣告參數那條路。

📌 **規則：宣告時傳的 `x-` 參數優先級高於 policy。**
**而 `list_queues` 的 `policy` 欄位只告訴你「有一條 policy 套用到這個佇列」，
不告訴你「它有沒有真的生效」。**

⚠️ **policy 有一個容易被忘記的性質：它會在你「沒宣告」的地方補上設定，而且它不在你的 repo 裡。**
一個本機行為正常、正式環境卻莫名其妙有 TTL 或長度上限的佇列，
**第一個要查的就是 `rabbitmqctl list_policies`。**

📌 **反過來說，這也是一個很好的營運手段**：
正式環境出事的時候，你可以**不改一行程式、不重啟服務**，
用一條 policy 立刻幫一批佇列加上長度上限或 TTL，止血之後再回頭改程式。

---

## 4.7 多環境共用一台 broker

`dev` / `staging` / `prod` 各一台 broker 當然最乾淨，但實務上常常不是這樣 ——
尤其是 `dev` 與 `staging`。這一節量兩種做法。

### 4.7.1 實測：vhost 隔離

**vhost（virtual host）是 RabbitMQ 的命名空間。**
不同 vhost 裡的 exchange、queue、binding、policy、使用者權限**完全獨立**。

```bash
docker exec rabbit-lab rabbitmqctl add_vhost staging
docker exec rabbit-lab rabbitmqctl set_permissions -p staging lab ".*" ".*" ".*"
```

```java
package com.example.lab11.ch04;

@SpringBootTest
class F5MultiEnvTest {

    @Test
    void sameQueueNameDifferentVhost() throws Exception {
        CachingConnectionFactory stagingCf = new CachingConnectionFactory("localhost", 5673);
        stagingCf.setUsername("lab"); stagingCf.setPassword("lab");
        stagingCf.setVirtualHost("staging");                    // ← 唯一的差別
        RabbitAdmin stagingAdmin = new RabbitAdmin(stagingCf);
        RabbitTemplate stagingRabbit = new RabbitTemplate(stagingCf);

        // 兩邊都建「一模一樣名字」的佇列
        prodAdmin.declareQueue(new Queue("order.confirm-mail.q", true, false, false));
        stagingAdmin.declareQueue(new Queue("order.confirm-mail.q", true, false, false));

        for (int i = 0; i < 10; i++) prodRabbit.convertAndSend("", Q, "prod-" + i);
        for (int i = 0; i < 3;  i++) stagingRabbit.convertAndSend("", Q, "staging-" + i);
        // ...
    }
}
```

**輸出**：

```
═══ 4.7.1 同一台 broker、同一個佇列名字，兩套環境互不干擾 ═══
  vhost "/"        order.confirm-mail.q 積壓 = 10
  vhost "staging"  order.confirm-mail.q 積壓 = 3

── broker 全域看到的佇列（rabbitmqctl 加上 --vhost）──
  name	messages
  order.confirm-mail.q	10
  order.analytics.q	0
  order.warehouse.q	0
  order.risk.q	0
  name	messages
  order.confirm-mail.q	3

── 連到一個不存在的 vhost ──
  ❌ IOException → connection error; protocol method: #method<connection.close>(
     reply-code=530, reply-text=NOT_ALLOWED - vhost typo-staging not found,
     class-id=10, method-id=40)

── 對照組：不用 vhost，改用前綴 ──
  prod.order.confirm-mail.q        積壓 = 1
  staging.order.confirm-mail.q     積壓 = 0
  送到 "stagin.order.confirm-mail.q"（前綴打錯一個字）→ 無聲丟棄
```

📌 **注意輸出裡最關鍵的一行差別**：

| 做法 | 設定打錯的後果 |
|---|---|
| **vhost** | `530 NOT_ALLOWED - vhost typo-staging not found` —— **連線直接失敗，服務起不來** |
| **前綴** | **無聲丟棄。** 訊息進 broker、broker 丟掉、沒有例外（[01 章 1.3.1](./01-reliable-delivery-three-hops.md)） |

⚠️ **這一條差別，本身就足以決定選哪一個。**

**vhost 打錯 → 你在啟動的那一秒就知道了。**
**前綴打錯 → 你在三天後對帳時才知道，而且那三天的訊息已經沒了。**

### 4.7.2 兩種做法的完整對照

| | **vhost** | **前綴 / 後綴** |
|---|---|---|
| Spring 設定 | `spring.rabbitmq.virtual-host: ${ENV}` | 每一個佇列名、exchange 名都要接一個變數 |
| 打錯設定 | ✅ **連線失敗，立刻知道** | ❌ **無聲丟棄** |
| 權限隔離 | ✅ 可以讓 `staging` 的帳號完全看不到 `prod` | ❌ 只能用 regex 做權限，很容易寫漏 |
| 管理介面 | ✅ 有 vhost 下拉選單，一次只看一套 | ❌ 所有環境的佇列混在同一張清單 |
| policy | ✅ 各自獨立 | ⚠️ policy 的 pattern 要記得帶前綴，漏了就會套到所有環境 |
| 資源隔離 | ⚠️ **沒有。** 同一台機器、同一份記憶體與磁碟 | ⚠️ 同上 |
| 程式碼改動量 | **一行設定** | 每一個佇列名都要改 |

📌 **結論很清楚：能用 vhost 就用 vhost。**

```yaml
# application.yml
spring:
  rabbitmq:
    host: ${RABBIT_HOST}
    virtual-host: ${RABBIT_VHOST:/}      # dev → /dev、staging → /staging
    username: ${RABBIT_USER}
    password: ${RABBIT_PASS}
```

⚠️ **但 vhost 沒有解決的那一件事要講清楚**：
**vhost 是命名空間，不是資源隔離。**
`staging` 的壓測把 broker 的記憶體吃光，`prod` 一樣會被流控（flow control）擋住。

📌 **所以本站的建議是**：

> **`prod` 用獨立的 broker。`dev` / `staging` 可以共用一台，用 vhost 分開。**
>
> 理由：`dev` / `staging` 的流量小、出事的成本低，共用省下的維運成本是真的。
> 而 `prod` 跟任何東西共用，你就永遠有一個「別人把我打掛」的風險 ——
> 那個風險的代價，遠大於一台 broker 的錢。

**什麼時候不得不用前綴？**

- broker 是託管服務，而你的方案**不支援多 vhost**（有些便宜方案是這樣）。
- 你要隔離的**不是環境，是租戶**，而租戶數量是動態的（幾百幾千個）——
  這時候幾千個 vhost 會變成 broker 的負擔。

⚠️ **真的要用前綴，就一定要搭配 `publisher-returns`**（[01 章 1.3.3](./01-reliable-delivery-three-hops.md)），
否則「前綴打錯」這件事你永遠不會知道。

---

## 4.8 落地：一個 exchange，四個消費者

### 4.8.1 實測：新增一個消費者，生產者一行都不用改

```java
package com.example.lab11.ch04;

@SpringBootTest
class F6ShopTopologyTest {

    @TestConfiguration
    static class Topology {
        @Bean TopicExchange orderX() { return ExchangeBuilder.topicExchange("ch04.shop.x").durable(true).build(); }

        @Bean Queue mailQ() { return QueueBuilder.durable("ch04.shop.confirm-mail.q").build(); }
        @Bean Queue whQ()   { return QueueBuilder.durable("ch04.shop.warehouse.q").build(); }
        @Bean Queue riskQ() { return QueueBuilder.durable("ch04.shop.risk.q").build(); }
        @Bean Queue anaQ()  { return QueueBuilder.durable("ch04.shop.analytics.q").build(); }

        @Bean Binding bMail() { return BindingBuilder.bind(mailQ()).to(orderX()).with("order.created.#"); }
        @Bean Binding bWh()   { return BindingBuilder.bind(whQ()).to(orderX()).with("order.created.#"); }
        @Bean Binding bRisk1(){ return BindingBuilder.bind(riskQ()).to(orderX()).with("order.created.vip"); }
        @Bean Binding bRisk2(){ return BindingBuilder.bind(riskQ()).to(orderX()).with("order.high-value.#"); }
        @Bean Binding bAna()  { return BindingBuilder.bind(anaQ()).to(orderX()).with("#"); }

        @Bean MessageConverter jsonConverter() { return new Jackson2JsonMessageConverter(); }
    }

    @Component
    static class Consumers {
        @RabbitListener(queues = "ch04.shop.confirm-mail.q")
        void mail(OrderCreated e) { ... }
        @RabbitListener(queues = "ch04.shop.warehouse.q")
        void warehouse(OrderCreated e) { ... }
        @RabbitListener(queues = "ch04.shop.risk.q")
        void risk(OrderCreated e) { ... }
        @RabbitListener(queues = "ch04.shop.analytics.q")
        void analytics(OrderCreated e) { ... }
    }
}
```

**輸出**：

```
═══ 4.8.1 一個 exchange、四個消費者、生產者一行都不用改 ═══

  送出 routing key = order.created.normal     OrderCreated[ORD-1, 1200]
    ch04.shop.confirm-mail.q ✅ 收到 1 則
    ch04.shop.warehouse.q    ✅ 收到 1 則
    ch04.shop.risk.q         ·
    ch04.shop.analytics.q    ✅ 收到 1 則

  送出 routing key = order.created.vip        OrderCreated[ORD-2, 3500]
    ch04.shop.confirm-mail.q ✅ 收到 1 則
    ch04.shop.warehouse.q    ✅ 收到 1 則
    ch04.shop.risk.q         ✅ 收到 1 則
    ch04.shop.analytics.q    ✅ 收到 1 則

  送出 routing key = order.high-value.vip     OrderCreated[ORD-3, 380000]
    ch04.shop.confirm-mail.q ·
    ch04.shop.warehouse.q    ·
    ch04.shop.risk.q         ✅ 收到 1 則
    ch04.shop.analytics.q    ✅ 收到 1 則

  送出 routing key = order.cancelled          OrderCreated[ORD-4, 900]
    ch04.shop.confirm-mail.q ·
    ch04.shop.warehouse.q    ·
    ch04.shop.risk.q         ·
    ch04.shop.analytics.q    ✅ 收到 1 則

  ── broker 上的 binding 表 ──
  source_name	destination_name	routing_key
  ch04.shop.x	ch04.shop.analytics.q	#
  ch04.shop.x	ch04.shop.confirm-mail.q	order.created.#
  ch04.shop.x	ch04.shop.warehouse.q	order.created.#
  ch04.shop.x	ch04.shop.risk.q	order.created.vip
  ch04.shop.x	ch04.shop.risk.q	order.high-value.#
```

**這張輸出有三件事值得看**：

**① 一個佇列可以有多條 binding。** `order.risk.q` 綁了兩條
（`order.created.vip` 與 `order.high-value.#`），任何一條命中就收得到。

**② 綁 `#` 的那個分析佇列，是一份完整的事件流。**
📌 **這個「什麼都收」的佇列在實務上非常值得建**，它有三個用途：

- **驗證路由**：某則訊息「消費者說沒收到」時，先看它在不在 analytics 佇列裡 ——
  在的話是 binding 的問題，不在的話是生產者的問題。
- **接住孤兒訊息**：routing key 打錯的訊息，至少會留在這裡，而不是無聲消失。
- **未來的消費者**：新需求要「補跑上個月的訂單事件」時，你至少有資料。

⚠️ **但它有三個代價**：
① broker 上的訊息量會多一倍（`#` 的佇列會拿到**每一則**訊息）、
② **這個佇列一定要設長度上限或 TTL**，否則它會無限長大
（[05 章 5.6.2](./05-rabbitmq-reliability.md) 與 [06 章 6.4](./06-rabbitmq-retry-delay-and-cluster.md)）、
③ ⚠️ **它會讓 `publisher-returns` 對所有路由錯誤失效** —— 4.4.1c 實測過：
只要有任何一個佇列收到了，broker 就不會回 `NO_ROUTE`。

**③ `order.high-value.vip` 那一則，寄信跟倉儲都沒收到** —— 這是 4.4.3 講的那個瑕疵。

### 4.8.2 `@RabbitListener` 的幾個參數

```java
@RabbitListener(
    queues = "order.confirm-mail.q",         // 聽哪些佇列（可以多個）
    concurrency = "3-10",                    // ⚠️ 最少 3 個、最多 10 個消費者執行緒
    containerFactory = "myFactory",          // 用哪一組設定（prefetch、ack 模式…）
    id = "mail-listener"                     // 可以用來在執行期 start/stop
)
public void onMessage(OrderCreated event,
                      @Header(AmqpHeaders.RECEIVED_ROUTING_KEY) String routingKey,
                      @Header(name = "traceId", required = false) String traceId,
                      Message raw) {          // 想拿原始訊息（properties / redelivered）就加這個參數
    ...
}
```

⚠️ **`concurrency` 這個參數現在先不要用。**

它會開多個消費者執行緒 → **同一個佇列的訊息會被並行處理 → 順序沒了**
（[00 章 0.5.1](./00-course-map-why-message-queue.md) 最後那一段預告）。
👉 **05 章 5.5 會把這件事量出來，包含它到底錯得多離譜、以及唯一的解法。**

📌 **`@RabbitListener` 方法的回傳值有一個隱藏行為**：
如果方法**有回傳值**，Spring 會把它當成「RPC 的回覆」送回 `reply-to` 那個佇列。
所以事件消費者的方法**應該是 `void`** —— 寫了回傳值而沒有 `reply-to` 的話，
Spring 會在日誌裡抱怨，而且那個回傳值就消失了。

### 4.8.3 本章建議的設定

```yaml
spring:
  rabbitmq:
    host: ${RABBIT_HOST:localhost}
    port: ${RABBIT_PORT:5673}
    username: ${RABBIT_USER:lab}
    password: ${RABBIT_PASS:lab}
    virtual-host: ${RABBIT_VHOST:/}      # 4.7：用 vhost 分環境
```

```java
@Configuration
public class RabbitTopology {

    public static final String ORDER_X = "order.x";

    // ── exchange ──
    @Bean TopicExchange orderExchange() {
        return ExchangeBuilder.topicExchange(ORDER_X).durable(true).build();
    }

    // ── queue（durable，1.4.1 四種組合裡唯一安全的那一種）──
    @Bean Queue mailQueue()      { return QueueBuilder.durable("order.confirm-mail.q").build(); }
    @Bean Queue warehouseQueue() { return QueueBuilder.durable("order.warehouse.q").build(); }
    @Bean Queue analyticsQueue() { return QueueBuilder.durable("order.analytics.q").build(); }

    // ── binding ──
    @Bean Binding mailBinding() {
        return BindingBuilder.bind(mailQueue()).to(orderExchange()).with("order.created.#");
    }
    @Bean Binding warehouseBinding() {
        return BindingBuilder.bind(warehouseQueue()).to(orderExchange()).with("order.created.#");
    }
    @Bean Binding analyticsBinding() {
        return BindingBuilder.bind(analyticsQueue()).to(orderExchange()).with("#");
    }

    // ── 4.5：JSON，而且不要因為多一個欄位就炸 ──
    //    （typePrecedence 預設就是 INFERRED，不用設；這裡明寫是為了讓下一個人看得到）
    @Bean MessageConverter jsonMessageConverter() {
        ObjectMapper om = JsonMapper.builder()
                .disable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES)
                .build();
        Jackson2JsonMessageConverter converter = new Jackson2JsonMessageConverter(om);
        DefaultJackson2JavaTypeMapper mapper = new DefaultJackson2JavaTypeMapper();
        mapper.setTypePrecedence(Jackson2JavaTypeMapper.TypePrecedence.INFERRED);
        converter.setJavaTypeMapper(mapper);
        return converter;
    }
}
```

⚠️ **這份設定還缺三樣東西，都在後面兩章補上**：

| 缺什麼 | 為什麼現在不寫 | 在哪裡補 |
|---|---|---|
| `publisher-confirm-type` / `publisher-returns` | [01 章 1.3.3](./01-reliable-delivery-three-hops.md) 講了機制，還沒落地 | **05 章 5.2** |
| `acknowledge-mode: manual` + prefetch | 這兩個是 RabbitMQ「不懂就一定寫錯」的地方 | **05 章 5.3、5.4** |
| 死信交換器（DLX） | 少了它，任何一則處理不了的訊息都會變成 [00 章 0.5.2](./00-course-map-why-message-queue.md) 的風暴 | **06 章 6.2** |

📌 **順序是刻意的**：先有正確的拓撲（04），才談得上可靠性（05），最後才是失敗處理（06）。
拓撲錯了，後面兩章的設定全部是白做的。

---

## 4.9 常見誤區

**① 「我沒有用 exchange」**

4.2.1 實測：你在用一個名字是空字串的 direct exchange，
而且 broker 幫你的每個佇列都自動綁了一條 `binding key = 佇列名` 的 binding。
你不能刪它、不能加 binding（`403 ACCESS_REFUSED`）。

📌 **真正的問題不是「你用了它」，是「它把生產者跟一個特定佇列焊死了」**（4.2.3）。

**② 「`order.*` 會收到 `order.created.vip`」**

4.4.1 實測：**不會。** `*` 是「剛好一段」。
⚠️ 而這個錯誤的症狀是**完全無聲的**：程式沒錯、broker 沒警告、消費者就是收不到。

**③ 「direct exchange 上的 `order.*` 是萬用字元」**

4.3.1 實測：那是一個**字面上叫做 `order.*` 的 binding key**，永遠一則都收不到。
⚠️ 最常見的觸發方式是：`@Exchange` 忘了寫 `type = ExchangeTypes.TOPIC`
（`@Exchange` 的 `type` 預設是 `direct`）。

**④ 「Spring 送物件是用 JSON」**

4.5.1 實測：**不是。** 預設是 `SimpleMessageConverter` → **Java 序列化**，
線路上是 `\xac\xed\x00\x05` 加上你的套件名，118 bytes（JSON 只要 37）。
⚠️ 而且 Boot **不會**自動幫你換掉 —— 要自己宣告一顆 `MessageConverter` bean。

**⑤ 「改成 JSON 就不會有型別問題了」**

4.5.3 實測：Jackson 把套件名搬到 `__TypeId__` header 上，**一樣炸**。
📌 但 4.5.4 實測發現真正的答案是反過來的：**`@RabbitListener` 配上明確的方法參數型別，
預設就免疫** —— 會炸的是 `RabbitTemplate.receiveAndConvert()`
與「方法參數寫成 `Object`」的 listener。
⚠️ 而大家最常查到的 `DefaultClassMapper.setDefaultType()` **在這個情境下是無效的**，
而且 4.5.4b 實測發現它**在「訊息完全沒有 `__TypeId__`」時也不需要** ——
`@RabbitListener` 照樣拿到完整的 `OrderCreated`。

**⑤b 「外部系統送的 JSON 會變成 `LinkedHashMap`」**

4.5.4b 實測：**`@RabbitListener(OrderCreated e)` 拿到的是 `OrderCreated[ORD-1, 100]`**，
只有 `receiveAndConvert()` 才拿到 `LinkedHashMap`。
📌 差別在「有沒有型別可推」，不在「訊息長什麼樣」。

**⑤c 「開了 `publisher-returns` 就抓得到路由錯誤」**

4.4.1c 實測：**只要有任何一個佇列收到了，broker 就不回 `NO_ROUTE`。**
一個綁 `#` 的稽核佇列（4.8.1 才剛建議你建的那種）會讓它對**所有**路由錯誤失效。

**⑥ 「宣告失敗只影響那一個佇列」**

4.6.1 實測：`PRECONDITION_FAILED` 會**關掉整條 channel**，
所以同一批宣告裡**排在它後面的佇列全部沒建起來**，
而「後面」是誰，取決於你 `@Configuration` 裡方法的順序。

**⑦ 「`ignoreDeclarationExceptions=true` 可以解決拓撲衝突」**

4.6.2 實測：它只是**不吵**。佇列的屬性還是舊的，服務啟動了但拓撲跟你以為的不一樣。
📌 它把「部署時就會發現」的問題，變成「上線後某天才會發現」的問題。

**⑧ 「改佇列參數，改一下 `@Bean` 就好」**

4.6.4 實測：不可變屬性改不動，唯一安全的路是
**「新名字的佇列 → 雙綁 → 解舊 binding → 排乾 → 刪」**，
⚠️ 而且**前提是消費者已經冪等**（雙綁期間實測多出 100 則重複）。

**⑨ 「policy 設了就會生效」**

4.6.5 實測：`list_queues` 的 `policy` 欄位顯示 policy 套用了，
**但宣告時傳的 `x-` 參數優先級更高**，policy 那份設定實際上沒作用。

**⑩ 「多環境用前綴分開就好」**

4.7.1 實測：前綴打錯一個字 → **無聲丟棄**；vhost 打錯 →
`530 NOT_ALLOWED`，**服務直接起不來**。
📌 「壞得很大聲」在這裡是一個功能，不是缺點。

**⑪ 「routing key 裡多放一點資訊比較彈性」**

4.4.3 實測：把 `order.created.vip` 改成 `order.high-value.vip`，
綁 `order.created.#` 的寄信與倉儲**立刻失聯，而且沒有任何錯誤**。
📌 **routing key 的每一段都是一份契約。** 要加條件是**加 binding**，不是改 routing key。

**⑫ 「用 `amq.topic` 就不用自己建 exchange 了」**

技術上可以，但那等於**所有服務共用一個命名空間**：
你沒辦法用權限把它們分開，也沒辦法從名字看出那是誰的 exchange。
📌 自己建一個 `order.x` 的成本是一行 `@Bean`。

---

## 4.10 本章小結

**這一章證明了五件事**：

1. **你一直在用一個 exchange**（4.2）：空字串、direct 型、broker 自動綁 binding、
   你改不了它。而它的問題是**把生產者跟特定佇列焊死**。
2. **四種 exchange 的落點完全不同**（4.3、4.4）：同一則訊息進四種 exchange，
   12 個佇列裡 8 個收到。最該記住的是 **`order.*` 收不到 `order.created.vip`**，
   而且那個錯誤**完全無聲**。
3. **`convertAndSend` 送物件預設是 Java 序列化**（4.5）：
   `\xac\xed\x00\x05` + 明碼套件名、118 bytes（JSON 37 bytes）。
   換 JSON 只解決一半，`__TypeId__` 是第二顆地雷，**正解是 `INFERRED`**。
4. **拓撲宣告失敗會帶走整批**（4.6）：一個 `x-dead-letter-exchange` 不一致 →
   整條 channel 關掉 → **後面兩個全新的佇列沒建起來** → 重試 5 次、卡 12 秒。
   要改不可變屬性，唯一的路是雙綁遷移，**而它的前提是冪等消費者**。
5. **多環境用 vhost，不要用前綴**（4.7）：兩者的關鍵差別是
   **「設定打錯時，一個立刻炸、一個無聲丟棄」**。

📌 **把這一章放回全站的位置**：

```
   01 章   訊息會在三個地方掉        ← 機制
   02 章   Outbox 補上「送出前掛掉」  ← 生產端
   03 章   冪等消費補上「重複」       ← 消費端
   ─────────────────────────────────
   04 章   broker 上面長什麼樣子      ← 你現在在這裡
   05 章   讓它不掉（confirm / ack / prefetch）
   06 章   讓它失敗得有秩序（DLX / 重試 / 延遲）
```

### 4.10.1 驗收清單

做得到才往下走：

- [ ] 說出 `convertAndSend("order.q", body)` 在協定層面完整發生了什麼（4.2.1 那四行）。
- [ ] 說出 exchange / queue / binding 各自負責什麼，以及**哪一個存訊息**。
- [ ] 分辨 **routing key** 與 **binding key**（誰帶著它、什麼時候設定）。
- [ ] 說出「為什麼 exchange 的積壓這個問題沒有意義」。
- [ ] 不看課文畫出 4.3.1 那張表：同一則訊息進四種 exchange，哪幾個佇列收到。
- [ ] 說出 direct exchange 上綁 `order.*` 會發生什麼。
- [ ] 說出 `order.*`、`order.#`、`#` 對 `order`、`order.created.vip`、空字串各自的結果。
- [ ] 說出兩個 routing key 設計原則，以及「加條件要加 binding 而不是改 routing key」的理由。
- [ ] 說出 `\xac\xed\x00\x05` 是什麼，以及那則訊息裡還明碼寫了什麼。
- [ ] 說出 Java 序列化的三個問題，以及第四個（允許清單預設是空的）。
- [ ] 說出 `__TypeId__` 是什麼、為什麼換成 JSON 還是會炸。
- [ ] 說出 `DefaultClassMapper.setDefaultType()` **有用**跟**沒用**的情境各是什麼。
- [ ] 說出 `typePrecedence` 的預設值，以及 `INFERRED` 實際上的完整語意
      （提示：它不是「永遠用推論的型別」）。
- [ ] 說出為什麼 `@RabbitListener(OrderCreated e)` 預設就擋得住壞掉的 `__TypeId__`，
      而 `RabbitTemplate.receiveAndConvert()` 擋不住。
- [ ] 說出 `setTypePrecedence(TYPE_ID)` 與 `setTrustedPackages("*")` 這兩行為什麼危險。
- [ ] 寫出本站建議的 `MessageConverter` bean，並說出裡面**唯一真正必要**的那一行是什麼。
- [ ] 說出 `@RabbitListener` 在「__TypeId__ 正確 / 壞掉 / 完全沒有」三種情況下的結果。
- [ ] 說出 `publisher-returns` 抓不到哪一種路由錯誤，以及為什麼綁 `#` 的稽核佇列會讓它失效。
- [ ] 說出 `order..created` 這個 routing key 有幾段、會被哪些 binding 收到。
- [ ] 說出事件物件的兩條相容性規則。
- [ ] 解釋為什麼「改 b 的參數」會讓「全新的 c 與 d」建不起來。
- [ ] 說出宣告是在什麼時候發生的（不是第一次送訊息時）。
- [ ] 說出 `ignoreDeclarationExceptions=true` 實際上做了什麼、沒做什麼。
- [ ] 說出三種拓撲宣告策略各自的代價，並說出你的團隊該用哪一種、為什麼。
- [ ] 完整寫出「改不可變屬性」的六個步驟，以及步驟 4 要看**哪兩個**數字。
- [ ] 說出 policy 與宣告參數誰的優先級高，以及 `list_queues` 的 `policy` 欄位騙了你什麼。
- [ ] 說出 vhost 與前綴最關鍵的那一個差別。
- [ ] 說出 vhost **沒有**解決的那一件事。

### 4.10.2 本章練習

**練習一（15 分鐘）**：把 4.3.1 的實驗改一個地方 ——
把 `ch04.direct.x` 的型別從 `direct` 改成 `topic`（其他都不動），重跑。
**記錄哪幾個佇列的結果變了。** 然後回答：
如果你在正式環境做這個改動，會發生什麼？
（提示：先想想 exchange 的型別可不可以改 —— 試試看，記錄錯誤訊息。）

**練習二（20 分鐘）**：擴充 4.4.1 的矩陣。
加三個 binding：`*`、`*.#`、`order.#.vip`，
再加三個 routing key：`vip`、`order..vip`（中間是空段）、`ORDER.created.vip`（大寫）。
**記錄完整的矩陣**，然後回答三個問題：
① `*` 跟 `#` 對單段 key 的差別是什麼？
② 空段（`order..vip`）算幾段？
③ topic 比對**區分大小寫嗎**？

**練習三（25 分鐘）**：把 4.5.1 的實驗跑一次，但這次用 `rabbitmqadmin get` 把訊息撈出來看：

```bash
docker exec rabbit-lab rabbitmqadmin -u lab -p lab get queue=ch04.convert.q ackmode=ack_requeue_true
```

**記錄 `payload_encoding` 這一欄在 Java 序列化與 JSON 兩種情況下分別是什麼**
（提示：[00 章 0.7.1](./00-course-map-why-message-queue.md) 那張欄位表）。
然後在管理介面（<http://localhost:15673> → Queues → Get messages）上看同一則訊息，
**記錄你能不能看懂它**。

**練習四（25 分鐘）**：在 `OrderCreated` 上**加一個欄位** `String couponCode`，
生產者用新版送、消費者用舊版收（把舊版的 class 檔留一份）。
分別在**三種設定**下跑：
① `SimpleMessageConverter`（Java 序列化）
② `Jackson2JsonMessageConverter` 預設
③ ② 再加上 `disable(FAIL_ON_UNKNOWN_PROPERTIES)`
**記錄三種情況各自發生什麼。** ①那個錯誤訊息特別值得記下來。

**練習五（30 分鐘）**：重現 4.6.1，但這次**把 `b` 那個 bean 移到最後一個**。
**記錄 `c` 與 `d` 這次有沒有建起來。**
然後再跑一次，這次把每一個佇列用**各自的 `RabbitAdmin`** 宣告
（四顆 `RabbitAdmin` bean，各自的 `ApplicationContext`）。
**記錄結果，並解釋為什麼。**
👉 這一題做完，你就知道 4.6.1 那個故障的真正邊界在哪裡。

**練習六（30 分鐘）**：完整走一次 4.6.4 的六步遷移，但這次加上真正的消費者：

1. 一個 `@RabbitListener` 聽 `order.mail.q`，每則睡 50 ms。
2. 持續有生產者以每秒 20 則的速度送訊息。
3. 照 SOP 把佇列換成帶 DLX 的新佇列。
4. **記錄：整個過程中有沒有任何一則訊息遺失、有幾則被處理兩次。**

**練習七（進階，40 分鐘）**：設計一個「多租戶」的 routing key 方案。
需求：3 個租戶、每個租戶 4 種事件、有些消費者跨租戶（稽核）、有些只看單一租戶。
**畫出你的 exchange / queue / binding 表**，然後回答：
① 新增第 4 個租戶要改幾個地方？
② 新增第 5 種事件要改幾個地方？
③ 如果改成「每個租戶一個 vhost」，上面兩題的答案變成什麼？
④ 兩種方案在「稽核要看全部租戶」這個需求上，差多少？

**練習八（進階，30 分鐘）**：寫一支「拓撲稽核」腳本：
列出這台 broker 上所有的 exchange、queue、binding，
並找出三種問題 ——
① **沒有任何 binding 的 exchange**（訊息送進去會全部丟掉）、
② **沒有任何 binding 的 queue**（除了走預設 exchange 的）、
③ **`durable=false` 的 queue**。
**輸出一張表。** 這個東西在真實工作裡叫「拓撲稽核」，通常一跑就會找到東西。

---

## 4.11 下一章預告

這一章把 broker 上的東西攤開了，但**它完全沒有處理「會不會掉」**。

你現在寫得出正確的拓撲，但這份設定裡有三個洞：

```yaml
spring:
  rabbitmq:
    # ① 送出去之後，broker 到底收到沒有？            → 沒有 confirm
    # ② 路由不到任何佇列的訊息，你會知道嗎？          → 沒有 return
    # ③ 消費者做到一半掛掉，那則訊息會怎樣？           → acknowledge-mode 是預設值
```

[01 章 1.7](./01-reliable-delivery-three-hops.md) 那張三段總表上，
RabbitMQ 那一欄的每一格都指向 05 章 —— 現在要把它們全部落地。

**05 章會量四件事**：

- **publisher confirm 與 return 的完整實作**：[01 章 1.3.3](./01-reliable-delivery-three-hops.md)
  已經證明「兩個都要開」，05 章要回答**「收到 nack 之後你要做什麼」** ——
  而那個答案跟 [02 章的 Outbox](./02-outbox-and-transactional-consistency.md) 是同一件事。
- **手動 ack**：[00 章 0.4.1](./00-course-map-why-message-queue.md) 那個
  `receiveAndConvert` 讀走就沒了的問題，在這裡修掉。
- ⚠️ **`prefetch` —— 這一章最重要的一個數字。**
  [00 章 0.9.3](./00-course-map-why-message-queue.md) 說 RabbitMQ 有兩個
  「不懂就一定會寫錯」的東西，prefetch 是其中之一。
  它**同時**決定了三件看起來無關的事：
  **吞吐**（設 1 會慢多少）、**公平性**（一個慢消費者會不會餓死大家）、
  以及 **一次故障會牽連多少則訊息**（Boot 預設 250 意味著什麼）。
  05 章會把三件事分別量出來。
- ⚠️ **多消費者破壞順序**：[00 章 0.5.1](./00-course-map-why-message-queue.md) 留了一句
  「RabbitMQ 也有順序問題，而且更隱蔽」。
  05 章 5.5 會證明：**只要 `concurrency > 1`，單一佇列的 FIFO 就沒了**，
  而 RabbitMQ **沒有 Kafka 的 key 那種機制可以救**。
  唯一的解法只有兩個，而且兩個都很貴。

**還有一個 05 章會回答、但你現在可能沒想過的問題**：

> **消費者處理到一半，行程被 `kill -9`。那則訊息現在在哪裡？**
>
> [01 章 1.5.1](./01-reliable-delivery-three-hops.md) 給了機制（`unacked` 會回到 `ready`），
> **但沒有回答「它會等多久」** —— 而答案取決於**它是怎麼死的**。
> 05 章 5.7 用一個外部行程實測兩種死法：`kill -9` 是 **1 秒**，
> `kill -STOP`（行程凍住、TCP 還連著）是 **180 秒**。
> 那 180 秒裡，那些訊息在監控上**不算積壓**。
