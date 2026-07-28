/**
 * Shared full-cycle test harness.
 *
 * Drives the REAL service code (createSale / createPurchase / createLabourBill)
 * against an isolated throwaway Neon database. Every helper creates fresh
 * accounts/items with random UUID + entry_no so each scenario starts from a
 * clean zero balance and is fully deterministic.
 *
 * Ledger sign conventions (verified against balance.ts):
 *   getAggregateBalances(acct) returns:
 *     totalPure   = Σ pure_in(to=acct) − Σ pure_out(from=acct)
 *     totalCash   = Σ cash_in(to=acct) − Σ cash_out(from=acct)
 *     balancePure = totalPure − Σ(cash from=acct)/rate + Σ(cash to=acct)/rate
 *   → balancePure is the rate-stable "gold still owed", the value carried
 *     forward as the NEXT bill's opening balance.
 */
import { db } from "@/db";
import { accounts, items } from "@/db/schema";
import { createEntryGroup } from "@/lib/entryBuilder";
import { getAggregateBalances, getBalance } from "@/lib/balance";
import { SYSTEM_ACCOUNTS } from "@/config/constants";
import { randomUUID } from "crypto";

export const TEST_USER = { id: "00000000-0000-0000-0000-0000000000aa", username: "fulltest_user" };
export const SHOP = SYSTEM_ACCOUNTS.SHOP_ID;
export const OPENING_STOCK = SYSTEM_ACCOUNTS.OPENING_STOCK_ID;
export const TODAY = "2026-07-07";

let entryNoSeq = 500000 + Math.floor(Math.random() * 400000);
const nextEntryNo = () => entryNoSeq++;

// ─── Account / item factories ─────────────────────────────────────────────────

export async function makeCustomer(name = "Cust"): Promise<string> {
  const id = randomUUID();
  await db.insert(accounts).values({
    id, entry_no: nextEntryNo(), name: `${name}-${id.slice(0, 8)}`,
    type: "CUSTOMER", customer_type: "CUSTOMER",
  });
  return id;
}

export async function makeSupplier(name = "Supp"): Promise<string> {
  const id = randomUUID();
  await db.insert(accounts).values({
    id, entry_no: nextEntryNo(), name: `${name}-${id.slice(0, 8)}`,
    type: "CUSTOMER", customer_type: "PURCHASER",
  });
  return id;
}

export async function makeGoldsmith(name = "Smith"): Promise<string> {
  const id = randomUUID();
  await db.insert(accounts).values({
    id, entry_no: nextEntryNo(), name: `${name}-${id.slice(0, 8)}`,
    type: "GOLDSMITH", customer_type: "GOLD_SMITH",
  });
  return id;
}

export async function makeGoldItem(name = "Pure Gold"): Promise<string> {
  const id = randomUUID();
  await db.insert(items).values({
    id, entry_no: nextEntryNo(), name: `${name}-${id.slice(0, 8)}`,
    type: "GOLD", unit: "GRAM",
  });
  return id;
}

export async function makeOrnamentItem(name = "Ring"): Promise<string> {
  const id = randomUUID();
  await db.insert(items).values({
    id, entry_no: nextEntryNo(), name: `${name}-${id.slice(0, 8)}`,
    type: "ORNAMENT", unit: "GRAM",
  });
  return id;
}

/** Load SHOP with gold stock via an OPENING entry (OPENING_STOCK → SHOP). */
export async function seedShopGold(itemId: string, grams: string, purity: string): Promise<void> {
  await createEntryGroup({
    type: "OPENING", accountId: SHOP, date: TODAY,
    entries: [{ fromAccountId: OPENING_STOCK, toAccountId: SHOP, itemId, quantity: grams, purity }],
  });
}

/** Load SHOP with an ornament lot at an explicit lot_id so a sale can reference it. */
export async function seedShopOrnamentLot(itemId: string, grams: string, purity: string, lotId: string): Promise<void> {
  await createEntryGroup({
    type: "OPENING", accountId: SHOP, date: TODAY,
    entries: [{ fromAccountId: OPENING_STOCK, toAccountId: SHOP, itemId, quantity: grams, purity, lotId }],
  });
}

// ─── Balance readers ──────────────────────────────────────────────────────────

export interface Bal {
  totalPure: number;
  totalCash: number;
  balancePure: number;
  goldCashOut: number;
  goldCashIn: number;
  pureNoRate: number;
}

export async function bal(accountId: string): Promise<Bal> {
  const b = await getAggregateBalances(accountId);
  return {
    totalPure: parseFloat(b.totalPure.toString()),
    totalCash: parseFloat(b.totalCash.toString()),
    balancePure: parseFloat(b.balancePure.toString()),
    goldCashOut: parseFloat(b.goldCashOut.toString()),
    goldCashIn: parseFloat(b.goldCashIn.toString()),
    pureNoRate: parseFloat(b.pureNoRate.toString()),
  };
}

/**
 * Cash-first "shop owes supplier" grams — exactly what the Purchase form now shows
 * as Opening Pure: the rupee balance owed ((goldCashOut − goldCashIn) − totalCash)
 * converted to grams at `lastRate`, minus rate-less opening-pure grams.
 * Rate-stable, reversal-safe, and phantom-free.
 */
export function cashFirstPayable(b: Bal, lastRate: number): number {
  const cashOwed = b.goldCashOut - b.goldCashIn - b.totalCash;
  const ratedPure = lastRate > 0 ? cashOwed / lastRate : 0;
  return round3(ratedPure - b.pureNoRate);
}

/** Net gram balance of one item for an account (e.g. SHOP stock of an item). */
export async function itemGrams(accountId: string, itemId: string): Promise<number> {
  const d = await getBalance(accountId, itemId);
  return parseFloat(d.toString());
}

// ─── Math helpers (mirror decimal.ts DB rounding: gold 3dp, cash 2dp) ─────────

export const round3 = (n: number) => Math.round(n * 1000) / 1000;
export const round2 = (n: number) => Math.round(n * 100) / 100;

/** Pure grams for a single gold line at (weight, touch) with DB 3dp rounding. */
export const purePure = (weight: number, touch: number) => round3(weight * (touch / 100));

/** Wastage grams in GRAM mode = weight × wastageGram (see decimal.calcWastageGram). */
export const wastageGram = (weight: number, wGram: number) => round3(weight * wGram);

/** Wastage grams in PERCENT mode = weight × (wPercent / touch) (see calcWastagePercent). */
export const wastagePercent = (weight: number, wPercent: number, touch: number) =>
  round3(weight * (wPercent / touch));

/** Assert two numbers are within tol; throws with a descriptive message. */
export function close(actual: number, expected: number, tol: number, label: string): void {
  if (Math.abs(actual - expected) > tol) {
    throw new Error(`${label}: expected ≈ ${expected}, got ${actual} (Δ ${Math.abs(actual - expected)}, tol ${tol})`);
  }
}
