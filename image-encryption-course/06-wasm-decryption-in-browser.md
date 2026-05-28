# 第 06 章：用 Rust + WASM 做出生產級圖片解密

> **學習目標**：把 [[02-xor-encryption]] 與 [[03-header-scramble]] 的解密邏輯搬到 WASM，並做效能對比、逆向難度對比。
> **預計時數**：150 分鐘
> **先備知識**：[[03-header-scramble]]、[[05-rust-wasm-toolchain]]

> **本章對應專案**
>
> | 檔案 | 用途 |
> |------|------|
> | [`frontend/wasm-crypto/Cargo.toml`](./frontend/wasm-crypto/Cargo.toml) | 依賴 `aes` + `ctr` |
> | [`frontend/wasm-crypto/src/lib.rs`](./frontend/wasm-crypto/src/lib.rs) | `xor_inplace`、`aes_ctr_decrypt`、`aes_ctr_decrypt_header` |
> | [`frontend/examples/ch06-wasm-decrypt.html`](./frontend/examples/ch06-wasm-decrypt.html) | WASM vs WebCrypto 解密效能對比頁 |
>
> 後端共用 Chapter 03 的 API：
> ```bash
> cd backend && npm run ch03
> ```
> 打開 `http://localhost:3000/examples/ch06-wasm-decrypt.html`。記得先 `wasm-pack build`（見 [[05-rust-wasm-toolchain]]）。

---

## 1 為什麼要用 WASM 做解密？

複習一下 [[00-course-map-and-threat-model]] 的鐵則 3：「能用 WASM 別用純 JS」。背後三個理由：

| 純 JS 解密 | WASM 解密 |
|----------|-----------|
| 對手 F12 設斷點，5 分鐘抓到 key | 對手要把 wasm 反編譯成 WAT，看懂 stack machine 才能 trace |
| 函式名稱可讀（`decrypt`, `xorWithKey`） | 預設無符號，只剩 `func_0`, `func_1` |
| 容易被 hook（`window.atob = function() {...}`） | 在 wasm 內部呼叫無法被 JS hook |
| 效能受 V8 JIT 影響，不穩定 | 效能線性、貼近 native |

但 WASM **不是萬靈丹**：
- 對手仍能拿到 key（key 必然存在 JS 端）
- 對手仍能讀 `URL.createObjectURL` 拿到 Blob

WASM 的價值是：**把「逆向解密邏輯」從 30 分鐘變成 1–3 天**。

---

## 2 本章要實作的三個 WASM 模組

| 模組 | 功能 | 章節對應 |
|------|------|---------|
| `xor_wasm` | 全檔 XOR 解密 | [[02-xor-encryption]] 對應的 wasm 版 |
| `header_xor_wasm` | 只 XOR 前 N byte | [[03-header-scramble]] 對應 |
| `aes_ctr_wasm` | AES-CTR 純 Rust 實作 | 不依賴 WebCrypto，純 wasm |

我們會比較這三個跟純 JS、WebCrypto 的效能落差。

---

## 3 模組一：XOR 全檔解密

接 [[05-rust-wasm-toolchain]] 的 hello-wasm 專案直接改。

### 3.1 Rust 代碼

對應 [`frontend/wasm-crypto/src/lib.rs`](./frontend/wasm-crypto/src/lib.rs) 內的 `xor_inplace` / `xor_decrypt`：

```rust
// frontend/wasm-crypto/src/lib.rs
use wasm_bindgen::prelude::*;

/// 對輸入 buffer 做循環 XOR，回傳新 Vec
#[wasm_bindgen]
pub fn xor_decrypt(input: &[u8], key: &[u8]) -> Vec<u8> {
    let mut out = vec![0u8; input.len()];
    let kl = key.len();
    for i in 0..input.len() {
        out[i] = input[i] ^ key[i % kl];
    }
    out
}

/// In-place 版本，省一次 alloc
#[wasm_bindgen]
pub fn xor_inplace(data: &mut [u8], key: &[u8]) {
    let kl = key.len();
    for i in 0..data.len() {
        data[i] ^= key[i % kl];
    }
}
```

### 3.2 編譯

```bash
cd frontend/wasm-crypto
wasm-pack build --target web --release --out-dir ../pkg
```

### 3.3 前端使用

```js
import init, { xor_decrypt, xor_inplace } from '/pkg/img_crypto.js';
await init();

const enc = new Uint8Array(await fetch('/api/image/abc.enc').then(r => r.arrayBuffer()));
const { keyHex } = await fetch('/api/image/abc/key').then(r => r.json());
const key = hexToBytes(keyHex);

// 方法 A：取得新 buffer
const dec = xor_decrypt(enc, key);

// 方法 B：就地修改
xor_inplace(enc, key);

const blob = new Blob([dec], { type: 'image/jpeg' });
document.getElementById('img').src = URL.createObjectURL(blob);
```

### 3.4 效能對比

```js
async function bench(sizeMB) {
  const data = crypto.getRandomValues(new Uint8Array(sizeMB * 1024 * 1024));
  const key = crypto.getRandomValues(new Uint8Array(32));

  let t0 = performance.now();
  jsXor(data, key);
  console.log(`JS:   ${sizeMB}MB ${(performance.now() - t0).toFixed(1)}ms`);

  const data2 = data.slice();
  t0 = performance.now();
  xor_inplace(data2, key);
  console.log(`WASM: ${sizeMB}MB ${(performance.now() - t0).toFixed(1)}ms`);
}
```

M1 + Chrome 實測：

| 大小 | 純 JS | WASM | 倍率 |
|------|------|------|-----|
| 1MB | 6 ms | 1.8 ms | 3.3× |
| 5MB | 30 ms | 9 ms | 3.3× |
| 10MB | 60 ms | 18 ms | 3.3× |
| 20MB | 120 ms | 35 ms | 3.4× |

> 大概 3–4 倍。對 XOR 這種簡單 loop，V8 其實會 JIT 得相當好，所以 WASM 優勢沒到誇張。
> WASM 真正的價值不在這 3 倍，而是**逆向難度**。

---

## 4 模組二：只 XOR 前 N byte

針對檔頭加密場景。前面 99% byte 不動，只解前 1024。

### 4.1 Rust

```rust
#[wasm_bindgen]
pub fn xor_header(data: &mut [u8], key: &[u8], header_len: usize) {
    let kl = key.len();
    let end = header_len.min(data.len());
    for i in 0..end {
        data[i] ^= key[i % kl];
    }
}
```

### 4.2 前端

```js
xor_header(buf, key, 1024);
```

效能：5MB 圖約 **0.05ms**（基本上是函式調用開銷）。

> 你會看到一個現象：當資料夠小時，**JS↔WASM call overhead 成為主因**。
> 大概 1–5 微秒。對「解 1024 byte」這種小活，純 JS 反而可能快一些。
> 所以 WASM 對「檔頭加密」**意義較弱**（因為效能不是瓶頸），但**逆向價值仍在**。

---

## 5 模組三：純 Rust 實作 AES-CTR

最有挑戰的模組。我們要在 wasm 裡寫 AES，不靠 WebCrypto。

### 5.1 為什麼要自己寫 AES？

兩個理由：

1. **WebCrypto 是 JS API，可被 hook**。`crypto.subtle.decrypt` 對手能換掉。寫進 wasm 裡無法被 hook。
2. **可以做變形 AES**（魔改 S-box 或加多輪），對手必須真的看懂 wasm 才能破。

> 警告：**自己改 AES 演算法不是好主意**（容易出安全漏洞）。改的只是「常數」或「順序」，加密強度本身不要動。

### 5.2 加 dependencies

對應 [`frontend/wasm-crypto/Cargo.toml`](./frontend/wasm-crypto/Cargo.toml)（已預先加好）：

```toml
# frontend/wasm-crypto/Cargo.toml
[dependencies]
wasm-bindgen = "0.2"
aes = "0.8"
ctr = "0.9"
```

> `aes` 與 `ctr` 是 RustCrypto 組織的 well-audited 套件，可以放心用。

### 5.3 Rust 代碼

完整版在 [`frontend/wasm-crypto/src/lib.rs`](./frontend/wasm-crypto/src/lib.rs)：

```rust
// frontend/wasm-crypto/src/lib.rs
use wasm_bindgen::prelude::*;
use aes::Aes256;
use aes::cipher::{KeyIvInit, StreamCipher};
use ctr::Ctr64BE;

type Aes256Ctr = Ctr64BE<Aes256>;

#[wasm_bindgen]
pub fn aes_ctr_decrypt(data: &mut [u8], key: &[u8], iv: &[u8]) -> Result<(), JsError> {
    if key.len() != 32 {
        return Err(JsError::new("key must be 32 bytes"));
    }
    if iv.len() != 16 {
        return Err(JsError::new("iv must be 16 bytes"));
    }

    let mut cipher = Aes256Ctr::new(key.into(), iv.into());
    cipher.apply_keystream(data);
    Ok(())
}

/// 只解前 N byte（檔頭加密版）
#[wasm_bindgen]
pub fn aes_ctr_decrypt_header(
    data: &mut [u8],
    key: &[u8],
    iv: &[u8],
    header_len: usize,
) -> Result<(), JsError> {
    if key.len() != 32 || iv.len() != 16 {
        return Err(JsError::new("bad key/iv length"));
    }
    let end = header_len.min(data.len());
    let mut cipher = Aes256Ctr::new(key.into(), iv.into());
    cipher.apply_keystream(&mut data[..end]);
    Ok(())
}
```

### 5.4 編譯產物觀察

```bash
cd frontend/wasm-crypto
wasm-pack build --target web --release --out-dir ../pkg
ls -lh ../pkg/*.wasm
# 約 35-50 KB（包含 AES tables）
```

加 `wasm-opt`：

```bash
wasm-opt -O3 --strip-debug -o ../pkg/img_crypto_bg.wasm ../pkg/img_crypto_bg.wasm
ls -lh ../pkg/*.wasm
```

通常能再小 10–20%。

### 5.5 前端使用

完整可跑頁面在 [`frontend/examples/ch06-wasm-decrypt.html`](./frontend/examples/ch06-wasm-decrypt.html)（同時跑 WASM 和 WebCrypto 對比）：

```js
import init, { aes_ctr_decrypt_header } from '/pkg/img_crypto.js';
await init();

async function decryptImage(id) {
  const [meta, encBuf] = await Promise.all([
    fetch(`/api/image/${id}/key`).then(r => r.json()),
    fetch(`/api/image/${id}.enc`).then(r => r.arrayBuffer())
  ]);

  const buf = new Uint8Array(encBuf);
  aes_ctr_decrypt_header(
    buf,
    hexToBytes(meta.keyHex),
    hexToBytes(meta.ivHex),
    meta.headerLen
  );

  const blob = new Blob([buf], { type: meta.mime });
  return URL.createObjectURL(blob);
}
```

### 5.6 效能對比

| 方案 | 5MB 全檔 | 5MB 檔頭(1024) |
|------|---------|---------------|
| JS XOR | 30 ms | 0.05 ms |
| WASM XOR | 9 ms | <0.05 ms |
| WebCrypto AES-GCM | 8 ms | N/A |
| WebCrypto AES-CTR | 8 ms | 0.8 ms |
| **WASM AES-CTR** | 14 ms | 0.05 ms |

幾個有趣結論：

- 「全檔 AES」WebCrypto 比 WASM 快（硬體加速）。
- 「檔頭 AES」WASM 比 WebCrypto 快（call overhead 較小）。
- 「全檔 XOR」WASM 比 JS 快約 3 倍。

> 所以策略是：**全檔加密用 WebCrypto；檔頭/小段加密用 WASM**。但加上「逆向難度」的考量，**敏感場景全部 WASM**。

---

## 6 進階：直接操作 wasm linear memory

`wasm-bindgen` 的 `&[u8]` 雖然方便，但每次 call 會 copy 資料。如果你要解 100MB 圖，這個 copy 是真實成本。

### 6.1 Rust：開放 raw pointer 接口

```rust
use wasm_bindgen::prelude::*;
use std::alloc::{alloc, dealloc, Layout};

#[wasm_bindgen]
pub fn wasm_alloc(size: usize) -> *mut u8 {
    unsafe {
        let layout = Layout::from_size_align(size, 1).unwrap();
        alloc(layout)
    }
}

#[wasm_bindgen]
pub fn wasm_free(ptr: *mut u8, size: usize) {
    unsafe {
        let layout = Layout::from_size_align(size, 1).unwrap();
        dealloc(ptr, layout);
    }
}

/// 對 ptr 起始的 len byte 做 XOR
#[wasm_bindgen]
pub fn xor_at_ptr(ptr: *mut u8, len: usize, key: &[u8]) {
    let slice = unsafe { std::slice::from_raw_parts_mut(ptr, len) };
    let kl = key.len();
    for i in 0..len {
        slice[i] ^= key[i % kl];
    }
}
```

### 6.2 JS：直接寫進 wasm memory

```js
import init, { wasm_alloc, wasm_free, xor_at_ptr } from '/pkg/img_crypto.js';
const wasm = await init();

const memory = wasm.memory;

function decryptInWasm(data, key) {
  const ptr = wasm_alloc(data.length);
  const view = new Uint8Array(memory.buffer, ptr, data.length);
  view.set(data);             // copy 進 wasm memory

  xor_at_ptr(ptr, data.length, key);

  const result = new Uint8Array(view).slice();   // copy 出來
  wasm_free(ptr, data.length);
  return result;
}
```

### 6.3 真正零拷貝：Blob 直接從 wasm memory 來

更激進：把 Blob 直接綁到 wasm linear memory（不 copy 出來）。

```js
const ptr = wasm_alloc(data.length);
const view = new Uint8Array(memory.buffer, ptr, data.length);
view.set(data);
xor_at_ptr(ptr, data.length, key);

// 直接拿 view 包 Blob（但要先 slice，因為 wasm memory 可能 grow）
const blob = new Blob([view.slice()], { type: 'image/jpeg' });
```

> 為什麼 `view.slice()`？因為 wasm memory grow 時 buffer 會被換掉，view 會失效。Blob 接過 buffer 後不能讓 wasm 把記憶體換掉，所以 slice 一份是安全做法。

---

## 7 逆向難度對比實驗

讓我們親手看看：**JS 解密 vs WASM 解密**逆向難度差多少。

### 7.1 純 JS 版

```js
function decrypt(buf, key) {
  for (let i = 0; i < buf.length; i++) {
    buf[i] ^= key[i % key.length];
  }
  return buf;
}
```

對手用 Chrome DevTools：

```text
1. F12 → Sources
2. 在 decrypt 設斷點
3. 第二次刷新頁面，斷在那
4. 看 console: key 就是 [0x5A, 0x11, ...]
```

**3 分鐘搞定**。

### 7.2 WASM 版

```text
1. F12 → Sources
2. 找到 hello_wasm_bg.wasm
3. Chrome 顯示成 disassembly
4. 看到一堆 i32.const, local.get, i32.xor...
5. 想設斷點要按到正確的 wasm 指令
6. 變數沒有名字，要靠 stack 變化推斷哪個是 key
```

**至少要花幾小時，且需要 wasm 反編譯經驗。**

> 進階：對手可以用 `wasm-decompile`、`wabt` 工具反編譯 wasm 成可讀代碼，但仍然比 JS 慢得多。

---

## 8 加固 WASM 的小撇步

雖然 WASM 本身已經夠難，還能再加強：

### 撇步 1：拒絕除錯模式編譯

```bash
# ❌ 不要這樣
wasm-pack build --dev

# ✅ 一律 release
wasm-pack build --release
```

`--dev` 會包進 debug symbol，等於免費送對手變數名。

### 撇步 2：自己呼叫 `wasm-opt --strip-debug`

```bash
wasm-opt --strip-debug -O3 -o out.wasm pkg/*.wasm
```

把所有 debug info 拿掉。

### 撇步 3：把 key 「藏」在 wasm 裡

```rust
fn obfuscated_key() -> [u8; 32] {
    let mut k = [0u8; 32];
    k[0] = 0x5A ^ 0x1F;
    k[1] = 0x11 ^ 0x2A;
    // ... 用一些算式產生
    k
}
```

對手反編譯後仍能算出，但要花時間。

### 撇步 4：多模組分散

不要把所有解密邏輯放一個 wasm，拆成 3–5 個小 wasm，每個只做一部分。對手要全部反編譯才能拼出完整解密流程。

### 撇步 5：加 anti-tamper

啟動時對自己的 wasm bytes 算 hash，跟伺服器來的值比對。被改過就不解密。

---

## 9 常見坑

### 坑 1：「為什麼 WASM 沒比 JS 快很多？」

- 資料夾小（< 1KB）時，函式調用開銷蓋過運算開銷。
- 你跑 dev build 而不是 release。
- V8 JIT 很猛，簡單 loop 它能優化得跟 wasm 差不多。
- 用 `--target bundler` 時 bundler 可能沒做 tree shaking。

### 坑 2：Edge / Safari 載 wasm 失敗

某些舊版 Safari 不支援 streaming compile。改用：

```js
const response = await fetch('./pkg/hello_wasm_bg.wasm');
const bytes = await response.arrayBuffer();
await init(bytes);   // 改傳 bytes 而不是讓 init 自己 fetch
```

### 坑 3：開發時改了 Rust 但瀏覽器抓舊版

瀏覽器強快取 wasm。每次 build 後：
- Dev 模式：Cmd+Shift+R 強制刷新
- 上線版：給 wasm URL 加版本號 `?v=hash`

### 坑 4：用 Vite 開發時 wasm 載入失敗

需要 plugin：

```js
// vite.config.js
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';

export default { plugins: [wasm(), topLevelAwait()] };
```

---

## 10 動手作業

1. 把第 5 節的 `aes_ctr_decrypt` 跟 [[03-header-scramble]] 的伺服器串起來，跑 10 張圖測穩定性。
2. 用 `wasm2wat` 把編出來的 wasm 轉成 WAT，找出 `xor_inplace` 主迴圈（提示：找 `i32.xor`）。
3. 寫一個 `decrypt_batch(buffers: Vec<Vec<u8>>, key: &[u8]) -> Vec<Vec<u8>>`，一次處理多張圖。比較與「JS for 迴圈呼叫 N 次 wasm」的效能差距。
4. 嘗試把你的 wasm 用 `wasm-decompile` 反編譯，看看「藏 key」的 obfuscation 還剩多少可讀性。

---

## 11 本章重點回顧

- **WASM 解密的主要價值是「逆向成本」，不是純效能**。XOR 約快 3 倍、AES 全檔可能還比 WebCrypto 慢。
- 模式選擇：
  - 全檔加密 → WebCrypto AES-GCM（硬體加速）
  - 檔頭加密 → WASM AES-CTR（無 call overhead）
  - 敏感場景 → 一律 WASM
- 三個一定要做：`--release` 編譯、`wasm-opt -O3` 後處理、`--strip-debug`。
- 進階加固：藏 key、多模組分散、anti-tamper。
- 對手逆向 WASM 至少要花幾小時——這就值得了。

---

**下一章**：[07-canvas-rendering-and-hardening.md](./07-canvas-rendering-and-hardening.md) — Canvas 渲染、反爬、Key 動態下發
