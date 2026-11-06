/**
 * Unit tests (no DB): Customer Cycle removed (2026-11-06) — the Labour Bill and
 * Job Work inputs are back to the old contract.
 *  - Labour Bill create/update: bill_cycle_id required; new_cycle /
 *    required_touch / close_cycle are no longer fields (silently dropped).
 *  - Labour Bill createCycle: { account_id, main_reason? } only.
 *  - Job Work create/update: order_cycle_id is no longer a field (silently
 *    dropped, never an error); the job-work cycle's required_touch stays.
 *
 *   bun test src/modules/transactions/__tests__/customerCycleRemoved.test.ts
 */
import { describe, expect, it } from "bun:test";
import * as lbSchema from "../labourBill/schema";
import * as jwSchema from "../jobWork/schema";

const ACCOUNT = "00000000-0000-4000-8000-000000000001";
const CYCLE = "00000000-0000-4000-8000-000000000002";
const ITEM = "00000000-0000-4000-8000-000000000003";
const GROUP = "00000000-0000-4000-8000-000000000004";

function bill(extra: Record<string, unknown> = {}) {
  return {
    account_id: ACCOUNT,
    bill_cycle_id: CYCLE,
    date: "2026-11-06",
    rate_per_gram: "6000",
    gold_receipt: [{ item_id: ITEM, quantity: "10", purity: "91.6" }],
    ...extra,
  };
}

describe("Labour Bill input (Customer Cycle removed)", () => {
  it("bill_cycle_id is required on create and update", () => {
    const { bill_cycle_id: _c, ...noCycle } = bill();
    const r = lbSchema.CreateLabourBillSchema.safeParse(noCycle);
    expect(r.success).toBe(false);
    expect(r.error!.issues[0]!.path).toEqual(["bill_cycle_id"]);
    expect(lbSchema.UpdateLabourBillSchema.safeParse({ ...noCycle, id: GROUP }).success).toBe(false);
    expect(lbSchema.UpdateLabourBillSchema.safeParse(bill({ id: GROUP })).success).toBe(true);
  });

  it("a gold receipt needs no Required Touch any more", () => {
    expect(lbSchema.CreateLabourBillSchema.safeParse(bill()).success).toBe(true);
  });

  it("new_cycle / required_touch / close_cycle are dropped, not stored or refused", () => {
    const r = lbSchema.CreateLabourBillSchema.safeParse(
      bill({ new_cycle: true, required_touch: "500", close_cycle: true }),
    );
    expect(r.success).toBe(true);
    expect(r.data).not.toHaveProperty("new_cycle");
    expect(r.data).not.toHaveProperty("required_touch");
    expect(r.data).not.toHaveProperty("close_cycle");
  });

  it("new_cycle alone (no bill_cycle_id) is refused — pick an existing cycle", () => {
    const { bill_cycle_id: _c, ...noCycle } = bill();
    expect(lbSchema.CreateLabourBillSchema.safeParse({ ...noCycle, new_cycle: true }).success).toBe(false);
  });

  it("createCycle takes { account_id, main_reason? }; a stray required_touch is dropped", () => {
    expect(lbSchema.CreateCycleSchema.safeParse({ account_id: ACCOUNT }).success).toBe(true);
    const r = lbSchema.CreateCycleSchema.safeParse({ account_id: ACCOUNT, main_reason: "Ring", required_touch: "x" });
    expect(r.success).toBe(true);
    expect(r.data).toEqual({ account_id: ACCOUNT, main_reason: "Ring" });
  });

  it("the Customer Cycle schemas are gone", () => {
    expect(lbSchema).not.toHaveProperty("SetCycleStatusSchema");
    expect(lbSchema).not.toHaveProperty("FinishedOrnamentsSchema");
    expect(lbSchema).not.toHaveProperty("CycleStatusSchema");
    expect(jwSchema).not.toHaveProperty("ListOpenCyclesSchema");
    expect(jwSchema).not.toHaveProperty("IssuableGoldSchema");
  });
});

describe("Job Work input (Customer Cycle removed)", () => {
  it("order_cycle_id is dropped on create and update — never an error", () => {
    for (const v of [CYCLE, null, "not-a-uuid"]) {
      const c = jwSchema.CreateJobWorkSchema.safeParse(bill({ order_cycle_id: v }));
      expect(c.success).toBe(true);
      expect(c.data).not.toHaveProperty("order_cycle_id");
      const u = jwSchema.UpdateJobWorkSchema.safeParse(bill({ id: GROUP, order_cycle_id: v }));
      expect(u.success).toBe(true);
      expect(u.data).not.toHaveProperty("order_cycle_id");
    }
  });

  it("the job-work cycle's required_touch is still a field", () => {
    const r = jwSchema.CreateJobWorkSchema.safeParse(bill({ required_touch: "91.6" }));
    expect(r.success).toBe(true);
    expect(r.data!.required_touch).toBe("91.6");
  });
});
