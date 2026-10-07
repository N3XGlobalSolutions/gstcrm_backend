CREATE TABLE "metals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(100) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "melting_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entry_no" integer NOT NULL,
	"date" date NOT NULL,
	"metal_id" uuid NOT NULL,
	"remarks" text,
	"is_deleted" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "melting_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"melting_id" uuid NOT NULL,
	"sort_order" integer NOT NULL,
	"weight" numeric(20, 3) NOT NULL,
	"touch" numeric(6, 2),
	"wastage_percent" numeric(6, 2),
	"pure" numeric(20, 3),
	"wastage" numeric(20, 3),
	"total_pure" numeric(20, 3),
	"quantity" integer
);
--> statement-breakpoint
ALTER TABLE "melting_entries" ADD CONSTRAINT "melting_entries_metal_id_metals_id_fk" FOREIGN KEY ("metal_id") REFERENCES "public"."metals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "melting_lines" ADD CONSTRAINT "melting_lines_melting_id_melting_entries_id_fk" FOREIGN KEY ("melting_id") REFERENCES "public"."melting_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "metals_name_lower_unique" ON "metals" USING btree (lower("name"));--> statement-breakpoint
CREATE INDEX "melting_entries_date_idx" ON "melting_entries" USING btree ("date");
