# 第 18 章：WebAssembly —— 用 wasm-pack 把 Rust 送進瀏覽器

> 前面 17 章，我們寫的 Rust 都跑在**伺服器**上：Axum 服務、資料庫、GPU 運算。
> 這一章換一個交付方向——把 Rust 編譯成 **WebAssembly（WASM）**，讓它跑在**使用者的瀏覽器裡**。
> 主角是 `wasm-pack`：它把「Rust 編譯 → 產生 JS 膠水程式 → 產出可 `import` 的 npm 套件」這一整串自動化。
> 學完你會知道：什麼工作值得搬到 WASM、資料怎麼在 JS 與 Rust 之間跨界、以及一個 `.wasm` 從編出來到上線要過哪幾關。

---

## 18.1 學習目標

完成本章後，你應該可以：

- 說清楚 WASM、`wasm32-unknown-unknown` target、`wasm-bindgen`、`wasm-pack` 四者的分工。
- 安裝 WASM 工具鏈，把一個 Rust crate 編成可在瀏覽器 `import` 的套件。
- 看懂 `wasm-pack` 產出的 `pkg/` 目錄裡每個檔案在幹嘛，以及四種 `--target` 的差別。
- 讓數字、字串、`Vec<u8>`、`struct`、`Result` 正確地在 JS 與 Rust 之間傳遞，並知道哪些操作有複製成本。
- 從 Rust 呼叫 JS（`console.log`、`performance.now()`），也讓 JS 呼叫 Rust 的 `async fn`。
- 用 `wasm-bindgen-test` 在真實瀏覽器裡跑測試。
- 把 `.wasm` 的體積壓下來，並知道 WASM 環境有哪些 Rust 標準庫用不了。
- **判斷一個需求該不該用 WASM**——這比會編更重要。

---

## 18.2 為什麼是 Rust + WASM

WebAssembly 是瀏覽器（以及 Node.js、Deno、邊緣運算平台）能執行的一種**二進位指令格式**。它不是要取代 JavaScript，而是補上 JS 不擅長的那一塊：**大量、密集、可預測的數值運算**。

JS 引擎其實很快，但它有幾個先天限制：值的型別要在執行期猜、有 GC 停頓、記憶體佈局不由你控制。WASM 剛好相反——型別在編譯期就定死、線性記憶體是一塊你自己管的 `ArrayBuffer`、沒有 GC。

而 Rust 是 WASM 生態的一等公民，原因很直接：

- **沒有 runtime、沒有 GC**——不像 Go 或 C# 要把整個執行期塞進 `.wasm`，Rust 編出來的東西小很多。
- **`wasm32-unknown-unknown` 是官方 tier 2 target**，`rustup` 一行指令就裝好，不用自己搞交叉編譯環境。
- **`wasm-bindgen` 這套膠水產生器非常成熟**，型別對應、TypeScript 定義檔、JS API 綁定全幫你生。

### 什麼工作值得搬到 WASM

| 適合 | 為什麼 |
|------|--------|
| 影像 / 音訊處理（濾鏡、編解碼、重取樣） | 對每個 pixel 做同一件事，純數值迴圈 |
| 加解密、壓縮、雜湊 | 大量位元運算，且常需要「不容易被逆向讀懂」 |
| 解析器（Markdown、SQL、自訂 DSL） | 邏輯複雜、狀態機多，Rust 的 enum + match 好寫又快 |
| 物理引擎、遊戲邏輯、幾何運算 | 密集浮點數運算 |
| **把已經存在的 Rust 邏輯拿到前端重用** | 前後端共用一份規則，不用兩邊各寫一次還寫得不一樣 |

### 什麼工作不值得

- **大量 DOM 操作**。每次跨 JS ↔ WASM 邊界都有成本，DOM 操作本身也還是要繞回 JS。用 WASM 改 DOM 通常**更慢**。
- **小資料、輕運算**。算 100 個數字的總和，JS 直接做完了，你光是傳資料進 WASM 就虧了。
- **只是想「用 Rust 寫前端」**。除非你有明確的效能或程式碼重用理由，否則多背一整套工具鏈與偵錯難度並不划算。

> **一句話心智模型**：WASM 是一顆**掛在 JS 旁邊的計算引擎**。JS 負責 UI、事件、DOM、網路；把「一坨很重的純計算」丟給 WASM 算完再拿回來。邊界要**粗**（一次傳一大包、算一大包），不要**細**（在迴圈裡一次呼叫一個 pixel）。

---

## 18.3 四個名詞的分工：target、wasm-bindgen、wasm-pack

初學最容易混的就是這幾個東西。它們是一條加工線上的不同工站：

```text
   你的 Rust 原始碼  src/lib.rs
            │
            │  ① rustc --target wasm32-unknown-unknown
            ▼
      一顆「純」的 .wasm
      （只認得數字：i32/i64/f32/f64）
      ❗ 不知道什麼是字串、什麼是物件
            │
            │  ② wasm-bindgen（讀 #[wasm_bindgen] 標記，產生兩邊的膠水）
            ▼
   .wasm（改寫過） + .js 膠水 + .d.ts 型別定義
      「字串怎麼過去、Vec 怎麼回來」都由膠水處理
            │
            │  ③ wasm-opt（binaryen 工具，瘦身與最佳化）
            ▼
       更小、更快的 .wasm
            │
            │  ④ 生成 package.json，包成一個 npm 套件
            ▼
          pkg/  ← 前端可以直接 import

   ①②③④ 這四步，wasm-pack 一個指令全包
```

講白話：

| 名詞 | 角色 | 白話 |
|------|------|------|
| `wasm32-unknown-unknown` | 編譯目標（target） | 「編給誰跑」的設定，第一個 unknown 是 CPU 廠商、第二個是作業系統——瀏覽器裡兩者都沒有 |
| `wasm-bindgen` | crate + CLI 工具 | **翻譯官**。WASM 原生只認數字，它負責讓字串、struct、`Vec` 能跨界 |
| `wasm-pack` | 建構工具 | **總指揮**。串起 cargo build → wasm-bindgen → wasm-opt → 產 npm 套件 |
| `web-sys` / `js-sys` | crate | 幫你把**瀏覽器 API**（DOM、fetch、Canvas）與 **JS 內建物件**（`Array`、`Promise`）包成 Rust 型別 |

> **另一個 target：`wasm32-wasip1`**（舊名 `wasm32-wasi`）。它是給「WASM 跑在瀏覽器之外」用的——有檔案系統、環境變數等系統介面，用在邊緣運算、外掛沙箱。本章講的是**瀏覽器**，所以用 `wasm32-unknown-unknown`。別裝錯。

---

## 18.4 安裝工具鏈

三步驟，接續第 00 章你已經裝好的 `rustup`：

```bash
# ① 加上 WASM 編譯目標
rustup target add wasm32-unknown-unknown

# ② 安裝 wasm-pack（--locked：照它發佈時鎖定的依賴版本編，比較不會編壞）
cargo install wasm-pack --locked
# （或用官方安裝腳本：curl https://wasm-bindgen.github.io/wasm-pack/installer/init.sh -sSf | sh）

# ③ 驗證
rustup target list --installed    # 清單裡要有 wasm32-unknown-unknown
wasm-pack --version               # 例如 wasm-pack 0.15.x
```

`cargo install wasm-pack` 是從原始碼編，會跑一兩分鐘到幾分鐘，泡杯咖啡。裝完後 `wasm-pack` 第一次執行時，還會自動幫你下載 `wasm-bindgen-cli` 與 `wasm-opt`——所以第一次 build 會比較久，之後就快了。`wasm-bindgen-cli` 的版本必須和你 `Cargo.lock` 裡的 `wasm-bindgen` crate **一字不差**，wasm-pack 會自動挑對的版本下載，這也是建議用它而不是自己手動串的原因之一。

> **找文件時注意網址**：wasm-pack 與 wasm-bindgen 早年放在 `rustwasm` GitHub 組織，該組織已在 2025 年封存；現在由 `github.com/wasm-bindgen` 維護，文件在 `wasm-bindgen.github.io`。網路上舊文章的 `rustwasm.github.io` 安裝腳本還連得到，但只會裝到停更的 0.13.1 版，別用。

> **不需要另外裝 Node.js 才能編**。但如果你要把產物 `import` 進前端專案（Vite/webpack）或 `npm publish`，那當然還是要 Node。

---

## 18.5 第一個 wasm crate：先跑通再說

先做一個最小的，確認整條線是通的。

```bash
cargo new --lib img-tools     # 注意是 --lib，WASM 產物是函式庫不是執行檔
cd img-tools
cargo add wasm-bindgen@0.2
```

打開 `Cargo.toml`，`[package]` 與 `[dependencies]` 是 `cargo new`、`cargo add` 已經寫好的，你要**自己加上中間的 `[lib]` 那段**：

```toml
[package]
name = "img-tools"
version = "0.1.0"
edition = "2024"

# ★ 最關鍵的一段：沒有這個 crate-type，編出來不會是可用的 wasm
[lib]
crate-type = ["cdylib", "rlib"]

[dependencies]
wasm-bindgen = "0.2"
```

`crate-type` 這行請務必理解，它是新手第一號地雷：

- **`cdylib`**：C-compatible dynamic library。這才是 `wasm-pack` 要拿去產生 `.wasm` 的那種產物。**漏掉這個，`wasm-pack build` 會直接報錯**（`crate-type must be cdylib to compile to WebAssembly`），並提示你加上這段。
- **`rlib`**：Rust 自己的函式庫格式。加上它，`tests/` 目錄裡的測試（例如 18.11 的 `tests/web.rs`）才能 `use img_tools::...`，這個 crate 也才能被其他 Rust crate 依賴。**兩個都寫**是常見做法（它對 LTO 有個副作用，18.12 會講）。

`src/lib.rs`（把 `cargo new` 產生的範例內容整個換掉）：

```rust
use wasm_bindgen::prelude::*;

/// 最單純的例子：兩個數字相加。
/// i32 是 WASM 原生型別，跨界零成本。
#[wasm_bindgen]
pub fn add(a: i32, b: i32) -> i32 {
    a + b
}

/// 字串就沒那麼單純了——見 18.8 節。
#[wasm_bindgen]
pub fn greet(name: &str) -> String {
    format!("Hello, {name}! 這句話是 Rust 在瀏覽器裡產生的。")
}
```

`#[wasm_bindgen]` 這個屬性巨集做的事是：**幫這個函式在 JS 那側生一個同名的包裝函式**，並處理型別轉換。沒有標記的 `pub fn` 不會被匯出到 JS。

在 `img-tools/` 目錄下編譯：

```bash
wasm-pack build --target web
```

---

## 18.6 產物解剖：`pkg/` 裡面有什麼

```text
img-tools/
├── Cargo.toml
├── src/lib.rs
├── target/               ← cargo 的中間產物（gitignore）
└── pkg/                  ← ★ wasm-pack 的成品（建構產物，由 CI 重建）
    ├── img_tools_bg.wasm      ← 真正的 WASM 二進位（bg = bindgen）
    ├── img_tools.js           ← JS 膠水：型別轉換 + 載入邏輯
    ├── img_tools.d.ts         ← TypeScript 型別定義（自動生成，很好用）
    ├── img_tools_bg.wasm.d.ts ← wasm 原始匯出的型別
    ├── package.json           ← 讓它就是一個能 npm install 的套件
    └── .gitignore             ← 內容只有一個 *，讓 git 忽略整個 pkg/
```

**注意檔名**：package 叫 `img-tools`（連字號），產物卻是 `img_tools`（底線）。因為 Rust 的 crate 名稱不允許連字號，`cargo` 會自動轉換。找不到檔案時先看這個。

`img_tools.d.ts` 打開來，重點是這兩行——`wasm-pack` 免費送你 TypeScript 型別（你寫在函式上的 `///` 文件註解也會一起帶過去，變成編輯器裡的提示）：

```typescript
export function add(a: number, b: number): number;
export function greet(name: string): string;
```

### 四種 `--target`，選錯就跑不起來

（wasm-pack 另外還有 `--target deno`，本章不談。）

```bash
wasm-pack build --target web        # 瀏覽器原生 ES Module，<script type="module"> 直接 import
wasm-pack build --target bundler    # 給 webpack 5 等打包工具（預設值）
wasm-pack build --target nodejs     # CommonJS，Node.js 用 require()
wasm-pack build --target no-modules # 不走 ES Module，掛全域變數
```

| target | 載入方式 | 什麼時候用 |
|--------|----------|-----------|
| `web` | 你要自己 `await init()` | **學習與 Vite 專案首選**。最直觀，沒有打包工具也能跑 |
| `bundler` | 打包工具自動處理，直接 `import { add }` 就能用 | webpack 5 專案。Vite 需要 `vite-plugin-wasm` 才行 |
| `nodejs` | `require('./pkg')`，同步載入 | 在 Node.js 後端跑 WASM |
| `no-modules` | `<script src>` 後用全域 `wasm_bindgen` | 沒有 build step 的老專案 |

> **實務建議**：**先用 `--target web` 學**，因為它把「載入」這件事攤在你面前，你會清楚知道 `.wasm` 是被 fetch 下來、編譯、實例化的。等你要接進 Vite/webpack 再依專案切換。

---

## 18.7 在瀏覽器裡跑起來

在專案根目錄建 `index.html`：

```html
<!doctype html>
<html lang="zh-Hant">
<head><meta charset="utf-8"><title>Rust WASM</title></head>
<body>
  <h1>Rust + WebAssembly</h1>
  <pre id="out">載入中…</pre>

  <script type="module">
    // ① 預設匯出的 init 負責 fetch .wasm、編譯、實例化
    import init, { add, greet } from './pkg/img_tools.js';

    // ② 一定要 await，沒 init 完就呼叫函式會炸
    await init();

    // ③ 之後就像呼叫普通 JS 函式
    document.getElementById('out').textContent =
      `add(2, 40) = ${add(2, 40)}\n${greet('工程師')}`;
  </script>
</body>
</html>
```

在**專案根目錄**（`img-tools/`，也就是 `index.html` 與 `pkg/` 所在的地方）啟一個靜態伺服器（**不能用 `file://` 直接開**，瀏覽器的 ES Module 與 WASM 載入都要求 HTTP 來源）：

```bash
python3 -m http.server 8080
# 或 npx serve .
```

打開 `http://localhost:8080`，看到：

```text
add(2, 40) = 42
Hello, 工程師! 這句話是 Rust 在瀏覽器裡產生的。
```

工具鏈通了。接下來才是真正有價值的部分。

---

## 18.8 資料怎麼跨界：複製成本在哪裡

這是 WASM 效能的**核心觀念**，也是多數人寫出「WASM 版比 JS 還慢」的原因。

WASM 的記憶體是**一塊連續的線性記憶體**，在 JS 那側就是一個 `ArrayBuffer`。WASM 函式的參數與回傳值，原生只能是 `i32 / i64 / f32 / f64`。所以：

| Rust 型別 | JS 型別 | 跨界成本 |
|-----------|---------|----------|
| `i32` / `u32` / `f64` | `number` | **零**。直接就是 WASM 原生型別 |
| `i64` / `u64` | `bigint` | **零**，但 JS 端要傳 `21n` 這種 BigInt；傳一般的 `21` 會丟 `TypeError: Cannot convert 21 to a BigInt` |
| `bool` | `boolean` | **零**（實際傳 0/1） |
| `&str` / `String` | `string` | **有複製 + 編碼轉換**。JS 是 UTF-16，Rust 是 UTF-8，每次都要轉碼 |
| `&[u8]` / `Vec<u8>` | `Uint8Array` | **有複製**。進去複製一次，出來再複製一次 |
| `#[wasm_bindgen] struct` | 一個 JS class（內含指標） | 物件**留在 WASM 記憶體裡**，JS 只拿到把手（handle） |
| `JsValue` | 任意 JS 值 | 存在 JS 側的表格裡，Rust 拿到的是索引 |
| 一般 `struct`（用 serde） | plain object | 要序列化，成本最高 |

`#[wasm_bindgen]` 幫你把這些轉換都藏起來了——方便，但**成本不會消失**。

### 設計原則：邊界要粗

```rust
// ❌ 壞設計：JS 要在迴圈裡呼叫一百萬次，每次都付跨界成本
#[wasm_bindgen]
pub fn process_one_pixel(r: u8, g: u8, b: u8) -> u8 { /* ... */ }

// ✅ 好設計：一次把整張圖交出去，Rust 在裡面跑完迴圈
#[wasm_bindgen]
pub fn process_image(rgba: &[u8]) -> Vec<u8> { /* ... */ }
```

跨界呼叫本身很便宜（幾奈秒），但**一百萬次的幾奈秒**加上每次的型別轉換，就足以吃掉 Rust 全部的效能優勢。

### 結構化資料：`serde-wasm-bindgen`

要傳「一包設定」或「一個結果物件」時，最順的做法是走 serde：

```bash
cargo add serde --features derive
cargo add serde-wasm-bindgen@0.6
```

```rust
use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

#[derive(Deserialize)]
pub struct FilterOptions {
    pub brightness: i16,
    pub grayscale: bool,
}

#[derive(Serialize)]
pub struct Stats {
    pub width: u32,
    pub height: u32,
    pub avg_luma: f32,
}

#[wasm_bindgen]
pub fn analyze(opts: JsValue) -> Result<JsValue, JsValue> {
    // JS 物件 → Rust struct
    let opts: FilterOptions = serde_wasm_bindgen::from_value(opts)?;

    let stats = Stats { width: 100, height: 100, avg_luma: if opts.grayscale { 0.5 } else { 0.7 } };

    // Rust struct → JS 物件
    Ok(serde_wasm_bindgen::to_value(&stats)?)
}
```

JS 端就是很自然的用法：

```js
const stats = analyze({ brightness: 10, grayscale: true });
console.log(stats.avg_luma);
```

JS 傳來的物件少了欄位或型別不對時（例如 `brightness: 'x'`），`from_value` 會失敗，`?` 把它變成 JS 那側的 `Error`，訊息像 `invalid type: string "x", expected i16`。

> **取捨**：serde 路線寫起來最舒服，但**每次呼叫都要序列化整包資料**，而且 `.d.ts` 裡這個函式只會寫成 `analyze(opts: any): any`，TypeScript 幫不上忙。設定參數（小、呼叫次數少）用它很好；**大量像素資料絕對不要走 serde**，用 `&[u8]` 或下一節的零複製寫法。

---

## 18.9 完整範例：瀏覽器端影像處理

現在做一個真正有意義的東西——把 Canvas 上的圖片交給 Rust 做灰階與亮度調整。這個例子會一次用到：`&[u8]` 傳遞、`Result` 錯誤處理、`#[wasm_bindgen] struct`、以及零複製的進階寫法。

沿用 18.5 的 `img-tools` 專案，把下面三個檔案整份換掉即可（`console_error_panic_hook` 可以用 `cargo add console_error_panic_hook@0.1` 加，或直接照抄這份 `Cargo.toml`）。改完重跑 `wasm-pack build --target web`，再重新整理頁面就好，18.7 的伺服器不用重開。

### 完整 `Cargo.toml`

```toml
[package]
name = "img-tools"
version = "0.1.0"
edition = "2024"

[lib]
crate-type = ["cdylib", "rlib"]

[dependencies]
wasm-bindgen = "0.2"
console_error_panic_hook = "0.1"
# 註：本範例的 console.log 是用 extern 區塊自己綁的（見下方 lib.rs），
#     所以還不需要 web-sys。18.10 節示範 web-sys 時才會加。

# 體積最佳化，18.12 節會解釋每一行
[profile.release]
opt-level = "z"
lto = true
codegen-units = 1
panic = "abort"
```

### 完整 `src/lib.rs`

```rust
use wasm_bindgen::prelude::*;

// ── 從 Rust 呼叫 JS ────────────────────────────────────────────
// extern 區塊裡宣告「JS 那邊有什麼函式」，wasm-bindgen 幫你接上。
#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = console, js_name = log)]
    fn console_log(s: &str);
}

/// 模組載入時（init() 裡）自動執行一次。
/// console_error_panic_hook 讓 Rust 的 panic 訊息（含檔名與行號）印到瀏覽器 console，
/// 否則你只會看到一句 "RuntimeError: unreachable"，完全不知道錯在哪。
#[wasm_bindgen(start)]
pub fn on_load() {
    console_error_panic_hook::set_once();
    console_log("img-tools WASM 已載入");
}

// ── 寫法 A：最直觀，進出各複製一次 ─────────────────────────────

/// 灰階轉換。輸入輸出都是 RGBA 位元組（每 4 個 byte 一個 pixel）。
#[wasm_bindgen]
pub fn grayscale(rgba: &[u8]) -> Vec<u8> {
    let mut out = rgba.to_vec();
    for px in out.chunks_exact_mut(4) {
        // 亮度公式 0.299R + 0.587G + 0.114B，
        // 這裡用整數近似（77/150/29 加總 = 256）避免浮點數，速度更快。
        let luma = ((px[0] as u32 * 77 + px[1] as u32 * 150 + px[2] as u32 * 29) >> 8) as u8;
        px[0] = luma;
        px[1] = luma;
        px[2] = luma;
        // px[3] 是 alpha，保持不動
    }
    out
}

/// 亮度調整。用 Result 示範錯誤怎麼跨界——
/// Err(JsValue) 在 JS 那側會變成一個真正的 throw，可以用 try/catch 接。
/// 注意 catch 到的是這個 JsValue 本身（這裡是一個字串），不是 Error 物件；
/// 想讓 JS 拿到有 message 的 Error，把錯誤型別換成 JsError，用 JsError::new("...") 建立。
#[wasm_bindgen]
pub fn brightness(rgba: &[u8], delta: i16) -> Result<Vec<u8>, JsValue> {
    if rgba.len() % 4 != 0 {
        return Err(JsValue::from_str("資料長度必須是 4 的倍數（RGBA）"));
    }
    if !(-255..=255).contains(&delta) {
        return Err(JsValue::from_str("delta 必須介於 -255 到 255"));
    }

    let mut out = rgba.to_vec();
    for px in out.chunks_exact_mut(4) {
        for c in &mut px[..3] {
            // saturating 的手動版本：clamp 到 0..=255，不讓它溢位環繞
            *c = (*c as i16 + delta).clamp(0, 255) as u8;
        }
    }
    Ok(out)
}

// ── 寫法 B：零複製，把 buffer 留在 WASM 記憶體裡 ─────────────────

/// 一個匯出到 JS 的 struct。JS 會拿到一個 class，
/// 但物件本體（pixels 這個 Vec）始終住在 WASM 的線性記憶體裡。
#[wasm_bindgen]
pub struct ImageBuffer {
    pixels: Vec<u8>,
    width: u32,
    height: u32,
}

#[wasm_bindgen]
impl ImageBuffer {
    /// 標記成 constructor，JS 端就能寫 new ImageBuffer(w, h)
    #[wasm_bindgen(constructor)]
    pub fn new(width: u32, height: u32) -> Result<ImageBuffer, JsValue> {
        let len = (width as usize)
            .checked_mul(height as usize)
            .and_then(|n| n.checked_mul(4))
            .ok_or_else(|| JsValue::from_str("尺寸過大，長度溢位"))?;

        Ok(ImageBuffer { pixels: vec![0; len], width, height })
    }

    /// 回傳 buffer 在 WASM 線性記憶體中的起始位址。
    /// JS 拿到這個數字後，可以直接在同一塊記憶體上開一個 view，不用複製。
    #[wasm_bindgen(getter)]
    pub fn ptr(&self) -> *const u8 {
        self.pixels.as_ptr()
    }

    #[wasm_bindgen(getter)]
    pub fn len(&self) -> usize {
        self.pixels.len()
    }

    #[wasm_bindgen(getter)]
    pub fn width(&self) -> u32 {
        self.width
    }

    #[wasm_bindgen(getter)]
    pub fn height(&self) -> u32 {
        self.height
    }

    /// 就地灰階——完全沒有跨界複製，只有一次函式呼叫。
    pub fn grayscale_in_place(&mut self) {
        for px in self.pixels.chunks_exact_mut(4) {
            let luma = ((px[0] as u32 * 77 + px[1] as u32 * 150 + px[2] as u32 * 29) >> 8) as u8;
            px[0] = luma;
            px[1] = luma;
            px[2] = luma;
        }
    }
}

// ── 一般單元測試：不需要瀏覽器，cargo test 就能跑 ──────────────
// 前提是測試走過的路徑不能建立 JsValue（原因見下方說明）。
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grayscale_makes_rgb_equal() {
        let input = vec![255, 0, 0, 255]; // 純紅，不透明
        let out = grayscale(&input);
        assert_eq!(out[0], out[1]);
        assert_eq!(out[1], out[2]);
        assert_eq!(out[3], 255, "alpha 不該被改動");
    }

    #[test]
    fn brightness_clamps_to_255() {
        // 只走 Ok 路徑，沒有建立 JsValue，原生的 cargo test 才跑得動
        let out = brightness(&[250, 10, 0, 255], 10).unwrap();
        assert_eq!(out, vec![255, 20, 10, 255]);
    }
}
```

**為什麼不在這裡測 `brightness` 的錯誤路徑？** `cargo test` 是把程式編成**原生**執行檔來跑，那裡沒有 JS 引擎。`JsValue::from_str` 這類函式在原生平台上只是個空殼，一呼叫就 panic：`function not implemented on non-wasm32 targets`，而且這個 panic 會讓整個測試程式直接中止，其他測試的結果也一起看不到。所以會碰到 `JsValue` 的測試，要放到 18.11 的 `wasm-bindgen-test`，在 wasm 裡跑。

### 完整 `index.html`

```html
<!doctype html>
<html lang="zh-Hant">
<head><meta charset="utf-8"><title>WASM 影像處理</title></head>
<body>
  <input type="file" id="file" accept="image/*">
  <button id="gray">灰階（寫法 A）</button>
  <button id="grayFast">灰階（寫法 B 零複製）</button>
  <pre id="log"></pre>
  <canvas id="cv"></canvas>

  <script type="module">
    import init, { grayscale, brightness, ImageBuffer } from './pkg/img_tools.js';

    // init() 回傳 wasm 模組的匯出物件；其中 wasm.memory 就是線性記憶體，寫法 B 會用到
    const wasm = await init();

    const cv = document.getElementById('cv');
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    const log = (m) => document.getElementById('log').textContent += m + '\n';

    document.getElementById('file').onchange = async (e) => {
      const bmp = await createImageBitmap(e.target.files[0]);
      cv.width = bmp.width; cv.height = bmp.height;
      ctx.drawImage(bmp, 0, 0);
    };

    // ── 寫法 A：把整包 pixel 傳進去、拿一包回來 ──
    document.getElementById('gray').onclick = () => {
      const img = ctx.getImageData(0, 0, cv.width, cv.height);

      // img.data 是 Uint8ClampedArray；wasm-bindgen 的 &[u8] 對應 Uint8Array，
      // 共用同一個 ArrayBuffer 開一個 view 即可，不會多複製。
      const view = new Uint8Array(img.data.buffer);

      const t0 = performance.now();
      const out = grayscale(view);          // ← 進去複製一次、出來複製一次
      const t1 = performance.now();

      img.data.set(out);
      ctx.putImageData(img, 0, 0);
      log(`寫法 A：${(t1 - t0).toFixed(2)} ms`);
    };

    // ── 寫法 B：buffer 住在 WASM 裡，JS 只在同一塊記憶體上開 view ──
    document.getElementById('grayFast').onclick = () => {
      const img = ctx.getImageData(0, 0, cv.width, cv.height);
      const buf = new ImageBuffer(cv.width, cv.height);

      // ⚠️ 每次都要重新建立 view：Rust 端只要配置記憶體（例如 new ImageBuffer）
      //    就可能讓 WASM 記憶體成長，舊的 ArrayBuffer 會被 detach，舊 view 就失效了。
      const mem = () => new Uint8Array(wasm.memory.buffer, buf.ptr, buf.len);

      mem().set(img.data);                  // 寫進 WASM 記憶體

      const t0 = performance.now();
      buf.grayscale_in_place();             // ← 純呼叫，零資料搬運
      const t1 = performance.now();

      img.data.set(mem());                  // 讀回來
      ctx.putImageData(img, 0, 0);
      log(`寫法 B：${(t1 - t0).toFixed(2)} ms`);

      // ⚠️ pixels 住在 WASM 記憶體裡，JS 的 GC 看不到它有多大；
      //    用完就自己釋放，別等 GC（見下方說明）
      buf.free();
    };
  </script>
</body>
</html>
```

**關於 `free()`**：wasm-bindgen 產生的 class 有登記 `FinalizationRegistry`，JS 物件被 GC 回收後，會順手把 Rust 那側的記憶體也釋放掉。但 GC 什麼時候跑、會不會跑都沒有保證，而且 GC 只看得到 JS 那個小小的把手，不知道它背後掛著幾 MB 的像素。所以大塊資料請**用完就 `free()`**（產生的 class 也實作了 `Symbol.dispose`，支援 `using` 宣告的環境可以讓它離開區塊時自動釋放）。另外，WASM 記憶體**只會長、不會縮**：`free()` 之後那塊空間會被 Rust 的配置器重複利用，但 `wasm.memory.buffer` 的大小不會變回去。

**兩種寫法怎麼選**：寫法 A 好懂、好維護，絕大多數情況夠用。只有當你**反覆處理同一塊大 buffer**（例如即時視訊逐格濾鏡、遊戲迴圈），複製成本累積起來才值得改用寫法 B。**先寫 A，量到瓶頸再換 B**——不要一開始就為了「零複製」四個字把程式寫得很難維護。

> **關於效能數字**：網路上的「WASM 比 JS 快 N 倍」都要打折看。純運算迴圈通常有 2～10 倍差距，但你必須把**資料搬運**與**模組初始化**算進去。小圖片上 JS 反而贏是很常見的結果。**用上面那段 `performance.now()` 自己量你的實際場景**，這比任何 benchmark 文章都準。量的時候注意：瀏覽器為了安全會刻意降低 `performance.now()` 的精度（Chromium 系約 0.1 ms，有些瀏覽器更粗），小圖片常常量出 `0.00 ms`——請用大一點的照片（例如 4000×3000），或把同一個操作跑幾十次取中位數。另外留意上面兩段的計時範圍不一樣：寫法 A 的數字包含資料進出的複製，寫法 B 只包含運算本身；想比「整趟」的成本，就把 B 的 `t0` 移到 `mem().set(...)` 之前、`t1` 移到讀回之後。

---

## 18.10 呼叫 JS、以及 async

### 從 Rust 呼叫 JS

有三種層次，由手動到自動（後兩種要先 `cargo add js-sys@0.3`，以及下方帶 feature 的 `web-sys`）：

```rust
use wasm_bindgen::prelude::*;

// ① 手動宣告：最輕量，只綁你要用的那一個
#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = console, js_name = log)]
    fn console_log(s: &str);

    // 也可以綁自己寫的 JS 函式
    #[wasm_bindgen(js_name = showToast)]
    fn show_toast(msg: &str);
}

// ② js-sys：JS 語言內建物件（Array、Date、Promise、Math…）
fn use_js_sys() {
    let arr = js_sys::Array::new();
    arr.push(&JsValue::from(1));
}

// ③ web-sys：瀏覽器 API（DOM、fetch、Canvas、WebGL…）
//    每個 API 都是一個 feature，要在 Cargo.toml 明確開啟，
//    這是刻意設計——只編譯你用到的部分，避免 .wasm 爆肥。
fn use_web_sys() -> Option<()> {
    let window = web_sys::window()?;
    let document = window.document()?;
    let el = document.get_element_by_id("out")?;
    el.set_text_content(Some("由 Rust 直接改的 DOM"));

    // performance.now() 與 console.log 也走 web-sys
    let ms = window.performance()?.now();
    web_sys::console::log_1(&format!("performance.now() = {ms}").into());
    Some(())
}
```

綁「自己寫的 JS 函式」時要注意：沒有額外指定的話，wasm-bindgen 會把 `showToast` 當成**全域函式**去找。呼叫前得先有 `window.showToast = (msg) => { ... }`，否則會丟 `ReferenceError: showToast is not defined`。比較乾淨的做法是寫成 ES Module 檔，再用 `#[wasm_bindgen(module = "/js/toast.js")]` 標在 `extern` 區塊上（路徑從 crate 根目錄算起），wasm-pack 會把那個檔案一起複製進 `pkg/snippets/`。

`web-sys` 的 feature 要這樣開（上面這段程式剛好用到這五個）：

```toml
[dependencies.web-sys]
version = "0.3"
features = ["console", "Window", "Document", "Element", "Performance"]
```

或用指令一次加好：`cargo add web-sys@0.3 --features console,Window,Document,Element,Performance`。

> **最常見的 web-sys 錯誤**：方法明明在文件上，編譯卻說找不到，例如 ``error[E0599]: no method named `document` found for struct `Window` ``，或 ``error[E0432]: unresolved import `web_sys::Document` ``——**九成是 feature 沒開**。麻煩的是錯誤訊息多半**不會**告訴你缺哪個 feature（只有少數情況會出現 ``the item is gated behind the `Window` feature``）。最快的查法是到 docs.rs 看那個方法或型別，每一項都標著「This API requires the following crate features to be activated: `Document`, `Window`」，照著加就好。

### async 函式

Rust 的 `async fn` 加上 `#[wasm_bindgen]` 之後，在 JS 那側就是一個回傳 `Promise` 的函式：

```bash
cargo add wasm-bindgen-futures@0.4 js-sys@0.3
```

```rust
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::JsFuture;

#[wasm_bindgen]
extern "C" {
    // JS 那邊定義的 async 函式，回傳 Promise
    #[wasm_bindgen(js_name = fetchConfig)]
    fn fetch_config() -> js_sys::Promise;
}

/// JS 端用法：await load_and_count()（JS 那側的名字跟 Rust 一樣，想改名就加 js_name）
#[wasm_bindgen]
pub async fn load_and_count() -> Result<u32, JsValue> {
    // JsFuture 把 JS 的 Promise 變成 Rust 的 Future，就能 .await
    let value = JsFuture::from(fetch_config()).await?;
    let text = value.as_string().ok_or_else(|| JsValue::from_str("預期是字串"))?;
    Ok(text.len() as u32)
}
```

產生的 `.d.ts` 是 `load_and_count(): Promise<number>`。`fetchConfig` 一樣要是全域函式，例如 `window.fetchConfig = async () => 'hello'`，這時 `await load_and_count()` 得到 `5`；如果它 resolve 的不是字串，`Err` 會讓 Promise 被 reject，JS 端用 `try/catch` 包住 `await` 就接得到。

這裡有一件事**必須講清楚**，它是第 08 章的直接延伸：

> **瀏覽器 WASM 裡沒有 Tokio 多執行緒 runtime。** 瀏覽器主執行緒本來就是單執行緒事件迴圈，`.await` 的推動者是**瀏覽器的事件迴圈**，不是 Tokio。你 `cargo add tokio --features full` 在 wasm target 下編不過（用到 mio、系統執行緒）。要用非同步就用 `wasm-bindgen-futures`；要真的平行運算，得走 Web Worker 或 `wasm-bindgen-rayon`。後者門檻不低：要用 nightly 工具鏈重編標準庫（開 `atomics` 等 target feature），還需要 `SharedArrayBuffer`，而它要求伺服器對頁面送出 `Cross-Origin-Opener-Policy: same-origin` 與 `Cross-Origin-Embedder-Policy: require-corp` 兩個標頭（俗稱 COOP/COEP），頁面上引用的跨網域資源也都得配合。

---

## 18.11 測試：在真的瀏覽器裡跑

第 06 章的 `cargo test` 在這裡仍然有效——**純邏輯測試（像上面那個 `mod tests`）用 `cargo test` 跑就好，它編成原生執行檔，快得多**。

但如果測試要碰到 DOM、`JsValue`（包括 `Err(JsValue)` 這種錯誤路徑）、或任何瀏覽器 API，就得編成 wasm 在 JS 環境裡跑：

```bash
cargo add --dev wasm-bindgen-test@0.3
```

在專案根目錄建 `tests/web.rs`（`tests/` 底下的檔案要靠 18.5 那個 `rlib` 才能 `use img_tools::...`）：

```rust
use img_tools::{brightness, grayscale};
use wasm_bindgen_test::*;

// 指定在瀏覽器環境執行（不加這行預設跑在 Node.js）
wasm_bindgen_test_configure!(run_in_browser);

#[wasm_bindgen_test]
fn grayscale_works_in_browser() {
    let out = grayscale(&[10, 20, 30, 255]);
    assert_eq!(out[0], out[1]);
    assert_eq!(out[3], 255);
}

// 錯誤路徑會建立 JsValue，只能在 wasm 裡測
#[wasm_bindgen_test]
fn brightness_rejects_bad_length() {
    assert!(brightness(&[1, 2, 3], 10).is_err());
}
```

執行：

```bash
wasm-pack test --headless --chrome     # 或 --firefox、--safari
```

`--headless` 會在無視窗的瀏覽器裡跑完回報結果——很適合放進 CI。幾個實際會卡住的地方：

- **瀏覽器本身要先裝好**。`--chrome` / `--firefox` 時 wasm-pack 會自動下載最新穩定版的 chromedriver / geckodriver，但不會幫你裝瀏覽器；Chrome 版本太舊、跟 chromedriver 對不上也會失敗。
- **`--safari` 用的是 macOS 內建的 `safaridriver`**，第一次要先在終端機跑一次 `safaridriver --enable`（需要管理員密碼），否則會看到 `safaridriver could not launch because it is not configured correctly`。
- **不加 `--headless`**（例如 `wasm-pack test --chrome`）會改成互動模式：它在 `http://127.0.0.1:8000` 開一個測試頁，你用手邊任何瀏覽器打開就能看到結果，跑完按 Ctrl-C 結束。WebDriver 設定不起來時，用這招先確認測試本身沒問題。

`wasm-pack test --node` 則不需要瀏覽器，改用 Node.js 跑——但它只跑**沒有** `run_in_browser` 的測試檔。上面這個 `tests/web.rs` 在 `--node` 下會整個被跳過，只印一行 `this test suite is only configured to run in a browser, but we're only testing node.js tests so skipping`，不算失敗也不算通過。想用 Node 跑，就另外開一個不加那行設定的測試檔（例如 `tests/node.rs`）。

> **測試策略建議**：把**純運算邏輯**寫成不帶 `#[wasm_bindgen]` 的普通 Rust 函式，用 `cargo test` 密集測試；`#[wasm_bindgen]` 那層只做「型別轉換 + 呼叫」的薄殼，用少量 `wasm_bindgen_test` 驗證接線正確。核心函式回傳一般的 Rust 錯誤型別（自訂 enum 或第 04 章的 `thiserror`），到薄殼才轉成 `JsValue`，連錯誤路徑都能用 `cargo test` 測。這其實就是第 09 章分層架構的同一個道理——**核心邏輯不該綁死在某個交付平台上**。

---

## 18.12 體積最佳化：`.wasm` 是要下載的

伺服器上的 binary 大小你可能不在意，但 `.wasm` 是**使用者每次開網頁都要下載的東西**，多 500 KB 就是實實在在的載入延遲。

### 第一步：Cargo profile

```toml
[profile.release]
opt-level = "z"      # 為體積最佳化（預設 3 是純速度；"s" 也壓體積但較溫和；"z" 壓得最兇）
lto = true           # Link Time Optimization，跨 crate 最佳化並剔除死程式碼
codegen-units = 1    # 只用一個編譯單元，最佳化空間最大（編譯較慢）
panic = "abort"      # 在 wasm32-unknown-unknown 上本來就是 abort，見下方說明
```

`panic = "abort"` 值得多說一句：在一般原生平台上，Rust 預設的 panic 會 unwind（逐層清理 stack），二進位裡要多帶一些資料，改成 abort 能省下體積。但 `wasm32-unknown-unknown` 預設就是 abort（`rustc --print cfg --target wasm32-unknown-unknown` 會看到 `panic="abort"`），所以這行**不會讓 `.wasm` 變小**，寫上去只是讓意圖明確。panic 時 wasm 會執行一道 `unreachable` 指令，JS 那側收到 `RuntimeError: unreachable`——這就是 18.9 要裝 `console_error_panic_hook` 的原因。（wasm-pack 0.15 起有 `--panic-unwind`，能讓 panic 在邊界被接住，但需要 nightly 工具鏈，本章不談。）

> **`lto` 的陷阱：`crate-type` 裡有 `rlib` 時，cargo 不會真的做 LTO。** 不報錯也不警告，`lto = true` 就這樣被略過。在 Rust 1.100 上，`["cdylib", "rlib"]` 加不加 `lto = true`，產出的 `.wasm` 一個 byte 都不差；改成只有 `["cdylib"]`，cargo 才會把 `-C lto` 傳給編譯器（`cargo build --release --target wasm32-unknown-unknown -v` 看得到）。偏偏 18.5 說過，`tests/` 底下的測試和「被其他 crate 依賴」都需要 `rlib`。兩者都要的話，就照 18.11 的分層建議拆成兩個 crate：核心邏輯放在一般的 lib crate（`cargo test` 和後端都依賴它），另開一個 `crate-type = ["cdylib"]` 的薄殼 crate，只放 `#[wasm_bindgen]` 函式，對薄殼跑 `wasm-pack build`，LTO 才會生效。

### 第二步：`wasm-opt`

`wasm-pack build`（不加參數就是 `--release`）會自動跑 `wasm-opt`，預設參數是 `-O`。這一步常常能再砍掉三成以上，可以加 `--no-opt` 另編一份比比看。想調參數：

```toml
[package.metadata.wasm-pack.profile.release]
wasm-opt = ["-Oz"]
```

### 第三步：量出來，別用猜的

```bash
ls -lh pkg/*.wasm
gzip -c pkg/img_tools_bg.wasm | wc -c    # 看 gzip 後的實際傳輸量（伺服器一定要開壓縮）
```

想知道**體積被誰吃掉**，用 `twiggy`。不過 `pkg/` 裡的 release 版 `.wasm` 已經被 `wasm-opt` 拿掉函式名稱，直接丟給 twiggy 只會看到 `code[0]`、`code[3]` 這種編號。所以先讓 profiling 建置保留名稱，再分析那一份：

```toml
# profiling 建置照樣最佳化，但用 -g 保留函式名稱給 twiggy 看
[package.metadata.wasm-pack.profile.profiling]
wasm-opt = ["-O", "-g"]
```

```bash
cargo install twiggy --locked
wasm-pack build --target web --profiling --out-dir pkg-prof
twiggy top -n 20 pkg-prof/img_tools_bg.wasm
```

它會列出佔用最大的那幾個項目（第一列 `"function names" subsection` 是名稱表本身，release 版沒有，略過即可）。常見的兇手：記憶體配置器（`dlmalloc`）、格式化機制（`format!` 與 panic 訊息會拉進一整套 `core::fmt`）、`serde` 的衍生程式碼、以及開太多 feature 的 `web-sys`。

給你一個量級參考（Rust 1.100、wasm-bindgen 0.2.130、預設的 release 設定）：18.5 那個只有 `add` 與 `greet` 的 crate，`.wasm` 約 15 KB，gzip 後約 7 KB；只放 18.8 那個 `analyze` 函式的 crate（多了 serde）就到約 59 KB，gzip 後約 26 KB，將近四倍。**這些數字依專案與版本差異很大，請用上面的指令量你自己的。**

> **`opt-level = "z"` 的取捨**：它不保證更小，還可能犧牲執行速度。在小 crate 上，`"z"` 甚至可能比預設的 3 還大（LTO 沒生效時尤其常見）。如果你的 WASM 是拿來做重運算的（就像本章的影像處理），**先試 `opt-level = 3` 或 `"s"`，兩邊都量過再決定**。別無腦抄設定。

---

## 18.13 WASM 環境的限制：哪些 Rust 你不能用

`wasm32-unknown-unknown` 的第二個 `unknown` 是「沒有作業系統」。在這個 target 上，標準庫的 API 幾乎都**編得過**，差別出在執行期：有的老實回傳 `Err`，有的**一呼叫就 panic**——後者最難查。真正會編不過的，通常是依賴作業系統的第三方 crate。

| 你想用 | 在瀏覽器 WASM 的狀況 | 替代方案 |
|--------|---------------------|----------|
| `std::fs` | 編得過，但每個操作都回 `Err`（`ErrorKind::Unsupported`），沒有檔案系統 | `web-sys` 的 File API / IndexedDB |
| `std::net` | 同上，連線一律回 `Err`，不能開 socket | `fetch`、WebSocket（透過 `web-sys`） |
| `std::thread::spawn` | **編得過，呼叫就 panic**（`failed to spawn thread`） | Web Worker、`wasm-bindgen-rayon` |
| `std::time::Instant` | **編得過，但呼叫就 panic** ⚠️（`time not implemented on this platform`） | `web_sys::window()?.performance()?.now()`（要開 `Window`、`Performance` feature） |
| `SystemTime::now()` | 同上，會 panic | `js_sys::Date::now()` |
| `rand` / `getrandom` | **編不過**，`getrandom` 會用 `compile_error!` 叫你開 `wasm_js` feature | 在你的 wasm crate 直接加 `getrandom` 並開 feature，版本要跟 `rand` 用的那版一致（`cargo tree -i getrandom` 可查）：`rand` 0.10 用 `cargo add getrandom@0.4 --features wasm_js`；`rand` 0.9 用 getrandom 0.3，0.3.4 起同樣只要開 `wasm_js`；`rand` 0.8 用 getrandom 0.2，開的是 `js` feature |
| `tokio`（`full` 或含 `net`） | 編不過（底層的 mio 直接報錯） | `wasm-bindgen-futures` |
| `reqwest` | **可用**，wasm target 下改走瀏覽器 fetch，但功能子集較小 | 或直接用 `web-sys` 的 `fetch` |

`Instant` 那一列是本節最重要的一行——**它編得過**，所以你以為沒事，直到使用者回報「按鈕按了整頁就死了」。有了 `console_error_panic_hook`（18.9 節那段 `on_load`），你至少能在 console 看到 `time not implemented on this platform` 與出事的位置，而不是一句 `RuntimeError: unreachable`。

> **實務做法**：用 `#[cfg(target_arch = "wasm32")]` 把平台相關的部分隔離掉，讓核心邏輯保持平台無關：
>
> ```rust
> #[cfg(target_arch = "wasm32")]
> fn now_ms() -> f64 { js_sys::Date::now() }
>
> #[cfg(not(target_arch = "wasm32"))]
> fn now_ms() -> f64 {
>     use std::time::{SystemTime, UNIX_EPOCH};
>     SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as f64
> }
> ```
>
> （wasm32 那一支需要 `js-sys`。`js-sys` 在原生平台也編得過，放在一般的 `[dependencies]` 就行，`#[cfg]` 保證原生版本不會呼叫到它；如果想讓原生建置完全不碰它，可以改放到 `[target.'cfg(target_arch = "wasm32")'.dependencies]` 底下。）
>
> 這樣同一個 crate 既能編成後端服務的一部分，也能編成前端的 `.wasm`——**這正是 Rust + WASM 最實際的價值：前後端共用一份規則**。

---

## 18.14 接進前端專案與發佈

### Vite

```bash
wasm-pack build --target web --out-dir ../frontend/src/wasm
```

```js
import init, { grayscale } from './wasm/img_tools.js';
await init();
```

`--target web` 在 Vite 下最省事，因為它就是標準 ES Module。如果你想用 `--target bundler` 直接 `import` 而不 `init()`，Vite 需要另外裝 `vite-plugin-wasm`（如果 Vite 版本較舊、或 `build.target` 設成不支援 top-level await 的瀏覽器，還要加 `vite-plugin-top-level-await`）；webpack 5 則原生支援（要開 `experiments.asyncWebAssembly`）。

### 發佈到 npm

`wasm-pack` 產出的 `pkg/` 本來就是一個完整的 npm 套件：

```bash
wasm-pack build --target bundler --scope your-org
wasm-pack publish              # 等同在 pkg/ 裡跑 npm publish
```

要調整套件名稱、描述、授權，改 `Cargo.toml` 就好——`wasm-pack` 會把 `[package]` 的資訊寫進生成的 `package.json`。

### 部署注意事項

- **伺服器要對 `.wasm` 回 `Content-Type: application/wasm`**。少了它，`WebAssembly.instantiateStreaming` 會失敗；wasm-bindgen 產生的膠水會在 console 印一則警告，然後退回較慢的非串流載入（自己手寫載入程式的話，通常就直接報錯了）。
- **一定要開 gzip 或 brotli 壓縮**。`.wasm` 壓縮率很好，常常能省一半以上。
- **`pkg/` 不要進版控**，跟 `target/` 一樣是建構產物，由 CI 重新產生。wasm-pack 已經在 `pkg/` 裡放了一個內容為 `*` 的 `.gitignore`，所以預設就不會被 commit；若改用 `--out-dir` 輸出到前端專案裡，記得確認那個目錄也被忽略。
- **確認目標瀏覽器夠新**。Rust 1.82 起，`wasm32-unknown-unknown` 預設開啟 reference-types、multivalue 等 WebAssembly 擴充功能，之後的版本又加上 bulk-memory 等（`rustc --print cfg --target wasm32-unknown-unknown | grep target_feature` 可以看到完整清單），wasm-bindgen 產生的膠水也直接用上這些功能。2021 年底以後的主流瀏覽器（Chrome 96、Firefox 79、Safari 15 以上）都支援；如果非得支援更舊的瀏覽器，得用 nightly 工具鏈以 `-Ctarget-cpu=mvp` 搭配 `-Zbuild-std` 重編標準庫，門檻不低。

---

## 18.15 常見錯誤

- **`Cargo.toml` 漏了 `crate-type = ["cdylib"]`** → `wasm-pack build` 報錯：`crate-type must be cdylib to compile to WebAssembly`。**第一號地雷**，出問題先檢查這行。
- **忘記 `await init()` 就呼叫函式** → 得到 `TypeError: Cannot read properties of undefined (reading 'add')` 這種莫名錯誤。`--target web` 下 init 是**必須**的。
- **用 `file://` 直接開 `index.html`** → ES Module 與 WASM 載入都被瀏覽器擋。一定要起 HTTP 伺服器。
- **找不到 `pkg/xxx.js`** → 檢查連字號 vs 底線：package `img-tools` 產出的是 `img_tools.js`。
- **`unresolved import web_sys::XXX`、`no method named ... found for struct Window`** → `web-sys` 的 feature 沒開。錯誤訊息多半不會告訴你缺哪個，到 docs.rs 查那個型別或方法的 feature 說明。
- **用了 `std::time::Instant` 或 `SystemTime::now()`** → 編譯通過但執行期 panic（`time not implemented on this platform`）。用 `js_sys::Date::now()` 或 `performance.now()`。
- **原生的 `cargo test` 走到會建立 `JsValue` 的程式碼** → panic：`function not implemented on non-wasm32 targets`，整個測試程式中止。這類測試改用 `wasm-bindgen-test`，或把核心邏輯和 `JsValue` 拆開（18.11）。
- **沒裝 `console_error_panic_hook`** → panic 時 console 只看到 `RuntimeError: unreachable`（Firefox 寫作 `unreachable executed`），完全查不到原因。**這是每個 WASM 專案的標配**，別省。
- **WASM 記憶體成長後沒重建 `Uint8Array` view** → 舊的 `ArrayBuffer` 被 detach，舊 view 的長度變成 0，讀出來是 `undefined`，寫入（`.set()`）直接拋 `TypeError`。零複製寫法（18.9 寫法 B）務必**每次重新建立 view**。
- **`#[wasm_bindgen] struct` 用完沒呼叫 `.free()`** → 只能等 GC 回收 JS 物件後由 `FinalizationRegistry` 補釋放，時機完全不保證；大量建立大 buffer 時，WASM 記憶體會先一路長上去（而且不會縮回來）。這是所有權跨語言邊界的代價：**Rust 的 drop 語意沒辦法準時延伸到 JS 那側**，大塊資料請手動釋放。
- **在迴圈裡高頻呼叫跨界函式** → WASM 版比 JS 還慢。回到 18.8 的原則：**邊界要粗**。
- **試圖 `cargo add tokio --features full`** → wasm target 編不過（mio 報 `This wasm target is unsupported by mio`）。用 `wasm-bindgen-futures`。
- **用了 `rand` 卻沒設定 `getrandom`** → 編譯錯誤，要你開 `wasm_js` feature。照 18.13 的表格加上對應版本的 `getrandom`。
- **`cargo build --target wasm32-unknown-unknown` 之後直接找 `.wasm` 來用** → 那顆是**沒跑過 wasm-bindgen** 的原始產物，只認得數字，字串與 struct 全都不能用。**要用 `wasm-pack build`。**

---

## 18.16 本章小結

- **WASM 是掛在 JS 旁邊的計算引擎**，不是 JS 的替代品。適合密集數值運算與程式碼重用，不適合大量 DOM 操作與輕量小資料。
- 工具鏈分工：`wasm32-unknown-unknown`（編給誰跑）→ `wasm-bindgen`（讓字串/struct 能跨界的翻譯官）→ `wasm-opt`（瘦身）→ `wasm-pack`（把前面全部串起來，並包成 npm 套件）。
- `Cargo.toml` 必須有 **`crate-type = ["cdylib", "rlib"]`**；`--target web` 是學習與 Vite 的首選，`bundler` 給 webpack，`nodejs` 給 Node。
- 跨界成本：數字零成本；字串要 UTF-16 ↔ UTF-8 轉碼；`&[u8]` 進出各複製一次；`#[wasm_bindgen] struct` 讓資料留在 WASM 裡、JS 只拿把手。**設計原則是邊界要粗**。
- 錯誤用 `Result<T, JsValue>` 跨界，在 JS 那側變成可 `try/catch` 的 throw；**`console_error_panic_hook` 是標配**。
- 非同步用 `wasm-bindgen-futures` 的 `JsFuture`，`async fn` 對 JS 就是回傳 Promise；**瀏覽器裡沒有 Tokio 多執行緒 runtime**。
- 測試分兩層：純邏輯用 `cargo test`（快），碰到 `JsValue` 或瀏覽器 API 才用 `wasm-pack test --headless`；`--node` 只跑沒設 `run_in_browser` 的測試檔。
- 體積要顧：`opt-level`、`lto`（`crate-type` 有 `rlib` 時不會生效）、`codegen-units = 1`，加上 wasm-pack 自動跑的 `wasm-opt`；每個設定都要量過才算數，用 `twiggy` 找兇手，伺服器開壓縮並送對 `Content-Type: application/wasm`。
- WASM 沒有 OS：`fs`、`net` 編得過但一律回 `Err`；`thread::spawn`、`Instant` / `SystemTime` **編得過但會 panic**——用 `#[cfg(target_arch = "wasm32")]` 隔離平台相關程式碼。

---

## 18.17 動手作業

1. 照 18.5 節把 `img-tools` 建起來，`wasm-pack build --target web` 成功，並在瀏覽器看到 `add` 與 `greet` 的輸出。打開 `pkg/img_tools.d.ts` 看一眼自動生成的 TypeScript 型別。
2. 完成 18.9 節的影像處理範例，載入一張真實照片跑灰階。用 `performance.now()` 量寫法 A 與寫法 B 的差距，再寫一個純 JS 的灰階迴圈量第三個數字——**三個數字放在一起比較**，寫下你的結論。
3. 新增一個 `blur(rgba: &[u8], width: u32, height: u32) -> Result<Vec<u8>, JsValue>`，做 3×3 均值模糊。注意邊界像素的處理，並在長度與 `width * height * 4` 對不上時回傳 `Err`。
4. 故意在某個函式裡寫 `panic!("test")`，先**註解掉** `console_error_panic_hook::set_once()` 跑一次，再打開跑一次，比較 console 訊息的差別。
5. 把 `[profile.release]` 那四行**逐一**加上去，每加一行就 `ls -lh pkg/*.wasm` 記錄體積，做成一張表。再用 `twiggy top` 找出最肥的三個項目。
6. 用 `wasm-bindgen-test` 寫兩個測試檔：一個不加 `run_in_browser`，用 `wasm-pack test --node` 跑；一個加 `run_in_browser`，用 `--headless --chrome`（或 `--firefox`）跑起來。
7. 用 `#[cfg(target_arch = "wasm32")]` 寫一個 `now_ms()`，讓同一個 crate **既能 `cargo test`（原生）也能 `wasm-pack build`（WASM）**，兩邊都要通過。

---

## 18.18 驗收清單

- [ ] 我能說出 WASM 適合與不適合的工作各是什麼，並解釋「邊界要粗」的理由。
- [ ] 我分得清 `wasm32-unknown-unknown`、`wasm-bindgen`、`wasm-pack`、`web-sys` 各自的角色。
- [ ] 我知道 `crate-type = ["cdylib", "rlib"]` 為什麼兩個都要寫。
- [ ] 我能說出四種 `--target` 的差別，並在 Vite 專案裡選對。
- [ ] 我看得懂 `pkg/` 裡每個檔案的用途。
- [ ] 我知道數字、字串、`&[u8]`、struct 跨界時各自的成本。
- [ ] 我會用 `Result<T, JsValue>` 把錯誤丟到 JS，並知道要裝 `console_error_panic_hook`。
- [ ] 我知道零複製寫法為何要每次重建 `Uint8Array` view，以及 struct 為何要 `.free()`。
- [ ] 我知道瀏覽器 WASM 裡不能用 Tokio 多執行緒，非同步要走 `wasm-bindgen-futures`。
- [ ] 我會用 `wasm-pack test --headless` 在真瀏覽器跑測試，也知道純邏輯該用 `cargo test`。
- [ ] 我會用 profile 設定與 `twiggy` 把 `.wasm` 體積壓下來並找出兇手。
- [ ] 我記得 `Instant` / `SystemTime` 在 WASM 會 panic，並知道怎麼用 `#[cfg]` 隔離。

---

## 18.19 延伸：一個完整的 WASM 實戰專案

本章教的是**工具鏈與心智模型**。如果你想看一個「從頭到尾用 WASM 做出可上線功能」的完整專案，本 repo 另有一門[前端圖片加密課程](../image-encryption-course/README.md)，其中：

- [第 05 章](../image-encryption-course/05-rust-wasm-toolchain.md) 從加解密的角度再走一次 wasm-pack 工具鏈，並示範直接操作 WASM 線性記憶體的極致效能寫法。
- [第 06 章](../image-encryption-course/06-wasm-decryption-in-browser.md) 用 WASM 做圖片解密，含與 JS 版的效能對比。
- [`frontend/wasm-crypto/`](../image-encryption-course/frontend/wasm-crypto/) 是可直接編譯的完整原始碼。

兩門課的角度不同：那邊關心的是「**逆向成本**」（把演算法藏進 `.wasm` 讓人不好偷），這邊關心的是「**工程交付**」（型別、測試、體積、平台限制、程式碼重用）。搭配著看效果最好。

---

**WASM 路線完成！** 你手上現在有了 Rust 的第三種交付形式：

```text
後端服務（01~14）   → 跑在你的伺服器上
GPU 運算（15~17）   → 跑在你的顯示卡上
WebAssembly（18）   → 跑在使用者的瀏覽器裡
```

同一套所有權、型別系統、錯誤處理的功夫，換三個地方發揮。最實際的收穫是：**你可以把驗證規則、計費邏輯、資料解析這類「前後端都需要、但兩邊寫兩次一定會不一致」的核心邏輯，抽成一個 crate，後端直接依賴、前端編成 `.wasm`**——一份程式碼、一份測試、兩邊行為保證相同。這是很多團隊嚮往但用其他技術很難做到的事。

回到 [課程首頁](./README.md) 複習任何章節。🦀🕸️
