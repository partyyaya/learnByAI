const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { protocol, net } = require("electron");

const SCHEME = "note-image";

// 只放行 store 產生的檔名格式（十六進位 + 副檔名），擋掉 ../../ 這類路徑穿越
const FILE_NAME_PATTERN = /^[a-f0-9]+\.(png|jpg|gif|webp)$/;

// 必須在 app ready「之前」呼叫，Chromium 才會把這個 scheme 當成標準且安全的來源。
// standard: true → 有 host/path 的正常 URL；secure: true → 視為安全來源，CSP 才好設定。
function registerImageScheme() {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true }
    }
  ]);
}

// app ready 之後才註冊實際的處理函式：note-image://images/<檔名> → userData 底下的圖片檔
function handleImageProtocol(imagesDir) {
  protocol.handle(SCHEME, (request) => {
    const { pathname } = new URL(request.url);
    const fileName = path.basename(decodeURIComponent(pathname));

    if (!FILE_NAME_PATTERN.test(fileName)) {
      return new Response("Invalid image name", { status: 400 });
    }

    // net.fetch 支援 file:// URL，交給它讀檔可以自動處理 MIME type 與串流
    return net.fetch(pathToFileURL(path.join(imagesDir, fileName)).toString());
  });
}

module.exports = { SCHEME, registerImageScheme, handleImageProtocol };
