-- Make entry_no nullable so REVERSAL groups don't consume voucher numbers
ALTER TABLE entry_groups ALTER COLUMN entry_no DROP NOT NULL;--> statement-breakpoint
-- Replace global unique constraint with a partial unique index scoped per type,
-- excluding deleted rows so voided entries don't block number reuse
ALTER TABLE entry_groups DROP CONSTRAINT entry_groups_entry_no_unique;--> statement-breakpoint
CREATE UNIQUE INDEX entry_groups_entry_no_unique ON entry_groups (type, entry_no) WHERE entry_no IS NOT NULL AND is_deleted = false;--> statement-breakpoint
-- Backfill: clear entry_no on all existing REVERSAL groups
UPDATE entry_groups SET entry_no = NULL WHERE type = 'REVERSAL';
