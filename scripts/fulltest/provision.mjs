// Provision / tear down an isolated throwaway Neon database for full-cycle bill
// testing. Prod `neondb` is never written to. Works over the pooler endpoint
// (CREATE DATABASE is permitted here).
//
//   node scripts/fulltest/provision.mjs create   -> create db + migrate + seed
//   node scripts/fulltest/provision.mjs drop     -> terminate + drop db
//   node scripts/fulltest/provision.mjs url      -> print TEST_DATABASE_URL only
import { config } from "dotenv";
import pg from "pg";
import { readFileSync, readdirSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

config();
const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, "..", "..", "src", "db", "migrations");
const TEST_DB = "goldcrm_fullcycle_test";
const raw = process.env.DATABASE_URL;
if (!raw) throw new Error("DATABASE_URL missing");

const adminUrl = new URL(raw); adminUrl.pathname = "/neondb";
const testUrl = new URL(raw); testUrl.pathname = "/" + TEST_DB;
const SSL = { rejectUnauthorized: false };

const SYSTEM_ACCOUNTS = [
  ["00000000-0000-0000-0000-000000000001", "Shop", "SHOP"],
  ["00000000-0000-0000-0000-000000000002", "Cash", "CASH"],
  ["00000000-0000-0000-0000-000000000003", "Bank", "BANK"],
  ["00000000-0000-0000-0000-000000000004", "Loss / Wastage", "LOSS"],
  ["00000000-0000-0000-0000-000000000005", "General Expense", "EXPENSE"],
  ["00000000-0000-0000-0000-000000000006", "Opening Stock", "OPENING_STOCK"],
];
const RUPEE_ID = "00000000-0000-0000-0000-000000000010";

async function migrateAndSeed() {
  const c = new pg.Client({ connectionString: testUrl.toString(), ssl: SSL });
  await c.connect();
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) {
    const sqlText = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
    const statements = sqlText.split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean);
    for (const stmt of statements) {
      try { await c.query(stmt); }
      catch (e) {
        // Ignore idempotency errors (type/table exists) so reruns are safe.
        if (!/already exists|duplicate/i.test(e.message)) {
          console.error(`MIGRATION FAIL in ${f}:`, e.message, "\n---\n", stmt.slice(0, 200));
          throw e;
        }
      }
    }
    console.log(`  applied ${f}`);
  }
  // Seed system accounts + RUPEE item (idempotent).
  for (let i = 0; i < SYSTEM_ACCOUNTS.length; i++) {
    const [id, name, type] = SYSTEM_ACCOUNTS[i];
    await c.query(
      `INSERT INTO accounts (id, entry_no, name, type, is_system_account)
       VALUES ($1,$2,$3,$4,true) ON CONFLICT (id) DO NOTHING`,
      [id, 1000001 + i, name, type]
    );
  }
  await c.query(
    `INSERT INTO items (id, entry_no, name, type, unit)
     VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO NOTHING`,
    [RUPEE_ID, 1000001, "Rupee", "MONEY", "RUPEE"]
  );
  // Seed a test user (sales service writes a notification referencing created_by).
  await c.query(
    `INSERT INTO app_users (id, entry_no, username, password_hash, user_group)
     VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO NOTHING`,
    ["00000000-0000-0000-0000-0000000000aa", 999001, "fulltest_user", "x", "admin"]
  );
  console.log("  seeded 6 system accounts + RUPEE item + test user");
  await c.end();
}

async function connectAdmin(retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const admin = new pg.Client({ connectionString: adminUrl.toString(), ssl: SSL });
      await admin.connect();
      return admin;
    } catch (e) {
      if (i === retries - 1) throw e;
      console.warn(`  admin connect failed (${e.message}) — retrying…`);
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
}

async function run() {
  const mode = process.argv[2] || "create";
  if (mode === "url") { console.log(testUrl.toString()); return; }

  const admin = await connectAdmin();

  if (mode === "drop") {
    await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${TEST_DB}' AND pid<>pg_backend_pid()`);
    await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
    console.log(`🗑️  dropped ${TEST_DB}`);
    await admin.end();
    return;
  }

  // create (fresh)
  const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname=$1", [TEST_DB]);
  if (exists.rowCount > 0) {
    await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${TEST_DB}' AND pid<>pg_backend_pid()`);
    await admin.query(`DROP DATABASE ${TEST_DB}`);
  }
  await admin.query(`CREATE DATABASE ${TEST_DB}`);
  await admin.end();
  console.log(`✅ created ${TEST_DB}`);
  await migrateAndSeed();
  console.log("✅ migrated + seeded");
  console.log("TEST_DATABASE_URL=" + testUrl.toString());
}

run().catch((e) => { console.error("PROVISION ERROR:", e.message); process.exit(1); });
