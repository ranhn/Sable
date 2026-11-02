"use client";

import { translate as swt } from "@/i18n/runtime";
import { useI18n } from "@/i18n";
import { cn } from "@/lib/utils"
import { Loader2Icon } from "lucide-react"

function Spinner({ className, ...props }: React.ComponentProps<"svg">) {
  "use no memo";
  const { t: swt, locale: swLocale } = useI18n();

  return (
    <Loader2Icon data-slot="spinner" role="status" aria-label={swt("english.e161")} className={cn("size-4 animate-spin", className)} {...props} />
  )
}

export { Spinner }
