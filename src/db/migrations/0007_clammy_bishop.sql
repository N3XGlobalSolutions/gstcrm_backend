ALTER TABLE "entries" ADD COLUMN IF NOT EXISTS "average_touch" numeric(20, 8);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "entry_groups_account_id_idx" ON "entry_groups" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "entry_groups_type_created_at_idx" ON "entry_groups" USING btree ("type","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "entry_groups_is_deleted_idx" ON "entry_groups" USING btree ("is_deleted");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "entry_groups_created_at_idx" ON "entry_groups" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "entries_group_id_idx" ON "entries" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "entries_from_account_id_idx" ON "entries" USING btree ("from_account_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "entries_to_account_id_idx" ON "entries" USING btree ("to_account_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "entries_item_id_idx" ON "entries" USING btree ("item_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "entries_lot_id_idx" ON "entries" USING btree ("lot_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "entries_created_at_idx" ON "entries" USING btree ("created_at");