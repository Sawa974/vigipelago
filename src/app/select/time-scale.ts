import type { Interval } from '../ingest/coverage';

// Compressee, l'axe ne porte que le temps ecoute : les coupures deviennent des bandes de `gapPx`.

export interface ScaleSegment {
  from: number;
  to: number;
  px: number;
  w: number;
}

export interface TimeScale {
  /** Une seule tranche en lineaire. */
  segs: ScaleSegment[];
  gapPx: number;
}

export function coveredWithin(coverage: readonly Interval[], window: Interval): Interval[] {
  const out: Interval[] = [];
  for (const c of coverage) {
    const from = Math.max(c.from, window.from);
    const to = Math.min(c.to, window.to);
    if (to > from) out.push({ from, to });
  }
  return out.sort((a, b) => a.from - b.from);
}

/** Ne doit rien lire de la geometrie : un cycle de signaux viderait l'onglet, sans erreur. */
export function axisSpan(
  coverage: readonly Interval[],
  window: Interval,
  compress: boolean,
): number {
  const full = Math.max(1, window.to - window.from);
  if (!compress) return full;
  const covered = coveredWithin(coverage, window).reduce((sum, c) => sum + (c.to - c.from), 0);
  return covered > 0 ? covered : full;
}

export function buildTimeScale(opts: {
  coverage: readonly Interval[];
  window: Interval;
  left: number;
  width: number;
  compress: boolean;
  gapPx: number;
}): TimeScale {
  const { window: w, left, width, compress } = opts;
  const linear: TimeScale = {
    segs: [{ from: w.from, to: w.to, px: left, w: width }],
    gapPx: 0,
  };
  if (!compress) return linear;

  const cov = coveredWithin(opts.coverage, w);
  if (!cov.length) return linear;

  // Les bandes ne prennent jamais plus de la moitie de la largeur.
  const bands = cov.length - 1;
  const gapPx = bands ? Math.min(opts.gapPx, width / 2 / bands) : 0;
  const budget = Math.max(1, width - bands * gapPx);
  const total = cov.reduce((sum, c) => sum + (c.to - c.from), 0) || 1;

  let cursor = left;
  const segs = cov.map((c) => {
    const segW = ((c.to - c.from) / total) * budget;
    const seg: ScaleSegment = { from: c.from, to: c.to, px: cursor, w: segW };
    cursor += segW + gapPx;
    return seg;
  });
  return { segs, gapPx };
}

/** Borne au bord le plus proche hors des tranches portees. */
export function scaleX(scale: TimeScale, t: number): number {
  const segs = scale.segs;
  if (t <= segs[0].from) return segs[0].px;

  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (t <= s.to) {
      const span = Math.max(1, s.to - s.from);
      return s.px + ((t - s.from) / span) * s.w;
    }
    const next = segs[i + 1];
    if (!next) break;
    if (t < next.from) {
      const span = Math.max(1, next.from - s.to);
      return s.px + s.w + ((t - s.to) / span) * scale.gapPx;
    }
  }
  const last = segs[segs.length - 1];
  return last.px + last.w;
}

/** Dans une coupure, rend le debut de la tranche suivante : le curseur ne s'y pose jamais. */
export function scaleInvert(scale: TimeScale, px: number): number {
  const segs = scale.segs;
  if (px <= segs[0].px) return segs[0].from;

  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (px <= s.px + s.w) {
      return s.from + ((px - s.px) / Math.max(1, s.w)) * (s.to - s.from);
    }
    const next = segs[i + 1];
    if (!next) break;
    if (px < next.px) return next.from;
  }
  const last = segs[segs.length - 1];
  return last.to;
}

export function inGap(scale: TimeScale, t: number): boolean {
  const segs = scale.segs;
  for (const s of segs) {
    if (t >= s.from && t <= s.to) return false;
  }
  return t > segs[0].from && t < segs[segs.length - 1].to;
}
