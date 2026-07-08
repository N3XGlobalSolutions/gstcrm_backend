-- Job Work bill cycles: a permanent per-account "bill book" for Issue & Job Works,
-- mirroring labour_bill_cycles but kept separate so job-work bill numbers do not
-- collide with labour-bill bill numbers for the same account.
CREATE TABLE IF NOT EXISTS "job_work_cycles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"bill_no" integer NOT NULL,
	"main_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_work_cycles_account_bill_no_unique" UNIQUE("account_id","bill_no")
);
--> statement-breakpoint
ALTER TABLE "entry_groups" ADD COLUMN IF NOT EXISTS "job_work_cycle_id" uuid;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "job_work_cycles" ADD CONSTRAINT "job_work_cycles_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "entry_groups" ADD CONSTRAINT "entry_groups_job_work_cycle_id_job_work_cycles_id_fk" FOREIGN KEY ("job_work_cycle_id") REFERENCES "public"."job_work_cycles"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "job_work_cycles_account_id_idx" ON "job_work_cycles" USING btree ("account_id");
