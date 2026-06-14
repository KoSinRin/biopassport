# Биопаспорт — бэкенд (Yandex Cloud Function)

Одна публичная функция на три задачи:
- `POST ?action=upload` — `{ "image": "<base64 PNG>" }` → кладёт в Object Storage → `{ "url": "https://storage.yandexcloud.net/biopassport/cards/..." }`
- `POST ?action=invoice` → `{ "link": "<ссылка на оплату Stars>" }`
- `POST` без `action` — вебхук Telegram (подтверждает `pre_checkout_query`)

## Деплой через консоль (без CLI, инлайн-редактор)

1. Консоль → каталог **biopassport-main** → раздел **Cloud Functions** (в группе Serverless) → **Создать функцию** → имя `biopassport-api`.
2. **Создать редактор/версию**:
   - Среда выполнения: **Node.js 18**
   - Способ: **Редактор кода**
   - Создай два файла и вставь содержимое из этой папки: `index.js` и `package.json`
   - **Точка входа**: `index.handler`
   - Таймаут: `30` сек, Память: `256` МБ
3. **Переменные окружения** (раздел «Параметры»):
   | Имя | Значение |
   |---|---|
   | `BOT_TOKEN` | новый токен от @BotFather |
   | `S3_KEY_ID` | идентификатор статического ключа |
   | `S3_SECRET` | секретный ключ |
   | `S3_BUCKET` | `biopassport` |
   | `PRICE_STARS` | `20` |
   > `S3_ENDPOINT` и `S3_REGION` уже заданы в коде по умолчанию.
4. **Сохранить / задеплоить**. Yandex сам установит зависимость из `package.json`.
5. Вкладка/настройка функции → включить **Публичная функция**.
6. URL функции: `https://functions.yandexcloud.net/<FUNCTION_ID>`
   > ВАЖНО: **без** `?integration=raw`. В режиме по умолчанию функция получает структурированный
   > HTTP-запрос (httpMethod/queryStringParameters/body) и возвращает `{statusCode, headers, body}`
   > как ответ. С `integration=raw` ломается роутинг по `action` и CORS-обёртка ответа.
7. **Привязать вебхук Telegram** — открыть в браузере (подставив токен и FUNCTION_ID):
   ```
   https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=https://functions.yandexcloud.net/<FUNCTION_ID>
   ```
   Ответ `{"ok":true,...}` = вебхук установлен.

## После деплоя

Дать фронту URL функции (`https://functions.yandexcloud.net/<FUNCTION_ID>`) — он подставляется в `BACKEND_URL` в `js/app.js`, и заглушки заменяются на реальные вызовы (Сторис, сохранение на Android, оплата Stars).
