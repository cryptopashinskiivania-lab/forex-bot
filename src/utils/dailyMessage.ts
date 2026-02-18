import { parseISO, format } from 'date-fns';
import { toZonedTime } from 'date-fns-tz';
import { InlineKeyboard } from 'grammy';
import { CalendarEvent } from '../types/calendar';
import { stripRedundantCountryPrefix } from './eventTitleFormat';
import { groupEvents, type EventGroup, getEventThemeByTitle } from './eventGrouping';

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

/** Иконки тем для саммари группы событий */
const THEME_ICONS: Record<string, string> = {
  labor: '💼',
  trade: '🚢',
  inflation: '📈',
  housing: '🏠',
  pmi: '🏭',
  other: '📊',
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

/**
 * Формирует краткий саммари группы: по темам первые 3 заголовка (до 30 символов) с иконками.
 */
function formatGroupSummary(group: EventGroup): string {
  const byTheme = new Map<string, CalendarEvent[]>();
  for (const e of group.events) {
    const theme = getEventThemeByTitle(e.title);
    const list = byTheme.get(theme) ?? [];
    list.push(e);
    byTheme.set(theme, list);
  }
  const parts: string[] = [];
  const order = ['labor', 'trade', 'inflation', 'housing', 'pmi', 'other'];
  const seen = new Set(order);
  for (const theme of order) {
    const list = byTheme.get(theme);
    if (!list?.length) continue;
    const icon = THEME_ICONS[theme] ?? THEME_ICONS.other;
    const titles = list
      .slice(0, 3)
      .map((e) => (e.title.length > 30 ? e.title.slice(0, 27) + '...' : e.title));
    parts.push(`${icon} ${titles.join(', ')}`);
  }
  for (const [theme] of byTheme) {
    if (seen.has(theme)) continue;
    const list = byTheme.get(theme)!;
    const icon = THEME_ICONS[theme] ?? THEME_ICONS.other;
    const titles = list
      .slice(0, 3)
      .map((e) => (e.title.length > 30 ? e.title.slice(0, 27) + '...' : e.title));
    parts.push(`${icon} ${titles.join(', ')}`);
  }
  return parts.join(' | ');
}

export interface BuildDailyResult {
  text: string;
  empty: boolean;
  grouped: Array<EventGroup | CalendarEvent>;
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
      grouped: [],
    };
  }

  const forexFactoryEvents = events.filter((e) => e.source === 'ForexFactory');
  const myfxbookEvents = events.filter((e) => e.source === 'Myfxbook');
  const groupedFF = groupEvents(forexFactoryEvents);
  const groupedMB = groupEvents(myfxbookEvents);

  let eventsText = '📅 События за сегодня:\n\n';
  let eventNumber = 0;

  function formatItem(
    item: EventGroup | CalendarEvent,
    userTz: string
  ): string {
    eventNumber++;
    if ('events' in item) {
      const group = item as EventGroup;
      const impactIcon = group.impact === 'High' ? '🔴' : '🟠';
      const time24 = formatTime24(group.events[0], userTz);
      const summary = formatGroupSummary(group);
      return `${eventNumber}. ${impactIcon} ${time24} — ${group.title} (${group.events.length} events)\n   ${summary}`;
    }
    const e = item as CalendarEvent;
    const impactEmoji = e.impact === 'High' ? '🔴' : '🟠';
    const time24 = formatTime24(e, userTz);
    const title = stripRedundantCountryPrefix(e.currency, e.title);
    return `${eventNumber}. ${impactEmoji} [${e.currency}] ${title}\n   🕐 ${time24}`;
  }

  if (groupedFF.length > 0) {
    eventsText += '━━━ 📰 ForexFactory ━━━\n\n';
    const ffLines = groupedFF.map((item) => formatItem(item, userTz));
    eventsText += ffLines.join('\n\n') + '\n\n';
  }

  if (groupedMB.length > 0) {
    eventsText += '━━━ 📊 Myfxbook ━━━\n\n';
    const mbLines = groupedMB.map((item) => formatItem(item, userTz));
    eventsText += mbLines.join('\n\n');
  }

  const grouped = [...groupedFF, ...groupedMB];
  return { text: eventsText, empty: false, grouped };
}

const MAX_CALLBACK_DATA_BYTES = 64;

/** Строит клавиатуру для /daily: кнопки групп + AI Forecast при наличии групп с результатами */
export function buildDailyKeyboard(
  grouped: Array<EventGroup | CalendarEvent>
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  const groups = grouped.filter((g): g is EventGroup => 'events' in g);
  for (const g of groups) {
    const label = `📋 View: ${g.title.length > 35 ? g.title.slice(0, 32) + '...' : g.title}`;
    const data = `group_details_${g.groupId}`;
    if (data.length <= MAX_CALLBACK_DATA_BYTES) {
      keyboard.row({ text: label, callback_data: data });
    }
  }
  const hasAnyResults = groups.some((g) => g.hasResults);
  if (hasAnyResults) {
    keyboard.row({ text: '🧠 AI Forecast', callback_data: 'daily_ai_forecast' });
  }
  keyboard.row({ text: '📊 AI Results', callback_data: 'daily_ai_results' });
  return keyboard;
}
