// One command to keep everything current: fresh data -> log today's picks -> score finished games.
// Run by hand with `node refresh.js`, or on a schedule (see run-refresh.bat).
'use strict';
const { execFileSync } = require('child_process'), path = require('path');
for (const script of ['update-data.js', 'log-picks.js', 'score-picks.js']) {
  console.log('\n[' + new Date().toLocaleString() + '] ' + script);
  try { execFileSync(process.execPath, [path.join(__dirname, script)], { stdio: 'inherit', cwd: __dirname }); }
  catch (e) { console.log('  FAILED: ' + script + ' (continuing)'); }
}
