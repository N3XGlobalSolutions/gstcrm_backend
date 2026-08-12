ALTER TABLE "accounts" ADD COLUMN "bank_name" varchar(200);--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "bank_account_no" varchar(30);--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "ifsc_code" varchar(15);