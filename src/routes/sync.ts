import { Router } from "express";
import type { Request, Response } from "express";
import { timingSafeEqual } from "crypto";
import { db } from "@/db";
import { sql } from "drizzle-orm";
import { generateEntryNo } from "@/lib/entryNoGenerator";

export const syncRouter = Router();

// No fallback secret: an unset key disables the endpoint rather than leaving it open
// with a value that is committed to the repository.
const SYNC_SECRET_KEY = process.env.SYNC_SECRET_KEY;

if (!SYNC_SECRET_KEY) {
  console.warn(
    "[SyncRouter] SYNC_SECRET_KEY is not set — /api/sync/account will reject all requests.",
  );
}

/** Constant-time secret comparison, safe against length differences and non-string headers. */
function isAuthorized(header: unknown): boolean {
  if (!SYNC_SECRET_KEY || typeof header !== "string") return false;
  const a = Buffer.from(header);
  const b = Buffer.from(SYNC_SECRET_KEY);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

syncRouter.post("/account", async (req: Request, res: Response): Promise<void> => {
  if (!SYNC_SECRET_KEY) {
    res.status(503).json({ error: "Sync is not configured on this server" });
    return;
  }

  if (!isAuthorized(req.headers["x-sync-secret"])) {
    res.status(401).json({ error: "Unauthorized sync request" });
    return;
  }

  const payload = req.body;
  if (!payload || !payload.id || !payload.name || !payload.type) {
    res.status(400).json({ error: "Invalid payload: missing id, name, or type" });
    return;
  }

  const isDeleted = payload.is_deleted === true;

  try {
    // One transaction so the existence check, entry_no generation and write cannot
    // interleave with a concurrent local account creation.
    const action = await db.transaction(async (tx) => {
      const existing: any = await tx.execute(
        sql`SELECT id FROM accounts WHERE id = ${payload.id} LIMIT 1`
      );

      if (existing.length > 0) {
        // Update master details without touching opening balances or entry_no.
        // is_deleted is carried over so deletes and restores propagate.
        await tx.execute(sql`
          UPDATE accounts SET
            name = ${payload.name},
            customer_type = ${payload.customer_type ?? null},
            gst_no = ${payload.gst_no ?? null},
            pan_no = ${payload.pan_no ?? null},
            state_code = ${payload.state_code ?? null},
            place_of_supply = ${payload.place_of_supply ?? null},
            address = ${payload.address ?? null},
            phone = ${payload.phone ?? null},
            email = ${payload.email ?? null},
            website = ${payload.website ?? null},
            bank_name = ${payload.bank_name ?? null},
            bank_account_no = ${payload.bank_account_no ?? null},
            ifsc_code = ${payload.ifsc_code ?? null},
            default_tds_percent = ${payload.default_tds_percent ?? null},
            default_tcs_percent = ${payload.default_tcs_percent ?? null},
            is_deleted = ${isDeleted},
            updated_at = NOW()
          WHERE id = ${payload.id}
        `);

        return "updated";
      }

      // Not found by id — take the same advisory lock local creation uses so the two
      // paths cannot pick the same entry_no and violate accounts_type_entry_no_unique.
      const entry_no = await generateEntryNo(tx as any, "accounts", payload.type);

      await tx.execute(sql`
        INSERT INTO accounts (
          id, entry_no, name, type, customer_type, gst_no, pan_no, state_code,
          place_of_supply, address, phone, email, website, bank_name, bank_account_no,
          ifsc_code, default_tds_percent, default_tcs_percent, opening_pure_balance,
          opening_cash_balance, is_system_account, is_deleted
        ) VALUES (
          ${payload.id}, ${entry_no}, ${payload.name}, ${payload.type}, ${payload.customer_type ?? null},
          ${payload.gst_no ?? null}, ${payload.pan_no ?? null}, ${payload.state_code ?? null},
          ${payload.place_of_supply ?? null}, ${payload.address ?? null}, ${payload.phone ?? null},
          ${payload.email ?? null}, ${payload.website ?? null}, ${payload.bank_name ?? null},
          ${payload.bank_account_no ?? null}, ${payload.ifsc_code ?? null},
          ${payload.default_tds_percent ?? null}, ${payload.default_tcs_percent ?? null},
          '0', '0', false, ${isDeleted}
        )
      `);

      return "created";
    });

    res.json({ success: true, action, id: payload.id });
  } catch (err: any) {
    // A name clash against a locally-created account with the same name but a different
    // id is a data conflict for a human to resolve, not a retryable server fault.
    if (err?.constraint_name === "accounts_type_name_unique" || err?.constraint === "accounts_type_name_unique") {
      console.warn(`[SyncRouter] Name conflict syncing account ${payload.id} ("${payload.name}")`);
      res.status(409).json({
        error: `An account named "${payload.name}" already exists locally with a different id`,
        id: payload.id,
      });
      return;
    }

    console.error("[SyncRouter] Failed to sync account:", err);
    res.status(500).json({ error: "Failed to sync account to database", details: err?.message });
  }
});
