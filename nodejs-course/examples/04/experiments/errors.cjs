const { EventEmitter } = require('node:events');
async function fail() { throw new Error('operation failed'); }

switch (process.argv[2]) {
  case 'awaited':
    (async () => {
      try { await fail(); } catch { console.log('local caught'); }
    })();
    break;
  case 'returned': {
    async function forward() {
      try { return fail(); } catch { console.log('local caught'); }
    }
    forward().catch(() => console.log('caller caught'));
    break;
  }
  case 'detached':
    try { fail(); } catch { console.log('local caught'); }
    break;
  case 'callback':
    try { setTimeout(() => { throw new Error('callback failed'); }, 0); }
    catch { console.log('local caught'); }
    break;
  case 'emitter':
    new EventEmitter().emit('error', new Error('source failed'));
    break;
  case 'async-listener': {
    const source = new EventEmitter();
    source.on('message', async () => { throw new Error('listener failed'); });
    try { source.emit('message'); } catch { console.log('local caught'); }
    break;
  }
  default:
    console.error('請指定教材中的實驗名稱');
    process.exitCode = 1;
}
