ALTER TABLE "entry_groups" DROP CONSTRAINT IF EXISTS "entry_groups_entry_no_unique";--> statement-breakpoint
ALTER TABLE "entry_groups" ALTER COLUMN "entry_no" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "company_details" ADD COLUMN "business_name" varchar(300);--> statement-breakpoint
ALTER TABLE "company_details" ADD COLUMN "address_line1" text;--> statement-breakpoint
ALTER TABLE "company_details" ADD COLUMN "city" varchar(100);--> statement-breakpoint
ALTER TABLE "company_details" ADD COLUMN "pincode" varchar(20);--> statement-breakpoint
ALTER TABLE "company_details" ADD COLUMN "state" varchar(100);--> statement-breakpoint
ALTER TABLE "company_details" ADD COLUMN "state_code" varchar(10);--> statement-breakpoint
ALTER TABLE "company_details" ADD COLUMN "country" varchar(100);--> statement-breakpoint
ALTER TABLE "company_details" ADD COLUMN "phone_number" varchar(50);--> statement-breakpoint
ALTER TABLE "company_details" ADD COLUMN "gstin" varchar(50);--> statement-breakpoint
ALTER TABLE "company_details" ADD COLUMN "pan_number" varchar(50);--> statement-breakpoint
ALTER TABLE "company_details" ADD COLUMN "place_of_supply" varchar(100);--> statement-breakpoint
ALTER TABLE "company_details" ADD COLUMN "business_type" varchar(100);--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "is_read" boolean DEFAULT false NOT NULL;