const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 8080;
const CHAVE = (process.env.ANTHROPIC_API_KEY || "").trim();

function servArquivo(res, filePath) {
  if (!fs.existsSync(filePath)) {
    res.writeHead(404);
    res.end("404 - Nao encontrado");
    return;
  }
  const ext = path.extname(filePath);
  const tipos = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript",
    ".json": "application/json",
    ".css": "text/css"
  };
  const tipo = tipos[ext] || "text/plain";
  res.writeHead(200, { "Content-Type": tipo });
  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer(function(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.url === "/api/claude" && req.method === "POST") {
    if (!CHAVE) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "SEM_CHAVE" }));
      return;
    }

    let body = "";
    req.on("data", function(chunk) { body += chunk; });
    req.on("end", function() {

      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch(e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "JSON invalido" }));
        return;
      }

      parsed.model = "claude-sonnet-4-6";
      const bodyFinal = JSON.stringify(parsed);

      const opcoes = {
        hostname: "api.anthropic.com",
        path: "/v1/messages",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": CHAVE,
          "anthropic-version": "2023-06-01",
          "Content-Length": Buffer.byteLength(bodyFinal)
        }
      };

      const proxy = https.request(opcoes, function(apiRes) {
        let dados = "";
        apiRes.on("data", function(c) { dados += c; });
        apiRes.on("end", function() {
          res.writeHead(apiRes.statusCode, { "Content-Type": "application/json" });
          res.end(dados);
        });
      });

      proxy.on("error", function(err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      });

      proxy.write(bodyFinal);
      proxy.end();
    });
    return;
  }

  const arquivo = req.url === "/" ? "/index.html" : req.url;
  servArquivo(res, path.join(__dirname, arquivo));
});

server.listen(PORT, "0.0.0.0", function() {
  console.log("RadarVisa rodando na porta " + PORT);
  console.log("Chave API: " + (CHAVE ? "OK" : "NAO ENCONTRADA"));
});
