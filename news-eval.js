// Scores the headline reader against the hand-labelled headlines in news-labels.json (o = out, d = doubtful, q = questionable, p = playing, u = unclear).
// Usage: node news-eval.js          rules only
//        ANTHROPIC_API_KEY=... node news-eval.js   also scores the hosted model on the headlines the rules left unclear
// The labels are one person's judgement on 37 headlines from 14 Nov 2026: treat small differences as noise, and add labels as you review the chips.
'use strict';
const fs = require('fs'), path = require('path'), { classify } = require('./fetch-news.js');
const L = JSON.parse(fs.readFileSync(path.join(__dirname, 'news-labels.json'), 'utf8')), map = { out: 'o', doubtful: 'q', questionable: 'q', playing: 'p', unclear: 'u' };
(async () => {
  const rules = L.map(x => map[classify(x.title)]), lab = L.map(x => x.label === 'd' ? 'q' : x.label), dec = L.map((x, i) => i).filter(i => lab[i] !== 'u'), vag = L.map((x, i) => i).filter(i => lab[i] === 'u');
  const rep = (name, got) => console.log(name.padEnd(20), 'decisive headlines right ' + dec.filter(i => got[i] === lab[i]).length + '/' + dec.length, '| vague headlines wrongly decided ' + vag.filter(i => got[i] !== 'u').length + '/' + vag.length,
    '| called OUT wrongly ' + L.filter((x, i) => got[i] === 'o' && lab[i] !== 'o').length, '| missed a real OUT ' + L.filter((x, i) => lab[i] === 'o' && got[i] !== 'o').length);
  rep('keyword rules', rules);
  if (process.env.ANTHROPIC_API_KEY) {
    const key = process.env.ANTHROPIC_API_KEY, items = L.map((x, i) => ({ i, x })).filter(o => rules[o.i] === 'u');
    const SYS = 'You read sports headlines and report ONE named player\'s availability for his team\'s NEXT game, using only what the headline says. For each numbered item answer exactly one of: OUT, DOUBTFUL, QUESTIONABLE, PLAYING, UNCLEAR (the headline does not state his availability). When in doubt answer UNCLEAR. Reply with JSON only: {"1":"OUT",...}';
    const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, body: JSON.stringify({ model: 'claude-haiku-5-5', max_tokens: 800, system: SYS, messages: [{ role: 'user', content: items.map((o, k) => (k + 1) + '. Player: ' + o.x.player + ' | Headline: ' + o.x.title).join('\n') }] }) });
    const j = await r.json(), a = JSON.parse(/\{[\s\S]*\}/.exec((j.content && j.content[0].text) || '{}')[0]), both = rules.slice();
    items.forEach((o, k) => { const v = String(a[k + 1] || 'UNCLEAR').toUpperCase(); both[o.i] = v === 'OUT' ? 'o' : v === 'DOUBTFUL' || v === 'QUESTIONABLE' ? 'q' : v === 'PLAYING' ? 'p' : 'u'; });
    rep('rules + hosted model', both);
  } else console.log('(no ANTHROPIC_API_KEY set: hosted model not scored)');
})();
