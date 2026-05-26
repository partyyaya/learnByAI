# 第 04 章：播放器狀態機與外掛架構

> **學習目標**：用狀態機重構播放器，建立事件總線與外掛系統，能像 video.js 一樣擴充功能。
> **預計時數**：120 分鐘
> **先備知識**：[[03-custom-player-ui]]

---

## 1 為什麼需要狀態機？

寫到第 03 章，你應該感覺到一個問題：UI 邏輯越加越多，事件處理散落各處：

```js
// 散亂的判斷
if (video.paused && !video.ended && video.buffered.length > 0) { ... }
if (waitingStart && !video.error) { ... }
if (video.readyState >= 3 && !video.paused) { ... }
```

這種寫法的問題：
- 條件爆炸
- 競態（waiting 後緊接 error 的情況）
- 難以加新功能

**狀態機讓你把「現在處於什麼狀態」變成第一公民。**

---

## 2 播放器的狀態圖

一個播放器至少有這些狀態：

```text
                  ┌────────┐
                  │  idle  │ ← 還沒設 src
                  └────┬───┘
                       │ load()
                       ↓
                ┌─────────────┐
                │   loading   │ ← 下載 metadata 中
                └──────┬──────┘
              error    │  loadedmetadata
                 ↓     ↓
              ┌──────┴──────┐
              │             ↓
        ┌─────┴───┐   ┌──────────┐
        │  error  │   │  ready   │ ← 可以播
        └─────────┘   └─────┬────┘
                            │ play()
                            ↓
                      ┌──────────┐  ←──┐
              ┌───────┤ playing  ├─────┤
              │       └─────┬────┘     │
              │             │ waiting  │ playing
              │             ↓          │
              │       ┌──────────┐     │
              │ pause │ buffering├─────┘
              │       └──────────┘
              ↓
          ┌────────┐
          │ paused │
          └────┬───┘
               │ play()
               ↑
               ↓
          ┌────────┐
          │ ended  │
          └────────┘
```

對應到 HTML5 事件：

| 狀態 | 觸發進入的事件 |
|------|----------------|
| idle | (初始) |
| loading | `loadstart` |
| ready | `canplay` |
| playing | `playing` |
| buffering | `waiting` |
| paused | `pause` |
| ended | `ended` |
| error | `error` |

---

## 3 簡易狀態機實作

不需要引入 XState，自己寫 30 行就夠用：

```js
class StateMachine {
  constructor(initial, transitions) {
    this.state = initial;
    this.transitions = transitions;   // { [from]: { [event]: to } }
    this.listeners = new Set();
  }

  can(event) {
    return !!this.transitions[this.state]?.[event];
  }

  send(event, payload) {
    const next = this.transitions[this.state]?.[event];
    if (!next) {
      console.warn(`Invalid transition: ${this.state} -[${event}]-> ?`);
      return false;
    }
    const prev = this.state;
    this.state = next;
    this.emit({ prev, next, event, payload });
    return true;
  }

  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(info)   { this.listeners.forEach(fn => fn(info)); }
}
```

### 套用到播放器

```js
const playerSM = new StateMachine('idle', {
  idle:      { LOAD: 'loading' },
  loading:   { READY: 'ready', ERROR: 'error' },
  ready:     { PLAY: 'playing', ERROR: 'error' },
  playing:   { PAUSE: 'paused', WAIT: 'buffering', END: 'ended', ERROR: 'error' },
  buffering: { PLAY: 'playing', PAUSE: 'paused', ERROR: 'error' },
  paused:    { PLAY: 'playing', LOAD: 'loading', ERROR: 'error' },
  ended:     { PLAY: 'playing', LOAD: 'loading' },
  error:     { LOAD: 'loading' },
});

// 把 HTML5 事件對應到狀態機 event
video.addEventListener('loadstart',       () => playerSM.send('LOAD'));
video.addEventListener('canplay',         () => playerSM.send('READY'));
video.addEventListener('playing',         () => playerSM.send('PLAY'));
video.addEventListener('pause',           () => playerSM.send('PAUSE'));
video.addEventListener('waiting',         () => playerSM.send('WAIT'));
video.addEventListener('ended',           () => playerSM.send('END'));
video.addEventListener('error',           () => playerSM.send('ERROR'));

// UI 監聽狀態變化
playerSM.onChange(({ prev, next }) => {
  console.log(`狀態: ${prev} → ${next}`);
  document.body.dataset.playerState = next;
});
```

### 用 CSS 對應狀態

```css
[data-player-state="loading"]   .controls { opacity: 0.3; }
[data-player-state="buffering"] .spinner  { display: block; }
[data-player-state="error"]     .error-overlay { display: flex; }
[data-player-state="ended"]     .replay-button { display: block; }
```

> 狀態驅動 UI，省掉一堆 if-else。

---

## 4 事件總線（Event Bus）

播放器內各模組互相通訊不要用直接 reference，而是用事件總線：

```js
class EventBus {
  constructor() { this.events = new Map(); }

  on(name, fn) {
    if (!this.events.has(name)) this.events.set(name, new Set());
    this.events.get(name).add(fn);
    return () => this.off(name, fn);
  }

  off(name, fn) {
    this.events.get(name)?.delete(fn);
  }

  once(name, fn) {
    const off = this.on(name, (...args) => { off(); fn(...args); });
    return off;
  }

  emit(name, ...args) {
    this.events.get(name)?.forEach(fn => {
      try { fn(...args); }
      catch (e) { console.error(`EventBus error in "${name}":`, e); }
    });
  }
}
```

### 用法

```js
const bus = new EventBus();

bus.on('player:ready',       () => console.log('準備好了'));
bus.on('player:qualitychange', (q) => console.log('切換解析度', q));

bus.emit('player:ready');
bus.emit('player:qualitychange', { width: 1280, height: 720 });
```

---

## 5 Player Core：把狀態機 + 事件總線整合

```js
class PlayerCore extends EventBus {
  constructor(container, options = {}) {
    super();
    this.container = container;
    this.video = container.querySelector('video');
    this.options = options;
    this.plugins = new Map();

    this.sm = this.createStateMachine();
    this.bindVideoEvents();
  }

  createStateMachine() {
    const sm = new StateMachine('idle', {
      idle:      { LOAD: 'loading' },
      loading:   { READY: 'ready', ERROR: 'error' },
      ready:     { PLAY: 'playing', ERROR: 'error' },
      playing:   { PAUSE: 'paused', WAIT: 'buffering', END: 'ended', ERROR: 'error' },
      buffering: { PLAY: 'playing', PAUSE: 'paused', ERROR: 'error' },
      paused:    { PLAY: 'playing', LOAD: 'loading', ERROR: 'error' },
      ended:     { PLAY: 'playing', LOAD: 'loading' },
      error:     { LOAD: 'loading' },
    });
    sm.onChange((info) => this.emit('statechange', info));
    return sm;
  }

  bindVideoEvents() {
    const v = this.video;
    const map = {
      loadstart: 'LOAD',
      canplay: 'READY',
      playing: 'PLAY',
      pause: 'PAUSE',
      waiting: 'WAIT',
      ended: 'END',
      error: 'ERROR',
    };
    for (const [evt, smEvt] of Object.entries(map)) {
      v.addEventListener(evt, () => this.sm.send(smEvt));
    }
    // 同時轉發原始事件給 plugin
    ['play','pause','playing','waiting','seeking','seeked','timeupdate','volumechange','ended','error']
      .forEach((e) => v.addEventListener(e, (ev) => this.emit(e, ev)));
  }

  // 公開 API
  play()          { return this.video.play(); }
  pause()         { return this.video.pause(); }
  seek(time)      { this.video.currentTime = time; }
  setVolume(v)    { this.video.volume = v; }
  setRate(r)      { this.video.playbackRate = r; }
  get state()     { return this.sm.state; }
  get duration()  { return this.video.duration; }
  get currentTime(){ return this.video.currentTime; }

  // 外掛系統
  use(plugin, options) {
    const instance = plugin(this, options);
    this.plugins.set(plugin.pluginName || plugin.name, instance);
    return this;
  }
}
```

---

## 6 外掛系統（Plugin）

外掛就是一個 `function (player, options)`，可以監聽事件、操控播放器、注入 UI。

### 6.1 範例：埋點外掛

```js
function analyticsPlugin(player, options = {}) {
  const { endpoint, sessionId } = options;
  const stats = {
    playStart: 0,
    totalPlayTime: 0,
    bufferingCount: 0,
    bufferingTotalMs: 0,
    bufferingStart: 0,
  };

  player.on('playing', () => {
    if (stats.bufferingStart) {
      stats.bufferingTotalMs += Date.now() - stats.bufferingStart;
      stats.bufferingStart = 0;
    }
    if (!stats.playStart) stats.playStart = Date.now();
  });

  player.on('waiting', () => {
    stats.bufferingCount++;
    stats.bufferingStart = Date.now();
  });

  player.on('error', () => {
    sendReport({ type: 'error', code: player.video.error?.code });
  });

  // 每 30 秒上報一次
  setInterval(() => sendReport({ type: 'stats', ...stats }), 30_000);

  // 頁面離開時上報
  window.addEventListener('beforeunload', () => sendReport({ type: 'final', ...stats }));

  function sendReport(payload) {
    navigator.sendBeacon(endpoint,
      JSON.stringify({ sessionId, ts: Date.now(), ...payload }));
  }

  return { stats };
}
analyticsPlugin.pluginName = 'analytics';
```

### 6.2 範例：彈幕外掛

```js
function danmakuPlugin(player, options = {}) {
  const canvas = document.createElement('canvas');
  canvas.className = 'danmaku-layer';
  canvas.style.cssText = 'position:absolute;inset:0;pointer-events:none';
  player.container.appendChild(canvas);
  const ctx = canvas.getContext('2d');

  const bullets = [];   // 飛行中的彈幕
  const queue = [];     // 待出場的彈幕（按時間排序）

  function resize() {
    canvas.width = canvas.clientWidth;
    canvas.height = canvas.clientHeight;
  }
  resize();
  window.addEventListener('resize', resize);

  function add(text, time, color = '#fff') {
    queue.push({ text, time, color });
    queue.sort((a, b) => a.time - b.time);
  }

  function spawn(item) {
    bullets.push({
      ...item,
      x: canvas.width,
      y: Math.random() * (canvas.height * 0.7) + 20,
      speed: 2 + Math.random() * 2,
    });
  }

  function loop() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const t = player.currentTime;

    // 出場
    while (queue.length && queue[0].time <= t) spawn(queue.shift());

    // 移動 & 繪製
    for (let i = bullets.length - 1; i >= 0; i--) {
      const b = bullets[i];
      b.x -= b.speed;
      if (b.x < -200) { bullets.splice(i, 1); continue; }
      ctx.font = '20px sans-serif';
      ctx.fillStyle = b.color;
      ctx.strokeStyle = 'rgba(0,0,0,.8)';
      ctx.lineWidth = 3;
      ctx.strokeText(b.text, b.x, b.y);
      ctx.fillText(b.text, b.x, b.y);
    }

    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);

  player.on('seeking', () => bullets.length = 0);

  return { add };
}
danmakuPlugin.pluginName = 'danmaku';
```

### 6.3 使用

```js
const player = new PlayerCore(document.querySelector('.player'));

player
  .use(analyticsPlugin, { endpoint: '/api/log', sessionId: 'abc123' })
  .use(danmakuPlugin);

const danmaku = player.plugins.get('danmaku');
danmaku.add('歡迎光臨', 1);
danmaku.add('好棒喔', 3, '#ff0');
danmaku.add('666', 5, '#0ff');

player.play();
```

---

## 7 外掛 API 設計原則

寫 plugin 時遵守這幾條：

1. **只透過 player 公開 API 操作，不直接碰內部變數**
2. **回傳一個 destroy 函式**讓播放器銷毀時清理
3. **不要依賴其他 plugin 的存在**（除非明確聲明依賴）
4. **配置都靠 options 傳入，不要寫死**

更嚴謹的版本：

```js
function myPlugin(player, options) {
  const subs = [];

  subs.push(player.on('playing', onPlay));
  subs.push(player.on('pause', onPause));

  function onPlay() { /* ... */ }
  function onPause() { /* ... */ }

  return {
    destroy() {
      subs.forEach(unsub => unsub());
    },
    publicMethod() { /* ... */ },
  };
}
```

---

## 8 模組通訊範例：UI ↔ Core ↔ Plugin

```text
[ Click ⚙ 按鈕 ]
       ↓
[ UI 元件 emit 'settings:openrequest' ]
       ↓
[ Core EventBus 廣播 ]
       ↓
[ Settings Plugin 監聽，打開選單 ]
       ↓
[ 使用者選了 "1080p" ]
       ↓
[ Plugin emit 'quality:change', 1080 ]
       ↓
[ HLS Plugin 監聽，切換 SourceBuffer ]
       ↓
[ State Machine 觸發 'WAIT' → buffering ]
       ↓
[ UI 顯示 loading spinner ]
```

整個流程沒有任何模組直接呼叫對方的方法，全靠事件。

---

## 9 進階：狀態機加 Guard 與 Action

更接近 XState 的設計：

```js
class FSM {
  constructor(config) {
    this.config = config;
    this.state = config.initial;
    this.context = config.context || {};
    this.listeners = new Set();
  }

  send(event, payload) {
    const stateNode = this.config.states[this.state];
    const transitions = stateNode.on?.[event];
    if (!transitions) return false;

    const list = Array.isArray(transitions) ? transitions : [transitions];
    for (const t of list) {
      if (t.guard && !t.guard(this.context, payload)) continue;
      const next = t.target;
      const prev = this.state;
      this.state = next;
      if (t.actions) {
        for (const action of t.actions) action(this.context, payload);
      }
      this.listeners.forEach(fn => fn({ prev, next, event, payload }));
      return true;
    }
    return false;
  }

  onChange(fn) { this.listeners.add(fn); }
}
```

```js
const sm = new FSM({
  initial: 'idle',
  context: { retries: 0 },
  states: {
    idle: { on: { LOAD: { target: 'loading' } } },
    loading: {
      on: {
        READY: { target: 'ready' },
        ERROR: [
          {
            target: 'loading',
            guard: (ctx) => ctx.retries < 3,
            actions: [(ctx) => ctx.retries++],
          },
          { target: 'error' },
        ],
      },
    },
    ready:   { /* ... */ },
    error:   { /* ... */ },
  },
});
```

這個版本實作了「自動重試三次後再進入 error 狀態」。

---

## 10 與 React / Vue 的整合

把 PlayerCore 包成 framework 元件：

### React 版

```jsx
import { useEffect, useRef, useState } from 'react';

export function VideoPlayer({ src, plugins = [], onStateChange }) {
  const containerRef = useRef(null);
  const playerRef = useRef(null);
  const [state, setState] = useState('idle');

  useEffect(() => {
    const player = new PlayerCore(containerRef.current);
    plugins.forEach(([p, opts]) => player.use(p, opts));
    player.on('statechange', ({ next }) => {
      setState(next);
      onStateChange?.(next);
    });
    player.video.src = src;
    playerRef.current = player;

    return () => player.destroy();
  }, []);

  // src 變更
  useEffect(() => {
    if (playerRef.current) {
      playerRef.current.video.src = src;
      playerRef.current.video.load();
    }
  }, [src]);

  return (
    <div ref={containerRef} className="player" data-state={state}>
      <video />
      {/* ... 控制列 JSX ... */}
    </div>
  );
}
```

### Vue 3 版（Composition API）

```vue
<script setup>
import { ref, onMounted, onUnmounted, watch } from 'vue';

const props = defineProps({ src: String, plugins: Array });
const emit = defineEmits(['state-change']);

const containerRef = ref(null);
const state = ref('idle');
let player;

onMounted(() => {
  player = new PlayerCore(containerRef.value);
  props.plugins?.forEach(([p, opts]) => player.use(p, opts));
  player.on('statechange', ({ next }) => {
    state.value = next;
    emit('state-change', next);
  });
  player.video.src = props.src;
});

watch(() => props.src, (src) => {
  player.video.src = src;
  player.video.load();
});

onUnmounted(() => player?.destroy());
</script>

<template>
  <div ref="containerRef" class="player" :data-state="state">
    <video />
  </div>
</template>
```

---

## 11 本章重點回顧

- 狀態機把「播放器在做什麼」變成第一公民，UI 用 `data-state` 對應 CSS 就好。
- 事件總線解耦各模組，UI、Plugin、Core 互不依賴。
- 外掛系統用「function (player, options)」這種最樸素的設計就很好用。
- 透過 PlayerCore 抽象，後續換成 HLS / DASH / WebRTC 都不用動 UI。

---

## 12 課後練習

1. 把 [第 03 章](./03-custom-player-ui.md) 的 mini-player 重構為基於 PlayerCore 的架構，UI 用 `data-state` 控制。
2. 寫一個「快捷鍵」外掛，把第 03 章的鍵盤處理抽離成 plugin。
3. 寫一個「廣告」外掛：影片開始前播 5 秒廣告（用第二個 video element），結束後恢復主影片。

---

**上一章**：[[03-custom-player-ui]] ｜ **下一章**：[05-http-range-and-cdn.md](./05-http-range-and-cdn.md)
