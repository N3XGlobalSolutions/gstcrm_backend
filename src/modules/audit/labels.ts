// ─── Audited business tables ──────────────────────────────────────────────────
// Every table here has the gstcrm_audit AFTER INSERT/UPDATE/DELETE trigger
// (migration 0025_data_audit.sql; tables created later must get it in their own
// migration). `parent` = the header row a child row belongs to (trigger
// arguments); header tables point at themselves.
// Keep this list and the migration in sync (a unit test checks it).
// Pure — no database / env imports.

export interface AuditedTable {
  table: string;
  label: string;
  parent?: { table: string; column: string };
}

export const AUDITED_TABLES: readonly AuditedTable[] = [
  // Bills & vouchers
  { table: "entry_groups", label: "Bills & vouchers" },
  { table: "entries", label: "Bill item & payment lines", parent: { table: "entry_groups", column: "group_id" } },
  { table: "gst_sales_history", label: "Sales GST conversions", parent: { table: "entry_groups", column: "sale_id" } },
  { table: "gst_purchase_history", label: "Purchase GST conversions", parent: { table: "entry_groups", column: "purchase_id" } },
  { table: "labour_bill_cycles", label: "Labour bill cycles" },
  { table: "job_work_cycles", label: "Job work cycles" },
  { table: "bank_transactions", label: "Bank deposits, withdrawals & transfers" },
  // Melting register (GST CRM only)
  { table: "melting_entries", label: "Melting entries" },
  { table: "melting_lines", label: "Melting lines", parent: { table: "melting_entries", column: "melting_id" } },
  { table: "melting_alloys", label: "Melting alloys", parent: { table: "melting_entries", column: "melting_id" } },
  // Masters
  { table: "accounts", label: "Accounts (customers, suppliers, employees…)" },
  { table: "items", label: "Items" },
  { table: "metals", label: "Metals" },
  { table: "tax_master", label: "Tax master" },
  { table: "company_details", label: "Company details & banks" },
  { table: "print_templates", label: "Print templates" },
];

/**
 * Not audited row-by-row: auth / security / log tables (secrets, sessions,
 * permissions — admin changes to these already go to audit_logs), the logs
 * themselves and notifications.
 */
export const EXCLUDED_TABLES: readonly string[] = [
  "app_users",
  "user_form_permissions",
  "user_activity_permissions",
  "user_devices",
  "refresh_tokens",
  "login_attempts",
  "login_history",
  "activity_logs",
  "audit_logs",
  "data_audit_log",
  "notifications",
];

const LABELS = new Map(AUDITED_TABLES.map((t) => [t.table, t.label]));

export function isAuditedTable(table: string): boolean {
  return LABELS.has(table);
}

export function tableLabel(table: string): string {
  return LABELS.get(table) ?? table;
}
