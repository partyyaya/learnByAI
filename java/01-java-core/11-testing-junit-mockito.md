# 第 11 章：測試

> 前面十章我們寫了一個功能完整的 Todo CLI：有例外體系、有檔案持久化、
> 有併發匯入、有記憶體洩漏診斷、能打包成一個 jar 出貨。
>
> 但它有一個致命問題：**我們從來不知道它是不是對的。**
>
> 每次改完程式，我們的驗證方式是「跑一下看看」。這在 200 行時可行，
> 在 2,000 行時勉強，在 20,000 行時是自殺。
>
> 這一章要蓋的是**安全網**——它不會讓你的程式變快、變好看，
> 但它是唯一能讓你「三個月後還敢改這段程式碼」的東西。

---

## 11.1 學習目標

完成本章後，你應該可以：

- 說出「沒有測試」的三個具體成本，以及測試真正在買的是什麼。
- 說明測試金字塔，並在單元 / 整合 / 端對端之間分配你的測試。
- 建立 JUnit 5 環境，說出 Platform / Jupiter / Vintage 三層的分工。
- 熟練 JUnit 5 的生命週期註解，並說明測試實例的預設生命週期。
- 用 AssertJ 寫出可讀的斷言，並知道它比 `assertEquals` 好在哪。
- 用 `@Nested` + `@DisplayName` 讓測試報告本身就是一份規格書。
- 寫參數化測試，並選對 `@ValueSource` / `@CsvSource` / `@MethodSource` / `@EnumSource`。
- 分辨 dummy / stub / spy / mock / fake 五種測試替身。
- 用 Mockito 的 `@Mock` / `@InjectMocks` / `verify` / `ArgumentCaptor`，並避開六個常見誤用。
- **測試「不可測」的東西**：時間、隨機、檔案系統、環境變數、併發。
- 寫「契約測試」，讓同一份測試驗證多個實作。
- 設定 JaCoCo 覆蓋率門檻，並說明覆蓋率會騙你的兩種情況。
- 認出 flaky test 的六個來源並修掉它們。
- **給 Todo 專案補上完整的測試安全網。**

---

## 11.2 先看見沒有測試的代價

### 一個「顯然正確」的五行改動

我們的 `TodoService` 有這個方法（第 07 章寫的）：

```java
public Todo markDone(long id) {
    Todo todo = repository.findById(id)
            .orElseThrow(() -> new TodoNotFoundException(id));
    todo.markDone(clock.instant());
    repository.save(todo);
    notifier.notifyDone(todo);
    return todo;
}
```

產品經理說：「已經完成的事項再按一次完成，不要噴錯，直接當成功就好。」

你花 30 秒改完：

```java
public Todo markDone(long id) {
    Todo todo = repository.findById(id)
            .orElseThrow(() -> new TodoNotFoundException(id));
    if (todo.isDone()) {
        return todo;                     // ← 已完成就直接回傳
    }
    todo.markDone(clock.instant());
    repository.save(todo);
    notifier.notifyDone(todo);
    return todo;
}
```

手動測一下：

```bash
$ todo add "買牛奶"
已新增 #1 買牛奶
$ todo done 1
已標記完成。
$ todo done 1
已標記完成。          # ✅ 不噴錯了，需求達成
```

**看起來完美。合併，上線。**

### 三個星期後

三個問題陸續回報：

**問題 1**：客服說「使用者抱怨重複按完成，通知訊息沒有再發一次」。
——這是**正確的**行為，但沒人知道這是刻意的。半天的溝通成本。

**問題 2**：報表團隊說「`completedAt` 有些是 null」。
——因為某條舊路徑呼叫的是 `todo.markDone()` 而不是 `service.markDone()`，
你的 `if` 沒有守住那條路。你完全不知道有那條路。

**問題 3**：QA 說「刪掉再重新加同一個標題，`done 1` 會標記到錯的事項」。
——這跟你的改動無關，是三個月前的 bug。但因為沒有測試，
**沒有人能確定它跟你的改動有沒有關**。你花了一天證明「不是我」。

### 沒有測試的三個成本

| 成本 | 具體長什麼樣 |
|---|---|
| **不敢改** | 「這段程式碼我看不懂但它能跑，別動它」——技術債從此利滾利。三年後整個模組沒人敢碰，只能包一層新的在外面 |
| **改了不知道有沒有壞** | 每次上線都是賭博。回歸測試靠人手動點，點 30 分鐘，漏掉的比測到的多 |
| **除錯時間爆炸** | 有測試：失敗的那個測試直接告訴你哪裡壞了。沒測試：從「使用者說有問題」到「找到那一行」可能是三天 |

### 測試真正在買的是什麼

新手常以為測試是為了「找出 bug」。**不是。**

寫測試的當下你幾乎不會找到 bug（那段程式碼你剛寫完，你知道它在做什麼）。
測試真正的價值在**未來**：

> **測試是「我對這段程式碼行為的理解」的可執行版本。**
>
> 它讓你三個月後改這段程式碼時，能在 10 秒內知道自己有沒有改壞。
> 它讓新人能靠讀測試理解需求，而不是問你。
> 它讓 code review 的人能看「行為變了什麼」而不只是「程式碼變了什麼」。

換個角度：**測試買的是「改變的勇氣」。**
一個沒有測試的專案，重構成本趨近無限；一個測試良好的專案，
你可以把整個實作重寫，只要測試還是綠的就知道行為沒變。

### 上面那個改動，該有的測試

```java
@Nested
@DisplayName("markDone")
class MarkDone {

    @Test
    @DisplayName("標記完成後會設定完成時間、儲存、並發出通知")
    void marksDoneAndNotifies() {
        Todo todo = new Todo(1L, "買牛奶", Priority.MEDIUM, FIXED_NOW);
        given(repository.findById(1L)).willReturn(Optional.of(todo));

        Todo result = service.markDone(1L);

        assertThat(result.isDone()).isTrue();
        assertThat(result.completedAt()).isEqualTo(FIXED_NOW);
        verify(repository).save(todo);
        verify(notifier).notifyDone(todo);
    }

    @Test
    @DisplayName("重複標記完成是冪等的：不噴錯、不重複儲存、不重複通知")
    void isIdempotent() {
        Todo done = new Todo(1L, "買牛奶", Priority.MEDIUM, FIXED_NOW);
        done.markDone(FIXED_NOW);
        given(repository.findById(1L)).willReturn(Optional.of(done));

        assertThatNoException().isThrownBy(() -> service.markDone(1L));

        verify(repository, never()).save(any());
        verify(notifier, never()).notifyDone(any());
    }
}
```

第二個測試的名字就是那份「沒人知道是刻意的」的規格。
它同時**記錄了決定**、**防止未來有人改回去**、**讓 code review 的人一眼看懂**。

這就是本章要教的東西。

---

## 11.3 測試的種類與比例

### 測試金字塔

```
              ╱╲                E2E / UI 測試
             ╱  ╲               慢（分鐘）、脆、貴
            ╱ 5% ╲              但最接近真實使用者
           ╱──────╲
          ╱        ╲            整合測試
         ╱   15%    ╲           中（秒）、真實依賴（DB、HTTP）
        ╱────────────╲          驗證「元件接起來會動」
       ╱              ╲
      ╱      80%       ╲        單元測試
     ╱                  ╲       快（毫秒）、穩、便宜
    ╱────────────────────╲      驗證「這個類別的邏輯對」
```

| | 單元測試 | 整合測試 | 端對端測試 |
|---|---|---|---|
| 範圍 | 一個類別（依賴用替身） | 幾個元件 + 真實資源（DB、檔案） | 整個系統 |
| 速度 | < 10 ms | 100 ms ～ 幾秒 | 幾秒 ～ 幾分鐘 |
| 穩定性 | 極穩 | 中 | 容易 flaky |
| 失敗時的定位 | **直接指出哪個方法錯** | 大概知道哪一層 | 只知道「壞了」 |
| 本章重點 | ✅ 主要 | ✅ 11.17 節 | ➖ 第 10 站 |
| 工具 | JUnit 5 + AssertJ + Mockito | + failsafe + Testcontainers | Selenium / Playwright / REST-assured |

**為什麼是金字塔而不是方塊？** 因為速度與定位能力。

假設你有一個 bug：「訂單金額算錯」。

- 單元測試失敗 → `OrderCalculatorTest.appliesVolumeDiscount` 紅了 → 你知道是折扣邏輯，30 秒定位。
- 只有 E2E 測試 → 「結帳流程失敗」紅了 → 可能是前端、API、服務層、DB、快取⋯⋯ 兩小時定位。

### 反面模式：冰淇淋甜筒

```
    ╱────────────────────╲       手動測試（最多）
   ╱                      ╲
  ╱────────────────────────╲     E2E 測試（很多）
   ╲                      ╱
    ╲────────────────────╱       整合測試
     ╲                  ╱
      ╲────────────────╱         單元測試（很少）
       ╲              ╱
        ╲────────────╱
```

症狀：CI 跑 40 分鐘、每週有幾次「重跑就過了」、沒人相信紅燈是真的。

一旦團隊開始說「先重跑看看」，測試就已經死了——**它不再提供資訊。**

### 現代的修正：Testcontainers 讓中間層變便宜

金字塔是 2000 年代的產物，那時「整合測試」意味著要有人維護一台共用的測試資料庫，
所以要盡量少。現在有 Docker + Testcontainers，起一個乾淨的 PostgreSQL 只要兩秒，
比例可以變成：

```
     ╱╲          E2E 5%
    ╱──╲
   ╱ 30 ╲        整合測試（真 DB、真 HTTP，靠容器隔離）
  ╱──────╲
 ╱   65   ╲      單元測試
╱──────────╲
```

**但原則不變：失敗時能不能快速定位。**
如果你的 300 個整合測試每次都跑 10 分鐘，還是要往下推。

### 什麼該用單元測試、什麼該用整合測試

| 要驗證的東西 | 用哪種 | 理由 |
|---|---|---|
| 分支邏輯、邊界值、例外路徑 | **單元** | 組合爆炸，只有單元測試跑得完 |
| 演算法、計算 | **單元** | 純函式，最容易測 |
| 「有沒有呼叫通知服務」 | **單元**（mock） | 不需要真的寄信 |
| SQL 對不對、交易有沒有回滾 | **整合** | mock 掉 DB 就等於沒測到 SQL |
| JSON 序列化的實際格式 | **整合**（或用真的 `ObjectMapper` 的單元測試） | mock `ObjectMapper` 毫無意義 |
| 檔案的原子寫入、備份輪替 | **整合**（`@TempDir`） | 檔案系統的行為 mock 不出來 |
| 併發競態 | **單元**（多執行緒） + **壓力測試** | 第 08 章的內容，11.15 節 |
| 「使用者能不能完成下單」 | **E2E** | 只有這種能驗證整條路徑 |

> **一句話判準**：如果你把某個依賴 mock 掉之後，這個測試「還在驗證有意義的東西」，
> 就寫單元測試。如果 mock 掉之後測試就變成「驗證我的 mock 設定對不對」，
> 那就該用真實依賴的整合測試。

---

## 11.4 環境設定與第一個測試

### JUnit 5 的三層架構

```
┌───────────────────────────────────────────────────────────────┐
│  你的建置工具 / IDE                                            │
│  （surefire、Gradle test task、IntelliJ 的執行按鈕）            │
└──────────────────────────┬────────────────────────────────────┘
                           │ Launcher API
┌──────────────────────────▼────────────────────────────────────┐
│  JUnit Platform                                               │
│  負責「發現測試、執行測試、回報結果」的基礎設施。               │
│  它不知道什麼是 @Test——那是 engine 的事。                      │
└────────┬──────────────────┬───────────────────┬───────────────┘
         │ Engine API       │                   │
┌────────▼───────┐  ┌───────▼────────┐  ┌───────▼──────────────┐
│ JUnit Jupiter  │  │ JUnit Vintage  │  │ 其他 engine          │
│ （JUnit 5 的   │  │ （跑舊的       │  │ Spock / Cucumber /   │
│  新 API）      │  │  JUnit 4 測試）│  │ TestNG / ArchUnit    │
└────────────────┘  └────────────────┘  └──────────────────────┘
```

**為什麼要分這麼多層？** 因為 JUnit 4 把「API」和「執行引擎」綁在一起，
導致 IDE 和建置工具都寫死了對 JUnit 4 內部的依賴，整個生態系動不了。

Platform 這一層的意義是：**你可以在同一次執行裡混跑 JUnit 4 的舊測試、
JUnit 5 的新測試、和 ArchUnit 的架構測試**——它們是三個不同的 engine，
但共用同一個 Launcher。這讓「漸進遷移」變成可能。

**Artifact 對照：**

| 座標 | 內容 | 你需要嗎 |
|---|---|---|
| `org.junit.jupiter:junit-jupiter` | **聚合包**：api + params + engine | ✅ 用這個就好 |
| `org.junit.jupiter:junit-jupiter-api` | `@Test`、`Assertions`⋯（編譯期） | 由聚合包帶入 |
| `org.junit.jupiter:junit-jupiter-params` | `@ParameterizedTest` | 由聚合包帶入 |
| `org.junit.jupiter:junit-jupiter-engine` | 執行引擎（執行期） | 由聚合包帶入 |
| `org.junit.vintage:junit-vintage-engine` | 跑 JUnit 4 的測試 | 只有遷移時要 |
| `org.junit.platform:junit-platform-suite` | `@Suite` 組測試集 | 少用 |

### Maven 設定

沿用第 10 章的多模組專案。根 pom 已經有 `junit-bom` 與共用測試依賴，
這裡把完整的測試相關設定列出來：

```xml
<properties>
  <junit.version>5.11.0</junit.version>
  <assertj.version>3.26.3</assertj.version>
  <mockito.version>5.13.0</mockito.version>
  <awaitility.version>4.2.2</awaitility.version>
  <archunit.version>1.3.0</archunit.version>
  <jacoco.version>0.8.12</jacoco.version>
</properties>

<dependencyManagement>
  <dependencies>
    <dependency>
      <groupId>org.junit</groupId>
      <artifactId>junit-bom</artifactId>
      <version>${junit.version}</version>
      <type>pom</type>
      <scope>import</scope>
    </dependency>
  </dependencies>
</dependencyManagement>

<dependencies>
  <!-- JUnit 5：聚合包，一個就夠。版本來自 BOM -->
  <dependency>
    <groupId>org.junit.jupiter</groupId>
    <artifactId>junit-jupiter</artifactId>
    <scope>test</scope>
  </dependency>

  <!-- AssertJ：斷言。11.6 節會說明為什麼不用 JUnit 內建的 -->
  <dependency>
    <groupId>org.assertj</groupId>
    <artifactId>assertj-core</artifactId>
    <version>${assertj.version}</version>
    <scope>test</scope>
  </dependency>

  <!-- Mockito：測試替身。注意要用 mockito-junit-jupiter 才有 MockitoExtension -->
  <dependency>
    <groupId>org.mockito</groupId>
    <artifactId>mockito-core</artifactId>
    <version>${mockito.version}</version>
    <scope>test</scope>
  </dependency>
  <dependency>
    <groupId>org.mockito</groupId>
    <artifactId>mockito-junit-jupiter</artifactId>
    <version>${mockito.version}</version>
    <scope>test</scope>
  </dependency>

  <!-- Awaitility：測非同步 / 併發（11.15 節） -->
  <dependency>
    <groupId>org.awaitility</groupId>
    <artifactId>awaitility</artifactId>
    <version>${awaitility.version}</version>
    <scope>test</scope>
  </dependency>

  <!-- ArchUnit：把第 10 章的模組邊界變成測試（11.19 節） -->
  <dependency>
    <groupId>com.tngtech.archunit</groupId>
    <artifactId>archunit-junit5</artifactId>
    <version>${archunit.version}</version>
    <scope>test</scope>
  </dependency>
</dependencies>
```

> ⚠️ **所有測試依賴一律 `<scope>test</scope>`。**
> 第 10 章 10.7 節講過忘記寫的後果：有人在產品程式碼 `import` 了
> `org.junit.jupiter.api.Assertions.assertNotNull`，上線後 `NoClassDefFoundError`
> 炸在付款流程。scope 不是為了省空間，是為了讓這件事在編譯期就不可能。

surefire 的設定（第 10 章 10.10 節，這裡補上 Mockito 的 agent 設定）：

```xml
<build>
  <plugins>
    <!-- 讓 ${org.mockito:mockito-core:jar} 這個 property 可用 -->
    <plugin>
      <groupId>org.apache.maven.plugins</groupId>
      <artifactId>maven-dependency-plugin</artifactId>
      <version>3.8.0</version>
      <executions>
        <execution>
          <id>resolve-agent-paths</id>
          <phase>process-test-classes</phase>
          <goals><goal>properties</goal></goals>
        </execution>
      </executions>
    </plugin>

    <plugin>
      <groupId>org.apache.maven.plugins</groupId>
      <artifactId>maven-surefire-plugin</artifactId>
      <version>3.5.0</version>
      <configuration>
        <!-- @{argLine} 保留 JaCoCo 的 agent（第 10 章 10.10 節的坑）
             -javaagent 明確掛載 Mockito，見下方說明 -->
        <argLine>
          @{argLine}
          -javaagent:${org.mockito:mockito-core:jar}
          -Duser.timezone=Asia/Taipei
          -Dfile.encoding=UTF-8
        </argLine>
      </configuration>
    </plugin>
  </plugins>
</build>
```

> **為什麼要明確 `-javaagent` 掛 Mockito？**
>
> Mockito 的 inline mock maker（Mockito 5 起是預設）需要一個 Java agent
> 才能改寫 `final` 類別與 `static` 方法的 bytecode。它過去用「自我附加」
> （self-attach）的方式在執行期動態載入 agent。
>
> 但 JDK 21 起，動態載入 agent 會發出警告（JEP 451），
> 未來版本會**預設禁止**。所以你會看到：
>
> ```
> WARNING: A Java agent has been loaded dynamically (mockito-core-5.13.0.jar)
> WARNING: If a serviceability tool is in use, please run with -XX:+EnableDynamicAgentLoading
> WARNING: Dynamic loading of agents will be disallowed by default in a future release.
> ```
>
> 用 `-javaagent:` 明確掛載就沒有這個問題，而且是未來唯一可行的方式。
> `${org.mockito:mockito-core:jar}` 這個 property 由 `dependency:properties` 產生，
> 指向本機倉庫裡那個 jar 的絕對路徑——不用自己組路徑。

### 本章的受測程式碼

為了讓後面所有測試都能直接看懂，先把受測的類別完整列出（**從第 02～08 章原樣搬來**，
只在 `TodoService` 多了一個 `Notifier` 參數，理由見下方說明）。

**`Priority.java`**（第 02 章）

```java
package com.example.todo.model;

/** 優先度。附帶顯示用的標籤與排序權重（第 02 章 2.14 節：帶欄位的 enum）。 */
public enum Priority {

    HIGH("高", 3),
    MEDIUM("中", 2),
    LOW("低", 1);

    private final String label;
    private final int weight;

    Priority(String label, int weight) {
        this.label = label;
        this.weight = weight;
    }

    public String label() {
        return label;
    }

    public int weight() {
        return weight;
    }
}
```

**`Todo.java`**（第 07 章：用 `Instant`）

```java
package com.example.todo.model;

import com.example.todo.exception.InvalidTodoException;
import com.example.todo.exception.TodoAlreadyDoneException;

import java.time.Instant;
import java.util.LinkedHashSet;
import java.util.Objects;
import java.util.Set;

public class Todo {

    public static final int MAX_TITLE_LENGTH = 100;
    public static final int MAX_TAGS = 5;

    private final long id;
    private final Instant createdAt;
    private String title;
    private Priority priority;
    private boolean done;
    private Instant completedAt;
    private final Set<String> tags = new LinkedHashSet<>();

    public Todo(long id, String title, Priority priority, Instant createdAt) {
        if (id <= 0) {
            throw new InvalidTodoException("id 必須是正整數，收到：" + id);
        }
        this.id = id;
        this.createdAt = Objects.requireNonNull(createdAt, "createdAt 不可為 null");
        this.priority = Objects.requireNonNull(priority, "priority 不可為 null");
        setTitle(title);      // 走同一套驗證，不要在建構子重複寫
    }

    // ── 行為方法（第 02 章 2.9 節：不要只給 setter） ──

    /** 標記完成。已完成再標記會丟例外——冪等性交由 Service 層決定（11.2 節）。 */
    public void markDone(Instant at) {
        if (done) {
            throw new TodoAlreadyDoneException(id);
        }
        this.done = true;
        this.completedAt = Objects.requireNonNull(at, "完成時間不可為 null");
    }

    public void setTitle(String title) {
        String trimmed = title == null ? "" : title.strip();
        if (trimmed.isEmpty()) {
            throw new InvalidTodoException("標題不可為空白");
        }
        if (trimmed.length() > MAX_TITLE_LENGTH) {
            throw new InvalidTodoException(
                    "標題不可超過 %d 字，收到 %d 字".formatted(MAX_TITLE_LENGTH, trimmed.length()));
        }
        this.title = trimmed;
    }

    public void changePriority(Priority priority) {
        this.priority = Objects.requireNonNull(priority, "priority 不可為 null");
    }

    public void addTag(String tag) {
        String trimmed = tag == null ? "" : tag.strip().toLowerCase();
        if (trimmed.isEmpty()) {
            throw new InvalidTodoException("標籤不可為空白");
        }
        if (!tags.contains(trimmed) && tags.size() >= MAX_TAGS) {
            throw new InvalidTodoException("標籤最多 " + MAX_TAGS + " 個");
        }
        tags.add(trimmed);
    }

    // ── 查詢 ──

    public long id() {
        return id;
    }

    public String title() {
        return title;
    }

    public Priority priority() {
        return priority;
    }

    public boolean isDone() {
        return done;
    }

    public Instant createdAt() {
        return createdAt;
    }

    /** 未完成時為 null。第 12 章會改成 Optional 或 record + sealed。 */
    public Instant completedAt() {
        return completedAt;
    }

    /** 防禦性複製（第 02 章 2.12 節）：外部拿不到內部集合的參考 */
    public Set<String> tags() {
        return Set.copyOf(tags);
    }

    @Override
    public boolean equals(Object o) {
        if (this == o) {
            return true;
        }
        return o instanceof Todo other && id == other.id;
    }

    @Override
    public int hashCode() {
        return Long.hashCode(id);
    }

    @Override
    public String toString() {
        return "Todo[id=%d, title=%s, priority=%s, done=%s]".formatted(id, title, priority, done);
    }
}
```

**例外體系**（第 04 章）

```java
package com.example.todo.exception;

/** 錯誤碼。每個都對應一個明確的使用者可見訊息（第 04 章 4.8 節）。 */
public enum ErrorCode {

    TODO_NOT_FOUND("TODO-404", "找不到指定的待辦事項"),
    TODO_ALREADY_DONE("TODO-409", "此待辦事項已經完成"),
    INVALID_TODO("TODO-400", "待辦事項資料不合法"),
    STORAGE_FAILURE("TODO-500", "儲存失敗");

    private final String code;
    private final String defaultMessage;

    ErrorCode(String code, String defaultMessage) {
        this.code = code;
        this.defaultMessage = defaultMessage;
    }

    public String code() {
        return code;
    }

    public String defaultMessage() {
        return defaultMessage;
    }
}
```

```java
package com.example.todo.exception;

/** 所有業務例外的基底。unchecked——呼叫方通常無法在當場處理（第 04 章 4.5 節）。 */
public abstract class TodoException extends RuntimeException {

    private final ErrorCode errorCode;

    protected TodoException(ErrorCode errorCode, String message) {
        super(message);
        this.errorCode = errorCode;
    }

    protected TodoException(ErrorCode errorCode, String message, Throwable cause) {
        super(message, cause);
        this.errorCode = errorCode;
    }

    public ErrorCode errorCode() {
        return errorCode;
    }
}
```

```java
package com.example.todo.exception;

public class TodoNotFoundException extends TodoException {
    public TodoNotFoundException(long id) {
        super(ErrorCode.TODO_NOT_FOUND, "找不到 id 為 " + id + " 的待辦事項");
    }
}
```

```java
package com.example.todo.exception;

public class TodoAlreadyDoneException extends TodoException {
    public TodoAlreadyDoneException(long id) {
        super(ErrorCode.TODO_ALREADY_DONE, "待辦事項 " + id + " 已經完成了");
    }
}
```

```java
package com.example.todo.exception;

public class InvalidTodoException extends TodoException {
    public InvalidTodoException(String message) {
        super(ErrorCode.INVALID_TODO, message);
    }
}
```

**`TodoRepository.java`**（第 03 章抽出的介面）

```java
package com.example.todo.repository;

import com.example.todo.model.Todo;

import java.util.List;
import java.util.Optional;

public interface TodoRepository {

    /** 儲存（新增或更新）。回傳存好的實體。 */
    Todo save(Todo todo);

    Optional<Todo> findById(long id);

    List<Todo> findAll();

    /** @return true 表示真的刪掉了；false 表示本來就不存在 */
    boolean deleteById(long id);

    /** 產生下一個可用的 id */
    long nextId();
}
```

**`Notifier.java`**（第 03 章）

```java
package com.example.todo.service;

import com.example.todo.model.Todo;

/** 事件通知。實作可以是 console、email、webhook…（第 03 章 3.10 節） */
public interface Notifier {

    void notifyCreated(Todo todo);

    void notifyDone(Todo todo);
}
```

**`TodoService.java`**（第 07 章 + 本章補上 `Notifier`）

```java
package com.example.todo.service;

import com.example.todo.exception.TodoNotFoundException;
import com.example.todo.model.Priority;
import com.example.todo.model.Todo;
import com.example.todo.repository.TodoRepository;

import java.time.Clock;
import java.util.Comparator;
import java.util.List;
import java.util.Objects;

public class TodoService {

    private final TodoRepository repository;
    private final Clock clock;
    private final Notifier notifier;

    public TodoService(TodoRepository repository, Clock clock, Notifier notifier) {
        this.repository = Objects.requireNonNull(repository, "repository");
        this.clock = Objects.requireNonNull(clock, "clock");
        this.notifier = Objects.requireNonNull(notifier, "notifier");
    }

    public Todo add(String title, Priority priority) {
        Todo todo = new Todo(repository.nextId(), title, priority, clock.instant());
        Todo saved = repository.save(todo);
        notifier.notifyCreated(saved);
        return saved;
    }

    /** 標記完成。已完成時是冪等的：不噴錯、不重複儲存、不重複通知（11.2 節） */
    public Todo markDone(long id) {
        Todo todo = repository.findById(id)
                .orElseThrow(() -> new TodoNotFoundException(id));
        if (todo.isDone()) {
            return todo;
        }
        todo.markDone(clock.instant());
        Todo saved = repository.save(todo);
        notifier.notifyDone(saved);
        return saved;
    }

    public void remove(long id) {
        if (!repository.deleteById(id)) {
            throw new TodoNotFoundException(id);
        }
    }

    /** 全部，依「未完成優先 → 優先度高的優先 → 建立時間早的優先」排序 */
    public List<Todo> findAll() {
        return repository.findAll().stream()
                .sorted(Comparator.comparing(Todo::isDone)
                        .thenComparing(t -> -t.priority().weight())
                        .thenComparing(Todo::createdAt))
                .toList();
    }

    public List<Todo> findPending() {
        return findAll().stream().filter(t -> !t.isDone()).toList();
    }
}
```

> ⚠️ **第 10 章的 `App.buildService()` 要跟著補一個參數**，否則編不過：
>
> ```java
> return new TodoService(
>         new JsonFileTodoRepository(dataFile, new Json()),
>         Clock.systemDefaultZone(),
>         new ConsoleNotifier());          // ← 新增
> ```
>
> 搭配一個最小的實作：
>
> ```java
> package com.example.todo.service;
>
> import com.example.todo.model.Todo;
>
> /** 把事件印到 stderr。stdout 要留給資料（第 10 章 10.18 節的 CLI 禮儀）。 */
> public class ConsoleNotifier implements Notifier {
>
>     @Override
>     public void notifyCreated(Todo todo) {
>         System.err.printf("[通知] 已建立 #%d %s%n", todo.id(), todo.title());
>     }
>
>     @Override
>     public void notifyDone(Todo todo) {
>         System.err.printf("[通知] 已完成 #%d %s%n", todo.id(), todo.title());
>     }
> }
> ```

### 第一個測試

檔案放在 `src/test/java`，**套件路徑要和受測類別一致**
（這樣測試才能存取 package-private 的成員）：

```
todo-model/
├── src/main/java/com/example/todo/model/Todo.java
└── src/test/java/com/example/todo/model/TodoTest.java      ← 同一個套件
```

```java
package com.example.todo.model;

import com.example.todo.exception.InvalidTodoException;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.time.Instant;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

@DisplayName("Todo")
class TodoTest {

    private static final Instant NOW = Instant.parse("2026-08-17T10:00:00Z");

    @Test
    @DisplayName("建立時會保留 id、標題、優先度與建立時間")
    void createsWithGivenValues() {
        Todo todo = new Todo(1L, "買牛奶", Priority.HIGH, NOW);

        assertThat(todo.id()).isEqualTo(1L);
        assertThat(todo.title()).isEqualTo("買牛奶");
        assertThat(todo.priority()).isEqualTo(Priority.HIGH);
        assertThat(todo.createdAt()).isEqualTo(NOW);
        assertThat(todo.isDone()).isFalse();
        assertThat(todo.completedAt()).isNull();
        assertThat(todo.tags()).isEmpty();
    }

    @Test
    @DisplayName("標題前後空白會被去掉")
    void stripsTitle() {
        Todo todo = new Todo(1L, "  買牛奶  ", Priority.LOW, NOW);

        assertThat(todo.title()).isEqualTo("買牛奶");
    }

    @Test
    @DisplayName("標題只有空白時拒絕建立")
    void rejectsBlankTitle() {
        assertThatThrownBy(() -> new Todo(1L, "   ", Priority.LOW, NOW))
                .isInstanceOf(InvalidTodoException.class)
                .hasMessageContaining("標題不可為空白");
    }
}
```

執行：

```bash
./mvnw -pl todo-model test
```

```
[INFO] --- surefire:3.5.0:test (default-test) @ todo-model ---
[INFO] Using auto detected provider org.apache.maven.surefire.junitplatform.JUnitPlatformProvider
[INFO]
[INFO] -------------------------------------------------------
[INFO]  T E S T S
[INFO] -------------------------------------------------------
[INFO] Running com.example.todo.model.TodoTest
[INFO] Tests run: 3, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.089 s
    -- in com.example.todo.model.TodoTest
[INFO]
[INFO] Results:
[INFO]
[INFO] Tests run: 3, Failures: 0, Errors: 0, Skipped: 0
[INFO]
[INFO] BUILD SUCCESS
```

### 測試類別的三個慣例

| 慣例 | 為什麼 |
|---|---|
| 類別不加 `public` | JUnit 5 不需要（JUnit 4 需要）。少一個修飾子，少一個雜訊 |
| 測試方法不加 `public` | 同上。用 package-private（什麼都不寫） |
| 類別名 = 受測類別名 + `Test` | surefire 的預設 include 模式（第 10 章 10.10 節）。也讓 IDE 能一鍵跳轉 |

> ⚠️ **測試方法不能是 `static`、不能有回傳值**（`@TestFactory` 除外）。
> 寫成 `static void shouldWork()` 的話 JUnit 會噴：
> `@Test method must not be static`。

### 讓失敗訊息有用

故意寫一個會失敗的測試，看看訊息長什麼樣：

```java
@Test
void failOnPurpose() {
    Todo todo = new Todo(1L, "買牛奶", Priority.HIGH, NOW);

    assertThat(todo.title()).isEqualTo("買醬油");
}
```

```
[ERROR] TodoTest.failOnPurpose:52
expected: "買醬油"
 but was: "買牛奶"
```

**這就是好的失敗訊息**：不用打開程式碼就知道哪裡不對。
下一節會看到，同樣的斷言用不同寫法，失敗訊息的品質差很多。

---

## 11.5 生命週期與註解全覽

### 執行順序

```java
package com.example.todo;

import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

class LifecycleDemoTest {

    LifecycleDemoTest() {
        System.out.println("  建構子");
    }

    @BeforeAll
    static void beforeAll() {
        System.out.println("@BeforeAll（整個類別一次，必須 static）");
    }

    @BeforeEach
    void beforeEach() {
        System.out.println("  @BeforeEach");
    }

    @Test
    void testA() {
        System.out.println("    testA");
    }

    @Test
    void testB() {
        System.out.println("    testB");
    }

    @AfterEach
    void afterEach() {
        System.out.println("  @AfterEach");
    }

    @AfterAll
    static void afterAll() {
        System.out.println("@AfterAll（整個類別一次，必須 static）");
    }
}
```

輸出：

```
@BeforeAll（整個類別一次，必須 static）
  建構子
  @BeforeEach
    testA
  @AfterEach
  建構子                    ← 注意：又建立了一次！
  @BeforeEach
    testB
  @AfterEach
@AfterAll（整個類別一次，必須 static）
```

### 🔑 每個測試都是一個新的實例

**這是 JUnit 最重要也最常被誤解的設計。** 預設的 `TestInstance.Lifecycle.PER_METHOD`
表示：**每個 `@Test` 方法執行前，JUnit 都會 `new` 一個新的測試類別實例。**

為什麼？**為了測試隔離。** 這樣一來：

```java
class CounterTest {

    // 每個測試都拿到一個新的、空的 list
    private final List<String> log = new ArrayList<>();

    @Test
    void testA() {
        log.add("a");
        assertThat(log).hasSize(1);      // ✅
    }

    @Test
    void testB() {
        log.add("b");
        assertThat(log).hasSize(1);      // ✅ 不是 2！testA 的 "a" 不在這裡
    }
}
```

**這也是為什麼 `@BeforeAll` 必須是 `static`**——它在任何實例存在之前就要執行，
所以不可能存取實例欄位。

想改成「整個類別共用一個實例」：

```java
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class ExpensiveSetupTest {

    // 現在 @BeforeAll 可以不是 static，也能存取實例欄位
    private Database db;

    @BeforeAll
    void setUp() {
        db = Database.connect();     // 只做一次
    }

    @AfterAll
    void tearDown() {
        db.close();
    }
}
```

> ⚠️ **`PER_CLASS` 要非常小心。** 一旦共用實例，測試之間就會透過欄位互相影響，
> 執行順序會變得重要——這是 flaky test 的頭號來源（11.18 節）。
>
> **只在「建立成本真的很高」時用**（DB 連線、啟動容器、載入大檔案），
> 而且要確保共用的東西是**不可變的**或**每個測試會重設**。

### 註解全覽

| 註解 | 用途 | 注意 |
|---|---|---|
| `@Test` | 標記測試方法 | 不能 `static`、不能有回傳值 |
| `@BeforeEach` / `@AfterEach` | 每個測試前 / 後 | 用來準備 / 清理**每個測試各自的**狀態 |
| `@BeforeAll` / `@AfterAll` | 類別的第一次 / 最後一次 | 預設必須 `static` |
| `@DisplayName` | 給人看的名字 | 支援中文、空白、emoji |
| `@Nested` | 巢狀測試類別 | 必須是**非 static 的內部類別**。11.7 節 |
| `@Disabled("理由")` | 暫時跳過 | **一定要寫理由**，否則三個月後沒人知道能不能開回來 |
| `@Tag("slow")` | 分類，用於篩選執行 | 11.17 節的整合測試分流 |
| `@Timeout(5)` | 超時就失敗 | 抓「不小心寫出無限迴圈」與死鎖 |
| `@RepeatedTest(100)` | 重複執行 | 抓併發競態（11.15 節） |
| `@ParameterizedTest` | 參數化 | 11.8 節 |
| `@TestFactory` | 動態產生測試 | 回傳 `DynamicTest` 的集合，較少用 |
| `@TestMethodOrder` | 指定方法順序 | **通常是設計問題的訊號**，見下方 |
| `@ExtendWith` | 掛擴充（Mockito、Spring） | 11.11 節 |
| `@RegisterExtension` | 用欄位掛擴充（可帶設定） | 需要傳參數給 extension 時用 |
| `@TempDir` | 注入臨時目錄 | 11.13 節 |
| `@EnabledOnOs(MAC)` / `@DisabledOnOs` | 依 OS 條件執行 | 檔案路徑、換行符相關的測試 |
| `@EnabledIfSystemProperty` / `@EnabledIfEnvironmentVariable` | 依環境條件 | 「只在 CI 上跑」 |

### 幾個實務要點

**① `@Disabled` 一定要寫理由，而且要有到期日**

```java
// ❌ 三個月後沒人知道這是什麼
@Disabled
@Test
void syncsWithRemote() { }

// ✅
@Disabled("等 payment-gateway 的 sandbox 修好（PAY-1423，預計 2026-09 前）")
@Test
void syncsWithRemote() { }
```

被 `@Disabled` 的測試會在報告裡顯示 `Skipped`，很容易被忽略。
**建議在 CI 加一條檢查：`@Disabled` 超過 N 個就警告。**
一個永遠被跳過的測試，比沒有測試更糟——它給了你虛假的安全感。

**② `@Timeout` 值得預設加在整個專案**

```java
// 在測試類別上，或用 junit-platform.properties 全域設定
@Timeout(value = 5, unit = TimeUnit.SECONDS)
class TodoServiceTest { }
```

或在 `src/test/resources/junit-platform.properties` 全域設定：

```properties
# 每個測試方法最多 5 秒
junit.jupiter.execution.timeout.testable.method.default = 5 s
# @BeforeAll / @AfterAll 最多 30 秒（可能要起容器）
junit.jupiter.execution.timeout.lifecycle.method.default = 30 s
```

理由：沒有 timeout 的話，一個死鎖的測試會讓 CI 卡到 job timeout（可能 60 分鐘）
才失敗，而且錯誤訊息只有「job cancelled」。有 timeout 就會明確告訴你
`TodoServiceTest.importsAll() timed out after 5 seconds`。

**③ `@TestMethodOrder` 幾乎都是設計問題的訊號**

```java
// ⚠️ 看到這個要警覺
@TestMethodOrder(MethodOrderer.OrderAnnotation.class)
class BadTest {

    static long createdId;      // 測試之間傳遞狀態

    @Test @Order(1)
    void createsTodo() {
        createdId = service.add("買牛奶", Priority.LOW).id();
    }

    @Test @Order(2)
    void marksDone() {
        service.markDone(createdId);     // 依賴前一個測試
    }
}
```

問題：
- `marksDone` 單獨執行會失敗（`createdId` 是 0）——你不能只跑一個測試來除錯。
- 平行執行會壞掉。
- `createsTodo` 失敗時，`marksDone` 也失敗，但原因完全不明。

**正解**：每個測試自己準備自己需要的狀態。

```java
@Test
void marksDone() {
    long id = service.add("買牛奶", Priority.LOW).id();     // 自己準備

    service.markDone(id);

    assertThat(service.findAll().get(0).isDone()).isTrue();
}
```

> **唯一合理使用 `@TestMethodOrder` 的場合**：測試「一連串操作的完整流程」
> 且刻意要模擬時間順序（例如狀態機的轉換），並且用 `@Nested` 把它們包在一起
> 以限制影響範圍。即使如此，也要在類別註解上寫清楚為什麼。

---

## 11.6 斷言：從 `assertEquals` 到 AssertJ

### JUnit 內建斷言

```java
import static org.junit.jupiter.api.Assertions.*;

assertEquals(expected, actual);
assertEquals(expected, actual, "自訂失敗訊息");
assertNotEquals(a, b);
assertTrue(condition);
assertFalse(condition);
assertNull(x);
assertNotNull(x);
assertSame(a, b);            // 參考相同（第 01 章 == vs equals）
assertArrayEquals(a, b);
assertIterableEquals(a, b);
assertInstanceOf(Todo.class, x);

// 例外
InvalidTodoException e = assertThrows(InvalidTodoException.class,
        () -> new Todo(1L, "", Priority.LOW, NOW));
assertEquals("標題不可為空白", e.getMessage());

// 一次驗證多個，全部都會執行（不會第一個失敗就停）
assertAll("todo",
        () -> assertEquals(1L, todo.id()),
        () -> assertEquals("買牛奶", todo.title()),
        () -> assertFalse(todo.isDone()));

// 超時
assertTimeout(Duration.ofSeconds(1), () -> service.findAll());
assertTimeoutPreemptively(Duration.ofSeconds(1), () -> service.findAll());
```

> **`assertTimeout` vs `assertTimeoutPreemptively`**
> 前者**等它跑完**再判斷有沒有超時（所以無限迴圈會卡死）。
> 後者在**另一條執行緒**跑，超時就中斷。
> 但後者有陷阱：在另一條執行緒執行會讓 `ThreadLocal`（第 08 章 8.13 節）失效，
> Spring 的交易、`SecurityContext` 都會拿不到。
> **通常用 `@Timeout` 註解就好，別用這兩個。**

### 為什麼要換成 AssertJ

同一件事，三種寫法：

```java
List<Todo> todos = service.findPending();

// ① JUnit 內建
assertEquals(2, todos.size());
assertEquals("買牛奶", todos.get(0).title());
assertEquals("寫測試", todos.get(1).title());

// ② JUnit + 迴圈（更難讀）
assertTrue(todos.stream().anyMatch(t -> t.title().equals("買牛奶")));

// ③ AssertJ
assertThat(todos)
        .hasSize(2)
        .extracting(Todo::title)
        .containsExactly("買牛奶", "寫測試");
```

差別不只是好看。看失敗訊息：

```java
// ① 失敗訊息
org.opentest4j.AssertionFailedError:
expected: <2> but was: <3>
```

「3 個？哪 3 個？多的是誰？」——你要打開 debugger。

```java
// ③ 失敗訊息
java.lang.AssertionError:
Expected size: 2 but was: 3 in:
[Todo[id=1, title=買牛奶, priority=HIGH, done=false],
 Todo[id=2, title=寫測試, priority=MEDIUM, done=false],
 Todo[id=3, title=買醬油, priority=LOW, done=false]]
```

**多的那個是 `買醬油`。** 不用開 debugger。

> 這就是為什麼幾乎所有 Java 團隊都用 AssertJ 而不是內建斷言：
> **失敗訊息的資訊量**。測試失敗的那一刻，訊息品質就是你的除錯速度。

還有一個實務理由：**IDE 自動補全**。
`assertThat(todos).` 之後按下 `.`，IDE 會列出所有對 `List` 有意義的斷言
（`hasSize`、`contains`、`isSorted`⋯）。內建斷言你得先想起函式名。

### AssertJ 常用斷言

**基本型別與物件**

```java
import static org.assertj.core.api.Assertions.*;

assertThat(todo.title()).isEqualTo("買牛奶");
assertThat(todo.title()).isNotBlank()
                        .startsWith("買")
                        .hasSize(3)
                        .containsIgnoringCase("牛");

assertThat(todo.isDone()).isFalse();
assertThat(todo.completedAt()).isNull();
assertThat(todo).isNotNull().isInstanceOf(Todo.class);

// 數值
assertThat(count).isEqualTo(3)
                 .isPositive()
                 .isBetween(1, 5)
                 .isGreaterThan(2);

// 浮點數要用容差（第 01 章 1.6 節：不要用 == 比 double）
assertThat(average).isCloseTo(2.5, within(0.001));
assertThat(average).isCloseTo(2.5, withPercentage(1.0));

// BigDecimal 的坑：0.1 和 0.10 用 isEqualTo 會失敗（scale 不同）
assertThat(price).isEqualByComparingTo("0.10");     // ✅ 用 compareTo 語意
```

**集合**

```java
List<Todo> todos = service.findAll();

assertThat(todos).hasSize(3)
                 .isNotEmpty()
                 .doesNotContainNull();

// 順序重要
assertThat(todos).extracting(Todo::id).containsExactly(1L, 2L, 3L);
// 順序不重要
assertThat(todos).extracting(Todo::id).containsExactlyInAnyOrder(3L, 1L, 2L);
// 只要包含（可以有其他）
assertThat(todos).extracting(Todo::title).contains("買牛奶");
// 一定不包含
assertThat(todos).extracting(Todo::title).doesNotContain("買醬油");

// 抽多個欄位，用 tuple
assertThat(todos)
        .extracting(Todo::id, Todo::title, Todo::priority)
        .containsExactly(
                tuple(1L, "買牛奶", Priority.HIGH),
                tuple(2L, "寫測試", Priority.MEDIUM));

// 每個元素都要滿足
assertThat(todos).allSatisfy(t -> {
    assertThat(t.id()).isPositive();
    assertThat(t.title()).isNotBlank();
});
assertThat(todos).allMatch(t -> !t.isDone());
assertThat(todos).anySatisfy(t -> assertThat(t.priority()).isEqualTo(Priority.HIGH));
assertThat(todos).noneMatch(Todo::isDone);

// 過濾再斷言
assertThat(todos)
        .filteredOn(t -> t.priority() == Priority.HIGH)
        .hasSize(1)
        .extracting(Todo::title)
        .containsExactly("買牛奶");

// 排序
assertThat(todos).extracting(Todo::createdAt).isSorted();
assertThat(todos).isSortedAccordingTo(Comparator.comparing(Todo::id));
```

**Map**

```java
Map<Priority, Long> counts = statistics.countByPriority();

assertThat(counts).hasSize(3)
                  .containsEntry(Priority.HIGH, 1L)
                  .containsKeys(Priority.HIGH, Priority.MEDIUM)
                  .doesNotContainKey(null)
                  .containsExactlyInAnyOrderEntriesOf(
                          Map.of(Priority.HIGH, 1L, Priority.MEDIUM, 2L, Priority.LOW, 0L));
```

**Optional**

```java
assertThat(repository.findById(1L)).isPresent()
                                   .get()
                                   .extracting(Todo::title)
                                   .isEqualTo("買牛奶");

assertThat(repository.findById(999L)).isEmpty();

// 更直接
assertThat(repository.findById(1L)).hasValueSatisfying(
        t -> assertThat(t.title()).isEqualTo("買牛奶"));
```

**例外**

```java
// 寫法 1：最常用
assertThatThrownBy(() -> service.markDone(999L))
        .isInstanceOf(TodoNotFoundException.class)
        .hasMessageContaining("999")
        .extracting(e -> ((TodoException) e).errorCode())
        .isEqualTo(ErrorCode.TODO_NOT_FOUND);

// 寫法 2：型別放在前面，讀起來更像英文
assertThatExceptionOfType(InvalidTodoException.class)
        .isThrownBy(() -> new Todo(1L, "", Priority.LOW, NOW))
        .withMessageContaining("標題不可為空白")
        .withNoCause();

// 寫法 3：驗證「不該丟例外」
assertThatNoException().isThrownBy(() -> service.markDone(1L));

// 驗證包裝的原因（第 04 章 4.7 節：不要吞掉 cause）
assertThatThrownBy(() -> store.save(todos))
        .isInstanceOf(StorageException.class)
        .hasCauseInstanceOf(IOException.class)
        .rootCause()
        .hasMessageContaining("No space left on device");
```

> ⚠️ **不要斷言例外訊息的完整字串。**
>
> ```java
> // ❌ 脆弱：改一個標點符號，測試就紅
> .hasMessage("找不到 id 為 999 的待辦事項")
>
> // ✅ 斷言「關鍵資訊有出現」
> .hasMessageContaining("999")
>
> // ✅✅ 更好：斷言結構化的錯誤碼，訊息怎麼改都不影響
> .extracting(e -> ((TodoException) e).errorCode()).isEqualTo(ErrorCode.TODO_NOT_FOUND)
> ```
>
> 這正是第 04 章 4.8 節設計 `ErrorCode` enum 的回報之一：
> **訊息是給人看的（可以改），錯誤碼是給程式看的（是契約）。**

**遞迴比較（比較整個物件，不用逐欄位寫）**

```java
Todo expected = new Todo(1L, "買牛奶", Priority.HIGH, NOW);

// 逐欄位比較（用反射），不需要 equals
assertThat(actual).usingRecursiveComparison().isEqualTo(expected);

// 忽略某些欄位（例如自動產生的 id、時間戳）
assertThat(actual).usingRecursiveComparison()
                  .ignoringFields("id", "createdAt")
                  .isEqualTo(expected);

// 只比較某些欄位
assertThat(actual).usingRecursiveComparison()
                  .comparingOnlyFields("title", "priority")
                  .isEqualTo(expected);
```

**`usingRecursiveComparison` 為什麼重要**：我們的 `Todo` 的 `equals` 只比 `id`
（第 02 章的實體語意）。所以 `assertThat(actual).isEqualTo(expected)`
即使標題完全不同也會通過！

```java
Todo a = new Todo(1L, "買牛奶", Priority.HIGH, NOW);
Todo b = new Todo(1L, "完全不同", Priority.LOW, NOW);

assertThat(a).isEqualTo(b);                          // ✅ 通過（只比 id）
assertThat(a).usingRecursiveComparison().isEqualTo(b);  // ❌ 失敗（逐欄位比）
```

```
java.lang.AssertionError:
Expecting actual:
  Todo[id=1, title=買牛奶, priority=HIGH, done=false]
to be equal to:
  Todo[id=1, title=完全不同, priority=LOW, done=false]
when recursively comparing field by field, but found the following 2 differences:

field/property 'priority' differ:
- actual value  : HIGH
- expected value: LOW

field/property 'title' differ:
- actual value  : "買牛奶"
- expected value: "完全不同"
```

**這是 `equals` 只比 id 的實體類別的必備工具。** 不知道它的人會寫出
「永遠通過的測試」——最危險的那種測試。

### Soft assertions：一次看到所有失敗

預設情況下，第一個斷言失敗就停止，你只看到第一個問題：

```java
@Test
void hardAssertions() {
    Todo todo = new Todo(1L, "買牛奶", Priority.HIGH, NOW);

    assertThat(todo.title()).isEqualTo("買醬油");    // ❌ 這裡就停了
    assertThat(todo.priority()).isEqualTo(Priority.LOW);   // 沒執行
    assertThat(todo.isDone()).isTrue();                    // 沒執行
}
```

用 soft assertions 一次看完：

```java
@Test
void softAssertions() {
    Todo todo = new Todo(1L, "買牛奶", Priority.HIGH, NOW);

    assertSoftly(softly -> {
        softly.assertThat(todo.title()).isEqualTo("買醬油");
        softly.assertThat(todo.priority()).isEqualTo(Priority.LOW);
        softly.assertThat(todo.isDone()).isTrue();
    });
}
```

```
org.assertj.core.api.SoftAssertionError:
The following 3 assertions failed:
1) expected: "買醬油" but was: "買牛奶"
2) expected: LOW but was: HIGH
3) Expecting value to be true but was false
```

**什麼時候用 soft**：驗證一個物件的多個獨立屬性時。
一次看到全部，除錯一輪就夠，不用「修一個、跑一次、看下一個」。

**什麼時候別用 soft**：斷言之間有依賴時。

```java
// ❌ 錯用：第一個失敗（list 是空的）之後，第二行會 IndexOutOfBoundsException
assertSoftly(softly -> {
    softly.assertThat(todos).hasSize(1);
    softly.assertThat(todos.get(0).title()).isEqualTo("買牛奶");   // 💥
});
```

這種情況要用一般（hard）斷言，或用 `assertThat(todos).singleElement()`：

```java
assertThat(todos).singleElement()
                 .extracting(Todo::title)
                 .isEqualTo("買牛奶");
```

### 給斷言加上描述

當一個測試裡有多個相似的斷言，失敗時分不清是哪一個：

```java
assertThat(pending).as("未完成清單").hasSize(2);
assertThat(done).as("已完成清單").hasSize(1);

// 支援格式化
assertThat(todo.title()).as("todo #%d 的標題", todo.id()).isEqualTo("買牛奶");
```

```
[todo #1 的標題]
expected: "買牛奶"
 but was: "買醬油"
```

> ⚠️ **`as()` 必須寫在斷言之前**（它回傳的是同一個 assert 物件，設定描述）。
> 寫在後面（`isEqualTo(...).as(...)`）不會有效果——那時斷言已經執行完了。

### 自訂斷言：讓領域語言進入測試

當同一組斷言重複出現超過三次，就該抽出來：

```java
package com.example.todo.model;

import org.assertj.core.api.AbstractAssert;

import java.time.Instant;

/** Todo 的專屬斷言。用 TodoAssert.assertThat(todo) 開始。 */
public class TodoAssert extends AbstractAssert<TodoAssert, Todo> {

    private TodoAssert(Todo actual) {
        super(actual, TodoAssert.class);
    }

    public static TodoAssert assertThat(Todo actual) {
        return new TodoAssert(actual);
    }

    public TodoAssert isPending() {
        isNotNull();
        if (actual.isDone()) {
            failWithMessage("預期 <%s> 是未完成，但它已完成於 <%s>",
                    actual.title(), actual.completedAt());
        }
        return this;
    }

    public TodoAssert isDoneAt(Instant expected) {
        isNotNull();
        if (!actual.isDone()) {
            failWithMessage("預期 <%s> 已完成，但它還是未完成", actual.title());
        }
        if (!expected.equals(actual.completedAt())) {
            failWithMessage("預期 <%s> 的完成時間是 <%s>，實際是 <%s>",
                    actual.title(), expected, actual.completedAt());
        }
        return this;
    }

    public TodoAssert hasTags(String... expected) {
        isNotNull();
        org.assertj.core.api.Assertions.assertThat(actual.tags())
                .as("todo <%s> 的標籤", actual.title())
                .containsExactlyInAnyOrder(expected);
        return this;
    }
}
```

用起來：

```java
import static com.example.todo.model.TodoAssert.assertThat;

@Test
void marksDone() {
    Todo todo = new Todo(1L, "買牛奶", Priority.HIGH, NOW);

    todo.markDone(NOW.plusSeconds(3600));

    assertThat(todo).isDoneAt(NOW.plusSeconds(3600));
}
```

**價值**：測試讀起來像規格書（`assertThat(todo).isPending()`），
而且失敗訊息是**領域語言**（「預期買牛奶是未完成，但它已完成於⋯」）
而不是技術語言（「expected false but was true」）。

> ⚠️ 自訂斷言的類別要放在 **`src/test/java`**（除非你要發佈測試工具給別人用）。
> 放進 `src/main/java` 會讓產品程式碼依賴 AssertJ——第 10 章 10.7 節的問題。

---

## 11.7 測試命名與結構

### 一個測試的三段結構

```java
@Test
void marksDoneAndNotifies() {
    // ── Arrange（準備）：建立受測物件與輸入 ──
    Todo todo = new Todo(1L, "買牛奶", Priority.MEDIUM, NOW);
    given(repository.findById(1L)).willReturn(Optional.of(todo));

    // ── Act（執行）：呼叫受測的那一個方法 ──
    Todo result = service.markDone(1L);

    // ── Assert（驗證）：檢查結果與副作用 ──
    assertThat(result.isDone()).isTrue();
    verify(notifier).notifyDone(todo);
}
```

這叫 **AAA**（Arrange-Act-Assert），或 BDD 風格的 **Given-When-Then**。
名字不重要，重要的是：

> **每個測試只有一個 Act。**

如果你的測試有兩個「執行」步驟，它就在測兩件事。
失敗時你不知道是哪一個壞了，而且其中一個壞掉會遮蔽另一個。

**用空行分隔三段。** 不需要寫 `// Arrange` 註解——
空行已經表達了結構，註解只是雜訊。真正需要註解的是「為什麼要這樣準備」。

### 測試方法命名

三種主流風格：

```java
// ① 行為描述式（推薦，最像規格）
void marksDoneAndNotifies()
void rejectsBlankTitle()
void returnsEmptyListWhenNoTodos()

// ② should_X_when_Y（囉唆但明確）
void shouldMarkDoneAndNotify()
void shouldRejectBlankTitle_whenTitleIsOnlyWhitespace()

// ③ 方法_情境_預期（單元測試的老派寫法）
void markDone_alreadyDone_isIdempotent()
void setTitle_blankInput_throwsInvalidTodoException()
```

**選一種，全專案統一。** 我在這個課程用 ①，並搭配 `@DisplayName` 寫中文。

**判斷一個測試名字好不好的標準**：

> 只看名字（不看程式碼），你能不能說出「這個測試在驗證什麼規則」？

```java
// ❌ 看不出來在測什麼
void test1()
void testMarkDone()
void markDoneTest()
void testMarkDoneWorks()

// ✅ 名字就是規格
void marksDoneAndSetsCompletedAt()
void isIdempotentWhenAlreadyDone()
void throwsNotFoundWhenIdDoesNotExist()
```

### `@DisplayName`：讓報告變成規格書

```java
@DisplayName("TodoService")
class TodoServiceTest {

    @Test
    @DisplayName("新增事項時會產生 id、記錄建立時間、並發出通知")
    void addsWithIdAndNotifies() { }
}
```

IDE 與測試報告會顯示：

```
TodoService
  ✓ 新增事項時會產生 id、記錄建立時間、並發出通知
```

不想每個方法都寫 `@DisplayName`？用產生器自動把底線換成空白：

```java
@DisplayNameGeneration(DisplayNameGenerator.ReplaceUnderscores.class)
class TodoServiceTest {

    @Test
    void adds_todo_with_generated_id() { }      // → "adds todo with generated id"
}
```

或全域設定（`src/test/resources/junit-platform.properties`）：

```properties
junit.jupiter.displayname.generator.default = \
  org.junit.jupiter.api.DisplayNameGenerator$ReplaceUnderscores
```

> **我的建議**：**用中文 `@DisplayName`**，方法名用英文。
> 理由：中文的表達密度高得多，一行就能寫清楚規則。
> 而方法名保持英文，因為它會出現在堆疊追蹤、CI 的失敗清單、
> `-Dtest=xxx` 的參數裡——那些地方中文會很難處理。

### `@Nested`：用結構表達層次

一個 `TodoService` 有五個方法，每個方法有 3～5 個測試。
平舖直敘的 20 個測試方法很難導航。用 `@Nested` 分組：

```java
package com.example.todo.service;

import com.example.todo.exception.TodoNotFoundException;
import com.example.todo.model.Priority;
import com.example.todo.model.Todo;
import com.example.todo.repository.TodoRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatNoException;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.BDDMockito.given;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;

@ExtendWith(MockitoExtension.class)
@DisplayName("TodoService")
class TodoServiceTest {

    private static final Instant NOW = Instant.parse("2026-08-17T10:00:00Z");

    @Mock
    TodoRepository repository;

    @Mock
    Notifier notifier;

    TodoService service;

    @BeforeEach
    void setUp() {
        // 固定時鐘：讓時間變成可預測的輸入（11.13 節）
        Clock fixed = Clock.fixed(NOW, ZoneOffset.UTC);
        service = new TodoService(repository, fixed, notifier);
    }

    // ══════════════════════════════════════════════════════════
    @Nested
    @DisplayName("add")
    class Add {

        @Test
        @DisplayName("用 repository 產生的 id 與固定時鐘的時間建立事項")
        void createsWithGeneratedIdAndClockTime() {
            given(repository.nextId()).willReturn(42L);
            given(repository.save(any(Todo.class))).willAnswer(inv -> inv.getArgument(0));

            Todo created = service.add("買牛奶", Priority.HIGH);

            assertThat(created.id()).isEqualTo(42L);
            assertThat(created.createdAt()).isEqualTo(NOW);
            assertThat(created.title()).isEqualTo("買牛奶");
            verify(notifier).notifyCreated(created);
        }

        @Test
        @DisplayName("標題不合法時不會儲存、也不會通知")
        void doesNotSaveWhenTitleInvalid() {
            given(repository.nextId()).willReturn(42L);

            assertThatThrownBy(() -> service.add("   ", Priority.HIGH))
                    .isInstanceOf(com.example.todo.exception.InvalidTodoException.class);

            verify(repository, never()).save(any());
            verify(notifier, never()).notifyCreated(any());
        }
    }

    // ══════════════════════════════════════════════════════════
    @Nested
    @DisplayName("markDone")
    class MarkDone {

        @Test
        @DisplayName("標記完成、設定完成時間、儲存並通知")
        void marksDoneAndNotifies() {
            Todo todo = new Todo(1L, "買牛奶", Priority.MEDIUM, NOW.minusSeconds(3600));
            given(repository.findById(1L)).willReturn(Optional.of(todo));
            given(repository.save(todo)).willReturn(todo);

            Todo result = service.markDone(1L);

            assertThat(result.isDone()).isTrue();
            assertThat(result.completedAt()).isEqualTo(NOW);
            verify(repository).save(todo);
            verify(notifier).notifyDone(todo);
        }

        @Test
        @DisplayName("已完成的事項再標記是冪等的：不噴錯、不儲存、不通知")
        void isIdempotentWhenAlreadyDone() {
            Todo done = new Todo(1L, "買牛奶", Priority.MEDIUM, NOW.minusSeconds(7200));
            done.markDone(NOW.minusSeconds(3600));
            given(repository.findById(1L)).willReturn(Optional.of(done));

            assertThatNoException().isThrownBy(() -> service.markDone(1L));

            assertThat(done.completedAt()).isEqualTo(NOW.minusSeconds(3600));   // 沒被改
            verify(repository, never()).save(any());
            verify(notifier, never()).notifyDone(any());
        }

        @Test
        @DisplayName("id 不存在時丟 TodoNotFoundException")
        void throwsWhenNotFound() {
            given(repository.findById(999L)).willReturn(Optional.empty());

            assertThatThrownBy(() -> service.markDone(999L))
                    .isInstanceOf(TodoNotFoundException.class)
                    .hasMessageContaining("999");

            verify(notifier, never()).notifyDone(any());
        }
    }
}
```

測試報告：

```
TodoService
  add
    ✓ 用 repository 產生的 id 與固定時鐘的時間建立事項
    ✓ 標題不合法時不會儲存、也不會通知
  markDone
    ✓ 標記完成、設定完成時間、儲存並通知
    ✓ 已完成的事項再標記是冪等的：不噴錯、不儲存、不通知
    ✓ id 不存在時丟 TodoNotFoundException
```

**這份輸出就是 `TodoService` 的行為規格。** 新人不用讀程式碼，
讀這份清單就知道這個服務保證什麼。

### `@Nested` 的規則與好處

| 規則 | 說明 |
|---|---|
| 必須是**非 static** 內部類別 | `static class` 會被忽略（JUnit 需要外層實例） |
| 可以再嵌套 | 但超過兩層就太深了 |
| 內層可存取外層的欄位 | 這是它比「另開一個測試類別」好的原因 |
| 外層的 `@BeforeEach` 先執行，再執行內層的 | 由外而內，`@AfterEach` 反之 |
| 內層不能有 `@BeforeAll`（除非 `PER_CLASS`） | 因為 `@BeforeAll` 要 static，而內部類別不能有 static 成員初始化⋯⋯Java 16 起可以，但語意仍受限 |

用 `@Nested` 表達「共同前提」是它最大的價值：

```java
@Nested
@DisplayName("當清單已有三筆未完成事項")
class WithThreePendingTodos {

    @BeforeEach
    void seed() {
        // 這個前提只對這一組測試成立
        given(repository.findAll()).willReturn(List.of(
                new Todo(1L, "高", Priority.HIGH, NOW),
                new Todo(2L, "中", Priority.MEDIUM, NOW.plusSeconds(1)),
                new Todo(3L, "低", Priority.LOW, NOW.plusSeconds(2))));
    }

    @Test
    @DisplayName("findAll 依優先度由高到低排序")
    void sortsByPriorityDesc() {
        assertThat(service.findAll())
                .extracting(Todo::title)
                .containsExactly("高", "中", "低");
    }

    @Test
    @DisplayName("findPending 回傳全部三筆")
    void returnsAllThree() {
        assertThat(service.findPending()).hasSize(3);
    }
}
```

比在每個測試裡重複 seed 好，也比放在最外層的 `@BeforeEach` 好
（那會影響到不需要這個前提的測試，且讓每個測試的前提變得不明確）。

---

## 11.8 參數化測試

### 問題：同一段邏輯，十組輸入

`Todo.setTitle()` 的驗證規則有好幾個邊界。笨方法：

```java
@Test void rejectsNull() { assertThatThrownBy(() -> new Todo(1L, null, LOW, NOW))...; }
@Test void rejectsEmpty() { assertThatThrownBy(() -> new Todo(1L, "", LOW, NOW))...; }
@Test void rejectsSpaces() { assertThatThrownBy(() -> new Todo(1L, "   ", LOW, NOW))...; }
@Test void rejectsTab() { assertThatThrownBy(() -> new Todo(1L, "\t", LOW, NOW))...; }
@Test void rejectsNewline() { assertThatThrownBy(() -> new Todo(1L, "\n", LOW, NOW))...; }
// ⋯ 複製貼上五次，改一個字
```

五個測試，五份幾乎一樣的程式碼。加第六個邊界時要再複製一次。

### `@ValueSource`：一個參數

```java
@ParameterizedTest(name = "[{index}] 標題 = <{0}>")
@DisplayName("空白標題會被拒絕")
@ValueSource(strings = {"", " ", "   ", "\t", "\n", "　"})
void rejectsBlankTitle(String title) {
    assertThatThrownBy(() -> new Todo(1L, title, Priority.LOW, NOW))
            .isInstanceOf(InvalidTodoException.class)
            .hasMessageContaining("標題不可為空白");
}
```

輸出：

```
空白標題會被拒絕
  ✓ [1] 標題 = <>
  ✓ [2] 標題 = < >
  ✓ [3] 標題 = <   >
  ✓ [4] 標題 = <	>
  ✓ [5] 標題 = <
>
  ✓ [6] 標題 = <　>
```

**每一組都是獨立的測試**——第 3 組失敗不影響第 4 組執行，
而且報告會明確告訴你是哪一組失敗。

> `　` 是**全形空白**（IDEOGRAPHIC SPACE）。中文輸入法很容易打出來，
> 而 `String.trim()` **不會**去掉它，`String.strip()` 才會（第 07 章 7.3 節）。
> 這一組測試就是在鎖住「我們用的是 `strip()` 不是 `trim()`」這個決定。
> 這是參數化測試的典型價值：**把邊界條件變成一份清單，一眼看得出漏了什麼。**

`@ValueSource` 支援的型別：`shorts`、`bytes`、`ints`、`longs`、`floats`、
`doubles`、`chars`、`booleans`、`strings`、`classes`。
**一次只能用一種，而且只能有一個參數。**

### `null` 與空字串的特別註解

`@ValueSource` **不能傳 `null`**（Java 註解的限制）。所以：

```java
@ParameterizedTest
@NullSource                      // 只傳 null
void rejectsNull(String title) { }

@ParameterizedTest
@EmptySource                     // 傳 ""（或空集合、空陣列，依參數型別）
void rejectsEmpty(String title) { }

@ParameterizedTest
@NullAndEmptySource              // 兩個都傳
@ValueSource(strings = {" ", "\t", "　"})     // 可以疊加！
void rejectsBlankTitle(String title) {
    assertThatThrownBy(() -> new Todo(1L, title, Priority.LOW, NOW))
            .isInstanceOf(InvalidTodoException.class);
}
```

最後那個寫法會產生 5 組：`null`、`""`、`" "`、`"\t"`、`"　"`。
**這是測試「空白輸入」最完整也最簡潔的寫法。**

### `@CsvSource`：多個參數

```java
@ParameterizedTest(name = "{0} 的權重應為 {1}")
@CsvSource({
        "HIGH,   3",
        "MEDIUM, 2",
        "LOW,    1"
})
void hasCorrectWeight(Priority priority, int expectedWeight) {
    assertThat(priority.weight()).isEqualTo(expectedWeight);
}
```

JUnit 會自動把字串轉成目標型別（enum、`int`、`Instant`、`Path`⋯⋯，
還有任何有 `static valueOf(String)` 或單一 `String` 參數建構子的型別）。

**處理特殊值：**

```java
@ParameterizedTest
@CsvSource(nullValues = "NULL", value = {
        "買牛奶,     HIGH,   false",
        "'含,逗號',  LOW,    false",      // 單引號包住含逗號的值
        "NULL,       LOW,    true"        // 對應 nullValues
})
void validatesTitle(String title, Priority priority, boolean shouldFail) { }
```

**用文字區塊寫大一點的表格**（JUnit 5.8.2+，可讀性大勝）：

```java
@ParameterizedTest(name = "{0}")
@DisplayName("排序規則")
@CsvSource(useHeadersInDisplayName = true, textBlock = """
        情境,              第一筆,  第二筆,  第三筆
        全部未完成,        高,      中,      低
        高優先已完成,      中,      低,      高
        全部已完成,        高,      中,      低
        """)
void sortsCorrectly(String scenario, String first, String second, String third) {
    // ...
}
```

`useHeadersInDisplayName = true` 會讓失敗訊息帶上欄位名：

```
✗ 高優先已完成
    情境 = 高優先已完成, 第一筆 = 中, 第二筆 = 低, 第三筆 = 高
```

### `@CsvFileSource`：資料放檔案

當測資有幾十上百筆（例如稅率表、匯率表、驗證規則表）：

`src/test/resources/title-validation.csv`

```csv
# 標題,是否合法,說明
買牛奶,true,一般情況
  買牛奶  ,true,前後空白會被去掉
,false,空字串
   ,false,只有空白
"含,逗號的標題",true,CSV 引號處理
```

```java
@ParameterizedTest(name = "{2}：<{0}>")
@CsvFileSource(resources = "/title-validation.csv", numLinesToSkip = 1, delimiter = ',')
void validatesTitle(String title, boolean valid, String description) {
    if (valid) {
        assertThatNoException()
                .isThrownBy(() -> new Todo(1L, title, Priority.LOW, NOW));
    } else {
        assertThatThrownBy(() -> new Todo(1L, title, Priority.LOW, NOW))
                .isInstanceOf(InvalidTodoException.class);
    }
}
```

> ⚠️ **`if/else` 出現在參數化測試裡，通常是訊號：你把兩個測試塞成一個。**
> 更好的做法是拆成兩個測試、兩份測資（合法的、不合法的），
> 各自只有一種斷言。這樣測試名字才能誠實地描述它在驗證什麼。
>
> 例外：像上面這種「規則表」，且合法/不合法只差斷言方向時，
> 放一起能讓測資表更完整、更容易看出漏了哪些邊界。**這是取捨，不是規則。**

### `@MethodSource`：需要複雜物件時

`@CsvSource` 只能傳字串能轉成的東西。要傳 `Todo`、`List`、`Map`、lambda 時，用 `@MethodSource`：

```java
package com.example.todo.service;

import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;

import java.time.Instant;
import java.util.List;
import java.util.stream.Stream;

import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.params.provider.Arguments.arguments;

class SortingTest {

    private static final Instant T0 = Instant.parse("2026-08-17T10:00:00Z");

    /** 提供方法必須是 static（除非類別是 @TestInstance(PER_CLASS)） */
    static Stream<Arguments> sortingCases() {
        return Stream.of(
                arguments("全部未完成，依優先度",
                        List.of(todo(1, "低", Priority.LOW, false),
                                todo(2, "高", Priority.HIGH, false),
                                todo(3, "中", Priority.MEDIUM, false)),
                        List.of("高", "中", "低")),

                arguments("已完成的排在最後",
                        List.of(todo(1, "已完成的高", Priority.HIGH, true),
                                todo(2, "未完成的低", Priority.LOW, false)),
                        List.of("未完成的低", "已完成的高")),

                arguments("同優先度時，建立時間早的在前",
                        List.of(todo(2, "晚建立", Priority.HIGH, false, T0.plusSeconds(60)),
                                todo(1, "早建立", Priority.HIGH, false, T0)),
                        List.of("早建立", "晚建立")),

                arguments("空清單",
                        List.of(),
                        List.of()));
    }

    @ParameterizedTest(name = "{0}")
    @MethodSource("sortingCases")
    void sortsTodos(String scenario, List<Todo> input, List<String> expectedTitles) {
        // ... 用 input 建立 service，斷言 findAll() 的標題順序等於 expectedTitles
    }

    // ── 測試專用的建構輔助 ──

    private static Todo todo(long id, String title, Priority priority, boolean done) {
        return todo(id, title, priority, done, T0);
    }

    private static Todo todo(long id, String title, Priority priority,
                             boolean done, Instant createdAt) {
        Todo t = new Todo(id, title, priority, createdAt);
        if (done) {
            t.markDone(createdAt.plusSeconds(1));
        }
        return t;
    }
}
```

**`@MethodSource` 的規則：**

| 情況 | 寫法 |
|---|---|
| 同類別的方法 | `@MethodSource("sortingCases")` |
| 省略名稱 | `@MethodSource` → 找同名的 static 方法 |
| 別的類別 | `@MethodSource("com.example.TestData#sortingCases")` |
| 多個來源 | `@MethodSource({"caseA", "caseB"})` |
| 單一參數 | 方法可以回傳 `Stream<String>`、`IntStream`、`List<Todo>`⋯不用包 `Arguments` |
| 多個參數 | 必須回傳 `Stream<Arguments>` / `Collection<Arguments>` / `Iterator<Arguments>` |
| 非 static 的提供方法 | 類別要加 `@TestInstance(PER_CLASS)` |

### `@EnumSource`：窮舉 enum

```java
// 全部 enum 值
@ParameterizedTest
@EnumSource(Priority.class)
void everyPriorityHasLabel(Priority priority) {
    assertThat(priority.label()).isNotBlank();
    assertThat(priority.weight()).isPositive();
}

// 只要某幾個
@ParameterizedTest
@EnumSource(value = Priority.class, names = {"HIGH", "MEDIUM"})
void importantOnes(Priority priority) { }

// 排除某幾個
@ParameterizedTest
@EnumSource(value = Priority.class, names = "LOW", mode = EnumSource.Mode.EXCLUDE)
void notLow(Priority priority) { }

// 用正則
@ParameterizedTest
@EnumSource(value = ErrorCode.class, names = "TODO_.*", mode = EnumSource.Mode.MATCH_ALL)
void allTodoErrorCodes(ErrorCode code) {
    assertThat(code.code()).startsWith("TODO-");
    assertThat(code.defaultMessage()).isNotBlank();
}
```

> 🔑 **`@EnumSource(SomeEnum.class)` 有一個隱藏的巨大價值：新增 enum 值時，
> 測試會自動涵蓋它。**
>
> 假設半年後有人加了 `Priority.URGENT` 但忘記設 `label`：
>
> ```java
> URGENT("", 4)      // label 忘了填
> ```
>
> 上面的 `everyPriorityHasLabel` **立刻紅**。
> 如果你是手寫三個測試（HIGH / MEDIUM / LOW），新的 `URGENT` 永遠不會被測到。
>
> **凡是「所有 enum 值都該滿足某個性質」的規則，都該用 `@EnumSource` 寫成測試。**
> 這和第 01 章 1.13 節「arrow switch + enum 的窮舉檢查」是同一個思路：
> **讓「漏掉」變成編譯錯誤或測試失敗，而不是靠人記得。**

### `@ArgumentsSource`：可複用的提供者

當同一組測資要給多個測試類別用：

```java
package com.example.todo;

import org.junit.jupiter.api.extension.ExtensionContext;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.ArgumentsProvider;

import java.util.stream.Stream;

/** 所有「應該被視為空白」的字串。給多個測試類別共用。 */
public class BlankStringsProvider implements ArgumentsProvider {

    @Override
    public Stream<? extends Arguments> provideArguments(ExtensionContext context) {
        return Stream.of(
                Arguments.of((Object) null),
                Arguments.of(""),
                Arguments.of(" "),
                Arguments.of("\t"),
                Arguments.of("\n"),
                Arguments.of("\r\n"),
                Arguments.of("　"),      // 全形空白
                Arguments.of(" "))      // NO-BREAK SPACE（從網頁複製常帶到）
                .map(a -> a);
    }
}
```

```java
@ParameterizedTest
@ArgumentsSource(BlankStringsProvider.class)
void rejectsBlankTitle(String title) { }

@ParameterizedTest
@ArgumentsSource(BlankStringsProvider.class)
void rejectsBlankTag(String tag) { }
```

更進一步，可以做成自訂的組合註解：

```java
package com.example.todo;

import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ArgumentsSource;

import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

@Target(ElementType.METHOD)
@Retention(RetentionPolicy.RUNTIME)
@ParameterizedTest(name = "空白字串 [{index}]")
@ArgumentsSource(BlankStringsProvider.class)
public @interface BlankStringTest {
}
```

```java
@BlankStringTest
void rejectsBlankTitle(String title) {
    assertThatThrownBy(() -> new Todo(1L, title, Priority.LOW, NOW))
            .isInstanceOf(InvalidTodoException.class);
}
```

**一行註解，八組邊界測試。** 這是 JUnit 5 註解可組合設計的實用價值。

### 選擇指南

| 情況 | 用哪個 |
|---|---|
| 一個參數，值是字面常量 | `@ValueSource` |
| 要測 `null` / 空字串 | `@NullSource` / `@EmptySource` / `@NullAndEmptySource` |
| 2～4 個參數，都能用字串表示 | `@CsvSource`（多行時用 `textBlock`） |
| 測資很多（> 20 筆）或非工程師要維護 | `@CsvFileSource` |
| 參數是複雜物件、集合、lambda | `@MethodSource` |
| 窮舉 enum | `@EnumSource` |
| 同一組測資給多個類別用 | `@ArgumentsSource` + 自訂註解 |

> ⚠️ **參數化測試的反面用法**：把**行為完全不同**的情境塞進同一個參數化測試，
> 然後在方法裡用 `if/switch` 分支。
>
> ```java
> // ❌ 這不是參數化，這是把三個測試擠在一起
> @ParameterizedTest
> @CsvSource({"add", "markDone", "remove"})
> void testEverything(String operation) {
>     switch (operation) {
>         case "add" -> { /* 20 行 */ }
>         case "markDone" -> { /* 20 行 */ }
>         case "remove" -> { /* 20 行 */ }
>     }
> }
> ```
>
> **判準：如果不同參數走的是不同的斷言邏輯，就該拆成不同的測試方法。**
> 參數化測試的正確用途是「**同一段邏輯，不同輸入**」。

---

## 11.9 例外與邊界測試

### 例外測試的三個層次

```java
// 層次 1：型別對不對（最基本）
assertThatThrownBy(() -> service.markDone(999L))
        .isInstanceOf(TodoNotFoundException.class);

// 層次 2：訊息含有關鍵資訊（讓使用者能自救）
assertThatThrownBy(() -> service.markDone(999L))
        .isInstanceOf(TodoNotFoundException.class)
        .hasMessageContaining("999");           // id 要出現在訊息裡

// 層次 3：結構化資訊正確（給程式用的契約）
assertThatThrownBy(() -> service.markDone(999L))
        .isInstanceOf(TodoNotFoundException.class)
        .asInstanceOf(InstanceOfAssertFactories.type(TodoException.class))
        .extracting(TodoException::errorCode)
        .isEqualTo(ErrorCode.TODO_NOT_FOUND);
```

### 別忘了測「副作用有沒有發生」

例外測試最常漏掉的一半：

```java
@Test
@DisplayName("標題不合法時，不會寫入儲存層也不會發通知")
void doesNotSaveWhenTitleInvalid() {
    given(repository.nextId()).willReturn(42L);

    assertThatThrownBy(() -> service.add("   ", Priority.HIGH))
            .isInstanceOf(InvalidTodoException.class);

    // ★ 這兩行才是重點：確認失敗時沒有留下半成品
    verify(repository, never()).save(any());
    verify(notifier, never()).notifyCreated(any());
}
```

**只驗證「有丟例外」是不夠的。** 一個方法可以先寫進資料庫、
再發現參數不對而丟例外——這時你的資料就髒了。

第 04 章 4.9 節講過的「失敗時要保持一致狀態」，就是靠這種測試守住的。

### 測試例外鏈（不要吞掉 cause）

第 04 章 4.7 節的規則：包裝例外時一定要帶上 `cause`。用測試鎖住它：

```java
@Test
@DisplayName("磁碟寫入失敗時，包成 StorageException 但保留原始 IOException")
void wrapsIoExceptionWithCause() {
    IOException diskFull = new IOException("No space left on device");
    given(fileStore.write(any())).willThrow(diskFull);

    assertThatThrownBy(() -> repository.save(todo))
            .isInstanceOf(StorageException.class)
            .hasMessageContaining("儲存失敗")
            .cause()                                    // 往下一層
            .isSameAs(diskFull);                        // 是同一個物件，不是複製的訊息
}
```

`isSameAs` 而不是 `isEqualTo`——確認是**原始那個物件**被傳下去，
而不是「有人 `new IOException(e.getMessage())` 重建了一個」（那會遺失堆疊）。

### 邊界值：測「剛好」和「差一點」

`Todo.MAX_TITLE_LENGTH = 100`。要測幾個值？

```java
@ParameterizedTest(name = "長度 {0}")
@DisplayName("標題長度剛好在上限內可以接受")
@ValueSource(ints = {1, 2, 99, 100})
void acceptsTitleUpToMaxLength(int length) {
    String title = "牛".repeat(length);

    Todo todo = new Todo(1L, title, Priority.LOW, NOW);

    assertThat(todo.title()).hasSize(length);
}

@ParameterizedTest(name = "長度 {0}")
@DisplayName("標題超過上限時被拒絕")
@ValueSource(ints = {101, 200, 1000})
void rejectsTitleOverMaxLength(int length) {
    String title = "牛".repeat(length);

    assertThatThrownBy(() -> new Todo(1L, title, Priority.LOW, NOW))
            .isInstanceOf(InvalidTodoException.class)
            .hasMessageContaining("100");
}
```

**邊界測試的鐵律：測 `n-1`、`n`、`n+1`。**

`100` 和 `101` 這兩個值是關鍵——它們抓的是**差一錯誤**（off-by-one）：

```java
// 這兩種寫法的差別，只有 length == 100 那一組測試抓得到
if (trimmed.length() > MAX_TITLE_LENGTH)     // ✅ 100 通過
if (trimmed.length() >= MAX_TITLE_LENGTH)    // ❌ 100 被拒
```

沒有 `100` 這一組，你的測試（測 1、50、200）**兩種寫法都會通過**。

### 不要用魔術數字，用常量

```java
// ❌ 100 這個數字散落在測試裡。改上限時要改 N 個地方
@ValueSource(ints = {99, 100})
void acceptsTitle(int length) { }

// ✅ 從受測類別讀
@Test
void acceptsTitleAtExactlyMaxLength() {
    String title = "牛".repeat(Todo.MAX_TITLE_LENGTH);

    assertThat(new Todo(1L, title, Priority.LOW, NOW).title())
            .hasSize(Todo.MAX_TITLE_LENGTH);
}

@Test
void rejectsTitleOneOverMaxLength() {
    String title = "牛".repeat(Todo.MAX_TITLE_LENGTH + 1);

    assertThatThrownBy(() -> new Todo(1L, title, Priority.LOW, NOW))
            .isInstanceOf(InvalidTodoException.class);
}
```

> ⚠️ **但這裡有個取捨要說清楚。**
> 用常量的好處是「改上限時測試自動跟上」；**壞處是「改上限時測試不會發現」**。
>
> 如果 `MAX_TITLE_LENGTH` 是**對外承諾的規格**（API 文件寫了 100），
> 那測試裡就該**寫死 100**——這樣有人偷偷改成 50 時，測試會紅，
> 提醒他「這是破壞性變更，要更新文件與通知使用者」。
>
> **判準：這個數字是「實作細節」還是「對外契約」？**
> 實作細節 → 用常量。對外契約 → 寫死，並在測試名稱裡寫明
> （`titleLimitIsExactly100Characters`）。

### 邊界清單：寫測試前先列出來

每種型別都有一組「一定要想過」的邊界。這是我的檢查清單：

| 型別 | 一定要測的邊界 |
|---|---|
| 整數 | 0、1、-1、最大值、最小值、溢位（第 01 章 1.5 節）、上限 ±1 |
| 字串 | `null`、`""`、只有空白（含全形）、剛好上限、超過 1、含換行、含 emoji（第 07 章 7.5 節）、含 SQL/HTML 特殊字元 |
| 集合 | `null`、空集合、一個元素、重複元素、含 `null` 元素、超大集合 |
| `Optional` | 空、有值 |
| 日期時間 | 月初/月底、閏年 2/29、跨年、DST 切換（第 07 章 7.12 節）、不同時區、`Instant.MIN`/`MAX` |
| 金額 | 0、負數、小數精度（第 01 章 1.7 節的 `BigDecimal`）、超大數 |
| 檔案 | 不存在、沒權限、空檔案、超大檔案、路徑含 `..`（第 07 章 7.8 節） |

**寫測試前花兩分鐘掃這張表**，比事後補 bug 快得多。

---

## 11.10 測試替身：五種，別再全叫 mock

「mock」這個詞被濫用了。實際上有五種不同的東西，混用會導致溝通成本
和設計錯誤。以下用 Martin Fowler 的分類。

```
測試替身（Test Double）
├── Dummy   ── 只是為了填參數，根本不會被呼叫
├── Stub    ── 回傳預先設定的答案（狀態驗證）
├── Spy     ── 真的執行，但記錄被呼叫的情況
├── Mock    ── 預先設定「期望被怎麼呼叫」，事後驗證（行為驗證）
└── Fake    ── 有真正的實作，只是簡化版（例如記憶體版資料庫）
```

### 一個一個看

**① Dummy——填空用**

```java
@Test
void findAllDoesNotUseNotifier() {
    // notifier 在這個測試裡根本不會被呼叫，但建構子需要它
    Notifier dummy = new Notifier() {
        @Override public void notifyCreated(Todo todo) {
            throw new AssertionError("不該被呼叫");
        }
        @Override public void notifyDone(Todo todo) {
            throw new AssertionError("不該被呼叫");
        }
    };

    TodoService service = new TodoService(repository, clock, dummy);

    assertThat(service.findAll()).isEmpty();
}
```

> 讓 dummy 在被呼叫時丟 `AssertionError`，比讓它什麼都不做好——
> 它把「這個測試不該碰到通知」的假設變成**會失敗的檢查**。
> Mockito 的 `@Mock` 預設是「什麼都不做」，反而藏起了這個資訊。

**② Stub——提供答案**

```java
@Test
void returnsTodoFromRepository() {
    // stub：問它 findById(1)，它回答一個固定的 Todo
    TodoRepository stub = new TodoRepository() {
        @Override public Optional<Todo> findById(long id) {
            return id == 1L
                    ? Optional.of(new Todo(1L, "買牛奶", Priority.HIGH, NOW))
                    : Optional.empty();
        }
        @Override public Todo save(Todo todo) { return todo; }
        @Override public List<Todo> findAll() { return List.of(); }
        @Override public boolean deleteById(long id) { return false; }
        @Override public long nextId() { return 1L; }
    };

    TodoService service = new TodoService(stub, clock, notifier);

    assertThat(service.markDone(1L).isDone()).isTrue();
}
```

Mockito 的 `when(...).thenReturn(...)` 做的就是這件事，只是不用手寫整個類別。

**③ Spy——真的做，但記錄**

```java
@Test
void logsEveryNotification() {
    // spy：包住真實實作，額外記錄呼叫
    class RecordingNotifier implements Notifier {
        private final Notifier delegate = new ConsoleNotifier();
        final List<Todo> created = new ArrayList<>();

        @Override public void notifyCreated(Todo todo) {
            created.add(todo);
            delegate.notifyCreated(todo);      // 真的執行
        }
        @Override public void notifyDone(Todo todo) {
            delegate.notifyDone(todo);
        }
    }
    RecordingNotifier spy = new RecordingNotifier();

    new TodoService(repository, clock, spy).add("買牛奶", Priority.LOW);

    assertThat(spy.created).hasSize(1);
}
```

**④ Mock——事先設定期望，事後驗證**

```java
@Test
void notifiesExactlyOnce() {
    // Mockito 的 mock。重點在最後的 verify（行為驗證）
    given(repository.nextId()).willReturn(1L);
    given(repository.save(any())).willAnswer(inv -> inv.getArgument(0));

    service.add("買牛奶", Priority.LOW);

    verify(notifier, times(1)).notifyCreated(any(Todo.class));
    verifyNoMoreInteractions(notifier);
}
```

**Stub 和 Mock 的差別**是本節最重要的區分：

| | Stub | Mock |
|---|---|---|
| 目的 | **提供輸入** | **驗證輸出（互動）** |
| 驗證方式 | 斷言受測物件的**回傳值 / 狀態** | 斷言**某個方法被怎麼呼叫** |
| 失敗訊息 | 「預期 X 但得到 Y」 | 「預期呼叫 notifyDone 一次，實際 0 次」 |
| 測試耦合度 | 低（換實作不影響） | **高**（實作改了呼叫方式，測試就紅） |

**實務建議：優先用 stub + 狀態驗證，只在「副作用本身就是需求」時用 mock 驗證。**

```java
// ✅ 狀態驗證：我不在意你怎麼存的，只在意存完後查得到
@Test
void savedTodoCanBeFound() {
    service.add("買牛奶", Priority.LOW);

    assertThat(service.findAll()).extracting(Todo::title).containsExactly("買牛奶");
}

// ✅ 行為驗證：「發出通知」本身就是需求，沒有狀態可以查
@Test
void notifiesOnCreate() {
    service.add("買牛奶", Priority.LOW);

    verify(notifier).notifyCreated(any());
}

// ❌ 過度行為驗證：這在測「實作細節」
@Test
void callsFindByIdBeforeSave() {
    service.markDone(1L);

    InOrder order = inOrder(repository);
    order.verify(repository).findById(1L);
    order.verify(repository).save(any());
}
```

第三個測試的問題：如果有人重構成「用 `findByIdForUpdate` 一次拿到並鎖定」，
**行為完全一樣，但測試會紅**。這種測試會讓重構變成苦工，
最後大家的反應是「把測試刪掉」——安全網就沒了。

**⑤ Fake——簡化的真實實作**

```java
package com.example.todo.repository;

import com.example.todo.model.Todo;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicLong;

/**
 * 記憶體版 Repository。測試專用的 fake：
 * 有真正的實作（真的能存、能查、能刪），只是不落地。
 *
 * <p>比 mock 好的地方：不用一個一個 stub，而且會抓到「存了之後查不到」這種 bug。
 */
public class FakeTodoRepository implements TodoRepository {

    private final Map<Long, Todo> store = new LinkedHashMap<>();
    private final AtomicLong sequence = new AtomicLong(0);

    @Override
    public Todo save(Todo todo) {
        store.put(todo.id(), todo);
        return todo;
    }

    @Override
    public Optional<Todo> findById(long id) {
        return Optional.ofNullable(store.get(id));
    }

    @Override
    public List<Todo> findAll() {
        return new ArrayList<>(store.values());
    }

    @Override
    public boolean deleteById(long id) {
        return store.remove(id) != null;
    }

    @Override
    public long nextId() {
        return sequence.incrementAndGet();
    }

    // ── 測試用的額外方法（真實實作不會有） ──

    /** 直接塞資料，跳過 service 層 */
    public FakeTodoRepository seed(Todo... todos) {
        for (Todo t : todos) {
            store.put(t.id(), t);
            sequence.updateAndGet(cur -> Math.max(cur, t.id()));
        }
        return this;
    }

    public int size() {
        return store.size();
    }
}
```

用起來：

```java
@Test
@DisplayName("新增後可以查到，且 id 遞增")
void addThenFind() {
    FakeTodoRepository repo = new FakeTodoRepository();
    TodoService service = new TodoService(repo, FIXED_CLOCK, notifier);

    service.add("買牛奶", Priority.HIGH);
    service.add("寫測試", Priority.MEDIUM);

    assertThat(service.findAll())
            .extracting(Todo::id, Todo::title)
            .containsExactly(
                    tuple(1L, "買牛奶"),
                    tuple(2L, "寫測試"));
}
```

**對比同一個測試用 mock 寫：**

```java
@Test
void addThenFindWithMocks() {
    given(repository.nextId()).willReturn(1L, 2L);
    given(repository.save(any())).willAnswer(inv -> inv.getArgument(0));
    // 還要 stub findAll 回傳什麼⋯⋯而那就是我要驗證的東西！
    given(repository.findAll()).willReturn(List.of(
            new Todo(1L, "買牛奶", Priority.HIGH, NOW),
            new Todo(2L, "寫測試", Priority.MEDIUM, NOW)));

    service.add("買牛奶", Priority.HIGH);
    service.add("寫測試", Priority.MEDIUM);

    assertThat(service.findAll()).hasSize(2);    // 這只是驗證我剛剛設定的 stub
}
```

**這個測試什麼都沒驗證到。** 它驗證的是「我寫的 stub 回傳了我寫的東西」。

> 🔑 **這是 mock 最常見的誤用，也是本章最重要的一課：**
>
> **當你發現自己 stub 的東西，就是你要驗證的東西時，這個測試是假的。**
>
> 解法：把 stub 換成 fake。Fake 有真實行為，所以「存了之後查得到」
> 這件事是被**真的驗證**的。

### 選擇指南

| 情況 | 用哪個 |
|---|---|
| 只是為了填建構子參數 | Dummy（讓它在被呼叫時丟 `AssertionError`） |
| 需要依賴回傳特定值 | Stub（Mockito `when/thenReturn`） |
| 「有沒有呼叫」本身就是需求（寄信、發事件、寫 audit log） | Mock + `verify` |
| 依賴有狀態，而你要測「一連串操作的結果」 | **Fake** |
| 依賴是純函式或很簡單 | **用真的**，不要替身 |
| 依賴是你自己寫的值物件（`Todo`、`Priority`） | **一定用真的**。11.12 節 |

> **一個好用的判準**：Repository、Cache、外部 API 客戶端這類「有狀態的東西」
> 用 **fake**；Notifier、EmailSender、EventPublisher 這類「只有副作用的東西」
> 用 **mock**；Validator、Formatter、Calculator 這類「純函式」**用真的**。

---

## 11.11 Mockito 實戰

### 三種建立 mock 的方式

```java
// ① 註解（推薦）：需要 MockitoExtension
@ExtendWith(MockitoExtension.class)
class TodoServiceTest {
    @Mock TodoRepository repository;
    @Mock Notifier notifier;
}

// ② 程式呼叫：不需要 extension，適合區域變數
TodoRepository repository = Mockito.mock(TodoRepository.class);

// ③ 帶名字（失敗訊息更清楚）
TodoRepository repository = Mockito.mock(TodoRepository.class,
        withSettings().name("主要儲存層"));
```

### `MockitoExtension` 做了什麼

```java
@ExtendWith(MockitoExtension.class)
class TodoServiceTest {

    @Mock TodoRepository repository;     // 每個測試前建立新的 mock
    @Mock Notifier notifier;
    @Captor ArgumentCaptor<Todo> todoCaptor;

    // ...
}
```

它做四件事：
1. 每個測試前初始化所有 `@Mock` / `@Spy` / `@Captor` / `@InjectMocks` 欄位。
2. 每個測試後驗證沒有多餘的 stub（`STRICT_STUBS`，見下方）。
3. 每個測試後重設，測試之間不會互相影響。
4. 支援把 mock 當測試方法參數注入。

> 舊教學會看到 `MockitoAnnotations.openMocks(this)` 放在 `@BeforeEach`。
> 那是沒有 extension 時的做法。**用 `@ExtendWith(MockitoExtension.class)`
> 更好**，因為它會額外做 strict stubs 檢查。

### `@InjectMocks`：自動組裝（但我建議別用）

```java
@ExtendWith(MockitoExtension.class)
class TodoServiceTest {

    @Mock TodoRepository repository;
    @Mock Notifier notifier;

    @InjectMocks TodoService service;     // Mockito 自動用上面的 mock 建構它
}
```

看起來很方便。**但我建議手動建構：**

```java
@ExtendWith(MockitoExtension.class)
class TodoServiceTest {

    @Mock TodoRepository repository;
    @Mock Notifier notifier;

    TodoService service;

    @BeforeEach
    void setUp() {
        service = new TodoService(repository, Clock.fixed(NOW, ZoneOffset.UTC), notifier);
    }
}
```

**四個理由：**

1. **`Clock` 不是 mock**。`@InjectMocks` 會把 `Clock` 也塞成 mock
   （`clock.instant()` 回傳 `null`），然後你的 `Todo` 建構子噴 NPE，
   而錯誤訊息完全看不出原因。
2. **`@InjectMocks` 靜默失敗**。找不到適合的建構子時，它會退回到欄位注入
   或什麼都不注入，讓你在測試裡拿到一個 `null` 欄位——然後 NPE。
3. **新增建構子參數時，測試不會壞**（它會靜默塞 `null`），
   於是你以為測試還在保護你，實際上受測物件是半殘的。
4. **手寫建構子讓依賴看得見**。讀測試的人一眼就知道 `TodoService` 需要什麼。

> **這是一個「方便 vs 明確」的取捨，而測試程式碼應該永遠選明確。**
> `@InjectMocks` 唯一真正划算的場合是「建構子有 8 個依賴」——
> 但那時真正的問題是「這個類別責任太多」，不是「組裝太麻煩」。

### Stubbing：設定回答

```java
import static org.mockito.BDDMockito.given;      // BDD 風格
import static org.mockito.Mockito.when;          // 經典風格

// 兩種寫法完全等價，選一種統一用
when(repository.findById(1L)).thenReturn(Optional.of(todo));
given(repository.findById(1L)).willReturn(Optional.of(todo));

// 丟例外
given(repository.save(any())).willThrow(new StorageException("磁碟滿了"));

// 連續呼叫回傳不同值（第一次 1，第二次 2，之後都是 2）
given(repository.nextId()).willReturn(1L, 2L);

// 依參數動態決定
given(repository.save(any(Todo.class))).willAnswer(inv -> inv.getArgument(0));

// void 方法要用 doXxx().when() 的順序
doThrow(new StorageException("寄信失敗")).when(notifier).notifyDone(any());
doNothing().when(notifier).notifyCreated(any());
```

> **`given(...).willReturn(...)` vs `doReturn(...).when(...)`**
> 前者更好讀，但它會**真的呼叫一次** mock 的方法（對 mock 來說無害）。
> 對 **spy**（包住真實物件）就不行了——`given(spy.risky()).willReturn(x)`
> 會真的執行 `risky()`。所以 **spy 一律用 `doReturn().when(spy).risky()`**。

### Argument matchers

```java
import static org.mockito.ArgumentMatchers.*;

given(repository.findById(anyLong())).willReturn(Optional.empty());
given(repository.save(any(Todo.class))).willAnswer(inv -> inv.getArgument(0));

verify(notifier).notifyDone(argThat(t -> t.id() == 1L && t.isDone()));
verify(repository).findById(eq(1L));

// 常用 matcher
any()            // 任何東西（包含 null）
any(Todo.class)  // 任何 Todo（Mockito 5 起也接受 null）
anyLong() / anyInt() / anyString() / anyBoolean()
anyList() / anyMap() / anySet()
isNull() / isNotNull()
eq(value)        // 等於（用 equals）
same(value)      // 同一個物件
argThat(pred)    // 自訂條件
```

> 🔥 **matcher 的第一大坑：混用 matcher 和實際值。**
>
> ```java
> // ❌ 一個 matcher 一個實際值 → InvalidUseOfMatchersException
> verify(service).transfer(anyLong(), 100L);
>
> // ✅ 全部用 matcher
> verify(service).transfer(anyLong(), eq(100L));
>
> // ✅ 或全部用實際值
> verify(service).transfer(1L, 100L);
> ```
>
> 原因是 matcher 的實作機制：`anyLong()` 其實回傳 `0L`，
> 同時把「這個位置用 matcher」推進一個堆疊。Mockito 用堆疊的大小
> 和參數個數比對——混用就對不上。錯誤訊息長這樣：
>
> ```
> org.mockito.exceptions.misusing.InvalidUseOfMatchersException:
> Invalid use of argument matchers!
> 2 matchers expected, 1 recorded
> ```
>
> ⚠️ **而且它會在「下一個」測試裡爆炸**（因為堆疊沒清空），
> 讓你以為是那個測試的問題。看到這個錯誤，先看它上面那個測試。

### Verify：驗證互動

```java
import static org.mockito.Mockito.*;

verify(notifier).notifyDone(todo);                 // 剛好一次（times(1) 的簡寫）
verify(notifier, times(2)).notifyDone(any());
verify(notifier, never()).notifyDone(any());
verify(notifier, atLeastOnce()).notifyDone(any());
verify(notifier, atLeast(2)).notifyDone(any());
verify(notifier, atMost(3)).notifyDone(any());

verifyNoInteractions(notifier);                    // 完全沒被碰過
verifyNoMoreInteractions(notifier);                // 除了已驗證的，沒有別的

// 順序驗證（謹慎使用，見 11.10 節的警告）
InOrder order = inOrder(repository, notifier);
order.verify(repository).save(any());
order.verify(notifier).notifyDone(any());
```

> ⚠️ **`verifyNoMoreInteractions` 要小心用。**
> 它會讓測試對「任何新增的互動」都敏感——包含無害的。
> 有人在方法裡加了一行 `repository.count()` 做 metrics，
> 你的 20 個測試全部紅。
>
> **只在「多餘的呼叫本身就是 bug」時用**（例如「不可以重複寄信」、
> 「不可以重複扣款」）。一般情況用 `verify(mock, never())` 精準驗證你在意的那一項。

### `ArgumentCaptor`：檢查傳進去的東西

當你要驗證的不只是「有沒有被呼叫」，而是「被傳了什麼」：

```java
@Test
@DisplayName("儲存時，完成時間用的是時鐘的當下時間")
void savesWithClockTime() {
    Todo todo = new Todo(1L, "買牛奶", Priority.HIGH, NOW.minusSeconds(3600));
    given(repository.findById(1L)).willReturn(Optional.of(todo));
    given(repository.save(any())).willAnswer(inv -> inv.getArgument(0));

    service.markDone(1L);

    ArgumentCaptor<Todo> captor = ArgumentCaptor.forClass(Todo.class);
    verify(repository).save(captor.capture());

    Todo saved = captor.getValue();
    assertThat(saved.isDone()).isTrue();
    assertThat(saved.completedAt()).isEqualTo(NOW);
}
```

用 `@Captor` 註解可以少一行：

```java
@Captor ArgumentCaptor<Todo> todoCaptor;

// ...
verify(repository).save(todoCaptor.capture());
assertThat(todoCaptor.getValue().isDone()).isTrue();
```

**捕捉多次呼叫：**

```java
@Test
void savesEachTodoOnce() {
    // ... 執行三次 add

    verify(repository, times(3)).save(todoCaptor.capture());

    assertThat(todoCaptor.getAllValues())
            .extracting(Todo::title)
            .containsExactly("第一", "第二", "第三");
}
```

> **`ArgumentCaptor` vs `argThat`**
>
> ```java
> // argThat：條件簡單時比較短
> verify(repository).save(argThat(t -> t.isDone()));
>
> // Captor：條件複雜、或要多個斷言時比較好
> verify(repository).save(todoCaptor.capture());
> assertThat(todoCaptor.getValue())
>         .satisfies(t -> assertThat(t.isDone()).isTrue())
>         .satisfies(t -> assertThat(t.completedAt()).isEqualTo(NOW));
> ```
>
> **關鍵差異在失敗訊息。** `argThat` 失敗時只說「找不到符合的呼叫」，
> 你不知道實際傳了什麼。Captor 失敗時 AssertJ 會印出實際物件。
> **所以：驗證用 `argThat`（當條件是「哪一次呼叫」），
> 斷言內容用 `Captor`（當你要檢查「傳了什麼」）。**

### `Answer`：自訂行為

```java
// 回傳傳進來的第一個參數（save 常見的行為）
given(repository.save(any(Todo.class))).willAnswer(inv -> inv.getArgument(0));

// 模擬「存進去之後查得到」
Map<Long, Todo> store = new HashMap<>();
given(repository.save(any(Todo.class))).willAnswer(inv -> {
    Todo t = inv.getArgument(0);
    store.put(t.id(), t);
    return t;
});
given(repository.findById(anyLong())).willAnswer(inv ->
        Optional.ofNullable(store.get(inv.<Long>getArgument(0))));
```

> ⚠️ **如果你的 `Answer` 開始維護狀態（像上面那樣），停下來——
> 你正在手工打造一個 fake。** 直接寫 `FakeTodoRepository`（11.10 節）
> 會短得多、清楚得多、也可以在多個測試裡重用。
>
> **「Answer 裡出現 `Map`」是應該換成 fake 的明確訊號。**

### Strict stubs：Mockito 幫你抓廢棄的測試

`MockitoExtension` 預設是 `Strictness.STRICT_STUBS`，它會抓兩種問題：

**① `UnnecessaryStubbingException`——設了 stub 但沒用到**

```java
@Test
void findAllReturnsEmpty() {
    given(repository.nextId()).willReturn(1L);        // ← 沒用到！
    given(repository.findAll()).willReturn(List.of());

    assertThat(service.findAll()).isEmpty();
}
```

```
org.mockito.exceptions.misusing.UnnecessaryStubbingException:
Unnecessary stubbings detected.
Clean & maintainable test code requires zero unnecessary code.
Following stubbings are unnecessary (click to navigate to relevant line of code):
  1. -> at com.example.todo.service.TodoServiceTest.findAllReturnsEmpty(TodoServiceTest.java:45)
```

**這個檢查非常有價值。** 它抓的是「程式碼重構後，測試裡殘留的舊假設」——
那些 stub 記錄的是**已經不存在的行為**，留著會誤導讀者。

**② `PotentialStubbingProblem`——用了沒設定的參數**

```java
@Test
void marksDone() {
    given(repository.findById(1L)).willReturn(Optional.of(todo));

    service.markDone(2L);      // 傳的是 2 不是 1！
}
```

```
org.mockito.exceptions.misusing.PotentialStubbingProblem:
Strict stubbing argument mismatch. Please check:
 - this invocation of 'findById' method: repository.findById(2L);
 - has following stubbing(s) with different arguments:
     1. repository.findById(1L);
```

寬鬆模式下，`findById(2L)` 會回傳 `null`（mock 的預設值），
然後你在 `orElseThrow` 前就 NPE，錯誤訊息完全看不出是參數打錯。
Strict 模式直接告訴你「你 stub 的是 1，實際問的是 2」。

**需要放寬時：**

```java
// 整個類別放寬（不建議）
@ExtendWith(MockitoExtension.class)
@MockitoSettings(strictness = Strictness.LENIENT)
class SomeTest { }

// 只放寬某一個 stub（推薦）
given(repository.nextId()).willReturn(1L);            // strict
lenient().when(repository.count()).thenReturn(0L);    // 這一個放寬
```

> **什麼時候真的需要 `lenient()`？**
> 通常是「`@Nested` 的外層 `@BeforeEach` 設了 stub，但某些內層測試用不到」。
> 這時 `lenient()` 是合理的。
>
> 但更好的解法是**把 stub 移到真正需要它的那一層**——
> 這也會讓每個測試的前提更明確。`lenient()` 是最後手段，不是預設。

### `@Spy`：部分模擬

```java
@Test
void usesRealLogicExceptForOneMethod() {
    // spy 包住真實物件：沒 stub 的方法會真的執行
    FakeTodoRepository real = new FakeTodoRepository().seed(existingTodo);
    TodoRepository spy = Mockito.spy(real);

    // 只讓 save 失敗，其他方法照真實行為
    doThrow(new StorageException("磁碟滿了")).when(spy).save(any());

    TodoService service = new TodoService(spy, FIXED_CLOCK, notifier);

    assertThatThrownBy(() -> service.markDone(1L))
            .isInstanceOf(StorageException.class);

    // findById 是真的跑的，所以這個測試驗證了「真實查詢 + 假的寫入失敗」
    assertThat(real.findById(1L)).isPresent();
}
```

> ⚠️ **`@Spy` 是最容易被誤用的 Mockito 功能。**
>
> 看到自己在 spy **受測類別本身**（而不是它的依賴）時，停下來：
>
> ```java
> // ❌ 這是設計問題的訊號
> @Spy @InjectMocks TodoService service;
>
> // 然後 stub 掉 service 自己的一個方法
> doReturn(List.of()).when(service).findAll();
> ```
>
> 這表示 `TodoService` 內部有一段你「不想執行」的邏輯——
> 那段邏輯應該被抽成一個**獨立的協作者**，然後正常地 mock 它。
>
> Spy 受測類別會讓測試變得極難理解（「哪些方法是真的？」），
> 而且第 03 章 3.13 節的問題會浮現：**self-invocation 不會經過 spy**，
> 所以 `this.findAll()` 呼叫的是真實方法，你的 stub 完全沒效果。
> 這種 bug 可以耗掉一整個下午。

---
## 11.12 Mockito 的六個誤用

Mockito 很強，強到很容易寫出**看起來測了很多、實際什麼都沒測**的測試。
以下六個是我 code review 時最常標記的。

### 誤用 1：mock 自己的值物件

```java
// ❌ 災難
@Test
void badMockingValueObject() {
    Todo todo = mock(Todo.class);
    given(todo.title()).willReturn("買牛奶");
    given(todo.isDone()).willReturn(false);
    given(todo.priority()).willReturn(Priority.HIGH);

    // ...
}
```

三個問題：

1. **驗證的是你的 stub，不是 `Todo` 的邏輯。** `Todo` 的標題驗證、
   `markDone` 的狀態轉換、防禦性複製，全部被繞過。
2. **`Todo` 的規則改變時測試不會紅。** 有人把 `MAX_TITLE_LENGTH` 改成 10，
   你的 mock 照樣回傳 100 字的標題，測試綠燈。
3. **程式碼比真的建構它還長。** 上面 4 行 vs `new Todo(1L, "買牛奶", Priority.HIGH, NOW)` 1 行。

```java
// ✅ 值物件一律用真的
Todo todo = new Todo(1L, "買牛奶", Priority.HIGH, NOW);
```

> **規則：只 mock「你不想真的執行」的東西**——會連網的、會寫檔的、
> 會寄信的、很慢的、還沒實作的。
>
> `Todo`、`Priority`、`ErrorCode`、`Money`、任何 `record`——**永遠用真的**。
> 它們沒有副作用、執行只要奈秒、而且它們的邏輯**正是你想驗證的**。

### 誤用 2：stub 你要驗證的東西

11.10 節講過，但值得再強調一次，因為它最隱蔽：

```java
// ❌ 這個測試永遠通過，即使 findAll 的排序邏輯完全壞掉
@Test
void sortsByPriority() {
    given(repository.findAll()).willReturn(List.of(
            new Todo(1L, "高", Priority.HIGH, NOW),
            new Todo(2L, "低", Priority.LOW, NOW)));

    assertThat(service.findAll())
            .extracting(Todo::title)
            .containsExactly("高", "低");     // 剛好和 stub 的順序一樣！
}
```

**這個測試沒有驗證排序。** 因為 stub 回傳的順序恰好就是期望的順序，
即使 `TodoService.findAll()` 裡的 `sorted(...)` 被整行刪掉，測試依然綠。

```java
// ✅ 讓 stub 的順序「故意是錯的」，這樣排序邏輯才被真的驗證
@Test
void sortsByPriority() {
    given(repository.findAll()).willReturn(List.of(
            new Todo(1L, "低", Priority.LOW, NOW),        // ← 故意倒過來放
            new Todo(2L, "高", Priority.HIGH, NOW)));

    assertThat(service.findAll())
            .extracting(Todo::title)
            .containsExactly("高", "低");                  // 期望被重新排序
}
```

> 🔑 **一個自我檢查的技巧**：寫完測試後，**故意把受測的那行邏輯註解掉**，
> 確認測試會紅。如果測試還是綠的，那它沒在測你以為的東西。
>
> 這個動作只要 30 秒，卻能抓出大量「假測試」。11.16 節的突變測試
> 就是把這件事自動化。

### 誤用 3：驗證實作細節而非行為

```java
// ❌ 測試綁死在「怎麼做」上
@Test
void marksDone() {
    service.markDone(1L);

    verify(repository).findById(1L);        // 誰在意你用哪個方法查？
    verify(repository).save(any());
    verify(repository, never()).findAll();  // 這是在限制實作
}
```

任何合理的重構都會讓這個測試紅：
改用 `findByIdForUpdate`、改成批次寫入、加一層快取、換成 `merge`⋯⋯
**行為完全沒變，但測試全紅。**

```java
// ✅ 驗證可觀察的結果
@Test
void marksDone() {
    FakeTodoRepository repo = new FakeTodoRepository().seed(pendingTodo);
    TodoService service = new TodoService(repo, FIXED_CLOCK, notifier);

    service.markDone(1L);

    assertThat(repo.findById(1L)).get()
            .extracting(Todo::isDone, Todo::completedAt)
            .containsExactly(true, NOW);
}
```

> **判準：如果我把實作重寫（行為不變），這個測試會不會紅？**
> 會紅 → 它在測實作細節，該改。
> 不會紅 → 它在測行為，很好。
>
> 一個測試套件如果讓重構變成苦工，團隊最後的反應是**刪掉測試**。
> 那時你不只失去安全網，還失去了「測試有價值」這個信念。

### 誤用 4：一個測試裡 mock 五個東西

```java
// ❌ 這是設計問題，不是測試問題
@ExtendWith(MockitoExtension.class)
class OrderServiceTest {
    @Mock TodoRepository repository;
    @Mock Notifier notifier;
    @Mock PaymentGateway payment;
    @Mock InventoryClient inventory;
    @Mock AuditLogger audit;
    @Mock MetricsCollector metrics;
    @Mock FeatureFlags flags;
    @Mock ObjectMapper mapper;
    // ⋯⋯
}
```

**mock 的數量是「這個類別依賴太多」的溫度計。**
七個依賴表示這個類別至少做了七件事——它違反單一職責。

測試會怎麼變糟：
- 每個測試前要 stub 五個東西才能跑起來（`@BeforeEach` 40 行）。
- 新增一個依賴，全部測試要改。
- 任何一個 stub 忘記設，就是 NPE，而錯誤訊息指向受測類別內部而不是測試。

**解法是重構產品程式碼，不是把測試寫得更精巧。**
把 `OrderService` 拆成 `OrderValidator`（純函式，不用 mock）、
`OrderPersistence`（一個依賴）、`OrderNotification`（一個依賴），
然後一個薄薄的協調者。每個都好測。

> **經驗值：一個測試類別超過 3～4 個 mock，就該懷疑受測類別的設計。**
> 這是「難以測試」提供的最有價值的訊息——**測試困難是設計問題的症狀**，
> 不是要克服的障礙。

### 誤用 5：`mockStatic` 當成常規工具

Mockito 5 可以 mock 靜態方法：

```java
@Test
void mocksStaticMethod() {
    try (MockedStatic<Instant> mocked = mockStatic(Instant.class)) {
        mocked.when(Instant::now).thenReturn(NOW);

        // ... 現在程式碼裡的 Instant.now() 會回傳 NOW
    }
}
```

**能用，但這是止血帶，不是治療。**

四個代價：

1. **只對當前執行緒有效。** 受測程式碼裡如果有 `ExecutorService`
   （第 08 章），子執行緒看到的是真的 `Instant.now()`。
2. **必須 try-with-resources。** 忘記 close，整個 JVM 的後續測試都被污染
   ——而且失敗會出現在**別的測試類別**裡，極難追查。
3. **無法平行執行。** 11.18 節的平行測試會壞掉。
4. **它掩蓋了設計問題。** 需要 mock `Instant.now()` 表示你的程式碼
   直接呼叫了全域狀態——那就注入 `Clock`（11.13 節），一勞永逸。

```java
// ✅ 正解：讓「現在幾點」變成一個可注入的依賴
public TodoService(TodoRepository repository, Clock clock, Notifier notifier) { ... }

// 測試裡
Clock fixed = Clock.fixed(NOW, ZoneOffset.UTC);
```

> **`mockStatic` 唯一合理的用途**：你**無法修改**的第三方靜態方法
> （老舊 SDK 的 `LegacyUtil.getConfig()`）。而即使那時，
> 更好的做法通常是包一層自己的介面（第 03 章 3.11 節的 Adapter），
> 然後正常地 mock 那個介面。

### 誤用 6：忘記 `verify` 的預設是「至少一次」⋯⋯其實不是

一個常見的誤解，值得澄清：

```java
verify(notifier).notifyDone(todo);
// 等價於
verify(notifier, times(1)).notifyDone(todo);
```

**預設是「剛好一次」，不是「至少一次」。** 呼叫兩次會失敗：

```
org.mockito.exceptions.verification.TooManyActualInvocations:
notifier.notifyDone(Todo[id=1, ...]);
Wanted 1 time:
-> at com.example.todo.service.TodoServiceTest.marksDone(TodoServiceTest.java:78)
But was 2 times:
-> at com.example.todo.service.TodoService.markDone(TodoService.java:41)
-> at com.example.todo.service.TodoService.markDone(TodoService.java:43)
```

這是**好事**——它抓到了「重複寄信」這類 bug。
想要「至少一次」就明確寫 `atLeastOnce()`。

另一個相關的誤解：

```java
// ❌ 這不會驗證任何東西！
verify(notifier);            // 少了要驗證的方法呼叫
```

這行程式碼合法但無用（它只是回傳一個等待驗證的代理）。
Mockito 會在下一次與該 mock 互動時噴 `UnfinishedVerificationException`——
但如果沒有下一次互動，它就**靜默通過**。

同理，這個經典錯誤也要小心：

```java
// ❌ verify 寫在 assert 之後，而 assert 先失敗了 → verify 從沒執行
assertThat(result.isDone()).isTrue();      // 這裡失敗
verify(notifier).notifyDone(todo);         // 永遠不會跑到
```

不是大問題（測試已經紅了），但你會少看到一半資訊。
用 `assertSoftly` 或把 `verify` 放前面可以避免。

### 六個誤用速查

| # | 誤用 | 訊號 | 正解 |
|---|---|---|---|
| 1 | mock 值物件 | `mock(Todo.class)` | 用真的 `new Todo(...)` |
| 2 | stub 要驗證的東西 | stub 的回傳值恰好等於斷言的期望值 | 讓 stub 的資料「故意是錯的順序 / 內容」，或改用 fake |
| 3 | 驗證實作細節 | `verify(repo).findById(...)` 這類「怎麼做」的驗證 | 驗證可觀察結果（狀態 / 回傳值） |
| 4 | mock 五個以上 | `@BeforeEach` 超過 20 行 | **重構產品程式碼**，拆小 |
| 5 | `mockStatic` 當常規 | `mockStatic(Instant.class)` | 注入 `Clock` / 包一層介面 |
| 6 | 誤解 `verify` 語意 | 以為預設是「至少一次」 | 預設是 `times(1)`；要放寬就明寫 |

---

## 11.13 測試「不可測」的東西

以下四類東西的共通點：**它們是全域可變狀態**。
測試它們的通用解法也是同一個：**把它變成一個依賴，從外面傳進來。**

### ① 時間

**問題：**

```java
// ❌ 無法測試
public Todo markDone(long id) {
    Todo todo = ...;
    todo.markDone(Instant.now());     // ← 全域狀態
    // ...
}
```

你怎麼斷言 `completedAt`？

```java
// ❌ 脆弱到不行
Instant before = Instant.now();
service.markDone(1L);
Instant after = Instant.now();
assertThat(todo.completedAt()).isBetween(before, after);
```

這能跑，但：測試變囉唆、無法測「跨越午夜」「月底」「DST 切換」這類情境、
而且時鐘偶爾回撥（NTP 校時）就會 flaky。

**正解：注入 `Clock`。**

```java
private final Clock clock;

public TodoService(TodoRepository repository, Clock clock, Notifier notifier) {
    this.clock = Objects.requireNonNull(clock, "clock");
}

// 用的時候
todo.markDone(clock.instant());
```

**測試裡的四種 `Clock`：**

```java
// 1. 固定：時間永遠不動。九成的測試用這個
Clock fixed = Clock.fixed(Instant.parse("2026-08-17T10:00:00Z"), ZoneOffset.UTC);

// 2. 偏移：從現在往前 / 後推
Clock yesterday = Clock.offset(Clock.systemUTC(), Duration.ofDays(-1));

// 3. 指定時區的系統時鐘（測 DST 用）
Clock taipei = Clock.system(ZoneId.of("Asia/Taipei"));

// 4. 可推進：測「時間經過」的行為
```

第 4 種要自己寫（第 07 章 7.15 節寫過，這裡原樣搬來）：

```java
package com.example.todo.support;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;

/**
 * 測試用的可控時鐘。可以固定、可以手動推進。
 *
 * <p>用途：測「快取 TTL 過期」、「N 天前的事項」、「逾期提醒」這類
 * 依賴「時間經過」而不只是「當下時間」的邏輯。
 */
public final class MutableClock extends Clock {

    private Instant instant;
    private final ZoneId zone;

    public MutableClock(Instant start, ZoneId zone) {
        this.instant = start;
        this.zone = zone;
    }

    /** 常用起點：UTC 的某個整點，方便心算 */
    public static MutableClock at(String iso8601) {
        return new MutableClock(Instant.parse(iso8601), ZoneId.of("UTC"));
    }

    @Override
    public Instant instant() {
        return instant;
    }

    @Override
    public ZoneId getZone() {
        return zone;
    }

    @Override
    public Clock withZone(ZoneId newZone) {
        return new MutableClock(instant, newZone);
    }

    // ── 測試用的控制方法 ──

    public MutableClock advance(Duration amount) {
        this.instant = this.instant.plus(amount);
        return this;
    }

    public MutableClock advanceDays(long days) {
        return advance(Duration.ofDays(days));
    }

    public MutableClock advanceMinutes(long minutes) {
        return advance(Duration.ofMinutes(minutes));
    }

    public MutableClock setTo(String iso8601) {
        this.instant = Instant.parse(iso8601);
        return this;
    }
}
```

用它測「時間經過」的邏輯：

```java
@Test
@DisplayName("超過 7 天未完成的事項會被標記為逾期")
void marksOverdueAfterSevenDays() {
    MutableClock clock = MutableClock.at("2026-08-17T10:00:00Z");
    TodoService service = new TodoService(repository, clock, notifier);

    Todo todo = service.add("買牛奶", Priority.LOW);
    assertThat(service.findOverdue()).isEmpty();

    clock.advanceDays(6);
    assertThat(service.findOverdue()).as("第 6 天還不算逾期").isEmpty();

    clock.advanceDays(1);
    assertThat(service.findOverdue()).as("第 7 天開始算逾期")
            .extracting(Todo::title).containsExactly("買牛奶");
}
```

**這個測試在 0.001 秒內驗證了七天的行為。** 沒有 `Thread.sleep`，
沒有 flaky，而且「第 6 天不算、第 7 天算」這個邊界被明確鎖住。

> 🔑 **注入 `Clock` 是本課程最值得帶走的實務習慣之一。**
> 它的成本是建構子多一個參數；回報是「所有和時間有關的邏輯都變得可測」。
>
> 第 02 站的 Spring 甚至讓它零成本：
> ```java
> @Bean
> Clock clock() { return Clock.systemDefaultZone(); }
> ```
> 然後正式環境自動注入真實時鐘，測試裡用 `@MockBean` 或測試用的 `@Configuration`
> 換成 `Clock.fixed`。

### ② 亂數

同一個模式：

```java
// ❌ 不可測
public String generateToken() {
    return UUID.randomUUID().toString();
}

// ✅ 注入
private final RandomGenerator random;

public TokenService(RandomGenerator random) {
    this.random = random;
}

public String generateToken() {
    byte[] bytes = new byte[16];
    random.nextBytes(bytes);
    return HexFormat.of().formatHex(bytes);
}
```

測試裡用**固定種子**（Java 17+ 的 `RandomGenerator` 介面）：

```java
@Test
@DisplayName("同一個種子產生同一組 token（可重現）")
void generatesDeterministicToken() {
    RandomGenerator seeded = new java.util.Random(42);
    TokenService service = new TokenService(seeded);

    String first = service.generateToken();

    // 用同一個種子重跑，應得到同一個結果
    assertThat(new TokenService(new java.util.Random(42)).generateToken())
            .isEqualTo(first);
}
```

如果只是要「不重複」而不在意具體值：

```java
@Test
@DisplayName("連續產生 1000 個 token 不重複")
void generatesUniqueTokens() {
    TokenService service = new TokenService(RandomGenerator.getDefault());

    Set<String> tokens = IntStream.range(0, 1000)
            .mapToObj(i -> service.generateToken())
            .collect(Collectors.toSet());

    assertThat(tokens).hasSize(1000);
}
```

> ⚠️ **產生密碼學用途的東西（token、session id、密碼重設連結）
> 一定要用 `SecureRandom`，不能用 `Random`。**
> `Random` 的種子只有 48 bit，而且演算法公開——
> 攻擊者看到幾個輸出就能預測後續全部。
>
> 所以正式環境注入 `SecureRandom`，測試裡才注入固定種子的 `Random`。
> **這正是注入的價值：兩個環境用不同實作，而程式碼一行不改。**
> 第 09 站的 Spring Security 會再談這件事。

### ③ 檔案系統

用 JUnit 5 內建的 `@TempDir`：

```java
package com.example.todo.repository;

import com.example.todo.model.Priority;
import com.example.todo.model.Todo;
import com.example.todo.support.Json;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;

import static org.assertj.core.api.Assertions.assertThat;

@DisplayName("JsonFileTodoRepository")
class JsonFileTodoRepositoryTest {

    private static final Instant NOW = Instant.parse("2026-08-17T10:00:00Z");

    /** JUnit 建立臨時目錄，測試結束後自動遞迴刪除 */
    @TempDir
    Path tempDir;

    @Test
    @DisplayName("存進去的事項可以從新的 repository 實例讀回來")
    void persistsAcrossInstances() {
        Path file = tempDir.resolve("todos.json");

        JsonFileTodoRepository first = new JsonFileTodoRepository(file, new Json());
        first.save(new Todo(1L, "買牛奶", Priority.HIGH, NOW));

        // 全新的實例，只靠檔案讀取
        JsonFileTodoRepository second = new JsonFileTodoRepository(file, new Json());

        assertThat(second.findById(1L)).get()
                .extracting(Todo::title, Todo::priority)
                .containsExactly("買牛奶", Priority.HIGH);
    }

    @Test
    @DisplayName("檔案不存在時視為空清單，不丟例外")
    void treatsMissingFileAsEmpty() {
        Path missing = tempDir.resolve("does-not-exist.json");

        JsonFileTodoRepository repo = new JsonFileTodoRepository(missing, new Json());

        assertThat(repo.findAll()).isEmpty();
    }

    @Test
    @DisplayName("寫入是原子的：寫完後沒有殘留的暫存檔")
    void writesAtomically() throws IOException {
        Path file = tempDir.resolve("todos.json");
        JsonFileTodoRepository repo = new JsonFileTodoRepository(file, new Json());

        repo.save(new Todo(1L, "買牛奶", Priority.HIGH, NOW));

        try (var entries = Files.list(tempDir)) {
            assertThat(entries.map(Path::getFileName).map(Path::toString))
                    .as("目錄裡不該有 .tmp 殘留（第 07 章 7.9 節的原子寫入）")
                    .noneMatch(name -> name.endsWith(".tmp"));
        }
    }

    @Test
    @DisplayName("檔案內容是 UTF-8，中文不會變亂碼")
    void writesUtf8() throws IOException {
        Path file = tempDir.resolve("todos.json");
        JsonFileTodoRepository repo = new JsonFileTodoRepository(file, new Json());

        repo.save(new Todo(1L, "買牛奶🥛", Priority.HIGH, NOW));

        String raw = Files.readString(file, StandardCharsets.UTF_8);
        assertThat(raw).contains("買牛奶🥛");
    }

    @Test
    @DisplayName("檔案內容損壞時，錯誤訊息要指出是哪個檔案")
    void reportsFileNameOnCorruptContent() throws IOException {
        Path file = tempDir.resolve("todos.json");
        Files.writeString(file, "{ 這不是合法的 JSON", StandardCharsets.UTF_8);

        assertThatThrownBy(() -> new JsonFileTodoRepository(file, new Json()).findAll())
                .hasMessageContaining("todos.json");     // 訊息要能讓人找到檔案
    }
}
```

**`@TempDir` 的細節：**

| 用法 | 說明 |
|---|---|
| 欄位 `@TempDir Path dir` | 每個測試方法一個新目錄 |
| `static` 欄位 | 整個類別共用一個目錄（配 `@BeforeAll`） |
| 方法參數 `void test(@TempDir Path dir)` | 只有那個測試需要時 |
| 兩個 `@TempDir` 欄位 | 會得到兩個**不同**的目錄（測「從 A 搬到 B」很好用） |
| `@TempDir(cleanup = ON_SUCCESS)` | **只在成功時刪除**——失敗時留下來讓你檢查 |

> 💡 **`cleanup = CleanupMode.ON_SUCCESS` 在除錯時非常好用。**
> 測試失敗時目錄留在硬碟上，你可以直接去看寫出來的檔案長什麼樣。
> JUnit 會在 log 印出路徑。

**為什麼不用 mock 檔案系統？**

```java
// ❌ 這個測試什麼都沒驗證
@Test
void savesToFile() {
    Files mockFiles = mock(Files.class);     // 而且 Files 是 final utility class
    // ...
}
```

檔案系統的行為（原子性、權限、編碼、`ATOMIC_MOVE` 是否跨檔案系統、
路徑分隔符）**mock 不出來**。你 mock 的是自己對檔案系統的想像，
而 bug 恰好都出在想像和現實的差距。

> **`@TempDir` 的整合測試又快又真實**（本機 SSD 上寫個小檔案大約 0.1 ms），
> 沒有理由用 mock。
>
> 真的需要模擬「磁碟滿了」「沒有權限」這類難以在真實檔案系統重現的錯誤時，
> 才在 `TodoFileStore` 這層加一個介面並 mock 它——
> 而不是去 mock `java.nio.file.Files`。

### ④ 環境變數與系統屬性

```java
// ❌ 不可測（而且會污染其他測試）
public class Config {
    public static String dataDir() {
        return System.getenv("TODO_HOME");
    }
}
```

`System.getenv()` 在 Java 裡**無法從程式碼修改**（`System.getenv` 回傳不可變 Map，
且沒有 setter）。有些函式庫用反射硬改，但那在 Java 17+ 的模組系統下會失敗。

**正解一：注入一個查詢函式**

```java
package com.example.todo.support;

import java.nio.file.Path;
import java.util.Objects;
import java.util.Optional;
import java.util.function.Function;

/** 應用設定。環境查詢被抽成一個函式，測試時可以替換。 */
public final class Config {

    private final Function<String, String> env;

    /** 正式環境用這個 */
    public Config() {
        this(System::getenv);
    }

    /** 測試用這個 */
    public Config(Function<String, String> env) {
        this.env = Objects.requireNonNull(env);
    }

    public Path dataDir() {
        return Optional.ofNullable(env.apply("TODO_HOME"))
                .filter(s -> !s.isBlank())
                .map(Path::of)
                .orElseGet(() -> Path.of(System.getProperty("user.home"), ".todo"));
    }

    public String logLevel() {
        return Optional.ofNullable(env.apply("TODO_LOG_LEVEL"))
                .filter(s -> !s.isBlank())
                .orElse("INFO");
    }
}
```

```java
@Test
@DisplayName("TODO_HOME 有設定時用它，否則用 ~/.todo")
void resolvesDataDir() {
    // 用 Map 當假環境，一行搞定
    Config withEnv = new Config(Map.of("TODO_HOME", "/data/todo")::get);
    assertThat(withEnv.dataDir()).isEqualTo(Path.of("/data/todo"));

    Config withoutEnv = new Config(name -> null);
    assertThat(withoutEnv.dataDir())
            .isEqualTo(Path.of(System.getProperty("user.home"), ".todo"));
}

@ParameterizedTest(name = "TODO_HOME = <{0}> 時退回預設值")
@NullAndEmptySource
@ValueSource(strings = {"   ", "\t"})
void fallsBackWhenBlank(String value) {
    Config config = new Config(name -> value);

    assertThat(config.dataDir())
            .isEqualTo(Path.of(System.getProperty("user.home"), ".todo"));
}
```

> `Map.of(...)::get` 是一個很好用的小技巧——`Map` 的 `get` 剛好符合
> `Function<String, String>` 的簽章（第 06 章 6.4 節的方法參考）。
> 不用寫 lambda，也不用寫假的類別。

**正解二：系統屬性可以直接改（但要清理）**

系統屬性（`System.getProperty`）和環境變數不同，**是可以改的**：

```java
class ConfigSystemPropertyTest {

    private String original;

    @BeforeEach
    void saveOriginal() {
        original = System.getProperty("todo.home");
    }

    @AfterEach
    void restore() {
        if (original == null) {
            System.clearProperty("todo.home");
        } else {
            System.setProperty("todo.home", original);
        }
    }

    @Test
    void usesSystemProperty() {
        System.setProperty("todo.home", "/tmp/todo-test");

        assertThat(new Config().dataDir()).isEqualTo(Path.of("/tmp/todo-test"));
    }
}
```

> ⚠️ **這種寫法有兩個危險，必須知道：**
>
> 1. **忘記在 `@AfterEach` 還原 → 污染後續測試。** 而且失敗會出現在
>    **別的測試類別**，你完全想不到是這裡造成的。
> 2. **平行執行時一定壞掉**（11.18 節）。系統屬性是整個 JVM 共用的，
>    兩個測試同時改就競態了。要加 `@Execution(SAME_THREAD)`
>    和 `@ResourceLock(Resources.SYSTEM_PROPERTIES)`。
>
> **所以：能用注入就用注入（正解一），不要碰全域狀態。**
> 只有在「無法修改那段程式碼」時才用正解二，而且務必寫好清理。

### 四類「不可測」的統一解法

| 全域狀態 | 抽成什麼依賴 | 測試時傳什麼 |
|---|---|---|
| `Instant.now()` / `LocalDate.now()` / `System.currentTimeMillis()` | `java.time.Clock` | `Clock.fixed(...)` / `MutableClock` |
| `Math.random()` / `new Random()` / `UUID.randomUUID()` | `RandomGenerator` / 自訂的 `IdGenerator` | 固定種子的 `Random` |
| `Files.*` 直接寫死路徑 | 建構子接 `Path` | `@TempDir` 給的路徑 |
| `System.getenv()` | `Function<String, String>` 或一個 `Config` 物件 | `Map.of(...)::get` |
| `System.out` / `System.err` | 建構子接 `PrintStream` / `PrintWriter` | `PrintStream(ByteArrayOutputStream)` |
| 靜態單例（`SomeManager.getInstance()`） | 建構子接介面 | mock 或 fake |

> 🔑 **這張表是本節的核心，也是整章最實用的一頁。**
>
> 注意它們的模式完全相同：**把「隱含的全域依賴」變成「明確的建構子參數」。**
> 這正是第 03 章 3.11 節「對介面編程」和第 02 站 Spring 依賴注入的同一個原理，
> 只是動機不同——那裡是為了替換實作，這裡是為了可測試。
>
> 而這也解釋了為什麼「可測試的設計」和「好的設計」高度重疊：
> **它們要求的是同一件事——明確的依賴。**

---

## 11.14 契約測試：一份測試，多個實作

### 問題

我們有兩個 `TodoRepository` 實作：`InMemoryTodoRepository`（第 04 章）
和 `JsonFileTodoRepository`（第 07 章）。加上測試用的 `FakeTodoRepository`，
共三個。

它們必須遵守同一份契約：

- `save` 之後 `findById` 查得到。
- `save` 同一個 id 兩次是更新，不是新增。
- `deleteById` 不存在的 id 回傳 `false`，不丟例外。
- `nextId` 每次回傳不同的正整數。
- `findAll` 回傳的集合修改不會影響儲存層（防禦性複製）。

如果每個實作各寫一份測試，會發生三件事：
複製貼上三次、加新規則時漏改一個、`FakeTodoRepository` 和真實實作行為悄悄分歧
（於是用 fake 的測試全綠，正式環境炸）。

### 解法一：抽象基底類別

```java
package com.example.todo.repository;

import com.example.todo.model.Priority;
import com.example.todo.model.Todo;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.List;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatNoException;

/**
 * TodoRepository 的契約測試。
 *
 * <p>每個實作都要有一個子類別 extends 這個類別並實作 {@link #createRepository()}。
 * 新增契約規則時只改這裡一個地方，所有實作立刻被驗證。
 */
@DisplayName("TodoRepository 契約")
abstract class TodoRepositoryContract {

    protected static final Instant NOW = Instant.parse("2026-08-17T10:00:00Z");

    /** 子類別提供一個乾淨的、空的 repository */
    protected abstract TodoRepository createRepository();

    protected Todo todo(long id, String title) {
        return new Todo(id, title, Priority.MEDIUM, NOW);
    }

    // ══════════════════════════════════════════════════════════
    @Nested
    @DisplayName("save + findById")
    class SaveAndFind {

        @Test
        @DisplayName("存進去之後查得到")
        void savedTodoIsFound() {
            TodoRepository repo = createRepository();

            repo.save(todo(1L, "買牛奶"));

            assertThat(repo.findById(1L)).get()
                    .extracting(Todo::title)
                    .isEqualTo("買牛奶");
        }

        @Test
        @DisplayName("不存在的 id 回傳空 Optional，不是 null、不丟例外")
        void unknownIdReturnsEmpty() {
            TodoRepository repo = createRepository();

            assertThat(repo.findById(999L)).isEmpty();
        }

        @Test
        @DisplayName("存同一個 id 兩次是更新，不是新增")
        void saveSameIdTwiceUpdates() {
            TodoRepository repo = createRepository();
            Todo first = todo(1L, "買牛奶");
            repo.save(first);

            Todo updated = todo(1L, "買醬油");
            repo.save(updated);

            assertThat(repo.findAll()).hasSize(1);
            assertThat(repo.findById(1L)).get()
                    .extracting(Todo::title)
                    .isEqualTo("買醬油");
        }

        @Test
        @DisplayName("save 回傳存好的實體")
        void saveReturnsSavedEntity() {
            TodoRepository repo = createRepository();
            Todo todo = todo(1L, "買牛奶");

            Todo returned = repo.save(todo);

            assertThat(returned.id()).isEqualTo(1L);
            assertThat(returned.title()).isEqualTo("買牛奶");
        }
    }

    // ══════════════════════════════════════════════════════════
    @Nested
    @DisplayName("findAll")
    class FindAll {

        @Test
        @DisplayName("空的 repository 回傳空清單，不是 null")
        void emptyRepositoryReturnsEmptyList() {
            assertThat(createRepository().findAll()).isNotNull().isEmpty();
        }

        @Test
        @DisplayName("回傳全部，且修改回傳的清單不會影響儲存層")
        void returnsDefensiveCopy() {
            TodoRepository repo = createRepository();
            repo.save(todo(1L, "買牛奶"));
            repo.save(todo(2L, "寫測試"));

            List<Todo> firstCall = repo.findAll();
            assertThat(firstCall).hasSize(2);

            // 試著破壞它（如果是不可變清單，這裡會丟例外——也算通過契約）
            try {
                firstCall.clear();
            } catch (UnsupportedOperationException expected) {
                // 不可變清單，更好
            }

            assertThat(repo.findAll())
                    .as("修改 findAll 的回傳值不該影響儲存層（第 02 章 2.12 節）")
                    .hasSize(2);
        }
    }

    // ══════════════════════════════════════════════════════════
    @Nested
    @DisplayName("deleteById")
    class DeleteById {

        @Test
        @DisplayName("刪掉存在的 id 回傳 true，之後查不到")
        void deletesExisting() {
            TodoRepository repo = createRepository();
            repo.save(todo(1L, "買牛奶"));

            assertThat(repo.deleteById(1L)).isTrue();
            assertThat(repo.findById(1L)).isEmpty();
        }

        @Test
        @DisplayName("刪掉不存在的 id 回傳 false，不丟例外")
        void deletingUnknownIdReturnsFalse() {
            TodoRepository repo = createRepository();

            assertThatNoException().isThrownBy(() -> repo.deleteById(999L));
            assertThat(repo.deleteById(999L)).isFalse();
        }

        @Test
        @DisplayName("刪兩次：第一次 true，第二次 false")
        void deleteIsNotIdempotentInReturnValue() {
            TodoRepository repo = createRepository();
            repo.save(todo(1L, "買牛奶"));

            assertThat(repo.deleteById(1L)).isTrue();
            assertThat(repo.deleteById(1L)).isFalse();
        }
    }

    // ══════════════════════════════════════════════════════════
    @Nested
    @DisplayName("nextId")
    class NextId {

        @Test
        @DisplayName("每次回傳不同的正整數")
        void returnsDistinctPositiveIds() {
            TodoRepository repo = createRepository();

            Set<Long> ids = new java.util.HashSet<>();
            for (int i = 0; i < 100; i++) {
                long id = repo.nextId();
                assertThat(id).isPositive();
                ids.add(id);
            }

            assertThat(ids).as("100 次呼叫應產生 100 個不同的 id").hasSize(100);
        }

        @Test
        @DisplayName("已有資料時，nextId 不會撞到既有的 id")
        void doesNotCollideWithExisting() {
            TodoRepository repo = createRepository();
            repo.save(todo(1L, "第一"));
            repo.save(todo(2L, "第二"));

            long next = repo.nextId();

            assertThat(repo.findById(next))
                    .as("nextId 產生的 id 不該已經被用掉")
                    .isEmpty();
        }
    }
}
```

三個實作各寫一個**只有五行**的子類別：

```java
package com.example.todo.repository;

import org.junit.jupiter.api.DisplayName;

@DisplayName("InMemoryTodoRepository")
class InMemoryTodoRepositoryTest extends TodoRepositoryContract {

    @Override
    protected TodoRepository createRepository() {
        return new InMemoryTodoRepository();
    }
}
```

```java
package com.example.todo.repository;

import com.example.todo.support.Json;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;

@DisplayName("JsonFileTodoRepository")
class JsonFileTodoRepositoryContractTest extends TodoRepositoryContract {

    @TempDir
    Path tempDir;

    private int counter;

    @Override
    protected TodoRepository createRepository() {
        // 每次呼叫給一個新檔案，確保「乾淨的 repository」
        return new JsonFileTodoRepository(tempDir.resolve("todos-" + counter++ + ".json"), new Json());
    }
}
```

```java
package com.example.todo.repository;

import org.junit.jupiter.api.DisplayName;

@DisplayName("FakeTodoRepository")
class FakeTodoRepositoryTest extends TodoRepositoryContract {

    @Override
    protected TodoRepository createRepository() {
        return new FakeTodoRepository();
    }
}
```

執行結果：

```
InMemoryTodoRepository
  save + findById
    ✓ 存進去之後查得到
    ✓ 不存在的 id 回傳空 Optional，不是 null、不丟例外
    ✓ 存同一個 id 兩次是更新，不是新增
    ✓ save 回傳存好的實體
  findAll
    ✓ 空的 repository 回傳空清單，不是 null
    ✓ 回傳全部，且修改回傳的清單不會影響儲存層
  deleteById
    ✓ 刪掉存在的 id 回傳 true，之後查不到
    ✓ 刪掉不存在的 id 回傳 false，不丟例外
    ✓ 刪兩次：第一次 true，第二次 false
  nextId
    ✓ 每次回傳不同的正整數
    ✓ 已有資料時，nextId 不會撞到既有的 id
JsonFileTodoRepository
  （同樣 11 個）
FakeTodoRepository
  （同樣 11 個）
```

**11 條規則 × 3 個實作 = 33 個測試，而規則只寫了一次。**

### 契約測試的三個回報

**① 抓出 fake 和真實實作的分歧**

這是最大的價值。`FakeTodoRepository` 現在被同一份契約驗證，
所以「用 fake 的單元測試通過，但正式環境炸」這件事不會再發生
——除了契約沒涵蓋的部分（所以契約要盡量完整）。

**② 新增實作時，正確性是免費的**

第 06～08 站會加 `JdbcTodoRepository` 和 `JpaTodoRepository`。
到時候只要：

```java
@DisplayName("JdbcTodoRepository")
@Testcontainers
class JdbcTodoRepositoryTest extends TodoRepositoryContract {

    @Container
    static PostgreSQLContainer<?> db = new PostgreSQLContainer<>("postgres:16-alpine");

    @Override
    protected TodoRepository createRepository() {
        return new JdbcTodoRepository(dataSourceFor(db));
    }
}
```

11 條規則立刻套用。**你會馬上發現 SQL 實作的行為差異**——
例如 `deleteById` 回傳的是 `affectedRows > 0` 還是永遠 `true`。

**③ 契約本身成為介面的文件**

`TodoRepository` 的 Javadoc 寫「`@return true 表示真的刪掉了」，
但那只是文字。契約測試是**可執行的文件**——它不會過期，
因為過期就是紅燈。

### 解法二：測試介面 + `default` 方法

JUnit 5 支援**介面上的 `@Test`**（配 `default` 方法）。
這比抽象類別更有彈性，因為一個測試類別可以實作**多個**契約介面：

```java
package com.example.todo.repository;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

/** 「存了之後查得到」這一組契約 */
interface SaveAndFindContract {

    TodoRepository repository();

    Todo sampleTodo(long id, String title);

    @Test
    default void savedTodoIsFound() {
        repository().save(sampleTodo(1L, "買牛奶"));

        assertThat(repository().findById(1L)).isPresent();
    }
}
```

```java
/** 「執行緒安全」這一組契約——只有部分實作需要遵守 */
interface ThreadSafetyContract {

    TodoRepository repository();

    @Test
    default void concurrentSavesDoNotLoseData() throws Exception {
        // ... 11.15 節的併發測試
    }
}
```

```java
// JsonFileTodoRepository 要遵守兩份契約
class JsonFileTodoRepositoryTest
        implements SaveAndFindContract, ThreadSafetyContract {

    // ... 實作兩個介面要求的方法
}

// InMemoryTodoRepository 只遵守第一份（它沒有宣稱執行緒安全）
class InMemoryTodoRepositoryTest implements SaveAndFindContract {
    // ...
}
```

> **兩種解法怎麼選？**
>
> | | 抽象類別 | 測試介面 |
> |---|---|---|
> | 一個實作只有一份契約 | ✅ 簡單直接 | 過度設計 |
> | 契約可以「選配」（執行緒安全、可排序、支援交易） | ❌ 做不到 | ✅ 多重實作 |
> | 需要共用欄位（`@TempDir`、`@Mock`） | ✅ 方便 | 要每個類別自己宣告 |
> | 可讀性 | 較好（`extends` 一眼看到） | 需要多跳一層 |
>
> **建議：從抽象類別開始。** 只有在真的出現「選配契約」時才升級成介面。
> 我們的 Todo 專案用抽象類別就夠了。

---
## 11.15 併發程式的測試

第 08 章寫了 `ConcurrentTodoImporter`，用虛擬執行緒併發匯入多個來源。
怎麼測它？

先說一個必須誠實面對的事實：

> **併發測試只能證明 bug 存在，不能證明 bug 不存在。**
>
> 一個競態條件可能在你的機器上跑一萬次都不出現，卻在正式環境的第三次
> 就炸掉——因為核心數、快取行為、JIT 最佳化、負載都不同。
>
> 所以併發測試的目標不是「證明正確」，而是**「大幅提高抓到問題的機率」**。

### ❌ 第一個反面教材：`Thread.sleep`

```java
// ❌ 錯得非常典型
@Test
void importsAllSources() throws InterruptedException {
    importer.importFrom(List.of(source1, source2, source3));

    Thread.sleep(1000);      // 「等一下應該就好了吧」

    assertThat(repository.findAll()).hasSize(30);
}
```

三個問題：

1. **慢。** 匯入可能 50 ms 就完成，你卻等了 1000 ms。100 個這種測試 = CI 多 100 秒。
2. **不穩。** CI 機器忙碌時 1000 ms 不夠，測試隨機失敗。
   然後有人把它改成 3000 ms，CI 更慢，但還是會偶爾失敗。
3. **不精確。** 失敗時你不知道是「邏輯錯」還是「等不夠久」。

**`Thread.sleep` 在測試裡幾乎永遠是錯的。** 唯一例外是「刻意製造延遲來觸發競態」
（見下方的 `SlowSource`）。等待結果一律用下面兩種方式。

### ✅ 方式一：`CountDownLatch`（精確同步）

```java
package com.example.todo.importer;

import com.example.todo.model.Priority;
import com.example.todo.model.Todo;
import com.example.todo.repository.FakeTodoRepository;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;

@DisplayName("併發寫入")
class ConcurrentWriteTest {

    private static final Instant NOW = Instant.parse("2026-08-17T10:00:00Z");

    @Test
    @Timeout(10)
    @DisplayName("100 條執行緒同時新增，不會遺失任何一筆")
    void concurrentSavesDoNotLoseData() throws Exception {
        int threads = 100;
        var repository = new FakeTodoRepository();   // 假設它是執行緒安全的實作

        // ① 起跑閘門：讓所有執行緒「同時」開始，最大化競爭
        CountDownLatch startGate = new CountDownLatch(1);
        // ② 終點閘門：主執行緒等所有人跑完
        CountDownLatch finishGate = new CountDownLatch(threads);
        List<Future<?>> futures = new ArrayList<>();

        try (ExecutorService pool = Executors.newVirtualThreadPerTaskExecutor()) {
            for (int i = 0; i < threads; i++) {
                final long id = i + 1;
                futures.add(pool.submit(() -> {
                    try {
                        startGate.await();          // 所有人卡在這裡
                        repository.save(new Todo(id, "第 " + id + " 筆",
                                Priority.MEDIUM, NOW));
                    } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();   // 第 08 章 8.3 節
                        throw new IllegalStateException(e);
                    } finally {
                        finishGate.countDown();
                    }
                }));
            }

            startGate.countDown();                   // 一聲令下，全部同時衝

            assertThat(finishGate.await(5, TimeUnit.SECONDS))
                    .as("所有執行緒應在 5 秒內完成")
                    .isTrue();
        }

        // ③ 逐一 get()：子執行緒的例外在這裡才會浮出來（見本節結尾的警告）
        for (Future<?> future : futures) {
            future.get();
        }

        assertThat(repository.findAll())
                .as("100 次新增應該有 100 筆，一筆都不能少")
                .hasSize(threads);
    }
}
```

**`startGate` 這個模式很重要。** 沒有它，第 1 條執行緒可能在第 100 條
還沒建立時就跑完了——根本沒有併發，測試等於白寫。
起跑閘門讓所有執行緒**同時**進入臨界區，把競爭機率拉到最高。

> 這正是第 08 章 8.4 節「親眼看到競態條件」用的技巧。
> 沒有 `startGate` 的併發測試，抓到 bug 的機率可能低於 1%。

### ✅ 方式二：Awaitility（等待非同步結果）

當結果是「稍後才會出現」（背景執行緒、事件、輪詢）：

```java
import static org.awaitility.Awaitility.await;

@Test
@DisplayName("背景匯入完成後，資料會出現在 repository")
void importsInBackground() {
    importer.importAsync(List.of(source1, source2));      // 立刻回傳

    await().atMost(Duration.ofSeconds(5))
           .pollInterval(Duration.ofMillis(20))
           .untilAsserted(() ->
                   assertThat(repository.findAll()).hasSize(30));
}
```

**Awaitility 比 `Thread.sleep` 好在哪：**

| | `Thread.sleep(1000)` | `await().atMost(5s)` |
|---|---|---|
| 條件在 20 ms 達成 | 還是等 1000 ms | **20 ms 就往下走** |
| 條件在 1500 ms 達成 | 失敗（等不夠久） | 通過 |
| 條件永遠不達成 | 失敗，訊息是「size 是 0 不是 30」 | 失敗，訊息是「等了 5 秒，最後一次斷言：size 是 0 不是 30」 |
| CI 慢的時候 | 隨機失敗 | 只要在上限內就通過 |

其他好用的寫法：

```java
// 等某個條件成立
await().until(() -> repository.findAll().size() == 30);

// 等一個值變成期望值（失敗訊息會印出實際值）
await().untilAtomic(counter, equalTo(30));

// 先等 100 ms 再開始輪詢（避免測到「初始狀態剛好符合」）
await().pollDelay(Duration.ofMillis(100))
       .atMost(Duration.ofSeconds(5))
       .untilAsserted(() -> assertThat(repository.findAll()).hasSize(30));

// 驗證「在這段時間內都保持不變」（測「不該發生的事沒發生」）
await().during(Duration.ofSeconds(1))
       .atMost(Duration.ofSeconds(2))
       .untilAsserted(() -> assertThat(repository.findAll()).isEmpty());
```

> ⚠️ **`atMost` 的值要設得慷慨一點。** 本機 200 ms 就完成的事，
> CI 上可能要 2 秒（共用機器、冷啟動、JIT 還沒暖）。
> **設 5 秒不會讓成功的測試變慢**（條件達成就立刻往下），
> 只影響「真的失敗」時要等多久。這是 Awaitility 相對 `sleep` 的關鍵優勢。

### 用 `@RepeatedTest` 提高抓到競態的機率

競態條件是機率事件。跑一次可能永遠抓不到，跑一百次就有機會：

```java
@RepeatedTest(value = 100, name = "第 {currentRepetition}/{totalRepetitions} 次")
@DisplayName("重複執行以提高抓到競態的機率")
void concurrentMarkDoneIsSafe() throws Exception {
    // ... 每次都用全新的 repository 與 service
}
```

> ⚠️ **`@RepeatedTest` 是「提高機率」，不是「保證」。**
> 而且它會讓測試變慢 100 倍。
>
> **實務做法**：把重複次數設成可調的，本機跑 5 次、CI 的 nightly job 跑 1000 次：
>
> ```java
> @RepeatedTest(value = 100)
> // 或用系統屬性：-Dconcurrency.repeat=1000
> ```
>
> 真正嚴肅的併發驗證要用 **jcstress**（OpenJDK 的併發壓力測試框架），
> 它會做 bytecode 層級的重排與大量迭代。但那是寫**函式庫**時才需要的工具，
> 寫應用程式用上面的技巧就夠了。

### 測試「應該要壞掉」的版本

最有說服力的併發測試，是**先證明沒有同步時真的會壞**：

```java
@Test
@DisplayName("沒有同步的實作真的會遺失資料（證明我們的鎖是必要的）")
void unsafeImplementationLosesData() throws Exception {
    // 一個故意不同步的實作
    class UnsafeRepository implements TodoRepository {
        private final Map<Long, Todo> store = new HashMap<>();   // 非執行緒安全！
        @Override public Todo save(Todo t) { store.put(t.id(), t); return t; }
        @Override public List<Todo> findAll() { return new ArrayList<>(store.values()); }
        // ... 其餘方法略
    }

    var unsafe = new UnsafeRepository();
    // ... 用上面的 startGate 模式，100 條執行緒同時 save

    // HashMap 在併發寫入下可能遺失資料、甚至無限迴圈（第 05 章 5.7 節）
    // 這個斷言「大部分時候」會失敗——這正是重點
    assertThat(unsafe.findAll().size())
            .as("非執行緒安全的實作在併發下會遺失資料")
            .isLessThan(100);
}
```

> ⚠️ **但這種測試本身是 flaky 的**（它斷言「應該會壞」，但偶爾不會壞）。
>
> **所以不要把它放進 CI。** 它的用途是**教學與驗證假設**——
> 在你懷疑「真的需要加鎖嗎」的時候，寫一個這樣的測試跑給自己看。
> 確認之後把它刪掉或標 `@Disabled("示範用，本質上 flaky")`。

### 測第 08 章的 `ConcurrentTodoImporter`

實際的測試策略：**把併發的部分和邏輯的部分分開測。**

```java
package com.example.todo.importer;

import com.example.todo.model.Todo;
import com.example.todo.repository.FakeTodoRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;

@DisplayName("ConcurrentTodoImporter")
class ConcurrentTodoImporterTest {

    private static final Instant NOW = Instant.parse("2026-08-17T10:00:00Z");

    FakeTodoRepository repository;
    Clock clock;

    @BeforeEach
    void setUp() {
        repository = new FakeTodoRepository();
        clock = Clock.fixed(NOW, ZoneOffset.UTC);
    }

    // ── 測試用的來源（fake，不是 mock） ──

    /** 立刻回傳固定資料 */
    record StaticSource(String name, List<String[]> rows) implements TodoSource {
        @Override public List<String[]> read() {
            return rows;
        }
    }

    /** 會慢慢回傳——用來驗證「真的是併發跑的」 */
    record SlowSource(String name, Duration delay, List<String[]> rows) implements TodoSource {
        @Override public List<String[]> read() throws InterruptedException {
            Thread.sleep(delay.toMillis());     // ← 這是「刻意製造延遲」，不是「等結果」
            return rows;
        }
    }

    /** 一定失敗 */
    record FailingSource(String name, String reason) implements TodoSource {
        @Override public List<String[]> read() {
            throw new IllegalStateException(reason);
        }
    }

    // ══════════════════════════════════════════════════════════
    @Nested
    @DisplayName("匯入結果")
    class Results {

        @Test
        @DisplayName("合併所有來源的資料")
        void mergesAllSources() {
            var importer = new ConcurrentTodoImporter(repository, clock, 10);

            ImportResult result = importer.importFrom(List.of(
                    new StaticSource("A", rows("A1", "A2")),
                    new StaticSource("B", rows("B1")),
                    new StaticSource("C", rows("C1", "C2", "C3"))));

            assertThat(result.imported()).isEqualTo(6);
            assertThat(result.failed()).isZero();
            assertThat(repository.findAll())
                    .extracting(Todo::title)
                    .containsExactlyInAnyOrder("A1", "A2", "B1", "C1", "C2", "C3");
        }

        @Test
        @DisplayName("單一來源失敗不影響其他來源（第 08 章的部分失敗策略）")
        void partialFailureDoesNotStopOthers() {
            var importer = new ConcurrentTodoImporter(repository, clock, 10);

            ImportResult result = importer.importFrom(List.of(
                    new StaticSource("A", rows("A1", "A2")),
                    new FailingSource("B", "連線逾時"),
                    new StaticSource("C", rows("C1"))));

            assertThat(result.imported()).isEqualTo(3);
            assertThat(result.failed()).isEqualTo(1);
            assertThat(result.errors())
                    .hasSize(1)
                    .allSatisfy(e -> {
                        assertThat(e.sourceName()).isEqualTo("B");
                        assertThat(e.message()).contains("連線逾時");
                    });
            assertThat(repository.findAll()).hasSize(3);
        }
    }

    // ══════════════════════════════════════════════════════════
    @Nested
    @DisplayName("併發行為")
    class Concurrency {

        @Test
        @Timeout(5)
        @DisplayName("五個各需 200ms 的來源，總時間應遠小於 1 秒（證明是併發不是循序）")
        void runsSourcesConcurrently() {
            var importer = new ConcurrentTodoImporter(repository, clock, 10);
            List<TodoSource> slow = java.util.stream.IntStream.rangeClosed(1, 5)
                    .mapToObj(i -> (TodoSource) new SlowSource(
                            "S" + i, Duration.ofMillis(200), rows("T" + i)))
                    .toList();

            long start = System.nanoTime();
            ImportResult result = importer.importFrom(slow);
            Duration elapsed = Duration.ofNanos(System.nanoTime() - start);

            assertThat(result.imported()).isEqualTo(5);
            assertThat(elapsed)
                    .as("循序執行要 1000ms，併發應該接近 200ms")
                    .isLessThan(Duration.ofMillis(700));
        }

        @Test
        @Timeout(10)
        @DisplayName("Semaphore 限制同時執行的來源數不超過設定值")
        void respectsConcurrencyLimit() {
            AtomicInteger inFlight = new AtomicInteger();
            AtomicInteger peak = new AtomicInteger();

            // 每個來源進入時記錄「同時有幾個在跑」
            List<TodoSource> counting = java.util.stream.IntStream.rangeClosed(1, 20)
                    .mapToObj(i -> (TodoSource) new TodoSource() {
                        @Override public String name() {
                            return "S" + i;
                        }
                        @Override public List<String[]> read() throws InterruptedException {
                            int now = inFlight.incrementAndGet();
                            peak.updateAndGet(p -> Math.max(p, now));
                            try {
                                Thread.sleep(50);
                                return rows("T" + i);
                            } finally {
                                inFlight.decrementAndGet();
                            }
                        }
                    })
                    .toList();

            new ConcurrentTodoImporter(repository, clock, 3).importFrom(counting);

            assertThat(peak.get())
                    .as("同時執行的來源數不該超過 Semaphore 的許可數")
                    .isLessThanOrEqualTo(3);
        }
    }

    private static List<String[]> rows(String... titles) {
        return java.util.Arrays.stream(titles)
                .map(t -> new String[]{t, "MEDIUM"})
                .toList();
    }
}
```

**注意這裡的兩個設計：**

1. **來源用 fake（`record` 實作介面）而不是 mock。**
   `SlowSource` 要「真的慢」，這用 mock 很難自然地表達。
   而且 `record` 實作介面只要一行，比 `mock(...)` + 三行 stub 更短。

2. **「證明真的是併發」的測試用時間斷言。**
   `isLessThan(700ms)` 這個上限很寬鬆——它不是在測效能，
   而是在區分「200 ms（併發）」和「1000 ms（循序）」這兩個數量級。
   **時間斷言只能用來區分數量級，絕不能用來測「必須小於 210 ms」這種精確值。**

### 併發測試的檢查清單

| 檢查 | 為什麼 |
|---|---|
| 有沒有用 `Thread.sleep` 等結果？ | 改用 `CountDownLatch` / Awaitility |
| 所有執行緒是不是「同時」開始？ | 沒有 `startGate` 的話，可能根本沒併發 |
| 有沒有 `@Timeout`？ | 死鎖時才不會卡到 CI job timeout |
| 子執行緒的例外有沒有被看見？ | 子執行緒丟例外**不會**讓測試失敗！要用 `AtomicInteger` 或 `Future.get()` 收集 |
| 時間斷言是不是只在區分數量級？ | 精確的時間斷言在 CI 上必 flaky |
| 這個測試會不會污染其他測試？ | 執行緒池要 close，`ThreadLocal` 要清（第 08 章 8.13 節） |

> 🔥 **「子執行緒的例外不會讓測試失敗」是最容易吃虧的一點。**
>
> ```java
> // ❌ 這個測試永遠通過，即使 save 每次都丟例外
> pool.submit(() -> repository.save(todo));      // 例外被 Future 吞掉
> ```
>
> `ExecutorService.submit` 回傳 `Future`，例外被存在裡面。
> 你不呼叫 `get()` 就永遠看不到它（第 08 章 8.12 節）。
>
> ```java
> // ✅ 收集 Future 並逐一 get()
> List<Future<?>> futures = new ArrayList<>();
> for (int i = 0; i < threads; i++) {
>     futures.add(pool.submit(() -> repository.save(todo(i))));
> }
> for (Future<?> f : futures) {
>     f.get();      // 有例外會在這裡丟出來，測試才會紅
> }
> ```

---

## 11.16 覆蓋率與突變測試

### 設定 JaCoCo

```xml
<plugin>
  <groupId>org.jacoco</groupId>
  <artifactId>jacoco-maven-plugin</artifactId>
  <version>0.8.12</version>
  <executions>
    <!-- 1. 在 test 之前掛上 agent，把參數放進 ${argLine} -->
    <execution>
      <id>prepare-agent</id>
      <goals><goal>prepare-agent</goal></goals>
    </execution>

    <!-- 2. 產生 HTML / XML 報告 -->
    <execution>
      <id>report</id>
      <phase>verify</phase>
      <goals><goal>report</goal></goals>
    </execution>

    <!-- 3. 門檻不到就讓建置失敗 -->
    <execution>
      <id>check</id>
      <phase>verify</phase>
      <goals><goal>check</goal></goals>
      <configuration>
        <rules>
          <rule>
            <element>BUNDLE</element>          <!-- 整個模組 -->
            <limits>
              <limit>
                <counter>LINE</counter>
                <value>COVEREDRATIO</value>
                <minimum>0.80</minimum>
              </limit>
              <limit>
                <counter>BRANCH</counter>
                <value>COVEREDRATIO</value>
                <minimum>0.70</minimum>
              </limit>
            </limits>
          </rule>
          <rule>
            <element>CLASS</element>           <!-- 每個類別 -->
            <limits>
              <limit>
                <counter>LINE</counter>
                <value>COVEREDRATIO</value>
                <minimum>0.50</minimum>        <!-- 不能有完全沒測的類別 -->
              </limit>
            </limits>
            <excludes>
              <exclude>com.example.todo.App</exclude>   <!-- main 由 IT 測 -->
            </excludes>
          </rule>
        </rules>
      </configuration>
    </execution>
  </executions>
</plugin>
```

```bash
./mvnw clean verify
open target/site/jacoco/index.html
```

> ⚠️ **記得第 10 章 10.10 節的坑**：surefire 的 `<argLine>` 一定要保留
> `@{argLine}`，否則 JaCoCo 的 agent 參數被覆蓋，覆蓋率變 0%。

**報告怎麼看：**

```
Element                    Missed Instructions  Cov.   Missed Branches  Cov.
com.example.todo.model     ████████████░░░░     87%    ██████████░░     78%
com.example.todo.service   ██████████████░░     91%    ████████████░    85%
com.example.todo.repository ███████░░░░░░░░     54%    █████░░░░░░░     41%   ← 這裡
com.example.todo.importer  ████████████████     96%    ██████████████   92%
```

**綠色 = 執行過、黃色 = 分支只走了一半、紅色 = 完全沒執行。**

黃色最有價值：它指出「這個 `if` 你只測了 true，沒測 false」。

### 覆蓋率會騙你的兩種情況

**騙法一：沒有斷言的測試**

```java
// 這個測試讓 TodoService 的覆蓋率變 100%，但它什麼都沒驗證
@Test
void coversEverything() {
    service.add("買牛奶", Priority.HIGH);
    service.markDone(1L);
    service.findAll();
    service.remove(1L);
    // 沒有任何 assert！
}
```

**每一行都被執行了 → 100% 行覆蓋率。**
但即使 `markDone` 把資料存成錯的、`findAll` 排序完全錯亂，測試依然綠。

這不是假想的問題——當團隊被要求「覆蓋率要 80%」時，**這正是最快達標的方式**。

**騙法二：行覆蓋率 vs 分支覆蓋率**

```java
public String describe(Todo todo) {
    return todo.isDone() ? "已完成" : "待辦";
}
```

```java
@Test
void describes() {
    assertThat(service.describe(pendingTodo)).isEqualTo("待辦");
}
```

**行覆蓋率：100%**（那一行執行了）。
**分支覆蓋率：50%**（`isDone() == true` 的路徑從沒走過）。

如果有人把 `"已完成"` 打成 `"已完城"`，這個測試抓不到。

> **所以：看報告時，分支覆蓋率比行覆蓋率重要得多。**
> 我的門檻設定習慣是「行 80% / 分支 70%」——分支的門檻低一點，
> 因為有些分支（`Objects.requireNonNull`、防禦性檢查）真的不值得為它寫測試。

### 覆蓋率的正確用法

> 🔑 **覆蓋率是「找出沒測到的地方」的工具，不是「衡量測試品質」的指標。**

| ✅ 正確用法 | ❌ 錯誤用法 |
|---|---|
| 打開報告，看**紅色的區塊**，問「這裡為什麼沒測到？」 | 把數字當 KPI，要求「這一季要從 72% 到 85%」 |
| 看**新增程式碼**的覆蓋率（PR 上的 diff coverage） | 看整個專案的絕對數字 |
| 把它當「我是不是漏了某條路徑」的提醒 | 把它當「我的測試夠不夠好」的證明 |
| 設一個**下限**防止倒退 | 追求 100% |

**追求 100% 的三個壞處：**

1. 你會為了 getter、`toString`、`equals` 寫沒有價值的測試。
2. 你會為了「不可能發生」的防禦性分支寫測試（或更糟：把防禦刪掉）。
3. 團隊學到的是「數字重要」而不是「行為正確重要」。

**合理的目標**：核心業務邏輯（service、model、計算）**高覆蓋 + 高品質斷言**；
邊界層（DTO、設定類別、`main`）**不強求**。

### 突變測試：檢驗你的測試

覆蓋率回答「這行有沒有被執行」。**突變測試回答「這行改壞了，測試會不會發現」**
——這才是我們真正想知道的。

原理：PIT 自動修改你的 bytecode（產生「突變體」），然後跑你的測試。

```
原始：if (trimmed.length() > MAX_TITLE_LENGTH)
突變：if (trimmed.length() >= MAX_TITLE_LENGTH)      ← 邊界條件突變
突變：if (trimmed.length() < MAX_TITLE_LENGTH)       ← 條件反轉
突變：if (true)                                       ← 移除條件
```

- 測試**紅了** → 突變被「殺死」✅ 你的測試有效。
- 測試**還是綠的** → 突變「存活」❌ **你的測試沒有真正驗證這行。**

**設定：**

```xml
<plugin>
  <groupId>org.pitest</groupId>
  <artifactId>pitest-maven</artifactId>
  <version>1.17.0</version>
  <dependencies>
    <dependency>
      <groupId>org.pitest</groupId>
      <artifactId>pitest-junit5-plugin</artifactId>
      <version>1.2.1</version>
    </dependency>
  </dependencies>
  <configuration>
    <targetClasses>
      <param>com.example.todo.model.*</param>
      <param>com.example.todo.service.*</param>
    </targetClasses>
    <targetTests>
      <param>com.example.todo.*</param>
    </targetTests>
    <mutationThreshold>70</mutationThreshold>
    <timeoutConstant>5000</timeoutConstant>
  </configuration>
</plugin>
```

```bash
./mvnw test org.pitest:pitest-maven:mutationCoverage
open target/pit-reports/index.html
```

**輸出：**

```
================================================================================
- Statistics
================================================================================
>> Line Coverage (for mutated classes only): 142/158 (90%)
>> Generated 87 mutations Killed 71 (82%)
>> Mutations with no coverage 6. Test strength 88%
>> Ran 412 tests (4.74 tests per mutation)
```

**報告會精確指出哪個突變活下來：**

```
Todo.java
 62  1. changed conditional boundary → SURVIVED
        if (trimmed.length() > MAX_TITLE_LENGTH)
        ↑ 把 > 改成 >= 之後，你的測試還是全綠
```

**這就是 11.9 節說的「一定要測 100 和 101」的自動化證明。**
補上 `@ValueSource(ints = {100})` 這一組之後，突變就被殺死了。

> **突變測試的代價**：慢。它要為每個突變跑一次相關的測試。
> 中型專案跑 10～30 分鐘是常態。
>
> **實務做法**：
> - **不要**放進每次 push 的 CI。
> - 放進 **nightly job**，或用 `<historyInputFile>` 做增量分析。
> - 或用 `scmMutationCoverage` goal，**只分析這次改動的檔案**（幾秒鐘）。
>
> ```bash
> ./mvnw org.pitest:pitest-maven:scmMutationCoverage
> ```

> 🔑 **如果你這一章只帶走一個工具，選突變測試。**
> 覆蓋率報告會讓你自我感覺良好；突變報告會告訴你哪些測試是假的。
> 第一次跑通常是個震撼教育——「我有 92% 覆蓋率，但突變分數只有 54%」。

---

## 11.17 整合測試與測試分流

### 命名約定決定誰來跑

第 10 章 10.10 節設定過 surefire 和 failsafe。回顧一下分工：

| | surefire（`mvn test`） | failsafe（`mvn verify`） |
|---|---|---|
| 檔名 | `*Test`、`Test*`、`*Tests`、`*TestCase` | `IT*`、`*IT`、`*ITCase` |
| 何時跑 | 每次改程式碼 | 提交前、CI |
| 速度要求 | 全部加起來 < 30 秒 | 幾分鐘可接受 |
| 能用真實資源嗎 | ❌ 不行 | ✅ DB、Docker、網路 |

**所以：把整合測試命名成 `XxxIT`，它就自動只在 `mvn verify` 時跑。**
本機開發用 `mvn test`（快速回饋），提交前用 `mvn verify`（完整驗證）。

### 用 `@Tag` 做更細的分流

```java
@Tag("slow")
@Tag("docker")
class TodoRepositoryPostgresIT { }
```

```xml
<!-- 本機預設跳過需要 Docker 的測試 -->
<plugin>
  <groupId>org.apache.maven.plugins</groupId>
  <artifactId>maven-failsafe-plugin</artifactId>
  <version>3.5.0</version>
  <configuration>
    <excludedGroups>${excluded.test.groups}</excludedGroups>
  </configuration>
</plugin>
```

```xml
<properties>
  <excluded.test.groups>docker</excluded.test.groups>
</properties>

<profiles>
  <profile>
    <id>ci</id>
    <properties>
      <excluded.test.groups></excluded.test.groups>   <!-- CI 上全跑 -->
    </properties>
  </profile>
</profiles>
```

```bash
./mvnw verify              # 跳過 docker 標籤的測試
./mvnw verify -Pci         # 全部跑
```

也可以用標籤運算式：

```bash
./mvnw test -Dgroups="fast & !flaky"
./mvnw test -Dgroups="unit | contract"
```

### CLI 的端對端整合測試

我們的 `App` 目前直接用 `System.out`——這讓輸出無法驗證。
先做一個**小小的重構**，把輸出也變成注入的依賴（11.13 節的模式）：

```java
public final class App {

    private final TodoService service;
    private final ZoneId displayZone;
    private final PrintStream out;      // ← 新增
    private final PrintStream err;      // ← 新增

    /** 正式環境用的建構子 */
    App(TodoService service, ZoneId displayZone) {
        this(service, displayZone, System.out, System.err);
    }

    /** 測試用的建構子：可以把輸出導到 ByteArrayOutputStream */
    App(TodoService service, ZoneId displayZone, PrintStream out, PrintStream err) {
        this.service = service;
        this.displayZone = displayZone;
        this.out = out;
        this.err = err;
    }

    // 然後把方法裡所有 System.out.printf 換成 out.printf，
    // System.err.println 換成 err.println
}
```

> **這個重構值不值得？** 值得，而且不只為了測試。
> 有了它，你之後想加 `--quiet`、`--json`、寫進檔案、
> 或在第 02 站把 CLI 改成 Web 服務時，輸出目的地都是可換的。
>
> **「為了可測試而做的設計改動，幾乎總是也讓程式碼更有彈性」**
> ——這是 11.13 節那張表背後的真正原因。

```java
package com.example.todo;

import com.example.todo.model.Priority;
import com.example.todo.repository.JsonFileTodoRepository;
import com.example.todo.service.ConsoleNotifier;
import com.example.todo.service.TodoService;
import com.example.todo.support.Json;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.ByteArrayOutputStream;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * CLI 的端對端整合測試。
 *
 * <p>用真實的 JsonFileTodoRepository（寫真的檔案，在 @TempDir 裡），
 * 只有時鐘是固定的。這驗證的是「所有元件接起來會動」——
 * 序列化、檔案讀寫、排序、輸出格式、離開碼，全部一起。
 *
 * <p>命名為 *IT，所以只有 mvn verify 會跑（第 10 章 10.10 節）。
 */
@DisplayName("Todo CLI 端對端")
class AppIT {

    private static final Instant NOW = Instant.parse("2026-08-17T10:00:00Z");

    @TempDir
    Path tempDir;

    private ByteArrayOutputStream outBuffer;
    private ByteArrayOutputStream errBuffer;
    private App app;

    @BeforeEach
    void setUp() {
        outBuffer = new ByteArrayOutputStream();
        errBuffer = new ByteArrayOutputStream();

        TodoService service = new TodoService(
                new JsonFileTodoRepository(tempDir.resolve("todos.json"), new Json()),
                Clock.fixed(NOW, ZoneOffset.UTC),
                new ConsoleNotifier());

        app = new App(service, ZoneId.of("Asia/Taipei"),
                new PrintStream(outBuffer, true, StandardCharsets.UTF_8),
                new PrintStream(errBuffer, true, StandardCharsets.UTF_8));
    }

    private String stdout() {
        return outBuffer.toString(StandardCharsets.UTF_8);
    }

    private String stderr() {
        return errBuffer.toString(StandardCharsets.UTF_8);
    }

    // ══════════════════════════════════════════════════════════
    @Nested
    @DisplayName("完整流程")
    class HappyPath {

        @Test
        @DisplayName("新增兩筆、列出、完成一筆、再列出")
        void addListDoneList() {
            assertThat(app.run(new String[]{"add", "買牛奶", "--priority", "HIGH"})).isZero();
            assertThat(app.run(new String[]{"add", "寫測試"})).isZero();
            assertThat(app.run(new String[]{"list"})).isZero();

            assertThat(stdout())
                    .contains("已新增 #1 買牛奶")
                    .contains("已新增 #2 寫測試")
                    .contains("買牛奶")
                    .contains("共 2 筆");

            outBuffer.reset();
            assertThat(app.run(new String[]{"done", "1"})).isZero();
            assertThat(app.run(new String[]{"list"})).isZero();

            assertThat(stdout())
                    .as("預設的 list 只顯示未完成，所以買牛奶應該消失")
                    .doesNotContain("買牛奶")
                    .contains("寫測試")
                    .contains("共 1 筆");
        }

        @Test
        @DisplayName("資料真的寫進檔案，而且是合法的 UTF-8 JSON")
        void persistsToDisk() throws Exception {
            app.run(new String[]{"add", "買牛奶🥛", "--priority", "HIGH"});

            Path file = tempDir.resolve("todos.json");
            assertThat(file).exists();

            String content = Files.readString(file, StandardCharsets.UTF_8);
            assertThat(content)
                    .contains("買牛奶🥛")
                    .contains("HIGH")
                    .contains("2026-08-17T10:00:00Z");    // 固定時鐘的時間
        }

        @Test
        @DisplayName("--version 印出版本資訊並回傳 0")
        void printsVersion() {
            assertThat(app.run(new String[]{"--version"})).isZero();

            assertThat(stdout()).containsIgnoringCase("todo");
        }
    }

    // ══════════════════════════════════════════════════════════
    @Nested
    @DisplayName("錯誤處理與離開碼")
    class ErrorHandling {

        @Test
        @DisplayName("找不到的 id：離開碼 1，錯誤訊息帶錯誤碼，走 stderr")
        void unknownIdExitsWithUserError() {
            assertThat(app.run(new String[]{"done", "999"})).isEqualTo(1);

            assertThat(stderr()).contains("TODO-404").contains("999");
            assertThat(stdout()).as("錯誤不該污染 stdout").isEmpty();
        }

        @Test
        @DisplayName("未知指令：離開碼 1，提示看 --help")
        void unknownCommandExitsWithUserError() {
            assertThat(app.run(new String[]{"frobnicate"})).isEqualTo(1);

            assertThat(stderr()).contains("未知的指令").contains("--help");
        }

        @Test
        @DisplayName("id 不是數字時給出可理解的訊息")
        void nonNumericIdIsRejected() {
            assertThat(app.run(new String[]{"done", "abc"})).isEqualTo(1);

            assertThat(stderr()).contains("id 必須是數字").contains("abc");
        }

        @Test
        @DisplayName("空標題：離開碼 1，且不會寫入檔案")
        void blankTitleDoesNotPersist() {
            assertThat(app.run(new String[]{"add", "   "})).isEqualTo(1);

            assertThat(stderr()).contains("TODO-400");
            assertThat(tempDir.resolve("todos.json"))
                    .as("驗證失敗時不該產生資料檔")
                    .doesNotExist();
        }
    }
}
```

**這個 IT 驗證了單元測試碰不到的東西：**

- Jackson 真的能序列化 `Instant` 和 emoji（第 07 章 7.17 節）。
- 檔案真的寫得出來、讀得回去。
- `list` 的輸出格式（欄寬、時區轉換）。
- 離開碼的約定（第 10 章 10.18 節：0 / 1 / 2）。
- stdout / stderr 的分離（第 10 章的 CLI 禮儀）。
- **驗證失敗時不會留下半成品檔案**（第 04 章 4.9 節）。

### Testcontainers 預告

第 06～08 站會用真的 MySQL / PostgreSQL。到時候的寫法：

```java
@Testcontainers
@Tag("docker")
class JdbcTodoRepositoryIT extends TodoRepositoryContract {

    @Container
    static final PostgreSQLContainer<?> DB =
            new PostgreSQLContainer<>("postgres:16-alpine")
                    .withDatabaseName("todo")
                    .withReuse(true);          // 重複使用容器，大幅加速

    @Override
    protected TodoRepository createRepository() {
        return new JdbcTodoRepository(dataSource(DB));
    }
}
```

**注意它 `extends TodoRepositoryContract`**——11.14 節寫的 11 條契約
立刻套用到真實資料庫上。這就是契約測試的複利效果。

> `static` 的 `@Container` 表示**整個類別共用一個容器**（啟動一次）；
> 非 static 表示每個測試方法一個新容器（乾淨但慢很多）。
> 通常用 `static` + 在 `@BeforeEach` 清空資料表。

---

## 11.18 讓測試快、穩、可讀

一個測試套件要能長期活著，需要三個性質：**快**（不然沒人跑）、
**穩**（不然沒人信）、**可讀**（不然沒人維護）。

### 穩：flaky test 的六個來源

**Flaky test**（時好時壞的測試）是測試套件的癌症。
它讓團隊學會「紅燈重跑一次就好」——從此紅燈不再有意義。

| # | 來源 | 症狀 | 修法 |
|---|---|---|---|
| 1 | **時間** | 半夜跑失敗、月底失敗、CI 在 UTC 跑失敗 | 注入 `Clock`（11.13 節）；surefire 釘死 `-Duser.timezone` |
| 2 | **測試之間共用狀態** | 單獨跑過、一起跑失敗；換順序就變 | 每個測試自備狀態；避免 `static` 欄位與 `@TestInstance(PER_CLASS)` |
| 3 | **`Thread.sleep` / 時間斷言** | CI 忙的時候失敗 | Awaitility（11.15 節）；時間斷言只區分數量級 |
| 4 | **順序不確定的集合** | 偶爾順序不同 | `HashMap` / `HashSet` 的迭代順序無保證，用 `containsExactlyInAnyOrder` |
| 5 | **外部依賴** | 網路慢、第三方 API 掛、埠號被佔 | 單元測試用替身；整合測試用 Testcontainers（隨機埠） |
| 6 | **併發** | 100 次跑 1 次失敗 | 起跑閘門、`@Timeout`、收集子執行緒例外（11.15 節） |

**第 4 點特別值得展開**，因為它最隱蔽：

```java
// ❌ 這個測試可能今天過、明天失敗
Map<String, Integer> tagCounts = statistics.countByTag();

assertThat(tagCounts.keySet())
        .containsExactly("工作", "生活", "購物");     // 順序！
```

`HashMap` 的迭代順序取決於雜湊值與容量——**同一份程式碼在不同 JVM 版本、
不同輸入順序下可能不同**（第 05 章 5.6 節）。

```java
// ✅ 順序無關的斷言
assertThat(tagCounts.keySet())
        .containsExactlyInAnyOrder("工作", "生活", "購物");

// ✅✅ 或者：如果順序真的是需求，就用 LinkedHashMap / TreeMap 並在測試裡說明
assertThat(tagCounts).isInstanceOf(LinkedHashMap.class);
assertThat(tagCounts.keySet()).containsExactly("工作", "生活", "購物");
```

### 抓出「測試之間互相污染」

一個實用技巧：**隨機化執行順序**。

```properties
# src/test/resources/junit-platform.properties
junit.jupiter.testmethod.order.default = \
  org.junit.jupiter.api.MethodOrderer$Random
junit.jupiter.testclass.order.default = \
  org.junit.jupiter.api.ClassOrderer$Random
```

如果你的測試在隨機順序下開始失敗，就是有共用狀態。
**這比等它在 CI 上隨機失敗好得多**——你在本機就抓到了，
而且失敗訊息會印出這次用的 seed，可以重現。

### 快：平行執行

```properties
# src/test/resources/junit-platform.properties
junit.jupiter.execution.parallel.enabled = true

# 方法預設在同一條執行緒（同一個類別內不平行）
junit.jupiter.execution.parallel.mode.default = same_thread
# 但不同類別可以平行
junit.jupiter.execution.parallel.mode.classes.default = concurrent

# 依 CPU 核心數動態決定執行緒數
junit.jupiter.execution.parallel.config.strategy = dynamic
junit.jupiter.execution.parallel.config.dynamic.factor = 1
```

**先只開「類別之間平行」**（`mode.default = same_thread`）——
這是風險最低、收益最大的設定。同一個類別內的測試常共用 `@BeforeEach` 建立的狀態，
讓它們平行容易出事。

**必須排除的測試：**

```java
// 這個類別要獨占執行（例如它改了系統屬性）
@Execution(ExecutionMode.SAME_THREAD)
class ConfigSystemPropertyTest { }

// 或用資源鎖：所有標記同一個資源的測試不會同時跑
@ResourceLock(Resources.SYSTEM_PROPERTIES)
class ConfigSystemPropertyTest { }

@ResourceLock(value = "todo-file", mode = ResourceAccessMode.READ_WRITE)
class FileWritingTest { }
```

> ⚠️ **平行執行會把所有「隱藏的共用狀態」變成隨機失敗。**
> 開啟之前，先確認：
> - 沒有 `static` 可變欄位
> - 沒有共用的臨時檔路徑（用 `@TempDir`，它每個測試一個目錄）
> - 沒有 `System.setProperty`（或有加 `@ResourceLock`）
> - 沒有 `mockStatic`（11.12 節：它是 thread-local，行為會很怪）
>
> **開啟平行執行是一次「一次性的痛」**：會抓出一堆本來就存在的問題。
> 那些問題本來就會在 CI 上偶發，只是你以為是「CI 不穩」。

其他加速手段：

| 手段 | 效果 |
|---|---|
| 把 Spring / DB 相關的移到 `*IT` | `mvn test` 從 3 分鐘變 20 秒 |
| 用 fake 取代 Testcontainers（能用時） | 每個測試省 1～3 秒 |
| `@Container` 用 `static` + `withReuse(true)` | 容器只啟動一次 |
| 第 10 章的 `mvn -T 1C` | 多模組平行建置 |
| Gradle 的 build cache（第 10 章 10.15 節） | 沒改的模組完全不跑 |

### 可讀：測試裡不要有邏輯

```java
// ❌ 測試裡有迴圈和條件 → 測試本身可能有 bug，而測試沒有測試
@Test
void calculatesTotal() {
    List<Todo> todos = new ArrayList<>();
    int expected = 0;
    for (int i = 1; i <= 5; i++) {
        Priority p = i % 2 == 0 ? Priority.HIGH : Priority.LOW;
        todos.add(new Todo(i, "T" + i, p, NOW));
        if (p == Priority.HIGH) {
            expected += 3;
        } else {
            expected += 1;
        }
    }

    assertThat(statistics.totalWeight(todos)).isEqualTo(expected);
}
```

這個測試的 `expected` 是**用和產品程式碼一樣的邏輯算出來的**——
如果邏輯本身錯了，測試也會跟著錯，然後綠燈。

```java
// ✅ 期望值用「人算出來的字面常量」
@Test
void calculatesTotal() {
    List<Todo> todos = List.of(
            new Todo(1L, "低", Priority.LOW, NOW),      // 1
            new Todo(2L, "高", Priority.HIGH, NOW),     // 3
            new Todo(3L, "中", Priority.MEDIUM, NOW));  // 2

    assertThat(statistics.totalWeight(todos)).isEqualTo(6);   // 1+3+2，手算的
}
```

> **鐵律：測試裡不該有 `if`、`for`、`switch`、`try/catch`（斷言例外除外）。**
> 有的話，要嘛改用參數化測試（11.8 節），要嘛把期望值寫成常量。
>
> 理由很簡單：**測試是用來驗證程式碼的，那誰來驗證測試？**
> 答案是「測試簡單到不可能有 bug」。一旦測試有邏輯，這個保證就沒了。

### 可讀：測試資料建構器

當建構受測物件變得囉唆（8 個參數，其中只有 1 個和這個測試有關）：

```java
// ❌ 雜訊淹沒訊號：讀者看不出哪個參數才是重點
Todo todo = new Todo(1L, "買牛奶", Priority.MEDIUM, NOW);
todo.addTag("購物");
todo.addTag("生活");
todo.markDone(NOW.plusSeconds(3600));
```

```java
package com.example.todo.model;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;

/**
 * 測試用的 Todo 建構器。所有欄位都有合理預設，測試只需指定它在意的那一個。
 *
 * <p>放在 src/test/java——這是測試工具，不該進交付物（第 10 章 10.7 節）。
 */
public final class TodoBuilder {

    private static final Instant DEFAULT_CREATED_AT = Instant.parse("2026-08-17T10:00:00Z");

    private long id = 1L;
    private String title = "預設標題";
    private Priority priority = Priority.MEDIUM;
    private Instant createdAt = DEFAULT_CREATED_AT;
    private Instant completedAt;
    private final List<String> tags = new ArrayList<>();

    public static TodoBuilder aTodo() {
        return new TodoBuilder();
    }

    /** 常用組合的捷徑 */
    public static TodoBuilder aPendingTodo() {
        return new TodoBuilder();
    }

    public static TodoBuilder aDoneTodo() {
        return new TodoBuilder().completedAt(DEFAULT_CREATED_AT.plusSeconds(3600));
    }

    public TodoBuilder id(long id) {
        this.id = id;
        return this;
    }

    public TodoBuilder title(String title) {
        this.title = title;
        return this;
    }

    public TodoBuilder priority(Priority priority) {
        this.priority = priority;
        return this;
    }

    public TodoBuilder createdAt(Instant createdAt) {
        this.createdAt = createdAt;
        return this;
    }

    public TodoBuilder completedAt(Instant completedAt) {
        this.completedAt = completedAt;
        return this;
    }

    public TodoBuilder tags(String... tags) {
        this.tags.addAll(List.of(tags));
        return this;
    }

    public Todo build() {
        Todo todo = new Todo(id, title, priority, createdAt);
        tags.forEach(todo::addTag);
        if (completedAt != null) {
            todo.markDone(completedAt);
        }
        return todo;
    }
}
```

現在測試只寫它在意的東西：

```java
import static com.example.todo.model.TodoBuilder.aTodo;
import static com.example.todo.model.TodoBuilder.aDoneTodo;

@Test
@DisplayName("高優先度的事項排在前面")
void sortsByPriority() {
    // 讀者一眼看出：這個測試只在意 priority
    List<Todo> todos = List.of(
            aTodo().id(1).title("低").priority(Priority.LOW).build(),
            aTodo().id(2).title("高").priority(Priority.HIGH).build());

    // ...
}

@Test
@DisplayName("已完成的事項不出現在 findPending")
void excludesDone() {
    // 讀者一眼看出：這個測試只在意 done 狀態
    repository.save(aDoneTodo().id(1).build());
    repository.save(aTodo().id(2).build());

    assertThat(service.findPending()).extracting(Todo::id).containsExactly(2L);
}
```

> **建構器的價值不是「少打字」，是「讓每個測試的重點凸顯出來」。**
>
> `aTodo().priority(HIGH).build()` 明確說了「這個測試只在乎優先度」；
> `new Todo(1L, "買牛奶", Priority.HIGH, NOW)` 讓讀者得自己判斷
> 「id 和標題重要嗎？」
>
> 而且新增欄位時，只要建構器有預設值，**既有的測試一行都不用改**。

### 一個測試的可讀性檢查表

- [ ] 只看方法名（或 `@DisplayName`），能說出它在驗證什麼規則嗎？
- [ ] 有沒有明顯的 Arrange / Act / Assert 三段（用空行分隔）？
- [ ] 只有**一個** Act 嗎？
- [ ] 測試裡有沒有 `if` / `for` / 計算？
- [ ] 期望值是常量，還是「算出來的」？
- [ ] 準備資料時，有沒有和這個測試無關的雜訊？
- [ ] 失敗時的訊息，能不能不看程式碼就知道問題？

---
## 11.19 練習專案：給 Todo 補上完整測試

現在把整章串起來。目標：讓第 10 章那個「能打包出貨但沒有安全網」的專案，
變成「敢改」的專案。

### 測試檔案的最終結構

```
todo/
├── pom.xml                        ← 加上 JaCoCo、PIT（本節）
│
├── todo-model/src/test/java/com/example/todo/model/
│   ├── TodoTest.java              ← 模型不變條件、邊界、參數化
│   ├── PriorityTest.java          ← @EnumSource 窮舉
│   ├── TodoBuilder.java           ← 測試資料建構器（11.18 節）
│   └── TodoAssert.java            ← 自訂斷言（11.6 節）
│
├── todo-core/src/test/java/com/example/todo/
│   ├── repository/
│   │   ├── TodoRepositoryContract.java          ← 契約（11.14 節）
│   │   ├── FakeTodoRepository.java              ← fake（11.10 節）
│   │   ├── FakeTodoRepositoryTest.java          ← extends 契約
│   │   ├── InMemoryTodoRepositoryTest.java      ← extends 契約
│   │   ├── JsonFileTodoRepositoryContractTest.java  ← extends 契約
│   │   └── JsonFileTodoRepositoryTest.java      ← 檔案專屬行為（@TempDir）
│   ├── service/
│   │   ├── TodoServiceTest.java                 ← Mockito + 固定時鐘
│   │   └── TodoServiceWithFakeTest.java         ← fake + 狀態驗證
│   └── support/
│       ├── MutableClock.java                    ← 可控時鐘（11.13 節）
│       └── JsonTest.java                        ← 序列化往返
│
├── todo-importer/src/test/java/com/example/todo/importer/
│   └── ConcurrentTodoImporterTest.java          ← 併發（11.15 節）
│
└── todo-cli/src/test/java/com/example/todo/
    ├── AppTest.java               ← 參數解析、離開碼（用 fake service）
    ├── AppIT.java                 ← 端對端（11.17 節）
    └── ArchitectureTest.java      ← 模組邊界（本節）
```

**注意兩件事：**

1. **`TodoBuilder`、`TodoAssert`、`FakeTodoRepository`、`MutableClock`
   都放在 `src/test/java`**——它們是測試工具，不該進交付物。
2. **`TodoServiceTest`（mock）和 `TodoServiceWithFakeTest`（fake）並存。**
   前者驗證互動（有沒有通知），後者驗證狀態（存完查得到）。
   11.10 節說過：兩者用途不同，不是二選一。

### `PriorityTest`：用 `@EnumSource` 鎖住不變條件

```java
package com.example.todo.model;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.junit.jupiter.params.provider.EnumSource;

import java.util.Arrays;
import java.util.stream.Collectors;

import static org.assertj.core.api.Assertions.assertThat;

@DisplayName("Priority")
class PriorityTest {

    @ParameterizedTest(name = "{0}")
    @EnumSource(Priority.class)
    @DisplayName("每個優先度都有非空標籤與正的權重")
    void everyPriorityIsWellFormed(Priority priority) {
        assertThat(priority.label()).isNotBlank();
        assertThat(priority.weight()).isPositive();
    }

    @org.junit.jupiter.api.Test
    @DisplayName("權重彼此不重複（否則排序會不穩定）")
    void weightsAreDistinct() {
        assertThat(Arrays.stream(Priority.values()).map(Priority::weight).distinct().count())
                .isEqualTo(Priority.values().length);
    }

    @org.junit.jupiter.api.Test
    @DisplayName("標籤彼此不重複（否則使用者分不出來）")
    void labelsAreDistinct() {
        assertThat(Arrays.stream(Priority.values()).map(Priority::label)
                .collect(Collectors.toSet()))
                .hasSize(Priority.values().length);
    }

    @ParameterizedTest(name = "{0} 的權重是 {1}")
    @CsvSource({"HIGH, 3", "MEDIUM, 2", "LOW, 1"})
    @DisplayName("權重是對外契約，不可隨意更動")
    void weightsAreStable(Priority priority, int expected) {
        assertThat(priority.weight()).isEqualTo(expected);
    }
}
```

> **`weightsAreDistinct` 這個測試值得說明。**
> 如果有人新增 `URGENT("急", 3)`——和 `HIGH` 同權重——
> 排序就變得不穩定（兩個同權重的項目順序取決於原始順序）。
> 這種 bug 在正式環境的症狀是「清單順序偶爾會變」，極難追查。
>
> 而這個測試會**在他 commit 之前就紅**。
> 這就是 11.8 節說的 `@EnumSource` 複利效果：
> **規則寫一次，未來所有新增的 enum 值自動被檢查。**

### `TodoTest`：用 `@Nested` 整理不變條件

```java
package com.example.todo.model;

import com.example.todo.exception.InvalidTodoException;
import com.example.todo.exception.TodoAlreadyDoneException;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.NullAndEmptySource;
import org.junit.jupiter.params.provider.ValueSource;

import java.time.Instant;

import static com.example.todo.model.TodoBuilder.aTodo;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

@DisplayName("Todo")
class TodoTest {

    private static final Instant NOW = Instant.parse("2026-08-17T10:00:00Z");

    // ══════════════════════════════════════════════════════════
    @Nested
    @DisplayName("建立")
    class Creation {

        @Test
        @DisplayName("新建立的事項是未完成、沒有完成時間、沒有標籤")
        void startsAsPending() {
            Todo todo = aTodo().build();

            assertThat(todo.isDone()).isFalse();
            assertThat(todo.completedAt()).isNull();
            assertThat(todo.tags()).isEmpty();
        }

        @ParameterizedTest(name = "id = {0}")
        @ValueSource(longs = {0L, -1L, Long.MIN_VALUE})
        @DisplayName("id 必須是正整數")
        void rejectsNonPositiveId(long id) {
            assertThatThrownBy(() -> new Todo(id, "買牛奶", Priority.LOW, NOW))
                    .isInstanceOf(InvalidTodoException.class)
                    .hasMessageContaining("正整數");
        }

        @Test
        @DisplayName("createdAt 為 null 時拒絕建立")
        void rejectsNullCreatedAt() {
            assertThatThrownBy(() -> new Todo(1L, "買牛奶", Priority.LOW, null))
                    .isInstanceOf(NullPointerException.class)
                    .hasMessageContaining("createdAt");
        }
    }

    // ══════════════════════════════════════════════════════════
    @Nested
    @DisplayName("標題")
    class Title {

        @ParameterizedTest(name = "[{index}] <{0}>")
        @NullAndEmptySource
        @ValueSource(strings = {" ", "   ", "\t", "\n", "\r\n", "　"})
        @DisplayName("空白標題一律拒絕（含全形空白）")
        void rejectsBlank(String title) {
            assertThatThrownBy(() -> new Todo(1L, title, Priority.LOW, NOW))
                    .isInstanceOf(InvalidTodoException.class)
                    .hasMessageContaining("標題不可為空白");
        }

        @Test
        @DisplayName("前後空白會被去掉")
        void stripsWhitespace() {
            assertThat(aTodo().title("  買牛奶  ").build().title()).isEqualTo("買牛奶");
        }

        @Test
        @DisplayName("剛好 100 字可以接受")
        void acceptsExactly100Characters() {
            String title = "牛".repeat(100);

            assertThat(aTodo().title(title).build().title()).hasSize(100);
        }

        @Test
        @DisplayName("101 字被拒絕（邊界 +1）")
        void rejects101Characters() {
            String title = "牛".repeat(101);

            assertThatThrownBy(() -> aTodo().title(title).build())
                    .isInstanceOf(InvalidTodoException.class)
                    .hasMessageContaining("100");
        }

        @Test
        @DisplayName("emoji 依 char 計算長度（第 07 章 7.5 節的已知行為）")
        void emojiCountsAsCodeUnits() {
            // 🥛 是輔助平面字元，佔 2 個 char。50 個就是 100 char
            String title = "🥛".repeat(50);

            assertThat(aTodo().title(title).build().title()).hasSize(100);

            assertThatThrownBy(() -> aTodo().title("🥛".repeat(51)).build())
                    .isInstanceOf(InvalidTodoException.class);
        }
    }

    // ══════════════════════════════════════════════════════════
    @Nested
    @DisplayName("markDone")
    class MarkDone {

        @Test
        @DisplayName("標記完成後 isDone 為 true 且記錄完成時間")
        void marksDone() {
            Todo todo = aTodo().build();
            Instant at = NOW.plusSeconds(3600);

            todo.markDone(at);

            assertThat(todo.isDone()).isTrue();
            assertThat(todo.completedAt()).isEqualTo(at);
        }

        @Test
        @DisplayName("重複標記完成會丟 TodoAlreadyDoneException")
        void rejectsDoubleMarkDone() {
            Todo todo = aTodo().id(7L).build();
            todo.markDone(NOW);

            assertThatThrownBy(() -> todo.markDone(NOW.plusSeconds(1)))
                    .isInstanceOf(TodoAlreadyDoneException.class)
                    .hasMessageContaining("7");
        }

        @Test
        @DisplayName("失敗時不改變任何狀態")
        void failureLeavesStateUnchanged() {
            Todo todo = aTodo().build();
            Instant first = NOW.plusSeconds(100);
            todo.markDone(first);

            assertThatThrownBy(() -> todo.markDone(NOW.plusSeconds(999)))
                    .isInstanceOf(TodoAlreadyDoneException.class);

            assertThat(todo.completedAt())
                    .as("第二次失敗不該覆寫第一次的完成時間")
                    .isEqualTo(first);
        }
    }

    // ══════════════════════════════════════════════════════════
    @Nested
    @DisplayName("標籤")
    class Tags {

        @Test
        @DisplayName("標籤會轉小寫並去空白")
        void normalizesTags() {
            Todo todo = aTodo().tags("  Work  ", "HOME").build();

            assertThat(todo.tags()).containsExactlyInAnyOrder("work", "home");
        }

        @Test
        @DisplayName("重複標籤只算一個")
        void deduplicates() {
            Todo todo = aTodo().tags("work", "Work", "WORK").build();

            assertThat(todo.tags()).containsExactly("work");
        }

        @Test
        @DisplayName("最多 5 個標籤")
        void limitsTagCount() {
            Todo todo = aTodo().tags("a", "b", "c", "d", "e").build();

            assertThatThrownBy(() -> todo.addTag("f"))
                    .isInstanceOf(InvalidTodoException.class)
                    .hasMessageContaining("5");
        }

        @Test
        @DisplayName("已滿 5 個時，重複加既有標籤不算超過")
        void reAddingExistingTagWhenFullIsAllowed() {
            Todo todo = aTodo().tags("a", "b", "c", "d", "e").build();

            assertThatThrownBy(() -> todo.addTag("f")).isInstanceOf(InvalidTodoException.class);

            // 但重複加已有的應該沒問題
            todo.addTag("a");
            assertThat(todo.tags()).hasSize(5);
        }

        @Test
        @DisplayName("tags() 回傳防禦性複本，改它不影響 Todo")
        void returnsDefensiveCopy() {
            Todo todo = aTodo().tags("work").build();

            assertThatThrownBy(() -> todo.tags().add("hack"))
                    .isInstanceOf(UnsupportedOperationException.class);

            assertThat(todo.tags()).containsExactly("work");
        }
    }

    // ══════════════════════════════════════════════════════════
    @Nested
    @DisplayName("equals / hashCode")
    class Equality {

        @Test
        @DisplayName("id 相同就相等（實體語意），即使其他欄位不同")
        void equalsById() {
            Todo a = aTodo().id(1L).title("買牛奶").priority(Priority.HIGH).build();
            Todo b = aTodo().id(1L).title("完全不同").priority(Priority.LOW).build();

            assertThat(a).isEqualTo(b).hasSameHashCodeAs(b);
        }

        @Test
        @DisplayName("id 不同就不相等")
        void notEqualsByDifferentId() {
            assertThat(aTodo().id(1L).build()).isNotEqualTo(aTodo().id(2L).build());
        }

        @Test
        @DisplayName("和 null、其他型別比較不會爆炸")
        void handlesNullAndOtherTypes() {
            Todo todo = aTodo().build();

            assertThat(todo).isNotEqualTo(null).isNotEqualTo("字串");
        }

        @Test
        @DisplayName("可以當 HashSet 的元素（第 05 章 5.5 節的契約）")
        void worksInHashSet() {
            var set = new java.util.HashSet<Todo>();
            set.add(aTodo().id(1L).title("原本").build());
            set.add(aTodo().id(1L).title("換個標題").build());

            assertThat(set).as("id 相同視為同一個").hasSize(1);
        }
    }
}
```

### `TodoServiceWithFakeTest`：狀態驗證版

和 11.7 節的 mock 版並存，補足它測不到的東西：

```java
package com.example.todo.service;

import com.example.todo.model.Priority;
import com.example.todo.model.Todo;
import com.example.todo.repository.FakeTodoRepository;
import com.example.todo.support.MutableClock;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.tuple;

/**
 * 用 fake 而不是 mock，驗證「一連串操作之後的狀態」。
 * 這類測試抓得到 mock 版抓不到的問題：存了之後查不到、排序錯、id 撞號。
 */
@DisplayName("TodoService（狀態驗證）")
class TodoServiceWithFakeTest {

    /** 記錄通知的 spy（11.10 節）——比 mock 更直接 */
    static final class RecordingNotifier implements Notifier {
        final List<Todo> created = new ArrayList<>();
        final List<Todo> done = new ArrayList<>();

        @Override public void notifyCreated(Todo todo) {
            created.add(todo);
        }

        @Override public void notifyDone(Todo todo) {
            done.add(todo);
        }
    }

    FakeTodoRepository repository;
    MutableClock clock;
    RecordingNotifier notifier;
    TodoService service;

    @BeforeEach
    void setUp() {
        repository = new FakeTodoRepository();
        clock = MutableClock.at("2026-08-17T10:00:00Z");
        notifier = new RecordingNotifier();
        service = new TodoService(repository, clock, notifier);
    }

    @Test
    @DisplayName("連續新增三筆，id 依序遞增且都查得到")
    void addsSequentially() {
        service.add("第一", Priority.LOW);
        service.add("第二", Priority.MEDIUM);
        service.add("第三", Priority.HIGH);

        assertThat(repository.findAll())
                .extracting(Todo::id, Todo::title)
                .containsExactly(
                        tuple(1L, "第一"),
                        tuple(2L, "第二"),
                        tuple(3L, "第三"));
        assertThat(notifier.created).hasSize(3);
    }

    @Test
    @DisplayName("每筆的建立時間來自時鐘的當下，會隨時間推進而不同")
    void recordsClockTime() {
        Todo first = service.add("早上的事", Priority.LOW);

        clock.advance(java.time.Duration.ofHours(5));
        Todo second = service.add("下午的事", Priority.LOW);

        assertThat(first.createdAt()).isEqualTo(java.time.Instant.parse("2026-08-17T10:00:00Z"));
        assertThat(second.createdAt()).isEqualTo(java.time.Instant.parse("2026-08-17T15:00:00Z"));
    }

    @Test
    @DisplayName("findAll：未完成優先，同狀態依優先度，同優先度依建立時間")
    void sortsCorrectly() {
        // 故意用「和期望相反」的順序建立（11.12 節誤用 2）
        Todo lowFirst = service.add("低-早", Priority.LOW);
        clock.advanceMinutes(1);
        service.add("高", Priority.HIGH);
        clock.advanceMinutes(1);
        service.add("中", Priority.MEDIUM);
        clock.advanceMinutes(1);
        Todo willBeDone = service.add("高-已完成", Priority.HIGH);

        service.markDone(willBeDone.id());

        assertThat(service.findAll())
                .extracting(Todo::title)
                .containsExactly("高", "中", "低-早", "高-已完成");
    }

    @Test
    @DisplayName("markDone 之後，重新查詢拿到的是已完成狀態（真的存進去了）")
    void markDonePersists() {
        long id = service.add("買牛奶", Priority.HIGH).id();
        clock.advanceMinutes(30);

        service.markDone(id);

        assertThat(repository.findById(id)).get()
                .extracting(Todo::isDone, Todo::completedAt)
                .containsExactly(true, java.time.Instant.parse("2026-08-17T10:30:00Z"));
        assertThat(notifier.done).extracting(Todo::id).containsExactly(id);
    }

    @Test
    @DisplayName("remove 之後查不到，且 findPending 不再包含它")
    void removeWorks() {
        long id = service.add("買牛奶", Priority.HIGH).id();
        service.add("留著的", Priority.LOW);

        service.remove(id);

        assertThat(repository.findById(id)).isEmpty();
        assertThat(service.findPending()).extracting(Todo::title).containsExactly("留著的");
    }
}
```

> 對照 11.7 節的 mock 版：那裡驗證「有沒有呼叫 `notifier`」，
> 這裡驗證「排序對不對、真的存進去了沒」。
>
> **`sortsCorrectly` 這個測試 mock 版寫不出來**——因為 mock 版必須
> stub `repository.findAll()` 回傳固定清單，而那正是要驗證的東西（11.12 節誤用 2）。

### `ArchitectureTest`：把第 10 章的模組邊界變成測試

第 10 章 10.12 節說「拆模組讓編譯器守住架構邊界」。
但**同一個模組內部的分層**（model / repository / service）編譯器管不到。
ArchUnit 補上這一塊：

```java
package com.example.todo;

import com.tngtech.archunit.core.importer.ImportOption;
import com.tngtech.archunit.junit.AnalyzeClasses;
import com.tngtech.archunit.junit.ArchTest;
import com.tngtech.archunit.lang.ArchRule;

import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalDateTime;

import static com.tngtech.archunit.library.Architectures.layeredArchitecture;
import static com.tngtech.archunit.lang.syntax.ArchRuleDefinition.classes;
import static com.tngtech.archunit.lang.syntax.ArchRuleDefinition.noClasses;

@AnalyzeClasses(
        packages = "com.example.todo",
        importOptions = ImportOption.DoNotIncludeTests.class)
class ArchitectureTest {

    @ArchTest
    static final ArchRule 分層架構 = layeredArchitecture()
            .consideringAllDependencies()
            .layer("Model").definedBy("com.example.todo.model..")
            .layer("Exception").definedBy("com.example.todo.exception..")
            .layer("Repository").definedBy("com.example.todo.repository..")
            .layer("Service").definedBy("com.example.todo.service..")
            .layer("Importer").definedBy("com.example.todo.importer..")
            .layer("CLI").definedBy("com.example.todo")

            .whereLayer("CLI").mayNotBeAccessedByAnyLayer()
            .whereLayer("Importer").mayOnlyBeAccessedByLayers("CLI")
            .whereLayer("Service").mayOnlyBeAccessedByLayers("CLI", "Importer")
            .whereLayer("Repository").mayOnlyBeAccessedByLayers("CLI", "Service", "Importer");

    @ArchTest
    static final ArchRule 模型不可依賴儲存層 = noClasses()
            .that().resideInAPackage("..model..")
            .should().dependOnClassesThat()
            .resideInAnyPackage("..repository..", "..service..", "..importer..")
            .because("model 是最底層，被所有人依賴，不能反向依賴任何人");

    @ArchTest
    static final ArchRule 不可直接取得系統時間 = noClasses()
            .that().resideOutsideOfPackages("com.example.todo", "..support..")
            .should().callMethod(Instant.class, "now")
            .orShould().callMethod(LocalDate.class, "now")
            .orShould().callMethod(LocalDateTime.class, "now")
            .orShould().callMethod(System.class, "currentTimeMillis")
            .because("時間必須從注入的 Clock 取得，否則無法測試（第 11 章 11.13 節）");

    @ArchTest
    static final ArchRule 不可用_printStackTrace = noClasses()
            .should().callMethod(Throwable.class, "printStackTrace")
            .because("例外要用 logger 記錄，printStackTrace 在正式環境查不到（第 04 章 4.11 節）");

    @ArchTest
    static final ArchRule 不可用_System_out = noClasses()
            .that().resideOutsideOfPackage("com.example.todo")
            .should().accessField(System.class, "out")
            .orShould().accessField(System.class, "err")
            .because("只有 CLI 層可以直接輸出，其他層要用 logger 或回傳值");

    @ArchTest
    static final ArchRule 例外必須繼承_TodoException = classes()
            .that().resideInAPackage("..exception..")
            .and().areNotEnums()
            .and().haveSimpleNameEndingWith("Exception")
            .and().areNotAssignableFrom(com.example.todo.exception.TodoException.class)
            .should().beAssignableTo(com.example.todo.exception.TodoException.class)
            .because("統一的例外基底讓最外層處理器能一次接住（第 04 章 4.10 節）");

    @ArchTest
    static final ArchRule 不可有循環依賴 = com.tngtech.archunit.library.dependencies
            .SlicesRuleDefinition.slices()
            .matching("com.example.todo.(*)..")
            .should().beFreeOfCycles();
}
```

執行後如果有人違反：

```
java.lang.AssertionError: Architecture Violation [Priority: MEDIUM] -
Rule '不可直接取得系統時間' was violated (1 times):
Method <com.example.todo.service.TodoService.findOverdue()> calls method
<java.time.Instant.now()> in (TodoService.java:78)
```

> 🔑 **ArchUnit 的價值在於「規範自動執行」。**
>
> 「時間要用 Clock」這條規則，寫在 wiki 上三個月後就沒人記得；
> 寫成 ArchUnit 規則，違反的人在 push 前就會看到紅燈，
> 而且錯誤訊息裡有 `because(...)` 說明理由和出處。
>
> 這和第 10 章 10.10 節的 enforcer 是同一個哲學：
> **把團隊約定從「文件」變成「建置失敗」。**

### 加上 JaCoCo 與 PIT

在根 pom 的 `<build><plugins>` 加上 11.16 節的兩個外掛。
再加一個方便的 profile：

```xml
<profiles>
  <profile>
    <id>mutation</id>
    <build>
      <plugins>
        <plugin>
          <groupId>org.pitest</groupId>
          <artifactId>pitest-maven</artifactId>
          <version>1.17.0</version>
          <dependencies>
            <dependency>
              <groupId>org.pitest</groupId>
              <artifactId>pitest-junit5-plugin</artifactId>
              <version>1.2.1</version>
            </dependency>
          </dependencies>
          <configuration>
            <targetClasses>
              <param>com.example.todo.model.*</param>
              <param>com.example.todo.service.*</param>
            </targetClasses>
            <mutationThreshold>70</mutationThreshold>
          </configuration>
          <executions>
            <execution>
              <id>pit-report</id>
              <phase>verify</phase>
              <goals><goal>mutationCoverage</goal></goals>
            </execution>
          </executions>
        </plugin>
      </plugins>
    </build>
  </profile>
</profiles>
```

更新第 10 章的 `Makefile`：

```makefile
test:                       ## 單元測試（快，開發時用）
	$(MVN) -T 1C test

verify:                     ## 單元 + 整合測試 + 覆蓋率門檻
	$(MVN) -T 1C clean verify

coverage: verify            ## 產生並開啟覆蓋率報告
	@open todo-core/target/site/jacoco/index.html 2>/dev/null || \
	 echo "報告在 */target/site/jacoco/index.html"

mutation:                   ## 突變測試（慢，週期性跑）
	$(MVN) clean verify -Pmutation
	@open todo-core/target/pit-reports/index.html 2>/dev/null || true

test-one:                   ## 跑單一測試（make test-one T=TodoServiceTest）
	$(MVN) test -Dtest=$(T)

flaky:                      ## 隨機順序跑 10 次，找出測試之間的污染
	@for i in 1 2 3 4 5 6 7 8 9 10; do \
	  echo "=== 第 $$i 次 ==="; \
	  $(MVN) -q test -Djunit.jupiter.testmethod.order.default=org.junit.jupiter.api.MethodOrderer\$$Random \
	    || { echo "第 $$i 次失敗！"; exit 1; }; \
	done; echo "✅ 10 次隨機順序全部通過"
```

### 執行與驗收

```bash
# 1. 單元測試（開發時的快速回饋）
./mvnw -T 1C test
```

```
[INFO] Reactor Summary for Todo 1.0.0-SNAPSHOT:
[INFO] Todo ............................................... SUCCESS [  0.14 s]
[INFO] Todo :: Model ...................................... SUCCESS [  2.81 s]
[INFO] Todo :: Core ....................................... SUCCESS [  4.02 s]
[INFO] Todo :: Importer ................................... SUCCESS [  3.55 s]
[INFO] Todo :: CLI ........................................ SUCCESS [  1.93 s]
[INFO] ------------------------------------------------------------------------
[INFO] BUILD SUCCESS
[INFO] Total time:  9.412 s
```

```bash
# 2. 完整驗證（整合測試 + 覆蓋率門檻）
./mvnw -T 1C clean verify
```

```
[INFO] --- surefire:3.5.0:test (default-test) @ todo-core ---
[INFO] Tests run: 74, Failures: 0, Errors: 0, Skipped: 0
[INFO]
[INFO] --- failsafe:3.5.0:integration-test (default) @ todo-cli ---
[INFO] Tests run: 9, Failures: 0, Errors: 0, Skipped: 0
[INFO]
[INFO] --- jacoco:0.8.12:check (check) @ todo-core ---
[INFO] Analyzed bundle 'Todo :: Core' with 11 classes
[INFO] All coverage checks have been met.
[INFO] ------------------------------------------------------------------------
[INFO] BUILD SUCCESS
```

```bash
# 3. 看覆蓋率報告，找紅色區塊
make coverage
```

```
Element                       Line Cov.   Branch Cov.
com.example.todo.model           94%          88%
com.example.todo.exception       100%         n/a
com.example.todo.repository      91%          83%
com.example.todo.service         96%          92%
com.example.todo.support         87%          75%
com.example.todo.importer        89%          81%
──────────────────────────────────────────────────
Total                            92%          85%
```

```bash
# 4. 突變測試：檢驗測試本身的品質
make mutation
```

```
>> Generated 214 mutations Killed 178 (83%)
>> Ran 1,043 tests (4.87 tests per mutation)
```

```bash
# 5. 隨機順序跑十次，確認測試之間沒有污染
make flaky
```

```
✅ 10 次隨機順序全部通過
```

```bash
# 6. 驗證安全網真的有效：故意改壞一行，看有沒有被抓到
#    把 TodoService.findAll() 的 sorted(...) 註解掉
./mvnw -q test -pl todo-core
```

```
[ERROR] TodoServiceWithFakeTest.sortsCorrectly:98
Expecting actual:
  ["低-早", "高", "中", "高-已完成"]
to contain exactly (and in same order):
  ["高", "中", "低-早", "高-已完成"]
```

**這一步是整章最重要的驗收。** 覆蓋率 92%、突變分數 83% 都只是數字；
**「改壞一行會被抓到」才是安全網的定義。**

### 這一章我們得到了什麼

| 能力 | 靠什麼 |
|---|---|
| 改程式碼時，10 秒內知道有沒有改壞 | 9 秒跑完的 83 個單元測試 |
| 新人讀測試報告就懂需求 | `@Nested` + 中文 `@DisplayName`（11.7 節） |
| 邊界條件不會漏 | 參數化測試 + `@EnumSource`（11.8 節） |
| fake 和真實實作不會偷偷分歧 | 契約測試（11.14 節） |
| 時間相關的邏輯可測 | 注入 `Clock` + `MutableClock`（11.13 節） |
| 檔案 IO 真的被驗證 | `@TempDir` 的整合測試（11.13 節） |
| 併發的行為有被檢查 | 起跑閘門 + `@Timeout` + Awaitility（11.15 節） |
| 打包後的完整流程有驗證 | `AppIT` 端對端（11.17 節） |
| 架構規範自動執行 | ArchUnit（本節） |
| 知道哪些測試是假的 | 突變測試（11.16 節） |
| 測試不會互相污染 | 隨機順序 + `make flaky`（11.18 節） |

### 還沒解決的問題（留給後面）

| 問題 | 什麼時候解 |
|---|---|
| `Todo` 有 150 行樣板（getter / equals / hashCode / toString） | **第 12 章**：`record` |
| `completedAt` 用 `null` 表示「未完成」，測試要一直檢查 null | **第 12 章**：`sealed` + 模式比對，讓狀態機顯性化 |
| `App.dispatch` 的 `switch` 新增指令要改三處 | **第 12 章** |
| 沒有真實資料庫的測試 | **第 06～08 站**：Testcontainers + 契約測試 |
| 沒有 HTTP 層的測試 | **第 03～05 站**：`MockMvc` / `WebTestClient` / REST-assured |
| 手動組裝依賴，測試要自己 new 一堆東西 | **第 02 站**：`@SpringBootTest` / `@MockBean` |

---
## 11.20 常見錯誤

| # | 錯誤 | 後果 | 正解 |
|---|------|------|------|
| 1 | 測試依賴沒寫 `<scope>test</scope>` | 產品程式碼 import 得到 JUnit，有人真的用了 → 上線 `NoClassDefFoundError` | 測試依賴一律 `test` scope（第 10 章 10.7 節） |
| 2 | `@BeforeAll` 忘記 `static` | `@BeforeAll method must be static`（除非 `@TestInstance(PER_CLASS)`） | 加 `static`，或明確選 `PER_CLASS` 並理解代價 |
| 3 | 以為測試共用同一個實例 | 在 `@Test` 裡改欄位，期望下一個測試看得到 → 看不到 | 預設每個測試一個新實例（11.5 節）。要共用就每個測試自己準備 |
| 4 | `@Nested` 寫成 `static class` | 整組測試被靜默忽略，報告裡完全不出現 | `@Nested` 必須是非 static 內部類別 |
| 5 | 用 `assertEquals` 比集合 | 失敗訊息只說「不相等」，不告訴你差在哪 | AssertJ 的 `containsExactly` / `extracting`（11.6 節） |
| 6 | 對 `equals` 只比 id 的實體用 `isEqualTo` | **測試永遠通過**，即使所有其他欄位都錯 | `usingRecursiveComparison()`（11.6 節） |
| 7 | `BigDecimal` 用 `isEqualTo` | `0.10` 和 `0.1` 不相等（scale 不同） | `isEqualByComparingTo("0.10")` |
| 8 | `double` 用 `isEqualTo` | 浮點誤差（第 01 章 1.6 節） | `isCloseTo(x, within(0.001))` |
| 9 | 斷言例外訊息的完整字串 | 改一個標點測試就紅，大家開始改測試而不是看 bug | `hasMessageContaining` 或斷言 `ErrorCode`（11.9 節） |
| 10 | 只驗證「有丟例外」，不驗證副作用 | 方法先寫入 DB 再丟例外 → 資料髒了但測試綠 | 加 `verify(repo, never()).save(any())`（11.9 節） |
| 11 | 邊界只測「明顯超過」的值 | 差一錯誤（`>` vs `>=`）抓不到 | 測 `n-1`、`n`、`n+1`（11.9 節） |
| 12 | `mock(Todo.class)` mock 值物件 | 繞過所有驗證邏輯，測的是自己的 stub | 值物件永遠用真的（11.12 節誤用 1） |
| 13 | stub 的回傳值恰好就是斷言的期望值 | **測試永遠通過**，把受測邏輯整行刪掉也一樣 | 讓 stub 資料「故意是錯的順序」，或改用 fake（11.12 節誤用 2） |
| 14 | `verify(repo).findById(1L)` 驗證實作細節 | 任何重構都讓測試紅，最後團隊選擇刪測試 | 驗證可觀察的狀態 / 回傳值（11.12 節誤用 3） |
| 15 | 一個測試類別 mock 五個以上 | `@BeforeEach` 40 行，加依賴要改全部測試 | **重構產品程式碼**，那是設計問題（11.12 節誤用 4） |
| 16 | 用 `mockStatic(Instant.class)` 控制時間 | 只對當前執行緒有效、無法平行、忘記 close 會污染整個 JVM | 注入 `Clock`（11.13 節） |
| 17 | `@InjectMocks` 把 `Clock` 也塞成 mock | `clock.instant()` 回 `null` → NPE，錯誤訊息完全看不出原因 | 手動 `new TodoService(...)`（11.11 節） |
| 18 | 混用 matcher 和實際值 | `InvalidUseOfMatchersException`，**而且爆在下一個測試裡** | 全用 matcher（`eq(1L)`）或全用實際值（11.11 節） |
| 19 | 以為 `verify(mock).m()` 是「至少一次」 | 其實是「剛好一次」，兩次會失敗 | 要放寬就明寫 `atLeastOnce()`（11.12 節誤用 6） |
| 20 | 用 `Thread.sleep` 等非同步結果 | 慢、CI 上隨機失敗、失敗訊息無用 | `CountDownLatch` 或 Awaitility（11.15 節） |
| 21 | 併發測試沒有起跑閘門 | 第 1 條執行緒跑完時第 100 條還沒建立 → 根本沒併發 | `CountDownLatch startGate`（11.15 節） |
| 22 | `pool.submit(...)` 沒收 `Future` | **子執行緒的例外被吞掉，測試永遠綠** | 收集 `Future` 並逐一 `get()`（11.15 節） |
| 23 | surefire 的 `<argLine>` 直接覆寫 | JaCoCo agent 沒掛上，覆蓋率變 0% | 保留 `@{argLine}`（第 10 章 10.10 節） |
| 24 | 把覆蓋率當 KPI | 大家寫「沒有斷言的測試」衝數字，安全網是假的 | 覆蓋率用來「找沒測到的地方」；品質看突變測試（11.16 節） |
| 25 | 斷言 `HashMap` / `HashSet` 的迭代順序 | 換 JVM 版本或輸入順序就失敗 | `containsExactlyInAnyOrder`（11.18 節） |
| 26 | 測試裡有 `for` / `if` 算期望值 | 用和產品程式碼一樣的邏輯算期望值 → 邏輯錯了測試也錯 | 期望值寫成手算的常量（11.18 節） |
| 27 | 測試之間用 `static` 欄位傳狀態 | 單獨跑過、一起跑失敗；開平行執行後全面崩潰 | 每個測試自備狀態；用 `make flaky` 隨機順序驗證 |
| 28 | `@Disabled` 沒寫理由 | 三個月後沒人知道能不能開回來，變成永久的謊言 | 一定寫理由 + 追蹤編號 + 預計時間（11.5 節） |
| 29 | 沒有 `@Timeout` | 死鎖的測試卡到 CI job timeout（可能 60 分鐘）才失敗 | 用 `junit-platform.properties` 設全域預設（11.5 節） |
| 30 | 整合測試命名成 `*Test` | 每次 `mvn test` 都要起 Docker，本機回饋從 10 秒變 3 分鐘 | 命名成 `*IT`，交給 failsafe（11.17 節） |

---

## 11.21 本章練習

### 練習 1：找出四個假測試

以下四個測試都是綠的，但至少有三個「什麼都沒驗證到」。
指出哪些是假的、為什麼，以及怎麼修。

```java
// ── A ──
@Test
void findAllSortsByPriority() {
    given(repository.findAll()).willReturn(List.of(
            new Todo(1L, "高", Priority.HIGH, NOW),
            new Todo(2L, "中", Priority.MEDIUM, NOW),
            new Todo(3L, "低", Priority.LOW, NOW)));

    assertThat(service.findAll())
            .extracting(Todo::title)
            .containsExactly("高", "中", "低");
}

// ── B ──
@Test
void todoIsCreatedCorrectly() {
    Todo expected = new Todo(1L, "買牛奶", Priority.HIGH, NOW);

    Todo actual = service.add("買牛奶", Priority.HIGH);

    assertThat(actual).isEqualTo(expected);
}

// ── C ──
@Test
void serviceHandlesEverything() {
    service.add("買牛奶", Priority.HIGH);
    service.markDone(1L);
    service.findAll();
    service.remove(1L);
}

// ── D ──
@Test
void markDoneSetsCompletedAt() {
    Todo todo = mock(Todo.class);
    given(todo.isDone()).willReturn(false);
    given(repository.findById(1L)).willReturn(Optional.of(todo));

    service.markDone(1L);

    verify(todo).markDone(any(Instant.class));
}
```

<details>
<summary>參考解答</summary>

**四個全部有問題。**

---

**A —— 假測試（11.12 節誤用 2）**

`stub` 回傳的順序（高、中、低）**恰好就是期望的順序**。
把 `TodoService.findAll()` 裡的整段 `.sorted(...)` 刪掉，這個測試依然綠。

**它驗證的是「我的 stub 回傳了我寫的東西」。**

修法：讓 stub 的順序**故意是錯的**。

```java
@Test
void findAllSortsByPriority() {
    given(repository.findAll()).willReturn(List.of(
            new Todo(3L, "低", Priority.LOW, NOW),        // ← 故意亂序
            new Todo(1L, "高", Priority.HIGH, NOW),
            new Todo(2L, "中", Priority.MEDIUM, NOW)));

    assertThat(service.findAll())
            .extracting(Todo::title)
            .containsExactly("高", "中", "低");    // 期望被重新排序
}
```

**自我檢查法**：把 `.sorted(...)` 註解掉，測試必須紅。

---

**B —— 假測試（11.6 節：`equals` 只比 id）**

`Todo.equals` 只比較 `id`（第 02 章的實體語意）。所以：

```java
new Todo(1L, "買牛奶", Priority.HIGH, NOW)
    .equals(new Todo(1L, "完全不同的標題", Priority.LOW, OTHER_TIME))    // → true
```

即使 `service.add` 把標題存成 `"買醬油"`、優先度存成 `LOW`、
建立時間存成 1970 年，只要 id 是 1，這個測試就通過。

修法一（推薦，用遞迴比較）：

```java
assertThat(actual).usingRecursiveComparison().isEqualTo(expected);
```

修法二（明確列出在意的欄位，可讀性更好）：

```java
assertThat(actual)
        .extracting(Todo::id, Todo::title, Todo::priority, Todo::createdAt, Todo::isDone)
        .containsExactly(1L, "買牛奶", Priority.HIGH, NOW, false);
```

> **這是「`equals` 有領域語意」的類別的通用陷阱。**
> 任何 `equals` 只比 id / 主鍵的實體（JPA 的 `@Entity` 幾乎都是），
> 都不能直接用 `isEqualTo` 做斷言。

---

**C —— 假測試（11.16 節：沒有斷言）**

**完全沒有斷言。** 它唯一能抓到的是「丟出例外」。
`markDone` 存錯資料、`findAll` 回傳空的、`remove` 刪錯人，全部不會被發現。

但它會讓 `TodoService` 的**行覆蓋率變得很好看**——
這正是「用覆蓋率當 KPI」時最快的達標方式。

修法：拆成有明確主題的測試，每個都有斷言。

```java
@Test
@DisplayName("新增後可以查到，且狀態是未完成")
void addedTodoIsPending() {
    Todo created = service.add("買牛奶", Priority.HIGH);

    assertThat(repository.findById(created.id())).get()
            .extracting(Todo::title, Todo::isDone)
            .containsExactly("買牛奶", false);
}

@Test
@DisplayName("刪除後查不到")
void removedTodoIsGone() {
    long id = service.add("買牛奶", Priority.HIGH).id();

    service.remove(id);

    assertThat(repository.findById(id)).isEmpty();
}
```

> 順帶一提，C 還有一個隱藏 bug：它假設 `service.add` 產生的 id 是 `1L`
> 才能 `markDone(1L)`。這是 11.5 節說的「測試之間的隱含依賴」——
> 換一個 repository 實作（id 從 100 開始）就爆炸。

---

**D —— 假測試（11.12 節誤用 1：mock 值物件）**

三個問題：

1. **`Todo` 被 mock 掉了**，所以 `markDone` 的真實邏輯（設定 `done`、
   設定 `completedAt`、重複標記時丟例外）**完全沒被執行**。
2. **`verify(todo).markDone(any(Instant.class))` 只驗證「有呼叫」**，
   不驗證傳的是不是時鐘的時間。傳 `Instant.MIN` 也會通過。
3. 測試名字叫 `markDoneSetsCompletedAt`，但它根本沒檢查 `completedAt`。

修法：用真的 `Todo`，驗證狀態。

```java
@Test
@DisplayName("標記完成時，completedAt 用的是時鐘的當下時間")
void markDoneSetsCompletedAt() {
    Todo todo = new Todo(1L, "買牛奶", Priority.HIGH, NOW.minusSeconds(3600));
    given(repository.findById(1L)).willReturn(Optional.of(todo));
    given(repository.save(any())).willAnswer(inv -> inv.getArgument(0));

    Todo result = service.markDone(1L);

    assertThat(result.isDone()).isTrue();
    assertThat(result.completedAt())
            .as("應該用注入的固定時鐘，不是 Instant.now()")
            .isEqualTo(NOW);
}
```

---

**通用的自我檢查法**

寫完任何測試後，做這三件事之一：

| 方法 | 怎麼做 | 成本 |
|---|---|---|
| 手動突變 | 把受測的那一行邏輯註解掉 / 改個運算子，確認測試會紅 | 30 秒 |
| 反轉期望 | 把斷言的期望值改成錯的，確認測試會紅 | 10 秒 |
| 自動突變 | 跑 PIT（11.16 節） | 幾分鐘～幾十分鐘 |

**如果測試在你破壞程式碼之後還是綠的，它沒在測你以為的東西。**

</details>

---

### 練習 2：診斷五個 flaky test

以下五個測試「大部分時候會過」。分別說出①為什麼會 flaky②怎麼修。

```java
// ── A ──
@Test
void createdTodayIsToday() {
    Todo todo = service.add("買牛奶", Priority.HIGH);

    assertThat(todo.createdAt().atZone(ZoneId.systemDefault()).toLocalDate())
            .isEqualTo(LocalDate.now());
}

// ── B ──
private static final List<String> LOG = new ArrayList<>();

@Test
void logsCreation() {
    service.add("買牛奶", Priority.HIGH);

    assertThat(LOG).hasSize(1);
}

@Test
void logsCompletion() {
    long id = service.add("買牛奶", Priority.HIGH).id();
    service.markDone(id);

    assertThat(LOG).hasSize(2);
}

// ── C ──
@Test
void importsAll() throws Exception {
    importer.importAsync(List.of(source1, source2, source3));

    Thread.sleep(500);

    assertThat(repository.findAll()).hasSize(30);
}

// ── D ──
@Test
void groupsByTag() {
    Map<String, List<Todo>> byTag = statistics.groupByTag(todos);

    assertThat(byTag.keySet()).containsExactly("工作", "生活", "購物");
}

// ── E ──
@Test
void completesWithinBudget() {
    long start = System.nanoTime();

    service.findAll();

    assertThat(Duration.ofNanos(System.nanoTime() - start))
            .isLessThan(Duration.ofMillis(50));
}
```

<details>
<summary>參考解答</summary>

**A —— 跨日競態 + 時區依賴**

**為什麼 flaky**：如果測試在當地時間 23:59:59.998 執行，
`service.add` 拿到的是今天，`LocalDate.now()` 在兩毫秒後求值時已經是明天。
**一天有一次機會失敗**——通常是某個加班的晚上，或 CI 排程在午夜跑批次時。

另外它還依賴 `ZoneId.systemDefault()`：本機是 `Asia/Taipei`，
CI 容器是 `UTC`。台灣時間早上 7 點 = UTC 前一天 23 點，日期就不同了。

**修法**：注入固定時鐘，讓「今天」變成確定的輸入。

```java
@Test
void createdAtComesFromClock() {
    Clock fixed = Clock.fixed(Instant.parse("2026-08-17T10:00:00Z"), ZoneOffset.UTC);
    TodoService service = new TodoService(repository, fixed, notifier);

    Todo todo = service.add("買牛奶", Priority.HIGH);

    assertThat(todo.createdAt()).isEqualTo(Instant.parse("2026-08-17T10:00:00Z"));
}
```

順便測那個危險的邊界（這是固定時鐘才做得到的）：

```java
@Test
@DisplayName("台北時間跨日的瞬間，日期歸屬正確")
void handlesMidnightInTaipei() {
    // 2026-08-17T15:59:59Z = 台北時間 2026-08-17 23:59:59
    Clock justBefore = Clock.fixed(Instant.parse("2026-08-17T15:59:59Z"), ZoneOffset.UTC);
    // 再一秒就是台北的 8/18
    Clock justAfter = Clock.fixed(Instant.parse("2026-08-17T16:00:00Z"), ZoneOffset.UTC);

    ZoneId taipei = ZoneId.of("Asia/Taipei");

    assertThat(new TodoService(repository, justBefore, notifier)
            .add("A", Priority.LOW).createdAt().atZone(taipei).toLocalDate())
            .isEqualTo(LocalDate.of(2026, 8, 17));

    assertThat(new TodoService(repository, justAfter, notifier)
            .add("B", Priority.LOW).createdAt().atZone(taipei).toLocalDate())
            .isEqualTo(LocalDate.of(2026, 8, 18));
}
```

**保險起見**，surefire 也釘死時區（第 10 章 10.10 節）：

```xml
<argLine>@{argLine} -Duser.timezone=Asia/Taipei</argLine>
```

---

**B —— `static` 可變欄位造成測試間污染**

**為什麼 flaky**：`LOG` 是 `static`，**所有測試共用**。

- 單獨跑 `logsCompletion` → `LOG` 有 2 筆 → ✅
- 先跑 `logsCreation` 再跑 `logsCompletion` → `LOG` 有 1+2=3 筆 → ❌
- 換個執行順序，結果又不同。
- 開啟平行執行（11.18 節）後，兩個測試同時 `add`，數字完全不可預測。

而 JUnit **不保證方法執行順序**——同一份程式碼在不同 JVM 版本、
不同作業系統下的反射順序可能不同。所以它會在「換一台 CI 機器」時突然開始失敗。

**修法一（最好）**：不要用 `static`，改用實例欄位。
每個測試一個新實例（11.5 節），自動隔離。

```java
private final List<String> log = new ArrayList<>();     // 不是 static
```

**修法二**：如果因為某些理由必須是 `static`，就在 `@BeforeEach` 清空。

```java
@BeforeEach
void clearLog() {
    LOG.clear();
}
```

**修法三（最乾淨）**：用 11.19 節的 `RecordingNotifier`——
把「記錄」變成一個注入的協作者，而不是全域狀態。

```java
@BeforeEach
void setUp() {
    notifier = new RecordingNotifier();      // 每個測試一個新的
    service = new TodoService(repository, FIXED_CLOCK, notifier);
}

@Test
void logsCompletion() {
    long id = service.add("買牛奶", Priority.HIGH).id();
    service.markDone(id);

    assertThat(notifier.created).hasSize(1);
    assertThat(notifier.done).hasSize(1);
}
```

**怎麼提早發現這類問題**：`make flaky`（11.19 節）用隨機順序跑十次。

---

**C —— `Thread.sleep` 等非同步結果**

**為什麼 flaky**：500 ms 是猜的。本機 SSD + 空閒 CPU 可能 80 ms 就好，
CI 上共用機器 + 冷啟動 + JIT 未暖可能要 1200 ms。

而且它同時是**慢**（成功時也白等 500 ms）和**不穩**（忙的時候不夠）。
典型的惡性循環是：有人改成 2000 ms → CI 變慢 → 還是偶爾失敗 → 改成 5000 ms⋯⋯

**修法**：Awaitility。

```java
@Test
@Timeout(10)
void importsAll() {
    importer.importAsync(List.of(source1, source2, source3));

    await().atMost(Duration.ofSeconds(5))
           .pollInterval(Duration.ofMillis(20))
           .untilAsserted(() -> assertThat(repository.findAll()).hasSize(30));
}
```

- 80 ms 完成 → 大約 80～100 ms 就往下走（比 sleep 快 5 倍）。
- 1200 ms 完成 → 通過（sleep 版會失敗）。
- 永遠不完成 → 5 秒後失敗，訊息是「最後一次斷言：size 是 12 不是 30」
  （sleep 版只說「size 是 12 不是 30」，你不知道是「還沒好」還是「壞了」）。

**更好的修法**：如果 API 允許，讓它回傳 `CompletableFuture`（第 08 章 8.12 節），
測試就能精確等待，完全不需要輪詢。

```java
@Test
void importsAll() throws Exception {
    CompletableFuture<ImportResult> future =
            importer.importAsync(List.of(source1, source2, source3));

    ImportResult result = future.get(5, TimeUnit.SECONDS);

    assertThat(result.imported()).isEqualTo(30);
}
```

---

**D —— 依賴 `HashMap` 的迭代順序**

**為什麼 flaky**：`groupByTag` 大概是用 `Collectors.groupingBy`，
它預設回傳 `HashMap`。`HashMap` 的迭代順序取決於**鍵的雜湊值與當前容量**——
不是插入順序，也不是字典序。

中文字串的 `hashCode` 是確定的，所以同一個 JVM 上結果會穩定；
但只要：
- 元素數量變化導致 `HashMap` 擴容（rehash）→ 順序變
- 換 JVM 實作或版本 → 可能變
- 有人多加了一個標籤 → 全部順序可能變

⋯⋯測試就紅。**這種 flaky 最惡毒的地方是「和你的改動看起來完全無關」。**

**修法一（通常正確）**：順序不是需求，用順序無關的斷言。

```java
assertThat(byTag.keySet()).containsExactlyInAnyOrder("工作", "生活", "購物");
// 或者連 key 帶 value 一起比
assertThat(byTag).containsOnlyKeys("工作", "生活", "購物");
```

**修法二**：如果順序**真的是需求**（要顯示給使用者），
那產品程式碼就該保證它，測試才能斷言它。

```java
// 產品程式碼：明確指定 LinkedHashMap（保留插入順序）或 TreeMap（排序）
public Map<String, List<Todo>> groupByTag(List<Todo> todos) {
    return todos.stream()
            .flatMap(t -> t.tags().stream().map(tag -> Map.entry(tag, t)))
            .collect(Collectors.groupingBy(
                    Map.Entry::getKey,
                    TreeMap::new,                    // ← 明確指定
                    Collectors.mapping(Map.Entry::getValue, Collectors.toList())));
}
```

```java
// 測試就可以斷言順序，而且不會 flaky
assertThat(byTag.keySet()).containsExactly("工作", "生活", "購物");  // 依 TreeMap 排序
```

> ⚠️ 注意：中文的 `TreeMap` 排序是 **UTF-16 code unit 順序**，
> 既不是筆畫也不是注音（第 05 章 5.15 節）。要照中文習慣排序要用 `Collator`。
> 這也是一個該在測試裡明確鎖住的行為。

---

**E —— 精確的時間斷言**

**為什麼 flaky**：`50 ms` 這個數字在你的機器上很寬鬆，
但在 CI 上可能因為以下任一原因超過：

- 共用 runner，隔壁的 job 在編譯
- 第一次執行，JIT 還沒編譯（第 00 章 0.9 節的暖機）
- 剛好碰到一次 GC 停頓（第 09 章 9.9 節）
- 類別載入（第 09 章 9.6 節）

**單元測試不該做效能斷言。** 這是 flaky test 的經典來源，
而且它「抓到問題」時你也不知道是真的變慢還是機器忙。

**修法一（最常見）**：刪掉這個斷言。效能問題交給專門的效能測試
（JMH microbenchmark、或壓測環境的 k6 / Gatling）。

**修法二**：如果真的要防止「不小心寫出 O(n²)」，就測**複雜度的數量級**
而不是絕對時間：

```java
@Test
@DisplayName("findAll 的耗時應接近線性，不該是平方級")
void scalesLinearly() {
    Duration for1000 = timeFindAll(1_000);
    Duration for10000 = timeFindAll(10_000);

    // 線性的話大約 10 倍；平方的話是 100 倍。用 25 倍當門檻，容忍雜訊
    assertThat(for10000.toNanos())
            .as("資料量 10 倍，耗時不該超過 25 倍（那表示是平方級）")
            .isLessThan(for1000.toNanos() * 25);
}
```

**修法三**：用 `@Timeout` 抓「完全卡住」而不是「有點慢」。

```java
@Test
@Timeout(value = 5, unit = TimeUnit.SECONDS)      // 只抓死鎖 / 無限迴圈
void findAllCompletes() {
    assertThat(service.findAll()).hasSize(1000);
}
```

> **11.15 節的原則再說一次：時間斷言只能用來區分數量級**
> （200 ms vs 1000 ms、線性 vs 平方），**絕不能用來測精確值**。

---

**五個 flaky 的共同結構**

| 題 | 根因 | 通則 |
|---|---|---|
| A | 全域狀態（系統時鐘、預設時區） | 注入 `Clock`，釘死時區 |
| B | 全域狀態（`static` 欄位） | 每個測試自備狀態 |
| C | 時間假設（`sleep` 猜多久） | 等條件，不等時間 |
| D | 未定義行為（`HashMap` 順序） | 不斷言未保證的東西 |
| E | 環境依賴（機器效能） | 單元測試不做效能斷言 |

> **flaky test 的根源幾乎都是「測試依賴了它無法控制的東西」。**
> 修法也永遠是同一個：**把不可控的東西變成可控的輸入**，
> 或**不要斷言不可控的東西**。

</details>

---

### 練習 3：把不可測的類別改成可測

以下這個類別無法寫任何有意義的單元測試。
①指出四個「不可測」的來源 ②重構它 ③寫三個測試證明重構有效。

```java
package com.example.todo.report;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.LocalDate;
import java.util.List;
import java.util.UUID;

public class DailyReportGenerator {

    public void generate(List<Todo> todos) {
        String reportId = UUID.randomUUID().toString();
        LocalDate today = LocalDate.now();

        long done = todos.stream().filter(Todo::isDone).count();
        long pending = todos.size() - done;

        String content = """
                報表編號：%s
                日期：%s
                已完成：%d
                未完成：%d
                """.formatted(reportId, today, done, pending);

        Path output = Path.of(System.getenv("REPORT_DIR"), "daily-" + today + ".txt");
        try {
            Files.writeString(output, content);
        } catch (IOException e) {
            System.out.println("寫入失敗：" + e.getMessage());
        }

        System.out.println("報表已產生：" + output);
    }
}
```

<details>
<summary>參考解答</summary>

**① 四個（其實是五個）不可測的來源**

| # | 程式碼 | 為什麼不可測 |
|---|---|---|
| 1 | `UUID.randomUUID()` | 每次不同，無法斷言報表內容 |
| 2 | `LocalDate.now()` | 依賴系統時鐘與預設時區；跨日 flaky；無法測「月底」「閏年」 |
| 3 | `System.getenv("REPORT_DIR")` | Java 無法在程式中修改環境變數；沒設的話直接 NPE |
| 4 | `Files.writeString(...)` 寫死路徑 | 測試會污染真實檔案系統 |
| 5 | `System.out.println` | 輸出無法驗證，而且吞掉了例外（`catch` 只印訊息就算了——第 04 章 4.11 節的反面教材） |

**② 重構**

三個原則：
- 把全域狀態變成注入的依賴（11.13 節那張表）。
- **把「計算」和「副作用」分開**——純函式的部分完全不需要替身。
- 錯誤要往上拋，不要吞掉。

```java
package com.example.todo.report;

import java.time.Clock;
import java.time.LocalDate;
import java.util.List;
import java.util.function.Supplier;

/** 報表內容。純資料，好比對、好測。 */
public record DailyReport(String reportId, LocalDate date, long done, long pending) {

    public String render() {
        return """
                報表編號：%s
                日期：%s
                已完成：%d
                未完成：%d
                """.formatted(reportId, date, done, pending);
    }
}
```

```java
package com.example.todo.report;

import com.example.todo.model.Todo;

import java.time.Clock;
import java.time.LocalDate;
import java.util.List;
import java.util.Objects;
import java.util.function.Supplier;

/**
 * 只負責「算出報表內容」。沒有任何副作用——不寫檔、不印東西。
 * 這是純函式，測試完全不需要任何替身。
 */
public class DailyReportCalculator {

    private final Clock clock;
    private final Supplier<String> idGenerator;

    public DailyReportCalculator(Clock clock, Supplier<String> idGenerator) {
        this.clock = Objects.requireNonNull(clock, "clock");
        this.idGenerator = Objects.requireNonNull(idGenerator, "idGenerator");
    }

    public DailyReport calculate(List<Todo> todos) {
        Objects.requireNonNull(todos, "todos");

        long done = todos.stream().filter(Todo::isDone).count();
        return new DailyReport(
                idGenerator.get(),
                LocalDate.now(clock),          // ← 用注入的時鐘
                done,
                todos.size() - done);
    }
}
```

```java
package com.example.todo.report;

import com.example.todo.exception.ErrorCode;
import com.example.todo.exception.TodoException;
import com.example.todo.model.Todo;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Objects;

/** 只負責「把報表寫出去」。輸出目錄由外面決定。 */
public class DailyReportWriter {

    private static final Logger log = LoggerFactory.getLogger(DailyReportWriter.class);

    private final DailyReportCalculator calculator;
    private final Path outputDir;

    public DailyReportWriter(DailyReportCalculator calculator, Path outputDir) {
        this.calculator = Objects.requireNonNull(calculator, "calculator");
        this.outputDir = Objects.requireNonNull(outputDir, "outputDir");
    }

    /** @return 寫出去的檔案路徑 */
    public Path generate(List<Todo> todos) {
        DailyReport report = calculator.calculate(todos);
        Path output = outputDir.resolve("daily-" + report.date() + ".txt");

        try {
            Files.createDirectories(outputDir);
            Files.writeString(output, report.render(), StandardCharsets.UTF_8);
        } catch (IOException e) {
            // 不要吞掉：包成業務例外並保留 cause（第 04 章 4.7 節）
            throw new ReportWriteException(output, e);
        }

        log.info("報表已產生：{}", output);
        return output;                 // 回傳路徑，呼叫方要印要記錄都行
    }

    public static class ReportWriteException extends TodoException {
        public ReportWriteException(Path path, Throwable cause) {
            super(ErrorCode.STORAGE_FAILURE, "報表寫入失敗：" + path, cause);
        }
    }
}
```

正式環境組裝（第 10 章的 `App.buildService()` 風格）：

```java
new DailyReportWriter(
        new DailyReportCalculator(
                Clock.systemDefaultZone(),
                () -> UUID.randomUUID().toString()),
        Path.of(System.getenv().getOrDefault("REPORT_DIR", System.getProperty("user.home"))));
```

**③ 三個測試**

```java
package com.example.todo.report;

import com.example.todo.model.Priority;
import com.example.todo.model.Todo;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

@DisplayName("每日報表")
class DailyReportTest {

    // 台北時間 2026-08-17 23:30（刻意選一個接近跨日的時間）
    private static final Clock TAIPEI_LATE_NIGHT =
            Clock.fixed(Instant.parse("2026-08-17T15:30:00Z"), ZoneId.of("Asia/Taipei"));

    private static Todo todo(long id, boolean done) {
        Todo t = new Todo(id, "事項 " + id, Priority.MEDIUM,
                Instant.parse("2026-08-17T00:00:00Z"));
        if (done) {
            t.markDone(Instant.parse("2026-08-17T01:00:00Z"));
        }
        return t;
    }

    // ── 測試 1：純計算，完全不需要替身，也不碰檔案 ──
    @Test
    @DisplayName("正確統計已完成與未完成的數量，且用注入的 id 與時鐘")
    void calculatesCounts() {
        var calculator = new DailyReportCalculator(TAIPEI_LATE_NIGHT, () -> "FIXED-ID");

        DailyReport report = calculator.calculate(List.of(
                todo(1, true), todo(2, true), todo(3, false), todo(4, false), todo(5, false)));

        assertThat(report.reportId()).isEqualTo("FIXED-ID");
        assertThat(report.date()).isEqualTo(LocalDate.of(2026, 8, 17));
        assertThat(report.done()).isEqualTo(2);
        assertThat(report.pending()).isEqualTo(3);
    }

    // ── 測試 2：時區邊界。重構前這個測試根本寫不出來 ──
    @Test
    @DisplayName("報表日期用注入時鐘的時區，不是 UTC")
    void usesClockTimeZone() {
        Instant sameMoment = Instant.parse("2026-08-17T16:30:00Z");

        var taipei = new DailyReportCalculator(
                Clock.fixed(sameMoment, ZoneId.of("Asia/Taipei")), () -> "X");
        var utc = new DailyReportCalculator(
                Clock.fixed(sameMoment, ZoneId.of("UTC")), () -> "X");

        // 同一個瞬間：台北已是 8/18 00:30，UTC 還是 8/17 16:30
        assertThat(taipei.calculate(List.of()).date()).isEqualTo(LocalDate.of(2026, 8, 18));
        assertThat(utc.calculate(List.of()).date()).isEqualTo(LocalDate.of(2026, 8, 17));
    }

    // ── 測試 3：真的寫檔，但寫在 @TempDir 裡 ──
    @Test
    @DisplayName("寫出 UTF-8 檔案，檔名含日期，內容可讀")
    void writesFile(@TempDir Path tempDir) throws IOException {
        var writer = new DailyReportWriter(
                new DailyReportCalculator(TAIPEI_LATE_NIGHT, () -> "RPT-001"),
                tempDir.resolve("reports"));

        Path output = writer.generate(List.of(todo(1, true), todo(2, false)));

        assertThat(output).exists().hasFileName("daily-2026-08-17.txt");
        assertThat(Files.readString(output, StandardCharsets.UTF_8))
                .contains("報表編號：RPT-001")
                .contains("日期：2026-08-17")
                .contains("已完成：1")
                .contains("未完成：1");
    }

    // ── 加碼：錯誤處理也可測了 ──
    @Test
    @DisplayName("輸出目錄無法建立時，丟出帶有路徑與 cause 的例外")
    void reportsWriteFailure(@TempDir Path tempDir) throws IOException {
        // 用一個「已存在的檔案」當目錄路徑，createDirectories 就會失敗
        Path blocker = tempDir.resolve("reports");
        Files.writeString(blocker, "我是檔案不是目錄");

        var writer = new DailyReportWriter(
                new DailyReportCalculator(TAIPEI_LATE_NIGHT, () -> "X"), blocker);

        assertThatThrownBy(() -> writer.generate(List.of()))
                .isInstanceOf(DailyReportWriter.ReportWriteException.class)
                .hasMessageContaining("daily-2026-08-17.txt")
                .hasCauseInstanceOf(IOException.class);
    }
}
```

**重構帶來了什麼**

| 重構前 | 重構後 |
|---|---|
| 一個測試都寫不出來 | 4 個測試，其中 2 個是純函式（0.1 ms） |
| 無法測時區邊界 | 測試 2 明確驗證了跨日的行為 |
| 例外被吞掉，只印訊息 | 包成 `ReportWriteException`，保留 cause，可測 |
| 呼叫方無法知道檔案在哪 | `generate` 回傳 `Path` |
| 「算」和「寫」綁在一起 | 分成兩個類別，各自單一職責 |

> 🔑 **注意最後一列。** 為了可測試而做的分離
> （`Calculator` 算、`Writer` 寫），**同時也是更好的設計**：
> 現在你可以在不寫檔的情況下產生報表（給 API 回傳）、
> 可以換成寫 S3、可以在同一份計算上輸出多種格式。
>
> 這再次驗證 11.13 節的結論：**「難以測試」是設計問題的症狀。**
> 修好可測試性，通常就順便修好了設計。

</details>

---

### 練習 4：為一個介面設計契約測試

團隊要新增一個快取抽象，會有三個實作
（`InMemoryCache`、`CaffeineCache`、`RedisCache`）：

```java
public interface TodoCache {

    /** 放入快取，並設定存活時間 */
    void put(long id, Todo todo, Duration ttl);

    /** 取出。不存在或已過期時回傳空 */
    Optional<Todo> get(long id);

    /** 移除。@return true 表示原本存在 */
    boolean evict(long id);

    /** 清空全部 */
    void clear();

    /** 目前有效的項目數（不含已過期的） */
    int size();
}
```

①列出至少 8 條這個介面該遵守的契約 ②寫出契約測試的骨架
③說明「TTL 過期」這條契約怎麼測才不會 flaky ④三個實作各有什麼不能放進契約的差異。

<details>
<summary>參考解答</summary>

**① 契約清單**

| # | 契約 | 為什麼重要 |
|---|---|---|
| 1 | `put` 之後 `get` 拿得到同一個值 | 最基本 |
| 2 | 沒 `put` 過的 id，`get` 回傳空 `Optional`（不是 null、不丟例外） | 呼叫方不用寫 null 檢查 |
| 3 | 同一個 id `put` 兩次是覆蓋，不是新增 | 否則 `size` 會錯 |
| 4 | TTL 到期後 `get` 回傳空 | 快取的核心語意 |
| 5 | TTL 到期後 `size` 不計入該項 | 否則容量控制會失效 |
| 6 | `evict` 存在的 id 回傳 `true`，之後 `get` 拿不到 | |
| 7 | `evict` 不存在的 id 回傳 `false`，不丟例外 | 呼叫方不用先檢查 |
| 8 | `clear` 之後 `size` 為 0，所有 `get` 都是空 | |
| 9 | 空快取的 `size` 是 0（不是 -1、不丟例外） | |
| 10 | `put` 的 `ttl` 為零或負數 → 立刻過期（或拒絕，但要一致） | **這種邊界一定要在契約裡定義**，否則三個實作各做各的 |
| 11 | `put` 的 `todo` 為 null → 丟 NPE（不要靜默存 null） | 否則 `get` 回傳 `Optional.of(null)` 會爆 |
| 12 | 併發 `put` 同一個 id 不會遺失或損壞資料 | 見 ④，這條要當**選配契約** |

> **契約測試最大的價值就在第 10、11 條這種「邊界的定義」。**
> 沒有契約測試時，三個實作對「TTL 是 0 怎麼辦」會有三種行為，
> 而且沒有人發現——直到某天換了實作，正式環境出現詭異的快取行為。

**② 契約測試骨架**

```java
package com.example.todo.cache;

import com.example.todo.model.Priority;
import com.example.todo.model.Todo;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;

import java.time.Duration;
import java.time.Instant;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatNoException;
import static org.assertj.core.api.Assertions.assertThatNullPointerException;

@DisplayName("TodoCache 契約")
abstract class TodoCacheContract {

    protected static final Instant NOW = Instant.parse("2026-08-17T10:00:00Z");
    protected static final Duration LONG_TTL = Duration.ofHours(1);

    /** 子類別提供一個空的快取 */
    protected abstract TodoCache createCache();

    /** 子類別提供「讓時間前進」的方式——見 ③ */
    protected abstract void advanceTime(Duration amount);

    protected Todo todo(long id) {
        return new Todo(id, "事項 " + id, Priority.MEDIUM, NOW);
    }

    // ══════════════════════════════════════════════════════════
    @Nested
    @DisplayName("put + get")
    class PutAndGet {

        @Test
        @DisplayName("① put 之後 get 拿得到同一個值")
        void putThenGet() {
            TodoCache cache = createCache();
            Todo todo = todo(1L);

            cache.put(1L, todo, LONG_TTL);

            assertThat(cache.get(1L)).get()
                    .extracting(Todo::id, Todo::title)
                    .containsExactly(1L, "事項 1");
        }

        @Test
        @DisplayName("② 沒 put 過的 id 回傳空 Optional")
        void unknownIdReturnsEmpty() {
            assertThat(createCache().get(999L)).isEmpty();
        }

        @Test
        @DisplayName("③ 同一個 id put 兩次是覆蓋")
        void putTwiceOverwrites() {
            TodoCache cache = createCache();
            cache.put(1L, todo(1L), LONG_TTL);

            Todo replacement = new Todo(1L, "換過了", Priority.HIGH, NOW);
            cache.put(1L, replacement, LONG_TTL);

            assertThat(cache.size()).isEqualTo(1);
            assertThat(cache.get(1L)).get()
                    .extracting(Todo::title).isEqualTo("換過了");
        }

        @Test
        @DisplayName("⑪ put null 值時丟 NPE")
        void rejectsNullValue() {
            assertThatNullPointerException()
                    .isThrownBy(() -> createCache().put(1L, null, LONG_TTL));
        }
    }

    // ══════════════════════════════════════════════════════════
    @Nested
    @DisplayName("TTL 過期")
    class Expiry {

        @Test
        @DisplayName("④ TTL 到期後 get 拿不到")
        void expiresAfterTtl() {
            TodoCache cache = createCache();
            cache.put(1L, todo(1L), Duration.ofMinutes(10));

            advanceTime(Duration.ofMinutes(9));
            assertThat(cache.get(1L)).as("第 9 分鐘還在").isPresent();

            advanceTime(Duration.ofMinutes(2));      // 累計 11 分鐘
            assertThat(cache.get(1L)).as("第 11 分鐘已過期").isEmpty();
        }

        @Test
        @DisplayName("⑤ 已過期的項目不計入 size")
        void expiredItemsNotCounted() {
            TodoCache cache = createCache();
            cache.put(1L, todo(1L), Duration.ofMinutes(5));
            cache.put(2L, todo(2L), Duration.ofHours(2));

            advanceTime(Duration.ofMinutes(10));

            assertThat(cache.size()).isEqualTo(1);
        }

        @Test
        @DisplayName("⑩ TTL 為零或負數時立刻過期")
        void zeroOrNegativeTtlExpiresImmediately() {
            TodoCache cache = createCache();

            cache.put(1L, todo(1L), Duration.ZERO);
            cache.put(2L, todo(2L), Duration.ofSeconds(-1));

            assertThat(cache.get(1L)).isEmpty();
            assertThat(cache.get(2L)).isEmpty();
            assertThat(cache.size()).isZero();
        }
    }

    // ══════════════════════════════════════════════════════════
    @Nested
    @DisplayName("evict + clear + size")
    class Removal {

        @Test
        @DisplayName("⑥ evict 存在的 id 回傳 true 且之後拿不到")
        void evictsExisting() {
            TodoCache cache = createCache();
            cache.put(1L, todo(1L), LONG_TTL);

            assertThat(cache.evict(1L)).isTrue();
            assertThat(cache.get(1L)).isEmpty();
            assertThat(cache.size()).isZero();
        }

        @Test
        @DisplayName("⑦ evict 不存在的 id 回傳 false，不丟例外")
        void evictingUnknownIdReturnsFalse() {
            TodoCache cache = createCache();

            assertThatNoException().isThrownBy(() -> cache.evict(999L));
            assertThat(cache.evict(999L)).isFalse();
        }

        @Test
        @DisplayName("⑧ clear 之後全空")
        void clearEmptiesCache() {
            TodoCache cache = createCache();
            cache.put(1L, todo(1L), LONG_TTL);
            cache.put(2L, todo(2L), LONG_TTL);

            cache.clear();

            assertThat(cache.size()).isZero();
            assertThat(cache.get(1L)).isEmpty();
            assertThat(cache.get(2L)).isEmpty();
        }

        @Test
        @DisplayName("⑨ 空快取的 size 是 0")
        void emptyCacheSizeIsZero() {
            assertThat(createCache().size()).isZero();
        }
    }
}
```

**③ TTL 過期怎麼測才不 flaky**

**❌ 絕對不要這樣：**

```java
cache.put(1L, todo, Duration.ofMillis(100));
Thread.sleep(150);
assertThat(cache.get(1L)).isEmpty();
```

CI 忙的時候 `sleep(150)` 可能實際睡 400 ms（那還好），
但如果快取實作有背景清理執行緒，時序就完全不可控了。
而且這個測試**每跑一次就慢 150 ms**——十個這種測試就是 1.5 秒。

**✅ 正解：讓快取的時間來源也是注入的 `Clock`（11.13 節）。**

介面不用改，但實作的建構子要接 `Clock`：

```java
public class InMemoryCache implements TodoCache {

    private record Entry(Todo todo, Instant expiresAt) { }

    private final Map<Long, Entry> store = new ConcurrentHashMap<>();
    private final Clock clock;

    public InMemoryCache(Clock clock) {
        this.clock = Objects.requireNonNull(clock, "clock");
    }

    @Override
    public void put(long id, Todo todo, Duration ttl) {
        Objects.requireNonNull(todo, "todo");
        store.put(id, new Entry(todo, clock.instant().plus(ttl)));
    }

    @Override
    public Optional<Todo> get(long id) {
        Entry entry = store.get(id);
        if (entry == null) {
            return Optional.empty();
        }
        if (!clock.instant().isBefore(entry.expiresAt())) {
            store.remove(id);                 // 順手清掉
            return Optional.empty();
        }
        return Optional.of(entry.todo());
    }

    // size() 同樣要過濾掉已過期的...
}
```

契約測試的子類別就這樣實作 `advanceTime`：

```java
@DisplayName("InMemoryCache")
class InMemoryCacheTest extends TodoCacheContract {

    private final MutableClock clock = MutableClock.at("2026-08-17T10:00:00Z");

    @Override
    protected TodoCache createCache() {
        return new InMemoryCache(clock);
    }

    @Override
    protected void advanceTime(Duration amount) {
        clock.advance(amount);           // 瞬間，0 ms
    }
}
```

**結果：測試「一小時後過期」只要 0.1 ms，而且 100% 穩定。**

`CaffeineCache` 也可以——Caffeine 支援 `Ticker`：

```java
@DisplayName("CaffeineCache")
class CaffeineCacheTest extends TodoCacheContract {

    private final AtomicLong nanos = new AtomicLong(0);

    @Override
    protected TodoCache createCache() {
        return new CaffeineCache(Caffeine.newBuilder()
                .ticker(nanos::get)          // 可控的時間來源
                .build());
    }

    @Override
    protected void advanceTime(Duration amount) {
        nanos.addAndGet(amount.toNanos());
    }
}
```

`RedisCache` 的 TTL 由 Redis 伺服器管理，時鐘不在你手上。
兩個選擇：

```java
@DisplayName("RedisCache")
@Tag("docker")
class RedisCacheIT extends TodoCacheContract {

    @Container
    static final GenericContainer<?> REDIS =
            new GenericContainer<>("redis:7-alpine").withExposedPorts(6379);

    @Override
    protected void advanceTime(Duration amount) {
        // 選項 A：真的等（只有這個實作要付出時間代價，且用秒級 TTL）
        // 選項 B（推薦）：用 Redis 的 DEBUG SLEEP 或直接改 key 的 TTL
        redisClient.pexpire(key, remainingMillis - amount.toMillis());
    }
}
```

> **這就是把 `advanceTime` 設計成抽象方法的原因**：
> 每個實作用它自己最有效率的方式推進時間，而契約本身不需要知道。

**④ 不能放進契約的三個差異**

| 差異 | 為什麼不能進契約 | 怎麼處理 |
|---|---|---|
| **執行緒安全** | `InMemoryCache` 用 `ConcurrentHashMap` 是安全的；某個簡單實作可能不是。不是所有實作都宣稱這件事 | 做成**選配契約**：`interface ThreadSafeCacheContract`，只有宣稱安全的實作 implements 它（11.14 節解法二） |
| **容量上限與淘汰策略** | Caffeine 有 LRU/LFU 淘汰（超過容量會踢掉東西），`InMemoryCache` 沒有。契約寫「put 之後一定拿得到」會讓 Caffeine 版失敗 | 契約只保證「**在容量內**」的行為；淘汰策略寫在各自的測試類別裡 |
| **序列化** | Redis 要把 `Todo` 序列化成 bytes，所以「存進去和拿出來是同一個物件參考」對它不成立（`assertThat(get).isSameAs(put)` 會失敗）；記憶體版則成立 | 契約一律用 `isEqualTo` / 欄位比對，**絕不用 `isSameAs`**。另外 Redis 版要額外測「循環參考」「未知欄位」等序列化議題 |

其他該留在各自測試的：

- `RedisCache`：連線中斷時的行為、逾時設定、序列化格式相容性。
- `CaffeineCache`：統計資訊（hit rate）、非同步載入。
- `InMemoryCache`：記憶體洩漏（第 09 章 9.11 節——沒有容量上限的快取是頭號洩漏來源）。

> 🔑 **契約測試的設計原則：只放「所有實作都必須遵守」的規則。**
>
> 一條規則只要有一個合理的實作不能滿足，它就不屬於契約——
> 要嘛降級成選配契約，要嘛留在該實作自己的測試裡。
>
> 契約寫得太寬鬆 → 抓不到實作間的分歧（失去價值）；
> 太嚴格 → 綁死實作，新實作加不進來（變成阻礙）。
> **找到這條線，是設計介面時最有價值的思考。**

</details>

---

### 練習 5：100% 覆蓋率下的漏網之魚

以下方法計算折扣後的總額。它有 **100% 行覆蓋率**，但有一個 bug。

```java
package com.example.todo.billing;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.util.List;

public class DiscountCalculator {

    private static final BigDecimal VIP_RATE = new BigDecimal("0.20");
    private static final BigDecimal BULK_RATE = new BigDecimal("0.10");
    private static final int BULK_THRESHOLD = 10;

    /**
     * 計算折扣後總額。
     * VIP 打八折；數量達 10 件（含）再打九折。兩種折扣可疊加。
     * 結果四捨五入到小數第二位。
     */
    public BigDecimal total(List<BigDecimal> prices, boolean vip) {
        BigDecimal sum = BigDecimal.ZERO;
        for (BigDecimal price : prices) {
            sum = sum.add(price);
        }

        if (vip) {
            sum = sum.multiply(BigDecimal.ONE.subtract(VIP_RATE));
        }
        if (prices.size() > BULK_THRESHOLD) {
            sum = sum.multiply(BigDecimal.ONE.subtract(BULK_RATE));
        }

        return sum.setScale(2, RoundingMode.HALF_UP);
    }
}
```

現有的測試（覆蓋率 100%）：

```java
@Test
void calculatesTotal() {
    assertThat(calc.total(List.of(new BigDecimal("100")), false))
            .isEqualByComparingTo("100.00");
}

@Test
void appliesVipDiscount() {
    assertThat(calc.total(List.of(new BigDecimal("100")), true))
            .isEqualByComparingTo("80.00");
}

@Test
void appliesBulkDiscount() {
    List<BigDecimal> twenty = Collections.nCopies(20, new BigDecimal("10"));

    assertThat(calc.total(twenty, false)).isEqualByComparingTo("180.00");
}
```

①找出 bug ②說明為什麼 100% 行覆蓋率抓不到 ③寫出會抓到它的測試
④列出這個方法還有哪些沒被測到的邊界。

<details>
<summary>參考解答</summary>

**① Bug：`>` 應該是 `>=`**

Javadoc 說「數量達 10 件（**含**）」，程式碼寫的是：

```java
if (prices.size() > BULK_THRESHOLD)      // 11 件才打折
```

正確應該是：

```java
if (prices.size() >= BULK_THRESHOLD)     // 10 件就打折
```

**現況**：買 10 件的客人**沒有拿到應得的九折**。
這種 bug 在正式環境的表現是「客訴說折扣沒算到」，
而客服查了半天說「系統顯示正常」——因為買 11 件確實有折扣。

**② 為什麼 100% 行覆蓋率抓不到**

覆蓋率只問「**這行有沒有被執行**」：

| 行 | 被執行了嗎 | 由哪個測試 |
|---|---|---|
| `for` 迴圈 | ✅ | 全部三個 |
| `if (vip)` 為 true | ✅ | `appliesVipDiscount` |
| `if (vip)` 為 false | ✅ | 另外兩個 |
| `if (size > 10)` 為 true | ✅ | `appliesBulkDiscount`（20 件） |
| `if (size > 10)` 為 false | ✅ | 另外兩個（1 件） |
| `setScale` | ✅ | 全部 |

**行覆蓋率 100%，分支覆蓋率也是 100%。**

但沒有任何測試用 **10** 這個值。測試用的是 1 件和 20 件——
它們離邊界都太遠，`>` 和 `>=` 的行為完全一樣。

> 🔑 **這就是 11.9 節「一定要測 n-1、n、n+1」的理由，
> 也是 11.16 節「覆蓋率不等於測試品質」最好的例子。**
>
> 突變測試（11.16 節）會產生 `changed conditional boundary`
> 這個突變（把 `>` 改成 `>=`），發現三個測試全都還是綠的，
> 於是報告 `SURVIVED`——精確指出這一行。

**③ 抓得到的測試**

```java
@ParameterizedTest(name = "{0} 件 → 總額 {1}")
@DisplayName("數量折扣的邊界：9 件無折扣、10 件起打九折")
@CsvSource({
        " 9,  90.00",     // 9 × 10 = 90，無折扣
        "10,  90.00",     // 10 × 10 = 100，九折 = 90  ← 關鍵！現在會失敗
        "11,  99.00"      // 11 × 10 = 110，九折 = 99
})
void bulkDiscountBoundary(int count, String expected) {
    List<BigDecimal> prices = Collections.nCopies(count, new BigDecimal("10"));

    assertThat(calc.total(prices, false)).isEqualByComparingTo(expected);
}
```

跑起來：

```
✓ 9 件 → 總額 90.00
✗ 10 件 → 總額 90.00
    expected: 90.00
     but was: 100.00
✓ 11 件 → 總額 99.00
```

**注意 9 件和 10 件的期望值剛好都是 `90.00`（一個是沒折扣的 9×10，
一個是打折後的 100×0.9）——這個巧合讓測試看起來有點怪。
可以換一個單價讓意圖更清楚：**

```java
@CsvSource({
        " 9, 100,  900.00",     // 無折扣
        "10, 100,  900.00",     // 1000 打九折
        "11, 100,  990.00"
})
void bulkDiscountBoundary(int count, String unitPrice, String expected) { ... }
```

**④ 其他沒被測到的邊界**

| # | 邊界 | 目前的行為 | 該怎麼定義 |
|---|---|---|---|
| 1 | **空清單** | 回傳 `0.00`（`BigDecimal.ZERO` 乘任何數都是 0） | 合理，但要有測試鎖住 |
| 2 | **`prices` 為 `null`** | `for` 迴圈 NPE，訊息不明 | 加 `Objects.requireNonNull(prices, "prices")` |
| 3 | **清單中有 `null` 元素** | `sum.add(null)` 丟 NPE | 明確拒絕，或明確定義為跳過 |
| 4 | **負數價格**（退貨？） | 靜默接受，總額可能是負的 | 業務要定義；若不允許就拒絕 |
| 5 | **兩種折扣疊加** | 沒有任何測試！ | VIP + 10 件 = 0.8 × 0.9 = 0.72 折 |
| 6 | **四捨五入邊界** | 沒測 | `100.005` 該進位成 `100.01`（`HALF_UP`） |
| 7 | **VIP 折扣後的除不盡** | 沒測 | `33.33 × 0.8 = 26.664` → `26.66` |
| 8 | **超大金額** | `BigDecimal` 不會溢位，但要確認 | 一億筆的總和 |
| 9 | **`setScale` 之前的中間精度** | 只在最後 setScale，正確 | 測「多次乘法不會提早損失精度」 |

**⑤ 疊加折扣**是最嚴重的漏測——它是唯一一個「兩個 `if` 都為 true」的路徑，
而且業務規則（可疊加）只寫在 Javadoc 裡，沒有任何測試保護。

```java
@Test
@DisplayName("VIP 買 10 件：兩種折扣疊加（0.8 × 0.9 = 0.72）")
void stacksVipAndBulkDiscount() {
    List<BigDecimal> tenItems = Collections.nCopies(10, new BigDecimal("100"));

    // 1000 × 0.8 = 800，再 × 0.9 = 720
    assertThat(calc.total(tenItems, true)).isEqualByComparingTo("720.00");
}

@Test
@DisplayName("四捨五入到小數第二位（HALF_UP）")
void roundsHalfUp() {
    // 33.33 × 3 = 99.99，VIP 八折 = 79.992 → 79.99
    assertThat(calc.total(Collections.nCopies(3, new BigDecimal("33.33")), true))
            .isEqualByComparingTo("79.99");

    // 33.35 × 3 = 100.05，VIP 八折 = 80.04 → 80.04
    assertThat(calc.total(Collections.nCopies(3, new BigDecimal("33.35")), true))
            .isEqualByComparingTo("80.04");
}

@Test
@DisplayName("空清單回傳 0.00")
void emptyListReturnsZero() {
    assertThat(calc.total(List.of(), true)).isEqualByComparingTo("0.00");
    assertThat(calc.total(List.of(), false)).isEqualByComparingTo("0.00");
}

@Test
@DisplayName("prices 為 null 時，錯誤訊息要指出是哪個參數")
void rejectsNullList() {
    assertThatNullPointerException()
            .isThrownBy(() -> calc.total(null, false))
            .withMessageContaining("prices");
}
```

**⑥ 這一題的三個教訓**

1. **覆蓋率 100% ≠ 測試充分。** 這個例子的行覆蓋率和分支覆蓋率**都是 100%**，
   卻漏掉一個會直接造成金錢損失的 bug。
2. **邊界值必須明確測 `n-1` / `n` / `n+1`。** 測 1 和 20 不算測了邊界。
3. **「規則寫在 Javadoc 裡但沒有測試」= 那條規則不存在。**
   「兩種折扣可疊加」這句話沒有測試保護，
   隨時可能被某次重構改掉而無人察覺。

> 💡 **加碼練習**：把這段程式碼跑一次 PIT（11.16 節），
> 看它會回報幾個存活的突變。
> 補上上面所有測試之後再跑一次，觀察突變分數的變化。
> 這是體會「突變測試 vs 覆蓋率」差異最快的方式。

</details>

---

## 11.22 驗收清單

- [ ] 我能說出沒有測試的三個具體成本，以及測試真正買到的是什麼。
- [ ] 我知道測試金字塔的三層，也知道 Testcontainers 如何改變了比例。
- [ ] 我能判斷一個需求該用單元測試還是整合測試。
- [ ] 我知道 JUnit Platform / Jupiter / Vintage 的分工，以及為什麼要分層。
- [ ] 我能從零設定 JUnit 5 + AssertJ + Mockito 的 Maven 依賴與 surefire 參數。
- [ ] 我知道為什麼要用 `-javaagent` 明確掛載 Mockito。
- [ ] **我知道每個測試方法都會拿到一個新的測試類別實例，以及為什麼。**
- [ ] 我知道 `@BeforeAll` 為什麼必須是 `static`，以及 `PER_CLASS` 的代價。
- [ ] 我會用 `@Timeout` 的全域設定，也知道 `@Disabled` 一定要寫理由。
- [ ] 我知道 `@TestMethodOrder` 通常是設計問題的訊號。
- [ ] 我能說出 AssertJ 比內建斷言好在哪（失敗訊息的資訊量）。
- [ ] 我會用 `extracting` / `containsExactly` / `filteredOn` / `allSatisfy`。
- [ ] **我知道 `equals` 只比 id 的實體，要用 `usingRecursiveComparison` 才測得準。**
- [ ] 我知道 `BigDecimal` 要用 `isEqualByComparingTo`、`double` 要用 `isCloseTo`。
- [ ] 我會用 `assertThatThrownBy` 驗證型別、訊息關鍵字與 `ErrorCode`。
- [ ] 我知道不該斷言例外訊息的完整字串。
- [ ] 我知道 soft assertions 什麼時候該用、什麼時候會反咬一口。
- [ ] 我會寫自訂斷言，讓失敗訊息使用領域語言。
- [ ] 我的測試有清楚的 Arrange / Act / Assert 三段，而且只有一個 Act。
- [ ] 我能只看測試名字就說出它在驗證什麼規則。
- [ ] 我會用 `@Nested` + `@DisplayName` 讓測試報告變成規格書。
- [ ] 我能為不同情境選對 `@ValueSource` / `@CsvSource` / `@MethodSource` / `@EnumSource`。
- [ ] **我知道 `@EnumSource` 能讓「未來新增的 enum 值」自動被檢查。**
- [ ] 我知道參數化測試裡出現 `if/switch` 通常表示該拆開。
- [ ] 我測邊界時會測 `n-1`、`n`、`n+1`。
- [ ] 我知道例外測試要連「副作用有沒有發生」一起驗證。
- [ ] 我能分辨 dummy / stub / spy / mock / fake 五種替身，並選對。
- [ ] **我知道「stub 的東西就是要驗證的東西」時，這個測試是假的。**
- [ ] 我知道 Repository 這類有狀態的依賴該用 fake，Notifier 這類該用 mock，純函式該用真的。
- [ ] 我會用 `@Mock` / `@Captor` / `given` / `verify` / `ArgumentCaptor`。
- [ ] 我知道為什麼不該用 `@InjectMocks`。
- [ ] 我知道混用 matcher 和實際值會爆炸，而且爆在下一個測試。
- [ ] 我知道 strict stubs 抓的兩種問題，以及 `lenient()` 是最後手段。
- [ ] 我能說出 Mockito 的六個誤用，並在 code review 時認出它們。
- [ ] **我知道測試困難是設計問題的症狀，不是要克服的障礙。**
- [ ] 我會注入 `Clock`，也會用 `MutableClock` 測「時間經過」的邏輯。
- [ ] 我會用 `@TempDir` 測檔案 IO，也知道不該 mock 檔案系統。
- [ ] 我知道環境變數要抽成 `Function<String,String>`，而不是硬改全域狀態。
- [ ] 我能寫契約測試，讓一份規則驗證多個實作。
- [ ] 我知道契約該放什麼、不該放什麼（選配契約的概念）。
- [ ] **我知道併發測試需要起跑閘門，否則可能根本沒有併發。**
- [ ] 我知道 `Thread.sleep` 在測試裡幾乎永遠是錯的，該用 `CountDownLatch` 或 Awaitility。
- [ ] 我知道子執行緒丟出的例外不會讓測試失敗，必須收集 `Future`。
- [ ] 我知道時間斷言只能用來區分數量級。
- [ ] 我會設定 JaCoCo 門檻，也知道分支覆蓋率比行覆蓋率重要。
- [ ] **我知道覆蓋率會騙我的兩種情況，也知道它是「找漏洞」的工具而非 KPI。**
- [ ] 我知道突變測試在測什麼，也知道它為什麼比覆蓋率誠實。
- [ ] 我知道整合測試該命名成 `*IT`，交給 failsafe。
- [ ] 我能說出 flaky test 的六個來源，並各給一個修法。
- [ ] 我會用隨機執行順序找出測試之間的污染。
- [ ] 我知道開啟平行執行前要檢查什麼。
- [ ] 我的測試裡沒有 `if` / `for` / 計算出來的期望值。
- [ ] 我會用測試資料建構器讓每個測試的重點凸顯出來。
- [ ] 我會用 ArchUnit 把架構規範變成會失敗的測試。
- [ ] **我寫完測試後會故意改壞一行，確認測試真的會紅。**

---

> 這一章沒有教你任何新的語言特性，但它改變的是你**寫程式的方式**。
>
> 有安全網之前，「重構」是一件需要勇氣的事，所以大家選擇「在旁邊加一個新方法」——
> 於是類別越長越大，重複越來越多，直到沒人敢碰。
>
> 有安全網之後，重構只是一個動作：改、跑測試、綠燈、繼續。
> 你會開始**主動**改善設計，因為改善的成本降到幾乎為零。
>
> 而且你會發現一件事：**這一章講的每一個「為了可測試」的改動——
> 注入 `Clock`、抽出介面、分開計算與副作用、減少依賴數量——
> 全部都讓程式碼本身變得更好。**
>
> 這不是巧合。可測試性是好設計的一個側面，
> 而測試是唯一會誠實告訴你「這個設計好不好」的東西。

完成後請前往 [12-modern-java-records-sealed-pattern.md](./12-modern-java-records-sealed-pattern.md)。
