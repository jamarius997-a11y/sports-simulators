// Audit test (Nov 2026): do player values learned from last season price missed college basketball players better than the Game Score rule? Result: no.
// Usage: node research/player-value-test.js . 2025   (root folder, then the season to test; needs the box scores in cache/, which backtest-college.js downloads)
// Player-value test (college basketball): learn each player's effect on his team's margin from last season, price missed players with it.  node pv.js <root> <testYear>
const ROOT = process.argv[2], Y1 = +process.argv[3], Y0 = Y1 - 1, L = 'ncaab', C = require(ROOT + '/college.js');
const season = async y => { const raw = await C.seasonGames(L, y), D = await C.seasonDetail(L, y), days = {}; for (const d in raw) days[d] = raw[d].map(g => C.gameRow(L, g, D[g[5]])); return { days, D }; };
const gsOf = p => p[3] + 0.28 * p[7] + 0.7 * p[8] + p[9] + 0.7 * p[10] - 0.7 * p[4] - 0.2 * p[5] - p[6];   // same formula as college.js players()
(async () => {
  const cfg = C.CFG[L], S0 = await season(Y0), S1 = await season(Y1), M = new Set(Object.keys(await C.members(L, Y1)));
  const base = { members: M, hca: cfg.hca, k: cfg.k, carry: cfg.carry, gap: cfg.gap, gapD: cfg.gapD };
  // ---- train: season Y0, whole-season ratings, residual margin vs players' minutes deviation ----
  const R0 = C.rate(C.flat(L, S0.days, M), Object.assign({}, base, { lg: 0 }));
  const games = [], teamG = {}, tot = {};   // tot[team|player] = minutes
  for (const day of Object.keys(S0.days).sort()) for (const g of S0.days[day]) { const d = S0.D[g[5]]; if (!d || !d.p[0] || !d.p[1] || !M.has(g[0]) || !M.has(g[1]) || !R0.teams[g[0]] || !R0.teams[g[1]]) continue;
    games.push(g); [0, 1].forEach(i => { const t = g[i]; teamG[t] = (teamG[t] || 0) + 1; for (const p of d.p[i]) tot[t + '|' + p[0]] = (tot[t + '|' + p[0]] || 0) + p[2]; }); }
  const avg = k => { const t = k.split('|')[0]; return (tot[k] || 0) / teamG[t]; };
  const roster = {}; for (const k in tot) { const [t, id] = k.split('|'); if (avg(k) >= 5) (roster[t] = roster[t] || []).push(id); }
  const rows = games.map(g => { const d = S0.D[g[5]], H = R0.teams[g[0]], A = R0.teams[g[1]], pm = (H.o - H.d) - (A.o - A.d) + (g[4] ? 0 : cfg.hca), r = (g[2] - g[3]) - pm, x = [];
    [0, 1].forEach(i => { const t = g[i], mins = {}; for (const p of d.p[i]) mins[p[0]] = p[2]; for (const id of roster[t] || []) x.push([t + '|' + id, (i ? -1 : 1) * ((mins[id] || 0) - avg(t + '|' + id)) / 40]); }); return { r, x }; });
  function fit(lam) {
    const v = {}, byP = {}; rows.forEach((row, i) => row.x.forEach(([k, d]) => { (byP[k] = byP[k] || []).push([i, d]); })); const pred = new Float64Array(rows.length);
    for (let it = 0; it < 25; it++) for (const k in byP) { let num = 0, den = lam; const vk = v[k] || 0; for (const [i, d] of byP[k]) { num += d * (rows[i].r - pred[i] + d * vk); den += d * d; } const nv = num / den; for (const [i, d] of byP[k]) pred[i] += d * (nv - vk); v[k] = nv; }
    return v; }
  // ---- test: walk-forward on Y1 ----
  const prior = R0, days = Object.keys(S1.days).sort(), state = {};
  const out = {};   // variant -> [abs errors]
  const add = (name, e) => (out[name] = out[name] || []).push(e);
  const VAL = {};   // player id -> fitted value (any team), trained value per full game
  const LAM = [30, 100, 300];
  const fits = LAM.map(l => fit(l)); fits.forEach((v, j) => { VAL[j] = {}; for (const k in v) { const id = k.split('|')[1]; VAL[j][id] = (VAL[j][id] || 0) + v[k] * 0; VAL[j][id] = v[k]; } });
  const sorted = fits[1] ? Object.entries(fits[1]).sort((a, b) => b[1] - a[1]) : []; console.log('fitted values (λ=100): top', sorted.slice(0, 3).map(x => x[1].toFixed(1)).join(', '), 'bottom', sorted.slice(-2).map(x => x[1].toFixed(1)).join(', '), '| SD', Math.sqrt(sorted.reduce((a, x) => a + x[1] ** 2, 0) / sorted.length).toFixed(2), 'players', sorted.length);
  let nFlag = 0, nGame = 0, nKnown = 0, nPlayers = 0;
  for (const day of days) {
    const R = C.rate(C.flat(L, S1.days, M, day), Object.assign({}, base, { prior: prior.teams, lg: prior.lg }));
    const flagged = id => { const T = state[id]; if (!T || T.g < 4) return []; return Object.entries(T.p).filter(([pid, a]) => { const mpg = a[2] / a[1], gpr = a[1] / T.g; return T.g - a[11] > 0 && mpg >= 12 && gpr >= 0.4 && Object.values(T.p).filter(b => b[2] > a[2]).length < 11; }).map(([pid, a]) => ({ id: pid, mpg: a[2] / a[1], gpr: a[1] / T.g, gs40: 40 * gsOf(a) / a[2] })); };
    for (const g of S1.days[day]) {
      if (!M.has(g[0]) || !M.has(g[1])) continue; const H = R.teams[g[0]], A = R.teams[g[1]]; if (!H || !A || H.n < 3 || A.n < 3) continue;
      const rm = (H.o - H.d) - (A.o - A.d) + (g[4] ? 0 : cfg.hca), am = g[2] - g[3]; nGame++;
      const fh = flagged(g[0]), fa = flagged(g[1]); if (fh.length || fa.length) nFlag++;
      const rule = f => Math.min(8, f.reduce((a, p) => a + 0.5 * (p.mpg / 40) * p.gpr * Math.max(0, p.gs40 - 8), 0));
      const learned = (f, j, k) => Math.min(8, f.reduce((a, p) => { const v = VAL[j][p.id]; if (v == null) { nPlayers++; return a + 0.5 * (p.mpg / 40) * p.gpr * Math.max(0, p.gs40 - 8); } nKnown++; return a + k * Math.max(0, v) * (p.mpg / 40) * p.gpr; }, 0));
      add('no absence adjustment', Math.abs(rm - am)); add('current rule (Game Score)', Math.abs(rm - rule(fh) + rule(fa) - am));
      for (let j = 0; j < LAM.length; j++) for (const k of [0.5, 1, 1.5]) add('learned λ=' + LAM[j] + ' ×' + k, Math.abs(rm - learned(fh, j, k) + learned(fa, j, k) - am));
    }
    for (const g of S1.days[day]) { C.track(L, state, g, S1.D[g[5]]); }
  }
  // players were tracked with ids in state.p keys; the learned values are keyed by the same athlete ids
  console.log('\n== train ' + Y0 + ' -> test ' + Y1 + ': ' + nGame + ' games, ' + nFlag + ' with a flagged player; flagged players with a learned value ' + nKnown + ' vs without (fallback) ' + nPlayers);
  const base0 = out['no absence adjustment'].reduce((a, b) => a + b, 0) / nGame;
  for (const k in out) { const m = out[k].reduce((a, b) => a + b, 0) / out[k].length; console.log(k.padEnd(30), 'margin miss', m.toFixed(4), (m - base0 >= 0 ? '+' : '') + (m - base0).toFixed(4), 'vs no adjustment'); }
})().catch(e => console.log('ERR', e));
