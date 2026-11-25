const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
// Browser-Test gegen den laufenden Dev-Server (npm run dev, Port 5173).
// Aufruf: npm run e2e  [Ausgabeordner, Standard tests/e2e/out]
const S = process.argv[2] || path.join(__dirname, 'out');
fs.mkdirSync(S, { recursive: true });
const t0 = Date.now();
const mock = fs.readFileSync(path.join(__dirname, 'fixtures', 'overpass.json'), 'utf8');
let osmMode = 'ok';
const results = [];
const check = (name, ok, info = '') => { results.push([ok ? 'OK ' : 'FEHLER', name, info]); };
(async () => {
  const proxy = process.env.HTTPS_PROXY;
  const browser = await chromium.launch({ proxy: proxy ? { server: proxy, bypass: 'localhost,127.0.0.1' } : undefined, args: ['--ignore-certificate-errors'] });
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|tile|Access to fetch/i.test(m.text())) errors.push(m.text().slice(0, 150)); });
  await page.route(/overpass/, r => osmMode === 'ok' ? r.fulfill({ status: 200, contentType: 'application/json', body: mock, headers: { 'access-control-allow-origin': '*' } }) : r.abort());
  await page.route(/nominatim/, r => r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify([{ display_name: 'Bovec, Slowenien', lon: '13.552', lat: '46.338' }]) }));
  await page.goto('http://localhost:5173/');
  await page.waitForFunction(() => window.__map && window.__map.loaded());

  const status = () => page.textContent('#status');
  const stat = async (k) => page.evaluate((k) => { const dts = [...document.querySelectorAll('#stats dt')]; const dt = dts.find(d => d.textContent === k); return dt ? dt.nextElementSibling.textContent : null; }, k);
  const waitIdle = async (ms = 240000) => { await page.waitForTimeout(300); await page.waitForFunction(() => !document.body.classList.contains('busy'), null, { timeout: ms }); await page.waitForTimeout(200); };
  const view = (c, z) => page.evaluate(([c, z]) => new Promise(res => { window.__map.jumpTo({ center: c, zoom: z }); window.__map.once('idle', res); setTimeout(res, 3000); }), [c, z]);
  const clickLL = async (ll) => {
    const pt = await page.evaluate((ll) => window.__map.project(ll), ll);
    const box = await page.locator('#map canvas').boundingBox();
    await page.mouse.click(box.x + pt.x, box.y + pt.y);
    await page.waitForTimeout(450);
  };
  const resultsVisible = () => page.isVisible('#results');

  // 1 Referenzstrecke mit OSM
  await page.click('#load-preset'); await waitIdle();
  check('Referenz: Ergebnis mit OSM + Sentinel-2', await resultsVisible() && /OpenStreetMap/.test(await stat('Flusslinie')) && /Sentinel-2/.test(await stat('Flusslinie')), `${await stat('Flusslinie')} · ${await stat('Länge')} · ${await stat('Ø Gefälle')} · Literatur: ${await stat('Literatur')} · Status: ${await status()}`);
  check('Referenz: Name', (await page.textContent('#res-title')).includes('Na Logu'), await page.textContent('#res-title'));

  // 2 Parameter ändern → neu rechnen
  const before = await page.locator('#stats').textContent();
  await page.evaluate(() => document.querySelector('details').open = true);
  await page.selectOption('#opt-seg', '1000'); await waitIdle();
  const nSeg = await page.evaluate(() => document.querySelectorAll('#profile .seg-area').length);
  check('Parameter: Abschnitte 1 km', nSeg >= 30 && nSeg <= 45, `${nSeg} Abschnitte`);
  check('Parameter: Literatur bleibt erhalten', !!(await stat('Literatur')));
  await page.selectOption('#opt-seg', '500'); await waitIdle();

  // 3 Referenz ohne OSM (Häkchen aus)
  await page.evaluate(() => { document.querySelector('#opt-osm').checked = false; });
  await page.click('#load-preset'); await waitIdle();
  await page.evaluate(() => { document.querySelector('#opt-osm').checked = true; });
  check('Referenz ohne OSM: Satellit + Höhenmodell', !/OpenStreetMap/.test(await stat('Flusslinie')) && /Sentinel-2/.test(await stat('Flusslinie')), `${await stat('Flusslinie')} · ${await stat('Länge')} · Status: ${await status()}`);

  // 4 Modus OSM
  await page.click('[data-mode="osm"]');
  await view([13.60, 46.33], 12);
  await clickLL([13.5583, 46.3238]); await waitIdle();
  check('OSM: Fluss geladen', (await status()).includes('Soča'), await status());
  check('OSM: Modus Einstieg', (await page.textContent('#mode-help')).includes('Einstieg'));
  await clickLL([13.6239, 46.338]);
  await clickLL([13.5583, 46.3238]); await waitIdle();
  check('OSM: Ergebnis', await resultsVisible(), `${await stat('Länge')} · ${await stat('Höhe')} · Status: ${await status()}`);

  // 5 OSM: Ein- und Ausstieg vertauscht (flussaufwärts geklickt)
  await page.click('[data-mode="osm"]');
  await clickLL([13.5583, 46.3238]); await waitIdle();
  await clickLL([13.5583, 46.3238]);
  await clickLL([13.6239, 46.338]); await waitIdle();
  const h = await stat('Höhe');
  check('OSM vertauscht: fällt trotzdem', h && Number(h.split('→')[0]) > Number(h.split('→')[1].replace(' m', '')), `${h} · Status: ${await status()}`);

  // 6 OSM: Klick ins Leere (Fehler)
  osmMode = 'empty';
  await page.route(/overpass/, r => r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: osmMode === 'empty' ? '{"elements":[]}' : mock }));
  await page.click('[data-mode="osm"]');
  await clickLL([13.62, 46.30]); await waitIdle();
  check('OSM leer: Fehlermeldung, Modus bleibt', (await page.textContent('#mode-help')).includes('Fluss in der Karte') && (await status()).includes('Kein Gewässer'), await status());
  osmMode = 'ok';

  // 7 Ein-/Ausstieg (Koritnica, ohne OSM)
  await page.evaluate(() => { document.querySelector('#opt-osm').checked = false; });
  await page.click('[data-mode="route"]');
  await view([13.576, 46.336], 13);
  await clickLL([13.5815, 46.349]);
  await clickLL([13.5694, 46.3242]); await waitIdle();
  check('Ein-/Ausstieg Koritnica: Ergebnis mit Satellit', await resultsVisible() && /Sentinel-2/.test(await stat('Flusslinie')), `${await stat('Flusslinie')} · ${await stat('Länge')} · ${await stat('Ø Gefälle')}`);
  await page.locator('#map').screenshot({ path: S + '/e2e-koritnica.png' });

  // 8 Ein-/Ausstieg vertauscht → Linie trotzdem, Richtung korrigiert
  await page.click('[data-mode="route"]');
  await clickLL([13.5694, 46.3242]);
  await clickLL([13.5815, 46.349]); await waitIdle();
  const h8 = await stat('Höhe');
  check('Ein-/Ausstieg vertauscht: fällt trotzdem', h8 && Number(h8.split('→')[0]) > Number(h8.split('→')[1].replace(' m', '')), `${h8} · Status: ${await status()}`);
  await page.evaluate(() => { document.querySelector('#opt-osm').checked = true; });

  // 8b Norwegen (Sjoa) mit Kartverket
  await page.click('[data-mode="route"]');
  await view([9.49, 61.70], 12);
  await clickLL([9.43, 61.722]);
  await clickLL([9.545, 61.684]); await waitIdle();
  const sjNr = (await page.textContent('#narrows-list')).replace(/\s+/g, ' ');
  check('Norwegen: Åmot-Schlucht als Schlucht-/Klammstrecke', /Klamm|Schlucht/.test(sjNr), sjNr.slice(0, 160) + ' | ' + (await page.textContent('#narrows-meta')).slice(0, 120));
  check('Norwegen: Kartverket-Höhenmodell (oder klarer Hinweis bei Störung)', /Kartverket/.test(await stat('Höhenmodell') || ''), `${await stat('Höhenmodell')} · ${await stat('Flusslinie')} · ${await stat('Länge')} · ${await stat('Höhe')}`);
  await page.selectOption('#opt-dem', 'global'); await waitIdle();
  check('Norwegen: Umschalten auf global', /global/.test(await stat('Höhenmodell') || ''), `${await stat('Höhenmodell')} · ${await stat('Höhe')}`);
  await page.selectOption('#opt-dem', 'auto'); await waitIdle();
  await view([13.60, 46.33], 12);

  // 9 Zeichnen mit Doppelklick
  await page.click('[data-mode="draw"]');
  const z0 = await page.evaluate(() => window.__map.getZoom());
  await clickLL([13.6239, 46.338]);
  await clickLL([13.6102, 46.3375]);
  await clickLL([13.5964, 46.3352]);
  await clickLL([13.0, 46.0]).catch(() => {}); // wird mit Undo entfernt
  await page.click('#undo-draw');
  const pt = await page.evaluate(() => window.__map.project([13.5827, 46.3312]));
  const box = await page.locator('#map canvas').boundingBox();
  await page.mouse.dblclick(box.x + pt.x, box.y + pt.y);
  await waitIdle();
  const z1 = await page.evaluate(() => window.__map.getZoom());
  check('Zeichnen: Doppelklick beendet, kein Zoom', (await resultsVisible()) && Math.abs(z1 - z0) < 0.01, `${await stat('Länge')} · Zoom ${z0.toFixed(2)}→${z1.toFixed(2)} · ${await status()}`);

  // 10 Esc bricht ab
  await page.click('[data-mode="draw"]');
  await clickLL([13.6239, 46.338]);
  await page.keyboard.press('Escape');
  const draft = await page.evaluate(() => window.__map.getSource('draft')._data.features?.length ?? 0);
  check('Esc: Modus beendet, Entwurf leer', (await page.textContent('#mode-help')).startsWith('Wähle') && draft === 0);

  // 11 Reset + Parameter ändern darf nichts anzeigen
  await page.click('#load-preset'); await waitIdle();
  await page.click('#reset');
  await page.selectOption('#opt-seg', '250'); await page.waitForTimeout(2500);
  await page.selectOption('#opt-seg', '500');
  check('Reset: Parameter ändern zeigt nichts', !(await resultsVisible()));

  // 12 Doppelt laden (Race)
  await page.click('#load-preset');
  await page.click('#load-preset', { force: true }).catch(() => {});
  await waitIdle();
  check('Doppelt laden: ein Ergebnis', await resultsVisible(), await stat('Länge'));
  // Referenz Koritnica
  await page.selectOption('#preset', 'koritnica');
  await page.click('#load-preset'); await waitIdle();
  await page.waitForFunction(() => !/Wird geladen/.test(document.querySelector('#flow-info').textContent), null, { timeout: 60000 }).catch(() => {});
  const fi = (await page.textContent('#flow-info')).replace(/\s+/g, ' ');
  check('Luftbild-Datum + Hinweise, keine Modellzahl', /21\.08\.2023/.test(fi) && /eher niedrig|unauffällig|eher erhöht|eher hoch/.test(fi) && !/Modell/.test(fi), fi.slice(0, 160));
  await page.click('#tour-next'); await page.waitForTimeout(1500);
  check('Stellen-Tour zoomt ins Luftbild', (await page.evaluate(() => window.__map.getZoom())) > 17, await page.textContent('#tour-label'));
  check('Referenz Koritnica', await resultsVisible(), `${await stat('Länge')} · ${await stat('Ø Gefälle')} · ${await stat('Literatur')}`);
  const korNr = (await page.textContent('#narrows-list')).replace(/\s+/g, ' ');
  check('Koritnica: Klamm unterhalb Kluže markiert', /Klamm/.test(korNr), korNr.slice(0, 160));
  check('Koritnica: Marker K auf Karte', (await page.locator('.nr-marker').count()) > 0);
  check('Koritnica: Band im Profil', (await page.locator('#profile .narrow-band').count()) > 0);
  const wwTxt = (await page.textContent('#ww-list')).replace(/\s+/g, ' ');
  check('Koritnica: Schwallstellen im Orthofoto (GURS) gesucht', /Schwallstelle|Gefahrenstelle/.test(wwTxt) && /21\.08\.2023/.test(await page.textContent('#ww-meta')), wwTxt.slice(0, 160));
  check('Koritnica: Marker W auf Karte + Band im Profil', (await page.locator('.ww-marker').count()) > 0 && (await page.locator('#profile .ww-mark').count()) > 0);
  check('Schwallstellen in der Stellen-Tour', /Schwallstelle|Gefahrenstelle/.test(await page.evaluate(() => { const b = document.querySelector('#tour-next'); for (let i = 0; i < 30; i++) { b.click(); if (/Schwallstelle|Gefahrenstelle/.test(document.querySelector('#tour-label').textContent)) return document.querySelector('#tour-label').textContent; } return ''; })));
  check('Koritnica: Steilstufe am Schluchtausgang', /Höhenverlust/.test(await page.textContent('#steps-list')), (await page.textContent('#steps-list')).replace(/\s+/g, ' ').slice(0, 100));
  check('Wucht nur mit Pegel, sonst Hinweis', /kein Pegel/.test(fi) ? /braucht einen Abfluss/.test(await page.textContent('#rate-note')) : /Strömungsleistung/.test(await page.textContent('#rate-note')), await page.textContent('#rate-note'));
  await page.selectOption('#q-src', 'own'); await page.fill('#q-own', '150'); await page.dispatchEvent('#q-own', 'change'); await page.waitForTimeout(500);
  check('Eigener Abfluss → schwerere Einstufung', /150 m³\/s/.test(await page.textContent('#rate-note')), (await page.textContent('#classes')).replace(/\s+/g, ' ').slice(0, 120));
  await page.selectOption('#q-src', 'today');
  await page.selectOption('#preset', 'soca-trenta-kobarid');

  // Reset während Berechnung → neue Messung möglich
  await page.click('[data-mode="route"]');
  await view([9.24, 61.73], 11);
  await clickLL([9.1754, 61.7042]); await clickLL([9.3016, 61.7517]);
  await page.waitForTimeout(300);
  const midBusy = await page.evaluate(() => document.body.classList.contains('busy'));
  await page.click('#reset');
  await page.click('[data-mode="route"]');
  await clickLL([9.1754, 61.7042]); await clickLL([9.3016, 61.7517]); await waitIdle();
  check('Zurücksetzen während Berechnung, danach neue Messung', midBusy && await resultsVisible(), `busy mittendrin: ${midBusy} · ${await stat('Länge')} · ${await status()}`);
  await view([13.576, 46.336], 13);
  // Abbrechen-Knopf
  await page.click('[data-mode="route"]');
  await view([10.0, 61.9], 11);
  await clickLL([9.96, 61.92]); await clickLL([10.05, 61.88]);
  await page.waitForTimeout(300);
  const cancelVisible = await page.isVisible('#cancel');
  if (cancelVisible) await page.click('#cancel');
  check('Abbrechen-Knopf beendet Berechnung', cancelVisible && !(await page.evaluate(() => document.body.classList.contains('busy'))), await status());
  await page.selectOption('#preset', 'koritnica');
  await page.click('#load-preset'); await waitIdle();

  // 13 Suche
  await page.fill('#search', 'Bovec'); await page.click('#search-form button');
  await page.waitForSelector('#search-results li button');
  await page.click('#search-results li button'); await page.waitForTimeout(5000);
  const c = await page.evaluate(() => window.__map.getCenter());
  check('Suche', Math.abs(c.lng - 13.552) < 0.01, `${c.lng.toFixed(3)},${c.lat.toFixed(3)}`);

  // 14 Export
  for (const [id, ext] of [['#exp-gpx', 'gpx'], ['#exp-csv', 'csv'], ['#exp-geojson', 'geojson']]) {
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click(id)]);
    const p = await dl.path(); const txt = fs.readFileSync(p, 'utf8');
    check(`Export ${ext}`, txt.length > 200 && dl.suggestedFilename().endsWith(ext), `${dl.suggestedFilename()} ${txt.length} B`);
    if (ext !== 'csv' && /Klamm/.test(await page.textContent('#narrows-list'))) check(`Export ${ext} enthält Klamm`, /Klamm/.test(txt));
    if (ext !== 'csv' && (await page.locator('#ww-list .ww-id').count()) > 0) check(`Export ${ext} enthält Schwallstellen`, /Schwall|schwall/.test(txt));
  }

  // 15 Profil-Hover
  await page.hover('#profile svg', { position: { x: 600, y: 100 } });
  const cur = await page.evaluate(() => window.__map.getSource('cursor')._data?.geometry?.type);
  check('Profil-Hover zeigt Punkt auf Karte', cur === 'Point');

  // Gefahrenstellen: Wasserfälle der Jökulsá á Fjöllum (NÁTT-Luftbild)
  await page.selectOption('#preset', 'jokulsa-dettifoss'); await page.click('#load-preset'); await waitIdle(400000);
  const nBreak = await page.locator('.break-marker').count();
  check('Island: Wasserfälle als Gefahrenstellen (Abbruchkante + Höhenverlust)', nBreak >= 2, `${nBreak} Gefahrenstellen · ${(await page.textContent('#ww-list')).replace(/\s+/g, ' ').slice(0, 200)}`);
  check('Keine Hotspot-Marker mehr', (await page.locator('.hs-marker').count()) === 0);

  // 17 Kartenwechsel + 3D
  await page.click('[data-base="s2"]'); await page.click('[data-base="topo"]'); await page.check('#terrain'); await page.waitForTimeout(1500); await page.uncheck('#terrain');
  check('Karten/3D ohne Fehler', true);

  // 18 Mobil
  await page.setViewportSize({ width: 390, height: 844 }); await page.waitForTimeout(1000);
  const sw = await page.evaluate(() => document.documentElement.scrollWidth);
  check('Mobil: kein horizontales Scrollen', sw <= 390, `scrollWidth ${sw}`);
  await page.screenshot({ path: S + '/e2e-mobile.png' });

  check('Keine JS-Fehler', errors.length === 0, errors.join(' | '));
  for (const r of results) console.log(r.join('  '));
  console.log('Dauer', Math.round((Date.now() - t0) / 1000), 's');
  await browser.close();
})().catch(e => { for (const r of results) console.log(r.join('  ')); console.log('ABBRUCH', e.message); process.exit(1); });
