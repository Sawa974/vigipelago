import { describe, expect, it } from 'vitest';
import { manualUse, permissionRule } from './permissions';

describe('manualUse', () => {
  it('lit les cinq valeurs du protocole', () => {
    expect(manualUse(0b000)).toBe('non'); // disabled
    expect(manualUse(0b001)).toBe('oui'); // enabled
    expect(manualUse(0b010)).toBe('apres-objectif'); // goal
    expect(manualUse(0b110)).toBe('apres-objectif'); // auto
    expect(manualUse(0b111)).toBe('oui'); // auto_enabled
  });

  it('ne conclut pas sur une permission que le serveur n a pas annoncee', () => {
    expect(manualUse(undefined)).toBe('inconnu');
  });

  it('le bit manuel l emporte sur le bit d objectif', () => {
    expect(manualUse(0b011)).toBe('oui');
  });
});

describe('permissionRule', () => {
  it('nomme les cinq valeurs du protocole', () => {
    expect(permissionRule(0b000)).toBe('disabled');
    expect(permissionRule(0b001)).toBe('manual');
    expect(permissionRule(0b010)).toBe('afterGoal');
    expect(permissionRule(0b110)).toBe('auto');
    expect(permissionRule(0b111)).toBe('autoManual');
  });

  it('dit inconnu plutot que de supposer', () => {
    expect(permissionRule(undefined)).toBeNull();
    expect(permissionRule(null)).toBeNull();
  });
});
