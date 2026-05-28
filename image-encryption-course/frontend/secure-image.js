// 對應章節：Chapter 07（Canvas + 浮水印）、Chapter 08（capstone 整合）
//
// 使用：<secure-image image-id="xxx"></secure-image>
// 內部流程：取簽名 URL → 取 key + 密文 → WASM AES-CTR 解密 → Canvas 渲染 + 浮水印
'use strict';

import init, { aes_ctr_decrypt_header } from './pkg/img_crypto.js';

const wasmReady = init();

class SecureImage extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'closed' })
      .appendChild(document.createElement('div'));
  }

  static get observedAttributes() { return ['image-id']; }

  attributeChangedCallback() { this.render(); }

  async render() {
    await wasmReady;
    const id = this.getAttribute('image-id');
    if (!id) return;

    const root = this.shadowRoot.firstChild;
    root.textContent = 'Loading…';

    const jwt = localStorage.getItem('jwt');
    if (!jwt) { root.textContent = 'not logged in'; return; }

    try {
      const signRes = await fetch(`/api/image/${id}/sign`, {
        headers: { Authorization: `Bearer ${jwt}` },
      });
      if (!signRes.ok) {
        root.textContent = `Error ${signRes.status}`;
        return;
      }
      const { keyUrl, encUrl } = await signRes.json();

      const [meta, encBuf] = await Promise.all([
        fetch(keyUrl).then((r) => r.json()),
        fetch(encUrl).then((r) => r.arrayBuffer()),
      ]);

      const buf = new Uint8Array(encBuf);
      aes_ctr_decrypt_header(
        buf,
        hexToBytes(meta.keyHex),
        hexToBytes(meta.ivHex),
        meta.headerLen,
      );

      const bitmap = await createImageBitmap(new Blob([buf], { type: meta.mime }));
      const canvas = document.createElement('canvas');
      canvas.style.cssText = 'max-width:100%;display:block';
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      canvas.addEventListener('contextmenu', (e) => e.preventDefault());

      const ctx = canvas.getContext('2d');
      ctx.drawImage(bitmap, 0, 0);
      drawWatermark(ctx, canvas, jwt);

      bitmap.close();
      buf.fill(0);

      root.replaceChildren(canvas);
    } catch (e) {
      console.error('[secure-image] failed', e);
      root.textContent = 'decrypt failed';
    }
  }
}

function drawWatermark(ctx, canvas, jwt) {
  let uid = '';
  try {
    uid = JSON.parse(atob(jwt.split('.')[1])).userId?.slice(0, 8) ?? '';
  } catch { /* ignore */ }
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
