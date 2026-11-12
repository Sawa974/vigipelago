/**
 * Tronque a deux decimales, sans arrondir : 99,996 % ne s'affiche pas 100 %. Plafonne a 100 %,
 * comme les ratios.
 * Calcule en entiers : `Math.floor(0.29 * 100)` vaut 28, la virgule flottante tombe juste en dessous.
 */
export function truncPercent(num: number, den: number): string {
  return (Math.floor((Math.min(num, den) * 10000) / den) / 100).toFixed(2);
}
