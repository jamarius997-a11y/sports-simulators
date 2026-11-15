// Weekly health and accuracy report -> reports/weekly-YYYY-MM-DD.md (run by .github/workflows/weekly.yml, or by hand: node weekly-review.js).
// Plain statistics, no model. It compares the live record with the backtest and the market, flags drift, and checks each data feed still delivers.
// A drift flag only says "look at this": a few dozen games are noisy, so nothing here changes a setting by itself.
'use strict';
const fs = require('fs'), path = require('path');
global.window = global;
for (const f of ['data.js', 'backtest-results.js', 'picks-results.js', 'blend-weights.js', 'news-data.js']) { try { require('./' + f); } catch (e) { /* optional */ } }
const D = window.LIVE_DATA || {}, B = (window.BACKTEST && window.BACKTEST.leagues) || {}, P = (window.PICKS && window.PICKS.leagues) || {}, F = (window.BLEND_FIT && window.BLEND_FIT.leagues) || {}, N = window.NEWS || { items: [] };
const LABEL = { nba: 'NBA', nfl: 'NFL', nhl: 'NHL', ncaaf: 'NCAA football', ncaab: 'NCAA basketball' }, pct = x => x == null ? '-' : (100 * x).toFixed(1) + '%';
const L = [], flags = [], today = new Date().toISOString().slice(0, 10);
L.push('# Weekly review, ' + today, '', 'Generated ' + new Date().toISOString() + '. Data file written ' + (D.generated || 'unknown') + '.', '');
L.push('## Live record against the backtest and the market', '', '| Sport | Scored | Sim winners | Market winners | Backtest winners | Sim Brier | Market Brier | Sim margin miss | Market margin miss |', '|---|---|---|---|---|---|---|---|---|');
for (const sp of Object.keys(LABEL)) {
  const p = P[sp] || {}, b = B[sp] || {}; if (!p.n) { L.push('| ' + LABEL[sp] + ' | 0 | - | - | ' + pct(b.acc) + ' | - | - | - | - |'); continue; }
  L.push('| ' + LABEL[sp] + ' | ' + p.n + ' | ' + pct(p.acc) + ' | ' + pct(p.accMkt) + ' | ' + pct(b.acc) + ' | ' + (p.brierSimMkt != null ? p.brierSimMkt : '-') + ' | ' + (p.brierMkt != null ? p.brierMkt : '-') + ' | ' + (p.marMAESim != null ? p.marMAESim : '-') + ' | ' + (p.marMAEMkt != null ? p.marMAEMkt : '-') + ' |');
  if (p.n >= 40 && b.acc != null) { const se = Math.sqrt(b.acc * (1 - b.acc) / p.n), z = (p.acc - b.acc) / se; if (z < -2) flags.push(LABEL[sp] + ': live winners ' + pct(p.acc) + ' is ' + Math.abs(z).toFixed(1) + ' standard errors under the backtest ' + pct(b.acc) + ' (' + p.n + ' games). Check the data feed first.'); }
  if (p.n >= 40 && p.brierSimMkt != null && p.brierMkt != null && p.brierSimMkt - p.brierMkt > 0.03) flags.push(LABEL[sp] + ': the sim trails the market by ' + (p.brierSimMkt - p.brierMkt).toFixed(3) + ' Brier over ' + p.n + ' games.');
  if (p.totBias != null && Math.abs(p.totBias) > 4 && p.nTot >= 30) flags.push(LABEL[sp] + ': totals are off by ' + p.totBias.toFixed(1) + ' points on average over ' + p.nTot + ' games (sim ' + (p.totBias > 0 ? 'low' : 'high') + ').');
}
L.push('', '## Calls against the line (sim 2+ points away from the posted number)', '', '| Sport | Spread calls right | Total calls right | News flags: games | News flags: flagged side did worse than the sim expected by |', '|---|---|---|---|---|');
for (const sp of Object.keys(LABEL)) { const p = P[sp] || {}; L.push('| ' + LABEL[sp] + ' | ' + (p.nCallS ? pct(p.hitCallS) + ' of ' + p.nCallS : '-') + ' | ' + (p.nCallT ? pct(p.hitCallT) + ' of ' + p.nCallT : '-') + ' | ' + (p.nNews || 0) + ' | ' + (p.nNews >= 30 ? p.newsMiss.toFixed(1) + ' pts' : 'too few') + ' |'); }
L.push('', '(52.4% is break-even at standard prices. The news-flag column is positive when headlines knew something the sim missed; it needs about 100 games to mean anything.)', '', '## Blend weights (sim share of the best-pick blend)', '', '| Sport | Scored games with a line | Best weight so far | In use | Source |', '|---|---|---|---|---|');
for (const sp of Object.keys(LABEL)) { const f = F[sp]; if (f) L.push('| ' + LABEL[sp] + ' | ' + f.n + ' | ' + (f.bestWeight == null ? '-' : f.bestWeight.toFixed(2)) + ' | ' + f.applied.toFixed(2) + ' | ' + f.source + ' |'); }
const E = Object.keys(F).filter(k => F[k].espn && F[k].espn.usable); if (E.length) { L.push('', '**ESPN BPI/FPI has enough games to consider as a blend input:** ' + E.map(k => LABEL[k] + ' (Brier ' + F[k].espn.brierEspn + ' vs sim ' + F[k].espn.brierSim + ' vs market ' + F[k].espn.brierMarket + ')').join('; ') + '.'); }
L.push('', '## Feeds', '');
const feed = (name, ok, note) => { L.push('- ' + (ok ? 'OK' : '**PROBLEM**') + ' ' + name + (note ? ': ' + note : '')); if (!ok) flags.push(name + ': ' + note); };
const age = (Date.now() - new Date(D.generated || 0).getTime()) / 3600e3; feed('data.js freshness', age < 12, age.toFixed(1) + ' hours old');
for (const sp of Object.keys(LABEL)) { const t = D[sp] ? Object.keys(D[sp]).length : 0, s = (D.schedule && D.schedule[sp] || []).length; feed(LABEL[sp] + ' teams', t >= { nba: 28, nfl: 30, nhl: 30, ncaaf: 120, ncaab: 300 }[sp], t + ' teams, ' + s + ' upcoming games'); }
const nn = N.items.length, nAge = (Date.now() - new Date(N.generated || 0).getTime()) / 3600e3; feed('news flags', nn > 0 && nAge < 12, nn + ' stated statuses, file ' + nAge.toFixed(1) + ' hours old' + (N.items.some(i => i.by === 'model') ? ', hosted model in use' : ', keyword rules only'));
const log = JSON.parse(fs.readFileSync(path.join(__dirname, 'picks-log.json'), 'utf8')), kb = Math.round(fs.statSync(path.join(__dirname, 'picks-log.json')).size / 1024); feed('picks log', kb < 4000, Object.keys(log).length + ' open games, ' + kb + ' KB');
L.push('', '## Needs a look', '', flags.length ? flags.map(f => '- ' + f).join('\n') : 'Nothing flagged.', '');
fs.mkdirSync(path.join(__dirname, 'reports'), { recursive: true });
fs.writeFileSync(path.join(__dirname, 'reports', 'weekly-' + today + '.md'), L.join('\n'));
console.log('wrote reports/weekly-' + today + '.md; ' + flags.length + ' flag(s)' + (flags.length ? ':\n - ' + flags.join('\n - ') : ''));
