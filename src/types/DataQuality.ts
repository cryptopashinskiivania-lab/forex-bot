/**
 * Types for Data Quality Control Module
 */

export type DataIssueType =
  | 'MISSING_REQUIRED_FIELD'
  | 'INVALID_RANGE'
  | 'TIME_INCONSISTENCY'
  | 'DUPLICATE_EVENT'
  | 'CONFLICT_BETWEEN_SOURCES'
  | 'PAST_TOO_FAR'
  | 'NO_TIME';

export interface DataIssue {
  eventId?: string;
  source: 'ForexFactory' | 'Myfxbook' | 'Merge';
  type: DataIssueType;
  message: string;
  details?: Record<string, unknown>;
}

export interface ValidationResult<T> {
  valid: T[];
  issues: DataIssue[];
}

export interface FilterResult<T> {
  deliver: T[];
  skipped: DataIssue[];
}

export interface AiQualitySummary {
  totalEvents: number;
  validEvents: number;
  issues: DataIssue[];
  recommendations: string[];
}
