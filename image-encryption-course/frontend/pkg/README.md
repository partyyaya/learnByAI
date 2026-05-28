# pkg/ (wasm 編譯產物)

這個資料夾的內容由 `wasm-pack` 產生，**不要手改也不要 commit**。

請到 `../wasm-crypto/` 跑：

```bash
wasm-pack build --target web --release --out-dir ../pkg
```

build 完後這裡會出現：

- `img_crypto.js`
- `img_crypto_bg.wasm`
- `img_crypto.d.ts`
- `package.json`

前端透過 `import init, { ... } from '/pkg/img_crypto.js'` 載入。
