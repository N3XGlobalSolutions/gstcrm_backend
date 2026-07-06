import { describe, it, expect } from "bun:test";
import { CreateLabourBillSchema } from "../schema";

// A valid, minimal labour bill: one gold receipt inside a cycle.
const validBase = {
  account_id: "a5fe9568-1111-4111-8111-111111111111",
  date: "2026-07-07",
  bill_cycle_id: "e117f1b8-2222-4222-9222-222222222222",
  gold_receipt: [
    {
      item_id: "33333333-3333-4333-a333-333333333333",
      quantity: "100",
      purity: "99.99",
    },
  ],
};

describe("CreateLabourBillSchema — bill_cycle_id is mandatory", () => {
  it("accepts a labour bill that carries a valid bill_cycle_id", () => {
    const result = CreateLabourBillSchema.safeParse(validBase);
    expect(result.success).toBe(true);
  });

  it("rejects a labour bill with no bill_cycle_id (prevents phantom auto-numbered bills)", () => {
    const { bill_cycle_id, ...withoutCycle } = validBase;
    const result = CreateLabourBillSchema.safeParse(withoutCycle);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toContain("bill_cycle_id");
    }
  });

  it("rejects a labour bill whose bill_cycle_id is not a UUID", () => {
    const result = CreateLabourBillSchema.safeParse({ ...validBase, bill_cycle_id: "not-a-uuid" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toContain("bill_cycle_id");
    }
  });

  it("rejects a labour bill with an empty-string bill_cycle_id", () => {
    const result = CreateLabourBillSchema.safeParse({ ...validBase, bill_cycle_id: "" });
    expect(result.success).toBe(false);
  });
});
