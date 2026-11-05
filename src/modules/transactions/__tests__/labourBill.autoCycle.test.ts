/**
 * Integration test: Labour Bill automated cycle ("New cycle" on save) + Required
 * Touch on the bill (Gold CRM's Labour Bill "New voucher" behaviour).
 *
 * Runs against a real Postgres. Point DATABASE_URL at a throwaway test database
 * before running — the guard below refuses anything that isn't a *_test DB.
 *
 *   DATABASE_URL='postgresql://.../goldcrm_fullcycle_test?...' \
 *     bun test --timeout 60000 src/modules/transactions/__tests__/labourBill.autoCycle.test.ts
 *
 * Every test creates its own uniquely-named accounts. The shared pool is NOT
 * closed here (labourBill.edit.test.ts, which runs last, does that).
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

let db: typeof import("@/db").db;
let schema: typeof import("@/db/schema");
let lb: typeof import("../labourBill/service");
let entryNo: typeof import("@/lib/entryNoGenerator");
let orm: typeof import("drizzle-orm");

const RUN = `AUTOCY-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
const TODAY = new Date().toISOString().split("T")[0]!;

let goldItemId: string;

beforeAll(async () => {
  ({ db } = await import("@/db"));
  schema = await import("@/db/schema");
  lb = await import("../labourBill/service");
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
});

// ─── helpers ──────────────────────────────────────────────────────────────────

// bun's `expect(promise).rejects` hangs on DB-backed rejections.
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
async function newCustomer(): Promise<string> {
  const name = `${RUN} customer ${++seq}`;
  return db.transaction(async (tx) => {
    const no = await entryNo.generateEntryNo(tx as any, "accounts", "CUSTOMER");
    const [acc] = await tx
      .insert(schema.accounts)
      .values({ entry_no: no, name, type: "CUSTOMER", customer_type: "LABOUR_BILL" })
      .returning();
    return acc!.id;
  });
}

/** A pre-0026 style cycle with no Required Touch stored. */
async function cycleWithoutTouch(customerId: string, billNo: number) {
  const [c] = await db
    .insert(schema.labourBillCycles)
    .values({ account_id: customerId, bill_no: billNo, main_reason: RUN, status: "OPEN" })
    .returning();
  return c!;
}

const goldReceipt = (q: string) => [{ item_id: goldItemId, quantity: q, purity: "91.6" }];
const goldIssue = (q: string) => [{ item_id: goldItemId, quantity: q, purity: "91.6" }];

function bill(
  customerId: string,
  cycle: { bill_cycle_id?: string; new_cycle?: boolean },
  rows: { gold_receipt?: ReturnType<typeof goldReceipt>; gold_issue?: ReturnType<typeof goldIssue> },
  extra: { required_touch?: string; close_cycle?: boolean } = {},
) {
  return {
    account_id: customerId,
    ...cycle,
    ...extra,
    date: TODAY,
    rate_per_gram: "6000",
    remarks: RUN,
    gold_issue: rows.gold_issue ?? [],
    gold_receipt: rows.gold_receipt ?? [],
    ornament_issue: [],
    ornament_receipt: [],
    cash_conversions: [],
  };
}

async function cyclesOf(customerId: string) {
  return db
    .select()
    .from(schema.labourBillCycles)
    .where(orm.eq(schema.labourBillCycles.account_id, customerId))
    .orderBy(schema.labourBillCycles.bill_no);
}

async function cycleRow(id: string) {
  const [c] = await db.select().from(schema.labourBillCycles).where(orm.eq(schema.labourBillCycles.id, id)).limit(1);
  return c!;
}

async function liveBillsOf(customerId: string) {
  return db
    .select()
    .from(schema.entryGroups)
    .where(
      orm.and(
        orm.eq(schema.entryGroups.account_id, customerId),
        orm.eq(schema.entryGroups.type, "LABOUR_BILL"),
        orm.eq(schema.entryGroups.is_deleted, false),
      ),
    );
}

async function groupRow(id: string) {
  const [g] = await db.select().from(schema.entryGroups).where(orm.eq(schema.entryGroups.id, id)).limit(1);
  return g!;
}

// ─── tests ────────────────────────────────────────────────────────────────────

describe("Labour Bill: New cycle on save", () => {
  it("new_cycle creates the customer's next cycle (N+1) with the touch, and the bill is on it", async () => {
    const customerId = await newCustomer();
    const first = await lb.createCycle({ account_id: customerId, required_touch: "91.6", main_reason: RUN });
    expect(first.bill_no).toBe(1);

    const res = await lb.createLabourBill(
      bill(customerId, { new_cycle: true }, { gold_receipt: goldReceipt("10") }, { required_touch: "92.5" }),
    );
    expect(res.cycle.bill_no).toBe(2);
    expect(Number(res.cycle.required_touch)).toBe(92.5);
    expect(res.cycle.status).toBe("OPEN");
    expect(res.group.bill_cycle_id).toBe(res.cycle.id);
    expect(res.group.bill_no).toBe(2);
    expect(res.entries.length).toBe(1);

    const stored = await cycleRow(res.cycle.id);
    expect(stored.account_id).toBe(customerId);
    expect(stored.main_reason).toBeNull();
    expect(stored.status).toBe("OPEN");

    // The first cycle is untouched; a following bill can use the new cycle by id
    expect(Number((await cycleRow(first.id)).required_touch)).toBe(91.6);
    const next = await lb.createLabourBill(
      bill(customerId, { bill_cycle_id: res.cycle.id }, { gold_receipt: goldReceipt("1") }),
    );
    expect(next.cycle.id).toBe(res.cycle.id);
    expect(next.group.bill_no).toBe(2);
  });

  it("first-ever bill with new_cycle is Cycle 1; a bill without gold receipt may leave the touch empty", async () => {
    const customerId = await newCustomer();
    const res = await lb.createLabourBill(bill(customerId, { new_cycle: true }, { gold_issue: goldIssue("2") }));
    expect(res.cycle.bill_no).toBe(1);
    expect(res.cycle.required_touch).toBeNull();
    // "" counts as not given
    const res2 = await lb.createLabourBill(
      bill(customerId, { new_cycle: true }, { gold_issue: goldIssue("1") }, { required_touch: "" }),
    );
    expect(res2.cycle.bill_no).toBe(2);
    expect(res2.cycle.required_touch).toBeNull();
  });

  it("two new_cycle bills for the same customer get consecutive numbers — also when saved at the same time", async () => {
    const customerId = await newCustomer();
    const a = await lb.createLabourBill(
      bill(customerId, { new_cycle: true }, { gold_receipt: goldReceipt("1") }, { required_touch: "91.6" }),
    );
    const b = await lb.createLabourBill(
      bill(customerId, { new_cycle: true }, { gold_receipt: goldReceipt("1") }, { required_touch: "91.6" }),
    );
    expect([a.cycle.bill_no, b.cycle.bill_no]).toEqual([1, 2]);

    // Concurrent saves (plus a manual createCycle) serialize on the account lock
    const [c, d, e] = await Promise.all([
      lb.createLabourBill(bill(customerId, { new_cycle: true }, { gold_receipt: goldReceipt("1") }, { required_touch: "91.6" })),
      lb.createLabourBill(bill(customerId, { new_cycle: true }, { gold_receipt: goldReceipt("1") }, { required_touch: "91.6" })),
      lb.createCycle({ account_id: customerId, required_touch: "91.6" }),
    ]);
    expect([c.cycle.bill_no, d.cycle.bill_no, e.bill_no].sort((x, y) => x - y)).toEqual([3, 4, 5]);
    expect((await cyclesOf(customerId)).map((x) => x.bill_no)).toEqual([1, 2, 3, 4, 5]);
    expect((await liveBillsOf(customerId)).length).toBe(4);
  });

  it("new_cycle + close_cycle: cycle created, bill saved, cycle closed — all in one save", async () => {
    const customerId = await newCustomer();
    const res = await lb.createLabourBill(
      bill(customerId, { new_cycle: true }, { gold_receipt: goldReceipt("3") }, { required_touch: "91.6", close_cycle: true }),
    );
    expect(res.cycle.status).toBe("DELIVERED");
    const stored = await cycleRow(res.cycle.id);
    expect(stored.status).toBe("DELIVERED");
    expect(stored.delivered_at).not.toBeNull();
    expect(res.group.bill_cycle_id).toBe(res.cycle.id);

    // …and, being closed, it takes no further NEW bill
    const err = await errorOf(
      lb.createLabourBill(bill(customerId, { bill_cycle_id: res.cycle.id }, { gold_receipt: goldReceipt("1") })),
    );
    expect(err).toContain(`Bill cycle ${res.cycle.bill_no} is closed`);
  });

  it("neither or both of bill_cycle_id / new_cycle → refused, nothing saved", async () => {
    const customerId = await newCustomer();
    const cycle = await lb.createCycle({ account_id: customerId, required_touch: "91.6" });
    const rows = { gold_receipt: goldReceipt("1") };

    expect(await errorOf(lb.createLabourBill(bill(customerId, {}, rows)))).toBe("Pick a cycle or New cycle.");
    expect(await errorOf(lb.createLabourBill(bill(customerId, { new_cycle: false }, rows)))).toBe(
      "Pick a cycle or New cycle.",
    );
    expect(
      await errorOf(lb.createLabourBill(bill(customerId, { bill_cycle_id: cycle.id, new_cycle: true }, rows, { required_touch: "91.6" }))),
    ).toBe("Pick a cycle or New cycle.");

    expect((await cyclesOf(customerId)).length).toBe(1);
    expect((await liveBillsOf(customerId)).length).toBe(0);
  });
});

describe("Labour Bill: Required Touch on the bill", () => {
  it("gold receipt without any touch is refused — nothing saved, no cycle created", async () => {
    const customerId = await newCustomer();

    // New cycle, no touch
    for (const required_touch of [undefined, "", "  "]) {
      const err = await errorOf(
        lb.createLabourBill(bill(customerId, { new_cycle: true }, { gold_receipt: goldReceipt("5") }, { required_touch })),
      );
      expect(err).toBe("Required Touch is needed when receiving gold.");
    }
    expect((await cyclesOf(customerId)).length).toBe(0);
    expect((await liveBillsOf(customerId)).length).toBe(0);

    // Existing cycle with no stored touch, no touch on the bill
    const bare = await cycleWithoutTouch(customerId, 1);
    const err = await errorOf(
      lb.createLabourBill(bill(customerId, { bill_cycle_id: bare.id }, { gold_receipt: goldReceipt("5") })),
    );
    expect(err).toBe("Required Touch is needed when receiving gold.");
    expect((await liveBillsOf(customerId)).length).toBe(0);
    expect((await cycleRow(bare.id)).required_touch).toBeNull();

    // A bill with no gold receipt doesn't need one
    await lb.createLabourBill(bill(customerId, { bill_cycle_id: bare.id }, { gold_issue: goldIssue("1") }));
    // Giving the touch on the bill fixes it and stores it on the cycle
    const ok = await lb.createLabourBill(
      bill(customerId, { bill_cycle_id: bare.id }, { gold_receipt: goldReceipt("5") }, { required_touch: "91.6" }),
    );
    expect(Number(ok.cycle.required_touch)).toBe(91.6);
    expect(Number((await cycleRow(bare.id)).required_touch)).toBe(91.6);
    // From now on the stored touch is enough
    await lb.createLabourBill(bill(customerId, { bill_cycle_id: bare.id }, { gold_receipt: goldReceipt("1") }));
    expect((await liveBillsOf(customerId)).length).toBe(3);
  });

  it("out-of-range touch is refused", async () => {
    const customerId = await newCustomer();
    for (const required_touch of ["0", "100.5", "abc", "-1"]) {
      const err = await errorOf(
        lb.createLabourBill(bill(customerId, { new_cycle: true }, { gold_receipt: goldReceipt("1") }, { required_touch })),
      );
      expect(err).toContain("Required touch must be greater than 0 and at most 100");
    }
    expect((await cyclesOf(customerId)).length).toBe(0);
  });

  it("a touch different from the existing cycle's updates the cycle (create and update); same touch is a no-op", async () => {
    const customerId = await newCustomer();
    const cycle = await lb.createCycle({ account_id: customerId, required_touch: "91.6" });
    const updatedAt0 = (await cycleRow(cycle.id)).updated_at;

    // Same value (different spelling) → untouched
    await lb.createLabourBill(
      bill(customerId, { bill_cycle_id: cycle.id }, { gold_receipt: goldReceipt("1") }, { required_touch: "91.60" }),
    );
    expect(new Date((await cycleRow(cycle.id)).updated_at).getTime()).toBe(new Date(updatedAt0).getTime());

    // Different → cycle updated
    const a = await lb.createLabourBill(
      bill(customerId, { bill_cycle_id: cycle.id }, { gold_receipt: goldReceipt("2") }, { required_touch: "92" }),
    );
    expect(Number(a.cycle.required_touch)).toBe(92);
    expect(Number((await cycleRow(cycle.id)).required_touch)).toBe(92);

    // Update of the bill with another touch → cycle updated again, bill stays on it
    const u = await lb.updateLabourBill({
      ...bill(customerId, { bill_cycle_id: cycle.id }, { gold_receipt: goldReceipt("3") }, { required_touch: "95.5" }),
      id: a.group.id,
    });
    expect(u.cycle.id).toBe(cycle.id);
    expect(u.group.bill_cycle_id).toBe(cycle.id);
    expect(u.group.bill_no).toBe(cycle.bill_no);
    expect(Number(u.cycle.required_touch)).toBe(95.5);
    expect(Number((await cycleRow(cycle.id)).required_touch)).toBe(95.5);
    expect((await groupRow(a.group.id)).is_deleted).toBe(true);

    // Omitted on update → stored touch kept
    const u2 = await lb.updateLabourBill({
      ...bill(customerId, { bill_cycle_id: cycle.id }, { gold_receipt: goldReceipt("4") }),
      id: u.group.id,
    });
    expect(Number(u2.cycle.required_touch)).toBe(95.5);
  });
});

describe("Labour Bill update: cycle rules", () => {
  it("new_cycle on update is refused and the stored bill is left as it was", async () => {
    const customerId = await newCustomer();
    const a = await lb.createLabourBill(
      bill(customerId, { new_cycle: true }, { gold_receipt: goldReceipt("2") }, { required_touch: "91.6" }),
    );

    const err1 = await errorOf(
      lb.updateLabourBill({
        ...bill(customerId, { new_cycle: true }, { gold_receipt: goldReceipt("3") }, { required_touch: "91.6" }),
        id: a.group.id,
      }),
    );
    expect(err1).toContain("New cycle is only for a new bill");
    const err2 = await errorOf(
      lb.updateLabourBill({
        ...bill(customerId, { bill_cycle_id: a.cycle.id, new_cycle: true }, { gold_receipt: goldReceipt("3") }),
        id: a.group.id,
      }),
    );
    expect(err2).toContain("New cycle is only for a new bill");
    // bill_cycle_id still required on update
    const err3 = await errorOf(
      lb.updateLabourBill({ ...bill(customerId, {}, { gold_receipt: goldReceipt("3") }), id: a.group.id }),
    );
    expect(err3).toBe("A bill cycle must be selected before saving a labour bill.");

    const g = await groupRow(a.group.id);
    expect(g.is_deleted).toBe(false);
    expect(g.reversed_by).toBeNull();
    expect((await cyclesOf(customerId)).length).toBe(1);
  });

  it("a refused edit (missing touch) leaves the bill unreversed; a valid edit keeps the bill's cycle", async () => {
    const customerId = await newCustomer();
    const bare = await cycleWithoutTouch(customerId, 1);
    const a = await lb.createLabourBill(bill(customerId, { bill_cycle_id: bare.id }, { gold_issue: goldIssue("2") }));

    // Edit adds a gold receipt but no touch anywhere → refused, nothing reversed
    const err = await errorOf(
      lb.updateLabourBill({
        ...bill(customerId, { bill_cycle_id: bare.id }, { gold_issue: goldIssue("2"), gold_receipt: goldReceipt("1") }),
        id: a.group.id,
      }),
    );
    expect(err).toBe("Required Touch is needed when receiving gold.");
    const g = await groupRow(a.group.id);
    expect(g.is_deleted).toBe(false);
    expect(g.reversed_by).toBeNull();

    // With the touch → edit saves on the same cycle and keeps its entry_no
    const u = await lb.updateLabourBill({
      ...bill(customerId, { bill_cycle_id: bare.id }, { gold_issue: goldIssue("2"), gold_receipt: goldReceipt("1") }, { required_touch: "90" }),
      id: a.group.id,
    });
    expect(u.cycle).toEqual({ id: bare.id, bill_no: 1, required_touch: "90.00", status: "OPEN" });
    expect(u.group.bill_cycle_id).toBe(bare.id);
    expect(u.group.entry_no).toBe(a.group.entry_no);
    expect((await groupRow(a.group.id)).is_deleted).toBe(true);
    expect((await liveBillsOf(customerId)).map((x) => x.id)).toEqual([u.group.id]);
  });

  it("editing a bill on a closed cycle stays allowed (touch update + close tick work there too)", async () => {
    const customerId = await newCustomer();
    const a = await lb.createLabourBill(
      bill(customerId, { new_cycle: true }, { gold_receipt: goldReceipt("2") }, { required_touch: "91.6", close_cycle: true }),
    );
    expect(a.cycle.status).toBe("DELIVERED");
    const u = await lb.updateLabourBill({
      ...bill(customerId, { bill_cycle_id: a.cycle.id }, { gold_receipt: goldReceipt("2.5") }, { required_touch: "93" }),
      id: a.group.id,
    });
    expect(u.cycle.status).toBe("DELIVERED");
    expect(Number(u.cycle.required_touch)).toBe(93);
    const r = await lb.updateLabourBill({
      ...bill(customerId, { bill_cycle_id: a.cycle.id }, { gold_receipt: goldReceipt("2.5") }, { close_cycle: false }),
      id: u.group.id,
    });
    expect(r.cycle.status).toBe("OPEN");
  });
});
