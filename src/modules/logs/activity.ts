import { db } from "@/db";
import { activityLogs } from "@/db/schema";
import { parseUserAgent } from "@/modules/account/userAgent";
import { lookupRecordLabel } from "@/modules/audit/lookup";
import { deriveActivityMeta, recordLookupId } from "./helpers";

// ─── Activity log ─────────────────────────────────────────────────────────────
// Every tRPC mutation (wired in protectedProcedure) plus client-reported
// exports / prints. Inputs are NEVER stored — only the record_ref keys
// (entry_no, bill_no, voucher_no, invoice_no, ticket_no, id) are read.

export { deriveActivityMeta, findRecordRef } from "./helpers";

/** Procedures that write their own activity row (or must not be logged twice). */
const SKIP_PATHS: ReadonlySet<string> = new Set(["logs.logClientEvent"]);

export interface ActivityCtx {
  user: { id: string; username: string; did?: string | null } | null;
  ip?: string | null;
  userAgent?: string | null;
}

/** Fire-and-forget: never throws, never delays the response. */
export function recordMutation(opts: {
  ctx: ActivityCtx;
  path: string;
  ok: boolean;
  error?: string | null;
  input: unknown;
  result: unknown;
}): void {
  try {
    if (SKIP_PATHS.has(opts.path)) return;
    const result = opts.ok ? opts.result : undefined;
    const meta = deriveActivityMeta(opts.path, opts.input, result);
    const lookupId = recordLookupId(meta.recordRef, opts.input, result);
    const ua = parseUserAgent(opts.ctx.userAgent);
    void (async () => {
      // A uuid means nothing to a reader: show "Purchase · Bill No 3" instead
      // (falls back to the raw ref when the row can't be found / read).
      let recordRef = meta.recordRef;
      if (lookupId) {
        try {
          recordRef = (await lookupRecordLabel(lookupId)) ?? recordRef;
        } catch (err) {
          console.error(`[activity] Could not label record for ${opts.path}:`, err);
        }
      }
      await db.insert(activityLogs).values({
        user_id: opts.ctx.user?.id ?? null,
        username: opts.ctx.user?.username?.slice(0, 100) ?? null,
        module: meta.module,
        action: meta.action,
        procedure: meta.procedure,
        record_ref: recordRef?.slice(0, 100) ?? null,
        success: opts.ok,
        error: opts.ok ? null : (opts.error ?? "Failed").slice(0, 1000),
        ip: opts.ctx.ip?.slice(0, 45) ?? null,
        device_id: opts.ctx.user?.did ?? null,
        browser: ua.browser?.slice(0, 100) ?? null,
        os: ua.os?.slice(0, 100) ?? null,
      });
    })().catch((err: unknown) => console.error(`[activity] Failed to log ${opts.path}:`, err));
  } catch (err) {
    console.error(`[activity] Failed to log ${opts.path}:`, err);
  }
}

/** Client-reported export / print (logs.logClientEvent). Awaited by the caller. */
export async function recordClientEvent(opts: {
  ctx: ActivityCtx;
  module: string;
  action: "export" | "print";
  recordRef?: string | null;
}): Promise<void> {
  const ua = parseUserAgent(opts.ctx.userAgent);
  await db.insert(activityLogs).values({
    user_id: opts.ctx.user?.id ?? null,
    username: opts.ctx.user?.username?.slice(0, 100) ?? null,
    module: opts.module.slice(0, 50),
    action: opts.action,
    procedure: "logs.logClientEvent",
    record_ref: opts.recordRef?.trim().slice(0, 100) || null,
    success: true,
    error: null,
    ip: opts.ctx.ip?.slice(0, 45) ?? null,
    device_id: opts.ctx.user?.did ?? null,
    browser: ua.browser?.slice(0, 100) ?? null,
    os: ua.os?.slice(0, 100) ?? null,
  });
}
