const https = require("https");
const http = require("http");
const { URL } = require("url");

module.exports = (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const parsed = new URL(req.url, `https://${req.headers.host}`);
  const target = parsed.searchParams.get("url");
  if (!target) {
    res.writeHead(400);
    res.end("url 파라미터 필요");
    return;
  }

  let targetUrl;
  try {
    targetUrl = new URL(target);
  } catch {
    res.writeHead(400);
    res.end("잘못된 url");
    return;
  }

  const lib = targetUrl.protocol === "https:" ? https : http;
  const options = {
    hostname: targetUrl.hostname,
    port: targetUrl.port || (targetUrl.protocol === "https:" ? 443 : 80),
    path: targetUrl.pathname + targetUrl.search,
    method: "GET",
    headers: {
      Accept: "*/*",
      "User-Agent": "Mozilla/5.0",
    },
  };

  const proxy = lib.request(options, (apiRes) => {
    res.writeHead(apiRes.statusCode, {
      "Content-Type": "application/json; charset=utf-8",
    });
    apiRes.pipe(res);
  });

  proxy.on("error", (e) => {
    res.writeHead(500);
    res.end(JSON.stringify({ error: e.message }));
  });

  proxy.end();
};
