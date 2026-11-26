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
  // Markierung im Format von PR #17 (ohne Art/Merkmale) am Koritnica-Ausstieg – muss bei der Analyse Merkmale bekommen
  await page.addInitScript(() => { if (!localStorage.getItem('packraft.wwLabels')) localStorage.setItem('packraft.wwLabels', JSON.stringify([{ p: [13.5694, 46.3242], schwall: false, date: '2026-11-26' }])); });
  await page.goto('http://localhost:5173/');
  await page.waitForFunction(() => window.__map && window.__map.loaded());

  const status = () => page.textContent('#status');
  const stat = async (k) => page.evaluate((k) => { const dts = [...document.querySelectorAll('#results dt')]; const dt = dts.find(d => d.textContent === k); return dt ? dt.nextElementSibling.textContent : null; }, k);
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
  check('Schwallstellen-Erkennung standardmäßig aus (experimentell), Eigene Stellen + OSM-Abschnitt da', !(await page.isChecked('#opt-ww')) && !(await page.isVisible('#ww-section')) && await page.isVisible('#own-list') && await page.isVisible('#osm-list') && (await page.locator('.ww-marker').count()) === 0, (await page.textContent('#osm-list')).replace(/\s+/g, ' ').slice(0, 100));

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

  check('Modus „Fluss aus OSM“ entfernt', (await page.locator('[data-mode="osm"]').count()) === 0);

  // 7 Ein-/Ausstieg (Koritnica, ohne OSM)
  await page.evaluate(() => { document.querySelector('#opt-osm').checked = false; });
  await page.click('[data-mode="route"]');
  await view([13.576, 46.336], 13);
  await clickLL([13.5815, 46.349]);
  await clickLL([13.5694, 46.3242]); await waitIdle();
  check('Ein-/Ausstieg Koritnica: Ergebnis mit Satellit', await resultsVisible() && /Sentinel-2/.test(await stat('Flusslinie')), `${await stat('Flusslinie')} · ${await stat('Länge')} · ${await stat('Ø Gefälle')}`);
  await page.locator('#map').screenshot({ path: S + '/e2e-koritnica.png' });
  // Ein-/Ausstieg verschieben und Strecke über Zwischenpunkte bearbeiten
  {
    const len = async () => parseFloat((await stat('Länge')).replace(',', '.'));
    const L0 = await len();
    const dragTo = async (loc, ll) => {
      const b = await loc.boundingBox();
      const pt = await page.evaluate((ll) => window.__map.project(ll), ll);
      const box = await page.locator('#map canvas').boundingBox();
      await page.mouse.move(b.x + b.width / 2, b.y + b.height - 2); await page.mouse.down();
      await page.mouse.move(box.x + pt.x, box.y + pt.y - 6, { steps: 10 }); await page.mouse.up();
      await waitIdle();
    };
    await dragTo(page.locator('.endpoint', { hasText: 'Ausstieg' }), [13.5752, 46.3318]);
    const L1 = await len();
    check('Ausstieg verschieben → Strecke neu berechnet (kürzer)', L1 < L0 - 0.3 && /von Hand angepasst/.test(await stat('Flusslinie')), `${L0} → ${L1} km · ${await stat('Flusslinie')}`);
    await page.click('#edit-btn');
    const mid = await page.evaluate(() => { const f = window.__map.querySourceFeatures('section').flatMap((x) => x.geometry.coordinates); return f[Math.floor(f.length / 2)]; });
    await clickLL(mid);
    const h1 = await page.locator('.edit-handle').count();
    await dragTo(page.locator('.edit-handle').first(), [mid[0] + 0.002, mid[1]]);
    const h2 = await page.locator('.edit-handle').count();
    const L2 = await len();
    await page.locator('.edit-handle').first().click(); await waitIdle();
    const h3 = await page.locator('.edit-handle').count();
    await page.keyboard.press('Escape');
    check('Strecke bearbeiten: Zwischenpunkt einfügen, ziehen, löschen', h1 === 1 && h2 === 1 && h3 === 0 && (await resultsVisible()) && !(await page.locator('#edit-btn.on').count()), `Griffe ${h1}/${h2}/${h3} · ${L1} → ${L2} km`);
  }

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
  const sjWw = (await page.textContent('#ww-list')).replace(/\s+/g, ' ');
  check('Norwegen: ohne Erkennung keine Schwallstellen-Suche, kein Abschnitt', /Ausgeschaltet/.test(sjWw) && !(await page.isVisible('#ww-section')) && (await page.locator('.ww-marker').count()) === 0, sjWw.slice(0, 120));
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
  // Referenz Koritnica – mit eingeschalteter (experimenteller) Schwallstellen-Erkennung; OSM liefert eine Stromschnelle am Ausstieg
  const osmPlaces = JSON.stringify({ elements: [
    { type: 'node', id: 901, lat: 46.3243, lon: 13.5695, tags: { whitewater: 'rapid', 'whitewater:rapid_grade': '3', 'whitewater:rapid_name': 'Test-Schwall' } },
    { type: 'node', id: 902, lat: 46.40, lon: 13.70, tags: { waterway: 'waterfall' } },
  ] });
  await page.route(/overpass/, (r) => /whitewater/.test(decodeURIComponent(r.request().postData() || '')) ? r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: osmPlaces }) : r.fallback());
  await page.evaluate(() => { const c = document.querySelector('#opt-ww'); c.checked = true; c.dispatchEvent(new Event('change')); });
  await waitIdle();
  await page.selectOption('#preset', 'koritnica');
  await page.click('#load-preset'); await waitIdle();
  await page.waitForFunction(() => !/Wird geladen/.test(document.querySelector('#flow-info').textContent), null, { timeout: 60000 }).catch(() => {});
  const fi = (await page.textContent('#flow-info')).replace(/\s+/g, ' ');
  check('Luftbild-Datum + Hinweise, keine Modellzahl', /21\.08\.2023/.test(fi) && /eher niedrig|unauffällig|eher erhöht|eher hoch/.test(fi) && !/Modell/.test(fi), fi.slice(0, 160));
  check('Regime (Gletscher/Schnee/Regen) statt Wetterdaten', /Abflussregime: (Gletscherfluss|Schneeschmelze|Regen)/.test(fi) && !/Open-Meteo|Wetterdaten|mm Regen/.test(fi), fi.slice(0, 200));
  await page.click('#tour-next'); await page.waitForTimeout(1500);
  check('Stellen-Tour zoomt ins Luftbild', (await page.evaluate(() => window.__map.getZoom())) > 17, await page.textContent('#tour-label'));
  check('Referenz Koritnica', await resultsVisible(), `${await stat('Länge')} · ${await stat('Ø Gefälle')} · ${await stat('Literatur')}`);
  const korNr = (await page.textContent('#narrows-list')).replace(/\s+/g, ' ');
  check('Koritnica: Klamm unterhalb Kluže markiert', /Klamm/.test(korNr), korNr.slice(0, 160));
  check('Koritnica: Schlucht-Marker S, kein K', (await page.locator('.nr-marker').count()) > 0 && !(await page.locator('.nr-marker').allTextContents()).some((t) => t.includes('K')));
  check('Koritnica: Band im Profil', (await page.locator('#profile .narrow-band').count()) > 0);
  const wwTxt = (await page.textContent('#ww-list')).replace(/\s+/g, ' ');
  check('Koritnica: Schwallstellen im Orthofoto (GURS) gesucht', /Schwallstelle|Gefahrenstelle/.test(wwTxt) && /21\.08\.2023/.test(await page.textContent('#ww-meta')), wwTxt.slice(0, 160));
  const sens = async (v) => { await page.$eval('#ww-sens', (el, v) => { el.value = String(v); el.dispatchEvent(new Event('input')); }, v); await page.waitForTimeout(300); return page.locator('#ww-list .ww-id').count(); };
  const n9 = await sens(9), n1 = await sens(1), n5 = await sens(5);
  check('Empfindlichkeit: Regler ändert die Zahl der Schwallstellen', n9 > n1 && n9 >= n5 && n5 >= n1, `Stufe 1: ${n1} · 5: ${n5} · 9: ${n9} · ${await page.textContent('#ww-sens-out')}`);
  // eigene Markierung: Schnellauswahl Art + Grad, Klick daneben bearbeitet statt zu doppeln, Löschen
  {
    await page.locator('#ww-list li button').first().click(); await page.waitForTimeout(1500); // springt zur Stelle (Kartenmitte)
    await page.click('#own-btn');
    const cb = await page.locator('#map canvas').boundingBox();
    const px = cb.x + cb.width / 2 + 45, py = cb.y + cb.height / 2;
    const info = async () => (await page.textContent('#ww-learn-info')).replace(/\s+/g, ' ');
    const i0 = await info();
    check('Alte Markierung (PR #17) bekommt bei der Analyse Luftbild-Merkmale', /^1 eigene Markierung \(0 Schwall, 1 kein Schwall; 1 mit Luftbild/.test(i0), i0.slice(0, 90));
    await page.mouse.click(px, py); await page.waitForSelector('.ww-popup');
    await page.click('.ww-popup button[data-g="III"]'); await page.click('.ww-popup button[data-k="walze"]'); await page.waitForTimeout(400);
    const i1 = await info();
    await page.mouse.click(px + 3, py + 2); await page.waitForSelector('.ww-popup');
    const head = await page.textContent('.ww-popup b');
    await page.click('.ww-popup button[data-k="kiesbank"]'); await page.waitForTimeout(400);
    const i2 = await info();
    await page.mouse.click(px, py); await page.waitForSelector('.ww-popup');
    await page.click('.ww-popup button[data-del]'); await page.waitForTimeout(400);
    const i3 = await info();
    const visIn = await page.evaluate(() => window.__map.getLayoutProperty('ww-labels', 'visibility'));
    await page.click('#own-btn');
    const visOut = await page.evaluate(() => window.__map.getLayoutProperty('ww-labels', 'visibility'));
    // Lernen mit zu wenigen Markierungen → sichtbare Rückmeldung; Export mit Schlüssel → Upload (GitHub-API simuliert)
    await page.evaluate(() => { document.querySelectorAll('#ww-tune, #ww-tune details').forEach((dd) => (dd.open = true)); });
    await page.click('#ww-learn'); await page.waitForTimeout(300);
    const lr = (await page.textContent('#ww-learn-result')).replace(/\s+/g, ' ');
    const lrHtml = await page.innerHTML('#ww-learn-result');
    let put = null;
    await page.route(/api\.github\.com/, (r) => { put = r.request(); return r.fulfill({ status: 201, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ content: { html_url: 'https://github.com/zowallawilli/App-Design-/blob/main/daten/markierungen/x.json' } }) }); });
    await page.evaluate(() => { const el = document.getElementById('gh-token'); el.value = 'test-token'; el.dispatchEvent(new Event('change')); });
    await page.click('#ww-export'); await page.waitForTimeout(800);
    const up = (await page.textContent('#ww-learn-result')).replace(/\s+/g, ' ');
    await page.evaluate(() => { const el = document.getElementById('gh-token'); el.value = ''; el.dispatchEvent(new Event('change')); });
    check('Lernen gibt Rückmeldung, Export lädt mit Schlüssel nach daten/markierungen/ hoch', /Verarbeitet: \d+ von \d+ Markierungen/.test(lr) && /alle Schwälle<\/b>: \d+ Schwall/.test(lrHtml) && /hochgeladen nach daten\/markierungen\/markierungen-/.test(up) && put && put.method() === 'PUT' && /contents\/daten\/markierungen\//.test(put.url()), `${lr.slice(0, 80)} | ${up.slice(0, 90)}`);
    check('Eigene Markierungen nur im Markier-Modus sichtbar', visIn === 'visible' && visOut === 'none', `${visIn} → ${visOut}`);
    // Nachbearbeiten erkannter Stellen: Fenster per Kartenklick schließen, löschen, verschieben
    await page.click('#own-btn');
    await page.mouse.click(px, py + 60); await page.waitForSelector('.ww-popup');
    await page.mouse.click(px - 260, py - 160); await page.waitForTimeout(400);
    const closed = (await page.locator('.ww-popup').count()) === 0;
    const n0 = await page.locator('.ww-marker').count();
    const m1 = await page.locator('.ww-marker').first().boundingBox();
    await page.mouse.click(m1.x + m1.width / 2, m1.y + m1.height / 2); await page.waitForSelector('.ww-popup button[data-hide]');
    await page.click('.ww-popup button[data-hide]'); await page.waitForTimeout(500);
    const n1 = await page.locator('.ww-marker').count();
    await page.locator('#ww-list li button').first().click(); await page.waitForTimeout(1500); // zur verbliebenen Stelle springen
    if (await page.locator('.ww-popup').count()) await page.keyboard.press('Escape');
    const m2 = await page.locator('.ww-marker').first().boundingBox();
    await page.mouse.move(m2.x + m2.width / 2, m2.y + m2.height / 2); await page.mouse.down();
    await page.mouse.move(m2.x + m2.width / 2 + 30, m2.y + m2.height / 2 + 20, { steps: 8 }); await page.mouse.up(); await page.waitForTimeout(600);
    const movedHead = (await page.locator('.ww-popup b').count()) ? await page.textContent('.ww-popup b') : '';
    const ownInList = /✓|nur eigene Markierung/.test(await page.textContent('#ww-list'));
    await page.keyboard.press('Escape'); await page.waitForTimeout(200);
    const escOk = (await page.locator('.ww-popup').count()) === 0 && /ww-label|Stellen/.test(await page.textContent('#mode-help')) && (await page.locator('.ww-marker, .own-marker').count()) > 0;
    await page.keyboard.press('Escape'); await page.waitForTimeout(200);
    const escOut = !(await page.locator('#own-btn.on').count());
    check('Erkannte Stellen: Fenster schließt per Kartenklick, Löschen, Verschieben; Esc behält Analyse', closed && escOk && escOut && n1 === n0 - 1 && /Markiert: Stromschnelle/.test(movedHead) && ownInList, `zu: ${closed} · Marker ${n0} → ${n1} · ${movedHead} · eigene in Liste: ${ownInList}`);
    check('Eigene Markierung: Art + Grad, Ändern ohne Doppelung, Löschen', /^2 eigene Markierungen \(1 Schwall, 1 kein Schwall; 2 mit Luftbild/.test(i1) && /Walze \/ Loch · WW III/.test(head) && /^2 eigene Markierungen \(0 Schwall, 2 kein Schwall/.test(i2) && /^1 eigene Markierung \(/.test(i3), `${i1.slice(0, 70)} | ${head} | ${i2.slice(0, 50)} | ${i3.slice(0, 30)}`);
  }
  // OSM-Stelle + Erkennung wieder aus: eigene Stellen bleiben, Schwallstellen-Abschnitt verschwindet
  {
    const osmTxt = (await page.textContent('#osm-list')).replace(/\s+/g, ' ');
    check('OSM: Stromschnelle mit Grad an der Strecke, ferner Wasserfall nicht', /Stromschnelle · WW III · Test-Schwall/.test(osmTxt) && /aus OSM, nicht geprüft/.test(osmTxt) && !/Wasserfall/.test(osmTxt) && (await page.locator('.osm-marker').count()) === 1, osmTxt.slice(0, 140));
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#exp-gpx')]);
    const gpx = fs.readFileSync(await dl.path(), 'utf8');
    check('GPX enthält eigene Stellen und OSM-Stellen', /<type>Eigene Stelle<\/type>/.test(gpx) && /Stromschnelle WW III km [\d.]+ \(OSM\)/.test(gpx), `${(gpx.match(/<wpt /g) || []).length} Wegpunkte`);
  }
  check('Koritnica: Marker W auf Karte + Band im Profil', (await page.locator('.ww-marker, .own-marker').count()) > 0 && (await page.locator('#profile .ww-mark').count()) > 0);
  check('Schwallstellen in der Stellen-Tour', /Schwallstelle|Gefahrenstelle|Eigene Stelle/.test(await page.evaluate(() => { const b = document.querySelector('#tour-next'); for (let i = 0; i < 30; i++) { b.click(); if (/Schwallstelle|Gefahrenstelle|Eigene Stelle/.test(document.querySelector('#tour-label').textContent)) return document.querySelector('#tour-label').textContent; } return ''; })));
  // Nutzerregel: keine Gefahrenstelle nur aus dem Höhenmodell; Kluže-Ende ist im 0,25-m-Orthofoto sichtbar → keine
  check('Koritnica: keine Gefahrenstelle ohne Bildbefund, keine Steilstufen-Marker', (await page.locator('.hz-marker').count()) === 0 && (await page.locator('.st-marker').count()) === 0, (await page.textContent('#hz-list')).replace(/\s+/g, ' ').slice(0, 160));
  check('Wucht nur mit Pegel, sonst Hinweis', /kein Pegel/.test(fi) ? /braucht einen Abfluss/.test(await page.textContent('#rate-note')) : /Strömungsleistung/.test(await page.textContent('#rate-note')), await page.textContent('#rate-note'));
  await page.selectOption('#q-src', 'own'); await page.fill('#q-own', '150'); await page.dispatchEvent('#q-own', 'change'); await page.waitForTimeout(500);
  check('Eigener Abfluss → schwerere Einstufung', /150 m³\/s/.test(await page.textContent('#rate-note')), (await page.textContent('#classes')).replace(/\s+/g, ' ').slice(0, 120));
  await page.selectOption('#q-src', 'today');
  {
    await page.evaluate(() => { const c = document.querySelector('#opt-ww'); c.checked = false; c.dispatchEvent(new Event('change')); });
    await waitIdle();
    const ownTxt = (await page.textContent('#own-list')).replace(/\s+/g, ' ');
    check('Erkennung aus: kein Schwallstellen-Abschnitt, eigene Stelle bleibt in Liste und Karte', !(await page.isVisible('#ww-section')) && (await page.locator('.ww-marker').count()) === 0 && /Stromschnelle/.test(ownTxt) && (await page.locator('.own-marker').count()) >= 1, ownTxt.slice(0, 120));
    // weltweit ohne Analyse: Stelle setzen, verschieben, löschen
    await page.click('#reset');
    await view([69.5, 39.0], 12); // Zentralasien, kein Orthofoto
    const n0 = await page.locator('.own-marker').count();
    await page.click('#own-btn');
    const cb = await page.locator('#map canvas').boundingBox();
    const cx = cb.x + cb.width / 2, cy = cb.y + cb.height / 2;
    await page.mouse.click(cx, cy); await page.waitForSelector('.ww-popup');
    const noLearn = !(await page.locator('.ww-popup button[data-k="kiesbank"]').count());
    await page.fill('.ww-popup .lbl-note', 'Sandbank links');
    await page.click('.ww-popup button[data-k="lager"]'); await page.waitForTimeout(400);
    const n1 = await page.locator('.own-marker').count();
    const icoOk = /<svg/.test(await page.locator('.own-marker').last().innerHTML()) && !(await page.locator('.own-marker').last().textContent()).trim();
    const lab = () => page.evaluate(() => JSON.parse(localStorage.getItem('packraft.wwLabels')).find((l) => l.kind === 'lager'));
    const l1 = await lab();
    const mk = await page.locator('.own-marker').last().boundingBox();
    await page.mouse.move(mk.x + mk.width / 2, mk.y + mk.height / 2); await page.mouse.down();
    await page.mouse.move(mk.x + mk.width / 2 + 60, mk.y + mk.height / 2 + 30, { steps: 8 }); await page.mouse.up(); await page.waitForTimeout(600);
    const l2 = await lab();
    const head = (await page.locator('.ww-popup b').count()) ? await page.textContent('.ww-popup b') : '';
    await page.click('.ww-popup button[data-del]'); await page.waitForTimeout(400);
    const n2 = await page.locator('.own-marker').count();
    await page.click('#own-btn');
    check('Eigene Stellen weltweit ohne Analyse: setzen (Lagerplatz + Notiz, Zelt-Symbol), verschieben, löschen; ohne Lern-Arten', noLearn && icoOk && n1 === n0 + 1 && l1 && l1.note === 'Sandbank links' && l1.show && !l1.feat && l2 && l2.p[0] !== l1.p[0] && /Markiert: Lagerplatz/.test(head) && n2 === n0, `${n0} → ${n1} → ${n2} · ${head}`);
    await page.evaluate(() => { const c = document.querySelector('#opt-ww'); c.checked = true; c.dispatchEvent(new Event('change')); });
  }
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

  check('Teilen-Knopf sichtbar, Quellen eingeklappt', await page.isVisible('#exp-share') && !(await page.isVisible('#ww-meta')) && !(await page.isVisible('#stats-more')));
  {
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#exp-gpx')]);
    const txt = fs.readFileSync(await dl.path(), 'utf8');
    check('GPX: steile Abschnitte als Track + Wegpunkt', /<name>Steil km/.test(txt) && (txt.match(/<trk>/g) || []).length >= 2, `${(txt.match(/<trk>/g) || []).length} Tracks`);
  }
  {
    const vis = () => page.evaluate(() => window.__map.getLayoutProperty('catch-line', 'visibility'));
    const v0 = await vis();
    await page.click('#flow-info details.more > summary'); await page.uncheck('#show-catch'); await page.waitForTimeout(300);
    const v1 = await vis();
    await page.check('#show-catch');
    check('Einzugsgebiet standardmäßig an (blau gestrichelt), abschaltbar', v0 === 'visible' && v1 === 'none', `${v0} → ${v1}`);
  }
  // 15 Profil-Hover
  await page.hover('#profile svg', { position: { x: 600, y: 100 } });
  const cur = await page.evaluate(() => window.__map.getSource('cursor')._data?.geometry?.type);
  check('Profil-Hover zeigt Punkt auf Karte', cur === 'Point');
  // Klick ins Profil: Karte springt zur Stelle
  await view([13.0, 46.0], 9);
  await page.click('#profile svg .profile-hit', { position: { x: 300, y: 60 } }); await page.waitForTimeout(1500);
  const jc = await page.evaluate(() => ({ c: window.__map.getCenter(), z: window.__map.getZoom(), p: window.__map.getSource('cursor')._data?.geometry?.coordinates }));
  check('Profil-Klick springt zur Stelle', jc.p && Math.abs(jc.c.lng - jc.p[0]) < 0.01 && Math.abs(jc.c.lat - jc.p[1]) < 0.01 && jc.z >= 15, `Zoom ${jc.z.toFixed(1)}`);
  // Bildabschnitte als Leiste im Profil statt Band auf der Karte
  const nStrip = await page.locator('#profile .img-stretch').count();
  check('Bildabschnitte als Leiste unter dem Profil, kein Band auf der Karte', nStrip > 0 && !(await page.evaluate(() => window.__map.getLayer('imgsec'))), `${nStrip} Abschnitte`);
  if (nStrip) {
    await page.click('#profile .img-stretch >> nth=0'); await page.waitForTimeout(1200);
    check('Klick auf Bildabschnitt markiert Panelkarte', (await page.locator('#flow-info .day.active').count()) === 1);
  }
  check('Kein Hintergrund „Orthofoto AT“ mehr', (await page.locator('[data-base="ortho"]').count()) === 0);
  const gl = await page.getAttribute('#ext-gmaps', 'href');
  check('Links Google Maps/Earth/Apple zur Kartenmitte', /google\.com\/maps\/@\?api=1.*basemap=satellite/.test(gl || '') && /earth\.google\.com\/web\/@/.test(await page.getAttribute('#ext-gearth', 'href') || ''), gl);

  // Gefahrenstellen: Wasserfälle der Jökulsá á Fjöllum (NÁTT-Luftbild)
  await page.selectOption('#preset', 'jokulsa-dettifoss'); await page.click('#load-preset'); await waitIdle(400000);
  const nBreak = (await page.locator('#hz-list li').allTextContents()).filter((t) => /Abbruchkante/.test(t)).length;
  check('Island: Wasserfälle als Gefahrenstellen (Abbruchkante + Höhenverlust)', nBreak >= 2, `${nBreak} Gefahrenstellen · ${(await page.textContent('#ww-list')).replace(/\s+/g, ' ').slice(0, 200)}`);
  check('Keine Hotspot-Marker mehr', (await page.locator('.hs-marker').count()) === 0);

  // 17 Kartenwechsel + 3D
  await page.click('[data-base="s2"]'); await page.click('[data-base="topo"]'); await page.check('#terrain'); await page.waitForTimeout(1500); await page.uncheck('#terrain');
  await page.check('#terrain'); await page.waitForTimeout(800);
  await page.click('#rot-right'); await page.waitForTimeout(1200);
  const br = await page.evaluate(() => window.__map.getBearing());
  await page.click('#rot-orbit'); await page.waitForTimeout(1500);
  const br2 = await page.evaluate(() => window.__map.getBearing());
  await page.click('#rot-orbit'); await page.click('#rot-north'); await page.waitForTimeout(1200);
  const br3 = await page.evaluate(() => window.__map.getBearing());
  await page.uncheck('#terrain');
  check('3D: Karte drehen (45°, Rundflug, Norden)', Math.abs(br - 45) < 2 && br2 > br + 3 && Math.abs(br3) < 1, `${br.toFixed(1)}° → ${br2.toFixed(1)}° → ${br3.toFixed(1)}°`);
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
