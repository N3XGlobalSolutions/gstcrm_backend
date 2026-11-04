import { db, type Database } from "@/db";
import { auditLogs } from "@/db/schema";

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
type DbOrTx = Database | Tx;

// ─── Audit log ────────────────────────────────────────────────────────────────
// Security + admin changes with old → new values. Never pass password hashes,
// 2FA secrets, tokens or backup codes in `changes`.

export type AuditChange = { field: string; from: unknown; to: unknown };

export interface AuditEntry {
  actor: { id: string; username: string } | null; // null = system / CLI
  action: string; // e.g. "user_created", "permissions_changed", "account_locked"
  targetType: string; // e.g. "user", "permissions", "company_details", "ip", "password_policy"
  targetId?: string | null;
  targetLabel?: string | null;
  changes?: AuditChange[] | null;
  reason?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

/** Write one audit row. Pass `dbx` = the transaction when the change itself runs in one. */
export async function writeAuditLog(entry: AuditEntry, dbx: DbOrTx = db): Promise<void> {
  await dbx.insert(auditLogs).values({
    actor_user_id: entry.actor?.id ?? null,
    actor_username: entry.actor?.username ?? "system",
    action: entry.action,
    target_type: entry.targetType,
    target_id: entry.targetId ?? null,
    target_label: entry.targetLabel?.slice(0, 200) ?? null,
    changes: entry.changes && entry.changes.length ? entry.changes : null,
    reason: entry.reason ?? null,
    ip: entry.ip ?? null,
    user_agent: entry.userAgent?.slice(0, 500) ?? null,
  });
}

/**
 * Old → new list for the given fields; unchanged fields are skipped.
 * Values are compared by JSON so numbers/strings/dates/null compare sensibly.
 */
export function diffFields<T extends object>(
  before: Partial<T> | null | undefined,
  after: Partial<T> | null | undefined,
  fields: (keyof T & string)[],
): AuditChange[] {
  const changes: AuditChange[] = [];
  for (const field of fields) {
    const from = before?.[field] ?? null;
    const to = after?.[field] ?? null;
    if (JSON.stringify(from) !== JSON.stringify(to)) changes.push({ field, from, to });
  }
  return changes;
}
