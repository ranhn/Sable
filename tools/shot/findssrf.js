const puppeteer = require('puppeteer-core');

(async () => {
  const token = process.env.TOK;
  const browser = await puppeteer.launch({
    executablePath: '/usr/bin/google-chrome',
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--window-size=1600,1000'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000 });
  await page.setCookie({ name: 'artex_token', value: token, domain: '127.0.0.1', path: '/ning' });
  await page.setCookie({ name: 'token', value: token, domain: '127.0.0.1', path: '/ning' });

  await page.goto('http://127.0.0.1/ning/function/findings', { waitUntil: 'networkidle2', timeout: 45000 });
  await new Promise(r => setTimeout(r, 2500));

  // type into the search box
  const box = await page.$('input[placeholder]');
  if (box) {
    await box.click();
    await box.type('SSRF', { delay: 60 });
    await new Promise(r => setTimeout(r, 3000));
  }
  const url = page.url();
  const bodyText = await page.evaluate(() => document.body.innerText);
  const hit = bodyText.includes('SSRF') || bodyText.includes('levoit');
  const rows = await page.evaluate(() => {
    const t = document.body.innerText.split('\n').filter(l => l.trim());
    const i = t.findIndex(l => l.includes('SSRF') || l.includes('ucp/mcp'));
    return i >= 0 ? t.slice(Math.max(0, i - 4), i + 8) : null;
  });
  console.log(JSON.stringify({ url, searched: !!box, found: hit, context: rows }, null, 2));

  await page.screenshot({ path: '/opt/sable/data/shots/_demo/findings-ssrf.png' });
  await browser.close();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
