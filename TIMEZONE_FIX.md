# Исправление Timezone для ForexFactory

## Проблема

ForexFactory отображал неправильное время в боте:
- **На сайте ForexFactory** (с настройкой Kyiv timezone): **21:00** и **21:30**
- **В Telegram боте** (блок ForexFactory): **04:00** и **04:30** ❌

## Причина

Playwright открывал ForexFactory с timezone `America/New_York`, и сайт отдавал время в NY timezone (9:00pm = 21:00 NY). Код конвертировал это время как NY → UTC → Kyiv, что давало:
- 21:00 NY (9:00pm) → 02:00 UTC (29 января) → 04:00 Kyiv (29 января)

Но на самом деле ForexFactory показывает время в timezone, выбранном пользователем на сайте. Когда пользователь настраивает Kyiv timezone, сайт показывает 21:00 (уже в Kyiv времени).

## Решение

Изменили настройки Playwright и парсинга:

1. **CalendarService.ts** - изменили timezone на `Europe/Kyiv`:
   ```typescript
   const FF_TZ = 'Europe/Kyiv'; // ForexFactory will show times in this timezone
   ```

2. **fetchHTML()** - добавили `timezoneId` в настройки Playwright:
   ```typescript
   const page: Page = await browser.newPage({
     userAgent: '...',
     viewport: { width: 1920, height: 1080 },
     timezoneId: 'Europe/Kyiv', // Set timezone to match user's ForexFactory settings
     locale: 'en-US',
   });
   ```

3. **parseTimeToISO()** - обновили комментарии:
   ```typescript
   // This time string represents Europe/Kyiv local time (as set in Playwright timezoneId)
   const utcDate = fromZonedTime(dateString, FF_TZ);
   ```

## Результат

✅ **ForexFactory в боте теперь показывает правильное время:**
- Federal Funds Rate: **21:00** ✅ (было 04:00)
- FOMC Press Conference: **21:30** ✅ (было 04:30)

✅ **Время совпадает с настройками пользователя на ForexFactory**

✅ **Дедупликация работает корректно** - события от ForexFactory и Myfxbook с одинаковым временем распознаются как дубликаты

## Тестирование

```bash
# Тест парсинга ForexFactory
npx ts-node scripts/test-calendar-scrape.ts

# Тест команды /daily
npx ts-node scripts/test-daily-command.ts

# Сборка проекта
npm run build
```

## Дата исправления

28 января 2026

## Измененные файлы

1. `src/services/CalendarService.ts`
2. `scripts/test-calendar-scrape.ts`
3. `IMPLEMENTATION_SUMMARY.md`
