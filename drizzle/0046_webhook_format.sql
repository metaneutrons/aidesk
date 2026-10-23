ALTER TABLE "webhook" ADD COLUMN "format" text DEFAULT 'aidesk' NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook" ADD COLUMN "with_subject" boolean DEFAULT false NOT NULL;