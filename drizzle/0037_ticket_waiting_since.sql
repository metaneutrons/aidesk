ALTER TABLE "ticket" ADD COLUMN "waiting_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ticket" ADD COLUMN "auto_reminded_for" timestamp with time zone;--> statement-breakpoint
-- A ticket that waits already: the wait began when it was last changed, which is when the answer was sent.
UPDATE "ticket" SET "waiting_since" = "updated_at" WHERE "status" = 'waiting';
