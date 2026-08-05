# Chery Pulse

Личное SSR-приложение для двух пользователей: состояние автомобиля StarLine, журнал поездок и Telegram-бот. Веб-процесс работает только с SQLite и очередью `jobs`; все обращения к StarLine и Telegram выполняет отдельный worker.

## Требования

- Windows 11 для разработки
- Node.js 22 LTS (`.nvmrc`)
- npm

## Первый запуск

1. Скопируйте `.env.example` в `.env` и замените `NUXT_SESSION_PASSWORD` и пароли двух пользователей.
2. Выполните `npm install`.
3. Выполните `npm run db:migrate`.
4. Выполните `npm run seed`.
5. Запустите в двух терминалах `npm run dev` и `npm run worker`.
6. Откройте `http://localhost:3000`.

По умолчанию `STARLINE_MODE=fixture`: сеть StarLine не используется, данные читаются из безопасного примера `fixtures/starline-device.example.json`. Реальные реквизиты нужны только для `STARLINE_MODE=live` или одноразового `npm run starline:probe`. Probe выполняет официальную цепочку авторизации и сохраняет сырой ответ в игнорируемый Git файл `fixtures/starline-device.json`; после этого укажите этот путь в `STARLINE_FIXTURE_PATH`.

## Команды

- `npm run db:generate` — создать миграцию после изменения схемы.
- `npm run db:migrate` — применить миграции.
- `npm run seed` — создать или обновить две учётные записи из `.env`.
- `npm run worker` — worker и Telegram long polling в watch-режиме.
- `npm run worker:start` — worker без watch-режима для production.
- `npm run worker:once` — обработать одну готовую задачу (удобно для smoke-проверки).
- `npm test` — модульные тесты парсера.
- `npm run typecheck` — проверка Nuxt и worker TypeScript.
- `npm run build` — production-сборка Nuxt.
- `npm run smoke` — проверить собранный сервер, 401 без сессии, вход и защищённый дашборд.

## Production-развёртывание в Docker

В состав входят четыре production-сервиса: `web`, `worker`, одноразовый `migrate` и Caddy. Caddy принимает трафик на портах 80/443 и автоматически выпускает и обновляет TLS-сертификат. SQLite хранится в именованном volume `app-data`; наружу порт Nuxt не публикуется.

На Linux-сервере должны быть установлены Docker Engine и Compose plugin. До запуска направьте A/AAAA-запись домена на сервер и откройте входящие TCP-порты 80/443 и UDP-порт 443.

Первое развёртывание:

```bash
git clone <repository-url> chery-pulse
cd chery-pulse
cp .env.production.example .env.production
chmod 600 .env.production
# Заполните домен, секрет сессии, пользователей и реквизиты интеграций.

docker compose build
docker compose run --rm --no-deps migrate
docker compose run --rm --no-deps seed
docker compose up -d
```

Секрет сессии можно создать командой `openssl rand -base64 48`. Не используйте значения-заглушки из примера. Команда `seed` обновляет пароли существующих пользователей, поэтому запускайте её повторно только при намеренной ротации учётных данных.

Проверка состояния и просмотр логов:

```bash
docker compose ps
docker compose logs --tail=100 web worker caddy
curl --fail https://pulse.example.com/api/health
```

Для обновления приложения:

```bash
git pull --ff-only
docker compose pull caddy
docker compose build --pull
docker compose up -d
```

`migrate` запускается перед `web` и `worker`; миграции должны оставаться обратно совместимыми на время обновления. Не масштабируйте `worker` больше чем до одного экземпляра: очередь и Telegram long polling рассчитаны на единственный процесс.

Перед обновлением рекомендуется сделать согласованную резервную копию SQLite:

```bash
docker compose stop web worker
docker compose run --rm --no-deps migrate sh -c 'tar -C /app/data -czf - .' > chery-pulse-data-$(date +%F-%H%M).tar.gz
docker compose start web worker
```

Сертификаты Caddy находятся в volumes `caddy-data` и `caddy-config`. Они восстанавливаются автоматически, но volume `app-data` содержит незаменяемую историю и должен регулярно копироваться за пределы сервера.

## Хранение данных

Снимки состояния автомобиля, поездки и журнал обращений к API хранятся бессрочно. В приложении нет фоновой очистки, TTL или ограничения истории по дате. Журнал поездок выводится постранично, поэтому все накопленные поездки остаются доступны независимо от их возраста.

Миграции и повторный запуск `npm run seed` не очищают историю. Для переноса или резервного копирования необходимо сохранять файл SQLite, указанный в `DATABASE_URL` (по умолчанию `data/app.db`). Просроченные токены StarLine могут заменяться или удаляться при повторной авторизации — это служебные учётные данные, а не история автомобиля.
