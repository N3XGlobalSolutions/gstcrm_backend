import { AsyncLocalStorage } from "node:async_hooks";

// ─── Data audit: who is making this change ────────────────────────────────────
// protectedProcedure (src/lib/trpc.ts) runs each request inside
// runWithAuditContext(...). src/db/index.ts reads the store at the start of every
// db.transaction and copies it into transaction-local Postgres settings
// (gstcrm.user_id / username / ip / path / reason) that the gstcrm_audit_row()
// trigger stamps on every data_audit_log row. No store → actor "unknown".
//
// Kept free of db / env imports so it can be imported anywhere (incl. db/index.ts).

export interface AuditContextValue {
  userId: string | null;
  username: string | null;
  ip: string | null;
  /** tRPC path, e.g. "transactions.sales.update" (or a REST path). */
  path: string | null;
  /** Why the user changed / deleted a saved bill (x-audit-reason header). */
  reason: string | null;
}

export const auditContext = new AsyncLocalStorage<AuditContextValue>();

/** Run `fn` with `value` as the data-audit actor for every transaction it starts. */
export function runWithAuditContext<T>(value: AuditContextValue, fn: () => T): T {
  return auditContext.run(value, fn);
}

export function getAuditContext(): AuditContextValue | undefined {
  return auditContext.getStore();
}

/** Values for the gstcrm.* settings (column widths match data_audit_log). Empty string = not set. */
export function auditSettingValues(value: AuditContextValue): {
  userId: string;
  username: string;
  ip: string;
  path: string;
  reason: string;
} {
  return {
    userId: value.userId ?? "",
    username: (value.username ?? "").slice(0, 100),
    ip: (value.ip ?? "").slice(0, 45),
    path: (value.path ?? "").slice(0, 150),
    reason: (value.reason ?? "").slice(0, 500),
  };
}
