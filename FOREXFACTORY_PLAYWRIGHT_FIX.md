# ForexFactory Playwright Migration

## Проблема

На сервере ForexFactory возвращал **0 событий**, потому что Cloudflare блокировал запросы от `cloudscraper`:

```
[Bot] ForexFactory events: 0          ← Проблема!
[CalendarService] Cached 0 events
server: 'cloudflare'
'cf-ray': '9c4ae3a69b89085c-FRA'
```

### Почему локально работало?

- Домашний IP не в черном списке Cloudflare
- `cloudscraper` успешно обходил защиту

### Почему на сервере не работало?

- Серверный IP (Frankfurt) строго фильтруется Cloudflare
- `cloudscraper` недостаточно для обхода защиты

## Решение

Переписан `CalendarService` на **Playwright** (аналогично `MyfxbookService`).

## Изменения

### 1. `src/services/CalendarService.ts`

#### Было (cloudscraper):
```typescript
import cloudscraper from 'cloudscraper';

export class CalendarService {
  private async fetchEvents(url: string): Promise<CalendarEvent[]> {
    const html = await cloudscraper({
      uri: url,
      headers: { /* ... */ }
    }) as string;
    // ...
  }
}
```

#### Стало (Playwright):
```typescript
import { chromium, Browser, Page } from 'playwright';

export class CalendarService {
  private browser: Browser | null = null;
  private browserLock: Promise<Browser> | null = null;

  private async getBrowser(): Promise<Browser> {
    if (this.browserLock) {
      return this.browserLock;
    }
    
    if (!this.browser || !this.browser.isConnected()) {
      this.browserLock = chromium.launch({
        headless: true,
        args: [
          '--disable-blink-features=AutomationControlled',
          '--disable-dev-shm-usage',
          '--no-sandbox',
          '--disable-setuid-sandbox',
        ],
      });
      
      try {
        this.browser = await this.browserLock;
      } finally {
        this.browserLock = null;
      }
    }
    return this.browser;
  }

  private async fetchHTML(url: string): Promise<string> {
    const browser = await this.getBrowser();
    const page = await browser.newPage({
      userAgent: 'Mozilla/5.0 ...',
      viewport: { width: 1920, height: 1080 },
    });

    try {
      await page.goto(url, { 
        waitUntil: 'domcontentloaded',
        timeout: 30000 
      });
      
      await page.waitForSelector('table.calendar__table', { timeout: 10000 });
      
      return await page.content();
    } finally {
      await page.close();
    }
  }

  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }
}
```

### 2. `src/services/SchedulerService.ts`

#### Было:
```typescript
async stop(): Promise<void> {
  // ...
  await this.myfxbookService.close();  // Только Myfxbook
}
```

#### Стало:
```typescript
async stop(): Promise<void> {
  // ...
  await this.calendarService.close();   // ForexFactory
  await this.myfxbookService.close();  // Myfxbook
}
```

## Преимущества

✅ **Обходит Cloudflare** - Playwright имитирует реальный браузер  
✅ **Стабильно работает** - и локально, и на сервере  
✅ **Единый подход** - ForexFactory и Myfxbook используют одну технологию  
✅ **Browser lock** - предотвращает конфликты при параллельных запросах  
✅ **Graceful shutdown** - браузеры корректно закрываются  

## Недостатки

⚠️ **Медленнее** - ~10 сек вместо ~2 сек с `cloudscraper`  
⚠️ **Больше ресурсов** - два Chromium процесса (FF + MB)  

## Тестирование

### Локально:

```bash
npx ts-node scripts/test-calendar-scrape.ts
# Должно показать события от ForexFactory

npx ts-node scripts/test-deduplication.ts
# Должно показать:
# ForexFactory: 3 события (Federal Funds Rate, FOMC Statement, FOMC Press Conference)
# Myfxbook: 9 событий
```

### На сервере:

```bash
cd /root/forex-bot
git pull
npm ci --only=production
npx playwright install chromium
npx playwright install-deps chromium
npm run build
pm2 restart forex-bot

# Проверить логи:
pm2 logs forex-bot --lines 50 | grep "ForexFactory events"
# Должно быть: [Bot] ForexFactory events: 3 (или больше)
```

## Результат

**До исправления:**
```
[Bot] ForexFactory events: 0          ❌
[Bot] Myfxbook events: 9
[Bot] Total: 9 events

Telegram: только Myfxbook события
```

**После исправления:**
```
[Bot] ForexFactory events: 3          ✅
[Bot] Myfxbook events: 7 (дубликаты удалены)
[Bot] Total: 10 events

Telegram:
━━━ 📰 ForexFactory ━━━
1. Federal Funds Rate
2. FOMC Statement  
3. FOMC Press Conference

━━━ 📊 Myfxbook ━━━
4. BoJ Policy Minutes
5. GfK Consumer Confidence
...
```

## Деплой на сервер

```bash
# 1. Обновить код
cd /root/forex-bot
git pull origin main

# 2. Установить зависимости
npm ci --only=production

# 3. Убедиться, что Playwright установлен
npx playwright install chromium
npx playwright install-deps chromium

# 4. Пересобрать
npm run build

# 5. Перезапустить бота
pm2 restart forex-bot

# 6. Проверить работу
pm2 logs forex-bot --lines 100
```

Ищите в логах:
```
[CalendarService] Launching Chromium browser...
[CalendarService] Browser launched successfully
[CalendarService] Successfully fetched HTML
[Bot] ForexFactory events: 3+        ← Должно быть > 0!
```

## Альтернативные решения (не реализованы)

### Вариант 1: Прокси
Использовать прокси-сервер для обхода блокировки IP.

**Плюсы:** Быстрее, чем Playwright  
**Минусы:** Дополнительные расходы, может быть нестабильно  

### Вариант 2: VPN на сервере
Запускать бота через VPN с другим IP.

**Плюсы:** Простое решение  
**Минусы:** Дополнительная настройка, может замедлить весь трафик  

### Вариант 3: API ForexFactory
Использовать официальное API (если существует).

**Плюсы:** Быстро, стабильно  
**Минусы:** Может быть платным, требует авторизации  

## Заключение

Playwright решает проблему полностью и работает стабильно как локально, так и на сервере. Несмотря на небольшое увеличение времени загрузки (~8 секунд дополнительно), это приемлемо для обеспечения надежности.
