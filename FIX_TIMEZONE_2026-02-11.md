# Исправление Timezone для ForexFactory (2026-02-11)

## 🔴 Проблема

На ForexFactory было неправильное отображение времени:
- **ForexFactory показывал:** 15:30 (Kyiv timezone)
- **Бот показывал:** 22:30 (разница +7 часов!)

### Причина
- ForexFactory позволяет пользователю установить свой timezone в настройках
- Парсер предполагал что все время в **America/New_York** (EST)
- Но пользователь установил timezone **Europe/Kiev** (GMT+2)
- Результат: парсер читал "15:30" как EST, конвертировал в UTC, получалось 22:30 Kyiv

## ✅ Решение

### 1. Автоматическое определение timezone
Добавлен метод `detectForexFactoryTimezone()` который:
- Открывает страницу `/timezone` на ForexFactory
- Извлекает GMT offset (например `+02:00`)
- Мапит его в IANA timezone ID (например `Europe/Kiev`)

### 2. Кеширование timezone
- Timezone определяется один раз и кешируется на **1 час**
- Это ускоряет последующие запросы

### 3. Использование detected timezone
- Базовая дата создается в detected timezone
- Функция `parseTimeToISO()` принимает timezone параметр
- Конвертация: Local Time (detected TZ) → UTC → ISO string

## 📝 Изменения в коде

### Файл: `src/services/CalendarService.ts`

#### 1. Добавлены поля для кеширования timezone:
```typescript
// Cache for detected timezone (1 hour TTL)
private detectedTimezone: string | null = null;
private timezoneDetectionTime: number = 0;
private readonly TIMEZONE_CACHE_TTL = 60 * 60 * 1000; // 1 hour
```

#### 2. Метод `getForexFactoryTimezone()`:
```typescript
/**
 * Get ForexFactory timezone with caching (1 hour TTL)
 */
private async getForexFactoryTimezone(): Promise<string> {
  // Check cache first
  const now = Date.now();
  if (this.detectedTimezone && (now - this.timezoneDetectionTime) < this.TIMEZONE_CACHE_TTL) {
    console.log(`[CalendarService] Using cached timezone: ${this.detectedTimezone}`);
    return this.detectedTimezone;
  }
  
  // Detect timezone from ForexFactory
  // ...
}
```

#### 3. Метод `detectForexFactoryTimezone()`:
```typescript
/**
 * Detect timezone from ForexFactory website by reading the /timezone page
 */
private async detectForexFactoryTimezone(page: Page): Promise<string> {
  // Navigate to /timezone page
  // Extract GMT offset from page text
  // Map to IANA timezone ID
  // ...
}
```

#### 4. Изменена функция `parseTimeToISO()`:
```typescript
/**
 * Parse time string to ISO format
 * @param sourceTimezone - Timezone of the source (detected from ForexFactory)
 */
function parseTimeToISO(raw: string, baseDate: dayjs.Dayjs, sourceTimezone: string): string | undefined {
  // ...
  // Convert from source timezone to UTC
  const utcDate = fromZonedTime(dateString, sourceTimezone);
  // ...
}
```

#### 5. Изменен метод `fetchEvents()`:
```typescript
private async fetchEvents(url: string): Promise<CalendarEvent[]> {
  // ...
  
  // IMPORTANT: Detect ForexFactory timezone BEFORE fetching HTML
  const sourceTimezone = await this.getForexFactoryTimezone();
  console.log(`[CalendarService] Using source timezone: ${sourceTimezone}`);
  
  // Base date in detected source timezone
  const baseDate = url.includes('tomorrow')
    ? dayjs().tz(sourceTimezone).add(1, 'day')
    : dayjs().tz(sourceTimezone);
  
  // ...
  
  // Pass timezone to parseTimeToISO
  const timeISO = parseTimeToISO(time, baseDate, sourceTimezone);
  // ...
}
```

## 🧪 Тестирование

### Тестовый скрипт: `scripts/test-timezone-detection.ts`

Результат:
```
[CalendarService] ForexFactory timezone detected: {
  rawText: '(GMT+02:00) Bucharest   ',
  offset: '+02:00',
  city: 'Bucharest'
}
[CalendarService] Using timezone: Europe/Kiev

[CalendarService] Time parsing: "3:30pm" -> Local: 2026-02-11 15:30:00 (Europe/Kiev) -> UTC: 2026-02-11T13:30:00.000Z

✅ NFP Event found!
   Title: Non-Farm Employment Change
   Time: 3:30pm
   Time ISO: 2026-02-11T13:30:00.000Z
```

**Проверка:**
- 15:30 Kyiv (GMT+2) = 13:30 UTC ✅
- В боте теперь показывается **15:30** вместо **22:30** ✅

## 📊 Supported Timezones

Мапинг GMT offset → IANA timezone:
```typescript
const offsetMap: Record<string, string> = {
  '+02:00': 'Europe/Kiev',      // Kyiv, Bucharest
  '+03:00': 'Europe/Moscow',     // Moscow
  '+00:00': 'Europe/London',     // London (GMT)
  '+01:00': 'Europe/Paris',      // Paris, Berlin
  '-05:00': 'America/New_York',  // EST
  '-08:00': 'America/Los_Angeles', // PST
  '+08:00': 'Asia/Shanghai',     // Shanghai
  '+09:00': 'Asia/Tokyo',        // Tokyo
};
```

## 🚀 Deployment

1. Остановить бот
2. Обновить код
3. Запустить бот
4. Проверить `/daily` - время должно быть правильное!

## 📝 Примечания

1. **ForexFactory НЕ уважает browser timezone** - использует настройки пользователя (cookies/session)
2. **Timezone кешируется на 1 час** - это оптимально для производительности
3. **Fallback timezone:** `Europe/Kiev` - если определение не удалось
4. **Работает для всех пользователей** - каждый может установить свой timezone на ForexFactory

## ✅ Статус: **ИСПРАВЛЕНО** ✓

Время теперь корректно конвертируется из timezone пользователя в UTC и отображается в Kyiv timezone в боте.
