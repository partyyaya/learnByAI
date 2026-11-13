# 第 06 章：用 Rust + WASM 做圖片解密

> **學習目標**：把 [第 02 章](./02-xor-encryption.md) 與 [第 03 章](./03-header-scramble.md) 的解密邏輯搬到 WASM，實測效能，並看清楚 WASM 能拉高哪些逆向成本、擋不住哪些。
> **預計時數**：150 分鐘
> **先備知識**：[第 03 章](./03-header-scramble.md)、[第 05 章](./05-rust-wasm-toolchain.md)

> **本章對應專案**
>
> | 檔案 | 用途 |
> |------|------|
> | [`frontend/wasm-crypto/Cargo.toml`](./frontend/wasm-crypto/Cargo.toml) | 依賴 `aes` + `ctr` |
> | [`frontend/wasm-crypto/src/lib.rs`](./frontend/wasm-crypto/src/lib.rs) | 本章所有 Rust 函式：XOR、AES-CTR、直接操作 linear memory |
> | [`frontend/examples/ch06-wasm-decrypt.html`](./frontend/examples/ch06-wasm-decrypt.html) | WASM vs WebCrypto 解密效能對比頁 |
>
> 後端共用 Chapter 03 的 API：
> ```bash
> cd backend && npm run ch03
> ```
> 打開 `http://localhost:3000/examples/ch06-wasm-decrypt.html`。記得先 `wasm-pack build`（見 [第 05 章](./05-rust-wasm-toolchain.md)）。

---

## 1 為什麼要用 WASM 做解密？

複習一下 [第 00 章](./00-course-map-and-threat-model.md) 的鐵則 3：WASM 藏得住「怎麼解」，藏不住「交給它的 key」。先把兩邊的差別列清楚：

| 純 JS 解密 | WASM 解密 |
|----------|-----------|
| 對手設斷點，幾分鐘就看懂演算法 | 要讀 wasm 指令才看得懂演算法 |
| 函式、變數名稱可讀（除非另外混淆） | release build 的內部函式沒有名稱；但 **export 名稱**（`aes_ctr_decrypt`）和 wasm-pack 產生的 **JS 膠水程式**一定可讀 |
| 每個函式都能被 hook | wasm 內部互相呼叫無法從 JS hook；但 **JS 呼叫 wasm 的那一下**（傳 key 進去、拿明文出來）一樣能 hook |
| 效能受 JIT 影響 | 效能穩定，但用不到 CPU 的 AES 硬體指令 |

WASM **不是萬靈丹**。到目前為止的設計（第 03 章的 API + 本章的 wasm）有三個洞：

1. **key 以明文 JSON 回傳**：對手在 Network 面板點開 `/key` 的回應，`keyHex`、`ivHex`、`headerLen` 全都看得到。
2. **演算法是標準的 AES-CTR**：有了 key 和 IV，對手用任何語言的 AES 函式庫都能解，不需要看懂 wasm（第 7 節示範）。
3. **`aes_ctr_decrypt` 是公開的 export**：對手甚至可以直接呼叫它。

也就是說：**key 以明文經過 JS 時，WASM 擋不住任何人。**
WASM 的價值要等到「key 不以明文出現在 JS」的設計（第 8 節）才發揮出來，那時對手才真的得去讀 wasm 指令。就算做到了，最後交給 `createImageBitmap` 的明文圖片仍然攔得到（[第 07 章](./07-canvas-rendering-and-hardening.md)）。

本章先把解密搬進 WASM、量清楚效能，再回頭看逆向成本。

---

## 2 本章要用到的函式

全部寫在同一個 crate：[`frontend/wasm-crypto/src/lib.rs`](./frontend/wasm-crypto/src/lib.rs)。

| 函式 | 功能 | 章節對應 |
|------|------|---------|
| `xor_inplace` / `xor_decrypt` | 全檔 XOR 解密 | [第 02 章](./02-xor-encryption.md) 的 wasm 版 |
| `xor_header` | 只 XOR 前 N byte | [第 03 章](./03-header-scramble.md) 作業的 XOR 版 |
| `aes_ctr_decrypt` / `aes_ctr_decrypt_header` | AES-CTR，純 Rust 實作，不依賴 WebCrypto | [第 03 章](./03-header-scramble.md) 的 wasm 版 |
| `wasm_alloc` / `wasm_free` / `xor_at_ptr` | 直接操作 wasm linear memory | 第 6 節 |

我們會比較這些跟純 JS、WebCrypto 的效能落差。

---

## 3 模組一：XOR 全檔解密

接 [第 05 章](./05-rust-wasm-toolchain.md) 的 hello-wasm 專案直接改。

### 3.1 Rust 程式碼

對應 [`frontend/wasm-crypto/src/lib.rs`](./frontend/wasm-crypto/src/lib.rs) 內的 `xor_inplace` / `xor_decrypt`：

```rust
// 摘自 frontend/wasm-crypto/src/lib.rs
use wasm_bindgen::prelude::*;

/// 就地修改，省一次配置
#[wasm_bindgen]
pub fn xor_inplace(data: &mut [u8], key: &[u8]) {
    let kl = key.len();
    if kl == 0 { return; }          // 沒有這行的話，空 key 會在 i % 0 時 panic
    for i in 0..data.len() {
        data[i] ^= key[i % kl];
    }
}

/// 回傳新的 Vec，不動原資料
#[wasm_bindgen]
pub fn xor_decrypt(input: &[u8], key: &[u8]) -> Vec<u8> {
    let mut out = vec![0u8; input.len()];
    let kl = key.len();
    if kl == 0 { return out; }
    for i in 0..input.len() {
        out[i] = input[i] ^ key[i % kl];
    }
    out
}
```

### 3.2 編譯

```bash
cd frontend/wasm-crypto
wasm-pack build --target web --release --out-dir ../pkg
```

### 3.3 前端使用（接第 02 章的 API）

```js
import init, { xor_decrypt, xor_inplace } from '/pkg/img_crypto.js';
await init();

const enc = new Uint8Array(await fetch('/api/image/abc.enc').then(r => r.arrayBuffer()));
const { keyHex, mime } = await fetch('/api/image/abc/key', {
  headers: { Authorization: 'Bearer dummy-token' },
}).then(r => r.json());
const key = hexToBytes(keyHex);

// 方法 A：回傳新的陣列，enc 不動
const dec = xor_decrypt(enc, key);

// 方法 B：就地修改 enc，省一次配置（跟方法 A 二選一）
// xor_inplace(enc, key);
// const dec = enc;

const blob = new Blob([dec], { type: mime });
document.getElementById('img').src = URL.createObjectURL(blob);
```

### 3.4 效能對比

```js
async function bench(sizeMB) {
  const data = randomBytes(sizeMB * 1024 * 1024);   // 第 02 章的分段版 randomBytes
  const key = randomBytes(32);

  let t0 = performance.now();
  jsXor(data, key);
  console.log(`JS:   ${sizeMB}MB ${(performance.now() - t0).toFixed(1)}ms`);

  const data2 = data.slice();
  t0 = performance.now();
  xor_inplace(data2, key);
  console.log(`WASM: ${sizeMB}MB ${(performance.now() - t0).toFixed(1)}ms`);
}
```

Apple M2 + Edge 157 實測（取中位數）：

| 大小 | 純 JS（第 02 章 `i % kLen` 寫法） | 純 JS（一次 4 byte） | WASM `xor_inplace`（含進出複製） |
|------|------|------|------|
| 1MB | 1.7 ms | 0.3 ms | 0.7 ms |
| 5MB | 9.3 ms | 1.5 ms | 3.5 ms |
| 10MB | 17 ms | 2.9 ms | 6.7 ms |
| 20MB | 36 ms | 6.0 ms | 13.6 ms |

> WASM 比第 02 章的 JS 寫法快約 2.7 倍，但輸給「一次處理 4 byte」的 JS。兩邊的瓶頸其實一樣：`i % kl` 讓每個 byte 都做一次除法。
> 複製資料的成本反而不大：5MB 資料已經在 wasm 記憶體裡時，純運算約 3.3 ms，複製只占 0.2 ms 左右。
> 所以 WASM 在這裡的價值不在這幾倍速度，而是第 1 節談的逆向成本。

---

## 4 模組二：只 XOR 前 N byte

針對檔頭加密場景：只解前面一小段，其餘 byte 不動。

### 4.1 Rust

```rust
// 摘自 frontend/wasm-crypto/src/lib.rs
#[wasm_bindgen]
pub fn xor_header(data: &mut [u8], key: &[u8], header_len: usize) {
    let kl = key.len();
    if kl == 0 { return; }
    let end = header_len.min(data.len());
    for i in 0..end {
        data[i] ^= key[i % kl];
    }
}
```

### 4.2 前端：只把要處理的那一段傳進去

```js
// ❌ 傳整個檔案：wasm-bindgen 會把 5MB 全部複製進 wasm、解完再複製回來
xor_header(buf, key, headerLen);

// ✅ 只傳檔頭那一段：只複製 headerLen byte，結果一樣會寫回 buf
xor_header(buf.subarray(0, headerLen), key, headerLen);
```

M2 + Edge 157，5MB 檔案、檔頭約 1.7KB：

| 寫法 | 耗時 |
|------|------|
| 傳整個檔案 | ~0.26 ms |
| 只傳 `subarray` | ~0.003 ms |
| 純 JS 迴圈 | ~0.03 ms |

> wasm-bindgen 處理 `&mut [u8]` 的方式是：把你傳的整個 `Uint8Array` 複製進 wasm 記憶體，函式結束後再複製回同一個 `Uint8Array`。
> 傳 `subarray` 時，它只複製那一段，寫回時也寫進原本的 buffer——所以結果完全一樣，成本差了將近 100 倍。

---

## 5 模組三：純 Rust 實作 AES-CTR

我們要在 wasm 裡跑 AES，不靠 WebCrypto。

### 5.1 為什麼要在 WASM 裡跑 AES？

常聽到兩個理由，各有前提：

1. **「WebCrypto 是 JS API，可被 hook」**：沒錯，`crypto.subtle.decrypt` 可以被換掉，key 和明文都攔得到。但 wasm 的 export 一樣是從 JS 呼叫的，hook 那個呼叫也能攔到同樣的東西。搬進 wasm 真正擋掉的，是「在演算法中間設斷點」。
2. **「可以做變形 AES」**（換 S-box、加輪數），讓對手不能直接套用標準 AES 函式庫。代價有兩個：
   - 改過的演算法沒有經過任何安全分析，可能比原版弱很多。
   - 後端也得用同一個變形演算法加密，不能再用 Node 的 `crypto`。

   如果目的只是「別讓對手直接套用標準函式庫」，更穩的做法是**演算法不動，把 key 的取得方式藏進 wasm**（第 8 節）。

另外要有心理準備：純軟體 AES 用不到 CPU 的 AES 硬體指令，**全檔解密比 WebCrypto 慢約 20 倍**（5.6 節）。

### 5.2 加 dependencies

對應 [`frontend/wasm-crypto/Cargo.toml`](./frontend/wasm-crypto/Cargo.toml)（已預先加好）：

```toml
# frontend/wasm-crypto/Cargo.toml
[dependencies]
wasm-bindgen = "0.2"
aes = "0.8"
ctr = "0.9"
```

> `aes` 與 `ctr` 是 RustCrypto 組織維護、使用廣泛的套件，不需要自己實作 AES。

### 5.3 Rust 程式碼

```rust
// 摘自 frontend/wasm-crypto/src/lib.rs
use wasm_bindgen::prelude::*;
use aes::Aes256;
use aes::cipher::{KeyIvInit, StreamCipher};
use ctr::Ctr128BE;

// Node 的 aes-256-ctr 把整個 16 byte IV 當 128 bit 計數器遞增，
// 這裡用 Ctr128BE 才會跟後端完全一致（Ctr64BE 只遞增低 64 bit）
type Aes256Ctr = Ctr128BE<Aes256>;

/// 傳入哪段就解哪段。檔頭加密時，前端傳 buf.subarray(0, headerLen)
#[wasm_bindgen]
pub fn aes_ctr_decrypt(data: &mut [u8], key: &[u8], iv: &[u8]) -> Result<(), JsError> {
    check_key_iv(key, iv)?;
    let mut cipher = Aes256Ctr::new(key.into(), iv.into());
    cipher.apply_keystream(data);
    Ok(())
}

/// 傳入整個檔案、只解前 header_len byte（用來對比複製成本）
#[wasm_bindgen]
pub fn aes_ctr_decrypt_header(
    data: &mut [u8],
    key: &[u8],
    iv: &[u8],
    header_len: usize,
) -> Result<(), JsError> {
    check_key_iv(key, iv)?;
    let end = header_len.min(data.len());
    let mut cipher = Aes256Ctr::new(key.into(), iv.into());
    cipher.apply_keystream(&mut data[..end]);
    Ok(())
}

fn check_key_iv(key: &[u8], iv: &[u8]) -> Result<(), JsError> {
    if key.len() != 32 {
        return Err(JsError::new("key must be 32 bytes"));
    }
    if iv.len() != 16 {
        return Err(JsError::new("iv must be 16 bytes"));
    }
    Ok(())
}
```

`key.into()` 會把 `&[u8]` 轉成固定長度的陣列參考，長度不對會 panic，所以先用 `check_key_iv` 擋掉，讓 JS 端收到的是一般的 `Error`（`key must be 32 bytes`）。

### 5.4 編譯產物觀察

```bash
cd frontend/wasm-crypto
wasm-pack build --target web --release --out-dir ../pkg
ls -lh ../pkg/*.wasm
# 約 32KB（opt-level = 3）
```

`aes` crate 在 wasm 上用的是不查表的純軟體實作（fixslicing），所以檔案不大。
`wasm-pack build --release` 已經自動跑過 `wasm-opt`，不需要再手動處理。

### 5.5 前端使用

完整可跑頁面在 [`frontend/examples/ch06-wasm-decrypt.html`](./frontend/examples/ch06-wasm-decrypt.html)（同時跑 WASM 和 WebCrypto 對比）：

```js
import init, { aes_ctr_decrypt } from '/pkg/img_crypto.js';
await init();

async function decryptImage(id) {
  const [meta, encBuf] = await Promise.all([
    fetch(`/api/image/${id}/key`).then(r => r.json()),
    fetch(`/api/image/${id}.enc`).then(r => r.arrayBuffer())
  ]);

  const buf = new Uint8Array(encBuf);
  aes_ctr_decrypt(
    buf.subarray(0, meta.headerLen),   // 只傳檔頭那一段
    hexToBytes(meta.keyHex),
    hexToBytes(meta.ivHex)
  );

  const blob = new Blob([buf], { type: meta.mime });
  return URL.createObjectURL(blob);
}
```

### 5.6 效能對比

M2 + Edge 157，5MB 檔案：

| 方案 | 5MB 全檔 | 檔頭（約 1.7KB） |
|------|---------|---------------|
| JS XOR（第 02 章寫法） | 9.3 ms | 0.03 ms |
| WASM XOR | 3.5 ms | 0.003 ms（只傳 subarray） |
| WebCrypto AES-GCM | 2.6 ms | — |
| WebCrypto AES-CTR | 2.6 ms | 0.005 ms（含 importKey） |
| **WASM AES-CTR** | 54 ms | 0.02 ms（只傳 subarray）／0.31 ms（傳整個檔案） |

幾個結論：

- 「全檔 AES」WebCrypto 比 WASM 快約 20 倍：一邊有 CPU 的 AES 硬體指令，一邊是純軟體。
- 「檔頭 AES」兩邊都在微秒級，使用者感覺不出差別；但 WASM 一定要只傳 subarray。
- 「全檔 XOR」WASM 比第 02 章的 JS 快，但輸給一次處理 4 byte 的 JS。

> 所以效能上，**能用 WebCrypto 就用 WebCrypto**。選 WASM 的理由不是效能，而是逆向成本——而那又取決於 key 怎麼交給它（第 7、8 節）。
> 這也是第 03 章「只加密檔頭」在 WASM 方案裡特別划算的原因：全檔要 54 ms，檔頭只要 0.02 ms。

---

## 6 進階：直接操作 wasm linear memory

`wasm-bindgen` 的 `&[u8]` 很方便，但每次呼叫都會複製資料。如果要反覆處理同一塊大資料，可以自己在 wasm 記憶體裡配置空間、直接寫進去。

### 6.1 Rust：開放指標介面

```rust
// 摘自 frontend/wasm-crypto/src/lib.rs
#[wasm_bindgen]
pub fn wasm_alloc(size: usize) -> *mut u8 {
    let mut buf = Vec::<u8>::with_capacity(size.max(1));
    let ptr = buf.as_mut_ptr();
    std::mem::forget(buf);   // 交給 JS 管理，之後用 wasm_free 歸還
    ptr
}

#[wasm_bindgen]
pub fn wasm_free(ptr: *mut u8, size: usize) {
    unsafe { drop(Vec::from_raw_parts(ptr, 0, size.max(1))) };
}

/// 對 ptr 起始的 len byte 做 XOR。key 也用指標傳入（同樣先 wasm_alloc 再寫進去）：
/// 這個函式本身不配置記憶體，JS 端先建好的 view 不會因為 memory grow 而失效。
#[wasm_bindgen]
pub fn xor_at_ptr(ptr: *mut u8, len: usize, key_ptr: *const u8, key_len: usize) {
    if key_len == 0 { return; }
    let data = unsafe { std::slice::from_raw_parts_mut(ptr, len) };
    let key = unsafe { std::slice::from_raw_parts(key_ptr, key_len) };
    for i in 0..len {
        data[i] ^= key[i % key_len];
    }
}
```

### 6.2 JS：直接寫進 wasm memory

```js
import init, { wasm_alloc, wasm_free, xor_at_ptr } from '/pkg/img_crypto.js';
const wasm = await init();   // init() 回傳 wasm 的 exports，裡面有 memory

function decryptInWasm(data, key) {
  // 先把需要的空間全部配置好，再建立 view
  const ptr = wasm_alloc(data.length);
  const keyPtr = wasm_alloc(key.length);

  new Uint8Array(wasm.memory.buffer, ptr, data.length).set(data);     // 複製進去
  new Uint8Array(wasm.memory.buffer, keyPtr, key.length).set(key);

  xor_at_ptr(ptr, data.length, keyPtr, key.length);

  // 每次都重新用 wasm.memory.buffer 建 view，不要沿用舊的
  const result = new Uint8Array(wasm.memory.buffer, ptr, data.length).slice();   // 複製出來
  wasm_free(ptr, data.length);
  wasm_free(keyPtr, key.length);
  return result;
}
```

> **view 為什麼會失效**：wasm 的記憶體不夠時會 grow，grow 之後 `wasm.memory.buffer` 會換成一個新的 ArrayBuffer，舊的 buffer 被「detach」，建在上面的 `Uint8Array` 長度變成 0。
> 任何可能配置記憶體的呼叫（例如 `wasm_alloc`，或任何參數是 `&[u8]` 的 wasm-bindgen 函式，它們內部會 malloc）之後，都要重新建 view。

### 6.3 能不能做到零拷貝？

明文最後要包成 Blob 交給瀏覽器解碼，而 **`new Blob()` 建立時一定會把內容複製一份**（Blob 是不可變的快照）。所以從 wasm 記憶體到 Blob，最少複製一次——那一次就是 `new Blob()` 本身，不需要先 `slice()`：

```js
const ptr = wasm_alloc(data.length);
new Uint8Array(wasm.memory.buffer, ptr, data.length).set(data);
xor_at_ptr(ptr, data.length, keyPtr, key.length);

// Blob 建立時就複製了內容，之後立刻釋放 wasm 記憶體也不影響它
const blob = new Blob([new Uint8Array(wasm.memory.buffer, ptr, data.length)], { type: 'image/jpeg' });
wasm_free(ptr, data.length);
```

---

## 7 逆向難度對比實驗

讓我們親手看看，從對手的角度，**JS 解密 vs WASM 解密**到底差多少。

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
3. 重新整理頁面，停在斷點
4. 看 console：key 就是 [0x5A, 0x11, ...]
```

**3 分鐘搞定**。其實連斷點都不用設：key 就在 Network 面板 `/key` 的回應裡。

### 7.2 本章目前的 WASM 版

```text
1. F12 → Network → 點 /api/image/xxx/key → 回應裡就有 keyHex、ivHex、headerLen
2. 另存 /api/image/xxx.enc
3. 用任何語言的 AES-CTR 解前 headerLen byte（演算法是標準的）
```

```python
import json
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

meta = json.load(open('x.json'))          # 從 Network 面板複製下來的 /key 回應
key, iv, n = bytes.fromhex(meta['keyHex']), bytes.fromhex(meta['ivHex']), meta['headerLen']

enc = open('x.enc', 'rb').read()          # 從 Network 面板另存的 .enc
dec = Cipher(algorithms.AES(key), modes.CTR(iv)).decryptor()
open('x.jpg', 'wb').write(dec.update(enc[:n]) + enc[n:])
```

**跟純 JS 版一樣幾分鐘搞定**，WASM 完全沒派上用場。

### 7.3 key 不以明文經過 JS 的版本（第 8 節撇步 3）

```text
1. F12 → Network：/key 回應裡只有包裝過的 key（一串看不懂的 byte）
2. 要知道怎麼解包，得去讀 wasm：找到解包的函式、看懂它從哪裡拿解包用的秘密
3. Chrome DevTools 能在 wasm 裡設斷點、看記憶體，但函式和變數沒有名字，要靠指令推斷
```

**這時才需要花上幾小時，還要有 wasm 逆向經驗。**

> 對手也可以用 `wasm-decompile`（wabt）把 wasm 轉成類 C 的虛擬碼，會快很多，但仍比讀 JS 費工。
> 不過，這仍然擋不住在 `Blob` / `createImageBitmap` 那一側攔明文的人（[第 07 章](./07-canvas-rendering-and-hardening.md)）。

---

## 8 加固 WASM 的小撇步

### 撇步 1：一律 release build

```bash
# ❌ 不要這樣上線
wasm-pack build --dev

# ✅ 一律 release
wasm-pack build --release
```

`--dev` 會把函式名稱（name section）包進去。實測本課程的 img-crypto：dev build 257KB，Rust 函式名稱一覽無遺；release build 32KB，沒有任何函式名稱。

### 撇步 2：上線前檢查產物

```js
// 在 Node 或瀏覽器 console 檢查 .wasm 有沒有 name section
const m = new WebAssembly.Module(bytes);
WebAssembly.Module.customSections(m, 'name').length;   // 0 才對
WebAssembly.Module.exports(m).map(e => e.name);        // 這些名字對手一定看得到，取名時要有心理準備
```

### 撇步 3：不要讓 key 以明文經過 JS

這是讓 WASM 真正有用的關鍵。概念上：

- 伺服器不回傳 `keyHex`，而是回傳 `wrappedKey = AES-GCM(imgKey, transportKey)`。
- `transportKey` 由 wasm 內部算出，例如把編譯時嵌進 wasm 的秘密，跟這次請求的 nonce 一起做 HKDF。
- wasm 匯出的函式改成「收密文和 wrappedKey、吐出圖片」：解包和解密都在 wasm 裡完成，JS 從頭到尾只看得到包裝過的 key。

```rust
// 示意：本課程專案沒有實作這一版，留作第 08 章的延伸
const EMBEDDED_SECRET: [u8; 32] = [/* build 時由腳本產生，每個版本不同 */];

#[wasm_bindgen]
pub fn decrypt_image(data: &mut [u8], wrapped_key: &[u8], nonce: &[u8], iv: &[u8]) -> Result<(), JsError> {
    let transport_key = hkdf_sha256(&EMBEDDED_SECRET, nonce, b"img-transport");
    let img_key = aes_gcm_unwrap(&transport_key, wrapped_key)?;
    let mut cipher = Aes256Ctr::new(img_key.as_slice().into(), iv.into());
    cipher.apply_keystream(data);
    Ok(())
}
```

要誠實面對它的極限：嵌在 wasm 裡的秘密終究在使用者手上，有心的對手能把它挖出來。它的作用是把「打開 Network 面板」變成「逆向 wasm」；每次發新版時換掉秘密，對手就得重來一次。這就是本課程一直在說的「提高成本」。

> 反例：把**每張圖的 key** 直接寫死在 wasm 裡。那等於 [第 00 章](./00-course-map-and-threat-model.md) 鐵則 1 說的「key 寫死在前端」，挖出來一次，所有圖片永久失守。

### 撇步 4：多模組分散

不要把所有解密邏輯放一個 wasm，拆成 3–5 個小 wasm，每個只做一部分。對手要全部看懂才能拼出完整流程。
但要注意：串起各模組的是 JS，串接處傳來傳去的資料一樣能被 hook。

### 撇步 5：加 anti-tamper

啟動時對 wasm 的 bytes 算雜湊，跟伺服器給的值比對，被改過就不解密。
wasm 讀不到自己的 bytes，雜湊要在 JS 端 fetch 下來後算；而這段檢查程式本身也在對手手上，可以一起被改掉。它擋的是現成的 patch 工具，不是有心人。

---

## 9 常見坑

### 坑 1：「為什麼 WASM 沒比 JS 快很多？」

- 資料很小（< 1KB）時，函式呼叫的開銷蓋過運算本身。
- 參數是 `&[u8]` 時整個陣列都會被複製：只需要處理一段，就傳 `subarray`。
- 你跑 dev build 而不是 release。
- Rust 迴圈寫成 `i % key_len`，每個 byte 都做一次除法；JS 端用同樣寫法也一樣慢。
- V8 JIT 很猛，簡單 loop 它能優化得跟 wasm 差不多。

### 坑 2：伺服器沒設 `application/wasm`

`init()` 預設用 `WebAssembly.instantiateStreaming` 載入，它要求伺服器回應的 Content-Type 是 `application/wasm`。
不是的話，wasm-bindgen 產生的程式會自動退回較慢的 `WebAssembly.instantiate`，並在 console 印警告。想自己控制載入時，先 fetch 成 bytes 再交給 `init`：

```js
const bytes = await fetch('./pkg/img_crypto_bg.wasm').then(r => r.arrayBuffer());
await init({ module_or_path: bytes });   // 新版 wasm-bindgen 要用物件參數；直接傳 bytes 會出現 deprecated 警告
```

### 坑 3：開發時改了 Rust 但瀏覽器抓舊版

瀏覽器強快取 wasm。每次 build 後：
- Dev 模式：Cmd+Shift+R 強制刷新
- 上線版：給 wasm URL 加版本號 `?v=hash`

### 坑 4：用 Vite 開發時 wasm 載入失敗

用 `--target web` 編譯時，Vite 不需要額外 plugin：`init()` 會用 `new URL('img_crypto_bg.wasm', import.meta.url)` 自己載入。
用 `--target bundler` 時才需要：

```js
// vite.config.js
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';

export default { plugins: [wasm(), topLevelAwait()] };
```

---

## 10 動手作業

1. 把第 5 節的 `aes_ctr_decrypt` 跟 [第 03 章](./03-header-scramble.md) 的伺服器串起來，跑 10 張圖測穩定性。
2. 用 `wasm2wat` 把編出來的 wasm 轉成 WAT，找出 `xor_inplace` 的主迴圈（提示：release build 沒有函式名稱，先從 `(export "xor_inplace" (func N))` 找到函式編號，再找 `i32.xor`）。
3. 寫一個 `decrypt_batch(data: &mut [u8], lens: &[u32], key: &[u8])`：把 N 張圖接成一個大陣列，另外傳每張的長度，在 Rust 裡逐段處理。比較與「JS for 迴圈呼叫 N 次 wasm」的效能差距。（wasm-bindgen 不支援 `Vec<Vec<u8>>` 這種巢狀陣列當參數，編譯會失敗。）
4. 照第 8 節撇步 3 的概念，在 Rust 裡用一個寫死的秘密解包 key，再用 `wasm-decompile` 反編譯，看看那個秘密有多容易被找到。

---

## 11 本章重點回顧

- **key 以明文經過 JS 時，WASM 擋不住任何人**：Network 面板看得到 key，演算法又是標準的。
- WASM 真正拉高成本的前提，是 key 以包裝過的形式送進 wasm、在 wasm 內解開；就算如此，輸出的明文仍然攔得到。
- 效能：全檔 AES 用 WebCrypto（比 WASM 快約 20 倍）；檔頭加密兩邊都只要微秒。
- wasm-bindgen 的 `&[u8]` / `&mut [u8]` 會整段複製：只傳需要處理的 `subarray`。
- 直接操作 linear memory 時，任何可能配置記憶體的呼叫之後都要重建 view。
- 上線一律 release build，並確認產物沒有 name section。

---

**下一章**：[07-canvas-rendering-and-hardening.md](./07-canvas-rendering-and-hardening.md) — Canvas 渲染、反爬、Key 動態下發
