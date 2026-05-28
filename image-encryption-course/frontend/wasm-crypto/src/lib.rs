// 對應章節：
//   add / greet           → Chapter 05（toolchain 驗證用）
//   xor_inplace           → Chapter 05、Chapter 06（純 XOR 解密）
//   aes_ctr_decrypt       → Chapter 06（全檔 AES-CTR）
//   aes_ctr_decrypt_header→ Chapter 06、Chapter 07、Chapter 08（檔頭 AES-CTR）

use wasm_bindgen::prelude::*;

use aes::Aes256;
use aes::cipher::{KeyIvInit, StreamCipher};
use ctr::Ctr64BE;

type Aes256Ctr = Ctr64BE<Aes256>;

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

#[wasm_bindgen]
pub fn xor_inplace(data: &mut [u8], key: &[u8]) {
    let kl = key.len();
    if kl == 0 { return; }
    for i in 0..data.len() {
        data[i] ^= key[i % kl];
    }
}

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

// === Chapter 06：AES-CTR 全檔 ===

#[wasm_bindgen]
pub fn aes_ctr_decrypt(data: &mut [u8], key: &[u8], iv: &[u8]) -> Result<(), JsError> {
    check_key_iv(key, iv)?;
    let mut cipher = Aes256Ctr::new(key.into(), iv.into());
    cipher.apply_keystream(data);
    Ok(())
}

// === Chapter 06 / 07 / 08：AES-CTR 只解前 N byte ===

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
