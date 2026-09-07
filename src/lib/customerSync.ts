import dotenv from "dotenv";
dotenv.config();

const REMOTE_SYNC_URL = process.env.REMOTE_SYNC_URL;
const SYNC_SECRET_KEY = process.env.SYNC_SECRET_KEY;

/** Abandon a sync attempt rather than leaving the request hanging on an unresponsive peer. */
const SYNC_TIMEOUT_MS = 10_000;

if (REMOTE_SYNC_URL && !SYNC_SECRET_KEY) {
  console.warn(
    "[CustomerSync] REMOTE_SYNC_URL is set but SYNC_SECRET_KEY is not — outbound customer sync is disabled.",
  );
}

export interface SyncAccountPayload {
  id: string;
  name: string;
  type: string;
  customer_type?: string | null;
  gst_no?: string | null;
  pan_no?: string | null;
  state_code?: string | null;
  place_of_supply?: string | null;
  address?: string | null;
  phone?: string | null;
  email?: string | null;
  website?: string | null;
  bank_name?: string | null;
  bank_account_no?: string | null;
  ifsc_code?: string | null;
  default_tds_percent?: string | null;
  default_tcs_percent?: string | null;
  /** Propagates soft deletes and restores to the peer. */
  is_deleted?: boolean;
}

/**
 * Asynchronously syncs customer account master data to the remote peer CRM backend.
 * Best-effort side-effect: never throws or blocks local execution.
 */
export async function syncAccountToRemote(payload: SyncAccountPayload): Promise<void> {
  if (!REMOTE_SYNC_URL || !SYNC_SECRET_KEY) {
    return;
  }

  try {
    const targetUrl = `${REMOTE_SYNC_URL.replace(/\/+$/, "")}/api/sync/account`;
    const res = await fetch(targetUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Sync-Secret": SYNC_SECRET_KEY,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(SYNC_TIMEOUT_MS),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      console.warn(`[CustomerSync] Remote sync failed with status ${res.status}: ${errText}`);
    }
  } catch (err: any) {
    console.warn(`[CustomerSync] Failed to sync account ${payload.id} to remote: ${err?.message || err}`);
  }
}
