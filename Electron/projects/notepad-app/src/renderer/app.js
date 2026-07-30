// ---------- 外觀樣式與語言 ----------
// 這段要放在最前面：<script> 在 </body> 前，會在第一次繪製之前跑完，
// 主題與語言直接掛上去就不會先閃一下另一個樣子。
// 開場值由 main 判斷後經 preload 同步帶進來（見 main.js 的 detectLanguage）。

const THEMES = ["light", "dark"];

function applyTheme(theme) {
  document.documentElement.dataset.theme = THEMES.includes(theme) ? theme : "light";
}

applyTheme(window.appInfo?.initialTheme);
setLanguage(window.appInfo?.initialLanguage); // 來自 i18n.js

// ---------- DOM ----------

const newNoteBtn = document.getElementById("newNoteBtn");
const noteList = document.getElementById("noteList");
const listEmpty = document.getElementById("listEmpty");

const composeView = document.getElementById("composeView");
const titleInput = document.getElementById("titleInput");
const editor = document.getElementById("editor");
const composeHint = document.getElementById("composeHint");
const cancelEditBtn = document.getElementById("cancelEditBtn");
const addBtn = document.getElementById("addBtn");

const readView = document.getElementById("readView");
const readTitle = document.getElementById("readTitle");
const readTime = document.getElementById("readTime");
const readBody = document.getElementById("readBody");
const editBtn = document.getElementById("editBtn");
const deleteBtn = document.getElementById("deleteBtn");

const shortcutBtn = document.getElementById("shortcutBtn");
const shortcutDialog = document.getElementById("shortcutDialog");
const shortcutDialogTitle = document.getElementById("shortcutDialogTitle");
const shortcutList = document.getElementById("shortcutList");
const shortcutCloseBtn = document.getElementById("shortcutCloseBtn");

const themeBtn = document.getElementById("themeBtn");
const themeDialog = document.getElementById("themeDialog");
const themeCloseBtn = document.getElementById("themeCloseBtn");
const themeHint = document.getElementById("themeHint");
const themeOptions = [...themeDialog.querySelectorAll(".picker-option")];

const languageBtn = document.getElementById("languageBtn");
const languageDialog = document.getElementById("languageDialog");
const languageCloseBtn = document.getElementById("languageCloseBtn");
const languageHint = document.getElementById("languageHint");
const languageOptions = [...languageDialog.querySelectorAll(".picker-option")];

const storageBtn = document.getElementById("storageBtn");
const storageDialog = document.getElementById("storageDialog");
const storageCloseBtn = document.getElementById("storageCloseBtn");
const storagePath = document.getElementById("storagePath");
const exportBtn = document.getElementById("exportBtn");
const importBtn = document.getElementById("importBtn");
const openFolderBtn = document.getElementById("openFolderBtn");

const confirmDialog = document.getElementById("confirmDialog");
const confirmMessage = document.getElementById("confirmMessage");
const confirmOkBtn = document.getElementById("confirmOkBtn");
const confirmCancelBtn = document.getElementById("confirmCancelBtn");

// ---------- 狀態 ----------

let notes = [];
let selectedId = null; // 目前選到的記事；null 代表在「新增」狀態
let editingId = null; // 不是 null 代表撰寫區正在編輯某篇既有記事
let editSnapshot = null; // 進入編輯時的內容，用來判斷有沒有未儲存的修改
let hintTimer = null;

// ---------- HTML 淨化 ----------
// 記事內容存的是 HTML 字串，所以「存檔前」與「顯示時」都要過濾一次，
// 只留下我們認得的標籤，圖片也只接受自己產生的 note-image:// 網址。

const ALLOWED_TAGS = new Set(["DIV", "P", "BR", "B", "STRONG", "I", "EM", "U", "IMG"]);
const DROPPED_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "IFRAME", "OBJECT", "EMBED", "LINK"]);
const IMAGE_URL_PREFIX = "note-image://images/";

function sanitizeInto(source, target) {
  for (const child of source.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      target.append(child.textContent);
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;

    const tag = child.tagName;
    if (DROPPED_TAGS.has(tag)) continue; // 整個丟掉，連文字都不要

    if (tag === "IMG") {
      const src = child.getAttribute("src") ?? "";
      if (src.startsWith(IMAGE_URL_PREFIX) && !src.includes("..")) {
        const image = document.createElement("img");
        image.setAttribute("src", src);
        target.append(image);
      }
      continue;
    }

    if (!ALLOWED_TAGS.has(tag)) {
      sanitizeInto(child, target); // 不在白名單的標籤只保留它的內容
      continue;
    }

    const clean = document.createElement(tag.toLowerCase());
    sanitizeInto(child, clean);
    target.append(clean);
  }
}

// 撰寫區 → 要存進 store 的 HTML 字串
function serializeEditor() {
  const holder = document.createElement("div");
  sanitizeInto(editor, holder);
  return holder.innerHTML;
}

// store 的 HTML 字串 → 可安全掛上畫面的節點
// DOMParser 產生的是 inert document，裡面的資源不會被載入，過濾完才進 DOM
function parseStoredHtml(html) {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  const fragment = document.createDocumentFragment();
  sanitizeInto(parsed.body, fragment);
  return fragment;
}

// ---------- 小工具 ----------

// 日期格式交給 toLocaleString()，地區設定跟著介面語言走
function formatDateTime(isoString) {
  return new Date(isoString).toLocaleString(getDateLocale(), {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
}

// main process 丟出來的是錯誤代碼（例如 TITLE_TOO_LONG），不是給人看的句子。
// 代碼會被 Electron 包成「Error invoking remote method '…': Error: CODE」，
// 所以用 includes 比對，對不到就原樣顯示。
const ERROR_MESSAGE_KEYS = {
  INVALID_FIELD: "error.invalidField",
  TITLE_TOO_LONG: "error.titleTooLong",
  CONTENT_TOO_LONG: "error.contentTooLong",
  NOTE_NOT_FOUND: "error.noteNotFound",
  INVALID_ID: "error.invalidId",
  UNSUPPORTED_IMAGE: "error.unsupportedImage",
  EMPTY_IMAGE: "error.emptyImage",
  IMAGE_TOO_LARGE: "error.imageTooLarge",
  UNSUPPORTED_THEME: "error.unsupportedTheme",
  UNSUPPORTED_LANGUAGE: "error.unsupportedLanguage",
  OPEN_FOLDER_FAILED: "error.openFolderFailed",
  INVALID_BACKUP: "error.invalidBackup",
  BACKUP_TOO_LARGE: "error.backupTooLarge",
  EXPORT_FAILED: "error.exportFailed"
};

function describeError(error) {
  const message = String(error?.message ?? "");
  for (const [code, key] of Object.entries(ERROR_MESSAGE_KEYS)) {
    if (message.includes(code)) return t(key);
  }
  return message;
}

function showHint(message, isError = false) {
  composeHint.textContent = message;
  composeHint.classList.toggle("is-error", isError);

  clearTimeout(hintTimer);
  if (message) {
    hintTimer = setTimeout(() => {
      composeHint.textContent = "";
      composeHint.classList.remove("is-error");
    }, 3000);
  }
}

function isEditorEmpty() {
  return editor.textContent.trim() === "" && editor.querySelector("img") === null;
}

// contenteditable 沒有原生 placeholder，用 class 控制 CSS 的 ::before
function syncEditorPlaceholder() {
  editor.classList.toggle("is-empty", isEditorEmpty());
}

// ---------- 左側列表 ----------

function renderList() {
  noteList.replaceChildren(
    ...notes.map((note) => {
      const item = document.createElement("li");

      const button = document.createElement("button");
      button.type = "button";
      button.className = "note-item";
      button.classList.toggle("is-active", note.id === selectedId);
      button.dataset.id = note.id;

      const title = document.createElement("div");
      title.className = "note-item__title";
      title.textContent = note.title; // 用 textContent，標題再怎麼寫都不會變成 HTML

      const time = document.createElement("div");
      time.className = "note-item__time";
      time.textContent = formatDateTime(note.createdAt);

      button.append(title, time);
      item.append(button);
      return item;
    })
  );

  listEmpty.hidden = notes.length > 0;
}

async function refreshList() {
  notes = await window.notesApi.list();
  renderList();
}

// ---------- 兩種模式切換 ----------

// 撰寫區同時負責「新增」與「編輯」：傳 null 是新增，傳 note 是編輯那一篇
function fillCompose(note) {
  editingId = note?.id ?? null;
  selectedId = editingId;

  titleInput.value = note?.title ?? "";
  editor.replaceChildren();
  if (note) editor.append(parseStoredHtml(note.contentHtml));
  syncEditorPlaceholder();
  showHint("");

  // 用「過濾後」的內容當比較基準，才不會一進編輯就被判定成有修改
  editSnapshot = note ? { title: titleInput.value, contentHtml: serializeEditor() } : null;

  syncComposeLabels();

  composeView.classList.remove("is-hidden");
  readView.classList.add("is-hidden");
  renderList();
  (note ? editor : titleInput).focus();
}

// 底部按鈕的文字同時取決於「是不是編輯中」與「目前語言」，抽出來讓切語言時也能重跑
function syncComposeLabels() {
  const editing = editingId !== null;
  addBtn.textContent = editing ? t("compose.save") : t("compose.add");
  cancelEditBtn.textContent = t("compose.cancelEdit");
  cancelEditBtn.classList.toggle("is-hidden", !editing);
}

function showCompose() {
  fillCompose(null);
}

function startEdit(note) {
  fillCompose(note);
}

function showNote(note) {
  selectedId = note.id;
  editingId = null; // 離開撰寫區就不再是編輯中
  editSnapshot = null;

  readTitle.textContent = note.title;
  readTime.textContent = note.updatedAt
    ? t("read.editedAt", {
        created: formatDateTime(note.createdAt),
        updated: formatDateTime(note.updatedAt)
      })
    : formatDateTime(note.createdAt);
  readBody.replaceChildren(parseStoredHtml(note.contentHtml));

  readView.classList.remove("is-hidden");
  composeView.classList.add("is-hidden");
  renderList();
}

// 編輯到一半切走會丟掉修改，內容真的變了才問一次
function hasUnsavedEdit() {
  if (editingId === null || editSnapshot === null) return false;
  return (
    titleInput.value !== editSnapshot.title || serializeEditor() !== editSnapshot.contentHtml
  );
}

async function canLeaveEdit() {
  if (!hasUnsavedEdit()) return true;
  return askConfirm({ message: t("confirm.discard"), confirmLabel: t("confirm.discardOk") });
}

// ---------- 彈窗 ----------

function openDialog(dialog) {
  if (!dialog.open) dialog.showModal();
}

function isDialogOpen() {
  return (
    shortcutDialog.open ||
    themeDialog.open ||
    languageDialog.open ||
    storageDialog.open ||
    confirmDialog.open
  );
}

// 開啟、關閉、點 backdrop 關閉，幾個彈窗都是同一套
function setupDialog(dialog, openBtn, closeBtn) {
  openBtn.addEventListener("click", () => openDialog(dialog));
  closeBtn.addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", (event) => {
    // 點在 backdrop 上時，事件的 target 就是 <dialog> 本身
    if (event.target === dialog) dialog.close();
  });
}

// ---------- 確認彈窗 ----------
// 取代 window.confirm()：原生對話框的按鈕文字是作業系統給的（介面是中文、按鈕卻是
// OK / Cancel），也吃不到主題顏色。這裡用 <dialog> 自己做一個，回傳 Promise<boolean>。

let confirmResolve = null;

// cancelLabel 傳 null 就變成只有一顆按鈕的通知彈窗（見下面的 showAlert）
function askConfirm({ message, confirmLabel, cancelLabel = t("confirm.cancel"), danger = true }) {
  confirmMessage.textContent = message;

  confirmOkBtn.textContent = confirmLabel;
  confirmOkBtn.classList.toggle("btn--danger", danger);
  confirmOkBtn.classList.toggle("btn--primary", !danger);

  confirmCancelBtn.textContent = cancelLabel ?? "";
  confirmCancelBtn.classList.toggle("is-hidden", cancelLabel === null);

  openDialog(confirmDialog);

  return new Promise((resolve) => {
    confirmResolve = resolve;
  });
}

// 取代 window.alert()：同一個彈窗，只是沒有取消鈕
function showAlert(message) {
  return askConfirm({
    message,
    confirmLabel: t("dialog.close"),
    cancelLabel: null,
    danger: false
  });
}

// close 事件涵蓋所有關閉方式：按按鈕（form 會帶 value 進 returnValue）、Esc、點 backdrop
confirmDialog.addEventListener("close", () => {
  const resolve = confirmResolve;
  confirmResolve = null;
  resolve?.(confirmDialog.returnValue === "ok");
});

confirmDialog.addEventListener("click", (event) => {
  if (event.target === confirmDialog) confirmDialog.close(); // returnValue 會是空字串＝取消
});

// ---------- 記事資料：匯出 / 匯入 / 開啟位置 ----------

let dataDirPath = ""; // 只拿來顯示；真正要讀寫哪裡都由 main 決定

function syncStoragePath() {
  storageBtn.title = t("storage.tooltip", { path: dataDirPath });
  storagePath.textContent = dataDirPath;
}

async function openDataFolder() {
  try {
    await window.notesApi.openDataFolder();
  } catch (error) {
    // 這些動作在哪個模式下都能觸發，用彈窗回報才不會有時候看不到訊息
    await showAlert(t("folder.openFailed", { message: describeError(error) }));
  }
}

async function exportBackup() {
  try {
    const result = await window.backupApi.exportAll({
      title: t("backup.exportTitle"),
      filterName: t("backup.fileFilter")
    });
    if (result.canceled) return;

    await showAlert(
      t("backup.exportDone", {
        notes: result.noteCount,
        images: result.imageCount,
        path: result.filePath
      })
    );
  } catch (error) {
    await showAlert(t("backup.exportFailed", { message: describeError(error) }));
  }
}

async function importBackup() {
  // 匯入是整包取代，動手前先問一次
  const confirmed = await askConfirm({
    message: t("backup.importConfirm"),
    confirmLabel: t("backup.importOk")
  });
  if (!confirmed) return;

  try {
    const result = await window.backupApi.importAll({
      title: t("backup.importTitle"),
      filterName: t("backup.fileFilter")
    });
    if (result.canceled) return;

    // 備份檔裡的設定也一起還原，畫面要跟著換
    applyTheme(result.settings.theme);
    setLanguage(result.settings.language ?? getLanguage());

    await refreshList();
    showCompose(); // 目前選到的記事可能已經不存在，回到乾淨的撰寫狀態
    refreshTexts();

    await showAlert(
      t("backup.importDone", { notes: result.noteCount, images: result.imageCount })
    );
  } catch (error) {
    await showAlert(t("backup.importFailed", { message: describeError(error) }));
  }
}

// ---------- 語言 ----------

function syncLanguageOptions() {
  const current = getLanguage();
  for (const option of languageOptions) {
    const isCurrent = option.dataset.language === current;
    option.classList.toggle("is-active", isCurrent);
    option.setAttribute("aria-checked", String(isCurrent));
  }
}

// 有 data-i18n 的元素統一在這裡套用，畫面上不留寫死的字
function applyStaticTranslations() {
  const attributeKeys = {
    "data-i18n-placeholder": "placeholder",
    "data-i18n-aria-label": "aria-label",
    "data-i18n-title": "title"
  };

  for (const element of document.querySelectorAll("[data-i18n]")) {
    element.textContent = t(element.dataset.i18n);
  }

  for (const [dataAttribute, target] of Object.entries(attributeKeys)) {
    for (const element of document.querySelectorAll(`[${dataAttribute}]`)) {
      element.setAttribute(target, t(element.getAttribute(dataAttribute)));
    }
  }
}

// 切語言不重新載入頁面，把所有會變的地方重跑一次就好
function refreshTexts() {
  document.documentElement.lang = getLanguage();
  document.title = t("app.title");

  applyStaticTranslations();
  renderShortcutList(); // 快捷鍵說明、圖示 tooltip、編輯區提示
  syncStoragePath();
  syncComposeLabels();
  syncThemeOptions();
  syncLanguageOptions();
  renderList(); // 列表的日期格式跟著語言

  // 檢視模式的時間字串（「編輯於 …」）也要重畫
  const note = notes.find((item) => item.id === selectedId);
  if (note && !isComposing()) showNote(note);
}

async function chooseLanguage(language) {
  setLanguage(language); // 來自 i18n.js
  refreshTexts();

  try {
    await window.settingsApi.setLanguage(language);
    languageHint.textContent = "";
    languageHint.classList.remove("is-error");
  } catch (error) {
    languageHint.textContent = t("language.saveFailed", { message: describeError(error) });
    languageHint.classList.add("is-error");
  }
}

// ---------- 外觀樣式選擇 ----------

function syncThemeOptions() {
  const current = document.documentElement.dataset.theme;
  for (const option of themeOptions) {
    const isCurrent = option.dataset.theme === current;
    option.classList.toggle("is-active", isCurrent);
    option.setAttribute("aria-checked", String(isCurrent));
  }
}

async function chooseTheme(theme) {
  applyTheme(theme); // 先套用，切換才是即時的
  syncThemeOptions();

  try {
    // 存進 <userData>/notepad/settings.json，下次開 App 會用同一個樣式
    await window.settingsApi.setTheme(theme);
    themeHint.textContent = "";
    themeHint.classList.remove("is-error");
  } catch (error) {
    themeHint.textContent = t("theme.saveFailed", { message: describeError(error) });
    themeHint.classList.add("is-error");
  }
}

// ---------- 平台判斷 ----------
// 平台字串由 preload 從 process.platform 傳過來（renderer 沒有 process 可用）。
// 只有 macOS 需要特別處理：修飾鍵是 ⌘（metaKey），其餘平台都是 Ctrl（ctrlKey）。
// 讀不到就當成非 macOS，因為那是比較保守的預設（Windows / Linux 都吃 Ctrl）。

const PLATFORM = window.appInfo?.platform ?? "win32";
const IS_MAC = PLATFORM === "darwin";
const IS_WINDOWS = PLATFORM === "win32";

const MOD_LABEL = IS_MAC ? "⌘" : "Ctrl";
const PLATFORM_LABEL = IS_MAC ? "macOS" : IS_WINDOWS ? "Windows" : "Linux";

// ---------- 快捷鍵 ----------

function isComposing() {
  return !composeView.classList.contains("is-hidden");
}

// 這份陣列同時是「說明彈窗的內容」與「鍵盤事件的對照表」，只會有一份定義。
// enabled 決定該快捷鍵目前有沒有作用——直接對藏起來的按鈕呼叫 click() 還是會觸發它的
// 事件處理器（例如在檢視模式按 ⌘S 會拿舊的撰寫區內容多存一篇），所以要先擋掉。
// descriptionKey 而不是寫死的句子：切語言時整份清單重畫一次就好
const SHORTCUTS = [
  {
    keys: [MOD_LABEL, "N"],
    key: "n",
    descriptionKey: "shortcut.newNote",
    run: () => newNoteBtn.click()
  },
  {
    keys: [MOD_LABEL, "S"],
    key: "s",
    descriptionKey: "shortcut.save",
    enabled: isComposing,
    run: () => addBtn.click()
  },
  {
    keys: [MOD_LABEL, "E"],
    key: "e",
    descriptionKey: "shortcut.edit",
    enabled: () => !isComposing(),
    run: () => editBtn.click()
  },
  {
    keys: [MOD_LABEL, "/"],
    key: "/",
    descriptionKey: "shortcut.help",
    run: () => openDialog(shortcutDialog)
  },
  { keys: ["Esc"], descriptionKey: "shortcut.escape" },
  { keys: [MOD_LABEL, "V"], descriptionKey: "shortcut.paste" }
];

function renderShortcutList() {
  shortcutBtn.title = t("shortcut.tooltip", { mod: MOD_LABEL });

  // 把平台判斷結果直接寫在標題上，一眼就知道現在吃的是哪一套修飾鍵
  shortcutDialogTitle.textContent = t("shortcut.title", { platform: PLATFORM_LABEL });

  // contenteditable 的提示字同時跟著語言與平台換，不能寫死「Cmd/Ctrl」
  editor.dataset.placeholder = t("compose.editorPlaceholder", { mod: MOD_LABEL });

  shortcutList.replaceChildren(
    ...SHORTCUTS.map(({ keys, descriptionKey }) => {
      const row = document.createElement("div");
      row.className = "shortcut";

      const term = document.createElement("dt");
      term.append(
        ...keys.map((key) => {
          const kbd = document.createElement("kbd");
          kbd.textContent = key;
          return kbd;
        })
      );

      const detail = document.createElement("dd");
      detail.textContent = t(descriptionKey);

      row.append(term, detail);
      return row;
    })
  );
}

// macOS 認 ⌘（metaKey），Windows / Linux 認 Ctrl（ctrlKey）。
// 兩邊都要把另一顆排除掉：mac 上按 Ctrl+S、Windows 上按 Win+S 都不該觸發。
function isModPressed(event) {
  return IS_MAC ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

document.addEventListener("keydown", (event) => {
  // 彈窗開著時交給 <dialog> 自己處理（Esc 關閉），不要再觸發其他快捷鍵
  if (isDialogOpen()) return;

  if (event.key === "Escape") {
    if (editingId !== null) cancelEditBtn.click();
    return;
  }

  if (!isModPressed(event) || event.altKey || event.shiftKey) return;

  const shortcut = SHORTCUTS.find((item) => item.key === event.key.toLowerCase());
  if (!shortcut) return;

  // 認得的組合一律吃掉，不要讓 Chromium 跑預設行為（例如 ⌘S 的「儲存網頁」）
  event.preventDefault();
  if (!shortcut.enabled || shortcut.enabled()) shortcut.run();
});

// ---------- 貼上圖片 ----------

function currentRangeInEditor() {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return null;

  const range = selection.getRangeAt(0);
  return editor.contains(range.commonAncestorContainer) ? range : null;
}

function insertNodeAt(range, node) {
  if (!range) {
    editor.append(node);
    return;
  }

  range.deleteContents();
  range.insertNode(node);

  // 游標移到剛插入的節點之後，才能繼續往下打字
  range.setStartAfter(node);
  range.collapse(true);

  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}

async function insertImageFile(file, range) {
  try {
    // 圖片二進位交給 main process 寫成檔案，內容裡只留下一段短網址
    const data = await file.arrayBuffer();
    const { url } = await window.notesApi.saveImage({ mimeType: file.type, data });

    const image = document.createElement("img");
    image.setAttribute("src", url);
    insertNodeAt(range, image);
    syncEditorPlaceholder();
  } catch (error) {
    showHint(t("compose.imageFailed", { message: describeError(error) }), true);
  }
}

editor.addEventListener("paste", (event) => {
  const clipboard = event.clipboardData;
  if (!clipboard) return;

  // getAsFile() 與 getData() 都必須在事件處理器裡同步取得，await 之後剪貼簿就讀不到了
  const imageItem = [...clipboard.items].find(
    (item) => item.kind === "file" && item.type.startsWith("image/")
  );

  event.preventDefault(); // 一律接手貼上行為，避免外部 HTML 直接進到編輯器

  if (imageItem) {
    const file = imageItem.getAsFile();
    if (file) insertImageFile(file, currentRangeInEditor());
    return;
  }

  document.execCommand("insertText", false, clipboard.getData("text/plain"));
  syncEditorPlaceholder();
});

editor.addEventListener("input", syncEditorPlaceholder);

// ---------- 事件 ----------

// canLeaveEdit() 現在會跳自製彈窗，所以是非同步的
newNoteBtn.addEventListener("click", async () => {
  if (await canLeaveEdit()) showCompose();
});

noteList.addEventListener("click", async (event) => {
  const button = event.target.closest(".note-item");
  if (!button) return;

  const note = notes.find((item) => item.id === button.dataset.id);
  if (note && (await canLeaveEdit())) showNote(note);
});

editBtn.addEventListener("click", () => {
  const note = notes.find((item) => item.id === selectedId);
  if (note) startEdit(note);
});

cancelEditBtn.addEventListener("click", async () => {
  const leavingId = editingId; // 等使用者回答時 editingId 可能已經被改掉
  if (!(await canLeaveEdit())) return;

  const note = notes.find((item) => item.id === leavingId);
  if (note) showNote(note);
  else showCompose(); // 這篇在別的地方被刪掉了，退回新增狀態
});

addBtn.addEventListener("click", async () => {
  const isEdit = editingId !== null;
  const contentHtml = serializeEditor();

  if (isEditorEmpty() && titleInput.value.trim() === "") {
    showHint(t("compose.needContent"), true);
    return;
  }

  addBtn.disabled = true;
  try {
    // 標題留空時由 main process 補上日期時間
    const note = isEdit
      ? await window.notesApi.update({ id: editingId, title: titleInput.value, contentHtml })
      : await window.notesApi.create({ title: titleInput.value, contentHtml });

    await refreshList();
    showNote(note); // 存完直接切到檢視模式看結果
  } catch (error) {
    const key = isEdit ? "compose.saveFailed" : "compose.addFailed";
    showHint(t(key, { message: describeError(error) }), true);
  } finally {
    addBtn.disabled = false;
  }
});

deleteBtn.addEventListener("click", async () => {
  const targetId = selectedId;
  if (!targetId) return;

  const confirmed = await askConfirm({
    message: t("confirm.delete"),
    confirmLabel: t("confirm.deleteOk")
  });
  if (!confirmed) return;

  await window.notesApi.remove(targetId);
  await refreshList();
  showCompose();
});

setupDialog(shortcutDialog, shortcutBtn, shortcutCloseBtn);
setupDialog(themeDialog, themeBtn, themeCloseBtn);
setupDialog(languageDialog, languageBtn, languageCloseBtn);

for (const option of themeOptions) {
  option.addEventListener("click", () => chooseTheme(option.dataset.theme));
}

for (const option of languageOptions) {
  option.addEventListener("click", () => chooseLanguage(option.dataset.language));
}

setupDialog(storageDialog, storageBtn, storageCloseBtn);

// 三個動作都會開系統對話框或跳結果彈窗，先把這個彈窗收起來，畫面才不會疊兩層
for (const [button, action] of [
  [exportBtn, exportBackup],
  [importBtn, importBackup],
  [openFolderBtn, openDataFolder]
]) {
  button.addEventListener("click", () => {
    storageDialog.close();
    action();
  });
}

// 把檔案拖進視窗預設會讓 Chromium 直接開啟該檔案（等於離開 App 畫面），一律擋掉
for (const type of ["dragover", "drop"]) {
  window.addEventListener(type, (event) => event.preventDefault());
}

// ---------- 啟動 ----------

async function init() {
  refreshTexts(); // 一次套用所有文字（含快捷鍵清單與兩個選單的勾選狀態）

  dataDirPath = await window.notesApi.dataDir();
  syncStoragePath();

  await refreshList();
  showCompose();
}

init();
