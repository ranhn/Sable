"use client";

import { translate as swt } from "@/i18n/runtime";
import { useI18n } from "@/i18n";
import * as React from "react";

import Link from "next/link";

import { ArrowUpCircleIcon } from "lucide-react";

import { api } from "@/lib/api";

/* Check for updates on mount and show a header badge linking to Version and updates. The backend caches GitHub results for 30 minutes, avoiding the unauthenticated API's 60 requests/hour/IP limit across tabs. Fail silently here; the settings page exposes check errors. */
export function UpdateBadge() {
  "use no memo";
  const { t: swt, locale: swLocale } = useI18n();

  const [latest, setLatest] = React.useState("");

  React.useEffect(() => {
    let alive = true;
    api
      .checkUpdate()
      .then((r) => {
        // has_update already checks version comparability; development builds do not show this badge.
        if (alive && r.has_update && r.latest) setLatest(r.latest.replace(/^v(?=\d)/, ""));
      })
      .catch(() => {
        // Keep network/GitHub rate-limit errors silent in the header.
      });
    return () => {
      alive = false;
    };
  }, []);

  if (!latest) return null;

  return (
    <Link
      href="/system/settings"
      title={swt("interface.m0066", { p0: latest })}
      className="inline-flex items-center gap-1.5 rounded-full bg-primary px-2.5 py-1 font-medium text-primary-foreground text-xs transition-opacity hover:opacity-90"
    >
      {/* A pulsing dot makes the update notice noticeable among many header elements. */}
      <span className="relative flex size-1.5">
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary-foreground opacity-75" />
        <span className="relative inline-flex size-1.5 rounded-full bg-primary-foreground" />
      </span>
      <ArrowUpCircleIcon className="size-3.5" />
      <span className="hidden sm:inline">{swt("interface.m0067")}{" "}{latest}</span>
      <span className="sm:hidden">{swt("interface.m0067")}</span>
    </Link>
  );
}
