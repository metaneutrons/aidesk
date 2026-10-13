ALTER TABLE "config_change" ADD COLUMN "kind" text DEFAULT 'config' NOT NULL;--> statement-breakpoint
ALTER TABLE "config_change" ADD COLUMN "target" text;--> statement-breakpoint
ALTER TABLE "connection" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;