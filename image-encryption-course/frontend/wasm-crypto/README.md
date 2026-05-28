# wasm-crypto · Rust 來源

對應章節：**Chapter 05、06、07、08**。

## 編譯

```bash
# 確認你已裝好（見 Ch05）
rustup target add wasm32-unknown-unknown
cargo install wasm-pack

# 編譯（產物會放到 ../pkg/）
wasm-pack build --target web --release --out-dir ../pkg
```

完成後 `frontend/pkg/` 會有：

```text
img_crypto.js              ← ES Module（前端 import 這個）
img_crypto_bg.wasm         ← 編譯產物
img_crypto.d.ts            ← TS 型別
package.json
```

## Optional：用 wasm-opt 進一步壓縮

```bash
brew install binaryen   # 或 apt install binaryen
wasm-opt -O3 --strip-debug -o ../pkg/img_crypto_bg.wasm ../pkg/img_crypto_bg.wasm
```

## 匯出的函式

| Function | 章節 | 用途 |
|----------|------|------|
| `add(a, b)` | Ch05 | toolchain hello |
| `greet(name)` | Ch05 | 字串傳遞 demo |
| `xor_inplace(data, key)` | Ch05、06 | 就地 XOR |
| `xor_decrypt(input, key)` | Ch05、06 | XOR + 回新 Vec |
| `aes_ctr_decrypt(data, key, iv)` | Ch06 | 全檔 AES-CTR |
| `aes_ctr_decrypt_header(data, key, iv, header_len)` | Ch06、07、08 | 只解前 N byte |
