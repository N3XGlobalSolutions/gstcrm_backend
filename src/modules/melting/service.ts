import { and, asc, desc, eq, gte, inArray, lte, ne, or, sql, type SQL } from "drizzle-orm";
import { db, type Database } from "@/db";
import { entries, items, meltingAlloys, meltingEntries, meltingLines, metals } from "@/db/schema";
import { SYSTEM_ACCOUNTS } from "@/config/constants";
import { toDecimal, toQuantityString, type Decimal } from "@/lib/decimal";
import { createEntryGroup } from "@/lib/entryBuilder";
import { reverseEntryGroup } from "@/lib/reversal";
import { AppError } from "@/types/errors";
import { computeAlloy, computeMeltLoss, type MeltLossResult } from "./alloy";
import type {
  CreateMeltingInput,
  CreateMetalInput,
  ListMeltingInput,
  MeltingAlloyInput,
  MeltingLineInput,
  UpdateMeltingInput,
  UpdateMetalInput,
} from "./schema";

export { computeAlloy, computeMeltLoss } from "./alloy";

// Melting register. Since 0023 every saved entry posts one MELTING entry_group
// that moves the melted lots out of SHOP stock and the melted gold back in
// (see "Stock posting" below). Pre-0023 entries have no group and stay
// record-only until they are edited.

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

// ─── Metals ──────────────────────────────────────────────────────────────────

export async function listMetals(): Promise<{ id: string; name: string }[]> {
  return db
    .select({ id: metals.id, name: metals.name })
    .from(metals)
    .orderBy(asc(sql`lower(${metals.name})`));
}

async function assertMetalNameFree(name: string, exceptId?: string) {
  const conds: SQL[] = [sql`lower(${metals.name}) = lower(${name})`];
  if (exceptId) conds.push(ne(metals.id, exceptId));
  const [dup] = await db
    .select({ id: metals.id })
    .from(metals)
    .where(and(...conds))
    .limit(1);
  if (dup) throw new AppError("CONFLICT", "Metal already exists", "name");
}

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.code === "23505" || e?.cause?.code === "23505";
}

export async function createMetal(input: CreateMetalInput) {
  const name = input.name.trim();
  await assertMetalNameFree(name);
  try {
    const [row] = await db
      .insert(metals)
      .values({ name })
      .returning({ id: metals.id, name: metals.name });
    return row!;
  } catch (err) {
    // Lost a race with a concurrent create of the same name.
    if (isUniqueViolation(err)) throw new AppError("CONFLICT", "Metal already exists", "name");
    throw err;
  }
}

export async function updateMetal(input: UpdateMetalInput) {
  const name = input.name.trim();
  await assertMetalNameFree(name, input.id);
  try {
    const [row] = await db
      .update(metals)
      .set({ name, updated_at: new Date() })
      .where(eq(metals.id, input.id))
      .returning({ id: metals.id, name: metals.name });
    if (!row) throw new AppError("NOT_FOUND", "Metal not found");
    return row;
  } catch (err) {
    if (isUniqueViolation(err)) throw new AppError("CONFLICT", "Metal already exists", "name");
    throw err;
  }
}

export async function deleteMetal(id: string) {
  const [used] = await db
    .select({ id: meltingEntries.id })
    .from(meltingEntries)
    .where(and(eq(meltingEntries.metal_id, id), eq(meltingEntries.is_deleted, false)))
    .limit(1);
  const [usedAsAlloy] = await db
    .select({ id: meltingAlloys.id })
    .from(meltingAlloys)
    .innerJoin(meltingEntries, eq(meltingEntries.id, meltingAlloys.melting_id))
    .where(and(eq(meltingAlloys.metal_id, id), eq(meltingEntries.is_deleted, false)))
    .limit(1);
  if (used || usedAsAlloy) {
    throw new AppError("BUSINESS_RULE_VIOLATION", "Metal is used in melting entries");
  }
  // Soft-deleted melting entries still reference the metal through the FK, so
  // a hard delete would fail there too — report it the same way.
  const [anyRef] = await db
    .select({ id: meltingEntries.id })
    .from(meltingEntries)
    .where(eq(meltingEntries.metal_id, id))
    .limit(1);
  const [anyAlloyRef] = await db
    .select({ id: meltingAlloys.id })
    .from(meltingAlloys)
    .where(eq(meltingAlloys.metal_id, id))
    .limit(1);
  if (anyRef || anyAlloyRef) {
    throw new AppError(
      "BUSINESS_RULE_VIOLATION",
      "Metal is referenced by deleted melting entries and cannot be removed",
    );
  }
  const [row] = await db.delete(metals).where(eq(metals.id, id)).returning({ id: metals.id });
  if (!row) throw new AppError("NOT_FOUND", "Metal not found");
  return { success: true as const };
}

// ─── Line math ───────────────────────────────────────────────────────────────
// Mirrors SalesItemGrid computeRow / createSale exactly (decimal.js ROUND_HALF_UP):
//   pure       = weight × touch / 100                         → 3dp
//   wastage    = weight × wastage% / touch  (Sales PERCENT mode, calcWastagePercent) → 3dp
//   total_pure = (weight + UNROUNDED wastage) × touch / 100   → 3dp
// Touch is required since 0023 and normalised to 3dp (the gold stock row key).

function computeLine(line: MeltingLineInput) {
  const weight = toDecimal(line.weight);
  const touch = toDecimal(line.touch);
  const wPct = line.wastage_percent !== null ? toDecimal(line.wastage_percent) : null;

  const pure = toQuantityString(weight.mul(touch).div(100));
  const rawWastage =
    wPct !== null && wPct.gt(0) && touch.gt(0) ? weight.mul(wPct).div(touch) : toDecimal(0);
  const wastage = wPct !== null ? toQuantityString(rawWastage) : null;
  const totalPure = toQuantityString(weight.plus(rawWastage).mul(touch).div(100));

  return {
    item_id: line.item_id,
    lot_id: line.lot_id,
    weight: toQuantityString(weight),
    touch: touch.toFixed(3),
    wastage_percent: line.wastage_percent,
    pure,
    wastage,
    total_pure: totalPure,
    quantity: line.quantity,
  };
}

type PreparedLine = ReturnType<typeof computeLine>;

async function assertMetalExists(tx: Tx, metalId: string) {
  const [m] = await tx.select({ id: metals.id }).from(metals).where(eq(metals.id, metalId)).limit(1);
  if (!m) throw new AppError("NOT_FOUND", "Selected metal no longer exists", "metal_id");
}

async function assertAlloyMetalsExist(tx: Tx, alloys: MeltingAlloyInput[]) {
  if (alloys.length === 0) return;
  const ids = [...new Set(alloys.map((a) => a.metal_id))];
  const found = await tx.select({ id: metals.id }).from(metals).where(inArray(metals.id, ids));
  if (found.length !== ids.length) {
    throw new AppError("NOT_FOUND", "Selected metal no longer exists", "alloys");
  }
}

async function insertLines(tx: Tx, meltingId: string, lines: PreparedLine[]) {
  await tx.insert(meltingLines).values(
    lines.map((l, i) => ({ melting_id: meltingId, sort_order: i, ...l })),
  );
}

async function insertAlloys(
  tx: Tx,
  meltingId: string,
  alloys: ReturnType<typeof computeAlloy>["alloys"],
) {
  if (alloys.length === 0) return;
  await tx.insert(meltingAlloys).values(
    alloys.map((a, i) => ({
      melting_id: meltingId,
      metal_id: a.metal_id,
      sort_order: i,
      share_percent: a.share_percent,
      grams: a.grams,
    })),
  );
}

// ─── Stock posting ───────────────────────────────────────────────────────────
// One MELTING entry_group per melting entry, dated the melting date, booked
// against the system LOSS account ("Loss / Wastage"):
//   each line  : SHOP → LOSS  (item, lot, quantity = weight, purity = touch)
//   output     : LOSS → SHOP  (output GOLD item, quantity = after_weight,
//                              purity = out_touch; gold carries no lot)
// The LOSS account's net is therefore exactly what was lost in the furnace.
// Edit = reverse + re-post (same as Purchase/Sales), delete = reverse.

const SHOP = SYSTEM_ACCOUNTS.SHOP_ID;
const LOSS = SYSTEM_ACCOUNTS.LOSS_ID;

type ItemMeta = { id: string; name: string; type: "GOLD" | "ORNAMENT" | "MONEY"; is_deleted: boolean };

async function loadItems(tx: Tx, ids: string[]): Promise<Map<string, ItemMeta>> {
  const unique = [...new Set(ids)];
  const rows = await tx
    .select({ id: items.id, name: items.name, type: items.type, is_deleted: items.is_deleted })
    .from(items)
    .where(inArray(items.id, unique));
  return new Map(rows.map((r) => [r.id, r]));
}

/**
 * Validates line items + output item and normalises lot ids: ornament lines
 * must name a lot (ornament stock is per lot); gold lines never carry one (gold
 * stock is one row per item AND touch — see getGoldStock).
 */
function validateItems(lines: PreparedLine[], outputItemId: string, meta: Map<string, ItemMeta>) {
  const out = meta.get(outputItemId);
  if (!out || out.is_deleted) {
    throw new AppError("NOT_FOUND", "Selected output item no longer exists", "output_item_id");
  }
  if (out.type !== "GOLD") {
    throw new AppError("VALIDATION_ERROR", "Output item must be a Gold item", "output_item_id");
  }
  return lines.map((l) => {
    const m = meta.get(l.item_id);
    if (!m) throw new AppError("NOT_FOUND", "A selected stock item no longer exists", "lines");
    if (m.type === "MONEY") {
      throw new AppError("VALIDATION_ERROR", `${m.name} is not a stock item`, "lines");
    }
    if (m.type === "ORNAMENT") {
      if (!l.lot_id) {
        throw new AppError("VALIDATION_ERROR", `Lot is required for ornament ${m.name}`, "lines");
      }
      return l;
    }
    return { ...l, lot_id: null };
  });
}

/** Net SHOP weight of one gold stock row (item + touch). */
async function goldTouchBalance(tx: Tx, itemId: string, touch: string) {
  const [row] = await tx.execute<{ available: string }>(
    sql`SELECT COALESCE(SUM(CASE WHEN to_account_id = ${SHOP} THEN quantity ELSE -quantity END), 0)::text AS available
        FROM ${entries}
        WHERE item_id = ${itemId}
          AND COALESCE(purity, 0) = ${touch}::numeric
          AND (to_account_id = ${SHOP} OR from_account_id = ${SHOP})`,
  );
  return toDecimal(row?.available ?? "0");
}

/**
 * Each stock row (gold: item+touch, ornament: item+lot) must hold at least the
 * total weight the lines take from it. Locks the rows like createSale does.
 */
async function assertStockAvailable(tx: Tx, lines: PreparedLine[], meta: Map<string, ItemMeta>) {
  const need = new Map<string, { line: PreparedLine; weight: Decimal }>();
  for (const l of lines) {
    const key = l.lot_id ? `${l.item_id}::lot::${l.lot_id}` : `${l.item_id}::touch::${l.touch}`;
    const cur = need.get(key);
    need.set(key, { line: l, weight: (cur?.weight ?? toDecimal(0)).plus(toDecimal(l.weight)) });
  }

  for (const { line, weight } of need.values()) {
    const name = meta.get(line.item_id)?.name ?? "item";
    let available: Decimal;
    let where: string;
    if (line.lot_id) {
      await tx.execute(
        sql`SELECT id FROM ${entries}
            WHERE item_id = ${line.item_id} AND lot_id = ${line.lot_id}
              AND (to_account_id = ${SHOP} OR from_account_id = ${SHOP})
            FOR UPDATE`,
      );
      const [row] = await tx.execute<{ available: string }>(
        sql`SELECT COALESCE(SUM(CASE WHEN to_account_id = ${SHOP} THEN quantity ELSE -quantity END), 0)::text AS available
            FROM ${entries}
            WHERE item_id = ${line.item_id} AND lot_id = ${line.lot_id}
              AND (to_account_id = ${SHOP} OR from_account_id = ${SHOP})`,
      );
      available = toDecimal(row?.available ?? "0");
      where = `lot ${line.lot_id}`;
    } else {
      await tx.execute(
        sql`SELECT id FROM ${entries}
            WHERE item_id = ${line.item_id}
              AND (to_account_id = ${SHOP} OR from_account_id = ${SHOP})
            FOR UPDATE`,
      );
      available = await goldTouchBalance(tx, line.item_id, line.touch);
      where = `touch ${line.touch}`;
    }
    if (available.lt(weight)) {
      throw new AppError(
        "BUSINESS_RULE_VIOLATION",
        `Not enough stock for ${name} (${where}). Available: ${toQuantityString(available.gt(0) ? available : toDecimal(0))} g, required: ${toQuantityString(weight)} g`,
        "lines",
      );
    }
  }
}

async function postMeltingGroup(
  tx: Tx,
  args: {
    entryNo: number;
    date: string;
    remarks: string | null;
    lines: PreparedLine[];
    outputItemId: string;
    afterWeight: string;
    outTouch: string;
  },
) {
  const { group } = await createEntryGroup(
    {
      type: "MELTING",
      accountId: LOSS,
      date: args.date,
      entryNo: args.entryNo,
      skipBillNo: true,
      remarks: `Melting #${args.entryNo}${args.remarks ? ` - ${args.remarks}` : ""}`,
      entries: [
        ...args.lines.map((l) => ({
          fromAccountId: SHOP,
          toAccountId: LOSS,
          itemId: l.item_id,
          lotId: l.lot_id ?? undefined,
          quantity: l.weight,
          purity: l.touch,
        })),
        {
          fromAccountId: LOSS,
          toAccountId: SHOP,
          itemId: args.outputItemId,
          quantity: args.afterWeight,
          purity: args.outTouch,
        },
      ],
    },
    tx,
  );
  return group.id;
}

/**
 * Reverses a previously posted group. If the melted gold it put into stock has
 * since been sold/used, taking it back out would drive that gold row negative —
 * refuse instead (checked after `afterReverse`, so an edit that re-adds the
 * same output is judged on the net effect).
 */
async function reverseMeltingGroup(
  tx: Tx,
  old: { entry_group_id: string; output_item_id: string | null; out_touch: string | null },
  afterReverse?: () => Promise<void>,
) {
  const touch = old.out_touch !== null ? toDecimal(old.out_touch).toFixed(3) : null;
  const before =
    old.output_item_id && touch ? await goldTouchBalance(tx, old.output_item_id, touch) : null;

  await reverseEntryGroup(old.entry_group_id, tx);
  if (afterReverse) await afterReverse();

  if (old.output_item_id && touch && before !== null && before.gte(0)) {
    const after = await goldTouchBalance(tx, old.output_item_id, touch);
    if (after.lt(0)) {
      throw new AppError(
        "BUSINESS_RULE_VIOLATION",
        `The melted gold from this entry has already been used (only ${toQuantityString(before)} g left at touch ${old.out_touch}). Reverse the later transactions first.`,
      );
    }
  }
}

// ─── Melting entries ─────────────────────────────────────────────────────────

export async function getNextEntryNo(): Promise<{ entryNo: number }> {
  const [row] = await db
    .select({ next: sql<number>`COALESCE(MAX(${meltingEntries.entry_no}), 0) + 1` })
    .from(meltingEntries);
  return { entryNo: Number(row?.next ?? 1) };
}

/** Server-side figures for a create/update — client-sent numbers are ignored. */
async function prepare(tx: Tx, input: CreateMeltingInput) {
  if (input.metal_id) await assertMetalExists(tx, input.metal_id);
  await assertAlloyMetalsExist(tx, input.alloys);
  const computed = input.lines.map(computeLine);
  const meta = await loadItems(tx, [...computed.map((l) => l.item_id), input.output_item_id]);
  const lines = validateItems(computed, input.output_item_id, meta);
  const calc = computeMeltLoss(lines, input.required_touch, input.alloys, input.after_weight);
  return { lines, meta, calc };
}

function entryValues(input: CreateMeltingInput, calc: MeltLossResult) {
  return {
    date: input.date,
    remarks: input.remarks?.trim() || null,
    required_touch: input.required_touch,
    final_weight: calc.final_weight,
    alloy_total: calc.alloy_total,
    after_weight: calc.after_weight,
    output_item_id: input.output_item_id,
    out_touch: calc.out_touch,
    expected_weight: calc.expected_weight,
    loss_weight: calc.loss_weight,
    pure_loss: calc.pure_loss,
  };
}

export async function createMelting(input: CreateMeltingInput) {
  return db.transaction(async (tx) => {
    const { lines, meta, calc } = await prepare(tx, input);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('melting_entry_no'))`);
    const [nextRow] = await tx
      .select({ next: sql<number>`COALESCE(MAX(${meltingEntries.entry_no}), 0) + 1` })
      .from(meltingEntries);
    const entryNo = Number(nextRow?.next ?? 1);

    await assertStockAvailable(tx, lines, meta);
    const values = entryValues(input, calc);
    const groupId = await postMeltingGroup(tx, {
      entryNo,
      date: input.date,
      remarks: values.remarks,
      lines,
      outputItemId: input.output_item_id,
      afterWeight: calc.after_weight,
      outTouch: calc.out_touch,
    });

    const [entry] = await tx
      .insert(meltingEntries)
      .values({
        entry_no: entryNo,
        metal_id: input.metal_id ?? null,
        ...values,
        entry_group_id: groupId,
      })
      .returning({ id: meltingEntries.id, entry_no: meltingEntries.entry_no });

    await insertLines(tx, entry!.id, lines);
    await insertAlloys(tx, entry!.id, calc.alloys);
    return { id: entry!.id, entry_no: entry!.entry_no };
  });
}

export async function updateMelting(input: UpdateMeltingInput) {
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select({
        id: meltingEntries.id,
        entry_no: meltingEntries.entry_no,
        entry_group_id: meltingEntries.entry_group_id,
        output_item_id: meltingEntries.output_item_id,
        out_touch: meltingEntries.out_touch,
      })
      .from(meltingEntries)
      .where(and(eq(meltingEntries.id, input.id), eq(meltingEntries.is_deleted, false)))
      .limit(1)
      .for("update");
    if (!existing) throw new AppError("NOT_FOUND", "Melting entry not found");
    const { lines, meta, calc } = await prepare(tx, input);
    const values = entryValues(input, calc);

    // Old stock movement comes back first, so the new lines can re-take the
    // same lots; a legacy (record-only) entry has nothing to reverse.
    let groupId = "";
    const repost = async () => {
      await assertStockAvailable(tx, lines, meta);
      groupId = await postMeltingGroup(tx, {
        entryNo: existing.entry_no,
        date: input.date,
        remarks: values.remarks,
        lines,
        outputItemId: input.output_item_id,
        afterWeight: calc.after_weight,
        outTouch: calc.out_touch,
      });
    };
    if (existing.entry_group_id) {
      await reverseMeltingGroup(
        tx,
        {
          entry_group_id: existing.entry_group_id,
          output_item_id: existing.output_item_id,
          out_touch: existing.out_touch,
        },
        repost,
      );
    } else {
      await repost();
    }

    await tx
      .update(meltingEntries)
      .set({
        // undefined = leave the legacy metal as is; null = clear it.
        ...(input.metal_id !== undefined ? { metal_id: input.metal_id } : {}),
        ...values,
        entry_group_id: groupId,
        updated_at: new Date(),
      })
      .where(eq(meltingEntries.id, input.id));

    await tx.delete(meltingLines).where(eq(meltingLines.melting_id, input.id));
    await insertLines(tx, input.id, lines);
    await tx.delete(meltingAlloys).where(eq(meltingAlloys.melting_id, input.id));
    await insertAlloys(tx, input.id, calc.alloys);
    return { id: existing.id, entry_no: existing.entry_no };
  });
}

export async function deleteMelting(id: string) {
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select({
        id: meltingEntries.id,
        entry_group_id: meltingEntries.entry_group_id,
        output_item_id: meltingEntries.output_item_id,
        out_touch: meltingEntries.out_touch,
      })
      .from(meltingEntries)
      .where(and(eq(meltingEntries.id, id), eq(meltingEntries.is_deleted, false)))
      .limit(1)
      .for("update");
    if (!existing) throw new AppError("NOT_FOUND", "Melting entry not found");

    if (existing.entry_group_id) {
      await reverseMeltingGroup(tx, {
        entry_group_id: existing.entry_group_id,
        output_item_id: existing.output_item_id,
        out_touch: existing.out_touch,
      });
    }
    await tx
      .update(meltingEntries)
      .set({ is_deleted: true, updated_at: new Date() })
      .where(eq(meltingEntries.id, id));
    return { success: true as const };
  });
}

async function fetchAlloys(meltingIds: string[]) {
  if (meltingIds.length === 0) return [];
  return db
    .select({
      melting_id: meltingAlloys.melting_id,
      metal_id: meltingAlloys.metal_id,
      metal_name: metals.name,
      share_percent: meltingAlloys.share_percent,
      grams: meltingAlloys.grams,
    })
    .from(meltingAlloys)
    .innerJoin(metals, eq(metals.id, meltingAlloys.metal_id))
    .where(inArray(meltingAlloys.melting_id, meltingIds))
    .orderBy(asc(meltingAlloys.melting_id), asc(meltingAlloys.sort_order));
}

export async function listMelting(input: ListMeltingInput) {
  const conds: SQL[] = [eq(meltingEntries.is_deleted, false)];
  if (input.from_date) conds.push(gte(meltingEntries.date, input.from_date));
  if (input.to_date) conds.push(lte(meltingEntries.date, input.to_date));
  if (input.metal_id) {
    // Matches the legacy single metal OR any alloy metal on the entry.
    conds.push(
      or(
        eq(meltingEntries.metal_id, input.metal_id),
        sql`EXISTS (SELECT 1 FROM ${meltingAlloys} WHERE ${meltingAlloys.melting_id} = ${meltingEntries.id} AND ${meltingAlloys.metal_id} = ${input.metal_id})`,
      )!,
    );
  }
  if (input.search) {
    const like = `%${input.search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    conds.push(
      sql`(${meltingEntries.entry_no}::text ILIKE ${like} OR ${meltingEntries.remarks} ILIKE ${like} OR ${metals.name} ILIKE ${like} OR ${items.name} ILIKE ${like} OR EXISTS (SELECT 1 FROM melting_alloys ma JOIN metals am ON am.id = ma.metal_id WHERE ma.melting_id = ${meltingEntries.id} AND am.name ILIKE ${like}))`,
    );
  }
  const where = and(...conds);

  const [countRow] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(meltingEntries)
    .leftJoin(metals, eq(metals.id, meltingEntries.metal_id))
    .leftJoin(items, eq(items.id, meltingEntries.output_item_id))
    .where(where);

  // Per-entry line totals, aggregated once and joined in.
  const totals = db
    .select({
      melting_id: meltingLines.melting_id,
      line_count: sql<number>`count(*)::int`.as("line_count"),
      total_weight: sql<string>`COALESCE(SUM(${meltingLines.weight}), 0)::numeric(20,3)::text`.as("total_weight"),
      total_pure: sql<string>`COALESCE(SUM(${meltingLines.total_pure}), 0)::numeric(20,3)::text`.as("total_pure"),
      total_wastage: sql<string>`COALESCE(SUM(${meltingLines.wastage}), 0)::numeric(20,3)::text`.as("total_wastage"),
      total_qty: sql<number>`COALESCE(SUM(${meltingLines.quantity}), 0)::int`.as("total_qty"),
    })
    .from(meltingLines)
    .groupBy(meltingLines.melting_id)
    .as("totals");

  const rows = await db
    .select({
      id: meltingEntries.id,
      entry_no: meltingEntries.entry_no,
      date: meltingEntries.date,
      metal_id: meltingEntries.metal_id,
      metal_name: metals.name,
      remarks: meltingEntries.remarks,
      required_touch: meltingEntries.required_touch,
      alloy_total: meltingEntries.alloy_total,
      after_weight: meltingEntries.after_weight,
      loss_weight: meltingEntries.loss_weight,
      pure_loss: meltingEntries.pure_loss,
      output_item_name: items.name,
      line_count: totals.line_count,
      total_weight: totals.total_weight,
      total_pure: totals.total_pure,
      total_wastage: totals.total_wastage,
      total_qty: totals.total_qty,
    })
    .from(meltingEntries)
    .leftJoin(metals, eq(metals.id, meltingEntries.metal_id))
    .leftJoin(items, eq(items.id, meltingEntries.output_item_id))
    .leftJoin(totals, eq(totals.melting_id, meltingEntries.id))
    .where(where)
    .orderBy(desc(meltingEntries.date), desc(meltingEntries.entry_no))
    .limit(input.limit)
    .offset((input.page - 1) * input.limit);

  // One batched query for every alloy on this page (no N+1).
  const alloyRows = await fetchAlloys(rows.map((r) => r.id));
  const summaryById = new Map<string, string[]>();
  for (const a of alloyRows) {
    const parts = summaryById.get(a.melting_id) ?? [];
    parts.push(`${a.metal_name} ${a.grams} g`);
    summaryById.set(a.melting_id, parts);
  }

  return {
    data: rows.map((r) => ({
      ...r,
      alloy_summary: summaryById.get(r.id)?.join(", ") ?? null,
      line_count: Number(r.line_count ?? 0),
      total_weight: r.total_weight ?? "0.000",
      total_pure: r.total_pure ?? "0.000",
      total_wastage: r.total_wastage ?? "0.000",
      total_qty: Number(r.total_qty ?? 0),
    })),
    total: Number(countRow?.total ?? 0),
  };
}

export async function getMeltingById(id: string) {
  const [entry] = await db
    .select({
      id: meltingEntries.id,
      entry_no: meltingEntries.entry_no,
      date: meltingEntries.date,
      metal_id: meltingEntries.metal_id,
      metal_name: metals.name,
      remarks: meltingEntries.remarks,
      required_touch: meltingEntries.required_touch,
      final_weight: meltingEntries.final_weight,
      alloy_total: meltingEntries.alloy_total,
      output_item_id: meltingEntries.output_item_id,
      output_item_name: items.name,
      after_weight: meltingEntries.after_weight,
      out_touch: meltingEntries.out_touch,
      expected_weight: meltingEntries.expected_weight,
      loss_weight: meltingEntries.loss_weight,
      pure_loss: meltingEntries.pure_loss,
    })
    .from(meltingEntries)
    .leftJoin(metals, eq(metals.id, meltingEntries.metal_id))
    .leftJoin(items, eq(items.id, meltingEntries.output_item_id))
    .where(and(eq(meltingEntries.id, id), eq(meltingEntries.is_deleted, false)))
    .limit(1);
  if (!entry) throw new AppError("NOT_FOUND", "Melting entry not found");

  const lines = await db
    .select({
      item_id: meltingLines.item_id,
      item_name: items.name,
      lot_id: meltingLines.lot_id,
      weight: meltingLines.weight,
      touch: meltingLines.touch,
      wastage_percent: meltingLines.wastage_percent,
      pure: meltingLines.pure,
      wastage: meltingLines.wastage,
      total_pure: meltingLines.total_pure,
      quantity: meltingLines.quantity,
    })
    .from(meltingLines)
    .leftJoin(items, eq(items.id, meltingLines.item_id))
    .where(eq(meltingLines.melting_id, id))
    .orderBy(asc(meltingLines.sort_order));

  const alloys = await fetchAlloys([id]);
  const current = computeAlloy(lines, null, []);

  return {
    ...entry,
    current_weight: current.current_weight,
    current_pure: current.current_pure,
    current_touch: current.current_touch,
    alloys: alloys.map((a) => ({
      metal_id: a.metal_id,
      metal_name: a.metal_name,
      share_percent: a.share_percent,
      grams: a.grams,
    })),
    lines: lines.map((l) => ({
      ...l,
      quantity: l.quantity === null ? null : String(l.quantity),
    })),
  };
}

// ─── Totals (Stock page) ─────────────────────────────────────────────────────
// Over non-deleted melting entries that posted stock (entry_group_id set), by
// melting date. in = lots taken out of stock; out = melted gold put back;
// melted_out_pure = in_pure − pure_loss (exactly the stored per-entry figures).

export async function getMeltingTotals(input: { from_date: string; to_date: string }) {
  const [row] = await db.execute<{
    in_weight: string | null;
    in_pure: string | null;
    out_weight: string | null;
    loss_weight: string | null;
    pure_loss: string | null;
  }>(sql`
    SELECT
      COALESCE(SUM(t.w), 0)::text AS in_weight,
      COALESCE(SUM(t.p), 0)::text AS in_pure,
      COALESCE(SUM(me.after_weight), 0)::text AS out_weight,
      COALESCE(SUM(me.loss_weight), 0)::text AS loss_weight,
      COALESCE(SUM(me.pure_loss), 0)::text AS pure_loss
    FROM melting_entries me
    LEFT JOIN (
      SELECT melting_id, SUM(weight) AS w, SUM(COALESCE(pure, 0)) AS p
      FROM melting_lines GROUP BY melting_id
    ) t ON t.melting_id = me.id
    WHERE me.is_deleted = false
      AND me.entry_group_id IS NOT NULL
      AND me.date >= ${input.from_date}
      AND me.date <= ${input.to_date}
  `);

  const inPure = toDecimal(row?.in_pure ?? "0");
  const pureLoss = toDecimal(row?.pure_loss ?? "0");
  return {
    melted_in_weight: toQuantityString(toDecimal(row?.in_weight ?? "0")),
    melted_in_pure: toQuantityString(inPure),
    melted_out_weight: toQuantityString(toDecimal(row?.out_weight ?? "0")),
    melted_out_pure: toQuantityString(inPure.minus(pureLoss)),
    loss_weight: toQuantityString(toDecimal(row?.loss_weight ?? "0")),
    pure_loss: toQuantityString(pureLoss),
  };
}
