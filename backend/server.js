"use strict";

/* =====================================================================
   Биопаспорт · HTTP-обёртка для Railway (и любого хоста с постоянным
   процессом). Превращает входящий HTTP-запрос в тот же event-объект,
   который ждёт наш handler из index.js (формат Yandex Cloud Function),
   и слушает порт из $PORT. Логику не меняем — переиспользуем как есть.
   ===================================================================== */

const http = require("http");
const { handler } = require("./index.js");

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", async () => {
    const body = Buffer.concat(chunks).toString("utf8");
    const url = new URL(req.url, "http://localhost");
    const event = {
      httpMethod: req.method,
      queryStringParameters: Object.fromEntries(url.searchParams),
      headers: req.headers, // нужно для проверки секрета вебхука Telegram
      body,
      isBase64Encoded: false,
    };
    try {
      const result = await handler(event);
      res.writeHead(result.statusCode || 200, result.headers || {});
      res.end(result.body || "");
    } catch (e) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: String((e && e.message) || e) }));
    }
  });
});

server.listen(PORT, () => console.log("[biopassport] listening on :" + PORT));
