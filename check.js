// Quick health check for every sport: node check.js   (exit code 1 if anything fails)
// node check.js --ci   fails only on hard errors (a crash, a missing or NaN rating, a bad score, an unreadable picks log); softer findings (fewer players than usual,
//                      no backtest) are printed as warnings. The refresh workflow runs this before committing, so bad data never reaches the site.
// Loads the live data, then for each sport plays a detailed game, a 400-game Monte Carlo and a series, and checks the upcoming schedule,
// the picks log and the track record all line up. Run it after changing sim.js or the data scripts.
'use strict';
const fs = require('fs'), path = require('path');
global.window = global;
const Sim = require('./sim.js');
require('./data.js'); try { require('./backtest-results.js'); require('./picks-results.js'); } catch (e) { /* optional */ }
const D = window.LIVE_DATA, live = Sim.applyLive(D), fails = [];
const CI = process.argv.includes('--ci'), warns = [], SOFT = /fewer than 90%|no backtest/;
const ok = (cond, msg) => { if (!cond) (CI && SOFT.test(msg) ? warns : fails).push(msg); return cond; };
const fin = x => typeof x === 'number' && isFinite(x);

for (const sp of Object.keys(Sim.SPORTS)) {
  const S = Sim.SPORTS[sp], T = S.teams, rng = Sim.makeRng(12345), note = [];
  try {
    if (!ok(T.length >= 2, sp + ': no teams loaded')) continue;
    const a = T[0], h = T[T.length - 1], keys = S.fields.map(f => f[0]);
    ok(T.every(t => keys.every(k => fin(t[k]))), sp + ': a team has a missing rating');
    const g = Sim.simGame(sp, a, h, rng, { detail: true });
    ok(fin(g.score[0]) && fin(g.score[1]) && g.score[0] >= 0 && g.score[1] >= 0, sp + ': bad score in a single game');
    ok(g.line && g.line.rows.length === 2 && Array.isArray(g.box), sp + ': single game has no line score or box score');
    ok(!g.tables || g.tables.every(t => Array.isArray(t)), sp + ': player tables malformed');
    const m = Sim.monteCarlo(sp, a, h, 400, rng, {}), p = (m.wins[1] + m.wins[2] / 2) / m.n;
    ok(fin(m.avg[0]) && fin(m.avg[1]) && p >= 0 && p <= 1 && fin(m.avgTotal), sp + ': Monte Carlo returned bad numbers');
    const s = Sim.playSeries(sp, a, h, 7, rng, {}); ok(s && typeof s === 'object', sp + ': series failed');
    note.push(T.length + ' teams', 'game ' + g.score.join('-'), 'home wins ' + Math.round(p * 100) + '%', 'avg total ' + m.avgTotal.toFixed(1));
    if (sp !== 'mlb') {
      ok(T.filter(t => t.live).length >= T.length * 0.9, sp + ': fewer than 90% of teams have live ratings');
      const withR = T.filter(t => t.roster).length; note.push(withR + ' with real players');
      ok(withR >= T.length * 0.9, sp + ': fewer than 90% of teams have real players');
      const sched = (D.schedule && D.schedule[sp]) || [], find = x => (x.id && T.find(t => t.eid === x.id)) || T.find(t => t.name === x.name) || T.find(t => t.id === x.abbr);
      const matched = sched.filter(x => find(x.away) && find(x.home)); note.push(sched.length + ' upcoming (' + matched.length + ' simulated, ' + sched.filter(x => x.line).length + ' with a line)');
      if (matched.length) { const x = matched[0], r = Sim.monteCarlo(sp, find(x.away), find(x.home), 200, rng, { neutral: !!(x.venue && x.venue.neutral), weather: x.weather, rest: { away: x.awayRest, home: x.homeRest } }); ok(fin(r.avgTotal), sp + ': an upcoming game failed to simulate'); }
      const inj = T.reduce((n, t) => n + Sim.injuries(sp, t).length, 0); note.push(inj + ' players flagged out or doubtful');
      const B = window.BACKTEST && window.BACKTEST.leagues[sp]; ok(B && B.n > 100, sp + ': no backtest results'); if (B) note.push('backtest ' + (B.acc * 100).toFixed(1) + '% of ' + B.n);
      const P = window.PICKS && window.PICKS.leagues[sp]; if (P) note.push('live record ' + (P.n ? (P.acc * 100).toFixed(1) + '% of ' + P.n : 'none yet') + ', ' + P.pending + ' pending');
    }
  } catch (e) { fails.push(sp + ': crashed: ' + e.message); }
  console.log((fails.some(f => f.startsWith(sp + ':')) ? 'FAIL ' : 'ok   ') + S.label.padEnd(8) + note.join(' · '));
}
// data freshness and the picks log
const age = (Date.now() - new Date(D.generated).getTime()) / 3600e3; console.log('data.js is ' + age.toFixed(1) + ' hours old; ' + live + ' teams with live ratings');
try {
  const log = JSON.parse(fs.readFileSync(path.join(__dirname, 'picks-log.json'), 'utf8')), n = Object.keys(log).length, kb = Math.round(fs.statSync(path.join(__dirname, 'picks-log.json')).size / 1024);
  ok(Object.values(log).every(e => e.key && e.league && e.start && fin(e.simPHome)), 'picks-log.json has a malformed entry');
  console.log('picks-log.json: ' + n + ' games, ' + kb + ' KB');
} catch (e) { fails.push('picks-log.json unreadable: ' + e.message); }
if (warns.length) console.log('\nWarnings (not blocking):\n - ' + warns.join('\n - '));
if (fails.length) { console.log('\nPROBLEMS:\n - ' + fails.join('\n - ')); process.exit(1); }
console.log('\nAll checks passed.');
