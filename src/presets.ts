// Referenzabschnitte. Koordinaten werden beim Laden auf die OSM-Flusslinie gesnappt.

import type { LngLat } from "./geo";

export interface Preset {
  id: string;
  name: string;
  description: string;
  /** Punkt auf/nahe dem Fluss zum Laden der Geometrie */
  seed: LngLat;
  putIn: LngLat;
  takeOut: LngLat;
  zoom: number;
}

export const PRESETS: Preset[] = [
  {
    id: "soca-trenta-kobarid",
    name: "Soča · Trenta (Na Logu) – Kobarid",
    description:
      "Referenzfluss: steiler Oberlauf mit Klammen, Bovecer Becken, dann der Abschnitt über Srpenica bis Kobarid.",
    seed: [13.6239, 46.338],
    putIn: [13.7502, 46.3815],
    takeOut: [13.5863, 46.2477],
    zoom: 11,
  },
  {
    id: "soca-oberlauf",
    name: "Soča · Oberlauf Na Logu – Čezsoča",
    description: "Trenta-Tal und Dorf Soča bis ins Bovecer Becken.",
    seed: [13.6239, 46.338],
    putIn: [13.7502, 46.3815],
    takeOut: [13.5583, 46.3238],
    zoom: 12,
  },
  {
    id: "soca-cezsoca-kobarid",
    name: "Soča · Čezsoča – Kobarid",
    description: "Mittel- und Unterlauf über Žaga und Srpenica bis Kobarid.",
    seed: [13.5195, 46.3206],
    putIn: [13.5583, 46.3238],
    takeOut: [13.5863, 46.2477],
    zoom: 11,
  },
];
