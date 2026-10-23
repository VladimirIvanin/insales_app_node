# InSales App Node.js

Заготовка устанавливаемого партнёрского приложения InSales на Node.js и TypeScript.

**Статус:** заготовка v1. `npm test` проверяет её на встроенном симуляторе и не заменяет прогон на живом магазине.

## Кратко

Приложение принимает установку из InSales, выполняет вход сотрудника через token3, показывает состояние подключения и делает read-only probe API. Удаление сравнивает готовый пароль и отзывает только совпавшее подключение вместе с его сессиями. Данные магазинов изолированы.

## Стек

| Компонент | Выбор |
| --- | --- |
| Runtime | Node.js >=22.12 и <25, включая 22 LTS и 24 LTS, ESM |
| Язык | TypeScript strict |
| HTTP | Fastify 5 |
| Шаблоны | EJS |
| Хранилище | SQLite (better-sqlite3) |
| HTTP-клиент | undici |
| Криптография | node:crypto (AES-256-GCM) |
| Тесты | Vitest |
| Разработка | tsx |

## Быстрый старт

```bash
# 1. Скопировать пример окружения
cp .env.example .env

# 2. Установить зависимости
npm ci

# 3. Сгенерировать ключ шифрования
npm run keygen
# Вставить вывод в APP_ENCRYPTION_KEY в .env

# 4. Заполнить остальные обязательные параметры .env

# 5. Применить миграции
npm run db:migrate

# 6. Запустить в разработке
npm run dev

# 7. В другом терминале проверить процесс
curl http://127.0.0.1:8765/health
curl http://127.0.0.1:8765/ready
```

### Обязательные параметры .env

```
INSALES_APP_ID=123456
INSALES_APP_SECRET=replace-with-app-secret
APP_BASE_URL=https://app.example.com
APP_ENCRYPTION_KEY=replace-with-64-hex-chars
ALLOWED_SHOPS=shop1.example,shop2.example
```

`INSALES_APP_ID` — ID приложения в InSales. `INSALES_APP_SECRET` — секрет приложения. `APP_BASE_URL` — публичный URL без query и fragment. `APP_ENCRYPTION_KEY` — 64 hex-символа из `npm run keygen`. `ALLOWED_SHOPS` — точные домены магазинов через запятую.

Комментарий в `.env` занимает всю строку. Текст после значения станет частью секрета, списка доменов или URL. Образец с комментариями на отдельных строках лежит в `.env.example`.

### Настройка тестового магазина

1. Заполните `.env` реквизитами приложения и разрешёнными магазинами.
2. Проверьте конфигурацию: `npm run doctor`.
3. Обеспечьте HTTPS-доступ к приложению (ngrok/Cloudflare Tunnel/Reverse Proxy).
4. Укажите URL установки, входа и удаления в настройках приложения InSales.
5. Установите приложение из панели администратора магазина.

## Команды

```bash
npm run dev          # Запуск в разработке (tsx)
npm start            # Запуск production-сборки (node dist/server.js)
npm run build        # TypeScript-компиляция и копирование ресурсов
npm run typecheck    # Проверка типов
npm test             # Запуск тестов (Vitest)
npm run check        # typecheck + test
npm run keygen       # Генерация ключа шифрования
npm run db:migrate   # Применение миграций
npm run db:status    # Статус миграций
npm run doctor       # Конфигурация, ключ и БД. Код 0 только при успехе
npm run doctor -- --api  # То же и read-only GET /admin/account.json
npm run cleanup      # Просроченные записи. Ошибка конфигурации даёт код 1
```

## HTTP-маршруты

| Метод | Путь | Назначение | Доступ |
| --- | --- | --- | --- |
| GET | `/health` | Проверка процесса | Публичный |
| GET | `/ready` | Проверка БД | Публичный |
| GET | `/install` | Callback установки | InSales |
| GET | `/login` | Начало входа | InSales |
| GET | `/autologin` | Проверка token3 | Challenge |
| GET | `/uninstall` | Callback удаления | InSales |
| GET | `/` | Dashboard | Сессия |
| GET | `/probe` | Проверка API | Сессия |
| POST | `/logout` | Выход | Сессия + CSRF |

## Протокол

- Install: `MD5(token + app_secret)` — пароль магазина. Сохраняется как кандидат. API не вызывается во время callback.
- Login: при первом входе проверяется кандидат через `GET /admin/account.json`. Active credentials не заменяются до успешной проверки. Неверный пароль или чужой `account.id` снимают только этот кандидат. Сбой сети, невалидный JSON, 429 и 5xx оставляют кандидата; если активного подключения ещё нет, ответ `503`.
- Token3: `MD5(nonce + user_email + user_name + user_id + email_confirmed + password)` — проверка постоянным временем.
- Uninstall: в query приходит готовый пароль магазина. Он сравнивается с сохранённым credential без повторного MD5. Отзываются только совпавшие active и pending; другое поколение и другой магазин не затрагиваются. Ответ 200 не сообщает, была ли запись.
- Пароли шифруются AES-256-GCM с AAD-привязкой к магазину и назначению.

## Структура проекта

```
src/
  server.ts           # Точка входа
  app.ts              # buildApp factory (сервер + тесты)
  config.ts           # Загрузка и валидация конфигурации
  cli.ts              # CLI-команды
  insales/
    protocol.ts       # Формулы MD5 token/token2/token3
    transport.ts      # HTTP-клиент к InSales API
    errors.ts         # Типы ошибок
    resources/
      account.ts      # GET /admin/account.json
  application/
    installation.ts   # Install/uninstall/verify
  storage/
    database.ts       # SQLite init
    migrate.ts        # Миграции
    installations.ts  # SQL-операции lifecycle
    sessions.ts       # SQL-операции сессий/challenges
    credentials.ts    # AES-256-GCM шифрование
  http/
    routes.ts         # Маршруты
    auth.ts           # Сессионный контекст
    logging.ts        # Безопасное логирование
    schemas.ts        # TypeBox схемы
    error-handler.ts  # Обработка ошибок
templates/            # EJS-шаблоны
public/               # Статические файлы (CSS)
migrations/           # SQL-миграции
tests/                # Тесты (Vitest)
```

## Автоматические проверки

`npm test` не читает `.env` разработчика и не требует экспортированных секретов. В набор входят формулы протокола, жизненный цикл в SQLite, HTTP к симулятору, CSRF для logout, `Cache-Control: no-store`, отсутствие секретов callback в access-логе, `TRUST_PROXY`, deadline и потоковый предел тела, а также поиск шаблонов у собранного модуля из другого рабочего каталога. Живой магазин этими тестами не вызывается.

## Ограничения v1

- Один web-процесс, SQLite. Не предназначено для нескольких экземпляров.
- Проверка кандидата при первом входе, а не в фоне.
- Нет фонового retry, webhook inbox и очередей.
- Read-only probe через `account.json`. Другие ресурсы API добавляются отдельно.
- Нет OAuth/OIDC-входа покупателей, SPA, биллинга.
- Dockerfile не входит в поставку, но сборка совместима с контейнеризацией.

## Лицензия

MIT. Текст лежит в `LICENSE`.