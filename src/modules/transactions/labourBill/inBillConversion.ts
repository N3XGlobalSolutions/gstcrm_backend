import { SYSTEM_ACCOUNTS, SYSTEM_ITEMS } from "@/config/constants";
import { toDecimal, toQuantityString } from "@/lib/decimal";
import type { EntryInput } from "@/lib/entryBuilder";

// ─── In-bill gold → cash conversion (Labour Bill + Issue & Job Works) ────────
// A conversion typed on the slip (cash_conversions[]) moves `gold_grams` of the
// party's pure balance into a cash balance of `cash_amount`. Like the stand-alone
// convertGoldToCash it posts TWO RUPEE entries — no real gold moves:
//   1. the gold side: quantity 0, pure_quantity = gold_grams
//   2. the cash side: quantity = cash_amount
//
// Raw ledger sign: positive = the party owes the shop; an entry TO the party
// raises it, FROM the party lowers it.
//   LOWER_PURE (Labour Bill slip: slipBalancePure −= grams, cash += amount):
//     gold party → SHOP, cash SHOP → party.
//   RAISE_PURE (Job Works slip, which shows −raw: slipBalancePure −= grams,
//     cash += amount on the "shop owes" side): gold SHOP → party, cash party → SHOP.
//
// Remarks: the cash side keeps the long-standing "Cash conversion: {g}g @ ₹{r}/g"
// (reports parse the grams out of it once per conversion). The gold side reads
// "Cash conversion: gold {g}g @ ₹{r}/g" — still a "Cash conversion:" line (never
// a payment), but no number straight after the colon, so the reports' gram
// parser reads 0 for it and the grams are not counted twice.

export const CASH_CONVERSION_PREFIX = "Cash conversion:";
export const CASH_CONVERSION_GOLD_PREFIX = "Cash conversion: gold ";

export function conversionEntries(
  accountId: string,
  conversion: { gold_grams: string; rate_per_gram: string; cash_amount: string },
  direction: "LOWER_PURE" | "RAISE_PURE",
): EntryInput[] {
  const grams = toDecimal(conversion.gold_grams);
  const cash = toDecimal(conversion.cash_amount);
  if (!grams.gt(0) && !cash.gt(0)) return [];

  const shop = SYSTEM_ACCOUNTS.SHOP_ID;
  const goldFrom = direction === "LOWER_PURE" ? accountId : shop;
  const goldTo = direction === "LOWER_PURE" ? shop : accountId;
  const detail = `${conversion.gold_grams}g @ ₹${conversion.rate_per_gram}/g`;

  return [
    {
      fromAccountId: goldFrom,
      toAccountId: goldTo,
      itemId: SYSTEM_ITEMS.RUPEE_ITEM_ID,
      quantity: "0",
      pureQuantity: toQuantityString(grams),
      remarks: `${CASH_CONVERSION_GOLD_PREFIX}${detail}`,
    },
    {
      // Cash grows on the side the gold left.
      fromAccountId: goldTo,
      toAccountId: goldFrom,
      itemId: SYSTEM_ITEMS.RUPEE_ITEM_ID,
      quantity: cash.toFixed(2),
      remarks: `${CASH_CONVERSION_PREFIX} ${detail}`,
    },
  ];
}
