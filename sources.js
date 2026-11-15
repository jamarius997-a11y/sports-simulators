// Extra data sources beyond ESPN. Each reader returns plain data and never throws (a failed source just returns nothing).
//   nflOfficial()  the NFL's own injury report (nfl.com/injuries): practice and game status for every listed player this week
// Not used on purpose: the NBA's official injury PDFs (official.nba.com refuses automated requests with "Access Denied"), and the SEC / Big Ten /
// Big 12 availability pages (the SEC's loads its reports by script and showed none; the others have no public page).
'use strict';
const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36' };
const decode = s => String(s).replace(/&amp;/g, '&').replace(/&#0?39;|&#x27;|&apos;|&rsquo;/g, "'").replace(/&quot;/g, '"').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const snapName = x => String(x).toLowerCase().replace(/\b(jr|sr|ii|iii|iv|v)\b\.?/g, '').replace(/[^a-z]/g, '');

async function text(url, ms) {
  try { const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(ms || 30000) }); return r.ok ? await r.text() : null; } catch (e) { return null; }
}

// -> { teamNickname: [{ name, pos, injury, practice, game }] } (game is "Out", "Doubtful", "Questionable" or "" when none is set yet)
function parseNfl(html) {
  const out = {}; let team = null;
  const re = /<div class="d3-o-section-sub-title"><span>([^<]+)<\/span><\/div>|<tr><td scope="row"[^>]*>([\s\S]*?)<\/td><td>([\s\S]*?)<\/td><td>([\s\S]*?)<\/td><td>([\s\S]*?)<\/td><td>([\s\S]*?)<\/td><\/tr>/g;
  for (const m of html.matchAll(re)) {
    if (m[1]) { team = decode(m[1]); out[team] = out[team] || []; continue; }
    if (!team) continue;
    out[team].push({ name: decode(m[2]), pos: decode(m[3]), injury: decode(m[4]), practice: decode(m[5]), game: decode(m[6]) });
  }
  return out;
}
async function nflOfficial() {
  const html = await text('https://www.nfl.com/injuries/');
  if (!html) return null;
  const t = parseNfl(html); return Object.keys(t).length >= 10 ? t : null;   // fewer than 10 teams means the page layout changed: use nothing
}

module.exports = { nflOfficial, parseNfl, snapName, decode, text, UA };
