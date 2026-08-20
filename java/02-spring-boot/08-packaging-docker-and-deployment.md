# 第 08 章：打包與部署

> 前七章都在講「怎麼把程式寫對」。這一章講「怎麼讓它在別人的機器上也跑對」。
>
> 這一章的內容不會出現在功能規格裡，但它決定了三件事：
> - **部署要 30 秒還是 8 分鐘**（映像分層做對了沒有）
> - **重新部署時使用者會不會看到 500**（優雅關閉做對了沒有）
> - **被入侵時攻擊者能做到什麼**（容器用 root 跑、還是唯讀檔案系統的非特權使用者）
>
> 我見過三個真實的部署事故，全部都是這一章的內容：
> - 每次部署重建 380 MB 的映像層，只因為 `COPY` 的順序寫錯。
> - 沒有優雅關閉，每次部署有大約 40 筆訂單「送出了但沒建立」。
> - 容器用 root 跑，一個檔案上傳漏洞讓攻擊者寫入 `/etc/cron.d`。
>
> 這一章會把這些一次講清楚，並給出一份可以直接抄的上線檢查清單。

---

## 8.1 學習目標

完成本章後，你應該可以：

- 解剖 Spring Boot 可執行 jar 的結構，說明它與普通 jar、fat jar 的差別。
- 說明 `JarLauncher` 的巢狀 jar 載入機制，以及它為什麼不是「解壓縮再跑」。
- **用分層（layered jar）與正確的 `COPY` 順序，讓映像重建只上傳幾 MB**。
- 寫出一份符合生產標準的多階段 `Dockerfile`：非 root、最小基底、健康檢查、正確的訊號處理。
- 用 Buildpacks（`spring-boot:build-image`）與 Jib 產生映像，並說明何時該選它們。
- 用 CDS 與 AOT 縮短啟動時間，並判斷 GraalVM native image 值不值得。
- **依「下游容量」而不是預設值定出 Tomcat 執行緒池大小**，並說出「CPU 30% 但回應時間爆炸」的原因。
- 說明虛擬執行緒把瓶頸移到哪裡，以及打開它之前要先確認什麼。
- 列出三個一定要設的逾時，並說明「沒設逾時」為什麼是最常見的單一事故原因。
- **正確設定優雅關閉**：Spring 端、容器端、K8s 端三層都要對。
- 說明 JVM 在容器裡的記憶體計算，並用 `MaxRAMPercentage` 避免 OOMKilled。
- 用環境變數與 Secret 注入設定（銜接第 03 章），並避免密鑰進映像。
- 設定 K8s 的三種探針、資源限制、`PodDisruptionBudget`，做到零停機部署。
- 產生 SBOM 並掃描映像漏洞。
- 執行一份完整的上線前檢查清單。

---

## 8.2 可執行 jar 的結構

### 先看它長什麼樣

```bash
$ ./mvnw clean package
$ ls -lh target/*.jar
-rw-r--r--  1 dev  staff    48M  Aug 18 14:02 shop-service-1.4.2.jar
-rw-r--r--  1 dev  staff    38K  Aug 18 14:02 shop-service-1.4.2.jar.original
```

**兩個檔案**：

| 檔案 | 是什麼 |
|---|---|
| `shop-service-1.4.2.jar.original` | Maven 原本打包出來的**普通 jar**（只有你的 class，38 KB） |
| `shop-service-1.4.2.jar` | `spring-boot-maven-plugin` 的 `repackage` goal 產生的**可執行 jar**（48 MB） |

```bash
$ unzip -l target/shop-service-1.4.2.jar | head -30
Archive:  target/shop-service-1.4.2.jar
  Length      Date    Time    Name
---------  ---------- -----   ----
        0  2026-08-18 14:02   META-INF/
      459  2026-08-18 14:02   META-INF/MANIFEST.MF
        0  2026-08-18 14:02   BOOT-INF/
        0  2026-08-18 14:02   BOOT-INF/classes/
     1234  2026-08-18 14:02   BOOT-INF/classes/com/example/shop/ShopServiceApplication.class
     4521  2026-08-18 14:02   BOOT-INF/classes/com/example/shop/order/OrderService.class
      892  2026-08-18 14:02   BOOT-INF/classes/application.yml
        0  2026-08-18 14:02   BOOT-INF/lib/
  7654321  2026-08-18 14:02   BOOT-INF/lib/spring-core-6.2.0.jar
  2345678  2026-08-18 14:02   BOOT-INF/lib/spring-boot-3.5.0.jar
  1234567  2026-08-18 14:02   BOOT-INF/lib/jackson-databind-2.18.0.jar
      ...
    12345  2026-08-18 14:02   BOOT-INF/layers.idx
        0  2026-08-18 14:02   org/springframework/boot/loader/
     3456  2026-08-18 14:02   org/springframework/boot/loader/launch/JarLauncher.class
     5678  2026-08-18 14:02   org/springframework/boot/loader/launch/LaunchedClassLoader.class
      ...
```

### 四個部分

```
shop-service-1.4.2.jar
├── META-INF/MANIFEST.MF                    ① 啟動資訊
├── BOOT-INF/classes/                       ② 你的 class 與 resources
├── BOOT-INF/lib/*.jar                      ③ 所有依賴（★ 巢狀 jar ★）
├── BOOT-INF/layers.idx                     ④ 分層索引（Docker 用）
└── org/springframework/boot/loader/        ⑤ Spring Boot 的啟動器
```

```bash
$ unzip -p target/shop-service-1.4.2.jar META-INF/MANIFEST.MF
Manifest-Version: 1.0
Created-By: Maven JAR Plugin 3.4.1
Build-Jdk-Spec: 21
Implementation-Title: shop-service
Implementation-Version: 1.4.2
Main-Class: org.springframework.boot.loader.launch.JarLauncher        ← ① JVM 執行的是這個
Start-Class: com.example.shop.ShopServiceApplication                  ← ② 你的 main class
Spring-Boot-Version: 3.5.0
Spring-Boot-Classes: BOOT-INF/classes/
Spring-Boot-Lib: BOOT-INF/lib/
Spring-Boot-Classpath-Index: BOOT-INF/classpath.idx
Spring-Boot-Layers-Index: BOOT-INF/layers.idx
```

> ⚠️ **`JarLauncher` 的套件在 Spring Boot 3.2 搬過家**：
> ```
> Boot 3.1 及之前：org.springframework.boot.loader.JarLauncher
> Boot 3.2 起：    org.springframework.boot.loader.launch.JarLauncher
> ```
> 如果你的 Dockerfile 或 K8s 設定裡有寫死這個類別名稱，升版時會壞掉。
> 第 09 章會列進遷移清單。

### `JarLauncher` 做了什麼

**核心問題：標準 Java 的 classpath 無法讀取「jar 裡面的 jar」。**

```bash
# ❌ 這樣是不行的，JVM 不支援巢狀 jar
java -cp shop.jar:shop.jar!/BOOT-INF/lib/spring-core.jar com.example.shop.ShopServiceApplication
```

所以 Spring Boot 自己寫了一個 ClassLoader：

```
java -jar shop-service.jar
   │
   ├─ ① JVM 讀 MANIFEST.MF，執行 Main-Class = JarLauncher
   │
   ├─ ② JarLauncher 掃描 BOOT-INF/lib/ 下的所有巢狀 jar
   │      並讀取 BOOT-INF/classpath.idx 決定順序
   │
   ├─ ③ 建立 LaunchedClassLoader
   │      它能直接從「外層 jar 的位元組串流」中定位巢狀 jar 的內容
   │      ★ 不需要解壓縮到磁碟 ★
   │
   ├─ ④ 用這個 ClassLoader 載入 Start-Class
   │
   └─ ⑤ 反射呼叫它的 main(String[])
```

> **「不需要解壓縮」是關鍵設計**：
> Spring Boot 的巢狀 jar 用 **`STORED`（不壓縮）** 方式存放，
> 所以可以直接用 offset 定位並讀取，不需要先 inflate。
> 這也是為什麼可執行 jar 比「所有 class 攤平的 fat jar」大一些——
> 但換來的是**依賴 jar 的完整性**（簽章有效、`META-INF/services` 不衝突）。

### 為什麼不用 fat jar（shade / uber jar）

| | Spring Boot 可執行 jar | fat jar（maven-shade-plugin） |
|---|---|---|
| 依賴的存放方式 | 保持原本的 jar 檔 | **全部攤平**到同一層 |
| `META-INF/services` 衝突 | ✅ 不會（各 jar 獨立） | ❌ 會互相覆蓋（需要 transformer） |
| 依賴的簽章 | ✅ 保留 | ❌ 破壞（`SecurityException`） |
| 同名資源檔 | ✅ 各自獨立 | ❌ 後者覆蓋前者 |
| 能否辨識用了哪些依賴 | ✅ 一目了然 | ❌ 全部混在一起 |
| 分層（Docker 快取） | ✅ 支援 | ❌ 不支援 |

> **真實案例**：某團隊為了「讓 jar 小一點」改用 shade plugin。
> 結果 `META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports`
> 這個檔案（第 02 章）在多個 starter 裡都存在，被互相覆蓋，
> **只剩最後一個 jar 的自動組態生效**。症狀是「一半的功能莫名失效」，查了一週。

### 提取內容：`jarmode`

```bash
# ① 列出可用的工具【Boot 3.3+】
$ java -Djarmode=tools -jar shop-service.jar help
Usage:
  java -Djarmode=tools -jar shop-service.jar
Available commands:
  extract      Extract the contents from the jar
  list-layers  List layers from the jar that can be extracted
  help         Help about any command

# ② 列出分層
$ java -Djarmode=tools -jar shop-service.jar list-layers
dependencies
spring-boot-loader
snapshot-dependencies
application

# ③ 提取（Docker 建置會用到）
$ java -Djarmode=tools -jar shop-service.jar extract --layers --destination extracted
$ ls -la extracted/
dependencies/
spring-boot-loader/
snapshot-dependencies/
application/

$ du -sh extracted/*
 46M    extracted/dependencies         ← ★ 很少變 ★
252K    extracted/spring-boot-loader   ← 幾乎不變
  0B    extracted/snapshot-dependencies
1.2M    extracted/application          ← ★ 每次都變 ★
```

> ⚠️ **Boot 3.3 之前用的是 `-Djarmode=layertools`**：
> ```bash
> java -Djarmode=layertools -jar shop.jar extract       # Boot 3.2 及之前
> java -Djarmode=tools -jar shop.jar extract --layers   # Boot 3.3+
> ```
> `layertools` 在 3.3 起已棄用。這是第 09 章遷移清單的一項。

### 分層的意義：那 46 MB 只要上傳一次

```
不分層的 Dockerfile（COPY 整個 jar）：
  每次改一行程式碼 → 48 MB 的映像層全部重建 → 上傳 48 MB

分層的 Dockerfile：
  改一行程式碼 → 只有 application 層（1.2 MB）重建 → 上傳 1.2 MB
  → ★ 部署速度快 40 倍 ★
```

### 自訂分層

`src/layers.xml`：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<layers xmlns="http://www.springframework.org/schema/boot/layers"
        xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
        xsi:schemaLocation="http://www.springframework.org/schema/boot/layers
                            https://www.springframework.org/schema/boot/layers/layers-3.3.xsd">

    <application>
        <into layer="spring-boot-loader">
            <include>org/springframework/boot/loader/**</include>
        </into>
        <!-- 設定檔獨立一層：改設定不用重建整個 application 層 -->
        <into layer="application-config">
            <include>BOOT-INF/classes/application*.yml</include>
            <include>BOOT-INF/classes/logback-spring.xml</include>
        </into>
        <into layer="application"/>
    </application>

    <dependencies>
        <into layer="snapshot-dependencies">
            <include>*:*:*SNAPSHOT</include>
        </into>
        <!-- 公司內部函式庫：比第三方變動頻繁，獨立一層 -->
        <into layer="company-dependencies">
            <include>com.example:*</include>
        </into>
        <into layer="dependencies"/>
    </dependencies>

    <!-- ★ 順序很重要：越少變的放前面（Docker 層由上往下堆疊）★ -->
    <layerOrder>
        <layer>dependencies</layer>
        <layer>spring-boot-loader</layer>
        <layer>snapshot-dependencies</layer>
        <layer>company-dependencies</layer>
        <layer>application-config</layer>
        <layer>application</layer>
    </layerOrder>
</layers>
```

```xml
<plugin>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-maven-plugin</artifactId>
    <configuration>
        <layers>
            <enabled>true</enabled>
            <configuration>${project.basedir}/src/layers.xml</configuration>
        </layers>
    </configuration>
</plugin>
```

---

## 8.3 Dockerfile：從最爛寫到生產級

### 版本 0：能動但很爛

```dockerfile
FROM openjdk:21
COPY target/shop-service-1.4.2.jar /app.jar
ENTRYPOINT ["java", "-jar", "/app.jar"]
```

**六個問題：**

| # | 問題 | 後果 |
|---|---|---|
| 1 | `openjdk:21` | ⚠️ 這個映像已經**停止維護**（deprecated），不再有安全更新 |
| 2 | 用完整 JDK 而不是 JRE | 映像大 200 MB+，還包含編譯器等攻擊面 |
| 3 | 沒有分層 | 改一行程式碼要重建整個 jar 層 |
| 4 | **用 root 執行** | 容器逃逸風險大幅提高 |
| 5 | 版本寫死在 `COPY` | 改版本要改 Dockerfile |
| 6 | 沒有 JVM 記憶體設定 | 容器 OOMKilled 風險 |
| 7 | 沒有健康檢查、沒有優雅關閉處理 | 部署時掉請求 |

### 版本 1：多階段 + 分層 + 非 root（生產級）

```dockerfile
# syntax=docker/dockerfile:1.7

# ══════════════════════════════════════════════════════════
# 階段 1：建置
# ══════════════════════════════════════════════════════════
FROM eclipse-temurin:21-jdk-alpine AS builder

WORKDIR /build

# ① 先只複製依賴描述檔 —— 讓 Maven 依賴下載可以被 Docker 快取
COPY .mvn/ .mvn/
COPY mvnw pom.xml ./

# ② 下載依賴（只要 pom.xml 沒改，這一層就會命中快取）
#    --mount=type=cache 讓 ~/.m2 在多次建置間共用（BuildKit 功能）
RUN --mount=type=cache,target=/root/.m2 \
    ./mvnw dependency:go-offline -B -q

# ③ 現在才複製原始碼（原始碼一定會變，所以放最後）
COPY src/ src/

# ④ 建置。-DskipTests 是因為測試應該在 CI 的獨立階段跑（第 07 章）
RUN --mount=type=cache,target=/root/.m2 \
    ./mvnw clean package -DskipTests -B -q

# ⑤ 提取分層
RUN java -Djarmode=tools -jar target/*.jar extract --layers --destination extracted


# ══════════════════════════════════════════════════════════
# 階段 2：執行
# ══════════════════════════════════════════════════════════
FROM eclipse-temurin:21-jre-alpine AS runtime

# ① 安裝必要工具
#    curl：健康檢查用（如果用 exec probe 就不需要）
#    tzdata：Alpine 預設沒有時區資料庫（第 06 章的時區問題！）
RUN apk add --no-cache curl tzdata && \
    rm -rf /var/cache/apk/*

ENV TZ=Asia/Taipei

# ② 建立非 root 使用者
RUN addgroup -S -g 10001 spring && \
    adduser -S -u 10001 -G spring -h /app -s /sbin/nologin spring

WORKDIR /app

# ③ ★★ 依「變動頻率」由低到高複製，最大化 Docker 層快取 ★★
ARG EXTRACTED=/build/extracted
COPY --from=builder --chown=spring:spring ${EXTRACTED}/dependencies/            ./
COPY --from=builder --chown=spring:spring ${EXTRACTED}/spring-boot-loader/      ./
COPY --from=builder --chown=spring:spring ${EXTRACTED}/snapshot-dependencies/   ./
COPY --from=builder --chown=spring:spring ${EXTRACTED}/application/             ./

# ④ 切換到非 root
USER 10001:10001

EXPOSE 8080 8081

# ⑤ JVM 參數
ENV JAVA_OPTS="\
  -XX:MaxRAMPercentage=70.0 \
  -XX:InitialRAMPercentage=50.0 \
  -XX:+UseG1GC \
  -XX:+ExitOnOutOfMemoryError \
  -XX:+HeapDumpOnOutOfMemoryError \
  -XX:HeapDumpPath=/tmp/heapdump.hprof \
  -Djava.security.egd=file:/dev/./urandom \
  -Dfile.encoding=UTF-8"

# ⑥ 健康檢查（K8s 環境下通常改用 K8s 的探針，這裡是給 Docker Compose 用）
HEALTHCHECK --interval=15s --timeout=3s --start-period=45s --retries=3 \
  CMD curl -fsS http://localhost:8081/actuator/health/liveness || exit 1

# ⑦ ★ 用 exec 形式 + JarLauncher，讓 java 成為 PID 1 並直接收到 SIGTERM ★
ENTRYPOINT ["sh", "-c", "exec java $JAVA_OPTS org.springframework.boot.loader.launch.JarLauncher"]
```

### 逐點說明

#### ① 為什麼 `COPY pom.xml` 要在 `COPY src/` 之前

**Docker 的層快取規則：某一層的內容變了，它「以及後面所有層」都要重建。**

```
❌ 錯誤順序：
   COPY . .                        ← 任何檔案改動都讓這層失效
   RUN ./mvnw package              ← 所以每次都要重新下載所有依賴（3 分鐘）

✅ 正確順序：
   COPY pom.xml .                  ← 只有改依賴時才失效
   RUN ./mvnw dependency:go-offline ← 依賴下載被快取（0 秒）
   COPY src/ src/                  ← 改程式碼只讓這層失效
   RUN ./mvnw package              ← 只重新編譯（20 秒）
```

**效果**：改一行程式碼的建置時間從 3 分 20 秒降到 25 秒。

#### ③ 為什麼四個 `COPY` 的順序這樣排

```
Docker 映像是「層」的堆疊。推送時只上傳「本地有、遠端沒有」的層。

COPY dependencies/          （46 MB，只有改 pom.xml 時才變）
COPY spring-boot-loader/    （252 KB，只有升 Boot 版本時才變）
COPY snapshot-dependencies/ （通常 0 B）
COPY application/           （1.2 MB，★ 每次都變 ★）

改一行程式碼 → 只有最後一層重建 → 推送 1.2 MB
```

**如果順序反過來**（`application` 在最前面），那麼每次改程式碼都會讓
後面的 `dependencies` 層失效 → 每次推送 48 MB。

#### ④ 為什麼一定要非 root

```
容器裡的 root 就是「主機上的 root」（除非開了 user namespace remapping）。

風險鏈：
  應用程式漏洞（例如檔案上傳沒驗證路徑）
    → 寫入 /etc/cron.d/ 或 /root/.ssh/authorized_keys
    → 容器逃逸（配合 kernel 漏洞或錯誤的 mount）
    → 主機被完全控制
```

> **真實案例**：某服務的檔案上傳功能沒有驗證路徑（`../../../etc/cron.d/backdoor`）。
> 因為容器用 root 跑，攻擊者成功寫入 cron 排程，取得了容器內的 shell。
> 又因為容器掛載了 Docker socket（另一個錯誤），最終取得主機權限。
>
> **`USER 10001` 這一行，會讓這條攻擊鏈在第一步就斷掉。**

**用「數字 UID」而不是使用者名稱**：

```dockerfile
USER 10001:10001      # ✅ K8s 的 runAsNonRoot 檢查需要數字
USER spring           # ⚠️ K8s 無法從名稱判斷是不是 root
```

#### ⑤ `MaxRAMPercentage` 為什麼比 `-Xmx` 好

**JVM 的記憶體不只有堆積：**

```
容器 memory limit = 1 GB
  │
  ├─ Heap（-Xmx）                      ← 大家只想到這個
  ├─ Metaspace                         約 50～150 MB（類別多就多）
  ├─ Code Cache（JIT 編譯後的機器碼）    約 50～240 MB
  ├─ Thread Stacks（每條 1 MB）         200 條 Tomcat 執行緒 = 200 MB
  ├─ Direct Memory（NIO buffer）        Netty / 檔案 IO
  ├─ GC 自身的資料結構                   約 heap 的 5～10%
  └─ JVM 本身 + glibc/musl              約 30 MB
```

```dockerfile
# ❌ 寫死 -Xmx = 容器上限 → 必定 OOMKilled
ENV JAVA_OPTS="-Xmx1g"          # 容器 limit 也是 1g

# ✅ 用百分比，留空間給非堆積
ENV JAVA_OPTS="-XX:MaxRAMPercentage=70.0"
```

> **JDK 10+ 預設開啟 `UseContainerSupport`**，會讀 cgroup 的限制，
> 所以 `MaxRAMPercentage` 是相對於「容器的 limit」而不是「主機的實體記憶體」。
>
> **70% 是常見的起點**，但要實測：
> ```bash
> # 用 Native Memory Tracking 看真實用量
> java -XX:NativeMemoryTracking=summary -jar app.jar
> jcmd <pid> VM.native_memory summary
> ```

#### `-XX:+ExitOnOutOfMemoryError` 為什麼重要

```
沒有這個參數：
  發生 OOM → 拋出 OutOfMemoryError → 某個執行緒死掉
  → 但 JVM 還活著，healthcheck 可能還是回 UP
  → ★ 服務變成「半死狀態」：有些請求成功、有些莫名失敗 ★
  → 這比直接掛掉難查十倍

有這個參數：
  發生 OOM → JVM 立刻退出 → 容器重啟 → 服務恢復
  → 而且 K8s 會記錄 OOMKilled，你知道發生了什麼
```

> **「快速失敗」在分散式系統裡比「勉強活著」好**——
> 因為有負載均衡與副本，一個實例重啟不影響服務；
> 但一個「半死」的實例會持續回傳錯誤。

#### ⑦ `ENTRYPOINT` 的形式決定訊號能不能傳到 JVM

```dockerfile
# ❌ shell 形式：實際執行 /bin/sh -c "java -jar app.jar"
#    → sh 是 PID 1，java 是子程序
#    → docker stop 送 SIGTERM 給 sh，sh 不會轉發給 java
#    → 15 秒後 SIGKILL，優雅關閉完全沒發生
ENTRYPOINT java -jar /app.jar

# ⚠️ exec 形式但需要展開變數時不行
ENTRYPOINT ["java", "$JAVA_OPTS", "-jar", "/app.jar"]     # $JAVA_OPTS 不會被展開

# ✅ 用 sh -c 但加 exec：exec 會「取代」sh 程序，讓 java 成為 PID 1
ENTRYPOINT ["sh", "-c", "exec java $JAVA_OPTS org.springframework.boot.loader.launch.JarLauncher"]

# ✅ 或用 tini 當 init（處理殭屍程序 + 訊號轉發）
# RUN apk add --no-cache tini
# ENTRYPOINT ["/sbin/tini", "--", "sh", "-c", "exec java $JAVA_OPTS org.springframework.boot.loader.launch.JarLauncher"]
```

**驗證方式：**

```bash
$ docker run -d --name shop shop-service:1.4.2
$ docker exec shop ps -ef
PID   USER     TIME  COMMAND
    1 spring    0:12 java -XX:MaxRAMPercentage=70.0 ... JarLauncher     ← ★ java 是 PID 1 ★
   45 spring    0:00 ps -ef

# 如果看到這樣就是錯的：
#     1 spring    0:00 sh -c java -jar /app.jar
#     7 spring    0:12 java -jar /app.jar        ← java 不是 PID 1
```

### `.dockerignore`（不要漏）

```gitignore
# 建置產物（要在容器內重建，不要複製本機的）
target/
build/
*.jar
*.war

# IDE
.idea/
.vscode/
*.iml

# 版控
.git/
.gitignore

# ★ 敏感檔案（第 03 章）★
.env
application-local.yml
application-prod.yml
*.pem
*.key
*.p12
*.jks

# 文件與測試資料
*.md
docs/
```

> **為什麼 `.git/` 一定要排除**：
> 一個中型專案的 `.git` 可能有 200 MB，而且**包含所有歷史版本的內容**。
> 如果歷史裡曾經 commit 過密碼（第 03 章的案例），複製 `.git` 就等於把密碼帶進映像。

### 映像大小對照

```bash
$ docker images | grep shop-service
shop-service   fat-openjdk       892MB      # FROM openjdk:21 + 整個 jar
shop-service   jdk-alpine        412MB      # FROM temurin:21-jdk-alpine
shop-service   jre-alpine        198MB      # FROM temurin:21-jre-alpine  ← 建議起點
shop-service   jlink-custom      112MB      # 用 jlink 裁剪的 runtime
shop-service   native            78MB       # GraalVM native image
```

### 進階：用 `jlink` 裁剪 runtime

```dockerfile
FROM eclipse-temurin:21-jdk-alpine AS jre-builder

# ① 分析 jar 需要哪些模組
RUN --mount=type=bind,from=builder,source=/build/target,target=/target \
    jdeps --ignore-missing-deps --print-module-deps --multi-release 21 \
      --recursive /target/shop-service-1.4.2.jar > /modules.txt

# ② 只保留需要的模組建立 runtime
RUN jlink \
      --add-modules "$(cat /modules.txt),jdk.crypto.ec,jdk.unsupported" \
      --strip-debug --no-man-pages --no-header-files --compress=zip-6 \
      --output /custom-jre

FROM alpine:3.20
COPY --from=jre-builder /custom-jre /opt/jre
ENV PATH="/opt/jre/bin:${PATH}"
# ... 後續同版本 1
```

> **取捨**：省下 80 MB，但增加建置複雜度，而且 `jdeps` 常常漏抓反射用到的模組
> （所以要手動補 `jdk.crypto.ec`、`jdk.unsupported` 之類）。
>
> **建議：先用 `jre-alpine`（198 MB）。** 映像大小很少是真正的瓶頸——
> Docker 的層快取讓「重複部署」只上傳變動的層。

---

## 8.4 不寫 Dockerfile 的兩種方式

### Buildpacks：`spring-boot:build-image`

```bash
$ ./mvnw spring-boot:build-image -DskipTests
...
[INFO] Building image 'docker.io/library/shop-service:1.4.2'
[INFO]  > Pulling builder image 'paketobuildpacks/builder-jammy-java-tiny'
[INFO]  > Executing lifecycle version v0.20.x
[INFO]     [creator]     Paketo Buildpack for BellSoft Liberica 11.x.x
[INFO]     [creator]     Paketo Buildpack for Executable JAR 6.x.x
[INFO]     [creator]     Paketo Buildpack for Spring Boot 5.x.x
[INFO]     [creator]       Creating slices from layers index
[INFO]     [creator]         dependencies (46.2 MB)
[INFO]     [creator]         spring-boot-loader (252.1 KB)
[INFO]     [creator]         snapshot-dependencies (0.0 B)
[INFO]     [creator]         application (1.2 MB)
[INFO] Successfully built image 'docker.io/library/shop-service:1.4.2'
```

```xml
<plugin>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-maven-plugin</artifactId>
    <configuration>
        <image>
            <name>registry.example.com/shop/shop-service:${project.version}</name>
            <builder>paketobuildpacks/builder-jammy-java-tiny</builder>
            <env>
                <BP_JVM_VERSION>21</BP_JVM_VERSION>
                <BPE_APPEND_JAVA_TOOL_OPTIONS>-XX:MaxRAMPercentage=70</BPE_APPEND_JAVA_TOOL_OPTIONS>
                <BP_SPRING_CLOUD_BINDINGS_DISABLED>true</BP_SPRING_CLOUD_BINDINGS_DISABLED>
            </env>
            <publish>true</publish>
        </image>
        <docker>
            <publishRegistry>
                <username>${env.REGISTRY_USER}</username>
                <password>${env.REGISTRY_TOKEN}</password>
            </publishRegistry>
        </docker>
    </configuration>
</plugin>
```

**Buildpacks 自動幫你做的事：**

| 項目 | 說明 |
|---|---|
| 分層 | 自動讀 `layers.idx` |
| 非 root | 預設用 `cnb` 使用者（UID 1000） |
| 記憶體計算 | **內建 Java Memory Calculator**，依容器 limit 自動算 `-Xmx`、`-XX:MaxMetaspaceSize`、`-Xss` |
| SBOM | 自動產生 |
| 基底映像更新 | 只要 rebase 就能換掉有漏洞的基底層，**不用重新編譯應用程式** |
| 健康檢查 | 需要自己在部署層設定 |

> **Java Memory Calculator 是 Buildpacks 的殺手級功能**：
> 它會依據「容器 limit − 執行緒數 × 堆疊大小 − Metaspace − 直接記憶體」
> 反推出安全的 `-Xmx`，比自己猜 `MaxRAMPercentage` 準確。

**Buildpacks 的取捨：**

| 優點 | 缺點 |
|---|---|
| 不用維護 Dockerfile | 客製化能力受限（要裝額外套件很麻煩） |
| 自動處理安全性更新（rebase） | 映像比手寫 Dockerfile 大（約 250～350 MB） |
| 記憶體自動計算 | 建置比較慢（第一次要拉 builder 映像） |
| 標準化（多個團隊產出一致） | 對「發生什麼事」的可見度較低 |

> **建議**：團隊多、想要標準化 → Buildpacks。
> 需要精細控制（特定 CA 憑證、特殊 native 函式庫、極致映像瘦身）→ 手寫 Dockerfile。

### Jib：不需要 Docker daemon

```xml
<plugin>
    <groupId>com.google.cloud.tools</groupId>
    <artifactId>jib-maven-plugin</artifactId>
    <version>3.4.3</version>
    <configuration>
        <from>
            <image>eclipse-temurin:21-jre-alpine</image>
        </from>
        <to>
            <image>registry.example.com/shop/shop-service</image>
            <tags>
                <tag>${project.version}</tag>
                <tag>latest</tag>
            </tags>
        </to>
        <container>
            <user>10001:10001</user>
            <ports>
                <port>8080</port>
                <port>8081</port>
            </ports>
            <jvmFlags>
                <jvmFlag>-XX:MaxRAMPercentage=70.0</jvmFlag>
                <jvmFlag>-XX:+ExitOnOutOfMemoryError</jvmFlag>
            </jvmFlags>
            <environment>
                <TZ>Asia/Taipei</TZ>
            </environment>
            <!-- ★ 可重現建置：固定時間戳 ★ -->
            <creationTime>USE_CURRENT_TIMESTAMP</creationTime>
        </container>
    </configuration>
</plugin>
```

```bash
./mvnw jib:build          # 直接推到 registry（不需要 Docker daemon！）
./mvnw jib:dockerBuild    # 建到本機 Docker
```

> **Jib 最大的優勢：不需要 Docker daemon。**
> 這在 CI 環境（尤其是 K8s 裡跑的 CI runner）很重要——
> 不用掛 Docker socket（安全風險）也不用 DinD（複雜且慢）。
>
> Jib 也天生分層（依賴 / 資源 / class 三層），而且建置極快（增量建置幾秒）。

### 三種方式的選擇

| | 手寫 Dockerfile | Buildpacks | Jib |
|---|---|---|---|
| 控制度 | ⭐⭐⭐⭐⭐ | ⭐⭐ | ⭐⭐⭐ |
| 需要 Docker daemon | ✅ | ✅ | ❌ |
| 建置速度 | 中 | 慢 | **快** |
| 映像大小 | 最小 | 較大 | 小 |
| 記憶體自動計算 | ❌ | ✅ | ❌ |
| 學習成本 | 中 | 低 | 低 |
| 適合 | 需要客製化 | 多團隊標準化 | CI 環境、快速迭代 |

---

## 8.5 縮短啟動時間

### 現況與目標

```
一般 Spring Boot 服務：1.5～8 秒
  → 對「重新部署」影響不大（滾動更新有時間）
  → 對「自動擴容」影響很大（流量尖峰時新 Pod 要多久才能接流量）
  → 對「Serverless / Scale-to-zero」是致命的
```

### 手段 1：CDS（Class Data Sharing）【Boot 3.3+】

**原理**：把「類別載入與解析的結果」預先寫進一個 archive，啟動時直接 mmap 進來。

```dockerfile
FROM eclipse-temurin:21-jre-alpine AS cds-builder

WORKDIR /app
COPY --from=builder /build/extracted/dependencies/            ./
COPY --from=builder /build/extracted/spring-boot-loader/      ./
COPY --from=builder /build/extracted/snapshot-dependencies/   ./
COPY --from=builder /build/extracted/application/             ./

# ① 訓練執行：啟動一次應用程式，記錄用到哪些類別
#    Boot 3.3+ 提供 spring.context.exit=onRefresh，啟動完成就退出
RUN java -XX:ArchiveClassesAtExit=/app/application.jsa \
         -Dspring.context.exit=onRefresh \
         org.springframework.boot.loader.launch.JarLauncher

FROM eclipse-temurin:21-jre-alpine AS runtime
# ... 使用者設定同前 ...
WORKDIR /app
COPY --from=cds-builder --chown=spring:spring /app/ ./

USER 10001:10001

# ② 執行時使用 archive
ENV JAVA_OPTS="-XX:SharedArchiveFile=/app/application.jsa -XX:MaxRAMPercentage=70.0"
ENTRYPOINT ["sh", "-c", "exec java $JAVA_OPTS org.springframework.boot.loader.launch.JarLauncher"]
```

**效果**：啟動時間通常縮短 **20～40%**（例如 2.5 秒 → 1.6 秒）。

> ⚠️ **CDS archive 與 JVM 版本、classpath 綁定**。
> 換 JDK 版本或改依賴，archive 就失效（JVM 會警告並忽略它，不會崩潰）。
> 所以 archive 一定要在**建置時**產生，不要跨版本重用。

### 手段 2：AOT 處理【Boot 3.0+】

```xml
<plugin>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-maven-plugin</artifactId>
    <executions>
        <execution>
            <id>process-aot</id>
            <goals>
                <goal>process-aot</goal>
            </goals>
        </execution>
    </executions>
</plugin>
```

```bash
java -Dspring.aot.enabled=true -jar shop-service.jar
```

**AOT 在建置時把這些工作提前做完：**

```
① 解析 @Configuration，產生「直接註冊 Bean」的 Java 程式碼
② 評估 @Conditional，把結果固化
③ 產生 GraalVM 需要的反射/資源/代理設定
```

**效果**：啟動時間縮短 **10～30%**，而且與 CDS 可以疊加。

> ⚠️ **AOT 的重要限制：條件被固化了。**
> 也就是說「用 profile 切換 Bean」這種**執行期決定**的行為會失效
> （因為 `@Profile` 的判斷在建置時就做完了）。
>
> **這是第 03 章多環境設定的重要注意事項**：
> 開了 AOT 之後，「同一個映像用不同 profile 啟動」可能不再有效。
> 需要 profile 切換的專案要謹慎評估。

### 手段 3：GraalVM Native Image

```xml
<profiles>
    <profile>
        <id>native</id>
        <build>
            <plugins>
                <plugin>
                    <groupId>org.graalvm.buildtools</groupId>
                    <artifactId>native-maven-plugin</artifactId>
                    <configuration>
                        <buildArgs>
                            <buildArg>--enable-preview</buildArg>
                            <buildArg>-H:+ReportExceptionStackTraces</buildArg>
                        </buildArgs>
                    </configuration>
                </plugin>
            </plugins>
        </build>
    </profile>
</profiles>
```

```bash
# 需要 GraalVM JDK
$ sdk install java 21.0.5-graal
$ ./mvnw -Pnative native:compile -DskipTests
# 建置時間：3～15 分鐘（很慢）

$ ./target/shop-service
...
Started ShopServiceApplication in 0.087 seconds     ← ★ 87 毫秒 ★
```

或用 Buildpacks 產生 native 映像：

```bash
./mvnw -Pnative spring-boot:build-image
```

**對照表：**

| | JVM | JVM + CDS + AOT | Native Image |
|---|---|---|---|
| 啟動時間 | 2.5 s | 1.4 s | **0.09 s** |
| 記憶體（RSS） | 380 MB | 360 MB | **95 MB** |
| 映像大小 | 198 MB | 205 MB | **78 MB** |
| 建置時間 | 30 s | 60 s | **8 min** |
| 尖峰吞吐量 | 100% | 100% | **85～95%**（沒有 JIT） |
| 反射 / 動態代理 | ✅ 全支援 | ✅ | ⚠️ 需要設定 |
| 執行期 profile 切換 | ✅ | ⚠️ 受限 | ❌ 固化 |
| 除錯工具（jstack/jmap/JFR） | ✅ | ✅ | ⚠️ 受限 |
| 函式庫相容性 | ✅ | ✅ | ⚠️ 要逐一驗證 |

> **判斷準則：**
>
> | 情境 | 建議 |
> |---|---|
> | 一般長時間運行的服務 | **JVM**（可加 CDS） |
> | 要頻繁自動擴容應對尖峰 | JVM + CDS + AOT |
> | Serverless / Scale-to-zero / CLI 工具 | **Native Image** |
> | 記憶體成本是主要考量（大量小服務） | Native Image |
>
> **不要為了「聽起來很酷」而用 native image。**
> 建置慢 8 分鐘會嚴重影響開發回饋速度，而且函式庫相容性問題會吃掉大量時間。

---

## 8.6 ★ 內嵌伺服器的執行緒模型與調參 ★

上一節談的是「啟動要多久」。這一節談的是**啟動之後能扛多少**。

**這是上線前最常被跳過、也最常變成事故的一組設定。**
Spring Boot 的預設值適合開發，不適合正式環境——
而它們的共同問題是：**超過負載時不會報錯，只會變慢，然後全部逾時。**

---

### 8.6.1 一個請求佔用一條執行緒

回到第 00 章 0.13 的那張圖，最上面那一格：

```
請求進來 → Tomcat 從執行緒池借一條 worker
            │
            │  ★ 從這裡到回應寫出為止，全程都是這條執行緒
            │     Filter → DispatcherServlet → 你的方法
            │       → 呼叫資料庫（等）
            │       → 呼叫外部 API（等）
            │       → 序列化 JSON
            ▼
         歸還執行緒
```

> 🔑 **關鍵字是「等」。**
> 傳統 Servlet 模型下，執行緒在等資料庫、等外部 API 的整段時間都是**被佔住**的。
> 一支平均 200 毫秒的 API，其中 190 毫秒可能都在等——
> **執行緒不是在算東西，是在發呆，但別人也用不到它。**

這推出一條公式（Little's Law）：

```
需要的執行緒數 ≈ 每秒請求數 × 平均回應時間（秒）

  例：500 rps × 0.2 秒 = 100 條
      500 rps × 2.0 秒 = 1000 條   ← 外部 API 變慢 10 倍，需求變 10 倍
```

**第二行就是「下游變慢 → 整個服務掛掉」的完整機制**：
下游沒有掛，只是變慢；但你的執行緒池被吃光，於是**所有**端點都開始逾時，
包含那些根本不碰下游的端點。

---

### 8.6.2 四個預設值，以及它們各自的意義

```yaml
server:
  tomcat:
    threads:
      max: 200                    # worker 執行緒上限
      min-spare: 10               # 常駐的最少執行緒
    max-connections: 8192         # 同時「接受」的連線數
    accept-count: 100             # 連線佇列長度（滿了才拒絕）
    connection-timeout: 20s       # 連線建立後多久沒送出完整請求就斷
    max-http-form-post-size: 2MB
  max-http-request-header-size: 8KB
```

| 設定 | 預設 | 它控制什麼 | 超過會怎樣 |
|---|---|---|---|
| `threads.max` | **200** | 同時**處理**中的請求數 | 超過的請求進入佇列等待 |
| `max-connections` | **8192** | 同時**接受**的連線數 | 超過的進 `accept-count` 佇列 |
| `accept-count` | **100** | 佇列長度 | **佇列也滿了才會拒絕連線** |
| `connection-timeout` | **20s** | 慢速攻擊防護 | 連線被斷 |

**三層的關係要一起看**：

```
8192 條連線可以「進來」
   └→ 但同時只有 200 條在「處理」
        └→ 其餘 7992 條在等一條 worker 空出來
             └→ 而客戶端那邊的逾時可能只有 3 秒

  ⚠️ 結果：使用者早就收到逾時錯誤了，但你的伺服器還在慢慢處理
     那些「已經沒人在等」的請求 —— 這叫做「工作已經沒有意義了還在做」
```

> 🔑 **這是「壓測時 CPU 只有 30%，但回應時間爆炸」的標準解釋。**
> 瓶頸不在 CPU，在**執行緒池佇列**。指標要看
> `tomcat_threads_busy_threads` 和 `tomcat_threads_config_max`
> （第 05 章 5.14 的 Micrometer 指標），而不是只看 CPU。

---

### 8.6.3 怎麼定這幾個數字

**步驟一：先算出下游的容量上限，再回推。**

```
資料庫連線池（HikariCP）預設 10 條
   ↓
就算你開 200 條 worker，同時也只有 10 條能真的查資料庫
   ↓
其餘 190 條在搶連線 → 全部卡在 HikariCP 的 connectionTimeout（預設 30 秒）
   ↓
★ 開更多 worker 執行緒不會更快，只會讓更多請求「一起慢慢逾時」
```

> 🔑 **worker 執行緒數不該遠大於下游的容量。**
> 讓 200 條執行緒去搶 10 條資料庫連線，只是把「快速拒絕」變成「集體逾時」——
> 而後者的使用者體驗與排查難度都差得多。

**步驟二：一組可以直接抄的起點**（之後靠壓測調整）：

```yaml
# 典型的「每個請求都要查資料庫」的 CRUD 服務
spring:
  datasource:
    hikari:
      maximum-pool-size: 20          # 依資料庫的 max_connections 與實例數決定
      connection-timeout: 3000       # ★ 3 秒拿不到連線就快速失敗，不要等 30 秒

server:
  tomcat:
    threads:
      max: 50                        # ≈ 連線池的 2～3 倍，不是預設的 200
      min-spare: 10
    accept-count: 100
    max-connections: 2000
    connection-timeout: 5s
  shutdown: graceful                 # ★ 8.7 節
```

| 服務型態 | `threads.max` 的方向 |
|---|---|
| 每個請求都查資料庫（大多數 CRUD） | **連線池大小的 2～3 倍** |
| 大量呼叫外部 API（等待為主） | 較大，但**一定要配逾時 + 隔艙 / 熔斷**（03-rest-api 第 08 章） |
| 純計算、不等 IO | **≈ CPU 核心數**，開更多只是增加 context switch |
| 用虛擬執行緒（見下） | 不再由這個值決定 |

**步驟三：容器裡要確認 JVM 看到的 CPU 數是對的。**

```bash
# 進到容器裡確認 —— 這個數字影響執行緒池、GC 執行緒、ForkJoinPool.commonPool
java -XshowSettings:system -version 2>&1 | grep -i cpu
# 或
jcmd 1 VM.flags | tr ' ' '\n' | grep -i ActiveProcessorCount
```

> ⚠️ **CPU limit 設成 `500m`（半顆）時，JVM 會看到 1 顆**，
> 於是 `commonPool` 只有 0 條額外執行緒、GC 執行緒也只有 1 條。
> 這是 01-java-core 第 09 章 9.13「容器環境的三個陷阱」在部署時的具體後果——
> **`-XX:ActiveProcessorCount` 可以覆寫，但通常正確做法是給整數顆 CPU。**

---

### 8.6.4 虛擬執行緒：把這一整節的算式換掉

```yaml
spring:
  threads:
    virtual:
      enabled: true          # 需要 Boot 3.2+ 與 JDK 21+
```

打開之後，每個請求配一條**虛擬執行緒**（01-java-core 第 08 章 8.14），
`server.tomcat.threads.max` 不再是瓶頸——「等待」不再佔住平台執行緒。

**但它不是免費的**：

| 注意事項 | 說明 |
|---|---|
| **瓶頸會往下游移** | 執行緒不再是限制，於是資料庫連線池、下游 API 變成新的瓶頸。**沒有配套的限流，你只是把塞車移到更貴的地方** |
| **`synchronized` 會釘住（pin）載體執行緒** | JDK 21 上，`synchronized` 區塊裡的阻塞會抵銷虛擬執行緒的好處（JDK 24 起大幅改善）。改用 `ReentrantLock`（01-java-core 第 08 章 8.9） |
| **`ThreadLocal` 的成本改變** | 每個請求一條新執行緒 → 快取型的 `ThreadLocal` 完全失效（01-java-core 第 08 章 8.13） |
| **執行緒池指標失去意義** | 監控要改看下游的飽和度，不是 `tomcat_threads_busy` |

> 🔑 **虛擬執行緒解決的是「執行緒太貴」，不是「下游容量不足」。**
> 打開它之前，先確定你的限流與逾時是對的（03-rest-api 第 08 章）。

---

### 8.6.5 三個一定要設的逾時

**執行緒池調得再好，只要少了逾時，一次下游變慢就會拖垮整個服務。**

```yaml
spring:
  datasource:
    hikari:
      connection-timeout: 3000        # ① 拿不到連線就快速失敗
      validation-timeout: 1000
  # ② 每個外部 HTTP 呼叫都要有 connect + read 逾時（05-service 會實作）
  #    RestClient / WebClient 預設「沒有逾時」＝ 永遠等下去

server:
  tomcat:
    connection-timeout: 5s            # ③ 慢速客戶端
```

> ⚠️ **「沒有設逾時」是 Java 後端最常見的單一事故原因。**
> `RestTemplate` / `RestClient` 不設就是**無限等待**——
> 一個沒回應的下游，可以在 200 條執行緒全滿之後讓你的服務完全停止回應，
> 而 CPU 使用率是 0%、log 裡什麼也沒有。
>
> 排查方法在 01-java-core 第 08 章 8.17：`jstack` 看有沒有一大票執行緒卡在同一個
> socket read 上。**看到那個畫面，答案就是這一節。**

---

### 8.6.6 上線前的六個問題

```
□ threads.max 是依「下游容量」算出來的，不是留著 200 的預設值？
□ HikariCP 的 maximum-pool-size × 實例數 ≤ 資料庫的 max_connections？
□ 每一個外部呼叫都設了 connect + read 逾時？
□ HikariCP 的 connection-timeout 調短了（3 秒，不是預設 30 秒）？
□ 容器裡 java 看到的 CPU 數是你預期的？
□ 監控上有 tomcat_threads_busy / hikaricp_connections_pending 的告警？
```

> 這六題有任何一題答不出來，就代表**你的服務的最大承載量是未知數**——
> 而未知數會在流量最高的那一天被發現。

---

## 8.7 ★ 優雅關閉 ★

**這一節的內容直接影響「部署時使用者會不會看到錯誤」。**

### 不做優雅關閉會發生什麼

```
t=0    K8s 決定關閉 Pod（滾動更新）
t=0    K8s 送 SIGTERM 給容器
t=0    JVM 立刻停止 → 所有正在處理的請求「連線被切斷」
       → 使用者看到 502 / ERR_CONNECTION_RESET
       → 已經寫了一半的交易 rollback（還好）
       → 或者：交易已 commit 但回應沒送出 → ★ 使用者以為失敗，實際成功 ★
```

> **真實案例**：某電商每次部署（一天 3～5 次）都有大約 40 筆訂單
> 「使用者說沒送出成功，但資料庫裡有」。客服每天處理十幾張重複下單的客訴。
> 根因就是沒有優雅關閉。

### 三層都要設對

```
┌─────────────────────────────────────────────────────────┐
│ 第 3 層：Kubernetes                                       │
│  ├─ preStop hook（等 endpoint 從 LB 移除）                │
│  └─ terminationGracePeriodSeconds（給多少時間）            │
├─────────────────────────────────────────────────────────┤
│ 第 2 層：容器                                             │
│  └─ ENTRYPOINT 用 exec 形式（讓 java 收到 SIGTERM）        │
├─────────────────────────────────────────────────────────┤
│ 第 1 層：Spring Boot                                      │
│  ├─ server.shutdown=graceful                             │
│  ├─ spring.lifecycle.timeout-per-shutdown-phase          │
│  └─ 各執行緒池的 await-termination                        │
└─────────────────────────────────────────────────────────┘
```

### 第 1 層：Spring Boot 設定

```yaml
server:
  shutdown: graceful                          # ★ 預設是 immediate ★

spring:
  lifecycle:
    timeout-per-shutdown-phase: 30s           # 等現有請求完成的上限

  task:
    execution:                                # @Async 執行緒池（第 06 章）
      shutdown:
        await-termination: true
        await-termination-period: 25s
    scheduling:                               # @Scheduled 執行緒池
      shutdown:
        await-termination: true
        await-termination-period: 25s

  datasource:
    hikari:
      # 關閉時等連線歸還（避免「交易還沒完成就關連線池」）
      keepalive-time: 30000
```

**`server.shutdown: graceful` 做的事：**

```
收到關閉訊號
  → ① Web 伺服器停止接受「新連線」
  → ② 等待「進行中的請求」完成（最多 timeout-per-shutdown-phase）
  → ③ 開始關閉 ApplicationContext
       ├─ 執行 @PreDestroy
       ├─ 關閉執行緒池（等 await-termination-period）
       └─ 關閉連線池
  → ④ JVM 退出
```

日誌會看到：

```
2026-08-18T14:32:01.102Z  INFO --- Commencing graceful shutdown. Waiting for active requests to complete
2026-08-18T14:32:03.418Z  INFO --- Graceful shutdown complete
2026-08-18T14:32:03.420Z  INFO --- Shutting down ExecutorService 'applicationTaskExecutor'
2026-08-18T14:32:03.512Z  INFO --- HikariPool-1 - Shutdown initiated...
2026-08-18T14:32:03.531Z  INFO --- HikariPool-1 - Shutdown completed.
```

### 加上自訂的關閉邏輯

```java
package com.example.shop.lifecycle;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.availability.AvailabilityChangeEvent;
import org.springframework.boot.availability.ReadinessState;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.context.event.ContextClosedEvent;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;

import java.util.concurrent.atomic.AtomicBoolean;

@Component
public class ShutdownCoordinator {

    private static final Logger log = LoggerFactory.getLogger(ShutdownCoordinator.class);

    private final ApplicationEventPublisher publisher;
    private final AtomicBoolean shuttingDown = new AtomicBoolean(false);

    public ShutdownCoordinator(ApplicationEventPublisher publisher) {
        this.publisher = publisher;
    }

    /**
     * 收到關閉訊號時，第一件事就是「讓 readiness 變成 REFUSING_TRAFFIC」。
     *
     * <p>這樣 K8s 的 readinessProbe 會失敗 → 把這個 Pod 從 Service endpoints 移除
     * → 新請求不再進來（配合 preStop 的等待時間）。
     */
    @EventListener(ContextClosedEvent.class)
    public void onShutdown() {
        if (shuttingDown.compareAndSet(false, true)) {
            log.info("收到關閉訊號，停止接受新流量");
            AvailabilityChangeEvent.publish(publisher, this, ReadinessState.REFUSING_TRAFFIC);
        }
    }

    public boolean isShuttingDown() {
        return shuttingDown.get();
    }
}
```

```java
package com.example.shop.batch;

import com.example.shop.lifecycle.ShutdownCoordinator;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import java.util.List;

/**
 * 長時間執行的批次任務要主動檢查關閉訊號（第 06 章練習 4 的延伸）。
 */
@Component
public class LongRunningBatch {

    private static final Logger log = LoggerFactory.getLogger(LongRunningBatch.class);

    private final ShutdownCoordinator shutdownCoordinator;
    private final OrderRepository repository;

    public LongRunningBatch(ShutdownCoordinator shutdownCoordinator, OrderRepository repository) {
        this.shutdownCoordinator = shutdownCoordinator;
        this.repository = repository;
    }

    @Scheduled(fixedDelayString = "PT10M")
    public void processLargeBatch() {
        List<Long> ids = repository.findPendingIds(10_000);
        int processed = 0;

        for (Long id : ids) {
            // ★ 每一筆都檢查，讓關閉可以在幾秒內完成而不是幾十分鐘 ★
            if (shutdownCoordinator.isShuttingDown() || Thread.currentThread().isInterrupted()) {
                log.info("偵測到關閉訊號，已處理 {}/{} 筆，剩餘的下次再處理",
                        processed, ids.size());
                return;                                  // 安全退出，不是拋例外
            }
            processOne(id);
            processed++;
        }
        log.info("批次處理完成，共 {} 筆", processed);
    }

    private void processOne(Long id) { }
}
```

> **這個設計的關鍵：批次任務必須是「可中斷且可續跑」的。**
> 每筆處理完就標記狀態，中斷後下一輪從未處理的繼續。
> **不要設計成「必須一次跑完 10000 筆」的任務**——它會讓部署卡住幾十分鐘。

### 第 2 層：容器（8.3 已講）

```dockerfile
ENTRYPOINT ["sh", "-c", "exec java $JAVA_OPTS org.springframework.boot.loader.launch.JarLauncher"]
```

**驗證：**

```bash
$ docker run -d --name shop shop-service:1.4.2
$ docker exec shop ps -ef | head -3
PID   USER     COMMAND
    1 spring    java -XX:MaxRAMPercentage=70.0 ... JarLauncher    ← ✅ java 是 PID 1

$ time docker stop shop
shop
real    0m2.418s          ← ✅ 2 秒（優雅關閉完成）
# 如果是 real 0m10.xxx 就代表 SIGTERM 沒被處理，等到了 Docker 的 10 秒 timeout
```

### 第 3 層：Kubernetes

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: shop-service
spec:
  replicas: 3
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1                              # 最多多開 1 個
      maxUnavailable: 0                        # ★ 0 表示絕不減少可用副本 ★
  template:
    spec:
      # ★★ 這個數字要 > preStop sleep + Spring 的 timeout ★★
      terminationGracePeriodSeconds: 60

      containers:
        - name: shop-service
          image: registry.example.com/shop/shop-service:1.4.2

          lifecycle:
            preStop:
              exec:
                # ★★ 這 10 秒是關鍵，理由見下方 ★★
                command: ["sh", "-c", "sleep 10"]

          readinessProbe:
            httpGet:
              path: /actuator/health/readiness
              port: 8081
            periodSeconds: 3
            failureThreshold: 2
            timeoutSeconds: 2

          livenessProbe:
            httpGet:
              path: /actuator/health/liveness
              port: 8081
            periodSeconds: 10
            failureThreshold: 3
            timeoutSeconds: 3

          startupProbe:
            httpGet:
              path: /actuator/health/liveness
              port: 8081
            periodSeconds: 5
            failureThreshold: 24                # 最多等 120 秒
```

### ★ 為什麼需要 `preStop: sleep 10` ★

**這是最多人不知道、但影響最大的一個細節。**

```
K8s 關閉 Pod 時，這兩件事是「並行」發生的，沒有順序保證：

  ① kubelet 送 SIGTERM 給容器
  ② kube-proxy / Ingress Controller 更新規則，把這個 Pod 從 endpoints 移除

如果 ① 比 ② 快（很常見，因為 ② 要經過 API Server → 各節點 kube-proxy → iptables/IPVS 更新）：

  t=0.0   SIGTERM → Spring 開始 graceful shutdown，不再接受「新連線」
  t=0.1   ★ 但 LB 還不知道，繼續把新請求送過來 ★
  t=0.1   新請求被拒絕（連線被 reset）→ 使用者看到 502
  t=2.0   endpoints 終於更新完成
  → 這 2 秒內的請求全部失敗
```

**`preStop: sleep 10` 的作用：**

```
  t=0.0   K8s 開始關閉流程
  t=0.0   ① 執行 preStop hook（sleep 10）—— ★ SIGTERM 還沒送出 ★
  t=0.0   ② 同時開始更新 endpoints
  t=2.0   endpoints 更新完成，LB 不再送新請求進來
  t=10.0  preStop 結束 → 現在才送 SIGTERM
  t=10.0  Spring 開始 graceful shutdown（此時已經沒有新請求了）
  t=12.0  現有請求處理完，JVM 退出
  → ★ 零掉包 ★
```

**時間預算要對得上：**

```
terminationGracePeriodSeconds (60)
  ≥ preStop sleep (10)
  + spring.lifecycle.timeout-per-shutdown-phase (30)
  + 執行緒池 await-termination (25，與上面部分重疊)
  + 緩衝

⚠️ 如果 terminationGracePeriodSeconds 太小，K8s 會在時間到時直接 SIGKILL，
   優雅關閉做一半被砍掉，反而更糟。
```

### 配合 `readinessProbe` 的另一種做法

如果不想用 `preStop: sleep`，可以靠 `ShutdownCoordinator`（上面那段程式碼）
主動把 readiness 設成 `REFUSING_TRAFFIC`：

```
t=0.0   SIGTERM → ContextClosedEvent → readiness 變成 REFUSING_TRAFFIC
t=0.0   Spring 停止接受新連線
t=0～3  readinessProbe 失敗（periodSeconds: 3）
t=3     endpoints 更新
→ 但 t=0～3 這段時間 LB 還在送請求，仍然會掉包
```

> **結論：`preStop: sleep` 是目前最可靠的做法。**
> 兩者一起做最好——`preStop` 處理 LB 更新延遲，
> `ShutdownCoordinator` 讓 readiness 立刻反映狀態（對監控與 debug 有幫助）。

### 驗證零停機部署

```bash
# ① 開一個持續打請求的視窗
$ while true; do
    code=$(curl -s -o /dev/null -w '%{http_code}' https://shop.example.com/actuator/health)
    echo "$(date +%T) $code"
    sleep 0.2
  done | tee deploy-test.log

# ② 另一個視窗做滾動更新
$ kubectl set image deployment/shop-service shop-service=registry.example.com/shop/shop-service:1.4.3
$ kubectl rollout status deployment/shop-service

# ③ 檢查有沒有非 200
$ grep -v ' 200$' deploy-test.log
# ★ 應該是空的 ★
```

**如果有非 200，依症狀排查：**

| 狀態碼 | 原因 |
|---|---|
| `502` / `000` | 沒有 `preStop`，或 SIGTERM 沒傳到 JVM |
| `503` | 新 Pod 的 readiness 還沒通過就被加進 LB（檢查 `maxUnavailable: 0`） |
| 連線逾時 | `terminationGracePeriodSeconds` 太小，被 SIGKILL |

---

## 8.8 設定注入與密鑰（銜接第 03 章）

### 環境變數

```yaml
# k8s deployment
env:
  - name: SPRING_PROFILES_ACTIVE
    value: prod
  - name: TZ
    value: Asia/Taipei
  - name: JAVA_OPTS
    value: "-XX:MaxRAMPercentage=70.0 -XX:+ExitOnOutOfMemoryError"

  # 從 ConfigMap
  - name: DB_URL
    valueFrom:
      configMapKeyRef:
        name: shop-config
        key: db.url

  # 從 Secret
  - name: DB_PASSWORD
    valueFrom:
      secretKeyRef:
        name: shop-secrets
        key: db.password

envFrom:
  - configMapRef:
      name: shop-config
```

### 更好的做法：Secret 掛載成檔案 + `configtree`

回顧第 03 章 3.11：

```yaml
volumeMounts:
  - name: shop-secrets
    mountPath: /run/secrets
    readOnly: true

volumes:
  - name: shop-secrets
    secret:
      secretName: shop-service-secrets
      defaultMode: 0400                      # 只有擁有者可讀
```

```yaml
# application.yml
spring:
  config:
    import:
      - optional:configtree:/run/secrets/
```

```
/run/secrets/
├── spring.datasource.password       → spring.datasource.password
└── shop.payment.api-key             → shop.payment.api-key
```

**為什麼比環境變數好：**

| | 環境變數 | Secret 掛載檔案 |
|---|---|---|
| `docker inspect` 看得到 | ✅ 看得到 | ❌ 看不到 |
| `/proc/<pid>/environ` 看得到 | ✅ | ❌ |
| 子程序繼承 | ✅（可能洩漏） | ❌ |
| 崩潰報告 / APM 可能收集 | ✅ 風險 | ❌ |
| 輪替時 | 要重啟 Pod | K8s 會自動更新檔案內容（但 Spring 不會重讀，仍需重啟） |

### 唯讀根檔案系統

```yaml
securityContext:
  runAsNonRoot: true
  runAsUser: 10001
  runAsGroup: 10001
  allowPrivilegeEscalation: false
  readOnlyRootFilesystem: true              # ★ 強力的防護 ★
  capabilities:
    drop: ["ALL"]
  seccompProfile:
    type: RuntimeDefault

volumeMounts:
  # 唯讀根檔案系統時，需要寫入的路徑要單獨掛 emptyDir
  - name: tmp
    mountPath: /tmp
  - name: heapdump
    mountPath: /dump

volumes:
  - name: tmp
    emptyDir:
      sizeLimit: 256Mi
  - name: heapdump
    emptyDir:
      sizeLimit: 2Gi
```

> **`readOnlyRootFilesystem: true` 讓「寫入 webshell」這類攻擊直接失效。**
> 但要注意：Tomcat 需要一個可寫的暫存目錄（預設在 `/tmp`），
> JVM 的 heap dump、JFR 記錄也需要。所以要掛 `emptyDir`。
>
> 如果 Tomcat 啟動時報「Unable to create tempDir」，就是這個問題：
> ```yaml
> env:
>   - name: JAVA_OPTS
>     value: "-Djava.io.tmpdir=/tmp"
> ```

### 資源限制

```yaml
resources:
  requests:
    memory: "512Mi"
    cpu: "500m"
  limits:
    memory: "1Gi"
    # ⚠️ CPU limit 要謹慎設（見下方）
```

> **關於 CPU limit 的爭議：**
>
> K8s 的 CPU limit 用 CFS quota 實作，會造成**節流（throttling）**：
> 一個 100ms 的週期內用完配額，剩下的時間就被暫停——
> 即使機器還很閒。這會讓 P99 延遲大幅惡化。
>
> 對 JVM 更麻煩：**GC 執行緒與 JIT 編譯執行緒也算 CPU 用量**。
> 一次 GC 就可能觸發節流，讓正常請求被卡住。
>
> **常見建議：設 `requests` 保證資源，不設 `cpu.limits`**（或設得寬鬆），
> 靠 `requests` 與節點容量規劃來避免搶佔。
>
> **但這要看團隊的政策**——如果多租戶共用叢集，limit 可能是強制的。
> 那就設得比 requests 高 2～4 倍，並監控 `container_cpu_cfs_throttled_seconds_total`。

### 完整的 Deployment

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: shop-service
  labels:
    app: shop-service
    version: "1.4.2"
spec:
  replicas: 3
  revisionHistoryLimit: 5
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 0
  selector:
    matchLabels:
      app: shop-service
  template:
    metadata:
      labels:
        app: shop-service
        version: "1.4.2"
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "8081"
        prometheus.io/path: "/actuator/prometheus"
    spec:
      terminationGracePeriodSeconds: 60
      securityContext:
        runAsNonRoot: true
        runAsUser: 10001
        runAsGroup: 10001
        fsGroup: 10001
        seccompProfile:
          type: RuntimeDefault

      # 分散到不同節點，避免單一節點故障造成全掛
      topologySpreadConstraints:
        - maxSkew: 1
          topologyKey: kubernetes.io/hostname
          whenUnsatisfiable: ScheduleAnyway
          labelSelector:
            matchLabels:
              app: shop-service

      containers:
        - name: shop-service
          image: registry.example.com/shop/shop-service:1.4.2
          imagePullPolicy: IfNotPresent

          ports:
            - name: http
              containerPort: 8080
            - name: management
              containerPort: 8081

          env:
            - name: SPRING_PROFILES_ACTIVE
              value: prod
            - name: TZ
              value: Asia/Taipei
            - name: JAVA_OPTS
              value: >-
                -XX:MaxRAMPercentage=70.0
                -XX:+UseG1GC
                -XX:+ExitOnOutOfMemoryError
                -XX:+HeapDumpOnOutOfMemoryError
                -XX:HeapDumpPath=/dump/heapdump.hprof
                -Djava.io.tmpdir=/tmp
            - name: POD_NAME
              valueFrom:
                fieldRef:
                  fieldPath: metadata.name

          envFrom:
            - configMapRef:
                name: shop-config

          volumeMounts:
            - name: shop-secrets
              mountPath: /run/secrets
              readOnly: true
            - name: tmp
              mountPath: /tmp
            - name: dump
              mountPath: /dump

          resources:
            requests:
              memory: "768Mi"
              cpu: "500m"
            limits:
              memory: "1536Mi"

          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop: ["ALL"]

          lifecycle:
            preStop:
              exec:
                command: ["sh", "-c", "sleep 10"]

          startupProbe:
            httpGet: { path: /actuator/health/liveness, port: 8081 }
            periodSeconds: 5
            failureThreshold: 24

          readinessProbe:
            httpGet: { path: /actuator/health/readiness, port: 8081 }
            periodSeconds: 3
            failureThreshold: 2
            timeoutSeconds: 2

          livenessProbe:
            httpGet: { path: /actuator/health/liveness, port: 8081 }
            periodSeconds: 10
            failureThreshold: 3
            timeoutSeconds: 3

      volumes:
        - name: shop-secrets
          secret:
            secretName: shop-service-secrets
            defaultMode: 0400
        - name: tmp
          emptyDir: { sizeLimit: 256Mi }
        - name: dump
          emptyDir: { sizeLimit: 2Gi }

---
# 業務流量的 Service（只開 8080）
apiVersion: v1
kind: Service
metadata:
  name: shop-service
spec:
  selector:
    app: shop-service
  ports:
    - name: http
      port: 80
      targetPort: http

---
# 監控用的 Service（8081，配合 NetworkPolicy 限制來源）
apiVersion: v1
kind: Service
metadata:
  name: shop-service-metrics
  labels:
    monitoring: "true"
spec:
  selector:
    app: shop-service
  ports:
    - name: management
      port: 8081
      targetPort: management

---
# ★ 防止節點維護時所有 Pod 同時被驅逐 ★
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: shop-service
spec:
  minAvailable: 2
  selector:
    matchLabels:
      app: shop-service

---
# 管理 port 只允許 monitoring namespace 存取（第 05 章 5.16）
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: shop-service-management
spec:
  podSelector:
    matchLabels:
      app: shop-service
  policyTypes: [Ingress]
  ingress:
    - from:
        - podSelector: {}                    # 同 namespace 可存取 8080
      ports:
        - port: 8080
    - from:
        - namespaceSelector:
            matchLabels:
              name: monitoring
      ports:
        - port: 8081
```

---

## 8.9 供應鏈安全：SBOM 與漏洞掃描

### 產生 SBOM【Boot 3.3+】

```xml
<plugin>
    <groupId>org.cyclonedx</groupId>
    <artifactId>cyclonedx-maven-plugin</artifactId>
    <version>2.8.1</version>
    <executions>
        <execution>
            <phase>package</phase>
            <goals><goal>makeAggregateBom</goal></goals>
        </execution>
    </executions>
    <configuration>
        <outputFormat>json</outputFormat>
        <includeBomSerialNumber>true</includeBomSerialNumber>
    </configuration>
</plugin>
```

Spring Boot 3.3+ 會自動把 SBOM 納入 jar，並提供 Actuator 端點：

```bash
$ curl -s localhost:8081/actuator/sbom | jq
{ "ids": ["application"] }

$ curl -s localhost:8081/actuator/sbom/application | jq '.components | length'
187
```

> **SBOM 的實際價值**：下一個 Log4Shell 出現時，
> 你能在**五分鐘內**回答「我們的 40 個服務裡，哪些用了受影響的版本」，
> 而不是花兩天翻每個專案的 `pom.xml`。

### 掃描漏洞

```bash
# ① 掃描依賴（OWASP Dependency-Check）
./mvnw org.owasp:dependency-check-maven:check

# ② 掃描映像（Trivy）
trivy image --severity HIGH,CRITICAL registry.example.com/shop/shop-service:1.4.2

# ③ 掃描 SBOM（更快，因為不用重新分析映像）
trivy sbom target/shop-service-1.4.2-cyclonedx.json

# ④ 掃描密鑰（第 03 章）
gitleaks detect --source . --log-opts="--all"
```

```yaml
# CI 整合
- name: 掃描映像漏洞
  uses: aquasecurity/trivy-action@master
  with:
    image-ref: registry.example.com/shop/shop-service:${{ github.sha }}
    severity: 'HIGH,CRITICAL'
    exit-code: '1'                   # 有高危漏洞就讓 CI 失敗
    ignore-unfixed: true             # 忽略「還沒有修補版本」的（否則永遠紅）
```

> **`ignore-unfixed: true` 很重要**：
> 基底映像常有「已知但上游還沒修」的漏洞。如果不忽略，CI 會永遠紅，
> 然後大家就開始忽略掃描結果——又是一次告警疲勞（第 05 章）。

### 映像簽章

```bash
# 用 cosign 簽章（供應鏈完整性）
cosign sign --key cosign.key registry.example.com/shop/shop-service:1.4.2

# 部署前驗證
cosign verify --key cosign.pub registry.example.com/shop/shop-service:1.4.2
```

---

## 8.10 完整的 CI/CD 流水線

```yaml
# .github/workflows/deploy.yml
name: Build and Deploy

on:
  push:
    branches: [main]
    tags: ['v*']

env:
  REGISTRY: registry.example.com
  IMAGE_NAME: shop/shop-service

jobs:
  # ══════════════════════════════════════
  test:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-java@v4
        with:
          java-version: '21'
          distribution: 'temurin'
          cache: maven

      - name: 快測試（第 07 章的分流）
        run: ./mvnw -B test

      - name: 整合測試
        run: ./mvnw -B verify -DskipUnitTests

      - name: 上傳測試報告
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: test-reports
          path: target/surefire-reports/

  # ══════════════════════════════════════
  security:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: 掃描密鑰
        uses: gitleaks/gitleaks-action@v2

      - name: 掃描依賴漏洞
        run: ./mvnw -B org.owasp:dependency-check-maven:check -DfailBuildOnCVSS=8

  # ══════════════════════════════════════
  build:
    runs-on: ubuntu-latest
    needs: [test, security]
    permissions:
      contents: read
      packages: write
      id-token: write                     # cosign keyless 簽章需要
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-java@v4
        with:
          java-version: '21'
          distribution: 'temurin'
          cache: maven

      - name: 決定版本標籤
        id: meta
        run: |
          if [[ "${GITHUB_REF}" == refs/tags/v* ]]; then
            echo "version=${GITHUB_REF#refs/tags/v}" >> $GITHUB_OUTPUT
          else
            echo "version=main-${GITHUB_SHA::8}" >> $GITHUB_OUTPUT
          fi

      - name: 設定 Buildx（多平台 + 快取）
        uses: docker/setup-buildx-action@v3

      - uses: docker/login-action@v3
        with:
          registry: ${{ env.REGISTRY }}
          username: ${{ secrets.REGISTRY_USER }}
          password: ${{ secrets.REGISTRY_TOKEN }}

      - name: 建置並推送映像
        uses: docker/build-push-action@v6
        with:
          context: .
          platforms: linux/amd64,linux/arm64
          push: true
          tags: |
            ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}:${{ steps.meta.outputs.version }}
            ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}:latest
          cache-from: type=gha
          cache-to: type=gha,mode=max
          provenance: true
          sbom: true

      - name: 掃描映像
        uses: aquasecurity/trivy-action@master
        with:
          image-ref: ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}:${{ steps.meta.outputs.version }}
          severity: 'HIGH,CRITICAL'
          exit-code: '1'
          ignore-unfixed: true

      - name: 簽章
        run: |
          cosign sign --yes \
            ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}:${{ steps.meta.outputs.version }}

  # ══════════════════════════════════════
  deploy-staging:
    runs-on: ubuntu-latest
    needs: build
    environment: staging
    steps:
      - name: 部署到 staging
        run: |
          kubectl set image deployment/shop-service \
            shop-service=${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}:${{ needs.build.outputs.version }} \
            -n staging
          kubectl rollout status deployment/shop-service -n staging --timeout=5m

      - name: 冒煙測試
        run: |
          for i in $(seq 1 30); do
            code=$(curl -s -o /dev/null -w '%{http_code}' https://staging.shop.example.com/actuator/health)
            [ "$code" = "200" ] && exit 0
            sleep 5
          done
          exit 1

  # ══════════════════════════════════════
  deploy-prod:
    runs-on: ubuntu-latest
    needs: deploy-staging
    if: startsWith(github.ref, 'refs/tags/v')
    environment: production               # ★ 需要人工核准 ★
    steps:
      - name: 部署到 production
        run: |
          kubectl set image deployment/shop-service \
            shop-service=${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}:${{ needs.build.outputs.version }} \
            -n production
          kubectl rollout status deployment/shop-service -n production --timeout=10m

      - name: 驗證版本（用第 05 章的 /info 端點）
        run: |
          version=$(curl -s https://shop.example.com/actuator/info | jq -r '.app.version')
          echo "線上版本：$version"
          [ "$version" = "${{ needs.build.outputs.version }}" ]

      - name: 部署失敗自動回滾
        if: failure()
        run: |
          kubectl rollout undo deployment/shop-service -n production
          kubectl rollout status deployment/shop-service -n production
```

---

## 8.11 常見錯誤

### ① `no main manifest attribute`

`pom.xml` 少了 `spring-boot-maven-plugin`（第 00 章 0.15 已講）。

### ② 用 `.jar.original` 部署

```bash
# ❌ 這是普通 jar，沒有依賴
java -jar target/shop-service-1.4.2.jar.original
# Error: Could not find or load main class
```

### ③ `COPY src/` 在 `COPY pom.xml` 之前

每次建置都重新下載依賴，慢 8 倍。

### ④ 四個分層 `COPY` 的順序寫反

每次部署都推送整個映像。

### ⑤ 容器用 root 執行

安全風險。設 `USER 10001:10001` + `runAsNonRoot: true`。

### ⑥ `ENTRYPOINT` 用 shell 形式

SIGTERM 傳不到 JVM，優雅關閉完全失效。

### ⑦ 沒設 `server.shutdown: graceful`

預設是 `immediate`，部署時掉請求。

### ⑧ 沒有 `preStop` hook

LB 更新延遲造成 502。

### ⑨ `terminationGracePeriodSeconds` 太小

優雅關閉做一半被 SIGKILL。

### ⑩ 寫死 `-Xmx` 等於容器 limit

必定 OOMKilled。用 `MaxRAMPercentage`。

### ⑪ Alpine 沒裝 tzdata

`TZ=Asia/Taipei` 無效，時區還是 UTC → 排程在錯誤時間執行（第 06 章）。

### ⑫ `readOnlyRootFilesystem` 沒掛 `/tmp`

Tomcat 啟動失敗（`Unable to create tempDir`）。

### ⑬ `.dockerignore` 沒排除 `.git` 與敏感檔案

映像變大，且可能帶入 Git 歷史裡的密鑰。

### ⑭ `maxUnavailable` 不是 0

滾動更新時可用副本減少，尖峰時可能過載。

### ⑮ 沒有 `PodDisruptionBudget`

節點維護時所有 Pod 同時被驅逐 → 服務中斷。

### ⑯ 用 `latest` 標籤部署

無法回滾、無法確認線上版本、`imagePullPolicy` 行為不確定。

---

## 8.12 上線前檢查清單

### 建置

```
□ pom.xml 有 spring-boot-maven-plugin
□ 版本號不是 SNAPSHOT（正式發布）
□ 分層已啟用（unzip -l 看得到 BOOT-INF/layers.idx）
□ Dockerfile 的 COPY 順序正確（pom.xml → src/，dependencies → application）
□ .dockerignore 排除 target/、.git/、*.yml 密鑰檔、*.pem
□ 多階段建置（builder 階段不進最終映像）
□ 基底映像是維護中的（不是 openjdk:*）
□ 用 JRE 而不是 JDK
□ SBOM 已產生
□ 映像已掃描，無 HIGH/CRITICAL（或已記錄例外）
□ 映像已簽章
```

### 容器

```
□ USER 是數字 UID，非 0
□ ENTRYPOINT 是 exec 形式（docker exec ps -ef 確認 java 是 PID 1）
□ TZ 已設定，且 Alpine 有裝 tzdata
□ JAVA_OPTS 有 MaxRAMPercentage（不是寫死 -Xmx）
□ 有 -XX:+ExitOnOutOfMemoryError
□ 有 -XX:+HeapDumpOnOutOfMemoryError 且路徑可寫
□ docker stop 在 3 秒內完成（證明 SIGTERM 有被處理）
```

### 應用程式設定（第 03、05 章）

```
□ SPRING_PROFILES_ACTIVE 已設定（且有 ProfileGuard 防護）
□ 沒有任何密碼寫在映像裡
□ Secret 用檔案掛載 + configtree，不用環境變數
□ server.shutdown=graceful
□ spring.lifecycle.timeout-per-shutdown-phase 已設
□ 執行緒池的 await-termination 已設（第 06 章）
□ 日誌等級是 INFO/WARN，不是 DEBUG
□ spring.jpa.show-sql=false
□ server.error.include-stacktrace=never
□ management.server.port 與業務 port 分離
□ Actuator 只開 health/info/prometheus
□ /env、/configprops、/heapdump、/shutdown 沒有開
```

### Kubernetes

```
□ terminationGracePeriodSeconds ≥ preStop + shutdown timeout + 緩衝
□ preStop: sleep 10（或等同機制）
□ maxUnavailable: 0
□ startupProbe 已設（啟動慢的服務必備）
□ readinessProbe 含資料庫等必要依賴
□ livenessProbe 只有 livenessState（不含外部依賴！第 05 章）
□ resources.requests 已設
□ securityContext: runAsNonRoot, readOnlyRootFilesystem, drop ALL caps
□ /tmp 與 heapdump 路徑有掛 emptyDir
□ PodDisruptionBudget 已設
□ topologySpreadConstraints 或 podAntiAffinity（分散節點）
□ NetworkPolicy 限制管理 port 來源
□ 映像用具體版本標籤，不是 latest
```

### 驗證（部署後）

```
□ /actuator/health 回 200 且 status=UP
□ /actuator/info 顯示正確的版本與 git commit
□ 啟動日誌沒有 "No active profile set"
□ 啟動日誌的 "Exposing N endpoints" 數量符合預期
□ 滾動更新過程中持續打請求，全部 200（8.7 的驗證腳本）
□ Prometheus 抓得到指標
□ 日誌有正確送到日誌平台，且有 traceId
□ 排程任務出現在 /actuator/scheduledtasks（第 06 章）
□ 回滾指令已驗證可用（kubectl rollout undo）
```

---

## 8.13 本章練習

### 練習 1：找出 Dockerfile 的問題

```dockerfile
FROM openjdk:21
WORKDIR /app
COPY . .
RUN ./mvnw clean package
COPY target/shop-service-1.4.2.jar app.jar
EXPOSE 8080
ENV JAVA_OPTS="-Xmx1g"
ENTRYPOINT java $JAVA_OPTS -jar app.jar
```

列出所有問題並寫出修正版。

<details>
<summary>參考解答</summary>

**九個問題：**

| # | 問題 | 後果 |
|---|---|---|
| 1 | `openjdk:21` | 已停止維護，沒有安全更新 |
| 2 | 單階段建置 | Maven、原始碼、`.git` 全部進最終映像（大 500 MB+，且洩漏原始碼） |
| 3 | `COPY . .` 在 build 之前 | 任何檔案改動都讓依賴下載快取失效 |
| 4 | 沒有 `.dockerignore` | `.git`、`target/`、密鑰檔全被複製進去 |
| 5 | 沒有分層 | 每次部署推送整個 jar 層 |
| 6 | **用 root 執行** | 安全風險 |
| 7 | 版本號寫死在 `COPY` | 改版本要改 Dockerfile |
| 8 | `-Xmx1g` 寫死 | 容器 limit 也是 1g 時必定 OOMKilled |
| 9 | **`ENTRYPOINT` shell 形式** | SIGTERM 傳不到 JVM，優雅關閉失效 |

**另外還有：** 沒有 tzdata（時區問題）、沒有健康檢查、沒有 OOM 處理參數。

**修正版：**

```dockerfile
# syntax=docker/dockerfile:1.7

# ══════════ 建置階段 ══════════
FROM eclipse-temurin:21-jdk-alpine AS builder
WORKDIR /build

# 修正 3：先只複製依賴描述檔
COPY .mvn/ .mvn/
COPY mvnw pom.xml ./
RUN --mount=type=cache,target=/root/.m2 ./mvnw dependency:go-offline -B -q

COPY src/ src/
RUN --mount=type=cache,target=/root/.m2 ./mvnw clean package -DskipTests -B -q

# 修正 5、7：提取分層，且不寫死版本號（用 *.jar）
RUN java -Djarmode=tools -jar target/*.jar extract --layers --destination extracted

# ══════════ 執行階段 ══════════
# 修正 1、2：維護中的 JRE 映像，且 builder 階段不進最終映像
FROM eclipse-temurin:21-jre-alpine AS runtime

# 修正：tzdata（第 06 章的時區問題）
RUN apk add --no-cache curl tzdata && rm -rf /var/cache/apk/*
ENV TZ=Asia/Taipei

# 修正 6：非 root 使用者
RUN addgroup -S -g 10001 spring && \
    adduser -S -u 10001 -G spring -h /app -s /sbin/nologin spring

WORKDIR /app

# 修正 5：依變動頻率由低到高複製
COPY --from=builder --chown=spring:spring /build/extracted/dependencies/          ./
COPY --from=builder --chown=spring:spring /build/extracted/spring-boot-loader/    ./
COPY --from=builder --chown=spring:spring /build/extracted/snapshot-dependencies/ ./
COPY --from=builder --chown=spring:spring /build/extracted/application/           ./

USER 10001:10001
EXPOSE 8080 8081

# 修正 8：百分比而非寫死
ENV JAVA_OPTS="\
  -XX:MaxRAMPercentage=70.0 \
  -XX:+UseG1GC \
  -XX:+ExitOnOutOfMemoryError \
  -XX:+HeapDumpOnOutOfMemoryError \
  -XX:HeapDumpPath=/tmp/heapdump.hprof \
  -Djava.io.tmpdir=/tmp \
  -Dfile.encoding=UTF-8"

HEALTHCHECK --interval=15s --timeout=3s --start-period=45s --retries=3 \
  CMD curl -fsS http://localhost:8081/actuator/health/liveness || exit 1

# 修正 9：exec 形式，讓 java 成為 PID 1
ENTRYPOINT ["sh", "-c", "exec java $JAVA_OPTS org.springframework.boot.loader.launch.JarLauncher"]
```

**修正 4：`.dockerignore`**

```gitignore
target/
build/
.git/
.gitignore
.idea/
*.iml
.env
application-local.yml
application-prod.yml
*.pem
*.key
*.jks
*.md
docs/
```

**效果對照：**

| | 修正前 | 修正後 |
|---|---|---|
| 映像大小 | 約 950 MB | 約 205 MB |
| 改一行程式碼的建置時間 | 3 分 20 秒 | 25 秒 |
| 改一行程式碼的推送量 | 950 MB | 1.2 MB |
| `docker stop` 耗時 | 10 秒（被 SIGKILL） | 2 秒 |
| 執行使用者 | root | UID 10001 |

</details>

### 練習 2：診斷 OOMKilled

Pod 每隔約 40 分鐘就被 `OOMKilled` 重啟。設定如下：

```yaml
resources:
  limits:
    memory: "1Gi"
env:
  - name: JAVA_OPTS
    value: "-Xmx1g -XX:+UseG1GC"
```

`/actuator/prometheus` 顯示 heap 用量穩定在 600 MB 左右，沒有持續上升。

<details>
<summary>參考解答</summary>

**根因：`-Xmx1g` 等於容器 limit，完全沒有留空間給非堆積記憶體。**

```
容器 limit：1024 MB

JVM 實際用量：
  Heap（-Xmx1g）              最多 1024 MB   ← 光這個就用完 limit 了
  + Metaspace                    約 120 MB
  + Code Cache                   約  80 MB
  + Thread Stacks（200 × 1 MB）  約 200 MB
  + GC 資料結構                  約  60 MB
  + Direct Memory                約  40 MB
  + JVM 本身 + musl              約  30 MB
  ─────────────────────────────────────────
  合計最壞情況                   約 1554 MB   ← 遠超 1024 MB
```

**「heap 穩定在 600 MB」正是關鍵線索**：
heap 沒有洩漏，所以不是程式碼的記憶體洩漏問題，
而是「heap + 非堆積」加起來超過容器限制。

**為什麼是 40 分鐘**：JIT 編譯累積 Code Cache、類別載入累積 Metaspace、
執行緒池慢慢擴充到 max — 這些非堆積用量會隨時間緩慢增長，
大約 40 分鐘後總量突破 1 GB。

**修正：**

```yaml
resources:
  requests:
    memory: "768Mi"
  limits:
    memory: "1536Mi"                   # ★ 提高 limit ★
env:
  - name: JAVA_OPTS
    value: >-
      -XX:MaxRAMPercentage=70.0        # ★ 1536 × 70% = 1075 MB heap ★
      -XX:MaxMetaspaceSize=256m        # ★ 明確上限，避免無限成長 ★
      -XX:ReservedCodeCacheSize=128m
      -XX:MaxDirectMemorySize=128m
      -Xss512k                         # ★ 執行緒堆疊減半（200 條省 100 MB）★
      -XX:+UseG1GC
      -XX:+ExitOnOutOfMemoryError
      -XX:+HeapDumpOnOutOfMemoryError
      -XX:HeapDumpPath=/dump/heapdump.hprof
      -XX:NativeMemoryTracking=summary  # ★ 讓下次可以精確診斷 ★
```

**診斷步驟（下次再遇到時）：**

```bash
# ① 確認是被誰殺的
kubectl describe pod shop-service-xxx | grep -A5 'Last State'
#     Last State:  Terminated
#       Reason:    OOMKilled       ← 確認
#       Exit Code: 137

# ② 看容器層級的記憶體用量（不只 heap）
kubectl top pod shop-service-xxx
# 或
container_memory_working_set_bytes{pod="shop-service-xxx"}

# ③ 用 NMT 看非堆積的細目（★ 最有用的一步 ★）
kubectl exec shop-service-xxx -- jcmd 1 VM.native_memory summary
```

```
Native Memory Tracking:
Total: reserved=2145MB, committed=1487MB
-                 Java Heap (reserved=1024MB, committed=628MB)
-                     Class (reserved=280MB, committed=132MB)     ← Metaspace
-                    Thread (reserved=213MB, committed=213MB)     ← ★ 執行緒堆疊 ★
-                      Code (reserved=142MB, committed=94MB)      ← Code Cache
-                        GC (reserved=78MB,  committed=78MB)
-                  Internal (reserved=12MB,  committed=12MB)
-                    Symbol (reserved=28MB,  committed=28MB)
```

**從這份輸出可以看出**：`Thread` 佔了 213 MB。
用 `/actuator/metrics/jvm.threads.live` 查會發現有 210 條執行緒
（Tomcat 200 + 排程 8 + 非同步池）。

**兩種解法：**

```yaml
# 解法 A：減少執行緒數
server:
  tomcat:
    threads:
      max: 100                    # 200 → 100，省 100 MB

# 解法 B：改用虛擬執行緒（第 06 章 6.7）
spring:
  threads:
    virtual:
      enabled: true               # 虛擬執行緒不佔 1 MB 堆疊
```

> **這題的核心教訓：**
> **「heap 沒有洩漏」不代表「記憶體沒問題」。**
> 容器化的 JVM 有一大半記憶體在 heap 之外，
> 只監控 `jvm_memory_used_bytes{area="heap"}` 會漏掉真正的問題。
>
> **一定要同時監控 `container_memory_working_set_bytes`**（容器實際用量），
> 並在它超過 limit 的 85% 時告警。

</details>

### 練習 3：設計零停機部署

現況：3 個副本，滾動更新時使用者會看到約 5 秒的 502。設定如下：

```yaml
spec:
  replicas: 3
  strategy:
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 1
  template:
    spec:
      containers:
        - name: shop
          image: shop-service:1.4.2
          readinessProbe:
            httpGet: { path: /actuator/health, port: 8080 }
            initialDelaySeconds: 60
            periodSeconds: 10
```

```yaml
# application.yml
server:
  port: 8080
```

```dockerfile
ENTRYPOINT java -jar /app.jar
```

找出所有原因並修正。

<details>
<summary>參考解答</summary>

**六個原因：**

| # | 問題 | 造成的症狀 |
|---|---|---|
| 1 | `ENTRYPOINT` shell 形式 | SIGTERM 傳不到 JVM → 舊 Pod 的請求被硬切 → **502** |
| 2 | 沒有 `server.shutdown: graceful` | 即使收到 SIGTERM 也立刻關閉 → **502** |
| 3 | 沒有 `preStop` hook | LB 更新前就開始關閉 → **502** |
| 4 | 沒有 `terminationGracePeriodSeconds` | 用預設 30 秒（勉強夠，但沒有預算規劃） |
| 5 | `maxUnavailable: 1` | 更新期間只有 2 個副本可用 → 尖峰時可能過載 → **503** |
| 6 | `readinessProbe` 用 `/actuator/health` + `initialDelaySeconds: 60` | ① 檢查了所有依賴（Redis 抖動就整個 Pod 被移除）② 60 秒硬等，新 Pod 遲遲不接流量，拉長整個更新窗口 |

**修正版：**

```yaml
# application.yml
server:
  port: 8080
  shutdown: graceful                              # 修正 2

spring:
  lifecycle:
    timeout-per-shutdown-phase: 25s
  task:
    execution:
      shutdown:
        await-termination: true
        await-termination-period: 20s
    scheduling:
      shutdown:
        await-termination: true
        await-termination-period: 20s

management:
  server:
    port: 8081                                    # 管理 port 分離（第 05 章）
  endpoint:
    health:
      probes:
        enabled: true
      group:
        liveness:
          include: livenessState                  # 修正 6：不含外部依賴
        readiness:
          include: readinessState,db
```

```dockerfile
# 修正 1
ENTRYPOINT ["sh", "-c", "exec java $JAVA_OPTS org.springframework.boot.loader.launch.JarLauncher"]
```

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: shop-service
spec:
  replicas: 3
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 0                           # 修正 5
  template:
    spec:
      terminationGracePeriodSeconds: 60           # 修正 4：10(preStop) + 25(shutdown) + 緩衝

      containers:
        - name: shop
          image: shop-service:1.4.3

          lifecycle:
            preStop:
              exec:
                command: ["sh", "-c", "sleep 10"]  # 修正 3

          # 修正 6：三種探針各司其職
          startupProbe:
            httpGet: { path: /actuator/health/liveness, port: 8081 }
            periodSeconds: 5
            failureThreshold: 24                   # 最多等 120 秒（取代 initialDelaySeconds）

          readinessProbe:
            httpGet: { path: /actuator/health/readiness, port: 8081 }
            periodSeconds: 3                       # 更頻繁，讓新 Pod 早點接流量
            failureThreshold: 2
            timeoutSeconds: 2

          livenessProbe:
            httpGet: { path: /actuator/health/liveness, port: 8081 }
            periodSeconds: 10
            failureThreshold: 3

---
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: shop-service
spec:
  minAvailable: 2
  selector:
    matchLabels:
      app: shop-service
```

**修正後的時序（一個 Pod 的更新過程）：**

```
t=0     K8s 建立新 Pod（maxSurge: 1）
t=0     並行：舊 Pod 開始 preStop（sleep 10）
t=0     並行：舊 Pod 從 endpoints 移除的流程開始
t=2     舊 Pod 已從 LB 移除（不再有新請求進來）
t=10    preStop 結束 → SIGTERM → Spring graceful shutdown 開始
t=12    舊 Pod 現有請求處理完，JVM 退出
t=15    新 Pod startupProbe 通過
t=18    新 Pod readinessProbe 通過 → 加入 endpoints → 開始接流量
        （★ 期間可用副本數一直是 3 或 4，從未低於 3 ★）
```

**驗證：**

```bash
# 視窗 1：持續打請求
$ while true; do
    printf '%s %s\n' "$(date +%T.%3N)" \
      "$(curl -s -o /dev/null -w '%{http_code}' https://shop.example.com/orders/1)"
    sleep 0.1
  done | tee rollout.log

# 視窗 2：滾動更新
$ kubectl set image deployment/shop-service shop=shop-service:1.4.3
$ kubectl rollout status deployment/shop-service

# 檢查
$ grep -cv ' 200$' rollout.log
0                                    # ★ 零掉包 ★

# 順便確認可用副本數從未低於 3
$ kubectl get deployment shop-service -w
NAME           READY   UP-TO-DATE   AVAILABLE
shop-service   3/3     0            3
shop-service   4/3     1            3        ← maxSurge 生效，多開一個
shop-service   3/3     1            3        ← 舊的關掉，可用數仍是 3
```

**額外建議：加上 `Retry-After` 與連線關閉標頭**

如果 LB 有連線重用（Keep-Alive），舊 Pod 上的長連線可能還在。
可以在關閉時回應 `Connection: close`：

```java
@Component
public class ShutdownHeaderFilter extends OncePerRequestFilter {

    private final ShutdownCoordinator coordinator;

    public ShutdownHeaderFilter(ShutdownCoordinator coordinator) {
        this.coordinator = coordinator;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response,
                                    FilterChain chain) throws ServletException, IOException {
        if (coordinator.isShuttingDown()) {
            // 告訴用戶端「這個連線用完就關」，不要繼續重用
            response.setHeader("Connection", "close");
        }
        chain.doFilter(request, response);
    }
}
```

</details>

### 練習 4：建置最佳化

CI 的 Docker 建置每次都要 6 分鐘，其中 4 分鐘在下載 Maven 依賴。
映像推送每次都要 48 MB。設計最佳化方案。

<details>
<summary>參考解答</summary>

#### 問題 1：每次都重新下載依賴（4 分鐘）

**原因**：`COPY . .` 或 `COPY src/` 在依賴下載之前，
任何原始碼改動都讓那一層失效，後續的 `RUN ./mvnw` 也全部重跑。

**解法 A：正確的 `COPY` 順序**

```dockerfile
COPY .mvn/ .mvn/
COPY mvnw pom.xml ./
RUN ./mvnw dependency:go-offline -B -q     # ← 只有改 pom.xml 才會重跑
COPY src/ src/
RUN ./mvnw clean package -DskipTests -B -q
```

**解法 B：BuildKit cache mount（更好，跨建置共用）**

```dockerfile
# syntax=docker/dockerfile:1.7
RUN --mount=type=cache,target=/root/.m2 \
    ./mvnw dependency:go-offline -B -q
```

> **`cache mount` 比「靠層快取」更強**：
> 即使 `pom.xml` 改了（新增一個依賴），也只需要下載**那一個新依賴**，
> 而不是全部重新下載。

**解法 C：CI 的 registry cache**

```yaml
- uses: docker/build-push-action@v6
  with:
    cache-from: type=registry,ref=registry.example.com/shop/shop-service:buildcache
    cache-to: type=registry,ref=registry.example.com/shop/shop-service:buildcache,mode=max
```

**這一項讓「不同的 CI runner」也能共用快取**——GitHub Actions 每次都是新機器，
沒有這個設定的話本機快取完全用不上。

**解法 D：在 CI 外面先建 jar（最快，但耦合較高）**

```yaml
- uses: actions/setup-java@v4
  with:
    java-version: '21'
    distribution: 'temurin'
    cache: maven                        # ★ GitHub Actions 內建的 Maven 快取 ★

- run: ./mvnw -B package -DskipTests

- uses: docker/build-push-action@v6
  with:
    file: Dockerfile.jar-only           # 只做 COPY + extract，不編譯
```

```dockerfile
# Dockerfile.jar-only
FROM eclipse-temurin:21-jre-alpine AS extractor
WORKDIR /build
COPY target/*.jar app.jar
RUN java -Djarmode=tools -jar app.jar extract --layers --destination extracted

FROM eclipse-temurin:21-jre-alpine
# ... 後續同前 ...
```

#### 問題 2：每次推送 48 MB

**原因**：沒有分層，或分層的 `COPY` 順序寫反。

**解法：分層 + 正確順序**

```dockerfile
COPY --from=builder /build/extracted/dependencies/          ./   # 46 MB，很少變
COPY --from=builder /build/extracted/spring-boot-loader/    ./   # 252 KB
COPY --from=builder /build/extracted/snapshot-dependencies/ ./   # 0 B
COPY --from=builder /build/extracted/application/           ./   # 1.2 MB，每次變
```

**驗證分層有效：**

```bash
# 改一行程式碼後重建
$ docker build -t shop-service:test2 .
...
 => CACHED [runtime 5/8] COPY --from=builder .../dependencies/ ./          ← ★ CACHED ★
 => CACHED [runtime 6/8] COPY --from=builder .../spring-boot-loader/ ./    ← ★ CACHED ★
 => CACHED [runtime 7/8] COPY --from=builder .../snapshot-dependencies/ ./ ← ★ CACHED ★
 =>        [runtime 8/8] COPY --from=builder .../application/ ./           ← 只有這層重建

# 推送時只上傳變動的層
$ docker push registry.example.com/shop/shop-service:test2
5f70bf18a086: Layer already exists
a3f8c21b9d4e: Layer already exists
1b2c3d4e5f60: Layer already exists
9a8b7c6d5e4f: Pushed          1.2MB      ← ★ 只有 1.2 MB ★
```

#### 完整的最佳化後 CI

```yaml
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-java@v4
        with:
          java-version: '21'
          distribution: 'temurin'
          cache: maven                            # ① Maven 依賴快取

      - name: 建置 jar
        run: ./mvnw -B package -DskipTests

      - uses: docker/setup-buildx-action@v3

      - uses: docker/login-action@v3
        with:
          registry: ${{ env.REGISTRY }}
          username: ${{ secrets.REGISTRY_USER }}
          password: ${{ secrets.REGISTRY_TOKEN }}

      - name: 建置並推送
        uses: docker/build-push-action@v6
        with:
          context: .
          file: Dockerfile.jar-only
          push: true
          tags: ${{ env.REGISTRY }}/shop/shop-service:${{ github.sha }}
          cache-from: type=gha                    # ② Docker 層快取
          cache-to: type=gha,mode=max
```

#### 效果對照

| | 最佳化前 | 最佳化後 |
|---|---|---|
| 首次建置 | 6 分 10 秒 | 5 分 40 秒 |
| **改一行程式碼** | **6 分 10 秒** | **48 秒** |
| 改一個依賴 | 6 分 10 秒 | 2 分 20 秒 |
| 推送量（程式碼變更） | 48 MB | 1.2 MB |

**最重要的一點**：「改一行程式碼」是**最常見的情況**（一天可能十幾次）。
把它從 6 分鐘降到 48 秒，是開發體驗最大的改善。

#### 額外建議：不要在 Dockerfile 裡跑測試

```dockerfile
# ❌ 不要這樣
RUN ./mvnw clean package                # 會跑測試，讓建置變慢且無法平行
```

測試應該在 CI 的獨立 job 跑（第 07 章的分流），理由：

1. **可以與建置平行**（省時間）。
2. **測試報告可以上傳成 artifact**（Docker 裡面的報告拿不出來）。
3. **測試失敗時不用等映像建置**（快速回饋）。
4. **Testcontainers 在 Docker 裡跑要 DinD**（複雜且慢）。

</details>

---

## 8.14 驗收清單

- [ ] 我能解剖 Spring Boot 可執行 jar 的四個部分，並說出 `MANIFEST.MF` 裡 `Main-Class` 與 `Start-Class` 的差別。
- [ ] 我知道 `JarLauncher` 用自訂 ClassLoader 直接讀巢狀 jar，不需要解壓縮。
- [ ] 我知道 `JarLauncher` 的套件在 Boot 3.2 搬過家。
- [ ] 我能說出為什麼不該用 fat jar（shade），特別是 `META-INF/services` 衝突。
- [ ] 我會用 `java -Djarmode=tools ... extract --layers` 提取分層。
- [ ] 我知道 Boot 3.3 起 `layertools` 已被 `tools` 取代。
- [ ] **我知道 `COPY pom.xml` 要在 `COPY src/` 之前，並能說出效益。**
- [ ] **我知道四個分層 `COPY` 的順序要依變動頻率由低到高。**
- [ ] 我會寫多階段 Dockerfile，讓 builder 階段不進最終映像。
- [ ] 我知道要用維護中的基底映像（不是 `openjdk:*`）與 JRE 而非 JDK。
- [ ] 我知道容器一定要用非 root，且 `USER` 要寫數字 UID。
- [ ] **我知道 `ENTRYPOINT` 要用 exec 形式，並會用 `docker exec ps -ef` 驗證 java 是 PID 1。**
- [ ] 我知道 Alpine 要裝 tzdata，否則 `TZ` 無效。
- [ ] 我知道 `.dockerignore` 一定要排除 `.git` 與密鑰檔。
- [ ] **我知道不能寫死 `-Xmx` 等於容器 limit，並能列出 JVM 的非堆積記憶體項目。**
- [ ] 我知道 `-XX:+ExitOnOutOfMemoryError` 為什麼比「讓 JVM 半死著」好。
- [ ] 我知道 Buildpacks 與 Jib 的取捨，以及 Buildpacks 的 Java Memory Calculator 價值。
- [ ] 我知道 CDS 與 AOT 能縮短啟動時間，也知道 AOT 會固化 `@Conditional` 結果。
- [ ] 我能判斷 GraalVM native image 值不值得（並知道它會犧牲尖峰吞吐量）。
- [ ] **我知道一個請求從進來到回應寫出，全程佔用同一條 worker 執行緒。**
- [ ] 我能用 `每秒請求數 × 平均回應時間` 估出需要的執行緒數。
- [ ] **我能說出 `threads.max` / `max-connections` / `accept-count` 三層的關係。**
- [ ] 我知道 `threads.max` 預設 200、HikariCP 預設 10，兩者不匹配的後果是「集體逾時」。
- [ ] **我知道「壓測時 CPU 只有 30% 但回應時間爆炸」的瓶頸在執行緒池佇列，不在 CPU。**
- [ ] 我會監控 `tomcat_threads_busy_threads` 與 `hikaricp_connections_pending`。
- [ ] 我知道 HikariCP 的 `connection-timeout` 預設 30 秒太長，該調成 3 秒快速失敗。
- [ ] 我會確認容器裡 `java` 看到的 CPU 數，也知道 `500m` 會被看成 1 顆。
- [ ] **我知道虛擬執行緒解決的是「執行緒太貴」，不是「下游容量不足」，瓶頸會往下游移。**
- [ ] 我知道 JDK 21 上 `synchronized` 會釘住載體執行緒，要改用 `ReentrantLock`。
- [ ] **我知道 `RestClient` / `RestTemplate` 不設逾時就是無限等待，這是最常見的單一事故原因。**
- [ ] 我能用 `jstack` 認出「一大票執行緒卡在同一個 socket read」的畫面。
- [ ] **我知道優雅關閉要三層都設對：Spring、容器、K8s。**
- [ ] 我知道 `server.shutdown` 預設是 `immediate`。
- [ ] **我能解釋 `preStop: sleep 10` 為什麼必要（endpoints 更新與 SIGTERM 的競態）。**
- [ ] 我知道 `terminationGracePeriodSeconds` 要大於 preStop + shutdown timeout。
- [ ] 我知道長時間批次任務要主動檢查關閉訊號。
- [ ] 我會用 Secret 掛載 + `configtree` 而不是環境變數傳密鑰。
- [ ] 我知道 `readOnlyRootFilesystem` 要搭配 `/tmp` 的 emptyDir。
- [ ] 我知道 `maxUnavailable: 0` 與 `PodDisruptionBudget` 的作用。
- [ ] 我知道 CPU limit 造成的 CFS 節流問題。
- [ ] 我會產生 SBOM 並掃描映像漏洞，也知道 `ignore-unfixed` 為什麼重要。
- [ ] 我不會用 `latest` 標籤部署。
- [ ] **我會用「持續打請求 + 滾動更新」驗證零停機。**
- [ ] 我能診斷 OOMKilled（用 NMT 看非堆積用量），也知道要監控 `container_memory_working_set_bytes`。
- [ ] 我不在 Dockerfile 裡跑測試。
- [ ] 我能執行完整的上線前檢查清單。

---

完成後請前往 [09-spring-boot-3-and-pitfalls.md](./09-spring-boot-3-and-pitfalls.md)。
