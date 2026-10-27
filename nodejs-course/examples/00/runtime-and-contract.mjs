import assert from 'node:assert/strict';

// 這是環境觀察與規格練習，尚未建立 HTTP 服務、Session 或資料庫。
const capabilities = {
  node: process.version,
  window: typeof window,
  document: typeof document,
  fetch: typeof fetch,
  process: typeof process,
};

assert.equal(capabilities.window, 'undefined');
assert.equal(capabilities.document, 'undefined');
assert.equal(capabilities.fetch, 'function');
assert.equal(capabilities.process, 'object');
console.log('執行環境：', JSON.stringify(capabilities));

// actor 在這裡是測試資料；正式 API 必須由已驗證的 Session 取得身分。
function canEditArticle(actor, article) {
  if (actor === null || article.status === 'archived') return false;
  return actor.role === 'admin' || actor.id === article.authorId;
}

const alice = { id: 'u_alice', role: 'member' };
const bob = { id: 'u_bob', role: 'member' };
const admin = { id: 'u_admin', role: 'admin' };
const draft = { id: 'a_1', authorId: alice.id, status: 'draft' };

const permissionCases = [
  ['訪客不能修改草稿', null, draft, false],
  ['作者能修改自己的草稿', alice, draft, true],
  ['其他會員不能修改草稿', bob, draft, false],
  ['作者能修改自己的已發佈文章', alice, { ...draft, status: 'published' }, true],
  ['管理員能修改他人的文章', admin, draft, true],
  ['作者不能修改封存文章', alice, { ...draft, status: 'archived' }, false],
  ['管理員也不能修改封存文章', admin, { ...draft, status: 'archived' }, false],
];

for (const [name, actor, article, expected] of permissionCases) {
  assert.equal(canEditArticle(actor, article), expected, name);
}

function nextArticleStatus(current, action) {
  if (current === 'draft' && action === 'publish') return 'published';
  if ((current === 'draft' || current === 'published') && action === 'archive') {
    return 'archived';
  }
  return null; // 沒有合法轉換；正式 API 將回傳 409。
}

const transitionCases = [
  ['draft', 'publish', 'published'],
  ['draft', 'archive', 'archived'],
  ['published', 'archive', 'archived'],
  ['published', 'publish', null],
  ['archived', 'publish', null],
  ['archived', 'archive', null],
];

for (const [current, action, expected] of transitionCases) {
  assert.equal(nextArticleStatus(current, action), expected, `${current} → ${action}`);
}

console.log(`PASS：4 項環境檢查、${permissionCases.length} 項權限案例、${transitionCases.length} 項狀態轉換案例`);
console.log('本章尚未啟動 HTTP 服務，也沒有建立資料庫。');
