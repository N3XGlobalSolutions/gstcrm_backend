// ─────────────────────────────────────────────────────────────────────────────
// "Bill & Data History" readability — pure unit tests (no database, no env).
// Plain-English record labels, save action derivation, picking the main record
// of a save, and folding audit rows into one row per save (tx_id).
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from "bun:test";
import { describeRecord, recordLabel, isUuid, parseRowData, RECORD_LABEL_MAX } from "../recordLabel";
import { deriveSaveAction, pickSaveRecord, groupSaves, dominantParent, type SaveSourceRow } from "../saves";

const G_OLD = "11111111-1111-4111-8111-111111111111";
const G_REV = "22222222-2222-4222-8222-222222222222";
const G_NEW = "33333333-3333-4333-8333-333333333333";
const T0 = new Date("2026-10-29T10:00:00.000Z");

function row(p: Partial<SaveSourceRow> & Pick<SaveSourceRow, "table_name" | "operation">): SaveSourceRow {
  return {
    tx_id: "100",
    record_id: null,
    parent_table: null,
    parent_id: null,
    old_data: null,
    new_data: null,
    actor_username: "ravi",
    ip: "10.0.0.1",
    request_path: null,
    reason: null,
    created_at: T0,
    ...p,
  };
}

/** The 14-ish rows of one purchase edit: old group soft-deleted + reversal + new group, with lines. */
function purchaseEditRows(): SaveSourceRow[] {
  const line = (group: string) =>
    row({ table_name: "entries", operation: "INSERT", record_id: crypto.randomUUID(), parent_table: "entry_groups", parent_id: group });
  return [
    row({
      table_name: "entry_groups", operation: "INSERT", record_id: G_REV, parent_table: "entry_groups", parent_id: G_REV,
      new_data: { id: G_REV, type: "REVERSAL", bill_no: null, entry_no: null, reversal_of: G_OLD, is_deleted: false },
    }),
    line(G_REV), line(G_REV), line(G_REV),
    row({
      table_name: "entry_groups", operation: "UPDATE", record_id: G_OLD, parent_table: "entry_groups", parent_id: G_OLD,
      old_data: { id: G_OLD, type: "PURCHASE", bill_no: 3, entry_no: 3, is_deleted: false },
      new_data: { id: G_OLD, type: "PURCHASE", bill_no: 3, entry_no: 3, is_deleted: true, reversed_by: G_REV },
      reason: "Wrong weight",
    }),
    row({
      table_name: "entry_groups", operation: "INSERT", record_id: G_NEW, parent_table: "entry_groups", parent_id: G_NEW,
      new_data: { id: G_NEW, type: "PURCHASE", bill_no: 3, entry_no: 3, is_deleted: false },
    }),
    line(G_NEW), line(G_NEW), line(G_NEW), line(G_NEW),
  ].map((r) => ({ ...r, request_path: "transactions.purchase.update", reason: "Wrong weight" }));
}

describe("describeRecord / recordLabel", () => {
  it("names bills by type and bill number", () => {
    expect(recordLabel("entry_groups", { type: "PURCHASE", bill_no: 3, entry_no: 3 })).toBe("Purchase · Bill No 3");
    expect(recordLabel("entry_groups", { type: "SALE", bill_no: 12, entry_no: 12 })).toBe("Sales · Bill No 12");
    expect(recordLabel("entry_groups", { type: "LABOUR_BILL", bill_no: 4 })).toBe("Labour Bill · Bill No 4");
    expect(recordLabel("entry_groups", { type: "JOB_WORK", bill_no: 9 })).toBe("Job Work · Bill No 9");
    expect(describeRecord("entry_groups", { type: "SALE", bill_no: 12 })?.specific).toBe(true);
  });

  it("uses the entry number for expenses and opening balances", () => {
    expect(recordLabel("entry_groups", { type: "EXPENSE", entry_no: 5, bill_no: 2 })).toBe("Expense · Entry No 5");
    expect(recordLabel("entry_groups", { type: "EXPENSE", entry_no: null, bill_no: 2 })).toBe("Expense · Bill No 2");
    expect(recordLabel("entry_groups", { type: "OPENING", entry_no: 1 })).toBe("Opening balance · Entry No 1");
  });

  it("names unnumbered postings by their remarks, reversals plainly", () => {
    expect(recordLabel("entry_groups", { type: "PURCHASE", bill_no: null, remarks: "Gold to Cash Conversion  @ 7200" })).toBe(
      "Purchase · Gold to Cash Conversion @ 7200",
    );
    expect(describeRecord("entry_groups", { type: "PURCHASE", bill_no: null })).toEqual({ label: "Purchase", specific: false });
    expect(describeRecord("entry_groups", { type: "REVERSAL", bill_no: null })).toEqual({ label: "Reversal", specific: false });
  });

  it("labels melting entries, bank entries and masters", () => {
    expect(recordLabel("melting_entries", { entry_no: 7 })).toBe("Melting · Entry No 7");
    expect(recordLabel("melting_entries", { entry_no: null })).toBe("Melting");
    expect(recordLabel("metals", { name: "Copper" })).toBe("Metal · Copper");
    expect(recordLabel("melting_lines", { weight: "10" })).toBeNull();
    expect(recordLabel("bank_transactions", { kind: "DEPOSIT", bank_label: "SBI - 1234" })).toBe("Bank deposit · SBI - 1234");
    expect(recordLabel("accounts", { type: "CUSTOMER", customer_type: "CUSTOMER", name: "Ravi Kumar" })).toBe("Customer · Ravi Kumar");
    expect(recordLabel("accounts", { type: "CUSTOMER", customer_type: "PURCHASER", name: "Sri Gold" })).toBe("Purchaser · Sri Gold");
    expect(recordLabel("accounts", { type: "CUSTOMER", customer_type: "GOLD_SMITH", name: "Mani" })).toBe("Mc Customer · Mani");
    expect(recordLabel("accounts", { type: "GOLDSMITH", customer_type: null, name: "Selvam" })).toBe("Employee · Selvam");
    expect(recordLabel("accounts", { type: "EXPENSE", name: "Tea" })).toBe("Expense head · Tea");
    expect(recordLabel("items", { name: "Ring 22K" })).toBe("Item · Ring 22K");
    expect(recordLabel("tax_master", { name: "GST 3%" })).toBe("Tax master · GST 3%");
    // Gold CRM-only tables are not labelled here
    expect(recordLabel("labour_vouchers", { voucher_no: 7 })).toBeNull();
    expect(recordLabel("investments", { entry_no: 3 })).toBeNull();
    expect(recordLabel("company_details", { business_name: "Sri Jewels" })).toBe("Company details · Sri Jewels");
  });

  it("labels GST conversion rows by their bill", () => {
    expect(recordLabel("gst_sales_history", { bill_no: "12" })).toBe("Sales · Bill No 12");
    expect(recordLabel("gst_purchase_history", { bill_no: "3" })).toBe("Purchase · Bill No 3");
  });

  it("has no label for line rows, unknown tables or missing data", () => {
    expect(recordLabel("entries", { quantity: "1" })).toBeNull();
    expect(recordLabel("app_users", { username: "x" })).toBeNull();
    expect(recordLabel("entry_groups", null)).toBeNull();
  });

  it("keeps labels within 100 characters", () => {
    const label = recordLabel("accounts", { type: "CUSTOMER", customer_type: "CUSTOMER", name: "x".repeat(300) })!;
    expect(label.length).toBeLessThanOrEqual(RECORD_LABEL_MAX);
    expect(label.endsWith("…")).toBe(true);
  });

  it("parses row JSON and recognises uuids", () => {
    expect(parseRowData('{"bill_no": 3}')).toEqual({ bill_no: 3 });
    expect(parseRowData("[1]")).toBeNull();
    expect(parseRowData("{bad")).toBeNull();
    expect(parseRowData(null)).toBeNull();
    expect(isUuid(G_OLD)).toBe(true);
    expect(isUuid("42")).toBe(false);
  });
});

describe("deriveSaveAction", () => {
  const ins = { operation: "INSERT", old_data: null, new_data: {} };
  const upd = { operation: "UPDATE", old_data: { is_deleted: false }, new_data: { is_deleted: false } };
  const softDel = { operation: "UPDATE", old_data: { is_deleted: false }, new_data: { is_deleted: true } };
  const del = { operation: "DELETE", old_data: {}, new_data: null };

  it("follows the procedure name", () => {
    expect(deriveSaveAction("transactions.sales.create", [upd])).toBe("created");
    expect(deriveSaveAction("transactions.purchase.update", [ins, softDel])).toBe("edited");
    expect(deriveSaveAction("transactions.sales.delete", [ins, softDel])).toBe("deleted");
    expect(deriveSaveAction("stock.deleteByLot", [upd])).toBe("deleted");
    expect(deriveSaveAction("transactions.sales.updateGSTSalesConversion", [ins])).toBe("converted");
    expect(deriveSaveAction("transactions.purchase.convertGoldToCash", [ins])).toBe("converted");
    expect(deriveSaveAction("transactions.purchase.undoGSTPurchaseConversion", [del])).toBe("converted");
  });

  it("otherwise follows what the rows did", () => {
    expect(deriveSaveAction("transactions.sales.settlePayment", [ins, ins])).toBe("created");
    expect(deriveSaveAction("orderVoucher.markDelivered", [upd])).toBe("edited");
    expect(deriveSaveAction("items.remove", [softDel])).toBe("deleted");
    expect(deriveSaveAction(null, [ins, del])).toBe("deleted");
    expect(deriveSaveAction(null, [])).toBe("other");
  });
});

describe("pickSaveRecord", () => {
  it("picks the new, numbered bill of an edit (not the old or reversal group)", () => {
    expect(pickSaveRecord(purchaseEditRows())).toEqual({ table: "entry_groups", id: G_NEW, label: "Purchase · Bill No 3" });
  });

  it("picks the deleted bill of a delete (soft-delete + reversal)", () => {
    const rows = purchaseEditRows().filter((r) => r.record_id !== G_NEW && r.parent_id !== G_NEW);
    expect(pickSaveRecord(rows)).toEqual({ table: "entry_groups", id: G_OLD, label: "Purchase · Bill No 3" });
  });

  it("prefers the bill over a bill cycle touched in the same save", () => {
    const rows = [
      row({ table_name: "labour_bill_cycles", operation: "INSERT", record_id: G_OLD, new_data: { bill_no: 7 } }),
      row({ table_name: "entry_groups", operation: "INSERT", record_id: G_NEW, new_data: { type: "LABOUR_BILL", bill_no: 4 } }),
    ];
    expect(pickSaveRecord(rows)?.label).toBe("Labour Bill · Bill No 4");
  });

  it("falls back to a GST conversion row's bill, else null", () => {
    const gst = row({
      table_name: "gst_sales_history", operation: "INSERT", record_id: G_REV, parent_table: "entry_groups", parent_id: G_OLD,
      new_data: { bill_no: "12", sale_id: G_OLD },
    });
    expect(pickSaveRecord([gst])).toEqual({ table: "entry_groups", id: G_OLD, label: "Sales · Bill No 12" });
    const line = row({ table_name: "entries", operation: "INSERT", record_id: G_REV, parent_table: "entry_groups", parent_id: G_OLD });
    expect(pickSaveRecord([line])).toBeNull();
    expect(dominantParent([line, line])).toEqual({ table: "entry_groups", id: G_OLD });
    expect(dominantParent([])).toBeNull();
  });

  it("names a melting save by its melting entry (not the MELTING stock group)", () => {
    const rows = [
      row({ table_name: "melting_entries", operation: "INSERT", record_id: G_OLD, new_data: { entry_no: 5 } }),
      row({ table_name: "entry_groups", operation: "INSERT", record_id: G_NEW, new_data: { type: "MELTING", remarks: "Melting #5" } }),
      row({ table_name: "melting_lines", operation: "INSERT", record_id: G_REV, parent_table: "melting_entries", parent_id: G_OLD }),
    ];
    expect(pickSaveRecord(rows)).toEqual({ table: "melting_entries", id: G_OLD, label: "Melting · Entry No 5" });
  });
});

describe("groupSaves", () => {
  it("folds a purchase edit into one readable save", () => {
    const [save] = groupSaves(purchaseEditRows(), ["100"]);
    expect(save).toEqual({
      tx_id: "100",
      created_at: T0,
      actor_username: "ravi",
      ip: "10.0.0.1",
      reason: "Wrong weight",
      request_path: "transactions.purchase.update",
      action: "edited",
      record: { table: "entry_groups", id: G_NEW, label: "Purchase · Bill No 3" },
      change_count: 10,
      tables: ["entry_groups", "entries"],
    });
  });

  it("keeps the given tx order, skips unknown tx ids and uses the earliest row", () => {
    const later = new Date(T0.getTime() + 1000);
    const rows = [
      row({ tx_id: "7", table_name: "items", operation: "UPDATE", record_id: G_OLD, new_data: { name: "Ring" }, created_at: later, actor_username: "b" }),
      row({ tx_id: "7", table_name: "items", operation: "UPDATE", record_id: G_OLD, new_data: { name: "Ring" }, created_at: T0, actor_username: "a" }),
      row({ tx_id: "9", table_name: "accounts", operation: "INSERT", record_id: G_NEW, new_data: { type: "CUSTOMER", customer_type: "CUSTOMER", name: "Ravi" } }),
    ];
    const saves = groupSaves(rows, ["9", "8", "7"]);
    expect(saves.map((s) => s.tx_id)).toEqual(["9", "7"]);
    expect(saves[0]!.action).toBe("created");
    expect(saves[0]!.record?.label).toBe("Customer · Ravi");
    expect(saves[1]!.created_at).toEqual(T0);
    expect(saves[1]!.actor_username).toBe("a");
    expect(saves[1]!.change_count).toBe(2);
    expect(saves[1]!.action).toBe("edited");
  });
});
