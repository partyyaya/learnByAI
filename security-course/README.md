# 資安攻防完整課程（Ethical Hacking / 滲透測試）

> 這不是一門「教你入侵別人」的課，而是「用攻擊者的思維理解系統，再用防禦者的手段守住它」。
> 我們會從駭客思維、法律紅線、實驗室搭建開始，一路走過偵察、Web 攻防、系統攻防、密碼學、社會工程，
> 最後收在藍隊防禦、事件回應與一次完整的授權滲透測試。**每一個攻擊技術都會配一段「怎麼防」**——
> 因為懂攻擊只是手段，讓系統更安全才是目的。重點是建立可遷移的攻防心智模型，而不是背工具指令。

---

## ⚠️ 開始前，先讀這段（不是客套話）

這門課教的技術**只能用在你有明確書面授權的目標，或你自己搭建的隔離實驗室**。

- **未經授權**存取、掃描、攻擊任何電腦系統，在台灣觸犯《刑法》第 36 章妨害電腦使用罪，在多數國家都是刑事犯罪。
- 「我只是好奇 / 只是掃一下沒破壞」**不是抗辯理由**——很多罪名光是「未授權存取」就成立。
- 本課所有實作都在**你自己的虛擬機靶場**（DVWA、Juice Shop、Metasploitable、TryHackMe / HackTheBox 這類合法平台）進行。
- 學會的能力請走**負責任揭露（responsible disclosure）**，不要拿去炫技或牟利。

第 00 章會把法律與倫理框架講得更完整。**先把這條紅線刻在心裡，再往下學。**

---

## 課程目錄

課程分為 7 篇、24 章（00–23），目前已全數發布。

### 第 0 篇 —— 入門與地基

| 章節 | 檔案 | 主題 |
|------|------|------|
| 00 | [00-course-map-ethics-and-mindset.md](./00-course-map-ethics-and-mindset.md) | 課程地圖・駭客思維・法律與倫理 |
| 01 | [01-build-your-lab.md](./01-build-your-lab.md) | 打造你的攻防實驗室 |
| 02 | [02-networking-for-attackers.md](./02-networking-for-attackers.md) | 攻防必備的網路基礎 |
| 03 | [03-linux-and-cli-for-security.md](./03-linux-and-cli-for-security.md) | 攻防必備的 Linux 與命令列 |

### 第 1 篇 —— 偵察與掃描

| 章節 | 檔案 | 主題 |
|------|------|------|
| 04 | [04-osint-passive-recon.md](./04-osint-passive-recon.md) | 被動情報蒐集 OSINT |
| 05 | [05-active-scanning-enumeration.md](./05-active-scanning-enumeration.md) | 主動掃描與列舉 |

### 第 2 篇 —— Web 攻防

| 章節 | 檔案 | 主題 |
|------|------|------|
| 06 | [06-web-attack-map-owasp-burp.md](./06-web-attack-map-owasp-burp.md) | Web 攻擊地圖:OWASP Top 10 與 Burp Suite |
| 07 | [07-sql-injection.md](./07-sql-injection.md) | 注入攻擊:SQL Injection |
| 08 | [08-other-injections.md](./08-other-injections.md) | 其他注入:命令注入・XXE・SSTI・NoSQL |
| 09 | [09-xss.md](./09-xss.md) | 跨站腳本 XSS 與 CSP 防禦 |
| 10 | [10-csrf-ssrf.md](./10-csrf-ssrf.md) | CSRF・SSRF:兩種「請求偽造」 |
| 11 | [11-authentication-session.md](./11-authentication-session.md) | 認證與 Session 攻防（含 JWT） |
| 12 | [12-access-control-idor.md](./12-access-control-idor.md) | 存取控制與業務邏輯漏洞（IDOR、越權） |
| 13 | [13-file-upload-path-traversal-deserialization.md](./13-file-upload-path-traversal-deserialization.md) | 檔案上傳・路徑穿越・反序列化 |

### 第 3 篇 —— 系統攻防

| 章節 | 檔案 | 主題 |
|------|------|------|
| 14 | [14-exploitation-basics-metasploit.md](./14-exploitation-basics-metasploit.md) | 漏洞利用基礎（記憶體安全概念、Metasploit） |
| 15 | [15-password-attacks-hash-cracking.md](./15-password-attacks-hash-cracking.md) | 密碼攻擊與雜湊破解 |
| 16 | [16-privilege-escalation-post-exploitation.md](./16-privilege-escalation-post-exploitation.md) | 提權與後滲透 |

### 第 4 篇 —— 密碼與人性

| 章節 | 檔案 | 主題 |
|------|------|------|
| 17 | [17-applied-cryptography.md](./17-applied-cryptography.md) | 應用密碼學攻防 |
| 18 | [18-social-engineering-phishing.md](./18-social-engineering-phishing.md) | 社會工程與釣魚（防禦向） |

### 第 5 篇 —— 藍隊防禦

| 章節 | 檔案 | 主題 |
|------|------|------|
| 19 | [19-defense-hardening.md](./19-defense-hardening.md) | 防禦體系與系統加固 |
| 20 | [20-detection-monitoring-siem.md](./20-detection-monitoring-siem.md) | 偵測與監控（Log / SIEM / IDS） |
| 21 | [21-incident-response-forensics.md](./21-incident-response-forensics.md) | 事件回應與數位鑑識 |

### 第 6 篇 —— 實戰

| 章節 | 檔案 | 主題 |
|------|------|------|
| 22 | [22-ctf.md](./22-ctf.md) | CTF 實戰入門 |
| 23 | [23-capstone-pentest.md](./23-capstone-pentest.md) | Capstone:一次完整的授權滲透測試 |

---

## 課程特色

- **攻防對照**:每個攻擊技術都配「防禦方怎麼擋」，紅隊藍隊一起學，才不會變成半吊子。
- **原理優先**:先問「這個漏洞為什麼會存在」（設計缺陷、信任錯置），再講怎麼利用、怎麼修。
- **心智模型**:把散落的技巧收斂成幾個核心觀念（信任邊界、輸入即危險、最小權限），能力才可遷移。
- **逐段解釋**:payload 與工具指令附逐行註解，不是貼一串魔法字串要你照抄。
- **合法可練**:全程在自建靶場動手，每章標明對應的練習環境。

## 適合對象

- 想理解「自己寫的網站為什麼會被打」的前端 / 後端 / 全端工程師。
- 想入門滲透測試、準備 CEH / OSCP 這類證照的人。
- 負責 code review、想看懂資安報告在講什麼的技術主管。
- 對 CTF、資安攻防有興趣，想建立系統性知識的人。

## 前置知識

- 基本的命令列操作（`cd`、`ls`、管線 `|`）。
- 懂 HTTP 請求/回應長什麼樣（第 02、06 章會再補）。
- 會用瀏覽器開發者工具看 Network 面板。
- 搭配閱讀:本倉庫的 [Nginx 課程](../nginx/README.md)（反向代理與安全）、[Docker 課程](../docker/README.md)（搭靶場很好用）、[通用基礎的 HTTP/HTTPS](../common/README.md) 會更有感。

## 學習路線建議

```
地基篇（必修，別跳）
  00 法律與心態 → 01 實驗室 → 02 網路 → 03 Linux

偵察篇（攻擊的起手式）
  04 OSINT → 05 掃描列舉

Web 攻防篇（前端/後端工程師的核心戰場）
  06 攻擊地圖 → 07 SQLi → 08 其他注入 → 09 XSS → ...

防禦篇（真正的目的地）
  19 加固 → 20 偵測 → 21 事件回應

實戰篇（收尾）
  22 CTF → 23 完整滲透測試
```

> 第一次學務必從第 00 章開始——不是因為它「簡單」，而是因為法律紅線與實驗室隔離**必須先建立**，
> 否則你很可能在「只是想試試看」的心態下踩到刑責。把地基篇走完，後面的攻防才學得踏實又安全。
