// ─── Plain-English record labels ──────────────────────────────────────────────
// "Purchase · Bill No 3", "Expense · Entry No 5", "Melting · Entry No 7",
// "Customer · Ravi Kumar", "Item · Ring 22K" — built from a row's columns as
// to_jsonb(row) gives them (the data_audit_log old_data / new_data copies, or a
// live row read the same way). Used by "Bill & Data History" (one row per save)
// and by the Activity log's Record column.
// Pure — no database / env imports.

export type RowData = Record<string, unknown>;

export interface RecordDescription {
  label: string;
  /** True when the label names the record (bill / entry / voucher number, a name …). */
  specific: boolean;
}

export const RECORD_LABEL_MAX = 100;
const SNIPPET_MAX = 60;

const ENTRY_GROUP_TYPE_LABELS: Record<string, string> = {
  SALE: "Sales",
  PURCHASE: "Purchase",
  JOB_WORK: "Job Work",
  LABOUR_BILL: "Labour Bill",
  EXPENSE: "Expense",
  OPENING: "Opening balance",
  REVERSAL: "Reversal",
  MELTING: "Melting",
};

/** accounts.type (non-CUSTOMER) → label. */
const ACCOUNT_TYPE_LABELS: Record<string, string> = {
  SHOP: "Shop account",
  CUSTOMER: "Customer",
  GOLDSMITH: "Employee",
  CASH: "Cash account",
  BANK: "Bank account",
  EXPENSE: "Expense head",
  LOSS: "Loss account",
  OPENING_STOCK: "Opening stock account",
};

/** accounts.customer_type → label (same words as the Customer master). */
const CUSTOMER_TYPE_LABELS: Record<string, string> = {
  CUSTOMER: "Customer",
  PURCHASER: "Purchaser",
  GOLD_SMITH: "Mc Customer",
  SALES_MAN: "Salesman",
  LABOUR_BILL: "Labour bill customer",
};

const BANK_KIND_LABELS: Record<string, string> = {
  DEPOSIT: "Bank deposit",
  WITHDRAWAL: "Bank withdrawal",
  TRANSFER_IN: "Bank transfer",
  TRANSFER_OUT: "Bank transfer",
};

/** A bill / entry / voucher number as text ("12"), or null when missing. */
function numberText(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  return null;
}

/** Trimmed, one-line, shortened free text, or null when empty. */
function snippet(value: unknown, max = SNIPPET_MAX): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

function clamp(label: string): string {
  return label.length > RECORD_LABEL_MAX ? `${label.slice(0, RECORD_LABEL_MAX - 1)}…` : label;
}

function named(prefix: string, name: unknown): RecordDescription {
  const text = snippet(name);
  return text ? { label: `${prefix} · ${text}`, specific: true } : { label: prefix, specific: false };
}

function numbered(prefix: string, caption: string, no: unknown): RecordDescription | null {
  const n = numberText(no);
  return n ? { label: `${prefix} · ${caption} ${n}`, specific: true } : null;
}

function describeEntryGroup(data: RowData): RecordDescription {
  const type = typeof data.type === "string" ? data.type : "";
  const prefix = ENTRY_GROUP_TYPE_LABELS[type] ?? "Bill";
  if (type === "REVERSAL") return { label: prefix, specific: false };
  if (type === "EXPENSE" || type === "OPENING") {
    return (
      numbered(prefix, "Entry No", data.entry_no) ??
      numbered(prefix, "Bill No", data.bill_no) ?? { label: prefix, specific: false }
    );
  }
  // Sales / Purchase / Labour Bill / Job Work: the printed invoice number is bill_no
  // (= entry_no). Unnumbered postings of these types (gold↔cash conversions, cash
  // receipts) are named by their remarks.
  return (
    numbered(prefix, "Bill No", data.bill_no) ??
    numbered(prefix, "Entry No", data.entry_no) ?? {
      label: snippet(data.remarks) ? `${prefix} · ${snippet(data.remarks)}` : prefix,
      specific: false,
    }
  );
}

function describeAccount(data: RowData): RecordDescription {
  const type = typeof data.type === "string" ? data.type : "";
  const customerType = typeof data.customer_type === "string" ? data.customer_type : "";
  const prefix =
    (type === "CUSTOMER" || !type ? CUSTOMER_TYPE_LABELS[customerType] : undefined) ??
    ACCOUNT_TYPE_LABELS[type] ??
    "Account";
  return named(prefix, data.name);
}

/**
 * Label of one row of an audited table, from its columns. null for tables whose
 * rows are not records on their own (bill item & payment lines) or unknown tables.
 */
export function describeRecord(table: string, data: RowData | null | undefined): RecordDescription | null {
  if (!data || typeof data !== "object") return null;
  let d: RecordDescription | null;
  switch (table) {
    case "entry_groups":
      d = describeEntryGroup(data);
      break;
    case "bank_transactions": {
      const kind = typeof data.kind === "string" ? data.kind : "";
      d = named(BANK_KIND_LABELS[kind] ?? "Bank entry", data.bank_label);
      break;
    }
    case "accounts":
      d = describeAccount(data);
      break;
    case "items":
      d = named("Item", data.name);
      break;
    case "metals":
      d = named("Metal", data.name);
      break;
    case "melting_entries":
      d = numbered("Melting", "Entry No", data.entry_no) ?? { label: "Melting", specific: false };
      break;
    case "labour_bill_cycles":
      d = numbered("Labour bill cycle", "Bill No", data.bill_no) ?? { label: "Labour bill cycle", specific: false };
      break;
    case "job_work_cycles":
      d = numbered("Job work cycle", "Bill No", data.bill_no) ?? { label: "Job work cycle", specific: false };
      break;
    case "gst_sales_history":
      d = numbered("Sales", "Bill No", data.bill_no) ?? { label: "Sales GST conversion", specific: false };
      break;
    case "gst_purchase_history":
      d = numbered("Purchase", "Bill No", data.bill_no) ?? { label: "Purchase GST conversion", specific: false };
      break;
    case "tax_master":
      d = named("Tax master", data.name);
      break;
    case "company_details":
      d = named("Company details", data.business_name ?? data.company_name);
      break;
    case "print_templates":
      d = named("Print template", data.template_name);
      break;
    default:
      d = null;
  }
  return d ? { label: clamp(d.label), specific: d.specific } : null;
}

/** describeRecord(...).label, or null. */
export function recordLabel(table: string, data: RowData | null | undefined): string | null {
  return describeRecord(table, data)?.label ?? null;
}

/**
 * Tables whose rows can be looked up by id to label an Activity log record, in
 * the order they are tried. All have a uuid `id` primary key.
 */
export const LOOKUP_TABLES = [
  "entry_groups",
  "melting_entries",
  "bank_transactions",
  "accounts",
  "items",
  "labour_bill_cycles",
  "job_work_cycles",
  "metals",
  "tax_master",
  "print_templates",
] as const;

export type LookupTable = (typeof LOOKUP_TABLES)[number];

const LOOKUP_SET: ReadonlySet<string> = new Set(LOOKUP_TABLES);

export function isLookupTable(table: string): table is LookupTable {
  return LOOKUP_SET.has(table);
}

/** A JSON object from its text (to_jsonb(row)::text), or null. */
export function parseRowData(text: unknown): RowData | null {
  if (typeof text !== "string") return null;
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as RowData) : null;
  } catch {
    return null;
  }
}

export const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_REGEX.test(value);
}
