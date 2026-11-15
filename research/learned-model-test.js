// Audit test (Nov 2026): can a learned model (ridge, boosted trees) beat the opponent-adjusted ratings for college basketball margins? Result: no.
// Usage: node research/learned-model-test.js .
// Learned college basketball model vs the current ratings.  node ml.js <root>
// Features are built walk-forward (only what was known before each game); a model is trained on one season and tested on the other, both ways.
const ROOT = process.argv[2], L = 'ncaab', fs = require('fs'), C = require(ROOT + '/college.js');
const cdf = z => 0.5 * (1 + Math.sign(z) * Math.sqrt(1 - Math.exp(-4 * (z / Math.SQRT2) ** 2 / Math.PI)));
const dnum = d => Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8)) / 86400000;
const STATS = ['efg', 'tov', 'orb', 'ftr', 'tpar', 'tp', 'ft', 'pace'];
let NAMES = null;

async function build(YEAR) {
  const season = async y => { const raw = await C.seasonGames(L, y), D = await C.seasonDetail(L, y), days = {}; for (const d in raw) days[d] = raw[d].map(g => C.gameRow(L, g, D[g[5]])); return { days, D }; };
  const cfg = C.CFG[L], prev = await season(YEAR - 1), cur = await season(YEAR), M = new Set(Object.keys(await C.members(L, YEAR)));
  const base = { members: M, hca: cfg.hca, k: cfg.k, carry: cfg.carry, gap: cfg.gap, gapD: cfg.gapD }, prior = C.rate(C.flat(L, prev.days, M), Object.assign({}, base, { lg: 0 }));
  const acc = {}, state = {}, rows = [], LG = { s: new Array(16).fill(0), n: 0 };
  const A = id => acc[id] || (acc[id] = { g: 0, own: new Array(8).fill(0), opp: new Array(8).fill(0), poss: 0, res: [], last: null });
  const poss = t => t[1] - t[6] + t[7] + 0.475 * t[5];
  const rates = (t, p, g) => ({ efg: (t[0] + 0.5 * t[2]) / t[1], tov: t[7] / p, orb: t[6] / Math.max(1, t[1] - t[0]), ftr: t[5] / t[1], tpar: t[3] / t[1], tp: t[2] / Math.max(1, t[3]), ft: t[4] / Math.max(1, t[5]), pace: p / g });
  for (const day of Object.keys(cur.days).sort()) {
    const R = C.rate(C.flat(L, cur.days, M, day), Object.assign({}, base, { prior: prior.teams, lg: prior.lg })), dn = dnum(day);
    for (const g of cur.days[day]) {
      if (!M.has(g[0]) || !M.has(g[1])) continue;
      const H = R.teams[g[0]], Aw = R.teams[g[1]], ah = acc[g[0]], aa = acc[g[1]];
      if (!H || !Aw || H.n < 3 || Aw.n < 3 || !ah || !aa || ah.g < 3 || aa.g < 3) continue;
      const hca = g[4] ? 0 : cfg.hca, lost = id => { const pl = C.players(L, state[id]) || []; return Math.min(8, pl.filter(p => p.out).reduce((a, p) => a + 0.5 * (p.min / 40) * p.gpr * Math.max(0, p.gs40 - 8), 0)); };
      const lh = lost(g[0]), la = lost(g[1]); let rm = (H.o - H.d) - (Aw.o - Aw.d) + hca - lh + la; rm += Math.sign(rm) * 0.25 * Math.max(0, Math.abs(rm) - 10);
      const rt = 2 * R.lg + H.o + H.d + Aw.o + Aw.d;
      const f = { rm, rt, oH: H.o, dH: H.d, oA: Aw.o, dA: Aw.d, neutral: g[4], lostH: lh, lostA: la, gpH: ah.g, gpA: aa.g, restH: Math.min(10, dn - ah.last), restA: Math.min(10, dn - aa.last),
        formH: ah.res.slice(-5).reduce((x, y) => x + y, 0) / Math.min(5, ah.res.length), formA: aa.res.slice(-5).reduce((x, y) => x + y, 0) / Math.min(5, aa.res.length), lg: R.lg, dayOfSeason: dn - dnum(Object.keys(cur.days).sort()[0]) };
      for (const [tag, a] of [['H', ah], ['A', aa]]) { const o = rates(a.own, a.poss, a.g), d = rates(a.opp, a.poss, a.g); for (const s of STATS) { f['o_' + s + tag] = o[s]; if (s !== 'pace') f['d_' + s + tag] = d[s]; } }
      const o = cur.D[g[5]] && cur.D[g[5]].o;
      NAMES = NAMES || Object.keys(f);
      rows.push({ x: NAMES.map(k => isFinite(f[k]) ? f[k] : 0), am: g[2] - g[3], at: g[2] + g[3], rm, rt, mm: o && o[0] != null ? -o[0] : null, mt: o ? o[1] : null });
    }
    for (const g of cur.days[day]) {
      const d = cur.D[g[5]]; C.track(L, state, g, d);
      if (!d || !d.t[0] || !d.t[1]) continue;
      const p = (poss(d.t[0]) + poss(d.t[1])) / 2, H = R.teams[g[0]], Aw = R.teams[g[1]];
      const pred = H && Aw ? (H.o - H.d) - (Aw.o - Aw.d) + (g[4] ? 0 : cfg.hca) : null;
      [[g[0], 0], [g[1], 1]].forEach(([id, i]) => { const a = A(id); a.g++; a.poss += p; for (let k = 0; k < 8; k++) { a.own[k] += d.t[i][k]; a.opp[k] += d.t[1 - i][k]; } a.last = dn; if (pred != null) a.res.push((i ? -1 : 1) * (g[2] - g[3] - pred)); });
    }
  }
  return rows;
}

// ---- models ----
function ridge(X, y, lam) {   // standardized features, intercept
  const n = X.length, p = X[0].length, mu = new Array(p).fill(0), sd = new Array(p).fill(0);
  for (const r of X) r.forEach((v, j) => mu[j] += v / n); for (const r of X) r.forEach((v, j) => sd[j] += (v - mu[j]) ** 2 / n); sd.forEach((v, j) => sd[j] = Math.sqrt(v) || 1);
  const my = y.reduce((a, b) => a + b, 0) / n, Am = Array.from({ length: p }, () => new Array(p + 1).fill(0));
  for (let i = 0; i < n; i++) { const z = X[i].map((v, j) => (v - mu[j]) / sd[j]); for (let a = 0; a < p; a++) { for (let b = a; b < p; b++) Am[a][b] += z[a] * z[b]; Am[a][p] += z[a] * (y[i] - my); } }
  for (let a = 0; a < p; a++) { for (let b = 0; b < a; b++) Am[a][b] = Am[b][a]; Am[a][a] += lam * n; }
  for (let i = 0; i < p; i++) { let q = i; for (let r = i + 1; r < p; r++) if (Math.abs(Am[r][i]) > Math.abs(Am[q][i])) q = r; [Am[i], Am[q]] = [Am[q], Am[i]]; for (let r = 0; r < p; r++) if (r !== i) { const f = Am[r][i] / Am[i][i]; for (let c = i; c <= p; c++) Am[r][c] -= f * Am[i][c]; } }
  const w = Am.map((r, i) => r[p] / r[i]);
  return x => my + x.reduce((s, v, j) => s + w[j] * (v - mu[j]) / sd[j], 0);
}
function gbm(X, y, o) {   // gradient-boosted regression trees (squared error), histogram splits
  const n = X.length, p = X[0].length, B = 24, rnd = (s => () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296)(7);
  const edges = [], bin = Array.from({ length: n }, () => new Uint8Array(p));
  for (let j = 0; j < p; j++) { const v = X.map(r => r[j]).sort((a, b) => a - b), e = []; for (let b = 1; b < B; b++) e.push(v[Math.floor(n * b / B)]); edges.push(e); for (let i = 0; i < n; i++) { let b = 0; while (b < e.length && X[i][j] > e[b]) b++; bin[i][j] = b; } }
  const f0 = y.reduce((a, b) => a + b, 0) / n, F = new Array(n).fill(f0), trees = [];
  const grow = (idx, res, depth) => {
    const sum = idx.reduce((a, i) => a + res[i], 0), node = { v: sum / idx.length };
    if (depth >= o.depth || idx.length < 2 * o.leaf) return node;
    let best = 0, bj = -1, bb = -1;
    for (let j = 0; j < p; j++) { const hs = new Float64Array(B), hn = new Int32Array(B); for (const i of idx) { hs[bin[i][j]] += res[i]; hn[bin[i][j]]++; }
      let ls = 0, ln = 0; for (let b = 0; b < B - 1; b++) { ls += hs[b]; ln += hn[b]; const rn = idx.length - ln; if (ln < o.leaf || rn < o.leaf) continue; const gain = ls * ls / ln + (sum - ls) ** 2 / rn - sum * sum / idx.length; if (gain > best) { best = gain; bj = j; bb = b; } } }
    if (bj < 0) return node;
    node.j = bj; node.t = edges[bj][bb]; node.l = grow(idx.filter(i => bin[i][bj] <= bb), res, depth + 1); node.r = grow(idx.filter(i => bin[i][bj] > bb), res, depth + 1); return node;
  };
  const walk = (t, x) => { while (t.j != null) t = x[t.j] <= t.t ? t.l : t.r; return t.v; };
  for (let m = 0; m < o.rounds; m++) { const res = y.map((v, i) => v - F[i]), idx = []; for (let i = 0; i < n; i++) if (rnd() < o.sub) idx.push(i); const t = grow(idx, res, 0); trees.push(t); for (let i = 0; i < n; i++) F[i] += o.lr * walk(t, X[i]); }
  return x => trees.reduce((s, t) => s + o.lr * walk(t, x), f0);
}

(async () => {
  const S = { 2024: await build(2024), 2025: await build(2025) };
  console.log('features per game: ' + NAMES.length + ' (' + NAMES.slice(0, 17).join(', ') + ', then eight box-score rates on offense and seven on defense for each team)');
  const G = { depth: 3, leaf: 40, rounds: 300, lr: 0.04, sub: 0.7 };
  for (const [tr, te] of [[2024, 2025], [2025, 2024]]) {
    const A = S[tr], T = S[te], X = A.map(r => r.x), XT = T.map(r => r.x);
    // every learned model predicts the correction to the current system's number (so it can only add to it), for margin and for total
    const fit = (kind, key, basek) => { const y = A.map(r => r[key] - r[basek]); const f = kind === 'ridge' ? ridge(X, y, 0.05) : gbm(X, y, G); return XT.map((x, i) => T[i][basek] + f(x)); };
    const P = { 'current ratings': { m: T.map(r => r.rm), t: T.map(r => r.rt) }, 'learned: linear (ridge)': { m: fit('ridge', 'am', 'rm'), t: fit('ridge', 'at', 'rt') }, 'learned: boosted trees': { m: fit('gbm', 'am', 'rm'), t: fit('gbm', 'at', 'rt') } };
    P['learned: small trees'] = (() => { const G2 = { depth: 2, leaf: 80, rounds: 150, lr: 0.03, sub: 0.7 }, g = (key, basek) => { const f = gbm(X, A.map(r => r[key] - r[basek]), G2); return XT.map((x, i) => T[i][basek] + f(x)); }; return { m: g('am', 'rm'), t: g('at', 'rt') }; })();
    P['average of ratings + trees'] = { m: T.map((r, i) => (r.rm + P['learned: boosted trees'].m[i]) / 2), t: T.map((r, i) => (r.rt + P['learned: boosted trees'].t[i]) / 2) };
    const K = T.map((r, i) => i).filter(i => T[i].mm != null), Kt = K.filter(i => T[i].mt != null), mean = (I, f) => I.reduce((a, i) => a + f(i), 0) / I.length, all = T.map((r, i) => i);
    console.log('\n== trained on ' + tr + '-' + (tr + 1 - 2000) + ' (' + A.length + ' games), tested on ' + te + '-' + (te + 1 - 2000) + ' (' + T.length + ' games, ' + K.length + ' with a closing line)');
    console.log('model'.padEnd(30) + 'margin miss  total miss  Brier    winners  vs spread (3+ pts off)   totals (3+ off)');
    const line = (name, m, t) => { const rec = (I, pred, mk, act) => { let w = 0, l = 0; for (const i of I) { const e = pred[i] - mk(i), a = act(i) - mk(i); if (Math.abs(e) < 3 || a === 0) continue; Math.sign(e) === Math.sign(a) ? w++ : l++; } return w + '-' + l + ' (' + (100 * w / Math.max(1, w + l)).toFixed(1) + '%)'; };
      console.log(name.padEnd(30) + mean(all, i => Math.abs(m[i] - T[i].am)).toFixed(3).padEnd(13) + mean(all, i => Math.abs(t[i] - T[i].at)).toFixed(3).padEnd(12) + mean(all, i => (cdf(m[i] / 11) - (T[i].am > 0 ? 1 : 0)) ** 2).toFixed(4).padEnd(9) + (100 * mean(all, i => (m[i] > 0) === (T[i].am > 0) ? 1 : 0)).toFixed(1).padEnd(9) + '%' + (name === 'closing line' ? '' : rec(K, m, i => T[i].mm, i => T[i].am).padEnd(25) + rec(Kt, t, i => T[i].mt, i => T[i].at))); };
    for (const k in P) line(k, P[k].m, P[k].t);
    line('closing line', T.map(r => r.mm == null ? r.rm : r.mm), T.map(r => r.mt == null ? r.rt : r.mt));
    // can a learned model improve on the closing line itself? (predict the line's miss from the same features plus the sim-vs-line gap)
    const Ak = A.filter(r => r.mm != null && r.mt != null), Xk = Ak.map(r => r.x.concat([r.rm - r.mm, r.rt - r.mt])), f = gbm(Xk, Ak.map(r => r.am - r.mm), G), Tk = Kt;
    const adj = Tk.map(i => T[i].mm + f(T[i].x.concat([T[i].rm - T[i].mm, T[i].rt - T[i].mt])));
    console.log('line + learned correction: margin miss ' + (Tk.reduce((a, i, k) => a + Math.abs(adj[k] - T[i].am), 0) / Tk.length).toFixed(3) + ' vs the line alone ' + mean(Tk, i => Math.abs(T[i].mm - T[i].am)).toFixed(3) + ' on the same ' + Tk.length + ' games');
  }
})();
