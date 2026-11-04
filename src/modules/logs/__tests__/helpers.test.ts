// ─────────────────────────────────────────────────────────────────────────────
// LOGS — pure unit tests (no database, no env).
// Activity module / action / record_ref derivation, permission diffs (only
// toggled entries), and Asia/Kolkata date filters → timestamp bounds.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from "bun:test";
import {
  deriveActivityMeta,
  findRecordRef,
  diffFormPermissions,
  diffActivityPermissions,
  permissionLabel,
  istDateRange,
  likePattern,
  recordLookupId,
} from "../helpers";

describe("recordLookupId", () => {
  const G = "33333333-3333-4333-8333-333333333333";
  const H = "44444444-4444-4444-8444-444444444444";

  it("looks up a uuid record_ref", () => {
    expect(recordLookupId(G, { id: H }, null)).toBe(G);
  });

  it("looks up the input / result id behind a bare number", () => {
    expect(recordLookupId("42", { id: G }, { id: H })).toBe(G);
    expect(recordLookupId("42", {}, { id: H, entry_no: 42 })).toBe(H);
  });

  it("has nothing to look up without a uuid", () => {
    expect(recordLookupId("u-1", { id: "u-1" }, null)).toBeNull();
    expect(recordLookupId(null, undefined, undefined)).toBeNull();
  });
});

describe("deriveActivityMeta", () => {
  it("uses the second segment under transactions", () => {
    const m = deriveActivityMeta("transactions.sales.create", {}, { id: "g1", entry_no: 42 });
    expect(m).toEqual({ module: "sales", action: "create", procedure: "transactions.sales.create", recordRef: "42" });
  });

  it("uses the first segment elsewhere (settings.users.x → settings)", () => {
    const m = deriveActivityMeta("settings.users.delete", { id: "u-1" }, { success: true });
    expect(m.module).toBe("settings");
    expect(m.action).toBe("delete");
    expect(m.recordRef).toBe("u-1");
  });

  it("two-segment paths keep module = first, action = last", () => {
    const m = deriveActivityMeta("accounts.update", { id: "a1" }, null);
    expect(m.module).toBe("accounts");
    expect(m.action).toBe("update");
  });

  it("'transactions.x' with only two segments keeps 'transactions'", () => {
    expect(deriveActivityMeta("transactions.ping", null, null).module).toBe("transactions");
  });

  it("caps lengths to the column sizes", () => {
    const long = "m".repeat(80);
    const m = deriveActivityMeta(`${long}.${"a".repeat(80)}`, null, null);
    expect(m.module.length).toBe(50);
    expect(m.action.length).toBe(50);
    expect(m.procedure.length).toBeLessThanOrEqual(150);
  });
});

describe("findRecordRef", () => {
  it("prefers the key order entry_no > bill_no > voucher_no > invoice_no > ticket_no > id", () => {
    expect(findRecordRef({ id: "x", bill_no: 7 }, null)).toBe("7");
    expect(findRecordRef({ id: "x" }, { entry_no: 3 })).toBe("3");
    expect(findRecordRef({ id: "x" }, { ticket_no: 12 })).toBe("12");
    expect(findRecordRef(null, { voucher_no: "OV-5", invoice_no: "INV-9" })).toBe("OV-5");
  });

  it("looks at the input before the result for the same key", () => {
    expect(findRecordRef({ id: "in" }, { id: "out" })).toBe("in");
  });

  it("never reads anything else (passwords etc.)", () => {
    expect(findRecordRef({ password: "Secret#1", currentPassword: "x", newPassword: "y" }, { success: true })).toBeNull();
  });

  it("ignores non-scalar, empty and array values", () => {
    expect(findRecordRef({ id: { nested: 1 } }, null)).toBeNull();
    expect(findRecordRef({ id: "   " }, null)).toBeNull();
    expect(findRecordRef([{ id: "1" }], null)).toBeNull();
    expect(findRecordRef({ entry_no: NaN }, { id: "ok" })).toBe("ok");
  });

  it("stringifies and caps at 100 characters", () => {
    expect(findRecordRef({ id: "z".repeat(150) }, null)!.length).toBe(100);
  });
});

describe("diffFormPermissions", () => {
  const before = [
    { module: "Sales", form_name: "Sales Entry", allowed: true },
    { module: "Sales", form_name: "Sales Report", allowed: false },
    { module: "Purchase", form_name: "Purchase Entry", allowed: true },
  ];

  it("returns only toggled entries with 'Module › Form' labels", () => {
    const after = [
      { module: "Sales", form_name: "Sales Entry", allowed: true }, // unchanged
      { module: "Sales", form_name: "Sales Report", allowed: true }, // off → on
      { module: "Purchase", form_name: "Purchase Entry", allowed: false }, // on → off
    ];
    expect(diffFormPermissions(before, after)).toEqual([
      { field: "Sales › Sales Report", from: false, to: true },
      { field: "Purchase › Purchase Entry", from: true, to: false },
    ]);
  });

  it("treats a missing row as not allowed on either side", () => {
    const after = [
      { module: "Sales", form_name: "Sales Entry", allowed: true },
      { module: "Stock", form_name: "Stock View", allowed: true }, // new + allowed
      { module: "Bank", form_name: "Bank Entry", allowed: false }, // new + not allowed → no change
    ];
    // Purchase Entry (was allowed) is gone → turned off
    expect(diffFormPermissions(before, after)).toEqual([
      { field: "Purchase › Purchase Entry", from: true, to: false },
      { field: "Stock › Stock View", from: false, to: true },
    ]);
  });

  it("no changes → empty list", () => {
    expect(diffFormPermissions(before, before)).toEqual([]);
    expect(permissionLabel("A", "B")).toBe("A › B");
  });
});

describe("diffActivityPermissions", () => {
  it("only toggled flags", () => {
    expect(
      diffActivityPermissions(
        { can_view: true, can_edit: false, can_delete: false },
        { can_view: true, can_edit: true, can_delete: false },
      ),
    ).toEqual([{ field: "Activity › Edit", from: false, to: true }]);
  });

  it("no saved row = all off", () => {
    expect(diffActivityPermissions(undefined, { can_view: true, can_edit: false, can_delete: true })).toEqual([
      { field: "Activity › View", from: false, to: true },
      { field: "Activity › Delete", from: false, to: true },
    ]);
  });
});

describe("istDateRange (Asia/Kolkata)", () => {
  it("from = local midnight (18:30Z the day before)", () => {
    const { start, endExclusive } = istDateRange("2026-10-29", null);
    expect(start!.toISOString()).toBe("2026-10-28T18:30:00.000Z");
    expect(endExclusive).toBeNull();
  });

  it("to is inclusive → next local midnight, exclusive", () => {
    const { start, endExclusive } = istDateRange(undefined, "2026-10-29");
    expect(start).toBeNull();
    expect(endExclusive!.toISOString()).toBe("2026-10-29T18:30:00.000Z");
  });

  it("a single day spans exactly 24 hours", () => {
    const { start, endExclusive } = istDateRange("2026-03-31", "2026-03-31");
    expect(endExclusive!.getTime() - start!.getTime()).toBe(24 * 60 * 60 * 1000);
  });

  it("23:59 IST on the 'to' day is inside, 00:00 IST next day is outside", () => {
    const { endExclusive } = istDateRange("2026-10-01", "2026-10-29");
    const lastMinute = new Date("2026-10-29T23:59:00+05:30");
    const nextDay = new Date("2026-10-30T00:00:00+05:30");
    expect(lastMinute < endExclusive!).toBe(true);
    expect(nextDay < endExclusive!).toBe(false);
  });

  it("crosses month / year ends", () => {
    expect(istDateRange(null, "2026-12-31").endExclusive!.toISOString()).toBe("2026-12-31T18:30:00.000Z");
  });

  it("rejects malformed dates", () => {
    expect(() => istDateRange("29-10-2026", null)).toThrow();
    expect(() => istDateRange("2026-13-45", null)).toThrow();
  });
});

describe("likePattern", () => {
  it("wraps in % and escapes wildcards", () => {
    expect(likePattern(" chennai ")).toBe("%chennai%");
    expect(likePattern("50%_off\\")).toBe("%50\\%\\_off\\\\%");
  });
});
