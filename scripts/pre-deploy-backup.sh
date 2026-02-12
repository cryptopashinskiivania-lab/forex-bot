#!/bin/bash
# Резервная копия БД и конфигурации перед деплоем.
# Запуск: на сервере из корня проекта: bash scripts/pre-deploy-backup.sh

set -e

BACKUP_DIR="${BACKUP_DIR:-./backups}"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
mkdir -p "$BACKUP_DIR"

echo "=== Резервная копия перед деплоем ($TIMESTAMP) ==="

# 1. БД
if [ -f "bot.db" ]; then
  cp bot.db "$BACKUP_DIR/bot_${TIMESTAMP}.db"
  echo "  [OK] bot.db -> $BACKUP_DIR/bot_${TIMESTAMP}.db"
else
  echo "  [SKIP] bot.db не найден"
fi

# 2. .env (без вывода содержимого)
if [ -f ".env" ]; then
  cp .env "$BACKUP_DIR/env_${TIMESTAMP}.bak"
  echo "  [OK] .env -> $BACKUP_DIR/env_${TIMESTAMP}.bak"
else
  echo "  [SKIP] .env не найден"
fi

# 3. ecosystem.config.js
if [ -f "ecosystem.config.js" ]; then
  cp ecosystem.config.js "$BACKUP_DIR/ecosystem_${TIMESTAMP}.config.js"
  echo "  [OK] ecosystem.config.js -> $BACKUP_DIR/ecosystem_${TIMESTAMP}.config.js"
fi

echo ""
echo "Резервные копии сохранены в $BACKUP_DIR"
