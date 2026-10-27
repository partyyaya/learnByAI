import { publishArticle } from './article.js';
import type { Article } from './article.js';

const draft: Article = {
  id: 'a_1001',
  authorId: 'u_alice',
  title: '我的第一篇文章',
  content: '先建立可以建置、執行與測試的專案。',
  status: 'draft',
  version: 1,
};

const published = publishArticle(draft);

console.log(`Node ${process.version}`);
console.log(`文章 ${published.id}：${draft.status} → ${published.status}`);
console.log(`版本：${draft.version} → ${published.version}`);
console.log('本章只執行本機規則，尚未啟動 HTTP 服務或寫入資料庫。');
