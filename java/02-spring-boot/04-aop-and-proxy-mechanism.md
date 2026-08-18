# 第 04 章：AOP 與代理機制

> 這是整個 Spring 生態裡**最多人「會用但不懂」的一章**，也是最常發生「明明加了註解卻沒作用」的地方。
>
> `@Transactional` 不 rollback、`@Async` 還是同步、`@Cacheable` 每次都查資料庫、`@PreAuthorize` 沒擋住——
> 這些症狀有 90% 是**同一個原因**：你呼叫的是**原始物件**，而不是**代理物件**。
>
> 這一章要做三件事：
> 1. 親手寫一次 JDK 動態代理與 CGLIB，讓「代理」不再是抽象名詞。
> 2. 把 Spring AOP 的織入時機，接回第 01 章的 Bean 生命週期。
> 3. 把「自呼叫失效」從「一句口訣」變成「你能畫出記憶體裡發生什麼事」。

---

## 4.1 學習目標

完成本章後，你應該可以：

- 說出 AOP 解決的問題，以及它與「繼承」「工具類別」「裝飾器」的差別。
- 精確使用 AOP 的七個名詞：Aspect、Join Point、Pointcut、Advice、Target、Proxy、Weaving。
- **手寫**一個 JDK 動態代理與一個 CGLIB 代理，說出兩者的限制。
- 說明 Spring 什麼時候用 JDK Proxy、什麼時候用 CGLIB，以及 Spring Boot 為什麼預設 CGLIB。
- 把 AOP 代理的產生時機，指到 Bean 生命週期的哪一步。
- 熟練 `@Aspect` 與五種 Advice，並說出它們的**實際執行順序**。
- 讀寫切點運算式：`execution`、`within`、`@annotation`、`args`、`bean`、`this` vs `target`。
- 用「自訂註解 + `@annotation` 切點」做出可讀性最好的切面。
- **畫出自呼叫失效的完整過程**，並用四種方式解決它。
- 列出 `@Transactional` 的八種失效情境，並各自說明原因。
- 說明 AOP 對效能、除錯、`getClass()`、`equals()` 的實際影響。
- 為訂單服務實作稽核、計時、重試三個切面，並為它們寫測試。
- 判斷什麼時候 Spring AOP 不夠用、需要換成 AspectJ 完全織入。

---

## 4.2 先看見痛：每個方法都要做同一件事

需求很常見：**營運要求每個對外 API 都要記錄執行時間，超過 500ms 要警告。**

### 版本 0：每個方法自己寫

```java
package com.example.shop.order;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.math.BigDecimal;
import java.util.List;

@Service
public class OrderService {

    private static final Logger log = LoggerFactory.getLogger(OrderService.class);

    private final OrderRepository repository;

    public OrderService(OrderRepository repository) {
        this.repository = repository;
    }

    public Order placeOrder(String customerName, BigDecimal amount) {
        long start = System.nanoTime();                          // ← 樣板程式碼
        try {
            // ─── 真正的業務邏輯只有這三行 ───
            Order order = new Order(null, customerName, amount, "CREATED");
            Order saved = repository.save(order);
            return saved;
            // ──────────────────────────────
        } finally {
            long ms = (System.nanoTime() - start) / 1_000_000;   // ← 樣板程式碼
            if (ms > 500) {
                log.warn("placeOrder 執行 {} ms，超過門檻", ms);
            } else {
                log.debug("placeOrder 執行 {} ms", ms);
            }
        }
    }

    public List<Order> listAll() {
        long start = System.nanoTime();                          // ← 又一次
        try {
            return repository.findAll();
        } finally {
            long ms = (System.nanoTime() - start) / 1_000_000;
            if (ms > 500) {
                log.warn("listAll 執行 {} ms，超過門檻", ms);
            } else {
                log.debug("listAll 執行 {} ms", ms);
            }
        }
    }

    // ... 另外 15 個方法，每一個都長這樣 ...
}
```

**問題清單：**

| 問題 | 後果 |
|---|---|
| 業務邏輯 3 行，樣板 12 行 | 讀程式碼時要先跳過雜訊才看得到重點 |
| 每個方法複製一次 | 40 個 Service × 平均 8 個方法 = 320 份複製 |
| 門檻要從 500 改成 300 | 改 320 個地方 |
| 有人忘記加 | 出事時剛好那支 API 沒有數據 |
| 方法名稱要手寫 | 複製貼上時忘了改，log 顯示錯誤的方法名 |

> **真實案例**：某團隊真的用複製貼上做這件事。
> 上線後查效能問題時發現 `updateOrder` 的日誌一直顯示 `placeOrder`——
> 因為當初是從 `placeOrder` 複製過去的，方法名稱那個字串沒改。
> 於是他們花了兩天在錯的方法上找瓶頸。

### 為什麼「抽個工具方法」解決不了

```java
// 想法：把樣板抽成工具方法
public Order placeOrder(String customerName, BigDecimal amount) {
    return Timing.measure("placeOrder", () -> {
        Order order = new Order(null, customerName, amount, "CREATED");
        return repository.save(order);
    });
}
```

好一點，但**還是每個方法都要改，還是可能忘記，方法名稱還是手寫字串**。

### 為什麼「繼承」也解決不了

```java
public abstract class TimedService {
    protected <T> T timed(String name, Supplier<T> action) { /* ... */ }
}

@Service
public class OrderService extends TimedService {  // Java 只能單一繼承，這個位置很珍貴
    // 而且每個方法還是要自己呼叫 timed(...)
}
```

### AOP 的答案：讓「呼叫」這件事本身被攔截

```java
@Service
public class OrderService {

    private final OrderRepository repository;

    public OrderService(OrderRepository repository) {
        this.repository = repository;
    }

    // 業務邏輯回歸乾淨
    public Order placeOrder(String customerName, BigDecimal amount) {
        Order order = new Order(null, customerName, amount, "CREATED");
        return repository.save(order);
    }

    public List<Order> listAll() {
        return repository.findAll();
    }
}
```

```java
package com.example.shop.observability;

import org.aspectj.lang.ProceedingJoinPoint;
import org.aspectj.lang.annotation.Around;
import org.aspectj.lang.annotation.Aspect;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

@Aspect
@Component
public class TimingAspect {

    private static final Logger log = LoggerFactory.getLogger(TimingAspect.class);
    private static final long THRESHOLD_MS = 500;

    /** 攔截 com.example.shop 底下所有 @Service 的 public 方法 */
    @Around("within(com.example.shop..*) && @within(org.springframework.stereotype.Service)")
    public Object measure(ProceedingJoinPoint pjp) throws Throwable {
        long start = System.nanoTime();
        try {
            return pjp.proceed();
        } finally {
            long ms = (System.nanoTime() - start) / 1_000_000;
            String name = pjp.getSignature().toShortString();   // 方法名稱自動取得，不會抄錯
            if (ms > THRESHOLD_MS) {
                log.warn("{} 執行 {} ms，超過 {} ms 門檻", name, ms, THRESHOLD_MS);
            } else {
                log.debug("{} 執行 {} ms", name, ms);
            }
        }
    }
}
```

**一個類別，涵蓋整個專案所有 Service 的所有方法。**
門檻要改 → 改一行。新增 Service → 自動涵蓋，不可能忘記。

---

## 4.3 AOP 的七個名詞

先把名詞定義清楚，後面才不會誤讀文件。

```
┌──────────────────────────────────────────────────────────────┐
│  Aspect（切面）                                                │
│  ───────────                                                  │
│  一個「橫切關注點」的模組化單位。                                  │
│  = Pointcut（在哪裡切） + Advice（切了要做什麼）                   │
│  程式碼上就是一個標了 @Aspect 的類別。                             │
│                                                               │
│  ┌────────────────────────┐  ┌──────────────────────────┐    │
│  │ Pointcut（切點）         │  │ Advice（通知）             │    │
│  │ 「哪些方法要被攔截」的     │  │ 「攔截到之後要做什麼」      │    │
│  │  運算式                  │  │  的程式碼                  │    │
│  │  execution(* *..*(..))  │  │  @Before / @Around ...   │    │
│  └────────────────────────┘  └──────────────────────────┘    │
└──────────────────────────────────────────────────────────────┘

Join Point（連接點）  程式執行過程中「可以被攔截的點」。
                     ⚠️ Spring AOP 只支援一種：方法執行（method execution）。
                     完整的 AspectJ 還支援欄位存取、建構子呼叫、例外處理等。

Target（目標物件）    被代理的原始物件（你 new 出來的那個 OrderService）。

Proxy（代理物件）     Spring 產生的替身。容器裡放的、被注入到別處的，是它。

Weaving（織入）      把 Aspect 套用到 Target 上、產生 Proxy 的過程。
                     Spring AOP 是「執行期織入」（runtime weaving）。
```

### 一張圖看清楚呼叫路徑

```
   Controller（呼叫端）
        │
        │  orderService.placeOrder(...)
        ▼
   ┌─────────────────────────────────────┐
   │  Proxy（代理物件）★ 你注入到的是這個 ★ │
   │                                     │
   │   ① 執行 @Before / @Around 前半      │
   │   ② ────────────────────┐           │
   │   ④ 執行 @After / @Around 後半       │
   └────────────────────────│────────────┘
                            │ 委派
                            ▼
   ┌─────────────────────────────────────┐
   │  Target（原始物件）                   │
   │   ③ 真正的 placeOrder() 業務邏輯      │
   └─────────────────────────────────────┘
```

**記住這張圖。** 4.14 講自呼叫失效時，你只需要問一個問題：
**「這次呼叫有沒有經過上面那個框？」**

---

## 4.4 手寫 JDK 動態代理

不要把代理當黑箱。它就是 Java 的標準功能，20 行就能寫完。

### 前置：介面與實作

```java
package com.example.proxydemo;

import java.math.BigDecimal;

public interface OrderService {
    String placeOrder(String customer, BigDecimal amount);
    void cancelOrder(long orderId);
}
```

```java
package com.example.proxydemo;

import java.math.BigDecimal;

public class OrderServiceImpl implements OrderService {

    @Override
    public String placeOrder(String customer, BigDecimal amount) {
        System.out.println("    [業務] 建立 " + customer + " 的訂單，金額 " + amount);
        return "ORDER-1001";
    }

    @Override
    public void cancelOrder(long orderId) {
        System.out.println("    [業務] 取消訂單 " + orderId);
    }
}
```

### 代理：`InvocationHandler`

```java
package com.example.proxydemo;

import java.lang.reflect.InvocationHandler;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;

/**
 * 所有對代理物件的方法呼叫，都會被轉送到這個 invoke()。
 */
public class TimingInvocationHandler implements InvocationHandler {

    private final Object target;      // 原始物件

    public TimingInvocationHandler(Object target) {
        this.target = target;
    }

    @Override
    public Object invoke(Object proxy, Method method, Object[] args) throws Throwable {
        System.out.println("  [代理] 進入 " + method.getName());
        long start = System.nanoTime();
        try {
            // ★ 關鍵：用反射呼叫「原始物件」的方法 ★
            return method.invoke(target, args);
        } catch (InvocationTargetException e) {
            // 反射會把業務例外包一層，要拆開再拋，不然呼叫端收到的型別是錯的
            throw e.getTargetException();
        } finally {
            long ms = (System.nanoTime() - start) / 1_000_000;
            System.out.println("  [代理] 離開 " + method.getName() + "，耗時 " + ms + " ms");
        }
    }
}
```

### 產生代理並使用

```java
package com.example.proxydemo;

import java.lang.reflect.Proxy;
import java.math.BigDecimal;

public class JdkProxyDemo {

    public static void main(String[] args) {
        OrderService target = new OrderServiceImpl();

        OrderService proxy = (OrderService) Proxy.newProxyInstance(
                OrderService.class.getClassLoader(),   // ① 用哪個 ClassLoader 載入代理類別
                new Class<?>[]{OrderService.class},    // ② 代理要實作哪些介面
                new TimingInvocationHandler(target));  // ③ 攔截邏輯

        System.out.println("代理的類別：" + proxy.getClass().getName());
        System.out.println("是 OrderServiceImpl 嗎？ " + (proxy instanceof OrderServiceImpl));
        System.out.println();

        String orderId = proxy.placeOrder("王小明", new BigDecimal("1280"));
        System.out.println("回傳：" + orderId);
        System.out.println();

        proxy.cancelOrder(1001L);
    }
}
```

輸出：

```
代理的類別：jdk.proxy1.$Proxy0
是 OrderServiceImpl 嗎？ false        ← ★ 注意這行 ★

  [代理] 進入 placeOrder
    [業務] 建立 王小明 的訂單，金額 1280
  [代理] 離開 placeOrder，耗時 1 ms
回傳：ORDER-1001

  [代理] 進入 cancelOrder
    [業務] 取消訂單 1001
  [代理] 離開 cancelOrder，耗時 0 ms
```

### JDK 動態代理的三個關鍵性質

**① 代理類別是執行期產生的，長這樣（概念示意）：**

```java
// JVM 在記憶體裡動態產生的位元組碼，大致等同於：
public final class $Proxy0 extends java.lang.reflect.Proxy implements OrderService {

    private static Method m3;   // placeOrder
    private static Method m4;   // cancelOrder

    public $Proxy0(InvocationHandler h) { super(h); }

    @Override
    public String placeOrder(String customer, BigDecimal amount) {
        try {
            return (String) super.h.invoke(this, m3, new Object[]{customer, amount});
        } catch (RuntimeException | Error e) {
            throw e;
        } catch (Throwable t) {
            throw new UndeclaredThrowableException(t);
        }
    }
    // cancelOrder 同理
}
```

**② 它 `extends Proxy`，所以不可能再 `extends` 你的類別。**
這就是「JDK 代理只能代理介面」的根本原因——**Java 沒有多重繼承**。

**③ `proxy instanceof OrderServiceImpl` 是 `false`。**

這一點會造成實務問題：

```java
// ❌ 在 Spring 裡這樣寫，如果用的是 JDK 代理，會 ClassCastException
@Autowired
private OrderServiceImpl orderService;    // 注入具體類別
```

```
Bean named 'orderServiceImpl' is expected to be of type 'com.example.OrderServiceImpl'
but was actually of type 'jdk.proxy2.$Proxy123'
```

> **這是「一律注入介面，不要注入實作類別」這條規則的真正理由**，
> 不是設計潔癖，是會直接爆炸。

---

## 4.5 手寫 CGLIB 代理

沒有介面的類別怎麼辦？用**繼承**。

```java
package com.example.proxydemo;

import java.math.BigDecimal;

/** 注意：沒有實作任何介面 */
public class InventoryService {

    public void decrease(String sku, int quantity) {
        System.out.println("    [業務] 扣減 " + sku + " 庫存 " + quantity);
    }

    public final void auditLog(String message) {          // ← final 方法
        System.out.println("    [業務] 稽核：" + message);
    }

    private void internalCheck() {                        // ← private 方法
        System.out.println("    [業務] 內部檢查");
    }

    public static void reset() {                          // ← static 方法
        System.out.println("    [業務] 重置");
    }
}
```

Spring 有把 CGLIB 重新打包進 `spring-core`，所以不用額外加依賴：

```java
package com.example.proxydemo;

import org.springframework.cglib.proxy.Enhancer;
import org.springframework.cglib.proxy.MethodInterceptor;
import org.springframework.cglib.proxy.MethodProxy;

import java.lang.reflect.Method;

public class CglibProxyDemo {

    public static void main(String[] args) {
        Enhancer enhancer = new Enhancer();
        enhancer.setSuperclass(InventoryService.class);       // ★ 用「繼承」而不是實作介面 ★
        enhancer.setCallback((MethodInterceptor) CglibProxyDemo::intercept);

        InventoryService proxy = (InventoryService) enhancer.create();

        System.out.println("代理的類別：" + proxy.getClass().getName());
        System.out.println("父類別：" + proxy.getClass().getSuperclass().getName());
        System.out.println("是 InventoryService 嗎？ " + (proxy instanceof InventoryService));
        System.out.println();

        proxy.decrease("SKU-001", 3);
        System.out.println();
        proxy.auditLog("測試 final 方法");     // ← 觀察有沒有被攔截
    }

    private static Object intercept(Object obj, Method method, Object[] args, MethodProxy mp)
            throws Throwable {
        System.out.println("  [代理] 進入 " + method.getName());
        long start = System.nanoTime();
        try {
            // ★ invokeSuper：呼叫「父類別」（也就是原始類別）的實作 ★
            return mp.invokeSuper(obj, args);
        } finally {
            System.out.println("  [代理] 離開 " + method.getName()
                    + "，耗時 " + (System.nanoTime() - start) / 1_000_000 + " ms");
        }
    }
}
```

輸出：

```
代理的類別：com.example.proxydemo.InventoryService$$EnhancerBySpringCGLIB$$1a2b3c4d
父類別：com.example.proxydemo.InventoryService
是 InventoryService 嗎？ true          ← ★ 與 JDK 代理不同 ★

  [代理] 進入 decrease
    [業務] 扣減 SKU-001 庫存 3
  [代理] 離開 decrease，耗時 0 ms

    [業務] 稽核：測試 final 方法          ← ★ final 方法完全沒被攔截！★
```

### CGLIB 的性質與限制

| 性質 | 說明 |
|---|---|
| 不需要介面 | 用繼承，所以任何非 final 的類別都能代理 |
| `instanceof` 成立 | 代理是子類別，可以轉型成原始類別 |
| ❌ **`final` 類別無法代理** | 不能繼承 |
| ❌ **`final` 方法無法攔截** | 不能覆寫（上面的 `auditLog` 就是活生生的例子） |
| ❌ **`private` 方法無法攔截** | 子類別看不到 |
| ❌ **`static` 方法無法攔截** | 靜態方法不參與多型 |
| ⚠️ **建構子會被呼叫兩次** | 一次建原始物件、一次建代理（Spring 用 Objenesis 繞過這點） |
| 需要無參數建構子 | 純 CGLIB 需要；Spring 4.3+ 已用 Objenesis 解決 |

> **上面那張表的後四列，就是 `@Transactional` 失效清單的一半。** 4.16 會整理完整版。

### 代理與欄位：一個很少人知道的坑

```java
public class Counter {
    public int count = 0;                      // public 欄位

    public void increment() { count++; }
}
```

```java
Counter proxy = (Counter) enhancer.create();
proxy.increment();
System.out.println(proxy.count);               // 0 ！不是 1
```

**原因**：CGLIB 代理是**子類別的實例**，它有自己的 `count` 欄位（初始值 0）。
`increment()` 被攔截後委派給父類別的實作——但 `this` 指向的是**代理物件**，
所以改的是代理的欄位……實際上依 Spring 的實作方式（`invokeSuper`）會改到代理物件的欄位，
而 Spring 的做法（委派給獨立的 target 實例）則會改到 target 的欄位，兩邊的 `count` 是**兩份**。

> **實務結論：不要在 Bean 上用 public 欄位，一律用方法存取。**
> 這在有 AOP 的環境下不只是封裝問題，是正確性問題。

---

## 4.6 Spring 怎麼選：JDK 還是 CGLIB

### 決策規則

```
目標類別有實作介面嗎？
   │
   ├─ 有 ──▶ proxyTargetClass = true ?
   │           ├─ true  ──▶ CGLIB
   │           └─ false ──▶ JDK 動態代理
   │
   └─ 沒有 ──▶ CGLIB（別無選擇）
```

### Spring Boot 的預設值

**Spring Boot 從 2.0 起，`spring.aop.proxy-target-class` 預設是 `true`，也就是一律用 CGLIB。**

```yaml
spring:
  aop:
    proxy-target-class: true    # Spring Boot 的預設值
```

翻開 `AopAutoConfiguration` 就看得到：

```java
@AutoConfiguration
@ConditionalOnProperty(prefix = "spring.aop", name = "auto", havingValue = "true",
        matchIfMissing = true)
public class AopAutoConfiguration {

    @Configuration(proxyBeanMethods = false)
    @ConditionalOnClass(Advice.class)
    static class AspectJAutoProxyingConfiguration {

        @Configuration(proxyBeanMethods = false)
        @EnableAspectJAutoProxy(proxyTargetClass = false)
        @ConditionalOnProperty(prefix = "spring.aop", name = "proxy-target-class",
                havingValue = "false")
        static class JdkDynamicAutoProxyConfiguration { }

        @Configuration(proxyBeanMethods = false)
        @EnableAspectJAutoProxy(proxyTargetClass = true)
        @ConditionalOnProperty(prefix = "spring.aop", name = "proxy-target-class",
                havingValue = "true", matchIfMissing = true)   // ★ 預設 true ★
        static class CglibAutoProxyConfiguration { }
    }
}
```

### 為什麼預設改成 CGLIB

| 理由 | 說明 |
|---|---|
| **少踩坑** | 注入具體類別時不會 `ClassCastException` |
| **不強迫抽介面** | 很多 Service 根本只有一個實作，抽介面是為了框架而抽，不是為了設計 |
| **行為一致** | 有介面沒介面都一樣，不會「加了介面之後某個註解突然失效」 |

> **代價**：CGLIB 的限制（final、private、static）現在對所有 Bean 都成立。
> 所以在 Spring Boot 專案裡，**不要在需要 AOP 的方法上用 `final`**。
> Kotlin 專案要特別注意——Kotlin 的類別與方法**預設就是 final**，
> 所以要用 `all-open` 編譯外掛（`kotlin-spring`）把 Spring 相關的類別打開。

### 驗證你的 Bean 到底是什麼

```java
package com.example.shop.debug;

import org.springframework.aop.framework.AopProxyUtils;
import org.springframework.aop.support.AopUtils;
import org.springframework.boot.CommandLineRunner;
import org.springframework.stereotype.Component;

@Component
public class ProxyInspector implements CommandLineRunner {

    private final OrderService orderService;

    public ProxyInspector(OrderService orderService) {
        this.orderService = orderService;
    }

    @Override
    public void run(String... args) {
        System.out.println("注入的類別   ：" + orderService.getClass().getName());
        System.out.println("是代理嗎     ：" + AopUtils.isAopProxy(orderService));
        System.out.println("是 JDK 代理  ：" + AopUtils.isJdkDynamicProxy(orderService));
        System.out.println("是 CGLIB 代理：" + AopUtils.isCglibProxy(orderService));
        System.out.println("原始類別     ：" + AopProxyUtils.ultimateTargetClass(orderService));
    }
}
```

典型輸出：

```
注入的類別   ：com.example.shop.order.OrderService$$SpringCGLIB$$0
是代理嗎     ：true
是 JDK 代理  ：false
是 CGLIB 代理：true
原始類別     ：com.example.shop.order.OrderService
```

> **`ultimateTargetClass()` 在寫框架程式碼時很重要**：
> 例如你要讀方法上的自訂註解，直接對代理類別做反射可能拿不到
> （CGLIB 子類別不會繼承方法上的註解，除非該註解標了 `@Inherited`——而方法註解根本不支援 `@Inherited`）。
> 正確做法是先用 `AopUtils.getTargetClass()` 拿到原始類別再找方法。

---

## 4.7 織入時機：接回 Bean 生命週期

回顧第 01 章 1.11 的生命週期圖，AOP 就在其中一格：

```
建立 Bean：
   3.1 實例化（呼叫建構子）
   3.2 屬性填充（依賴注入）
   3.3 Aware 回呼
   3.4 BeanPostProcessor.postProcessBeforeInitialization()
   3.5 初始化方法（@PostConstruct / afterPropertiesSet）
   3.6 BeanPostProcessor.postProcessAfterInitialization()
        │
        └─ ★★ AnnotationAwareAspectJAutoProxyCreator 在這裡 ★★
              ├─ 找出所有 @Aspect
              ├─ 判斷這個 Bean 有沒有符合任何切點
              ├─ 有 → 建立代理，回傳代理物件
              └─ 沒有 → 原樣回傳
   3.7 放進單例池   ← 放進去的是「代理物件」
```

**兩個非常重要的推論：**

### 推論 1：`@PostConstruct` 裡的 `this` 不是代理

```java
@Service
public class OrderService {

    @PostConstruct
    public void init() {
        // ⚠️ 這時候代理還沒產生（3.5 在 3.6 之前）
        this.warmUpCache();       // 這個呼叫上的 @Transactional / @Cacheable 不會生效
    }

    @Cacheable("orders")
    public void warmUpCache() { }
}
```

### 推論 2：建構子注入的依賴，拿到的是「對方的代理」

```java
@Service
public class OrderService {
    private final PaymentService paymentService;   // 拿到的是 PaymentService 的代理 ✅

    public OrderService(PaymentService paymentService) {
        this.paymentService = paymentService;
    }

    public void placeOrder() {
        paymentService.charge();      // ✅ 經過代理，@Transactional 生效
        this.updateStatus();          // ❌ this 是原始物件，不經過代理
    }

    @Transactional
    public void updateStatus() { }
}
```

**這就是自呼叫失效的完整原因，4.14 會展開。**

---

## 4.8 第一個切面

### 開啟 AOP

```xml
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-aop</artifactId>
</dependency>
```

它會帶進 `aspectjweaver`（提供切點運算式的解析能力，**不是**用來做完全織入）。

**Spring Boot 加了這個依賴就自動開啟 AOP**，不需要 `@EnableAspectJAutoProxy`
（`AopAutoConfiguration` 已經幫你加了）。

### 最小可用的切面

```java
package com.example.shop.observability;

import org.aspectj.lang.JoinPoint;
import org.aspectj.lang.annotation.Aspect;
import org.aspectj.lang.annotation.Before;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

@Aspect        // ① 告訴 Spring 這是一個切面
@Component     // ② 切面本身也必須是一個 Bean，否則不會生效
public class LoggingAspect {

    private static final Logger log = LoggerFactory.getLogger(LoggingAspect.class);

    @Before("execution(* com.example.shop.order.OrderService.*(..))")
    public void logBefore(JoinPoint joinPoint) {
        log.info("即將執行：{}", joinPoint.getSignature().toShortString());
    }
}
```

> ⚠️ **`@Aspect` 沒有 `@Component` 是最常見的「切面沒生效」原因。**
> `@Aspect` 只是一個標記，Spring 必須先把它當成 Bean 掃進來，才會去讀它。

---

## 4.9 切點運算式

這是 AOP 最需要練習的部分。

### `execution`：最常用，可以精確到方法簽章

```
execution(修飾詞? 回傳型別 宣告型別? 方法名(參數) 例外?)
          ↑必填  ↑必填    ↑可選    ↑必填  ↑必填   ↑可選
```

```java
// 任何回傳型別、任何方法、任何參數
execution(* com.example.shop.order.OrderService.*(..))

// 只攔截 public 方法
execution(public * com.example.shop.order.OrderService.*(..))

// 只攔截回傳 Order 的方法
execution(com.example.shop.order.Order com.example.shop.order.OrderService.*(..))

// 只攔截 place 開頭的方法
execution(* com.example.shop.order.OrderService.place*(..))

// 整個套件（不含子套件）
execution(* com.example.shop.order.*.*(..))

// 整個套件「及其子套件」—— 注意兩個點
execution(* com.example.shop..*.*(..))

// 第一個參數是 String，後面隨意
execution(* com.example.shop..*.*(String, ..))

// 恰好兩個參數：String 與 BigDecimal
execution(* com.example.shop..*.*(String, java.math.BigDecimal))

// 恰好一個參數（任何型別）
execution(* com.example.shop..*.*(*))

// 沒有參數
execution(* com.example.shop..*.*())
```

**萬用字元的意思：**

| 符號 | 意義 |
|---|---|
| `*` | 匹配任意「一段」（一個型別、一個方法名、一個參數） |
| `..` | 用在套件：任意層級的子套件；用在參數：任意數量任意型別的參數 |
| `+` | 型別後綴，表示「以及其所有子型別」，如 `OrderService+` |

### `within`：依「類別」過濾（比 `execution` 快）

```java
within(com.example.shop.order.OrderService)     // 這個類別
within(com.example.shop.order.*)                // 這個套件
within(com.example.shop..*)                     // 這個套件及子套件
```

> **效能提示**：`within` 只比對類別，`execution` 要比對完整方法簽章。
> 大型專案可以用 `within(...) && execution(...)` 讓 Spring 先用便宜的條件刷掉大部分候選。

### `@annotation`：依「方法上的註解」（**最推薦的模式**）

```java
@annotation(com.example.shop.observability.Timed)
@annotation(org.springframework.transaction.annotation.Transactional)
```

### `@within` / `@target`：依「類別上的註解」

```java
@within(org.springframework.stereotype.Service)   // 類別標了 @Service（靜態判斷，較快）
@target(org.springframework.stereotype.Service)   // 執行期物件的類別標了 @Service
```

**兩者差別**：`@within` 在**編譯／織入期**依宣告型別判斷，`@target` 在**執行期**依實際物件判斷。
一般情況下用 `@within` 就好，而且效能較好。

### `args`：依「參數的執行期型別」

```java
args(java.lang.String, ..)                       // 第一個參數的執行期型別是 String

// 更有用的是「綁定參數」
@Before("execution(* com.example.shop..*.*(..)) && args(orderId, ..)")
public void logOrderId(long orderId) {           // 直接拿到參數值
    log.info("操作訂單 {}", orderId);
}
```

### `bean`：Spring 專屬，依 Bean 名稱

```java
bean(orderService)          // 名稱是 orderService 的 Bean
bean(*Service)              // 名稱以 Service 結尾
bean(*Service) && !bean(legacyService)
```

**這個很實用**，因為它不需要寫套件路徑。

### `this` vs `target`：最容易搞混的一對

```java
this(com.example.shop.order.OrderService)     // 「代理物件」是這個型別的實例
target(com.example.shop.order.OrderService)   // 「原始物件」是這個型別的實例
```

差別只在用 JDK 代理時才看得出來：

```
用 CGLIB（代理是子類別）：
  this(OrderServiceImpl)    → ✅ 成立（代理 extends OrderServiceImpl）
  target(OrderServiceImpl)  → ✅ 成立

用 JDK 代理（代理只實作介面）：
  this(OrderServiceImpl)    → ❌ 不成立（代理是 $Proxy0，不是 OrderServiceImpl）
  target(OrderServiceImpl)  → ✅ 成立
```

> **實務建議：不要用 `this`。** 它的行為依賴代理型別，會讓切面在換了代理策略後突然失效。

### Spring AOP **不支援**的 AspectJ 切點

```
call()                 呼叫端的攔截（Spring 只支援 execution）
get() / set()          欄位存取
staticinitialization() 靜態初始化區塊
preinitialization()    建構子前置
handler()              例外處理器
cflow() / cflowbelow() 控制流
if()                   條件判斷
```

**根本原因**：Spring AOP 是**代理**，只能攔截「經過代理的方法呼叫」。
上面那些需要修改位元組碼，得用 AspectJ 完全織入（4.19）。

### 具名切點：讓運算式可重用

```java
package com.example.shop.observability;

import org.aspectj.lang.annotation.Aspect;
import org.aspectj.lang.annotation.Pointcut;

@Aspect
public class CommonPointcuts {

    /** 所有 Service 層 */
    @Pointcut("within(com.example.shop..*) && @within(org.springframework.stereotype.Service)")
    public void serviceLayer() { }         // 方法體永遠是空的，方法名稱就是切點名稱

    /** 所有 Controller 層 */
    @Pointcut("@within(org.springframework.web.bind.annotation.RestController)")
    public void webLayer() { }

    /** 所有 Repository 層 */
    @Pointcut("@within(org.springframework.stereotype.Repository)")
    public void repositoryLayer() { }

    /** 標了 @Timed 的方法 */
    @Pointcut("@annotation(com.example.shop.observability.Timed)")
    public void timedMethod() { }

    /** 排除 Actuator 與健康檢查 */
    @Pointcut("!within(org.springframework.boot.actuate..*)")
    public void notActuator() { }
}
```

```java
@Aspect
@Component
public class TimingAspect {

    // 用完整類別名稱 + 方法名稱參照
    @Around("com.example.shop.observability.CommonPointcuts.serviceLayer() " +
            "&& com.example.shop.observability.CommonPointcuts.notActuator()")
    public Object measure(ProceedingJoinPoint pjp) throws Throwable {
        return pjp.proceed();
    }
}
```

> **這是大型專案的標準做法**：把切點集中在一個類別，切面只引用不重寫。
> 要調整攔截範圍時，只改 `CommonPointcuts` 一個檔案。

---

## 4.10 五種 Advice 與執行順序

```java
package com.example.shop.observability;

import org.aspectj.lang.JoinPoint;
import org.aspectj.lang.ProceedingJoinPoint;
import org.aspectj.lang.annotation.After;
import org.aspectj.lang.annotation.AfterReturning;
import org.aspectj.lang.annotation.AfterThrowing;
import org.aspectj.lang.annotation.Around;
import org.aspectj.lang.annotation.Aspect;
import org.aspectj.lang.annotation.Before;
import org.aspectj.lang.annotation.Pointcut;
import org.springframework.stereotype.Component;

@Aspect
@Component
public class AdviceOrderDemoAspect {

    @Pointcut("execution(* com.example.shop.demo.DemoService.*(..))")
    public void demoMethods() { }

    @Around("demoMethods()")
    public Object around(ProceedingJoinPoint pjp) throws Throwable {
        System.out.println("① @Around 前");
        try {
            Object result = pjp.proceed();
            System.out.println("⑥ @Around 後（正常）");
            return result;
        } catch (Throwable t) {
            System.out.println("⑥ @Around 後（例外）");
            throw t;
        }
    }

    @Before("demoMethods()")
    public void before(JoinPoint jp) {
        System.out.println("② @Before");
    }

    @AfterReturning(pointcut = "demoMethods()", returning = "result")
    public void afterReturning(JoinPoint jp, Object result) {
        System.out.println("④ @AfterReturning，回傳值 = " + result);
    }

    @AfterThrowing(pointcut = "demoMethods()", throwing = "ex")
    public void afterThrowing(JoinPoint jp, Throwable ex) {
        System.out.println("④ @AfterThrowing，例外 = " + ex.getClass().getSimpleName());
    }

    @After("demoMethods()")
    public void after(JoinPoint jp) {
        System.out.println("⑤ @After（不論成功失敗都執行）");
    }
}
```

### 實際執行順序

**方法正常回傳時：**

```
① @Around 前
② @Before
③ ── 目標方法執行 ──
④ @AfterReturning
⑤ @After
⑥ @Around 後（正常）
```

**方法拋出例外時：**

```
① @Around 前
② @Before
③ ── 目標方法拋出例外 ──
④ @AfterThrowing
⑤ @After
⑥ @Around 後（例外）    ← 例外會繼續往外拋
```

> ⚠️ **這個順序在 Spring 5.2.7 改過**。
> 舊版是 `@After` 先於 `@AfterReturning`，新版統一成上面的順序（與 AspectJ 一致）。
> 如果你在網路上看到不同的說法，多半是舊文章。

### 五種 Advice 的選擇

| Advice | 能做什麼 | 什麼時候用 |
|---|---|---|
| `@Before` | 只能觀察，不能改參數也不能中止 | 記錄、驗證前置條件 |
| `@AfterReturning` | 觀察回傳值（可以改回傳物件的內容，但不能換掉回傳值） | 記錄結果、發送事件 |
| `@AfterThrowing` | 觀察例外（不能吞掉） | 錯誤記錄、告警 |
| `@After` | 相當於 `finally` | 資源清理、MDC 清除 |
| **`@Around`** | **全部都能做**：改參數、換回傳值、吞例外、不執行目標方法 | 計時、重試、快取、交易 |

> **實務建議：能用 `@Before` / `@After` 就不要用 `@Around`。**
> `@Around` 忘記呼叫 `pjp.proceed()` 會讓目標方法**完全不執行**，
> 而且回傳 `null`——這種 bug 極難察覺（方法看起來執行成功，但什麼都沒做）。

---

## 4.11 `JoinPoint` API

```java
@Around("com.example.shop.observability.CommonPointcuts.serviceLayer()")
public Object inspect(ProceedingJoinPoint pjp) throws Throwable {

    // ── 方法資訊 ──
    Signature signature = pjp.getSignature();
    String shortName = signature.toShortString();          // OrderService.placeOrder(..)
    String longName  = signature.toLongString();           // 完整簽章
    String methodName = signature.getName();               // placeOrder

    // 拿到 Method 物件（讀註解時需要）
    MethodSignature methodSignature = (MethodSignature) signature;
    Method method = methodSignature.getMethod();
    String[] paramNames = methodSignature.getParameterNames();   // 需要編譯時 -parameters

    // ── 參數 ──
    Object[] args = pjp.getArgs();

    // ── 物件 ──
    Object proxy  = pjp.getThis();      // 代理物件
    Object target = pjp.getTarget();    // 原始物件
    Class<?> targetClass = target.getClass();

    // ── 執行 ──
    Object result = pjp.proceed();              // 用原本的參數執行
    // Object result = pjp.proceed(newArgs);    // 換掉參數再執行

    return result;
}
```

### 讀取方法上的註解（最常用的需求）

```java
package com.example.shop.observability;

import org.aspectj.lang.ProceedingJoinPoint;
import org.aspectj.lang.reflect.MethodSignature;
import org.springframework.core.annotation.AnnotatedElementUtils;

import java.lang.reflect.Method;

public final class AspectSupport {

    private AspectSupport() { }

    /**
     * 從 JoinPoint 取得目標方法上的註解。
     *
     * <p>⚠️ 不要直接用 signature.getMethod()，因為它可能拿到「介面上的方法」，
     * 而註解通常標在實作類別上。要先用 target class 重新查一次。
     */
    public static <A extends java.lang.annotation.Annotation> A findAnnotation(
            ProceedingJoinPoint pjp, Class<A> annotationType) throws NoSuchMethodException {

        MethodSignature signature = (MethodSignature) pjp.getSignature();
        Method method = signature.getMethod();

        // 用「原始物件的類別」重新找一次同名同參數的方法
        Class<?> targetClass = pjp.getTarget().getClass();
        Method targetMethod = targetClass.getMethod(method.getName(), method.getParameterTypes());

        // AnnotatedElementUtils 支援「合成註解」（註解上的註解），比 method.getAnnotation() 完整
        A annotation = AnnotatedElementUtils.findMergedAnnotation(targetMethod, annotationType);
        return annotation != null
                ? annotation
                : AnnotatedElementUtils.findMergedAnnotation(method, annotationType);
    }
}
```

> **這段程式碼解決一個很常見的困惑**：「我明明在實作類別的方法上標了註解，
> 切面裡卻讀不到。」原因就是 `signature.getMethod()` 在介面代理的情況下會回傳介面方法。

---

## 4.12 自訂註解 + `@annotation`：最好用的模式

用切點運算式描述「哪些方法要被攔截」，在需求複雜時會變得很難讀：

```java
// 😩 三個月後沒人看得懂這是在攔什麼
@Around("execution(* com.example.shop..*Service.*(..)) " +
        "&& !execution(* com.example.shop..*Service.find*(..)) " +
        "&& !execution(* com.example.shop..*Service.get*(..)) " +
        "&& !within(com.example.shop.internal..*)")
```

**改用註解，意圖直接寫在方法上**：

```java
package com.example.shop.observability;

import java.lang.annotation.Documented;
import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

/**
 * 標記需要記錄執行時間的方法。
 */
@Documented
@Target({ElementType.METHOD, ElementType.TYPE})      // 可標在方法或整個類別
@Retention(RetentionPolicy.RUNTIME)                  // ★ 必須是 RUNTIME，否則執行期讀不到 ★
public @interface Timed {

    /** 指標名稱，留空則用「類別.方法」 */
    String value() default "";

    /** 超過這個毫秒數就記 WARN */
    long thresholdMs() default 500;

    /** 是否把參數一起記錄（含敏感資料的方法要設 false） */
    boolean logArgs() default false;
}
```

```java
package com.example.shop.observability;

import org.aspectj.lang.ProceedingJoinPoint;
import org.aspectj.lang.annotation.Around;
import org.aspectj.lang.annotation.Aspect;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;

import java.util.Arrays;

@Aspect
@Component
@Order(20)
public class TimedAspect {

    private static final Logger log = LoggerFactory.getLogger(TimedAspect.class);

    /**
     * 兩個切點：方法上標了 @Timed，或整個類別標了 @Timed。
     */
    @Around("@annotation(com.example.shop.observability.Timed) "
          + "|| @within(com.example.shop.observability.Timed)")
    public Object measure(ProceedingJoinPoint pjp) throws Throwable {

        Timed timed = AspectSupport.findAnnotation(pjp, Timed.class);
        long threshold = timed != null ? timed.thresholdMs() : 500;
        String name = (timed != null && !timed.value().isBlank())
                ? timed.value()
                : pjp.getSignature().toShortString();

        long start = System.nanoTime();
        boolean failed = false;
        try {
            return pjp.proceed();
        } catch (Throwable t) {
            failed = true;
            throw t;
        } finally {
            long ms = (System.nanoTime() - start) / 1_000_000;
            String argsText = (timed != null && timed.logArgs())
                    ? " args=" + Arrays.toString(pjp.getArgs())
                    : "";

            if (failed) {
                log.warn("{} 失敗，耗時 {} ms{}", name, ms, argsText);
            } else if (ms > threshold) {
                log.warn("{} 耗時 {} ms，超過 {} ms 門檻{}", name, ms, threshold, argsText);
            } else {
                log.debug("{} 耗時 {} ms{}", name, ms, argsText);
            }
        }
    }
}
```

使用：

```java
@Service
public class OrderService {

    @Timed(thresholdMs = 200)                              // 這支很重要，門檻設嚴一點
    public Order placeOrder(String customer, BigDecimal amount) { /* ... */ }

    @Timed(value = "order.report", thresholdMs = 5000)     // 報表本來就慢
    public Report generateReport() { /* ... */ }

    @Timed(logArgs = false)                                // 參數含個資，不記錄
    public void updateCustomerProfile(String idNumber) { /* ... */ }
}
```

**這個模式的三個好處：**

1. **意圖寫在方法上**——讀 `OrderService` 就知道這個方法會被計時。
2. **可以帶參數**——門檻、名稱、開關都能個別調整。
3. **切點運算式極簡**——不會隨著需求變複雜而失控。

> **這正是 Spring 自己的做法**：`@Transactional`、`@Cacheable`、`@Async`、`@Retryable`
> 全部都是「自訂註解 + 切面」的模式。你現在寫的東西，跟框架用的是同一套機制。

---

## 4.13 多個切面的順序

當一個方法被多個切面攔截時，用 `@Order` 控制順序（**數字小的在外層**）。

```java
@Aspect @Component @Order(10) public class TracingAspect { }   // 最外層
@Aspect @Component @Order(20) public class TimedAspect { }
@Aspect @Component @Order(30) public class AuditAspect { }     // 最內層
```

執行順序：

```
TracingAspect  前
  TimedAspect  前
    AuditAspect  前
      ── 目標方法 ──
    AuditAspect  後
  TimedAspect  後
TracingAspect  後
```

### 一個真實的順序 bug

```java
@Aspect @Component @Order(100)     // 交易切面（Spring 內建，預設 Ordered.LOWEST_PRECEDENCE）
// @Transactional

@Aspect @Component @Order(50)      // 你的重試切面
public class RetryAspect { }
```

**問題**：重試切面在**交易外面**，所以每次重試都會開一個新交易——這通常是對的。

但如果順序反過來（重試在交易裡面），第一次失敗導致交易被標記為 `rollback-only`，
後面的重試就算成功了，交易還是會 rollback，出現 `UnexpectedRollbackException`。

> **規則：重試、熔斷、限流這類切面，一定要在交易切面的「外面」。**
> Spring 的交易切面順序是 `Ordered.LOWEST_PRECEDENCE`（最內層），
> 所以你的切面只要有明確的 `@Order` 數字就會在外面。
>
> 可以用 `spring.transaction.default-timeout` 旁邊那組設定調整交易切面的順序：
> ```java
> @EnableTransactionManagement(order = 100)
> ```

### 同一個切面內的多個 Advice

同一個 `@Aspect` 類別裡的多個 Advice，順序由 4.10 那張表決定，
**不能用 `@Order` 控制**（`@Order` 是切面層級的）。
需要精確控制時，把它們拆成兩個 `@Aspect` 類別。

---

## 4.14 ★ 自呼叫失效 ★

**這是本章的核心，也是實務上最常出事的地方。**

### 現象

```java
package com.example.shop.order;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class OrderService {

    private final OrderRepository repository;
    private final InventoryRepository inventoryRepository;

    public OrderService(OrderRepository repository, InventoryRepository inventoryRepository) {
        this.repository = repository;
        this.inventoryRepository = inventoryRepository;
    }

    public void placeOrderBatch(java.util.List<OrderRequest> requests) {
        for (OrderRequest request : requests) {
            this.placeOne(request);          // ★ 自呼叫 ★
        }
    }

    @Transactional                            // ← 完全不會生效
    public void placeOne(OrderRequest request) {
        repository.save(new Order(null, request.customer(), request.amount(), "CREATED"));
        inventoryRepository.decrease(request.sku(), request.quantity());   // 這裡失敗
        // 期待：整筆 rollback
        // 實際：訂單已經寫進去了，庫存沒扣 → 資料不一致
    }
}
```

> **真實案例**：某電商的批次匯入功能就是這樣寫的。
> 匯入 500 筆訂單時，第 137 筆的商品代碼不存在導致例外，
> 前面 136 筆的訂單留在資料庫，但庫存完全沒扣。
> 對帳時才發現「賣出去的比庫存扣的多」，回溯了三個月的資料。

### 為什麼會這樣：畫出記憶體裡發生的事

```
容器啟動時：
   ┌─────────────────────────────────────────┐
   │ OrderService$$SpringCGLIB$$0（代理）      │
   │  ┌─────────────────────────────────────┐│
   │  │ 交易攔截器 → 委派給 target           ││
   │  └─────────────────────────────────────┘│
   │           │                              │
   │           ▼                              │
   │  ┌─────────────────────────────────────┐│
   │  │ OrderService（原始物件 = target）     ││
   │  └─────────────────────────────────────┘│
   └─────────────────────────────────────────┘
                   ↑
          容器裡放的是「代理」，注入到別處的也是「代理」


執行時：
   Controller 呼叫 orderService.placeOrderBatch(...)
        │
        ▼
   ┌── 代理 ──────────────────────────┐
   │  placeOrderBatch 沒有 @Transactional │
   │  → 沒有攔截器要跑，直接委派          │
   └────────────┬─────────────────────┘
                │
                ▼
   ┌── 原始物件 ──────────────────────────────────────┐
   │  placeOrderBatch() {                             │
   │      for (...) {                                 │
   │          this.placeOne(request);                 │
   │            ↑                                     │
   │            └─ this 是「原始物件」，不是代理！        │
   │               → 這是一次普通的 Java 方法呼叫        │
   │               → 完全不經過代理                     │
   │               → @Transactional 不會被看到          │
   │      }                                           │
   │  }                                               │
   └──────────────────────────────────────────────────┘
```

**一句話總結：**

> **代理只能攔截「從外面進來的呼叫」。物件內部的 `this.method()` 是 JVM 層級的直接呼叫，
> 代理根本沒有機會插手。**

### 這個問題影響哪些註解

**所有靠 AOP 實作的註解，全部中招：**

```
@Transactional      交易不生效，不會 rollback
@Async              變成同步執行
@Cacheable          每次都真的執行，快取形同虛設
@CacheEvict         快取不會被清掉
@Retryable          失敗不會重試
@PreAuthorize       權限檢查被繞過 ★ 安全問題 ★
@RateLimiter        限流失效
你自己寫的所有切面    全部失效
```

> **`@PreAuthorize` 那一條特別危險**：
> ```java
> public void adminAction() {
>     this.deleteAllOrders();       // 繞過權限檢查
> }
>
> @PreAuthorize("hasRole('ADMIN')")
> public void deleteAllOrders() { }
> ```
> 這不是 bug，是**漏洞**。09-spring-security 會再強調一次。

### 解法 1：拆到另一個 Bean（最好）

```java
package com.example.shop.order;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/** 單筆訂單的處理，交易邊界在這裡 */
@Service
public class OrderPlacementService {

    private final OrderRepository repository;
    private final InventoryRepository inventoryRepository;

    public OrderPlacementService(OrderRepository repository,
                                 InventoryRepository inventoryRepository) {
        this.repository = repository;
        this.inventoryRepository = inventoryRepository;
    }

    @Transactional
    public void placeOne(OrderRequest request) {
        repository.save(new Order(null, request.customer(), request.amount(), "CREATED"));
        inventoryRepository.decrease(request.sku(), request.quantity());
    }
}
```

```java
package com.example.shop.order;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.List;

/** 批次處理的協調者，沒有交易 */
@Service
public class OrderBatchService {

    private static final Logger log = LoggerFactory.getLogger(OrderBatchService.class);

    private final OrderPlacementService placementService;    // ★ 注入的是「代理」★

    public OrderBatchService(OrderPlacementService placementService) {
        this.placementService = placementService;
    }

    public BatchResult placeOrderBatch(List<OrderRequest> requests) {
        List<String> failures = new ArrayList<>();
        int success = 0;

        for (OrderRequest request : requests) {
            try {
                placementService.placeOne(request);   // ✅ 經過代理，每一筆一個獨立交易
                success++;
            } catch (Exception e) {
                log.warn("第 {} 筆匯入失敗：{}", requests.indexOf(request), e.getMessage());
                failures.add(request.sku() + ": " + e.getMessage());
            }
        }
        return new BatchResult(success, failures);
    }

    public record BatchResult(int successCount, List<String> failures) { }
}
```

**這個解法的額外好處**：拆開之後，「批次協調」與「單筆處理」的職責變清楚了，
而且可以個別測試。**AOP 的限制反而逼出了更好的設計。**

### 解法 2：注入自己

```java
package com.example.shop.order;

import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;

@Service
public class OrderService {

    private final OrderRepository repository;
    private final ObjectProvider<OrderService> selfProvider;   // ★ 注入自己的 Provider ★

    public OrderService(OrderRepository repository, ObjectProvider<OrderService> selfProvider) {
        this.repository = repository;
        this.selfProvider = selfProvider;
    }

    public void placeOrderBatch(List<OrderRequest> requests) {
        OrderService self = selfProvider.getObject();     // 取得「代理」
        for (OrderRequest request : requests) {
            self.placeOne(request);                        // ✅ 經過代理
        }
    }

    @Transactional
    public void placeOne(OrderRequest request) { /* ... */ }
}
```

> **為什麼要用 `ObjectProvider` 而不是直接注入 `OrderService self`？**
> 直接注入會造成**建構子循環依賴**（建 OrderService 需要 OrderService），
> Spring Boot 2.6+ 預設會直接啟動失敗。
> `ObjectProvider` 是延遲取得，不會在建構時就需要對方。
>
> 另一種寫法是 `@Lazy`：
> ```java
> public OrderService(OrderRepository repository, @Lazy OrderService self) { ... }
> ```
> 兩者都可以，`ObjectProvider` 意圖更明確。

**缺點**：`self.placeOne(...)` 這種寫法很奇怪，新人看到會困惑，需要註解說明。

### 解法 3：`AopContext.currentProxy()`

```java
package com.example.shop;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.context.annotation.EnableAspectJAutoProxy;

@SpringBootApplication
@EnableAspectJAutoProxy(exposeProxy = true)      // ★ 必須開這個開關 ★
public class ShopServiceApplication {
    public static void main(String[] args) {
        SpringApplication.run(ShopServiceApplication.class, args);
    }
}
```

```java
@Service
public class OrderService {

    public void placeOrderBatch(List<OrderRequest> requests) {
        OrderService self = (OrderService) AopContext.currentProxy();
        for (OrderRequest request : requests) {
            self.placeOne(request);       // ✅
        }
    }

    @Transactional
    public void placeOne(OrderRequest request) { /* ... */ }
}
```

**原理**：`exposeProxy = true` 會讓代理在呼叫時把自己存進 `ThreadLocal`。

**缺點**：

- 把程式碼綁死在 Spring 上（`AopContext` 是 Spring 專屬 API）。
- 要記得開全域開關，忘了開就 `IllegalStateException`。
- 有 `ThreadLocal` 的成本。

> **不推薦，但要看得懂**——很多既有專案裡有這種寫法。

### 解法 4：AspectJ 完全織入

改用編譯期或載入期織入，不用代理（4.19）。**大砲打小鳥，除非有其他理由，否則不值得。**

### 四種解法的選擇

| 解法 | 推薦度 | 適用 |
|---|---|---|
| **拆到另一個 Bean** | ⭐⭐⭐⭐⭐ | 預設選這個。順便改善設計 |
| 注入自己（`ObjectProvider`） | ⭐⭐⭐ | 拆開會造成過度切割時 |
| `AopContext.currentProxy()` | ⭐⭐ | 既有專案已在用時 |
| AspectJ 織入 | ⭐ | 有其他強烈需求時 |

---

## 4.15 其他失效情境

自呼叫只是其中一種。完整清單：

### ① `private` 方法

```java
@Service
public class OrderService {
    @Transactional
    private void save() { }        // ❌ CGLIB 無法覆寫 private 方法
}
```

而且它一定是自呼叫（private 方法只能從類別內部呼叫），所以是**雙重失效**。

### ② `final` 方法或 `final` 類別

```java
@Service
public final class OrderService {           // ❌ CGLIB 無法繼承 final 類別
    @Transactional
    public final void save() { }            // ❌ 無法覆寫 final 方法
}
```

`final` 類別的情況，Spring 啟動時會報錯：

```
Cannot subclass final class com.example.shop.order.OrderService
```

**`final` 方法的情況更糟：Spring 不會報錯，只是靜靜地不攔截。**

### ③ `static` 方法

```java
@Service
public class OrderService {
    @Transactional
    public static void save() { }           // ❌ 靜態方法不參與多型
}
```

### ④ 非 Spring 管理的物件

```java
@Service
public class OrderService {
    public void process() {
        OrderValidator validator = new OrderValidator();   // ❌ 自己 new 的，不是 Bean
        validator.validate();                              // 上面的註解全部無效
    }
}
```

### ⑤ 多執行緒

```java
@Service
public class OrderService {

    @Transactional
    public void process(List<OrderRequest> requests) {
        requests.parallelStream().forEach(this::handleOne);   // ❌ 交易綁在原本的執行緒上
    }
}
```

**交易是綁在 `ThreadLocal` 上的**（`TransactionSynchronizationManager`），
新執行緒拿不到交易上下文。這一點在 05-service 第 06 章會詳談。

### ⑥ 例外被吞掉

```java
@Service
public class OrderService {

    @Transactional
    public void placeOrder() {
        try {
            repository.save(order);
            inventory.decrease(sku);        // 拋例外
        } catch (Exception e) {
            log.error("失敗", e);            // ❌ 吞掉了，交易切面看不到例外
        }
        // → 交易照常 commit，資料不一致
    }
}
```

### ⑦ Checked Exception 預設不 rollback

```java
@Transactional
public void placeOrder() throws IOException {
    repository.save(order);
    throw new IOException("寫檔失敗");        // ❌ checked exception 預設不觸發 rollback
}

// 修正
@Transactional(rollbackFor = Exception.class)
public void placeOrder() throws IOException { }
```

### ⑧ Bean 提早建立，錯過 AOP 加工

回顧第 01 章 1.12：如果一個 Bean 在 `BeanPostProcessor` 完成之前就被建立
（例如被某個 `BeanPostProcessor` 注入），它就不會被代理。

啟動日誌會有：

```
Bean 'orderService' of type [...] is not eligible for getting processed by all
BeanPostProcessors (for example: not eligible for auto-proxying)
```

**看到這行警告，就要去確認那個 Bean 的 AOP 有沒有生效。**

### 完整檢查清單

遇到「註解沒生效」時，依序檢查：

```
□ 1. 這個類別是 Spring Bean 嗎？（不是自己 new 的）
□ 2. 方法是 public 嗎？（不是 private / protected / 套件私有）
□ 3. 方法或類別有 final 嗎？
□ 4. 是 static 方法嗎？
□ 5. 是從外部呼叫的嗎？（不是 this.method()）
□ 6. 有沒有把例外 catch 掉？
□ 7. 拋的是 RuntimeException 嗎？（checked 要設 rollbackFor）
□ 8. 啟動日誌有沒有 "not eligible for auto-proxying" 警告？
□ 9. 用 AopUtils.isAopProxy(bean) 確認它真的是代理
```

---

## 4.16 AOP 的效能與副作用

### 效能：實際數字

Spring AOP 的開銷主要來自：

| 項目 | 大約成本 |
|---|---|
| 代理方法呼叫（CGLIB） | 約 20～50 ns |
| 反射呼叫（JDK 代理） | 約 30～80 ns |
| 切點比對 | **只在啟動時做一次**（結果會快取） |
| `@Around` 裡的邏輯 | 你自己寫的，這才是重點 |

> **結論：AOP 本身的開銷幾乎可以忽略**（一次資料庫查詢是 1～10 ms = 1,000,000～10,000,000 ns）。
> 真正會拖慢的是你在切面裡做的事——**不要在切面裡查資料庫、呼叫外部 API、序列化大物件**。

### 反面教材：在切面裡序列化參數

```java
@Around("...")
public Object log(ProceedingJoinPoint pjp) throws Throwable {
    // ❌ 每次呼叫都把參數序列化成 JSON，即使 log 等級是 INFO 不會輸出
    log.debug("參數：{}", objectMapper.writeValueAsString(pjp.getArgs()));
    return pjp.proceed();
}

// ✅ 先判斷等級
@Around("...")
public Object log(ProceedingJoinPoint pjp) throws Throwable {
    if (log.isDebugEnabled()) {
        log.debug("參數：{}", objectMapper.writeValueAsString(pjp.getArgs()));
    }
    return pjp.proceed();
}
```

> **真實案例**：某服務加了「記錄所有 Service 參數」的切面，
> 用 `objectMapper.writeValueAsString()` 序列化。上線後 P99 延遲從 80ms 升到 340ms。
> 因為有些方法的參數是包含幾百筆明細的訂單物件，每次呼叫都要序列化一次——
> **而且 log 等級是 INFO，序列化出來的字串根本沒被輸出。**

### 副作用 1：`getClass()` 回傳的是代理類別

```java
@Service
public class OrderService {
    public void whoAmI() {
        System.out.println(this.getClass().getName());
        // 在切面裡拿到的 bean.getClass() → OrderService$$SpringCGLIB$$0
    }
}
```

影響：

```java
// ❌ 用 getClass() 當 Map 的 key、做 switch、比對型別，都會出問題
if (bean.getClass() == OrderService.class) { }      // false！

// ✅ 用 Spring 的工具
if (AopProxyUtils.ultimateTargetClass(bean) == OrderService.class) { }
```

### 副作用 2：`Logger` 的名稱

```java
@Service
public class OrderService {
    // ⚠️ 如果用 getClass() 建 logger，名稱會變成 OrderService$$SpringCGLIB$$0
    private final Logger log = LoggerFactory.getLogger(getClass());

    // ✅ 用類別字面值
    private static final Logger log = LoggerFactory.getLogger(OrderService.class);
}
```

日誌 pattern 裡的 logger 名稱會出現一堆 `$$SpringCGLIB$$0`，很難看也難過濾。

### 副作用 3：`equals()` / `hashCode()`

CGLIB 代理**會**覆寫 `equals` / `hashCode`（委派給 target），
但 JDK 代理的行為要看 `InvocationHandler` 怎麼寫。
Spring 的 `JdkDynamicAopProxy` 有處理這兩個方法，所以行為正確。

**但仍然不要把 Bean 當成 Map 的 key 或放進 Set。**

### 副作用 4：除錯時的堆疊變長

```
at com.example.shop.order.OrderService.placeOrder(OrderService.java:42)
at java.base/jdk.internal.reflect.DirectMethodHandleAccessor.invoke(...)
at org.springframework.aop.support.AopUtils.invokeJoinpointUsingReflection(...)
at org.springframework.aop.framework.ReflectiveMethodInvocation.invokeJoinpoint(...)
at org.springframework.aop.framework.ReflectiveMethodInvocation.proceed(...)
at org.springframework.transaction.interceptor.TransactionInterceptor.invoke(...)
at org.springframework.aop.framework.ReflectiveMethodInvocation.proceed(...)
at org.springframework.aop.framework.CglibAopProxy$DynamicAdvisedInterceptor.intercept(...)
at com.example.shop.order.OrderService$$SpringCGLIB$$0.placeOrder(<generated>)
at com.example.shop.web.OrderController.create(OrderController.java:31)
```

**看堆疊時的技巧**：`org.springframework.aop.*` 那幾層全部跳過，
找 `$$SpringCGLIB$$` 那一行的上下，就是「呼叫端」與「真正的實作」。

---

## 4.17 實戰：訂單服務的三個切面

### 切面 1：稽核（`@Auditable`）

```java
package com.example.shop.audit;

import java.lang.annotation.Documented;
import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

@Documented
@Target(ElementType.METHOD)
@Retention(RetentionPolicy.RUNTIME)
public @interface Auditable {

    /** 動作代碼，例如 CANCEL_ORDER */
    String action();

    /**
     * 資源識別的 SpEL 運算式，可以引用方法參數。
     * 例如 "'order:' + #orderId"
     */
    String resource() default "";
}
```

```java
package com.example.shop.audit;

import org.aspectj.lang.ProceedingJoinPoint;
import org.aspectj.lang.annotation.Around;
import org.aspectj.lang.annotation.Aspect;
import org.aspectj.lang.reflect.MethodSignature;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.core.DefaultParameterNameDiscoverer;
import org.springframework.core.ParameterNameDiscoverer;
import org.springframework.core.annotation.Order;
import org.springframework.expression.EvaluationContext;
import org.springframework.expression.ExpressionParser;
import org.springframework.expression.spel.standard.SpelExpressionParser;
import org.springframework.expression.spel.support.StandardEvaluationContext;
import org.springframework.stereotype.Component;

import java.time.Instant;
import java.util.Map;

@Aspect
@Component
@Order(30)
public class AuditAspect {

    private static final Logger log = LoggerFactory.getLogger(AuditAspect.class);

    private final ExpressionParser parser = new SpelExpressionParser();
    private final ParameterNameDiscoverer nameDiscoverer = new DefaultParameterNameDiscoverer();
    private final AuditRecorder recorder;
    private final CurrentUserProvider currentUserProvider;

    public AuditAspect(AuditRecorder recorder, CurrentUserProvider currentUserProvider) {
        this.recorder = recorder;
        this.currentUserProvider = currentUserProvider;
    }

    @Around("@annotation(auditable)")     // ★ 直接把註解綁成參數，不用自己找 ★
    public Object audit(ProceedingJoinPoint pjp, Auditable auditable) throws Throwable {

        String actor = currentUserProvider.currentUser();
        String resource = evaluateResource(pjp, auditable.resource());

        try {
            Object result = pjp.proceed();
            record(actor, auditable.action(), resource, "SUCCESS", Map.of());
            return result;

        } catch (Throwable t) {
            // ★ 失敗也要記錄 —— 「誰嘗試做了什麼但失敗了」往往比成功紀錄更重要 ★
            record(actor, auditable.action(), resource, "FAILURE",
                    Map.of("error", t.getClass().getSimpleName(),
                           "message", String.valueOf(t.getMessage())));
            throw t;
        }
    }

    private void record(String actor, String action, String resource,
                        String outcome, Map<String, Object> details) {
        try {
            recorder.record(new AuditEvent(Instant.now(), actor, action, resource, outcome, details));
        } catch (Exception e) {
            // ★ 稽核失敗絕對不能讓業務流程失敗 ★
            log.error("寫入稽核紀錄失敗 action={} resource={}", action, resource, e);
        }
    }

    /** 用 SpEL 解析 resource 運算式，可以引用方法參數名稱 */
    private String evaluateResource(ProceedingJoinPoint pjp, String expression) {
        if (expression == null || expression.isBlank()) {
            return pjp.getSignature().toShortString();
        }
        try {
            MethodSignature signature = (MethodSignature) pjp.getSignature();
            EvaluationContext context = new StandardEvaluationContext();
            String[] names = nameDiscoverer.getParameterNames(signature.getMethod());
            Object[] args = pjp.getArgs();
            if (names != null) {
                for (int i = 0; i < names.length; i++) {
                    context.setVariable(names[i], args[i]);
                }
            }
            return String.valueOf(parser.parseExpression(expression).getValue(context));
        } catch (Exception e) {
            log.warn("解析 resource 運算式失敗：{}", expression, e);
            return expression;
        }
    }
}
```

使用：

```java
@Service
public class OrderService {

    @Auditable(action = "CANCEL_ORDER", resource = "'order:' + #orderId")
    public void cancelOrder(long orderId, String reason) {
        // ...
    }

    @Auditable(action = "REFUND", resource = "'order:' + #request.orderId()")
    public void refund(RefundRequest request) {
        // ...
    }
}
```

> **`@Around("@annotation(auditable)")` 這個寫法值得學**：
> 參數名稱 `auditable` 與方法參數 `Auditable auditable` 對應，
> Spring 會自動把註解實例綁進來，比 4.11 那段手動查註解的程式碼乾淨很多。

### 切面 2：重試（`@Retry`）

```java
package com.example.shop.resilience;

import java.lang.annotation.Documented;
import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

@Documented
@Target(ElementType.METHOD)
@Retention(RetentionPolicy.RUNTIME)
public @interface Retry {

    /** 最多嘗試幾次（含第一次） */
    int maxAttempts() default 3;

    /** 第一次重試前等多久（毫秒） */
    long initialDelayMs() default 200;

    /** 每次重試的延遲倍數 */
    double multiplier() default 2.0;

    /** 只有這些例外才重試 */
    Class<? extends Throwable>[] retryOn() default {Exception.class};

    /** 這些例外一律不重試（優先於 retryOn） */
    Class<? extends Throwable>[] noRetryOn() default {};
}
```

```java
package com.example.shop.resilience;

import org.aspectj.lang.ProceedingJoinPoint;
import org.aspectj.lang.annotation.Around;
import org.aspectj.lang.annotation.Aspect;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;

import java.util.Arrays;
import java.util.concurrent.ThreadLocalRandom;

/**
 * 重試切面。
 *
 * <p>⚠️ @Order(10) 讓它排在交易切面「外面」。
 * 若排在裡面，第一次失敗會把交易標記成 rollback-only，
 * 後續重試就算成功也會拋 UnexpectedRollbackException。
 */
@Aspect
@Component
@Order(10)
public class RetryAspect {

    private static final Logger log = LoggerFactory.getLogger(RetryAspect.class);

    @Around("@annotation(retry)")
    public Object retry(ProceedingJoinPoint pjp, Retry retry) throws Throwable {

        String name = pjp.getSignature().toShortString();
        long delay = retry.initialDelayMs();
        Throwable lastError = null;

        for (int attempt = 1; attempt <= retry.maxAttempts(); attempt++) {
            try {
                if (attempt > 1) {
                    log.info("{} 第 {}/{} 次嘗試", name, attempt, retry.maxAttempts());
                }
                return pjp.proceed();

            } catch (Throwable t) {
                lastError = t;

                if (!shouldRetry(t, retry)) {
                    log.debug("{} 拋出 {}，不在重試範圍內，直接往外拋",
                            name, t.getClass().getSimpleName());
                    throw t;
                }
                if (attempt == retry.maxAttempts()) {
                    log.warn("{} 重試 {} 次後仍失敗", name, retry.maxAttempts());
                    throw t;
                }

                // 加入 jitter，避免多個實例同時重試造成尖峰
                long jitter = ThreadLocalRandom.current().nextLong(delay / 4 + 1);
                long sleepMs = delay + jitter;
                log.warn("{} 第 {} 次失敗（{}），{} ms 後重試",
                        name, attempt, t.getClass().getSimpleName(), sleepMs);

                try {
                    Thread.sleep(sleepMs);
                } catch (InterruptedException ie) {
                    Thread.currentThread().interrupt();     // ★ 一定要恢復中斷旗標 ★
                    throw t;
                }
                delay = (long) (delay * retry.multiplier());
            }
        }
        throw lastError;    // 理論上到不了這裡
    }

    private boolean shouldRetry(Throwable t, Retry retry) {
        if (Arrays.stream(retry.noRetryOn()).anyMatch(type -> type.isInstance(t))) {
            return false;
        }
        return Arrays.stream(retry.retryOn()).anyMatch(type -> type.isInstance(t));
    }
}
```

使用：

```java
@Service
public class PaymentService {

    @Retry(maxAttempts = 4,
           initialDelayMs = 300,
           retryOn = {java.net.SocketTimeoutException.class, org.springframework.web.client.ResourceAccessException.class},
           noRetryOn = {InsufficientBalanceException.class})   // 餘額不足重試幾次都沒用
    public void charge(String orderId, BigDecimal amount) {
        // 呼叫外部金流 API
    }
}
```

> **`noRetryOn` 這個設計很重要**：
> 「餘額不足」「卡片過期」「訂單不存在」這類**業務錯誤重試沒有意義**，
> 只會浪費時間並讓使用者多等幾秒。
> **只重試「暫時性錯誤」**：連線逾時、503、連線被重設。

### 切面 3：追蹤 ID 傳遞（為第 05 章鋪路）

```java
package com.example.shop.observability;

import org.aspectj.lang.ProceedingJoinPoint;
import org.aspectj.lang.annotation.Around;
import org.aspectj.lang.annotation.Aspect;
import org.slf4j.MDC;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;

import java.util.UUID;

/**
 * 確保任何進入 Service 層的呼叫都有 traceId。
 *
 * <p>Web 請求的 traceId 由 Filter 產生（第 05 章）；
 * 排程任務、訊息消費這類沒有 HTTP 請求的入口，就靠這個切面補上。
 */
@Aspect
@Component
@Order(5)                                   // 最外層，讓所有後續 log 都帶得到
public class TraceIdAspect {

    private static final String TRACE_ID = "traceId";

    @Around("com.example.shop.observability.CommonPointcuts.serviceLayer()")
    public Object ensureTraceId(ProceedingJoinPoint pjp) throws Throwable {
        boolean created = false;
        if (MDC.get(TRACE_ID) == null) {
            MDC.put(TRACE_ID, UUID.randomUUID().toString().replace("-", "").substring(0, 16));
            created = true;
        }
        try {
            return pjp.proceed();
        } finally {
            if (created) {
                MDC.remove(TRACE_ID);       // ★ 誰放的誰清，避免污染執行緒池 ★
            }
        }
    }
}
```

---

## 4.18 測試切面

### 方式 1：切片式的最小 context

```java
package com.example.shop.resilience;

import org.junit.jupiter.api.Test;
import org.springframework.boot.autoconfigure.aop.AopAutoConfiguration;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.stereotype.Service;

import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class RetryAspectTest {

    private final ApplicationContextRunner runner = new ApplicationContextRunner()
            .withConfiguration(org.springframework.boot.autoconfigure.AutoConfigurations
                    .of(AopAutoConfiguration.class))
            .withUserConfiguration(TestConfig.class);

    @Test
    void 暫時性失敗後應重試成功() {
        runner.run(context -> {
            FlakyService service = context.getBean(FlakyService.class);

            String result = service.callWithRetry(2);      // 前 2 次失敗，第 3 次成功

            assertThat(result).isEqualTo("OK");
            assertThat(service.attempts.get()).isEqualTo(3);
        });
    }

    @Test
    void 超過次數後應拋出原始例外() {
        runner.run(context -> {
            FlakyService service = context.getBean(FlakyService.class);

            assertThatThrownBy(() -> service.callWithRetry(99))
                    .isInstanceOf(IllegalStateException.class)
                    .hasMessageContaining("暫時性失敗");

            assertThat(service.attempts.get()).isEqualTo(3);   // maxAttempts = 3
        });
    }

    @Test
    void noRetryOn的例外不應重試() {
        runner.run(context -> {
            FlakyService service = context.getBean(FlakyService.class);

            assertThatThrownBy(service::callWithBusinessError)
                    .isInstanceOf(IllegalArgumentException.class);

            assertThat(service.attempts.get()).isEqualTo(1);   // ★ 只試一次 ★
        });
    }

    // ── 測試用的元件 ──

    @Service
    static class FlakyService {
        final AtomicInteger attempts = new AtomicInteger();

        @Retry(maxAttempts = 3, initialDelayMs = 1,
               retryOn = IllegalStateException.class,
               noRetryOn = IllegalArgumentException.class)
        public String callWithRetry(int failTimes) {
            if (attempts.incrementAndGet() <= failTimes) {
                throw new IllegalStateException("暫時性失敗");
            }
            return "OK";
        }

        @Retry(maxAttempts = 3, initialDelayMs = 1,
               retryOn = Exception.class,
               noRetryOn = IllegalArgumentException.class)
        public void callWithBusinessError() {
            attempts.incrementAndGet();
            throw new IllegalArgumentException("參數錯誤，重試沒用");
        }
    }

    @Configuration(proxyBeanMethods = false)
    static class TestConfig {
        @Bean RetryAspect retryAspect() { return new RetryAspect(); }
        @Bean FlakyService flakyService() { return new FlakyService(); }
    }
}
```

> **注意 `initialDelayMs = 1`**：測試裡不要真的等 200ms × 指數退避，
> 那會讓測試變成好幾秒。**把延遲設成 1 毫秒**，行為一樣但跑得快。

### 方式 2：直接驗證代理狀態

```java
@SpringBootTest
class ProxyAssertionTest {

    @Autowired
    private OrderService orderService;

    @Test
    void OrderService應該被代理() {
        assertThat(AopUtils.isAopProxy(orderService)).isTrue();
        assertThat(AopProxyUtils.ultimateTargetClass(orderService))
                .isEqualTo(OrderService.class);
    }
}
```

### 方式 3：用 ArchUnit 防止 final 方法

```java
package com.example.shop.arch;

import com.tngtech.archunit.core.domain.JavaClasses;
import com.tngtech.archunit.core.importer.ClassFileImporter;
import com.tngtech.archunit.lang.syntax.ArchRuleDefinition;
import org.junit.jupiter.api.Test;
import org.springframework.transaction.annotation.Transactional;

class AopSafetyArchTest {

    private final JavaClasses classes =
            new ClassFileImporter().importPackages("com.example.shop");

    @Test
    void 標了Transactional的方法不可以是final或private() {
        ArchRuleDefinition.methods()
                .that().areAnnotatedWith(Transactional.class)
                .should().bePublic()
                .andShould().notBeFinal()
                .andShould().notBeStatic()
                .because("Spring AOP 用 CGLIB 代理，final / private / static 方法無法被攔截")
                .check(classes);
    }
}
```

> **這個測試很值得加**。它把「AOP 的限制」變成 CI 會擋下來的規則，
> 而不是靠每個人記得。ArchUnit 的用法在 01-java-core 第 11 章有完整介紹。

---

## 4.19 什麼時候 Spring AOP 不夠用

| 需求 | Spring AOP | AspectJ 完全織入 |
|---|---|---|
| 攔截 public 方法 | ✅ | ✅ |
| 攔截 private / final / static 方法 | ❌ | ✅ |
| 攔截 `this.method()` 自呼叫 | ❌ | ✅ |
| 攔截 `new` 出來的物件 | ❌ | ✅ |
| 攔截建構子 | ❌ | ✅ |
| 攔截欄位讀寫 | ❌ | ✅ |
| 攔截第三方 jar 裡的類別 | ❌ | ✅ |
| 設定複雜度 | 加一個依賴 | 需要編譯外掛或 JVM agent |
| 啟動速度 | 正常 | LTW 會變慢 |

### 兩種完全織入

**編譯期織入（CTW, Compile-Time Weaving）**：用 `aspectj-maven-plugin` 在編譯時改位元組碼。

```xml
<plugin>
    <groupId>dev.aspectj</groupId>
    <artifactId>aspectj-maven-plugin</artifactId>
    <version>1.14</version>
    <configuration>
        <complianceLevel>21</complianceLevel>
        <aspectLibraries>
            <aspectLibrary>
                <groupId>org.springframework</groupId>
                <artifactId>spring-aspects</artifactId>
            </aspectLibrary>
        </aspectLibraries>
    </configuration>
    <executions>
        <execution>
            <goals><goal>compile</goal></goals>
        </execution>
    </executions>
</plugin>
```

**載入期織入（LTW, Load-Time Weaving）**：用 JVM agent 在類別載入時改位元組碼。

```bash
java -javaagent:aspectjweaver.jar -jar shop.jar
```

```java
@SpringBootApplication
@EnableLoadTimeWeaving
public class ShopServiceApplication { }
```

> **實務建議：99% 的專案不需要這些。**
> 「自呼叫失效」拆一個 Bean 就解決了，而完全織入帶來的複雜度（建置流程變複雜、
> 除錯時看到的程式碼跟原始碼對不上、新人完全看不懂）遠大於好處。
>
> **真的需要的場景**：要對 JPA Entity（不是 Bean）做 AOP、
> 要攔截第三方函式庫的內部方法、要做效能剖析工具。

---

## 4.20 常見錯誤

### ① 切面完全沒生效

```
□ @Aspect 類別上有 @Component 嗎？
□ 這個類別在 @ComponentScan 範圍內嗎？
□ 有 spring-boot-starter-aop 依賴嗎？
□ 切點運算式打錯了嗎？（用下面的除錯切面驗證）
□ 目標方法是 public 嗎？
□ 是自呼叫嗎？
```

**除錯技巧：先寫一個「攔截一切」的切面確認 AOP 本身有在運作**

```java
@Aspect
@Component
public class DebugAspect {
    private static final Logger log = LoggerFactory.getLogger(DebugAspect.class);

    @Before("within(com.example.shop..*)")
    public void everything(JoinPoint jp) {
        log.info("[AOP-DEBUG] {}", jp.getSignature().toLongString());
    }
}
```

如果這個有輸出 → AOP 正常，是你的切點運算式問題。
如果連這個都沒輸出 → AOP 本身沒開起來。

### ② `@Around` 忘記 `proceed()`

```java
@Around("...")
public Object bad(ProceedingJoinPoint pjp) throws Throwable {
    log.info("執行中");
    return null;            // 💥 目標方法「完全沒被執行」，而且回傳 null
}
```

**症狀**：方法看起來執行成功（沒有例外），但什麼事都沒發生，回傳值是 `null`。
資料沒有存進去、通知沒有寄出、狀態沒有改變。**極難察覺。**

### ③ `@Around` 吞掉例外

```java
@Around("...")
public Object bad(ProceedingJoinPoint pjp) {
    try {
        return pjp.proceed();
    } catch (Throwable t) {
        log.error("出錯了", t);
        return null;         // 💥 例外被吞掉 → 交易不會 rollback，呼叫端以為成功
    }
}
```

**切面除非有意為之，否則一律把例外原樣往外拋。**

### ④ 切點範圍過寬

```java
@Around("execution(* com.example..*.*(..))")     // ⚠️ 連 getter/setter、DTO 都攔
```

後果：效能下降、日誌爆量、可能攔到 Spring 自己的 Bean 造成詭異行為。

```java
// ✅ 限縮
@Around("within(com.example.shop..*) " +
        "&& @within(org.springframework.stereotype.Service) " +
        "&& execution(public * *(..))")
```

### ⑤ 切面自己也被攔截，造成無限遞迴

```java
@Aspect
@Component
public class BadAspect {
    @Around("within(com.example.shop..*)")    // ⚠️ 這個範圍包含切面自己
    public Object around(ProceedingJoinPoint pjp) throws Throwable {
        this.helper();                         // → 又觸發切面 → StackOverflowError
        return pjp.proceed();
    }
    private void helper() { }
}
```

實際上 Spring 會排除 `@Aspect` 類別自己，但如果切面呼叫了範圍內的其他 Bean，仍可能出問題。

```java
// ✅ 明確排除
@Around("within(com.example.shop..*) && !within(@org.aspectj.lang.annotation.Aspect *)")
```

### ⑥ 註解的 `@Retention` 不是 `RUNTIME`

```java
@Retention(RetentionPolicy.CLASS)     // ❌ 預設值，執行期讀不到
public @interface Timed { }
```

**症狀**：切點 `@annotation(Timed)` 永遠不匹配，沒有任何錯誤訊息。

### ⑦ 在切面裡注入了會造成循環的 Bean

```java
@Aspect
@Component
public class AuditAspect {
    @Autowired private OrderService orderService;   // ⚠️ 而 OrderService 又被這個切面攔截
}
```

可能造成啟動失敗或「Bean 錯過 AOP 加工」的警告。**用 `ObjectProvider` 延遲取得。**

---

## 4.21 本章練習

### 練習 1：預測執行順序

```java
@Aspect @Component @Order(1)
class AspectA {
    @Around("execution(* Demo.hello(..))")
    Object around(ProceedingJoinPoint pjp) throws Throwable {
        System.out.println("A-in");
        Object r = pjp.proceed();
        System.out.println("A-out");
        return r;
    }
}

@Aspect @Component @Order(2)
class AspectB {
    @Before("execution(* Demo.hello(..))")
    void before() { System.out.println("B-before"); }

    @After("execution(* Demo.hello(..))")
    void after() { System.out.println("B-after"); }

    @AfterReturning("execution(* Demo.hello(..))")
    void afterReturning() { System.out.println("B-afterReturning"); }
}

@Component
class Demo {
    String hello() { System.out.println("hello"); return "hi"; }
}
```

寫出 `demo.hello()` 的完整輸出。

<details>
<summary>參考解答</summary>

```
A-in
B-before
hello
B-afterReturning
B-after
A-out
```

**推導：**

1. `@Order(1)` 的 `AspectA` 在**外層**，先進後出。
2. 進入 `AspectA` 的 `@Around` 前半 → `A-in`。
3. `pjp.proceed()` 進入下一層 `AspectB`。
4. `AspectB` 的 `@Before` → `B-before`。
5. 目標方法 → `hello`。
6. 同一個切面內的順序（Spring 5.2.7+）：`@AfterReturning` → `@After`。
   所以是 `B-afterReturning` 然後 `B-after`。
7. 回到 `AspectA` 的 `@Around` 後半 → `A-out`。

**如果 `hello()` 拋出例外，輸出會變成：**

```
A-in
B-before
（例外拋出）
B-after            ← 沒有 @AfterThrowing，所以只有 @After
（例外繼續往外拋，A-out 不會執行，因為 AspectA 的 proceed() 拋了例外）
```

注意 `A-out` **不會出現**——因為 `AspectA` 的 `@Around` 沒有 try-catch，
`pjp.proceed()` 拋例外之後，`System.out.println("A-out")` 那行根本到不了。

**這題想傳達的重點**：`@Around` 如果要保證「後半一定執行」，必須自己寫 `try-finally`。

</details>

### 練習 2：找出失效原因

以下五段程式，各自的註解為什麼不生效？

```java
// A
@Service
public class AService {
    public void batch(List<Item> items) {
        items.forEach(this::processOne);
    }
    @Transactional
    public void processOne(Item item) { }
}

// B
@Service
public class BService {
    @Transactional
    private void save(Item item) { }
    public void doIt(Item item) { save(item); }
}

// C
@Service
public final class CService {
    @Transactional
    public void save(Item item) { }
}

// D
@Service
public class DService {
    @Cacheable("items")
    public final Item find(long id) { return null; }
}

// E
@Service
public class EService {
    @Transactional
    public void save(Item item) {
        try {
            repository.insert(item);
        } catch (DataAccessException e) {
            log.error("失敗", e);
        }
    }
}
```

<details>
<summary>參考解答</summary>

| | 原因 | 修正 |
|---|---|---|
| **A** | **自呼叫**。`this::processOne` 是方法參考，等同 `this.processOne(...)`，不經過代理 | 把 `processOne` 拆到另一個 Bean |
| **B** | **雙重失效**：① `private` 方法 CGLIB 無法覆寫 ② 只能自呼叫 | 改成 public 並拆到另一個 Bean |
| **C** | **`final` 類別無法被 CGLIB 繼承**。這個會在**啟動時報錯**（`Cannot subclass final class`） | 拿掉 `final` |
| **D** | **`final` 方法無法被覆寫**。⚠️ **不會報錯，靜靜失效** —— 比 C 更危險 | 拿掉方法上的 `final` |
| **E** | **例外被吞掉**，交易切面看不到例外，照常 commit | 記錄後重新拋出，或用 `TransactionAspectSupport.currentTransactionStatus().setRollbackOnly()` |

**E 的兩種修法：**

```java
// 修法 1：記錄後重拋（推薦）
@Transactional
public void save(Item item) {
    try {
        repository.insert(item);
    } catch (DataAccessException e) {
        log.error("寫入 item {} 失敗", item.id(), e);
        throw new ItemSaveException("寫入失敗", e);      // 重新拋出
    }
}

// 修法 2：明確標記 rollback（需要吞例外但仍要 rollback 時）
@Transactional
public void save(Item item) {
    try {
        repository.insert(item);
    } catch (DataAccessException e) {
        log.error("寫入失敗", e);
        TransactionAspectSupport.currentTransactionStatus().setRollbackOnly();
    }
}
```

**C 與 D 的對比很值得記住**：
`final` **類別**啟動就爆（好事，早期發現）；
`final` **方法**靜靜失效（壞事，可能上線後才發現資料不一致）。
這就是 4.18 那個 ArchUnit 測試的價值。

</details>

### 練習 3：寫一個限流切面

需求：

1. 自訂註解 `@RateLimit(permitsPerSecond = 10, key = "'user:' + #userId")`。
2. `key` 用 SpEL 解析，支援引用方法參數。
3. 超過速率時拋 `RateLimitExceededException`。
4. 用第 02 章寫的 `RateLimiter` 介面。
5. 附測試。

<details>
<summary>參考解答</summary>

```java
package com.example.shop.ratelimit;

import java.lang.annotation.Documented;
import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

@Documented
@Target(ElementType.METHOD)
@Retention(RetentionPolicy.RUNTIME)
public @interface RateLimit {

    /**
     * 限流的 key，SpEL 運算式。可引用方法參數，例如 "'user:' + #userId"。
     * 留空則用「類別.方法」當 key（全域限流）。
     */
    String key() default "";

    /** 每秒允許次數。0 表示用全域預設值。 */
    double permitsPerSecond() default 0;

    /** 被擋下時的錯誤訊息 */
    String message() default "請求過於頻繁，請稍後再試";
}
```

```java
package com.example.shop.ratelimit;

public class RateLimitExceededException extends RuntimeException {

    private final String key;

    public RateLimitExceededException(String key, String message) {
        super(message);
        this.key = key;
    }

    public String getKey() { return key; }
}
```

```java
package com.example.shop.ratelimit;

import org.aspectj.lang.ProceedingJoinPoint;
import org.aspectj.lang.annotation.Around;
import org.aspectj.lang.annotation.Aspect;
import org.aspectj.lang.reflect.MethodSignature;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.core.DefaultParameterNameDiscoverer;
import org.springframework.core.ParameterNameDiscoverer;
import org.springframework.core.annotation.Order;
import org.springframework.expression.EvaluationContext;
import org.springframework.expression.ExpressionParser;
import org.springframework.expression.spel.standard.SpelExpressionParser;
import org.springframework.expression.spel.support.StandardEvaluationContext;
import org.springframework.stereotype.Component;

/**
 * 限流切面。
 *
 * <p>@Order(1)：必須在最外層。
 * 若排在交易切面裡面，被擋下的請求已經開了一個交易又立刻 rollback，白白浪費連線。
 */
@Aspect
@Component
@Order(1)
public class RateLimitAspect {

    private static final Logger log = LoggerFactory.getLogger(RateLimitAspect.class);

    private final ExpressionParser parser = new SpelExpressionParser();
    private final ParameterNameDiscoverer nameDiscoverer = new DefaultParameterNameDiscoverer();
    private final RateLimiter rateLimiter;

    public RateLimitAspect(RateLimiter rateLimiter) {
        this.rateLimiter = rateLimiter;
    }

    @Around("@annotation(rateLimit)")
    public Object limit(ProceedingJoinPoint pjp, RateLimit rateLimit) throws Throwable {

        String key = resolveKey(pjp, rateLimit);

        if (!rateLimiter.tryAcquire(key)) {
            log.warn("限流觸發 key={} method={}", key, pjp.getSignature().toShortString());
            throw new RateLimitExceededException(key, rateLimit.message());
        }
        return pjp.proceed();
    }

    private String resolveKey(ProceedingJoinPoint pjp, RateLimit rateLimit) {
        if (rateLimit.key().isBlank()) {
            return pjp.getSignature().toShortString();      // 全域限流
        }
        try {
            MethodSignature signature = (MethodSignature) pjp.getSignature();
            EvaluationContext context = new StandardEvaluationContext();
            String[] names = nameDiscoverer.getParameterNames(signature.getMethod());
            Object[] args = pjp.getArgs();
            if (names != null) {
                for (int i = 0; i < names.length; i++) {
                    context.setVariable(names[i], args[i]);
                }
            }
            Object value = parser.parseExpression(rateLimit.key()).getValue(context);
            return String.valueOf(value);
        } catch (Exception e) {
            // ★ SpEL 解析失敗時「降級成全域限流」，不要讓限流機制本身變成故障點 ★
            log.warn("限流 key 運算式解析失敗：{}，改用方法名稱", rateLimit.key(), e);
            return pjp.getSignature().toShortString();
        }
    }
}
```

使用：

```java
@RestController
@RequestMapping("/orders")
public class OrderController {

    @PostMapping
    @RateLimit(key = "'create-order:' + #request.customerId()",
               message = "下單過於頻繁，請稍候")
    public Order create(@RequestBody CreateOrderRequest request) { /* ... */ }

    @GetMapping("/report")
    @RateLimit(message = "報表查詢排隊中")          // 沒有 key → 全域限流
    public Report report() { /* ... */ }
}
```

**測試：**

```java
package com.example.shop.ratelimit;

import org.junit.jupiter.api.Test;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.autoconfigure.aop.AopAutoConfiguration;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class RateLimitAspectTest {

    private final ApplicationContextRunner runner = new ApplicationContextRunner()
            .withConfiguration(AutoConfigurations.of(AopAutoConfiguration.class))
            .withUserConfiguration(TestConfig.class);

    @Test
    void 未超過速率時應正常執行() {
        runner.run(context -> {
            DemoService service = context.getBean(DemoService.class);
            assertThatCode(() -> service.doSomething(1L)).doesNotThrowAnyException();
        });
    }

    @Test
    void 超過速率時應拋出例外() {
        runner.run(context -> {
            DemoService service = context.getBean(DemoService.class);
            RecordingRateLimiter limiter = context.getBean(RecordingRateLimiter.class);
            limiter.allow = false;

            assertThatThrownBy(() -> service.doSomething(1L))
                    .isInstanceOf(RateLimitExceededException.class)
                    .hasMessage("太快了");
        });
    }

    @Test
    void key應由SpEL解析出使用者ID() {
        runner.run(context -> {
            DemoService service = context.getBean(DemoService.class);
            RecordingRateLimiter limiter = context.getBean(RecordingRateLimiter.class);

            service.doSomething(42L);
            service.doSomething(99L);

            assertThat(limiter.keys).containsExactly("user:42", "user:99");
        });
    }

    @Test
    void 沒有key時應用方法名稱當全域key() {
        runner.run(context -> {
            DemoService service = context.getBean(DemoService.class);
            RecordingRateLimiter limiter = context.getBean(RecordingRateLimiter.class);

            service.globalLimited();

            assertThat(limiter.keys).hasSize(1);
            assertThat(limiter.keys.get(0)).contains("globalLimited");
        });
    }

    @Test
    void 被限流時不應執行目標方法() {
        runner.run(context -> {
            DemoService service = context.getBean(DemoService.class);
            RecordingRateLimiter limiter = context.getBean(RecordingRateLimiter.class);
            limiter.allow = false;

            assertThatThrownBy(() -> service.doSomething(1L))
                    .isInstanceOf(RateLimitExceededException.class);

            assertThat(service.executed).isZero();        // ★ 驗證「沒有發生」★
        });
    }

    // ── 測試替身 ──

    static class RecordingRateLimiter implements RateLimiter {
        final List<String> keys = new ArrayList<>();
        boolean allow = true;

        @Override
        public boolean tryAcquire(String key) {
            keys.add(key);
            return allow;
        }
    }

    @Service
    static class DemoService {
        int executed = 0;

        @RateLimit(key = "'user:' + #userId", message = "太快了")
        public void doSomething(long userId) { executed++; }

        @RateLimit
        public void globalLimited() { executed++; }
    }

    @Configuration(proxyBeanMethods = false)
    static class TestConfig {
        @Bean RecordingRateLimiter rateLimiter() { return new RecordingRateLimiter(); }
        @Bean RateLimitAspect rateLimitAspect(RateLimiter l) { return new RateLimitAspect(l); }
        @Bean DemoService demoService() { return new DemoService(); }
    }
}
```

**三個設計重點：**

1. **`@Order(1)` 在最外層**——被擋下的請求不該進到交易、不該佔用資料庫連線。
2. **SpEL 解析失敗時降級成全域限流**——限流是保護機制，
   它自己壞掉時應該「降級」而不是「讓整個 API 掛掉」。
3. **測試「被限流時目標方法沒有執行」**——這是最容易漏掉的斷言。
   如果切面寫錯（例如先 `proceed()` 再檢查），功能測試看起來會過，但完全沒有限流效果。

</details>

### 練習 4：診斷一個真實問題

某服務的訂單匯入 API 有這段程式碼。QA 回報「匯入 100 筆時，如果第 50 筆失敗，
前 49 筆有寫進去、第 50 筆之後完全沒處理，而且沒有任何錯誤回應」。

```java
@RestController
public class ImportController {
    private final ImportService importService;

    @PostMapping("/import")
    public ImportResult importOrders(@RequestBody List<OrderRequest> requests) {
        return importService.importAll(requests);
    }
}

@Service
public class ImportService {
    private static final Logger log = LoggerFactory.getLogger(ImportService.class);
    private final OrderRepository repository;

    @Transactional
    public ImportResult importAll(List<OrderRequest> requests) {
        int count = 0;
        for (OrderRequest r : requests) {
            this.importOne(r);
            count++;
        }
        return new ImportResult(count, List.of());
    }

    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public void importOne(OrderRequest r) {
        repository.save(new Order(null, r.customer(), r.amount(), "CREATED"));
    }
}

@Aspect
@Component
public class ImportAspect {
    private static final Logger log = LoggerFactory.getLogger(ImportAspect.class);

    @Around("execution(* com.example.shop..ImportService.*(..))")
    public Object handle(ProceedingJoinPoint pjp) {
        try {
            return pjp.proceed();
        } catch (Throwable t) {
            log.error("匯入出錯", t);
            return null;
        }
    }
}
```

找出所有問題。

<details>
<summary>參考解答</summary>

**四個問題，互相疊加造成了 QA 看到的現象：**

#### 問題 1：`ImportAspect` 吞掉例外並回傳 `null`

```java
} catch (Throwable t) {
    log.error("匯入出錯", t);
    return null;              // 💥
}
```

這造成三件事：

- **HTTP 回應是 `200 OK` 加上空 body**（因為回傳 `null`），前端完全不知道失敗了。
- **例外沒有往外拋，交易切面看不到** → `importAll` 的交易照常 commit。
- QA 說「沒有任何錯誤回應」就是這個原因。

#### 問題 2：`this.importOne(r)` 是自呼叫

`@Transactional(propagation = REQUIRES_NEW)` **完全沒有生效**。
所有的 save 都在 `importAll` 那一個交易裡。

#### 問題 3：`REQUIRES_NEW` 的設計意圖與實際行為不符

就算修好自呼叫，`REQUIRES_NEW` 也不是這裡想要的。
它會讓每一筆開一個**獨立交易**，但外層 `importAll` 的交易還在——
100 筆就是 101 個交易，而且外層交易全程持有連線，
**連線池會被「外層 1 條 + 內層 1 條」同時佔用兩條**。
匯入量大時很容易把連線池吃光。

#### 問題 4：沒有錯誤收集

`ImportResult` 的 `failures` 永遠是 `List.of()`，
就算某幾筆失敗，呼叫端也不知道是哪幾筆。

---

**修正版：**

```java
// ① 切面：不要吞例外
@Aspect
@Component
@Order(10)
public class ImportAspect {
    private static final Logger log = LoggerFactory.getLogger(ImportAspect.class);

    @Around("execution(* com.example.shop..ImportService.*(..))")
    public Object handle(ProceedingJoinPoint pjp) throws Throwable {
        long start = System.nanoTime();
        try {
            return pjp.proceed();
        } catch (Throwable t) {
            log.error("匯入出錯：{}", pjp.getSignature().toShortString(), t);
            throw t;                          // ★ 原樣往外拋 ★
        } finally {
            log.info("{} 耗時 {} ms", pjp.getSignature().toShortString(),
                    (System.nanoTime() - start) / 1_000_000);
        }
    }
}
```

```java
// ② 拆成兩個 Bean，外層不開交易
@Service
public class ImportService {

    private static final Logger log = LoggerFactory.getLogger(ImportService.class);

    private final OrderImporter importer;     // ★ 注入的是代理 ★

    public ImportService(OrderImporter importer) {
        this.importer = importer;
    }

    // ★ 沒有 @Transactional：外層不該包一個橫跨 100 筆的長交易 ★
    public ImportResult importAll(List<OrderRequest> requests) {
        int success = 0;
        List<ImportFailure> failures = new ArrayList<>();

        for (int i = 0; i < requests.size(); i++) {
            OrderRequest r = requests.get(i);
            try {
                importer.importOne(r);        // ✅ 經過代理，每筆一個獨立交易
                success++;
            } catch (Exception e) {
                log.warn("第 {} 筆匯入失敗 sku={}", i, r.sku(), e);
                failures.add(new ImportFailure(i, r.sku(), e.getMessage()));
            }
        }
        return new ImportResult(success, failures);
    }

    public record ImportFailure(int index, String sku, String reason) { }
    public record ImportResult(int successCount, List<ImportFailure> failures) { }
}
```

```java
@Service
public class OrderImporter {

    private final OrderRepository repository;

    public OrderImporter(OrderRepository repository) {
        this.repository = repository;
    }

    @Transactional                            // ★ REQUIRED（預設）就好，不需要 REQUIRES_NEW ★
    public void importOne(OrderRequest r) {
        repository.save(new Order(null, r.customer(), r.amount(), "CREATED"));
    }
}
```

**修正後的行為**：

- 第 50 筆失敗 → 只有第 50 筆 rollback，其餘 99 筆正常寫入。
- 回應會包含 `successCount: 99` 與失敗明細。
- 每筆一個短交易，連線借用時間短，不會拖垮連線池。

**這題的核心教訓**：
「例外被切面吞掉」是**最惡劣的一種 bug**——
它同時破壞了交易語意、錯誤回報、與可觀測性，而且從 API 的行為完全看不出來。
**切面除非是刻意的容錯設計（例如稽核失敗不影響業務），否則永遠把例外原樣往外拋。**

</details>

---

## 4.22 驗收清單

- [ ] 我能說出 AOP 解決什麼問題，也知道「抽工具方法」與「繼承」為什麼解決不了。
- [ ] 我能精確使用 Aspect / Join Point / Pointcut / Advice / Target / Proxy / Weaving 七個名詞。
- [ ] 我能手寫一個 JDK 動態代理，並說出它「只能代理介面」的根本原因。
- [ ] 我能手寫一個 CGLIB 代理，並列出它對 final / private / static 的限制。
- [ ] 我知道 Spring Boot 2.0+ 預設用 CGLIB，也知道為什麼這樣改比較好。
- [ ] 我能指出 AOP 代理在 Bean 生命週期的哪一步產生（`postProcessAfterInitialization`）。
- [ ] 我知道 `@PostConstruct` 裡的 `this` 還不是代理。
- [ ] 我知道 `@Aspect` 一定要配 `@Component` 才會生效。
- [ ] 我能讀寫 `execution` / `within` / `@annotation` / `@within` / `args` / `bean` 切點。
- [ ] 我知道 Spring AOP 只支援「方法執行」這一種 join point。
- [ ] 我能說出五種 Advice 的實際執行順序（含例外路徑）。
- [ ] 我知道 `@Around` 忘記 `proceed()` 會讓目標方法完全不執行且回傳 null。
- [ ] 我會用「自訂註解 + `@annotation` 切點」寫可讀性好的切面。
- [ ] 我知道自訂註解的 `@Retention` 必須是 `RUNTIME`。
- [ ] 我能用 `@Order` 控制多切面順序，也知道重試切面必須在交易切面外面。
- [ ] **我能畫出自呼叫失效的完整過程，並說出「代理只能攔截從外面進來的呼叫」。**
- [ ] 我能用四種方式解決自呼叫，並知道「拆到另一個 Bean」是首選。
- [ ] 我能列出 `@Transactional` 的八種失效情境。
- [ ] 我知道 `final` 類別會啟動報錯，但 `final` 方法會靜靜失效。
- [ ] 我知道不要在切面裡做昂貴的事（序列化、查資料庫、呼叫外部 API）。
- [ ] 我知道 `getClass()` 在有代理時會回傳 `$$SpringCGLIB$$` 類別，也知道用 `ultimateTargetClass()` 取代。
- [ ] 我會用 `AopUtils.isAopProxy()` 驗證 Bean 有沒有被代理。
- [ ] 我會為切面寫測試，包含「被攔截時目標方法沒有執行」這種負向斷言。
- [ ] 我知道 ArchUnit 可以把「不可以有 final 的 `@Transactional` 方法」變成 CI 規則。
- [ ] 我知道什麼情況 Spring AOP 不夠用，也知道 AspectJ 完全織入的代價。

---

完成後請前往 [05-logging-and-actuator.md](./05-logging-and-actuator.md)。
