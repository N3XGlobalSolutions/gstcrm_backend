CREATE TYPE "public"."item_type" AS ENUM('GOLD', 'ORNAMENT', 'MONEY');--> statement-breakpoint
CREATE TYPE "public"."item_unit" AS ENUM('GRAM', 'PIECE', 'RUPEE');--> statement-breakpoint
CREATE TYPE "public"."account_type" AS ENUM('SHOP', 'CUSTOMER', 'GOLDSMITH', 'CASH', 'BANK', 'EXPENSE', 'LOSS');--> statement-breakpoint
CREATE TYPE "public"."customer_type" AS ENUM('PURCHASER', 'CUSTOMER', 'GOLD_SMITH', 'SALES_MAN', 'LABOUR_BILL');--> statement-breakpoint
CREATE TYPE "public"."entry_group_type" AS ENUM('PURCHASE', 'SALE', 'JOB_WORK', 'LABOUR_BILL', 'EXPENSE', 'OPENING', 'REVERSAL');--> statement-breakpoint
CREATE TYPE "public"."wastage_mode" AS ENUM('PERCENT', 'GRAM');--> statement-breakpoint
CREATE TABLE "items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entry_no" integer NOT NULL,
	"name" varchar(100) NOT NULL,
	"type" "item_type" NOT NULL,
	"unit" "item_unit" NOT NULL,
	"is_deleted" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "items_entry_no_unique" UNIQUE("entry_no")
);
--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entry_no" integer NOT NULL,
	"name" varchar(200) NOT NULL,
	"type" "account_type" NOT NULL,
	"customer_type" "customer_type",
	"gst_no" varchar(20),
	"pan_no" varchar(10),
	"state_code" varchar(10),
	"place_of_supply" varchar(100),
	"address" text,
	"phone" varchar(15),
	"email" varchar(200),
	"website" varchar(200),
	"opening_pure_balance" numeric(20, 8) DEFAULT '0' NOT NULL,
	"opening_cash_balance" numeric(20, 2) DEFAULT '0' NOT NULL,
	"is_system_account" boolean DEFAULT false NOT NULL,
	"is_deleted" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_entry_no_unique" UNIQUE("entry_no")
);
--> statement-breakpoint
CREATE TABLE "entry_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entry_no" integer NOT NULL,
	"bill_no" integer,
	"date" date NOT NULL,
	"type" "entry_group_type" NOT NULL,
	"account_id" uuid NOT NULL,
	"rate_per_gram" numeric(20, 2),
	"remarks" text,
	"reversed_by" uuid,
	"reversal_of" uuid,
	"is_deleted" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "entry_groups_entry_no_unique" UNIQUE("entry_no")
);
--> statement-breakpoint
CREATE TABLE "entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"from_account_id" uuid NOT NULL,
	"to_account_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"quantity" numeric(20, 8) NOT NULL,
	"purity" numeric(20, 8),
	"pure_quantity" numeric(20, 8),
	"wastage_mode" "wastage_mode",
	"wastage_value" numeric(20, 8),
	"wastage_quantity" numeric(20, 8),
	"rate" numeric(20, 2),
	"amount" numeric(20, 2),
	"remarks" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entry_no" integer NOT NULL,
	"username" varchar(100) NOT NULL,
	"password_hash" text NOT NULL,
	"user_group" varchar(50),
	"is_deleted" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_users_entry_no_unique" UNIQUE("entry_no"),
	CONSTRAINT "app_users_username_unique" UNIQUE("username")
);
--> statement-breakpoint
CREATE TABLE "company_details" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_name" varchar(300),
	"address" text,
	"phone" varchar(20),
	"email" varchar(200),
	"gst_no" varchar(20),
	"pan_no" varchar(10),
	"bank_details" text,
	"logo_url" varchar(500),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "print_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entry_no" integer NOT NULL,
	"template_name" varchar(200) NOT NULL,
	"status" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "print_templates_entry_no_unique" UNIQUE("entry_no")
);
--> statement-breakpoint
CREATE TABLE "user_activity_permissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"can_view" boolean DEFAULT false NOT NULL,
	"can_edit" boolean DEFAULT false NOT NULL,
	"can_delete" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_form_permissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"module" varchar(100) NOT NULL,
	"form_name" varchar(100) NOT NULL,
	"allowed" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entry_no" integer NOT NULL,
	"message" text NOT NULL,
	"created_by" uuid NOT NULL,
	"is_deleted" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notifications_entry_no_unique" UNIQUE("entry_no")
);
--> statement-breakpoint
ALTER TABLE "entry_groups" ADD CONSTRAINT "entry_groups_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entries" ADD CONSTRAINT "entries_group_id_entry_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."entry_groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entries" ADD CONSTRAINT "entries_from_account_id_accounts_id_fk" FOREIGN KEY ("from_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entries" ADD CONSTRAINT "entries_to_account_id_accounts_id_fk" FOREIGN KEY ("to_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entries" ADD CONSTRAINT "entries_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_activity_permissions" ADD CONSTRAINT "user_activity_permissions_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_form_permissions" ADD CONSTRAINT "user_form_permissions_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_created_by_app_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id") ON DELETE no action ON UPDATE no action;