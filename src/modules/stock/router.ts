import { router, protectedProcedure, guardedProcedure } from "@/lib/trpc";
import { z } from "zod";
import { getBalances, getLotBalances, getAccountLotBalances, getAccountItemBalances, getAllGoldsmithsLotBalances } from "@/lib/balance";
import { toDecimal, type Decimal } from "@/lib/decimal";
import { db } from "@/db";
import { items, accounts } from "@/db/schema";
import { eq, and, or } from "drizzle-orm";
import { SYSTEM_ACCOUNTS } from "@/config/constants";
import { createEntryGroup } from "@/lib/entryBuilder";
import { getIncomeStatement } from "@/modules/reports/incomeStatement";
import { TRPCError } from "@trpc/server";

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
  const [shopLots, mcLots, profitLossRows] = await Promise.all([
    getAccountLotBalances(SYSTEM_ACCOUNTS.SHOP_ID),
    getAllGoldsmithsLotBalances(goldItemIds),
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
  for (const lot of shopLots) {
    if (goldItemIds.includes(lot.item_id)) {
      const pq = lot.pure_quantity ?? zero;
      if (isFinite(Number(pq))) {
        gold_total_pure = gold_total_pure.plus(pq);
      }
    }
  }

  // 2. Ornament count: number of distinct items with positive balance in shop
  const ornamentBalances = new Map<string, Decimal>();
  for (const lot of shopLots) {
    if (ornamentItemIds.includes(lot.item_id)) {
      const qty = lot.quantity ?? zero;
      if (isFinite(Number(qty))) {
        const current = ornamentBalances.get(lot.item_id) ?? zero;
        ornamentBalances.set(lot.item_id, current.plus(qty));
      }
    }
  }
  const ornaments_in_stock = Array.from(ornamentBalances.values()).filter((b) => b.gt(zero)).length;

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
  // Pooled mode: sum all entries per item_id, ignoring lot_id
  const itemBalances = await getAccountItemBalances(SYSTEM_ACCOUNTS.SHOP_ID, goldItemIds);

  const flatItems = itemBalances
    .filter((bal) => bal.quantity.gt(toDecimal("0")))
    .map((bal) => {
      const item = goldItems.find((i) => i.id === bal.item_id)!;
      const qty = Number(bal.quantity);
      const pur = bal.purity ? Number(bal.purity) : null;
      const pureQty = bal.pure_quantity ? Number(bal.pure_quantity) : null;
      return {
        item,
        lot_id: null as string | null,  // no lot in pooled mode
        balance: isNaN(qty) ? '0.000' : bal.quantity.toFixed(3),
        purity: pur !== null && !isNaN(pur) ? bal.purity!.toFixed(2) : undefined,
        average_touch: bal.average_touch
          ? bal.average_touch.toFixed(2)
          : (pur !== null && !isNaN(pur) ? bal.purity!.toFixed(2) : undefined),
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

  const flatLots = lots.map((lot) => {
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
  const offset = (input.page - 1) * input.limit;
  return { data: flatLots.slice(offset, offset + input.limit), total: flatLots.length };
}

async function getMcGoldStock() {
  const goldsmiths = await db
    .select()
    .from(accounts)
    .where(
      and(
        or(eq(accounts.type, "GOLDSMITH"), eq(accounts.customer_type, "GOLD_SMITH")),
        eq(accounts.is_deleted, false)
      )
    );

  const goldItems = await db
    .select()
    .from(items)
    .where(and(eq(items.type, "GOLD"), eq(items.is_deleted, false)))
    .orderBy(items.entry_no);

  const goldItemIds = goldItems.map((item) => item.id);
  const lots = await getAllGoldsmithsLotBalances(goldItemIds);

  const flatLots = lots.map((lot) => {
    const g = goldsmiths.find((acc) => acc.id === lot.account_id)!;
    const item = goldItems.find((i) => i.id === lot.item_id)!;
    return {
      goldsmith: g,
      item,
      lot_id: lot.lot_id,
      balance: lot.quantity.toFixed(3),
      purity: lot.purity?.toFixed(2),
      average_touch: lot.average_touch ? lot.average_touch.toFixed(2) : (lot.purity ? lot.purity.toFixed(2) : undefined),
      pure_balance: lot.pure_quantity?.toFixed(3),
      created_at: lot.created_at,
    };
  });

  flatLots.sort((a, b) => a.created_at.getTime() - b.created_at.getTime());
  return flatLots;
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
        sales_pure: sql<string>`COALESCE(SUM(CASE WHEN ${entryGroups.type} = 'SALE' THEN ${entriesTable.pure_quantity} ELSE 0 END), 0)::text`,
        purchases_pure: sql<string>`COALESCE(SUM(CASE WHEN ${entryGroups.type} = 'PURCHASE' THEN ${entriesTable.pure_quantity} ELSE 0 END), 0)::text`,
        sales_amount: sql<string>`COALESCE(SUM(CASE WHEN ${entryGroups.type} = 'SALE' THEN ${entriesTable.pure_quantity} * COALESCE(${entriesTable.rate}, ${entryGroups.rate_per_gram}, 0) ELSE 0 END), 0)::text`,
        purchases_amount: sql<string>`COALESCE(SUM(CASE WHEN ${entryGroups.type} = 'PURCHASE' THEN ${entriesTable.pure_quantity} * COALESCE(${entriesTable.rate}, ${entryGroups.rate_per_gram}, 0) ELSE 0 END), 0)::text`,
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
    const pure = toDecimal(row.entry.pure_quantity || "0");
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
    const pure = toDecimal(row.entry.pure_quantity || "0");
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

// ─── Router ───────────────────────────────────────────────────────────────────

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
