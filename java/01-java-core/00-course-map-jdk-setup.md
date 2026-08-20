# 第 00 章：課程地圖、JDK 版本與環境安裝

> 學 Java 最常見的第一個坑，不是語法，而是**環境**。
> 「我電腦裡到底有幾個 Java？」「公司專案是 8，教材是 21，我該裝哪個？」「為什麼同事跑得起來我跑不起來？」
> 這章先把版本、發行商、安裝、編譯流程弄清楚，之後每一章你才有一個能跑、能重現的環境。

---

## 0.1 學習目標

完成本章後，你應該可以：

- 說明 JDK、JRE、JVM 的差別，以及為什麼「寫一次到處跑」是 JVM 的功勞。
- 說出 Java 的發行節奏（每 6 個月一版）與 LTS 策略，並判斷專案該選哪一版。
- 分辨 Temurin、Oracle JDK、Corretto、Zulu、GraalVM 的差異，避開 Oracle 授權地雷。
- 用 SDKMAN（macOS / Linux）或 winget（Windows）安裝並**切換多個 JDK 版本**。
- 正確設定 `JAVA_HOME` 與 `PATH`，並解釋 IDE 為什麼可以用跟終端機不同的 JDK。
- 從 `.java` → `.class` → 執行，完整說出編譯與執行流程，並用 `javap` 看到 bytecode。
- 建立一個 Maven 專案骨架，這個骨架會用到整門課結束。
- 看到 `UnsupportedClassVersionError`、中文亂碼、`JAVA_HOME is not set` 時，知道原因在哪。
- **用除錯器設中斷點、條件式中斷點與例外中斷點**，並知道什麼時候它會騙你、什麼時候該改用日誌或傾印。

---

## 0.2 這門課要把你帶到哪裡

先看整體地圖。這門子課程（01-java-core）在整條 Java 後端路線的位置是**地基**：

```
[你在這裡] 01-java-core     語言 + JVM + 建置 + 測試
                ↓
           02-spring-boot   IoC / DI / 自動組態
                ↓
           03~06            REST API / Controller / Service / Repository
                ↓
           07~08            MySQL / JPA / MyBatis
                ↓
           09~10            Spring Security / 期末專題
```

很多人跳過這一站直接學 Spring Boot，短期看起來很快——會貼註解、會跑起來。
但接下來會遇到一連串「查不到原因」的問題，而它們全部是這一站的內容：

| 你在 Spring Boot 遇到的症狀 | 真正的原因在這一站的哪一章 |
|------|------|
| `NullPointerException` 出現在 log，但看不出哪個東西是 null | 第 01 章（自動拆箱）、第 06 章（Optional） |
| API 回傳金額變成 `299.99999999997` | 第 01 章（浮點數）、第 07 章（`BigDecimal`） |
| 例外被吞掉，正式環境出事完全查不到 | 第 04 章（例外設計） |
| `@Autowired` 換一個實作就好了，為什麼？ | 第 03 章（介面與多型） |
| 一支 API 一次跑出 500 條 SQL | 第 06 章（Stream 裡呼叫查詢） |
| 服務跑三天就 OOM 重啟 | 第 09 章（JVM 記憶體與 GC） |
| 為什麼 `@Transactional` 加在 private 方法上沒效果 | 第 03 章（多型與代理） |

所以這一站不是「先撐過語法」，而是**先把後面所有除錯能力先買下來**。

### 練習專案：一個純 Java 的待辦事項 CLI

從第 02 章開始，我們會維護同一個專案 `demo/`：一個**不用任何框架**的待辦事項命令列工具。

```
第 02 章  用類別建模：Todo、TodoList
第 03 章  抽出介面：儲存庫、通知
第 04 章  加上例外處理與輸入驗證
第 05 章  換成集合框架，支援標籤與排序
第 06 章  用 Stream 做統計報表
第 07 章  存到檔案（JSON）、處理日期時間
第 08 章  併發匯入大量待辦
第 09 章  故意做出一個記憶體洩漏，然後抓出來
第 10 章  用 Maven 打包成可執行 jar
第 11 章  補上完整測試
第 12 章  用 record / sealed / pattern matching 重寫
```

刻意不用框架，是為了讓你在第 02 站看到 Spring 時，能清楚分辨「這是 Java 語言本來就有的」和「這是 Spring 加上去的」。

---

## 0.3 JDK、JRE、JVM 到底差在哪

這三個詞天天出現，但很多人講不清楚。用一張圖：

```
┌─────────────────────────────────────────────────┐
│ JDK  (Java Development Kit) — 開發用             │
│                                                 │
│  javac  編譯器（.java → .class）                 │
│  javap  反組譯器（看 bytecode）                   │
│  jar    打包工具                                 │
│  jshell 互動式 REPL                              │
│  jstack / jmap / jcmd / jfr  診斷工具            │
│                                                 │
│  ┌───────────────────────────────────────────┐  │
│  │ JRE (Java Runtime Environment) — 執行用    │  │
│  │                                           │  │
│  │  標準函式庫（java.lang, java.util, ...）    │  │
│  │                                           │  │
│  │  ┌─────────────────────────────────────┐  │  │
│  │  │ JVM (Java Virtual Machine)          │  │  │
│  │  │  類別載入器 / 執行引擎 / JIT / GC     │  │  │
│  │  └─────────────────────────────────────┘  │  │
│  └───────────────────────────────────────────┘  │
└─────────────────────────────────────────────────┘
```

- **JVM**：真正執行 bytecode 的虛擬機。它讀 `.class`，翻譯成當前 CPU 的機器碼（JIT），並管理記憶體與 GC。**跨平台是它提供的**：`.class` 檔在 Windows、Linux、macOS 上都是同一份，是 JVM 各平台各有一份實作。
- **JRE**：JVM + 標準函式庫。只想「執行」Java 程式時的最小集合。
- **JDK**：JRE + 開發工具。你要寫程式，就裝 JDK。

> **實務提醒**：Java 11 之後，Oracle 不再單獨提供 JRE 下載，官方方向是用 `jlink` 從 JDK 裁剪出自訂執行環境。
> 現在部署 Spring Boot，主流做法是 Docker 映像直接放一個 JDK（或 jlink 裁過的 runtime），**不要再糾結「伺服器只裝 JRE」**。

### 一句話回答面試題

> 「Java 為什麼能跨平台？」
> 因為 Java 原始碼編譯成的是**與平台無關的 bytecode**，而不是機器碼；再由**各平台各自實作的 JVM** 去執行。代價是多了一層虛擬機，好處是同一份 artifact 可以到處跑。

---

## 0.4 版本策略：LTS 是什麼，我該選哪一版

### 發行節奏

從 Java 9（2017）開始，Oracle 改成**固定每 6 個月發一個版本**（3 月、9 月），並每 2 年指定一個 **LTS（Long-Term Support，長期支援）**。

```
時間軸（只列 LTS 與課程相關版本）

2014-03  Java 8    LTS   ← Lambda / Stream，至今仍大量存在於舊系統
2018-09  Java 11   LTS   ← 第一個「模組化之後」的 LTS
2021-09  Java 17   LTS   ← Spring Boot 3 的最低要求
2023-09  Java 21   LTS   ← 虛擬執行緒、pattern matching 完整化【本課基準】
2025-09  Java 25   LTS   ← 目前最新 LTS
2026-03  Java 26         ← 非 LTS
```

- **非 LTS 版本**（18、19、20、22、23、24、26…）通常只有 6 個月更新，適合嘗鮮，**不適合生產環境**。
- **LTS 版本**有數年的安全性更新，是生產環境唯一合理的選擇。

### 各版本關鍵差異（實務視角）

| | Java 8 | Java 11 | Java 17 | Java 21 | Java 25 |
|---|---|---|---|---|---|
| Lambda / Stream | ✅ 起點 | | | | |
| `var` 區域變數推斷 | ❌ | ✅ | | | |
| 單檔直接執行 `java X.java` | ❌ | ✅ | | | |
| `HttpClient`（內建） | ❌ | ✅ | | | |
| 文字區塊 `"""` | ❌ | ❌ | ✅ | | |
| `record` | ❌ | ❌ | ✅ | | |
| `sealed` 密封類別 | ❌ | ❌ | ✅ | | |
| switch 模式比對 | ❌ | ❌ | preview | ✅ 正式 | |
| **虛擬執行緒** | ❌ | ❌ | ❌ | ✅ | |
| 循序集合 `SequencedCollection` | ❌ | ❌ | ❌ | ✅ | |
| 簡化 main（`void main()`） | ❌ | ❌ | ❌ | ❌ | ✅ |
| 模組匯入宣告 | ❌ | ❌ | ❌ | ❌ | ✅ |
| GC 預設 | Parallel | G1 | G1 | G1（+ZGC 分代） | G1（+ZGC/Shenandoah 分代） |

### 決策建議

| 你的情況 | 選什麼 |
|---|---|
| 新專案，可自由選 | **21 或 25**（Spring Boot 3.2+ 兩者都支援） |
| 公司專案在 Spring Boot 3.x | 至少 17，建議 21 |
| 公司專案在 Spring Boot 2.7 或更舊 | 卡在 8 或 11，升級前先讀第 12 章了解你錯過什麼 |
| 學這門課 | **21**（本課所有範例以 21 驗證，會標註需要 17 / 25 的地方） |

> **本課約定**：預設 JDK 21。用到 Java 21 以後才有的語法，我會標 `【Java 25】`；只有 8 有的舊寫法，我會標 `【Java 8 舊寫法】`。

---

## 0.5 發行商：同樣是 21，為什麼有五種下載

Java 的規格（JLS / JVMS）是公開的，OpenJDK 是參考實作，任何人都能編譯發佈。所以「JDK 21」有很多家：

| 發行商 | 名稱 | 授權 / 費用 | 適合誰 |
|---|---|---|---|
| Eclipse Adoptium | **Temurin** | 免費，無商業限制 | **多數人的預設選擇** |
| Amazon | Corretto | 免費 | 部署在 AWS |
| Azul | Zulu | 免費（Zulu Prime 付費） | 需要商業支援 |
| Microsoft | Microsoft Build of OpenJDK | 免費 | Azure / VS Code 生態 |
| Red Hat | Red Hat build of OpenJDK | RHEL 訂閱 | RHEL 環境 |
| Oracle | **Oracle JDK** | ⚠️ 見下方 | 有買 Oracle 授權的企業 |
| Oracle | GraalVM | 社群版免費 | 需要 native image（極快啟動） |

### ⚠️ Oracle JDK 的授權地雷

這是很多公司踩過的實際成本問題：

- **Java 8 / 11 的 Oracle JDK**：商業用途需付費訂閱。
- **Java 17～20**：曾採用 NFTC 授權，可免費商業使用，但**只到該版本推出後約 3 年**。
- **Java 21 之後**：回到 NFTC，同樣有時限；且 Oracle 的訂閱是按**整個組織的員工數**計費，不是按裝機數。

> **實務結論**：除非公司法務已確認有 Oracle 授權，**開發與部署都用 Temurin 或 Corretto**。
> 功能上和 Oracle JDK 幾乎沒有差異（同樣源自 OpenJDK），但沒有授權風險。

本課使用 **Temurin 21**。

---

## 0.6 安裝：管好多版本，而不是裝一個

實務上你一定會同時面對「舊專案 8、新專案 21」。所以第一步不是裝 JDK，而是裝一個**版本管理工具**。

### macOS / Linux：SDKMAN（強烈推薦）

```bash
# 1. 安裝 SDKMAN
curl -s "https://get.sdkman.io" | bash

# 2. 讓當前終端機生效（或重開終端機）
source "$HOME/.sdkman/bin/sdkman-init.sh"

# 3. 看有哪些 Java 版本可裝
sdk list java

# 4. 安裝 Temurin 21（本課基準）
sdk install java 21.0.5-tem

# 5. 順手裝一個 Java 8，之後對照舊寫法用
sdk install java 8.0.432-tem

# 6. 設成預設
sdk default java 21.0.5-tem

# 7. 裝 Maven（0.10 之後每一章都會用到，別跳過）
sdk install maven

# 8. 確認
java -version
javac -version
mvn -version
```

> **`java` 有了但 `mvn: command not found`？**
> 就是漏了第 7 步。SDKMAN 的 `sdk install java` 只裝 JDK，**Maven 是另一個 candidate，要獨立安裝**。
> 檢查你到底裝了什麼：
>
> ```bash
> ls ~/.sdkman/candidates      # 應該看到 java 和 maven 兩個目錄
> sdk current                  # 列出目前生效的所有 candidate 版本
> ```

> **`echo $JAVA_HOME` 印出空白？**
> 安裝程式把初始化那兩行寫進了 `~/.zshrc`，但 **`.zshrc` 只在終端機「開啟的那一刻」讀取一次**。
> 你如果在安裝前就已經開著的視窗裡驗證，那個視窗永遠讀不到，看起來就像設定失敗。
>
> ```bash
> exec zsh        # 就地重載當前 shell（或直接開一個新的終端機分頁）
> ```
>
> 這也是為什麼第 2 步要 `source`——但 `source` 只救得了「當下那一個」視窗。
> 附帶一提，SDKMAN 設的 `JAVA_HOME` 會指向 `.../candidates/java/**current**`（一個會跟著切版本走的符號連結），
> **不是**指向 `.../java/21.0.5-tem`。看到 `current` 是正常的，不要以為版本沒設定好。

`sdk list java` 輸出的 identifier 後綴代表發行商：`-tem` Temurin、`-amzn` Corretto、`-zulu` Zulu、`-graal` GraalVM。版本號會持續更新，照你當下 `sdk list` 看到的填。

**臨時切換（只影響當前終端機）：**

```bash
sdk use java 8.0.432-tem
java -version   # 這個視窗變成 8，其他視窗不受影響
```

**讓專案自動綁定版本**——在專案根目錄放一個 `.sdkmanrc`：

```bash
cd ~/projects/new-app
sdk env init        # 用「目前生效的版本」產生 .sdkmanrc
```

產生出來的檔案長這樣，可以自己再加其他工具：

```properties
# .sdkmanrc
java=21.0.5-tem
maven=3.9.9
```

**步驟 1：開啟自動切換（整台機器只要做一次）**

自動切換預設是關的，要改 `~/.sdkman/etc/config` 裡的一行。**課程只提到「改成 true」是不夠的，這裡把三種改法都寫出來：**

*方法 A：直接用你慣用的編輯器改（最不會出錯）*

```bash
code ~/.sdkman/etc/config      # VS Code / Cursor
# 或 nano ~/.sdkman/etc/config
```

找到這一行：

```properties
sdkman_auto_env=false
```

改成：

```properties
sdkman_auto_env=true
```

存檔。**只改這一行，其他不要動。**

*方法 B：一行指令改完，不進編輯器*

```bash
sed -i.bak 's/^sdkman_auto_env=false/sdkman_auto_env=true/' ~/.sdkman/etc/config

# 確認真的改到了
grep sdkman_auto_env ~/.sdkman/etc/config
# 應該印出 sdkman_auto_env=true
```

（`-i.bak` 會留一份 `config.bak` 備份，而且這個寫法在 macOS 和 Linux 都能用。）

*方法 C：`sdk config`*

```bash
sdk config
```

它會**用 `vi` 打開同一個檔案**（除非你設過 `SDKMAN_EDITOR` 或 `EDITOR`）。很多人卡在這裡出不來，vi 的操作是：

| 動作 | 按鍵 |
|---|---|
| 進入編輯模式 | `i` |
| 改完，離開編輯模式 | `Esc` |
| 存檔並離開 | `:wq` 然後 Enter |
| 不存檔離開（改壞了） | `:q!` 然後 Enter |

不熟 vi 就用方法 A 或 B，結果完全一樣。

**步驟 2：讓設定生效**

改完設定檔**當前終端機還不會生效**，要重開終端機，或：

```bash
source ~/.sdkman/bin/sdkman-init.sh
```

**步驟 3：驗證**

```bash
cd ~/projects/legacy-java8-app   # 自動變成 8
java -version

cd ~/projects/new-app            # 自動變成 21
java -version
```

看到 `Using java version 21.0.5-tem in this shell.` 這類訊息就是成功了。

> **踩雷提醒**：如果 `.sdkmanrc` 寫的版本你還沒裝，`cd` 進去時會看到
> `Stop! java 21.0.5-tem is not installed.`
> 這時候在該目錄下跑 `sdk env install`，它會把 `.sdkmanrc` 裡列的東西一次裝好。

> **不想開自動切換也可以**：在專案目錄手動下 `sdk env` 就會套用 `.sdkmanrc`，`sdk env clear` 還原成預設版本。差別只是要不要自己記得下指令。

> 這一招在公司同時維護新舊專案時，可以省掉每天無數次「啊我版本又忘了切」。

### Windows

**方法 A：winget（Windows 10/11 內建）**

```powershell
# 搜尋
winget search Microsoft.OpenJDK

# 安裝
winget install EclipseAdoptium.Temurin.21.JDK

# 確認
java -version
```

**方法 B：Scoop（想要類似 SDKMAN 的體驗）**

```powershell
scoop bucket add java
scoop install temurin21-jdk
scoop install temurin8-jdk

# 切換
scoop reset temurin8-jdk
java -version
```

**方法 C：WSL2 + SDKMAN**——如果你的部署目標是 Linux（幾乎都是），這是最貼近正式環境的做法，也能避開 Windows 路徑與換行符號的雜事。

### 設定 JAVA_HOME

很多工具（Maven、Gradle、Tomcat、部分 IDE 外掛）不看 `PATH` 裡的 `java`，而是讀 `JAVA_HOME`。**這是「明明 java -version 是 21，Maven 卻說我是 8」的頭號原因。**

SDKMAN 會自動維護 `JAVA_HOME`，手動安裝則要自己設：

**macOS / Linux（`~/.zshrc` 或 `~/.bashrc`）：**

```bash
# macOS 可以用內建工具查出指定版本的路徑
export JAVA_HOME=$(/usr/libexec/java_home -v 21)
export PATH="$JAVA_HOME/bin:$PATH"
```

**Linux（手動路徑）：**

```bash
export JAVA_HOME=/usr/lib/jvm/temurin-21-jdk-amd64
export PATH="$JAVA_HOME/bin:$PATH"
```

**Windows（PowerShell，設定使用者層級永久變數）：**

```powershell
[Environment]::SetEnvironmentVariable(
  "JAVA_HOME",
  "C:\Program Files\Eclipse Adoptium\jdk-21.0.5.11-hotspot",
  "User")
```

**驗證三件事都一致：**

```bash
java -version          # 執行時的版本
javac -version         # 編譯時的版本
echo $JAVA_HOME        # 工具讀到的版本（Windows: echo %JAVA_HOME%）
mvn -version           # Maven 實際用哪個 JDK（會印出 Java version 與 JAVA_HOME）
```

如果這四行講的不是同一個版本，先把它修好，不要往下走。

**這四行沒印出東西時，先照這個順序排除：**

| 症狀 | 原因 | 修法 |
|---|---|---|
| `mvn: command not found` | 沒裝 Maven（SDKMAN 的 java 和 maven 是兩個獨立 candidate） | `sdk install maven` |
| `echo $JAVA_HOME` 是空白行 | 這個終端機視窗在設定寫入 `~/.zshrc` **之前**就開了 | `exec zsh` 或開新分頁 |
| `java: command not found` | 同上，或 `.zshrc` 裡的 SDKMAN 初始化被後面的設定覆蓋掉 | `grep -n sdkman ~/.zshrc` 確認那兩行還在，且沒被更後面的 `export PATH=...` 蓋掉 |
| 四行版本不一致 | `JAVA_HOME` 是手動設的舊路徑，跟 SDKMAN 打架 | 移除 `.zshrc` 裡自己寫的 `export JAVA_HOME=...`，交給 SDKMAN 管 |

### Maven 版本和 Java 版本怎麼對應

看到 `mvn -version` 會印出 Java 版本，很自然會問：**是不是每個 Java 版本都要配一個對應的 Maven？**

**不用。你整台機器只需要裝一份 Maven。**

原因是 Maven 本身就是一支 Java 程式，它沒有內建 JDK。它啟動時做兩件事：

```
mvn 啟動
  ├─ 讀 JAVA_HOME → 決定「用哪個 JVM 跑 Maven 自己」
  └─ 同一個 JDK 的 javac → 決定「用哪個編譯器編你的程式碼」
```

所以你用 SDKMAN 切 Java，Maven 會**自動跟著換**，不需要重裝：

```bash
sdk use java 21.0.5-tem
mvn -version | grep "Java version"      # Java version: 21.0.5

sdk use java 8.0.432-tem
mvn -version | grep "Java version"      # Java version: 1.8.0_432
# 同一個 Maven，同一個 mvn 指令，跟著 JAVA_HOME 走
```

所以「哪個 Maven 配哪個 Java」不是一張對應表，而是**兩道邊界**：

**邊界 1（下限）：Maven 自己要跑得起來**

| Maven 版本 | 能跑它的最低 Java |
|---|---|
| 3.6.3 / 3.8.x | 7 |
| **3.9.x** | **8** ← 本課用這個 |
| 4.0.x | 17 |

Maven 3.9.x 的下限是 Java 8，而本課最舊也只用到 Java 8，**所以一份 3.9.x 就通吃本課全部版本**。
反過來如果你裝了 Maven 4，就不能再用它跑 Java 8 或 11 的舊專案——這是選 3.9.x 當預設的實際理由。

**邊界 2（上限）：不能編譯比「跑 Maven 的 JDK」更新的目標版本**

```xml
<maven.compiler.release>25</maven.compiler.release>
```

在 JDK 21 上跑會直接失敗：

```
error: release version 25 not supported
```

因為 `--release 25` 需要 JDK 25 自己的編譯器和 API 描述檔，Maven 變不出來。**往下編可以（21 的 JDK 編 release=8 沒問題），往上編不行。**

**結論**：`8 ≤ 你的 JDK`、`JDK ≥ pom 裡的 release`，這兩個條件成立，任何 Java 版本都能配同一份 Maven 3.9.x。

> **想在 JDK 21 上用「真正的 JDK 8 編譯器」怎麼辦？**
> `release=8` 只是限制語法和 API 表面，編譯器仍然是 21 的。如果公司要求用原生 8 編譯，
> 就設定 `~/.m2/toolchains.xml` 搭配 `maven-toolchains-plugin`，讓 Maven 跑在 21、
> 但 fork 出 JDK 8 的 `javac`。這是進階用法，第 10 章講 Maven 時會提。

> **真正卡版本的通常是「外掛」，不是 Maven 本體。**
> 舊版外掛內嵌舊的 ASM 函式庫，讀不懂新 JDK 的 class 檔，在新 JDK 上會噴：
>
> ```
> Unsupported class file major version 65
> ```
>
> 常見於舊版 Lombok、JaCoCo、maven-shade-plugin。**修法是升那個外掛的版本，不是換 Maven。**

---

## 0.7 IDE 設定

### IntelliJ IDEA（推薦）

Community Edition 免費，做純 Java + Maven + JUnit 完全夠用（到第 02 站 Spring Boot 時，Ultimate 的 Spring 支援會很有感，但不是必需）。

安裝後要確認三個地方，它們是**獨立**設定，常常不一致：

1. **Project SDK**：`File → Project Structure → Project`
   - SDK 選 21，Language level 選 `21 - Pattern matching for switch...`
2. **Maven 用的 JDK**：`Settings → Build, Execution, Deployment → Build Tools → Maven → Importing → JDK for importer`
3. **編譯器目標版本**：`Settings → Build, Execution, Deployment → Compiler → Java Compiler → Target bytecode version`

> **為什麼 IDE 可以跟終端機用不同 JDK？**
> IDE 不呼叫你 `PATH` 裡的 `javac`，它有自己的編譯器整合與 SDK 註冊表。這解釋了「IDE 跑得起來，CI 卻編譯失敗」——CI 用的是 `JAVA_HOME`。
> **真正的答案是把版本寫進 `pom.xml`**（見 0.10），讓 IDE 和 CI 都只能照它做。

必開的幾個設定，會省下大量時間：

| 設定 | 位置 | 為什麼 |
|---|---|---|
| 檔案編碼一律 UTF-8 | `Settings → Editor → File Encodings`（三個欄位都設 UTF-8） | 中文亂碼的根源 |
| 顯示行號 | `Settings → Editor → General → Appearance` | 對照課程行號 |
| 存檔自動 optimize imports | `Settings → Editor → General → Auto Import` | 減少雜訊 diff |

### VS Code

安裝 **Extension Pack for Java**（含 Language Support、Debugger、Test Runner、Maven、Project Manager）。

`settings.json` 設定多版本：

```json
{
  "java.configuration.runtimes": [
    {
      "name": "JavaSE-1.8",
      "path": "/Users/you/.sdkman/candidates/java/8.0.432-tem"
    },
    {
      "name": "JavaSE-21",
      "path": "/Users/you/.sdkman/candidates/java/21.0.5-tem",
      "default": true
    }
  ],
  "files.encoding": "utf8"
}
```

---

## 0.8 第一支程式：把每一個字都講清楚

建立 `Hello.java`：

```java
public class Hello {
    public static void main(String[] args) {
        System.out.println("Hello, Java 21!");
    }
}
```

編譯與執行：

```bash
javac Hello.java     # 產生 Hello.class
java Hello           # 注意：沒有 .class 副檔名
# 輸出：Hello, Java 21!
```

`java` 吃的是**類別名稱**，不是檔案路徑。`Hello` 在當前目錄時，JVM 預設從 `.` 找 `Hello.class`。若 class 在子資料夾裡（這支還沒寫 `package`）：

```
專案根目錄/
  demo/
    Hello.java
    Hello.class
```

```bash
java -cp demo Hello     # 人在專案根目錄：把 demo/ 當成 classpath 根
cd demo && java Hello   # 先進子資料夾，效果相同
```

`-cp demo` 的意思是「到 `demo/` 裡找類別」。類別名稱仍是 `Hello`，所以後面寫 `Hello`，不要寫 `demo.Hello`。

| 指令 | 結果 |
|---|---|
| `java demo/Hello` | 被當成 package `demo`、類別 `Hello`，沒寫 package 就找不到 |
| `java demo.Hello` | 同上 |
| `java demo/Hello.class` | 更不行，`java` 不吃檔案路徑 |

> **有 package 時**（真實專案常見）要用全名，而且 classpath 要指到 package 的**根**目錄，見 0.11 錯誤 4。現在這支還沒寫 package，記住 `java -cp 子資料夾 類別名` 就夠。

逐字拆解 `public static void main(String[] args)`：

| 部分 | 意思 | 拿掉會怎樣 |
|---|---|---|
| `public` | 公開，JVM 從類別外部呼叫得到 | JVM 找不到入口 |
| `static` | 屬於類別，不需要先 `new Hello()` | JVM 得先建立物件才能呼叫，但它不知道該用哪個建構子 |
| `void` | 不回傳值 | 回傳值 JVM 也不會用 |
| `main` | JVM 約定的入口名稱 | 換名字就不是入口了 |
| `String[] args` | 命令列參數 | 簽章不符，JVM 認不出來 |

**檔名必須是 `Hello.java`**：一個原始檔中，`public` 類別的名稱必須和檔名一致。這是編譯器規定，不是慣例。

試試命令列參數：

```java
public class Greet {
    public static void main(String[] args) {
        if (args.length == 0) {
            System.out.println("用法: java Greet <名字>");
            return;
        }
        System.out.println("你好, " + args[0]);
    }
}
```

```bash
javac Greet.java
java Greet 小明        # 你好, 小明
java Greet             # 用法: java Greet <名字>
```

> 注意 `args` **不包含**程式名稱（跟 C 的 `argv[0]` 不同）。`java Greet 小明` 的 `args` 是 `["小明"]`，長度 1。

### 【Java 11+】單檔直接執行，不用先編譯

```bash
java Hello.java        # 直接跑，class 檔留在記憶體裡不落地
java demo/Hello.java   # 原始檔可以用路徑；這跟 `java Hello` 吃類別名稱不同
```

寫小實驗、驗證一個語法時很方便。本課很多小範例你都可以這樣跑。

### 【Java 25】簡化的 main

Java 25 正式支援「精簡原始檔與實例 main 方法」，入口可以短到這樣：

```java
// Java 25 才能編譯
void main() {
    IO.println("Hello");
}
```

不需要 `class`、不需要 `public static`、不需要 `String[] args`。這是為了降低初學門檻。

**但本課一律用完整寫法**，因為：

1. 真實專案的 class 是必要的（要放欄位、要被注入、要被測試）。
2. 你面試、看別人的程式、讀 Spring 原始碼，看到的都是完整寫法。

### jshell：不用建檔案就能實驗

```bash
jshell
```

```
jshell> 1 + 2
$1 ==> 3

jshell> var name = "Java"
name ==> "Java"

jshell> "Hello, " + name
$3 ==> "Hello, Java"

jshell> "abc".toUpperCase()
$4 ==> "ABC"

jshell> /exit
```

本課凡是「這個表達式結果是什麼」的問題，最快的驗證方式就是 jshell，不要為此開一個專案。

---

## 0.9 編譯與執行流程：JVM 在背後做了什麼

這一節是後面第 09 章（JVM 記憶體與 GC）的前導，現在先建立大圖。

```
Hello.java
   │
   │ ① javac 編譯（發生在你的機器上，一次性）
   │    - 詞法 / 語法分析 → 語意檢查（型別、泛型、例外）
   │    - 產生與平台無關的 bytecode
   ↓
Hello.class  ←── 這就是「跨平台的 artifact」
   │
   │ ② java 啟動 JVM
   ↓
┌──────────────── JVM ────────────────┐
│                                     │
│ ③ 類別載入（ClassLoader）            │
│    載入 → 驗證 → 準備 → 解析 → 初始化 │
│                                     │
│ ④ 執行引擎                           │
│    先用「解譯器」逐條執行 bytecode     │
│    熱點程式碼 → JIT 編譯成機器碼      │
│                                     │
│ ⑤ 記憶體管理                         │
│    堆積 / 堆疊 / Metaspace + GC      │
└─────────────────────────────────────┘
```

### 親眼看看 bytecode

`javap` 是 JDK 內建的**反組譯器**（class file disassembler）：讀 `.class`，把裡面的結構印成人看得懂的文字。它不執行程式，只是打開編譯器產物給你看。

`-c` 是 `--disassemble`：把每個方法的 **bytecode 指令**（`Code:` 那段）印出來。不加 `-c` 時，`javap Hello.class` 只會列出方法簽章，看不到 `getstatic`、`invokevirtual` 這些指令。

```bash
javap Hello.class      # 只看公開成員與方法簽章
javap -c Hello.class   # 再加上每條 bytecode
```

```
public class Hello {
  public Hello();
    Code:
       0: aload_0
       1: invokespecial #1   // Method java/lang/Object."<init>":()V
       4: return

  public static void main(java.lang.String[]);
    Code:
       0: getstatic     #7   // Field java/lang/System.out:Ljava/io/PrintStream;
       3: ldc           #13  // String Hello, Java 21!
       5: invokevirtual #15  // Method java/io/PrintStream.println:(...)V
       8: return
}
```

三個觀察，都會在後面章節用到：

1. **編譯器幫你加了無參數建構子** `public Hello()`（第 02 章會講「什麼時候它不幫你加」）。
2. `invokevirtual` 這個指令代表**動態分派**——執行時才決定呼叫哪個實作。這就是多型的底層機制（第 03 章）。
3. 字串常值 `"Hello, Java 21!"` 用 `ldc` 從**常量池**取出，這解釋了第 01 章的字串池行為。

### 為什麼 Java「一開始慢，跑久了變快」

JVM 啟動時用解譯器執行（啟動快、執行慢）；當某段程式碼被呼叫夠多次（成為「熱點」），JIT 才把它編譯成機器碼並做最佳化（內聯、逃逸分析、迴圈展開）。

**實務影響：**

- **效能測試不能只測第一次**。要先「暖機」跑幾千次，否則量到的是解譯器的速度。第 11 章講基準測試會再回到這裡。
- 短命的 CLI 工具或 Lambda 函式吃不到 JIT 的好處，這是 GraalVM native image（提前編譯成原生執行檔）存在的理由。
- Spring Boot 服務啟動後前幾十秒偏慢是正常的，正式上線常搭配「暖機請求」再放進負載平衡。

---

## 0.10 建立本課的 Maven 專案骨架

第 10 章會完整講 Maven。現在先建立一個能用的骨架，因為從第 01 章開始就會需要跑測試。

### 手動建立（推薦，比背 archetype 指令實在）

```bash
mkdir -p demo/src/main/java/com/example/todo   # -p：中間目錄不存在就一併建立，已存在也不報錯
mkdir -p demo/src/test/java/com/example/todo
cd demo
```

Maven 的目錄慣例（**約定優於設定**，記住就好）：

```
demo/
├── pom.xml                      ← 專案描述：座標、依賴、外掛
├── .gitignore                   ← 跟 pom.xml 同層（專案根目錄）
├── src/
│   ├── main/
│   │   ├── java/                ← 產品程式碼
│   │   └── resources/           ← 設定檔、靜態資源（會被打進 jar）
│   └── test/
│       ├── java/                ← 測試程式碼（不會被打進 jar）
│       └── resources/           ← 測試用設定檔
└── target/                      ← 建置產出（.class、jar）；加入 .gitignore
```

`pom.xml`：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0
                             http://maven.apache.org/xsd/maven-4.0.0.xsd">
  <modelVersion>4.0.0</modelVersion>

  <!-- 座標：groupId + artifactId + version 唯一標定一個 artifact -->
  <groupId>com.example</groupId>
  <artifactId>todo-cli</artifactId>
  <version>1.0.0-SNAPSHOT</version>
  <packaging>jar</packaging>

  <properties>
    <!-- 這兩行是最重要的：讓 IDE 和 CI 都只能用 21 -->
    <maven.compiler.release>21</maven.compiler.release>
    <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
    <junit.version>5.11.3</junit.version>
  </properties>

  <dependencies>
    <!-- JUnit 5：aggregate 依賴，含 api + params + engine -->
    <dependency>
      <groupId>org.junit.jupiter</groupId>
      <artifactId>junit-jupiter</artifactId>
      <version>${junit.version}</version>
      <scope>test</scope>
    </dependency>

    <!-- AssertJ：讀起來像英文的斷言，第 11 章會大量使用 -->
    <dependency>
      <groupId>org.assertj</groupId>
      <artifactId>assertj-core</artifactId>
      <version>3.26.3</version>
      <scope>test</scope>
    </dependency>
  </dependencies>

  <build>
    <plugins>
      <plugin>
        <groupId>org.apache.maven.plugins</groupId>
        <artifactId>maven-surefire-plugin</artifactId>
        <version>3.5.2</version>
      </plugin>
    </plugins>
  </build>
</project>
```

### 為什麼用 `maven.compiler.release` 而不是 `source` + `target`

這是實務上真的會出事的細節：

```xml
<!-- ❌ 舊寫法：只檢查語法版本，不檢查 API -->
<maven.compiler.source>8</maven.compiler.source>
<maven.compiler.target>8</maven.compiler.target>

<!-- ✅ Java 9+ 寫法：連「這個 API 在該版本存不存在」都一起檢查 -->
<maven.compiler.release>21</maven.compiler.release>
```

用 `source`/`target` 設成 8，但你在程式裡呼叫了 `List.of()`（Java 9 才有）：**編譯會過**，因為編譯器用的是 JDK 21 的函式庫；但部署到 Java 8 的機器上執行就爆 `NoSuchMethodError`。

`release` 會同時限制語法**和** API 表面，編譯期就攔下來。**新專案一律用 `release`。**

### 驗證骨架能跑

`src/main/java/com/example/todo/App.java`：

```java
package com.example.todo;

public class App {

    public static String greet(String name) {
        return "Hello, " + name;
    }

    public static void main(String[] args) {
        System.out.println(greet("Java"));
    }
}
```

`src/test/java/com/example/todo/AppTest.java`：

```java
package com.example.todo;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class AppTest {

    @Test
    @DisplayName("greet 會回傳帶名字的招呼語")
    void greet_returnsGreetingWithName() {
        assertThat(App.greet("Java")).isEqualTo("Hello, Java");
    }
}
```

```bash
mvn -q test           # 跑測試
mvn -q compile        # 只編譯
mvn clean             # 清掉 target/
mvn -q exec:java -Dexec.mainClass=com.example.todo.App   # 需要 exec 外掛，第 10 章講
```

`demo/.gitignore`（專案根目錄，跟 `pom.xml` 同一層；你前面已經 `cd demo`，所以在這裡建檔即可）：

```gitignore
target/
*.class
.idea/
*.iml
.vscode/
.DS_Store
```

放錯位置（例如放到 `src/` 或課程 repo 最外層）Git 就不會忽略這個 Maven 專案的 `target/`。Git 從檔案所在目錄往上找 `.gitignore`，規則對該目錄及其子目錄生效。

> **注意 `package` 與目錄要一致**：`package com.example.todo;` 的檔案必須放在 `src/main/java/com/example/todo/`。不一致的話 Maven 編譯會直接失敗。第 02 章會講 package 的設計。

---

## 0.11 常見錯誤與排查

### 錯誤 1：`UnsupportedClassVersionError`

```
java.lang.UnsupportedClassVersionError: com/example/App has been compiled by a more
recent version of the Java Runtime (class file version 65.0), this version of the
Java Runtime only recognizes class file versions up to 52.0
```

**意思**：用新版編譯，用舊版執行。

class file version 對照表（背下來很實用）：

| class file version | Java 版本 |
|---|---|
| 52 | 8 |
| 55 | 11 |
| 61 | 17 |
| 65 | 21 |
| 69 | 25 |

上面的訊息是「用 21 編譯（65），但執行環境只到 8（52）」。

**排查**：

```bash
java -version      # 執行環境版本
mvn -version       # Maven 用的 JDK（看 "Java version" 那行）
```

修法：升級執行環境，或把 `maven.compiler.release` 降到執行環境的版本。

### 錯誤 2：中文變成 `??` 或 `æ¸¬è©¦`

三個地方都要是 UTF-8，缺一不可：

```xml
<!-- ① 原始檔編碼：pom.xml -->
<properties>
  <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
</properties>
```

```bash
# ② 手動 javac 時
javac -encoding UTF-8 Hello.java

# ③ 執行時的輸出編碼（Java 18 之前預設跟隨系統，Windows 常是 MS950）
java -Dfile.encoding=UTF-8 Hello
```

> **Java 18 之後**，`file.encoding` 預設就是 UTF-8（JEP 400），這類問題大幅減少。
> Windows 終端機仍可能需要 `chcp 65001` 把 code page 切成 UTF-8。

### 錯誤 3：`JAVA_HOME is not set`

```
Error: JAVA_HOME is not set and no 'java' command could be found in your PATH.
```

Maven / Gradle 讀 `JAVA_HOME`，不是讀 `PATH` 裡的 `java`。回到 0.6 設定。

### 錯誤 4：`錯誤: 找不到或無法載入主要類別 Hello`

四種常見原因：

```bash
java Hello.class     # ❌ 不要加 .class
java Hello           # ✅

# ❌ class 在子資料夾、又沒寫 package：路徑不是類別名稱
java demo/Hello      # ❌ 被當成 package demo
java -cp demo Hello  # ✅ 見 0.8

# ❌ 有 package 的類別，要用全名，而且要從 package 的根目錄執行
cd src/main/java
java com.example.todo.App     # ✅

# ❌ class 檔不在 classpath 上
java -cp target/classes com.example.todo.App   # ✅ 明確指定
```

### 錯誤 5：`class X is public, should be declared in a file named X.java`

`public` 類別名稱必須和檔名完全一致，包含大小寫。

> 補充陷阱：macOS 的檔案系統預設**不分大小寫**，`Hello.java` 和 `hello.java` 被當成同一個檔案，但 Java 編譯器分大小寫。這會造成「本機正常、Linux CI 失敗」。**類別名稱一律 PascalCase，檔名一字不差地跟著。**

### 錯誤 6：IDE 沒紅字，`mvn compile` 卻失敗

IDE 和 Maven 用不同 JDK / 不同語言等級。修法在 0.7：把版本寫進 `pom.xml`，然後讓 IDE 重新匯入 Maven 專案（IntelliJ：Maven 面板的 `Reload All Maven Projects`）。

---

## 0.12 用除錯器：比 `println` 快十倍的那個按鈕

上一節的錯誤都有明確的錯誤訊息。但更多時候，程式**沒有報錯，只是答案不對**——
迴圈少跑一圈、某個欄位莫名其妙變成 `null`、金額算出來差了一塊錢。

大部分人這時候的做法是：

```
加一行 println → 重新編譯 → 再跑一次 → 猜錯地方 → 再加三行 println
→ 重新編譯 → 再跑一次 → ⋯⋯ → 修好之後忘記刪，把 println 一起 commit 進去
```

**每一輪至少 30 秒，而且你只看得到你「事先想到要印」的那些變數。**

除錯器（debugger）做的是同一件事，但：一次就能看到**當下所有變數**、
不用重新編譯、可以往前往後走、還可以當場改變數的值試試看。

> 🔑 **這一節放在第 00 章，是因為它是「投資報酬率最高、卻最常被跳過」的一節。**
> 現在花 20 分鐘學會，接下來 12 章的每一次「咦，怎麼會這樣」都會省你幾十分鐘。

---

### 0.12.1 三個核心動作

用第 0.10 節建好的專案，隨便找一個方法試：

| 動作 | IntelliJ | VS Code | 做什麼 |
|---|---|---|---|
| **設中斷點** | 點行號左邊的空白 | 同左 | 程式跑到這一行就停住 |
| **啟動除錯** | `main` 旁邊的綠色蟲圖示 → Debug | `F5` | 用除錯模式跑 |
| **看變數** | 下方 Variables 面板 | 左側 VARIABLES | **當下所有變數的值，不用事先想好要印哪個** |

停住之後，四個按鈕決定你往哪走：

| 按鈕 | 快捷鍵（IntelliJ / VS Code） | 意思 | 什麼時候用 |
|---|---|---|---|
| **Step Over** | `F8` / `F10` | 執行這一行，**不進去**方法內部 | 預設就用這個 |
| **Step Into** | `F7` / `F11` | **進入**這一行呼叫的方法 | 懷疑問題在被呼叫的方法裡 |
| **Step Out** | `Shift+F8` / `Shift+F11` | 執行完目前方法，回到呼叫端 | 進錯地方了，想退出來 |
| **Resume** | `F9` / `F5` | 繼續跑到下一個中斷點 | 這一段看完了 |

> 💡 **最常見的挫折**：按 Step Into 結果進到 `ArrayList.add()` 或 `String.valueOf()` 裡面。
> 解法是設定 **step filter**，讓除錯器跳過標準函式庫：
>
> - IntelliJ：`Settings → Build, Execution, Deployment → Debugger → Stepping`，
>   勾選 `Do not step into classes`，預設已含 `java.*`、`javax.*`、`jdk.*`。
> - VS Code：`launch.json` 加 `"stepFilters": { "skipClasses": ["$JDK", "junit.*"] }`。

---

### 0.12.2 條件式中斷點：只在你要的那一圈停

```java
for (int i = 0; i < 100_000; i++) {
    process(items.get(i));          // 第 87_432 圈才出錯
}
```

在中斷點上**按右鍵 → Condition**，填一個布林運算式：

```java
i == 87432
// 或者更實用的：不知道第幾圈，但知道特徵
items.get(i).getAmount() < 0
```

程式只會在條件成立時停下來。

> ⚠️ **代價**：條件式中斷點是「每一圈都停下來、算一次運算式、不成立就繼續」。
> 放在跑一百萬次的熱迴圈裡，程式會慢到幾乎不能動。
> 如果條件很複雜，改用「先在程式裡寫 `if (條件) { int x = 0; }` 再對那一行設普通中斷點」會快很多。

---

### 0.12.3 ★ 例外中斷點：本節最被低估的功能

情境：log 裡有一個 `NullPointerException`，但堆疊追蹤指向的是第 04 章那種
「已經被 catch 過又重新包裝」的地方，看不出原始的那個 `null` 是誰。

**例外中斷點會在例外「被丟出的那一瞬間」停住**——
不是在 `catch` 停，是在 `throw` 停。這時候整個現場都還在。

| IDE | 設定位置 |
|---|---|
| IntelliJ | `Run → View Breakpoints`（`Ctrl/Cmd+Shift+F8`）→ `+` → `Java Exception Breakpoints` → 輸入 `NullPointerException` |
| VS Code | 左側 BREAKPOINTS 面板 → 勾 `Uncaught Exceptions` / `Caught Exceptions` |

> 🔑 **「Caught」和「Uncaught」要分清楚**：
> - 勾 **Uncaught**：只在沒人接的例外停。安全，但漏掉「被吞掉」的那些。
> - 勾 **Caught**：連被 `catch` 的也停。**這才是查「例外被吞掉」的正確工具**
>   （第 04 章 4.12 的反模式一），但在 Spring 這種框架裡會停個不停——
>   所以要**指定例外型別**，不要對 `Exception` 開。

### 0.12.4 欄位監看點：「到底是誰改了這個值」

`config.timeout` 在某個時刻變成 `0`，但全專案有 20 個地方寫它。

**在欄位宣告的行號上設中斷點**（IntelliJ 會自動變成 field watchpoint，
圖示是一隻眼睛），選 `Field modification`——
任何人寫入這個欄位時就會停住，而堆疊追蹤直接告訴你是誰。

> 這是查「莫名其妙被改掉的狀態」最快的路。
> 第 02 章 2.9 講不可變物件時你會理解：**需要用到欄位監看點，通常就是該用不可變物件的訊號。**

---

### 0.12.5 Evaluate Expression：在現場試跑

停在中斷點時，按 `Alt+F8`（IntelliJ）/ 在 DEBUG CONSOLE 輸入（VS Code），
可以執行任意運算式：

```java
items.stream().filter(i -> i.getAmount() < 0).count()    // 現場算一下有幾筆
new BigDecimal("4.35").multiply(new BigDecimal("100"))   // 驗證第 01 章 1.5 的金額問題
order.getCustomer().getAddress()                          // 一路點下去看哪一層是 null
```

**也可以直接改變數的值**（Variables 面板 → 右鍵 → `Set Value`）：
想測「如果這裡是 `-1` 會怎樣」，不用改程式再跑一次。

> ⚠️ **Evaluate 會真的執行程式碼**。如果那個方法會寫資料庫、送 email、扣庫存——
> 它就真的做了。**在正式資料上除錯時特別注意。**

### 0.12.6 Drop Frame：時光倒流

「啊，剛剛那個方法我按太快 Step Over 過去了。」

不用重跑：IntelliJ 的 `Drop Frame`（VS Code 的 `Restart Frame`）會把目前的方法
**退回到還沒進入的狀態**，讓你重新 Step Into 一次。

> ⚠️ 它只能還原**堆疊**，還原不了**副作用**——
> 剛才那個方法已經寫進去的資料庫紀錄、已經改掉的靜態變數，不會跟著倒退。

---

### 0.12.7 除錯器會騙你的四個地方

| # | 陷阱 | 說明 |
|---|---|---|
| 1 | **`toString()` 有副作用** | Variables 面板會對每個變數呼叫 `toString()`。如果它會觸發延遲載入（08-jpa-mybatis 的 JPA）或計數器，你「看一眼」就改變了程式的行為 |
| 2 | **停住的時候，世界沒有停** | 資料庫交易在逾時、HTTP 連線在逾時、K8s 的存活探針在倒數。**「debug 時一切正常，放開就失敗」通常就是這個** |
| 3 | **多執行緒的暫停策略** | 預設 `Suspend: All` 會停住所有執行緒，這會讓併發問題**消失**（第 08 章 8.4 的競態條件靠 debug 幾乎抓不到）。改成 `Suspend: Thread` 只停一條，但要小心製造出人為的死鎖 |
| 4 | **最佳化過的程式碼** | JIT 內聯之後，某些區域變數可能顯示為「不可用」。這是正常的，不是 IDE 壞了 |

> 🔑 **第 2、3 點合起來就是一條原則：**
> **除錯器適合「邏輯錯」，不適合「時間錯」。**
> 併發、逾時、效能問題要用第 08 章的 `jstack`、第 09 章的 heap dump 與 JFR。

---

### 0.12.8 遠端除錯：連進容器裡的那個 JVM

程式在 Docker 裡跑、在測試機上跑，但你想用本機的 IDE 除錯。

啟動 JVM 時加上這一串（**JDK 9 之後的正確寫法**）：

```bash
java -agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=*:5005 -jar app.jar
```

| 參數 | 意思 | 常踩的坑 |
|---|---|---|
| `transport=dt_socket` | 用 TCP 連線 | — |
| `server=y` | JVM 當伺服器，等 IDE 連進來 | — |
| `suspend=n` | **不要**等 IDE 連上才啟動 | 設成 `y` 時容器會卡在啟動中，健康檢查直接判定失敗 |
| `address=*:5005` | 監聽所有網卡的 5005 埠 | ★ **JDK 9 起預設只綁 localhost**，只寫 `address=5005` 從容器外連不進去 |

```bash
# Docker 要把埠對映出來
docker run -p 8080:8080 -p 5005:5005 \
  -e JAVA_TOOL_OPTIONS="-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=*:5005" \
  myapp:latest
```

然後在 IDE 建一個 `Remote JVM Debug` 設定，填 `localhost:5005`。

> ⚠️ **JDWP 埠等於一個完全沒有認證的遠端程式碼執行入口。**
> 任何連得上 5005 的人都能讀你的記憶體、改你的變數、呼叫任何方法。
>
> **絕對不要開在正式環境**，也不要讓它出現在對外的安全群組 / Ingress 上。
> 需要在正式環境查問題時，用第 09 章的 `jcmd` / heap dump / JFR——
> **它們是唯讀的，JDWP 不是。**

---

### 0.12.9 什麼時候不該用除錯器

| 症狀 | 用什麼 | 章節 |
|---|---|---|
| 邏輯不對、值不如預期 | **除錯器** | 本節 |
| 只在正式環境發生 | 結構化日誌 + traceId | 02-spring-boot 第 05 章 |
| 只在高併發下發生 | `jstack`、執行緒傾印 | 第 08 章 8.17 |
| 記憶體一直漲 / OOM | heap dump + MAT | 第 09 章 9.11 |
| 「有時候慢」但不知道慢在哪 | JFR、火焰圖 | 第 09 章 9.12 |
| 要看「一萬次呼叫的分佈」 | 指標（Micrometer） | 02-spring-boot 第 05 章 5.14 |

> 🔑 **除錯器一次只能看一條執行緒的一個瞬間。**
> 「跨時間」（趨勢）和「跨請求」（分佈）的問題，它幫不上忙——
> 那是日誌與指標的工作。這條分界線在後面每一站都會再出現。

---

## 0.13 本章練習

### 練習 1：環境自檢

在終端機執行以下指令，確認四者版本一致：

```bash
java -version
javac -version
echo $JAVA_HOME
mvn -version
```

<details>
<summary>參考輸出</summary>

```
openjdk version "21.0.5" 2024-10-15 LTS
OpenJDK Runtime Environment Temurin-21.0.5+11 (build 21.0.5+11-LTS)
OpenJDK 64-Bit Server VM Temurin-21.0.5+11 (build 21.0.5+11-LTS, mixed mode)

javac 21.0.5

/Users/you/.sdkman/candidates/java/current

Apache Maven 3.9.9
Maven home: /Users/you/.sdkman/candidates/maven/3.9.9
Java version: 21.0.5, vendor: Eclipse Adoptium
```

關鍵是最後一行的 `Java version` 要跟 `java -version` 一樣。

</details>

### 練習 2：多版本切換

安裝 Java 8 與 Java 21，並回答：在 Java 8 環境下，下面這行為什麼編譯不過？

```java
var list = java.util.List.of("a", "b");
```

<details>
<summary>參考解答</summary>

兩個 Java 8 沒有的東西：

1. `var`（區域變數型別推斷）是 **Java 10** 才加入的語法。
2. `List.of(...)`（不可變集合工廠方法）是 **Java 9** 才加入的 API。

驗證：

```bash
sdk use java 8.0.432-tem
javac Test.java
# 錯誤: 找不到符號 / 'var' 不是有效的型別名稱
```

這正是 0.10 提到的：如果只用 `source`/`target` 設成 8，而 JDK 是 21，第 2 點會**編譯通過但執行時爆炸**。用 `release=8` 才會在編譯期就報錯。

</details>

### 練習 3：讀 bytecode

編譯下面這支程式，用 `javap -c` 觀察 `a + b` 和字串串接分別變成什麼指令。

```java
public class Calc {
    public static int add(int a, int b) {
        return a + b;
    }

    public static String label(String name, int count) {
        return name + ":" + count;
    }

    public static void main(String[] args) {
        System.out.println(add(1, 2));
        System.out.println(label("qty", 3));
    }
}
```

<details>
<summary>參考解答</summary>

```bash
javac Calc.java && javap -c Calc.class
```

`add` 非常單純，三條指令：

```
public static int add(int, int);
    Code:
       0: iload_0        // 載入第 0 個參數
       1: iload_1        // 載入第 1 個參數
       2: iadd           // 整數相加
       3: ireturn        // 回傳 int
```

`label` 就有趣了。Java 9+ 的編譯器不會產生 `StringBuilder`，而是用 `invokedynamic` 呼叫 `StringConcatFactory`：

```
public static java.lang.String label(java.lang.String, int);
    Code:
       0: aload_0
       1: iload_1
       2: invokedynamic #7,  0   // makeConcatWithConstants:(...)Ljava/lang/String;
       7: areturn
```

**這個觀察很重要**（第 07 章會用到）：字串串接不是「一律很慢」。
單次串接編譯器會最佳化掉；真正的效能問題出在**迴圈裡串接**，那時候每一圈都建新字串，才需要手動用 `StringBuilder`。

在 Java 8 上編譯同一支程式，你會看到 `new StringBuilder` / `append` / `toString` —— 這就是「Java 8 建議一律用 StringBuilder」這個老說法的來源，在現代 Java 上已經不完全適用。

</details>

### 練習 4：建立你的專案骨架

依照 0.10 建立 `demo/` 專案，讓 `mvn test` 綠燈通過。這個專案會一路用到第 12 章。

<details>
<summary>驗收方式</summary>

```bash
cd demo
mvn -q clean test
# 沒有輸出（-q 只印錯誤）就是成功
# 或用 mvn test 看到 Tests run: 1, Failures: 0, Errors: 0, Skipped: 0
```

檢查目錄結構：

```bash
find . -name "*.java" -o -name "pom.xml" | grep -v target
# ./pom.xml
# ./src/main/java/com/example/todo/App.java
# ./src/test/java/com/example/todo/AppTest.java
```

</details>

### 練習 5：情境判斷

你進了一家公司，接手一個 Spring Boot 2.7 的專案，跑在 Oracle JDK 8 上。老闆問「我們要不要升級 Java？」

請列出你會先查哪些事情。

<details>
<summary>參考解答</summary>

**授權與風險（通常最急）**

1. Oracle JDK 8 商業使用需要付費訂閱，公司有沒有買？若沒有，**最低成本的動作是先換成 Temurin 8**——這不改任何程式碼，只換 runtime，先把授權風險解掉。
2. Java 8 的公開安全更新狀況如何？有沒有已知 CVE 沒補？

**技術可行性**

3. Spring Boot 2.7 已停止 OSS 支援，升 Spring Boot 3.x 是**同時**要做的事，而 Boot 3 最低要求 Java 17。所以這其實是「Java 升級 + Spring 升級 + `javax.*` → `jakarta.*` 命名空間全面改名」三件事綁在一起。
4. 依賴清單裡有沒有卡住的東西？常見地雷：舊版 Hibernate、舊版 Lombok（不支援新 JDK 會直接編譯爆）、用了 `sun.misc.Unsafe` 或反射存取 JDK 內部 API 的函式庫（Java 9 模組化之後會被封鎖）。
5. 建置工具版本：Maven / Gradle 太舊可能不支援新 JDK。

**收益（要能講給老闆聽）**

6. 效能：G1 / ZGC 比 Java 8 預設的 Parallel GC 停頓短得多；JIT 也有多年改進，通常換 runtime 就有 10～20% 的免費效能。
7. 可觀測性：JFR 內建，線上診斷比 Java 8 時代容易太多（第 09 章）。
8. 若服務是 IO 密集且併發高，Java 21 的虛擬執行緒可能大幅簡化執行緒池調校（第 08 章）。

**執行策略**

9. 分階段，不要一次全上：`Oracle 8 → Temurin 8`（解授權）→ `Temurin 17`（解 Boot 3 前提）→ `Spring Boot 3`（改命名空間）→ `Temurin 21`。每一步都要有可回滾的部署。
10. 前提是**有測試**。如果測試覆蓋率接近零，升級前的第一件事是補測試（第 11 章），否則你只是在賭。

</details>

---

## 0.14 驗收清單

- [ ] 我能說明 JDK / JRE / JVM 的差別，以及跨平台是誰提供的。
- [ ] 我知道 Java 每 6 個月發一版，每 2 年一個 LTS，也知道 21 和 25 都是 LTS。
- [ ] 我知道 Oracle JDK 有授權風險，預設該用 Temurin 或 Corretto。
- [ ] 我的機器上有 JDK 21，`java` / `javac` / `JAVA_HOME` / `mvn` 四者版本一致。
- [ ] 我能在兩個 JDK 版本之間切換，也知道 `.sdkmanrc` 的用途。
- [ ] 我能解釋 `public static void main(String[] args)` 每一個字的意義。
- [ ] 我能說出 `.java` → `.class` → JVM 執行的流程，並知道 JIT 為什麼讓 Java「跑久了變快」。
- [ ] 我有一個能 `mvn test` 綠燈的 Maven 專案骨架。
- [ ] 我看到 `UnsupportedClassVersionError` 時，知道要對比編譯版本和執行版本。
- [ ] 我知道 `maven.compiler.release` 比 `source`/`target` 安全，也說得出為什麼。
- [ ] 我會設中斷點、單步執行，也設定過 step filter 讓除錯器不要進到 JDK 內部。
- [ ] 我會用**條件式中斷點**只在特定那一圈停住，也知道它在熱迴圈裡的代價。
- [ ] **我會用例外中斷點在 `throw` 的瞬間停住，也知道 Caught 和 Uncaught 的差別。**
- [ ] 我知道 Variables 面板會呼叫 `toString()`，而它可能有副作用。
- [ ] **我知道「debug 時停住，但資料庫交易與 HTTP 連線的逾時不會停」。**
- [ ] 我知道併發問題用除錯器幾乎抓不到，要改用執行緒傾印。
- [ ] 我會用 `-agentlib:jdwp=...,address=*:5005` 遠端除錯容器裡的 JVM。
- [ ] **我知道 JDWP 埠等於無認證的遠端程式碼執行，絕不能開在正式環境。**

---

完成後請前往 [01-syntax-variables-control-flow.md](./01-syntax-variables-control-flow.md)。
