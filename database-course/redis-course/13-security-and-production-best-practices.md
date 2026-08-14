# 第 13 章：安全、客戶端設定與生產實踐

> Redis 的預設設定是**為了讓開發者三秒鐘就能開始用**設計的，不是為了安全。它預設沒有密碼、預設監聽所有網路介面（在早期版本）、預設允許 `FLUSHALL` 和 `CONFIG SET`。
> 這個組合曾經造成大規模的災難：2015～2018 年間，網路上有數萬台 Redis 直接暴露在公網且無密碼，被批量掃描後用來寫入 SSH 公鑰、挖礦、或直接勒索（把資料清空後留一個「付款贖回」的 key）。攻擊方式簡單到不需要任何漏洞——**攻擊者只是連上去執行了合法的命令。**
> 這章要做三件事：把安全設定做對；把客戶端設定做對（這是最常被忽略、卻最常造成線上問題的一環）；最後給一份可以逐項打勾的上線檢查表。

---

## 13.1 學習目標

完成本章後，你應該可以：

- 說明 Redis 預設設定的風險，以及「未授權存取」是怎麼被利用的。
- 正確設定網路層防護：`bind`、`protected-mode`、防火牆。
- 用 ACL 設計最小權限的帳號，並說明它相比 `requirepass` 的優勢。
- 設定 TLS 加密傳輸，並知道它的效能代價。
- 用 ACL 或 `rename-command` 封鎖危險命令，並說出兩者的取捨。
- 說明 Lua 腳本與模組帶來的安全風險。
- 正確設定客戶端的連線池、超時與重試，並說明每個參數怎麼推。
- 做容量規劃：估算記憶體、QPS、網路頻寬與成本。
- 設定作業系統層的必要參數（THP、overcommit、somaxconn、ulimit）。
- 安全地執行版本升級與設定變更。
- 用一份完整的檢查表確認上線準備。

---

## 13.2 為什麼「未授權存取」這麼致命

先理解攻擊路徑，才知道每一項防護在防什麼。

假設一台 Redis 暴露在公網且沒有密碼，攻擊者能做什麼：

**攻擊 1：直接讀走所有資料**

```bash
redis-cli -h <目標IP> KEYS '*'
redis-cli -h <目標IP> --rdb dump.rdb    # 把整份資料集拉走
```

Session token、使用者資料、快取的個資，全部帶走。

**攻擊 2：清空資料並勒索**

```bash
redis-cli -h <目標IP> FLUSHALL
redis-cli -h <目標IP> SET readme "Your data is backed up. Send 0.05 BTC to..."
```

如果你沒有備份（或備份也在同一台機器上），這就是真實的資料損失。

**攻擊 3：寫入 SSH 公鑰取得主機權限**

這是最嚴重的一種，它利用了 `CONFIG SET` 能改變持久化路徑：

```bash
# 攻擊者的操作（原理示意，說明為什麼要封鎖 CONFIG）
redis-cli -h <目標> CONFIG SET dir /root/.ssh/
redis-cli -h <目標> CONFIG SET dbfilename authorized_keys
redis-cli -h <目標> SET x "\n\nssh-rsa AAAA...攻擊者的公鑰...\n\n"
redis-cli -h <目標> SAVE
# 現在 /root/.ssh/authorized_keys 裡有攻擊者的公鑰
```

前提是 Redis 以 root 執行（很多人這樣做）。**Redis 從「一個快取服務」變成了「主機的後門」。**

同樣的手法也能寫 crontab（`/var/spool/cron/`）來執行任意命令。

**這三種攻擊都沒有用到任何漏洞**——它們都是合法的 Redis 命令。所以「升級到最新版」防不了，只有正確的設定能防。

### `protected-mode`：官方的補救

因為這類事故太多，Redis 3.2 加入了 `protected-mode`：

```bash
protected-mode yes    # 預設值
```

啟用時，如果**同時滿足**以下條件，Redis 只接受來自 127.0.0.1 的連線：

- 沒有設定 `requirepass`
- 沒有設定 `bind`（或 bind 了所有介面）

這擋住了「什麼都沒設就上線」的最糟情況。**但不要依賴它**——一旦你設了密碼（很多人為了方便設個弱密碼），`protected-mode` 就不再限制來源了。

---

## 13.3 網路層：第一道也是最重要的一道防線

### `bind`：只監聽該監聽的介面

```bash
# 只監聽本機（單機應用、或用 unix socket 時）
bind 127.0.0.1 -::1

# 監聽內網介面（應用伺服器在同一內網）
bind 10.0.1.20

# 危險：監聽所有介面
bind 0.0.0.0
# 或完全註解掉 bind（效果同上）
```

`-::1` 前面的減號表示「這個位址綁不上也不要啟動失敗」，用於 IPv6 未啟用的環境。

### Unix socket：最安全也最快

如果應用和 Redis 在同一台機器，用 unix socket 完全繞過網路：

```bash
unixsocket /var/run/redis/redis.sock
unixsocketperm 770
port 0                 # 完全關閉 TCP 監聽
```

```bash
redis-cli -s /var/run/redis/redis.sock
```

延遲比 TCP 低（省掉 TCP 堆疊的開銷），且不可能從網路存取。**單機部署時這是最佳選擇。**

### 防火牆

即使設了 `bind` 和密碼，防火牆仍然是必要的一層：

```bash
# 只允許應用伺服器網段
sudo iptables -A INPUT -p tcp --dport 6379 -s 10.0.1.0/24 -j ACCEPT
sudo iptables -A INPUT -p tcp --dport 6379 -j DROP

# Sentinel 埠也要
sudo iptables -A INPUT -p tcp --dport 26379 -s 10.0.1.0/24 -j ACCEPT
sudo iptables -A INPUT -p tcp --dport 26379 -j DROP
```

雲端環境用安全群組（Security Group）做同樣的事，並且**不要開 0.0.0.0/0**。

### 三個絕對不要

```text
✗ 不要把 Redis 埠開放到公網
✗ 不要用 root 執行 redis-server
✗ 不要在容器裡用 --network host 又不設防火牆
```

**用非 root 使用者執行**能把「攻擊 3」的影響從「取得主機」降為「取得一個受限帳號」：

```bash
# 套件安裝通常已經建好 redis 使用者
sudo -u redis redis-server /etc/redis/redis.conf

# Docker 的官方映像預設就是用 redis 使用者
docker run redis:7.2 id
# uid=999(redis) gid=999(redis)
```

---

## 13.4 ACL：比 `requirepass` 好得多的認證

### `requirepass` 的問題

```bash
requirepass "a-very-long-random-password"
```

```bash
redis-cli -a "a-very-long-random-password"
# 或連線後
AUTH "a-very-long-random-password"
```

它能用，但有三個問題：

1. **只有一個帳號**，所有服務共用同一組憑證。
2. **權限是全有全無**，那個帳號能執行 `FLUSHALL`、`CONFIG SET`、`SHUTDOWN`。
3. **無法追蹤**，出事時你不知道是哪個服務做的。

（另外還有 `masterauth`，那是給從節點連主節點用的，需要和主節點的密碼一致。）

### ACL：Redis 6.0 起的正解

ACL 讓你建立多個使用者，每個使用者有各自的密碼、可執行的命令、可存取的 key 模式。

```bash
# 查看目前的使用者
ACL LIST
# 1) "user default on nopass sanitize-payload ~* &* +@all"

# 查看自己的權限
ACL WHOAMI
ACL GETUSER default
```

預設的 `default` 使用者是 `nopass +@all ~*`——無密碼、所有命令、所有 key。**上線前一定要改掉。**

### 設計最小權限的帳號

```bash
# 1. 應用程式帳號：只能對自己的 key 前綴做讀寫，不能執行管理命令
ACL SETUSER app_order on \
  >AppOrderSecret_2026 \
  ~order:* ~cache:order:* \
  +@read +@write +@string +@hash +@list +@sortedset +@set \
  -@dangerous \
  +ping +info

# 2. 唯讀帳號（給 BI、報表、除錯用）
ACL SETUSER readonly on \
  >ReadOnlySecret_2026 \
  ~* \
  +@read -@dangerous

# 3. 維運帳號：能做管理但不能刪資料
ACL SETUSER ops on \
  >OpsSecret_2026 \
  ~* \
  +@all -flushall -flushdb -shutdown -@dangerous \
  +config|get +client +info +slowlog +latency +memory

# 4. 監控帳號：只能讀指標
ACL SETUSER monitoring on \
  >MonitorSecret_2026 \
  ~* \
  +info +ping +client|list +config|get +slowlog|get +latency|latest +memory|stats \
  +cluster|info +replicaof
```

語法規則：

| 語法 | 含義 |
|------|------|
| `on` / `off` | 啟用 / 停用這個帳號 |
| `>password` | 加一個密碼 |
| `<password` | 移除一個密碼 |
| `nopass` | 不需要密碼（危險） |
| `~pattern` | 允許存取符合模式的 key |
| `%R~pattern` | 只允許讀取（7.0+） |
| `%W~pattern` | 只允許寫入（7.0+） |
| `allkeys` 或 `~*` | 所有 key |
| `resetkeys` | 清除所有 key 權限 |
| `+command` | 允許某命令 |
| `-command` | 禁止某命令 |
| `+@category` | 允許某類命令 |
| `+command\|subcommand` | 只允許某個子命令（如 `+config\|get`） |
| `&channel` | 允許的 Pub/Sub 頻道 |
| `allchannels` 或 `&*` | 所有頻道 |

命令類別（用 `ACL CAT` 查看全部）：

```bash
ACL CAT
# read, write, keyspace, string, list, set, sortedset, hash, bitmap,
# hyperloglog, geo, stream, pubsub, admin, fast, slow, blocking,
# dangerous, connection, transaction, scripting

# 查看某個類別包含哪些命令
ACL CAT dangerous
# flushall, flushdb, shutdown, keys, config, debug, monitor, save, ...
```

**`-@dangerous` 是最重要的一行**，它一次擋掉 `FLUSHALL`、`FLUSHDB`、`KEYS`、`CONFIG`、`DEBUG`、`MONITOR`、`SHUTDOWN`、`REPLICAOF` 等所有高風險命令。

### 持久化 ACL 設定

`ACL SETUSER` 只改變執行中的狀態，重啟就沒了。兩種持久化方式：

**方式 1：寫在設定檔裡**

```bash
# redis.conf
user app_order on >AppOrderSecret_2026 ~order:* ~cache:order:* +@read +@write -@dangerous
user readonly on >ReadOnlySecret_2026 ~* +@read -@dangerous
user default off
```

**方式 2：用獨立的 ACL 檔案（推薦）**

```bash
# redis.conf
aclfile /etc/redis/users.acl
```

```bash
# 把目前的設定存進 aclfile
ACL SAVE

# 從 aclfile 重新載入（改檔案後不用重啟）
ACL LOAD
```

用 `aclfile` 的好處是可以熱重載，而且權限設定和其他設定分開管理。**注意兩種方式不能混用**——設了 `aclfile` 之後就不能在 `redis.conf` 裡寫 `user` 行。

### 停用 default 使用者

```bash
# 建好其他帳號並確認可用之後
ACL SETUSER default off
ACL SAVE
```

**順序很重要**：先建好新帳號、改好所有應用的連線設定、確認都能連上，最後才停用 `default`。反過來做會造成全面中斷。

### ACL 日誌：誰做了不該做的事

```bash
ACL LOG
```

```text
1)  1) "count"
    2) (integer) 3
    3) "reason"
    4) "command"                       # 被拒原因：命令不允許
    5) "context"
    6) "toplevel"
    7) "object"
    8) "flushall"                      # 試圖執行的命令
    9) "username"
   10) "app_order"
   11) "age-seconds"
   12) "12.34"
   13) "client-info"
   14) "id=45 addr=10.0.1.5:52134 name=order-service-pod-2 ..."
```

**這是第 12 章「資料莫名消失」劇本裡缺的那塊拼圖**——它能告訴你是哪個服務、哪個 pod 試圖執行 `FLUSHALL`。

```bash
ACL LOG RESET     # 清空
```

建議定期採集 `ACL LOG` 進日誌系統並對 `reason=command` 設告警——正常運作的應用不該觸發任何 ACL 拒絕。

### 應用端怎麼用

```javascript
const redis = new Redis({
  host: 'redis.internal',
  port: 6379,
  username: 'app_order',          // ACL 使用者名稱
  password: process.env.REDIS_PASSWORD,
});
```

```python
import redis
r = redis.Redis(
    host='redis.internal',
    username='app_order',
    password=os.environ['REDIS_PASSWORD'],
)
```

**密碼絕不寫在程式碼或提交進 git**，用環境變數或密鑰管理系統（Vault、AWS Secrets Manager、K8s Secret）。

---

## 13.5 TLS

Redis 6.0 起原生支援 TLS。沒有 TLS 時，密碼和資料都是**明文**在網路上傳輸。

### 什麼時候需要

```text
必須用：
  跨網路傳輸（跨機房、跨 VPC、走公網）
  有合規要求（PCI-DSS、HIPAA）
  多租戶的共享網路環境

可以不用：
  同一台機器（用 unix socket 更好）
  完全受控的內網，且有網路層隔離
```

### 產生憑證（測試用）

```bash
mkdir -p tls && cd tls

# CA
openssl genrsa -out ca.key 4096
openssl req -x509 -new -nodes -sha256 -key ca.key -days 3650 \
  -subj "/O=Redis Course/CN=Redis Course CA" -out ca.crt

# 伺服器憑證
openssl genrsa -out redis.key 2048
openssl req -new -sha256 -key redis.key \
  -subj "/O=Redis Course/CN=redis.internal" -out redis.csr
openssl x509 -req -sha256 -in redis.csr -CA ca.crt -CAkey ca.key \
  -CAcreateserial -days 365 -out redis.crt

# DH 參數（可選，提升前向安全性）
openssl dhparam -out redis.dh 2048
```

生產環境請用正式 CA 或內部 PKI 簽發的憑證，不要用自簽。

### 設定

```bash
# 關閉非加密埠，只接受 TLS
port 0
tls-port 6379

tls-cert-file /etc/redis/tls/redis.crt
tls-key-file /etc/redis/tls/redis.key
tls-ca-cert-file /etc/redis/tls/ca.crt
tls-dh-params-file /etc/redis/tls/redis.dh

# 要求客戶端也出示憑證（雙向驗證，更安全）
tls-auth-clients yes

# 主從複製也走 TLS
tls-replication yes

# Cluster 節點間通訊走 TLS
tls-cluster yes

# 限制協定版本
tls-protocols "TLSv1.2 TLSv1.3"
tls-ciphersuites TLS_AES_128_GCM_SHA256:TLS_AES_256_GCM_SHA384
```

連線：

```bash
redis-cli --tls \
  --cert /etc/redis/tls/client.crt \
  --key /etc/redis/tls/client.key \
  --cacert /etc/redis/tls/ca.crt \
  -a "$REDIS_PASSWORD"
```

```javascript
const redis = new Redis({
  host: 'redis.internal',
  port: 6379,
  username: 'app_order',
  password: process.env.REDIS_PASSWORD,
  tls: {
    ca: fs.readFileSync('/etc/redis/tls/ca.crt'),
    cert: fs.readFileSync('/etc/redis/tls/client.crt'),
    key: fs.readFileSync('/etc/redis/tls/client.key'),
    servername: 'redis.internal',   // 必須和憑證的 CN/SAN 一致
  },
});
```

### 效能代價

TLS 會增加 CPU 開銷與延遲：

```text
吞吐量：下降約 20～40%（視 cipher 與封包大小）
延遲：  每次連線多一次 handshake（可用 session resumption 緩解）
CPU：   加解密在主執行緒進行 -> 直接吃掉 Redis 的處理能力
```

**因為加解密在主執行緒，TLS 對 Redis 的影響比對多執行緒服務更明顯。** 兩個緩解方式：

```bash
# 1. 開啟 I/O threads，讓 TLS 的讀寫分擔到其他執行緒（第 04 章）
io-threads 4
io-threads-do-reads yes
```

2. 用長連線（連線池），避免反覆 handshake——這也是下一節的主題。

---

## 13.6 危險命令的處理

### 哪些命令危險

| 命令 | 風險 |
|------|------|
| `FLUSHALL` / `FLUSHDB` | 清空資料 |
| `KEYS` | O(N) 阻塞整個實例（第 01、04 章） |
| `CONFIG` | 可改持久化路徑寫檔案（13.2 節的攻擊 3） |
| `DEBUG` | `DEBUG SLEEP` 能直接卡住 Redis，`DEBUG SEGFAULT` 讓它崩潰 |
| `SHUTDOWN` | 直接關閉服務 |
| `MONITOR` | 效能影響 + 洩漏所有命令內容 |
| `REPLICAOF` / `SLAVEOF` | 可讓實例去複製攻擊者的 Redis，資料被清空替換 |
| `SAVE` | 同步阻塞式快照 |
| `SCRIPT` / `EVAL` | 可執行任意 Lua（見 13.7 節） |

### 方式 1：ACL（推薦）

```bash
ACL SETUSER app_order on >secret ~app:* +@all -@dangerous -@scripting
```

好處：**細緻、可分帳號、可查日誌、可熱更新**。維運帳號仍能執行 `CONFIG GET`，應用帳號則完全不能碰。

### 方式 2：`rename-command`（舊做法）

```bash
# 改名成無法猜到的字串
rename-command CONFIG "CONFIG_a8f3c2b1d4e5"
rename-command DEBUG ""

# 改成空字串 = 完全禁用
rename-command FLUSHALL ""
rename-command FLUSHDB ""
rename-command KEYS ""
```

限制：

- **只能全域生效**，無法分帳號（維運也用不了）。
- 只能寫在設定檔，**不能用 `CONFIG SET` 動態改**，改了要重啟。
- 改名後某些工具會失效（例如監控工具需要 `CONFIG GET`）。

**Redis 7.0 起 `rename-command` 已被標為棄用**，官方建議用 ACL。但在 Redis 5 及更早的環境裡它仍是唯一選擇。

### 兩者的取捨

| | ACL | `rename-command` |
|---|-----|------------------|
| 版本需求 | 6.0+ | 全部 |
| 分帳號 | **是** | 否 |
| 動態修改 | **是**（`ACL SETUSER`） | 否（要重啟） |
| 稽核日誌 | **是**（`ACL LOG`） | 否 |
| 對維運的影響 | 可另開帳號 | 全域失效 |

**結論：6.0 以上一律用 ACL。**

---

## 13.7 Lua 與模組的安全風險

### Lua 腳本

Redis 的 Lua 環境是沙箱化的——**不能存取檔案系統、不能開網路連線、不能載入任意 Lua 模組**。所以它不像某些人擔心的那樣能直接執行系統命令。

但它仍有兩個真實風險：

**風險 1：無限迴圈或超慢腳本會卡住整個實例**

```lua
-- 這會讓 Redis 完全無回應
while true do end
```

```bash
# 腳本執行超過這個時間，Redis 開始對其他客戶端回 BUSY 錯誤
busy-reply-threshold 5000        # 毫秒（舊名 lua-time-limit）
```

超時後其他客戶端會收到：

```text
(error) BUSY Redis is busy running a script. You can only call SCRIPT KILL or SHUTDOWN NOSAVE.
```

```bash
# 殺掉腳本（只有在腳本還沒執行過寫入時有效）
SCRIPT KILL

# 如果腳本已經寫入過資料，只能強制關閉（會丟資料）
SHUTDOWN NOSAVE
```

**注意 `SCRIPT KILL` 對「已經執行過寫命令」的腳本無效**——因為那會破壞原子性（一半的修改已經生效）。這時只剩 `SHUTDOWN NOSAVE` 這條路，代價是丟掉未持久化的資料。

**所以生產環境的 Lua 腳本必須有明確的迴圈上界。** 第 07 章強調過這件事，這裡是它的安全面向。

**風險 2：`EVAL` 允許提交任意腳本**

如果應用有注入漏洞讓攻擊者控制腳本內容，他們就能：

- 用 `redis.call('KEYS', '*')` 掃描所有 key
- 寫一個超慢腳本做 DoS
- 讀取任何 key（繞過 ACL 的 key 權限？不會——Redis 7 的 ACL 會檢查腳本存取的 key，但更早的版本檢查較弱）

防護：

```bash
# 應用帳號只允許執行已註冊的腳本（EVALSHA），不允許提交新腳本（EVAL）
ACL SETUSER app_order on >secret ~app:* +@all -@dangerous -eval -script
# 然後在部署時用維運帳號 SCRIPT LOAD，應用只用 EVALSHA
```

實務上這個限制較少見（管理成本高），更常見的是**確保腳本內容都是程式碼裡的常數，永遠不拼接使用者輸入**——和 SQL 注入的防護思路完全一樣。

### 模組

模組是編譯成 `.so` 的原生程式碼，**在 Redis 行程內執行，沒有任何沙箱**。一個惡意或有 bug 的模組能做任何事。

```bash
# 只載入你信任來源的模組
loadmodule /usr/lib/redis/modules/redisbloom.so

# 禁止動態載入（避免攻擊者用 MODULE LOAD 載入惡意模組）
enable-module-command no        # 7.0+
```

**`MODULE LOAD` 是一個常被忽略的攻擊面**——它能載入本機任何 `.so`。如果攻擊者能先寫入檔案（透過 13.2 節的 `CONFIG SET dir` 手法）再 `MODULE LOAD`，就是完整的遠端程式碼執行。

`enable-module-command no` 應該是預設設定的一部分。

---

## 13.8 客戶端設定：最常被忽略的一環

前面十二章都在講 Redis 那一側。但實務上**很多「Redis 很慢」的問題其實在客戶端**。

### 連線池：一個常見的誤解

不同語言的客戶端模型不同，設定方式也不同：

```text
Node.js（ioredis / node-redis）
  單執行緒 + 非阻塞 I/O
  -> 一個連線就能處理大量併發（命令會排隊送出）
  -> 不需要連線池，只要「不要每個請求都 new 一個」

Java（Jedis / Lettuce）
  Jedis：連線非執行緒安全 -> 必須用連線池（JedisPool）
  Lettuce：連線是執行緒安全的 -> 單連線即可，但仍常用池

Python
  redis-py：內建連線池，預設每個 Redis() 物件一個池
  -> 要在模組層建立一次並複用，不要在函式裡建立

Go
  go-redis：內建連線池
```

**最常見的錯誤是每次請求都建立連線**（第 12 章劇本 3）：

```javascript
// ❌ 每個請求一個新連線，很快就打滿 maxclients
app.get('/api/product/:id', async (req, res) => {
  const redis = new Redis(config);
  const data = await redis.get(`product:${req.params.id}`);
  await redis.quit();
  res.json(data);
});

// ✅ 模組層建立一次，全程複用
const redis = new Redis(config);
app.get('/api/product/:id', async (req, res) => {
  const data = await redis.get(`product:${req.params.id}`);
  res.json(data);
});
```

### 連線池大小怎麼算

Java / Python / Go 需要決定池大小。太小會排隊，太大會浪費 Redis 的連線配額。

```text
所需連線數 ≈ 目標 QPS × 平均命令耗時（秒）

例：這台應用要打 5000 QPS，Redis 平均回應 0.5 毫秒
    5000 × 0.0005 = 2.5 個連線

加上安全餘裕（尖峰、GC 停頓、慢命令）-> 8～16 個
```

**多數團隊設得太大。** 常見的「maxTotal=200」在上面的例子裡是 80 倍的浪費，而且如果有 50 個 pod，那就是 10000 個連線——正好打滿預設的 `maxclients`。

```java
// Jedis 的合理設定
JedisPoolConfig config = new JedisPoolConfig();
config.setMaxTotal(16);              // 依上面公式推算
config.setMaxIdle(8);
config.setMinIdle(4);                // 預熱，避免尖峰時才建連線
config.setMaxWaitMillis(1000);       // 拿不到連線最多等 1 秒，不要無限等
config.setTestOnBorrow(false);       // 每次借用都 PING 會增加延遲
config.setTestWhileIdle(true);       // 改成閒置時檢查
config.setTimeBetweenEvictionRunsMillis(30000);
```

```python
# redis-py
pool = redis.ConnectionPool(
    host='redis.internal', port=6379,
    username='app_order', password=os.environ['REDIS_PASSWORD'],
    max_connections=16,
    socket_connect_timeout=2,
    socket_timeout=1,
    retry_on_timeout=True,
    health_check_interval=30,
)
r = redis.Redis(connection_pool=pool)   # 模組層建立一次
```

### 超時設定：三個不同的超時

這是最容易設錯的部分，因為它們的作用完全不同：

```javascript
const redis = new Redis({
  // 1. 連線超時：建立 TCP + 認證的時間上限
  connectTimeout: 2000,        // 2 秒。設太長會讓故障轉移期間的請求堆積

  // 2. 命令超時：單個命令等待回應的時間上限
  commandTimeout: 1000,        // 1 秒。要大於你的 P99.9，但遠小於 HTTP 超時

  // 3. socket 層的 keep-alive，偵測半開連線
  keepAlive: 30000,
});
```

**`commandTimeout` 怎麼推**：

```text
必須大於：Redis 的 P99.9 延遲 × 2（留餘裕）
必須小於：你的 HTTP 請求超時（否則 Redis 還在等，上游已經放棄了）

例：Redis P99.9 = 5ms，HTTP 超時 3 秒
    -> commandTimeout 設 200ms～1s 都合理
    -> 設 5 秒是錯的（上游早就超時了，這個等待毫無意義）
```

**沒有設 `commandTimeout` 是很危險的**——Redis 卡住時（例如有人跑了 `KEYS *`），你的請求會一直等，執行緒/連線全部耗盡，變成整個服務不可用。

### 重試策略

```javascript
const redis = new Redis({
  // 連線失敗的重連退避（指數退避 + 上限）
  retryStrategy(times) {
    if (times > 10) return null;              // 放棄，觸發 error 事件
    return Math.min(times * 200, 3000);       // 200ms, 400ms, ... 最多 3 秒
  },

  // 單個命令的重試次數（故障轉移期間很重要）
  maxRetriesPerRequest: 3,

  // 斷線期間的命令要不要排隊等重連
  enableOfflineQueue: true,    // true = 排隊（可能造成延遲累積）
                               // false = 立刻失敗（更快讓上游降級）
});
```

**`enableOfflineQueue` 的取捨**：

```text
true（預設）：
  斷線期間的命令排隊，重連後送出
  好處：故障轉移期間（5～30 秒）的請求不會失敗
  壞處：如果斷很久，隊列會累積大量命令，重連時一次湧入

false：
  斷線期間立刻拋錯
  好處：讓應用能快速走降級路徑（第 09 章）
  壞處：故障轉移期間會有錯誤
```

**如果你已經照第 09 章做了降級（Redis 錯誤就當未命中），設 `false` 反而更好**——快速失敗 + 降級，比排隊等待更能維持服務可用。

### 一定要做的三件事

```javascript
const redis = new Redis({ /* ... */ });

// 1. 設定客戶端名稱（第 12 章：排錯時的關鍵）
redis.on('connect', () => {
  redis.client('SETNAME', `${process.env.SERVICE_NAME}-${process.env.POD_NAME}`);
});

// 2. 監聽錯誤事件（不監聽的話 Node.js 會拋未捕獲異常直接崩潰）
redis.on('error', (err) => {
  logger.error({ err }, 'redis error');
  metrics.increment('redis.error', { type: err.name });
});

// 3. 優雅關閉（避免部署時丟掉正在處理的命令）
process.on('SIGTERM', async () => {
  await redis.quit();     // 等待進行中的命令完成，不要用 disconnect()
  process.exit(0);
});
```

第 2 項在 Node.js 特別重要——**`error` 事件沒有監聽器時會變成未捕獲異常，整個程序崩潰。** 一次 Redis 網路抖動就讓所有 pod 重啟，這是真實發生過的事故模式。

---

## 13.9 容量規劃

### 記憶體估算

```text
總記憶體需求 = 資料量 + 開銷 + 緩衝區 + fork 餘裕

1. 資料量
   對每一類 key：數量 × 平均大小
   用 MEMORY USAGE 實測樣本，不要靠猜（第 12 章）

2. 開銷
   每個 key 約 50～100 bytes 的固定開銷（key 名稱、expire 表、dict entry）
   -> 一千萬個 key 就是 500MB～1GB，只是「存在」的成本

3. 緩衝區
   repl-backlog-size（第 11 章）
   client-output-buffer（第 05、12 章）
   AOF buffer

4. fork 餘裕
   BGSAVE 時的 copy-on-write 可能額外用掉 10～50% 的記憶體
   （寫入越頻繁，COW 複製的頁越多）
```

實際計算範例：

```text
Session：      200 萬 × 800 bytes  = 1.6 GB
商品快取：      50 萬 × 4 KB        = 2.0 GB
排行榜：        50 個 ZSET × 4 MB   = 0.2 GB
限流計數器：    100 萬 × 80 bytes   = 0.08 GB
────────────────────────────────────────────
資料小計                            = 3.9 GB
key 開銷：     351 萬 × 80 bytes    = 0.28 GB
repl-backlog                        = 0.06 GB
客戶端緩衝區（估）                    = 0.2 GB
────────────────────────────────────────────
小計                                = 4.4 GB
fork 餘裕（+30%）                    = 1.3 GB
────────────────────────────────────────────
建議 maxmemory                       = 6 GB
建議機器記憶體（maxmemory / 0.7）      = 8.5 GB -> 選 8 或 16 GB 的機型
```

**兩個規劃原則：**

**`maxmemory` 不要設成機器記憶體的 100%。** 建議 70%，留給 fork 的 COW、作業系統快取、以及突發的客戶端緩衝區。設成 100% 的話，一次 BGSAVE 就可能觸發 OOM kill。

**要規劃成長。** 用過去 3 個月的成長率外推 12 個月，並在容量到 70% 時就開始規劃擴容，不要等到 90%。

### QPS 與網路頻寬

```text
單機 Redis 的能力參考值（簡單命令、小 value）：
  O(1) 命令：8～12 萬 QPS
  用 pipeline：50 萬～100 萬+ QPS
  開啟 TLS：下降 20～40%

網路頻寬 = QPS × (平均請求大小 + 平均回應大小)

例：5 萬 QPS，平均回應 4KB
    50000 × 4KB = 200 MB/s = 1.6 Gbps
    -> 千兆網卡（1 Gbps）會被打滿！
```

**網路頻寬是很容易被忽略的瓶頸。** 快取大 value 時特別明顯——Redis 的 CPU 還很閒，但網卡已經滿了。這時要嘛減小 value（拆 Hash、只取需要的欄位），要嘛加本地快取（第 09 章），要嘛換萬兆網卡。

### 成本估算

```text
自建（雲端 VM）：
  記憶體優化機型（如 AWS r6g.xlarge，32GB）
  + 主從 2 台 + Sentinel 3 台小機器
  + 維運人力成本（最容易被低估的一項）

託管（如 ElastiCache）：
  單價較高（約自建 VM 的 1.5～2 倍）
  但省下備份、監控、故障轉移、版本升級的維運工作

判斷：
  團隊沒有專職 SRE -> 託管幾乎總是更便宜（算上人力）
  規模很大且有 SRE 團隊 -> 自建的邊際成本優勢才顯現
```

---

## 13.10 作業系統層設定

這些設定不做，Redis 會在生產環境出現「無法解釋」的延遲尖峰。

### 1. 關閉透明大頁（THP）

**這是延遲問題的第一號元凶。**

```bash
# 檢查
cat /sys/kernel/mm/transparent_hugepage/enabled
# [always] madvise never    <- 中括號是當前值

# 關閉
echo never > /sys/kernel/mm/transparent_hugepage/enabled
echo never > /sys/kernel/mm/transparent_hugepage/defrag

# 永久生效（加進 /etc/rc.local 或 systemd unit）
```

原因：THP 讓記憶體頁從 4KB 變成 2MB。fork 之後的 copy-on-write 一旦觸發，要複製的就是 2MB 而不是 4KB——**COW 的成本放大 512 倍**。這會讓 BGSAVE 期間的寫入延遲飆升，也會讓記憶體用量暴漲。

Redis 啟動時會警告：

```text
WARNING you have Transparent Huge Pages (THP) support enabled in your kernel.
This will create latency and memory usage issues with Redis.
```

### 2. `vm.overcommit_memory`

```bash
sysctl -w vm.overcommit_memory=1
echo "vm.overcommit_memory = 1" >> /etc/sysctl.conf
```

原因：fork 時作業系統會**保守估計**子行程可能需要和父行程一樣多的記憶體。如果 `overcommit_memory=0`（預設）且可用記憶體不足，`fork()` 會直接失敗：

```text
Can't save in background: fork: Cannot allocate memory
```

實際上 COW 讓子行程幾乎不會真的用掉那麼多，所以設 1（允許 overcommit）是安全且必要的。

### 3. `vm.swappiness`

```bash
sysctl -w vm.swappiness=0        # 或 1（完全不 swap 有 OOM 風險，1 較保守）
```

Redis 的記憶體被 swap 到磁碟時，延遲會從微秒變成毫秒——**這比 Redis 直接掛掉更糟**，因為服務還「活著」但慢到無法使用（第 12 章的 `mem_fragmentation_ratio < 1`）。

### 4. `net.core.somaxconn` 與 TCP backlog

```bash
sysctl -w net.core.somaxconn=1024
echo "net.core.somaxconn = 1024" >> /etc/sysctl.conf
```

```bash
# redis.conf
tcp-backlog 511                  # 不能超過 somaxconn，否則會被截斷
```

高併發連線建立時（例如所有 pod 同時重啟），backlog 太小會導致連線被拒絕。

### 5. 檔案描述符上限

```bash
# 檢查
ulimit -n

# systemd 服務要在 unit 檔設定
# /etc/systemd/system/redis.service.d/override.conf
[Service]
LimitNOFILE=65535
```

**Redis 會自動把 `maxclients` 調降到 `(ulimit -n) - 32`。** 所以 `ulimit -n` 是 1024 的話，`maxclients` 設 10000 也只會生效 992——而且 Redis 啟動時會警告，很多人沒注意到。

### 6. TCP keepalive

```bash
# redis.conf
tcp-keepalive 300
```

偵測半開連線（客戶端機器直接斷電，TCP 連線沒有正常關閉）。沒有這個設定的話，那些死連線會一直佔用 `maxclients` 配額。

### 檢查腳本

```bash
#!/bin/sh
echo "=== THP（應為 never）==="
cat /sys/kernel/mm/transparent_hugepage/enabled

echo "=== overcommit_memory（應為 1）==="
sysctl vm.overcommit_memory

echo "=== swappiness（應為 0 或 1）==="
sysctl vm.swappiness

echo "=== somaxconn（應 >= tcp-backlog）==="
sysctl net.core.somaxconn

echo "=== ulimit -n（應 >= maxclients + 32）==="
ulimit -n

echo "=== Redis 啟動警告 ==="
redis-cli -a "$REDIS_PASSWORD" --no-auth-warning INFO server | grep -E 'redis_version|config_file'
journalctl -u redis 2>/dev/null | grep -i warning | tail -10
```

---

## 13.11 升級與變更

### 版本升級

Redis 的小版本升級（7.2.3 → 7.2.5）通常很安全，大版本（6.2 → 7.0）要看變更說明。

**有主從架構時的滾動升級順序：**

```text
1. 先升級「從節點」
   docker stop replica-1 -> 換映像 -> 啟動 -> 等 master_link_status:up
   重複處理所有從節點

2. 觸發手動故障轉移，讓已升級的從節點成為主
   redis-cli -p 26379 SENTINEL failover mymaster

3. 升級舊的主節點（現在已是從節點）

4. 全部完成後確認版本一致
   redis-cli INFO server | grep redis_version
```

**為什麼先升級從節點**：舊版主節點通常能複製給新版從節點（向前相容），反過來則不一定。而且從節點出問題不影響服務。

**單機沒有主從時**：升級 = 重啟 = 服務中斷 + 可能丟資料。這也是為什麼即使流量不大也建議做主從——**它讓所有維運操作變成零中斷**。

### 設定變更

```bash
# 動態修改（立刻生效，但重啟後失效）
CONFIG SET maxmemory 8gb

# 把當前執行中的設定寫回設定檔
CONFIG REWRITE
```

**`CONFIG REWRITE` 的陷阱**（第 06 章提過）：它會重新格式化整個設定檔，**你手寫的註解可能會消失或被移動**。

實務上建議：

```text
1. 用設定管理工具（Ansible / Puppet / K8s ConfigMap）管理設定檔
2. 變更時同時改「設定檔」和「執行中的設定」（CONFIG SET）
3. 不要依賴 CONFIG REWRITE
4. 部署後驗證：CONFIG GET <參數> 是否等於預期值
```

哪些參數不能動態改（要重啟）：

```text
port / tls-port
bind
unixsocket
databases
rename-command
loadmodule
io-threads
```

### 變更前的檢查

任何生產變更前：

```bash
# 1. 記錄當前設定（回滾用）
redis-cli -a "$PWD" CONFIG GET '*' > /tmp/config-before-$(date +%s).txt

# 2. 確認有可用的備份（第 06 章）
ls -la /data/dump.rdb /data/appendonlydir/

# 3. 確認主從狀態正常
redis-cli -a "$PWD" INFO replication

# 4. 記錄關鍵指標作為變更後的對照
redis-cli -a "$PWD" INFO all > /tmp/info-before-$(date +%s).txt
```

---

## 13.12 上線檢查表

這是本章的核心產出，可以直接複製到你的部署文件。

```text
═══════════════════════════════════════════════════════════
 Redis 上線檢查表
═══════════════════════════════════════════════════════════

【網路與存取】
[ ] 不對公網開放 6379 / 26379 埠
[ ] bind 只綁必要的介面（不是 0.0.0.0）
[ ] 防火牆/安全群組只允許應用伺服器網段
[ ] 同機部署時考慮用 unix socket 並 port 0
[ ] protected-mode 保持 yes

【認證與權限】
[ ] 已建立 ACL 使用者，不使用 default
[ ] default 使用者已停用（ACL SETUSER default off）
[ ] 應用帳號有 -@dangerous
[ ] 應用帳號的 key 權限限制在自己的前綴（~app:*）
[ ] 維運/監控帳號各自獨立
[ ] ACL 設定已持久化（aclfile + ACL SAVE）
[ ] 密碼強度足夠（32 字元以上隨機）
[ ] 密碼存在密鑰管理系統，未寫進程式碼或 git
[ ] 主從有設 masterauth
[ ] ACL LOG 有納入日誌採集與告警

【傳輸加密】
[ ] 跨網路傳輸已啟用 TLS
[ ] tls-replication / tls-cluster 已啟用（若適用）
[ ] 憑證有到期監控
[ ] 已評估 TLS 的效能影響並做過壓測

【危險命令】
[ ] FLUSHALL / FLUSHDB 已封鎖（ACL）
[ ] KEYS 已封鎖
[ ] CONFIG 對應用帳號封鎖
[ ] DEBUG / MONITOR / SHUTDOWN / REPLICAOF 已封鎖
[ ] enable-module-command no（若不需要動態載入模組）
[ ] busy-reply-threshold 已設定（Lua 保護）

【記憶體】
[ ] maxmemory 已設定（不是 0）
[ ] maxmemory 約為機器記憶體的 70%
[ ] maxmemory-policy 符合資料特性
[ ] 已確認 volatile-* 策略下有足夠比例的 key 帶 TTL
[ ] 所有寫入路徑都有設 TTL（或明確知道哪些不設、為什麼）
[ ] 已做過容量估算，並規劃 12 個月的成長

【持久化與備份】
[ ] 已決定 RDB / AOF / 混合，且理由清楚
[ ] 備份有定期複製到「其他機器」（複製不是備份）
[ ] 已實測過還原流程，並記錄 RTO
[ ] 已知道並記錄本實例的 RPO
[ ] 磁碟空間有告警（寫入失敗會導致全面拒絕寫入）

【高可用】
[ ] 有主從（即使流量不大，為了零中斷維運）
[ ] Sentinel 至少 3 個且為奇數
[ ] Sentinel 與 Redis 不在同一故障域
[ ] 每個 Sentinel 有自己的設定檔
[ ] 已實際演練過故障轉移，並記錄 RPO / RTO
[ ] 客戶端透過 Sentinel 取得位址，未寫死 IP
[ ] 已決定是否啟用 min-replicas-to-write
[ ] repl-backlog-size 依寫入量計算過（不是預設 1mb）

【客戶端設定】
[ ] 連線在模組層建立並複用，不是每個請求 new 一個
[ ] 連線池大小依「QPS × 延遲」推算過
[ ] connectTimeout 已設定（1～3 秒）
[ ] commandTimeout 已設定（大於 P99.9，小於 HTTP 超時）
[ ] 重試策略有指數退避與次數上限
[ ] 已決定 enableOfflineQueue 的取捨
[ ] 有監聽 error 事件（Node.js 不監聽會崩潰）
[ ] 有設 CLIENT SETNAME
[ ] 有優雅關閉（SIGTERM 時 quit 而非 disconnect）
[ ] Redis 錯誤時有降級路徑，不會讓請求直接失敗

【作業系統】
[ ] THP 已關閉（never）
[ ] vm.overcommit_memory = 1
[ ] vm.swappiness = 0 或 1
[ ] net.core.somaxconn >= tcp-backlog
[ ] ulimit -n >= maxclients + 32
[ ] tcp-keepalive 已設定
[ ] Redis 以非 root 使用者執行
[ ] 檢查啟動日誌沒有 WARNING

【監控】
[ ] 有 exporter 或等效的指標採集
[ ] P0 告警：無回應、複製中斷、持久化失敗、故障轉移、swap
[ ] P1 告警：記憶體 80%、驅逐、複製延遲、連線數、fork 耗時
[ ] 有應用層埋點：分業務命中率、客戶端延遲、降級次數
[ ] 有慢查詢採集（slowlog 是環狀緩衝，會被沖掉）
[ ] 儀表板涵蓋可用性、資源、效能三層
[ ] 有值班 runbook 與排錯速查表

【文件】
[ ] 架構圖與 key 命名規範
[ ] 各類資料的 RPO / RTO 目標與實測值
[ ] 容量現況與擴容觸發條件
[ ] 故障轉移的處理手冊
[ ] 誰有哪個帳號的權限
═══════════════════════════════════════════════════════════
```

---

## 13.13 常見錯誤

### 錯誤 1：Redis 埠對公網開放

歷史上最大規模的 Redis 事故來源。即使有密碼也不該開放——弱密碼會被爆破，而且不需要漏洞就能造成損害。

### 錯誤 2：用 root 執行 redis-server

讓「寫入任意檔案」的攻擊能直接取得主機權限。用專用的非特權帳號。

### 錯誤 3：只設 `requirepass` 就以為安全了

那個帳號能執行 `FLUSHALL` 和 `CONFIG SET`。6.0 以上要用 ACL 做最小權限。

### 錯誤 4：不停用 `default` 使用者

建了 ACL 帳號但沒停用 `default`，等於前門鎖了後門敞開。

### 錯誤 5：ACL 只在執行中設定，沒有持久化

重啟後全部失效，變成 `default nopass +@all`。要用 `aclfile` + `ACL SAVE`。

### 錯誤 6：先停用 `default` 再改應用設定

順序反了會造成全面中斷。先建帳號、改應用、確認能連、最後才停用。

### 錯誤 7：以為 Lua 沙箱能防住所有問題

沙箱防的是檔案與網路存取，防不了無限迴圈卡死實例。腳本必須有明確的迴圈上界。

### 錯誤 8：沒有關閉 `MODULE LOAD`

它能載入本機任何 `.so`，配合檔案寫入就是遠端程式碼執行。設 `enable-module-command no`。

### 錯誤 9：每個請求建立一個 Redis 連線

最常見的客戶端錯誤，會快速打滿 `maxclients`。連線要在模組層建立並複用。

### 錯誤 10：連線池設得太大

`maxTotal=200` × 50 個 pod = 10000 個連線，正好打滿預設上限。依「QPS × 延遲」推算，通常 8～16 就夠。

### 錯誤 11：沒有設 `commandTimeout`

Redis 被慢命令卡住時，你的請求會無限等待，執行緒耗盡，變成整個服務不可用。

### 錯誤 12：`commandTimeout` 設得比 HTTP 超時還長

上游早就放棄了，你還在等——這個等待毫無意義，只是佔用資源。

### 錯誤 13：Node.js 沒有監聽 `error` 事件

會變成未捕獲異常導致程序崩潰。一次網路抖動讓所有 pod 重啟。

### 錯誤 14：沒關閉 THP

fork 時的 COW 成本放大 512 倍，造成 BGSAVE 期間的延遲尖峰與記憶體暴漲。這是「無法解釋的延遲」最常見的原因。

### 錯誤 15：`maxmemory` 設成機器記憶體的 100%

BGSAVE 的 COW 會需要額外記憶體，設 100% 容易觸發 OOM kill。建議 70%。

### 錯誤 16：`ulimit -n` 太小卻設了很大的 `maxclients`

Redis 會自動調降到 `ulimit -n - 32`，你設的值根本沒生效。啟動日誌有警告但常被忽略。

### 錯誤 17：依賴 `CONFIG REWRITE` 管理設定

它會重排設定檔並可能弄丟註解。用設定管理工具，並在部署後驗證 `CONFIG GET`。

### 錯誤 18：升級時先升主節點

新版主節點複製給舊版從節點不一定相容。先升從節點，再故障轉移。

---

## 13.14 本章練習

### 練習 1：把一個「預設設定」的 Redis 加固到可上線

給你一個用預設設定啟動的 Redis，請把它加固，並驗證每一項生效。

<details>
<summary>參考解答</summary>

**第 1 步：起一個「錯誤示範」的 Redis**

```bash
docker run --name redis-insecure -p 6390:6379 -d redis:7.2 \
  redis-server --bind 0.0.0.0 --protected-mode no
```

驗證它有多不安全：

```bash
# 不需要密碼就能做任何事
docker exec redis-insecure redis-cli PING
docker exec redis-insecure redis-cli CONFIG GET dir
docker exec redis-insecure redis-cli ACL LIST
# 1) "user default on nopass sanitize-payload ~* &* +@all"
```

`on nopass ~* &* +@all` 就是「啟用、無密碼、所有 key、所有頻道、所有命令」。

**第 2 步：建立加固的設定檔**

```bash
mkdir -p secure
cat > secure/redis.conf <<'EOF'
################################ 網路 #################################
bind 0.0.0.0
protected-mode yes
port 6379
tcp-backlog 511
tcp-keepalive 300
timeout 300

############################### 記憶體 ################################
maxmemory 256mb
maxmemory-policy allkeys-lru

############################### 持久化 ################################
appendonly yes
appendfsync everysec
save 900 1
save 300 10

############################### 安全 ##################################
aclfile /etc/redis/users.acl
enable-module-command no
enable-debug-command no
enable-protected-configs no
busy-reply-threshold 5000

############################### 複製 ##################################
repl-backlog-size 64mb
replica-read-only yes

############################### 日誌 ##################################
loglevel notice
slowlog-log-slower-than 10000
slowlog-max-len 256
latency-monitor-threshold 100
EOF
```

（`bind 0.0.0.0` 在容器裡是必要的，因為要接受來自其他容器的連線；真正的隔離靠 Docker 網路與防火牆。裸機部署時要綁具體的內網 IP。）

**第 3 步：建立 ACL 檔案**

```bash
cat > secure/users.acl <<'EOF'
# default 停用
user default off

# 應用帳號：只能操作 app: 前綴，不能執行危險命令
user app_service on >AppSecret_LongRandom_2026 ~app:* ~cache:* &app:events:* +@read +@write +@string +@hash +@list +@set +@sortedset +@stream +ping +info -@dangerous

# 唯讀帳號
user readonly on >ReadSecret_LongRandom_2026 ~* +@read -@dangerous

# 維運帳號：可管理但不能清資料
user ops on >OpsSecret_LongRandom_2026 ~* &* +@all -flushall -flushdb -shutdown -debug -reset

# 監控帳號：只能讀指標
user monitoring on >MonitorSecret_LongRandom_2026 ~* +info +ping +client|list +config|get +slowlog|get +latency|latest +memory|stats +cluster|info
EOF
```

**第 4 步：啟動並驗證每一項**

```bash
docker rm -f redis-insecure

docker run --name redis-secure -p 6390:6379 -d \
  -v "$(pwd)/secure/redis.conf:/etc/redis/redis.conf" \
  -v "$(pwd)/secure/users.acl:/etc/redis/users.acl" \
  redis:7.2 redis-server /etc/redis/redis.conf
```

逐項驗證：

```bash
# ✓ 1. 無密碼被拒絕
docker exec redis-secure redis-cli PING
# (error) NOAUTH Authentication required.

# ✓ 2. default 已停用
docker exec redis-secure redis-cli -a AppSecret_LongRandom_2026 --no-auth-warning PING
# (error) WRONGPASS invalid username-password pair or user is disabled.
#   ^ 因為沒帶 --user，預設用 default，而 default 已停用

# ✓ 3. 應用帳號可以正常使用自己的 key
docker exec redis-secure redis-cli --user app_service -a AppSecret_LongRandom_2026 \
  --no-auth-warning SET app:test "hello"
# OK

# ✓ 4. 應用帳號不能碰別人的 key
docker exec redis-secure redis-cli --user app_service -a AppSecret_LongRandom_2026 \
  --no-auth-warning SET other:test "hello"
# (error) NOPERM No permissions to access a key

# ✓ 5. 應用帳號不能執行危險命令
docker exec redis-secure redis-cli --user app_service -a AppSecret_LongRandom_2026 \
  --no-auth-warning FLUSHALL
# (error) NOPERM ... has no permissions to run the 'flushall' command

docker exec redis-secure redis-cli --user app_service -a AppSecret_LongRandom_2026 \
  --no-auth-warning KEYS '*'
# (error) NOPERM ...

docker exec redis-secure redis-cli --user app_service -a AppSecret_LongRandom_2026 \
  --no-auth-warning CONFIG GET dir
# (error) NOPERM ...

# ✓ 6. 唯讀帳號不能寫
docker exec redis-secure redis-cli --user readonly -a ReadSecret_LongRandom_2026 \
  --no-auth-warning SET app:x 1
# (error) NOPERM ...
docker exec redis-secure redis-cli --user readonly -a ReadSecret_LongRandom_2026 \
  --no-auth-warning GET app:test
# "hello"

# ✓ 7. 維運帳號可以管理但不能清空
docker exec redis-secure redis-cli --user ops -a OpsSecret_LongRandom_2026 \
  --no-auth-warning CONFIG GET maxmemory
# 1) "maxmemory"  2) "268435456"
docker exec redis-secure redis-cli --user ops -a OpsSecret_LongRandom_2026 \
  --no-auth-warning FLUSHALL
# (error) NOPERM ...

# ✓ 8. 模組載入已禁用
docker exec redis-secure redis-cli --user ops -a OpsSecret_LongRandom_2026 \
  --no-auth-warning MODULE LIST
# (error) ERR MODULE command not allowed. ...

# ✓ 9. 記憶體與策略生效
docker exec redis-secure redis-cli --user ops -a OpsSecret_LongRandom_2026 \
  --no-auth-warning CONFIG GET maxmemory-policy
# 1) "maxmemory-policy"  2) "allkeys-lru"

# ✓ 10. ACL 日誌記錄了所有違規
docker exec redis-secure redis-cli --user ops -a OpsSecret_LongRandom_2026 \
  --no-auth-warning ACL LOG 3
```

`ACL LOG` 的輸出會顯示剛才所有被拒的嘗試，包含使用者名稱、被拒的命令、以及客戶端資訊——這正是第 12 章排錯時需要的稽核軌跡。

**第 5 步：檢查啟動警告**

```bash
docker logs redis-secure 2>&1 | grep -i warning
```

在 Docker Desktop（macOS）上通常會看到：

```text
WARNING Memory overcommit must be enabled! ...
```

這是宿主機層的設定（13.10 節），在 Docker Desktop 裡改不了，但在真實的 Linux 主機上必須處理。

**第 6 步：驗證作業系統層（在真實 Linux 主機上）**

```bash
# THP
cat /sys/kernel/mm/transparent_hugepage/enabled       # 要看到 [never]

# overcommit
sysctl vm.overcommit_memory                           # 要是 1

# swappiness
sysctl vm.swappiness                                  # 要是 0 或 1

# somaxconn
sysctl net.core.somaxconn                             # 要 >= 511

# fd 上限
ulimit -n                                             # 要 >= maxclients + 32

# 執行使用者
ps -o user= -p $(pgrep -f redis-server | head -1)     # 不能是 root
```

**清理**

```bash
docker rm -f redis-secure
rm -rf secure
```

**這個練習的重點**：加固不是「設個密碼」，而是**每一項都要驗證生效**。上面十項驗證裡，任何一項失敗都代表有一個真實的攻擊面沒關上。

</details>

### 練習 2：修好一段有問題的客戶端設定

以下是某服務的 Redis 客戶端設定，它在生產環境造成了三次事故。請找出所有問題。

```javascript
// src/services/product.js
const Redis = require('ioredis');

async function getProduct(id) {
  const redis = new Redis({
    host: process.env.REDIS_HOST,
    port: 6379,
    password: 'Pr0duct10n_R3d1s_2024',
  });

  const cached = await redis.get(`product:${id}`);
  if (cached) {
    await redis.quit();
    return JSON.parse(cached);
  }

  const product = await db.getProduct(id);
  await redis.set(`product:${id}`, JSON.stringify(product));
  await redis.quit();
  return product;
}

module.exports = { getProduct };
```

<details>
<summary>參考解答</summary>

**問題 1：每個請求建立一個新連線（造成過的事故：連線數打滿）**

`new Redis()` 在函式內部，每次呼叫 `getProduct` 都建立一次 TCP 連線 + 認證。在 5000 QPS 下，這是每秒 5000 次連線建立——`maxclients` 會瞬間打滿，`INFO stats` 的 `rejected_connections` 開始飆升（第 12 章劇本 3）。

**問題 2：密碼寫死在程式碼裡（造成過的事故：憑證洩漏）**

它會進 git 歷史、進 CI 日誌、進錯誤堆疊。而且輪換密碼要改程式碼重新部署。

**問題 3：沒有設定任何超時**

`connectTimeout` 和 `commandTimeout` 都沒設。Redis 被慢命令卡住時（例如有人跑 `KEYS *`），所有請求會無限等待，Node.js 的事件循環堆滿待處理的 Promise，服務完全不回應。

**問題 4：沒有監聽 `error` 事件（造成過的事故：全部 pod 崩潰）**

ioredis 在連線出錯時會 emit `error`。沒有監聽器的 EventEmitter 錯誤在 Node.js 裡會變成**未捕獲異常，直接讓程序退出**。一次 Redis 網路抖動 → 所有 pod 同時崩潰重啟。

這是三次事故裡最嚴重的一個，因為它把「Redis 短暫不可用」放大成「整個服務中斷」。

**問題 5：Redis 錯誤沒有降級**

`await redis.get()` 拋錯會讓整個 `getProduct` 失敗。快取不可用時應該退回資料庫，而不是讓請求失敗（第 09 章）。

**問題 6：`if (cached)` 用真值判斷**

`cached` 是 `""` 或 `"0"` 時會被判為 false，明明命中卻回源。要用 `!== null`。

**問題 7：`set` 沒有設 TTL**

這個 key 會永久存在。累積下來記憶體無限成長，而且 `volatile-lru` 策略下它永遠不會被驅逐（第 05、12 章）。

**問題 8：沒有處理「查不到」的情況**

`db.getProduct` 回傳 `undefined` 時，`JSON.stringify(undefined)` 得到 `undefined`（不是字串），寫入行為取決於客戶端；而且下次讀取時 `JSON.parse` 會拋錯。同時也造成快取穿透（第 09 章）。

**問題 9：沒有設 `CLIENT SETNAME`**

排錯時 `SLOWLOG` 和 `CLIENT LIST` 只有 IP，在 K8s 環境下無法定位是哪個服務（第 12 章）。

**問題 10：沒有優雅關閉**

部署時 pod 收到 SIGTERM 直接退出，進行中的命令會被中斷。

**修正版本：**

```javascript
// src/lib/redis.js —— 連線在模組層建立一次
const Redis = require('ioredis');
const logger = require('./logger');
const metrics = require('./metrics');

const redis = new Redis({
  host: process.env.REDIS_HOST,
  port: parseInt(process.env.REDIS_PORT || '6379', 10),

  // 用 ACL 帳號 + 環境變數
  username: process.env.REDIS_USERNAME,
  password: process.env.REDIS_PASSWORD,

  // 超時：commandTimeout 要大於 P99.9 且小於上游的 HTTP 超時
  connectTimeout: 2000,
  commandTimeout: 500,
  keepAlive: 30000,

  // 重試：指數退避 + 上限
  retryStrategy(times) {
    if (times > 10) return null;
    return Math.min(times * 200, 3000);
  },
  maxRetriesPerRequest: 3,

  // 已有降級路徑，所以快速失敗優於排隊（第 09 章）
  enableOfflineQueue: false,
});

// 必須監聽 error，否則未捕獲異常會讓程序崩潰
redis.on('error', (err) => {
  logger.error({ err: err.message }, 'redis error');
  metrics.increment('redis.error', { type: err.name });
});

redis.on('connect', () => {
  // 排錯時能定位到具體的服務與 pod
  redis.client('SETNAME',
    `${process.env.SERVICE_NAME || 'unknown'}-${process.env.POD_NAME || process.pid}`)
    .catch(() => {});   // 失敗不影響服務
});

redis.on('reconnecting', (delay) => {
  logger.warn({ delay }, 'redis reconnecting');
});

// 優雅關閉：quit 會等進行中的命令完成，disconnect 不會
async function shutdown() {
  try {
    await redis.quit();
  } catch (err) {
    redis.disconnect();
  }
}

module.exports = { redis, shutdown };
```

```javascript
// src/services/product.js
const { redis } = require('../lib/redis');
const metrics = require('../lib/metrics');

const TTL_BASE = 300;
const TTL_NULL = 30;
const NULL_MARKER = ' NULL';

function ttlWithJitter(base = TTL_BASE) {
  return base + Math.floor(base * 0.2 * Math.random());
}

async function getProduct(id) {
  const key = `product:${id}`;

  // 讀快取：任何錯誤都降級成未命中，不讓請求失敗
  let cached = null;
  try {
    cached = await redis.get(key);
  } catch (err) {
    metrics.increment('redis.degraded', { op: 'get' });
    // 不 rethrow，繼續走資料庫
  }

  if (cached === NULL_MARKER) {
    metrics.increment('cache.hit', { biz: 'product', type: 'null' });
    return null;
  }
  if (cached !== null) {                       // 明確比對 null，不用真值判斷
    metrics.increment('cache.hit', { biz: 'product' });
    try {
      return JSON.parse(cached);
    } catch (err) {
      // 快取內容損壞，當作未命中重建
      metrics.increment('cache.corrupted', { biz: 'product' });
    }
  }

  metrics.increment('cache.miss', { biz: 'product' });
  const product = await db.getProduct(id);

  // 寫快取：失敗不影響回傳
  try {
    if (!product) {
      await redis.set(key, NULL_MARKER, 'EX', TTL_NULL);   // 防穿透
    } else {
      await redis.set(key, JSON.stringify(product), 'EX', ttlWithJitter());
    }
  } catch (err) {
    metrics.increment('redis.degraded', { op: 'set' });
  }

  return product || null;
}

module.exports = { getProduct };
```

```javascript
// src/index.js —— 優雅關閉
const { shutdown } = require('./lib/redis');

process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down');
  server.close();
  await shutdown();
  process.exit(0);
});
```

**對應的 ACL 帳號：**

```bash
ACL SETUSER product_service on \
  >"$(openssl rand -base64 32)" \
  ~product:* \
  +@read +@write +@string +ping +info +client\|setname \
  -@dangerous
ACL SAVE
```

注意要顯式加上 `+client|setname`，否則 `-@dangerous` 會連 `CLIENT` 一起擋掉，`SETNAME` 就會失敗。

**這題的核心結論**：三次事故裡有兩次（連線打滿、pod 全崩）**完全是客戶端設定造成的，Redis 本身沒有任何問題**。這也是本章把客戶端設定和安全放在同一章的原因——它們同樣屬於「不做就會出事，但做了也看不出效果」的那一類工作。

</details>

### 練習 3：為一個多服務環境設計 ACL 權限矩陣

某公司的 Redis 被以下六個角色使用：

| 角色 | 需求 |
|------|------|
| 訂單服務 | 讀寫 `order:*`、`lock:order:*`；發布 `events:order:*` |
| 商品服務 | 讀寫 `product:*`、`cache:product:*` |
| 前台 Web | 讀寫 `session:*`；讀 `cache:product:*`（不能寫） |
| 限流網關 | 讀寫 `rate:*`；需要執行 Lua |
| 資料分析 | 唯讀所有 key，且不能影響效能 |
| SRE 值班 | 需要排錯，但不能刪資料 |

請設計 ACL 規則，並說明每個決策的理由。

<details>
<summary>參考解答</summary>

**設計原則**

三個原則貫穿整份設計：

1. **key 前綴即權限邊界**——每個服務只能碰自己的前綴，這也反過來要求 key 命名規範必須嚴格（第 01 章）。
2. **所有應用帳號一律 `-@dangerous`**，需要的個別命令再加回來。
3. **能唯讀就唯讀**——前台 Web 讀商品快取但不該寫，用 `%R~` 明確表達。

**ACL 檔案**

```bash
# /etc/redis/users.acl

# ─────────────────────────────────────────────────────────────
# default 停用
# ─────────────────────────────────────────────────────────────
user default off

# ─────────────────────────────────────────────────────────────
# 訂單服務
#   - 讀寫 order:* 與 lock:order:*
#   - 發布 events:order:* 頻道
#   - 需要 SET NX / EXPIRE（分散式鎖）與 EVAL（釋放鎖要用 Lua）
# ─────────────────────────────────────────────────────────────
user svc_order on >ORDER_SECRET_REPLACE_ME \
  ~order:* ~lock:order:* \
  &events:order:* \
  +@read +@write +@string +@hash +@list +@sortedset +@set +@stream \
  +expire +pexpire +ttl +pttl +persist \
  +eval +evalsha +script|load \
  +publish \
  +ping +info +client|setname \
  -@dangerous

# ─────────────────────────────────────────────────────────────
# 商品服務
#   - 讀寫 product:*（事實來源的快取）與 cache:product:*
#   - 不需要 Lua、不需要 Pub/Sub
# ─────────────────────────────────────────────────────────────
user svc_product on >PRODUCT_SECRET_REPLACE_ME \
  ~product:* ~cache:product:* \
  resetchannels \
  +@read +@write +@string +@hash +@list +@sortedset +@set \
  +expire +pexpire +ttl +persist \
  +ping +info +client|setname \
  -@dangerous

# ─────────────────────────────────────────────────────────────
# 前台 Web
#   - 讀寫 session:*
#   - 只「讀」cache:product:*  <- 用 %R~ 表達（Redis 7.0+）
#   - 訂閱商品快取失效事件（多級快取，第 09 章）
# ─────────────────────────────────────────────────────────────
user svc_web on >WEB_SECRET_REPLACE_ME \
  ~session:* %R~cache:product:* \
  &cache:invalidate:* \
  +@read +@write +@string +@hash \
  +expire +pexpire +ttl \
  +subscribe +psubscribe +unsubscribe \
  +ping +info +client|setname \
  -@dangerous

# ─────────────────────────────────────────────────────────────
# 限流網關
#   - 讀寫 rate:*，需要 EVAL（第 10 章的限流腳本）
#   - 命令範圍刻意收得很窄：它只需要計數與 ZSET
# ─────────────────────────────────────────────────────────────
user svc_gateway on >GATEWAY_SECRET_REPLACE_ME \
  ~rate:* ~bucket:* \
  resetchannels \
  +get +set +incr +incrby +decr +expire +pexpire +ttl \
  +hget +hset +hmget +hincrby \
  +zadd +zcard +zremrangebyscore +zrange \
  +eval +evalsha +script|load \
  +ping +info +client|setname

# ─────────────────────────────────────────────────────────────
# 資料分析
#   - 唯讀所有 key
#   - 關鍵：禁止 KEYS，只允許 SCAN 系列（避免阻塞，第 04 章）
#   - 不允許 O(N) 的整份取回命令
# ─────────────────────────────────────────────────────────────
user analytics on >ANALYTICS_SECRET_REPLACE_ME \
  ~* \
  resetchannels \
  +@read -@dangerous \
  -keys -hgetall -smembers -lrange \
  +scan +hscan +sscan +zscan \
  +ping +info +client|setname

# ─────────────────────────────────────────────────────────────
# SRE 值班
#   - 排錯需要的一切，但不能刪資料、不能關機
# ─────────────────────────────────────────────────────────────
user sre on >SRE_SECRET_REPLACE_ME \
  ~* &* \
  +@all \
  -flushall -flushdb -shutdown -reset \
  -debug -replicaof -slaveof -failover \
  -del -unlink

# ─────────────────────────────────────────────────────────────
# 監控採集
# ─────────────────────────────────────────────────────────────
user monitoring on >MONITORING_SECRET_REPLACE_ME \
  resetkeys resetchannels \
  +info +ping +client|list +config|get \
  +slowlog|get +slowlog|len +latency|latest +latency|history \
  +memory|stats +memory|doctor +cluster|info +acl|log
```

**權限矩陣**

| | order | product | web | gateway | analytics | sre |
|---|-------|---------|-----|---------|-----------|-----|
| `order:*` | RW | — | — | — | R | RW |
| `lock:order:*` | RW | — | — | — | R | RW |
| `product:*` | — | RW | — | — | R | RW |
| `cache:product:*` | — | RW | **R only** | — | R | RW |
| `session:*` | — | — | RW | — | R | RW |
| `rate:*` / `bucket:*` | — | — | — | RW | R | RW |
| `EVAL` | ✓ | — | — | ✓ | — | ✓ |
| `KEYS` | — | — | — | — | **—** | ✓ |
| `SCAN` | — | — | — | — | ✓ | ✓ |
| `FLUSHALL` | — | — | — | — | — | **—** |
| `DEL` | ✓ | ✓ | ✓ | — | — | **—** |

**每個決策的理由**

**為什麼前台 Web 用 `%R~cache:product:*`**

前台不該有能力寫商品快取——那是商品服務的職責。如果前台能寫，一個 bug 就能污染所有使用者看到的商品資料，而且事後完全無法從權限上排除嫌疑。`%R~` 讓這件事在**權限層面**不可能發生，而不是靠 code review 保證。

（若 Redis < 7.0 沒有 `%R~`，退而求其次是把商品快取拆到另一個實例，或接受這個風險並在 code review 把關。）

**為什麼分析帳號要顯式 `-keys -hgetall -smembers -lrange`**

`+@read` 包含這些命令，而它們都是 O(N)——分析人員在正式環境跑一個 `HGETALL` 大 Hash 就能卡住整個實例（第 04 章）。需求裡「不能影響效能」這句話，在 ACL 上就是這幾個 `-`。

只留 `SCAN` 系列，強迫他們分批取。

**為什麼 SRE 不能 `DEL`**

這是有爭議的設計，理由是：**排錯不需要刪資料。** 值班時最容易犯的錯就是「先刪掉試試看」，而那個動作往往不可逆。真的需要刪時，走一個需要另一人核可的流程（用另一個帳號或臨時 `ACL SETUSER`）。

如果團隊文化上覺得這太綁手，至少要保留 `-flushall -flushdb`——一次誤下 `FLUSHALL` 的代價遠大於多一道流程的麻煩。

**為什麼限流網關的命令列白名單，而不是用 `+@write -@dangerous`**

它是最容易暴露在外部流量的服務（在網關層），所以權限收得最緊。列舉它實際用到的十幾個命令，比「除了危險的都給」更安全——如果哪天它被入侵，攻擊者能做的事極其有限。

代價是新增功能時要改 ACL。這個摩擦是刻意的。

**為什麼監控帳號要 `resetkeys`**

它完全不需要存取任何 key，只需要 `INFO` 之類的管理命令。`resetkeys` 明確表達「零 key 權限」，比不寫 `~` 更清楚（不寫的話預設也是沒有，但顯式宣告可讀性更好）。

**為什麼所有帳號都加 `+client|setname`**

因為 `-@dangerous` 會把 `CLIENT` 整個擋掉，而 `CLIENT SETNAME` 是排錯的必要條件（第 12 章）。這是實務上很容易忘記的一行——加固完之後發現 `SLOWLOG` 裡的 client name 全是空的，就是漏了它。

**部署與輪換流程**

```bash
# 1. 用隨機密碼生成正式的 acl 檔案
for role in order product web gateway analytics sre monitoring; do
  echo "${role}: $(openssl rand -base64 32)"
done > /secure/redis-passwords.txt   # 存進密鑰管理系統，不要留在磁碟

# 2. 部署 aclfile 並載入（不需要重啟）
redis-cli --user sre -a "$SRE_PASSWORD" ACL LOAD

# 3. 驗證每個帳號
redis-cli --user svc_web -a "$WEB_PASSWORD" SET cache:product:1 x
# 應該回 NOPERM

# 4. 確認無誤後停用 default
redis-cli --user sre -a "$SRE_PASSWORD" ACL SETUSER default off
redis-cli --user sre -a "$SRE_PASSWORD" ACL SAVE
```

密碼輪換可以無中斷進行，因為一個 ACL 使用者可以有多個密碼：

```bash
# 加上新密碼（舊密碼仍有效）
ACL SETUSER svc_order >NEW_SECRET
ACL SAVE
# 滾動部署應用，改用新密碼
# 全部完成後移除舊密碼
ACL SETUSER svc_order <OLD_SECRET
ACL SAVE
```

**最後要配上告警**

```text
ACL LOG 出現任何 reason=command 或 reason=key
  -> P1 告警
```

正常運作的應用**不該觸發任何 ACL 拒絕**。一旦出現，兩種可能：有人在做不該做的事，或是你的 ACL 漏了某個正常需要的命令。兩者都需要立刻知道。

</details>

---

## 13.15 驗收清單

進入下一章前，確認你可以：

- [ ] 說明「未授權存取」的三種攻擊路徑，以及為什麼升級版本防不了。
- [ ] 說明 `protected-mode` 保護什麼，以及為什麼不能依賴它。
- [ ] 正確設定 `bind`、防火牆，並說明 unix socket 的優勢。
- [ ] 說明為什麼不能用 root 執行 redis-server。
- [ ] 說出 `requirepass` 的三個問題。
- [ ] 用 ACL 建立最小權限帳號，包含 key 模式、命令類別與頻道。
- [ ] 說明 `-@dangerous` 涵蓋哪些命令，以及為什麼要另外加回 `+client|setname`。
- [ ] 用 `aclfile` 持久化 ACL，並說明停用 `default` 的正確順序。
- [ ] 用 `ACL LOG` 追查違規存取。
- [ ] 設定 TLS，並說明它對 Redis 的效能影響為什麼比對多執行緒服務更大。
- [ ] 比較 ACL 與 `rename-command` 的取捨。
- [ ] 說明 Lua 沙箱防什麼、不防什麼，以及 `SCRIPT KILL` 的限制。
- [ ] 說明 `MODULE LOAD` 為什麼是攻擊面。
- [ ] 用「QPS × 延遲」推算連線池大小，並說明多數團隊為什麼設得太大。
- [ ] 區分 `connectTimeout`、`commandTimeout`、`keepAlive`，並說明後者怎麼推。
- [ ] 說明 `enableOfflineQueue` 的取捨，以及有降級時該怎麼選。
- [ ] 說明 Node.js 不監聽 `error` 事件的後果。
- [ ] 做一次完整的記憶體容量估算，包含 key 開銷與 fork 餘裕。
- [ ] 判斷網路頻寬是否會成為瓶頸。
- [ ] 說明關閉 THP 為什麼是延遲問題的第一號檢查項。
- [ ] 設定 `vm.overcommit_memory`、`vm.swappiness`、`somaxconn`、`ulimit -n`。
- [ ] 說明滾動升級為什麼要先升從節點。
- [ ] 逐項走完上線檢查表。

---

最後一章把全部十四章的內容用在一個真實系統上：[14-capstone-redis-architecture.md](./14-capstone-redis-architecture.md)，我們要為一個電商直播平台設計完整的 Redis 架構。
