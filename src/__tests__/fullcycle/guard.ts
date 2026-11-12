// Safety guard for every full-cycle test suite. Import it FIRST in each
// *.fullcycle.test.ts — before "@/db" — so a suite can never write test bills
// into the real database:
//
//   import "@/__tests__/fullcycle/guard";
//
// The suites only run when DATABASE_URL names a throwaway "*_test" database
// (the one scripts/fulltest/run.mjs creates). Anything else stops the run.

const raw = process.env.DATABASE_URL ?? "";
let dbName = "";
try {
  dbName = decodeURIComponent(new URL(raw).pathname.replace(/^\//, ""));
} catch {
  dbName = "";
}

if (!/_test$/.test(dbName)) {
  throw new Error(
    `Full-cycle tests refused to run: DATABASE_URL points at "${dbName || "(none)"}", not a *_test database. ` +
      "Run them with: node scripts/fulltest/run.mjs",
  );
}

export const FULLTEST_DB = dbName;
