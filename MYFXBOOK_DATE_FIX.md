# Myfxbook Date Filtering Fix

## Проблема

Myfxbook возвращал события за много дней (90 событий за неделю+), вместо четкой фильтрации на "сегодня" или "завтра".

## Решение

Добавлена строгая фильтрация по датам в `MyfxbookService.ts`:

### Изменения в `getEventsForToday()`:

```typescript
async getEventsForToday(): Promise<CalendarEvent[]> {
  const events = await this.fetchEvents(CALENDAR_URL_TODAY);
  
  // Filter to only include today's events
  const tz = getTimezone();
  const nowLocal = dayjs.tz(new Date(), tz);
  const todayStart = nowLocal.startOf('day');
  const todayEnd = nowLocal.endOf('day');
  
  return events.filter(event => {
    if (!event.timeISO) return false;
    
    const eventDate = dayjs(event.timeISO).tz(tz);
    const isToday = eventDate.isAfter(todayStart) && eventDate.isBefore(todayEnd);
    
    return isToday;
  });
}
```

### Изменения в `getEventsForTomorrow()`:

```typescript
async getEventsForTomorrow(): Promise<CalendarEvent[]> {
  const events = await this.fetchEvents(CALENDAR_URL_TOMORROW);
  
  // Filter to only include tomorrow's events
  const tz = getTimezone();
  const nowLocal = dayjs.tz(new Date(), tz);
  const tomorrowStart = nowLocal.add(1, 'day').startOf('day');
  const tomorrowEnd = nowLocal.add(1, 'day').endOf('day');
  
  return events.filter(event => {
    if (!event.timeISO) return false;
    
    const eventDate = dayjs(event.timeISO).tz(tz);
    const isTomorrow = eventDate.isAfter(tomorrowStart) && eventDate.isBefore(tomorrowEnd);
    
    return isTomorrow;
  });
}
```

## Дополнительно: Browser Lock

Добавлена блокировка для предотвращения запуска нескольких экземпляров браузера одновременно:

```typescript
export class MyfxbookService {
  private browser: Browser | null = null;
  private browserLock: Promise<Browser> | null = null;

  private async getBrowser(): Promise<Browser> {
    // If browser is already being launched, wait for it
    if (this.browserLock) {
      console.log('[MyfxbookService] Waiting for browser to launch...');
      return this.browserLock;
    }
    
    if (!this.browser || !this.browser.isConnected()) {
      console.log('[MyfxbookService] Launching Chromium browser...');
      
      // Set lock while launching
      this.browserLock = chromium.launch({ /* ... */ });
      
      try {
        this.browser = await this.browserLock;
        console.log('[MyfxbookService] Browser launched successfully');
      } finally {
        this.browserLock = null;
      }
    }
    return this.browser;
  }
}
```

## Результаты тестирования

### До исправления:
- **90 событий** за неделю (27 января - 3 февраля)

### После исправления:

#### Сегодня (27 января):
```
Found 8 events:
1. [EUR] Medium | New Car Registrations YoY (Dec) - 07:00
2. [EUR] Medium | Consumer Confidence (Jan) - 09:45
3. [EUR] High | Unemployment Rate (Q4) - 10:00
4. [USD] High | ADP Employment Change Weekly - 15:15
5. [USD] Medium | S&P/Case-Shiller Home Price YoY (Nov) - 16:00
6. [USD] Medium | CB Consumer Confidence (Jan) - 17:00
7. [EUR] Medium | ECB President Lagarde Speech - 19:00
8. [USD] Medium | API Crude Oil Stock Change (Jan/23) - 23:30
```

#### Завтра (28 января):
```
Found 9 events:
1. [JPY] Medium | BoJ Monetary Policy Meeting Minutes - 01:50
2. [EUR] High | GfK Consumer Confidence (Feb) - 09:00
3. [EUR] Medium | Consumer Confidence (Jan) - 11:00
4. [EUR] Medium | Business Confidence (Jan) - 11:00
5. [USD] Medium | MBA 30-Year Mortgage Rate (Jan/23) - 14:00
6. [USD] Medium | EIA Gasoline Stocks Change (Jan/23) - 17:30
7. [USD] Medium | EIA Crude Oil Stocks Change (Jan/23) - 17:30
8. [USD] High | Fed Interest Rate Decision - 21:00 ⭐
9. [USD] High | Fed Press Conference - 21:30 ⭐
```

## Проверка

### Время работает правильно:
```
Myfxbook (GMT) → UTC → Kyiv
Jan 27, 05:00 → 05:00 UTC → 07:00 Kyiv ✅
Jan 27, 15:00 → 15:00 UTC → 17:00 Kyiv ✅
```

### Тестовые скрипты:
```bash
# Проверить сегодня
npx ts-node scripts/test-myfxbook.ts

# Проверить завтра
npx ts-node scripts/test-myfxbook-tomorrow.ts

# Проверить время
npx ts-node scripts/test-myfxbook-time.ts
```

## Статус

✅ Проблема решена
✅ Даты фильтруются четко
✅ Время конвертируется правильно (GMT → UTC → Kyiv)
✅ Browser lock предотвращает конфликты
✅ Логирование добавлено для отладки

## Деплой

```bash
git pull
npm ci --only=production
npm run build
pm2 restart forex-news-bot
```
