// 對應章節：Chapter 04 - 全檔 AES-GCM + key wrap + 簽名 URL demo
//
// 跑起來後，前端打開 ../frontend/examples/ch04-aes.html
'use strict';

const express = require('express');
const multer = require('multer');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { v4: uuid } = require('uuid');
const { encrypt } = require('../lib/aes-gcm');
const { wrapKey, unwrapKey, hmacSign, hmacVerify } = require('../lib/crypto-util');

const MASTER_KEY_HEX = process.env.MASTER_KEY
  || '0000000000000000000000000000000000000000000000000000000000000000';
const MASTER_KEY = Buffer.from(MASTER_KEY_HEX, 'hex');
if (MASTER_KEY.length !== 32) throw new Error('MASTER_KEY must be 64 hex chars');

const SIGN_SECRET = process.env.JWT_SECRET || 'demo-sign-secret';

const ENC_DIR = path.join(__dirname, '..', 'data', 'encrypted', 'ch04');
fs.mkdirSync(ENC_DIR, { recursive: true });

const META_FILE = path.join(ENC_DIR, '_meta.json');
const load = () => (fs.existsSync(META_FILE) ? JSON.parse(fs.readFileSync(META_FILE, 'utf-8')) : {});
const save = (d) => fs.writeFileSync(META_FILE, JSON.stringify(d, null, 2));

const app = express();
app.use(cors());
app.use(express.json());

const FRONTEND = path.resolve(__dirname, '..', '..', 'frontend');
app.use(express.static(FRONTEND));

const upload = multer({ storage: multer.memoryStorage() });

app.post('/api/upload', upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no file' });

  const id = uuid();
  const { encrypted, keyHex } = encrypt(req.file.buffer);
  fs.writeFileSync(path.join(ENC_DIR, `${id}.enc`), encrypted);

  const meta = load();
  meta[id] = {
    id,
    mime: req.file.mimetype,
    wrappedKey: wrapKey(keyHex, MASTER_KEY),
    createdAt: Date.now(),
  };
  save(meta);

  res.json({ id });
});

// 簽名 URL：60 秒有效，綁定 userId（demo 簡化成固定 'demo-user'）
app.get('/api/image/:id/sign', (req, res) => {
  const meta = load()[req.params.id];
  if (!meta) return res.status(404).end();

  const userId = 'demo-user';
  const exp = Date.now() + 60 * 1000;
  const payload = `${req.params.id}|${userId}|${exp}`;
  const sig = hmacSign(SIGN_SECRET, payload);

  res.json({
    keyUrl: `/api/image/${req.params.id}/key?u=${userId}&exp=${exp}&sig=${sig}`,
    encUrl: `/api/image/${req.params.id}.enc`,
  });
});

app.get('/api/image/:id/key', (req, res) => {
  const { u, exp, sig } = req.query;
  if (Date.now() > Number(exp)) return res.status(403).json({ error: 'expired' });

  const payload = `${req.params.id}|${u}|${exp}`;
  if (!hmacVerify(SIGN_SECRET, payload, String(sig))) {
    return res.status(403).json({ error: 'bad sig' });
  }

  const meta = load()[req.params.id];
  if (!meta) return res.status(404).end();

  res.json({
    keyHex: unwrapKey(meta.wrappedKey, MASTER_KEY),
    mime: meta.mime,
  });
});

app.get('/api/image/:id.enc', (req, res) => {
  const file = path.join(ENC_DIR, `${req.params.id}.enc`);
  if (!fs.existsSync(file)) return res.status(404).end();
  res.set('Content-Type', 'application/octet-stream');
  res.set('X-Content-Type-Options', 'nosniff');
  fs.createReadStream(file).pipe(res);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[Ch04 AES-GCM] http://localhost:${PORT}/examples/ch04-aes.html`);
});
