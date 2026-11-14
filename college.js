// College football (FBS) and men's college basketball (Division I): season results from ESPN and opponent-adjusted team ratings.
// Used by update-data.js (live ratings) and backtest-college.js (walk-forward test).
'use strict';
const fs = require('fs'), path = require('path');

// hca: home edge in points of margin. k: how many games of evidence last season's rating (or the average, for a team without one) is worth.
// carry: share of last season's rating kept as this season's starting point. gap: how far below average a non-member opponent (FCS, non-Division I)
// starts on each side of the ball. start/end: [month, day] the season's games fall between (end is in the following calendar year).
// hca, k and carry were picked on the 2025 seasons (nearby values score almost the same). Keep hca equal to NCAAF_HCA / NCAAB_HCA in sim.js.
// The rest were tested walk-forward on two seasons each (2024 and 2025) against results and closing lines:
//   yards (football): share of each game's score replaced by the points its yardage and turnovers usually produce. Margin accuracy unchanged, totals 0.15-0.2 points closer.
//   three (basketball): share of three-point shooting luck removed from each score (makes above/below the Division I rate on the attempts taken). Margin miss 9.17 -> 9.13.
//   gap / gapD (basketball): non-Division I opponents score about 10 below average but allow about 26 more, so one number for both inflated totals.
//   drift (basketball): scoring falls about 4 points a game from November to February; scores are shifted to the last `drift` days' level. Total bias +1.7 -> +0.3.
const CFG = {
  ncaaf: { sport: 'football', key: 'college-football', groups: 80, hca: 3.5, k: 3, carry: 0.8, gap: 12, yards: 0.25, start: [8, 15], end: [1, 31] },
  ncaab: { sport: 'basketball', key: 'mens-college-basketball', groups: 50, hca: 3.5, k: 5, carry: 0.8, gap: 10, gapD: 26, three: 0.5, drift: 21, start: [11, 1], end: [4, 15] },
};
// Football: points a team usually scores from its total yards, its own turnovers and the opponent's (least squares on 2023 and 2024 FBS games).
const XP = [-10, 0.096, -1.95, 2.45], P3 = 0.338;
const SITE = 'https://site.api.espn.com/apis/site/v2/sports/';

async function get(url) {
  for (let i = 0; i < 3; i++) {
    try { const r = await fetch(url, { signal: AbortSignal.timeout(30000) }); if (r.status === 404) return null; if (r.ok) return await r.json(); } catch (e) { /* retry */ }
    await new Promise(r => setTimeout(r, 500 * (i + 1)));
  }
  return null;
}
async function pool(items, n, fn) {
  const out = new Array(items.length); let k = 0;
  await Promise.all(Array.from({ length: n }, async () => { for (;;) { const i = k++; if (i >= items.length) return; out[i] = await fn(items[i], i); } }));
  return out;
}
const ymd = d => d.toISOString().slice(0, 10).replace(/-/g, '');

// The season a date belongs to, named by the year it starts in (the 2026-27 basketball season is 2026).
function seasonOf(L, now) { const d = now || new Date(), m = d.getUTCMonth() + 1; return m >= CFG[L].start[0] ? d.getUTCFullYear() : d.getUTCFullYear() - 1; }
function seasonDays(L, year, until) {
  const c = CFG[L], out = [], end = Math.min(Date.UTC(year + 1, c.end[0] - 1, c.end[1], 12), (until || new Date()).getTime());
  for (let t = Date.UTC(year, c.start[0] - 1, c.start[1], 12); t <= end; t += 86400000) out.push(ymd(new Date(t)));
  return out;
}
// One day's finished games as [homeId, awayId, homeScore, awayScore, neutral(0/1), eventId]; null if the request failed.
// The list's .pending is how many of the day's games have not finished yet.
async function dayGames(L, day) {
  const c = CFG[L], j = await get(SITE + c.sport + '/' + c.key + '/scoreboard?dates=' + day + '&groups=' + c.groups + '&limit=500');
  if (!j) return null;
  const out = []; out.pending = 0;
  for (const ev of j.events || []) {
    if (!ev.status.type.completed) { if (ev.status.type.state !== 'post') out.pending++; continue; }
    const comp = ev.competitions[0], h = comp.competitors.find(x => x.homeAway === 'home'), a = comp.competitors.find(x => x.homeAway === 'away');
    if (!h || !a || !isFinite(+h.score) || !isFinite(+a.score) || (+h.score === 0 && +a.score === 0)) continue;
    out.push([h.team.id, a.team.id, +h.score, +a.score, comp.neutralSite ? 1 : 0, ev.id]);
  }
  return out;
}
// A whole finished season, { day: [games] }, kept in cache/ (not committed) so it is only downloaded once.
async function seasonGames(L, year) {
  const file = path.join(__dirname, 'cache', 'college_' + L + '_' + year + '_v2.json');
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  const ds = seasonDays(L, year), got = await pool(ds, 8, d => dayGames(L, d)), days = {};
  if (got.some(g => g === null)) throw new Error(L + ' ' + year + ': some days failed to download');
  ds.forEach((d, i) => { if (got[i].length) days[d] = got[i]; });
  if (Date.now() > Date.UTC(year + 1, CFG[L].end[0] - 1, CFG[L].end[1] + 2)) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(days)); }
  return days;
}
// Member teams: FBS (from the standings) or all of Division I basketball (the team list). { espnId: { abbr, name } }
async function members(L, year) {
  const c = CFG[L], out = {};
  if (L === 'ncaaf') {
    const j = await get('https://site.api.espn.com/apis/v2/sports/football/college-football/standings?season=' + year + '&group=' + c.groups);
    const walk = n => { ((n.standings && n.standings.entries) || []).forEach(e => { out[e.team.id] = { abbr: e.team.abbreviation, name: e.team.displayName }; }); (n.children || []).forEach(walk); };
    if (j) walk(j);
  } else {
    const j = await get(SITE + c.sport + '/' + c.key + '/teams?limit=1000');
    for (const t of (j ? j.sports[0].leagues[0].teams : [])) out[t.team.id] = { abbr: t.team.abbreviation, name: t.team.displayName };
  }
  return out;
}

// Opponent-adjusted ratings. Every game says: points = league average + offense of the scorer + defense of the opponent (+/- half the home edge).
// Each team's offense and defense are solved together, shrunk toward a starting point (last season's rating scaled by `carry`, the average for a
// member with no history, or `gap` below average for a non-member) that counts as k games. Returned as points above/below average: { lg, teams: { id: { o, d, n } } }
// where d > 0 means the team allows more than average.
function rate(games, o) {
  const sc = (g, i) => g[6 + i] != null ? g[6 + i] : g[2 + i];   // the adjusted score when the game has one
  const T = {}, isM = id => !o.members || o.members.has(id);
  const tm = id => T[id] || (T[id] = (p => ({ n: 0, o: p.o, d: p.d, po: p.o, pd: p.d, so: 0, sd: 0 }))(
    o.prior && o.prior[id] ? { o: o.prior[id].o * o.carry, d: o.prior[id].d * o.carry } : isM(id) ? { o: 0, d: 0 } : { o: -o.gap, d: o.gapD || o.gap }));
  let pts = 0, n = 0;
  for (const g of games) { tm(g[0]).n++; tm(g[1]).n++; if (isM(g[0]) && isM(g[1])) { pts += sc(g, 0) + sc(g, 1); n += 2; } }
  const lg = n >= 40 ? pts / n : o.lg;
  for (let it = 0; it < 60; it++) {
    for (const id in T) { T[id].so = 0; T[id].sd = 0; }
    for (const g of games) {
      const H = T[g[0]], A = T[g[1]], hh = g[4] ? 0 : o.hca / 2, ph = sc(g, 0) - lg - hh, pa = sc(g, 1) - lg + hh;
      H.so += ph - A.d; A.sd += ph - H.o; A.so += pa - H.d; H.sd += pa - A.o;
    }
    for (const id in T) { const t = T[id]; t.o = 0.5 * t.o + 0.5 * (t.so + o.k * t.po) / (t.n + o.k); t.d = 0.5 * t.d + 0.5 * (t.sd + o.k * t.pd) / (t.n + o.k); }
  }
  const teams = {};
  for (const id in T) teams[id] = { o: T[id].o, d: T[id].d, n: T[id].n };
  return { lg, teams };
}

// ---------- per-game detail: team box stats, player lines and the closing betting line ----------
const CORE = 'https://sports.core.api.espn.com/v2/sports/';
const num = x => { const v = parseFloat(x); return isFinite(v) ? v : 0; }, pair = x => String(x || '').split(/[-/]/).map(num);
// The closing line from a list of ESPN odds entries: [home spread (negative = home favored), total], or null.
function lineOf(items) {
  for (const it of items || []) {
    if (!it || /live/i.test((it.provider && it.provider.name) || '') || it.spread == null || !it.homeTeamOdds || !it.awayTeamOdds) continue;
    const sp = Math.abs(+it.spread), hf = it.homeTeamOdds.favorite, af = it.awayTeamOdds.favorite;
    if (!isFinite(sp) || (sp > 0 && hf === af)) continue;
    return [hf ? -sp : sp, it.overUnder != null ? +it.overUnder : null];
  }
  return null;
}
// One finished game, compact. { o: [home spread, total] | null, t: [home, away] team stats, p: [home, away] player lines }
//   basketball t: [fgm, fga, 3pm, 3pa, ftm, fta, oreb, turnovers]            p: [id, name, min, pts, fga, fta, tov, reb, ast, stl, blk, starter]
//   football   t: [plays, yards, turnovers, passAtt, passYds, rushAtt, rushYds]  p: { q: [id, name, cmp, att, yds, td, int], r: [id, name, car, yds, td], c: [id, name, rec, yds, td] }
async function gameDetail(L, id) {
  const c = CFG[L], j = await get(SITE + c.sport + '/' + c.key + '/summary?event=' + id);
  if (!j || !j.boxscore) return null;
  const comp = j.header && j.header.competitions && j.header.competitions[0], order = ['home', 'away'].map(s => { const x = comp && comp.competitors.find(k => k.homeAway === s); return x ? String(x.team.id) : null; });
  const out = { o: lineOf(j.pickcenter), t: [null, null], p: [null, null] };
  if (!out.o) { const od = await get(CORE + c.sport + '/leagues/' + c.key + '/events/' + id + '/competitions/' + id + '/odds'); out.o = lineOf(od && od.items); }
  for (const tm of j.boxscore.teams || []) {
    const i = order.indexOf(String(tm.team.id)); if (i < 0) continue;
    const m = {}; for (const s of tm.statistics || []) m[s.name] = s.displayValue;
    if (L === 'ncaab') {
      const fg = pair(m['fieldGoalsMade-fieldGoalsAttempted']), tp = pair(m['threePointFieldGoalsMade-threePointFieldGoalsAttempted']), ft = pair(m['freeThrowsMade-freeThrowsAttempted']);
      if (fg[1] > 0) out.t[i] = [fg[0], fg[1], tp[0], tp[1] || 0, ft[0], ft[1] || 0, num(m.offensiveRebounds), num(m.totalTurnovers != null ? m.totalTurnovers : m.turnovers)];
    } else {
      const ca = pair(m.completionAttempts), ra = num(m.rushingAttempts);
      if (ca[1] + ra > 0) out.t[i] = [ca[1] + ra, num(m.totalYards), num(m.turnovers), ca[1], num(m.netPassingYards), ra, num(m.rushingYards)];
    }
  }
  for (const tm of j.boxscore.players || []) {
    const i = order.indexOf(String(tm.team.id)); if (i < 0) continue;
    if (L === 'ncaab') {
      const st = (tm.statistics || [])[0]; if (!st) continue;
      const ix = k => st.labels.indexOf(k), I = { min: ix('MIN'), pts: ix('PTS'), fg: ix('FG'), ft: ix('FT'), to: ix('TO'), reb: ix('REB'), ast: ix('AST'), stl: ix('STL'), blk: ix('BLK') };
      out.p[i] = st.athletes.filter(a => a.stats && a.stats.length && num(a.stats[I.min]) > 0).map(a => [String(a.athlete.id), a.athlete.displayName, num(a.stats[I.min]), num(a.stats[I.pts]), pair(a.stats[I.fg])[1] || 0, pair(a.stats[I.ft])[1] || 0,
        num(a.stats[I.to]), num(a.stats[I.reb]), num(a.stats[I.ast]), num(a.stats[I.stl]), num(a.stats[I.blk]), a.starter ? 1 : 0]);
    } else {
      const grab = (name, f) => { const st = (tm.statistics || []).find(s => s.name === name); return st ? st.athletes.map(a => [String(a.athlete.id), a.athlete.displayName].concat(f(a.stats, k => num(a.stats[st.labels.indexOf(k)])))) : []; };
      out.p[i] = { q: grab('passing', (s, v) => { const ca = pair(s[0]); return [ca[0], ca[1] || 0, v('YDS'), v('TD'), v('INT')]; }), r: grab('rushing', (s, v) => [v('CAR'), v('YDS'), v('TD')]), c: grab('receiving', (s, v) => [v('REC'), v('YDS'), v('TD')]) };
    }
  }
  return out;
}
// Detail for every game of a finished season, { eventId: detail }, kept in cache/ (not committed). Resumes where it stopped.
async function seasonDetail(L, year, log) {
  const file = path.join(__dirname, 'cache', 'college_' + L + '_' + year + '_detail.json');
  let D = {}; try { D = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { /* first run */ }
  const ids = Object.values(await seasonGames(L, year)).flat().map(g => g[5]).filter(id => id && !(id in D));
  if (!ids.length) return D;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let i = 0; i < ids.length; i += 400) {
    const part = ids.slice(i, i + 400), got = await pool(part, 10, id => gameDetail(L, id));
    part.forEach((id, k) => { if (got[k]) D[id] = got[k]; });
    fs.writeFileSync(file, JSON.stringify(D)); if (log) log(L + ' ' + year + ': ' + Math.min(i + 400, ids.length) + ' / ' + ids.length + ' games');
  }
  return D;
}

// A game row with its luck-adjusted scores appended: [..., eventId, homeAdj, awayAdj]. Without box stats the real score is used.
function gameRow(L, g, d) {
  const c = CFG[L]; let x = g[2], y = g[3]; const t = d && d.t;
  if (t && t[0] && t[1]) {
    if (L === 'ncaaf') { const e = (a, b) => XP[0] + XP[1] * a[1] + XP[2] * a[2] + XP[3] * b[2]; x = (1 - c.yards) * x + c.yards * e(t[0], t[1]); y = (1 - c.yards) * y + c.yards * e(t[1], t[0]); }
    else { x -= 3 * c.three * (t[0][2] - t[0][3] * P3); y -= 3 * c.three * (t[1][2] - t[1][3] * P3); }
  }
  return [g[0], g[1], g[2], g[3], g[4], g[5], Math.round(x * 10) / 10, Math.round(y * 10) / 10];
}
// All games before `day` (yyyymmdd; omit for all) from a { day: [rows] } map, as one list for rate(). Basketball scores are shifted from the scoring
// level around their own date to the level of the last CFG.drift days (levels = average points per team in games between member teams).
function flat(L, days, members, day) {
  const c = CFG[L], keys = Object.keys(days).filter(d => !day || d < day).sort(), all = [];
  if (!c.drift) { for (const d of keys) all.push(...days[d]); return all; }
  const num = d => Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8)) / 86400000, by = {};
  for (const d of keys) { const b = by[num(d)] = [0, 0]; for (const g of days[d]) if (members.has(g[0]) && members.has(g[1])) { b[0] += g[2] + g[3]; b[1] += 2; } }
  const level = end => { let s = 0, n = 0; for (let k = end - c.drift; k < end; k++) if (by[k]) { s += by[k][0]; n += by[k][1]; } return n >= 100 ? s / n : null; };
  const end = day ? num(day) : (keys.length ? num(keys[keys.length - 1]) + 1 : 0), now = level(end), half = c.drift >> 1;
  for (const d of keys) {
    const then = now == null ? null : level(Math.min(end, num(d) + 1 + half)), sh = then == null ? 0 : then - now;
    for (const g of days[d]) all.push(sh ? [g[0], g[1], g[2], g[3], g[4], g[5], (g[6] != null ? g[6] : g[2]) - sh, (g[7] != null ? g[7] : g[3]) - sh] : g);
  }
  return all;
}

// ---------- players: season totals per team from the box scores, and who was missing from a team's last game ----------
// ESPN has no usable college injury report, so absence is read from the box scores: a regular who did not play in his team's last game is
// treated as out for the next one (it holds about two times in three). The costs are in sim.js.
// state: { teamId: { g: games, ... } }
//   basketball p: { athleteId: [name, gp, min, pts, fga, fta, tov, reb, ast, stl, blk, team game number he last played in] }
//   football   q: [name, gp, cmp, att, yds, td, int, team game number he last threw 5+ passes in]   r: [name, car, yds, td]   c: [name, rec, yds, td]
function track(L, state, g, d) {
  if (!d) return;
  [g[0], g[1]].forEach((tid, i) => {
    const line = d.p && d.p[i]; if (!line || (L === 'ncaab' ? !line.length : !line.q || !line.q.length)) return;
    const T = state[tid] = state[tid] || (L === 'ncaab' ? { g: 0, p: {} } : { g: 0, q: {}, r: {}, c: {} });
    T.g++;
    if (L === 'ncaab') for (const p of line) { const a = T.p[p[0]] = T.p[p[0]] || [p[1], 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]; a[1]++; for (let k = 2; k <= 10; k++) a[k] += p[k]; a[11] = T.g; }
    else {
      for (const p of line.q) { if (/^ *team *$/i.test(p[1])) continue; const a = T.q[p[0]] = T.q[p[0]] || [p[1], 0, 0, 0, 0, 0, 0, 0]; a[1]++; for (let k = 2; k <= 6; k++) a[k] += p[k]; if (p[3] >= 5) a[7] = T.g; }
      for (const k of ['r', 'c']) for (const p of line[k] || []) { const a = T[k][p[0]] = T[k][p[0]] || [p[1], 0, 0, 0]; for (let j = 1; j <= 3; j++) a[j] += p[j + 1]; }
    }
  });
}
// A team's players in the shape sim.js reads (close to the NBA / NFL rosters), or null with too little data.
function players(L, T) {
  const r1 = x => Math.round(x * 10) / 10, r3 = x => Math.round(x * 1000) / 1000;
  if (!T || !T.g) return null;
  if (L === 'ncaab') {
    const out = Object.values(T.p).filter(a => a[2] >= 10).sort((x, y) => y[2] - x[2]).slice(0, 11).map(a => {
      const gp = a[1], min = a[2], gs = a[3] + 0.28 * a[7] + 0.7 * a[8] + a[9] + 0.7 * a[10] - 0.7 * a[4] - 0.2 * a[5] - a[6], missed = T.g - a[11], mpg = min / gp, gpr = gp / T.g;
      const p = { name: a[0], min: r1(mpg), pts: r1(a[3] / gp), reb: r1(a[7] / gp), ast: r1(a[8] / gp), gs40: r1(40 * gs / min), gpr: r3(gpr) };
      if (missed > 0 && T.g >= 4 && mpg >= 12 && gpr >= 0.4) { p.out = true; p.note = 'Missed the last ' + (missed > 1 ? missed + ' games' : 'game'); }
      return p;
    });
    return out.length >= 5 ? out : null;
  }
  const qs = Object.values(T.q).filter(a => a[3] > 0 && !/^ *team *$/i.test(a[0])).sort((x, y) => y[3] - x[3]), tot = qs.reduce((s, a) => s + a[3], 0);
  if (!qs.length) return null;
  const qb = qs.slice(0, 3).map((a, i) => {
    const p = { name: a[0], pos: 'QB', att: a[3], cmp: r3(a[2] / a[3]), ypa: r3(a[4] / a[3]), int: r3(a[6] / a[3]), yds: a[4], td: a[5] };
    if (i === 0) { p.base = true; if (tot >= 40 && a[3] / tot >= 0.6 && a[7] < T.g) { p.out = true; p.note = 'Did not play in the last ' + (T.g - a[7] > 1 ? (T.g - a[7]) + ' games' : 'game'); } }
    return p;
  });
  const isTeam = a => /^ *team *$/i.test(a[0]), rbIds = Object.keys(T.r).filter(id => !T.q[id] && !isTeam(T.r[id])).sort((x, y) => T.r[y][1] - T.r[x][1]).slice(0, 4);
  const rb = rbIds.map(id => { const a = T.r[id], c = T.c[id] || [0, 0, 0, 0]; return { name: a[0], pos: 'RB', car: a[1], yds: a[2], tgt: r1(c[1] * 1.4), rec: c[1], ryds: c[2] }; }).filter(p => p.car >= 3);
  const rec = Object.keys(T.c).filter(id => !rbIds.includes(id)).map(id => T.c[id]).filter(a => !isTeam(a)).sort((x, y) => y[2] - x[2]).slice(0, 7).map(a => ({ name: a[0], pos: 'REC', tgt: r1(a[1] * 1.55), rec: a[1], yds: a[2], td: a[3] })).filter(p => p.rec >= 2);
  return { qb, rb, rec };
}

module.exports = { gameRow, flat, track, players, gameDetail, seasonDetail, lineOf, CFG, SITE, get, pool, ymd, seasonOf, seasonDays, dayGames, seasonGames, members, rate };
