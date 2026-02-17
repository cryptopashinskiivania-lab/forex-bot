/**
 * Shared calendar event type used by ForexFactory (CSV), Myfxbook, and aggregation.
 */
export interface CalendarEvent {
  title: string;
  currency: string;
  impact: 'High' | 'Medium' | 'Low';
  time: string;
  timeISO?: string;
  forecast: string;
  previous: string;
  actual: string;
  source?: string;
  isResult: boolean;
}
