// Screenshot einer Ein-/Ausstieg-Analyse plus Textauszug der Ergebnisse (Dev-Server muss laufen).
// Aufruf: node tests/e2e/screenshot.cjs <Name> '[lon,lat Einstieg]' '[lon,lat Ausstieg]' '[lon,lat Kartenmitte]' <Zoom> <datei.png>
// Beispiel Sanna: node tests/e2e/screenshot.cjs Sanna '[10.4910,47.1176]' '[10.5630,47.1436]' '[10.527,47.13]' 13.3 tests/e2e/out/sanna.png
// Zoom so wählen, dass beide Punkte im Kartenausschnitt liegen (sonst gehen die Klicks ins Leere).
// Optional SHOT=flow: nur die Abfluss-Tabelle aufnehmen.
// Optional TIROL_DIR=<ordner mit tirol.json und tirol-archiv/>: Tirol-Spiegel aus lokalen Dateien
// (z. B. frisch erzeugt mit scripts/tirol-mirror.mjs), bevor die Action den Branch aktualisiert hat.
const { chromium } = require('playwright');
(async () => {
  const [name, a, b, center, zoom, out] = [process.argv[2], JSON.parse(process.argv[3]), JSON.parse(process.argv[4]), JSON.parse(process.argv[5]), Number(process.argv[6]), process.argv[7]];
  const proxy = process.env.HTTPS_PROXY;
  const browser = await chromium.launch({ proxy: proxy ? { server: proxy, bypass: 'localhost,127.0.0.1' } : undefined, args: ['--ignore-certificate-errors'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1900 }, deviceScaleFactor: 2 });
  if (process.env.TIROL_DIR) await page.route(/raw\.githubusercontent\.com\/zowallawilli\/App-Design-\/pegeldaten\/(.*)$/, (r) => {
    const f = require('path').join(process.env.TIROL_DIR, new URL(r.request().url()).pathname.split('/pegeldaten/')[1]);
    return require('fs').existsSync(f) ? r.fulfill({ path: f, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' } }) : r.fulfill({ status: 404, body: '' });
  });
  // Optional WEATHER_FILE=<json>: Antwort für archive-api.open-meteo.com (z. B. bei erreichtem Tageslimit)
  if (process.env.WEATHER_FILE) await page.route(/archive-api\.open-meteo\.com/, (r) => r.fulfill({ path: process.env.WEATHER_FILE, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' } }));
  page.on('pageerror', e => console.log('pageerror', e.message)); page.on('console', m => m.type() === 'error' && console.log('console', m.text().slice(0, 200)));
  await page.goto('http://localhost:5173/');
  await page.waitForFunction(() => window.__map && window.__map.loaded());
  await page.evaluate(([c, z]) => window.__map.jumpTo({ center: c, zoom: z }), [center, zoom]); await page.waitForTimeout(1500);
  const box = await page.locator('#map canvas').boundingBox();
  const click = async (ll) => { const pt = await page.evaluate((ll) => window.__map.project(ll), ll); await page.mouse.click(box.x + pt.x, box.y + pt.y); await page.waitForTimeout(450); };
  const t0 = Date.now();
  await page.click('[data-mode="route"]'); await click(a); await click(b);
  await page.waitForTimeout(500);
  await page.waitForFunction(() => !document.body.classList.contains('busy'), null, { timeout: 300000 });
  await page.waitForFunction(() => !/Wird geladen/.test(document.querySelector('#flow-info').textContent), null, { timeout: 120000 }).catch(() => {});
  await page.waitForTimeout(4000);
  console.log(`== ${name} (${((Date.now() - t0) / 1000).toFixed(0)} s) Status: ${await page.textContent('#status')}`);
  const t = async (sel) => (await page.textContent(sel)).replace(/\s+/g, ' ').trim();
  console.log('STATS', await t('#stats'));
  console.log('RATE', await t('#rate-note'));
  console.log('KLASSEN', (await t('#classes')).slice(0, 500));
  console.log('FLOW', (await t('#flow-info')).slice(0, 1500));
  console.log('NARROWS', (await t('#narrows-list')).slice(0, 300));
  console.log('STUFEN', (await t('#steps-list')).slice(0, 400));
  console.log('HOTSPOTS', (await t('#hotspots')).slice(0, 300));
  // Panel so scrollen, dass Kennzahlen + Schwierigkeit oben stehen
  await page.evaluate(() => document.querySelector('#res-title').scrollIntoView());
  await page.waitForTimeout(500);
  // SHOT=flow: nur die Abfluss-Tabelle (#flow-info) aufnehmen
  if (process.env.SHOT === 'flow') await page.locator('#flow-info').screenshot({ path: out });
  else await page.screenshot({ path: out });
  await browser.close();
})();
