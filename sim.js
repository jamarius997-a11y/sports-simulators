// Sports simulators: NBA (possession-based), MLB (plate-appearance), NHL (minute/shot-based).
// Team ratings are illustrative approximations and are editable in the UI.
(function (root) {
  'use strict';

  // ---------- utilities ----------
  function makeRng(seed) {
    let a = (seed >>> 0) || 1;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function poisson(l, rng) {
    const L = Math.exp(-l); let k = 0, p = 1;
    do { k++; p *= rng(); } while (p > L);
    return k - 1;
  }
  function normal(rng) { return Math.sqrt(-2 * Math.log(1 - rng())) * Math.cos(2 * Math.PI * rng()); }
  const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
  // Chance a player with an uncertain injury designation does not play (a hard "Out" always sits).
  const SIT = { doubtful: 0.75, questionable: 0.4, 'day-to-day': 0.3, probable: 0.05 };
  function sits(p, rng) {
    if (p.out) return true;
    if (!p.note || !rng) return false;
    const n = p.note.toLowerCase();
    for (const k in SIT) if (n.includes(k)) return rng() < SIT[k];
    return false;
  }

  // ---------- teams ----------
  const NBA_TEAMS = [
    ['ATL', 'Atlanta Hawks', 115, 116], ['BOS', 'Boston Celtics', 118, 112], ['BKN', 'Brooklyn Nets', 109, 118],
    ['CHA', 'Charlotte Hornets', 111, 116], ['CHI', 'Chicago Bulls', 113, 117], ['CLE', 'Cleveland Cavaliers', 119, 112],
    ['DAL', 'Dallas Mavericks', 114, 114], ['DEN', 'Denver Nuggets', 120, 115], ['DET', 'Detroit Pistons', 114, 113],
    ['GSW', 'Golden State Warriors', 114, 112], ['HOU', 'Houston Rockets', 114, 111], ['IND', 'Indiana Pacers', 118, 116],
    ['LAC', 'LA Clippers', 114, 113], ['LAL', 'Los Angeles Lakers', 116, 115], ['MEM', 'Memphis Grizzlies', 118, 115],
    ['MIA', 'Miami Heat', 113, 114], ['MIL', 'Milwaukee Bucks', 114, 114], ['MIN', 'Minnesota Timberwolves', 115, 111],
    ['NOP', 'New Orleans Pelicans', 111, 117], ['NYK', 'New York Knicks', 118, 113], ['OKC', 'Oklahoma City Thunder', 120, 108],
    ['ORL', 'Orlando Magic', 108, 111], ['PHI', 'Philadelphia 76ers', 112, 115], ['PHX', 'Phoenix Suns', 113, 116],
    ['POR', 'Portland Trail Blazers', 110, 115], ['SAC', 'Sacramento Kings', 114, 116], ['SAS', 'San Antonio Spurs', 113, 114],
    ['TOR', 'Toronto Raptors', 114, 114], ['UTA', 'Utah Jazz', 112, 120], ['WAS', 'Washington Wizards', 108, 120],
  ].map(t => ({ id: t[0], name: t[1], off: t[2], def: t[3] }));

  const MLB_TEAMS = [
    ['ARI', 'Arizona Diamondbacks', 5.0, 4.8], ['ATH', 'Athletics', 4.5, 4.8], ['ATL', 'Atlanta Braves', 4.3, 3.9],
    ['BAL', 'Baltimore Orioles', 4.4, 4.5], ['BOS', 'Boston Red Sox', 4.7, 4.2], ['CHC', 'Chicago Cubs', 4.8, 4.0],
    ['CWS', 'Chicago White Sox', 3.5, 5.3], ['CIN', 'Cincinnati Reds', 4.3, 4.1], ['CLE', 'Cleveland Guardians', 4.2, 3.9],
    ['COL', 'Colorado Rockies', 3.9, 5.7], ['DET', 'Detroit Tigers', 4.5, 3.9], ['HOU', 'Houston Astros', 4.4, 3.9],
    ['KC', 'Kansas City Royals', 4.0, 3.9], ['LAA', 'Los Angeles Angels', 4.1, 4.8], ['LAD', 'Los Angeles Dodgers', 5.2, 3.9],
    ['MIA', 'Miami Marlins', 4.1, 4.8], ['MIL', 'Milwaukee Brewers', 4.7, 3.9], ['MIN', 'Minnesota Twins', 4.1, 4.2],
    ['NYM', 'New York Mets', 4.7, 4.2], ['NYY', 'New York Yankees', 5.0, 4.1], ['PHI', 'Philadelphia Phillies', 4.7, 4.1],
    ['PIT', 'Pittsburgh Pirates', 3.6, 4.1], ['SD', 'San Diego Padres', 4.4, 3.9], ['SF', 'San Francisco Giants', 4.0, 4.1],
    ['SEA', 'Seattle Mariners', 4.6, 3.9], ['STL', 'St. Louis Cardinals', 4.0, 4.4], ['TB', 'Tampa Bay Rays', 4.2, 4.0],
    ['TEX', 'Texas Rangers', 4.1, 3.9], ['TOR', 'Toronto Blue Jays', 4.6, 4.2], ['WSH', 'Washington Nationals', 4.1, 5.0],
  ].map(t => ({ id: t[0], name: t[1], rs: t[2], ra: t[3] }));

  const NHL_TEAMS = [
    ['ANA', 'Anaheim Ducks', 3.0, 3.5], ['BOS', 'Boston Bruins', 2.8, 3.2], ['BUF', 'Buffalo Sabres', 3.0, 3.1],
    ['CGY', 'Calgary Flames', 2.8, 3.0], ['CAR', 'Carolina Hurricanes', 3.3, 2.7], ['CHI', 'Chicago Blackhawks', 2.6, 3.4],
    ['COL', 'Colorado Avalanche', 3.4, 3.1], ['CBJ', 'Columbus Blue Jackets', 3.1, 3.3], ['DAL', 'Dallas Stars', 3.2, 2.7],
    ['DET', 'Detroit Red Wings', 3.0, 3.2], ['EDM', 'Edmonton Oilers', 3.2, 2.9], ['FLA', 'Florida Panthers', 3.2, 2.8],
    ['LAK', 'Los Angeles Kings', 2.9, 2.7], ['MIN', 'Minnesota Wild', 3.0, 2.9], ['MTL', 'Montreal Canadiens', 3.0, 3.2],
    ['NSH', 'Nashville Predators', 2.8, 3.2], ['NJD', 'New Jersey Devils', 3.1, 2.9], ['NYI', 'New York Islanders', 2.7, 2.9],
    ['NYR', 'New York Rangers', 2.9, 3.0], ['OTT', 'Ottawa Senators', 3.1, 3.0], ['PHI', 'Philadelphia Flyers', 2.8, 3.1],
    ['PIT', 'Pittsburgh Penguins', 3.0, 3.2], ['SJS', 'San Jose Sharks', 2.7, 3.6], ['SEA', 'Seattle Kraken', 2.9, 3.3],
    ['STL', 'St. Louis Blues', 2.8, 3.1], ['TBL', 'Tampa Bay Lightning', 3.4, 2.8], ['TOR', 'Toronto Maple Leafs', 3.2, 3.0],
    ['UTA', 'Utah Mammoth', 3.0, 3.0], ['VAN', 'Vancouver Canucks', 2.9, 3.0], ['VGK', 'Vegas Golden Knights', 3.2, 2.7],
    ['WSH', 'Washington Capitals', 3.2, 2.8], ['WPG', 'Winnipeg Jets', 3.3, 2.5],
  ].map(t => ({ id: t[0], name: t[1], gf: t[2], ga: t[3] }));

  const NFL_TEAMS = [['ARI','Arizona Cardinals'],['ATL','Atlanta Falcons'],['BAL','Baltimore Ravens'],['BUF','Buffalo Bills'],['CAR','Carolina Panthers'],['CHI','Chicago Bears'],['CIN','Cincinnati Bengals'],['CLE','Cleveland Browns'],['DAL','Dallas Cowboys'],['DEN','Denver Broncos'],['DET','Detroit Lions'],['GB','Green Bay Packers'],['HOU','Houston Texans'],['IND','Indianapolis Colts'],['JAX','Jacksonville Jaguars'],['KC','Kansas City Chiefs'],['LV','Las Vegas Raiders'],['LAC','Los Angeles Chargers'],['LAR','Los Angeles Rams'],['MIA','Miami Dolphins'],['MIN','Minnesota Vikings'],['NE','New England Patriots'],['NO','New Orleans Saints'],['NYG','New York Giants'],['NYJ','New York Jets'],['PHI','Philadelphia Eagles'],['PIT','Pittsburgh Steelers'],['SF','San Francisco 49ers'],['SEA','Seattle Seahawks'],['TB','Tampa Bay Buccaneers'],['TEN','Tennessee Titans'],['WSH','Washington Commanders']].map(t => ({ id: t[0], name: t[1], pf: 22.5, pa: 22.5 }));

  // =====================================================================
  // Rosters (generated placeholders: names are random, ratings are editable)
  // =====================================================================
  const FIRST = ['Jalen', 'Marcus', 'Devin', 'Tyrese', 'Cole', 'Ian', 'Mateo', 'Noah', 'Eli', 'Reggie', 'Dario', 'Kofi', 'Luka', 'Andre', 'Theo', 'Caleb', 'Jonas', 'Rafael', 'Silas', 'Omar', 'Brandon', 'Wes', 'Tomas', 'Gabe', 'Isaiah', 'Declan', 'Victor', 'Hank', 'Leo', 'Darius'];
  const LAST = ['Brooks', 'Whitfield', 'Okafor', 'Delgado', 'Navarro', 'Hartley', 'Sutton', 'Ramires', 'Kowalski', 'Ellison', 'Park', 'Maddox', 'Fontaine', 'Baptiste', 'Lindqvist', 'Ortega', 'Pruitt', 'Haas', 'Tanaka', 'Quinn', 'Mercer', 'Voss', 'Abara', 'Castillo', 'Dunmore', 'Reyes', 'Sloane', 'Ibarra', 'Novak', 'Gallo'];
  function hashStr(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

  function genRoster(sport, team) {
    const r = makeRng(hashStr(sport + team.id)), used = new Set();
    const name = () => { for (;;) { const n = FIRST[Math.floor(r() * FIRST.length)] + ' ' + LAST[Math.floor(r() * LAST.length)]; if (!used.has(n)) { used.add(n); return n; } } };
    const jit = (v, s) => Math.round(v * (1 + (r() - 0.5) * s) * 10) / 10;
    if (sport === 'nba') {
      const pos = ['PG', 'SF', 'C', 'SG', 'PF', 'PG', 'SF', 'C', 'SG', 'PF'];
      const usage = [26, 22, 19, 16, 13, 10, 8, 7, 5, 4], min = [36, 34, 32, 30, 28, 24, 20, 16, 12, 8];
      const rebw = { PG: 0.6, SG: 0.7, SF: 1, PF: 1.5, C: 2 }, astw = { PG: 2.2, SG: 1.3, SF: 1, PF: 0.7, C: 0.6 };
      return { players: usage.map((u, i) => ({ name: name(), pos: pos[i], usage: jit(u, 0.2), min: min[i], reb: rebw[pos[i]], ast: astw[pos[i]] })) };
    }
    if (sport === 'mlb') {
      const pos = ['CF', 'SS', 'RF', '1B', 'DH', '3B', 'LF', '2B', 'C'], bat = [112, 108, 110, 106, 100, 96, 94, 92, 88];
      const adj = [-0.5, -0.25, 0, 0.25, 0.5];
      for (let i = adj.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [adj[i], adj[j]] = [adj[j], adj[i]]; }
      return { lineup: bat.map((b, i) => ({ name: name(), pos: pos[i], bat: Math.round(jit(b, 0.1)) })), rotation: adj.map(a => ({ name: name(), adj: a })) };
    }
    if (sport === 'nfl') {
      const rcv = [['WR', 120], ['WR', 95], ['WR', 70], ['TE', 75], ['WR', 35]];
      return { qb: [{ name: name(), pos: 'QB', base: true, att: 500, ypa: 6.9, cmp: 0.645, int: 0.022 }],
        rb: [200, 100, 50].map(c => ({ name: name(), pos: 'RB', car: c, ypc: 4.3, tgt: c / 5, rec: c / 7 })),
        rec: rcv.map(x => ({ name: name(), pos: x[0], tgt: x[1], rec: x[1] * 0.65, yds: x[1] * 7.5, td: 0 })) };
    }
    const fw = [14, 12, 11, 9, 8, 7, 6, 5, 4, 3, 3, 2], dw = [4, 3, 2.5, 2, 1.5, 1], fp = ['C', 'LW', 'RW'];
    return { fwd: fw.map((w, i) => ({ name: name(), pos: fp[i % 3], w: jit(w, 0.2) })), def: dw.map(w => ({ name: name(), pos: 'D', w: jit(w, 0.2) })), g: { name: name() }, goalies: null, svAvg: 0.905 };
  }
  function roster(sport, team) { return team.roster || (team.roster = genRoster(sport, team)); }

  // =====================================================================
  // NBA
  // =====================================================================
  let NBA_LG = 114;        // league-average points per game (set from live data)
  const NBA_TOV = 0.125, NBA_FT = 0.12, NBA_OREB = 0.25, NBA_3SHARE = 0.40, NBA_FTPCT = 0.78;

  // Expected points per possession as a function of a shooting shift d.
  function nbaEV(d) {
    const p3 = 0.355 + d, p2 = 0.545 + 1.5 * d;
    const e = NBA_3SHARE * 3 * p3 + (1 - NBA_3SHARE) * 2 * p2;
    const miss = 1 - (NBA_3SHARE * p3 + (1 - NBA_3SHARE) * p2);
    const chain = e / (1 - miss * NBA_OREB);
    return (1 - NBA_TOV - NBA_FT) * chain + NBA_FT * 2 * NBA_FTPCT;
  }
  function nbaOffense(team, opp, adj) {
    const target = (team.off + opp.def - NBA_LG + adj) / 100.3;
    let lo = -0.25, hi = 0.25;
    for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2; if (nbaEV(m) < target) lo = m; else hi = m; }
    const d = (lo + hi) / 2;
    return { p3: clamp(0.355 + d, 0.15, 0.7), p2: clamp(0.545 + 1.5 * d, 0.25, 0.8) };
  }
  // Per-player shooting shift; usage-and-minutes-weighted mean is zero so team totals stay calibrated.
  function nbaPrep(team, rng) {
    const all = roster('nba', team).players;
    const gone = new Set(all.filter(p => sits(p, rng)));
    let act = all.filter(p => !gone.has(p)).sort((a, b) => b.min - a.min).slice(0, 10);
    if (act.length < 8) act = all.slice().sort((a, b) => b.min - a.min).slice(0, 8);
    const k = 240 / (act.reduce((a, p) => a + p.min, 0) || 240);
    const P = act.map(p => Object.assign({}, p, { min: Math.min(40, p.min * k) }));
    let sw = 0, su = 0, st = 0;
    P.forEach(p => { const w = p.usage * p.min; sw += w; su += w * p.usage; st += w * (p.ts || 0.56); });
    const mu = sw ? su / sw : 0, tmu = sw ? st / sw : 0.56;
    const res = P.map(p => ({ p, delta: clamp(0.04 * (p.usage - mu) / 10 + (p.ts ? 0.6 * (p.ts - tmu) : 0), -0.08, 0.08) }));
    res.outNames = all.filter(p => gone.has(p)).map(p => p.name);
    // Missing players: 0.3 points of margin per unit of (Game Score per 36 - 9) x (minutes / 36). Fit on NBA Stats game logs, 2024-25 and
    // 2025-26: absences of recent rotation players vs the sim's misses gave 0.26 and 0.35, and this beat the old points-per-36 rule and
    // on/off plus-minus when fit on one season and tested on the other. Split 65% to the team's own scoring, 35% to its defense.
    const NBA_ABS = 0.3;
    const loss = all.filter(p => gone.has(p)).reduce((a, p) => {
      const g = p.gpr == null ? 1 : p.gpr;
      if (p.gs36 != null) return a + NBA_ABS * g * (p.min / 36) * Math.max(0, p.gs36 - 9);
      return a + g * (p.min / 36) * (0.3 * Math.max(0, (p.pts36 || 12) - 12) + 0.5 * Math.max(0, (p.stk == null ? 1.6 : p.stk) - 1.6));   // old rule (data without gs36)
    }, 0);
    res.pen = Math.min(6, 0.65 * loss); res.defLoss = Math.min(3, 0.35 * loss);
    return res;
  }

  const NBA_B2B = 1.0;    // points per 100 lost by a team on the second night of a back-to-back (backtest: ~2 pts of margin)
  function nbaGame(away, home, rng, opts) {
    opts = opts || {};
    const teams = [away, home];
    const R = [nbaPrep(away, rng), nbaPrep(home, rng)];
    const rest = opts.rest || {}, ab = rest.away === 0 ? 1 : 0, hb = rest.home === 0 ? 1 : 0;
    const off = [nbaOffense(away, home, -1.0 - R[0].pen + R[1].defLoss - NBA_B2B * ab + NBA_B2B * hb), nbaOffense(home, away, 1.0 - R[1].pen + R[0].defLoss - NBA_B2B * hb + NBA_B2B * ab)];
    const pace = clamp(99 + normal(rng) * 2.2, 90, 108);
    const ps = R.map(r => r.map(() => ({ pts: 0, fgm: 0, fga: 0, tpm: 0, tpa: 0, ftm: 0, fta: 0, reb: 0, ast: 0, tov: 0, min: 0 })));
    const st = [0, 1].map(() => ({ fgm: 0, fga: 0, tpm: 0, tpa: 0, ftm: 0, fta: 0, tov: 0, reb: 0 }));
    const score = [0, 0], periods = [[], []];
    let leadChanges = 0, lastLeader = -1, maxLead = [0, 0], runTeam = -1, runPts = 0, bestRun = [0, 0];
    let L = [[], []];

    function pick(pool, w) {
      let tot = 0; for (const j of pool) tot += w(j);
      let r = rng() * tot;
      for (const j of pool) { r -= w(j); if (r <= 0) return j; }
      return pool[pool.length - 1];
    }
    function lineup(i) {
      const pool = R[i].map((_, j) => j), out = [];
      for (let k = 0; k < 5; k++) { const j = pick(pool, x => R[i][x].p.min); out.push(j); pool.splice(pool.indexOf(j), 1); }
      return out;
    }

    function possession(i) {
      const o = off[i], s = st[i], d = st[1 - i], on = L[i], dn = L[1 - i], P = ps[i], D = ps[1 - i];
      const usage = j => R[i][j].p.usage, defReb = j => R[1 - i][j].p.reb, offReb = j => R[i][j].p.reb;
      const r = rng();
      let sh = pick(on, usage);
      if (r < NBA_TOV) { s.tov++; P[sh].tov++; return 0; }
      if (r < NBA_TOV + NBA_FT) {
        let pts = 0; s.fta += 2; P[sh].fta += 2;
        for (let k = 0; k < 2; k++) if (rng() < NBA_FTPCT) { pts++; s.ftm++; P[sh].ftm++; }
        P[sh].pts += pts;
        if (pts < 2 && rng() < 0.12) { d.reb++; D[pick(dn, defReb)].reb++; }
        return pts;
      }
      let pts = 0;
      for (;;) {
        const three = rng() < NBA_3SHARE;
        s.fga++; P[sh].fga++; if (three) { s.tpa++; P[sh].tpa++; }
        const pm = clamp((three ? o.p3 : o.p2) + R[i][sh].delta, 0.05, 0.9);
        if (rng() < pm) {
          s.fgm++; P[sh].fgm++; if (three) { s.tpm++; P[sh].tpm++; }
          pts += three ? 3 : 2;
          if (rng() < 0.6) { const a = pick(on.filter(x => x !== sh), j => R[i][j].p.ast); P[a].ast++; }
          if (rng() < 0.04) { s.fta++; P[sh].fta++; if (rng() < NBA_FTPCT) { s.ftm++; P[sh].ftm++; pts++; } }
          P[sh].pts += pts;
          return pts;
        }
        if (rng() < NBA_OREB) { s.reb++; sh = pick(on, offReb); P[sh].reb++; continue; }
        d.reb++; D[pick(dn, defReb)].reb++; return pts;
      }
    }

    let period = 0;
    for (;;) {
      period++;
      const reg = period <= 4;
      const n = reg ? Math.max(18, Math.round(pace / 4 + normal(rng))) : Math.max(7, Math.round(pace / 48 * 5 + normal(rng) * 0.7));
      const chunks = reg ? 2 : 1, chunkMin = reg ? 6 : 2.5;
      const start = score.slice();
      let done = 0;
      for (let c = 0; c < chunks; c++) {
        L = [lineup(0), lineup(1)];
        for (let i = 0; i < 2; i++) for (const j of L[i]) ps[i][j].min += chunkMin;
        const nc = c === chunks - 1 ? n - done : Math.floor(n / chunks);
        done += nc;
        for (let k = 0; k < nc; k++) {
          for (let i = 0; i < 2; i++) {
            const pts = possession(i);
            score[i] += pts;
            if (pts) {
              if (runTeam === i) runPts += pts; else { runTeam = i; runPts = pts; }
              bestRun[i] = Math.max(bestRun[i], runPts);
            }
            const leader = score[0] > score[1] ? 0 : score[1] > score[0] ? 1 : -1;
            if (leader !== -1) {
              if (lastLeader !== -1 && leader !== lastLeader) leadChanges++;
              lastLeader = leader;
              maxLead[leader] = Math.max(maxLead[leader], Math.abs(score[0] - score[1]));
            }
          }
        }
      }
      periods[0].push(score[0] - start[0]); periods[1].push(score[1] - start[1]);
      if (period >= 4 && score[0] !== score[1]) break;
      if (period > 12) { score[rng() < 0.5 ? 0 : 1]++; break; }
    }

    const names = period <= 4 ? ['Q1', 'Q2', 'Q3', 'Q4'] : ['Q1', 'Q2', 'Q3', 'Q4'].concat(Array.from({ length: period - 4 }, (_, k) => k ? 'OT' + (k + 1) : 'OT'));
    const pct = (m, a) => a ? (100 * m / a).toFixed(1) + '%' : '-';
    const winner = score[0] > score[1] ? 0 : 1;
    const cum = [0, 0];
    const log = periods[0].map((_, k) => {
      cum[0] += periods[0][k]; cum[1] += periods[1][k];
      return names[k] + ' final: ' + away.id + ' ' + cum[0] + ' – ' + home.id + ' ' + cum[1];
    });
    log.push('Lead changes: ' + leadChanges + ' · Largest lead: ' + away.id + ' ' + maxLead[0] + ', ' + home.id + ' ' + maxLead[1]);
    log.push('Biggest scoring run: ' + away.id + ' ' + bestRun[0] + '-0, ' + home.id + ' ' + bestRun[1] + '-0');
    let tables;
    if (opts.detail) {
      tables = [0, 1].map(i => [{
        title: 'Box score',
        headers: ['Player', 'MIN', 'PTS', 'REB', 'AST', 'FG', '3P', 'FT', 'TO'],
        rows: R[i].map((x, j) => [x.p.name + ' (' + x.p.pos + ')', Math.round(ps[i][j].min), ps[i][j].pts, ps[i][j].reb, ps[i][j].ast,
          ps[i][j].fgm + '-' + ps[i][j].fga, ps[i][j].tpm + '-' + ps[i][j].tpa, ps[i][j].ftm + '-' + ps[i][j].fta, ps[i][j].tov])
          .filter((_, j) => ps[i][j].min > 0).sort((a, b) => b[1] - a[1]),
      }]);
      let top = null;
      for (let i = 0; i < 2; i++) R[i].forEach((x, j) => { if (!top || ps[i][j].pts > top.pts) top = { pts: ps[i][j].pts, name: x.p.name, t: teams[i].id }; });
      [0, 1].forEach(i => { if (R[i].outNames.length) log.push('Out – ' + teams[i].id + ': ' + R[i].outNames.join(', ')); });
      log.push('Top scorer: ' + top.name + ' (' + top.t + ') ' + top.pts + ' pts');
    }
    return {
      sport: 'nba', teams, score, winner, extra: period > 4, extraLabel: period > 4 ? names[period - 1] : '',
      line: { headers: names.concat(['T']), rows: [0, 1].map(i => periods[i].concat([score[i]])) },
      box: [
        ['FG', st[0].fgm + '-' + st[0].fga, st[1].fgm + '-' + st[1].fga],
        ['FG%', pct(st[0].fgm, st[0].fga), pct(st[1].fgm, st[1].fga)],
        ['3P', st[0].tpm + '-' + st[0].tpa, st[1].tpm + '-' + st[1].tpa],
        ['FT', st[0].ftm + '-' + st[0].fta, st[1].ftm + '-' + st[1].fta],
        ['Rebounds', st[0].reb, st[1].reb],
        ['Turnovers', st[0].tov, st[1].tov],
      ],
      tables, log,
    };
  }

  // =====================================================================
  // MLB
  // =====================================================================
  const MLB_LG = 4.6, MLB_S = 0.6;
  const MLB_BASE = { K: 0.225, BB: 0.090, HBP: 0.010, '1B': 0.158, '2B': 0.048, '3B': 0.004, HR: 0.033 };
  const MLB_EXP = { K: -0.4, BB: 0.5, HBP: 0, '1B': 0.6, '2B': 0.8, '3B': 0.8, HR: 1.2 };

  function mlbProbs(rs, ra) {
    const f = (rs / MLB_LG) * (ra / MLB_LG);
    const out = []; let sum = 0;
    for (const k in MLB_BASE) { const p = MLB_BASE[k] * Math.pow(f, MLB_EXP[k] * MLB_S); out.push([k, p]); sum += p; }
    out.push(['OUT', Math.max(0.15, 1 - sum)]);
    const tot = out.reduce((a, x) => a + x[1], 0);
    return out.map(x => [x[0], x[1] / tot]);
  }

  // One half-inning. probs[slot] = PA probabilities for each lineup slot; bs[slot] = batter stat lines.
  function mlbHalf(probs, bs, slot, rng, ghost, runsToWin) {
    let outs = 0, runs = 0, hits = 0, bb = 0, k = 0, hr = 0;
    let b = [-1, ghost ? (slot + 8) % 9 : -1, -1];
    const plays = [];
    while (outs < 3) {
      const bt = slot, S = bs[bt];
      let r = rng(), ev = 'OUT';
      for (const [name, p] of probs[bt]) { if (r < p) { ev = name; break; } r -= p; }
      const sc = []; let nb = b, label = '', rbi = true;
      S.pa++;
      if (ev === 'K') { outs++; k++; S.k++; S.ab++; }
      else if (ev === 'OUT') {
        if (b[0] >= 0 && outs < 2 && rng() < 0.13) {
          S.ab++; outs += 2; rbi = false; if (outs < 3 && b[2] >= 0) sc.push(b[2]);
          nb = [-1, -1, outs < 3 ? b[1] : -1]; label = 'Double play';
        } else {
          outs++; nb = b.slice();
          if (outs < 3 && b[2] >= 0 && rng() < 0.30) { sc.push(b[2]); nb[2] = -1; label = 'Sacrifice fly'; }
          else { S.ab++; if (outs < 3 && rng() < 0.2) { if (b[2] >= 0) sc.push(b[2]); nb = [-1, b[0], b[1]]; label = 'Groundout, runners advance'; } }
        }
      }
      else if (ev === 'BB' || ev === 'HBP') {
        bb++; S.bb++; nb = b.slice();
        if (b[0] >= 0) { if (b[1] >= 0) { if (b[2] >= 0) sc.push(b[2]); nb[2] = b[1]; } nb[1] = b[0]; }
        nb[0] = bt; label = ev === 'BB' ? 'Bases-loaded walk' : 'Hit by pitch, run forced in';
      }
      else if (ev === '1B') {
        hits++; S.h++; S.ab++; nb = [bt, -1, -1]; if (b[2] >= 0) sc.push(b[2]);
        if (b[1] >= 0) { if (rng() < 0.55) sc.push(b[1]); else nb[2] = b[1]; }
        if (b[0] >= 0) { if (nb[2] < 0 && rng() < 0.25) nb[2] = b[0]; else nb[1] = b[0]; }
        label = 'Single';
      }
      else if (ev === '2B') {
        hits++; S.h++; S.ab++; nb = [-1, bt, -1]; if (b[2] >= 0) sc.push(b[2]); if (b[1] >= 0) sc.push(b[1]);
        if (b[0] >= 0) { if (rng() < 0.4) sc.push(b[0]); else nb[2] = b[0]; }
        label = 'Double';
      }
      else if (ev === '3B') { hits++; S.h++; S.ab++; for (const x of b) if (x >= 0) sc.push(x); nb = [-1, -1, bt]; label = 'Triple'; }
      else if (ev === 'HR') {
        hits++; hr++; S.h++; S.hr++; S.ab++; for (const x of b) if (x >= 0) sc.push(x); sc.push(bt); nb = [-1, -1, -1];
        label = sc.length === 1 ? 'Solo home run' : sc.length === 4 ? 'Grand slam' : sc.length + '-run home run';
      }
      b = nb; runs += sc.length;
      for (const x of sc) bs[x].r++;
      if (rbi) S.rbi += sc.length;
      if (sc.length) {
        const mid = label === 'Single' || label === 'Double' || label === 'Triple' ? label + ', ' + sc.length + (sc.length === 1 ? ' run scores' : ' runs score') : label;
        plays.push({ runs: sc.length, label: mid, bat: bt });
      }
      slot = (slot + 1) % 9;
      if (runs >= runsToWin) { plays[plays.length - 1].walkoff = true; break; }
    }
    return { runs, hits, bb, k, hr, outs, slot, plays };
  }

  function mlbGame(away, home, rng, opts) {
    opts = opts || {};
    const teams = [away, home];
    const R = teams.map(t => roster('mlb', t));
    const sp = R.map((r, i) => r.rotation[teams[i].startIdx >= 0 && teams[i].startIdx != null ? teams[i].startIdx : Math.floor(rng() * r.rotation.length)]);
    const spIn = [5 + Math.floor(rng() * 3), 5 + Math.floor(rng() * 3)];
    const side = [0.97, 1.03];
    // probs[team][state][slot]; state 0 = vs starter, 1 = vs bullpen
    const probs = [0, 1].map(i => {
      const lu = R[i].lineup, mean = lu.reduce((a, x) => a + x.bat, 0) / lu.length, p = 1 - i;
      return [0, 1].map(state => lu.map(x => mlbProbs(teams[i].rs * side[i] * x.bat / mean, teams[p].ra + sp[p].adj + (state ? 0.27 : -0.13))));
    });
    const bat = [0, 1].map(i => R[i].lineup.map(() => ({ pa: 0, ab: 0, h: 0, hr: 0, bb: 0, k: 0, rbi: 0, r: 0 })));
    const pit = [0, 1].map(() => [{ outs: 0, h: 0, r: 0, bb: 0, k: 0, hr: 0 }, { outs: 0, h: 0, r: 0, bb: 0, k: 0, hr: 0 }]);
    const slot = [0, 0];
    const score = [0, 0], line = [[], []], stat = [0, 1].map(() => ({ h: 0, bb: 0, k: 0, lob: 0 }));
    const log = [];
    let inning = 0;
    for (;;) {
      inning++;
      const ghost = inning >= 10;
      for (let half = 0; half < 2; half++) {
        if (half === 1 && inning >= 9 && score[1] > score[0]) { line[1].push('X'); continue; }
        const need = half === 1 && inning >= 9 ? score[0] - score[1] + 1 : Infinity;
        const p = 1 - half, state = inning <= spIn[p] ? 0 : 1;
        const res = mlbHalf(probs[half][state], bat[half], slot[half], rng, ghost, need);
        slot[half] = res.slot;
        const pl = pit[p][state]; pl.outs += res.outs; pl.h += res.hits; pl.r += res.runs; pl.bb += res.bb; pl.k += res.k; pl.hr += res.hr;
        let run = 0;
        for (const play of res.plays) {
          run += play.runs;
          const tmp = score.slice(); tmp[half] += run;
          log.push((half ? 'Bot ' : 'Top ') + inning + ' – ' + teams[half].id + ': ' + play.label + ' (' + R[half].lineup[play.bat].name + ')' + (play.walkoff ? ' (walk-off!)' : '') + '  [' + away.id + ' ' + tmp[0] + ', ' + home.id + ' ' + tmp[1] + ']');
        }
        score[half] += res.runs; line[half].push(res.runs);
        const s = stat[half]; s.h += res.hits; s.bb += res.bb; s.k += res.k;
      }
      if (inning >= 9 && score[0] !== score[1]) break;
      if (inning >= 30) { score[rng() < 0.5 ? 0 : 1]++; break; }
    }
    const headers = [];
    for (let k = 1; k <= inning; k++) headers.push(String(k));
    const winner = score[0] > score[1] ? 0 : 1;
    let tables;
    if (opts.detail) {
      const ip = o => Math.floor(o / 3) + '.' + (o % 3);
      tables = [0, 1].map(i => [
        { title: 'Batting', headers: ['Batter', 'AB', 'R', 'H', 'HR', 'RBI', 'BB', 'K'],
          rows: R[i].lineup.map((x, j) => [x.name + ' (' + x.pos + ')', bat[i][j].ab, bat[i][j].r, bat[i][j].h, bat[i][j].hr, bat[i][j].rbi, bat[i][j].bb, bat[i][j].k]) },
        { title: 'Pitching', headers: ['Pitcher', 'IP', 'H', 'R', 'BB', 'K', 'HR'],
          rows: [[sp[i].name + ' (SP)'].concat([ip(pit[i][0].outs), pit[i][0].h, pit[i][0].r, pit[i][0].bb, pit[i][0].k, pit[i][0].hr]),
            ['Bullpen'].concat([ip(pit[i][1].outs), pit[i][1].h, pit[i][1].r, pit[i][1].bb, pit[i][1].k, pit[i][1].hr])] },
      ]);
    }
    for (let i = 0; i < 2; i++) stat[i].lob = 0;
    return {
      sport: 'mlb', teams, score, winner, extra: inning > 9, extraLabel: inning > 9 ? 'F/' + inning : '',
      line: { headers: headers.concat(['R', 'H']), rows: [0, 1].map(i => { const r = line[i].slice(); while (r.length < inning) r.push('X'); return r.concat([score[i], stat[i].h]); }) },
      box: [
        ['Starting pitcher', sp[0].name, sp[1].name],
        ['Hits', stat[0].h, stat[1].h], ['Walks/HBP', stat[0].bb, stat[1].bb],
        ['Strikeouts (by batters)', stat[0].k, stat[1].k],
      ],
      tables, log: log.length ? log : ['No runs scored.'],
    };
  }

  // =====================================================================
  // NHL
  // =====================================================================
  let NHL_LG = 3.05; const NHL_SHOTS_PER_MIN = 0.5, NHL_PEN_PER_MIN = 0.048;
  const NHL_B2B_OFF = typeof process !== 'undefined' && process.env && process.env.BT_NHL_B2B === '0' ? 0 : 0.10, NHL_B2B_DEF = NHL_B2B_OFF ? 0.15 : 0;

  function nhlSkaters(team, rng) {
    const r = roster('nhl', team);
    const gone = new Set(r.fwd.concat(r.def).filter(p => sits(p, rng)));
    let fw = r.fwd.filter(p => !gone.has(p)), df = r.def.filter(p => !gone.has(p));
    fw = fw.length >= 9 ? fw.slice(0, 12) : r.fwd.slice(0, 12); df = df.length >= 4 ? df.slice(0, 6) : r.def.slice(0, 6);
    const sk = fw.concat(df);
    const gl = r.goalies && r.goalies.length ? r.goalies : [{ name: r.g.name, sv: null, gp: 1 }];
    const goalie = team.gIdx != null && team.gIdx >= 0 && gl[team.gIdx] ? gl[team.gIdx] : (gl.find(g => !sits(g, rng)) || gl[0]);
    const w = sk.map(p => Math.max(0.01, p.w)), aw = sk.map((p, i) => w[i] * (p.pos === 'D' ? 2.2 : 1));
    return { r, sk, w, aw, tw: w.reduce((a, x) => a + x, 0), goalie, svAvg: r.svAvg, garAvg: r.garAvg, lostDef: Math.max(-0.1, Math.min(0.3, r.fwd.concat(r.def).filter(p => gone.has(p)).reduce((a, p) => a + (p.dimp || 0) * (p.gpr == null ? 1 : p.gpr), 0))),
      lostOff: Math.max(-0.1, Math.min(0.4, r.fwd.concat(r.def).filter(p => gone.has(p)).reduce((a, p) => a + (p.oimp || 0) * (p.gpr == null ? 1 : p.gpr), 0))), out: r.fwd.concat(r.def).filter(p => gone.has(p)).map(p => p.name) };
  }
  function pickW(w, tot, rng, skip) {
    for (;;) {
      let x = rng() * tot;
      for (let i = 0; i < w.length; i++) { x -= w[i]; if (x <= 0) { if (!skip || !skip.includes(i)) return i; break; } }
    }
  }

  function nhlGame(away, home, rng, opts) {
    opts = opts || {};
    const teams = [away, home];
    const lam = [away.gf * home.ga / NHL_LG * 0.98, home.gf * away.ga / NHL_LG * 1.02];
    const p = lam.map(l => clamp(l / (30 * 1.08), 0.03, 0.25));
    const K = [nhlSkaters(away, rng), nhlSkaters(home, rng)];
    const gf = k => { const g = k.goalie; if (g.gar && k.garAvg) return clamp(g.gar / k.garAvg, 0.8, 1.25); if (!g.sv || !k.svAvg) return 1; const w = (g.gp || 1) / ((g.gp || 1) + 10), sv = k.svAvg + (g.sv - k.svAvg) * w; return clamp((1 - sv) / (1 - k.svAvg), 0.75, 1.3); };
    p[0] *= gf(K[1]); p[1] *= gf(K[0]);
    p[0] *= 1 + K[1].lostDef / lam[0]; p[1] *= 1 + K[0].lostDef / lam[1];   // missing defenders let the other side score a little more
    p[0] *= Math.max(0.6, 1 - K[0].lostOff / lam[0]); p[1] *= Math.max(0.6, 1 - K[1].lostOff / lam[1]);   // missing scorers: the team itself creates fewer chances
    // Second night of a back-to-back: about 0.25 goals of margin (0.10 fewer scored, 0.15 more allowed, mostly tired or backup goalies).
    // 2024-25 and 2025-26 backtest residuals: away team on a back-to-back cost 0.17-0.42 goals vs rested games; home side noisier, ~0.3 pooled.
    const rest = opts.rest || {}, b2b = [rest.away === 0 ? 1 : 0, rest.home === 0 ? 1 : 0];
    p[0] *= (1 - NHL_B2B_OFF * b2b[0] / lam[0]) * (1 + NHL_B2B_DEF * b2b[1] / lam[0]);
    p[1] *= (1 - NHL_B2B_OFF * b2b[1] / lam[1]) * (1 + NHL_B2B_DEF * b2b[0] / lam[1]);
    const ps = K.map(k => k.sk.map(() => ({ g: 0, a: 0, sog: 0 })));
    const score = [0, 0], shots = [0, 0], ppg = [0, 0], ppo = [0, 0], pen = [0, 0];
    const byPeriod = [[0, 0, 0], [0, 0, 0]];
    const log = [];
    const clock = t => { const per = Math.floor(t / 20), m = t % 20, s = Math.floor(rng() * 60); return { per, txt: (per < 3 ? 'P' + (per + 1) : 'OT') + ' ' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0') }; };

    function minute(t, threeOnThree, suddenDeath) {
      if (!threeOnThree) {
        for (let i = 0; i < 2; i++) if (!pen[i] && rng() < NHL_PEN_PER_MIN) { pen[i] = 2; ppo[1 - i]++; }
      }
      let ended = false;
      for (let i = 0; i < 2 && !ended; i++) {
        const o = 1 - i, k = K[i];
        const mult = threeOnThree ? 1.8 : (pen[o] && !pen[i]) ? 2.4 : (pen[i] && !pen[o]) ? 0.4 : 1;
        const n = poisson(NHL_SHOTS_PER_MIN * mult, rng);
        for (let q = 0; q < n; q++) {
          shots[i]++;
          const sh = pickW(k.w, k.tw, rng); ps[i][sh].sog++;
          if (rng() < p[i]) {
            const tag = (pen[o] && !pen[i]) ? ' (PP)' : (pen[i] && !pen[o]) ? ' (SH)' : '';
            if (tag === ' (PP)') { ppg[i]++; pen[o] = 0; }
            score[i]++; ps[i][sh].g++;
            const asst = [];
            if (rng() < 0.9) { const a = pickW(k.aw, k.aw.reduce((x, y) => x + y, 0), rng, [sh]); asst.push(a); ps[i][a].a++;
              if (rng() < 0.65) { const b = pickW(k.aw, k.aw.reduce((x, y) => x + y, 0), rng, [sh, a]); asst.push(b); ps[i][b].a++; } }
            const c = clock(t);
            if (c.per < 3) byPeriod[i][c.per]++;
            log.push(c.txt + ' – ' + teams[i].id + ' goal' + tag + ': ' + k.sk[sh].name + (asst.length ? ' (' + asst.map(a => k.sk[a].name).join(', ') + ')' : ' (unassisted)') + '  [' + away.id + ' ' + score[0] + ', ' + home.id + ' ' + score[1] + ']');
            if (suddenDeath) { ended = true; break; }
          }
        }
      }
      for (let i = 0; i < 2; i++) pen[i] = Math.max(0, pen[i] - 1);
      return ended;
    }

    for (let t = 0; t < 60; t++) minute(t, false, false);

    let ot = null;
    if (score[0] === score[1]) {
      ot = 'OT';
      if (opts.playoff) {
        for (let t = 60; t < 60 + 20 * 12; t++) if (minute(t, false, true)) break;
        if (score[0] === score[1]) score[rng() < 0.5 ? 0 : 1]++;
      } else {
        for (let t = 60; t < 65; t++) if (minute(t, true, true)) break;
        if (score[0] === score[1]) {
          ot = 'SO';
          const q = [clamp(0.30 * lam[0] / 3.05, 0.2, 0.4), clamp(0.30 * lam[1] / 3.05, 0.2, 0.4)];
          const so = [0, 0];
          for (let rd = 0; rd < 3; rd++) for (let i = 0; i < 2; i++) if (rng() < q[i]) so[i]++;
          while (so[0] === so[1]) for (let i = 0; i < 2; i++) if (rng() < q[i]) so[i]++;
          if (so[0] === so[1]) so[rng() < 0.5 ? 0 : 1]++;
          const w = so[0] > so[1] ? 0 : 1;
          score[w]++;
          log.push('Shootout: ' + away.id + ' ' + so[0] + ', ' + home.id + ' ' + so[1] + ' – ' + teams[w].id + ' wins');
        }
      }
    }
    const winner = score[0] > score[1] ? 0 : 1;
    const reg = i => byPeriod[i][0] + byPeriod[i][1] + byPeriod[i][2];
    const headers = ['1', '2', '3'];
    const rows = [0, 1].map(i => byPeriod[i].slice());
    if (ot === 'OT') { headers.push('OT'); rows.forEach((r, i) => r.push(score[i] - reg(i))); }
    if (ot === 'SO') { headers.push('OT'); headers.push('SO'); rows.forEach(r => r.push(0)); rows.forEach((r, i) => r.push(i === winner ? 1 : 0)); }
    headers.push('T'); rows.forEach((r, i) => r.push(score[i]));
    let tables;
    if (opts.detail) {
      tables = [0, 1].map(i => {
        const ga = score[1 - i] - (ot === 'SO' && winner !== i ? 1 : 0), sa = shots[1 - i], sv = Math.max(0, sa - ga);
        return [
          { title: 'Skaters', headers: ['Skater', 'G', 'A', 'PTS', 'SOG'],
            rows: K[i].sk.map((x, j) => [x.name + ' (' + x.pos + ')', ps[i][j].g, ps[i][j].a, ps[i][j].g + ps[i][j].a, ps[i][j].sog])
              .filter(r => r[1] || r[2] || r[4]).sort((a, b) => b[3] - a[3] || b[1] - a[1] || b[4] - a[4]) },
          { title: 'Goalie', headers: ['Goalie', 'SA', 'SV', 'SV%'], rows: [[K[i].goalie.name, sa, sv, sa ? (sv / sa).toFixed(3) : '-']] },
        ];
      });
    }
    return {
      sport: 'nhl', teams, score, winner, extra: !!ot, extraLabel: ot || '',
      line: { headers, rows },
      box: [
        ['Shots on goal', shots[0], shots[1]],
        ['Power play', ppg[0] + '/' + ppo[0], ppg[1] + '/' + ppo[1]],
      ],
      tables, log: (opts.detail ? [0, 1].filter(i => K[i].out.length).map(i => 'Out – ' + teams[i].id + ': ' + K[i].out.join(', ')) : []).concat(log.length ? log : ['No goals scored.']),
    };
  }

  // =====================================================================
  // NFL (play-by-play: downs, clock, punts, field goals, turnovers, overtime)
  // =====================================================================
  let NFL_LG = 22.5;
  const lognormal = (mean, sigma, rng) => mean * Math.exp(sigma * normal(rng) - sigma * sigma / 2);

  const NFL_REPL = { cmp: 0.02, ypa: 0.4, int: 0.2 };   // replacement-level QB penalty (tuned so a starter-to-backup swap costs about 2.5 points, between the sim's old 1.0 and the noisy 3.1 seen in 2025)
  function nflPrep(team, rng) {
    const r = roster('nfl', team);
    const qbList = r.qb && r.qb.length ? r.qb : [{ name: 'QB', pos: 'QB', base: true, att: 500, ypa: 6.9, cmp: 0.645, int: 0.022 }];
    const memo = new Map(), sit = p => { if (!memo.has(p)) memo.set(p, sits(p, rng)); return memo.get(p); };
    const qb = qbList.find(p => !sit(p)) || qbList[0], base = qbList.find(p => p.base) || qbList[0];
    let rbs = (r.rb || []).filter(p => !sit(p));
    if (!rbs.length) rbs = [{ name: 'RB', pos: 'RB', car: 200, ypc: 4.3, tgt: 30, rec: 22, ryds: 150 }];
    const rec = (r.rec || []).filter(p => !sit(p));
    const rcv = rec.map(p => ({ p, w: Math.max(2, p.tgt) })).concat(rbs.map(p => ({ p, w: Math.max(2, (p.tgt || 10) * 0.8) })));
    if (rcv.length < 3) for (let i = rcv.length; i < 4; i++) rcv.push({ p: { name: 'WR', pos: 'WR', tgt: 40 }, w: 40 });
    const kicker = (r.k && r.k.name) || 'Kicker';
    // missing defenders: ~0.1 points per unit of lost defensive production (sacks/hits/TFL/passes defended/INTs), halved from the backtest estimate; capped at 3
    const dl = r.defense || [], ol = r.ol || [];
    // Missing starters by snap share (nflverse snap counts; 1.0 = plays every snap). 2024-25 injury reports vs the sim's misses gave about
    // 1.1 / 1.0 / 1.3 points per full-time OL / skill / defensive starter out; shrunk to 0.8 / 0.5 / 1.0 because the estimates are noisy
    // (skill players also lose less because the sim already hands their targets to teammates). Without snap data: the old production rule.
    const snapSum = arr => arr.filter(sit).reduce((a, p) => a + (p.snap || 0), 0);
    const hasSnap = dl.some(p => p.snap != null);
    const defLost = hasSnap ? Math.min(4, 1.0 * snapSum(dl)) : Math.min(3, 0.1 * dl.filter(sit).reduce((a, p) => a + (p.gpr == null ? 1 : p.gpr) * p.prod, 0));
    const offLost = Math.min(3, 0.8 * snapSum(ol)) + Math.min(2, 0.5 * snapSum((r.rb || []).concat(r.rec || []).filter(p => p.snap != null)));
    const outNames = [qbList, r.rb || [], r.rec || [], ol, dl].flat().filter(sit).map(p => p.name);
    // a backup with few attempts is shrunk toward the league average by the data pipeline, but real replacement QBs are below average: pull them down by how little we have seen of them
    const rp = qb === base ? 0 : 1 - qb.att / (qb.att + 300);
    const q = rp ? { cmp: qb.cmp - NFL_REPL.cmp * rp, ypa: qb.ypa - NFL_REPL.ypa * rp, int: qb.int * (1 + NFL_REPL.int * rp) } : qb;
    return { qb, base, rbs, rcv, kicker, defLost, offLost, outNames,
      cmpRel: clamp(q.cmp / base.cmp, 0.85, 1.12), ypaRel: clamp(q.ypa / base.ypa, 0.8, 1.2), intRel: clamp(q.int / base.int, 0.6, 1.8) };
  }

  // Weather: points added to the game total (negative = fewer). Fit on nflverse 2015-23 outdoor games, tuned on the sim's 2024-25 backtest:
  // wind over 7 mph and cold under 40F lower scoring. Domes get nothing extra because dome teams' ratings already include their home games indoors.
  function nflWeatherAdj(w) {
    if (!w || w.indoor || w.wind == null) return 0;
    return -0.2 * Math.max(0, w.wind - 7) - 0.1 * Math.max(0, 40 - (w.temp == null ? 55 : w.temp));
  }
  function nflGame(away, home, rng, opts) {
    opts = opts || {};
    const teams = [away, home];
    const R = teams.map(t => nflPrep(t, rng));
    const wx = nflWeatherAdj(opts.weather) / 2;
    const e = [away.pf * home.pa / NFL_LG - 1.0 + R[1].defLost - R[0].offLost + wx, home.pf * away.pa / NFL_LG + 1.0 + R[0].defLost - R[1].offLost + wx];
    const s = e.map(x => clamp(x / NFL_LG, 0.45, 1.8));
    const score = [0, 0], byQ = [[0, 0, 0, 0, 0], [0, 0, 0, 0, 0]];
    const st = [0, 1].map(() => ({ plays: 0, yds: 0, pass: 0, rush: 0, to: 0, pen: 0, penYds: 0, c3: 0, a3: 0, top: 0, sacks: 0 }));
    const qbS = R.map(() => ({ cmp: 0, att: 0, yds: 0, td: 0, int: 0, sk: 0 }));
    const rushS = R.map(r => r.rbs.map(() => ({ car: 0, yds: 0, td: 0 })));
    const recS = R.map(r => r.rcv.map(() => ({ tgt: 0, rec: 0, yds: 0, td: 0 })));
    const kS = R.map(() => ({ fgm: 0, fga: 0, xpm: 0, xpa: 0, long: 0 }));
    const log = [];
    let el = 0, otEnd = 0;
    const segEnd = () => el < 1800 ? 1800 : el < 3600 ? 3600 : otEnd;
    const qOf = t => t >= 3600 ? 4 : Math.floor(t / 900);
    const stamp = () => { const q = qOf(el), left = el >= 3600 ? 600 - (el - 3600) : 900 - (el % 900); const m = Math.floor(left / 60), sc = Math.floor(left % 60); return (q === 4 ? 'OT' : 'Q' + (q + 1)) + ' ' + m + ':' + String(sc).padStart(2, '0'); };
    const addScore = (i, pts) => { score[i] += pts; byQ[i][qOf(el)] += pts; };
    const wpick = (arr, w) => { let tot = 0; for (let k = 0; k < arr.length; k++) tot += w(arr[k]); let r = rng() * tot; for (let k = 0; k < arr.length; k++) { r -= w(arr[k]); if (r <= 0) return k; } return arr.length - 1; };
    const ko = () => clamp(Math.round(37 + normal(rng) * 5), 24, 55);
    const fgProb = d => 1 / (1 + Math.exp((d - 53) / 6));

    function drive(i, yl, ot) {
      const o = R[i], me = st[i], oppI = 1 - i, sk = s[i];
      let down = 1, dist = 10, nPlays = 0, yds0 = yl, last = '';
      for (;;) {
        const lead = score[i] - score[oppI], left = segEnd() - el;
        const hurry = lead <= 0 && left < 120 && (segEnd() !== 1800 || true) || (lead < 0 && el >= 3600 - 360 && el < 3600);
        const burn = lead > 0 && el >= 3600 - 300 && el < 3600;
        // ---- fourth down ----
        if (down === 4) {
          const fgD = 100 - yl + 17;
          let go = false;
          if (hurry && lead < 0 && left < 240 && !(lead >= -3 && fgD <= 56)) go = true;
          else if (dist <= 2 && yl >= 40 && fgD > 33) go = rng() < 0.45;
          else if (dist <= 1 && yl >= 30) go = rng() < 0.55;
          else if (yl >= 94 && dist <= 3) go = rng() < 0.35;
          if (!go) {
            if (fgD <= 56) {
              kS[i].fga++; el += 6;
              if (rng() < fgProb(fgD)) { kS[i].fgm++; kS[i].long = Math.max(kS[i].long, fgD); addScore(i, 3); log.push(stamp() + ' – ' + teams[i].id + ' FG ' + fgD + ' yd (' + o.kicker + ')  [' + away.id + ' ' + score[0] + ', ' + home.id + ' ' + score[1] + ']'); return { result: 'FG' }; }
              return { result: 'miss', yl: Math.max(20, 100 - yl) };
            }
            const net = clamp(Math.round(44 + normal(rng) * 7), 25, 70); el += 8;
            const land = yl + net;
            return { result: 'punt', yl: land >= 100 ? 20 : clamp(100 - land, 1, 99) };
          }
        }
        // ---- choose play ----
        let passP = 0.575;
        if (down >= 3 && dist >= 7) passP = 0.82; else if (down >= 2 && dist >= 8) passP = 0.7; else if (dist <= 2) passP = 0.35;
        if (hurry) passP = Math.max(passP, 0.8);
        if (burn) passP = 0.15;
        if (lead > 14 && el > 2400 && !burn) passP -= 0.15;
        let dur;
        me.plays++; nPlays++;
        if (down === 3) me.a3++;
        let gain = 0, turnover = null, firstDown = false, td = false;
        const pr = rng();
        if (pr < 0.07) { // penalty
          const offPen = rng() < 0.55;
          me.pen++; el += 12; me.top += 12;
          if (offPen) { me.penYds += 10; yl = Math.max(1, yl - 10); dist += 10; me.plays--; nPlays--; if (down === 3) me.a3--; if (dist > 30) dist = 30; }
          else { me.plays--; nPlays--; if (down === 3) me.a3--; const g = Math.min(5, 100 - yl - 1); yl += g; dist -= g; if (dist <= 0 || rng() < 0.45) { down = 1; dist = Math.min(10, 100 - yl); } }
          if (el >= segEnd()) return { result: 'half' };
          continue;
        }
        if (rng() < passP) {
          const sackP = 0.065 * Math.pow(sk, -0.35), intP = 0.021 * o.intRel * Math.pow(sk, -0.5);
          const u = rng();
          if (u < sackP) {
            gain = -Math.round(1 + rng() * 11); me.sacks++; qbS[i].sk++; dur = 30; last = 'sack';
            if (rng() < 0.12) turnover = { type: 'fumble', yl: clamp(yl + gain, 1, 99) };
          } else {
            const tgt = wpick(o.rcv, x => x.w), rp = o.rcv[tgt].p;
            qbS[i].att++; recS[i][tgt].tgt++;
            if (u < sackP + intP) {
              qbS[i].int++; dur = 12; gain = 0; last = 'int';
              turnover = { type: 'int', yl: clamp(yl + Math.round(rng() * 22), 1, 99) };
            } else if (rng() < clamp(0.645 * Math.pow(sk, 0.12) * o.cmpRel, 0.4, 0.85)) {
              gain = Math.max(0, Math.round(lognormal(11.9 * Math.pow(sk, 0.3) * Math.pow(o.ypaRel, 0.8), 0.8, rng)));
              if (rng() < 0.012) gain = 0;
              gain = Math.min(gain, 100 - yl);
              qbS[i].cmp++; qbS[i].yds += gain; recS[i][tgt].rec++; recS[i][tgt].yds += gain; me.pass += gain;
              dur = rng() < 0.15 ? 8 : 33 + (rng() - 0.5) * 12;
              if (yl + gain >= 100) { td = true; qbS[i].td++; recS[i][tgt].td++; last = gain + ' yd pass to ' + rp.name; }
            } else { dur = 6; gain = 0; last = 'inc'; }
          }
        } else {
          const ri = wpick(o.rbs, x => Math.max(5, x.car || 50)), rb = o.rbs[ri];
          const rel = clamp((rb.ypc || 4.3) / 4.3, 0.75, 1.3);
          gain = rng() < 0.09 ? -(1 + Math.floor(rng() * 3)) : Math.round(lognormal(4.55 / 0.91 * Math.pow(sk, 0.25) * rel, 0.85, rng));
          gain = Math.min(gain, 100 - yl);
          rushS[i][ri].car++; rushS[i][ri].yds += gain; me.rush += gain; dur = 34 + (rng() - 0.5) * 12;
          if (rng() < 0.008) turnover = { type: 'fumble', yl: clamp(yl + gain, 1, 99) };
          if (yl + gain >= 100) { td = true; rushS[i][ri].td++; last = gain + ' yd run by ' + rb.name; }
        }
        if (hurry && !burn) dur = Math.min(dur, dur > 10 ? 15 : dur);
        if (burn) dur = dur > 10 ? 40 : dur;
        el += dur; me.top += dur;
        me.yds += gain;
        if (turnover) {
          me.to++; return { result: 'turnover', yl: 100 - turnover.yl };
        }
        if (td) {
          log.push(stamp() + ' – ' + teams[i].id + ' TD: ' + last + ' (' + nPlays + ' plays, ' + Math.round(yl + gain - yds0) + ' yds)');
          addScore(i, 6);
          if (!ot) {
            if (rng() < 0.945) { kS[i].xpa++; kS[i].xpm++; addScore(i, 1); } else kS[i].xpa++;
          }
          log[log.length - 1] += '  [' + away.id + ' ' + score[0] + ', ' + home.id + ' ' + score[1] + ']';
          if (down === 3) me.c3++;
          return { result: 'TD' };
        }
        yl += gain;
        if (gain >= dist) { if (down === 3) me.c3++; down = 1; dist = Math.min(10, 100 - yl); }
        else { down++; dist -= gain; if (down > 4) return { result: 'downs', yl: 100 - yl }; }
        if (el >= segEnd()) return { result: 'half' };
      }
    }

    const first = rng() < 0.5 ? 0 : 1;
    let poss = first, yl = ko(), half2 = false;
    while (el < 3600) {
      if (!half2 && el >= 1800) { half2 = true; poss = 1 - first; yl = ko(); }
      const r = drive(poss, yl, false);
      if (r.result === 'TD' || r.result === 'FG') { poss = 1 - poss; yl = ko(); }
      else if (r.result === 'half') { /* handled above */ }
      else { poss = 1 - poss; yl = r.yl; }
    }
    // ---- overtime ----
    let otPlayed = false;
    if (score[0] === score[1]) {
      otPlayed = true; el = 3600; otEnd = 3600 + (opts.playoff ? 900 * 6 : 600);
      poss = rng() < 0.5 ? 0 : 1; yl = ko();
      let drives = 0;
      while (el < otEnd) {
        const r = drive(poss, yl, true); drives++;
        if (r.result === 'TD' && drives === 1) break;
        if (drives >= 2 && score[0] !== score[1]) break;
        if (r.result === 'TD' || r.result === 'FG') { poss = 1 - poss; yl = ko(); } else if (r.result !== 'half') { poss = 1 - poss; yl = r.yl; }
        if (opts.playoff && drives > 40) break;
      }
    }
    const tie = score[0] === score[1];
    const winner = tie ? 1 : score[0] > score[1] ? 0 : 1;

    const top = t => Math.floor(t / 60) + ':' + String(Math.round(t % 60) % 60).padStart(2, '0');
    let tables;
    if (opts.detail) {
      tables = [0, 1].map(i => {
        const q = qbS[i], out = [
          { title: 'Passing', headers: ['Player', 'C/ATT', 'YDS', 'TD', 'INT', 'SACK'], rows: [[R[i].qb.name, q.cmp + '/' + q.att, q.yds, q.td, q.int, q.sk]] },
          { title: 'Rushing', headers: ['Player', 'CAR', 'YDS', 'AVG', 'TD'], rows: R[i].rbs.map((p, j) => [p.name, rushS[i][j].car, rushS[i][j].yds, rushS[i][j].car ? (rushS[i][j].yds / rushS[i][j].car).toFixed(1) : '-', rushS[i][j].td]).filter(r => r[1]) },
          { title: 'Receiving', headers: ['Player', 'TGT', 'REC', 'YDS', 'TD'], rows: R[i].rcv.map((x, j) => [x.p.name + ' (' + x.p.pos + ')', recS[i][j].tgt, recS[i][j].rec, recS[i][j].yds, recS[i][j].td]).filter(r => r[1]).sort((a, b) => b[3] - a[3]) },
          { title: 'Kicking', headers: ['Player', 'FG', 'XP', 'LONG'], rows: [[R[i].kicker, kS[i].fgm + '/' + kS[i].fga, kS[i].xpm + '/' + kS[i].xpa, kS[i].long || '-']] },
        ];
        return out;
      });
    }
    const headers = ['1', '2', '3', '4'].concat(otPlayed ? ['OT'] : []).concat(['T']);
    return {
      sport: 'nfl', teams, score, winner, tie, extra: otPlayed, extraLabel: otPlayed ? 'OT' : '',
      line: { headers, rows: [0, 1].map(i => byQ[i].slice(0, otPlayed ? 5 : 4).concat([score[i]])) },
      box: [
        ['Total yards', st[0].yds, st[1].yds], ['Passing yards', st[0].pass, st[1].pass], ['Rushing yards', st[0].rush, st[1].rush],
        ['Plays', st[0].plays, st[1].plays], ['3rd down', st[0].c3 + '/' + st[0].a3, st[1].c3 + '/' + st[1].a3],
        ['Turnovers', st[0].to, st[1].to], ['Sacks taken', st[0].sacks, st[1].sacks],
        ['Penalties', st[0].pen + '-' + st[0].penYds, st[1].pen + '-' + st[1].penYds],
        ['Time of possession', top(st[0].top), top(st[1].top)],
      ],
      tables, log: (opts.detail ? [0, 1].filter(i => R[i].outNames.length).map(i => 'Out – ' + teams[i].id + ': ' + R[i].outNames.join(', ')) : []).concat(log.length ? log : ['No scoring.']),
    };
  }

  // =====================================================================
  // Common API
  // =====================================================================
  const SPORTS = {
    nba: { label: 'NBA', teams: NBA_TEAMS, game: nbaGame, bin: 4, fields: [['off', 'Offense (pts/100 poss)', 0.5], ['def', 'Defense (pts allowed/100)', 0.5]] },
    mlb: { label: 'MLB', teams: MLB_TEAMS, game: mlbGame, bin: 1, fields: [['rs', 'Runs scored / game', 0.1], ['ra', 'Runs allowed / game', 0.1]] },
    nfl: { label: 'NFL', teams: NFL_TEAMS, game: nflGame, bin: 3, fields: [['pf', 'Points for / game', 0.5], ['pa', 'Points against / game', 0.5]] },
    nhl: { label: 'NHL', teams: NHL_TEAMS, game: nhlGame, bin: 1, fields: [['gf', 'Goals for / game', 0.05], ['ga', 'Goals against / game', 0.05]] },
  };

  function simGame(sport, away, home, rng, opts) { return SPORTS[sport].game(away, home, rng, opts); }

  function monteCarlo(sport, away, home, n, rng, opts) {
    const wins = [0, 0, 0], sum = [0, 0]; let extra = 0, totSum = 0;
    const margins = new Map(), bin = SPORTS[sport].bin; let min = Infinity, max = -Infinity;
    for (let i = 0; i < n; i++) {
      const g = simGame(sport, away, home, rng, opts);
      wins[g.tie ? 2 : g.winner]++; sum[0] += g.score[0]; sum[1] += g.score[1]; totSum += g.score[0] + g.score[1];
      if (g.extra) extra++;
      const m = Math.round((g.score[1] - g.score[0]) / bin) * bin;
      margins.set(m, (margins.get(m) || 0) + 1);
      min = Math.min(min, m); max = Math.max(max, m);
    }
    return { n, wins, avg: [sum[0] / n, sum[1] / n], avgTotal: totSum / n, extraPct: extra / n, margins, min, max, bin };
  }

  function playSeries(sport, hi, lo, bestOf, rng) {
    const need = Math.ceil(bestOf / 2);
    const homeIsHi = bestOf === 7 ? [1, 1, 0, 0, 1, 0, 1] : bestOf === 5 ? [1, 1, 0, 0, 1] : bestOf === 3 ? [1, 0, 1] : [1];
    const w = [0, 0], games = [];
    for (let g = 0; w[0] < need && w[1] < need; g++) {
      const hiHome = homeIsHi[g % homeIsHi.length];
      const res = hiHome ? simGame(sport, lo, hi, rng, { playoff: true }) : simGame(sport, hi, lo, rng, { playoff: true });
      const hiScore = hiHome ? res.score[1] : res.score[0], loScore = hiHome ? res.score[0] : res.score[1];
      const hiWon = hiScore > loScore; hiWon ? w[0]++ : w[1]++;
      games.push({ hiHome: !!hiHome, hiScore, loScore, hiWon, extra: res.extraLabel });
    }
    return { winner: w[0] > w[1] ? 0 : 1, wins: w, games };
  }

  function seriesMonteCarlo(sport, hi, lo, bestOf, n, rng) {
    const need = Math.ceil(bestOf / 2), wins = [0, 0], lengths = {};
    for (let i = 0; i < n; i++) {
      const s = playSeries(sport, hi, lo, bestOf, rng);
      wins[s.winner]++;
      lengths[s.games.length] = (lengths[s.games.length] || 0) + 1;
    }
    return { n, wins, lengths, need };
  }

  function leagueTable(sport, reps, rng) {
    const teams = SPORTS[sport].teams, rows = teams.map(t => ({ team: t, w: 0, l: 0, pf: 0, pa: 0 }));
    for (let r = 0; r < reps; r++)
      for (let a = 0; a < teams.length; a++)
        for (let h = 0; h < teams.length; h++) {
          if (a === h) continue;
          const g = simGame(sport, teams[a], teams[h], rng);
          rows[a].pf += g.score[0]; rows[a].pa += g.score[1];
          rows[h].pf += g.score[1]; rows[h].pa += g.score[0];
          if (g.tie) { rows[a].w += 0.5; rows[a].l += 0.5; rows[h].w += 0.5; rows[h].l += 0.5; }
          else if (g.winner === 0) { rows[a].w++; rows[h].l++; } else { rows[h].w++; rows[a].l++; }
        }
    rows.forEach(x => { const gp = x.w + x.l; x.pct = x.w / gp; x.gp = gp; });
    return rows.sort((a, b) => b.pct - a.pct);
  }

  // Overlay live ratings/rosters (from data.js) onto the built-in teams.
  function applyLive(data) {
    if (!data) return 0;
    if (data.meta) for (const k in data.meta) setLeague(k, data.meta[k].lg);
    const norm = x => x.toLowerCase().replace(/[^a-z]/g, ''); let n = 0;
    for (const sp of ['nba', 'nfl', 'nhl']) {
      const d = data[sp]; if (!d) continue;
      const byName = {}; Object.keys(d).forEach(k => { byName[norm(d[k].name)] = d[k]; });
      for (const t of SPORTS[sp].teams) {
        const e = byName[norm(t.name)] || d[t.id]; if (!e) continue;
        n++; t.live = true; t.liveGp = e.gp; delete t.roster;
        if (sp === 'nba') { t.off = e.off; t.def = e.def; if (e.players && e.players.length >= 8) t.roster = { players: e.players }; }
        if (sp === 'nfl') { t.pf = e.off; t.pa = e.def; if (e.players && e.players.qb && e.players.qb.length) t.roster = { qb: e.players.qb, rb: e.players.rb, rec: e.players.rec, ol: e.players.ol || [], defense: e.players.defense || [] }; }
        if (sp === 'nhl') {
          t.gf = e.off; t.ga = e.def;
          if (e.fwd && e.dmen && e.fwd.length >= 9 && e.dmen.length >= 4 && e.goalies && e.goalies.length) t.roster = { fwd: e.fwd, def: e.dmen, g: { name: e.goalies[0].name }, goalies: e.goalies, svAvg: e.svAvg, garAvg: e.garAvg };
        }
      }
    }
    return n;
  }
  function setLeague(sport, v) { if (sport === 'nba') NBA_LG = v; else if (sport === 'nhl') NHL_LG = v; else if (sport === 'nfl') NFL_LG = v; }
  // Key players who are out or uncertain for a team, most important first: [{ name, pos, status, out }]. Used to explain why the sim and the market disagree.
  const STATUS = [[/out|injured reserve/i, 'Out'], [/doubtful/i, 'Doubtful'], [/questionable/i, 'Questionable'], [/day-to-day/i, 'Day-to-day']];
  function injuries(sport, team, max) {
    const r = roster(sport, team), out = [];
    const add = (p, w) => {
      if (p.gpr != null && p.gpr < 0.35 && p.out) return;   // out most of the season: already in the team rating, not news
      const hit = STATUS.find(s => p.note && s[0].test(p.note)); if (!hit && !p.out) return;
      out.push({ name: p.name, pos: p.pos || '', status: hit ? hit[1] : 'Out', out: hit ? hit[1] === 'Out' : true, w: w * (p.gpr == null ? 1 : Math.max(0.5, p.gpr)) });
    };
    if (sport === 'nba') (r.players || []).forEach(p => { if (p.min >= 18) add(p, p.min); });
    else if (sport === 'nhl') { (r.fwd || []).concat(r.def || []).forEach(p => { if (p.toi >= 15) add(p, p.toi); }); (r.goalies || []).forEach(p => { if (p.gp >= 10) add(p, 40); }); }
    else if (sport === 'nfl') {
      (r.qb || []).slice(0, 2).forEach(p => add(p, 100)); (r.rb || []).forEach(p => { if (p.car + p.tgt >= 60) add(p, 20 + (p.car + p.tgt) / 10); });
      (r.rec || []).forEach(p => { if (p.tgt >= 30) add(p, 10 + p.tgt / 5); }); (r.defense || []).forEach(p => { if (p.snap != null ? p.snap >= 0.6 : p.prod >= 2) add(p, p.snap != null ? 10 + 20 * p.snap : 10 + p.prod * 3); });
      (r.ol || []).forEach(p => { if (p.snap >= 0.6) add(p, 10 + 16 * p.snap); });
    }
    return out.sort((a, b) => b.w - a.w).slice(0, max || 4).map(p => ({ name: p.name, pos: p.pos, status: p.status, out: p.out }));
  }
  const fold = s => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z ]/g, '').trim();
  function matchGoalie(list, name) {   // index of the goalie whose surname and first initial match, or -1
    const m = name && /^(\S+)\s+(.+)$/.exec(fold(name)); if (!m || !list) return -1;
    return list.findIndex(g => { const p = fold(g.name).split(' '); return p.slice(1).join(' ') === m[2] && p[0][0] === m[1][0]; });
  }
  const api = { setLeague, applyLive, injuries, matchGoalie, makeRng, roster, nflWeatherAdj, SPORTS, simGame, monteCarlo, playSeries, seriesMonteCarlo, leagueTable };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Sim = api;
})(typeof window !== 'undefined' ? window : globalThis);
