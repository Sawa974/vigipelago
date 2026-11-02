import { describe, expect, it } from 'vitest';
import type { BouncedPacket } from '../protocol/types';
import {
  DEATH_TIME_TOLERANCE_MS,
  buildDeathDraft,
  deathDedupSuffix,
  isDeathLink,
  renderDeath,
} from './deathlink';
import { EN, type Key } from '../i18n/en';
import { translate, type Dict, type Params } from '../i18n/translate';
import fr from '../../../public/i18n/fr.json';

/** Attentes en francais : rendu avec le fichier livre. */
const tFr = (key: Key, params?: Params) => translate(key, params, 'fr', fr as Dict, EN);

const NOW = 1_700_000_000_000;

const NAMES = new Map<number, string[]>([
  [1, ['Alice']],
  [2, ['Bob', 'BobLeBricoleur']],
]);

function bounced(data: Record<string, unknown>, tags = ['DeathLink']): BouncedPacket {
  return { cmd: 'Bounced', tags, data };
}

describe('isDeathLink', () => {
  it('reconnait un DeathLink par le tag cible, pas par la forme de la charge', () => {
    expect(isDeathLink(bounced({}))).toBe(true);
    expect(isDeathLink(bounced({ source: 'Alice' }, ['AP']))).toBe(false);
    expect(isDeathLink({ cmd: 'Bounced', data: {} })).toBe(false);
  });
});

describe('buildDeathDraft', () => {
  it('utilise le time du paquet : le seul vrai instant du protocole', () => {
    const d = buildDeathDraft({
      packet: bounced({ time: (NOW - 30_000) / 1000, source: 'Alice' }),
      receivedAt: NOW,
      slotNames: NAMES,
    });
    expect(d.ts).toBe(NOW - 30_000);
    expect(d.tsFromPayload).toBe(true);
  });

  it('retombe sur la reception quand le time manque', () => {
    const d = buildDeathDraft({
      packet: bounced({ source: 'Alice' }),
      receivedAt: NOW,
      slotNames: NAMES,
    });
    expect(d.ts).toBe(NOW);
    expect(d.tsFromPayload).toBe(false);
  });

  it('refuse un time aberrant et retombe sur la reception', () => {
    const loin = (NOW - DEATH_TIME_TOLERANCE_MS - 60_000) / 1000;
    const d = buildDeathDraft({
      packet: bounced({ time: loin, source: 'Alice' }),
      receivedAt: NOW,
      slotNames: NAMES,
    });
    expect(d.ts).toBe(NOW);
    expect(d.tsFromPayload).toBe(false);
  });

  it('accepte un decalage d horloge jusqu a la tolerance', () => {
    const decale = (NOW - DEATH_TIME_TOLERANCE_MS) / 1000;
    const d = buildDeathDraft({
      packet: bounced({ time: decale, source: 'Alice' }),
      receivedAt: NOW,
      slotNames: NAMES,
    });
    expect(d.tsFromPayload).toBe(true);
  });

  it('rapproche une source d un slot par son nom, et par son alias', () => {
    const parNom = buildDeathDraft({
      packet: bounced({ source: 'Alice' }),
      receivedAt: NOW,
      slotNames: NAMES,
    });
    expect(parNom.slot).toBe(1);

    const parAlias = buildDeathDraft({
      packet: bounced({ source: 'BobLeBricoleur' }),
      receivedAt: NOW,
      slotNames: NAMES,
    });
    expect(parAlias.slot).toBe(2);
  });

  it('n attribue rien sur une correspondance approximative', () => {
    for (const source of ['alice', 'Alice2', 'Ali', ' Alice', '']) {
      const d = buildDeathDraft({
        packet: bounced({ source }),
        receivedAt: NOW,
        slotNames: NAMES,
      });
      expect(d.slot, source).toBeNull();
    }
  });

  it('garde la source et la cause telles quelles', () => {
    const d = buildDeathDraft({
      packet: bounced({ source: 'Perso2', cause: 'Berserker was run over by a train.' }),
      receivedAt: NOW,
      slotNames: NAMES,
    });
    expect(d.source).toBe('Perso2');
    expect(d.cause).toBe('Berserker was run over by a train.');
    expect(d.slot).toBeNull();
  });
});

describe('deathDedupSuffix', () => {
  it('est stable sur l instant et la source', () => {
    expect(deathDedupSuffix(NOW, 'Alice')).toBe(deathDedupSuffix(NOW, 'Alice'));
    expect(deathDedupSuffix(NOW, 'Alice')).not.toBe(deathDedupSuffix(NOW + 1, 'Alice'));
    expect(deathDedupSuffix(NOW, 'Alice')).not.toBe(deathDedupSuffix(NOW, 'Bob'));
  });

  it('ne depend pas de la cause : un texte different reste la meme mort', () => {
    const a = buildDeathDraft({
      packet: bounced({ time: NOW / 1000, source: 'Alice', cause: 'noye' }),
      receivedAt: NOW,
      slotNames: NAMES,
    });
    const b = buildDeathDraft({
      packet: bounced({ time: NOW / 1000, source: 'Alice', cause: 'Alice est tombee' }),
      receivedAt: NOW,
      slotNames: NAMES,
    });
    expect(deathDedupSuffix(a.ts, a.source)).toBe(deathDedupSuffix(b.ts, b.source));
  });
});

describe('renderDeath', () => {
  it('parle la langue de l interface : la ligne se recompose a l affichage', () => {
    const d = buildDeathDraft({ packet: bounced({ source: 'Alice' }), receivedAt: NOW, slotNames: NAMES });
    const tEn = (key: Key, params?: Params) => translate(key, params, 'en', EN, EN);
    expect(renderDeath(d, 'Alice', tEn).text).toBe('Death of Alice');
    expect(renderDeath(d, 'Alice', tFr).text).toBe('Mort de Alice');
  });

  it('porte toujours le mot Mort, pour que la recherche le trouve', () => {
    const sansCause = renderDeath(buildDeathDraft({ packet: bounced({ source: 'Alice' }), receivedAt: NOW, slotNames: NAMES }), 'Alice', tFr);
    expect(sansCause.text).toContain('Mort');
    expect(sansCause.text).toContain('Alice');
  });

  it('reprend la cause telle quelle, sans redoubler le nom qu elle contient deja', () => {
    const d = buildDeathDraft({
      packet: bounced({ source: 'Alice', cause: 'Alice was run over by a train.' }),
      receivedAt: NOW,
      slotNames: NAMES,
    });
    const r = renderDeath(d, 'Alice', tFr);
    expect(r.text).toBe('Mort : Alice was run over by a train. (Alice)');
    expect(r.text).not.toContain('Mort de Alice');
  });

  it('rend la source trouvable meme quand aucun slot ne lui correspond', () => {
    const d = buildDeathDraft({
      packet: bounced({ source: 'Perso2' }),
      receivedAt: NOW,
      slotNames: NAMES,
    });
    const r = renderDeath(d, null, tFr);
    expect(r.text).toContain('Perso2');
    expect(r.srcSlot).toBeNull();
    const seg = r.segments.find((s) => s.text.includes('Perso2'));
    expect(seg?.title).toContain('aucun slot');
  });

  it('ne pretend pas connaitre une source absente', () => {
    const d = buildDeathDraft({ packet: bounced({}), receivedAt: NOW, slotNames: NAMES });
    const r = renderDeath(d, null, tFr);
    expect(r.text).toContain('source inconnue');
    expect(r.srcSlot).toBeNull();
  });

  it('attache la mort au slot reconnu, et a aucun destinataire', () => {
    const d = buildDeathDraft({
      packet: bounced({ source: 'Alice' }),
      receivedAt: NOW,
      slotNames: NAMES,
    });
    const r = renderDeath(d, 'Alice', tFr);
    expect(r.kind).toBe('death');
    expect(r.srcSlot).toBe(1);
    expect(r.dstSlot).toBeNull();
  });
});
