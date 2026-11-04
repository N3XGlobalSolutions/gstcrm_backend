import { createHash, createHmac } from "node:crypto";

// ─── Audit hash chain: pure helpers (no database, no env) ─────────────────────
// Each sealed row stores prev_hash (the previous row's row_hash, 64 zeros for the
// first row ever) and row_hash = HMAC-SHA256(key, prev_hash + canonicalJson(row)),
// or plain SHA-256 when no AUDIT_CHAIN_KEY is configured. Chain order is
// seal_seq (1, 2, 3 … with no gaps), NOT id.
//
// The row content comes from Postgres as JSON text
// (to_jsonb(row) - 'seal_seq' - 'prev_hash' - 'row_hash')::text and is parsed
// with parseJsonExact so NUMERIC values keep every digit (a JS double would
// silently round numeric(20,8) values).

export const GENESIS_HASH = "0".repeat(64);

/** A JSON number kept as its exact source text. */
export class RawNumber {
  constructor(readonly raw: string) {}
}

/**
 * Deterministic JSON: object keys sorted (by UTF-16 code units) at every level,
 * no whitespace, arrays in order. undefined object members are dropped (as in
 * JSON.stringify); undefined array items become null. Dates → ISO strings,
 * bigint → integer literal, RawNumber → its exact text.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (value instanceof RawNumber) return value.raw;
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "number":
      return Number.isFinite(value) ? JSON.stringify(value) : "null";
    case "boolean":
      return value ? "true" : "false";
    case "bigint":
      return value.toString();
    case "object":
      break;
    default:
      return "null"; // functions / symbols
  }
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) {
    return `[${value.map((v) => (v === undefined ? "null" : canonicalJson(v))).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

/**
 * JSON.parse that keeps numbers as RawNumber (exact digits). Strings, objects,
 * arrays, true/false/null as usual. Throws on malformed input.
 */
export function parseJsonExact(text: string): unknown {
  let i = 0;
  const n = text.length;

  const ws = () => {
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09) i++;
      else break;
    }
  };
  const fail = (msg: string): never => {
    throw new SyntaxError(`Invalid JSON at ${i}: ${msg}`);
  };

  const parseString = (): string => {
    // text[i] === '"' — find the closing quote, honouring escapes, then let JSON.parse decode it.
    const start = i;
    i++;
    while (i < n) {
      const c = text[i];
      if (c === "\\") i += 2;
      else if (c === '"') {
        i++;
        return JSON.parse(text.slice(start, i)) as string;
      } else i++;
    }
    return fail("unterminated string");
  };

  const parseValue = (): unknown => {
    ws();
    if (i >= n) fail("unexpected end");
    const c = text[i];
    if (c === "{") {
      i++;
      const out: Record<string, unknown> = {};
      ws();
      if (text[i] === "}") {
        i++;
        return out;
      }
      for (;;) {
        ws();
        if (text[i] !== '"') fail("expected key");
        const key = parseString();
        ws();
        if (text[i] !== ":") fail("expected ':'");
        i++;
        out[key] = parseValue();
        ws();
        if (text[i] === ",") {
          i++;
          continue;
        }
        if (text[i] === "}") {
          i++;
          return out;
        }
        fail("expected ',' or '}'");
      }
    }
    if (c === "[") {
      i++;
      const arr: unknown[] = [];
      ws();
      if (text[i] === "]") {
        i++;
        return arr;
      }
      for (;;) {
        arr.push(parseValue());
        ws();
        if (text[i] === ",") {
          i++;
          continue;
        }
        if (text[i] === "]") {
          i++;
          return arr;
        }
        fail("expected ',' or ']'");
      }
    }
    if (c === '"') return parseString();
    if (text.startsWith("true", i)) {
      i += 4;
      return true;
    }
    if (text.startsWith("false", i)) {
      i += 5;
      return false;
    }
    if (text.startsWith("null", i)) {
      i += 4;
      return null;
    }
    const m = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(i, i + 400));
    if (!m) return fail("unexpected token");
    i += m[0].length;
    return new RawNumber(m[0]);
  };

  const value = parseValue();
  ws();
  if (i !== n) fail("trailing characters");
  return value;
}

/** Hash key from AUDIT_CHAIN_KEY (64 hex) — null = unkeyed SHA-256. */
export function chainKeyFromHex(hex: string | undefined | null): Buffer | null {
  if (!hex) return null;
  return /^[0-9a-fA-F]{64}$/.test(hex) ? Buffer.from(hex, "hex") : null;
}

/** row_hash for one row: HMAC-SHA256(key, prev + canonical) or SHA-256(prev + canonical). */
export function computeRowHash(prevHash: string, canonicalContent: string, key: Buffer | null): string {
  const h = key ? createHmac("sha256", key) : createHash("sha256");
  h.update(prevHash, "utf8");
  h.update(canonicalContent, "utf8");
  return h.digest("hex");
}

/** Row content (object, or JSON text from Postgres) → canonical JSON. */
export function canonicalContent(content: unknown): string {
  return canonicalJson(typeof content === "string" ? parseJsonExact(content) : content);
}

// ─── Sealing ──────────────────────────────────────────────────────────────────

export interface ChainHead {
  /** Last sealed seal_seq (0n when nothing is sealed yet). */
  seq: bigint;
  /** Its row_hash (GENESIS_HASH when nothing is sealed yet). */
  hash: string;
}

export interface SealAssignment {
  id: string;
  seal_seq: bigint;
  prev_hash: string;
  row_hash: string;
}

/** Seal `rows` (in the order given) onto the chain after `head`. */
export function buildSeals(
  head: ChainHead,
  rows: Array<{ id: string; content: unknown }>,
  key: Buffer | null,
): { seals: SealAssignment[]; head: ChainHead } {
  let seq = head.seq;
  let prev = head.hash;
  const seals: SealAssignment[] = [];
  for (const row of rows) {
    seq += 1n;
    const hash = computeRowHash(prev, canonicalContent(row.content), key);
    seals.push({ id: row.id, seal_seq: seq, prev_hash: prev, row_hash: hash });
    prev = hash;
  }
  return { seals, head: { seq, hash: prev } };
}

// ─── Verification ─────────────────────────────────────────────────────────────

export interface SealedRow {
  seal_seq: bigint | string;
  id: string;
  created_at: Date | string;
  prev_hash: string | null;
  row_hash: string | null;
  content: unknown;
}

export interface ChainBreak {
  seal_seq: string;
  id: string;
  created_at: Date;
  message: string;
}

/**
 * Incremental verifier — push rows in seal_seq order (page by page).
 * The first row anchors the chain on its own prev_hash (older rows may have been
 * removed by retention), except seal_seq 1 which must start from GENESIS_HASH.
 */
export function createChainVerifier(key: Buffer | null) {
  let last: { seq: bigint; hash: string } | null = null;
  let checked = 0;
  let broken: ChainBreak | null = null;

  const breakAt = (row: SealedRow, seq: bigint, message: string): ChainBreak => {
    broken = {
      seal_seq: seq.toString(),
      id: String(row.id),
      created_at: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
      message,
    };
    return broken;
  };

  return {
    /** Returns the break (and stops checking) at the first bad row; null while intact. */
    push(row: SealedRow): ChainBreak | null {
      if (broken) return broken;
      const seq = BigInt(row.seal_seq);
      const label = `record #${seq}`;
      if (!row.prev_hash || !row.row_hash) {
        return breakAt(row, seq, `The seal of ${label} is missing.`);
      }
      if (last) {
        if (seq !== last.seq + 1n) {
          return breakAt(row, seq, `Records are missing before ${label} (expected #${last.seq + 1n}).`);
        }
        if (row.prev_hash !== last.hash) {
          return breakAt(row, seq, `The chain link before ${label} does not match — a record was changed or removed.`);
        }
      } else if (seq === 1n && row.prev_hash !== GENESIS_HASH) {
        return breakAt(row, seq, `The first record does not start the chain.`);
      }
      let expected: string;
      try {
        expected = computeRowHash(row.prev_hash, canonicalContent(row.content), key);
      } catch {
        return breakAt(row, seq, `The content of ${label} could not be read.`);
      }
      if (expected !== row.row_hash) {
        return breakAt(row, seq, `${label[0]!.toUpperCase()}${label.slice(1)} was changed after it was sealed.`);
      }
      last = { seq, hash: row.row_hash };
      checked++;
      return null;
    },
    get checked() {
      return checked;
    },
    get broken(): ChainBreak | null {
      return broken;
    },
  };
}

/** Convenience: verify a whole in-memory list (sorted by seal_seq). */
export function verifyRows(rows: SealedRow[], key: Buffer | null): { ok: boolean; checked: number; brokenAt?: ChainBreak } {
  const v = createChainVerifier(key);
  for (const row of rows) {
    const b = v.push(row);
    if (b) return { ok: false, checked: v.checked, brokenAt: b };
  }
  return { ok: true, checked: v.checked };
}
