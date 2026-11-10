// ─────────────────────────────────────────────────────────────────────────────
// CUSTOMER BALANCE REPORT — the party's running balance at every bill.
//
// For each Sales / Purchase / Labour Bill / Job Work bill in the range:
//   opening = the party's ledger balance just before the bill (same query the
//             history tables use: getBatchAggregateBalances, excluding the bill)
//   bill    = what this bill itself moved (every entry in the bill's group,
//             including payments added to it later from the Pay popup)
//   closing = opening + bill
// Plus each party's balance as on the To date (covers conversions and payments
// made after their last bill).
//
// Signs follow the bill prints:
//   Sales / Labour Bill / Job Work → positive = party owes the shop
//   Purchase                       → positive = shop owes the supplier
// ─────────────────────────────────────────────────────────────────────────────

import { and, asc, eq, gte, inArray, isNotNull, lte, sql } from "drizzle-orm";
import { db } from "@/db";
import { accounts, entries, entryGroups } from "@/db/schema";
import { SYSTEM_ITEMS } from "@/config/constants";
import { getBatchAggregateBalances } from "@/lib/balance";
import type { CustomerBalanceInput } from "./schema";

const NO_GROUP = "00000000-0000-0000-0000-000000000000";

const round2 = (n: number) => Math.round(n * 100) / 100;
const round3 = (n: number) => Math.round(n * 1000) / 1000;

export interface CustomerBalanceBill {
  id: string;
  date: string;
  bill_no: number | string | null;
  entry_no: number | string | null;
  account_id: string;
  party_name: string;
  opening_pure: number;
  opening_cash: number;
  bill_pure: number;
  bill_cash: number;
  closing_pure: number;
  closing_cash: number;
}

export interface CustomerBalanceParty {
  account_id: string;
  party_name: string;
  bills: number;
  /** Balance as on the To date (end of day, Asia/Kolkata). */
  balance_pure: number;
  balance_cash: number;
}

/** Purchase prints balances from the supplier's side (shop owes = positive). */
export const balanceSign = (type: CustomerBalanceInput["type"]) => (type === "PURCHASE" ? -1 : 1);

export async function getCustomerBalanceReport(
  input: CustomerBalanceInput,
): Promise<{ bills: CustomerBalanceBill[]; parties: CustomerBalanceParty[] }> {
  const conditions = [
    eq(entryGroups.type, input.type),
    eq(entryGroups.is_deleted, false),
    isNotNull(entryGroups.bill_no),
    gte(entryGroups.date, input.from_date),
    lte(entryGroups.date, input.to_date),
  ];
  if (input.account_id) conditions.push(eq(entryGroups.account_id, input.account_id));

  const groups = await db
    .select({
      id: entryGroups.id,
      date: entryGroups.date,
      billNo: entryGroups.bill_no,
      entryNo: entryGroups.entry_no,
      accountId: entryGroups.account_id,
      createdAt: entryGroups.created_at,
      party: accounts.name,
    })
    .from(entryGroups)
    .innerJoin(accounts, eq(entryGroups.account_id, accounts.id))
    .where(and(...conditions))
    .orderBy(asc(entryGroups.date), asc(entryGroups.entry_no), asc(entryGroups.created_at));

  if (groups.length === 0) return { bills: [], parties: [] };

  const sign = balanceSign(input.type);
  const cashItemId = SYSTEM_ITEMS.RUPEE_ITEM_ID;

  // Opening balance before each bill — identical to the history tables.
  const openings = await getBatchAggregateBalances(
    groups.map((g) => ({
      id: g.id,
      accountId: g.accountId,
      createdAt: new Date(g.createdAt),
      excludeGroupId: g.id,
    })),
  );

  // What each bill moved for its own party, in one query.
  const deltaRows = await db
    .select({
      groupId: entries.group_id,
      pure: sql<string>`COALESCE(SUM(CASE
          WHEN ${entries.to_account_id} = ${entryGroups.account_id} THEN COALESCE(${entries.pure_quantity}, 0)
          WHEN ${entries.from_account_id} = ${entryGroups.account_id} THEN -COALESCE(${entries.pure_quantity}, 0)
          ELSE 0 END), 0)::text`,
      cash: sql<string>`COALESCE(SUM(CASE
          WHEN ${entries.item_id} <> ${cashItemId} THEN 0
          WHEN ${entries.to_account_id} = ${entryGroups.account_id} THEN ${entries.quantity}
          WHEN ${entries.from_account_id} = ${entryGroups.account_id} THEN -${entries.quantity}
          ELSE 0 END), 0)::text`,
    })
    .from(entries)
    .innerJoin(entryGroups, eq(entries.group_id, entryGroups.id))
    .where(inArray(entries.group_id, groups.map((g) => g.id)))
    .groupBy(entries.group_id);
  const deltas = new Map(deltaRows.map((r) => [r.groupId, r]));

  const bills: CustomerBalanceBill[] = groups.map((g) => {
    const opening = openings[g.id]!;
    const openingPure = Number(opening.totalPure.toString()) || 0;
    const openingCash = Number(opening.totalCash.toString()) || 0;
    const delta = deltas.get(g.id);
    const billPure = Number(delta?.pure ?? 0) || 0;
    const billCash = Number(delta?.cash ?? 0) || 0;
    return {
      id: g.id,
      date: g.date,
      bill_no: g.billNo,
      entry_no: g.entryNo,
      account_id: g.accountId,
      party_name: g.party,
      opening_pure: round3(sign * openingPure),
      opening_cash: round2(sign * openingCash),
      bill_pure: round3(sign * billPure),
      bill_cash: round2(sign * billCash),
      closing_pure: round3(sign * (openingPure + billPure)),
      closing_cash: round2(sign * (openingCash + billCash)),
    };
  });

  // Each party's balance as on the To date (end of that day in India).
  const partyMap = new Map<string, { name: string; bills: number }>();
  for (const g of groups) {
    const p = partyMap.get(g.accountId);
    if (p) p.bills += 1;
    else partyMap.set(g.accountId, { name: g.party, bills: 1 });
  }
  const asOf = new Date(`${input.to_date}T23:59:59.999+05:30`);
  const balances = await getBatchAggregateBalances(
    Array.from(partyMap.keys(), (accountId) => ({
      id: accountId,
      accountId,
      createdAt: asOf,
      excludeGroupId: NO_GROUP,
    })),
  );

  const parties: CustomerBalanceParty[] = Array.from(partyMap, ([accountId, p]) => {
    const b = balances[accountId]!;
    return {
      account_id: accountId,
      party_name: p.name,
      bills: p.bills,
      balance_pure: round3(sign * (Number(b.totalPure.toString()) || 0)),
      balance_cash: round2(sign * (Number(b.totalCash.toString()) || 0)),
    };
  }).sort((a, b) => a.party_name.localeCompare(b.party_name));

  return { bills, parties };
}
