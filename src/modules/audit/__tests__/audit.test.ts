// ─────────────────────────────────────────────────────────────────────────────
// DATA AUDIT — pure unit tests (no database, no env).
// Canonical JSON, the hash chain (seal → verify → tamper), the "reason required"
// rule, the x-audit-reason header, the audit context store, and that the
// migration has a trigger for every audited table.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  canonicalJson,
  parseJsonExact,
  RawNumber,
  buildSeals,
  verifyRows,
  computeRowHash,
  chainKeyFromHex,
  GENESIS_HASH,
  type SealedRow,
} from "../chain";
import { requiresAuditReason, parseAuditReasonHeader } from "../reason";
import { runWithAuditContext, getAuditContext, auditSettingValues } from "../context";
import { AUDITED_TABLES, EXCLUDED_TABLES, isAuditedTable, tableLabel } from "../labels";

describe("canonicalJson", () => {
  it("sorts keys recursively and drops whitespace", () => {
    const a = canonicalJson({ b: 1, a: { d: [3, { z: true, y: null }], c: "x" } });
    const b = canonicalJson({ a: { c: "x", d: [3, { y: null, z: true }] }, b: 1 });
    expect(a).toBe('{"a":{"c":"x","d":[3,{"y":null,"z":true}]},"b":1}');
    expect(b).toBe(a);
  });

  it("keeps array order, drops undefined members, maps special values", () => {
    expect(canonicalJson([2, 1, undefined])).toBe("[2,1,null]");
    expect(canonicalJson({ a: undefined, b: 2 })).toBe('{"b":2}');
    expect(canonicalJson(new Date("2026-10-29T10:00:00.000Z"))).toBe('"2026-10-29T10:00:00.000Z"');
    expect(canonicalJson(12345678901234567890n)).toBe("12345678901234567890");
    expect(canonicalJson(Number.NaN)).toBe("null");
    expect(canonicalJson("é\"\n")).toBe(JSON.stringify("é\"\n"));
  });

  it("keeps exact numeric text from Postgres JSON (no float rounding)", () => {
    const text = '{"rate": 1234567890123.12345678, "qty": 1.50000000, "items": [{"b": 2, "a": -0.001}], "n": null}';
    const parsed = parseJsonExact(text) as Record<string, unknown>;
    expect(parsed.rate).toBeInstanceOf(RawNumber);
    expect(canonicalJson(parsed)).toBe(
      '{"items":[{"a":-0.001,"b":2}],"n":null,"qty":1.50000000,"rate":1234567890123.12345678}',
    );
  });

  it("parses strings with escapes and rejects malformed JSON", () => {
    expect(parseJsonExact('{"k": "a\\"b\\\\c\\u00e9", "t": true, "f": false}')).toEqual({ k: 'a"b\\cé', t: true, f: false });
    expect(() => parseJsonExact('{"a": 1')).toThrow();
    expect(() => parseJsonExact('{"a": 1} x')).toThrow();
  });
});

// ─── Hash chain ───────────────────────────────────────────────────────────────

const KEY = chainKeyFromHex("ab".repeat(32));

function makeRows(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: String(100 + i),
    content: JSON.stringify({
      id: 100 + i,
      table_name: "entry_groups",
      operation: i % 2 ? "UPDATE" : "INSERT",
      new_data: { bill_no: i + 1, rate_per_gram: "7000.00" },
      created_at: `2026-10-29T10:00:0${i}.123456+00:00`,
    }),
  }));
}

function sealed(n: number, key: Buffer | null = KEY): SealedRow[] {
  const rows = makeRows(n);
  const { seals } = buildSeals({ seq: 0n, hash: GENESIS_HASH }, rows, key);
  return seals.map((s, i) => ({
    seal_seq: s.seal_seq.toString(),
    id: s.id,
    created_at: new Date(`2026-10-29T10:00:0${i}.000Z`),
    prev_hash: s.prev_hash,
    row_hash: s.row_hash,
    content: rows[i]!.content,
  }));
}

describe("hash chain", () => {
  it("chainKeyFromHex accepts only 64 hex characters", () => {
    expect(chainKeyFromHex(undefined)).toBeNull();
    expect(chainKeyFromHex("abc")).toBeNull();
    expect(chainKeyFromHex("0F".repeat(32))?.length).toBe(32);
  });

  it("links rows: genesis, then prev_hash = previous row_hash, seal_seq 1..n", () => {
    const rows = sealed(4);
    expect(rows[0]!.prev_hash).toBe(GENESIS_HASH);
    for (let i = 1; i < rows.length; i++) expect(rows[i]!.prev_hash).toBe(rows[i - 1]!.row_hash);
    expect(rows.map((r) => String(r.seal_seq))).toEqual(["1", "2", "3", "4"]);
    expect(rows[0]!.row_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("continues from an existing head", () => {
    const first = buildSeals({ seq: 0n, hash: GENESIS_HASH }, makeRows(2), KEY);
    const next = buildSeals(first.head, makeRows(1), KEY);
    expect(next.seals[0]!.seal_seq).toBe(3n);
    expect(next.seals[0]!.prev_hash).toBe(first.head.hash);
  });

  it("verifies an intact chain (content as object or JSON text gives the same hash)", () => {
    expect(verifyRows(sealed(5), KEY)).toEqual({ ok: true, checked: 5 });
    const text = '{"b": 1, "a": 2}';
    expect(computeRowHash(GENESIS_HASH, canonicalJson(parseJsonExact(text)), KEY)).toBe(
      computeRowHash(GENESIS_HASH, canonicalJson({ a: 2, b: 1 }), KEY),
    );
  });

  it("detects a tampered row", () => {
    const rows = sealed(5);
    rows[2] = { ...rows[2]!, content: (rows[2]!.content as string).replace('"7000.00"', '"6000.00"') };
    const r = verifyRows(rows, KEY);
    expect(r.ok).toBe(false);
    expect(r.checked).toBe(2);
    expect(r.brokenAt?.seal_seq).toBe("3");
    expect(r.brokenAt?.id).toBe("102");
    expect(r.brokenAt?.created_at).toBeInstanceOf(Date);
  });

  it("detects a re-hashed row by the broken link to the next one", () => {
    const rows = sealed(4);
    const content = (rows[1]!.content as string).replace('"INSERT"', '"DELETE"').replace('"UPDATE"', '"DELETE"');
    const forged = computeRowHash(rows[1]!.prev_hash!, canonicalJson(parseJsonExact(content)), KEY);
    rows[1] = { ...rows[1]!, content, row_hash: forged };
    const r = verifyRows(rows, KEY);
    expect(r.ok).toBe(false);
    expect(r.brokenAt?.seal_seq).toBe("3");
  });

  it("detects a removed row (gap in seal_seq)", () => {
    const rows = sealed(5);
    rows.splice(2, 1);
    const r = verifyRows(rows, KEY);
    expect(r.ok).toBe(false);
    expect(r.brokenAt?.seal_seq).toBe("4");
  });

  it("anchors on the first remaining row after retention removed the oldest", () => {
    expect(verifyRows(sealed(6).slice(2), KEY)).toEqual({ ok: true, checked: 4 });
  });

  it("seal_seq 1 must start from the genesis hash", () => {
    const rows = sealed(3);
    rows[0] = { ...rows[0]!, prev_hash: "f".repeat(64) };
    expect(verifyRows(rows, KEY).brokenAt?.seal_seq).toBe("1");
  });

  it("a different key (or no key) does not verify a keyed chain", () => {
    expect(verifyRows(sealed(2), chainKeyFromHex("cd".repeat(32))).ok).toBe(false);
    expect(verifyRows(sealed(2), null).ok).toBe(false);
    expect(verifyRows(sealed(3, null), null)).toEqual({ ok: true, checked: 3 });
  });

  it("missing seal columns break the chain", () => {
    const rows = sealed(2);
    rows[1] = { ...rows[1]!, row_hash: null };
    expect(verifyRows(rows, KEY).brokenAt?.seal_seq).toBe("2");
  });
});

// ─── Reason required ──────────────────────────────────────────────────────────

describe("requiresAuditReason", () => {
  it.each([
    ["transactions.sales.update", true],
    ["transactions.sales.create", false],
    ["transactions.purchase.update", true],
    ["transactions.purchase.delete", true],
    ["transactions.purchase.updateGSTPurchaseConversion", true],
    ["transactions.purchase.undoGSTPurchaseConversion", true],
    ["transactions.sales.updateGSTConversion", true],
    ["transactions.sales.undoGSTConversion", true],
    ["transactions.labourBill.update", true],
    ["transactions.labourBill.delete", true],
    ["transactions.jobWork.update", true],
    ["transactions.jobWork.delete", true],
    ["transactions.expense.update", true],
    ["transactions.expense.delete", true],
    ["bank.transfer", false],
    ["bank.addFunds", false],
    ["bank.save", false],
    ["stock.deleteByLot", true],
    ["stock.addOpeningStock", false],
    // Melting register (GST CRM only): a saved stock voucher
    ["melting.update", false],
    ["melting.delete", false],
    ["melting.create", false],
    ["melting.metals.update", false],
    ["melting.metals.delete", false],
    ["settings.users.delete", false],
    ["settings.taxMaster.delete", false],
    ["accounts.update", false],
    ["accounts.delete", false],
    ["items.delete", false],
    ["transactions.sales.list", false],
    ["xtransactions.sales.update", false],
    // Gold CRM routers GST CRM does not have
    ["investment.delete", false],
    ["wages.deleteSettlement", false],
    ["transactions.purchase.setSupplierBill", false],
    // Payment on a saved bill
    ["transactions.purchase.settlePayment", true],
    ["transactions.sales.settlePayment", true],
    ["transactions.labourBill.settlePayment", false],
    ["transactions.purchase.settlePaymentX", false],
    ["xtransactions.sales.settlePayment", false],
    // Standalone account-level actions create new records — no reason
    ["transactions.labourBill.receiveCash", false],
    ["transactions.jobWork.receiveCash", false],
    ["transactions.labourBill.convertGoldToCash", false],
    ["transactions.jobWork.convertCashToGold", false],
    ["transactions.sales.convertGoldToCash", false],
    ["transactions.labourBill.createCycle", false],
    ["transactions.jobWork.createCycle", false],
  ] as const)("%s → %p", (path, expected) => {
    expect(requiresAuditReason(path)).toBe(expected);
  });
});

describe("parseAuditReasonHeader", () => {
  it("decodes encodeURIComponent'd text and trims it", () => {
    expect(parseAuditReasonHeader(encodeURIComponent("  Rate correction — ₹7,000/g  "))).toBe("Rate correction — ₹7,000/g");
    expect(parseAuditReasonHeader(encodeURIComponent("Line 1\nLine 2"))).toBe("Line 1\nLine 2");
  });

  it("enforces 3–500 characters after decoding", () => {
    expect(parseAuditReasonHeader(encodeURIComponent("ab"))).toBeNull();
    expect(parseAuditReasonHeader(encodeURIComponent("   ab   "))).toBeNull();
    expect(parseAuditReasonHeader(encodeURIComponent("abc"))).toBe("abc");
    expect(parseAuditReasonHeader(encodeURIComponent("x".repeat(500)))).toBe("x".repeat(500));
    expect(parseAuditReasonHeader(encodeURIComponent("x".repeat(501)))).toBeNull();
  });

  it("returns null for missing or malformed values", () => {
    expect(parseAuditReasonHeader(undefined)).toBeNull();
    expect(parseAuditReasonHeader(null)).toBeNull();
    expect(parseAuditReasonHeader("")).toBeNull();
    expect(parseAuditReasonHeader("%E0%A4%A")).toBeNull();
  });

  it("takes the first of repeated headers and strips control characters", () => {
    expect(parseAuditReasonHeader([encodeURIComponent("Wrong entry"), "other"])).toBe("Wrong entry");
    expect(parseAuditReasonHeader(encodeURIComponent("Wr\u0000ong\u0007 entry"))).toBe("Wrong entry");
  });
});

// ─── Audit context ────────────────────────────────────────────────────────────

describe("audit context", () => {
  it("is visible inside runWithAuditContext (across awaits) and gone outside", async () => {
    expect(getAuditContext()).toBeUndefined();
    const value = { userId: "u1", username: "anu", ip: "1.2.3.4", path: "transactions.sales.update", reason: "Wrong entry" };
    const seen = await runWithAuditContext(value, async () => {
      await new Promise((r) => setTimeout(r, 1));
      return getAuditContext();
    });
    expect(seen).toEqual(value);
    expect(getAuditContext()).toBeUndefined();
  });

  it("auditSettingValues fills blanks and fits the column widths", () => {
    const v = auditSettingValues({ userId: null, username: "u".repeat(150), ip: null, path: "p".repeat(200), reason: null });
    expect(v.userId).toBe("");
    expect(v.username.length).toBe(100);
    expect(v.ip).toBe("");
    expect(v.path.length).toBe(150);
    expect(v.reason).toBe("");
  });
});

// ─── Audited tables ↔ migration ───────────────────────────────────────────────

describe("audited tables", () => {
  // 0025 puts the trigger on every audited table; tables created after it must
  // get theirs in their own migration (add the file here).
  const migration = ["0025_data_audit.sql"]
    .map((f) => readFileSync(join(import.meta.dir, "..", "..", "..", "db", "migrations", f), "utf8"))
    .join("\n");

  it("every audited table has the gstcrm_audit trigger with its parent arguments", () => {
    for (const t of AUDITED_TABLES) {
      const args = t.parent ? `'${t.parent.table}', '${t.parent.column}'` : "'', ''";
      expect(migration).toContain(
        `CREATE TRIGGER gstcrm_audit AFTER INSERT OR UPDATE OR DELETE ON "${t.table}" FOR EACH ROW EXECUTE FUNCTION gstcrm_audit_row(${args});`,
      );
    }
    const triggerCount = migration.match(/CREATE TRIGGER gstcrm_audit /g)?.length ?? 0;
    expect(triggerCount).toBe(AUDITED_TABLES.length);
  });

  it("excluded tables are never audited and the lists don't overlap", () => {
    for (const t of EXCLUDED_TABLES) {
      expect(isAuditedTable(t)).toBe(false);
      expect(migration).not.toContain(`gstcrm_audit AFTER INSERT OR UPDATE OR DELETE ON "${t}"`);
    }
  });

  it("protects all four log tables", () => {
    for (const t of ["data_audit_log", "audit_logs", "login_history", "activity_logs"]) {
      expect(migration).toContain(`CREATE TRIGGER gstcrm_protect_update BEFORE UPDATE ON "${t}"`);
      expect(migration).toContain(`CREATE TRIGGER gstcrm_protect_delete BEFORE DELETE ON "${t}"`);
      expect(migration).toContain(`CREATE TRIGGER gstcrm_protect_truncate BEFORE TRUNCATE ON "${t}"`);
    }
  });

  it("labels are plain English", () => {
    expect(tableLabel("entries")).toBe("Bill item & payment lines");
    expect(tableLabel("unknown_table")).toBe("unknown_table");
  });
});
