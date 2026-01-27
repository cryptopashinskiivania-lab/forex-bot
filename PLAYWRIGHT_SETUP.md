# Playwright Setup Instructions

## Локальная разработка

### 1. Установка зависимостей

```bash
npm install
```

### 2. Установка браузеров Playwright

```bash
npx playwright install chromium
```

### 3. Установка системных зависимостей (Linux/Docker)

Если вы на Linux или используете Docker, нужно установить системные зависимости для Chromium:

```bash
npx playwright install-deps chromium
```

## Docker Deployment

### Вариант 1: Использование официального образа Playwright

Измените ваш `Dockerfile`:

```dockerfile
# Используем официальный образ с предустановленным Playwright
FROM mcr.microsoft.com/playwright:v1.49.0-jammy

WORKDIR /app

# Копируем package.json и устанавливаем зависимости
COPY package*.json ./
RUN npm ci --only=production

# Копируем остальные файлы
COPY . .

# Собираем TypeScript
RUN npm run build

# Запускаем приложение
CMD ["node", "dist/bot.js"]
```

### Вариант 2: Установка Playwright в существующий образ

Если у вас уже есть Dockerfile на базе Node.js:

```dockerfile
FROM node:18-slim

WORKDIR /app

# Установка системных зависимостей для Playwright
RUN apt-get update && apt-get install -y \
    libnss3 \
    libnspr4 \
    libdbus-1-3 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    libpango-1.0-0 \
    libcairo2 \
    && rm -rf /var/lib/apt/lists/*

# Копируем package.json
COPY package*.json ./
RUN npm ci --only=production

# Устанавливаем браузеры Playwright
RUN npx playwright install chromium

# Копируем остальные файлы
COPY . .

# Собираем TypeScript
RUN npm run build

CMD ["node", "dist/bot.js"]
```

## VPS/Server Setup (без Docker)

Если деплоите напрямую на сервер:

```bash
# 1. Установка Node.js зависимостей
npm ci --only=production

# 2. Установка браузеров Playwright
npx playwright install chromium

# 3. Установка системных зависимостей (Ubuntu/Debian)
npx playwright install-deps chromium

# 4. Сборка проекта
npm run build

# 5. Запуск
npm start
```

## Проверка установки

После установки можете протестировать парсинг:

```bash
# Для TypeScript
npx ts-node scripts/test-calendar-scrape.ts

# Для скомпилированного кода
node dist/scripts/test-calendar-scrape.js
```

## Troubleshooting

### Ошибка "Executable doesn't exist"

```bash
npx playwright install chromium
```

### Ошибка "libnss3.so: cannot open shared object file"

```bash
npx playwright install-deps chromium
```

### Cloudflare все еще блокирует

1. Убедитесь, что используете актуальный User-Agent
2. Попробуйте добавить больше задержек (`page.waitForTimeout`)
3. Проверьте, что браузер запускается в headless режиме
4. Рассмотрите использование прокси-серверов

## Оптимизация

### Повторное использование браузера

В текущей реализации браузер переиспользуется между запросами (`getBrowser()` метод). 
Это экономит время и ресурсы.

### Закрытие браузера при остановке бота

Добавьте в ваш `bot.ts`:

```typescript
import { CalendarService } from './services/CalendarService';

const calendarService = new CalendarService();

// При остановке бота
process.on('SIGINT', async () => {
  console.log('Shutting down...');
  await calendarService.close();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('Shutting down...');
  await calendarService.close();
  process.exit(0);
});
```

## Размер Docker образа

Официальный образ Playwright достаточно большой (~1.5GB). Для продакшена рекомендуется:

1. Использовать multi-stage build
2. Установить только chromium, а не все браузеры
3. Использовать alpine-based образы где возможно

Пример оптимизированного Dockerfile:

```dockerfile
# Build stage
FROM node:18-slim AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# Production stage
FROM mcr.microsoft.com/playwright:v1.49.0-jammy
WORKDIR /app

# Копируем только production зависимости
COPY package*.json ./
RUN npm ci --only=production

# Копируем собранный код
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/src/db ./src/db

CMD ["node", "dist/bot.js"]
```
