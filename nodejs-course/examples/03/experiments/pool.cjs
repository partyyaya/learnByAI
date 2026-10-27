const { pbkdf2 } = require('node:crypto');
const { readFile } = require('node:fs');
const { performance } = require('node:perf_hooks');
const start = performance.now();
const observations = [];
function record(name) {
  observations.push({ name, elapsedMs: Math.round(performance.now() - start) });
}

// 固定輸入僅供觀察 worker pool，並非密碼儲存設計或參數建議。
function derive(name, iterations) {
  return new Promise((resolve, reject) => {
    pbkdf2('demo', 'demo-salt', iterations, 32, 'sha256', (error) => {
      if (error) return reject(error);
      record(name);
      resolve();
    });
  });
}

Promise.all([
  derive('crypto:long', 200000),
  derive('crypto:short', 1),
  new Promise((resolve, reject) => readFile(__filename, (error) => {
    if (error) return reject(error);
    record('file:read');
    resolve();
  })),
  new Promise((resolve) => setTimeout(() => { record('timer:probe'); resolve(); }, 0)),
]).then(() => console.log(JSON.stringify({ poolSize: process.env.UV_THREADPOOL_SIZE, observations })))
  .catch((error) => { console.error(error); process.exitCode = 1; });
