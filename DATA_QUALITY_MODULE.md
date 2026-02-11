# Data Quality Module - Модуль контроля качества данных

## Описание

Модуль `DataQualityService` предназначен для проверки и очистки экономических событий перед сохранением в БД и перед отправкой пользователям. Цель — повысить качество и достоверность выходных данных.

## Архитектура

### Файлы модуля

1. **src/types/DataQuality.ts** - Типы для контроля качества данных
2. **src/services/DataQualityService.ts** - Основной сервис проверки качества
3. **src/db/database.ts** - Дополнительные методы для логирования проблем

### Типы проблем (DataIssueType)

```typescript
type DataIssueType =
  | 'MISSING_REQUIRED_FIELD'      // Отсутствует обязательное поле
  | 'INVALID_RANGE'               // Значение вне допустимого диапазона
  | 'TIME_INCONSISTENCY'          // Проблемы с временем события
  | 'DUPLICATE_EVENT'             // Дублирующееся событие
  | 'CONFLICT_BETWEEN_SOURCES'    // Конфликт между источниками
  | 'PAST_TOO_FAR'                // Событие слишком далеко в прошлом
  | 'NO_TIME'                     // Отсутствует время события
```

## Основные методы DataQualityService

### 1. checkRawAndNormalize(events: CalendarEvent[])

Проверяет и нормализует события перед сохранением в БД.

**Проверки:**
- ✅ Обязательные поля (title, currency, source, impact)
- ✅ Валидация impact (только High/Medium/Low)
- ✅ Проверка временного диапазона (±2 дня от текущей даты)
- ✅ Дедупликация (одинаковые события из одного источника)

**Пример использования:**

```typescript
const dataQualityService = new DataQualityService();
const rawEvents = await calendarService.fetchEvents(url);

const { valid, issues } = dataQualityService.checkRawAndNormalize(rawEvents);

// valid - очищенные события для сохранения в БД
// issues - список обнаруженных проблем

// Сохраняем проблемы в БД
issues.forEach(issue => {
  database.logDataIssue(
    issue.eventId,
    issue.source,
    issue.type,
    issue.message,
    issue.details
  );
});

// Возвращаем только валидные события
return valid;
```

### 2. filterForDelivery(events: CalendarEvent[], options)

Фильтрует события перед отправкой пользователю или в AI-сервисы.

**Режимы фильтрации:**
- `general` - Общий режим (по умолчанию)
- `reminder` - Для напоминаний
- `ai_forecast` - Для AI прогноза (только будущие события)
- `ai_results` - Для AI анализа результатов (только события с actual)

**Правила фильтрации:**
- ❌ События без времени (кроме AI Results с actual)
- ❌ События > 30 минут в прошлом (кроме AI Results)
- ✅ Для AI Forecast: только будущие события
- ✅ Для AI Results: только события с actual данными

**Пример использования:**

```typescript
const dataQualityService = new DataQualityService();

// Перед отправкой напоминания
const { deliver, skipped } = dataQualityService.filterForDelivery(
  events,
  { mode: 'reminder', nowUtc: new Date() }
);

// Перед AI Forecast
const { deliver: forecastEvents } = dataQualityService.filterForDelivery(
  events,
  { mode: 'ai_forecast', nowUtc: new Date() }
);

// Перед AI Results
const { deliver: resultEvents } = dataQualityService.filterForDelivery(
  events,
  { mode: 'ai_results', nowUtc: new Date() }
);
```

### 3. checkCrossSourceConflicts(allEvents: CalendarEvent[])

Проверяет конфликты между разными источниками (ForexFactory vs Myfxbook).

**Проверки:**
- Похожие названия событий (similarity > 0.7)
- Разница во времени > 5 минут
- Разные данные для одного и того же события

**Пример использования:**

```typescript
const allEvents = [...forexFactoryEvents, ...myfxbookEvents];
const conflicts = dataQualityService.checkCrossSourceConflicts(allEvents);

if (conflicts.length > 0) {
  console.log(`Found ${conflicts.length} conflicts between sources`);
  conflicts.forEach(conflict => {
    console.log(`Conflict: ${conflict.message}`);
  });
}
```

## Интеграция в существующий код

### 1. CalendarService и MyfxbookService

Парсеры автоматически применяют `checkRawAndNormalize` перед кешированием событий:

```typescript
// В CalendarService.fetchEvents():
const events = /* parse events from HTML */;

// Применяем проверку качества
const { valid, issues } = this.dataQualityService.checkRawAndNormalize(events);

// Логируем проблемы в БД
issues.forEach(issue => {
  database.logDataIssue(issue.eventId, issue.source, issue.type, issue.message, issue.details);
});

// Кешируем и возвращаем только валидные события
this.cache.set(url, { data: valid, expires: Date.now() + this.CACHE_TTL });
return valid;
```

### 2. SchedulerService

Перед отправкой уведомлений применяется `filterForDelivery`:

```typescript
// Получаем события для пользователя
const events = await aggregateCoreEvents(this.calendarService, this.myfxbookService, userId);

// Фильтруем по активам пользователя
const userEventsRaw = events.filter(e => monitoredAssets.includes(e.currency));

// Применяем фильтр качества
const { deliver: userEvents } = this.dataQualityService.filterForDelivery(
  userEventsRaw,
  { mode: 'general', nowUtc: new Date() }
);

// Отправляем только отфильтрованные события
for (const event of userEvents) {
  // ... send notification
}
```

### 3. bot.ts (команды /daily, /tomorrow)

Перед AI анализом применяется соответствующий режим фильтрации:

```typescript
// AI Forecast
const eventsRaw = allEvents.filter(e => monitoredAssets.includes(e.currency));
const { deliver: events } = dataQualityService.filterForDelivery(
  eventsRaw,
  { mode: 'ai_forecast', nowUtc: new Date() }
);

// AI Results
const { deliver: eventsWithResults } = dataQualityService.filterForDelivery(
  eventsRaw,
  { mode: 'ai_results', nowUtc: new Date() }
);
```

## База данных

### Таблица data_issues

Хранит все обнаруженные проблемы качества данных:

```sql
CREATE TABLE data_issues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT,
  source TEXT NOT NULL,
  type TEXT NOT NULL,
  message TEXT NOT NULL,
  details TEXT,
  created_at INTEGER NOT NULL
);
```

### Методы для работы с проблемами

```typescript
// Сохранить проблему
database.logDataIssue(eventId, source, type, message, details);

// Получить последние проблемы
const recentIssues = database.getRecentDataIssues(100);

// Автоматическая очистка (при database.cleanup())
// Удаляются проблемы старше 7 дней
```

## Скрипт для просмотра проблем

Используйте скрипт `scripts/view-data-issues.ts` для просмотра проблем:

```bash
npx ts-node scripts/view-data-issues.ts
```

## Расширение функциональности

### Добавление новых правил проверки

В `DataQualityService.checkRawAndNormalize()`:

```typescript
// 5. Новая проверка
if (event.someField && !isValidSomeField(event.someField)) {
  eventIssues.push({
    eventId,
    source: event.source as 'ForexFactory' | 'Myfxbook',
    type: 'INVALID_RANGE', // или добавить новый тип
    message: `Invalid someField value: ${event.someField}`,
    details: { someField: event.someField },
  });
}
```

### Добавление новых режимов фильтрации

В `DataQualityService.filterForDelivery()`:

```typescript
if (mode === 'my_custom_mode') {
  // Специфичная логика для нового режима
  if (!event.someRequirement) {
    skipped.push({...});
    shouldSkip = true;
  }
}
```

### Интеграция с AI Review (будущее)

Метод `aiReview()` подготовлен для интеграции с LLM:

```typescript
async aiReview(
  events: CalendarEvent[],
  issues: DataIssue[]
): Promise<AiQualitySummary> {
  // TODO: Интегрировать с AI сервисом
  const prompt = `Analyze these data quality issues: ${JSON.stringify(issues)}`;
  const aiResponse = await llmService.analyze(prompt);
  
  return {
    totalEvents: events.length,
    validEvents: events.length - issues.length,
    issues,
    recommendations: aiResponse.recommendations,
  };
}
```

## Мониторинг и отладка

### Логи

Все операции логируются в консоль:

```
[CalendarService] Applying data quality checks...
[CalendarService] Data quality issues found: 5
  - MISSING_REQUIRED_FIELD: Missing required fields: timeISO
  - DUPLICATE_EVENT: Duplicate event detected: NFP Report
[CalendarService] Cached 45 validated events for https://...
```

### Просмотр статистики проблем

```typescript
const issues = database.getRecentDataIssues(100);

// Группировка по типу
const byType = issues.reduce((acc, issue) => {
  acc[issue.type] = (acc[issue.type] || 0) + 1;
  return acc;
}, {});

console.log('Issues by type:', byType);
```

## Константы конфигурации

В `DataQualityService.ts`:

```typescript
const VALIDATION_CONFIG = {
  MAX_DAYS_FROM_NOW: 2,                    // Максимальное отклонение времени события (дни)
  PAST_EVENT_THRESHOLD_MINUTES: 30,       // Порог для "слишком старых" событий (минуты)
  VALID_IMPACTS: ['High', 'Medium', 'Low'], // Допустимые значения impact
  REQUIRED_FIELDS: ['title', 'currency', 'source', 'impact'], // Обязательные поля
};
```

Эти константы можно легко изменить для настройки правил валидации.

## Преимущества

1. ✅ **Единое место контроля качества** - вся логика в одном сервисе
2. ✅ **Логирование проблем** - все проблемы сохраняются в БД для анализа
3. ✅ **Гибкость** - легко добавлять новые правила и режимы
4. ✅ **Прозрачность** - детальное логирование всех операций
5. ✅ **Масштабируемость** - готово к интеграции с AI для автоматического улучшения
6. ✅ **Надежность** - события проверяются на каждом этапе (парсинг → отправка → AI анализ)

## Планы развития

- [ ] Интеграция с LLM для `aiReview()` метода
- [ ] Автоматическое разрешение конфликтов между источниками
- [ ] Веб-интерфейс для просмотра проблем качества
- [ ] Алерты при критических проблемах
- [ ] Статистика качества данных по источникам
- [ ] ML-модель для предсказания качества события
