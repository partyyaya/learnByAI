const events = [];
setTimeout(() => {
  events.push('timer');
  console.log(JSON.stringify(events));
}, 0);

(async () => {
  for (let index = 0; index < 1000; index++) await Promise.resolve();
  events.push('microtasks:done');
})();
