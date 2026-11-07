// What a match request asks a supplier for. The email names a percentage, never a euro price,
// so it does not reveal what the owner pays or what a competitor charges. Pure, so unit-tested.

/**
 * How much lower the supplier's price would need to be to meet the better price found,
 * as a whole percent of the current price. 0 when nothing is cheaper; otherwise at least 1.
 */
export function reductionPercent(yourPrice: number, bestPrice: number): number {
  if (!(yourPrice > 0) || !(bestPrice >= 0) || bestPrice >= yourPrice) return 0
  return Math.max(1, Math.round(((yourPrice - bestPrice) / yourPrice) * 100))
}
