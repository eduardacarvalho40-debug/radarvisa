const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8080;
const CHAVE = process.env.ANTHROPIC_API_KEY || null;

http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.url === '/api/claude' && req.method === 'POST') {
    if (!CHAVE) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'SEM_CHAVE' }));
      return;
    }
    let body = '';
    req.on('data', function(c) { body += c; });
    req.on('end', function() {
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
      const p = https.request(opt, function(r) {
        let d = '';
        r.on('data', function(c) { d += c; });
        r.on('end', function() {
          res.writeHead(r.statusCode, { 'Content-Type': 'application/json' });
          res.end(d);
        });
      });
      p.on('error', function(e) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: e.message }));
      });
      p.write(body);
      p.end();
    });
    return;
  }

  var file = req.url === '/' ? '/index.html' : req.url;
  file = path.join(__dirname, file);
  if (!fs.existsSync(file)) {
    res.writeHead(404);
    res.end('404');
    return;
  }
  var mime = { '.html': 'text/html', '.js': 'application/javascript', '.json': 'application/js
