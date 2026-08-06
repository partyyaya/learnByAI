import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles/global.css";

// StrictMode 在開發模式會把每個 effect 跑兩次（掛載 → 卸載 → 再掛載），
// 所以終端機的 [api] log 開發時會看到成對的請求，這是刻意的檢查機制而不是 bug：
// 它專門用來抓「effect 沒寫清理函式」的問題。useApi 靠 requestId 讓第一次的回應
// 作廢，所以畫面不會因此錯亂。打包後只會跑一次。
createRoot(document.getElementById("root")).render(
  <StrictMode>
    <App />
  </StrictMode>
);
