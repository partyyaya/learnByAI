// 對應章節：
//   add / greet                       → Chapter 05（toolchain 驗證用）
//   xor_inplace / xor_decrypt         → Chapter 05、Chapter 06（純 XOR 解密）
//   xor_header                        → Chapter 06（只 XOR 前 N byte）
//   aes_ctr_decrypt                   → Chapter 06、07、08（AES-CTR，傳入哪段就解哪段）
//   aes_ctr_decrypt_header            → Chapter 06（傳入整個檔案、只解前 N byte）
//   wasm_alloc / wasm_free / xor_at_ptr → Chapter 06（直接操作 linear memory）

use wasm_bindgen::prelude::*;

use aes::Aes256;
use aes::cipher::{KeyIvInit, StreamCipher};
use ctr::Ctr128BE;

// Node 的 aes-256-ctr 把整個 16 byte IV 當 128 bit 計數器遞增，
// 這裡用 Ctr128BE 才會跟後端完全一致（Ctr64BE 只遞增低 64 bit）
type Aes256Ctr = Ctr128BE<Aes256>;

// === Chapter 05 hello demo ===

#[wasm_bindgen]
pub fn add(a: i32, b: i32) -> i32 {
    a + b
}

#[wasm_bindgen]
pub fn greet(name: &str) -> String {
    format!("Hello, {}!", name)
}

// === Chapter 05 / 06：XOR ===

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

#[wasm_bindgen]
pub fn xor_header(data: &mut [u8], key: &[u8], header_len: usize) {
    let kl = key.len();
    if kl == 0 { return; }
    let end = header_len.min(data.len());
    for i in 0..end {
        data[i] ^= key[i % kl];
    }
}

// === Chapter 06 / 07 / 08：AES-CTR ===
// 檔頭加密時，前端只把 buf.subarray(0, headerLen) 傳進來，
// wasm-bindgen 就只會複製這一小段，而不是整個檔案。

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

// === Chapter 06：直接操作 wasm linear memory ===

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
