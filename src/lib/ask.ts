// What a match request asks a supplier for. Pure, so it is unit-tested.
// The email names the buy price we want and the percentage cut that is. It never names the
// owner's selling prices or margin. Where a selling price is known, the target is the buy
// price that lets the owner sell at the competitive price and keep the same profit.

/**
 * How much lower the supplier's price would need to be to meet the target,
 * as a whole percent of the current price. 0 when nothing is lower; otherwise at least 1.
 */
export function reductionPercent(yourPrice: number, bestPrice: number): number {
  if (!(yourPrice > 0) || !(bestPrice >= 0) || bestPrice >= yourPrice) return 0
  return Math.max(1, Math.round(((yourPrice - bestPrice) / yourPrice) * 100))
}

export interface BuyTarget {
  /** Buy price per pack we want, euro, rounded to the cent. */
  target: number
  /** How much lower than today's buy price, whole percent. */
  percent: number
  /** 'profit': from the owner's selling price. 'found_price': the better price found, as is. */
  basis: 'profit' | 'found_price'
}

function cents(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * All prices are per the same pack, ex VAT:
 * - your_price: what the owner pays the supplier now.
 * - best_price: the competitive price found (what others sell it for).
 * - selling_price: what the owner sells that pack for, or null when not entered.
 *
 * With a selling price above the competitive price, the owner must cut it to compete.
 * Keeping the same profit in euros, the buy price has to fall by the same amount:
 * target = best_price - (selling_price - your_price).
 * Without a usable selling price, or when that gives no sensible target, the target is the
 * better price found. Null when no lower buy price makes sense.
 */
export function targetBuyPrice(input: {
  your_price: number
  best_price: number
  selling_price: number | null
}): BuyTarget | null {
  const { your_price, best_price, selling_price } = input
  if (!(your_price > 0) || !(best_price >= 0)) return null
  if (selling_price != null && selling_price > best_price) {
    const profit = selling_price - your_price
    const target = cents(best_price - profit)
    if (profit > 0 && target > 0 && target < your_price)
      return {
        target,
        percent: reductionPercent(your_price, target),
        basis: 'profit',
      }
  }
  if (best_price > 0 && best_price < your_price)
    return {
      target: cents(best_price),
      percent: reductionPercent(your_price, best_price),
      basis: 'found_price',
    }
  return null
}
