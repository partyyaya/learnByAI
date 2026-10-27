import { formatArticleLabel } from '@course/article-label';
import { publishArticle } from './article.js';
import type { Article } from './article.js';
import { ConfigError, loadConfig } from './config.js';

function main(): void {
  // 所有設定通過後才執行業務；目前還沒有 listen() 或資料庫連線。
  const config = loadConfig(process.env);
  console.log(`設定已驗證：${config.appName}；模式 ${config.environment}；預定連接埠 ${config.port}`);
  console.log(`稽核開關：${config.enableAuditLog}（本章只驗證設定，尚未實作稽核寫入）`);

  const draft: Article = {
    id: 'a_1001',
    authorId: 'u_alice',
    title: '模組與設定',
    content: '設定通過後才開始執行業務。',
    status: 'draft',
    version: 1,
  };
  const published = publishArticle(draft);
  console.log(`文章 ${formatArticleLabel(published.id, published.status)}；版本 ${published.version}`);
  console.log('本章沒有啟動 HTTP 服務或寫入資料庫。');
}

try {
  main();
} catch (error) {
  console.error(error instanceof ConfigError ? error.message : '啟動失敗：未預期的錯誤');
  process.exitCode = 1;
}
