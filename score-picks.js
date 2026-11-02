// Fills in final scores for logged games (from ESPN) and writes picks-results.js, the live track record shown in the page.
'use strict';
const fs = require('fs'), path = require('path');
const FILE = path.join(__dirname, 'picks-log.json');
const SPORT = { nba: 'basketball', nfl: 'football', nhl: 'hockey' };
const log = fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, 'utf8')) : {};

async function board(sp, ymd) {
  try {
    const r = await fetch('https://site.api.espn.com/apis/site/v2/sports/' + SPORT[sp] + '/' + sp + '/scoreboard?dates=' + ymd, { signal: AbortSignal.timeout(20000) });
    return r.ok ? (await r.json()).events || [] : [];
  } catch (e) { return []; }
}
const ymdOf = d => d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');

(async () => {
  // group unresolved games by league + day, one request per day
  const need = {};
  for (const e of Object.values(log)) {
    if (e.result || new Date(e.start).getTime() > Date.now() - 4 * 3600e3) continue;
    for (const off of [0, -1]) { const d = new Date(new Date(e.start).getTime() + off * 86400000 - 5 * 3600e3); (need[e.league + '|' + ymdOf(d)] = need[e.league + '|' + ymdOf(d)] || []).push(e); }
  }
  let scored = 0;
  for (const k of Object.keys(need)) {
    const [sp, ymd] = k.split('|');
    const evs = await board(sp, ymd);
    for (const e of need[k]) {
      if (e.result) continue;
      const ev = evs.find(x => x.id === e.gameId);
      if (!ev || !ev.status.type.completed) continue;
      const c = ev.competitions[0], h = c.competitors.find(x => x.homeAway === 'home'), a = c.competitors.find(x => x.homeAway === 'away');
      e.result = { homeScore: +h.score, awayScore: +a.score }; scored++;
    }
  }
  fs.writeFileSync(FILE, JSON.stringify(log, null, 1));

  const out = { generated: new Date().toISOString(), leagues: {} };
  for (const sp of ['nba', 'nfl', 'nhl']) {
    const done = Object.values(log).filter(e => e.league === sp && e.result).sort((x, y) => x.start.localeCompare(y.start));
    const pending = Object.values(log).filter(e => e.league === sp && !e.result).length;
    if (!done.length) { out.leagues[sp] = { n: 0, pending }; continue; }
    const y = e => e.result.homeScore === e.result.awayScore ? 0.5 : e.result.homeScore > e.result.awayScore ? 1 : 0;
    const mean = (arr, f) => arr.length ? +(arr.reduce((a, e) => a + f(e), 0) / arr.length).toFixed(4) : null;
    const M = done.filter(e => e.mkt && e.mkt.pHome != null), T = done.filter(e => e.mkt && e.mkt.total != null);
    const right = (arr, p) => arr.filter(e => y(e) !== 0.5).length ? +(arr.filter(e => y(e) !== 0.5 && (p(e) > 0.5) === (y(e) === 1)).length / arr.filter(e => y(e) !== 0.5).length).toFixed(3) : null;
    const S = done.filter(e => e.mkt && e.mkt.margin != null), tot = e => e.result.homeScore + e.result.awayScore, mar = e => e.result.homeScore - e.result.awayScore;
    const callsT = T.filter(e => Math.abs(e.simTotal - e.mkt.total) >= 2 && tot(e) !== e.mkt.total), callsS = S.filter(e => Math.abs(e.simMargin - e.mkt.margin) >= 2 && mar(e) !== e.mkt.margin);
    const BW = { nfl: 0.15 }[sp], B = BW == null ? [] : M.filter(e => e.blendPHome != null);
    out.leagues[sp] = {
      n: done.length, pending,
      acc: right(done, e => e.simPHome), brier: mean(done, e => (e.simPHome - y(e)) ** 2),
      nMkt: M.length, accSimMkt: right(M, e => e.simPHome), accMkt: right(M, e => e.mkt.pHome),
      brierSimMkt: mean(M, e => (e.simPHome - y(e)) ** 2), brierMkt: mean(M, e => (e.mkt.pHome - y(e)) ** 2),
      nBlend: B.length, brierBlend: mean(B, e => (e.blendPHome - y(e)) ** 2), brierBlendMkt: mean(B, e => (e.mkt.pHome - y(e)) ** 2),
      nSpread: S.length, marMAESim: mean(S, e => Math.abs(e.simMargin - mar(e))), marMAEMkt: mean(S, e => Math.abs(e.mkt.margin - mar(e))),
      totBias: mean(T, e => tot(e) - e.simTotal), mktTotBias: mean(T, e => tot(e) - e.mkt.total),
      nCallT: callsT.length, hitCallT: callsT.length ? +(callsT.filter(e => (e.simTotal > e.mkt.total) === (tot(e) > e.mkt.total)).length / callsT.length).toFixed(3) : null,
      nCallS: callsS.length, hitCallS: callsS.length ? +(callsS.filter(e => (e.simMargin > e.mkt.margin) === (mar(e) > e.mkt.margin)).length / callsS.length).toFixed(3) : null,
      nTot: T.length, totMAESim: mean(T, e => Math.abs(e.simTotal - (e.result.homeScore + e.result.awayScore))), totMAEMkt: mean(T, e => Math.abs(e.mkt.total - (e.result.homeScore + e.result.awayScore))),
      recent: done.slice(-15).reverse().map(e => ({ d: e.start, g: e.away.abbr + ' @ ' + e.home.abbr, p: e.simPHome, mp: e.mkt && e.mkt.pHome, st: e.simTotal, mt: e.mkt && e.mkt.total, hs: e.result.homeScore, as: e.result.awayScore })),
    };
  }
  fs.writeFileSync(path.join(__dirname, 'picks-results.js'), 'window.PICKS = ' + JSON.stringify(out) + ';\n');
  console.log('scored ' + scored + ' newly finished games; ' + Object.values(out.leagues).map((l, i) => ['nba', 'nfl', 'nhl'][i] + ' ' + l.n).join(', ') + ' tracked');
})();
