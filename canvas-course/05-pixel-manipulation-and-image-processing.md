# 第 05 章:像素級操作與影像處理

> **學習目標**:掌握第三種繪圖典範——**直接讀寫每一個像素**。理解 `ImageData` 的 RGBA 結構、寫出灰階/反相/亮度濾鏡、用**卷積核**做模糊與邊緣偵測,並認清第 00 章埋下的真相:**`getImageData` 是昂貴的 GPU→CPU 回讀**,以及跨域圖片「污染畫布」的安全機制。
> **預計時數**:110 分鐘
> 前面四章我們都在「下繪圖命令」(畫形狀、文字、圖片)。這一章我們繞過命令,**直接碰底層的像素**。這是濾鏡、影像處理、以及你 [影像加密課](../image-encryption-course/07-canvas-rendering-and-hardening.md) 的根基。

---

## 5.1 第三種繪圖典範:不下命令,直接改像素

回顧第 02 章說的三種繪圖典範,前兩種(路徑、矩形捷徑)都是「告訴 Canvas 畫什麼」。第三種完全不同:**Canvas 把畫布的像素陣列交給你,你直接讀、直接改、再交回去。**

```js
// 1. 取出一塊區域的像素(GPU→CPU 把資料搬下來)
const imageData = ctx.getImageData(0, 0, W, H);

// 2. 直接改 imageData.data 裡的數字(這是純 JS 陣列運算)
//    ...修改像素...

// 3. 把改完的寫回畫布(CPU→GPU 搬回去)
ctx.putImageData(imageData, 0, 0);
```

> **心智模型**:前面的繪圖像「**叫油漆工照圖施工**」;像素操作像「**你自己拿著放大鏡,一格一格調整顏料**」。最大彈性(任何演算法都能做),但也最貴(資料要在 GPU 和 CPU 之間搬,5.6 詳述)。

---

## 5.2 `ImageData` 的結構:一維 RGBA 陣列

`getImageData` 回傳的 `ImageData` 有三個東西:`width`、`height`、`data`。關鍵是 `data`:

- 它是一個 **`Uint8ClampedArray`**(8 位元、自動夾在 0~255 的整數陣列)。
- **每個像素佔 4 個格子:R、G、B、A**(紅、綠、藍、透明度,各 0~255)。
- 像素是**逐列(row-major)**排列的:先第 0 列由左到右,再第 1 列……

```
data = [ R,G,B,A,  R,G,B,A,  R,G,B,A, ... ]
        └像素(0,0)┘ └像素(1,0)┘ └像素(2,0)┘
```

### 座標 ↔ 索引的換算公式(務必記住)

要存取座標 `(x, y)` 的像素,它在 `data` 裡的起始索引是:

```js
const index = (y * width + x) * 4;
const r = data[index];
const g = data[index + 1];
const b = data[index + 2];
const a = data[index + 3];
```

> **心智模型**:`data` 是把二維的畫布「攤平成一條」的一維陣列。`y * width + x` 是「攤平後第幾個像素」,再 `× 4` 因為每像素 4 個數字。這個 `(y*width+x)*4` 公式,是所有像素操作的核心,寫到變肌肉記憶。

---

## 5.3 第一批濾鏡:灰階、反相、亮度

掌握公式後,濾鏡就是「遍歷每個像素、套一個數學」:

```js
const imageData = ctx.getImageData(0, 0, W, H);
const data = imageData.data;

for (let i = 0; i < data.length; i += 4) {   // 每次跳 4(一個像素)
  const r = data[i], g = data[i + 1], b = data[i + 2];

  // ── 灰階:用加權平均(人眼對綠最敏感)──
  const gray = 0.299 * r + 0.587 * g + 0.114 * b;
  data[i] = data[i + 1] = data[i + 2] = gray;

  // ── 反相(把上面註解掉,改用這個)──
  // data[i] = 255 - r; data[i+1] = 255 - g; data[i+2] = 255 - b;

  // ── 調亮 +40 ──
  // data[i] = r + 40; data[i+1] = g + 40; data[i+2] = b + 40;
  // (不用怕超過 255,Uint8ClampedArray 會自動夾住)

  // data[i + 3] 是 alpha,通常不動
}

ctx.putImageData(imageData, 0, 0);   // 寫回
```

> **重點**:`data` 是 `Uint8ClampedArray`,**算出來超過 255 自動變 255、低於 0 自動變 0**(clamp 的由來),所以調亮不用自己 `Math.min`。但這也意味著「過曝」的資訊會永久丟失。

---

## 5.4 `putImageData` 的特殊脾氣

`putImageData` **不是一般的繪圖命令**,它有兩個反直覺的行為,踩過的人都記得:

1. **它無視變換矩陣**:`translate`/`scale`/相機(第 03 章)對它**完全無效**。它的座標永遠是「畫布緩衝區的物理像素座標」。
2. **它無視 `globalAlpha`、合成模式、clip**:它是「直接覆蓋像素」,不跟既有內容混合。

```js
ctx.translate(100, 100);
ctx.putImageData(imageData, 0, 0);   // 還是畫在 (0,0),translate 沒用!
```

> **心智模型**:`drawImage` 是「**畫**一張圖」(尊重所有狀態);`putImageData` 是「**直接把記憶體蓋上去**」(繞過一切狀態)。需要混合、變換時,先 `putImageData` 到一張離屏 canvas,再用 `drawImage` 把它畫上來——這也是處理 HiDPI 下像素操作的標準做法(因為 `getImageData` 拿的是物理像素,跟你 `scale(dpr)` 後的邏輯座標對不上)。

---

## 5.5 卷積核(Convolution Kernel):模糊、銳化、邊緣偵測的通用框架

灰階、反相只看「單一像素」。但模糊、銳化、邊緣偵測要看「**這個像素和它鄰居的關係**」。這類運算有一個統一的數學框架:**卷積(convolution)**。

概念:對每個像素,拿它周圍 3×3(或更大)的鄰居,各自乘上一個權重(這組權重叫 **kernel / 核**),加總當作新值。

```
   kernel(3×3)            對每個像素:
   ┌────┬────┬────┐       新值 = Σ(鄰居像素 × 對應權重)
   │ w0 │ w1 │ w2 │
   ├────┼────┼────┤       不同的 kernel = 不同的濾鏡效果
   │ w3 │ w4 │ w5 │
   ├────┼────┼────┤
   │ w6 │ w7 │ w8 │
   └────┴────┴────┘
```

| Kernel | 效果 |
|--------|------|
| `[0,0,0, 0,1,0, 0,0,0]` | 原圖(中心 1,其餘 0) |
| 全部 `1/9` | 均值模糊 |
| `[0,-1,0, -1,5,-1, 0,-1,0]` | 銳化 |
| `[-1,-1,-1, -1,8,-1, -1,-1,-1]` | 邊緣偵測 |

```js
function convolve(ctx, W, H, kernel) {
  const src = ctx.getImageData(0, 0, W, H);
  const dst = ctx.createImageData(W, H);
  const s = src.data, d = dst.data;
  const side = Math.sqrt(kernel.length);     // 3(代表 3×3)
  const half = (side / 2) | 0;

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let r = 0, g = 0, b = 0;
      // 掃過 kernel 涵蓋的鄰居
      for (let ky = 0; ky < side; ky++) {
        for (let kx = 0; kx < side; kx++) {
          const px = Math.min(W - 1, Math.max(0, x + kx - half));   // 邊界夾住
          const py = Math.min(H - 1, Math.max(0, y + ky - half));
          const si = (py * W + px) * 4;
          const wt = kernel[ky * side + kx];
          r += s[si] * wt; g += s[si + 1] * wt; b += s[si + 2] * wt;
        }
      }
      const di = (y * W + x) * 4;
      d[di] = r; d[di + 1] = g; d[di + 2] = b; d[di + 3] = s[di + 3];
    }
  }
  ctx.putImageData(dst, 0, 0);
}

// 邊緣偵測
convolve(ctx, W, H, [-1,-1,-1, -1,8,-1, -1,-1,-1]);
```

> ⚠️ **兩個卷積的隱含契約,沒注意會以為程式壞了**:
> ① 上面的 `convolve` 沒做正規化,所以 **kernel 權重總和要自己先湊成 1**(均值模糊就是每格 `1/9`,**不能**傳整數 `1`,否則整張過曝變白)。要更通用就加一個 `divisor` 參數,把累加結果除以權重總和。
> ② 邊緣偵測核(權重和=0)算出的值多半是負或接近 0,寫進 `Uint8ClampedArray` 被夾成黑——所以**正確結果就是「黑底、只有邊緣發亮」**,不是「白底黑線稿」。要白底黑線,得再加一個 `offset`(bias,例如結果 +128)或對結果取絕對值。

> **心智模型**:卷積就是「**每個像素抄一點鄰居的值**」。抄法(kernel)決定效果——抄平均→模糊;放大跟鄰居的差異→銳化/找邊緣。這正是 CNN(卷積神經網路)裡「卷積」的同一個概念,做完這章你會對 [Browser AI 課](../browserAI/README.md) 的卷積更有感。

---

## 5.6 效能真相:`getImageData` 很貴(呼應第 00 章)

第 00 章我們破除過「Canvas 2D 是純 CPU 所以慢」的迷思,並說真正的瓶頸往往是**像素回讀**。現在解釋為什麼:

```
畫布內容平常住在 GPU 的記憶體裡(快、適合合成)
   ↓ getImageData
把那塊像素從 GPU「搬下來」到 CPU 的 JS 陣列 ← 這個搬運很慢,還會強制 GPU 同步
   ↓ 你用 JS 一個一個改(JS 迴圈本身也慢)
   ↓ putImageData
再把資料從 CPU「搬回」GPU
```

每一次 `getImageData`/`putImageData` 都是一次 GPU↔CPU 來回,而且會打斷 GPU 的非同步管線。**在動畫迴圈裡每幀做全畫面像素操作,是掉幀的頭號元兇。**

優化原則:

1. **`willReadFrequently` 提示**:若你會頻繁讀像素,建立 context 時提示瀏覽器把畫布放在 CPU 端,省掉來回搬運:
   ```js
   const ctx = canvas.getContext('2d', { willReadFrequently: true });
   ```
2. **減少回讀次數**:一次取一大塊、批次處理,不要在迴圈裡一格一格 `getImageData`(那是災難)。
3. **只取需要的區域**:`getImageData(x, y, smallW, smallH)` 而不是整張。
4. **能不碰像素就別碰**:很多效果(模糊、亮度、對比)可以用下一節的 `ctx.filter` 在 GPU 上做,完全不用回讀。

---

## 5.7 替代方案:`ctx.filter`(GPU 跑,不用回讀)

很多常見濾鏡,瀏覽器提供了 **CSS filter 語法**,直接在繪圖時套用,**在 GPU 上跑、不需要 `getImageData`**:

```js
ctx.filter = 'blur(4px)';                    // 高斯模糊(比自己卷積快太多)
ctx.drawImage(img, 0, 0);

ctx.filter = 'grayscale(100%) contrast(1.2)';// 可串接多個
ctx.drawImage(img, 0, 0);

ctx.filter = 'none';                         // 用完還原(狀態機!第 02 章)
```

> **決策原則**:**能用 `ctx.filter` 達成的效果(模糊、灰階、亮度、對比、色相旋轉…),就別自己 `getImageData` 卷積**——前者 GPU 跑、零回讀、快得多。只有當你需要 `ctx.filter` 做不到的**自訂演算法**(影像加密的逐像素 XOR、特殊的邊緣演算法、讀取某點顏色做命中測定)時,才動用 `getImageData`。

---

## 5.8 兩個一定要知道的限制:跨域污染與精度

### 跨域圖片會「污染畫布」(tainted canvas)

如果你 `drawImage` 了一張**跨域(別的網域)且沒設 CORS** 的圖片,然後想 `getImageData`——瀏覽器會**直接拋錯**:

```
SecurityError: The canvas has been tainted by cross-origin data.
```

這是**安全機制**:防止惡意網站把你登入後才看得到的跨域圖片(例如你的私人相片)畫到畫布、再讀出像素偷走。畫布一旦「被污染」,就**永久禁止讀像素**(`getImageData`、`toDataURL`、`toBlob` 全部失效)。

解法:圖片伺服器要回傳允許跨域的標頭,且你載入時要宣告:

```js
const img = new Image();
img.crossOrigin = 'anonymous';   // 宣告要用 CORS 方式載入
img.src = 'https://other-domain.com/pic.jpg';
// 且對方伺服器必須回 Access-Control-Allow-Origin
```

> 這個機制跟你 [影像加密課](../image-encryption-course/07-canvas-rendering-and-hardening.md) 的威脅模型直接相關:Canvas 的像素讀取能力強大,瀏覽器才用「同源 + CORS」嚴格把關。把影片畫到畫布再 `getImageData`(第 04 章)也受同樣限制——跨域影片同樣會污染畫布。

### 精度:`Uint8ClampedArray` 是 8 位元整數

每個通道只有 0~255 共 256 階。多次疊加運算(連續調亮再調暗)會累積**捨入誤差**,且過曝/死黑的資訊不可逆。需要高精度影像處理時,得自己用 `Float32Array` 在中間運算、最後才量化回 0~255。

---

## 5.9 綜合範例:即時調整亮度的滑桿

把像素操作接到 UI,做一個即時濾鏡。注意這裡刻意用 `willReadFrequently` + 從原圖重算(而不是反覆在已處理的結果上疊加,以免累積誤差):

```js
const ctx = canvas.getContext('2d', { willReadFrequently: true });
let original;   // 暫存原圖像素,每次都從它重算

img.decode().then(() => {
  ctx.drawImage(img, 0, 0, W, H);
  original = ctx.getImageData(0, 0, W, H);   // 只取一次原圖
});

slider.addEventListener('input', () => {
  const delta = Number(slider.value);                 // -100 ~ 100
  const out = ctx.createImageData(W, H);
  const src = original.data, dst = out.data;
  for (let i = 0; i < src.length; i += 4) {
    dst[i]     = src[i]     + delta;   // clamp 自動處理溢位
    dst[i + 1] = src[i + 1] + delta;
    dst[i + 2] = src[i + 2] + delta;
    dst[i + 3] = src[i + 3];           // alpha 不動
  }
  ctx.putImageData(out, 0, 0);
});
```

> **設計重點**:**永遠從「原圖」重算,不要在「上一次的結果」上疊加**——否則拉滑桿時誤差會越積越大、影像越來越爛。這是即時濾鏡的通用紀律(Photoshop 的「調整圖層」也是這個道理:原圖不動,效果是疊加的描述)。

---

## 5.10 把畫布存成圖片:`toDataURL` / `toBlob`

像素能讀出來,自然也能把整張畫布「輸出成圖檔」——這是「存圖、下載、上傳縮圖」的基礎,也是第 11 章白板「匯出 PNG」的作法。

```js
// 1. toDataURL:同步,回傳 base64 的 data: URL(小圖、要塞進 <img>/localStorage 時方便)
const url = canvas.toDataURL('image/png');        // 也可 'image/jpeg', 0.8(第二參數是品質)
img.src = url;

// 2. toBlob:非同步,回傳 Blob(大圖首選——不佔記憶體、可直接下載/上傳)
canvas.toBlob((blob) => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'canvas.png';
  a.click();
  URL.revokeObjectURL(a.href);                     // 用完釋放,別漏記憶體
}, 'image/png');
```

| 方法 | 回傳 | 適合 |
|------|------|------|
| `toDataURL(type, quality)` | 同步、base64 字串(`data:` URL) | 小圖、要當字串存 / 塞 `src` |
| `toBlob(cb, type, quality)` | 非同步、`Blob` | 大圖、下載、上傳(省記憶體) |
| `OffscreenCanvas.convertToBlob()` | `Promise<Blob>`(Worker 內用) | 背景執行緒匯出(第 09 章) |

> ⚠️ **三個坑**:① **匯出的是緩衝區的物理像素**——HiDPI 下你會得到 `CSS尺寸 × dpr` 的大圖(通常是好事,更清晰);要固定輸出尺寸就另開一張指定大小的離屏 canvas 重畫再匯出。② **被污染的畫布(5.8 的跨域圖片)會讓 `toDataURL`/`toBlob` 直接拋 `SecurityError`**——跟 `getImageData` 是同一道安全閘。③ `toDataURL` 的 base64 對大圖又慢又佔記憶體(字串膨脹約 1.33 倍),大圖一律用 `toBlob`。

---

## 5.11 本章小結與下一步

- **第三種典範**:`getImageData` → 改 `data` → `putImageData`,直接讀寫像素。
- **`ImageData` 結構**:`Uint8ClampedArray`,每像素 RGBA 4 格,逐列排列;核心公式 **`(y*width+x)*4`**;超界自動 clamp 到 0~255。
- **`putImageData` 的脾氣**:無視變換、透明、clip——它是「直接蓋記憶體」,不是繪圖命令。
- **卷積核**:模糊/銳化/邊緣偵測的通用框架,本質是「每個像素抄一點鄰居」,跟 CNN 同源。
- **效能真相**:`getImageData` 是昂貴的 GPU→CPU 回讀;用 `willReadFrequently`、減少回讀、能用 **`ctx.filter`(GPU)就別自己卷積**。
- **兩大限制**:跨域圖片**污染畫布**(安全機制,連結影像加密課)、8 位元精度誤差。
- **匯出**:`toBlob`(大圖首選)/ `toDataURL`(小圖、字串);匯出的是物理像素,且受同一道跨域安全閘限制。

**下一章(06)**,我們回到第 01 章埋下的伏筆:**動畫不該綁在「幀」上,該綁在「時間」上**。你會學到 delta-time、固定時間步長、緩動(easing)與補間(tween),讓動畫在 60Hz 和 120Hz 螢幕上一樣快、一樣順,並優雅地處理「切到背景分頁」的時間暴衝問題。

> 💡 **動手作業**:做一個「綠幕去背」效果:載入一張綠幕前景圖,遍歷像素,把「綠色成分明顯高於紅藍」的像素 alpha 設為 0(變透明),再用 `drawImage` 疊到另一張背景上。完成後你會親手體會:**透明度(alpha 通道)也是像素的一部分,而合成就是在玩 alpha**——這也呼應第 02 章的 `globalCompositeOperation`。
