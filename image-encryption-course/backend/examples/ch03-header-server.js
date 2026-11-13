// 對應章節：Chapter 03 - 只加密檔頭（AES-CTR）demo
//
// 跑起來後，前端打開 http://localhost:3000/examples/ch03-header.html
// Chapter 06 的 WASM 解密頁也共用這支 API
'use strict';

const express = require('express');
const multer = require('multer');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { v4: uuid } = require('uuid');
const { computeHeaderLen, encryptHeader } = require('../lib/crypto-util');

const ENC_DIR = path.join(__dirname, '..', 'data', 'encrypted', 'ch03');
fs.mkdirSync(ENC_DIR, { recursive: true });

const META_FILE = path.join(ENC_DIR, '_meta.json');
const load = () => (fs.existsSync(META_FILE) ? JSON.parse(fs.readFileSync(META_FILE, 'utf-8')) : {});
const save = (d) => fs.writeFileSync(META_FILE, JSON.stringify(d, null, 2));

// id 只接受 UUID：Express 會把 %2F 解碼成 /，不檢查的話 ..%2F 能讀到資料夾外的檔案
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const app = express();
app.use(cors());

const FRONTEND = path.resolve(__dirname, '..', '..', 'frontend');
app.use(express.static(FRONTEND));

const upload = multer({ storage: multer.memoryStorage() });

app.post('/api/upload', upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no file' });

  const id = uuid();
  const key = crypto.randomBytes(32);
  const iv = crypto.randomBytes(16);
  const headerLen = computeHeaderLen(req.file.buffer);   // 每張圖各自算加密範圍
  const encrypted = encryptHeader(req.file.buffer, key, iv, headerLen);

  fs.writeFileSync(path.join(ENC_DIR, `${id}.enc`), encrypted);

  const meta = load();
  meta[id] = {
    id,
    mime: req.file.mimetype,
    headerLen,
    keyHex: key.toString('hex'),
    ivHex: iv.toString('hex'),
    algorithm: 'aes-256-ctr-header',
    createdAt: Date.now(),
  };
  save(meta);

  res.json({ id, headerLen, size: req.file.size });
});

app.get('/api/image/:id.enc', (req, res) => {
  if (!ID_RE.test(req.params.id)) return res.status(404).end();
  const file = path.join(ENC_DIR, `${req.params.id}.enc`);
  if (!fs.existsSync(file)) return res.status(404).end();
  res.set('Content-Type', 'application/octet-stream');
  res.set('X-Content-Type-Options', 'nosniff');
  fs.createReadStream(file).pipe(res);
});

// demo 簡化：沒做身分驗證（第 07 章補上）
app.get('/api/image/:id/key', (req, res) => {
  const m = load()[req.params.id];
  if (!m) return res.status(404).end();
  res.set('Cache-Control', 'no-store');
  res.json({
    keyHex: m.keyHex,
    ivHex: m.ivHex,
    headerLen: m.headerLen,
    mime: m.mime,
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[Ch03 Header-AES] http://localhost:${PORT}/examples/ch03-header.html`);
});
