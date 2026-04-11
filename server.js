const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const PORT  = process.env.PORT || 8080;
const CHAVE = process.env.ANTHROPIC_API_KEY || null;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
};

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.url === '/api/claude' && req.method === 'POST') {
    if (!CHAVE) {
      res.writeHead(500, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({ error: 'SEM_CHAVE' }));
      return;
    }
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      const opt = {
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': CHAVE,
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'web-search-20250305',
          'Content-Length': Buffer.byteLength(body)
        }
      };
      const p = https.request(opt, r => {
        let d = '';
        r.on('data', c => d += c);
        r.on('end', () => { res.writeHead(r.statusCode, {'Content-Type':'application/json'}); res.end(d); });
      });
      p.on('error', e => { res.writeHead(500); res.end(JSON.stringify({error:e.message})); });
      p.write(body); p.end();
    });
    return;
  }

  let file = req.url === '/' ? '/index.html' : req.url;
  file = path.join(__dirname, file);
  if (!fs.existsSync(file)) { res.writeHead(404); res.end('404'); return; }
  const ext = path.extname(file);
  res.writeHead(200, {'Content-Type': MIME[ext] || 'text/plain'});
  fs.createReadStream(file).pipe(res);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('RadarVisa rodando na porta ' + PORT);
  console.log('Chave: ' + (CHAVE ? 'OK' : 'NAO ENCONTRADA'));
});

  // Abre o navegador automaticamente
});
