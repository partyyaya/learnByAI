// npm run dev 的進入點：先把 Vite dev server 開起來，拿到實際網址之後才啟動 Electron。
//
// 為什麼不用 concurrently 之類的工具同時跑兩條指令？因為那樣有競爭條件——
// Electron 常常比 dev server 早一步 ready，載入時就吃到 ERR_CONNECTION_REFUSED。
// 用 Vite 的 JS API 就能確定「server listen 成功」之後才 spawn，而且順便把網址
// 用環境變數交給 main process，不必在兩個檔案裡各寫一次 port。
import { spawn } from "node:child_process";
import process from "node:process";
import { createServer } from "vite";
import electronPath from "electron";

const server = await createServer({ mode: "development" });
await server.listen();
server.printUrls();

const devServerUrl = server.resolvedUrls.local[0];

// VS Code 的內建終端機會塞 ELECTRON_RUN_AS_NODE=1 給子行程，Electron 會因此
// 以純 Node 模式啟動，require("electron") 拿到的是一個字串路徑而不是 API，
// 直接爆 "Cannot read properties of undefined (reading 'whenReady')"。
// 這裡主動拔掉，就不用叫使用者改用系統終端機。
const env = { ...process.env, VITE_DEV_SERVER_URL: devServerUrl };
delete env.ELECTRON_RUN_AS_NODE;

const electron = spawn(electronPath, ["."], { stdio: "inherit", env });

// 關掉 App 就把 dev server 一起收掉，不要留一個孤兒行程佔著 5173
electron.on("close", async (code) => {
  await server.close();
  process.exit(code ?? 0);
});

// Ctrl + C 時反過來：先關 Electron，讓上面的 close 事件負責收尾
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => electron.kill());
}
