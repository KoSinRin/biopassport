"use strict";

/* =====================================================================
   Биопаспорт · бэкенд (Yandex Cloud Function, Node.js 18)
   Один публичный обработчик на три задачи (роутинг по ?action и телу):
     • ?action=upload  — принять PNG (base64) → положить в Object Storage → вернуть публичный URL
     • ?action=invoice — создать ссылку на оплату Telegram Stars (createInvoiceLink)
     • без action      — вебхук Telegram (отвечаем на pre_checkout_query)
   Точка входа: index.handler
   ===================================================================== */

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

// Ленивая инициализация S3: тяжёлый @aws-sdk грузится только при загрузке картинки,
// чтобы холодный старт вебхука/оплаты был быстрым (pre_checkout_query надо успеть за 10 сек).
let _s3 = null;
function getS3() {
  if (!_s3) {
    const { S3Client } = require("@aws-sdk/client-s3");
    _s3 = new S3Client({
      region: S3_REGION,
      endpoint: S3_ENDPOINT,
      credentials: { accessKeyId: (S3_KEY_ID || "").trim(), secretAccessKey: (S3_SECRET || "").trim() },
      forcePathStyle: true,
      // Yandex Object Storage не поддерживает новые flexible-checksums из свежего aws-sdk —
      // иначе PutObject падает с "signature does not match". Отключаем их.
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    });
  }
  return _s3;
}

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
      const { PutObjectCommand } = require("@aws-sdk/client-s3");
      await getS3().send(new PutObjectCommand({ Bucket: S3_BUCKET, Key: key, Body: png, ContentType: "image/png" }));
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
    console.log("[webhook] keys=", Object.keys(update).join(","));
    if (update.pre_checkout_query) {
      // обязательно подтвердить в течение 10 секунд, иначе оплата отменится
      const ans = await tg("answerPreCheckoutQuery", { pre_checkout_query_id: update.pre_checkout_query.id, ok: true });
      console.log("[pre_checkout] answer=", JSON.stringify(ans));
    }
    // Факт оплаты клиент узнаёт из tg.openInvoice(). В тестовом режиме (AUTO_REFUND=1)
    // сразу возвращаем звёзды, чтобы гонять оплату по кругу без потерь.
    const sp = update.message && update.message.successful_payment;
    if (sp) {
      console.log("[successful_payment] charge=", sp.telegram_payment_charge_id);
      if (process.env.AUTO_REFUND === "1") {
        const ref = await tg("refundStarPayment", {
          user_id: update.message.from.id,
          telegram_payment_charge_id: sp.telegram_payment_charge_id,
        });
        console.log("[refund] result=", JSON.stringify(ref));
      }
    }
  } catch (e) {
    console.error("[webhook] parse/handle error:", e && e.message, "| rawHead=", String(rawBody).slice(0, 120));
  }
  return json(200, { ok: true });
};
