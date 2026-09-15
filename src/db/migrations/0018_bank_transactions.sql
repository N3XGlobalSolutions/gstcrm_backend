CREATE TYPE "public"."bank_txn_direction" AS ENUM('CREDIT', 'DEBIT');--> statement-breakpoint
CREATE TYPE "public"."bank_txn_kind" AS ENUM('DEPOSIT', 'WITHDRAWAL', 'TRANSFER_IN', 'TRANSFER_OUT');--> statement-breakpoint
CREATE TABLE "bank_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bank_key" varchar(400) NOT NULL,
	"bank_label" varchar(400) NOT NULL,
	"kind" "bank_txn_kind" NOT NULL,
	"direction" "bank_txn_direction" NOT NULL,
	"amount" numeric(20, 2) NOT NULL,
	"date" date NOT NULL,
	"remarks" text,
	"transfer_group_id" uuid,
	"counterparty_bank_key" varchar(400),
	"counterparty_bank_label" varchar(400),
	"created_by" varchar(200),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "bank_transactions_bank_key_idx" ON "bank_transactions" USING btree ("bank_key");--> statement-breakpoint
CREATE INDEX "bank_transactions_date_idx" ON "bank_transactions" USING btree ("date");--> statement-breakpoint
CREATE INDEX "bank_transactions_transfer_group_idx" ON "bank_transactions" USING btree ("transfer_group_id");