// Integration test: editing a goldsmith's labour bills (latest AND older ones).
// Runs against a real Postgres DB — set DATABASE_URL to a throwaway test DB.
//   DATABASE_URL='...' bun test --timeout 60000 src/modules/transactions/__tests__/labourBill.edit.test.ts
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { accounts, entryGroups, items } from "@/db/schema";
import { getAggregateBalances } from "@/lib/balance";
import {
  createCycle,
  createLabourBill,
  getLabourBillById,
  updateLabourBill,
} from "../labourBill/service";

const RUN = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const DATE = "2026-11-04";

let goldItemId: string;

function uniqueEntryNo() {
  // High range so we never collide with real/seeded entry numbers.
  return 800_000_000 + Math.floor(Math.random() * 100_000_000);
}

async function makeGoldsmith(label: string) {
  const [acc] = await db
    .insert(accounts)
    .values({
      entry_no: uniqueEntryNo(),
      name: `LB-Edit-Test ${label} ${RUN}`,
      type: "GOLDSMITH",
      customer_type: "GOLD_SMITH",
    })
    .returning();
  const cycle = await createCycle({ account_id: acc!.id, main_reason: "edit test" });
  return { accountId: acc!.id, cycleId: cycle.id };
}

// bun 1.3.14's `expect(promise).rejects` hung on these DB-backed rejections, so
// capture the error by hand instead.
async function errorOf(p: Promise<unknown>): Promise<string | null> {
  try {
    await p;
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/** Exact (microsecond) DB timestamp text — JS Date would hide sub-ms differences. */
async function rawCreatedAt(id: string): Promise<string> {
  const rows = await db.execute<{ ts: string }>(
    sql`SELECT created_at::text AS ts FROM entry_groups WHERE id = ${id}`,
  );
  return rows[0]!.ts;
}

async function getGroup(id: string) {
  const [g] = await db.select().from(entryGroups).where(eq(entryGroups.id, id)).limit(1);
  return g!;
}

function billInput(
  gs: { accountId: string; cycleId: string },
  opts: { qty: string; purity?: string; rate?: string; bankPaid?: string },
) {
  return {
    account_id: gs.accountId,
    date: DATE,
    rate_per_gram: opts.rate ?? "6000",
    bill_cycle_id: gs.cycleId,
    gold_issue: [{ item_id: goldItemId, quantity: opts.qty, purity: opts.purity ?? "92" }],
    gold_receipt: [],
    ornament_issue: [],
    ornament_receipt: [],
    cash_conversions: [],
    ...(opts.bankPaid ? { bank_paid: opts.bankPaid } : {}),
  };
}

beforeAll(async () => {
  const url = process.env.DATABASE_URL ?? "";
  // Hard guard: never run against production.
  if (!url.includes("goldcrm_fullcycle_test")) {
    throw new Error(`Refusing to run: DATABASE_URL is not the throwaway test DB (${url.split("@")[1] ?? "?"})`);
  }
  const [item] = await db
    .insert(items)
    .values({
      entry_no: uniqueEntryNo(),
      name: `LB-Edit Gold ${RUN}`.slice(0, 100),
      type: "GOLD",
      unit: "GRAM",
      touch: "92",
    })
    .returning();
  goldItemId = item!.id;
});

describe("Labour Bill edit (latest and older bills)", () => {
  it("1. edit gold_issue weight: old group reversed, numbers kept, balance = new weight only", async () => {
    const gs = await makeGoldsmith("case1");
    const created = await createLabourBill(billInput(gs, { qty: "10" }));
    const oldId = created.group.id;

    // 10g @ 92 = 9.2 pure
    let bal = await getAggregateBalances(gs.accountId);
    expect(bal.totalPure.toFixed(3)).toBe("9.200");

    const updated = await updateLabourBill({ id: oldId, ...billInput(gs, { qty: "15" }) });

    const oldGroup = await getGroup(oldId);
    expect(oldGroup.is_deleted).toBe(true);
    expect(oldGroup.reversed_by).not.toBeNull();

    const revGroup = await getGroup(oldGroup.reversed_by!);
    expect(revGroup.type).toBe("REVERSAL");
    expect(revGroup.reversal_of).toBe(oldId);

    expect(updated.group.id).not.toBe(oldId);
    expect(updated.group.bill_no).toBe(created.group.bill_no);
    expect(updated.group.entry_no).toBe(created.group.entry_no);
    expect(updated.group.bill_cycle_id).toBe(gs.cycleId);
    expect(updated.group.is_deleted).toBe(false);

    // 15g @ 92 = 13.8 pure — only the new version counts
    bal = await getAggregateBalances(gs.accountId);
    expect(bal.totalPure.toFixed(3)).toBe("13.800");
    expect(bal.totalCash.toFixed(2)).toBe("0.00");

    // Old bill no longer readable; new one is
    expect(await errorOf(getLabourBillById({ id: oldId }))).toBe("Labour bill not found");
    const fetched = await getLabourBillById({ id: updated.group.id });
    expect(fetched.entries.length).toBe(1);
    expect(Number(fetched.entries[0]!.entry.quantity)).toBe(15);
  });

  it("2. edit twice in a row: second edit reverses the first edited version, no doubling", async () => {
    const gs = await makeGoldsmith("case2");
    const v0 = await createLabourBill(billInput(gs, { qty: "10", bankPaid: "1000" }));
    const v1 = await updateLabourBill({ id: v0.group.id, ...billInput(gs, { qty: "20", bankPaid: "2000" }) });
    const v2 = await updateLabourBill({ id: v1.group.id, ...billInput(gs, { qty: "5", bankPaid: "500" }) });

    const g0 = await getGroup(v0.group.id);
    const g1 = await getGroup(v1.group.id);
    const g2 = await getGroup(v2.group.id);
    expect(g0.is_deleted).toBe(true);
    expect(g0.reversed_by).not.toBeNull();
    expect(g1.is_deleted).toBe(true);
    expect(g1.reversed_by).not.toBeNull();
    expect(g1.reversed_by).not.toBe(g0.reversed_by);
    expect(g2.is_deleted).toBe(false);
    expect(g2.reversed_by).toBeNull();

    expect(g2.bill_no).toBe(v0.group.bill_no);
    expect(g2.entry_no).toBe(v0.group.entry_no);

    // Latest only: 5g @ 92 = 4.6 pure; bank_paid 500 (SHOP → goldsmith)
    const bal = await getAggregateBalances(gs.accountId);
    expect(bal.totalPure.toFixed(3)).toBe("4.600");
    expect(bal.totalCash.toFixed(2)).toBe("500.00");

    // Re-editing an already-reversed version must be refused
    expect(
      await errorOf(updateLabourBill({ id: v1.group.id, ...billInput(gs, { qty: "7" }) })),
    ).toBe("Transaction already reversed");
    const after = await getAggregateBalances(gs.accountId);
    expect(after.totalPure.toFixed(3)).toBe("4.600");
  });

  it("3. edit rate_per_gram / bank_paid: new group stores new rate, cash balance correct", async () => {
    const gs = await makeGoldsmith("case3");
    const v0 = await createLabourBill(billInput(gs, { qty: "10", rate: "6000", bankPaid: "3000" }));
    expect(Number(v0.group.rate_per_gram)).toBe(6000);

    let bal = await getAggregateBalances(gs.accountId);
    expect(bal.totalCash.toFixed(2)).toBe("3000.00");

    const v1 = await updateLabourBill({
      id: v0.group.id,
      ...billInput(gs, { qty: "10", rate: "6500", bankPaid: "4500" }),
    });

    const g1 = await getGroup(v1.group.id);
    expect(Number(g1.rate_per_gram)).toBe(6500);
    expect(g1.bill_no).toBe(v0.group.bill_no);
    expect(g1.entry_no).toBe(v0.group.entry_no);

    bal = await getAggregateBalances(gs.accountId);
    expect(bal.totalCash.toFixed(2)).toBe("4500.00");
    expect(bal.totalPure.toFixed(3)).toBe("9.200");

    // Reversal carried the OLD rate so the old bill's gold value cancels out:
    // net gold-cash = new bill only (9.2 pure × 6500 into the goldsmith).
    expect(bal.goldCashIn.minus(bal.goldCashOut).toFixed(2)).toBe("59800.00");

    const fetched = await getLabourBillById({ id: v1.group.id });
    expect(Number(fetched.group.rate_per_gram)).toBe(6500);
    const rupee = fetched.entries.filter((e) => e.item_type === "MONEY");
    expect(rupee.length).toBe(1);
    expect(Number(rupee[0]!.entry.quantity)).toBe(4500);
  });

  it("4. edit an OLD bill: keeps its exact timestamp/position, later bill's opening follows", async () => {
    const gs = await makeGoldsmith("case4");
    const a = await createLabourBill(billInput(gs, { qty: "10", bankPaid: "1000" }));
    await Bun.sleep(1200); // clearly distinct created_at
    const b = await createLabourBill(billInput(gs, { qty: "5" }));

    // Before the edit B opens with A: 10g @ 92 = 9.2 pure, 1000 cash
    const bBefore = await getLabourBillById({ id: b.group.id });
    expect(Number(bBefore.openingPure).toFixed(3)).toBe("9.200");
    expect(Number(bBefore.openingCash).toFixed(2)).toBe("1000.00");

    const aRawBefore = await rawCreatedAt(a.group.id);
    const a2 = await updateLabourBill({
      id: a.group.id,
      ...billInput(gs, { qty: "20", bankPaid: "2500" }),
    });

    // Reversal AND new version carry A's exact (microsecond) DB timestamp,
    // so the edited bill stays before B.
    const a2Raw = await rawCreatedAt(a2.group.id);
    const oldA = await getGroup(a.group.id);
    const revRaw = await rawCreatedAt(oldA.reversed_by!);
    expect(a2Raw).toBe(aRawBefore);
    expect(revRaw).toBe(aRawBefore);
    expect(new Date(a2.group.created_at).getTime()).toBeLessThan(new Date(b.group.created_at).getTime());
    expect(a2.group.bill_no).toBe(a.group.bill_no);
    expect(a2.group.entry_no).toBe(a.group.entry_no);

    // Entries of the new version and the reversal are backdated too
    const entryTs = await db.execute<{ ts: string }>(sql`
      SELECT DISTINCT created_at::text AS ts FROM entries
      WHERE group_id IN (${a2.group.id}, ${oldA.reversed_by!})
    `);
    expect(entryTs.map((r) => r.ts)).toEqual([aRawBefore]);

    // B's opening now reflects the edited A (20g → 18.4 pure, 2500 cash), not both
    const bAfter = await getLabourBillById({ id: b.group.id });
    expect(Number(bAfter.openingPure).toFixed(3)).toBe("18.400");
    expect(Number(bAfter.openingCash).toFixed(2)).toBe("2500.00");

    // Edited A is the goldsmith's first bill → opening 0 (old + reversal cancel)
    const aView = await getLabourBillById({ id: a2.group.id });
    expect(Number(aView.openingPure)).toBe(0);
    expect(Number(aView.openingCash)).toBe(0);

    // Final balance = edited A + B
    const bal = await getAggregateBalances(gs.accountId);
    expect(bal.totalPure.toFixed(3)).toBe("23.000");
    expect(bal.totalCash.toFixed(2)).toBe("2500.00");
  });
});

afterAll(async () => {
  // Close the postgres.js pool so the test process can exit.
  await (db as unknown as { $client?: { end?: (o?: { timeout?: number }) => Promise<void> } }).$client?.end?.({ timeout: 5 });
});
