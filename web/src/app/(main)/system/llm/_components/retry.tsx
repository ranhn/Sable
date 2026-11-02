"use client";

import { translate as swt } from "@/i18n/runtime";
import { useI18n } from "@/i18n";
// Shared LLM retry controls: count and interval for each of five layers.
//
// Inside out: connection (SDK), empty response (SDK), same-provider safe window, rotation breaker, intent rerun.
// The first three follow endpoints and allow profile overrides; the last two are process-global.
//
// All inputs use blank = unset, matching backend db.RetryRule:
// Count: blank/0 uses built-in default; -1 disables the layer; positive values override.
// Interval: blank/0 uses existing exponential backoff; positive values use fixed milliseconds.

import * as React from "react";

import { Loader2Icon, SaveIcon } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api";
import type { LLMRetryOverride, LLMRetryPolicy, LLMRetryRule } from "@/lib/types";

export const ZERO_RULE: LLMRetryRule = { attempts: 0, interval_ms: 0 };
export const ZERO_OVERRIDE: LLMRetryOverride = {
  connect: ZERO_RULE,
  empty: ZERO_RULE,
  stream: ZERO_RULE,
};
const ZERO_POLICY: LLMRetryPolicy = {
  ...ZERO_OVERRIDE,
  breaker: ZERO_RULE,
  intent: ZERO_RULE,
};

type LayerMeta = {
  title: string;
  /* Where and by whom this retry layer is executed. */
  where: string;
  /* Concrete triggering errors, including status codes, rather than vague descriptions. */
  trigger: string;
  /* Similar errors excluded from this layer, preventing mistaken expectations. */
  skips?: string;
  desc: string;
  attemptsLabel: string;
  /* Default retry count, shown as the placeholder. */
  defAttempts: number;
  /* Default interval strategy, shown as the placeholder. */
  defInterval: string;
  /* Meaning of retry count -1. */
  offHint: string;
};

export const RETRY_LAYERS = {
  connect: {
    get title() { return swt("interface.m1275"); },
    get where() { return swt("interface.m1276"); },
    get trigger() { return swt("interface.m1277"); },
    get skips() { return swt("interface.m1278"); },
    get desc() { return swt("interface.m1279"); },
    get attemptsLabel() { return swt("interface.m1280"); },
    defAttempts: 3,
    get defInterval() { return swt("interface.m1281"); },
    get offHint() { return swt("interface.m1282"); },
  },
  empty: {
    get title() { return swt("interface.m1283"); },
    get where() { return swt("interface.m1284"); },
    get trigger() { return swt("interface.m1285"); },
    get skips() { return swt("interface.m1286"); },
    get desc() { return swt("interface.m1287"); },
    get attemptsLabel() { return swt("interface.m1280"); },
    defAttempts: 2,
    get defInterval() { return swt("interface.m1281"); },
    get offHint() { return swt("interface.m1288"); },
  },
  stream: {
    get title() { return swt("interface.m1289"); },
    get where() { return swt("interface.m1290"); },
    get trigger() { return swt("interface.m1291"); },
    get skips() { return swt("interface.m1292"); },
    get desc() { return swt("interface.m1293"); },
    get attemptsLabel() { return swt("interface.m1280"); },
    defAttempts: 2,
    get defInterval() { return swt("interface.m1294"); },
    get offHint() { return swt("interface.m1295"); },
  },
  breaker: {
    get title() { return swt("interface.m1296"); },
    get where() { return swt("interface.m1297"); },
    get trigger() { return swt("interface.m1298"); },
    get skips() { return swt("interface.m1299"); },
    get desc() { return swt("interface.m1300"); },
    get attemptsLabel() { return swt("interface.m1301"); },
    defAttempts: 3,
    get defInterval() { return swt("interface.m1302"); },
    get offHint() { return swt("interface.m1303"); },
  },
  intent: {
    get title() { return swt("interface.m1304"); },
    get where() { return swt("interface.m1297"); },
    get trigger() { return swt("interface.m1305"); },
    get skips() { return swt("interface.m1306"); },
    get desc() { return swt("interface.m1307"); },
    get attemptsLabel() { return swt("interface.m1308"); },
    defAttempts: 2,
    get defInterval() { return swt("interface.m1309"); },
    get offHint() { return swt("interface.m1310"); },
  },
} satisfies Record<string, LayerMeta>;

type LayerKey = keyof typeof RETRY_LAYERS;

/* Human-readable milliseconds beside inputs to avoid counting zeros. */
function humanMs(ms: number) {
  if (!Number.isFinite(ms) || ms <= 0) return "";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${Number((ms / 1000).toFixed(2))}s`;
  return `${Number((ms / 60_000).toFixed(2))}min`;
}

/* Controlled numeric input: blank maps to 0; intermediate '-' or '1e' stays local without disturbing the parent. */
function NumField({
  id,
  value,
  onChange,
  placeholder,
  min,
}: {
  id: string;
  value: number;
  onChange: (n: number) => void;
  placeholder: string;
  min: number;
}) {
  "use no memo";
  const { t: swt, locale: swLocale } = useI18n();

  const [text, setText] = React.useState(value === 0 ? "" : String(value));
  // Follow complete parent-value replacements, such as loaded policies or switched profiles. Typing does not
  // enter this path because value already equals the parsed local text.
  React.useEffect(() => {
    const incoming = value === 0 ? "" : String(value);
    setText((cur) => (Number(cur || 0) === value ? cur : incoming));
  }, [value]);
  return (
    <Input
      id={id}
      type="number"
      min={min}
      className="w-28 shrink-0"
      value={text}
      placeholder={placeholder}
      onChange={(e) => {
        setText(e.target.value);
        const n = Number(e.target.value);
        onChange(e.target.value.trim() === "" || !Number.isFinite(n) ? 0 : Math.trunc(n));
      }}
    />
  );
}

/* Two controls per retry layer. idPrefix keeps label htmlFor unique across repeated instances. */
export function RetryRuleFields({
  layer,
  idPrefix,
  value,
  onChange,
  compact,
}: {
  layer: LayerKey;
  idPrefix: string;
  value: LLMRetryRule;
  onChange: (r: LLMRetryRule) => void;
  /* Compact profile-drawer mode keeps the trigger explanation but omits expanded details. */
  compact?: boolean;
}) {
  "use no memo";
  const { t: swt, locale: swLocale } = useI18n();

  const meta = RETRY_LAYERS[layer];
  const human = humanMs(value.interval_ms);
  return (
    <div className={compact ? "grid gap-2" : "grid gap-3 rounded-lg border p-3"}>
      <div className="grid gap-0.5">
        <div className="flex flex-wrap items-baseline gap-2">
          <Label className="text-sm">{meta.title}</Label>
          <span className="text-muted-foreground text-xs">{meta.where}</span>
        </div>
        {/* List specific triggering status codes so users can see why a retry setting may not affect an error. */}
        <p className="text-muted-foreground text-xs">
          <span className="font-medium text-foreground">{swt("interface.m1311")}</span>：{meta.trigger}
        </p>
        {!compact && meta.skips && (
          <p className="text-muted-foreground text-xs">
            <span className="font-medium text-foreground">{swt("interface.m1312")}</span>：{meta.skips}
          </p>
        )}
        {!compact && <p className="text-muted-foreground text-xs">{meta.desc}</p>}
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex items-center gap-2">
          <Label htmlFor={`${idPrefix}-${layer}-n`} className="text-muted-foreground text-xs">
            {meta.attemptsLabel}
          </Label>
          <NumField
            id={`${idPrefix}-${layer}-n`}
            min={-1}
            value={value.attempts}
            placeholder={swt("interface.m1313", { p0: meta.defAttempts })}
            onChange={(n) => onChange({ ...value, attempts: n })}
          />
        </div>
        <div className="flex items-center gap-2">
          <Label htmlFor={`${idPrefix}-${layer}-ms`} className="text-muted-foreground text-xs">
            {swt("interface.m1314")}</Label>
          <NumField
            id={`${idPrefix}-${layer}-ms`}
            min={0}
            value={value.interval_ms}
            placeholder={swt("interface.m1315")}
            onChange={(n) => onChange({ ...value, interval_ms: n })}
          />
          <span className="text-muted-foreground text-xs">{human ? swt("interface.m1316", { p0: human }) : meta.defInterval}</span>
        </div>
      </div>
      {!compact && <p className="text-muted-foreground text-xs">{swt("interface.m1317")}{meta.offHint}。</p>}
    </div>
  );
}

/* The three endpoint-specific retry overrides in the model profile drawer. */
export function ProfileRetryFields({
  value,
  onChange,
}: {
  value: LLMRetryOverride;
  onChange: (o: LLMRetryOverride) => void;
}) {
  "use no memo";
  const { t: swt, locale: swLocale } = useI18n();

  return (
    <div className="grid gap-3 rounded-lg border p-3">
      <div className="grid gap-0.5">
        <Label className="text-sm">{swt("interface.m1318")}</Label>
        <p className="text-muted-foreground text-xs">
          {swt("interface.m1319")}</p>
      </div>
      {(["connect", "empty", "stream"] as const).map((k) => (
        <div key={k} className="border-t pt-3 first:border-t-0 first:pt-0">
          <RetryRuleFields
            compact
            layer={k}
            idPrefix="pf"
            value={value[k]}
            onChange={(r) => onChange({ ...value, [k]: r })}
          />
        </div>
      ))}
    </div>
  );
}

/* Retries and backoff tab: global defaults for all five layers. */
export function RetryPolicyPanel() {
  "use no memo";
  const { t: swt, locale: swLocale } = useI18n();

  const [policy, setPolicy] = React.useState<LLMRetryPolicy>(ZERO_POLICY);
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const p = await api.llmRetryPolicy();
      setPolicy({ ...ZERO_POLICY, ...p });
    } catch (e) {
      toast.error(swt("interface.m1320", { p0: (e as Error).message }));
    } finally {
      setLoading(false);
    }
  }, [swLocale]);

  React.useEffect(() => {
    void load();
  }, [load]);

  async function save() {
    if (saving) return;
    setSaving(true);
    try {
      // Use returned server-clamped values so displayed settings match stored values.
      const saved = await api.saveLLMRetryPolicy(policy);
      setPolicy({ ...ZERO_POLICY, ...saved });
      toast.success(swt("interface.m1321"));
    } catch (e) {
      toast.error(swt("interface.m0267", { p0: (e as Error).message }));
    } finally {
      setSaving(false);
    }
  }

  const set = (k: LayerKey) => (r: LLMRetryRule) => setPolicy((p) => ({ ...p, [k]: r }));

  if (loading) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-dashed p-10 text-muted-foreground text-sm">
        <Loader2Icon className="size-4 animate-spin" /> {swt("interface.m1322")}</div>
    );
  }

  return (
    <div className="grid gap-4">
      <div className="rounded-lg border bg-muted/30 p-3 text-muted-foreground text-xs leading-relaxed">
        {swt("interface.m1323")}<span className="text-foreground"> {swt("interface.m1324")}</span>
        {swt("interface.m1325")}<span className="text-foreground">{swt("interface.m1326")}</span>
        {swt("interface.m1327")}</div>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {(Object.keys(RETRY_LAYERS) as LayerKey[]).map((k) => (
          <RetryRuleFields key={k} layer={k} idPrefix="gl" value={policy[k]} onChange={set(k)} />
        ))}
      </div>

      <div className="flex gap-2">
        <Button onClick={save} disabled={saving}>
          {saving ? <Loader2Icon className="animate-spin" /> : <SaveIcon />}
          {swt("interface.m0273")}</Button>
        <Button variant="outline" onClick={() => setPolicy(ZERO_POLICY)} disabled={saving}>
          {swt("interface.m1328")}</Button>
      </div>
    </div>
  );
}
