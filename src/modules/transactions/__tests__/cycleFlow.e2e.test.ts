/**
 * End-to-end test: the customer cycle shop flow (migration 0026), one cycle
 * walked from order to delivery, asserting at every step.
 *
 *   customer cycle (Required Touch) → Labour Bill Gold Receipt (customer → shop)
 *   → Issue Job Works linked to the cycle (Gold Issue from the issuable rows)
 *   → edit a job work → Job Work Ornament Receipt (employee → shop)
 *   → Labour Bill Ornament Issue (shop → customer) → getCycleDetail summary
 *   → Delivered (closed to new bills / links, edits allowed) → reopen.
 *
 * Runs against a real Postgres. Point DATABASE_URL at a throwaway test database
 * before running — the guard below refuses anything that isn't a *_test DB.
 *
 *   DATABASE_URL='postgresql://.../goldcrm_fullcycle_test?...' \
 *     bun test --timeout 60000 src/modules/transactions/__tests__/cycleFlow.e2e.test.ts
 *
 * The steps share state and run in order. Everything is created under uniquely
 * named accounts / items and hard-deleted again in afterAll.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";

const DB_URL = process.env.DATABASE_URL ?? "";
if (!/\/[^/?]*_test(\?|$)/.test(DB_URL)) {
  throw new Error(
    `Refusing to run: DATABASE_URL does not point at a *_test database (got db "${
      DB_URL.split("/").pop()?.split("?")[0]
    }")`,
  );
}

// Loaded lazily so the guard above runs before any DB module is imported.
let db: typeof import("@/db").db;
let schema: typeof import("@/db/schema");
let lb: typeof import("../labourBill/service");
let jw: typeof import("../jobWork/service");
let link: typeof import("../labourBill/cycleLink");
let entryNo: typeof import("@/lib/entryNoGenerator");
let orm: typeof import("drizzle-orm");

const RUN = `CYFLOW-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
const TODAY = new Date().toISOString().split("T")[0]!;
const RATE = "6000";
const TOUCH = "91.6";
const LOT = `CF${Math.random().toString(36).slice(2, 10)}`; // lot the customer's gold lands in

// ─── shared state (steps run in order) ────────────────────────────────────────
let goldItemId: string;
let ornamentItemId: string;
let customerId: string;
let customerName: string;
let employeeId: string;
let employeeName: string;
let jwCycleId: string;
let cycle: Awaited<ReturnType<typeof import("../labourBill/service").createCycle>>;
let receiptBillId: string; // Labour Bill — Gold Receipt 50 g
let jw1Id: string; // Job Work — Gold Issue 30 g (edited → 25 g, id changes)
let jw1OrigId: string;
let jw2Id: string; // Job Work — Gold Issue 20 g
let jw3Id: string; // Job Work — Ornament Receipt (2 ornaments)
let ornLotA: string;
let ornLotB: string;
let issueBillId: string; // Labour Bill — Ornament Issue of ornament A

const accountIds: string[] = [];
const itemIds: string[] = [];

// ─── helpers ──────────────────────────────────────────────────────────────────

type Caught = { code: string | null; message: string } | null;

// bun 1.3.14's `expect(promise).rejects` hangs on DB-backed rejections.
async function errorOf(p: PromiseLike<unknown>): Promise<Caught> {
  try {
    await p;
    return null;
  } catch (e) {
    const cause = (e as { cause?: unknown }).cause;
    const msg = e instanceof Error ? e.message : String(e);
    return {
      code: (e as { code?: string }).code ?? null,
      message: cause instanceof Error ? `${msg}\n${cause.message}` : msg,
    };
  }
}

async function newItem(type: "GOLD" | "ORNAMENT", label: string): Promise<string> {
  const id = await db.transaction(async (tx) => {
    const no = await entryNo.generateEntryNo(tx as any, "items", type);
    const [item] = await tx
      .insert(schema.items)
      .values({ entry_no: no, name: `${RUN} ${label}`, type, unit: "GRAM", touch: TOUCH })
      .returning();
    return item!.id;
  });
  itemIds.push(id);
  return id;
}

async function newAccount(kind: "customer" | "employee"): Promise<{ id: string; name: string }> {
  const name = `${RUN} ${kind}`;
  const id = await db.transaction(async (tx) => {
    const type = kind === "customer" ? "CUSTOMER" : "GOLDSMITH";
    const no = await entryNo.generateEntryNo(tx as any, "accounts", type);
    const [acc] = await tx
      .insert(schema.accounts)
      .values({
        entry_no: no,
        name,
        type,
        // MC customer (Labour Bill customer)
        customer_type: kind === "customer" ? "LABOUR_BILL" : null,
      })
      .returning();
    return acc!.id;
  });
  accountIds.push(id);
  return { id, name };
}

type Gold = { item_id: string; quantity: string; purity: string; lot_id?: string };
type Orn = { item_id: string; quantity: string; purity: string; wastage_percent: string; lot_id?: string };

function labourBillInput(rows: { gold_receipt?: Gold[]; ornament_issue?: Orn[] }) {
  return {
    account_id: customerId,
    bill_cycle_id: cycle.id,
    date: TODAY,
    rate_per_gram: RATE,
    remarks: RUN,
    gold_issue: [],
    gold_receipt: rows.gold_receipt ?? [],
    ornament_issue: rows.ornament_issue ?? [],
    ornament_receipt: [],
    cash_conversions: [],
  };
}

function jobWorkInput(
  orderCycleId: string | null | undefined,
  rows: { gold_issue?: Gold[]; ornament_receipt?: Orn[] },
) {
  return {
    account_id: employeeId,
    bill_cycle_id: jwCycleId,
    ...(orderCycleId === undefined ? {} : { order_cycle_id: orderCycleId }),
    date: TODAY,
    rate_per_gram: RATE,
    remarks: RUN,
    gold_issue: rows.gold_issue ?? [],
    gold_receipt: [],
    ornament_issue: [],
    ornament_receipt: rows.ornament_receipt ?? [],
    cash_conversions: [],
  };
}

async function issuable(excludeGroupId?: string) {
  const res = await link.getIssuableGold({ cycle_id: cycle.id, exclude_group_id: excludeGroupId ?? null });
  return res;
}

async function groupRow(id: string) {
  const [g] = await db.select().from(schema.entryGroups).where(orm.eq(schema.entryGroups.id, id)).limit(1);
  return g!;
}

// ─── setup / teardown ─────────────────────────────────────────────────────────

beforeAll(async () => {
  ({ db } = await import("@/db"));
  schema = await import("@/db/schema");
  lb = await import("../labourBill/service");
  jw = await import("../jobWork/service");
  link = await import("../labourBill/cycleLink");
  entryNo = await import("@/lib/entryNoGenerator");
  orm = await import("drizzle-orm");
});

afterAll(async () => {
  // Hard-delete everything this run created (entries → groups → cycles → accounts / items).
  try {
    if (accountIds.length || itemIds.length) {
      await db.transaction(async (tx) => {
        const { inArray, or, sql } = orm;
        const { entries, entryGroups, labourBillCycles, jobWorkCycles, accounts, items } = schema;
        const accCond = accountIds.length ? inArray(entryGroups.account_id, accountIds) : sql`false`;
        const groupIds = (
          await tx.select({ id: entryGroups.id }).from(entryGroups).where(accCond)
        ).map((g) => g.id);
        const entryConds = [
          groupIds.length ? inArray(entries.group_id, groupIds) : undefined,
          accountIds.length ? inArray(entries.from_account_id, accountIds) : undefined,
          accountIds.length ? inArray(entries.to_account_id, accountIds) : undefined,
          itemIds.length ? inArray(entries.item_id, itemIds) : undefined,
        ].filter((c): c is NonNullable<typeof c> => !!c);
        // Groups reached only through entries (none expected, but be thorough)
        const viaEntries = (
          await tx.selectDistinct({ id: entries.group_id }).from(entries).where(or(...entryConds))
        ).map((r) => r.id);
        const allGroups = [...new Set([...groupIds, ...viaEntries])];
        if (allGroups.length) await tx.delete(entries).where(inArray(entries.group_id, allGroups));
        await tx.delete(entries).where(or(...entryConds));
        if (allGroups.length) await tx.delete(entryGroups).where(inArray(entryGroups.id, allGroups));
        if (accountIds.length) {
          await tx.delete(labourBillCycles).where(inArray(labourBillCycles.account_id, accountIds));
          await tx.delete(jobWorkCycles).where(inArray(jobWorkCycles.account_id, accountIds));
          await tx.delete(accounts).where(inArray(accounts.id, accountIds));
        }
        if (itemIds.length) await tx.delete(items).where(inArray(items.id, itemIds));
      });
      // Verify nothing is left behind
      const left = await db
        .select({ id: schema.accounts.id })
        .from(schema.accounts)
        .where(orm.like(schema.accounts.name, `${RUN}%`));
      if (left.length) console.error(`cleanup: ${left.length} ${RUN} account(s) left behind`);
      else console.log(`cleanup: ${RUN} data removed`);
    }
  } catch (e) {
    console.error("cleanup failed:", e instanceof Error ? e.message : e);
  }
  // The postgres.js pool is NOT closed here: bun runs every test file in one
  // process and shares the @/db module, so ending it would break later files.
});

// ─── the flow ─────────────────────────────────────────────────────────────────

describe("customer cycle — end-to-end shop flow", () => {
  it("1. masters: MC customer, employee goldsmith (with its job-work cycle), gold + ornament items", async () => {
    ({ id: customerId, name: customerName } = await newAccount("customer"));
    ({ id: employeeId, name: employeeName } = await newAccount("employee"));
    goldItemId = await newItem("GOLD", "Gold");
    ornamentItemId = await newItem("ORNAMENT", "Ring");

    const jwCycle = await jw.createCycle({ account_id: employeeId, main_reason: RUN });
    jwCycleId = jwCycle.id;
    expect(jwCycle.account_id).toBe(employeeId);
    expect(jwCycle.bill_no).toBe(1);
  });

  it("2. createCycle: touch required and in (0, 100]; valid → Cycle 1, OPEN, touch stored", async () => {
    const missing = await errorOf(lb.createCycle({ account_id: customerId, main_reason: RUN } as any));
    expect(missing).not.toBeNull();
    expect(missing!.message).toContain("Required touch");
    for (const bad of ["0", "101"]) {
      const err = await errorOf(lb.createCycle({ account_id: customerId, main_reason: RUN, required_touch: bad }));
      expect(err).not.toBeNull();
      expect(err!.message).toContain("Required touch");
    }
    // Nothing was created by the refused calls
    expect((await lb.listCycles({ account_id: customerId })).length).toBe(0);

    cycle = await lb.createCycle({ account_id: customerId, main_reason: RUN, required_touch: TOUCH });
    expect(cycle.account_id).toBe(customerId);
    expect(cycle.bill_no).toBe(1);
    expect(cycle.status).toBe("OPEN");
    expect(Number(cycle.required_touch)).toBe(91.6);
    expect(cycle.delivered_at).toBeNull();

    const listed = await lb.listCycles({ account_id: customerId });
    expect(listed.map((c) => c.id)).toEqual([cycle.id]);
    expect(listed[0]!.status).toBe("OPEN");
    expect(Number(listed[0]!.required_touch)).toBe(91.6);
  });

  it("3. Labour Bill Gold Receipt (customer → shop): 50 g @ 91.6 into a lot", async () => {
    const { group, entries } = await lb.createLabourBill(
      labourBillInput({ gold_receipt: [{ item_id: goldItemId, quantity: "50", purity: TOUCH, lot_id: LOT }] }),
    );
    receiptBillId = group.id;
    expect(group.type).toBe("LABOUR_BILL");
    expect(group.bill_cycle_id).toBe(cycle.id);
    expect(group.account_id).toBe(customerId);
    expect(entries.length).toBe(1);
    const e = entries[0]!;
    expect(e.from_account_id).toBe(customerId);
    expect(e.to_account_id).toBe("00000000-0000-0000-0000-000000000001"); // SHOP
    expect(e.lot_id).toBe(LOT);
    expect(Number(e.quantity)).toBe(50);
    expect(Number(e.pure_quantity)).toBe(45.8); // 50 × 0.916
  });

  it("4. listOpenCycles shows the cycle with the customer; issuableGold = the 50 g row", async () => {
    const open = await link.listOpenCycles({});
    const mine = open.find((c) => c.id === cycle.id);
    expect(mine).toBeDefined();
    expect(mine!.customer_name).toBe(customerName);
    expect(mine!.account_id).toBe(customerId);
    expect(mine!.status).toBe("OPEN");
    expect(mine!.bill_no).toBe(1);
    expect(Number(mine!.required_touch)).toBe(91.6);

    const res = await issuable();
    expect(res.cycle_id).toBe(cycle.id);
    expect(res.customer_name).toBe(customerName);
    expect(Number(res.required_touch)).toBe(91.6);
    expect(res.rows).toEqual([
      {
        item_id: goldItemId,
        item_name: `${RUN} Gold`,
        lot_id: LOT,
        purity: "91.60",
        received: "50.000",
        issued: "0.000",
        quantity: "50.000",
      },
    ]);
  });

  it("5. Job Work Gold Issue from the issuable row: 30 g → 20 g left; another 20 g → nothing left", async () => {
    const row = (await issuable()).rows[0]!;
    const { group: j1, entries } = await jw.createJobWork(
      jobWorkInput(cycle.id, {
        gold_issue: [{ item_id: row.item_id, quantity: "30", purity: row.purity, lot_id: row.lot_id ?? undefined }],
      }),
    );
    jw1Id = jw1OrigId = j1.id;
    expect(j1.type).toBe("JOB_WORK");
    expect(j1.account_id).toBe(employeeId);
    expect(j1.job_work_cycle_id).toBe(jwCycleId);
    expect(j1.order_cycle_id).toBe(cycle.id);
    expect(entries[0]!.from_account_id).toBe("00000000-0000-0000-0000-000000000001");
    expect(entries[0]!.to_account_id).toBe(employeeId);
    expect(entries[0]!.lot_id).toBe(LOT);

    let res = await issuable();
    expect(res.rows.map((r) => [r.lot_id, r.purity, r.received, r.issued, r.quantity])).toEqual([
      [LOT, "91.60", "50.000", "30.000", "20.000"],
    ]);

    const { group: j2 } = await jw.createJobWork(
      jobWorkInput(cycle.id, {
        gold_issue: [{ item_id: goldItemId, quantity: res.rows[0]!.quantity, purity: TOUCH, lot_id: LOT }],
      }),
    );
    jw2Id = j2.id;
    expect(j2.order_cycle_id).toBe(cycle.id);
    expect(j2.bill_no).toBe(j1.bill_no); // same job-work bill cycle

    res = await issuable();
    expect(res.rows).toEqual([]); // fully issued — never shows a negative row
  });

  it("6. edit the first job work 30 → 25 g without order_cycle_id: link kept, 5 g issuable; exclude_group_id frees its 25 g", async () => {
    const { group: j1b } = await jw.updateJobWork({
      ...jobWorkInput(undefined, { gold_issue: [{ item_id: goldItemId, quantity: "25", purity: TOUCH, lot_id: LOT }] }),
      id: jw1Id,
    });
    expect(j1b.id).not.toBe(jw1OrigId);
    expect(j1b.order_cycle_id).toBe(cycle.id);
    expect(j1b.bill_no).toBe((await groupRow(jw1OrigId)).bill_no);
    expect((await groupRow(jw1OrigId)).is_deleted).toBe(true);
    jw1Id = j1b.id;

    const byId = await jw.getJobWorkById({ id: jw1Id });
    expect(byId.group.order_cycle_id).toBe(cycle.id);
    expect(byId.order_cycle_customer_name).toBe(customerName);

    let res = await issuable();
    expect(res.rows.map((r) => [r.lot_id, r.received, r.issued, r.quantity])).toEqual([
      [LOT, "50.000", "45.000", "5.000"],
    ]);

    // Editing the (edited) first job work: its own 25 g is available again → 30 g
    res = await issuable(jw1Id);
    expect(res.rows.map((r) => [r.lot_id, r.received, r.issued, r.quantity])).toEqual([
      [LOT, "50.000", "20.000", "30.000"],
    ]);
    // The soft-deleted old version never counts, excluded or not
    res = await issuable(jw1OrigId);
    expect(res.rows.map((r) => r.quantity)).toEqual(["5.000"]);
  });

  it("7. Job Work Ornament Receipt (employee → shop): two ornaments on the cycle, both listed, not issued", async () => {
    const { group: j3, entries } = await jw.createJobWork(
      jobWorkInput(cycle.id, {
        ornament_receipt: [
          { item_id: ornamentItemId, quantity: "20", purity: TOUCH, wastage_percent: "2" },
          { item_id: ornamentItemId, quantity: "12", purity: TOUCH, wastage_percent: "0" },
        ],
      }),
    );
    jw3Id = j3.id;
    expect(j3.order_cycle_id).toBe(cycle.id);
    expect(entries.length).toBe(2);
    for (const e of entries) {
      expect(e.from_account_id).toBe(employeeId);
      expect(e.to_account_id).toBe("00000000-0000-0000-0000-000000000001");
      expect(e.lot_id).not.toBeNull();
    }
    expect(entries[0]!.lot_id).not.toBe(entries[1]!.lot_id); // different lots

    // Ornament receipts never touch the issuable gold
    expect((await issuable()).rows.map((r) => r.quantity)).toEqual(["5.000"]);

    const fo = await link.getFinishedOrnaments({ cycle_id: cycle.id });
    expect(fo.cycle_id).toBe(cycle.id);
    expect(fo.customer_id).toBe(customerId);
    expect(fo.customer_name).toBe(customerName);
    expect(fo.ornaments.length).toBe(2);
    const [a, b] = fo.ornaments;
    for (const o of [a!, b!]) {
      expect(o.group_id).toBe(jw3Id);
      expect(o.job_work_bill_no).toBe(j3.bill_no);
      expect(o.employee_id).toBe(employeeId);
      expect(o.employee_name).toBe(employeeName);
      expect(o.item_id).toBe(ornamentItemId);
      expect(Number(o.purity)).toBe(91.6);
      expect(o.already_issued).toBe(false);
    }
    expect([a!.quantity, b!.quantity]).toEqual(["20.000", "12.000"]);
    expect([Number(a!.wastage_percent), Number(b!.wastage_percent)]).toEqual([2, 0]);
    expect(a!.lot_id).not.toBe(b!.lot_id);
    expect(new Set([a!.lot_id, b!.lot_id])).toEqual(new Set(entries.map((e) => e.lot_id)));
    ornLotA = a!.lot_id!;
    ornLotB = b!.lot_id!;
  });

  it("8. Labour Bill Ornament Issue (shop → customer) of ONE lot: that one already_issued; exclude_group_id clears it", async () => {
    const { group, entries } = await lb.createLabourBill(
      labourBillInput({
        ornament_issue: [{ item_id: ornamentItemId, quantity: "20", purity: TOUCH, wastage_percent: "2", lot_id: ornLotA }],
      }),
    );
    issueBillId = group.id;
    expect(group.bill_cycle_id).toBe(cycle.id);
    expect(entries[0]!.from_account_id).toBe("00000000-0000-0000-0000-000000000001");
    expect(entries[0]!.to_account_id).toBe(customerId);
    expect(entries[0]!.lot_id).toBe(ornLotA);

    let fo = await link.getFinishedOrnaments({ cycle_id: cycle.id });
    expect(fo.ornaments.map((o) => [o.lot_id, o.already_issued])).toEqual([
      [ornLotA, true],
      [ornLotB, false],
    ]);
    fo = await link.getFinishedOrnaments({ cycle_id: cycle.id, exclude_group_id: issueBillId });
    expect(fo.ornaments.map((o) => [o.lot_id, o.already_issued])).toEqual([
      [ornLotA, false],
      [ornLotB, false],
    ]);

    // Ornament Issue never reduces the issuable gold
    expect((await issuable()).rows.map((r) => r.quantity)).toEqual(["5.000"]);
  });

  it("9. getCycleDetail: labour bills + linked job works; customer and employee summaries kept apart", async () => {
    const d = await lb.getCycleDetail({ cycle_id: cycle.id });
    expect(d.cycle.id).toBe(cycle.id);
    expect(d.cycle.status).toBe("OPEN");
    expect(d.groups.map((g) => g.group.id)).toEqual([receiptBillId, issueBillId]);
    expect(d.groups.every((g) => g.group.type === "LABOUR_BILL")).toBe(true);
    // Edited job work keeps its original timestamp → still first
    expect(d.job_works.map((g) => g.group.id)).toEqual([jw1Id, jw2Id, jw3Id]);
    expect(d.job_works.every((g) => g.account_name === employeeName)).toBe(true);
    expect(d.job_works.some((g) => g.group.id === jw1OrigId)).toBe(false);

    // Customer: gold received 50 × 0.916 = 45.800
    //           ornament issued (20 + 20×0.02/0.916) × 0.916 = 18.32 + 0.4 = 18.720
    // Employee: gold issued (25 + 20) × 0.916 = 41.220
    //           ornament received 18.720 + 12 × 0.916 (10.992) = 29.712
    expect(d.summary).toEqual({
      customer: { gold_received_pure: "45.800", ornament_issued_pure: "18.720" },
      employees: [
        {
          account_id: employeeId,
          name: employeeName,
          gold_issued_pure: "41.220",
          ornament_received_pure: "29.712",
        },
      ],
    });
  });

  it("10. Delivered: new bill / new link refused, picker hides it, edits allowed; reopen → new bill allowed", async () => {
    const delivered = await link.setCycleStatus({ cycle_id: cycle.id, status: "DELIVERED" });
    expect(delivered.status).toBe("DELIVERED");
    expect(delivered.delivered_at).not.toBeNull();

    // New labour bill → refused
    const lbErr = await errorOf(
      lb.createLabourBill(labourBillInput({ gold_receipt: [{ item_id: goldItemId, quantity: "1", purity: TOUCH }] })),
    );
    expect(lbErr).not.toBeNull();
    expect(lbErr!.code).toBe("BUSINESS_RULE_VIOLATION");
    expect(lbErr!.message).toContain("is closed");

    // New job work linking it → refused
    const jwErr = await errorOf(
      jw.createJobWork(jobWorkInput(cycle.id, { gold_issue: [{ item_id: goldItemId, quantity: "1", purity: TOUCH }] })),
    );
    expect(jwErr).not.toBeNull();
    expect(jwErr!.code).toBe("BUSINESS_RULE_VIOLATION");
    expect(jwErr!.message).toContain("is closed");

    // Refusals left nothing behind
    const dAfterRefusal = await lb.getCycleDetail({ cycle_id: cycle.id });
    expect(dAfterRefusal.groups.length).toBe(2);
    expect(dAfterRefusal.job_works.length).toBe(3);

    // Picker hides it unless it is the edited job work's cycle
    expect((await link.listOpenCycles({})).some((c) => c.id === cycle.id)).toBe(false);
    const incl = (await link.listOpenCycles({ include_cycle_id: cycle.id })).find((c) => c.id === cycle.id);
    expect(incl?.status).toBe("DELIVERED");
    expect(incl?.customer_name).toBe(customerName);

    // Editing an EXISTING labour bill on it → allowed (50 → 48 g)
    const { group: rb2 } = await lb.updateLabourBill({
      ...labourBillInput({ gold_receipt: [{ item_id: goldItemId, quantity: "48", purity: TOUCH, lot_id: LOT }] }),
      id: receiptBillId,
    });
    expect(rb2.bill_cycle_id).toBe(cycle.id);
    expect(rb2.id).not.toBe(receiptBillId);
    receiptBillId = rb2.id;

    // Editing an EXISTING job work on it → allowed (link kept, 20 → 18 g)
    const { group: j2b } = await jw.updateJobWork({
      ...jobWorkInput(cycle.id, { gold_issue: [{ item_id: goldItemId, quantity: "18", purity: TOUCH, lot_id: LOT }] }),
      id: jw2Id,
    });
    expect(j2b.order_cycle_id).toBe(cycle.id);
    jw2Id = j2b.id;

    // 48 received − (25 + 18) issued = 5 g
    expect((await issuable()).rows.map((r) => [r.received, r.issued, r.quantity])).toEqual([
      ["48.000", "43.000", "5.000"],
    ]);

    // Reopen → a new labour bill is allowed again, picker lists it again
    const reopened = await link.setCycleStatus({ cycle_id: cycle.id, status: "OPEN" });
    expect(reopened.status).toBe("OPEN");
    expect(reopened.delivered_at).toBeNull();
    expect((await link.listOpenCycles({})).some((c) => c.id === cycle.id)).toBe(true);

    const { group: lb3 } = await lb.createLabourBill(
      labourBillInput({ gold_receipt: [{ item_id: goldItemId, quantity: "2", purity: TOUCH, lot_id: LOT }] }),
    );
    expect(lb3.bill_cycle_id).toBe(cycle.id);
    expect((await issuable()).rows.map((r) => [r.received, r.issued, r.quantity])).toEqual([
      ["50.000", "43.000", "7.000"],
    ]);
  });
});
