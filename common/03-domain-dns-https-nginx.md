# 第三章：從申請網域到 HTTPS 上線 — 網域、DNS、憑證與前端 Nginx 實戰

> 這章把一個網站從「只有一台伺服器」到「使用者輸入網址就能用 HTTPS 安全連線」的完整流程串起來：
> **申請網域 → 把網域指向公開 IP → 申請 HTTPS 憑證 → 用 Nginx 把網域與憑證套到前端網站。**

---

## 3.1 整體流程概覽

在動手之前，先建立一張完整的地圖。後面每一節都是這張圖的其中一格：

```
①  申請網域                ②  網域指向公開 IP            ③  申請 HTTPS 憑證            ④  設定前端 Nginx
┌──────────────┐         ┌────────────────────┐       ┌────────────────────┐      ┌────────────────────┐
│ 在註冊商買    │         │ 在 DNS 設定          │       │ Let's Encrypt /     │      │ listen 443 ssl      │
│ example.com   │ ──────▶ │ A 紀錄              │ ────▶ │ Cloudflare /        │ ───▶ │ 套上憑證 + 網站根目錄 │
│               │         │ → 1.2.3.4 (公開IP)  │       │ 商業 CA              │      │ HTTP → HTTPS 重導向   │
└──────────────┘         └────────────────────┘       └────────────────────┘      └────────────────────┘
```

| 步驟 | 你要做的事 | 結果 |
|------|-----------|------|
| ① 申請網域 | 在網域註冊商付費註冊一個名字 | 你擁有 `example.com` 一年（或多年） |
| ② 指向 IP | 在 DNS 加上 A / AAAA / CNAME 紀錄 | 全世界輸入網域都會連到你的伺服器 |
| ③ 申請憑證 | 向 CA 證明你擁有這個網域 | 拿到 `fullchain.pem` 與 `privkey.pem` |
| ④ 設定 Nginx | 把憑證與網域寫進 server block | 瀏覽器顯示鎖頭，HTTPS 正常運作 |

> 延伸閱讀：本章聚焦「實際操作流程」。若想深入了解 HTTP/HTTPS 原理請看 [01-http-https.md](./01-http-https.md)，想深入了解憑證內部結構請看 [02-ssl-certificates.md](./02-ssl-certificates.md)。

---

## 3.2 第一步：如何申請網域

### 什麼是網域（Domain）？

網域是給人類記憶的「網站名字」，例如 `google.com`。電腦之間其實是用 IP 位址（例如 `142.250.0.0`）溝通的，但 IP 很難記，所以才有了網域與 DNS（網域名稱系統）來做「名字 → IP」的翻譯。

```
網域結構（由右往左層級越高）：

        www  .  example  .  com
         │         │         │
      主機名稱   二級網域   頂級網域(TLD)
     (子網域)   (你買的)   (.com/.tw/.io...)
```

| 名詞 | 範例 | 說明 |
|------|------|------|
| 頂級網域（TLD） | `.com` `.tw` `.io` `.dev` | 由國際組織管理，你只能「租用」其下的名字 |
| 二級網域（你註冊的） | `example` | 你真正花錢買的部分，加上 TLD 就是你的網域 |
| 子網域（Subdomain） | `www.` `api.` `blog.` | 買到網域後可自由建立，**不需再付費** |

### 在哪裡申請網域？

網域是向**網域註冊商（Registrar）**付費租用的（通常以「年」為單位）。常見選擇：

| 註冊商 | 特色 | 適合 |
|--------|------|------|
| **Cloudflare Registrar** | 以成本價販售、無加價、免費附 DNS 與 CDN | 想要最便宜且整合 CDN 的人（推薦） |
| **Google Domains → Squarespace** | 介面簡單（已轉移至 Squarespace） | 新手 |
| **Namecheap** | 價格便宜、首年常有優惠 | 個人專案 |
| **GoDaddy** | 知名度高、行銷強 | 注意續約價常較貴 |
| **Gandi / Porkbun** | 開發者友善、價格透明 | 進階使用者 |
| **台灣 Gandi / 中華電信 / PChome** | 提供 `.tw` 網域與中文客服 | 需要 `.tw` 或發票報帳 |

> **重點觀念**：網域是「租」不是「買斷」。一定要開啟**自動續約**，否則到期後別人可以搶註你的網域。

### 申請步驟（以通用流程為例）

```
1. 在註冊商網站搜尋你想要的名字
   └─ 例如輸入 "mycoolapp"，系統會列出 mycoolapp.com / .io / .dev 等可註冊的選項與價格

2. 加入購物車並結帳
   └─ 注意「首年優惠價」與「續約價」常常不同，看清楚續約價

3. 填寫註冊人資訊（WHOIS）
   └─ 建議開啟「WHOIS 隱私保護」(WHOIS Privacy)，避免你的姓名、Email、電話被公開查詢

4. 完成付款 → 驗證 Email
   └─ ICANN 規定必須驗證註冊信箱，否則網域會被暫停

5. 開啟自動續約
```

### 申請時的注意事項

| 注意項目 | 說明 |
|---------|------|
| 續約價 vs 首年價 | 首年 NT$30，續約 NT$500 是常見手法，務必看清楚 |
| WHOIS 隱私保護 | 是否免費？多數好的註冊商免費提供 |
| DNS 管理介面 | 是否好用？能否設定 A / CNAME / TXT 等紀錄 |
| 轉移政策 | 未來想換註冊商是否容易（注意 60 天轉移鎖定） |
| TLD 信任度 | 某些便宜 TLD（如 `.xyz` 早期）易被當垃圾信，影響 Email 與 SEO |

> **如何判斷 TLD 信任度？**
> 沒有官方分數，但可以從以下幾個面向綜合判斷：
>
> | 判斷面向 | 高信任度的特徵 | 低信任度的警訊 |
> |---------|--------------|--------------|
> | **歷史與普及度** | 老牌且廣泛使用（`.com` `.org` `.net` `.edu` `.gov`、各國國碼如 `.tw` `.jp` `.uk`） | 近年才出現、很少正規網站使用 |
> | **價格是否異常便宜** | 價格正常、續約價合理 | 首年趨近免費或極低價、或**完全免費**，垃圾信與釣魚網站愛用，連帶拖累整個 TLD 名聲 |
> | **註冊門檻** | 有一定費用或驗證門檻，濫用者較少 | 完全免費、無門檻（如早期 `.tk` `.ml` `.ga`） |
> | **Email 送達率** | 寄信不易被判垃圾 | 寄出的信常被收件方擋下或丟垃圾桶 |
> | **用途定位** | 與你的用途相符（`.dev` 給開發、`.io` 給科技新創、`.shop` 給電商） | 用途不符，讓訪客覺得不專業 |
>
> **多少價格算合理？**（以最常見的 `.com` 為基準）
>
> | 級距 | 年費（約） | 解讀 |
> |------|-----------|------|
> | 成本價 | US$9–15（NT$300–500） | 合理。Cloudflare、Porkbun、Namecheap 多在此區間 |
> | 偏高 | NT$500–900 | 可接受，多是 GoDaddy 等加了行銷 / 服務費 |
> | 太貴的警訊 | 續約 NT$1000+ | 常見「首年便宜、續約翻倍」套路，**務必看續約價而非首年價** |
> | 太便宜的警訊 | 首年 NT$30 或趨近免費 | 不是有續約陷阱，就是該 TLD 本身信任度低；**完全免費**（`.tk` `.ml`）才是真正的紅旗 |
>
> 其他常見 TLD 的正常行情：`.tw` 約 NT$600–800、`.io` 約 US$30–40、`.dev`／`.app` 約 US$12–20。判斷重點不是「絕對便宜」，而是**續約價是否合理、是否完全免費**。
>
> **實際查證方法：**
> 1. **看垃圾信榜單**：搜尋 Spamhaus 的「The World's Most Abused TLDs」報告，榜上 badness 比例高的 TLD 要避開。
> 2. **看大公司怎麼選**：知名品牌、銀行、政府幾乎都用 `.com` 或國碼 TLD，這本身就是信任度的指標。
> 3. **查 Google 是否差別對待**：Google 官方說明「不會因 TLD 給予 SEO 加減分」，但低信任 TLD 上充斥垃圾內容，連帶讓使用者點擊意願降低——影響的是「人」而非演算法。
>
> ⚠️ **注意：「試寄信」不能在購買前做。** 寄信需要你已擁有該網域並設好 MX / SPF 等 DNS 紀錄，買之前辦不到。所以「寄信到 Gmail / Outlook 看會不會進垃圾桶」只能當作**買之後的驗收**，用來確認 Email 送達率正不正常；它無法當作購買前的判斷依據。購買前請改用上面第 1～3 點（查榜單、看誰在用、查 SEO 說明）來判斷。
>
> **結論**：正式商業用途優先選 `.com`（或所在地國碼如 `.tw`）；技術 / 個人專案用 `.dev` `.io` `.app` 也相當安全；避開「免費或趨近免費、常出現在垃圾信榜單」的 TLD。

---

## 3.3 第二步：把網域指向公開 IP（含公開 IP 與私有 IP 的差別）

申請完網域後，它還不知道要指向哪台伺服器。這一步要做的就是設定 **DNS 紀錄**，把網域對應到你伺服器的**公開 IP**。

### 先搞懂：公開 IP 與私有 IP 的差別

這是新手最容易卡住的觀念。網域只能指向**公開 IP**，不能指向私有 IP。

```
              網際網路 (Internet)
                    │
            公開 IP：1.2.3.4   ← 全世界都能連到（網域要指向「這個」）
                    │
            ┌───────┴────────┐
            │   路由器 / NAT   │   ← 家用路由器或雲端的對外閘道
            └───────┬────────┘
                    │
        私有 IP 區段（家裡 / 內網，外部連不到）
       ┌────────┬────────┬────────┐
   192.168.1.10  .11      .12     ← 你的電腦、伺服器在這層
```

| 項目 | 公開 IP（Public IP） | 私有 IP（Private IP） |
|------|---------------------|----------------------|
| 誰能連到 | **全世界**任何人都能連 | 只有**同一個區域網路**內能連 |
| 由誰分配 | ISP（電信業者）或雲端商分配，全球唯一 | 路由器自動分配，可重複使用 |
| 常見範圍 | 除私有範圍外的所有 IP | `10.0.0.0/8`、`172.16.0.0/12`、`192.168.0.0/16` |
| 範例 | `1.2.3.4`、`203.0.113.5` | `192.168.1.10`、`10.0.0.5` |
| 能否被網域指向 | ✅ 可以 | ❌ 不行（外部根本連不到） |

> **白話比喻**：公開 IP 像「大樓的街道門牌」，郵差（網際網路）找得到；私有 IP 像「大樓內部的房號」，只有進了大樓（連上同一個 WiFi / 內網）才認得。網域指向必須用「街道門牌」。

#### 怎麼查自己的 IP？

```bash
# 查「公開 IP」(從外部看到你的 IP，網域要指向這個)
curl ifconfig.me
curl ipinfo.io/ip

# 查「私有 IP」(這台機器在內網的位址，不能給網域用)
ip addr            # Linux
ifconfig           # macOS / 舊版 Linux
ipconfig           # Windows
```

#### 我該用哪種環境的公開 IP？

| 部署環境 | 公開 IP 從哪來 | 注意事項 |
|---------|---------------|----------|
| 雲端主機（AWS EC2 / GCP / 自架 VPS） | 雲端商分配的固定/彈性公開 IP | **最推薦**，IP 穩定、80/443 可開放 |
| 家用網路自架 | ISP 給路由器的公開 IP | IP 常會變動（動態 IP），需搭配 DDNS；還要在路由器做 Port Forwarding |
| 公司內網 | 通常沒有對外公開 IP | 一般無法直接對外，需走公司 VPN 或反向代理穿透 |

> 若你是**家用動態 IP**，可使用 DDNS 服務（如 Cloudflare API、No-IP、DuckDNS）讓網域自動追蹤變動的公開 IP。正式服務仍**強烈建議使用雲端 VPS**，IP 固定又能穩定開放 80/443。

### 設定 DNS 紀錄

到你的註冊商（或 DNS 服務商，如 Cloudflare）的 DNS 管理介面，新增以下紀錄：

| 紀錄類型 | 名稱 / 主機 | 值（指向） | 用途 |
|---------|------------|-----------|------|
| **A** | `@`（代表根網域 example.com） | `1.2.3.4`（你的公開 IPv4） | 主網域指向伺服器 |
| **A** | `www` | `1.2.3.4` | 讓 `www.example.com` 也能用 |
| **AAAA** | `@` | `2606:...`（公開 IPv6，可選） | 支援 IPv6 的訪客 |
| **CNAME** | `api`（即 `api.example.com`） | `example.com` | 子網域指向另一個網域名稱（別名） |

> **「名稱 / 主機」欄填的是相對部分，系統會自動補上你的網域**：填 `@` 代表根網域 `example.com`、填 `www` 代表 `www.example.com`、填 `api` 代表 `api.example.com`。
> 上表最後一列的意思是：連到 `api.example.com` 時，DNS 先解析成 `example.com`，再查 `example.com` 的 A 紀錄拿到最終 IP。好處是**將來換 IP 只要改 `example.com` 那一筆 A 紀錄，所有 CNAME 會自動跟著變**，不必逐筆修改。

```
A 紀錄    ：網域名稱 → IPv4 位址      （example.com → 1.2.3.4）
AAAA 紀錄 ：網域名稱 → IPv6 位址      （example.com → 2606:...）
CNAME 紀錄：網域名稱 → 另一個網域名稱  （www.example.com → example.com）
            ⚠️ 根網域(@)通常不能用 CNAME，要用 A 紀錄
```

> **A 還是 CNAME？**
> - 指向「一個 IP」用 **A 紀錄**（最常見）。
> - 指向「另一個網域名稱」（例如雲端負載平衡器給你的 `xxx.elb.amazonaws.com`）用 **CNAME**。
> - 根網域（`@`）依規範不能用 CNAME，請用 A 紀錄（或服務商的 CNAME Flattening 功能）。

### DNS 生效需要時間（TTL 與傳播）

DNS 設定不會立刻全球生效，會有「傳播（Propagation）」延遲，受 **TTL（Time To Live）** 影響。

```bash
# 查詢網域目前解析到哪個 IP
dig example.com +short
dig www.example.com +short

# 指定用 Google 的 DNS 查詢（排除本機快取，看「比較新」的結果）
dig @8.8.8.8 example.com +short

# Windows 可用 nslookup
nslookup example.com

# 清除本機 DNS 快取（設定後沒生效時試試）
sudo dscacheutil -flushcache              # macOS
sudo systemd-resolve --flush-caches       # Linux (systemd)
ipconfig /flushdns                        # Windows
```

| 名詞 | 說明 | 建議 |
|------|------|------|
| TTL | DNS 紀錄可被快取的秒數 | 初次設定先設低（如 300 秒），穩定後再調高 |
| 傳播延遲 | 全球 DNS 伺服器更新的時間 | 通常數分鐘到 48 小時，多數很快 |

> **驗證連通性**：DNS 生效後，先確認伺服器的 80/443 連接埠對外開放（雲端要設定**安全群組 / 防火牆規則**，家用要設定 **Port Forwarding**），否則網域解析正確但仍連不上。

---

## 3.4 第三步：如何申請 HTTPS 憑證（兩種以上方案）

網域指向伺服器後，現在用 `http://example.com` 已經能連，但瀏覽器會顯示「不安全」。要啟用 HTTPS（鎖頭），必須向**憑證授權機構（CA）**申請 TLS 憑證。

申請憑證的核心都是：**向 CA 證明「你真的擁有這個網域」**（稱為 Domain Validation, DV）。以下介紹三種常見方案。

### 三種方案總覽

| 方案 | 費用 | 自動續約 | 適合情境 |
|------|------|---------|---------|
| **方案一：Let's Encrypt + Certbot** | 免費 | ✅ 工具自動 | 自架 VPS、最普遍的選擇（推薦） |
| **方案二：Cloudflare 代管憑證** | 免費 | ✅ 全自動 | 想要 CDN + 最省事，網站走 Cloudflare 代理 |
| **方案三：商業 CA（付費 OV/EV）** | 付費 | ❌ 手動 | 企業官網、需要組織驗證或保險 |

---

### 方案一：Let's Encrypt + Certbot（免費、最普遍）

Let's Encrypt 是免費的 CA，搭配 Certbot 工具可自動申請與續約。憑證有效期 90 天，但會自動續約。

```bash
# 1. 安裝 Certbot（Ubuntu，含 Nginx 外掛）
sudo apt update
sudo apt install certbot python3-certbot-nginx -y
# certbot                = ACME 客戶端本體，負責向 Let's Encrypt 申請與續約
# python3-certbot-nginx  = Nginx 外掛，讓 certbot 能自動改寫 Nginx 設定

# 2-A. 全自動：申請憑證「並」自動修改 Nginx 設定
sudo certbot --nginx -d example.com -d www.example.com
# --nginx       = 自動完成驗證並直接幫你改 Nginx（加上 443 與重導向）
# -d example.com = 要簽進憑證的網域，可重複多個 -d

# 2-B. 半自動：只申請憑證，不動我的 Nginx 設定（自己掌控設定）
sudo certbot certonly --webroot -w /var/www/example.com -d example.com -d www.example.com
# certonly  = 只拿憑證，不改任何設定
# --webroot = 把驗證檔寫進網站目錄，由正在運行的 Nginx 對外提供（不需停機）
# -w        = 你網站實際對外的 root 目錄
```

> **這行指令背後發生了什麼？（HTTP-01 驗證）**
> 1. Certbot 向 Let's Encrypt 申請，宣稱「我擁有 example.com」。
> 2. Let's Encrypt 連到 `http://example.com/.well-known/acme-challenge/xxx` 檢查驗證檔——**這就是為何 80 連接埠必須對外開放**。
> 3. 驗證通過，憑證下載到 `/etc/letsencrypt/live/example.com/`：
>    - `fullchain.pem`（憑證 + 中繼憑證，Nginx 用這個）
>    - `privkey.pem`（私鑰，**絕不可外洩**）

```bash
# 3. 測試自動續約（dry-run 不會真的簽發，只模擬流程）
sudo certbot renew --dry-run

# Certbot 安裝時通常已建立 systemd timer / cron，會在到期前自動續約。
# 確認續約排程是否存在：
systemctl list-timers | grep certbot
```

| 好處 | 限制 |
|------|------|
| 完全免費、主流瀏覽器信任 | 憑證 90 天，必須確保續約機制正常運作 |
| 高度自動化（申請 + 續約） | 有簽發頻率限制（rate limit），勿反覆測試正式網域 |
| 與 Nginx 整合容易 | 需要可公開驗證的網域與開放的 80 連接埠（內網不適用） |

> 若無法開放 80 連接埠或要簽**萬用憑證**（`*.example.com`），可改用 **DNS-01 驗證**：透過在 DNS 加一筆 TXT 紀錄證明網域所有權（適合搭配支援 API 的 DNS 商自動化）。

---

### 方案二：Cloudflare 代管憑證（免費、最省事）

若你願意把網域的 DNS 交給 Cloudflare 並開啟「代理（橘色雲朵）」，Cloudflare 會**自動幫你的網站發放並續約憑證**，你完全不用碰 Certbot。

```
訪客 ──HTTPS──▶ Cloudflare（代理 + 憑證自動續約）──▶ 你的伺服器（Origin）
                    ↑ 這段憑證由 Cloudflare 全自動處理
```

設定流程：

```
1. 把網域的「名稱伺服器（Nameserver, NS）」改成 Cloudflare 提供的兩組
   （在你的註冊商後台修改 NS）

2. 在 Cloudflare DNS 設定 A 紀錄指向你的公開 IP，並開啟「Proxied（橘色雲朵）」

3. SSL/TLS 模式選擇：
   - Flexible      ：訪客↔CF 加密，CF↔伺服器不加密（不建議，伺服器端仍是 HTTP）
   - Full          ：兩段都加密，但不驗證伺服器憑證
   - Full (Strict) ：兩段都加密「且」驗證伺服器憑證（最安全，推薦）

4. （Full/Strict）在伺服器安裝 Cloudflare「Origin 憑證」
   Cloudflare 後台 → SSL/TLS → Origin Server → Create Certificate
   把產生的憑證與私鑰存到伺服器（有效期可長達 15 年，僅供 CF 連線使用）
```

| 好處 | 限制 |
|------|------|
| 對外憑證**全自動**，永不過期煩惱 | 必須把 DNS 託管給 Cloudflare 並走它的代理 |
| 附帶 CDN、快取、DDoS 防護 | 流量都會經過 Cloudflare（隱私 / 合規需評估） |
| 不需在伺服器跑 Certbot | Origin 憑證只被 Cloudflare 信任，不能單獨給瀏覽器用 |

---

### 方案三：商業 CA 付費憑證（OV / EV）

Let's Encrypt 只提供 **DV（網域驗證）** 憑證——只證明你擁有網域。若企業需要**驗證組織身分**或需要憑證**保險與保固**，可向商業 CA（DigiCert、Sectigo、GlobalSign 等）購買。

| 憑證類型 | 驗證內容 | 申請時間 | 適合 |
|---------|---------|---------|------|
| **DV**（Domain Validation） | 只驗網域所有權 | 數分鐘 | 個人、部落格、API（Let's Encrypt 即屬此類） |
| **OV**（Organization Validation） | 驗組織真實存在 | 數天 | 公司官網、需要展示公司名 |
| **EV**（Extended Validation） | 最嚴格的組織查核 | 一至數週 | 金融、電商等高信任需求 |

申請流程（與免費的差別在於要「人工審核組織」與「付費」）：

```bash
# 1. 在伺服器產生私鑰與憑證簽署請求（CSR）
openssl req -new -newkey rsa:2048 -nodes \
  -keyout example.com.key \
  -out example.com.csr \
  -subj "/C=TW/O=Example Inc./CN=example.com"
# req -new      = 產生新的 CSR
# -newkey rsa:2048 -nodes = 同時產生 2048 位元私鑰，且私鑰不加密碼
# -keyout       = 私鑰輸出檔（妥善保管，勿外洩）
# -out          = CSR 輸出檔（這個丟給 CA）
# -subj         = 憑證主體資訊（CN 一定要是你的網域）

# 2. 把 example.com.csr 內容貼到 CA 的申請頁面，付費並完成組織驗證

# 3. CA 審核通過後寄回憑證檔（通常含 your_domain.crt + 中繼憑證 chain）
#    把伺服器憑證與中繼憑證合併成 fullchain（順序：自己的憑證在上、中繼在下）
cat example.com.crt intermediate.crt > fullchain.crt
```

| 好處 | 限制 |
|------|------|
| 提供 OV/EV 組織身分驗證、保險保固 | 需付費，且每年要重新購買 / 續約 |
| 符合某些企業 / 法規要求 | 申請需人工審核，速度慢 |
| 可簽較長效期、商業客服支援 | 對「純技術安全性」而言，與免費 DV 的加密強度相同 |

> **怎麼選？** 個人專案、API、絕大多數網站用**方案一（Let's Encrypt）**就夠；想要 CDN + 零維護用**方案二（Cloudflare）**；只有在企業需要展示組織身分或法規要求時才需要**方案三**。

---

## 3.5 第四步：用網域與 HTTPS 憑證設定前端 Nginx

現在你已經有：
1. ✅ 網域 `example.com`（已指向公開 IP）
2. ✅ 憑證檔 `fullchain.pem` 與私鑰 `privkey.pem`

最後一步：用 Nginx 把它們套到你的**前端網站**（例如 React / Vue 打包後的靜態檔，或前端配後端 API 的反向代理）。

### 前端網站的典型目錄

```
/var/www/example.com/
└── dist/              ← 前端 build 後的產物（npm run build 的輸出）
    ├── index.html
    ├── assets/
    │   ├── index-xxxx.js
    │   └── index-xxxx.css
    └── favicon.ico
```

### 完整的前端 Nginx 設定範例

建立設定檔 `/etc/nginx/sites-available/example.com`：

```nginx
# ── HTTP (80)：只做一件事，全部導向 HTTPS ──
server {
    listen 80;
    listen [::]:80;
    server_name example.com www.example.com;   # 對應你 DNS 設定的網域

    # 把所有 http 請求 301 永久重導向到 https
    return 301 https://$host$request_uri;
    # $host         = 請求的主機名（保留使用者輸入的網域）
    # $request_uri  = 原始路徑與查詢字串（保留使用者要去的頁面）
}

# ── HTTPS (443)：實際服務前端網站 ──
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;                                   # 啟用 HTTP/2，提升載入效能
    server_name example.com www.example.com;

    # ① 套用憑證（指向你第三步拿到的檔案）
    ssl_certificate     /etc/letsencrypt/live/example.com/fullchain.pem;  # 憑證 + 中繼鏈
    ssl_certificate_key /etc/letsencrypt/live/example.com/privkey.pem;    # 私鑰（勿外洩）

    # ② TLS 安全性設定（只開現代協定）
    ssl_protocols       TLSv1.2 TLSv1.3;        # 停用老舊不安全的 TLS 版本
    ssl_ciphers         HIGH:!aNULL:!MD5;        # 使用高強度加密套件
    ssl_prefer_server_ciphers on;

    # ③ 前端網站根目錄
    root  /var/www/example.com/dist;
    index index.html;

    # ④ SPA 前端路由：找不到實體檔案就回傳 index.html
    #    （讓 Vue Router / React Router 的前端路由能正常運作）
    location / {
        try_files $uri $uri/ /index.html;
        # $uri      = 先找對應的實體檔案 (如 /assets/x.js)
        # $uri/     = 再找對應目錄
        # /index.html = 都找不到就交給前端 SPA 處理路由
    }

    # ⑤ 靜態資源長快取（檔名有 hash，可放心長期快取）
    location /assets/ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }

    # ⑥（可選）把 /api 反向代理到後端服務
    location /api/ {
        proxy_pass http://127.0.0.1:3000;       # 後端跑在本機 3000 埠（私有，不對外）
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;  # 讓後端知道原始是 https
    }
}
```

> **注意第 ⑥ 點呼應 3.3 的觀念**：後端用 `127.0.0.1:3000`（私有位址）只在本機監聽，**不直接對外**。外界一律透過 Nginx（持有公開 IP + 憑證）進來，由 Nginx 反向代理到後端，這是最常見也最安全的前後端部署架構。

### 啟用設定並驗證

```bash
# 1. 建立軟連結到 sites-enabled（Debian/Ubuntu 的慣例）
sudo ln -s /etc/nginx/sites-available/example.com /etc/nginx/sites-enabled/

# 2. 測試設定語法是否正確（上線前「必做」）
sudo nginx -t
# 出現 "syntax is ok" 與 "test is successful" 才代表沒問題

# 3. 重新載入設定（不中斷現有連線）
sudo systemctl reload nginx

# 4. 從外部驗證 HTTPS 是否正常
curl -I https://example.com
# 應看到 HTTP/2 200，且無憑證錯誤

# 5. 驗證 HTTP 是否正確導向 HTTPS
curl -I http://example.com
# 應看到 301 與 Location: https://example.com/
```

> 若你用的是 **Cloudflare（方案二）**，`ssl_certificate` 改成 Cloudflare 的 **Origin 憑證**路徑；其餘設定相同。SSL/TLS 模式記得設為 **Full (Strict)** 才會驗證這張 Origin 憑證。

### 上線後的加分項（可選）

```nginx
# 在 https 的 server block 內加上常見安全標頭
add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
# HSTS（HTTP Strict Transport Security）：告訴瀏覽器「往後一段時間只准用 HTTPS 連我」，防止被降級到 HTTP。
# 逐段拆解：
#   Strict-Transport-Security = 這個安全標頭的名稱
#   max-age=31536000          = 此規則的有效秒數，31536000 秒 = 365 天（瀏覽器會「記住」一年）
#   includeSubDomains         = 連同所有子網域(www.、api. ...)一併強制 HTTPS
#   always                    = Nginx 參數：即使回應是錯誤碼(4xx/5xx)也要送出這個標頭
#
# 效果：使用者第一次用 HTTPS 連線後，瀏覽器會記住這條規則。之後就算手動輸入 http://
#       或點到 http 連結，瀏覽器會「自己」改成 https 才送出，封包不會以明文離開電腦，
#       可擋掉「SSL stripping」這類把連線偷偷降級成 HTTP 的中間人攻擊。
#
# ⚠️ 注意：設定後該網域在 max-age 期間內「無法」用 HTTP 存取。請先確定 HTTPS 完全正常
#         （憑證有效、443 可連）再加這行；否則憑證一出問題，使用者在效期內會連不進來。
add_header X-Content-Type-Options "nosniff" always;     # 禁止瀏覽器亂猜 MIME 類型
add_header X-Frame-Options "SAMEORIGIN" always;          # 防止網站被惡意嵌入 iframe（點擊劫持）
```

---

## 3.6 完整流程檢查清單

```
□ ① 申請網域
    └─ 已註冊網域、已驗證 Email、已開啟自動續約、已開啟 WHOIS 隱私

□ ② 指向公開 IP
    └─ 已查到伺服器「公開 IP」（curl ifconfig.me）
    └─ DNS 已加 A 紀錄 (@ 與 www) 指向公開 IP
    └─ dig example.com +short 解析正確
    └─ 防火牆 / 安全群組已開放 80 與 443 連接埠

□ ③ 申請 HTTPS 憑證
    └─ 已選定方案（Let's Encrypt / Cloudflare / 商業 CA）
    └─ 已拿到 fullchain.pem 與 privkey.pem（或對應檔案）
    └─ Let's Encrypt：certbot renew --dry-run 通過、自動續約排程存在

□ ④ 設定前端 Nginx
    └─ server_name 對應正確網域
    └─ ssl_certificate / ssl_certificate_key 指向正確檔案
    └─ nginx -t 通過、已 reload
    └─ https 顯示鎖頭、http 自動 301 導向 https
    └─ SPA 路由 (try_files) 正常、（若有）/api 反向代理正常
```

---

## 3.7 常見問題排查（Troubleshooting）

| 症狀 | 可能原因 | 解法 |
|------|---------|------|
| 網域連不上、逾時 | DNS 未生效 / 防火牆沒開 80,443 / 指到私有 IP | `dig` 確認指向公開 IP；檢查安全群組與防火牆 |
| 顯示「不安全」沒有鎖頭 | 還在用 HTTP，或憑證未套上 | 完成第三、四步，確認 443 server block 正確 |
| `ERR_CERT_COMMON_NAME_INVALID` | 憑證網域與實際網域不符 | 確認 `-d` 與 `server_name` 都涵蓋了該網域（含 www） |
| Certbot 驗證失敗 | 80 埠沒開 / DNS 還沒生效 | 開放 80 埠、等 DNS 傳播後再申請 |
| 憑證突然過期 | 自動續約沒運作 | 檢查 `systemctl list-timers`、手動 `certbot renew` |
| 重新整理子頁面 404 | SPA 沒設 try_files | 加上 `try_files $uri $uri/ /index.html;` |
| `502 Bad Gateway`（/api） | 後端服務沒啟動 / 埠號錯 | 確認後端在 `proxy_pass` 指定的埠正常運行 |

---

## 3.8 本章小結

| 步驟 | 關鍵指令 / 動作 | 一句話重點 |
|------|----------------|-----------|
| ① 申請網域 | 在註冊商註冊 + 開自動續約 | 網域是「租」的，別讓它過期 |
| ② 指向公開 IP | DNS 加 A 紀錄 → 公開 IP | 網域只能指公開 IP，私有 IP 外部連不到 |
| ③ 申請憑證 | `certbot --nginx` / Cloudflare / 商業 CA | 核心是「向 CA 證明你擁有網域」 |
| ④ 設定 Nginx | `ssl_certificate` + `nginx -t` + reload | 80 導向 443，443 套憑證提供前端 |

走完這四步，使用者在瀏覽器輸入 `example.com` 就會看到鎖頭與你的網站，整條從網域到 HTTPS 的鏈路就完整打通了。

> 想更深入 Nginx 的反向代理、負載平衡、效能與安全性設定，可參考 `nginx/` 目錄下的完整教學（特別是 [04-reverse-proxy](../nginx/04-reverse-proxy.md)、[06-ssl-https](../nginx/06-ssl-https.md)）。
