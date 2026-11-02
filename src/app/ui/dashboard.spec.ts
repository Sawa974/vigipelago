import { TestBed } from '@angular/core/testing';
import { beforeAll, describe, expect, it } from 'vitest';
import { ApSessionService } from '../core/ap-session.service';
import { Dashboard } from './dashboard';
import { signal } from '@angular/core';

/**
 * Garde contre un cycle de signaux (ex. `geo -> needsDateRow -> axisStep -> axisSpan -> scale -> geo`),
 * qui vide tout l'onglet sans que tsc ni ng build ne le voient.
 */

/** jsdom n'a pas de `ResizeObserver`, et le constructeur en cree un. */
beforeAll(() => {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
});

/** Hors connexion, `reload()` rend la main sans toucher la base. */
function sessionStub() {
  return {
    roomId: signal<string | null>(null),
    players: signal<{ slot: number; name: string; game: string }[]>([]),
    eventCount: signal(0),
    slotStatus: signal<ReadonlyMap<number, number | null>>(new Map()),
    state: signal('idle'),
  };
}

function dashboard(): Record<string, () => unknown> {
  TestBed.configureTestingModule({
    providers: [Dashboard, { provide: ApSessionService, useValue: sessionStub() }],
  });
  return TestBed.inject(Dashboard) as unknown as Record<string, () => unknown>;
}

describe('Dashboard, graphe de dependances', () => {
  it('enchaine geometrie, echelle et series sans boucler', () => {
    const d = dashboard();

    // `geo()` d'abord : c'est lui qu'un cycle rend inaccessible.
    const calculs = [
      'geo',
      'markBand',
      'gaps',
      'ticks',
      'columns',
      'linePaths',
      'goalMarks',
      'goalBadges',
      'progress',
      'cursorX',
      'cursorPermil',
      'cursorLabel',
      'multiworld',
      'classTotals',
    ];
    for (const key of calculs) {
      expect(() => d[key](), `le calcul « ${key} » a leve une erreur`).not.toThrow();
    }
    expect((d['geo']() as { padTop: number }).padTop).toBeGreaterThan(0);
    expect(d['live']()).toBe(true);
    expect(d['cursorPermil']()).toBe(1000);
  });
});
