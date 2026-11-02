/** « Tous » retient le statut deduit du catalogue : regle partagee, ne pas la dupliquer. */
export interface ChecklistRow<S extends string> {
  name: string;
  status: S;
  searchExtra?: string;
}

export interface ChecklistView<R> {
  rows: R[];
  /** Avant plafond. */
  matched: number;
  truncated: boolean;
  /** L'appelant doit le dire a l'ecran, sinon la liste passe pour complete. */
  catalogueWithheld: boolean;
}

export function filterChecklist<S extends string, R extends ChecklistRow<S>>(
  rows: readonly R[],
  opts: {
    text: string;
    status: S | 'all';
    limit: number;
    withheld?: S;
  },
): ChecklistView<R> {
  const needle = opts.text.trim().toLocaleLowerCase('fr');
  const matches = (r: R) =>
    !needle ||
    r.name.toLocaleLowerCase('fr').includes(needle) ||
    (r.searchExtra?.toLocaleLowerCase('fr').includes(needle) ?? false);
  // `withheld` absent : aucun statut ne vaut `undefined`, rien n'est retenu.
  const kept = rows.filter(
    (r) =>
      (opts.status === 'all' ? r.status !== opts.withheld : r.status === opts.status) && matches(r),
  );
  return {
    rows: kept.length > opts.limit ? kept.slice(0, opts.limit) : kept,
    matched: kept.length,
    truncated: kept.length > opts.limit,
    catalogueWithheld:
      opts.status !== opts.withheld && rows.some((r) => r.status === opts.withheld),
  };
}
