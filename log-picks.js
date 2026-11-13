// Simulates every upcoming game in data.js and saves a snapshot of the sim vs. the market to picks-log.json.
// Re-running before a game starts overwrites that game's snapshot, so the last pre-game run is the one scored.
'use strict';
const fs = require('fs'), path = require('path');
global.window = global;
const Sim = require('./sim.js');
const Travel = require('./travel.js');
require('./data.js');
try { require('./backtest-results.js'); } catch (e) { /* optional */ }
Sim.applyLive(window.LIVE_DATA);

const FILE = path.join(__dirname, 'picks-log.json');
const SIMS = 2000, SD = { nba: 12.0, nfl: 13.2 };
const norm = x => String(x).toLowerCase().replace(/[^a-z]/g, '');
const imp = ml => ml < 0 ? -ml / (-ml + 100) : 100 / (ml + 100);
const cdf = z => 0.5 * (1 + Math.sign(z) * Math.sqrt(1 - Math.exp(-4 * (z / Math.SQRT2) ** 2 / Math.PI)));   // standard normal CDF (erf approximation)

function findTeam(sp, side) {
  const T = Sim.SPORTS[sp].teams;
  return T.find(t => norm(t.name) === norm(side.name)) || T.find(t => t.id === side.abbr);
}
function market(sp, g) {
  const m = { line: g.line || null, total: g.total || null, pHome: null, margin: null };
  if (g.homeML != null && g.awayML != null) { const ph = imp(g.homeML), pa = imp(g.awayML); m.pHome = ph / (ph + pa); }
  const r = g.line && /^(\S+)\s+([+-]?\d+(?:\.\d+)?)$/.exec(g.line);
  if (r) {
    const fav = r[1], v = parseFloat(r[2]), isHome = fav === g.home.abbr;
    if (Math.abs(v) >= 100) { if (m.pHome == null) { const p = imp(v) / 1.045; m.pHome = isHome ? p : 1 - p; } }   // single-sided moneyline: remove a typical ~4.5% overround
    else { m.margin = isHome ? -v : v; if (m.pHome == null && SD[sp]) m.pHome = cdf(m.margin / SD[sp]); }
  }
  return m;
}
const BLEND = { nfl: 0.15 };   // sim weight in the sim/market blend (nfl backtests: best weight 0% in 2024, 25% in 2025)
// every refresh that sees a different market appends a snapshot, so we keep opening-to-closing line movement for free
function lineHistory(prev, mk) {
  const h = (prev && prev.lines) || [], last = h[h.length - 1], now = { t: new Date().toISOString(), pHome: mk.pHome != null ? +mk.pHome.toFixed(4) : null, margin: mk.margin, total: mk.total };
  if (!last || last.pHome !== now.pHome || last.margin !== now.margin || last.total !== now.total) h.push(now);
  return h.slice(-40);
}
function stretch(sp) { const b = window.BACKTEST && window.BACKTEST.leagues && window.BACKTEST.leagues[sp]; return (b && b.stretch) || 1; }

const log = fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, 'utf8')) : {};
const rng = Sim.makeRng((Date.now() & 0xffffffff) >>> 0);
let added = 0, updated = 0;
for (const sp of ['nba', 'nfl', 'nhl']) {
  const sched = (window.LIVE_DATA.schedule && window.LIVE_DATA.schedule[sp]) || [];
  const a = stretch(sp);
  for (const g of sched) {
    if (new Date(g.date).getTime() <= Date.now()) continue;           // already started
    const away = findTeam(sp, g.away), home = findTeam(sp, g.home);
    if (!away || !home) continue;
    if (sp === 'nhl') [[away, g.away], [home, g.home]].forEach(([t, s]) => {
      const R = Sim.roster('nhl', t); t.gIdx = -1; if (!R.goalies) return;
      const c = Sim.matchGoalie(R.goalies, s.confirmed); if (c >= 0) { t.gIdx = c; return; }
      if (s.probable) { const i = R.goalies.findIndex(x => x.name === s.probable); if (i >= 0) t.gIdx = i; }
    });
    const m = Sim.monteCarlo(sp, away, home, SIMS, rng, { rest: { away: g.awayRest, home: g.homeRest } });
    const raw = (m.wins[1] + m.wins[2] / 2) / m.n;
    const z = Math.log(Math.min(0.999, Math.max(0.001, raw)) / (1 - Math.min(0.999, Math.max(0.001, raw))));
    const mk = market(sp, g), key = sp + ':' + g.id;
    const prev = log[key];
    log[key] = {
      key, league: sp, gameId: g.id, start: g.date, away: { abbr: g.away.abbr, name: g.away.name }, home: { abbr: g.home.abbr, name: g.home.name },
      goalies: sp === 'nhl' ? [g.away.confirmed || g.away.probable, g.home.confirmed || g.home.probable] : undefined, goalieConfirmed: sp === 'nhl' ? [!!g.away.confirmed, !!g.home.confirmed] : undefined, rest: [g.awayRest, g.homeRest],
      simPHome: +(1 / (1 + Math.exp(-a * z))).toFixed(4), rawPHome: +raw.toFixed(4), simMargin: +(m.avg[1] - m.avg[0]).toFixed(2), simScore: [+m.avg[0].toFixed(2), +m.avg[1].toFixed(2)], simTotal: +m.avgTotal.toFixed(2),
      blendPHome: BLEND[sp] != null && mk.pHome != null ? +(BLEND[sp] * (1 / (1 + Math.exp(-a * z))) + (1 - BLEND[sp]) * mk.pHome).toFixed(4) : undefined,
      inj: [Sim.injuries(sp, away), Sim.injuries(sp, home)],
      lines: lineHistory(prev, mk),
      travel: [[g.awayFrom, g.home.abbr], [g.homeFrom, g.home.abbr]].map(([f, to]) => f && f !== to ? { from: f, miles: Math.round(Travel.miles(sp, f, to) || 0), tz: Travel.tzShift(sp, f, to) } : null),
      mkt: mk, loggedAt: new Date().toISOString(), result: prev ? prev.result : null,
    };
    prev ? updated++ : added++;
  }
}
fs.writeFileSync(FILE, JSON.stringify(log, null, 1));
console.log('picks logged: ' + added + ' new, ' + updated + ' refreshed, ' + Object.keys(log).length + ' total');
