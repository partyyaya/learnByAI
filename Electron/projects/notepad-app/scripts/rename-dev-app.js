// 開發時把 dock 上顯示的名字從「Electron」改成「記事本」
//
// macOS 的 dock 名稱（滑鼠移上去的提示、選單列左上角）是 LaunchServices 從
// app bundle 的 Info.plist 讀來的，不是 app.setName() 或 package.json 決定的——
// app.setName() 只會改到 app.getName()，dock 依然顯示 Electron。
//
// 開發時跑的其實是 node_modules 裡的 Electron.app，所以這裡直接改它的 Info.plist。
// 打包後的 App 不需要這一步，electron-builder 會用 package.json 的 productName 產生。
//
// 由 `npm run dev` 自動呼叫；已經改過就直接跳出，不重複寫檔。
// 重裝 node_modules 之後會恢復成 Electron，下次 npm run dev 會再改一次。

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const APP_NAME = "記事本";
const KEYS = ["CFBundleName", "CFBundleDisplayName"];
const appBundle = path.join(__dirname, "..", "node_modules/electron/dist/Electron.app");
const plistFile = path.join(appBundle, "Contents/Info.plist");
const LSREGISTER =
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";

// 只有 macOS 有這個問題；Windows / Linux 的視窗標題本來就是對的
if (process.platform !== "darwin") process.exit(0);

if (!fs.existsSync(plistFile)) {
  console.warn(`找不到 ${plistFile}，跳過改名（先 npm install？）`);
  process.exit(0);
}

const plistBuddy = (...args) =>
  execFileSync("/usr/libexec/PlistBuddy", [...args, plistFile], { encoding: "utf8" }).trim();

try {
  const current = KEYS.map((key) => plistBuddy("-c", `Print :${key}`));
  if (current.every((value) => value === APP_NAME)) process.exit(0); // 已經是對的

  for (const key of KEYS) plistBuddy("-c", `Set :${key} ${APP_NAME}`);
  fs.utimesSync(appBundle, new Date(), new Date());

  // 只改 Info.plist 還不夠：LaunchServices 會把舊名字快取起來，只跑 `lsregister -f`
  // 也叫不動它，一定要先 `-u` 把舊紀錄踢掉再重新註冊，dock 才會拿到新名字。
  execFileSync(LSREGISTER, ["-u", appBundle], { stdio: "ignore" });
  execFileSync(LSREGISTER, ["-f", "-R", appBundle], { stdio: "ignore" });

  console.log(`已把開發用的 Electron.app 改名為「${APP_NAME}」`);
} catch (error) {
  // 改名失敗不該擋住開發，頂多 dock 上還是顯示 Electron
  console.warn("改名失敗，dock 上會顯示 Electron：", error.message);
}
