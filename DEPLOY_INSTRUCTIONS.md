# Инструкции по деплою обновлений

## Что изменилось

1. ✅ Playwright вместо cloudscraper (обход Cloudflare)
2. ✅ Исправлен фильтр событий (Press Conference, Policy Report)
3. ✅ Добавлены валюты: CAD, AUD, CHF

## Деплой на сервер

### Шаг 1: Обновить код

```bash
cd /path/to/forex-news-bot
git pull origin main
```

### Шаг 2: Установить зависимости

```bash
# Установка Node.js пакетов
npm ci --only=production

# Установка Playwright Chromium
npx playwright install chromium

# Установка системных зависимостей (только Linux)
npx playwright install-deps chromium
```

### Шаг 3: Миграция базы данных

```bash
# Обновить отслеживаемые валюты
npx ts-node scripts/migrate-db-assets.ts

# Проверить настройки
npx ts-node scripts/check-db-assets.ts
```

### Шаг 4: Пересобрать проект

```bash
npm run build
```

### Шаг 5: Перезапустить бота

#### Если используете PM2:
```bash
pm2 restart forex-news-bot
pm2 logs forex-news-bot --lines 50
```

#### Если используете systemd:
```bash
sudo systemctl restart forex-news-bot
sudo systemctl status forex-news-bot
journalctl -u forex-news-bot -n 50 -f
```

#### Если используете Docker:
```bash
# Пересобрать образ
docker build -t forex-news-bot .

# Остановить контейнер
docker stop forex-news-bot
docker rm forex-news-bot

# Запустить новый
docker run -d \
  --name forex-news-bot \
  --env-file .env \
  -v $(pwd)/bot.db:/app/bot.db \
  forex-news-bot
```

## Проверка работы

### 1. Проверить логи

Должны увидеть:
```
✅ Bot started with SQLite persistence and Timezone support
[Scheduler] Quiet hours: enabled (23:00-08:00 Kyiv)
SchedulerService started successfully
```

### 2. Проверить отслеживаемые валюты

В боте выполните `/settings` и убедитесь, что видны:
- 🇺🇸 USD
- 🇪🇺 EUR
- 🇬🇧 GBP
- 🇯🇵 JPY
- 🇨🇦 CAD ✅ (новая)
- 🇦🇺 AUD ✅ (новая)
- 🇳🇿 NZD
- 🇨🇭 CHF ✅ (новая)

### 3. Проверить парсинг

```bash
# Локально (на сервере)
npx ts-node scripts/test-tomorrow.ts

# Должно показать все события, включая CAD и Press Conference
```

### 4. Проверить Playwright

В логах при парсинге должны быть:
```
[CalendarService] Launching Chromium browser...
[CalendarService] Navigating to https://...
[CalendarService] Waiting for calendar table...
[CalendarService] Successfully fetched HTML
```

## Откат изменений (если нужно)

```bash
# Откатить код
git revert HEAD

# Откатить зависимости
npm ci --only=production

# Откатить базу данных
npx ts-node scripts/migrate-db-assets.ts
# И вручную установить старые валюты ['USD', 'EUR', 'GBP', 'JPY', 'NZD']

# Пересобрать
npm run build

# Перезапустить
pm2 restart forex-news-bot
```

## Troubleshooting

### Playwright не запускается

```bash
# Переустановить Chromium
npx playwright install chromium --force

# Установить системные зависимости
npx playwright install-deps chromium
```

### База данных не обновляется

```bash
# Удалить и пересоздать
rm bot.db
npx ts-node src/bot.ts  # Запустит бота и создаст новую БД
# Нажать Ctrl+C

# Или запустить миграцию еще раз
npx ts-node scripts/migrate-db-assets.ts
```

### Cloudflare блокирует

1. Проверьте User-Agent (должен быть актуальный Chrome)
2. Увеличьте задержки в `CalendarService.ts`
3. Используйте прокси (если нужно)

## Docker-specific

### Dockerfile

Используйте официальный образ Playwright:

```dockerfile
FROM mcr.microsoft.com/playwright:v1.49.0-jammy

WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
RUN npm run build

CMD ["node", "dist/bot.js"]
```

### Docker Compose

```yaml
version: '3.8'
services:
  forex-news-bot:
    build: .
    container_name: forex-news-bot
    env_file: .env
    volumes:
      - ./bot.db:/app/bot.db
    restart: unless-stopped
    mem_limit: 512m
```

## Мониторинг

### Логи Playwright

```
[CalendarService] Launching Chromium browser...     ← Браузер запускается
[CalendarService] Successfully fetched HTML         ← Cloudflare пройден
[CalendarService] Closing browser...                ← Очистка ресурсов
```

### Graceful Shutdown

При остановке (Ctrl+C или SIGTERM):
```
SIGINT received. Shutting down gracefully...
✅ Scheduler stopped
✅ Bot stopped
```

## Производительность

| Метрика | Значение |
|---------|----------|
| Запуск бота | ~2-3 секунды |
| Парсинг календаря | ~10 секунд |
| Потребление памяти | ~150-200MB |
| CPU (idle) | <5% |
| CPU (парсинг) | 20-30% |

## Итоговый чеклист

- [ ] Код обновлен (`git pull`)
- [ ] Зависимости установлены (`npm ci`)
- [ ] Playwright установлен (`npx playwright install chromium`)
- [ ] База данных мигрирована (`migrate-db-assets.ts`)
- [ ] Проект собран (`npm run build`)
- [ ] Бот перезапущен
- [ ] Логи проверены (нет ошибок)
- [ ] Настройки проверены (`/settings` в боте)
- [ ] Парсинг работает (тест или реальные уведомления)

✅ **Готово к использованию!**
