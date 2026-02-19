# Data Sources

## MyFxBook

| Property | Value |
|----------|--------|
| **Method** | RSS feed |
| **URL** | https://www.myfxbook.com/rss/forex-economic-calendar-events |
| **Service** | `MyfxbookRssService` (`src/services/MyfxbookRssService.ts`) |
| **Performance** | ~400–500 ms |
| **Reliability** | 99%+ (no browser, no Cloudflare) |

RSS is parsed with `rss-parser`; only High/Medium impact events are kept. No Playwright/browser used.

---

## ForexFactory

| Property | Value |
|----------|--------|
| **Method** | CSV export (HTTP + papaparse) |
| **URL** | https://nfs.faireconomy.media/ff_calendar_thisweek.csv |
| **Service** | `ForexFactoryCsvService` (`src/services/ForexFactoryCsvService.ts`) |
| **Performance** | ~100–300 ms (no browser) |
| **Reliability** | 99%+ (no Cloudflare) |
| **Cache** | 60 minutes (CSV updates hourly) |

CSV columns: Title, Country, Date, Time, Impact, Forecast, Previous, URL. Date (MM-DD-YYYY) and Time (h:mma) are in **UTC** (nfs.faireconomy.media), parsed and converted to ISO. Only High/Medium impact events are returned. DataQualityService validates before caching. On 429 (rate limit), service waits per Retry-After then retries once; if still rate limited, returns cached data or empty array.

---

## Event Aggregation

All bot commands and the scheduler use **`aggregateCoreEvents()`** (`src/utils/eventAggregation.ts`), which:

1. **Fetches** from one or both sources (based on user preference: `ForexFactory`, `Myfxbook`, or `Both`).
2. **Filters by user timezone** — “today” or “tomorrow” in the user’s timezone.
3. **Filters by monitored currencies** — only events for currencies the user follows.
4. **Deduplicates** events (same title/time/currency) across sources.
5. **Returns** events sorted by time.

Shared calendar data can be fetched once per run via `fetchSharedCalendarToday()` and then filtered per user with `getEventsForUserFromShared()` (used by the scheduler to avoid N×2 fetches for N users).
