"use client";

// React binding for the locale store. Components call useI18n() and render
// t("namespace.key"); because `t`, `rich` and `fmt` change identity with the
// locale, memoized output (React Compiler) refreshes on a language switch.

import { createContext, Fragment, type ReactNode, useContext, useEffect, useMemo, useSyncExternalStore } from "react";

import type { MessageKey } from "./catalog.ts";
import { DEFAULT_LOCALE, type Locale } from "./config.ts";
import { createFormatters, type Formatters, type MessageParams } from "./format.ts";
import { initializeLocale, getLocale, setLocale, subscribeLocale, translateIn } from "./runtime.ts";

export type { MessageKey } from "./catalog.ts";
export type { Locale } from "./config.ts";
export { LOCALE_NATIVE_NAMES, LOCALES } from "./config.ts";
export { getLocale, hasMessage, localeHeaders, localizedUrl, setLocale, translate } from "./runtime.ts";

export type TFunction = (key: MessageKey, params?: MessageParams) => string;
export type RichParams = Record<string, ReactNode>;
export type RichTags = Record<string, (chunk: ReactNode) => ReactNode>;
export type RichFunction = (key: MessageKey, params?: RichParams, tags?: RichTags) => ReactNode;

export interface I18n {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: TFunction;
  rich: RichFunction;
  fmt: Formatters;
}

const TOKEN = /<([A-Za-z][A-Za-z0-9]*)>([\s\S]*?)<\/\1>|\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

// renderRich supports ReactNode placeholders ({name}) and simple non-nested
// tags (<code>text</code>) rendered through the supplied tag functions.
export function renderRich(message: string, params: RichParams = {}, tagFns: RichTags = {}): ReactNode {
  const out: ReactNode[] = [];
  let last = 0;
  let index = 0;
  const pushText = (text: string) => {
    if (text) out.push(text);
  };
  for (const match of message.matchAll(TOKEN)) {
    const start = match.index ?? 0;
    pushText(message.slice(last, start));
    last = start + match[0].length;
    if (match[1] !== undefined) {
      const fn = tagFns[match[1]];
      const inner = renderRich(match[2], params, tagFns);
      out.push(<Fragment key={`t${index++}`}>{fn ? fn(inner) : inner}</Fragment>);
    } else {
      const name = match[3];
      out.push(
        <Fragment key={`p${index++}`}>{Object.hasOwn(params, name) ? params[name] : match[0]}</Fragment>,
      );
    }
  }
  pushText(message.slice(last));
  return out.length === 1 ? out[0] : out;
}

const cache = new Map<Locale, I18n>();

function i18nFor(locale: Locale): I18n {
  let value = cache.get(locale);
  if (!value) {
    const t: TFunction = (key, params) => translateIn(locale, key, params);
    value = {
      locale,
      setLocale,
      t,
      rich: (key, params, tags) => renderRich(translateIn(locale, key), params, tags),
      fmt: createFormatters(locale),
    };
    cache.set(locale, value);
  }
  return value;
}

const I18nContext = createContext<I18n>(i18nFor(DEFAULT_LOCALE));

// The server snapshot (static export prerender) is always English so hydration
// matches; the stored preference is applied right after hydration.
const serverSnapshot = () => DEFAULT_LOCALE;

export function LocaleProvider({ children }: { children: ReactNode }) {
  useEffect(() => { initializeLocale(); }, []);
  const locale = useSyncExternalStore(subscribeLocale, getLocale, serverSnapshot);
  const value = useMemo(() => i18nFor(locale), [locale]);
  useEffect(() => {
    document.documentElement.lang = locale;
    document.title = value.t("app.metaTitle");
  }, [locale, value]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18n {
  return useContext(I18nContext);
}

export function useT(): TFunction {
  return useContext(I18nContext).t;
}
