import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
let cases = 0;

function check(name, args, expected, fails = false, cwd = root) {
  const result = spawnSync(process.execPath, args, { cwd, encoding: 'utf8', timeout: 10000 });
  assert.ifError(result.error);
  assert.equal(result.signal, null, name);
  if (fails) assert.notEqual(result.status, 0, name);
  else assert.equal(result.status, 0, result.stderr);
  assert.match(fails ? result.stderr : result.stdout, expected, name);
  cases += 1;
  console.log(`PASS：${name}`);
}

check('CommonJS 的 require / module.exports', ['modules/cjs/main.cjs'], /文章：模組練習/);
check('ESM 的 import / export', ['modules/esm/main.mjs'], /文章：模組練習/);
check('.js 使用最近一層 commonjs 設定', ['modules/commonjs-scope/main.js'], /commonjs .js/);
check('.js 使用最近一層 module 設定', ['modules/esm-scope/main.js'], /esm .js/);
check('ESM 相對匯入缺少副檔名會失敗', ['--input-type=module', '-e', "import './modules/esm/format'"], /ERR_MODULE_NOT_FOUND/, true);
check('ESM 沒有內建 require 變數', ['--input-type=module', '-e', "require('node:path')"], /require is not defined/, true);
check('CommonJS 使用套件公開入口', ['-e', "console.log(require('@course/article-label').formatArticleLabel('a_1', 'draft'))"], /\[draft\] a_1/);
check('ESM 可用 default import 讀 CommonJS 入口', ['--input-type=module', '-e', "import label from '@course/article-label'; console.log(label.formatArticleLabel('a_1', 'draft'))"], /\[draft\] a_1/);
check('exports 擋下未公開的套件子路徑', ['-e', "require('@course/article-label/internal.cjs')"], /ERR_PACKAGE_PATH_NOT_EXPORTED/, true);
check('require 不能載入含 top-level await 的 ESM', ['-e', "require('./modules/esm/async-value.mjs')"], /ERR_REQUIRE_ASYNC_MODULE/, true);
check('CommonJS 可用動態 import 載入非同步 ESM', ['-e', "import('./modules/esm/async-value.mjs').then(mod => console.log(mod.value))"], /ready/);
check('相對匯入跟著模組位置，不跟著工作目錄', [fileURLToPath(new URL('./esm/main.mjs', import.meta.url))], /文章：模組練習/, false, tmpdir());
console.log(`模組實驗：${cases} 項通過（包含預期失敗案例）`);
