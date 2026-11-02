"use client";
import { useI18n } from "@/i18n";

import { ApprovalRecords } from "@/components/approval-records";

export function InterceptTab({ taskId }: { taskId: string }) {
  "use no memo";
  const { locale: swLocale } = useI18n();

  return <ApprovalRecords key={taskId} taskId={taskId} />;
}
