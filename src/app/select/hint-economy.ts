/** Cout d'un hint et depense d'un slot. Le cout est approche tant qu'il n'a pas ete observe. */

export interface HintEconomyInput {
  /** Un pourcentage du total d'emplacements du slot, pas des points. */
  hintCost: number | null;
  locationCheckPoints: number | null;
  totalLocations: number | null;
  checked: number;
  hintPoints: number | null;
  observedCost?: number | null;
  /** Le `hintCost` de l'observation : l'hote peut le changer, l'observation ne vaut plus. */
  observedFor?: number | null;
}

export interface HintEconomy {
  perCheck: number | null;
  costPoints: number | null;
  costExact: boolean;
  checksPerHint: number | null;
  earned: number | null;
  balance: number | null;
  /** Un minimum : deduit par soustraction, rien ne garantit que les checks soient la seule source. */
  spentAtLeast: number | null;
  affordableHints: number | null;
  freeHints: boolean;
  freeHintsExist: true;
}

export function buildHintEconomy(input: HintEconomyInput): HintEconomy {
  const { hintCost, locationCheckPoints, totalLocations, checked, hintPoints } = input;

  const perCheck = typeof locationCheckPoints === 'number' ? locationCheckPoints : null;

  const computed =
    hintCost !== null && totalLocations !== null
      ? Math.ceil((hintCost / 100) * totalLocations)
      : null;

  const observationStillValid =
    typeof input.observedCost === 'number' &&
    input.observedFor !== null &&
    input.observedFor === hintCost;

  const costPoints = observationStillValid ? input.observedCost! : computed;
  const costExact = observationStillValid;

  let checksPerHint: number | null = null;
  if (costPoints !== null && perCheck !== null) {
    if (costPoints === 0) {
      checksPerHint = 0;
    } else if (perCheck > 0) {
      checksPerHint = Math.ceil(costPoints / perCheck);
    }
    // perCheck <= 0 avec un cout : `null`, pas l'infini.
  }

  const earned = perCheck !== null ? perCheck * checked : null;
  const balance = hintPoints;
  const spentAtLeast =
    earned !== null && balance !== null ? Math.max(0, earned - balance) : null;

  const freeHints = costPoints === 0;
  const affordableHints =
    balance !== null && costPoints !== null && costPoints > 0
      ? Math.floor(balance / costPoints)
      : null;

  return {
    perCheck,
    costPoints,
    costExact,
    affordableHints,
    freeHints,
    checksPerHint,
    earned,
    balance,
    spentAtLeast,
    freeHintsExist: true,
  };
}

/** Au-dela, c'est le modele du cout qui serait faux, pas l'arrondi du serveur. */
export const OBSERVED_COST_TOLERANCE = 2;

/** `drop` doit etre une baisse de solde sans gain mele. */
export function validateObservedHintCost(args: {
  drop: number;
  computedCost: number | null;
}): number | null {
  const { drop, computedCost } = args;
  if (drop <= 0) return null;
  if (computedCost === null || computedCost <= 0) return null;
  return Math.abs(drop - computedCost) <= OBSERVED_COST_TOLERANCE ? drop : null;
}

/**
 * Reponse a `!hint` seul : on lit ses deux nombres, jamais ses mots, dont le format n'est pas
 * documente. L'un doit etre le solde connu, l'autre proche du cout calcule.
 */
export function readHintCostReply(args: {
  text: string;
  balance: number | null;
  computedCost: number | null;
}): number | null {
  const { text, balance, computedCost } = args;
  if (balance === null) return null;
  const numbers = (text.match(/\d+/g) ?? []).map(Number);
  if (numbers.length !== 2) return null;
  const [a, b] = numbers;
  const candidates = new Set<number>();
  if (b === balance) candidates.add(a);
  if (a === balance) candidates.add(b);
  const accepted = [...candidates].filter(
    (c) => validateObservedHintCost({ drop: c, computedCost }) !== null,
  );
  return accepted.length === 1 ? accepted[0] : null;
}
