# Multi-User Migration Guide

## Обзор изменений

Бот был переработан с **single-user** архитектуры на **multi-user** архитектуру. Теперь каждый пользователь имеет свои персональные настройки, и изменения одного пользователя не влияют на других.

## Что изменилось

### 1. База данных

#### Новая таблица `users`
```sql
CREATE TABLE users (
  user_id INTEGER PRIMARY KEY,
  username TEXT,
  first_name TEXT,
  last_name TEXT,
  registered_at INTEGER NOT NULL
);
```

#### Обновленная таблица `user_settings`
```sql
CREATE TABLE user_settings (
  user_id INTEGER NOT NULL,
  key TEXT NOT NULL,
  value TEXT,
  PRIMARY KEY (user_id, key),
  FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
);
```

**Было:** Настройки хранились глобально без привязки к пользователю
```
key                    | value
-----------------------|----------------
monitored_assets       | ["USD","EUR"]
RSS_ENABLED           | "true"
QUIET_HOURS_ENABLED   | "true"
```

**Стало:** Настройки хранятся для каждого пользователя отдельно
```
user_id | key                  | value
--------|----------------------|----------------
12345   | monitored_assets     | ["USD","EUR"]
12345   | RSS_ENABLED         | "true"
67890   | monitored_assets     | ["GBP","JPY"]
67890   | QUIET_HOURS_ENABLED | "false"
```

### 2. API Database

Все методы теперь принимают `userId` как первый параметр:

#### Было:
```typescript
database.getMonitoredAssets();
database.toggleAsset(asset);
database.isRssEnabled();
database.toggleRss();
database.isQuietHoursEnabled();
database.toggleQuietHours();
```

#### Стало:
```typescript
database.getMonitoredAssets(userId);
database.toggleAsset(userId, asset);
database.isRssEnabled(userId);
database.toggleRss(userId);
database.isQuietHoursEnabled(userId);
database.toggleQuietHours(userId);
```

#### Новые методы:
```typescript
// Регистрация пользователя (автоматически при первом взаимодействии)
database.registerUser(userId, username?, firstName?, lastName?);

// Получить всех пользователей
database.getUsers();

// Получить пользователя по ID
database.getUserById(userId);
```

### 3. Bot.ts

#### Автоматическая регистрация пользователей
Добавлен middleware, который автоматически регистрирует пользователей при первом взаимодействии:

```typescript
bot.use(async (ctx, next) => {
  if (ctx.from) {
    database.registerUser(
      ctx.from.id,
      ctx.from.username,
      ctx.from.first_name,
      ctx.from.last_name
    );
  }
  await next();
});
```

#### Команды и callbacks
Все команды и callback handlers теперь работают с `ctx.from.id`:

```typescript
// Пример: /settings команда
const userId = ctx.from.id;
const monitoredAssets = database.getMonitoredAssets(userId);
const keyboard = buildSettingsKeyboard(userId);
```

### 4. SchedulerService

#### Было: Отправка только админу
```typescript
const adminChatId = env.ADMIN_CHAT_ID;
await bot.api.sendMessage(adminChatId, message);
```

#### Стало: Рассылка всем пользователям с персональными настройками
```typescript
const users = database.getUsers();

for (const user of users) {
  const monitoredAssets = database.getMonitoredAssets(user.user_id);
  const userEvents = events.filter(e => monitoredAssets.includes(e.currency));
  
  if (userEvents.length > 0) {
    await bot.api.sendMessage(user.user_id, formatMessage(userEvents));
  }
}
```

#### Персональные настройки тихих часов
Каждый пользователь может настроить свои тихие часы:

```typescript
function isQuietHours(userId: number): boolean {
  if (!database.isQuietHoursEnabled(userId)) {
    return false;
  }
  // Проверка времени...
}
```

### 5. Services (CalendarService, MyfxbookService, RssService)

#### Удалена фильтрация по активам
Сервисы больше не фильтруют события по монitoredAssets, так как каждый пользователь имеет свой набор активов.

**Было:**
```typescript
const monitoredAssets = database.getMonitoredAssets();
const allowed = ALLOWED_CURRENCIES.has(currency);
```

**Стало:**
```typescript
// Возвращаем все события (фильтрация происходит в SchedulerService per-user)
const allowed = (impact === 'High' || impact === 'Medium');
```

### 6. Sent News Tracking

Теперь для каждого пользователя отслеживается своя история отправленных новостей:

**Было:**
```typescript
const id = itemId(title, time);
if (!database.hasSent(id)) {
  await sendMessage(adminChatId, message);
  database.markAsSent(id);
}
```

**Стало:**
```typescript
const id = `reminder_${userId}_${itemId(title, time)}`;
if (!database.hasSent(id)) {
  await sendMessage(userId, message);
  database.markAsSent(id);
}
```

## Миграция

### 1. Запустить скрипт миграции

```bash
npx ts-node scripts/migrate-multi-user.ts
```

Скрипт:
- Проверяет структуру базы данных
- Создает пользователя из ADMIN_CHAT_ID (если указан в .env)
- Устанавливает настройки по умолчанию
- Показывает список всех пользователей

### 2. Проверить настройки

```bash
npx ts-node scripts/check-db-assets.ts
```

Показывает:
- Список всех пользователей
- Настройки каждого пользователя (активы, RSS, тихие часы)

### 3. Запустить бота

```bash
npm run dev
```

## Использование

### Для пользователей

1. **Начать работу с ботом:**
   - Отправить `/start` боту в Telegram
   - Пользователь автоматически регистрируется

2. **Настроить свои активы:**
   - Отправить `/settings`
   - Выбрать интересующие валюты (USD, EUR, GBP, JPY, и т.д.)
   - Настроить RSS (внешние источники)
   - Настроить тихие часы (23:00-08:00)

3. **Получать персональные уведомления:**
   - Бот будет отправлять уведомления только о выбранных активах
   - Уведомления учитывают персональные настройки тихих часов

### Для разработчиков

#### Добавить настройку для пользователя
```typescript
// В database.ts
setSomeSetting: (userId: number, value: string) => {
  db.prepare('INSERT OR REPLACE INTO user_settings (user_id, key, value) VALUES (?, ?, ?)')
    .run(userId, 'SOME_SETTING', value);
},

getSomeSetting: (userId: number): string | undefined => {
  const row = db.prepare('SELECT value FROM user_settings WHERE user_id = ? AND key = ?')
    .get(userId, 'SOME_SETTING') as { value: string } | undefined;
  return row?.value;
}
```

#### Получить настройки пользователя в bot.ts
```typescript
bot.command('mycommand', async (ctx) => {
  const userId = ctx.from.id;
  const setting = database.getSomeSetting(userId);
  // ...
});
```

#### Отправить уведомление всем пользователям
```typescript
const users = database.getUsers();

for (const user of users) {
  try {
    await bot.api.sendMessage(user.user_id, 'Важное уведомление');
  } catch (error) {
    console.error(`Error sending to user ${user.user_id}:`, error);
  }
}
```

## Преимущества

✅ **Масштабируемость** - Поддержка неограниченного количества пользователей

✅ **Персонализация** - Каждый пользователь настраивает бота под себя

✅ **Изоляция данных** - Изменения одного пользователя не влияют на других

✅ **Гибкость** - Разные пользователи могут следить за разными активами

✅ **Удобство** - Автоматическая регистрация, простая настройка через /settings

## Обратная совместимость

⚠️ **Внимание:** Это breaking change. После обновления:

1. Старая база данных будет автоматически обновлена при первом запуске
2. Если был установлен ADMIN_CHAT_ID, используйте скрипт миграции для создания admin пользователя
3. Все пользователи должны будут настроить свои preferences через `/settings`

## Тестирование

### Локальное тестирование с несколькими пользователями

1. Создайте несколько тестовых Telegram аккаунтов
2. Запустите бота
3. Отправьте `/start` с каждого аккаунта
4. Настройте разные активы для каждого аккаунта через `/settings`
5. Проверьте, что каждый пользователь получает уведомления только по своим активам

### Проверка изоляции настроек

```bash
# Проверить настройки всех пользователей
npx ts-node scripts/check-db-assets.ts

# Вывод должен показывать разные настройки для разных пользователей
```

## Поддержка

При возникновении проблем:

1. Проверьте структуру базы данных: `sqlite3 bot.db ".schema"`
2. Проверьте список пользователей: `npx ts-node scripts/check-db-assets.ts`
3. Посмотрите логи бота на наличие ошибок
4. Убедитесь, что ADMIN_CHAT_ID правильно установлен в .env (если используется)

## Changelog

### v2.0.0 - Multi-User Support

#### Added
- Таблица `users` для хранения информации о пользователях
- Автоматическая регистрация пользователей при первом взаимодействии
- Персональные настройки для каждого пользователя
- Рассылка уведомлений всем пользователям на основе их настроек
- Скрипт миграции `migrate-multi-user.ts`

#### Changed
- Все методы `database` теперь принимают `userId`
- SchedulerService теперь рассылает уведомления всем пользователям
- CalendarService, MyfxbookService, RssService больше не фильтруют по активам
- Tracking отправленных новостей теперь per-user

#### Removed
- ADMIN_CHAT_ID больше не требуется (опциональный)
- Глобальные настройки (теперь все per-user)

#### Migration
- Запустите `npx ts-node scripts/migrate-multi-user.ts`
- Все существующие пользователи должны настроить свои preferences
