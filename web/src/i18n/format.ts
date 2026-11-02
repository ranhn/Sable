// Message interpolation and locale-aware formatting. Pure functions.

import { intlLocale, type Locale } from "./config.ts";

export type MessageParams = Record<string, string | number | null | undefined>;

const PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const TAG = /<([A-Za-z][A-Za-z0-9]*)>|<\/([A-Za-z][A-Za-z0-9]*)>/g;

// interpolate replaces {name} placeholders. Unknown placeholders are kept
// verbatim so a missing value is visible instead of silently disappearing.
export function interpolate(message: string, params?: MessageParams): string {
  if (!params) return message;
  return message.replace(PLACEHOLDER, (match, name: string) =>
    Object.hasOwn(params, name) ? String(params[name]) : match,
  );
}

export function placeholders(message: string): string[] {
  return Array.from(new Set(Array.from(message.matchAll(PLACEHOLDER), (m) => m[1]))).sort();
}

export function tags(message: string): string[] {
  // The rich renderer consumes paired tags; unpaired URL metavariables such
  // as <host> are plain display text and may have translated names.
  const matches = Array.from(message.matchAll(TAG));
  const paired = new Set(matches.filter((m) => m[2]).map((m) => m[2]));
  return matches.filter((m) => paired.has(m[1] ?? m[2])).map((m) => m[1] ?? `/${m[2]}`).sort();
}

export type DateInput = Date | number | string | null | undefined;

function toDate(value: DateInput): Date | null {
  if (value === null || value === undefined || value === "") return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatDateTime(locale: Locale, value: DateInput, options?: Intl.DateTimeFormatOptions): string {
  const date = toDate(value);
  if (!date) return typeof value === "string" ? value : "";
  return date.toLocaleString(intlLocale(locale), options);
}

export function formatDate(locale: Locale, value: DateInput, options?: Intl.DateTimeFormatOptions): string {
  const date = toDate(value);
  if (!date) return typeof value === "string" ? value : "";
  return date.toLocaleDateString(intlLocale(locale), options);
}

export function formatTime(locale: Locale, value: DateInput, options?: Intl.DateTimeFormatOptions): string {
  const date = toDate(value);
  if (!date) return typeof value === "string" ? value : "";
  return date.toLocaleTimeString(intlLocale(locale), options);
}

export function formatNumber(locale: Locale, value: number, options?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat(intlLocale(locale), options).format(value);
}

export interface Formatters {
  locale: Locale;
  dateTime: (value: DateInput, options?: Intl.DateTimeFormatOptions) => string;
  date: (value: DateInput, options?: Intl.DateTimeFormatOptions) => string;
  time: (value: DateInput, options?: Intl.DateTimeFormatOptions) => string;
  number: (value: number, options?: Intl.NumberFormatOptions) => string;
}

export function createFormatters(locale: Locale): Formatters {
  return {
    locale,
    dateTime: (value, options) => formatDateTime(locale, value, options),
    date: (value, options) => formatDate(locale, value, options),
    time: (value, options) => formatTime(locale, value, options),
    number: (value, options) => formatNumber(locale, value, options),
  };
}
