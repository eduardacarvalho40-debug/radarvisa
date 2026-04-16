const http  = require("http");
const https = require("https");
const fs    = require("fs");
const path  = require("path");

const PORT  = process.env.PORT || 8080;
const CHAVE = (process.env.ANTHROPIC_API_KEY || "").trim();

function servArquivo(res, filePath) {
  if (!fs.existsSync(filePath)) { res.writeHead(404); res.end("404"); return; }
  const tipos = { ".html":"text/html;charset=utf-8", ".js":"application/javascript", ".json":"application/json", ".css":"text/css" };
  res.writeHead(200, { "Content-Type": tipos[path.extname(filePath)] || "text/plain" });
  fs.createReadStream(filePath).pipe(res);
}

// ── Busca o DOU e extrai jsonArray do script embutido ─────────
function buscarDOU(dataAPI, callback) {
  var opts = {
    hostname: "www.in.gov.br",
    path: "/leiturajornal?data=" + dataAPI + "&secao=do1",
    method: "GET",
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0",
      "Accept": "text/html,application/xhtml+xml",
      "Accept-Language": "pt-BR,pt;q=0.9",
      "Cache-Control": "no-cache"
    }
  };

  var req = https.request(opts, function(res) {
    var chunks = [];
    res.on("data", function(c) { chunks.push(c); });
    res.on("end", function() {
      var html = Buffer.concat(chunks).toString("utf8");
      console.log("DOU status:", res.statusCode, "tamanho:", html.length);
      callback(null, html, res.statusCode);
    });
  });

  req.on("error", function(e) { callback(e, null, 0); });
  req.setTimeout(20000, function() { req.destroy(); callback(new Error("Timeout"), null, 0); });
  req.end();
}

// ── Extrai publicacoes ANVISA/HPPC do HTML ────────────────────
function extrairPublicacoes(html, dataExib) {
  if (!html || html.length < 500) return [];

  var resultados = [];
  var vistos = {};

  // Frases exatas que a ANVISA usa nas resolucoes de cosmeticos
  var frasesExatas = [
    "deferir os registros e as peticoes dos produtos de higiene pessoal, cosmeticos e perfumes",
    "indeferir os registros e as peticoes dos produtos de higiene pessoal, cosmeticos e perfumes",
    "cancelar os registros e as peticoes dos produtos de higiene pessoal, cosmeticos e perfumes",
    "produtos de higiene pessoal, cosmeticos e perfumes",
    "registro de produtos cosmeticos",
    "reg. cosmeticos"
  ];

  var termosHPPC = [
    "cosmet", "higiene pessoal", "perfum", "protetor solar",
    "repelente", "antissept", "alisante", "capilar",
    "maquiagem", "batom", "creme", "sabonete", "shampoo",
    "xampu", "desodorante", "gel alcool", "pomada",
    "hppc", "2731"
  ];

  // Termos que EXCLUEM a publicacao (saneantes, medicamentos, etc)
  var termosExcluir = [
    "saneante", "medicamento", "farmaceutico", "dispositivo medico",
    "alimento", "agrotox", "fumigeno"
  ];

  // Estrategia 1: extrai do script application/json (formato Next.js do DOU)
  // O DOU injeta os dados em <script id="__NEXT_DATA__" type="application/json">
  var nextDataMatch = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
  if (nextDataMatch) {
    try {
      var nextData = JSON.parse(nextDataMatch[1]);
      // Navega pela estrutura do Next.js
      var props = nextData.props || {};
      var pageProps = props.pageProps || {};
      var items = pageProps.jsonArray || pageProps.items || pageProps.content || [];

      if (!Array.isArray(items) && pageProps.data) {
        items = pageProps.data.jsonArray || pageProps.data.items || [];
      }

      console.log("__NEXT_DATA__ encontrado, items:", items.length);

      items.forEach(function(item) {
        processar(item, dataExib, termosHPPC, vistos, resultados);
      });
    } catch(e) {
      console.log("Erro __NEXT_DATA__:", e.message);
    }
  }

  // Estrategia 2: procura jsonArray em qualquer script
  if (resultados.length === 0) {
    var scriptMatches = html.match(/<script[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/gi);
    if (scriptMatches) {
      scriptMatches.forEach(function(script) {
        if (resultados.length > 0) return;
        try {
          var content = script.replace(/<script[^>]*>/i, "").replace(/<\/script>/i, "");
          var json = JSON.parse(content);
          var items = [];
          if (Array.isArray(json)) items = json;
          else if (json.jsonArray) items = json.jsonArray;
          else if (json.items) items = json.items;

          console.log("Script JSON encontrado, items:", items.length);
          if (items.length > 0) {
            var amostra = items[0];
            console.log("AMOSTRA item[0] keys:", Object.keys(amostra).join(","));
            console.log("AMOSTRA title:", (amostra.title || amostra.titulo || "SEM TITULO").substring(0,80));
            console.log("AMOSTRA orgao:", (amostra.orgaoName || amostra.orgao || amostra.hierarchyStr || "SEM ORGAO").substring(0,80));
          }
          items.forEach(function(item) {
            processar(item, dataExib, termosHPPC, vistos, resultados);
          });
        } catch(e) {}
      });
    }
  }

  // Estrategia 3: regex direto para encontrar jsonArray
  if (resultados.length === 0) {
    var jaMatch = html.match(/jsonArray["\s]*:\s*(\[[\s\S]{10,}\])/);
    if (jaMatch) {
      try {
        // Limita o tamanho para evitar JSON invalido
        var jsonStr = jaMatch[1];
        // Encontra o fim do array balanceando colchetes
        var depth = 0;
        var end = 0;
        for (var i = 0; i < jsonStr.length; i++) {
          if (jsonStr[i] === "[") depth++;
          else if (jsonStr[i] === "]") { depth--; if (depth === 0) { end = i + 1; break; } }
        }
        var items = JSON.parse(jsonStr.substring(0, end));
        console.log("jsonArray regex, items:", items.length);
        items.forEach(function(item) {
          processar(item, dataExib, termosHPPC, vistos, resultados);
        });
      } catch(e) {
        console.log("Erro jsonArray regex:", e.message.substring(0, 100));
      }
    }
  }

  console.log("Total HPPC encontrado:", resultados.length);
  return resultados;
}

function processar(item, dataExib, termosHPPC, vistos, resultados) {
  var titulo  = limpar(item.title || item.titulo || "");
  var resumo  = limpar(item.content || item.resumo || item.abstract || item.artBody || "");
  // hierarchyStr e o campo correto do DOU: "Ministerio da Saude/Agencia Nacional de Vigilancia Sanitaria/..."
  var orgao   = (item.hierarchyStr || item.hierarchyList || item.orgaoName || item.orgao || "").toLowerCase();
  var urlTit  = item.urlTitle || item.slugify || "";
  var secao   = item.pubName || item.secao || "DO1";

  // Filtra: precisa ser da ANVISA
  var textoCompleto = (titulo + " " + resumo + " " + orgao).toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  var ehAnvisa = textoCompleto.includes("anvisa") ||
                 textoCompleto.includes("vigilancia sanitaria") ||
                 textoCompleto.includes("agencia nacional de vigilancia");
  if (!ehAnvisa) return;

  // LOG: mostra os primeiros 5 itens da ANVISA para debug
  if (Object.keys(vistos).length < 5) {
    console.log("ANVISA item titulo:", titulo.substring(0,80));
    console.log("ANVISA item resumo:", resumo.substring(0,120));
    console.log("ANVISA item orgao:", orgao.substring(0,80));
  }

  var textoNorm = textoCompleto.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  var orgaoNorm = orgao.normalize("NFD").replace(/[\u0300-\u036f]/g, "");

  // ESTRATEGIA PRINCIPAL: filtra pelo orgao/hierarquia
  // A ANVISA tem setores especificos para cosmeticos:
  // "gerencia geral de cosmeticos" ou "cosmeticos e saneantes"
  var ehCosmeticosPorOrgao =
    orgaoNorm.includes("cosmeticos") ||
    orgaoNorm.includes("cosmet") ||
    orgaoNorm.includes("higiene pessoal") ||
    orgaoNorm.includes("perfumaria");

  // Exclui fumigenos (tabaco) mesmo que esteja na gerencia de cosmeticos/saneantes
  var ehFumigeno = textoNorm.includes("fumigeno") || textoNorm.includes("tabaco") || textoNorm.includes("cigarro");
  if (ehFumigeno) return;

  // Exclui saneantes puros (sem cosmeticos)
  var ehSaneantesPuro = orgaoNorm.includes("saneante") && !orgaoNorm.includes("cosmet");

  var ehHPPC = ehCosmeticosPorOrgao && !ehSaneantesPuro;

  // FALLBACK: se nao identificou pelo orgao, tenta pelo titulo/conteudo
  if (!ehHPPC) {
    var ehHPPCPorTexto = frasesExatas.some(function(t) { return textoNorm.indexOf(t) !== -1; });
    if (!ehHPPCPorTexto) ehHPPCPorTexto = termosHPPC.some(function(t) { return textoNorm.indexOf(t) !== -1; });
    if (!ehHPPCPorTexto) return;
    // Exclui saneantes e fumigenos pelo texto
    var ehExcluido = termosExcluir.some(function(t) { return textoNorm.indexOf(t) !== -1; });
    if (ehExcluido) return;
  }

  // Evita duplicatas
  var uid = urlTit || titulo.substring(0, 60);
  if (vistos[uid]) return;
  vistos[uid] = true;

  var link = urlTit
    ? "https://www.in.gov.br/web/dou/-/" + urlTit
    : "https://www.in.gov.br/consulta";

  resultados.push({
    titulo:   titulo || "Publicacao ANVISA",
    empresa:  extrairEmpresa(titulo + " " + resumo),
    tipo:     classificar(titulo, resumo),
    resumo:   resumo.substring(0, 400),
    link:     link,
    secao:    secao,
    data:     dataExib,
    orgao:    limpar(item.orgaoName || item.orgao || "ANVISA")
  });
}

function limpar(s) {
  return (s || "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
}

function extrairEmpresa(texto) {
  var m = texto.match(/([A-ZÀÁÂÃÉÊÍÓÔÕÚÇ][A-ZÀÁÂÃÉÊÍÓÔÕÚÇ\s]{3,60}(?:LTDA|S\.A\.|EIRELI|S\/A|EPP|ME)\.?)/i);
  return m ? m[1].trim().substring(0, 80) : "";
}

function classificar(titulo, resumo) {
  var t = (titulo + " " + resumo).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

  // Usa as frases exatas da ANVISA primeiro
  if (t.includes("deferir os registros") && !t.includes("indeferir")) return "Deferimento";
  if (t.includes("indeferir os registros") || t.includes("indeferimento")) return "Indeferimento";
  if (t.includes("cancelar os registros") || t.includes("cancelamento")) return "Cancelamento";

  // Fallback pelos codigos de ato
  if (t.includes("2731") || (t.includes("registro") && t.includes("concess"))) return "Deferimento";
  if (t.includes("238") || t.includes("revalida")) return "Revalidacao Automatica";
  if (t.includes("235")) return "Cancelamento";
  if (t.includes("230") || t.includes("formula")) return "Modificacao Formula";
  if (t.includes("289") || t.includes("rotulagem")) return "Alteracao Rotulagem";
  if (t.includes("2112") || t.includes("inclusao")) return "Inclusao Apresentacao";
  if (t.includes("indeferid")) return "Indeferimento";

  return "Publicacao ANVISA";
}

// ── Servidor ──────────────────────────────────────────────────
const server = http.createServer(function(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  // Rota: busca direta no DOU
  if (req.url.startsWith("/buscar-dou") && req.method === "GET") {
    var qs = req.url.split("?")[1] || "";
    var params = {};
    qs.split("&").forEach(function(p) { var kv = p.split("="); params[decodeURIComponent(kv[0])] = decodeURIComponent(kv[1] || ""); });
    var dataParam = params.data; // dd/MM/yyyy

    if (!dataParam) { res.writeHead(400); res.end(JSON.stringify({error:"Parametro data obrigatorio"})); return; }

    var partes = dataParam.split("/");
    var dataAPI = partes[0] + "-" + partes[1] + "-" + partes[2]; // dd-MM-yyyy

    buscarDOU(dataAPI, function(err, html, status) {
      if (err || status !== 200) {
        console.log("Erro DOU:", err ? err.message : "status " + status);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ publicacoes: [], total: 0, erro: err ? err.message : "status " + status }));
        return;
      }

      var pubs = extrairPublicacoes(html, dataParam);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ publicacoes: pubs, total: pubs.length, data: dataParam }));
    });
    return;
  }

  // Rota: proxy Claude
  if (req.url === "/api/claude" && req.method === "POST") {
    if (!CHAVE) { res.writeHead(500); res.end(JSON.stringify({error:"SEM_CHAVE"})); return; }
    let body = "";
    req.on("data", function(c) { body += c; });
    req.on("end", function() {
      let parsed;
      try { parsed = JSON.parse(body); } catch(e) { res.writeHead(400); res.end(JSON.stringify({error:"JSON invalido"})); return; }
      parsed.model = "claude-sonnet-4-6";
      if (!parsed.max_tokens || parsed.max_tokens > 4096) parsed.max_tokens = 4096;
      delete parsed.tools;
      const bf = JSON.stringify(parsed);
      const opcoes = {
        hostname: "api.anthropic.com", path: "/v1/messages", method: "POST",
        headers: { "Content-Type":"application/json", "x-api-key":CHAVE, "anthropic-version":"2023-06-01", "Content-Length":Buffer.byteLength(bf) }
      };
      const proxy = https.request(opcoes, function(apiRes) {
        let dados = "";
        apiRes.on("data", function(c) { dados += c; });
        apiRes.on("end", function() {
          if (apiRes.statusCode !== 200) console.log("Erro Anthropic", apiRes.statusCode, dados.substring(0,200));
          res.writeHead(apiRes.statusCode, {"Content-Type":"application/json"});
          res.end(dados);
        });
      });
      proxy.on("error", function(e) { res.writeHead(500); res.end(JSON.stringify({error:e.message})); });
      proxy.write(bf); proxy.end();
    });
    return;
  }

  servArquivo(res, path.join(__dirname, req.url === "/" ? "/index.html" : req.url));
});

server.listen(PORT, "0.0.0.0", function() {
  console.log("RadarVisa v3 na porta " + PORT);
  console.log("Chave API: " + (CHAVE ? "OK" : "NAO CONFIGURADA"));
});
