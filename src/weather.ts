// Hinweise zum Wasserstand ohne Pegel: übliche Jahreszeit der Region und Abflussregime (Gletscher-,
// Schneeschmelze oder Regen). Die Wetterabfrage (Regen, Schnee der Tage davor) ist seit 26.11.2026
// eingefroren (Nutzerentscheidung) – Code bleibt, wird aber nicht mehr aufgerufen. Bewusst KEINE Abflusszahl – das
// Modell GloFAS lag im Abgleich mit 223 Pegeln meist um ein Mehrfaches daneben (README).
//
// Daten: Open-Meteo, Wetter-Reanalyse ERA5 (archive-api, ab 1940, ~5 Tage Verzug) bzw. für die
// letzten Tage die Wetterdienst-Modelle (api.open-meteo.com, past_days). Kostenlos, CORS offen.
// Die Punkte (Einstieg, Streckenmitte und ein Ring von ~13 km um den Einstieg) stehen grob für das
// Einzugsgebiet oberhalb; das echte Einzugsgebiet ist der App nicht bekannt.

import type { LngLat } from "./geo";

const ARCHIVE = "https://archive-api.open-meteo.com/v1/archive";
const RECENT = "https://api.open-meteo.com/v1/forecast";
const DAYS = 14;

export interface WeatherWindow {
  /** Tage (YYYY-MM-DD), der letzte ist der betrachtete Tag */
  time: string[];
  /** je Punkt: Regen (mm), Schneefall (cm), Tagesmitteltemperatur (°C), Schneehöhe mittags (m) */
  points: { rain: number[]; snowfall: number[]; temp: number[]; snow: number[]; elevation: number }[];
}

export interface Hint {
  text: string;
  /** Wirkung auf den Wasserstand: −1 eher weniger, 0 neutral, +1 mehr, +2 deutlich mehr */
  effect: -1 | 0 | 1 | 2;
}

export interface Conditions {
  date: string;
  hints: Hint[];
  /** Wetterdaten vorhanden? (sonst nur Jahreszeit) */
  weather: boolean;
  /** Tendenz aus Wetter + Jahreszeit (keine Messung) */
  tendency: "eher niedrig" | "unauffällig" | "eher erhöht" | "eher hoch";
}

const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

export function samplePoints(line: LngLat[]): LngLat[] {
  const a = line[0], m = line[Math.floor(line.length / 2)];
  const ring: LngLat[] = [];
  for (let k = 0; k < 4; k++) {
    const t = (k * Math.PI) / 2 + Math.PI / 4;
    ring.push([a[0] + 0.17 * Math.cos(t), a[1] + 0.12 * Math.sin(t)]);
  }
  return [a, m, ...ring];
}

const cache = new Map<string, Promise<WeatherWindow>>();
/** Wetter der `DAYS` Tage bis einschließlich `date` an den Punkten. */
export function weatherBefore(points: LngLat[], date: string, fetchFn: typeof fetch = fetch): Promise<WeatherWindow> {
  const key = `${date}|${points.map((p) => p.map((v) => v.toFixed(2)).join(",")).join(";")}`;
  let p = cache.get(key);
  if (!p) {
    const recent = Date.parse(`${date}T00:00:00Z`) > Date.now() - 6 * 864e5;
    const q =
      `latitude=${points.map((x) => x[1].toFixed(3)).join(",")}&longitude=${points.map((x) => x[0].toFixed(3)).join(",")}` +
      `&daily=rain_sum,snowfall_sum,temperature_2m_mean&hourly=snow_depth&timezone=auto`;
    const url = recent ? `${RECENT}?${q}&past_days=${DAYS}&forecast_days=1` : `${ARCHIVE}?${q}&start_date=${addDays(date, -(DAYS - 1))}&end_date=${date}`;
    p = fetchFn(url)
      .then((r) => {
        if (!r.ok) throw new Error(`Wetterdaten HTTP ${r.status}`);
        return r.json();
      })
      .then((d) => {
        const list = (Array.isArray(d) ? d : [d]) as {
          elevation: number;
          daily: { time: string[]; rain_sum: (number | null)[]; snowfall_sum: (number | null)[]; temperature_2m_mean: (number | null)[] };
          hourly: { time: string[]; snow_depth: (number | null)[] };
        }[];
        const time = list[0].daily.time.filter((t) => t <= date).slice(-DAYS);
        return {
          time,
          points: list.map((x) => {
            const at = (arr: (number | null)[]) => time.map((t) => arr[x.daily.time.indexOf(t)] ?? 0);
            return {
              elevation: x.elevation,
              rain: at(x.daily.rain_sum),
              snowfall: at(x.daily.snowfall_sum),
              temp: at(x.daily.temperature_2m_mean),
              snow: time.map((t) => x.hourly.snow_depth[x.hourly.time.indexOf(`${t}T12:00`)] ?? 0),
            };
          }),
        };
      });
    p.catch(() => cache.delete(key));
    cache.set(key, p);
  }
  return p;
}

const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / Math.max(1, v.length);
const sumLast = (v: number[], n: number) => v.slice(-n).reduce((a, b) => a + b, 0);
const mm = (v: number) => `${Math.round(v)} mm`;

/** Gletschereinfluss: Anteil vergletschert laut Pegel-Stammdaten (%) bzw. Gletscherfläche im Umkreis (km²) */
export interface Glacier {
  pct?: number;
  areaKm2?: number;
}
/** Gletscherfluss? (≥ 2 % vergletschert laut Pegel, sonst ≥ 5 km² Gletscher im Umkreis von 20 km) */
export const isGlacial = (g?: Glacier | null) => !!g && ((g.pct ?? 0) >= 2 || (g.pct === undefined && (g.areaKm2 ?? 0) >= 5));

/** Abflussregime: was den Fluss im Jahreslauf prägt */
export type RegimeKind = "gletscher" | "schnee" | "regen";
export interface Regime { kind: RegimeKind; text: string; /** höchster Punkt des Einzugsgebiets (m), falls bekannt */ maxElev?: number }
/** Höhe, ab der im Winter meist eine Schneedecke liegt, die im Frühjahr abschmilzt (grob nach Breite) */
export function snowElevation(lat: number): number {
  const a = Math.abs(lat);
  return a >= 60 ? 300 : a >= 55 ? 600 : a >= 50 ? 1000 : a >= 45 ? 1300 : a >= 35 ? 1800 : a >= 25 ? 2800 : 4000;
}
const fmtM = (m: number) => `${Math.round(m / 100) * 100} m`.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
/** Gletscher-, Schneeschmelze- oder Regenfluss aus Gletscheranteil und Höhe des Einzugsgebiets */
export function regimeOf(glacier: Glacier | null | undefined, maxElev: number | undefined, lat: number, snowShare?: number): Regime {
  if (isGlacial(glacier)) {
    const g = glacier!;
    const how = g.pct !== undefined ? `${String(Math.round(g.pct * 10) / 10).replace(".", ",")} % des Einzugsgebiets vergletschert` : `~${Math.round(g.areaKm2 ?? 0)} km² Gletscher im Einzugsgebiet`;
    return { kind: "gletscher", maxElev, text: `Gletscherfluss (${how}): im Sommer viel Schmelzwasser, an warmen Tagen abends am meisten.` };
  }
  // mit Einzugsgebiet aus dem Höhenmodell: Anteil der Fläche über der Schneegrenze, sonst nur der höchste Punkt
  const snowy = snowShare !== undefined ? snowShare >= 0.15 : maxElev !== undefined && maxElev >= snowElevation(lat);
  if (snowy && maxElev !== undefined)
    return { kind: "schnee", maxElev, text: `Schneeschmelze prägt den Fluss (${snowShare !== undefined ? `${Math.round(snowShare * 100)} % des Einzugsgebiets über ~${fmtM(snowElevation(lat))}, ` : ""}bis ~${fmtM(maxElev)}): meist am meisten Wasser im Frühjahr/Frühsommer.` };
  return {
    kind: "regen", maxElev,
    text: maxElev !== undefined ? `Regen prägt den Fluss (Einzugsgebiet bis ~${fmtM(maxElev)}, kaum Schneeschmelze): Wasserstand folgt dem Niederschlag.` : "Regime unbekannt (Höhe des Einzugsgebiets nicht ermittelt).",
  };
}

/** Übliche Jahreszeit der Region (Erfahrungswerte, keine Daten des Tages) */
export function seasonHint(p: LngLat, date: string, glacial = false, regime?: RegimeKind): Hint | null {
  const [lon, lat] = p;
  const mo0 = Number(date.slice(5, 7));
  // Südhalbkugel: Jahreszeiten um ein halbes Jahr versetzt
  const mo = lat < 0 ? ((mo0 + 5) % 12) + 1 : mo0;
  const iceland = lat > 63 && lat < 67 && lon > -25 && lon < -13;
  const nordic = !iceland && lat >= 58;
  const alps = lat > 43.5 && lat < 48.6 && lon > 5 && lon < 17;
  // Gletscherflüsse: Hochwasser im Sommer durch Eisschmelze, abends am höchsten
  if (glacial) {
    const peak = iceland || nordic ? mo >= 6 && mo <= 8 : mo >= 6 && mo <= 9;
    if (peak) return { text: "Gletscherfluss im Sommer: viel Schmelzwasser, abends am meisten.", effect: mo === 7 || mo === 8 ? 2 : 1 };
  }
  if (iceland) {
    if (mo >= 6 && mo <= 8) return { text: "Sommer in Island: Gletscherflüsse führen viel Wasser.", effect: 1 };
    if (mo === 5) return { text: "Mai in Island: Schneeschmelze.", effect: 1 };
    if (mo >= 11 || mo <= 3) return { text: "Winter in Island: meist wenig Wasser.", effect: -1 };
    return null;
  }
  if (nordic) {
    if (mo === 5 || mo === 6) return { text: "Mai/Juni im Norden: Schneeschmelze („vårflom“), meist Hochwasserzeit.", effect: 2 };
    if (mo === 7) return { text: "Juli im Norden: Schneeschmelze klingt ab.", effect: 1 };
    if (mo >= 8 && mo <= 10) return { text: "Spätsommer/Herbst im Norden: Wasserstand hängt vom Regen ab.", effect: 0 };
    return { text: "Winter im Norden: meist Niedrigwasser, teils vereist.", effect: -1 };
  }
  if (alps && regime !== "regen") {
    if (mo === 3) return { text: "März in den Alpen: Schneeschmelze beginnt unten.", effect: 0 };
    if (mo >= 4 && mo <= 6) return { text: "April–Juni in den Alpen: Schneeschmelze, meist mehr Wasser.", effect: 1 };
    if (mo === 7 || mo === 8) return { text: "Hochsommer in den Alpen: Wasserstand hängt von Gewittern und Regen ab.", effect: 0 };
    if (mo >= 9 && mo <= 11) return { text: "Herbst in den Alpen: meist niedriger Grundabfluss.", effect: 0 };
    return { text: "Winter in den Alpen: meist Niedrigwasser.", effect: -1 };
  }
  if (regime === "schnee" && !alps) {
    // Schneeschmelze anderswo: Hochwasserzeit nach Breite (Nordhalbkugel-Monate, Süden verschoben)
    const a = Math.abs(lat);
    const [m0, m1] = a < 40 ? [3, 5] : a < 50 ? [4, 6] : [5, 7];
    if (mo >= m0 && mo <= m1) return { text: "Zeit der Schneeschmelze in dieser Region: meist mehr Wasser.", effect: 1 };
    if (mo === m1 + 1) return { text: "Schneeschmelze klingt ab.", effect: 0 };
    if (mo >= 11 || mo <= 2) return { text: "Winter: Schnee bleibt liegen, meist wenig Wasser.", effect: -1 };
    return { text: "Nach der Schneeschmelze: Wasserstand hängt vom Regen ab.", effect: 0 };
  }
  if (lat > 45 && lat < 55 && !alps) {
    if (mo === 12 || mo <= 3) return { text: "Winter/Frühjahr im Mittelgebirge: meist die wasserreichste Zeit.", effect: 1 };
    if (mo >= 7 && mo <= 10) return { text: "Sommer/Herbst im Mittelgebirge: meist die wasserärmste Zeit.", effect: -1 };
  }
  if (alps && regime === "regen") {
    if (mo >= 7 && mo <= 10) return { text: "Voralpenfluss im Sommer/Herbst: Wasserstand hängt vom Regen ab.", effect: 0 };
  }
  return null;
}

/** Temperatur auf `h` m aus der Gitterpunkt-Temperatur (−0,65 °C je 100 m) */
const tempAt = (t: number, elevation: number, h: number) => t - 0.0065 * (h - elevation);

/** Hinweise aus dem Wetter der Tage vor `date` (ohne Jahreszeit) */
/** Reaktionszeit des Flusses nach Gebietsgröße: Tage, in denen Regen voll wirkt, und wie lange er nachwirkt */
export function responseDays(areaKm2?: number) {
  if (!areaKm2 || areaKm2 < 500) return { now: 3, until: 10 };
  if (areaKm2 < 3000) return { now: 4, until: 12 };
  return { now: 6, until: 13 };
}

export function weatherHints(w: WeatherWindow, date = w.time[w.time.length - 1] ?? "", glacial = false, areaKm2?: number): Hint[] {
  const hints: Hint[] = [];
  const n = w.time.length;
  if (!n || !w.points.length) return hints;
  const mo = Number(date.slice(5, 7));
  const rain = w.time.map((_, i) => mean(w.points.map((p) => p.rain[i])));
  const rd = responseDays(areaKm2);
  const r3 = sumLast(rain, rd.now), r7 = sumLast(rain, 7), r14 = sumLast(rain, 14);
  const perPoint = w.points.map((p) => sumLast(p.rain, rd.now));
  const r3max = Math.max(...perPoint);
  // Anteil der Bezugspunkte mit kräftigem Regen: verbreitet (ganzes Gebiet) oder nur örtlich (Gewitter)
  const share = perPoint.filter((v) => v >= 30).length / perPoint.length;
  const temp5 = mean(w.points.map((p) => mean(p.temp.slice(-5))));
  const t2000 = mean(w.points.map((p) => tempAt(mean(p.temp.slice(-5)), p.elevation, 2000)));
  const t3000 = mean(w.points.map((p) => tempAt(mean(p.temp.slice(-5)), p.elevation, 3000)));
  const snowfall7 = mean(w.points.map((p) => sumLast(p.snowfall, 7)));
  // Schneeschmelze: Schneedecke an einem Punkt in einer Woche deutlich geschrumpft bei Plusgraden
  const melt = w.points
    .map((p) => ({ from: p.snow[Math.max(0, n - 8)], to: p.snow[n - 1], t: mean(p.temp.slice(-5)) }))
    .filter((x) => x.from >= 0.1 && x.to <= x.from * 0.75 && x.t > 0)
    .sort((a, b) => b.from - b.to - (a.from - a.to))[0];
  // Starkregen früher im Zeitraum (4–13 Tage vorher): Fluss kann noch erhöht sein
  let heavyEarlier: { ago: number; sum: number } | null = null;
  for (let e = n - 1 - rd.now; e >= Math.max(2, n - rd.until); e--) {
    const s3 = rain[e] + rain[e - 1] + rain[e - 2];
    if (s3 >= 50 && (!heavyEarlier || s3 > heavyEarlier.sum)) heavyEarlier = { ago: n - 1 - e, sum: s3 };
  }
  const deg = (v: number) => `${Math.round(v)} °C`;

  if (r3 >= 30 || share >= 0.5) hints.push({ text: `Kräftiger Regen verbreitet im Gebiet (~${mm(r3)} in ${rd.now} Tagen).`, effect: 2 });
  else if (r3max >= 40) hints.push({ text: `Örtlich kräftiger Regen (bis ~${mm(r3max)}), nicht im ganzen Gebiet.`, effect: 1 });
  else if (heavyEarlier) hints.push({ text: `Starkregen ${heavyEarlier.ago} Tage davor (~${mm(heavyEarlier.sum)}) – evtl. noch erhöht.`, effect: 1 });
  else if (r7 >= 40) hints.push({ text: `Nasse Woche davor (~${mm(r7)} Regen).`, effect: 1 });
  else if (r3 >= 12) hints.push({ text: `Etwas Regen in den Tagen davor (~${mm(r3)}).`, effect: 0 });
  if (melt) hints.push({ text: `Schneeschmelze: Schneedecke schrumpfte von ~${Math.round(melt.from * 100)} auf ~${Math.round(melt.to * 100)} cm.`, effect: melt.from - melt.to >= 0.3 ? 2 : 1 });
  // Tauwetter im Gebirge im Frühjahr (Schnee liegt dort, auch wenn das grobe Wetterraster keinen zeigt)
  const thaw = !melt && mo >= 3 && mo <= 6 && t2000 > 2 && !glacial;
  if (thaw) hints.push({ text: `Tauwetter bis ~2000 m (~${deg(t2000)}) – Schneeschmelze wahrscheinlich.`, effect: 1 });
  // Gletscher: Hitze bzw. Kälte im Hochgebirge steuert die Eisschmelze
  if (glacial && mo >= 5 && mo <= 9) {
    if (t3000 >= 3) hints.push({ text: `Warm im Hochgebirge (~${deg(t3000)} auf 3000 m) – starke Gletscherschmelze.`, effect: 1 });
    else if (t3000 <= -2) hints.push({ text: `Kalt im Hochgebirge (~${deg(t3000)} auf 3000 m) – Gletscherschmelze gebremst.`, effect: -1 });
  }
  if (snowfall7 >= 10 && temp5 < 1) hints.push({ text: `Neuschnee bei Frost (~${Math.round(snowfall7)} cm) – wirkt erst bei Tauwetter.`, effect: 0 });
  if (r14 < 8 && !melt && !thaw && !(glacial && t3000 >= 3)) hints.push({ text: `Zwei Wochen fast trocken (~${mm(r14)}).`, effect: -1 });
  if (!hints.length) hints.push({ text: `Wetter davor unauffällig (~${mm(r7)} Regen in 7 Tagen).`, effect: 0 });
  return hints;
}

export interface Basin {
  /** Fläche des Einzugsgebiets (km²) – steuert die Reaktionszeit */
  areaKm2?: number;
  /** Speicher oder Kraftwerksausleitungen oberhalb (Namen bzw. Beschreibung) */
  regulated?: string[];
}

export function assess(date: string, p: LngLat, w: WeatherWindow | null, glacier?: Glacier | null, basin: Basin = {}, regime?: RegimeKind): Conditions {
  const glacial = isGlacial(glacier);
  const season = seasonHint(p, date, glacial, regime);
  const hints = [...(w ? weatherHints(w, date, glacial, basin.areaKm2) : []), ...(season ? [season] : [])];
  if (basin.regulated?.length)
    hints.push({ text: `Speicher/Kraftwerke oberhalb (${basin.regulated.slice(0, 2).join(", ")}) – Wetter wirkt gedämpft, Schwall möglich.`, effect: 0 });
  const score = hints.reduce((a, h) => a + h.effect, 0);
  const tendency = score >= 3 ? "eher hoch" : score >= 1 ? "eher erhöht" : score <= -1 ? "eher niedrig" : "unauffällig";
  return { date, hints, tendency, weather: !!w };
}

/** Bildart kurz (Uhrzeit veröffentlicht Esri nicht; das Datum genügt für den Wetterbezug) */
export function captureNote(provider: string, name: string): string {
  return /maxar|vantor|digitalglobe|worldview|geoeye|airbus|pl[eé]iades|spot|cnes/i.test(`${provider} ${name}`) ? "Satellitenbild" : "Orthofoto";
}
