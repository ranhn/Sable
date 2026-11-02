import assert from "node:assert/strict";
import fs from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";

// Resolve the same aliases as Next.js while loading the real TypeScript mock client.
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    const url = specifier.startsWith("@/")
      ? new URL(`../${specifier.slice(2)}`, import.meta.url)
      : specifier.startsWith(".") ? new URL(specifier, context.parentURL) : null;
    if (url && !/\.[a-z]+$/i.test(url.pathname)) {
      for (const suffix of [".ts", "/index.ts"]) {
        const candidate = new URL(url.href + suffix);
        if (fs.existsSync(candidate)) return nextResolve(candidate.href, context);
      }
    }
    return nextResolve(specifier, context);
  },
});
const { mockHandle } = await import("./mock/handler.ts");
hooks.deregister();

test("demo approval usage supplies a complete zero-total response and daily array", async () => {
  const usage = await mockHandle("GET", "/intercept/judge/usage?days=30&lang=ko");
  assert.deepEqual(usage, { calls: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, reasoning_tokens: 0, daily: [] });
});
