// Pulls live team ratings, rosters, injuries and player stats from ESPN's public JSON API
// and writes data.js (loaded by index.html). Usage: node update-data.js [nba|nfl|nhl ...]
'use strict';
const { read: readCsv } = require('./csv.js');
const fs = require('fs'), path = require('path');

const LEAGUES = {
  nba: { sport: 'basketball', prior: 8, lg: 114, curMin: 12 },
  nfl: { sport: 'football', prior: 3, lg: 22.5, curMin: 6 },
  nhl: { sport: 'hockey', prior: 5, lg: 3.05, curMin: 12, shrink: 50 },
};
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
function nflDefenders(defs, dc, dp) {
  return defs.map(a => {
    const k = normName(a.fullName), c = dc[k], p = dp[k], inj = injuryOf(a);
    const weeks = (c ? c.weeks : 0) + 0.6 * (p ? p.weeks : 0);
    if (!weeks) return null;
    const prod = ((c ? c.prod : 0) + 0.6 * (p ? p.prod : 0)) / weeks;
    return { name: a.fullName, pos: a.position.abbreviation, prod: r1(prod), gpr: c && c.teamWeeks ? r3(Math.min(1, c.weeks / c.teamWeeks)) : 0, out: inj.out, note: inj.note };
  }).filter(p => p && p.prod >= 0.5).sort((x, y) => y.prod - x.prod).slice(0, 12);
}

// NHL: how many expected goals against a skater saves per game, from on-ice vs off-ice xGA (heavily shrunk)
async function mpSkaterImpact(year) {
  const [sk, tm] = await Promise.all([mpCsv(year, 'skaters'), mpCsv(year, 'teams')]);
  const ice = {}, tgp = {};
  (tm || []).forEach(r => { ice[r.team] = +r.iceTime; tgp[r.team] = +r.games_played; });
  const out = {};
  for (const r of sk || []) out[normName(r.name)] = { team: r.team, gp: +r.games_played, t: +r.icetime, on: +r.OnIce_A_xGoals, off: +r.OffIce_A_xGoals, T: ice[r.team], tgp: tgp[r.team] };
  return out;
}
function skaterImpact(cur, pri) {
  const w = 0.6, c = cur || {}, p = pri || {};
  const t = (c.t || 0) + w * (p.t || 0), T = (c.T ? c.T - (c.t || 0) : 0) + w * (p.T ? p.T - (p.t || 0) : 0);
  if (t < 3600 || T <= 0) return null;
  const on = (c.on || 0) + w * (p.on || 0), off = (c.off || 0) + w * (p.off || 0), gp = (c.gp || 0) + w * (p.gp || 0);
  const perGame = (off / T - on / t) * (t / Math.max(1, gp));        // xG against saved per game played
  const shrink = t / (t + 150000);                                   // on/off splits are very noisy: ~2,500 minutes before trusting half of it
  return { dimp: r3(Math.max(-0.06, Math.min(0.06, perGame * shrink))), gpr: c.gp && c.tgp ? r3(Math.min(1, c.gp / c.tgp)) : 0 };
}

function injuryOf(a) {
  const inj = (a.injuries && a.injuries[0]) || null;
  const status = inj ? (inj.status || (inj.type && inj.type.description) || '') : '';
  const out = /out|injured reserve|suspend/i.test(status) || (a.status && /injured|suspend|out/i.test(a.status.name || '') && !/active/i.test(a.status.name || ''));
  return { out: !!out, note: status || (a.status && a.status.name !== 'Active' ? a.status.name : '') };
}
const r1 = x => Math.round(x * 10) / 10, r3 = x => Math.round(x * 1000) / 1000;

async function build(L) {
  const key = L, cfg = LEAGUES[L];
  const tj = await get(SITE + cfg.sport + '/' + key + '/teams');
  const teams = tj.sports[0].leagues[0].teams.map(t => t.team);
  const rj = await get(SITE + cfg.sport + '/' + key + '/teams/' + teams[0].id + '/roster');
  const year = rj.season.year;
  console.log(L.toUpperCase() + ': season ' + year + ', ' + teams.length + ' teams');

  const [cur, pri] = await Promise.all([standings(L, key, year), standings(L, key, year - 1)]);
  const raw = {};
  for (const t of teams) {
    const c = cur[t.id], p = pri[t.id];
    if (!c && !p) { console.log('  no standings for', t.abbreviation); continue; }
    const wp = p ? cfg.prior : 0, gc = c ? c.gp : 0, den = gc + wp;
    raw[t.id] = { gp: gc, off: ((c ? c.pf * gc : 0) + (p ? p.pf * wp : 0)) / den, def: ((c ? c.pa * gc : 0) + (p ? p.pa * wp : 0)) / den };
  }
  let gmap = {}, smapC = {}, smapP = {}, dc = {}, dp = {};
  if (L === 'nfl') [dc, dp] = await Promise.all([nflDefense(year), nflDefense(year - 1)]);
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
    if (L === 'nhl') Object.assign(entry, nhlPlayers(rows, gmap, smapC, smapP));
    if (L === 'nfl') { entry.players = nflPlayers(rows); entry.players.defense = nflDefenders(defs, dc, dp); }
    result[t.abbreviation] = entry;
  });
  META[L] = { lg: Math.round(lgMean * 1000) / 1000 };
  return result;
}

function nbaPlayers(rows, teamGp) {
  return rows.map(({ a, s, pos, inj }) => {
    const gp = s.gamesPlayed || 0, min = s.minutes || 0;
    if (gp < 1 || min < 30) return null;
    const fga = s.fieldGoalsAttempted || 0, fta = s.freeThrowsAttempted || 0, tov = s.turnovers || 0, pts = s.points || 0;
    const poss = fga + 0.44 * fta + tov;
    return { name: a.fullName, pos, out: inj.out, note: inj.note, gpr: teamGp >= 4 ? r3(Math.min(1, (s.__gpc || 0) / teamGp)) : 1, min: r1(min / gp), usage: r1(36 * poss / min), ts: r3(poss > 0 ? pts / (2 * (fga + 0.44 * fta + 5)) : 0.5),
      stk: r1(36 * ((s.steals || 0) + (s.blocks || 0)) / min), reb: r1(Math.max(0.5, 36 * (s.rebounds || 0) / min)), ast: r1(Math.max(0.3, 36 * (s.assists || 0) / min)), pts36: r1(36 * pts / min) };
  }).filter(Boolean).sort((x, y) => y.min - x.min).slice(0, 13);
}

function nhlPlayers(rows, gmap, smapC, smapP) {
  const sk = [], gk = [];
  for (const { a, s, pos, inj } of rows) {
    if (pos === 'G') {
      const sa = s.shotsAgainst || 0, gp = s.games || s.gamesPlayed || 0;
      if (gp >= 1 && sa > 0) gk.push({ name: a.fullName, out: inj.out, note: inj.note, gp: r1(gp), sv: r3((s.saves || 0) / sa), sa, gar: gmap && gmap[normName(a.fullName)] ? r3(gmap[normName(a.fullName)].gar) : null });
      continue;
    }
    const gp = s.games || 0; if (gp < 1) continue;
    sk.push({ name: a.fullName, pos: pos === 'L' ? 'LW' : pos === 'R' ? 'RW' : pos, out: inj.out, note: inj.note,
      dimp: (skaterImpact(smapC[normName(a.fullName)], smapP[normName(a.fullName)]) || {}).dimp || 0, gpr: (skaterImpact(smapC[normName(a.fullName)], smapP[normName(a.fullName)]) || {}).gpr || 0,
      toi: r1((s.timeOnIcePerGame || (s.timeOnIce || 0) / gp) / 60), w: r1(Math.max(0.3, (s.shotsTotal || 0) / gp)) });
  }
  const norm = p => ({ ...p, w: Math.max(0.3, p.w) });
  const top = (arr, n) => arr.sort((x, y) => y.toi - x.toi).slice(0, n).map(norm);
  const fwd = top(sk.filter(p => p.pos !== 'D'), 14), def = top(sk.filter(p => p.pos === 'D'), 8);
  gk.sort((x, y) => y.gp - x.gp);
  const saves = gk.reduce((a, g) => a + g.sv * g.sa, 0), sa = gk.reduce((a, g) => a + g.sa, 0);
  return { fwd, dmen: def, goalies: gk.map(g => ({ name: g.name, out: g.out, note: g.note, gp: g.gp, sv: g.sv, gar: g.gar })).slice(0, 3), garAvg: garAvg(gk), svAvg: sa ? r3(saves / sa) : 0.905 };
}

function garAvg(gk) {
  const w = gk.filter(g => g.gar); const gp = w.reduce((a, g) => a + g.gp, 0);
  return gp ? r3(w.reduce((a, g) => a + g.gar * g.gp, 0) / gp) : null;
}

function nflPlayers(rows) {
  const shrink = (num, den, prior, k) => (num + prior * k) / (den + k);
  const all = rows.map(({ a, s, pos, inj }) => ({ name: a.fullName, pos, out: inj.out, note: inj.note, s }));
  const qbs = all.filter(p => p.pos === 'QB' && (p.s.passingAttempts || 0) > 0).sort((x, y) => y.s.passingAttempts - x.s.passingAttempts).slice(0, 3).map((p, i) => ({
    name: p.name, pos: 'QB', out: p.out, note: p.note, base: i === 0, att: r1(p.s.passingAttempts),
    ypa: r3(shrink(p.s.passingYards || 0, p.s.passingAttempts, 6.9, 150)), cmp: r3(shrink(p.s.completions || 0, p.s.passingAttempts, 0.645, 150)),
    int: r3(shrink(p.s.interceptions || 0, p.s.passingAttempts, 0.022, 150)), rush: r1((p.s.rushingAttempts || 0) / Math.max(1, p.s.__gp ? p.s.__gp : 1)) }));
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
    const j = await get(SITE + cfg.sport + '/' + L + '/scoreboard?dates=' + ymd);
    for (const ev of (j && j.events) || []) for (const c of ev.competitions[0].competitors) hist.push({ team: c.team.abbreviation, day: dayIdx(ev.date), venue: ev.competitions[0].competitors.find(x => x.homeAway === 'home').team.abbreviation });
  }
  for (let d = 0; d < days; d++) {
    const dt = new Date(Date.now() + d * 86400000);
    const ymd = etYmd(dt);
    const j = await get(SITE + cfg.sport + '/' + L + '/scoreboard?dates=' + ymd);
    for (const ev of (j && j.events) || []) {
      if (ev.status.type.state !== 'pre') continue;
      const c = ev.competitions[0], home = c.competitors.find(x => x.homeAway === 'home'), away = c.competitors.find(x => x.homeAway === 'away');
      const side = x => ({ abbr: x.team.abbreviation, name: x.team.displayName, probable: ((x.probables || [])[0] && x.probables[0].athlete && x.probables[0].athlete.fullName) || null });
      const o = c.odds && c.odds[0];
      out.push({ id: ev.id, date: ev.date, away: side(away), home: side(home), line: o ? o.details || null : null, total: o ? o.overUnder || null : null,
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
  return uniq;
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
