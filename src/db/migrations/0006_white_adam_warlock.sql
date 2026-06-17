CREATE TABLE IF NOT EXISTS "gst_sales_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sale_id" uuid NOT NULL,
	"entry_no" text NOT NULL,
	"bill_no" text NOT NULL,
	"date" timestamp with time zone NOT NULL,
	"account_id" uuid NOT NULL,
	"pure" numeric(20, 8) NOT NULL,
	"cash" numeric(20, 2) NOT NULL,
	"gst_amount" numeric(20, 2) NOT NULL,
	"tds_amount" numeric(20, 2) DEFAULT '0',
	"tcs_amount" numeric(20, 2) DEFAULT '0',
	"type" text DEFAULT 'SALE' NOT NULL,
	"rate" numeric(20, 2) NOT NULL,
	"item_type" text NOT NULL,
	"bal_pure" numeric(20, 8) NOT NULL,
	"bal_cash" numeric(20, 2) NOT NULL,
	"bank_paid" numeric(20, 2) DEFAULT '0',
	"bank_receive" numeric(20, 2) DEFAULT '0',
	"cash_paid" numeric(20, 2) DEFAULT '0',
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "gst_purchase_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"purchase_id" uuid NOT NULL,
	"entry_no" text NOT NULL,
	"bill_no" text NOT NULL,
	"date" timestamp with time zone NOT NULL,
	"account_id" uuid NOT NULL,
	"pure" numeric(20, 8) NOT NULL,
	"cash" numeric(20, 2) NOT NULL,
	"gst_amount" numeric(20, 2) NOT NULL,
	"tds_amount" numeric(20, 2) DEFAULT '0',
	"tcs_amount" numeric(20, 2) DEFAULT '0',
	"type" text DEFAULT 'PURCHASE' NOT NULL,
	"rate" numeric(20, 2) NOT NULL,
	"item_type" text NOT NULL,
	"bal_pure" numeric(20, 8) NOT NULL,
	"bal_cash" numeric(20, 2) NOT NULL,
	"bank_paid" numeric(20, 2) DEFAULT '0',
	"bank_receive" numeric(20, 2) DEFAULT '0',
	"cash_paid" numeric(20, 2) DEFAULT '0',
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "entry_groups" ADD COLUMN IF NOT EXISTS "gst_amount" numeric(20, 2) DEFAULT '0';--> statement-breakpoint
ALTER TABLE "gst_sales_history" DROP CONSTRAINT IF EXISTS "gst_sales_history_account_id_accounts_id_fk";--> statement-breakpoint
ALTER TABLE "gst_sales_history" ADD CONSTRAINT "gst_sales_history_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gst_purchase_history" DROP CONSTRAINT IF EXISTS "gst_purchase_history_account_id_accounts_id_fk";--> statement-breakpoint
ALTER TABLE "gst_purchase_history" ADD CONSTRAINT "gst_purchase_history_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;