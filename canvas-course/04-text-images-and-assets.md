# 第 04 章:文字、圖片與資源處理

> **學習目標**:在 Canvas 上正確地畫文字(含 `textBaseline` 對齊坑、**自己實作自動換行**)與圖片(`drawImage` 的三種簽名、精靈圖、**等圖片載入完才能畫**),並認識「可繪製的來源」有哪些——包括把 `<video>` 逐幀畫到畫布(連結影音課)。
> **預計時數**:100 分鐘
> 第 03 章我們學會擺放座標系。這一章處理真實專案最常見的兩種素材:**文字**與**圖片**。它們各自都有一個「DOM 免費送你、Canvas 卻要你自己做」的洞——文字的自動換行、圖片的非同步載入。

---

## 4.1 畫文字:`fillText` 與 `strokeText`

```js
ctx.font = '24px sans-serif';   // 先設字型(像 CSS 的 font 簡寫)
ctx.fillStyle = '#333';
ctx.fillText('Hello Canvas', 100, 100);   // fillText(文字, x, y) → 在座標 (100,100) 填色畫出文字(最常用)
ctx.strokeText('Outline', 100, 150);      // 只描邊框的空心字
```

文字也是**狀態機**的一員(第 02 章):`font`、`textAlign`、`textBaseline`、`fillStyle` 都是設定後持續生效的狀態。

### `font` 屬性:就是 CSS 的 font 簡寫

```js
ctx.font = 'bold italic 28px "Noto Sans TC", sans-serif';
//          ^粗 ^斜  ^大小 ^字型(順序跟 CSS font 簡寫一樣)
```

⚠️ 兩個坑:

1. **一定要寫單位**:`ctx.font = '24'` 無效,必須 `'24px ...'`。
2. **網頁字型(@font-face)要先載入完**,否則 `fillText` 會用後備字型畫,等字型載入完也**不會自動重畫**(immediate mode!)。用 `document.fonts.ready` 或 `FontFace` API 等載入完再畫:

```js
await document.fonts.ready;   // 等所有字型就緒
render();                     // 再畫,才會用到正確字型
```

---

## 4.2 對齊的坑:`textAlign` 與 `textBaseline`

`fillText(text, x, y)` 的 `(x, y)` 是文字的「錨點」,但「錨點落在文字的哪裡」由這兩個狀態決定:

```js
ctx.textAlign = 'center';      // 水平:left(預設) / center / right
ctx.textBaseline = 'middle';   // 垂直:這個最會出錯,見下
```

### `textBaseline` 的經典坑

預設 `textBaseline = 'alphabetic'`(英文字母的基線),意思是 `y` 對應的是**文字的基線**,而不是頂端或中間。所以你寫 `fillText('A', 0, 0)`,字其實畫在 `y=0` **上方**(因為基線在字的底部附近):

```
y=0 ───── A的基線在這 ──── 字往「上」長,跑到畫布外看不見!
```

這是新手「文字怎麼不見了/位置不對」的頭號原因。

| `textBaseline` 值 | `y` 對應到 | 何時用 |
|--------------------|-----------|--------|
| `alphabetic`(預設) | 字母基線(字底偏上) | 跟隨排版習慣時 |
| `top` | 文字頂端 | **想用 (x,y) 當左上角時最直覺** |
| `middle` | 文字垂直中心 | 想垂直置中時 |
| `bottom` | 文字底端 | 對齊底線 |

> **實用建議**:做 UI 標籤、置中文字時,設 `textBaseline = 'middle'` + `textAlign = 'center'`,然後 `(x,y)` 給「你想讓文字中心落在的點」,最直覺、最不會算錯。

```js
// 在任意 (cx, cy) 完美置中一段文字
ctx.textAlign = 'center';
ctx.textBaseline = 'middle';
ctx.fillText('置中', cx, cy);
```

---

## 4.3 量測文字:`measureText`(置中、自動換行的基礎)

Canvas **不會幫你排版**——它不知道一段文字多寬、會不會超出框、要不要換行。要知道這些,你得自己量:

```js
const metrics = ctx.measureText('Hello');
console.log(metrics.width);   // 這段文字的像素寬度
// 進階:metrics.actualBoundingBoxAscent / Descent 可算精確高度
```

### 自己實作「自動換行」(immediate mode 的洞)

DOM 裡文字超出寬度會自動換行,**Canvas 完全不會**。你得自己:逐字(或逐詞)累加寬度,超過最大寬度就換行。

```js
/**
 * 把 text 在 maxWidth 寬度內自動換行,逐行畫出。
 */
function wrapText(ctx, text, x, y, maxWidth, lineHeight) {
  // 切成「可斷點單位」:CJK 逐字、英文單字保持整塊、其餘標點/空白各自成 token。
  // (中文沒有空格,不能像英文那樣用 split(' ');這裡用正則同時處理中英混排)
  // 一-鿿:是一個字元範圍集合(character class):比對範圍 Unicode 碼位:一 = U+4E00,鿿 = U+9FFF 之間的任一個字
  // 中文:每個字都能當斷點 → 逐字切([一-鿿])
  // 英文:單字不該被拆開(hel 換行 lo 很醜)→ 整個單字當一個 token([A-Za-z0-9]+)
  const tokens = text.match(/[一-鿿]|[A-Za-z0-9]+|\s|\S/g) || [];
  let line = '';

  for (const tk of tokens) {
    const testLine = line + tk;
    if (ctx.measureText(testLine).width > maxWidth && line.trim() !== '') {
      ctx.fillText(line, x, y);            // 這一行滿了,先畫出來
      line = tk.trim() === '' ? '' : tk;   // 換行;行首不留空白
      y += lineHeight;                     // y 往下挪一行
    } else {
      line = testLine;
    }
  }
  if (line) ctx.fillText(line, x, y);      // 畫最後一行
}
```

> 上面的 CJK 偵測(`一-鿿`)是簡化版,涵蓋常用漢字;要完整支援(含全形標點、日韓、emoji 不被拆開)可改用 `Intl.Segmenter`(`new Intl.Segmenter('zh', { granularity: 'word' })`),它是瀏覽器內建的斷詞器,但較新(2023 起普及),用前先確認相容性。

> **心智模型**:Canvas 的文字是「畫上去的像素」,不是「會自己流動的文字盒」。**排版邏輯(換行、對齊、省略號…)全都是你的 JS 程式碼的責任**。這也是為什麼大型應用(如線上文件)寧可把文字交給 DOM,只把圖形交給 Canvas——排版這件事 DOM 做得太好了,沒必要重造。

---

## 4.4 畫圖片:`drawImage` 的三種簽名

`drawImage` 有三種參數形式,從簡單到強大:

```js
// 形式 1:原尺寸貼到 (dx, dy)
ctx.drawImage(img, dx, dy);

// 形式 2:縮放到 dw × dh
ctx.drawImage(img, dx, dy, dw, dh);

// 形式 3(九參數,最強):從來源裁一塊 (sx,sy,sw,sh),貼到目標 (dx,dy,dw,dh)
ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh);
```

### 九參數版本 = 精靈圖(sprite sheet)的核心

遊戲常把很多小圖拼成一張大圖(精靈圖),用九參數版本「只取其中一格」來畫,達到動畫或省請求:

```
   來源大圖(sprite sheet)        目標畫布
   ┌──┬──┬──┐                    ┌──────┐
   │ 0│ 1│ 2│   取第 2 格         │  ▣   │  畫到 (100,100)
   ├──┼──┼──┤   (sx=128,sy=0)    └──────┘
   │ 3│ 4│ 5│
   └──┴──┴──┘
```

```js
const FRAME = 64;            // 每格 64×64
const col = frameIndex % 4;  // 第幾欄
const row = (frameIndex / 4) | 0;
ctx.drawImage(
  spriteSheet,
  col * FRAME, row * FRAME, FRAME, FRAME,   // 來源:裁出這一格
  x, y, FRAME, FRAME                        // 目標:畫到畫面
);
```

> **心智模型**:九參數 `drawImage` = 「**從來源圖剪一塊貼上**」。換 `frameIndex` 就是換動作幀,做角色行走動畫;裁切大圖就是省 HTTP 請求。第 11 章白板的圖片物件、做縮圖,也都用它。

---

## 4.5 致命坑:圖片要「載入完」才能畫(非同步)

`new Image()` 的載入是**非同步**的。第 01 章除錯清單第 9 條就是它:你 `drawImage` 時圖片還沒下載好,結果什麼都沒畫出來,而且**不報錯**(immediate mode 忠實執行了一道「畫一張空圖」的命令)。

```js
// ❌ 錯:圖片還沒載入就畫
const img = new Image();
img.src = 'cat.png';
ctx.drawImage(img, 0, 0);   // 多半畫不出來,因為圖還在下載

// ✅ 對:等 onload
const img = new Image();
img.onload = () => ctx.drawImage(img, 0, 0);   // 載入完才畫
img.src = 'cat.png';
```

實務上用 Promise 包起來,把所有素材**預載完再開始渲染**:

```js
// 基本版:用 onload,包成回傳 Promise 的函式
function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}
```

不過 `onload` 只保證「**下載完**」,解碼(把壓縮的 JPEG/PNG bytes 轉成記憶體點陣圖)常被延遲到第一次 `drawImage` 才做,可能造成首幀卡頓。**更好的做法是改用 `img.decode()`**——它保證下載 + 解碼都完成才 resolve,`drawImage` 不會卡頓。同樣包成回傳 Promise 的函式,並記得處理載入失敗時的 reject:

```js
// 進階版:用 decode(),首次繪製不卡頓
async function loadImage(src) {   // async 函式本身就回傳 Promise
  const img = new Image();
  img.src = src;
  try {
    await img.decode();           // 下載 + 解碼都完成才往下走
    return img;
  } catch (e) {
    throw new Error(`圖片載入失敗:${src}`);   // decode() 失敗會 reject
  }
}
```

兩個版本的介面一致(都回傳 `Promise<img>`),所以預載的寫法完全不用改:

```js
// 預載所有素材,全部就緒才開始畫
const [bg, player] = await Promise.all([
  loadImage('bg.png'),
  loadImage('player.png'),
]);
startRenderLoop();
```

---

## 4.6 「可繪製的來源」不只圖片:video、canvas、ImageBitmap

`drawImage` 的第一個參數(`CanvasImageSource`)可以是很多東西,這開了很多大門:

| 來源型別 | 用途 |
|----------|------|
| `HTMLImageElement` | 一般圖片 |
| `HTMLCanvasElement` | **另一張 canvas**——離屏快取的核心(第 09 章) |
| `HTMLVideoElement` | **把影片當前幀畫上去**——影音處理(連結影音課) |
| `ImageBitmap` | 已解碼的點陣圖,可傳給 Worker(第 09 章) |
| `OffscreenCanvas` | 離屏畫布(第 09 章) |

### 把 `<video>` 逐幀畫到畫布(連結影音播放器課)

這是 Canvas 跟你 [影音播放器課](../video-player-course/README.md) 的接點:在渲染迴圈裡把 video 當前畫面畫上去,就能做濾鏡、加浮水印、做彈幕底圖、擷取截圖:

```js
const video = document.querySelector('video');
function drawFrame() {
  if (!video.paused && !video.ended) {
    ctx.drawImage(video, 0, 0, W, H);   // 把影片「當下這一幀」畫到畫布
    // 在這之後可以疊字幕、加濾鏡、做像素處理(第 05 章)...
  }
  requestAnimationFrame(drawFrame);
}
video.addEventListener('play', () => requestAnimationFrame(drawFrame));
```

> **心智模型**:`drawImage` 不在乎來源是「靜態圖、另一張畫布、還是影片的某一瞬間」,對它來說都是「一塊可取像素的矩形」。理解這點,你就能把 Canvas 當成「**所有視覺來源的混音台**」——影片 + 圖片 + 文字 + 自己畫的圖形,全疊在一起。`WebCodecs` 解出的視訊幀(影音課第 11 章)也是這樣畫的。

### `createImageBitmap`:給 Worker 用的解碼圖

```js
const bitmap = await createImageBitmap(blob);   // 非同步解碼成點陣
ctx.drawImage(bitmap, 0, 0);
// bitmap 可以用 postMessage「轉移(transfer)」給 Web Worker,不複製、零成本(第 09 章)
```

---

## 4.7 圖片縮放的平滑:`imageSmoothingEnabled`

把小圖放大時,瀏覽器預設會「插值平滑」(看起來糊但柔)。做**像素藝術 / 復古遊戲**時你反而要「硬邊、清楚的大像素」,就得關掉它:

```js
ctx.imageSmoothingEnabled = false;   // 關掉平滑 → 放大時是清晰的方塊像素
ctx.drawImage(pixelArt, 0, 0, 16, 16, 0, 0, 256, 256);   // drawImage(圖, 來源sx,sy,sw,sh, 目標dx,dy,dw,dh):取來源 16×16、放大貼成 256×256(放大 16 倍)
// imageSmoothingQuality = 'high' 則可在需要平滑時提高品質
```

---

## 4.8 綜合範例:畫一張使用者卡片

把本章的東西串起來——圓形頭像(用第 02 章的 `clip`)+ 標題 + 自動換行的內文:

```js
async function drawCard(ctx, x, y, avatarSrc, name, bio) {
  const avatar = await loadImage(avatarSrc);   // 4.5 預載

  ctx.save();
  ctx.translate(x, y);                          // 第 03 章:把座標系挪到卡片左上

  // 卡片底。roundRect 是較新 API(Safari 16+、2023 起才全瀏覽器普及),
  // 舊環境要自己用 arcTo/arc 拼圓角。注意畫路徑前先 beginPath(第 02 章紀律)。
  ctx.fillStyle = '#fff';
  ctx.strokeStyle = '#e0e0e0';
  ctx.beginPath();
  ctx.roundRect(0, 0, 300, 120, 12);            // roundRect(x, y, 寬, 高, 圓角半徑) → 300×120、圓角 12px
  ctx.fill();
  ctx.stroke();

  // 圓形頭像(clip,記得 save/restore 隔離裁切區——第 02 章紀律)
  ctx.save();
  ctx.beginPath();
  // arc(圓心x, 圓心y, 半徑, 起始角, 結束角[, 逆時針?]):角度單位是「弧度」
  //   0 = 3 點鐘方向;Math.PI*2 = 轉一整圈(360°)→ 畫出完整的圓
  //   (只畫半圓就 0 → Math.PI;90° = Math.PI/2,以此類推)
  ctx.arc(50, 60, 32, 0, Math.PI * 2);
  ctx.fillStyle = '#f0f0f0';                    // 先填底色當背景:頭像還沒載入或有透明區時不會「開天窗」
  ctx.fill();
  ctx.clip();                                   // 裁切區 = 上面那個圓;之後畫的東西只會出現在圓內
  ctx.drawImage(avatar, 18, 28, 64, 64);        // 方圖被裁成圓;透明處會露出上面的底色
  ctx.restore();

  // 標題
  ctx.fillStyle = '#222';
  ctx.font = 'bold 18px sans-serif';
  ctx.textBaseline = 'top';                     // 4.2:用左上對齊最直覺
  ctx.fillText(name, 100, 28);

  // 內文(自動換行,4.3)
  ctx.fillStyle = '#666';
  ctx.font = '13px sans-serif';
  wrapText(ctx, bio, 100, 54, 180, 18);

  ctx.restore();
}
```

這段用上了:`clip` 圓形頭像(02)、`translate` 定位(03)、`drawImage`(04.4)、預載(04.5)、`measureText` 換行(04.3)、`textBaseline`(04.2)、`save`/`restore` 紀律(02)。

---

## 4.9 本章小結與下一步

- **文字**:`fillText`/`strokeText`;`font` 要寫單位、網頁字型要等 `document.fonts.ready`;**`textBaseline` 預設 alphabetic 是位置錯亂的元兇**,UI 置中用 `middle` + `center`。
- **自動換行要自己做**:Canvas 不排版,用 `measureText` 逐詞累加實作 word wrap——又一個 immediate mode 的洞。
- **`drawImage` 三簽名**:原尺寸 / 縮放 / **九參數裁切**(精靈圖、影片幀的核心)。
- **圖片非同步**:必須 `onload` 或 `await img.decode()` 後才畫,否則靜默畫不出。
- **來源多樣**:image / canvas / **video** / ImageBitmap / OffscreenCanvas——Canvas 是所有視覺來源的混音台,接得上影音課與第 09 章。
- **`imageSmoothingEnabled`**:像素藝術要關掉平滑。

**下一章(05)**,我們進入第三種繪圖典範:**直接操作每一個像素**。你會學到 `getImageData` 拿到的 RGBA 陣列怎麼讀寫,做出灰階、反相、模糊、邊緣偵測這些濾鏡;也會理解一個第 00 章就埋下的真相——**`getImageData` 是 GPU→CPU 的回讀,很貴**,以及跨域圖片會「污染畫布」讓你讀不到像素(安全機制)。這章直接連到你的 [影像加密課](../image-encryption-course/07-canvas-rendering-and-hardening.md)。

> 💡 **動手作業**:做一個「迷因產生器」:載入一張底圖,在頂部和底部畫置中、帶黑色描邊的白色粗體字(`strokeText` 畫黑邊 + `fillText` 畫白字),且文字過長時自動縮小字級或換行。完成後你會對 `textAlign`/`textBaseline`/`measureText` 的配合非常有感。
