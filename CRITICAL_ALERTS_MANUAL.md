# Critical Data Quality Alerts - Manual Mode

## Изменения

Автоматические алерты Critical Data Quality **ОТКЛЮЧЕНЫ** (Feb 11, 2026).

### Что было изменено:

1. **CalendarService.ts** - закомментирован автоматический вызов `sendCriticalDataAlert`
2. **MyfxbookService.ts** - закомментирован автоматический вызов `sendCriticalDataAlert`

### Причина:

Автоматические алерты отправлялись слишком часто и могли создавать спам в админ-чате. Теперь алерты отправляются **только по запросу**.

---

## Как использовать алерты вручную

### 1. Ежедневный отчет о качестве данных

Используйте скрипт для генерации подробного отчета за последние 24 часа:

```bash
npx ts-node scripts/daily-quality-report.ts
```

**Что включает отчет:**
- Общее количество проблем за 24 часа
- Разбивка по типам проблем
- Разбивка по источникам (ForexFactory, Myfxbook)
- Примеры последних проблем
- Тренды (если доступны данные за предыдущий день)

**Отправка:** Автоматически отправляется в админ-чат (если настроен `ADMIN_CHAT_ID`)

---

### 2. Просмотр текущих проблем

Просмотрите все проблемы в базе данных:

```bash
npx ts-node scripts/view-data-issues.ts
```

**Возможности:**
- Фильтрация по типу проблемы
- Фильтрация по источнику
- Просмотр деталей каждой проблемы
- Экспорт в JSON

---

### 3. Ручная отправка критических алертов (если нужно)

Если необходимо вернуть автоматические алерты, раскомментируйте код в:

#### CalendarService.ts (строки ~333-343):

```typescript
// NOTE: Automatic critical data quality alerts are DISABLED
// Use manual scripts (e.g., daily-quality-report.ts) to send alerts on demand
// 
// const criticalIssues = issues.filter(i => 
//   i.type === 'MISSING_REQUIRED_FIELD' ||
//   i.type === 'TIME_INCONSISTENCY' ||
//   i.type === 'INVALID_RANGE'
// );
// if (criticalIssues.length > 0) {
//   const urlType = url.includes('tomorrow') ? 'Tomorrow' : 'Today';
//   sendCriticalDataAlert(criticalIssues, `ForexFactory Calendar (${urlType}`)
//     .catch(err => console.error('[CalendarService] Failed to send alert:', err));
// }
```

#### MyfxbookService.ts (строки ~395-405):

```typescript
// NOTE: Automatic critical data quality alerts are DISABLED
// Use manual scripts (e.g., daily-quality-report.ts) to send alerts on demand
// 
// const criticalIssues = issues.filter(i => 
//   i.type === 'MISSING_REQUIRED_FIELD' ||
//   i.type === 'TIME_INCONSISTENCY' ||
//   i.type === 'INVALID_RANGE'
// );
// if (criticalIssues.length > 0) {
//   const urlType = url.includes('tomorrow') ? 'Tomorrow' : 'Today';
//   sendCriticalDataAlert(criticalIssues, `Myfxbook Calendar (${urlType}`)
//     .catch(err => console.error('[MyfxbookService] Failed to send alert:', err));
// }
```

---

## Рекомендуемый график проверки

- **Ежедневно:** Запускать `daily-quality-report.ts` один раз в день (утром)
- **По мере необходимости:** Использовать `view-data-issues.ts` для детального анализа
- **После обновлений:** Проверять качество данных после изменений в парсерах

---

## Функция sendCriticalDataAlert все еще доступна

Функция `sendCriticalDataAlert` из `src/utils/adminAlerts.ts` остается доступной и может быть использована в скриптах или других местах по необходимости.

### Пример использования в скрипте:

```typescript
import { initializeAdminAlerts, sendCriticalDataAlert } from '../src/utils/adminAlerts';
import { Bot } from 'grammy';
import { env } from '../src/config/env';

const bot = new Bot(env.BOT_TOKEN);
initializeAdminAlerts(bot);

const criticalIssues = [...]; // ваши критические проблемы

await sendCriticalDataAlert(criticalIssues, 'Custom Check');
```

---

## Защита от спама

Функция `sendCriticalDataAlert` имеет встроенный throttling:
- **Период:** 1 час
- **Логика:** Один и тот же тип алерта не отправляется чаще раза в час

Это предотвращает спам даже если автоматические алерты включены.
