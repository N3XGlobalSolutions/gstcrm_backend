import "@/__tests__/fullcycle/guard";
// Full-cycle integration test: MELTING register + EXPENSE bills.
// Runs against a throwaway "*_test" Postgres DB only (the guard above refuses
// anything else). Service functions are called directly; zod schemas are run
// first so inputs look exactly like what the router hands the service.
import { beforeAll, describe, expect, it } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { accounts, entryGroups, items, meltingEntries } from "@/db/schema";
import { SYSTEM_ACCOUNTS, SYSTEM_ITEMS } from "@/config/constants";
import { getBalance } from "@/lib/balance";
import { createEntryGroup } from "@/lib/entryBuilder";
import { getGoldStock } from "@/modules/stock/router";
import {
  createMelting,
  createMetal,
  deleteMelting,
  getMeltingById,
  listMelting,
  updateMelting,
} from "@/modules/melting/service";
import { CreateMeltingSchema, UpdateMeltingSchema } from "@/modules/melting/schema";
import {
  createExpense,
  deleteExpense,
  getExpenseById,
  listExpenses,
  updateExpense,
} from "../../expense/service";
import { CreateExpenseSchema, UpdateExpenseSchema } from "../../expense/schema";

const RUN = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const DATE = "2026-11-10";
const SHOP = SYSTEM_ACCOUNTS.SHOP_ID;
const LOSS = SYSTEM_ACCOUNTS.LOSS_ID;
const CASH = SYSTEM_ACCOUNTS.CASH_ID;
const BANK = SYSTEM_ACCOUNTS.BANK_ID;
const RUPEE = SYSTEM_ITEMS.RUPEE_ITEM_ID;

let copperId: string;
let silverId: string;

// ─── helpers ─────────────────────────────────────────────────────────────────

function uniqueEntryNo() {
  return 800_000_000 + Math.floor(Math.random() * 100_000_000);
}

// bun's `expect(promise).rejects` hung on DB-backed rejections — capture by hand.
async function errorOf(p: Promise<unknown>): Promise<string | null> {
  try {
    await p;
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

async function makeItem(label: string, type: "GOLD" | "ORNAMENT", touch = "92") {
  const [row] = await db
    .insert(items)
    .values({
      entry_no: uniqueEntryNo(),
      name: `Melt-FT ${label} ${RUN}`.slice(0, 100),
      type,
      unit: "GRAM",
      touch,
    })
    .returning();
  return row!.id;
}

/** Opening stock into SHOP. Returns the lot id (auto-generated for ornaments). */
async function openStock(itemId: string, qty: string, touch: string): Promise<string | null> {
  const { entries } = await createEntryGroup({
    type: "OPENING",
    accountId: SYSTEM_ACCOUNTS.OPENING_STOCK_ID,
    date: DATE,
    remarks: `melt-ft opening ${RUN}`,
    entries: [
      {
        fromAccountId: SYSTEM_ACCOUNTS.OPENING_STOCK_ID,
        toAccountId: SHOP,
        itemId,
        quantity: qty,
        purity: touch,
      },
    ],
  });
  return entries[0]!.lot_id ?? null;
}

/** SHOP net weight of one gold stock row (item + touch) — same rule as the service. */
async function goldRow(itemId: string, touch: string): Promise<string> {
  const [row] = await db.execute<{ q: string }>(
    sql`SELECT COALESCE(SUM(CASE WHEN to_account_id = ${SHOP} THEN quantity ELSE -quantity END), 0)::numeric(20,3)::text AS q
        FROM entries
        WHERE item_id = ${itemId}
          AND COALESCE(purity, 0) = ${touch}::numeric
          AND (to_account_id = ${SHOP} OR from_account_id = ${SHOP})`,
  );
  return row!.q;
}

/** SHOP net weight of one ornament lot. */
async function lotRow(itemId: string, lotId: string): Promise<string> {
  const [row] = await db.execute<{ q: string }>(
    sql`SELECT COALESCE(SUM(CASE WHEN to_account_id = ${SHOP} THEN quantity ELSE -quantity END), 0)::numeric(20,3)::text AS q
        FROM entries
        WHERE item_id = ${itemId} AND lot_id = ${lotId}
          AND (to_account_id = ${SHOP} OR from_account_id = ${SHOP})`,
  );
  return row!.q;
}

async function bal(accountId: string, itemId: string) {
  return (await getBalance(accountId, itemId)).toFixed(3);
}

type LineIn = { item_id: string; weight: string; touch: string; lot_id?: string | null };

function meltInput(opts: {
  lines: LineIn[];
  required_touch?: string | null;
  alloys?: { metal_id: string; share_percent: string }[];
  output_item_id?: string | null;
  after_weight?: string | null;
  out_touch?: string | null;
  remarks?: string;
}) {
  return {
    date: DATE,
    remarks: opts.remarks ?? `melt-ft ${RUN}`,
    required_touch: opts.required_touch ?? null,
    alloys: opts.alloys ?? [],
    output_item_id: opts.output_item_id ?? null,
    after_weight: opts.after_weight ?? null,
    out_touch: opts.out_touch ?? null,
    lines: opts.lines.map((l) => ({ lot_id: null, ...l })),
  };
}

const create = (raw: object) => createMelting(CreateMeltingSchema.parse(raw));
const update = (id: string, raw: object) =>
  updateMelting(UpdateMeltingSchema.parse({ id, ...raw }));

function zodMessages(raw: unknown, update = false): string[] {
  const r = update ? UpdateMeltingSchema.safeParse(raw) : CreateMeltingSchema.safeParse(raw);
  return r.success ? [] : r.error.issues.map((i) => i.message);
}

async function meltingRow(id: string) {
  const [row] = await db.select().from(meltingEntries).where(eq(meltingEntries.id, id)).limit(1);
  return row!;
}

async function meltingCount() {
  const [row] = await db.execute<{ n: string }>(sql`SELECT count(*)::text AS n FROM melting_entries`);
  return Number(row!.n);
}

beforeAll(async () => {
  const c = await createMetal({ name: `Copper ${RUN}` });
  const s = await createMetal({ name: `Silver ${RUN}` });
  copperId = c.id;
  silverId = s.id;
});

// ─── MELTING ─────────────────────────────────────────────────────────────────

describe("Melting", () => {
  it("1. direct melting: lines leave stock, output enters stock at required touch, figures correct", async () => {
    const fine = await makeItem("fine-1", "GOLD", "99.5");
    const out = await makeItem("out-1", "GOLD", "92");
    await openStock(fine, "100", "99.5");
    expect(await goldRow(fine, "99.5")).toBe("100.000");

    // 100 g @ 99.5 → pure 99.500. Required 92 → final 99.5×100/92 = 108.152,
    // alloy 8.152 (copper 70% = 5.706, silver 30% = 2.446). Expected 108.152.
    // After 107.5 → loss 0.652; pure out 107.5×0.92 = 98.900 → pure loss 0.600.
    const { id, entry_no } = await create(
      meltInput({
        lines: [{ item_id: fine, weight: "100", touch: "99.5" }],
        required_touch: "92",
        alloys: [
          { metal_id: copperId, share_percent: "70" },
          { metal_id: silverId, share_percent: "30" },
        ],
        output_item_id: out,
        after_weight: "107.5",
      }),
    );
    expect(entry_no).toBeGreaterThan(0);

    const m = await getMeltingById(id);
    expect(m.is_pending).toBe(false);
    expect(m.current_weight).toBe("100.000");
    expect(m.current_pure).toBe("99.500");
    expect(Number(m.required_touch)).toBe(92);
    expect(Number(m.final_weight)).toBe(108.152);
    expect(Number(m.alloy_total)).toBe(8.152);
    expect(m.alloys.map((a) => Number(a.grams))).toEqual([5.706, 2.446]);
    expect(Number(m.expected_weight)).toBe(108.152);
    expect(Number(m.after_weight)).toBe(107.5);
    expect(Number(m.out_touch)).toBe(92);
    expect(Number(m.loss_weight)).toBe(0.652);
    expect(Number(m.pure_loss)).toBe(0.6);
    expect(m.output_item_id).toBe(out);
    expect(m.lines.length).toBe(1);
    expect(Number(m.lines[0]!.pure)).toBe(99.5);

    // Stock: fine gold row emptied, melted gold appears at touch 92.
    expect(await goldRow(fine, "99.5")).toBe("0.000");
    expect(await goldRow(out, "92")).toBe("107.500");
    expect(await bal(SHOP, out)).toBe("107.500");
    // LOSS account holds the furnace difference per item.
    expect(await bal(LOSS, fine)).toBe("100.000");
    expect(await bal(LOSS, out)).toBe("-107.500");

    // The MELTING ledger group is posted against LOSS.
    const row = await meltingRow(id);
    const [g] = await db.select().from(entryGroups).where(eq(entryGroups.id, row.entry_group_id!));
    expect(g!.type).toBe("MELTING");
    expect(g!.account_id).toBe(LOSS);
    expect(g!.is_deleted).toBe(false);
  });

  it("2. pending melting: lines leave stock, nothing comes back; receiving later puts the output in stock", async () => {
    const gold = await makeItem("std-2", "GOLD", "91.6");
    const out = await makeItem("out-2", "GOLD", "91.6");
    await openStock(gold, "50", "91.6");

    const pendingInput = meltInput({ lines: [{ item_id: gold, weight: "50", touch: "91.6" }] });
    const { id } = await create(pendingInput);

    let m = await getMeltingById(id);
    expect(m.is_pending).toBe(true);
    expect(m.output_item_id).toBeNull();
    expect(m.after_weight).toBeNull();
    expect(m.loss_weight).toBeNull();
    expect(m.pure_loss).toBeNull();
    expect(await goldRow(gold, "91.6")).toBe("0.000");
    expect(await bal(SHOP, out)).toBe("0.000");
    // Gold is "in the furnace" (sitting in LOSS).
    expect(await bal(LOSS, gold)).toBe("50.000");

    const pendingList = await listMelting({ page: 1, limit: 100, status: "pending" });
    expect(pendingList.data.some((r) => r.id === id)).toBe(true);

    // Receive: no required touch, no out_touch → out touch = current touch 91.60.
    // pure 45.800; pure out 45.5×0.916 = 41.678 → pure loss 4.122; loss 4.500.
    const res = await update(id, { ...pendingInput, output_item_id: out, after_weight: "45.5" });
    expect(res.id).toBe(id);

    m = await getMeltingById(id);
    expect(m.is_pending).toBe(false);
    expect(Number(m.out_touch)).toBe(91.6);
    expect(Number(m.expected_weight)).toBe(50);
    expect(Number(m.loss_weight)).toBe(4.5);
    expect(Number(m.pure_loss)).toBe(4.122);

    expect(await goldRow(gold, "91.6")).toBe("0.000");
    expect(await goldRow(out, "91.6")).toBe("45.500");
    expect(await bal(LOSS, gold)).toBe("50.000");
    expect(await bal(LOSS, out)).toBe("-45.500");

    const received = await listMelting({ page: 1, limit: 100, status: "received" });
    expect(received.data.some((r) => r.id === id)).toBe(true);
    const stillPending = await listMelting({ page: 1, limit: 100, status: "pending" });
    expect(stillPending.data.some((r) => r.id === id)).toBe(false);
  });

  it("3. received BELOW required touch (91.60 → 90) saves; stock row is at 90; pure loss uses 90", async () => {
    const fine = await makeItem("fine-3", "GOLD", "99.5");
    const out = await makeItem("out-3", "GOLD", "91.6");
    await openStock(fine, "20", "99.5");

    // pure 19.900; final 19.9×100/91.6 = 21.725, alloy 1.725, expected 21.725.
    // after 21.5 → loss 0.225; pure out 21.5×0.90 = 19.350 → pure loss 0.550.
    const { id } = await create(
      meltInput({
        lines: [{ item_id: fine, weight: "20", touch: "99.5" }],
        required_touch: "91.60",
        alloys: [{ metal_id: copperId, share_percent: "100" }],
        output_item_id: out,
        after_weight: "21.5",
        out_touch: "90",
      }),
    );

    const m = await getMeltingById(id);
    expect(Number(m.required_touch)).toBe(91.6);
    expect(m.out_touch).toBe("90.00");
    expect(Number(m.expected_weight)).toBe(21.725);
    expect(Number(m.loss_weight)).toBe(0.225);
    expect(Number(m.pure_loss)).toBe(0.55);

    expect(await goldRow(out, "90")).toBe("21.500");
    expect(await goldRow(out, "91.6")).toBe("0.000");

    // Stock page shows one row for the output item, at touch 90.000.
    const stock = await getGoldStock({ page: 1, limit: 100000 });
    const rows = stock.data.filter((r) => r.item.id === out);
    expect(rows.length).toBe(1);
    expect(rows[0]!.touch).toBe("90.000");
    expect(rows[0]!.balance).toBe("21.500");
    expect(rows[0]!.pure_balance).toBe("19.350");
  });

  it("4. out_touch blank falls back to the required touch", async () => {
    const fine = await makeItem("fine-4", "GOLD", "99.5");
    const out = await makeItem("out-4", "GOLD", "91.6");
    await openStock(fine, "20", "99.5");

    // pure out 21.5×0.916 = 19.694 → pure loss 19.900 − 19.694 = 0.206.
    const { id } = await create(
      meltInput({
        lines: [{ item_id: fine, weight: "20", touch: "99.5" }],
        required_touch: "91.6",
        output_item_id: out,
        after_weight: "21.5",
        out_touch: "",
      }),
    );
    const m = await getMeltingById(id);
    expect(m.out_touch).toBe("91.60");
    expect(Number(m.pure_loss)).toBe(0.206);
    expect(await goldRow(out, "91.6")).toBe("21.500");
  });

  it("5. alloy / receiving validations reject", async () => {
    const base = meltInput({
      lines: [{ item_id: copperId /* any uuid */, weight: "10", touch: "99.5" }],
    });

    // Shares must total 100.
    expect(
      zodMessages({
        ...base,
        required_touch: "92",
        alloys: [
          { metal_id: copperId, share_percent: "60" },
          { metal_id: silverId, share_percent: "30" },
        ],
      }),
    ).toContain("Metal shares must total 100%");
    // 33.33 + 33.33 + 33.34 is fine (within ±0.01).
    const thirdId = "22222222-2222-4222-8222-222222222222";
    expect(
      zodMessages({
        ...base,
        required_touch: "92",
        alloys: [
          { metal_id: copperId, share_percent: "33.33" },
          { metal_id: silverId, share_percent: "33.33" },
          { metal_id: thirdId, share_percent: "33.34" },
        ],
      }),
    ).toEqual([]);

    // Alloys need a required touch.
    expect(
      zodMessages({ ...base, alloys: [{ metal_id: copperId, share_percent: "100" }] }),
    ).toContain("Required touch is needed to add alloy metals");

    // Same metal twice.
    expect(
      zodMessages({
        ...base,
        required_touch: "92",
        alloys: [
          { metal_id: copperId, share_percent: "50" },
          { metal_id: copperId, share_percent: "50" },
        ],
      }),
    ).toContain("Each metal can be added only once");

    // Share out of range, received touch out of range, required touch 0.
    expect(zodMessages({ ...base, required_touch: "92", alloys: [{ metal_id: copperId, share_percent: "120" }] }))
      .toContain("Share % must be between 0 and 100");
    expect(zodMessages({ ...base, output_item_id: copperId, after_weight: "5", out_touch: "101" }))
      .toContain("Received touch must be greater than 0 and at most 100");
    expect(zodMessages({ ...base, required_touch: "0" }))
      .toContain("Required touch must be greater than 0 and at most 100");

    // Receiving side must be both-or-neither.
    expect(zodMessages({ ...base, output_item_id: copperId })).toContain("Enter the after melting weight");
    expect(zodMessages({ ...base, after_weight: "5" })).toContain("Select the output gold item");

    // Same rules on update.
    expect(
      zodMessages({ id: copperId, ...base, alloys: [{ metal_id: copperId, share_percent: "100" }] }, true),
    ).toContain("Required touch is needed to add alloy metals");

    // Service: unknown alloy metal, non-gold output item, ornament line without lot.
    const fine = await makeItem("fine-5", "GOLD", "99.5");
    const orn = await makeItem("orn-5", "ORNAMENT", "91.6");
    await openStock(fine, "10", "99.5");
    const before = await meltingCount();

    expect(
      await errorOf(
        create(
          meltInput({
            lines: [{ item_id: fine, weight: "10", touch: "99.5" }],
            required_touch: "92",
            alloys: [{ metal_id: "11111111-1111-4111-8111-111111111111", share_percent: "100" }],
          }),
        ),
      ),
    ).toBe("Selected metal no longer exists");
    expect(
      await errorOf(
        create(
          meltInput({
            lines: [{ item_id: fine, weight: "10", touch: "99.5" }],
            output_item_id: orn,
            after_weight: "9",
          }),
        ),
      ),
    ).toBe("Output item must be a Gold item");
    expect(
      await errorOf(create(meltInput({ lines: [{ item_id: orn, weight: "5", touch: "91.6" }] }))),
    ).toContain("Lot is required for ornament");

    // Nothing was saved and the stock is untouched.
    expect(await meltingCount()).toBe(before);
    expect(await goldRow(fine, "99.5")).toBe("10.000");
  });

  it("6. cannot melt more than the lot / stock row holds", async () => {
    const fine = await makeItem("fine-6", "GOLD", "99.5");
    const orn = await makeItem("orn-6", "ORNAMENT", "91.6");
    await openStock(fine, "10", "99.5");
    const lot = await openStock(orn, "15", "91.6");
    expect(lot).not.toBeNull();
    expect(await lotRow(orn, lot!)).toBe("15.000");
    const before = await meltingCount();

    // Gold: more than the row holds.
    const e1 = await errorOf(create(meltInput({ lines: [{ item_id: fine, weight: "10.5", touch: "99.5" }] })));
    expect(e1).toContain("Not enough stock");
    expect(e1).toContain("Available: 10.000 g, required: 10.500 g");

    // Gold: right item, wrong touch row (stock is at 99.5, not 92).
    const e2 = await errorOf(create(meltInput({ lines: [{ item_id: fine, weight: "1", touch: "92" }] })));
    expect(e2).toContain("Available: 0.000 g");

    // Ornament: more than the lot.
    const e3 = await errorOf(
      create(meltInput({ lines: [{ item_id: orn, lot_id: lot, weight: "16", touch: "91.6" }] })),
    );
    expect(e3).toContain(`lot ${lot}`);
    expect(e3).toContain("Available: 15.000 g, required: 16.000 g");

    // Two lines on the same lot are added up (8 + 8 = 16 > 15).
    const e4 = await errorOf(
      create(
        meltInput({
          lines: [
            { item_id: orn, lot_id: lot, weight: "8", touch: "91.6" },
            { item_id: orn, lot_id: lot, weight: "8", touch: "91.6" },
          ],
        }),
      ),
    );
    expect(e4).toContain("required: 16.000 g");

    expect(await meltingCount()).toBe(before);
    expect(await goldRow(fine, "99.5")).toBe("10.000");
    expect(await lotRow(orn, lot!)).toBe("15.000");

    // Exactly what's there is fine — ornament lot + gold together.
    const out = await makeItem("out-6", "GOLD", "91.6");
    const { id } = await create(
      meltInput({
        lines: [
          { item_id: orn, lot_id: lot, weight: "15", touch: "91.6" },
          { item_id: fine, weight: "10", touch: "99.5" },
        ],
        output_item_id: out,
        after_weight: "24.8",
      }),
    );
    expect(await lotRow(orn, lot!)).toBe("0.000");
    expect(await goldRow(fine, "99.5")).toBe("0.000");
    // pure 13.740 + 9.950 = 23.690 over 25 g → current touch 94.76.
    const m = await getMeltingById(id);
    expect(m.current_pure).toBe("23.690");
    expect(m.out_touch).toBe("94.76");
    expect(await goldRow(out, "94.76")).toBe("24.800");
    // Lot cannot be melted again.
    expect(
      await errorOf(create(meltInput({ lines: [{ item_id: orn, lot_id: lot, weight: "0.1", touch: "91.6" }] }))),
    ).toContain("Not enough stock");
  });

  it("7a. deleting a melting restores the input stock and removes the melted gold", async () => {
    const fine = await makeItem("fine-7a", "GOLD", "99.5");
    const out = await makeItem("out-7a", "GOLD", "92");
    await openStock(fine, "30", "99.5");

    const { id } = await create(
      meltInput({
        lines: [{ item_id: fine, weight: "30", touch: "99.5" }],
        required_touch: "92",
        output_item_id: out,
        after_weight: "32",
      }),
    );
    expect(await goldRow(fine, "99.5")).toBe("0.000");
    expect(await goldRow(out, "92")).toBe("32.000");
    const groupId = (await meltingRow(id)).entry_group_id!;

    expect(await deleteMelting(id)).toEqual({ success: true });
    expect(await goldRow(fine, "99.5")).toBe("30.000");
    expect(await goldRow(out, "92")).toBe("0.000");
    expect(await bal(LOSS, fine)).toBe("0.000");
    expect(await bal(LOSS, out)).toBe("0.000");

    const row = await meltingRow(id);
    expect(row.is_deleted).toBe(true);
    const [g] = await db.select().from(entryGroups).where(eq(entryGroups.id, groupId));
    expect(g!.is_deleted).toBe(true);
    expect(g!.reversed_by).not.toBeNull();

    expect(await errorOf(getMeltingById(id))).toBe("Melting entry not found");
    expect(await errorOf(deleteMelting(id))).toBe("Melting entry not found");

    // A pending melting can be deleted too.
    const { id: pid } = await create(meltInput({ lines: [{ item_id: fine, weight: "12", touch: "99.5" }] }));
    expect(await goldRow(fine, "99.5")).toBe("18.000");
    await deleteMelting(pid);
    expect(await goldRow(fine, "99.5")).toBe("30.000");
  });

  it("7b. editing a melting re-posts stock (old movement undone, new one applied)", async () => {
    const fine = await makeItem("fine-7b", "GOLD", "99.5");
    const outA = await makeItem("out-7b-A", "GOLD", "92");
    const outB = await makeItem("out-7b-B", "GOLD", "92");
    await openStock(fine, "40", "99.5");

    const first = meltInput({
      lines: [{ item_id: fine, weight: "10", touch: "99.5" }],
      required_touch: "92",
      output_item_id: outA,
      after_weight: "10.8",
    });
    const { id, entry_no } = await create(first);
    expect(await goldRow(fine, "99.5")).toBe("30.000");
    expect(await goldRow(outA, "92")).toBe("10.800");

    // Edit: take 25 g instead, receive into a different item at touch 90.
    // pure 24.875; final 24.875×100/92 = 27.038; after 27 → loss 0.038;
    // pure out 27×0.90 = 24.300 → pure loss 0.575.
    const res = await update(id, {
      ...first,
      lines: [{ item_id: fine, weight: "25", touch: "99.5" }],
      output_item_id: outB,
      after_weight: "27",
      out_touch: "90",
    });
    expect(res).toEqual({ id, entry_no });

    expect(await goldRow(fine, "99.5")).toBe("15.000");
    expect(await goldRow(outA, "92")).toBe("0.000");
    expect(await goldRow(outB, "90")).toBe("27.000");
    expect(await goldRow(outB, "92")).toBe("0.000");

    const m = await getMeltingById(id);
    expect(m.entry_no).toBe(entry_no);
    expect(Number(m.expected_weight)).toBe(27.038);
    expect(Number(m.loss_weight)).toBe(0.038);
    expect(Number(m.pure_loss)).toBe(0.575);
    expect(m.lines.length).toBe(1);
    expect(Number(m.lines[0]!.weight)).toBe(25);

    // Editing to more than stock + what this entry already holds is refused and
    // rolls back completely (15 free + 25 own = 40 max).
    const err = await errorOf(
      update(id, { ...first, lines: [{ item_id: fine, weight: "40.5", touch: "99.5" }], output_item_id: outB, after_weight: "27", out_touch: "90" }),
    );
    expect(err).toContain("Not enough stock");
    expect(await goldRow(fine, "99.5")).toBe("15.000");
    expect(await goldRow(outB, "90")).toBe("27.000");

    // Only one live MELTING group for the entry.
    const live = await db
      .select({ id: entryGroups.id })
      .from(entryGroups)
      .where(and(eq(entryGroups.type, "MELTING"), eq(entryGroups.entry_no, entry_no), eq(entryGroups.is_deleted, false)));
    expect(live.length).toBe(1);
  });

  it("7c. melted gold already used: delete/edit of the first melting is refused", async () => {
    const fine = await makeItem("fine-7c", "GOLD", "99.5");
    const out1 = await makeItem("out-7c-1", "GOLD", "92");
    const out2 = await makeItem("out-7c-2", "GOLD", "91.6");
    await openStock(fine, "50", "99.5");

    const firstInput = meltInput({
      lines: [{ item_id: fine, weight: "50", touch: "99.5" }],
      required_touch: "92",
      output_item_id: out1,
      after_weight: "54",
    });
    const { id: firstId } = await create(firstInput);
    expect(await goldRow(out1, "92")).toBe("54.000");

    // Melt 20 g of that melted gold again.
    const { id: secondId } = await create(
      meltInput({
        lines: [{ item_id: out1, weight: "20", touch: "92" }],
        required_touch: "91.6",
        output_item_id: out2,
        after_weight: "20",
      }),
    );
    expect(await goldRow(out1, "92")).toBe("34.000");

    expect(await errorOf(deleteMelting(firstId))).toContain("already been used");
    // Nothing changed.
    expect((await meltingRow(firstId)).is_deleted).toBe(false);
    expect(await goldRow(out1, "92")).toBe("34.000");
    expect(await goldRow(fine, "99.5")).toBe("0.000");

    // Edit that brings back less than was used → refused.
    expect(await errorOf(update(firstId, { ...firstInput, after_weight: "15" }))).toContain("already been used");
    expect(await goldRow(out1, "92")).toBe("34.000");

    // Edit that still covers what was used (net effect judged) → allowed: 54 → 30.
    await update(firstId, { ...firstInput, after_weight: "30" });
    expect(await goldRow(out1, "92")).toBe("10.000");

    // Undo the second melting first, then the first can be deleted.
    await deleteMelting(secondId);
    expect(await goldRow(out1, "92")).toBe("30.000");
    expect(await goldRow(out2, "91.6")).toBe("0.000");
    await deleteMelting(firstId);
    expect(await goldRow(out1, "92")).toBe("0.000");
    expect(await goldRow(fine, "99.5")).toBe("50.000");
  });
});

// ─── EXPENSE ─────────────────────────────────────────────────────────────────

describe("Expense", () => {
  it("8a. create expense: cash goes out, expense account recorded", async () => {
    const name = `FT Tea ${RUN}`;
    const cashBefore = await getBalance(CASH, RUPEE);

    const res = await createExpense(
      CreateExpenseSchema.parse({ date: DATE, name, amount: "1500", reason: "tea and snacks" }),
    );
    expect(res.group.type).toBe("EXPENSE");
    expect(res.group.bill_no).not.toBeNull();
    expect(res.entries.length).toBe(1);
    expect(res.entries[0]!.from_account_id).toBe(CASH);

    const expAcc = res.group.account_id;
    const [acc] = await db.select().from(accounts).where(eq(accounts.id, expAcc));
    expect(acc!.type).toBe("EXPENSE");
    expect(acc!.name).toBe(name);

    expect((await getBalance(CASH, RUPEE)).minus(cashBefore).toFixed(2)).toBe("-1500.00");
    expect((await getBalance(expAcc, RUPEE)).toFixed(2)).toBe("1500.00");

    // Same name again (any case) reuses the same expense account.
    const again = await createExpense(
      CreateExpenseSchema.parse({ date: DATE, name: name.toUpperCase(), amount: "500", reason: "more tea" }),
    );
    expect(again.group.account_id).toBe(expAcc);
    expect((await getBalance(expAcc, RUPEE)).toFixed(2)).toBe("2000.00");

    const fetched = await getExpenseById({ id: res.group.id });
    expect(fetched).toBeTruthy();
    const list = await listExpenses({ page: 1, limit: 100 });
    expect(list.data.some((r) => r.group.id === res.group.id)).toBe(true);
  });

  it("8b. paid from bank: bank goes out, bank details kept", async () => {
    const name = `FT Rent ${RUN}`;
    const bankBefore = await getBalance(BANK, RUPEE);
    const cashBefore = await getBalance(CASH, RUPEE);
    const res = await createExpense(
      CreateExpenseSchema.parse({
        date: DATE,
        name,
        amount: "12000.50",
        reason: "rent",
        from_account_id: BANK,
        bank_details: "NEFT 123",
      }),
    );
    expect((await getBalance(BANK, RUPEE)).minus(bankBefore).toFixed(2)).toBe("-12000.50");
    expect((await getBalance(CASH, RUPEE)).minus(cashBefore).toFixed(2)).toBe("0.00");
    expect(res.entries[0]!.remarks).toBe("NEFT 123");
  });

  it("8c. edit expense: old reversed, bill/entry no kept, only the new amount counts", async () => {
    const name = `FT Fuel ${RUN}`;
    const cashBefore = await getBalance(CASH, RUPEE);
    const bankBefore = await getBalance(BANK, RUPEE);
    const v0 = await createExpense(
      CreateExpenseSchema.parse({ date: DATE, name, amount: "800", reason: "petrol" }),
    );
    const expAcc = v0.group.account_id;

    const v1 = await updateExpense(
      UpdateExpenseSchema.parse({
        id: v0.group.id,
        date: DATE,
        name,
        amount: "1200",
        reason: "petrol + diesel",
        from_account_id: BANK,
      }),
    );
    expect(v1.group.id).not.toBe(v0.group.id);
    expect(v1.group.bill_no).toBe(v0.group.bill_no);
    expect(v1.group.entry_no).toBe(v0.group.entry_no);
    expect(v1.group.account_id).toBe(expAcc);

    const [old] = await db.select().from(entryGroups).where(eq(entryGroups.id, v0.group.id));
    expect(old!.is_deleted).toBe(true);
    expect(old!.reversed_by).not.toBeNull();

    // Cash refunded, bank paid instead; expense account shows only 1200.
    expect((await getBalance(CASH, RUPEE)).minus(cashBefore).toFixed(2)).toBe("0.00");
    expect((await getBalance(BANK, RUPEE)).minus(bankBefore).toFixed(2)).toBe("-1200.00");
    expect((await getBalance(expAcc, RUPEE)).toFixed(2)).toBe("1200.00");

    // Re-editing the old version is refused; balances unchanged.
    expect(
      await errorOf(
        updateExpense(UpdateExpenseSchema.parse({ id: v0.group.id, date: DATE, name, amount: "5", reason: "x" })),
      ),
    ).toBe("Transaction already reversed");
    expect((await getBalance(expAcc, RUPEE)).toFixed(2)).toBe("1200.00");

    // Rename on edit moves the amount to the new expense account.
    const newName = `FT Fuel Renamed ${RUN}`;
    const v2 = await updateExpense(
      UpdateExpenseSchema.parse({ id: v1.group.id, date: DATE, name: newName, amount: "1200", reason: "fuel" }),
    );
    expect(v2.group.account_id).not.toBe(expAcc);
    expect((await getBalance(expAcc, RUPEE)).toFixed(2)).toBe("0.00");
    expect((await getBalance(v2.group.account_id, RUPEE)).toFixed(2)).toBe("1200.00");
    expect((await getBalance(BANK, RUPEE)).minus(bankBefore).toFixed(2)).toBe("0.00");
    expect((await getBalance(CASH, RUPEE)).minus(cashBefore).toFixed(2)).toBe("-1200.00");
  });

  it("8d. delete is disabled for expenses: refused, nothing changes", async () => {
    const name = `FT Misc ${RUN}`;
    const v0 = await createExpense(
      CreateExpenseSchema.parse({ date: DATE, name, amount: "300", reason: "misc" }),
    );
    const cashMid = await getBalance(CASH, RUPEE);
    expect(await errorOf(deleteExpense({ id: v0.group.id }))).toBe(
      "Delete option has been disabled for expenses",
    );
    const [g] = await db.select().from(entryGroups).where(eq(entryGroups.id, v0.group.id));
    expect(g!.is_deleted).toBe(false);
    expect((await getBalance(CASH, RUPEE)).toFixed(2)).toBe(cashMid.toFixed(2));
    expect((await getBalance(v0.group.account_id, RUPEE)).toFixed(2)).toBe("300.00");
  });

  it("8e. amount must be greater than zero", () => {
    expect(CreateExpenseSchema.safeParse({ date: DATE, name: "x", amount: "0", reason: "r" }).success).toBe(false);
    expect(CreateExpenseSchema.safeParse({ date: DATE, name: "x", amount: "-5", reason: "r" }).success).toBe(false);
    expect(CreateExpenseSchema.safeParse({ date: DATE, name: "", amount: "5", reason: "r" }).success).toBe(false);
  });

  // B1 (expense side): the edit reverses the old version and books the new one in ONE
  // transaction, so a refused save leaves the original expense exactly as it was.
  it("8f. a refused expense edit leaves the original intact (all-or-nothing)", async () => {
    const name = `FT Atomic ${RUN}`;
    const cashBefore = await getBalance(CASH, RUPEE);
    const v0 = await createExpense(
      CreateExpenseSchema.parse({ date: DATE, name, amount: "700", reason: "stationery" }),
    );
    const expAcc = v0.group.account_id;

    const intact = async () => {
      const [g] = await db.select().from(entryGroups).where(eq(entryGroups.id, v0.group.id));
      expect(g!.is_deleted).toBe(false);
      expect(g!.reversed_by).toBeNull();
      // No stray REVERSAL group was left behind for it.
      expect(await db.select().from(entryGroups).where(eq(entryGroups.reversal_of, v0.group.id))).toEqual([]);
      expect((await getBalance(expAcc, RUPEE)).toFixed(2)).toBe("700.00");
      expect((await getBalance(CASH, RUPEE)).minus(cashBefore).toFixed(2)).toBe("-700.00");
    };

    // (a) Refused by the service's own check (amount 0 — bypasses the API schema).
    expect(
      await errorOf(
        updateExpense({ id: v0.group.id, date: DATE, name, amount: "0", reason: "x" } as never),
      ),
    ).toBe("Amount must be greater than zero");
    await intact();

    // (b) Fails mid-save, AFTER the reversal ran: the paid-from account does not exist
    // (foreign-key error on the new entry). A rename is in the same edit — the new
    // expense account must not be left behind either.
    const renamed = `FT Atomic Renamed ${RUN}`;
    const err = await errorOf(
      updateExpense(
        UpdateExpenseSchema.parse({
          id: v0.group.id,
          date: DATE,
          name: renamed,
          amount: "900",
          reason: "x",
          from_account_id: crypto.randomUUID(),
        }),
      ),
    );
    expect(err).not.toBeNull();
    await intact();
    expect(await db.select().from(accounts).where(eq(accounts.name, renamed))).toEqual([]);

    // A valid edit afterwards still works and keeps the bill no.
    const v1 = await updateExpense(
      UpdateExpenseSchema.parse({ id: v0.group.id, date: DATE, name, amount: "900", reason: "stationery" }),
    );
    expect(v1.group.bill_no).toBe(v0.group.bill_no);
    expect((await getBalance(expAcc, RUPEE)).toFixed(2)).toBe("900.00");
  });

  // BUG: updateExpense never checks that the id it is given is an EXPENSE bill.
  // Passing any other bill's group id (here a MELTING group) reverses that bill
  // and books a brand-new expense in its place — the melting's stock movement is
  // silently undone while the melting entry still points at the dead group.
  // src/modules/transactions/expense/service.ts updateExpense (line 162: no
  // `type = 'EXPENSE'` / is_deleted check before reverseEntryGroup).
  it("8g. editing an expense with a non-expense bill id is refused", async () => {
    const fine = await makeItem("fine-bug", "GOLD", "99.5");
    await openStock(fine, "5", "99.5");
    const { id } = await create(meltInput({ lines: [{ item_id: fine, weight: "5", touch: "99.5" }] }));
    const meltGroupId = (await meltingRow(id)).entry_group_id!;
    expect(await goldRow(fine, "99.5")).toBe("0.000");

    const err = await errorOf(
      updateExpense(
        UpdateExpenseSchema.parse({ id: meltGroupId, date: DATE, name: `FT Bug ${RUN}`, amount: "10", reason: "bug" }),
      ),
    );
    // Correct behaviour: refused, and the melting's stock movement is untouched.
    const [g] = await db.select().from(entryGroups).where(eq(entryGroups.id, meltGroupId));
    const stockAfter = await goldRow(fine, "99.5");
    expect(err).not.toBeNull();
    expect(g!.is_deleted).toBe(false);
    expect(stockAfter).toBe("0.000");
  });
});
