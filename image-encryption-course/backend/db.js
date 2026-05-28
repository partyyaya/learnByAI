// 對應章節：Chapter 08 - 畢業專題的 SQLite schema
'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, 'data');
fs.mkdirSync(path.join(DATA_DIR, 'encrypted'), { recursive: true });

const db = new Database(path.join(DATA_DIR, 'meta.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    passwordHash TEXT NOT NULL,
    createdAt INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS images (
    id TEXT PRIMARY KEY,
    ownerId TEXT NOT NULL,
    mime TEXT NOT NULL,
    headerLen INTEGER NOT NULL,
    ivHex TEXT NOT NULL,
    wrappedKey TEXT NOT NULL,
    visibility TEXT NOT NULL CHECK(visibility IN ('public','friends','private')),
    createdAt INTEGER NOT NULL,
    FOREIGN KEY (ownerId) REFERENCES users(id)
  );

  CREATE INDEX IF NOT EXISTS idx_images_owner ON images(ownerId);

  CREATE TABLE IF NOT EXISTS friends (
    a TEXT NOT NULL,
    b TEXT NOT NULL,
    PRIMARY KEY (a, b)
  );
`);

module.exports = db;
