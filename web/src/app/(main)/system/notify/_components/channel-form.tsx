"use client";

import { translate as swt } from "@/i18n/runtime";
import { useI18n } from "@/i18n";
import { CheckIcon } from "lucide-react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import type { NotificationFilter } from "@/lib/types";

// asText/inputType are rendering helpers kept here rather than in channel-fields.
import { type FieldDef, type FieldKind, SEVERITY_OPTIONS } from "./channel-fields";

// asText converts arbitrary configuration values into input-compatible strings.
// JSON configuration values may be strings, numbers, booleans, arrays, or null;
// this only handles text display, while buildConfig handles serialization.
function asText(v: unknown): string {
  if (typeof v === "string") return v;
  if (v === null || v === undefined) return "";
  return String(v);
}

// inputType maps field kinds to input type attributes.
function inputType(kind: FieldKind): "text" | "password" | "number" {
  if (kind === "password") return "password";
  if (kind === "number") return "number";
  return "text";
}

// ConfigField renders the control described by its field definition.
//
// Masked credentials never appear inside inputs; show a separate Saved hint instead.
// Thus text inside a field always means user input and an empty field means empty.
// Placing __masked__:…abc123 inside the input could look like placeholder text to delete,
// making accidental credential removal more likely.
export function ConfigField({
  def,
  value,
  isSecret,
  onChange,
}: {
  def: FieldDef;
  value: unknown;
  isSecret: boolean;
  onChange: (v: unknown) => void;
}) {
  "use no memo";
  const { t: swt, locale: swLocale } = useI18n();

  const id = `n-cfg-${def.key}`;
  const raw = asText(value);
  // Backend masks use __masked__:…abc123 with a recognizable suffix of the original value.
  const masked = isSecret && raw.startsWith("__masked__");
  const maskedTail = masked ? (raw.split("…")[1] ?? "") : "";

  if (def.kind === "switch") {
    return (
      <div className="flex items-center gap-2 text-sm">
        <Switch checked={value === true} onCheckedChange={onChange} aria-label={def.label} />
        {def.label}
        {def.help && <span className="text-muted-foreground">（{def.help}）</span>}
      </div>
    );
  }

  if (def.kind === "select") {
    return (
      <div className="grid gap-2">
        <Label>{def.label}</Label>
        <Select value={raw || def.options?.[0]?.value} onValueChange={onChange}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(def.options ?? []).map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    );
  }

  // Dispatch four control types through if statements instead of deeply nested ternaries,
  // which are difficult to read here.
  function control() {
    if (def.kind === "textarea" || def.kind === "kv") {
      return (
        <Textarea
          id={id}
          className="font-mono"
          placeholder={def.placeholder}
          value={masked ? "" : raw}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    }
    if (def.kind === "list") {
      return (
        <Input
          id={id}
          value={Array.isArray(value) ? (value as string[]).join(", ") : raw}
          onChange={(e) => onChange(e.target.value)}
          placeholder={def.placeholder}
        />
      );
    }
    return (
      <Input
        id={id}
        className={def.kind === "text" ? "font-mono" : ""}
        type={inputType(def.kind)}
        placeholder={def.placeholder}
        value={masked ? "" : raw}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }

  const hint = masked ? (
    <p className="text-muted-foreground flex items-center gap-1 text-xs">
      <CheckIcon className="size-3" />
      {swt("interface.m0377")}{" "}{maskedTail ? swt("interface.m1513", { p0: maskedTail }) : ""} {swt("interface.m1514")}</p>
  ) : (
    def.help && <p className="text-muted-foreground text-xs">{def.help}</p>
  );

  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>{def.label}</Label>
      {control()}
      {hint}
    </div>
  );
}

// FilterSummary describes channel filters in one line without opening the card.
export function FilterSummary({ filter }: { filter: NotificationFilter }) {
  "use no memo";
  const { t: swt, locale: swLocale } = useI18n();

  const parts: string[] = [];
  if (filter.min_severity) {
    parts.push(SEVERITY_OPTIONS.find((o) => o.value === filter.min_severity)?.label ?? filter.min_severity);
  }
  if (filter.vulnclass_include?.length) parts.push(swt("interface.m1515", { p0: filter.vulnclass_include.length }));
  if (filter.vulnclass_exclude?.length) parts.push(swt("interface.m1516", { p0: filter.vulnclass_exclude.length }));
  if (filter.task_ids?.length) parts.push(swt("interface.m0989", { p0: filter.task_ids.length }));
  if (filter.asset_ids?.length) parts.push(swt("interface.m1517", { p0: filter.asset_ids.length }));
  if (filter.on_status_change) parts.push(swt("interface.m1518"));
  if (parts.length === 0) {
    return <p className="text-muted-foreground text-sm">{swt("interface.m1519")}</p>;
  }
  return <p className="text-muted-foreground text-sm">{parts.join(" · ")}</p>;
}
