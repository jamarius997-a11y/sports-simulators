// Tiny static server so the page can be opened at http://localhost:8123 (node serve.js)
const http = require('http'), fs = require('fs'), path = require('path');
const T = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json' };
http.createServer((q, r) => {
  const f = path.join(__dirname, q.url.split('?')[0] === '/' ? 'index.html' : decodeURIComponent(q.url.split('?')[0]));
  if (!f.startsWith(__dirname) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); return r.end(); }
  r.writeHead(200, { 'Content-Type': T[path.extname(f)] || 'text/plain' }); fs.createReadStream(f).pipe(r);
}).listen(8123, () => console.log('http://localhost:8123'));
