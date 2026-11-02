"use client";
import { useI18n } from "@/i18n";

import * as React from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

// Tailwind-styled element overrides (no typography plugin in this project, so we
// style each element). `node` is stripped — it's not a valid DOM attribute.
const components: Components = {
  h1: ({ node, ...p }) => <div className="mt-2.5 text-base font-semibold" {...p} />,
  h2: ({ node, ...p }) => <div className="mt-2 text-sm font-semibold" {...p} />,
  h3: ({ node, ...p }) => <div className="mt-1.5 text-sm font-medium text-foreground/90" {...p} />,
  h4: ({ node, ...p }) => <div className="mt-1.5 text-sm font-medium text-foreground/90" {...p} />,
  p: ({ node, ...p }) => <p className="leading-relaxed" {...p} />,
  ul: ({ node, ...p }) => <ul className="my-1 list-disc space-y-0.5 pl-5" {...p} />,
  ol: ({ node, ...p }) => <ol className="my-1 list-decimal space-y-0.5 pl-5" {...p} />,
  strong: ({ node, ...p }) => <strong className="font-semibold" {...p} />,
  a: ({ node, ...p }) => (
    <a className="text-primary underline underline-offset-2" target="_blank" rel="noreferrer" {...p} />
  ),
  hr: () => <hr className="my-2 border-border" />,
  blockquote: ({ node, ...p }) => (
    <blockquote className="my-1 border-l-2 border-border pl-2.5 text-muted-foreground" {...p} />
  ),
  pre: ({ node, ...p }) => (
    <pre className="my-1.5 overflow-auto rounded-md bg-muted/70 p-2.5 text-xs leading-relaxed" {...p} />
  ),
  code: ({ node, className, children, ...rest }) => {
    const block = /language-/.test(className || "");
    return block ? (
      <code className={"font-mono text-xs " + (className || "")} {...rest}>
        {children}
      </code>
    ) : (
      <code className="break-all rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]" {...rest}>
        {children}
      </code>
    );
  },
  table: ({ node, ...p }) => (
    // w-auto + min-w-full: the table sizes to its content instead of stretching to the
    // container, so a short label column is not squeezed into one-character-per-line.
    // The first column is a label ("漏洞编号", "目标资产"…), so it never wraps; long
    // values in the second column still wrap, and the wrapper scrolls if needed.
    <div className="my-1.5 overflow-x-auto">
      <table
        className="w-auto min-w-full border-collapse text-xs [&_tr>td:first-child]:sticky [&_tr>td:first-child]:left-0 [&_tr>td:first-child]:z-10 [&_tr>td:first-child]:bg-background [&_tr>td:first-child]:min-w-[6.5rem] [&_tr>td:first-child]:whitespace-nowrap [&_tr>td:first-child]:font-medium [&_tr>td:first-child]:align-top [&_tr>td:first-child]:text-muted-foreground"
        {...p}
      />
    </div>
  ),
  th: ({ node, ...p }) => (
    <th className="border border-border bg-muted/60 px-2 py-1 text-left font-medium whitespace-nowrap" {...p} />
  ),
  td: ({ node, ...p }) => <td className="border border-border px-2 py-1 align-top" {...p} />,
  img: ({ node, ...p }) => (
    <a
      href={typeof p.src === "string" ? p.src : undefined}
      target="_blank"
      rel="noreferrer"
      className="my-1.5 inline-block"
    >
      <img className="max-h-80 w-auto max-w-full rounded-md border border-border" loading="lazy" {...p} />
    </a>
  ),
};

export function Markdown({ text }: { text: string }) {
  "use no memo";
  const { locale: swLocale } = useI18n();

  return (
    <div className="min-w-0 space-y-1.5 text-sm [&>*:first-child]:mt-0">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
