# 第 02 章:繪圖基本指令與「狀態機」

> **學習目標**:理解 `ctx` 是一台**狀態機**——你設定的不是「物件的屬性」,而是「畫筆當前的狀態」。
  > 掌握路徑(path)的構築、填色描邊的狀態、以及 `save()`/`restore()` 這對「狀態存檔/讀檔」如何防止你的程式碼互相污染。
> **預計時數**:120 分鐘
> 第 01 章我們讓畫布動了起來。這一章我們深入「畫筆」本身。如果你曾經「明明顏色設對了,畫出來卻是別的顏色」「畫第二個圖形時莫名其妙連出一條線」——那都是因為你還沒搞懂 Canvas 最反直覺的本質:**它是一台狀態機**。

---

## 2.1 核心心智模型:`ctx` 是一台狀態機,不是一組物件

先看一段對比。在 **DOM(retained mode)** 裡,樣式是**綁在物件上**的:

```js
// DOM:每個元素自己帶著自己的樣式
redBox.style.background = 'red';     // 這個 box 永遠是紅的
blueBox.style.background = 'blue';   // 那個 box 永遠是藍的
// 兩者互不影響,因為樣式屬於各自的物件
```

但在 **Canvas(immediate mode)** 裡,根本沒有物件可以綁樣式。你能做的是:**設定「畫筆當前的狀態」,然後之後所有的繪圖,都會沿用這個狀態,直到你下一次改它。**

```js
// Canvas:你設的是「畫筆現在的顏色」,不是「某個圖形的顏色」
ctx.fillStyle = 'red';
ctx.fillRect(0, 0, 50, 50);     // fillRect(x, y, 寬, 高) → 在 (0,0) 畫 50×50 的紅色方塊
ctx.fillRect(60, 0, 50, 50);    // 一樣 fillRect(x, y, 寬, 高),還是紅色!因為畫筆狀態沒變

ctx.fillStyle = 'blue';         // 現在把畫筆狀態改成藍
ctx.fillRect(120, 0, 50, 50);   // 藍色方塊
ctx.fillRect(180, 0, 50, 50);   // 還是藍色
```

> **心智模型**:把 `ctx` 想成一支**只有一種狀態的魔法畫筆**。它同一時間只記得「我現在是什麼顏色、多粗、要不要透明」。你畫東西時,它用**當下**的狀態去畫。你沒改它,它就一直用同一個狀態。
>
> **白話翻譯**:DOM 是「每個東西自己穿衣服」;Canvas 是「**一支畫筆,你幫它換衣服,它換好後畫的所有東西都穿那件,直到你再幫它換**」。

這個差異是 Canvas 一切「狀態污染」bug 的根源。我們先把畫筆狀態有哪些東西列出來,你就有全局觀了:

| 類別 | 狀態屬性 | 預設值 | 本章哪節講 |
|------|----------|--------|-----------|
| 填色 | `fillStyle` | `'#000'` 黑 | 2.4 |
| 描邊 | `strokeStyle`、`lineWidth`、`lineCap`、`lineJoin`、`miterLimit`、`lineDashOffset` | 黑 / 1 / butt / miter | 2.4 |
| 透明/合成 | `globalAlpha`、`globalCompositeOperation` | 1 / source-over | 2.7 |
| 文字 | `font`、`textAlign`、`textBaseline` | (見第 04 章) | 第 04 章 |
| 陰影 | `shadowColor`、`shadowBlur`、`shadowOffsetX/Y` | 透明 / 0 | 2.4 補充 |
| 變換 | 變換矩陣(`translate`/`rotate`/`scale`…) | 單位矩陣 | 第 03 章 |
| 裁切 | 目前的 clip 區域 | 全畫布 | 2.8 |

⚠️ 注意:**「當前路徑(current path)」不在這張表裡**——這很重要,2.6 講 `save/restore` 時會回來解釋為什麼。

---

## 2.2 三種繪圖典範:Path、Rectangle 捷徑、Pixel

Canvas 2D 畫東西其實只有三條路:

1. **路徑(Path)**:先「規劃」一條路徑(直線、曲線、圓弧的組合),再決定要 `fill()`(填滿內部)還是 `stroke()`(描出輪廓)。**最通用、最重要**,本章主角。
2. **矩形捷徑(Rectangle)**:`fillRect`/`strokeRect`/`clearRect`——因為矩形太常用,Canvas 給了「一步到位、不用建路徑」的捷徑。
3. **像素(Pixel)**:`getImageData`/`putImageData` 直接操作每個像素的 RGBA——第 05 章專講。

這章把 1 和 2 講透。

> **心智模型**:路徑模式像是「**先用鉛筆打草稿(規劃形狀),再決定要用油漆填滿、還是用簽字筆描邊**」。
> 打草稿(`arc`、`lineTo`)的時候**畫面上什麼都不會出現**,直到你 `fill()` 或 `stroke()` 才真正落筆。這是初學者第 5 名的坑:「我 `arc()` 了為什麼沒東西?」——因為你只打了草稿,沒落筆。

---

## 2.3 路徑指令詳解

一條路徑的生命週期是:**開始(`beginPath`)→ 規劃(`moveTo`/`lineTo`/`arc`…)→ 落筆(`fill`/`stroke`)**。

### `beginPath()` —— 為什麼非用不可(第 6 名坑)

`beginPath()` 的意思是「**清空之前的路徑規劃,重新開始一條**」。如果你不呼叫它,**新的路徑指令會「累加」到舊路徑上**,而且每次 `fill`/`stroke` 都會把**累積至今的整條路徑**重畫一次。

```js
// ❌ 沒有 beginPath 的災難
ctx.arc(50, 50, 20, 0, Math.PI * 2);   // arc(圓心x, 圓心y, 半徑, 起始角, 結束角),下一節詳解
ctx.stroke();                          // stroke():把目前路徑「描出輪廓」——這裡描出圓 A

ctx.arc(150, 50, 20, 0, Math.PI * 2);  // 這個 arc 累加到舊路徑!
ctx.stroke();                          // 把圓 A + 圓 B「一起」再描一次
// 結果:圓 A 被描了兩次(變深/變模糊),還可能多出一條連接線
```

```js
// ✅ 正確:每個獨立形狀前都 beginPath
ctx.beginPath();
ctx.arc(50, 50, 20, 0, Math.PI * 2);
ctx.stroke();

ctx.beginPath();                       // 清空,重新開始
ctx.arc(150, 50, 20, 0, Math.PI * 2);
ctx.stroke();
```

> **記死它**:**每畫一個獨立形狀前,先 `beginPath()`**。這是 Canvas 肌肉記憶級的習慣。忘記它,是新手最常見的「畫面莫名其妙多東西/顏色變深」來源。

### 直線類:`moveTo` / `lineTo`

- `moveTo(x, y)`:把「畫筆」抬起來、移到 `(x,y)`,**不畫線**(像鉛筆懸空移動)。
- `lineTo(x, y)`:從目前位置「拉一條線」到 `(x,y)`(鉛筆落下畫線)。

```js
ctx.beginPath();
ctx.moveTo(20, 20);    // 起點(懸空移過去)
ctx.lineTo(120, 20);   // 畫到右邊
ctx.lineTo(70, 100);   // 再畫到下方 → 形成一個 V / 三角形的兩條邊
ctx.stroke();          // 描邊(此時是開口的折線)
```

### 圓與圓弧:`arc`(最容易搞混角度)

```js
ctx.arc(x, y, radius, startAngle, endAngle, counterClockwise);
```

三個要命的細節:

1. **角度用弧度(radian),不是度數**。半圈 = `Math.PI`,整圈 = `Math.PI * 2`。要用度數請換算:`弧度 = 度 × Math.PI / 180`。
2. **0 弧度在「3 點鐘方向」(正右方)**,角度**順時針**增加(因為 y 軸向下,見第 01 章)。
3. 想畫**整圓**就 `0` 到 `Math.PI * 2`。

```
        1.5π (上, -y)
            │
   π ───────┼─────── 0 (右, +x)   ← 0 從這裡開始
   (左)     │
        0.5π (下, +y)             ← 順時針(因為 y 向下)
```

```js
// 整圓
ctx.beginPath();
ctx.arc(100, 100, 40, 0, Math.PI * 2);
ctx.fill();   // fill():把目前路徑的內部「填滿」——這裡填滿整圓

// 半圓(下半)
ctx.beginPath();
ctx.arc(220, 100, 40, 0, Math.PI);    // 0 → π,順時針掃過下半
ctx.fill();
```

### 矩形路徑:`rect`

`rect(x, y, w, h)` 會在路徑裡加一個矩形(注意:這是「加進路徑」,要自己 `fill`/`stroke`,跟 2.4 的 `fillRect` 捷徑不同)。

### 曲線:`quadraticCurveTo` / `bezierCurveTo` / `arcTo`(進階,先有印象)

```js
// 二次貝茲曲線:一個控制點 (cpx,cpy) + 終點 (x,y)
ctx.quadraticCurveTo(cpx, cpy, x, y);

// 三次貝茲曲線:兩個控制點 + 終點(設計工具的鋼筆工具就是這個)
ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, x, y);
```

> 曲線屬於進階,做圓角矩形、流暢連線、簽名板平滑化時會用到。這裡先知道「Canvas 能畫貝茲曲線、控制點決定彎曲方向」即可,Capstone(第 11 章)做連接線時會回來深入。現代瀏覽器也有 `ctx.roundRect(x,y,w,h,r)` 直接畫圓角矩形(較新 API:Safari 16+、2023 起才全瀏覽器普及;舊環境要自己用 `arcTo`/`arc` 拼),很方便。

### `closePath()` —— 它不是「結束路徑」

最後一個常見誤會:`closePath()` **不是**「結束/落筆」的意思,它是「**從目前位置拉一條線回到路徑起點,把形狀封口**」。

```js
ctx.beginPath();
ctx.moveTo(20, 20);
ctx.lineTo(120, 20);
ctx.lineTo(70, 100);
ctx.closePath();   // 從 (70,100) 自動連回起點 (20,20),封成三角形
ctx.stroke();      // 現在是封閉三角形,而不是開口折線
```

- `fill()` 時即使不 `closePath`,也會**自動視為封閉**來填(它會自動連回起點計算內部)。
- `stroke()` 時就有差:不 `closePath` 是開口折線,有 `closePath` 才封口。

---

## 2.4 描邊與填色的狀態

### 填(`fill`)vs 描(`stroke`)

- `fill()`:把路徑**內部**塗滿(用 `fillStyle`)。
- `stroke()`:沿著路徑**畫出輪廓線**(用 `strokeStyle` + `lineWidth`)。

一個路徑可以兩個都做(通常先 `fill` 再 `stroke`,讓邊框蓋在填色上):

```js
ctx.beginPath();
ctx.arc(100, 100, 40, 0, Math.PI * 2);
ctx.fillStyle = '#ffd166';     // 填色狀態
ctx.fill();
ctx.strokeStyle = '#333';      // 描邊狀態
ctx.lineWidth = 4;
ctx.stroke();
```

### 描邊的線條樣式

| 屬性 | 作用 | 常用值 |
|------|------|--------|
| `lineWidth` | 線寬 | 數字(預設 1) |
| `lineCap` | 線「端點」形狀 | `butt`(平切,預設)、`round`(圓頭)、`square`(方頭外擴) |
| `lineJoin` | 兩線「轉角」形狀 | `miter`(尖角,預設)、`round`(圓角)、`bevel`(切角) |
| `miterLimit` | 尖角過尖時的限制 | 數字(預設 10) |
| `setLineDash([...])` | 虛線樣式 | 例 `[10, 5]` = 畫10空5 |

```js
ctx.setLineDash([12, 6]);   // 虛線
ctx.lineCap = 'round';      // 圓頭
ctx.lineWidth = 8;
ctx.beginPath();
ctx.moveTo(20, 20); ctx.lineTo(200, 20);
ctx.stroke();
ctx.setLineDash([]);        // 記得清掉,否則「狀態污染」後面的線也變虛線!
```

> ⚠️ 最後那行 `setLineDash([])` 體現了 2.1 的狀態機本質:**虛線設定會一直生效,直到你清掉它**。後面你想畫實線卻變虛線?就是忘了清。這正是 2.6 的 `save/restore` 要解決的問題。

### 描邊在路徑「正中央」—— 1px 線為什麼會糊?(經典坑)

描邊是**跨在路徑上**畫的:線寬一半在路徑內側、一半在外側。當你畫一條 `lineWidth = 1` 的垂直線在整數座標 `x = 50`:

```
線的範圍 = 49.5 ~ 50.5(中心 50,各佔 0.5)
   → 跨越了兩個像素格(49 和 50)
   → 瀏覽器只好把這 1px 的線「平分」畫在兩格上(各 50% 不透明)
   → 看起來是一條 2px 寬的灰線,而不是 1px 的銳利黑線 → 糊!
```

**解法:把座標偏移半像素**,讓 1px 的線正好落在一個像素格中央:

```js
// ❌ 糊:整數座標的 1px 線
ctx.beginPath(); ctx.moveTo(50, 10); ctx.lineTo(50, 100); ctx.stroke();

// ✅ 銳利:偏移 0.5
ctx.beginPath(); ctx.moveTo(50.5, 10); ctx.lineTo(50.5, 100); ctx.stroke();
```

> **心智模型**:像素是有「格子」的,但座標是「格線」(在格子之間)。1px 的線畫在格線上 → 騎跨兩格 → 糊;畫在格子中央(+0.5)→ 正好填滿一格 → 銳利。畫表格、格線、像素藝術時這個技巧救命。(這跟第 01 章的 HiDPI 糊是**不同的糊**,別搞混:那個是緩衝區不夠細,這個是線騎在格線上。)

### 陰影(順帶一提)

```js
ctx.shadowColor = 'rgba(0,0,0,.3)';
ctx.shadowBlur = 8;
ctx.shadowOffsetX = 2;
ctx.shadowOffsetY = 2;
// 之後畫的東西都會帶陰影,直到你把 shadowColor 設回透明或 shadowBlur 設 0
```

---

## 2.5 漸層與圖樣:`fillStyle` 不只是顏色字串

`fillStyle` / `strokeStyle` 除了給顏色字串(`'red'`、`'#333'`、`'rgba(...)'`),還能給**漸層物件**或**圖樣物件**:

```js
// 線性漸層:從 (0,0) 到 (0,200) 的方向
const grad = ctx.createLinearGradient(0, 0, 0, 200);
grad.addColorStop(0, '#0077ff');    // 起點顏色(位置 0)
grad.addColorStop(1, '#00d2ff');    // 終點顏色(位置 1)
ctx.fillStyle = grad;
ctx.fillRect(0, 0, 300, 200);
```

| 方法 | 用途 |
|------|------|
| `createLinearGradient(x0,y0,x1,y1)` | 線性漸層(沿一條方向) |
| `createRadialGradient(x0,y0,r0,x1,y1,r1)` | 放射狀漸層(兩個圓之間) |
| `createConicGradient(angle,x,y)` | 圓錐(角度)漸層,做色相環、儀表 |
| `createPattern(image, repeat)` | 用一張圖當重複貼磚(背景紋理) |

> **重點**:漸層物件**建立時就綁定了座標**(那條方向是相對畫布座標的)。這在第 03 章你開始用 `translate`/`rotate` 移動座標系後會有微妙影響——漸層方向會跟著變換一起轉,有時是你要的、有時不是。先記著。

---

## 2.6 狀態的存檔與讀檔:`save()` / `restore()`(本章最重要)

到目前為止你應該已經感覺到痛點了:**畫筆狀態會一直殘留,污染後面的繪圖**。設了虛線忘了清、改了顏色忘了改回來、`scale` 完忘了還原……手動「改回去」既繁瑣又容易漏。

Canvas 給的解法是一對「**狀態存檔 / 讀檔**」:

- `ctx.save()`:把**當前的整個畫筆狀態**(所有 2.1 表格裡的東西:樣式、變換、clip…)**推入一個堆疊**保存起來。
- `ctx.restore()`:從堆疊**彈出最近一次保存的狀態,完整還原**。

```js
ctx.fillStyle = 'black';

ctx.save();                  // ── 存檔:把「現在是黑色」存起來
ctx.fillStyle = 'red';     // 改成紅色(只在這段有效)
ctx.globalAlpha = 0.5;     // 改透明度
ctx.fillRect(0, 0, 50, 50);// 用紅色半透明畫
ctx.restore();               // ── 讀檔:狀態完整還原成「黑色、不透明」

ctx.fillRect(60, 0, 50, 50); // 又變回黑色不透明,完全不受上面影響
```

### 它是一個堆疊(Stack)

`save`/`restore` 可以巢狀,後進先出(LIFO):

```js
ctx.save();        // 堆疊: [狀態A]
  ctx.save();      // 堆疊: [狀態A, 狀態B]
    // ...改一堆東西...
  ctx.restore();   // 彈出 B,還原到 B 存的那一刻;堆疊: [狀態A]
ctx.restore();     // 彈出 A;堆疊: []
```

> **心智模型**:`save`/`restore` 就像遊戲的**存檔點**。進一個房間前存檔(`save`),在裡面亂搞(改顏色、旋轉、縮放),出來時讀檔(`restore`),房間裡的改動完全不影響外面的世界。**「畫一個東西前 save、畫完 restore」是 Canvas 最重要的紀律。**

### 標準慣用法:用 save/restore 包住「會改狀態」的繪圖

```js
function drawBadge(ctx, x, y) {
  ctx.save();                    // 進門存檔
  ctx.translate(x, y);           // 移動座標系(第 03 章)
  ctx.fillStyle = 'crimson';
  ctx.beginPath();
  ctx.arc(0, 0, 20, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();                 // 出門讀檔——translate、fillStyle 全還原
}

// 呼叫方完全不用擔心 drawBadge 會把自己的畫筆狀態弄髒
drawBadge(ctx, 100, 100);
drawBadge(ctx, 200, 100);
```

> **這是寫可組合 Canvas 程式碼的黃金法則**:**每個繪圖函式都應該 `save` 開頭、`restore` 結尾**,做到「自掃門前雪、不污染外面」。第 08 章的場景圖,每個物件的 `draw()` 都會遵守這個約定。

### 兩個經典 bug

```js
// bug 1:save / restore 不成對 → 狀態洩漏 或 堆疊錯亂
ctx.save();
// ...忘了 restore... → 之後的狀態全被這次的改動污染,且堆疊越積越多

// bug 2:restore 比 save 多 → restore 一個空堆疊(無效,但邏輯已亂)
```

**口訣:`save` 和 `restore` 必須成對,像括號一樣。** 巢狀時尤其要對齊。

### ⚠️ save/restore 不會還原什麼?

回到 2.1 埋的伏筆:**`save`/`restore` 只管「畫筆狀態」,不管這兩樣東西**:

1. **當前路徑(current path)**:`restore` 不會還原路徑。路徑是獨立於狀態堆疊的,要重來請用 `beginPath`。
2. **畫布上的像素內容**:`restore` 是「還原畫筆設定」,**不是「復原畫面」**(它不是 Undo!)。你已經畫上去的像素不會因為 `restore` 而消失。

> 很多人誤以為 `restore()` 能「撤銷剛剛畫的東西」——**不行**。Canvas 沒有內建 Undo(又一個 immediate mode 的洞,第 08 章做白板時要自己實作 Undo/Redo)。`restore` 只還原「畫筆怎麼設定」,不還原「畫布長怎樣」。

---

## 2.7 透明度與合成:`globalAlpha` 與 `globalCompositeOperation`

### `globalAlpha` —— 整體透明度

```js
ctx.globalAlpha = 0.5;    // 之後畫的所有東西都半透明(會跟既有像素疊加)
// ...畫東西...
ctx.globalAlpha = 1;      // 記得改回來(或用 save/restore 包起來)
```

### `globalCompositeOperation` —— 新像素怎麼跟舊像素「混合」

預設是 `source-over`(新的蓋在舊的上面),但你可以改變混合規則,做出特效:

| 值 | 效果 | 典型用途 |
|-----|------|----------|
| `source-over`(預設) | 新蓋舊 | 一般繪圖 |
| `destination-out` | 新圖形變成「橡皮擦」,擦掉舊像素 | 橡皮擦工具、刮刮樂 |
| `multiply` | 顏色相乘(變暗) | 陰影、混色 |
| `screen` | 反相乘(變亮) | 光暈、發光 |
| `lighter` | 顏色相加 | 粒子發光疊加 |

```js
// 用 destination-out 做橡皮擦:後畫的形狀「擦掉」先前的內容
ctx.globalCompositeOperation = 'destination-out';
ctx.beginPath();
ctx.arc(mouseX, mouseY, 20, 0, Math.PI * 2);
ctx.fill();                                       // 在這個圓的範圍把畫面擦透明
ctx.globalCompositeOperation = 'source-over';     // 用完務必還原!
```

> 同樣是狀態機的成員:**用完一定要還原**(或包在 `save`/`restore` 裡)。`destination-out`、`multiply` 這些是做圖層特效、橡皮擦、發光的利器,第 05 章影像處理、第 11 章白板的橡皮擦都會用到。

---

## 2.8 裁切:`clip()`

`clip()` 把「**目前的路徑**」設成裁切區域:**之後所有繪圖只會出現在這個區域內**,區域外的一律被裁掉。它也是畫筆狀態的一部分(會被 `save`/`restore` 管理)。

```js
ctx.save();
ctx.beginPath();
ctx.arc(100, 100, 60, 0, Math.PI * 2);
ctx.clip();                       // 設定圓形裁切區
// 之後畫的東西只會顯示在這個圓內(例如把方形圖片裁成圓形頭像)
ctx.drawImage(avatar, 40, 40, 120, 120);   // drawImage(圖, x, y, 寬, 高),詳見第 04 章
ctx.restore();                    // 還原裁切區(否則後面全被裁在那個圓裡!)
```

> **務必用 `save`/`restore` 包住 `clip`**。否則裁切區會一直生效,你會發現「後面畫的東西莫名其妙只出現在某個圓裡」——這又是一個超難 debug 的狀態污染,因為裁切是「看不見」的狀態。

---

## 2.9 綜合範例:把狀態機觀念用起來

我們畫一排「不同樣式的圖示」,示範如何用 `save`/`restore` 讓每個圖示的狀態互不干擾:

```js
const items = [
  { color: '#e63946', alpha: 1,   dash: [] },
  { color: '#457b9d', alpha: 0.6, dash: [8, 4] },
  { color: '#2a9d8f', alpha: 1,   dash: [2, 3] },
];

items.forEach((item, i) => {
  ctx.save();                        // ① 每個圖示開始前存檔
  ctx.translate(80 + i * 120, 100);  // 移到各自位置(第 03 章詳述)

  // 設定這個圖示專屬的畫筆狀態
  ctx.globalAlpha = item.alpha;
  ctx.strokeStyle = item.color;
  ctx.fillStyle = item.color;
  ctx.lineWidth = 4;
  ctx.setLineDash(item.dash);

  // 畫一個圓 + 內部填色
  ctx.beginPath();                   // ② 形狀前 beginPath
  ctx.arc(0, 0, 40, 0, Math.PI * 2);
  ctx.stroke();

  ctx.restore();                     // ③ 畫完讀檔——alpha/dash/顏色全還原
});
// 因為每個都 save/restore 包好,三個圖示的虛線、透明度完全不互相污染
```

這段把本章三個關鍵紀律全用上了:

1. **`beginPath()`** 每個形狀前清路徑(2.3)。
2. **狀態機**:`globalAlpha`、`setLineDash` 等都是「設定後持續生效」的狀態(2.1、2.4)。
3. **`save`/`restore`** 把每個圖示的狀態隔離,互不污染(2.6)。

---

## 2.10 本章小結與下一步

這一章我們把 Canvas 最反直覺的本質講透了:

- **`ctx` 是狀態機**:你設的是「畫筆當前狀態」,不是「物件屬性」;狀態會持續生效到你改它,這是所有「顏色/虛線污染」bug 的根源。
- **路徑生命週期**:`beginPath`(清空)→ 規劃(`moveTo`/`lineTo`/`arc`/曲線)→ 落筆(`fill`/`stroke`)。**每個獨立形狀前 `beginPath`**;`arc` 的角度是弧度、0 在右方、順時針。
- **描邊細節**:`fill` vs `stroke`、線條樣式、描邊跨在路徑中央導致的 **1px 線模糊**與 +0.5 解法。
- **`fillStyle` 可以是漸層/圖樣**,不只顏色。
- **`save`/`restore`** 是「狀態存檔/讀檔」堆疊——**每個繪圖函式 save 開頭、restore 結尾**是黃金法則;但它**不是 Undo**,不還原路徑、也不還原已畫的像素。
- **合成與裁切**(`globalCompositeOperation`、`clip`)也是狀態,用完務必還原。

**下一章(03)**,我們進入 Canvas 最有「魔法感」也最該理解的部分:**座標變換與矩陣**。你會學到 `translate`/`rotate`/`scale` 其實都是在操作一個**變換矩陣**,理解它之後,你就能做出「**可以平移、縮放的相機**」(白板、地圖、設計工具的核心),並輕鬆處理「螢幕座標 ↔ 世界座標」的換算——這是第 07 章命中測定、第 11 章 Capstone 白板的數學地基。而且你會發現,`save`/`restore` 跟變換是天作之合。

> 💡 **動手作業**:用本章學到的東西畫一個**簡單的笑臉**(臉=大圓、眼睛=兩個小圓、嘴巴=半圓弧)。要求:① 每個部位前都 `beginPath`;② 用 `save`/`restore` 把「畫嘴巴時改的 lineWidth/lineCap」隔離,確保不影響眼睛。做完後故意把某個 `restore` 註解掉,觀察狀態污染怎麼讓畫面出錯——**親手製造一次 bug,比讀十遍更記得住**。
