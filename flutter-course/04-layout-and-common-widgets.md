# 第 04 章：版面配置與常用元件

> 這一章把「擺積木」的功夫練起來。重點不是背一堆 Widget 名字，而是先搞懂 Flutter **獨特的版面規則——「約束模型」**。
> 90% 的 Flutter 排版錯誤（黃黑斑馬線、東西不見了、無限高度報錯）都是不懂約束模型造成的。
> 懂了它，你就從「亂試到對」進化成「知道為什麼」。

---

## 4.1 Flutter 的版面黃金法則：約束往下、尺寸往上、父層定位

這是 Flutter 排版的**唯一核心規則**，請背起來：

```text
1. 父層 → 給子層「約束（constraints）」    ：你最小/最大能多寬、多高
2. 子層 → 回父層「我決定的尺寸（size）」    ：在約束範圍內，我要這麼大
3. 父層 → 決定子層的「位置（position）」     ：把你擺在我座標的哪裡
```

**一句話心法**：**Constraints go down. Sizes go up. Parent sets position.**（約束向下傳，尺寸向上回，父層定位置。）

舉例理解：

- `Center` 對子層說：「你最大可以跟我一樣大，最小可以是 0，你自己決定」（寬鬆約束）。
- `SizedBox(width: 100, height: 100)` 對子層說：「你**必須**是 100×100」（緊約束）。
- 子層在這個約束內選一個尺寸回報，父層再把它擺到對應位置（Center 就擺中間）。

**為什麼一定要先懂這個？** 因為 Flutter 不像 CSS 那樣「我直接設這個東西寬 200」。在 Flutter，一個 Widget **能不能變成 200 寬，取決於它父層給的約束允不允許**。新手最常見的崩潰「我明明設了 width 為什麼沒效果？」答案永遠是：**父層的約束不允許**。

---

## 4.2 最常用的三劍客：Column / Row / Stack

### Column（垂直排）與 Row（水平排）

```dart
Column(
  mainAxisAlignment: MainAxisAlignment.center,    // 主軸（垂直）對齊
  crossAxisAlignment: CrossAxisAlignment.start,   // 交叉軸（水平）對齊
  children: [
    Text('第一行'),
    Text('第二行'),
    Text('第三行'),
  ],
)
```

逐段解釋（這兩個概念是 Row/Column 的全部精華）：

- **主軸 vs 交叉軸**：
  - `Column` 的**主軸是垂直**（東西往下排），交叉軸是水平。
  - `Row` 的**主軸是水平**（東西往右排），交叉軸是垂直。
  - **心智模型**：主軸＝「東西排列的方向」，交叉軸＝「跟它垂直的方向」。
- **`mainAxisAlignment`**：沿著主軸怎麼分布。常用值：`start`（靠頭）、`center`（置中）、`end`（靠尾）、`spaceBetween`（兩端對齊、中間平均留白）、`spaceAround`、`spaceEvenly`。
- **`crossAxisAlignment`**：在交叉軸上怎麼對齊。例如 Column 裡 `crossAxisAlignment: start` 讓每行靠左。

### Expanded 與 Flexible：按比例分配空間

```dart
Row(
  children: [
    Expanded(flex: 2, child: Container(color: Colors.red)),   // 佔 2 份
    Expanded(flex: 1, child: Container(color: Colors.blue)),  // 佔 1 份
  ],
)
```

- **`Expanded`**：放在 Row/Column 裡，表示「把剩餘空間按 `flex` 比例吃掉」。上面紅:藍 = 2:1 分配整列寬度。
- 這就是 Flutter 版的「彈性佈局」。想做「左邊固定、右邊填滿」？右邊包 `Expanded` 就好。
- **`Flexible`** 跟 Expanded 類似，差別在 Flexible 允許子層「比分到的空間小」，Expanded 強制「填滿分到的空間」。先記 Expanded，九成情況夠用。

### Stack：疊起來（類似 CSS 的 position: absolute）

```dart
Stack(
  children: [
    Image.network(imageUrl),                        // 底層：圖片
    Positioned(                                      // 疊在上面、指定位置
      bottom: 8,
      right: 8,
      child: Text('右下角浮水印'),
    ),
  ],
)
```

- **`Stack`**：讓子元件**互相疊在一起**（後面的蓋在前面的上面）。
- **`Positioned`**：在 Stack 裡精準定位（離上下左右多遠）。沒包 Positioned 的子元件就疊在左上角。
- 用途：頭像上的紅點通知、圖片上的文字、浮動按鈕疊在內容上。

---

## 4.3 容器類：Container / Padding / SizedBox

```dart
Container(
  width: 200,
  height: 100,
  padding: const EdgeInsets.all(16),         // 內距
  margin: const EdgeInsets.symmetric(horizontal: 8),  // 外距
  decoration: BoxDecoration(                 // 裝飾：背景、圓角、邊框、陰影
    color: Colors.white,
    borderRadius: BorderRadius.circular(12),
    boxShadow: const [BoxShadow(blurRadius: 4, color: Colors.black12)],
  ),
  child: const Text('卡片內容'),
)
```

逐段解釋：

- **`Container`**：瑞士刀型容器，可以同時設定大小、邊距、背景、圓角、陰影。**但別濫用**——如果只是要留白，用 `Padding`；只是要固定大小，用 `SizedBox`。Container 包山包海，單一用途時用專門的 Widget 更清楚、效能也好。
- **`EdgeInsets.all(16)`**：四邊都 16。其他常用：`EdgeInsets.symmetric(horizontal: 8, vertical: 4)`（左右 8、上下 4）、`EdgeInsets.only(left: 16)`（只有左邊）。
- **`decoration: BoxDecoration(...)`**：背景色、圓角、邊框、陰影都在這設定。**注意**：設了 `decoration` 就不能同時設 Container 的 `color`（會衝突報錯），顏色要寫進 `BoxDecoration` 裡。
- **`SizedBox`**：純粹「佔一個固定大小的空間」。最常見用法是當「間隔」：`SizedBox(height: 16)` 在兩個元件間插 16 的垂直間距，比用 Padding 更直覺。

---

## 4.4 文字、圖片、按鈕、圖示

```dart
// 文字
Text(
  '標題',
  style: TextStyle(fontSize: 20, fontWeight: FontWeight.bold, color: Colors.indigo),
  maxLines: 2,
  overflow: TextOverflow.ellipsis,    // 超過就顯示「...」
)

// 圖片（網路）
Image.network('https://example.com/cat.png', fit: BoxFit.cover)

// 圖片（專案內 asset，需先在 pubspec.yaml 的 assets 登記）
Image.asset('assets/images/logo.png')

// 圖示
Icon(Icons.favorite, color: Colors.red, size: 28)
```

逐段重點：

- **`Text` 的 `overflow: TextOverflow.ellipsis`** + `maxLines`：避免長文字撐爆版面。很常用。
- **`Image.network` 的 `fit: BoxFit.cover`**：控制圖片怎麼填滿區域。`cover`＝填滿（可能裁切）、`contain`＝完整顯示（可能留白）。
- **`Image.asset`**：用專案內建圖片前，要在 `pubspec.yaml` 的 `flutter: assets:` 區塊登記路徑（第 01 章提過），否則找不到檔案。

按鈕家族（Material 3）：

```dart
ElevatedButton(onPressed: () {}, child: const Text('主要按鈕'))   // 實心、突出
FilledButton(onPressed: () {}, child: const Text('填滿按鈕'))     // 填色
OutlinedButton(onPressed: () {}, child: const Text('外框按鈕'))   // 只有外框
TextButton(onPressed: () {}, child: const Text('文字按鈕'))       // 純文字
IconButton(onPressed: () {}, icon: const Icon(Icons.search))      // 只有圖示
```

- **共同重點：`onPressed`**。給它一個函式＝可點；**給 `null` ＝按鈕變灰（disabled）**。所以「依條件啟用/禁用按鈕」就是 `onPressed: canSubmit ? _submit : null`。

---

## 4.5 列表：ListView 與它的效能陷阱

清單是 App 最常見的畫面。Flutter 有兩種寫法，**選錯會卡爆**。

### 短清單：`ListView`（直接列出）

```dart
ListView(
  children: const [
    ListTile(title: Text('項目 1')),
    ListTile(title: Text('項目 2')),
    ListTile(title: Text('項目 3')),
  ],
)
```

- 適合**項目數量少且固定**（例如設定頁的 5 個選項）。
- **缺點**：它會「一次把所有 children 全部建出來」。如果有 1000 筆，啟動時就建 1000 個 Widget——卡。

### 長清單：`ListView.builder`（按需建立，⭐ 預設就用這個）

```dart
ListView.builder(
  itemCount: products.length,                 // 總共幾筆
  itemBuilder: (context, index) {             // 只在「快滑到」時才呼叫
    final p = products[index];
    return ListTile(
      title: Text(p.name),
      subtitle: Text('NT\$ ${p.price}'),
      onTap: () => print('點了 ${p.name}'),
    );
  },
)
```

逐段解釋（這是效能關鍵）：

- **`itemBuilder: (context, index) {...}`**：這是一個「**按需呼叫**」的函式。Flutter **只在某個項目快要進入畫面時才呼叫它建立**那一項，滑出去的會被回收。
- **白話翻譯**：螢幕只裝得下 10 筆，那就算你資料有 10000 筆，Flutter 同時間也只建約 10~15 個 Widget，捲動時動態回收再利用。**記憶體與效能都穩**。
- **心智模型**：`ListView`＝把整桌菜一次全端上來；`ListView.builder`＝你點到哪、廚房才出哪一道。長清單一律用 builder。
- **`ListTile`**：Material 提供的標準「清單列」，內建 title / subtitle / leading（左圖示）/ trailing（右圖示）/ onTap，排版好看又省事。

> 規則：**項目數量不確定或可能很多 → 一律用 `ListView.builder`。** 用普通 `ListView` 列大量資料是新手最常見的效能地雷。

---

## 4.6 滾動與安全區：SingleChildScrollView 與 SafeArea

```dart
SafeArea(                          // 避開瀏海、狀態列、底部手勢條
  child: SingleChildScrollView(    // 內容可能超出一屏 → 讓它能捲動
    child: Column(
      children: [ /* 很多內容 */ ],
    ),
  ),
)
```

- **`SafeArea`**：自動加上內距，**避開瀏海、狀態列、圓角、底部 home 手勢條**。不包它，內容可能被瀏海遮住。頁面最外層常包一個。
- **`SingleChildScrollView`**：當「一個 Column 的內容可能超過螢幕高度」時包它，內容就能上下捲動。**這也是解決惡名昭彰的 `RenderFlex overflowed`（黃黑斑馬線）的常見手段**——那條斑馬線就是在告訴你「東西超出可用空間了」。

---

## 4.7 一個整合範例：商品卡片

把上面學的組起來，做一張商品卡：

```dart
class ProductCard extends StatelessWidget {
  final String name;
  final int price;
  final String imageUrl;

  const ProductCard({
    super.key,
    required this.name,
    required this.price,
    required this.imageUrl,
  });

  @override
  Widget build(BuildContext context) {
    return Card(                                   // Material 卡片（自帶圓角+陰影）
      margin: const EdgeInsets.all(8),
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Row(                                // 左圖右文，水平排
          children: [
            ClipRRect(                             // 把圖片裁成圓角
              borderRadius: BorderRadius.circular(8),
              child: Image.network(
                imageUrl,
                width: 64, height: 64, fit: BoxFit.cover,
              ),
            ),
            const SizedBox(width: 12),             // 圖文之間留 12 間距
            Expanded(                              // 文字區吃掉剩餘寬度
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,  // 文字靠左
                children: [
                  Text(
                    name,
                    style: const TextStyle(fontSize: 16, fontWeight: FontWeight.bold),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                  const SizedBox(height: 4),
                  Text('NT\$ $price', style: const TextStyle(color: Colors.green)),
                ],
              ),
            ),
            const Icon(Icons.chevron_right),       // 右側箭頭
          ],
        ),
      ),
    );
  }
}
```

逐段把設計思路講清楚：

- **整體結構**：`Card`（外觀）→ `Padding`（內距）→ `Row`（左圖右文）。這就是 3.8 講的「組合」。
- **`ClipRRect`**：圖片本身是方的，用它裁成圓角。`Clip` 系列就是「把子元件裁形狀」。
- **`SizedBox(width: 12)`**：圖跟文字之間的間距。用 SizedBox 當間隔是 Flutter 慣例。
- **`Expanded` 包住中間的 Column**：這是關鍵。Row 裡左邊圖固定 64、右邊箭頭固定大小，**中間文字用 Expanded「吃掉剩下的所有寬度」**。沒有 Expanded 的話，長標題會把 Row 撐爆（出現斑馬線）。這正是 4.1 約束模型的實戰：Expanded 幫子層拿到「填滿剩餘空間」的約束。
- **`maxLines: 1` + `ellipsis`**：標題太長就 `...`，不會破版。
- **`NT\$`**：`$` 在 Dart 字串裡是特殊字元（插值用），要顯示錢字號得跳脫成 `\$`。

把它丟進 `ListView.builder` 的 `itemBuilder` 回傳，就是一個完整的商品列表了。

---

## 4.8 排版除錯心法（遇到問題照這個查）

1. **看到黃黑斑馬線（overflow）**：內容超出空間。解法：包 `Expanded`/`Flexible`（在 Row/Column 裡）、或包 `SingleChildScrollView`（讓它可捲）、或 `Text` 加 `maxLines`+`ellipsis`。
2. **「設了 width 沒效果」**：父層約束不允許。回想 4.1，先搞清楚父層給了什麼約束。
3. **「unbounded height/width」報錯**：常見於「Column 裡放 ListView」——Column 給 ListView 的高度約束是「無限」，ListView 不知道自己該多高。解法：把 ListView 包 `Expanded`。
4. **打開 Flutter DevTools 的 Layout Explorer**：能視覺化看每個 Widget 拿到的約束與實際尺寸，排版疑難雜症的神器。

---

## 4.9 動手練習

1. 用 `Row` + `Expanded` 做一個「紅:綠:藍 = 1:2:1」的橫條。
2. 做一個個人資料卡：圓形頭像（`CircleAvatar`）+ 右邊姓名與簡介，用 `Row` + `Expanded`。
3. 用 `ListView.builder` 列出 50 筆假資料（`List.generate(50, (i) => '項目 $i')`），每筆用 `ListTile`。
4. 故意在一個 `Row` 裡塞一段超長文字**不**包 Expanded，重現黃黑斑馬線，再用 Expanded 修好它——親手體驗約束模型。

---

## 小結

- **約束模型是 Flutter 排版的根**：約束往下、尺寸往上、父層定位。「設了大小沒效果」永遠先想「父層約束允不允許」。
- `Column`/`Row`：分清主軸/交叉軸，用 `mainAxisAlignment`/`crossAxisAlignment` 對齊，用 `Expanded` 按比例分空間。
- `Stack` + `Positioned`：疊層與絕對定位。
- 容器三兄弟：`Container`（全能但別濫用）、`Padding`（留白）、`SizedBox`（固定大小/當間隔）。
- 長清單**一律用 `ListView.builder`**（按需建立，效能穩），別用普通 ListView 硬列。
- `SafeArea` 避開瀏海、`SingleChildScrollView` 解 overflow。

---

> 會擺積木後，下一章讓 App「能換頁」：用 go_router 做宣告式路由、傳參數、處理 deep link。
> 前往 [第 05 章：導航與路由（go_router）](./05-navigation-and-routing.md)。
