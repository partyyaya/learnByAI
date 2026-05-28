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
const {
  HEADER_LEN, encryptHeader, wrapKey, unwrapKey, hmacSign, hmacVerify,
} = require('./lib/crypto-util');
const {
  hashPassword, verifyPassword, signJwt, authMiddleware, JWT_SECRET,
} = require('./lib/auth');

// === Master Key 檢查 ===
const MASTER_KEY_HEX = process.env.MASTER_KEY
  || '0000000000000000000000000000000000000000000000000000000000000000';
const MASTER_KEY = Buffer.from(MASTER_KEY_HEX, 'hex');
if (MASTER_KEY.length !== 32) {
  throw new Error('MASTER_KEY must be 64 hex chars (32 bytes)');
}
if (MASTER_KEY_HEX === '00'.repeat(32)) {
  console.warn('[WARN] using default MASTER_KEY — demo only!');
}

const ENC_DIR = path.join(__dirname, 'data', 'encrypted');

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

app.post('/api/register', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'missing fields' });
  }
  const id = uuid();
  try {
    db.prepare(
      'INSERT INTO users (id, username, passwordHash, createdAt) VALUES (?,?,?,?)'
    ).run(id, username, hashPassword(password), Date.now());
  } catch {
    return res.status(409).json({ error: 'username taken' });
  }
  res.json({ token: signJwt({ userId: id, username }) });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!u || !verifyPassword(password, u.passwordHash)) {
    return res.status(401).json({ error: 'bad credentials' });
  }
  res.json({ token: signJwt({ userId: u.id, username: u.username }) });
});

// === Upload (Chapter 03 加密 + Chapter 04 wrap key) ===

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
});

app.post('/api/upload', authMiddleware, upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no file' });

  const visibility = ['public', 'friends', 'private'].includes(req.body.visibility)
    ? req.body.visibility
    : 'private';

  const id = uuid();
  const imgKey = crypto.randomBytes(32);
  const iv = crypto.randomBytes(16);
  const encrypted = encryptHeader(req.file.buffer, imgKey, iv);

  fs.writeFileSync(path.join(ENC_DIR, `${id}.enc`), encrypted);

  db.prepare(`
    INSERT INTO images
      (id, ownerId, mime, headerLen, ivHex, wrappedKey, visibility, createdAt)
    VALUES (?,?,?,?,?,?,?,?)
  `).run(
    id, req.user.userId, req.file.mimetype, HEADER_LEN,
    iv.toString('hex'),
    wrapKey(imgKey.toString('hex'), MASTER_KEY),
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

app.get('/api/image/:id/sign', authMiddleware, (req, res) => {
  const img = db.prepare('SELECT * FROM images WHERE id = ?').get(req.params.id);
  if (!img) return res.status(404).end();
  if (!permitted(img, req.user.userId)) return res.status(403).json({ error: 'forbidden' });

  const exp = Date.now() + 60 * 1000;
  const payload = `${img.id}|${req.user.userId}|${exp}`;
  const sig = hmacSign(JWT_SECRET, payload);

  res.json({
    keyUrl: `/api/image/${img.id}/key?u=${req.user.userId}&exp=${exp}&sig=${sig}`,
    encUrl: `/api/image/${img.id}.enc`,
  });
});

// === Key API ===

const keyLimiter = rateLimit({ windowMs: 60 * 1000, max: 60, standardHeaders: true });

app.get('/api/image/:id/key', keyLimiter, (req, res) => {
  const { u, exp, sig } = req.query;
  if (!u || !exp || !sig) return res.status(400).end();
  if (Date.now() > Number(exp)) return res.status(403).json({ error: 'expired' });

  const payload = `${req.params.id}|${u}|${exp}`;
  if (!hmacVerify(JWT_SECRET, payload, String(sig))) {
    return res.status(403).json({ error: 'bad sig' });
  }

  const img = db.prepare('SELECT * FROM images WHERE id = ?').get(req.params.id);
  if (!img) return res.status(404).end();

  const imgKeyHex = unwrapKey(img.wrappedKey, MASTER_KEY);
  res.json({
    keyHex: imgKeyHex,
    ivHex: img.ivHex,
    headerLen: img.headerLen,
    mime: img.mime,
  });
});

// === Encrypted asset ===

const encLimiter = rateLimit({ windowMs: 60 * 1000, max: 120, standardHeaders: true });

app.get('/api/image/:id.enc', encLimiter, (req, res) => {
  const file = path.join(ENC_DIR, `${req.params.id}.enc`);
  if (!fs.existsSync(file)) return res.status(404).end();
  res.set('Content-Type', 'application/octet-stream');
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Cache-Control', 'private, max-age=300');
  fs.createReadStream(file).pipe(res);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[Image Vault] http://localhost:${PORT}`);
  console.log(`[Image Vault] open ${FRONTEND}/login.html via the URL above`);
});
