# Чек-лист перед деплоем (Фаза 1)

**Источник:** SCALING_AND_OPTIMIZATION.md §7

## 1. Резервная копия БД и конфигурации

```bash
bash scripts/pre-deploy-backup.sh
```

Сохраняет в `./backups/`:
- `bot_YYYYMMDD_HHMMSS.db` — копия БД
- `env_YYYYMMDD_HHMMSS.bak` — копия .env
- `ecosystem_YYYYMMDD_HHMMSS.config.js` — копия PM2 конфига

## 2. Проверка способа запуска

**Текущая конфигурация (ecosystem.config.js):**

| Параметр | Значение |
|----------|----------|
| script | `src/bot.ts` |
| interpreter | `node` |
| interpreter_args | `--require ts-node/register` |
| node_args | `--max-old-space-size=2048` |
| instances | 1 |

**Запуск в production:**
```bash
pm2 start ecosystem.config.js
# или
pm2 reload ecosystem.config.js
```

**Переменные окружения (.env):**
- `BOT_TOKEN` — обязательно
- `GROQ_API_KEY` — обязательно
- `ADMIN_CHAT_ID` — опционально

Проверить наличие: `cat .env | grep -E '^BOT_TOKEN|^GROQ_API_KEY'` (значения не показывать).

## 3. Зафиксировать метрики PM2

```bash
bash scripts/pre-deploy-metrics.sh
```

Сохраняет в `./backups/pm2_metrics_before_*.txt`:
- `pm2 list` — статус процессов
- `pm2 show forex-bot` — heap, restarts, uptime, memory

**Ключевые метрики для сравнения после деплоя:**
- Heap usage (%)
- Restarts (количество)
- Uptime

## 4. Логирование ошибок

Ошибки логируются в:
- `bot.catch()` — ошибки Grammy (console.error)
- `process.on('uncaughtException')` — необработанные исключения
- `process.on('unhandledRejection')` — необработанные промисы

При сокращении логов (MyfxbookService, DataQualityService) критические ошибки по-прежнему выводятся через `console.error`.

---

## Быстрый запуск всех пунктов

```bash
cd /path/to/forex-news-bot
bash scripts/pre-deploy-backup.sh
bash scripts/pre-deploy-metrics.sh
echo "Чек-лист выполнен. Метрики и бэкапы в ./backups/"
```
