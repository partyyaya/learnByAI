# 第 05 章：Rust + wasm-pack 工具鏈，編出你第一個 .wasm

> **學習目標**：從零安裝 Rust，理解 wasm-pack 的角色，並親手編出一個能在瀏覽器跑的 `.wasm` 模組。
> **預計時數**：120 分鐘
> **先備知識**：[[00-course-map-and-threat-model]]、瀏覽器 ES Module 概念
> **不需要**：你不用會 Rust，本章從零教你看得懂範例就好

---

## 1 為什麼選 Rust 來寫 WASM？

候選方案：

| 語言 | 編譯產物大小 | 學習曲線 | 生態 | 適合 |
|------|------------|---------|------|------|
| C/C++ (emscripten) | 中（含 glue） | 高 | 老牌 | 移植既有 C 程式 |
| Rust (wasm-pack) | 小（< 20KB 起跳） | 中 | 強 | **新寫的小模組（推薦）** |
| AssemblyScript | 中 | 低（像 TS） | 弱 | 純 JS 工程師快速嘗試 |
| Go (tinygo) | 中 | 中 | 中 | 已有 Go 程式 |
| Zig | 小 | 中 | 新 | 嘗鮮 |

**本課程選 Rust**，因為：

1. 對 byte 操作極快、無 GC、適合加解密這類運算。
2. `wasm-bindgen` 工具鏈最成熟，JS ↔ Rust 互通最自然。
3. 寫加密類程式時，Rust 編譯器會幫你避開大量 UB（整數溢位、越界）。

---

## 2 工具鏈總覽（圖解）

```text
你寫的 .rs ──→ rustc + cargo ──→ .wasm
                   │                  │
                   ▼                  ▼
              wasm-bindgen-cli   wasm-opt (binaryen)
                   │                  │
                   └────→ wasm-pack ──┘
                              │
                              ▼
                       pkg/{module.js, module.wasm, .d.ts}
                              │
                              ▼
                       前端 import 直接用
```

四個關鍵組件：

| 工具 | 角色 |
|------|------|
| `rustc` | Rust 編譯器 |
| `cargo` | 套件管理（像 npm） |
| `wasm-bindgen` | 產生 JS glue code，讓 Rust function 看起來像 JS function |
| `wasm-pack` | 把上面三個串起來的「總指揮」 |

---

## 3 安裝步驟

### 3.1 安裝 Rust

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
# 一路 Enter，選預設安裝
source "$HOME/.cargo/env"

rustc --version
# rustc 1.78.0 (or 更新)

cargo --version
```

### 3.2 安裝 WebAssembly target

```bash
rustup target add wasm32-unknown-unknown
```

### 3.3 安裝 wasm-pack

```bash
cargo install wasm-pack
wasm-pack --version
# wasm-pack 0.12.x
```

> Mac 上如果 `cargo install` 太慢，可改用 `brew install wasm-pack` 或從 GitHub release 下載 binary。

### 3.4 驗證環境

```bash
$ cargo new --lib hello-wasm
$ cd hello-wasm
$ ls
Cargo.toml  src/lib.rs
```

工具鏈就緒。

---

## 4 第一個 WASM：把兩個數字相加

我們先做最小範例，跑通 toolchain。

### 4.1 設定 Cargo.toml

```toml
# Cargo.toml
[package]
name = "hello-wasm"
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["cdylib"]   # 編成 dynamic library，wasm-pack 才認

[dependencies]
wasm-bindgen = "0.2"
```

> `crate-type = ["cdylib"]` 很容易漏，沒寫的話編出來不是 wasm。

### 4.2 寫 Rust 代碼

```rust
// src/lib.rs
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn add(a: i32, b: i32) -> i32 {
    a + b
}

#[wasm_bindgen]
pub fn greet(name: &str) -> String {
    format!("Hello, {}!", name)
}
```

`#[wasm_bindgen]` 是關鍵：它告訴編譯器「這個函式要 export 給 JS 使用」。

### 4.3 編譯

```bash
wasm-pack build --target web --release
```

成功後會生成 `pkg/` 資料夾：

```text
pkg/
├── hello_wasm.js          ← JS glue code
├── hello_wasm_bg.wasm     ← 真正的 wasm
├── hello_wasm.d.ts        ← TypeScript 型別
├── hello_wasm_bg.wasm.d.ts
└── package.json
```

`--target web` 是給原生 ES Module 用；還有 `bundler`（webpack/vite）、`nodejs` 等選項。

### 4.4 瀏覽器使用

```html
<!DOCTYPE html>
<html>
<body>
  <script type="module">
    import init, { add, greet } from './pkg/hello_wasm.js';

    await init();   // 一定要先 init，載入並實例化 wasm

    console.log(add(3, 4));         // 7
    console.log(greet('Rust'));     // "Hello, Rust!"
  </script>
</body>
</html>
```

**注意**：必須用 HTTP 伺服器開（直接 `file://` 開會被 CORS 擋）。最快：

```bash
npx serve .
```

打開 console 看到 `7` 跟 `Hello, Rust!`——恭喜，你的第一個 wasm 跑起來了。

---

## 5 JS ↔ Rust 資料傳遞的真相

加密一定要傳 byte array。先搞懂這個機制。

### 5.1 數字（i32, f64）

直接傳值，最快。沒踩雷空間。

### 5.2 字串

`wasm-bindgen` 自動幫你做 UTF-8 編碼，但**每次傳都會 copy**。
對於加密這種大資料場景，**不要用字串**，永遠用 byte array。

### 5.3 Byte array（重點）

兩種方式：

#### 方式 A：直接傳 `Uint8Array` 進去（wasm-bindgen 包好）

```rust
#[wasm_bindgen]
pub fn xor_decrypt(data: &mut [u8], key: &[u8]) {
    let key_len = key.len();
    for i in 0..data.len() {
        data[i] ^= key[i % key_len];
    }
}
```

```js
const data = new Uint8Array([0xFF, 0x12, ...]);
const key = new Uint8Array([0x5A, ...]);
xor_decrypt(data, key);
console.log(data);   // 已就地修改
```

簡單，但每次 call 還是會 copy 一次到 wasm linear memory。

#### 方式 B：直接操作 wasm memory（極致效能）

繞過 `wasm-bindgen`，自己管理：

```rust
#[no_mangle]
pub extern "C" fn alloc(len: usize) -> *mut u8 { /*...*/ }

#[no_mangle]
pub extern "C" fn xor_decrypt(ptr: *mut u8, len: usize, key_ptr: *const u8, key_len: usize) { /*...*/ }
```

JS 端：

```js
const memory = instance.exports.memory;
const ptr = instance.exports.alloc(data.length);
new Uint8Array(memory.buffer, ptr, data.length).set(data);
instance.exports.xor_decrypt(ptr, data.length, ...);
const result = new Uint8Array(memory.buffer, ptr, data.length).slice();
```

更快但更複雜。第 06 章會兩種都示範。

---

## 6 wasm-pack 三種 target 差別

執行 `wasm-pack build` 時 `--target` 影響很大：

| target | 用法 | 適合 |
|--------|------|------|
| `web` | `<script type="module">` 直接 import | 原生 ES Module、本課程主推 |
| `bundler` | `import` 然後給 webpack/vite | 大型專案 |
| `nodejs` | `require()` | Node.js 跑 wasm（少見） |
| `no-modules` | 全局 `wasm_bindgen` 函式 | 舊瀏覽器 / 沒有 module |

---

## 7 加快編譯的小技巧

加密類 wasm 應該 **小** 且 **快**。改 `Cargo.toml`：

```toml
[profile.release]
opt-level = "z"      # 優化體積（s 是平衡、3 是純速度）
lto = true           # link-time optimization
codegen-units = 1    # 更激進的優化（編譯變慢）
strip = true         # 移除 debug symbol
panic = "abort"      # panic 不展開 stack，省 size
```

> 對加解密這種 hot loop，建議用 `opt-level = 3` 而不是 `z`。

並裝 `wasm-opt`（binaryen）做後處理：

```bash
brew install binaryen   # 或 apt install binaryen
wasm-opt -O3 -o out.wasm pkg/your_wasm_bg.wasm
```

實測：原本 30KB 的 wasm 可降到 18KB 左右。

---

## 8 看一眼 wasm 內部

`wasm-pack` 編出來的是 binary，但可以看 **WAT**（WebAssembly Text）：

```bash
# 裝 wabt
brew install wabt
wasm2wat pkg/hello_wasm_bg.wasm > out.wat
```

打開 `out.wat`：

```wat
(module
  (type (;0;) (func (param i32 i32) (result i32)))
  (func $add (type 0) (param i32 i32) (result i32)
    local.get 0
    local.get 1
    i32.add)
  (export "add" (func $add))
  ...
)
```

非常底層、像彙編。逆向 wasm 的人就是看這個。
**它比 JS 難 100 倍逆向**——這是 WASM 的核心防禦價值。

---

## 9 寫一個圖片相關的「Hello」：XOR

預告 [[06-wasm-decryption-in-browser]]，但這裡先讓你動手做出第一個有用的 wasm。

### 9.1 Rust

```rust
// src/lib.rs
use wasm_bindgen::prelude::*;

/// 對 data 做循環 XOR，就地修改
#[wasm_bindgen]
pub fn xor_inplace(data: &mut [u8], key: &[u8]) {
    let key_len = key.len();
    if key_len == 0 { return; }
    for i in 0..data.len() {
        data[i] ^= key[i % key_len];
    }
}
```

### 9.2 編譯

```bash
wasm-pack build --target web --release
```

### 9.3 跑一張圖

```html
<!DOCTYPE html>
<body>
<input type="file" id="up" accept="image/*">
<img id="show" />

<script type="module">
import init, { xor_inplace } from './pkg/hello_wasm.js';
await init();

const KEY = new Uint8Array([0x5A, 0x11, 0xAB, 0xCD]);

document.getElementById('up').onchange = async (e) => {
  const file = e.target.files[0];
  const buf = new Uint8Array(await file.arrayBuffer());

  // 加密
  xor_inplace(buf, KEY);
  console.log('加密後前 4 byte:', buf.slice(0, 4));

  // 立刻再 XOR 一次，還原
  xor_inplace(buf, KEY);

  const blob = new Blob([buf], { type: file.type });
  document.getElementById('show').src = URL.createObjectURL(blob);
};
</script>
</body>
```

選一張圖，console 會印出「加密後的前 4 byte」（看起來是亂碼），而 `<img>` 顯示原圖（因為 XOR 兩次還原）。

---

## 10 常見坑

### 坑 1：`crate-type` 沒寫成 `cdylib`

只會編出 `.rlib`，沒有 `.wasm`。

### 坑 2：忘記 `await init()`

```js
import init, { add } from './pkg/hello_wasm.js';
console.log(add(3, 4));   // ❌ TypeError: add is not a function
```

要先：

```js
await init();
console.log(add(3, 4));   // ✅
```

### 坑 3：用 `file://` 開 HTML

```text
Failed to fetch dynamically imported module
```

一定要起 HTTP server。`npx serve .` / `python3 -m http.server` / Vite dev server 都行。

### 坑 4：改了 Rust 後沒重新 build

每次改完 `.rs`：

```bash
wasm-pack build --target web --release
```

重整瀏覽器（強制重整 `Cmd+Shift+R`，因為瀏覽器會快取 wasm）。

---

## 11 動手作業

1. 改 `xor_inplace` 為 `xor_copy(input: &[u8], key: &[u8]) -> Vec<u8>`，回傳新的 vector（不修改原資料）。比較與 in-place 的效能差。
2. 加一個 `add_one_to_each` 函式：把 byte array 每個元素 +1（mod 256）。用 release build 和 debug build（`wasm-pack build --dev`）比較速度。
3. 用 `wasm-opt -O3` 後處理你的 wasm，比較 file size：原始 vs `opt-level=z` vs `opt-level=3` vs `wasm-opt` 後。

---

## 12 本章重點回顧

- Rust + wasm-pack 是寫加密 wasm 的黃金組合。
- 關鍵步驟：`crate-type = ["cdylib"]` → `#[wasm_bindgen]` → `wasm-pack build --target web`。
- 傳大量 byte 用 `&mut [u8]` 或 `&[u8]`，**不要用字串**。
- 用 `opt-level=3 + lto + wasm-opt -O3` 把產物壓到最小。
- WASM 的核心防禦價值：**比 JS 難 100 倍逆向**，看 WAT 自然懂。

---

**下一章**：[06-wasm-decryption-in-browser.md](./06-wasm-decryption-in-browser.md) — 用 Rust + WASM 做出生產級圖片解密
