// 對應章節：Chapter 04（簽名 URL + JWT 概念）、Chapter 08（完整登入流程）
'use strict';

const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'demo-jwt-secret';

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
  JWT_SECRET,
  hashPassword,
  verifyPassword,
  signJwt,
  authMiddleware,
};
