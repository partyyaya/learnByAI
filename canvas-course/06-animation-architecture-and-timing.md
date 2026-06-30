# 第 06 章:動畫架構與時間管理

> **學習目標**:兌現第 01 章的伏筆——**動畫要綁「時間」(delta-time)而不是「幀」**。掌握 update/render 分離、固定時間步長(物理模擬)、緩動(easing)與補間(tween)系統,並優雅處理「切到背景分頁回來時間暴衝」與動畫生命週期管理。
> **預計時數**:110 分鐘
> 第 01 章我們寫了第一個渲染迴圈,但留了一個坑:速度綁在幀上,120Hz 螢幕會跑兩倍快。這一章把動畫從「能動」升級到「**穩、順、可控**」——這是遊戲、資料視覺化過場、UI 微互動的共同地基。

---

## 6.1 回到第 01 章的坑:把速度綁在「幀」上是錯的

第 01 章的彈球這樣寫:

```js
ball.x += ball.vx;   // 每一幀移動 vx 像素
```

問題:`requestAnimationFrame` 的呼叫頻率**跟著螢幕刷新率**——60Hz 螢幕每秒呼叫 60 次,120Hz 螢幕每秒 120 次,而且當畫面變複雜掉幀時,頻率還會浮動。

```
60Hz 螢幕:每秒 60 幀 → 球每秒移動 60 × vx
120Hz 螢幕:每秒 120 幀 → 球每秒移動 120 × vx ← 整整快兩倍!
掉到 30fps 時 → 球每秒只移動 30 × vx ← 變慢
```

**同一份程式碼,在不同裝置上動畫速度不同、還會隨掉幀忽快忽慢。** 這是業餘和專業的分水嶺。

---

## 6.2 解法:Delta-time(基於時間,而非幀)

正確的觀念:**不要問「這一幀移動多少」,要問「距離上一幀過了多少時間,該移動多少」**。

`requestAnimationFrame` 的回呼會收到一個 `timestamp`(高精度毫秒,第 01 章提過)。算出兩幀之間的時間差 `dt`,用「速度 × 時間」算位移:

```js
let lastTime = 0;

function frame(now) {        // now:瀏覽器傳入的當前時間(毫秒)
  const dt = (now - lastTime) / 1000;   // 距上一幀過了幾「秒」
  lastTime = now;

  update(dt);              // 把 dt 傳進去,用時間算移動
  render();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

function update(dt) {
  // vx 現在的單位是「像素 / 秒」,不是「像素 / 幀」
  ball.x += ball.vx * dt;   // 移動量 = 速度 × 時間
  ball.y += ball.vy * dt;
}
```

現在 `vx = 120` 代表「**每秒移動 120 像素**」,不管螢幕是 60Hz 還 120Hz、不管有沒有掉幀,**一秒就是移動 120 像素**,完全一致。

> **心智模型**:幀率是「我多久畫一次」,跟「東西該多快」是兩回事。**物理世界用「秒」描述速度,渲染用「幀」呈現**——delta-time 就是這兩者之間的翻譯。把 `vx` 從「像素/幀」改成「像素/秒」,你的動畫就跟硬體解耦了。

---

## 6.3 `update` / `render` 分離

注意上面我把 `update(dt)`(更新狀態)和 `render()`(畫出來)分成兩個函式。這不只是整潔,而是一個重要的架構原則:

- **`update(dt)`**:只改「資料」(物件位置、速度、動畫進度),不碰畫布。這是「模擬世界往前走一步」。
- **`render()`**:只讀資料、畫到畫布,不改資料。這是「把世界拍一張照」。

> **心智模型**:呼應第 00 章——畫面上的東西不是物件,你維護的 JS 資料才是。`update` 推進「資料的世界」,`render` 把那個世界投影成像素。這個分離讓你之後可以:暫停(停止 update 但仍 render)、回放(記錄每幀的狀態)、把 render 換成 WebGL(第 10 章)而不動 update、測試 update 邏輯(不需要畫布)。第 08 章的場景圖會把這個分離推到極致。

---

## 6.4 固定時間步長(Fixed Timestep):物理模擬的必修

Delta-time 解決了「速度一致」,但若你做**物理模擬**(碰撞、彈跳、重力、堆疊),用浮動的 `dt` 會出問題:`dt` 忽大忽小會讓物理計算不穩定,大 `dt` 還會「穿牆」(一幀移動太多,直接跳過了牆)。

專業做法:**邏輯更新用固定的步長(例如每步 1/60 秒),用一個累加器(accumulator)把真實時間切成固定步**:

```js
let lastTime = 0;
let accumulator = 0;
const STEP = 1 / 60;          // 物理每步固定 1/60 秒

function frame(now) {
  let dt = (now - lastTime) / 1000;
  lastTime = now;
  dt = Math.min(dt, 0.25);    // 防暴衝(見 6.7),最多補 0.25 秒

  accumulator += dt;
  while (accumulator >= STEP) {  // 累積夠一個固定步就更新一次
    updatePhysics(STEP);         // 永遠用固定的 STEP,物理超穩定
    accumulator -= STEP;
  }

  render();                      // render 仍然每幀畫(可加內插讓更平滑)
  requestAnimationFrame(frame);
}
```

| 步長策略 | 優點 | 缺點 | 適合 |
|----------|------|------|------|
| 變動步長(`dt` 直接用) | 簡單 | 物理不穩、會穿牆 | UI 動畫、簡單移動 |
| 固定步長(accumulator) | 穩定、可重現 | 較複雜 | 物理、遊戲、需要確定性 |

> **心智模型**:固定步長把「現實時間」切成大小一致的積木,物理只認積木。一幀真實時間若很長,就連續走好幾個積木(`while` 迴圈),而不是走一大步——所以不會穿牆、計算穩定。**需要「可重現/確定性」(replay、網路同步、單元測試)的場景,固定步長是唯一解。**

---

## 6.5 緩動與補間:讓動畫「有生命」

機械式的等速移動(linear)很死板。真實世界的運動有加速減速——這就是**緩動(easing)**。一個 easing 函式把「線性進度 `t`(0→1)」映射成「實際進度」:

```js
const Easing = {
  linear:    t => t,
  easeInOut: t => t < 0.5 ? 2*t*t : 1 - Math.pow(-2*t + 2, 2) / 2,
  easeOut:   t => 1 - Math.pow(1 - t, 3),   // 快進慢出,UI 最常用
  easeIn:    t => t * t * t,
};
```

```
linear:   ●─────●─────●─────●   等速(死板)
easeOut:  ●───●──●─●●●          先快後慢(自然、UI 感)
```

### 一個通用的補間(Tween)系統

「補間」= 在 `duration` 時間內,把某個值從 `from` 平滑變到 `to`。這是 UI 動畫的核心:

```js
class Tween {
  constructor(from, to, duration, easing = Easing.easeOut) {
    this.from = from;
    this.to = to;
    this.duration = duration;   // 秒
    this.easing = easing;
    this.elapsed = 0;
    this.done = false;
  }
  update(dt) {
    this.elapsed += dt;
    let t = Math.min(this.elapsed / this.duration, 1);   // 線性進度 0→1
    if (t >= 1) this.done = true;
    const eased = this.easing(t);                        // 套 easing
    return this.from + (this.to - this.from) * eased;    // 內插出當前值
  }
}

// 用法:讓方塊在 0.4 秒內平滑滑到 x=500
const tween = new Tween(box.x, 500, 0.4);
function update(dt) {
  if (!tween.done) box.x = tween.update(dt);
}
```

> **心智模型**:補間 = 「**從 A 到 B,花 N 秒,用某種節奏**」。`t` 是線性時間進度(0→1),`easing(t)` 把它扭成有快慢的節奏,再 `from + (to-from)×eased` 內插出當下的值。所有 UI 微動畫(展開、滑入、淡出)都是這個公式。

---

## 6.6 基於物理的動畫(spring,簡介)

比 tween 更自然的是**彈簧(spring)動畫**——不用指定 duration,而是用物理(剛性、阻尼)讓值「彈」到目標,被打斷時也能平順接續(iOS、現代 UI 大量使用):

```js
// 簡化的彈簧:每幀朝目標加速,並施加阻尼
function springStep(state, target, dt, stiffness = 120, damping = 14) {
  const force = (target - state.value) * stiffness;
  state.velocity += force * dt;
  state.velocity *= Math.pow(0.5, dt * damping);   // 阻尼
  state.value += state.velocity * dt;
}
```

> tween 適合「明確的進場/退場」;spring 適合「跟手、可被打斷」的互動(拖曳放手後回彈)。先知道有這個選項,深入可參考 framer-motion / react-spring 的模型。

---

## 6.7 背景分頁與時間暴衝(必踩的坑)

第 01 章說過 `rAF` 在分頁切到背景時**自動暫停**——這是省電的好事,但回來時會出事:

```
你切去別的分頁 5 秒 → rAF 暫停 → 回來時:
   now - lastTime ≈ 5000ms → dt ≈ 5 秒!
   → ball.x += vx * 5 → 球瞬間飛到天邊 / 物理炸裂
```

解法:**夾住 `dt` 上限**,回來後最多補一小段時間,避免一幀暴衝:

```js
dt = Math.min(dt, 0.1);   // 任何超過 0.1 秒的間隔都當成 0.1 秒處理
```

> **上限要設多少?** 取捨是:設太小(如 0.05)→ 卡頓後追不上、動畫變慢;設太大 → 暴衝防不住。**一般動畫**用 **0.1 秒**左右就夠(本節);而 **6.4 的固定步長物理**因為會把 `dt` 切成多個固定小步逐一補上(不會一步穿牆),可以容忍較大的上限,所以那裡用 `0.25`。**兩處數字不同是用途不同,不是筆誤。**

> **記住**:任何用 `dt` 的動畫,**第一件事就是 clamp 它**。否則你的應用「切走再切回來就爆炸」,而且這種 bug 極難在開發時發現(你不會一直切分頁)。

---

## 6.8 動畫的生命週期:啟動、停止、避免重複迴圈

```js
let rafId = null;

function start() {
  if (rafId !== null) return;        // 防止重複啟動(常見 bug:多個迴圈疊在一起)
  lastTime = performance.now();      // 重設時間基準,避免第一幀 dt 暴衝
  rafId = requestAnimationFrame(frame);
}

function stop() {
  cancelAnimationFrame(rafId);       // 用 rafId 取消
  rafId = null;
}
```

兩個常見 bug:

1. **重複啟動**:多次呼叫 `start()` 沒擋,結果同時跑好幾個 `rAF` 迴圈,動畫變快、CPU 飆高。用 `rafId !== null` 守門。
2. **停了忘了重設時間基準**:停很久再 `start`,第一幀 `dt` 暴衝(同 6.7)。`start` 時重設 `lastTime`。

### 省電進階:不變就不畫(dirty flag)

不是每個應用都要每秒畫 60 次。如果畫面靜止(沒動畫、使用者沒操作),**根本不需要重畫**。用一個 `dirty` 旗標,只在有變化時才畫:

```js
let dirty = true;
function invalidate() { dirty = true; }   // 任何改變狀態的地方都呼叫它

function frame() {
  if (dirty) {
    render();
    dirty = false;
  }
  requestAnimationFrame(frame);   // 迴圈還在轉,但只在 dirty 時才真的畫
}
```

> 這是「**按需渲染(on-demand rendering)**」,白板、編輯器這類「大部分時間是靜止」的應用必用——能把待機時的 CPU/GPU 用量降到接近 0。第 09 章效能、第 11 章白板會用它。

---

## 6.9 綜合範例:點一下,方塊平滑飛到滑鼠位置

把 delta-time、tween、按需渲染串起來:

```js
const box = { x: 100, y: 100, size: 40 };
let tweenX = null, tweenY = null;

canvas.addEventListener('click', (e) => {
  const p = getCanvasPoint(canvas, e);          // 第 03 章
  tweenX = new Tween(box.x, p.x, 0.5, Easing.easeOut);
  tweenY = new Tween(box.y, p.y, 0.5, Easing.easeOut);
});

let lastTime = performance.now();
function frame(now) {
  let dt = Math.min((now - lastTime) / 1000, 0.1);   // delta-time + clamp
  lastTime = now;

  if (tweenX && !tweenX.done) box.x = tweenX.update(dt);
  if (tweenY && !tweenY.done) box.y = tweenY.update(dt);

  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#457b9d';
  ctx.fillRect(box.x - box.size/2, box.y - box.size/2, box.size, box.size);

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
```

點哪裡,方塊就用「先快後慢」的自然節奏滑過去。改 `Easing.easeOut` 成別的,立刻感受節奏差異。

---

## 6.10 本章小結與下一步

- **delta-time**:速度用「像素/秒」,移動量 = `速度 × dt`,動畫跟硬體刷新率解耦,不再忽快忽慢。
- **update/render 分離**:`update(dt)` 推進資料、`render()` 只畫;讓暫停、回放、測試、換渲染後端都變可能。
- **固定時間步長**:物理模擬用 accumulator 切成固定步,穩定、不穿牆、可重現。
- **easing + tween**:`from + (to-from) × easing(t)`,所有 UI 微動畫的公式;spring 適合跟手互動。
- **必踩的坑**:背景分頁回來 `dt` 暴衝 → **永遠 clamp `dt`**;防重複啟動;停止後重設時間基準。
- **按需渲染(dirty flag)**:靜止時不畫,省電——編輯器類應用必備。

**下一章(07)**,我們兌現第 00 章最重要的推論:**Canvas 沒有 click 事件,點到誰要自己算**。這就是**命中測定(hit testing)**——從滑鼠座標轉世界座標(第 03 章)、用數學判斷點在不在圖形內、`isPointInPath`、到「隱藏色彩緩衝」這種神技,最後做出可 hover、可選取、可拖曳的互動。這是把 Canvas 從「會動的圖」變成「可互動的應用」的關鍵一章。

> 💡 **動手作業**:做一個「煙火/粒子效果」:點一下在該位置生成 50 個粒子,每個有隨機速度、受重力影響(`vy += gravity * dt`)、透明度隨時間 ease 到 0 後消失。要求全部用 delta-time,並 clamp dt。完成後你會同時練到:delta-time、物理(重力)、生命週期管理、以及大量物件的 update/render——這也是第 09 章效能的前哨。
