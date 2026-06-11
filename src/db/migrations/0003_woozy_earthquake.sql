ALTER TABLE "entry_groups" DROP CONSTRAINT IF EXISTS "entry_groups_entry_no_unique";--> statement-breakpoint
ALTER TABLE "entry_groups" ALTER COLUMN "entry_no" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "company_details" ADD COLUMN IF NOT EXISTS "business_name" varchar(300);--> statement-breakpoint
ALTER TABLE "company_details" ADD COLUMN IF NOT EXISTS "address_line1" text;--> statement-breakpoint
ALTER TABLE "company_details" ADD COLUMN IF NOT EXISTS "city" varchar(100);--> statement-breakpoint
ALTER TABLE "company_details" ADD COLUMN IF NOT EXISTS "pincode" varchar(20);--> statement-breakpoint
ALTER TABLE "company_details" ADD COLUMN IF NOT EXISTS "state" varchar(100);--> statement-breakpoint
ALTER TABLE "company_details" ADD COLUMN IF NOT EXISTS "state_code" varchar(10);--> statement-breakpoint
ALTER TABLE "company_details" ADD COLUMN IF NOT EXISTS "country" varchar(100);--> statement-breakpoint
ALTER TABLE "company_details" ADD COLUMN IF NOT EXISTS "phone_number" varchar(50);--> statement-breakpoint
ALTER TABLE "company_details" ADD COLUMN IF NOT EXISTS "gstin" varchar(50);--> statement-breakpoint
ALTER TABLE "company_details" ADD COLUMN IF NOT EXISTS "pan_number" varchar(50);--> statement-breakpoint
ALTER TABLE "company_details" ADD COLUMN IF NOT EXISTS "place_of_supply" varchar(100);--> statement-breakpoint
ALTER TABLE "company_details" ADD COLUMN IF NOT EXISTS "business_type" varchar(100);--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "is_read" boolean DEFAULT false NOT NULL;