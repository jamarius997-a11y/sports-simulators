// Pulls live team ratings, rosters, injuries and player stats from ESPN's public JSON API
// and writes data.js (loaded by index.html). Usage: node update-data.js [nba|nfl|nhl|ncaaf|ncaab ...]
'use strict';
const { read: readCsv } = require('./csv.js');
const fs = require('fs'), path = require('path');

const LEAGUES = {
  nba: { sport: 'basketball', prior: 8, lg: 114, curMin: 12 },
  nfl: { sport: 'football', prior: 3, lg: 22.5, curMin: 6 },
  nhl: { sport: 'hockey', prior: 5, lg: 3.05, curMin: 12, shrink: 50 },
  // college: ESPN's league name differs from ours, and its scoreboard only lists ranked teams unless a group is named (80 = FBS, 50 = Division I)
  ncaaf: { sport: 'football', key: 'college-football', groups: 80, college: true },
  ncaab: { sport: 'basketball', key: 'mens-college-basketball', groups: 50, college: true },
};
const lkey = L => LEAGUES[L].key || L, boardUrl = (L, ymd) => SITE + LEAGUES[L].sport + '/' + lkey(L) + '/scoreboard?dates=' + ymd + (LEAGUES[L].groups ? '&groups=' + LEAGUES[L].groups + '&limit=500' : '');
const META = {};
const SITE = 'https://site.api.espn.com/apis/site/v2/sports/', V2 = 'https://site.api.espn.com/apis/v2/sports/', CORE = 'https://sports.core.api.espn.com/v2/sports/';

async function get(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
      if (r.status === 404) return null;
      if (r.ok) return await r.json();
    } catch (e) { /* retry */ }
    await new Promise(r => setTimeout(r, 400 * (i + 1)));
  }
  return null;
}
async function pool(items, n, fn) {
  const out = new Array(items.length); let k = 0;
  await Promise.all(Array.from({ length: n }, async () => { for (;;) { const i = k++; if (i >= items.length) return; out[i] = await fn(items[i], i); } }));
  return out;
}

function flattenEntries(node, acc = []) {
  if (node.standings && node.standings.entries) acc.push(...node.standings.entries);
  (node.children || []).forEach(c => flattenEntries(c, acc));
  return acc;
}
function statMap(stats) { const m = {}; for (const s of stats) m[s.name] = s.value; return m; }

async function standings(L, key, year) {
  const j = await get(V2 + LEAGUES[L].sport + '/' + key + '/standings?season=' + year);
  const out = {};
  if (!j) return out;
  for (const e of flattenEntries(j)) {
    const m = statMap(e.stats);
    let gp = (m.gamesPlayed != null ? m.gamesPlayed : (m.wins || 0) + (m.losses || 0) + (m.ties || 0) + (m.otLosses || m.overtimeLosses || 0));
    if (L === 'nhl') gp = m.gamesPlayed || ((m.wins || 0) + (m.losses || 0) + (m.otLosses || 0));
    let pf = m.avgPointsFor, pa = m.avgPointsAgainst;
    if (pf == null && gp) { pf = (m.pointsFor != null ? m.pointsFor : m.goalsFor) / gp; pa = (m.pointsAgainst != null ? m.pointsAgainst : m.goalsAgainst) / gp; }
    if (gp && pf != null && isFinite(pf)) out[e.team.id] = { gp, pf, pa };
  }
  return out;
}

// stats totals for one athlete-season, flattened across categories
async function playerTotals(L, key, year, id) {
  const j = await get(CORE + LEAGUES[L].sport + '/leagues/' + key + '/seasons/' + year + '/types/2/athletes/' + id + '/statistics/0');
  if (!j || !j.splits) return null;
  const m = {};
  for (const c of j.splits.categories) for (const s of c.stats) if (!(s.name in m) || !m[s.name]) m[s.name] = s.value;
  return m;
}
async function combined(L, key, year, id, curMin) {
  const cur = await playerTotals(L, key, year, id);
  const gpOf = m => m ? (m.gamesPlayed || m.games || 0) : 0;
  let prior = null;
  if (gpOf(cur) < curMin) prior = await playerTotals(L, key, year - 1, id);
  if (!cur && !prior) return null;
  const out = {};
  for (const m of [[cur, 1], [prior, 0.6]]) if (m[0]) for (const k in m[0]) if (typeof m[0][k] === 'number') out[k] = (out[k] || 0) + m[0][k] * m[1];
  out.__gp = gpOf(cur) + 0.6 * gpOf(prior); out.__gpc = gpOf(cur);
  return out;
}

// ---------- MoneyPuck (NHL expected goals + goalie goals-saved-above-expected) ----------
const MP_CODE = { NJ: 'NJD', SJ: 'SJS', TB: 'TBL', LA: 'LAK', UTAH: 'UTA' };
const normName = x => String(x).toLowerCase().replace(/[^a-z]/g, '');
async function mpCsv(year, kind) {
  try {
    const r = await fetch('https://moneypuck.com/moneypuck/playerData/seasonSummary/' + year + '/regular/' + kind + '.csv', { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(30000) });
    if (!r.ok) return null;
    const lines = (await r.text()).trim().split(String.fromCharCode(10)).map(x => x.replace(String.fromCharCode(13), '')), h = lines[0].split(',');
    return lines.slice(1).map(l => { const c = l.split(','), o = {}; h.forEach((k, i) => { if (!(k in o)) o[k] = c[i]; }); return o; }).filter(o => o.situation === 'all');
  } catch (e) { return null; }
}
async function mpTeams(year) {
  const rows = await mpCsv(year, 'teams'); if (!rows) return {};
  const sum = k => rows.reduce((a, r) => a + (+r[k] || 0), 0), kf = sum('goalsFor') / (sum('xGoalsFor') || 1), ka = sum('goalsAgainst') / (sum('xGoalsAgainst') || 1);
  const out = {};
  for (const r of rows) { const gp = +r.games_played; if (gp > 0) out[r.team] = { gp, off: 0.35 * (+r.goalsFor) / gp + 0.65 * kf * (+r.xGoalsFor) / gp, def: 0.35 * (+r.goalsAgainst) / gp + 0.65 * ka * (+r.xGoalsAgainst) / gp }; }
  return out;
}
async function mpGoalies(year) {
  const rows = (await mpCsv(year, 'goalies')) || [], out = {};
  for (const r of rows) out[normName(r.name)] = { g: +r.goals || 0, x: +r.xGoals || 0 };
  return out;
}

// NFL defender production per game from nflverse weekly player stats (free). Weights are rough: sacks and interceptions count most.
async function nflDefense(year) {
  const out = {};
  try {
    const r = await fetch('https://github.com/nflverse/nflverse-data/releases/download/stats_player/stats_player_week_' + year + '.csv', { signal: AbortSignal.timeout(60000) });
    if (!r.ok) return out;
    const file = path.join(__dirname, 'cache', 'nfl_player_week_' + year + '.csv');
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, await r.text());
    const teamWeeks = {};
    for (const row of readCsv(file)) {
      if (row.season_type !== 'REG') continue;
      (teamWeeks[row.team] = teamWeeks[row.team] || new Set()).add(row.week);
      if (!['DL', 'LB', 'DB'].includes(row.position_group)) continue;
      const p = 4 * (+row.def_sacks || 0) + 1.5 * (+row.def_qb_hits || 0) + (+row.def_tackles_for_loss || 0) + 2 * (+row.def_pass_defended || 0) + 4 * (+row.def_interceptions || 0);
      const o = out[normName(row.player_display_name)] = out[normName(row.player_display_name)] || { prod: 0, weeks: 0 };
      o.prod += p; o.weeks++; o.team = row.team;
    }
    for (const k in out) out[k].teamWeeks = teamWeeks[out[k].team] ? teamWeeks[out[k].team].size : 0;
  } catch (e) { /* optional */ }
  return out;
}
// NFL team efficiency from nflverse weekly team stats: offensive EPA per play, and defensive EPA per play (what opponents' offenses did against them).
// Weighted 25% EPA / 75% points: in the full-sim backtest (backtest.js, 2024 and 2025) 50% was worse than points alone and 25% was slightly better.
const NFLV_CODE = { WSH: 'WAS', LAR: 'LA' };
async function nflEpa(year) {
  const out = {};
  try {
    const r = await fetch('https://github.com/nflverse/nflverse-data/releases/download/stats_team/stats_team_week_' + year + '.csv', { signal: AbortSignal.timeout(60000) });
    if (!r.ok) return out;
    const file = path.join(__dirname, 'cache', 'nfl_team_week_' + year + '.csv');
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, await r.text());
    const wk = {};
    for (const row of readCsv(file)) if (row.season_type === 'REG') wk[row.team + '|' + row.week] = { opp: row.opponent_team, epa: (+row.passing_epa || 0) + (+row.rushing_epa || 0), plays: (+row.attempts || 0) + (+row.sacks_suffered || 0) + (+row.carries || 0) };
    for (const k in wk) {
      const [team, week] = k.split('|'), me = wk[k], th = wk[me.opp + '|' + week]; if (!th || !me.plays || !th.plays) continue;
      const o = out[team] = out[team] || { oe: 0, op: 0, de: 0, dp: 0, gp: 0 };
      o.oe += me.epa; o.op += me.plays; o.de += th.epa; o.dp += th.plays; o.gp++;
    }
  } catch (e) { /* optional: ratings fall back to points only */ }
  return out;
}

// nflverse snap counts: each player's share of his team's snaps (offense or defense) in the games he played over the team's last 6 weeks,
// i.e. his role when healthy. Tested on 2024-25 injury reports against the sim's misses: per full-time starter listed out, a team lost about
// 1.1 points (offensive line), 1.0 (WR/TE/RB) and 1.3 (defense); snap share beat the old production measure for defenders.
const snapName = x => String(x).toLowerCase().replace(/\b(jr|sr|ii|iii|iv|v)\b\.?/g, '').replace(/[^a-z]/g, '');
async function nflSnaps(year) {
  const S = {}, last = {};
  try {
    const r = await fetch('https://github.com/nflverse/nflverse-data/releases/download/snap_counts/snap_counts_' + year + '.csv', { signal: AbortSignal.timeout(60000) });
    if (!r.ok) return null;
    const file = path.join(__dirname, 'cache', 'snap_counts_' + year + '.csv');
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, await r.text());
    for (const s of readCsv(file)) {
      if (s.game_type !== 'REG') continue;
      const wk = +s.week, pct = Math.max(+s.offense_pct || 0, +s.defense_pct || 0);
      last[s.team] = Math.max(last[s.team] || 0, wk);
      (S[s.team + '|' + snapName(s.player)] = S[s.team + '|' + snapName(s.player)] || []).push({ wk, pct });
    }
  } catch (e) { return null; }
  return (team, name) => {
    const w = (S[team + '|' + snapName(name)] || []).filter(x => x.wk > (last[team] || 0) - 6);
    return w.length ? r3(w.reduce((a, x) => a + x.pct, 0) / w.length) : 0;
  };
}

function nflDefenders(defs, dc, dp, snap) {
  return defs.map(a => {
    const k = normName(a.fullName), c = dc[k], p = dp[k], inj = injuryOf(a);
    const weeks = (c ? c.weeks : 0) + 0.6 * (p ? p.weeks : 0);
    const prod = weeks ? ((c ? c.prod : 0) + 0.6 * (p ? p.prod : 0)) / weeks : 0, sn = snap ? snap(a.fullName) : null;
    if (!weeks && !sn) return null;
    return { name: a.fullName, pos: a.position.abbreviation, prod: r1(prod), snap: sn, gpr: c && c.teamWeeks ? r3(Math.min(1, c.weeks / c.teamWeeks)) : 0, out: inj.out, note: inj.note };
  }).filter(p => p && (p.prod >= 0.5 || p.snap >= 0.3)).sort((x, y) => (y.snap || 0) - (x.snap || 0) || y.prod - x.prod).slice(0, 14);
}
const OL_POS = ['OT', 'T', 'G', 'OG', 'C', 'OL'];
function nflLine(ath, snap) {
  if (!snap) return [];
  return ath.filter(a => OL_POS.includes(a.position && a.position.abbreviation)).map(a => { const inj = injuryOf(a); return { name: a.fullName, pos: a.position.abbreviation, snap: snap(a.fullName), out: inj.out, note: inj.note }; })
    .filter(p => p.snap >= 0.3).sort((x, y) => y.snap - x.snap).slice(0, 8);
}

// NHL: how many expected goals against a skater saves per game, from on-ice vs off-ice xGA (heavily shrunk)
async function mpSkaterImpact(year) {
  const [sk, tm] = await Promise.all([mpCsv(year, 'skaters'), mpCsv(year, 'teams')]);
  const ice = {}, tgp = {};
  (tm || []).forEach(r => { ice[r.team] = +r.iceTime; tgp[r.team] = +r.games_played; });
  const out = {};
  for (const r of sk || []) out[normName(r.name)] = { team: r.team, gp: +r.games_played, t: +r.icetime, on: +r.OnIce_A_xGoals, off: +r.OffIce_A_xGoals, onF: +r.OnIce_F_xGoals, offF: +r.OffIce_F_xGoals, T: ice[r.team], tgp: tgp[r.team] };
  return out;
}
function skaterImpact(cur, pri) {
  const w = 0.6, c = cur || {}, p = pri || {};
  const t = (c.t || 0) + w * (p.t || 0), T = (c.T ? c.T - (c.t || 0) : 0) + w * (p.T ? p.T - (p.t || 0) : 0);
  if (t < 3600 || T <= 0) return null;
  const on = (c.on || 0) + w * (p.on || 0), off = (c.off || 0) + w * (p.off || 0), gp = (c.gp || 0) + w * (p.gp || 0);
  const perGame = (off / T - on / t) * (t / Math.max(1, gp));        // xG against saved per game played
  const shrink = t / (t + 150000);                                   // on/off splits are very noisy: ~2,500 minutes before trusting half of it
  // offense: expected goals FOR the team gains per game with him on the ice (all situations, so power-play and linemate roles are included).
  // Year-to-year correlation 0.66-0.71 in MoneyPuck 2022-25, about twice as stable as the defensive number above. On/off also credits a player for his
  // linemates, so it is shrunk twice as hard (~5,000 minutes to trust half): McDavid lands near 0.08 goals/game and only a handful of stars reach the cap.
  const onF = (c.onF || 0) + w * (p.onF || 0), offF = (c.offF || 0) + w * (p.offF || 0);
  const oGame = (onF / t - offF / T) * (t / Math.max(1, gp));
  return { dimp: r3(Math.max(-0.06, Math.min(0.06, perGame * shrink))), oimp: r3(Math.max(-0.05, Math.min(0.15, oGame * t / (t + 300000)))), gpr: c.gp && c.tgp ? r3(Math.min(1, c.gp / c.tgp)) : 0 };
}

function injuryOf(a) {
  const inj = (a.injuries && a.injuries[0]) || null;
  const status = inj ? (inj.status || (inj.type && inj.type.description) || '') : '';
  const out = /out|injured reserve|suspend/i.test(status) || (a.status && /injured|suspend|out/i.test(a.status.name || '') && !/active/i.test(a.status.name || ''));
  return { out: !!out, note: status || (a.status && a.status.name !== 'Active' ? a.status.name : '') };
}
const r1 = x => Math.round(x * 10) / 10, r3 = x => Math.round(x * 1000) / 1000;

// College teams: opponent-adjusted ratings from this season's results (college.js), starting from last season's ratings, plus each team's
// players from the box scores. college-cache.json (committed) keeps last season's ratings, this season's finished days and the player totals,
// so a refresh only downloads days that were not finished last time. A day is closed (box scores read, never downloaded again) once all its
// games are final, or after 3 days whatever its state; days close in order so "missed the last game" stays right.
async function buildCollege(L) {
  const C = require('./college.js'), cfg = C.CFG[L], year = C.seasonOf(L), file = path.join(__dirname, 'college-cache.json'), VER = 2;
  let cache = {}; try { cache = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { /* first run */ }
  const c = cache[L] && cache[L].season === year && cache[L].v === VER ? cache[L] : { v: VER, season: year, prior: null, days: {}, open: {}, pl: {} };
  const mem = await C.members(L, year);
  if (Object.keys(mem).length < 50) throw new Error(L + ': team list failed to load');
  const M = new Set(Object.keys(mem)), base = { members: M, hca: cfg.hca, k: cfg.k, carry: cfg.carry, gap: cfg.gap, gapD: cfg.gapD };
  if (!c.prior) {   // once a season: last season's games and box scores (a large download the first time)
    const raw = await C.seasonGames(L, year - 1), D = await C.seasonDetail(L, year - 1, m => console.log('  ' + m)), days = {};
    for (const d in raw) days[d] = raw[d].map(g => C.gameRow(L, g, D[g[5]]));
    const p = C.rate(C.flat(L, days, M), Object.assign({}, base, { lg: 0 }));
    c.prior = { lg: r1(p.lg), teams: {} };
    for (const id in p.teams) c.prior.teams[id] = { o: Math.round(p.teams[id].o * 100) / 100, d: Math.round(p.teams[id].d * 100) / 100 };
    console.log(L.toUpperCase() + ': rated the ' + (year - 1) + ' season as a starting point (' + Object.keys(p.teams).length + ' teams)');
  }
  const all = C.seasonDays(L, year), need = all.filter(d => !(d in c.days)), got = await C.pool(need, 8, d => C.dayGames(L, d));
  let inOrder = true, boxes = 0; c.open = {};
  for (let i = 0; i < need.length; i++) {
    const d = need[i], games = got[i], age = all.length - 1 - all.indexOf(d);
    if (!games) { inOrder = false; continue; }
    if (inOrder && (games.pending === 0 || age > 3)) {
      const det = await C.pool(games, 10, g => C.gameDetail(L, g[5]));
      c.days[d] = games.map((g, k) => { C.track(L, c.pl, g, det[k]); return C.gameRow(L, g, det[k]); }); boxes += games.length;
    } else { inOrder = false; if (games.length) c.open[d] = games.map(g => g.slice(0, 6)); }
  }
  for (const id in c.pl) if (!M.has(id)) delete c.pl[id];
  cache[L] = c; fs.writeFileSync(file, JSON.stringify(cache));
  const days = Object.assign({}, c.days, c.open), R = C.rate(C.flat(L, days, M), Object.assign({}, base, { prior: c.prior.teams, lg: c.prior.lg }));
  const nGames = Object.values(days).reduce((a, x) => a + x.length, 0);
  console.log(L.toUpperCase() + ': season ' + year + ', ' + Object.keys(mem).length + ' teams, ' + nGames + ' games played (' + need.length + ' days checked, ' + boxes + ' box scores read)');
  const result = {}; let withPl = 0, flagged = 0;
  for (const id in mem) {
    const p = c.prior.teams[id], t = R.teams[id] || { o: p ? p.o * cfg.carry : 0, d: p ? p.d * cfg.carry : 0, n: 0 }, pl = C.players(L, c.pl[id]);
    result[id] = { abbr: mem[id].abbr, name: mem[id].name, off: r1(R.lg + t.o), def: r1(R.lg + t.d), gp: t.n };
    if (pl) { result[id].players = pl; withPl++; flagged += (L === 'ncaab' ? pl : pl.qb).filter(x => x.out).length; }
  }
  console.log('  players for ' + withPl + ' teams; ' + flagged + (L === 'ncaab' ? ' regulars' : ' starting quarterbacks') + ' missed their team\'s last game');
  META[L] = { lg: Math.round(R.lg * 1000) / 1000 };
  return result;
}

async function build(L) {
  if (LEAGUES[L].college) return buildCollege(L);
  const key = L, cfg = LEAGUES[L];
  const tj = await get(SITE + cfg.sport + '/' + key + '/teams');
  const teams = tj.sports[0].leagues[0].teams.map(t => t.team);
  // season year from the first roster that loads (ESPN sometimes 404s a single team's roster), else the league's listed season
  let year = null;
  for (const t of teams.slice(0, 5)) { const rj = await get(SITE + cfg.sport + '/' + key + '/teams/' + t.id + '/roster'); if (rj && rj.season) { year = rj.season.year; break; } }
  if (!year) { const s = tj.sports[0].leagues[0].season; if (!s) throw new Error(L + ': no season year from ESPN'); year = s.year; }
  console.log(L.toUpperCase() + ': season ' + year + ', ' + teams.length + ' teams');

  const [cur, pri] = await Promise.all([standings(L, key, year), standings(L, key, year - 1)]);
  const raw = {};
  for (const t of teams) {
    const c = cur[t.id], p = pri[t.id];
    if (!c && !p) { console.log('  no standings for', t.abbreviation); continue; }
    const wp = p ? cfg.prior : 0, gc = c ? c.gp : 0, den = gc + wp;
    raw[t.id] = { gp: gc, off: ((c ? c.pf * gc : 0) + (p ? p.pf * wp : 0)) / den, def: ((c ? c.pa * gc : 0) + (p ? p.pa * wp : 0)) / den };
  }
  let gmap = {}, smapC = {}, smapP = {}, dc = {}, dp = {}, snaps = null;
  if (L === 'nfl') {
    let ec, ep;
    [dc, dp, ec, ep, snaps] = await Promise.all([nflDefense(year), nflDefense(year - 1), nflEpa(year), nflEpa(year - 1), nflSnaps(year)]);
    console.log('  nflverse snap counts: ' + (snaps ? 'loaded' : 'unavailable'));
    // EPA per play -> points per game: 1 EPA/play of net efficiency was worth about 52 points/game of net scoring in the 2024-25 fit
    const K = 52, lgPer = E => { let oe = 0, op = 0; for (const k in E) { oe += E[k].oe; op += E[k].op; } return op ? oe / op : 0; }, mc = lgPer(ec), mp = lgPer(ep);
    const lgPts = Object.values(raw).reduce((a, x) => a + x.off + x.def, 0) / (2 * Object.keys(raw).length);
    let used = 0;
    for (const t of teams) {
      if (!raw[t.id]) continue;
      const code = NFLV_CODE[t.abbreviation] || t.abbreviation, c = ec[code], p = ep[code];
      if (!c && !p) continue;
      const wc = c ? c.gp : 0, wp = p ? cfg.prior : 0, den = wc + wp;
      const side = (e, m, k1, k2) => e ? (e[k1] / e[k2] - m) : 0;
      const off = lgPts + K * ((side(c, mc, 'oe', 'op') * wc + side(p, mp, 'oe', 'op') * wp) / den);
      const def = lgPts + K * ((side(c, mc, 'de', 'dp') * wc + side(p, mp, 'de', 'dp') * wp) / den);
      raw[t.id].off = 0.75 * raw[t.id].off + 0.25 * off; raw[t.id].def = 0.75 * raw[t.id].def + 0.25 * def; used++;
    }
    console.log('  nflverse EPA: blended into ' + used + ' team ratings');
  }
  if (L === 'nhl') {
    const [mc, mp, gc, gp_] = await Promise.all([mpTeams(year - 1), mpTeams(year - 2), mpGoalies(year - 1), mpGoalies(year - 2)]);
    let used = 0;
    for (const t of teams) {
      const code = MP_CODE[t.abbreviation] || t.abbreviation, c = mc[code], p = mp[code];
      if (!c && !p) continue;
      const wp = p ? cfg.prior : 0, gcn = c ? c.gp : 0, den = gcn + wp;
      raw[t.id] = { gp: gcn, off: ((c ? c.off * gcn : 0) + (p ? p.off * wp : 0)) / den, def: ((c ? c.def * gcn : 0) + (p ? p.def * wp : 0)) / den }; used++;
    }
    [smapC, smapP] = await Promise.all([mpSkaterImpact(year - 1), mpSkaterImpact(year - 2)]);
    for (const k of new Set([...Object.keys(gc), ...Object.keys(gp_)])) {
      const a = gc[k] || { g: 0, x: 0 }, b = gp_[k] || { g: 0, x: 0 };
      gmap[k] = { gar: (a.g + 0.5 * b.g + 20) / (a.x + 0.5 * b.x + 20) };
    }
    console.log('  MoneyPuck: ' + used + ' teams, ' + Object.keys(gmap).length + ' goalies');
  }
  const ids = Object.keys(raw), mean = k => ids.reduce((a, i) => a + raw[i][k], 0) / ids.length;
  if (cfg.shrink) {   // backtest: hockey results are so noisy that ratings should regress heavily toward the league mean
    const mo = mean('off'), md = mean('def');
    for (const i of ids) { const n = raw[i].gp + (cfg.prior || 0), f = n / (n + cfg.shrink); raw[i].off = mo + (raw[i].off - mo) * f; raw[i].def = md + (raw[i].def - md) * f; }
  }
  const scale = 1, lgMean = (mean('off') + mean('def')) / 2;

  const result = {};
  await pool(teams, 4, async t => {
    if (!raw[t.id]) return;
    const rost = await get(SITE + cfg.sport + '/' + key + '/teams/' + t.id + '/roster');
    const ath = rost ? rost.athletes.flatMap(g => g.items || [g]) : [];
    const want = ath.filter(a => {
      const p = a.position && a.position.abbreviation;
      if (L === 'nfl') return ['QB', 'RB', 'FB', 'WR', 'TE'].includes(p);
      return true;
    });
    const defs = L === 'nfl' ? ath.filter(a => ['DE', 'DT', 'NT', 'DL', 'LB', 'ILB', 'OLB', 'MLB', 'CB', 'S', 'FS', 'SS', 'DB'].includes(a.position && a.position.abbreviation)) : [];
    const stats = await pool(want, 8, a => combined(L, key, year, a.id, cfg.curMin));
    const rows = want.map((a, i) => ({ a, s: stats[i], pos: a.position.abbreviation, inj: injuryOf(a) })).filter(x => x.s);
    const entry = { name: t.displayName, off: r1(raw[t.id].off * scale * 10) / 10, def: r1(raw[t.id].def * scale * 10) / 10, gp: raw[t.id].gp };
    if (L === 'nhl') { entry.off = r3(raw[t.id].off * scale); entry.def = r3(raw[t.id].def * scale); }
    if (L === 'nba') entry.players = nbaPlayers(rows, raw[t.id].gp);
    if (L === 'nhl') Object.assign(entry, nhlPlayers(rows, gmap, smapC, smapP, await depthOf('nhl', t.id, 'g'), ath));
    if (L === 'nfl') {
      const code = NFLV_CODE[t.abbreviation] || t.abbreviation, snap = snaps ? name => snaps(code, name) : null;
      entry.players = nflPlayers(rows, await depthOf('nfl', t.id, 'qb'), ath); entry.players.defense = nflDefenders(defs, dc, dp, snap);
      if (snap) { for (const p of entry.players.rb.concat(entry.players.rec)) p.snap = snap(p.name); entry.players.ol = nflLine(ath, snap); }
    }
    result[t.abbreviation] = entry;
  });
  META[L] = { lg: Math.round(lgMean * 1000) / 1000 };
  return result;
}

// Hollinger Game Score from season totals (the sim's NBA absence cost uses it per 36 minutes)
function gameScore(s) {
  const n = k => s[k] || 0, oreb = s.offensiveRebounds != null ? n('offensiveRebounds') : 0.25 * n('rebounds'), dreb = s.defensiveRebounds != null ? n('defensiveRebounds') : 0.75 * n('rebounds');
  return n('points') + 0.4 * n('fieldGoalsMade') - 0.7 * n('fieldGoalsAttempted') - 0.4 * (n('freeThrowsAttempted') - n('freeThrowsMade')) + 0.7 * oreb + 0.3 * dreb
    + n('steals') + 0.7 * n('assists') + 0.7 * n('blocks') - 0.4 * n('fouls') - n('turnovers');
}
function nbaPlayers(rows, teamGp) {
  return rows.map(({ a, s, pos, inj }) => {
    const gp = s.gamesPlayed || 0, min = s.minutes || 0;
    if (gp < 1 || min < 30) return null;
    const fga = s.fieldGoalsAttempted || 0, fta = s.freeThrowsAttempted || 0, tov = s.turnovers || 0, pts = s.points || 0;
    const poss = fga + 0.44 * fta + tov;
    return { name: a.fullName, pos, out: inj.out, note: inj.note, gpr: teamGp >= 4 ? r3(Math.min(1, (s.__gpc || 0) / teamGp)) : 1, min: r1(min / gp), usage: r1(36 * poss / min), ts: r3(poss > 0 ? pts / (2 * (fga + 0.44 * fta + 5)) : 0.5),
      stk: r1(36 * ((s.steals || 0) + (s.blocks || 0)) / min), reb: r1(Math.max(0.5, 36 * (s.rebounds || 0) / min)), ast: r1(Math.max(0.3, 36 * (s.assists || 0) / min)), pts36: r1(36 * pts / min),
      gs36: r1(36 * gameScore(s) / min) };
  }).filter(Boolean).sort((x, y) => y.min - x.min).slice(0, 13);
}

function nhlPlayers(rows, gmap, smapC, smapP, depth, ath) {
  const sk = [], gk = [];
  for (const { a, s, pos, inj } of rows) {
    if (pos === 'G') {
      const sa = s.shotsAgainst || 0, gp = s.games || s.gamesPlayed || 0;
      if (gp >= 1 && sa > 0) gk.push({ name: a.fullName, out: inj.out, note: inj.note, gp: r1(gp), sv: r3((s.saves || 0) / sa), sa, gar: gmap && gmap[normName(a.fullName)] ? r3(gmap[normName(a.fullName)].gar) : null });
      continue;
    }
    const gp = s.games || 0; if (gp < 1) continue;
    sk.push({ name: a.fullName, pos: pos === 'L' ? 'LW' : pos === 'R' ? 'RW' : pos, out: inj.out, note: inj.note,
      ...(({ dimp = 0, oimp = 0, gpr = 0 }) => ({ dimp, oimp, gpr }))(skaterImpact(smapC[normName(a.fullName)], smapP[normName(a.fullName)]) || {}),
      toi: r1((s.timeOnIcePerGame || (s.timeOnIce || 0) / gp) / 60), w: r1(Math.max(0.3, (s.shotsTotal || 0) / gp)) });
  }
  const norm = p => ({ ...p, w: Math.max(0.3, p.w) });
  const top = (arr, n) => arr.sort((x, y) => y.toi - x.toi).slice(0, n).map(norm);
  const fwd = top(sk.filter(p => p.pos !== 'D'), 14), def = top(sk.filter(p => p.pos === 'D'), 8);
  gk.sort((x, y) => y.gp - x.gp);
  // depth-chart order first: with no probable or confirmed starter announced, the sim and the page start the first healthy goalie in this list.
  // A listed goalie with no NHL games yet gets a league-average save percentage.
  const ord = (depth || []).map(d => {
    const i = gk.findIndex(g => g.name === d.name); if (i >= 0) return gk.splice(i, 1)[0];
    const a = (ath || []).find(x => String(x.id) === d.id), inj = a ? injuryOf(a) : { out: false, note: '' };
    return { name: d.name, out: inj.out, note: inj.note, gp: 0, sv: 0.905, sa: 0, gar: null };
  });
  gk.unshift(...ord);
  const saves = gk.reduce((a, g) => a + g.sv * g.sa, 0), sa = gk.reduce((a, g) => a + g.sa, 0);
  return { fwd, dmen: def, goalies: gk.map(g => ({ name: g.name, out: g.out, note: g.note, gp: g.gp, sv: g.sv, gar: g.gar })).slice(0, 3), garAvg: garAvg(gk), svAvg: sa ? r3(saves / sa) : 0.905 };
}

function garAvg(gk) {
  const w = gk.filter(g => g.gar); const gp = w.reduce((a, g) => a + g.gp, 0);
  return gp ? r3(w.reduce((a, g) => a + g.gar * g.gp, 0) / gp) : null;
}

// ESPN team depth chart (the same endpoint sportsdataverse's depth-chart wrappers read): one position's players in listed order, starter first.
// Used for NFL quarterbacks and NHL goalies. The NBA chart was checked too, but its starters were already all in the player list, so it adds nothing there.
async function depthOf(L, teamId, pos) {
  const j = await get(SITE + LEAGUES[L].sport + '/' + L + '/teams/' + teamId + '/depthcharts');
  for (const g of (j && j.depthchart) || []) {
    const p = g.positions && (g.positions[pos] || g.positions[pos.toUpperCase()]);
    if (p && p.athletes && p.athletes.length) return p.athletes.map(a => ({ id: String(a.id), name: a.displayName || a.fullName }));
  }
  return [];
}

function nflPlayers(rows, depth, ath) {
  const shrink = (num, den, prior, k) => (num + prior * k) / (den + k);
  const all = rows.map(({ a, s, pos, inj }) => ({ id: String(a.id), name: a.fullName, pos, out: inj.out, note: inj.note, s }));
  const qbStat = p => ({ name: p.name, pos: 'QB', out: p.out, note: p.note, att: r1(p.s.passingAttempts || 0),
    ypa: r3(shrink(p.s.passingYards || 0, p.s.passingAttempts || 0, 6.9, 150)), cmp: r3(shrink(p.s.completions || 0, p.s.passingAttempts || 0, 0.645, 150)),
    int: r3(shrink(p.s.interceptions || 0, p.s.passingAttempts || 0, 0.022, 150)), rush: r1((p.s.rushingAttempts || 0) / Math.max(1, p.s.__gp ? p.s.__gp : 1)) });
  // "base" = the QB with the most attempts, whose play the team rating already reflects. Who starts follows the depth chart:
  // its QBs go first in listed order (a starter with no NFL attempts yet gets league-average numbers, and the sim's backup penalty), then the rest by attempts.
  const byAtt = all.filter(p => p.pos === 'QB' && (p.s.passingAttempts || 0) > 0).sort((x, y) => y.s.passingAttempts - x.s.passingAttempts);
  const list = [];
  for (const d of (depth || []).slice(0, 3)) {
    const p = all.find(x => x.id === d.id && x.pos === 'QB');
    if (p && (p.s.passingAttempts || 0) > 0) { list.push({ ...qbStat(p), depth: list.length + 1 }); continue; }
    const a = (ath || []).find(x => String(x.id) === d.id), inj = a ? injuryOf(a) : { out: false, note: '' };
    list.push({ name: d.name, pos: 'QB', out: inj.out, note: inj.note, att: 0, ypa: 6.9, cmp: 0.645, int: 0.022, rush: 0, depth: list.length + 1 });
  }
  for (const p of byAtt) if (list.length < 3 || p === byAtt[0]) { if (!list.some(q => q.name === p.name)) list.push(qbStat(p)); }
  if (byAtt[0]) { const b = list.find(q => q.name === byAtt[0].name); if (b) b.base = true; } else if (list[0]) list[0].base = true;
  const qbs = list;
  const rbs = all.filter(p => (p.pos === 'RB' || p.pos === 'FB') && (p.s.rushingAttempts || 0) > 3).sort((x, y) => y.s.rushingAttempts - x.s.rushingAttempts).slice(0, 4).map(p => ({
    name: p.name, pos: 'RB', out: p.out, note: p.note, car: r1(p.s.rushingAttempts), ypc: r3(shrink(p.s.rushingYards || 0, p.s.rushingAttempts, 4.3, 40)), tgt: r1(p.s.receivingTargets || 0), rec: r1(p.s.receptions || 0), ryds: r1(p.s.receivingYards || 0) }));
  const rcv = all.filter(p => ['WR', 'TE', 'RB', 'FB'].includes(p.pos) && (p.s.receivingTargets || 0) > 3).map(p => ({
    name: p.name, pos: p.pos === 'FB' ? 'RB' : p.pos, out: p.out, note: p.note, tgt: r1(p.s.receivingTargets), rec: r1(p.s.receptions || 0), yds: r1(p.s.receivingYards || 0), td: r1(p.s.receivingTouchdowns || 0) }));
  const wrte = rcv.filter(p => p.pos !== 'RB').sort((x, y) => y.tgt - x.tgt).slice(0, 7);
  return { qb: qbs, rb: rbs, rec: wrte };
}

// ESPN's scoreboard is keyed by US Eastern date; the machine's own date is wrong after 7pm Eastern on a UTC runner
const etYmd = d => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d).replace(/-/g, '');
// NHL's own API lists the starting goalies once teams submit lineups (roughly 1-2 hours before puck drop). Before that ESPN's "probable" is all we have.
const NHL_CODE = abbr => MP_CODE[abbr] || abbr;
function nhlStarters(box) {
  const pb = box && box.playerByGameStats, pick = t => { const g = pb && pb[t] && (pb[t].goalies || []).find(x => x.starter === true); return g ? g.name.default : null; };
  return { away: pick('awayTeam'), home: pick('homeTeam') };
}
async function nhlConfirm(games) {
  const soon = games.filter(g => { const dt = new Date(g.date).getTime() - Date.now(); return dt < 5 * 3600e3 && dt > -3600e3; });
  if (!soon.length) return;
  const J = async u => { try { const r = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(20000) }); return r.ok ? r.json() : null; } catch (e) { return null; } };
  const sched = await J('https://api-web.nhle.com/v1/schedule/now'); if (!sched) return;
  const all = (sched.gameWeek || []).flatMap(d => d.games || []); let n = 0;
  for (const g of soon) {
    const m = all.find(x => x.awayTeam.abbrev === NHL_CODE(g.away.abbr) && x.homeTeam.abbrev === NHL_CODE(g.home.abbr) && Math.abs(new Date(x.startTimeUTC) - new Date(g.date)) < 3600e3);
    if (!m) continue;
    const s = nhlStarters(await J('https://api-web.nhle.com/v1/gamecenter/' + m.id + '/boxscore'));
    if (s.away) { g.away.confirmed = s.away; n++; } if (s.home) { g.home.confirmed = s.home; n++; }
  }
  console.log('  NHL API: ' + n + ' confirmed starters for ' + soon.length + ' games starting soon');
}
async function schedule(L, days) {
  const out = [], cfg = LEAGUES[L], hist = [];
  const dayIdx = iso => Math.floor((new Date(iso).getTime() - 5 * 3600e3) / 86400000);
  for (let d = -3; d < 0; d++) {      // recent results, only used to work out days of rest
    const dt = new Date(Date.now() + d * 86400000);
    const ymd = etYmd(dt);
    const j = await get(boardUrl(L, ymd));
    for (const ev of (j && j.events) || []) for (const c of ev.competitions[0].competitors) hist.push({ team: c.team.abbreviation, day: dayIdx(ev.date), venue: ev.competitions[0].competitors.find(x => x.homeAway === 'home').team.abbreviation });
  }
  for (let d = 0; d < days; d++) {
    const dt = new Date(Date.now() + d * 86400000);
    const ymd = etYmd(dt);
    const j = await get(boardUrl(L, ymd));
    for (const ev of (j && j.events) || []) {
      if (ev.status.type.state !== 'pre') continue;
      const c = ev.competitions[0], home = c.competitors.find(x => x.homeAway === 'home'), away = c.competitors.find(x => x.homeAway === 'away');
      const rank = x => cfg.college && x.curatedRank && x.curatedRank.current >= 1 && x.curatedRank.current <= 25 ? x.curatedRank.current : undefined;
      const side = x => ({ abbr: x.team.abbreviation, name: x.team.displayName, id: cfg.college ? x.team.id : undefined, rank: rank(x), probable: ((x.probables || [])[0] && x.probables[0].athlete && x.probables[0].athlete.fullName) || null });
      const o = c.odds && c.odds[0];
      out.push({ id: ev.id, date: ev.date, away: side(away), home: side(home), venue: cfg.college ? { neutral: !!c.neutralSite } : L === 'nfl' && c.venue ? { indoor: !!c.venue.indoor, neutral: !!c.neutralSite } : undefined,
        homeFav: o && o.homeTeamOdds && o.awayTeamOdds && o.homeTeamOdds.favorite !== o.awayTeamOdds.favorite ? !!o.homeTeamOdds.favorite : undefined,   // which side the line favors (college abbreviations in the line text can be ambiguous)
        line: o ? o.details || null : null, total: o ? o.overUnder || null : null,
        homeML: o && o.homeTeamOdds ? o.homeTeamOdds.moneyLine ?? null : null, awayML: o && o.awayTeamOdds ? o.awayTeamOdds.moneyLine ?? null : null });
    }
  }
  const uniq = out.filter((g, i, a) => a.findIndex(x => x.id === g.id) === i).sort((x, y) => x.date.localeCompare(y.date));
  for (const g of uniq) {   // days since each team's previous game (0 = back-to-back), null if unknown
    const day = dayIdx(g.date);
    const prev = abbr => { const ds = hist.map(h => h.team === abbr ? h.day : null).concat(uniq.filter(o => o !== g && (o.away.abbr === abbr || o.home.abbr === abbr)).map(o => dayIdx(o.date))).filter(x => x != null && x < day); return ds.length ? day - Math.max(...ds) - 1 : null; };
    g.awayRest = prev(g.away.abbr); g.homeRest = prev(g.home.abbr);
    // where each team played its previous game (the arena it travels from), for travel distance and time-zone change
    const from = abbr => { const c = hist.filter(h => h.team === abbr && h.day < day).map(h => ({ day: h.day, venue: h.venue })).concat(uniq.filter(o => o !== g && (o.away.abbr === abbr || o.home.abbr === abbr) && dayIdx(o.date) < day).map(o => ({ day: dayIdx(o.date), venue: o.home.abbr }))); return c.length ? c.sort((x, y) => y.day - x.day)[0].venue : null; };
    g.awayFrom = from(g.away.abbr); g.homeFrom = from(g.home.abbr);
  }
  if (L === 'nhl') await nhlConfirm(uniq);
  if (L === 'nfl') await nflWeather(uniq);
  if (L !== 'nhl') await espnPredictor(L, uniq);
  return uniq;
}

// ESPN's own matchup predictor (BPI for basketball, FPI for football): home win chance from the game summary. ESPN drops it once a game ends, so it
// cannot be backtested; it is logged with each pick (log-picks.js) and shown on the card so it can be judged against results over time.
async function espnPredictor(L, games) {
  let n = 0;
  await pool(games, 6, async g => {
    const j = await get(SITE + LEAGUES[L].sport + '/' + lkey(L) + '/summary?event=' + g.id), h = j && j.predictor && j.predictor.homeTeam;
    const p = h ? parseFloat(h.gameProjection) / 100 : NaN;
    if (p > 0 && p < 1) { g.espnP = Math.round(p * 1000) / 1000; n++; }
  });
  console.log('  ESPN predictor: ' + n + ' of ' + games.length + ' ' + L.toUpperCase() + ' games');
}

// NFL kickoff weather from Open-Meteo's free forecast (no key): wind (mph) and temperature (F) at the home stadium for the kickoff hour.
// Indoor venues (ESPN's venue.indoor; retractable roofs count as indoor) get { indoor: true }. Neutral sites have no stadium coordinates here and are skipped.
async function nflWeather(games) {
  const Travel = require('./travel.js'); let n = 0;
  const DOME = ['ARI', 'ATL', 'DAL', 'DET', 'HOU', 'IND', 'LV', 'LAC', 'LAR', 'MIN', 'NO'];   // fixed or retractable roofs, in case ESPN's venue flag is missing
  for (const g of games) {
    if (!g.venue) continue;
    if (g.venue.indoor || (!g.venue.neutral && DOME.includes(g.home.abbr))) { g.weather = { indoor: true }; continue; }
    const p = !g.venue.neutral && Travel.loc('nfl', g.home.abbr); if (!p) continue;
    const day = g.date.slice(0, 10);
    try {
      const r = await fetch('https://api.open-meteo.com/v1/forecast?latitude=' + p[0] + '&longitude=' + p[1] + '&hourly=temperature_2m,wind_speed_10m,precipitation&wind_speed_unit=mph&temperature_unit=fahrenheit&timezone=UTC&start_date=' + day + '&end_date=' + day, { signal: AbortSignal.timeout(20000) });
      if (!r.ok) continue;
      const j = await r.json(), h = new Date(g.date).getUTCHours(), i = (j.hourly.time || []).findIndex(t => +t.slice(11, 13) === h);
      if (i < 0) continue;
      g.weather = { wind: Math.round(j.hourly.wind_speed_10m[i]), temp: Math.round(j.hourly.temperature_2m[i]), precip: j.hourly.precipitation[i] }; n++;
    } catch (e) { /* forecast is optional */ }
  }
  console.log('  Open-Meteo: kickoff weather for ' + n + ' outdoor NFL games');
}

(async () => {
  const want = process.argv.slice(2).filter(a => LEAGUES[a]);
  const leagues = want.length ? want : Object.keys(LEAGUES);
  const file = path.join(__dirname, 'data.js');
  let data = {};
  try { data = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^[^{]*/, '').replace(/;\s*$/, '')); } catch (e) { /* first run */ }
  data.generated = new Date().toISOString();
  data.meta = data.meta || {};
  data.schedule = data.schedule || {};
  for (const L of leagues) { data.schedule[L] = await schedule(L, 3); console.log('  ' + data.schedule[L].length + ' upcoming ' + L.toUpperCase() + ' games'); }
  for (const L of leagues) { const t0 = Date.now(); data[L] = await build(L); data.meta[L] = META[L]; console.log('  ' + Object.keys(data[L]).length + ' teams in ' + ((Date.now() - t0) / 1000).toFixed(0) + 's'); }
  fs.writeFileSync(file, 'window.LIVE_DATA = ' + JSON.stringify(data) + ';\n');
  console.log('wrote ' + file);
})();
