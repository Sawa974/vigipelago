import { describe, expect, it } from 'vitest';
import type { CaptureSession, Room } from '../db/db';
import {
  attachPlan,
  dedupeByRoom,
  deriveProfiles,
  labelOf,
  missingProfiles,
  profileFromLegacyTarget,
  repairRoomLinks,
  shortRoomId,
  sortProfiles,
  targetKey,
  type ConnectionProfile,
} from './profiles';

const M = 60_000;

// Format reel de roomId : aucun prefixe commun.
const R1 = '53474563874335540287';
const R2 = '80651550253117080590';

function room(over: Partial<Room> = {}): Room {
  return {
    roomId: R1,
    seedName: 'Seed42',
    label: '',
    host: 'localhost',
    port: 38281,
    players: [],
    firstSeenAt: 10 * M,
    createdAt: null,
    lastSeenAt: 20 * M,
    hintCost: null,
    locationCheckPoints: null,
    ...over,
  };
}

function session(over: Partial<CaptureSession> = {}): CaptureSession {
  return {
    id: 1,
    roomId: R1,
    connectedAsSlot: 'Ada',
    startedAt: 10 * M,
    endedAt: null,
    lastHeartbeatAt: 10 * M,
    closeReason: 'user',
    appVersion: '0.0.0',
    ...over,
  };
}

function profile(over: Partial<ConnectionProfile> = {}): ConnectionProfile {
  return {
    label: '',
    host: 'localhost',
    port: 38281,
    slotName: 'Ada',
    targetKey: targetKey('localhost', 38281, 'Ada'),
    roomId: R1,
    createdAt: 0,
    lastUsedAt: null,
    ...over,
  };
}

describe('targetKey', () => {
  it('ignore la casse de l hote : c est un nom de machine', () => {
    expect(targetKey('LocalHost', 38281, 'Ada')).toBe(targetKey('localhost', 38281, 'Ada'));
  });

  it('distingue la casse du slot : Archipelago le fait', () => {
    expect(targetKey('localhost', 38281, 'Ada')).not.toBe(targetKey('localhost', 38281, 'ada'));
  });

  it('normalise un port saisi en texte, pour ne pas creer un doublon', () => {
    expect(targetKey('localhost', '38281' as unknown as number, 'Ada')).toBe(
      targetKey('localhost', 38281, 'Ada'),
    );
  });

  it('ignore les espaces autour de l hote et du slot', () => {
    expect(targetKey('  localhost ', 38281, ' Ada ')).toBe(targetKey('localhost', 38281, 'Ada'));
  });
});

describe('shortRoomId', () => {
  it('abrege a sept caracteres quand rien ne collisionne', () => {
    expect(shortRoomId(R1, [R1, R2])).toBe('5347456');
  });

  it('s allonge juste ce qu il faut pour rester non ambigu', () => {
    const a = '1234567890';
    const b = '1234567899';
    expect(shortRoomId(a, [a, b])).toBe('1234567890');
    expect(shortRoomId(b, [a, b])).toBe('1234567899');
  });

  it('ne se compare pas a lui-meme', () => {
    expect(shortRoomId(R1, [R1])).toBe('5347456');
  });

  it('rend l id entier quand il est plus court que la troncature', () => {
    expect(shortRoomId('abc', [])).toBe('abc');
  });
});

describe('labelOf', () => {
  it('prefere le libelle saisi par le joueur', () => {
    expect(labelOf(profile({ label: 'Partie du mardi' }), [R1])).toBe('Partie du mardi');
  });

  it('retombe sur le court-id quand le libelle est vide ou blanc', () => {
    expect(labelOf(profile({ label: '   ' }), [R1, R2])).toBe('5347456');
  });

  it('retombe sur l hote tant qu aucune connexion n a nomme la room', () => {
    expect(labelOf(profile({ label: '', roomId: null, host: 'ap.example.org' }))).toBe(
      'ap.example.org',
    );
  });
});

describe('deriveProfiles', () => {
  it('reconstruit une ligne par partie, pas par slot', () => {
    const rooms = [room(), room({ roomId: R2, host: 'ap.example.org', port: 12345 })];
    const sessions = [
      session({ id: 1, roomId: R1, connectedAsSlot: 'Ada', startedAt: 10 * M }),
      session({ id: 2, roomId: R1, connectedAsSlot: 'Bryn', startedAt: 12 * M }),
      session({ id: 3, roomId: R2, connectedAsSlot: 'Ada', startedAt: 30 * M }),
    ];
    const out = deriveProfiles(rooms, sessions, 0);
    expect(out).toHaveLength(2);
    expect(out[0].roomId).toBe(R2);
    expect(out[0].host).toBe('ap.example.org');
    expect(out[0].port).toBe(12345);
    expect(out[1].roomId).toBe(R1);
    expect(out[1].slotName).toBe('Bryn');
  });

  it('fusionne les sessions d une meme cible et garde la plus recente', () => {
    const sessions = [
      session({ id: 1, startedAt: 10 * M }),
      session({ id: 2, startedAt: 40 * M }),
      session({ id: 3, startedAt: 20 * M }),
    ];
    const out = deriveProfiles([room()], sessions, 0);
    expect(out).toHaveLength(1);
    expect(out[0].lastUsedAt).toBe(40 * M);
  });

  it('garde une ligne par partie quand la meme cible a ete reseedee', () => {
    const sessions = [
      session({ id: 1, roomId: R1, startedAt: 10 * M }),
      session({ id: 2, roomId: R2, startedAt: 90 * M }),
    ];
    const out = deriveProfiles([room(), room({ roomId: R2 })], sessions, 0);
    expect(out.map((p) => p.roomId)).toEqual([R2, R1]);
    expect(out[0].targetKey).toBe(out[1].targetKey);
  });

  it('ignore une session dont la room est inconnue : sans hote, pas de reconnexion', () => {
    const out = deriveProfiles([], [session()], 0);
    expect(out).toEqual([]);
  });

  it('ignore une session sans slot', () => {
    expect(deriveProfiles([room()], [session({ connectedAsSlot: '' })], 0)).toEqual([]);
  });

  it('etiquette avec le court-id de la room', () => {
    const out = deriveProfiles([room(), room({ roomId: R2 })], [session()], 0);
    expect(out[0].label).toBe('5347456');
  });
});

describe('profileFromLegacyTarget', () => {
  it('convertit l ancienne cible unique du localStorage', () => {
    const raw = JSON.stringify({ host: 'localhost', port: 38281, slotName: 'Ada' });
    const p = profileFromLegacyTarget(raw, 5 * M);
    expect(p?.host).toBe('localhost');
    expect(p?.slotName).toBe('Ada');
    expect(p?.roomId).toBeNull();
    expect(p?.createdAt).toBe(5 * M);
  });

  it('ne stocke jamais de mot de passe, meme si l ancienne valeur en contenait un', () => {
    const raw = JSON.stringify({ host: 'h', port: 1, slotName: 's', password: 'secret' });
    const p = profileFromLegacyTarget(raw, 0);
    expect(JSON.stringify(p)).not.toContain('secret');
  });

  it('rend null sur une valeur absente, illisible ou incomplete', () => {
    expect(profileFromLegacyTarget(null, 0)).toBeNull();
    expect(profileFromLegacyTarget('{pas du json', 0)).toBeNull();
    expect(profileFromLegacyTarget(JSON.stringify({ host: 'h', port: 1 }), 0)).toBeNull();
    expect(profileFromLegacyTarget(JSON.stringify({ port: 1, slotName: 's' }), 0)).toBeNull();
  });
});

describe('sortProfiles', () => {
  it('met la derniere cible utilisee en tete et les jamais utilisees a la fin', () => {
    const a = profile({ id: 1, lastUsedAt: 10 * M });
    const b = profile({ id: 2, lastUsedAt: null });
    const c = profile({ id: 3, lastUsedAt: 30 * M });
    expect(sortProfiles([a, b, c]).map((p) => p.id)).toEqual([3, 1, 2]);
  });
});

describe('dedupeByRoom', () => {
  it('ne garde qu une ligne par partie, avec le dernier slot utilise', () => {
    const old = profile({ id: 1, slotName: 'Ada', lastUsedAt: 10 * M });
    const recent = profile({ id: 2, slotName: 'Bryn', lastUsedAt: 40 * M });
    const { keep, remove } = dedupeByRoom([old, recent]);
    expect(keep).toHaveLength(1);
    expect(keep[0].slotName).toBe('Bryn');
    expect(remove.map((p) => p.id)).toEqual([1]);
  });

  it('ne fusionne jamais deux profils sans room : rien ne dit qu ils se rejoignent', () => {
    const a = profile({ id: 1, roomId: null, slotName: 'Ada' });
    const b = profile({ id: 2, roomId: null, slotName: 'Bryn' });
    const { keep, remove } = dedupeByRoom([a, b]);
    expect(keep).toHaveLength(2);
    expect(remove).toEqual([]);
  });

  it('laisse intactes deux parties distinctes', () => {
    const { keep, remove } = dedupeByRoom([
      profile({ id: 1, roomId: R1 }),
      profile({ id: 2, roomId: R2 }),
    ]);
    expect(keep).toHaveLength(2);
    expect(remove).toEqual([]);
  });

  it('sauve un libelle saisi a la main porte par la ligne perdante', () => {
    const named = profile({ id: 1, label: 'Partie du mardi', lastUsedAt: 10 * M });
    const recent = profile({ id: 2, label: '', slotName: 'Bryn', lastUsedAt: 40 * M });
    const { keep } = dedupeByRoom([named, recent]);
    expect(keep[0].label).toBe('Partie du mardi');
    expect(keep[0].slotName).toBe('Bryn');
    expect(keep[0].id).toBe(2);
  });

  it('ne touche pas au libelle du gagnant quand il en a deja un', () => {
    const a = profile({ id: 1, label: 'Ancien', lastUsedAt: 10 * M });
    const b = profile({ id: 2, label: 'Recent', lastUsedAt: 40 * M });
    expect(dedupeByRoom([a, b]).keep[0].label).toBe('Recent');
  });

  it('est idempotent : repasser dessus ne retire plus rien', () => {
    const first = dedupeByRoom([
      profile({ id: 1, lastUsedAt: 10 * M }),
      profile({ id: 2, lastUsedAt: 40 * M }),
    ]);
    expect(dedupeByRoom(first.keep).remove).toEqual([]);
  });

  it('replie aussi les profils derives d un historique a deux slots', () => {
    const rooms = [room()];
    const sessions = [
      session({ id: 1, connectedAsSlot: 'Ada', startedAt: 10 * M }),
      session({ id: 2, connectedAsSlot: 'Bryn', startedAt: 40 * M }),
    ];
    const out = deriveProfiles(rooms, sessions, 0);
    expect(out).toHaveLength(1);
    expect(out[0].slotName).toBe('Bryn');
  });
});

describe('missingProfiles', () => {
  it('reconstruit la ligne d une room qui n en a plus', () => {
    const derived = [profile({ id: undefined, roomId: R1, slotName: 'Ada' })];
    const existing = [profile({ id: 7, roomId: R2, slotName: 'Bryn' })];
    expect(missingProfiles(derived, existing).map((p) => p.roomId)).toEqual([R1]);
  });

  it('ne re-derive pas une room deja representee, meme sous un autre slot', () => {
    const derived = [profile({ id: undefined, roomId: R1, slotName: 'Ada' })];
    const existing = [profile({ id: 7, roomId: R1, slotName: 'Bryn' })];
    expect(missingProfiles(derived, existing)).toEqual([]);
  });

  it('laisse passer un profil sans room : rien ne peut le representer', () => {
    const derived = [profile({ id: undefined, roomId: null, host: 'ap.example.org' })];
    const existing = [profile({ id: 7, roomId: R1 })];
    expect(missingProfiles(derived, existing)).toHaveLength(1);
  });
});

describe('attachPlan', () => {
  it('ne fait rien quand la ligne porte deja la partie', () => {
    expect(attachPlan({ roomId: R1 }, R1)).toBe('none');
  });

  it('rattache une ligne qui n a encore aucune partie', () => {
    expect(attachPlan({ roomId: null }, R1)).toBe('link');
  });

  it('ne re-pointe jamais une ligne deja rattachee a une autre partie', () => {
    expect(attachPlan({ roomId: R1 }, R2)).toBe('split');
  });
});

describe('repairRoomLinks', () => {
  const rooms = [room({ roomId: R1 }), room({ roomId: R2 })];
  const sessions = [
    session({ id: 1, roomId: R1, connectedAsSlot: 'Ada', startedAt: 10 * M }),
    session({ id: 2, roomId: R2, connectedAsSlot: 'Bryn', startedAt: 20 * M }),
  ];

  function linked(over: Partial<ConnectionProfile>): ConnectionProfile {
    const slotName = over.slotName ?? 'Ada';
    return profile({ targetKey: targetKey('localhost', 38281, slotName), ...over, slotName });
  }

  it('renvoie la room que les sessions du slot soutiennent', () => {
    const usurped = linked({ id: 3, slotName: 'Bryn', roomId: R1 });
    expect(repairRoomLinks([usurped], rooms, sessions)).toEqual([{ id: 3, roomId: R2 }]);
  });

  it('efface un libelle qui n etait que le court-id de l ancienne room', () => {
    const usurped = linked({
      id: 3,
      slotName: 'Bryn',
      roomId: R1,
      label: R1.slice(0, 7),
    });
    expect(repairRoomLinks([usurped], rooms, sessions)).toEqual([
      { id: 3, roomId: R2, label: '' },
    ]);
  });

  it('garde le libelle que le joueur a ecrit lui-meme', () => {
    const usurped = linked({
      id: 3,
      slotName: 'Bryn',
      roomId: R1,
      label: 'Partie du mardi',
    });
    expect(repairRoomLinks([usurped], rooms, sessions)).toEqual([{ id: 3, roomId: R2 }]);
  });

  it('ne touche pas a un lien que les sessions soutiennent', () => {
    const ok = linked({ id: 3, slotName: 'Ada', roomId: R1 });
    expect(repairRoomLinks([ok], rooms, sessions)).toEqual([]);
  });

  it('ne detache jamais : un slot sans session garde sa room', () => {
    const chosenByHand = linked({ id: 3, slotName: 'Inconnu', roomId: R1 });
    expect(repairRoomLinks([chosenByHand], rooms, sessions)).toEqual([]);
  });

  it('ne juge pas une room dont aucune session ne nomme de slot', () => {
    const muettes = [session({ id: 1, roomId: R1, connectedAsSlot: '' })];
    const p = linked({ id: 3, slotName: 'Bryn', roomId: R1 });
    expect(repairRoomLinks([p], rooms, muettes)).toEqual([]);
  });

  it('ignore un profil sans room : il n y a rien a contredire', () => {
    const p = linked({ id: 3, slotName: 'Bryn', roomId: null });
    expect(repairRoomLinks([p], rooms, sessions)).toEqual([]);
  });

  it('suit le dernier slot quand une cible a change de partie', () => {
    const reseeded = [
      session({ id: 1, roomId: R1, connectedAsSlot: 'Ada', startedAt: 10 * M }),
      session({ id: 2, roomId: R2, connectedAsSlot: 'Ada', startedAt: 90 * M }),
    ];
    const stale = linked({ id: 3, slotName: 'Bryn', roomId: R1 });
    expect(repairRoomLinks([stale], rooms, reseeded)).toEqual([]);

    // Un lien atteste par une session n'est jamais redirige, meme vers plus recent.
    const stillValid = linked({ id: 4, slotName: 'Ada', roomId: R1 });
    expect(repairRoomLinks([stillValid], rooms, reseeded)).toEqual([]);
  });
});
