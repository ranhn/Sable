"use client";

import { localizedFetch as fetch } from "@/i18n/request";

import { translate as swt } from "@/i18n/runtime";
import { useI18n } from "@/i18n";
import * as React from "react";

import {
  CheckCircle2Icon,
  DownloadIcon,
  ExternalLinkIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  ShieldCheckIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { api, sseUrl } from "@/lib/api";
import type { UpdateCheck, UpdateProgress } from "@/lib/types";

/* Maximum update wait. Staging, swapping, and the new version each start a process; three minutes covers slow disks and Docker recreation. */
const RESTART_TIMEOUT_MS = 180_000;

function humanSize(n?: number): string {
  if (!n || n <= 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function UpdateCard() {
  "use no memo";
  const { t: swt, rich, locale: swLocale } = useI18n();

  const updateStream = React.useRef<EventSource | null>(null);
  const updateFrom = React.useRef<string | null>(null);
  const [info, setInfo] = React.useState<UpdateCheck | null>(null);
  const [checking, setChecking] = React.useState(true);
  const [progress, setProgress] = React.useState<UpdateProgress | null>(null);
  // Separate from progress: staging stops the process and SSE, then /api/health polling takes over.
  const [restarting, setRestarting] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  // quiet also controls cache bypass. Automatic entry checks use cache already warmed by the header;
  // manual checks force upstream refresh so new releases appear before cache expiry.
  const check = React.useCallback((quiet = false) => {
    setChecking(true);
    api
      .checkUpdate(!quiet)
      .then((r) => {
        setInfo(r);
        if (!quiet) {
          // Strict local-only mode is a deliberate policy, not a failed connection.
          if (r.local_llm_only) toast.info(swt("settings.updateLocalOnly"));
          else if (r.error) toast.error(swt("interface.m1589") + r.error);
          else if (r.has_update) toast.success(swt("interface.m1590", { p0: r.latest }));
          else if (r.comparable) toast.success(swt("interface.m1591"));
        }
      })
      .catch((e) => {
        if (!quiet) toast.error(swt("interface.m1589") + (e as Error).message);
      })
      .finally(() => setChecking(false));
  }, [swLocale]);

  React.useEffect(() => {
    check(true);
  }, [check]);

  // Poll /api/health until the version changes.
  //
  // Require a changed version, not merely connectivity: the old version briefly starts during swapping
  // to install artex.new and exits again. Connectivity alone would falsely report success.
  const waitForNewVersion = React.useCallback(async (fromVersion: string) => {
    setRestarting(true);
    const deadline = Date.now() + RESTART_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await sleep(2000);
      try {
        const r = await fetch("/sable/api/health", { cache: "no-store" });
        if (r.ok) {
          const j = (await r.json()) as { version?: string };
          if (j.version && j.version !== fromVersion) {
            toast.success(swt("interface.m1592", { p0: j.version }));
            await sleep(800);
            window.location.reload();
            return;
          }
        }
      } catch {
        // Connection failure during restart is expected; continue polling.
      }
    }
    setRestarting(false);
    toast.error(swt("interface.m1593"));
  }, [swLocale]);

  // Subscribe to update progress directly; Next /api rewrites buffer SSE events.
  const openStream = React.useCallback(
    (fromVersion: string) => {
      const es = new EventSource(sseUrl("/sable/api/update/stream"));
      updateStream.current = es;
      updateFrom.current = fromVersion;
      es.onmessage = (ev) => {
        let p: UpdateProgress;
        try {
          p = JSON.parse(ev.data) as UpdateProgress;
        } catch {
          return;
        }
        setProgress(p);
        if (p.phase === "failed") {
          es.close();
          setBusy(false);
          toast.error(swt("interface.m0352") + (p.error || p.message));
          return;
        }
        if (p.phase === "staged") {
          es.close();
          void waitForNewVersion(fromVersion);
        }
      };
      es.onerror = () => {
        // SSE necessarily disconnects when the process exits. During restart wait this is expected;
        // let /api/health polling determine completion.
        es.close();
      };
      return es;
    },
    [swLocale, waitForNewVersion],
  );

  React.useEffect(() => {
    const previous = updateStream.current;
    if (!previous || previous.readyState === EventSource.CLOSED || !updateFrom.current) return;
    previous.close();
    openStream(updateFrom.current);
  }, [swLocale, openStream]);
  React.useEffect(() => () => updateStream.current?.close(), []);

  const doUpdate = () => {
    if (!info || info.local_llm_only) return;
    const from = info.current;
    const ok = window.confirm(
      swt("interface.m1594", { p0: info.latest }) +
        swt("interface.m1595") +
        (info.mode === "docker"
          ? swt("interface.m1596") +
            swt("interface.m1597")
          : ""),
    );
    if (!ok) return;

    setBusy(true);
    setProgress({ phase: "downloading", percent: 0, message: swt("interface.m1598") });
    const es = openStream(from);
    api.applyUpdate().catch((e) => {
      es.close();
      updateStream.current?.close();
      setBusy(false);
      setProgress(null);
      toast.error(swt("interface.m1599") + (e as Error).message);
    });
  };

  const doRollback = () => {
    if (!info) return;
    if (
      !window.confirm(
        swt("interface.m1600"),
      )
    )
      return;
    const from = info.current;
    setBusy(true);
    api
      .rollbackUpdate()
      .then(() => {
        toast.success(swt("interface.m1601"));
        void waitForNewVersion(from);
      })
      .catch((e) => {
        setBusy(false);
        toast.error(swt("interface.m1602") + (e as Error).message);
      });
  };

  const phase = progress?.phase;
  const showProgress = busy || restarting;
  // Only downloading has a real percentage from Content-Length. Verification, extraction, and restart
  // have unknown durations; use a full pulsing bar to indicate indeterminate activity.
  const downloading = !restarting && phase === "downloading";
  const pct = downloading ? Math.max(progress?.percent ?? 0, 0) : 100;

  return (
    // Settings uses a multicolumn masonry layout; cards provide spacing and avoid column breaks.
    <Card className="mb-4 break-inside-avoid md:mb-6">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <DownloadIcon className="size-4" />
          {swt("interface.m1603")}</CardTitle>
        <CardDescription>{swt("interface.m1604")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted-foreground">{swt("interface.m1605")}</span>
          <Badge variant="secondary" className="font-mono">
            {info?.current ?? "…"}
          </Badge>
          {info && (
            <>
              <Badge variant="outline" className="font-mono">
                {info.os}/{info.arch}
              </Badge>
              <Badge variant="outline">{info.mode === "docker" ? "Docker" : swt("interface.m1606")}</Badge>
            </>
          )}
          {info?.latest && (
            <>
              <span className="text-muted-foreground">{swt("interface.m1607")}</span>
              <Badge variant={info.has_update ? "default" : "secondary"} className="font-mono">
                {info.latest}
              </Badge>
            </>
          )}
          {info?.html_url && (
            <a
              href={info.html_url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-xs text-muted-foreground underline-offset-4 hover:underline"
            >
              {swt("interface.m1608")}<ExternalLinkIcon className="size-3" />
            </a>
          )}
        </div>

        {info?.boot_notice && (
          <p className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-700 dark:text-amber-400">
            <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
            {info.boot_notice}
          </p>
        )}

        {info?.local_llm_only && (
          <p role="status" className="flex items-start gap-2 rounded-md border bg-muted/40 p-2 text-xs text-muted-foreground">
            <ShieldCheckIcon className="mt-0.5 size-3.5 shrink-0" />
            {swt("settings.updateLocalOnly")}</p>
        )}

        {info?.error && !info.local_llm_only && (
          <p className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
            <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
            {swt("interface.m1609")}{info.error}
            {"　"}{swt("interface.m1610")}</p>
        )}

        {info && !info.comparable && info.reason && <p className="text-xs text-muted-foreground">{info.reason}</p>}

        {info?.has_update && info.asset_available === false && (
          <p className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
            <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
            {info.latest} {swt("interface.m1611")}{" "}{info.os}/{info.arch} {swt("interface.m1612")}{" "}{info.asset}{swt("interface.m1613")}</p>
        )}

        {info?.has_update && info.asset_available !== false && (
          <p className="text-xs text-muted-foreground">
            {swt("interface.m1614")}<span className="font-mono">{info.asset}</span>
            {info.size ? `（${humanSize(info.size)}）` : ""}{swt("interface.m1615")}</p>
        )}

        {info && !info.has_update && info.comparable && !info.error && (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <CheckCircle2Icon className="size-3.5 text-emerald-600" />
            {swt("interface.m1616")}</p>
        )}

        {info?.mode === "docker" && info.has_update && (
          <p className="text-xs text-muted-foreground">
            {swt("interface.m1617")}<span className="font-mono"> docker compose up -d </span>
            {swt("interface.m1618")}<span className="font-mono"> docker compose pull artex &amp;&amp; docker compose up -d artex</span>。
          </p>
        )}

        {showProgress && (
          <div className="space-y-1.5">
            <Progress value={pct} className={downloading ? undefined : "animate-pulse"} />
            <p className="text-xs text-muted-foreground">
              {restarting ? swt("interface.m1619") : progress?.message}
            </p>
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => check(false)} disabled={checking || busy || restarting}>
            <RefreshCwIcon className={checking ? "size-4 animate-spin" : "size-4"} />
            {swt("interface.m1620")}</Button>
          <Button
            size="sm"
            onClick={doUpdate}
            disabled={busy || restarting || info?.local_llm_only || !info?.has_update || info?.asset_available === false}
          >
            <DownloadIcon className="size-4" />
            {info?.has_update ? swt("interface.m1621", { p0: info.latest }) : swt("interface.m1622")}
          </Button>
          {info?.has_backup && (
            <Button variant="ghost" size="sm" onClick={doRollback} disabled={busy || restarting}>
              <RotateCcwIcon className="size-4" />
              {swt("interface.m1623")}</Button>
          )}
        </div>

        <p className="text-xs text-muted-foreground">
          {rich("settings.updateLauncher", {}, { code: (text) => <code className="font-mono">{text}</code> })}</p>
      </CardContent>
    </Card>
  );
}
