/**
 * Global mutex for browser-based fetches (CalendarService, MyfxbookService).
 * Ensures only one Playwright operation runs at a time to avoid:
 * - Dozens of concurrent browsers (timeouts, "browser has been closed")
 * - Resource exhaustion on scheduler + many /calendar commands.
 */

let tail: Promise<unknown> = Promise.resolve();

/**
 * Run an async function while holding the browser fetch lock.
 * Call this around any code that launches or uses Playwright (getBrowser, page.goto, etc.).
 */
export function runWithBrowserLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = tail;
  const p = prev.then(() => fn());
  tail = p.catch(() => {});
  return p;
}
