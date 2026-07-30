const fs = require("node:fs");
const path = require("node:path");
const { app } = require("electron");

// 兩套樣式的「主要顏色」，同時給 renderer 的 CSS 與 BrowserWindow 的 backgroundColor 用
const THEME_BACKGROUNDS = {
  light: "#fcfcfc",
  dark: "#0d1117"
};

const THEMES = Object.keys(THEME_BACKGROUNDS);
const DEFAULT_THEME = "light";

// 介面語言。實際要用哪一個由 main 依系統偏好判斷（見 main.js 的 detectLanguage），
// 使用者選過之後就以 settings.json 裡的值為準。
const LANGUAGES = ["zh-Hant", "en"];

function settingsFile() {
  return path.join(app.getPath("userData"), "notepad", "settings.json");
}

function backgroundColor(theme) {
  return THEME_BACKGROUNDS[theme] ?? THEME_BACKGROUNDS[DEFAULT_THEME];
}

// 設定壞掉或還不存在都只是「回預設值」，不該讓 App 開不起來。
// language 沒設過時回 null，代表「還沒選過，交給系統偏好決定」。
function readSettings() {
  let parsed = {};
  try {
    parsed = JSON.parse(fs.readFileSync(settingsFile(), "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") console.error("settings.json 讀取失敗，改用預設值：", error);
  }

  return {
    theme: THEMES.includes(parsed.theme) ? parsed.theme : DEFAULT_THEME,
    language: LANGUAGES.includes(parsed.language) ? parsed.language : null
  };
}

// 一律先讀再合併寫回，才不會存了語言就把樣式洗掉
function writeSettings(patch) {
  const next = { ...readSettings(), ...patch };
  const target = settingsFile();
  const temp = `${target}.tmp`;

  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(temp, JSON.stringify(next, null, 2), "utf8"); // 一樣先寫暫存檔再 rename
  fs.renameSync(temp, target);

  return next;
}

function setTheme(theme) {
  // renderer 傳來的值一律先比對白名單，不直接寫進檔案
  if (!THEMES.includes(theme)) throw new Error("UNSUPPORTED_THEME");
  return writeSettings({ theme });
}

function setLanguage(language) {
  if (!LANGUAGES.includes(language)) throw new Error("UNSUPPORTED_LANGUAGE");
  return writeSettings({ language });
}

// 使用者「主要使用的語言」：getPreferredSystemLanguages() 會依偏好順序回傳，
// 例如 ["zh-Hant-TW", "en-US"]，取第一個我們支援的。
// 中文只做繁體一種，所有 zh-* 都對到 zh-Hant；兩種都不是（日文、德文…）就用英文。
function detectLanguage(preferred = app.getPreferredSystemLanguages()) {
  for (const tag of preferred) {
    const lower = String(tag).toLowerCase();
    if (lower.startsWith("zh")) return "zh-Hant";
    if (lower.startsWith("en")) return "en";
  }
  return "en";
}

// 使用者自己選過就以設定為準，沒選過才看系統
function resolveLanguage() {
  return readSettings().language ?? detectLanguage();
}

module.exports = {
  THEMES,
  LANGUAGES,
  DEFAULT_THEME,
  settingsFile,
  backgroundColor,
  readSettings,
  setTheme,
  setLanguage,
  detectLanguage,
  resolveLanguage
};
