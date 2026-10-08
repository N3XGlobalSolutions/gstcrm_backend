ALTER TYPE "public"."entry_group_type" ADD VALUE IF NOT EXISTS 'MELTING';--> statement-breakpoint
ALTER TABLE "melting_entries" ADD COLUMN IF NOT EXISTS "entry_group_id" uuid;--> statement-breakpoint
ALTER TABLE "melting_entries" ADD COLUMN IF NOT EXISTS "after_weight" numeric(20, 3);--> statement-breakpoint
ALTER TABLE "melting_entries" ADD COLUMN IF NOT EXISTS "output_item_id" uuid;--> statement-breakpoint
ALTER TABLE "melting_entries" ADD COLUMN IF NOT EXISTS "out_touch" numeric(6, 2);--> statement-breakpoint
ALTER TABLE "melting_entries" ADD COLUMN IF NOT EXISTS "expected_weight" numeric(20, 3);--> statement-breakpoint
ALTER TABLE "melting_entries" ADD COLUMN IF NOT EXISTS "loss_weight" numeric(20, 3);--> statement-breakpoint
ALTER TABLE "melting_entries" ADD COLUMN IF NOT EXISTS "pure_loss" numeric(20, 3);--> statement-breakpoint
ALTER TABLE "melting_lines" ADD COLUMN IF NOT EXISTS "item_id" uuid;--> statement-breakpoint
ALTER TABLE "melting_lines" ADD COLUMN IF NOT EXISTS "lot_id" varchar(20);--> statement-breakpoint
ALTER TABLE "melting_lines" ALTER COLUMN "touch" SET DATA TYPE numeric(7, 3);--> statement-breakpoint
ALTER TABLE "melting_entries" ADD CONSTRAINT "melting_entries_entry_group_id_entry_groups_id_fk" FOREIGN KEY ("entry_group_id") REFERENCES "public"."entry_groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "melting_entries" ADD CONSTRAINT "melting_entries_output_item_id_items_id_fk" FOREIGN KEY ("output_item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "melting_lines" ADD CONSTRAINT "melting_lines_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;
