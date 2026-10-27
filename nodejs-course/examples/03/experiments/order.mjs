const events = ['sync:start'];
process.nextTick(() => events.push('nextTick'));
Promise.resolve().then(() => events.push('promise'));
queueMicrotask(() => events.push('queueMicrotask'));
(async () => {
  events.push('async:before-await');
  await Promise.resolve();
  events.push('async:after-await');
})();
events.push('sync:end');
setTimeout(() => console.log(JSON.stringify(events)), 0);
