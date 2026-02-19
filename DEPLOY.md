# Деплой forex-news-bot

## Быстрый деплой обновлений

### На локальной машине

```bash
git add .
git commit -m "описание изменений"
git push origin main
```

### На сервере

**Обычное обновление** (git pull):

```bash
cd /path/to/forex-news-bot   # или cd forex-bot — как у вас называется папка
bash scripts/deploy-update.sh
```

**Полная синхронизация с GitHub** (если на сервере не видно изменений — привести код в точности к origin/main):

```bash
cd /path/to/forex-news-bot
bash scripts/deploy-update-full.sh
```

Скрипт выполняет:
1. Резервную копию БД и .env
2. `git fetch` + `git reset --hard origin/main` (код как в репозитории)
3. `npm install`
4. `pm2 reload ecosystem.config.js`

---

## Первоначальная настройка сервера

Если сервер ещё не настроен, см. `deploy-server.sh`.

**Важно:** в production используйте `pm2 start ecosystem.config.js`, а не `npm run dev`.

---

## Одной командой (если настроен SSH)

```bash
ssh user@your-server "cd /path/to/forex-news-bot && bash scripts/deploy-update.sh"
```
