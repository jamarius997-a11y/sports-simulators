// Minimal CSV reader that handles quoted fields (some nflverse columns contain commas).
'use strict';
const fs = require('fs');
function parse(text) {
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n') { row.push(f.replace('\r', '')); rows.push(row); row = []; f = ''; }
    else f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  return rows;
}
// -> array of objects keyed by header (first occurrence wins for duplicate column names)
function read(file) {
  const t = parse(fs.readFileSync(file, 'utf8')), h = t[0];
  return t.slice(1).filter(v => v.length === h.length).map(v => { const o = {}; h.forEach((k, i) => { if (!(k in o)) o[k] = v[i]; }); return o; });
}
module.exports = { parse, read };
