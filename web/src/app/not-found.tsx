"use client";
import { translate as swt } from "@/i18n/runtime";
import { useI18n } from "@/i18n";

import Link from "next/link";

import { Button } from "@/components/ui/button";

export default function NotFound() {
  "use no memo";
  const { locale: swLocale } = useI18n();

  return (
    <div className="flex h-dvh flex-col items-center justify-center space-y-2 text-center">
      <h1 className="font-semibold text-2xl">{swt("english.e140")}</h1>
      <p className="text-muted-foreground">{swt("english.e141")}</p>
      <Link prefetch={false} replace href="/function/tasks">
        <Button variant="outline">{swt("english.e142")}</Button>
      </Link>
    </div>
  );
}
