// Framework-agnostic locale store. React components read it through
// LocaleProvider/useI18n (src/i18n/index.tsx); non-React modules such as the
// API client call getLocale()/translate() directly.

import { catalogs, type MessageKey } from "./catalog.ts";
import {
  DEFAULT_LOCALE,
  intlLocale,
  LOCALE_STORAGE_KEY,
  type Locale,
  localeCookie,
  normalizeLocale,
  readCookieLocale,
  withLocaleHeaders,
  withLocaleQuery,
} from "./config.ts";
import { interpolate, type MessageParams } from "./format.ts";

type Listener = (locale: Locale) => void;

let current: Locale = DEFAULT_LOCALE;
let initialized = false;
const listeners = new Set<Listener>();

// readStoredLocale: localStorage first, then the cookie. No browser-language
// sniffing — English stays the default until the user picks another locale.
export function readStoredLocale(): Locale | null {
  if (typeof window === "undefined") return null;
  try {
    const stored = normalizeLocale(window.localStorage.getItem(LOCALE_STORAGE_KEY));
    if (stored) return stored;
  } catch {
    // Storage can be unavailable (privacy mode); fall through to the cookie.
  }
  return typeof document === "undefined" ? null : readCookieLocale(document.cookie);
}

export function initializeLocale() {
  if (initialized || typeof window === "undefined") return;
  initialized = true;
  const next = readStoredLocale() ?? DEFAULT_LOCALE;
  const changed = current !== next;
  current = next;
  persist(next);
  if (changed) for (const listener of listeners) listener(next);
}

// Rendering starts in English, matching the static-export hydration snapshot.
// The provider initializes persisted preferences after hydration.
export function getLocale(): Locale { return current; }

function persist(locale: Locale) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // Ignore storage failures; the cookie still carries the preference.
  }
  // biome-ignore lint/suspicious/noDocumentCookie: plain cookie write keeps static export working.
  document.cookie = localeCookie(locale);
  document.documentElement.lang = locale;
}

export function setLocale(next: Locale) {
  initialized = true;
  persist(next);
  if (next === current) return;
  current = next;
  for (const listener of listeners) listener(next);
}

export function subscribeLocale(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function hasMessage(key: string): key is MessageKey {
  return Object.hasOwn(catalogs.en, key);
}

// translateIn never falls back to another language: shipped catalogs are
// complete by construction (see catalog.ts); an unknown key renders as itself.
export function translateIn(locale: Locale, key: MessageKey, params?: MessageParams): string {
  const message = catalogs[locale][key];
  return message === undefined ? key : interpolate(message, params);
}

export function translate(key: MessageKey, params?: MessageParams): string {
  return translateIn(getLocale(), key, params);
}

export function localeHeaders(headers?: HeadersInit): Record<string, string> {
  return withLocaleHeaders(readStoredLocale() ?? getLocale(), headers);
}

export function localizedUrl(url: string): string {
  return withLocaleQuery(url, readStoredLocale() ?? getLocale());
}

// Test hook: reset module state between cases.
export function __resetLocaleForTests() {
  current = DEFAULT_LOCALE;
  initialized = false;
  listeners.clear();
}

export function getIntlLocale(): string { return intlLocale(getLocale()); }
