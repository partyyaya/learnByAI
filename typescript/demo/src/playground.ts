// ┌─────────────────────────────────────────────────────────────┐
// │  playground.ts —— 你的 TypeScript 測試場                      │
// ├─────────────────────────────────────────────────────────────┤
// │  邊寫邊跑： npm run dev     （存檔後自動重新執行）              │
// │  執行一次： npm start                                         │
// │  只型別檢查： npm run check                                    │
// └─────────────────────────────────────────────────────────────┘

// 在這裡自由測試任何 TypeScript 語法 👇

interface User {
  id: number;
  name: string;
  role: "admin" | "user";
}

function describe(user: User): string {
  return `#${user.id} ${user.name}（${user.role}）`;
}

const gary: User = { id: 1, name: "Gary", role: "admin" };

console.log(describe(gary));
console.log("TypeScript 版本可用 npx tsc --version 查看");

// 試試把 role 改成 "guest"，存檔後看 npm run check 會不會報錯：
// const bad: User = { id: 2, name: "Bob", role: "guest" }; // ❌
