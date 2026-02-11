# Исправление: Не все события отображались

## Проблема

Бот показывал не все важные события из календаря ForexFactory:
- ❌ Отсутствовали события типа "Press Conference"
- ❌ Не отслеживались валюты CAD, AUD, CHF
- ❌ Пример: "FOMC Press Conference" и события Bank of Canada не показывались

## Что было исправлено

### 1. Расширен фильтр событий без данных

**Было:**
```typescript
const isSpeechMinutesStatement = /Speech|Minutes|Statement/i.test(title);
```

**Стало:**
```typescript
const isSpeechMinutesStatement = /Speech|Minutes|Statement|Press Conference|Policy Report/i.test(title);
```

Теперь события типа "Press Conference" и "Policy Report" **не фильтруются**, даже если у них нет прогноза/предыдущих значений.

**Файлы:**
- `src/services/CalendarService.ts`
- `src/services/MyfxbookService.ts`

### 2. Добавлены новые валюты

**Было:**
```typescript
const DEFAULT_ASSETS = ['USD', 'EUR', 'GBP', 'JPY', 'NZD'];
const AVAILABLE_ASSETS = ['USD', 'EUR', 'GBP', 'JPY', 'NZD', 'XAU', 'BTC', 'OIL'];
```

**Стало:**
```typescript
const DEFAULT_ASSETS = ['USD', 'EUR', 'GBP', 'JPY', 'CAD', 'AUD', 'NZD', 'CHF'];
const AVAILABLE_ASSETS = ['USD', 'EUR', 'GBP', 'JPY', 'CAD', 'AUD', 'NZD', 'CHF', 'XAU', 'BTC', 'OIL'];
```

**Файлы:**
- `src/db/database.ts` - дефолтные отслеживаемые валюты
- `src/bot.ts` - доступные валюты в настройках
- `src/services/SchedulerService.ts` - флаги валют

**Добавленные валюты:**
- 🇨🇦 **CAD** - Canadian Dollar (Bank of Canada)
- 🇦🇺 **AUD** - Australian Dollar (Reserve Bank of Australia)
- 🇨🇭 **CHF** - Swiss Franc (Swiss National Bank)

## Результаты

### До исправления (28 января):
```
Found 2 events:
1. [USD] High | Federal Funds Rate
2. [USD] High | FOMC Statement
```

❌ Отсутствовали: FOMC Press Conference, все события CAD

### После исправления (28 января):
```
Found 7 events:
1. [CAD] High | BOC Monetary Policy Report
2. [CAD] High | BOC Rate Statement
3. [CAD] High | Overnight Rate
4. [CAD] High | BOC Press Conference
5. [USD] High | Federal Funds Rate
6. [USD] High | FOMC Statement
7. [USD] High | FOMC Press Conference ✅
```

✅ Все важные события теперь отображаются!

## Миграция существующих установок

Если у вас уже работает бот с базой данных, выполните миграцию:

```bash
npx ts-node scripts/migrate-db-assets.ts
```

Это обновит список отслеживаемых валют в базе данных.

Или просто удалите `bot.db` - она пересоздастся с новыми настройками:

```bash
# Windows
del bot.db

# Linux/Mac
rm bot.db
```

## Тестирование

Проверьте, что все события отображаются:

```bash
# Тест на завтра
npx ts-node scripts/test-tomorrow.ts

# Проверка текущих настроек БД
npx ts-node scripts/check-db-assets.ts

# Debug - все события до фильтрации
npx ts-node scripts/debug-tomorrow.ts
```

## Пример вывода

```
Fetching https://www.forexfactory.com/calendar?day=tomorrow ...

Found 7 events (after filtering):

1. [CAD] High | BOC Monetary Policy Report
   Time: 9:45am (NY) → 16:45 (Kyiv)

2. [CAD] High | BOC Rate Statement
   Time: All Day

3. [CAD] High | Overnight Rate
   Forecast: 2.25%

4. [CAD] High | BOC Press Conference
   Time: 10:30am (NY) → 17:30 (Kyiv)

5. [USD] High | Federal Funds Rate
   Time: 2:00pm (NY) → 21:00 (Kyiv)
   Forecast: 3.75%

6. [USD] High | FOMC Statement
   Time: All Day

7. [USD] High | FOMC Press Conference
   Time: 2:30pm (NY) → 21:30 (Kyiv)
```

## Настройки в боте

Пользователи могут включать/выключать валюты через `/settings`:

```
⚙️ Настройки

Отслеживаемые активы: 🇺🇸 USD, 🇪🇺 EUR, 🇬🇧 GBP, 🇯🇵 JPY, 🇨🇦 CAD, 🇦🇺 AUD, 🇳🇿 NZD, 🇨🇭 CHF

[✅ 🇺🇸 USD] [✅ 🇪🇺 EUR] [✅ 🇬🇧 GBP]
[✅ 🇯🇵 JPY] [✅ 🇨🇦 CAD] [✅ 🇦🇺 AUD]
[✅ 🇳🇿 NZD] [✅ 🇨🇭 CHF] [❌ 🏆 XAU]
[❌ ₿ BTC] [❌ 🛢️ OIL]
```

## Сводка изменений

| Изменение | Файлы | Статус |
|-----------|-------|--------|
| Фильтр "Press Conference" | CalendarService.ts, MyfxbookService.ts | ✅ |
| Добавлены CAD, AUD, CHF | database.ts, bot.ts, SchedulerService.ts | ✅ |
| Флаги валют | bot.ts, SchedulerService.ts | ✅ |
| Скрипт миграции БД | scripts/migrate-db-assets.ts | ✅ |
| Тесты | scripts/test-tomorrow.ts, debug-tomorrow.ts | ✅ |

## Итог

✅ **Проблема решена**  
✅ Все важные события теперь отображаются  
✅ Добавлены CAD, AUD, CHF  
✅ Пользователи могут настраивать валюты через бота  
✅ Готово к деплою  

---

**Дата исправления**: 27 января 2026  
**Затронутые файлы**: 5  
**Новых валют добавлено**: 3 (CAD, AUD, CHF)
