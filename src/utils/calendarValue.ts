/**
 * Helpers for calendar event values (actual, forecast).
 * Treats placeholders like PENDING as "no data" so we don't show result until real data is available.
 */

const PLACEHOLDER_ACTUAL = /^(pending|tbd|tba|n\/a|na|—|-|\.\.\.)$/i;

/**
 * Returns true if the value is a placeholder (no real data yet).
 * Used so we don't treat "PENDING" as actual and don't send "РЕЗУЛЬТАТ" until data is available.
 */
export function isPlaceholderActual(value: string): boolean {
  const t = (value || '').trim();
  return !t || t === '—' || t === '-' || PLACEHOLDER_ACTUAL.test(t);
}

/**
 * Returns true if the event time is "Tentative" (no fixed time).
 * Used so Tentative events are not grouped with others and are returned as singles.
 */
export function isTentativeTime(time: string): boolean {
  return (time || '').trim().toLowerCase() === 'tentative';
}
