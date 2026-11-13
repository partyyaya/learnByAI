// 對應章節：Chapter 07（Canvas + 浮水印）、Chapter 08（capstone 整合）
//
// 使用：<secure-image image-id="xxx"></secure-image>（JWT 從 localStorage 取）
// 內部流程：取簽名 URL → 取 key + 密文 → WASM AES-CTR 解密檔頭 → Canvas 渲染 + 浮水印

import init, { aes_ctr_decrypt } from './pkg/img_crypto.js';

const wasmReady = init();

class SecureImage extends HTMLElement {
  // closed 模式下 this.shadowRoot 永遠是 null，要自己把 attachShadow 的回傳值存起來
  #root;

  constructor() {
    super();
    this.#root = this.attachShadow({ mode: 'closed' });
  }

  static get observedAttributes() { return ['image-id']; }

  attributeChangedCallback() { this.render(); }

  async render() {
    const id = this.getAttribute('image-id');
    if (!id) return;
    this.#root.textContent = 'Loading…';

    const jwt = localStorage.getItem('jwt');
    if (!jwt) { this.#root.textContent = 'not logged in'; return; }

    try {
      await wasmReady;

      const signRes = await fetch(`/api/image/${id}/sign`, {
        headers: { Authorization: `Bearer ${jwt}` },
      });
      if (!signRes.ok) {
        this.#root.textContent = `Error ${signRes.status}`;
        return;
      }
      const { keyUrl, encUrl } = await signRes.json();

      const [meta, encBuf] = await Promise.all([
        fetch(keyUrl).then((r) => r.json()),
        fetch(encUrl).then((r) => r.arrayBuffer()),
      ]);

      // 只把加密的那一段交給 wasm：wasm-bindgen 會把傳進去的陣列複製進 wasm 記憶體、
      // 解完再寫回來，傳整個檔案就得多複製好幾 MB
      const buf = new Uint8Array(encBuf);
      aes_ctr_decrypt(
        buf.subarray(0, meta.headerLen),
        hexToBytes(meta.keyHex),
        hexToBytes(meta.ivHex),
      );

      const bitmap = await createImageBitmap(new Blob([buf], { type: meta.mime }));
      const canvas = document.createElement('canvas');
      canvas.style.cssText = 'max-width:100%;display:block';
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      // Chrome / Edge 的 canvas 右鍵選單有「另存圖片」，要自己擋掉
      canvas.addEventListener('contextmenu', (e) => e.preventDefault());

      const ctx = canvas.getContext('2d');
      ctx.drawImage(bitmap, 0, 0);
      drawWatermark(ctx, canvas, jwt);

      bitmap.close();
      this.#root.replaceChildren(canvas);
    } catch (e) {
      console.error('[secure-image] failed', e);
      this.#root.textContent = 'decrypt failed';
    }
  }
}

// JWT 用的是 base64url（- 和 _，沒有 =），不能直接丟給 atob；
// payload 是 UTF-8，中文帳號名稱要用 TextDecoder 解
function decodeJwtPayload(jwt) {
  const b64 = jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, '='));
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
}

function drawWatermark(ctx, canvas, jwt) {
  let uid = '';
  try {
    uid = decodeJwtPayload(jwt).userId?.slice(0, 8) ?? '';
  } catch { /* 解不開就只印時間 */ }
  const stamp = `${uid} · ${new Date().toLocaleString()}`;

  ctx.save();
  ctx.fillStyle = 'rgba(255,255,255,0.08)';
  ctx.font = '14px sans-serif';
  ctx.rotate(-Math.PI / 12);
  for (let y = -canvas.height; y < canvas.height * 2; y += 60) {
    for (let x = -canvas.width; x < canvas.width * 2; x += 240) {
      ctx.fillText(stamp, x, y);
    }
  }
  ctx.restore();
}

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return out;
}

customElements.define('secure-image', SecureImage);
