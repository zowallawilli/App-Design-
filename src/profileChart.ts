// Längsprofil als SVG mit Hover-Kopplung zur Karte.

import type { Analysis } from "./analysis";

const NS = "http://www.w3.org/2000/svg";

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, parent?: Element) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  parent?.appendChild(e);
  return e;
}

function niceStep(range: number, target: number) {
  const raw = range / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const n = raw / mag;
  return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * mag;
}

export function renderProfile(
  container: HTMLElement,
  a: Analysis,
  onHover: (d: number | null) => void,
): { highlight: (d: number | null) => void } {
  container.innerHTML = "";
  const W = container.clientWidth || 600;
  const H = container.clientHeight || 220;
  const m = { l: 48, r: 12, t: 12, b: 34 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const svg = el("svg", { width: W, height: H, viewBox: `0 0 ${W} ${H}`, class: "profile-svg", role: "img", "aria-label": "Längsprofil" }, container);

  const zs = a.profile.flatMap((p) => [p.z, p.floor]);
  let zMin = Math.min(...zs), zMax = Math.max(...zs);
  const pad = Math.max(5, (zMax - zMin) * 0.06);
  zMin -= pad; zMax += pad;
  const x = (d: number) => m.l + (d / a.length) * iw;
  const y = (z: number) => m.t + (1 - (z - zMin) / (zMax - zMin)) * ih;

  // Gitter & Achsen
  const g = el("g", { class: "axes" }, svg);
  const zStep = niceStep(zMax - zMin, 4);
  for (let z = Math.ceil(zMin / zStep) * zStep; z <= zMax; z += zStep) {
    el("line", { x1: m.l, x2: W - m.r, y1: y(z), y2: y(z), class: "grid" }, g);
    el("text", { x: m.l - 6, y: y(z) + 4, "text-anchor": "end" }, g).textContent = `${Math.round(z)}`;
  }
  const dStep = niceStep(a.length / 1000, 6) * 1000;
  for (let d = 0; d <= a.length + 1; d += dStep) {
    el("text", { x: x(d), y: H - m.b + 16, "text-anchor": "middle" }, g).textContent = `${(d / 1000).toFixed(dStep < 1000 ? 1 : 0)}`;
  }
  el("text", { x: W - m.r, y: H - 4, "text-anchor": "end", class: "axis-label" }, g).textContent = "km ab Einstieg";
  el("text", { x: 4, y: m.t + 2, "dominant-baseline": "hanging", class: "axis-label" }, g).textContent = "m ü. M.";

  // Hotspots
  for (const h of a.hotspots) {
    el("rect", { x: x(h.d0), y: m.t, width: Math.max(2, x(h.d1) - x(h.d0)), height: ih, class: "hotspot-band" }, svg);
  }

  // Abschnittsflächen nach Gefälleklasse
  for (const s of a.segments) {
    const pts = a.profile.filter((p) => p.d >= s.d0 - 1e-6 && p.d <= s.d1 + 1e-6);
    if (pts.length < 2) continue;
    const top = pts.map((p) => `${x(p.d)},${y(p.z)}`).join(" ");
    el("polygon", { points: `${x(pts[0].d)},${m.t + ih} ${top} ${x(pts[pts.length - 1].d)},${m.t + ih}`, fill: s.cls.color, class: "seg-area" }, svg);
  }

  // Rohdaten und geglättetes Profil
  el("polyline", { points: a.profile.map((p) => `${x(p.d)},${y(p.floor)}`).join(" "), class: "raw-line" }, svg);
  el("polyline", { points: a.profile.map((p) => `${x(p.d)},${y(p.z)}`).join(" "), class: "z-line" }, svg);

  // Hover
  const cursor = el("line", { y1: m.t, y2: m.t + ih, class: "cursor", visibility: "hidden" }, svg);
  const tip = el("text", { y: m.t + 14, class: "tip", visibility: "hidden" }, svg);
  const highlight = (d: number | null) => {
    if (d === null) {
      cursor.setAttribute("visibility", "hidden");
      tip.setAttribute("visibility", "hidden");
      return;
    }
    const seg = a.segments.find((s) => d >= s.d0 && d <= s.d1) ?? a.segments[a.segments.length - 1];
    const p = a.profile.reduce((b, q) => (Math.abs(q.d - d) < Math.abs(b.d - d) ? q : b));
    const cx = x(d);
    cursor.setAttribute("x1", String(cx));
    cursor.setAttribute("x2", String(cx));
    cursor.setAttribute("visibility", "visible");
    const right = cx > m.l + iw * 0.6;
    tip.setAttribute("x", String(right ? cx - 6 : cx + 6));
    tip.setAttribute("text-anchor", right ? "end" : "start");
    tip.textContent = `km ${(d / 1000).toFixed(2)} · ${Math.round(p.z)} m · ${seg.gradient.toFixed(1)} m/km`;
    tip.setAttribute("visibility", "visible");
  };
  const hit = el("rect", { x: m.l, y: m.t, width: iw, height: ih, fill: "transparent" }, svg);
  hit.addEventListener("pointermove", (ev) => {
    const r = svg.getBoundingClientRect();
    const d = Math.max(0, Math.min(a.length, (((ev.clientX - r.left) * (W / r.width) - m.l) / iw) * a.length));
    highlight(d);
    onHover(d);
  });
  hit.addEventListener("pointerleave", () => {
    highlight(null);
    onHover(null);
  });
  return { highlight };
}
