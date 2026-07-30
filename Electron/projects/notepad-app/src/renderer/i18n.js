// 所有給使用者看的字串都放在這裡，畫面上不寫死任何一句話。
// 這支檔案在 app.js 之前載入（index.html 的 <script> 順序），所以 t() 是全域可用的。
//
// 語言由 main process 依系統偏好判斷後傳進來，使用者也可以在左下角自己選。

const MESSAGES = {
  "zh-Hant": {
    "app.title": "記事本",

    "sidebar.newNote": "＋ 新增記事",
    "sidebar.listLabel": "記事列表",
    "list.empty": "還沒有任何記事",

    "compose.label": "撰寫記事",
    "compose.titlePlaceholder": "標題（留空會自動用當天日期時間）",
    "compose.editorLabel": "記事內容",
    "compose.editorPlaceholder": "在這裡輸入內容，可以直接貼上文字或圖片（{mod} + V）",
    "compose.add": "新增",
    "compose.save": "儲存修改",
    "compose.cancelEdit": "取消編輯",
    "compose.needContent": "請先輸入標題或內容",
    "compose.addFailed": "新增失敗：{message}",
    "compose.saveFailed": "儲存失敗：{message}",
    "compose.imageFailed": "圖片貼上失敗：{message}",

    "read.label": "檢視記事",
    "read.hint": "按左上角「新增記事」可回到撰寫模式",
    "read.delete": "刪除這篇",
    "read.edit": "開始編輯",
    "read.editedAt": "{created}（編輯於 {updated}）",

    "confirm.cancel": "取消",
    "confirm.delete": "確定要刪除這篇記事嗎？",
    "confirm.deleteOk": "刪除",
    "confirm.discard": "尚未儲存的修改會遺失，確定要離開嗎？",
    "confirm.discardOk": "不儲存離開",

    "theme.buttonLabel": "外觀樣式",
    "theme.title": "外觀樣式",
    "theme.light": "白",
    "theme.dark": "黑",
    "theme.saveFailed": "樣式沒存起來：{message}",

    "language.buttonLabel": "語言",
    "language.title": "語言",
    "language.saveFailed": "語言沒存起來：{message}",

    "storage.buttonLabel": "記事資料",
    "storage.tooltip": "記事資料\n{path}",
    "storage.title": "記事資料",
    "storage.export": "匯出備份",
    "storage.exportHint": "把設定、記事與圖片存成一個檔案",
    "storage.import": "匯入備份",
    "storage.importHint": "用匯出的檔案還原，會覆蓋目前的內容",
    "storage.openFolder": "開啟儲存位置",
    "storage.openFolderHint": "用檔案總管打開記事資料夾",
    "storage.pathLabel": "目前位置",

    "backup.fileFilter": "記事本備份檔",
    "backup.exportTitle": "匯出備份",
    "backup.importTitle": "選擇備份檔",
    "backup.exportDone": "已匯出 {notes} 篇記事與 {images} 張圖片：\n{path}",
    "backup.exportFailed": "匯出失敗：{message}",
    "backup.importConfirm": "匯入會覆蓋目前所有的記事、圖片與設定，確定要繼續嗎？",
    "backup.importOk": "匯入並覆蓋",
    "backup.importDone": "已匯入 {notes} 篇記事與 {images} 張圖片",
    "backup.importFailed": "匯入失敗：{message}",

    "folder.openFailed": "打不開記事資料夾：{message}",

    "shortcut.buttonLabel": "鍵盤快捷鍵",
    "shortcut.title": "鍵盤快捷鍵（{platform}）",
    "shortcut.tooltip": "鍵盤快捷鍵（{mod} /）",
    "shortcut.newNote": "新增記事",
    "shortcut.save": "儲存（新增／儲存修改）",
    "shortcut.edit": "編輯目前這篇記事",
    "shortcut.help": "打開這份快捷鍵說明",
    "shortcut.escape": "取消編輯／關閉彈窗",
    "shortcut.paste": "在內容區貼上文字或圖片",

    "dialog.close": "關閉",

    // main process 只回錯誤代碼，這裡才決定要顯示什麼句子
    "error.invalidField": "標題與內容必須是文字",
    "error.titleTooLong": "標題太長了",
    "error.contentTooLong": "內容過長，請拆成多篇記事",
    "error.noteNotFound": "找不到這篇記事，可能已經被刪掉了",
    "error.invalidId": "記事編號不正確",
    "error.unsupportedImage": "不支援這種圖片格式",
    "error.emptyImage": "圖片內容是空的",
    "error.imageTooLarge": "圖片太大了（上限 10MB）",
    "error.unsupportedTheme": "不支援這個外觀樣式",
    "error.unsupportedLanguage": "不支援這個語言",
    "error.openFolderFailed": "作業系統打不開這個資料夾",
    "error.invalidBackup": "這不是有效的備份檔",
    "error.backupTooLarge": "備份檔太大了",
    "error.exportFailed": "寫入檔案時出錯"
  },

  en: {
    "app.title": "Notepad",

    "sidebar.newNote": "+ New note",
    "sidebar.listLabel": "Note list",
    "list.empty": "No notes yet",

    "compose.label": "Compose note",
    "compose.titlePlaceholder": "Title (leave blank to use the current date and time)",
    "compose.editorLabel": "Note content",
    "compose.editorPlaceholder": "Write here — you can paste text or images ({mod} + V)",
    "compose.add": "Add",
    "compose.save": "Save changes",
    "compose.cancelEdit": "Cancel",
    "compose.needContent": "Enter a title or some content first",
    "compose.addFailed": "Could not add the note: {message}",
    "compose.saveFailed": "Could not save the note: {message}",
    "compose.imageFailed": "Could not paste the image: {message}",

    "read.label": "View note",
    "read.hint": "Use “New note” at the top left to go back to composing",
    "read.delete": "Delete",
    "read.edit": "Edit",
    "read.editedAt": "{created} (edited {updated})",

    "confirm.cancel": "Cancel",
    "confirm.delete": "Delete this note?",
    "confirm.deleteOk": "Delete",
    "confirm.discard": "You have unsaved changes. Leave without saving?",
    "confirm.discardOk": "Discard",

    "theme.buttonLabel": "Appearance",
    "theme.title": "Appearance",
    "theme.light": "Light",
    "theme.dark": "Dark",
    "theme.saveFailed": "Could not save the theme: {message}",

    "language.buttonLabel": "Language",
    "language.title": "Language",
    "language.saveFailed": "Could not save the language: {message}",

    "storage.buttonLabel": "Notes data",
    "storage.tooltip": "Notes data\n{path}",
    "storage.title": "Notes data",
    "storage.export": "Export backup",
    "storage.exportHint": "Save settings, notes and images to a single file",
    "storage.import": "Import backup",
    "storage.importHint": "Restore from an exported file — this replaces everything",
    "storage.openFolder": "Open storage folder",
    "storage.openFolderHint": "Open the notes folder in your file manager",
    "storage.pathLabel": "Current location",

    "backup.fileFilter": "Notepad backup",
    "backup.exportTitle": "Export backup",
    "backup.importTitle": "Choose a backup file",
    "backup.exportDone": "Exported {notes} notes and {images} images to:\n{path}",
    "backup.exportFailed": "Export failed: {message}",
    "backup.importConfirm":
      "Importing replaces all current notes, images and settings. Continue?",
    "backup.importOk": "Import and replace",
    "backup.importDone": "Imported {notes} notes and {images} images",
    "backup.importFailed": "Import failed: {message}",

    "folder.openFailed": "Could not open the notes folder: {message}",

    "shortcut.buttonLabel": "Keyboard shortcuts",
    "shortcut.title": "Keyboard shortcuts ({platform})",
    "shortcut.tooltip": "Keyboard shortcuts ({mod} /)",
    "shortcut.newNote": "New note",
    "shortcut.save": "Save (add or save changes)",
    "shortcut.edit": "Edit the current note",
    "shortcut.help": "Open this shortcut list",
    "shortcut.escape": "Cancel editing / close dialog",
    "shortcut.paste": "Paste text or an image into the content area",

    "dialog.close": "Close",

    "error.invalidField": "Title and content must be text",
    "error.titleTooLong": "That title is too long",
    "error.contentTooLong": "That note is too long — split it into several notes",
    "error.noteNotFound": "Note not found — it may have been deleted",
    "error.invalidId": "Invalid note id",
    "error.unsupportedImage": "That image format is not supported",
    "error.emptyImage": "The image is empty",
    "error.imageTooLarge": "That image is too large (10 MB max)",
    "error.unsupportedTheme": "Unsupported appearance",
    "error.unsupportedLanguage": "Unsupported language",
    "error.openFolderFailed": "The operating system could not open that folder",
    "error.invalidBackup": "That is not a valid backup file",
    "error.backupTooLarge": "That backup file is too large",
    "error.exportFailed": "Something went wrong writing the file"
  }
};

const FALLBACK_LANGUAGE = "zh-Hant";
const LANGUAGES = Object.keys(MESSAGES);

// 語言選單一律用該語言自己的寫法，不翻譯——英文介面下也該看得懂「中文」那一項
const LANGUAGE_NAMES = { "zh-Hant": "中文", en: "English" };

// 日期時間交給 toLocaleString()，每個語言用對應的地區設定
const DATE_LOCALES = { "zh-Hant": "zh-TW", en: "en-US" };

let currentLanguage = FALLBACK_LANGUAGE;

function setLanguage(language) {
  currentLanguage = MESSAGES[language] ? language : FALLBACK_LANGUAGE;
  return currentLanguage;
}

function getLanguage() {
  return currentLanguage;
}

function getDateLocale() {
  return DATE_LOCALES[currentLanguage] ?? DATE_LOCALES[FALLBACK_LANGUAGE];
}

// t("compose.addFailed", { message: "…" })
// 找不到 key 就退回預設語言，再找不到就把 key 本身印出來——這樣漏翻的地方一眼看得出來
function t(key, vars) {
  const template = MESSAGES[currentLanguage]?.[key] ?? MESSAGES[FALLBACK_LANGUAGE][key] ?? key;
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name) => vars[name] ?? match);
}
