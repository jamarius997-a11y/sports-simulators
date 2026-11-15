// Reads recent injury headlines (Google News feeds, many outlets) and flags the players data.js knows about: writes news-data.js, shown as "News" chips on the cards.
// Display only: nothing here changes the sims. The flags are also saved with each logged pick (log-picks.js) so score-picks.js can check them against results.
// How a headline becomes a status:
//   1. plain keyword rules (classify below). They only decide when the headline states a status, so "Is X playing tonight?" stays unclear.
//   2. if ANTHROPIC_API_KEY is set, the headlines the rules left unclear go to a hosted Claude model that must answer OUT / DOUBTFUL / QUESTIONABLE / PLAYING /
//      UNCLEAR for each (anything else is dropped). Without a key this step is skipped. The local model tested in the audit invented a status for 12 of 18 vague
//      headlines, so it is not used here. Run `node news-eval.js` to score either path against the hand-labelled headlines in news-labels.json.
// Usage: node fetch-news.js
'use strict';
const fs = require('fs'), path = require('path');
const { snapName, decode } = require('./sources.js');

const QUERIES = {
  ncaaf: ['college football injury report out questionable', 'college football starting quarterback out', 'college football availability report', 'college football ruled out Saturday'],
  ncaab: ['college basketball injury out tonight', 'college basketball questionable game-time decision', 'college basketball ruled out'],
  nba: ['NBA injury report out tonight', 'NBA questionable tonight injury', 'NBA ruled out'],
  nfl: ['NFL injury report ruled out Sunday', 'NFL questionable doubtful Sunday', 'NFL final injury report'],
  nhl: ['NHL injury out tonight', 'NHL day-to-day injury lineup', 'NHL injured scratched'],
};
const HOURS = 48, MODEL = 'claude-haiku-5-5';

// 'out' | 'doubtful' | 'questionable' | 'playing' | 'unclear'
function classify(title) {
  const t = String(title);
  if (/knock(s|ed)? out|out of (the )?(playoff|tournament|ranking|poll|top)|work out|workout/i.test(t)) return 'unclear';
  if (/ruled out|rules? out|will not play|won'?t play|not playing|sidelined|inactive|scratched|season-ending|out for the (season|year)|out for (the )?(game|week|rest)|out (against|vs\.?|with|at|tonight|saturday|sunday|friday|thursday|monday|tuesday|wednesday)\b|out with|not on (the )?final availability|sits? out|won'?t suit up|shut down for/i.test(t)) return 'out';
  if (/doubtful/i.test(t)) return 'doubtful';
  if (/questionable|game-?time decision|gametime decision|day-to-day|in doubt|uncertain|could miss|may miss|injury scare|heading to (the )?locker room|limited in practice|did not practice/i.test(t)) return 'questionable';
  if (!/\?/.test(t) && /set to start|will start|to start\b|cleared to (play|return)|expected to play|will play|returns?\b|back in the lineup|upgrade[sd]?\b|available\b/i.test(t)) return 'playing';
  return 'unclear';
}

async function feed(q) {
  try {
    const r = await fetch('https://news.google.com/rss/search?q=' + encodeURIComponent(q + ' when:2d') + '&hl=en-US&gl=US&ceid=US:en', { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(25000) });
    if (!r.ok) return [];
    const x = await r.text(), out = [];
    for (const m of x.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
      const t = /<title>([\s\S]*?)<\/title>/.exec(m[1]), d = /<pubDate>([\s\S]*?)<\/pubDate>/.exec(m[1]), s = /<source[^>]*>([\s\S]*?)<\/source>/.exec(m[1]), l = /<link>([\s\S]*?)<\/link>/.exec(m[1]);
      if (t) out.push({ title: decode(t[1].replace(/<!\[CDATA\[|\]\]>/g, '')).replace(/\s+-\s+[^-]+$/, ''), source: s ? decode(s[1]) : '', date: d ? new Date(d[1]).toISOString() : null, url: l ? decode(l[1]) : '' });
    }
    return out;
  } catch (e) { return []; }
}

// players the data knows about, per sport: key -> [{ name, team }]
function playerIndex(D) {
  const idx = {};
  for (const sp of Object.keys(QUERIES)) {
    idx[sp] = {};
    for (const id in D[sp] || {}) {
      const t = D[sp][id], pl = t.players; if (!pl) continue;
      const list = Array.isArray(pl) ? pl : [].concat(pl.qb || [], pl.rb || [], pl.rec || [], pl.defense || [], pl.ol || [], t.fwd || [], t.dmen || [], t.goalies || []);
      for (const p of list) { const w = String(p.name).split(/\s+/); if (w.length < 2) continue; const k = snapName(p.name); (idx[sp][k] = idx[sp][k] || []).push({ name: p.name, team: t.name, first: snapName(w[0] + w[w.length - 1].replace(/\b(jr|sr|ii|iii|iv)\b\.?/gi, '')) }); }
    }
  }
  return idx;
}
const fold = s => ' ' + String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\b(jr|sr|ii|iii|iv)\b\.?/g, '').replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim() + ' ';
// the one known player a headline names (null when none or when two different players are named)
function findPlayer(index, title) {
  const t = fold(title), hits = new Map();
  for (const k in index) for (const p of index[k]) { const w = fold(p.name).trim().split(' '); if (t.includes(' ' + w.join(' ') + ' ') || (w.length > 2 && t.includes(' ' + w[0] + ' ' + w[w.length - 1] + ' '))) hits.set(snapName(p.name), p); }
  return hits.size === 1 ? [...hits.values()][0] : null;
}

async function llm(items) {
  const key = process.env.ANTHROPIC_API_KEY; if (!key || !items.length) return {};
  const SYS = 'You read sports headlines and report ONE named player\'s availability for his team\'s NEXT game, using only what the headline says. For each numbered item answer exactly one of: OUT (ruled out, will not play, suspended, season-ending), DOUBTFUL, QUESTIONABLE (game-time decision, uncertain, day-to-day), PLAYING (starting, cleared, available, returns), UNCLEAR (the headline does not state his availability, for example a question, a recap, or a general injury report). When in doubt answer UNCLEAR. Reply with JSON only: {"1":"OUT","2":"UNCLEAR",...}';
  const res = {};
  for (let i = 0; i < items.length; i += 40) {
    const part = items.slice(i, i + 40);
    try {
      const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, signal: AbortSignal.timeout(60000),
        body: JSON.stringify({ model: MODEL, max_tokens: 800, system: SYS, messages: [{ role: 'user', content: part.map((c, k) => (k + 1) + '. Player: ' + c.player + ' | Headline: ' + c.title).join('\n') }] }) });
      if (!r.ok) { console.log('  hosted model: HTTP ' + r.status + ' (skipped)'); continue; }
      const j = await r.json(), txt = (j.content && j.content[0] && j.content[0].text) || '', m = /\{[\s\S]*\}/.exec(txt); if (!m) continue;
      const a = JSON.parse(m[0]); part.forEach((c, k) => { const v = String(a[k + 1] || '').toUpperCase(); if (['OUT', 'DOUBTFUL', 'QUESTIONABLE', 'PLAYING', 'UNCLEAR'].includes(v)) res[c.id] = v.toLowerCase(); });
    } catch (e) { console.log('  hosted model failed: ' + e.message); }
  }
  return res;
}

module.exports = { classify, findPlayer, playerIndex };
if (require.main === module) (async () => {
  global.window = global; require('./data.js'); const D = window.LIVE_DATA, index = playerIndex(D), cutoff = Date.now() - HOURS * 3600e3, seen = new Set(), cands = [];
  let headlines = 0;
  for (const sp in QUERIES) for (const q of QUERIES[sp]) {
    for (const h of await feed(q)) {
      if (!h.date || new Date(h.date).getTime() < cutoff || seen.has(sp + h.title)) continue; seen.add(sp + h.title); headlines++;
      const p = findPlayer(index[sp], h.title); if (p) cands.push({ id: cands.length, sport: sp, player: p.name, team: p.team, title: h.title, source: h.source, date: h.date, url: h.url, status: classify(h.title), by: 'rules' });
    }
    await new Promise(r => setTimeout(r, 250));
  }
  const vague = cands.filter(c => c.status === 'unclear'), hosted = await llm(vague);
  for (const c of vague) if (hosted[c.id] && hosted[c.id] !== 'unclear') { c.status = hosted[c.id]; c.by = 'model'; }
  const items = cands.filter(c => c.status !== 'unclear').map(c => ({ sport: c.sport, player: c.player, team: c.team, status: c.status, by: c.by, title: c.title, source: c.source, date: c.date, url: c.url })).sort((a, b) => b.date.localeCompare(a.date));
  fs.writeFileSync(path.join(__dirname, 'news-data.js'), 'window.NEWS = ' + JSON.stringify({ generated: new Date().toISOString(), hours: HOURS, items }) + ';\n');
  const by = {}; for (const i of items) by[i.sport] = (by[i.sport] || 0) + 1;
  console.log('news: ' + headlines + ' headlines, ' + cands.length + ' name one known player, ' + items.length + ' with a stated status ' + JSON.stringify(by) + (process.env.ANTHROPIC_API_KEY ? ' (hosted model on)' : ' (rules only; set ANTHROPIC_API_KEY for the hosted model)'));
})();
