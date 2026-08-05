# Chery Pulse

Личное SSR-приложение для двух пользователей: состояние автомобиля StarLine, журнал поездок, журнал запросов к API и Telegram-бот. Веб-процесс работает только с SQLite и очередью `jobs`; все обращения к StarLine и Telegram выполняет отдельный worker. Журнал API хранит адрес, метод, статус, длительность, заголовки и тела запросов/ответов StarLine; секретные значения автоматически маскируются.

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

По умолчанию `STARLINE_MODE=fixture`: сеть StarLine не используется, данные читаются из безопасного примера `fixtures/starline-device.example.json`. Для `STARLINE_MODE=live` заполните реквизиты без `STARLINE_DEVICE_ID` и выполните `npm run starline:setup`. Команда интерактивно обрабатывает CAPTCHA или SMS-код, сохраняет токен пользователя в SQLite и выводит доступные `STARLINE_DEVICE_ID`. Одноразовый `npm run starline:probe` проверяет уже настроенное устройство и сохраняет сырой ответ в игнорируемый Git файл `fixtures/starline-device.json`; после этого этот файл можно использовать как `STARLINE_FIXTURE_PATH`.

## Команды

- `npm run db:generate` — создать миграцию после изменения схемы.
- `npm run db:migrate` — применить миграции.
- `npm run seed` — создать или обновить две учётные записи из `.env`.
- `npm run worker` — worker и Telegram long polling в watch-режиме.
- `npm run worker:start` — worker без watch-режима для production.
- `npm run worker:once` — обработать одну готовую задачу (удобно для smoke-проверки).
- `npm run starline:setup` — пройти интерактивную авторизацию StarLine, включая CAPTCHA/2FA, и получить `device_id`.
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

Если StarLine запрашивает CAPTCHA или `STARLINE_DEVICE_ID` ещё неизвестен, остановите worker и запустите интерактивную настройку с подключённым production volume:

```bash
docker compose stop worker
docker compose run --rm --no-deps worker npm run starline:setup
# Скопируйте выведенный STARLINE_DEVICE_ID в .env.production.
docker compose up -d --force-recreate worker
```

При автоматическом деплое добавляйте к каждой команде Compose `--env-file .env.deploy`, чтобы использовался опубликованный tasks-образ. Токен пользователя сохраняется в SQLite; пароль и токены в терминал не выводятся.

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

## Автоматическое развёртывание

Workflow `.github/workflows/deploy.yml` запускается после каждого push в `main` и вручную через `workflow_dispatch`. Он выполняет тесты и typecheck, собирает два Linux-образа, публикует их в GHCR с неизменяемым тегом commit SHA и развёртывает релиз по SSH.

В GitHub Actions должны быть настроены repository secrets:

- `DEPLOY_HOST` — IP-адрес production-сервера;
- `DEPLOY_HOST_KEY` — строка `known_hosts` с подтверждённым ED25519-ключом сервера;
- `DEPLOY_SSH_KEY` — отдельный приватный SSH-ключ без passphrase, доступный только Actions. Соответствующий публичный ключ на сервере ограничен опциями `restrict` и `command`, поэтому не предоставляет интерактивный shell, SCP или port forwarding.

Перед миграцией `deploy/production-deploy.sh` останавливает `web` и `worker`, сохраняет согласованную копию SQLite в `/opt/chery-pulse/backups`, применяет миграции и ждёт healthcheck. При неуспешном запуске скрипт возвращает предыдущие образы. Автоматические резервные копии хранятся 14 дней; внешнее резервное копирование volume по-прежнему необходимо.

## Хранение данных

Снимки состояния автомобиля, поездки и журнал обращений к API хранятся бессрочно. В приложении нет фоновой очистки, TTL или ограничения истории по дате. Журнал поездок выводится постранично, поэтому все накопленные поездки остаются доступны независимо от их возраста.

Миграции и повторный запуск `npm run seed` не очищают историю. Для переноса или резервного копирования необходимо сохранять файл SQLite, указанный в `DATABASE_URL` (по умолчанию `data/app.db`). Просроченные токены StarLine могут заменяться или удаляться при повторной авторизации — это служебные учётные данные, а не история автомобиля.
