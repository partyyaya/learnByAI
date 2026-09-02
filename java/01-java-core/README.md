# 01 — Java 語言核心與 JVM

> 目標不是「背完語法」，而是能寫出**別人看得懂、測得動、上線不炸**的 Java 程式，並理解 JVM 在背後做了什麼。
> 這一站打的地基，後面 Spring Boot 的每一個「魔法」都會回頭用到——
> 而第 13 章會把那些「魔法」直接拆開給你看。

---

## 學完你可以

- 選對 JDK 版本，說明 LTS、發行節奏與 Java 8 / 17 / 21 的關鍵差異。
- 用 OOP 四大特性設計類別，而不是把所有程式塞進 `main`。
- 正確處理例外：知道什麼該 catch、什麼該往上拋、什麼該包成自訂例外。
- 熟練 Collections 與 Stream，寫出宣告式而非一堆 for 迴圈的資料處理。
- 說明堆疊 / 堆積、GC 何時發生、OOM 怎麼查。
- 用 Maven 或 Gradle 管依賴、打包，用 JUnit 5 + Mockito 寫測試。
- 用除錯器（含條件式與例外中斷點）取代 `println`，並知道什麼時候它會騙你。
- **讀懂框架**：說明反射、註解與動態代理怎麼組成 Spring 的「魔法」。

## 前置知識

任一程式語言基礎（知道變數、迴圈、函式是什麼）即可。

---

## 章節目錄

| 章節 | 檔案 | 主題 | 重點 |
|------|------|------|------|
| 00 | [00-course-map-jdk-setup.md](./00-course-map-jdk-setup.md) | 課程地圖、JDK 版本與環境安裝 | LTS 策略、SDKMAN（Windows 建議 WSL2）、JAVA_HOME、IDE、第一支程式與編譯流程、**除錯器** |
| 01 | [01-syntax-variables-control-flow.md](./01-syntax-variables-control-flow.md) | 基本語法與流程控制 | 基本型別 vs 包裝型別、字串池、整數溢位、`BigDecimal`、switch、迴圈、陣列 |
| 02 | [02-oop-class-object-encapsulation.md](./02-oop-class-object-encapsulation.md) | 類別、物件與封裝 | 建構子、`this`、static、存取修飾子、package、不可變物件、Builder |
| 03 | [03-inheritance-polymorphism-interface.md](./03-inheritance-polymorphism-interface.md) | 繼承、多型與介面 | 抽象類別 vs 介面、`default`/`static` 方法、組合優於繼承、對介面編程 |
| 04 | [04-exception-handling.md](./04-exception-handling.md) | 例外處理 | Checked vs Unchecked、try-with-resources、例外鏈、自訂例外、分層策略 |
| 05 | [05-collections-and-generics.md](./05-collections-and-generics.md) | 集合框架與泛型 | List / Set / Map 選型、`equals`/`hashCode` 契約、泛型與 PECS、Comparator |
| 06 | [06-stream-lambda-optional.md](./06-stream-lambda-optional.md) | Lambda、Stream 與 Optional | 函式介面、方法參考、collect / groupingBy、Optional 正確用法、平行流的陷阱 |
| 07 | [07-string-io-datetime-json.md](./07-string-io-datetime-json.md) | 字串、IO、日期時間與 JSON | 編碼、正規表達式 DoS、NIO.2 原子寫入、`java.time` 與 DST、Jackson |
| 08 | [08-concurrency-thread-executor.md](./08-concurrency-thread-executor.md) | 併發程式設計 | JMM 與 `volatile`、鎖、死鎖診斷、`ExecutorService`、`CompletableFuture`、虛擬執行緒 |
| 09 | [09-jvm-memory-and-gc.md](./09-jvm-memory-and-gc.md) | JVM 記憶體模型與 GC | 類別載入、堆疊 / 堆積 / Metaspace、GC 演算法、六種 OOM、`jcmd` / heap dump / JFR |
| 10 | [10-build-tools-maven-gradle.md](./10-build-tools-maven-gradle.md) | 建置工具 | Maven 生命週期與座標、依賴衝突、BOM、多模組、打包可執行 jar、容器化、供應鏈風險 |
| 11 | [11-testing-junit-mockito.md](./11-testing-junit-mockito.md) | 測試 | JUnit 5、參數化測試、AssertJ、Mockito、契約測試、併發測試、覆蓋率與突變測試 |
| 12 | [12-modern-java-records-sealed-pattern.md](./12-modern-java-records-sealed-pattern.md) | 現代 Java 特性 | `record`、`sealed`、switch 模式比對、`var`、文字區塊，何時該用 |
| 13 | [13-reflection-annotations-and-proxy.md](./13-reflection-annotations-and-proxy.md) | 反射、註解與動態代理 | `Class`、`setAccessible`、自訂註解、`Proxy`、手寫測試框架 / DI 容器 / AOP |

### 怎麼讀

```
00（環境、除錯器）
 └─→ 01 → 02 → 03    ← 語言地基，照順序讀，不要跳
      ├─→ 04（例外）
      ├─→ 05（集合）─→ 06（Stream）
      ├─→ 07（字串 / IO / 時間 / JSON）
      ├─→ 08（併發）─→ 09（JVM 與 GC）
      └─→ 10（建置）─→ 11 ★（測試）─→ 12（現代語法）─→ 13 ★（反射與代理）
```

⚠️ **如果時間有限**：
**02、03 是後面全部章節的前提**，不能跳。
**11 是唯一能讓你「敢改程式」的一章。**
**13 是通往第 02 站的橋** —— 跳過它，Spring 就會一直是黑箱。
09 與 10 可以先讀一遍有印象，等真的遇到 OOM 或依賴衝突再回來查。

---

## 常見誤區（課程會逐一破解）

- 到處 `catch (Exception e) { e.printStackTrace(); }` — 例外被吞掉，線上出事查不到。
- 用 `==` 比字串，測試環境剛好過、正式環境爆掉。
- 用 `double` 算錢，對帳差一分錢查三天。
- `HashMap` 的 key 沒實作 `hashCode` / `equals`，查不到自己剛放進去的東西。
- Stream 寫成一行 200 字，比 for 迴圈還難讀。
- 以為 `static` 是萬用工具，結果整份程式無法測試。
- 覆蓋率 100%，但沒有任何一個測試會因為你改壞一行而變紅。
- 自訂註解忘了寫 `@Retention(RUNTIME)`，程式不報錯、只是什麼都沒發生。

---

## 練習專案：一個純 Java 的待辦事項 CLI

課文會帶你從第 02 章一路寫到第 13 章，做出同一個**不用任何框架**的待辦事項 CLI。
**專案由你自己在本機建立**（第 00 章 0.10 節有骨架），repo 裡只放課程的 `.md` 檔案。

刻意不用框架，是為了讓你在第 02 站看到 Spring 時，能清楚分辨
「這是 Java 語言本來就有的」和「這是 Spring 加上去的」。

| 章節 | 專案演進 |
|------|----------|
| 02 | `Todo` / `TodoList` / `Priority`：用類別建模，取代三個平行的 `List` |
| 03 | 抽出 `TodoRepository` / `Notifier` 介面，手動組裝依賴（DI 的原型） |
| 04 | 錯誤碼 enum + 例外體系 + 最外層統一處理器 |
| 05 | 標籤反向索引（`Map<String, Set<Long>>`）、`EnumMap`、統計 |
| 06 | 統計全面改用 Stream（`groupingBy` / `teeing` / `filtering`） |
| 07 | JSON 檔案持久化（原子寫入 + 備份）、`Instant`、注入 `Clock` |
| 08 | 多來源併發匯入（虛擬執行緒 + `Semaphore`），Repository 加上執行緒安全 |
| 09 | 故意做出四種記憶體洩漏，再用 `jstat` / heap dump / MAT 抓出來並修掉 |
| 10 | 拆成四個 Maven 模組，打包成可執行 jar，加上 SBOM 與 Docker 映像 |
| 11 | 完整測試安全網：契約測試、fake、`MutableClock`、ArchUnit、JaCoCo + 突變測試 |
| 12 | `record` + `sealed Completion` 消滅 null、`sealed Command` 讓 CLI 分派有窮盡性檢查 |
| 13 | 手寫迷你測試框架、迷你 DI 容器、`@Timed` 動態代理——把前 12 章的成果反過來當框架的材料 |

### 這個專案「會變」，而且那是重點

跟著做的時候，你會發現**前面章節寫的類別，後面章節會回頭改它**。
每一次改動都有一個當下才學得到的理由 —— 先知道會改什麼，讀起來會順很多：

| 在哪一章被改 | 改了什麼 | 為什麼 |
|---|---|---|
| 03 | `TodoList` 拆成 `TodoRepository` 介面 + 實作 | 換儲存方式不該動到商業邏輯 |
| 04 | 驗證改丟 `InvalidTodoException`，不再是 `IllegalArgumentException` | 錯誤要帶錯誤碼與上下文 |
| 05 | `Todo` 加上標籤；`InMemoryTodoRepository` 加上反向索引 | 用對集合，把 O(n) 變成 O(1) |
| 06 | `TodoStatistics` 的 for 迴圈全改成 `Collectors` | 宣告式比命令式好讀 |
| 07 | `createdAt` 從 `LocalDateTime` 改成 `Instant`；`TodoService` 注入 `Clock` | 事件時刻必須無歧義、時間要可測 |
| 07 | ⚠️ 上一條會讓 06 章的 `TodoStatistics.countByDate()` **編不過** | `Instant` 沒有「日期」，要先講定時區（7.18 節有完整的更新版） |
| 08 | `JsonFileTodoRepository` 加上 `ReadWriteLock` | 併發匯入會壞掉 |
| 11 | `App` 的輸出改成注入的 `PrintStream` | 不注入就沒辦法驗證輸出（11.17 節） |
| 12 | `Todo` 改成 `record` + `sealed Completion` | 消滅 null，讓無效狀態編不出來 |
| 12 | ⚠️ 上一條會讓 08、11 章的四個檔案編不過 | 清單與修法在 12.16 節，**編譯器會逐一指給你看** |

> 🔑 **兩個 ⚠️ 是刻意留著的。** 它們是這門課想教的其中一件事：
> **好的型別設計，會讓「我改了 A，哪些地方要跟著改」變成編譯器的工作，而不是你的記憶力。**

---

## 關於書裡的程式碼

**基準版本**：Java 21（Temurin）/ Maven 3.9。
測試相關的版本在第 11 章 11.4 節宣告：JUnit 5.11、AssertJ 3.26、Mockito 5.13、
Awaitility 4.2、ArchUnit 1.3、JaCoCo 0.8.12；第 07 章用 Jackson 2.17。

課文會把「哪一版才有」標在旁邊（例如 `【Java 15+】` 的文字區塊、
`【Java 21】` 的虛擬執行緒與模式比對、`【Java 25】` 的 `ScopedValue` 與精簡原始檔）。
**如果你的專案還在 Java 8 / 11 / 17，這些地方要換回舊寫法** —— 第 12 章 12.14 節有版本對照表。

> ✅ 課文裡的範例程式與待辦事項專案（第 02～11 章的版本），
> 都在 **JDK 21 + Maven 3.9** 上編譯執行過，可以直接抄。
>
> ⚠️ **這三類東西請以你自己環境跑出來的結果為準**：
> 第 09 章的 GC 與 heap dump 數字（隨機器與收集器而不同）、
> 第 10 章的 Gradle / Docker / jlink 建置、第 12 章之後的 record 版專案
> （它**刻意**會讓四個檔案編不過，清單見 12.16 節）。

---

完成後請前往 [02-spring-boot](../02-spring-boot/) ——
那一站的每一個「魔法」，都是這一站某個概念的自動化版本。
