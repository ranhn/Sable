"use client";

import * as React from "react";

import { api } from "@/lib/api";

// Task numbering shared by every screen that shows a task reference.
//
// The task list numbers tasks by creation order (oldest = 1) instead of printing the
// database id, because ids stay sparse after deletions (1,2,3 then 9,10…) and "the
// same task shows as 3 in the list but 9 in the approval log" reads like a bug.
// One module-level cache keeps every screen consistent without a fetch per component.

let cached: Map<string, number> | null = null;
let inflight: Promise<Map<string, number>> | null = null;
let cachedAt = 0;
const TTL_MS = 30_000;

function fetchNumbers(): Promise<Map<string, number>> {
  if (cached && Date.now() - cachedAt < TTL_MS) return Promise.resolve(cached);
  if (inflight) return inflight;
  inflight = api
    .tasks()
    .then((res) => {
      const ascending = [...res.tasks].sort((a, b) => Number(a.id) - Number(b.id));
      const map = new Map<string, number>();
      ascending.forEach((task, index) => map.set(task.id, index + 1));
      cached = map;
      cachedAt = Date.now();
      return map;
    })
    .catch(() => cached ?? new Map<string, number>())
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** id → list number. Tolerant of the string|number ids that DTOs carry. */
export interface TaskNumberLookup {
  get: (id?: string | number | null) => number | undefined;
}

/** id → list number; empty until the first fetch resolves. */
export function useTaskNumbers(): TaskNumberLookup {
  const [map, setMap] = React.useState<Map<string, number>>(() => cached ?? new Map());
  React.useEffect(() => {
    let alive = true;
    void fetchNumbers().then((next) => {
      if (alive) setMap(next);
    });
    return () => {
      alive = false;
    };
  }, []);
  return React.useMemo(
    () => ({
      get: (id?: string | number | null) =>
        id === null || id === undefined || id === "" ? undefined : map.get(String(id)),
    }),
    [map],
  );
}

/** The number the task list shows for this id, or null while loading. */
export function useTaskNumber(id?: string | null): number | null {
  const numbers = useTaskNumbers();
  if (id === undefined || id === null || id === "") return null;
  return numbers.get(String(id)) ?? null;
}

/**
 * Inline task reference. Renders the list number, keeps the real id in the tooltip so
 * a support conversation can still name the row in the database.
 */
export function TaskRef({ id, prefix }: { id?: string | null; prefix?: string }) {
  const number = useTaskNumber(id);
  if (id === undefined || id === null || id === "") return <>—</>;
  return (
    <span title={`#${id}`}>
      {prefix}
      {number ?? id}
    </span>
  );
}
