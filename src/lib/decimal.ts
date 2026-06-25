import Decimal from "decimal.js";

// Configure decimal.js precision globally
Decimal.set({ precision: 28, rounding: Decimal.ROUND_HALF_UP });

// ─── Core conversion ──────────────────────────────────────────────────────────

/**
 * Convert a string or number to a Decimal instance.
 * Never pass raw JS numbers for financial/weight calculations.
 */
export function toDecimal(value: string | number): Decimal {
  return new Decimal(String(value));
}

// ─── Gold calculations ────────────────────────────────────────────────────────

/**
 * Pure gold weight: quantity × (purity / 100)
 * e.g. 100g at 91.6% touch = 91.6g pure
 */
export function calcPure(quantity: string, purity: string): Decimal {
  return toDecimal(quantity).mul(toDecimal(purity).div(100));
}

/**
 * Wastage in PERCENT mode: baseWeight × (wastagePercent / touchPercent)
 */
export function calcWastagePercent(
  baseWeight: string,
  wastagePercent: string,
  touchPercent: string,
): Decimal {
  return toDecimal(baseWeight).mul(
    toDecimal(wastagePercent).div(toDecimal(touchPercent)),
  );
}

/**
 * Wastage in GRAM mode: baseWeight × wastageGram
 */
export function calcWastageGram(
  baseWeight: string,
  wastageGram: string,
): Decimal {
  return toDecimal(baseWeight).mul(toDecimal(wastageGram));
}

/**
 * Total weight after stone/throde deductions and wastage addition:
 * weight - (stone + throde) + wastage
 */
export function calcTotalWeight(
  weight: string,
  stone: string,
  throde: string,
  wastage: string,
): Decimal {
  return toDecimal(weight)
    .minus(toDecimal(stone))
    .minus(toDecimal(throde))
    .plus(toDecimal(wastage));
}

/**
 * Total pure from total weight: totalWeight / touchPercent × 100
 */
export function calcTotalPure(
  totalWeight: string,
  touchPercent: string,
): Decimal {
  return toDecimal(totalWeight).div(toDecimal(touchPercent)).mul(100);
}

/**
 * Average touch percentage: totalPure / weight × 100
 */
export function calcAverageTouch(
  totalPure: string,
  weight: string,
): Decimal {
  return toDecimal(totalPure).div(toDecimal(weight)).mul(100);
}

/**
 * Cash amount: quantity × rate
 */
export function calcAmount(quantity: string, rate: string): Decimal {
  return toDecimal(quantity).mul(toDecimal(rate));
}

// ─── Arithmetic helpers ───────────────────────────────────────────────────────

export function sumDecimals(values: string[]): Decimal {
  return values.reduce((acc, val) => acc.plus(toDecimal(val)), toDecimal("0"));
}

export function subtractDecimals(a: string, b: string): Decimal {
  return toDecimal(a).minus(toDecimal(b));
}

export function multiplyDecimals(a: string, b: string): Decimal {
  return toDecimal(a).mul(toDecimal(b));
}

export function divideDecimals(a: string, b: string): Decimal {
  return toDecimal(a).div(toDecimal(b));
}

/**
 * Serialize a Decimal for DB write — gold/weight quantities use 3 decimal places.
 * Rule: all gold weights stored and calculated to 3dp. Cash to 2dp.
 */
export function toQuantityString(value: Decimal): string {
  return value.toFixed(3);
}

/**
 * Serialize a Decimal for DB write (amounts use 2 decimal places).
 */
export function toAmountString(value: Decimal): string {
  return value.toFixed(2);
}

// Legacy alias kept for backwards compatibility
export function serializeDecimal(value: Decimal, decimalPlaces = 6): string {
  return value.toFixed(decimalPlaces);
}

export { Decimal };
