-- Customer cycle link (owner, 2026-11-05): a Labour Bill cycle is the customer's
-- order. It carries a Required Touch (asked once, when the cycle is created; old
-- cycles have none), an OPEN / DELIVERED status, and Issue Job Works can be linked
-- to it (entry_groups.order_cycle_id, JOB_WORK groups only) so the gold received on
-- the cycle can be issued to employees and their finished ornaments listed back.
-- labour_bill_cycles / entry_groups already carry the gstcrm_audit row trigger
-- (0025), which records whole rows — the new columns are audited automatically.
ALTER TABLE "labour_bill_cycles" ADD COLUMN IF NOT EXISTS "required_touch" numeric(6, 2);
--> statement-breakpoint
ALTER TABLE "labour_bill_cycles" ADD COLUMN IF NOT EXISTS "status" text DEFAULT 'OPEN' NOT NULL;
--> statement-breakpoint
ALTER TABLE "labour_bill_cycles" ADD COLUMN IF NOT EXISTS "delivered_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "labour_bill_cycles" ADD CONSTRAINT "labour_bill_cycles_status_check" CHECK ("labour_bill_cycles"."status" in ('OPEN', 'DELIVERED'));
--> statement-breakpoint
ALTER TABLE "entry_groups" ADD COLUMN IF NOT EXISTS "order_cycle_id" uuid;
--> statement-breakpoint
ALTER TABLE "entry_groups" ADD CONSTRAINT "entry_groups_order_cycle_id_labour_bill_cycles_id_fk" FOREIGN KEY ("order_cycle_id") REFERENCES "public"."labour_bill_cycles"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "entry_groups_order_cycle_id_idx" ON "entry_groups" USING btree ("order_cycle_id");
