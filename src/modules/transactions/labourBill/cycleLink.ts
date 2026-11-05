// ─── Customer cycle ↔ Issue Job Works link ───────────────────────────────────
// Owner (2026-11-05): a Labour Bill cycle (labour_bill_cycles) is the customer's
// order. The gold the customer hands in on the cycle's Labour Bills (Gold Receipt)
// is issued to employees on Issue Job Works linked to the cycle
// (entry_groups.order_cycle_id); the finished ornaments the employees hand back
// (Job Work Ornament Receipt) are then issued to the customer on the cycle's
// Labour Bills (Ornament Issue). A cycle can be marked Delivered (closed to new
// bills / links) and reopened.
//
// Ported from Gold CRM's Order Voucher (src/modules/transactions/orderVoucher/
// service.ts: buildIssuableGold, getFinishedOrnaments, setVoucherDelivered,
// balances), adapted to GST CRM's tables. Wages are not part of GST CRM.
//
// Customer side and employee side are kept apart — never summed together.

import { AppError } from "@/types/errors";
import { db } from "@/db";
import { accounts, entries as entriesTable, entryGroups, items as itemsTable, labourBillCycles } from "@/db/schema";
import { SYSTEM_ACCOUNTS } from "@/config/constants";
import { toDecimal } from "@/lib/decimal";
import { and, asc, desc, eq, inArray, isNotNull, ne, or, sql } from "drizzle-orm";
import type Decimal from "decimal.js";
import type { FinishedOrnamentsInput, SetCycleStatusInput } from "./schema";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type DbOrTx = typeof db | Tx;

export type CycleStatus = "OPEN" | "DELIVERED";

// ─── Reads ───────────────────────────────────────────────────────────────────

const cycleColumns = {
  id: labourBillCycles.id,
  bill_no: labourBillCycles.bill_no,
  account_id: labourBillCycles.account_id,
  customer_name: accounts.name,
  required_touch: labourBillCycles.required_touch,
  status: labourBillCycles.status,
  main_reason: labourBillCycles.main_reason,
  delivered_at: labourBillCycles.delivered_at,
  created_at: labourBillCycles.created_at,
};

export type CycleRef = {
  id: string;
  bill_no: number;
  account_id: string;
  customer_name: string | null;
  required_touch: string | null;
  status: CycleStatus;
  main_reason: string | null;
  delivered_at: Date | null;
  created_at: Date;
};

/** A customer cycle with its customer's name, or NOT_FOUND. */
export async function getCycleRef(cycleId: string, conn: DbOrTx = db): Promise<CycleRef> {
  const [row] = await conn
    .select(cycleColumns)
    .from(labourBillCycles)
    .leftJoin(accounts, eq(labourBillCycles.account_id, accounts.id))
    .where(eq(labourBillCycles.id, cycleId))
    .limit(1);
  if (!row) throw new AppError("NOT_FOUND", "Bill cycle not found.", "cycle_id");
  return row;
}

/** Cycles by id (missing ids are simply absent from the map). */
export async function getCycleRefs(ids: (string | null | undefined)[]): Promise<Map<string, CycleRef>> {
  const unique = [...new Set(ids.filter((v): v is string => !!v))];
  if (unique.length === 0) return new Map();
  const rows = await db
    .select(cycleColumns)
    .from(labourBillCycles)
    .leftJoin(accounts, eq(labourBillCycles.account_id, accounts.id))
    .where(inArray(labourBillCycles.id, unique));
  return new Map(rows.map((r) => [r.id, r]));
}

/**
 * Issue Job Works cycle picker: OPEN customer cycles of ALL customers (an
 * employee may work on any customer's order), newest first. include_cycle_id is
 * listed too even when DELIVERED — the job work being edited is linked to it.
 */
export async function listOpenCycles(input: { include_cycle_id?: string | null }) {
  const rows = await db
    .select({
      id: labourBillCycles.id,
      bill_no: labourBillCycles.bill_no,
      account_id: labourBillCycles.account_id,
      customer_name: accounts.name,
      required_touch: labourBillCycles.required_touch,
      status: labourBillCycles.status,
      main_reason: labourBillCycles.main_reason,
      created_at: labourBillCycles.created_at,
    })
    .from(labourBillCycles)
    .leftJoin(accounts, eq(labourBillCycles.account_id, accounts.id))
    .where(
      input.include_cycle_id
        ? or(eq(labourBillCycles.status, "OPEN"), eq(labourBillCycles.id, input.include_cycle_id))
        : eq(labourBillCycles.status, "OPEN"),
    )
    .orderBy(desc(labourBillCycles.created_at), desc(labourBillCycles.bill_no));
  return rows;
}

// ─── Status (Delivered / reopen) ─────────────────────────────────────────────

/** Delivered closes the cycle to new bills / job-work links; OPEN reopens it. */
export async function setCycleStatus(input: SetCycleStatusInput) {
  return db.transaction(async (tx) => {
    const locked = await tx.execute<{ id: string; delivered_at: string | null }>(
      sql`SELECT id, delivered_at FROM ${labourBillCycles} WHERE id = ${input.cycle_id} FOR UPDATE`,
    );
    const existing = locked[0];
    if (!existing) throw new AppError("NOT_FOUND", "Bill cycle not found.", "cycle_id");
    // Re-marking an already-delivered cycle keeps its original delivered_at.
    const deliveredAt =
      input.status === "DELIVERED" ? (existing.delivered_at ? new Date(existing.delivered_at) : new Date()) : null;
    const [row] = await tx
      .update(labourBillCycles)
      .set({ status: input.status, delivered_at: deliveredAt, updated_at: new Date() })
      .where(eq(labourBillCycles.id, input.cycle_id))
      .returning();
    return row!;
  });
}

/**
 * A DELIVERED cycle takes no new bills / links — waived when it is the cycle the
 * edited bill already has (`keepingCycleId`), so an edit never strands a bill.
 */
export function assertCycleTakesBills(
  cycle: { id: string; bill_no: number; status: string },
  keepingCycleId: string | null | undefined,
  what: "labour bill" | "job work",
  field: string,
) {
  if (cycle.status === "DELIVERED" && cycle.id !== keepingCycleId) {
    throw new AppError(
      "BUSINESS_RULE_VIOLATION",
      what === "labour bill"
        ? `Bill cycle ${cycle.bill_no} is closed — reopen it to add a new labour bill.`
        : `Customer cycle ${cycle.bill_no} is closed — reopen it to link a job work to it.`,
      field,
    );
  }
}

/**
 * Labour Bill save transaction: row-locks the bill's cycle and re-checks it
 * still takes the bill (a concurrent close between the pre-check and the save
 * cannot slip a new bill onto a closed cycle). Returns the cycle's state BEFORE
 * the bill form's "Close cycle" tick is applied.
 */
export async function lockCycleForBill(tx: Tx, cycleId: string, keepingCycleId: string | null | undefined) {
  const [cycle] = await tx
    .select({ id: labourBillCycles.id, bill_no: labourBillCycles.bill_no, status: labourBillCycles.status })
    .from(labourBillCycles)
    .where(eq(labourBillCycles.id, cycleId))
    .for("update");
  if (!cycle) throw new AppError("NOT_FOUND", "Selected bill cycle does not exist.", "bill_cycle_id");
  assertCycleTakesBills(cycle, keepingCycleId, "labour bill", "bill_cycle_id");
  return cycle;
}

/**
 * Labour Bill form's "Close cycle — order complete" tick (Gold CRM's
 * voucher_delivered): true closes the cycle (DELIVERED, delivered_at = now),
 * false reopens it (OPEN, delivered_at = null). Only written when it differs
 * from the cycle's current state; undefined leaves the cycle alone.
 */
export async function applyCycleCloseFlag(
  tx: Tx,
  cycle: { id: string; status: string },
  closeCycle: boolean | undefined,
) {
  if (closeCycle === undefined) return;
  const target: CycleStatus = closeCycle ? "DELIVERED" : "OPEN";
  if (cycle.status === target) return;
  await tx
    .update(labourBillCycles)
    .set({ status: target, delivered_at: closeCycle ? new Date() : null, updated_at: new Date() })
    .where(eq(labourBillCycles.id, cycle.id));
}

/**
 * Job work → customer cycle link check (create and update). Returns the cycle id
 * to store, or null. The cycle must exist; it must be OPEN unless it is the cycle
 * the edited job work is already linked to.
 */
export async function resolveOrderCycleForJobWork(
  orderCycleId: string | null | undefined,
  existingOrderCycleId?: string | null,
): Promise<string | null> {
  if (!orderCycleId) return null;
  const [cycle] = await db
    .select({ id: labourBillCycles.id, bill_no: labourBillCycles.bill_no, status: labourBillCycles.status })
    .from(labourBillCycles)
    .where(eq(labourBillCycles.id, orderCycleId))
    .limit(1);
  if (!cycle) throw new AppError("NOT_FOUND", "Selected customer cycle does not exist.", "order_cycle_id");
  assertCycleTakesBills(cycle, existingOrderCycleId, "job work", "order_cycle_id");
  return cycle.id;
}

// ─── Cycle groups (Labour Bills on it, Job Works linked to it) ───────────────

type GroupEntry = {
  entry: typeof entriesTable.$inferSelect;
  item_name: string | null;
  item_type: "GOLD" | "ORNAMENT" | "MONEY" | null;
};

async function loadEntries(groupIds: string[]) {
  const txEntries = groupIds.length
    ? await db
        .select({ entry: entriesTable, item_name: itemsTable.name, item_type: itemsTable.type })
        .from(entriesTable)
        .leftJoin(itemsTable, eq(entriesTable.item_id, itemsTable.id))
        .where(inArray(entriesTable.group_id, groupIds))
    : [];
  const map = new Map<string, GroupEntry[]>();
  for (const e of txEntries) {
    if (!map.has(e.entry.group_id)) map.set(e.entry.group_id, []);
    map.get(e.entry.group_id)!.push(e);
  }
  return map;
}

/** Live (not soft-deleted) Labour Bills of the cycle, oldest first, with entries. */
export async function loadCycleLabourBills(cycleId: string) {
  const groups = await db
    .select({ group: entryGroups })
    .from(entryGroups)
    .where(
      and(
        eq(entryGroups.bill_cycle_id, cycleId),
        eq(entryGroups.type, "LABOUR_BILL"),
        eq(entryGroups.is_deleted, false),
      ),
    )
    .orderBy(asc(entryGroups.created_at));
  const map = await loadEntries(groups.map((g) => g.group.id));
  return groups.map((g) => ({ ...g, entries: map.get(g.group.id) ?? [] }));
}

/** Live Job Works linked to the cycle, oldest first, with the employee's name and entries. */
export async function loadCycleJobWorks(cycleId: string) {
  const groups = await db
    .select({ group: entryGroups, account_name: accounts.name })
    .from(entryGroups)
    .leftJoin(accounts, eq(entryGroups.account_id, accounts.id))
    .where(
      and(
        eq(entryGroups.order_cycle_id, cycleId),
        eq(entryGroups.type, "JOB_WORK"),
        eq(entryGroups.is_deleted, false),
      ),
    )
    .orderBy(asc(entryGroups.created_at));
  const map = await loadEntries(groups.map((g) => g.group.id));
  return groups.map((g) => ({ ...g, entries: map.get(g.group.id) ?? [] }));
}

type SourceGroup = { group: { id: string; account_id: string }; entries: GroupEntry[] };

// Movement kinds (party = the group's own account: the customer on a Labour Bill,
// the employee on a Job Work):
//   Labour Bill  Gold Receipt     GOLD      customer → SHOP
//   Labour Bill  Ornament Issue   ORNAMENT  SHOP → customer
//   Job Work     Gold Issue       GOLD      SHOP → employee
//   Job Work     Ornament Receipt ORNAMENT  employee → SHOP
const isIn = (g: SourceGroup, e: GroupEntry) =>
  e.entry.from_account_id === g.group.account_id && e.entry.to_account_id === SYSTEM_ACCOUNTS.SHOP_ID;
const isOut = (g: SourceGroup, e: GroupEntry) =>
  e.entry.from_account_id === SYSTEM_ACCOUNTS.SHOP_ID && e.entry.to_account_id === g.group.account_id;

const pureOf = (e: GroupEntry) => toDecimal(e.entry.pure_quantity ?? "0");

// ─── Summary (getCycleDetail) ────────────────────────────────────────────────

export function buildCycleSummary(
  labourBills: SourceGroup[],
  jobWorks: (SourceGroup & { account_name: string | null })[],
) {
  let goldReceived = toDecimal(0);
  let ornamentIssued = toDecimal(0);
  for (const g of labourBills) {
    for (const e of g.entries) {
      if (e.item_type === "GOLD" && isIn(g, e)) goldReceived = goldReceived.plus(pureOf(e));
      if (e.item_type === "ORNAMENT" && isOut(g, e)) ornamentIssued = ornamentIssued.plus(pureOf(e));
    }
  }

  const perEmployee = new Map<string, { account_id: string; name: string; gold: Decimal; orn: Decimal }>();
  for (const g of jobWorks) {
    let acc = perEmployee.get(g.group.account_id);
    if (!acc) {
      acc = { account_id: g.group.account_id, name: g.account_name ?? "", gold: toDecimal(0), orn: toDecimal(0) };
      perEmployee.set(g.group.account_id, acc);
    }
    for (const e of g.entries) {
      if (e.item_type === "GOLD" && isOut(g, e)) acc.gold = acc.gold.plus(pureOf(e));
      if (e.item_type === "ORNAMENT" && isIn(g, e)) acc.orn = acc.orn.plus(pureOf(e));
    }
  }

  return {
    customer: {
      gold_received_pure: goldReceived.toFixed(3),
      ornament_issued_pure: ornamentIssued.toFixed(3),
    },
    employees: [...perEmployee.values()]
      .sort((a, b) => a.name.localeCompare(b.name) || a.account_id.localeCompare(b.account_id))
      .map((e) => ({
        account_id: e.account_id,
        name: e.name,
        gold_issued_pure: e.gold.toFixed(3),
        ornament_received_pure: e.orn.toFixed(3),
      })),
  };
}

// ─── Issuable gold (Job Work Gold Issue auto-fill) ───────────────────────────
// Gold the customer handed in on the cycle's Labour Bills (Gold Receipt, GOLD
// customer → SHOP) less the Gold Issue already given out on the Job Works linked
// to the cycle (GOLD SHOP → employee, every employee; exclude_group_id = the job
// work being edited, whose own rows are about to be replaced).
//
// Gold CRM groups by (item, touch to 2 dp). GST CRM's Gold Receipt rows may carry
// a lot, so the key here is (item, lot, touch): each row names the SHOP lot the
// received gold landed in (null = no lot) and can be issued straight from it.
// Issued gold is netted against the receipt with the same (item, lot, touch)
// first; whatever is left over (issued from another lot / without one) is then
// taken from the other lots of the same (item, touch), oldest receipt first.
// Ornament issues are not gold handed in, so they never reduce it. Remaining is
// clamped at 0; rows with nothing left (to 3 dp) are dropped.

export interface IssuableGoldRow {
  item_id: string;
  item_name: string;
  lot_id: string | null;
  /** Touch to 2 dp. */
  purity: string;
  /** Σ received on the cycle's Labour Bills (3 dp). */
  received: string;
  /** Σ issued on the linked Job Works and netted against this row (3 dp). */
  issued: string;
  /** received − issued (3 dp) — the Gold Issue row's quantity. */
  quantity: string;
}

export function buildIssuableGold(
  labourBills: SourceGroup[],
  jobWorks: SourceGroup[],
  excludeGroupId?: string | null,
): IssuableGoldRow[] {
  type Bucket = { item_id: string; item_name: string; lot_id: string | null; purity: string; first: number; received: Decimal; issued: Decimal };
  const buckets = new Map<string, Bucket>();
  const keyOf = (itemId: string, lotId: string | null, purity: string) => `${itemId}|${lotId ?? ""}|${purity}`;
  const touchOf = (e: GroupEntry) => toDecimal(e.entry.purity ?? "0").toFixed(2);

  labourBills.forEach((g, groupIdx) => {
    for (const e of g.entries) {
      if (e.item_type !== "GOLD" || !isIn(g, e)) continue;
      const purity = touchOf(e);
      const lot = e.entry.lot_id ?? null;
      const key = keyOf(e.entry.item_id, lot, purity);
      let b = buckets.get(key);
      if (!b) {
        b = { item_id: e.entry.item_id, item_name: e.item_name ?? "", lot_id: lot, purity, first: groupIdx, received: toDecimal(0), issued: toDecimal(0) };
        buckets.set(key, b);
      }
      b.received = b.received.plus(toDecimal(e.entry.quantity));
    }
  });
  // Row order = the bill that first received it (oldest first), then item name,
  // touch, lot (no lot first). Rows inside one bill have no stored order, so the
  // tie-break keeps the result stable.
  const ordered = [...buckets.values()].sort(
    (a, b) =>
      a.first - b.first ||
      a.item_name.localeCompare(b.item_name) ||
      a.item_id.localeCompare(b.item_id) ||
      Number(a.purity) - Number(b.purity) ||
      (a.lot_id ?? "").localeCompare(b.lot_id ?? ""),
  );

  // Issued per (item, lot, touch).
  const issued = new Map<string, { item_id: string; lot_id: string | null; purity: string; qty: Decimal }>();
  for (const g of jobWorks) {
    if (excludeGroupId && g.group.id === excludeGroupId) continue;
    for (const e of g.entries) {
      if (e.item_type !== "GOLD" || !isOut(g, e)) continue;
      const purity = touchOf(e);
      const lot = e.entry.lot_id ?? null;
      const key = keyOf(e.entry.item_id, lot, purity);
      const acc = issued.get(key) ?? { item_id: e.entry.item_id, lot_id: lot, purity, qty: toDecimal(0) };
      acc.qty = acc.qty.plus(toDecimal(e.entry.quantity));
      issued.set(key, acc);
    }
  }

  const room = (b: Bucket) => {
    const r = b.received.minus(b.issued);
    return r.gt(0) ? r : toDecimal(0);
  };

  // 1. exact (item, lot, touch) match
  const leftovers: { item_id: string; purity: string; qty: Decimal }[] = [];
  for (const [key, iss] of issued) {
    const b = buckets.get(key);
    let left = iss.qty;
    if (b) {
      const take = minDecimal(left, room(b));
      b.issued = b.issued.plus(take);
      left = left.minus(take);
    }
    if (left.gt(0)) leftovers.push({ item_id: iss.item_id, purity: iss.purity, qty: left });
  }
  // 2. spill over into the other lots of the same (item, touch), oldest first
  for (const lo of leftovers) {
    let left = lo.qty;
    for (const b of ordered) {
      if (!left.gt(0)) break;
      if (b.item_id !== lo.item_id || b.purity !== lo.purity) continue;
      const take = minDecimal(left, room(b));
      if (!take.gt(0)) continue;
      b.issued = b.issued.plus(take);
      left = left.minus(take);
    }
  }

  const rows: IssuableGoldRow[] = [];
  for (const b of ordered) {
    const qty = room(b);
    if (!toDecimal(qty.toFixed(3)).gt(0)) continue;
    rows.push({
      item_id: b.item_id,
      item_name: b.item_name,
      lot_id: b.lot_id,
      purity: b.purity,
      received: b.received.toFixed(3),
      issued: b.issued.toFixed(3),
      quantity: qty.toFixed(3),
    });
  }
  return rows;
}

function minDecimal(a: Decimal, b: Decimal): Decimal {
  return a.lt(b) ? a : b;
}

export async function getIssuableGold(input: { cycle_id: string; exclude_group_id?: string | null }) {
  const cycle = await getCycleRef(input.cycle_id);
  const [labourBills, jobWorks] = await Promise.all([
    loadCycleLabourBills(input.cycle_id),
    loadCycleJobWorks(input.cycle_id),
  ]);
  return {
    cycle_id: cycle.id,
    bill_no: cycle.bill_no,
    customer_name: cycle.customer_name,
    required_touch: cycle.required_touch,
    rows: buildIssuableGold(labourBills, jobWorks, input.exclude_group_id),
  };
}

// ─── Finished ornaments (Labour Bill Ornament Issue picker) ──────────────────
// Every Ornament Receipt row (ORNAMENT employee → SHOP) of the live Job Works
// linked to the cycle. already_issued = the same (item, lot) — Gold CRM's match:
// a lot is one physical piece — already appears in an Ornament Issue row (SHOP →
// customer) of a live Labour Bill of this cycle, leaving out exclude_group_id
// (the bill being edited). Rows without a lot can't be matched (never "issued").
// If two receipts ever share one (item, lot), it is listed once (the first).

export async function getFinishedOrnaments(input: FinishedOrnamentsInput) {
  const cycle = await getCycleRef(input.cycle_id);

  const receipts = await db
    .select({
      entry_id: entriesTable.id,
      group_id: entryGroups.id,
      job_work_bill_no: entryGroups.bill_no,
      date: entryGroups.date,
      employee_id: entryGroups.account_id,
      employee_name: accounts.name,
      item_id: entriesTable.item_id,
      item_name: itemsTable.name,
      lot_id: entriesTable.lot_id,
      quantity: entriesTable.quantity,
      purity: entriesTable.purity,
      wastage_value: entriesTable.wastage_value,
    })
    .from(entriesTable)
    .innerJoin(entryGroups, eq(entriesTable.group_id, entryGroups.id))
    .innerJoin(itemsTable, eq(entriesTable.item_id, itemsTable.id))
    .leftJoin(accounts, eq(entryGroups.account_id, accounts.id))
    .where(
      and(
        eq(entryGroups.order_cycle_id, input.cycle_id),
        eq(entryGroups.type, "JOB_WORK"),
        // An edited / deleted job work's old version is soft-deleted (and
        // reversed), so only the live version lists — no duplicates.
        eq(entryGroups.is_deleted, false),
        eq(itemsTable.type, "ORNAMENT"),
        eq(entriesTable.to_account_id, SYSTEM_ACCOUNTS.SHOP_ID),
        sql`${entriesTable.from_account_id} = ${entryGroups.account_id}`,
      ),
    )
    // One job work's rows share created_at; their lots were numbered in row
    // order, so length-then-text keeps the typed order.
    .orderBy(
      asc(entryGroups.date),
      asc(entryGroups.created_at),
      sql`length(${entriesTable.lot_id})`,
      asc(entriesTable.lot_id),
      asc(entriesTable.id),
    );

  const issuedRows = await db
    .select({ item_id: entriesTable.item_id, lot_id: entriesTable.lot_id })
    .from(entriesTable)
    .innerJoin(entryGroups, eq(entriesTable.group_id, entryGroups.id))
    .innerJoin(itemsTable, eq(entriesTable.item_id, itemsTable.id))
    .where(
      and(
        eq(entryGroups.bill_cycle_id, input.cycle_id),
        eq(entryGroups.type, "LABOUR_BILL"),
        eq(entryGroups.is_deleted, false),
        input.exclude_group_id ? ne(entryGroups.id, input.exclude_group_id) : undefined,
        eq(itemsTable.type, "ORNAMENT"),
        eq(entriesTable.from_account_id, SYSTEM_ACCOUNTS.SHOP_ID),
        sql`${entriesTable.to_account_id} = ${entryGroups.account_id}`,
        isNotNull(entriesTable.lot_id),
      ),
    );
  const issued = new Set(issuedRows.map((r) => `${r.item_id}|${r.lot_id}`));

  const seen = new Set<string>();
  const ornaments = [];
  for (const r of receipts) {
    const key = `${r.item_id}|${r.lot_id}`;
    if (r.lot_id) {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    ornaments.push({
      entry_id: r.entry_id,
      group_id: r.group_id,
      job_work_bill_no: r.job_work_bill_no,
      date: r.date,
      employee_id: r.employee_id,
      employee_name: r.employee_name,
      item_id: r.item_id,
      item_name: r.item_name,
      lot_id: r.lot_id,
      quantity: toDecimal(r.quantity).toFixed(3),
      purity: toDecimal(r.purity ?? "0").toString(),
      wastage_percent: toDecimal(r.wastage_value ?? "0").toString(),
      already_issued: !!r.lot_id && issued.has(key),
    });
  }

  return {
    cycle_id: cycle.id,
    bill_no: cycle.bill_no,
    customer_id: cycle.account_id,
    customer_name: cycle.customer_name,
    required_touch: cycle.required_touch,
    ornaments,
  };
}
