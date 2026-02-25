# 第二章：SSL 憑證的取得與必備知識

## 2.1 什麼是 SSL/TLS？

SSL（Secure Sockets Layer）和 TLS（Transport Layer Security）是用來加密網路通訊的安全協定。TLS 是 SSL 的繼任者，但業界習慣上仍統稱為「SSL 憑證」。

### SSL/TLS 版本演進

| 版本 | 年份 | 狀態 |
|------|------|------|
| SSL 1.0 | — | 從未公開發布（有嚴重安全漏洞） |
| SSL 2.0 | 1995 | ❌ 已廢棄（2011 年正式棄用） |
| SSL 3.0 | 1996 | ❌ 已廢棄（POODLE 漏洞） |
| TLS 1.0 | 1999 | ❌ 已廢棄（2020 年主流瀏覽器停止支援） |
| TLS 1.1 | 2006 | ❌ 已廢棄（2020 年主流瀏覽器停止支援） |
| TLS 1.2 | 2008 | ✅ 目前廣泛使用 |
| TLS 1.3 | 2018 | ✅ 最新版本，推薦使用 |

> **重要**：現在所說的「SSL 憑證」實際上使用的是 TLS 協定。伺服器設定時應只啟用 TLS 1.2 和 TLS 1.3。

---

## 2.2 SSL 憑證是什麼？

SSL 憑證是一份數位文件，由受信任的憑證授權機構（CA, Certificate Authority）簽發，用來證明「這個網站確實屬於某個組織或個人」。

### 憑證包含的資訊

```
SSL 憑證內容：
├── 持有者資訊（Subject）
│   ├── 域名（CN: Common Name）：www.example.com
│   ├── 組織名稱（O: Organization）：Example Inc.
│   └── 國家 / 地區（C/ST/L）
├── 簽發者資訊（Issuer）
│   └── 簽發的 CA 名稱：Let's Encrypt Authority X3
├── 有效期間
│   ├── 生效日期：2025-01-01
│   └── 到期日期：2025-03-31
├── 公鑰（Public Key）
├── 數位簽章（Signature）
└── 延伸資訊
    ├── SAN（Subject Alternative Names）：支援的其他域名
    └── 金鑰用途（Key Usage）
```

### 查看憑證資訊

```bash
# 查看網站的 SSL 憑證資訊
echo | openssl s_client -connect www.example.com:443 -servername www.example.com 2>/dev/null | openssl x509 -text -noout

# 只查看到期日期
echo | openssl s_client -connect www.example.com:443 -servername www.example.com 2>/dev/null | openssl x509 -noout -dates

# 只查看持有者與簽發者
echo | openssl s_client -connect www.example.com:443 -servername www.example.com 2>/dev/null | openssl x509 -noout -subject -issuer

# 查看本地憑證檔案
openssl x509 -in /path/to/certificate.pem -text -noout
```

---

## 2.3 憑證信任鏈（Chain of Trust）

瀏覽器之所以信任一張 SSL 憑證，是因為背後有一套「信任鏈」機制：

```
Root CA（根憑證授權機構）
  │    內建在作業系統和瀏覽器中，被無條件信任
  │
  ├──→ Intermediate CA（中間憑證授權機構）
  │      │    由 Root CA 簽發，增加安全性與彈性
  │      │
  │      └──→ 你的 SSL 憑證（End-Entity Certificate）
  │             由 Intermediate CA 簽發
  │
  瀏覽器驗證流程：
  你的憑證 → 中間 CA 是否有效？→ Root CA 是否被信任？→ ✅ 驗證通過
```

### 為什麼要用 fullchain.pem？

```
cert.pem      = 只有你的憑證
chain.pem     = 中間 CA 憑證
fullchain.pem = 你的憑證 + 中間 CA 憑證（推薦使用）

如果只使用 cert.pem，部分客戶端可能無法完成信任鏈驗證，導致：
- Android 舊版瀏覽器顯示不信任
- API 請求出現 SSL 驗證錯誤
- curl 回報 "unable to verify the first certificate"
```

```bash
# 驗證憑證鏈是否完整
openssl verify -CAfile chain.pem cert.pem

# 查看完整的憑證鏈
openssl s_client -connect yourdomain.com:443 -servername yourdomain.com -showcerts
```

---

## 2.4 SSL 憑證的類型

### 依據驗證等級分類

| 類型 | 全名 | 驗證內容 | 簽發時間 | 費用 | 適用對象 |
|------|------|----------|----------|------|----------|
| DV | Domain Validation | 僅驗證域名所有權 | 幾分鐘 | 免費～低 | 個人網站、部落格 |
| OV | Organization Validation | 驗證域名 + 組織身份 | 1-3 天 | 中等 | 企業網站、電商 |
| EV | Extended Validation | 嚴格驗證組織合法性 | 1-2 週 | 較高 | 金融機構、大型企業 |

### 依據涵蓋範圍分類

| 類型 | 涵蓋範圍 | 範例 | 費用 |
|------|----------|------|------|
| 單域名憑證 | 一個域名 | `www.example.com` | 最低 |
| 多域名憑證（SAN） | 多個不同域名 | `example.com` + `example.org` | 中等 |
| 萬用字元憑證（Wildcard） | 一個域名的所有子域名 | `*.example.com` | 較高 |

### 如何選擇？

```
個人網站 / 小型專案
  → DV 單域名（Let's Encrypt 免費）

有多個子域名的網站
  → DV 萬用字元（Let's Encrypt 免費）

企業官網 / 電商平台
  → OV 憑證（需顯示公司資訊）

銀行 / 金融服務
  → EV 憑證（最高等級驗證）
```

---

## 2.5 取得免費 SSL 憑證（Let's Encrypt）

Let's Encrypt 是由非營利組織 ISRG 運營的免費 CA，是目前最受歡迎的免費 SSL 憑證提供者。

### Let's Encrypt 的特點

| 特點 | 說明 |
|------|------|
| 完全免費 | 不需要任何費用 |
| 自動化 | 透過 ACME 協定自動簽發與續約 |
| 憑證類型 | DV（Domain Validation）憑證 |
| 有效期 | 90 天（需要自動續約） |
| 支援萬用字元 | 支援 `*.yourdomain.com` |
| 廣泛被信任 | 所有主流瀏覽器和作業系統都信任 |

### 使用 Certbot 取得憑證

#### 步驟一：安裝 Certbot

```bash
# Ubuntu / Debian
sudo apt update
sudo apt install certbot -y

# 如果使用 Nginx
sudo apt install python3-certbot-nginx -y

# 如果使用 Apache
sudo apt install python3-certbot-apache -y

# CentOS / RHEL
sudo yum install certbot python3-certbot-nginx -y

# macOS（使用 Homebrew）
brew install certbot
```

#### 步驟二：取得憑證

```bash
# 方法 A：自動設定 Nginx（最推薦）
sudo certbot --nginx -d yourdomain.com -d www.yourdomain.com

# 方法 B：自動設定 Apache
sudo certbot --apache -d yourdomain.com -d www.yourdomain.com

# 方法 C：只取得憑證，不修改 Web Server 設定
sudo certbot certonly --webroot -w /var/www/yourdomain/html \
  -d yourdomain.com -d www.yourdomain.com

# 方法 D：Standalone 模式（暫時佔用 80 port）
sudo certbot certonly --standalone -d yourdomain.com
```

#### 步驟三：驗證方式

Let's Encrypt 需要驗證你確實擁有該域名：

| 驗證方式 | 說明 | 適用場景 |
|----------|------|----------|
| HTTP-01 | 在網站根目錄放置驗證檔案 | 最常用，適合有 Web Server 的情況 |
| DNS-01 | 在 DNS 加入 TXT 記錄 | 取得萬用字元憑證的唯一方式 |
| TLS-ALPN-01 | 透過 TLS 連線驗證 | 較少使用 |

```bash
# DNS-01 驗證（取得萬用字元憑證）
sudo certbot certonly --manual --preferred-challenges dns \
  -d yourdomain.com -d "*.yourdomain.com"

# Certbot 會提示你在 DNS 加入 TXT 記錄：
# _acme-challenge.yourdomain.com → "xxxxxxxxxxxxxxxxxxxx"

# 驗證 DNS 記錄是否生效
dig TXT _acme-challenge.yourdomain.com
```

#### 步驟四：憑證檔案位置

```bash
# 取得成功後，憑證存放在：
/etc/letsencrypt/live/yourdomain.com/
├── cert.pem       # 你的憑證
├── chain.pem      # 中間 CA 憑證
├── fullchain.pem  # 完整憑證鏈（cert.pem + chain.pem）← 伺服器設定用這個
├── privkey.pem    # 私鑰 ← 絕對不能外洩！
└── README

# 查看憑證資訊
sudo certbot certificates
```

#### 步驟五：設定自動續約

```bash
# 測試續約流程（不會真正續約）
sudo certbot renew --dry-run

# 檢查 systemd timer 是否已設定
sudo systemctl list-timers | grep certbot

# 如果沒有自動排程，手動加入 cron
echo "0 3 * * * root certbot renew --quiet --post-hook 'systemctl reload nginx'" \
  | sudo tee /etc/cron.d/certbot-renew

# 建議：設定到期通知
# Let's Encrypt 會在到期前 20 天發送 Email 通知
# 確保申請時填寫的 Email 正確
```

---

## 2.6 取得付費 SSL 憑證

### 何時需要付費憑證？

- 需要 OV 或 EV 驗證等級（公司名稱顯示在憑證中）
- 組織內部政策要求使用特定 CA
- 需要更長的有效期（最長 1 年，2020 年後 CA/B Forum 規定）
- 需要額外的保險保障（部分付費 CA 提供）

### 常見付費 CA 供應商

| CA | 特點 | 適用場景 |
|----|------|----------|
| DigiCert | 業界最受信任、企業首選 | 大型企業、金融機構 |
| Sectigo (Comodo) | 價格合理、產品線豐富 | 中小企業 |
| GlobalSign | 歐洲知名 CA | 跨國企業 |
| GoDaddy | 域名 + SSL 一站式服務 | 已在 GoDaddy 註冊域名的用戶 |

### 付費憑證申請流程

```bash
# 步驟 1：產生私鑰
openssl genrsa -out yourdomain.key 2048

# 步驟 2：產生 CSR（Certificate Signing Request）
openssl req -new -key yourdomain.key -out yourdomain.csr \
  -subj "/C=TW/ST=Taiwan/L=Taipei/O=Your Company/OU=IT/CN=yourdomain.com"

# 步驟 3：查看 CSR 內容（確認資訊正確）
openssl req -in yourdomain.csr -noout -text

# 步驟 4：將 CSR 提交給 CA（透過 CA 的網站）
# 步驟 5：完成驗證（DNS / Email / HTTP）
# 步驟 6：下載憑證檔案
# 步驟 7：安裝到伺服器
```

### 安裝付費憑證到 Nginx

```nginx
server {
    listen 443 ssl http2;
    server_name yourdomain.com;

    # 憑證（如果 CA 有提供 Bundle，需合併）
    ssl_certificate /etc/ssl/yourdomain/yourdomain_bundle.crt;
    ssl_certificate_key /etc/ssl/yourdomain/yourdomain.key;

    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers on;

    # ... 其他設定
}
```

```bash
# 如果 CA 分別提供了憑證和中間 CA 憑證，需手動合併
cat yourdomain.crt intermediate.crt > yourdomain_bundle.crt

# 驗證合併後的憑證鏈
openssl verify -CAfile intermediate.crt yourdomain.crt
```

---

## 2.7 雲端服務的 SSL 方案

### Cloudflare（最簡單的方式）

```
設定步驟：
1. 註冊 Cloudflare 帳號
2. 將域名的 DNS 指向 Cloudflare 的 Name Server
3. 在 Cloudflare 控制台啟用 SSL（免費方案即包含）
4. 選擇 SSL 模式：

SSL 模式選項：
┌───────────────────────────────────────────────────────┐
│ Off          不使用 SSL                                │
│ Flexible     瀏覽器 ←HTTPS→ Cloudflare ←HTTP→ 伺服器   │
│ Full         瀏覽器 ←HTTPS→ Cloudflare ←HTTPS→ 伺服器  │
│              （伺服器可用自簽憑證）                       │
│ Full(Strict) 瀏覽器 ←HTTPS→ Cloudflare ←HTTPS→ 伺服器  │
│              （伺服器需要有效的 CA 憑證）                 │
└───────────────────────────────────────────────────────┘
建議：使用 Full (Strict) 模式，伺服器安裝 Cloudflare Origin CA 憑證
```

### AWS ACM（AWS Certificate Manager）

```bash
# 使用 AWS CLI 申請憑證
aws acm request-certificate \
  --domain-name yourdomain.com \
  --subject-alternative-names "*.yourdomain.com" \
  --validation-method DNS

# ACM 憑證可免費用於：
# - ALB（Application Load Balancer）
# - CloudFront（CDN）
# - API Gateway
# 注意：ACM 憑證不能下載安裝到 EC2 上的 Nginx
```

### GCP Google-managed SSL

```bash
# 在 GCP Load Balancer 中設定
gcloud compute ssl-certificates create my-cert \
  --domains=yourdomain.com,www.yourdomain.com \
  --global

# Google 會自動管理憑證的簽發與續約
```

---

## 2.8 自簽憑證（Self-Signed Certificate）

自簽憑證僅適用於開發與測試環境，**不應用於正式環境**。

### 使用 OpenSSL 產生自簽憑證

```bash
# 一行指令產生自簽憑證（有效期 365 天）
openssl req -x509 -nodes -days 365 \
  -newkey rsa:2048 \
  -keyout selfsigned.key \
  -out selfsigned.crt \
  -subj "/C=TW/ST=Taiwan/L=Taipei/O=Dev/CN=localhost"

# 產生帶有 SAN（Subject Alternative Name）的自簽憑證
openssl req -x509 -nodes -days 365 \
  -newkey rsa:2048 \
  -keyout selfsigned.key \
  -out selfsigned.crt \
  -subj "/CN=localhost" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"
```

### 使用 mkcert（本地開發推薦）

```bash
# 安裝 mkcert
brew install mkcert       # macOS
sudo apt install mkcert   # Linux

# 安裝本地 CA（會自動加入系統信任清單）
mkcert -install

# 產生本地開發用憑證
mkcert localhost 127.0.0.1 ::1
# 產出：localhost+2.pem（憑證）和 localhost+2-key.pem（私鑰）

# 產生特定域名的憑證
mkcert "myapp.local" "*.myapp.local"
```

### mkcert vs OpenSSL 自簽

| 比較 | mkcert | OpenSSL 自簽 |
|------|--------|-------------|
| 瀏覽器信任 | ✅ 自動信任（安裝了本地 CA） | ❌ 會顯示不信任警告 |
| 設定難度 | 簡單（一行指令） | 較複雜 |
| 適用場景 | 本地開發 | 開發/測試/內部服務 |
| 是否適合正式環境 | ❌ | ❌ |

---

## 2.9 憑證管理最佳實踐

### 私鑰安全

```bash
# 私鑰的權限必須嚴格控制
sudo chmod 600 /etc/ssl/private/yourdomain.key
sudo chown root:root /etc/ssl/private/yourdomain.key

# 絕對不能做的事：
# ❌ 將私鑰上傳到 Git
# ❌ 將私鑰放在公開可存取的目錄
# ❌ 使用 Email 傳送私鑰
# ❌ 多個服務共用同一把私鑰

# 加入 .gitignore
echo "*.key" >> .gitignore
echo "*.pem" >> .gitignore
```

### 到期監控

```bash
# 檢查憑證到期日
echo | openssl s_client -connect yourdomain.com:443 -servername yourdomain.com 2>/dev/null \
  | openssl x509 -noout -enddate

# 自動檢查腳本（可加入 cron）
#!/bin/bash
DOMAIN="yourdomain.com"
EXPIRY=$(echo | openssl s_client -connect $DOMAIN:443 -servername $DOMAIN 2>/dev/null \
  | openssl x509 -noout -enddate | cut -d= -f2)
EXPIRY_EPOCH=$(date -d "$EXPIRY" +%s)
NOW_EPOCH=$(date +%s)
DAYS_LEFT=$(( ($EXPIRY_EPOCH - $NOW_EPOCH) / 86400 ))

if [ $DAYS_LEFT -lt 14 ]; then
  echo "⚠️ $DOMAIN 的 SSL 憑證將在 $DAYS_LEFT 天後到期！"
  # 在這裡加入通知邏輯（Email、Slack 等）
fi
```

### 憑證備份與災難恢復

```bash
# 備份憑證與私鑰
sudo tar czf ssl-backup-$(date +%Y%m%d).tar.gz \
  /etc/letsencrypt/live/yourdomain.com/ \
  /etc/letsencrypt/archive/yourdomain.com/ \
  /etc/letsencrypt/renewal/yourdomain.com.conf

# 存放到安全位置（加密儲存）
gpg --symmetric --cipher-algo AES256 ssl-backup-*.tar.gz
```

---

## 2.10 實際情境

### 情境一：SSL 憑證到期，網站無法訪問

**問題**：使用者回報瀏覽器顯示「您的連線不安全」或 `NET::ERR_CERT_DATE_INVALID`

```bash
# 1. 確認憑證到期日
echo | openssl s_client -connect yourdomain.com:443 -servername yourdomain.com 2>/dev/null \
  | openssl x509 -noout -dates

# 2. 如果使用 Let's Encrypt，嘗試手動續約
sudo certbot renew

# 3. 如果續約失敗
sudo certbot renew --dry-run
# 常見原因：
# - 80 port 被防火牆阻擋
# - DNS 未指向此伺服器
# - Certbot 設定檔被刪除

# 4. 如果設定檔遺失，重新申請
sudo certbot --nginx -d yourdomain.com -d www.yourdomain.com

# 5. 重載 Web Server
sudo systemctl reload nginx
```

### 情境二：SSL 握手失敗

**問題**：客戶端回報 `SSL_ERROR_HANDSHAKE_FAILURE_ALERT` 或 `ERR_SSL_VERSION_OR_CIPHER_MISMATCH`

```bash
# 1. 測試 SSL 連線
openssl s_client -connect yourdomain.com:443 -servername yourdomain.com

# 2. 檢查支援的 TLS 版本
openssl s_client -connect yourdomain.com:443 -tls1_2
openssl s_client -connect yourdomain.com:443 -tls1_3

# 3. 常見原因與解決
# 原因 A：使用了 cert.pem 而非 fullchain.pem
# 解決：ssl_certificate 改用 fullchain.pem

# 原因 B：TLS 版本過舊
# 解決：確保設定 ssl_protocols TLSv1.2 TLSv1.3;

# 原因 C：加密套件不相容
# 解決：使用推薦的加密套件清單
```

### 情境三：curl 或程式碼呼叫 HTTPS API 出現憑證錯誤

**問題**：`curl: (60) SSL certificate problem: unable to get local issuer certificate`

```bash
# 原因：系統缺少 CA 憑證套件，或中間憑證不完整

# 解決方法 1：安裝 CA 憑證套件
sudo apt install ca-certificates -y
sudo update-ca-certificates

# 解決方法 2：確認伺服器端使用 fullchain.pem
# 在伺服器上檢查
openssl s_client -connect yourdomain.com:443 -servername yourdomain.com -showcerts

# 解決方法 3（臨時方案，不建議用於正式環境）
curl -k https://yourdomain.com  # 跳過 SSL 驗證
```

### 情境四：多域名 / 萬用字元憑證設定

**問題**：一台伺服器要服務多個域名，如何管理 SSL 憑證？

```bash
# 方法 A：每個域名各自申請憑證
sudo certbot --nginx -d site-a.com
sudo certbot --nginx -d site-b.com

# 方法 B：萬用字元憑證（適合同一域名的多個子域名）
sudo certbot certonly --manual --preferred-challenges dns \
  -d yourdomain.com -d "*.yourdomain.com"

# 方法 C：SAN 多域名憑證
sudo certbot --nginx -d site-a.com -d site-b.com -d site-c.com
```

```nginx
# Nginx 設定：使用 SNI 在同一 IP 上服務多張憑證
server {
    listen 443 ssl http2;
    server_name site-a.com;
    ssl_certificate /etc/letsencrypt/live/site-a.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/site-a.com/privkey.pem;
}

server {
    listen 443 ssl http2;
    server_name site-b.com;
    ssl_certificate /etc/letsencrypt/live/site-b.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/site-b.com/privkey.pem;
}
```

### 情境五：在 Docker 環境中管理 SSL 憑證

```yaml
# docker-compose.yml — 使用 Nginx Proxy + Let's Encrypt 自動化
services:
  nginx-proxy:
    image: nginxproxy/nginx-proxy
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - /var/run/docker.sock:/tmp/docker.sock:ro
      - certs:/etc/nginx/certs
      - html:/usr/share/nginx/html
      - vhost:/etc/nginx/vhost.d

  acme-companion:
    image: nginxproxy/acme-companion
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - certs:/etc/nginx/certs
      - html:/usr/share/nginx/html
      - vhost:/etc/nginx/vhost.d
      - acme:/etc/acme.sh
    environment:
      - DEFAULT_EMAIL=your@email.com

  your-app:
    image: your-app:latest
    environment:
      - VIRTUAL_HOST=yourdomain.com
      - LETSENCRYPT_HOST=yourdomain.com

volumes:
  certs:
  html:
  vhost:
  acme:
```

---

## 2.11 SSL 安全性檢測與評分

### 線上檢測工具

| 工具 | 網址 | 用途 |
|------|------|------|
| SSL Labs | https://www.ssllabs.com/ssltest/ | 最全面的 SSL 評分（目標：A+） |
| SSL Shopper | https://www.sslshopper.com/ssl-checker.html | 快速檢查憑證鏈 |
| Security Headers | https://securityheaders.com/ | 檢查安全性標頭 |

### 命令列檢測

```bash
# 檢查支援的 TLS 版本與加密套件
nmap --script ssl-enum-ciphers -p 443 yourdomain.com

# 檢查完整的 SSL 資訊
echo | openssl s_client -connect yourdomain.com:443 -servername yourdomain.com 2>/dev/null \
  | openssl x509 -text -noout

# 檢查 HSTS 標頭
curl -sI https://yourdomain.com | grep -i strict-transport-security

# 快速安全性檢查腳本
echo "=== SSL Certificate Check for yourdomain.com ==="
echo "--- Expiry Date ---"
echo | openssl s_client -connect yourdomain.com:443 2>/dev/null | openssl x509 -noout -enddate
echo "--- TLS Version ---"
curl -sI https://yourdomain.com -o /dev/null -w "TLS: %{ssl_version}\n"
echo "--- HTTP Version ---"
curl -sI https://yourdomain.com -o /dev/null -w "HTTP: %{http_version}\n"
```

### 取得 A+ 評分的建議設定

```nginx
# /etc/nginx/snippets/ssl-best-practice.conf

# 只允許 TLS 1.2 和 1.3
ssl_protocols TLSv1.2 TLSv1.3;
ssl_prefer_server_ciphers on;
ssl_ciphers 'ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384';

# SSL Session 快取
ssl_session_cache shared:SSL:10m;
ssl_session_timeout 1d;
ssl_session_tickets off;

# OCSP Stapling
ssl_stapling on;
ssl_stapling_verify on;
resolver 8.8.8.8 8.8.4.4 valid=300s;
resolver_timeout 5s;

# 安全標頭
add_header Strict-Transport-Security "max-age=63072000; includeSubDomains; preload" always;
add_header X-Frame-Options "SAMEORIGIN" always;
add_header X-Content-Type-Options "nosniff" always;
add_header X-XSS-Protection "1; mode=block" always;
add_header Referrer-Policy "strict-origin-when-cross-origin" always;
```

---

## 2.12 本章小結

- SSL/TLS 是保護網路通訊的安全協定，現代應只啟用 TLS 1.2 和 TLS 1.3
- SSL 憑證由 CA 簽發，分為 DV、OV、EV 三個驗證等級
- Let's Encrypt 提供免費的 DV 憑證，搭配 Certbot 可完全自動化
- 務必使用 `fullchain.pem`（而非 `cert.pem`）來確保憑證鏈完整
- 私鑰是最敏感的檔案，權限應設為 600，絕不可上傳到 Git 或公開存取
- 設定自動續約和到期監控，避免憑證過期導致服務中斷
- 使用 SSL Labs 測試你的 SSL 設定，目標是取得 A+ 評分
- 本地開發建議使用 mkcert，正式環境使用 Let's Encrypt 或付費 CA

---

> 上一章：[HTTP 與 HTTPS 必備知識](./01-http-https.md)
