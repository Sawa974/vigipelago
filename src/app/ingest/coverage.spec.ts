import { describe, expect, it } from 'vitest';
import { gapDuration, gapsWithin, lastCoveredBefore, mergeCoverage, sessionEndAt } from './coverage';

const M = 60_000;

describe('mergeCoverage', () => {
  it('fusionne les sessions qui se chevauchent', () => {
    const cov = mergeCoverage(
      [
        { startedAt: 0, endedAt: 10 * M, lastHeartbeatAt: 10 * M },
        { startedAt: 5 * M, endedAt: 20 * M, lastHeartbeatAt: 20 * M },
        { startedAt: 40 * M, endedAt: 50 * M, lastHeartbeatAt: 50 * M },
      ],
      60 * M,
    );
    expect(cov).toEqual([
      { from: 0, to: 20 * M },
      { from: 40 * M, to: 50 * M },
    ]);
  });

  it('borne une session jamais fermee a son dernier battement', () => {
    const cov = mergeCoverage([{ startedAt: 0, endedAt: 30 * M, lastHeartbeatAt: 30 * M }], 100 * M);
    expect(cov[0].to).toBe(30 * M);
  });

  it('etend une session vivante jusqu a maintenant', () => {
    const cov = mergeCoverage([{ startedAt: 0, endedAt: null, lastHeartbeatAt: 10 * M }], 25 * M);
    expect(cov[0].to).toBe(25 * M);
  });
});

describe('gapsWithin', () => {
  it('renvoie le complement de la couverture', () => {
    const cov = [
      { from: 10 * M, to: 20 * M },
      { from: 40 * M, to: 50 * M },
    ];
    expect(gapsWithin(cov, 0, 60 * M)).toEqual([
      { from: 0, to: 10 * M },
      { from: 20 * M, to: 40 * M },
      { from: 50 * M, to: 60 * M },
    ]);
  });

  it('ne renvoie rien quand la fenetre est entierement couverte', () => {
    expect(gapsWithin([{ from: 0, to: 100 * M }], 10 * M, 50 * M)).toEqual([]);
  });

  it('traite une couverture vide comme un trou complet', () => {
    expect(gapsWithin([], 0, 5 * M)).toEqual([{ from: 0, to: 5 * M }]);
  });

  it('totalise la duree des trous', () => {
    const cov = [{ from: 10 * M, to: 20 * M }];
    expect(gapDuration(cov, 0, 30 * M)).toBe(20 * M);
  });
});

describe('lastCoveredBefore', () => {
  it('donne la fin de la derniere periode couverte avant l instant', () => {
    const cov = [
      { from: 0, to: 10 * M },
      { from: 40 * M, to: 50 * M },
    ];
    expect(lastCoveredBefore(cov, 45 * M)).toBe(45 * M);
    expect(lastCoveredBefore(cov, 30 * M)).toBe(10 * M);
  });

  it('renvoie null si rien n a jamais ete couvert avant', () => {
    expect(lastCoveredBefore([{ from: 40 * M, to: 50 * M }], 10 * M)).toBeNull();
  });
});

describe('sessionEndAt', () => {
  it('ferme une session coupee a son dernier paquet, pas a la detection de la coupure', () => {
    expect(sessionEndAt(1_000, 50_000, 140_000)).toBe(50_000);
  });

  it('ne remonte jamais avant le debut de la session', () => {
    expect(sessionEndAt(60_000, 59_000, 140_000)).toBe(60_000);
  });

  it('prend maintenant si aucun paquet n a ete recu', () => {
    expect(sessionEndAt(60_000, null, 140_000)).toBe(140_000);
  });

  it('fait apparaitre la coupure dans la couverture', () => {
    const end = sessionEndAt(0, 10 * 60_000, 20 * 60_000);
    const cov = mergeCoverage(
      [
        { startedAt: 0, endedAt: end, lastHeartbeatAt: 20 * 60_000 },
        { startedAt: 25 * 60_000, endedAt: null, lastHeartbeatAt: 25 * 60_000 },
      ],
      30 * 60_000,
    );
    expect(lastCoveredBefore(cov, 25 * 60_000)).toBe(10 * 60_000);
    expect(gapDuration(cov, 0, 30 * 60_000)).toBe(15 * 60_000);
  });
});
