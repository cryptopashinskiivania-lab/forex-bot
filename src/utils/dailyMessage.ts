import { parseISO, format } from 'date-fns';
import { toZonedTime } from 'date-fns-tz';
import { InlineKeyboard } from 'grammy';
import { CalendarEvent } from '../types/calendar';
import { stripRedundantCountryPrefix } from './eventTitleFormat';

const ASSET_FLAGS: Record<string, string> = {
  USD: '🇺🇸',
  EUR: '🇪🇺',
  GBP: '🇬🇧',
  JPY: '🇯🇵',
  NZD: '🇳🇿',
  CAD: '🇨🇦',
  AUD: '🇦🇺',
  CHF: '🇨🇭',
  XAU: '🏆',
  BTC: '₿',
  OIL: '🛢️',
};

function formatTime24(event: CalendarEvent, timezone: string): string {
  if (event.timeISO) {
    try {
      const eventTime = parseISO(event.timeISO);
      const localTime = toZonedTime(eventTime, timezone);
      return format(localTime, 'HH:mm');
    } catch {
      // fall through
    }
  }
  const timeStr = event.time.trim();
  if (/^\d{1,2}:\d{2}$/.test(timeStr)) {
    const [hours, minutes] = timeStr.split(':');
    return `${hours.padStart(2, '0')}:${minutes}`;
  }
  const amPmMatch = timeStr.match(/(\d{1,2}):(\d{2})\s*(AM|PM|am|pm)/i);
  if (amPmMatch) {
    let hours = parseInt(amPmMatch[1], 10);
    const minutes = amPmMatch[2];
    const ampm = amPmMatch[3].toUpperCase();
    if (ampm === 'PM' && hours !== 12) hours += 12;
    else if (ampm === 'AM' && hours === 12) hours = 0;
    return `${hours.toString().padStart(2, '0')}:${minutes}`;
  }
  return timeStr;
}

export interface BuildDailyResult {
  text: string;
  empty: boolean;
}

/**
 * Строит текст сводки за сегодня в том же формате, что и команда /daily.
 * Используется и в /daily, и при автоматической отправке в 08:00.
 */
export function buildDailyMessage(
  events: CalendarEvent[],
  userTz: string,
  monitoredAssets: string[]
): BuildDailyResult {
  if (events.length === 0) {
    const assetsText =
      monitoredAssets.length > 0
        ? monitoredAssets.map((a) => `${ASSET_FLAGS[a] || ''} ${a}`).join(', ')
        : 'Нет активов';
    return {
      text: `📅 Сегодня нет событий для ваших активов (${assetsText}).\n\nИзмените активы через /settings`,
      empty: true,
    };
  }

  const forexFactoryEvents = events.filter((e) => e.source === 'ForexFactory');
  const myfxbookEvents = events.filter((e) => e.source === 'Myfxbook');

  let eventsText = '📅 События за сегодня:\n\n';
  let eventNumber = 0;

  if (forexFactoryEvents.length > 0) {
    eventsText += '━━━ 📰 ForexFactory ━━━\n\n';
    const ffLines = forexFactoryEvents.map((e) => {
      eventNumber++;
      const impactEmoji = e.impact === 'High' ? '🔴' : '🟠';
      const time24 = formatTime24(e, userTz);
      const title = stripRedundantCountryPrefix(e.currency, e.title);
      return `${eventNumber}. ${impactEmoji} [${e.currency}] ${title}\n   🕐 ${time24}`;
    });
    eventsText += ffLines.join('\n\n') + '\n\n';
  }

  if (myfxbookEvents.length > 0) {
    eventsText += '━━━ 📊 Myfxbook ━━━\n\n';
    const mbLines = myfxbookEvents.map((e) => {
      eventNumber++;
      const impactEmoji = e.impact === 'High' ? '🔴' : '🟠';
      const time24 = formatTime24(e, userTz);
      const title = stripRedundantCountryPrefix(e.currency, e.title);
      return `${eventNumber}. ${impactEmoji} [${e.currency}] ${title}\n   🕐 ${time24}`;
    });
    eventsText += mbLines.join('\n\n');
  }

  return { text: eventsText, empty: false };
}

/** Клавиатура для сводки (AI Forecast / AI Results), как у /daily */
export function buildDailyKeyboard(): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  keyboard.row(
    { text: '🔮 AI Forecast', callback_data: 'daily_ai_forecast' },
    { text: '📊 AI Results', callback_data: 'daily_ai_results' }
  );
  return keyboard;
}
