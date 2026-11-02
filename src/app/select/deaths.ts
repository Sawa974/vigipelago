import type { ApEvent } from '../db/db';
import { DEATHLINK_TAG } from '../ingest/deathlink';
import { classifyTags } from '../protocol/tags';
import type { Key } from '../i18n/en';

// Un slot sans le tag meurt sans qu'on le sache : seul `tagged-silent` vaut un vrai zero.

export type DeathKnowledge = 'observed' | 'tagged-silent' | 'untagged' | 'unknown';

export interface SlotDeaths {
  slot: number;
  /** `null` et non 0 quand rien ne permet de l'affirmer. */
  count: number | null;
  knowledge: DeathKnowledge;
  /** Part des morts entendues, pas des morts de la partie. */
  share: number | null;
  lastTs: number | null;
}

export interface DeathTally {
  /** Pas la somme de `bySlot` : les morts non attribuees y sont. */
  total: number;
  unattributed: number;
  /** Lues dans `raw` : vides apres un export allege, les comptes restent justes. */
  sources: string[];
  bySlot: SlotDeaths[];
  slotsWithoutData: number;
  silent: boolean;
}

export interface DeathTallyInput {
  events: readonly ApEvent[];
  slots: readonly number[];
}

export function buildDeathTally(input: DeathTallyInput): DeathTally {
  const countBySlot = new Map<number, number>();
  const lastBySlot = new Map<number, number>();
  const sources = new Set<string>();
  // Suppose les evenements tries : la derniere annonce du tag l'emporte.
  const taggedBySlot = new Map<number, boolean>();
  let total = 0;
  let unattributed = 0;

  for (const e of input.events) {
    if (e.kind === 'death') {
      total++;
      if (e.srcSlot === null) {
        unattributed++;
      } else {
        countBySlot.set(e.srcSlot, (countBySlot.get(e.srcSlot) ?? 0) + 1);
        lastBySlot.set(e.srcSlot, Math.max(lastBySlot.get(e.srcSlot) ?? 0, e.ts));
      }
      // Pas depuis le texte rendu, que nous composons nous-memes.
      const raw = e.raw as { data?: { source?: unknown } } | null;
      const src = raw?.data?.source;
      if (typeof src === 'string' && src) sources.add(src);
      continue;
    }
    // Clients de jeu seulement : l'outil porte lui-meme le tag DeathLink pour ecouter.
    if ((e.kind === 'join' || e.kind === 'tags') && e.srcSlot !== null && e.tags) {
      if (classifyTags(e.tags) === 'player') {
        taggedBySlot.set(e.srcSlot, e.tags.includes(DEATHLINK_TAG));
      }
    }
  }

  const bySlot: SlotDeaths[] = input.slots.map((slot) => {
    const count = countBySlot.get(slot) ?? 0;
    if (count > 0) {
      return {
        slot,
        count,
        knowledge: 'observed',
        share: total ? count / total : null,
        lastTs: lastBySlot.get(slot) ?? null,
      };
    }
    const tagged = taggedBySlot.get(slot);
    if (tagged === true) {
      return {
        slot,
        count: 0,
        knowledge: 'tagged-silent',
        share: total ? 0 : null,
        lastTs: null,
      };
    }
    return {
      slot,
      count: null,
      knowledge: tagged === false ? 'untagged' : 'unknown',
      share: null,
      lastTs: null,
    };
  });

  return {
    total,
    unattributed,
    sources: [...sources].sort((a, b) => a.localeCompare(b, 'fr')),
    bySlot,
    slotsWithoutData: bySlot.filter((s) => s.count === null).length,
    silent: total === 0,
  };
}

export const DEATH_KNOWLEDGE_LABEL: Record<DeathKnowledge, Key> = {
  observed: 'death.knowledge.observed',
  'tagged-silent': 'death.knowledge.tagged-silent',
  untagged: 'death.knowledge.untagged',
  unknown: 'death.knowledge.unknown',
};
