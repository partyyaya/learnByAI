# 第 03 章：繼承、多型與介面

> 這章是整個 Java 生態的樞紐。你之後看到的每一個 `@Autowired`、每一個「換個實作就換掉整個行為」的設計，
> 底層都是本章的**多型**。
>
> 但這章同時也是最容易被誤用的：**繼承常被拿來「複用程式碼」，那是錯的用法。**
> 我們會把「什麼時候該用繼承、什麼時候該用組合、什麼時候該用介面」講到你能直接套在專案上。

---

## 3.1 學習目標

完成本章後，你應該可以：

- 使用 `extends` 與 `super`，並說出建構子的呼叫鏈與初始化順序。
- 說出方法覆寫的四條規則，並知道 `@Override` 為什麼一定要寫。
- 解釋多型（動態分派）如何運作，並說明**欄位不會多型**這個陷阱。
- 設計抽象類別與模板方法（Template Method）。
- 使用介面的 `default` / `static` / `private` 方法，並處理多重繼承衝突。
- 在「抽象類別 vs 介面」之間做出有理由的選擇。
- 用**組合 + 策略模式**取代不當的繼承。
- 說明里氏替換原則，並用 `instanceof` 模式比對安全地做型別判斷。
- 說出「對介面編程」如何導向依賴注入，以及 Spring 的代理為什麼對 `private` 方法無效。

---

## 3.2 繼承：`extends` 與 `super`

```java
// 父類別（superclass / base class）
public class Employee {

    protected final String name;      // protected：子類別可直接存取
    protected final long baseSalary;  // 單位：分

    public Employee(String name, long baseSalary) {
        if (name == null || name.isBlank()) {
            throw new IllegalArgumentException("姓名不可為空");
        }
        if (baseSalary < 0) {
            throw new IllegalArgumentException("底薪不可為負: " + baseSalary);
        }
        this.name = name.strip();
        this.baseSalary = baseSalary;
    }

    public long monthlyPay() {
        return baseSalary;
    }

    public String describe() {
        return "%s 月薪 %.2f".formatted(name, monthlyPay() / 100.0);
    }
}
```

```java
// 子類別（subclass / derived class）
public class SalesEmployee extends Employee {

    private final long salesAmount;       // 本月業績（分）
    private final int commissionPercent;  // 抽成百分比

    public SalesEmployee(String name, long baseSalary, long salesAmount, int commissionPercent) {
        super(name, baseSalary);           // ① 必須先呼叫父類別建構子，且必須是第一行
        if (commissionPercent < 0 || commissionPercent > 100) {
            throw new IllegalArgumentException("抽成需在 0~100，收到: " + commissionPercent);
        }
        this.salesAmount = salesAmount;
        this.commissionPercent = commissionPercent;
    }

    @Override
    public long monthlyPay() {              // ② 覆寫父類別方法
        return super.monthlyPay() + salesAmount * commissionPercent / 100;   // ③ 呼叫父類別實作
    }
}
```

```java
public class InheritDemo {
    public static void main(String[] args) {
        Employee e = new Employee("小明", 50_000_00);
        System.out.println(e.describe());        // 小明 月薪 50000.00

        SalesEmployee s = new SalesEmployee("小華", 40_000_00, 200_000_00, 5);
        System.out.println(s.describe());        // 小華 月薪 50000.00
        // 40000 + 200000 * 5% = 40000 + 10000 = 50000
    }
}
```

**注意 `describe()` 這件事**：它定義在 `Employee` 裡，內部呼叫 `monthlyPay()`。
但 `s.describe()` 呼叫到的是 **`SalesEmployee` 的** `monthlyPay()`。這就是多型（3.4 節詳述）。

### `super` 的兩種用途

```java
super(args);              // 呼叫父類別建構子（必須在子類別建構子的第一行）
super.methodName();       // 呼叫父類別的方法實作
```

### 隱含的 `super()`

```java
public class ImplicitSuper {

    static class Parent {
        Parent() { System.out.println("Parent()"); }
        Parent(String s) { System.out.println("Parent(String)"); }
    }

    static class Child extends Parent {
        Child() {
            // 這裡沒寫 super()，編譯器自動插入 super()（無參數版本）
            System.out.println("Child()");
        }
    }

    static class Parent2 {
        Parent2(String s) { }        // 只有這個建構子，沒有無參數版本
    }

    // static class Child2 extends Parent2 {
    //     Child2() { }               // ❌ 編譯錯誤：找不到 super()
    // }

    static class Child2Fixed extends Parent2 {
        Child2Fixed() {
            super("必須明確呼叫");     // ✅
        }
    }

    public static void main(String[] args) {
        new Child();
        // Parent()
        // Child()
    }
}
```

> **實務踩雷**：父類別只提供有參數建構子時，所有子類別都被迫明確呼叫 `super(...)`。
> 這在框架整合時常出問題（Spring 的某些基底類別、JPA 的 Entity 繼承）。
> 設計父類別時，如果預期會被繼承，考慮提供一個 `protected` 無參數建構子。

### Java 是單一繼承

```java
// class A extends B, C { }     // ❌ Java 不支援多重類別繼承
class A extends B implements C, D { }   // ✅ 可以實作多個介面
```

所有類別都隱含繼承 `java.lang.Object`，所以每個物件都有 `toString()`、`equals()`、`hashCode()`、`getClass()`。

---

## 3.3 方法覆寫的規則

```java
import java.io.IOException;
import java.util.List;
import java.util.ArrayList;

public class OverrideRules {

    static class Parent {
        protected Number getValue() { return 1; }
        public void doWork() throws IOException { }
        private void internal() { }
        public static void staticMethod() { System.out.println("Parent.static"); }
        public final void cannotOverride() { }
    }

    static class Child extends Parent {

        // ① 存取權可以放寬（protected → public），不可縮小
        @Override
        public Integer getValue() {      // ② 回傳型別可以是子型別（共變回傳）
            return 2;
        }

        // ③ 宣告的 checked 例外可以更少或更窄，不可更多或更寬
        @Override
        public void doWork() { }         // 不丟例外，合法

        // ④ private 方法不參與覆寫，這是「另一個獨立方法」
        private void internal() { }

        // static 方法是「隱藏」不是「覆寫」，加 @Override 會編譯錯誤
        public static void staticMethod() { System.out.println("Child.static"); }

        // @Override public void cannotOverride() { }   // ❌ final 方法不可覆寫
    }

    public static void main(String[] args) {
        Parent p = new Child();
        System.out.println(p.getValue());       // 2  ← 動態分派，走 Child 的實作
        Parent.staticMethod();                  // Parent.static ← static 看「宣告型別」，不是物件
    }
}
```

### 四條規則整理

| 項目 | 規則 |
|---|---|
| 方法簽章（名稱 + 參數） | **必須完全相同**（不同就變成重載，不是覆寫） |
| 回傳型別 | 相同，或是父類別回傳型別的**子型別**（共變回傳） |
| 存取權 | 可以放寬（`protected` → `public`），**不可縮小** |
| checked 例外 | 可以更少 / 更窄 / 不丟，**不可更多或更寬** |

### `@Override` 為什麼一定要寫

```java
public class OverrideAnnotation {

    static class Base {
        public boolean equals(Object o) { return this == o; }
        public void process(String data) { System.out.println("Base: " + data); }
    }

    static class WithoutAnnotation extends Base {
        // 想覆寫，但參數型別打錯了 → 變成「重載」，編譯器完全不會抗議
        public void process(StringBuilder data) { System.out.println("Sub: " + data); }
    }

    static class WithAnnotation extends Base {
        // @Override
        // public void process(StringBuilder data) { }   // ❌ 加了註解就編譯錯誤，馬上發現
        @Override
        public void process(String data) { System.out.println("Sub: " + data); }
    }

    public static void main(String[] args) {
        Base b1 = new WithoutAnnotation();
        b1.process("hello");        // Base: hello   ← 沒覆寫成功！靜默走了父類別
        Base b2 = new WithAnnotation();
        b2.process("hello");        // Sub: hello    ✅
    }
}
```

**最經典的災難是 `equals`：**

```java
public class EqualsTypo {

    static class Point {
        int x, y;
        Point(int x, int y) { this.x = x; this.y = y; }

        // ❌ 參數型別是 Point，不是 Object → 這是「重載」，不是「覆寫」
        public boolean equals(Point other) {
            return this.x == other.x && this.y == other.y;
        }
    }

    public static void main(String[] args) {
        Point a = new Point(1, 2);
        Point b = new Point(1, 2);

        System.out.println(a.equals(b));                 // true  ← 呼叫到重載版本

        Object ob = b;
        System.out.println(a.equals(ob));                // false ← 呼叫 Object.equals！

        java.util.List<Point> list = new java.util.ArrayList<>();
        list.add(a);
        System.out.println(list.contains(b));            // false ← 集合內部用 Object.equals
    }
}
```

`List.contains` 內部呼叫的是 `equals(Object)`，所以完全走不到你寫的版本。**加上 `@Override` 就會在編譯期報錯。**

> **規則：任何你認為在覆寫的方法，都加 `@Override`。** 它不影響執行，只讓編譯器幫你檢查。

---

## 3.4 多型：本章的核心

**多型** = 用父型別（或介面）的變數，呼叫到實際物件的方法實作。

### 實務案例：多種付款方式

```java
import java.math.BigDecimal;
import java.util.List;

public class PaymentDemo {

    // 抽象的付款處理器
    static abstract class PaymentProcessor {
        protected final String merchantId;

        protected PaymentProcessor(String merchantId) {
            this.merchantId = merchantId;
        }

        /** 子類別必須實作：實際扣款 */
        public abstract String charge(BigDecimal amount);

        /** 各通道手續費不同 */
        public abstract BigDecimal feeFor(BigDecimal amount);

        /** 共用邏輯：所有通道都一樣 */
        public final String pay(BigDecimal amount) {
            if (amount.compareTo(BigDecimal.ZERO) <= 0) {
                throw new IllegalArgumentException("金額必須大於 0: " + amount);
            }
            BigDecimal fee = feeFor(amount);
            String txId = charge(amount);
            return "[%s] 收款 %s，手續費 %s，交易號 %s"
                    .formatted(getClass().getSimpleName(), amount, fee, txId);
        }
    }

    static class CreditCardProcessor extends PaymentProcessor {
        CreditCardProcessor(String merchantId) { super(merchantId); }

        @Override
        public String charge(BigDecimal amount) {
            return "CC-" + merchantId + "-" + System.nanoTime();
        }

        @Override
        public BigDecimal feeFor(BigDecimal amount) {
            return amount.multiply(new BigDecimal("0.028"));      // 2.8%
        }
    }

    static class LinePayProcessor extends PaymentProcessor {
        LinePayProcessor(String merchantId) { super(merchantId); }

        @Override
        public String charge(BigDecimal amount) {
            return "LINE-" + merchantId + "-" + System.nanoTime();
        }

        @Override
        public BigDecimal feeFor(BigDecimal amount) {
            return amount.multiply(new BigDecimal("0.03"));       // 3%
        }
    }

    static class BankTransferProcessor extends PaymentProcessor {
        BankTransferProcessor(String merchantId) { super(merchantId); }

        @Override
        public String charge(BigDecimal amount) {
            return "ATM-" + merchantId + "-" + System.nanoTime();
        }

        @Override
        public BigDecimal feeFor(BigDecimal amount) {
            return new BigDecimal("15");                          // 固定 15 元
        }
    }

    public static void main(String[] args) {
        // 關鍵：宣告型別都是 PaymentProcessor，執行時各自走自己的實作
        List<PaymentProcessor> processors = List.of(
                new CreditCardProcessor("M001"),
                new LinePayProcessor("M001"),
                new BankTransferProcessor("M001"));

        BigDecimal amount = new BigDecimal("1000");
        for (PaymentProcessor p : processors) {
            System.out.println(p.pay(amount));
        }
    }
}
```

輸出（交易號會不同）：

```
[CreditCardProcessor] 收款 1000，手續費 28.000，交易號 CC-M001-...
[LinePayProcessor] 收款 1000，手續費 30.00，交易號 LINE-M001-...
[BankTransferProcessor] 收款 1000，手續費 15，交易號 ATM-M001-...
```

### 多型解決了什麼

沒有多型的話，程式碼會長這樣：

```java
// ❌ 每加一種付款方式，就要回來改這個 if-else
public String pay(String method, BigDecimal amount) {
    if (method.equals("CREDIT_CARD")) {
        // 30 行信用卡邏輯
    } else if (method.equals("LINE_PAY")) {
        // 30 行 LINE Pay 邏輯
    } else if (method.equals("BANK_TRANSFER")) {
        // 30 行轉帳邏輯
    }
    throw new IllegalArgumentException("不支援: " + method);
}
```

用多型後：

```java
// ✅ 新增付款方式 = 新增一個類別。這個方法永遠不用改
public String pay(PaymentProcessor processor, BigDecimal amount) {
    return processor.pay(amount);
}
```

> 這就是**開放封閉原則（OCP）**：對擴充開放（可以加新類別），對修改封閉（不用改既有程式碼）。
> 也是第 02 站 Spring DI 存在的理由——它負責在執行時決定「要注入哪一個實作」。

### 向上轉型與向下轉型

```java
public class Casting {

    static class Animal { void speak() { System.out.println("..."); } }
    static class Dog extends Animal {
        @Override void speak() { System.out.println("汪"); }
        void fetch() { System.out.println("撿球"); }
    }
    static class Cat extends Animal {
        @Override void speak() { System.out.println("喵"); }
    }

    public static void main(String[] args) {
        // 向上轉型：永遠安全，自動發生
        Animal a = new Dog();
        a.speak();          // 汪  ← 執行時決定
        // a.fetch();       // ❌ 編譯錯誤：Animal 型別上沒有 fetch()

        // 向下轉型：需要明確寫，且可能失敗
        Dog d = (Dog) a;
        d.fetch();          // 撿球

        Animal cat = new Cat();
        try {
            Dog wrong = (Dog) cat;     // ClassCastException
        } catch (ClassCastException e) {
            System.out.println("轉型失敗: " + e.getMessage());
        }

        // ✅ 安全做法：先用 instanceof 檢查（Java 16+ 可同時綁定變數）
        if (cat instanceof Dog dog) {
            dog.fetch();
        } else {
            System.out.println("不是狗，不能撿球");
        }
    }
}
```

> **實務原則**：程式裡出現大量向下轉型，通常代表抽象設計錯了。
> 如果你需要知道「它到底是哪個子類別」才能做事，那個行為應該定義在父型別上（讓多型處理），
> 或者你該用 3.14 節的 `sealed` + 模式比對。

---

## 3.5 陷阱：欄位不會多型

這是很多人不知道的細節，也是「明明覆寫了為什麼沒生效」的一種來源。

```java
public class FieldHiding {

    static class Parent {
        String name = "Parent";
        String getName() { return "Parent"; }
    }

    static class Child extends Parent {
        String name = "Child";                    // 這是「隱藏」，不是覆寫
        @Override String getName() { return "Child"; }
    }

    public static void main(String[] args) {
        Parent p = new Child();

        System.out.println(p.name);         // Parent  ← 欄位看「宣告型別」（編譯期決定）
        System.out.println(p.getName());    // Child   ← 方法看「實際物件」（執行期決定）

        Child c = new Child();
        System.out.println(c.name);                 // Child
        System.out.println(((Parent) c).name);      // Parent  ← 同一個物件，兩個 name 欄位都存在！
    }
}
```

**規則：**

- **方法**是**動態綁定**（執行期依實際物件決定）→ 這才是多型。
- **欄位**是**靜態綁定**（編譯期依宣告型別決定）→ 沒有多型。

**實務結論**：不要在子類別宣告與父類別同名的欄位。這不是覆寫，只會製造兩個同名欄位和無盡的困惑。
需要子類別提供不同值時，**用方法**：

```java
public class ProperOverride {

    static abstract class Config {
        // ✅ 用方法讓子類別覆寫，而不是欄位
        protected abstract int timeoutMillis();

        public void connect() {
            System.out.println("以 " + timeoutMillis() + "ms 逾時連線");
        }
    }

    static class FastConfig extends Config {
        @Override protected int timeoutMillis() { return 1000; }
    }

    static class SlowConfig extends Config {
        @Override protected int timeoutMillis() { return 30_000; }
    }

    public static void main(String[] args) {
        for (Config c : java.util.List.of(new FastConfig(), new SlowConfig())) {
            c.connect();
        }
        // 以 1000ms 逾時連線
        // 以 30000ms 逾時連線
    }
}
```

---

## 3.6 繼承下的初始化順序，與一個經典陷阱

```java
public class InitWithInheritance {

    static class Parent {
        static { System.out.println("1. Parent 靜態區塊"); }
        { System.out.println("3. Parent 實例區塊"); }
        Parent() { System.out.println("4. Parent 建構子"); }
    }

    static class Child extends Parent {
        static { System.out.println("2. Child 靜態區塊"); }
        { System.out.println("5. Child 實例區塊"); }
        Child() { System.out.println("6. Child 建構子"); }
    }

    public static void main(String[] args) {
        new Child();
        System.out.println("--- 第二個 ---");
        new Child();
    }
}
```

輸出：

```
1. Parent 靜態區塊
2. Child 靜態區塊
3. Parent 實例區塊
4. Parent 建構子
5. Child 實例區塊
6. Child 建構子
--- 第二個 ---
3. Parent 實例區塊
4. Parent 建構子
5. Child 實例區塊
6. Child 建構子
```

**規則：父類別的靜態 → 子類別的靜態 → 父類別的實例 → 子類別的實例。**（靜態部分只跑一次）

### ⚠️ 建構子中呼叫可覆寫的方法：真實會出事的坑

```java
import java.util.ArrayList;
import java.util.List;

public class ConstructorTrap {

    static abstract class AbstractValidator {

        protected AbstractValidator() {
            // ❌ 在建構子裡呼叫抽象／可覆寫的方法
            System.out.println("父建構子取得規則: " + rules());
        }

        protected abstract List<String> rules();
    }

    static class EmailValidator extends AbstractValidator {

        private final List<String> myRules = new ArrayList<>(List.of("必須包含 @", "長度 > 5"));

        @Override
        protected List<String> rules() {
            return myRules;
        }

        public void check() {
            System.out.println("check() 時的規則: " + rules());
        }
    }

    public static void main(String[] args) {
        EmailValidator v = new EmailValidator();
        v.check();
    }
}
```

輸出：

```
父建構子取得規則: null      ← 💥
check() 時的規則: [必須包含 @, 長度 > 5]
```

**為什麼？** 依照初始化順序，父類別建構子執行時，子類別的 `myRules` **還沒初始化**（它是第 5 步），
所以 `rules()` 回傳 `null`。如果父建構子接著呼叫 `rules().size()`，就是一個 NPE，
而且堆疊訊息指向父類別，讓人完全找不到原因。

**修法：**

```java
import java.util.ArrayList;
import java.util.List;
import java.util.Objects;

public class ConstructorTrapFixed {

    static abstract class AbstractValidator {
        private final List<String> rules;

        // ✅ 方案 A：讓子類別把值透過 super(...) 傳上來
        protected AbstractValidator(List<String> rules) {
            this.rules = List.copyOf(Objects.requireNonNull(rules, "rules 不可為 null"));
            System.out.println("父建構子取得規則: " + this.rules);
        }

        protected List<String> rules() { return rules; }
    }

    static class EmailValidator extends AbstractValidator {
        EmailValidator() {
            super(List.of("必須包含 @", "長度 > 5"));
        }

        public void check() {
            System.out.println("check() 時的規則: " + rules());
        }
    }

    public static void main(String[] args) {
        new EmailValidator().check();
        // 父建構子取得規則: [必須包含 @, 長度 > 5]
        // check() 時的規則: [必須包含 @, 長度 > 5]
    }
}
```

> **鐵律：建構子裡只做欄位賦值與驗證，不要呼叫可被覆寫的方法。**
> 需要「建立後初始化」時，用明確的 `init()` 方法或工廠方法，讓物件先完整建好再呼叫。
> 這也是為什麼 Spring 有 `@PostConstruct`——框架保證所有依賴注入完成後才呼叫它。

---

## 3.7 `final`、`protected`、`abstract`

### `final` 的三種位置

```java
import java.util.ArrayList;
import java.util.List;

public class FinalDemo {

    // ① final 類別：不可被繼承
    static final class Immutable { }
    // static class Sub extends Immutable { }   // ❌

    static class Base {
        // ② final 方法：不可被覆寫
        public final void criticalLogic() {
            System.out.println("這個流程不允許子類別改");
        }
    }
    static class Sub extends Base {
        // @Override public void criticalLogic() { }   // ❌
    }

    public static void main(String[] args) {
        // ③ final 變數：只能賦值一次
        final int max = 100;
        // max = 200;                          // ❌

        final List<String> list = new ArrayList<>();
        list.add("a");                          // ✅ 內容可改（第 02 章 2.9 節）
        // list = new ArrayList<>();            // ❌ 參考不可改
    }
}
```

`String`、`Integer`、`LocalDate`、`BigDecimal` 都是 `final` 類別——因為它們是不可變的，
被繼承後子類別可能加上可變狀態，破壞不可變的保證。

### `protected` 的真正意義

`protected` 是**給子類別的 API**。一旦你把某個東西宣告成 `protected`，你就承諾要維護它。

```java
public abstract class AbstractRepository {

    // public API：外部使用
    public final void save(String data) {
        validate(data);
        doSave(data);
        afterSave(data);
    }

    // protected：給子類別實作的擴充點（這是設計的一部分）
    protected abstract void doSave(String data);

    // protected 且有預設實作：子類別可選擇性覆寫（hook）
    protected void afterSave(String data) { }

    // private：純內部細節，隨時可改
    private void validate(String data) {
        if (data == null || data.isBlank()) {
            throw new IllegalArgumentException("資料不可為空");
        }
    }
}
```

> **設計建議**：預設用 `private`。只有在「明確要讓子類別擴充」時才用 `protected`，並在 Javadoc 說明契約。
> 把欄位設成 `protected`（像 3.2 節的 `Employee`）在教學上方便，但實務上通常改成 `private` + `protected` getter，
> 避免子類別直接改父類別的狀態。

### `abstract`

```java
// abstract 類別：不能被 new，可以有實作也可以有抽象方法
public abstract class Shape {
    public abstract double area();          // 抽象方法：沒有本體，子類別必須實作

    public String describe() {              // 具體方法：子類別直接繼承
        return "%s 面積 %.2f".formatted(getClass().getSimpleName(), area());
    }
}
```

```java
// Shape s = new Shape();      // ❌ 抽象類別不能實例化

public class Circle extends Shape {
    private final double radius;
    public Circle(double radius) { this.radius = radius; }
    @Override public double area() { return Math.PI * radius * radius; }
}
```

規則：

- 有抽象方法的類別**必須**宣告 `abstract`。
- `abstract` 類別可以**沒有**抽象方法（單純不想讓人 new）。
- 子類別若沒有實作全部抽象方法，它自己也必須是 `abstract`。

---

## 3.8 抽象類別與模板方法模式

**模板方法（Template Method）**：父類別定義流程骨架，子類別填入變化的步驟。
這是實務上抽象類別最有價值的用法。

### 實務案例：批次匯入報表

```java
import java.util.List;

public abstract class AbstractImportJob {

    /**
     * 模板方法：流程固定，宣告 final 讓子類別不能改動順序。
     * 每一個匯入任務都是：讀取 → 驗證 → 轉換 → 寫入 → 通知。
     */
    public final ImportResult run(String source) {
        long start = System.currentTimeMillis();
        log("開始匯入: " + source);

        List<String[]> rows = read(source);                  // ← 抽象：各格式不同
        log("讀取 " + rows.size() + " 列");

        int success = 0;
        int failed = 0;
        for (String[] row : rows) {
            try {
                validate(row);                               // ← 抽象：各任務規則不同
                Object entity = convert(row);                // ← 抽象：各任務目標不同
                persist(entity);                             // ← 抽象：寫到哪裡
                success++;
            } catch (RuntimeException e) {
                failed++;
                onRowError(row, e);                          // ← hook：預設記 log，可覆寫
            }
        }

        long elapsed = System.currentTimeMillis() - start;
        ImportResult result = new ImportResult(success, failed, elapsed);
        afterFinish(result);                                  // ← hook
        log("完成: " + result);
        return result;
    }

    // ===== 子類別必須實作 =====
    protected abstract List<String[]> read(String source);
    protected abstract void validate(String[] row);
    protected abstract Object convert(String[] row);
    protected abstract void persist(Object entity);

    // ===== 子類別可選擇覆寫（hook）=====
    protected void onRowError(String[] row, RuntimeException e) {
        log("列匯入失敗: " + String.join(",", row) + " → " + e.getMessage());
    }

    protected void afterFinish(ImportResult result) { }

    // ===== 共用工具 =====
    protected void log(String message) {
        System.out.println("[" + getClass().getSimpleName() + "] " + message);
    }

    /** 匯入結果 */
    public static final class ImportResult {
        private final int success;
        private final int failed;
        private final long elapsedMillis;

        public ImportResult(int success, int failed, long elapsedMillis) {
            this.success = success;
            this.failed = failed;
            this.elapsedMillis = elapsedMillis;
        }

        public int getSuccess() { return success; }
        public int getFailed() { return failed; }
        public long getElapsedMillis() { return elapsedMillis; }

        @Override
        public String toString() {
            return "成功 %d 筆，失敗 %d 筆，耗時 %d ms".formatted(success, failed, elapsedMillis);
        }
    }
}
```

具體實作：

```java
import java.util.ArrayList;
import java.util.List;

public class ProductCsvImportJob extends AbstractImportJob {

    private final List<String> savedProducts = new ArrayList<>();

    @Override
    protected List<String[]> read(String source) {
        // 實務上這裡會讀檔（第 07 章）。這裡用內建資料示範流程。
        List<String[]> rows = new ArrayList<>();
        for (String line : source.split("\n")) {
            if (line.isBlank()) continue;
            rows.add(line.split(","));
        }
        return rows;
    }

    @Override
    protected void validate(String[] row) {
        if (row.length != 3) {
            throw new IllegalArgumentException("欄位數應為 3，實際 " + row.length);
        }
        if (row[0].isBlank()) {
            throw new IllegalArgumentException("商品編號不可為空");
        }
        try {
            long price = Long.parseLong(row[2].strip());
            if (price <= 0) {
                throw new IllegalArgumentException("價格必須大於 0: " + price);
            }
        } catch (NumberFormatException e) {
            throw new IllegalArgumentException("價格格式錯誤: " + row[2]);
        }
    }

    @Override
    protected Object convert(String[] row) {
        return "%s|%s|%s".formatted(row[0].strip(), row[1].strip(), row[2].strip());
    }

    @Override
    protected void persist(Object entity) {
        savedProducts.add((String) entity);      // 實務上是 repository.save(entity)
    }

    @Override
    protected void afterFinish(ImportResult result) {
        if (result.getFailed() > 0) {
            log("⚠️ 有 " + result.getFailed() + " 筆失敗，請檢查來源檔案");
        }
    }

    public List<String> getSavedProducts() { return List.copyOf(savedProducts); }

    public static void main(String[] args) {
        String csv = """
                P001,鍵盤,2990
                P002,滑鼠,890
                ,無編號商品,100
                P004,螢幕,abc
                P005,耳機,1590
                """;

        ProductCsvImportJob job = new ProductCsvImportJob();
        ImportResult result = job.run(csv);

        System.out.println("實際寫入: " + job.getSavedProducts());
    }
}
```

輸出：

```
[ProductCsvImportJob] 開始匯入: P001,鍵盤,2990...
[ProductCsvImportJob] 讀取 5 列
[ProductCsvImportJob] 列匯入失敗: ,無編號商品,100 → 商品編號不可為空
[ProductCsvImportJob] 列匯入失敗: P004,螢幕,abc → 價格格式錯誤: abc
[ProductCsvImportJob] ⚠️ 有 2 筆失敗，請檢查來源檔案
[ProductCsvImportJob] 完成: 成功 3 筆，失敗 2 筆，耗時 3 ms
實際寫入: [P001|鍵盤|2990, P002|滑鼠|890, P005|耳機|1590]
```

**模板方法帶來什麼：**

- 「一筆失敗不中斷整批」、「計時」、「統計成功失敗」這些**橫切邏輯只寫一次**。
- 新增一種匯入（訂單、會員、庫存）只要實作 4 個方法。
- 流程順序被 `final` 鎖住，不會有人在某個子類別裡偷改順序。

> Spring 裡到處是這個模式：`JdbcTemplate`、`RestTemplate`、`AbstractApplicationContext`。
> 名字裡有 `Template` 的類別，八成就是這個模式。

---

## 3.9 介面

介面定義**能力（能做什麼）**，不關心怎麼做。

```java
public interface Notifier {
    /** 發送通知；失敗時應丟出 RuntimeException */
    void send(String recipient, String subject, String body);
}
```

```java
public class EmailNotifier implements Notifier {
    @Override
    public void send(String recipient, String subject, String body) {
        System.out.printf("[Email] to=%s subject=%s%n", recipient, subject);
    }
}

public class SlackNotifier implements Notifier {
    private final String webhookUrl;

    public SlackNotifier(String webhookUrl) { this.webhookUrl = webhookUrl; }

    @Override
    public void send(String recipient, String subject, String body) {
        System.out.printf("[Slack] channel=%s text=%s: %s%n", recipient, subject, body);
    }
}
```

### 介面成員的默認修飾子

```java
public interface Constants {
    int MAX_RETRY = 3;              // 隱含 public static final
    void doWork();                   // 隱含 public abstract
}
```

**介面中不能有實例欄位**（只能有 `static final` 常數）。這是它和抽象類別最大的差別之一。

### 【Java 8+】`default` 方法

```java
public interface Notifier {

    void send(String recipient, String subject, String body);

    /** default 方法：提供預設實作，實作類別可以不覆寫 */
    default void sendUrgent(String recipient, String body) {
        send(recipient, "🔴 [緊急] 請立即處理", body);
    }

    /** 批次發送，預設逐一呼叫；能批次的實作可以覆寫成真正的批次 API */
    default void sendBatch(java.util.List<String> recipients, String subject, String body) {
        for (String r : recipients) {
            send(r, subject, body);
        }
    }

    /** static 方法：工具方法，放在介面上比另開一個 Utils 類別更內聚 */
    static Notifier noop() {
        return (recipient, subject, body) -> { };      // 什麼都不做，測試時很有用
    }
}
```

**`default` 存在的理由**：讓介面能**新增方法而不破壞既有實作**。

Java 8 要在 `Collection` 加 `stream()`，如果沒有 `default`，全世界所有實作 `Collection` 的類別
都會在升級後編譯失敗。這就是 `default` 被加入語言的原因。

### 【Java 9+】`private` 方法

```java
public interface OrderValidator {

    void validate(Order order);

    default void validateAll(java.util.List<Order> orders) {
        for (Order o : orders) {
            requireNonNull(o);          // 呼叫 private 方法
            validate(o);
        }
    }

    default void validateFirst(java.util.List<Order> orders) {
        if (orders.isEmpty()) return;
        Order first = orders.get(0);
        requireNonNull(first);          // 重用同一段邏輯
        validate(first);
    }

    /** private：只給介面內的 default 方法共用，不暴露給實作類別 */
    private void requireNonNull(Order order) {
        if (order == null) {
            throw new IllegalArgumentException("訂單不可為 null");
        }
    }
}
```

### 多重繼承衝突（菱形問題）

```java
public class DiamondProblem {

    interface Walkable {
        default String move() { return "走路"; }
    }

    interface Swimmable {
        default String move() { return "游泳"; }
    }

    // ❌ 兩個介面都有 move()，編譯器不知道用哪個
    // static class Duck implements Walkable, Swimmable { }

    // ✅ 必須明確覆寫，並用 介面名.super.方法() 指定
    static class Duck implements Walkable, Swimmable {
        @Override
        public String move() {
            return Walkable.super.move() + " 或 " + Swimmable.super.move();
        }
    }

    public static void main(String[] args) {
        System.out.println(new Duck().move());     // 走路 或 游泳
    }
}
```

**衝突解析的優先順序**（記住第一條就好）：

1. **類別 > 介面**：父類別的具體方法勝過介面的 `default`。
2. **子介面 > 父介面**：更具體的介面勝出。
3. 都不能決定 → **編譯錯誤，必須自己覆寫**。

> Java 不會有 C++ 那種菱形繼承的資料重複問題，因為介面**沒有實例欄位**——衝突只可能發生在方法上，
> 且編譯器強制你解決。

---

## 3.10 抽象類別 vs 介面：怎麼選

| | 抽象類別 | 介面 |
|---|---|---|
| 實例欄位 | ✅ 可以有 | ❌ 只能有 `static final` 常數 |
| 建構子 | ✅ 有 | ❌ 沒有 |
| 方法實作 | ✅ 具體方法 + 抽象方法 | ✅ `default` / `static`（但無狀態） |
| 存取修飾子 | 任意（`private` / `protected` / `public`） | 只有 `public`（加 `private` 給 default 共用） |
| 多重繼承 | ❌ 只能 extends 一個 | ✅ 可以 implements 多個 |
| 語意 | **是什麼**（is-a），共用狀態與流程 | **能做什麼**（can-do），能力契約 |

### 決策流程

```
需要抽象一組行為
   │
   ├─ 需要共用「狀態（欄位）」或「建構子驗證」？
   │     是 → 抽象類別
   │
   ├─ 需要固定流程、只讓子類別填空？（模板方法）
   │     是 → 抽象類別
   │
   ├─ 實作者可能已經繼承了別的類別？
   │     是 → 介面（Java 單一繼承）
   │
   ├─ 只是定義「能力」，實作可能天差地遠？
   │     是 → 介面
   │
   └─ 都符合 → 介面優先，需要時再加一個 abstract 基底類別
```

### 實務上最常見的組合：介面 + 抽象基底類別

JDK 自己就是這樣設計的：

```
Collection（介面）           ← 定義契約，所有集合都能用
  ↑
AbstractCollection（抽象類別） ← 提供樣板實作，減少重複
  ↑
ArrayList / LinkedList        ← 具體實作
```

```java
import java.util.List;

public class InterfacePlusAbstract {

    /** ① 介面：對外的契約。使用者只依賴這個 */
    interface Cache {
        String get(String key);
        void put(String key, String value);

        default String getOrDefault(String key, String defaultValue) {
            String v = get(key);
            return v != null ? v : defaultValue;
        }
    }

    /** ② 抽象基底：提供共用的統計與 log，減少實作類別的重複 */
    static abstract class AbstractCache implements Cache {
        private long hits = 0;
        private long misses = 0;

        @Override
        public final String get(String key) {
            if (key == null || key.isBlank()) {
                throw new IllegalArgumentException("key 不可為空");
            }
            String value = doGet(key);
            if (value == null) misses++; else hits++;
            return value;
        }

        protected abstract String doGet(String key);

        public String stats() {
            long total = hits + misses;
            double rate = total == 0 ? 0 : (double) hits / total * 100;
            return "命中 %d / %d (%.1f%%)".formatted(hits, total, rate);
        }
    }

    /** ③ 具體實作：只要實作 doGet 和 put */
    static class MemoryCache extends AbstractCache {
        private final java.util.Map<String, String> map = new java.util.HashMap<>();

        @Override protected String doGet(String key) { return map.get(key); }
        @Override public void put(String key, String value) { map.put(key, value); }
    }

    public static void main(String[] args) {
        MemoryCache cache = new MemoryCache();
        cache.put("a", "1");

        System.out.println(cache.get("a"));                    // 1
        System.out.println(cache.get("b"));                    // null
        System.out.println(cache.getOrDefault("b", "default")); // default（default 方法）
        System.out.println(cache.stats());                      // 命中 1 / 3 (33.3%)

        // 使用者只需要知道 Cache 介面
        Cache c = cache;
        System.out.println(c.getOrDefault("a", "x"));           // 1
    }
}
```

**為什麼不直接用抽象類別？** 因為使用者宣告成 `Cache` 型別後，將來可以換成 Redis 實作
（它可能繼承了某個 Redis 客戶端基底類別，用不了你的 `AbstractCache`）。
**介面留下了替換的自由，抽象類別提供了不寫重複碼的便利。**

---

## 3.11 組合優於繼承

**這是本章實務價值最高的一節。**

### 繼承被誤用的樣子

```java
// ❌ 為了「複用程式碼」而繼承
public class BaseService {
    protected void log(String msg) { System.out.println("[LOG] " + msg); }
    protected String formatDate(java.time.LocalDate d) { return d.toString(); }
    protected boolean isValidEmail(String s) { return s != null && s.contains("@"); }
}

public class OrderService extends BaseService { }        // 只是想用 log()
public class ProductService extends BaseService { }
public class UserService extends BaseService { }
```

**問題：**

1. `OrderService` **不是**一種 `BaseService`（is-a 關係不成立）。
2. `extends` 的名額被浪費了——之後想繼承別的類別就沒辦法。
3. `BaseService` 越長越大（人人都往裡面加工具方法），變成上帝類別。
4. 改 `BaseService` 的任何方法，會影響所有子類別，而你不知道誰在用。
5. `protected` 成員全部暴露給子類別，封裝被破壞。

**修法：需要 log 就注入 logger，需要工具方法就用 static 工具類別。**

```java
public class OrderService {
    private static final java.util.logging.Logger log =
            java.util.logging.Logger.getLogger(OrderService.class.getName());
    // 實務上用 SLF4J：private static final Logger log = LoggerFactory.getLogger(OrderService.class);
}
```

### 判斷法：is-a 還是 has-a

```java
// ✅ is-a：SalesEmployee 是一種 Employee → 繼承合理
class SalesEmployee extends Employee { }

// ❌ 這不是 is-a：訂單「不是」一種清單
class Order extends ArrayList<OrderItem> { }

// ✅ has-a：訂單「有」一組項目 → 組合
class Order {
    private final List<OrderItem> items = new ArrayList<>();
}
```

`class Order extends ArrayList<OrderItem>` 為什麼糟？因為 `Order` 就繼承了 `clear()`、`removeAll()`、
`sort()`、`set(int, OrderItem)` 等 30 幾個方法——任何人都能繞過你的業務規則直接改動訂單項目。
**繼承會把父類別的整個 API 暴露出去，這是它最大的成本。**

### 實務案例：折扣規則——從繼承地獄到策略模式

需求演進的真實過程：

```java
// 第一版：兩種折扣，用繼承還算能看
class Discount { BigDecimal apply(BigDecimal amount) { return amount; } }
class PercentDiscount extends Discount { }        // 打折
class FixedDiscount extends Discount { }          // 折抵固定金額
```

```java
// 第二版：老闆說「會員打折 + 折價券可以同時用」
// ❌ 用繼承你要開 PercentAndFixedDiscount…
// 第三版：再加「滿額折扣」、「首購折扣」、「限時折扣」
// ❌ 組合爆炸：2^5 = 32 個類別
```

**用組合重寫：**

```java
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.util.ArrayList;
import java.util.List;

/** 折扣規則（策略介面） */
interface DiscountRule {
    /** 回傳「折抵金額」，不是折後價 */
    BigDecimal discountFor(BigDecimal subtotal);

    String description();
}

/** 百分比折扣 */
class PercentOffRule implements DiscountRule {
    private final BigDecimal percent;       // 例如 20 代表打八折

    PercentOffRule(String percent) {
        this.percent = new BigDecimal(percent);
    }

    @Override
    public BigDecimal discountFor(BigDecimal subtotal) {
        return subtotal.multiply(percent).divide(new BigDecimal("100"), 2, RoundingMode.HALF_UP);
    }

    @Override
    public String description() { return percent + "% 折扣"; }
}

/** 滿額折抵固定金額 */
class ThresholdCouponRule implements DiscountRule {
    private final BigDecimal threshold;
    private final BigDecimal amount;

    ThresholdCouponRule(String threshold, String amount) {
        this.threshold = new BigDecimal(threshold);
        this.amount = new BigDecimal(amount);
    }

    @Override
    public BigDecimal discountFor(BigDecimal subtotal) {
        return subtotal.compareTo(threshold) >= 0 ? amount : BigDecimal.ZERO;
    }

    @Override
    public String description() { return "滿 " + threshold + " 折 " + amount; }
}

/** 首購折扣 */
class FirstPurchaseRule implements DiscountRule {
    private final boolean isFirstPurchase;
    private final BigDecimal amount;

    FirstPurchaseRule(boolean isFirstPurchase, String amount) {
        this.isFirstPurchase = isFirstPurchase;
        this.amount = new BigDecimal(amount);
    }

    @Override
    public BigDecimal discountFor(BigDecimal subtotal) {
        return isFirstPurchase ? amount.min(subtotal) : BigDecimal.ZERO;
    }

    @Override
    public String description() { return "首購折 " + amount; }
}

/** 折扣計算器：用「組合」持有多個規則，而不是繼承 */
class DiscountCalculator {

    private final List<DiscountRule> rules = new ArrayList<>();

    public DiscountCalculator add(DiscountRule rule) {
        rules.add(rule);
        return this;
    }

    public Result calculate(BigDecimal subtotal) {
        BigDecimal total = BigDecimal.ZERO;
        List<String> applied = new ArrayList<>();

        for (DiscountRule rule : rules) {
            BigDecimal d = rule.discountFor(subtotal);
            if (d.compareTo(BigDecimal.ZERO) > 0) {
                total = total.add(d);
                applied.add("%s (-%s)".formatted(rule.description(), d));
            }
        }

        // 折抵不可超過小計
        if (total.compareTo(subtotal) > 0) {
            total = subtotal;
        }

        BigDecimal payable = subtotal.subtract(total).setScale(2, RoundingMode.HALF_UP);
        return new Result(subtotal, total.setScale(2, RoundingMode.HALF_UP), payable, applied);
    }

    record Result(BigDecimal subtotal, BigDecimal discount,
                  BigDecimal payable, List<String> appliedRules) {
        @Override
        public String toString() {
            return "小計 %s，折抵 %s，應付 %s%n  套用: %s"
                    .formatted(subtotal, discount, payable, appliedRules);
        }
    }
}

public class DiscountDemo {
    public static void main(String[] args) {
        BigDecimal subtotal = new BigDecimal("1200");

        // 金卡會員 + 首購 + 滿千折百，三個規則自由組合
        DiscountCalculator gold = new DiscountCalculator()
                .add(new PercentOffRule("20"))
                .add(new ThresholdCouponRule("1000", "100"))
                .add(new FirstPurchaseRule(true, "50"));
        System.out.println(gold.calculate(subtotal));

        // 一般會員只有滿千折百
        DiscountCalculator normal = new DiscountCalculator()
                .add(new ThresholdCouponRule("1000", "100"));
        System.out.println(normal.calculate(subtotal));

        // 沒有任何規則
        System.out.println(new DiscountCalculator().calculate(subtotal));
    }
}
```

輸出：

```
小計 1200，折抵 390.00，應付 810.00
  套用: [20% 折扣 (-240.00), 滿 1000 折 100 (-100), 首購折 50 (-50)]
小計 1200，折抵 100.00，應付 1100.00
  套用: [滿 1000 折 100 (-100)]
小計 1200，折抵 0.00，應付 1200.00
  套用: []
```

**組合帶來什麼：**

| | 繼承版 | 組合版 |
|---|---|---|
| 新增一種折扣 | 可能要開多個組合類別 | 加一個 `implements DiscountRule` |
| 執行時改變規則 | ❌ 繼承在編譯期固定 | ✅ 從資料庫讀規則設定，動態組出來 |
| 測試 | 要測所有組合類別 | 每個規則獨立測，計算器另外測 |
| 類別數量 | 2^n | n + 1 |

> **這就是策略模式（Strategy Pattern）**，也是 Spring 中最常見的設計：
> 定義一個介面 → 多個 `@Component` 實作 → Spring 把它們全部注入成 `List<DiscountRule>`。
> 你會在第 05 站看到這個寫法。

### 一句話總結

> **繼承是「白盒複用」**——你看得到父類別內部，也被它綁住。改父類別會影響所有子類別。
> **組合是「黑盒複用」**——只透過介面互動，可以在執行時替換。
>
> **預設用組合。只有在真的是 is-a 關係、且你控制整個繼承體系時，才用繼承。**

---

## 3.12 里氏替換原則與型別判斷

### 里氏替換原則（LSP）

> **任何使用父型別的地方，都應該可以換成子型別而不出錯。**

違反的經典例子：

```java
public class LspViolation {

    static class Rectangle {
        protected int width, height;

        public void setWidth(int w) { this.width = w; }
        public void setHeight(int h) { this.height = h; }
        public int area() { return width * height; }
    }

    /** ❌ 正方形「數學上」是矩形，但作為子類別違反了 LSP */
    static class Square extends Rectangle {
        @Override public void setWidth(int w) { this.width = w; this.height = w; }
        @Override public void setHeight(int h) { this.width = h; this.height = h; }
    }

    /** 這個方法對 Rectangle 是正確的 */
    static void resizeAndCheck(Rectangle r) {
        r.setWidth(5);
        r.setHeight(4);
        System.out.println("預期面積 20，實際 " + r.area());
    }

    public static void main(String[] args) {
        resizeAndCheck(new Rectangle());     // 預期面積 20，實際 20
        resizeAndCheck(new Square());        // 預期面積 20，實際 16  💥
    }
}
```

**修法**：不要讓 `Square extends Rectangle`。用一個共同介面 `Shape { int area(); }`，
兩者各自實作，且都設計成不可變（沒有 setter，就沒有這個問題）。

**實務上違反 LSP 的常見形式：**

```java
// ❌ 子類別把父類別的方法「關掉」
class ReadOnlyList<E> extends ArrayList<E> {
    @Override
    public boolean add(E e) {
        throw new UnsupportedOperationException();     // 呼叫者拿到 List 型別，不會預期這個
    }
}

// ❌ 子類別加上父類別沒有的前置條件
class PositiveCounter extends Counter {
    @Override
    public void increment(int n) {
        if (n <= 0) throw new IllegalArgumentException();    // 父類別允許負數
        super.increment(n);
    }
}
```

檢查方式：**子類別不該加強前置條件，也不該弱化後置條件。**

### `instanceof` 與模式比對

```java
public class PatternMatching {

    sealed interface Shape permits Circle, Rectangle, Triangle { }
    record Circle(double radius) implements Shape { }
    record Rectangle(double width, double height) implements Shape { }
    record Triangle(double base, double height) implements Shape { }

    // ❌ Java 16 之前：檢查 + 轉型 + 賦值，三步
    static double areaOld(Object shape) {
        if (shape instanceof Circle) {
            Circle c = (Circle) shape;
            return Math.PI * c.radius() * c.radius();
        } else if (shape instanceof Rectangle) {
            Rectangle r = (Rectangle) shape;
            return r.width() * r.height();
        }
        return 0;
    }

    // ✅ Java 16+：instanceof 模式比對，檢查與綁定一步完成
    static double areaBetter(Shape shape) {
        if (shape instanceof Circle c) {
            return Math.PI * c.radius() * c.radius();
        } else if (shape instanceof Rectangle r) {
            return r.width() * r.height();
        } else if (shape instanceof Triangle t) {
            return t.base() * t.height() / 2;
        }
        throw new IllegalArgumentException("未知形狀: " + shape);
    }

    // ✅✅ Java 21：switch 模式比對 + sealed → 編譯器檢查完整性，不需要 default
    static double areaBest(Shape shape) {
        return switch (shape) {
            case Circle c    -> Math.PI * c.radius() * c.radius();
            case Rectangle r -> r.width() * r.height();
            case Triangle t  -> t.base() * t.height() / 2;
        };
    }

    public static void main(String[] args) {
        java.util.List<Shape> shapes = java.util.List.of(
                new Circle(2), new Rectangle(3, 4), new Triangle(6, 5));

        for (Shape s : shapes) {
            System.out.printf("%-30s 面積 %.2f%n", s, areaBest(s));
        }
        // Circle[radius=2.0]                   面積 12.57
        // Rectangle[width=3.0, height=4.0]     面積 12.00
        // Triangle[base=6.0, height=5.0]       面積 15.00
    }
}
```

> ⚠️ **注意**：上面 `areaBest` 是「用型別判斷代替多型」，這在**資料導向**的設計裡是合理的
> （`Shape` 是純資料，面積計算屬於外部的幾何邏輯）。
>
> 但如果每個子型別都有自己的行為（像 3.4 節的付款處理器），**用多型，不要用 switch**。
> 判斷方式：新增一個子型別時，你需要改幾個地方？多型是 0 個，switch 是每一個 switch 都要改。

---

## 3.13 對介面編程：通往依賴注入

### 具體類別依賴的問題

```java
// ❌ OrderService 死綁 MySqlOrderRepository 和 EmailNotifier
public class OrderService {

    private final MySqlOrderRepository repository = new MySqlOrderRepository();
    private final EmailNotifier notifier = new EmailNotifier();

    public void placeOrder(String userId, long amountCents) {
        String orderId = repository.insert(userId, amountCents);
        notifier.send(userId, "訂單成立", "訂單 " + orderId);
    }
}
```

問題：

1. **無法測試**：測 `placeOrder` 會真的連 MySQL、真的寄信。
2. **無法替換**：想改用 PostgreSQL 或改寄 Slack，必須改 `OrderService` 的原始碼。
3. **無法組態**：正式環境寄信、開發環境不寄，做不到。

### 對介面編程 + 建構子注入

```java
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;

/** ① 定義契約 */
interface OrderRepository {
    String insert(String userId, long amountCents);
    long countByUser(String userId);
}

interface Notifier {
    void send(String recipient, String subject, String body);
}

/** ② Service 只依賴介面 */
class OrderService {

    private final OrderRepository repository;
    private final Notifier notifier;

    // 依賴從外部傳入 = 依賴注入（Dependency Injection）
    public OrderService(OrderRepository repository, Notifier notifier) {
        this.repository = Objects.requireNonNull(repository, "repository 不可為 null");
        this.notifier = Objects.requireNonNull(notifier, "notifier 不可為 null");
    }

    public String placeOrder(String userId, long amountCents) {
        if (amountCents <= 0) {
            throw new IllegalArgumentException("金額必須大於 0: " + amountCents);
        }
        String orderId = repository.insert(userId, amountCents);
        long count = repository.countByUser(userId);
        notifier.send(userId, "訂單成立",
                "訂單 %s 已成立，這是您的第 %d 筆訂單".formatted(orderId, count));
        return orderId;
    }
}

/** ③ 正式環境的實作 */
class JdbcOrderRepository implements OrderRepository {
    @Override
    public String insert(String userId, long amountCents) {
        // 實務上這裡執行 INSERT（第 06 站）
        return "ORD-" + System.nanoTime();
    }

    @Override
    public long countByUser(String userId) {
        return 42;      // 實務上是 SELECT COUNT(*)
    }
}

class EmailNotifier implements Notifier {
    @Override
    public void send(String recipient, String subject, String body) {
        System.out.printf("[Email] to=%s subject=%s body=%s%n", recipient, subject, body);
    }
}

/** ④ 測試用的假實作（stub / fake），完全不碰外部系統 */
class InMemoryOrderRepository implements OrderRepository {
    private final Map<String, Long> countByUser = new HashMap<>();
    private int seq = 0;

    @Override
    public String insert(String userId, long amountCents) {
        countByUser.merge(userId, 1L, Long::sum);
        return "TEST-ORD-" + (++seq);
    }

    @Override
    public long countByUser(String userId) {
        return countByUser.getOrDefault(userId, 0L);
    }
}

class RecordingNotifier implements Notifier {
    private final List<String> sent = new java.util.ArrayList<>();

    @Override
    public void send(String recipient, String subject, String body) {
        sent.add("%s|%s|%s".formatted(recipient, subject, body));
    }

    public List<String> getSent() { return List.copyOf(sent); }
}

public class DiDemo {
    public static void main(String[] args) {

        // 正式環境的組裝
        OrderService prod = new OrderService(new JdbcOrderRepository(), new EmailNotifier());
        System.out.println("正式: " + prod.placeOrder("u001", 29900));

        // 測試環境的組裝：同一個 OrderService，完全不同的依賴
        RecordingNotifier notifier = new RecordingNotifier();
        OrderService test = new OrderService(new InMemoryOrderRepository(), notifier);

        String id = test.placeOrder("u001", 100);
        System.out.println("測試: " + id);
        System.out.println("驗證通知內容: " + notifier.getSent());
        // 驗證通知內容: [u001|訂單成立|訂單 TEST-ORD-1 已成立，這是您的第 1 筆訂單]

        // 現在可以斷言了：沒有連資料庫、沒有寄信，而且能驗證行為
    }
}
```

**這段程式碼就是 Spring 的核心價值。** Spring 做的事情是：

```java
// 你寫的（第 02 站會看到）
@Service
public class OrderService {
    private final OrderRepository repository;
    private final Notifier notifier;

    public OrderService(OrderRepository repository, Notifier notifier) {
        this.repository = repository;
        this.notifier = notifier;
    }
}

// Spring 在啟動時自動做的（相當於上面的手動組裝）
// new OrderService(jdbcOrderRepositoryBean, emailNotifierBean)
```

Spring 沒有發明新概念，它只是把「組裝物件圖」這件事自動化。**你現在已經懂原理了。**

### 為什麼多型也解釋了 `@Transactional` 的坑

Spring 的 `@Transactional`、`@Cacheable`、`@Async` 都是靠**動態代理**實作的：
Spring 建立一個「代理物件」，它繼承（或實作）你的類別，在方法前後插入交易/快取邏輯，
然後把代理物件注入給別人用。

```
呼叫者 → [Spring 代理物件] → 開啟交易 → [你的 OrderService] → 提交交易
```

這解釋了三個經典問題：

```java
@Service
public class OrderService {

    // ❌ private 方法：代理無法覆寫 private 方法 → @Transactional 完全沒作用
    @Transactional
    private void saveInternal(Order o) { }

    // ❌ final 方法／final 類別：CGLIB 代理靠繼承，final 無法覆寫 → 沒作用
    @Transactional
    public final void save(Order o) { }

    // ❌ 自我呼叫（self-invocation）：this.save() 不經過代理 → 沒作用
    public void process(Order o) {
        this.save(o);          // 直接呼叫自己，繞過了代理
    }

    @Transactional
    public void save(Order o) { }
}
```

> 三個問題的根源都是**多型與代理的機制**，而不是「Spring 有 bug」。
> 第 02 站（AOP）與第 05 站（交易傳播）會完整處理，但你現在就知道原因了。

---

## 3.14 `sealed`：受控的繼承（預告）

Java 17 起可以精確控制「誰可以繼承我」：

```java
public class SealedPreview {

    /** 只允許這三個型別實作，其他人不行 */
    sealed interface PaymentResult permits Success, Failed, Pending { }

    record Success(String transactionId, java.math.BigDecimal amount) implements PaymentResult { }
    record Failed(String errorCode, String message) implements PaymentResult { }
    record Pending(String transactionId, int retryAfterSeconds) implements PaymentResult { }

    static String describe(PaymentResult result) {
        // 因為 sealed 限定了所有可能，switch 不需要 default，
        // 且新增一個 permits 型別時這裡會編譯失敗（強迫你處理）
        return switch (result) {
            case Success s -> "成功，交易號 %s，金額 %s".formatted(s.transactionId(), s.amount());
            case Failed f  -> "失敗 [%s] %s".formatted(f.errorCode(), f.message());
            case Pending p -> "處理中，%d 秒後重試".formatted(p.retryAfterSeconds());
        };
    }

    public static void main(String[] args) {
        java.util.List<PaymentResult> results = java.util.List.of(
                new Success("TX-001", new java.math.BigDecimal("1000")),
                new Failed("INSUFFICIENT_FUNDS", "餘額不足"),
                new Pending("TX-003", 30));

        results.forEach(r -> System.out.println(describe(r)));
    }
}
```

輸出：

```
成功，交易號 TX-001，金額 1000
失敗 [INSUFFICIENT_FUNDS] 餘額不足
處理中，30 秒後重試
```

**`sealed` 的價值**：一般介面是「開放的」——任何人都能實作，所以 `switch` 永遠需要 `default`。
`sealed` 讓編譯器知道所有可能，於是能做**完整性檢查**（就像第 01 章的 enum + switch）。

第 12 章會完整講，這裡先讓你知道：**回傳「成功或多種失敗」的場合，`sealed` 比丟例外更能表達意圖**。

---

## 3.15 練習專案：Todo CLI 加上介面

第 02 章的 `TodoList` 把「資料管理」和「儲存」混在一起。現在抽出介面。

```
demo/src/main/java/com/example/todo/
├── model/
│   ├── Priority.java          （第 02 章，不變）
│   └── Todo.java              （第 02 章，不變）
├── repository/
│   ├── TodoRepository.java    ← 新增：介面
│   └── InMemoryTodoRepository.java  ← 新增：實作
├── service/
│   ├── Notifier.java          ← 新增：介面
│   ├── ConsoleNotifier.java   ← 新增
│   ├── CompositeNotifier.java ← 新增：組合模式
│   └── TodoService.java       ← 新增：商業邏輯
└── App.java
```

### `TodoRepository.java`

```java
package com.example.todo.repository;

import com.example.todo.model.Todo;

import java.util.List;
import java.util.Optional;

public interface TodoRepository {

    /** 儲存（新增或更新），回傳儲存後的物件 */
    Todo save(Todo todo);

    Optional<Todo> findById(long id);

    List<Todo> findAll();

    boolean deleteById(long id);

    /** 產生下一個可用的 id */
    long nextId();

    // ===== default 方法：所有實作都能用的便利方法 =====

    default Todo getById(long id) {
        return findById(id).orElseThrow(
                () -> new IllegalArgumentException("找不到待辦 #" + id));
    }

    default long count() {
        return findAll().size();
    }

    default boolean exists(long id) {
        return findById(id).isPresent();
    }
}
```

### `InMemoryTodoRepository.java`

```java
package com.example.todo.repository;

import com.example.todo.model.Todo;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;

public class InMemoryTodoRepository implements TodoRepository {

    // LinkedHashMap 保留插入順序，findAll() 的結果才穩定
    private final Map<Long, Todo> storage = new LinkedHashMap<>();
    private long sequence = 0;

    @Override
    public Todo save(Todo todo) {
        Objects.requireNonNull(todo, "todo 不可為 null");
        storage.put(todo.id(), todo);
        return todo;
    }

    @Override
    public Optional<Todo> findById(long id) {
        return Optional.ofNullable(storage.get(id));
    }

    @Override
    public List<Todo> findAll() {
        return List.copyOf(storage.values());       // 唯讀拷貝，外部改不到內部
    }

    @Override
    public boolean deleteById(long id) {
        return storage.remove(id) != null;
    }

    @Override
    public long nextId() {
        return ++sequence;
    }
}
```

> **注意 `findById` 用 `Map` 而不是 for 迴圈**——第 02 章的 `TodoList.findById` 是 O(n)，
> 這裡是 O(1)。第 05 章會講為什麼、以及 `HashMap` vs `LinkedHashMap` 的差別。

### `Notifier.java` / `ConsoleNotifier.java` / `CompositeNotifier.java`

```java
package com.example.todo.service;

import com.example.todo.model.Todo;

/**
 * 事件通知。實作可以是 console、email、webhook…
 *
 * ⚠️ 注意它收的是「發生了什麼事」（`notifyCreated`／`notifyDone`），
 *    而不是一個已經拼好的字串。**訊息長怎樣是通知管道自己的事** ——
 *    email 要 HTML、Slack 要 markdown、簡訊只能純文字。
 *    介面若收 `String`，這個決定就被鎖死在呼叫端了。
 */
public interface Notifier {

    void notifyCreated(Todo todo);

    void notifyDone(Todo todo);

    /** 什麼都不做的實作，測試或關閉通知時用 */
    static Notifier noop() {
        return new Notifier() {
            @Override public void notifyCreated(Todo todo) { }
            @Override public void notifyDone(Todo todo) { }
        };
    }
}
```

> ⚠️ **這裡有一個取捨**：介面從一個方法變成兩個，就**不再是函式介面**，
> `Notifier.noop()` 沒辦法再寫成 lambda（`message -> { }`），只能用匿名類別。
> 換來的是「新增一種事件時，編譯器會叫所有實作補上」。
> 本章練習 2 的裝飾器則刻意保留單方法版本 —— 兩種設計各有適用場合。

```java
package com.example.todo.service;

import com.example.todo.model.Todo;

import java.time.LocalTime;
import java.time.format.DateTimeFormatter;

public class ConsoleNotifier implements Notifier {

    private static final DateTimeFormatter TIME = DateTimeFormatter.ofPattern("HH:mm:ss");

    @Override
    public void notifyCreated(Todo todo) {
        print("新增待辦 #" + todo.id() + "：" + todo.title());
    }

    @Override
    public void notifyDone(Todo todo) {
        print("完成待辦 #" + todo.id() + "：" + todo.title());
    }

    private void print(String message) {
        System.out.println("🔔 [" + LocalTime.now().format(TIME) + "] " + message);
    }
}
```

```java
package com.example.todo.service;

import com.example.todo.model.Todo;

import java.util.List;
import java.util.Objects;
import java.util.function.Consumer;

/**
 * 組合模式：一個 Notifier 內含多個 Notifier。
 * 對呼叫者而言它就是一個 Notifier，不用知道背後有幾個通道。
 */
public class CompositeNotifier implements Notifier {

    private final List<Notifier> delegates;

    public CompositeNotifier(List<Notifier> delegates) {
        this.delegates = List.copyOf(Objects.requireNonNull(delegates, "delegates 不可為 null"));
    }

    @Override
    public void notifyCreated(Todo todo) {
        fanOut(n -> n.notifyCreated(todo));
    }

    @Override
    public void notifyDone(Todo todo) {
        fanOut(n -> n.notifyDone(todo));
    }

    /** 兩個方法唯一的差別只有「呼叫哪一個」，所以把它當參數傳進來（第 06 章 6.6 節） */
    private void fanOut(Consumer<Notifier> action) {
        for (Notifier delegate : delegates) {
            try {
                action.accept(delegate);
            } catch (RuntimeException e) {
                // 一個通道失敗不該讓其他通道也收不到
                System.err.println("通知失敗 (" + delegate.getClass().getSimpleName()
                        + "): " + e.getMessage());
            }
        }
    }
}
```

### `TodoService.java`

```java
package com.example.todo.service;

import com.example.todo.model.Priority;
import com.example.todo.model.Todo;
import com.example.todo.repository.TodoRepository;

import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.List;
import java.util.Objects;

public class TodoService {

    private final TodoRepository repository;
    private final Notifier notifier;

    // 建構子注入：只依賴介面，不知道也不在乎背後是記憶體、檔案還是資料庫
    public TodoService(TodoRepository repository, Notifier notifier) {
        this.repository = Objects.requireNonNull(repository, "repository 不可為 null");
        this.notifier = Objects.requireNonNull(notifier, "notifier 不可為 null");
    }

    public Todo add(String title, Priority priority) {
        Todo todo = new Todo(repository.nextId(), title, priority, LocalDateTime.now());
        repository.save(todo);
        notifier.notifyCreated(todo);
        return todo;
    }

    public Todo markDone(long id) {
        Todo todo = repository.getById(id);
        todo.markDone(LocalDateTime.now());
        repository.save(todo);
        notifier.notifyDone(todo);
        return todo;
    }

    public boolean remove(long id) {
        return repository.deleteById(id);
    }

    public List<Todo> findPending() {
        List<Todo> result = new ArrayList<>();
        for (Todo todo : repository.findAll()) {
            if (!todo.isDone()) result.add(todo);
        }
        return result;
    }

    public List<Todo> findAll() {
        return repository.findAll();
    }

    public double completionRate() {
        List<Todo> all = repository.findAll();
        if (all.isEmpty()) return 0.0;
        long done = all.size() - findPending().size();
        return (double) done / all.size() * 100;
    }
}
```

### `App.java`

```java
package com.example.todo;

import com.example.todo.model.Priority;
import com.example.todo.model.Todo;
import com.example.todo.repository.InMemoryTodoRepository;
import com.example.todo.repository.TodoRepository;
import com.example.todo.service.CompositeNotifier;
import com.example.todo.service.ConsoleNotifier;
import com.example.todo.service.Notifier;
import com.example.todo.service.TodoService;

import java.util.List;

public class App {

    public static void main(String[] args) {

        // ===== 組裝階段：所有「用哪個實作」的決定都在這裡 =====
        TodoRepository repository = new InMemoryTodoRepository();
        Notifier notifier = new CompositeNotifier(List.of(
                new ConsoleNotifier(),
                new Notifier() {                          // 稽核用的第二個通道
                    @Override public void notifyCreated(Todo t) { audit("新增", t); }
                    @Override public void notifyDone(Todo t) { audit("完成", t); }
                    private void audit(String what, Todo t) {
                        System.out.println("📝 [Audit] " + what + "待辦 #" + t.id() + "：" + t.title());
                    }
                }
        ));
        TodoService service = new TodoService(repository, notifier);

        // ===== 使用階段：只透過 service，不知道背後是誰 =====
        service.add("寫第 03 章", Priority.HIGH);
        service.add("Code review", Priority.MEDIUM);
        Todo coffee = service.add("買咖啡", Priority.LOW);

        service.markDone(coffee.id());

        System.out.println("\n=== 未完成 ===");
        for (Todo todo : service.findPending()) {
            System.out.println(todo.toDisplayLine());
        }
        System.out.printf("完成率 %.1f%%%n", service.completionRate());

        // ===== 換掉通知實作，其他程式碼完全不用改 =====
        System.out.println("\n=== 靜音模式 ===");
        TodoService quiet = new TodoService(new InMemoryTodoRepository(), Notifier.noop());
        quiet.add("這次不會有通知", Priority.MEDIUM);
        System.out.println("已新增，共 " + quiet.findAll().size() + " 筆（沒有任何通知輸出）");
    }
}
```

輸出：

```
🔔 [10:30:15] 新增待辦 #1：寫第 03 章
📝 [Audit] 新增待辦 #1：寫第 03 章
🔔 [10:30:15] 新增待辦 #2：Code review
📝 [Audit] 新增待辦 #2：Code review
🔔 [10:30:15] 新增待辦 #3：買咖啡
📝 [Audit] 新增待辦 #3：買咖啡
🔔 [10:30:15] 完成待辦 #3：買咖啡
📝 [Audit] 完成待辦 #3：買咖啡

=== 未完成 ===
[ ] #1   [高] 寫第 03 章
[ ] #2   [中] Code review
完成率 33.3%

=== 靜音模式 ===
已新增，共 1 筆（沒有任何通知輸出）
```

### 這一版得到了什麼

| | 第 02 章版本 | 現在 |
|---|---|---|
| 換儲存方式（檔案 / DB） | 改 `TodoList` 內部 | 新增一個 `implements TodoRepository`（第 07 章會做） |
| 換通知方式 | 沒有通知功能 | 換一個 `Notifier`，`TodoService` 不動 |
| 測試 | 只能整包跑 | 傳入假的 repository 與 notifier（第 11 章） |
| 「用哪個實作」的決定 | 散在各處 | 集中在 `App` 的組裝區塊 |

> 那個「組裝階段」的區塊，就是 Spring 的 `ApplicationContext` 在做的事。
> 第 02 站你會把它換成 `@Service` + `@Repository` + 建構子注入，然後這段手動組裝碼就消失了。

---

## 3.16 常見錯誤

### 錯誤 1：忘記加 `@Override`

```java
// ❌ 參數型別打錯就變成重載，靜默失效
public boolean equals(Point other) { }

// ✅ 加了 @Override 編譯期就抓到
@Override public boolean equals(Object o) { }
```

### 錯誤 2：為了複用程式碼而繼承

```java
// ❌
class OrderService extends BaseUtilService { }

// ✅ 用組合或 static 工具類別
class OrderService {
    private final DateFormatter formatter;
}
```

### 錯誤 3：在建構子裡呼叫可覆寫的方法

```java
// ❌ 子類別欄位還沒初始化
public Parent() { init(); }

// ✅ 透過 super(...) 傳值，或提供明確的初始化方法
public Parent(Config config) { this.config = config; }
```

### 錯誤 4：子類別宣告與父類別同名的欄位

```java
// ❌ 這是隱藏，不是覆寫，會有兩個 name 欄位
class Child extends Parent { String name = "Child"; }

// ✅ 用可覆寫的方法提供不同值
class Child extends Parent { @Override String getName() { return "Child"; } }
```

### 錯誤 5：繼承 `ArrayList` / `HashMap` 來做業務物件

```java
// ❌ 把 30 幾個集合方法都暴露出去
class Cart extends ArrayList<CartItem> { }

// ✅ 組合，只暴露你想暴露的
class Cart {
    private final List<CartItem> items = new ArrayList<>();
    public void add(CartItem item) { /* 可以加業務規則 */ }
    public List<CartItem> items() { return List.copyOf(items); }
}
```

### 錯誤 6：介面裡塞太多方法

```java
// ❌ 違反介面隔離原則（ISP）：實作者被迫實作用不到的方法
interface UserService {
    void register(); void login(); void logout(); void resetPassword();
    void exportToExcel(); void sendNewsletter(); void generateReport();
}

// ✅ 拆成小介面，各自組合
interface UserAuthentication { void login(); void logout(); }
interface UserRegistration { void register(); void resetPassword(); }
interface UserReporting { void exportToExcel(); void generateReport(); }
```

### 錯誤 7：用大量 `instanceof` + 轉型代替多型

```java
// ❌ 每加一個型別，所有這種 if 都要改
if (shape instanceof Circle) { ... }
else if (shape instanceof Square) { ... }

// ✅ 行為放在型別上
shape.area();

// 例外：資料導向的處理（純資料 + 外部演算法），用 sealed + switch 反而更好
```

---

## 3.17 本章練習

### 練習 1：判斷該用繼承、組合，還是介面

| 需求 | 你的選擇 |
|---|---|
| ① `AdminUser` 有 `User` 的全部行為，加上 `banUser()` | ? |
| ② `Order` 需要「一組 `OrderItem`」 | ? |
| ③ 系統要支援多種檔案匯出：CSV、Excel、PDF | ? |
| ④ `ProductService` 想用 `OrderService` 裡寫好的 `formatCurrency()` | ? |
| ⑤ 十種報表都是「查資料 → 轉格式 → 輸出 → 記錄」，只有中間步驟不同 | ? |
| ⑥ 快取實作可能是記憶體、Redis、或兩層 | ? |

<details>
<summary>參考解答</summary>

| 需求 | 選擇 | 理由 |
|---|---|---|
| ① `AdminUser` | **繼承**（或改用組合 + 角色欄位） | is-a 成立。但實務上更常見的是 `User` 有 `Set<Role> roles`，因為「管理員」是狀態而非型別——使用者可能同時是管理員與一般會員，也可能被降權。用繼承的話，一個 `User` 物件無法在執行時「變成」`AdminUser`。 |
| ② `Order` / `OrderItem` | **組合** | has-a。絕對不要 `Order extends ArrayList<OrderItem>` |
| ③ 多種匯出 | **介面** `Exporter` | 純能力契約，實作差異大。若有共用的「開檔 → 寫入 → 關檔」流程，再加一個 `AbstractExporter` |
| ④ 共用 `formatCurrency()` | **都不要**——抽成 static 工具方法或注入 formatter | 為了共用一個方法而繼承是典型誤用。這是 3.11 節的 `BaseService` 反模式 |
| ⑤ 十種報表 | **抽象類別 + 模板方法** | 流程固定、步驟變化，正是 Template Method 的定義 |
| ⑥ 快取 | **介面 + 組合** | `Cache` 介面；兩層快取用**裝飾器**：`TwoLevelCache implements Cache` 內含 `Cache local` 和 `Cache remote`。這也是 3.10 節 `CompositeNotifier` 的同一手法 |

</details>

### 練習 2：實作通知系統（含裝飾器）

在 3.15 節的 `Notifier` 基礎上，實作：

1. `EmailNotifier`、`SmsNotifier`
2. `RetryNotifier`：包裝任一個 `Notifier`，失敗時重試 N 次
3. `RateLimitedNotifier`：包裝任一個 `Notifier`，每分鐘最多發 N 次

要能任意組合，例如「有速率限制的、會重試的 Email 通知」。

<details>
<summary>參考解答</summary>

```java
import java.util.ArrayDeque;
import java.util.Deque;
import java.util.Objects;

interface Notifier {
    void notify(String message);

    static Notifier noop() {
        return message -> { };
    }
}

class EmailNotifier implements Notifier {
    private final String address;
    private int failCount;          // 為了示範重試，前兩次故意失敗

    EmailNotifier(String address) { this.address = address; }

    @Override
    public void notify(String message) {
        if (++failCount <= 2) {
            throw new RuntimeException("SMTP 連線逾時（第 " + failCount + " 次）");
        }
        System.out.println("[Email→" + address + "] " + message);
    }
}

class SmsNotifier implements Notifier {
    private final String phone;

    SmsNotifier(String phone) { this.phone = phone; }

    @Override
    public void notify(String message) {
        // 簡訊有長度限制，超過就截斷
        String text = message.length() > 70 ? message.substring(0, 67) + "..." : message;
        System.out.println("[SMS→" + phone + "] " + text);
    }
}

/** 裝飾器：加上重試，不改變 Notifier 的契約 */
class RetryNotifier implements Notifier {

    private final Notifier delegate;
    private final int maxAttempts;
    private final long backoffMillis;

    RetryNotifier(Notifier delegate, int maxAttempts, long backoffMillis) {
        this.delegate = Objects.requireNonNull(delegate, "delegate 不可為 null");
        if (maxAttempts < 1) {
            throw new IllegalArgumentException("maxAttempts 必須 >= 1，收到: " + maxAttempts);
        }
        this.maxAttempts = maxAttempts;
        this.backoffMillis = backoffMillis;
    }

    @Override
    public void notify(String message) {
        RuntimeException last = null;
        for (int attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                delegate.notify(message);
                if (attempt > 1) {
                    System.out.println("   ↳ 第 " + attempt + " 次嘗試成功");
                }
                return;
            } catch (RuntimeException e) {
                last = e;
                System.out.println("   ↳ 第 " + attempt + " 次失敗: " + e.getMessage());
                if (attempt < maxAttempts) {
                    sleep(backoffMillis * attempt);      // 線性退避
                }
            }
        }
        throw new RuntimeException(
                "通知失敗，已重試 %d 次".formatted(maxAttempts), last);
    }

    private void sleep(long millis) {
        try {
            Thread.sleep(millis);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();          // 一定要恢復中斷旗標（第 08 章）
            throw new RuntimeException("重試等待被中斷", e);
        }
    }
}

/** 裝飾器：加上速率限制（滑動視窗） */
class RateLimitedNotifier implements Notifier {

    private final Notifier delegate;
    private final int maxPerWindow;
    private final long windowMillis;
    private final Deque<Long> timestamps = new ArrayDeque<>();

    RateLimitedNotifier(Notifier delegate, int maxPerWindow, long windowMillis) {
        this.delegate = Objects.requireNonNull(delegate, "delegate 不可為 null");
        this.maxPerWindow = maxPerWindow;
        this.windowMillis = windowMillis;
    }

    @Override
    public void notify(String message) {
        long now = System.currentTimeMillis();

        // 清掉視窗外的紀錄
        while (!timestamps.isEmpty() && now - timestamps.peekFirst() > windowMillis) {
            timestamps.pollFirst();
        }

        if (timestamps.size() >= maxPerWindow) {
            System.out.println("⏸ 已達速率上限（" + maxPerWindow + "/" + windowMillis
                    + "ms），丟棄訊息: " + message);
            return;
        }

        timestamps.addLast(now);
        delegate.notify(message);
    }
}

public class NotifierComposition {
    public static void main(String[] args) {

        // 組合：速率限制 → 重試 → Email
        // 讀法由外而內：先過速率限制，通過後才進重試，重試裡面才真的寄信
        Notifier notifier = new RateLimitedNotifier(
                new RetryNotifier(new EmailNotifier("ops@example.com"), 3, 50),
                2, 60_000);

        System.out.println("--- 第 1 則（前兩次會失敗，第三次成功）---");
        notifier.notify("訂單 ORD-001 付款失敗");

        System.out.println("--- 第 2 則 ---");
        notifier.notify("訂單 ORD-002 付款失敗");

        System.out.println("--- 第 3 則（超過速率限制）---");
        notifier.notify("訂單 ORD-003 付款失敗");

        System.out.println("\n--- 換成 SMS，同樣的裝飾器 ---");
        Notifier sms = new RetryNotifier(new SmsNotifier("0912345678"), 2, 10);
        sms.notify("您的訂單已出貨，物流單號 1234567890，預計明日送達，如有問題請洽客服專線");
    }
}
```

輸出：

```
--- 第 1 則（前兩次會失敗，第三次成功）---
   ↳ 第 1 次失敗: SMTP 連線逾時（第 1 次）
   ↳ 第 2 次失敗: SMTP 連線逾時（第 2 次）
[Email→ops@example.com] 訂單 ORD-001 付款失敗
   ↳ 第 3 次嘗試成功
--- 第 2 則 ---
[Email→ops@example.com] 訂單 ORD-002 付款失敗
--- 第 3 則（超過速率限制）---
⏸ 已達速率上限（2/60000ms），丟棄訊息: 訂單 ORD-003 付款失敗

--- 換成 SMS，同樣的裝飾器 ---
[SMS→0912345678] 您的訂單已出貨，物流單號 1234567890，預計明日送達，如有問題請洽客...
```

**這題的設計重點：**

1. **裝飾器模式**：`RetryNotifier` 和 `RateLimitedNotifier` 都是 `Notifier`，也都**持有**一個 `Notifier`。
   因為型別相同，可以無限層層包裝。
2. 用繼承做不到這件事——你沒辦法在執行時決定「要不要加重試」。
3. 每個裝飾器只負責一件事（單一職責），可以獨立測試。
4. 注意 `Thread.currentThread().interrupt()`——捕捉 `InterruptedException` 後必須恢復中斷旗標，
   否則上層的執行緒池無法正確關閉。第 08 章會詳細講。

> **實務對照**：Resilience4j、Spring Retry 就是這個模式的成熟版本，
> 提供重試、熔斷、限流、降級的裝飾器。第 05 站會用到。

</details>

### 練習 3：修正 LSP 違反

```java
class FileStorage {
    public void save(String path, byte[] content) { /* 寫檔 */ }
    public byte[] load(String path) { /* 讀檔 */ return new byte[0]; }
    public void delete(String path) { /* 刪檔 */ }
}

class ReadOnlyS3Storage extends FileStorage {
    @Override
    public void save(String path, byte[] content) {
        throw new UnsupportedOperationException("S3 儲存桶為唯讀");
    }

    @Override
    public void delete(String path) {
        throw new UnsupportedOperationException("S3 儲存桶為唯讀");
    }
}
```

指出問題並改正。

<details>
<summary>參考解答</summary>

**問題**：`ReadOnlyS3Storage` 違反 LSP。任何寫成這樣的程式碼都會爆炸：

```java
void backup(FileStorage storage, byte[] data) {
    storage.save("/backup/" + System.currentTimeMillis(), data);   // 傳 S3 進來就 💥
}
```

呼叫者拿到 `FileStorage` 型別，理應可以 `save`。用 `UnsupportedOperationException`「關掉」父類別的方法，
等於在型別系統上說謊——編譯器過了，執行時炸。

**修正：把「能力」拆成獨立介面（介面隔離原則）**

```java
import java.util.HashMap;
import java.util.Map;
import java.util.Objects;

/** 讀取能力 */
interface ReadableStorage {
    byte[] load(String path);
    boolean exists(String path);
}

/** 寫入能力 */
interface WritableStorage {
    void save(String path, byte[] content);
    void delete(String path);
}

/** 需要兩種能力時，用一個組合介面表達 */
interface Storage extends ReadableStorage, WritableStorage { }

/** 本機檔案：兩種能力都有 */
class LocalFileStorage implements Storage {
    private final Map<String, byte[]> files = new HashMap<>();

    @Override public void save(String path, byte[] content) {
        files.put(path, content.clone());       // 防禦性拷貝
    }
    @Override public byte[] load(String path) {
        byte[] c = files.get(path);
        if (c == null) throw new IllegalArgumentException("檔案不存在: " + path);
        return c.clone();
    }
    @Override public void delete(String path) { files.remove(path); }
    @Override public boolean exists(String path) { return files.containsKey(path); }
}

/** 唯讀 S3：型別上就只宣告 ReadableStorage，不承諾寫入 */
class ReadOnlyS3Storage implements ReadableStorage {
    private final String bucket;

    ReadOnlyS3Storage(String bucket) { this.bucket = Objects.requireNonNull(bucket); }

    @Override public byte[] load(String path) {
        return ("s3://" + bucket + path).getBytes();
    }
    @Override public boolean exists(String path) { return true; }
}

public class StorageFixed {

    /** 只需要讀 → 宣告最小需求，S3 和本機都能傳進來 */
    static void printSize(ReadableStorage storage, String path) {
        System.out.println(path + " 大小 " + storage.load(path).length + " bytes");
    }

    /** 需要寫 → 型別就要求 WritableStorage，S3 在「編譯期」就傳不進來 */
    static void backup(WritableStorage storage, String path, byte[] data) {
        storage.save(path, data);
        System.out.println("已備份到 " + path);
    }

    public static void main(String[] args) {
        LocalFileStorage local = new LocalFileStorage();
        ReadOnlyS3Storage s3 = new ReadOnlyS3Storage("my-bucket");

        backup(local, "/backup/a.txt", "hello".getBytes());
        printSize(local, "/backup/a.txt");
        printSize(s3, "/public/logo.png");

        // backup(s3, "/x", new byte[0]);
        // ❌ 編譯錯誤：ReadOnlyS3Storage 不是 WritableStorage
        // 這正是我們要的——錯誤在編譯期就被抓到，不是上線後才丟例外
    }
}
```

**核心觀念**：

> 「不支援某個操作」不該用**執行期例外**表達，該用**型別**表達。
> 讓編譯器擋掉，而不是讓使用者在正式環境踩到。

順帶一提，JDK 自己就違反了這條——`List.of()` 回傳的不可變 List 呼叫 `add()` 會丟
`UnsupportedOperationException`。這是為了向後相容而做的妥協，**不是值得模仿的設計**。

</details>

### 練習 4：預測輸出

```java
public class Quiz {

    static class A {
        String name = "A";
        String who() { return "A"; }
        void print() { System.out.println(name + "/" + who()); }
    }

    static class B extends A {
        String name = "B";
        @Override String who() { return "B"; }
    }

    public static void main(String[] args) {
        A a = new B();
        System.out.println(a.name);
        System.out.println(a.who());
        a.print();

        B b = new B();
        System.out.println(b.name);
        System.out.println(((A) b).name);
        b.print();
    }
}
```

<details>
<summary>參考解答</summary>

```
A
B
A/B
B
A
A/B
```

**逐行推導：**

| 行 | 輸出 | 為什麼 |
|---|---|---|
| `a.name` | `A` | **欄位是靜態綁定**——看宣告型別 `A`（3.5 節） |
| `a.who()` | `B` | **方法是動態綁定**——看實際物件 `B` |
| `a.print()` | `A/B` | `print()` 定義在 `A` 裡，其中的 `name` 在編譯 `A` 時就綁到 `A.name`；`who()` 動態分派到 `B` |
| `b.name` | `B` | 宣告型別是 `B` |
| `((A) b).name` | `A` | 轉型改變了**宣告型別**，同一個物件裡 `A.name` 和 `B.name` 兩個欄位都存在 |
| `b.print()` | `A/B` | 同第 3 行，`print()` 的程式碼在 `A` 裡，看到的是 `A.name` |

**最重要的一行是 `a.print()`**：即使物件是 `B`，`A.print()` 裡的 `name` 永遠是 `A.name`。
這就是為什麼 3.5 節說「不要在子類別宣告同名欄位」——你會得到兩個欄位，而且哪個生效取決於程式碼寫在哪個類別裡。

</details>

### 練習 5：設計可擴充的通知路由

需求：不同事件類型走不同通知通道。

```
訂單成立   → Email
付款失敗   → Email + SMS
系統異常   → Slack + SMS（且要重試）
一般公告   → Email（可靜音）
```

要能在**不改既有程式碼**的前提下新增事件類型。

<details>
<summary>參考解答</summary>

```java
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;

// ===== 3.15 節的 Notifier，原樣搬來 =====
interface Notifier {
    void notify(String message);

    static Notifier noop() {
        return message -> { };
    }
}

class EmailNotifier implements Notifier {
    @Override public void notify(String m) { System.out.println("  [Email] " + m); }
}

class SmsNotifier implements Notifier {
    @Override public void notify(String m) { System.out.println("  [SMS] " + m); }
}

class SlackNotifier implements Notifier {
    @Override public void notify(String m) { System.out.println("  [Slack] " + m); }
}

/** 組合模式：一個 Notifier 內含多個（3.15 節 CompositeNotifier，原樣搬來） */
class CompositeNotifier implements Notifier {
    private final List<Notifier> delegates;

    CompositeNotifier(List<Notifier> delegates) {
        this.delegates = List.copyOf(Objects.requireNonNull(delegates));
    }

    @Override
    public void notify(String message) {
        for (Notifier d : delegates) {
            try {
                d.notify(message);
            } catch (RuntimeException e) {
                System.err.println("  通知失敗 (" + d.getClass().getSimpleName()
                        + "): " + e.getMessage());
            }
        }
    }
}

/** 裝飾器：重試（練習 2 的簡化版） */
class RetryNotifier implements Notifier {
    private final Notifier delegate;
    private final int maxAttempts;

    RetryNotifier(Notifier delegate, int maxAttempts) {
        this.delegate = Objects.requireNonNull(delegate);
        this.maxAttempts = maxAttempts;
    }

    @Override
    public void notify(String message) {
        RuntimeException last = null;
        for (int i = 1; i <= maxAttempts; i++) {
            try {
                delegate.notify(message);
                return;
            } catch (RuntimeException e) {
                last = e;
                System.out.println("  第 " + i + " 次失敗，重試中");
            }
        }
        throw new RuntimeException("重試 " + maxAttempts + " 次仍失敗", last);
    }
}

// ===== 本題的核心：事件與路由 =====

/** 事件類型：用 enum 而不是字串，避免拼錯 */
enum EventType {
    ORDER_CREATED("訂單成立"),
    PAYMENT_FAILED("付款失敗"),
    SYSTEM_ERROR("系統異常"),
    ANNOUNCEMENT("一般公告");

    private final String label;

    EventType(String label) { this.label = label; }

    public String getLabel() { return label; }
}

/**
 * 通知路由：把「事件類型 → 通知通道」的對應集中管理。
 * 新增事件類型時只要 register 一次，其他程式碼完全不用改。
 */
class NotificationRouter {

    private final Map<EventType, Notifier> routes = new HashMap<>();
    private final Notifier fallback;

    NotificationRouter(Notifier fallback) {
        this.fallback = Objects.requireNonNull(fallback, "fallback 不可為 null");
    }

    public NotificationRouter register(EventType type, Notifier notifier) {
        routes.put(type, Objects.requireNonNull(notifier, "notifier 不可為 null"));
        return this;
    }

    public void publish(EventType type, String message) {
        System.out.println("▶ " + type.getLabel() + ": " + message);
        // 沒註冊的事件走 fallback，不會靜默消失
        routes.getOrDefault(type, fallback).notify("[" + type.getLabel() + "] " + message);
    }
}

public class NotificationRoutingDemo {
    public static void main(String[] args) {

        Notifier email = new EmailNotifier();
        Notifier sms = new SmsNotifier();
        Notifier slack = new SlackNotifier();

        NotificationRouter router = new NotificationRouter(email)     // 未註冊的預設走 Email
                .register(EventType.ORDER_CREATED, email)
                .register(EventType.PAYMENT_FAILED, new CompositeNotifier(List.of(email, sms)))
                .register(EventType.SYSTEM_ERROR,
                        new RetryNotifier(new CompositeNotifier(List.of(slack, sms)), 3))
                .register(EventType.ANNOUNCEMENT, Notifier.noop());  // 先靜音

        router.publish(EventType.ORDER_CREATED, "訂單 ORD-001 已成立");
        router.publish(EventType.PAYMENT_FAILED, "訂單 ORD-002 信用卡授權失敗");
        router.publish(EventType.SYSTEM_ERROR, "資料庫連線池耗盡");
        router.publish(EventType.ANNOUNCEMENT, "系統將於今晚維護");
    }
}
```

輸出：

```
▶ 訂單成立: 訂單 ORD-001 已成立
  [Email] [訂單成立] 訂單 ORD-001 已成立
▶ 付款失敗: 訂單 ORD-002 信用卡授權失敗
  [Email] [付款失敗] 訂單 ORD-002 信用卡授權失敗
  [SMS] [付款失敗] 訂單 ORD-002 信用卡授權失敗
▶ 系統異常: 資料庫連線池耗盡
  [Slack] [系統異常] 資料庫連線池耗盡
  [SMS] [系統異常] 資料庫連線池耗盡
▶ 一般公告: 系統將於今晚維護
```

**設計解析：**

1. **`Notifier` 這一個介面就撐起了整個系統**——單一通道、組合、裝飾器全部是同一個型別，
   所以能自由嵌套（`Retry(Composite(Slack, SMS))`）。
2. **路由表用 `Map<EventType, Notifier>`**：新增事件類型 = 加一個 enum 常數 + 一行 `register`。
   `publish` 方法永遠不用改，符合開放封閉原則。
3. **`fallback` 很重要**：忘記註冊的事件不會靜默消失，這種「通知沒發出去也沒人知道」的問題極難查。
4. **靜音用 `Notifier.noop()`**，不是在 `publish` 裡寫 `if (type == ANNOUNCEMENT) return;`。
   規則寫在組態，不寫在流程裡。

> **實務對照**：Spring 的 `ApplicationEventPublisher` + `@EventListener` 就是這個模式的框架版，
> 註冊表由 Spring 自動維護。你現在懂它在做什麼了。

</details>

---

## 3.18 驗收清單

- [ ] 我能說出 `super(...)` 必須在第一行，以及父類別沒有無參數建構子時的後果。
- [ ] 我能說出方法覆寫的四條規則（簽章、回傳型別、存取權、例外）。
- [ ] 我一律加 `@Override`，也知道漏加時 `equals` 會怎麼失效。
- [ ] 我能解釋多型如何讓「新增實作不用改既有程式碼」。
- [ ] 我知道**欄位是靜態綁定、方法是動態綁定**，也不會在子類別宣告同名欄位。
- [ ] 我知道繼承下的初始化順序，也知道建構子裡不能呼叫可覆寫的方法。
- [ ] 我能用抽象類別寫出模板方法，並知道流程方法要宣告 `final`。
- [ ] 我知道介面的 `default` 方法為什麼存在，以及菱形衝突要怎麼解。
- [ ] 我能在抽象類別與介面之間做出有理由的選擇。
- [ ] 我理解「組合優於繼承」，並能用策略模式取代組合爆炸。
- [ ] 我知道里氏替換原則，也知道「不支援的操作該用型別表達，不是丟例外」。
- [ ] 我能解釋「對介面編程 + 建構子注入」如何讓程式可測試，以及它和 Spring DI 的關係。
- [ ] 我知道 Spring 的代理為什麼對 `private`、`final`、自我呼叫無效。

---

完成後請前往 [04-exception-handling.md](./04-exception-handling.md)。
