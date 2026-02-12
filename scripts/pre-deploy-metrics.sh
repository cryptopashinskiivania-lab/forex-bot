#!/bin/bash
# Захват метрик PM2 перед деплоем для сравнения после.
# Запуск: на сервере: bash scripts/pre-deploy-metrics.sh

OUTPUT_FILE="${1:-./backups/pm2_metrics_before_$(date +%Y%m%d_%H%M%S).txt}"
mkdir -p "$(dirname "$OUTPUT_FILE")"

echo "=== Сохранение метрик PM2 в $OUTPUT_FILE ==="

{
  echo "=== PM2 метрики перед деплоем ==="
  echo "Дата: $(date -Iseconds)"
  echo ""
  echo "--- pm2 list ---"
  pm2 list 2>/dev/null || true
  echo ""
  echo "--- pm2 show forex-bot ---"
  pm2 show forex-bot 2>/dev/null || true
  echo ""
  echo "--- pm2 monit (однократный снимок) ---"
  pm2 jlist 2>/dev/null | head -500 || true
} > "$OUTPUT_FILE"

echo "Метрики сохранены: $OUTPUT_FILE"
echo "Для сравнения после деплоя: heap, restarts, uptime, memory"
