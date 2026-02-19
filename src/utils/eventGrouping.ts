import dayjs from 'dayjs';
import { CalendarEvent } from '../types/calendar';
import { isPlaceholderActual, isTentativeTime } from './calendarValue';

/**
 * Группа связанных событий календаря (одна валюта, одно время ±5 мин).
 */
export interface EventGroup {
  groupId: string;
  time: string;
  currency: string;
  title: string;
  impact: 'High' | 'Medium' | 'Low';
  events: CalendarEvent[];
  hasResults: boolean;
  theme: string;
}

/** Паттерны для определения тематики группы по заголовкам событий */
export const GROUP_PATTERNS: Record<string, RegExp> = {
  labor: /Jobless|Employment|Unemployment|Claims|NFP|Payrolls/i,
  trade: /Trade|Import|Export|Balance/i,
  inflation: /Inflation|CPI|PPI|Price/i,
  gdp: /GDP|Growth|Output/i,
  pmi: /PMI|Manufacturing|Services|Composite/i,
  housing: /Housing|Home Sales|Building Permits|Starts/i,
  speech: /Speech|Statement|Conference|Minutes/i,
  rate: /Rate Decision|Interest Rate|Policy Rate/i,
  inventory: /Inventor/i,
};

/** Эмодзи флагов по коду валюты */
export const CURRENCY_FLAGS: Record<string, string> = {
  USD: '🇺🇸',
  EUR: '🇪🇺',
  GBP: '🇬🇧',
  JPY: '🇯🇵',
  AUD: '🇦🇺',
  NZD: '🇳🇿',
  CAD: '🇨🇦',
  CHF: '🇨🇭',
};

/** Название страны/региона по коду валюты */
export const CURRENCY_TO_COUNTRY: Record<string, string> = {
  USD: 'US',
  EUR: 'Euro Area',
  GBP: 'UK',
  JPY: 'Japan',
  AUD: 'Australia',
  NZD: 'New Zealand',
  CAD: 'Canada',
  CHF: 'Switzerland',
};

/**
 * Определяет тематику группы по заголовкам событий.
 * Возвращает тему с максимальным числом совпадений паттернов, если она покрывает ≥50% событий, иначе 'mixed'.
 */
export function detectGroupTheme(events: CalendarEvent[]): string {
  if (events.length === 0) return 'mixed';
  const counts: Record<string, number> = {};
  for (const key of Object.keys(GROUP_PATTERNS)) {
    counts[key] = 0;
  }
  for (const e of events) {
    const title = e.title || '';
    for (const [theme, re] of Object.entries(GROUP_PATTERNS)) {
      if (re.test(title)) {
        counts[theme] = (counts[theme] ?? 0) + 1;
      }
    }
  }
  let bestTheme = 'mixed';
  let bestCount = 0;
  for (const [theme, count] of Object.entries(counts)) {
    if (count > bestCount) {
      bestCount = count;
      bestTheme = theme;
    }
  }
  const threshold = events.length * 0.5;
  return bestCount >= threshold ? bestTheme : 'mixed';
}

/**
 * Определяет тему одного события по заголовку (первое совпадение с GROUP_PATTERNS).
 * Для построения саммари по темам внутри группы.
 */
export function getEventThemeByTitle(title: string): string {
  const t = title || '';
  for (const [theme] of Object.entries(GROUP_PATTERNS)) {
    if (GROUP_PATTERNS[theme].test(t)) return theme;
  }
  return 'other';
}

/**
 * Returns true if the event has actual or forecast data (not placeholders).
 */
function eventHasData(e: CalendarEvent): boolean {
  const hasActual = !isPlaceholderActual(e.actual);
  const hasForecast =
    (e.forecast ?? '').trim() !== '' &&
    (e.forecast ?? '').trim() !== '—' &&
    (e.forecast ?? '').trim() !== '-';
  return hasActual || hasForecast;
}

/**
 * Impact order for sorting: High first, then Medium, then Low.
 */
const IMPACT_ORDER: Record<string, number> = {
  High: 3,
  Medium: 2,
  Low: 1,
};

/**
 * Picks the most important event in the group: High impact first,
 * then events with actual/forecast data, then chronological order.
 */
export function getMostImportantEvent(events: CalendarEvent[]): CalendarEvent {
  if (events.length === 0) throw new Error('getMostImportantEvent requires at least one event');
  const sorted = [...events].sort((a, b) => {
    const impactA = IMPACT_ORDER[a.impact] ?? 0;
    const impactB = IMPACT_ORDER[b.impact] ?? 0;
    if (impactB !== impactA) return impactB - impactA;
    const dataA = eventHasData(a) ? 1 : 0;
    const dataB = eventHasData(b) ? 1 : 0;
    if (dataB !== dataA) return dataB - dataA;
    const ta = getEventTimeMs(a);
    const tb = getEventTimeMs(b);
    return ta - tb;
  });
  return sorted[0];
}

/**
 * Forms the group title from the most important event in the group.
 */
export function generateGroupTitle(events: CalendarEvent[], currency: string): string {
  const flag = CURRENCY_FLAGS[currency] ?? '';
  const mainEvent = getMostImportantEvent(events);
  return `${flag} ${mainEvent.title}`;
}

/** Минимальное количество событий для образования группы */
const MIN_GROUP_SIZE = 3;
/** Окно времени (мс) для объединения событий в одну группу */
const TIME_THRESHOLD_MS = 5 * 60 * 1000;

/**
 * Возвращает timestamp в ms для сортировки и сравнения. Если timeISO нет — возвращает 0.
 */
function getEventTimeMs(event: CalendarEvent): number {
  if (event.timeISO) {
    const t = dayjs(event.timeISO);
    return t.isValid() ? t.valueOf() : 0;
  }
  return 0;
}

/**
 * Группирует события по валюте и времени (±5 мин).
 * События с одной валютой и временем в одном окне и в количестве ≥ MIN_GROUP_SIZE объединяются в EventGroup.
 * Остальные возвращаются как отдельные CalendarEvent.
 */
export function groupEvents(
  events: CalendarEvent[]
): Array<EventGroup | CalendarEvent> {
  if (events.length === 0) return [];

  const sorted = [...events].sort((a, b) => {
    const ta = getEventTimeMs(a);
    const tb = getEventTimeMs(b);
    if (ta !== tb) return ta - tb;
    return (a.title || '').localeCompare(b.title || '');
  });

  const used = new Set<number>();
  const result: Array<EventGroup | CalendarEvent> = [];

  for (let i = 0; i < sorted.length; i++) {
    if (used.has(i)) continue;
    const base = sorted[i];
    const baseMs = getEventTimeMs(base);
    if (baseMs === 0 || isTentativeTime(base.time)) {
      result.push(base);
      continue;
    }
    const candidates: number[] = [];
    for (let j = 0; j < sorted.length; j++) {
      if (used.has(j)) continue;
      const other = sorted[j];
      if (other.currency !== base.currency) continue;
      const otherMs = getEventTimeMs(other);
      if (otherMs === 0 || isTentativeTime(other.time)) continue;
      if (Math.abs(otherMs - baseMs) <= TIME_THRESHOLD_MS) {
        candidates.push(j);
      }
    }
    if (candidates.length >= MIN_GROUP_SIZE) {
      const groupEventsList = candidates.map((idx) => sorted[idx]);
      candidates.forEach((idx) => used.add(idx));
      const theme = detectGroupTheme(groupEventsList);
      const title = generateGroupTitle(groupEventsList, base.currency);
      const timeStr =
        base.time && /^\d{1,2}:\d{2}/.test(base.time.trim())
          ? base.time.trim().replace(/^(\d{1,2}):(\d{2}).*/, (_, h, m) =>
              `${h.padStart(2, '0')}:${m}`
            )
          : base.timeISO
            ? dayjs(base.timeISO).format('HH:mm')
            : '--:--';
      const groupId = `${base.currency}_${timeStr.replace(':', '')}`;
      const impacts = groupEventsList.map((e) => e.impact);
      const impact: 'High' | 'Medium' | 'Low' =
        impacts.some((x) => x === 'High') ? 'High' : impacts.some((x) => x === 'Medium') ? 'Medium' : 'Low';
      const hasResults = groupEventsList.some((e) => !isPlaceholderActual(e.actual));
      result.push({
        groupId,
        time: timeStr,
        currency: base.currency,
        title,
        impact,
        events: groupEventsList,
        hasResults,
        theme,
      });
    } else {
      result.push(base);
      used.add(i);
    }
  }

  const withTime = result.filter((item) => {
    if ('events' in item) return getEventTimeMs((item as EventGroup).events[0]) > 0;
    return getEventTimeMs(item as CalendarEvent) > 0;
  });
  const withoutTime = result.filter((item) => {
    if ('events' in item) return getEventTimeMs((item as EventGroup).events[0]) === 0;
    return getEventTimeMs(item as CalendarEvent) === 0;
  });
  const sortByTime = (a: EventGroup | CalendarEvent, b: EventGroup | CalendarEvent) => {
    const ta = 'events' in a ? getEventTimeMs((a as EventGroup).events[0]) : getEventTimeMs(a as CalendarEvent);
    const tb = 'events' in b ? getEventTimeMs((b as EventGroup).events[0]) : getEventTimeMs(b as CalendarEvent);
    return ta - tb;
  };
  withTime.sort(sortByTime);
  return [...withTime, ...withoutTime];
}
