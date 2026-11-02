import type { EventKind, RenderedSegment } from '../db/db';
import { itemClassCss, itemClassOf, ITEM_CLASS_GLYPH } from './item-class';
import { hintDedupSuffix } from '../ingest/hints';
import type { NameResolver } from './names';
import {
  type JSONMessagePart,
  type PrintJsonPacket,
  type PrintJsonType,
} from './types';

export interface EventDraft {
  kind: EventKind;
  team: number;
  srcSlot: number | null;
  dstSlot: number | null;
  itemId: number | null;
  locationId: number | null;
  itemFlags: number | null;
  text: string;
  segments: RenderedSegment[];
  tags: string[] | null;
  /** Sans le prefixe de room. */
  dedupSuffix: string;
}

const KIND_BY_TYPE: Record<PrintJsonType, EventKind> = {
  ItemSend: 'item',
  ItemCheat: 'item',
  Hint: 'hint',
  Join: 'join',
  Part: 'part',
  Chat: 'chat',
  ServerChat: 'server',
  Tutorial: 'tutorial',
  TagsChanged: 'tags',
  CommandResult: 'command',
  AdminCommandResult: 'command',
  Goal: 'goal',
  Release: 'release',
  Collect: 'collect',
  Countdown: 'countdown',
};

function itemClass(flags: number | undefined): string {
  return itemClassCss(itemClassOf(flags ?? 0));
}

function classMarker(flags: number | undefined): string {
  const cls = itemClassOf(flags ?? 0);
  return cls === 'progression' || cls === 'trap' ? ITEM_CLASS_GLYPH[cls] + ' ' : '';
}

export function renderParts(parts: JSONMessagePart[], names: NameResolver): RenderedSegment[] {
  const out: RenderedSegment[] = [];
  for (const part of parts) {
    const type = part.type ?? 'text';
    switch (type) {
      case 'player_id': {
        const slot = Number(part.text);
        out.push({
          text: names.playerName(slot),
          cls: slot === names.ownSlot ? 'player-self' : 'player-other',
          title: names.gameOf(slot) ? `${names.gameOf(slot)} (slot ${slot})` : `slot ${slot}`,
        });
        break;
      }
      case 'player_name':
        out.push({ text: part.text ?? '', cls: 'player-other' });
        break;
      case 'item_id': {
        const id = Number(part.text);
        const owner = part.player ?? 0;
        out.push({
          text: classMarker(part.flags) + names.itemName(id, owner),
          cls: itemClass(part.flags),
          title: `item ${id}`,
        });
        break;
      }
      case 'item_name':
        out.push({ text: classMarker(part.flags) + (part.text ?? ''), cls: itemClass(part.flags) });
        break;
      case 'location_id': {
        const id = Number(part.text);
        const owner = part.player ?? 0;
        out.push({ text: names.locationName(id, owner), cls: 'location', title: `location ${id}` });
        break;
      }
      case 'location_name':
        out.push({ text: part.text ?? '', cls: 'location' });
        break;
      case 'entrance_name':
        out.push({ text: part.text ?? '', cls: 'entrance' });
        break;
      case 'hint_status':
        out.push({ text: part.text ?? '', cls: `hint-status-${part.hint_status ?? 0}` });
        break;
      case 'color':
        out.push({ text: part.text ?? '', cls: `c-${(part.color ?? '').replace(/[^a-z_]/g, '')}` });
        break;
      default:
        out.push({ text: part.text ?? '', cls: 'text' });
    }
  }
  return out;
}

function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

export function decodePrintJson(packet: PrintJsonPacket, names: NameResolver, receivedAt: number): EventDraft {
  const kind = packet.type ? (KIND_BY_TYPE[packet.type] ?? 'server') : 'server';
  const segments = renderParts(packet.data ?? [], names);
  const text = segments.map((s) => s.text).join('');

  const item = packet.item;
  const srcSlot = item ? item.player : (packet.slot ?? null);
  const dstSlot = packet.receiving ?? null;
  const team = packet.team ?? 0;

  // Ni texte ni instant pour un check ou un hint : le direct et le rattrapage doivent converger.
  const dedupSuffix =
    item && item.location >= 0 && (kind === 'item' || kind === 'hint')
      ? kind === 'hint'
        ? hintDedupSuffix(team, item.player, item.location)
        : `i:${team}:${item.player}:${item.location}`
      : `x:${kind}:${fnv1a(text)}:${Math.floor(receivedAt / 60000)}`;

  return {
    kind,
    team,
    srcSlot,
    dstSlot,
    itemId: item?.item ?? null,
    locationId: item?.location ?? null,
    itemFlags: item?.flags ?? null,
    text,
    segments,
    tags: packet.tags ?? null,
    dedupSuffix,
  };
}
