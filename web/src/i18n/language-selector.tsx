"use client";
;

import { Languages } from "lucide-react";
import { useI18n, LOCALES, LOCALE_NATIVE_NAMES, type Locale } from "./index";

export function LanguageSelector() {
  const { locale, setLocale, t } = useI18n();
  return (
    <label className="inline-flex items-center gap-2 rounded-md border bg-background px-2 py-1.5 text-sm text-foreground">
      <Languages aria-hidden="true" className="size-4 shrink-0" />
      <span className="sr-only">{t("app.language")}</span>
      <select aria-label={t("app.languageSelectAria")} value={locale} onChange={(event) => setLocale(event.target.value as Locale)} className="min-w-0 bg-transparent outline-none focus-visible:ring-2 focus-visible:ring-ring">
        {LOCALES.map((value) => <option key={value} value={value}>{LOCALE_NATIVE_NAMES[value]}</option>)}
      </select>
    </label>
  );
}
