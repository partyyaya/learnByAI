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
| 00 | [00-course-map-jdk-setup.md](./00-course-map-jdk-setup.md) | 課程地圖、JDK 版本與環境安裝 | LTS 策略、SDKMAN（Windows 建議 WSL2）、JAVA_HOME、IDE、第一支程式與編譯流程 |
| 01 | [01-syntax-variables-control-flow.md](./01-syntax-variables-control-flow.md) | 基本語法與流程控制 | 基本型別 vs 包裝型別、字串池、運算子、switch、迴圈、陣列 |
| 02 | [02-oop-class-object-encapsulation.md](./02-oop-class-object-encapsulation.md) | 類別、物件與封裝 | 建構子、`this`、static、存取修飾子、package、不可變物件 |
| 03 | [03-inheritance-polymorphism-interface.md](./03-inheritance-polymorphism-interface.md) | 繼承、多型與介面 | 抽象類別 vs 介面、`default`/`static` 方法、組合優於繼承 |
| 04 | [04-exception-handling.md](./04-exception-handling.md) | 例外處理 | Checked vs Unchecked、try-with-resources、自訂例外、例外設計原則 |
| 05 | [05-collections-and-generics.md](./05-collections-and-generics.md) | 集合框架與泛型 | List / Set / Map 選型、`equals`/`hashCode`、泛型與萬用字元、Comparator |
| 06 | [06-stream-lambda-optional.md](./06-stream-lambda-optional.md) | Lambda、Stream 與 Optional | 函式介面、方法參考、collect / groupingBy、Optional 正確用法、平行流的陷阱 |
| 07 | [07-string-io-datetime-json.md](./07-string-io-datetime-json.md) | 字串、IO、日期時間與 JSON | `StringBuilder`、文字區塊、NIO.2、`java.time` 時區、Jackson 序列化 |
| 08 | [08-concurrency-thread-executor.md](./08-concurrency-thread-executor.md) | 併發程式設計 | Thread、`synchronized`、`ExecutorService`、`CompletableFuture`、Java 21 虛擬執行緒 |
| 09 | [09-jvm-memory-and-gc.md](./09-jvm-memory-and-gc.md) | JVM 記憶體模型與 GC | 類別載入、堆疊 / 堆積 / Metaspace、GC 演算法、OOM 診斷、`jstack` / `jmap` / JFR |
| 10 | [10-build-tools-maven-gradle.md](./10-build-tools-maven-gradle.md) | 建置工具 | Maven 生命週期與座標、依賴傳遞與衝突、Gradle 對照、多模組、打包可執行 jar |
| 11 | [11-testing-junit-mockito.md](./11-testing-junit-mockito.md) | 測試 | JUnit 5、參數化測試、AssertJ、Mockito stub / verify、測試命名與結構 |
| 12 | [12-modern-java-records-sealed-pattern.md](./12-modern-java-records-sealed-pattern.md) | 現代 Java 特性 | `record`、`sealed`、switch 模式比對、`var`、文字區塊，何時該用 |
| 13 | [13-reflection-annotations-and-proxy.md](./13-reflection-annotations-and-proxy.md) | 反射、註解與動態代理 | `Class`、`setAccessible`、自訂註解、`Proxy`、手寫測試框架 / DI 容器 / AOP |

---

## 常見誤區（課程會逐一破解）

- 到處 `catch (Exception e) { e.printStackTrace(); }` — 例外被吞掉，線上出事查不到。
- 用 `==` 比字串，測試環境剛好過、正式環境爆掉。
- `HashMap` 的 key 沒實作 `hashCode` / `equals`，查不到自己剛放進去的東西。
- Stream 寫成一行 200 字，比 for 迴圈還難讀。
- 以為 `static` 是萬用工具，結果整份程式無法測試。
- 自訂註解忘了寫 `@Retention(RUNTIME)`，程式不報錯、只是什麼都沒發生。

## 練習專案

`demo/` 底下會放一個純 Java（無框架）的**待辦事項 CLI**，一路從第 02 章長到第 13 章：
先用類別建模，再導入集合與 Stream，接著加例外處理、檔案持久化、併發匯入，補上完整測試，
最後用反射與代理**自己做出一個小框架**。

刻意不用框架，是為了讓你在第 02 站看到 Spring 時，能清楚分辨「這是 Java 語言本來就有的」和「這是 Spring 加上去的」。

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

---

## 進度

**第 00～13 章全部完成**（含每章的驗收清單與附解答練習），合計約 **54,200 行**。
這一站已結業，下一站是 [02-spring-boot](../02-spring-boot/)。

> ⚠️ 課程中的程式碼與建置設定均經逐行檢閱，但**尚未在本機編譯執行驗證**
> （這台機器上沒有安裝 JDK 與 Maven）。若你在實作時遇到與課文不符的輸出，請以你的環境為準。
