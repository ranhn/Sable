// Evidence screenshot capture.
//
// Usage:
//   node shot.js <url> <out.png> [--wait ms] [--full] [--cookie "name=value"]
//                [--form "k=v&k2=v2"] [--header "k: v"]
//
// Why puppeteer instead of `chrome --screenshot`:
//   - cookies: an authenticated 越权 view cannot be captured by a bare headless run
//   - dialogs: an XSS alert blocks the renderer, so the plain CLI screenshot stalls or
//     returns an empty file. We listen for the dialog, record its message (that string
//     is the actual proof), dismiss it, then capture the injected page.
//   - POST: a reflected XSS that only fires on a form submission cannot be reached by
//     navigating to a URL. --form makes the page submit a real form to the target and
//     then photograph whatever comes back, so the injected response is what gets saved.
//
// Output (stdout, last line): JSON {ok, path, status, title, dialog, error}
// Everything is a real observation of the live page; nothing is synthesised.
const fs = require("fs");
const os = require("os");
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
function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
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
const formBody = arg("--form", "");
const headers = argAll("--header");

(async () => {
  const result = { ok: false, path: out, status: 0, title: "", dialog: null, error: "" };
  let browser;
  let tmpForm = "";
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

    if (headers.length) {
      const h = {};
      for (const raw of headers) {
        const i = raw.indexOf(":");
        if (i > 0) h[raw.slice(0, i).trim()] = raw.slice(i + 1).trim();
      }
      await page.setExtraHTTPHeaders(h);
    }

    // An XSS payload can fire more than one dialog; keep the first message, then stop
    // blocking the renderer so the screenshot is not taken on a stalled page.
    page.on("dialog", async (d) => {
      if (result.dialog === null) result.dialog = `${d.type()}: ${d.message()}`;
      try { await d.dismiss(); } catch (_) {}
    });

    // Track the status of the last real navigation: with --form the first goto is a
    // local file, and the target status arrives on the follow-up request.
    let navStatus = 0;
    page.on("response", (r) => {
      try {
        if (r.request().isNavigationRequest() && /^https?:/i.test(r.url())) navStatus = r.status();
      } catch (_) {}
    });

    if (formBody) {
      // Build a tiny local page that immediately submits a real form to the target.
      // Using a file page (not setContent) keeps Chrome's normal form navigation, so
      // the response is rendered and any injected script actually executes.
      const fields = [...new URLSearchParams(formBody)].map(
        ([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`,
      );
      tmpForm = path.join(os.tmpdir(), `shot-post-${Date.now()}-${Math.floor(Math.random() * 1e6)}.html`);
      fs.writeFileSync(
        tmpForm,
        `<!doctype html><html><body onload="document.f.submit()">` +
          `<form name="f" method="POST" action="${esc(url)}" ` +
          `enctype="application/x-www-form-urlencoded">${fields.join("")}</form>` +
          `</body></html>`,
      );
      await page.goto("file://" + tmpForm, { waitUntil: "domcontentloaded", timeout: 25000 });
      await new Promise((r) => setTimeout(r, waitMs));
      result.status = navStatus;
    } else {
      const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25000 });
      result.status = resp ? resp.status() : navStatus;
      await new Promise((r) => setTimeout(r, waitMs));
    }

    try { result.title = (await page.title()).slice(0, 200); } catch (_) {}

    await page.screenshot({ path: out, fullPage: full });
    result.ok = fs.existsSync(out) && fs.statSync(out).size > 1024;
    if (!result.ok) result.error = "screenshot empty (<1KB), page likely a download or blank";
  } catch (e) {
    result.error = String(e && e.message ? e.message : e).slice(0, 300);
  } finally {
    if (tmpForm) { try { fs.unlinkSync(tmpForm); } catch (_) {} }
    if (browser) { try { await browser.close(); } catch (_) {} }
  }
  console.log(JSON.stringify(result));
  process.exit(result.ok ? 0 : 1);
})();
