const { readFile } = require('node:fs');

readFile(__filename, (error) => {
  if (error) throw error;
  const events = ['io:callback'];
  setTimeout(() => {
    events.push('timeout');
    console.log(JSON.stringify(events));
  }, 0);
  setImmediate(() => events.push('immediate'));
});
