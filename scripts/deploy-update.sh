#!/bin/bash
# Деплой обновлений forex-bot на сервер.
# Запуск: на сервере из корня проекта: bash scripts/deploy-update.sh
#
# Предварительно: git push с локальной машины.

set -e

PROJECT_DIR="${PROJECT_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
cd "$PROJECT_DIR"

echo "=== Деплой forex-bot ($(date -Iseconds)) ==="

# 1. Резервная копия перед обновлением
echo ""
echo "1. Резервная копия..."
bash scripts/pre-deploy-backup.sh 2>/dev/null || echo "  [SKIP] pre-deploy-backup.sh не выполнен"

# 2. Получить обновления
echo ""
echo "2. Git pull..."
git pull origin main || git pull origin master || git pull

# 3. Установить зависимости (если изменились)
echo ""
echo "3. npm install..."
npm install

# 4. Перезапуск PM2
echo ""
echo "4. PM2 reload..."
if pm2 describe forex-bot &>/dev/null; then
  pm2 reload ecosystem.config.js --update-env
  echo "  [OK] forex-bot перезапущен"
else
  echo "  Запуск forex-bot (первый раз)..."
  pm2 start ecosystem.config.js
fi

pm2 save

echo ""
echo "=== Деплой завершён ==="
echo "Проверка: pm2 logs forex-bot --lines 20"
