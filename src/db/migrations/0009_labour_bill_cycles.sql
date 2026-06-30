CREATE TABLE "labour_bill_cycles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"bill_no" integer NOT NULL,
	"main_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "labour_bill_cycles_account_bill_no_unique" UNIQUE("account_id","bill_no")
);
--> statement-breakpoint
ALTER TABLE "entry_groups" ADD COLUMN "bill_cycle_id" uuid;
--> statement-breakpoint
ALTER TABLE "labour_bill_cycles" ADD CONSTRAINT "labour_bill_cycles_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "entry_groups" ADD CONSTRAINT "entry_groups_bill_cycle_id_labour_bill_cycles_id_fk" FOREIGN KEY ("bill_cycle_id") REFERENCES "public"."labour_bill_cycles"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "labour_bill_cycles_account_id_idx" ON "labour_bill_cycles" USING btree ("account_id");
