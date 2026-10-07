ALTER TABLE "melting_entries" ALTER COLUMN "metal_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "melting_entries" ADD COLUMN "required_touch" numeric(6, 2);--> statement-breakpoint
ALTER TABLE "melting_entries" ADD COLUMN "final_weight" numeric(20, 3);--> statement-breakpoint
ALTER TABLE "melting_entries" ADD COLUMN "alloy_total" numeric(20, 3);--> statement-breakpoint
CREATE TABLE "melting_alloys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"melting_id" uuid NOT NULL,
	"metal_id" uuid NOT NULL,
	"sort_order" integer NOT NULL,
	"share_percent" numeric(6, 2) NOT NULL,
	"grams" numeric(20, 3) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "melting_alloys" ADD CONSTRAINT "melting_alloys_melting_id_melting_entries_id_fk" FOREIGN KEY ("melting_id") REFERENCES "public"."melting_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "melting_alloys" ADD CONSTRAINT "melting_alloys_metal_id_metals_id_fk" FOREIGN KEY ("metal_id") REFERENCES "public"."metals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "melting_alloys_melting_id_idx" ON "melting_alloys" USING btree ("melting_id");--> statement-breakpoint
CREATE INDEX "melting_alloys_metal_id_idx" ON "melting_alloys" USING btree ("metal_id");
