// ─────────────────────────────────────────────────────────────────────────────
// PURCHASE WASTAGE — pure unit tests (no database, no env).
// The wastage % on Purchase → Ornament rows is a cost in the income statement;
// grams are pure (same basis as sale wastage) and valued at the row's rate.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from "bun:test";
import { purchaseWastagePure, sumPurchaseWastage, type PurchaseWastageRow } from "../purchaseWastage";

const row = (o: Partial<PurchaseWastageRow>): PurchaseWastageRow => ({
  quantity: "10",
  purity: "91.6",
  wastage_mode: "PERCENT",
  wastage_value: "8",
  wastage_quantity: "0",
  rate: "7000",
  ...o,
});

describe("purchaseWastagePure", () => {
  it("10 g at 91.6 touch, 8% wastage → 0.800 g pure (as purchase stores it: wastage_quantity 0)", () => {
    expect(purchaseWastagePure(row({})).toFixed(3)).toBe("0.800");
  });

  it("matches the sale basis: weight × % ÷ touch, then × touch/100", () => {
    const gross = (10 * 8) / 91.6;
    expect(purchaseWastagePure(row({})).toNumber()).toBeCloseTo((gross * 91.6) / 100, 8);
  });

  it("uses a recorded wastage_quantity (gross grams) when present", () => {
    expect(purchaseWastagePure(row({ wastage_quantity: "1", wastage_value: "8" })).toFixed(3)).toBe("0.916");
  });

  it("touch 0 direct row: weight × %", () => {
    expect(purchaseWastagePure(row({ purity: "0" })).toFixed(3)).toBe("0.800");
  });

  it("GRAM mode: weight × grams-per-gram × touch", () => {
    expect(purchaseWastagePure(row({ wastage_mode: "GRAM", wastage_value: "0.1" })).toFixed(3)).toBe("0.916");
  });

  it("no wastage → 0; null / empty fields are safe", () => {
    expect(purchaseWastagePure(row({ wastage_value: "0" })).isZero()).toBe(true);
    expect(purchaseWastagePure(row({ wastage_value: null, wastage_mode: null, wastage_quantity: null })).isZero()).toBe(true);
    expect(purchaseWastagePure(row({ wastage_value: "" })).isZero()).toBe(true);
  });
});

describe("sumPurchaseWastage", () => {
  it("worked example: 10 g / 91.6 / 8% @ ₹7,000 → 0.800 g, ₹5,600", () => {
    const t = sumPurchaseWastage([row({})]);
    expect(t.grams.toFixed(3)).toBe("0.800");
    expect(t.value.toFixed(2)).toBe("5600.00");
  });

  it("each row valued at its own rate; a row with no rate counts grams but ₹0", () => {
    const t = sumPurchaseWastage([
      row({}),                                     // 0.800 g × 7000
      row({ quantity: "5", rate: "6500" }),       // 0.400 g × 6500
      row({ quantity: "2.5", rate: null }),       // 0.200 g × 0
    ]);
    expect(t.grams.toFixed(3)).toBe("1.400");
    expect(t.value.toFixed(2)).toBe("8200.00");
  });

  it("empty → zero", () => {
    const t = sumPurchaseWastage([]);
    expect(t.grams.toFixed(3)).toBe("0.000");
    expect(t.value.toFixed(2)).toBe("0.00");
  });
});
