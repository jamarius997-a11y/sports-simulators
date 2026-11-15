// Audit test (Nov 2026): how often do NFL players listed Questionable / Doubtful / Out actually sit? This set the odds in sim.js. Usage: node research/availability-odds-test.js
// how often does a player listed Questionable / Doubtful / Out on the NFL official report actually sit?  (nflverse injuries + snap counts, 2024-25)
const { read } = require(require('path').join(__dirname, '..', 'csv.js')); const fs = require('fs');
const C = require('path').join(__dirname, '..', 'cache') + '/';
const snapName = x => String(x).toLowerCase().replace(/\b(jr|sr|ii|iii|iv|v)\b\.?/g, '').replace(/[^a-z]/g, '');
const stat = {};
for (const y of [2024, 2025]) {
  const f = C + 'snap_counts_' + y + '.csv'; if (!fs.existsSync(f)) { console.log('missing', f); continue; }
  const played = new Map(); for (const s of read(f)) if (s.game_type === 'REG') played.set(y + '|' + s.week + '|' + snapName(s.player), Math.max(+s.offense_snaps || 0, +s.defense_snaps || 0, +s.st_snaps || 0));
  const inj = read(C + 'nfl_injuries_' + y + '.csv').filter(r => r.game_type === 'REG' && r.report_status);
  for (const r of inj) { const k = y + '|' + r.week + '|' + snapName(r.full_name); if (!played.has(k) && !(played.size)) continue;
    const snaps = played.get(k) || 0, pos = /^(QB)$/.test(r.position) ? 'QB' : /^(RB|WR|TE|FB)$/.test(r.position) ? 'skill' : /^(T|G|C|OL|OT|OG)$/.test(r.position) ? 'OL' : 'defense/other';
    for (const key of ['all', pos]) { const s = stat[r.report_status + '|' + key] = stat[r.report_status + '|' + key] || { n: 0, sat: 0 }; s.n++; if (snaps === 0) s.sat++; } }
}
for (const st of ['Out', 'Doubtful', 'Questionable']) console.log(st.padEnd(13), ['all', 'QB', 'skill', 'OL', 'defense/other'].map(k => { const s = stat[st + '|' + k]; return s ? k + ' ' + (100 * s.sat / s.n).toFixed(0) + '% sat (' + s.n + ')' : k + ' -'; }).join(' | '));
console.log('sim.js now uses: doubtful 99%, questionable 35% (QB 73%), day-to-day 30%, probable 5%  (before this test: 75% / 40% / 30% / 5%)');
