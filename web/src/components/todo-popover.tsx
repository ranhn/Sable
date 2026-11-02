"use client";

import { translate as swt } from "@/i18n/runtime";
import { useI18n } from "@/i18n";
import * as React from "react";
import { ListTodo } from "lucide-react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

// TodoPopover shows the latest TodoWrite state of a session (chat conversation or
// task worker/planner replay). The full todo list isn't in the activity list
// (detail is lazy), so on open it fetches the detail of the most-recent TodoWrite
// call — by seq — and parses its {todos:[…]} JSON. Purely client-side; the caller
// supplies the seq + a detail fetcher (conversation or exploration endpoint).
export function TodoPopover({
  seq,
  fetchDetail,
}: {
  seq: number | null;
  fetchDetail: (seq: number) => Promise<string>;
}) {
  "use no memo";
  const { t: swt, locale: swLocale } = useI18n();

  const [open, setOpen] = React.useState(false);
  const [todos, setTodos] = React.useState<{ content: string; status: string }[] | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [err, setErr] = React.useState("");

  const load = React.useCallback(async () => {
    if (seq == null) return;
    setLoading(true);
    setErr("");
    try {
      const detail = await fetchDetail(seq);
      const start = detail.indexOf("{"); // detail may have a TodoWrite prefix.
      const parsed = JSON.parse(start >= 0 ? detail.slice(start) : detail);
      setTodos(Array.isArray(parsed?.todos) ? parsed.todos : []);
    } catch {
      setErr(swt("interface.m2367"));
      setTodos(null);
    } finally {
      setLoading(false);
    }
  }, [swLocale, seq, fetchDetail]);

  // refetch on each open — todos change as the run progresses.
  React.useEffect(() => {
    if (open) load();
  }, [open, load]);

  const disabled = seq == null;
  const MARK: Record<string, string> = { pending: "☐", in_progress: "▶", completed: "✔" };
  return (
    <Popover open={open} onOpenChange={disabled ? undefined : setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          title={disabled ? swt("interface.m2368") : swt("interface.m2369")}
          className="text-muted-foreground/70 hover:text-primary flex items-center gap-0.5 text-xs disabled:pointer-events-none disabled:opacity-40"
        >
          <ListTodo className="size-3" />
          {swt("english.e150")}</button>
      </PopoverTrigger>
      <PopoverContent align="end" className="max-h-80 w-80 overflow-auto p-2">
        <p className="text-muted-foreground px-1 pb-1 text-[11px] font-medium">
          {swt("interface.m2370")}{" "}{loading ? swt("interface.m2371") : ""}
        </p>
        {err && <p className="text-destructive px-1 text-xs">{err}</p>}
        {todos && todos.length === 0 && !loading && (
          <p className="text-muted-foreground px-1 text-xs">{swt("interface.m0306")}</p>
        )}
        <ul className="space-y-0.5">
          {(todos ?? []).map((t, i) => (
            <li
              key={`${i}:${t.content}`}
              className={cn("flex gap-1.5 px-1 text-xs", t.status === "completed" && "text-muted-foreground line-through")}
            >
              <span className="shrink-0">{MARK[t.status] ?? "☐"}</span>
              <span className="break-words">{t.content}</span>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
