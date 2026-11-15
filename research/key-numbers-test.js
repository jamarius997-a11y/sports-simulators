// Audit test (Nov 2026): is a bell curve a fair model of how far results land from the closing line, or do key numbers (3, 7, 10) matter? Result: the bell curve is fine.
// Usage: node research/key-numbers-test.js
// closing-line misses (actual margin - closing margin): shape, push rate, key numbers; normal vs empirical, tested across seasons
const R0 = require('path').join(__dirname, '..'), C = require(R0 + '/college.js'), { read } = require(R0 + '/csv.js'), fs = require('fs');
const sets = {};   // name -> [{ y: season, r: actual - closing margin, t: actual total - closing total }]
(async () => {
  for (const [L, name] of [['ncaaf', 'college football'], ['ncaab', 'college basketball']]) for (const y of [2023, 2024, 2025]) {
    const raw = await C.seasonGames(L, y), D = await C.seasonDetail(L, y), a = sets[name] = sets[name] || [];
    for (const d in raw) for (const g of raw[d]) { const o = D[g[5]] && D[g[5]].o; if (!o || o[0] == null) continue; a.push({ y, r: (g[2] - g[3]) - (-o[0]), t: o[1] != null ? (g[2] + g[3]) - o[1] : null, neutral: g[4] }); }
  }
  const nf = read(R0 + '/cache/nfl_games.csv'); console.log('nfl_games columns:', Object.keys(nf[0]).join(',').slice(0, 300));
  const a = sets['NFL'] = []; for (const g of nf) { if (g.game_type !== 'REG' || g.result === '' || g.spread_line === '' || g.result == null) continue; const y = +g.season; if (y < 2022) continue; a.push({ y, r: +g.result - (+g.spread_line), t: g.total_line ? (+g.home_score + +g.away_score) - +g.total_line : null }); }
  const nrm = (x, s) => 0.5 * (1 + Math.sign(x) * Math.sqrt(1 - Math.exp(-4 * (x / s / Math.SQRT2) ** 2 / Math.PI)));
  for (const name in sets) {
    const S = sets[name], yrs = [...new Set(S.map(x => x.y))].sort(), all = S.map(x => x.r), m = all.reduce((p, q) => p + q, 0) / all.length, sd = Math.sqrt(all.reduce((p, q) => p + (q - m) ** 2, 0) / all.length), k = all.reduce((p, q) => p + ((q - m) / sd) ** 4, 0) / all.length;
    const intShare = all.filter(x => Math.abs(x - Math.round(x)) < 1e-9).length / all.length;
    const mass = v => (100 * all.filter(x => Math.round(x) === v && Math.abs(x - v) < 1e-9).length / all.length).toFixed(1);
    console.log('\n##', name, 'games', all.length, 'seasons', yrs.join(','), '| mean miss', m.toFixed(2), 'SD', sd.toFixed(2), 'kurtosis', k.toFixed(2), '(normal = 3.00) | share on whole numbers', (100 * intShare).toFixed(0) + '%');
    console.log('   actual result lands exactly on the number (push): ' + mass(0) + '%; normal curve says ' + (100 * (nrm(0.5, sd) - nrm(-0.5, sd))).toFixed(1) + '%');
    console.log('   miss of exactly +-3: ' + (+mass(3) + +mass(-3)).toFixed(1) + '%, +-7: ' + (+mass(7) + +mass(-7)).toFixed(1) + '%, +-10: ' + (+mass(10) + +mass(-10)).toFixed(1) + '%; normal says ' + (200 * (nrm(3.5, sd) - nrm(2.5, sd))).toFixed(1) + '%, ' + (200 * (nrm(7.5, sd) - nrm(6.5, sd))).toFixed(1) + '%, ' + (200 * (nrm(10.5, sd) - nrm(9.5, sd))).toFixed(1) + '%');
    // out-of-season test: for each season, predict P(actual miss > c) for thresholds c with (a) a normal curve using the SD of OTHER seasons, (b) the empirical distribution of OTHER seasons. Brier on the held-out season.
    const cs = [-14, -10, -7, -3.5, -2.5, -1, 0, 1, 2.5, 3.5, 7, 10, 14].map(c => c * (sd / 13)); let bN = 0, bE = 0, n = 0;
    for (const y of yrs) { const tr = S.filter(x => x.y !== y).map(x => x.r), te = S.filter(x => x.y === y).map(x => x.r), tm = tr.reduce((p, q) => p + q, 0) / tr.length, ts = Math.sqrt(tr.reduce((p, q) => p + (q - tm) ** 2, 0) / tr.length);
      for (const c of cs) { const pe = tr.filter(x => x > c).length / tr.length, pn = 1 - nrm(c - tm, ts); for (const r of te) { const o = r > c ? 1 : 0; bN += (pn - o) ** 2; bE += (pe - o) ** 2; n++; } } }
    console.log('   held-out Brier over 13 thresholds: normal ' + (bN / n).toFixed(5) + ' | empirical ' + (bE / n).toFixed(5) + ' | gain ' + (100 * (bN - bE) / bN).toFixed(2) + '%');
    const T = S.filter(x => x.t != null).map(x => x.t); if (T.length) { const tm = T.reduce((p, q) => p + q, 0) / T.length, ts = Math.sqrt(T.reduce((p, q) => p + (q - tm) ** 2, 0) / T.length); console.log('   totals: n ' + T.length + ' mean miss ' + tm.toFixed(2) + ' SD ' + ts.toFixed(2)); }
    // does the miss SD depend on how big the spread is?  (heteroscedasticity)
  }
})().catch(e => console.log('ERR', e));
