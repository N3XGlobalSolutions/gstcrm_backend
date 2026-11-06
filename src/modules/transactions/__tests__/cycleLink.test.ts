/**
 * Integration test: customer cycle (labour_bill_cycles) ↔ Issue Job Works link
 * (migration 0026) — Required Touch, order_cycle_id on job works, issuableGold,
 * finishedOrnaments, getCycleDetail summary, Delivered / reopen.
 *
 * Runs against a real Postgres. Point DATABASE_URL at a throwaway test database
 * before running — the guard below refuses anything that isn't a *_test DB.
 *
 *   DATABASE_URL='postgresql://.../goldcrm_fullcycle_test?...' \
 *     bun test --timeout 60000 src/modules/transactions/__tests__/cycleLink.test.ts
 *
 * Every test creates its own uniquely-named accounts, so it never touches (or
 * depends on) data written by anything else in the same database.
 */
import { beforeAll, describe, expect, it } from "bun:test";

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

const RUN = `CYLINK-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
const TODAY = new Date().toISOString().split("T")[0]!;
const RATE = "6000";

let goldItemId: string;
let ornamentItemId: string;

beforeAll(async () => {
  ({ db } = await import("@/db"));
  schema = await import("@/db/schema");
  lb = await import("../labourBill/service");
  jw = await import("../jobWork/service");
  link = await import("../labourBill/cycleLink");
  entryNo = await import("@/lib/entryNoGenerator");
  orm = await import("drizzle-orm");

  goldItemId = await db.transaction(async (tx) => {
    const no = await entryNo.generateEntryNo(tx as any, "items", "GOLD");
    const [item] = await tx
      .insert(schema.items)
      .values({ entry_no: no, name: `${RUN} Gold`, type: "GOLD", unit: "GRAM", touch: "91.6" })
      .returning();
    return item!.id;
  });
  ornamentItemId = await db.transaction(async (tx) => {
    const no = await entryNo.generateEntryNo(tx as any, "items", "ORNAMENT");
    const [item] = await tx
      .insert(schema.items)
      .values({ entry_no: no, name: `${RUN} Ring`, type: "ORNAMENT", unit: "GRAM", touch: "91.6" })
      .returning();
    return item!.id;
  });
});

// ─── helpers ──────────────────────────────────────────────────────────────────

// bun 1.3.14's `expect(promise).rejects` hangs on DB-backed rejections.
async function errorOf(p: PromiseLike<unknown>): Promise<string | null> {
  try {
    await p;
    return null;
  } catch (e) {
    const cause = (e as { cause?: unknown }).cause;
    const msg = e instanceof Error ? e.message : String(e);
    return cause instanceof Error ? `${msg}\n${cause.message}` : msg;
  }
}

let seq = 0;
async function newAccount(kind: "customer" | "employee"): Promise<string> {
  const name = `${RUN} ${kind} ${++seq}`;
  return db.transaction(async (tx) => {
    const type = kind === "customer" ? "CUSTOMER" : "GOLDSMITH";
    const no = await entryNo.generateEntryNo(tx as any, "accounts", type);
    const [acc] = await tx
      .insert(schema.accounts)
      .values({
        entry_no: no,
        name,
        type,
        customer_type: kind === "customer" ? "LABOUR_BILL" : null,
      })
      .returning();
    return acc!.id;
  });
}

async function newCustomerCycle(touch = "91.6") {
  const customerId = await newAccount("customer");
  const cycle = await lb.createCycle({ account_id: customerId, main_reason: RUN, required_touch: touch });
  return { customerId, cycle };
}

async function newEmployee() {
  const employeeId = await newAccount("employee");
  // Required Touch % on the job-work cycle: its job works have Ornament Receipts.
  const jwCycle = await jw.createCycle({ account_id: employeeId, main_reason: RUN, required_touch: "91.6" });
  return { employeeId, jwCycleId: jwCycle.id };
}

type Gold = { item_id: string; quantity: string; purity: string; lot_id?: string };
type Orn = { item_id: string; quantity: string; purity: string; wastage_percent: string; lot_id?: string };

function labourBillInput(
  customerId: string,
  cycleId: string,
  rows: { gold_receipt?: Gold[]; ornament_issue?: Orn[] },
) {
  return {
    account_id: customerId,
    bill_cycle_id: cycleId,
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
  employeeId: string,
  jwCycleId: string,
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

async function groupRow(id: string) {
  const [g] = await db.select().from(schema.entryGroups).where(orm.eq(schema.entryGroups.id, id)).limit(1);
  return g!;
}

// ─── tests ────────────────────────────────────────────────────────────────────

describe("customer cycle: Required Touch", () => {
  it("createCycle requires a touch in (0, 100] and stores it with status OPEN", async () => {
    const customerId = await newAccount("customer");

    // missing / empty / out of range → refused, nothing created
    expect(await errorOf(lb.createCycle({ account_id: customerId } as any))).not.toBeNull();
    expect(await errorOf(lb.createCycle({ account_id: customerId, required_touch: "" }))).toContain("Required touch");
    expect(await errorOf(lb.createCycle({ account_id: customerId, required_touch: "0" }))).toContain("Required touch");
    expect(await errorOf(lb.createCycle({ account_id: customerId, required_touch: "100.5" }))).toContain("Required touch");
    expect(await errorOf(lb.createCycle({ account_id: customerId, required_touch: "abc" }))).toContain("Required touch");
    expect((await lb.listCycles({ account_id: customerId })).length).toBe(0);

    const cycle = await lb.createCycle({ account_id: customerId, required_touch: "91.6", main_reason: RUN });
    expect(cycle.bill_no).toBe(1);
    expect(Number(cycle.required_touch)).toBe(91.6);
    expect(cycle.status).toBe("OPEN");
    expect(cycle.delivered_at).toBeNull();

    const [listed] = await lb.listCycles({ account_id: customerId });
    expect(listed!.id).toBe(cycle.id);
    expect(Number(listed!.required_touch)).toBe(91.6);
    expect(listed!.status).toBe("OPEN");
  });
});

describe("job work ↔ customer cycle link", () => {
  it("order_cycle_id is saved, survives an update (kept when omitted), and can be cleared", async () => {
    const { cycle } = await newCustomerCycle();
    const { employeeId, jwCycleId } = await newEmployee();

    const { group: a } = await jw.createJobWork(
      jobWorkInput(employeeId, jwCycleId, cycle.id, { gold_issue: [{ item_id: goldItemId, quantity: "2", purity: "91.6" }] }),
    );
    expect(a.order_cycle_id).toBe(cycle.id);
    expect(a.job_work_cycle_id).toBe(jwCycleId);

    const byId = await jw.getJobWorkById({ id: a.id });
    expect(byId.group.order_cycle_id).toBe(cycle.id);
    expect(byId.order_cycle?.bill_no).toBe(cycle.bill_no);
    expect(Number(byId.order_cycle?.required_touch)).toBe(91.6);
    expect(byId.order_cycle_bill_no).toBe(cycle.bill_no);
    expect(byId.order_cycle_customer_name).toContain(RUN);

    // Update sending the same link → kept, timestamp kept
    const { group: b } = await jw.updateJobWork({
      ...jobWorkInput(employeeId, jwCycleId, cycle.id, { gold_issue: [{ item_id: goldItemId, quantity: "3", purity: "91.6" }] }),
      id: a.id,
    });
    expect(b.id).not.toBe(a.id);
    expect(b.order_cycle_id).toBe(cycle.id);
    expect(new Date((await groupRow(b.id)).created_at).getTime()).toBe(new Date(a.created_at).getTime());

    // Update omitting the field → stored link kept
    const { group: c } = await jw.updateJobWork({
      ...jobWorkInput(employeeId, jwCycleId, undefined, { gold_issue: [{ item_id: goldItemId, quantity: "3", purity: "91.6" }] }),
      id: b.id,
    });
    expect(c.order_cycle_id).toBe(cycle.id);

    // list rows carry it too
    const list = await jw.listJobWork({ page: 1, limit: 100 });
    const row = list.data.find((d) => d.group.id === c.id) as any;
    expect(row?.group.order_cycle_id).toBe(cycle.id);
    expect(row?.order_cycle?.id).toBe(cycle.id);
    expect(row?.order_cycle_bill_no).toBe(cycle.bill_no);
    expect(row?.order_cycle_customer_name).toContain(RUN);

    // Update with null → cleared
    const { group: d } = await jw.updateJobWork({
      ...jobWorkInput(employeeId, jwCycleId, null, { gold_issue: [{ item_id: goldItemId, quantity: "3", purity: "91.6" }] }),
      id: c.id,
    });
    expect(d.order_cycle_id).toBeNull();
    const cleared = await jw.getJobWorkById({ id: d.id });
    expect(cleared.order_cycle).toBeNull();
    expect(cleared.order_cycle_bill_no).toBeNull();
    expect(cleared.order_cycle_customer_name).toBeNull();
  });

  it("refuses a cycle that does not exist", async () => {
    const { employeeId, jwCycleId } = await newEmployee();
    const err = await errorOf(
      jw.createJobWork(
        jobWorkInput(employeeId, jwCycleId, "00000000-0000-4000-8000-00000000abcd", {
          gold_issue: [{ item_id: goldItemId, quantity: "1", purity: "91.6" }],
        }),
      ),
    );
    expect(err).toContain("customer cycle does not exist");
  });
});

describe("issuableGold", () => {
  it("received − issued per (item, lot, touch); leftovers spill to other lots; exclude_group_id", async () => {
    const { customerId, cycle } = await newCustomerCycle();
    const { employeeId, jwCycleId } = await newEmployee();
    const LOT = `T${Math.random().toString(36).slice(2, 10)}`;

    // Customer hands in 10g @91.6 (no lot) + 5g @91.6 into LOT, then 3g @99.5
    await lb.createLabourBill(
      labourBillInput(customerId, cycle.id, {
        gold_receipt: [
          { item_id: goldItemId, quantity: "10", purity: "91.6" },
          { item_id: goldItemId, quantity: "5", purity: "91.6", lot_id: LOT },
        ],
      }),
    );
    await lb.createLabourBill(
      labourBillInput(customerId, cycle.id, { gold_receipt: [{ item_id: goldItemId, quantity: "3", purity: "99.5" }] }),
    );

    let res = await link.getIssuableGold({ cycle_id: cycle.id });
    expect(res.bill_no).toBe(cycle.bill_no);
    expect(Number(res.required_touch)).toBe(91.6);
    const simple = (r: typeof res) =>
      r.rows.map((x) => [x.lot_id, x.purity, x.received, x.issued, x.quantity]);
    expect(simple(res)).toEqual([
      [null, "91.60", "10.000", "0.000", "10.000"],
      [LOT, "91.60", "5.000", "0.000", "5.000"],
      [null, "99.50", "3.000", "0.000", "3.000"],
    ]);

    // Employee gets 4g @91.6 (no lot) on a linked job work
    const { group: j1 } = await jw.createJobWork(
      jobWorkInput(employeeId, jwCycleId, cycle.id, { gold_issue: [{ item_id: goldItemId, quantity: "4", purity: "91.6" }] }),
    );
    // An UNLINKED job work never counts
    await jw.createJobWork(
      jobWorkInput(employeeId, jwCycleId, null, { gold_issue: [{ item_id: goldItemId, quantity: "50", purity: "91.6" }] }),
    );
    res = await link.getIssuableGold({ cycle_id: cycle.id });
    expect(simple(res)).toEqual([
      [null, "91.60", "10.000", "4.000", "6.000"],
      [LOT, "91.60", "5.000", "0.000", "5.000"],
      [null, "99.50", "3.000", "0.000", "3.000"],
    ]);

    // 7g more @91.6 (no lot): 6 from the no-lot row, 1 spills into LOT
    const { group: j2 } = await jw.createJobWork(
      jobWorkInput(employeeId, jwCycleId, cycle.id, { gold_issue: [{ item_id: goldItemId, quantity: "7", purity: "91.6" }] }),
    );
    res = await link.getIssuableGold({ cycle_id: cycle.id });
    expect(simple(res)).toEqual([
      [LOT, "91.60", "5.000", "1.000", "4.000"],
      [null, "99.50", "3.000", "0.000", "3.000"],
    ]);

    // Editing j2: its own rows don't count
    res = await link.getIssuableGold({ cycle_id: cycle.id, exclude_group_id: j2.id });
    expect(simple(res)).toEqual([
      [null, "91.60", "10.000", "4.000", "6.000"],
      [LOT, "91.60", "5.000", "0.000", "5.000"],
      [null, "99.50", "3.000", "0.000", "3.000"],
    ]);

    // An edited job work counts once (old version soft-deleted)
    await jw.updateJobWork({
      ...jobWorkInput(employeeId, jwCycleId, cycle.id, { gold_issue: [{ item_id: goldItemId, quantity: "5", purity: "91.6" }] }),
      id: j1.id,
    });
    res = await link.getIssuableGold({ cycle_id: cycle.id });
    // 5 + 7 = 12 issued against 10 (no lot) → 2 spill into LOT
    expect(simple(res)).toEqual([
      [LOT, "91.60", "5.000", "2.000", "3.000"],
      [null, "99.50", "3.000", "0.000", "3.000"],
    ]);
  });
});

describe("finishedOrnaments + getCycleDetail", () => {
  it("lists the linked job works' ornament receipts; already_issued after a labour bill issues the lot", async () => {
    const { customerId, cycle } = await newCustomerCycle();
    const { employeeId, jwCycleId } = await newEmployee();

    const { group: recv } = await lb.createLabourBill(
      labourBillInput(customerId, cycle.id, { gold_receipt: [{ item_id: goldItemId, quantity: "10", purity: "91.6" }] }),
    );
    const { group: jwg } = await jw.createJobWork(
      jobWorkInput(employeeId, jwCycleId, cycle.id, {
        gold_issue: [{ item_id: goldItemId, quantity: "10", purity: "91.6" }],
        ornament_receipt: [
          { item_id: ornamentItemId, quantity: "8", purity: "91.6", wastage_percent: "2" },
          { item_id: ornamentItemId, quantity: "1.5", purity: "91.6", wastage_percent: "0" },
        ],
      }),
    );

    let fo = await lb.getCycleDetail({ cycle_id: cycle.id }); // warm path; also checked below
    let res = await link.getFinishedOrnaments({ cycle_id: cycle.id });
    expect(res.cycle_id).toBe(cycle.id);
    expect(res.customer_id).toBe(customerId);
    expect(res.ornaments.length).toBe(2);
    const [o1, o2] = res.ornaments;
    expect(o1!.group_id).toBe(jwg.id);
    expect(o1!.job_work_bill_no).toBe(jwg.bill_no);
    expect(o1!.employee_id).toBe(employeeId);
    expect(o1!.lot_id).not.toBeNull();
    expect(o1!.quantity).toBe("8.000");
    expect(Number(o1!.purity)).toBe(91.6);
    expect(Number(o1!.wastage_percent)).toBe(2);
    expect(o1!.already_issued).toBe(false);
    expect(o2!.already_issued).toBe(false);

    // Labour bill issues the first ornament's lot to the customer
    const { group: issueBill } = await lb.createLabourBill(
      labourBillInput(customerId, cycle.id, {
        ornament_issue: [
          { item_id: ornamentItemId, quantity: "8", purity: "91.6", wastage_percent: "2", lot_id: o1!.lot_id! },
        ],
      }),
    );
    res = await link.getFinishedOrnaments({ cycle_id: cycle.id });
    expect(res.ornaments.map((o) => o.already_issued)).toEqual([true, false]);
    // Editing that bill: its own issue no longer counts
    res = await link.getFinishedOrnaments({ cycle_id: cycle.id, exclude_group_id: issueBill.id });
    expect(res.ornaments.map((o) => o.already_issued)).toEqual([false, false]);

    // getCycleDetail: groups (labour bills) + job_works + summary, sides kept apart
    fo = await lb.getCycleDetail({ cycle_id: cycle.id });
    expect(fo.groups.map((g) => g.group.id).sort()).toEqual([recv.id, issueBill.id].sort());
    expect(fo.job_works.map((g) => g.group.id)).toEqual([jwg.id]);
    expect(fo.job_works[0]!.account_name).toContain(RUN);
    expect(fo.summary.customer.gold_received_pure).toBe("9.160");
    // 8g @91.6 + 2% wastage: (8 + 8×0.02/0.916) × 0.916 = 7.488
    expect(fo.summary.customer.ornament_issued_pure).toBe("7.488");
    expect(fo.summary.employees.length).toBe(1);
    expect(fo.summary.employees[0]!.account_id).toBe(employeeId);
    expect(fo.summary.employees[0]!.gold_issued_pure).toBe("9.160");
    // 7.488 + 1.5 × 0.916 = 8.862
    expect(fo.summary.employees[0]!.ornament_received_pure).toBe("8.862");

    // A cycle with nothing on it still returns the new keys
    const { cycle: empty } = await newCustomerCycle();
    const ed = await lb.getCycleDetail({ cycle_id: empty.id });
    expect(ed.groups).toEqual([]);
    expect(ed.job_works).toEqual([]);
    expect(ed.summary).toEqual({ customer: { gold_received_pure: "0.000", ornament_issued_pure: "0.000" }, employees: [] });
  });
});

describe("Delivered / reopen", () => {
  it("delivered cycle blocks a new labour bill and a new job-work link; edits stay allowed; reopen works", async () => {
    const { customerId, cycle } = await newCustomerCycle();
    const { employeeId, jwCycleId } = await newEmployee();

    const { group: bill } = await lb.createLabourBill(
      labourBillInput(customerId, cycle.id, { gold_receipt: [{ item_id: goldItemId, quantity: "2", purity: "91.6" }] }),
    );
    const { group: job } = await jw.createJobWork(
      jobWorkInput(employeeId, jwCycleId, cycle.id, { gold_issue: [{ item_id: goldItemId, quantity: "1", purity: "91.6" }] }),
    );

    const delivered = await link.setCycleStatus({ cycle_id: cycle.id, status: "DELIVERED" });
    expect(delivered.status).toBe("DELIVERED");
    expect(delivered.delivered_at).not.toBeNull();
    // Re-marking keeps the original delivered_at
    const again = await link.setCycleStatus({ cycle_id: cycle.id, status: "DELIVERED" });
    expect(new Date(again.delivered_at!).getTime()).toBe(new Date(delivered.delivered_at!).getTime());

    // Open-cycle picker leaves it out unless asked for
    expect((await link.listOpenCycles({})).some((c) => c.id === cycle.id)).toBe(false);
    const incl = await link.listOpenCycles({ include_cycle_id: cycle.id });
    expect(incl.find((c) => c.id === cycle.id)?.status).toBe("DELIVERED");

    // New labour bill → refused
    const lbErr = await errorOf(
      lb.createLabourBill(
        labourBillInput(customerId, cycle.id, { gold_receipt: [{ item_id: goldItemId, quantity: "1", purity: "91.6" }] }),
      ),
    );
    expect(lbErr).toContain("is closed");
    // New job work linking it → refused
    const jwErr = await errorOf(
      jw.createJobWork(
        jobWorkInput(employeeId, jwCycleId, cycle.id, { gold_issue: [{ item_id: goldItemId, quantity: "1", purity: "91.6" }] }),
      ),
    );
    expect(jwErr).toContain("is closed");
    // Existing job work moved ONTO a delivered cycle → refused (and not reversed)
    const { group: other } = await jw.createJobWork(
      jobWorkInput(employeeId, jwCycleId, null, { gold_issue: [{ item_id: goldItemId, quantity: "1", purity: "91.6" }] }),
    );
    const moveErr = await errorOf(
      jw.updateJobWork({
        ...jobWorkInput(employeeId, jwCycleId, cycle.id, { gold_issue: [{ item_id: goldItemId, quantity: "1", purity: "91.6" }] }),
        id: other.id,
      }),
    );
    expect(moveErr).toContain("is closed");
    expect((await groupRow(other.id)).is_deleted).toBe(false);

    // Edits of bills already on it → allowed
    const { group: bill2 } = await lb.updateLabourBill({
      ...labourBillInput(customerId, cycle.id, { gold_receipt: [{ item_id: goldItemId, quantity: "3", purity: "91.6" }] }),
      id: bill.id,
    });
    expect(bill2.bill_cycle_id).toBe(cycle.id);
    const { group: job2 } = await jw.updateJobWork({
      ...jobWorkInput(employeeId, jwCycleId, cycle.id, { gold_issue: [{ item_id: goldItemId, quantity: "2", purity: "91.6" }] }),
      id: job.id,
    });
    expect(job2.order_cycle_id).toBe(cycle.id);

    // Reopen → new bill + link work again
    const reopened = await link.setCycleStatus({ cycle_id: cycle.id, status: "OPEN" });
    expect(reopened.status).toBe("OPEN");
    expect(reopened.delivered_at).toBeNull();
    expect((await link.listOpenCycles({})).some((c) => c.id === cycle.id)).toBe(true);
    const { group: bill3 } = await lb.createLabourBill(
      labourBillInput(customerId, cycle.id, { gold_receipt: [{ item_id: goldItemId, quantity: "1", purity: "91.6" }] }),
    );
    expect(bill3.bill_cycle_id).toBe(cycle.id);
    const { group: job3 } = await jw.createJobWork(
      jobWorkInput(employeeId, jwCycleId, cycle.id, { gold_issue: [{ item_id: goldItemId, quantity: "1", purity: "91.6" }] }),
    );
    expect(job3.order_cycle_id).toBe(cycle.id);
  });
});

describe("Labour Bill \"Close cycle\" tick (close_cycle)", () => {
  async function cycleState(id: string) {
    const [c] = await db
      .select({ status: schema.labourBillCycles.status, delivered_at: schema.labourBillCycles.delivered_at })
      .from(schema.labourBillCycles)
      .where(orm.eq(schema.labourBillCycles.id, id))
      .limit(1);
    return c!;
  }
  const gold = (q: string) => ({ gold_receipt: [{ item_id: goldItemId, quantity: q, purity: "91.6" }] });

  it("a new bill with close_cycle=true saves and then closes the open cycle", async () => {
    const { customerId, cycle } = await newCustomerCycle();
    const { group } = await lb.createLabourBill({ ...labourBillInput(customerId, cycle.id, gold("2")), close_cycle: true });
    expect(group.bill_cycle_id).toBe(cycle.id);
    expect((await groupRow(group.id)).is_deleted).toBe(false);
    const c = await cycleState(cycle.id);
    expect(c.status).toBe("DELIVERED");
    expect(c.delivered_at).not.toBeNull();
  });

  it("close_cycle=false / undefined on a new bill leaves an open cycle open", async () => {
    const { customerId, cycle } = await newCustomerCycle();
    await lb.createLabourBill({ ...labourBillInput(customerId, cycle.id, gold("1")), close_cycle: false });
    expect((await cycleState(cycle.id)).status).toBe("OPEN");
    await lb.createLabourBill(labourBillInput(customerId, cycle.id, gold("1")));
    const c = await cycleState(cycle.id);
    expect(c.status).toBe("OPEN");
    expect(c.delivered_at).toBeNull();
  });

  it("a new bill on a closed cycle is still refused, even with close_cycle=false", async () => {
    const { customerId, cycle } = await newCustomerCycle();
    await lb.createLabourBill({ ...labourBillInput(customerId, cycle.id, gold("1")), close_cycle: true });
    expect((await cycleState(cycle.id)).status).toBe("DELIVERED");

    for (const close_cycle of [false, true, undefined]) {
      const err = await errorOf(
        lb.createLabourBill({ ...labourBillInput(customerId, cycle.id, gold("1")), close_cycle }),
      );
      expect(err).toContain(`Bill cycle ${cycle.bill_no} is closed`);
    }
    // Refusal leaves the cycle closed and adds no bill
    expect((await cycleState(cycle.id)).status).toBe("DELIVERED");
    const detail = await lb.getCycleDetail({ cycle_id: cycle.id });
    expect(detail.groups.length).toBe(1);
  });

  it("editing a bill on a closed cycle: undefined / true keep it closed; false reopens it", async () => {
    const { customerId, cycle } = await newCustomerCycle();
    const { group: a } = await lb.createLabourBill({ ...labourBillInput(customerId, cycle.id, gold("2")), close_cycle: true });
    const closedAt = (await cycleState(cycle.id)).delivered_at;
    expect(closedAt).not.toBeNull();

    // undefined → untouched (delivered_at kept)
    const { group: b } = await lb.updateLabourBill({ ...labourBillInput(customerId, cycle.id, gold("3")), id: a.id });
    let c = await cycleState(cycle.id);
    expect(c.status).toBe("DELIVERED");
    expect(new Date(c.delivered_at!).getTime()).toBe(new Date(closedAt!).getTime());

    // true on an already-closed cycle → no change (delivered_at kept)
    const { group: d } = await lb.updateLabourBill({
      ...labourBillInput(customerId, cycle.id, gold("4")),
      id: b.id,
      close_cycle: true,
    });
    c = await cycleState(cycle.id);
    expect(c.status).toBe("DELIVERED");
    expect(new Date(c.delivered_at!).getTime()).toBe(new Date(closedAt!).getTime());

    // false → edit saves and the cycle reopens
    const { group: e } = await lb.updateLabourBill({
      ...labourBillInput(customerId, cycle.id, gold("5")),
      id: d.id,
      close_cycle: false,
    });
    expect(e.bill_cycle_id).toBe(cycle.id);
    expect((await groupRow(d.id)).is_deleted).toBe(true);
    c = await cycleState(cycle.id);
    expect(c.status).toBe("OPEN");
    expect(c.delivered_at).toBeNull();

    // …so a new bill is accepted again
    const { group: f } = await lb.createLabourBill(labourBillInput(customerId, cycle.id, gold("1")));
    expect(f.bill_cycle_id).toBe(cycle.id);
  });

  it("editing a bill on an open cycle with close_cycle=true closes it", async () => {
    const { customerId, cycle } = await newCustomerCycle();
    const { group: a } = await lb.createLabourBill(labourBillInput(customerId, cycle.id, gold("2")));
    await lb.updateLabourBill({ ...labourBillInput(customerId, cycle.id, gold("2")), id: a.id, close_cycle: true });
    const c = await cycleState(cycle.id);
    expect(c.status).toBe("DELIVERED");
    expect(c.delivered_at).not.toBeNull();
  });
});
