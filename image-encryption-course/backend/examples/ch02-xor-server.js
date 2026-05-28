// 對應章節：Chapter 02 - XOR 全檔加密 demo
//
// 跑起來後，前端打開 ../frontend/examples/ch02-xor.html
'use strict';

const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { v4: uuid } = require('uuid');
const { xorBuffer, randomKey } = require('../lib/xor');

const ENC_DIR = path.join(__dirname, '..', 'data', 'encrypted', 'ch02');
fs.mkdirSync(ENC_DIR, { recursive: true });

const META_FILE = path.join(ENC_DIR, '_meta.json');
const load = () => (fs.existsSync(META_FILE) ? JSON.parse(fs.readFileSync(META_FILE, 'utf-8')) : {});
const save = (d) => fs.writeFileSync(META_FILE, JSON.stringify(d, null, 2));

const app = express();
app.use(cors());

const FRONTEND = path.resolve(__dirname, '..', '..', 'frontend');
app.use(express.static(FRONTEND));

const upload = multer({ storage: multer.memoryStorage() });

app.post('/api/upload', upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no file' });

  const id = uuid();
  const key = randomKey(32);
  const enc = xorBuffer(req.file.buffer, key);

  fs.writeFileSync(path.join(ENC_DIR, `${id}.enc`), enc);

  const meta = load();
  meta[id] = {
    id,
    mime: req.file.mimetype,
    size: req.file.size,
    keyHex: key.toString('hex'),
    createdAt: Date.now(),
  };
  save(meta);

  res.json({ id, size: req.file.size });
});

app.get('/api/image/:id.enc', (req, res) => {
  const file = path.join(ENC_DIR, `${req.params.id}.enc`);
  if (!fs.existsSync(file)) return res.status(404).end();
  res.set('Content-Type', 'application/octet-stream');
  res.set('X-Content-Type-Options', 'nosniff');
  fs.createReadStream(file).pipe(res);
});

// 簡化：未做 token 驗證，僅 demo
app.get('/api/image/:id/key', (req, res) => {
  const m = load()[req.params.id];
  if (!m) return res.status(404).end();
  res.json({ keyHex: m.keyHex, mime: m.mime, size: m.size });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[Ch02 XOR] http://localhost:${PORT}/examples/ch02-xor.html`);
});
