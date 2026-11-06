/**
 * Unit tests (no DB): job-work Bill Cycle Required Touch % — input validation
 * on create / update / createCycle, and the "receipt needs a touch" rule.
 *
 *   bun test src/modules/transactions/jobWork/__tests__/requiredTouch.test.ts
 */
import { describe, expect, it } from "bun:test";
import { CreateCycleSchema, CreateJobWorkSchema, UpdateJobWorkSchema } from "../schema";
import { assertTouchForReceipts, givenRequiredTouch, JOB_WORK_TOUCH_NEEDED_MESSAGE } from "../touch";
import { AppError } from "@/types/errors";

const ACCOUNT = "00000000-0000-4000-8000-000000000001";
const CYCLE = "00000000-0000-4000-8000-000000000002";
const ITEM = "00000000-0000-4000-8000-000000000003";
const GROUP = "00000000-0000-4000-8000-000000000004";

function jobWork(extra: Record<string, unknown> = {}) {
  return {
    account_id: ACCOUNT,
    bill_cycle_id: CYCLE,
    date: "2026-11-06",
    rate_per_gram: "6000",
    gold_receipt: [{ item_id: ITEM, quantity: "10", purity: "91.6" }],
    ...extra,
  };
}

describe("CreateJobWorkSchema.required_touch", () => {
  it("is optional (omitted → undefined)", () => {
    const r = CreateJobWorkSchema.safeParse(jobWork());
    expect(r.success).toBe(true);
    expect(r.data!.required_touch).toBeUndefined();
  });

  it("accepts empty / whitespace as 'not given' (trimmed to '')", () => {
    for (const v of ["", "   "]) {
      const r = CreateJobWorkSchema.safeParse(jobWork({ required_touch: v }));
      expect(r.success).toBe(true);
      expect(r.data!.required_touch).toBe("");
    }
  });

  it("accepts 0 < touch ≤ 100", () => {
    for (const v of ["91.6", "100", "0.01", " 92.5 "]) {
      const r = CreateJobWorkSchema.safeParse(jobWork({ required_touch: v }));
      expect(r.success).toBe(true);
    }
  });

  it("rejects 0, negatives, > 100 and non-numbers", () => {
    for (const v of ["0", "-1", "100.01", "abc"]) {
      const r = CreateJobWorkSchema.safeParse(jobWork({ required_touch: v }));
      expect(r.success).toBe(false);
      expect(r.error!.issues[0]!.path).toEqual(["required_touch"]);
      expect(r.error!.issues[0]!.message).toBe("Required touch must be greater than 0 and at most 100");
    }
  });

  it("rejects a non-string", () => {
    expect(CreateJobWorkSchema.safeParse(jobWork({ required_touch: 91.6 })).success).toBe(false);
  });

  it("UpdateJobWorkSchema carries the same field", () => {
    expect(UpdateJobWorkSchema.safeParse(jobWork({ id: GROUP, required_touch: "91.6" })).success).toBe(true);
    expect(UpdateJobWorkSchema.safeParse(jobWork({ id: GROUP, required_touch: "" })).success).toBe(true);
    expect(UpdateJobWorkSchema.safeParse(jobWork({ id: GROUP, required_touch: "101" })).success).toBe(false);
  });
});

describe("CreateCycleSchema.required_touch (job-work cycle)", () => {
  it("is optional — omitted or empty is allowed", () => {
    expect(CreateCycleSchema.safeParse({ account_id: ACCOUNT }).success).toBe(true);
    expect(CreateCycleSchema.safeParse({ account_id: ACCOUNT, required_touch: "" }).success).toBe(true);
  });

  it("validates the range when given", () => {
    expect(CreateCycleSchema.safeParse({ account_id: ACCOUNT, required_touch: "91.6" }).success).toBe(true);
    expect(CreateCycleSchema.safeParse({ account_id: ACCOUNT, required_touch: "0" }).success).toBe(false);
    expect(CreateCycleSchema.safeParse({ account_id: ACCOUNT, required_touch: "100.5" }).success).toBe(false);
    expect(CreateCycleSchema.safeParse({ account_id: ACCOUNT, required_touch: "x" }).success).toBe(false);
  });
});

describe("givenRequiredTouch", () => {
  it("treats undefined / null / blank as not given", () => {
    expect(givenRequiredTouch(undefined)).toBeUndefined();
    expect(givenRequiredTouch(null)).toBeUndefined();
    expect(givenRequiredTouch("")).toBeUndefined();
    expect(givenRequiredTouch("  ")).toBeUndefined();
    expect(givenRequiredTouch(" 91.6 ")).toBe("91.6");
  });
});

describe("assertTouchForReceipts", () => {
  const refusal = (rows: number, given: string | undefined, stored: string | null) => {
    try {
      assertTouchForReceipts(rows, given, stored);
      return null;
    } catch (e) {
      return e;
    }
  };

  it("refuses receipt rows with no touch anywhere", () => {
    const err = refusal(1, undefined, null);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe("VALIDATION_ERROR");
    expect((err as AppError).message).toBe(JOB_WORK_TOUCH_NEEDED_MESSAGE);
    expect((err as AppError).field).toBe("required_touch");
  });

  it("passes with the form's touch, or the cycle's stored touch", () => {
    expect(refusal(2, "91.6", null)).toBeNull();
    expect(refusal(2, undefined, "91.60")).toBeNull();
  });

  it("passes without a touch when the bill has no receipt rows", () => {
    expect(refusal(0, undefined, null)).toBeNull();
  });
});
