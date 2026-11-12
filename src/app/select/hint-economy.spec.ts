import { describe, expect, it } from 'vitest';
import {
  OBSERVED_COST_TOLERANCE,
  buildHintEconomy,
  readHintCostReply,
  validateObservedHintCost,
  type HintEconomyInput,
} from './hint-economy';

/** Defauts d'Archipelago : 10 % du total, 1 point par check. */
const BASE: HintEconomyInput = {
  hintCost: 10,
  locationCheckPoints: 1,
  totalLocations: 1366,
  checked: 1366,
  hintPoints: 1366,
};

describe('buildHintEconomy', () => {
  it('calcule le cout en points et en checks a partir du total du slot', () => {
    const e = buildHintEconomy(BASE);
    expect(e.costPoints).toBe(136);
    expect(e.checksPerHint).toBe(136);
    expect(e.perCheck).toBe(1);
  });

  it('donne un cout different a deux slots de la meme room', () => {
    const petit = buildHintEconomy({ ...BASE, totalLocations: 120, checked: 0 });
    expect(petit.checksPerHint).toBe(12);
    expect(buildHintEconomy(BASE).checksPerHint).toBe(136);
  });

  it('divise par les points gagnes a chaque check', () => {
    const e = buildHintEconomy({ ...BASE, locationCheckPoints: 4 });
    expect(e.costPoints).toBe(136);
    expect(e.checksPerHint).toBe(34);
  });

  it('deduit la depense du solde, et les hints gratuits n y entrent pas', () => {
    const e = buildHintEconomy({ ...BASE, hintPoints: 1092 });
    expect(e.earned).toBe(1366);
    expect(e.balance).toBe(1092);
    expect(e.spentAtLeast).toBe(274);
  });

  it('ne rend jamais une depense negative quand le solde depasse les gains connus', () => {
    const e = buildHintEconomy({ ...BASE, checked: 10, hintPoints: 500 });
    expect(e.earned).toBe(10);
    expect(e.spentAtLeast).toBe(0);
  });

  it('sans solde capture, aucune depense n est deduite', () => {
    const e = buildHintEconomy({ ...BASE, hintPoints: null });
    expect(e.balance).toBeNull();
    expect(e.spentAtLeast).toBeNull();
    expect(e.checksPerHint).toBe(136);
  });

  it('sans les reglages de la room, aucun cout n est invente', () => {
    const e = buildHintEconomy({ ...BASE, hintCost: null, locationCheckPoints: null });
    expect(e.costPoints).toBeNull();
    expect(e.checksPerHint).toBeNull();
    expect(e.perCheck).toBeNull();
    expect(e.earned).toBeNull();
    expect(e.spentAtLeast).toBeNull();
  });

  it('sans le total du slot, aucun cout : le denominateur ne s invente pas', () => {
    const e = buildHintEconomy({ ...BASE, totalLocations: null });
    expect(e.costPoints).toBeNull();
    expect(e.checksPerHint).toBeNull();
    expect(e.earned).toBe(1366);
  });

  it('un cout nul rend les hints gratuits, et zero check suffit', () => {
    const e = buildHintEconomy({ ...BASE, hintCost: 0 });
    expect(e.costPoints).toBe(0);
    expect(e.checksPerHint).toBe(0);
  });

  it('un check sans point ne paie aucun hint, et ne rend pas l infini', () => {
    const e = buildHintEconomy({ ...BASE, locationCheckPoints: 0 });
    expect(e.perCheck).toBe(0);
    expect(e.checksPerHint).toBeNull();
    expect(e.earned).toBe(0);
  });

  it('tronque comme le serveur, sans descendre sous un point', () => {
    expect(buildHintEconomy({ ...BASE, totalLocations: 1365 }).costPoints).toBe(136);
    expect(buildHintEconomy({ ...BASE, hintCost: 1, totalLocations: 50 }).costPoints).toBe(1);
  });

  it('une baisse relevee remplace le calcul, et le marque exact', () => {
    const e = buildHintEconomy({ ...BASE, observedCost: 136, observedFor: 10 });
    expect(e.costPoints).toBe(136);
    expect(e.costExact).toBe(true);
    expect(e.checksPerHint).toBe(136);
  });

  it('sans observation, le cout reste calcule et marque approche', () => {
    const e = buildHintEconomy(BASE);
    expect(e.costPoints).toBe(136);
    expect(e.costExact).toBe(false);
  });

  it('une observation faite sous un autre pourcentage est perimee', () => {
    const e = buildHintEconomy({ ...BASE, hintCost: 20, observedCost: 136, observedFor: 10 });
    expect(e.costExact).toBe(false);
    expect(e.costPoints).toBe(273);
  });
});

describe('validateObservedHintCost', () => {
  it('accepte une baisse a un point du cout calcule', () => {
    expect(validateObservedHintCost({ drop: 136, computedCost: 137 })).toBe(136);
    expect(validateObservedHintCost({ drop: 137, computedCost: 137 })).toBe(137);
  });

  it('accepte la baisse exactement a la limite de tolerance', () => {
    const drop = 137 - OBSERVED_COST_TOLERANCE;
    expect(validateObservedHintCost({ drop, computedCost: 137 })).toBe(drop);
  });

  it('refuse une baisse qui vaut deux hints', () => {
    expect(validateObservedHintCost({ drop: 274, computedCost: 137 })).toBeNull();
  });

  it('refuse une baisse qui contredit le modele', () => {
    expect(validateObservedHintCost({ drop: 50, computedCost: 137 })).toBeNull();
  });

  it('refuse une hausse ou un solde inchange', () => {
    expect(validateObservedHintCost({ drop: 0, computedCost: 137 })).toBeNull();
    expect(validateObservedHintCost({ drop: -10, computedCost: 137 })).toBeNull();
  });

  it('refuse sans cout calcule : rien ne distingue un hint de deux', () => {
    expect(validateObservedHintCost({ drop: 137, computedCost: null })).toBeNull();
    expect(validateObservedHintCost({ drop: 137, computedCost: 0 })).toBeNull();
  });
});

describe('readHintCostReply', () => {
  const reply = 'A hint costs 13 points. You have 8 points.';

  it('lit le cout quand l autre nombre est le solde connu et le cout proche du calcul', () => {
    expect(readHintCostReply({ text: reply, balance: 8, computedCost: 14 })).toBe(13);
  });

  it('ne depend ni de l ordre ni des mots de la phrase', () => {
    expect(readHintCostReply({ text: 'Solde 8, un hint vaut 13', balance: 8, computedCost: 13 })).toBe(13);
  });

  it('refuse quand aucun nombre n est le solde connu', () => {
    expect(readHintCostReply({ text: reply, balance: 9, computedCost: 13 })).toBeNull();
  });

  it('refuse un cout trop loin du calcul : ce ne serait pas cette reponse', () => {
    expect(readHintCostReply({ text: reply, balance: 8, computedCost: 40 })).toBeNull();
  });

  it('refuse une ligne qui ne porte pas exactement deux nombres', () => {
    expect(readHintCostReply({ text: 'You have 8 points.', balance: 8, computedCost: 13 })).toBeNull();
    expect(readHintCostReply({ text: '13 8 2', balance: 8, computedCost: 13 })).toBeNull();
  });

  it('ne conclut pas sans solde ni cout calcule', () => {
    expect(readHintCostReply({ text: reply, balance: null, computedCost: 13 })).toBeNull();
    expect(readHintCostReply({ text: reply, balance: 8, computedCost: null })).toBeNull();
  });

  it('accepte un cout egal au solde', () => {
    expect(readHintCostReply({ text: 'A hint costs 8 points. You have 8 points.', balance: 8, computedCost: 9 })).toBe(8);
  });
});
