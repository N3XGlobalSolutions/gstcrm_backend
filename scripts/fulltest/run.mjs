// One-command full-cycle transaction test runner for gstcrm.
//   node scripts/fulltest/run.mjs            → provision isolated DB, run every suite, tear down
//   node scripts/fulltest/run.mjs --keep     → leave the test DB up afterwards for inspection
//
// Never touches the real `neondb`: it creates a throwaway `gstcrm_fullcycle_test`
// database on the same server, points the app's DATABASE_URL at it, runs the
// suites, then drops it. Each suite also refuses to run unless DATABASE_URL
// names a *_test database (see src/__tests__/fullcycle/guard.ts).
import { config } from "dotenv";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join, relative } from "path";
import { readdirSync, statSync } from "fs";

config();
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const provision = join(__dirname, "provision.mjs");
const keep = process.argv.includes("--keep");

const TEST_DB = process.env.FULLTEST_DB || "gstcrm_fullcycle_test";
const testUrl = new URL(process.env.DATABASE_URL);
testUrl.pathname = "/" + TEST_DB;

// Every *.fullcycle.test.ts under src/, plus the older DB-backed edit tests.
function findSuites(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...findSuites(p));
    else if (name.endsWith(".fullcycle.test.ts")) out.push(relative(ROOT, p).replace(/\\/g, "/"));
  }
  return out;
}
const suites = [
  ...findSuites(join(ROOT, "src")).sort(),
  "src/modules/transactions/__tests__/labourBill.edit.test.ts",
  "src/modules/transactions/__tests__/jobWork.edit.test.ts",
];

function step(label, cmd, args, env) {
  console.log(`\n▶ ${label}`);
  const r = spawnSync(cmd, args, {
    stdio: "inherit",
    cwd: ROOT,
    env: { ...process.env, FULLTEST_DB: TEST_DB, ...env },
    shell: process.platform === "win32",
  });
  return r.status ?? 1;
}

let exit = 0;
try {
  if (step("Provisioning isolated test DB", "node", [provision, "create"]) !== 0) throw new Error("provision failed");
  // One bun process per suite: suites close the shared DB pool in afterAll,
  // so running them in one process cuts the connection for the next file.
  const results = [];
  for (const suite of suites) {
    const code = step(`Suite: ${suite}`, "bun", ["test", "--timeout", "120000", suite], {
      DATABASE_URL: testUrl.toString(),
    });
    results.push([suite, code]);
    if (code !== 0) exit = 1;
  }
  console.log("\n══ Summary ══");
  for (const [suite, code] of results) console.log(`${code === 0 ? "PASS" : "FAIL"}  ${suite}`);
} finally {
  if (!keep) step("Tearing down isolated test DB", "node", [provision, "drop"]);
  else console.log(`\nℹ️  --keep set: ${TEST_DB} left running. Drop with: node scripts/fulltest/provision.mjs drop`);
}
process.exit(exit);
