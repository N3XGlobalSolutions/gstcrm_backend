import { and, eq, gte, inArray, isNotNull, lte, ne } from "drizzle-orm";
import { db } from "@/db";
import { entries, entryGroups, items } from "@/db/schema";

const num = (v: string | null | undefined) => Number.parseFloat(v || "0") || 0;

/**
 * Gold↔Cash balance conversions are stored as bills of the same type but move no
 * goods and carry no bill number — they are ledger reclassifications, and would
 * distort every weight and amount total if counted as sales or purchases.
 */
export function isConversion(remarks: string | null): boolean {
  const text = remarks || "";
  return text.startsWith("Gold to Cash Conversion") || text.startsWith("Cash to Gold Conversion");
}

/** Pure grams of a goods line — the stored figure, else weight × touch. */
export function linePure(line: { quantity: string; purity: string | null; pure: string | null }): number {
  return num(line.pure) || (num(line.quantity) * num(line.purity)) / 100;
}

/**
 * Goods value of one sale / purchase line (no GST, TDS, TCS, discount or round-off):
 * pure × rate, where a touch-0 line is a direct sale/purchase valued on weight.
 * The line's own rate wins; the bill's rate-per-gram is the fallback.
 */
export function lineGoodsAmount(
  line: { quantity: string; purity: string | null; pure: string | null; rate: string | null },
  groupRate: number,
): number {
  const pure = linePure(line);
  const rate = num(line.rate) || groupRate;
  return (pure > 0 ? pure : num(line.quantity)) * rate;
}

/** 1 Apr – 31 Mar financial year containing today (India time), as YYYY-MM-DD. */
export function currentFinancialYear(now: Date = new Date()): { from_date: string; to_date: string } {
  const ist = new Date(now.getTime() + 330 * 60 * 1000);
  const year = ist.getUTCFullYear();
  const startYear = ist.getUTCMonth() >= 3 ? year : year - 1;
  return { from_date: `${startYear}-04-01`, to_date: `${startYear + 1}-03-31` };
}

export interface PartyAverage {
  bill_count: number;
  total_amount: string;
  avg_amount: string;
  from_date: string;
  to_date: string;
}

/**
 * Average bill (goods) value per party for the current financial year, over live
 * SALE / PURCHASE bills that carry a bill number. Two queries for any number of
 * accounts. Every requested account is present in the result (zeros when none).
 */
export async function getPartyAverages(
  type: "SALE" | "PURCHASE",
  accountIds: string[],
): Promise<Map<string, PartyAverage>> {
  const { from_date, to_date } = currentFinancialYear();
  const unique = [...new Set(accountIds)];
  const totals = new Map<string, { count: number; total: number }>();
  for (const id of unique) totals.set(id, { count: 0, total: 0 });

  if (unique.length) {
    const groups = await db
      .select({
        id: entryGroups.id,
        accountId: entryGroups.account_id,
        ratePerGram: entryGroups.rate_per_gram,
        remarks: entryGroups.remarks,
      })
      .from(entryGroups)
      .where(
        and(
          eq(entryGroups.type, type),
          eq(entryGroups.is_deleted, false),
          isNotNull(entryGroups.bill_no),
          gte(entryGroups.date, from_date),
          lte(entryGroups.date, to_date),
          inArray(entryGroups.account_id, unique),
        ),
      );

    const realGroups = groups.filter((g) => !isConversion(g.remarks));
    const groupIds = realGroups.map((g) => g.id);

    const lines = groupIds.length
      ? await db
          .select({
            groupId: entries.group_id,
            quantity: entries.quantity,
            purity: entries.purity,
            pure: entries.pure_quantity,
            rate: entries.rate,
          })
          .from(entries)
          .innerJoin(items, eq(entries.item_id, items.id))
          .where(and(inArray(entries.group_id, groupIds), ne(items.type, "MONEY")))
      : [];

    const goodsByGroup = new Map<string, number>();
    const rateByGroup = new Map(realGroups.map((g) => [g.id, num(g.ratePerGram)]));
    for (const line of lines) {
      const amount = lineGoodsAmount(line, rateByGroup.get(line.groupId) ?? 0);
      goodsByGroup.set(line.groupId, (goodsByGroup.get(line.groupId) ?? 0) + amount);
    }

    for (const g of realGroups) {
      const t = totals.get(g.accountId);
      if (!t) continue;
      t.count += 1;
      // Rounded per bill, matching the detailed report's goods_amount.
      t.total += Math.round((goodsByGroup.get(g.id) ?? 0) * 100) / 100;
    }
  }

  const result = new Map<string, PartyAverage>();
  for (const [id, t] of totals) {
    result.set(id, {
      bill_count: t.count,
      total_amount: t.total.toFixed(2),
      avg_amount: (t.count ? t.total / t.count : 0).toFixed(2),
      from_date,
      to_date,
    });
  }
  return result;
}

export async function getPartyAverage(type: "SALE" | "PURCHASE", accountId: string): Promise<PartyAverage> {
  const map = await getPartyAverages(type, [accountId]);
  return map.get(accountId)!;
}
