// Evidence screenshot capture.
//
// Usage:
//   node shot.js <url> <out.png> [--wait ms] [--full] [--cookie "name=value"] [--cookie "..."] [--json]
//
// Why puppeteer instead of `chrome --screenshot`:
//   - cookies: an authenticated 越权 view cannot be captured by a bare headless run
//   - dialogs: an XSS alert blocks the renderer, so the plain CLI screenshot stalls or
//     returns an empty file. We listen for the dialog, record its message (that string
//     is the actual proof), dismiss it, then capture the injected page.
//
// Output (stdout, last line): JSON {ok, path, status, title, dialog, error}
// Everything is a real observation of the live page; nothing is synthesised.
const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer-core");

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
function argAll(name) {
  const out = [];
  process.argv.forEach((v, i) => {
    if (v === name && process.argv[i + 1]) out.push(process.argv[i + 1]);
  });
  return out;
}

const url = process.argv[2];
const out = process.argv[3];
if (!url || !out) {
  console.log(JSON.stringify({ ok: false, error: "usage: node shot.js <url> <out.png>" }));
  process.exit(2);
}

const waitMs = parseInt(arg("--wait", "2500"), 10);
const full = process.argv.includes("--full");
const cookies = argAll("--cookie");

(async () => {
  const result = { ok: false, path: out, status: 0, title: "", dialog: null, error: "" };
  let browser;
  try {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    browser = await puppeteer.launch({
      executablePath: "/usr/bin/google-chrome",
      headless: "new",
      args: [
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--hide-scrollbars",
        "--window-size=1280,900",
      ],
      protocolTimeout: 45000,
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });

    if (cookies.length) {
      const parsed = cookies.map((c) => {
        const i = c.indexOf("=");
        return { name: c.slice(0, i), value: c.slice(i + 1), domain: new URL(url).hostname, path: "/" };
      });
      await page.setCookie(...parsed);
    }

    // An XSS payload can fire more than one dialog; keep the first message, then stop
    // blocking the renderer so the screenshot is not taken on a stalled page.
    page.on("dialog", async (d) => {
      if (result.dialog === null) result.dialog = `${d.type()}: ${d.message()}`;
      try { await d.dismiss(); } catch (_) {}
    });

    const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25000 });
    result.status = resp ? resp.status() : 0;
    await new Promise((r) => setTimeout(r, waitMs));
    try { result.title = (await page.title()).slice(0, 200); } catch (_) {}

    await page.screenshot({ path: out, fullPage: full });
    result.ok = fs.existsSync(out) && fs.statSync(out).size > 1024;
    if (!result.ok) result.error = "screenshot empty (<1KB), page likely a download or blank";
  } catch (e) {
    result.error = String(e && e.message ? e.message : e).slice(0, 300);
  } finally {
    if (browser) { try { await browser.close(); } catch (_) {} }
  }
  console.log(JSON.stringify(result));
  process.exit(result.ok ? 0 : 1);
})();
