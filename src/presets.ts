// Referenzabschnitte. Koordinaten werden beim Laden auf die OSM-Flusslinie gesnappt.

import type { LngLat } from "./geo";

export interface Preset {
  id: string;
  name: string;
  description: string;
  /** Schwierigkeit laut Literatur (zum Vergleich mit der Gefälleanalyse) */
  literature?: string;
  /** Kartenmitte beim Laden */
  seed: LngLat;
  putIn: LngLat;
  takeOut: LngLat;
  zoom: number;
}

// Orte entlang der Soča; Flusspunkte aus dem nachgezogenen Verlauf bzw. Ortslagen (Wikipedia)
const NA_LOGU: LngLat = [13.7502, 46.3815];
const SOCA_DORF: LngLat = [13.6532, 46.3402]; // Flusspunkt beim Dorf Soča
const CEZSOCA: LngLat = [13.5583, 46.3238];
const SRPENICA: LngLat = [13.5024, 46.2956];
const TRNOVO: LngLat = [13.5562, 46.282]; // Flusspunkt bei Trnovo ob Soči
const KOBARID: LngLat = [13.5863, 46.2477];

// Sjoa (Norwegen): Abschnittsgrenzen nach Rafting-Anbietern, auf den Flusslauf gesetzt
const RIDDER: LngLat = [9.0763, 61.6821];
const ASENG_IN: LngLat = [9.1754, 61.7042];
const ASENG_OUT: LngLat = [9.3016, 61.7517];
const AMOT_IN: LngLat = [9.4806, 61.6878];
const SJOA_MOUTH: LngLat = [9.5413, 61.6818];

export const PRESETS: Preset[] = [
  {
    id: "soca-trenta-kobarid",
    name: "Soča · Na Logu – Kobarid (gesamt)",
    description: "Referenzfluss über alle klassischen Abschnitte: Trenta, Velika Korita, Bovecer Becken, Srpenica, Trnovo-Schlucht, Kobarid.",
    literature: "WW I–V je nach Abschnitt",
    seed: [13.63, 46.31],
    putIn: NA_LOGU,
    takeOut: KOBARID,
    zoom: 11,
  },
  {
    id: "soca-trenta",
    name: "Soča · Trenta: Na Logu – Soča (Dorf)",
    description: "Oberlauf im Trenta-Tal, wenig Wasser, steinig.",
    literature: "WW I–II, steinig (Oberlauf)",
    seed: [13.70, 46.36],
    putIn: NA_LOGU,
    takeOut: SOCA_DORF,
    zoom: 12,
  },
  {
    id: "soca-korita",
    name: "Soča · Soča (Dorf) – Čezsoča",
    description: "Mit der Velika-Korita-Klamm (750 m lang, 15 m tief, wenige Meter breit) und dem Abschnitt Lepena – Kršovec.",
    literature: "WW II–IV; Velika Korita nur Experten",
    seed: [13.60, 46.33],
    putIn: SOCA_DORF,
    takeOut: CEZSOCA,
    zoom: 12,
  },
  {
    id: "soca-cezsoca-srpenica",
    name: "Soča · Čezsoča – Srpenica",
    description: "Anfängerstrecke über Boka und Žaga.",
    literature: "WW I–II (teils II–III angegeben)",
    seed: [13.51, 46.31],
    putIn: CEZSOCA,
    takeOut: SRPENICA,
    zoom: 12,
  },
  {
    id: "soca-srpenica-trnovo",
    name: "Soča · Srpenica – Trnovo",
    description: "Klassische kommerzielle Strecke mit technischen Stufen.",
    literature: "WW II–III+, bei Hochwasser IV",
    seed: [13.53, 46.29],
    putIn: SRPENICA,
    takeOut: TRNOVO,
    zoom: 13,
  },
  {
    id: "soca-trnovo-kobarid",
    name: "Soča · Trnovo – Kobarid",
    description: "Trnovo-Schlucht („Katarakt“), danach Otona bis Kobarid.",
    literature: "Katarakt WW IV–V+ (nur Experten); Otona – Kobarid WW III–IV",
    seed: [13.57, 46.265],
    putIn: TRNOVO,
    takeOut: KOBARID,
    zoom: 13,
  },
  {
    id: "sjoa-ridderspranget",
    name: "Sjoa · Ridderspranget – Åsengjuvet-Einstieg",
    description: "Oberste Sjoa-Strecke ab der Ridderspranget-Klamm (drei Fälle am Einstieg).",
    literature: "WW 5 bei Ridderspranget",
    seed: [9.12, 61.69],
    putIn: RIDDER,
    takeOut: ASENG_IN,
    zoom: 12,
  },
  {
    id: "sjoa-asengjuvet",
    name: "Sjoa · Åsengjuvet",
    description: "12 km durchgehende Schluchtstrecke, anspruchsvoll und schwer verlassbar.",
    literature: "WW 3–4 (+), bei viel Wasser schwerer",
    seed: [9.24, 61.73],
    putIn: ASENG_IN,
    takeOut: ASENG_OUT,
    zoom: 12,
  },
  {
    id: "sjoa-playrun",
    name: "Sjoa · Playrun (Heidal)",
    description: "Klassische Raft- und Kajakstrecke durch Heidal (Faukstad, China Hole, Washing Machine).",
    literature: "WW 2–3",
    seed: [9.39, 61.72],
    putIn: ASENG_OUT,
    takeOut: AMOT_IN,
    zoom: 12,
  },
  {
    id: "sjoa-amot",
    name: "Sjoa · Åmot – Mündung",
    description: "Åmot-Schlucht bis zur Mündung in die Gudbrandsdalslågen bei Sjoa.",
    literature: "WW 4, bei Hochwasser fast 5",
    seed: [9.51, 61.685],
    putIn: AMOT_IN,
    takeOut: SJOA_MOUTH,
    zoom: 13,
  },
  {
    id: "koritnica",
    name: "Koritnica · Kluže – Mündung",
    description: "Einstieg am Ende der Kluže-Schlucht (die Schlucht selbst ist nicht befahrbar: wenige Meter breit, 70 m tief).",
    literature: "WW III/IV",
    seed: [13.575, 46.336],
    putIn: [13.5906, 46.3598],
    takeOut: [13.5694, 46.3242],
    zoom: 14,
  },
  {
    id: "jokulsa-dettifoss",
    name: "Jökulsá á Fjöllum · Selfoss – Dettifoss – Hafragilsfoss",
    description: "Drei große Wasserfälle des Gletscherflusses (Island) – Prüfstrecke für Gefahrenstellen/Abbruchkanten im offenen NÁTT-Luftbild. Nicht befahrbar.",
    literature: "Selfoss ~11 m, Dettifoss ~44 m, Hafragilsfoss ~27 m",
    seed: [-16.392, 65.82],
    putIn: [-16.379, 65.7965],
    takeOut: [-16.4005, 65.8372],
    zoom: 13,
  },
];
