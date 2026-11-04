// ─── Logs: pure helpers (no database, no env) ─────────────────────────────────
// Kept free of db/env imports so they can be unit-tested directly.

import type { AuditChange } from "./audit";
import { isUuid } from "@/modules/audit/recordLabel";

// ─── Activity: module / action / record_ref ───────────────────────────────────

/** Keys looked up (in this order) on the input, then the result, for record_ref. */
export const RECORD_REF_KEYS = [
  "entry_no",
  "bill_no",
  "voucher_no",
  "invoice_no",
  "ticket_no",
  "id",
] as const;

export interface ActivityMeta {
  module: string;
  action: string;
  procedure: string;
  recordRef: string | null;
}

function scalarRef(source: unknown, key: string): string | null {
  if (!source || typeof source !== "object" || Array.isArray(source)) return null;
  const value = (source as Record<string, unknown>)[key];
  if (typeof value === "string" && value.trim() !== "") return value.trim().slice(0, 100);
  if (typeof value === "number" && Number.isFinite(value)) return String(value).slice(0, 100);
  if (typeof value === "bigint") return value.toString().slice(0, 100);
  return null;
}

/**
 * First of entry_no, bill_no, voucher_no, invoice_no, ticket_no, id found on the
 * input or the result (input first for each key). Only these keys are ever read
 * — nothing else of the input is looked at or stored.
 */
export function findRecordRef(input: unknown, result: unknown): string | null {
  for (const key of RECORD_REF_KEYS) {
    const ref = scalarRef(input, key) ?? scalarRef(result, key);
    if (ref) return ref;
  }
  return null;
}

/**
 * The uuid to look up for a readable record label ("Purchase · Bill No 3"):
 * the record_ref itself when it is a uuid, else the `id` on the input / result
 * when that is a uuid (a bare "42" entry number gains its bill type). null when
 * there is nothing to look up.
 */
export function recordLookupId(recordRef: string | null, input: unknown, result: unknown): string | null {
  if (isUuid(recordRef)) return recordRef;
  const id = scalarRef(input, "id") ?? scalarRef(result, "id");
  return isUuid(id) ? id : null;
}

/**
 * "transactions.sales.create" → module "sales", action "create";
 * "settings.users.delete" → module "settings", action "delete".
 */
export function deriveActivityMeta(path: string, input: unknown, result: unknown): ActivityMeta {
  const parts = path.split(".").filter(Boolean);
  const first = parts[0] ?? "unknown";
  const module = first === "transactions" && parts.length > 2 ? parts[1]! : first;
  const action = parts[parts.length - 1] ?? "unknown";
  return {
    module: module.slice(0, 50),
    action: action.slice(0, 50),
    procedure: path.slice(0, 150),
    recordRef: findRecordRef(input, result),
  };
}

// ─── Permissions diff ─────────────────────────────────────────────────────────

export interface FormPermissionRow {
  module: string;
  form_name: string;
  allowed: boolean;
}

/** "Sales › Sales Entry" */
export function permissionLabel(module: string, formName: string): string {
  return `${module} › ${formName}`;
}

/**
 * Only the toggled entries between the saved rows and the new set. A form
 * missing on either side counts as not allowed (that is how checks treat it).
 */
export function diffFormPermissions(
  before: FormPermissionRow[],
  after: FormPermissionRow[],
): AuditChange[] {
  const key = (r: FormPermissionRow) => `${r.module}\u0000${r.form_name}`;
  const beforeMap = new Map<string, FormPermissionRow>();
  for (const r of before) beforeMap.set(key(r), r);
  const afterMap = new Map<string, FormPermissionRow>();
  for (const r of after) afterMap.set(key(r), r);

  const changes: AuditChange[] = [];
  const seen = new Set<string>();
  for (const [k, r] of [...beforeMap, ...afterMap]) {
    if (seen.has(k)) continue;
    seen.add(k);
    const from = beforeMap.get(k)?.allowed ?? false;
    const to = afterMap.get(k)?.allowed ?? false;
    if (from !== to) changes.push({ field: permissionLabel(r.module, r.form_name), from, to });
  }
  return changes;
}

export interface ActivityPermissionFlags {
  can_view: boolean;
  can_edit: boolean;
  can_delete: boolean;
}

const ACTIVITY_FLAG_LABELS: Array<[keyof ActivityPermissionFlags, string]> = [
  ["can_view", "Activity › View"],
  ["can_edit", "Activity › Edit"],
  ["can_delete", "Activity › Delete"],
];

/** Toggled View / Edit / Delete flags (a missing row = all off). */
export function diffActivityPermissions(
  before: ActivityPermissionFlags | null | undefined,
  after: ActivityPermissionFlags,
): AuditChange[] {
  const changes: AuditChange[] = [];
  for (const [flag, field] of ACTIVITY_FLAG_LABELS) {
    const from = before?.[flag] ?? false;
    const to = after[flag];
    if (from !== to) changes.push({ field, from, to });
  }
  return changes;
}

// ─── Date filters (Asia/Kolkata) ──────────────────────────────────────────────
// India has no daylight saving, so a local day is always [00:00 +05:30, next 00:00 +05:30).

export const LOG_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

function istMidnight(date: string): Date {
  if (!LOG_DATE_REGEX.test(date)) throw new Error(`Invalid date "${date}" (expected YYYY-MM-DD)`);
  const d = new Date(`${date}T00:00:00+05:30`);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid date "${date}"`);
  return d;
}

/**
 * Inclusive local dates → timestamp bounds: created_at >= start AND created_at < endExclusive.
 * Either bound may be missing.
 */
export function istDateRange(
  from?: string | null,
  to?: string | null,
): { start: Date | null; endExclusive: Date | null } {
  return {
    start: from ? istMidnight(from) : null,
    endExclusive: to ? new Date(istMidnight(to).getTime() + DAY_MS) : null,
  };
}

// ─── Search ───────────────────────────────────────────────────────────────────

/** "%text%" for ILIKE, with %, _ and \ in the text matched literally. */
export function likePattern(search: string): string {
  return `%${search.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

// ─── Login events ─────────────────────────────────────────────────────────────

export const LOGIN_EVENTS = [
  "login_success",
  "login_failed",
  "mfa_success",
  "mfa_failed",
  "mfa_locked",
  "account_locked",
  "password_change_required",
  "password_changed",
  "logout",
] as const;
