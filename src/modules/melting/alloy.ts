import { toDecimal, toQuantityString } from "@/lib/decimal";

// Alloy calculator — pure function, no DB access (unit tested in isolation).
//
// The melt's gold is fixed; alloy metals (copper, silver, …) carry no gold and
// are added to dilute it down to required_touch:
//   current_weight = Σ line.weight
//   current_pure   = Σ line.pure            (pure = weight × touch / 100, 3dp; no wastage)
//   current_touch  = current_pure / current_weight × 100   → 2dp
//   final_weight   = current_pure × 100 / required_touch   → 3dp
//   alloy_total    = final_weight − current_weight         (≤ 0 → 0)
//   metal grams    = alloy_total × share% / 100            → 3dp, remainder on the last metal
// decimal.js is configured globally with ROUND_HALF_UP (see lib/decimal).

export interface AlloyLineInput {
  weight: string;
  touch: string | null;
}

export interface AlloyShareInput {
  metal_id: string;
  share_percent: string;
}

export interface AlloyResult {
  current_weight: string;
  current_pure: string;
  current_touch: string | null;
  final_weight: string | null;
  alloy_total: string | null;
  alloys: { metal_id: string; share_percent: string; grams: string }[];
}

export function computeAlloy(
  lines: AlloyLineInput[],
  requiredTouch: string | null,
  alloys: AlloyShareInput[],
): AlloyResult {
  let weight = toDecimal(0);
  let pure = toDecimal(0);
  for (const l of lines) {
    const w = toDecimal(l.weight);
    weight = weight.plus(w);
    if (l.touch !== null && l.touch !== "") {
      // Same 3dp rounding as the stored line.pure.
      pure = pure.plus(toDecimal(toQuantityString(w.mul(toDecimal(l.touch)).div(100))));
    }
  }

  const currentTouch = weight.gt(0) ? pure.div(weight).mul(100).toFixed(2) : null;

  const req = requiredTouch !== null && requiredTouch !== "" ? toDecimal(requiredTouch) : null;
  let finalWeight: string | null = null;
  let alloyTotal: string | null = null;
  if (req !== null && req.gt(0)) {
    const fw = toDecimal(toQuantityString(pure.mul(100).div(req)));
    finalWeight = toQuantityString(fw);
    const diff = fw.minus(toDecimal(toQuantityString(weight)));
    alloyTotal = toQuantityString(diff.gt(0) ? diff : toDecimal(0));
  }

  const total = toDecimal(alloyTotal ?? "0");
  let allocated = toDecimal(0);
  const outAlloys = alloys.map((a, i) => {
    const share = toDecimal(a.share_percent);
    let grams: string;
    if (i === alloys.length - 1) {
      const rest = total.minus(allocated);
      grams = toQuantityString(rest.gt(0) ? rest : toDecimal(0));
    } else {
      grams = toQuantityString(total.mul(share).div(100));
      allocated = allocated.plus(toDecimal(grams));
    }
    return { metal_id: a.metal_id, share_percent: share.toFixed(2), grams };
  });

  return {
    current_weight: toQuantityString(weight),
    current_pure: toQuantityString(pure),
    current_touch: currentTouch,
    final_weight: finalWeight,
    alloy_total: alloyTotal,
    alloys: outAlloys,
  };
}

// ─── Melt loss (0023) ────────────────────────────────────────────────────────
// What came out of the furnace vs what should have:
//   expected_weight = current_weight + alloy_total   (alloy adds weight, no gold)
//   out_touch       = required_touch if set, else current_touch           → 2dp
//   loss_weight     = expected_weight − after_weight  (may be negative)   → 3dp
//   pure_out        = after_weight × out_touch / 100                      → 3dp
//   pure_loss       = current_pure − pure_out         (may be negative)   → 3dp

export interface MeltLossResult extends AlloyResult {
  expected_weight: string;
  after_weight: string;
  out_touch: string;
  loss_weight: string;
  pure_out: string;
  pure_loss: string;
}

export function computeMeltLoss(
  lines: AlloyLineInput[],
  requiredTouch: string | null,
  alloys: AlloyShareInput[],
  afterWeight: string,
): MeltLossResult {
  const calc = computeAlloy(lines, requiredTouch, alloys);
  const expected = toDecimal(calc.current_weight).plus(toDecimal(calc.alloy_total ?? "0"));
  const outTouch =
    requiredTouch !== null && requiredTouch !== ""
      ? toDecimal(requiredTouch).toFixed(2)
      : (calc.current_touch ?? "0.00");
  const after = toDecimal(toQuantityString(toDecimal(afterWeight)));
  const pureOut = toDecimal(toQuantityString(after.mul(toDecimal(outTouch)).div(100)));
  return {
    ...calc,
    expected_weight: toQuantityString(expected),
    after_weight: toQuantityString(after),
    out_touch: outTouch,
    loss_weight: toQuantityString(expected.minus(after)),
    pure_out: toQuantityString(pureOut),
    pure_loss: toQuantityString(toDecimal(calc.current_pure).minus(pureOut)),
  };
}
