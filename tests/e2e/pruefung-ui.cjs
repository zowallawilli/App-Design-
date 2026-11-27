// Grundfunktionen Desktop 1440×900 und Handy 390×844 (Teil von pruefung.cjs: node tests/e2e/pruefung.cjs ui)
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { open, txt, waitIdle, view, clickLL, OUT } = require('./pruefung.cjs');

async function step(res, name, fn) {
  const t0 = Date.now();
  try { const info = await fn(); res.push({ name, ok: true, s: +((Date.now() - t0) / 1000).toFixed(1), info }); console.log('OK  ', name, JSON.stringify(info)?.slice(0, 300)); }
  catch (e) { res.push({ name, ok: false, s: +((Date.now() - t0) / 1000).toFixed(1), info: String(e.message || e).slice(0, 400) }); console.log('FEHL', name, String(e.message || e).slice(0, 300)); }
}
const center = (page) => page.evaluate(() => { const c = window.__map.getCenter(); return [+c.lng.toFixed(5), +c.lat.toFixed(5), +window.__map.getZoom().toFixed(2)]; });
const shot = (page, f) => page.screenshot({ path: path.join(OUT, f) });

async function desktop(browser) {
  const res = [];
  const { ctx, page, log } = await open(browser);
  const dl = async (sel) => { const [d] = await Promise.all([page.waitForEvent('download', { timeout: 15000 }), page.click(sel)]); const f = path.join(OUT, 'export', d.suggestedFilename()); fs.mkdirSync(path.dirname(f), { recursive: true }); await d.saveAs(f); return f; };

  await step(res, 'Startseite', async () => { await shot(page, '01-start-desktop.png'); return await txt(page, '#mode-help'); });
  await step(res, 'Ortssuche „Bovec“', async () => {
    await page.fill('#search', 'Bovec'); await page.click('#search-form button[type=submit]');
    await page.waitForSelector('#search-results li', { timeout: 15000 });
    const items = await page.$$eval('#search-results li', (l) => l.map((x) => x.textContent));
    await shot(page, '02-ortssuche.png');
    await page.click('#search-results li button').catch(() => {}); await page.waitForTimeout(2500);
    return { items: items.slice(0, 3), center: await center(page) };
  });
  await step(res, 'Ortssuche ohne Treffer', async () => {
    await page.fill('#search', 'xqzxqzxqz'); await page.click('#search-form button[type=submit]'); await page.waitForTimeout(3000);
    return await txt(page, '#search-results');
  });
  await step(res, 'Referenz Koritnica laden', async () => {
    const t0 = Date.now(); await page.selectOption('#preset', 'koritnica'); await page.click('#load-preset'); await waitIdle(page);
    await shot(page, '03-koritnica-desktop.png');
    return { s: (Date.now() - t0) / 1000, stats: await txt(page, '#stats') };
  });
  await step(res, 'Steilster Abschnitt: Klick springt hin', async () => {
    const before = await center(page); await page.click('#go-steepest'); await page.waitForTimeout(2500);
    return { before, after: await center(page), label: await txt(page, '#go-steepest') };
  });
  await step(res, 'Bewertung Gefälle / Wucht / eigener Abfluss', async () => {
    const out = {};
    for (const m of ['gradient', 'power', 'combined']) { await page.selectOption('#rate-mode', m); await page.waitForTimeout(600); out[m] = await txt(page, '#rate-note'); }
    out.qOptions = await page.$$eval('#q-src option', (o) => o.map((x) => `${x.value}${x.hidden ? '(versteckt)' : ''}`));
    await page.selectOption('#q-src', 'own'); await page.fill('#q-own', '25,5'); await page.press('#q-own', 'Enter'); await page.waitForTimeout(800);
    out.own = await txt(page, '#rate-note');
    await page.fill('#q-own', 'abc'); await page.press('#q-own', 'Enter'); await page.waitForTimeout(600); out.ownInvalid = await txt(page, '#rate-note');
    await page.fill('#q-own', '-5'); await page.press('#q-own', 'Enter'); await page.waitForTimeout(600); out.ownNegative = await txt(page, '#rate-note');
    await page.selectOption('#q-src', 'today'); await page.waitForTimeout(500);
    return out;
  });
  await step(res, 'Eingeklappte Bereiche öffnen', async () => {
    await page.evaluate(() => document.querySelectorAll('#results details').forEach((d) => (d.open = true)));
    const cb = page.locator('#show-catch'); let catchInfo = 'kein Häkchen';
    if (await cb.count()) { await cb.check(); await page.waitForTimeout(2500); catchInfo = await page.evaluate(() => window.__map.getStyle().layers.filter((l) => /catch/i.test(l.id)).map((l) => `${l.id}:${window.__map.getLayoutProperty(l.id, 'visibility') ?? 'visible'}`)); }
    await page.setViewportSize({ width: 1440, height: 4200 }); await page.waitForTimeout(800);
    await page.locator('#panel').screenshot({ path: path.join(OUT, '04-koritnica-ergebnis-aufgeklappt.png') });
    await page.setViewportSize({ width: 1440, height: 900 }); await page.waitForTimeout(500);
    await shot(page, '05-einzugsgebiet.png');
    return { catchInfo, summaries: await page.$$eval('#results details summary', (s) => s.map((x) => x.textContent)) };
  });
  await step(res, 'Höhenprofil: Hover, Klick, Bildabschnitt', async () => {
    const svg = page.locator('#profile svg'); const b = await svg.boundingBox();
    await page.mouse.move(b.x + b.width * 0.4, b.y + b.height * 0.4); await page.waitForTimeout(400);
    const tip = await page.textContent('#profile .tip');
    const c0 = await center(page);
    await page.mouse.click(b.x + b.width * 0.4, b.y + b.height * 0.4); await page.waitForTimeout(2500);
    const c1 = await center(page);
    const strips = await page.$$eval('#profile .img-stretch', (g) => g.map((x) => x.querySelector('title')?.textContent));
    if (strips.length) { await page.click('#profile .img-stretch'); await page.waitForTimeout(2000); }
    const c2 = await center(page);
    await page.setViewportSize({ width: 1000, height: 700 }); await page.waitForTimeout(800);
    const w1 = (await svg.boundingBox())?.width;
    await shot(page, '06-profil-1000px.png');
    await page.setViewportSize({ width: 1440, height: 900 }); await page.waitForTimeout(800);
    return { tip, c0, c1, strips, c2, svgWidthBei1000: w1, svgWidthBei1440: (await svg.boundingBox())?.width };
  });
  await step(res, 'Stellen-Tour ◀ ▶', async () => {
    const out = [];
    for (let i = 0; i < 4; i++) { await page.click('#tour-next'); await page.waitForTimeout(1800); out.push(`${await txt(page, '#tour-label')} @ ${(await center(page)).join(',')}`); }
    await page.click('#tour-prev'); await page.waitForTimeout(1500); out.push('◀ ' + (await txt(page, '#tour-label')));
    await shot(page, '07-tour.png');
    return out;
  });
  await step(res, 'Listen: Klick zoomt (Gefahr/Schwall/Schlucht)', async () => {
    const out = {};
    for (const sel of ['#hz-list li button', '#ww-list li button', '#narrows-list li button']) {
      const n = await page.locator(sel).count(); if (!n) { out[sel] = 'leer'; continue; }
      await view(page, [13.58, 46.34], 11); await page.locator(sel).first().click(); await page.waitForTimeout(2000); out[sel] = `${n} Einträge → ${(await center(page)).join(',')}`;
    }
    return out;
  });
  await step(res, 'Empfindlichkeit 1/5/9', async () => {
    const o = {}; for (const v of [1, 5, 9, 5]) { await page.$eval('#ww-sens', (el, v) => { el.value = String(v); el.dispatchEvent(new Event('input')); el.dispatchEvent(new Event('change')); }, v); await page.waitForTimeout(400); o[v] = `${await page.locator('#ww-list .ww-id').count()} · ${await txt(page, '#ww-sens-out')}`; }
    return o;
  });
  await step(res, 'Hintergründe + 3D + Drehen', async () => {
    const o = {};
    await view(page, [13.5815, 46.349], 15);
    for (const b of ['s2', 'topo', 'esri']) { await page.click(`[data-base="${b}"]`); await page.waitForTimeout(2500); await shot(page, `08-hintergrund-${b}.png`); o[b] = await txt(page, '#img-date'); }
    await page.check('#terrain'); await page.waitForTimeout(3000);
    o.rotVisible = await page.isVisible('#rot');
    await page.click('#rot-left'); await page.waitForTimeout(1200); o.bearingLeft = await page.evaluate(() => window.__map.getBearing());
    await page.click('#rot-orbit'); await page.waitForTimeout(3000); o.bearingOrbit = await page.evaluate(() => window.__map.getBearing());
    await shot(page, '09-3d-rundflug.png');
    await page.click('#rot-north'); await page.waitForTimeout(1500); o.bearingNorth = await page.evaluate(() => window.__map.getBearing());
    await page.uncheck('#terrain'); await page.waitForTimeout(1000); o.pitchNach3dAus = await page.evaluate(() => window.__map.getPitch());
    return o;
  });
  await step(res, 'Schärfer-Links = Kartenmitte?', async () => {
    await view(page, [13.5815, 46.349], 17.5); await page.waitForTimeout(1500);
    return { center: await center(page), visible: await page.isVisible('#ext-view'), gmaps: await page.getAttribute('#ext-gmaps', 'href'), gearth: await page.getAttribute('#ext-gearth', 'href'), apple: await page.getAttribute('#ext-apple', 'href'), kopf: await txt(page, '#img-date') };
  });
  await step(res, 'Hineinzoomen bis 19 (Koritnica, Charyn)', async () => {
    const o = {};
    for (const [n, c] of [['koritnica', [13.5815, 46.349]], ['charyn', [79.1300, 43.3800]]]) {
      for (const z of [17, 18, 19]) { await view(page, c, z); await page.waitForTimeout(2500); await shot(page, `10-zoom-${n}-z${z}.png`); }
      o[n] = await txt(page, '#img-date');
    }
    return o;
  });
  await step(res, 'Wellen messen', async () => {
    await view(page, [13.5815, 46.349], 18.5);
    await page.click('#wave-btn'); const help = await txt(page, '#mode-help');
    const box = await page.locator('#map canvas').boundingBox();
    for (let i = 0; i < 4; i++) await page.mouse.click(box.x + box.width / 2 - 60 + i * 40, box.y + box.height / 2);
    await page.mouse.dblclick(box.x + box.width / 2 + 100, box.y + box.height / 2); await page.waitForTimeout(1200);
    await shot(page, '11-wellen.png');
    const st = await txt(page, '#status'); await page.keyboard.press('Escape');
    return { help, status: st };
  });
  await step(res, 'Export GPX/CSV/GeoJSON (Varianten)', async () => {
    const o = {};
    const variants = { std: [true, false, false], keine: [false, false, false], split: [false, true, false], km: [false, false, true], alle: [true, true, true] };
    for (const [k, [a, b, c]] of Object.entries(variants)) {
      await page.setChecked('#gpx-steep', a); await page.setChecked('#gpx-split', b); await page.setChecked('#gpx-km', c);
      const f = await dl('#exp-gpx'); const nf = f.replace(/\.gpx$/, `-${k}.gpx`); fs.renameSync(f, nf);
      const x = fs.readFileSync(nf, 'utf8');
      o[k] = { datei: path.basename(nf), trk: (x.match(/<trk>/g) || []).length, wpt: (x.match(/<wpt /g) || []).length, trkptOhneEle: (x.match(/<trkpt [^>]*>(?!\s*<ele>)/g) || []).length, namen: [...x.matchAll(/<name>([^<]*)<\/name>/g)].slice(0, 8).map((m) => m[1]) };
    }
    o.csv = path.basename(await dl('#exp-csv')); o.geojson = path.basename(await dl('#exp-geojson'));
    o.shareVisible = await page.isVisible('#exp-share');
    if (o.shareVisible) { try { o.share = path.basename(await dl('#exp-share')); } catch (e) { o.share = 'kein Download: ' + (await txt(page, '#status')); } }
    return o;
  });
  await step(res, 'Analyse-Parameter (Neuberechnung je Option)', async () => {
    await page.evaluate(() => (document.querySelector('#panel details').open = true));
    const o = {};
    const set = async (label, fn) => { const t0 = Date.now(); await fn(); await waitIdle(page); o[label] = `${((Date.now() - t0) / 1000).toFixed(0)} s · ${await txt(page, '#stats')}`.slice(0, 200); };
    await set('seg250', () => page.selectOption('#opt-seg', '250'));
    await set('seg1000', () => page.selectOption('#opt-seg', '1000'));
    await page.selectOption('#opt-seg', '500'); await waitIdle(page);
    await set('demGlobal', () => page.selectOption('#opt-dem', 'global'));
    await set('resFein', () => page.selectOption('#opt-res', '1'));
    await set('conf35', () => page.selectOption('#opt-conf', '35'));
    await set('width', () => page.check('#opt-width'));
    o.narrowsMitBreite = (await txt(page, '#narrows-list')).slice(0, 200);
    await set('wwAus', () => page.uncheck('#opt-ww')); o.wwAus = await txt(page, '#ww-list');
    await set('narrowsAus', () => page.uncheck('#opt-narrows')); o.narrowsAus = await txt(page, '#narrows-list');
    for (const [s, v] of [['#opt-dem', 'auto'], ['#opt-res', '0'], ['#opt-conf', '20']]) await page.selectOption(s, v);
    await page.uncheck('#opt-width'); await page.check('#opt-ww'); await page.check('#opt-narrows'); await waitIdle(page);
    return o;
  });
  await step(res, 'Schlüssel-Felder (NVE/GitHub) – Speicherort', async () => {
    await page.fill('#gh-token', 'PRUEF-TOKEN-123'); await page.dispatchEvent('#gh-token', 'change');
    await page.fill('#nve-key', 'PRUEF-NVE-456'); await page.dispatchEvent('#nve-key', 'change');
    const ls = await page.evaluate(() => Object.keys(localStorage).map((k) => `${k}=${localStorage.getItem(k).slice(0, 40)}`));
    const type = [await page.getAttribute('#gh-token', 'type'), await page.getAttribute('#nve-key', 'type')];
    const f = await dl('#exp-gpx'); const leakGpx = fs.readFileSync(f, 'utf8').includes('PRUEF');
    // Markierungen-Export mit Token würde hochladen → GitHub-API abfangen, nur prüfen, wohin der Schlüssel geht
    let req = null;
    await page.route(/api\.github\.com/, (r) => { req = { url: r.request().url(), auth: (r.request().headers().authorization || '').replace(/PRUEF-TOKEN-123/, '<token>') }; return r.fulfill({ status: 401, body: '{}', headers: { 'access-control-allow-origin': '*' } }); });
    await page.evaluate(() => (document.querySelector('#ww-export').closest('details').open = true));
    const [d] = await Promise.all([page.waitForEvent('download', { timeout: 15000 }).catch(() => null), page.click('#ww-export')]);
    let leakJson = null; if (d) { const p = path.join(OUT, 'export', 'markierungen.json'); await d.saveAs(p); leakJson = fs.readFileSync(p, 'utf8').includes('PRUEF'); }
    const st = await txt(page, '#status');
    await page.fill('#gh-token', ''); await page.dispatchEvent('#gh-token', 'change');
    await page.fill('#nve-key', ''); await page.dispatchEvent('#nve-key', 'change');
    return { type, ls, leakGpx, leakJson, githubReq: req, status: st };
  });
  await step(res, 'Markierungen: setzen, exportieren, importieren, löschen', async () => {
    await page.locator('#ww-list li button').first().click(); await page.waitForTimeout(1500);
    await page.click('#ww-label');
    const cb = await page.locator('#map canvas').boundingBox();
    await page.mouse.click(cb.x + cb.width / 2, cb.y + cb.height / 2); await page.waitForSelector('.ww-popup', { timeout: 5000 });
    await shot(page, '12-markierung-popup.png');
    await page.fill('.ww-popup .lbl-note', 'Test "<b>fett</b>" & <img src=x onerror=alert(1)>');
    await page.click('.ww-popup button[data-k]'); await page.waitForTimeout(500);
    await page.click('#ww-label');
    const info1 = await txt(page, '#ww-learn-info');
    await page.click('#ww-learn'); await page.waitForTimeout(500); const learn = await txt(page, '#ww-learn-result');
    const [d] = await Promise.all([page.waitForEvent('download'), page.click('#ww-export')]); const p = path.join(OUT, 'export', 'markierungen-2.json'); await d.saveAs(p);
    page.once('dialog', (dg) => dg.accept()); await page.click('#ww-clear'); await page.waitForTimeout(500); const info2 = await txt(page, '#ww-learn-info');
    const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.click('#ww-import')]); await fc.setFiles(p); await page.waitForTimeout(1000);
    const info3 = await txt(page, '#ww-learn-info');
    const [fc2] = await Promise.all([page.waitForEvent('filechooser'), page.click('#ww-import')]);
    const bad = path.join(OUT, 'export', 'kaputt.json'); fs.writeFileSync(bad, '{"labels": 5'); await fc2.setFiles(bad); await page.waitForTimeout(800);
    return { info1, learn: learn.slice(0, 200), info2, info3, nachKaputt: await txt(page, '#status') };
  });
  await step(res, 'Abbrechen mitten in der Analyse + Esc + Zurücksetzen', async () => {
    const o = {};
    await page.selectOption('#preset', 'soca-trenta-kobarid'); await page.click('#load-preset');
    await page.waitForTimeout(4000); o.cancelVisible = await page.isVisible('#cancel'); o.statusVorher = await txt(page, '#status');
    if (o.cancelVisible) await page.click('#cancel');
    await page.waitForTimeout(2500); o.busyNach = await page.evaluate(() => document.body.classList.contains('busy')); o.statusNach = await txt(page, '#status');
    // in später Phase abbrechen
    await page.click('#load-preset'); await page.waitForTimeout(20000); o.statusSpaet = await txt(page, '#status');
    if (await page.isVisible('#cancel')) await page.click('#cancel'); await page.waitForTimeout(2500); o.nachSpaet = await txt(page, '#status');
    await page.click('[data-mode="draw"]'); await page.keyboard.press('Escape'); o.esc = await txt(page, '#mode-help');
    await page.click('#reset'); await page.waitForTimeout(800); o.resetResults = await page.isVisible('#results'); o.resetProfile = await page.isVisible('#profile-wrap');
    // doppeltes Laden schnell hintereinander
    await page.selectOption('#preset', 'koritnica'); await page.click('#load-preset'); await page.click('#load-preset', { force: true }).catch(() => {}); await page.click('#load-preset', { force: true }).catch(() => {});
    await waitIdle(page); o.doppelt = await txt(page, '#stats'); o.marker = await page.locator('.ww-marker').count();
    return o;
  });
  await step(res, 'Tastatur: Fokus-Reihenfolge (erste 25 Tab-Stopps)', async () => {
    await page.reload(); await page.waitForFunction(() => window.__map && window.__map.loaded());
    const seq = [];
    for (let i = 0; i < 25; i++) { await page.keyboard.press('Tab'); seq.push(await page.evaluate(() => { const e = document.activeElement; const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return `${e.tagName.toLowerCase()}${e.id ? '#' + e.id : ''}${e.dataset?.mode ? '[' + e.dataset.mode + ']' : ''}${e.dataset?.base ? '[' + e.dataset.base + ']' : ''} ${(e.textContent || e.getAttribute('aria-label') || '').trim().slice(0, 18)} ${r.width ? '' : '(unsichtbar)'}${cs.outlineStyle === 'none' && !cs.boxShadow.includes('rgb') ? ' (kein Fokusrahmen?)' : ''}`; })); }
    return seq;
  });
  await ctx.close();
  return { res, log };
}

async function mobile(browser) {
  const res = [];
  const { ctx, page, log } = await open(browser, { viewport: { width: 390, height: 844 }, mobile: true });
  await step(res, 'Handy: Startseite', async () => { await page.screenshot({ path: path.join(OUT, '15-handy-start.png'), fullPage: false }); await page.screenshot({ path: path.join(OUT, '15-handy-start-ganz.png'), fullPage: true }); return { scrollW: await page.evaluate(() => document.documentElement.scrollWidth) }; });
  await step(res, 'Handy: Referenz Koritnica', async () => {
    const t0 = Date.now(); await page.selectOption('#preset', 'koritnica'); await page.click('#load-preset'); await waitIdle(page);
    await page.screenshot({ path: path.join(OUT, '16-handy-koritnica.png') });
    await page.screenshot({ path: path.join(OUT, '16-handy-koritnica-ganz.png'), fullPage: true });
    return { s: (Date.now() - t0) / 1000, stats: await txt(page, '#stats'), scrollW: await page.evaluate(() => document.documentElement.scrollWidth), imgDateSichtbar: await page.isVisible('#img-date'), extSichtbar: await page.isVisible('#ext-view') };
  });
  await step(res, 'Handy: Tippziele < 44 px', async () => {
    return await page.evaluate(() => {
      const els = [...document.querySelectorAll('button, a[href], input, select, summary, [role=button]')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; });
      const small = els.filter((e) => { const r = e.getBoundingClientRect(); return r.height < 44 || r.width < 44; });
      const desc = (e) => { const r = e.getBoundingClientRect(); return `${e.tagName.toLowerCase()}${e.id ? '#' + e.id : ''}${e.className && typeof e.className === 'string' ? '.' + e.className.split(' ')[0] : ''} „${(e.textContent || e.getAttribute('aria-label') || e.type || '').trim().slice(0, 16)}“ ${Math.round(r.width)}×${Math.round(r.height)}`; };
      return { gesamt: els.length, zuKlein: small.length, kleinsteHoehe: Math.min(...small.map((e) => e.getBoundingClientRect().height)), beispiele: small.slice(0, 40).map(desc) };
    });
  });
  await step(res, 'Handy: Stellen-Tour + Teilen', async () => {
    await page.click('#tour-next'); await page.waitForTimeout(1800);
    await page.screenshot({ path: path.join(OUT, '17-handy-tour.png') });
    return { tour: await txt(page, '#tour-label'), share: await page.isVisible('#exp-share') };
  });
  await step(res, 'Handy: Ein-/Ausstieg per Tippen (Sanna)', async () => {
    await view(page, [10.527, 47.13], 12.2);
    await page.click('[data-mode="route"]');
    const t0 = Date.now();
    for (const ll of [[10.4910, 47.1176], [10.5630, 47.1436]]) { const pt = await page.evaluate((ll) => window.__map.project(ll), ll); const box = await page.locator('#map canvas').boundingBox(); await page.touchscreen.tap(box.x + pt.x, box.y + pt.y); await page.waitForTimeout(500); }
    await waitIdle(page);
    await page.screenshot({ path: path.join(OUT, '18-handy-sanna.png') });
    return { s: (Date.now() - t0) / 1000, stats: await txt(page, '#stats'), status: await txt(page, '#status') };
  });
  await ctx.close();
  return { res, log };
}

async function run(browser) {
  const d = await desktop(browser);
  const m = await mobile(browser);
  // GPX gegen das Schema prüfen, falls vorhanden
  const xsd = path.join(__dirname, 'fixtures', 'gpx.xsd');
  const val = {};
  if (fs.existsSync(xsd)) for (const f of fs.readdirSync(path.join(OUT, 'export')).filter((f) => f.endsWith('.gpx'))) {
    try { execSync(`xmllint --noout --schema ${xsd} "${path.join(OUT, 'export', f)}" 2>&1`); val[f] = 'gültig'; } catch (e) { val[f] = String(e.stdout).slice(0, 600); }
  }
  return { desktop: d, mobile: m, gpxSchema: val };
}
module.exports = { run };
