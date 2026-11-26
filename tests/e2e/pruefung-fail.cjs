// Fehlerfälle und Grenzen (Teil von pruefung.cjs: node tests/e2e/pruefung.cjs fail)
const path = require('path');
const { open, txt, waitIdle, view, clickLL, summary, OUT } = require('./pruefung.cjs');

const BLOCK = {
  overpass: /overpass/,
  openfreemap: /tiles\.openfreemap\.org/,
  sentinelStac: /earth-search\.aws\.element84\.com/,
  openMeteo: /open-meteo\.com/,
  pegelArso: /arso\.gov\.si/,
  esriMetadaten: /metadata\.maptiles\.arcgis\.com|MapServer\/(identify|query)/,
  terrarium: /elevation-tiles-prod|s3\.amazonaws\.com\/elevation/,
  orthofotoGurs: /gurs|prostor|e-prostor/,
  allesExtern: /^https?:\/\/(?!localhost)/,
};

// Open-Meteo zählt Anfragen gewichtet: je Ort 1 Aufruf, Zeitraum > 14 Tage bzw. > 10 Variablen zählen mehrfach
function meteoWeight(url) {
  const u = new URL(url); const q = u.searchParams;
  const n = (q.get('latitude') || '').split(',').length;
  let days = 14;
  if (q.get('start_date') && q.get('end_date')) days = (new Date(q.get('end_date')) - new Date(q.get('start_date'))) / 864e5 + 1;
  else if (q.get('past_days')) days = Number(q.get('past_days')) + Number(q.get('forecast_days') || 7);
  const vars = ((q.get('daily') || '').split(',').filter(Boolean).length + (q.get('hourly') || '').split(',').filter(Boolean).length) || 1;
  return n * Math.max(1, days / 14) * Math.max(1, vars / 10);
}

async function koritnica(page) {
  const t0 = Date.now();
  await page.selectOption('#preset', 'koritnica'); await page.click('#load-preset');
  await waitIdle(page, 240000).catch(() => {});
  return { s: Math.round((Date.now() - t0) / 1000), ...(await summary(page)) };
}

async function run(browser) {
  const out = { blockiert: {}, grenzen: {}, meteo: null };
  // Anfragen an Open-Meteo zählen (eine Analyse Sanna)
  {
    const { ctx, page } = await open(browser);
    const reqs = [];
    page.on('request', (r) => { if (/open-meteo\.com/.test(r.url())) reqs.push(r.url()); });
    await view(page, [10.527, 47.13], 13); await page.click('[data-mode="route"]');
    await clickLL(page, [10.4910, 47.1176]); await clickLL(page, [10.5630, 47.1436]); await waitIdle(page);
    out.meteo = { anfragen: reqs.length, gewichtet: Math.round(reqs.reduce((a, u) => a + meteoWeight(u), 0)), einzeln: reqs.map((u) => `${Math.round(meteoWeight(u))} ← ${u.slice(0, 170)}`) };
    console.log('Open-Meteo', JSON.stringify(out.meteo).slice(0, 400));
    await ctx.close();
  }
  for (const [k, rx] of Object.entries(BLOCK)) {
    const { ctx, page, log } = await open(browser, { block: [rx] }).catch(async (e) => ({ ctx: null, page: null, log: null, err: e }));
    if (!page) { out.blockiert[k] = 'Seite lädt nicht'; continue; }
    const r = await koritnica(page).catch((e) => ({ fehler: String(e).slice(0, 200) }));
    r.bedienbar = await page.isEnabled('#load-preset').catch(() => false);
    r.pageerror = log.pageerror.slice(0, 5);
    await page.screenshot({ path: path.join(OUT, `40-blockiert-${k}.png`) });
    out.blockiert[k] = r; console.log('block', k, r.s, r.status, (r.stats || '').slice(0, 80), (r.flow || '').slice(0, 120));
    await ctx.close();
  }
  // Grenzfälle mit Ein-/Ausstieg
  const cases = [
    ['kurz-150m', [10.5280, 47.1290], [10.5298, 47.1296], [10.529, 47.1293], 16],
    ['neben-fluss-500m', [10.5000, 47.1250], [10.5500, 47.1500], [10.525, 47.137], 13],
    ['see-achensee', [11.7050, 47.4300], [11.7150, 47.4700], [11.71, 47.45], 12],
    ['meer-adria', [13.3000, 45.5000], [13.4000, 45.5500], [13.35, 45.525], 11],
    ['grenze-inn-kufstein', [12.1700, 47.5850], [12.1560, 47.6560], [12.163, 47.62], 12],
    ['vertauscht-sanna', [10.5630, 47.1436], [10.4910, 47.1176], [10.527, 47.13], 13],
  ];
  for (const [k, a, b, c, z] of cases) {
    const { ctx, page, log } = await open(browser);
    await view(page, c, z); await page.click('[data-mode="route"]');
    const t0 = Date.now(); await clickLL(page, a); await clickLL(page, b); await waitIdle(page).catch(() => {});
    const r = { s: Math.round((Date.now() - t0) / 1000), ...(await summary(page)), pageerror: log.pageerror.slice(0, 5) };
    await page.screenshot({ path: path.join(OUT, `41-grenze-${k}.png`) });
    out.grenzen[k] = r; console.log('grenze', k, r.s, r.status, r.stats.slice(0, 120));
    await ctx.close();
  }
  // Schnelles Mehrfachklicken + Fenstergröße während der Analyse
  {
    const { ctx, page, log } = await open(browser);
    await view(page, [10.527, 47.13], 13); await page.click('[data-mode="route"]');
    for (const ll of [[10.4910, 47.1176], [10.5630, 47.1436], [10.52, 47.13], [10.50, 47.12], [10.54, 47.14]]) await clickLL(page, ll).catch(() => {});
    await page.setViewportSize({ width: 800, height: 600 }); await page.waitForTimeout(1500); await page.setViewportSize({ width: 1440, height: 900 });
    await waitIdle(page).catch(() => {});
    out.grenzen.mehrfachklick = { ...(await summary(page)), pageerror: log.pageerror, marker: await page.locator('.maplibregl-marker').count() };
    await page.screenshot({ path: path.join(OUT, '42-mehrfachklick.png') });
    await ctx.close();
  }
  // localStorage gesperrt
  {
    const { ctx, page, log } = await open(browser, { noStorage: true }).catch((e) => ({ err: String(e) }));
    if (!page) out.grenzen.ohneSpeicher = { fehler: 'Seite lädt nicht', log };
    else {
      const r = await koritnica(page);
      out.grenzen.ohneSpeicher = { ...r, pageerror: log.pageerror.slice(0, 5), console: log.console.filter((x) => /error/.test(x)).slice(0, 5) };
      await page.screenshot({ path: path.join(OUT, '43-ohne-localstorage.png') });
      await ctx.close();
    }
  }
  return out;
}
module.exports = { run, meteoWeight };
