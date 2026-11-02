import type { EventDraft } from '../protocol/decode';
import type { BouncedPacket, DeathLinkData } from '../protocol/types';
import type { Translate } from '../i18n/translate';

/** Sans le tag, le serveur ne transmet ni ne garde aucun `Bounced` : une mort manquee est perdue. */
export const DEATHLINK_TAG = 'DeathLink';

export interface DeathDraft {
  /** En ms ; le `time` du paquet, en secondes, quand il est plausible. */
  ts: number;
  tsFromPayload: boolean;
  source: string;
  cause: string;
  /** `source` est un nom libre, pas un slot : correspondance exacte ou `null`, jamais approchee. */
  slot: number | null;
}

/** Le tag cible, pas la forme de `data` : une charge utile vide reste un DeathLink. */
export function isDeathLink(pkt: BouncedPacket): boolean {
  return (pkt.tags ?? []).includes(DEATHLINK_TAG);
}

/** Large expres : un decalage d'horloge est normal, au-dela `time` est faux. */
export const DEATH_TIME_TOLERANCE_MS = 6 * 60 * 60 * 1000;

export interface DeathDraftInput {
  packet: BouncedPacket;
  receivedAt: number;
  /** Nom puis alias de chaque slot. */
  slotNames: ReadonlyMap<number, readonly string[]>;
}

export function buildDeathDraft(input: DeathDraftInput): DeathDraft {
  const data = (input.packet.data ?? {}) as DeathLinkData;
  const source = typeof data.source === 'string' ? data.source : '';
  const cause = typeof data.cause === 'string' ? data.cause : '';

  const announced = typeof data.time === 'number' ? Math.round(data.time * 1000) : null;
  const usable =
    announced !== null &&
    Number.isFinite(announced) &&
    Math.abs(announced - input.receivedAt) <= DEATH_TIME_TOLERANCE_MS;

  return {
    ts: usable ? announced! : input.receivedAt,
    tsFromPayload: usable,
    source,
    cause,
    slot: resolveSlot(source, input.slotNames),
  };
}

function resolveSlot(
  source: string,
  slotNames: ReadonlyMap<number, readonly string[]>,
): number | null {
  if (!source) return null;
  for (const [slot, names] of slotNames) {
    if (names.some((n) => n === source)) return slot;
  }
  return null;
}

/** Sans la cause : un texte legerement different reste un doublon a l'import. */
export function deathDedupSuffix(ts: number, source: string): string {
  return `d:${ts}:${source}`;
}

/** `source` et `cause` recopiees telles quelles pour la recherche ; `cause` nomme deja le joueur. */
export function renderDeath(draft: DeathDraft, slotLabel: string | null, t: Translate): EventDraft {
  const who = slotLabel ?? (draft.source || t('line.death.unknownSource'));
  const death = t('line.death');
  const head = draft.cause ? `${death} : ${draft.cause}` : `${death}${t('line.death.of')}${who}`;
  // La cause nomme le personnage, pas forcement le slot : la recherche a besoin du slot.
  const tail = draft.cause && who ? ` (${who})` : '';
  const text = head + tail;

  // Classes existantes seulement : un `cls` sans regle CSS echoue en silence.
  const segments: { text: string; cls: string; title?: string }[] = [
    { text: death, cls: 'item-trap' },
  ];
  segments.push({ text: draft.cause ? ' : ' : t('line.death.of'), cls: 'text' });
  if (draft.cause) segments.push({ text: draft.cause, cls: 'text' });
  segments.push({
    text: draft.cause ? ` (${who})` : who,
    cls: draft.slot !== null ? 'player-other' : 'item-unknown',
    title:
      draft.slot !== null
        ? undefined
        : t('line.death.noSlot', { source: draft.source || t('line.death.noSource') }),
  });

  return {
    kind: 'death',
    team: 0,
    srcSlot: draft.slot,
    dstSlot: null,
    itemId: null,
    locationId: null,
    itemFlags: null,
    text,
    segments,
    tags: null,
    dedupSuffix: deathDedupSuffix(draft.ts, draft.source),
  };
}
