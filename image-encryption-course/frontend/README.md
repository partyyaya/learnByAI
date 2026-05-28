# Image Encryption Course · Frontend

純 HTML + ES Module 的前端，不需要打包工具。直接由後端的 `express.static` 服務。

## 章節對應

| 檔案 | 對應章節 | 說明 |
|------|----------|------|
| `index.html` | 入口頁 | 連到各章節 demo 與 capstone |
| `login.html` | **Chapter 08** | 註冊 / 登入 |
| `gallery.html` | **Chapter 08** | 圖庫主頁（上傳、列表、權限） |
| `secure-image.js` | Chapter 07、08 | `<secure-image>` Web Component：fetch → WASM 解密 → Canvas 渲染 + 浮水印 |
| `examples/ch02-xor.html` | Chapter 02 | XOR 全檔加解密 demo |
| `examples/ch03-header.html` | Chapter 03 | 只解前 N byte 的 AES-CTR demo（WebCrypto 版） |
| `examples/ch04-aes.html` | Chapter 04 | 全檔 AES-GCM + 簽名 URL demo |
| `examples/ch05-hello-wasm.html` | Chapter 05 | Rust + wasm-pack 的「Hello WASM」 |
| `examples/ch06-wasm-decrypt.html` | Chapter 06 | 用 WASM 做 AES-CTR 解密 |
| `wasm-crypto/` | Chapter 05、06、08 | Rust 原始碼，編譯後產物放到 `pkg/` |
| `pkg/` | Chapter 05+ | wasm-pack 編譯產物（gitignored，build 完才出現） |

## 安裝與啟動

### 編譯 WASM（Chapter 05 之後才需要）

```bash
cd wasm-crypto
wasm-pack build --target web --release --out-dir ../pkg
```

完成後 `frontend/pkg/` 會出現 `img_crypto.js`、`img_crypto_bg.wasm` 等檔。

### 啟動

前端**不需要自己起 server**，由後端服務：

```bash
# 在 backend/ 目錄
npm run start       # Chapter 08 整合版（推薦）
# 或
npm run ch02        # Chapter 02 demo
npm run ch03        # Chapter 03 demo
npm run ch04        # Chapter 04 demo
```

打開 `http://localhost:3000/` 進入入口頁。

## 注意事項

- `crypto.subtle` 與 `WebAssembly.instantiate` **必須** 在 HTTPS 或 `http://localhost` 環境，不能用 `file://`。
- 改完 Rust 後記得重 build wasm 並強制刷新瀏覽器（Cmd+Shift+R），瀏覽器會快取 wasm。
