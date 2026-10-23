# InSales App Node.js

Заготовка устанавливаемого партнёрского приложения InSales. Один процесс Node.js принимает установку, вход сотрудника через token3, показывает состояние подключения и выполняет read-only проверку `account.json`. Заказы и товары доступны через API-клиент. Удаление сравнивает готовый пароль и отзывает только совпавшее подключение вместе с его сессиями.

`npm test` проверяет заготовку на встроенном симуляторе. Симулятор не заменяет вход настоящим браузером в магазин InSales.

## Стек

| Компонент    | Выбор                                                                   |
| ------------ | ----------------------------------------------------------------------- |
| Runtime      | Node.js `>=22.19.0 <23` или `>=24 <25`. Промежуточные major не заявлены |
| Язык         | TypeScript strict                                                       |
| HTTP         | Fastify 5                                                               |
| Шаблоны      | EJS                                                                     |
| Хранилище    | SQLite (`better-sqlite3`), режим WAL                                    |
| HTTP-клиент  | undici. Установленная версия требует Node.js `>=22.19.0`                |
| Криптография | `node:crypto`, AES-256-GCM                                              |
| Тесты        | Vitest                                                                  |

## Быстрый старт разработки

Нужны Node.js из диапазона выше и `npm ci`. Отдельное production-окружение и предварительная сборка не нужны: сервер разработки запускается через `tsx`.

```bash
cp .env.example .env
npm ci
npm run dev:keygen
```

Вставьте выведенные 64 hex-символа в `APP_ENCRYPTION_KEY`. Заполните `INSALES_APP_ID`, `INSALES_APP_SECRET`, `APP_BASE_URL` и `ALLOWED_SHOPS`. Для локальной работы оставьте `APP_ENV=development`.

```bash
npm run dev:db:migrate
npm run dev
```

В другом терминале:

```bash
curl http://127.0.0.1:8765/health
curl http://127.0.0.1:8765/ready
```

`/health` отвечает `200`, когда процесс слушает порт. `/ready` отвечает `200`, когда открыта SQLite.

### Обязательные параметры

```text
INSALES_APP_ID=123456
INSALES_APP_SECRET=replace-with-app-secret
APP_BASE_URL=https://app.example.com
APP_ENCRYPTION_KEY=replace-with-64-hex-chars
ALLOWED_SHOPS=shop1.example,shop2.example
```

`APP_BASE_URL` — публичный origin без query и fragment. В `APP_ENV=production` он обязан быть `https`. `ALLOWED_SHOPS` — точные домены магазинов. Комментарий в `.env` занимает всю строку: текст после значения станет частью секрета, списка доменов или URL. Образец лежит в `.env.example`.

Относительный `APP_DB` считается от `APP_RUNTIME_DIR`, а не от второго каталога `runtime`. Web-процесс и CLI открывают один и тот же файл.

## Запуск собранного приложения

Сборка нужна там, где нет `tsx` и остальных devDependencies. `typebox` остаётся runtime-зависимостью: схемы импортируют его после компиляции. `@fastify/type-provider-typebox` в собранный JavaScript не входит.

```bash
npm ci
npm run build
```

Дальше можно поставить только production-зависимости. Каталог `dist`, `package.json`, `package-lock.json` и `.npmrc` достаточны; исходный checkout для запуска не нужен. Ставьте зависимости на той же ОС и архитектуре, где запускается приложение: нативные модули выбираются под текущую платформу. `better-sqlite3` берёт готовый бинарник из своего каталога `prebuilds`.

`.npmrc` отключает install-скрипты зависимостей. Без него `npm ci` запускает `node-gyp rebuild` для `better-sqlite3`: npm берёт метаданные из lockfile, а там нет `gypfile: false`. Тогда сборке нужны компилятор C++ и Python, а на Windows — ещё и Visual Studio, которую поддерживает `node-gyp`.

```bash
npm ci --omit=dev
node dist/cli.js keygen
node dist/cli.js db:migrate
node dist/server.js
```

`keygen` не требует параметров магазина. Остальные команды при ошибке конфигурации завершаются с ненулевым кодом и не печатают секрет. Проверка этого пути: `node scripts/production-smoke.mjs` после `npm run build`.

`SIGTERM` и `SIGINT` обрабатывает только процесс `dist/server.js`. Закрытие Fastify закрывает SQLite. Если завершение длится дольше 10 секунд, процесс выходит с кодом 1. Вызовы `buildApp` из тестов и CLI слушатели сигналов не добавляют.

## Команды

Разработка, через `tsx`:

```bash
npm run dev
npm run dev:keygen
npm run dev:doctor
npm run dev:doctor -- --api
npm run dev:cleanup
npm run dev:db:migrate
npm run dev:db:status
```

Собранное приложение, через Node.js:

```bash
npm start
npm run keygen
npm run doctor
npm run doctor -- --api
npm run cleanup
npm run db:migrate
npm run db:status
```

`doctor --api` читает `GET /admin/account.json` активных магазинов. `db:migrate` и `db:status` открывают SQLite напрямую и не создают HTTP-приложение.

Проверки:

```bash
npm run check
npm test
npm run typecheck
npm run lint
npm run format:check
npm run audit
```

`npm run check` запускает lint, проверку форматирования, типы исходников, типы тестов и тесты. Тестовые файлы не входят в `dist`.

## Адреса приложения

В настройках приложения InSales укажите:

| Назначение | URL                        |
| ---------- | -------------------------- |
| Установка  | `{APP_BASE_URL}/install`   |
| Вход       | `{APP_BASE_URL}/login`     |
| Удаление   | `{APP_BASE_URL}/uninstall` |

`/login` создаёт одноразовый challenge и перенаправляет браузер в магазин. Магазин возвращает сотрудника на `{APP_BASE_URL}/autologin` с `token3`. Если в настройках InSales вместо `/login` указан `/autologin`, входа не будет: challenge ещё не создан.

| Метод | Путь         | Назначение               | Доступ                            |
| ----- | ------------ | ------------------------ | --------------------------------- |
| GET   | `/health`    | Процесс слушает порт     | Публичный                         |
| GET   | `/ready`     | SQLite открыта           | Публичный                         |
| GET   | `/install`   | Callback установки       | InSales, домен из `ALLOWED_SHOPS` |
| GET   | `/login`     | Начало входа             | InSales, домен из `ALLOWED_SHOPS` |
| GET   | `/autologin` | Проверка `token3`        | Challenge этого браузера          |
| GET   | `/uninstall` | Callback удаления        | InSales                           |
| GET   | `/`          | Состояние подключения    | Сессия                            |
| GET   | `/probe`     | Read-only `account.json` | Сессия                            |
| POST  | `/logout`    | Выход                    | Сессия и CSRF                     |

Probe не вызывает заказы и товары. Подключение клиента в коде не меняет права приложения в InSales: их задаёт карточка приложения.

Для `GET /admin/account.json` нужно право на настройки магазина. Чтение и изменение заказов и товаров требуют прав, которые выдаются этому приложению в InSales. Если права нет, API отвечает `403` и JSON `{"status":"error","message":"Недостаточно прав для операции"}`.

## Протокол подключения

- Install: пароль магазина — `MD5(token + app_secret)`. Callback только сохраняет кандидата и отвечает `200`. API во время callback не вызывается.
- Порядок кандидата — монотонное число, занятое в той же записи, что и сам кандидат. Это не время и не поколение уже подтверждённого подключения. Счётчик не сбрасывается при удалении магазина.
- Login: при первом входе кандидат проверяется через `GET /admin/account.json`. Активация повторно читает кандидата под блокировкой записи. Более поздний уже подтверждённый магазин не заменяется ответом старой проверки. Непроверенный новый кандидат не отзывает сессии текущего подключения.
- Повтор установки с тем же паролем не меняет поколение и не удаляет сессии. Другой пароль получает новый порядковый номер и после успешной проверки сменяет подключение.
- Неверный пароль или чужой `account.id` снимают только этот кандидат. Сеть, невалидный JSON, `429` и `5xx` оставляют кандидата до TTL в 7 дней. Если активного подключения ещё нет, ответ login — `503`.
- Token3: `MD5(nonce + user_email + user_name + user_id + email_confirmed + password)`. Challenge привязан к браузеру, магазину и поколению, живёт 5 минут и расходуется один раз. Проверка подписи, повторное чтение поколения и запись сессии — одна транзакция: создаётся не больше одной сессии, и сессия старого поколения не создаётся.
- Сессия живёт 1 час. Запрос получает пароль того поколения, с которым сессия была прочитана.
- Uninstall получает готовый пароль и не хеширует его повторно. В одной транзакции отменяются только active и pending с этим паролем. Ответ `200` не сообщает, была ли запись.
- Пароли шифруются AES-256-GCM. AAD связывает шифртекст с доменом, `insales_id` и назначением `store` или `candidate`.

Миграция `002_candidate_ordinal.sql` не переписывает уже применённую `001_initial.sql`. Старые pending хранили порядок как `0`, поэтому миграция их отменяет. Активные магазины и их сессии сохраняются. Магазин, который был только в pending, нужно установить снова.

## API-клиент

Клиент принадлежит одному магазину. Общего изменяемого клиента нет. Транспорт выполняет один запрос: автоматического повтора нет. Таймаут `PUT` или `POST` означает, что результат неизвестен; такой запрос не повторяют вслепую.

В авторизованном обработчике из `src/http` клиент строится из уже прочитанного контекста:

```typescript
import { authorize, clientForContext } from './auth.js';

const session = authorize(config, request);
if (!session) return;
const client = clientForContext(config, session);

const listed = await client.orders.list({ page: 1, perPage: 25 });
const one = await client.orders.get('1001');
const total = await client.orders.count();
```

Те же методы есть у `client.products`. `list` принимает `page`, `perPage` и `query` для остальных документированных параметров. Ключи и значения `query` только кодируются. Пример фильтра заказов: `{ 'fulfillment_status[]': ['new', 'delivered'] }`. `page` и `per_page` в `query` передавать не нужно. Платформа может изменить размер страницы: у заказов `per_page` больше 100 становится 100, у товаров значение меньше 10 становится 10.

Обновление передаёт только изменённые поля. Это не шаг подключения настоящего магазина; контракт проверяется симулятором.

```typescript
import { ApiError, ResponseError, TransportError } from '../insales/errors.js';

try {
  const updated = await client.orders.update('1001', { manager_comment: 'собрано' });
  console.log(updated.order.id, updated.order.fulfillmentStatus);
} catch (err) {
  if (err instanceof ApiError) {
    // status, usage и retryAfter. Тело ответа в ошибку не входит.
  } else if (err instanceof TransportError) {
    // сеть или таймаут. Для update результат мог уже сохраниться.
  } else if (err instanceof ResponseError) {
    // JSON или обязательное поле не совпали с операцией.
  }
}
```

Товар обновляется так же: `client.products.update(id, patch)` отправляет `PUT /admin/products/:id.json` с телом `{ product: patch }`. Заказ отправляется как `{ order: patch }`.

Клиент проверяет обязательную форму, а не все поля InSales. У заказа это `id`, `number`, `fulfillment_status` и `financial_status`. У товара — `id` и `title`. У счётчика — неотрицательное целое `count`. Список может быть пустым.

Новый ресурс вызывает `apiRequest` и подключается в `createClient`. Транспорт копировать не нужно.

## Структура

```text
src/server.ts                         # SIGTERM/SIGINT и listen
src/app.ts                            # buildApp
src/cli.ts                            # keygen, doctor, cleanup, db:migrate, db:status
src/insales/client.ts                 # клиент одного магазина
src/insales/transport.ts              # HTTP, HTTPS, deadline, предел тела
src/insales/resources/                # account, orders, products
src/application/installation.ts       # install, проверка кандидата, uninstall
src/storage/                          # SQLite, миграции, сессии, шифрование
src/http/                             # маршруты, сессия, логи, ошибки
scripts/build.mjs                     # tsc и копирование шаблонов, SQL, CSS
scripts/production-smoke.mjs          # запуск dist без devDependencies
migrations/                           # SQL, включая обновление уже созданной БД
templates/ и public/                  # EJS и CSS
```

Шаблоны, CSS и SQL ищутся рядом с запущенным модулем. Смена текущего каталога их не подменяет.

## CI

GitHub Actions выполняет четыре обязательные проверки. Обычному прогону не нужны `.env` автора, исходники платформы и настоящий магазин.

| Job                     | Что делает                                                                                       |
| ----------------------- | ------------------------------------------------------------------------------------------------ |
| Linux Node 22 и Node 24 | `npm ci`, `npm run check`, `npm run build`                                                       |
| Production smoke        | копия `dist`, `npm ci --omit=dev`, CLI, `/health`, `/ready`, шаблон и CSS, завершение по SIGTERM |
| Windows                 | `npm ci`, сборка, `keygen`                                                                       |
| npm audit               | падает на уязвимостях high и critical                                                            |

`npm audit fix --force` не используется. Известная уязвимость high/critical чинится отдельным обновлением зависимости. Moderate и low смотрите в еженедельных группах Dependabot: runtime и development отдельно, Actions — своей группой. Если обновление меняет требование к Node.js, вместе с ним меняются `engines` и этот README.

## Ограничения

- Один web-процесс и одна SQLite. Несколько экземпляров на один файл не поддерживаются.
- Кандидат проверяется при первом входе, не в фоне.
- Нет фонового повтора, webhook inbox и очередей.
- Probe читает только аккаунт. Заказы и товары вызываются из кода; экрана для них нет.
- Нет OAuth/OIDC-входа покупателей, SPA и биллинга.
- Dockerfile в поставку не входит. Каталог `dist` можно запускать из контейнера тем же `node dist/server.js`.

## Лицензия

MIT. Текст лежит в `LICENSE`.
