ALTER TABLE "ticket" ADD COLUMN "priority" text DEFAULT 'normal' NOT NULL;--> statement-breakpoint
ALTER TABLE "ticket" ADD COLUMN "category" text;