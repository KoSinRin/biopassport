"use strict";

/* =====================================================================
   Биопаспорт · бэкенд (Yandex Cloud Function, Node.js 18)
   Один публичный обработчик на три задачи (роутинг по ?action и телу):
     • ?action=upload  — принять PNG (base64) → положить в Object Storage → вернуть публичный URL
     • ?action=invoice — создать ссылку на оплату Telegram Stars (createInvoiceLink)
     • без action      — вебхук Telegram (отвечаем на pre_checkout_query)
   Точка входа: index.handler
   ===================================================================== */

const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const crypto = require("crypto");

const {
  BOT_TOKEN,
  S3_KEY_ID,
  S3_SECRET,
  S3_BUCKET = "biopassport",
  S3_ENDPOINT = "https://storage.yandexcloud.net",
  S3_REGION = "ru-central1",
  PRICE_STARS = "20",
} = process.env;

const s3 = new S3Client({
  region: S3_REGION,
  endpoint: S3_ENDPOINT,
  credentials: { accessKeyId: S3_KEY_ID, secretAccessKey: S3_SECRET },
});

function tg(method, payload) {
  return fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  }).then((r) => r.json());
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type",
};

function json(statusCode, obj) {
  return { statusCode, headers: { "content-type": "application/json", ...CORS }, body: JSON.stringify(obj) };
}

exports.handler = async (event) => {
  const method = (event && event.httpMethod) || "POST";
  if (method === "OPTIONS") return { statusCode: 204, headers: CORS, body: "" };

  const q = (event && event.queryStringParameters) || {};
  const rawBody =
    event && event.isBase64Encoded && event.body
      ? Buffer.from(event.body, "base64").toString("utf8")
      : (event && event.body) || "";

  // ---- 1) Загрузка PNG → публичный URL ----
  if (q.action === "upload") {
    try {
      const data = JSON.parse(rawBody);
      const png = Buffer.from(String(data.image || ""), "base64");
      if (!png.length) return json(400, { error: "empty image" });
      const key = `cards/${Date.now()}-${crypto.randomBytes(4).toString("hex")}.png`;
      await s3.send(new PutObjectCommand({ Bucket: S3_BUCKET, Key: key, Body: png, ContentType: "image/png" }));
      return json(200, { url: `${S3_ENDPOINT}/${S3_BUCKET}/${key}` });
    } catch (e) {
      return json(500, { error: String(e && e.message || e) });
    }
  }

  // ---- 2) Ссылка на оплату Telegram Stars ----
  if (q.action === "invoice") {
    const res = await tg("createInvoiceLink", {
      title: "Полный биопаспорт",
      description: "Все биомаркеры и способности + сохранение в PDF",
      payload: "biopassport_full",
      currency: "XTR", // Telegram Stars
      prices: [{ label: "Полный паспорт", amount: Number(PRICE_STARS) }],
    });
    if (!res.ok) return json(500, { error: res.description });
    return json(200, { link: res.result });
  }

  // ---- 3) Вебхук Telegram ----
  try {
    const update = JSON.parse(rawBody);
    if (update.pre_checkout_query) {
      // обязательно подтвердить в течение 10 секунд, иначе оплата отменится
      await tg("answerPreCheckoutQuery", { pre_checkout_query_id: update.pre_checkout_query.id, ok: true });
    }
    // update.message.successful_payment — для MVP не храним: факт оплаты клиент узнаёт из tg.openInvoice()
  } catch (e) {
    /* не телеграм-апдейт — игнорируем */
  }
  return json(200, { ok: true });
};
