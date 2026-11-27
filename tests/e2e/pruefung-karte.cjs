// Prüfhilfe: Kartenhintergründe, 3D und hohe Zoomstufen einzeln (node tests/e2e/pruefung-karte.cjs)
const { chromium } = require('playwright');
const path = require('path');
const { open, view, OUT } = require('./pruefung.cjs');
const stat = async (page, f) => { const b = await page.screenshot({ path: path.join(OUT, f) }); return f; };
async function blank(page) { return page.evaluate(() => { const c = document.querySelector('#map canvas'); const g = c.getContext('webgl2') || c.getContext('webgl'); return null; }); }
(async () => {
  const proxy = process.env.HTTPS_PROXY;
  const browser = await chromium.launch({ proxy: proxy ? { server: proxy, bypass: 'localhost,127.0.0.1' } : undefined, args: ['--ignore-certificate-errors'] });
  const cases = [
    ['a-esri-z15', async (p) => { await view(p, [13.5815, 46.349], 15); }],
    ['b-s2', async (p) => { await view(p, [13.5815, 46.349], 13); await p.click('[data-base="s2"]'); }],
    ['c-topo', async (p) => { await view(p, [13.5815, 46.349], 13); await p.click('[data-base="topo"]'); }],
    ['d-3d', async (p) => { await view(p, [13.5815, 46.349], 14); await p.check('#terrain'); }],
    ['e-esri-z18', async (p) => { await view(p, [13.5815, 46.349], 18); }],
    ['f-esri-z19', async (p) => { await view(p, [13.5815, 46.349], 19); }],
    ['g-charyn-z18', async (p) => { await view(p, [79.13, 43.38], 18); }],
    ['h-charyn-z19', async (p) => { await view(p, [79.13, 43.38], 19); }],
    ['i-3d-aus-z18', async (p) => { await view(p, [13.5815, 46.349], 14); await p.check('#terrain'); await p.waitForTimeout(3000); await p.uncheck('#terrain'); await view(p, [13.5815, 46.349], 18); }],
  ];
  for (const [n, fn] of cases) {
    const { ctx, page, log } = await open(browser);
    await fn(page); await page.waitForTimeout(6000);
    await page.screenshot({ path: path.join(OUT, `19-karte-${n}.png`) });
    const kopf = (await page.textContent('#img-date')) || '';
    const layers = await page.evaluate(() => window.__map.getStyle().layers.filter((l) => l.type === 'raster').map((l) => `${l.id}:${window.__map.getLayoutProperty(l.id, 'visibility') ?? 'visible'}`));
    console.log(n, '| Kopf:', kopf, '| Raster:', layers.join(','), '| Fehler:', [...new Set([...log.failed, ...log.http].map((x) => x.split(' ').slice(0, 2).join(' ')))].slice(0, 6).join('; '), '| pageerror:', log.pageerror.slice(0, 2).join(';'));
    await ctx.close();
  }
  await browser.close();
})();
