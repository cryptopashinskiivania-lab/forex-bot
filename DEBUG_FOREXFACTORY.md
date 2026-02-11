# Debug ForexFactory Parsing Issue

## Проблема

На сервере `CalendarService` возвращает **0 событий** от ForexFactory, хотя:
- ✅ Playwright запускается успешно
- ✅ HTML загружается без ошибок  
- ✅ События существуют на сайте
- ✅ Локально парсинг работает

## Добавленные инструменты

### 1. Debug Script: `scripts/debug-ff-parsing.ts`

Детальный скрипт для анализа парсинга ForexFactory:
- Загружает HTML через Playwright
- Сохраняет HTML в файл `debug-ff-html.html`
- Показывает каждое событие и причины фильтрации
- Тестирует `CalendarService`

**Запуск локально:**
```bash
npx ts-node scripts/debug-ff-parsing.ts
```

**Запуск на сервере:**
```bash
cd /root/forex-bot
git pull origin main
npm run build
npx ts-node scripts/debug-ff-parsing.ts
```

### 2. Детальные логи в CalendarService

Добавлены логи в `src/services/CalendarService.ts`:
```
[CalendarService] Found X total rows in calendar table
[CalendarService] Filtered: "Event Title" [USD] High - reason: ...
[CalendarService] Parsing complete:
  - Rows processed: X
  - Events found: X
  - Events filtered: X
  - Events passed: X
```

## Инструкция по отладке

### Шаг 1: Обновить код на сервере

```bash
cd /root/forex-bot
git pull origin main
npm install
npm run build
pm2 restart forex-bot
```

### Шаг 2: Запросить `/daily` в боте

Откройте Telegram и отправьте `/daily` боту.

### Шаг 3: Проверить логи

```bash
pm2 logs forex-bot --lines 100 | grep -A 10 "CalendarService\] Found"
```

**Ищите:**
```
[CalendarService] Found 50 total rows in calendar table
[CalendarService] Parsing complete:
  - Rows processed: 50
  - Events found: 3
  - Events filtered: 1
  - Events passed: 2
```

## Возможные результаты

### Сценарий 1: Found 0 rows
```
[CalendarService] Found 0 total rows in calendar table
```

**Причина:** HTML таблицы не найдена или селектор неправильный.

**Решение:** 
1. Запустить `debug-ff-parsing.ts` на сервере
2. Проверить сохраненный HTML файл
3. Сравнить с локальным HTML

### Сценарий 2: Found N rows, Events found: 0
```
[CalendarService] Found 50 total rows
[CalendarService] Parsing complete:
  - Events found: 0
```

**Причина:** События не распознаются парсером.

**Решение:** Проверить структуру HTML, возможно ForexFactory изменил классы.

### Сценарий 3: Events found: N, Events passed: 0
```
[CalendarService] Found 50 rows
[CalendarService] Parsing complete:
  - Events found: 5
  - Events filtered: 5
  - Events passed: 0
```

**Причина:** Все события фильтруются (Low impact или неотслеживаемая валюта).

**Решение:** Проверить логи фильтрации:
```bash
pm2 logs forex-bot | grep "Filtered:"
```

Пример:
```
[CalendarService] Filtered: "CB Consumer Confidence" [USD] Low - reason: low impact
```

### Сценарий 4: Events passed: N > 0, но не показываются

**Причина:** Проблема в дедупликации или форматировании в `bot.ts`.

**Решение:** Проверить логи бота:
```bash
pm2 logs forex-bot | grep "ForexFactory events:"
```

Должно быть:
```
[Bot] ForexFactory events: 2
```

## Дополнительная отладка

### Сравнить HTML локально и на сервере

**Локально:**
```bash
npx ts-node scripts/debug-ff-parsing.ts
# Создаст файл scripts/debug-ff-html.html
```

**На сервере:**
```bash
cd /root/forex-bot
npx ts-node scripts/debug-ff-parsing.ts
cat scripts/debug-ff-html.html
```

Скопируйте HTML с сервера и сравните с локальным.

### Проверить monitored assets

```bash
# На сервере
cd /root/forex-bot
sqlite3 forex_bot.db "SELECT currency FROM monitored_assets;"
```

Должны быть валюты: USD, EUR, GBP, JPY, AUD, CAD, CHF, NZD, CNY

## После исправления

1. Удалить debug скрипт (если больше не нужен)
2. Убрать детальные логи из `CalendarService.ts`
3. Создать коммит с исправлением

---

**Текущий статус:** Debug инструменты установлены, ожидаем результаты с сервера.
