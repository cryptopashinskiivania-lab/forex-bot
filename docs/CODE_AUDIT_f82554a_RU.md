# Отчёт по аудиту кода — forex-news-bot @ коммит f82554a

**Область:** Архитектура, типобезопасность, обработка ошибок, управление памятью, качество данных, готовность к продакшену, тестирование, безопасность.

---

## 1. Обзор архитектуры

**Рефакторинг: CalendarService → ForexFactoryCsvService + MyfxbookRssService**

| Находка | Критичность | Место | Детали |
|--------|-------------|--------|--------|
| Разделение ответственности корректно | — | `ForexFactoryCsvService.ts`, `MyfxbookRssService.ts` | FF = CSV URL + America/New_York; Myfxbook = RSS + GMT. Общей календарной логики нет; каждый сервис владеет fetch, parse, cache. |
| Дублирование логики | Низкая | `bot.ts` L154, `SchedulerService.ts` L96, `dailyMessage.ts` L21 | `formatTime24(event, timezone)` реализована трижды. Имеет смысл вынести в общий утил (например `src/utils/formatTime24.ts`), чтобы избежать расхождений. |
| Дублирования бизнес-логики между сервисами нет | — | Оба сервиса | Фильтрация (High/Medium), обработка пустых forecast/previous и использование DataQualityService согласованы, но реализованы по источникам (уместно). |

**Вывод:** Архитектура выстроена правильно. Рекомендация: вынести `formatTime24` в одну общую функцию.

---

## 2. Типобезопасность

| Проблема | Критичность | Файл:Строка | Код / исправление |
|----------|-------------|-------------|-------------------|
| `processQuestion` использует `ctx: any` | Средняя | `bot.ts:822` | Заменить на тип контекста Grammy, например `import type { Context } from 'grammy';` и использовать `Context` (или суженный тип) для первого параметра. |
| В тесте используется `as any` для impact | Низкая | `tests/DataQualityService.test.ts:236` | `impact: 'VeryHigh' as any` — в тестах допустимо для проверки невалидного значения; стоит явно задокументировать, что это намеренно. |
| `formatTime24` предполагает, что `event.time` задан | Низкая | `bot.ts:165` | В `CalendarEvent` указано `time: string`, но при передаче некорректного события `event.time` может быть undefined. Использовать: `const timeStr = (event.time ?? '').trim();` в `formatTime24` в bot, SchedulerService и dailyMessage. |

**Использование CalendarEvent:** Типы из `src/types/calendar.ts` используются единообразно в `bot.ts`, `DataQualityService.ts`, `SchedulerService.ts`, `ForexFactoryCsvService.ts` и `MyfxbookRssService.ts`. Других `any` или пропущенных проверок на null в этих путях не выявлено.

---

## 3. Обработка ошибок

| Проблема | Критичность | Файл:Строка | Код / исправление |
|----------|-------------|-------------|-------------------|
| Состояние пользователя не сбрасывается при раннем выходе в `processQuestion` | **Высокая** | `bot.ts:831-835` | При `!userId` функция выходит без вызова `deleteUserState(ctx.chat?.id)` и без ответа пользователю. Пользователь может остаться в `WAITING_FOR_QUESTION`. Исправление: перед `return` вызвать `if (ctx.chat) deleteUserState(ctx.chat.id);` и по желанию ответить, что вопрос обработать не удалось. |
| В `formatTime24` catch проглатывает ошибки | Низкая | `bot.ts:157-160` | `catch { // Fall through }` — лог не пишется. В продакшене логировать на уровне debug, например `if (process.env.LOG_LEVEL === 'debug') console.debug('[formatTime24] parseISO failed', event.timeISO, e);` (и аналогично в SchedulerService/dailyMessage, если оставить отдельные реализации). |
| MessageQueue: блокировка очереди не снимается при ошибке отправки | **Критическая** | `MessageQueue.ts:49-66` | Если `botInstance.api.sendMessage(...)` выбросит исключение, `isProcessingQueue` не вернётся в `false`, и обработка очереди остановится. Исправление: использовать try/finally и в `finally` выставлять `isProcessingQueue = false`. |
| Пустой catch в ForexFactoryCsvService `parseDateTimeToISO` | Низкая | `ForexFactoryCsvService.ts:82-85` | `catch { // ignore }` — рассмотреть логирование на уровне debug при некорректных строках даты/времени. |
| MyfxbookRssService: при ошибке fetch возвращается [] | — | `MyfxbookRssService.ts:280-284` | Ошибка логируется и возвращается `[]`; приемлемо для отказоустойчивости. |

**processQuestion:** Основной try/catch (L856-866) логирует и отвечает пользователю. Не хватает только сброса состояния на пути раннего выхода и вызова `deleteUserState` на всех путях выхода (включая после успешного ответа).

---

## 4. Управление памятью

| Элемент | Статус | Детали |
|---------|--------|--------|
| userStateEntries TTL | OK | `bot.ts:39-48` — очистка каждые 10 мин, TTL 30 мин; просроченные записи удаляются. |
| Кэш eventAggregation | OK | `eventAggregation.ts:23-35` — у `filteredByTzCache` TTL на запись (5 мин). Ключи — `(source, day, tz)`; число ключей ограничено количеством уникальных часовых поясов. Неограниченного роста нет. |
| MessageQueue | OK | `MessageQueue.ts:14` — `MAX_QUEUE_LENGTH = 2000`; при переполнении сообщения отбрасываются. Утечек нет. |
| Кэши сервисов | OK | ForexFactory 60 мин, Myfxbook 3 мин; очищаются при `close()` / перезаписываются. |

Утечек памяти не выявлено. Единственная функциональная ошибка — блокировка MessageQueue (см. §3).

---

## 5. Качество данных

| Проблема | Критичность | Файл:Строка | Детали |
|----------|-------------|-------------|--------|
| Отфильтрованные в general режиме события не пишутся в БД | Средняя | `bot.ts:345`, путь /tomorrow в `bot.ts` | `/daily` и `/tomorrow` вызывают `filterForDelivery(..., { mode: 'general', forScheduler: false })`, но деструктурируют только `deliver`; `skipped` игнорируется и не передаётся в `database.logDataIssue`. Таким образом NO_TIME / PAST_TOO_FAR и т.п. для general не сохраняются. Исправление: деструктурировать `skipped` и для каждого issue вызывать `database.logDataIssue(issue.eventId, issue.source, issue.type, issue.message, issue.details);` (как для ai_forecast/ai_results в боте). |
| Использование forScheduler | OK | `bot.ts:345`, `SchedulerService.ts:242,553` | Ручные команды используют `forScheduler: false`; планировщик — `forScheduler: true`. Согласовано. |
| Режимы filterForDelivery | OK | `DataQualityService.ts:319-454` | general, ai_forecast, ai_results ведут себя как задумано; отфильтрованные события попадают в `skipped` и возвращаются. Вызывающие ai_forecast/ai_results пишут в БД; вызывающие general пока нет (см. выше). |

---

## 6. Готовность к продакшену

| Проблема | Критичность | Файл:Строка | Рекомендация |
|----------|-------------|-------------|--------------|
| Подробные console.log без проверки LOG_LEVEL | Средняя | Несколько файлов | Оборачивать шумные логи в `process.env.LOG_LEVEL === 'debug'` (или в небольшой логгер). Примеры: `bot.ts` L321, L331-334, L341, L345; `DataQualityService.ts` L101, L217, L225, L331, L355, L390, L414, L440, L451; `eventAggregation.ts` L96-106, L243-306; `MyfxbookRssService.ts` L194-199, L257, L278; `ForexFactoryCsvService.ts` L182-184. Логи старта и ошибок оставить безусловными. |
| Границы ошибок для async | OK | — | У бота есть `bot.catch`; у процесса — обработчики uncaughtException/unhandledRejection. В SchedulerService в цикле по пользователям используется try/catch. |
| Гонки в колбэках | OK | — | Состояние пользователя ключируется по chat id; общего изменяемого состояния между колбэками нет (однопоточный event loop). MessageQueue обрабатывает по одному сообщению; единственная проблема — блокировка (см. §3). |

---

## 7. Покрытие тестами

| Область | Статус | Пробелы |
|---------|--------|---------|
| DataQualityService | Хорошо | `tests/DataQualityService.test.ts` покрывает filterForDelivery (general, ai_forecast, ai_results, forScheduler), checkRawAndNormalize (обязательные поля, impact, дубликаты, NO_TIME, диапазон времени), конфликты между источниками. В одном тесте используется `as any` для impact (см. §2). |
| ForexFactoryCsvService | Нет | Юнит-тестов нет. Важные сценарии: сбой fetchCsv/429, parseCsvToEvents (фильтр по impact, пустые forecast/previous), parseDateTimeToISO (валидные/невалидные/специальные строки времени). Рекомендация: как минимум разбор и поведение при rate-limit с моками. |
| MyfxbookRssService | Нет | Юнит-тестов нет. Важные сценарии: fetchAllEvents (пустая лента, ошибки разбора по элементам), getEventsForToday/Tomorrow (фильтрация по часовому поясу). Рекомендация: замокать парсер и проверить фильтрацию и обработку ошибок. |

---

## 8. Безопасность

| Элемент | Статус | Детали |
|---------|--------|--------|
| Ввод часового пояса | OK | `bot.ts`: timezone задаётся только из (1) колбэка `tz_0`…`tz_9` → `POPULAR_TIMEZONES` (фиксированный список), или (2) `resolveTimezoneInput()`, где вызывается `isValidIANATimezone(trimmed)`. Сырая строка от пользователя без проверки не сохраняется. |
| SQL-инъекции | OK | `database.ts`: все запросы с плейсхолдерами (`?`). Конкатенации пользовательского ввода в SQL нет. |
| Чувствительные данные в логах | Низкая | В `DataQualityService` и в `details` issue может попадать полный объект `event` (например L122 `details: { missingFields, event }`). Если в событиях когда-либо окажутся персональные данные, не логировать полный event; писать только идентификаторы и нужные поля. |

---

## Приоритизированный список замечаний

### Критическая — исправлено

1. **Блокировка MessageQueue при ошибке отправки**  
   **Файл:** `src/services/MessageQueue.ts` (processQueue)  
   **Исправление:** Выставлять `isProcessingQueue = false` в блоке `finally`, чтобы очередь продолжала работать после ошибок отправки.

```ts
async function processQueue(): Promise<void> {
  if (isProcessingQueue || messageQueue.length === 0 || !botInstance) return;
  isProcessingQueue = true;
  const message = messageQueue.shift();
  try {
    if (message) {
      await botInstance.api.sendMessage(message.chatId, message.text, message.options);
      if (process.env.LOG_LEVEL === 'debug') {
        console.log(`[Queue] Message sent to chat ${message.chatId}. Remaining: ${messageQueue.length}`);
      }
    }
  } catch (error) {
    console.error(`[Queue] Error sending message to chat ${message?.chatId}:`, error);
  } finally {
    isProcessingQueue = false;
  }
}
```

### Высокая — исправлено

2. **processQuestion: сбросить состояние пользователя при раннем выходе**  
   **Файл:** `src/bot.ts` (processQuestion, при `!userId`)  
   **Исправление:** Перед выходом сбросить состояние и при необходимости ответить пользователю.

```ts
if (!userId) {
  if (ctx.chat) deleteUserState(ctx.chat.id);
  await ctx.reply('❌ Не удалось определить пользователя.').catch(() => {});
  return;
}
```

### Средняя (исправить в ближайшее время / первом спринте)

3. **Писать отфильтрованные в general режиме события в БД**  
   **Файл:** `src/bot.ts` (команды daily и tomorrow)  
   **Исправление:** Деструктурировать `skipped` из `filterForDelivery` и для каждого вызывать `database.logDataIssue` (как для ai_forecast/ai_results).

4. **Заменить `ctx: any` в processQuestion**  
   **Файл:** `src/bot.ts:822`  
   **Исправление:** Использовать тип `Context` (или подходящий суженный тип) из `grammy`.

5. **Сократить шумное логирование в продакшене**  
   **Файлы:** bot.ts, DataQualityService.ts, eventAggregation.ts, MyfxbookRssService.ts, ForexFactoryCsvService.ts  
   **Исправление:** Оборачивать детальные логи в проверку `process.env.LOG_LEVEL === 'debug'` (или общий логгер).

### Низкая / техдолг (последующие спринты)

6. **Общая `formatTime24`** — Вынести в `src/utils/formatTime24.ts` и использовать в bot, SchedulerService, dailyMessage.  
7. **Защита от null для `event.time` в formatTime24** — Использовать `(event.time ?? '').trim()` во всех трёх реализациях (или в одной общей).  
8. **Логирование в formatTime24 и parseDateTimeToISO** — Добавить логи уровня debug при ошибке разбора.  
9. **Юнит-тесты для ForexFactoryCsvService и MyfxbookRssService** — Мокать HTTP/RSS и проверять разбор и обработку ошибок.  
10. **Детали data issue** — Не логировать полный `event` в details, если в событиях может быть персональная информация; писать только идентификаторы и нужные поля.

---

## Срочные действия и техдолг

| До выката | Техдолг (бэклог) |
|-----------|-------------------|
| ~~Исправить сброс `isProcessingQueue` в MessageQueue в `finally`.~~ ✅ | Вынести общую `formatTime24`. |
| ~~Сбрасывать состояние и при необходимости отвечать при `!userId` в `processQuestion`.~~ ✅ | Типизировать `processQuestion` контекстом Grammy `Context`. |
| (По желанию, но рекомендуется) Писать `skipped` в general режиме в БД для /daily и /tomorrow. | Оборачивать шумные логи в проверки LOG_LEVEL. |
| — | Добавить юнит-тесты для FF CSV и Myfxbook RSS. |
| — | Защита от null для `event.time` и debug-логи в formatTime24/parseDateTimeToISO. |

---

**Аудит выполнен для коммита f82554a.**  
Критические и высокие исправления уже внесены в кодовую базу.
