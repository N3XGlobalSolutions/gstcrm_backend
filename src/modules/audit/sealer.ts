import { sql, type SQL } from "drizzle-orm";
import { db, type Database } from "@/db";
import { env } from "@/config/env";
import { buildSeals, chainKeyFromHex, GENESIS_HASH, type ChainHead } from "./chain";

// ─── Hash-chain sealer ────────────────────────────────────────────────────────
// Every 60 s: give unsealed rows of data_audit_log ("data" chain) and audit_logs
// ("security" chain) their seal_seq / prev_hash / row_hash. Two separate chains.
// Runs inside a transaction that sets gstcrm.sealer = 'on' — the only way the
// tamper-protection trigger lets those three columns be written, and only once.
//
// Only one server instance seals at a time: pg_try_advisory_XACT_lock (the
// transaction-scoped form — a session-level advisory lock is not safe behind
// Neon's transaction-mode pooler). TimeZone is pinned to UTC in the transaction
// so to_jsonb() renders timestamps identically for the sealer and the verifier.

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

export type AuditChain = "data" | "security";

const BATCH_SIZE = 500;
const MAX_BATCHES_PER_TICK = 20;
const INTERVAL_MS = 60 * 1000;
/** pg advisory lock key space: (LOCK_NS, 1) data chain, (LOCK_NS, 2) security chain. */
const LOCK_NS = 0x60_1d_ad;

interface ChainSpec {
  table: SQL;
  lockKey: number;
  /** Unsealed rows in sealing order. */
  orderBy: SQL;
  /** Row content hashed: every column except the seal columns (and FK SET NULL columns). */
  content: SQL;
  idCast: SQL;
}

export const CHAINS: Record<AuditChain, ChainSpec> = {
  data: {
    table: sql.raw(`"data_audit_log"`),
    lockKey: 1,
    orderBy: sql.raw(`t."id"`),
    content: sql.raw(`(to_jsonb(t) - 'seal_seq' - 'prev_hash' - 'row_hash')::text`),
    idCast: sql.raw(`bigint`),
  },
  security: {
    table: sql.raw(`"audit_logs"`),
    lockKey: 2,
    orderBy: sql.raw(`t."created_at", t."id"`),
    // actor_user_id is ON DELETE SET NULL — left out so removing a user can't break the chain
    // (actor_username stays in the hash).
    content: sql.raw(`(to_jsonb(t) - 'seal_seq' - 'prev_hash' - 'row_hash' - 'actor_user_id')::text`),
    idCast: sql.raw(`uuid`),
  },
};

let warnedUnkeyed = false;

/** HMAC key from AUDIT_CHAIN_KEY; null (plain SHA-256) with a one-time warning when missing. */
export function getChainKey(): Buffer | null {
  const key = chainKeyFromHex(env.AUDIT_CHAIN_KEY);
  if (!key && !warnedUnkeyed) {
    warnedUnkeyed = true;
    console.warn(
      "[audit] AUDIT_CHAIN_KEY is not set — the audit hash chain is not keyed (plain SHA-256). " +
        "Set a 64-hex key (openssl rand -hex 32) before go-live; changing it later makes older rows fail verification.",
    );
  }
  return key;
}

/** Pin the transaction's TimeZone so to_jsonb(timestamptz) is rendered the same way every time. */
export async function pinUtc(tx: Tx): Promise<void> {
  await tx.execute(sql`select set_config('TimeZone', 'UTC', true)`);
}

async function readHead(tx: Tx, spec: ChainSpec): Promise<ChainHead> {
  const rows = await tx.execute<{ seal_seq: string; row_hash: string | null }>(
    sql`select h.seal_seq::text as seal_seq, h.row_hash from ${spec.table} h where h.seal_seq is not null order by h.seal_seq desc limit 1`,
  );
  const last = rows[0];
  if (!last) return { seq: 0n, hash: GENESIS_HASH };
  return { seq: BigInt(last.seal_seq), hash: last.row_hash ?? GENESIS_HASH };
}

/**
 * Seal up to BATCH_SIZE rows of one chain. Returns how many were sealed
 * (0 when another instance holds the lock or nothing is waiting).
 */
export async function sealBatch(chain: AuditChain, key: Buffer | null = getChainKey()): Promise<number> {
  const spec = CHAINS[chain];
  return db.transaction(async (tx) => {
    const [lock] = await tx.execute<{ locked: boolean }>(
      sql`select pg_try_advisory_xact_lock(${LOCK_NS}::int, ${spec.lockKey}::int) as locked`,
    );
    if (!lock?.locked) return 0;
    await tx.execute(sql`select set_config('gstcrm.sealer', 'on', true), set_config('TimeZone', 'UTC', true)`);

    const pending = await tx.execute<{ id: string; content: string }>(
      sql`select t.id::text as id, ${spec.content} as content from ${spec.table} t where t.seal_seq is null order by ${spec.orderBy} limit ${BATCH_SIZE}`,
    );
    if (pending.length === 0) return 0;

    const head = await readHead(tx, spec);
    const { seals } = buildSeals(
      head,
      pending.map((r) => ({ id: r.id, content: r.content })),
      key,
    );

    const values = sql.join(
      seals.map(
        (s) =>
          sql`(${s.id}::${spec.idCast}, ${s.seal_seq.toString()}::bigint, ${s.prev_hash}::varchar, ${s.row_hash}::varchar)`,
      ),
      sql`, `,
    );
    await tx.execute(
      sql`update ${spec.table} as t set seal_seq = v.seq, prev_hash = v.prev, row_hash = v.hash from (values ${values}) as v(id, seq, prev, hash) where t.id = v.id and t.seal_seq is null`,
    );
    return seals.length;
  });
}

/** Seal everything waiting on both chains (bounded per call). */
export async function sealPending(): Promise<{ data: number; security: number }> {
  const key = getChainKey();
  const out = { data: 0, security: 0 };
  for (const chain of ["data", "security"] as const) {
    for (let i = 0; i < MAX_BATCHES_PER_TICK; i++) {
      const n = await sealBatch(chain, key);
      out[chain] += n;
      if (n < BATCH_SIZE) break;
    }
  }
  return out;
}

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

async function tick() {
  if (running) return;
  running = true;
  try {
    await sealPending();
  } catch (err) {
    console.error("[audit] Sealing the audit hash chain failed:", err);
  } finally {
    running = false;
  }
}

/** Seals now, then every 60 seconds. Safe to call more than once. */
export function startAuditSealerJob(): void {
  if (timer) return;
  getChainKey(); // startup warning when the chain is not keyed
  void tick();
  timer = setInterval(() => void tick(), INTERVAL_MS);
  timer.unref?.();
}

export function stopAuditSealerJob(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
