// Writes recap-data.js (window.RECAP): a plain-English look at the last 30 hours of finished games, per sport, shown at the top of each tab.
// Every sentence is built from the scored picks (picks-log.json), so the numbers cannot be misstated; there is no model in this step.
'use strict';
const fs = require('fs'), path = require('path');
const log = Object.values(JSON.parse(fs.readFileSync(path.join(__dirname, 'picks-log.json'), 'utf8')));
const HOURS = 30, now = Date.now(), LABEL = { nba: 'NBA', nfl: 'NFL', nhl: 'NHL', ncaaf: 'NCAA football', ncaab: 'NCAA basketball' };
const out = { generated: new Date(now).toISOString(), hours: HOURS, leagues: {} };
const side = (e, home) => (home ? e.home : e.away).abbr, won = e => e.result.homeScore > e.result.awayScore;
for (const sp of Object.keys(LABEL)) {
  const G = log.filter(e => e.league === sp && e.result && now - new Date(e.start).getTime() < HOURS * 3600e3 && e.result.homeScore !== e.result.awayScore);
  if (!G.length) continue;
  const simRight = G.filter(e => (e.simPHome > 0.5) === won(e)), M = G.filter(e => e.mkt && e.mkt.pHome != null), mktRight = M.filter(e => (e.mkt.pHome > 0.5) === won(e)), lines = [];
  lines.push(LABEL[sp] + ': the sim picked ' + simRight.length + ' of ' + G.length + ' winners' + (M.length ? ' and the market ' + mktRight.length + ' of ' + M.length : '') + '.');
  const split = M.filter(e => (e.simPHome > 0.5) !== (e.mkt.pHome > 0.5));
  if (split.length) { const s = split.filter(e => (e.simPHome > 0.5) === won(e)).length; lines.push('They disagreed on the winner in ' + split.length + (split.length > 1 ? ' games' : ' game') + '; the sim was right in ' + s + ' and the market in ' + (split.length - s) + '.'); }
  const up = G.slice().sort((a, b) => { const pa = won(a) ? a.simPHome : 1 - a.simPHome, pb = won(b) ? b.simPHome : 1 - b.simPHome; return pa - pb; })[0], pu = won(up) ? up.simPHome : 1 - up.simPHome;
  if (pu < 0.35) lines.push('Biggest upset by the sim: ' + side(up, won(up)) + ' beat ' + side(up, !won(up)) + ' ' + (won(up) ? up.result.homeScore + '-' + up.result.awayScore : up.result.awayScore + '-' + up.result.homeScore) + ' after the sim gave them ' + Math.round(100 * pu) + '%' + (up.mkt && up.mkt.pHome != null ? ' (market ' + Math.round(100 * (won(up) ? up.mkt.pHome : 1 - up.mkt.pHome)) + '%)' : '') + '.');
  const T = G.filter(e => e.mkt && e.mkt.total != null && e.simTotal != null);
  if (T.length >= 5) { const a = T.reduce((s, e) => s + (e.result.homeScore + e.result.awayScore - e.simTotal), 0) / T.length, b = T.reduce((s, e) => s + (e.result.homeScore + e.result.awayScore - e.mkt.total), 0) / T.length;
    lines.push('Total points came in ' + Math.abs(a).toFixed(1) + ' ' + (a < 0 ? 'under' : 'over') + ' the sim\'s totals on average and ' + Math.abs(b).toFixed(1) + ' ' + (b < 0 ? 'under' : 'over') + ' the market\'s.'); }
  out.leagues[sp] = { n: G.length, simRight: simRight.length, mktRight: M.length ? mktRight.length : null, nMkt: M.length, lines };
}
fs.writeFileSync(path.join(__dirname, 'recap-data.js'), 'window.RECAP = ' + JSON.stringify(out) + ';\n');
console.log('recap: ' + Object.keys(out.leagues).map(k => k + ' ' + out.leagues[k].n).join(', '));
