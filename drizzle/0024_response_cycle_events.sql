ALTER TABLE "ticket" ADD COLUMN "warned_for" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ticket" ADD COLUMN "overdue_for" timestamp with time zone;