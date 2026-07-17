# 第 07 章:互動與命中測定(Hit Testing)

> **學習目標**:兌現第 00 章最核心的推論——**Canvas 沒有 per-shape 事件,點到誰要自己算**。掌握「滑鼠座標 → 世界座標 → 判斷命中哪個物件」的完整鏈路:幾何數學命中、`isPointInPath`/`Path2D`、z-order 取最上層、**隱藏色彩緩衝**神技、空間索引,最後做出可 hover、可選取、可拖曳的互動。
> **預計時數**:130 分鐘
> 這是把 Canvas 從「會動的圖」變成「可互動的應用」的關鍵一章,也是這門課最能體現「自己造引擎」精神的一章——你要親手補上 DOM 免費送你的整套事件系統。

---

## 7.1 為什麼 Canvas「沒有 click 事件」?

回顧第 00 章:DOM 是 retained mode,瀏覽器記得每個元素,所以你點下去,它知道「你點的是那個按鈕」,自動派發 `click` 給它。

Canvas 是 immediate mode,**畫面上沒有物件,只有像素**。你點了畫布,瀏覽器只能告訴你:

```js
canvas.addEventListener('click', (e) => {
  // 它只知道:「canvas 這塊元素被點了,座標是 (e.clientX, e.clientY)」
  // 它完全不知道那個座標上有沒有圖形、是哪一個 —— 因為對它來說圖形不存在
});
```

**「那個座標上是哪個圖形?」這個問題,只能你自己回答。** 這就是命中測定(hit testing)。

> **心智模型**:DOM 的事件系統幫你做了兩件事——① 知道滑鼠在哪;② 知道那裡有哪個物件,把事件送給它。Canvas 只給你 ①,**② 整個是你的工作**。這一章就是手工打造 ②。

---

## 7.2 第一步永遠是:把事件座標轉成「世界座標」

在判斷命中之前,有一個必經步驟,90% 的 bug 出在這裡沒做對。瀏覽器給的 `e.clientX/Y` 是「視窗座標」,而你的物件存的是「世界座標」(第 03 章)。中間隔了兩層:canvas 在頁面的位置、以及相機變換。

```js
function eventToWorld(canvas, camera, e) {
  // ① 視窗座標 → 畫布內 CSS 座標(減掉 canvas 在頁面的位置)
  const rect = canvas.getBoundingClientRect();
  const cssX = e.clientX - rect.left;
  const cssY = e.clientY - rect.top;

  // ② 畫布座標 → 世界座標(套用相機逆變換,第 03 章 screenToWorld)
  return {
    x: cssX / camera.zoom + camera.x,
    y: cssY / camera.zoom + camera.y,
  };
}
```

> ⚠️ 三個常見錯誤:
> ① 用 `e.offsetX` 當畫布座標(看起來方便,其實有三個地雷,下面專門展開);
> ② 忘了套相機逆變換,平移縮放後命中全亂;
> ③ HiDPI 處理不一致(第 01 章我們在 context 上 `scale(dpr)`,所以這裡用 CSS 座標即可,不用乘 dpr——但要跟你的繪圖座標系**保持一致**)。

**之後所有命中判斷,都用這個 world point 跟物件的世界座標比。** 把它做對,後面才有意義。

### 展開講:`e.offsetX` 看起來剛剛好,為什麼不用?

`e.offsetX/Y` 的定義是「滑鼠相對**事件目標(`e.target`)**的座標」。乍看正是我們要的東西,在簡單頁面上也真的能用——但它有三個地雷,正式專案幾乎都會踩到其中一個:

**地雷 1:它相對的是 `e.target`,不保證是你的 canvas。** 只要監聽器掛在父容器上(事件委派),或 canvas 上疊了別的元素(浮動工具列、tooltip、第 11 章的分層 canvas),`e.target` 就是「滑鼠底下實際壓到的那個元素」,`offsetX` 跟著變成相對那個元素的座標——滑鼠劃過工具列的瞬間,座標整組亂跳,而且時好時壞極難 debug。`e.clientX - rect.left` 則永遠是相對「你指定的那塊 canvas」在量,跟監聽器掛在哪、滑鼠底下壓到誰都無關。

**地雷 2:CSS 把畫布縮放顯示時,你需要 `rect` 才換算得回繪圖座標。** 本課的範例都讓「CSS 顯示尺寸 = 邏輯尺寸」,所以座標直接相減就對。但 RWD 版面常寫 `canvas { width: 100% }`——假設邏輯寬 800 的畫布被版面擠成只顯示 600px(只設 `width` 時,瀏覽器會照畫布的長寬比自動縮 `height`,屬於**等比縮放**),滑鼠點在畫布正中央:`offsetX` 回報 300(顯示尺寸的一半),但在你的繪圖座標系裡那個點是 400,全部命中判斷都會歪。正確換算需要「此刻實際顯示的尺寸」:

```js
const rect = canvas.getBoundingClientRect();
const x = (e.clientX - rect.left) * (W / rect.width);    // W、H = 你的邏輯尺寸(例如 800×400)
const y = (e.clientY - rect.top)  * (H / rect.height);   // 先量顯示位置,再按「邏輯/顯示」比例放回繪圖座標
```

注意公式的 x、y **各用各的比例**:等比縮放時兩個比例相同,算出來自然對;若 CSS 同時指定了 `width` 和 `height`(例如 `width: 100%; height: 300px`),畫布會被**非等比拉伸**,兩個比例就不一樣了——這個寫法連這種情況也一併算對。

`rect.width/height` 就是畫布此刻實際顯示的大小(連 `transform: scale` 的效果都反映在內),縮放比例自然就有了。`offsetX` 給不了這個資訊,而且它在 CSS transform 下的行為各瀏覽器不一致,想修正也無從修起。

**地雷 3:border/padding 造成的偏移——兩種方法都會中,最穩是別放在 canvas 上。** canvas 的繪圖區是 content box:`offsetX` 從 padding edge 起算,canvas 有 `padding` 就偏;`rect.left` 是 border box 外緣,有 `border` 或 `padding` 就偏。與其背修正公式,**不如把框線和留白放到外層容器上**——要框線就包一層 `<div>` 讓它畫,canvas 本身保持乾淨,哪種算法都準。

> **一句話結論**:`offsetX` 是「事件目標的相對座標」,你控制不了目標是誰;`clientX + getBoundingClientRect` 是「對你指定元素的主動量測」,掛哪裡、怎麼縮放都算得回來。所以本課一律用上面 `eventToWorld` 的寫法。

---

## 7.3 幾何數學命中:點在不在圖形內?

最基本、最快的方法:用數學直接算。每種形狀有自己的判斷式。

### 點在矩形內

```js
function pointInRect(p, rect) {
  return p.x >= rect.x && p.x <= rect.x + rect.w &&
         p.y >= rect.y && p.y <= rect.y + rect.h;
}
```

### 點在圓內(算距離)

```js
function pointInCircle(p, circle) {
  const dx = p.x - circle.cx;
  const dy = p.y - circle.cy;
  return dx * dx + dy * dy <= circle.r * circle.r;   // 比平方,省一次開根號
}
```

> **小優化**:比較距離時用「平方」(`dx²+dy² <= r²`)而不是 `Math.sqrt(...) <= r`,省掉開根號。命中測定常常每幀對很多物件跑,這種小優化會累積。

### 點在多邊形內(射線法 ray casting)

任意多邊形用「**從該點往右射一條水平射線,數它穿過多邊形的邊幾次:奇數=在內,偶數=在外**」:

```
              ┌──────────┐
   外部 a ●───╳──────────╳────────→   穿過 2 條邊(偶數)→ a 在外
              │          │
   內部 b ────┼──● b ────╳────────→   從 b 往右只穿過 1 條邊(奇數)→ b 在內
              │          │
              └──────────┘
```

為什麼「奇數在內」?想像你站在點上,往右一直走到無限遠。每穿過一條邊,就切換一次「從外進到內」或「從內出到外」。終點在無限遠一定是在多邊形外,所以反推回來:穿奇數次代表起點在「內」,偶數次代表起點在「外」。

```js
function pointInPolygon(p, points) {   // points: 多邊形頂點 [{x,y}, ...],依序首尾相接
  let inside = false;
  // i 是「這一個」頂點,j 是「前一個」頂點,(j → i) 就是一條邊。
  // 初值 i=0, j=最後一個 → 第一條檢查的邊是「最後一點 → 第 0 點」,也就是收尾那條邊;
  // j = i++ 每圈先把目前的 i 存給 j、再讓 i 前進,於是邊依序是 (n-1→0)、(0→1)、(1→2)…
  // 這個寫法不用特別處理「最後一點連回第一點」的收尾邊,一個迴圈全包了。
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const xi = points[i].x, yi = points[i].y;   // 邊的一端
    const xj = points[j].x, yj = points[j].y;   // 邊的另一端
    const intersect =
      // 條件 1:這條邊有沒有「跨過」射線的高度 p.y?(一端在 p.y 上方、另一端在下方)
      //         兩端同高同側就不可能被水平射線穿到,用 !== 確保剛好一端在上、一端在下
      ((yi > p.y) !== (yj > p.y)) &&
      // 條件 2:邊與「y = p.y」的交點 x,落在 p 的右邊嗎?(因為射線是往右射)
      //         下面這串是用相似三角形算出交點的 x 座標,再看它是否 > p.x
      (p.x < (xj - xi) * (p.y - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;   // 每被穿過一次就翻轉一次內/外
  }
  return inside;
}
```

**拆解條件 2 的公式**。條件 1 已經確定「這條邊跨過了 `p.y` 這個高度」,所以邊一定會跟「`y = p.y` 這條水平線」相交於某一點。我們要算出那個交點的 x,再看它在不在 p 的右邊。

分兩步想。一條邊從 `A=(xi,yi)` 走到 `B=(xj,yj)`,把「沿著邊從 A 走到 B」想成進度 0→1:

1. **先算垂直方向要走多少比例**才會到達 `p.y` 的高度。整條邊垂直總長是 `yj - yi`,而我們只要從 `yi` 走到 `p.y`,走了 `p.y - yi`,所以比例是:

   ```
   比例 t = (p.y - yi) / (yj - yi)     // 例:邊從 y=0 到 y=4,想到 y=2 → t = 2/4 = 0.5(走一半)
   ```

2. **x 就照同一個比例跟著走**。x 從 `xi` 出發,整條邊水平總共移動 `xj - xi`,走了 `t` 比例就是移動 `(xj - xi) × t`,所以交點:

   ```
   交點 x = xi + (xj - xi) × t = (xj - xi) × (p.y - yi) / (yj - yi) + xi
   ```

   這正是程式碼裡 `p.x <` 右邊那一整串。

**代個數字走一遍**:邊 `A=(2,0) → B=(6,4)`,查詢點 `p=(1, 2)`。
- `t = (2 - 0) / (4 - 0) = 0.5`(p.y=2 剛好在這條邊的垂直中點)
- `交點 x = 2 + (6 - 2) × 0.5 = 4`(邊在高度 2 的地方,x 落在 4)
- 條件 2:`p.x(1) < 交點x(4)` → true。p 在交點左邊,往右的射線會穿過這條邊 ✓

如果把 p 換成 `(5, 2)`:`5 < 4` → false,交點在 p 的左邊,射線往右射就碰不到這條邊了。

> **條件 1 那兩個 `>`,為什麼是 `>` 而不是 `>=`?** 指的是 `(yi > p.y)` 和 `(yj > p.y)` 這兩個比較。它們在問「這個端點在射線上方嗎」,而**當端點的 y 剛好等於 `p.y`(頂點正好落在射線上)時,用 `>` 會把它判成「不在上方」**——等於規定「剛好同高」一律算下方。這個看似隨便的選擇,是為了處理「射線剛好穿過一個頂點」這種邊界情形。
>
> 為什麼會出問題?一個頂點是**兩條邊共用**的端點。射線剛好穿過它時,這兩條邊都碰到了射線——如果規則不一致,可能兩條邊各數一次(多算 2 次)、或兩條都不數,奇偶就亂了。而「同高一律算下方」這個統一約定,會讓結果永遠正確:
>
> - 邊界**真的穿過**那個頂點(頂點一邊高、一邊低):只有一條邊會被數到 → 剛好算 1 次 ✓
> - 邊界**只是碰一下就回去**(頂點是往上的尖角或往下的凹谷,兩邊同高同側):兩條邊要嘛都不數、要嘛都數 → 算 0 或 2 次(偶數,等於沒穿過)✓
>
> 你不用背這些情形,只要記住:**`>`(而非 `>=`)是射線法的標準約定,用來讓「射線壓到頂點」時不會重複計數,照抄即可。**

### 點在「線段附近」(線/連接線的命中)

線沒有面積,點正好落在數學上那條「無寬度的線」機率是 0,所以命中改問「**點離線段夠不夠近**」:算出點到線段的最短距離,小於容差(例如 5px)就算命中。

最短距離怎麼算?想像從點 `p` 對線段拉一條垂直線,垂足(落在線段上的那個點)就是線段上離 `p` 最近的位置,`p` 到垂足的距離就是最短距離:

```
                p ●
                  │
                  │   ← 這段垂直距離就是最短距離,拿它跟容差比
                  │
   a ●────────────●────────────● b
                  ▲
              垂足 c(p 垂直投影到線段上的落點)
```

只是垂足有可能落在線段**外面**(延長線上),這時最近點其實是最靠近的那個端點,所以要把它「夾」回線段範圍內:

```js
function pointNearSegment(p, a, b, tolerance = 5) {
  // 線段方向向量(從 a 指向 b),與長度平方
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;

  // t = 垂足在線段上的位置比例:0 = 落在 a,1 = 落在 b,0.5 = 正中間。
  // 分子是「向量 a→p」和「向量 a→b」的內積(投影長度),除以長度平方換算成比例;
  // len2 為 0 代表 a、b 是同一點(退化線段),避免除以 0,直接令 t=0(就當 a)
  let t = len2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2 : 0;

  // 夾在 [0,1]:垂足若落在 a 之前(t<0)或 b 之後(t>1),最近點就是對應端點
  t = Math.max(0, Math.min(1, t));

  // 由比例 t 算出線段上的最近點 c = a + t × (b-a)
  const cx = a.x + t * dx, cy = a.y + t * dy;

  // 比較 p 到 c 的距離平方 vs 容差平方(平方比較,省一次開根號,同 7.3 的圓)
  const ddx = p.x - cx, ddy = p.y - cy;
  return ddx * ddx + ddy * ddy <= tolerance * tolerance;
}
```

**逐塊拆解求 `t` 這一行**。先把它讀成 `t = 分子 / len2`,外層 `len2 ? … : 0` 只是防呆:`len2` 是線段長度平方,等於 0 代表 a、b 疊在同一點(沒有方向可投影),就跳過計算直接令 `t=0`,避免除以 0。

重點在分子 `(p.x - a.x) * dx + (p.y - a.y) * dy`。這是兩個向量的**內積**:
- `(p.x - a.x, p.y - a.y)` 是向量 `a→p`(從線段起點指向查詢點)
- `(dx, dy)` 是向量 `a→b`(線段本身的方向)

內積的幾何意義是「**`a→p` 有多長的影子投在線段方向上**」——想像太陽垂直照在線段上,`a→p` 這根棍子在線段上的影子有多長。影子越長,垂足離 a 越遠。

但內積算出來的影子還帶著線段長度的倍率,不是「比例」。所以**除以 `len2`(長度平方)**把它歸一化:除一次長度把影子換成實際距離、再除一次長度換成「佔整條線段的比例」,結果就是 0~1 的 `t`(0=垂足在 a、1=在 b)。

**代數字走一遍**:線段 `a=(0,0) → b=(10,0)`(水平、長 10),查詢點 `p=(3,4)`。
- `a→p = (3,4)`,`a→b = (dx,dy) = (10,0)`
- 分子(內積)`= 3×10 + 4×0 = 30`
- `len2 = 10² + 0² = 100`
- `t = 30 / 100 = 0.3`

再往下一行 `c = a + t×(b-a) = (0 + 0.3×10, 0) = (3, 0)`——正是 `p=(3,4)` 垂直落到線段上的點,恰好在整條線段 0.3 的位置。完全吻合。

> **一句話**:內積負責「把 `a→p` 投影到線段方向、量出影子長度」,除以 `len2` 負責「把影子長度換算成 0~1 的比例」。這個「投影到某方向再化成比例」的向量手法,和 3.6 的座標換算、6.5 的 tween 進度 `t` 是同一套直覺。

> **心智模型**:幾何命中是「**用座標和半徑/邊界算數學**」。快、精確、不佔記憶體,適合形狀規則(矩形、圓、多邊形)的場景。缺點是每種形狀要寫一套,且旋轉/縮放過的形狀要先把點轉回形狀的本地座標系(用第 03 章的逆變換)再判斷。

---

## 7.4 用 Canvas 內建:`isPointInPath` 與 `Path2D`

當形狀很不規則(複雜路徑、貝茲曲線),自己寫數學太難。Canvas 提供 `isPointInPath`:**重建那條路徑,問 context「這個點在不在路徑裡」**。

```js
ctx.beginPath();
ctx.arc(100, 100, 40, 0, Math.PI * 2);   // arc(圓心x, 圓心y, 半徑, 起始角, 結束角) → 在 (100,100) 畫半徑 40 的整圓
if (ctx.isPointInPath(mouseX, mouseY)) {  // 注意:用「畫布座標」,且受當前變換影響
  console.log('命中圓');
}
ctx.isPointInStroke(mouseX, mouseY);      // 是否在「描邊線」上(命中細線好用)
```

問題:每次判斷都要重建路徑,而且座標系要對。更好的做法是用 **`Path2D` 物件把路徑存起來**,重複使用:

```js
// 建立時就把每個物件的路徑存成 Path2D
const circlePath = new Path2D();
circlePath.arc(100, 100, 40, 0, Math.PI * 2);   // arc(圓心x, 圓心y, 半徑, 起始角, 結束角) → 圓心 (100,100)、半徑 40 的整圓

// 畫的時候直接用
ctx.fill(circlePath);

// 命中判斷:傳入 Path2D,不用重建
if (ctx.isPointInPath(circlePath, mouseX, mouseY)) { /* 命中 */ }
```

> **取捨**:`isPointInPath` 的好處是「畫什麼形狀就能命中什麼形狀」,不用為每種形狀寫數學;壞處是它受 context 當前變換影響(座標要對齊),且大量物件時逐一呼叫不夠快。**規則形狀用 7.3 的數學、不規則形狀用 `Path2D` + `isPointInPath`** 是常見搭配。

---

## 7.5 多個物件:從上到下測,取最上層

畫面上有很多物件且會重疊。使用者點下去,應該命中「**最上面那個**」(視覺上蓋住別人的那個)。

繪製順序是「先畫的在下、後畫的在上」(z-order)。所以命中測定要**反向遍歷**(從最後畫的、也就是最上層開始),命中第一個就回傳:

```js
function hitTest(worldPoint, scene) {
  // 反向:從最上層(陣列尾端)往下找
  for (let i = scene.length - 1; i >= 0; i--) {
    if (scene[i].containsPoint(worldPoint)) {
      return scene[i];   // 命中最上層的就回傳,不再往下
    }
  }
  return null;           // 點到空白
}
```

> **心智模型**:畫畫是「由下往上疊」,命中是「由上往下找」——跟你伸手去拿一疊紙最上面那張的直覺一致。這個「反向遍歷取第一個命中」是所有編輯器選取邏輯的核心。

---

## 7.6 神技:隱藏色彩緩衝(Color Picking / Hidden Hit Canvas)

當形狀極度不規則(複雜路徑、半透明、甚至是逐像素的圖),數學命中寫不出來、`isPointInPath` 又太慢。有一個漂亮的招數:**用顏色當 ID**。

做法:

1. 開一張**離屏 canvas**(跟主畫布一樣大,但不顯示)。
2. 把每個物件用一個**獨一無二的純色**(當作它的 ID)畫到這張離屏 canvas 上(形狀跟主畫布完全一樣)。
3. 命中時,讀離屏 canvas 上**滑鼠螢幕位置那一點的顏色**(`getImageData` 1×1),把顏色換算回物件 ID。

```js
// 把 index 編碼成顏色(支援 ~1670 萬個物件)
function idToColor(id) {
  return `rgb(${(id >> 16) & 255}, ${(id >> 8) & 255}, ${id & 255})`;
}
function colorToId(r, g, b) {
  return (r << 16) | (g << 8) | b;
}

// hit canvas 用「1:1 邏輯尺寸」(不做 dpr 縮放——命中不需要高解析度,還更省),
// 但要套用「跟主畫布相同的相機」,讓每個形狀落在相同的螢幕位置。
function renderHitCanvas(hitCtx, scene) {
  hitCtx.setTransform(1, 0, 0, 1, 0, 0);      // setTransform(a,b,c,d,e,f) → 重設為單位矩陣(1:1、無縮放/旋轉/平移)
  hitCtx.clearRect(0, 0, W, H);               // 清成透明 → RGB 讀回 0 = 空白(見下方注)
  hitCtx.imageSmoothingEnabled = false;       // 關平滑!否則邊緣混色,ID 算錯
  hitCtx.save();
  applyCamera(hitCtx);                        // ★ 跟主畫布同一個相機,座標才對得上
  scene.forEach((shape, i) => {
    hitCtx.fillStyle = idToColor(i + 1);      // i+1:留 0 當「空白」
    shape.drawShapeOnly(hitCtx);              // 用純色畫同樣形狀(不畫漸層/紋理)
  });
  hitCtx.restore();
}

// 注意:傳入的是「螢幕座標(CSS 像素)」,不是世界座標——
// 因為 hit canvas 已套相機,形狀就畫在螢幕位置上。
function hitTestByColor(hitCtx, cssX, cssY, scene) {
  const [r, g, b] = hitCtx.getImageData(cssX, cssY, 1, 1).data;
  const id = colorToId(r, g, b);
  return id === 0 ? null : scene[id - 1];
}
```

> ⚠️ **兩個一定要對的座標細節(否則 Retina 上必踩,且會跟第 05 章打架)**:
> ① `getImageData` 永遠用**緩衝區的物理像素**座標(第 05 章 5.4 的鐵則),不受 `ctx` 變換影響。本例把 hit canvas 設成 **1:1 邏輯尺寸**(`setTransform(1,…)`、buffer = CSS 尺寸),所以能直接用 CSS 螢幕座標讀;若你比照主畫布也 `scale(dpr)`,就得改成 `getImageData(cssX * dpr, cssY * dpr, …)`。
> ② 讀的是**螢幕座標**而非世界座標——因為 hit canvas 套了同一個相機,形狀已落在螢幕位置。所以這裡只取到「CSS 螢幕座標」那一步(`e.clientX - rect.left`)即可,**不要**再做 7.2 的 `screenToWorld`。

| | 幾何數學(7.3) | 隱藏色彩緩衝(7.6) |
|---|----------------|---------------------|
| 精度 | 形狀的數學邊界 | **像素級精準**(連複雜路徑、文字邊緣都準) |
| 複雜形狀 | 難 | **免費**(畫得出來就命中得到) |
| 速度 | 視物件數 | 命中是 O(1)(只讀一個像素) |
| 成本 | 無額外記憶體 | 多一張全尺寸 canvas + 每次變動要重畫它 |
| 坑 | — | 必須關 `imageSmoothingEnabled`,否則抗鋸齒混色讓 ID 錯亂 |

> **心智模型**:用「顏色」當物件的隱形指紋。你看到的是漂亮的主畫布,背後有一張「身分證畫布」每個物件塗著自己的 ID 色;點哪裡,就看背後那點是誰的顏色。WebGL 也常用這招(叫 GPU picking)。**它把「複雜形狀命中」這個難題,轉化成「讀一個像素」這個簡單操作**——非常優雅。

---

## 7.7 大量物件:空間索引(別每次都 O(n) 掃)

7.5 的命中測定是「遍歷所有物件」,O(n)。畫面上幾十個物件沒問題,但**幾千、幾萬個**時,每次滑鼠移動都掃一遍會卡。

解法:**空間索引**——把空間切成區塊,只檢查「滑鼠所在區塊」的物件。常見兩種:

- **均勻網格(uniform grid)**:把世界切成固定大小的格子,每格記錄哪些物件在裡面。查詢時只看滑鼠那格。實作簡單,物件分布均勻時很好。
- **四叉樹(quadtree)**:遞迴把空間分成四象限,物件密的地方分得細、疏的地方分得粗。適合分布不均的場景。

```
四叉樹:只在物件密集處細分
   ┌─────┬──┬──┐
   │     ├──┼──┤    查詢點 → 只往它落入的象限遞迴
   │     ├──┼──┤    → 從「檢查 10000 個」變成「檢查附近幾個」
   ├─────┴──┴──┤
   │           │
   └───────────┘
```

> **心智模型**:空間索引就像圖書館的分類——你不會把每本書都翻過才找到要的,你直接去那一櫃。**O(n) → O(log n) 或接近 O(1)**。但別過早優化:幾百個物件用 7.5 的線性掃就夠了,**先量測再決定要不要上空間索引**(呼應第 09 章「先測量」)。碰撞偵測(粒子、遊戲)也用同一套結構。

---

## 7.8 完整互動:hover 高亮 + 點擊選取 + 拖曳

把前面串成一個真正能用的互動。我們做：滑過高亮、點擊選取、按住拖曳。

```js
// ── 材料:以下都是前面小節出現過的東西,這裡一起補齊,讓 7.8 能單獨貼上就跑 ──
//     (頁面需有一個 <canvas id="stage">;重點在下半部的互動邏輯)
const canvas = document.querySelector('#stage');
const ctx = canvas.getContext('2d');
const W = 800, H = 500;
const dpr = window.devicePixelRatio || 1;                 // HiDPI(第 01 章)
canvas.width = W * dpr; canvas.height = H * dpr;
canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
ctx.scale(dpr, dpr);

const camera = { x: 0, y: 0, zoom: 1 };                   // 相機(第 03 章),這裡用最單純的無平移縮放
function applyCamera(ctx) { ctx.scale(camera.zoom, camera.zoom); ctx.translate(-camera.x, -camera.y); }

function eventToWorld(canvas, camera, e) {                // 7.2:事件座標 → 世界座標
  const rect = canvas.getBoundingClientRect();
  const cssX = e.clientX - rect.left, cssY = e.clientY - rect.top;
  return { x: cssX / camera.zoom + camera.x, y: cssY / camera.zoom + camera.y };
}

function hitTest(p, scene) {                              // 7.5:反向遍歷,取最上層
  for (let i = scene.length - 1; i >= 0; i--)
    if (scene[i].containsPoint(p)) return scene[i];
  return null;
}

let dirty = true;                                         // 第 06 章:dirty flag,只在狀態變動時才重畫
function invalidate() { dirty = true; }

// 兩個示範物件:各自知道怎麼判斷命中(7.3)、怎麼畫、怎麼畫高亮與選取框
const scene = [
  {
    x: 120, y: 130, w: 180, h: 110, fill: '#457b9d',
    containsPoint(p) {                                    // 點在矩形內(7.3)
      return p.x >= this.x && p.x <= this.x + this.w &&
             p.y >= this.y && p.y <= this.y + this.h;
    },
    draw(ctx) { ctx.fillStyle = this.fill; ctx.fillRect(this.x, this.y, this.w, this.h); },
    drawHighlight(ctx) {                                  // hover:蓋一層半透明白,提亮
      ctx.fillStyle = 'rgba(255,255,255,0.25)';
      ctx.fillRect(this.x, this.y, this.w, this.h);
    },
    drawSelectionBox(ctx) {                               // selected:外圍畫虛線框
      ctx.strokeStyle = '#1d3557'; ctx.lineWidth = 2; ctx.setLineDash([6, 4]);
      ctx.strokeRect(this.x - 4, this.y - 4, this.w + 8, this.h + 8);
      ctx.setLineDash([]);                                // 清掉虛線,免得污染後面(第 02 章)
    },
  },
  {
    x: 470, y: 300, r: 70, fill: '#e63946',
    containsPoint(p) {                                    // 點在圓內:比距離平方(7.3)
      const dx = p.x - this.x, dy = p.y - this.y;
      return dx * dx + dy * dy <= this.r * this.r;
    },
    draw(ctx) {
      ctx.fillStyle = this.fill;
      ctx.beginPath(); ctx.arc(this.x, this.y, this.r, 0, Math.PI * 2); ctx.fill();
    },
    drawHighlight(ctx) {
      ctx.fillStyle = 'rgba(255,255,255,0.25)';
      ctx.beginPath(); ctx.arc(this.x, this.y, this.r, 0, Math.PI * 2); ctx.fill();
    },
    drawSelectionBox(ctx) {
      ctx.strokeStyle = '#1d3557'; ctx.lineWidth = 2; ctx.setLineDash([6, 4]);
      ctx.beginPath(); ctx.arc(this.x, this.y, this.r + 4, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]);
    },
  },
];

// ── 主體:hover 高亮 + 點擊選取 + 拖曳 ──
let hovered = null;
let selected = null;
let dragging = null;
let dragOffset = { x: 0, y: 0 };

canvas.addEventListener('pointermove', (e) => {
  const p = eventToWorld(canvas, camera, e);   // 7.2

  if (dragging) {
    // 拖曳中:物件跟著滑鼠移動(用按下時記的偏移,避免跳動)
    dragging.x = p.x - dragOffset.x;
    dragging.y = p.y - dragOffset.y;
    invalidate();                               // 第 06 章 dirty flag
    return;
  }

  // 沒拖曳:更新 hover 狀態 + 換游標
  const hit = hitTest(p, scene);                // 7.5
  if (hit !== hovered) {
    hovered = hit;
    canvas.style.cursor = hit ? 'pointer' : 'default';
    invalidate();
  }
});

canvas.addEventListener('pointerdown', (e) => {
  const p = eventToWorld(canvas, camera, e);
  const hit = hitTest(p, scene);
  selected = hit;
  if (hit) {
    dragging = hit;
    dragOffset = { x: p.x - hit.x, y: p.y - hit.y };   // 記住「抓在物件的哪裡」
    canvas.setPointerCapture(e.pointerId);             // 拖出畫布也持續收事件
  }
  invalidate();
});

canvas.addEventListener('pointerup', (e) => {
  dragging = null;
  canvas.releasePointerCapture(e.pointerId);
});

// render 時根據 hovered/selected 畫高亮、選取框
function render() {
  ctx.clearRect(0, 0, W, H);
  ctx.save(); applyCamera(ctx);
  for (const shape of scene) {
    shape.draw(ctx);
    if (shape === hovered) shape.drawHighlight(ctx);
    if (shape === selected) shape.drawSelectionBox(ctx);
  }
  ctx.restore();
}

// 迴圈:狀態有變才真的畫(配合 dirty flag,靜止時零成本)
function frame() {
  if (dirty) { render(); dirty = false; }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
```

幾個讓互動「專業」的細節:

- **`dragOffset`**:記住「按下時抓在物件的哪個相對位置」,拖曳時用它,物件才不會「跳」到滑鼠正中心。
- **`setPointerCapture`**:即使滑鼠拖出畫布外,也能持續收到 `pointermove`,拖曳不中斷。
- **`pointer` 事件**(而非 `mouse`):同時支援滑鼠、觸控、觸控筆,一套搞定。
- **游標樣式**:hover 到可拖物件時 `cursor: pointer`,給使用者明確回饋。
- **配合 dirty flag**:只在狀態變化時 `invalidate()`,靜止不重畫(第 06 章)。

---

## 7.9 效能細節:事件節流

`pointermove` 觸發**非常密集**(高刷新滑鼠每秒上百次)。如果每次都做重命中 + 重繪,會卡。標準做法:**把繪製交給 rAF,事件只更新狀態**:

```js
let pendingPoint = null;
canvas.addEventListener('pointermove', (e) => {
  pendingPoint = eventToWorld(canvas, camera, e);   // 事件只記座標,不立刻處理
});

function frame() {
  if (pendingPoint) {
    handleHover(pendingPoint);   // 一幀最多處理一次,多餘的事件被「合併」
    pendingPoint = null;
  }
  if (dirty) { render(); dirty = false; }
  requestAnimationFrame(frame);
}
```

> **心智模型**:事件來得比螢幕刷新還快是浪費——一幀內來 5 個 `pointermove`,你只需要最後一個。「**事件更新狀態、rAF 負責畫**」是把高頻事件跟渲染解耦的通用模式,呼應第 06 章 update/render 分離。

---

## 7.10 本章小結與下一步

- **核心**:Canvas 沒有 per-shape 事件,「點到誰」要自己算——這是 immediate mode 最大的洞,也是本章在補的。
- **必經第一步**:事件座標 → 世界座標(`getBoundingClientRect` + 相機逆變換),做錯則全盤皆錯。
- **幾何數學命中**:矩形/圓/多邊形(射線法)/線段距離;快、精確、無記憶體;比平方省開根號。
- **`isPointInPath` + `Path2D`**:不規則形狀的內建解,把路徑存成 `Path2D` 重用。
- **多物件**:反向遍歷取最上層(由上往下找)。
- **隱藏色彩緩衝**:用顏色當 ID,把「複雜形狀命中」變成「讀一個像素」,像素級精準、O(1)——記得關平滑。
- **空間索引**:大量物件用網格/四叉樹避免 O(n);但先測量再優化。
- **完整互動**:hover/選取/拖曳要有 `dragOffset`、`setPointerCapture`、pointer 事件、dirty flag、事件節流。

**下一章(08)**,我們把目前散落的物件資料,正式組織成一個 **場景圖(scene graph)**——也就是在 immediate mode 之上,親手蓋出一層 retained mode。你會發現自己重建了 Konva / Fabric 這類庫的核心,並因此解鎖三個 immediate mode 一直缺的能力:**階層/群組、Undo/Redo(兌現第 02 章伏筆)、以及序列化存檔**。引擎即將成形。

> 💡 **動手作業**:把第 06 章的粒子作業改成「**可點選的圖形編輯器雛形**」:畫面上散佈 20 個不同顏色的圓,實作 hover 變亮、點擊選取(選中畫外框)、拖曳移動。挑戰題:再用 7.6 的隱藏色彩緩衝重做一次命中測定,對比兩種做法的程式碼複雜度與手感。

### 動手作業參考實作

先自己動手做,卡住或想對答案時再看:

```html
<!DOCTYPE html>
<html lang="zh-Hant">
<head><meta charset="utf-8"><title>第 07 章作業:可點選的圖形編輯器雛形</title>
<style>
  body { font-family: sans-serif; }
  canvas { border: 1px solid #ccc; margin-top: 8px; }
</style></head>
<body>
  <!-- 挑戰題的開關:同一套互動,底下換兩種命中測定實作,手感應該一模一樣 -->
  <label><input type="checkbox" id="colorHit"> 用 7.6 的隱藏色彩緩衝做命中(取代數學命中)</label>
  <br>
  <canvas id="stage"></canvas>
  <script>
    const canvas = document.querySelector('#stage');
    const colorHitBox = document.querySelector('#colorHit');
    const W = 800, H = 480;

    // ---- 第 01 章 HiDPI:緩衝區 ×DPR,CSS 維持邏輯尺寸,再 scale ----
    const dpr = window.devicePixelRatio || 1;
    canvas.width = W * dpr;  canvas.height = H * dpr;
    canvas.style.width = W + 'px';  canvas.style.height = H + 'px';
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    // ---- 7.6 挑戰題:隱藏色彩緩衝(離屏,不顯示,1:1 邏輯尺寸,不做 dpr 縮放)----
    const hitCanvas = document.createElement('canvas');
    hitCanvas.width = W;  hitCanvas.height = H;
    const hitCtx = hitCanvas.getContext('2d', { willReadFrequently: true });   // 第 05 章:頻繁 getImageData 的提示

    // ---- 作業要求:20 個不同顏色的圓,散佈在畫面上 ----
    const circles = [];
    for (let i = 0; i < 20; i++) {
      circles.push({
        x: 40 + Math.random() * (W - 80),
        y: 40 + Math.random() * (H - 80),
        r: 16 + Math.random() * 16,
        hue: i * 18,   // 360 / 20 = 18,色相均分,保證 20 個顏色都不同
      });
    }

    let hovered = null;                  // 滑鼠正懸停的圓
    let selected = null;                 // 點擊選取的圓
    let dragging = null;                 // 正在拖曳的圓
    let dragOffset = { x: 0, y: 0 };     // 按下時「抓在圓的哪裡」
    let dirty = true;                    // 第 06 章:按需渲染的 dirty flag
    function invalidate() { dirty = true; }

    // ---- 7.2:事件座標 → 畫布座標(本作業沒有相機,畫布座標即世界座標)----
    function eventToWorld(e) {
      const rect = canvas.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    }

    // ---- 7.3:點在圓內,比距離平方,省一次開根號 ----
    function pointInCircle(p, c) {
      const dx = p.x - c.x, dy = p.y - c.y;
      return dx * dx + dy * dy <= c.r * c.r;
    }

    // ---- 7.5:反向遍歷,從最上層(陣列尾端)找起,命中第一個就回傳 ----
    function hitTestMath(p) {
      for (let i = circles.length - 1; i >= 0; i--) {
        if (pointInCircle(p, circles[i])) return circles[i];
      }
      return null;   // 點到空白
    }

    // ---- 7.6:把 index 編碼成顏色畫到隱藏畫布,命中 = 讀 1 個像素 ----
    function idToColor(id) {
      return 'rgb(' + ((id >> 16) & 255) + ',' + ((id >> 8) & 255) + ',' + (id & 255) + ')';
    }
    function renderHitCanvas() {
      hitCtx.clearRect(0, 0, W, H);              // 清成透明,RGB 讀回 0 = 空白
      hitCtx.imageSmoothingEnabled = false;      // 關平滑,否則邊緣混色讓 ID 算錯
      for (let i = 0; i < circles.length; i++) {
        hitCtx.fillStyle = idToColor(i + 1);     // i+1:留 0 當「空白」
        hitCtx.beginPath();
        hitCtx.arc(circles[i].x, circles[i].y, circles[i].r, 0, Math.PI * 2);
        hitCtx.fill();                           // 由下往上疊,上層蓋掉下層,z-order 自動正確
      }
    }
    function hitTestColor(p) {
      // hit canvas 是 1:1 邏輯尺寸,直接用 CSS 座標讀(getImageData 吃緩衝區像素座標)
      const d = hitCtx.getImageData(Math.floor(p.x), Math.floor(p.y), 1, 1).data;
      const id = (d[0] << 16) | (d[1] << 8) | d[2];
      return id === 0 ? null : circles[id - 1];
    }

    // 兩種命中法用開關切換,行為應該一模一樣,程式碼複雜度自己對比
    function hitTest(p) {
      return colorHitBox.checked ? hitTestColor(p) : hitTestMath(p);
    }

    // ---- 7.8:hover 高亮 + 點擊選取 + 拖曳 ----
    canvas.addEventListener('pointermove', (e) => {
      const p = eventToWorld(e);
      if (dragging) {
        // 作業要求:拖曳移動——用按下時記的偏移,圓才不會跳到滑鼠正中心
        dragging.x = p.x - dragOffset.x;
        dragging.y = p.y - dragOffset.y;
        invalidate();
        return;
      }
      const hit = hitTest(p);
      if (hit !== hovered) {
        hovered = hit;                                     // 作業要求:hover 狀態
        canvas.style.cursor = hit ? 'grab' : 'default';    // 作業要求:游標回饋
        invalidate();
      }
    });

    canvas.addEventListener('pointerdown', (e) => {
      const p = eventToWorld(e);
      const hit = hitTest(p);
      selected = hit;                                      // 作業要求:點擊選取(點空白 = 取消選取)
      if (hit) {
        dragging = hit;
        dragOffset = { x: p.x - hit.x, y: p.y - hit.y };   // 記住抓在圓的哪個相對位置
        canvas.style.cursor = 'grabbing';
        canvas.setPointerCapture(e.pointerId);             // 拖出畫布也持續收事件
      }
      invalidate();
    });

    canvas.addEventListener('pointerup', (e) => {
      if (!dragging) return;
      dragging = null;
      canvas.style.cursor = hovered ? 'grab' : 'default';
      canvas.releasePointerCapture(e.pointerId);
    });

    function render() {
      ctx.clearRect(0, 0, W, H);
      for (const c of circles) {
        // 作業要求:hover 變亮——把 HSL 亮度從 50% 提到 70%
        ctx.fillStyle = 'hsl(' + c.hue + ', 75%, ' + (c === hovered ? 70 : 50) + '%)';
        ctx.beginPath();
        ctx.arc(c.x, c.y, c.r, 0, Math.PI * 2);
        ctx.fill();
      }
      if (selected) {
        // 作業要求:選中畫外框——比圓大 4px 的虛線圓框
        ctx.strokeStyle = '#1d3557';
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 4]);
        ctx.beginPath();
        ctx.arc(selected.x, selected.y, selected.r + 4, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);   // 第 02 章:清掉虛線狀態,避免污染下一幀
      }
      renderHitCanvas();       // 圓移動了,身分證畫布也要同步重畫,兩邊才對得上
    }

    function frame() {
      if (dirty) { render(); dirty = false; }   // 第 06 章:狀態有變才重畫,靜止時零成本
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  </script>
</body>
</html>
```
