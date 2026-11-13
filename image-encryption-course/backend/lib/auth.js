// 對應章節：Chapter 07（JWT + 簽名 URL）、Chapter 08（完整登入流程）
'use strict';

const crypto = require('crypto');
const jwt = require('jsonwebtoken');

// 沒設 JWT_SECRET 就不要啟動：預設值寫在程式碼裡，等於任何人都能簽出合法 token
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error('JWT_SECRET is required（啟動方式見 backend/README.md）');
}

function hashPassword(pwd, salt = crypto.randomBytes(16).toString('hex')) {
  const h = crypto.scryptSync(pwd, salt, 64).toString('hex');
  return `${salt}:${h}`;
}

function verifyPassword(pwd, stored) {
  const [salt, h] = stored.split(':');
  const candidate = crypto.scryptSync(pwd, salt, 64).toString('hex');
  const a = Buffer.from(h, 'hex');
  const b = Buffer.from(candidate, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function signJwt(payload, opts = { expiresIn: '2h' }) {
  return jwt.sign(payload, JWT_SECRET, opts);
}

function authMiddleware(req, res, next) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'missing bearer token' });
  }
  try {
    req.user = jwt.verify(h.slice(7), JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'invalid token' });
  }
}

module.exports = {
  hashPassword,
  verifyPassword,
  signJwt,
  authMiddleware,
};
