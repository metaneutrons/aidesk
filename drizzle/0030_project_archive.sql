ALTER TABLE "project" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "archived_by" text;