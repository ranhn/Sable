"use client";

import { translate as swt } from "@/i18n/runtime";
import { useI18n } from "@/i18n";
import { Card, CardContent } from "@/components/ui/card";

export function StatTile({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: string }) {
  "use no memo";
  const { t: swt, locale: swLocale } = useI18n();

  return (
    <Card size="sm" className="gap-1">
      <CardContent>
        <p className="text-muted-foreground text-xs">{label}</p>
        <p className={`text-lg font-semibold ${tone === "red" ? "text-rose-600" : ""}`}>{value}</p>
        {hint && <p className={`text-xs ${tone === "red" ? "text-rose-600" : "text-muted-foreground"}`}>{hint}</p>}
      </CardContent>
    </Card>
  );
}

// formatBacklog renders backlog milliseconds at a readable scale.
export function formatBacklog(ms: number): string {
  if (!ms) return "—";
  if (ms < 60_000) return swt("interface.m1530", { p0: Math.round(ms / 1000) });
  if (ms < 3_600_000) return swt("interface.m1531", { p0: Math.round(ms / 60_000) });
  return swt("interface.m1532", { p0: (ms / 3_600_000).toFixed(1) });
}
