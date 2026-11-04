import { sql } from "drizzle-orm";
import { db } from "@/db";
import { createChainVerifier } from "./chain";
import { CHAINS, getChainKey, pinUtc, type AuditChain } from "./sealer";

// ─── Verify a hash chain ──────────────────────────────────────────────────────
// Walk the sealed rows in seal_seq order, recompute every row_hash and check the
// links. The first remaining row anchors the chain on its own prev_hash (older
// rows may have been removed by retention). Reports the first mismatch or gap.

const PAGE = 2000;

export interface ChainVerifyResult {
  ok: boolean;
  checked: number;
  unsealed: number;
  brokenAt?: { seal_seq: string; id: string; created_at: Date };
  message: string;
}

export async function verifyChain(chain: AuditChain): Promise<ChainVerifyResult> {
  const spec = CHAINS[chain];
  const key = getChainKey();

  return db.transaction(async (tx) => {
    await pinUtc(tx);
    const [countRow] = await tx.execute<{ n: string }>(
      sql`select count(*)::text as n from ${spec.table} where seal_seq is null`,
    );
    const unsealed = Number(countRow?.n ?? 0);

    const verifier = createChainVerifier(key);
    let after = -1n;
    for (;;) {
      const rows = await tx.execute<{
        seal_seq: string;
        id: string;
        created_at: Date | string;
        prev_hash: string | null;
        row_hash: string | null;
        content: string;
      }>(
        sql`select t.seal_seq::text as seal_seq, t.id::text as id, t.created_at, t.prev_hash, t.row_hash, ${spec.content} as content
            from ${spec.table} t
            where t.seal_seq is not null and t.seal_seq > ${after.toString()}::bigint
            order by t.seal_seq
            limit ${PAGE}`,
      );
      for (const row of rows) {
        const broken = verifier.push(row);
        if (broken) {
          return {
            ok: false,
            checked: verifier.checked,
            unsealed,
            brokenAt: { seal_seq: broken.seal_seq, id: broken.id, created_at: broken.created_at },
            message: broken.message,
          };
        }
      }
      if (rows.length < PAGE) break;
      after = BigInt(rows[rows.length - 1]!.seal_seq);
    }

    const checked = verifier.checked;
    const waiting = unsealed > 0 ? ` (${unsealed} newer record${unsealed === 1 ? "" : "s"} not sealed yet)` : "";
    return {
      ok: true,
      checked,
      unsealed,
      message:
        checked === 0
          ? `No sealed records yet${waiting}.`
          : `All ${checked} record${checked === 1 ? "" : "s"} intact${waiting}.`,
    };
  });
}
