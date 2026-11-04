CREATE TABLE "data_audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tx_id" bigint NOT NULL,
	"table_name" varchar(63) NOT NULL,
	"record_id" text,
	"parent_table" varchar(63),
	"parent_id" text,
	"operation" varchar(6) NOT NULL,
	"old_data" jsonb,
	"new_data" jsonb,
	"changed_fields" text[],
	"actor_user_id" uuid,
	"actor_username" varchar(100) DEFAULT 'unknown' NOT NULL,
	"ip" varchar(45),
	"request_path" varchar(150),
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"seal_seq" bigint,
	"prev_hash" varchar(64),
	"row_hash" varchar(64),
	CONSTRAINT "data_audit_log_seal_seq_unique" UNIQUE("seal_seq")
);
--> statement-breakpoint
ALTER TABLE "audit_logs" ADD COLUMN "seal_seq" bigint;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD COLUMN "prev_hash" varchar(64);--> statement-breakpoint
ALTER TABLE "audit_logs" ADD COLUMN "row_hash" varchar(64);--> statement-breakpoint
CREATE INDEX "data_audit_log_parent_idx" ON "data_audit_log" USING btree ("parent_table","parent_id");--> statement-breakpoint
CREATE INDEX "data_audit_log_record_idx" ON "data_audit_log" USING btree ("table_name","record_id");--> statement-breakpoint
CREATE INDEX "data_audit_log_created_at_idx" ON "data_audit_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "data_audit_log_tx_id_idx" ON "data_audit_log" USING btree ("tx_id");--> statement-breakpoint
CREATE INDEX "data_audit_log_actor_idx" ON "data_audit_log" USING btree ("actor_user_id");--> statement-breakpoint
CREATE INDEX "data_audit_log_unsealed_idx" ON "data_audit_log" USING btree ("id") WHERE "data_audit_log"."seal_seq" IS NULL;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_seal_seq_unique" UNIQUE("seal_seq");
--> statement-breakpoint
-- ─── Hand-written below this line (data audit triggers) ──────────────────────
-- The sealer picks unsealed security-audit rows in (created_at, id) order.
CREATE INDEX IF NOT EXISTS "audit_logs_unsealed_idx" ON "audit_logs" USING btree ("created_at","id") WHERE "seal_seq" IS NULL;
--> statement-breakpoint
-- gstcrm_audit_row(): AFTER INSERT/UPDATE/DELETE FOR EACH ROW on every business table.
--   TG_ARGV[0] = parent table ('' = the row is its own header)
--   TG_ARGV[1] = column holding the parent id ('' = none)
--   TG_ARGV[2] = primary-key column (optional, default 'id')
-- Actor comes from transaction-local settings set by src/db/index.ts
-- (gstcrm.user_id / username / ip / path / reason); missing → NULL / 'unknown'.
-- UPDATEs where nothing but updated_at changed are not recorded.
CREATE OR REPLACE FUNCTION gstcrm_audit_row() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_old jsonb;
  v_new jsonb;
  v_row jsonb;
  v_changed text[];
  v_parent_table text;
  v_parent_col text;
  v_id_col text;
  v_record_id text;
  v_parent_id text;
  v_uid_text text;
  v_uid uuid;
BEGIN
  v_parent_table := NULLIF(TG_ARGV[0], '');
  v_parent_col := NULLIF(TG_ARGV[1], '');
  v_id_col := COALESCE(NULLIF(TG_ARGV[2], ''), 'id');

  IF TG_OP = 'INSERT' THEN
    v_new := to_jsonb(NEW);
    v_row := v_new;
  ELSIF TG_OP = 'UPDATE' THEN
    v_old := to_jsonb(OLD);
    v_new := to_jsonb(NEW);
    v_row := v_new;
    SELECT array_agg(e.key ORDER BY e.key) INTO v_changed
      FROM jsonb_each(v_new) AS e(key, value)
     WHERE e.key <> 'updated_at'
       AND e.value IS DISTINCT FROM (v_old -> e.key);
    IF v_changed IS NULL THEN
      RETURN NULL; -- only updated_at (or nothing) changed
    END IF;
  ELSE
    v_old := to_jsonb(OLD);
    v_row := v_old;
  END IF;

  v_record_id := v_row ->> v_id_col;
  IF v_parent_table IS NOT NULL AND v_parent_col IS NOT NULL AND (v_row ->> v_parent_col) IS NOT NULL THEN
    v_parent_id := v_row ->> v_parent_col;
  ELSE
    v_parent_table := TG_TABLE_NAME;
    v_parent_id := v_record_id;
  END IF;

  v_uid_text := NULLIF(current_setting('gstcrm.user_id', true), '');
  IF v_uid_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    v_uid := v_uid_text::uuid;
  END IF;

  INSERT INTO data_audit_log (
    tx_id, table_name, record_id, parent_table, parent_id, operation,
    old_data, new_data, changed_fields,
    actor_user_id, actor_username, ip, request_path, reason
  ) VALUES (
    txid_current(), TG_TABLE_NAME, v_record_id, v_parent_table, v_parent_id, TG_OP,
    v_old, v_new, v_changed,
    v_uid,
    COALESCE(NULLIF(left(current_setting('gstcrm.username', true), 100), ''), 'unknown'),
    NULLIF(left(current_setting('gstcrm.ip', true), 45), ''),
    NULLIF(left(current_setting('gstcrm.path', true), 150), ''),
    NULLIF(current_setting('gstcrm.reason', true), '')
  );
  RETURN NULL;
END;
$fn$;
--> statement-breakpoint
-- ─── Audited tables → parent mapping (keep in sync with src/modules/audit/labels.ts) ──
--   entry_groups          header (sales / purchase / labour bill / job work / expense / opening / reversal / melting)
--   entries               → entry_groups.id via group_id    (bill item / payment / ledger lines)
--   gst_sales_history     → entry_groups.id via sale_id
--   gst_purchase_history  → entry_groups.id via purchase_id
--   melting_lines         → melting_entries.id via melting_id
--   melting_alloys        → melting_entries.id via melting_id
--   labour_bill_cycles, job_work_cycles, bank_transactions, melting_entries,
--   accounts, items, metals, tax_master, company_details, print_templates
--                         header (parent = self)
-- Every audited table has a uuid "id" primary key.
-- Not audited: app_users, user_*_permissions, user_devices, refresh_tokens,
--   login_attempts, login_history, activity_logs, audit_logs, data_audit_log,
--   notifications.
DROP TRIGGER IF EXISTS gstcrm_audit ON "entry_groups";
--> statement-breakpoint
CREATE TRIGGER gstcrm_audit AFTER INSERT OR UPDATE OR DELETE ON "entry_groups" FOR EACH ROW EXECUTE FUNCTION gstcrm_audit_row('', '');
--> statement-breakpoint
DROP TRIGGER IF EXISTS gstcrm_audit ON "entries";
--> statement-breakpoint
CREATE TRIGGER gstcrm_audit AFTER INSERT OR UPDATE OR DELETE ON "entries" FOR EACH ROW EXECUTE FUNCTION gstcrm_audit_row('entry_groups', 'group_id');
--> statement-breakpoint
DROP TRIGGER IF EXISTS gstcrm_audit ON "gst_sales_history";
--> statement-breakpoint
CREATE TRIGGER gstcrm_audit AFTER INSERT OR UPDATE OR DELETE ON "gst_sales_history" FOR EACH ROW EXECUTE FUNCTION gstcrm_audit_row('entry_groups', 'sale_id');
--> statement-breakpoint
DROP TRIGGER IF EXISTS gstcrm_audit ON "gst_purchase_history";
--> statement-breakpoint
CREATE TRIGGER gstcrm_audit AFTER INSERT OR UPDATE OR DELETE ON "gst_purchase_history" FOR EACH ROW EXECUTE FUNCTION gstcrm_audit_row('entry_groups', 'purchase_id');
--> statement-breakpoint
DROP TRIGGER IF EXISTS gstcrm_audit ON "labour_bill_cycles";
--> statement-breakpoint
CREATE TRIGGER gstcrm_audit AFTER INSERT OR UPDATE OR DELETE ON "labour_bill_cycles" FOR EACH ROW EXECUTE FUNCTION gstcrm_audit_row('', '');
--> statement-breakpoint
DROP TRIGGER IF EXISTS gstcrm_audit ON "job_work_cycles";
--> statement-breakpoint
CREATE TRIGGER gstcrm_audit AFTER INSERT OR UPDATE OR DELETE ON "job_work_cycles" FOR EACH ROW EXECUTE FUNCTION gstcrm_audit_row('', '');
--> statement-breakpoint
DROP TRIGGER IF EXISTS gstcrm_audit ON "bank_transactions";
--> statement-breakpoint
CREATE TRIGGER gstcrm_audit AFTER INSERT OR UPDATE OR DELETE ON "bank_transactions" FOR EACH ROW EXECUTE FUNCTION gstcrm_audit_row('', '');
--> statement-breakpoint
DROP TRIGGER IF EXISTS gstcrm_audit ON "melting_entries";
--> statement-breakpoint
CREATE TRIGGER gstcrm_audit AFTER INSERT OR UPDATE OR DELETE ON "melting_entries" FOR EACH ROW EXECUTE FUNCTION gstcrm_audit_row('', '');
--> statement-breakpoint
DROP TRIGGER IF EXISTS gstcrm_audit ON "melting_lines";
--> statement-breakpoint
CREATE TRIGGER gstcrm_audit AFTER INSERT OR UPDATE OR DELETE ON "melting_lines" FOR EACH ROW EXECUTE FUNCTION gstcrm_audit_row('melting_entries', 'melting_id');
--> statement-breakpoint
DROP TRIGGER IF EXISTS gstcrm_audit ON "melting_alloys";
--> statement-breakpoint
CREATE TRIGGER gstcrm_audit AFTER INSERT OR UPDATE OR DELETE ON "melting_alloys" FOR EACH ROW EXECUTE FUNCTION gstcrm_audit_row('melting_entries', 'melting_id');
--> statement-breakpoint
DROP TRIGGER IF EXISTS gstcrm_audit ON "accounts";
--> statement-breakpoint
CREATE TRIGGER gstcrm_audit AFTER INSERT OR UPDATE OR DELETE ON "accounts" FOR EACH ROW EXECUTE FUNCTION gstcrm_audit_row('', '');
--> statement-breakpoint
DROP TRIGGER IF EXISTS gstcrm_audit ON "items";
--> statement-breakpoint
CREATE TRIGGER gstcrm_audit AFTER INSERT OR UPDATE OR DELETE ON "items" FOR EACH ROW EXECUTE FUNCTION gstcrm_audit_row('', '');
--> statement-breakpoint
DROP TRIGGER IF EXISTS gstcrm_audit ON "metals";
--> statement-breakpoint
CREATE TRIGGER gstcrm_audit AFTER INSERT OR UPDATE OR DELETE ON "metals" FOR EACH ROW EXECUTE FUNCTION gstcrm_audit_row('', '');
--> statement-breakpoint
DROP TRIGGER IF EXISTS gstcrm_audit ON "tax_master";
--> statement-breakpoint
CREATE TRIGGER gstcrm_audit AFTER INSERT OR UPDATE OR DELETE ON "tax_master" FOR EACH ROW EXECUTE FUNCTION gstcrm_audit_row('', '');
--> statement-breakpoint
DROP TRIGGER IF EXISTS gstcrm_audit ON "company_details";
--> statement-breakpoint
CREATE TRIGGER gstcrm_audit AFTER INSERT OR UPDATE OR DELETE ON "company_details" FOR EACH ROW EXECUTE FUNCTION gstcrm_audit_row('', '');
--> statement-breakpoint
DROP TRIGGER IF EXISTS gstcrm_audit ON "print_templates";
--> statement-breakpoint
CREATE TRIGGER gstcrm_audit AFTER INSERT OR UPDATE OR DELETE ON "print_templates" FOR EACH ROW EXECUTE FUNCTION gstcrm_audit_row('', '');
--> statement-breakpoint
-- ─── Tamper protection for the log tables ────────────────────────────────────
-- UPDATE is refused except:
--  (a) a foreign-key ON DELETE SET NULL action: only the reference columns named
--      in the trigger arguments change, and only to NULL (user / device removed —
--      the username and the event itself stay; audit_logs.actor_user_id is left
--      out of its hash for this reason);
--  (b) the sealer: gstcrm.sealer = 'on', the row is not sealed yet
--      (row_hash IS NULL) and only seal_seq / prev_hash / row_hash change.
CREATE OR REPLACE FUNCTION gstcrm_protect_audit_update() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_old jsonb;
  v_new jsonb;
  v_diff text[];
BEGIN
  v_old := to_jsonb(OLD);
  v_new := to_jsonb(NEW);
  SELECT array_agg(e.key) INTO v_diff
    FROM jsonb_each(v_new) AS e(key, value)
   WHERE e.value IS DISTINCT FROM (v_old -> e.key);
  IF v_diff IS NULL THEN
    RETURN NEW; -- nothing changes
  END IF;

  IF TG_NARGS > 0
     AND v_diff <@ TG_ARGV::text[]
     AND NOT EXISTS (
       SELECT 1 FROM unnest(v_diff) AS d(col) WHERE (v_new -> d.col) <> 'null'::jsonb
     ) THEN
    RETURN NEW;
  END IF;

  IF current_setting('gstcrm.sealer', true) = 'on'
     AND (v_old -> 'row_hash') = 'null'::jsonb
     AND v_diff <@ ARRAY['seal_seq', 'prev_hash', 'row_hash']::text[] THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Audit records cannot be changed (%).', TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END;
$fn$;
--> statement-breakpoint
-- DELETE is refused unless the retention job set gstcrm.retention = 'on' in its
-- transaction AND the row is older than the floor given as the trigger argument
-- (data_audit_log: 8 years; security logs: 300 days).
CREATE OR REPLACE FUNCTION gstcrm_protect_audit_delete() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_floor interval;
BEGIN
  v_floor := COALESCE(NULLIF(TG_ARGV[0], ''), '300 days')::interval;
  IF current_setting('gstcrm.retention', true) = 'on' AND OLD.created_at < now() - v_floor THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Audit records cannot be deleted (%).', TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END;
$fn$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION gstcrm_protect_audit_truncate() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  RAISE EXCEPTION 'Audit records cannot be truncated (%).', TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END;
$fn$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS gstcrm_protect_update ON "data_audit_log";
--> statement-breakpoint
CREATE TRIGGER gstcrm_protect_update BEFORE UPDATE ON "data_audit_log" FOR EACH ROW EXECUTE FUNCTION gstcrm_protect_audit_update();
--> statement-breakpoint
DROP TRIGGER IF EXISTS gstcrm_protect_delete ON "data_audit_log";
--> statement-breakpoint
CREATE TRIGGER gstcrm_protect_delete BEFORE DELETE ON "data_audit_log" FOR EACH ROW EXECUTE FUNCTION gstcrm_protect_audit_delete('8 years');
--> statement-breakpoint
DROP TRIGGER IF EXISTS gstcrm_protect_truncate ON "data_audit_log";
--> statement-breakpoint
CREATE TRIGGER gstcrm_protect_truncate BEFORE TRUNCATE ON "data_audit_log" FOR EACH STATEMENT EXECUTE FUNCTION gstcrm_protect_audit_truncate();
--> statement-breakpoint
DROP TRIGGER IF EXISTS gstcrm_protect_update ON "audit_logs";
--> statement-breakpoint
CREATE TRIGGER gstcrm_protect_update BEFORE UPDATE ON "audit_logs" FOR EACH ROW EXECUTE FUNCTION gstcrm_protect_audit_update('actor_user_id');
--> statement-breakpoint
DROP TRIGGER IF EXISTS gstcrm_protect_delete ON "audit_logs";
--> statement-breakpoint
CREATE TRIGGER gstcrm_protect_delete BEFORE DELETE ON "audit_logs" FOR EACH ROW EXECUTE FUNCTION gstcrm_protect_audit_delete('300 days');
--> statement-breakpoint
DROP TRIGGER IF EXISTS gstcrm_protect_truncate ON "audit_logs";
--> statement-breakpoint
CREATE TRIGGER gstcrm_protect_truncate BEFORE TRUNCATE ON "audit_logs" FOR EACH STATEMENT EXECUTE FUNCTION gstcrm_protect_audit_truncate();
--> statement-breakpoint
DROP TRIGGER IF EXISTS gstcrm_protect_update ON "login_history";
--> statement-breakpoint
CREATE TRIGGER gstcrm_protect_update BEFORE UPDATE ON "login_history" FOR EACH ROW EXECUTE FUNCTION gstcrm_protect_audit_update('user_id', 'device_id');
--> statement-breakpoint
DROP TRIGGER IF EXISTS gstcrm_protect_delete ON "login_history";
--> statement-breakpoint
CREATE TRIGGER gstcrm_protect_delete BEFORE DELETE ON "login_history" FOR EACH ROW EXECUTE FUNCTION gstcrm_protect_audit_delete('300 days');
--> statement-breakpoint
DROP TRIGGER IF EXISTS gstcrm_protect_truncate ON "login_history";
--> statement-breakpoint
CREATE TRIGGER gstcrm_protect_truncate BEFORE TRUNCATE ON "login_history" FOR EACH STATEMENT EXECUTE FUNCTION gstcrm_protect_audit_truncate();
--> statement-breakpoint
DROP TRIGGER IF EXISTS gstcrm_protect_update ON "activity_logs";
--> statement-breakpoint
CREATE TRIGGER gstcrm_protect_update BEFORE UPDATE ON "activity_logs" FOR EACH ROW EXECUTE FUNCTION gstcrm_protect_audit_update('user_id', 'device_id');
--> statement-breakpoint
DROP TRIGGER IF EXISTS gstcrm_protect_delete ON "activity_logs";
--> statement-breakpoint
CREATE TRIGGER gstcrm_protect_delete BEFORE DELETE ON "activity_logs" FOR EACH ROW EXECUTE FUNCTION gstcrm_protect_audit_delete('300 days');
--> statement-breakpoint
DROP TRIGGER IF EXISTS gstcrm_protect_truncate ON "activity_logs";
--> statement-breakpoint
CREATE TRIGGER gstcrm_protect_truncate BEFORE TRUNCATE ON "activity_logs" FOR EACH STATEMENT EXECUTE FUNCTION gstcrm_protect_audit_truncate();
