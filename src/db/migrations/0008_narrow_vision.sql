ALTER TABLE "items" DROP CONSTRAINT "items_entry_no_unique";--> statement-breakpoint
ALTER TABLE "accounts" DROP CONSTRAINT "accounts_entry_no_unique";--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_type_entry_no_unique" UNIQUE("type","entry_no");--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_type_entry_no_unique" UNIQUE("type","entry_no");