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

`wasm-pack build --release` 會自動跑一次 `wasm-opt`，不用另外裝 binaryen。

> `Cargo.toml` 的 `[profile.release]` 不要加 `strip = true`：它會把 `target_features` 區段一起刪掉，
> wasm-opt 不知道 bulk memory 已啟用，build 會以 `memory.copy operations require bulk memory` 失敗。

## 匯出的函式

| Function | 章節 | 用途 |
|----------|------|------|
| `add(a, b)` | Ch05 | toolchain hello |
| `greet(name)` | Ch05 | 字串傳遞 demo |
| `xor_inplace(data, key)` | Ch05、06 | 就地 XOR |
| `xor_decrypt(input, key)` | Ch06 | XOR + 回新 Vec |
| `xor_header(data, key, header_len)` | Ch06 | 只 XOR 前 N byte |
| `aes_ctr_decrypt(data, key, iv)` | Ch06、07、08 | AES-CTR，傳入哪段就解哪段（檔頭加密時傳 `buf.subarray(0, headerLen)`） |
| `aes_ctr_decrypt_header(data, key, iv, header_len)` | Ch06 | 傳入整個檔案、只解前 N byte（用來對比複製成本） |
| `wasm_alloc(size)` / `wasm_free(ptr, size)` / `xor_at_ptr(ptr, len, key_ptr, key_len)` | Ch06 | 直接操作 wasm linear memory |

AES-CTR 用 `Ctr128BE`（整個 16 byte IV 當計數器遞增），跟 Node 的 `aes-256-ctr` 完全一致。
