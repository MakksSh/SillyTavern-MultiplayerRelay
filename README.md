# ST Multiplayer Relay

Рабочий MVP мультиплеерного relay для SillyTavern.

Сценарий:

1. Админ запускает relay.
2. Админ создаёт комнату в `/admin`.
3. Relay выдаёт `Guest URL` и `Extension WS URL`.
4. Гость заходит по ссылке и пишет свой draft.
5. Админ подключает extension в открытую вкладку SillyTavern.
6. После `Ready` админ отправляет общий ход в Tavern.
7. SillyTavern генерирует ответ обычным способом, extension возвращает его в relay.

## Установка relay

```bash
cd relay
npm install
cp .env.example .env
```

Если вы на Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

## Настройка relay

Файл `.env`:

```env
PORT=3000
ADMIN_KEY=change-me
PUBLIC_BASE_URL=http://localhost:3000
```

`PUBLIC_BASE_URL` должен совпадать с тем адресом, по которому пользователи и extension реально видят relay.

## Запуск relay

```bash
cd relay
npm start
```

После старта доступны:

- `/` стартовая страница
- `/admin` админский интерфейс
- `/room/:roomId` гостевая комната
- `/health` проверка сервиса

## Как создать комнату

1. Откройте `/admin`.
2. Введите `Admin Key`.
3. Укажите `Admin Name`.
4. Нажмите `Войти`.
5. Нажмите `Создать комнату`.

После этого страница покажет:

- `Room ID`
- `Guest URL`
- `Extension WS URL`

## Как подключить extension

1. Откройте в браузере нужный чат SillyTavern.
2. Откройте настройки `ST Multiplayer Relay` в списке extensions.
3. Вставьте `Extension WS URL` из `/admin` в поле `Relay WS URL`.
4. Нажмите `Connect`.
5. Убедитесь, что статус стал `Paired`.

Важно: extension работает с текущим открытым чатом SillyTavern. Не закрывайте эту вкладку во время игры.

## Как пригласить друга

1. Скопируйте `Guest URL` на странице `/admin`.
2. Отправьте ссылку гостю.
3. Гость открывает ссылку, вводит имя и нажимает `Join`.

## Как играть

1. Каждый игрок пишет свой `draft`.
2. Каждый игрок нажимает `Ready`.
3. Админ при необходимости добавляет `Admin Note`.
4. Админ нажимает `Send to Tavern`.
5. Relay собирает общий текст только из `ready`-игроков с непустым draft.
6. Extension отправляет общий ход в текущий чат SillyTavern.
7. После генерации ответ появляется у админа и у гостей.
8. Draft у `ready`-игроков очищается, `ready` сбрасывается.

`OOC Chat` живёт отдельно и в Tavern не отправляется.

## Удалённый relay

Для удалённого запуска нужен reverse proxy с HTTPS/WSS.

Минимальные требования:

- внешний адрес в `PUBLIC_BASE_URL` должен быть `https://...`
- proxy должен пробрасывать WebSocket на `/ws`
- extension должен получать `wss://...` URL

Рекомендации по безопасности:

- задайте свой сложный `ADMIN_KEY` вместо дефолтного `change-me`
- не публикуйте `Extension WS URL`, он содержит `hostPairKey`
- admin-сессия хранится только в `sessionStorage` текущей вкладки и пропадает после закрытия вкладки или перезапуска relay

Пример:

```env
PUBLIC_BASE_URL=https://relay.example.com
```

Тогда `Extension WS URL` будет строиться как `wss://relay.example.com/ws?...`.

## Ограничения MVP

- состояние хранится только в памяти
- нет БД и аккаунтов
- нет стриминга ответа
- нет приватных сообщений
- нет восстановления одной и той же сессии игрока после разрыва
