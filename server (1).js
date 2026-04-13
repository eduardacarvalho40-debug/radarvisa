const http  = require("http");
const https = require("https");
const fs    = require("fs");
const path  = require("path");

const PORT  = process.env.PORT || 8080;
const CHAVE = (process.env.ANTHROPIC_API_KEY || "").trim();

// ── Serve arquivos estaticos ──────────────────────────────────
function servArquivo(res, filePath) {
  if (!fs.existsSync(filePath)) {
    res.writeHead(404);
    res.end("404 - Nao encontrado");
    return;
  }
  const tipos = {
    ".html": "text/html; charset=utf-8",
    ".js":   "application/javascript",
    ".json": "application/json",
    ".css":  "text/css"
  };
  res.writeHead(200, { "Content-Type": tipos[path.extname(filePath)] || "text/plain" });
  fs.createReadStream(filePath).pipe(res);
}

// ── Busca direta no DOU ───────────────────────────────────────
function buscarDOU(data, callback) {
  // data formato: dd-MM-yyyy
  var url = "https://www.in.gov.br/leiturajornal?data=" + data + "&secao=do1";

  console.log("Buscando DOU:", url);

  var opts = {
    hostname: "www.in.gov.br",
    path: "/leiturajornal?data=" + data + "&secao=do1",
    method: "GET",
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "pt-BR,pt;q=0.9",
      "Connection": "keep-alive"
    }
  };

  var req = https.request(opts, function(res) {
    var html = "";
    res.on("data", function(c) { html += c; });
    res.on("end", function() {
      console.log("DOU respondeu status:", res.statusCode, "tamanho:", html.length);
      callback(null, html, res.statusCode);
    });
  });

  req.on("error", function(e) {
    console.log("Erro ao buscar DOU:", e.message);
    callback(e, null, 0);
  });

  req.setTimeout(15000, function() {
    req.destroy();
    callback(new Error("Timeout"), null, 0);
  });

  req.end();
}

// ── Extrai publicacoes da ANVISA do HTML do DOU ──────────────
function extrairAnvisa(html) {
  if (!html || html.length < 100) return [];

  var resultados = [];
  var vistos = {};

  // Termos HPPC para filtrar
  var termosHPPC = [
    "cosmetic", "higiene pessoal", "perfum", "protetor solar",
    "repelente", "antisseptico", "antisséptico", "alisante",
    "capilar", "maquiagem", "batom", "creme", "sabonete",
    "shampoo", "xampu", "desodorante", "gel alcoolico", "gel alcoólico",
    "hppc", "2731", "registro de produtos cosmeticos"
  ];

  // Tenta extrair via JSON embutido na pagina (Next.js / React)
  var jsonMatch = html.match(/"items"\s*:\s*(\[[\s\S]{100,50000}\])/);
  if (jsonMatch) {
    try {
      var items = JSON.parse(jsonMatch[1]);
      items.forEach(function(item) {
        var titulo  = (item.title || item.titulo || "").toLowerCase();
        var resumo  = (item.content || item.resumo || item.abstract || "").toLowerCase();
        var orgao   = (item.orgaoName || item.orgao || "").toLowerCase();
        var urlTit  = item.urlTitle || item.slugify || "";

        // So pega da ANVISA
        if (!orgao.includes("anvisa") && !titulo.includes("anvisa") && !resumo.includes("anvisa")) return;

        // Verifica se e HPPC
        var texto = titulo + " " + resumo;
        var ehHPPC = termosHPPC.some(function(t) { return texto.indexOf(t) !== -1; });
        if (!ehHPPC) return;

        var uid = urlTit || titulo.substring(0, 50);
        if (vistos[uid]) return;
        vistos[uid] = true;

        var link = urlTit
          ? "https://www.in.gov.br/web/dou/-/" + urlTit
          : "https://www.in.gov.br/consulta";

        resultados.push({
          titulo:   limpar(item.title || item.titulo || "Publicacao ANVISA"),
          empresa:  extrairEmpresa(item.content || item.title || ""),
          tipo:     classificar(item.title || "", item.content || ""),
          resumo:   limpar(item.content || item.resumo || "").substring(0, 400),
          link:     link,
          secao:    "DO1",
          data:     ""
        });
      });
    } catch(e) {
      console.log("Erro ao parsear JSON do DOU:", e.message);
    }
  }

  // Fallback: tenta extrair via regex no HTML cru
  if (resultados.length === 0) {
    var blocos = html.split(/class="[^"]*resultado[^"]*"/i);
    blocos.forEach(function(bloco, i) {
      if (i === 0) return;
      var titulo = (bloco.match(/<h[23][^>]*>([^<]{10,200})<\/h[23]>/i) || [])[1] || "";
      var texto  = titulo.toLowerCase();

      if (!texto.includes("anvisa")) return;
      var ehHPPC = termosHPPC.some(function(t) { return texto.indexOf(t) !== -1; });
      if (!ehHPPC) return;

      resultados.push({
        titulo:  limpar(titulo),
        empresa: extrairEmpresa(titulo),
        tipo:    classificar(titulo, ""),
        resumo:  "",
        link:    "https://www.in.gov.br/consulta",
        secao:   "DO1",
        data:    ""
      });
    });
  }

  console.log("Publicacoes HPPC encontradas:", resultados.length);
  return resultados;
}

// ── Busca via API do DOU (endpoint de busca) ──────────────────
function buscarAPIDOU(dataAPI, callback) {
  // Tenta o endpoint de busca oficial
  var termos = ["cosmeticos ANVISA", "protetor solar ANVISA", "repelente ANVISA"];
  var todos = [];
  var vistos = {};
  var idx = 0;

  function proxima() {
    if (idx >= termos.length) {
      callback(null, todos);
      return;
    }

    var termo = termos[idx++];
    var query = encodeURIComponent(termo);
    var pathBusca = "/consulta/-/buscar/dou?q=" + query + "&s=do1&exactDate=" + encodeURIComponent(dataAPI) + "&delta=20&currentPage=1";

    var opts = {
      hostname: "www.in.gov.br",
      path: pathBusca,
      method: "GET",
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Accept": "application/json, text/html"
      }
    };

    var req = https.request(opts, function(res) {
      var data = "";
      res.on("data", function(c) { data += c; });
      res.on("end", function() {
        try {
          var json = JSON.parse(data);
          var hits = [];
          if (json.hits && json.hits.hits) hits = json.hits.hits;
          else if (json.content) hits = json.content;
          else if (Array.isArray(json)) hits = json;

          hits.forEach(function(h) {
            var src = h._source || h;
            var uid = src.urlTitle || src.title || (idx + "_" + Math.random());
            if (vistos[uid]) return;
            vistos[uid] = true;

            var titulo = limpar(src.title || src.titulo || "");
            var resumo = limpar(src.content || src.resumo || "");
            var orgao  = (src.orgaoName || src.orgao || "").toLowerCase();

            if (!orgao.includes("anvisa") && !titulo.toLowerCase().includes("anvisa")) return;

            todos.push({
              titulo:  titulo || "Publicacao ANVISA",
              empresa: extrairEmpresa(titulo + " " + resumo),
              tipo:    classificar(titulo, resumo),
              resumo:  resumo.substring(0, 400),
              link:    src.urlTitle ? "https://www.in.gov.br/web/dou/-/" + src.urlTitle : "https://www.in.gov.br/consulta",
              secao:   src.pubName || "DO1",
              data:    ""
            });
          });
        } catch(e) {}

        setTimeout(proxima, 400);
      });
    });

    req.on("error", function() { setTimeout(proxima, 400); });
    req.setTimeout(10000, function() { req.destroy(); setTimeout(proxima, 400); });
    req.end();
  }

  proxima();
}

// ── Helpers ───────────────────────────────────────────────────
function limpar(s) {
  return (s || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function extrairEmpresa(texto) {
  var m = texto.match(/([A-ZÀÁÂÃÉÊÍÓÔÕÚÇ][A-ZÀÁÂÃÉÊÍÓÔÕÚÇ\s]{3,60}(?:LTDA|S\.A\.|EIRELI|S\/A|EPP|ME)\.?)/i);
  return m ? m[1].trim().substring(0, 80) : "";
}

function classificar(titulo, resumo) {
  var t = (titulo + " " + resumo).toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  if (t.includes("2731") || (t.includes("registro") && t.includes("concess"))) return "Registro Novo";
  if (t.includes("238") || t.includes("revalida")) return "Revalidacao";
  if (t.includes("235") || t.includes("cancelamento")) return "Cancelamento";
  if (t.includes("230") || t.includes("formula")) return "Modificacao Formula";
  if (t.includes("289") || t.includes("rotulagem")) return "Alteracao Rotulagem";
  if (t.includes("indeferid")) return "Indeferido";
  return "Publicacao ANVISA";
}

// ── Servidor HTTP ─────────────────────────────────────────────
const server = http.createServer(function(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  // ── Rota: busca direta no DOU ──
  if (req.url.startsWith("/buscar-dou") && req.method === "GET") {
    var urlParams = new URL("http://x" + req.url);
    var dataParam = urlParams.searchParams.get("data"); // dd/MM/yyyy
    var dataISO   = urlParams.searchParams.get("dataISO"); // yyyy-MM-dd

    if (!dataParam) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Parametro data obrigatorio" }));
      return;
    }

    // Converte dd/MM/yyyy para dd-MM-yyyy para a API do DOU
    var partes  = dataParam.split("/");
    var dataAPI = partes[0] + "-" + partes[1] + "-" + partes[2];

    console.log("Buscando DOU para data:", dataParam);

    // Tenta primeiro a API de busca do DOU
    buscarAPIDOU(dataAPI, function(err, resultados) {
      if (err || resultados.length === 0) {
        // Fallback: tenta leitura direta da pagina
        buscarDOU(dataAPI, function(err2, html, status) {
          if (err2 || status !== 200) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
              publicacoes: [],
              total: 0,
              fonte: "dou_direto",
              erro: err2 ? err2.message : "status " + status
            }));
            return;
          }

          var pubs = extrairAnvisa(html);
          pubs.forEach(function(p) { p.data = dataParam; });

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            publicacoes: pubs,
            total: pubs.length,
            fonte: "dou_html"
          }));
        });
      } else {
        resultados.forEach(function(p) { p.data = dataParam; });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          publicacoes: resultados,
          total: resultados.length,
          fonte: "dou_api"
        }));
      }
    });
    return;
  }

  // ── Rota: proxy Claude (fallback para analise) ──
  if (req.url === "/api/claude" && req.method === "POST") {
    if (!CHAVE) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "SEM_CHAVE" }));
      return;
    }

    let body = "";
    req.on("data", function(c) { body += c; });
    req.on("end", function() {
      let parsed;
      try { parsed = JSON.parse(body); } catch(e) {
        res.writeHead(400); res.end(JSON.stringify({ error: "JSON invalido" })); return;
      }

      parsed.model = "claude-sonnet-4-6";
      if (!parsed.max_tokens || parsed.max_tokens > 4096) parsed.max_tokens = 4096;

      // Remove tools para evitar rate limit alto
      delete parsed.tools;

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
          if (apiRes.statusCode !== 200) {
            console.log("Erro Anthropic", apiRes.statusCode, dados.substring(0, 300));
          }
          res.writeHead(apiRes.statusCode, { "Content-Type": "application/json" });
          res.end(dados);
        });
      });

      proxy.on("error", function(err) {
        res.writeHead(500); res.end(JSON.stringify({ error: err.message }));
      });

      proxy.write(bodyFinal);
      proxy.end();
    });
    return;
  }

  // ── Serve arquivos estaticos ──
  const arquivo = req.url === "/" ? "/index.html" : req.url;
  servArquivo(res, path.join(__dirname, arquivo));
});

server.listen(PORT, "0.0.0.0", function() {
  console.log("RadarVisa v2 rodando na porta " + PORT);
  console.log("Chave API: " + (CHAVE ? "OK" : "NAO CONFIGURADA"));
  console.log("Modo: Busca direta no DOU + fallback Claude");
});
