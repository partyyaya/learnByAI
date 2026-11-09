const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const source = fs.readFileSync(process.argv[2] || 'target/reconnect.js', 'utf8');
function fixture(refreshFails = false) {
  const calls = [];
  const context = vm.createContext({
    Math: Object.assign(Object.create(Math), { random: () => 0 }),
    refreshAccessToken: async () => { calls.push('refresh'); if (refreshFails) throw Error('refresh failed'); },
    handleTerminal: code => calls.push(['terminal', code]),
    setTimeout: (callback, delay) => calls.push(['timer', delay]),
    connect: () => calls.push('connect'),
  });
  vm.runInContext(source, context);
  return { context, calls };
}
(async () => {
  let f = fixture(); await f.context.scheduleReconnect({ code: 4029 }); assert.equal(f.calls[0][1], 30000);
  f = fixture(); await f.context.scheduleReconnect({ code: 4001 }); assert.equal(f.calls[0], 'refresh'); assert.equal(f.calls[1][0], 'timer');
  f = fixture(); await f.context.scheduleReconnect({ code: 4002 }); assert.deepEqual(f.calls, [['terminal', 4002]]);
  f = fixture(); await f.context.scheduleReconnect({ code: 1002 }); assert.deepEqual(f.calls, [['terminal', 1002]]);
  f = fixture(true); await f.context.scheduleReconnect({ code: 4001 }); assert.deepEqual(f.calls, ['refresh', ['terminal', 4002]]);
  f = fixture(); await f.context.scheduleReconnect({ code: 1001 }); assert.equal(f.calls[0][0], 'timer');
  f = fixture(); vm.runInContext('stoppedByUser = true', f.context); await f.context.scheduleReconnect({ code: 1001 }); assert.equal(f.calls[0][0], 'terminal');
  console.log('Reconnect: 7 behavior checks passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
