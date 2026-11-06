/**
 * Integration test: editing Job Work bills (latest AND older ones).
 *
 * Runs against a real Postgres. Point DATABASE_URL at a throwaway test database
 * before running — the guard below refuses anything that isn't a *_test DB.
 *
 *   DATABASE_URL='postgresql://.../goldcrm_fullcycle_test?...' \
 *     bun test --timeout 60000 src/modules/transactions/__tests__/jobWork.edit.test.ts
 *
 * Every test creates its own uniquely-named GOLDSMITH account, so it never touches
 * (or depends on) data written by anything else in the same database.
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
let svc: typeof import("../jobWork/service");
let balance: typeof import("@/lib/balance");
let entryNo: typeof import("@/lib/entryNoGenerator");
let orm: typeof import("drizzle-orm");

const RUN = `JWEDIT-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
const TODAY = new Date().toISOString().split("T")[0]!;
const PURITY = "92";
const RATE = "6000";

let goldItemId: string;

beforeAll(async () => {
  ({ db } = await import("@/db"));
  schema = await import("@/db/schema");
  svc = await import("../jobWork/service");
  balance = await import("@/lib/balance");
  entryNo = await import("@/lib/entryNoGenerator");
  orm = await import("drizzle-orm");

  // A dedicated GOLD item for this run
  goldItemId = await db.transaction(async (tx) => {
    const no = await entryNo.generateEntryNo(tx as any, "items", "GOLD");
    const [item] = await tx
      .insert(schema.items)
      .values({ entry_no: no, name: `${RUN} Gold`, type: "GOLD", unit: "GRAM", touch: PURITY })
      .returning();
    return item!.id;
  });
});

// ─── helpers ──────────────────────────────────────────────────────────────────

let acctSeq = 0;
async function newGoldsmith(): Promise<{ accountId: string; cycleId: string }> {
  const name = `${RUN} Smith ${++acctSeq}`;
  const accountId = await db.transaction(async (tx) => {
    const no = await entryNo.generateEntryNo(tx as any, "accounts", "GOLDSMITH");
    const [acc] = await tx
      .insert(schema.accounts)
      .values({ entry_no: no, name, type: "GOLDSMITH" })
      .returning();
    return acc!.id;
  });
  const cycle = await svc.createCycle({ account_id: accountId, main_reason: RUN });
  return { accountId, cycleId: cycle.id };
}

function jobWorkInput(accountId: string, cycleId: string, grams: string) {
  return {
    account_id: accountId,
    bill_cycle_id: cycleId,
    date: TODAY,
    rate_per_gram: RATE,
    remarks: RUN,
    // No lot_id → no stock check; SHOP may go negative by design.
    gold_issue: [{ item_id: goldItemId, quantity: grams, purity: PURITY }],
    gold_receipt: [],
    ornament_issue: [],
    ornament_receipt: [],
    cash_conversions: [],
  };
}

/** Pure grams the account receives for a gold issue of `grams` at PURITY. */
const pureOf = (grams: number) => Number((grams * Number(PURITY) / 100).toFixed(3));

async function groupRow(id: string) {
  const [g] = await db
    .select()
    .from(schema.entryGroups)
    .where(orm.eq(schema.entryGroups.id, id))
    .limit(1);
  return g!;
}

/** Exact (microsecond) DB timestamp text — JS Date would hide sub-ms differences. */
async function rawCreatedAt(id: string): Promise<string> {
  const rows = await db.execute<{ ts: string }>(
    orm.sql`SELECT created_at::text AS ts FROM entry_groups WHERE id = ${id}`,
  );
  return rows[0]!.ts;
}

async function pureBalance(accountId: string): Promise<number> {
  const b = await balance.getAggregateBalances(accountId);
  return Number(b.balancePure.toFixed(3));
}

async function liveJobWorkGroups(accountId: string) {
  return db
    .select()
    .from(schema.entryGroups)
    .where(
      orm.and(
        orm.eq(schema.entryGroups.account_id, accountId),
        orm.eq(schema.entryGroups.type, "JOB_WORK"),
        orm.eq(schema.entryGroups.is_deleted, false),
      ),
    );
}

// ─── tests ────────────────────────────────────────────────────────────────────

describe("updateJobWork", () => {
  it("1. edit latest bill: old version reversed, new keeps bill_no/entry_no, balance = new weight only", async () => {
    const { accountId, cycleId } = await newGoldsmith();

    const { group: orig } = await svc.createJobWork(jobWorkInput(accountId, cycleId, "10"));
    expect(await pureBalance(accountId)).toBe(pureOf(10));

    const { group: edited } = await svc.updateJobWork({
      ...jobWorkInput(accountId, cycleId, "12.5"),
      id: orig.id,
    });

    const old = await groupRow(orig.id);
    expect(old.is_deleted).toBe(true);
    expect(old.reversed_by).not.toBeNull();

    const reversal = await groupRow(old.reversed_by!);
    expect(reversal.type).toBe("REVERSAL");
    expect(reversal.reversal_of).toBe(orig.id);

    expect(edited.id).not.toBe(orig.id);
    expect(edited.bill_no).toBe(orig.bill_no);
    expect(edited.entry_no).toBe(orig.entry_no);
    expect(edited.job_work_cycle_id).toBe(cycleId);

    expect(await pureBalance(accountId)).toBe(pureOf(12.5));
  });

  it("2. edit an OLD bill: keeps its original timestamp/position and later bill's opening follows", async () => {
    const { accountId, cycleId } = await newGoldsmith();

    const { group: a } = await svc.createJobWork(jobWorkInput(accountId, cycleId, "10"));
    await Bun.sleep(1200); // guarantee clearly distinct created_at
    const { group: b } = await svc.createJobWork(jobWorkInput(accountId, cycleId, "5"));

    // Before the edit, B opens with A's pure
    const bBefore = await svc.getJobWorkById({ id: b.id });
    expect(Number(Number(bBefore.openingPure).toFixed(3))).toBe(pureOf(10));

    const aRawBefore = await rawCreatedAt(a.id);
    const { group: a2 } = await svc.updateJobWork({
      ...jobWorkInput(accountId, cycleId, "20"),
      id: a.id,
    });

    // New A carries the original A timestamp and still sits before B
    const a2Row = await groupRow(a2.id);
    expect(new Date(a2Row.created_at).getTime()).toBe(new Date(a.created_at).getTime());
    expect(new Date(a2Row.created_at).getTime()).toBeLessThan(new Date(b.created_at).getTime());
    expect(a2Row.bill_no).toBe(a.bill_no);
    expect(a2Row.entry_no).toBe(a.entry_no);

    // listJobWork is newest-first → B must come before (i.e. A after) in the list
    const list = await svc.listJobWork({ page: 1, limit: 100 });
    const ids = list.data.map((d) => d.group.id);
    const iA = ids.indexOf(a2.id);
    const iB = ids.indexOf(b.id);
    expect(iA).toBeGreaterThanOrEqual(0);
    expect(iB).toBeGreaterThanOrEqual(0);
    expect(ids).not.toContain(a.id); // old version hidden
    expect(iB).toBeLessThan(iA); // A is older than B

    // B's opening now reflects the edited A (20g), not the old 10g, nor both
    const bAfter = await svc.getJobWorkById({ id: b.id });
    expect(Number(Number(bAfter.openingPure).toFixed(3))).toBe(pureOf(20));
    const bInList = list.data.find((d) => d.group.id === b.id)!;
    expect(Number(Number(bInList.openingPure).toFixed(3))).toBe(pureOf(20));

    // Final balance = edited A + B
    expect(await pureBalance(accountId)).toBe(Number((pureOf(20) + pureOf(5)).toFixed(3)));

    // Diagnostic info for the precision check in test 4
    (globalThis as any).__jwEdit = { accountId, aId: a.id, a2Id: a2.id, aRawBefore };
  });

  it("3. nothing doubled: repeated edits leave exactly one live bill and the exact balance", async () => {
    const { accountId, cycleId } = await newGoldsmith();

    const { group: g1 } = await svc.createJobWork(jobWorkInput(accountId, cycleId, "8"));
    const { group: g2 } = await svc.updateJobWork({ ...jobWorkInput(accountId, cycleId, "9"), id: g1.id });
    const { group: g3 } = await svc.updateJobWork({ ...jobWorkInput(accountId, cycleId, "7.25"), id: g2.id });

    const live = await liveJobWorkGroups(accountId);
    expect(live.map((g) => g.id)).toEqual([g3.id]);

    // Exactly the last version — no leftovers from 8g or 9g
    expect(await pureBalance(accountId)).toBe(pureOf(7.25));

    // Raw ledger sum agrees (independent of balance.ts)
    const rows = await db.execute<{ net: string }>(orm.sql`
      SELECT COALESCE(SUM(CASE WHEN to_account_id = ${accountId} THEN pure_quantity
                               WHEN from_account_id = ${accountId} THEN -pure_quantity END), 0)::text AS net
      FROM entries WHERE to_account_id = ${accountId} OR from_account_id = ${accountId}
    `);
    expect(Number(Number(rows[0]!.net).toFixed(3))).toBe(pureOf(7.25));

    // The edited bill's own opening is 0 (old version + its reversal cancel out)
    const view = await svc.getJobWorkById({ id: g3.id });
    expect(Number(view.openingPure)).toBe(0);
  });

  it("4. edited old bill: exact DB timestamp preserved and its own opening unaffected", async () => {
    const info = (globalThis as any).__jwEdit as
      | { accountId: string; aId: string; a2Id: string; aRawBefore: string }
      | undefined;
    expect(info).toBeDefined();

    // Microsecond-exact: if the original timestamp is truncated to ms on re-insert,
    // the old version sorts AFTER its own reversal + new version.
    const a2Raw = await rawCreatedAt(info!.a2Id);
    expect(a2Raw).toBe(info!.aRawBefore);

    // Opening of the edited A must be 0 (it is the account's first bill)
    const view = await svc.getJobWorkById({ id: info!.a2Id });
    expect(Number(view.openingPure)).toBe(0);
  });
});

// ─── Required Touch % on the job-work Bill Cycle (owner, 2026-11-06) ─────────

async function errorOf(p: PromiseLike<unknown>): Promise<string | null> {
  try {
    await p;
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

async function cycleTouch(cycleId: string): Promise<string | null> {
  const [c] = await db
    .select({ required_touch: schema.jobWorkCycles.required_touch })
    .from(schema.jobWorkCycles)
    .where(orm.eq(schema.jobWorkCycles.id, cycleId))
    .limit(1);
  return c!.required_touch;
}

const TOUCH_NEEDED = "Required Touch % is needed when the bill has a Gold or Ornament Receipt.";
const receipt = (grams: string, purity = PURITY) => ({
  gold_receipt: [{ item_id: goldItemId, quantity: grams, purity }],
});

describe("job-work cycle Required Touch %", () => {
  it("5. createCycle stores an optional touch; listCycles / getCycleDetail return it", async () => {
    const { accountId, cycleId } = await newGoldsmith(); // created without a touch
    expect(await cycleTouch(cycleId)).toBeNull();

    const withTouch = await svc.createCycle({ account_id: accountId, main_reason: RUN, required_touch: "91.6" });
    expect(Number(withTouch.required_touch)).toBe(91.6);
    const blank = await svc.createCycle({ account_id: accountId, main_reason: RUN, required_touch: "" });
    expect(blank.required_touch).toBeNull();

    const listed = await svc.listCycles({ account_id: accountId });
    expect(Number(listed.find((c) => c.id === withTouch.id)!.required_touch)).toBe(91.6);
    const detail = await svc.getCycleDetail({ cycle_id: withTouch.id });
    expect(Number(detail.cycle.required_touch)).toBe(91.6);
  });

  it("6. a receipt needs a touch (form or cycle); no receipt → no touch needed", async () => {
    const { accountId, cycleId } = await newGoldsmith();

    // Issue only: fine without a touch
    await svc.createJobWork(jobWorkInput(accountId, cycleId, "10"));

    // Gold Receipt / Ornament Receipt with no touch anywhere → refused
    expect(await errorOf(svc.createJobWork({ ...jobWorkInput(accountId, cycleId, "1"), ...receipt("2") }))).toBe(TOUCH_NEEDED);
    expect(
      await errorOf(svc.createJobWork({
        ...jobWorkInput(accountId, cycleId, "1"),
        ornament_receipt: [{ item_id: goldItemId, quantity: "2", purity: PURITY, wastage_percent: "0" }],
        required_touch: "  ",
      })),
    ).toBe(TOUCH_NEEDED);
    expect(await cycleTouch(cycleId)).toBeNull();

    // Form gives the touch → saved and stored on the cycle
    await svc.createJobWork({ ...jobWorkInput(accountId, cycleId, "1"), ...receipt("2"), required_touch: "91.6" });
    expect(await cycleTouch(cycleId)).toBe("91.60");

    // Next bill: the cycle's stored touch is enough
    await svc.createJobWork({ ...jobWorkInput(accountId, cycleId, "1"), ...receipt("1") });

    // A different touch on the form updates the cycle
    await svc.createJobWork({ ...jobWorkInput(accountId, cycleId, "1"), ...receipt("1"), required_touch: "92.5" });
    expect(await cycleTouch(cycleId)).toBe("92.50");

    // A receipt BELOW the touch is never refused (frontend warning only)
    await svc.createJobWork({ ...jobWorkInput(accountId, cycleId, "1"), ...receipt("1", "80") });
  });

  it("7. edit refused for a missing touch leaves the stored job work untouched", async () => {
    const { accountId, cycleId } = await newGoldsmith();
    const { group: orig } = await svc.createJobWork(jobWorkInput(accountId, cycleId, "10"));
    const before = await pureBalance(accountId);

    const err = await errorOf(svc.updateJobWork({ ...jobWorkInput(accountId, cycleId, "10"), ...receipt("3"), id: orig.id }));
    expect(err).toBe(TOUCH_NEEDED);

    const stored = await groupRow(orig.id);
    expect(stored.is_deleted).toBe(false);
    expect(stored.reversed_by).toBeNull();
    expect((await liveJobWorkGroups(accountId)).map((g) => g.id)).toEqual([orig.id]);
    expect(await pureBalance(accountId)).toBe(before);
    expect(await cycleTouch(cycleId)).toBeNull();

    // With a touch the same edit goes through and the cycle keeps it
    const { group: edited } = await svc.updateJobWork({
      ...jobWorkInput(accountId, cycleId, "10"), ...receipt("3"), required_touch: "91.6", id: orig.id,
    });
    expect(edited.bill_no).toBe(orig.bill_no);
    expect(await cycleTouch(cycleId)).toBe("91.60");
  });
});
