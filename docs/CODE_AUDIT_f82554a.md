# Code Audit Report — forex-news-bot @ commit f82554a

**Scope:** Architecture, type safety, error handling, memory management, data quality, production readiness, testing, security.

---

## 1. Architecture Review

**Refactoring: CalendarService → ForexFactoryCsvService + MyfxbookRssService**

| Finding | Severity | Location | Details |
|--------|----------|----------|---------|
| Separation of concerns is correct | — | `ForexFactoryCsvService.ts`, `MyfxbookRssService.ts` | FF = CSV URL + America/New_York; Myfxbook = RSS + GMT. No shared calendar logic; each service owns fetch, parse, cache. |
| Duplicated logic | Low | `bot.ts` L154, `SchedulerService.ts` L96, `dailyMessage.ts` L21 | `formatTime24(event, timezone)` implemented three times. Consider moving to a shared util (e.g. `src/utils/formatTime24.ts`) to avoid drift. |
| No duplicated business logic between services | — | Both services | Filtering (High/Medium), empty forecast/previous handling, and DataQualityService usage are consistent but implemented per source (appropriate). |

**Conclusion:** Architecture is sound. Only recommendation: extract `formatTime24` to a single shared function.

---

## 2. Type Safety

| Issue | Severity | File:Line | Code / Fix |
|-------|----------|-----------|------------|
| `processQuestion` uses `ctx: any` | Medium | `bot.ts:822` | Replace with Grammy context type, e.g. `import type { Context } from 'grammy';` and use `Context` (or a narrowed type) for the first parameter. |
| Test uses `as any` for impact | Low | `tests/DataQualityService.test.ts:236` | `impact: 'VeryHigh' as any` — acceptable in tests to force invalid value; document that it’s intentional. |
| `formatTime24` assumes `event.time` is defined | Low | `bot.ts:165` | `CalendarEvent` defines `time: string`, but if a malformed event is passed, `event.time` could be undefined. Use: `const timeStr = (event.time ?? '').trim();` in `formatTime24` in bot, SchedulerService, and dailyMessage. |

**CalendarEvent usage:** Types from `src/types/calendar.ts` are used consistently in `bot.ts`, `DataQualityService.ts`, `SchedulerService.ts`, `ForexFactoryCsvService.ts`, and `MyfxbookRssService.ts`. No other `any` or missing null checks identified in these paths.

---

## 3. Error Handling

| Issue | Severity | File:Line | Code / Fix |
|-------|----------|-----------|------------|
| User state not cleared on early return in `processQuestion` | **High** | `bot.ts:831-835` | When `!userId`, function returns without calling `deleteUserState(ctx.chat?.id)` (and without replying). User can remain stuck in `WAITING_FOR_QUESTION`. Fix: before `return`, call `if (ctx.chat) deleteUserState(ctx.chat.id);` and optionally reply that the question could not be processed. |
| `formatTime24` catch swallows errors | Low | `bot.ts:157-160` | `catch { // Fall through }` — no log. In production, log at debug level, e.g. `if (process.env.LOG_LEVEL === 'debug') console.debug('[formatTime24] parseISO failed', event.timeISO, e);` (and same in SchedulerService/dailyMessage if kept separate). |
| MessageQueue: queue lock never released on send failure | **Critical** | `MessageQueue.ts:49-66` | If `botInstance.api.sendMessage(...)` throws, `isProcessingQueue` is never set back to `false`, so the queue stops processing. Fix: use try/finally and set `isProcessingQueue = false` in `finally`. |
| ForexFactoryCsvService `parseDateTimeToISO` empty catch | Low | `ForexFactoryCsvService.ts:82-85` | `catch { // ignore }` — consider logging at debug for bad date/time strings. |
| MyfxbookRssService: fetch error returns [] | — | `MyfxbookRssService.ts:280-284` | Error is logged and returns `[]`; acceptable for resilience. |

**processQuestion:** The main try/catch (L856-866) logs and replies to the user. Missing piece is only state cleanup on the early return path and ensuring `deleteUserState` is called on all exit paths (including after successful reply).

---

## 4. Memory Management

| Item | Status | Details |
|------|--------|---------|
| userStateEntries TTL | OK | `bot.ts:39-48` — cleanup every 10 min, TTL 30 min; expired entries removed. |
| eventAggregation cache | OK | `eventAggregation.ts:23-35` — `filteredByTzCache` has per-entry TTL (5 min). Keys are `(source, day, tz)`; number of keys bounded by unique timezones in use. No unbounded growth. |
| MessageQueue | OK | `MessageQueue.ts:14` — `MAX_QUEUE_LENGTH = 2000`; drops messages when full. No leak. |
| Service caches | OK | ForexFactory 60 min, Myfxbook 3 min; cleared on `close()` / overwritten. |

No memory leaks identified. Only functional bug is the MessageQueue lock (see §3).

---

## 5. Data Quality

| Issue | Severity | File:Line | Details |
|-------|----------|-----------|---------|
| General-mode skipped events not logged to DB | Medium | `bot.ts:345`, `bot.ts` /tomorrow path | `/daily` and `/tomorrow` use `filterForDelivery(..., { mode: 'general', forScheduler: false })` but only destructure `deliver`; `skipped` is ignored and never passed to `database.logDataIssue`. So NO_TIME / PAST_TOO_FAR etc. for general mode are not persisted. Fix: destructure `skipped` and log each issue: `skipped.forEach(issue => database.logDataIssue(issue.eventId, issue.source, issue.type, issue.message, issue.details));` (same pattern as ai_forecast/ai_results in bot). |
| forScheduler usage | OK | `bot.ts:345`, `SchedulerService.ts:242,553` | Manual commands use `forScheduler: false`; scheduler uses `forScheduler: true`. Consistent. |
| filterForDelivery modes | OK | `DataQualityService.ts:319-454` | general, ai_forecast, ai_results behave as intended; skipped events are pushed to `skipped` and returned. Callers for ai_forecast/ai_results log to DB; general-mode callers currently do not (see above). |

---

## 6. Production Readiness

| Issue | Severity | File:Line | Recommendation |
|-------|----------|-----------|----------------|
| Verbose console.log without LOG_LEVEL | Medium | Multiple | Wrap noisy logs in `process.env.LOG_LEVEL === 'debug'` (or a small logger helper). Examples: `bot.ts` L321, L331-334, L341, L345; `DataQualityService.ts` L101, L217, L225, L331, L355, L390, L414, L440, L451; `eventAggregation.ts` L96-106, L243-306; `MyfxbookRssService.ts` L194-199, L257, L278; `ForexFactoryCsvService.ts` L182-184. Keep startup and error logs unconditional. |
| Async error boundaries | OK | — | Bot has `bot.catch`; process has uncaughtException/unhandledRejection handlers. SchedulerService uses try/catch in user loop. |
| Race conditions in callbacks | OK | — | User state is keyed by chat id; no shared mutable state between concurrent callbacks beyond Map updates (single-threaded event loop). MessageQueue processes one message at a time; lock bug is the only issue (see §3). |

---

## 7. Testing Coverage

| Area | Status | Gap |
|------|--------|-----|
| DataQualityService | Good | `tests/DataQualityService.test.ts` covers filterForDelivery (general, ai_forecast, ai_results, forScheduler), checkRawAndNormalize (required fields, impact, duplicates, NO_TIME, time range), cross-source conflicts. One test uses `as any` for impact (see §2). |
| ForexFactoryCsvService | None | No unit tests. Critical paths: fetchCsv failure/429, parseCsvToEvents (impact filter, empty forecast/previous), parseDateTimeToISO (valid/invalid/special time strings). Recommend: at least parse + rate-limit behavior with mocks. |
| MyfxbookRssService | None | No unit tests. Critical paths: fetchAllEvents (empty feed, parse errors per item), getEventsForToday/Tomorrow (timezone filtering). Recommend: mock parser and test filtering and error handling. |

---

## 8. Security

| Item | Status | Details |
|------|--------|---------|
| Timezone input | OK | `bot.ts`: timezone set only from (1) callback `tz_0`…`tz_9` → `POPULAR_TIMEZONES` (fixed list), or (2) `resolveTimezoneInput()` which uses `isValidIANATimezone(trimmed)`. No raw user string stored without validation. |
| SQL injection | OK | `database.ts`: all queries use parameterized placeholders (`?`). No concatenation of user input into SQL. |
| Sensitive data in logs | Low | `DataQualityService` and issue `details` may include full `event` object (e.g. L122 `details: { missingFields, event }`). If events ever contain PII, avoid logging full event; log only ids and non-sensitive fields. |

---

## Prioritized Issue List

### Critical (fix before deployment)

1. **MessageQueue lock on send failure**  
   **File:** `src/services/MessageQueue.ts` (processQueue)  
   **Fix:** Set `isProcessingQueue = false` in a `finally` block so the queue continues after send errors.

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

### High (fix before deployment)

2. **processQuestion: clear user state on early return**  
   **File:** `src/bot.ts` (processQuestion, when `!userId`)  
   **Fix:** Before returning, clear state and optionally reply.

```ts
if (!userId) {
  if (ctx.chat) deleteUserState(ctx.chat.id);
  await ctx.reply('❌ Не удалось определить пользователя.').catch(() => {});
  return;
}
```

### Medium (fix soon / first sprint)

3. **Log general-mode skipped events to DB**  
   **File:** `src/bot.ts` (daily and tomorrow commands)  
   **Fix:** Destructure `skipped` from `filterForDelivery` and call `database.logDataIssue` for each (same as ai_forecast/ai_results).

4. **Replace `ctx: any` in processQuestion**  
   **File:** `src/bot.ts:822`  
   **Fix:** Use `Context` (or appropriate narrowed type) from `grammy`.

5. **Reduce verbose logging in production**  
   **Files:** bot.ts, DataQualityService.ts, eventAggregation.ts, MyfxbookRssService.ts, ForexFactoryCsvService.ts  
   **Fix:** Guard detailed logs with `process.env.LOG_LEVEL === 'debug'` (or a shared logger).

### Low / Technical debt (later sprints)

6. **Shared `formatTime24`** — Extract to `src/utils/formatTime24.ts` and use in bot, SchedulerService, dailyMessage.  
7. **formatTime24 null-safe `event.time`** — Use `(event.time ?? '').trim()` in all three implementations (or in the single shared one).  
8. **Logging in formatTime24 and parseDateTimeToISO** — Add debug-level logs when parsing fails.  
9. **Unit tests for ForexFactoryCsvService and MyfxbookRssService** — Mock HTTP/RSS and test parse paths and error handling.  
10. **Data issue details** — Avoid logging full `event` in issue details if events might contain PII; log only identifiers and necessary fields.

---

## Immediate Actions vs Technical Debt

| Before deployment | Technical debt (backlog) |
|-------------------|---------------------------|
| Fix MessageQueue `isProcessingQueue` in `finally`. | Extract shared `formatTime24`. |
| Clear user state and reply when `!userId` in `processQuestion`. | Type `processQuestion` with Grammy `Context`. |
| (Optional but recommended) Log general-mode `skipped` to DB for /daily and /tomorrow. | Wrap verbose logs in LOG_LEVEL checks. |
| — | Add unit tests for FF CSV and Myfxbook RSS. |
| — | Null-safe `event.time` and debug logging in formatTime24/parseDateTimeToISO. |

---

**Audit completed for commit f82554a.**  
If you want, I can implement the Critical and High fixes in the codebase next.
