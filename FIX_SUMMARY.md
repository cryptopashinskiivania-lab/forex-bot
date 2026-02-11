# ✅ Исправление: Новости из разных источников больше не объединяются

## Что было исправлено

**Проблема:** Если новость существовала и в ForexFactory, и в Myfxbook, показывалась только одна из них.

**Решение:** Теперь каждый источник отображает свои новости независимо.

## Примеры

### До исправления ❌
```
Новость "Non-Farm Payrolls" в 14:00:
- ForexFactory: NFP (High, forecast: 180K)
- Myfxbook: NFP (High, forecast: 180K)

Результат: Показывалась только ОДНА новость (та, которая имела приоритет)
```

### После исправления ✅
```
Новость "Non-Farm Payrolls" в 14:00:
- ForexFactory: NFP (High, forecast: 180K) → ПОКАЗЫВАЕТСЯ
- Myfxbook: NFP (High, forecast: 180K) → ПОКАЗЫВАЕТСЯ

Результат: Показываются ОБЕ новости, каждая со своим источником
```

## Что изменилось в коде

**Файл:** `src/utils/eventAggregation.ts`

**Функция `deduplicationKey`:**
```typescript
// Было:
return md5(`${timeKey}_${event.currency}`);

// Стало:
return md5(`${event.source}_${timeKey}_${event.currency}`);
```

Теперь ключ дедупликации включает **источник**, поэтому события из разных источников никогда не считаются дубликатами.

## Проверка

**Запустить тест:**
```bash
npx tsx scripts/test-no-cross-source-dedup.ts
```

**Результат:**
```
✅ PASS: Both events are shown (no cross-source deduplication)
✅ PASS: Duplicate within same source was removed
✅ PASS: One event per source (duplicate within FF removed, both sources shown)
✅ PASS: All different events are shown
```

## Поведение для пользователей

### Настройка "Both" (оба источника)
- ✅ Видны ВСЕ новости из ForexFactory
- ✅ Видны ВСЕ новости из Myfxbook
- ℹ️ Если новость есть в обоих источниках → она показывается дважды

### Настройка "ForexFactory"
- ✅ Видны только новости ForexFactory
- ✅ Новости Myfxbook не загружаются вообще

### Настройка "Myfxbook"
- ✅ Видны только новости Myfxbook
- ✅ Новости ForexFactory не загружаются вообще

## Документация

- **Подробное описание:** `CROSS_SOURCE_FIX_2026-02-11.md`
- **Тестовый скрипт:** `scripts/test-no-cross-source-dedup.ts`
- **Changelog:** `CHANGELOG_2026-02-11.md`

## Совместимость

- ✅ Обратно совместимо
- ✅ Не требует изменений в БД
- ✅ Не влияет на настройки пользователей
- ✅ Можно развернуть немедленно
