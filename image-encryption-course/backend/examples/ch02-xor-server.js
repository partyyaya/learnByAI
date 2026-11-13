// 對應章節：Chapter 02 - XOR 全檔加密 demo
//
// 跑起來後，前端打開 http://localhost:3000/examples/ch02-xor.html
'use strict';

const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { v4: uuid } = require('uuid');
const { xorBuffer, randomKey } = require('../lib/xor');

// 每章的資料各自放一個資料夾，互不干擾
const ENC_DIR = path.join(__dirname, '..', 'data', 'encrypted', 'ch02');
fs.mkdirSync(ENC_DIR, { recursive: true });

const META_FILE = path.join(ENC_DIR, '_meta.json');
const load = () => (fs.existsSync(META_FILE) ? JSON.parse(fs.readFileSync(META_FILE, 'utf-8')) : {});
const save = (d) => fs.writeFileSync(META_FILE, JSON.stringify(d, null, 2));

// id 只接受 UUID：Express 會把 %2F 解碼成 /，不檢查的話 ..%2F 能讀到資料夾外的檔案
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const app = express();
app.use(cors());

// 前端頁面由這裡一起服務，不用另外起伺服器
const FRONTEND = path.resolve(__dirname, '..', '..', 'frontend');
app.use(express.static(FRONTEND));

const upload = multer({ storage: multer.memoryStorage() });

// === 路由 1：上傳並加密 ===
app.post('/api/upload', upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no file' });

  const id = uuid();
  const key = randomKey(32);
  const enc = xorBuffer(req.file.buffer, key);

  fs.writeFileSync(path.join(ENC_DIR, `${id}.enc`), enc);

  // 把這張圖的「描述資訊」記到 meta 裡，給後續的 key API 用
  const meta = load();
  meta[id] = {
    id,                           // 跟 .enc 檔名一致，前端用它對應到密文檔
    mime: req.file.mimetype,      // 原圖的 MIME，前端解密後要靠它建 Blob
    size: req.file.size,          // 原圖大小（byte），給 debug / 前端顯示用
    keyHex: key.toString('hex'),  // ⚠️ 這張圖的 XOR key
                                  // demo 直接存明文很方便，正式環境不能這樣：
                                  //   1) 資料庫外洩 = 所有圖一次解密
                                  //   2) 應該用 master key 包裝後再存（第 04 章的 wrapKey）
                                  //   3) 或交給 KMS / Vault，程式只拿 reference
    createdAt: Date.now(),        // 建立時間（毫秒），用來做過期、排序、稽核
  };
  save(meta);
  // demo 簡化成「整檔重寫 JSON」，圖很多時應換成資料庫（見 backend/db.js）

  res.json({ id, size: req.file.size });
});

// === 路由 2：取得加密圖檔 ===
app.get('/api/image/:id.enc', (req, res) => {
  if (!ID_RE.test(req.params.id)) return res.status(404).end();
  const file = path.join(ENC_DIR, `${req.params.id}.enc`);
  if (!fs.existsSync(file)) return res.status(404).end();
  // 用 octet-stream 並關閉嗅探：這是「告訴瀏覽器別當圖片處理」，真正的保護來自 byte 已經被 XOR
  res.set('Content-Type', 'application/octet-stream');
  res.set('X-Content-Type-Options', 'nosniff');
  fs.createReadStream(file).pipe(res);
});

// === 路由 3：取 key（簡化：只檢查有沒有 Bearer token）===
app.get('/api/image/:id/key', (req, res) => {
  // 真實系統：從 Authorization 拆出 JWT、驗證簽章、確認這個人有權看這張圖（第 07 章）
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const m = load()[req.params.id];
  if (!m) return res.status(404).end();
  res.set('Cache-Control', 'no-store');
  res.json({ keyHex: m.keyHex, mime: m.mime, size: m.size });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[Ch02 XOR] http://localhost:${PORT}/examples/ch02-xor.html`);
});
