// 對應章節：Chapter 08 - 畢業專題（整合 Chapter 03/04/06/07 所有概念）
'use strict';

const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { v4: uuid } = require('uuid');

const db = require('./db');
const { detectImageType } = require('./lib/image-format');
const {
  computeHeaderLen, encryptHeader, deriveKey, wrapKey, unwrapKey, hmacSign, hmacVerify,
} = require('./lib/crypto-util');
const {
  hashPassword, verifyPassword, signJwt, authMiddleware,
} = require('./lib/auth');

// === Master Key：沒設就不啟動 ===
const MASTER_KEY = Buffer.from(process.env.MASTER_KEY || '', 'hex');
if (MASTER_KEY.length !== 32) {
  throw new Error('MASTER_KEY is required: 64 hex chars (32 bytes)（啟動方式見 backend/README.md）');
}
// 同一把 master key 衍生出兩把用途不同的 key
const KEY_WRAP_KEY = deriveKey(MASTER_KEY, 'image-key-wrap');   // 包裝每張圖的 key
const URL_SIGN_KEY = deriveKey(MASTER_KEY, 'key-url-sign');     // 簽 key URL

const ENC_DIR = path.join(__dirname, 'data', 'encrypted');
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const app = express();
app.use(cors());
app.use(express.json());

// 服務前端靜態檔（同 repo 的 ../frontend）
const FRONTEND = path.resolve(__dirname, '..', 'frontend');
if (fs.existsSync(FRONTEND)) {
  app.use(express.static(FRONTEND));
  console.log('[INFO] serving frontend from', FRONTEND);
}

// === Auth ===

// 登入、註冊依 IP 限流，擋暴力猜密碼
const authLimiter = rateLimit({ windowMs: 60 * 1000, max: 20, standardHeaders: true });

function readCredentials(req) {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
    return null;
  }
  return { username, password };
}

app.post('/api/register', authLimiter, (req, res) => {
  const cred = readCredentials(req);
  if (!cred) return res.status(400).json({ error: 'missing fields' });
  const id = uuid();
  try {
    db.prepare(
      'INSERT INTO users (id, username, passwordHash, createdAt) VALUES (?,?,?,?)'
    ).run(id, cred.username, hashPassword(cred.password), Date.now());
  } catch {
    return res.status(409).json({ error: 'username taken' });
  }
  res.json({ token: signJwt({ userId: id, username: cred.username }) });
});

app.post('/api/login', authLimiter, (req, res) => {
  const cred = readCredentials(req);
  if (!cred) return res.status(400).json({ error: 'missing fields' });
  const u = db.prepare('SELECT * FROM users WHERE username = ?').get(cred.username);
  if (!u || !verifyPassword(cred.password, u.passwordHash)) {
    return res.status(401).json({ error: 'bad credentials' });
  }
  res.json({ token: signJwt({ userId: u.id, username: u.username }) });
});

// === Friends：把對方加為好友後，對方可以看你 visibility = friends 的圖 ===

app.post('/api/friends', authMiddleware, (req, res) => {
  const { username } = req.body || {};
  if (typeof username !== 'string' || !username) return res.status(400).json({ error: 'missing username' });
  const friend = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (!friend) return res.status(404).json({ error: 'no such user' });
  if (friend.id === req.user.userId) return res.status(400).json({ error: 'cannot add yourself' });
  db.prepare('INSERT OR IGNORE INTO friends (a, b) VALUES (?, ?)').run(req.user.userId, friend.id);
  res.json({ ok: true });
});

// === Upload (Chapter 03 加密 + Chapter 04 wrap key) ===

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
});

app.post('/api/upload', authMiddleware, upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no file' });

  // 用 magic number 判斷格式，不信任瀏覽器送來的 mimetype
  const mime = detectImageType(req.file.buffer);
  if (!mime) return res.status(415).json({ error: 'not a supported image' });

  const visibility = ['public', 'friends', 'private'].includes(req.body.visibility)
    ? req.body.visibility
    : 'private';

  const id = uuid();
  const imgKey = crypto.randomBytes(32);
  const iv = crypto.randomBytes(16);
  const headerLen = computeHeaderLen(req.file.buffer);
  const encrypted = encryptHeader(req.file.buffer, imgKey, iv, headerLen);

  fs.writeFileSync(path.join(ENC_DIR, `${id}.enc`), encrypted);

  db.prepare(`
    INSERT INTO images
      (id, ownerId, mime, headerLen, ivHex, wrappedKey, visibility, createdAt)
    VALUES (?,?,?,?,?,?,?,?)
  `).run(
    id, req.user.userId, mime, headerLen,
    iv.toString('hex'),
    wrapKey(imgKey, KEY_WRAP_KEY, id),
    visibility, Date.now()
  );

  res.json({ id });
});

// === List ===

app.get('/api/images', authMiddleware, (req, res) => {
  const list = db.prepare(`
    SELECT id, mime, visibility, createdAt FROM images
    WHERE ownerId = ?
       OR visibility = 'public'
       OR (visibility = 'friends'
           AND ownerId IN (SELECT a FROM friends WHERE b = ?))
    ORDER BY createdAt DESC
  `).all(req.user.userId, req.user.userId);
  res.json(list);
});

// === Sign URL (Chapter 07) ===

function permitted(img, userId) {
  if (img.visibility === 'public') return true;
  if (img.ownerId === userId) return true;
  if (img.visibility === 'friends') {
    return !!db.prepare('SELECT 1 FROM friends WHERE a=? AND b=?').get(img.ownerId, userId);
  }
  return false;
}

// 依「帳號」限流：已登入的爬蟲換 IP 也沒用
const signLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  keyGenerator: (req) => req.user.userId,
});

app.get('/api/image/:id/sign', authMiddleware, signLimiter, (req, res) => {
  const img = db.prepare('SELECT * FROM images WHERE id = ?').get(req.params.id);
  if (!img) return res.status(404).end();
  if (!permitted(img, req.user.userId)) return res.status(403).json({ error: 'forbidden' });

  const exp = Date.now() + 60 * 1000;
  const payload = `${img.id}|${req.user.userId}|${exp}`;
  const sig = hmacSign(URL_SIGN_KEY, payload);

  res.json({
    keyUrl: `/api/image/${img.id}/key?u=${req.user.userId}&exp=${exp}&sig=${sig}`,
    encUrl: `/api/image/${img.id}.enc`,
  });
});

// === Key API ===

const keyLimiter = rateLimit({ windowMs: 60 * 1000, max: 120, standardHeaders: true });

app.get('/api/image/:id/key', keyLimiter, (req, res) => {
  const { u, exp, sig } = req.query;
  if (!u || !exp || !sig) return res.status(400).end();
  if (Date.now() > Number(exp)) return res.status(403).json({ error: 'expired' });

  const payload = `${req.params.id}|${u}|${exp}`;
  if (!hmacVerify(URL_SIGN_KEY, payload, sig)) {
    return res.status(403).json({ error: 'bad sig' });
  }

  const img = db.prepare('SELECT * FROM images WHERE id = ?').get(req.params.id);
  if (!img) return res.status(404).end();

  const imgKey = unwrapKey(img.wrappedKey, KEY_WRAP_KEY, img.id);
  res.set('Cache-Control', 'no-store');   // key 不要留在任何快取裡
  res.json({
    keyHex: imgKey.toString('hex'),
    ivHex: img.ivHex,
    headerLen: img.headerLen,
    mime: img.mime,
  });
});

// === Encrypted asset ===

const encLimiter = rateLimit({ windowMs: 60 * 1000, max: 240, standardHeaders: true });

app.get('/api/image/:id.enc', encLimiter, (req, res) => {
  // 只接受 UUID，避免 ..%2F 之類的路徑穿越
  if (!ID_RE.test(req.params.id)) return res.status(404).end();
  const file = path.join(ENC_DIR, `${req.params.id}.enc`);
  if (!fs.existsSync(file)) return res.status(404).end();
  res.set('Content-Type', 'application/octet-stream');
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Cache-Control', 'private, max-age=300');
  fs.createReadStream(file).pipe(res);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[Image Vault] http://localhost:${PORT}/login.html`);
});
