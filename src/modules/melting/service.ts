import { and, asc, desc, eq, gte, inArray, lte, ne, or, sql, type SQL } from "drizzle-orm";
import { db, type Database } from "@/db";
import { meltingAlloys, meltingEntries, meltingLines, metals } from "@/db/schema";
import { toDecimal, toQuantityString } from "@/lib/decimal";
import { AppError } from "@/types/errors";
import { computeAlloy } from "./alloy";
import type {
  CreateMeltingInput,
  CreateMetalInput,
  ListMeltingInput,
  MeltingAlloyInput,
  MeltingLineInput,
  UpdateMeltingInput,
  UpdateMetalInput,
} from "./schema";

export { computeAlloy } from "./alloy";

// Melting register — RECORD ONLY. Nothing here touches entry_groups/entries,
// stock or any balance; these tables are a standalone log.

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
// Touch not entered → pure / wastage / total_pure are stored as null.

function computeLine(line: MeltingLineInput) {
  const weight = toDecimal(line.weight);
  const touch = line.touch !== null ? toDecimal(line.touch) : null;
  const wPct = line.wastage_percent !== null ? toDecimal(line.wastage_percent) : null;

  let pure: string | null = null;
  let wastage: string | null = null;
  let totalPure: string | null = null;

  if (touch !== null) {
    pure = toQuantityString(weight.mul(touch).div(100));
    const rawWastage =
      wPct !== null && wPct.gt(0) && touch.gt(0) ? weight.mul(wPct).div(touch) : toDecimal(0);
    wastage = wPct !== null ? toQuantityString(rawWastage) : null;
    totalPure = toQuantityString(weight.plus(rawWastage).mul(touch).div(100));
  }

  return {
    weight: toQuantityString(weight),
    touch: line.touch,
    wastage_percent: line.wastage_percent,
    pure,
    wastage,
    total_pure: totalPure,
    quantity: line.quantity,
  };
}

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

async function insertLines(tx: Tx, meltingId: string, lines: MeltingLineInput[]) {
  await tx.insert(meltingLines).values(
    lines.map((l, i) => ({ melting_id: meltingId, sort_order: i, ...computeLine(l) })),
  );
}

// Server-side alloy figures — client-sent numbers are ignored.
function alloyFigures(input: CreateMeltingInput) {
  return computeAlloy(input.lines, input.required_touch, input.alloys);
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

// ─── Melting entries ─────────────────────────────────────────────────────────

export async function getNextEntryNo(): Promise<{ entryNo: number }> {
  const [row] = await db
    .select({ next: sql<number>`COALESCE(MAX(${meltingEntries.entry_no}), 0) + 1` })
    .from(meltingEntries);
  return { entryNo: Number(row?.next ?? 1) };
}

export async function createMelting(input: CreateMeltingInput) {
  return db.transaction(async (tx) => {
    if (input.metal_id) await assertMetalExists(tx, input.metal_id);
    await assertAlloyMetalsExist(tx, input.alloys);
    const calc = alloyFigures(input);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('melting_entry_no'))`);
    const [nextRow] = await tx
      .select({ next: sql<number>`COALESCE(MAX(${meltingEntries.entry_no}), 0) + 1` })
      .from(meltingEntries);
    const entryNo = Number(nextRow?.next ?? 1);

    const [entry] = await tx
      .insert(meltingEntries)
      .values({
        entry_no: entryNo,
        date: input.date,
        metal_id: input.metal_id ?? null,
        remarks: input.remarks?.trim() || null,
        required_touch: input.required_touch,
        final_weight: calc.final_weight,
        alloy_total: calc.alloy_total,
      })
      .returning({ id: meltingEntries.id, entry_no: meltingEntries.entry_no });

    await insertLines(tx, entry!.id, input.lines);
    await insertAlloys(tx, entry!.id, calc.alloys);
    return { id: entry!.id, entry_no: entry!.entry_no };
  });
}

export async function updateMelting(input: UpdateMeltingInput) {
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: meltingEntries.id, entry_no: meltingEntries.entry_no })
      .from(meltingEntries)
      .where(and(eq(meltingEntries.id, input.id), eq(meltingEntries.is_deleted, false)))
      .limit(1)
      .for("update");
    if (!existing) throw new AppError("NOT_FOUND", "Melting entry not found");
    if (input.metal_id) await assertMetalExists(tx, input.metal_id);
    await assertAlloyMetalsExist(tx, input.alloys);
    const calc = alloyFigures(input);

    await tx
      .update(meltingEntries)
      .set({
        date: input.date,
        // undefined = leave the legacy metal as is; null = clear it.
        ...(input.metal_id !== undefined ? { metal_id: input.metal_id } : {}),
        remarks: input.remarks?.trim() || null,
        required_touch: input.required_touch,
        final_weight: calc.final_weight,
        alloy_total: calc.alloy_total,
        updated_at: new Date(),
      })
      .where(eq(meltingEntries.id, input.id));

    await tx.delete(meltingLines).where(eq(meltingLines.melting_id, input.id));
    await insertLines(tx, input.id, input.lines);
    await tx.delete(meltingAlloys).where(eq(meltingAlloys.melting_id, input.id));
    await insertAlloys(tx, input.id, calc.alloys);
    return { id: existing.id, entry_no: existing.entry_no };
  });
}

export async function deleteMelting(id: string) {
  const [row] = await db
    .update(meltingEntries)
    .set({ is_deleted: true, updated_at: new Date() })
    .where(and(eq(meltingEntries.id, id), eq(meltingEntries.is_deleted, false)))
    .returning({ id: meltingEntries.id });
  if (!row) throw new AppError("NOT_FOUND", "Melting entry not found");
  return { success: true as const };
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
      sql`(${meltingEntries.entry_no}::text ILIKE ${like} OR ${meltingEntries.remarks} ILIKE ${like} OR ${metals.name} ILIKE ${like} OR EXISTS (SELECT 1 FROM melting_alloys ma JOIN metals am ON am.id = ma.metal_id WHERE ma.melting_id = ${meltingEntries.id} AND am.name ILIKE ${like}))`,
    );
  }
  const where = and(...conds);

  const [countRow] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(meltingEntries)
    .leftJoin(metals, eq(metals.id, meltingEntries.metal_id))
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
      line_count: totals.line_count,
      total_weight: totals.total_weight,
      total_pure: totals.total_pure,
      total_wastage: totals.total_wastage,
      total_qty: totals.total_qty,
    })
    .from(meltingEntries)
    .leftJoin(metals, eq(metals.id, meltingEntries.metal_id))
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
    })
    .from(meltingEntries)
    .leftJoin(metals, eq(metals.id, meltingEntries.metal_id))
    .where(and(eq(meltingEntries.id, id), eq(meltingEntries.is_deleted, false)))
    .limit(1);
  if (!entry) throw new AppError("NOT_FOUND", "Melting entry not found");

  const lines = await db
    .select({
      weight: meltingLines.weight,
      touch: meltingLines.touch,
      wastage_percent: meltingLines.wastage_percent,
      pure: meltingLines.pure,
      wastage: meltingLines.wastage,
      total_pure: meltingLines.total_pure,
      quantity: meltingLines.quantity,
    })
    .from(meltingLines)
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
