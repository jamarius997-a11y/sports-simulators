// Learns how much weight the sim deserves against the betting market, per sport, from the scored picks (picks-log.json plus picks-archive/).
// For each sport it finds the sim weight w that minimises the Brier score of  w * sim + (1 - w) * market  on every scored game that had a line.
// Until a sport has NMIN scored games it keeps the default; after that the fitted weight is shrunk toward the default (as if K games agreed with it) and capped at MAXW.
// Writes blend-weights.js (window.BLEND_FIT), read by index.html, log-picks.js and score-picks.js. Run by refresh.js after score-picks.js.
'use strict';
const fs = require('fs'), path = require('path');
const DEFAULT = { nba: 0.15, nfl: 0.15, nhl: 0.15, ncaaf: 0.3, ncaab: 0.1 }, NMIN = 150, K = 200, MAXW = 0.6;
const dir = path.join(__dirname, 'picks-archive');
const log = Object.values(JSON.parse(fs.readFileSync(path.join(__dirname, 'picks-log.json'), 'utf8')));
const arch = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => /^\d{4}-\d{2}\.json$/.test(f)).flatMap(f => Object.values(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')))) : [];
const seen = new Set(), all = [];
for (const e of log.concat(arch)) if (!seen.has(e.key)) { seen.add(e.key); all.push(e); }
const y = e => e.result.homeScore === e.result.awayScore ? 0.5 : e.result.homeScore > e.result.awayScore ? 1 : 0;
const out = { generated: new Date().toISOString(), nMin: NMIN, apply: {}, leagues: {} };
for (const sp of Object.keys(DEFAULT)) {
  const M = all.filter(e => e.league === sp && e.result && e.mkt && e.mkt.pHome != null && e.simPHome != null), n = M.length;
  const brier = w => M.reduce((a, e) => a + (w * e.simPHome + (1 - w) * e.mkt.pHome - y(e)) ** 2, 0) / Math.max(1, n);
  let best = DEFAULT[sp], bb = Infinity; for (let w = 0; w <= 1.0001; w += 0.05) { const b = brier(w); if (b < bb) { bb = b; best = +w.toFixed(2); } }
  const fitted = n >= NMIN, w = fitted ? +Math.min(MAXW, Math.max(0, (n * best + K * DEFAULT[sp]) / (n + K))).toFixed(2) : DEFAULT[sp];
  const E = M.filter(e => e.espnPHome != null);   // ESPN's BPI/FPI: reported only (not used in picks) until it has NMIN games
  let espn = null; if (E.length >= 30) { const b = f => E.reduce((a, e) => a + (f(e) - y(e)) ** 2, 0) / E.length; espn = { n: E.length, brierEspn: +b(e => e.espnPHome).toFixed(4), brierSim: +b(e => e.simPHome).toFixed(4), brierMarket: +b(e => e.mkt.pHome).toFixed(4), usable: E.length >= NMIN }; }
  out.leagues[sp] = { n, bestWeight: n ? best : null, brierAtBest: n ? +bb.toFixed(4) : null, brierAtDefault: n ? +brier(DEFAULT[sp]).toFixed(4) : null, applied: w, source: fitted ? 'fit' : 'default', espn };
  if (fitted) out.apply[sp] = w;
  console.log(sp.toUpperCase().padEnd(6), 'scored games with a line', String(n).padStart(4), '| best sim weight', n ? best.toFixed(2) : '  - ', '| using', w.toFixed(2), fitted ? '(fitted)' : '(default; fits start at ' + NMIN + ' games)', espn ? '| ESPN BPI/FPI Brier ' + espn.brierEspn + ' vs sim ' + espn.brierSim + ' vs market ' + espn.brierMarket + ' on ' + espn.n : '');
}
fs.writeFileSync(path.join(__dirname, 'blend-weights.js'), 'window.BLEND_FIT = ' + JSON.stringify(out) + ';\n');
