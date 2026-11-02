import { describe, expect, it } from 'vitest';
import { axisSpan, buildTimeScale, inGap, scaleInvert, scaleX } from './time-scale';

const H = 3600_000;
/** Deux seances de 7 h separees par 16 h d'arret. */
const DEUX_SEANCES = [
  { from: 0, to: 7 * H },
  { from: 23 * H, to: 30 * H },
];
const WIN = { from: 0, to: 30 * H };
const LAYOUT = { left: 100, width: 900, gapPx: 10 };
const COLLE = { left: 100, width: 900, gapPx: 0 };

describe('buildTimeScale, mode lineaire', () => {
  it('rend une seule tranche, la fenetre entiere', () => {
    const sc = buildTimeScale({ ...LAYOUT, coverage: DEUX_SEANCES, window: WIN, compress: false });
    expect(sc.segs).toEqual([{ from: 0, to: 30 * H, px: 100, w: 900 }]);
    expect(sc.gapPx).toBe(0);
    expect(scaleX(sc, 7 * H) - scaleX(sc, 0)).toBeCloseTo(210, 0);
    expect(scaleX(sc, 23 * H) - scaleX(sc, 7 * H)).toBeCloseTo(480, 0);
  });
});

describe('buildTimeScale, mode compresse', () => {
  const sc = buildTimeScale({ ...LAYOUT, coverage: DEUX_SEANCES, window: WIN, compress: true });

  it('ne porte que le temps ecoute, et une bande pour la coupure', () => {
    expect(sc.gapPx).toBe(10);
    expect(sc.segs.map((s) => [s.px, Math.round(s.w)])).toEqual([
      [100, 445],
      [555, 445],
    ]);
  });

  it('colle les deux seances a la largeur de la bande', () => {
    expect(scaleX(sc, 23 * H) - scaleX(sc, 7 * H)).toBeCloseTo(10, 5);
  });

  it('situe un instant dans la coupure sans le sortir de sa bande', () => {
    const milieu = scaleX(sc, 15 * H);
    expect(milieu).toBeGreaterThan(scaleX(sc, 7 * H));
    expect(milieu).toBeLessThan(scaleX(sc, 23 * H));
  });

  it('retire aussi le temps mort des bords', () => {
    const tardif = buildTimeScale({
      ...LAYOUT,
      coverage: [{ from: 5 * H, to: 12 * H }],
      window: { from: 0, to: 12 * H },
      compress: true,
    });
    expect(scaleX(tardif, 5 * H)).toBe(100);
    expect(scaleX(tardif, 12 * H)).toBeCloseTo(1000, 5);
  });

  it('borne les instants hors des tranches au bord le plus proche', () => {
    expect(scaleX(sc, -10 * H)).toBe(100);
    expect(scaleX(sc, 99 * H)).toBeCloseTo(1000, 5);
  });

  it('retombe en lineaire sans couverture connue', () => {
    const vide = buildTimeScale({ ...LAYOUT, coverage: [], window: WIN, compress: true });
    expect(vide.segs).toHaveLength(1);
    expect(vide.gapPx).toBe(0);
  });

  it('plafonne les bandes a la moitie de la largeur', () => {
    const hache = buildTimeScale({
      ...LAYOUT,
      coverage: Array.from({ length: 200 }, (_, i) => ({ from: i * 2 * H, to: i * 2 * H + H })),
      window: { from: 0, to: 400 * H },
      compress: true,
    });
    const total = 199 * hache.gapPx;
    expect(total).toBeLessThanOrEqual(450);
  });
});

describe('buildTimeScale, sans bande', () => {
  const sc = buildTimeScale({ ...COLLE, coverage: DEUX_SEANCES, window: WIN, compress: true });

  it('colle les deux seances bord a bord', () => {
    expect(sc.gapPx).toBe(0);
    expect(scaleX(sc, 7 * H)).toBeCloseTo(scaleX(sc, 23 * H), 5);
    expect(sc.segs.map((seg) => [seg.px, Math.round(seg.w)])).toEqual([
      [100, 450],
      [550, 450],
    ]);
  });

  it('place tout instant de la coupure sur la jonction', () => {
    expect(scaleX(sc, 15 * H)).toBeCloseTo(550, 5);
  });

  it('reconnait toujours la coupure, ce qui retire ses graduations', () => {
    expect(inGap(sc, 15 * H)).toBe(true);
  });
});

describe('inGap', () => {
  const sc = buildTimeScale({ ...LAYOUT, coverage: DEUX_SEANCES, window: WIN, compress: true });

  it('reconnait un instant non ecoute, et seulement lui', () => {
    expect(inGap(sc, 15 * H)).toBe(true);
    expect(inGap(sc, 3 * H)).toBe(false);
    expect(inGap(sc, 25 * H)).toBe(false);
    expect(inGap(sc, -H)).toBe(false);
    expect(inGap(sc, 99 * H)).toBe(false);
  });
});

describe('axisSpan', () => {
  it('rend la fenetre entiere en lineaire', () => {
    expect(axisSpan(DEUX_SEANCES, WIN, false)).toBe(30 * H);
  });

  it('rend le seul temps ecoute en compresse', () => {
    expect(axisSpan(DEUX_SEANCES, WIN, true)).toBe(14 * H);
  });

  it('retombe sur la fenetre sans couverture connue', () => {
    expect(axisSpan([], WIN, true)).toBe(30 * H);
    expect(axisSpan([{ from: 90 * H, to: 99 * H }], WIN, true)).toBe(30 * H);
  });
});

describe('scaleInvert', () => {
  it('refait le chemin inverse de scaleX, en lineaire comme en compresse', () => {
    for (const compress of [false, true]) {
      const sc = buildTimeScale({ ...LAYOUT, coverage: DEUX_SEANCES, window: WIN, compress });
      for (const t of [0, 3 * H, 7 * H, 23 * H, 26 * H, 30 * H]) {
        expect(scaleInvert(sc, scaleX(sc, t)), `${compress} / ${t / H} h`).toBeCloseTo(t, -2);
      }
    }
  });

  it('ne pose jamais le curseur dans une coupure', () => {
    const sc = buildTimeScale({ ...LAYOUT, coverage: DEUX_SEANCES, window: WIN, compress: true });
    const dansLaBande = scaleX(sc, 7 * H) + 5;
    expect(scaleInvert(sc, dansLaBande)).toBe(23 * H);
  });

  it('borne aux deux bouts', () => {
    const sc = buildTimeScale({ ...COLLE, coverage: DEUX_SEANCES, window: WIN, compress: true });
    expect(scaleInvert(sc, -500)).toBe(0);
    expect(scaleInvert(sc, 99_999)).toBe(30 * H);
  });
});
