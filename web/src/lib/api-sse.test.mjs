import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { __resetLocaleForTests, localizedUrl, setLocale, translate } from "../i18n/runtime.ts";

// Load the real client while isolating its mock-data imports and browser globals.
const source = fs.readFileSync(new URL("./api.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
});
function client(env = {}, token = null, browser = true) {
  const exports = {};
  const context = {
    exports,
    process: { env },
    localStorage: { getItem: () => token },
    require(id) {
      if (id === "@/i18n/runtime") return { localizedUrl, translate };
      if (id === "@/i18n/request") return { localizedFetch: fetch };
      if (id === "@/lib/mock/enabled") return { MOCK: false };
      if (id === "@/lib/mock/handler") return { mockHandle() { throw new Error("Unexpected mock request"); } };
      throw new Error(`Unexpected import: ${id}`);
    },
  };
  if (browser) context.window = { location: { protocol: "https:", hostname: "scope.example", port: "8797" } };
  vm.runInNewContext(outputText, context);
  return exports;
}

test("production SSE stays on the UI origin and preserves authentication and locale", () => {
  __resetLocaleForTests();
  setLocale("ko");
  try {
    const { sseUrl } = client({ NODE_ENV: "production" }, "a+b/= token");
    assert.equal(sseUrl("/api/activity?task=42"), "/api/activity?task=42&token=a%2Bb%2F%3D%20token&lang=ko");
    const url = new URL(sseUrl("/api/activity"), "https://scope.example:8797");
    assert.equal(url.origin, "https://scope.example:8797");
  } finally { __resetLocaleForTests(); }
});

test("development SSE bypasses the buffering Next.js proxy", () => {
  __resetLocaleForTests();
  assert.equal(client({ NODE_ENV: "development" }).sseUrl("/api/activity"), "https://scope.example:8787/api/activity?lang=en");
});

test("explicit SSE overrides include an empty same-origin base", () => {
  __resetLocaleForTests();
  for (const [base, expected] of [["", "/api/activity?lang=en"], ["https://events.example", "https://events.example/api/activity?lang=en"]]) {
    assert.equal(client({ NODE_ENV: "development", NEXT_PUBLIC_SSE_BASE: base }).sseUrl("/api/activity"), expected);
  }
  assert.equal(client({ NODE_ENV: "production" }, null, false).sseUrl("/api/activity"), "/api/activity?lang=en");
});

test("Chinese SSE keeps same-origin auth, cursor and explicit language overrides", () => {
  __resetLocaleForTests();
  setLocale("zh-Hans");
  try {
    const { sseUrl } = client({ NODE_ENV: "production" }, "a+b/= token");
    assert.equal(sseUrl("/api/logs/stream?since=7"), "/api/logs/stream?since=7&token=a%2Bb%2F%3D%20token&lang=zh-Hans");
    const override = new URL(sseUrl("/api/logs/stream?since=7&lang=ko"), "https://scope.example:8797");
    assert.equal(override.origin, "https://scope.example:8797");
    assert.equal(override.searchParams.get("since"), "7");
    assert.equal(override.searchParams.get("lang"), "ko");
    assert.equal(override.searchParams.get("token"), "a+b/= token");
  } finally { __resetLocaleForTests(); }
});
