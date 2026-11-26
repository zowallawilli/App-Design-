// Kleine Strich-Symbole (24×24, weiß auf farbigem Grund) für eigene und OSM-Stellen –
// sprachunabhängig statt Buchstaben (Nutzerwunsch 26.11.2026).

const P: Record<string, string> = {
  welle: '<path d="M2 9c2.5-3 5-3 7.5 0s5 3 7.5 0 3.5-2 5-1"/><path d="M2 16c2.5-3 5-3 7.5 0s5 3 7.5 0 3.5-2 5-1"/>',
  walze: '<path d="M17.5 9.5A6.5 6.5 0 1 0 18 15"/><path d="M18.5 4.5v5h-5"/>',
  wehr: '<path d="M3 8h18"/><path d="M6 8v5M12 8v5M18 8v5"/><path d="M2 18c2.5-2 5-2 7.5 0s5 2 7.5 0 3.5-1.5 5-1"/>',
  wasserfall: '<path d="M3 5h8v15"/><path d="M14 8v9M17.5 8v12M21 8v7"/>',
  damm: '<path d="M5 5l3 15h8l3-15z"/><path d="M2 9h3M19 9h3"/>',
  schleuse: '<path d="M5 3v18M19 3v18"/><path d="M5 12h14"/><path d="M9 7l3 3 3-3"/>',
  gefahr: '<path d="M12 3l10 18H2z"/><path d="M12 10v5"/><path d="M12 18v.5"/>',
  baum: '<path d="M12 2l-6 9h3.5L5 17h14l-4.5-6H18z"/><path d="M12 17v5"/>',
  zelt: '<path d="M3 20L12 4l9 16z"/><path d="M12 4v16"/><path d="M9 20l3-6 3 6"/>',
  tragen: '<path d="M3 7q9-6 18 0"/><circle cx="12" cy="10" r="1.3"/><path d="M12 12v4M12 16l-3 5M12 16l3 5M8.5 9.5L12 13l3.5-3.5"/>',
  zugang: '<path d="M5 4l7 7"/><path d="M12 5v6H6"/><path d="M2 18c2.5-2 5-2 7.5 0s5 2 7.5 0 3.5-1.5 5-1"/>',
  einstieg: '<path d="M12 3v10"/><path d="M8 9l4 4 4-4"/><path d="M2 18c2.5-2 5-2 7.5 0s5 2 7.5 0 3.5-1.5 5-1"/>',
  ausstieg: '<path d="M12 14V4"/><path d="M8 8l4-4 4 4"/><path d="M2 18c2.5-2 5-2 7.5 0s5 2 7.5 0 3.5-1.5 5-1"/>',
  notiz: '<path d="M4 4h16v11h-9l-4 4v-4H4z"/><path d="M8 8.5h8M8 11.5h5"/>',
  kreuz: '<path d="M6 6l12 12M18 6L6 18"/>',
};

export type IconName = keyof typeof P;

/** SVG-Symbol als HTML */
export function icon(name: IconName | string, size = 15, color = "#fff"): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] ?? P.notiz}</svg>`;
}

/** Symbol je Art einer eigenen Stelle (LabelKind) */
export const KIND_ICON: Record<string, IconName> = {
  schwall: "welle", walze: "walze", wehr: "wehr", gefahr: "welle", holz: "baum", umtragen: "tragen",
  zugang: "zugang", lager: "zelt", notiz: "notiz", kiesbank: "kreuz", bruecke: "kreuz", ruhig: "kreuz", sonstiges: "kreuz",
};

/** Symbol je Art einer OSM-Stelle */
export const OSM_ICON_NAME: Record<string, IconName> = {
  rapid: "welle", waterfall: "wasserfall", weir: "wehr", dam: "damm", lock: "schleuse", hazard: "gefahr",
  put_in: "einstieg", egress: "ausstieg", access: "zugang", portage: "tragen",
};
