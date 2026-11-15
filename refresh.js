// One command to keep everything current: fresh data -> log today's picks -> score finished games.
// Run by hand with `node refresh.js`, or on a schedule (see run-refresh.bat).
'use strict';
const { execFileSync } = require('child_process'), path = require('path');
for (const script of ['update-data.js', 'fetch-news.js', 'log-picks.js', 'score-picks.js', 'fit-blend.js', 'recap.js']) {
  console.log('\n[' + new Date().toLocaleString() + '] ' + script);
  const [file, ...args] = script.split(' ');
  try { execFileSync(process.execPath, [path.join(__dirname, file), ...args], { stdio: 'inherit', cwd: __dirname }); }
  catch (e) { console.log('  FAILED: ' + script + ' (continuing)'); }
}
