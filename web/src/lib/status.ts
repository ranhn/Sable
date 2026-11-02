import { translate as swt } from "@/i18n/runtime";
// Centralised status → color/label semantics, reused across the whole app.
// Spec 8.3: intents, coverage, tasks, and severity each use consistent colors.

export type Tone = "neutral" | "blue" | "green" | "amber" | "red" | "rose" | "violet" | "slate";

export const toneClasses: Record<Tone, string> = {
  neutral: "bg-muted text-muted-foreground border-transparent",
  blue: "bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/20",
  green: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/20",
  amber: "bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/20",
  red: "bg-red-500/15 text-red-600 dark:text-red-400 border-red-500/20",
  // Rose indicates Critical with solid emphasis, visually stronger than High's soft red outline.
  rose: "bg-rose-600 text-white border-rose-600 dark:bg-rose-600 dark:text-white",
  violet: "bg-violet-500/15 text-violet-600 dark:text-violet-400 border-violet-500/20",
  slate: "bg-slate-500/15 text-slate-600 dark:text-slate-400 border-slate-500/20",
};

export const toneDot: Record<Tone, string> = {
  neutral: "bg-muted-foreground",
  blue: "bg-blue-500",
  green: "bg-emerald-500",
  amber: "bg-amber-500",
  red: "bg-red-500",
  rose: "bg-white",
  violet: "bg-violet-500",
  slate: "bg-slate-500",
};

interface StatusMeta {
  label: string;
  tone: Tone;
}

const intent: Record<string, StatusMeta> = {
  open: { get label() { return swt("interface.m2842"); }, tone: "slate" },
  running: { get label() { return swt("interface.m0648"); }, tone: "blue" },
  paused: { get label() { return swt("interface.m0564"); }, tone: "amber" },
  done: { get label() { return swt("interface.m0809"); }, tone: "green" },
  // blocked means exhausted model/API/network retries, not target interception; exploration did not really complete.
  blocked: { get label() { return swt("interface.m2843"); }, tone: "red" },
  // exhausted means interrupted by time/step budget with partial results, not an exhausted direction.
  exhausted: { get label() { return swt("interface.m2844"); }, tone: "violet" },
  // stopped is the retained legacy soft-deletion state.
  stopped: { get label() { return swt("interface.m2218"); }, tone: "slate" },
  // deleted means user soft-deletion; preserve node/lineage and store the reason in delete_reason.
  deleted: { get label() { return swt("interface.m0700"); }, tone: "slate" },
};

const task: Record<string, StatusMeta> = {
  created: { get label() { return swt("interface.m0826"); }, tone: "slate" },
  queued: { get label() { return swt("interface.m0827"); }, tone: "amber" },
  running: { get label() { return swt("interface.m0096"); }, tone: "blue" },
  paused: { get label() { return swt("interface.m0564"); }, tone: "amber" },
  done: { get label() { return swt("interface.m0809"); }, tone: "green" },
  failed: { get label() { return swt("interface.m0294"); }, tone: "red" },
  timeout: { get label() { return swt("interface.m0828"); }, tone: "amber" },
};

const severity: Record<string, StatusMeta> = {
  critical: { get label() { return swt("interface.m0154"); }, tone: "rose" },
  high: { get label() { return swt("interface.m0155"); }, tone: "red" },
  medium: { get label() { return swt("interface.m0156"); }, tone: "amber" },
  low: { get label() { return swt("interface.m0157"); }, tone: "slate" },
};

const finding: Record<string, StatusMeta> = {
  pending: { get label() { return swt("interface.m0384"); }, tone: "amber" },
  in_progress: { get label() { return swt("interface.m2845"); }, tone: "blue" },
  confirmed: { get label() { return swt("interface.m0533"); }, tone: "red" },
  resolved: { get label() { return swt("interface.m2846"); }, tone: "green" },
  fixed: { get label() { return swt("interface.m2220"); }, tone: "green" },
  false_positive: { get label() { return swt("interface.m2847"); }, tone: "slate" },
  ignored: { get label() { return swt("interface.m2848"); }, tone: "neutral" },
  duplicate: { get label() { return swt("interface.m2849"); }, tone: "neutral" },
  risk_accepted: { get label() { return swt("interface.m2850"); }, tone: "violet" },
};

const engine: Record<string, StatusMeta> = {
  exploring: { get label() { return swt("interface.m2851"); }, tone: "blue" },
  paused: { get label() { return swt("interface.m0564"); }, tone: "amber" },
  stalled: { get label() { return swt("interface.m2852"); }, tone: "red" },
  idle: { get label() { return swt("interface.m2853"); }, tone: "neutral" },
};

const goal: Record<string, StatusMeta> = {
  open: { get label() { return swt("interface.m2854"); }, tone: "blue" },
  met: { get label() { return swt("interface.m2855"); }, tone: "green" },
  abandoned: { get label() { return swt("interface.m2856"); }, tone: "slate" },
};

const audit: Record<string, StatusMeta> = {
  allow: { get label() { return swt("interface.m1223"); }, tone: "green" },
  block: { get label() { return swt("interface.m0673"); }, tone: "red" },
};

const node: Record<string, StatusMeta> = {
  observed: { get label() { return swt("interface.m2857"); }, tone: "slate" },
  confirmed: { get label() { return swt("interface.m2858"); }, tone: "green" },
  tombstoned: { get label() { return swt("interface.m2859"); }, tone: "neutral" },
};

// Notification delivery states: sending is blue rather than amber because it indicates active delivery,
// not a problem, and differs from pending's waiting semantics.
const delivery: Record<string, StatusMeta> = {
  pending: { get label() { return swt("interface.m1547"); }, tone: "amber" },
  sending: { get label() { return swt("interface.m2860"); }, tone: "blue" },
  sent: { get label() { return swt("interface.m2861"); }, tone: "green" },
  failed: { get label() { return swt("interface.m0294"); }, tone: "red" },
  skipped: { get label() { return swt("interface.m2323"); }, tone: "neutral" },
};

const maps = {
  intent,
  task,
  severity,
  finding,
  engine,
  goal,
  audit,
  node,
  delivery,
} as const;

export type StatusDomain = keyof typeof maps;

export function statusMeta(domain: StatusDomain, key: string): StatusMeta {
  return maps[domain][key] ?? { label: key, tone: "neutral" };
}
