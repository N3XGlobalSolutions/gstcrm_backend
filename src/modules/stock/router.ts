import { router, protectedProcedure, guardedProcedure } from "@/lib/trpc";
import { z } from "zod";
import { getBalances, getLotBalances, getAccountLotBalances, getAccountItemBalances, getAccountItemTouchBalances, getAllGoldsmithsLotBalances } from "@/lib/balance";
import { toDecimal, type Decimal } from "@/lib/decimal";
import { db } from "@/db";
import { items, accounts } from "@/db/schema";
import { eq, and, or } from "drizzle-orm";
import { SYSTEM_ACCOUNTS } from "@/config/constants";
import { createEntryGroup } from "@/lib/entryBuilder";
import { getIncomeStatement } from "@/modules/reports/incomeStatement";
import { TRPCError } from "@trpc/server";
import { getMeltingTotals } from "@/modules/melting/service";

// ─── stock.getSummary ─────────────────────────────────────────────────────────

async function getSummary() {
  const [allItems, goldsmiths] = await Promise.all([
    db
      .select({ id: items.id, type: items.type })
      .from(items)
      .where(eq(items.is_deleted, false)),
    db
      .select({ id: accounts.id })
      .from(accounts)
      .where(
        and(
          or(eq(accounts.type, "GOLDSMITH"), eq(accounts.customer_type, "GOLD_SMITH")),
          eq(accounts.is_deleted, false)
        )
      )
  ]);

  const goldItemIds = allItems.filter((i) => i.type === "GOLD").map((i) => i.id);
  const ornamentItemIds = allItems.filter((i) => i.type === "ORNAMENT").map((i) => i.id);

  const zero = toDecimal("0");

  // Fetch shop stock, goldsmith stock, and profit/loss in parallel
  const [shopLots, shopGoldBalances, mcLots, profitLossRows] = await Promise.all([
    getAccountLotBalances(SYSTEM_ACCOUNTS.SHOP_ID),
    getAccountItemBalances(SYSTEM_ACCOUNTS.SHOP_ID, goldItemIds),
    Promise.resolve([] as any[]),
    (async () => {
      const { entries: entriesTable, entryGroups } = await import("@/db/schema");
      const { inArray, sql } = await import("drizzle-orm");
      return db
        .select({
          type: entryGroups.type,
          pure_quantity: sql<string>`SUM(${entriesTable.pure_quantity})`
        })
        .from(entriesTable)
        .innerJoin(entryGroups, eq(entriesTable.group_id, entryGroups.id))
        .innerJoin(items, eq(entriesTable.item_id, items.id))
        .where(
          and(
            eq(entryGroups.is_deleted, false),
            inArray(entryGroups.type, ["SALE", "PURCHASE"]),
            inArray(items.type, ["GOLD", "ORNAMENT"])
          )
        )
        .groupBy(entryGroups.type);
    })()
  ]);

  // 1. Gold Total Pure in shop
  let gold_total_pure = zero;
  for (const bal of shopGoldBalances) {
    const pq = bal.pure_quantity ?? zero;
    if (isFinite(Number(pq))) {
      gold_total_pure = gold_total_pure.plus(pq);
    }
  }

  // 2. Ornament count: number of distinct lots with positive balance in shop.
  // Ornament stock is tracked per lot (see getOrnamentStock / the Stock page's
  // ornament table, which shows one row per lot_id) — grouping by item_id alone
  // collapsed every lot of the same item into a single count, so a stock table
  // showing many lots would report a much smaller "Ornaments" summary number.
  const ornamentBalances = new Map<string, Decimal>();
  for (const lot of shopLots) {
    if (ornamentItemIds.includes(lot.item_id)) {
      const qty = lot.quantity ?? zero;
      if (isFinite(Number(qty))) {
        const key = `${lot.item_id}::${lot.lot_id}`;
        const current = ornamentBalances.get(key) ?? zero;
        ornamentBalances.set(key, current.plus(qty));
      }
    }
  }
  const inStockOrnamentLots = Array.from(ornamentBalances.values()).filter((b) => b.gt(zero));
  const ornaments_in_stock = inStockOrnamentLots.length;
  // Gross weight of those same in-stock lots (the Stock page's "Ornaments" card).
  const ornaments_weight = inStockOrnamentLots.reduce((sum, b) => sum.plus(b), zero);

  // 3. MC Gold Total
  let mc_gold_total = zero;
  for (const lot of mcLots) {
    const pq = lot.pure_quantity ?? zero;
    if (isFinite(Number(pq))) {
      mc_gold_total = mc_gold_total.plus(pq);
    }
  }

  // 4. Net Gold Movement (NOT profit — see note below)
  // This is Σ(pure sold) − Σ(pure purchased): a net inventory-flow figure, not
  // profit. Real net profit is computed by the income-statement report. We
  // accumulate with .plus() (not assign) so it stays correct even if the grouped
  // query ever returns more than one row per type.
  let salesPure = toDecimal("0");
  let purchasesPure = toDecimal("0");
  for (const row of profitLossRows) {
    if (row.type === "SALE") salesPure = salesPure.plus(toDecimal(row.pure_quantity || "0"));
    if (row.type === "PURCHASE") purchasesPure = purchasesPure.plus(toDecimal(row.pure_quantity || "0"));
  }
  const net_gold_movement = salesPure.minus(purchasesPure);

  return {
    gold_total_pure: gold_total_pure.toFixed(3),
    ornaments_in_stock,
    ornaments_weight: ornaments_weight.toFixed(3),
    mc_gold_total: mc_gold_total.toFixed(3),
    // net_gold_movement is the honest name; profit_loss_pure kept as an alias for
    // backward compatibility with the existing frontend until Phase 4 rewires it.
    net_gold_movement: net_gold_movement.toFixed(3),
    profit_loss_pure: net_gold_movement.toFixed(3),
  };
}

// ─── stock.getGoldStock ───────────────────────────────────────────────────────

export async function getGoldStock(input: { page: number; limit: number }) {
  const goldItems = await db
    .select()
    .from(items)
    .where(and(eq(items.type, "GOLD"), eq(items.is_deleted, false)))
    .orderBy(items.entry_no);

  const goldItemIds = goldItems.map((item) => item.id);
  // One row per item AND touch: the touch is typed by hand on each bill, so the
  // same name bought at two touches is two stock lines, and buying the same name
  // at the same touch adds to the line that is already there.
  const itemBalances = await getAccountItemTouchBalances(SYSTEM_ACCOUNTS.SHOP_ID, goldItemIds);

  const flatItems = itemBalances
    // A negative line means more was sold at that touch than was ever bought at
    // it — kept visible rather than hidden, so the mistake can be corrected.
    .filter((bal) => !bal.quantity.eq(toDecimal("0")))
    .map((bal) => {
      const item = goldItems.find((i) => i.id === bal.item_id)!;
      const qty = Number(bal.quantity);
      const pur = bal.purity ? Number(bal.purity) : null;
      const pureQty = bal.pure_quantity ? Number(bal.pure_quantity) : null;
      return {
        item,
        touch: bal.touch,
        lot_id: null as string | null,  // gold carries no lot
        balance: isNaN(qty) ? '0.000' : bal.quantity.toFixed(3),
        // 3 decimals: gold stock is held per touch, and a 99.999 purchase must
        // not read as 100.00 in the row that represents it.
        purity: pur !== null && !isNaN(pur) ? bal.purity!.toFixed(3) : undefined,
        average_touch: bal.average_touch
          ? bal.average_touch.toFixed(3)
          : (pur !== null && !isNaN(pur) ? bal.purity!.toFixed(3) : undefined),
        pure_balance: pureQty !== null && !isNaN(pureQty) ? bal.pure_quantity!.toFixed(3) : undefined,
        created_at: bal.created_at,
      };
    });

  // Preserve item master order (entry_no)
  flatItems.sort((a, b) => (a.item.entry_no ?? 0) - (b.item.entry_no ?? 0));
  const offset = (input.page - 1) * input.limit;
  return { data: flatItems.slice(offset, offset + input.limit), total: flatItems.length };
}

// ─── stock.getOrnamentStock ───────────────────────────────────────────────────

export async function getOrnamentStock(input: { page: number; limit: number }) {
  const ornamentItems = await db
    .select()
    .from(items)
    .where(and(eq(items.type, "ORNAMENT"), eq(items.is_deleted, false)))
    .orderBy(items.entry_no);

  const ornamentItemIds = ornamentItems.map((item) => item.id);
  const lots = await getAccountLotBalances(SYSTEM_ACCOUNTS.SHOP_ID, ornamentItemIds);

  // Only lots with a positive physical balance are actually "in stock" — a lot
  // that's been fully sold/returned nets to zero or negative and has nothing
  // left to show. Without this filter the table listed every lot ever touched
  // (including negative-balance ones), while the summary card's "Ornaments"
  // count only counted positive-balance lots — the two numbers disagreed
  // (e.g. table showing 5 rows, card showing 2) even though they describe the
  // same stock.
  const positiveLots = lots.filter((lot) => {
    const qty = Number(lot.quantity);
    return !isNaN(qty) && qty > 0;
  });

  const flatLots = positiveLots.map((lot) => {
    const item = ornamentItems.find((i) => i.id === lot.item_id)!;
    const qty = Number(lot.quantity);
    const pur = lot.purity ? Number(lot.purity) : null;
    const pureQty = lot.pure_quantity ? Number(lot.pure_quantity) : null;
    return {
      item,
      lot_id: lot.lot_id,
      balance: isNaN(qty) ? '0.000' : lot.quantity.toFixed(3),
      purity: pur !== null && !isNaN(pur) ? lot.purity!.toFixed(2) : undefined,
      average_touch: lot.average_touch ? lot.average_touch.toFixed(2) : (pur !== null && !isNaN(pur) ? lot.purity!.toFixed(2) : undefined),
      pure_balance: pureQty !== null && !isNaN(pureQty) ? lot.pure_quantity!.toFixed(3) : undefined,
      created_at: lot.created_at,
    };
  });

  // Newest purchases first — so page 1 always shows the latest stock
  flatLots.sort((a, b) => b.created_at.getTime() - a.created_at.getTime());

  // Totals across ALL in-stock lots (not just this page) for the summary cards.
  let totalWeight = toDecimal("0");
  let totalPure = toDecimal("0");
  for (const lot of positiveLots) {
    totalWeight = totalWeight.plus(lot.quantity);
    if (lot.pure_quantity) totalPure = totalPure.plus(lot.pure_quantity);
  }
  const totals = {
    lots: positiveLots.length,
    items: new Set(positiveLots.map((lot) => lot.item_id)).size,
    weight: totalWeight.toFixed(3),
    pure: totalPure.toFixed(3),
    // Weighted average touch = total pure ÷ total weight.
    avg_touch: totalWeight.gt(0) ? totalPure.div(totalWeight).mul(100).toFixed(2) : "0.00",
  };

  const offset = (input.page - 1) * input.limit;
  return { data: flatLots.slice(offset, offset + input.limit), total: flatLots.length, totals };
}

async function getMcGoldStock() {
  return [] as any[];
}

// ─── stock.addOpeningStock ────────────────────────────────────────────────────

const AddOpeningStockSchema = z.object({
  date: z.string().date(),
  gold_items: z
    .array(
      z.object({
        item_id: z.string().uuid(),
        quantity: z.string(),
        purity: z.string(),
      }),
    )
    .optional()
    .default([]),
  ornament_items: z
    .array(
      z.object({
        item_id: z.string().uuid(),
        quantity: z.string(),
        purity: z.string(),
      }),
    )
    .optional()
    .default([]),
  mc_gold_items: z
    .array(
      z.object({
        account_id: z.string().uuid(),
        item_id: z.string().uuid(),
        quantity: z.string(),
        purity: z.string(),
      }),
    )
    .optional()
    .default([]),
});

type AddOpeningStockInput = z.infer<typeof AddOpeningStockSchema>;

async function addOpeningStock(input: AddOpeningStockInput) {
  const { date, gold_items, ornament_items, mc_gold_items } = input;

  // ── Validation ─────────────────────────────────────────────────────────────
  if (gold_items.length === 0 && ornament_items.length === 0 && mc_gold_items.length === 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "At least one stock item is required",
    });
  }

  const isPositive = (v: string) => toDecimal(v).gt(0);

  for (const item of gold_items) {
    if (!isPositive(item.quantity) || !isPositive(item.purity)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "All quantity and purity values must be greater than zero",
      });
    }
  }
  for (const item of ornament_items) {
    if (!isPositive(item.quantity) || !isPositive(item.purity)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "All quantity and purity values must be greater than zero",
      });
    }
  }
  for (const item of mc_gold_items) {
    if (!isPositive(item.quantity) || !isPositive(item.purity)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "All quantity and purity values must be greater than zero",
      });
    }
  }

  // ── Step 1: Shop stock (gold + ornaments in one entry group) ────────────────
  if (gold_items.length > 0 || ornament_items.length > 0) {
    const shopEntries = [
      ...gold_items.map((item) => ({
        fromAccountId: SYSTEM_ACCOUNTS.OPENING_STOCK_ID,
        toAccountId: SYSTEM_ACCOUNTS.SHOP_ID,
        itemId: item.item_id,
        quantity: item.quantity,
        purity: item.purity,
      })),
      ...ornament_items.map((item) => ({
        fromAccountId: SYSTEM_ACCOUNTS.OPENING_STOCK_ID,
        toAccountId: SYSTEM_ACCOUNTS.SHOP_ID,
        itemId: item.item_id,
        quantity: item.quantity,
        purity: item.purity,
      })),
    ];

    await createEntryGroup({
      type: "OPENING",
      accountId: SYSTEM_ACCOUNTS.OPENING_STOCK_ID,
      date,
      entries: shopEntries,
    });
  }

  // ── Step 2: MC gold — one entry group per goldsmith ──────────────────────────
  for (const mcItem of mc_gold_items) {
    await createEntryGroup({
      type: "OPENING",
      accountId: SYSTEM_ACCOUNTS.OPENING_STOCK_ID,
      date,
      entries: [
        {
          fromAccountId: SYSTEM_ACCOUNTS.OPENING_STOCK_ID,
          toAccountId: mcItem.account_id,
          itemId: mcItem.item_id,
          quantity: mcItem.quantity,
          purity: mcItem.purity,
        },
      ],
    });
  }

  return { success: true };
}

// ─── stock.deleteByLot ──────────────────────────────────────────────────────

const DeleteByLotSchema = z.object({
  lot_id: z.string().min(1),
});

async function deleteStockByLot(input: z.infer<typeof DeleteByLotSchema>) {
  const { entries: entriesTable, entryGroups } = await import("@/db/schema");
  const { reverseEntryGroup } = await import("@/lib/reversal");
  const { isNull } = await import("drizzle-orm");

  // Find the entry_group that created this lot
  const lotEntries = await db
    .select({ group_id: entriesTable.group_id })
    .from(entriesTable)
    .where(eq(entriesTable.lot_id, input.lot_id))
    .limit(1);

  const firstEntry = lotEntries[0];
  if (!firstEntry) {
    throw new TRPCError({ code: "NOT_FOUND", message: "No entries found for this lot" });
  }

  const groupId = firstEntry.group_id;

  // Check if already reversed/deleted
  const [group] = await db
    .select({ is_deleted: entryGroups.is_deleted, reversed_by: entryGroups.reversed_by })
    .from(entryGroups)
    .where(eq(entryGroups.id, groupId))
    .limit(1);

  if (group?.is_deleted || group?.reversed_by) {
    // Orphaned reversal: group was reversed before lot_id preservation fix.
    // The reversal entry_group exists but its entries have lot_id=null,
    // so getLotBalances still shows a positive balance. Fix by backfilling lot_id.
    const reversalGroupId = group.reversed_by;
    if (reversalGroupId) {
      await db
        .update(entriesTable)
        .set({ lot_id: input.lot_id })
        .where(
          and(
            eq(entriesTable.group_id, reversalGroupId),
            isNull(entriesTable.lot_id),
          ),
        );
    }
    return { success: true };
  }

  await reverseEntryGroup(groupId);
  return { success: true };
}

// ─── stock.getProfitLossStock ──────────────────────────────────────────────────

async function getProfitLossStock(input: { page: number; limit: number }) {
  const { entries: entriesTable, entryGroups } = await import("@/db/schema");
  const { inArray, desc, sql } = await import("drizzle-orm");

  const conditions = [
    eq(entryGroups.is_deleted, false),
    inArray(entryGroups.type, ["SALE", "PURCHASE"]),
    inArray(items.type, ["GOLD", "ORNAMENT"]),
  ];

  const offset = (input.page - 1) * input.limit;

  const [data, [countRow], aggregates] = await Promise.all([
    db
      .select({
        entry: entriesTable,
        group: entryGroups,
        item: items,
      })
      .from(entriesTable)
      .innerJoin(entryGroups, eq(entriesTable.group_id, entryGroups.id))
      .innerJoin(items, eq(entriesTable.item_id, items.id))
      .where(and(...conditions))
      .orderBy(desc(entryGroups.created_at))
      .limit(input.limit)
      .offset(offset),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(entriesTable)
      .innerJoin(entryGroups, eq(entriesTable.group_id, entryGroups.id))
      .innerJoin(items, eq(entriesTable.item_id, items.id))
      .where(and(...conditions)),
    db
      .select({
        // Physical pure (quantity × purity), NOT the ledger's stored pure_quantity —
        // cash-mode Sale/Purchase entries deliberately zero pure_quantity (see lib/balance.ts).
        sales_pure: sql<string>`COALESCE(SUM(CASE WHEN ${entryGroups.type} = 'SALE' THEN ${entriesTable.quantity} * COALESCE(${entriesTable.purity}, 0) / 100 ELSE 0 END), 0)::text`,
        purchases_pure: sql<string>`COALESCE(SUM(CASE WHEN ${entryGroups.type} = 'PURCHASE' THEN ${entriesTable.quantity} * COALESCE(${entriesTable.purity}, 0) / 100 ELSE 0 END), 0)::text`,
        sales_amount: sql<string>`COALESCE(SUM(CASE WHEN ${entryGroups.type} = 'SALE' THEN (${entriesTable.quantity} * COALESCE(${entriesTable.purity}, 0) / 100) * COALESCE(${entriesTable.rate}, ${entryGroups.rate_per_gram}, 0) ELSE 0 END), 0)::text`,
        purchases_amount: sql<string>`COALESCE(SUM(CASE WHEN ${entryGroups.type} = 'PURCHASE' THEN (${entriesTable.quantity} * COALESCE(${entriesTable.purity}, 0) / 100) * COALESCE(${entriesTable.rate}, ${entryGroups.rate_per_gram}, 0) ELSE 0 END), 0)::text`,
      })
      .from(entriesTable)
      .innerJoin(entryGroups, eq(entriesTable.group_id, entryGroups.id))
      .innerJoin(items, eq(entriesTable.item_id, items.id))
      .where(and(...conditions))
  ]);

  const mapped = data.map((row) => {
    const isPurchase = row.group.type === "PURCHASE";
    const quantity = toDecimal(row.entry.quantity);
    const purity = toDecimal(row.entry.average_touch || row.entry.purity || "0");
    // Physical pure (quantity × purity), NOT the ledger's stored pure_quantity —
    // cash-mode Sale/Purchase entries deliberately zero pure_quantity (see lib/balance.ts).
    const pure = quantity.mul(toDecimal(row.entry.purity || "0")).div(100);
    const rate = toDecimal(row.entry.rate || row.group.rate_per_gram || "0");
    const total = pure.mul(rate);

    return {
      id: row.entry.id,
      bill_no: row.group.bill_no ?? 0,
      date: row.group.date,
      item_name: row.item.name,
      quantity: quantity.toFixed(3),
      weight: quantity.toFixed(3),
      touch: purity.toFixed(2),
      buying_price: isPurchase ? rate.toFixed(2) : null,
      selling_price: !isPurchase ? rate.toFixed(2) : null,
      pure: pure.toFixed(3),
      total: total.toFixed(2),
      type: row.group.type,
    };
  });

  const aggRow = aggregates?.[0];
  const salesPure = toDecimal(aggRow?.sales_pure || "0");
  const purchasesPure = toDecimal(aggRow?.purchases_pure || "0");
  const salesAmount = toDecimal(aggRow?.sales_amount || "0");
  const purchasesAmount = toDecimal(aggRow?.purchases_amount || "0");

  const goldProfitLoss = salesPure.minus(purchasesPure);
  const cashProfitLoss = salesAmount.minus(purchasesAmount);

  return {
    data: mapped,
    total: countRow?.total ?? 0,
    aggregates: {
      gold_profit_loss: goldProfitLoss.toFixed(3),
      cash_profit_loss: cashProfitLoss.toFixed(2),
    }
  };
}

// ─── stock.getExportData ──────────────────────────────────────────────────────

async function getExportData() {
  const { entries: entriesTable, entryGroups } = await import("@/db/schema");
  const { inArray, desc } = await import("drizzle-orm");

  // 1. Gold Stock
  const goldItems = await db
    .select()
    .from(items)
    .where(and(eq(items.type, "GOLD"), eq(items.is_deleted, false)))
    .orderBy(items.entry_no);

  const goldItemIds = goldItems.map((item) => item.id);

  // 2. Ornament Stock
  const ornamentItems = await db
    .select()
    .from(items)
    .where(and(eq(items.type, "ORNAMENT"), eq(items.is_deleted, false)))
    .orderBy(items.entry_no);

  const ornamentItemIds = ornamentItems.map((item) => item.id);

  // Fetch shop gold lots, shop ornament lots, MC gold lots, and profit/loss data in parallel
  const [shopGoldLots, shopOrnamentLots, mcGoldStock, profitLossData] = await Promise.all([
    getAccountLotBalances(SYSTEM_ACCOUNTS.SHOP_ID, goldItemIds),
    getAccountLotBalances(SYSTEM_ACCOUNTS.SHOP_ID, ornamentItemIds),
    getMcGoldStock(),
    db
      .select({
        entry: entriesTable,
        group: entryGroups,
        item: items,
      })
      .from(entriesTable)
      .innerJoin(entryGroups, eq(entriesTable.group_id, entryGroups.id))
      .innerJoin(items, eq(entriesTable.item_id, items.id))
      .where(
        and(
          eq(entryGroups.is_deleted, false),
          inArray(entryGroups.type, ["SALE", "PURCHASE"]),
          inArray(items.type, ["GOLD", "ORNAMENT"])
        )
      )
      .orderBy(desc(entryGroups.created_at))
  ]);

  const goldLots = shopGoldLots.map((lot) => {
    const item = goldItems.find((i) => i.id === lot.item_id)!;
    return {
      "Lot ID": lot.lot_id ?? "-",
      "Gold Type": item.name,
      "Weight (g)": Number(lot.quantity.toFixed(3)),
      "Touch %": lot.purity ? Number(lot.purity.toFixed(2)) : 0,
      "Avg. Touch %": lot.average_touch ? Number(lot.average_touch.toFixed(2)) : (lot.purity ? Number(lot.purity.toFixed(2)) : 0),
      "Pure Weight (g)": lot.pure_quantity ? Number(lot.pure_quantity.toFixed(3)) : 0,
      "Date Added": new Date(lot.created_at).toLocaleDateString("en-IN"),
    };
  });

  const ornamentLots = shopOrnamentLots.map((lot) => {
    const item = ornamentItems.find((i) => i.id === lot.item_id)!;
    return {
      "Lot ID": lot.lot_id ?? "-",
      "Ornament Type": item.name,
      "Weight (g)": Number(lot.quantity.toFixed(3)),
      "Touch %": lot.purity ? Number(lot.purity.toFixed(2)) : 0,
      "Avg. Touch %": lot.average_touch ? Number(lot.average_touch.toFixed(2)) : (lot.purity ? Number(lot.purity.toFixed(2)) : 0),
      "Pure Weight (g)": lot.pure_quantity ? Number(lot.pure_quantity.toFixed(3)) : 0,
      "Date Added": new Date(lot.created_at).toLocaleDateString("en-IN"),
    };
  });

  const mcGoldLots = mcGoldStock.map((row) => ({
    "Goldsmith": row.goldsmith.name,
    "Lot ID": row.lot_id ?? "-",
    "Gold Type": row.item.name,
    "Weight (g)": Number(Number(row.balance).toFixed(3)),
    "Touch %": row.purity ? Number(Number(row.purity).toFixed(2)) : 0,
    "Avg. Touch %": row.average_touch ? Number(Number(row.average_touch).toFixed(2)) : (row.purity ? Number(Number(row.purity).toFixed(2)) : 0),
    "Pure Weight (g)": row.pure_balance ? Number(Number(row.pure_balance).toFixed(3)) : 0,
    "Date Added": new Date(row.created_at).toLocaleDateString("en-IN"),
  }));

  const profitLossLots = profitLossData.map((row) => {
    const isPurchase = row.group.type === "PURCHASE";
    const quantity = toDecimal(row.entry.quantity);
    const purity = toDecimal(row.entry.average_touch || row.entry.purity || "0");
    // Physical pure (quantity × purity), NOT the ledger's stored pure_quantity —
    // cash-mode Sale/Purchase entries deliberately zero pure_quantity (see lib/balance.ts).
    const pure = quantity.mul(toDecimal(row.entry.purity || "0")).div(100);
    const rate = toDecimal(row.entry.rate || row.group.rate_per_gram || "0");
    const total = pure.mul(rate);

    return {
      // Real ledger entry_no (per-type sequence), not a fabricated running index.
      "Entry No": row.group.entry_no != null ? String(row.group.entry_no) : "-",
      "Type": isPurchase ? "Purchase" : "Sale",
      "Bill No": String(row.group.bill_no ?? 0),
      "Date": new Date(row.group.date).toLocaleDateString("en-IN"),
      "Item Name": row.item.name,
      "Quantity": Number(quantity.toFixed(3)),
      "Weight (g)": Number(quantity.toFixed(3)),
      "Touch %": Number(purity.toFixed(2)),
      "Buying Price (Rate)": isPurchase ? Number(rate.toFixed(2)) : 0,
      "Selling Price (Rate)": !isPurchase ? Number(rate.toFixed(2)) : 0,
      "Pure Weight (g)": Number(pure.toFixed(3)),
      "Total Amount": Number(total.toFixed(2)),
    };
  });

  return {
    goldStock: goldLots,
    ornamentStock: ornamentLots,
    mcGoldStock: mcGoldLots,
    profitLossStock: profitLossLots,
  };
}

// ─── stock.getJobWorkTotals ───────────────────────────────────────────────────

/**
 * Pure gold issued to / received back from job workers in a date range.
 * Out = SHOP → party, In = party → SHOP, on non-deleted JOB_WORK bills, gold and
 * ornament lines only (money lines — incl. "Cash conversion:" — are excluded),
 * skipping Gold↔Cash conversion groups. Pure = stored pure_quantity, else
 * quantity × purity / 100 (same basis as reports/service.ts).
 */
async function getJobWorkTotals(input: { from_date: string; to_date: string }) {
  const { entries: entriesTable, entryGroups } = await import("@/db/schema");
  const { sql, gte, lte, inArray } = await import("drizzle-orm");

  const shop = SYSTEM_ACCOUNTS.SHOP_ID;
  const pureExpr = sql`COALESCE(NULLIF(${entriesTable.pure_quantity}, 0), ${entriesTable.quantity} * COALESCE(${entriesTable.purity}, 0) / 100)`;

  const [row] = await db
    .select({
      out_pure: sql<string>`COALESCE(SUM(CASE WHEN ${entriesTable.from_account_id} = ${shop} THEN ${pureExpr} ELSE 0 END), 0)::text`,
      in_pure: sql<string>`COALESCE(SUM(CASE WHEN ${entriesTable.to_account_id} = ${shop} THEN ${pureExpr} ELSE 0 END), 0)::text`,
    })
    .from(entriesTable)
    .innerJoin(entryGroups, eq(entriesTable.group_id, entryGroups.id))
    .innerJoin(items, eq(entriesTable.item_id, items.id))
    .where(
      and(
        eq(entryGroups.type, "JOB_WORK"),
        eq(entryGroups.is_deleted, false),
        gte(entryGroups.date, input.from_date),
        lte(entryGroups.date, input.to_date),
        inArray(items.type, ["GOLD", "ORNAMENT"]),
        sql`COALESCE(${entryGroups.remarks}, '') NOT LIKE 'Gold to Cash Conversion%'`,
        sql`COALESCE(${entryGroups.remarks}, '') NOT LIKE 'Cash to Gold Conversion%'`,
        sql`COALESCE(${entriesTable.remarks}, '') NOT LIKE 'Cash conversion:%'`
      )
    );

  const outPure = toDecimal(row?.out_pure || "0");
  const inPure = toDecimal(row?.in_pure || "0");

  return {
    out_pure: outPure.toFixed(3),
    in_pure: inPure.toFixed(3),
    balance_pure: outPure.minus(inPure).toFixed(3),
  };
}

// ─── stock.getStockMovement ───────────────────────────────────────────────────

/**
 * Shop stock movement (gold + ornament) in a date range — the Stock page's
 * "Net Gold Movement" card. IN = lines TO the shop, OUT = lines FROM the shop,
 * GOLD/ORNAMENT items only (MONEY excluded, which also drops the money-only
 * Gold↔Cash conversion groups and "Cash conversion:" lines).
 *
 * Deletes / edits: stock balances (lib/balance.ts) sum every entry, so a
 * reversed bill contributes its original AND its REVERSAL group (same date,
 * from/to swapped) — net zero. Here we skip both (is_deleted originals and
 * REVERSAL groups), exactly like reports getStockReport, so In − Out still
 * equals the stock change while the in/out columns don't show movements that
 * never happened. Pure = stored pure_quantity, else quantity × purity / 100
 * (same basis as getJobWorkTotals).
 */
async function getStockMovement(input: { from_date: string; to_date: string }) {
  const { entries: entriesTable, entryGroups } = await import("@/db/schema");
  const { sql, gte, lte, ne, inArray } = await import("drizzle-orm");

  const shop = SYSTEM_ACCOUNTS.SHOP_ID;
  // Same pure formula as the stock balances (quantity × purity), so Net always equals
  // the change in the Gold / Ornament stock totals over the same period.
  const pureExpr = sql`${entriesTable.quantity} * COALESCE(${entriesTable.purity}, 0) / 100`;
  const isIn = sql`${entriesTable.to_account_id} = ${shop}`;
  const isOut = sql`${entriesTable.from_account_id} = ${shop}`;

  const rows = await db
    .select({
      type: entryGroups.type,
      in_pure: sql<string>`COALESCE(SUM(CASE WHEN ${isIn} THEN ${pureExpr} ELSE 0 END), 0)::text`,
      out_pure: sql<string>`COALESCE(SUM(CASE WHEN ${isOut} THEN ${pureExpr} ELSE 0 END), 0)::text`,
      in_weight: sql<string>`COALESCE(SUM(CASE WHEN ${isIn} THEN ${entriesTable.quantity} ELSE 0 END), 0)::text`,
      out_weight: sql<string>`COALESCE(SUM(CASE WHEN ${isOut} THEN ${entriesTable.quantity} ELSE 0 END), 0)::text`,
    })
    .from(entriesTable)
    .innerJoin(entryGroups, eq(entriesTable.group_id, entryGroups.id))
    .innerJoin(items, eq(entriesTable.item_id, items.id))
    .where(
      and(
        eq(entryGroups.is_deleted, false),
        ne(entryGroups.type, "REVERSAL"),
        gte(entryGroups.date, input.from_date),
        lte(entryGroups.date, input.to_date),
        inArray(items.type, ["GOLD", "ORNAMENT"]),
        or(eq(entriesTable.to_account_id, shop), eq(entriesTable.from_account_id, shop))
      )
    )
    .groupBy(entryGroups.type);

  const zero = toDecimal("0");
  let inPure = zero;
  let outPure = zero;
  let inWeight = zero;
  let outWeight = zero;
  const byType: { type: string; in_pure: string; out_pure: string }[] = [];

  for (const r of rows) {
    const ip = toDecimal(r.in_pure || "0");
    const op = toDecimal(r.out_pure || "0");
    inPure = inPure.plus(ip);
    outPure = outPure.plus(op);
    inWeight = inWeight.plus(toDecimal(r.in_weight || "0"));
    outWeight = outWeight.plus(toDecimal(r.out_weight || "0"));
    byType.push({ type: String(r.type), in_pure: ip.toFixed(3), out_pure: op.toFixed(3) });
  }
  byType.sort((a, b) => a.type.localeCompare(b.type));

  return {
    in_pure: inPure.toFixed(3),
    out_pure: outPure.toFixed(3),
    net_pure: inPure.minus(outPure).toFixed(3),
    in_weight: inWeight.toFixed(3),
    out_weight: outWeight.toFixed(3),
    by_type: byType,
  };
}

// ─── Router ───────────────────────────────────────────────────────────────────

const JobWorkTotalsSchema = z.object({
  from_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD"),
  to_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD"),
});

const PageSchema = z.object({
  page: z.number().int().min(1).default(1),
  limit: z.number().int().min(1).max(100).default(20),
});

const IncomeStatementSchema = z.object({
  range: z.enum(["today", "week", "month", "year", "all", "custom"]).default("month"),
  from_date: z.string().optional(),
  to_date: z.string().optional(),
});

export const stockRouter = router({
  getSummary: protectedProcedure.query(async () => getSummary()),
  getJobWorkTotals: protectedProcedure.input(JobWorkTotalsSchema).query(async ({ input }) => getJobWorkTotals(input)),
  // Melting in/out/loss over a date range (same date-range input as job work).
  getMeltingTotals: protectedProcedure.input(JobWorkTotalsSchema).query(async ({ input }) => getMeltingTotals(input)),
  // Shop gold+ornament stock IN/OUT/net over a date range ("Net Gold Movement" card).
  getStockMovement: protectedProcedure.input(JobWorkTotalsSchema).query(async ({ input }) => getStockMovement(input)),
  getGoldStock: protectedProcedure.input(PageSchema).query(async ({ input }) => getGoldStock(input)),
  getOrnamentStock: protectedProcedure.input(PageSchema).query(async ({ input }) => getOrnamentStock(input)),
  getMcGoldStock: protectedProcedure.query(async () => getMcGoldStock()),
  getProfitLossStock: protectedProcedure.input(PageSchema).query(async ({ input }) => getProfitLossStock(input)),
  getIncomeStatement: protectedProcedure.input(IncomeStatementSchema).query(async ({ input }) => getIncomeStatement(input)),
  getExportData: protectedProcedure.query(async () => getExportData()),
  addOpeningStock: guardedProcedure("stock", "stock", "edit")
    .input(AddOpeningStockSchema)
    .mutation(async ({ input }) => addOpeningStock(input)),
  deleteByLot: guardedProcedure("stock", "stock", "edit")
    .input(DeleteByLotSchema)
    .mutation(async ({ input }) => deleteStockByLot(input)),
});
