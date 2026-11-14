// Walk-forward backtest for the college simulators: every game between two member teams in a past season is predicted from ratings and
// player availability built ONLY on earlier days (plus the season before as a starting point), then scored against the real result
// and against the closing betting line.
// Usage: node backtest-college.js [ncaaf|ncaab ...]   -> adds both leagues to backtest-results.js (shown in index.html)
//        node backtest-college.js --fast              -> no simulation: a bell-curve around the rating margin, for tuning hca / k / carry
//        (BT_HCA, BT_K, BT_CARRY, BT_SIMS, BT_YEAR override the settings; a BT_YEAR run prints but does not save)
// The first run downloads every game's box score and closing line for three seasons (about 3,000 football and 19,000 basketball games) into cache/.
'use strict';
const fs = require('fs'), path = require('path');
const Sim = require('./sim.js'), C = require('./college.js');

const YEAR0 = +(process.env.BT_YEAR || 2025), FAST = process.argv.includes('--fast');
const SET = { ncaaf: { minGp: 2, sims: 300, sd: 16 }, ncaab: { minGp: 3, sims: 300, sd: 11 } };
const cdf = z => 0.5 * (1 + Math.sign(z) * Math.sqrt(1 - Math.exp(-4 * (z / Math.SQRT2) ** 2 / Math.PI)));

// a season's games with adjusted scores, as { day: [rows] }, plus its per-game detail
async function season(L, year) {
  const raw = await C.seasonGames(L, year), D = await C.seasonDetail(L, year, m => console.log('  ' + m)), days = {};
  for (const d in raw) days[d] = raw[d].map(g => C.gameRow(L, g, D[g[5]]));
  return { days, D };
}

async function run(L, YEAR) {
  const cfg = Object.assign({}, C.CFG[L]), set = SET[L];
  if (process.env.BT_HCA) cfg.hca = +process.env.BT_HCA; if (process.env.BT_K) cfg.k = +process.env.BT_K; if (process.env.BT_CARRY) cfg.carry = +process.env.BT_CARRY;
  const sims = +(process.env.BT_SIMS || set.sims);
  const prev = await season(L, YEAR - 1), cur = await season(L, YEAR), mem = await C.members(L, YEAR);
  const M = new Set(Object.keys(mem)), base = { members: M, hca: cfg.hca, k: cfg.k, carry: cfg.carry, gap: cfg.gap, gapD: cfg.gapD };
  const prior = C.rate(C.flat(L, prev.days, M), Object.assign({}, base, { lg: 0 }));
  const days = Object.keys(cur.days).sort(), rng = Sim.makeRng(2026), rows = [], state = {};
  let homeW = 0, homeN = 0;
  for (const day of days) {
    const R = C.rate(C.flat(L, cur.days, M, day), Object.assign({}, base, { prior: prior.teams, lg: prior.lg }));
    Sim.setLeague(L, R.lg);
    const team = id => {
      const t = R.teams[id] || { o: (prior.teams[id] ? prior.teams[id].o : 0) * cfg.carry, d: (prior.teams[id] ? prior.teams[id].d : 0) * cfg.carry, n: 0 }, pl = C.players(L, state[id]);
      return Object.assign({ id, name: id, n: t.n }, L === 'ncaaf' ? { pf: R.lg + t.o, pa: R.lg + t.d } : { off: R.lg + t.o, def: R.lg + t.d },
        pl ? { roster: L === 'ncaab' ? { players: pl } : { qb: pl.qb, rb: pl.rb, rec: pl.rec, ol: [], defense: [] } } : {});
    };
    for (const g of cur.days[day]) {
      if (!M.has(g[0]) || !M.has(g[1])) continue;
      const H = team(g[0]), A = team(g[1]);
      if (H.n >= set.minGp && A.n >= set.minGp) {
        const k = L === 'ncaaf' ? ['pf', 'pa'] : ['off', 'def'], rm = (H[k[0]] - H[k[1]]) - (A[k[0]] - A[k[1]]) + (g[4] ? 0 : cfg.hca);
        let p, pm, pt;
        if (FAST) { p = cdf(rm / set.sd); pm = rm; pt = H[k[0]] + H[k[1]] + A[k[0]] + A[k[1]] - 2 * R.lg; }
        else {
          let hw = 0, sm = 0, st = 0;
          for (let i = 0; i < sims; i++) { const r = Sim.simGame(L, A, H, rng, { neutral: !!g[4] }); hw += r.winner; sm += r.score[1] - r.score[0]; st += r.score[0] + r.score[1]; }
          p = hw / sims; pm = sm / sims; pt = st / sims;
        }
        const o = cur.D[g[5]] && cur.D[g[5]].o;   // closing line: [home spread, total]
        rows.push({ p, y: g[2] > g[3] ? 1 : g[2] < g[3] ? 0 : 0.5, base: homeN ? homeW / homeN : 0.6, pm, am: g[2] - g[3], pt, at: g[2] + g[3], neutral: g[4],
          mk: o && o[0] != null ? { p: cdf(-o[0] / set.sd), margin: -o[0], total: o[1] } : null });
      }
      homeN++; homeW += g[2] > g[3] ? 1 : 0;
    }
    for (const g of cur.days[day]) C.track(L, state, g, cur.D[g[5]]);
  }
  // summary, in the same shape backtest.js writes for the pro leagues
  const n = rows.length, mean = f => rows.reduce((a, r) => a + f(r), 0) / n;
  const ll = (p, y) => { p = Math.min(0.999, Math.max(0.001, p)); return -(y * Math.log(p) + (1 - y) * Math.log(1 - p)); };
  const lo = p => Math.log(Math.min(0.999, Math.max(0.001, p)) / (1 - Math.min(0.999, Math.max(0.001, p)))), sg = z => 1 / (1 + Math.exp(-z));
  const cal = [];
  for (let b = 0; b < 1; b += 0.1) { const x = rows.filter(r => r.p >= b && r.p < b + 0.1 + (b > 0.85 ? 0.01 : 0)); if (x.length >= 5) cal.push({ lo: +b.toFixed(1), n: x.length, pred: +(x.reduce((a, r) => a + r.p, 0) / x.length).toFixed(3), act: +(x.reduce((a, r) => a + r.y, 0) / x.length).toFixed(3) }); }
  let bestA = 1, bestLL = Infinity;
  for (let a = 0.5; a <= 3.01; a += 0.05) { const v = mean(r => ll(sg(a * lo(r.p)), r.y)); if (v < bestLL) { bestLL = v; bestA = a; } }
  const dec = rows.filter(r => r.y !== 0.5), resid = rows.map(r => r.am - r.pm), mr = resid.reduce((a, x) => a + x, 0) / n;
  // against the closing line (the market's win chance is a bell curve around its spread, as on the page)
  let market = null; const K = rows.filter(r => r.mk);
  if (K.length > 30) {
    const mm = (f, X = K) => X.reduce((a, r) => a + f(r), 0) / X.length, Kd = K.filter(r => r.y !== 0.5), Kt = K.filter(r => r.mk.total != null);
    let bw = 0, bb = Infinity; for (let w = 0; w <= 1.0001; w += 0.05) { const v = mm(r => (w * sg(bestA * lo(r.p)) + (1 - w) * r.mk.p - r.y) ** 2); if (v < bb) { bb = v; bw = w; } }
    const rec = (X, edge, res) => { let w = 0, l = 0; for (const r of X) { const e = edge(r), a = res(r); if (Math.abs(e) < 3 || a === 0) continue; if (Math.sign(e) === Math.sign(a)) w++; else l++; } return { w, l }; };
    market = { n: K.length, brierSim: +mm(r => (sg(bestA * lo(r.p)) - r.y) ** 2).toFixed(4), brierMarket: +mm(r => (r.mk.p - r.y) ** 2).toFixed(4), brierBlend: +bb.toFixed(4), simWeight: +bw.toFixed(2),
      accSim: +(Kd.filter(r => (r.p > 0.5) === (r.y === 1)).length / Kd.length).toFixed(3), accMarket: +(Kd.filter(r => (r.mk.p > 0.5) === (r.y === 1)).length / Kd.length).toFixed(3),
      marginMAESim: +mm(r => Math.abs(r.pm - r.am)).toFixed(2), marginMAEMarket: +mm(r => Math.abs(r.mk.margin - r.am)).toFixed(2),
      totalMAESim: +mm(r => Math.abs(r.pt - r.at), Kt).toFixed(2), totalMAEMarket: +mm(r => Math.abs(r.mk.total - r.at), Kt).toFixed(2),
      // picking against the closing number whenever the sim disagrees with it by 3+ points (52.4% is break-even at standard prices)
      ats: rec(K, r => r.pm - r.mk.margin, r => r.am - r.mk.margin), ou: rec(Kt, r => r.pt - r.mk.total, r => r.at - r.mk.total) };
  }
  return {
    market, n, window: days[0].replace(/(....)(..)(..)/, '$1-$2-$3') + ' → ' + days[days.length - 1].replace(/(....)(..)(..)/, '$1-$2-$3'), minGp: set.minGp, sims: FAST ? 0 : sims,
    acc: +(dec.filter(r => (r.p > 0.5) === (r.y === 1)).length / dec.length).toFixed(3), homeRate: +mean(r => r.y).toFixed(3), accBase: +(dec.filter(r => r.y === 1).length / dec.length).toFixed(3),
    brier: +mean(r => (r.p - r.y) ** 2).toFixed(4), brierBase: +mean(r => (r.base - r.y) ** 2).toFixed(4),
    stretch: +bestA.toFixed(2), brierCal: +mean(r => (sg(bestA * lo(r.p)) - r.y) ** 2).toFixed(4), loglossCal: +bestLL.toFixed(4),
    logloss: +mean(r => ll(r.p, r.y)).toFixed(4), loglossBase: +mean(r => ll(r.base, r.y)).toFixed(4),
    marginMAE: +mean(r => Math.abs(r.pm - r.am)).toFixed(2), marginBias: +mean(r => r.pm - r.am).toFixed(2), marginSD: +Math.sqrt(resid.reduce((a, x) => a + (x - mr) ** 2, 0) / n).toFixed(2),
    totalMAE: +mean(r => Math.abs(r.pt - r.at)).toFixed(2), totalBias: +mean(r => r.pt - r.at).toFixed(2), totalSD: +Math.sqrt(mean(r => (r.pt - r.at) ** 2)).toFixed(2),
    predTotal: +mean(r => r.pt).toFixed(1), actualTotal: +mean(r => r.at).toFixed(1), cal,
  };
}

(async () => {
  const want = process.argv.slice(2).filter(a => C.CFG[a]), leagues = want.length ? want : Object.keys(C.CFG);
  const file = path.join(__dirname, 'backtest-results.js');
  let out = { leagues: {} };
  try { out = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^[^{]*/, '').replace(/;\s*$/, '')); } catch (e) { /* first run */ }
  for (const L of leagues) {
    const t0 = Date.now(), r = await run(L, YEAR0), m = r.market;
    console.log(L.toUpperCase() + ' ' + YEAR0 + (FAST ? ' (fast)' : '') + ': ' + r.n + ' games in ' + ((Date.now() - t0) / 1000).toFixed(0) + 's · accuracy ' + r.acc + ' (always-home ' + r.accBase + ') · Brier ' + r.brier + ' (baseline ' + r.brierBase + ', calibrated ' + r.brierCal + ' at stretch ' + r.stretch + ')' +
      ' · margin MAE ' + r.marginMAE + ' bias ' + r.marginBias + ' sd ' + r.marginSD + ' · total MAE ' + r.totalMAE + ' bias ' + r.totalBias + ' sd ' + r.totalSD);
    if (m) console.log('  vs closing line (' + m.n + ' games): Brier sim ' + m.brierSim + ' / market ' + m.brierMarket + ' / blend ' + m.brierBlend + ' (sim weight ' + m.simWeight + ') · winners sim ' + m.accSim + ' / market ' + m.accMarket +
      ' · margin MAE sim ' + m.marginMAESim + ' vs market ' + m.marginMAEMarket + ' · total MAE sim ' + m.totalMAESim + ' vs market ' + m.totalMAEMarket + ' · vs the spread (3+ pt disagreements) ' + m.ats.w + '-' + m.ats.l + ' · totals ' + m.ou.w + '-' + m.ou.l);
    if (!FAST && !process.env.BT_YEAR) {   // the same settings on the season before, as a check on games they were not picked on
      const o = await run(L, YEAR0 - 1);
      r.oos = { n: o.n, window: o.window, acc: o.acc, accBase: o.accBase, brier: o.brier, brierBase: o.brierBase, marginMAE: o.marginMAE, totalBias: o.totalBias, market: o.market };
      console.log('  season before (' + o.n + ' games): accuracy ' + o.acc + ' · Brier ' + o.brier + ' · margin MAE ' + o.marginMAE + (o.market ? ' vs market ' + o.market.marginMAEMarket : '') + ' · total bias ' + o.totalBias);
      out.leagues[L] = r;
    }
  }
  if (!FAST && !process.env.BT_YEAR) { out.generated = out.generated || new Date().toISOString(); fs.writeFileSync(file, 'window.BACKTEST = ' + JSON.stringify(out) + ';\n'); console.log('wrote ' + file); }
})();
