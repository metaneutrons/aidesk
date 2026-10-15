ALTER TABLE "agent_run" ADD COLUMN "current_revision" integer;--> statement-breakpoint
UPDATE "agent_run" SET "current_revision" = "revision";--> statement-breakpoint
ALTER TABLE "agent_run" ALTER COLUMN "current_revision" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_run" ADD COLUMN "notes" integer DEFAULT 0 NOT NULL;
