/**
 * Unit tests (no DB): bill delete is turned off in GST CRM (owner, 2026-11-12).
 * Sales, Purchase, Labour Bill and Issue & Job Works keep a `delete` route so an
 * old screen gets a clear message, but the route always refuses and never calls
 * the delete* service.
 *
 *   bun test src/modules/transactions/__tests__/billDeleteDisabled.test.ts
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { TRPCError } from "@trpc/server";
import {
  BILL_DELETE_DISABLED_MESSAGE,
  STOCK_LOT_DELETE_DISABLED_MESSAGE,
  billDeleteDisabled,
  stockLotDeleteDisabled,
} from "@/lib/billDeleteDisabled";

describe("billDeleteDisabled", () => {
  it("always throws FORBIDDEN with a shop-readable message", () => {
    let caught: unknown;
    try {
      billDeleteDisabled();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(TRPCError);
    expect((caught as TRPCError).code).toBe("FORBIDDEN");
    expect((caught as TRPCError).message).toBe(BILL_DELETE_DISABLED_MESSAGE);
  });
});

describe("bill routers refuse delete", () => {
  const routers = {
    sales: "deleteSale",
    purchase: "deletePurchase",
    labourBill: "deleteLabourBill",
    jobWork: "deleteJobWork",
  } as const;

  for (const [module, serviceFn] of Object.entries(routers)) {
    it(`${module}.delete calls billDeleteDisabled and never ${serviceFn}`, () => {
      const src = readFileSync(join(import.meta.dir, "..", module, "router.ts"), "utf8");
      const deleteLine = src.split("\n").find((l) => /^\s*delete:\s/.test(l));
      expect(deleteLine).toBeDefined();
      expect(deleteLine).toContain("billDeleteDisabled()");
      expect(src).not.toContain(serviceFn);
    });
  }
});

describe("stock lot delete is turned off", () => {
  it("stockLotDeleteDisabled always throws FORBIDDEN with a shop-readable message", () => {
    let caught: unknown;
    try {
      stockLotDeleteDisabled();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(TRPCError);
    expect((caught as TRPCError).code).toBe("FORBIDDEN");
    expect((caught as TRPCError).message).toBe(STOCK_LOT_DELETE_DISABLED_MESSAGE);
  });

  it("stock.deleteByLot calls stockLotDeleteDisabled and never reverses the bill", () => {
    const src = readFileSync(join(import.meta.dir, "..", "..", "stock", "router.ts"), "utf8");
    const lines = src.split("\n");
    const at = lines.findIndex((l) => /^\s*deleteByLot:\s/.test(l));
    expect(at).toBeGreaterThan(-1);
    // The procedure is a short chain: guardedProcedure(...).input(...).mutation(...)
    const procedure = lines.slice(at, at + 4).join("\n");
    expect(procedure).toContain("stockLotDeleteDisabled()");
    expect(src).not.toContain("deleteStockByLot");
    expect(src).not.toContain("reverseEntryGroup");
  });
});
