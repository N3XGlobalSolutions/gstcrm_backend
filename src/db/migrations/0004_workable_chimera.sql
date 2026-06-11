CREATE TABLE IF NOT EXISTS "tax_master" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entry_no" integer NOT NULL,
	"category" varchar(50) NOT NULL,
	"name" varchar(200) NOT NULL,
	"code" varchar(50),
	"percentage" numeric(5, 2) NOT NULL,
	"is_deleted" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tax_master_entry_no_unique" UNIQUE("entry_no")
);
