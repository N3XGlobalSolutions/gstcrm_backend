import { describe, expect, it } from "bun:test";
import { computeAlloy } from "../alloy";

const A = "00000000-0000-0000-0000-00000000000a";
const B = "00000000-0000-0000-0000-00000000000b";
const C = "00000000-0000-0000-0000-00000000000c";

describe("computeAlloy", () => {
  it("computes current figures without a required touch", () => {
    const r = computeAlloy(
      [
        { weight: "50", touch: "99.5" },
        { weight: "50", touch: "91.6" },
      ],
      null,
      [],
    );
    expect(r.current_weight).toBe("100.000");
    expect(r.current_pure).toBe("95.550");
    expect(r.current_touch).toBe("95.55");
    expect(r.final_weight).toBeNull();
    expect(r.alloy_total).toBeNull();
    expect(r.alloys).toEqual([]);
  });

  it("splits alloy grams by share and sums exactly to alloy_total", () => {
    // pure 99.5 → final 99.5*100/92 = 108.152 → alloy 8.152
    const r = computeAlloy([{ weight: "100", touch: "99.5" }], "92", [
      { metal_id: A, share_percent: "70" },
      { metal_id: B, share_percent: "30" },
    ]);
    expect(r.final_weight).toBe("108.152");
    expect(r.alloy_total).toBe("8.152");
    expect(r.alloys).toEqual([
      { metal_id: A, share_percent: "70.00", grams: "5.706" },
      { metal_id: B, share_percent: "30.00", grams: "2.446" },
    ]);
  });

  it("puts the rounding remainder on the last metal", () => {
    const r = computeAlloy([{ weight: "10", touch: "100" }], "91", [
      { metal_id: A, share_percent: "33.33" },
      { metal_id: B, share_percent: "33.33" },
      { metal_id: C, share_percent: "33.34" },
    ]);
    // final 10*100/91 = 10.989 → alloy 0.989
    expect(r.alloy_total).toBe("0.989");
    const sum = r.alloys.reduce((s, a) => s + Math.round(Number(a.grams) * 1000), 0);
    expect(sum).toBe(989);
    expect(r.alloys[0]!.grams).toBe("0.330");
    expect(r.alloys[2]!.grams).toBe("0.329");
  });

  it("clamps alloy to zero when required touch >= current touch", () => {
    const r = computeAlloy([{ weight: "100", touch: "91.6" }], "95", [
      { metal_id: A, share_percent: "100" },
    ]);
    expect(r.alloy_total).toBe("0.000");
    expect(r.alloys[0]!.grams).toBe("0.000");
  });

  it("treats lines without touch as zero pure", () => {
    const r = computeAlloy(
      [
        { weight: "10", touch: null },
        { weight: "10", touch: "100" },
      ],
      null,
      [],
    );
    expect(r.current_weight).toBe("20.000");
    expect(r.current_pure).toBe("10.000");
    expect(r.current_touch).toBe("50.00");
  });
});
