# 第 10 章：建置工具

> 前面九章我們都假裝「程式碼放進 IDE 按執行就好」。真實世界不是這樣。
>
> 真實世界是：你要把 15 個第三方套件、38 個它們的傳遞依賴、200 個 class 檔、
> 一份設定檔、一份版本號，變成**一個可以丟到伺服器上跑的檔案**；
> 而且下個月別人 clone 下來，要能建出**位元組完全相同**的東西。
>
> 這章講的就是這件事。它不炫，但它是「能不能出貨」的門檻。

---

## 10.1 學習目標

完成本章後，你應該可以：

- 說出沒有建置工具時會遇到的四個具體問題，以及 Maven 各自怎麼解。
- 讀懂並手寫一份完整的 `pom.xml`，知道每個區塊在管什麼。
- 說出 Maven 的三個生命週期、`default` 生命週期的關鍵 phase，以及 phase 與 goal 的差別。
- 正確選擇 `compile` / `provided` / `runtime` / `test` 範圍，並說明範圍如何影響傳遞。
- 用 `mvn dependency:tree` 找出依賴衝突，並用三種方式解掉它。
- 用 `dependencyManagement` 與 BOM 統一版本，說明它與 `dependencies` 的差別。
- 設定 compiler / surefire / failsafe / shade / enforcer / versions 六個必備外掛。
- 用 profile 處理環境差異，並知道 `activeByDefault` 的陷阱。
- 拆出一個多模組專案，說明 reactor 的建置順序怎麼決定。
- **把 Todo CLI 打包成 `java -jar` 就能跑的可執行 jar**，並比較四種打包做法。
- 對照 Gradle 的等價概念，說出兩者在依賴衝突解決上的**相反行為**。
- 用 Wrapper、`-T`、`-pl -am` 讓 CI 建置又快又可重現。
- 檢查依賴的已知漏洞並產出 SBOM。

---

## 10.2 沒有建置工具的世界

先體驗痛苦，才會珍惜工具。

假設我們要寫一支程式，讀一個 JSON 檔、印出裡面的待辦事項。用 Jackson。

### 第一步：手動下載 jar

你到 Maven Central 搜 `jackson-databind`，下載 `jackson-databind-2.17.2.jar`，放進 `lib/`。

```
myapp/
├── lib/
│   └── jackson-databind-2.17.2.jar
└── src/
    └── App.java
```

編譯：

```bash
javac -cp lib/jackson-databind-2.17.2.jar -d out src/App.java
```

編譯過了。執行：

```bash
java -cp out:lib/jackson-databind-2.17.2.jar App
```

```
Exception in thread "main" java.lang.NoClassDefFoundError:
    com/fasterxml/jackson/core/JsonFactory
	at com.fasterxml.jackson.databind.ObjectMapper.<clinit>(ObjectMapper.java:...)
	at App.main(App.java:12)
```

**痛點 1：傳遞依賴。** `jackson-databind` 自己依賴 `jackson-core` 和 `jackson-annotations`。
你怎麼知道？你不知道。你只能看到錯誤訊息、再回去下載一個、再跑、再看下一個錯誤。
這個過程叫「打地鼠」。而且 `NoClassDefFoundError` 是**執行期**才炸，編譯期完全看不出來（第 09 章 9.6 節）。

### 第二步：湊齊依賴

```
lib/
├── jackson-annotations-2.17.2.jar
├── jackson-core-2.17.2.jar
└── jackson-databind-2.17.2.jar
```

```bash
javac -cp "lib/jackson-annotations-2.17.2.jar:lib/jackson-core-2.17.2.jar:lib/jackson-databind-2.17.2.jar" \
      -d out src/App.java
```

跑起來了。三個 jar 而已，classpath 已經三行。真實專案 40 個 jar 是常態。

**痛點 2：classpath 手動維護。**
Windows 的分隔符是 `;`，Linux / macOS 是 `:`。同事的專案跑不起來，因為他在 Windows。
你寫了一個 `build.sh` 和一個 `build.bat`，兩份要同步維護。

### 第三步：加第二個套件

現在要加 `httpclient5`。它依賴 `httpcore5`、`slf4j-api`。
而 `slf4j-api`⋯⋯等等，另一個套件也依賴 `slf4j-api`，但是 `1.7.36`，這個要 `2.0.13`。

你把兩個都放進 `lib/`：

```
lib/
├── slf4j-api-1.7.36.jar
└── slf4j-api-2.0.13.jar
```

```
Exception in thread "main" java.lang.NoSuchMethodError:
    'void org.slf4j.spi.LoggingEventBuilder.log(java.lang.String)'
```

**痛點 3：版本衝突。**
JVM 的 classpath 是「**先找到誰就用誰**」。兩個 jar 都有 `org/slf4j/Logger.class`，
JVM 載入 classpath 上**第一個**，另一個永遠被遮蔽。
而 classpath 順序在你手寫的字串裡——換個順序，行為就變了。
這叫 **jar hell**，它產生的錯誤（`NoSuchMethodError`、`NoClassDefFoundError`、`AbstractMethodError`）
在編譯期完全看不出來。

### 第四步：要交付了

老闆說：「打包給我。」

你要：
1. 編譯 main 的程式碼。
2. 編譯 test 的程式碼（但 test 不能進交付物）。
3. 跑測試，失敗就停。
4. 把 `resources/` 的檔案複製進去。
5. 產生 `META-INF/MANIFEST.MF`，寫上 `Main-Class`。
6. 打成 jar。
7. 決定第三方 jar 要怎麼跟著走。
8. 蓋上版本號。

**痛點 4：流程沒有標準。**
你寫了一個 300 行的 shell script。三個月後你自己也看不懂。
換一個專案，另一個人寫了另一個 300 行的 script，長得完全不一樣。
新人進來，每個專案都要重學一次「怎麼 build」。

### Maven 怎麼解這四個痛點

| 痛點 | Maven 的解法 |
|------|-------------|
| 傳遞依賴 | 每個套件在中央倉庫都有自己的 `pom`，宣告了它的依賴。Maven 遞迴讀取，自動湊齊整棵樹 |
| classpath 手動維護 | 你不再碰 classpath。Maven 依 scope 算出正確的 classpath 交給 `javac` / `java` |
| 版本衝突 | 有明確的**衝突解決規則**（10.8 節），且 `dependency:tree` 讓衝突**看得見**、`enforcer` 讓衝突**建置失敗** |
| 流程沒有標準 | **生命週期**（10.5 節）。任何 Maven 專案，`mvn clean package` 都做一樣的事 |

Maven 最大的價值不是「自動下載 jar」，是**約定**（convention）。
`src/main/java` 放程式、`src/test/java` 放測試、`target/` 放產出——
全世界的 Java 專案都長一樣，所以你 clone 任何專案下來都知道東西在哪。

> **一句話總結**：建置工具不是幫你省打字，是把「怎麼建置這個專案」這件知識，
> 從**某個人的腦袋**移到**版本控制裡的一個檔案**。

---

## 10.3 座標、倉庫與版本

### 座標（GAV）

Maven 用一組座標唯一定位一個構件（artifact）：

```
groupId    : artifactId    : version    [: packaging] [: classifier]
com.example: todo-core     : 1.2.0      : jar
```

| 欄位 | 意義 | 慣例 |
|------|------|------|
| `groupId` | 組織 / 專案的命名空間 | 反寫網域，如 `com.example.shop`。**必須**是你控制的網域（要發佈到 Central 時會驗證） |
| `artifactId` | 這個模組的名字 | 全小寫、`-` 分隔，如 `todo-core`。同一個 group 內唯一 |
| `version` | 版本 | 語意化版本 `MAJOR.MINOR.PATCH`，開發中加 `-SNAPSHOT` |
| `packaging` | 產出型態 | `jar`（預設）/ `war` / `pom`（父模組）/ `maven-plugin` |
| `classifier` | 同一版本的變體 | `sources`、`javadoc`、`tests`、`jdk8`。不常自己用，但要看得懂 |

這組座標會**直接對應到倉庫裡的路徑**：

```
com.example : todo-core : 1.2.0 : jar
  ↓
~/.m2/repository/com/example/todo-core/1.2.0/todo-core-1.2.0.jar
                 ^^^^^^^^^^^ groupId 的 . 換成 /
```

實際目錄長這樣：

```
~/.m2/repository/com/example/todo-core/1.2.0/
├── todo-core-1.2.0.jar
├── todo-core-1.2.0.jar.sha1
├── todo-core-1.2.0.pom          ← 關鍵：Maven 讀這個才知道它的依賴
├── todo-core-1.2.0.pom.sha1
└── _remote.repositories         ← 記錄從哪個倉庫抓來的
```

**這就是傳遞依賴的祕密**：jar 旁邊永遠有一份 pom，pom 裡寫著它自己的依賴。
Maven 下載 A 的 pom → 看到它依賴 B → 下載 B 的 pom → 看到 B 依賴 C ⋯⋯遞迴到底。

### 倉庫的三層

```
┌─────────────────────────────────────────────────────────────┐
│ 1. 本機倉庫（local）  ~/.m2/repository                       │
│    第一個查的地方。找到就用，不連網。                          │
└──────────────────────────┬──────────────────────────────────┘
                           │ miss
                           ▼
┌─────────────────────────────────────────────────────────────┐
│ 2. 公司倉庫（mirror / proxy）Nexus、Artifactory              │
│    在 ~/.m2/settings.xml 設 <mirror>。                       │
│    好處：① 快 ② 公司內部套件放這 ③ Central 掛了還能建置        │
│         ④ 可以掃描漏洞、封鎖有問題的版本                       │
└──────────────────────────┬──────────────────────────────────┘
                           │ miss
                           ▼
┌─────────────────────────────────────────────────────────────┐
│ 3. Maven Central  https://repo.maven.apache.org/maven2      │
│    預設的遠端倉庫。已發佈的版本永不改變（immutable）。          │
└─────────────────────────────────────────────────────────────┘
```

`~/.m2/settings.xml` 的最小可用範例（有公司倉庫時）：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<settings xmlns="http://maven.apache.org/SETTINGS/1.0.0">

  <!-- 把所有請求導到公司倉庫 -->
  <mirrors>
    <mirror>
      <id>company-nexus</id>
      <name>Company Nexus</name>
      <url>https://nexus.example.com/repository/maven-public/</url>
      <!-- central：只鏡像 central。* 會鏡像全部，通常太粗暴 -->
      <mirrorOf>central</mirrorOf>
    </mirror>
  </mirrors>

  <!-- 上傳 / 讀取私有倉庫的憑證 -->
  <servers>
    <server>
      <id>company-releases</id>
      <username>${env.NEXUS_USER}</username>
      <password>${env.NEXUS_PASSWORD}</password>
    </server>
  </servers>

</settings>
```

> ⚠️ **`settings.xml` 絕對不要進版控。** 它裡面有憑證。
> 用 `${env.XXX}` 讀環境變數，或用 `mvn --encrypt-password` 產生加密字串
> （搭配 `~/.m2/settings-security.xml`）。CI 上用 secret 注入。
>
> 這是最常見的憑證外洩途徑之一：有人為了「讓同事能建置」把 `settings.xml`
> commit 進去，公司 Nexus 的帳密就躺在 git 歷史裡了——而且 git 歷史刪不掉，
> 只能改密碼。

### `SNAPSHOT` 與正式版的差別

| | 正式版 `1.2.0` | 快照版 `1.3.0-SNAPSHOT` |
|---|---|---|
| 可變嗎 | **不可變**。同一個座標永遠是同一份位元組 | **可變**。今天抓到的和明天抓到的可能不同 |
| 本機快取 | 抓一次，永遠不再檢查 | 預設**每天**檢查一次遠端有沒有更新 |
| 倉庫檔名 | `todo-core-1.2.0.jar` | `todo-core-1.3.0-20260817.093012-7.jar`（帶時間戳與流水號） |
| 能發佈到 Central 嗎 | 可以 | **不行** |
| 正式環境可以用嗎 | 可以 | **絕對不行** |

「正式環境不能用 SNAPSHOT」的理由很具體：
你在 3/1 部署了 `1.3.0-SNAPSHOT`，3/15 出事要回滾——
你**回滾不到 3/1 那份**，因為那個座標指向的內容已經被覆寫十幾次了。
可重現的部署，前提是可重現的依賴。

**強迫更新 SNAPSHOT**：

```bash
mvn -U clean package        # -U = --update-snapshots
```

**完全離線建置**（CI 上驗證依賴是否都已快取，或飛機上寫程式）：

```bash
mvn -o clean package        # -o = --offline
```

### 那個一定會遇到的錯誤

```
[ERROR] Failed to execute goal on project todo-core:
  Could not resolve dependencies for project com.example:todo-core:jar:1.0.0:
  Failure to find com.example:todo-model:jar:1.0.0 in https://repo.maven.apache.org/maven2
  was cached in the local repository, resolution will not be reattempted
  until the update interval of central has elapsed or updates are forced
```

**翻譯**：「我之前找過，找不到，我把『找不到』這件事也快取了。」

本機倉庫裡會留一個 `.lastUpdated` 檔記錄這件事。三種解法：

```bash
# 1. 強迫重新解析
mvn -U clean package

# 2. 清掉所有失敗記錄（比刪整個 ~/.m2 溫和多了）
find ~/.m2/repository -name "*.lastUpdated" -delete

# 3. 如果它其實是你自己的模組：先 install 它，或用多模組一起建（10.12 節）
mvn -pl todo-model -am install
```

> ⚠️ 千萬別因為這個錯誤就 `rm -rf ~/.m2/repository`。
> 那要重抓幾 GB，而且如果你有手動 `install` 進去的東西會一起消失。

---

## 10.4 `pom.xml` 逐行解剖

這是 Todo 專案的完整 `pom.xml`。每一行都有註解，**這份可以直接複製當範本**。

```xml
<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0
                             https://maven.apache.org/xsd/maven-4.0.0.xsd">

  <!-- ═══════════════════════════════════════════════════════════════
       1. POM 格式版本。Maven 3 只認 4.0.0，照抄就好。
       ═══════════════════════════════════════════════════════════════ -->
  <modelVersion>4.0.0</modelVersion>

  <!-- ═══════════════════════════════════════════════════════════════
       2. 本專案的座標（10.3 節）
       ═══════════════════════════════════════════════════════════════ -->
  <groupId>com.example</groupId>
  <artifactId>todo-cli</artifactId>
  <version>1.0.0-SNAPSHOT</version>
  <packaging>jar</packaging>

  <!-- 3. 給人看的資訊。發佈到 Central 時 name / description / url / licenses
          / developers / scm 都是必填，內部專案至少寫 name 與 description。 -->
  <name>Todo CLI</name>
  <description>純 Java 待辦事項命令列工具，Java 語言核心課程的練習專案</description>

  <!-- ═══════════════════════════════════════════════════════════════
       4. 屬性：把「會變的東西」集中在一個地方
          用 ${property.name} 在整份 pom 裡引用
       ═══════════════════════════════════════════════════════════════ -->
  <properties>
    <!-- 編譯目標。用 release 而不是 source/target，理由見下方說明 -->
    <maven.compiler.release>21</maven.compiler.release>

    <!-- 檔案編碼。不設會出現 "Using platform encoding, i.e. build is
         platform dependent!" 警告，且中文註解在別人機器上會變亂碼
         （第 07 章 7.6 節的老問題） -->
    <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
    <project.reporting.outputEncoding>UTF-8</project.reporting.outputEncoding>

    <!-- 可重現建置：固定所有產出檔案的時間戳（10.16 節） -->
    <project.build.outputTimestamp>2026-08-17T00:00:00Z</project.build.outputTimestamp>

    <!-- 依賴與外掛版本集中管理。改版本只改這裡一個字 -->
    <jackson.version>2.17.2</jackson.version>
    <junit.version>5.11.0</junit.version>
    <assertj.version>3.26.3</assertj.version>
    <mockito.version>5.13.0</mockito.version>

    <maven-compiler-plugin.version>3.13.0</maven-compiler-plugin.version>
    <maven-surefire-plugin.version>3.5.0</maven-surefire-plugin.version>
    <maven-failsafe-plugin.version>3.5.0</maven-failsafe-plugin.version>
    <maven-jar-plugin.version>3.4.2</maven-jar-plugin.version>
    <maven-shade-plugin.version>3.6.0</maven-shade-plugin.version>
    <maven-enforcer-plugin.version>3.5.0</maven-enforcer-plugin.version>

    <!-- 主類別。給 jar 與 shade 外掛共用，避免寫兩次寫不一樣 -->
    <main.class>com.example.todo.App</main.class>
  </properties>

  <!-- ═══════════════════════════════════════════════════════════════
       5. 依賴版本管理（不會真的引入依賴，只是「如果用到，就用這個版本」）
          10.9 節詳談
       ═══════════════════════════════════════════════════════════════ -->
  <dependencyManagement>
    <dependencies>
      <!-- 匯入 Jackson 的 BOM：之後所有 jackson-* 都不用寫 version -->
      <dependency>
        <groupId>com.fasterxml.jackson</groupId>
        <artifactId>jackson-bom</artifactId>
        <version>${jackson.version}</version>
        <type>pom</type>
        <scope>import</scope>
      </dependency>
      <!-- JUnit 5 的 BOM -->
      <dependency>
        <groupId>org.junit</groupId>
        <artifactId>junit-bom</artifactId>
        <version>${junit.version}</version>
        <type>pom</type>
        <scope>import</scope>
      </dependency>
    </dependencies>
  </dependencyManagement>

  <!-- ═══════════════════════════════════════════════════════════════
       6. 真正的依賴
       ═══════════════════════════════════════════════════════════════ -->
  <dependencies>

    <!-- JSON（第 07 章）。版本來自上面的 BOM -->
    <dependency>
      <groupId>com.fasterxml.jackson.core</groupId>
      <artifactId>jackson-databind</artifactId>
    </dependency>
    <!-- java.time 的支援模組（第 07 章 7.17 節：不加就會炸） -->
    <dependency>
      <groupId>com.fasterxml.jackson.datatype</groupId>
      <artifactId>jackson-datatype-jsr310</artifactId>
    </dependency>

    <!-- 日誌門面（第 04 章 4.11 節）。只依賴 API，不綁實作 -->
    <dependency>
      <groupId>org.slf4j</groupId>
      <artifactId>slf4j-api</artifactId>
      <version>2.0.16</version>
    </dependency>
    <!-- 實作：只在執行期需要，編譯期不該碰到它的類別 -->
    <dependency>
      <groupId>ch.qos.logback</groupId>
      <artifactId>logback-classic</artifactId>
      <version>1.5.8</version>
      <scope>runtime</scope>
    </dependency>

    <!-- 測試（第 11 章會用到） -->
    <dependency>
      <groupId>org.junit.jupiter</groupId>
      <artifactId>junit-jupiter</artifactId>
      <scope>test</scope>
    </dependency>
    <dependency>
      <groupId>org.assertj</groupId>
      <artifactId>assertj-core</artifactId>
      <version>${assertj.version}</version>
      <scope>test</scope>
    </dependency>
    <dependency>
      <groupId>org.mockito</groupId>
      <artifactId>mockito-core</artifactId>
      <version>${mockito.version}</version>
      <scope>test</scope>
    </dependency>

  </dependencies>

  <!-- ═══════════════════════════════════════════════════════════════
       7. 建置設定：外掛在這裡
       ═══════════════════════════════════════════════════════════════ -->
  <build>
    <!-- 產出檔名。預設是 ${artifactId}-${version}，
         改成固定名字，部署腳本就不用跟著版本變 -->
    <finalName>todo-cli</finalName>

    <!-- pluginManagement：同 dependencyManagement，只鎖版本不啟用 -->
    <pluginManagement>
      <plugins>
        <plugin>
          <groupId>org.apache.maven.plugins</groupId>
          <artifactId>maven-compiler-plugin</artifactId>
          <version>${maven-compiler-plugin.version}</version>
        </plugin>
        <plugin>
          <groupId>org.apache.maven.plugins</groupId>
          <artifactId>maven-surefire-plugin</artifactId>
          <version>${maven-surefire-plugin.version}</version>
        </plugin>
        <plugin>
          <groupId>org.apache.maven.plugins</groupId>
          <artifactId>maven-jar-plugin</artifactId>
          <version>${maven-jar-plugin.version}</version>
        </plugin>
        <plugin>
          <groupId>org.apache.maven.plugins</groupId>
          <artifactId>maven-shade-plugin</artifactId>
          <version>${maven-shade-plugin.version}</version>
        </plugin>
      </plugins>
    </pluginManagement>

    <plugins>
      <!-- 編譯 -->
      <plugin>
        <groupId>org.apache.maven.plugins</groupId>
        <artifactId>maven-compiler-plugin</artifactId>
        <configuration>
          <compilerArgs>
            <!-- 保留參數名稱。Jackson / Spring 綁定參數時會用到
                 （沒有它，反射拿到的是 arg0、arg1） -->
            <arg>-parameters</arg>
            <!-- 開啟所有警告，並把警告當錯誤（新專案值得，舊專案會哭） -->
            <arg>-Xlint:all</arg>
          </compilerArgs>
          <showDeprecation>true</showDeprecation>
        </configuration>
      </plugin>

      <!-- 打 jar，並寫入 Main-Class -->
      <plugin>
        <groupId>org.apache.maven.plugins</groupId>
        <artifactId>maven-jar-plugin</artifactId>
        <configuration>
          <archive>
            <manifest>
              <mainClass>${main.class}</mainClass>
            </manifest>
          </archive>
        </configuration>
      </plugin>
    </plugins>
  </build>

</project>
```

### 三個要特別解釋的地方

**① `maven.compiler.release` vs `source` + `target`**

你會在網路上看到大量這種寫法：

```xml
<properties>
  <maven.compiler.source>21</maven.compiler.source>
  <maven.compiler.target>21</maven.compiler.target>
</properties>
```

**這是 Java 8 時代的寫法，現在請用 `release`。** 差別是什麼？

| | `source` + `target` | `release` |
|---|---|---|
| 語法檢查 | 用 `source` 指定的版本 | 同 |
| bytecode 版本 | 用 `target` 指定的版本 | 同 |
| **檢查 API 是否存在** | ❌ **用當前 JDK 的 API** | ✅ 用目標版本的 API |

災難場景：你用 **JDK 21** 編譯，設 `source/target = 17`。你寫了：

```java
// Java 21 才有的方法
String s = someString.splitWithDelimiters("-", 2)[0];
```

編譯**通過**（因為 JDK 21 的 `String` 有這個方法），bytecode 標成 17。
部署到跑 JDK 17 的機器上：

```
java.lang.NoSuchMethodError: 'java.lang.String[] java.lang.String.splitWithDelimiters(...)'
```

**編譯期沒人攔你，上線才炸。** 這正是第 09 章 9.6 節說的那種錯誤。

`release` 會連 API 一起限制（它使用 JDK 內建的歷史 API 簽章檔），所以：

```
[ERROR] cannot find symbol
  symbol:   method splitWithDelimiters(java.lang.String,int)
  location: variable someString of type java.lang.String
```

**編譯期就攔下來了。**

> 什麼時候還需要 `source`/`target`？只有兩種情況：
> ① `release` 不支援的極舊目標（`release` 最低支援到 6，且新 JDK 會逐步移除舊版）；
> ② 你必須用到目標版本沒有的 JDK 內部 API（少見，且通常是設計問題）。
> **其餘一律用 `release`。**

**② `${project.build.sourceEncoding}` 為什麼一定要設**

不設的話，`maven-resources-plugin` 和 `maven-compiler-plugin` 會用**平台預設編碼**。
你的 macOS 是 UTF-8，同事的舊版 Windows 是 MS950/GBK。同一份程式碼：

```java
System.out.println("待辦事項");
```

在你機器上編出來正常，在他機器上編出來是 `å¾…è¾¦äº‹é ‡`。
而且這是**編譯進 class 檔的常量字串**，執行時無論怎麼設 `-Dfile.encoding` 都救不回來。

> Java 18 起 `file.encoding` 預設就是 UTF-8（JEP 400），但那是**執行期**；
> Maven 外掛讀原始檔的編碼是**建置期**的事，還是要明確設定。

**③ `<finalName>` 的取捨**

```xml
<finalName>todo-cli</finalName>
```

產出 `target/todo-cli.jar` 而不是 `target/todo-cli-1.0.0-SNAPSHOT.jar`。

- **好處**：Dockerfile 裡可以寫 `COPY target/todo-cli.jar app.jar`，不用每次改版本號。
- **壞處**：如果這個模組會被別的模組依賴（安裝到倉庫），倉庫裡的檔名**還是**帶版本的
  （`finalName` 只影響 `target/` 裡的名字），有時會讓人困惑。函式庫模組建議不要改。

---

## 10.5 生命週期、phase、goal、plugin

這是 Maven 最容易被誤解的部分。搞懂它，你就不會再「不知道該打哪個指令」。

### 三個生命週期

Maven 有三個**互相獨立**的內建生命週期：

```
clean 生命週期        default 生命週期            site 生命週期
──────────────       ────────────────           ─────────────
pre-clean            validate                    pre-site
clean          ←     initialize                  site
post-clean           generate-sources            post-site
                     process-sources             site-deploy
                     generate-resources
                     process-resources     ← 複製 src/main/resources
                     compile               ← javac src/main/java
                     process-classes
                     generate-test-sources
                     process-test-sources
                     generate-test-resources
                     process-test-resources
                     test-compile          ← javac src/test/java
                     process-test-classes
                     test                  ← 跑單元測試（surefire）
                     prepare-package
                     package               ← 打成 jar / war
                     pre-integration-test
                     integration-test      ← 跑整合測試（failsafe）
                     post-integration-test
                     verify                ← 檢查（含 failsafe 驗證結果）
                     install               ← 裝進 ~/.m2/repository
                     deploy                ← 上傳到遠端倉庫
```

**最重要的規則：執行某個 phase，它前面的所有 phase 都會先執行。**

```bash
mvn package
# 實際執行：validate → ... → process-resources → compile → ...
#           → test-compile → test → prepare-package → package
```

所以 `mvn package` **一定會跑測試**。測試失敗，就沒有 jar。這是刻意設計的。

### 為什麼幾乎都要加 `clean`

```bash
mvn clean package     # 兩個生命週期，各自從頭跑
```

`clean` 和 `default` 是**不同的生命週期**，所以 `mvn package` 不會自動 clean。

不 clean 會出什麼事？Maven 的增量編譯只比對時間戳，**不追蹤依賴關係**：

```
你把 Foo.java 刪掉，改成 Bar.java
  → target/classes/Foo.class 還在（沒人去刪它）
  → 打包時 Foo.class 被包進 jar
  → 執行期，反射掃描 / SPI 載入到了一個「已經不存在」的類別
  → NoClassDefFoundError，而 grep 整個原始碼都找不到 Foo
```

這種鬼故事一年會遇到一兩次。**CI 上永遠 `clean`；本機為了快可以不 clean，但遇到「不可能的錯誤」第一件事就是 `mvn clean`。**

### phase vs goal

| | phase | goal |
|---|---|---|
| 是什麼 | 生命週期的一個**階段**，是抽象的「時機」 | **外掛裡的一個具體動作** |
| 誰提供 | Maven 核心定義 | 外掛（plugin）提供 |
| 寫法 | `mvn compile` | `mvn compiler:compile`（`前綴:goal`） |
| 類比 | 「早上」 | 「刷牙」 |

**phase 本身不做事**，它只是一個掛鉤點。真正做事的是綁在上面的 goal。

`jar` packaging 的預設綁定：

| phase | 綁定的 goal | 外掛 |
|-------|------------|------|
| `process-resources` | `resources:resources` | maven-resources-plugin |
| `compile` | `compiler:compile` | maven-compiler-plugin |
| `process-test-resources` | `resources:testResources` | maven-resources-plugin |
| `test-compile` | `compiler:testCompile` | maven-compiler-plugin |
| `test` | `surefire:test` | maven-surefire-plugin |
| `package` | `jar:jar` | maven-jar-plugin |
| `install` | `install:install` | maven-install-plugin |
| `deploy` | `deploy:deploy` | maven-deploy-plugin |

想親眼看到這些綁定：

```bash
mvn help:describe -Dcmd=package
```

### 直接呼叫 goal（不走生命週期）

```bash
mvn dependency:tree              # 只印依賴樹，不編譯
mvn versions:display-dependency-updates
mvn help:effective-pom
```

這些指令**不會**觸發 `compile`，因為你沒有指定任何 phase。
這也是它們快的原因，也是它們有時「拿到舊資料」的原因
（例如 `dependency:tree` 讀的是 pom，不需要編譯，所以永遠是最新的；
但 `exec:java` 讀 `target/classes`，如果你沒先 `compile` 就會跑到舊 class）。

### 自己把 goal 綁到 phase

`<executions>` 就是在做這件事：

```xml
<plugin>
  <groupId>org.apache.maven.plugins</groupId>
  <artifactId>maven-shade-plugin</artifactId>
  <version>3.6.0</version>
  <executions>
    <execution>
      <id>make-executable-jar</id>   <!-- 給這次綁定一個名字，方便看 log -->
      <phase>package</phase>         <!-- 綁在哪個 phase -->
      <goals>
        <goal>shade</goal>           <!-- 執行哪個 goal -->
      </goals>
      <configuration>
        <!-- 這次執行專屬的設定 -->
      </configuration>
    </execution>
  </executions>
</plugin>
```

> 每個 goal 都有**預設 phase**。像 `shade:shade` 預設就是 `package`，
> 所以上面的 `<phase>package</phase>` 其實可以省略。
> 但**寫出來比較好**——讀 pom 的人不用去查文件才知道它什麼時候跑。

### 讀懂建置輸出

```
[INFO] Scanning for projects...
[INFO]
[INFO] -----------------------< com.example:todo-cli >------------------------
[INFO] Building Todo CLI 1.0.0-SNAPSHOT
[INFO]   from pom.xml
[INFO] --------------------------------[ jar ]---------------------------------
[INFO]
[INFO] --- clean:3.2.0:clean (default-clean) @ todo-cli ---
[INFO] Deleting /Users/gary/todo-cli/target
[INFO]
[INFO] --- resources:3.3.1:resources (default-resources) @ todo-cli ---
[INFO] Copying 2 resources from src/main/resources to target/classes
[INFO]
[INFO] --- compiler:3.13.0:compile (default-compile) @ todo-cli ---
[INFO] Changes detected - recompiling the module! :source
[INFO] Compiling 14 source files with javac [debug release 21] to target/classes
[INFO]
[INFO] --- surefire:3.5.0:test (default-test) @ todo-cli ---
[INFO] Tests are skipped.
[INFO]
[INFO] --- jar:3.4.2:jar (default-jar) @ todo-cli ---
[INFO] Building jar: /Users/gary/todo-cli/target/todo-cli.jar
[INFO]
[INFO] --- shade:3.6.0:shade (make-executable-jar) @ todo-cli ---
[INFO] Including com.fasterxml.jackson.core:jackson-databind:jar:2.17.2 in the shaded jar.
[INFO] Replacing /Users/gary/todo-cli/target/todo-cli.jar with .../todo-cli-1.0.0-SNAPSHOT-shaded.jar
[INFO] ------------------------------------------------------------------------
[INFO] BUILD SUCCESS
[INFO] ------------------------------------------------------------------------
[INFO] Total time:  6.481 s
```

每一行 `--- 外掛:版本:goal (execution-id) @ 模組 ---` 都告訴你四件事。
**`(default-compile)` 這種 `default-` 前綴的 execution id，表示它是生命週期預設綁定的**；
`(make-executable-jar)` 是你自己在 pom 裡命名的。
排查「為什麼這個外掛跑了兩次」時，看 execution id 就知道是誰。

### 常用指令速查

```bash
mvn clean                       # 只刪 target/
mvn compile                     # 編譯 main
mvn test                        # 編譯 + 跑單元測試
mvn package                     # 上面全部 + 打 jar
mvn verify                      # 上面全部 + 整合測試 + 檢查
mvn install                     # 上面全部 + 裝進本機倉庫（給同機器其他專案用）
mvn deploy                      # 上面全部 + 上傳遠端倉庫

mvn clean package -DskipTests            # 跳過「執行」測試（但仍會編譯測試）
mvn clean package -Dmaven.test.skip=true # 連測試都不編譯（更快，但更危險）
mvn test -Dtest=TodoServiceTest          # 只跑一個測試類別
mvn test -Dtest='TodoServiceTest#shouldRejectEmptyTitle'  # 只跑一個方法

mvn -q package                  # quiet，只印警告與錯誤
mvn -ntp package                # 不印下載進度（CI log 會乾淨很多）
mvn -X package                  # debug，排查外掛行為時用
mvn -e package                  # 顯示完整 stack trace
```

> **`-DskipTests` vs `-Dmaven.test.skip=true`**
> 前者「編譯但不執行」——測試程式碼的編譯錯誤還是會被抓到。
> 後者「連編譯都跳過」——快，但你的測試可能已經編不過了而你不知道。
> **趕時間用前者，只有在確定不需要測試產出時（例如只想拿 jar 做手動驗證）才用後者。**
> CI 上兩個都不該出現。

---

## 10.6 標準目錄結構與資源處理

### 約定的目錄

```
todo-cli/
├── pom.xml
├── src/
│   ├── main/
│   │   ├── java/              ← 產品程式碼      → target/classes
│   │   ├── resources/         ← 產品資源        → target/classes（和 class 混在一起！）
│   │   └── java/module-info.java  ← 有的話就是 JPMS 模組（10.13 節）
│   └── test/
│       ├── java/              ← 測試程式碼      → target/test-classes
│       └── resources/         ← 測試資源        → target/test-classes
└── target/                    ← 全部產出，一定要 .gitignore
    ├── classes/
    ├── test-classes/
    ├── generated-sources/
    ├── surefire-reports/      ← 測試報告（CI 失敗時看這裡）
    ├── todo-cli.jar
    └── maven-status/
```

**關鍵認知：`src/main/resources` 的內容會被複製到 `target/classes`，和 `.class` 檔混在一起。**

所以：

```
src/main/resources/logback.xml   →   target/classes/logback.xml   →   jar 根目錄的 logback.xml
```

這就是為什麼你用 classpath 讀得到它：

```java
// 從 classpath 根目錄讀。前導 / 表示絕對路徑（第 07 章 7.8 節）
try (InputStream in = App.class.getResourceAsStream("/logback.xml")) {
    // ...
}
```

> ⚠️ **`getResourceAsStream` 回傳的 `InputStream` 可能是 `null`**（檔案不存在時），
> 而 try-with-resources 對 `null` 資源不會 NPE（它只在非 null 時 close），
> 但你**用它的下一行**就會 NPE。務必先檢查：
>
> ```java
> InputStream in = App.class.getResourceAsStream("/logback.xml");
> if (in == null) {
>     throw new IllegalStateException("classpath 上找不到 logback.xml");
> }
> try (in) { /* ... */ }
> ```

> ⚠️ **打成 jar 之後，資源不再是「檔案」。**
> `getResource("/data.json").getPath()` 會給你 `file:/app/todo.jar!/data.json`，
> 拿去 `new File(...)` 或 `Path.of(...)` 一定失敗。
> **永遠用 `getResourceAsStream()` 讀，不要試著轉成 `Path`。**
> 這是「在 IDE 跑得好、打包後就炸」的頭號原因。

### 改掉預設目錄（不建議，但要看得懂）

```xml
<build>
  <sourceDirectory>${project.basedir}/java-src</sourceDirectory>
  <testSourceDirectory>${project.basedir}/java-test</testSourceDirectory>
  <outputDirectory>${project.basedir}/build/classes</outputDirectory>
</build>
```

看到這種 pom，通常是從 Ant 遷移過來的老專案。**新專案請遵守約定**——
違反約定的代價是每個工具（IDE、SonarQube、覆蓋率、各種外掛）都要額外設定。

### 資源過濾（filtering）：把建置期資訊注入程式

這是很實用的一招。假設你希望程式能印出自己的版本號：

**`src/main/resources/build-info.properties`**

```properties
app.name=${project.name}
app.version=${project.version}
app.buildTime=${maven.build.timestamp}
app.javaTarget=${maven.compiler.release}
```

**`pom.xml`**

```xml
<properties>
  <!-- 預設格式是 yyyyMMdd-HHmm，且是 UTC -->
  <maven.build.timestamp.format>yyyy-MM-dd'T'HH:mm:ss'Z'</maven.build.timestamp.format>
</properties>

<build>
  <resources>
    <!-- 只對需要替換的檔案開 filtering -->
    <resource>
      <directory>src/main/resources</directory>
      <filtering>true</filtering>
      <includes>
        <include>build-info.properties</include>
      </includes>
    </resource>
    <!-- 其餘照抄，不過濾 -->
    <resource>
      <directory>src/main/resources</directory>
      <filtering>false</filtering>
      <excludes>
        <exclude>build-info.properties</exclude>
      </excludes>
    </resource>
  </resources>
</build>
```

**讀取它：**

```java
package com.example.todo.support;

import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.util.Properties;

/** 建置資訊。從 classpath 的 build-info.properties 讀，Maven 在建置時填入實際值。 */
public final class BuildInfo {

    private static final Properties PROPS = load();

    private BuildInfo() {
    }

    private static Properties load() {
        Properties p = new Properties();
        try (InputStream in = BuildInfo.class.getResourceAsStream("/build-info.properties")) {
            if (in == null) {
                // 從 IDE 直接跑、沒經過 Maven 時會走到這裡，不該讓程式掛掉
                p.setProperty("app.version", "dev");
                p.setProperty("app.buildTime", "unknown");
                return p;
            }
            p.load(in);
            return p;
        } catch (IOException e) {
            throw new UncheckedIOException("讀取 build-info.properties 失敗", e);
        }
    }

    public static String version() {
        return PROPS.getProperty("app.version", "unknown");
    }

    public static String buildTime() {
        return PROPS.getProperty("app.buildTime", "unknown");
    }

    /** 給 `todo --version` 用的單行字串 */
    public static String describe() {
        return "%s %s (built %s)".formatted(
                PROPS.getProperty("app.name", "todo"), version(), buildTime());
    }
}
```

執行結果：

```
$ java -jar target/todo-cli.jar --version
Todo CLI 1.0.0-SNAPSHOT (built 2026-08-17T09:42:11Z)
```

**為什麼這件事很重要**：線上出事時，第一個問題永遠是「現在跑的是哪一版」。
如果程式自己能回答，你省下十分鐘的猜測。
（第 02 站的 Spring Boot Actuator 有 `/actuator/info` 做同一件事，
原理就是這個——`spring-boot-maven-plugin` 的 `build-info` goal 產生 `build-info.properties`。）

### 過濾的兩個陷阱

**陷阱 1：二進位檔被破壞。**
`filtering` 會**逐字元讀寫**檔案。對 `.png`、`.jks`、`.p12`、`.xlsx` 開 filtering，
檔案會被編碼轉換弄壞。所以上面的範例特意用 `<includes>` 精確指定要過濾的檔案。

**陷阱 2：和 Spring 的 `${}` 撞語法。**
`application.properties` 裡的 `${JDBC_URL}` 本來是要給 Spring 在執行期解析的，
但 filtering 會在**建置期**就把它換成空字串（因為 Maven 找不到這個屬性）。

解法是改掉 Maven 的分隔符：

```xml
<properties>
  <!-- 用 @ 當分隔符，避開 ${} -->
  <resource.delimiter>@</resource.delimiter>
</properties>

<build>
  <plugins>
    <plugin>
      <groupId>org.apache.maven.plugins</groupId>
      <artifactId>maven-resources-plugin</artifactId>
      <version>3.3.1</version>
      <configuration>
        <delimiters>
          <delimiter>@</delimiter>
        </delimiters>
        <useDefaultDelimiters>false</useDefaultDelimiters>
      </configuration>
    </plugin>
  </plugins>
</build>
```

然後 properties 檔寫成 `app.version=@project.version@`。
（`spring-boot-starter-parent` 預設就幫你做了這件事，這也是為什麼
Spring Boot 專案的 `application.yml` 裡看得到 `@project.version@` 這種寫法。）

---

## 10.7 依賴範圍（scope）

scope 回答兩個問題：**① 這個依賴在哪些 classpath 上？② 它會不會傳遞給我的使用者？**

| scope | 編譯 main | 編譯 test | 執行期 | 打進 war/uber-jar | 會傳遞嗎 | 典型用途 |
|-------|:---------:|:---------:|:------:|:----------------:|:--------:|---------|
| `compile`（預設） | ✅ | ✅ | ✅ | ✅ | ✅ | Jackson、Guava、你自己的函式庫 |
| `provided` | ✅ | ✅ | ❌ | ❌ | ❌ | `jakarta.servlet-api`、Lombok、容器提供的東西 |
| `runtime` | ❌ | ✅ | ✅ | ✅ | ✅ | JDBC 驅動、`logback-classic`、SPI 實作 |
| `test` | ❌ | ✅ | ❌ | ❌ | ❌ | JUnit、Mockito、AssertJ、Testcontainers |
| `system` | ✅ | ✅ | ❌ | ❌ | ❌ | **已棄用**，指向本機絕對路徑。看到就想辦法幹掉 |
| `import` | — | — | — | — | — | 只用在 `dependencyManagement` + `<type>pom</type>`（10.9 節） |

### 逐個講清楚

**`compile`——預設，但別當萬用值**

大部分依賴確實是 `compile`。但如果你什麼都不寫，會出現兩個問題：

1. 你的**使用者**被迫接收所有依賴（包含他根本不需要的），衝突機率大增。
2. 執行期的 classpath 上有一堆編譯期用不到的類別，`ClassNotFoundException` 的搜尋範圍變大。

**`provided`——「別人會給我，我只要能編譯」**

```xml
<!-- 部署到 Tomcat 時，容器已經有 servlet-api 了 -->
<dependency>
  <groupId>jakarta.servlet</groupId>
  <artifactId>jakarta.servlet-api</artifactId>
  <version>6.1.0</version>
  <scope>provided</scope>
</dependency>
```

如果忘記寫 `provided`，這個 jar 會被打進 war 的 `WEB-INF/lib`，
和 Tomcat 自己的版本打架：

```
java.lang.LinkageError: loader constraint violation:
  loader ... previously initiated loading for a different type with name
  "jakarta/servlet/http/HttpServletRequest"
```

同一個類別被兩個 ClassLoader 各載一次，JVM 認為它們是**不同的類別**（第 09 章 9.6 節：
類別的身分是「全名 + ClassLoader」）。

Lombok 也是 `provided`（其實更精確是 `<optional>true</optional>` 或 `annotationProcessor`）——
它只在編譯期產生程式碼，執行期完全不需要。

**`runtime`——「編譯期我不該看到它」**

```xml
<dependency>
  <groupId>org.postgresql</groupId>
  <artifactId>postgresql</artifactId>
  <version>42.7.4</version>
  <scope>runtime</scope>
</dependency>
```

這是**設計上的強制**，不只是省空間：
你的程式碼應該只依賴 `java.sql.*`（或 JPA 介面），不該 `import org.postgresql.*`。
把驅動設成 `runtime`，編譯器會替你把關——誰不小心 import 了具體驅動，
**編譯就會失敗**。這是第 03 章 3.11 節「對介面編程」的建置期版本。

`logback-classic` 同理：程式碼只用 `org.slf4j.Logger`（`compile`），
實作用 `runtime`。這樣你要換成 `log4j2` 只需改 pom，一行 Java 都不用動。

**`test`——最常被忘記的那個**

```xml
<dependency>
  <groupId>org.junit.jupiter</groupId>
  <artifactId>junit-jupiter</artifactId>
  <scope>test</scope>
</dependency>
```

忘記寫 `test` 的後果，我見過真實案例：

某個團隊的 `pom.xml` 裡 JUnit 是 `compile`。有人在產品程式碼寫了：

```java
// 在 src/main/java 裡面！
import static org.junit.jupiter.api.Assertions.assertNotNull;

public void process(Order order) {
    assertNotNull(order);   // 「反正編譯過了」
    // ...
}
```

上線後 `junit-jupiter` 沒被打進交付物（有人後來修正了 scope）→
`NoClassDefFoundError` 在正式環境的核心付款流程炸開。

**`test` scope 不是為了省空間，是為了讓「產品程式碼用測試工具」在編譯期就不可能。**

### scope 如何影響傳遞

這是一張要記住的表。左邊是「A 依賴 B 的 scope」，上面是「B 依賴 C 的 scope」，
格子裡是「C 對 A 而言的 scope」（`—` 表示 C 完全不會傳到 A）：

```
                     B 對 C 宣告的 scope
A 對 B 的 scope   compile   provided   runtime   test
─────────────────────────────────────────────────────
compile          compile      —       runtime     —
provided         provided     —      provided     —
runtime          runtime      —       runtime     —
test             test         —        test       —
```

三個要記的結論：

1. **`provided` 和 `test` 永不傳遞。** 你依賴的函式庫用了 JUnit，
   JUnit 不會出現在你的 classpath 上。這就是它們存在的意義。
2. **`compile` 傳遞後遇到 `runtime` 會降級成 `runtime`。**
   別人的 `runtime` 依賴，對你也只是 `runtime`——你編譯不到它。
3. **`provided` 這一列**：你以 `provided` 依賴 B，B 的 `compile` 依賴 C
   對你也變成 `provided`。合理——反正整包都不會進交付物。

### 一個實務決策清單

| 這個依賴是⋯ | scope |
|---|---|
| 出現在我的 `public` 方法簽章裡 | `compile`（Gradle 是 `api`，見 10.15 節） |
| 我的實作內部用，但不外露 | `compile`（Gradle 是 `implementation`） |
| 只有註解處理器 / 編譯期產生程式碼 | `provided` + `<optional>true</optional>` |
| JDBC 驅動、日誌實作、SPI 實作 | `runtime` |
| 應用伺服器 / 執行環境會提供 | `provided` |
| 只有測試用得到 | `test` |
| 指向本機硬碟上的一個 jar | **重新設計**。放進公司 Nexus，不要用 `system` |

### 檢查你的 scope 有沒有寫錯

```bash
mvn dependency:analyze
```

```
[WARNING] Used undeclared dependencies found:
[WARNING]    com.fasterxml.jackson.core:jackson-core:jar:2.17.2:compile
[WARNING] Unused declared dependencies found:
[WARNING]    org.apache.commons:commons-lang3:jar:3.17.0:compile
```

- **Used undeclared**：你的程式碼直接用了某個**傳遞**依賴的類別。
  危險——哪天上游把它移除，你就編不過了。**應該明確宣告出來。**
- **Unused declared**：宣告了但沒用到。可以移除。
  ⚠️ **但會有誤判**：靠反射 / SPI 載入的東西（JDBC 驅動、`logback-classic`）
  程式碼裡確實沒有 import，會被誤報。用 `<ignoredUnusedDeclaredDependencies>` 標註它們。

---

## 10.8 依賴傳遞與衝突解決

這是 Maven 最會咬人的地方，也是面試最愛問的。

### 先看見問題

```xml
<dependencies>
  <dependency>
    <groupId>com.example</groupId>
    <artifactId>service-a</artifactId>
    <version>1.0.0</version>
  </dependency>
  <dependency>
    <groupId>com.example</groupId>
    <artifactId>service-b</artifactId>
    <version>2.0.0</version>
  </dependency>
</dependencies>
```

跑 `mvn dependency:tree`：

```
[INFO] com.example:todo-cli:jar:1.0.0-SNAPSHOT
[INFO] +- com.example:service-a:jar:1.0.0:compile
[INFO] |  \- com.google.guava:guava:jar:31.1-jre:compile
[INFO] \- com.example:service-b:jar:2.0.0:compile
[INFO]    \- com.google.guava:guava:jar:33.3.0-jre:compile   ← 沒印出來！
```

實際輸出只會有**一個** guava。因為 Maven **在解析階段就把衝突消掉了**——
最終 classpath 上永遠只有一個版本的 `guava`。

### 規則一：最近者優先（nearest wins）

**「路徑最短的那個版本贏。」** 路徑長度 = 從你的專案走到那個依賴要經過幾層。

```
todo-cli (深度 0)
├── service-a (深度 1)
│   └── guava:31.1-jre (深度 2)
└── service-b (深度 1)
    └── commons-x (深度 2)
        └── guava:33.3.0-jre (深度 3)      ← 深度 3，輸給深度 2
```

結果：**`guava:31.1-jre` 勝出**。

> ⚠️ **注意這件事的荒謬之處**：Maven 選的是**路徑近的**，不是**版本新的**。
> 上面的例子裡，較舊的 31.1 打贏了較新的 33.3。
> 如果 `service-b` 需要 33.3 的新 API，執行期就會 `NoSuchMethodError`。
>
> **這是 Maven 和 Gradle 最大的行為差異——Gradle 是「最高版本優先」。**
> 同一份依賴清單，兩個工具可能選出不同版本（10.15 節）。

**為什麼 Maven 這樣設計？** 因為「離你最近」代表「你（或你直接依賴的人）
的意圖最明確」。而且它讓結果**可預測**：你在自己 pom 裡直接宣告一個版本
（深度 1），就永遠贏過所有傳遞依賴。這就是規則一的實用推論——
**直接宣告是最強的覆寫方式**。

### 規則二：同深度時，先宣告者勝

```
todo-cli
├── service-a (深度 1)
│   └── guava:31.1-jre (深度 2)     ← 先宣告
└── service-b (深度 1)
    └── guava:33.3.0-jre (深度 2)   ← 後宣告，輸
```

結果：`guava:31.1-jre`。

**這條規則的可怕之處**：`<dependencies>` 裡兩個依賴**交換順序**，
你的執行期行為就變了。而交換順序這種事⋯⋯

```
- 有人為了「整理得比較整齊」把 pom 依字母排序
- IDE 的 "Optimize imports / sort dependencies" 功能
- 合併 git 衝突時順序被改掉
```

⋯⋯都可能在沒有任何 Java 程式碼變更的情況下，把正式環境弄壞。

> **所以：不要依賴這條規則。** 遇到同深度衝突，明確處理它（下面三種方式），
> 或用 `enforcer` 讓它建置失敗（10.10 節）。

### 看見完整的衝突：`-Dverbose`

```bash
mvn dependency:tree -Dverbose
```

```
[INFO] com.example:todo-cli:jar:1.0.0-SNAPSHOT
[INFO] +- com.example:service-a:jar:1.0.0:compile
[INFO] |  \- com.google.guava:guava:jar:31.1-jre:compile
[INFO] \- com.example:service-b:jar:2.0.0:compile
[INFO]    \- (com.google.guava:guava:jar:33.3.0-jre:compile
[INFO]        - omitted for conflict with 31.1-jre)
```

`omitted for conflict with 31.1-jre` — 這就是你要找的那行字。

只看某個套件：

```bash
mvn dependency:tree -Dincludes=com.google.guava
mvn dependency:tree -Dincludes=*:*slf4j*        # 支援萬用字元
mvn dependency:tree -Dverbose -Dincludes=com.google.guava:guava
```

輸出成檔案（超過幾百行時很有用）：

```bash
mvn dependency:tree -DoutputFile=target/deps.txt -DappendOutput=true
mvn dependency:tree -DoutputType=dot -DoutputFile=target/deps.dot   # 可以用 Graphviz 畫圖
```

> ⚠️ `-Dverbose` 印出的樹是外掛**重新計算**的（Maven 核心在解析時就丟掉了被淘汰的節點），
> 所以偶爾會和真實 classpath 有細微差異。想看**真正的** classpath：
>
> ```bash
> mvn dependency:list                    # 平坦清單，這就是最終結果
> mvn dependency:build-classpath -Dmdep.outputFile=target/cp.txt
> ```

### 三種解衝突的方式

**方式 A：直接宣告（最常用、最好懂）**

```xml
<dependencies>
  <!-- 明確指定我要哪一版。深度 1，贏過所有傳遞依賴 -->
  <dependency>
    <groupId>com.google.guava</groupId>
    <artifactId>guava</artifactId>
    <version>33.3.0-jre</version>
  </dependency>
  <!-- ... -->
</dependencies>
```

**缺點**：這個依賴出現在 `<dependencies>` 裡，看起來像「我直接用它」，
但其實你只是在調停衝突。加個註解說明：

```xml
<!-- 不是我們直接用，是為了解 service-a(31.1) 與 service-b(33.3) 的衝突。
     選新版因為 service-b 需要 33.x 的 Collectors API。
     等 service-a 升級後可移除。 -->
```

**方式 B：`dependencyManagement`（推薦，尤其多模組）**

```xml
<dependencyManagement>
  <dependencies>
    <dependency>
      <groupId>com.google.guava</groupId>
      <artifactId>guava</artifactId>
      <version>33.3.0-jre</version>
    </dependency>
  </dependencies>
</dependencyManagement>
```

**這不會引入依賴**，只是宣告「如果最終用到 guava，一律用 33.3.0-jre」。
語意更誠實，而且在父 pom 裡寫一次，所有子模組通用。

> 🔥 **重要且違反直覺**：`dependencyManagement` 的優先權**高於**「最近者優先」。
> 它是在依賴解析的最後階段強制套用的。所以父 pom 裡的一行 `dependencyManagement`，
> 可以無聲地覆寫掉你子模組期待的版本——這是多模組專案最常見的「我明明寫了 2.0，
> 為什麼跑起來是 1.5」之謎。**排查時第一個動作：`mvn help:effective-pom`。**

**方式 C：`<exclusions>`（外科手術）**

```xml
<dependency>
  <groupId>com.example</groupId>
  <artifactId>service-a</artifactId>
  <version>1.0.0</version>
  <exclusions>
    <exclusion>
      <groupId>com.google.guava</groupId>
      <artifactId>guava</artifactId>
    </exclusion>
  </exclusions>
</dependency>
```

用在**你不想要這個傳遞依賴，或它會和別的東西打架**時。
最經典的例子是排掉重複的日誌實作：

```xml
<dependency>
  <groupId>org.springframework.boot</groupId>
  <artifactId>spring-boot-starter-web</artifactId>
  <exclusions>
    <!-- 排掉 logback，改用 log4j2 -->
    <exclusion>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-logging</artifactId>
    </exclusion>
  </exclusions>
</dependency>
```

排除所有傳遞依賴（Maven 3.2.1+，慎用）：

```xml
<exclusions>
  <exclusion>
    <groupId>*</groupId>
    <artifactId>*</artifactId>
  </exclusion>
</exclusions>
```

> ⚠️ `exclusion` 是**逐個依賴**設定的。如果三個依賴都傳遞了同一個壞東西，
> 你要寫三次 exclusion。漏一個就沒效果——這是 exclusion 最煩的地方。
> 要全域排除，用 `enforcer` 的 `bannedDependencies` 規則（10.10 節）更可靠。

### 三種方式怎麼選

| 情況 | 用哪個 |
|---|---|
| 單模組專案，只是要指定版本 | A 直接宣告 |
| 多模組，要統一整個專案的版本 | B `dependencyManagement` |
| 上游用了整個生態系（Spring、Jackson） | B 的 BOM 形式（10.9 節） |
| 某個傳遞依賴根本不該存在（重複日誌實作、舊版 API 包） | C `exclusions` |
| 想禁止某個套件出現在任何地方 | `enforcer` 的 `bannedDependencies` |

### 真實案例：三個 SLF4J 打架

這是我最常在別人專案裡看到的問題。

**症狀**（啟動時的警告）：

```
SLF4J: Class path contains multiple SLF4J providers.
SLF4J: Found provider [ch.qos.logback.classic.spi.LogbackServiceProvider@1b6d3586]
SLF4J: Found provider [org.slf4j.reload4j.Reload4jServiceProvider@4554617c]
SLF4J: See https://www.slf4j.org/codes.html#multiple_bindings
SLF4J: Actual provider is of type [ch.qos.logback.classic.spi.LogbackServiceProvider@1b6d3586]
```

「Actual provider」是**哪個先被 SPI 掃到就用哪個**——也就是 classpath 順序決定的。
結果：你精心設定的 `logback.xml` 在某些機器上完全沒作用，log 格式跑掉、log 檔沒產生。

**診斷**：

```bash
mvn dependency:tree -Dverbose | grep -i -E "slf4j|logback|log4j|reload4j|commons-logging"
```

```
[INFO] +- org.slf4j:slf4j-api:jar:2.0.16:compile
[INFO] +- ch.qos.logback:logback-classic:jar:1.5.8:runtime
[INFO] |  \- ch.qos.logback:logback-core:jar:1.5.8:runtime
[INFO] +- com.example:legacy-sdk:jar:3.2.0:compile
[INFO] |  +- org.slf4j:slf4j-reload4j:jar:1.7.36:compile      ← 兇手 1（第二個 provider）
[INFO] |  \- commons-logging:commons-logging:jar:1.2:compile  ← 兇手 2（另一套門面）
[INFO] \- com.example:report-lib:jar:1.1.0:compile
[INFO]    \- log4j:log4j:jar:1.2.17:compile                   ← 兇手 3（且有 CVE）
```

**修法**：

```xml
<dependencies>
  <dependency>
    <groupId>com.example</groupId>
    <artifactId>legacy-sdk</artifactId>
    <version>3.2.0</version>
    <exclusions>
      <exclusion><groupId>org.slf4j</groupId><artifactId>slf4j-reload4j</artifactId></exclusion>
      <exclusion><groupId>commons-logging</groupId><artifactId>commons-logging</artifactId></exclusion>
    </exclusions>
  </dependency>

  <dependency>
    <groupId>com.example</groupId>
    <artifactId>report-lib</artifactId>
    <version>1.1.0</version>
    <exclusions>
      <exclusion><groupId>log4j</groupId><artifactId>log4j</artifactId></exclusion>
    </exclusions>
  </dependency>

  <!-- 橋接器：讓那些函式庫「以為」自己在用 commons-logging / log4j 1.x，
       實際上呼叫被轉發到 SLF4J。它們的 log 就會出現在你的 logback 設定裡 -->
  <dependency>
    <groupId>org.slf4j</groupId>
    <artifactId>jcl-over-slf4j</artifactId>
    <version>2.0.16</version>
    <scope>runtime</scope>
  </dependency>
  <dependency>
    <groupId>org.slf4j</groupId>
    <artifactId>log4j-over-slf4j</artifactId>
    <version>2.0.16</version>
    <scope>runtime</scope>
  </dependency>
</dependencies>
```

**然後鎖住，不讓它復發**（10.10 節的 enforcer）：

```xml
<bannedDependencies>
  <excludes>
    <exclude>commons-logging:commons-logging</exclude>
    <exclude>log4j:log4j</exclude>
    <exclude>org.slf4j:slf4j-log4j12</exclude>
    <exclude>org.slf4j:slf4j-reload4j</exclude>
    <exclude>org.apache.logging.log4j:log4j-slf4j-impl</exclude>
  </excludes>
</bannedDependencies>
```

> ⚠️ **千萬別同時放 `log4j-over-slf4j` 和 `slf4j-log4j12`**——
> 前者把 log4j 呼叫轉給 SLF4J，後者把 SLF4J 呼叫轉給 log4j。
> 兩個一起放 = 無限遞迴 = `StackOverflowError`（第 09 章 9.3 節）。
> 這是橋接器唯一的致命陷阱：**同一個方向只能有一座橋。**

---

## 10.9 `dependencyManagement` 與 BOM

### `dependencies` vs `dependencyManagement`

| | `<dependencies>` | `<dependencyManagement>` |
|---|---|---|
| 會加進 classpath 嗎 | ✅ 會 | ❌ 不會 |
| 作用 | 「我要用這個」 | 「如果用到這個，版本是⋯⋯」 |
| 子模組繼承 | 繼承後**直接生效**（也在 classpath 上） | 繼承後**只是規則**，子模組還要自己宣告才會用到 |
| 需要寫 version 嗎 | 有 management 時可省略 | 必寫 |

一個具體例子。父 pom：

```xml
<project>
  <groupId>com.example</groupId>
  <artifactId>todo-parent</artifactId>
  <version>1.0.0</version>
  <packaging>pom</packaging>

  <!-- 這裡的：所有子模組都會拿到，不需宣告 -->
  <dependencies>
    <dependency>
      <groupId>org.slf4j</groupId>
      <artifactId>slf4j-api</artifactId>
      <version>2.0.16</version>
    </dependency>
  </dependencies>

  <!-- 這裡的：子模組要用才拿，但不用寫版本 -->
  <dependencyManagement>
    <dependencies>
      <dependency>
        <groupId>com.fasterxml.jackson.core</groupId>
        <artifactId>jackson-databind</artifactId>
        <version>2.17.2</version>
      </dependency>
    </dependencies>
  </dependencyManagement>
</project>
```

子模組：

```xml
<project>
  <parent>
    <groupId>com.example</groupId>
    <artifactId>todo-parent</artifactId>
    <version>1.0.0</version>
  </parent>
  <artifactId>todo-core</artifactId>

  <dependencies>
    <!-- slf4j-api 不用寫，父的 <dependencies> 已經給了 -->

    <!-- jackson 要寫，但不用版本 -->
    <dependency>
      <groupId>com.fasterxml.jackson.core</groupId>
      <artifactId>jackson-databind</artifactId>
    </dependency>
  </dependencies>
</project>
```

**實務建議：父 pom 的 `<dependencies>` 只放「真的每個模組都要」的東西**
（通常只有 `slf4j-api` 和測試框架）。其他一律放 `<dependencyManagement>`。

理由很簡單：放進 `<dependencies>` 的東西，**子模組沒辦法拒絕**。
你的 `todo-model` 模組（純資料類別）不需要 HTTP 客戶端，
但如果父 pom 塞了進去，它就有了——然後 `dependency:analyze` 一片紅色，
uber-jar 多 5 MB，攻擊面多一個 CVE 來源。

### BOM：一次管一整個生態系

BOM = Bill of Materials（物料清單）。它就是一個 `packaging` 為 `pom` 的專案，
裡面**只有** `dependencyManagement`。

Jackson 有 20 幾個模組（`databind`、`core`、`annotations`、`datatype-jsr310`、
`module-kotlin`、`dataformat-yaml`⋯⋯），它們的版本**必須一致**，
混版會出現 `NoSuchMethodError`、`AbstractMethodError`。

手動維護 20 個 `<version>` 是災難。用 BOM：

```xml
<dependencyManagement>
  <dependencies>
    <dependency>
      <groupId>com.fasterxml.jackson</groupId>
      <artifactId>jackson-bom</artifactId>
      <version>2.17.2</version>
      <type>pom</type>          <!-- 必須 -->
      <scope>import</scope>     <!-- 必須 -->
    </dependency>
  </dependencies>
</dependencyManagement>

<dependencies>
  <!-- 以下全部不用寫版本，而且保證版本一致 -->
  <dependency>
    <groupId>com.fasterxml.jackson.core</groupId>
    <artifactId>jackson-databind</artifactId>
  </dependency>
  <dependency>
    <groupId>com.fasterxml.jackson.datatype</groupId>
    <artifactId>jackson-datatype-jsr310</artifactId>
  </dependency>
  <dependency>
    <groupId>com.fasterxml.jackson.dataformat</groupId>
    <artifactId>jackson-dataformat-yaml</artifactId>
  </dependency>
</dependencies>
```

升級 Jackson？改一個字：`2.17.2` → `2.18.0`。20 個模組一起走，保證一致。

**`import` scope 的三個限制**（很容易踩）：

1. 只能出現在 `<dependencyManagement>` 裡。
2. 必須配 `<type>pom</type>`。
3. 它做的是**當場展開合併**，不是繼承。所以：
   ```
   你 import 了 A-BOM
     A-BOM 裡面 import 了 B-BOM     ← 這層也會展開，OK
   但你的「使用者」import 你的 BOM 時⋯⋯
     → 你 <dependencies> 裡的東西不會傳過去，只有 dependencyManagement 會
   ```

**常見的 BOM**（值得記住）：

| BOM | 座標 | 管什麼 |
|---|---|---|
| Spring Boot | `org.springframework.boot:spring-boot-dependencies` | 幾百個套件，第 02 站的主角 |
| Spring Cloud | `org.springframework.cloud:spring-cloud-dependencies` | 微服務全家桶 |
| Jackson | `com.fasterxml.jackson:jackson-bom` | 所有 jackson-* |
| JUnit 5 | `org.junit:junit-bom` | jupiter-api / engine / params / platform |
| Testcontainers | `org.testcontainers:testcontainers-bom` | 各種容器模組 |
| Netty | `io.netty:netty-bom` | 所有 netty-* |
| AWS SDK v2 | `software.amazon.awssdk:bom` | 所有 AWS 服務 |

### 兩種用 Spring Boot BOM 的方式

**方式一：繼承 parent（Spring Boot 官方預設）**

```xml
<parent>
  <groupId>org.springframework.boot</groupId>
  <artifactId>spring-boot-starter-parent</artifactId>
  <version>3.3.4</version>
  <relativePath/>   <!-- 空的 relativePath：告訴 Maven 別在上層目錄找，直接去倉庫抓 -->
</parent>
```

拿到的**不只是版本管理**，還包括：外掛版本、`<resource.delimiter>@</resource.delimiter>`、
`maven.compiler.release`、surefire / failsafe / jar / repackage 的預設設定。開箱即用。

**代價**：你只能有一個 parent。如果公司有自己的父 pom（統一 code style、
Nexus 設定、企業規範），就衝突了。

**方式二：`import` BOM（有自己父 pom 時）**

```xml
<parent>
  <groupId>com.mycompany</groupId>
  <artifactId>company-parent</artifactId>
  <version>5.2.0</version>
</parent>

<dependencyManagement>
  <dependencies>
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-dependencies</artifactId>
      <version>3.3.4</version>
      <type>pom</type>
      <scope>import</scope>
    </dependency>
  </dependencies>
</dependencyManagement>
```

注意 artifactId 是 `spring-boot-dependencies`（純 BOM），
不是 `spring-boot-starter-parent`（父 pom）。

**代價**：外掛設定不會來。你要自己設 `spring-boot-maven-plugin`、
自己設 `resource.delimiter`、自己設 compiler release。

> **怎麼選**：純 Spring Boot 專案、沒有公司父 pom → 用 parent，省事。
> 有公司父 pom，或這是多模組專案的其中一個模組 → 用 import BOM。

### 排查「版本怎麼變成這樣」

當你搞不清楚最終版本從哪來：

```bash
# 1. 看合併所有 parent / BOM / profile 之後的完整 pom
mvn help:effective-pom

# 2. 只看某個模組的（多模組專案）
mvn help:effective-pom -pl todo-core

# 3. 存成檔案再慢慢看（通常有一兩千行）
mvn help:effective-pom -Doutput=target/effective-pom.xml

# 4. 看最終解析出的依賴清單（這才是真正的 classpath）
mvn dependency:list -DoutputFile=target/deps.txt

# 5. 看 property 最終是什麼值
mvn help:evaluate -Dexpression=jackson.version -q -DforceStdout
```

`help:effective-pom` 是 Maven 除錯的第一工具，重要程度等同第 09 章的 `jcmd`。
**九成的「為什麼版本不對」都能在它的輸出裡找到答案。**

---

## 10.10 你一定會用到的外掛

Maven 本身幾乎什麼都不做，功能都在外掛裡。這一節是「六個必備 + 幾個好用」。

### 通則：永遠鎖外掛版本

```
[WARNING] Some problems were encountered while building the effective model
[WARNING] 'build.plugins.plugin.version' for org.apache.maven.plugins:maven-jar-plugin
          is missing.
```

不鎖版本，Maven 會用**它自己內建的預設版本**。換一台機器、換一個 Maven 版本，
外掛版本就變了，行為可能跟著變。**這是「在我機器上好好的」的經典來源。**

用 `<pluginManagement>` 鎖住，或直接在 `<plugin>` 裡寫 `<version>`。
檢查有沒有漏：

```bash
mvn versions:display-plugin-updates
```

---

### ① maven-compiler-plugin

```xml
<plugin>
  <groupId>org.apache.maven.plugins</groupId>
  <artifactId>maven-compiler-plugin</artifactId>
  <version>3.13.0</version>
  <configuration>
    <!-- release 已經由 ${maven.compiler.release} 屬性設定，這裡不用重複 -->
    <compilerArgs>
      <arg>-parameters</arg>          <!-- 保留參數名，給反射 / Jackson 用 -->
      <arg>-Xlint:all</arg>           <!-- 開啟所有警告 -->
      <arg>-Xlint:-processing</arg>   <!-- 但關掉「沒有註解處理器」這個噪音 -->
    </compilerArgs>
    <showDeprecation>true</showDeprecation>
    <showWarnings>true</showWarnings>
    <!-- 新專案值得開：警告視為錯誤。舊專案開了會有幾百個錯 -->
    <!-- <failOnWarning>true</failOnWarning> -->

    <!-- 註解處理器要明確列出。JDK 23 起 javac 不再隱式從 classpath 掃描 -->
    <annotationProcessorPaths>
      <path>
        <groupId>org.projectlombok</groupId>
        <artifactId>lombok</artifactId>
        <version>1.18.34</version>
      </path>
      <path>
        <groupId>org.mapstruct</groupId>
        <artifactId>mapstruct-processor</artifactId>
        <version>1.6.2</version>
      </path>
    </annotationProcessorPaths>
  </configuration>
</plugin>
```

**`-parameters` 為什麼重要**：沒有它，編譯後的方法參數名會變成 `arg0`、`arg1`。
影響：

```java
// 第 07 章的 Todo 建構子
@JsonCreator
public Todo(@JsonProperty("id") long id, @JsonProperty("title") String title) { ... }
```

有 `-parameters` 的話，`@JsonProperty` 可以省略（Jackson 配 `ParameterNamesModule` 能讀到真名）。
Spring 的 `@PathVariable String id` 也是——沒有 `-parameters` 時，
Spring 6 會直接丟出「Name for argument of type [java.lang.String] not specified」。
**Spring Boot 的 parent pom 預設就開了這個 flag**，所以你平常沒感覺；
自己從零建 pom 時就會撞到。

**`annotationProcessorPaths` 為什麼要明確寫**：

`javac` 過去會自動掃描 classpath 上的 jar，找 `META-INF/services/javax.annotation.processing.Processor`
來執行註解處理。這個「隱式啟用」正在被淘汰：

- **JDK 21**：隱式啟用時會發出警告
  （`Annotation processing is enabled because one or more processors were found on the class path`）。
- **JDK 23 起**：**預設不再隱式啟用**。要跑註解處理，必須明確給
  `-processor` / `--processor-path`，或加上 `-proc:full`。

也就是說，如果你只是把 Lombok 放在 `<dependencies>` 裡就期待它生效，
在新 JDK 上會**安靜地什麼都不做**——然後所有 `@Getter` 產生的方法都不存在，
噴出幾百個 `cannot find symbol`。

用 `<annotationProcessorPaths>` 明確宣告，`maven-compiler-plugin` 會轉成
`--processor-path`，不受這個變更影響。額外好處：把處理器和一般依賴分開，
`mvn dependency:analyze` 才不會把它們誤報成 unused。

---

### ② maven-surefire-plugin（單元測試）

```xml
<plugin>
  <groupId>org.apache.maven.plugins</groupId>
  <artifactId>maven-surefire-plugin</artifactId>
  <version>3.5.0</version>
  <configuration>
    <!-- 預設就會抓這些，寫出來是為了讓人一眼看懂命名約定 -->
    <includes>
      <include>**/Test*.java</include>
      <include>**/*Test.java</include>
      <include>**/*Tests.java</include>
      <include>**/*TestCase.java</include>
    </includes>

    <!-- 併發跑測試。第 11 章會講什麼測試不能併發 -->
    <parallel>classes</parallel>
    <threadCount>4</threadCount>

    <!-- 每次執行的 JVM 參數。用固定時區與語系，避免「在 CI 上失敗」 -->
    <argLine>
      -Xmx1g
      -Duser.timezone=Asia/Taipei
      -Duser.language=zh -Duser.country=TW
      -Dfile.encoding=UTF-8
    </argLine>

    <!-- 沒有測試時不要讓建置失敗（新模組剛建立時） -->
    <failIfNoTests>false</failIfNoTests>
  </configuration>
</plugin>
```

> ⚠️ **`argLine` 和 JaCoCo 的經典衝突**：JaCoCo 會把它的 agent 參數放進
> `${argLine}` 這個 property。如果你直接覆寫 `<argLine>`，覆蓋率報告就變成 0%。
> 正確寫法是**保留** `@{argLine}`：
>
> ```xml
> <argLine>@{argLine} -Xmx1g -Duser.timezone=Asia/Taipei</argLine>
> ```
>
> 注意是 `@{...}` 不是 `${...}`——`@{}` 是 surefire 的「延遲求值」語法，
> 這樣才能拿到 JaCoCo 在建置中期才設好的值。
> 「覆蓋率突然變 0%」十次有八次是這個。

**設固定時區的理由**（第 07 章 7.11 節的延伸）：
你的測試在 `Asia/Taipei` 通過，CI 容器是 `UTC`。一個「計算今天的待辦事項」
的測試，在台灣時間早上 8 點跑（UTC 前一天 0 點）就會失敗。
**要嘛注入 `Clock`（第 07 章 7.15 節，正解），要嘛至少把時區釘死。**

---

### ③ maven-failsafe-plugin（整合測試）

為什麼需要兩個測試外掛？因為**單元測試和整合測試該在不同時機跑、失敗處理方式不同**。

| | surefire | failsafe |
|---|---|---|
| 綁定 phase | `test` | `integration-test` + `verify` |
| 檔名約定 | `*Test`、`Test*`、`*Tests`、`*TestCase` | `IT*`、`*IT`、`*ITCase` |
| 測試失敗時 | **立刻讓建置失敗** | 記錄下來，**繼續執行** `post-integration-test` |
| 為什麼這樣設計 | 單元測試該秒級失敗 | 整合測試開了 Docker / DB，**失敗也一定要清理** |

```xml
<plugin>
  <groupId>org.apache.maven.plugins</groupId>
  <artifactId>maven-failsafe-plugin</artifactId>
  <version>3.5.0</version>
  <executions>
    <execution>
      <goals>
        <goal>integration-test</goal>   <!-- 跑測試，記錄結果 -->
        <goal>verify</goal>             <!-- 檢查結果，失敗才讓建置紅 -->
      </goals>
    </execution>
  </executions>
</plugin>
```

**這兩個 goal 一定要一起綁。** 只綁 `integration-test` 的話，
測試失敗也不會讓建置失敗——你會有一個「永遠綠燈」的 CI。這比沒有測試更糟。

執行順序：

```
package                  ← jar 打好了
pre-integration-test     ← 啟動 DB / Docker / 測試伺服器
integration-test         ← failsafe:integration-test（測失敗也繼續）
post-integration-test    ← 關掉 DB / Docker（保證會執行！）
verify                   ← failsafe:verify（這裡才讓建置失敗）
```

所以 `mvn test` **不會**跑整合測試，`mvn verify` 才會。
本機開發用 `mvn test`（快），CI 用 `mvn verify`（完整）。

---

### ④ maven-shade-plugin（可執行 uber-jar）

10.13 節會完整比較，這裡先給設定：

```xml
<plugin>
  <groupId>org.apache.maven.plugins</groupId>
  <artifactId>maven-shade-plugin</artifactId>
  <version>3.6.0</version>
  <executions>
    <execution>
      <id>make-executable-jar</id>
      <phase>package</phase>
      <goals><goal>shade</goal></goals>
      <configuration>
        <!-- 不要產生 dependency-reduced-pom.xml 這種奇怪的東西 -->
        <createDependencyReducedPom>false</createDependencyReducedPom>

        <transformers>
          <!-- 寫入 Main-Class -->
          <transformer implementation="org.apache.maven.plugins.shade.resource.ManifestResourceTransformer">
            <mainClass>${main.class}</mainClass>
          </transformer>
          <!-- 合併 META-INF/services/*：SPI 的命脈，忘了它 SLF4J / JDBC 就掛 -->
          <transformer implementation="org.apache.maven.plugins.shade.resource.ServicesResourceTransformer"/>
        </transformers>

        <filters>
          <filter>
            <artifact>*:*</artifact>
            <excludes>
              <!-- 移除簽章檔。不移除的話 java -jar 會丟
                   "Invalid signature file digest for Manifest main attributes" -->
              <exclude>META-INF/*.SF</exclude>
              <exclude>META-INF/*.DSA</exclude>
              <exclude>META-INF/*.RSA</exclude>
              <!-- 模組描述檔在 uber-jar 裡沒意義，留著會讓 JPMS 混淆 -->
              <exclude>META-INF/versions/*/module-info.class</exclude>
              <exclude>module-info.class</exclude>
            </excludes>
          </filter>
        </filters>
      </configuration>
    </execution>
  </executions>
</plugin>
```

**`ServicesResourceTransformer` 是最容易漏、後果最嚴重的一項。**

原因：`META-INF/services/` 底下是 Java SPI 的註冊檔。
`slf4j-api` 有一個 `META-INF/services/org.slf4j.spi.SLF4JServiceProvider`，
`jackson-datatype-jsr310` 有 `META-INF/services/com.fasterxml.jackson.databind.Module`⋯⋯
**每個 jar 都有同名檔案**。打成一包時，如果不合併，只會保留其中一個（隨機），
其他全部消失。

症狀：

```
SLF4J(W): No SLF4J providers were found.
SLF4J(W): Defaulting to no-operation (NOP) logger implementation
```

或

```
java.sql.SQLException: No suitable driver found for jdbc:postgresql://...
```

**你的 log 全部消失、或 JDBC 驅動找不到——而且只在打包後發生，IDE 裡完全正常。**
加上 `ServicesResourceTransformer` 就解決了。

---

### ⑤ maven-enforcer-plugin（把約定變成建置失敗）

**這是最被低估的外掛。** 它把「團隊規範」從 wiki 上的一段文字，
變成 CI 上的一個紅燈。

```xml
<plugin>
  <groupId>org.apache.maven.plugins</groupId>
  <artifactId>maven-enforcer-plugin</artifactId>
  <version>3.5.0</version>
  <executions>
    <execution>
      <id>enforce-rules</id>
      <phase>validate</phase>       <!-- 越早越好，失敗要快 -->
      <goals><goal>enforce</goal></goals>
      <configuration>
        <rules>
          <!-- 1. Maven 版本。太舊的 Maven 有些語法不支援 -->
          <requireMavenVersion>
            <version>[3.9.0,)</version>
          </requireMavenVersion>

          <!-- 2. JDK 版本。防止有人用 JDK 17 建 Java 21 的專案 -->
          <requireJavaVersion>
            <version>[21,)</version>
          </requireJavaVersion>

          <!-- 3. 依賴收斂：同一個套件的所有傳遞版本必須一致 -->
          <dependencyConvergence/>

          <!-- 4. 禁用套件 -->
          <bannedDependencies>
            <excludes>
              <exclude>commons-logging:commons-logging</exclude>
              <exclude>log4j:log4j</exclude>
              <exclude>org.slf4j:slf4j-log4j12</exclude>
              <!-- 有 CVE 的 Log4j 2.x 版本區間 -->
              <exclude>org.apache.logging.log4j:log4j-core:[2.0,2.17.1)</exclude>
            </excludes>
            <searchTransitive>true</searchTransitive>
          </bannedDependencies>

          <!-- 5. 禁止 SNAPSHOT（發佈時開，開發時關） -->
          <!-- <requireReleaseDeps>
                 <message>正式版不可依賴 SNAPSHOT</message>
               </requireReleaseDeps> -->

          <!-- 6. 同一個 pom 裡不可重複宣告同一個依賴 -->
          <banDuplicatePomDependencyVersions/>
        </rules>
        <fail>true</fail>
      </configuration>
    </execution>
  </executions>
</plugin>
```

**`dependencyConvergence` 的輸出長這樣：**

```
[WARNING] Rule 3: org.apache.maven.enforcer.rules.dependency.DependencyConvergence failed with message:
Failed while enforcing releasability.

Dependency convergence error for com.google.guava:guava:31.1-jre paths to dependency are:
+-com.example:todo-cli:1.0.0-SNAPSHOT
  +-com.example:service-a:1.0.0
    +-com.google.guava:guava:31.1-jre
and
+-com.example:todo-cli:1.0.0-SNAPSHOT
  +-com.example:service-b:2.0.0
    +-com.google.guava:guava:33.3.0-jre
```

它把 10.8 節那個「安靜地選了一個版本」變成「**建置失敗，並告訴你兩條路徑**」。

> ⚠️ **在既有專案上第一次開 `dependencyConvergence`，會噴出幾十個錯誤。**
> 不要因此放棄。做法：
> ① 先設 `<fail>false</fail>`，看清全貌；
> ② 一個一個用 `dependencyManagement` 收斂；
> ③ 全部乾淨後改成 `<fail>true</fail>` 鎖住。
> 這通常是半天的工作，換來的是「再也不會有人不小心引入版本衝突」。

**額外規則**（需要 `extra-enforcer-rules` 這個第三方依賴）：

```xml
<plugin>
  <groupId>org.apache.maven.plugins</groupId>
  <artifactId>maven-enforcer-plugin</artifactId>
  <version>3.5.0</version>
  <dependencies>
    <dependency>
      <groupId>org.codehaus.mojo</groupId>
      <artifactId>extra-enforcer-rules</artifactId>
      <version>1.9.0</version>
    </dependency>
  </dependencies>
  <!-- 然後就能用 <banDuplicateClasses/>、<requireEncoding/> 等規則 -->
</plugin>
```

`banDuplicateClasses` 抓的是**不同座標卻有同名 class** 的情況——
例如 `javax.annotation:javax.annotation-api` 和 `jakarta.annotation:jakarta.annotation-api`，
座標不同，`dependencyConvergence` 抓不到，但 classpath 上就是有兩份 `javax/annotation/Nonnull.class`。

---

### ⑥ versions-maven-plugin（升級依賴）

```bash
# 看有哪些依賴有新版
mvn versions:display-dependency-updates

# 看有哪些外掛有新版
mvn versions:display-plugin-updates

# 看 properties 定義的版本有新版（配合我們把版本放 properties 的做法）
mvn versions:display-property-updates

# 改專案自己的版本（多模組會一起改，含 parent 引用）
mvn versions:set -DnewVersion=1.1.0

# 反悔（會還原 pom.xml.versionsBackup）
mvn versions:revert

# 確認（刪掉備份檔）
mvn versions:commit
```

輸出範例：

```
[INFO] The following dependencies in Dependencies have newer versions:
[INFO]   ch.qos.logback:logback-classic ................... 1.5.8 -> 1.5.11
[INFO]   com.fasterxml.jackson.core:jackson-databind ...... 2.17.2 -> 2.18.1
[INFO]   org.assertj:assertj-core ......................... 3.26.3 -> 3.26.3
```

> **實務做法**：不要手動跑這個然後手動改。用 **Dependabot**（GitHub）或
> **Renovate**，讓它自動開 PR，CI 跑完測試你再 merge。
> `versions` 外掛的價值在於**臨時檢查**和**發版時改版號**。

---

### 其他值得知道的外掛

| 外掛 | 做什麼 | 什麼時候用 |
|---|---|---|
| `jacoco-maven-plugin` | 測試覆蓋率 + 覆蓋率門檻 | 第 11 章 |
| `spotless-maven-plugin` | 自動格式化（Google Java Format、Palantir） | 團隊統一 code style，`mvn spotless:apply` |
| `maven-checkstyle-plugin` | 靜態檢查風格 | 有嚴格規範時。和 spotless 選一個就好 |
| `spotbugs-maven-plugin` | 找 bug pattern（NPE、資源洩漏） | 值得加，會抓到第 04、07 章講的那些坑 |
| `exec-maven-plugin` | `mvn exec:java` 直接跑 main | 本機快速驗證，不用先打包 |
| `maven-dependency-plugin` | `tree` / `analyze` / `copy-dependencies` / `build-classpath` | 天天用 |
| `flatten-maven-plugin` | 把 `${revision}` 展平成真實版本 | CI-friendly 版本（10.16 節） |
| `cyclonedx-maven-plugin` | 產生 SBOM | 10.17 節 |
| `dependency-check-maven` | 掃 CVE | 10.17 節 |
| `git-commit-id-maven-plugin` | 把 git commit 資訊注入建置 | 想知道「線上跑的是哪個 commit」 |
| `templating-maven-plugin` | 產生帶版本資訊的 Java 類別 | 比 10.6 節的 properties 做法更型別安全 |

`exec-maven-plugin` 的設定值得貼出來，因為開發時很好用：

```xml
<plugin>
  <groupId>org.codehaus.mojo</groupId>
  <artifactId>exec-maven-plugin</artifactId>
  <version>3.5.0</version>
  <configuration>
    <mainClass>${main.class}</mainClass>
  </configuration>
</plugin>
```

```bash
mvn compile exec:java -Dexec.args="add 買牛奶 --priority HIGH"
```

> ⚠️ 記得前面要加 `compile`。`exec:java` 讀的是 `target/classes`，
> 不會自己觸發編譯——所以你可能在跑一小時前的程式碼而不自知。

---
## 10.11 profile 與環境差異

profile 讓同一份 pom 在不同情境下有不同行為。

### 一個具體需求

我們的 Todo CLI 要有兩種建置模式：

- **開發**：跳過整合測試、不打 uber-jar（快，30 秒內）
- **發佈**：跑全部測試、打 uber-jar、產生 SBOM、檢查漏洞（慢，5 分鐘）

```xml
<profiles>

  <!-- ───────────── 開發用（預設啟用） ───────────── -->
  <profile>
    <id>dev</id>
    <activation>
      <activeByDefault>true</activeByDefault>
    </activation>
    <properties>
      <skip.integration.tests>true</skip.integration.tests>
      <log.level>DEBUG</log.level>
    </properties>
  </profile>

  <!-- ───────────── 發佈用（mvn -Prelease） ───────────── -->
  <profile>
    <id>release</id>
    <properties>
      <skip.integration.tests>false</skip.integration.tests>
      <log.level>INFO</log.level>
    </properties>
    <build>
      <plugins>
        <!-- 只有 release 才打 uber-jar -->
        <plugin>
          <groupId>org.apache.maven.plugins</groupId>
          <artifactId>maven-shade-plugin</artifactId>
          <executions>
            <execution>
              <id>make-executable-jar</id>
              <phase>package</phase>
              <goals><goal>shade</goal></goals>
            </execution>
          </executions>
        </plugin>
        <!-- 產生 sources jar 與 javadoc jar（發佈到倉庫時是必需的） -->
        <plugin>
          <groupId>org.apache.maven.plugins</groupId>
          <artifactId>maven-source-plugin</artifactId>
          <version>3.3.1</version>
          <executions>
            <execution>
              <id>attach-sources</id>
              <goals><goal>jar-no-fork</goal></goals>
            </execution>
          </executions>
        </plugin>
        <!-- 產生 SBOM（10.17 節） -->
        <plugin>
          <groupId>org.cyclonedx</groupId>
          <artifactId>cyclonedx-maven-plugin</artifactId>
          <version>2.9.0</version>
          <executions>
            <execution>
              <phase>package</phase>
              <goals><goal>makeAggregateBom</goal></goals>
            </execution>
          </executions>
        </plugin>
      </plugins>
    </build>
  </profile>

</profiles>
```

然後 failsafe 讀那個 property：

```xml
<plugin>
  <groupId>org.apache.maven.plugins</groupId>
  <artifactId>maven-failsafe-plugin</artifactId>
  <version>3.5.0</version>
  <configuration>
    <skipITs>${skip.integration.tests}</skipITs>
  </configuration>
  <executions>
    <execution>
      <goals>
        <goal>integration-test</goal>
        <goal>verify</goal>
      </goals>
    </execution>
  </executions>
</plugin>
```

用法：

```bash
mvn clean package              # dev：快
mvn clean verify -Prelease     # release：完整
```

### 五種啟用方式

```xml
<profile>
  <id>example</id>
  <activation>

    <!-- 1. 預設啟用（有陷阱，見下） -->
    <activeByDefault>true</activeByDefault>

    <!-- 2. 靠 property。這是最推薦的方式 -->
    <property>
      <name>env</name>
      <value>prod</value>     <!-- mvn package -Denv=prod -->
    </property>

    <!-- property 只要「存在」就啟用（不管值） -->
    <!-- <property><name>skipDocker</name></property> -->

    <!-- property「不存在」才啟用 -->
    <!-- <property><name>!skipDocker</name></property> -->

    <!-- 3. 靠 JDK 版本 -->
    <jdk>[21,)</jdk>

    <!-- 4. 靠作業系統 -->
    <os>
      <family>windows</family>
      <arch>amd64</arch>
    </os>

    <!-- 5. 靠檔案是否存在 -->
    <file>
      <exists>${project.basedir}/src/main/docker/Dockerfile</exists>
      <!-- <missing>...</missing> -->
    </file>

  </activation>
</profile>
```

查看目前哪些 profile 是啟用的：

```bash
mvn help:active-profiles
mvn help:all-profiles
```

### `activeByDefault` 的陷阱

**規則**：如果**同一個 pom 裡**有任何 profile 被「以 ID 明確啟用」（`-P`），
那麼所有 `activeByDefault` 的 profile 都會被**停用**。

```bash
mvn package                  # dev 啟用 ✅
mvn package -Prelease        # dev 被停用，只有 release ✅（這是我們想要的）
mvn package -Pdocker         # dev 被停用！❌ 但你可能沒預期到
```

第三個指令會讓你的 `skip.integration.tests` 變成未定義，
`<skipITs>${skip.integration.tests}</skipITs>` 拿到字串 `"${skip.integration.tests}"`，
Maven 把它當 `false`——**整合測試突然開始跑了，而你只是想建 Docker 映像**。

**建議做法：不要用 `activeByDefault`。** 改成在 `<properties>` 給預設值：

```xml
<properties>
  <!-- 預設值寫在這，永遠有效 -->
  <skip.integration.tests>true</skip.integration.tests>
</properties>

<profiles>
  <profile>
    <id>release</id>
    <properties>
      <!-- 只在 release 覆寫 -->
      <skip.integration.tests>false</skip.integration.tests>
    </properties>
    <!-- ... -->
  </profile>
</profiles>
```

這樣不管啟用什麼 profile，屬性都有值。**profile 只負責覆寫，不負責提供預設。**

### profile 不該用來做的事

**❌ 不要用 profile 切換依賴的存在與否。**

```xml
<!-- 反面教材 -->
<profile>
  <id>prod</id>
  <dependencies>
    <dependency>
      <groupId>com.oracle.database.jdbc</groupId>
      <artifactId>ojdbc11</artifactId>
      <version>23.5.0.24.07</version>
    </dependency>
  </dependencies>
</profile>
<profile>
  <id>dev</id>
  <dependencies>
    <dependency>
      <groupId>com.h2database</groupId>
      <artifactId>h2</artifactId>
      <version>2.3.232</version>
    </dependency>
  </dependencies>
</profile>
```

問題：**你的 CI 測的東西和上線的東西不一樣。**
測試在 H2 上全綠，Oracle 上的 `MERGE` 語法不支援——這種 bug 會在部署後才發現。

正解：兩個驅動都放進去（H2 用 `test` scope），靠**設定檔**而不是**依賴**切換資料庫；
或用 Testcontainers 直接在測試裡跑真的 Oracle（第 11 章）。

**❌ 不要用 profile 切換 `main` 程式碼的內容。**
如果 dev 和 prod 編譯出來的 class 不一樣，那你測的就不是要上線的東西。
所有環境差異都應該是**執行期的設定**（環境變數、設定檔），不是**建置期的分歧**。

> **一句話原則**：**「Build once, deploy many.」**
> 建一次，同一個 artifact 部署到 dev / staging / prod，靠設定區分。
> profile 應該只用來調整「建置流程」（要不要跑某類測試、要不要產生額外產出），
> 而不是「產出內容」。這是十二要素應用（12-Factor App）的第 5 條，
> 第 02 站的 Spring Boot `application-{profile}.yml` 就是這個原則的執行期版本。

---

## 10.12 多模組專案

### 為什麼要拆

我們的 Todo 專案現在是一個模組。什麼時候該拆？

| 訊號 | 說明 |
|---|---|
| 有多個交付物 | CLI 和未來的 Web 服務要共用 model 與 service |
| 想強制分層 | 讓 `todo-model` 在編譯期就**不可能**依賴 `todo-cli` |
| 建置太慢 | 改一行 CLI 的程式碼不該重編全部（配 `-pl`） |
| 對外發佈的粒度不同 | `todo-core` 給別人當函式庫，`todo-cli` 不發佈 |

**最重要的是第二點。** 單模組專案裡，`model` 套件可以 import `cli` 套件的類別——
沒有任何機制阻止你。拆成模組後，`todo-model` 的 pom 裡沒有 `todo-cli` 依賴，
**編譯器會替你守住架構邊界**。這是「架構規範」變成「建置失敗」的另一個例子。

### 目錄結構

```
todo/                              ← 根目錄（aggregator + parent）
├── pom.xml                        ← packaging: pom
├── mvnw / mvnw.cmd / .mvn/
├── todo-model/
│   ├── pom.xml
│   └── src/main/java/com/example/todo/model/
│       ├── Priority.java
│       └── Todo.java
├── todo-core/                     ← repository + service + exception + support
│   ├── pom.xml
│   └── src/
│       ├── main/java/com/example/todo/{exception,repository,service,support}/
│       └── test/java/...
├── todo-importer/                 ← 第 08 章的併發匯入
│   ├── pom.xml
│   └── src/main/java/com/example/todo/importer/
└── todo-cli/                      ← 可執行的那個
    ├── pom.xml
    └── src/main/java/com/example/todo/App.java
```

依賴方向（**只能單向，不能有環**）：

```
todo-cli  ──→ todo-importer ──→ todo-core ──→ todo-model
    └──────────────────────────────┴──────────────┘
```

### 根 pom（aggregator + parent 二合一）

```xml
<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0
                             https://maven.apache.org/xsd/maven-4.0.0.xsd">
  <modelVersion>4.0.0</modelVersion>

  <groupId>com.example</groupId>
  <artifactId>todo</artifactId>
  <version>1.0.0-SNAPSHOT</version>
  <packaging>pom</packaging>          <!-- 關鍵：pom，不是 jar -->
  <name>Todo</name>

  <!-- aggregator 的部分：列出子模組（順序不重要，見下方 reactor 說明） -->
  <modules>
    <module>todo-model</module>
    <module>todo-core</module>
    <module>todo-importer</module>
    <module>todo-cli</module>
  </modules>

  <properties>
    <maven.compiler.release>21</maven.compiler.release>
    <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
    <project.reporting.outputEncoding>UTF-8</project.reporting.outputEncoding>
    <project.build.outputTimestamp>2026-08-17T00:00:00Z</project.build.outputTimestamp>

    <jackson.version>2.17.2</jackson.version>
    <junit.version>5.11.0</junit.version>
    <slf4j.version>2.0.16</slf4j.version>
    <logback.version>1.5.8</logback.version>
    <assertj.version>3.26.3</assertj.version>
    <mockito.version>5.13.0</mockito.version>
  </properties>

  <!-- parent 的部分：版本管理 -->
  <dependencyManagement>
    <dependencies>
      <!-- 自家模組也要管版本，子模組互相依賴時就不用寫 version -->
      <dependency>
        <groupId>com.example</groupId>
        <artifactId>todo-model</artifactId>
        <version>${project.version}</version>
      </dependency>
      <dependency>
        <groupId>com.example</groupId>
        <artifactId>todo-core</artifactId>
        <version>${project.version}</version>
      </dependency>
      <dependency>
        <groupId>com.example</groupId>
        <artifactId>todo-importer</artifactId>
        <version>${project.version}</version>
      </dependency>

      <!-- 第三方 BOM -->
      <dependency>
        <groupId>com.fasterxml.jackson</groupId>
        <artifactId>jackson-bom</artifactId>
        <version>${jackson.version}</version>
        <type>pom</type>
        <scope>import</scope>
      </dependency>
      <dependency>
        <groupId>org.junit</groupId>
        <artifactId>junit-bom</artifactId>
        <version>${junit.version}</version>
        <type>pom</type>
        <scope>import</scope>
      </dependency>

      <dependency>
        <groupId>org.slf4j</groupId>
        <artifactId>slf4j-api</artifactId>
        <version>${slf4j.version}</version>
      </dependency>
      <dependency>
        <groupId>ch.qos.logback</groupId>
        <artifactId>logback-classic</artifactId>
        <version>${logback.version}</version>
      </dependency>
      <dependency>
        <groupId>org.assertj</groupId>
        <artifactId>assertj-core</artifactId>
        <version>${assertj.version}</version>
      </dependency>
      <dependency>
        <groupId>org.mockito</groupId>
        <artifactId>mockito-core</artifactId>
        <version>${mockito.version}</version>
      </dependency>
    </dependencies>
  </dependencyManagement>

  <!-- 每個模組都需要的：日誌門面 + 測試框架 -->
  <dependencies>
    <dependency>
      <groupId>org.slf4j</groupId>
      <artifactId>slf4j-api</artifactId>
    </dependency>
    <dependency>
      <groupId>org.junit.jupiter</groupId>
      <artifactId>junit-jupiter</artifactId>
      <scope>test</scope>
    </dependency>
    <dependency>
      <groupId>org.assertj</groupId>
      <artifactId>assertj-core</artifactId>
      <scope>test</scope>
    </dependency>
  </dependencies>

  <build>
    <pluginManagement>
      <plugins>
        <plugin>
          <groupId>org.apache.maven.plugins</groupId>
          <artifactId>maven-compiler-plugin</artifactId>
          <version>3.13.0</version>
          <configuration>
            <compilerArgs>
              <arg>-parameters</arg>
              <arg>-Xlint:all</arg>
              <arg>-Xlint:-processing</arg>
            </compilerArgs>
          </configuration>
        </plugin>
        <plugin>
          <groupId>org.apache.maven.plugins</groupId>
          <artifactId>maven-surefire-plugin</artifactId>
          <version>3.5.0</version>
          <configuration>
            <argLine>@{argLine} -Duser.timezone=Asia/Taipei -Dfile.encoding=UTF-8</argLine>
          </configuration>
        </plugin>
        <plugin>
          <groupId>org.apache.maven.plugins</groupId>
          <artifactId>maven-failsafe-plugin</artifactId>
          <version>3.5.0</version>
        </plugin>
        <plugin>
          <groupId>org.apache.maven.plugins</groupId>
          <artifactId>maven-jar-plugin</artifactId>
          <version>3.4.2</version>
        </plugin>
        <plugin>
          <groupId>org.apache.maven.plugins</groupId>
          <artifactId>maven-shade-plugin</artifactId>
          <version>3.6.0</version>
        </plugin>
      </plugins>
    </pluginManagement>

    <plugins>
      <!-- enforcer 在根 pom 設一次，所有模組都受約束 -->
      <plugin>
        <groupId>org.apache.maven.plugins</groupId>
        <artifactId>maven-enforcer-plugin</artifactId>
        <version>3.5.0</version>
        <executions>
          <execution>
            <id>enforce-rules</id>
            <phase>validate</phase>
            <goals><goal>enforce</goal></goals>
            <configuration>
              <rules>
                <requireMavenVersion><version>[3.9.0,)</version></requireMavenVersion>
                <requireJavaVersion><version>[21,)</version></requireJavaVersion>
                <dependencyConvergence/>
                <banDuplicatePomDependencyVersions/>
                <bannedDependencies>
                  <excludes>
                    <exclude>commons-logging:commons-logging</exclude>
                    <exclude>log4j:log4j</exclude>
                    <exclude>org.slf4j:slf4j-log4j12</exclude>
                  </excludes>
                  <searchTransitive>true</searchTransitive>
                </bannedDependencies>
              </rules>
            </configuration>
          </execution>
        </executions>
      </plugin>
    </plugins>
  </build>
</project>
```

### 子模組 pom

**`todo-model/pom.xml`**——最底層，只依賴 Jackson 註解：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0
                             https://maven.apache.org/xsd/maven-4.0.0.xsd">
  <modelVersion>4.0.0</modelVersion>

  <parent>
    <groupId>com.example</groupId>
    <artifactId>todo</artifactId>
    <version>1.0.0-SNAPSHOT</version>
    <!-- relativePath 預設就是 ../pom.xml，寫出來讓人一眼看懂 -->
    <relativePath>../pom.xml</relativePath>
  </parent>

  <!-- groupId 與 version 繼承自 parent，不用寫 -->
  <artifactId>todo-model</artifactId>
  <name>Todo :: Model</name>

  <dependencies>
    <!-- 只要註解，不要整個 databind。model 模組要保持乾淨 -->
    <dependency>
      <groupId>com.fasterxml.jackson.core</groupId>
      <artifactId>jackson-annotations</artifactId>
    </dependency>
  </dependencies>
</project>
```

**`todo-core/pom.xml`**：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0
                             https://maven.apache.org/xsd/maven-4.0.0.xsd">
  <modelVersion>4.0.0</modelVersion>

  <parent>
    <groupId>com.example</groupId>
    <artifactId>todo</artifactId>
    <version>1.0.0-SNAPSHOT</version>
  </parent>

  <artifactId>todo-core</artifactId>
  <name>Todo :: Core</name>

  <dependencies>
    <!-- 版本來自根 pom 的 dependencyManagement -->
    <dependency>
      <groupId>com.example</groupId>
      <artifactId>todo-model</artifactId>
    </dependency>
    <dependency>
      <groupId>com.fasterxml.jackson.core</groupId>
      <artifactId>jackson-databind</artifactId>
    </dependency>
    <dependency>
      <groupId>com.fasterxml.jackson.datatype</groupId>
      <artifactId>jackson-datatype-jsr310</artifactId>
    </dependency>

    <dependency>
      <groupId>org.mockito</groupId>
      <artifactId>mockito-core</artifactId>
      <scope>test</scope>
    </dependency>
  </dependencies>
</project>
```

**`todo-cli/pom.xml`**——唯一會打成可執行 jar 的模組：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0
                             https://maven.apache.org/xsd/maven-4.0.0.xsd">
  <modelVersion>4.0.0</modelVersion>

  <parent>
    <groupId>com.example</groupId>
    <artifactId>todo</artifactId>
    <version>1.0.0-SNAPSHOT</version>
  </parent>

  <artifactId>todo-cli</artifactId>
  <name>Todo :: CLI</name>

  <properties>
    <main.class>com.example.todo.App</main.class>
  </properties>

  <dependencies>
    <dependency>
      <groupId>com.example</groupId>
      <artifactId>todo-importer</artifactId>
    </dependency>
    <!-- 只有最終的可執行模組才需要日誌實作 -->
    <dependency>
      <groupId>ch.qos.logback</groupId>
      <artifactId>logback-classic</artifactId>
      <scope>runtime</scope>
    </dependency>
  </dependencies>

  <build>
    <finalName>todo-cli</finalName>
    <plugins>
      <plugin>
        <groupId>org.apache.maven.plugins</groupId>
        <artifactId>maven-jar-plugin</artifactId>
        <configuration>
          <archive>
            <manifest><mainClass>${main.class}</mainClass></manifest>
          </archive>
        </configuration>
      </plugin>
      <plugin>
        <groupId>org.apache.maven.plugins</groupId>
        <artifactId>maven-shade-plugin</artifactId>
        <executions>
          <execution>
            <id>make-executable-jar</id>
            <phase>package</phase>
            <goals><goal>shade</goal></goals>
            <configuration>
              <createDependencyReducedPom>false</createDependencyReducedPom>
              <transformers>
                <transformer implementation="org.apache.maven.plugins.shade.resource.ManifestResourceTransformer">
                  <mainClass>${main.class}</mainClass>
                </transformer>
                <transformer implementation="org.apache.maven.plugins.shade.resource.ServicesResourceTransformer"/>
              </transformers>
              <filters>
                <filter>
                  <artifact>*:*</artifact>
                  <excludes>
                    <exclude>META-INF/*.SF</exclude>
                    <exclude>META-INF/*.DSA</exclude>
                    <exclude>META-INF/*.RSA</exclude>
                    <exclude>module-info.class</exclude>
                    <exclude>META-INF/versions/*/module-info.class</exclude>
                  </excludes>
                </filter>
              </filters>
            </configuration>
          </execution>
        </executions>
      </plugin>
    </plugins>
  </build>
</project>
```

> **`<relativePath/>` 的三種寫法**，很容易搞混：
>
> | 寫法 | 意思 |
> |---|---|
> | 不寫 | 預設值 `../pom.xml`，找上一層目錄 |
> | `<relativePath>../pom.xml</relativePath>` | 同上，只是寫明白 |
> | `<relativePath/>`（空的） | **不要找檔案系統，直接去倉庫抓**。用在 parent 不在本地的情況（如 `spring-boot-starter-parent`） |
>
> 用錯的症狀：`Non-resolvable parent POM ... and 'parent.relativePath' points at
> wrong local POM`。表示 Maven 在你指的位置找到了 pom，但座標不符。

### aggregator vs parent 是兩件事

這是新手最大的困惑。它們**經常寫在同一個檔案裡，但概念完全獨立**：

| | aggregator（聚合器） | parent（父）|
|---|---|---|
| 靠什麼建立關係 | 根 pom 的 `<modules>` | 子 pom 的 `<parent>` |
| 方向 | 上 → 下（我包含這些） | 下 → 上（我繼承那個） |
| 用途 | 一個指令建置全部 | 共用設定與版本管理 |
| 一定要一致嗎 | ❌ 不用 | ❌ 不用 |

大型專案常見的組合：一個全公司共用的 `company-parent`（發佈到 Nexus，
不含 `<modules>`），加上每個專案自己的 aggregator。

### reactor：建置順序

執行 `mvn clean install` 在根目錄：

```
[INFO] ------------------------------------------------------------------------
[INFO] Reactor Build Order:
[INFO]
[INFO] Todo                                               [pom]
[INFO] Todo :: Model                                      [jar]
[INFO] Todo :: Core                                       [jar]
[INFO] Todo :: Importer                                   [jar]
[INFO] Todo :: CLI                                        [jar]
...
[INFO] ------------------------------------------------------------------------
[INFO] Reactor Summary for Todo 1.0.0-SNAPSHOT:
[INFO]
[INFO] Todo ............................................... SUCCESS [  0.148 s]
[INFO] Todo :: Model ...................................... SUCCESS [  1.832 s]
[INFO] Todo :: Core ....................................... SUCCESS [  3.421 s]
[INFO] Todo :: Importer ................................... SUCCESS [  2.104 s]
[INFO] Todo :: CLI ........................................ SUCCESS [  4.577 s]
[INFO] ------------------------------------------------------------------------
[INFO] BUILD SUCCESS
```

**關鍵認知：順序不是由 `<modules>` 的排列決定的，而是由模組間的依賴關係算出來的（拓撲排序）。**

你可以把 `<modules>` 裡的 `todo-cli` 放第一個，reactor 還是會先建 `todo-model`。
所以 `<modules>` 依字母排序就好，別花時間「排出正確順序」。

**如果有環**（A 依賴 B，B 依賴 A）：

```
[ERROR] The projects in the reactor contain a cyclic reference:
        Edge between 'Vertex{label='com.example:todo-core:1.0.0-SNAPSHOT'}'
        and 'Vertex{label='com.example:todo-model:1.0.0-SNAPSHOT'}' introduces to cycle
```

Maven **直接拒絕建置**。這是好事——它強迫你的架構是分層的。

### 只建你需要的：`-pl` 與 `-am`

大專案有 30 個模組，你只改了 `todo-cli` 一行。全建要 5 分鐘。

```bash
# -pl (--projects)：只建指定模組
mvn -pl todo-cli package
```

```
[ERROR] Failed to execute goal on project todo-cli:
  Could not resolve dependencies for project com.example:todo-cli:jar:1.0.0-SNAPSHOT:
  The following artifacts could not be resolved:
  com.example:todo-importer:jar:1.0.0-SNAPSHOT (absent)
```

**為什麼失敗？** `-pl todo-cli` 只把 `todo-cli` 放進 reactor。
Maven 找不到 `todo-importer` 在 reactor 裡，就去 `~/.m2/repository` 找——
但你從沒 `install` 過它。

```bash
# -am (--also-make)：連我依賴的模組一起建
mvn -pl todo-cli -am package
# → 建 todo（pom）、todo-model、todo-core、todo-importer、todo-cli
```

```bash
# -amd (--also-make-dependents)：連依賴我的模組一起建
mvn -pl todo-core -amd test
# → 建 todo-core，以及所有依賴 todo-core 的模組（core / importer / cli）
# 用途：「我改了 core，誰會被我弄壞？」
```

其他實用組合：

```bash
# 多個模組，逗號分隔
mvn -pl todo-model,todo-core install

# 用路徑指定（子目錄很深時方便）
mvn -pl :todo-cli install          # 冒號前綴 = 用 artifactId 指定

# 排除某個模組（前面加 !，zsh 要用引號包起來）
mvn -pl '!todo-cli' install

# 從某個模組開始往後建（前一次失敗後接續）
mvn -rf todo-core install          # -rf = --resume-from
```

`-rf` 超級好用：30 個模組建到第 18 個失敗，你修好之後不用從頭建，
Maven 甚至會直接在錯誤訊息裡告訴你指令：

```
[ERROR] After correcting the problems, you can resume the build with the command
[ERROR]   mvn <args> -rf :todo-importer
```

### 平行建置

```bash
mvn -T 1C clean install     # 每個 CPU 核心 1 個執行緒
mvn -T 4 clean install      # 固定 4 個執行緒
mvn -T 2C clean install     # 每核心 2 個
```

Maven 會依 reactor 的依賴圖，把**互相沒有依賴關係**的模組平行建置。
我們的 Todo 專案是一條直線（model → core → importer → cli），
所以 `-T` 沒有幫助。但 20 個模組的專案通常能省 40–60%。

> ⚠️ **`-T` 的前提是外掛必須是 thread-safe。** 不安全的外掛會噴：
>
> ```
> [WARNING] The following plugins are not marked as thread-safe in project X:
> [WARNING]   org.some:legacy-plugin:1.0
> ```
>
> 現代主流外掛都標了。如果看到警告，先確認那個外掛的行為（通常還是能跑，
> 但偶爾會出現詭異的競態——例如兩個模組同時寫同一個檔案）。
> CI 上如果建置結果不穩定，先把 `-T` 拿掉試試。

### 多模組的常見錯誤

| 錯誤 | 原因 | 修法 |
|---|---|---|
| `Could not resolve dependencies ... (absent)` | 用 `-pl` 但沒有 `-am` | 加 `-am`，或先 `mvn install` 全部 |
| 改了 `todo-core` 但 `todo-cli` 沒吃到 | 只 `mvn install -pl todo-core`，`todo-cli` 用的是舊 jar | 用 `-amd`，或在根目錄建 |
| 子模組版本和 parent 不同步 | 手動改版號改漏了 | 用 `mvn versions:set`，或用 `${revision}`（10.16 節） |
| 每個子模組都重複一大段 pom | 沒善用 parent 的 `pluginManagement` | 設定上移到根 pom |
| IDE 只認得一個模組 | 開的是子模組的 pom | 開**根目錄**的 pom，IDE 才會匯入整個 reactor |

---

## 10.13 打包成可執行 jar：四種做法

目標：讓使用者只要 `java -jar todo-cli.jar` 就能跑。

### 先搞懂：為什麼預設打出來的 jar 不能跑

```bash
mvn clean package
java -jar target/todo-cli.jar
```

```
no main manifest attribute, in target/todo-cli.jar
```

**原因**：jar 的 `META-INF/MANIFEST.MF` 沒有 `Main-Class`。

```bash
unzip -p target/todo-cli.jar META-INF/MANIFEST.MF
```

```
Manifest-Version: 1.0
Created-By: Maven JAR Plugin 3.4.2
Build-Jdk-Spec: 21
```

加上 `Main-Class` 之後（10.4 節的 `maven-jar-plugin` 設定）：

```
Manifest-Version: 1.0
Created-By: Maven JAR Plugin 3.4.2
Build-Jdk-Spec: 21
Main-Class: com.example.todo.App
```

再跑：

```bash
java -jar target/todo-cli.jar
```

```
Exception in thread "main" java.lang.NoClassDefFoundError:
    com/fasterxml/jackson/databind/ObjectMapper
	at com.example.todo.App.main(App.java:31)
Caused by: java.lang.ClassNotFoundException: com.fasterxml.jackson.databind.ObjectMapper
	...
```

**第二個問題**：jar 裡只有**你的** class，第三方依賴不在裡面。

而且——這是本章最重要的一個陷阱：

```bash
# 直覺的解法：把依賴加到 classpath
java -cp "target/todo-cli.jar:$HOME/.m2/repository/com/fasterxml/..." -jar target/todo-cli.jar
```

**還是一樣的錯誤。**

> 🔥 **`java -jar` 會完全忽略 `-cp` / `-classpath` 與 `CLASSPATH` 環境變數。**
>
> 用 `-jar` 時，classpath **只由 jar 內 manifest 的 `Class-Path` 屬性決定**。
> 這是 JVM 的規格行為，不是 bug。
>
> 所以你有兩條路：
> ① 不用 `-jar`，改用 `java -cp "jar:lib/*" com.example.todo.App`
> ② 用 `-jar`，但把依賴問題在**打包時**解決（下面四種做法）
>
> 這個陷阱每個 Java 工程師都會撞一次。撞完就記住了。

---

### 做法一：jar + `lib/` 目錄（manifest 的 `Class-Path`）

```xml
<plugins>
  <!-- 1. 把依賴複製到 target/lib/ -->
  <plugin>
    <groupId>org.apache.maven.plugins</groupId>
    <artifactId>maven-dependency-plugin</artifactId>
    <version>3.8.0</version>
    <executions>
      <execution>
        <id>copy-dependencies</id>
        <phase>prepare-package</phase>
        <goals><goal>copy-dependencies</goal></goals>
        <configuration>
          <outputDirectory>${project.build.directory}/lib</outputDirectory>
          <includeScope>runtime</includeScope>   <!-- 不要 test / provided -->
          <overWriteReleases>false</overWriteReleases>
        </configuration>
      </execution>
    </executions>
  </plugin>

  <!-- 2. 在 manifest 寫入 Class-Path: lib/xxx.jar lib/yyy.jar ... -->
  <plugin>
    <groupId>org.apache.maven.plugins</groupId>
    <artifactId>maven-jar-plugin</artifactId>
    <version>3.4.2</version>
    <configuration>
      <archive>
        <manifest>
          <mainClass>${main.class}</mainClass>
          <addClasspath>true</addClasspath>
          <classpathPrefix>lib/</classpathPrefix>
        </manifest>
      </archive>
    </configuration>
  </plugin>
</plugins>
```

產出：

```
target/
├── todo-cli.jar          ← 只有你的 class，很小（~40 KB）
└── lib/
    ├── jackson-databind-2.17.2.jar
    ├── jackson-core-2.17.2.jar
    ├── jackson-annotations-2.17.2.jar
    ├── jackson-datatype-jsr310-2.17.2.jar
    ├── slf4j-api-2.0.16.jar
    ├── logback-classic-1.5.8.jar
    └── logback-core-1.5.8.jar
```

manifest：

```
Main-Class: com.example.todo.App
Class-Path: lib/jackson-databind-2.17.2.jar lib/jackson-core-2.17.2.jar ...
```

```bash
java -jar target/todo-cli.jar list      # 可以跑了
```

| ✅ 優點 | ❌ 缺點 |
|---|---|
| 沒有任何檔案被改寫，依賴保持原樣（簽章有效） | 要搬**一整個目錄**，不是單一檔案 |
| 增量部署超快：改程式只重傳 40 KB 的主 jar | `lib/` 移動或改名就壞掉（`Class-Path` 是相對路徑） |
| Docker 分層友善（`lib/` 很少變，可以是獨立的 layer） | 依賴清單寫死在 manifest 裡，少一個檔案就 `NoClassDefFoundError` |

**適用**：Docker 映像、有部署腳本的環境。這其實是**最推薦的做法**，
只是「一個檔案」的直覺讓大家都跑去用 shade。

---

### 做法二：uber-jar / fat-jar（maven-shade-plugin）

設定在 10.10 節已經給了。原理是把所有依賴 jar **解開、混在一起、重新打包**：

```
todo-cli.jar
├── META-INF/MANIFEST.MF          （Main-Class: com.example.todo.App）
├── META-INF/services/            （由 ServicesResourceTransformer 合併）
│   ├── org.slf4j.spi.SLF4JServiceProvider
│   └── com.fasterxml.jackson.databind.Module
├── com/example/todo/...          （你的）
├── com/fasterxml/jackson/...     （Jackson 的）
├── org/slf4j/...
└── ch/qos/logback/...
```

```bash
mvn clean package
ls -lh target/todo-cli.jar          # ~8 MB
java -jar target/todo-cli.jar list  # 直接跑
```

驗證內容：

```bash
# 看有沒有 Main-Class
unzip -p target/todo-cli.jar META-INF/MANIFEST.MF

# 看 SPI 檔案有沒有被正確合併（每個 provider 都該在）
unzip -p target/todo-cli.jar META-INF/services/org.slf4j.spi.SLF4JServiceProvider

# 確認沒有殘留簽章檔
unzip -l target/todo-cli.jar | grep -E "\.SF|\.DSA|\.RSA"

# 找重複的 class（同名 class 出現兩次 = 有東西被覆蓋了）
unzip -l target/todo-cli.jar | awk '{print $4}' | grep '\.class$' \
  | sort | uniq -d | head
```

| ✅ 優點 | ❌ 缺點 |
|---|---|
| 真的只有一個檔案，`scp` 過去就能跑 | 每次改一行程式，整個 8 MB 都要重傳 |
| 不怕 `lib/` 被亂動 | 檔案衝突要手動處理（`ServicesResourceTransformer` 等） |
| 可以做 relocation（把套件改名，避開衝突） | **簽章 jar 會失效**（`.SF` 被移除，或不移除就報錯） |
| | 授權合規麻煩：`META-INF/LICENSE` 只留一份，追不出用了誰的程式碼 |
| | Docker 分層永遠是一大塊，快取效率差 |

**shade 的隱藏武器：relocation。**
如果你在寫**函式庫**，而你依賴 Guava 31，使用者依賴 Guava 33——
你可以把自己用的 Guava「搬家」到私有套件名，徹底避開衝突：

```xml
<relocations>
  <relocation>
    <pattern>com.google.common</pattern>
    <shadedPattern>com.example.todo.shaded.com.google.common</shadedPattern>
  </relocation>
</relocations>
```

shade 會改寫 bytecode 裡所有對這些類別的引用。
**代價**：反射會壞（字串裡的類別名不會被改寫）、debug 時堆疊很醜、jar 變大。
**只在寫對外函式庫時考慮，應用程式不需要。**

---

### 做法三：Spring Boot 式的嵌套 jar

Spring Boot 不用 shade，它用**嵌套 jar**：

```
app.jar
├── META-INF/MANIFEST.MF
│     Main-Class: org.springframework.boot.loader.launch.JarLauncher
│     Start-Class: com.example.Application
├── org/springframework/boot/loader/...     （Boot 的自訂 ClassLoader）
├── BOOT-INF/
│   ├── classes/com/example/...             （你的 class）
│   └── lib/
│       ├── jackson-databind-2.17.2.jar     ← 完整的 jar，沒有被解開！
│       └── ...
```

`java -jar app.jar` 執行的是 `JarLauncher`，它建立一個自訂 `ClassLoader`
（第 09 章 9.6 節），能從**嵌套在 jar 裡的 jar** 載入類別，
然後才呼叫 `Start-Class`。

**這個設計解決了 shade 的所有缺點**：

| 問題 | shade | Boot 嵌套 jar |
|---|---|---|
| 檔案名稱衝突 | 要手動加 transformer | 不會發生，每個 jar 保持獨立 |
| 簽章失效 | 是 | 不會 |
| 授權追蹤 | 混在一起 | 每個 jar 的 `META-INF` 完整保留 |
| Docker 分層 | 一大塊 | 可用 `jarmode` 拆成 4 層 |
| 依賴 jar 的原始位元組 | 被改寫 | 完全不變 |

我們的 Todo CLI 沒有 Spring，但這個知識在第 02 站馬上會用到：

```xml
<plugin>
  <groupId>org.springframework.boot</groupId>
  <artifactId>spring-boot-maven-plugin</artifactId>
  <executions>
    <execution>
      <goals><goal>repackage</goal></goals>
    </execution>
  </executions>
</plugin>
```

`repackage` 這個 goal 名字很精確：它拿 `maven-jar-plugin` 打好的普通 jar，
**重新包裝**成可執行的嵌套 jar，並把原本的普通 jar 留成 `xxx.jar.original`。

Docker 分層（第 02 站會用到）：

```bash
java -Djarmode=tools -jar app.jar list-layers
java -Djarmode=tools -jar app.jar extract --layers --destination extracted/
# → dependencies/ spring-boot-loader/ snapshot-dependencies/ application/
```

依賴那層幾個月才變一次，應用那層每次 commit 都變。
分開之後，Docker push / pull 的量從 60 MB 降到 2 MB。

> ⚠️ **這個 `jarmode` 的名字換過**：Spring Boot 3.2 之前是 `-Djarmode=layertools`，
> 3.3 起改成 `-Djarmode=tools`（`layertools` 標為棄用）。
> 網路上的舊教學大多寫 `layertools`，在新版上會看到棄用警告。
> 用 `java -Djarmode=tools -jar app.jar help` 確認你手上這版支援什麼子指令。

> 純 Java 專案想要同樣效果，可以用 **`maven-assembly-plugin`** 產生
> `jar + lib/` 的 tar.gz（做法一的封裝版），或直接在 Dockerfile 裡分兩次 `COPY`（10.14 節）。

---

### 做法四：jlink / jpackage——不需要裝 Java

前三種做法都假設目標機器**已經裝了 JRE**。如果沒有呢？

**`jlink`**（Java 9+）把「你的程式 + 只用到的 JDK 模組」組成一個**自帶執行環境的目錄**。

前提：**所有依賴都必須是 JPMS 模組**（有 `module-info.class`）。

```java
// src/main/java/module-info.java
module com.example.todo {
    requires com.fasterxml.jackson.databind;
    requires com.fasterxml.jackson.annotation;
    requires org.slf4j;

    // 讓 Jackson 能用反射存取我們的 model（第 07 章的序列化）
    opens com.example.todo.model to com.fasterxml.jackson.databind;

    exports com.example.todo.model;
}
```

先確認依賴的模組狀態：

```bash
# 列出需要哪些 JDK 模組
jdeps --multi-release 21 --print-module-deps \
      --class-path "target/lib/*" target/todo-cli.jar
# → java.base,java.logging,java.sql,java.xml

# 檢查某個 jar 是不是「真模組」還是「自動模組」
jar --describe-module --file target/lib/jackson-databind-2.17.2.jar
```

```
com.fasterxml.jackson.databind@2.17.2 jar:file:///.../jackson-databind-2.17.2.jar/!module-info.class
requires com.fasterxml.jackson.annotation transitive
requires com.fasterxml.jackson.core transitive
...
```

有 `module-info.class` → 真模組，可以 jlink。如果輸出是：

```
no.module.info@1.0 automatic
```

→ **自動模組（automatic module），`jlink` 不接受**，你就走不下去了。

> ⚠️ **這是 jlink 最大的實務障礙。** 一個專案有 30 個依賴，
> 只要**一個**是自動模組，整條路就斷了。所以 jlink 在應用程式上不普及，
> 主要用在 ① 依賴很少的 CLI 工具 ② 想極小化容器映像 ③ 桌面應用。

組出執行環境：

```bash
mvn clean package

jlink \
  --module-path "$JAVA_HOME/jmods:target/classes:target/lib" \
  --add-modules com.example.todo \
  --launcher todo=com.example.todo/com.example.todo.App \
  --strip-debug \
  --no-header-files \
  --no-man-pages \
  --compress=zip-6 \
  --output target/todo-runtime
```

```bash
du -sh target/todo-runtime      # 約 50–70 MB（完整 JDK 是 300+ MB）
./target/todo-runtime/bin/todo list
```

> `--compress` 的語法在 JDK 21 改過：舊的 `--compress=2` 已棄用，
> 現在是 `--compress=zip-0` 到 `zip-9`（或 `zip-6` 這種折衷值）。
> 看到舊教學寫 `--compress=2`，在新 JDK 上會有棄用警告。

**`jpackage`**（Java 14 引入，16 正式）再往前一步——產生**原生安裝檔**：

```bash
jpackage \
  --name Todo \
  --app-version 1.0.0 \
  --input target/dist \
  --main-jar todo-cli.jar \
  --main-class com.example.todo.App \
  --runtime-image target/todo-runtime \
  --type dmg \
  --dest target/installer
```

`--type` 可選：`dmg` / `pkg`（macOS）、`msi` / `exe`（Windows）、`deb` / `rpm`（Linux）、
`app-image`（純目錄，跨平台通用）。

> ⚠️ **`jpackage` 只能產生「當前平台」的安裝檔。** 要 Windows 的 msi，
> 就得在 Windows 上跑（通常用 CI 的 matrix build 解決）。
> 另外 macOS 的 dmg 要能給別人用，還需要 Apple 的簽章與公證（notarization）。

---

### 四種做法對照

| | jar + `lib/` | uber-jar (shade) | 嵌套 jar (Boot) | jlink / jpackage |
|---|---|---|---|---|
| 產出 | 1 jar + 目錄 | 1 jar | 1 jar | 一個目錄 / 安裝檔 |
| 大小 | 40 KB + 8 MB | 8 MB | 8 MB | 50–70 MB |
| 目標機器要有 JRE | ✅ 要 | ✅ 要 | ✅ 要 | ❌ 不用 |
| SPI 需要特殊處理 | ❌ 不用 | ✅ 要 transformer | ❌ 不用 | ❌ 不用 |
| 簽章 jar 能用 | ✅ | ❌ | ✅ | ✅ |
| Docker 分層 | ✅ 好 | ❌ 差 | ✅ 好 | ➖ 整層 |
| 依賴必須是 JPMS 模組 | ❌ | ❌ | ❌ | ✅ **要** |
| 設定複雜度 | 低 | 中 | 低（有 Boot） | 高 |

**選擇建議：**

- **有 Spring Boot** → 用 `spring-boot-maven-plugin`，沒有第二個選項。
- **純 Java 應用，要進 Docker** → 做法一（jar + lib），分層快取效益最大。
- **純 Java 應用，要給人手動下載執行** → 做法二（shade），一個檔案最省溝通。
- **桌面工具 / 目標機器沒有 Java** → 做法四。
- **寫函式庫** → **不要打包依賴**。發佈普通 jar，讓使用者自己決定版本。
  （打包依賴的函式庫是別人專案裡衝突的來源。）

---

## 10.14 容器化：從 jar 到映像

建置的最後一哩路。這一節接第 09 章 9.13 節的容器陷阱。

### 一份可以直接用的多階段 Dockerfile

```dockerfile
# syntax=docker/dockerfile:1

# ══════════════════════════════════════════════════════════════════
# 階段 1：建置（這一層不會進最終映像）
# ══════════════════════════════════════════════════════════════════
FROM maven:3.9.9-eclipse-temurin-21 AS build

WORKDIR /build

# 先只複製 pom.xml，讓依賴下載這一層能被快取
# 只要 pom 沒變，改 Java 程式碼時就不用重新下載依賴
COPY pom.xml .
COPY todo-model/pom.xml todo-model/
COPY todo-core/pom.xml todo-core/
COPY todo-importer/pom.xml todo-importer/
COPY todo-cli/pom.xml todo-cli/

# BuildKit 的快取掛載：~/.m2 在多次 build 之間共用，但不會進映像層
RUN --mount=type=cache,target=/root/.m2 \
    mvn -B -ntp -q dependency:go-offline

# 現在才複製原始碼
COPY todo-model/src todo-model/src
COPY todo-core/src todo-core/src
COPY todo-importer/src todo-importer/src
COPY todo-cli/src todo-cli/src

# -B: batch mode（非互動，CI 必加）  -ntp: 不印下載進度
RUN --mount=type=cache,target=/root/.m2 \
    mvn -B -ntp clean verify

# ══════════════════════════════════════════════════════════════════
# 階段 2：執行（只有 JRE + 我們的東西）
# ══════════════════════════════════════════════════════════════════
FROM eclipse-temurin:21-jre-alpine

# 不要用 root 跑應用（安全基本功）
RUN addgroup -S app && adduser -S -G app app

WORKDIR /app

# 分兩次 COPY：依賴很少變（快取命中），應用每次都變
COPY --from=build /build/todo-cli/target/lib/ ./lib/
COPY --from=build /build/todo-cli/target/todo-cli.jar ./todo-cli.jar

USER app

# JVM 參數：全部來自第 09 章 9.13 節
ENV JAVA_OPTS="\
  -XX:MaxRAMPercentage=75.0 \
  -XX:+ExitOnOutOfMemoryError \
  -XX:+HeapDumpOnOutOfMemoryError \
  -XX:HeapDumpPath=/tmp \
  -Xlog:gc*:file=/tmp/gc.log:time,uptime,level,tags:filecount=5,filesize=10M \
  -Duser.timezone=Asia/Taipei \
  -Dfile.encoding=UTF-8"

# ⚠️ 用 exec 形式（JSON 陣列），不要用 shell 形式
# shell 形式會讓 /bin/sh 當 PID 1，SIGTERM 不會傳給 java，
# graceful shutdown（第 08 章 8.11 節）就失效了
ENTRYPOINT ["sh", "-c", "exec java $JAVA_OPTS -jar /app/todo-cli.jar \"$@\"", "--"]
CMD ["list"]
```

> **為什麼 `ENTRYPOINT` 這樣寫這麼醜？**
> 因為我們想同時要三件事：① `$JAVA_OPTS` 被展開（需要 shell）
> ② `java` 成為 PID 1（需要 `exec`）③ `docker run image add "買牛奶"` 的參數能傳進去（需要 `"$@"`）。
> `sh -c "exec java ... \"$@\"" --` 是同時滿足三者的標準寫法。
>
> 如果不需要 `JAVA_OPTS`，就用最乾淨的形式：
> ```dockerfile
> ENTRYPOINT ["java", "-XX:MaxRAMPercentage=75.0", "-jar", "/app/todo-cli.jar"]
> ```

### `.dockerignore`（別漏了）

```
target/
**/target/
.git/
.gitignore
.idea/
*.iml
*.md
docs/
.mvn/wrapper/maven-wrapper.jar
```

沒有 `.dockerignore` 的話，`docker build` 會把整個 `target/`（含幾百 MB 的
class 檔、jar、heap dump）當成 build context 送給 daemon——**建置變超慢，
而且任何 `COPY . .` 都可能把你本機的 heap dump 和 log 打進映像。**

### 建置與驗證

```bash
docker build -t todo-cli:1.0.0 .

# 看映像分了幾層、各層多大
docker history todo-cli:1.0.0

# 執行
docker run --rm todo-cli:1.0.0 list
docker run --rm -v "$PWD/data:/app/data" todo-cli:1.0.0 add "買牛奶" --priority HIGH

# 驗證第 09 章的容器感知：JVM 有沒有看到 cgroup 的限制
docker run --rm --memory=512m todo-cli:1.0.0 \
  sh -c 'java -XX:MaxRAMPercentage=75 -XshowSettings:system -version 2>&1 | head -20'
```

預期輸出（節錄）：

```
Operating System Metrics:
    Provider: cgroupv2
    Effective CPU Count: 8
    CPU Period: 100000us
    CPU Quota: -1
    Memory Limit: 512.00M
    Memory Soft Limit: Unlimited
    Memory & Swap Limit: 512.00M
```

`Memory Limit: 512.00M` 表示 JVM 讀到了容器限制。
如果這裡顯示的是**主機**的記憶體，你的 JVM 就會用主機大小去算堆積 →
`OOMKilled`（第 09 章 9.13 節）。

### 不寫 Dockerfile 的選項

| 工具 | 指令 | 特點 |
|---|---|---|
| **Jib**（Google） | `mvn com.google.cloud.tools:jib-maven-plugin:build` | 不需要 Docker daemon、自動分層、可重現、直接推 registry。**強烈推薦** |
| Spring Boot | `mvn spring-boot:build-image` | 用 Cloud Native Buildpacks，零設定但映像較大 |
| `docker build` | 上面的 Dockerfile | 最大彈性，最需要維護 |

Jib 的設定短得驚人：

```xml
<plugin>
  <groupId>com.google.cloud.tools</groupId>
  <artifactId>jib-maven-plugin</artifactId>
  <version>3.4.3</version>
  <configuration>
    <from><image>eclipse-temurin:21-jre-alpine</image></from>
    <to><image>registry.example.com/todo-cli:${project.version}</image></to>
    <container>
      <mainClass>${main.class}</mainClass>
      <jvmFlags>
        <jvmFlag>-XX:MaxRAMPercentage=75.0</jvmFlag>
        <jvmFlag>-XX:+ExitOnOutOfMemoryError</jvmFlag>
      </jvmFlags>
      <user>1000:1000</user>
      <!-- 可重現建置：固定映像的建立時間 -->
      <creationTime>USE_CURRENT_TIMESTAMP</creationTime>
    </container>
  </configuration>
</plugin>
```

```bash
mvn package jib:build           # 推到 registry
mvn package jib:dockerBuild     # 載入本機 Docker
```

Jib 自動把依賴、資源、你的 class 分成三層——**改一行程式碼只重推幾十 KB**。

---

## 10.15 Gradle 對照

Gradle 是另一個主流選擇。你不一定會用它，但**一定會遇到用它的專案**。

### 概念對照表

| Maven | Gradle | 說明 |
|---|---|---|
| `pom.xml` | `build.gradle.kts` / `build.gradle` | Kotlin DSL（推薦）或 Groovy DSL |
| `settings.xml` | `~/.gradle/gradle.properties` + `init.gradle.kts` | |
| 多模組 `<modules>` | `settings.gradle.kts` 的 `include(...)` | Gradle 的模組叫 subproject |
| phase / goal | task | Gradle 是**任務圖**，不是固定生命週期 |
| `mvn clean package` | `./gradlew clean build` | `build` = `assemble` + `check` |
| `mvn install` | `./gradlew publishToMavenLocal` | |
| `mvn dependency:tree` | `./gradlew dependencies` | |
| `mvn help:effective-pom` | `./gradlew properties` / `dependencyInsight` | |
| `mvnw` | `gradlew` | 兩者都是 wrapper |
| `<properties>` | `gradle/libs.versions.toml`（version catalog） | |

### scope / configuration 對照

| Maven scope | Gradle configuration | 差別 |
|---|---|---|
| `compile`（會外露的 API） | `api` | 需要 `java-library` plugin |
| `compile`（純內部實作） | `implementation` | **Maven 沒有等價物** |
| `provided` | `compileOnly` | |
| `runtime` | `runtimeOnly` | |
| `test` | `testImplementation` | |
| test 的 runtime | `testRuntimeOnly` | |
| 註解處理器 | `annotationProcessor` | |

> 🔑 **`api` vs `implementation` 是 Gradle 相對 Maven 最實質的優勢。**
>
> Maven 的 `compile` 依賴一律傳遞給使用者。你用了 Guava 當內部工具，
> 你的使用者的 classpath 上就會出現 Guava——他們可能因此撞上版本衝突，
> 而且他們的 IDE 會自動補全 Guava 的類別，讓他們「不小心」依賴上它。
>
> Gradle 的 `implementation` 表示「我用它，但不外露」——
> 它**不會出現在使用者的編譯 classpath 上**（只在執行期 classpath）。
> 結果：① 使用者的編譯 classpath 小很多 → 編譯快 ② 你改用別的函式庫時，
> 不會是使用者的 breaking change。
>
> 判斷法則：**這個型別有出現在我的 `public` / `protected` 方法簽章或欄位型別上嗎？**
> 有 → `api`；沒有 → `implementation`。

### Todo 專案的 Gradle 版本

**`settings.gradle.kts`**

```kotlin
rootProject.name = "todo"

include("todo-model", "todo-core", "todo-importer", "todo-cli")
```

**`gradle/libs.versions.toml`**（version catalog，等價於 Maven 的 `<properties>` + BOM）

```toml
[versions]
jackson = "2.17.2"
slf4j = "2.0.16"
logback = "1.5.8"
junit = "5.11.0"
assertj = "3.26.3"
mockito = "5.13.0"

[libraries]
jackson-bom = { module = "com.fasterxml.jackson:jackson-bom", version.ref = "jackson" }
jackson-databind = { module = "com.fasterxml.jackson.core:jackson-databind" }
jackson-annotations = { module = "com.fasterxml.jackson.core:jackson-annotations" }
jackson-jsr310 = { module = "com.fasterxml.jackson.datatype:jackson-datatype-jsr310" }
slf4j-api = { module = "org.slf4j:slf4j-api", version.ref = "slf4j" }
logback-classic = { module = "ch.qos.logback:logback-classic", version.ref = "logback" }
junit-bom = { module = "org.junit:junit-bom", version.ref = "junit" }
junit-jupiter = { module = "org.junit.jupiter:junit-jupiter" }
assertj = { module = "org.assertj:assertj-core", version.ref = "assertj" }
mockito = { module = "org.mockito:mockito-core", version.ref = "mockito" }

[plugins]
shadow = { id = "com.gradleup.shadow", version = "8.3.3" }
```

**根 `build.gradle.kts`**（等價於 Maven 的父 pom）

```kotlin
plugins {
    // 只宣告不套用，讓子專案自己 apply
    id("java-library") apply false
}

// 所有子專案的共通設定
subprojects {
    apply(plugin = "java-library")

    group = "com.example"
    version = "1.0.0-SNAPSHOT"

    repositories {
        mavenCentral()
    }

    extensions.configure<JavaPluginExtension> {
        toolchain {
            // 等價於 maven.compiler.release，而且更強：
            // Gradle 會自動下載對應版本的 JDK，不必依賴本機裝了什麼
            languageVersion.set(JavaLanguageVersion.of(21))
        }
    }

    dependencies {
        // BOM：用 platform() 匯入
        add("implementation", platform(rootProject.libs.jackson.bom))
        add("testImplementation", platform(rootProject.libs.junit.bom))

        add("implementation", rootProject.libs.slf4j.api)
        add("testImplementation", rootProject.libs.junit.jupiter)
        add("testImplementation", rootProject.libs.assertj)
    }

    tasks.withType<JavaCompile>().configureEach {
        options.encoding = "UTF-8"
        options.compilerArgs.addAll(listOf("-parameters", "-Xlint:all"))
    }

    tasks.withType<Test>().configureEach {
        useJUnitPlatform()
        systemProperty("user.timezone", "Asia/Taipei")
        systemProperty("file.encoding", "UTF-8")
    }

    tasks.withType<Jar>().configureEach {
        // 可重現建置：Gradle 只要兩行
        isPreserveFileTimestamps = false
        isReproducibleFileOrder = true
    }
}
```

**`todo-core/build.gradle.kts`**

```kotlin
dependencies {
    // api：todo-core 的 public 方法簽章有用到 Todo，所以要外露
    api(project(":todo-model"))

    // implementation：Jackson 只在內部用（JsonFileTodoRepository），不外露
    implementation(libs.jackson.databind)
    implementation(libs.jackson.jsr310)

    testImplementation(libs.mockito)
}
```

**`todo-cli/build.gradle.kts`**

```kotlin
plugins {
    application
    alias(libs.plugins.shadow)      // 等價於 maven-shade-plugin
}

dependencies {
    implementation(project(":todo-importer"))
    runtimeOnly(libs.logback.classic)
}

application {
    mainClass.set("com.example.todo.App")
    applicationDefaultJvmArgs = listOf("-XX:MaxRAMPercentage=75.0")
}

tasks.shadowJar {
    archiveFileName.set("todo-cli.jar")
    mergeServiceFiles()            // = ServicesResourceTransformer，一行搞定
}
```

```bash
./gradlew :todo-cli:shadowJar
java -jar todo-cli/build/libs/todo-cli.jar list

# application plugin 額外給你的：可執行腳本 + tar/zip 發佈包
./gradlew :todo-cli:installDist
./todo-cli/build/install/todo-cli/bin/todo-cli list
```

### 🔥 最重要的差異：衝突解決規則相反

| | Maven | Gradle |
|---|---|---|
| 規則 | **最近者優先**（路徑最短） | **最高版本優先** |
| 平手時 | 先宣告者勝 | 不會平手（比版本號） |
| 結果 | 可能選到**舊**版本 | 一定選到**新**版本 |
| 哪個更安全 | 較容易出現 `NoSuchMethodError` | 較不容易，但可能引入未測過的新版行為 |

同一份依賴清單，兩個工具可能給你**不同的 classpath**。
遷移 Maven → Gradle 時，這是最容易出現「莫名其妙壞掉」的地方——
你的專案可能**一直依賴著 Maven 選中的舊版本**的某個行為。

Gradle 的版本控制手段：

```kotlin
configurations.all {
    resolutionStrategy {
        // 強制指定版本，不管誰要求什麼
        force("com.google.guava:guava:33.3.0-jre")

        // 有衝突就建置失敗（等價於 enforcer 的 dependencyConvergence）
        failOnVersionConflict()

        // 快取 SNAPSHOT 的時間
        cacheChangingModulesFor(10, "minutes")
    }
}

dependencies {
    // 宣告嚴格版本（Gradle 特有，比 Maven 的 dependencyManagement 更精確）
    implementation("com.google.guava:guava") {
        version { strictly("33.3.0-jre") }
    }

    // 排除傳遞依賴
    implementation("com.example:legacy-sdk:3.2.0") {
        exclude(group = "commons-logging", module = "commons-logging")
    }
}
```

### Gradle 的其他優勢與代價

**優勢：**

| 特性 | 說明 |
|---|---|
| 增量建置 | 追蹤每個 task 的輸入/輸出雜湊，沒變就跳過。大專案差異巨大 |
| Build cache | 跨機器共用建置結果。CI 上第二個人建同一個 commit → 秒完成 |
| Configuration cache | 連「設定階段」都快取。`./gradlew test` 的啟動從 3 秒降到 0.3 秒 |
| Toolchain | 自動下載並使用指定版本的 JDK，不管本機裝了什麼 |
| 依賴驗證 | `gradle/verification-metadata.xml` 鎖住每個 jar 的 checksum / 簽章。**Maven 沒有內建等價功能** |
| 建置腳本是程式 | 想做什麼都行 |

**代價：**

| 問題 | 說明 |
|---|---|
| 建置腳本是程式 | 同一句話。有人會寫出 500 行沒人看得懂的 `build.gradle` |
| 學習曲線 | Maven 是宣告式的 XML，一小時能讀懂；Gradle 要理解 task graph、configuration、lifecycle |
| 版本相容性 | Gradle 大版本升級常需要改建置腳本；Maven 的 pom 十年前寫的今天還能跑 |
| 錯誤訊息 | Kotlin DSL 的型別錯誤有時很難讀 |

### 該選哪個

| 情境 | 建議 |
|---|---|
| Spring Boot 專案、團隊都熟 Maven | **Maven**。生態最完整，Spring 官方文件以 Maven 為主 |
| 專案很大（50+ 模組）、建置時間是痛點 | **Gradle**。增量 + cache 的差距是數量級 |
| Android | **Gradle**（沒有選擇） |
| 寫要發佈的函式庫，在意使用者的 classpath | **Gradle**（`api` / `implementation` 的價值） |
| 需要嚴格的依賴完整性驗證 | **Gradle**（verification-metadata） |
| 團隊沒有專職的建置工程師 | **Maven**。約定大於彈性，出事好查 |

> **本課程用 Maven**，因為第 02 站之後全部是 Spring Boot，
> 且 Maven 的 XML 讓「建置在做什麼」一目了然，適合學習。
> 但上面的對照表你要看得懂——換工作第一天就可能用上。

---

## 10.16 Wrapper、CI 與可重現建置

### Maven Wrapper：消滅「我這邊可以跑」

問題：你用 Maven 3.9.9，同事用 3.6.3，CI 用 3.8.1。三種行為。

解法：把 Maven 版本也放進版控。

```bash
mvn wrapper:wrapper -Dmaven=3.9.9
```

產生：

```
mvnw                                    ← Unix 腳本
mvnw.cmd                                ← Windows 腳本
.mvn/wrapper/maven-wrapper.properties   ← 指定版本
```

`.mvn/wrapper/maven-wrapper.properties`：

```properties
wrapperVersion=3.3.2
distributionType=only-script
distributionUrl=https://repo.maven.apache.org/maven2/org/apache/maven/apache-maven/3.9.9/apache-maven-3.9.9-bin.zip
```

從此**所有人都用 `./mvnw`，不用 `mvn`**：

```bash
./mvnw clean verify         # 第一次會自動下載 Maven 3.9.9
```

`distributionType=only-script` 是新版預設（不需要 commit 一個 jar 檔進版控，
避免「為什麼我們的 repo 裡有 binary」的爭議）。

### `.mvn/jvm.config` 與 `.mvn/maven.config`

這兩個檔案讓你把常用參數也放進版控：

**`.mvn/jvm.config`**——Maven **自己**的 JVM 參數（不是你程式的）：

```
-Xmx2g
-XX:+UseG1GC
```

大型多模組專案的 Maven 程序本身可能 OOM（reactor 要載入所有模組的 pom 與外掛），
這時就靠這個檔案。

**`.mvn/maven.config`**——每次都要加的 CLI 參數：

```
-Dstyle.color=always
-ntp
--fail-at-end
```

這樣 `./mvnw verify` 就自動帶上這些參數。
（`--fail-at-end` 讓多模組建置不要第一個失敗就停，一次看完所有錯誤。）

### GitHub Actions 範例

```yaml
name: build

on:
  push:
    branches: [ main, master ]
  pull_request:

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Set up JDK 21
        uses: actions/setup-java@v4
        with:
          distribution: temurin
          java-version: '21'
          cache: maven        # 自動快取 ~/.m2/repository

      # -B: batch mode（非互動）
      # -ntp: 不印下載進度，log 少 80%
      # -T 1C: 每核心一個執行緒
      - name: Build and test
        run: ./mvnw -B -ntp -T 1C clean verify

      # 失敗時也要上傳報告，否則你只看到「BUILD FAILURE」
      - name: Upload test reports
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: test-reports
          path: |
            **/target/surefire-reports/
            **/target/failsafe-reports/
          retention-days: 7

      - name: Upload jar
        if: success()
        uses: actions/upload-artifact@v4
        with:
          name: todo-cli
          path: todo-cli/target/todo-cli.jar
```

**CI 上的四條紀律：**

1. **一定加 `-B`（batch mode）。** 沒有它，Maven 可能等待互動輸入而卡住整個 job。
2. **一定加 `-ntp`。** 下載進度條在 CI log 裡是幾千行垃圾。
3. **一定跑 `verify` 而不是 `package`。** `verify` 才會跑整合測試與各種檢查。
4. **一定 `clean`。** 10.5 節說的殘留 class 問題，在 CI 上會變成「上週的 bug 又出現了」。

### 可重現建置（Reproducible Builds）

**問題**：同一個 commit，建兩次，jar 的 SHA-256 不一樣。

```bash
mvn clean package && sha256sum target/todo-cli.jar
# a3f5b8c...
mvn clean package && sha256sum target/todo-cli.jar
# 7d2e91a...   ← 不一樣！
```

**原因**：jar 是 zip，zip 每個 entry 都存了**檔案修改時間**。
每次建置時間不同 → 位元組不同。另外檔案的**排列順序**也可能因檔案系統而異。

**為什麼要在意？**

- **驗證**：你能證明「registry 上這個 jar 就是這個 commit 建出來的」，沒被植入東西。
  這是供應鏈安全的基石（SolarWinds 事件之後這件事被嚴肅對待）。
- **快取**：CI 的 build cache / Docker layer cache 靠 hash 判斷。
  hash 每次都變 → 快取永遠不命中 → CI 永遠很慢。
- **除錯**：「這個 jar 到底是哪一版」不再需要猜。

**Maven 的解法——一行屬性：**

```xml
<properties>
  <!-- 固定所有產出的時間戳。可以是固定值，或用 git commit 時間 -->
  <project.build.outputTimestamp>2026-08-17T00:00:00Z</project.build.outputTimestamp>
</properties>
```

現代 Maven 外掛（jar / shade / assembly / source / war ⋯）都認這個屬性，
會用它取代「現在的時間」，並且把 entry 依固定順序排列。

用 git commit 時間更實用（配 `git-commit-id-maven-plugin`）：

```xml
<plugin>
  <groupId>io.github.git-commit-id</groupId>
  <artifactId>git-commit-id-maven-plugin</artifactId>
  <version>9.0.1</version>
  <executions>
    <execution>
      <id>get-git-info</id>
      <phase>initialize</phase>
      <goals><goal>revision</goal></goals>
    </execution>
  </executions>
  <configuration>
    <dateFormat>yyyy-MM-dd'T'HH:mm:ss'Z'</dateFormat>
    <dateFormatTimeZone>UTC</dateFormatTimeZone>
  </configuration>
</plugin>

<properties>
  <project.build.outputTimestamp>${git.commit.time}</project.build.outputTimestamp>
</properties>
```

**驗證是否真的可重現：**

```bash
# 檢查建置計畫裡有沒有「已知會破壞可重現性」的外掛
mvn artifact:check-buildplan

# 建置兩次，比對
mvn clean package && cp target/todo-cli.jar /tmp/a.jar
mvn clean package && cp target/todo-cli.jar /tmp/b.jar
cmp /tmp/a.jar /tmp/b.jar && echo "✅ 可重現" || echo "❌ 有差異"

# 有差異時，找出是哪個 entry
unzip -l /tmp/a.jar > /tmp/a.txt
unzip -l /tmp/b.jar > /tmp/b.txt
diff /tmp/a.txt /tmp/b.txt
```

> ⚠️ **可重現不代表「兩台不同機器建出來一樣」**——那還需要
> 同一個 JDK 版本（不同 JDK 的 `javac` 可能產生不同 bytecode）、
> 同一個 locale、同一個 Maven 與外掛版本。
> `mvnw` + `<release>` + 鎖死外掛版本 + Docker 建置環境，四個一起才夠。

### CI-friendly 版本號

多模組專案發版時，要把 20 個 pom 的版本一起改。Maven 3.5+ 支援：

```xml
<!-- 根 pom -->
<groupId>com.example</groupId>
<artifactId>todo</artifactId>
<version>${revision}</version>

<properties>
  <revision>1.0.0-SNAPSHOT</revision>
</properties>
```

子模組的 `<parent>` 也寫 `<version>${revision}</version>`。
然後：

```bash
mvn clean deploy -Drevision=1.2.0
```

**但有個坑**：這樣安裝到倉庫的 pom 裡會留著字面上的 `${revision}`，
別人依賴你的模組時解析不到。必須用 `flatten-maven-plugin` 產生「展平」的 pom：

```xml
<plugin>
  <groupId>org.codehaus.mojo</groupId>
  <artifactId>flatten-maven-plugin</artifactId>
  <version>1.6.0</version>
  <configuration>
    <updatePomFile>true</updatePomFile>
    <flattenMode>resolveCiFriendliesOnly</flattenMode>
  </configuration>
  <executions>
    <execution>
      <id>flatten</id>
      <phase>process-resources</phase>
      <goals><goal>flatten</goal></goals>
    </execution>
    <execution>
      <id>flatten-clean</id>
      <phase>clean</phase>
      <goals><goal>clean</goal></goals>
    </execution>
  </executions>
</plugin>
```

> **要不要用？** 模組不多（< 10 個）的話，`mvn versions:set` 就夠了，
> 簡單且不需要額外外掛。模組很多、發版頻繁，才值得引入 `${revision}` + flatten。

---

## 10.17 依賴的供應鏈風險

你的 `pom.xml` 寫了 8 個依賴，實際上 classpath 有 45 個 jar，來自 30 個不同的維護者。
**你信任的不是 8 個專案，是 30 個。**

### 先看規模

```bash
# 直接依賴幾個
grep -c "<artifactId>" pom.xml

# 實際 classpath 上幾個
mvn dependency:list -DexcludeTransitive=false | grep -c ":compile\|:runtime"

# 依賴樹有幾層深
mvn dependency:tree | wc -l
```

Log4Shell（CVE-2021-44228）之所以是災難，正是因為**大部分受影響的公司
根本不知道自己用了 Log4j**——它是某個依賴的依賴的依賴。

### 掃描已知漏洞

**選項 1：OWASP dependency-check**（本機 / CI 都能跑）

```xml
<plugin>
  <groupId>org.owasp</groupId>
  <artifactId>dependency-check-maven</artifactId>
  <version>10.0.4</version>
  <configuration>
    <!-- CVSS >= 7（High）就讓建置失敗 -->
    <failBuildOnCVSS>7</failBuildOnCVSS>
    <!-- NVD 從 2023 起要求 API key，沒有 key 會被嚴重限速（可能跑一小時） -->
    <nvdApiKey>${env.NVD_API_KEY}</nvdApiKey>
    <!-- 誤判豁免清單 -->
    <suppressionFiles>
      <suppressionFile>owasp-suppressions.xml</suppressionFile>
    </suppressionFiles>
  </configuration>
  <executions>
    <execution>
      <goals><goal>check</goal></goals>
    </execution>
  </executions>
</plugin>
```

```bash
mvn dependency-check:check
# 報告在 target/dependency-check-report.html
```

> ⚠️ **第一次跑會下載整個 NVD 資料庫（幾百 MB，可能 10–40 分鐘）。**
> CI 上務必快取 `~/.m2/repository/org/owasp/dependency-check-data/`，
> 否則每次 build 都重下載。
>
> 另外它的**誤判率不低**（靠檔名 / 座標猜 CPE）。所以需要 suppression 檔——
> 但要求「每一條豁免都寫理由和到期日」，否則三年後那份檔案就是一坨沒人敢動的黑箱。

**選項 2：SBOM + 外部掃描器**（現在的主流做法）

先產生 SBOM（Software Bill of Materials）：

```xml
<plugin>
  <groupId>org.cyclonedx</groupId>
  <artifactId>cyclonedx-maven-plugin</artifactId>
  <version>2.9.0</version>
  <executions>
    <execution>
      <phase>package</phase>
      <goals>
        <!-- 多模組用 makeAggregateBom，單模組用 makeBom -->
        <goal>makeAggregateBom</goal>
      </goals>
    </execution>
  </executions>
  <configuration>
    <outputFormat>json</outputFormat>
    <includeCompileScope>true</includeCompileScope>
    <includeRuntimeScope>true</includeRuntimeScope>
    <includeTestScope>false</includeTestScope>
  </configuration>
</plugin>
```

```bash
mvn package
# → target/bom.json、target/bom.xml
```

`bom.json` 長這樣（節錄）：

```json
{
  "bomFormat": "CycloneDX",
  "specVersion": "1.5",
  "components": [
    {
      "type": "library",
      "group": "com.fasterxml.jackson.core",
      "name": "jackson-databind",
      "version": "2.17.2",
      "purl": "pkg:maven/com.fasterxml.jackson.core/jackson-databind@2.17.2?type=jar",
      "hashes": [
        { "alg": "SHA-256", "content": "b7b0f2a..." }
      ],
      "licenses": [ { "license": { "id": "Apache-2.0" } } ]
    }
  ]
}
```

然後餵給掃描器（這些的資料庫更新更快、誤判更少）：

```bash
trivy sbom target/bom.json
grype sbom:target/bom.json
osv-scanner --sbom target/bom.json
```

**SBOM 的三個用途**（不只是掃漏洞）：

1. **下一個 Log4Shell 發生時**，你 5 分鐘內就能回答「我們有沒有受影響」。
2. **授權合規**。有人用了 GPL 的函式庫進你的閉源產品 → 法務問題。
3. **客戶要求**。美國政府採購（EO 14028）已強制要求 SBOM，很多企業客戶跟進。

### 減少攻擊面本身

掃漏洞是被動的。主動的做法是**依賴更少的東西**：

| 做法 | 說明 |
|---|---|
| 定期 `mvn dependency:analyze` | 移除 unused declared 依賴。少一個依賴，少一整棵子樹 |
| 用 JDK 內建的取代函式庫 | `java.net.http.HttpClient`（Java 11+）取代 Apache HttpClient；`java.time` 取代 Joda-Time；`String.format` 取代 commons-lang 的 formatter |
| 不要為了一個方法引入整個函式庫 | 需要 `StringUtils.isBlank()`？`String` 有 `isBlank()`（Java 11+）。需要 `Lists.newArrayList()`？`List.of()` 就好 |
| 檢查依賴的健康度 | 最後一次 release 是什麼時候？有幾個維護者？有沒有 CI？只有一個人維護的函式庫，是**單點故障**也是**單點入侵** |
| 用 `provided` / `runtime` 收窄 | 10.7 節。不該進交付物的東西就別進 |

### 兩個要知道的攻擊手法

**① Typosquatting（打錯字攻擊）**

攻擊者發佈 `com.fasterxml.jackson.core:jackson-databnid`（少一個 i），
或 `org.apache.commons:commons-io`（真的是 `commons-io:commons-io`）。
你打錯一個字，就引入了惡意程式碼——而它會在**建置時**（註解處理器、
Maven 外掛）或**執行時**（static 初始化，第 09 章 9.6 節）執行。

**防禦**：依賴一律從官方文件或 IDE 的搜尋功能複製，不要手打。
用 enforcer 的 `requireReleaseDeps` + 內部倉庫白名單。

**② Dependency Confusion（依賴混淆）**

你公司內部有一個套件 `com.mycompany:internal-utils:1.0.0`，只存在私有倉庫。
攻擊者在 **Maven Central** 發佈一個同名但**版本號更高**的 `com.mycompany:internal-utils:99.0.0`。

如果你的 `settings.xml` 設定會同時查兩個倉庫⋯⋯Maven 的行為取決於
倉庫順序與版本解析方式，有機率抓到攻擊者的版本。
（在 npm / pip 生態這個攻擊已造成多次真實入侵。）

**防禦**：
- 用 `<mirror>` + `<mirrorOf>*</mirrorOf>` 把**所有**請求導到公司 Nexus，
  由 Nexus 決定去哪抓（內部套件永不外流查詢）。
- 內部套件用**你控制的網域**當 groupId，並在 Central 上「佔位」（發一個空的 1.0.0）。
- **不要在 pom 裡寫 `<repositories>`**——那會讓每個使用你的模組的人都去查那個倉庫。
  倉庫設定屬於 `settings.xml`。

### 完整性驗證：Maven 的弱點

```
Maven 會驗證下載檔案的 SHA-1（和倉庫上的 .sha1 比對）。
但那個 .sha1 是倉庫自己提供的——如果倉庫被入侵，兩個都會被換掉。
```

Maven Central 上的構件**有 GPG 簽章**（`.asc` 檔），但 Maven **預設不驗證**。

Gradle 有內建解法（`gradle/verification-metadata.xml`）：

```xml
<verification-metadata>
  <components>
    <component group="com.fasterxml.jackson.core" name="jackson-databind" version="2.17.2">
      <artifact name="jackson-databind-2.17.2.jar">
        <sha256 value="b7b0f2a1..."/>
      </artifact>
    </component>
  </components>
</verification-metadata>
```

```bash
./gradlew --write-verification-metadata sha256 build
```

之後任何 jar 的 checksum 對不上，建置立刻失敗。

Maven 這邊的替代方案：用公司 Nexus 當唯一入口，在 Nexus 上做掃描與白名單控制
（Nexus Firewall、Artifactory Xray 這類產品就是在賣這件事）。

> **這一節的重點不是「趕快裝一堆掃描器」**，而是建立一個認知：
> **`pom.xml` 裡的每一行都是一個信任決定。**
> 加依賴前先問三個問題：① 我真的需要它嗎？② 它帶進來多少傳遞依賴？
> ③ 它還在維護嗎？
>
> 三個問題花你兩分鐘。省下的可能是某個週末的緊急修補。

---

## 10.18 練習專案：把 Todo CLI 打包出貨

現在把整章串起來。目標：

1. 把單模組的 Todo 專案拆成四個模組。
2. 打包成 `java -jar todo-cli.jar` 就能跑的可執行 jar。
3. 產出可重現的建置、SBOM，以及一個 Docker 映像。
4. 讓 `todo --version` 能印出版本與建置時間。

### 最終目錄結構

```
todo/
├── .dockerignore
├── .gitignore
├── .mvn/
│   ├── jvm.config
│   ├── maven.config
│   └── wrapper/maven-wrapper.properties
├── Dockerfile
├── Makefile
├── mvnw
├── mvnw.cmd
├── pom.xml                        ← 根 pom（10.12 節）
│
├── todo-model/
│   ├── pom.xml
│   └── src/main/java/com/example/todo/model/
│       ├── Priority.java          （第 02 章）
│       └── Todo.java              （第 07 章：Instant + Jackson 註解）
│
├── todo-core/
│   ├── pom.xml
│   └── src/
│       ├── main/java/com/example/todo/
│       │   ├── exception/         （第 04 章：ErrorCode、TodoException 家族）
│       │   ├── repository/        （第 04、05、07、08 章）
│       │   ├── service/           （第 07 章：注入 Clock 的 TodoService）
│       │   └── support/           （第 07 章：Json、TodoFileStore）
│       └── test/java/...          （第 11 章會補齊）
│
├── todo-importer/
│   ├── pom.xml
│   └── src/main/java/com/example/todo/importer/
│                                  （第 08 章：ConcurrentTodoImporter 等）
│
└── todo-cli/
    ├── pom.xml
    └── src/main/
        ├── java/com/example/todo/
        │   ├── App.java           ← 本章新寫
        │   └── support/BuildInfo.java   ← 本章新寫（10.6 節）
        └── resources/
            ├── build-info.properties    ← 本章新寫（會被 filtering）
            └── logback.xml              ← 本章新寫
```

前面章節寫的類別**一行都不用改**，只是搬進對應的模組目錄。
本章新增的是**建置設定**與**進入點**。

### `todo-cli/src/main/resources/build-info.properties`

```properties
# 這些 ${} 會在建置時被 Maven 替換成真實值（10.6 節的 resource filtering）
app.name=${project.name}
app.version=${project.version}
app.buildTime=${maven.build.timestamp}
app.javaTarget=${maven.compiler.release}
```

### `todo-cli/src/main/resources/logback.xml`

```xml
<?xml version="1.0" encoding="UTF-8"?>
<configuration>

  <!-- CLI 工具：log 走 stderr，讓 stdout 保持乾淨（可以被 pipe / 重導向） -->
  <appender name="STDERR" class="ch.qos.logback.core.ConsoleAppender">
    <target>System.err</target>
    <encoder>
      <pattern>%d{HH:mm:ss.SSS} %-5level %logger{20} - %msg%n</pattern>
      <charset>UTF-8</charset>
    </encoder>
  </appender>

  <!-- 也寫檔，方便事後追查 -->
  <appender name="FILE" class="ch.qos.logback.core.rolling.RollingFileAppender">
    <file>${user.home}/.todo/logs/todo.log</file>
    <rollingPolicy class="ch.qos.logback.core.rolling.TimeBasedRollingPolicy">
      <fileNamePattern>${user.home}/.todo/logs/todo.%d{yyyy-MM-dd}.log.gz</fileNamePattern>
      <maxHistory>7</maxHistory>
      <totalSizeCap>50MB</totalSizeCap>
    </rollingPolicy>
    <encoder>
      <pattern>%d{ISO8601} [%thread] %-5level %logger - %msg%n</pattern>
      <charset>UTF-8</charset>
    </encoder>
  </appender>

  <root level="INFO">
    <appender-ref ref="STDERR"/>
    <appender-ref ref="FILE"/>
  </root>

  <!-- 開發時想看細節：java -Dlogging.level=DEBUG -jar ... 沒用（那是 Spring 的做法），
       CLI 就用環境變數控制 -->
  <logger name="com.example.todo" level="${TODO_LOG_LEVEL:-INFO}"/>

</configuration>
```

> **CLI 工具的 log 走 `stderr`** 是 Unix 慣例。
> 這樣 `todo list > out.txt` 只會拿到待辦清單，不會混進 log。
> 這個小細節決定你的工具能不能被 `grep` / `jq` / 排程腳本使用。

### `todo-cli/src/main/java/com/example/todo/App.java`

```java
package com.example.todo;

import com.example.todo.exception.ErrorCode;
import com.example.todo.exception.TodoException;
import com.example.todo.model.Priority;
import com.example.todo.model.Todo;
import com.example.todo.repository.JsonFileTodoRepository;
import com.example.todo.service.TodoService;
import com.example.todo.support.BuildInfo;
import com.example.todo.support.Json;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.List;
import java.util.Locale;

/**
 * Todo CLI 的進入點。
 *
 * <p>職責只有三件事：
 * <ol>
 *   <li>組裝依賴（第 03 章 3.11 節：手動 DI）</li>
 *   <li>解析命令列參數</li>
 *   <li>把例外轉成離開碼與人看得懂的訊息（第 04 章 4.10 節：最外層統一處理）</li>
 * </ol>
 *
 * <p>業務邏輯一行都不在這裡。這是為了第 02 站——把 main 換成
 * {@code SpringApplication.run()} 時，底下的東西完全不用動。
 */
public final class App {

    private static final Logger log = LoggerFactory.getLogger(App.class);

    /** 離開碼：0 成功、1 使用者錯誤、2 系統錯誤。腳本會依賴這個約定 */
    private static final int EXIT_OK = 0;
    private static final int EXIT_USER_ERROR = 1;
    private static final int EXIT_SYSTEM_ERROR = 2;

    private static final DateTimeFormatter DISPLAY =
            DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm", Locale.TAIWAN);

    private final TodoService service;
    private final ZoneId displayZone;

    App(TodoService service, ZoneId displayZone) {
        this.service = service;
        this.displayZone = displayZone;
    }

    public static void main(String[] args) {
        // ── 這裡是唯一允許呼叫 System.exit 的地方 ──
        int exitCode = new App(buildService(), ZoneId.systemDefault()).run(args);
        System.exit(exitCode);
    }

    // ══════════════════════════════════════════════════════════
    // 組裝
    // ══════════════════════════════════════════════════════════

    private static TodoService buildService() {
        Path dataDir = Path.of(System.getProperty("user.home"), ".todo");
        try {
            Files.createDirectories(dataDir);
        } catch (java.io.IOException e) {
            throw new java.io.UncheckedIOException("無法建立資料目錄 " + dataDir, e);
        }
        Path dataFile = dataDir.resolve("todos.json");

        // 第 07 章：注入 Clock，讓時間可測
        // 第 07、08 章：JSON 檔案儲存 + 執行緒安全
        return new TodoService(
                new JsonFileTodoRepository(dataFile, new Json()),
                Clock.systemDefaultZone());
    }

    // ══════════════════════════════════════════════════════════
    // 分派 + 統一例外處理
    // ══════════════════════════════════════════════════════════

    int run(String[] args) {
        if (args.length == 0 || isHelp(args[0])) {
            printUsage();
            return EXIT_OK;
        }
        if (isVersion(args[0])) {
            System.out.println(BuildInfo.describe());
            return EXIT_OK;
        }

        try {
            return dispatch(args[0], java.util.Arrays.copyOfRange(args, 1, args.length));

        } catch (TodoException e) {
            // 業務例外：使用者看得懂的訊息，不印堆疊（第 04 章 4.10 節）
            System.err.printf("錯誤 [%s] %s%n", e.errorCode().code(), e.getMessage());
            log.debug("業務例外", e);
            return EXIT_USER_ERROR;

        } catch (IllegalArgumentException e) {
            System.err.println("參數錯誤：" + e.getMessage());
            System.err.println("用 todo --help 看說明。");
            return EXIT_USER_ERROR;

        } catch (Exception e) {
            // 意料之外：完整記錄，給使用者一個可以回報的訊息
            log.error("未預期的錯誤", e);
            System.err.println("發生未預期的錯誤，詳情請看 ~/.todo/logs/todo.log");
            System.err.println("版本：" + BuildInfo.describe());
            return EXIT_SYSTEM_ERROR;
        }
    }

    private int dispatch(String command, String[] rest) {
        switch (command) {
            case "add" -> add(rest);
            case "list" -> list(rest);
            case "done" -> done(rest);
            case "remove" -> remove(rest);
            default -> throw new IllegalArgumentException("未知的指令：" + command);
        }
        return EXIT_OK;
    }

    // ══════════════════════════════════════════════════════════
    // 各指令
    // ══════════════════════════════════════════════════════════

    private void add(String[] args) {
        if (args.length == 0) {
            throw new IllegalArgumentException("用法：todo add <標題> [--priority HIGH|MEDIUM|LOW]");
        }
        String title = args[0];
        Priority priority = Priority.MEDIUM;
        for (int i = 1; i < args.length - 1; i++) {
            if ("--priority".equals(args[i])) {
                priority = parsePriority(args[i + 1]);
            }
        }
        Todo created = service.add(title, priority);
        System.out.printf("已新增 #%d %s%n", created.id(), created.title());
    }

    private void list(String[] args) {
        boolean showAll = args.length > 0 && "--all".equals(args[0]);
        List<Todo> todos = showAll ? service.findAll() : service.findPending();

        if (todos.isEmpty()) {
            System.out.println("目前沒有待辦事項。");
            return;
        }
        System.out.printf("%-5s %-8s %-6s %-16s %s%n", "ID", "優先", "狀態", "建立時間", "標題");
        System.out.println("─".repeat(70));
        for (Todo t : todos) {
            System.out.printf("%-5d %-8s %-6s %-16s %s%n",
                    t.id(),
                    t.priority(),
                    t.isDone() ? "完成" : "待辦",
                    DISPLAY.format(t.createdAt().atZone(displayZone)),
                    t.title());
        }
        System.out.printf("%n共 %d 筆%n", todos.size());
    }

    private void done(String[] args) {
        service.markDone(parseId(args, "todo done <id>"));
        System.out.println("已標記完成。");
    }

    private void remove(String[] args) {
        service.remove(parseId(args, "todo remove <id>"));
        System.out.println("已刪除。");
    }

    // ══════════════════════════════════════════════════════════
    // 小工具
    // ══════════════════════════════════════════════════════════

    private static long parseId(String[] args, String usage) {
        if (args.length == 0) {
            throw new IllegalArgumentException("用法：" + usage);
        }
        try {
            return Long.parseLong(args[0]);
        } catch (NumberFormatException e) {
            // 第 04 章：不要把底層例外原封不動往上丟，換成使用者看得懂的訊息
            throw new IllegalArgumentException("id 必須是數字，收到：" + args[0], e);
        }
    }

    private static Priority parsePriority(String raw) {
        try {
            return Priority.valueOf(raw.toUpperCase(Locale.ROOT));
        } catch (IllegalArgumentException e) {
            throw new IllegalArgumentException(
                    "優先度必須是 HIGH / MEDIUM / LOW，收到：" + raw, e);
        }
    }

    private static boolean isHelp(String arg) {
        return "--help".equals(arg) || "-h".equals(arg) || "help".equals(arg);
    }

    private static boolean isVersion(String arg) {
        return "--version".equals(arg) || "-v".equals(arg) || "version".equals(arg);
    }

    private void printUsage() {
        System.out.println("""
                todo — 待辦事項命令列工具

                用法：
                  todo add <標題> [--priority HIGH|MEDIUM|LOW]   新增
                  todo list [--all]                              列出（預設只列未完成）
                  todo done <id>                                 標記完成
                  todo remove <id>                               刪除
                  todo --version                                 顯示版本
                  todo --help                                    顯示說明

                資料位置：~/.todo/todos.json
                日誌位置：~/.todo/logs/todo.log

                環境變數：
                  TODO_LOG_LEVEL   日誌等級（預設 INFO）
                """);
        System.out.println(BuildInfo.describe());
    }
}
```

> 這裡刻意讓 `run(String[])` 是**回傳 `int` 的實例方法**，
> 而 `main` 只負責 `System.exit`。理由：`run()` 可以在測試裡直接呼叫並斷言回傳值
> （第 11 章），而 `System.exit` 在測試裡會把整個 JVM 關掉。
> **「把 `System.exit` 推到最外一層」是可測試 CLI 的關鍵設計。**

### `Makefile`（把常用指令記下來）

```makefile
.PHONY: help build test verify run jar image sbom clean release

MVN := ./mvnw -B -ntp
VERSION := $(shell $(MVN) help:evaluate -Dexpression=project.version -q -DforceStdout)

help:                       ## 顯示所有指令
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
	  | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

build:                      ## 編譯（不打包）
	$(MVN) -T 1C clean compile

test:                       ## 單元測試
	$(MVN) -T 1C test

verify:                     ## 單元 + 整合測試 + 所有檢查
	$(MVN) -T 1C clean verify

jar:                        ## 打成可執行 jar
	$(MVN) -T 1C clean package -Prelease
	@ls -lh todo-cli/target/todo-cli.jar

run: jar                    ## 打包後執行（make run ARGS="add 買牛奶")
	java -jar todo-cli/target/todo-cli.jar $(ARGS)

image: jar                  ## 建 Docker 映像
	docker build -t todo-cli:$(VERSION) -t todo-cli:latest .
	@docker images todo-cli

sbom:                       ## 產生 SBOM 並掃描
	$(MVN) clean package -Prelease
	@test -f target/bom.json && trivy sbom target/bom.json || echo "找不到 target/bom.json"

tree:                       ## 印依賴樹（含衝突）
	$(MVN) dependency:tree -Dverbose

updates:                    ## 檢查有沒有新版依賴
	$(MVN) versions:display-dependency-updates versions:display-plugin-updates

reproducible:               ## 驗證建置是否可重現
	$(MVN) clean package -Prelease -q && cp todo-cli/target/todo-cli.jar /tmp/a.jar
	$(MVN) clean package -Prelease -q && cp todo-cli/target/todo-cli.jar /tmp/b.jar
	@cmp /tmp/a.jar /tmp/b.jar && echo "✅ 可重現" || echo "❌ 有差異"

clean:                      ## 清掉所有產出
	$(MVN) clean
	rm -f /tmp/a.jar /tmp/b.jar
```

> **為什麼用 Makefile 而不是一直打 `mvn` 指令？**
> 因為「這個專案怎麼建、怎麼跑、怎麼發版」這件知識應該進版控。
> 新人 clone 下來打 `make help` 就知道能做什麼——不用問人，不用翻 wiki。
> （這是 10.2 節那句話的具體實踐。）

### 完整驗收流程

```bash
# 1. 從零建置
git clone <repo> && cd todo
./mvnw -B -ntp clean verify
```

```
[INFO] Reactor Summary for Todo 1.0.0-SNAPSHOT:
[INFO]
[INFO] Todo ............................................... SUCCESS [  0.152 s]
[INFO] Todo :: Model ...................................... SUCCESS [  1.744 s]
[INFO] Todo :: Core ....................................... SUCCESS [  3.298 s]
[INFO] Todo :: Importer ................................... SUCCESS [  2.011 s]
[INFO] Todo :: CLI ........................................ SUCCESS [  4.406 s]
[INFO] ------------------------------------------------------------------------
[INFO] BUILD SUCCESS
[INFO] Total time:  11.902 s
```

```bash
# 2. 打包
./mvnw -B -ntp clean package -Prelease
ls -lh todo-cli/target/todo-cli.jar
```

```
-rw-r--r--  1 gary  staff   8.1M Aug 17 18:22 todo-cli/target/todo-cli.jar
```

```bash
# 3. 檢查 jar 的內容
unzip -p todo-cli/target/todo-cli.jar META-INF/MANIFEST.MF
```

```
Manifest-Version: 1.0
Created-By: Maven Shade Plugin 3.6.0
Build-Jdk-Spec: 21
Main-Class: com.example.todo.App
```

```bash
# SPI 有沒有被合併？（漏了的話 log 會完全消失）
unzip -p todo-cli/target/todo-cli.jar META-INF/services/org.slf4j.spi.SLF4JServiceProvider
```

```
ch.qos.logback.classic.spi.LogbackServiceProvider
```

```bash
# 有沒有殘留簽章檔？（有的話 java -jar 會報 Invalid signature file digest）
unzip -l todo-cli/target/todo-cli.jar | grep -cE '\.SF$|\.DSA$|\.RSA$'
```

```
0
```

```bash
# 4. 執行
java -jar todo-cli/target/todo-cli.jar --version
```

```
Todo :: CLI 1.0.0-SNAPSHOT (built 2026-08-17T10:22:41Z)
```

```bash
java -jar todo-cli/target/todo-cli.jar add "寫第 11 章" --priority HIGH
java -jar todo-cli/target/todo-cli.jar add "買牛奶"
java -jar todo-cli/target/todo-cli.jar list
```

```
已新增 #1 寫第 11 章
已新增 #2 買牛奶
ID    優先     狀態   建立時間          標題
──────────────────────────────────────────────────────────────────────
1     HIGH     待辦   2026-08-17 18:23  寫第 11 章
2     MEDIUM   待辦   2026-08-17 18:23  買牛奶

共 2 筆
```

```bash
# 5. 驗證離開碼（腳本會靠這個判斷成功失敗）
java -jar todo-cli/target/todo-cli.jar done 999; echo "exit=$?"
```

```
錯誤 [TODO-404] 找不到 id 為 999 的待辦事項
exit=1
```

```bash
java -jar todo-cli/target/todo-cli.jar frobnicate; echo "exit=$?"
```

```
參數錯誤：未知的指令：frobnicate
用 todo --help 看說明。
exit=1
```

```bash
# 6. 驗證 stdout / stderr 分離（CLI 的基本禮儀）
java -jar todo-cli/target/todo-cli.jar list > /tmp/out.txt 2> /tmp/err.txt
cat /tmp/out.txt        # 只有清單，沒有 log
```

```bash
# 7. 驗證可重現
make reproducible
```

```
✅ 可重現
```

```bash
# 8. 建 Docker 映像
make image
docker run --rm todo-cli:latest --version
```

### 這一章我們得到了什麼

| 能力 | 靠什麼 |
|---|---|
| 一個指令建置全部 | 多模組 + reactor（10.12 節） |
| 架構邊界被編譯器守住 | `todo-model` 的 pom 裡沒有 `todo-cli` |
| 依賴版本全專案一致 | 根 pom 的 `dependencyManagement` + BOM（10.9 節） |
| 版本衝突會讓建置失敗 | enforcer 的 `dependencyConvergence`（10.10 節） |
| 一個檔案就能交付 | shade + `ServicesResourceTransformer`（10.13 節） |
| 程式知道自己是哪一版 | resource filtering + `BuildInfo`（10.6 節） |
| 建置結果可驗證 | `project.build.outputTimestamp`（10.16 節） |
| 知道自己用了什麼、有沒有漏洞 | SBOM + 掃描器（10.17 節） |
| 能進 Docker，且分層合理 | 多階段 Dockerfile（10.14 節） |
| 誰都能建出一樣的東西 | `mvnw` + 鎖死外掛版本 + toolchain |

### 還沒解決的問題（留給後面的章節）

| 問題 | 什麼時候解 |
|---|---|
| `src/test/java` 幾乎是空的，沒有安全網 | **第 11 章**：JUnit 5 + Mockito + AssertJ |
| `Todo` 有 200 行樣板程式碼（getter / equals / hashCode） | **第 12 章**：`record` |
| `dispatch` 的 `switch` 新增指令要改三個地方 | **第 12 章**：`sealed` + 模式比對 |
| 手寫的 CLI 參數解析很脆弱（`--priority` 放在最後就抓不到） | 第 02 站：Spring Boot 的 `ApplicationArguments`，或 picocli |
| `buildService()` 的手動組裝，加一個依賴就要改這裡 | **第 02 站**：Spring 的 IoC 容器 |
| 沒有 HTTP 介面 | 第 03～05 站 |
| 資料存 JSON 檔，並發與查詢都會撐不住 | 第 06～08 站：MySQL + JPA |

---

## 10.19 常見錯誤

| # | 錯誤 | 後果 | 正解 |
|---|------|------|------|
| 1 | 用 `source` + `target` 而不是 `release` | 編譯期不檢查 API 是否存在，部署到舊 JDK 才 `NoSuchMethodError` | `<maven.compiler.release>21</maven.compiler.release>` |
| 2 | 不鎖外掛版本 | 換機器 / 換 Maven 版本，建置行為就變。「在我這邊可以跑」 | `<pluginManagement>` 全部寫死版本，用 `versions:display-plugin-updates` 檢查 |
| 3 | 不設 `project.build.sourceEncoding` | 中文在別人機器上編成亂碼，且是編進 class 的常量，執行期救不回來 | 一律設 `UTF-8` |
| 4 | `java -jar` 時想用 `-cp` 加依賴 | 被完全忽略，還是 `NoClassDefFoundError`，然後你會懷疑人生 | 用 shade / `lib/` + manifest `Class-Path`，或改用 `java -cp ... MainClass` |
| 5 | shade 忘記 `ServicesResourceTransformer` | SPI 註冊檔被覆蓋 → log 全部消失、JDBC 找不到驅動。**只在打包後發生** | 加 transformer，並用 `unzip -p` 驗證 |
| 6 | shade 沒排除 `META-INF/*.SF` | `Invalid signature file digest for Manifest main attributes` | `<filters>` 排除 `.SF` / `.DSA` / `.RSA` |
| 7 | surefire 的 `<argLine>` 直接覆寫 | JaCoCo 的 agent 參數被吃掉，覆蓋率變 0% | 保留 `@{argLine}`（注意是 `@{}` 不是 `${}`） |
| 8 | failsafe 只綁 `integration-test` 不綁 `verify` | 整合測試失敗但建置成功 → 永遠綠燈的 CI，比沒測試更糟 | 兩個 goal 一起綁 |
| 9 | 依賴忘記寫 `test` scope | 產品程式碼 import 得到 JUnit，有人真的用了 → 上線 `NoClassDefFoundError` | 測試依賴一律 `<scope>test</scope>` |
| 10 | JDBC 驅動 / 日誌實作用 `compile` | 程式碼可以直接 import 具體實作，介面隔離失效 | 用 `runtime`，讓編譯器守住邊界 |
| 11 | 靠「先宣告者勝」隱含決定版本 | 有人排序 pom / 合 git 衝突，正式環境就壞了，且沒有任何 Java 改動 | `dependencyManagement` 明確指定 + enforcer 的 `dependencyConvergence` |
| 12 | 父 pom 的 `<dependencies>` 塞太多 | 每個子模組都被迫拿到，`dependency:analyze` 一片紅，攻擊面變大 | 只放真正共用的（`slf4j-api` + 測試框架），其餘進 `dependencyManagement` |
| 13 | `mvn -pl xxx package` 沒加 `-am` | `Could not resolve dependencies ... (absent)` | 加 `-am`；改到別人也用的模組時用 `-amd` |
| 14 | 用 `activeByDefault` 提供預設值 | 啟用任何其他 profile 時它被停用，屬性變成未定義字串 | 預設值寫在 `<properties>`，profile 只負責覆寫 |
| 15 | 用 profile 切換依賴（dev 用 H2、prod 用 Oracle） | CI 測的東西和上線的不一樣 | Build once, deploy many。靠設定切換，不靠建置 |
| 16 | 只 `mvn package` 不 `clean` | 刪掉的類別留在 `target/classes` 被打進 jar，出現 grep 不到的類別 | CI 永遠 `clean`；本機遇到「不可能的錯誤」先 `mvn clean` |
| 17 | CI 上不加 `-B` | Maven 可能等待互動輸入，job 卡到 timeout | `-B -ntp` 是 CI 的標配 |
| 18 | 打包後才發現讀不到 resource | 在 IDE 裡 `getResource(...).getPath()` 能跑，jar 裡的資源不是檔案 | 一律用 `getResourceAsStream()`，不要轉 `Path` / `File` |
| 19 | 對 `.png` / `.jks` 開 resource filtering | 二進位檔被編碼轉換破壞 | 用 `<includes>` 精確指定要過濾的檔案 |
| 20 | `settings.xml` commit 進版控 | Nexus 憑證進 git 歷史，刪不掉，只能改密碼 | 用 `${env.XXX}` 或 `mvn --encrypt-password`；CI 用 secret |
| 21 | 在 `pom.xml` 裡加 `<repositories>` | 每個使用你模組的人都會去查那個倉庫，是 dependency confusion 的入口 | 倉庫設定屬於 `settings.xml` 的 `<mirror>` |
| 22 | 遷移 Maven → Gradle 時直接照搬版本 | Maven 選最近者、Gradle 選最高版本，classpath 不同 → 莫名其妙壞掉 | 遷移後比對 `dependency:list` 與 `./gradlew dependencies` |
| 23 | `Dockerfile` 用 shell 形式的 `ENTRYPOINT` | `/bin/sh` 是 PID 1，`SIGTERM` 不會傳給 java，graceful shutdown 失效 | 用 exec 形式，或 `sh -c "exec java ..."` |
| 24 | 沒有 `.dockerignore` | 整個 `target/`（含 heap dump、log）進 build context，甚至進映像 | 建專案第一天就寫 |
| 25 | 同時放 `log4j-over-slf4j` 和 `slf4j-log4j12` | 兩座橋方向相反 → 無限遞迴 → `StackOverflowError` | 同一個方向只能有一座橋 |
| 26 | 用 `rm -rf ~/.m2/repository` 解決 `.lastUpdated` 問題 | 重抓幾 GB，手動 install 的東西一起消失 | `mvn -U`，或 `find ~/.m2 -name "*.lastUpdated" -delete` |

---

## 10.20 本章練習

### 練習 1：算出最終版本

給定以下依賴關係，回答 ①～③ 每題最終 classpath 上是哪個 `guava` 版本。

**情境 ①**

```
my-app
├── lib-a:1.0
│   └── guava:31.1-jre
└── lib-b:2.0
    └── util-c:5.0
        └── guava:33.3.0-jre
```

**情境 ②**（`my-app` 的 `<dependencies>` 順序如下）

```
my-app
├── lib-a:1.0          （先宣告）
│   └── guava:31.1-jre
└── lib-b:2.0          （後宣告）
    └── guava:33.3.0-jre
```

**情境 ③**（同情境 ②，但 `my-app` 的父 pom 有這段）

```xml
<dependencyManagement>
  <dependencies>
    <dependency>
      <groupId>com.google.guava</groupId>
      <artifactId>guava</artifactId>
      <version>32.1.3-jre</version>
    </dependency>
  </dependencies>
</dependencyManagement>
```

再回答：④ 情境 ② 有什麼實務風險？⑤ 怎麼讓這三種情況都不會安靜地發生？

<details>
<summary>參考解答</summary>

**① `31.1-jre`。**

「最近者優先」：`31.1-jre` 在深度 2，`33.3.0-jre` 在深度 3。深度小的贏。

⚠️ 注意這裡選中的是**較舊**的版本。如果 `lib-b` 需要 `guava` 33.x 才有的 API，
執行期就會 `NoSuchMethodError`——而且編譯完全正常，因為 `lib-b` 是編譯好的 jar。

**② `31.1-jre`。**

兩個都在深度 2，平手。「先宣告者勝」——`lib-a` 在 `<dependencies>` 裡寫在前面。

**③ `32.1.3-jre`。**

`dependencyManagement` 的優先權**高於**最近者優先與宣告順序。
它在依賴解析的最後階段強制套用，會覆寫掉樹上算出來的任何版本。

這也是多模組專案「我明明在子模組寫了 33.3，為什麼跑起來是 32.1」的答案。
排查指令：

```bash
mvn help:effective-pom | grep -A3 guava     # 看 dependencyManagement 最終長什麼樣
mvn dependency:tree -Dverbose -Dincludes=com.google.guava:guava
```

**④ 情境 ② 的實務風險：版本由「宣告順序」決定。**

只要有人做了以下任一件事，正式環境的行為就變了，而 git diff 裡**沒有任何 Java 程式碼改動**：

- 為了「整齊」把 `<dependencies>` 依字母排序
- IDE 的「整理 pom」功能
- 合併 git 衝突時順序被改掉
- 新增一個依賴時插在中間

這種 bug 極難追查，因為 code review 時沒人覺得「調整順序」需要審。

**⑤ 讓它們不能安靜發生：**

```xml
<!-- 1. 在（父）pom 明確指定版本，並寫下理由 -->
<dependencyManagement>
  <dependencies>
    <!-- lib-a 要 31.x、lib-b 要 33.x。選 33.3.0-jre 因為
         lib-b 用到 33.x 的 Collectors API。lib-a 在 33 上實測相容。
         等 lib-a 升版後可移除此項。 -->
    <dependency>
      <groupId>com.google.guava</groupId>
      <artifactId>guava</artifactId>
      <version>33.3.0-jre</version>
    </dependency>
  </dependencies>
</dependencyManagement>
```

```xml
<!-- 2. 讓「未處理的衝突」變成建置失敗 -->
<plugin>
  <groupId>org.apache.maven.plugins</groupId>
  <artifactId>maven-enforcer-plugin</artifactId>
  <version>3.5.0</version>
  <executions>
    <execution>
      <id>enforce-convergence</id>
      <phase>validate</phase>
      <goals><goal>enforce</goal></goals>
      <configuration>
        <rules>
          <dependencyConvergence/>
        </rules>
      </configuration>
    </execution>
  </executions>
</plugin>
```

加上 `dependencyConvergence` 之後，情境 ①②③ 全部會在 `validate` 階段
就讓建置失敗，並印出兩條完整路徑。你被迫做出**明確的決定**，
而不是接受 Maven 幫你隨便選一個。

</details>

---

### 練習 2：打包後 log 全部消失

你的專案在 IDE 裡跑得很好，log 正常輸出。打成 shade uber-jar 之後：

```bash
java -jar target/app.jar
```

```
SLF4J(W): No SLF4J providers were found.
SLF4J(W): Defaulting to no-operation (NOP) logger implementation
SLF4J(W): See https://www.slf4j.org/codes.html#noProviders for further details.
```

程式功能正常，但**一行 log 都沒有**。

① 為什麼在 IDE 裡正常、打包後就壞？
② 用什麼指令確認你的診斷？
③ 怎麼修？
④ 同樣的機制還會影響哪些常見的東西？

<details>
<summary>參考解答</summary>

**① 原因：SPI 註冊檔在打包時被覆蓋了。**

SLF4J 2.x 用 Java 的 `ServiceLoader` 機制尋找日誌實作。
`logback-classic.jar` 裡有一個檔案：

```
META-INF/services/org.slf4j.spi.SLF4JServiceProvider
  內容：ch.qos.logback.classic.spi.LogbackServiceProvider
```

**在 IDE 裡**，classpath 上是幾十個獨立的 jar。`ServiceLoader` 會用
`getResources()`（複數）掃過**每一個** jar 的同名檔案，全部都找得到。

**打成 uber-jar 時**，shade 把所有 jar 解開合併成一包。
`META-INF/services/org.slf4j.spi.SLF4JServiceProvider` 這個路徑
在多個來源 jar 裡都存在 → 只能留一份 → **其他的被覆蓋掉**。
如果留下來的那份不是 logback 的（或整個被別的 jar 的空檔案蓋掉），provider 就消失了。

**② 確認指令：**

```bash
# 打包後的 jar 裡，這個檔案的內容是什麼？
unzip -p target/app.jar META-INF/services/org.slf4j.spi.SLF4JServiceProvider
```

沒有輸出 → 檔案不存在（被整個丟掉）。
有輸出但不是 `ch.qos.logback.classic.spi.LogbackServiceProvider` → 被別的蓋掉了。

```bash
# 原始的 logback jar 裡確實有嗎？（確認不是依賴本身的問題）
unzip -p ~/.m2/repository/ch/qos/logback/logback-classic/1.5.8/logback-classic-1.5.8.jar \
  META-INF/services/org.slf4j.spi.SLF4JServiceProvider

# 列出 jar 裡所有 SPI 檔案，看少了哪些
unzip -l target/app.jar | grep "META-INF/services/"

# 確認 logback 的 class 有進去（排除「依賴根本沒打進來」的可能）
unzip -l target/app.jar | grep LogbackServiceProvider
```

**③ 修法：加 `ServicesResourceTransformer`。**

```xml
<plugin>
  <groupId>org.apache.maven.plugins</groupId>
  <artifactId>maven-shade-plugin</artifactId>
  <version>3.6.0</version>
  <executions>
    <execution>
      <phase>package</phase>
      <goals><goal>shade</goal></goals>
      <configuration>
        <transformers>
          <transformer implementation="org.apache.maven.plugins.shade.resource.ManifestResourceTransformer">
            <mainClass>com.example.todo.App</mainClass>
          </transformer>
          <!-- ★ 這一行：把所有 META-INF/services/* 同名檔案「附加合併」而不是覆蓋 -->
          <transformer implementation="org.apache.maven.plugins.shade.resource.ServicesResourceTransformer"/>
        </transformers>
      </configuration>
    </execution>
  </executions>
</plugin>
```

修完再驗一次：

```bash
mvn clean package
unzip -p target/app.jar META-INF/services/org.slf4j.spi.SLF4JServiceProvider
# → ch.qos.logback.classic.spi.LogbackServiceProvider  ✅
java -jar target/app.jar        # log 回來了
```

**④ 同樣機制影響的其他東西**（全部都是 `ServiceLoader` / SPI）：

| 受影響的東西 | SPI 檔案 | 壞掉的症狀 |
|---|---|---|
| JDBC 驅動 | `java.sql.Driver` | `No suitable driver found for jdbc:...` |
| Jackson 模組自動註冊 | `com.fasterxml.jackson.databind.Module` | `findAndRegisterModules()` 找不到 `JavaTimeModule` → `Instant` 序列化失敗（第 07 章 7.17 節） |
| JAXB / Jakarta XML | `javax.xml.bind.JAXBContextFactory` | `Implementation of JAXB-API has not been found` |
| Bean Validation | `jakarta.validation.spi.ValidationProvider` | `Unable to create a Configuration` |
| Spring Boot 自動配置（3.x） | `META-INF/spring/*.imports` | Bean 莫名其妙不存在（**這個 shade 不會合併，要用 `AppendingTransformer`**） |
| Netty 的原生傳輸 | `META-INF/native-image/...` | 退回 NIO，效能下降但不報錯（最難發現） |

> **一般化的結論**：任何靠「掃描 classpath 上所有同名檔案」運作的機制，
> 在 uber-jar 裡都可能壞掉。**這也是 10.13 節說「Spring Boot 的嵌套 jar
> 設計更好」的核心理由**——它讓每個 jar 保持獨立，`getResources()` 照樣掃得到全部。
>
> 而最可怕的部分是：**這類問題全部只在打包後出現。** 你的測試（在 IDE / surefire
> 的多 jar classpath 上跑）100% 通過。所以 CI 上一定要有一步
> 「**打包後執行 smoke test**」，例如 `java -jar target/app.jar --version`。
> 這一行指令能攔下這整類 bug。

</details>

---

### 練習 3：診斷五個建置錯誤

以下每個錯誤，說出①最可能的原因②診斷指令③修法。

```
A) [ERROR] Failed to execute goal ... Could not resolve dependencies for
   project com.example:todo-cli:jar:1.0.0-SNAPSHOT: The following artifacts
   could not be resolved: com.example:todo-core:jar:1.0.0-SNAPSHOT (absent)

B) [ERROR] Source option 8 is no longer supported. Use 8 or later.

C) 建置成功，但 JaCoCo 報告顯示覆蓋率 0%，而測試明明有跑而且通過

D) java.lang.NoSuchMethodError: 'java.util.List com.google.common.collect.ImmutableList.of(...)'
   （只在正式環境出現，本機和 CI 都正常）

E) [ERROR] Failure to find com.example:internal-lib:jar:2.1.0 in
   https://repo.maven.apache.org/maven2 was cached in the local repository,
   resolution will not be reattempted until the update interval of central
   has elapsed or updates are forced
```

<details>
<summary>參考解答</summary>

**A) `-pl` 沒配 `-am`**

- **原因**：你跑了 `mvn -pl todo-cli package`。reactor 裡只有 `todo-cli`，
  Maven 找不到 `todo-core` 就去本機倉庫找，但你從沒 `install` 過它。
- **診斷**：
  ```bash
  # 確認本機倉庫真的沒有
  ls ~/.m2/repository/com/example/todo-core/1.0.0-SNAPSHOT/ 2>/dev/null || echo "沒有"
  # 看 reactor 裡有哪些模組
  mvn -pl todo-cli validate | grep "Reactor Build Order" -A 10
  ```
- **修法**：
  ```bash
  mvn -pl todo-cli -am package     # 連依賴的模組一起建
  # 或先把全部裝進本機倉庫（之後就能單獨建 todo-cli）
  mvn install -DskipTests
  ```

**B) `release`/`source` 設得比 JDK 支援的還舊**

- **原因**：你用 JDK 21 或更新的版本，但 pom 裡寫 `<source>8</source>`。
  JDK 21 移除了對 `source 7` 的支援，JDK 25 移除了 `source 8`
  （每個大版本會逐步淘汰最舊的目標）。
- **診斷**：
  ```bash
  mvn -v                                                    # 看 Maven 用的是哪個 JDK
  mvn help:evaluate -Dexpression=maven.compiler.release -q -DforceStdout
  mvn help:effective-pom | grep -E "<source>|<target>|<release>"
  ```
- **修法**：升級目標版本（正解），或用舊 JDK 建置：
  ```xml
  <properties>
    <maven.compiler.release>21</maven.compiler.release>
  </properties>
  ```
  真的必須產出舊 bytecode 又想用新 JDK，用 toolchain：
  ```xml
  <plugin>
    <artifactId>maven-toolchains-plugin</artifactId>
    <version>3.2.0</version>
    <!-- 搭配 ~/.m2/toolchains.xml 指定實體 JDK 8 的位置 -->
  </plugin>
  ```

**C) surefire 的 `<argLine>` 覆寫掉 JaCoCo 的 agent**

- **原因**：JaCoCo 的 `prepare-agent` goal 會把 `-javaagent:...jacocoagent.jar=...`
  塞進 `${argLine}` 這個 property。你在 surefire 寫 `<argLine>-Xmx1g</argLine>`
  就把它整個覆蓋掉了 → agent 沒載入 → 沒有任何覆蓋率資料。
- **診斷**：
  ```bash
  # 看 surefire 實際用了什麼 JVM 參數（搜 argLine 或 forkedProcessExitTimeout 附近）
  mvn test -X | grep -i "argline\|javaagent"
  # 有沒有產生執行資料？
  ls -la target/jacoco.exec
  ```
  `target/jacoco.exec` 不存在或是 0 bytes → 確認是 agent 沒載入。
- **修法**：保留 `@{argLine}`（`@{}` 是 surefire 的延遲求值，`${}` 在建置早期就被求值了，
  那時 JaCoCo 還沒設定）：
  ```xml
  <plugin>
    <groupId>org.apache.maven.plugins</groupId>
    <artifactId>maven-surefire-plugin</artifactId>
    <version>3.5.0</version>
    <configuration>
      <argLine>@{argLine} -Xmx1g -Duser.timezone=Asia/Taipei</argLine>
    </configuration>
  </plugin>
  ```
  更保險的做法是給 JaCoCo 一個專屬的 property 名，避免撞名：
  ```xml
  <plugin>
    <groupId>org.jacoco</groupId>
    <artifactId>jacoco-maven-plugin</artifactId>
    <version>0.8.12</version>
    <configuration>
      <propertyName>jacocoArgLine</propertyName>
    </configuration>
    <!-- executions 略 -->
  </plugin>
  <!-- 然後 surefire 寫 <argLine>${jacocoArgLine} -Xmx1g</argLine> -->
  ```

**D) 正式環境的 classpath 和建置時不同**

- **原因**：`NoSuchMethodError` 表示「編譯時看到的類別」和「執行時載入的類別」
  是同一個名字但不同版本（第 09 章 9.6 節）。「本機正常、正式環境炸」表示
  **正式環境的 classpath 上有另一個版本的 Guava**。三個常見來源：
  1. 部署用的 `lib/` 目錄有殘留的舊 jar（上一版留下的，沒清乾淨）
  2. 應用伺服器（Tomcat / WebLogic）自己的 `lib/` 有 Guava，且 ClassLoader 順序讓它先被載入
  3. 部署的不是 uber-jar，而是靠一個手寫的啟動腳本組 classpath，而那個腳本沒同步更新
- **診斷**：
  ```bash
  # 建置端：確認 Maven 選了哪一版
  mvn dependency:tree -Dverbose -Dincludes=com.google.guava:guava

  # 正式環境：問 JVM 自己「你從哪載入這個類別」（最可靠的一招）
  jcmd <pid> VM.system_properties | grep java.class.path
  # 或直接寫一行程式印出來
  # System.out.println(ImmutableList.class.getProtectionDomain().getCodeSource().getLocation());

  # 正式環境：找出所有含 guava 的檔案
  find /opt/app -name "*guava*"
  jcmd <pid> GC.class_histogram | grep -i guava     # 確認類別真的被載入
  ```
- **修法**：
  1. 部署前**清空**目標目錄（不要用「覆蓋」的部署方式）——這是根本原因最常見的一個
  2. 用 uber-jar 或容器映像，讓 classpath 不由部署環境決定
  3. 應用伺服器衝突用 `provided` scope + 確認 ClassLoader 委派順序
  4. **長期修法**：把「打包後 smoke test」放進部署流程

**E) 找不到內部套件，而且失敗被快取了**

- **原因**：`internal-lib:2.1.0` 是公司內部套件，不在 Maven Central。
  兩種可能：① 你的 `settings.xml` 沒設公司倉庫（或 mirror 設錯）
  ② 那個版本根本還沒發佈。而且 Maven 把「找不到」快取成 `.lastUpdated` 檔了。
- **診斷**：
  ```bash
  # 我的倉庫設定是什麼？
  mvn help:effective-settings | grep -A5 -i "mirror\|repository"

  # 本機倉庫留下了什麼？
  ls -la ~/.m2/repository/com/example/internal-lib/2.1.0/
  cat ~/.m2/repository/com/example/internal-lib/2.1.0/*.lastUpdated

  # 公司倉庫上到底有沒有這一版？
  curl -sI https://nexus.example.com/repository/maven-releases/com/example/internal-lib/2.1.0/internal-lib-2.1.0.pom
  ```
- **修法**：
  ```bash
  # 1. 倉庫設定沒問題，只是被快取了失敗紀錄
  mvn -U clean package

  # 2. 清掉失敗紀錄（比刪整個 ~/.m2 溫和）
  find ~/.m2/repository -name "*.lastUpdated" -delete

  # 3. 沒設公司倉庫 → 在 ~/.m2/settings.xml 加 mirror（10.3 節）

  # 4. 那一版真的還沒發佈 → 請對方發佈，或先用它的 SNAPSHOT，
  #    或在本機 install
  ```
  ⚠️ **不要 `rm -rf ~/.m2/repository`**——要重抓幾 GB，
  而且手動 `install` 進去的東西會一起消失。

</details>

---

### 練習 4：設計一個模組拆分

一個電商後端目前是單一 Maven 模組，`src/main/java` 下有這些套件：

```
com.shop.model          （Order、Product、Customer…純資料）
com.shop.repository     （介面 + JDBC 實作）
com.shop.service        （業務邏輯）
com.shop.web            （HTTP controller）
com.shop.batch          （每晚跑的對帳批次，有自己的 main）
com.shop.admin          （內部管理後台，另一個 web 服務）
com.shop.util           （StringHelper、DateHelper…）
```

需求：
- Web 服務、批次、管理後台要**分別部署**（三個不同的容器）
- `batch` 和 `admin` 都需要 `service` 與 `repository`
- `admin` 不該碰到 `web` 的東西
- 三個交付物的版本要一起走

問題：① 畫出模組結構與依賴方向 ② 寫出根 pom 的 `<modules>` 與
`dependencyManagement` 骨架 ③ 每個模組的關鍵依賴與 scope
④ `com.shop.util` 怎麼處理 ⑤ 這樣拆之後，CI 怎麼只建改動到的部分

<details>
<summary>參考解答</summary>

**① 模組結構**

```
shop/                          （根：aggregator + parent，packaging=pom）
├── shop-model                 （純資料型別，零業務依賴）
├── shop-core                  （repository 介面 + 實作 + service + util）
├── shop-web        ← 交付物 1（HTTP API）
├── shop-batch      ← 交付物 2（對帳批次）
└── shop-admin      ← 交付物 3（管理後台）
```

依賴方向：

```
                    ┌──────────────┐
                    │  shop-model  │  （最底層，誰都可以依賴它）
                    └──────▲───────┘
                           │
                    ┌──────┴───────┐
                    │  shop-core   │  （repository + service + util）
                    └──▲────▲───▲──┘
                       │    │   │
          ┌────────────┘    │   └────────────┐
   ┌──────┴─────┐   ┌───────┴──────┐  ┌──────┴──────┐
   │  shop-web  │   │  shop-batch  │  │ shop-admin  │
   └────────────┘   └──────────────┘  └─────────────┘
        （三個交付物互不依賴——這正是需求「admin 不該碰到 web」的實現）
```

**關鍵**：`shop-admin` 的 pom 裡**沒有** `shop-web` 依賴。
「不該碰到」從一句口頭約定，變成**編譯錯誤**。這是拆模組最大的價值。

> 要不要把 `repository` 和 `service` 再拆開？
> **一開始不要。** 三個交付物都同時需要它們，拆開只會增加維護成本
> 而沒有實際隔離效果。等到出現「只需要 repository 不需要 service」的
> 使用者時再拆——**模組邊界應該由實際的使用差異驅動，不是由套件名驅動。**

**② 根 pom 骨架**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0
                             https://maven.apache.org/xsd/maven-4.0.0.xsd">
  <modelVersion>4.0.0</modelVersion>

  <groupId>com.shop</groupId>
  <artifactId>shop</artifactId>
  <version>2.4.0-SNAPSHOT</version>
  <packaging>pom</packaging>

  <!-- 依字母排序就好，reactor 會自己算出正確順序 -->
  <modules>
    <module>shop-admin</module>
    <module>shop-batch</module>
    <module>shop-core</module>
    <module>shop-model</module>
    <module>shop-web</module>
  </modules>

  <properties>
    <maven.compiler.release>21</maven.compiler.release>
    <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
    <project.build.outputTimestamp>2026-08-17T00:00:00Z</project.build.outputTimestamp>
    <spring-boot.version>3.3.4</spring-boot.version>
  </properties>

  <dependencyManagement>
    <dependencies>
      <!-- 自家模組：用 ${project.version} 保證三個交付物版本一起走（需求 4） -->
      <dependency>
        <groupId>com.shop</groupId>
        <artifactId>shop-model</artifactId>
        <version>${project.version}</version>
      </dependency>
      <dependency>
        <groupId>com.shop</groupId>
        <artifactId>shop-core</artifactId>
        <version>${project.version}</version>
      </dependency>

      <!-- 第三方一律靠 BOM -->
      <dependency>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-dependencies</artifactId>
        <version>${spring-boot.version}</version>
        <type>pom</type>
        <scope>import</scope>
      </dependency>
    </dependencies>
  </dependencyManagement>

  <!-- 只放真正「每個模組都要」的（10.9 節） -->
  <dependencies>
    <dependency>
      <groupId>org.slf4j</groupId>
      <artifactId>slf4j-api</artifactId>
    </dependency>
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-test</artifactId>
      <scope>test</scope>
    </dependency>
  </dependencies>

  <build>
    <pluginManagement>
      <plugins>
        <!-- 所有外掛版本鎖在這裡（10.10 節） -->
      </plugins>
    </pluginManagement>
    <plugins>
      <!-- enforcer：dependencyConvergence + requireJavaVersion（10.10 節） -->
    </plugins>
  </build>
</project>
```

**③ 各模組的關鍵依賴**

| 模組 | packaging | 主要依賴 | scope | 備註 |
|---|---|---|---|---|
| `shop-model` | jar | `jackson-annotations` | compile | **不依賴任何自家模組**。保持零業務依賴，這樣它才能被任何人安全引用 |
| `shop-core` | jar | `shop-model` | compile | |
| | | `spring-jdbc` / `spring-tx` | compile | 不要 `spring-boot-starter-web`——core 不該知道 HTTP 存在 |
| | | `postgresql` | **runtime** | 10.7 節：讓編譯器擋住 `import org.postgresql.*` |
| | | `h2` | **test** | 測試用（更好的做法是 Testcontainers，第 11 章） |
| `shop-web` | jar | `shop-core` | compile | |
| | | `spring-boot-starter-web` | compile | |
| | | `spring-boot-starter-validation` | compile | |
| `shop-batch` | jar | `shop-core` | compile | |
| | | `spring-boot-starter`（**不含 web**） | compile | 批次不需要開 HTTP port |
| `shop-admin` | jar | `shop-core` | compile | |
| | | `spring-boot-starter-web` | compile | |
| | | `spring-boot-starter-security` | compile | 管理後台需要，一般 API 不需要 |

三個交付物模組各自加 `spring-boot-maven-plugin` 的 `repackage`（10.13 節做法三）。

**④ `com.shop.util` 怎麼處理**

**不要建一個 `shop-util` 模組。** 三個理由：

1. **它會變成垃圾桶。** 名字叫 util 的模組，最後會裝進所有「不知道放哪」的東西，
   然後開始依賴一堆奇怪的函式庫，最後每個模組都被迫拿到那些依賴。
2. **它沒有內聚性。** `StringHelper` 和 `DateHelper` 之間沒有任何關係，
   把它們放同一個模組只是因為「都是工具」——這不是模組化的理由。
3. **多一個模組就多一份 pom、多一次建置、多一個版本要管。**

**建議做法**：先檢查這些 util 是不是根本不需要存在。
第 01～09 章講過的東西，大部分「util」都能刪掉：

| 常見的 util | 現代 Java 的取代 |
|---|---|
| `StringHelper.isEmpty(s)` | `s == null \|\| s.isBlank()`（第 07 章） |
| `DateHelper.format(date)` | `DateTimeFormatter`（第 07 章 7.11 節） |
| `ListHelper.newList()` | `List.of()` / `new ArrayList<>()`（第 05 章） |
| `JsonHelper.toJson(o)` | 一個共用的 `ObjectMapper` 單例（第 07 章 7.17 節） |
| `NumberHelper.round(d, 2)` | `BigDecimal.setScale()`（第 01 章） |

真正刪不掉的（有業務語意的，例如「台灣統一編號驗證」、「發票號碼格式化」）：
放進 `shop-core` 的對應套件，或跟著它服務的領域物件放進 `shop-model`。
`TaxIdValidator` 屬於「稅務」這個領域，不屬於「工具」這個分類。

**⑤ CI 只建改動的部分**

```bash
# 1. 找出這次 push 改了哪些模組
CHANGED=$(git diff --name-only origin/main...HEAD \
          | grep -oE '^shop-[a-z]+' | sort -u | paste -sd, -)

if [ -z "$CHANGED" ]; then
  # 只改了根 pom 或 CI 設定 → 全建
  ./mvnw -B -ntp -T 1C clean verify
else
  # -amd：連「依賴我」的模組一起建（改 core 就要驗證三個交付物都沒壞）
  ./mvnw -B -ntp -T 1C clean verify -pl "$CHANGED" -amd
fi
```

`-amd`（also-make-dependents）是這裡的關鍵：
改了 `shop-core`，`web` / `batch` / `admin` 都必須重新測試——
否則你可能改壞了 `admin` 而 CI 完全沒發現。

> ⚠️ **這個最佳化有風險，要誠實面對**：
> - 改了根 pom（版本、`dependencyManagement`）會影響全部 → 上面的 `if` 分支處理了
> - 改了 `.mvn/`、`Dockerfile`、CI 設定 → 也該全建
> - **`main` 分支的 merge commit 一定要全建**（`-T 1C clean verify` 不加 `-pl`），
>   否則某次跳過的模組壞了，你要花很久才發現
>
> 換句話說：**PR 上可以只建改動的部分（快速回饋），
> merge 到主幹一定要全建（正確性保證）。** 兩者不可互相取代。
>
> 如果嫌這套 shell 太脆弱，這正是 Gradle 的 build cache（10.15 節）
> 或 Maven Build Cache Extension 的用武之地——讓工具自己判斷什麼沒變，
> 而不是用 git diff 猜。

</details>

---

### 練習 5：`java -jar` 的 classpath 之謎

你有一個 jar 和它的依賴：

```
dist/
├── app.jar          （manifest 有 Main-Class: com.example.App，沒有 Class-Path）
└── lib/
    └── gson-2.11.0.jar
```

以下四個指令，哪些能成功？為什麼？

```bash
# A
java -jar dist/app.jar

# B
java -cp "dist/app.jar:dist/lib/gson-2.11.0.jar" -jar dist/app.jar

# C
export CLASSPATH="dist/lib/gson-2.11.0.jar"
java -jar dist/app.jar

# D
java -cp "dist/app.jar:dist/lib/*" com.example.App
```

追問：⑤ 如果要保留 `java -jar` 的用法，有哪兩種修法？

<details>
<summary>參考解答</summary>

**A) ❌ 失敗**

```
Exception in thread "main" java.lang.NoClassDefFoundError: com/google/gson/Gson
```

classpath 只有 `app.jar` 本身（`-jar` 隱含把該 jar 設為唯一的 classpath 項目），
manifest 又沒有 `Class-Path`，所以 Gson 不在 classpath 上。

**B) ❌ 失敗，錯誤訊息和 A 完全一樣**

這是本章最重要的陷阱：

> **使用 `-jar` 時，`-cp` / `-classpath` 會被完全忽略。**

`java` 的文件寫得很明白：
「When you use the -jar option, the specified JAR file is the source of all user
classes, and other class path settings are ignored.」

這不是 bug，是規格。設計意圖是「`-jar` 代表這個 jar 自我描述了完整的執行環境」。

**最惡毒的地方**：**沒有任何警告**。你以為 `-cp` 生效了，
錯誤訊息和沒加 `-cp` 時一模一樣，於是你開始懷疑路徑打錯、jar 壞了、Gson 版本不對——
往完全錯誤的方向查半小時。

**C) ❌ 失敗，同樣的錯誤**

`CLASSPATH` 環境變數的優先度比 `-cp` 更低。`-jar` 一樣忽略它。

**D) ✅ 成功**

不用 `-jar`，改用 `-cp` + 明確的主類別名。這時 `-cp` 完全生效。

注意 `dist/lib/*` 這個寫法：

- 這是 **JVM 自己支援的萬用字元**（Java 6+），會展開成該目錄下**所有** `.jar`。
- **不要**加引號之外的東西，也**不要**寫成 `dist/lib/*.jar`
  （那是 shell 的萬用字元，展開後用 `:` 分隔會壞掉，而且 shell 會依當前目錄展開）。
- 要用引號包起來，避免 shell 先動手展開。
- ⚠️ 展開**順序未定義**（依檔案系統而定）。所以如果 `lib/` 裡有兩個版本的同一個
  函式庫，行為在不同機器上可能不同（10.2 節的 jar hell）。**這也是為什麼
  `lib/` 目錄裡絕對不能有殘留的舊 jar。**
- ⚠️ 它**不遞迴**。`lib/sub/x.jar` 不會被納入。

**⑤ 兩種修法（保留 `java -jar`）**

**修法一：在 manifest 寫 `Class-Path`**（做法一，10.13 節）

```xml
<plugin>
  <groupId>org.apache.maven.plugins</groupId>
  <artifactId>maven-jar-plugin</artifactId>
  <version>3.4.2</version>
  <configuration>
    <archive>
      <manifest>
        <mainClass>com.example.App</mainClass>
        <addClasspath>true</addClasspath>
        <classpathPrefix>lib/</classpathPrefix>
      </manifest>
    </archive>
  </configuration>
</plugin>
```

產生的 manifest：

```
Main-Class: com.example.App
Class-Path: lib/gson-2.11.0.jar
```

驗證：

```bash
unzip -p dist/app.jar META-INF/MANIFEST.MF
java -jar dist/app.jar        # ✅ 可以了
```

⚠️ **`Class-Path` 的三個規則**：
① 路徑是**相對於 jar 檔本身的位置**，不是相對於當前工作目錄——
所以 `cd /` 後 `java -jar /path/to/app.jar` 依然能工作。
② 不支援萬用字元，必須逐個列出（所以要靠 `addClasspath` 自動產生）。
③ 值太長時 manifest 會折行（每行最多 72 bytes），續行**必須**以一個空格開頭——
手動編輯 manifest 的人常在這裡出錯。

**修法二：打成 uber-jar**（做法二，10.13 節）

```bash
mvn clean package        # 有設 shade
java -jar target/app.jar # ✅ 依賴都在裡面了
```

**如果不需要 `java -jar`**，其實還有第三個選項——用啟動腳本包起來 D 的做法：

```bash
#!/usr/bin/env bash
# dist/bin/app
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec java ${JAVA_OPTS:-} -cp "$HERE/app.jar:$HERE/lib/*" com.example.App "$@"
```

Gradle 的 `application` plugin 產生的 `installDist` 就是這種腳本（10.15 節），
Maven 這邊可以用 `appassembler-maven-plugin` 或 `maven-assembly-plugin` 產生。

**這也是為什麼很多 Java 工具（Maven 自己、Gradle、Elasticsearch）
都是「一個 shell 腳本 + 一堆 jar」而不是單一 uber-jar**——
腳本能做 uber-jar 做不到的事：讀環境變數、算 `JAVA_OPTS`、
檢查 JDK 版本、依情境決定 classpath。看看 `mvnw` 的內容就知道了。

</details>

---

### 練習 6：`source/target` 的線上事故

一個團隊的 pom 是這樣：

```xml
<properties>
  <maven.compiler.source>17</maven.compiler.source>
  <maven.compiler.target>17</maven.compiler.target>
</properties>
```

開發者本機裝的是 JDK 21，正式環境的容器是 JDK 17。

某天有人寫了這段程式碼並成功合併、成功建置、成功通過所有測試：

```java
public List<String> topThree(List<String> all) {
    return all.stream()
              .sorted()
              .limit(3)
              .toList();
}

public String summarize(Map<String, Integer> counts) {
    return counts.entrySet().stream()
                 .map(e -> e.getKey() + "=" + e.getValue())
                 .collect(Collectors.joining(", "));
}

public boolean isValidRange(String raw) {
    // Java 21 的 String 新方法
    String[] parts = raw.splitWithDelimiters("-", 2);
    return parts.length >= 2;
}
```

上線後，`isValidRange` 一被呼叫就炸。

① 為什麼編譯期沒攔下來？② 錯誤訊息會是什麼？③ 為什麼測試沒抓到？
④ 一行改動怎麼徹底解決？⑤ 改完之後會發生什麼？

<details>
<summary>參考解答</summary>

**① 為什麼編譯期沒攔下來**

`source` / `target` 只做兩件事：

- `source=17`：用 **Java 17 的語法規則**檢查（所以你不能用 Java 21 才有的語法，
  例如未預覽開啟的 pattern matching）。
- `target=17`：產生 **class 檔版本 61**（Java 17）的 bytecode。

**它們都不管「這個方法在 Java 17 存不存在」。**
API 檢查用的是 `javac` 執行時所在的那個 JDK 的 `java.base` 模組——
也就是**開發者本機的 JDK 21**。

`String.splitWithDelimiters(String, int)` 是 Java 21 新增的方法。
JDK 21 的 `String` 有它 → 編譯通過 → bytecode 裡留下一個
指向 `java/lang/String.splitWithDelimiters` 的方法引用，class 版本標成 61。

`topThree` 和 `summarize` 沒問題：`Stream.toList()` 是 Java 16 加的，
`Collectors.joining` 更早就有。**這就是這個 bug 難發現的原因——
99% 的程式碼確實安全，只有偶爾用到新 API 的那一行是地雷。**

**② 錯誤訊息**

```
Exception in thread "main" java.lang.NoSuchMethodError:
    'java.lang.String[] java.lang.String.splitWithDelimiters(java.lang.String, int)'
	at com.example.Validator.isValidRange(Validator.java:42)
	...
```

注意這是 **`NoSuchMethodError`（Error，不是 Exception）**，而且是在
**第一次執行到那一行**時才發生（第 09 章 9.6 節：方法解析是延遲的）。

所以它可能上線三天後、某個罕用的 API 端點被呼叫時才爆——
而那時你早就忘了那次 commit 改了什麼。

**③ 為什麼測試沒抓到**

因為**測試也是在 JDK 21 上跑的**。

```
本機開發：   JDK 21 編譯 → JDK 21 執行測試 → ✅
CI：        JDK 21 編譯 → JDK 21 執行測試 → ✅
正式環境：   （用 CI 產出的 jar）→ JDK 17 執行 → 💥
```

`surefire` 預設用建置用的同一個 JVM。整條 pipeline 沒有任何一個環節
在 JDK 17 上執行過這份 bytecode。

**這是「建置環境與執行環境不一致」的教科書案例。**

**④ 一行改動**

```xml
<properties>
  <!-- 刪掉 source 和 target，改用 release -->
  <maven.compiler.release>17</maven.compiler.release>
</properties>
```

`release` 除了做 `source` + `target` 的事，還多做一件關鍵的事：
**它讓 `javac` 使用目標版本的 API 簽章**（JDK 內建了歷史版本的
`ct.sym` 簽章檔，`--release` 就是靠它）。

**⑤ 改完會發生什麼**

下次建置就會失敗：

```
[ERROR] /src/main/java/com/example/Validator.java:[42,29] cannot find symbol
[ERROR]   symbol:   method splitWithDelimiters(java.lang.String,int)
[ERROR]   location: variable raw of type java.lang.String
```

**在 CI 上，不在正式環境。** 這就是我們要的。

開發者接著有三個選擇：
1. 改用 Java 17 就有的寫法（`Pattern` / `indexOf`）。
2. 把正式環境升到 Java 21，然後 `release` 也改成 21。
3. 確認這個 API 真的必要，且能接受升級成本 → 走選項 2。

**額外建議：把「環境一致性」也變成建置的一部分**

```xml
<!-- 確保建置用的 JDK 不會低於目標（低於會編不動新語法） -->
<plugin>
  <groupId>org.apache.maven.plugins</groupId>
  <artifactId>maven-enforcer-plugin</artifactId>
  <version>3.5.0</version>
  <executions>
    <execution>
      <id>enforce-java</id>
      <phase>validate</phase>
      <goals><goal>enforce</goal></goals>
      <configuration>
        <rules>
          <requireJavaVersion><version>[17,)</version></requireJavaVersion>
        </rules>
      </configuration>
    </execution>
  </executions>
</plugin>
```

更徹底的做法是**讓 CI 在目標 JDK 上跑測試**：

```yaml
strategy:
  matrix:
    java: [17, 21]     # 用 17 建置產出，也在 21 上驗證相容
```

或用 Maven toolchain 明確指定建置用的 JDK，不依賴機器上剛好裝了什麼：

```xml
<!-- ~/.m2/toolchains.xml 定義各版本 JDK 的位置 -->
<plugin>
  <groupId>org.apache.maven.plugins</groupId>
  <artifactId>maven-toolchains-plugin</artifactId>
  <version>3.2.0</version>
  <executions>
    <execution>
      <goals><goal>select-jdk-toolchain</goal></goals>
    </execution>
  </executions>
  <configuration>
    <version>17</version>
  </configuration>
</plugin>
```

> **這一題的核心教訓**：`release` 不是「比較新的寫法」，
> 它修的是一個**會讓錯誤從編譯期溜到正式環境**的真實漏洞。
> 你在既有專案看到 `source`/`target`，那就是一個等著發生的事故。
> 改成 `release` 花你 30 秒。

</details>

---

## 10.21 驗收清單

- [ ] 我能說出沒有建置工具時的四個具體問題，以及 Maven 各自怎麼解。
- [ ] 我知道 Maven 最大的價值是「約定」，不是「自動下載 jar」。
- [ ] 我能從 GAV 座標推出它在 `~/.m2/repository` 的路徑，並說明 jar 旁邊的 pom 為什麼是傳遞依賴的關鍵。
- [ ] 我知道 SNAPSHOT 是可變的，也知道為什麼正式環境不能用它。
- [ ] 我能手寫一份完整的 `pom.xml`，並解釋每個區塊。
- [ ] **我知道 `maven.compiler.release` 和 `source`/`target` 的差別，以及後者會讓什麼錯誤溜到正式環境。**
- [ ] 我知道不設 `project.build.sourceEncoding` 會發生什麼。
- [ ] 我能說出三個生命週期，以及 `default` 生命週期的關鍵 phase 順序。
- [ ] 我能分辨 phase 與 goal，也知道 `mvn compile` 和 `mvn compiler:compile` 的差別。
- [ ] 我知道為什麼幾乎都要加 `clean`。
- [ ] 我知道 `-DskipTests` 和 `-Dmaven.test.skip=true` 的差別。
- [ ] 我知道 `src/main/resources` 的內容會和 class 混在 `target/classes`，且打包後不能當檔案讀。
- [ ] 我會用 resource filtering 把版本資訊注入程式，也知道它的兩個陷阱。
- [ ] 我能正確選擇四種 scope，並說出各自的實務理由（不只是「省空間」）。
- [ ] 我記得 `provided` 和 `test` 永不傳遞。
- [ ] **我能說出 Maven 的兩條衝突解決規則，並知道「先宣告者勝」為什麼危險。**
- [ ] 我會用 `mvn dependency:tree -Dverbose` 找衝突，也知道 `-Dincludes` 怎麼用。
- [ ] 我知道 `dependencyManagement` 的優先權高於「最近者優先」。
- [ ] 我會用 BOM + `import` scope，也知道它的三個限制。
- [ ] 我知道 `mvn help:effective-pom` 是排查版本問題的第一工具。
- [ ] 我能設定 compiler / surefire / failsafe / shade / enforcer / versions 六個外掛。
- [ ] 我知道 surefire 的 `argLine` 覆寫會讓 JaCoCo 覆蓋率變 0%，以及 `@{argLine}` 的寫法。
- [ ] 我知道 failsafe 為什麼要同時綁 `integration-test` 和 `verify`。
- [ ] **我知道 shade 忘記 `ServicesResourceTransformer` 會讓 log 全部消失，且只在打包後發生。**
- [ ] 我會用 enforcer 的 `dependencyConvergence` 把衝突變成建置失敗。
- [ ] 我知道 `activeByDefault` 的陷阱，也知道該把預設值寫在 `<properties>`。
- [ ] 我知道不該用 profile 切換依賴或 main 程式碼（Build once, deploy many）。
- [ ] 我能拆出多模組專案，並說明 aggregator 與 parent 是兩件事。
- [ ] 我知道 reactor 的順序來自依賴關係，不是 `<modules>` 的排列。
- [ ] 我會用 `-pl` / `-am` / `-amd` / `-rf` / `-T`。
- [ ] **我知道 `java -jar` 會完全忽略 `-cp` 與 `CLASSPATH`。**
- [ ] 我能說出四種打包方式的優缺點，並依情境選擇。
- [ ] 我知道 Spring Boot 的嵌套 jar 為什麼比 uber-jar 更好。
- [ ] 我知道 jlink 的前提是所有依賴都是 JPMS 模組，以及這為什麼是實務障礙。
- [ ] 我能寫一份多階段 Dockerfile，並知道 `ENTRYPOINT` 為什麼要用 exec 形式。
- [ ] 我知道 `.dockerignore` 不寫會發生什麼。
- [ ] 我能對照 Maven 與 Gradle 的概念，並說出 `api` vs `implementation` 的價值。
- [ ] **我知道 Maven 選「最近者」、Gradle 選「最高版本」，兩者行為相反。**
- [ ] 我知道 Maven Wrapper 解決什麼問題，也會用 `.mvn/maven.config`。
- [ ] 我知道 CI 上的四條紀律（`-B`、`-ntp`、`verify`、`clean`）。
- [ ] 我知道可重現建置的意義，也會用 `project.build.outputTimestamp` 並驗證它。
- [ ] 我能產生 SBOM，並說出它除了掃漏洞之外的兩個用途。
- [ ] 我知道 typosquatting 與 dependency confusion 這兩種攻擊，以及防禦方式。
- [ ] 我知道加一個依賴之前該問的三個問題。

---

> 建置工具這一章沒有炫技的地方，但它是所有「上線之後才出事」的問題的**唯一防線**。
>
> 回頭看看第 09 章那些症狀——`NoSuchMethodError`、`NoClassDefFoundError`、
> `LinkageError`、log 消失、OOMKilled——它們**絕大多數不是 JVM 的問題，是建置的問題**。
> 你在這一章學的每一個 enforcer 規則、每一個 scope、每一個 transformer，
> 都是在讓某一類線上事故變成**建置期的一個紅燈**。
>
> 這就是專業與業餘的差別：不是出事時修得快，是讓事情沒機會發生。

完成後請前往 [11-testing-junit-mockito.md](./11-testing-junit-mockito.md)。
