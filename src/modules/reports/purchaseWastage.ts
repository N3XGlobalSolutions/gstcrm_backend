/**
 * Purchase wastage — a COST to the shop (owner's rule).
 *
 * The wastage % typed on a Purchase → Ornament row is what the supplier charges
 * on top of the metal, so the income statement subtracts it from the sale +
 * labour wastage profit, in pure grams and in rupees.
 *
 * Purchase ornament rows store the % in `wastage_value` (mode PERCENT) and pass
 * `wastage_quantity = 0` explicitly (see purchase/service.ts), so the grams are
 * derived from the % here. If a row ever carries a real `wastage_quantity`
 * (gross grams, as sales/labour rows do), that recorded figure wins.
 *
 * Pure grams per row, on the same basis as sale wastage:
 *   wastage_quantity > 0 → wastage_quantity × touch/100   (touch 0 → gross)
 *   PERCENT              → quantity × wastage% / 100
 *                          (= sale's weight × wastage% ÷ touch, × touch/100;
 *                           a touch-0 direct row reads it as weight × %)
 *   GRAM                 → quantity × wastage_value × touch/100 (touch 0 → gross)
 * Value = pure grams × the row's rate (entry rate, else bill rate, else 0).
 * The physical weight × touch is used, never pure_quantity, so cash-mode bills
 * (pure_quantity forced to 0) still count.
 *
 * No DB import: kept pure so it can be unit-tested.
 */
import { toDecimal } from "@/lib/decimal";
import type Decimal from "decimal.js";

// A type alias (not an interface) so it satisfies db.execute's Record<string, unknown>.
export type PurchaseWastageRow = {
  quantity: string | null;
  purity: string | null;
  wastage_mode: string | null;
  wastage_value: string | null;
  wastage_quantity: string | null;
  /** COALESCE(entry rate, bill rate) — null when neither is set. */
  rate: string | null;
};

const num = (v: string | null | undefined) => toDecimal(v && v.trim() !== "" ? v : "0");

/** Pure wastage grams the supplier charged on one purchase row. */
export function purchaseWastagePure(row: PurchaseWastageRow): Decimal {
  const qty = num(row.quantity);
  const touch = num(row.purity);
  const recorded = num(row.wastage_quantity);
  const wv = num(row.wastage_value);

  if (recorded.gt(0)) return touch.gt(0) ? recorded.mul(touch).div(100) : recorded;
  if (wv.lte(0)) return toDecimal(0);
  if (row.wastage_mode === "PERCENT") return qty.mul(wv).div(100);
  if (row.wastage_mode === "GRAM") {
    const gross = qty.mul(wv);
    return touch.gt(0) ? gross.mul(touch).div(100) : gross;
  }
  return toDecimal(0);
}

/** Totals over purchase rows: pure grams and their rupee value. */
export function sumPurchaseWastage(rows: PurchaseWastageRow[]): { grams: Decimal; value: Decimal } {
  let grams = toDecimal(0);
  let value = toDecimal(0);
  for (const r of rows) {
    const g = purchaseWastagePure(r);
    if (g.isZero()) continue;
    grams = grams.plus(g);
    value = value.plus(g.mul(num(r.rate)));
  }
  return { grams, value };
}
