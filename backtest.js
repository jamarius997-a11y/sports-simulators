// Walk-forward backtest: for every completed game of a past season, rate teams using ONLY earlier games,
// simulate the matchup, and score the predicted win probability against the real result.
// Usage: node backtest.js [nba|nfl|nhl ...]   -> writes backtest-results.js (loaded by index.html)
'use strict';
const fs = require('fs'), path = require('path');
const Sim = require('./sim.js');

const SEASONS = {
  nba: { sport: 'basketball', start: '2025-10-21', end: '2026-04-12', k: 10, minGp: 12, sims: 400, lg: 114, w: 8, priorYear: 2025, rest: true },
  nhl: { sport: 'hockey', start: '2025-10-07', end: '2026-04-16', k: 15, minGp: 12, sims: 400, lg: null, w: 5, priorYear: 2024, shrink: 50, rest: true },
  nfl: { sport: 'football', start: '2025-09-04', end: '2026-01-05', k: 5, minGp: 5, sims: 300, lg: null, w: 3, priorYear: 2024 },
};
// BT_YEAR=2024 re-runs the identical settings on the 2024-25 season (out-of-sample check; writes cache/oos_results.json, not the page)
const OOS = process.env.BT_YEAR === '2024';
if (OOS) {
  Object.assign(SEASONS.nba, { start: '2024-10-22', end: '2025-04-13', priorYear: 2024 });
  Object.assign(SEASONS.nhl, { start: '2024-10-04', end: '2025-04-17', priorYear: 2023 });
  Object.assign(SEASONS.nfl, { start: '2024-09-05', end: '2025-01-05', priorYear: 2023 });
}
const CACHE = path.join(__dirname, OOS ? 'backtest-cache-2024.json' : 'backtest-cache.json');
const cache = fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE, 'utf8')) : {};

async function get(url) {
  for (let i = 0; i < 3; i++) {
    try { const r = await fetch(url, { signal: AbortSignal.timeout(20000) }); if (r.ok) return await r.json(); } catch (e) { /* retry */ }
    await new Promise(r => setTimeout(r, 400 * (i + 1)));
  }
  return null;
}
async function pool(items, n, fn) {
  const out = new Array(items.length); let k = 0;
  await Promise.all(Array.from({ length: n }, async () => { for (;;) { const i = k++; if (i >= items.length) return; out[i] = await fn(items[i]); } }));
  return out;
}
const V2 = 'https://site.api.espn.com/apis/v2/sports/';
function flat(node, acc = []) { if (node.standings && node.standings.entries) acc.push(...node.standings.entries); (node.children || []).forEach(c => flat(c, acc)); return acc; }
const MP_CODE = { NJ: 'NJD', SJ: 'SJS', TB: 'TBL', LA: 'LAK', UTAH: 'UTA' };

async function loadPrior(L) {
  const c = SEASONS[L], key = 'prior_' + L;
  if (cache[key]) return cache[key];
  const teams = {};
  if (L === 'nhl') {
    // MoneyPuck previous season: 35% goals, 65% expected goals (xG scaled to the league's goal total)
    const r = await fetch('https://moneypuck.com/moneypuck/playerData/seasonSummary/' + c.priorYear + '/regular/teams.csv', { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const lines = (await r.text()).trim().split(String.fromCharCode(10)).map(x => x.replace(String.fromCharCode(13), '')), h = lines[0].split(',');
    const rows = lines.slice(1).map(l => { const v = l.split(','), o = {}; h.forEach((k, i) => { if (!(k in o)) o[k] = v[i]; }); return o; }).filter(o => o.situation === 'all');
    const sum = k => rows.reduce((a, o) => a + (+o[k] || 0), 0), kf = sum('goalsFor') / sum('xGoalsFor'), ka = sum('goalsAgainst') / sum('xGoalsAgainst');
    const inv = {}; Object.keys(MP_CODE).forEach(k => { inv[MP_CODE[k]] = k; });
    for (const o of rows) { const gp = +o.games_played; teams[inv[o.team] || o.team] = { off: 0.35 * (+o.goalsFor) / gp + 0.65 * kf * (+o.xGoalsFor) / gp, def: 0.35 * (+o.goalsAgainst) / gp + 0.65 * ka * (+o.xGoalsAgainst) / gp }; }
  } else {
    const j = await get(V2 + c.sport + '/' + L + '/standings?season=' + c.priorYear);
    for (const e of flat(j || {})) {
      const m = {}; e.stats.forEach(x => { m[x.name] = x.value; });
      const gp = m.gamesPlayed != null ? m.gamesPlayed : (m.wins || 0) + (m.losses || 0) + (m.ties || 0);
      const pf = m.avgPointsFor != null ? m.avgPointsFor : m.pointsFor / gp, pa = m.avgPointsAgainst != null ? m.avgPointsAgainst : m.pointsAgainst / gp;
      if (gp && isFinite(pf)) teams[e.team.abbreviation] = { off: pf, def: pa };
    }
  }
  const ids = Object.keys(teams), lg = ids.reduce((a, i) => a + teams[i].off + teams[i].def, 0) / (2 * ids.length);
  return (cache[key] = { teams, lg });
}

// nflverse closing lines (free): spread_line is the expected home margin
async function loadNflMarket() {
  const file = path.join(__dirname, 'cache', 'nfl_games.csv');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file)) fs.writeFileSync(file, await (await fetch('https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv')).text());
  const lines = fs.readFileSync(file, 'utf8').trim().split(String.fromCharCode(10)).map(x => x.replace(String.fromCharCode(13), '')), h = lines[0].split(',');
  const I = n => h.indexOf(n), out = {};
  for (const l of lines.slice(1)) {
    const v = l.split(','); if (v[I('season')] !== (OOS ? '2024' : '2025') || v[I('game_type')] !== 'REG' || !v[I('spread_line')]) continue;
    out[v[I('home_team')] + '|' + v[I('away_team')]] = { spread: +v[I('spread_line')], total: +v[I('total_line')], hml: +v[I('home_moneyline')], aml: +v[I('away_moneyline')] };
  }
  return out;
}
const NFLV = { WSH: 'WAS', LAR: 'LA' }, imp = ml => ml < 0 ? -ml / (-ml + 100) : 100 / (ml + 100);

// nflverse weekly team stats -> offensive EPA and plays per team-week, plus each game's week (from nfl_games.csv) so results can be matched.
// Same blend as update-data.js: team rating = 75% points, 25% EPA per play converted at 52 points/game per 1.0 EPA/play. BT_EPA=0 turns it off.
// Full-sim Brier, 2025 / 2024: points only .2161 / .1944; 25% EPA .2166 / .1931 (accuracy .663 / .738 vs .635 / .738); 50% EPA .2191 / .1953.
// The gain is about the size of sim noise: EPA helps a little at most, so it gets a small weight.
const NFL_EPA_K = +(process.env.BT_EPA_K || 52), NFL_EPA_W = process.env.BT_EPA != null ? +process.env.BT_EPA : 0.25;   // BT_EPA = weight (0 = off), BT_EPA_K = points per 1.0 EPA/play   // BT_EPA = weight (0 = off), BT_EPA_K = points per 1.0 EPA/play
async function teamWeek(year) {
  const file = path.join(__dirname, 'cache', 'nfl_team_week_' + year + '.csv');
  if (!fs.existsSync(file)) { const r = await fetch('https://github.com/nflverse/nflverse-data/releases/download/stats_team/stats_team_week_' + year + '.csv'); if (!r.ok) return null; fs.writeFileSync(file, await r.text()); }
  const wk = {};
  for (const row of require('./csv.js').read(file)) if (row.season_type === 'REG') wk[row.team + '|' + row.week] = { epa: (+row.passing_epa || 0) + (+row.rushing_epa || 0), plays: (+row.attempts || 0) + (+row.sacks_suffered || 0) + (+row.carries || 0) };
  return wk;
}
async function loadNflEpa(year) {
  if (!NFL_EPA_W) return null;
  const [wk, prev] = await Promise.all([teamWeek(year), teamWeek(year - 1)]);
  if (!wk) return null;
  await loadNflMarket();   // makes sure cache/nfl_games.csv exists
  const week = {}, weather = {};   // weather: nflverse's recorded kickoff wind/temperature, same shape as the live Open-Meteo forecast
  for (const g of require('./csv.js').read(path.join(__dirname, 'cache', 'nfl_games.csv'))) if (g.season === String(year) && g.game_type === 'REG') {
    week[g.home_team + '|' + g.away_team] = g.week;
    weather[g.home_team + '|' + g.away_team] = g.roof === 'dome' || g.roof === 'closed' ? { indoor: true } : g.wind !== '' ? { wind: +g.wind, temp: g.temp === '' ? null : +g.temp } : null;
  }
  // last season's per-play offense/defense relative to that league's mean (defense = what opponents' offenses did, via each team-week's opponent)
  const prior = {};
  if (prev) {
    const opp = {};
    for (const g of require('./csv.js').read(path.join(__dirname, 'cache', 'nfl_games.csv'))) if (g.season === String(year - 1) && g.game_type === 'REG') { opp[g.home_team + '|' + g.week] = g.away_team; opp[g.away_team + '|' + g.week] = g.home_team; }
    let se = 0, sp = 0;
    for (const k in prev) {
      const [t, w] = k.split('|'), th = prev[opp[k] + '|' + w]; if (!th) continue;
      const p = prior[t] = prior[t] || { oe: 0, op: 0, de: 0, dp: 0 }; p.oe += prev[k].epa; p.op += prev[k].plays; p.de += th.epa; p.dp += th.plays; se += prev[k].epa; sp += prev[k].plays;
    }
    const m = sp ? se / sp : 0;
    for (const t in prior) { const p = prior[t]; prior[t] = { off: p.oe / p.op - m, def: p.de / p.dp - m }; }
  }
  return { wk, week, weather, prior };
}

function days(a, b) { const out = []; for (let d = new Date(a + 'T12:00:00Z'); d <= new Date(b + 'T12:00:00Z'); d = new Date(d.getTime() + 86400000)) out.push(d.toISOString().slice(0, 10).replace(/-/g, '')); return out; }

async function loadGames(L) {
  if (cache[L]) return cache[L];
  const c = SEASONS[L], ds = days(c.start, c.end);
  console.log(L.toUpperCase() + ': fetching ' + ds.length + ' days of results…');
  const per = await pool(ds, 8, async d => {
    const j = await get('https://site.api.espn.com/apis/site/v2/sports/' + c.sport + '/' + L + '/scoreboard?dates=' + d);
    const out = [];
    for (const ev of (j && j.events) || []) {
      if (!ev.status.type.completed || (ev.season && ev.season.type !== 2)) continue;
      const comp = ev.competitions[0], h = comp.competitors.find(x => x.homeAway === 'home'), a = comp.competitors.find(x => x.homeAway === 'away');
      if (comp.neutralSite) continue;
      out.push({ d: ev.date, h: h.team.abbreviation, a: a.team.abbreviation, hs: +h.score, as: +a.score });
    }
    return out;
  });
  const games = per.flat().sort((x, y) => x.d.localeCompare(y.d));
  cache[L] = games; fs.writeFileSync(CACHE, JSON.stringify(cache));
  return games;
}

function run(L, games, prior, market, useRest, epa) {
  const c = Object.assign({}, SEASONS[L]), rng = Sim.makeRng(2026); if (process.env.BT_K) c.k = +process.env.BT_K; if (process.env.BT_W) c.w = +process.env.BT_W; if (process.env.BT_MINGP) c.minGp = +process.env.BT_MINGP; if (process.env.BT_SIMS) c.sims = +process.env.BT_SIMS;
  const T = {}, tm = id => T[id] || (T[id] = { id, name: id, gp: 0, pf: 0, pa: 0, oe: 0, op: 0, de: 0, dp: 0, eg: 0 });
  let lgE = 0, lgP = 0;   // league offensive EPA and plays so far
  const blendE = (pts, e) => e == null ? pts : (1 - NFL_EPA_W) * pts + NFL_EPA_W * e;
  // EPA-implied points for/against, shrunk toward last season's EPA (prior run) or nothing (no-prior run) with the same weights as points
  const epaRate = (t, k, lg) => {
    if (!epa || !lgP) return null;
    const m = lgE / lgP, cur = t.eg ? (k === 'pf' ? t.oe / t.op : t.de / t.dp) - m : 0, pr = prior && epa.prior[NFLV[t.id] || t.id];
    const v = pr ? (cur * t.eg + c.w * (k === 'pf' ? pr.off : pr.def)) / (t.eg + c.w) : cur;
    return lg + NFL_EPA_K * v;
  };
  let lgG = 0, lgPts = 0, homeW = 0, homeN = 0;
  const last = {};   // team -> day index of previous game (US Eastern-ish)
  const dayOf = d => Math.floor((new Date(d).getTime() - 5 * 3600e3) / 86400000);
  const rows = [];
  for (const g of games) {
    const H = tm(g.h), A = tm(g.a);
    const dd = dayOf(g.d), hr = last[g.h] == null ? null : dd - last[g.h] - 1, ar = last[g.a] == null ? null : dd - last[g.a] - 1;
    last[g.h] = dd; last[g.a] = dd;
    if (H.gp >= c.minGp && A.gp >= c.minGp) {
      const lg = lgPts / (2 * lgG), rate = (t, k) => { const pr = prior && prior.teams[t.id]; let v; if (pr) v = (t[k] + c.w * pr[k === 'pf' ? 'off' : 'def'] * (lg / prior.lg)) / (t.gp + c.w); else return (t[k] + c.k * lg) / (t.gp + c.k); if (c.shrink && prior) { const n = t.gp + c.w, f = n / (n + c.shrink); v = lg + (v - lg) * f; } return v; };
      Sim.setLeague(L, lg);
      const scale = 1;
      const mk = t => L === 'nba' ? { id: t.id, name: t.id, off: rate(t, 'pf') * scale, def: rate(t, 'pa') * scale }
        : L === 'nhl' ? { id: t.id, name: t.id, gf: rate(t, 'pf'), ga: rate(t, 'pa') }
        : { id: t.id, name: t.id, pf: blendE(rate(t, 'pf'), epaRate(t, 'pf', lg)), pa: blendE(rate(t, 'pa'), epaRate(t, 'pa', lg)) };
      const home = mk(H), away = mk(A);
      let hw = 0, sm = 0, st = 0;
      const wx = epa && process.env.BT_WX !== '0' ? epa.weather[(NFLV[g.h] || g.h) + '|' + (NFLV[g.a] || g.a)] : undefined;   // BT_WX=0 turns weather off
      const opts = c.rest && useRest ? { rest: { away: ar, home: hr } } : wx ? {} : undefined; if (wx) opts.weather = wx;
      for (let i = 0; i < c.sims; i++) { const r = Sim.simGame(L, away, home, rng, opts); hw += r.tie ? 0.5 : r.winner; sm += r.score[1] - r.score[0]; st += r.score[0] + r.score[1]; }
      const actual = g.hs === g.as ? 0.5 : g.hs > g.as ? 1 : 0;
      let mkt = null;
      if (market) {
        const m = market[(NFLV[g.h] || g.h) + '|' + (NFLV[g.a] || g.a)];
        if (m && m.hml && m.aml) { const ph = imp(m.hml), pa = imp(m.aml); mkt = { p: ph / (ph + pa), margin: m.spread, total: m.total }; }
      }
      rows.push({ h: g.h, a: g.a, d: g.d, hr, ar, mk: mkt, p: hw / c.sims, y: actual, base: homeN ? homeW / homeN : 0.55, pm: sm / c.sims, am: g.hs - g.as, pt: st / c.sims, at: g.hs + g.as });
    }
    H.gp++; A.gp++; H.pf += g.hs; H.pa += g.as; A.pf += g.as; A.pa += g.hs;
    if (epa) {   // add this game's EPA only after it has been predicted (walk-forward)
      const h = NFLV[g.h] || g.h, a = NFLV[g.a] || g.a, w = epa.week[h + '|' + a], eh = w && epa.wk[h + '|' + w], ea = w && epa.wk[a + '|' + w];
      if (eh && ea && eh.plays && ea.plays) {
        H.oe += eh.epa; H.op += eh.plays; H.de += ea.epa; H.dp += ea.plays; H.eg++;
        A.oe += ea.epa; A.op += ea.plays; A.de += eh.epa; A.dp += eh.plays; A.eg++;
        lgE += eh.epa + ea.epa; lgP += eh.plays + ea.plays;
      }
    }
    lgG++; lgPts += g.hs + g.as;
    homeN++; homeW += g.hs === g.as ? 0.5 : g.hs > g.as ? 1 : 0;
  }
  if (process.env.BT_DUMP && (process.env.BT_DUMP === 'noprior' ? !prior : !!prior)) fs.writeFileSync(path.join(__dirname, 'cache', 'rows_' + L + (OOS ? '_2024' : '') + '.json'), JSON.stringify(rows));
  const n = rows.length, mean = f => rows.reduce((a, r) => a + f(r), 0) / n;
  const ll = (p, y) => { p = Math.min(0.999, Math.max(0.001, p)); return -(y * Math.log(p) + (1 - y) * Math.log(1 - p)); };
  const cal = [];
  for (let lo = 0; lo < 1; lo += 0.1) {
    const b = rows.filter(r => r.p >= lo && r.p < lo + 0.1 + (lo > 0.85 ? 0.01 : 0));
    if (b.length >= 5) cal.push({ lo: +lo.toFixed(1), n: b.length, pred: +(b.reduce((a, r) => a + r.p, 0) / b.length).toFixed(3), act: +(b.reduce((a, r) => a + r.y, 0) / b.length).toFixed(3) });
  }
  // one-parameter calibration: stretch the sim's log-odds by factor a (fit by log loss; in-sample)
  const lg = p => Math.log(Math.min(0.999, Math.max(0.001, p)) / (1 - Math.min(0.999, Math.max(0.001, p))));
  const sg = z => 1 / (1 + Math.exp(-z));
  let bestA = 1, bestLL = Infinity;
  for (let a = 0.6; a <= 3.01; a += 0.05) { const v = mean(r => ll(sg(a * lg(r.p)), r.y)); if (v < bestLL) { bestLL = v; bestA = a; } }
  const dec = rows.filter(r => r.y !== 0.5);
  let marketStats = null;
  const M = rows.filter(r => r.mk);
  if (M.length > 30) {
    const mm = f => M.reduce((a, r) => a + f(r), 0) / M.length;
    let bw = 0, bb = Infinity;
    for (let w = 0; w <= 1.0001; w += 0.05) { const v = mm(r => (w * r.p + (1 - w) * r.mk.p - r.y) ** 2); if (v < bb) { bb = v; bw = w; } }
    marketStats = { n: M.length, brierSim: +mm(r => (r.p - r.y) ** 2).toFixed(4), brierMarket: +mm(r => (r.mk.p - r.y) ** 2).toFixed(4), brierBlend: +bb.toFixed(4), simWeight: +bw.toFixed(2),
      accSim: +(M.filter(r => r.y !== 0.5 && (r.p > 0.5) === (r.y === 1)).length / M.filter(r => r.y !== 0.5).length).toFixed(3), accMarket: +(M.filter(r => r.y !== 0.5 && (r.mk.p > 0.5) === (r.y === 1)).length / M.filter(r => r.y !== 0.5).length).toFixed(3),
      marginMAESim: +mm(r => Math.abs(r.pm - r.am)).toFixed(2), marginMAEMarket: +mm(r => Math.abs(r.mk.margin - r.am)).toFixed(2),
      totalMAESim: +mm(r => Math.abs(r.pt - r.at)).toFixed(2), totalMAEMarket: +mm(r => Math.abs(r.mk.total - r.at)).toFixed(2) };
  }
  return {
    market: marketStats,
    n, window: games[0].d.slice(0, 10) + ' → ' + games[games.length - 1].d.slice(0, 10), minGp: c.minGp, sims: c.sims,
    acc: +(dec.filter(r => (r.p > 0.5) === (r.y === 1)).length / dec.length).toFixed(3),
    homeRate: +(mean(r => r.y)).toFixed(3),
    accBase: +(dec.filter(r => r.y === 1).length / dec.length).toFixed(3),
    brier: +mean(r => (r.p - r.y) ** 2).toFixed(4), brierBase: +mean(r => (r.base - r.y) ** 2).toFixed(4),
    stretch: +bestA.toFixed(2), brierCal: +mean(r => (sg(bestA * lg(r.p)) - r.y) ** 2).toFixed(4), loglossCal: +bestLL.toFixed(4),
    logloss: +mean(r => ll(r.p, r.y)).toFixed(4), loglossBase: +mean(r => ll(r.base, r.y)).toFixed(4),
    marginMAE: +mean(r => Math.abs(r.pm - r.am)).toFixed(2), marginBias: +mean(r => r.pm - r.am).toFixed(2),
    totalMAE: +mean(r => Math.abs(r.pt - r.at)).toFixed(2), totalBias: +mean(r => r.pt - r.at).toFixed(2),
    predTotal: +mean(r => r.pt).toFixed(1), actualTotal: +mean(r => r.at).toFixed(1), cal,
  };
}

// copy the out-of-sample (2024-25) summary into the page's results file so the page can show it
function mergeOos() {
  const oosFile = path.join(__dirname, 'cache', 'oos_results.js'), main = path.join(__dirname, 'backtest-results.js');
  if (!fs.existsSync(oosFile) || !fs.existsSync(main)) return;
  const rd = f => JSON.parse(fs.readFileSync(f, 'utf8').replace(/^[^{]*/, '').replace(/;\s*$/, ''));
  const o = rd(oosFile), m = rd(main);
  for (const L of Object.keys(o.leagues)) { const r = o.leagues[L]; if (m.leagues[L]) m.leagues[L].oos = { n: r.n, window: r.window, acc: r.acc, accBase: r.accBase, brier: r.brier, brierBase: r.brierBase, totalBias: r.totalBias, market: r.market }; }
  fs.writeFileSync(main, 'window.BACKTEST = ' + JSON.stringify(m) + ';\n');
}

(async () => {
  const want = process.argv.slice(2).filter(a => SEASONS[a]), leagues = want.length ? want : Object.keys(SEASONS);
  const file = OOS ? path.join(__dirname, 'cache', 'oos_results.js') : path.join(__dirname, 'backtest-results.js');
  let out = { leagues: {} }, prev = {};
  try { prev = JSON.parse(fs.readFileSync(path.join(__dirname, 'backtest-results.js'), 'utf8').replace(/^[^{]*/, '').replace(/;\s*$/, '')).leagues || {}; } catch (e) { /* none */ }
  try { out = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^[^{]*/, '').replace(/;\s*$/, '')); } catch (e) { /* first run */ }
  for (const L of leagues) {
    const games = await loadGames(L), t0 = Date.now();
    console.log(L.toUpperCase() + ': ' + games.length + ' completed games; simulating…');
    const prior = await loadPrior(L);
    const market = L === 'nfl' ? await loadNflMarket() : null;
    const epa = L === 'nfl' ? await loadNflEpa(SEASONS.nfl.priorYear + 1) : null;
    if (L === 'nfl') console.log('  EPA blend: ' + (epa ? (NFL_EPA_W * 100) + '% (nflverse team-week)' : 'off'));
    const base = run(L, games, null, null, undefined, epa);
    const noRest = SEASONS[L].rest && !OOS ? run(L, games, prior, market, false, epa) : null;
    out.leagues[L] = run(L, games, prior, market, true, epa);
    if (epa) out.leagues[L].epa = NFL_EPA_W;
    if (!OOS && prev[L] && prev[L].oos) out.leagues[L].oos = prev[L].oos;
    if (noRest) out.leagues[L].noRest = { acc: noRest.acc, brier: noRest.brier, logloss: noRest.logloss };
    out.leagues[L].noPrior = { acc: base.acc, brier: base.brier, logloss: base.logloss };
    const r = out.leagues[L];
    if (r.market) console.log('  vs closing line (' + r.market.n + ' games): Brier sim ' + r.market.brierSim + ' / market ' + r.market.brierMarket + ' / blend ' + r.market.brierBlend + ' (sim weight ' + r.market.simWeight + ') · margin MAE sim ' + r.market.marginMAESim + ' vs market ' + r.market.marginMAEMarket);
    console.log('  without last-season prior: accuracy ' + base.acc + ', Brier ' + base.brier);
    console.log('  ' + r.n + ' games scored in ' + ((Date.now() - t0) / 1000).toFixed(0) + 's · accuracy ' + r.acc + ' (always-home ' + r.accBase + ') · Brier ' + r.brier + ' (baseline ' + r.brierBase + ') · total bias ' + r.totalBias);
  }
  out.generated = new Date().toISOString();
  fs.writeFileSync(file, 'window.BACKTEST = ' + JSON.stringify(out) + ';\n');
  if (!OOS) mergeOos();   // pick up a fresher out-of-sample run (BT_YEAR=2024) if one was made
  console.log('wrote ' + file);
})();
