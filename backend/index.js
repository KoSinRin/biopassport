"use strict";

/* =====================================================================
   Биопаспорт · бэкенд (Yandex Cloud Function, Node.js 22)
   Один публичный обработчик на три задачи (роутинг по ?action и телу):
     • ?action=upload  — принять PNG (base64) → положить в Object Storage → вернуть публичный URL
     • ?action=invoice — создать ссылку на оплату Telegram Stars (createInvoiceLink)
     • без action      — вебхук Telegram (отвечаем на pre_checkout_query)
   Точка входа: index.handler

   ВАЖНО: без внешних зависимостей. Загрузка в S3 — на встроенном crypto (AWS SigV4),
   чтобы пакет был крошечным и холодный старт ~1с (иначе Telegram-вебхук ловит таймаут).
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
  WEBHOOK_SECRET,                                          // секрет вебхука Telegram (если задан — проверяем заголовок)
  WEBAPP_URL = "https://kosinrin.github.io/biopassport/",  // ссылка на мини-апп для кнопки в /start
} = process.env;

// Приветствие на /start (научпоп-голос). Кнопка ниже открывает мини-апп.
const WELCOME_TEXT =
  "🧬 Это твой Биопаспорт.\n\n" +
  "Не медкарта — биологическая визитка. От цвета глаз и группы крови до хронотипа и редких " +
  "генетических черт — узнай свой биологический класс, редкость комбинации «1 из N» и скрытые " +
  "суперспособности.\n\n" +
  "Жми кнопку ниже 👇";

// Чтение заголовка без оглядки на регистр (Yandex/Node отдают по-разному).
function headerVal(event, name) {
  const h = (event && event.headers) || {};
  name = name.toLowerCase();
  for (const k in h) if (k.toLowerCase() === name) return h[k];
  return undefined;
}

const S3_KEY = (S3_KEY_ID || "").trim();
const S3_SEC = (S3_SECRET || "").trim();

/* ---------- S3 PutObject через ручную подпись AWS Signature V4 ---------- */
function hmac(key, data) { return crypto.createHmac("sha256", key).update(data, "utf8").digest(); }
function sha256hex(data) { return crypto.createHash("sha256").update(data).digest("hex"); }

async function s3Put(key, body, contentType) {
  const host = new URL(S3_ENDPOINT).host;            // storage.yandexcloud.net
  const service = "s3";
  const amzdate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, ""); // YYYYMMDDTHHMMSSZ
  const datestamp = amzdate.slice(0, 8);
  const payloadHash = sha256hex(body);
  const canonicalUri = `/${S3_BUCKET}/${key}`;       // path-style, ключ из безопасных символов
  const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzdate}\n`;
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const canonicalRequest = `PUT\n${canonicalUri}\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
  const scope = `${datestamp}/${S3_REGION}/${service}/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzdate}\n${scope}\n${sha256hex(canonicalRequest)}`;
  const kSigning = hmac(hmac(hmac(hmac("AWS4" + S3_SEC, datestamp), S3_REGION), service), "aws4_request");
  const signature = crypto.createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");
  const authorization =
    `AWS4-HMAC-SHA256 Credential=${S3_KEY}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const res = await fetch(`${S3_ENDPOINT}/${S3_BUCKET}/${encodeURI(key)}`, {
    method: "PUT",
    headers: {
      "x-amz-date": amzdate,
      "x-amz-content-sha256": payloadHash,
      authorization,
      "content-type": contentType,
    },
    body,
  });
  if (!res.ok) throw new Error(`S3 ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return `${S3_ENDPOINT}/${S3_BUCKET}/${key}`;
}

/* ---------- Telegram Bot API ---------- */
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

  // ---- 1) Загрузка файла (PNG по умолчанию, PDF при type:"pdf") → публичный URL ----
  if (q.action === "upload") {
    try {
      const data = JSON.parse(rawBody);
      const bytes = Buffer.from(String(data.image || ""), "base64");
      if (!bytes.length) return json(400, { error: "empty file" });
      const isPdf = data.type === "pdf";
      const ext = isPdf ? "pdf" : "png";
      const contentType = isPdf ? "application/pdf" : "image/png";
      const key = `cards/${Date.now()}-${crypto.randomBytes(4).toString("hex")}.${ext}`;
      const url = await s3Put(key, bytes, contentType);
      return json(200, { url });
    } catch (e) {
      return json(500, { error: String((e && e.message) || e) });
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
  // Если задан WEBHOOK_SECRET — пускаем только запросы Telegram с верным заголовком.
  // (upload/invoice сюда не доходят — они обработаны выше по ?action, без секрета.)
  if (WEBHOOK_SECRET && headerVal(event, "x-telegram-bot-api-secret-token") !== WEBHOOK_SECRET) {
    console.warn("[webhook] отклонён: неверный секрет");
    return json(403, { error: "forbidden" });
  }
  try {
    const update = JSON.parse(rawBody);
    console.log("[webhook] keys=", Object.keys(update).join(","));
    // /start → приветствие с кнопкой запуска мини-аппа
    const msg = update.message;
    const cmd = msg && typeof msg.text === "string" ? msg.text.trim().split(/\s+/)[0].split("@")[0] : "";
    if (cmd === "/start") {
      await tg("sendMessage", {
        chat_id: msg.chat.id,
        text: WELCOME_TEXT,
        reply_markup: { inline_keyboard: [[{ text: "🧬 Открыть Биопаспорт", web_app: { url: WEBAPP_URL } }]] },
      });
    }
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
