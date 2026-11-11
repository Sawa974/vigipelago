/** Hors transaction, `bulkAdd` ecrit les autres lignes malgre un refus : seules les positions en echec manquent. */
export function storedRows<T>(rows: readonly T[], failuresByPos: Readonly<Record<number, unknown>>): T[] {
  return rows.filter((_, i) => !(i in failuresByPos));
}
