// 對應章節：Chapter 04 - 全檔 AES-GCM + key wrap + 簽名 URL demo
//
// 跑起來後，前端打開 http://localhost:3000/examples/ch04-aes.html
'use strict';

const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { v4: uuid } = require('uuid');
const { encrypt } = require('../lib/aes-gcm');
const { deriveKey, wrapKey, unwrapKey, hmacSign, hmacVerify } = require('../lib/crypto-util');

// master key 只存在伺服器，沒設就不啟動
const MASTER_KEY = Buffer.from(process.env.MASTER_KEY || '', 'hex');
if (MASTER_KEY.length !== 32) {
  throw new Error('MASTER_KEY is required: 64 hex chars（啟動方式見第 04 章）');
}
// 用途不同的 key 各自衍生，不共用同一把
const KEY_WRAP_KEY = deriveKey(MASTER_KEY, 'image-key-wrap');
const URL_SIGN_KEY = deriveKey(MASTER_KEY, 'key-url-sign');

const ENC_DIR = path.join(__dirname, '..', 'data', 'encrypted', 'ch04');
fs.mkdirSync(ENC_DIR, { recursive: true });

const META_FILE = path.join(ENC_DIR, '_meta.json');
const load = () => (fs.existsSync(META_FILE) ? JSON.parse(fs.readFileSync(META_FILE, 'utf-8')) : {});
const save = (d) => fs.writeFileSync(META_FILE, JSON.stringify(d, null, 2));

// id 只接受 UUID：Express 會把 %2F 解碼成 /，不檢查的話 ..%2F 能讀到資料夾外的檔案
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const app = express();
app.use(cors());
app.use(express.json());

const FRONTEND = path.resolve(__dirname, '..', '..', 'frontend');
app.use(express.static(FRONTEND));

const upload = multer({ storage: multer.memoryStorage() });

app.post('/api/upload', upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no file' });

  const id = uuid();
  const { encrypted, key } = encrypt(req.file.buffer);
  fs.writeFileSync(path.join(ENC_DIR, `${id}.enc`), encrypted);

  // 策略 B：資料庫只存「包裝過的 key」，master key 永遠不離開伺服器
  const meta = load();
  meta[id] = {
    id,
    mime: req.file.mimetype,
    wrappedKey: wrapKey(key, KEY_WRAP_KEY, id),
    createdAt: Date.now(),
  };
  save(meta);

  res.json({ id });
});

// 簽名 URL：60 秒有效。demo 簡化：沒做登入，userId 固定為 'demo-user'（第 07 章補上 JWT）
app.get('/api/image/:id/sign', (req, res) => {
  const meta = load()[req.params.id];
  if (!meta) return res.status(404).end();

  const userId = 'demo-user';
  const exp = Date.now() + 60 * 1000;
  const payload = `${req.params.id}|${userId}|${exp}`;
  const sig = hmacSign(URL_SIGN_KEY, payload);

  res.json({
    keyUrl: `/api/image/${req.params.id}/key?u=${userId}&exp=${exp}&sig=${sig}`,
    encUrl: `/api/image/${req.params.id}.enc`,
  });
});

app.get('/api/image/:id/key', (req, res) => {
  const { u, exp, sig } = req.query;
  if (!u || !exp || !sig) return res.status(400).end();
  if (Date.now() > Number(exp)) return res.status(403).json({ error: 'expired' });

  const payload = `${req.params.id}|${u}|${exp}`;
  if (!hmacVerify(URL_SIGN_KEY, payload, sig)) {
    return res.status(403).json({ error: 'bad sig' });
  }

  const meta = load()[req.params.id];
  if (!meta) return res.status(404).end();

  // 在伺服器端解開包裝，只把這張圖的 key 交出去
  const key = unwrapKey(meta.wrappedKey, KEY_WRAP_KEY, req.params.id);
  res.set('Cache-Control', 'no-store');
  res.json({ keyHex: key.toString('hex'), mime: meta.mime });
});

app.get('/api/image/:id.enc', (req, res) => {
  if (!ID_RE.test(req.params.id)) return res.status(404).end();
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
