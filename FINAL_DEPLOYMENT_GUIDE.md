# 🚀 Финальное руководство по деплою

## 📋 Что было исправлено

### 1. ✅ Myfxbook Date Filtering
- **Проблема:** Показывал события за много дней вместо конкретного дня
- **Решение:** Добавлена строгая фильтрация по датам (сегодня/завтра)
- **Файл:** `src/services/MyfxbookService.ts`

### 2. ✅ ForexFactory Source Field
- **Проблема:** `source: "undefined"` вместо `"ForexFactory"`
- **Решение:** Добавлено `source: 'ForexFactory'` в CalendarService
- **Файл:** `src/services/CalendarService.ts`

### 3. ✅ Visual Source Separation
- **Проблема:** События от разных источников не разделялись визуально
- **Решение:** Добавлены секции "━━━ 📰 ForexFactory ━━━" и "━━━ 📊 Myfxbook ━━━"
- **Файл:** `src/bot.ts` (команды `/daily` и `/tomorrow`)

### 4. ✅ Deduplication Priority
- **Проблема:** ForexFactory события заменялись Myfxbook дубликатами
- **Решение:** ForexFactory имеет приоритет, Myfxbook добавляет только уникальные
- **Файл:** `src/bot.ts` (функция `aggregateCoreEvents`)

### 5. ✅ ForexFactory Playwright Migration
- **Проблема:** На сервере Cloudflare блокировал `cloudscraper`, возвращалось 0 событий
- **Решение:** Переписан CalendarService на Playwright (как MyfxbookService)
- **Файл:** `src/services/CalendarService.ts`

## 🔧 Полная процедура деплоя на сервер

### Шаг 1: Обновить код

```bash
cd /root/forex-bot  # или ваш путь
git pull origin main
```

### Шаг 2: Установить зависимости

```bash
# Установить npm пакеты
npm ci --only=production

# Установить Playwright Chromium
npx playwright install chromium

# Установить системные зависимости для Playwright
npx playwright install-deps chromium
```

**Важно:** `playwright install-deps` требует sudo/root привилегии!

### Шаг 3: Добавить типы для better-sqlite3

```bash
npm install --save-dev @types/better-sqlite3
```

### Шаг 4: Пересобрать проект

```bash
npm run build
```

Убедитесь, что нет ошибок компиляции!

### Шаг 5: Перезапустить бота

#### Если используется PM2:
```bash
pm2 restart forex-bot
pm2 logs forex-bot --lines 50
```

#### Если используется systemd:
```bash
sudo systemctl restart forex-news-bot
journalctl -u forex-news-bot -f
```

#### Если запущен вручную:
```bash
pkill -f "node.*bot"
nohup npx ts-node src/bot.ts > bot.log 2>&1 &
tail -f bot.log
```

### Шаг 6: Проверить работу

Отправьте `/tomorrow` в Telegram и проверьте логи:

```bash
pm2 logs forex-bot --lines 100 | grep -E "(ForexFactory|Myfxbook|Bot\])"
```

**Ожидаемый вывод:**

```
[CalendarService] Launching Chromium browser...
[CalendarService] Browser launched successfully
[CalendarService] Successfully fetched HTML
[MyfxbookService] Launching Chromium browser...
[MyfxbookService] Browser launched successfully
[MyfxbookService] Successfully fetched HTML
[Bot] ForexFactory events: 3          ← Должно быть > 0!
[Bot] ForexFactory keys: [...]
[Bot] Skipped duplicate Myfxbook event: Fed Interest Rate Decision
[Bot] Skipped duplicate Myfxbook event: Fed Press Conference
[Bot] Total events after deduplication: 10
```

## 📱 Ожидаемый результат в Telegram

### Команда `/tomorrow`:

```
📅 Календарь на завтра:

━━━ 📰 ForexFactory ━━━

1. 🔴 [USD] Federal Funds Rate
   🕐 21:00  •  Прогноз: 3.75%  •  Предыдущее: 3.75%

2. 🔴 [USD] FOMC Statement
   🕐 21:00  •  Прогноз: —  •  Предыдущее: —

3. 🔴 [USD] FOMC Press Conference
   🕐 21:30  •  Прогноз: —  •  Предыдущее: —

━━━ 📊 Myfxbook ━━━

4. 🟠 [JPY] BoJ Monetary Policy Meeting Minutes
   🕐 01:50  •  Прогноз: —  •  Предыдущее: —

5. 🔴 [EUR] GfK Consumer Confidence (Feb)
   🕐 09:00  •  Прогноз: -25.8  •  Предыдущее: -26.9

...
```

## ✅ Чек-лист проверки

- [ ] `git pull` выполнен
- [ ] `npm ci` установил зависимости
- [ ] `@types/better-sqlite3` установлен
- [ ] `playwright install chromium` выполнен
- [ ] `playwright install-deps chromium` выполнен
- [ ] `npm run build` завершился без ошибок
- [ ] Бот перезапущен
- [ ] В логах видно `[Bot] ForexFactory events: 3+` (не 0)
- [ ] В логах видно `[Bot] Total events after deduplication: 10+`
- [ ] В Telegram отображаются обе секции (ForexFactory и Myfxbook)
- [ ] FOMC события присутствуют в секции ForexFactory

## 🐛 Troubleshooting

### Проблема: `[Bot] ForexFactory events: 0`

**Решение:**
```bash
# Убедиться, что Playwright установлен правильно
npx playwright install chromium
npx playwright install-deps chromium

# Проверить логи на ошибки браузера
pm2 logs forex-bot --lines 200 | grep -i "error\|failed"
```

### Проблема: `Could not find browser`

**Решение:**
```bash
npx playwright install chromium --force
```

### Проблема: `Failed to launch browser`

**Решение:**
```bash
# Установить системные зависимости
sudo apt-get install -y \
  libnss3 \
  libxss1 \
  libasound2 \
  libatk-bridge2.0-0 \
  libgtk-3-0 \
  libgbm1

# Или использовать playwright install-deps
npx playwright install-deps chromium
```

### Проблема: TypeScript ошибки при сборке

**Решение:**
```bash
npm install --save-dev @types/better-sqlite3
npm run build
```

### Проблема: Разделение не отображается в Telegram

**Решение:**
Проверьте, что в логах:
```
[Bot] ForexFactory events: 3+    ← Не должно быть 0
```

Если 0, смотрите "Проблема: ForexFactory events: 0" выше.

## 📊 Мониторинг

### Проверка здоровья бота:

```bash
# PM2 статус
pm2 status

# Логи в реальном времени
pm2 logs forex-bot --lines 50

# Проверка ForexFactory
pm2 logs forex-bot --lines 200 | grep "ForexFactory events"

# Проверка Myfxbook
pm2 logs forex-bot --lines 200 | grep "Myfxbook.*Found.*events"

# Проверка дедупликации
pm2 logs forex-bot --lines 200 | grep "Total events after deduplication"
```

### Ожидаемые значения:

```
[Bot] ForexFactory events: 2-10     ← Зависит от дня
[MyfxbookService] Found 72-90 events
[Bot] Total events after deduplication: 5-15
```

## 🎉 Результат

После деплоя бот будет:

✅ Показывать события от **обоих** источников  
✅ Разделять их визуально по секциям  
✅ **ForexFactory в приоритете** (без дубликатов)  
✅ Работать **стабильно на сервере** (Playwright обходит Cloudflare)  
✅ Фильтровать события **строго по датам**  
✅ Отображать **FOMC события** правильно  

## 📚 Документация

- `FOREXFACTORY_PLAYWRIGHT_FIX.md` - Детали миграции на Playwright
- `MYFXBOOK_DATE_FIX.md` - Исправление фильтрации дат
- `PLAYWRIGHT_SETUP.md` - Установка и настройка Playwright
- `IMPLEMENTATION_SUMMARY.md` - Общая сводка по проекту

---

**Готово к деплою!** 🚀
