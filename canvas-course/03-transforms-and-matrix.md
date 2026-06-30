# 第 03 章:座標變換與矩陣——做一台可平移縮放的相機

> **學習目標**:理解 `translate`/`rotate`/`scale` 其實都是在操作同一個**變換矩陣**。學會「移動的是座標系、不是圖形」這個關鍵心智模型,做出一台能平移縮放的**相機**,並掌握「**螢幕座標 ↔ 世界座標**」的換算——這是第 07 章命中測定、第 11 章白板的數學地基。
> **預計時數**:120 分鐘
> 第 02 章我們學會控制「畫筆狀態」。這一章控制「**座標系統**」。一旦理解變換,你會發現很多原本要手算的麻煩座標,瞬間變簡單;白板、地圖、設計工具那種「拖著畫布平移、滾輪縮放」的功能,核心就是這一章。

---

## 3.1 先問:同一個圖,要畫在不同位置、角度、大小,難道每次都重算座標?

假設你要畫一輛小車,它由好幾個圖形組成(車身、兩個輪子)。現在要在畫面上畫 5 輛車,每輛位置不同、有的還轉了角度。

如果用「手算座標」的笨方法:

```js
// ❌ 笨方法:每個圖形都自己算絕對座標
function drawCarAt(x, y) {
  ctx.fillRect(x, y, 60, 20);              // 車身
  ctx.beginPath();
  ctx.arc(x + 15, y + 20, 8, 0, 7);        // 左輪:要手動 +15、+20
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x + 45, y + 20, 8, 0, 7);        // 右輪:又要手動算偏移
  ctx.fill();
}
```

位置還好,一旦要「旋轉」「縮放」,手算就變成三角函數地獄。**變換(transform)就是來解決這件事的**:讓你能畫「相對座標」,把「擺到哪、轉幾度、放多大」交給座標系統處理。

---

## 3.2 三個基本變換:`translate` / `rotate` / `scale`

```js
ctx.translate(dx, dy);   // 平移:把座標系原點移到 (dx, dy)
ctx.rotate(angle);       // 旋轉:把座標系繞「目前原點」旋轉 angle 弧度
ctx.scale(sx, sy);       // 縮放:把座標系在 x/y 方向各放大 sx/sy 倍
```

### 最關鍵的心智模型:你移動的是「紙」,不是「圖」

這是這一章唯一一個你必須扭轉的直覺。**`translate(100, 50)` 不是「把圖形往右下移」,而是「把整張畫紙的原點搬到 (100,50)」。** 之後你在「(0,0)」畫東西,它其實出現在畫面的 (100,50)。

```js
ctx.translate(100, 50);          // 把座標系原點搬到 (100,50)
ctx.fillRect(0, 0, 60, 20);      // 在「新原點」畫,等於畫在畫面的 (100,50)
```

> **白話翻譯**:想像你面前有一張描圖紙,你永遠在紙的原點(左上角)畫圖。`translate` 是「把紙往旁邊推」,`rotate` 是「把紙轉個角度」,`scale` 是「把紙放大」。**你的手(畫圖的座標)永遠不動,動的是紙。** 圖最後落在畫面哪裡,取決於紙被你怎麼擺。

有了這個模型,3.1 的小車變得超乾淨——**每輛車都「在原點畫」,用 `translate` 把紙挪到該去的位置**:

```js
// ✅ 用變換:car 永遠「以自己為原點」畫,不用算絕對座標
function drawCar() {
  ctx.fillRect(0, 0, 60, 20);          // 車身(相對座標)
  ctx.beginPath(); ctx.arc(15, 20, 8, 0, 7); ctx.fill();   // 左輪
  ctx.beginPath(); ctx.arc(45, 20, 8, 0, 7); ctx.fill();   // 右輪
}

function placeCar(x, y, angle) {
  ctx.save();              // 存檔(第 02 章的黃金法則!)
  ctx.translate(x, y);     // 把紙挪到車該在的位置
  ctx.rotate(angle);       // 把紙轉到車的角度
  drawCar();               // 永遠在原點畫
  ctx.restore();           // 還原,不污染下一輛車
}

placeCar(100, 100, 0);
placeCar(300, 150, Math.PI / 6);   // 這輛轉了 30 度,drawCar 完全不用改
```

看到 `save`/`restore` 了嗎?**變換是畫筆狀態的一部分(第 02 章那張表的最後一列)**,所以它跟 `save`/`restore` 是天作之合:每個物件畫之前 `save` + 設定變換,畫完 `restore`,變換就被乾淨地隔離。

---

## 3.3 變換會「累積」,而且「順序」很重要

兩個一定要踩穩的觀念:

### 變換會疊加

連續呼叫變換,效果是**累積**的(矩陣相乘,3.4 會解釋):

```js
ctx.translate(100, 0);
ctx.translate(50, 0);     // 現在原點在 (150, 0),不是 (50,0)
```

這也是為什麼**不 `restore` 就會「越積越歪」**——這是新手「畫第二幀整個跑掉/旋轉停不下來」的元兇。動畫迴圈裡每幀都 `rotate`,角度會一直累加。要嘛每幀 `save`/`restore`,要嘛用 3.4 的 `setTransform` 重設。

### 順序不可交換:translate→rotate ≠ rotate→translate

```js
// 寫法 A:先平移再旋轉 —— 繞「平移後的新原點」轉
ctx.translate(200, 200);
ctx.rotate(Math.PI / 4);
ctx.fillRect(0, 0, 50, 50);     // 方塊在 (200,200) 處,繞該點旋轉 45°

// 寫法 B:先旋轉再平移 —— 整個座標系先轉,平移方向也跟著轉了
ctx.rotate(Math.PI / 4);
ctx.translate(200, 200);        // 這個「往右 200」是沿著「已旋轉的 x 軸」!
ctx.fillRect(0, 0, 50, 50);     // 方塊跑到完全不同的地方
```

> **心智模型**:把每個變換想成「對那張紙的操作」,**後面的操作是在「前面操作完的紙」上進行的**。先轉紙再推紙,「推」的方向會沿著轉過的紙;先推紙再轉紙,是繞著推到的新位置轉。順序一變,結果天差地遠。

### 繞「自己中心」旋轉的標準套路

最常見的需求:讓一個圖形繞**它自己的中心**旋轉(而不是繞畫布左上角)。套路是「**平移到中心 → 旋轉 → 以中心為原點畫**」:

```js
function drawRotatedRect(cx, cy, w, h, angle) {
  ctx.save();
  ctx.translate(cx, cy);            // 1. 紙的原點移到圖形中心
  ctx.rotate(angle);                // 2. 繞這個中心轉
  ctx.fillRect(-w / 2, -h / 2, w, h); // 3. 以中心為原點畫(所以是 -w/2, -h/2)
  ctx.restore();
}
```

> **記死這個套路**:`translate(中心) → rotate → 畫在 (-w/2,-h/2)`。旋轉圖示、指針、子彈朝向、Capstone 白板的物件旋轉手把,全都是它。

---

## 3.4 變換的真面目:一個 2D 仿射變換矩陣

`translate`/`rotate`/`scale` 看起來是三個獨立功能,其實它們**底層都是在改同一個東西:context 維護的一個 2D 仿射變換矩陣(affine matrix)**。

數學上,把點 `(x, y)` 變換到 `(x', y')` 是這樣算的:

```
x' = a·x + c·y + e
y' = b·x + d·y + f

寫成矩陣:
┌ x' ┐   ┌ a  c  e ┐ ┌ x ┐
│ y' │ = │ b  d  f │ │ y │
└ 1  ┘   └ 0  0  1 ┘ └ 1 ┘
```

你不用會算矩陣乘法,但要知道這六個數的角色:

- **`a, d`**:x / y 方向的縮放(`scale` 改這裡)。
- **`b, c`**:傾斜/旋轉的成分(`rotate` 改這裡)。
- **`e, f`**:平移量(`translate` 改這裡)。

> **心智模型**:不管你 `translate`、`rotate`、`scale` 怎麼組合,**最終都被「壓縮」成這六個數字**。這就是為什麼任意複雜的變換組合,效能都一樣(永遠只是六個數)。也是為什麼變換能「累積」——每次呼叫就是把新矩陣乘進去。

### 直接操作矩陣的 API

| 方法 | 作用 |
|------|------|
| `setTransform(a,b,c,d,e,f)` | **直接設定**整個矩陣(覆蓋,不累積)——重設變換的利器 |
| `transform(a,b,c,d,e,f)` | 把一個矩陣**乘進**目前的矩陣(累積) |
| `getTransform()` | 取得目前的矩陣(回傳 `DOMMatrix` 物件) |
| `resetTransform()` | 重設成單位矩陣(等於 `setTransform(1,0,0,1,0,0)`) |

`setTransform` 在動畫迴圈裡特別有用——**每幀開頭用它把變換重設到已知狀態,避免累積誤差**(取代 3.3 那個「越積越歪」的問題):

```js
// 每幀開頭:重設變換(同時保留 HiDPI 縮放,見第 01 章)
const dpr = window.devicePixelRatio || 1;
ctx.setTransform(dpr, 0, 0, dpr, 0, 0);   // 重設,但保留 dpr 縮放
ctx.clearRect(0, 0, W, H);
// ...接著套用相機、畫場景...
```

---

## 3.5 做一台「相機」:平移 + 縮放整個世界

現在來做這章的重頭戲。白板、地圖、設計工具都有一台**相機**:你能拖著畫布平移、滾輪縮放,但**物件本身的座標(世界座標)是不變的**,變的只是「相機怎麼看這個世界」。

相機其實就是「**畫所有物件之前,先套用的一個變換**」:

```js
const camera = {
  x: 0,        // 相機在世界裡的位置(平移)
  y: 0,
  zoom: 1,     // 縮放倍率
};

function applyCamera(ctx, camera) {
  // 順序:先縮放、再平移(平移量也會被縮放,所以這樣組合最直覺)
  ctx.scale(camera.zoom, camera.zoom);
  ctx.translate(-camera.x, -camera.y);   // 相機往右看 = 世界往左移
}

function render() {
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);   // 重設(保留 HiDPI)
  ctx.clearRect(0, 0, W, H);

  ctx.save();
  applyCamera(ctx, camera);          // ★ 套用相機
  drawWorld(ctx);                    // 用「世界座標」畫所有物件,完全不用管相機
  ctx.restore();
}
```

`drawWorld` 裡的所有物件都用**固定的世界座標**,完全不知道相機存在。你只要改 `camera.x/y/zoom`,整個世界就跟著平移縮放。

```js
// 拖曳平移:滑鼠拖動時,反向移動相機(注意要除以 zoom)
canvas.addEventListener('pointermove', (e) => {
  if (dragging) {
    camera.x -= e.movementX / camera.zoom;
    camera.y -= e.movementY / camera.zoom;
  }
});
```

> **心智模型**:**世界座標是「物件真正住的地方」,螢幕是「相機拍出來的照片」。** 物件不動,你動的是相機。這個「世界 / 螢幕」的分離,是所有專業圖形編輯器的架構基石。第 11 章白板的相機就是這個。

---

## 3.6 螢幕座標 ↔ 世界座標的換算(命中測定的前置)

相機帶來一個馬上要面對的問題:**滑鼠事件給你的是「螢幕座標」,但你的物件存的是「世界座標」**。使用者點了螢幕上的某點,你得先把它換算回世界座標,才知道點到了哪個物件(這就是第 07 章命中測定的第一步)。

### 第一步:把瀏覽器事件座標轉成「畫布內座標」

`event.clientX/Y` 是相對「整個視窗」的,要先減掉 canvas 在頁面上的位置:

```js
function getCanvasPoint(canvas, e) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: e.clientX - rect.left,   // 相對 canvas 左上角的座標(CSS 像素)
    y: e.clientY - rect.top,
  };
}
```

> ⚠️ 因為我們在第 01 章用 `ctx.scale(dpr)` 處理了 HiDPI,**我們的繪圖座標是「邏輯/CSS 座標」**,而 `getBoundingClientRect` 給的也是 CSS 像素,所以這裡剛好對得上、不用再乘 dpr。(如果你沒在 context 上 scale、而是手動乘 dpr 畫,那這裡就要對應處理。先記住:**保持一致**。)

### 第二步:畫布座標 → 世界座標(套用相機的逆變換)

相機把世界座標變成螢幕座標(`scale` 再 `translate`),所以反過來就是**逆運算**:

```js
function screenToWorld(screenPoint, camera) {
  return {
    x: screenPoint.x / camera.zoom + camera.x,
    y: screenPoint.y / camera.zoom + camera.y,
  };
}

function worldToScreen(worldPoint, camera) {
  return {
    x: (worldPoint.x - camera.x) * camera.zoom,
    y: (worldPoint.y - camera.y) * camera.zoom,
  };
}
```

### 更通用的做法:用矩陣的逆矩陣

當變換很複雜(相機之外還有旋轉、巢狀變換),手寫逆運算會出錯。通用解法是拿 context 當下的矩陣、求逆矩陣,套到螢幕點上:

```js
function screenToWorldByMatrix(ctx, sx, sy) {
  const m = ctx.getTransform();          // 目前的變換矩陣(含 dpr、相機)
  const inv = m.inverse();               // 求逆矩陣(DOMMatrix 內建)
  const p = inv.transformPoint(new DOMPoint(sx * dpr, sy * dpr));
  return { x: p.x, y: p.y };
}
```

> **心智模型**:變換是「世界 → 螢幕」的函式,**逆矩陣就是它的反函式「螢幕 → 世界」**。任何「我點了螢幕上這裡,對應世界的哪裡」的問題,答案都是「套用當前變換的逆矩陣」。記住有 `DOMMatrix.inverse()` 這個工具,複雜場景不用自己推三角函數。

---

## 3.7 進階但超實用:以游標為中心縮放(zoom to cursor)

滾輪縮放時,最自然的體驗是「**游標指著的那個點,縮放後還在游標下**」(像 Google Maps、Figma)。如果只是改 `zoom`,你會發現畫面是繞左上角縮放的,很難用。

訣竅:**縮放前後,記錄游標對應的世界座標,讓它保持不變,反推出新的相機位置**:

```js
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const screen = getCanvasPoint(canvas, e);

  // 1. 縮放前,游標指著的世界座標
  const before = screenToWorld(screen, camera);

  // 2. 改變縮放(滾輪向上放大)
  const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
  camera.zoom *= factor;
  camera.zoom = Math.max(0.1, Math.min(camera.zoom, 20));   // 限制範圍

  // 3. 縮放後,同一個螢幕點現在指著的世界座標
  const after = screenToWorld(screen, camera);

  // 4. 把相機平移「差值」,讓游標下的世界點回到原位
  camera.x += before.x - after.x;
  camera.y += before.y - after.y;

  render();
}, { passive: false });
```

> **這段值得收藏**。「以某點為中心縮放」是所有畫布編輯器的標配,而它的數學就是上面這四步:**記住焦點的世界座標 → 縮放 → 把焦點移回原位**。第 11 章白板會直接用它。

---

## 3.8 本章小結與下一步

這一章我們從「手算座標的地獄」走到「操控座標系」:

- **核心心智模型**:變換移動的是**座標系(紙)**,不是圖形。你永遠「在原點畫」,用 `translate`/`rotate`/`scale` 把紙擺好。
- **變換會累積、順序不可交換**:`translate→rotate ≠ rotate→translate`;不 `restore` 就越積越歪。繞自身中心旋轉的套路:`translate(中心)→rotate→畫在(-w/2,-h/2)`。
- **矩陣真面目**:所有變換最終壓成六個數 `a,b,c,d,e,f`;`setTransform` 直接設定(重設利器)、`getTransform`/`inverse` 做座標反算。
- **相機**:畫世界前套用一個變換,實現平移縮放;世界座標不變,變的是相機。
- **螢幕↔世界換算**:命中測定的前置;`screenToWorld` 用相機逆運算,複雜時用 `DOMMatrix.inverse()`。
- **以游標為中心縮放**:記住焦點世界座標 → 縮放 → 移回原位。

**下一章(04)**,我們處理 Canvas 上的「素材」:**文字與圖片**。你會發現 Canvas **沒有自動換行**(又一個 immediate mode 的洞,得自己用 `measureText` 實作)、文字的 `textBaseline` 有個經典對齊坑;而 `drawImage` 的九參數版本,是精靈圖(sprite sheet)、把影片逐幀畫到畫布(連結影音課)的關鍵。

> 💡 **動手作業**:做一個「可平移縮放的無限網格」:用相機畫一片格線背景,支援滑鼠拖曳平移、滾輪以游標為中心縮放,並在畫面角落即時顯示「滑鼠當前的世界座標」。完成後你就擁有了白板的骨架——第 11 章 Capstone 會直接站在它上面。
