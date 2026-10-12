ALTER TABLE "ticket" ADD COLUMN "junk_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ticket" ADD COLUMN "junk_reason" text;--> statement-breakpoint
-- Operators who may answer may also move tickets to junk, so the respond and
-- manage presets keep matching existing grants.
UPDATE "membership" SET "actions" = "actions" || '["ticket.junk"]'::jsonb WHERE "actions" ? 'ticket.reply' AND NOT "actions" ? 'ticket.junk';
