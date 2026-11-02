import { getLocale, translateIn } from "../i18n/runtime.ts";
import type { Locale } from "../i18n/config.ts";
import type { ChatContextView, ChatControlState } from "./types.ts";
export const chatCompactDefaults = { focus: "", keep_recent: 2 };
export function canCompactChatContext(state: ChatControlState | null, view: ChatContextView | null) {
  return (
    !!state?.capabilities.compact &&
    !state.active &&
    !state.context_changing &&
    !state.inputs.some((item) => item.status === "unknown") &&
    !!view &&
    view.source !== "unobserved"
  );
}
export function formatChatContext(view: ChatContextView | null, locale: Locale = getLocale()) {
  const t = (key: Parameters<typeof translateIn>[1]) => translateIn(locale, key);
  const number = (n: number) => new Intl.NumberFormat(locale).format(n);
  const unknown = !view || view.source === "unobserved";
  const label = view?.estimated ? t("interface.chatContextEstimated") : t("interface.chatContextMeasured");
  const names: Record<string, Parameters<typeof translateIn>[1]> = {
    system: "interface.chatContextSystem",
    tools: "interface.chatContextTools",
    skills: "interface.chatContextSkills",
    mcp: "interface.chatContextMCP",
    conversation: "interface.chatContextConversation",
    documents: "interface.chatContextDocuments",
    memory: "interface.chatContextMemory",
    other: "interface.chatContextOther",
  };
  return {
    usage: unknown
      ? t("interface.chatContextUnknown")
      : `${number(view.used)} / ${view.window > 0 ? number(view.window) : "?"} · ${label}`,
    headroom: unknown || view.window <= 0 ? "?" : number(view.headroom),
    categories: (view?.categories ?? []).map((category) => ({
      name: t(names[category.name] ?? names.other),
      label: `${number(category.tokens)} · ${t("interface.chatContextEstimated")}`,
    })),
  };
}
