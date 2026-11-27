// Prüfskript für den Prüfbericht (Dev-Server muss laufen: npx vite --port 5173 &).
// Aufruf: node tests/e2e/pruefung.cjs <phase> [weitere Phasen …]
//   ref     Referenzstrecken (Ein-/Ausstieg bzw. Auswahlfeld), Dauer, Pegel, Stellen, Screenshots
//   presets alle Einträge im Auswahlfeld (nur Kennzahlen + Dauer)
//   ui      Grundfunktionen Desktop · mobile  Grundfunktionen Handy 390×844
//   fail    Quellen blockiert / Grenzfälle · export  GPX/CSV/GeoJSON prüfen
// Ausgabe: tests/e2e/out/pruefung/<nr>-<name>.png und pruefung-<phase>.json (Konsolenfehler, Netzfehler, Anfragen je Host)
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const OUT = path.join(__dirname, 'out', 'pruefung');
fs.mkdirSync(OUT, { recursive: true });
const BASE = process.env.BASE || 'http://localhost:5173/';

async function open(browser, opts = {}) {
  const ctx = await browser.newContext({ viewport: opts.viewport || { width: 1440, height: 900 }, deviceScaleFactor: 2, acceptDownloads: true, isMobile: !!opts.mobile, hasTouch: !!opts.mobile });
  if (opts.noStorage) await ctx.addInitScript(() => { Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('gesperrt', 'SecurityError'); } }); });
  const page = await ctx.newPage();
  const log = { console: [], pageerror: [], failed: [], http: [], hosts: {} };
  page.on('pageerror', (e) => log.pageerror.push(e.message.slice(0, 300)));
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') log.console.push(`${m.type()}: ${m.text().slice(0, 250)}`); });
  page.on('request', (r) => { try { const h = new URL(r.url()).host; log.hosts[h] = (log.hosts[h] || 0) + 1; } catch {} });
  page.on('requestfailed', (r) => { try { log.failed.push(`${new URL(r.url()).host} ${r.failure()?.errorText} ${r.url().slice(0, 160)}`); } catch {} });
  page.on('response', (r) => { if (r.status() >= 400) try { log.http.push(`${r.status()} ${new URL(r.url()).host} ${r.url().slice(0, 160)}`); } catch {} });
  if (opts.block) for (const rx of opts.block) await page.route(rx, (r) => r.abort());
  await page.goto(BASE);
  await page.waitForFunction(() => window.__map && window.__map.loaded(), null, { timeout: 60000 });
  return { ctx, page, log };
}
const txt = async (page, sel) => ((await page.textContent(sel).catch(() => '')) || '').replace(/\s+/g, ' ').trim();
const busy = (page) => page.evaluate(() => document.body.classList.contains('busy'));
async function waitIdle(page, ms = 300000) {
  await page.waitForTimeout(400);
  await page.waitForFunction(() => !document.body.classList.contains('busy'), null, { timeout: ms });
  await page.waitForFunction(() => !/Wird geladen/.test(document.querySelector('#flow-info')?.textContent || ''), null, { timeout: 90000 }).catch(() => {});
  await page.waitForTimeout(1500);
}
async function view(page, c, z) {
  await page.evaluate(([c, z]) => new Promise((res) => { window.__map.jumpTo({ center: c, zoom: z }); window.__map.once('idle', res); setTimeout(res, 4000); }), [c, z]);
}
async function clickLL(page, ll) {
  const pt = await page.evaluate((ll) => window.__map.project(ll), ll);
  const box = await page.locator('#map canvas').boundingBox();
  await page.mouse.click(box.x + pt.x, box.y + pt.y);
  await page.waitForTimeout(450);
}
async function summary(page) {
  return {
    title: await txt(page, '#res-title'),
    stats: await txt(page, '#stats'),
    more: await txt(page, '#stats-more'),
    status: await txt(page, '#status'),
    rate: await txt(page, '#rate-note'),
    flow: (await txt(page, '#flow-info')).slice(0, 1400),
    hz: (await txt(page, '#hz-list')).slice(0, 700),
    ww: (await txt(page, '#ww-list')).slice(0, 700),
    wwMeta: (await txt(page, '#ww-meta')).slice(0, 400),
    narrows: (await txt(page, '#narrows-list')).slice(0, 500),
    imgDate: await txt(page, '#img-date'),
    nWwMarker: await page.locator('.ww-marker').count(),
    nHz: await page.locator('#hz-list .ww-id').count(),
  };
}
async function shotBoth(page, nr, name) {
  await page.screenshot({ path: path.join(OUT, `${nr}-${name}-karte.png`) });
  // Ergebnisseite: Panel komplett (scrollbar) als Elementaufnahme
  const panel = page.locator('#panel');
  const h = await panel.evaluate((el) => el.scrollHeight);
  await page.setViewportSize({ width: page.viewportSize().width, height: Math.min(Math.max(900, h + 40), 5000) });
  await page.waitForTimeout(500);
  await panel.screenshot({ path: path.join(OUT, `${nr}-${name}-ergebnis.png`) });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(400);
}
async function route(page, a, b, center, zoom) {
  await view(page, center, zoom);
  const t0 = Date.now();
  await page.click('[data-mode="route"]');
  await clickLL(page, a); await clickLL(page, b);
  await waitIdle(page);
  const s = (Date.now() - t0) / 1000;
  const r = await summary(page);
  // Karte auf die Strecke zoomen (für den Screenshot)
  await page.evaluate(() => { const src = window.__map.getSource('route'); }).catch(() => {});
  return { dauer_s: Math.round(s), ...r };
}

const REF = [
  // nr, name, Einstieg, Ausstieg, Mitte, Zoom
  ['21', 'sanna', [10.4910, 47.1176], [10.5630, 47.1436], [10.527, 47.13], 13.0],
  ['22', 'inn-imst', [10.7450, 47.2164], [10.8976, 47.2642], [10.82, 47.24], 12.2],
  ['23', 'salzach-taxenbach', [12.9640, 47.2925], [13.0480, 47.2990], [13.006, 47.296], 13.0],
  ['24', 'oetz', [10.9111, 47.1610], [10.8930, 47.2050], [10.902, 47.183], 12.7],
  ['25', 'charyn', [79.1009, 43.3599], [79.1631, 43.4215], [79.132, 43.391], 12.6],
  ['26', 'nahe-kirn', [7.45800, 49.78370], [7.58760, 49.79190], [7.523, 49.788], 12.4],
  ['27', 'oulankajoki', [29.34843, 66.37048], [29.44181, 66.35307], [29.395, 66.362], 12.5],
  ['28', 'piteaelven', [20.82458, 65.77398], [20.95007, 65.74050], [20.887, 65.757], 12.0],
  ['29', 'ubaye-fr', [6.43181, 44.43255], [6.38649, 44.45314], [6.409, 44.443], 13.0],
  ['30', 'arkansas-royal-gorge-us', [-105.37331, 38.48665], [-105.23787, 38.43893], [-105.305, 38.463], 12.0],
];
const PRE = [['11', 'soca-srpenica-trnovo'], ['12', 'koritnica'], ['13', 'sjoa-amot'], ['14', 'jokulsa-dettifoss']];

async function phaseRef(browser, only) {
  const res = [];
  for (const [nr, id] of PRE) {
    if (only && !only.includes(id)) continue;
    const { ctx, page, log } = await open(browser);
    const t0 = Date.now();
    await page.selectOption('#preset', id); await page.click('#load-preset'); await waitIdle(page);
    const r = { nr, name: id, dauer_s: Math.round((Date.now() - t0) / 1000), ...(await summary(page)), log };
    await shotBoth(page, nr, id);
    res.push(r); console.log(JSON.stringify({ nr, id, dauer: r.dauer_s, stats: r.stats, status: r.status }));
    await ctx.close();
  }
  for (const [nr, name, a, b, c, z] of REF) {
    if (only && !only.includes(name)) continue;
    const { ctx, page, log } = await open(browser);
    const r = { nr, name, ...(await route(page, a, b, c, z)), log };
    await shotBoth(page, nr, name);
    res.push(r); console.log(JSON.stringify({ nr, name, dauer: r.dauer_s, stats: r.stats, status: r.status }));
    await ctx.close();
  }
  return res;
}

async function phasePresets(browser) {
  const { ctx, page, log } = await open(browser);
  const ids = await page.$$eval('#preset option', (o) => o.map((x) => [x.value, x.textContent]));
  const res = [];
  for (const [id, label] of ids) {
    const t0 = Date.now();
    await page.selectOption('#preset', id); await page.click('#load-preset'); await waitIdle(page);
    const r = { id, label, dauer_s: Math.round((Date.now() - t0) / 1000), stats: await txt(page, '#stats'), status: await txt(page, '#status'), more: await txt(page, '#stats-more'), nWw: await page.locator('#ww-list .ww-id').count(), nHz: await page.locator('#hz-list .ww-id').count() };
    res.push(r); console.log(JSON.stringify(r));
  }
  await ctx.close();
  return { res, log };
}

module.exports = { open, txt, waitIdle, view, clickLL, summary, shotBoth, route, OUT };

if (require.main === module) (async () => {
  const proxy = process.env.HTTPS_PROXY;
  const browser = await chromium.launch({ proxy: proxy ? { server: proxy, bypass: 'localhost,127.0.0.1' } : undefined, args: ['--ignore-certificate-errors'] });
  const phases = process.argv.slice(2);
  const only = process.env.ONLY ? process.env.ONLY.split(',') : null;
  for (const ph of phases) {
    const t0 = Date.now();
    let out;
    if (ph === 'ref') out = await phaseRef(browser, only);
    else if (ph === 'presets') out = await phasePresets(browser);
    else { const mod = require(`./pruefung-${ph}.cjs`); out = await mod.run(browser); }
    fs.writeFileSync(path.join(OUT, `pruefung-${ph}${only ? '-' + only.join('_') : ''}.json`), JSON.stringify(out, null, 1));
    console.log(`== Phase ${ph}: ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  }
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
