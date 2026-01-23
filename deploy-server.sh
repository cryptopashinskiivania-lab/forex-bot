#!/bin/bash
# Деплой forex-bot на сервер (Ubuntu/Debian)
# Запуск: ssh root@161.97.89.186, затем bash deploy-server.sh

set -e

echo "=== 1. Обновляем систему и ставим Node.js 20 ==="
apt update && apt upgrade -y
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
apt install -y nodejs git

echo "=== 2. Ставим PM2, TypeScript, ts-node ==="
npm install -g pm2 typescript ts-node

echo "=== 3. Клонируем бот ==="
if [ -d "forex-bot" ]; then
  echo "Папка forex-bot уже есть. Пропускаем clone. (удали её вручную, если нужен свежий clone)"
else
  git clone https://github.com/cryptopashinskiivania-lab/forex-bot.git
fi
cd forex-bot

echo "=== 4. Устанавливаем зависимости ==="
npm install

echo "=== 5. Файл .env ==="
if [ ! -f ".env" ]; then
  touch .env
  echo "Создан пустой .env"
fi
echo ""
echo "Готово! Теперь отредактируй .env:"
echo "  nano .env"
echo ""
echo "Добавь в .env (значения скопируй из локального .env):"
echo "  BOT_TOKEN=..."
echo "  GEMINI_API_KEY=..."
echo "  GROQ_API_KEY=..."
echo "  ADMIN_CHAT_ID=..."
echo ""
echo "После заполнения .env запусти бота через PM2:"
echo "  pm2 start \"npm run dev\" --name forex-bot"
echo "  pm2 save"
echo "  pm2 startup"
echo ""
echo "Проверь статус: pm2 status"
echo "Логи: pm2 logs forex-bot"
