# Data Quality Service - Итоговое резюме реализации

## 📋 Обзор

Успешно реализован модуль контроля качества данных **DataQualityService**, который проверяет и очищает события перед сохранением в БД и перед отправкой пользователям.

## 📁 Созданные/Изменённые файлы

### Новые файлы

1. **src/types/DataQuality.ts** (НОВЫЙ)
   - Типы для контроля качества данных
   - `DataIssue`, `DataIssueType`, `ValidationResult`, `FilterResult`, `AiQualitySummary`

2. **src/services/DataQualityService.ts** (НОВЫЙ)
   - Основной сервис контроля качества
   - Методы: `checkRawAndNormalize()`, `filterForDelivery()`, `checkCrossSourceConflicts()`, `aiReview()`

3. **scripts/view-data-issues.ts** (НОВЫЙ)
   - Скрипт для просмотра проблем качества данных
   - Статистика по типам и источникам проблем

4. **DATA_QUALITY_MODULE.md** (НОВЫЙ)
   - Полная документация модуля
   - Примеры использования и руководство по расширению

### Изменённые файлы

1. **src/services/CalendarService.ts**
   - ✅ Добавлен `DataQualityService`
   - ✅ Применяется `checkRawAndNormalize()` перед кешированием
   - ✅ Логирование проблем в БД

2. **src/services/MyfxbookService.ts**
   - ✅ Добавлен `DataQualityService`
   - ✅ Применяется `checkRawAndNormalize()` перед кешированием
   - ✅ Логирование проблем в БД

3. **src/services/SchedulerService.ts**
   - ✅ Добавлен `DataQualityService`
   - ✅ Применяется `filterForDelivery()` перед отправкой уведомлений
   - ✅ Фильтрация в daily digest и minuteCheckTask

4. **src/bot.ts**
   - ✅ Добавлен `DataQualityService`
   - ✅ Фильтрация для AI Forecast (режим `ai_forecast`)
   - ✅ Фильтрация для AI Results (режим `ai_results`)
   - ✅ Фильтрация для Tomorrow AI Forecast

5. **src/db/database.ts**
   - ✅ Добавлена таблица `data_issues`
   - ✅ Методы: `logDataIssue()`, `getRecentDataIssues()`
   - ✅ Автоматическая очистка старых проблем (> 7 дней)

## 🔍 Реализованные проверки

### checkRawAndNormalize() - Проверка перед сохранением в БД

1. **Обязательные поля**
   ```typescript
   // Проверяет наличие: title, currency, source, impact
   if (isEmpty(event.title)) missingFields.push('title');
   ```

2. **Валидация impact**
   ```typescript
   // Только High, Medium, Low
   if (!VALIDATION_CONFIG.VALID_IMPACTS.includes(event.impact)) { /* error */ }
   ```

3. **Временной диапазон**
   ```typescript
   // События должны быть в пределах ±2 дней от сегодня
   if (diffDays > VALIDATION_CONFIG.MAX_DAYS_FROM_NOW) { /* error */ }
   ```

4. **Дедупликация**
   ```typescript
   // Одинаковые события из одного источника
   const deduplicationKey = `${event.source}_${event.currency}_${event.title}_${timeKey}`;
   if (seenEvents.has(deduplicationKey)) { /* duplicate */ }
   ```

### filterForDelivery() - Фильтрация перед отправкой

1. **События без времени**
   ```typescript
   if (!event.timeISO) {
     // Пропускаем, если нет времени (кроме AI Results с actual)
     skipped.push({ type: 'NO_TIME', ... });
   }
   ```

2. **Прошедшие события**
   ```typescript
   // События > 30 минут в прошлом (кроме AI Results)
   if (diffMinutes > VALIDATION_CONFIG.PAST_EVENT_THRESHOLD_MINUTES) {
     skipped.push({ type: 'PAST_TOO_FAR', ... });
   }
   ```

3. **Режим-специфичные фильтры**
   - **AI Forecast**: только будущие события
   - **AI Results**: только события с actual данными
   - **General**: общие правила (no time, past too far)
   - **Reminder**: проверка 15-минутного окна

## 📊 Примеры использования

### 1. В парсере (CalendarService)

```typescript
// До (старый код):
const events = /* parse events */;
return events;

// После (с DataQualityService):
const events = /* parse events */;
const { valid, issues } = this.dataQualityService.checkRawAndNormalize(events);

// Логируем проблемы
issues.forEach(issue => {
  database.logDataIssue(issue.eventId, issue.source, issue.type, issue.message, issue.details);
});

return valid; // Возвращаем только валидные события
```

### 2. В scheduler перед отправкой

```typescript
// До (старый код):
const userEvents = events.filter(e => monitoredAssets.includes(e.currency));
for (const event of userEvents) {
  // send notification
}

// После (с DataQualityService):
const userEventsRaw = events.filter(e => monitoredAssets.includes(e.currency));
const { deliver: userEvents } = this.dataQualityService.filterForDelivery(
  userEventsRaw,
  { mode: 'general', nowUtc: new Date() }
);

for (const event of userEvents) {
  // send notification (только валидные события)
}
```

### 3. В bot.ts перед AI анализом

```typescript
// AI Forecast - только будущие события
const { deliver: forecastEvents } = dataQualityService.filterForDelivery(
  eventsRaw,
  { mode: 'ai_forecast', nowUtc: new Date() }
);

// AI Results - только события с actual
const { deliver: resultEvents } = dataQualityService.filterForDelivery(
  eventsRaw,
  { mode: 'ai_results', nowUtc: new Date() }
);
```

## 🗄️ База данных

### Новая таблица data_issues

```sql
CREATE TABLE data_issues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT,
  source TEXT NOT NULL,           -- ForexFactory, Myfxbook, Merge
  type TEXT NOT NULL,              -- MISSING_REQUIRED_FIELD, NO_TIME, etc.
  message TEXT NOT NULL,           -- Описание проблемы
  details TEXT,                    -- JSON с деталями
  created_at INTEGER NOT NULL      -- Timestamp
);
```

### Просмотр проблем

```bash
# Через скрипт
npx ts-node scripts/view-data-issues.ts

# Или через код
const issues = database.getRecentDataIssues(100);
console.log(`Found ${issues.length} issues`);
```

## 🔧 Константы конфигурации

В `DataQualityService.ts`:

```typescript
const VALIDATION_CONFIG = {
  MAX_DAYS_FROM_NOW: 2,                    // ±2 дня от текущей даты
  PAST_EVENT_THRESHOLD_MINUTES: 30,       // 30 минут в прошлом
  VALID_IMPACTS: ['High', 'Medium', 'Low'],
  REQUIRED_FIELDS: ['title', 'currency', 'source', 'impact'],
};
```

## 📈 Типы проблем (DataIssueType)

| Тип | Описание | Критичность |
|-----|----------|-------------|
| `MISSING_REQUIRED_FIELD` | Отсутствует обязательное поле | 🔴 Критично |
| `INVALID_RANGE` | Значение вне допустимого диапазона | 🟠 Средняя |
| `TIME_INCONSISTENCY` | Проблемы с временем события | 🟠 Средняя |
| `DUPLICATE_EVENT` | Дублирующееся событие | 🟡 Низкая |
| `CONFLICT_BETWEEN_SOURCES` | Конфликт между источниками | 🟡 Низкая |
| `PAST_TOO_FAR` | Событие слишком далеко в прошлом | 🟡 Низкая |
| `NO_TIME` | Отсутствует время события | 🟠 Средняя |

## 🎯 Ключевые преимущества

1. ✅ **Единое место контроля** - вся логика в `DataQualityService`
2. ✅ **Прозрачность** - все проблемы логируются в БД
3. ✅ **Гибкость** - легко добавлять новые правила
4. ✅ **Масштабируемость** - готово к AI интеграции
5. ✅ **Надежность** - проверки на каждом этапе (парсинг → отправка → AI)
6. ✅ **Не ломает интерфейс** - изменения прозрачны для пользователя

## 🚀 Как расширять

### Добавить новое правило проверки

```typescript
// В DataQualityService.checkRawAndNormalize()
if (event.newField && !isValidNewField(event.newField)) {
  eventIssues.push({
    eventId,
    source: event.source as 'ForexFactory' | 'Myfxbook',
    type: 'INVALID_RANGE',
    message: `Invalid newField: ${event.newField}`,
    details: { newField: event.newField },
  });
}
```

### Добавить новый режим фильтрации

```typescript
// В DataQualityService.filterForDelivery()
if (mode === 'my_custom_mode') {
  if (!event.customRequirement) {
    skipped.push({
      eventId,
      source: event.source as 'ForexFactory' | 'Myfxbook',
      type: 'CUSTOM_ERROR',
      message: 'Custom error message',
      details: { event },
    });
    shouldSkip = true;
  }
}
```

## 📝 Логи

Примеры логов в консоли:

```
[CalendarService] Applying data quality checks...
[CalendarService] Data quality issues found: 3
  - MISSING_REQUIRED_FIELD: Missing required fields: timeISO
  - DUPLICATE_EVENT: Duplicate event detected: NFP Report
  - TIME_INCONSISTENCY: Event time is too far from now: 3.5 days
[CalendarService] Cached 42 validated events for https://...

[Scheduler] Daily digest: 2 events skipped for user 123456
[Bot] AI Forecast: 1 events skipped due to quality issues
```

## ⚠️ Важные замечания

1. **Не ломает работу бота** - если валидация не пройдена, событие просто не включается в выдачу
2. **Обратная совместимость** - все существующие функции работают как прежде
3. **Производительность** - проверки быстрые, не замедляют работу
4. **Логирование** - все проблемы сохраняются для анализа, но не мешают работе

## 🔮 Будущие улучшения

- [ ] Интеграция `aiReview()` с LLM для автоматического улучшения качества
- [ ] Автоматическое разрешение конфликтов между источниками
- [ ] Веб-интерфейс для просмотра статистики проблем
- [ ] ML-модель для предсказания качества события
- [ ] Алерты админу при критических проблемах

## ✅ Тестирование

Компиляция TypeScript: ✅ Успешно
```bash
npx tsc --noEmit
# Exit code: 0
```

## 📞 Контакты и поддержка

Для вопросов по расширению функциональности обращайтесь к документации:
- **DATA_QUALITY_MODULE.md** - Полная документация
- **scripts/view-data-issues.ts** - Скрипт для просмотра проблем
