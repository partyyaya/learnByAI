// 把 build/icon.svg 畫成 build/icon.png（1024×1024）
//
// 用 Electron 自己跑：Chromium 就是現成的 SVG 算圖器，不用多裝 sharp / imagemagick。
// 改完 icon.svg 之後跑 `npm run icon` 重新產生 PNG。
//
//   npm run icon

const fs = require("node:fs");
const path = require("node:path");
const { app, BrowserWindow } = require("electron");

const SIZE = 1024;
const buildDir = path.join(__dirname, "..", "build");
const svgFile = path.join(buildDir, "icon.svg");
const pngFile = path.join(buildDir, "icon.png");

app.on("window-all-closed", () => {});

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: SIZE,
    height: SIZE,
    show: false,
    useContentSize: true, // 讓內容剛好是 1024×1024，不含視窗邊框
    transparent: true,
    frame: false,
    webPreferences: { offscreen: true }
  });

  const svg = fs.readFileSync(svgFile, "utf8");
  const page = `<style>html,body{margin:0;padding:0;background:transparent}
    svg{display:block;width:${SIZE}px;height:${SIZE}px}</style>${svg}`;

  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page)}`);
  await new Promise((resolve) => setTimeout(resolve, 500)); // 等一次繪製

  const image = await win.webContents.capturePage();
  if (image.isEmpty()) throw new Error("算圖失敗，capturePage 拿到空圖");

  fs.writeFileSync(pngFile, image.toPNG());
  const { width, height } = image.getSize();
  console.log(`已產生 ${path.relative(process.cwd(), pngFile)}（${width}×${height}）`);

  app.exit(0);
});
