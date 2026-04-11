/**
 * RadarReg — Servidor local
 * Resolve CORS e faz proxy seguro para a API Anthropic
 * 
 * Como usar:
 *   1. Coloque sua chave API no arquivo .env (ANTHROPIC_API_KEY=sk-ant-...)
 *   2. Execute: node server.js
 *   3. Acesse: http://localhost:3000
 */

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const url   = require('url');

// ── Lê a chave do .env ──────────────────────
function lerChave() {
  return process.env.ANTHROPIC_API_KEY || null;
}
const PORT = process.env.PORT || 3000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
};

// ── Servidor ────────────────────────────────
const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);

  // CORS para tudo
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204); res.end(); return;
  }

  // ── PROXY para a API Anthropic ──
  if (parsed.pathname === '/api/claude' && req.method === 'POST') {
    const chave = lerChave();

    if (!chave) {
      res.writeHead(500, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({
        error: 'CHAVE_NAO_ENCONTRADA',
        mensagem: 'Crie o arquivo .env com: ANTHROPIC_API_KEY=sua-chave-aqui'
      }));
      return;
    }

    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      const options = {
        hostname: 'api.anthropic.com',
        path:     '/v1/messages',
        method:   'POST',
        headers: {
          'Content-Type':      'application/json',
          'x-api-key':         chave,
          'anthropic-version': '2023-06-01',
          'anthropic-beta':    'web-search-20250305',
          'Content-Length':    Buffer.byteLength(body)
        }
      };

      const proxy = https.request(options, apiRes => {
        let data = '';
        apiRes.on('data', chunk => data += chunk);
        apiRes.on('end', () => {
          res.writeHead(apiRes.statusCode, {'Content-Type': 'application/json'});
          res.end(data);
        });
      });

      proxy.on('error', err => {
        res.writeHead(500, {'Content-Type': 'application/json'});
        res.end(JSON.stringify({ error: err.message }));
      });

      proxy.write(body);
      proxy.end();
    });
    return;
  }

  // ── Serve arquivos estáticos ──
  let filePath = parsed.pathname === '/' ? '/index.html' : parsed.pathname;
  filePath = path.join(__dirname, filePath);

  if (!fs.existsSync(filePath)) {
    res.writeHead(404); res.end('Não encontrado'); return;
  }

  const ext  = path.extname(filePath);
  const mime = MIME[ext] || 'text/plain';
  res.writeHead(200, {'Content-Type': mime});
  fs.createReadStream(filePath).pipe(res);
});

server.listen(PORT, () => {
  console.log('');
  console.log('  ╔══════════════════════════════════════╗');
  console.log('  ║         RadarReg  iniciado!          ║');
  console.log('  ╠══════════════════════════════════════╣');
  console.log('  ║  Acesse: http://localhost:' + PORT + '        ║');
  console.log('  ╚══════════════════════════════════════╝');
  console.log('');

  const chave = lerChave();
  if (!chave) {
    console.log('  ⚠️  CHAVE NÃO ENCONTRADA!');
    console.log('  Crie o arquivo .env com o conteúdo:');
    console.log('  ANTHROPIC_API_KEY=sk-ant-sua-chave-aqui');
    console.log('');
  } else {
    console.log('  ✅ Chave API carregada');
    console.log('  ✅ Pronto para buscar no DOU');
    console.log('');
  }

  // Abre o navegador automaticamente
});
