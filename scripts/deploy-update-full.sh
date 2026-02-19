#!/bin/bash
# Полная синхронизация сервера с GitHub (как локально).
# Приводит код на сервере в точности к origin/main.
# Запуск: на сервере из корня проекта: bash scripts/deploy-update-full.sh
#
# Перед запуском: убедитесь что с локальной машины сделан git push.

set -e

PROJECT_DIR="${PROJECT_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
cd "$PROJECT_DIR"

echo "=== Полный деплой (синхронизация с GitHub) — $(date -Iseconds) ==="

# 1. Резервная копия
echo ""
echo "1. Резервная копия..."
bash scripts/pre-deploy-backup.sh 2>/dev/null || echo "  [SKIP] pre-deploy-backup.sh не выполнен"

# 2. Жёсткая синхронизация с origin/main (как у вас локально)
echo ""
echo "2. Git: fetch + reset --hard origin/main..."
git fetch origin
git checkout main 2>/dev/null || git checkout -b main origin/main
git reset --hard origin/main
git clean -fd -e node_modules -e .env -e bot.db -e backups 2>/dev/null || true
echo "  Текущий коммит: $(git log -1 --oneline)"

# 3. Зависимости
echo ""
echo "3. npm install..."
npm install

# 4. PM2
echo ""
echo "4. PM2 reload..."
if pm2 describe forex-bot &>/dev/null; then
  pm2 reload ecosystem.config.js --update-env
  echo "  [OK] forex-bot перезапущен"
else
  echo "  Запуск forex-bot..."
  pm2 start ecosystem.config.js
fi
pm2 save

echo ""
echo "=== Готово. Сервер синхронизирован с GitHub. ==="
echo "Проверка: pm2 logs forex-bot --lines 20"
