// One-command full-cycle test runner.
//   node scripts/fulltest/run.mjs            → provision isolated DB, run all 3 suites, tear down
//   node scripts/fulltest/run.mjs --keep     → leave the test DB up afterwards for inspection
//
// Never touches prod `neondb` — spins up a throwaway `goldcrm_fullcycle_test`
// database, points the app's DATABASE_URL at it, runs the suites, then drops it.
import { config } from "dotenv";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

config();
const __dirname = dirname(fileURLToPath(import.meta.url));
const provision = join(__dirname, "provision.mjs");
const keep = process.argv.includes("--keep");

const TEST_DB = "goldcrm_fullcycle_test";
const testUrl = new URL(process.env.DATABASE_URL);
testUrl.pathname = "/" + TEST_DB;

function step(label, cmd, args, env) {
  console.log(`\n▶ ${label}`);
  const r = spawnSync(cmd, args, { stdio: "inherit", env: { ...process.env, ...env }, shell: process.platform === "win32" });
  return r.status ?? 1;
}

let exit = 0;
try {
  if (step("Provisioning isolated test DB", "node", [provision, "create"]) !== 0) throw new Error("provision failed");
  exit = step(
    "Running full-cycle suites (Sales · Purchase · Labour)",
    "bun",
    ["test", "--timeout", "60000",
      "src/modules/transactions/__tests__/sales.fullcycle.test.ts",
      "src/modules/transactions/__tests__/purchase.fullcycle.test.ts",
      "src/modules/transactions/__tests__/labour.fullcycle.test.ts"],
    { DATABASE_URL: testUrl.toString() }
  );
} finally {
  if (!keep) step("Tearing down isolated test DB", "node", [provision, "drop"]);
  else console.log(`\nℹ️  --keep set: ${TEST_DB} left running. Drop with: node scripts/fulltest/provision.mjs drop`);
}
process.exit(exit);
