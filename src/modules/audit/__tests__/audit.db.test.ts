/**
 * Integration test: Logs + Bill & Data History against a real Postgres.
 *
 * Covers the gstcrm_audit_row() trigger (actor / reason stamping, updated_at-only
 * updates skipped), the tamper protection on the log tables, the hash-chain
 * sealer + verifier, retention, login history, the activity log and the
 * logs.* / dataAudit.* routers (incl. the "reason required" rule).
 *
 * Point DATABASE_URL at a throwaway test database before running — the guard
 * below refuses anything that isn't a *_test DB.
 *
 *   DATABASE_URL='postgresql://.../goldcrm_fullcycle_test?...' \
 *     bun test --timeout 60000 src/modules/audit/__tests__/audit.db.test.ts
 */
import { beforeAll, describe, expect, it } from "bun:test";

const DB_URL = process.env.DATABASE_URL ?? "";
if (!/\/[^/?]*_test(\?|$)/.test(DB_URL)) {
  throw new Error(
    `Refusing to run: DATABASE_URL does not point at a *_test database (got db "${
      DB_URL.split("/").pop()?.split("?")[0]
    }")`,
  );
}

// Loaded lazily so the guard above runs before any DB module is imported.
let db: typeof import("@/db").db;
let schema: typeof import("@/db/schema");
let orm: typeof import("drizzle-orm");
let auditCtx: typeof import("../context");
let itemsQ: typeof import("@/modules/items/queries");
let sealer: typeof import("../sealer");
let verify: typeof import("../verify");
let logsAudit: typeof import("@/modules/logs/audit");
let retention: typeof import("@/modules/logs/retention");
let loginHistory: typeof import("@/modules/account/loginHistory");
let appRouter: typeof import("@/app.router").appRouter;

// Seeded by scripts/fulltest/provision.mjs
const USER_ID = "00000000-0000-0000-0000-0000000000aa";
const RUN = `AUDIT-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function caller(auditReason: string | null = null) {
  return appRouter.createCaller({
    user: { id: USER_ID, username: "superadmin", user_group: "admin" },
    ip: "10.1.2.3",
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
    auditReason,
  });
}

async function auditRowsFor(table: string, recordId: string) {
  const { and, eq, asc } = orm;
  return db
    .select()
    .from(schema.dataAuditLog)
    .where(and(eq(schema.dataAuditLog.table_name, table), eq(schema.dataAuditLog.record_id, recordId)))
    .orderBy(asc(schema.dataAuditLog.id));
}

beforeAll(async () => {
  ({ db } = await import("@/db"));
  schema = await import("@/db/schema");
  orm = await import("drizzle-orm");
  auditCtx = await import("../context");
  itemsQ = await import("@/modules/items/queries");
  sealer = await import("../sealer");
  verify = await import("../verify");
  logsAudit = await import("@/modules/logs/audit");
  retention = await import("@/modules/logs/retention");
  loginHistory = await import("@/modules/account/loginHistory");
  ({ appRouter } = await import("@/app.router"));
});

describe("data audit trigger", () => {
  it("stamps the actor, path and reason of the request on every row change", async () => {
    const item = await auditCtx.runWithAuditContext(
      { userId: USER_ID, username: "fulltest_user", ip: "10.0.0.9", path: "items.create", reason: "Opening the shop" },
      () => itemsQ.insertItem({ entry_no: 900000 + Math.floor(Math.random() * 99999), name: `${RUN} Ring`, type: "ORNAMENT", unit: "GRAM" }),
    );
    const rows = await auditRowsFor("items", item.id);
    expect(rows.length).toBe(1);
    const r = rows[0]!;
    expect(r.operation).toBe("INSERT");
    expect(r.actor_user_id).toBe(USER_ID);
    expect(r.actor_username).toBe("fulltest_user");
    expect(r.ip).toBe("10.0.0.9");
    expect(r.request_path).toBe("items.create");
    expect(r.reason).toBe("Opening the shop");
    expect(r.parent_table).toBe("items");
    expect(r.parent_id).toBe(item.id);
    expect((r.new_data as Record<string, unknown>).name).toBe(`${RUN} Ring`);

    // A real change is recorded with its changed fields …
    await auditCtx.runWithAuditContext(
      { userId: USER_ID, username: "fulltest_user", ip: null, path: "items.update", reason: null },
      () => itemsQ.updateItemName(item.id, `${RUN} Ring 22K`),
    );
    // … an updated_at-only update is not; a change outside any request is "unknown".
    await db.transaction((tx) => tx.update(schema.items).set({ updated_at: new Date() }).where(orm.eq(schema.items.id, item.id)));
    await itemsQ.softDeleteItem(item.id);

    const after = await auditRowsFor("items", item.id);
    expect(after.map((a) => a.operation)).toEqual(["INSERT", "UPDATE", "UPDATE"]);
    expect(after[1]!.changed_fields).toContain("name");
    expect(after[1]!.changed_fields).not.toContain("updated_at");
    expect(after[1]!.actor_username).toBe("fulltest_user");
    expect(after[2]!.changed_fields).toContain("is_deleted");
    expect(after[2]!.actor_username).toBe("unknown");
    expect(after[2]!.actor_user_id).toBeNull();
    // One save = one tx_id
    expect(after[0]!.tx_id).not.toBe(after[1]!.tx_id);
  });

  it("child rows point at their header (melting line → melting entry)", async () => {
    const res = await db.execute<{ trigger: string }>(orm.sql`
      select tgname as trigger from pg_trigger t join pg_class c on c.oid = t.tgrelid
       where c.relname = 'melting_lines' and tgname = 'gstcrm_audit'`);
    expect(res.length).toBe(1);
  });
});

describe("tamper protection", () => {
  it("refuses UPDATE / DELETE / TRUNCATE on the log tables", async () => {
    const [row] = await db.select({ id: schema.dataAuditLog.id }).from(schema.dataAuditLog).limit(1);
    expect(row).toBeDefined();
    await expect(
      db.execute(orm.sql`update data_audit_log set actor_username = 'mallory' where id = ${row!.id.toString()}::bigint`),
    ).rejects.toThrow();
    await expect(db.execute(orm.sql`delete from data_audit_log where id = ${row!.id.toString()}::bigint`)).rejects.toThrow();
    await expect(db.execute(orm.sql`truncate data_audit_log`)).rejects.toThrow();
    await expect(db.execute(orm.sql`truncate audit_logs`)).rejects.toThrow();
    await expect(db.execute(orm.sql`truncate login_history`)).rejects.toThrow();
    await expect(db.execute(orm.sql`truncate activity_logs`)).rejects.toThrow();
  });

  it("refuses a retention delete of a row younger than the floor", async () => {
    await expect(
      db.transaction(async (tx) => {
        await tx.execute(orm.sql`select set_config('gstcrm.retention', 'on', true)`);
        await tx.execute(orm.sql`delete from data_audit_log where created_at > now() - interval '1 day'`);
      }),
    ).rejects.toThrow();
  });
});

describe("hash chain", () => {
  it("seals both chains and verifies them intact; a sealed row can't be re-sealed", async () => {
    await logsAudit.writeAuditLog({
      actor: { id: USER_ID, username: "fulltest_user" },
      action: "user_created",
      targetType: "user",
      targetLabel: `${RUN} user`,
      changes: [{ field: "username", from: null, to: `${RUN} user` }],
    });
    const sealed = await sealer.sealPending();
    expect(sealed.data).toBeGreaterThan(0);
    expect(sealed.security).toBeGreaterThan(0);

    const data = await verify.verifyChain("data");
    expect(data.ok).toBe(true);
    expect(data.checked).toBeGreaterThan(0);
    expect(data.unsealed).toBe(0);
    const security = await verify.verifyChain("security");
    expect(security.ok).toBe(true);

    // Even the sealer can't rewrite a sealed row.
    await expect(
      db.transaction(async (tx) => {
        await tx.execute(orm.sql`select set_config('gstcrm.sealer', 'on', true)`);
        await tx.execute(orm.sql`update data_audit_log set row_hash = repeat('0', 64) where seal_seq = 1`);
      }),
    ).rejects.toThrow();
  });
});

describe("retention", () => {
  it("runs and keeps everything younger than the floors", async () => {
    const r = await retention.runLogRetention();
    expect(r).toEqual({ loginHistory: 0, activityLogs: 0, auditLogs: 0, dataAudit: 0 });
  });
});

describe("routers", () => {
  it("refuses an edit / delete of a saved bill without a reason", async () => {
    await expect(
      caller(null).transactions.expense.delete({ id: "33333333-3333-4333-8333-333333333333" } as never),
    ).rejects.toThrow("Please give a reason for this change.");
    await expect(
      caller(null).melting.delete({ id: "33333333-3333-4333-8333-333333333333" } as never),
    ).rejects.toThrow("Please give a reason for this change.");
    // With a reason the rule passes (and the missing bill is reported instead).
    let message = "";
    try {
      await caller("Entered twice").transactions.expense.delete({ id: "33333333-3333-4333-8333-333333333333" } as never);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).not.toContain("Please give a reason");
  });

  it("logs every mutation in the activity log and reads it back", async () => {
    const created = await caller().items.create({ name: `${RUN} Chain`, type: "ORNAMENT", unit: "GRAM" } as never);
    expect(created).toBeDefined();
    let found: { rows: Array<{ module: string; action: string; record_ref: string | null; username: string | null; browser: string | null }> } | null = null;
    for (let i = 0; i < 20; i++) {
      await sleep(250);
      found = await caller().logs.activity({ page: 1, pageSize: 10, module: "items", action: "create", search: "items.create" });
      if (found.rows.length > 0) break;
    }
    expect(found!.rows.length).toBeGreaterThan(0);
    const row = found!.rows[0]!;
    expect(row.username).toBe("superadmin");
    expect(row.browser).toBe("Chrome 141");
    expect(row.record_ref).toContain("Item ·");

    // Bill & Data History: the create is a save with a readable record
    const saves = await caller().dataAudit.listSaves({ page: 1, pageSize: 10, table: "items", search: `${RUN} Chain` });
    expect(saves.total).toBeGreaterThan(0);
    expect(saves.rows[0]!.action).toBe("created");
    expect(saves.rows[0]!.record?.label).toBe(`Item · ${RUN} Chain`);
    expect(saves.rows[0]!.actor_username).toBe("superadmin");
    const detail = await caller().dataAudit.saveDetail({ txId: saves.rows[0]!.tx_id });
    expect(detail.changes.length).toBeGreaterThan(0);
    const history = await caller().dataAudit.recordHistory({ table: "items", id: saves.rows[0]!.record!.id });
    expect(history.events.length).toBe(1);
    const list = await caller().dataAudit.list({ page: 1, pageSize: 10, table: "items" });
    expect(list.total).toBeGreaterThan(0);
    const tables = await caller().dataAudit.tables();
    expect(tables.map((t) => t.table)).toContain("melting_entries");
  });

  it("login history, audit log, filter options and verify", async () => {
    await loginHistory.recordLoginEvent({
      userId: USER_ID,
      username: "fulltest_user",
      event: "login_failed",
      reason: "wrong_password",
      method: "password",
      ip: "192.168.1.5",
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    });
    const lh = await caller().logs.loginHistory({ page: 1, pageSize: 10, userId: USER_ID, event: "login_failed" });
    expect(lh.total).toBeGreaterThan(0);
    expect(lh.rows[0]!.country).toBe("Local network");
    expect(lh.rows[0]!.device_type).toBe("mobile");

    const audit = await caller().logs.audit({ page: 1, pageSize: 10, action: "user_created", search: RUN });
    expect(audit.total).toBe(1);

    const opts = await caller().logs.filterOptions();
    expect(opts.loginEvents).toContain("mfa_failed"); // same filter list as Gold CRM
    expect(opts.modules).toContain("items");

    const v = await caller().dataAudit.verify({ chain: "data" });
    expect(v.ok).toBe(true);

    await expect(
      appRouter
        .createCaller({ user: { id: USER_ID, username: "fulltest_user", user_group: "admin" } })
        .logs.audit({ page: 1, pageSize: 10 }),
    ).rejects.toThrow("Only superadmin");

    const ev = await caller().logs.logClientEvent({ module: "sales", action: "print", recordRef: "Bill 12" });
    expect(ev.success).toBe(true);
  });
});
