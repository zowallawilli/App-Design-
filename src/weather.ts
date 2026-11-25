// Hinweise zum Wasserstand ohne Pegel: Wetter in der Umgebung vor einem Tag (Regen, Schnee,
// Schneeschmelze) und die übliche Jahreszeit der Region. Bewusst KEINE Abflusszahl – das
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

/** Übliche Jahreszeit der Region (Erfahrungswerte, keine Daten des Tages) */
export function seasonHint(p: LngLat, date: string): Hint | null {
  const [lon, lat] = p;
  const mo = Number(date.slice(5, 7));
  const iceland = lat > 63 && lat < 67 && lon > -25 && lon < -13;
  const nordic = !iceland && lat >= 58;
  const alps = lat > 43.5 && lat < 48.6 && lon > 5 && lon < 17;
  if (iceland) {
    if (mo >= 6 && mo <= 8) return { text: "Hochsommer in Island: Gletscherflüsse führen von Juni bis August am meisten Wasser, nachmittags und abends mehr als morgens.", effect: 1 };
    if (mo === 5) return { text: "Mai in Island: Schneeschmelze, die Flüsse steigen.", effect: 1 };
    if (mo >= 11 || mo <= 3) return { text: "Winter in Island: Niederschlag bleibt meist als Schnee/Eis liegen – eher wenig Wasser (Tauwetter-Ausnahmen).", effect: -1 };
    return null;
  }
  if (nordic) {
    if (mo === 5 || mo === 6) return { text: "Mai/Juni im Norden: Schneeschmelze (Frühjahrshochwasser, „vårflom“) – die Flüsse führen erfahrungsgemäß am meisten Wasser.", effect: 2 };
    if (mo === 7) return { text: "Juli im Norden: Die Schneeschmelze klingt ab, in hohen Lagen und Gletscherflüssen noch viel Wasser.", effect: 1 };
    if (mo >= 8 && mo <= 10) return { text: "Spätsommer/Herbst im Norden: Wasserstand hängt vor allem vom Regen ab.", effect: 0 };
    return { text: "Winter im Norden: Niederschlag als Schnee, Flüsse teils vereist – üblicherweise Niedrigwasser.", effect: -1 };
  }
  if (alps) {
    if (mo === 3) return { text: "März in den Alpen: Die Schneeschmelze beginnt in tieferen Lagen; hoch oben liegt noch Schnee.", effect: 0 };
    if (mo >= 4 && mo <= 6) return { text: "April bis Juni in den Alpen: Schneeschmelze – die Flüsse führen erfahrungsgemäß deutlich mehr Wasser, oft mit Tagesgang (nachmittags/abends mehr).", effect: 1 };
    if (mo === 7 || mo === 8) return { text: "Hochsommer in den Alpen: Gletscherbäche führen viel Wasser (nachmittags am meisten), sonst entscheiden Gewitter und Regen.", effect: 0 };
    if (mo === 9) return { text: "September in den Alpen: Die Gletscherschmelze klingt ab, der Grundabfluss sinkt; nach Starkregen steigen die Flüsse schnell.", effect: 0 };
    if (mo >= 10 && mo <= 11) return { text: "Herbst in den Alpen: meist niedriger Grundabfluss; nach Starkregen steigen die Flüsse schnell.", effect: 0 };
    return { text: "Winter in den Alpen: Niederschlag fällt oben als Schnee – üblicherweise Niedrigwasser.", effect: -1 };
  }
  if (lat > 45 && lat < 55) {
    if (mo === 12 || mo <= 3) return { text: "Winter/Frühjahr im Mittelgebirge: Regen und Schneeschmelze – meist die wasserreichste Zeit.", effect: 1 };
    if (mo >= 7 && mo <= 10) return { text: "Sommer/Herbst im Mittelgebirge: meist die wasserärmste Zeit, außer nach Starkregen.", effect: -1 };
  }
  return null;
}

/** Hinweise aus dem Wetter der Tage vor `date` (ohne Jahreszeit) */
export function weatherHints(w: WeatherWindow): Hint[] {
  const hints: Hint[] = [];
  const n = w.time.length;
  if (!n || !w.points.length) return hints;
  const rain = w.time.map((_, i) => mean(w.points.map((p) => p.rain[i])));
  const r3 = sumLast(rain, 3), r7 = sumLast(rain, 7), r14 = sumLast(rain, 14);
  const r3max = Math.max(...w.points.map((p) => sumLast(p.rain, 3)));
  const temp5 = mean(w.points.map((p) => mean(p.temp.slice(-5))));
  const snowfall7 = mean(w.points.map((p) => sumLast(p.snowfall, 7)));
  // Schneeschmelze: Schneedecke an einem Punkt in einer Woche deutlich geschrumpft bei Plusgraden
  const melt = w.points
    .map((p) => ({ from: p.snow[Math.max(0, n - 8)], to: p.snow[n - 1], t: mean(p.temp.slice(-5)), el: p.elevation }))
    .filter((x) => x.from >= 0.1 && x.to <= x.from * 0.75 && x.t > 0)
    .sort((a, b) => b.from - b.to - (a.from - a.to))[0];
  // Starkregen früher im Zeitraum (4–13 Tage vorher): Fluss kann noch erhöht sein
  let heavyEarlier: { ago: number; sum: number } | null = null;
  for (let e = n - 4; e >= 2; e--) {
    const s3 = rain[e] + rain[e - 1] + rain[e - 2];
    if (s3 >= 50 && (!heavyEarlier || s3 > heavyEarlier.sum)) heavyEarlier = { ago: n - 1 - e, sum: s3 };
  }
  const snowNow = Math.max(...w.points.map((p) => p.snow[n - 1]));

  if (r3 >= 30 || r3max >= 50)
    hints.push({ text: `Kräftiger Regen in den drei Tagen davor (Ø ~${mm(r3)} im Umkreis, örtlich bis ~${mm(r3max)}) – der Fluss führte vermutlich deutlich mehr Wasser als üblich.`, effect: 2 });
  else if (heavyEarlier) hints.push({ text: `Starkregen ${heavyEarlier.ago} Tage vor der Aufnahme (~${mm(heavyEarlier.sum)} in 3 Tagen) – der Fluss kann noch erhöht gewesen sein (Wasser geht zurück).`, effect: 1 });
  else if (r7 >= 40) hints.push({ text: `Nasse Woche davor (~${mm(r7)} Regen in 7 Tagen) – eher erhöhter Wasserstand.`, effect: 1 });
  else if (r3 >= 12) hints.push({ text: `Etwas Regen in den Tagen davor (~${mm(r3)} in 3 Tagen) – kleinere Flüsse können leicht erhöht sein.`, effect: 0 });
  if (melt)
    hints.push({
      text: `Schneeschmelze im Gange: Die Schneedecke im Umkreis (~${Math.round(melt.el)} m) schrumpfte in einer Woche von ~${Math.round(melt.from * 100)} auf ~${Math.round(melt.to * 100)} cm bei Plusgraden – erhöht den Abfluss, meist mit Tagesgang.`,
      effect: melt.from - melt.to >= 0.3 ? 2 : 1,
    });
  if (snowfall7 >= 10 && temp5 < 1)
    hints.push({ text: `Niederschlag fiel als Schnee (~${Math.round(snowfall7)} cm in 7 Tagen) bei Frost – erhöht den Abfluss erst bei Tauwetter.`, effect: 0 });
  if (r14 < 8 && !melt)
    hints.push({ text: `Fast trocken in den zwei Wochen davor (~${mm(r14)} Regen)${snowNow > 0.05 ? ", Schnee taut nicht" : ""} – eher niedriger Wasserstand.`, effect: -1 });
  if (!hints.length) hints.push({ text: `Wetter davor unauffällig (~${mm(r7)} Regen in 7 Tagen, keine Schneeschmelze erkennbar).`, effect: 0 });
  return hints;
}

export function assess(date: string, p: LngLat, w: WeatherWindow | null): Conditions {
  const season = seasonHint(p, date);
  const hints = [...(w ? weatherHints(w) : []), ...(season ? [season] : [])];
  // Wetter des Tages zählt voll, die Jahreszeit nur als Grundlage
  const score = hints.reduce((a, h) => a + h.effect, 0);
  const tendency = score >= 3 ? "eher hoch" : score >= 1 ? "eher erhöht" : score <= -1 ? "eher niedrig" : "unauffällig";
  return { date, hints, tendency, weather: !!w };
}

/** Wie wurde das Bild aufgenommen? Uhrzeit veröffentlicht Esri nicht – nur Erfahrungswerte. */
export function captureNote(provider: string, name: string): string {
  const s = `${provider} ${name}`;
  if (/maxar|vantor|digitalglobe|worldview|geoeye|airbus|pl[eé]iades|spot|cnes/i.test(s))
    return "Satellitenbild – Uhrzeit nicht veröffentlicht; diese Satelliten überfliegen Europa meist am Vormittag (etwa 10–12 Uhr Ortszeit).";
  return "Luftbild-Befliegung (Orthofoto) – Uhrzeit nicht veröffentlicht; Befliegungen meist bei hohem Sonnenstand (Vormittag bis früher Nachmittag). Das Datum gilt für diesen Bildteil, Nachbarabschnitte können an anderen Tagen beflogen sein.";
}
