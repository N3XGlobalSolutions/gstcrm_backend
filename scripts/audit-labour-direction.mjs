// READ-ONLY audit: Labour Bill / Issue & Job Works money lines saved in the
// old (wrong) direction, before the 2026-11-11 fix (bugs B2 / B4).
//
//   node scripts/audit-labour-direction.mjs           -> text report
//   node scripts/audit-labour-direction.mjs --json    -> same data as JSON
//
// Uses DATABASE_URL (from the environment, else .env). The session is put in
// READ ONLY mode and only SELECTs are run — nothing is written or changed.
//
// What counts as "old direction" (raw ledger sign: positive = party owes shop;
// an entry TO the party raises it, FROM the party lowers it):
//
//   LABOUR_BILL (the slip shows the raw balance)
//     Discount / TDS Adjustment  correct: party → SHOP   old: SHOP → party
//                                 balance off by +2 × amount (cash)
//     TCS Adjustment              correct: SHOP → party   old: party → SHOP
//                                 balance off by −2 × amount (cash)
//     In-bill "Cash conversion:"  correct: gold side party → SHOP (pure g)
//                                          + cash side SHOP → party (₹)
//                                 old: one cash line party → SHOP, no gold side
//                                 balance off by +g pure and −2 × amount cash
//
//   JOB_WORK (the slip shows −raw; its Discount/TDS/TCS directions were already
//   right — listed only if one is ever found the other way round)
//     Discount / TDS Adjustment  correct: SHOP → party   wrong: off −2 × amount
//     TCS Adjustment              correct: party → SHOP   wrong: off +2 × amount
//     In-bill "Cash conversion:"  correct: gold side SHOP → party (pure g)
//                                          + cash side party → SHOP (₹)
//                                 old: the cash line only → off by −g pure
//
// "Off by" = what the ledger shows now − what the bill screen showed
// (positive = the ledger says the party owes the shop more than it should).
// Only live bills (is_deleted = false) are read; an edited bill's old version is
// soft-deleted and cancelled by its REVERSAL group, so it nets to zero already.
import { config } from "dotenv";
import pg from "pg";

config({ quiet: true }); // quiet: keep --json output clean
const raw = process.env.DATABASE_URL;
if (!raw) throw new Error("DATABASE_URL missing");
const asJson = process.argv.includes("--json");

const RUPEE_ID = "00000000-0000-0000-0000-000000000010";
const SHOP_ID = "00000000-0000-0000-0000-000000000001";
const GOLD_SIDE_PREFIX = "Cash conversion: gold ";

const client = new pg.Client({ connectionString: raw, ssl: { rejectUnauthorized: false } });

function gramsOf(remark) {
  const m = /^Cash conversion:\s*([\d.]+)\s*g/i.exec(remark ?? "");
  return m ? Number.parseFloat(m[1]) || 0 : 0;
}

const round2 = (n) => Math.round(n * 100) / 100;
const round3 = (n) => Math.round(n * 1000) / 1000;

async function main() {
  await client.connect();
  try {
    // Belt and braces: every statement below is a SELECT, and the session
    // refuses writes anyway.
    await client.query("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY");
    const { rows: [dbRow] } = await client.query("SELECT current_database() AS db");

    const { rows } = await client.query(
      `SELECT g.id            AS group_id,
              g.type          AS bill_type,
              g.bill_no,
              g.entry_no,
              g.date::text    AS date,
              g.account_id,
              a.name          AS party,
              e.remarks,
              e.quantity::text AS quantity,
              e.from_account_id,
              e.to_account_id,
              EXISTS (
                SELECT 1 FROM entries e2
                WHERE e2.group_id = g.id
                  AND e2.item_id = $1
                  AND e2.remarks LIKE $3
              ) AS has_gold_side
         FROM entry_groups g
         JOIN entries e  ON e.group_id = g.id
         JOIN accounts a ON a.id = g.account_id
        WHERE g.type IN ('LABOUR_BILL', 'JOB_WORK')
          AND g.is_deleted = false
          AND e.item_id = $1
          AND (e.remarks IN ('Discount', 'TDS Adjustment', 'TCS Adjustment')
               OR (e.remarks LIKE 'Cash conversion:%' AND e.remarks NOT LIKE $3))
          AND (e.from_account_id = $2 OR e.to_account_id = $2)
        ORDER BY a.name, g.date, g.created_at, e.remarks`,
      [RUPEE_ID, SHOP_ID, `${GOLD_SIDE_PREFIX}%`],
    );

    const findings = [];
    for (const r of rows) {
      const qty = Number.parseFloat(r.quantity) || 0;
      const toParty = r.to_account_id === r.account_id;
      const fromParty = r.from_account_id === r.account_id;
      const isLabour = r.bill_type === "LABOUR_BILL";
      let cashOff = 0;
      let pureOff = 0;
      let entry = r.remarks;

      if (r.remarks === "Discount" || r.remarks === "TDS Adjustment") {
        if (isLabour && toParty) cashOff = 2 * qty;
        else if (!isLabour && fromParty) cashOff = -2 * qty;
        else continue;
      } else if (r.remarks === "TCS Adjustment") {
        if (isLabour && fromParty) cashOff = -2 * qty;
        else if (!isLabour && toParty) cashOff = 2 * qty;
        else continue;
      } else {
        // Cash side of an in-bill conversion. New-style bills always carry the
        // matching gold side ("Cash conversion: gold …"); old ones never do.
        if (r.has_gold_side || qty <= 0) continue;
        const grams = gramsOf(r.remarks);
        entry = `In-bill conversion (${r.remarks})`;
        if (isLabour) {
          pureOff = grams;
          cashOff = fromParty ? -2 * qty : 0; // old code always wrote party → SHOP
        } else {
          pureOff = -grams;
          cashOff = 0;
        }
      }

      findings.push({
        bill_type: r.bill_type,
        bill_no: r.bill_no,
        entry_no: r.entry_no,
        date: r.date,
        account_id: r.account_id,
        party: r.party,
        entry,
        amount: round2(qty),
        cash_off: round2(cashOff),
        pure_off: round3(pureOff),
      });
    }

    // Per-party totals + the party's current raw balance (same sums as
    // lib/balance.ts getAggregateBalances: totalPure / totalCash).
    const parties = new Map();
    for (const f of findings) {
      const p = parties.get(f.account_id) ?? { account_id: f.account_id, party: f.party, bills: new Set(), cash_off: 0, pure_off: 0 };
      p.bills.add(`${f.bill_type}:${f.entry_no}`);
      p.cash_off += f.cash_off;
      p.pure_off += f.pure_off;
      parties.set(f.account_id, p);
    }
    const totals = [];
    for (const p of parties.values()) {
      const { rows: [b] } = await client.query(
        `SELECT COALESCE(SUM(CASE WHEN to_account_id = $1 THEN pure_quantity
                                  WHEN from_account_id = $1 THEN -pure_quantity END), 0)::text AS pure,
                COALESCE(SUM(CASE WHEN item_id = $2 AND to_account_id = $1 THEN quantity
                                  WHEN item_id = $2 AND from_account_id = $1 THEN -quantity END), 0)::text AS cash
           FROM entries WHERE to_account_id = $1 OR from_account_id = $1`,
        [p.account_id, RUPEE_ID],
      );
      const pureNow = Number.parseFloat(b.pure) || 0;
      const cashNow = Number.parseFloat(b.cash) || 0;
      totals.push({
        party: p.party,
        account_id: p.account_id,
        bills: p.bills.size,
        cash_off: round2(p.cash_off),
        pure_off: round3(p.pure_off),
        ledger_cash_now: round2(cashNow),
        ledger_pure_now: round3(pureNow),
        cash_corrected: round2(cashNow - p.cash_off),
        pure_corrected: round3(pureNow - p.pure_off),
      });
    }

    if (asJson) {
      console.log(JSON.stringify({ database: dbRow.db, findings, totals }, null, 2));
      return;
    }

    console.log(`Database: ${dbRow.db}   (read-only audit — nothing is changed)`);
    console.log(`Old-direction lines on live Labour Bill / Job Work bills: ${findings.length}`);
    console.log("Sign: + = the ledger says the party owes the shop MORE than the bill screen showed.\n");
    if (findings.length === 0) {
      console.log("Nothing found.");
      return;
    }
    console.table(findings.map((f) => ({
      type: f.bill_type,
      bill_no: f.bill_no,
      entry_no: f.entry_no,
      date: f.date,
      party: f.party,
      entry: f.entry,
      amount: f.amount.toFixed(2),
      cash_off: f.cash_off.toFixed(2),
      pure_off: f.pure_off.toFixed(3),
    })));
    console.log("\nTotal per party (ledger now; corrected = what the bill screens showed):");
    console.table(totals.map((t) => ({
      party: t.party,
      bills: t.bills,
      cash_off: t.cash_off.toFixed(2),
      pure_off: t.pure_off.toFixed(3),
      ledger_cash: t.ledger_cash_now.toFixed(2),
      corrected_cash: t.cash_corrected.toFixed(2),
      ledger_pure: t.ledger_pure_now.toFixed(3),
      corrected_pure: t.pure_corrected.toFixed(3),
    })));
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error("Audit failed:", e.message);
  process.exit(1);
});
