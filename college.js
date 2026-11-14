// College football (FBS) and men's college basketball (Division I): season results from ESPN and opponent-adjusted team ratings.
// Used by update-data.js (live ratings) and backtest-college.js (walk-forward test).
'use strict';
const fs = require('fs'), path = require('path');

// hca: home edge in points of margin. k: how many games of evidence last season's rating (or the average, for a team without one) is worth.
// carry: share of last season's rating kept as this season's starting point. gap: how far below average a non-member opponent (FCS, non-Division I)
// starts on each side of the ball. start/end: [month, day] the season's games fall between (end is in the following calendar year).
// hca, k and carry were picked on the 2025 seasons with backtest-college.js --fast (nearby values score almost the same). Keep hca equal to NCAAF_HCA / NCAAB_HCA in sim.js.
const CFG = {
  ncaaf: { sport: 'football', key: 'college-football', groups: 80, hca: 3.5, k: 3, carry: 0.8, gap: 12, start: [8, 15], end: [1, 31] },
  ncaab: { sport: 'basketball', key: 'mens-college-basketball', groups: 50, hca: 3.5, k: 5, carry: 0.8, gap: 14, start: [11, 1], end: [4, 15] },
};
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
// One day's finished games as [homeId, awayId, homeScore, awayScore, neutral(0/1)]; null if the request failed.
async function dayGames(L, day) {
  const c = CFG[L], j = await get(SITE + c.sport + '/' + c.key + '/scoreboard?dates=' + day + '&groups=' + c.groups + '&limit=500');
  if (!j) return null;
  const out = [];
  for (const ev of j.events || []) {
    if (!ev.status.type.completed) continue;
    const comp = ev.competitions[0], h = comp.competitors.find(x => x.homeAway === 'home'), a = comp.competitors.find(x => x.homeAway === 'away');
    if (!h || !a || !isFinite(+h.score) || !isFinite(+a.score) || (+h.score === 0 && +a.score === 0)) continue;
    out.push([h.team.id, a.team.id, +h.score, +a.score, comp.neutralSite ? 1 : 0]);
  }
  return out;
}
// A whole finished season, { day: [games] }, kept in cache/ (not committed) so it is only downloaded once.
async function seasonGames(L, year) {
  const file = path.join(__dirname, 'cache', 'college_' + L + '_' + year + '.json');
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
  const T = {}, isM = id => !o.members || o.members.has(id);
  const tm = id => T[id] || (T[id] = (p => ({ n: 0, o: p.o, d: p.d, po: p.o, pd: p.d, so: 0, sd: 0 }))(
    o.prior && o.prior[id] ? { o: o.prior[id].o * o.carry, d: o.prior[id].d * o.carry } : isM(id) ? { o: 0, d: 0 } : { o: -o.gap, d: o.gap }));
  let pts = 0, n = 0;
  for (const g of games) { tm(g[0]).n++; tm(g[1]).n++; if (isM(g[0]) && isM(g[1])) { pts += g[2] + g[3]; n += 2; } }
  const lg = n >= 40 ? pts / n : o.lg;
  for (let it = 0; it < 60; it++) {
    for (const id in T) { T[id].so = 0; T[id].sd = 0; }
    for (const g of games) {
      const H = T[g[0]], A = T[g[1]], hh = g[4] ? 0 : o.hca / 2, ph = g[2] - lg - hh, pa = g[3] - lg + hh;
      H.so += ph - A.d; A.sd += ph - H.o; A.so += pa - H.d; H.sd += pa - A.o;
    }
    for (const id in T) { const t = T[id]; t.o = 0.5 * t.o + 0.5 * (t.so + o.k * t.po) / (t.n + o.k); t.d = 0.5 * t.d + 0.5 * (t.sd + o.k * t.pd) / (t.n + o.k); }
  }
  const teams = {};
  for (const id in T) teams[id] = { o: T[id].o, d: T[id].d, n: T[id].n };
  return { lg, teams };
}

module.exports = { CFG, SITE, get, pool, ymd, seasonOf, seasonDays, dayGames, seasonGames, members, rate };
