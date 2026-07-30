const fs = require("node:fs");
const path = require("node:path");
const notesStore = require("./notes.store");
const settingsStore = require("./settings.store");

// 備份檔就是一個 JSON：設定 + 全部記事 + 圖片（base64）。
//
// 為什麼用 base64 而不是 zip：這個專案刻意維持零 runtime 依賴，Node 內建沒有 zip。
// 平常存檔堅持不用 base64（會讓 notes.json 爆炸，見 README「六個實作重點」），
// 但備份是「一次性、要一個檔案帶著走」的情境，體積換簡單是划算的。
const FORMAT = "notepad-backup";
const FORMAT_VERSION = 1;

// 跟 image-protocol.js 同一套白名單：檔名只能是十六進位 + 已知副檔名。
// 匯入的檔案是完全不可信的輸入，這條正則同時擋掉了 ../ 之類的路徑穿越。
const IMAGE_NAME_PATTERN = /^[a-f0-9]+\.(png|jpg|gif|webp)$/;

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_TITLE_LENGTH = 200;
const MAX_CONTENT_LENGTH = 2 * 1024 * 1024;
const MAX_NOTES = 20000;
const MAX_BACKUP_BYTES = 200 * 1024 * 1024;

function buildBackup() {
  notesStore.ensureDataDirs();

  const images = {};
  for (const file of fs.readdirSync(notesStore.imagesDir())) {
    if (!IMAGE_NAME_PATTERN.test(file)) continue; // 目錄裡的雜物不備份
    images[file] = fs.readFileSync(path.join(notesStore.imagesDir(), file)).toString("base64");
  }

  return {
    format: FORMAT,
    version: FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    settings: settingsStore.readSettings(),
    notes: notesStore.listNotes(),
    images
  };
}

// 只留認得的欄位，其他一律丟掉；有一筆壞掉就整個拒絕，不要匯入一半
function sanitizeNote(note) {
  if (!note || typeof note !== "object") throw new Error("INVALID_BACKUP");

  const { id, title, contentHtml, createdAt, updatedAt } = note;
  if (typeof id !== "string" || id.length === 0 || id.length > 200) {
    throw new Error("INVALID_BACKUP");
  }
  if (typeof title !== "string" || title.length > MAX_TITLE_LENGTH) {
    throw new Error("INVALID_BACKUP");
  }
  if (typeof contentHtml !== "string" || contentHtml.length > MAX_CONTENT_LENGTH) {
    throw new Error("INVALID_BACKUP");
  }
  if (typeof createdAt !== "string" || Number.isNaN(Date.parse(createdAt))) {
    throw new Error("INVALID_BACKUP");
  }

  const clean = { id, title, contentHtml, createdAt };
  if (typeof updatedAt === "string" && !Number.isNaN(Date.parse(updatedAt))) {
    clean.updatedAt = updatedAt;
  }
  return clean;
}

function parseBackup(raw) {
  if (raw.length > MAX_BACKUP_BYTES) throw new Error("BACKUP_TOO_LARGE");

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error("INVALID_BACKUP");
  }

  if (!data || data.format !== FORMAT) throw new Error("INVALID_BACKUP");
  if (!Array.isArray(data.notes) || data.notes.length > MAX_NOTES) {
    throw new Error("INVALID_BACKUP");
  }

  const notes = data.notes.map(sanitizeNote);

  const images = [];
  for (const [fileName, base64] of Object.entries(data.images ?? {})) {
    if (!IMAGE_NAME_PATTERN.test(fileName)) throw new Error("INVALID_BACKUP");
    if (typeof base64 !== "string") throw new Error("INVALID_BACKUP");

    const buffer = Buffer.from(base64, "base64");
    if (buffer.length === 0 || buffer.length > MAX_IMAGE_BYTES) throw new Error("INVALID_BACKUP");
    images.push({ fileName, buffer });
  }

  const settings = {};
  if (settingsStore.THEMES.includes(data.settings?.theme)) settings.theme = data.settings.theme;
  if (settingsStore.LANGUAGES.includes(data.settings?.language)) {
    settings.language = data.settings.language;
  }

  return { notes, images, settings };
}

// 匯入＝整包取代。動手前先把現有的 notes.json 另存一份，萬一匯錯還救得回來。
function restoreBackup(raw) {
  const { notes, images, settings } = parseBackup(raw);

  notesStore.ensureDataDirs();

  const notesFile = notesStore.notesFile();
  if (fs.existsSync(notesFile)) {
    fs.copyFileSync(notesFile, `${notesFile}.pre-import.bak`);
  }

  notesStore.replaceNotes(notes);
  for (const { fileName, buffer } of images) {
    fs.writeFileSync(path.join(notesStore.imagesDir(), fileName), buffer);
  }

  // 舊圖片沒有被新的記事引用就會在這裡被清掉，達成「整包取代」
  notesStore.cleanupOrphanImages();

  if (settings.theme) settingsStore.setTheme(settings.theme);
  if (settings.language) settingsStore.setLanguage(settings.language);

  return {
    noteCount: notes.length,
    imageCount: images.length,
    settings: settingsStore.readSettings()
  };
}

module.exports = {
  FORMAT,
  FORMAT_VERSION,
  MAX_BACKUP_BYTES,
  buildBackup,
  parseBackup,
  restoreBackup
};
