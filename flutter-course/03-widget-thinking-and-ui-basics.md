# 第 03 章：Widget 思維與 UI 基礎

> 這一章是整門課的「分水嶺」。Widget 是 Flutter 的靈魂，但很多人學一輩子都停在「會抄不會懂」。
> 我們要解開三個核心謎題：**為什麼一切皆 Widget？Flutter 重建這麼多次畫面為什麼不卡？setState 到底動了什麼？**
> 把這章的「三棵樹」心智模型建立起來，後面所有效能優化、`key`、生命週期的問題都會迎刃而解。

---

## 3.1 重新理解「Widget 是什麼」

新手最大的誤會：**以為 Widget 就是畫面上那個東西**。錯。

**Widget 其實是「畫面的設定說明書」，不是畫面本身。**

```dart
const Text('Hello', style: TextStyle(fontSize: 20))
```

這行 `Text` 不是螢幕上那串字，它只是一份**輕量、不可變的設定**：「我要一段文字，內容 Hello，大小 20」。真正去畫像素的是別的東西（後面講的 RenderObject）。

**心智模型**：Widget 像「裝潢設計圖」，RenderObject 像「蓋好的房子」。設計圖很便宜，可以隨手撕掉重畫；房子很貴，能不重蓋就不重蓋。Flutter 之所以能「一直重建 Widget 卻不卡」，秘密就在這個分工——**重建的是便宜的設計圖，不是重蓋昂貴的房子**。

這也解釋了一個你早晚會問的問題：「Flutter 每次 setState 都重新 build 整棵 Widget 樹，不會很慢嗎？」答案：**不會，因為 build 出來的 Widget 只是設定物件，建立它們極便宜；真正貴的繪製，Flutter 會聰明地只更新有變的部分。** 下面就講它怎麼做到的。

---

## 3.2 三棵樹：Flutter 高效更新的真正秘密

這是本章最重要的概念。Flutter 內部其實維護**三棵樹**，不是一棵：

```text
   Widget Tree            Element Tree              RenderObject Tree
  （設定說明書）          （中間人/管理員）            （真正畫畫的）
   便宜、常被丟棄重建        穩定、長期存活               昂貴、盡量重用

   Text("Hi")     ←→     TextElement      ←→        RenderParagraph
   會一直重建              記住對應關係                 真正去排版+畫字
```

逐層解釋：

1. **Widget Tree（設定）**：你 `build` 出來的東西。**便宜、不可變、隨時被整棵丟棄重建。**
2. **Element Tree（中間人）**：每個 Widget 對應一個 Element。**它是穩定存活的**，負責「拿著新的 Widget 設定，去更新對應的 RenderObject」。它是三棵樹的協調者。
3. **RenderObject Tree（實體）**：真正做「測量大小、排版、畫像素、處理觸控」的物件。**建立/銷毀它很貴**，所以 Flutter 盡量重用。

**更新流程（重點來了）**：當你 `setState`，Flutter 重新 `build` 出**新的 Widget 樹**，然後：

```text
Element 拿「新 Widget」跟「自己記得的舊 Widget」比對：
  ├─ 型別、key 都一樣？→ 不重建！只把新設定「更新」到現有 RenderObject（便宜）
  └─ 型別不一樣？      → 才丟棄舊的、建立新的 Element + RenderObject（貴）
```

**白話翻譯**：你每次 `build` 都產生一份全新的「設計圖」，但 Element 這個「監工」很聰明——它拿新圖跟舊圖比，發現「啊這面牆只是換個顏色」，就直接叫油漆工改色（更新 RenderObject），而不是把牆打掉重蓋。**只有當結構真的變了（例如 `Text` 變成 `Image`），才會真的拆掉重建。**

這就是為什麼 Flutter「一直重建 Widget」卻依然流暢：**重建的是便宜的設定，比對後只有真正變動的部分才會碰到昂貴的繪製層。**

> 你現在不需要直接操作 Element 或 RenderObject，99% 的時間只寫 Widget。但**懂了這三棵樹，你才會理解後面 `key` 為什麼重要、`const` 為什麼省效能、為什麼「重建很多次」不是問題。**

---

## 3.3 StatelessWidget：不會變的畫面

```dart
class Greeting extends StatelessWidget {
  final String name;                       // 從外面傳進來的資料

  const Greeting({super.key, required this.name});

  @override
  Widget build(BuildContext context) {
    return Text('Hello, $name');
  }
}
```

逐段解釋：

- **`StatelessWidget`**：「無狀態」——它的長相**完全由外面傳進來的參數（這裡是 `name`）決定**，自己內部沒有會變的資料。
- **`final String name;`**：注意是 `final`。StatelessWidget 的所有欄位都該是 `final`（不可變）。它要變？那就由父層傳新的值、重建一個新的 Greeting。
- **什麼時候用它**：純展示、長相只依賴傳入參數的元件。例如一個「顯示使用者名字的標籤」「一個 logo」。**能用 Stateless 就用 Stateless**，它更單純、好推理。

---

## 3.4 StatefulWidget：會變的畫面，與「為什麼要拆兩個類別」

```dart
class Counter extends StatefulWidget {
  const Counter({super.key});

  @override
  State<Counter> createState() => _CounterState();   // 建立它的「狀態保管箱」
}

class _CounterState extends State<Counter> {
  int _count = 0;                                     // 狀態：會變的資料

  void _increment() {
    setState(() => _count++);                         // 改狀態 + 通知重建
  }

  @override
  Widget build(BuildContext context) {
    return TextButton(
      onPressed: _increment,
      child: Text('count: $_count'),
    );
  }
}
```

**最關鍵的問題：為什麼 StatefulWidget 要拆成「Widget 類別」+「State 類別」兩個？**

回到 3.2 的三棵樹：**Widget 是便宜、會被一直丟棄重建的**。如果狀態（`_count`）存在 Widget 裡，那每次重建 Widget，`_count` 就歸零了——狀態根本留不住。

所以 Flutter 把狀態搬到 **State 物件**裡，而 State 物件是**掛在「長壽的」Element 上的**。於是：

```text
Widget（Counter）        → 一直被丟棄重建，但它很便宜，沒差
State（_CounterState）   → 掛在 Element 上，活很久，_count 安穩地待著
```

**心智模型**：Widget 是「這一幀的設定」，會一直換；State 是「跨越很多幀、需要被記住的記憶」，存放在穩定的 Element 上。**這就是 Flutter 把它們拆開的根本原因。**

`setState` 在這裡做的事：① 跑你給的函式改 `_count` ② 標記這個 State「髒了」，Flutter 下一幀就重新呼叫它的 `build`，產生新 Widget，走 3.2 的比對更新流程。

---

## 3.5 State 的生命週期（initState / dispose 一定要會）

State 物件有「出生到死亡」的生命週期。最常用的兩個：

```dart
class _VideoPageState extends State<VideoPage> {
  late final VideoController _controller;

  @override
  void initState() {
    super.initState();                  // ⭐ 一定要先呼叫 super
    _controller = VideoController();     // 只在「出生時」做一次的初始化
    _controller.load();
  }

  @override
  void dispose() {
    _controller.dispose();               // ⭐ 釋放資源，避免記憶體洩漏
    super.dispose();                     // super 放最後
  }

  @override
  Widget build(BuildContext context) {
    return VideoView(controller: _controller);
  }
}
```

逐段解釋這幾個生命週期方法：

- **`initState()`**：State **誕生時呼叫一次**。適合放「只做一次」的初始化：建立 controller、訂閱 stream、開啟 API 請求。**注意：這裡還不能用 `context` 拿主題/路由等（畫面還沒掛好）**，要用的話放到 `didChangeDependencies`。記得呼叫 `super.initState()`。
- **`build()`**：每次需要繪製就呼叫，**可能跑很多次**，所以**千萬別在 build 裡做「建立 controller、發 API」這種有副作用的事**（會重複執行、效能災難）。build 只負責「依目前狀態描述畫面」。
- **`dispose()`**：State **死亡前呼叫一次**。**極其重要**：你在 `initState` 開的東西（controller、stream 訂閱、計時器），要在這裡關掉。**不關就會記憶體洩漏**——這是 Flutter 常見的隱形 bug。

**心智模型**：`initState` 開場佈置、`dispose` 散場收拾。凡是「會佔資源、會持續跑」的東西（controller / timer / stream / listener），**開了就一定要在 dispose 關**，像呼吸一樣自然。

（還有 `didChangeDependencies`、`didUpdateWidget` 等，初學先掌握 `initState` / `build` / `dispose` 三個，其餘用到再學。）

---

## 3.6 BuildContext 是什麼？

`build(BuildContext context)` 裡那個 `context`，新手常忽略它，但它很重要。

**`BuildContext` ≈ 「這個 Widget 在 Element 樹裡的位置（它的座標）」。** 透過它，Widget 可以「往上找」拿到祖先提供的東西：

```dart
@override
Widget build(BuildContext context) {
  final theme = Theme.of(context);          // 往上找最近的主題設定
  final media = MediaQuery.of(context);     // 往上找螢幕尺寸資訊

  return Container(
    width: media.size.width / 2,             // 用螢幕寬度的一半
    color: theme.primaryColor,               // 用主題色
  );
}
```

逐段解釋：

- **`Theme.of(context)`**：「從我這個位置往上，找最近的一個 Theme，把它的設定給我」。所以 `context` 代表「我在樹的哪裡」，`.of(context)` 才知道要從哪開始往上找。
- 這個 `XXX.of(context)` 模式在 Flutter **無所不在**（`Theme.of`、`MediaQuery.of`、`Navigator.of`、`ScaffoldMessenger.of`…）。它背後是 Flutter 的 `InheritedWidget` 機制——「祖先把資料放在樹上，子孫用 context 往上拿」。第 06 章的 Riverpod 也是這個概念的進化版。

**心智模型**：`context` 是你在家族樹裡的位置。`Theme.of(context)` ＝「從我這個位置往上問祖先：『最近的主題是什麼？』」

---

## 3.7 `key`：Flutter 用來辨認 Widget 身分的身分證

回到 3.2：Element 比對新舊 Widget 時，預設是看「**型別 + 在 children 裡的位置**」。但有時候「位置」會騙人，這時就需要 `key`。

經典坑：一排有狀態的元件，重新排序時狀態跟錯人。

```dart
// 想像一個可勾選的待辦清單，每個 item 是 StatefulWidget（記住自己有沒有被勾）
Column(
  children: [
    TodoItem(key: ValueKey(todo.id), todo: todo),   // ⭐ 用穩定的 id 當 key
    // ...
  ],
)
```

逐段解釋：

- 不給 `key` 時，Element 靠「位置」配對。當你把清單**重新排序**，第 1 個位置的 Element 會去配對「現在排在第 1 的新 Widget」——於是**勾選狀態會留在位置上，而不是跟著資料走**，造成「勾錯項目」的詭異 bug。
- **`key: ValueKey(todo.id)`**：給每個 item 一張「身分證」。比對時 Flutter 改用 key 配對——「id=5 的 Element 去找 id=5 的新 Widget」，狀態就正確跟著資料移動了。

**什麼時候需要 key？** 規則：**當你有一串「有狀態」的同型別 Widget，且它們的順序/數量會變**（增刪、排序、篩選）時，給穩定的 `key`。其他大部分情況不用煩惱 key。

**心智模型**：沒有 key，Flutter 靠「站第幾個」認人；有了 key，改靠「身分證號」認人。人會換位置，但身分證不會變。

---

## 3.8 組合優於繼承：Flutter 寫 UI 的核心哲學

第 00 章提過「一切皆 Widget」是用小 Widget 組合。這裡講實務上怎麼落地。

**反例（新手常見）：所有東西塞在一個巨大的 build 裡**

```dart
Widget build(BuildContext context) {
  return Scaffold(
    body: Column(
      children: [
        // ...100 行的 header...
        // ...100 行的 list...
        // ...100 行的 footer...
      ],
    ),
  );
}
```

這會變成「300 行的 build 地獄」，難讀、難改、效能也差（任何一點變動都重建整包）。

**正解：拆成小 Widget**

```dart
class HomePage extends StatelessWidget {
  const HomePage({super.key});

  @override
  Widget build(BuildContext context) {
    return const Scaffold(
      body: Column(
        children: [
          _Header(),       // 把 header 抽成獨立 Widget
          _ProductList(),  // list 也抽出來
          _Footer(),       // footer 也是
        ],
      ),
    );
  }
}

class _Header extends StatelessWidget {
  const _Header();
  @override
  Widget build(BuildContext context) {
    return const Padding(
      padding: EdgeInsets.all(16),
      child: Text('商店', style: TextStyle(fontSize: 24)),
    );
  }
}
// _ProductList、_Footer 同理...
```

逐段解釋為什麼這樣更好：

- **好讀**：`HomePage.build` 一眼看出頁面由 header / list / footer 組成，細節各自關起來。
- **好維護**：改 header 只動 `_Header`，不會誤觸別的。
- **效能更好**：拆成獨立 Widget（尤其是 `const` 的）後，Flutter 重建時可以**跳過沒變的子 Widget**。整包塞在一起時做不到這點。
- **`_` 開頭的類別名**：代表「這個 Widget 只在本檔案用」（私有），不對外。

> 💡 實務技巧：在 VS Code 把游標放在某個 Widget 上，按 `Ctrl/Cmd + .`（快速修復）→ `Extract Widget`，可以一鍵把一段抽成獨立 Widget。

**心智模型**：寫 Flutter UI ＝ 把大畫面**切成一塊塊小積木**，每塊積木是一個 Widget。不要做「一個超大積木」，要做「很多小積木拼起來」。這跟 React 把 UI 拆成小 component 完全同個精神。

---

## 3.9 `const` Widget 再訪：它到底省了什麼

第 02 章說「能加 const 就加」，現在用三棵樹解釋為什麼：

```dart
// build 每次被呼叫時：
return Column(
  children: [
    const Text('標題'),     // const：永遠是同一個物件，Flutter 直接認得「沒變」
    Text('count: $count'),  // 非 const：每次 build 都產生新物件
  ],
);
```

- **`const Text('標題')`**：因為它是編譯期常數，**每次 build 拿到的是「同一個物件實例」**。Element 比對時發現「咦，跟上次根本是同一個東西」，直接跳過，連設定更新都省了。
- 非 const 的 `Text('count: $count')` 則每次都是新物件，要走比對流程（雖然也很便宜）。

**結論**：對「內容固定、不依賴會變的資料」的 Widget，**加上 `const`** 能讓 Flutter 在重建時直接略過它們，是免費的效能優化。lint 通常會自動提醒你哪裡可以加。

---

## 3.10 動手練習

1. 寫一個 `StatelessWidget` 叫 `PriceTag`，接收 `double price`，顯示成 `NT$ 100.0`。
2. 寫一個 `StatefulWidget` 計數器，有 `+` 和 `-` 兩個按鈕，且數字不能小於 0。
3. 在第 2 題的 State 加上 `initState` 印出 `'計數器誕生'`、`dispose` 印出 `'計數器銷毀'`，然後切換頁面觀察何時觸發。
4. 把一個你寫的長 build 用 `Extract Widget` 拆成 2~3 個小 Widget，並把不會變的加上 `const`。
5. **思考題**：如果把 `_CounterState` 裡的 `_count` 搬到 `Counter`（StatefulWidget）類別裡當欄位，會發生什麼？（提示：回想 3.4——Widget 會被重建）

---

## 小結

- Widget 不是畫面，是**畫面的設定說明書**：便宜、不可變、會被一直重建。
- **三棵樹**：Widget（設定，便宜）→ Element（穩定的中間人，負責比對更新）→ RenderObject（真正畫畫，昂貴）。**這是「一直重建卻不卡」的真正原因。**
- `StatelessWidget`（長相只看傳入參數）vs `StatefulWidget`（有會變的狀態）。狀態拆到 State 物件，是因為它要掛在**長壽的 Element** 上才留得住。
- 生命週期：`initState`（開場佈置，做一次）、`build`（描述畫面，可能很多次，別放副作用）、`dispose`（散場收拾，關掉 controller/stream/timer）。
- `BuildContext` 是「你在樹裡的位置」，`XXX.of(context)` 靠它往上找祖先資料。
- `key` 是 Widget 的身分證，在「有狀態、會排序/增刪的同型別清單」時必備。
- 寫 UI ＝ 組合小 Widget；能加 `const` 就加，讓 Flutter 跳過沒變的部分。

---

> 懂了 Widget 的本質，下一章我們就大量「擺積木」：版面配置（Row/Column/Stack）、Flutter 獨特的「約束模型」、以及最常用的一批現成元件與列表。
> 前往 [第 04 章：版面配置與常用元件](./04-layout-and-common-widgets.md)。
