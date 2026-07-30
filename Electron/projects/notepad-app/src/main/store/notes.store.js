const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { app } = require("electron");

// 允許貼上的圖片格式；key 是剪貼簿給的 MIME type，value 是實際存檔的副檔名
const ALLOWED_IMAGE_TYPES = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp"
};

const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 單張圖片上限 10MB，避免剪貼簿誤貼超大圖
const MAX_TITLE_LENGTH = 200;
const MAX_CONTENT_LENGTH = 2 * 1024 * 1024; // 單篇內容（HTML 字串）上限

// 已存檔的圖片會以 note-image://images/<檔名> 的形式寫進記事內容
const IMAGE_URL_PATTERN = /note-image:\/\/images\/([a-f0-9]+\.[a-z]+)/g;

// 注意：這些路徑函式都不是常數，因為 app.getPath() 必須在 app ready 之後才呼叫得到
function dataDir() {
  return path.join(app.getPath("userData"), "notepad");
}

function imagesDir() {
  return path.join(dataDir(), "images");
}

function notesFile() {
  return path.join(dataDir(), "notes.json");
}

function ensureDataDirs() {
  // recursive 會一併建立 notepad/ 與 notepad/images/，且目錄已存在時不會拋錯
  fs.mkdirSync(imagesDir(), { recursive: true });
}

// 沒填標題時，用「當天日期時間」當標題（例如 2026/07/30 14:05）
function defaultTitle(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  const ymd = `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())}`;
  const hm = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return `${ymd} ${hm}`;
}

function readNotesFile() {
  try {
    const parsed = JSON.parse(fs.readFileSync(notesFile(), "utf8"));
    return Array.isArray(parsed.notes) ? parsed.notes : [];
  } catch (error) {
    // 檔案還不存在＝第一次啟動，回空陣列即可
    if (error.code === "ENOENT") return [];

    // JSON 壞掉（例如寫入時斷電）就先備份再重來，不要讓 App 整個開不起來
    console.error("notes.json 讀取失敗，將備份後重建：", error);
    try {
      fs.renameSync(notesFile(), `${notesFile()}.bak`);
    } catch (renameError) {
      console.error("備份 notes.json 失敗：", renameError);
    }
    return [];
  }
}

// 原子寫入：先寫暫存檔再 rename，避免寫到一半被中斷而留下半殘的 JSON
function writeNotesFile(notes) {
  const target = notesFile();
  const temp = `${target}.tmp`;

  fs.writeFileSync(temp, JSON.stringify({ notes }, null, 2), "utf8");
  fs.renameSync(temp, target);
}

function listNotes() {
  return readNotesFile();
}

// 整包取代（目前只有匯入備份會用到）；寫入前的檢查在 backup.store.js
function replaceNotes(notes) {
  writeNotesFile(notes);
  return notes.length;
}

function getNote(id) {
  return readNotesFile().find((note) => note.id === id) ?? null;
}

// 來自 renderer 的資料一律視為不可信，新增與編輯都要先檢查型別與長度。
//
// 這裡丟出去的是「錯誤代碼」而不是中文句子：main 不該知道使用者用什麼語言，
// 由 renderer 的 i18n 決定要顯示哪一句（src/renderer/i18n.js 的 error.* ）。
function assertNoteInput(title, contentHtml) {
  if (typeof title !== "string" || typeof contentHtml !== "string") {
    throw new Error("INVALID_FIELD");
  }
  if (title.length > MAX_TITLE_LENGTH) {
    throw new Error("TITLE_TOO_LONG");
  }
  if (contentHtml.length > MAX_CONTENT_LENGTH) {
    throw new Error("CONTENT_TOO_LONG");
  }
}

function createNote({ title = "", contentHtml = "" } = {}) {
  assertNoteInput(title, contentHtml);

  const now = new Date();
  const note = {
    id: crypto.randomUUID(),
    title: title.trim() || defaultTitle(now),
    contentHtml,
    createdAt: now.toISOString()
  };

  const notes = readNotesFile();
  notes.unshift(note); // 最新的排最前面
  writeNotesFile(notes);

  return note;
}

function updateNote(id, { title = "", contentHtml = "" } = {}) {
  if (typeof id !== "string") throw new Error("INVALID_ID");
  assertNoteInput(title, contentHtml);

  const notes = readNotesFile();
  const index = notes.findIndex((note) => note.id === id);
  if (index === -1) throw new Error("NOTE_NOT_FOUND");

  const original = notes[index];
  const updated = {
    ...original,
    // 編輯時把標題清空＝回到「用建立時間當標題」，與新增時的規則一致
    title: title.trim() || defaultTitle(new Date(original.createdAt)),
    contentHtml,
    updatedAt: new Date().toISOString() // id 與 createdAt 一律沿用原本的
  };

  notes[index] = updated; // 只改內容，不動排序
  writeNotesFile(notes);
  cleanupOrphanImages(); // 編輯時刪掉的圖片就沒人引用了

  return updated;
}

function deleteNote(id) {
  const notes = readNotesFile();
  const remaining = notes.filter((note) => note.id !== id);

  if (remaining.length === notes.length) return false;

  writeNotesFile(remaining);
  cleanupOrphanImages(); // 這篇用到的圖片沒人再引用時一併清掉
  return true;
}

function saveImage({ mimeType, data } = {}) {
  const extension = ALLOWED_IMAGE_TYPES[mimeType];
  if (!extension) {
    throw new Error("UNSUPPORTED_IMAGE");
  }

  // renderer 傳來的是 ArrayBuffer，轉成 Buffer 才能寫檔
  const buffer = Buffer.from(data);
  if (buffer.length === 0) throw new Error("EMPTY_IMAGE");
  if (buffer.length > MAX_IMAGE_BYTES) throw new Error("IMAGE_TOO_LARGE");

  // 檔名自己產生（純小寫十六進位），不採用外部傳入的名稱，避免路徑穿越
  const fileName = `${crypto.randomBytes(16).toString("hex")}.${extension}`;
  fs.writeFileSync(path.join(imagesDir(), fileName), buffer);

  return { fileName, url: `note-image://images/${fileName}` };
}

// 使用者貼了圖但最後沒按「新增」，圖片就會變成沒人引用的孤兒檔；
// 每次啟動與刪除記事後掃一次，把沒被任何記事引用的圖片刪掉。
function cleanupOrphanImages() {
  const referenced = new Set();
  for (const note of readNotesFile()) {
    for (const match of String(note.contentHtml).matchAll(IMAGE_URL_PATTERN)) {
      referenced.add(match[1]);
    }
  }

  let files = [];
  try {
    files = fs.readdirSync(imagesDir());
  } catch (error) {
    if (error.code !== "ENOENT") console.error("讀取圖片目錄失敗：", error);
    return 0;
  }

  let removed = 0;
  for (const file of files) {
    if (referenced.has(file)) continue;
    try {
      fs.unlinkSync(path.join(imagesDir(), file));
      removed += 1;
    } catch (error) {
      console.error(`刪除孤兒圖片 ${file} 失敗：`, error);
    }
  }
  return removed;
}

module.exports = {
  dataDir,
  imagesDir,
  notesFile,
  ensureDataDirs,
  listNotes,
  replaceNotes,
  getNote,
  createNote,
  updateNote,
  deleteNote,
  saveImage,
  cleanupOrphanImages
};
