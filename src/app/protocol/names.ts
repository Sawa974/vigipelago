import type { NetworkPlayer, NetworkSlot } from './types';

export class NameResolver {
  private playerBySlot = new Map<number, NetworkPlayer>();
  private gameBySlot = new Map<number, string>();
  private itemNames = new Map<string, Record<number, string>>();
  private locationNames = new Map<string, Record<number, string>>();

  ownSlot: number | null = null;

  setPlayers(players: NetworkPlayer[], slotInfo: Record<string, NetworkSlot>): void {
    this.playerBySlot.clear();
    this.gameBySlot.clear();
    for (const p of players) this.playerBySlot.set(p.slot, p);
    for (const [slot, info] of Object.entries(slotInfo)) {
      this.gameBySlot.set(Number(slot), info.game);
    }
  }

  setGameData(game: string, itemIdToName: Record<number, string>, locationIdToName: Record<number, string>): void {
    this.itemNames.set(game, itemIdToName);
    this.locationNames.set(game, locationIdToName);
  }

  hasGameData(game: string): boolean {
    return this.itemNames.has(game);
  }

  playerName(slot: number): string {
    const p = this.playerBySlot.get(slot);
    if (!p) return `Slot ${slot}`;
    return p.alias || p.name;
  }

  /** Les deux : le `source` d'un DeathLink est l'un ou l'autre selon le client. */
  slotNames(): Map<number, string[]> {
    const out = new Map<number, string[]>();
    for (const [slot, p] of this.playerBySlot) {
      const names = [p.name, p.alias].filter((n): n is string => !!n);
      out.set(slot, [...new Set(names)]);
    }
    return out;
  }

  gameOf(slot: number): string | undefined {
    return this.gameBySlot.get(slot);
  }

  /** `slot` : le joueur dont le jeu definit l'id. */
  itemName(id: number, slot: number): string {
    const game = this.gameBySlot.get(slot);
    const table = game ? this.itemNames.get(game) : undefined;
    return table?.[id] ?? `Item ${id}`;
  }

  /** `slot` : le joueur dont le jeu definit l'id. */
  locationName(id: number, slot: number): string {
    const game = this.gameBySlot.get(slot);
    const table = game ? this.locationNames.get(game) : undefined;
    return table?.[id] ?? `Location ${id}`;
  }
}
