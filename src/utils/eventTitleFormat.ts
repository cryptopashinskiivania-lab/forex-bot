/**
 * Strip redundant country/region names from the beginning of event titles
 * when they match the currency (e.g. "[GBP] United Kingdom Unemployment Rate" -> "[GBP] Unemployment Rate").
 * Keeps impact, time, and forecast/previous/actual unchanged at call sites.
 */

const CURRENCY_PREFIXES: Record<string, string[]> = {
  USD: ['United States'],
  GBP: ['United Kingdom'],
  EUR: ['Euro Area', 'Germany', 'Italy', 'France', 'Spain', 'Netherlands'],
  AUD: ['Australia'],
  CAD: ['Canada'],
  JPY: ['Japan'],
  CHF: ['Switzerland'],
  NZD: ['New Zealand'],
};

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

let patternCache: Record<string, RegExp> = {};

function getPatternForCurrency(currency: string): RegExp | null {
  if (patternCache[currency]) return patternCache[currency];
  const prefixes = CURRENCY_PREFIXES[currency];
  if (!prefixes || prefixes.length === 0) return null;
  const sorted = [...prefixes].sort((a, b) => b.length - a.length);
  const escaped = sorted.map(escapeRegex).join('|');
  const pattern = new RegExp(`^(${escaped})\\s+`, 'i');
  patternCache[currency] = pattern;
  return pattern;
}

/**
 * Removes country/region prefix from the start of title when it matches the currency.
 * E.g. stripRedundantCountryPrefix('GBP', 'United Kingdom Unemployment Rate') -> 'Unemployment Rate'
 */
export function stripRedundantCountryPrefix(currency: string, title: string): string {
  const t = (title || '').trim();
  if (!t) return t;
  const pattern = getPatternForCurrency(currency);
  if (!pattern) return t;
  return t.replace(pattern, '').trim() || t;
}
